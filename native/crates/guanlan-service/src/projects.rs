//! 多项目并存中枢（Quiet.md 多目录工作台模型）：
//!
//! 职责：
//! 1. **全局持久化项目表（`projects.json`）**：跨会话记住用户纳入观澜管理的多个本机项目目录
//!    （支持自定义显示名与可选 `readonly` 归档只读保护），删除项目只移出列表，绝不触碰磁盘；
//! 2. **零重启并存运行时**：每个在线项目持有独立隔离的 `<data_dir>/<root_key>/index.db`、
//!    `WorkspaceLock`、轻量只读查询池、`IndexJobManager` 写线程与可选 `Watcher`；
//!    单项目遇 `ROOT_IN_USE` 或目录缺失时仅该项目降级离线，绝不拖垮整个应用；
//! 3. **父子互斥隔离（Quiet.md `mounts.rs` 纪律）**：任意两个受管项目不得互为父子目录
//!    （`MOUNT_REJECTED` 409），同路径去重（`CONFLICT` 409）；
//! 4. **毫秒级零重启焦点切换**：`activate(project_id)` 仅原子切换 `active_project_id`，
//!    不关闭 HTTP 服务、不换端口、不断开 SSE，`/api/v1/*` 全线端点立即指向新激活项目；
//! 5. **跨项目目录树 / 跨项目总览 / 跨项目检索 / 任意项目原地读写操控**：
//!    侧栏可同时展开多个项目的真实目录树（含空目录）并直接执行文件夹/文档 CRUD。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};

use guanlan_core::domain::mounts::{
    mount_display_name, normalize_mount_root, path_relation, PathRelation,
};
use guanlan_core::dto::{
    CrossProjectDecisionItem, CrossProjectRecentFile, CrossProjectSearchHit,
    CrossProjectSearchResponse, ProjectEntry, ProjectListResponse, ProjectMutationResponse,
    ProjectTreeResponse, ProjectsOverviewResponse,
};
use guanlan_core::error::GuanlanError;
use guanlan_core::query::projects as core_projects;
use guanlan_core::storage::{default_data_dir, ReadonlyStore};

use crate::http::query_exec::{pool_size_from_env, QueryExecutor};
use crate::index_jobs::{IndexJobManager, JobKind, SseNotice};
use crate::mounts::MountRegistry;
use crate::runtime::{acquire_workspace_lock, NoticeHub, WorkspaceLock};
use crate::watcher::{self, WatchBaseline, WatcherHandle};

const REGISTRY_FILE: &str = "projects.json";
const REGISTRY_VERSION: i64 = 1;
/// 后台非激活项目的只读连接池大小（保持轻内存占用；激活项目沿用 pool_size_from_env）
const BACKGROUND_POOL_SIZE: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedProject {
    project_id: String,
    root_path: String,
    name: String,
    #[serde(default)]
    readonly: bool,
    added_at: String,
    last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedRegistry {
    version: i64,
    #[serde(default)]
    active_project_id: Option<String>,
    #[serde(default)]
    projects: Vec<PersistedProject>,
}

struct OwnedRuntimeResources {
    watcher: Option<WatcherHandle>,
    jobs: Option<IndexJobManager>,
    notice_bridge: Option<std::thread::JoinHandle<()>>,
    lock: Option<WorkspaceLock>,
}

/// 单个在线项目的运行句柄集合（clone 友好；所有读/写通过本句柄路由，不持有 Hub 锁）
pub struct ProjectRuntime {
    pub project_id: String,
    pub root_path: String,
    pub data_dir: PathBuf,
    pub exec: Arc<QueryExecutor>,
    pub jobs: IndexJobManager,
    pub watcher: Option<WatcherHandle>,
    pub mounts: Arc<MountRegistry>,
    /// 目录清单缓存（枚举 `read_dir` 整棵树，不能放进只读查询体）
    folders: crate::folders::FolderInventoryCache,
    owned: Mutex<OwnedRuntimeResources>,
}

impl ProjectRuntime {
    #[allow(clippy::too_many_arguments)] // 运行期装配参数，逐项拆包会引入无谓的中间结构
    pub fn from_existing(
        project_id: String,
        root_path: String,
        data_dir: PathBuf,
        exec: Arc<QueryExecutor>,
        jobs: IndexJobManager,
        watcher: Option<WatcherHandle>,
        mounts: Arc<MountRegistry>,
        lock: WorkspaceLock,
        notice_bridge: Option<std::thread::JoinHandle<()>>,
    ) -> Arc<Self> {
        let jobs_owned = jobs.clone();
        let watcher_owned = watcher.clone();
        Arc::new(Self {
            project_id,
            root_path,
            data_dir,
            exec,
            jobs,
            watcher,
            mounts,
            folders: crate::folders::FolderInventoryCache::new(),
            owned: Mutex::new(OwnedRuntimeResources {
                watcher: watcher_owned,
                jobs: Some(jobs_owned),
                notice_bridge,
                lock: Some(lock),
            }),
        })
    }

    /// 取本项目目录清单（进程内缓存；读不全时保留上一次结果）。
    ///
    /// 同步 `read_dir`：调用方应把它放进 `spawn_blocking`，不要占着异步工作线程。
    pub fn folder_listing(&self) -> guanlan_core::index::collector::FolderListing {
        self.folders.get(&self.root_path)
    }

    /// 文件夹增删改移成功后立即失效缓存，下一次读取重新枚举。
    pub fn invalidate_folder_listing(&self) {
        self.folders.invalidate(&self.root_path);
    }

    /// 优雅停止该项目的 watcher、写线程、通知桥与排他锁（绝不持锁跨 await，
    /// 且写线程 `handle.join()` 放在 `spawn_blocking` 里避免阻塞 Tokio 异步工作线程）。
    pub async fn shutdown(&self) {
        let (watcher, jobs, bridge, lock) = {
            let mut g = self.owned.lock().expect("项目运行时资源锁");
            (
                g.watcher.take(),
                g.jobs.take(),
                g.notice_bridge.take(),
                g.lock.take(),
            )
        };
        if let Some(j) = &jobs {
            j.signal_shutdown();
        }
        if let Some(w) = watcher {
            w.stop().await;
        }
        if let Some(j) = jobs {
            let _ = tokio::task::spawn_blocking(move || {
                j.shutdown();
            })
            .await;
        }
        if let Some(t) = bridge {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = t.join();
            })
            .await;
        }
        drop(lock);
    }
}

