//! REST 路由与统一错误包络（REST、SSE 与静态资源）。
//!
//! 路由清单见 `contract-query-api.md` §1（核心只读端点）与 §2（写入、长任务与检索端点）。
//! 处理器解析请求参数（query string / path）→ 调 `core::query` /
//! `core::application` → `Json(响应 DTO)`；错误经 [`ApiError`] 统一转包络
//! （契约 §0.2 六个错误码加本地扩展码，index_generation 按当前代际补齐）。`guanlan-core`
//! 不依赖 HTTP 框架，故 IntoResponse 在本模块用本地新类型 [`ApiError`]
//! 实现，而非直接为 `GuanlanError` 实现（避免违反孤儿规则）。
//!
//! 查询执行形态（有界查询通道）：rusqlite 连接是 `Send + !Sync`，
//! 不再全局共享一把互斥锁——[`query_exec::QueryExecutor`] 维护独立只读连接池，
//! 许可数 = 连接数，排队长度/排队 deadline 双上限，饱和确定性返回 INDEX_BUSY；
//! 查询在 `tokio::task::spawn_blocking` 的阻塞线程池执行；请求断开/执行超时
//! 经 progress handler + interrupt 打断；错误包络 generation 取执行器缓存
//! （异步线程不抢数据库锁）。详见 [`query_exec`] 模块注释。
//!
//! 静态资源：`dist` 目录存在才挂载（`GUANLAN_DIST_DIR` → 可执行文件同级 `dist/`，
//! 见 runtime::resolve_dist_dir）；未挂载或未知 `/api/*` 路径一律走统一错误包络
//! 的 404。SSE（/api/v1/stream）与索引任务端点（/api/v1/index-jobs、/api/v1/jobs/{job_id}）
//! 均已就位（契约 §2.1、§2.2）；仅 /api/v1/graph 预留为 501 桩（契约 §2.3）。

mod projects_api;
pub mod query_exec;
pub mod range;
pub mod response_budget;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio_util::io::ReaderStream;
use tower::ServiceExt;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use guanlan_core::application;
use guanlan_core::application::BootstrapQuery;
use guanlan_core::dto::{
    BatchFileMutationResponse, BootstrapResponse, CheckpointAccepted, CheckpointsPage,
    ContextResponse, CreateDocumentResponse, CrossSearchResponse, DecisionsResponse,
    DraftContentResponse, DraftsPage, EventDaysResult, EventPage, EventTimeRangeResponse,
    FileDetailResponse, FileMutationResponse, FileRevisionsResponse, FileSummaryPage,
    FileSummaryResponse, FolderListResponse, FolderMutationResponse, IndexJobAccepted,
    IndexJobRequest, IndexJobStatusResponse, JobAccepted, MountAccepted, MountListResponse,
    MountedFilesResponse, ProposalAccepted, RelationsResponse, ResolveAccepted,
    ResumeContextResponse, ReviewBoardResponse, StateOverviewResponse, StatementsResponse,
    StatusResponse, StorageStatsResponse, TasksResponse, UpdateStoragePolicyResponse,
};
use guanlan_core::error::GuanlanError;
use guanlan_core::index::collector;
use guanlan_core::index::file_format::{FileFormat, FormatClass};
use guanlan_core::index::file_ops::{
    BatchMoveFilesInput, BatchTrashFilesInput, CreateDocumentInput, CreateFolderInput,
    MoveFileInput, MoveFolderInput, RenameFileInput, RenameFolderInput, TrashFileInput,
    TrashFolderInput,
};
use guanlan_core::query;

use crate::index_jobs::{BatchFileOpCommand, FileOpCommand, FolderOpCommand, JobKind};

pub use query_exec::QueryExecutor;
pub use response_budget::ResponseBudget;

/// 应用状态：有界查询执行器（连接池）+ 实例身份 + dist 目录（None=不挂静态资源）
#[derive(Clone)]
pub struct AppState {
    /// 有界查询执行通道（独立只读连接池 + 准入/取消/generation 缓存）
    pub exec: Arc<QueryExecutor>,
    /// 响应字节预算（内联正文的读取/转换/序列化/发送全生命周期）
    pub budget: Arc<ResponseBudget>,
    /// 服务实例身份（main 里经 runtime::generate_instance_id 生成，
    /// 与启动打印/GUANLAN_ENDPOINT 行一致；契约 §1.2）
    pub(crate) instance_id: String,
    /// dist 目录；存在才由 build_router 挂载静态资源
    pub(crate) dist: Option<PathBuf>,
    /// 索引任务管理器（唯一写入线程）
    pub(crate) jobs: crate::index_jobs::IndexJobManager,
    /// 文件监听句柄（测试/只读装配可为 None）
    pub(crate) watcher: Option<crate::watcher::WatcherHandle>,
    /// SSE 通知中枢（测试/只读装配可为 None）
    pub(crate) notices: Option<crate::runtime::NoticeHub>,
    /// 只读参考工作区挂载注册表（idle 装配 = 无挂载；测试/只读场景）
    pub(crate) mounts: Arc<crate::mounts::MountRegistry>,
    /// 多项目并存中枢（Some = 启用多项目零重启动态切换；None = 传统单项目测试装配）
    pub(crate) projects: Option<Arc<crate::projects::ProjectHub>>,
}

impl AppState {
    pub(crate) fn active_exec(&self) -> Arc<QueryExecutor> {
        if let Some(hub) = &self.projects {
            if let Some(rt) = hub.active_runtime() {
                return Arc::clone(&rt.exec);
            }
        }
        Arc::clone(&self.exec)
    }

    pub(crate) fn active_jobs(&self) -> crate::index_jobs::IndexJobManager {
        if let Some(hub) = &self.projects {
            if let Some(rt) = hub.active_runtime() {
                return rt.jobs.clone();
            }
        }
        self.jobs.clone()
    }

    pub(crate) fn active_watcher(&self) -> Option<crate::watcher::WatcherHandle> {
        if let Some(hub) = &self.projects {
            if let Some(rt) = hub.active_runtime() {
                return rt.watcher.clone();
            }
        }
        self.watcher.clone()
    }

    pub(crate) fn active_mounts(&self) -> Arc<crate::mounts::MountRegistry> {
        if let Some(hub) = &self.projects {
            if let Some(rt) = hub.active_runtime() {
                return Arc::clone(&rt.mounts);
            }
        }
        Arc::clone(&self.mounts)
    }

    pub(crate) fn require_active_writable(&self) -> Result<(), ApiError> {
        if let Some(hub) = &self.projects {
            if hub.is_active_readonly() {
                return Err(ApiError::with_generation(
                    GuanlanError::CrossWorkspaceForbidden(
                        "当前项目已开启只读归档保护，禁止写入/重命名/移动/回收站操作（可在项目菜单关闭只读保护）"
                            .to_owned(),
                    ),
                    self,
                ));
            }
        }
        Ok(())
    }
}

/// 业务错误 → HTTP 响应的本地包裹（统一错误包络，契约 §0.2）。
pub struct ApiError {
    err: GuanlanError,
    index_generation: Option<u64>,
}

impl From<GuanlanError> for ApiError {
    fn from(e: GuanlanError) -> Self {
        Self {
            err: e,
            index_generation: None,
        }
    }
}

impl ApiError {
    /// 错误发生时按执行器缓存的当前代际补齐包络 index_generation
    /// （缓存由阻塞任务内轻量刷新，异步线程不再同步抢数据库锁）
    fn with_generation(err: GuanlanError, state: &AppState) -> Self {
        Self {
            err,
            index_generation: state.active_exec().cached_generation(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.err.http_status())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut response =
            (status, Json(self.err.to_envelope(self.index_generation))).into_response();
        // 契约 §0.2：INDEX_BUSY 503 附 Retry-After，可重试
        if matches!(self.err, GuanlanError::IndexBusy) {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
        }
        response
    }
}

/// 有界查询统一执行：经执行器准入（许可 + 排队上限 + deadline），
/// 在阻塞线程池的独立只读连接上跑 core 查询；错误统一补缓存代际后转 [`ApiError`]。
async fn run_query<T, F>(state: &AppState, f: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&guanlan_core::storage::ReadonlyStore) -> Result<T, GuanlanError> + Send + 'static,
{
    let exec = state.active_exec();
    exec.run(f).await.map_err(|err| ApiError {
        err,
        index_generation: exec.cached_generation(),
    })
}

/// 组装 /api/v1 路由（业务、长任务与检索端点齐备，仅 graph 维持 501 桩；
/// dist 存在才挂静态资源）。
pub fn build_router(state: AppState) -> Router {
    let api: Router<AppState> = Router::new()
        // ===== 核心只读与文件/目录操作端点（契约 §1、§2.2.1）=====
        .route("/api/v1/bootstrap", get(bootstrap))
        .route("/api/v1/status", get(status))
        .route("/api/v1/files", get(files))
        .route("/api/v1/events", get(events))
        .route("/api/v1/events/days", get(event_days))
        .route("/api/v1/events/range", get(event_range))
        .route("/api/v1/files/{file_id}/revisions", get(file_revisions))
        .route("/api/v1/files/{file_id}/detail", get(file_detail))
        .route("/api/v1/files/{file_id}/rename", post(file_rename))
        .route("/api/v1/files/{file_id}/move", post(file_move))
        .route("/api/v1/files/{file_id}/trash", post(file_trash))
        .route("/api/v1/files/create", post(file_create))
        .route("/api/v1/files/batch-move", post(files_batch_move))
        .route("/api/v1/files/batch-trash", post(files_batch_trash))
        .route("/api/v1/folders", get(folders_list).post(folder_create))
        .route("/api/v1/folders/rename", post(folder_rename))
        .route("/api/v1/folders/move", post(folder_move))
        .route("/api/v1/folders/trash", post(folder_trash))
        .route(
            "/api/v1/revisions/{revision_id}/content",
            get(revision_content),
        )
        // ===== QuickLook 轻预览与流式图片缩略端点 =====
        .route(
            "/api/v1/revisions/{revision_id}/preview",
            get(revision_preview),
        )
        .route(
            "/api/v1/revisions/{revision_id}/thumbnail",
            get(revision_thumbnail),
        )
        .route(
            "/api/v1/revisions/{revision_id}/office",
            get(revision_office),
        )
        .route("/api/v1/revisions/{revision_id}/pdf", get(revision_pdf))
        .route("/api/v1/decisions", get(decisions))
        .route("/api/v1/relations", get(relations))
        // ===== 服务端已读基线查询 + 批量确立/撤销 =====
        .route("/api/v1/reading-state", get(reading_state_list))
        .route("/api/v1/reading-state/batch", post(reading_state_batch))
        // ===== 本地快照存储统计、策略、全量 SHA-256 完整性、铁律 GC、全量开放导出与脱敏诊断 ZIP =====
        .route("/api/v1/storage/stats", get(storage_stats))
        .route("/api/v1/storage/policy", post(storage_policy_update))
        .route("/api/v1/storage/integrity", get(storage_integrity))
        .route("/api/v1/storage/backups", get(storage_backups))
        .route("/api/v1/storage/gc", post(storage_gc))
        .route(
            "/api/v1/storage/diagnostic-zip",
            get(storage_diagnostic_zip_download).post(storage_diagnostic_zip_export),
        )
        .route("/api/v1/export/workspace", post(export_workspace_open))
        // ===== 长任务引擎与上下文基座端点（契约 §2.2）=====
        .route("/api/v1/stream", get(stream)) // SSE：hello + workspace-change + 心跳
        .route("/api/v1/state-overview", get(state_overview)) // 统一状态机投影
        .route("/api/v1/statements", get(statements_list)) // 拍板表单数据源
        .route(
            "/api/v1/decisions/{statement_id}/resolve",
            post(decision_resolve),
        ) // 拍板回写（恒 202）
        .route(
            "/api/v1/revision-proposals",
            get(revision_proposals_list).post(revision_proposals_create),
        ) // Agent 草案
        .route(
            "/api/v1/revision-proposals/{draft_id}/content",
            get(revision_proposals_content),
        ) // 草案多模态 Diff 审阅载荷（只读）
        .route(
            "/api/v1/revision-proposals/{draft_id}/adopt",
            post(revision_proposals_adopt),
        )
        .route(
            "/api/v1/revision-proposals/{draft_id}/dismiss",
            post(revision_proposals_dismiss),
        )
        .route(
            "/api/v1/checkpoints",
            get(checkpoints_list).post(checkpoint_commit),
        ) // 检查点同步受理（201）
        .route(
            "/api/v1/initiatives/{initiative_id}/tasks",
            get(initiative_tasks),
        ) // 五槽位 DAG
        .route(
            "/api/v1/initiatives/{initiative_id}/resume-context",
            get(resume_context),
        ) // 恢复上下文（增量 + 最新决策）
        .route(
            "/api/v1/initiatives/{initiative_id}/archive",
            post(initiative_archive),
        ) // 专项归档
        .route(
            "/api/v1/initiatives/{initiative_id}/reopen",
            post(initiative_reopen),
        ) // 专项重开
        // ===== 候选事项（多信号编织；采纳前绝不写正式归属） =====
        .route(
            "/api/v1/initiative-candidates",
            get(initiative_candidates_list),
        )
        .route(
            "/api/v1/initiative-candidates/{candidate_id}/adopt",
            post(initiative_candidate_adopt),
        )
        .route(
            "/api/v1/initiative-candidates/{candidate_id}/dismiss",
            post(initiative_candidate_dismiss),
        )
        .route(
            "/api/v1/initiative-candidates/{candidate_id}/members/{file_id}/exclude",
            post(initiative_candidate_exclude),
        )
        .route("/api/v1/diff", post(diff)) // 异步入任务队列
        .route("/api/v1/context", post(context)) // Token 预算感知上下文包
        .route("/api/v1/mcp/host-config", post(mcp_host_config)) // 主流宿主 .mcp.json 安全生成/写入
        .route("/api/v1/review-board", get(review_board)) // 五态批阅看板 + 失联 unknown 诊断
        .route(
            "/api/v1/review-board/{initiative_id}/repair-orphan",
            post(review_board_repair_orphan),
        ) // 孤儿/失联节点人工修复入口（严禁跳过审阅直接完结）
        .route("/api/v1/audit/ledger", get(audit_ledger)) // 关键决定账本哈希链与权限沙箱完整性只读审计
        // ===== 事项资料胶囊（Context Capsule）两阶段预览/脱敏导出/秒开核验 =====
        .route("/api/v1/capsules/preview", post(capsule_preview))
        .route("/api/v1/capsules/export", post(capsule_export))
        .route("/api/v1/capsules/inspect", post(capsule_inspect))
        .route("/api/v1/capsules/file", post(capsule_file))
        .route("/api/v1/summary/{file_id}", get(file_summary)) // L4A 摘要
        .route("/api/v1/index-jobs", post(index_jobs)) // 202 + job_id
        .route("/api/v1/jobs/{job_id}", get(job_status)) // 任务状态
        .route("/api/v1/jobs/{job_id}/cancel", post(job_cancel)) // 协作式取消
        .route("/api/v1/jobs/{job_id}/result", get(job_result)) // 有界结果
        // ===== 检索、跨项目只读挂载与预留关系端点（契约 §2.3–§2.5）=====
        .route("/api/v1/search", get(search)) // 有界检索（混合倒排索引）
        .route("/api/v1/search/rebuild", post(search_rebuild)) // 一键重建派生检索索引
        // ===== 跨项目只读挂载与联合检索（契约 §2.5）=====
        .route("/api/v1/mounts", get(mounts_list).post(mounts_mount))
        .route(
            "/api/v1/mounts/{mount_id}",
            axum::routing::delete(mounts_unmount),
        )
        .route("/api/v1/mounts/{mount_id}/files", get(mounts_files))
        .route("/api/v1/search/cross", get(search_cross))
        .route("/api/v1/graph", get(graph)) // 预留 501 桩：局部关系 center_id + depth
        .merge(projects_api::projects_routes());

    // dist 判定先独立克隆，避免 match 借用阻塞后面对 state 的 move
    let dist = state.dist.clone();
    let router: Router<AppState> = match dist.as_deref() {
        // dist 存在：非 /api 路径交给 ServeDir（文件缺失回退 index.html，SPA 口径）；
        // 未知 /api 路径仍走统一错误包络 404，不落静态回退
        Some(dist_dir) if dist_dir.is_dir() => {
            let serve = ServeDir::new(dist_dir)
                .append_index_html_on_directories(true)
                .fallback(ServeFile::new(dist_dir.join("index.html")));
            let state_for_fallback = state.clone();
            api.fallback_service(tower::service_fn(move |req: Request| {
                let serve = serve.clone();
                let state = state_for_fallback.clone();
                async move {
                    if req.uri().path().starts_with("/api/") || req.uri().path() == "/api" {
                        return Ok(ApiError::with_generation(
                            GuanlanError::NotFound("未知路由".to_owned()),
                            &state,
                        )
                        .into_response());
                    }
                    // ServeDir 的 Error = Infallible：不存在 Err 分支；
                    // 响应体统一转为 axum::body::Body（统一返回类型）
                    serve
                        .oneshot(req)
                        .await
                        .map(|resp| resp.map(Body::new))
                        .map_err(|e| match e {})
                }
            }))
        }
        // 无 dist（开发期）：未知路径返回统一错误包络 404
        _ => api.fallback(fallback_not_found),
    };
    router.with_state(state)
}

async fn fallback_not_found(State(state): State<AppState>) -> ApiError {
    ApiError::with_generation(GuanlanError::NotFound("未知路由".to_owned()), &state)
}

/// 桌面壳模式路由：在 [`build_router`] 之上放行跨源读取——WebView 页面源是
/// `http(s)://tauri.localhost`（Tauri v2 Windows 缺省），API 在 `127.0.0.1` 环回端口，
/// 属跨源；开发期 Vite (localhost:*) 代理也一并放行便于调试。
/// 只读语义对应的方法集；不带凭据（凭据不放进命令行或 URL）。
pub fn build_router_with_desktop_cors(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            // 头值非可见 ASCII 时直接拒绝
            let Ok(o) = origin.to_str() else { return false };
            // Tauri v2 Windows WebView 源 + 本机开发端口（Vite 调试）
            o == "http://tauri.localhost"
                || o == "https://tauri.localhost"
                || o.starts_with("http://localhost:")
                || o.starts_with("http://127.0.0.1:")
        }))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::HEAD,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::CONTENT_TYPE,
            header::RANGE,
            header::IF_NONE_MATCH,
            header::IF_RANGE,
        ])
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
            header::ETAG,
        ]);
    build_router(state).layer(cors)
}

