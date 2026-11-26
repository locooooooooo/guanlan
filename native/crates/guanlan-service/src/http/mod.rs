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
    pub(crate) instance_id: String,
    pub(crate) dist: Option<PathBuf>,
    pub(crate) jobs: crate::index_jobs::IndexJobManager,
    pub(crate) watcher: Option<crate::watcher::WatcherHandle>,
    pub(crate) notices: Option<crate::runtime::NoticeHub>,
    pub(crate) mounts: Arc<crate::mounts::MountRegistry>,
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
        if matches!(self.err, GuanlanError::IndexBusy) {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
        }
        response
    }
}

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
        .route("/api/v1/reading-state", get(reading_state_list))
        .route("/api/v1/reading-state/batch", post(reading_state_batch))
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
        .route("/api/v1/stream", get(stream))
        .route("/api/v1/state-overview", get(state_overview))
        .route("/api/v1/statements", get(statements_list))
        .route(
            "/api/v1/decisions/{statement_id}/resolve",
            post(decision_resolve),
        )
        .route(
            "/api/v1/revision-proposals",
            get(revision_proposals_list).post(revision_proposals_create),
        )
        .route(
            "/api/v1/revision-proposals/{draft_id}/content",
            get(revision_proposals_content),
        )
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
        )
        .route(
            "/api/v1/initiatives/{initiative_id}/tasks",
            get(initiative_tasks),
        )
        .route(
            "/api/v1/initiatives/{initiative_id}/resume-context",
            get(resume_context),
        )
        .route(
            "/api/v1/initiatives/{initiative_id}/archive",
            post(initiative_archive),
        )
        .route(
            "/api/v1/initiatives/{initiative_id}/reopen",
            post(initiative_reopen),
        )
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
        .route("/api/v1/diff", post(diff))
        .route("/api/v1/context", post(context))
        .route("/api/v1/mcp/host-config", post(mcp_host_config))
        .route("/api/v1/review-board", get(review_board))
        .route(
            "/api/v1/review-board/{initiative_id}/repair-orphan",
            post(review_board_repair_orphan),
        )
        .route("/api/v1/audit/ledger", get(audit_ledger))
        .route("/api/v1/capsules/preview", post(capsule_preview))
        .route("/api/v1/capsules/export", post(capsule_export))
        .route("/api/v1/capsules/inspect", post(capsule_inspect))
        .route("/api/v1/capsules/file", post(capsule_file))
        .route("/api/v1/summary/{file_id}", get(file_summary))
        .route("/api/v1/index-jobs", post(index_jobs))
        .route("/api/v1/jobs/{job_id}", get(job_status))
        .route("/api/v1/jobs/{job_id}/cancel", post(job_cancel))
        .route("/api/v1/jobs/{job_id}/result", get(job_result))
        .route("/api/v1/search", get(search))
        .route("/api/v1/search/rebuild", post(search_rebuild))
        .route("/api/v1/mounts", get(mounts_list).post(mounts_mount))
        .route(
            "/api/v1/mounts/{mount_id}",
            axum::routing::delete(mounts_unmount),
        )
        .route("/api/v1/mounts/{mount_id}/files", get(mounts_files))
        .route("/api/v1/search/cross", get(search_cross))
        .route("/api/v1/graph", get(graph))
        .merge(projects_api::projects_routes());

    let dist = state.dist.clone();
    let router: Router<AppState> = match dist.as_deref() {
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
                    serve
                        .oneshot(req)
                        .await
                        .map(|resp| resp.map(Body::new))
                        .map_err(|e| match e {})
                }
            }))
        }
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
            let Ok(o) = origin.to_str() else { return false };
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

fn param<'m>(params: &'m HashMap<String, String>, key: &str) -> Option<&'m str> {
    params
        .get(key)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
}

fn parse_kinds(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

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

fn parse_order(raw: Option<&str>) -> query::EventOrder {
    if raw == Some("observed") {
        query::EventOrder::Observed
    } else {
        query::EventOrder::Occurred
    }
}

fn parse_granularity(raw: Option<&str>) -> query::EventGranularity {
    match raw {
        Some("week") => query::EventGranularity::Week,
        Some("month") => query::EventGranularity::Month,
        _ => query::EventGranularity::Day,
    }
}

fn parse_revision_order(raw: Option<&str>) -> query::RevisionOrder {
    if raw == Some("seq_asc") {
        query::RevisionOrder::SeqAsc
    } else {
        query::RevisionOrder::SeqDesc
    }
}

fn parse_limit(params: &HashMap<String, String>, key: &str) -> Option<u32> {
    param(params, key)
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.max(0) as u32)
}