#[derive(Clone)]
struct ProjectSlot {
    project_id: String,
    /// 规范化展示与互斥路径（plain() 语义）
    root_path: String,
    /// 原始路径（与 Writer/ReadonlyStore 身份口径一致）
    raw_root: String,
    name: String,
    readonly: bool,
    added_at: String,
    last_opened_at: String,
    /// ready | offline | root_in_use | error
    status: String,
    error: Option<String>,
    runtime: Option<Arc<ProjectRuntime>>,
}

/// 解析默认全局 `projects.json` 路径：
/// `GUANLAN_PROJECTS_FILE`（"none" 表示禁用持久化）→ `<GUANLAN_DATA_DIR>/projects.json` →
/// `%LOCALAPPDATA%/Guanlan/projects.json`（测试构建默认不污染真实用户目录）。
pub fn default_projects_file_path() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("GUANLAN_PROJECTS_FILE") {
        let trimmed = custom.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("none") {
            return None;
        }
        return Some(PathBuf::from(trimmed));
    }
    if let Ok(data_dir) = std::env::var("GUANLAN_DATA_DIR") {
        let trimmed = data_dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join(REGISTRY_FILE));
        }
    }
    #[cfg(test)]
    {
        None
    }
    #[cfg(not(test))]
    {
        #[cfg(windows)]
        {
            std::env::var("LOCALAPPDATA")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|base| PathBuf::from(base).join("Guanlan").join(REGISTRY_FILE))
        }
        #[cfg(not(windows))]
        {
            if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
                if !xdg.trim().is_empty() {
                    return Some(PathBuf::from(xdg).join("guanlan").join(REGISTRY_FILE));
                }
            }
            std::env::var("HOME")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|home| {
                    PathBuf::from(home)
                        .join(".config")
                        .join("guanlan")
                        .join(REGISTRY_FILE)
                })
        }
    }
}

/// 添加项目请求参数
#[derive(Debug, Clone)]
pub struct AddProjectInput {
    pub root_path: String,
    pub name: Option<String>,
    pub readonly: bool,
    pub activate: bool,
}

/// 更新项目元信息参数
#[derive(Debug, Clone)]
pub struct UpdateProjectInput {
    pub name: Option<String>,
    pub readonly: Option<bool>,
}

/// 多项目并存中枢（由 `AppState` 与 `RunningService` 共享持有）
pub struct ProjectHub {
    registry_path: Option<PathBuf>,
    background_index: bool,
    notices: NoticeHub,
    active_id: RwLock<String>,
    slots: Mutex<Vec<ProjectSlot>>,
}

impl ProjectHub {
    /// 启动装载：把已启动的首个主项目接入 Hub，并自动恢复 `projects.json` 里登记的其他项目。
    pub async fn start_with_primary(
        primary_runtime: Arc<ProjectRuntime>,
        primary_raw_root: String,
        background_index: bool,
        notices: NoticeHub,
        registry_path: Option<PathBuf>,
    ) -> Arc<Self> {
        let now = now_iso_utc();
        let primary_id = primary_runtime.project_id.clone();
        let primary_norm = primary_runtime.root_path.clone();

        // 读取已持久化的项目清单（损坏/缺失按空表起步，绝不阻断服务启动）
        let persisted = registry_path
            .as_deref()
            .and_then(read_registry_file)
            .unwrap_or(PersistedRegistry {
                version: REGISTRY_VERSION,
                active_project_id: None,
                projects: Vec::new(),
            });

        // 查找主项目是否已在历史清单中（保留用户自定义别名与只读设置）
        let primary_saved = persisted.projects.iter().find(|p| {
            p.project_id == primary_id
                || path_relation(&p.root_path, &primary_norm) == PathRelation::Equal
        });
        let primary_slot = ProjectSlot {
            project_id: primary_id.clone(),
            root_path: primary_norm.clone(),
            raw_root: primary_raw_root,
            name: primary_saved
                .map(|p| p.name.clone())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| mount_display_name(&primary_norm)),
            readonly: primary_saved.map(|p| p.readonly).unwrap_or(false),
            added_at: primary_saved
                .map(|p| p.added_at.clone())
                .unwrap_or_else(|| now.clone()),
            last_opened_at: now.clone(),
            status: "ready".to_owned(),
            error: None,
            runtime: Some(primary_runtime),
        };

        let mut initial_slots = vec![primary_slot];

        // 逐条恢复历史登记的其他项目（父子冲突跳过、打不开降级离线，绝不拖垮主服务）
        for saved in persisted.projects {
            if saved.project_id == primary_id
                || path_relation(&saved.root_path, &primary_norm) == PathRelation::Equal
            {
                continue;
            }
            if initial_slots
                .iter()
                .any(|s| path_relation(&s.root_path, &saved.root_path) != PathRelation::Disjoint)
            {
                eprintln!(
                    "警告: 跳过历史项目 {}（{}）：与当前项目存在父子嵌套或重复",
                    saved.name, saved.root_path
                );
                continue;
            }
            let opened = open_secondary_project_runtime(
                &saved.root_path,
                background_index,
                notices.clone(),
                false,
            )
            .await;
            let slot = match opened {
                Ok(rt) => ProjectSlot {
                    project_id: rt.project_id.clone(),
                    root_path: rt.root_path.clone(),
                    raw_root: saved.root_path.clone(),
                    name: if saved.name.trim().is_empty() {
                        mount_display_name(&rt.root_path)
                    } else {
                        saved.name
                    },
                    readonly: saved.readonly,
                    added_at: saved.added_at,
                    last_opened_at: saved.last_opened_at,
                    status: "ready".to_owned(),
                    error: None,
                    runtime: Some(rt),
                },
                Err((status, msg)) => ProjectSlot {
                    project_id: saved.project_id,
                    root_path: saved.root_path.clone(),
                    raw_root: saved.root_path,
                    name: saved.name,
                    readonly: saved.readonly,
                    added_at: saved.added_at,
                    last_opened_at: saved.last_opened_at,
                    status,
                    error: Some(msg),
                    runtime: None,
                },
            };
            initial_slots.push(slot);
        }

