//! C05 挂载注册表：只读参考工作区（第二库）的挂载 / 卸载 / 列表 / 溯源。
//!
//! 职责与纪律（任务卡 C05 / 契约 contract-query-api.md §2.5、contract-storage.md §13）：
//! 1. **只读第二库**：参考区经 [`guanlan_core::storage::ReadonlyStore::open_at`]
//!    以 `SQLITE_OPEN_READONLY` 打开其数据目录下的 `index.db`——参考区零写入，
//!    与主区写入者（唯一写线程）互不相干；
//! 2. **挂载前互斥校验**（quiet-md 外挂目录隔离纪律）：参考区与主区、参考区与
//!    既有挂载区两两做父子目录判定，互为祖先/后代一律 `MOUNT_REJECTED`（409），
//!    绝不放行嵌套成环；同一目录（含大小写变体）重复挂载 → `CONFLICT`；
//! 3. **确定性写拦截**：主区 rename/move/trash 端点受理前经
//!    [`MountRegistry::provenance_file`] 溯源，命中挂载区 →
//!    `CROSS_WORKSPACE_FORBIDDEN`（403）——主/挂载区之间硬性禁止移动与跨库写入；
//! 4. **离线降级**：挂载状态持久化在主区数据目录 `mounts.json`（观澜私有区，
//!    零业务目录污染）；服务重启逐条重开，打不开的挂载保留**最后已知摘要**并标
//!    `online=false` + `error`——优雅离线，绝不伪造在线数据；
//! 5. **身份与路径**：挂载身份 `mount_key = sha256(plain() 规范化根路径)[..16]`，
//!    `\\?\` 长路径 / 混合斜杠 / 尾分隔符写法哈希恒一致（core domain::mounts 纯函数）。
//!
//! 所有方法同步阻塞（SQLite 点查/小查询毫秒级），HTTP 处理器一律经
//! `spawn_blocking` 调用——异步线程不做 IO。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use guanlan_core::domain::mounts::{
    mount_display_name, mount_key_of_resolved, normalize_mount_root, path_relation, PathRelation,
};
use guanlan_core::dto::{MountedFilesResponse, MountedWorkspaceInfo, SearchResponse};
use guanlan_core::error::GuanlanError;
use guanlan_core::query;
use guanlan_core::storage::ReadonlyStore;

/// 挂载侧车文件名（主区数据目录内，观澜私有区；契约 §13）
const SIDECAR_FILE: &str = "mounts.json";
/// 侧车格式版本（结构变更整体重置，不迁移——挂载是可重建的轻状态）
const SIDECAR_VERSION: i64 = 1;

/// 单个挂载条目（注册表内部态；store=Some 即在线）
struct MountEntry {
    mount_key: String,
    /// 规范化后的参考区根路径
    root_path: String,
    /// 参考区数据目录（挂载时解析；随侧车持久化——重启按原目录重开，不受
    /// 后续 GUANLAN_DATA_DIR 环境漂移影响）
    ref_data_dir: PathBuf,
    name: String,
    added_at: String,
    /// 在线时持有只读连接；离线为 None
    store: Option<ReadonlyStore>,
    /// 最后已知摘要（在线探测成功即刷新；离线降级时保留字段、置 offline）
    last_known: Option<MountedWorkspaceInfo>,
}