// ===== 参数解析（workspace-plugin.ts:277-311 的 v1 等价口径）=====

/// 取查询参数（空串按未传，对齐 Node `url.searchParams.get(x) || undefined`）
fn param<'m>(params: &'m HashMap<String, String>, key: &str) -> Option<&'m str> {
    params
        .get(key)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
}

/// kinds 逗号分隔，去首尾空白、滤空段（workspace-plugin.ts:278-281 逐字口径；
/// 契约 §5 风险 5：旧别名 kind 不迁，v1 只收 kinds）
fn parse_kinds(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// format 接受任意合法小写扩展名 token（如 `md`/`svg`/`pdf`/`ts`/`png`/`docx`）或 `class:<族名>`，
/// 长度 ≤ 32，只允许 `[a-z0-9_+-]` 与 `:`；空串或非法字符按未传。
fn parse_format(raw: Option<&str>) -> Option<String> {
    raw.map(|s| s.trim().to_ascii_lowercase()).filter(|s| {
        !s.is_empty()
            && s.len() <= 32
            && s.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'_' | b'-' | b'+' | b':')
            })
    })
}

/// order：仅 `observed` 改口径，其余一律 occurred（workspace-plugin.ts:284）
fn parse_order(raw: Option<&str>) -> query::EventOrder {
    if raw == Some("observed") {
        query::EventOrder::Observed
    } else {
        query::EventOrder::Occurred
    }
}

/// granularity：week|month，其余（含非法值）一律 day
fn parse_granularity(raw: Option<&str>) -> query::EventGranularity {
    match raw {
        Some("week") => query::EventGranularity::Week,
        Some("month") => query::EventGranularity::Month,
        _ => query::EventGranularity::Day,
    }
}

/// 版本链排序：仅 `seq_asc` 升序，其余（含非法值）默认 seq_desc（契约 §1.7）
fn parse_revision_order(raw: Option<&str>) -> query::RevisionOrder {
    if raw == Some("seq_asc") {
        query::RevisionOrder::SeqAsc
    } else {
        query::RevisionOrder::SeqDesc
    }
}

/// limit 类数值参数：整数解析失败按未传（core 侧默认值 + clamp 兜底）
fn parse_limit(params: &HashMap<String, String>, key: &str) -> Option<u32> {
    param(params, key)
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.max(0) as u32)
}

/// undated 布尔开关：仅 `1` 为真（workspace-plugin.ts:306 口径）
fn parse_undated(raw: Option<&str>) -> bool {
    raw == Some("1")
}

/// include 段解析（契约 §1.7：events,statements,edges,aliases 逗号分隔，未知段忽略）
fn parse_include(raw: Option<&str>) -> Vec<query::RevisionIncludeSection> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter_map(|s| match s {
            "events" => Some(query::RevisionIncludeSection::Events),
            "statements" => Some(query::RevisionIncludeSection::Statements),
            "edges" => Some(query::RevisionIncludeSection::Edges),
            "aliases" => Some(query::RevisionIncludeSection::Aliases),
            _ => None,
        })
        .collect()
}

// ===== 核心只读与存储管理端点处理器（契约 §1、§2.2.2）=====

async fn bootstrap(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<BootstrapResponse>, ApiError> {
    // 请求参数（契约 §1.1 参数表）：days_limit/days_samples/days_granularity/
    // files_page_size/events_limit，未传走 core 默认值（默认即 clamp 前的契约默认）
    let mut q = BootstrapQuery::default();
    if let Some(v) = parse_limit(&params, "days_limit") {
        q.days_limit = v;
    }
    if let Some(v) = parse_limit(&params, "days_samples") {
        q.days_samples = v;
    }
    q.days_granularity = parse_granularity(param(&params, "days_granularity"));
    if let Some(v) = parse_limit(&params, "files_page_size") {
        q.files_page_size = v;
    }
    if let Some(v) = parse_limit(&params, "events_limit") {
        q.events_limit = v;
    }
    // 一个短读事务内合成（契约 §1.1，core application::bootstrap）
    let mut resp = run_query(&state, move |store| application::bootstrap(store, &q)).await?;
    // 后台对账进行中时如实标出（前端据此显示「对账中」而不是假装数据已最新）
    if state.active_jobs().has_active() {
        resp.config.runtime_status.service_state = "reconciling".to_owned();
    }
    Ok(Json(resp))
}

async fn status(State(state): State<AppState>) -> Result<Json<StatusResponse>, ApiError> {
    let mut resp = run_query(&state, application::status).await?;
    // 实例身份统一为服务级身份：application::status 的内部生成器与
    // runtime::generate_instance_id 各自独立，wire 输出必须与启动打印的
    // instance_id 一致（契约 §1.2：SSE 三元组载体，单实例稳定）
    resp.instance_id = state.instance_id.clone();
    // 进行中的索引任务随状态一起给出（前端据此知道后台对账是否还在跑）
    let active = state.active_jobs().active_jobs();
    resp.active_jobs = active
        .iter()
        .filter_map(|job| serde_json::to_value(job.to_response()).ok())
        .collect();
    // 补齐 watcher 状态段 + L4A 进度 + schema_version=2（core 侧已填 2）
    let l4a = run_query(&state, query::l4a_progress).await?;
    resp.l4a_progress = guanlan_core::dto::L4aProgress {
        done: l4a.done,
        total: l4a.total,
        percent: l4a.percent,
        queue_depth: l4a.queue_depth,
    };
    match state.active_watcher().as_ref() {
        Some(handle) => {
            resp.watcher = guanlan_core::dto::WatcherStatus {
                enabled: handle.enabled,
                last_poll_at: handle.last_poll_at(),
                changed_paths_pending: handle.changed_paths_pending() as u32,
                l4a_queue_depth: l4a.queue_depth,
            };
        }
        None => {
            resp.watcher = guanlan_core::dto::WatcherStatus {
                enabled: false,
                last_poll_at: None,
                changed_paths_pending: 0,
                l4a_queue_depth: l4a.queue_depth,
            };
        }
    }
    Ok(Json(resp))
}

/// GET /api/v1/storage/stats —— 本地快照占用体积、三档配额与全格式分布明细
async fn storage_stats(
    State(state): State<AppState>,
) -> Result<Json<StorageStatsResponse>, ApiError> {
    let resp = run_query(&state, application::storage_stats).await?;
    Ok(Json(resp))
}

#[derive(Debug, serde::Deserialize)]
struct UpdateStoragePolicyBody {
    text_max_mib: u64,
    binary_max_mib: u64,
}

/// POST /api/v1/storage/policy —— 更新当前工作区三档快照上限（写 `meta` 表）
async fn storage_policy_update(
    State(state): State<AppState>,
    body: Result<Json<UpdateStoragePolicyBody>, JsonRejection>,
) -> Result<Json<UpdateStoragePolicyResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let reply_rx = state
        .active_jobs()
        .update_storage_policy(req.text_max_mib, req.binary_max_mib)
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("存储策略更新任务失败: {e}")),
            &state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, &state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, &state)),
    }
}

/// GET /api/v1/storage/integrity —— 校验全部活跃快照 SHA-256 完整性并 100% 诚实报告受损影响范围
async fn storage_integrity(
    State(state): State<AppState>,
) -> Result<Json<guanlan_core::storage::maintenance::BlobIntegrityReport>, ApiError> {
    let report = run_query(
        &state,
        guanlan_core::storage::maintenance::verify_blobs_integrity,
    )
    .await?;
    Ok(Json(report))
}

/// GET /api/v1/storage/backups —— 列出 SQLite Schema 升级前自动一致性备份（滚动保留最近 5 份）
async fn storage_backups(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let payload = run_query(&state, |store| {
        let items = guanlan_core::storage::migration::list_migration_backups(store.data_dir())?;
        Ok(serde_json::json!({
            "ok": true,
            "schema_version": store.schema_version()?,
            "supported_max_schema_version": guanlan_core::storage::migration::CURRENT_SCHEMA_VERSION,
            "max_retained": guanlan_core::storage::migration::MAX_MIGRATION_BACKUPS,
            "items": items,
        }))
    })
    .await?;
    Ok(Json(payload))
}

