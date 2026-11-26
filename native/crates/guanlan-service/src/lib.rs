//! guanlan-service 库入口：把 `guanlan serve` 的启动流程暴露成可编程接口，
//! 供 CLI 与桌面壳（guanlan-desktop，Tauri 进程内嵌）共用同一份服务实现——
//! 桌面壳不复制数据库与索引代码，只启动或连接同一服务，不另建实现。
//!
//! 读取路径与 CLI 完全一致：数据目录解析 → 同工作区 OS 级排他锁 → 只读打开
//! index.db 并认领工作区行 → 绑定 127.0.0.1 → axum 路由。任何一步失败返回
//! [`GuanlanError`]（CLI 端转统一错误包络退出；桌面壳弹启动失败提示）。

pub mod folders;
pub mod http;
pub mod index_jobs;
pub mod mcp;
pub mod mounts;
pub mod projects;
pub mod runtime;
pub mod watcher;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

pub use guanlan_core::error::GuanlanError;
use guanlan_core::storage::ReadonlyStore;

/// 服务启动配置。
pub struct ServeConfig {
    /// 工作区根目录（原始字符串参与身份计算，契约 §2.1：按 Node path.resolve(win32)
    /// 口径解析，不提前经 PathBuf 规范化）。
    pub root: String,
    /// 监听端口；0 = 内核分配随机端口。
    pub port: u16,
    /// 桌面壳模式：为 Tauri WebView（http(s)://tauri.localhost）与本机开发端口放行
    /// CORS。CLI serve 同源访问不需要，保持默认 false 不改变现有行为。
    pub cors_desktop: bool,
    /// 后台增量索引：启用后启动 File Watcher（OS 原生事件驱动，
    /// 100ms 滑动防抖 + 220ms 合并上限，见 [`watcher`]），
    /// 并在启动时入队一次整库核验，让「打开即见已存数据、后台并入最新改动」成立。
    ///
    /// 默认 **关闭**，因为它会写库：`guanlan serve` 的既有契约是「打开已有数据零扫描」
    /// （contract-storage.md §4-3）。启动重扫会把 `last_observed_at` 等观测事实改写成
    /// 当前时刻，使 API 输出与库内既有事实不再逐字一致（smoke-v1 正依赖该口径做
    /// Node↔Rust 端点比对）。桌面壳与需要实时跟随本地改动的本地服务显式打开它，
    /// CLI 侧开关是 `guanlan serve --watch`。
    ///
    /// 与本开关无关的能力：Inline 拍板 / MCP 回写等写回端点始终可用（它们自带 job
    /// 队列），只是不会自动感知外部文件改动。
    pub background_index: bool,
}

/// 运行中的服务实例。句柄被 drop 或调用 [`Self::shutdown`] 前服务持续运行；
/// 多项目运行时由 [`projects::ProjectHub`] 统一托管，停机/drop 时释放端口、写线程、监听任务与全部工作区锁。
pub struct RunningService {
    /// `http://127.0.0.1:<port>`，供前端注入 API 基址 / MCP 代理连接。
    pub endpoint: String,
    /// 实际监听地址（随机端口口径下的权威值）。
    pub local_addr: SocketAddr,
    /// 服务实例身份（SSE 通知三元组之一）。
    pub instance_id: String,
    /// 初始主工作区数据目录（index.db 与 blobs/ 所在）。
    pub data_dir: PathBuf,
    server: Option<tokio::task::JoinHandle<()>>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    notices: runtime::NoticeHub,
    projects: Arc<projects::ProjectHub>,
}

impl RunningService {
    /// 当前聚焦激活项目的根目录（随 `/api/v1/projects/{id}/activate` 实时变化）。
    pub fn active_root(&self) -> String {
        self.projects.active_root_path()
    }

    /// 多项目并存中枢句柄（桌面壳与测试用）。
    pub fn projects_hub(&self) -> Arc<projects::ProjectHub> {
        Arc::clone(&self.projects)
    }

    /// 提交增量路径核验任务（供桌面壳拖拽导入等本机操作立即触发索引，不等待 watcher 防抖）。
    pub fn submit_changed_paths(&self, paths: Vec<String>) -> Option<String> {
        if paths.is_empty() || paths.len() > 2000 {
            return None;
        }
        let rt = self.projects.active_runtime()?;
        rt.jobs
            .submit_external(index_jobs::JobKind::ChangedPaths(paths))
            .ok()
            .map(|(job_id, _, _)| job_id)
    }

    /// 等待服务任务结束（CLI 阻塞用；桌面壳不调用，切换/退出走 [`Self::shutdown`]）。
    pub async fn join(mut self) {
        if let Some(server) = self.server.take() {
            if let Err(e) = server.await {
                eprintln!("服务任务结束: {e}");
            }
        }
    }

