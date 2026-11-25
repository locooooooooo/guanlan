//! 多项目 HTTP 路由与处理器（`/api/v1/projects*`）：
//! 负责多项目注册管理、零重启激活、各项目完整目录树、跨项目总览、跨项目检索，
//! 以及对任意受管项目的原地文件夹/文档 CRUD（受 `readonly` 归档保护拦截）。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};

use guanlan_core::dto::{
    BatchFileMutationResponse, CreateDocumentResponse, CrossProjectSearchResponse,
    FileMutationResponse, FolderMutationResponse, ProjectListResponse, ProjectMutationResponse,
    ProjectTreeResponse, ProjectsOverviewResponse,
};
use guanlan_core::error::GuanlanError;
use guanlan_core::index::file_ops::{
    BatchMoveFilesInput, BatchTrashFilesInput, CreateDocumentInput, CreateFolderInput,
    MoveFileInput, MoveFolderInput, RenameFileInput, RenameFolderInput, TrashFileInput,
    TrashFolderInput,
};

use super::{
    param, parse_limit, ApiError, AppState, BatchMoveFilesBody, BatchTrashFilesBody,
    CreateDocumentBody, CreateFolderBody, MoveFileBody, MoveFolderBody, RenameFileBody,
    RenameFolderBody, TrashFileBody, TrashFolderBody,
};
use crate::index_jobs::{BatchFileOpCommand, FileOpCommand, FolderOpCommand};
use crate::projects::{AddProjectInput, ProjectHub, UpdateProjectInput};

pub(super) fn projects_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/projects", get(projects_list).post(projects_add))
        .route("/api/v1/projects/overview", get(projects_overview))
        .route("/api/v1/projects/search", get(projects_search))
        .route(
            "/api/v1/projects/{project_id}",
            patch(projects_update).delete(projects_remove),
        )
        .route(
            "/api/v1/projects/{project_id}/activate",
            post(projects_activate),
        )
        .route(
            "/api/v1/projects/{project_id}/rescan",
            post(projects_rescan),
        )
        .route("/api/v1/projects/{project_id}/tree", get(projects_tree))
        .route(
            "/api/v1/projects/{project_id}/folders",
            post(project_folder_create),
        )
        .route(
            "/api/v1/projects/{project_id}/folders/rename",
            post(project_folder_rename),
        )
        .route(
            "/api/v1/projects/{project_id}/folders/move",
            post(project_folder_move),
        )
        .route(
            "/api/v1/projects/{project_id}/folders/trash",
            post(project_folder_trash),
        )
        .route(
            "/api/v1/projects/{project_id}/files/create",
            post(project_file_create),
        )
        .route(
            "/api/v1/projects/{project_id}/files/{file_id}/rename",
            post(project_file_rename),
        )
        .route(
            "/api/v1/projects/{project_id}/files/{file_id}/move",
            post(project_file_move),
        )
        .route(
            "/api/v1/projects/{project_id}/files/{file_id}/trash",
            post(project_file_trash),
        )
        .route(
            "/api/v1/projects/{project_id}/files/batch-move",
            post(project_files_batch_move),
        )
        .route(
            "/api/v1/projects/{project_id}/files/batch-trash",
            post(project_files_batch_trash),
        )
}

fn require_hub(state: &AppState) -> Result<Arc<ProjectHub>, ApiError> {
    state.projects.clone().ok_or_else(|| {
        ApiError::with_generation(
            GuanlanError::NotImplemented("多项目并存中枢仅在服务完整启动时启用"),
            state,
        )
    })
}

#[derive(Debug, serde::Deserialize)]
struct AddProjectBody {
    root_path: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    readonly: bool,
    #[serde(default)]
    activate: bool,
}

#[derive(Debug, serde::Deserialize)]
struct UpdateProjectBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    readonly: Option<bool>,
}

async fn projects_list(
    State(state): State<AppState>,
) -> Result<Json<ProjectListResponse>, ApiError> {
    let hub = require_hub(&state)?;
    Ok(Json(hub.list_projects().await))
}

async fn projects_add(
    State(state): State<AppState>,
    body: Result<Json<AddProjectBody>, JsonRejection>,
) -> Result<Json<ProjectMutationResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let resp = hub
        .add_project(AddProjectInput {
            root_path: req.root_path,
            name: req.name,
            readonly: req.readonly,
            activate: req.activate,
        })
        .await
        .map_err(|err| ApiError::with_generation(err, &state))?;
    Ok(Json(resp))
}

async fn projects_update(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<UpdateProjectBody>, JsonRejection>,
) -> Result<Json<ProjectMutationResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let resp = hub
        .update_project(
            &project_id,
            UpdateProjectInput {
                name: req.name,
                readonly: req.readonly,
            },
        )
        .await
        .map_err(|err| ApiError::with_generation(err, &state))?;
    Ok(Json(resp))
}

async fn projects_remove(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ProjectListResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let resp = hub
        .remove_project(&project_id)
        .await
        .map_err(|err| ApiError::with_generation(err, &state))?;
    Ok(Json(resp))
}

async fn projects_activate(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ProjectMutationResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let resp = hub
        .activate_project(&project_id)
        .await
        .map_err(|err| ApiError::with_generation(err, &state))?;
    Ok(Json(resp))
}

async fn projects_rescan(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let hub = require_hub(&state)?;
    let job_id = hub
        .rescan_project(&project_id)
        .map_err(|err| ApiError::with_generation(err, &state))?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "project_id": project_id,
        "job_id": job_id,
    })))
}