/// POST /api/v1/storage/gc —— 存储瘦身（dry_run 走只读预演；execute 经唯一写线程并铁律保护决定证据快照）
async fn storage_gc(
    State(state): State<AppState>,
    body: Result<Json<guanlan_core::storage::maintenance::StorageGcRequest>, JsonRejection>,
) -> Result<Json<guanlan_core::storage::maintenance::StorageGcResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    if req.dry_run {
        let resp = run_query(&state, move |store| {
            guanlan_core::storage::maintenance::plan_storage_gc(store, &req)
        })
        .await?;
        return Ok(Json(resp));
    }
    let reply_rx = state
        .active_jobs()
        .run_storage_gc(req)
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(30))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("存储瘦身任务失败: {e}")),
            &state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, &state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, &state)),
    }
}

/// POST /api/v1/export/workspace —— 工作区级全量开放导出（零锁定：历史快照 + JSONL/MD 账本）
async fn export_workspace_open(
    State(state): State<AppState>,
    body: Result<
        Json<guanlan_core::storage::maintenance::WorkspaceOpenExportRequest>,
        JsonRejection,
    >,
) -> Result<Json<guanlan_core::storage::maintenance::WorkspaceOpenExportResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let resp = run_query(&state, move |store| {
        guanlan_core::storage::maintenance::export_workspace_open_archive(store, &req)
    })
    .await?;
    Ok(Json(resp))
}

/// GET /api/v1/reading-state —— 读工作区服务端已读基线
async fn reading_state_list(
    State(state): State<AppState>,
) -> Result<Json<guanlan_core::dto::ReadingStateListResponse>, ApiError> {
    let resp = run_query(&state, query::reading_states).await?;
    Ok(Json(resp))
}

/// POST /api/v1/reading-state/batch —— 存量工作区/目录一键确立已读基线或撤销还原
async fn reading_state_batch(
    State(state): State<AppState>,
    body: Result<Json<guanlan_core::dto::ReadingStateBatchRequest>, JsonRejection>,
) -> Result<Json<guanlan_core::dto::ReadingStateBatchResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let reply_rx = state
        .active_jobs()
        .batch_reading_state(req)
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(30))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("批量更新已读基线失败: {e}")),
            &state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, &state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, &state)),
    }
}

#[derive(Debug, serde::Deserialize, Default)]
struct DiagnosticZipBody {
    #[serde(default)]
    output_path: Option<String>,
}

/// POST /api/v1/storage/diagnostic-zip —— 落盘生成脱敏运行诊断包 ZIP 并返回路径回执
async fn storage_diagnostic_zip_export(
    State(state): State<AppState>,
    body: Option<Json<DiagnosticZipBody>>,
) -> Result<Json<guanlan_core::storage::maintenance::DiagnosticZipResponse>, ApiError> {
    let out = body.and_then(|Json(b)| b.output_path);
    let resp = run_query(&state, move |store| {
        guanlan_core::storage::maintenance::export_diagnostic_zip(store, out.as_deref())
    })
    .await?;
    Ok(Json(resp))
}

/// GET /api/v1/storage/diagnostic-zip —— 直接流式下载脱敏运行诊断包 ZIP
async fn storage_diagnostic_zip_download(
    State(state): State<AppState>,
) -> Result<Response, ApiError> {
    let (zip_bytes, _receipt) = run_query(
        &state,
        guanlan_core::storage::maintenance::build_diagnostic_zip_bytes,
    )
    .await?;
    let mut resp = Response::new(Body::from(zip_bytes));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/zip"),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_static("attachment; filename=\"guanlan-diagnostic.zip\""),
    );
    Ok(resp)
}

async fn files(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<FileSummaryPage>, ApiError> {
    let q = query::FileListQuery {
        cursor: param(&params, "cursor").map(str::to_owned),
        limit: parse_limit(&params, "limit"),
        dir: param(&params, "dir").map(str::to_owned),
        format: parse_format(param(&params, "format")),
        matter: param(&params, "matter").map(str::to_owned),
        q: param(&params, "q").map(str::to_owned),
        status: param(&params, "status").map(str::to_owned),
    };
    let resp = run_query(&state, move |store| query::list_files(store, &q)).await?;
    Ok(Json(resp))
}

async fn events(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<EventPage>, ApiError> {
    let q = query::EventQuery {
        from: param(&params, "from").map(str::to_owned),
        to: param(&params, "to").map(str::to_owned),
        kinds: parse_kinds(param(&params, "kinds")),
        format: parse_format(param(&params, "format")),
        order: parse_order(param(&params, "order")),
        undated: parse_undated(param(&params, "undated")),
        q: param(&params, "q").map(str::to_owned),
        limit: parse_limit(&params, "limit"),
        cursor: param(&params, "cursor").map(str::to_owned),
    };
    let resp = run_query(&state, move |store| query::query_events(store, &q)).await?;
    Ok(Json(resp))
}

async fn event_days(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<EventDaysResult>, ApiError> {
    let q = query::EventDaysQuery {
        from: param(&params, "from").map(str::to_owned),
        to: param(&params, "to").map(str::to_owned),
        kinds: parse_kinds(param(&params, "kinds")),
        format: parse_format(param(&params, "format")),
        order: parse_order(param(&params, "order")),
        granularity: parse_granularity(param(&params, "granularity")),
        limit_days: parse_limit(&params, "limit_days"),
        samples: parse_limit(&params, "samples"),
    };
    let resp = run_query(&state, move |store| query::query_event_days(store, &q)).await?;
    Ok(Json(resp))
}

async fn event_range(
    State(state): State<AppState>,
) -> Result<Json<EventTimeRangeResponse>, ApiError> {
    let resp = run_query(&state, query::event_time_range).await?;
    Ok(Json(resp))
}

async fn file_revisions(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<FileRevisionsResponse>, ApiError> {
    let q = query::FileRevisionsQuery {
        cursor: param(&params, "cursor").map(str::to_owned),
        limit: parse_limit(&params, "limit"),
        order: parse_revision_order(param(&params, "order")),
        include: parse_include(param(&params, "include")),
    };
    let resp = run_query(&state, move |store| {
        query::file_revisions(store, &file_id, &q)
    })
    .await?;
    Ok(Json(resp))
}

/// 阅读器兼容视图（契约 §1.7 末段；文件级非分页）
async fn file_detail(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
) -> Result<Json<FileDetailResponse>, ApiError> {
    let resp = run_query(&state, move |store| query::file_detail(store, &file_id)).await?;
    Ok(Json(resp))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct RenameFileBody {
    pub(super) new_name: String,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct MoveFileBody {
    pub(super) target_dir: String,
    #[serde(default)]
    pub(super) new_name: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct TrashFileBody {
    #[serde(default)]
    pub(super) confirm: bool,
}

async fn run_file_op_sync(
    state: &AppState,
    op: FileOpCommand,
) -> Result<Json<FileMutationResponse>, ApiError> {
    state.require_active_writable()?;
    let reply_rx = state
        .active_jobs()
        .execute_file_op(op)
        .map_err(|err| ApiError::with_generation(err, state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("文件操作回执任务失败: {e}")),
            state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, state)),
    }
}

/// POST /api/v1/files/{file_id}/rename —— 同目录原子重命名（保持 file_id 与全部历史连续）
async fn file_rename(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    body: Result<Json<RenameFileBody>, JsonRejection>,
) -> Result<Json<FileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    // 跨挂载写拦截：参考工作区只读，跨挂载边界写操作确定性拒绝（契约 §2.5）
    cross_write_preflight(&state, &file_id).await?;
    run_file_op_sync(
        &state,
        FileOpCommand::Rename(RenameFileInput {
            file_id,
            new_name: req.new_name,
        }),
    )
    .await
}

/// POST /api/v1/files/{file_id}/move —— 工作区内安全跨目录移动（保持 file_id 与全部历史连续）
async fn file_move(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    body: Result<Json<MoveFileBody>, JsonRejection>,
) -> Result<Json<FileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    // 跨挂载写拦截：参考工作区只读，跨挂载边界移动确定性拒绝（契约 §2.5）
    cross_write_preflight(&state, &file_id).await?;
    run_file_op_sync(
        &state,
        FileOpCommand::Move(MoveFileInput {
            file_id,
            target_dir: req.target_dir,
            new_name: req.new_name,
        }),
    )
    .await
}

/// POST /api/v1/files/{file_id}/trash —— 移入系统回收站（强制 confirm=true，绝不永久物理删除）
async fn file_trash(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    body: Result<Json<TrashFileBody>, JsonRejection>,
) -> Result<Json<FileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    // 跨挂载写拦截：参考工作区只读，跨挂载边界删除确定性拒绝（契约 §2.5）
    cross_write_preflight(&state, &file_id).await?;
    run_file_op_sync(
        &state,
        FileOpCommand::Trash(TrashFileInput {
            file_id,
            confirm: req.confirm,
        }),
    )
    .await
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct CreateFolderBody {
    #[serde(default)]
    pub(super) parent_dir: String,
    pub(super) name: String,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct RenameFolderBody {
    pub(super) folder_path: String,
    pub(super) new_name: String,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct MoveFolderBody {
    pub(super) folder_path: String,
    #[serde(default)]
    pub(super) target_parent_dir: String,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct TrashFolderBody {
    pub(super) folder_path: String,
    #[serde(default)]
    pub(super) confirm: bool,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct CreateDocumentBody {
    #[serde(default)]
    pub(super) target_dir: String,
    pub(super) name: String,
    #[serde(default)]
    pub(super) initial_content: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct BatchMoveFilesBody {
    pub(super) file_ids: Vec<String>,
    #[serde(default)]
    pub(super) target_dir: String,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct BatchTrashFilesBody {
    pub(super) file_ids: Vec<String>,
    #[serde(default)]
    pub(super) confirm: bool,
}

async fn run_folder_op_sync(
    state: &AppState,
    op: FolderOpCommand,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    state.require_active_writable()?;
    let reply_rx = state
        .active_jobs()
        .execute_folder_op(op)
        .map_err(|err| ApiError::with_generation(err, state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("文件夹操作回执任务失败: {e}")),
            state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, state)),
    }
}

/// GET /api/v1/folders —— 枚举工作区全部真实目录（含空文件夹；与采集同口径排除黑名单与 .gitignore）
async fn folders_list(State(state): State<AppState>) -> Result<Json<FolderListResponse>, ApiError> {
    let resp = run_query(&state, move |store| {
        let ws = store.workspace()?;
        let (folders, truncated) = collector::collect_workspace_folders(
            std::path::Path::new(&ws.root_path),
            &[],
            collector::DEFAULT_MAX_FOLDERS,
            collector::DEFAULT_MAX_DEPTH,
        );
        Ok(FolderListResponse {
            ok: true,
            index_generation: ws.index_generation,
            folders,
            truncated,
        })
    })
    .await?;
    Ok(Json(resp))
}

/// POST /api/v1/folders —— 在工作区内新建真实文件夹
async fn folder_create(
    State(state): State<AppState>,
    body: Result<Json<CreateFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_folder_op_sync(
        &state,
        FolderOpCommand::Create(CreateFolderInput {
            parent_dir: req.parent_dir,
            name: req.name,
        }),
    )
    .await
}

/// POST /api/v1/folders/rename —— 重命名真实文件夹并保真更新子树所有 file_id 路径
async fn folder_rename(
    State(state): State<AppState>,
    body: Result<Json<RenameFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_folder_op_sync(
        &state,
        FolderOpCommand::Rename(RenameFolderInput {
            folder_path: req.folder_path,
            new_name: req.new_name,
        }),
    )
    .await
}

/// POST /api/v1/folders/move —— 移动真实文件夹（防成环）并保真更新子树所有 file_id 路径
async fn folder_move(
    State(state): State<AppState>,
    body: Result<Json<MoveFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_folder_op_sync(
        &state,
        FolderOpCommand::Move(MoveFolderInput {
            folder_path: req.folder_path,
            target_parent_dir: req.target_parent_dir,
        }),
    )
    .await
}

/// POST /api/v1/folders/trash —— 将真实文件夹移入系统回收站（强制 confirm=true）
async fn folder_trash(
    State(state): State<AppState>,
    body: Result<Json<TrashFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_folder_op_sync(
        &state,
        FolderOpCommand::Trash(TrashFolderInput {
            folder_path: req.folder_path,
            confirm: req.confirm,
        }),
    )
    .await
}

/// POST /api/v1/files/create —— 在指定目录新建 Markdown 文档并立即入库
async fn file_create(
    State(state): State<AppState>,
    body: Result<Json<CreateDocumentBody>, JsonRejection>,
) -> Result<Json<CreateDocumentResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    state.require_active_writable()?;
    let reply_rx = state
        .active_jobs()
        .execute_create_doc(CreateDocumentInput {
            target_dir: req.target_dir,
            name: req.name,
            initial_content: req.initial_content,
        })
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("新建文档回执任务失败: {e}")),
            &state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, &state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, &state)),
    }
}

/// POST /api/v1/files/batch-move —— 批量跨目录移动文件（静默去重 + 逐项跨库写拦截）
async fn files_batch_move(
    State(state): State<AppState>,
    body: Result<Json<BatchMoveFilesBody>, JsonRejection>,
) -> Result<Json<BatchFileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    state.require_active_writable()?;
    for fid in &req.file_ids {
        cross_write_preflight(&state, fid).await?;
    }
    let reply_rx = state
        .active_jobs()
        .execute_batch_file_op(BatchFileOpCommand::Move(BatchMoveFilesInput {
            file_ids: req.file_ids,
            target_dir: req.target_dir,
        }))
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(15))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("批量移动回执任务失败: {e}")),
            &state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, &state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, &state)),
    }
}

