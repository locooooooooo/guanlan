//! guanlan-service 库入口：把 `guanlan serve` 的启动流程暴露成可编程接口，
//! 供 CLI 与桌面壳（guanlan-desktop，Tauri 进程内嵌）共用同一份服务实现——
//! 桌面壳不复制数据库与索引代码，只启动或连接同一服务，不另建实现。
//!
//! 读取路径与 CLI 完全一致：数据目录解析 → 同工作区 OS 级排他锁 → 只读打开
//! index.db 并认领工作区行 → 绑定 127.0.0.1 → axum 路由。任何一步失败返回
//! [`GuanlanError`]（CLI 端转统一错误包络退出；桌面壳弹启动失败提示）。

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
                // JoinError 罕见（任务 panic）；照 CLI 口径输出一行诊断
                eprintln!("服务任务结束: {e}");
            }
        }
    }

    /// 优雅停机并释放全部项目的工作区锁、监听套接字、写线程、watcher 与 SSE 连接（切换/退出零泄漏）。
    pub async fn shutdown(mut self) {
        // 先行通知所有项目写线程协作中止（大工作区全量扫描可在毫秒级退出，不拖住停机）
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

    // 1) 数据目录解析（契约 contract-storage.md §3.1：GUANLAN_DATA_DIR 整体替换 base）
    let data_dir = guanlan_core::storage::default_data_dir(&root)?;
    // 主区根 plain() 规范化（挂载互斥基准；主区 root_key 身份口径不受影响）
    let root_normalized = guanlan_core::domain::mounts::normalize_mount_root(&root)?;
    // 2) 同工作区 OS 级排他锁
    let lock = runtime::acquire_workspace_lock(&data_dir)?;
    // 3) 写侧就位：打开（或创建）可写库，确保 schema 与工作区行存在，
    //    写连接随后移交专用写线程（「唯一写入线程」，contract-storage.md §4.2）；
    //    首次运行时由写入侧建库，桌面壳因此可以在没有历史库时直接启动。
    let writer = guanlan_core::index::Writer::open_at(&data_dir, &root)?;
    // SSE 通知中枢（contract-query-api.md §2.2）：写线程处理函数经桥（同步 mpsc）投递，
    // 桥泵线程转发给 NoticeHub（broadcast::send 为同步调用，无需 async）
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
    // 4) 只读打开并认领工作区行（契约 §2.2/§4-2：只按库内已有行认领，不新建）；
    //    连接池按 GUANLAN_QUERY_POOL_SIZE（默认 4）开 N 条独立只读连接，
    //    各自认领同一工作区行——轻量读取不再互等（有界执行见 http::query_exec）
    let pool_size = http::query_exec::pool_size_from_env().max(1);
    let primary = match ReadonlyStore::open_for_root(&root) {
        Ok(store) => store,
        Err(e) => {
            jobs.shutdown();
            let _ = notice_bridge.join();
            return Err(e);
        }
    };
    // 4.5) 认领身份核对（契约 §2.2 root_path 精确匹配语义）：不拒绝服务（只读认领
    //      语义不变），但 stderr 告警一行，避免只能从事后 bootstrap 比对里察觉
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

    // 5) 绑定监听后再生成实例身份（携带实际端口，随机端口口径下才有意义）
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

    // 6) 组装应用状态与路由（dist 存在才挂静态资源；桌面壳为 WebView 放行 CORS）
    // watcher 只在显式启用后台索引时启动（见 ServeConfig::background_index）：
    // 未启用时保持「打开已有数据零扫描」的既有契约，读路径不产生任何写入。
    let watcher_handle = if cfg.background_index {
        // watcher 基线执行器：独立一条只读连接（ReadonlyStore 不可 Clone，不与查询池互借）
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
        // 响应字节预算（GUANLAN_RESPONSE_BUDGET_MIB / _MAX_MIB 可调）
        budget: Arc::new(http::ResponseBudget::from_env()),
        instance_id: instance_id.clone(),
        dist: runtime::resolve_dist_dir(),
        jobs: jobs.clone(),
        watcher: watcher_handle.clone(),
        notices: Some(notices.clone()),
        // 只读参考工作区挂载注册表（侧车 mounts.json 装载 + 离线降级；
        // 挂载互斥以规范化后的主区根为基准，严禁外挂目录与主区互为父子）
        mounts: primary_mounts,
        projects: Some(Arc::clone(&project_hub)),
    };
    let app = if cfg.cors_desktop {
        http::build_router_with_desktop_cors(state)
    } else {
        http::build_router(state)
    };

    // 7) 启动后台对账（「打开已有工作区先显示已保存的数据，后台对账
    //    不阻塞正文读取与事件查询」）：读路径立即可用，写线程随后把最新文档并进来。
    //    重启孤儿闭合：先重入队上轮遗留的 queued/running 任务（job_runs
    //    持久化），再排整库核验——其收尾 recompute 对全部 suspended/running 节点
    //    幂等重判，『决策已清零但唤醒未执行』与『作业挂起中重启』两类孤儿都被闭合。
    if cfg.background_index {
        let workspace_id = {
            // 写线程忙于重入队任务前先取工作区 id（读侧同源）
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

    // axum 服务任务：支持优雅停机信号（切换工作区时立即断开 SSE、停机并释放端口与锁）
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
        // 注意：default_data_dir 读取 GUANLAN_DATA_DIR 整体替换时多个 root 会撞同一目录；
        // 测试不同 rootKey 需各自独立，或直接不设 GUANLAN_DATA_DIR，而是在独立目录下各自测。
        // 这里用三份独立 root，使用默认 data_dir 太慢/污染 LOCALAPPDATA？不会，我们只清理对应目录。
        let ws_a = base.0.join("ws-a");
        let ws_b = base.0.join("ws-b");
        let ws_c = base.0.join("ws-c");
        for (ws, name) in [(&ws_a, "A"), (&ws_b, "B"), (&ws_c, "C")] {
            std::fs::create_dir_all(ws).expect("建工作区");
            std::fs::write(ws.join("README.md"), format!("# Workspace {name}\n")).expect("写文档");
        }

        // 启动 A → 验证同目录第二实例报 RootInUse → shutdown A → 再启动 A 成功
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

        // A → B → C → A 连续切换，验证锁与端口零泄漏
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