    /// 优雅停机并释放全部项目的工作区锁、监听套接字、写线程、watcher 与 SSE 连接（切换/退出零泄漏）。
    pub async fn shutdown(mut self) {
        self.projects.signal_shutdown();
        self.notices.close();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(mut server) = self.server.take() {
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut server)
                .await
                .is_err()
            {
                server.abort();
                let _ = server.await;
            }
        }
        self.projects.shutdown_all().await;
    }
}

impl Drop for RunningService {
    fn drop(&mut self) {
        self.projects.signal_shutdown();
        self.notices.close();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(server) = self.server.take() {
            server.abort();
        }
        self.projects.shutdown_sync();
    }
}

/// 按 [`ServeConfig`] 启动只读/多项目服务（与 `guanlan serve` 同一流程）：
/// 数据目录解析 → 工作区排他锁 → 可写库就位（建库或确保 schema 与工作区行）→
/// 写线程与通知桥 → 只读连接池认领 → 绑定 127.0.0.1 → 路由 → 后台对账入队。
/// 成功即已开始监听；调用方持有 [`RunningService`] 维持运行。
pub async fn start_readonly_service(cfg: ServeConfig) -> Result<RunningService, GuanlanError> {
    start_service_with_projects_file(cfg, projects::default_projects_file_path()).await
}