/// 侧车记录（serde 形状；与 [`MountEntry`] 一一对应）
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MountRecord {
    mount_key: String,
    root_path: String,
    ref_data_dir: String,
    name: String,
    added_at: String,
    last_known: Option<MountedWorkspaceInfo>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MountSidecar {
    version: i64,
    mounts: Vec<MountRecord>,
}

/// 参考区数据目录解析器：给规范化根路径定位其 `index.db` 所在数据目录。
/// 生产默认 [`default_ref_data_dir`]（与索引侧同源：GUANLAN_DATA_DIR 整体替换 base）；
/// 测试经 [`MountRegistry::set_test_data_dirs`] 注入显式映射。
type RefDataDirResolver = Arc<dyn Fn(&str) -> Result<PathBuf, GuanlanError> + Send + Sync>;

/// 挂载注册表（AppState 持 Arc 共享；全部方法经内部互斥锁串行）
pub struct MountRegistry {
    inner: Mutex<RegistryInner>,
}

struct RegistryInner {
    /// 侧车所在目录（主区数据目录）；None = 不持久化（idle 装配）
    data_dir: Option<PathBuf>,
    /// 规范化后的主区根路径（互斥校验基准）；None = idle 装配（跳过主区校验）
    primary_root: Option<String>,
    entries: Vec<MountEntry>,
    /// 参考区数据目录解析器
    resolver: RefDataDirResolver,
}

impl MountRegistry {
    /// 空注册表（无持久化、无主区基准）——测试与只读装配用
    pub fn idle() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(RegistryInner {
                data_dir: None,
                primary_root: None,
                entries: Vec::new(),
                resolver: default_resolver(),
            }),
        })
    }

    /// 测试注入：按规范化根路径映射参考区数据目录（HTTP 端到端测试用；
    /// 生产路径恒为 default_data_dir 解析，不受此影响）
    #[cfg(test)]
    pub fn set_test_data_dirs(&self, map: std::collections::HashMap<String, PathBuf>) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.resolver = Arc::new(move |root| {
            map.get(root)
                .cloned()
                .ok_or_else(|| GuanlanError::NotFound(format!("测试解析表无该工作区：{root}")))
        });
    }

    /// 从侧车装载（服务启动）：逐条重开参考区只读连接，打不开的条目降级为
    /// 离线并保留最后已知摘要。侧车缺失/损坏按空注册表起步（stderr 告警），
    /// 绝不让挂载侧车问题阻断服务启动。
    pub fn load(data_dir: &Path, primary_root_normalized: &str) -> Arc<Self> {
        let records = match std::fs::read_to_string(data_dir.join(SIDECAR_FILE)) {
            Ok(raw) => match serde_json::from_str::<MountSidecar>(&raw) {
                Ok(sidecar) if sidecar.version == SIDECAR_VERSION => sidecar.mounts,
                Ok(sidecar) => {
                    eprintln!(
                        "警告: mounts.json 版本 {} 不受支持（期望 {SIDECAR_VERSION}），按空挂载表起步",
                        sidecar.version
                    );
                    Vec::new()
                }
                Err(e) => {
                    eprintln!("警告: mounts.json 解析失败（{e}），按空挂载表起步");
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        let mut entries = Vec::new();
        for record in records {
            // 优先按侧车记录的参考区数据目录重开（挂载时解析的原值）；旧格式
            // / 缺失时回退 default_data_dir 解析。打不开 = 离线降级
            let ref_dir = if record.ref_data_dir.is_empty() {
                default_ref_data_dir(&record.root_path)
            } else {
                Ok(PathBuf::from(&record.ref_data_dir))
            };
            let reopened =
                ref_dir.and_then(|ref_dir| open_reference_store(&ref_dir, &record.root_path));
            let (store, last_known) = match reopened {
                Ok(store) => match probe_summary(&store, &record.root_path, &record.name) {
                    Ok(info) => (Some(store), Some(info)),
                    Err(e) => (
                        None,
                        record
                            .last_known
                            .map(|info| mark_offline(info, format!("重启后探测失败，已离线：{e}"))),
                    ),
                },
                Err(e) => (
                    None,
                    record.last_known.map(|info| {
                        mark_offline(info, format!("重启后无法打开索引库，已离线：{e}"))
                    }),
                ),
            };
            entries.push(MountEntry {
                mount_key: record.mount_key,
                root_path: record.root_path.clone(),
                ref_data_dir: if record.ref_data_dir.is_empty() {
                    default_ref_data_dir(&record.root_path).unwrap_or_default()
                } else {
                    PathBuf::from(&record.ref_data_dir)
                },
                name: record.name,
                added_at: record.added_at,
                store,
                last_known,
            });
        }
        Arc::new(Self {
            inner: Mutex::new(RegistryInner {
                data_dir: Some(data_dir.to_path_buf()),
                primary_root: Some(primary_root_normalized.to_owned()),
                entries,
                resolver: default_resolver(),
            }),
        })
    }

    /// 挂载参考工作区（同步；处理器经 spawn_blocking 调用）。
    ///
    /// 校验顺序（确定性错误码优先于磁盘 IO）：
    /// 规范化 → 与主区父子互斥（MOUNT_REJECTED）→ 与既有挂载父子互斥（MOUNT_REJECTED）
    /// / 同目录（CONFLICT）→ 目录存在（NOT_FOUND）→ 索引库存在（NOT_FOUND，
    /// 提示先经观澜索引）→ 只读打开与认领 → 现读在线摘要 → 入表并持久化。
    pub fn mount(&self, root_path_raw: &str) -> Result<MountedWorkspaceInfo, GuanlanError> {
        let normalized = normalize_mount_root(root_path_raw)?;
        self.mount_inner(&normalized, None)
    }

    /// 测试装配：显式给定参考区数据目录（生产路径为 [`default_ref_data_dir`] 解析）
    #[cfg(test)]
    pub fn mount_at(
        &self,
        root_path_raw: &str,
        ref_data_dir: &Path,
    ) -> Result<MountedWorkspaceInfo, GuanlanError> {
        let normalized = normalize_mount_root(root_path_raw)?;
        self.mount_inner(&normalized, Some(ref_data_dir))
    }

    fn mount_inner(
        &self,
        normalized: &str,
        explicit_data_dir: Option<&Path>,
    ) -> Result<MountedWorkspaceInfo, GuanlanError> {
        let mount_key = mount_key_of_resolved(normalized);
        let mount_id = format!("m_{mount_key}");
        let name = mount_display_name(normalized);

        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // ① 与主区互斥（quiet-md：外挂目录严禁与主区互为父子）
        if let Some(primary) = &inner.primary_root {
            match path_relation(primary, normalized) {
                PathRelation::Equal => {
                    return Err(GuanlanError::MountRejected(format!(
                        "参考目录 {normalized} 就是当前工作区根目录，禁止自我挂载"
                    )));
                }
                PathRelation::AncestorOf => {
                    return Err(GuanlanError::MountRejected(format!(
                        "参考目录 {normalized} 包含当前工作区根目录（{primary}）：父子目录互相包含互斥，禁止嵌套挂载"
                    )));
                }
                PathRelation::DescendantOf => {
                    return Err(GuanlanError::MountRejected(format!(
                        "参考目录 {normalized} 位于当前工作区根目录（{primary}）之内：父子目录互相包含互斥，禁止嵌套挂载"
                    )));
                }
                PathRelation::Disjoint => {}
            }
        }
        // ② 与既有挂载互斥 / 重复挂载
        for entry in &inner.entries {
            match path_relation(&entry.root_path, normalized) {
                PathRelation::Equal => {
                    return Err(GuanlanError::Conflict(format!(
                        "参考目录 {normalized} 已挂载（mount_id=m_{}，大小写变体视为同一目录）",
                        entry.mount_key
                    )));
                }
                PathRelation::AncestorOf | PathRelation::DescendantOf => {
                    return Err(GuanlanError::MountRejected(format!(
                        "参考目录 {normalized} 与既有挂载「{}」（{}）互为父子目录：挂载区之间禁止嵌套成环",
                        entry.name, entry.root_path
                    )));
                }
                PathRelation::Disjoint => {}
            }
            if entry.mount_key == mount_key {
                return Err(GuanlanError::Conflict(format!(
                    "该参考工作区已挂载（mount_id={mount_id}）"
                )));
            }
        }
        // ③ 目录存在性
        if !Path::new(normalized).is_dir() {
            return Err(GuanlanError::NotFound(format!(
                "参考目录不存在或不可访问：{normalized}"
            )));
        }
        // ④ 参考区数据目录与索引库（测试显式目录优先；生产走注入的解析器）
        let ref_data_dir = match explicit_data_dir {
            Some(dir) => dir.to_path_buf(),
            None => (inner.resolver)(normalized)?,
        };
        let store = open_reference_store(&ref_data_dir, normalized).map_err(|e| {
            if matches!(e, GuanlanError::NotFound(_)) {
                GuanlanError::NotFound(format!(
                    "参考工作区尚无观澜索引库（{}）：请先用观澜打开该目录建立索引后再挂载",
                    ref_data_dir.display()
                ))
            } else {
                e
            }
        })?;
        // ⑤ 现读在线摘要
        let info = probe_summary(&store, normalized, &name)?;
        // ⑥ 入表 + 持久化
        inner.entries.push(MountEntry {
            mount_key: mount_key.clone(),
            root_path: normalized.to_owned(),
            ref_data_dir,
            name: name.clone(),
            added_at: guanlan_core::index::clock::now_iso(),
            store: Some(store),
            last_known: Some(info.clone()),
        });
        persist_sidecar(&inner);
        Ok(info)
    }

    /// 卸载（只断开只读连接并移除登记，绝不动参考区磁盘与索引库）
    pub fn unmount(&self, mount_id: &str) -> Result<(), GuanlanError> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let before = inner.entries.len();
        inner
            .entries
            .retain(|e| format!("m_{}", e.mount_key) != mount_id);
        if inner.entries.len() == before {
            return Err(GuanlanError::NotFound(format!("未找到挂载 {mount_id}")));
        }
        persist_sidecar(&inner);
        Ok(())
    }

    /// 列表：在线条目现读摘要（探测失败原位降级为离线），离线条目给最后已知摘要。
    /// 任何情况下不伪造在线数据。
    pub fn list(&self) -> Vec<MountedWorkspaceInfo> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = Vec::new();
        for entry in &mut inner.entries {
            let info = match &entry.store {
                Some(store) => match probe_summary(store, &entry.root_path, &entry.name) {
                    Ok(live) => {
                        entry.last_known = Some(live.clone());
                        live
                    }
                    // 探测失败：参考区目录/索引库刚被移走或损坏 → 原位离线降级
                    Err(e) => {
                        entry.store = None;
                        let offline = offline_info(entry, format!("在线探测失败，已离线：{e}"));
                        entry.last_known = Some(offline.clone());
                        offline
                    }
                },
                None => offline_info(
                    entry,
                    "离线：参考区索引库暂不可达（可确认目录仍在后重试挂载）".to_owned(),
                ),
            };
            out.push(info);
        }
        out
    }

    /// 写拦截溯源：file_id 命中任一在线挂载区 → 返回该挂载摘要（主区未命中时
    /// 由 HTTP 处理器据此确定性拒绝）。离线条目跳过（无连接无从命中）。
    pub fn provenance_file(
        &self,
        file_id: &str,
    ) -> Result<Option<MountedWorkspaceInfo>, GuanlanError> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        for entry in &inner.entries {
            let Some(store) = &entry.store else { continue };
            if query::cross_search::file_exists(store, file_id)? {
                let info = entry
                    .last_known
                    .clone()
                    .unwrap_or_else(|| minimal_info(entry));
                return Ok(Some(info));
            }
        }
        Ok(None)
    }

    /// 版本级读路由溯源：revision_id 属于哪个挂载区（点查 revisions 主键）
    pub fn find_revision(&self, revision_id: &str) -> Result<Option<String>, GuanlanError> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        for entry in &inner.entries {
            let Some(store) = &entry.store else { continue };
            if query::cross_search::revision_exists(store, revision_id)? {
                return Ok(Some(format!("m_{}", entry.mount_key)));
            }
        }
        Ok(None)
    }

    /// 在指定挂载区的只读连接上执行查询（离线 → NOT_FOUND 诚实口径，绝不伪造数据）
    pub fn run_on_mount<T>(
        &self,
        mount_id: &str,
        f: impl FnOnce(&ReadonlyStore) -> Result<T, GuanlanError>,
    ) -> Result<T, GuanlanError> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let entry = inner
            .entries
            .iter_mut()
            .find(|e| format!("m_{}", e.mount_key) == mount_id)
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到挂载 {mount_id}")))?;
        let store = entry.store.as_mut().ok_or_else(|| {
            GuanlanError::NotFound(format!(
                "挂载 {mount_id} 当前离线（{}）：最后已知摘要见 /api/v1/mounts",
                entry.root_path
            ))
        })?;
        f(store)
    }

    /// 列出指定挂载区的只读文件与目录清单（侧栏目录树浏览；离线 → NOT_FOUND 诚实口径）
    pub fn list_mount_files(
        &self,
        mount_id: &str,
        limit: usize,
    ) -> Result<MountedFilesResponse, GuanlanError> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let entry = inner
            .entries
            .iter_mut()
            .find(|e| format!("m_{}", e.mount_key) == mount_id)
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到挂载 {mount_id}")))?;
        let store = entry.store.as_ref().ok_or_else(|| {
            GuanlanError::NotFound(format!(
                "挂载 {mount_id} 当前离线（{}）：无法列出目录结构",
                entry.root_path
            ))
        })?;
        query::cross_search::mount_list_files(store, mount_id, &entry.name, &entry.root_path, limit)
    }

    /// 联合检索：对全部在线挂载区跑 C02 检索（串行；离线区 response=None）。
    /// 单区失败不拖垮整体——该区原位降级离线，响应诚实标注。
    pub fn search_mounts(
        &self,
        search_query: &guanlan_core::query::SearchQuery,
    ) -> Vec<guanlan_core::query::cross_search::MountedSearchOutcome> {
        use guanlan_core::query::cross_search::MountedSearchOutcome;
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = Vec::new();
        for entry in &mut inner.entries {
            let mut info = match &entry.store {
                Some(store) => match probe_summary(store, &entry.root_path, &entry.name) {
                    Ok(live) => {
                        entry.last_known = Some(live.clone());
                        live
                    }
                    Err(e) => {
                        entry.store = None;
                        let offline = offline_info(entry, format!("在线探测失败，已离线：{e}"));
                        entry.last_known = Some(offline.clone());
                        offline
                    }
                },
                None => offline_info(entry, "离线：参考区索引库暂不可达".to_owned()),
            };
            let mut response: Option<SearchResponse> = None;
            if let Some(store) = entry.store.as_ref() {
                match query::search(store, search_query) {
                    Ok(resp) => response = Some(resp),
                    // 单区检索失败：原位降级离线（诚实口径），不拖垮其余挂载区
                    Err(e) => {
                        entry.store = None;
                        info = offline_info(entry, format!("检索失败，已离线：{e}"));
                        entry.last_known = Some(info.clone());
                    }
                }
            }
            out.push(MountedSearchOutcome { info, response });
        }
        out
    }
}