/// POST /api/v1/files/batch-trash —— 批量移入系统回收站（强制 confirm=true + 逐项跨库写拦截）
async fn files_batch_trash(
    State(state): State<AppState>,
    body: Result<Json<BatchTrashFilesBody>, JsonRejection>,
) -> Result<Json<BatchFileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    state.require_active_writable()?;
    for fid in &req.file_ids {
        cross_write_preflight(&state, fid).await?;
    }
    let reply_rx = state
        .active_jobs()
        .execute_batch_file_op(BatchFileOpCommand::Trash(BatchTrashFilesInput {
            file_ids: req.file_ids,
            confirm: req.confirm,
        }))
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(15))
    })
    .await
    .map_err(|e| {
        ApiError::with_generation(
            GuanlanError::Internal(format!("批量回收站回执任务失败: {e}")),
            &state,
        )
    })?;
    match outcome {
        Ok(Ok(resp)) => Ok(Json(resp)),
        Ok(Err(err)) => Err(ApiError::with_generation(err, &state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, &state)),
    }
}

/// 按版本读正文（契约 §1.8；带响应字节预算）：
/// - `raw=1`（MD/SVG/PDF）：快照原字节流式回包（64KiB 分块，恒定内存）；
/// - PDF 无 raw：JSON + raw_url（v1 指自身路径）；
/// - MD/SVG 无 raw：受限内联——打开后取**实际**文件大小（不信 DB size_bytes），
///   超过单响应上限直接 413 UNSUPPORTED_CONTENT（提示 raw=1），不整读后再判断；
///   上限内先预占字节预算，再在阻塞池里读取 + utf-8 转换 + JSON 序列化，
///   预算随响应体（BudgetedBody）释放——覆盖读取/转换/缓冲/发送全生命周期。
async fn revision_content(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    let raw = param(&params, "raw") == Some("1");
    let q = query::RevisionContentQuery { raw };
    // 版本级只读路由：挂载区命中即在参考区只读库上执行（引用的外部资料可读）
    let located = run_revision_query(&state, &revision_id, move |store, rid| {
        query::revision_content(store, rid, &q)
    })
    .await?;
    // 稳定 ETag（内容寻址）+ 条件请求/Range 的请求头
    let etag = range::etag_for_content_hash(&located.content_hash);
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let if_range = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok());
    match located.snapshot_path.clone() {
        // 流式路径：任何格式的 raw=1（含 PDF 默认二进制）都走分块流，不占内联预算
        Some(path) if located.format == "pdf" => Ok(serve_snapshot_stream(
            path,
            "application/pdf",
            &etag,
            if_none_match,
            range_header,
            if_range,
        )
        .await),
        Some(path) if raw => {
            let parsed = FileFormat::parse(&located.format);
            let mime = match parsed {
                Some(ref f) if f.is_utf8_text() && f.as_str() != "svg" => {
                    "text/plain; charset=utf-8"
                }
                Some(ref f) => f.mime_type(),
                None => "application/octet-stream",
            };
            Ok(
                serve_snapshot_stream(path, mime, &etag, if_none_match, range_header, if_range)
                    .await,
            )
        }
        Some(path) => {
            // MD/SVG 内联：先开文件取实际大小（定位与读取间快照消失 → 410）
            let file = tokio::fs::File::open(&path).await.map_err(|e| {
                ApiError::from(GuanlanError::SnapshotUnavailable(format!(
                    "快照读取失败 {}：{e}",
                    path.display()
                )))
            })?;
            let actual_len = file
                .metadata()
                .await
                .map(|m| m.len() as usize)
                .map_err(|e| {
                    ApiError::from(GuanlanError::SnapshotUnavailable(format!(
                        "快照元数据读取失败 {}：{e}",
                        path.display()
                    )))
                })?;
            // 单响应上限门禁：以磁盘实际大小为准，不信 DB 的 size_bytes
            if actual_len > state.budget.max_single() {
                // 错误包络按当前代际补齐（与 run_query 错误路径同口径）
                return Err(ApiError::with_generation(
                    GuanlanError::UnsupportedContent(format!(
                        "正文快照 {actual_len} 字节超过内联上限 {} 字节；请用 raw=1 流式读取",
                        state.budget.max_single()
                    )),
                    &state,
                ));
            }
            // 预占字节预算：许可直到响应体被读完/丢弃才归还
            let permit = state
                .budget
                .acquire(actual_len)
                .await
                .map_err(|e| ApiError {
                    err: e,
                    index_generation: state.active_exec().cached_generation(),
                })?;
            // 读取 + utf-8 转换 + JSON 序列化全部在阻塞池执行（不占异步线程）
            let mut resp = located;
            let path_for_read = path.clone();
            let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, GuanlanError> {
                // 限长读取：文件在 metadata 后增长时也不会超读
                let mut raw = Vec::with_capacity(actual_len);
                let mut f = std::fs::File::open(&path_for_read).map_err(|e| {
                    GuanlanError::SnapshotUnavailable(format!(
                        "快照读取失败 {}：{e}",
                        path_for_read.display()
                    ))
                })?;
                use std::io::Read;
                (&mut f)
                    .take(actual_len as u64)
                    .read_to_end(&mut raw)
                    .map_err(|e| {
                        GuanlanError::SnapshotUnavailable(format!(
                            "快照读取失败 {}：{e}",
                            path_for_read.display()
                        ))
                    })?;
                resp.text = Some(String::from_utf8_lossy(&raw).into_owned());
                drop(raw); // 原始字节缓冲立即释放；owned String 与 JSON 缓冲仍在预算内
                serde_json::to_vec(&resp)
                    .map_err(|e| GuanlanError::Internal(format!("正文响应序列化失败: {e}")))
            })
            .await
            .map_err(|e| {
                ApiError::from(GuanlanError::Internal(format!("序列化任务失败: {e}")))
            })??;
            let body = Body::new(response_budget::BudgetedBody::new(
                Body::from(bytes),
                permit.into_guard(),
            ));
            Ok(([(header::CONTENT_TYPE, "application/json")], body).into_response())
        }
        // PDF 默认（无 raw）：JSON + raw_url
        None => Ok(Json(located).into_response()),
    }
}

/// GET /api/v1/revisions/{revision_id}/preview —— QuickLook L1 轻预览端点。
///
/// - 文本/源码/CSV/SVG 仅读取 `offset..offset+max_bytes`（默认 64 KiB），恒定内存且支持分片续读；
/// - 图片仅读取文件头 ≤64 KiB 抽取像素尺寸，配合 `/thumbnail` 或 `?raw=1` 流式渲染；
/// - 大二进制 / L0 仅元数据文件永不读全文件（有快照只读 64 字节魔数头），附带同文件版本体积演进历史。
async fn revision_preview(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    let offset = param(&params, "offset")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let max_bytes = param(&params, "max_bytes")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(query::DEFAULT_PREVIEW_SLICE_BYTES);
    let q = query::RevisionPreviewQuery { offset, max_bytes };
    let clamped_max = q.clamped_max_bytes();

    // 版本级只读路由：挂载区命中即在参考区只读库上执行
    let mut resp = run_revision_query(&state, &revision_id, move |store, rid| {
        query::revision_preview(store, rid, &q)
    })
    .await?;

    let etag = format!(
        "\"prev-{}-g{}-o{}-m{}\"",
        resp.content_hash, resp.index_generation, offset, clamped_max
    );
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    if range::if_none_match_hits(if_none_match, &etag) {
        return Ok(build_stream_response(
            StatusCode::NOT_MODIFIED,
            vec![
                (header::ETAG, etag),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=0, must-revalidate".to_owned(),
                ),
            ],
            Body::empty(),
        ));
    }

    if let Some(path) = resp.snapshot_path.clone() {
        let preview_kind = resp.preview_kind.clone();
        let format_token = resp.format.clone();
        let inspected = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Seek};
            let mut file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => return Err(()),
            };
            let total_len = match file.metadata() {
                Ok(m) => m.len(),
                Err(_) => return Err(()),
            };

            let mut text_slice: Option<String> = None;
            let mut slice_offset: u64 = 0;
            let mut slice_bytes: u64 = 0;
            let mut line_count: u64 = 0;
            let mut truncated = false;
            let mut image_meta = None;
            let mut magic_signature: Option<String> = None;
            let mut header_hex: Option<String> = None;

            match preview_kind.as_str() {
                "markdown" | "code" | "table" | "text" | "vector" => {
                    if offset < total_len {
                        let _ = file.seek(std::io::SeekFrom::Start(offset));
                        let mut buf = Vec::with_capacity(clamped_max.min(65_536) as usize);
                        if (&mut file).take(clamped_max).read_to_end(&mut buf).is_ok() {
                            let reached_eof = offset.saturating_add(buf.len() as u64) >= total_len;
                            let (txt, skipped, used_len, lines) =
                                query::slice_utf8_bounded(&buf, offset, reached_eof);
                            slice_offset = offset.saturating_add(skipped as u64);
                            slice_bytes = used_len as u64;
                            line_count = lines;
                            truncated = slice_offset.saturating_add(slice_bytes) < total_len;
                            if preview_kind == "vector" && offset == 0 {
                                image_meta = query::inspect_image_dimensions(&buf, &format_token);
                            }
                            text_slice = Some(txt);
                        }
                    } else {
                        slice_offset = total_len;
                    }
                }
                "image" => {
                    let mut buf = Vec::with_capacity(65_536);
                    if (&mut file).take(65_536).read_to_end(&mut buf).is_ok() {
                        image_meta = query::inspect_image_dimensions(&buf, &format_token);
                    }
                }
                _ => {
                    let mut buf = Vec::with_capacity(64);
                    if (&mut file).take(64).read_to_end(&mut buf).is_ok() && !buf.is_empty() {
                        magic_signature = query::detect_magic_signature(&buf).map(str::to_owned);
                        header_hex = Some(query::format_hex_head(&buf));
                    }
                }
            }

            Ok((
                total_len,
                text_slice,
                slice_offset,
                slice_bytes,
                line_count,
                truncated,
                image_meta,
                magic_signature,
                header_hex,
            ))
        })
        .await
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("轻预览读取失败: {e}"))))?;

        match inspected {
            Ok((
                total_len,
                text_slice,
                slice_offset,
                slice_bytes,
                line_count,
                truncated,
                image_meta,
                magic_signature,
                header_hex,
            )) => {
                resp.total_bytes = total_len;
                resp.text_slice = text_slice;
                resp.slice_offset = slice_offset;
                resp.slice_bytes = slice_bytes;
                resp.line_count = line_count;
                resp.truncated = truncated;
                resp.image_meta = image_meta;
                resp.magic_signature = magic_signature;
                resp.header_hex = header_hex;
            }
            Err(()) => {
                resp.snapshot_available = false;
                resp.blob_missing = true;
                resp.raw_url = None;
                resp.thumbnail_url = None;
            }
        }
    }

    let bytes = serde_json::to_vec(&resp)
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("轻预览序列化失败: {e}"))))?;
    Ok(build_stream_response(
        StatusCode::OK,
        vec![
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (header::ETAG, etag),
            (
                header::CACHE_CONTROL,
                "private, max-age=0, must-revalidate".to_owned(),
            ),
        ],
        Body::from(bytes),
    ))
}

/// GET /api/v1/revisions/{revision_id}/office —— `.docx`/`.xlsx` 结构化 L2 阅读端点
async fn revision_office(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    // 版本级只读路由：挂载区命中即在参考区只读库上执行
    let resp = run_revision_query(&state, &revision_id, |store, rid| {
        query::revision_office(store, rid)
    })
    .await?;
    let etag = format!("\"office-{}-{}\"", resp.content_hash, resp.index_generation);
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    if range::if_none_match_hits(if_none_match, &etag) {
        return Ok(build_stream_response(
            StatusCode::NOT_MODIFIED,
            vec![
                (header::ETAG, etag),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=0, must-revalidate".to_owned(),
                ),
            ],
            Body::empty(),
        ));
    }
    let bytes = serde_json::to_vec(&resp).map_err(|e| {
        ApiError::from(GuanlanError::Internal(format!(
            "Office 阅读序列化失败: {e}"
        )))
    })?;
    Ok(build_stream_response(
        StatusCode::OK,
        vec![
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (header::ETAG, etag),
            (
                header::CACHE_CONTROL,
                "private, max-age=0, must-revalidate".to_owned(),
            ),
        ],
        Body::from(bytes),
    ))
}

/// GET /api/v1/revisions/{revision_id}/pdf —— PDF 页级文本阅读端点（页码证据直达）
async fn revision_pdf(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    // 版本级只读路由：挂载区命中即在参考区只读库上执行
    let resp = run_revision_query(&state, &revision_id, |store, rid| {
        query::revision_pdf(store, rid)
    })
    .await?;
    let etag = format!("\"pdf-{}-{}\"", resp.content_hash, resp.index_generation);
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    if range::if_none_match_hits(if_none_match, &etag) {
        return Ok(build_stream_response(
            StatusCode::NOT_MODIFIED,
            vec![
                (header::ETAG, etag),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=0, must-revalidate".to_owned(),
                ),
            ],
            Body::empty(),
        ));
    }
    let bytes = serde_json::to_vec(&resp)
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("PDF 阅读序列化失败: {e}"))))?;
    Ok(build_stream_response(
        StatusCode::OK,
        vec![
            (header::CONTENT_TYPE, "application/json".to_owned()),
            (header::ETAG, etag),
            (
                header::CACHE_CONTROL,
                "private, max-age=0, must-revalidate".to_owned(),
            ),
        ],
        Body::from(bytes),
    ))
}