        let hub = Arc::new(Self {
            registry_path,
            background_index,
            notices,
            active_id: RwLock::new(primary_id),
            slots: Mutex::new(initial_slots),
        });
        // 若已有历史 projects.json，同步写回最新 last_opened_at 与主项目记录
        if hub.registry_path.as_deref().is_some_and(|p| p.exists()) {
            hub.persist_registry();
        }
        hub
    }

    /// 当前激活项目 id
    pub fn active_project_id(&self) -> String {
        self.active_id.read().expect("激活项目读锁").clone()
    }

    /// 当前激活项目的实时根路径（供桌面壳 reveal / open / save / import 实时同步）
    pub fn active_root_path(&self) -> String {
        let active = self.active_project_id();
        let slots = self.slots.lock().expect("项目表锁");
        slots
            .iter()
            .find(|s| s.project_id == active)
            .map(|s| s.raw_root.clone())
            .or_else(|| slots.first().map(|s| s.raw_root.clone()))
            .unwrap_or_default()
    }

    /// 取得当前激活项目的在线运行时（O(1) 克隆 Arc，不持有 Hub 锁）
    pub fn active_runtime(&self) -> Option<Arc<ProjectRuntime>> {
        let active = self.active_project_id();
        let slots = self.slots.lock().expect("项目表锁");
        slots
            .iter()
            .find(|s| s.project_id == active)
            .and_then(|s| s.runtime.clone())
            .or_else(|| slots.iter().find_map(|s| s.runtime.clone()))
    }

    /// 按 project_id 取指定项目运行时与元数据（含只读标记校验用）
    pub fn get_runtime(
        &self,
        project_id: &str,
    ) -> Result<(Arc<ProjectRuntime>, bool), GuanlanError> {
        let slots = self.slots.lock().expect("项目表锁");
        let slot = slots
            .iter()
            .find(|s| s.project_id == project_id)
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到项目：{project_id}")))?;
        let rt = slot.runtime.clone().ok_or_else(|| {
            let reason = slot.error.as_deref().unwrap_or("项目当前离线");
            GuanlanError::Conflict(format!("项目「{}」暂不可用：{reason}", slot.name))
        })?;
        Ok((rt, slot.readonly))
    }

    /// 校验项目是否可写；只读保护开启时确定性返回 403 CROSS_WORKSPACE_FORBIDDEN
    pub fn require_writable_runtime(
        &self,
        project_id: &str,
    ) -> Result<Arc<ProjectRuntime>, GuanlanError> {
        let (rt, readonly) = self.get_runtime(project_id)?;
        if readonly {
            return Err(GuanlanError::CrossWorkspaceForbidden(
                "该项目已开启只读归档保护，禁止写入/重命名/移动/回收站操作（可在项目菜单关闭只读保护）"
                    .to_owned(),
            ));
        }
        Ok(rt)
    }

    /// 校验当前激活项目是否处于只读保护态
    pub fn is_active_readonly(&self) -> bool {
        let active = self.active_project_id();
        let slots = self.slots.lock().expect("项目表锁");
        slots
            .iter()
            .find(|s| s.project_id == active)
            .map(|s| s.readonly)
            .unwrap_or(false)
    }

    /// 按 project_id 列出全部受管项目的实时视图（GET /api/v1/projects）
    pub async fn list_projects(&self) -> ProjectListResponse {
        let active = self.active_project_id();
        let snapshot: Vec<ProjectSlot> = self.slots.lock().expect("项目表锁").clone();
        let mut items = Vec::with_capacity(snapshot.len());
        for slot in snapshot {
            items.push(build_project_entry(&slot, slot.project_id == active).await);
        }
        ProjectListResponse {
            ok: true,
            active_project_id: active,
            projects: items,
        }
    }

    /// 添加新的本地项目目录（自动建库 + 后台扫描 + 监听，零前置手动 scan 门槛）
    pub async fn add_project(
        &self,
        input: AddProjectInput,
    ) -> Result<ProjectMutationResponse, GuanlanError> {
        let normalized = normalize_mount_root(&input.root_path)?;
        let path_buf = PathBuf::from(&normalized);
        if !path_buf.is_dir() {
            return Err(GuanlanError::NotFound(format!(
                "项目目录不存在或无法访问：{normalized}"
            )));
        }
        let target_id = guanlan_core::domain::root_key_of(&normalized)?;

        // 1) 父子互斥与重复校验（Quiet.md 外挂目录隔离纪律）
        {
            let slots = self.slots.lock().expect("项目表锁");
            for existing in slots.iter() {
                if existing.project_id == target_id
                    || path_relation(&normalized, &existing.root_path) == PathRelation::Equal
                {
                    return Err(GuanlanError::Conflict(format!(
                        "目录已在项目列表中：「{}」（{}）",
                        existing.name, existing.root_path
                    )));
                }
                match path_relation(&normalized, &existing.root_path) {
                    PathRelation::DescendantOf => {
                        return Err(GuanlanError::MountRejected(format!(
                            "拒绝嵌套添加：所选目录位于既有项目「{}」内部（{}）",
                            existing.name, existing.root_path
                        )));
                    }
                    PathRelation::AncestorOf => {
                        return Err(GuanlanError::MountRejected(format!(
                            "拒绝嵌套添加：所选目录包含了既有项目「{}」（{}）",
                            existing.name, existing.root_path
                        )));
                    }
                    PathRelation::Equal | PathRelation::Disjoint => {}
                }
            }
        }

        // 2) 初始化并启动独立运行时（若尚无 index.db 会自动创建并立即入队 VerifyAll）
        let runtime = open_secondary_project_runtime(
            &normalized,
            self.background_index,
            self.notices.clone(),
            true,
        )
        .await
        .map_err(|(status, msg)| {
            if status == "root_in_use" {
                GuanlanError::RootInUse
            } else {
                GuanlanError::Internal(msg)
            }
        })?;

        let now = now_iso_utc();
        let display_name = input
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| mount_display_name(&normalized));

        let new_slot = ProjectSlot {
            project_id: runtime.project_id.clone(),
            root_path: runtime.root_path.clone(),
            raw_root: normalized.clone(),
            name: display_name,
            readonly: input.readonly,
            added_at: now.clone(),
            last_opened_at: now,
            status: "ready".to_owned(),
            error: None,
            runtime: Some(runtime.clone()),
        };
        let created_id = new_slot.project_id.clone();

        let duplicate = {
            let mut slots = self.slots.lock().expect("项目表锁");
            // 并发添加二次去重保护
            if slots.iter().any(|s| s.project_id == created_id) {
                true
            } else {
                slots.push(new_slot);
                false
            }
        };
        if duplicate {
            runtime.shutdown().await;
            return Err(GuanlanError::Conflict(format!(
                "目录已在项目列表中：{normalized}"
            )));
        }

        if input.activate {
            *self.active_id.write().expect("激活项目写锁") = created_id.clone();
        }
        self.persist_registry();
        self.publish_projects_notice("project_added");

        let list = self.list_projects().await;
        let project = list
            .projects
            .iter()
            .find(|p| p.project_id == created_id)
            .cloned()
            .ok_or_else(|| GuanlanError::Internal("新增项目后读取列表失败".to_owned()))?;
        Ok(ProjectMutationResponse {
            ok: true,
            active_project_id: list.active_project_id,
            project,
            projects: list.projects,
        })
    }

    /// 零重启秒切当前聚焦项目（POST /api/v1/projects/{project_id}/activate）
    pub async fn activate_project(
        &self,
        project_id: &str,
    ) -> Result<ProjectMutationResponse, GuanlanError> {
        // 先检查是否存在以及是否需要重连离线项目
        let need_reopen: Option<(String, bool)> = {
            let slots = self.slots.lock().expect("项目表锁");
            let slot = slots
                .iter()
                .find(|s| s.project_id == project_id)
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到项目：{project_id}")))?;
            if slot.runtime.is_none() {
                Some((slot.raw_root.clone(), slot.readonly))
            } else {
                None
            }
        };

        if let Some((raw_root, _readonly)) = need_reopen {
            match open_secondary_project_runtime(
                &raw_root,
                self.background_index,
                self.notices.clone(),
                true,
            )
            .await
            {
                Ok(rt) => {
                    let mut slots = self.slots.lock().expect("项目表锁");
                    if let Some(slot) = slots.iter_mut().find(|s| s.project_id == project_id) {
                        slot.runtime = Some(rt);
                        slot.status = "ready".to_owned();
                        slot.error = None;
                    }
                }
                Err((status, msg)) => {
                    let mut slots = self.slots.lock().expect("项目表锁");
                    if let Some(slot) = slots.iter_mut().find(|s| s.project_id == project_id) {
                        slot.status = status.clone();
                        slot.error = Some(msg.clone());
                    }
                    return Err(if status == "root_in_use" {
                        GuanlanError::RootInUse
                    } else {
                        GuanlanError::Conflict(format!("无法切换到该项目：{msg}"))
                    });
                }
            }
        }

        let now = now_iso_utc();
        {
            let mut slots = self.slots.lock().expect("项目表锁");
            if let Some(slot) = slots.iter_mut().find(|s| s.project_id == project_id) {
                slot.last_opened_at = now;
            }
        }
        *self.active_id.write().expect("激活项目写锁") = project_id.to_owned();
        self.persist_registry();
        self.publish_projects_notice("project_activated");

        let list = self.list_projects().await;
        let project = list
            .projects
            .iter()
            .find(|p| p.project_id == project_id)
            .cloned()
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到项目：{project_id}")))?;
        Ok(ProjectMutationResponse {
            ok: true,
            active_project_id: list.active_project_id,
            project,
            projects: list.projects,
        })
    }

    /// 更新项目显示别名或只读保护开关（PATCH /api/v1/projects/{project_id}）
    pub async fn update_project(
        &self,
        project_id: &str,
        input: UpdateProjectInput,
    ) -> Result<ProjectMutationResponse, GuanlanError> {
        {
            let mut slots = self.slots.lock().expect("项目表锁");
            let slot = slots
                .iter_mut()
                .find(|s| s.project_id == project_id)
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到项目：{project_id}")))?;
            if let Some(name) = input.name {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    return Err(GuanlanError::BadRequest("项目名称不能为空".to_owned()));
                }
                if trimmed.chars().count() > 80 {
                    return Err(GuanlanError::BadRequest(
                        "项目名称不能超过 80 个字符".to_owned(),
                    ));
                }
                slot.name = trimmed.to_owned();
            }
            if let Some(ro) = input.readonly {
                slot.readonly = ro;
            }
        }
        self.persist_registry();
        self.publish_projects_notice("project_updated");

        let list = self.list_projects().await;
        let project = list
            .projects
            .iter()
            .find(|p| p.project_id == project_id)
            .cloned()
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到项目：{project_id}")))?;
        Ok(ProjectMutationResponse {
            ok: true,
            active_project_id: list.active_project_id,
            project,
            projects: list.projects,
        })
    }

    /// 从观澜项目列表移除项目（释放监听与锁，绝不触碰磁盘文件）
    pub async fn remove_project(
        &self,
        project_id: &str,
    ) -> Result<ProjectListResponse, GuanlanError> {
        let removed_runtime: Option<Arc<ProjectRuntime>>;
        let next_active: Option<String>;
        {
            let mut slots = self.slots.lock().expect("项目表锁");
            let idx = slots
                .iter()
                .position(|s| s.project_id == project_id)
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到项目：{project_id}")))?;
            if slots.len() <= 1 {
                return Err(GuanlanError::BadRequest(
                    "至少保留一个工作项目；如需替换，请先添加新项目后再移除当前项目".to_owned(),
                ));
            }
            let active = self.active_project_id();
            if active == project_id {
                // 优先切到下一个在线项目；若其余均离线则拒绝移除最后一个在线主区
                let fallback = slots
                    .iter()
                    .find(|s| s.project_id != project_id && s.runtime.is_some())
                    .map(|s| s.project_id.clone());
                let Some(next_id) = fallback else {
                    return Err(GuanlanError::Conflict(
                        "其余项目当前均离线，无法移除最后一个在线项目".to_owned(),
                    ));
                };
                next_active = Some(next_id);
            } else {
                next_active = None;
            }
            let removed = slots.remove(idx);
            removed_runtime = removed.runtime;
        }

        if let Some(next_id) = next_active {
            *self.active_id.write().expect("激活项目写锁") = next_id;
        }
        if let Some(rt) = removed_runtime {
            rt.shutdown().await;
        }
        self.persist_registry();
        self.publish_projects_notice("project_removed");
        Ok(self.list_projects().await)
    }

    /// 对指定项目手动触发一次整库核验扫描（POST /api/v1/projects/{project_id}/rescan）
    pub fn rescan_project(&self, project_id: &str) -> Result<String, GuanlanError> {
        let (rt, _ro) = self.get_runtime(project_id)?;
        let (job_id, _, _) = rt.jobs.submit_kind(JobKind::VerifyAll);
        Ok(job_id)
    }

    /// 获取单个项目的完整目录树（含真实空目录 + 活跃受管文件）
    pub async fn project_tree(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<ProjectTreeResponse, GuanlanError> {
        let active = self.active_project_id();
        let slot = {
            let slots = self.slots.lock().expect("项目表锁");
            slots
                .iter()
                .find(|s| s.project_id == project_id)
                .cloned()
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到项目：{project_id}")))?
        };
        let is_active = slot.project_id == active;
        let Some(rt) = slot.runtime else {
            return Ok(ProjectTreeResponse {
                ok: true,
                project_id: slot.project_id,
                name: slot.name,
                root_path: slot.root_path,
                readonly: slot.readonly,
                is_active,
                status: slot.status,
                total: 0,
                truncated: false,
                folders: Vec::new(),
                files: Vec::new(),
            });
        };

        let pid = slot.project_id.clone();
        let name = slot.name.clone();
        let root_path = slot.root_path.clone();
        let readonly = slot.readonly;
        let status = if rt.jobs.has_active() {
            "scanning".to_owned()
        } else {
            slot.status.clone()
        };
        // 目录清单在只读查询体之外取：read_dir 整棵树不能占着连接池
        let listing = tokio::task::spawn_blocking({
            let rt = Arc::clone(&rt);
            move || rt.folder_listing()
        })
        .await
        .unwrap_or_default();
        rt.exec
            .run(move |store| {
                core_projects::project_tree(
                    store, &pid, &name, &root_path, readonly, is_active, &status, limit, &listing,
                )
            })
            .await
    }

    /// 跨项目今日首页总览（汇总全部受管项目卡片、全局待拍板决策与近期活跃文档）
    pub async fn overview(&self) -> ProjectsOverviewResponse {
        let active = self.active_project_id();
        let snapshot: Vec<ProjectSlot> = self.slots.lock().expect("项目表锁").clone();

        let mut projects = Vec::with_capacity(snapshot.len());
        let mut all_decisions: Vec<CrossProjectDecisionItem> = Vec::new();
        let mut all_recent: Vec<CrossProjectRecentFile> = Vec::new();
        let mut online_projects = 0usize;
        let mut total_files = 0u64;
        let mut total_pending_decisions = 0u64;

        for slot in snapshot {
            let is_active = slot.project_id == active;
            let entry = build_project_entry(&slot, is_active).await;
            if entry.status == "ready" || entry.status == "scanning" {
                online_projects += 1;
            }
            total_files += entry.file_count;
            total_pending_decisions += entry.pending_decisions_count;
            projects.push(entry);

            if let Some(rt) = slot.runtime {
                let pid = slot.project_id.clone();
                let pname = slot.name.clone();
                if let Ok((decs, recents)) = rt
                    .exec
                    .run(move |store| {
                        let d = core_projects::project_pending_decisions(store, &pid, &pname, 8)?;
                        let r = core_projects::project_recent_files(store, &pid, &pname, 8)?;
                        Ok((d, r))
                    })
                    .await
                {
                    all_decisions.extend(decs);
                    all_recent.extend(recents);
                }
            }
        }

        // 决策排序：来源不一致优先 → 最近观测时间降序
        all_decisions.sort_by(|a, b| {
            let rank = |s: &str| if s == "来源不一致" { 0u8 } else { 1u8 };
            rank(&a.status)
                .cmp(&rank(&b.status))
                .then_with(|| b.observed_at.cmp(&a.observed_at))
        });
        all_decisions.truncate(20);

        // 近期文档按观测时间降序
        all_recent.sort_by(|a, b| b.observed_at.cmp(&a.observed_at));
        all_recent.truncate(16);

        ProjectsOverviewResponse {
            ok: true,
            active_project_id: active,
            total_projects: projects.len(),
            online_projects,
            total_files,
            total_pending_decisions,
            projects,
            pending_decisions: all_decisions,
            recent_files: all_recent,
        }
    }

    /// 跨全部在线项目的统一搜索（供 Ctrl+K Omnibox 一键跳转任意项目文档）
    pub async fn search_all(&self, raw_query: &str, limit: usize) -> CrossProjectSearchResponse {
        let trimmed = raw_query.trim();
        let clamped = limit.clamp(1, 100);
        if trimmed.is_empty() {
            return CrossProjectSearchResponse {
                ok: true,
                query: String::new(),
                total_hits: 0,
                searched_projects: 0,
                offline_projects: 0,
                items: Vec::new(),
            };
        }

        let active = self.active_project_id();
        let snapshot: Vec<ProjectSlot> = self.slots.lock().expect("项目表锁").clone();
        let mut searched_projects = 0usize;
        let mut offline_projects = 0usize;
        let mut hits: Vec<CrossProjectSearchHit> = Vec::new();
        let per_project_limit = clamped.clamp(8, 30);

        for slot in snapshot {
            let Some(rt) = slot.runtime else {
                offline_projects += 1;
                continue;
            };
            searched_projects += 1;
            let pid = slot.project_id.clone();
            let pname = slot.name.clone();
            let is_active = slot.project_id == active;
            let q = trimmed.to_owned();
            if let Ok(part) = rt
                .exec
                .run(move |store| {
                    core_projects::project_search(
                        store,
                        &pid,
                        &pname,
                        is_active,
                        &q,
                        per_project_limit,
                    )
                })
                .await
            {
                hits.extend(part);
            }
        }

        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| b.is_active.cmp(&a.is_active))
                .then_with(|| a.file_id.cmp(&b.file_id))
        });
        let total_hits = hits.len();
        hits.truncate(clamped);

        CrossProjectSearchResponse {
            ok: true,
            query: trimmed.to_owned(),
            total_hits,
            searched_projects,
            offline_projects,
            items: hits,
        }
    }

    /// 非阻塞通知全部在线项目的写线程协作中止（服务停机/切换工作区时第一时间触发）。
    pub fn signal_shutdown(&self) {
        let runtimes: Vec<Arc<ProjectRuntime>> = {
            let slots = self.slots.lock().expect("项目表锁");
            slots
                .iter()
                .filter_map(|s| s.runtime.as_ref().map(Arc::clone))
                .collect()
        };
        for rt in runtimes {
            rt.jobs.signal_shutdown();
        }
    }

    /// 优雅停止全部受管项目的运行时（服务退出时调用）
    pub async fn shutdown_all(&self) {
        let runtimes: Vec<Arc<ProjectRuntime>> = {
            let mut slots = self.slots.lock().expect("项目表锁");
            slots.iter_mut().filter_map(|s| s.runtime.take()).collect()
        };
        for rt in &runtimes {
            rt.jobs.signal_shutdown();
        }
        for rt in runtimes {
            rt.shutdown().await;
        }
    }

    /// 同步紧急回收（Drop 兜底）：立即停止全部写线程并释放排他锁，不阻塞等待异步任务
    pub fn shutdown_sync(&self) {
        let runtimes: Vec<Arc<ProjectRuntime>> = {
            let mut slots = self.slots.lock().expect("项目表锁");
            slots.iter_mut().filter_map(|s| s.runtime.take()).collect()
        };
        for rt in &runtimes {
            rt.jobs.signal_shutdown();
        }
        for rt in runtimes {
            let mut g = rt.owned.lock().expect("项目运行时资源锁");
            g.watcher.take();
            if let Some(j) = g.jobs.take() {
                j.shutdown();
            }
            g.lock.take();
        }
    }

    fn persist_registry(&self) {
        let Some(path) = self.registry_path.as_deref() else {
            return;
        };
        let active = self.active_project_id();
        let projects: Vec<PersistedProject> = {
            let slots = self.slots.lock().expect("项目表锁");
            slots
                .iter()
                .map(|s| PersistedProject {
                    project_id: s.project_id.clone(),
                    root_path: s.root_path.clone(),
                    name: s.name.clone(),
                    readonly: s.readonly,
                    added_at: s.added_at.clone(),
                    last_opened_at: s.last_opened_at.clone(),
                })
                .collect()
        };
        let payload = PersistedRegistry {
            version: REGISTRY_VERSION,
            active_project_id: Some(active),
            projects,
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&payload) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, &json).is_ok() && std::fs::rename(&tmp, path).is_err() {
                let _ = std::fs::write(path, &json);
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }

    fn publish_projects_notice(&self, kind: &str) {
        self.notices.publish(SseNotice {
            index_generation: None,
            new_events: 0,
            new_revisions: 0,
            at: now_iso_utc(),
            kinds: vec![kind.to_owned()],
        });
    }
}