/// 同 [`start_readonly_service`]，但允许调用方显式指定全局多项目注册表文件路径（桌面壳/测试隔离）。
pub async fn start_service_with_projects_file(
    cfg: ServeConfig,
    projects_file: Option<PathBuf>,
) -> Result<RunningService, GuanlanError> {
    let root = cfg.root;
    if !PathBuf::from(&root).is_dir() {
        return Err(GuanlanError::NotFound(format!(
            "--root 不是有效目录: {root}"
        )));
    }

    let data_dir = guanlan_core::storage::default_data_dir(&root)?;
    let root_normalized = guanlan_core::domain::mounts::normalize_mount_root(&root)?;
    let lock = runtime::acquire_workspace_lock(&data_dir)?;
    let writer = guanlan_core::index::Writer::open_at(&data_dir, &root)?;
    let notices = runtime::NoticeHub::new();
    let (bridge_tx, bridge_rx) = std::sync::mpsc::channel::<index_jobs::SseNotice>();
    let notice_bridge = {
        let hub = notices.clone();
        std::thread::Builder::new()
            .name("guanlan-notice-bridge".to_owned())
            .spawn(move || {
                for notice in bridge_rx {
                    hub.publish(notice);
                }
            })
            .expect("启动通知桥线程失败")
    };
    let jobs = index_jobs::IndexJobManager::start_with_options(
        writer,
        Some(bridge_tx),
        cfg.background_index,
    );
    let pool_size = http::query_exec::pool_size_from_env().max(1);
    let primary = match ReadonlyStore::open_for_root(&root) {
        Ok(store) => store,
        Err(e) => {
            jobs.shutdown();
            let _ = notice_bridge.join();
            return Err(e);
        }
    };
    let requested_key = guanlan_core::domain::resolve_root(&root)
        .map(|resolved| guanlan_core::domain::root_key_of_resolved(&resolved))?;
    if let Ok(claimed) = primary.workspace() {
        if claimed.root_key != requested_key {
            eprintln!(
                "警告: 库内工作区身份与请求 root 不一致：root_key={}（root_path={}）≠ 请求 root_key={}；GUANLAN_DATA_DIR 可能指向了其他工作区的数据目录",
                claimed.root_key, claimed.root_path, requested_key
            );
        }
    }
    let mut stores = vec![primary];
    for _ in 1..pool_size {
        match ReadonlyStore::open_for_root(&root) {
            Ok(store) => stores.push(store),
            Err(e) => {
                drop(stores);
                jobs.shutdown();
                let _ = notice_bridge.join();
                return Err(e);
            }
        }
    }

    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            drop(stores);
            jobs.shutdown();
            let _ = notice_bridge.join();
            return Err(GuanlanError::Internal(format!("监听 {addr} 失败: {e}")));
        }
    };
    let local = listener.local_addr().expect("listener local_addr");
    let root_path = PathBuf::from(&root);
    let instance_id = runtime::generate_instance_id(&root_path, local.port());

    let watcher_handle = if cfg.background_index {
        let watcher_store = match ReadonlyStore::open_for_root(&root) {
            Ok(s) => s,
            Err(e) => {
                drop(stores);
                jobs.shutdown();
                let _ = notice_bridge.join();
                return Err(e);
            }
        };
        let watcher_exec = Arc::new(http::query_exec::QueryExecutor::new(vec![watcher_store]));
        Some(watcher::start(
            root.clone(),
            jobs.clone(),
            watcher::WatchBaseline::new(watcher_exec),
        ))
    } else {
        None
    };
    let primary_exec = Arc::new(http::query_exec::QueryExecutor::new(stores));
    let primary_mounts = mounts::MountRegistry::load(&data_dir, &root_normalized);
    let primary_runtime = projects::ProjectRuntime::from_existing(
        requested_key.clone(),
        root_normalized.clone(),
        data_dir.clone(),
        Arc::clone(&primary_exec),
        jobs.clone(),
        watcher_handle.clone(),
        Arc::clone(&primary_mounts),
        lock,
        Some(notice_bridge),
    );
    let project_hub = projects::ProjectHub::start_with_primary(
        primary_runtime,
        root.clone(),
        cfg.background_index,
        notices.clone(),
        projects_file,
    )
    .await;

    let state = http::AppState {
        exec: primary_exec,
        budget: Arc::new(http::ResponseBudget::from_env()),
        instance_id: instance_id.clone(),
        dist: runtime::resolve_dist_dir(),
        jobs: jobs.clone(),
        watcher: watcher_handle.clone(),
        notices: Some(notices.clone()),
        mounts: primary_mounts,
        projects: Some(Arc::clone(&project_hub)),
    };
    let app = if cfg.cors_desktop {
        http::build_router_with_desktop_cors(state)
    } else {
        http::build_router(state)
    };

    if cfg.background_index {
        let workspace_id = {
            let probe = guanlan_core::index::Writer::open_at(&data_dir, &root)?;
            probe.workspace()?.workspace_id
        };
        let mut recovery_writer = guanlan_core::index::Writer::open_at(&data_dir, &root)?;
        let recovered = jobs.recover_from_job_runs(&mut recovery_writer, &workspace_id);
        drop(recovery_writer);
        let (startup_job_id, merged, _) = jobs.submit_kind(index_jobs::JobKind::VerifyAll);
        eprintln!(
            "guanlan 后台对账已入队 job_id={startup_job_id}（merged={merged}）root={root}；重启恢复重入队 {recovered} 个遗留任务；watcher 已启用"
        );
    } else {
        eprintln!(
            "guanlan 只读模式（background_index=false）：不扫描、不监听，仅提供既有数据的读取与写回端点；root={root}"
        );
    }

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let graceful = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = graceful.await {
            eprintln!("服务退出: {e}");
        }
    });

    Ok(RunningService {
        endpoint: format!("http://{local}"),
        local_addr: local,
        instance_id,
        data_dir,
        server: Some(server),
        shutdown_tx: Some(shutdown_tx),
        notices,
        projects: project_hub,
    })
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    struct TempDirGuard(PathBuf);
    impl TempDirGuard {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "guanlan-svc-lifecycle-{}-{tag}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }
    }
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn shutdown_releases_lock_and_allows_clean_rebind_across_workspaces() {
        let base = TempDirGuard::new("rebind");
        let data_base = base.0.join("data");
        std::fs::create_dir_all(&data_base).expect("data");
        let ws_a = base.0.join("ws-a");
        let ws_b = base.0.join("ws-b");
        let ws_c = base.0.join("ws-c");
        for (ws, name) in [(&ws_a, "A"), (&ws_b, "B"), (&ws_c, "C")] {
            std::fs::create_dir_all(ws).expect("建工作区");
            std::fs::write(ws.join("README.md"), format!("# Workspace {name}\n")).expect("写文档");
        }

        let svc_a = start_readonly_service(ServeConfig {
            root: ws_a.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: true,
            background_index: true,
        })
        .await
        .expect("首启 A");

        let dup = start_readonly_service(ServeConfig {
            root: ws_a.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: true,
            background_index: false,
        })
        .await;
        assert!(
            matches!(dup, Err(GuanlanError::RootInUse)),
            "占用期间同工作区必须返回 RootInUse：{:?}",
            dup.err()
        );
        assert!(
            runtime::read_lock_diagnostics(&svc_a.data_dir)
                .unwrap_or_default()
                .contains("pid="),
            "锁文件应包含 pid 诊断"
        );

        let a_data_dir = svc_a.data_dir.clone();
        svc_a.shutdown().await;

        let svc_b = start_readonly_service(ServeConfig {
            root: ws_b.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: true,
            background_index: true,
        })
        .await
        .expect("切换 B");
        let b_data_dir = svc_b.data_dir.clone();
        svc_b.shutdown().await;

        let svc_c = start_readonly_service(ServeConfig {
            root: ws_c.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: true,
            background_index: true,
        })
        .await
        .expect("切换 C");
        let c_data_dir = svc_c.data_dir.clone();
        svc_c.shutdown().await;

        let svc_a2 = start_readonly_service(ServeConfig {
            root: ws_a.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: true,
            background_index: true,
        })
        .await
        .expect("切回 A 必须立刻成功且无 ROOT_IN_USE");
        svc_a2.shutdown().await;

        for dir in [a_data_dir, b_data_dir, c_data_dir] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