/// GET /api/v1/revisions/{revision_id}/thumbnail —— 图像/矢量缩略流式端点（支持 Range/ETag）。
async fn revision_thumbnail(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    let rev_id_for_err = revision_id.clone();
    // 版本级只读路由：挂载区命中即在参考区只读库上执行
    let located = run_revision_query(&state, &revision_id, |store, rid| {
        query::revision_content(store, rid, &query::RevisionContentQuery { raw: true })
    })
    .await?;

    let parsed = FileFormat::parse(&located.format);
    let is_image_or_vector = parsed
        .as_ref()
        .is_some_and(|f| matches!(f.class(), FormatClass::Image | FormatClass::Vector));
    if !is_image_or_vector {
        return Err(ApiError::with_generation(
            GuanlanError::UnsupportedContent(format!("格式 {} 不支持图像缩略预览", located.format)),
            &state,
        ));
    }

    let Some(path) = located.snapshot_path else {
        return Err(ApiError::with_generation(
            GuanlanError::SnapshotUnavailable(format!("版本 {rev_id_for_err} 无可用图像快照")),
            &state,
        ));
    };

    let mime = parsed
        .as_ref()
        .map(|f| f.mime_type())
        .unwrap_or("application/octet-stream");
    let etag = range::etag_for_content_hash(&located.content_hash);
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let if_range = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok());

    Ok(serve_snapshot_stream(path, mime, &etag, if_none_match, range_header, if_range).await)
}

/// 快照流式响应（raw=1 / PDF 二进制）：
/// - 稳定 ETag（内容哈希）+ `If-None-Match` → 304（无 body）
/// - 单区间 `Range`（含开放结尾/后缀）→ 206 + `Content-Range`/`Content-Length`
/// - 不可满足 → 416 + `Content-Range: bytes */len`
/// - 多区间/不可解析 → 明确回退全量 200
/// - `If-Range` 不匹配 → 忽略 Range 返回全量（不让客户端拼错版本区间）
/// - 一律 64KiB 分块流式（`Accept-Ranges: bytes` + `Content-Length` 便于客户端跳页）
///
/// 快照不可用语义不变：打开失败仍是 410 SNAPSHOT_UNAVAILABLE。
/// 缓存策略：`Cache-Control: private, max-age=0, must-revalidate`——快照按内容寻址，
/// ETag 命中即 304，但不允许中间层长期缓存（本地服务，语义优先）。
async fn serve_snapshot_stream(
    path: PathBuf,
    content_type: &'static str,
    etag: &str,
    if_none_match: Option<&str>,
    range_header: Option<&str>,
    if_range: Option<&str>,
) -> Response {
    use tokio::io::AsyncSeekExt;

    let snapshot_unavailable = |e: std::io::Error| {
        ApiError::from(GuanlanError::SnapshotUnavailable(format!(
            "快照读取失败 {}：{e}",
            path.display()
        )))
        .into_response()
    };

    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(e) => return snapshot_unavailable(e),
    };
    let len = match file.metadata().await {
        Ok(meta) => meta.len(),
        Err(e) => return snapshot_unavailable(e),
    };

    // 条件请求（先于 Range：命中即 304，不读正文）
    if range::if_none_match_hits(if_none_match, etag) {
        return build_stream_response(
            StatusCode::NOT_MODIFIED,
            vec![
                (header::ETAG, etag.to_owned()),
                (header::ACCEPT_RANGES, "bytes".to_owned()),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=0, must-revalidate".to_owned(),
                ),
            ],
            Body::empty(),
        );
    }

    // If-Range 不匹配 → 忽略 Range（按全量返回，客户端会拿到完整新内容）
    let effective_range = if range::if_range_matches(if_range, etag) {
        range_header
    } else {
        None
    };

    let mut common: Vec<(axum::http::HeaderName, String)> = vec![
        (header::CONTENT_TYPE, content_type.to_owned()),
        (header::ETAG, etag.to_owned()),
        (header::ACCEPT_RANGES, "bytes".to_owned()),
        (
            header::CACHE_CONTROL,
            "private, max-age=0, must-revalidate".to_owned(),
        ),
    ];

    match range::parse_range(effective_range, len) {
        range::RangeOutcome::Unsatisfiable => {
            common.push((header::CONTENT_RANGE, format!("bytes */{len}")));
            build_stream_response(StatusCode::RANGE_NOT_SATISFIABLE, common, Body::empty())
        }
        range::RangeOutcome::Partial { start, end } => {
            let span = end - start + 1;
            common.push((header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")));
            common.push((header::CONTENT_LENGTH, span.to_string()));
            if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
                return snapshot_unavailable(e);
            }
            // 区间读取仍分块（Take 限制上界，ReaderStream 64KiB 分块）
            let stream =
                ReaderStream::with_capacity(tokio::io::AsyncReadExt::take(file, span), 64 * 1024);
            build_stream_response(
                StatusCode::PARTIAL_CONTENT,
                common,
                Body::from_stream(stream),
            )
        }
        range::RangeOutcome::Full => {
            common.push((header::CONTENT_LENGTH, len.to_string()));
            let stream = ReaderStream::with_capacity(file, 64 * 1024);
            build_stream_response(StatusCode::OK, common, Body::from_stream(stream))
        }
    }
}

/// 组装带多值头的响应（Range/条件请求路径：头需按计算结果动态生成，
/// 元组 `into_response` 不接受动态 `Vec<(HeaderName, String)>`）
fn build_stream_response(
    status: StatusCode,
    headers: Vec<(axum::http::HeaderName, String)>,
    body: Body,
) -> Response {
    let mut resp = Response::new(body);
    *resp.status_mut() = status;
    for (name, value) in headers {
        if let Ok(parsed) = HeaderValue::from_str(&value) {
            resp.headers_mut().insert(name, parsed);
        }
    }
    resp
}

async fn decisions(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<DecisionsResponse>, ApiError> {
    let q = query::DecisionsQuery {
        cursor: param(&params, "cursor").map(str::to_owned),
        limit: parse_limit(&params, "limit"),
        status: param(&params, "status").map(str::to_owned),
        code: param(&params, "code").map(str::to_owned),
        q: param(&params, "q").map(str::to_owned),
    };
    let resp = run_query(&state, move |store| query::decisions(store, &q)).await?;
    Ok(Json(resp))
}

/// 全量关系查询（契约 §1.10）
async fn relations(State(state): State<AppState>) -> Result<Json<RelationsResponse>, ApiError> {
    let resp = run_query(&state, query::relations).await?;
    Ok(Json(resp))
}

// ===== 长任务引擎与上下文基座端点处理器（契约 §2.2）=====

/// GET /api/v1/state-overview?initiative_id=（统一状态机投影，四视图唯一数据源）
async fn state_overview(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<StateOverviewResponse>, ApiError> {
    let initiative_id = param(&params, "initiative_id").map(str::to_owned);
    let resp = run_query(&state, move |store| {
        let ws = store.workspace()?;
        let overview = query::state_overview(store, &ws.workspace_id, initiative_id.as_deref())?;
        Ok(StateOverviewResponse {
            ok: true,
            index_generation: ws.index_generation,
            generated_at: guanlan_core::index::clock::now_iso(),
            initiatives: overview.initiatives,
            artifacts: overview.artifacts,
        })
    })
    .await?;
    Ok(Json(resp))
}

/// GET /api/v1/statements?file_id=&status=&limit=（拍板表单数据源）
async fn statements_list(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<StatementsResponse>, ApiError> {
    let file_id = param(&params, "file_id")
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::from(GuanlanError::BadRequest(
                "statements 需要 file_id".to_owned(),
            ))
        })?;
    let status = param(&params, "status").map(str::to_owned);
    let limit = parse_limit(&params, "limit");
    let resp = run_query(&state, move |store| {
        query::statements(store, &file_id, status.as_deref(), limit)
    })
    .await?;
    Ok(Json(resp))
}

/// 拍板回写请求体
#[derive(Debug, serde::Deserialize)]
struct ResolveRequest {
    decision: String,
    confirmer: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    effective_scope: Option<String>,
    /// YYYY-MM-DD
    #[serde(default)]
    effective_date: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// POST /api/v1/decisions/{statement_id}/resolve —— 恒 202（端点永不 409；
/// archived 主体是同步 409 CONFLICT 的唯一例外口径）
async fn decision_resolve(
    State(state): State<AppState>,
    Path(statement_id): Path<String>,
    body: Result<Json<ResolveRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<ResolveAccepted>), ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    if request.decision.trim().is_empty() || request.confirmer.trim().is_empty() {
        return Err(ApiError::from(GuanlanError::BadRequest(
            "resolve 需要 decision 与 confirmer".to_owned(),
        )));
    }
    // 受理前置检查：陈述存在 + 所属专项未归档（读侧快照，权威检查在写线程）
    let statement_lookup = statement_id.clone();
    let (decision_id, archived) = run_query(&state, move |store| {
        let brief = query::statement_brief(store, &statement_lookup)?
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到陈述 {statement_lookup}")))?;
        let archived = query::file_initiative_archived(store, &brief.file_id)?;
        Ok((brief.decision_id, archived))
    })
    .await?;
    if archived {
        return Err(ApiError::from(GuanlanError::Conflict(
            "已归档文档需先人工重开".to_owned(),
        )));
    }
    let decision_id = decision_id.ok_or_else(|| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "陈述 {statement_id} 没有 decision_id（不可拍板）"
        )))
    })?;
    let (job_id, _, _) = state.active_jobs().submit_kind(JobKind::DecisionWriteback {
        statement_id: statement_id.clone(),
        decision: request.decision,
        confirmer: request.confirmer,
        role: request.role,
        effective_scope: request.effective_scope,
        effective_date: request.effective_date,
        note: request.note,
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(ResolveAccepted {
            ok: true,
            job_id,
            statement_id,
            decision_id,
        }),
    ))
}

/// 修订草案提交请求体（含输入上下文哈希清单与回执摘要）
#[derive(Debug, serde::Deserialize)]
struct ProposeRequest {
    file_id: String,
    base_revision_id: String,
    content: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    input_context_hashes: Vec<String>,
    #[serde(default)]
    receipt_summary: Option<String>,
}

/// 草案退回请求体（可选退回理由；空 body 或 `{}` 同样合法）
#[derive(Debug, Default, serde::Deserialize)]
struct DismissRequest {
    #[serde(default)]
    reason: Option<String>,
}

/// POST /api/v1/revision-proposals —— 恒 202；默认落入独立草案分支
/// `v(N+1)-agent-draft`，绝不直接修改工作区正式文件；conflict 为受理初判预览，
/// 权威结果在 job report.proposal
async fn revision_proposals_create(
    State(state): State<AppState>,
    body: Result<Json<ProposeRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<ProposalAccepted>), ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    if request.content.is_empty() {
        return Err(ApiError::from(GuanlanError::BadRequest(
            "revision-proposals 需要 content".to_owned(),
        )));
    }
    // 受理前置：文件存在 + 未归档 + CAS 初判预览（磁盘哈希 vs 基准版本哈希）
    let proposed_hash = guanlan_core::domain::sha256_hex(request.content.as_bytes());
    let (conflict, draft_id, draft_version_label) = run_query(&state, {
        let file_id = request.file_id.clone();
        let base_revision_id = request.base_revision_id.clone();
        let content_hash = proposed_hash.clone();
        move |store| {
            let archived = query::file_initiative_archived(store, &file_id)?;
            if archived {
                return Err(GuanlanError::Conflict("已归档文档需先人工重开".to_owned()));
            }
            let ws = store.workspace()?;
            let base = store
                .snapshot_path_for_revision(&base_revision_id)
                .ok()
                .map(|(_, row)| row)
                .ok_or_else(|| {
                    GuanlanError::NotFound(format!("未找到基准版本 {base_revision_id}"))
                })?;
            let latest_seq = store
                .snapshot_path_for_file(&file_id)
                .ok()
                .map(|(_, row)| row.seq)
                .unwrap_or(base.seq);
            let version_label =
                guanlan_core::application::proposals::draft_version_label(latest_seq.max(base.seq));
            let rel_disk = disk_path_of(store, &file_id)?;
            let disk_hash = match guanlan_core::storage::sandbox::resolve_workspace_file_in_jail(
                &ws.root_path,
                &rel_disk,
            ) {
                Ok(disk_path) => std::fs::read(disk_path)
                    .map(|bytes| guanlan_core::domain::sha256_hex(&bytes))
                    .unwrap_or_default(),
                Err(GuanlanError::NotFound(_)) => String::new(),
                Err(err) => return Err(err),
            };
            let conflict = disk_hash != base.content_hash;
            let draft_id = format!(
                "draft_{}",
                guanlan_core::index::ident::stable_key(&format!(
                    "{file_id}|{base_revision_id}|{content_hash}"
                ))
            );
            Ok((conflict, draft_id, version_label))
        }
    })
    .await?;
    let input_context_hashes = guanlan_core::application::proposals::normalize_context_hashes(
        &request.input_context_hashes,
    );
    let receipt_summary = guanlan_core::application::proposals::normalize_receipt_summary(
        request.receipt_summary.as_deref(),
    );
    let (job_id, _, _) = state.active_jobs().submit_kind(JobKind::ProposeRevision {
        file_id: request.file_id,
        base_revision_id: request.base_revision_id,
        content: request.content,
        note: request.note,
        input_context_hashes,
        receipt_summary,
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(ProposalAccepted {
            ok: true,
            job_id,
            draft_id,
            conflict,
            draft_version_label,
        }),
    ))
}