async fn build_project_entry(slot: &ProjectSlot, is_active: bool) -> ProjectEntry {
    let Some(rt) = slot.runtime.as_ref() else {
        return ProjectEntry {
            project_id: slot.project_id.clone(),
            name: slot.name.clone(),
            root_path: slot.root_path.clone(),
            readonly: slot.readonly,
            is_active,
            status: slot.status.clone(),
            error: slot.error.clone(),
            file_count: 0,
            folder_count: 0,
            pending_decisions_count: 0,
            index_generation: 0,
            is_scanning: false,
            last_scan_at: None,
            last_activity_at: None,
            added_at: slot.added_at.clone(),
            last_opened_at: slot.last_opened_at.clone(),
        };
    };

    let is_scanning = rt.jobs.has_active();
    // 目录清单在查询体之外取（缓存内的 read_dir 不占只读连接）
    let folder_count = tokio::task::spawn_blocking({
        let rt = Arc::clone(rt);
        move || rt.folder_listing().folders.len() as u64
    })
    .await
    .unwrap_or(0);
    match rt
        .exec
        .run(move |store| core_projects::project_live_metrics(store, folder_count))
        .await
    {
        Ok(m) => ProjectEntry {
            project_id: slot.project_id.clone(),
            name: slot.name.clone(),
            root_path: slot.root_path.clone(),
            readonly: slot.readonly,
            is_active,
            status: if is_scanning {
                "scanning".to_owned()
            } else {
                "ready".to_owned()
            },
            error: None,
            file_count: m.file_count,
            folder_count: m.folder_count,
            pending_decisions_count: m.pending_decisions_count,
            index_generation: m.index_generation,
            is_scanning,
            last_scan_at: m.last_scan_at,
            last_activity_at: m.last_activity_at,
            added_at: slot.added_at.clone(),
            last_opened_at: slot.last_opened_at.clone(),
        },
        Err(e) => ProjectEntry {
            project_id: slot.project_id.clone(),
            name: slot.name.clone(),
            root_path: slot.root_path.clone(),
            readonly: slot.readonly,
            is_active,
            status: "error".to_owned(),
            error: Some(e.to_string()),
            file_count: 0,
            folder_count: 0,
            pending_decisions_count: 0,
            index_generation: 0,
            is_scanning,
            last_scan_at: None,
            last_activity_at: None,
            added_at: slot.added_at.clone(),
            last_opened_at: slot.last_opened_at.clone(),
        },
    }
}