/// 默认参考区数据目录解析器（与生产索引侧同源解析：GUANLAN_DATA_DIR 整体替换 base）
fn default_ref_data_dir(normalized_root: &str) -> Result<PathBuf, GuanlanError> {
    guanlan_core::storage::default_data_dir(normalized_root)
}

fn default_resolver() -> RefDataDirResolver {
    Arc::new(default_ref_data_dir)
}

/// 打开参考区只读库并认领工作区行（认领失败 = 库内无可认领行 = 未被观澜索引）
fn open_reference_store(
    ref_data_dir: &Path,
    normalized_root: &str,
) -> Result<ReadonlyStore, GuanlanError> {
    if !ref_data_dir.join("index.db").exists() {
        return Err(GuanlanError::NotFound(format!(
            "参考区索引库不存在：{}",
            ref_data_dir.display()
        )));
    }
    ReadonlyStore::open_at(ref_data_dir, normalized_root)
}

/// 在线摘要现读：root_key / index_generation / active 文件数 / search_state。
/// 结果即「最后已知摘要」的最新值（挂载身份字段由登记项补齐）。
fn probe_summary(
    store: &ReadonlyStore,
    normalized_root: &str,
    name: &str,
) -> Result<MountedWorkspaceInfo, GuanlanError> {
    let (root_key, index_generation, file_count, search_state) =
        query::cross_search::mount_live_summary(store)?;
    let mount_key = mount_key_of_resolved(normalized_root);
    Ok(MountedWorkspaceInfo {
        mount_id: format!("m_{mount_key}"),
        mount_key,
        root_key,
        root_path: normalized_root.to_owned(),
        name: name.to_owned(),
        online: true,
        index_generation,
        search_state,
        file_count,
        error: None,
        last_seen_at: Some(guanlan_core::index::clock::now_iso()),
    })
}