/// 文件的磁盘相对路径（读侧小工具，走 core 查询）
fn disk_path_of(
    store: &guanlan_core::storage::ReadonlyStore,
    file_id: &str,
) -> Result<String, GuanlanError> {
    query::file_current_path(store, file_id)
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {file_id}")))
}

/// GET /api/v1/revision-proposals?status=&cursor=（只读分页）
async fn revision_proposals_list(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<DraftsPage>, ApiError> {
    let status = param(&params, "status").map(str::to_owned);
    let cursor = param(&params, "cursor").map(str::to_owned);
    let limit = parse_limit(&params, "limit");
    let resp = run_query(&state, move |store| {
        query::revision_drafts(store, status.as_deref(), cursor.as_deref(), limit)
    })
    .await?;
    Ok(Json(resp))
}

/// GET /api/v1/revision-proposals/{draft_id}/content（草案多模态 Diff 审阅载荷）
async fn revision_proposals_content(
    State(state): State<AppState>,
    Path(draft_id): Path<String>,
) -> Result<Json<DraftContentResponse>, ApiError> {
    let resp = run_query(&state, move |store| {
        query::revision_draft_content(store, &draft_id)
    })
    .await?;
    Ok(Json(resp))
}

/// POST /api/v1/revision-proposals/{draft_id}/adopt —— 202
async fn revision_proposals_adopt(
    State(state): State<AppState>,
    Path(draft_id): Path<String>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let (job_id, _, _) = state
        .active_jobs()
        .submit_kind(JobKind::AdoptDraft { draft_id });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// POST /api/v1/revision-proposals/{draft_id}/dismiss —— 202（支持可选 `{ reason }`）
async fn revision_proposals_dismiss(
    State(state): State<AppState>,
    Path(draft_id): Path<String>,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let reason = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<DismissRequest>(&body)
            .ok()
            .and_then(|req| req.reason)
            .map(|r| r.trim().to_owned())
            .filter(|r| !r.is_empty())
    };
    let (job_id, _, _) = state
        .active_jobs()
        .submit_kind(JobKind::DismissDraft { draft_id, reason });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// checkpoint 请求体（node_id 可缺省——按 (initiative_id, stage) 反查）
#[derive(Debug, serde::Deserialize)]
struct CheckpointRequest {
    #[serde(default)]
    node_id: Option<String>,
    initiative_id: String,
    stage: String,
    /// SUCCESS | FAILED_RETRYABLE | SUSPENDED_HITL
    status: String,
    input_context_hash: String,
    #[serde(default)]
    output_revision_id: Option<String>,
    #[serde(default)]
    token_usage: Option<i64>,
    #[serde(default)]
    elapsed_ms: Option<i64>,
    #[serde(default)]
    note: Option<String>,
}

/// POST /api/v1/checkpoints —— 同事务同步受理 201。
/// handler 在 spawn_blocking 内等写线程回执（5s 超时 → 503 INDEX_BUSY）；
/// 校验失败 404 NOT_FOUND 回传（checkpoint 不落库、无 job_id）。
async fn checkpoint_commit(
    State(state): State<AppState>,
    body: Result<Json<CheckpointRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<CheckpointAccepted>), ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    // 受理前置：initiative 存在且未归档（读侧快照；权威校验在写线程同事务内）
    let workspace_id = run_query(&state, {
        let initiative_id = request.initiative_id.clone();
        move |store| {
            let state_str = query::initiative_state(store, &initiative_id)?
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到专项 {initiative_id}")))?;
            if state_str == "archived" {
                return Err(GuanlanError::Conflict("已归档文档需先人工重开".to_owned()));
            }
            Ok(store.workspace()?.workspace_id)
        }
    })
    .await?;
    let payload = guanlan_core::index::writer::CheckpointInput {
        node_id: request.node_id,
        workspace_id,
        initiative_id: request.initiative_id,
        stage: request.stage,
        status: request.status,
        input_context_hash: request.input_context_hash,
        output_revision_id: request.output_revision_id,
        token_usage: request.token_usage,
        elapsed_ms: request.elapsed_ms,
        note: request.note,
        created_at: guanlan_core::index::clock::now_iso(),
    };
    let reply_rx = state
        .active_jobs()
        .commit_checkpoint(payload)
        .map_err(|err| ApiError {
            err,
            index_generation: state.active_exec().cached_generation(),
        })?;
    // 同步受理：阻塞池内等回执（写线程积压时最坏 5s 才 503——契约预留的回退口径）
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|e| {
        ApiError::from(GuanlanError::Internal(format!(
            "checkpoint 回执任务失败: {e}"
        )))
    })?;
    // 三层：JoinError 已 ? → RecvTimeoutError（5s 超时 → 503）→ 校验结果（404/400 原样回传）
    match outcome {
        Ok(Ok(commit)) => Ok((
            StatusCode::CREATED,
            Json(CheckpointAccepted {
                ok: true,
                checkpoint_id: commit.checkpoint_id,
                node_state: commit.node_state,
            }),
        )),
        Ok(Err(err)) => Err(ApiError {
            err,
            index_generation: state.active_exec().cached_generation(),
        }),
        Err(_timeout) => Err(ApiError {
            err: GuanlanError::IndexBusy,
            index_generation: state.active_exec().cached_generation(),
        }),
    }
}

/// GET /api/v1/checkpoints?initiative_id=&node_id=&status=&limit=
async fn checkpoints_list(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<CheckpointsPage>, ApiError> {
    let initiative_id = param(&params, "initiative_id")
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::from(GuanlanError::BadRequest(
                "checkpoints 需要 initiative_id".to_owned(),
            ))
        })?;
    let node_id = param(&params, "node_id").map(str::to_owned);
    let status = param(&params, "status").map(str::to_owned);
    let limit = parse_limit(&params, "limit");
    let resp = run_query(&state, move |store| {
        query::checkpoints(
            store,
            &initiative_id,
            node_id.as_deref(),
            status.as_deref(),
            limit,
        )
    })
    .await?;
    Ok(Json(resp))
}

/// GET /api/v1/initiatives/{initiative_id}/tasks（五槽位 DAG）
async fn initiative_tasks(
    State(state): State<AppState>,
    Path(initiative_id): Path<String>,
) -> Result<Json<TasksResponse>, ApiError> {
    let resp = run_query(&state, move |store| {
        query::task_nodes(store, &initiative_id)
    })
    .await?;
    Ok(Json(resp))
}