/// 打开并启动一个附加项目的隔离运行时（自动建库 + 轻量读池 + 可选 watcher + 首次扫描）
async fn open_secondary_project_runtime(
    root_path: &str,
    background_index: bool,
    notices: NoticeHub,
    trigger_initial_scan: bool,
) -> Result<Arc<ProjectRuntime>, (String, String)> {
    let root_owned = root_path.to_owned();
    let notices_for_blocking = notices.clone();

    // 同步 IO（目录检测 / 排他锁 / SQLite 开库 / 读连接池）放入阻塞线程池
    let opened = tokio::task::spawn_blocking(move || {
        if !Path::new(&root_owned).is_dir() {
            return Err((
                "offline".to_owned(),
                format!("目录不存在或不可访问：{root_owned}"),
            ));
        }
        let normalized =
            normalize_mount_root(&root_owned).map_err(|e| ("error".to_owned(), e.to_string()))?;
        let project_id = guanlan_core::domain::root_key_of(&normalized)
            .map_err(|e| ("error".to_owned(), e.to_string()))?;
        let data_dir =
            default_data_dir(&normalized).map_err(|e| ("error".to_owned(), e.to_string()))?;

        let lock = match acquire_workspace_lock(&data_dir) {
            Ok(l) => l,
            Err(GuanlanError::RootInUse) => {
                return Err((
                    "root_in_use".to_owned(),
                    "该目录已被另一个观澜实例独占锁定".to_owned(),
                ));
            }
            Err(e) => return Err(("error".to_owned(), e.to_string())),
        };

        let writer = guanlan_core::index::Writer::open_at(&data_dir, &normalized)
            .map_err(|e| ("error".to_owned(), e.to_string()))?;
        let needs_first_scan = writer
            .workspace()
            .ok()
            .and_then(|w| w.last_scan_at)
            .is_none();

        let (bridge_tx, bridge_rx) = std::sync::mpsc::channel::<SseNotice>();
        let notice_bridge = std::thread::Builder::new()
            .name(format!(
                "guanlan-notice-{}",
                &project_id[..8.min(project_id.len())]
            ))
            .spawn(move || {
                for notice in bridge_rx {
                    notices_for_blocking.publish(notice);
                }
            })
            .map_err(|e| ("error".to_owned(), format!("启动项目通知桥失败：{e}")))?;

        let jobs = IndexJobManager::start_with_options(writer, Some(bridge_tx), background_index);

        let pool_n = pool_size_from_env().clamp(1, BACKGROUND_POOL_SIZE);
        let mut stores = Vec::with_capacity(pool_n);
        for _ in 0..pool_n {
            match ReadonlyStore::open_at(&data_dir, &normalized) {
                Ok(s) => stores.push(s),
                Err(e) => {
                    drop(stores);
                    jobs.shutdown();
                    let _ = notice_bridge.join();
                    return Err(("error".to_owned(), e.to_string()));
                }
            }
        }
        let watcher_store = if background_index {
            match ReadonlyStore::open_at(&data_dir, &normalized) {
                Ok(s) => Some(s),
                Err(e) => {
                    drop(stores);
                    jobs.shutdown();
                    let _ = notice_bridge.join();
                    return Err(("error".to_owned(), e.to_string()));
                }
            }
        } else {
            None
        };

        let mounts = MountRegistry::load(&data_dir, &normalized);
        Ok((
            project_id,
            normalized,
            data_dir,
            stores,
            watcher_store,
            jobs,
            mounts,
            lock,
            notice_bridge,
            needs_first_scan,
        ))
    })
    .await
    .map_err(|e| ("error".to_owned(), format!("初始化项目任务异常：{e}")))??;

    let (
        project_id,
        normalized,
        data_dir,
        stores,
        watcher_store,
        jobs,
        mounts,
        lock,
        notice_bridge,
        needs_first_scan,
    ) = opened;

    let exec = Arc::new(QueryExecutor::new(stores));
    let watcher_handle = watcher_store.map(|ws| {
        let watcher_exec = Arc::new(QueryExecutor::new(vec![ws]));
        watcher::start(
            normalized.clone(),
            jobs.clone(),
            WatchBaseline::new(watcher_exec),
        )
    });

    // 首次接入的新目录（尚无扫描记录）或显式触发时，立刻后台入队一次整库扫描
    if trigger_initial_scan || needs_first_scan || background_index {
        let _ = jobs.submit_kind(JobKind::VerifyAll);
    }

    Ok(ProjectRuntime::from_existing(
        project_id,
        normalized,
        data_dir,
        exec,
        jobs,
        watcher_handle,
        mounts,
        lock,
        Some(notice_bridge),
    ))
}