/// 离线摘要：保留最后已知字段 + 离线原因（绝不伪造 online=true）
fn offline_info(entry: &MountEntry, error: String) -> MountedWorkspaceInfo {
    let mut info = entry
        .last_known
        .clone()
        .unwrap_or_else(|| minimal_info(entry));
    info.online = false;
    info.error = Some(error);
    info
}

/// 从未成功在线（重启装载即失败且无侧车摘要）：最小诚实信息
fn minimal_info(entry: &MountEntry) -> MountedWorkspaceInfo {
    MountedWorkspaceInfo {
        mount_id: format!("m_{}", entry.mount_key),
        mount_key: entry.mount_key.clone(),
        root_key: String::new(),
        root_path: entry.root_path.clone(),
        name: entry.name.clone(),
        online: false,
        index_generation: 0,
        search_state: "absent".to_owned(),
        file_count: 0,
        error: None,
        last_seen_at: None,
    }
}

/// 侧车装载/降级共用：置 offline 并附原因
fn mark_offline(mut info: MountedWorkspaceInfo, error: String) -> MountedWorkspaceInfo {
    info.online = false;
    info.error = Some(error);
    info
}

/// 侧车原子落盘（tmp + rename；失败仅 stderr 告警——内存登记仍是事实源，
/// 挂载是可重建的轻状态，不为侧车 IO 打断挂载语义）
fn persist_sidecar(inner: &RegistryInner) {
    let Some(data_dir) = &inner.data_dir else {
        return;
    };
    let records: Vec<MountRecord> = inner
        .entries
        .iter()
        .map(|e| MountRecord {
            mount_key: e.mount_key.clone(),
            root_path: e.root_path.clone(),
            ref_data_dir: e.ref_data_dir.to_string_lossy().into_owned(),
            name: e.name.clone(),
            added_at: e.added_at.clone(),
            last_known: e.last_known.clone(),
        })
        .collect();
    let sidecar = MountSidecar {
        version: SIDECAR_VERSION,
        mounts: records,
    };
    let path = data_dir.join(SIDECAR_FILE);
    let tmp = data_dir.join(format!("{SIDECAR_FILE}.tmp"));
    let payload = match serde_json::to_vec_pretty(&sidecar) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("警告: mounts.json 序列化失败（{e}），跳过落盘");
            return;
        }
    };
    if let Err(e) = std::fs::write(&tmp, &payload).and_then(|()| std::fs::rename(&tmp, &path)) {
        eprintln!("警告: mounts.json 落盘失败（{e}），挂载表仅保留在内存");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 最小可认领库 DDL（workspaces + files + revisions + meta；探针所需全集）
    const LITE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, root_key TEXT NOT NULL,
  created_at TEXT NOT NULL, last_scan_at TEXT, index_generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, current_path TEXT NOT NULL,
  format TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,
  first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
  last_mtime_ms INTEGER NOT NULL DEFAULT 0, last_revision_id TEXT, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS revisions (
  revision_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL, prev_revision_id TEXT, content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, observed_at TEXT NOT NULL, occurred_at TEXT,
  occurred_precision TEXT NOT NULL DEFAULT 'unknown', occurred_source TEXT,
  snapshot_hash TEXT NOT NULL, snapshot_available INTEGER NOT NULL DEFAULT 1,
  extract_rule_version TEXT NOT NULL, UNIQUE (file_id, seq)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#;

    /// 临时目录守卫（测试结束清理）
    struct TempGuard(PathBuf);
    impl TempGuard {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "guanlan-svc-mounts-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }
    }
    impl Drop for TempGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 建一个"曾被观澜索引过"的最小参考工作区（1 active 文件 + 1 版本）
    fn make_reference_ws(base: &Path, tag: &str) -> (String, PathBuf) {
        let root = base.join(tag);
        std::fs::create_dir_all(&root).expect("建参考目录");
        std::fs::write(root.join("README.md"), "# 参考区\n历史采纳的规范正文。\n").expect("写文档");
        let data_dir = base.join(format!("{tag}-data"));
        std::fs::create_dir_all(&data_dir).expect("建数据目录");
        let resolved = guanlan_core::domain::resolve_root_with(&root.to_string_lossy(), "H:\\");
        let root_key = guanlan_core::domain::root_key_of_resolved(&resolved);
        let conn = rusqlite::Connection::open(data_dir.join("index.db")).expect("建库");
        conn.execute_batch(LITE_DDL).expect("建表");
        let ws_id = guanlan_core::domain::workspace_id_of(&root_key);
        conn.execute(
            "INSERT INTO workspaces (workspace_id, root_path, root_key, created_at) VALUES (?1, ?2, ?3, '2026-01-01')",
            rusqlite::params![ws_id, resolved, root_key],
        )
        .expect("写工作区行");
        conn.execute(
            "INSERT INTO files (file_id, workspace_id, current_path, format, title, role, first_observed_at, last_observed_at, last_revision_id, status) \
             VALUES ('f_ref', ?1, 'README.md', 'md', '参考', '方案', '2026-01-01', '2026-01-01', 'f_ref_r1', 'active')",
            [&ws_id],
        )
        .expect("写文件行");
        conn.execute(
            "INSERT INTO revisions (revision_id, file_id, workspace_id, seq, content_hash, size_bytes, observed_at, snapshot_hash, snapshot_available, extract_rule_version) \
             VALUES ('f_ref_r1', 'f_ref', ?1, 1, 'aa00', 8, '2026-01-01', 'aa00', 1, 'v0.4.3')",
            [&ws_id],
        )
        .expect("写版本行");
        drop(conn);
        (root.to_string_lossy().into_owned(), data_dir)
    }

    /// 互斥矩阵：自我挂载 / 子目录 / 父目录 / 与既有挂载嵌套 → MOUNT_REJECTED；
    /// 重复挂载（含 \\?\ 长路径与混合斜杠写法）→ CONFLICT
    #[test]
    fn mount_rejects_nesting_and_duplicates_deterministically() {
        let base = TempGuard::new("mutex");
        let (ref_root, ref_data) = make_reference_ws(base.0.as_path(), "ref");
        let primary = base.0.join("primary");
        std::fs::create_dir_all(&primary).expect("建主区");
        let registry = MountRegistry::idle();
        let info = registry
            .mount_at(&ref_root, &ref_data)
            .expect("首次挂载应成功");
        assert!(info.online);
        assert_eq!(info.file_count, 1);
        assert_eq!(
            info.search_state, "absent",
            "最小库无检索索引 → 诚实 absent"
        );

        // 重复挂载（同路径 / \\?\ 长路径 / 混合斜杠）→ CONFLICT（规范化收敛同一身份）
        for variant in [
            ref_root.clone(),
            format!(r"\\?\{}", ref_root),
            format!("{}/", ref_root.replace('\\', "/")),
        ] {
            let err = registry
                .mount_at(&variant, &ref_data)
                .expect_err("重复挂载必须拒绝");
            assert!(
                matches!(err, GuanlanError::Conflict(_)),
                "重复挂载应为 CONFLICT：{err}"
            );
        }

        // 自我挂载（主区基准）→ MOUNT_REJECTED
        // （idle 无主区基准；带主区基准的注册表经 load 构造，空目录=空侧车）
        let dir = base.0.join("data-primary");
        std::fs::create_dir_all(&dir).expect("建主区数据目录");
        let with_primary = MountRegistry::load(&dir, &primary.to_string_lossy());
        for candidate in [
            primary.to_string_lossy().into_owned(),
            primary.join("nested").to_string_lossy().into_owned(),
            base.0.to_string_lossy().into_owned(), // 主区的父目录
        ] {
            let err = with_primary
                .mount_at(&candidate, &ref_data)
                .expect_err("父子/自我挂载必须拒绝");
            assert!(
                matches!(err, GuanlanError::MountRejected(_)),
                "父子互斥应为 MOUNT_REJECTED：{err}"
            );
        }

        // 与既有挂载嵌套（参考区的子/父目录）→ MOUNT_REJECTED
        let ref_parent = std::path::Path::new(&ref_root)
            .parent()
            .expect("参考区父目录")
            .to_string_lossy()
            .into_owned();
        for candidate in [format!(r"{ref_root}\nested"), ref_parent] {
            let err = registry
                .mount_at(&candidate, &ref_data)
                .expect_err("与既有挂载嵌套必须拒绝");
            assert!(
                matches!(err, GuanlanError::MountRejected(_)),
                "挂载区嵌套应为 MOUNT_REJECTED：{err}"
            );
        }
    }

    /// 侧车 roundtrip：挂载后落盘、重启 load 重开在线；溯源点查与版本读路由可用
    #[test]
    fn sidecar_roundtrip_and_provenance() {
        let base = TempGuard::new("sidecar");
        let (ref_root, ref_data) = make_reference_ws(base.0.as_path(), "ref");
        let data_dir = base.0.join("data");
        std::fs::create_dir_all(&data_dir).expect("建数据目录");
        let primary = base.0.join("primary");
        std::fs::create_dir_all(&primary).expect("建主区");

        let registry = MountRegistry::load(&data_dir, &primary.to_string_lossy());
        let info = registry.mount_at(&ref_root, &ref_data).expect("挂载");
        assert!(info.online);
        // 侧车已落盘
        assert!(data_dir.join(SIDECAR_FILE).exists(), "挂载后应写侧车");

        // 溯源：file_id 命中挂载区
        let hit = registry
            .provenance_file("f_ref")
            .expect("溯源查询失败")
            .expect("应命中挂载区");
        assert_eq!(hit.mount_id, info.mount_id);
        assert!(registry.provenance_file("f_other").unwrap().is_none());

        // 版本级读路由：revision 溯源 + 在指定挂载区执行查询
        let mount_id = registry
            .find_revision("f_ref_r1")
            .expect("版本溯源失败")
            .expect("应命中");
        let rev_ok = registry
            .run_on_mount(&mount_id, |store| {
                query::cross_search::revision_exists(store, "f_ref_r1")
            })
            .expect("挂载区执行失败");
        assert!(rev_ok);

        // 重启装载：重开同一侧车 → 在线
        let reloaded = MountRegistry::load(&data_dir, &primary.to_string_lossy());
        let listed = reloaded.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].online, "重启后参考区仍在应在线");
        assert_eq!(listed[0].mount_id, info.mount_id);
        assert_eq!(listed[0].file_count, 1);

        // 卸载 → 侧车同步移除；未知 mount_id 404
        reloaded.unmount(&info.mount_id).expect("卸载失败");
        assert!(reloaded.list().is_empty());
        let err = reloaded
            .unmount(&info.mount_id)
            .expect_err("二次卸载应 404");
        assert!(matches!(err, GuanlanError::NotFound(_)));
    }

    /// 离线降级：重启时索引库打不开 → online=false + 最后已知摘要保留（绝不伪造在线）
    #[test]
    fn offline_mount_keeps_last_known_summary() {
        let base = TempGuard::new("offline");
        let data_dir = base.0.join("data");
        std::fs::create_dir_all(&data_dir).expect("建数据目录");
        let primary = base.0.join("primary");
        std::fs::create_dir_all(&primary).expect("建主区");

        // 手写侧车：一条指向不存在目录的挂载 + 完整最后已知摘要
        let sidecar = serde_json::json!({
            "version": 1,
            "mounts": [{
                "mount_key": "deadbeef00000000",
                "root_path": r"Z:\no-such-dir\gone-ws",
                "ref_data_dir": r"C:\no-such-data\gone-ws",
                "name": "gone-ws",
                "added_at": "2026-11-21T09:00:00.000+08:00",
                "last_known": {
                    "mount_id": "m_deadbeef00000000",
                    "mount_key": "deadbeef00000000",
                    "root_key": "rk_was_online",
                    "root_path": r"Z:\no-such-dir\gone-ws",
                    "name": "gone-ws",
                    "online": true,
                    "index_generation": 5,
                    "search_state": "ready",
                    "file_count": 42,
                    "error": null,
                    "last_seen_at": "2026-11-20T18:00:00.000+08:00"
                }
            }]
        });
        std::fs::write(
            data_dir.join(SIDECAR_FILE),
            serde_json::to_string_pretty(&sidecar).expect("序列化侧车"),
        )
        .expect("写侧车");

        let registry = MountRegistry::load(&data_dir, &primary.to_string_lossy());
        let listed = registry.list();
        assert_eq!(listed.len(), 1);
        let gone = &listed[0];
        assert!(!gone.online, "索引库不可达必须诚实离线");
        assert!(gone.error.as_deref().unwrap_or_default().contains("离线"));
        // 最后已知摘要逐字段保留（验收「离线时优雅显示最后已知摘要」）
        assert_eq!(gone.root_key, "rk_was_online");
        assert_eq!(gone.index_generation, 5);
        assert_eq!(gone.search_state, "ready");
        assert_eq!(gone.file_count, 42);
        assert_eq!(
            gone.last_seen_at.as_deref(),
            Some("2026-11-20T18:00:00.000+08:00")
        );
    }
}