fn parse_undated(raw: Option<&str>) -> bool {
    raw == Some("1")
}

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

async fn bootstrap(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<BootstrapResponse>, ApiError> {
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
    let mut resp = run_query(&state, move |store| application::bootstrap(store, &q)).await?;
    if state.active_jobs().has_active() {
        resp.config.runtime_status.service_state = "reconciling".to_owned();
    }
    Ok(Json(resp))
}

async fn status(State(state): State<AppState>) -> Result<Json<StatusResponse>, ApiError> {
    let mut resp = run_query(&state, application::status).await?;
    resp.instance_id = state.instance_id.clone();
    let active = state.active_jobs().active_jobs();
    resp.active_jobs = active
        .iter()
        .filter_map(|job| serde_json::to_value(job.to_response()).ok())
        .collect();
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

async fn reading_state_list(
    State(state): State<AppState>,
) -> Result<Json<guanlan_core::dto::ReadingStateListResponse>, ApiError> {
    let resp = run_query(&state, query::reading_states).await?;
    Ok(Json(resp))
}

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
        Ok(Ok(resp)) => {
            if let Some(hub) = &state.projects {
                if let Some(rt) = hub.active_runtime() {
                    rt.invalidate_folder_listing();
                }
            }
            Ok(Json(resp))
        }
        Ok(Err(err)) => Err(ApiError::with_generation(err, state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, state)),
    }
}

async fn folders_list(State(state): State<AppState>) -> Result<Json<FolderListResponse>, ApiError> {
    if let Some(hub) = &state.projects {
        if let Some(rt) = hub.active_runtime() {
            let generation =
                run_query(&state, |store| Ok(store.workspace()?.index_generation)).await?;
            let listing = tokio::task::spawn_blocking(move || rt.folder_listing())
                .await
                .unwrap_or_default();
            return Ok(Json(FolderListResponse {
                ok: true,
                index_generation: generation,
                folders: listing.folders,
                truncated: listing.truncated,
            }));
        }
    }
    let resp = run_query(&state, move |store| {
        let ws = store.workspace()?;
        let listing = collector::collect_workspace_folders(
            std::path::Path::new(&ws.root_path),
            &[],
            collector::DEFAULT_MAX_FOLDERS,
            collector::DEFAULT_MAX_DEPTH,
        );
        Ok(FolderListResponse {
            ok: true,
            index_generation: ws.index_generation,
            folders: listing.folders,
            truncated: listing.truncated,
        })
    })
    .await?;
    Ok(Json(resp))
}

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

async fn revision_content(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    let raw = param(&params, "raw") == Some("1");
    let q = query::RevisionContentQuery { raw };
    let located = run_revision_query(&state, &revision_id, move |store, rid| {
        query::revision_content(store, rid, &q)
    })
    .await?;
    let etag = range::etag_for_content_hash(&located.content_hash);
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let if_range = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok());
    match located.snapshot_path.clone() {
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
            if actual_len > state.budget.max_single() {
                return Err(ApiError::with_generation(
                    GuanlanError::UnsupportedContent(format!(
                        "正文快照 {actual_len} 字节超过内联上限 {} 字节；请用 raw=1 流式读取",
                        state.budget.max_single()
                    )),
                    &state,
                ));
            }
            let permit = state
                .budget
                .acquire(actual_len)
                .await
                .map_err(|e| ApiError {
                    err: e,
                    index_generation: state.active_exec().cached_generation(),
                })?;
            let mut resp = located;
            let path_for_read = path.clone();
            let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, GuanlanError> {
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
                drop(raw);
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
        None => Ok(Json(located).into_response()),
    }
}

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