fn read_registry_file(path: &Path) -> Option<PersistedRegistry> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: PersistedRegistry = serde_json::from_str(&raw).ok()?;
    if parsed.version != REGISTRY_VERSION {
        return None;
    }
    Some(parsed)
}

fn now_iso_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hh = rem / 3_600;
    let mm = (rem % 3_600) / 60;
    let ss = rem % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

#[cfg(test)]
mod multi_project_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("guanlan-multiproj-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建临时测试根目录");
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn json_req(
        app: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        let req = match body {
            Some(v) => {
                builder = builder.header("content-type", "application/json");
                builder.body(Body::from(v.to_string())).expect("req")
            }
            None => builder.body(Body::empty()).expect("req"),
        };
        let resp = app.clone().oneshot(req).await.expect("oneshot");
        let status = resp.status();
        let bytes = resp.into_body().collect().await.expect("body").to_bytes();
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}));
        (status, json)
    }

    #[tokio::test]
    async fn multi_project_hub_end_to_end_lifecycle() {
        let tmp = TempDir::new("e2e");
        let proj_a = tmp.0.join("alpha-project");
        let proj_b = tmp.0.join("beta-project");
        let proj_c = tmp.0.join("gamma-archive");
        let child_of_a = proj_a.join("nested-sub");
        let registry_file = tmp.0.join("projects.json");

        std::fs::create_dir_all(&child_of_a).expect("alpha");
        std::fs::create_dir_all(proj_b.join("empty_blueprint")).expect("beta empty");
        std::fs::create_dir_all(proj_b.join("specs")).expect("beta specs");
        std::fs::create_dir_all(&proj_c).expect("gamma");

        std::fs::write(
            proj_a.join("alpha-plan.md"),
            "# Alpha 总体规划\n\nAlphaUniqueToken 关键目标说明。\n",
        )
        .expect("write alpha");
        std::fs::write(
            proj_b.join("specs").join("beta-decision.md"),
            "# Beta 架构方案\n\nBetaUniqueToken 检索词。\n\n- [待确认] D-101：是否启用多项目并存架构？\n",
        )
        .expect("write beta");
        std::fs::write(
            proj_c.join("gamma-ref.md"),
            "# Gamma 历史规范\n\nGammaUniqueToken 归档内容。\n",
        )
        .expect("write gamma");

        // 启动主项目 Alpha（并绑定独立 projects.json 隔离真实用户配置）
        let raw_a = proj_a.to_string_lossy().into_owned();
        let data_a = default_data_dir(&raw_a).expect("data_a");
        let norm_a = normalize_mount_root(&raw_a).expect("norm_a");
        let id_a = guanlan_core::domain::root_key_of(&raw_a).expect("id_a");
        let lock_a = acquire_workspace_lock(&data_a).expect("lock_a");
        let writer_a = guanlan_core::index::Writer::open_at(&data_a, &raw_a).expect("writer_a");
        let jobs_a = IndexJobManager::start(writer_a);
        let _ = jobs_a.submit_kind(JobKind::VerifyAll);
        let store_a = ReadonlyStore::open_at(&data_a, &raw_a).expect("store_a");
        let exec_a = Arc::new(QueryExecutor::new(vec![store_a]));
        let mounts_a = MountRegistry::load(&data_a, &norm_a);
        let notices = NoticeHub::new();
        let rt_a = ProjectRuntime::from_existing(
            id_a.clone(),
            norm_a,
            data_a,
            Arc::clone(&exec_a),
            jobs_a.clone(),
            None,
            Arc::clone(&mounts_a),
            lock_a,
            None,
        );
        let hub = ProjectHub::start_with_primary(
            rt_a,
            raw_a,
            false,
            notices.clone(),
            Some(registry_file.clone()),
        )
        .await;

        let app = crate::http::build_router(crate::http::AppState {
            exec: exec_a,
            budget: Arc::new(crate::http::ResponseBudget::from_env()),
            instance_id: "inst_mp_test".to_owned(),
            dist: None,
            jobs: jobs_a,
            watcher: None,
            notices: Some(notices),
            mounts: mounts_a,
            projects: Some(Arc::clone(&hub)),
        });

        // 1) 初始列表恰有 Alpha
        let (st, list1) = json_req(&app, "GET", "/api/v1/projects", None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(list1["projects"].as_array().unwrap().len(), 1);
        assert_eq!(list1["active_project_id"].as_str().unwrap(), id_a);

        // 2) 父子嵌套与重复添加被确定性拦截（409 MOUNT_REJECTED / CONFLICT）
        let (st_child, err_child) = json_req(
            &app,
            "POST",
            "/api/v1/projects",
            Some(serde_json::json!({ "root_path": child_of_a.to_string_lossy() })),
        )
        .await;
        assert_eq!(st_child, StatusCode::CONFLICT);
        assert_eq!(err_child["code"], "MOUNT_REJECTED");

        let (st_dup, err_dup) = json_req(
            &app,
            "POST",
            "/api/v1/projects",
            Some(serde_json::json!({ "root_path": proj_a.to_string_lossy() })),
        )
        .await;
        assert_eq!(st_dup, StatusCode::CONFLICT);
        assert_eq!(err_dup["code"], "CONFLICT");

        // 3) 添加全新未扫描的 Beta（读写）与 Gamma（只读保护）
        let (st_b, res_b) = json_req(
            &app,
            "POST",
            "/api/v1/projects",
            Some(serde_json::json!({
                "root_path": proj_b.to_string_lossy(),
                "name": "项目 Beta",
                "readonly": false,
                "activate": false
            })),
        )
        .await;
        assert_eq!(st_b, StatusCode::OK, "add beta: {res_b}");
        let id_b = res_b["project"]["project_id"].as_str().unwrap().to_owned();

        let (st_c, res_c) = json_req(
            &app,
            "POST",
            "/api/v1/projects",
            Some(serde_json::json!({
                "root_path": proj_c.to_string_lossy(),
                "name": "历史归档 Gamma",
                "readonly": true,
                "activate": false
            })),
        )
        .await;
        assert_eq!(st_c, StatusCode::OK, "add gamma: {res_c}");
        let id_c = res_c["project"]["project_id"].as_str().unwrap().to_owned();

        // 等待 Beta/Gamma 首次自动扫描完成
        for _ in 0..40 {
            let (_, tree_b) =
                json_req(&app, "GET", &format!("/api/v1/projects/{id_b}/tree"), None).await;
            let (_, tree_c) =
                json_req(&app, "GET", &format!("/api/v1/projects/{id_c}/tree"), None).await;
            if tree_b["files"].as_array().is_some_and(|a| !a.is_empty())
                && tree_c["files"].as_array().is_some_and(|a| !a.is_empty())
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        // 4) 非激活项目 Beta 目录树包含真实空目录 empty_blueprint 及已索引文件
        let (st_tb, tree_b) =
            json_req(&app, "GET", &format!("/api/v1/projects/{id_b}/tree"), None).await;
        assert_eq!(st_tb, StatusCode::OK);
        let b_folders: Vec<&str> = tree_b["folders"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            b_folders.contains(&"empty_blueprint"),
            "应含空目录: {b_folders:?}"
        );
        assert!(!tree_b["files"].as_array().unwrap().is_empty());

        // 5) 在非激活项目 Beta 原地新建文件夹与 Markdown 文档
        let (st_mk, mk_json) = json_req(
            &app,
            "POST",
            &format!("/api/v1/projects/{id_b}/folders"),
            Some(serde_json::json!({ "parent_dir": "", "name": "inbox" })),
        )
        .await;
        assert_eq!(st_mk, StatusCode::OK, "create folder in beta: {mk_json}");
        assert!(proj_b.join("inbox").is_dir());

        let (st_doc, doc_json) = json_req(
            &app,
            "POST",
            &format!("/api/v1/projects/{id_b}/files/create"),
            Some(serde_json::json!({ "target_dir": "inbox", "name": "kickoff" })),
        )
        .await;
        assert_eq!(st_doc, StatusCode::OK, "create doc in beta: {doc_json}");
        assert!(proj_b.join("inbox").join("kickoff.md").is_file());

        // 6) 只读归档项目 Gamma 拒绝写入（403 CROSS_WORKSPACE_FORBIDDEN）
        let (st_ro, ro_json) = json_req(
            &app,
            "POST",
            &format!("/api/v1/projects/{id_c}/folders"),
            Some(serde_json::json!({ "parent_dir": "", "name": "forbidden" })),
        )
        .await;
        assert_eq!(st_ro, StatusCode::FORBIDDEN);
        assert_eq!(ro_json["code"], "CROSS_WORKSPACE_FORBIDDEN");

        // 7) 跨项目总览与跨项目搜索同时覆盖三项目
        let (st_ov, ov) = json_req(&app, "GET", "/api/v1/projects/overview", None).await;
        assert_eq!(st_ov, StatusCode::OK);
        assert_eq!(ov["total_projects"], 3);
        assert_eq!(ov["online_projects"], 3);
        assert!(ov["total_files"].as_u64().unwrap() >= 4);

        let (st_sq, sq) =
            json_req(&app, "GET", "/api/v1/projects/search?q=beta-decision", None).await;
        assert_eq!(st_sq, StatusCode::OK);
        assert!(
            sq["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|h| h["project_id"] == id_b),
            "跨项目搜索应命中 Beta: {sq}"
        );

        // 8) 零重启激活切换到 Beta → /api/v1/folders 与 /api/v1/bootstrap 立即指向 Beta
        let (st_act, act) = json_req(
            &app,
            "POST",
            &format!("/api/v1/projects/{id_b}/activate"),
            None,
        )
        .await;
        assert_eq!(st_act, StatusCode::OK);
        assert_eq!(act["active_project_id"], id_b);

        let (st_f, active_folders) = json_req(&app, "GET", "/api/v1/folders", None).await;
        assert_eq!(st_f, StatusCode::OK);
        let af: Vec<&str> = active_folders["folders"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            af.contains(&"empty_blueprint") && af.contains(&"inbox"),
            "{af:?}"
        );

        // 9) 移除 Gamma：列表缩为 2 项，且磁盘文件完好无损
        let (st_rm, rm_list) =
            json_req(&app, "DELETE", &format!("/api/v1/projects/{id_c}"), None).await;
        assert_eq!(st_rm, StatusCode::OK);
        assert_eq!(rm_list["projects"].as_array().unwrap().len(), 2);
        assert!(
            proj_c.join("gamma-ref.md").is_file(),
            "移除项目绝不能删除磁盘文件"
        );
        assert!(registry_file.is_file(), "projects.json 应已持久化");

        hub.shutdown_all().await;
    }
}