async fn projects_tree(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ProjectTreeResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let limit = parse_limit(&params, "limit").unwrap_or(2000) as usize;
    let resp = hub
        .project_tree(&project_id, limit)
        .await
        .map_err(|err| ApiError::with_generation(err, &state))?;
    Ok(Json(resp))
}

async fn projects_overview(
    State(state): State<AppState>,
) -> Result<Json<ProjectsOverviewResponse>, ApiError> {
    let hub = require_hub(&state)?;
    Ok(Json(hub.overview().await))
}

async fn projects_search(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<CrossProjectSearchResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let q = param(&params, "q").unwrap_or("");
    let limit = parse_limit(&params, "limit").unwrap_or(30) as usize;
    Ok(Json(hub.search_all(q, limit).await))
}

// ===== 指定项目的原地文件夹 / 文档 CRUD =====

async fn run_project_folder_op(
    state: &AppState,
    project_id: &str,
    op: FolderOpCommand,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let hub = require_hub(state)?;
    let rt = hub
        .require_writable_runtime(project_id)
        .map_err(|err| ApiError::with_generation(err, state))?;
    let reply_rx = rt
        .jobs
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
            // 目录结构变了：失效该项目的清单缓存
            rt.invalidate_folder_listing();
            Ok(Json(resp))
        }
        Ok(Err(err)) => Err(ApiError::with_generation(err, state)),
        Err(_timeout) => Err(ApiError::with_generation(GuanlanError::IndexBusy, state)),
    }
}

async fn run_project_file_op(
    state: &AppState,
    project_id: &str,
    op: FileOpCommand,
) -> Result<Json<FileMutationResponse>, ApiError> {
    let hub = require_hub(state)?;
    let rt = hub
        .require_writable_runtime(project_id)
        .map_err(|err| ApiError::with_generation(err, state))?;
    let reply_rx = rt
        .jobs
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

async fn project_folder_create(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<CreateFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_project_folder_op(
        &state,
        &project_id,
        FolderOpCommand::Create(CreateFolderInput {
            parent_dir: req.parent_dir,
            name: req.name,
        }),
    )
    .await
}

async fn project_folder_rename(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<RenameFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_project_folder_op(
        &state,
        &project_id,
        FolderOpCommand::Rename(RenameFolderInput {
            folder_path: req.folder_path,
            new_name: req.new_name,
        }),
    )
    .await
}

async fn project_folder_move(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<MoveFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_project_folder_op(
        &state,
        &project_id,
        FolderOpCommand::Move(MoveFolderInput {
            folder_path: req.folder_path,
            target_parent_dir: req.target_parent_dir,
        }),
    )
    .await
}

async fn project_folder_trash(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<TrashFolderBody>, JsonRejection>,
) -> Result<Json<FolderMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_project_folder_op(
        &state,
        &project_id,
        FolderOpCommand::Trash(TrashFolderInput {
            folder_path: req.folder_path,
            confirm: req.confirm,
        }),
    )
    .await
}

async fn project_file_create(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<CreateDocumentBody>, JsonRejection>,
) -> Result<Json<CreateDocumentResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let rt = hub
        .require_writable_runtime(&project_id)
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let reply_rx = rt
        .jobs
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

async fn project_file_rename(
    State(state): State<AppState>,
    Path((project_id, file_id)): Path<(String, String)>,
    body: Result<Json<RenameFileBody>, JsonRejection>,
) -> Result<Json<FileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_project_file_op(
        &state,
        &project_id,
        FileOpCommand::Rename(RenameFileInput {
            file_id,
            new_name: req.new_name,
        }),
    )
    .await
}

async fn project_file_move(
    State(state): State<AppState>,
    Path((project_id, file_id)): Path<(String, String)>,
    body: Result<Json<MoveFileBody>, JsonRejection>,
) -> Result<Json<FileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_project_file_op(
        &state,
        &project_id,
        FileOpCommand::Move(MoveFileInput {
            file_id,
            target_dir: req.target_dir,
            new_name: req.new_name,
        }),
    )
    .await
}

async fn project_file_trash(
    State(state): State<AppState>,
    Path((project_id, file_id)): Path<(String, String)>,
    body: Result<Json<TrashFileBody>, JsonRejection>,
) -> Result<Json<FileMutationResponse>, ApiError> {
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    run_project_file_op(
        &state,
        &project_id,
        FileOpCommand::Trash(TrashFileInput {
            file_id,
            confirm: req.confirm,
        }),
    )
    .await
}

async fn project_files_batch_move(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<BatchMoveFilesBody>, JsonRejection>,
) -> Result<Json<BatchFileMutationResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let rt = hub
        .require_writable_runtime(&project_id)
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let reply_rx = rt
        .jobs
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

async fn project_files_batch_trash(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<BatchTrashFilesBody>, JsonRejection>,
) -> Result<Json<BatchFileMutationResponse>, ApiError> {
    let hub = require_hub(&state)?;
    let rt = hub
        .require_writable_runtime(&project_id)
        .map_err(|err| ApiError::with_generation(err, &state))?;
    let Json(req) = body.map_err(|rejection| {
        ApiError::with_generation(
            GuanlanError::BadRequest(format!("请求体不是合法 JSON：{rejection}")),
            &state,
        )
    })?;
    let reply_rx = rt
        .jobs
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