/// GET /api/v1/initiatives/{id}/resume-context?stage=
/// 最近 SUCCESS checkpoint + 增量变更 + 最新决策结果（外部 Agent 注入下一步 Prompt 用；
/// 引擎不做 Prompt 注入/编排）。
async fn resume_context(
    State(state): State<AppState>,
    Path(initiative_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ResumeContextResponse>, ApiError> {
    let stage = param(&params, "stage").map(str::to_owned);
    let resp = run_query(&state, move |store| {
        let ws = store.workspace()?;
        query::resume_context(store, &ws.workspace_id, &initiative_id, stage.as_deref())
    })
    .await?;
    Ok(Json(resp))
}

/// 专项归档请求体
#[derive(Debug, serde::Deserialize)]
struct ArchiveRequest {
    #[serde(default)]
    note: Option<String>,
}

/// POST /api/v1/initiatives/{id}/archive —— 202
async fn initiative_archive(
    State(state): State<AppState>,
    Path(initiative_id): Path<String>,
    body: Result<Json<ArchiveRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let note = match body {
        Ok(Json(request)) => request.note,
        Err(_) => None,
    };
    // 受理前置：专项存在（读侧；不存在 404 而非入队后失败）
    run_query(&state, {
        let initiative_id = initiative_id.clone();
        move |store| {
            query::initiative_state(store, &initiative_id)?
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到专项 {initiative_id}")))?;
            Ok(())
        }
    })
    .await?;
    let (job_id, _, _) = state.active_jobs().submit_kind(JobKind::ArchiveInitiative {
        initiative_id,
        note,
    });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// POST /api/v1/initiatives/{id}/reopen —— 202
async fn initiative_reopen(
    State(state): State<AppState>,
    Path(initiative_id): Path<String>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    run_query(&state, {
        let initiative_id = initiative_id.clone();
        move |store| {
            query::initiative_state(store, &initiative_id)?
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到专项 {initiative_id}")))?;
            Ok(())
        }
    })
    .await?;
    let (job_id, _, _) = state
        .active_jobs()
        .submit_kind(JobKind::ReopenInitiative { initiative_id });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// GET /api/v1/initiative-candidates —— 多信号候选事项列表（含理由胶囊）
async fn initiative_candidates_list(
    State(state): State<AppState>,
) -> Result<Json<guanlan_core::dto::InitiativeCandidatesResponse>, ApiError> {
    let resp = run_query(&state, query::list_candidates).await?;
    Ok(Json(resp))
}

/// 候选受理前置：候选存在性校验（不存在 404 而非入队后失败）
async fn candidate_exists_preflight(state: &AppState, candidate_id: &str) -> Result<(), ApiError> {
    run_query(state, {
        let candidate_id = candidate_id.to_owned();
        move |store| {
            if !query::candidate_exists(store, &candidate_id)? {
                return Err(GuanlanError::NotFound(format!(
                    "未找到候选事项 {candidate_id}"
                )));
            }
            Ok(())
        }
    })
    .await
}

/// POST /api/v1/initiative-candidates/{id}/adopt —— 202（采纳为正式事项）
async fn initiative_candidate_adopt(
    State(state): State<AppState>,
    Path(candidate_id): Path<String>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    candidate_exists_preflight(&state, &candidate_id).await?;
    let (job_id, _, _) = state
        .active_jobs()
        .submit_kind(JobKind::AdoptCandidate { candidate_id });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// POST /api/v1/initiative-candidates/{id}/dismiss —— 202（整簇否决 + 信号对排除）
async fn initiative_candidate_dismiss(
    State(state): State<AppState>,
    Path(candidate_id): Path<String>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    candidate_exists_preflight(&state, &candidate_id).await?;
    let (job_id, _, _) = state
        .active_jobs()
        .submit_kind(JobKind::DismissCandidate { candidate_id });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// POST /api/v1/initiative-candidates/{id}/members/{file_id}/exclude —— 202（单成员剔除）
async fn initiative_candidate_exclude(
    State(state): State<AppState>,
    Path((candidate_id, file_id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    candidate_exists_preflight(&state, &candidate_id).await?;
    let (job_id, _, _) = state
        .active_jobs()
        .submit_kind(JobKind::ExcludeCandidateMember {
            candidate_id,
            file_id,
        });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// diff 请求体
#[derive(Debug, serde::Deserialize)]
struct DiffRequest {
    file_id: String,
    baseline_revision_id: String,
    target_revision_id: String,
}

/// POST /api/v1/diff —— 202（大计算异步入任务队列，契约 §2.2）
async fn diff(
    State(state): State<AppState>,
    body: Result<Json<DiffRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    let (job_id, _, _) = state.active_jobs().submit_kind(JobKind::Diff {
        file_id: request.file_id,
        baseline_revision_id: request.baseline_revision_id,
        target_revision_id: request.target_revision_id,
    });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// context 请求体
#[derive(Debug, serde::Deserialize)]
struct ContextRequest {
    intent: String,
    #[serde(default)]
    focus_file_id: Option<String>,
    #[serde(default)]
    initiative_id: Option<String>,
    #[serde(default)]
    items: Option<Vec<ContextItemRequest>>,
    /// structured | markdown | both
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    budget_tokens: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
struct ContextItemRequest {
    file_id: String,
    #[serde(default)]
    revision_id: Option<String>,
    /// full | summary | decisions_only
    #[serde(default)]
    granularity: Option<String>,
}

/// POST /api/v1/context（智能体上下文包；单短读事务组装）
async fn context(
    State(state): State<AppState>,
    body: Result<Json<ContextRequest>, JsonRejection>,
) -> Result<Json<ContextResponse>, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    let intent = guanlan_core::application::context::ContextIntent::parse(&request.intent)
        .ok_or_else(|| {
            ApiError::from(GuanlanError::BadRequest(format!(
                "未知 intent「{}」（允许 document|initiative|global）",
                request.intent
            )))
        })?;
    let mode = match request.mode.as_deref() {
        None => guanlan_core::application::context::ContextMode::Both,
        Some(raw) => {
            guanlan_core::application::context::ContextMode::parse(raw).ok_or_else(|| {
                ApiError::from(GuanlanError::BadRequest(format!(
                    "未知 mode「{raw}」（允许 structured|markdown|both）"
                )))
            })?
        }
    };
    let mut items = Vec::new();
    for raw in request.items.unwrap_or_default() {
        let granularity = match raw.granularity.as_deref() {
            None => guanlan_core::application::context::ContextGranularity::Full,
            Some(g) => guanlan_core::application::context::ContextGranularity::parse(g)
                .ok_or_else(|| {
                    ApiError::from(GuanlanError::BadRequest(format!(
                        "未知 granularity「{g}」（允许 full|summary|diff_only|metadata_only|decisions_only）"
                    )))
                })?,
        };
        items.push(guanlan_core::application::context::ContextItemInput {
            file_id: raw.file_id,
            revision_id: raw.revision_id,
            granularity,
        });
    }
    let core_request = guanlan_core::application::context::ContextRequest {
        intent,
        focus_file_id: request.focus_file_id,
        initiative_id: request.initiative_id,
        items,
        mode,
        budget_tokens: request.budget_tokens.unwrap_or(65536).max(1),
        max_inline_bytes: state.budget.max_single(),
    };
    let resp = run_query(&state, move |store| {
        guanlan_core::application::context::assemble_context(store, &core_request)
    })
    .await?;
    Ok(Json(resp))
}

/// 主流宿主 .mcp.json 自动配置请求体（仅白名单三宿主，绝不写入任何本机密钥或环境变量）
#[derive(Debug, serde::Deserialize)]
struct McpHostConfigRequest {
    /// zcode | claude_code | cursor
    host: String,
    /// 回环端点（缺省 http://127.0.0.1:39120；强校验仅允许 127.0.0.1 / localhost）
    #[serde(default)]
    endpoint: Option<String>,
    /// true = 仅预览合并结果不落盘；false = 需 confirm=true 才原子落盘
    #[serde(default)]
    dry_run: bool,
    /// 人工确认门禁（dry_run=false 时必须 true）
    #[serde(default)]
    confirm: bool,
}

#[derive(Debug, serde::Serialize)]
struct McpHostConfigResponse {
    ok: bool,
    host: String,
    target_relative_path: String,
    target_absolute_path: String,
    endpoint: String,
    merged_existing: bool,
    written: bool,
    config_json: String,
}

fn validate_loopback_mcp_endpoint(raw: Option<&str>) -> Result<String, GuanlanError> {
    let endpoint = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("http://127.0.0.1:39120")
        .trim_end_matches('/')
        .to_owned();
    let Some(rest) = endpoint.strip_prefix("http://") else {
        return Err(GuanlanError::BadRequest(format!(
            "MCP 端点仅允许本地回环 http://127.0.0.1:<port> 或 http://localhost:<port>，收到「{endpoint}」"
        )));
    };
    let Some((host, port)) = rest.rsplit_once(':') else {
        return Err(GuanlanError::BadRequest(format!(
            "MCP 端点缺少端口号：{endpoint}"
        )));
    };
    if !matches!(host, "127.0.0.1" | "localhost") || port.parse::<u16>().is_err() {
        return Err(GuanlanError::BadRequest(format!(
            "MCP 端点仅允许本地回环地址（127.0.0.1 / localhost）与有效端口，收到「{endpoint}」"
        )));
    }
    Ok(endpoint)
}

fn host_target_relative_path(host: &str) -> Result<&'static str, GuanlanError> {
    match host {
        "zcode" | "claude_code" => Ok(".mcp.json"),
        "cursor" => Ok(".cursor/mcp.json"),
        other => Err(GuanlanError::BadRequest(format!(
            "不支持的宿主「{other}」（仅支持 zcode | claude_code | cursor）"
        ))),
    }
}

fn merge_host_mcp_config_json(
    existing_raw: Option<&str>,
    host: &str,
    endpoint: &str,
) -> Result<(String, bool), GuanlanError> {
    let mut root_obj = match existing_raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(serde_json::Value::Object(map)) => (map, true),
            Ok(_) => {
                return Err(GuanlanError::Conflict(
                    "现有宿主配置文件根节点不是 JSON 对象，已安全中止以避免覆写损坏".to_owned(),
                ));
            }
            Err(err) => {
                return Err(GuanlanError::Conflict(format!(
                    "现有宿主配置文件 JSON 解析失败（{err}），已安全中止以避免覆写人工配置"
                )));
            }
        },
        None => (serde_json::Map::new(), false),
    };
    let servers = root_obj
        .0
        .entry("mcpServers".to_owned())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let Some(servers_map) = servers.as_object_mut() else {
        return Err(GuanlanError::Conflict(
            "现有宿主配置中的 mcpServers 不是对象，已安全中止".to_owned(),
        ));
    };
    // 仅写入 guanlan 单条目与本地回环 GUANLAN_ENDPOINT，绝不注入任何密钥或宿主环境变量
    let entry = if host == "claude_code" {
        serde_json::json!({
            "type": "stdio",
            "command": "guanlan",
            "args": ["mcp"],
            "env": {
                "GUANLAN_ENDPOINT": endpoint,
            }
        })
    } else {
        serde_json::json!({
            "command": "guanlan",
            "args": ["mcp"],
            "env": {
                "GUANLAN_ENDPOINT": endpoint,
            }
        })
    };
    servers_map.insert("guanlan".to_owned(), entry);
    let formatted = serde_json::to_string_pretty(&serde_json::Value::Object(root_obj.0))
        .map_err(|e| GuanlanError::Internal(format!("序列化宿主配置失败：{e}")))?;
    Ok((format!("{formatted}\n"), root_obj.1))
}

/// POST /api/v1/mcp/host-config（一键为 ZCode / Claude Code / Cursor 生成或原子合并写入 .mcp.json）
async fn mcp_host_config(
    State(state): State<AppState>,
    body: Result<Json<McpHostConfigRequest>, JsonRejection>,
) -> Result<Json<McpHostConfigResponse>, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    let host = request.host.trim().to_ascii_lowercase();
    let rel_path = host_target_relative_path(&host)?;
    let endpoint = validate_loopback_mcp_endpoint(request.endpoint.as_deref())?;
    if !request.dry_run && !request.confirm {
        return Err(ApiError::from(GuanlanError::BadRequest(
            "写入工作区宿主配置需显式 confirm=true（或设 dry_run=true 仅预览）".to_owned(),
        )));
    }
    let root_path = run_query(&state, |store| Ok(store.workspace()?.root_path.clone())).await?;
    let target_abs = PathBuf::from(&root_path).join(rel_path);
    let existing_raw = if target_abs.exists() {
        Some(std::fs::read_to_string(&target_abs).map_err(|e| {
            ApiError::from(GuanlanError::Internal(format!("读取现有宿主配置失败：{e}")))
        })?)
    } else {
        None
    };
    let (config_json, merged_existing) =
        merge_host_mcp_config_json(existing_raw.as_deref(), &host, &endpoint)?;
    if !request.dry_run {
        if let Some(parent) = target_abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ApiError::from(GuanlanError::Internal(format!("创建宿主配置目录失败：{e}")))
            })?;
        }
        let tmp_path = target_abs.with_extension("json.guanlan.tmp");
        std::fs::write(&tmp_path, config_json.as_bytes()).map_err(|e| {
            ApiError::from(GuanlanError::Internal(format!(
                "写入宿主配置临时文件失败：{e}"
            )))
        })?;
        std::fs::rename(&tmp_path, &target_abs).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            ApiError::from(GuanlanError::Internal(format!("原子替换宿主配置失败：{e}")))
        })?;
    }
    Ok(Json(McpHostConfigResponse {
        ok: true,
        host,
        target_relative_path: rel_path.to_owned(),
        target_absolute_path: target_abs.to_string_lossy().into_owned(),
        endpoint,
        merged_existing,
        written: !request.dry_run,
        config_json,
    }))
}

#[derive(Debug, serde::Deserialize)]
struct ReviewBoardQuery {
    #[serde(default)]
    now: Option<String>,
    #[serde(default)]
    stall_threshold_secs: Option<i64>,
}

/// GET /api/v1/review-board（五态批阅看板 + 失联/无回执 unknown 诚实诊断）
async fn review_board(
    State(state): State<AppState>,
    Query(query): Query<ReviewBoardQuery>,
) -> Result<Json<ReviewBoardResponse>, ApiError> {
    let now = query.now;
    let threshold = query.stall_threshold_secs;
    let resp = run_query(&state, move |store| {
        guanlan_core::application::review_board::query_review_board(
            store,
            now.as_deref(),
            threshold,
        )
    })
    .await?;
    Ok(Json(resp))
}

#[derive(Debug, serde::Deserialize)]
struct RepairOrphanRequest {
    action: String,
    #[serde(default)]
    node_id: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// POST /api/v1/review-board/{initiative_id}/repair-orphan（人工孤儿修复入口，禁止隐式完结）
async fn review_board_repair_orphan(
    State(state): State<AppState>,
    Path(initiative_id): Path<String>,
    body: Result<Json<RepairOrphanRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    // 同步入口校验白名单（停机红线：严禁跳过人工审阅直接完结）
    let valid_action =
        guanlan_core::application::review_board::validate_orphan_repair_action(&request.action)?
            .to_owned();
    let init_check = initiative_id.clone();
    let exists = run_query(&state, move |store| {
        guanlan_core::application::review_board::initiative_exists(store, &init_check)
    })
    .await?;
    if !exists {
        return Err(ApiError::from(GuanlanError::NotFound(format!(
            "未找到专项 {initiative_id}"
        ))));
    }
    let (job_id, _, _) = state.active_jobs().submit_kind(JobKind::RepairOrphan {
        initiative_id,
        node_id: request.node_id,
        action: valid_action,
        note: request.note,
    });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

/// GET /api/v1/summary/{file_id}（L4A 确定性摘要）
async fn file_summary(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
) -> Result<Json<FileSummaryResponse>, ApiError> {
    let resp = run_query(&state, move |store| query::file_summary(store, &file_id)).await?;
    Ok(Json(resp))
}

/// SSE 流（contract-query-api.md §2.2）：hello → workspace-change 通知 → 15s 心跳
///（KeepAlive 由 axum 层承担；通知经 tokio mpsc 桥接入——其 poll_recv 公开可手写 Stream）
async fn stream(State(state): State<AppState>) -> Response {
    let hello = serde_json::json!({
        "type": "hello",
        "instance_id": state.instance_id,
        "notice_seq": state.notices.as_ref().map(|hub| hub.next_seq()).unwrap_or(0),
        "index_generation": state.active_exec().cached_generation(),
    });
    // 通知桥：broadcast 订阅 → unbounded mpsc（Receiver 实现 poll_recv，
    // SseNoticeStream 手写 Stream；订阅端断开由发送端清理）
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<crate::index_jobs::SseNotice>();
    if let Some(hub) = state.notices.clone() {
        let (_, mut broadcast_rx) = hub.subscribe();
        tokio::spawn(async move {
            loop {
                match broadcast_rx.recv().await {
                    Ok(notice) => {
                        if tx.send(notice).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
    let inner = SseNoticeStream {
        rx,
        hello: Some(hello.to_string()),
    };
    Sse::new(inner)
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

/// SSE 事件流：tokio mpsc Receiver（poll_recv 公开）+ hello 先行
struct SseNoticeStream {
    rx: tokio::sync::mpsc::UnboundedReceiver<crate::index_jobs::SseNotice>,
    hello: Option<String>,
}

impl futures_core::Stream for SseNoticeStream {
    type Item = Result<SseEvent, std::convert::Infallible>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        // hello 先行（连接建立即发 hello 三元组）
        if let Some(hello) = self.hello.take() {
            return Poll::Ready(Some(Ok(SseEvent::default().event("hello").data(hello))));
        }
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(notice)) => {
                let payload = serde_json::json!({
                    "type": "workspace-change",
                    "index_generation": notice.index_generation,
                    "new_events": notice.new_events,
                    "new_revisions": notice.new_revisions,
                    "at": notice.at,
                    "kinds": notice.kinds,
                });
                Poll::Ready(Some(Ok(SseEvent::default()
                    .event("workspace-change")
                    .data(payload.to_string()))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// GET /api/v1/search —— 有界检索（契约 §2.4）。
/// matchStrategy 四态 + 每文件命中上限 3；派生索引非 ready 时诚实返回空 items。
async fn search(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<guanlan_core::dto::SearchResponse>, ApiError> {
    let q = param(&params, "q")
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            ApiError::from(GuanlanError::BadRequest(
                "检索需要非空 q 参数（关键词 / 编号 / 文件名缩写）".to_owned(),
            ))
        })?;
    let dir = match param(&params, "dir")
        .map(|v| v.trim().trim_end_matches(['/', '\\']))
        .filter(|v| !v.is_empty())
    {
        Some(raw) => Some(
            guanlan_core::storage::sandbox::validate_workspace_rel_path(raw)
                .map_err(ApiError::from)?,
        ),
        None => None,
    };
    let query = guanlan_core::query::SearchQuery {
        q: q.to_owned(),
        format: parse_format(param(&params, "format")),
        dir,
        limit: parse_limit(&params, "limit"),
    };
    let resp = run_query(&state, move |store| query::search(store, &query)).await?;
    Ok(Json(resp))
}

/// GET /api/v1/audit/ledger —— 关键决定账本防篡改哈希链 + 工作区路径沙箱 + 响应字节预算只读审计
async fn audit_ledger(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let max_single_bytes = state.budget.max_single();
    let in_use_bytes = state.budget.in_use_bytes();
    let payload = run_query(&state, move |store| {
        let ws = store.workspace()?;
        let ledger = guanlan_core::storage::ledger::verify_decision_ledger(store)?;
        let sandbox = guanlan_core::storage::sandbox::audit_workspace_file_paths(store)?;
        let ok = ledger.ok && sandbox.ok;
        Ok(serde_json::json!({
            "ok": ok,
            "index_generation": ws.index_generation,
            "workspace_id": ws.workspace_id,
            "ledger": ledger,
            "sandbox": sandbox,
            "response_budget": {
                "max_single_bytes": max_single_bytes,
                "in_use_bytes": in_use_bytes,
            },
        }))
    })
    .await?;
    Ok(Json(payload))
}

/// POST /api/v1/capsules/preview —— 事项资料胶囊预览（体积估算 + 敏感路径自动排除 + preview_token）
async fn capsule_preview(
    State(state): State<AppState>,
    body: Result<Json<guanlan_core::application::capsule::CapsulePreviewRequest>, JsonRejection>,
) -> Result<Json<guanlan_core::application::capsule::CapsulePreviewResponse>, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let resp = run_query(&state, move |store| {
        guanlan_core::application::capsule::preview_capsule(store, &request)
    })
    .await?;
    Ok(Json(resp))
}

/// POST /api/v1/capsules/export —— 事项资料胶囊导出（强制 preview_token + confirmed_preview=true）
async fn capsule_export(
    State(state): State<AppState>,
    body: Result<Json<guanlan_core::application::capsule::CapsuleExportRequest>, JsonRejection>,
) -> Result<Json<guanlan_core::application::capsule::CapsuleExportResponse>, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let resp = run_query(&state, move |store| {
        guanlan_core::application::capsule::export_capsule(store, &request)
    })
    .await?;
    Ok(Json(resp))
}

#[derive(Debug, serde::Deserialize)]
struct CapsuleInspectRequest {
    capsule_dir: String,
}

/// POST /api/v1/capsules/inspect —— 校验并秒开任意开放事项资料胶囊目录
async fn capsule_inspect(
    State(state): State<AppState>,
    body: Result<Json<CapsuleInspectRequest>, JsonRejection>,
) -> Result<Json<guanlan_core::application::capsule::CapsuleInspectResponse>, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let dir = request.capsule_dir.trim().to_owned();
    if dir.is_empty() {
        return Err(ApiError::from(GuanlanError::BadRequest(
            "capsule_dir 不能为空".to_owned(),
        )));
    }
    let resp = tokio::task::spawn_blocking(move || {
        guanlan_core::application::capsule::inspect_capsule_dir(std::path::Path::new(&dir))
    })
    .await
    .map_err(|e| ApiError::from(GuanlanError::Internal(format!("胶囊核验任务失败：{e}"))))??;
    Ok(Json(resp))
}

#[derive(Debug, serde::Deserialize)]
struct CapsuleFileRequest {
    capsule_dir: String,
    bundled_rel_path: String,
}

/// POST /api/v1/capsules/file —— 沙箱读取胶囊内附带快照原文（支持另一台观澜跳转定位行号证据）
async fn capsule_file(
    State(state): State<AppState>,
    body: Result<Json<CapsuleFileRequest>, JsonRejection>,
) -> Result<Json<guanlan_core::application::capsule::CapsuleFileContentResponse>, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let dir = request.capsule_dir.trim().to_owned();
    let rel = request.bundled_rel_path.trim().to_owned();
    if dir.is_empty() || rel.is_empty() {
        return Err(ApiError::from(GuanlanError::BadRequest(
            "capsule_dir 与 bundled_rel_path 均不能为空".to_owned(),
        )));
    }
    let resp = tokio::task::spawn_blocking(move || {
        guanlan_core::application::capsule::read_capsule_file(std::path::Path::new(&dir), &rel)
    })
    .await
    .map_err(|e| ApiError::from(GuanlanError::Internal(format!("胶囊快照读取失败：{e}"))))??;
    Ok(Json(resp))
}

/// POST /api/v1/search/rebuild —— 202（一键重建派生检索索引；损坏自愈）
async fn search_rebuild(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let (job_id, _, _) = state.active_jobs().submit_kind(JobKind::RebuildSearchIndex);
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

// ===== 跨项目只读挂载与联合检索（契约 §2.5）=====

/// GET /api/v1/mounts —— 挂载列表（在线现读摘要；离线给最后已知摘要 + error）
async fn mounts_list(State(state): State<AppState>) -> Json<MountListResponse> {
    let registry = state.active_mounts();
    let items = tokio::task::spawn_blocking(move || registry.list())
        .await
        .unwrap_or_default();
    Json(MountListResponse {
        ok: true,
        index_generation: state.active_exec().cached_generation().unwrap_or(0),
        items,
    })
}

#[derive(Debug, serde::Deserialize)]
struct MountRequest {
    root_path: String,
}

/// POST /api/v1/mounts —— 只读挂载参考工作区（同步受理）。
/// 父子目录互斥/重复挂载在注册表内确定性拒绝（MOUNT_REJECTED 409 / CONFLICT 409）；
/// 参考区无观澜索引库 → 404（提示先用观澜索引）。
async fn mounts_mount(
    State(state): State<AppState>,
    body: Result<Json<MountRequest>, JsonRejection>,
) -> Result<Json<MountAccepted>, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    if request.root_path.trim().is_empty() {
        return Err(ApiError::from(GuanlanError::BadRequest(
            "挂载需要非空 root_path".to_owned(),
        )));
    }
    let registry = state.active_mounts();
    let info = tokio::task::spawn_blocking(move || registry.mount(&request.root_path))
        .await
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("挂载任务失败: {e}"))))??;
    Ok(Json(MountAccepted {
        ok: true,
        mount: info,
    }))
}

/// DELETE /api/v1/mounts/{mount_id} —— 卸载（只断开只读连接，绝不动参考区磁盘）
async fn mounts_unmount(
    State(state): State<AppState>,
    Path(mount_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let registry = state.active_mounts();
    let rid = mount_id.clone();
    tokio::task::spawn_blocking(move || registry.unmount(&rid))
        .await
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("卸载任务失败: {e}"))))??;
    Ok(Json(
        serde_json::json!({ "ok": true, "mount_id": mount_id }),
    ))
}

/// GET /api/v1/mounts/{mount_id}/files —— 列出只读挂载参考工作区的目录与文件树（侧栏直接浏览）
async fn mounts_files(
    State(state): State<AppState>,
    Path(mount_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<MountedFilesResponse>, ApiError> {
    let limit = parse_limit(&params, "limit").unwrap_or(1000).clamp(1, 5000) as usize;
    let registry = state.active_mounts();
    let resp = tokio::task::spawn_blocking(move || registry.list_mount_files(&mount_id, limit))
        .await
        .map_err(|e| {
            ApiError::from(GuanlanError::Internal(format!("读取挂载目录树失败: {e}")))
        })??;
    Ok(Json(resp))
}

/// GET /api/v1/search/cross?q=&format=&dir=&limit= —— 主区 + 全部在线挂载区
/// 联合检索（预算 <80ms：主区走有界执行器，挂载区在阻塞线程串行点查级执行；
/// 挂载区命中逐条携带 source_workspace 来源标注，离线挂载在 mounts[] 中诚实降级）。
async fn search_cross(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<CrossSearchResponse>, ApiError> {
    let q = param(&params, "q")
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            ApiError::from(GuanlanError::BadRequest(
                "检索需要非空 q 参数（关键词 / 编号 / 文件名缩写）".to_owned(),
            ))
        })?;
    let query = guanlan_core::query::SearchQuery {
        q: q.to_owned(),
        format: parse_format(param(&params, "format")),
        dir: param(&params, "dir").map(str::to_owned),
        limit: parse_limit(&params, "limit"),
    };
    // 主区检索（复用既有混合倒排检索管线与有界执行器）
    let primary_query = query.clone();
    let primary = run_query(&state, move |store| {
        guanlan_core::query::search(store, &primary_query)
    })
    .await?;
    // 挂载区检索（串行；离线/失败区诚实降级，不拖垮整体）
    let registry = state.active_mounts();
    let mounted = tokio::task::spawn_blocking(move || registry.search_mounts(&query))
        .await
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("挂载区检索任务失败: {e}"))))?;
    let limit = parse_limit(&params, "limit").unwrap_or(30).clamp(1, 100) as usize;
    Ok(Json(guanlan_core::query::cross_search::merge_cross_search(
        primary, mounted, limit,
    )))
}

/// 版本级只读路由：先溯源挂载区（点查 revisions 主键），命中即在对应挂载区
/// 只读连接上执行；否则回落主区有界执行器。闭包须为 Fn + Clone（多库重放）。
async fn run_revision_query<T, F>(state: &AppState, revision_id: &str, f: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: Fn(&guanlan_core::storage::ReadonlyStore, &str) -> Result<T, GuanlanError>
        + Clone
        + Send
        + 'static,
{
    // ① 挂载区溯源（逐在线挂载点查主键，毫秒级；探测异常按未命中回落主区）
    let registry = state.active_mounts();
    let rid = revision_id.to_owned();
    let mount_probe = tokio::task::spawn_blocking(move || registry.find_revision(&rid))
        .await
        .ok()
        .and_then(|probed| probed.ok())
        .flatten();
    if let Some(mount_id) = mount_probe {
        let registry = state.active_mounts();
        let rid = revision_id.to_owned();
        let closure = f.clone();
        return tokio::task::spawn_blocking(move || {
            registry.run_on_mount(&mount_id, |store| closure(store, &rid))
        })
        .await
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("挂载区查询任务失败: {e}"))))?
        .map_err(ApiError::from);
    }
    // ② 主区（既有管线原样）
    let rid = revision_id.to_owned();
    run_query(state, move |store| f(store, &rid)).await
}