async fn revision_office(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
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

async fn revision_pdf(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
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

async fn revision_thumbnail(
    State(state): State<AppState>,
    Path(revision_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    let rev_id_for_err = revision_id.clone();
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

async fn relations(State(state): State<AppState>) -> Result<Json<RelationsResponse>, ApiError> {
    let resp = run_query(&state, query::relations).await?;
    Ok(Json(resp))
}

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

#[derive(Debug, serde::Deserialize)]
struct ResolveRequest {
    decision: String,
    confirmer: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    effective_scope: Option<String>,
    #[serde(default)]
    effective_date: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

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

#[derive(Debug, Default, serde::Deserialize)]
struct DismissRequest {
    #[serde(default)]
    reason: Option<String>,
}

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

fn disk_path_of(
    store: &guanlan_core::storage::ReadonlyStore,
    file_id: &str,
) -> Result<String, GuanlanError> {
    query::file_current_path(store, file_id)
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {file_id}")))
}

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

async fn revision_proposals_adopt(
    State(state): State<AppState>,
    Path(draft_id): Path<String>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let (job_id, _, _) = state
        .active_jobs()
        .submit_kind(JobKind::AdoptDraft { draft_id });
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

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

#[derive(Debug, serde::Deserialize)]
struct CheckpointRequest {
    #[serde(default)]
    node_id: Option<String>,
    initiative_id: String,
    stage: String,
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

async fn checkpoint_commit(
    State(state): State<AppState>,
    body: Result<Json<CheckpointRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<CheckpointAccepted>), ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::from(GuanlanError::BadRequest(format!(
            "请求体不是合法 JSON：{rejection}"
        )))
    })?;
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
    let outcome = tokio::task::spawn_blocking(move || {
        reply_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|e| {
        ApiError::from(GuanlanError::Internal(format!(
            "checkpoint 回执任务失败: {e}"
        )))
    })?;
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

#[derive(Debug, serde::Deserialize)]
struct ArchiveRequest {
    #[serde(default)]
    note: Option<String>,
}

async fn initiative_archive(
    State(state): State<AppState>,
    Path(initiative_id): Path<String>,
    body: Result<Json<ArchiveRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let note = match body {
        Ok(Json(request)) => request.note,
        Err(_) => None,
    };
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

async fn initiative_candidates_list(
    State(state): State<AppState>,
) -> Result<Json<guanlan_core::dto::InitiativeCandidatesResponse>, ApiError> {
    let resp = run_query(&state, query::list_candidates).await?;
    Ok(Json(resp))
}

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

#[derive(Debug, serde::Deserialize)]
struct DiffRequest {
    file_id: String,
    baseline_revision_id: String,
    target_revision_id: String,
}

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

#[derive(Debug, serde::Deserialize)]
struct ContextRequest {
    intent: String,
    #[serde(default)]
    focus_file_id: Option<String>,
    #[serde(default)]
    initiative_id: Option<String>,
    #[serde(default)]
    items: Option<Vec<ContextItemRequest>>,
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
    #[serde(default)]
    granularity: Option<String>,
}

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

#[derive(Debug, serde::Deserialize)]
struct McpHostConfigRequest {
    host: String,
    /// 回环端点（缺省 http://127.0.0.1:39120；强校验仅允许 127.0.0.1 / localhost）
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    dry_run: bool,
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

async fn file_summary(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
) -> Result<Json<FileSummaryResponse>, ApiError> {
    let resp = run_query(&state, move |store| query::file_summary(store, &file_id)).await?;
    Ok(Json(resp))
}

async fn stream(State(state): State<AppState>) -> Response {
    let hello = serde_json::json!({
        "type": "hello",
        "instance_id": state.instance_id,
        "notice_seq": state.notices.as_ref().map(|hub| hub.next_seq()).unwrap_or(0),
        "index_generation": state.active_exec().cached_generation(),
    });
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

async fn search_rebuild(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<JobAccepted>), ApiError> {
    let (job_id, _, _) = state.active_jobs().submit_kind(JobKind::RebuildSearchIndex);
    Ok((StatusCode::ACCEPTED, Json(JobAccepted { ok: true, job_id })))
}

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
    let primary_query = query.clone();
    let primary = run_query(&state, move |store| {
        guanlan_core::query::search(store, &primary_query)
    })
    .await?;
    let registry = state.active_mounts();
    let mounted = tokio::task::spawn_blocking(move || registry.search_mounts(&query))
        .await
        .map_err(|e| ApiError::from(GuanlanError::Internal(format!("挂载区检索任务失败: {e}"))))?;
    let limit = parse_limit(&params, "limit").unwrap_or(30).clamp(1, 100) as usize;
    Ok(Json(guanlan_core::query::cross_search::merge_cross_search(
        primary, mounted, limit,
    )))
}

async fn run_revision_query<T, F>(state: &AppState, revision_id: &str, f: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: Fn(&guanlan_core::storage::ReadonlyStore, &str) -> Result<T, GuanlanError>
        + Clone
        + Send
        + 'static,
{
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
    let rid = revision_id.to_owned();
    run_query(state, move |store| f(store, &rid)).await
}

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

async fn graph(Query(_params): Query<HashMap<String, String>>) -> ApiError {
    GuanlanError::NotImplemented("graph").into()
}

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

async fn job_status(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<IndexJobStatusResponse>, ApiError> {
    let job = state.active_jobs().get(&job_id).ok_or_else(|| {
        ApiError::from(GuanlanError::NotFound(format!("索引任务不存在：{job_id}")))
    })?;
    Ok(Json(job.to_response()))
}

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