/// 跨挂载写拦截溯源：file_id 属于任一在线挂载区 → 确定性 403
/// CROSS_WORKSPACE_FORBIDDEN（主/挂载区之间硬性禁止 rename/move/trash 与一切跨库写入）。
async fn cross_write_preflight(state: &AppState, file_id: &str) -> Result<(), ApiError> {
    let registry = state.active_mounts();
    let fid = file_id.to_owned();
    let provenance = tokio::task::spawn_blocking(move || registry.provenance_file(&fid))
        .await
        .ok()
        .and_then(|probed| probed.ok())
        .unwrap_or(None);
    if let Some(mount) = provenance {
        return Err(ApiError::from(GuanlanError::CrossWorkspaceForbidden(format!(
            "文件 {file_id} 属于参考工作区「{}」（{}）：参考工作区只读，主/挂载区之间禁止改名、移动与删除",
            mount.name, mount.root_path
        ))));
    }
    Ok(())
}

/// 预留 501 桩：局部关系（center_id + depth(1|2)，maxNodes=80；契约 §2.3）
async fn graph(Query(_params): Query<HashMap<String, String>>) -> ApiError {
    GuanlanError::NotImplemented("graph").into()
}

/// POST /api/v1/index-jobs —— 202 + job_id（外部四类；内部 kind 400）
async fn index_jobs(
    State(state): State<AppState>,
    body: Result<Json<IndexJobRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<IndexJobAccepted>), ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
    let kind = JobKind::parse(&request.kind).ok_or_else(|| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "未知任务类型「{}」：外部可提 verify_all|changed_paths|l4a_summary|set_initiative_dirs",
            request.kind
        )))
    })?;
    let kind = match kind {
        JobKind::ChangedPaths(_) => {
            let paths = request.paths.clone().unwrap_or_default();
            if paths.is_empty() {
                return Err(ApiError::from(GuanlanError::BadRequest(
                    "changed_paths 任务需要 paths（≤2000 条相对路径）".to_owned(),
                )));
            }
            if paths.len() > 2000 {
                return Err(ApiError::from(GuanlanError::BadRequest(format!(
                    "paths 超过 2000 条上限（{} 条）",
                    paths.len()
                ))));
            }
            JobKind::ChangedPaths(paths)
        }
        JobKind::SetInitiativeDirs(_) => {
            let dirs = request.dirs.clone().unwrap_or_default();
            if dirs.is_empty() {
                return Err(ApiError::from(GuanlanError::BadRequest(
                    "set_initiative_dirs 任务需要 dirs（≤64 条目录名）".to_owned(),
                )));
            }
            if dirs.len() > 64 {
                return Err(ApiError::from(GuanlanError::BadRequest(format!(
                    "dirs 超过 64 条上限（{} 条）",
                    dirs.len()
                ))));
            }
            JobKind::SetInitiativeDirs(dirs)
        }
        other => other,
    };
    let (job_id, merged, index_generation) = state.active_jobs().submit_external(kind)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(IndexJobAccepted {
            ok: true,
            job_id,
            state: "queued".to_owned(),
            merged,
            index_generation,
        }),
    ))
}

/// 任务状态、阶段、已发现/已处理、失败项、结果分支
async fn job_status(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<IndexJobStatusResponse>, ApiError> {
    let job = state.active_jobs().get(&job_id).ok_or_else(|| {
        ApiError::from(GuanlanError::NotFound(format!("索引任务不存在：{job_id}")))
    })?;
    Ok(Json(job.to_response()))
}

/// POST /api/v1/jobs/{job_id}/cancel —— 202（queued 立即；running 协作式；
/// 已结束 → 409 CONFLICT）
async fn job_cancel(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let response_state = state
        .active_jobs()
        .cancel(&job_id)
        .map_err(ApiError::from)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "ok": true,
            "job_id": job_id,
            "state": response_state,
        })),
    ))
}

/// GET /api/v1/jobs/{job_id}/result —— 200 {ok, job_id, state, kind,
/// result, next_cursor}
async fn job_result(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let job = state.active_jobs().get(&job_id).ok_or_else(|| {
        ApiError::from(GuanlanError::NotFound(format!("索引任务不存在：{job_id}")))
    })?;
    let response = job.to_response();
    let next_cursor = response
        .result
        .as_ref()
        .and_then(|result| result.get("next_cursor"))
        .and_then(|cursor| cursor.as_str())
        .map(str::to_owned);
    Ok(Json(serde_json::json!({
        "ok": true,
        "job_id": job.job_id,
        "state": response.state,
        "kind": response.kind,
        "result": response.result,
        "next_cursor": next_cursor,
    })))
}

#[cfg(test)]
#[path = "longtask_tests.rs"]
mod longtask_tests;
#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
