//! 智能体上下文组装器。
//!
//! 三入口默认包：
//! - `document`（文档正文页）：当前文档完整正文 + 所属专项 README/核心定位（摘要）
//!   + 当前文档关联 P0/P1 未决事项；
//! - `initiative`（专项详情）：各阶段最新定版（选中修订）文档摘要 + 当前阶段全量
//!   正文 + 该专项全部未决事项；
//! - `global`（首页总览）：最近活跃 Top-3 专项核心摘要 + 全局最高优先级未决汇总。
//!
//! 双模输出：模式 A `<guanlan_context>` XML 结构 Markdown；模式 B
//! `guanlan-mcp/v1` JSON 载荷（session_checkpoint_id / context_bundle /
//! allowed_mcp_tools / guardrails）。
//!
//! Token 预算：est_tokens = ceil(cjk*0.7 + non_cjk_bytes/3.5)
//! （[`crate::index::state_machine::estimate_tokens`]，双端同公式）；超阈值时给
//! 全量条目的降级建议（est_tokens 降序）。
//!
//! 推荐挂载排序：本文引用(3)/同专项引用(3) > 跨专项引用(2) > 命名关联(1)
//! （unresolved 边归为命名关联）。

use std::collections::HashMap;

use rusqlite::params;

use crate::application::diff::{compute_diff, DiffLine};
use crate::dto::{
    ConfirmedDecision, ContextDecisions, ContextItem, ContextPreset, ContextResponse,
    PendingDecision, RecommendedItem, TokenBudget, UpstreamReferenceSnippet,
};
use crate::error::GuanlanError;
use crate::index::derive::parse_markdown_outline;
use crate::index::state_machine::estimate_tokens;
use crate::storage::{internal_sql, ReadonlyStore};

const SNAPSHOT_READ_CAP: usize = 8 * 1024 * 1024;
const DIFF_SNIPPET_MAX_LINES: usize = 120;
const DIFF_SNIPPET_MAX_BYTES: usize = 16 * 1024;
const UPSTREAM_SNIPPET_CAP: usize = 4;
const UPSTREAM_SNIPPET_MAX_CHARS: usize = 520;
/// 脱敏替换令牌（停机红线护栏：本机密钥/环境变量绝不进入上下文包）
pub const REDACTED_SECRET_MARKER: &str = "[REDACTED_SECRET]";

/// 上下文意图（intent）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextIntent {
    Document,
    Initiative,
    Global,
}

impl ContextIntent {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "document" => Some(ContextIntent::Document),
            "initiative" => Some(ContextIntent::Initiative),
            "global" => Some(ContextIntent::Global),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ContextIntent::Document => "document",
            ContextIntent::Initiative => "initiative",
            ContextIntent::Global => "global",
        }
    }
}

/// 输出模式（mode）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextMode {
    Structured,
    Markdown,
    Both,
}

impl ContextMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "structured" => Some(ContextMode::Structured),
            "markdown" => Some(ContextMode::Markdown),
            "both" => Some(ContextMode::Both),
            _ => None,
        }
    }

    fn has_markdown(self) -> bool {
        matches!(self, ContextMode::Markdown | ContextMode::Both)
    }

    fn has_structured(self) -> bool {
        matches!(self, ContextMode::Structured | ContextMode::Both)
    }
}

/// 注入粒度（full | summary | diff_only | metadata_only | decisions_only）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextGranularity {
    Full,
    Summary,
    DiffOnly,
    MetadataOnly,
    DecisionsOnly,
}

impl ContextGranularity {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "full" => Some(ContextGranularity::Full),
            "summary" => Some(ContextGranularity::Summary),
            "diff_only" => Some(ContextGranularity::DiffOnly),
            "metadata_only" => Some(ContextGranularity::MetadataOnly),
            "decisions_only" => Some(ContextGranularity::DecisionsOnly),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ContextGranularity::Full => "full",
            ContextGranularity::Summary => "summary",
            ContextGranularity::DiffOnly => "diff_only",
            ContextGranularity::MetadataOnly => "metadata_only",
            ContextGranularity::DecisionsOnly => "decisions_only",
        }
    }
}

/// 上下文请求（items 缺省/空时按意图组装默认包）
#[derive(Debug, Clone)]
pub struct ContextRequest {
    pub intent: ContextIntent,
    pub focus_file_id: Option<String>,
    pub initiative_id: Option<String>,
    pub items: Vec<ContextItemInput>,
    pub mode: ContextMode,
    pub budget_tokens: u64,
    /// 内联正文上限（service 层传入 budget.max_single()）
    pub max_inline_bytes: usize,
}

/// 显式条目（items[]）
#[derive(Debug, Clone)]
pub struct ContextItemInput {
    pub file_id: String,
    pub revision_id: Option<String>,
    pub granularity: ContextGranularity,
}

struct WorkspaceView {
    workspace_id: String,
    workspace_root: String,
    index_generation: u64,
    files: HashMap<String, FileMeta>,
    artifacts: HashMap<String, ArtifactMeta>,
    initiatives: HashMap<String, InitiativeMeta>,
}

struct FileMeta {
    path: String,
    title: String,
    format: String,
    last_revision_id: Option<String>,
    status: String,
}

struct ArtifactMeta {
    initiative_id: Option<String>,
    stage: String,
    state: String,
}

struct InitiativeMeta {
    name: String,
    current_stage: String,
}

/// GET/POST /api/v1/context 的组装入口（单短读事务）。
pub fn assemble_context(
    store: &ReadonlyStore,
    request: &ContextRequest,
) -> Result<ContextResponse, GuanlanError> {
    store.read_txn(|conn| {
        let ws = store.workspace()?.clone();
        let mut view = WorkspaceView {
            workspace_id: ws.workspace_id.clone(),
            workspace_root: ws.root_path.clone(),
            index_generation: ws.index_generation,
            files: HashMap::new(),
            artifacts: HashMap::new(),
            initiatives: HashMap::new(),
        };
        {
            let mut stmt = conn
                .prepare("SELECT file_id, current_path, title, format, last_revision_id, status FROM files WHERE workspace_id = ?")
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (file_id, path, title, format, last_revision_id, status) =
                    row.map_err(internal_sql)?;
                view.files.insert(
                    file_id,
                    FileMeta {
                        path,
                        title,
                        format,
                        last_revision_id,
                        status,
                    },
                );
            }
        }
        {
            let mut stmt = conn
                .prepare("SELECT file_id, initiative_id, stage, state FROM artifact_states WHERE workspace_id = ?")
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (file_id, initiative_id, stage, state) = row.map_err(internal_sql)?;
                view.artifacts.insert(
                    file_id,
                    ArtifactMeta {
                        initiative_id,
                        stage,
                        state,
                    },
                );
            }
        }
        {
            let mut stmt = conn
                .prepare("SELECT initiative_id, name, current_stage FROM initiatives WHERE workspace_id = ?")
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (initiative_id, name, current_stage) = row.map_err(internal_sql)?;
                view.initiatives.insert(
                    initiative_id,
                    InitiativeMeta {
                        name,
                        current_stage,
                    },
                );
            }
        }

        let mut selected: Vec<(String, Option<String>, ContextGranularity)> = Vec::new();
        if request.items.is_empty() {
            selected = default_items(conn, &ws.workspace_id, &view, request)?;
        } else {
            for item in &request.items {
                if !view.files.contains_key(&item.file_id) {
                    return Err(GuanlanError::NotFound(format!(
                        "未找到文件 {}",
                        item.file_id
                    )));
                }
                selected.push((
                    item.file_id.clone(),
                    item.revision_id.clone(),
                    item.granularity,
                ));
            }
        }
        let mut seen: Vec<String> = Vec::new();
        selected.retain(|(file_id, _, _)| {
            if seen.contains(file_id) {
                false
            } else {
                seen.push(file_id.clone());
                true
            }
        });

        let initiative_id = resolve_initiative_id(&view, request)?;
        let decision_scope: Option<Vec<String>> = match request.intent {
            ContextIntent::Document => {
                if let Some(init_id) = initiative_id.as_deref() {
                    let mut scope = initiative_file_filter(&view, Some(init_id));
                    if let Some(focus) = &request.focus_file_id {
                        if !scope.contains(focus) {
                            scope.push(focus.clone());
                        }
                    }
                    Some(scope)
                } else {
                    request.focus_file_id.clone().map(|focus| vec![focus])
                }
            }
            ContextIntent::Initiative => {
                Some(initiative_file_filter(&view, initiative_id.as_deref()))
            }
            ContextIntent::Global => None,
        };
        let (pending, confirmed) =
            collect_decisions(conn, &ws.workspace_id, &view, decision_scope.as_deref())?;

        let mut items: Vec<ContextItem> = Vec::new();
        let mut est_total: u64 = 0;
        let mut est_chars_total: u64 = 0;
        let mut redacted_total: usize = 0;
        for (file_id, explicit_rev, granularity) in &selected {
            let Some(meta) = view.files.get(file_id) else {
                continue;
            };
            let revision_id = explicit_rev
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| meta.last_revision_id.clone());
            let content_hash = revision_id
                .as_deref()
                .and_then(|rev| lookup_revision_hash(conn, rev));
            let (seq, version_label) = revision_id
                .as_deref()
                .and_then(|id| id.rsplit("_r").next())
                .and_then(|seq| seq.parse::<i64>().ok())
                .map(|seq| (Some(seq), Some(format!("v{seq}"))))
                .unwrap_or((None, None));
            let state = view
                .artifacts
                .get(file_id)
                .map(|artifact| artifact.state.clone())
                .unwrap_or_else(|| "draft".to_owned());

            let sensitive_path = is_sensitive_secret_path(&meta.path);
            let (est_chars, est, content, snippet) = if sensitive_path {
                redacted_total += 1;
                let note = format!(
                    "{} （敏感凭证路径已由脱敏护栏拦截，未读取正文）",
                    REDACTED_SECRET_MARKER
                );
                let chars = note.chars().count() as u64;
                let tok = estimate_tokens(&note);
                (chars, tok, None, Some(note))
            } else {
                match granularity {
                    ContextGranularity::Full => {
                        let raw_text = read_snapshot_text(store, revision_id.as_deref())?;
                        let (text, hits) = sanitize_context_text(&raw_text);
                        redacted_total += hits;
                        let chars = text.chars().count() as u64;
                        let est = estimate_tokens(&text);
                        let inline = request.mode.has_markdown()
                            && meta.format == "md"
                            && text.len() <= request.max_inline_bytes;
                        let content = if inline { Some(text.clone()) } else { None };
                        let snippet = if text.is_empty() {
                            None
                        } else if text.len() <= request.max_inline_bytes {
                            Some(text)
                        } else {
                            let prefix: String = text.chars().take(4000).collect();
                            Some(format!("{prefix}\n…（超出单文件内联上限，已截断）"))
                        };
                        (chars, est, content, snippet)
                    }
                    ContextGranularity::Summary => {
                        let raw_text = read_snapshot_text(store, revision_id.as_deref())?;
                        let summary_raw = summary_text(&raw_text);
                        let (summary, hits) = sanitize_context_text(&summary_raw);
                        redacted_total += hits;
                        let chars = summary.chars().count() as u64;
                        let est = estimate_tokens(&summary);
                        let snippet = if summary.is_empty() {
                            None
                        } else {
                            Some(summary)
                        };
                        (chars, est, None, snippet)
                    }
                    ContextGranularity::DiffOnly => {
                        let diff_raw = diff_only_text(
                            store,
                            conn,
                            file_id,
                            revision_id.as_deref(),
                        )?;
                        let (diff, hits) = sanitize_context_text(&diff_raw);
                        redacted_total += hits;
                        let chars = diff.chars().count() as u64;
                        let est = estimate_tokens(&diff);
                        let snippet = if diff.is_empty() { None } else { Some(diff) };
                        (chars, est, None, snippet)
                    }
                    ContextGranularity::MetadataOnly => {
                        let meta_line = metadata_only_text(
                            &meta.path,
                            version_label.as_deref(),
                            &state,
                            content_hash.as_deref(),
                        );
                        let chars = meta_line.chars().count() as u64;
                        let est = estimate_tokens(&meta_line);
                        (chars, est, None, Some(meta_line))
                    }
                    ContextGranularity::DecisionsOnly => {
                        let file_pending: Vec<PendingDecision> = pending
                            .iter()
                            .filter(|d| d.file_id == *file_id)
                            .cloned()
                            .collect();
                        let raw_dec = if file_pending.is_empty() {
                            decisions_only_text(&pending, &confirmed)
                        } else {
                            decisions_only_text(&file_pending, &confirmed)
                        };
                        let (dec, hits) = sanitize_context_text(&raw_dec);
                        redacted_total += hits;
                        let chars = dec.chars().count() as u64;
                        let est = estimate_tokens(&dec);
                        let snippet = if dec.is_empty() { None } else { Some(dec) };
                        (chars, est, None, snippet)
                    }
                }
            };
            est_total += est;
            est_chars_total += est_chars;
            items.push(ContextItem {
                file_id: file_id.clone(),
                path: meta.path.clone(),
                title: meta.title.clone(),
                revision_id: revision_id.clone(),
                seq,
                version_label,
                content_hash,
                state,
                granularity: granularity.as_str().to_owned(),
                snapshot_available: revision_id.is_some(),
                est_chars,
                est_tokens: est,
                content,
                snippet,
            });
        }

        let selected_pairs: Vec<(String, ContextGranularity)> = selected
            .iter()
            .map(|(id, _, g)| (id.clone(), *g))
            .collect();
        let (upstream_snippets, upstream_redacted) = collect_upstream_snippets(
            store,
            conn,
            &ws.workspace_id,
            &view,
            &selected_pairs,
            request,
        )?;
        redacted_total += upstream_redacted;
        for up in &upstream_snippets {
            est_total += up.est_tokens;
            est_chars_total += up.est_chars;
        }

        let recommended = collect_recommended(
            store,
            conn,
            &ws.workspace_id,
            &view,
            &selected_pairs,
            request,
        )?;

        let mut downgrade: Vec<(String, u64)> = items
            .iter()
            .filter(|item| item.granularity == "full")
            .map(|item| (item.file_id.clone(), item.est_tokens))
            .collect();
        downgrade.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let over_threshold = est_total > request.budget_tokens;
        let downgrade_suggestions = if over_threshold {
            downgrade.into_iter().map(|(file_id, _)| file_id).collect()
        } else {
            Vec::new()
        };

        let initiative_meta = initiative_id.as_deref().and_then(|id| view.initiatives.get(id));
        let markdown = if request.mode.has_markdown() {
            let raw_md = render_markdown(
                &view.workspace_root,
                initiative_meta.map(|meta| meta.name.as_str()),
                initiative_meta.map(|meta| meta.current_stage.as_str()),
                &items,
                &pending,
                &confirmed,
                &upstream_snippets,
            );
            let (clean_md, md_hits) = sanitize_context_text(&raw_md);
            redacted_total += md_hits;
            Some(clean_md)
        } else {
            None
        };
        let payload = request
            .mode
            .has_structured()
            .then(|| render_payload(store, &view, initiative_id.as_deref(), &items));

        Ok(ContextResponse {
            ok: true,
            index_generation: view.index_generation,
            intent: request.intent.as_str().to_owned(),
            workspace_root: view.workspace_root.clone(),
            initiative_id,
            preset: ContextPreset {
                items,
                recommended,
            },
            decisions: ContextDecisions {
                pending,
                confirmed,
            },
            upstream_snippets,
            token_budget: TokenBudget {
                selected: selected.len() as u32,
                est_chars: est_chars_total,
                est_tokens: est_total,
                threshold: request.budget_tokens,
                over_threshold,
                downgrade_suggestions,
            },
            redacted_secrets_count: redacted_total as u32,
            markdown,
            payload,
        })
    })
}

fn resolve_initiative_id(
    view: &WorkspaceView,
    request: &ContextRequest,
) -> Result<Option<String>, GuanlanError> {
    if let Some(initiative_id) = &request.initiative_id {
        if !view.initiatives.contains_key(initiative_id) {
            return Err(GuanlanError::NotFound(format!(
                "未找到专项 {initiative_id}"
            )));
        }
        return Ok(Some(initiative_id.clone()));
    }
    if let Some(focus) = &request.focus_file_id {
        return Ok(view
            .artifacts
            .get(focus)
            .and_then(|artifact| artifact.initiative_id.clone()));
    }
    Ok(None)
}

fn initiative_file_filter(view: &WorkspaceView, initiative_id: Option<&str>) -> Vec<String> {
    view.artifacts
        .iter()
        .filter(|(_, artifact)| artifact.initiative_id.as_deref() == initiative_id)
        .map(|(file_id, _)| file_id.clone())
        .collect()
}

fn default_items(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    view: &WorkspaceView,
    request: &ContextRequest,
) -> Result<Vec<(String, Option<String>, ContextGranularity)>, GuanlanError> {
    let mut items: Vec<(String, Option<String>, ContextGranularity)> = Vec::new();
    let push_unique = |list: &mut Vec<(String, Option<String>, ContextGranularity)>,
                       file_id: String,
                       granularity: ContextGranularity| {
        if let Some(meta) = view.files.get(&file_id) {
            if is_sensitive_secret_path(&meta.path) {
                return;
            }
        }
        if !list.iter().any(|(id, _, _)| id == &file_id) {
            list.push((file_id, None, granularity));
        }
    };

    match request.intent {
        ContextIntent::Document => {
            let focus = request.focus_file_id.as_deref().ok_or_else(|| {
                GuanlanError::BadRequest("intent=document 需要 focus_file_id".to_owned())
            })?;
            if !view.files.contains_key(focus) {
                return Err(GuanlanError::NotFound(format!("未找到文件 {focus}")));
            }
            push_unique(&mut items, focus.to_owned(), ContextGranularity::Full);
            let initiative_id = view
                .artifacts
                .get(focus)
                .and_then(|artifact| artifact.initiative_id.clone());
            if let Some(initiative_id) = &initiative_id {
                if let Some(companion) = initiative_core_doc(view, initiative_id, focus) {
                    push_unique(&mut items, companion, ContextGranularity::Summary);
                }
            }
            if let Some(meta) = view.files.get(focus) {
                if let Some(rev_id) = meta.last_revision_id.as_deref() {
                    let upstream_ids = upstream_target_file_ids(conn, workspace_id, focus, rev_id)?;
                    for target_id in upstream_ids.into_iter().take(2) {
                        push_unique(&mut items, target_id, ContextGranularity::Summary);
                    }
                }
            }
            if items.len() < 2 {
                if let Some(init_id) = initiative_id.as_deref() {
                    let mut mates: Vec<(&String, &FileMeta)> = view
                        .artifacts
                        .iter()
                        .filter(|(fid, a)| {
                            a.initiative_id.as_deref() == Some(init_id) && fid.as_str() != focus
                        })
                        .filter_map(|(fid, _)| view.files.get(fid).map(|m| (fid, m)))
                        .filter(|(_, m)| m.status == "active" && !is_sensitive_secret_path(&m.path))
                        .collect();
                    mates.sort_by(|a, b| a.1.path.cmp(&b.1.path));
                    if let Some((fid, _)) = mates.first() {
                        push_unique(&mut items, (*fid).clone(), ContextGranularity::Summary);
                    }
                }
            }
        }
        ContextIntent::Initiative => {
            let initiative_id = resolve_initiative_id(view, request)?.ok_or_else(|| {
                GuanlanError::BadRequest(
                    "intent=initiative 需要 initiative_id 或 focus_file_id".to_owned(),
                )
            })?;
            let mut by_stage: HashMap<String, Vec<(&String, &FileMeta)>> = HashMap::new();
            let mut all_init_files: Vec<(&String, &FileMeta)> = Vec::new();
            for (file_id, artifact) in &view.artifacts {
                if artifact.initiative_id.as_deref() != Some(initiative_id.as_str()) {
                    continue;
                }
                let Some(meta) = view.files.get(file_id) else {
                    continue;
                };
                if meta.status != "active" || is_sensitive_secret_path(&meta.path) {
                    continue;
                }
                all_init_files.push((file_id, meta));
                by_stage
                    .entry(artifact.stage.clone())
                    .or_default()
                    .push((file_id, meta));
            }
            all_init_files.sort_by(|a, b| a.1.path.cmp(&b.1.path));
            let current_stage = view
                .initiatives
                .get(&initiative_id)
                .map(|meta| meta.current_stage.clone())
                .unwrap_or_else(|| "待分类".to_owned());
            for stage in ["蓝图", "计划", "决策", "执行", "交付"] {
                if stage == current_stage {
                    continue;
                }
                if let Some(mut metas) = by_stage.remove(stage) {
                    metas.sort_by(|a, b| a.1.path.cmp(&b.1.path));
                    if let Some((file_id, _)) = metas.first() {
                        push_unique(&mut items, (*file_id).clone(), ContextGranularity::Summary);
                    }
                }
            }
            let mut current_files: Vec<(String, &FileMeta)> = view
                .artifacts
                .iter()
                .filter(|(_, artifact)| {
                    artifact.initiative_id.as_deref() == Some(initiative_id.as_str())
                        && artifact.stage == current_stage
                })
                .filter_map(|(file_id, _)| {
                    view.files.get(file_id).map(|meta| (file_id.clone(), meta))
                })
                .filter(|(_, meta)| {
                    meta.status == "active" && !is_sensitive_secret_path(&meta.path)
                })
                .collect();
            current_files.sort_by(|a, b| a.1.path.cmp(&b.1.path));
            for (file_id, _) in current_files {
                push_unique(&mut items, file_id, ContextGranularity::Full);
            }
            if items.is_empty() && !all_init_files.is_empty() {
                for (idx, (file_id, _)) in all_init_files.into_iter().take(6).enumerate() {
                    let g = if idx == 0 {
                        ContextGranularity::Full
                    } else {
                        ContextGranularity::Summary
                    };
                    push_unique(&mut items, file_id.clone(), g);
                }
            }
        }
        ContextIntent::Global => {
            let mut initiative_ids: Vec<&String> = view.initiatives.keys().collect();
            initiative_ids.sort();
            for initiative_id in initiative_ids.into_iter().take(3) {
                let current_stage = view
                    .initiatives
                    .get(initiative_id)
                    .map(|meta| meta.current_stage.clone())
                    .unwrap_or_default();
                let mut members: Vec<(&String, &FileMeta)> = view
                    .artifacts
                    .iter()
                    .filter(|(_, artifact)| {
                        artifact.initiative_id.as_deref() == Some(initiative_id.as_str())
                            && artifact.stage == current_stage
                    })
                    .filter_map(|(file_id, _)| view.files.get(file_id).map(|m| (file_id, m)))
                    .filter(|(_, m)| m.status == "active" && !is_sensitive_secret_path(&m.path))
                    .collect();
                members.sort_by(|a, b| a.1.path.cmp(&b.1.path));
                if let Some((file_id, _)) = members.first() {
                    push_unique(&mut items, (*file_id).clone(), ContextGranularity::Summary);
                } else if let Some(fallback) = initiative_core_doc(view, initiative_id, "") {
                    push_unique(&mut items, fallback, ContextGranularity::Summary);
                }
            }
            if items.is_empty() {
                let mut active: Vec<(&String, &FileMeta)> = view
                    .files
                    .iter()
                    .filter(|(_, m)| m.status == "active" && !is_sensitive_secret_path(&m.path))
                    .collect();
                active.sort_by(|a, b| a.1.path.cmp(&b.1.path));
                for (file_id, _) in active.into_iter().take(3) {
                    push_unique(&mut items, file_id.clone(), ContextGranularity::Summary);
                }
            }
        }
    }
    Ok(items)
}

fn initiative_core_doc(
    view: &WorkspaceView,
    initiative_id: &str,
    exclude_file_id: &str,
) -> Option<String> {
    let mut members: Vec<(&String, &FileMeta)> = view
        .artifacts
        .iter()
        .filter(|(file_id, artifact)| {
            artifact.initiative_id.as_deref() == Some(initiative_id)
                && file_id.as_str() != exclude_file_id
        })
        .filter(|(file_id, _)| {
            view.files
                .get(*file_id)
                .map(|meta| meta.status == "active" && !is_sensitive_secret_path(&meta.path))
                .unwrap_or(false)
        })
        .filter_map(|(file_id, _)| view.files.get(file_id).map(|meta| (file_id, meta)))
        .collect();
    members.sort_by(|a, b| a.1.path.cmp(&b.1.path));
    members
        .iter()
        .find(|(_, meta)| {
            let lower = meta.path.to_lowercase();
            lower.contains("readme") || meta.title.contains("核心") || meta.title.contains("定位")
        })
        .or_else(|| members.first())
        .map(|(file_id, _)| (*file_id).clone())
}

fn read_snapshot_text(
    store: &ReadonlyStore,
    revision_id: Option<&str>,
) -> Result<String, GuanlanError> {
    let Some(revision_id) = revision_id else {
        return Ok(String::new());
    };
    let Some((path, _)) = store.snapshot_path_for_revision(revision_id).ok() else {
        return Ok(String::new());
    };
    let bytes = std::fs::read(&path).unwrap_or_default();
    let capped = &bytes[..bytes.len().min(SNAPSHOT_READ_CAP)];
    Ok(String::from_utf8_lossy(capped).into_owned())
}

fn summary_text(content: &str) -> String {
    let outline = parse_markdown_outline(content);
    let mut out = String::new();
    for (title, line) in outline.iter().take(30) {
        out.push_str(&format!("- {title}（L{line}）\n"));
    }
    let mut conclusions: Vec<&str> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("```") {
            continue;
        }
        if trimmed.contains("结论")
            || trimmed.contains("决定：")
            || trimmed.contains("已确认")
            || trimmed.contains("核心方案")
            || trimmed.contains("终版")
        {
            conclusions.push(trimmed);
            if conclusions.len() >= 8 {
                break;
            }
        }
    }
    for line in &conclusions {
        out.push_str(&format!("结论：{line}\n"));
    }
    if let Some(paragraph) = content.lines().find(|line| {
        let t = line.trim();
        !t.is_empty() && !t.starts_with('#') && !t.starts_with("```") && !conclusions.contains(&t)
    }) {
        out.push_str(paragraph.trim());
    }
    out
}

fn decisions_only_text(pending: &[PendingDecision], confirmed: &[ConfirmedDecision]) -> String {
    let mut out = String::new();
    for decision in confirmed {
        out.push_str(&format!("[已确认] {}\n", decision.decision_text));
    }
    for decision in pending {
        out.push_str(&format!(
            "[{}-待确认] {}（{}#L{}）\n",
            decision.priority, decision.question, decision.path, decision.line_start
        ));
    }
    out
}

#[allow(clippy::type_complexity)]
fn collect_decisions(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    view: &WorkspaceView,
    file_filter: Option<&[String]>,
) -> Result<(Vec<PendingDecision>, Vec<ConfirmedDecision>), GuanlanError> {
    let mut stmt = conn
        .prepare(
            "SELECT s.statement_id, s.code, s.question, s.status, s.file_id,
                    s.decision_id, s.detail_json, s.quote, s.line_start, s.observed_at
             FROM statements s
             WHERE s.workspace_id = ? AND s.revision_id IN (
                 SELECT last_revision_id FROM files WHERE workspace_id = ? AND last_revision_id IS NOT NULL
             )
             ORDER BY s.line_start ASC",
        )
        .map_err(internal_sql)?;
    let rows = stmt
        .query_map(params![workspace_id, workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;

    type Latest = (
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        String,
    );
    let mut latest: HashMap<String, Latest> = HashMap::new();
    for (
        statement_id,
        code,
        question,
        status,
        file_id,
        decision_id,
        detail_json,
        quote,
        line_start,
        observed_at,
    ) in rows
    {
        if let Some(filter) = file_filter {
            if !filter.contains(&file_id) {
                continue;
            }
        }
        let Some(decision_id) = decision_id else {
            continue;
        };
        let candidate: Latest = (
            statement_id,
            code,
            question,
            status,
            file_id,
            observed_at.clone(),
            line_start,
            detail_json,
            quote,
        );
        latest
            .entry(decision_id.clone())
            .and_modify(|existing| {
                if candidate.5 > existing.5 {
                    *existing = candidate.clone();
                }
            })
            .or_insert(candidate);
    }

    let mut pending: Vec<PendingDecision> = Vec::new();
    let mut confirmed: Vec<ConfirmedDecision> = Vec::new();
    for (decision_id, entry) in latest {
        let (
            statement_id,
            code,
            question,
            status,
            file_id,
            _observed,
            line_start,
            detail_json,
            quote,
        ) = entry;
        let path = view
            .files
            .get(&file_id)
            .map(|meta| meta.path.clone())
            .unwrap_or_default();
        let detail: serde_json::Value =
            serde_json::from_str(&detail_json).unwrap_or(serde_json::Value::Null);
        let priority = detail
            .get("priority")
            .and_then(|p| p.as_str())
            .filter(|p| matches!(*p, "P0" | "P1" | "P2"))
            .unwrap_or("P2")
            .to_owned();
        match status.as_str() {
            "待确认" => pending.push(PendingDecision {
                decision_id: decision_id.clone(),
                statement_id,
                code,
                priority,
                question,
                file_id,
                path,
                line_start,
            }),
            "已确认" => confirmed.push(ConfirmedDecision {
                decision_id,
                decision_text: quote,
                confirmer: detail
                    .get("confirmer")
                    .and_then(|c| c.as_str())
                    .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '_' || c == '…'))
                    .map(str::to_owned),
                effective_date: detail
                    .get("effective_date")
                    .and_then(|d| d.as_str())
                    .map(str::to_owned),
            }),
            _ => {}
        }
    }
    pending.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then(a.path.cmp(&b.path))
            .then(a.line_start.cmp(&b.line_start))
            .then(a.decision_id.cmp(&b.decision_id))
    });
    confirmed.sort_by(|a, b| {
        a.decision_id
            .cmp(&b.decision_id)
            .then(a.decision_text.cmp(&b.decision_text))
    });
    Ok((pending, confirmed))
}

fn collect_recommended(
    store: &ReadonlyStore,
    conn: &rusqlite::Connection,
    workspace_id: &str,
    view: &WorkspaceView,
    selected: &[(String, ContextGranularity)],
    request: &ContextRequest,
) -> Result<Vec<RecommendedItem>, GuanlanError> {
    let selected_ids: Vec<&str> = selected.iter().map(|(id, _)| id.as_str()).collect();
    let mut source_revisions: Vec<(String, String)> = Vec::new();
    if let Some(focus) = &request.focus_file_id {
        if let Some(meta) = view.files.get(focus) {
            if let Some(revision_id) = &meta.last_revision_id {
                source_revisions.push((focus.clone(), revision_id.clone()));
            }
        }
    }
    if source_revisions.is_empty() {
        for (file_id, _) in selected {
            if let Some(meta) = view.files.get(file_id) {
                if let Some(revision_id) = &meta.last_revision_id {
                    source_revisions.push((file_id.clone(), revision_id.clone()));
                }
            }
        }
    }
    if source_revisions.is_empty() {
        return Ok(Vec::new());
    }

    let mut edges: Vec<(String, String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.source_file_id, e.target_file_id, e.resolution FROM edges e
                 JOIN revisions r ON r.revision_id = e.source_revision_id
                 WHERE r.workspace_id = ? AND r.file_id = ? AND r.revision_id = ?",
            )
            .map_err(internal_sql)?;
        for (file_id, revision_id) in &source_revisions {
            let rows = stmt
                .query_map(params![workspace_id, file_id, revision_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?;
            edges.extend(rows);
        }
    }

    let mut ranked: Vec<(u8, RecommendedItem)> = Vec::new();
    let mut seen_targets: Vec<String> = Vec::new();
    for (source_file_id, target_file_id, _resolution) in edges {
        let Some(target_id) = target_file_id
            .strip_prefix("unresolved:")
            .map_or_else(|| Some(target_file_id.clone()), |_| None)
        else {
            continue;
        };
        if selected_ids.contains(&target_id.as_str()) || seen_targets.contains(&target_id) {
            continue;
        }
        let Some(meta) = view.files.get(&target_id) else {
            continue;
        };
        if is_sensitive_secret_path(&meta.path) {
            continue;
        }
        seen_targets.push(target_id.clone());
        let source_initiative = view
            .artifacts
            .get(&source_file_id)
            .and_then(|artifact| artifact.initiative_id.clone());
        let target_initiative = view
            .artifacts
            .get(&target_id)
            .and_then(|artifact| artifact.initiative_id.clone());
        let (reason, rank) =
            if source_initiative.is_some() && source_initiative == target_initiative {
                if request.focus_file_id.as_deref() == Some(source_file_id.as_str()) {
                    ("本文引用", 3u8)
                } else {
                    ("同专项引用", 3u8)
                }
            } else {
                ("跨专项引用", 2u8)
            };
        let revision_id = meta.last_revision_id.clone();
        let content_hash = revision_id
            .as_deref()
            .and_then(|rev| lookup_revision_hash(conn, rev));
        let content = read_snapshot_text(store, revision_id.as_deref())?;
        let (clean_summary, _) = sanitize_context_text(&summary_text(&content));
        let est_chars = clean_summary.chars().count() as u64;
        let est = estimate_tokens(&clean_summary);
        let seq = revision_id
            .as_deref()
            .and_then(|id| id.rsplit("_r").next().and_then(|s| s.parse::<i64>().ok()));
        recommended_ranked_push(
            &mut ranked,
            rank,
            RecommendedItem {
                item: ContextItem {
                    file_id: target_id.clone(),
                    path: meta.path.clone(),
                    title: meta.title.clone(),
                    revision_id: revision_id.clone(),
                    seq,
                    version_label: seq.map(|n| format!("v{n}")),
                    content_hash,
                    state: view
                        .artifacts
                        .get(&target_id)
                        .map(|artifact| artifact.state.clone())
                        .unwrap_or_else(|| "draft".to_owned()),
                    granularity: ContextGranularity::Summary.as_str().to_owned(),
                    snapshot_available: revision_id.is_some(),
                    est_chars,
                    est_tokens: est,
                    content: None,
                    snippet: None,
                },
                reason: reason.to_owned(),
            },
        );
    }
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.item.est_tokens.cmp(&a.1.item.est_tokens))
            .then(a.1.item.path.cmp(&b.1.item.path))
    });
    Ok(ranked.into_iter().map(|(_, item)| item).collect())
}

fn recommended_ranked_push(
    ranked: &mut Vec<(u8, RecommendedItem)>,
    rank: u8,
    item: RecommendedItem,
) {
    ranked.push((rank, item));
}

fn state_label(state: &str) -> &'static str {
    match state {
        "draft" => "草稿",
        "pending_review" => "待用户确认",
        "approved_revision" => "选中修订",
        "executing" => "执行中",
        "delivered" => "已交付",
        "archived" => "已归档",
        _ => "草稿",
    }
}

fn granularity_label(granularity: &str) -> &'static str {
    match granularity {
        "full" => "全文",
        "summary" => "仅大纲与结论",
        "diff_only" => "仅变更 Diff",
        "metadata_only" => "仅元数据路径",
        "decisions_only" => "仅决策",
        _ => "全文",
    }
}

fn render_markdown(
    workspace_root: &str,
    initiative_name: Option<&str>,
    initiative_stage: Option<&str>,
    items: &[ContextItem],
    pending: &[PendingDecision],
    confirmed: &[ConfirmedDecision],
    upstream_snippets: &[UpstreamReferenceSnippet],
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "<guanlan_context workspace=\"{}\"",
        xml_attr(workspace_root)
    ));
    if let Some(name) = initiative_name {
        out.push_str(&format!(" initiative=\"{}\"", xml_attr(name)));
    }
    if let Some(stage) = initiative_stage {
        out.push_str(&format!(" stage=\"{}\"", xml_attr(stage)));
    }
    out.push_str(">\n");

    out.push_str("  <objective>\n");
    out.push_str(
        "    请阅读以下观澜工作区上下文，基于已拍板决策推进当前阶段长任务，并在完成后按规范更新对应文档。\n",
    );
    out.push_str("  </objective>\n\n");

    out.push_str(&format!(
        "  <confirmed_decisions count=\"{}\">\n",
        confirmed.len()
    ));
    for decision in confirmed {
        let confirmer = decision.confirmer.as_deref().unwrap_or("未登记");
        let date = decision.effective_date.as_deref().unwrap_or("未登记");
        let text = decision.decision_text.chars().take(160).collect::<String>();
        out.push_str(&format!(
            "    - {text}（确认人：{confirmer}，生效日期：{date}）\n"
        ));
    }
    out.push_str("  </confirmed_decisions>\n\n");

    out.push_str(&format!(
        "  <pending_blockers count=\"{}\">\n",
        pending.len()
    ));
    for decision in pending {
        out.push_str(&format!(
            "    - [{}-待确认] {}（文件路径：{}#L{}）\n",
            decision.priority, decision.question, decision.path, decision.line_start
        ));
    }
    out.push_str("  </pending_blockers>\n\n");

    if !upstream_snippets.is_empty() {
        out.push_str(&format!(
            "  <upstream_references count=\"{}\">\n",
            upstream_snippets.len()
        ));
        for up in upstream_snippets {
            let ver = up.version_label.as_deref().unwrap_or("未知版本");
            let hash_bit = up
                .content_hash
                .as_deref()
                .map(|h| format!(" · sha256:{}", &h[..h.len().min(16)]))
                .unwrap_or_default();
            out.push_str(&format!(
                "    <reference path=\"{}\" version=\"{}\" relation=\"{}\"{}>\n",
                xml_attr(&up.path),
                xml_attr(ver),
                xml_attr(&up.relation_type),
                if hash_bit.is_empty() {
                    String::new()
                } else {
                    format!(
                        " hash=\"sha256:{}\"",
                        xml_attr(
                            up.content_hash
                                .as_deref()
                                .map(|h| &h[..h.len().min(16)])
                                .unwrap_or("")
                        )
                    )
                }
            ));
            for line in up.snippet.lines() {
                out.push_str("      ");
                out.push_str(line);
                out.push('\n');
            }
            out.push_str("    </reference>\n");
        }
        out.push_str("  </upstream_references>\n\n");
    }

    out.push_str(&format!("  <reference_files count=\"{}\">\n", items.len()));
    for (index, item) in items.iter().enumerate() {
        let version = item.version_label.as_deref().unwrap_or("未知版本");
        let state = state_label(&item.state);
        out.push_str(&format!(
            "    {}. [{}] {} ({} · {})\n",
            index + 1,
            granularity_label(&item.granularity),
            item.path,
            version,
            state
        ));
    }
    out.push_str("  </reference_files>\n\n");

    let excerpt_items: Vec<&ContextItem> = items
        .iter()
        .filter(|item| {
            item.granularity != "metadata_only"
                && item
                    .snippet
                    .as_deref()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false)
        })
        .collect();
    if !excerpt_items.is_empty() {
        out.push_str(&format!(
            "  <context_excerpts count=\"{}\">\n",
            excerpt_items.len()
        ));
        for item in excerpt_items {
            let version = item.version_label.as_deref().unwrap_or("未知版本");
            let hash_attr = item
                .content_hash
                .as_deref()
                .map(|h| format!(" hash=\"sha256:{}\"", xml_attr(&h[..h.len().min(16)])))
                .unwrap_or_default();
            out.push_str(&format!(
                "    <artifact path=\"{}\" granularity=\"{}\" version=\"{}\"{}>\n",
                xml_attr(&item.path),
                xml_attr(&item.granularity),
                xml_attr(version),
                hash_attr
            ));
            if let Some(snippet) = item.snippet.as_deref() {
                for line in snippet.lines() {
                    out.push_str("      ");
                    out.push_str(line);
                    out.push('\n');
                }
            }
            out.push_str("    </artifact>\n");
        }
        out.push_str("  </context_excerpts>\n\n");
    }

    out.push_str("  <writeback_protocol>\n");
    out.push_str(
        "    执行完成后，请勿仅在对话中输出总结。请直接修改上述本地 Markdown 文件的对应章节，并在文件头部 YAML Frontmatter 中递增 `revision` 版本号，以便观澜后台 File Watcher 自动捕获并沉淀新版本 Checkpoint。\n",
    );
    out.push_str("  </writeback_protocol>\n");
    out.push_str("</guanlan_context>\n");
    out
}

fn xml_attr(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_payload(
    store: &ReadonlyStore,
    view: &WorkspaceView,
    initiative_id: Option<&str>,
    items: &[ContextItem],
) -> serde_json::Value {
    let session_checkpoint_id = initiative_id.and_then(|id| {
        latest_success_checkpoint_id(store, &view.workspace_id, id)
            .ok()
            .flatten()
    });
    let bundle: Vec<serde_json::Value> = items
        .iter()
        .map(|item| {
            let granularity = match item.granularity.as_str() {
                "summary" => "summary_only",
                other => other,
            };
            let hash_prefix = item
                .content_hash
                .as_deref()
                .filter(|h| !h.is_empty())
                .map(|h| format!("sha256:{}", &h[..h.len().min(16)]))
                .or_else(|| {
                    item.revision_id
                        .as_deref()
                        .map(|id| format!("sha256:{}", &id[id.len().saturating_sub(16)..]))
                })
                .unwrap_or_default();
            serde_json::json!({
                "uri": format!("guanlan://{}", item.path),
                "granularity": granularity,
                "version": item.version_label.clone().unwrap_or_default(),
                "hash": hash_prefix,
            })
        })
        .collect();
    serde_json::json!({
        "protocol": "guanlan-mcp/v1",
        "session_checkpoint_id": session_checkpoint_id,
        "workspace_root": view.workspace_root,
        "initiative": initiative_id.map(|id| {
            let meta = view.initiatives.get(id);
            serde_json::json!({
                "id": id,
                "name": meta.map(|m| m.name.clone()).unwrap_or_default(),
                "current_stage": meta.map(|m| m.current_stage.clone()).unwrap_or_default(),
            })
        }),
        "context_bundle": bundle,
        "allowed_mcp_tools": [
            "guanlan.read_artifact",
            "guanlan.propose_revision",
            "guanlan.resolve_decision",
            "guanlan.commit_checkpoint",
        ],
        "guardrails": {
            "block_write_on_unresolved_p0": true,
            "require_version_bump": true,
        }
    })
}

fn latest_success_checkpoint_id(
    store: &ReadonlyStore,
    workspace_id: &str,
    initiative_id: &str,
) -> Result<Option<String>, GuanlanError> {
    store.read_txn(|conn| {
        conn.prepare(
            "SELECT checkpoint_id FROM checkpoints
             WHERE workspace_id = ? AND initiative_id = ? AND status = 'SUCCESS'
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .map_err(internal_sql)?
        .query_row(params![workspace_id, initiative_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(crate::storage::internal_sql(other)),
        })
        .map(|found| found.flatten())
    })
}

fn lookup_revision_hash(conn: &rusqlite::Connection, revision_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT content_hash FROM revisions WHERE revision_id = ?",
        params![revision_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|h| !h.trim().is_empty())
}

fn metadata_only_text(
    path: &str,
    version_label: Option<&str>,
    state: &str,
    content_hash: Option<&str>,
) -> String {
    let ver = version_label.unwrap_or("未知版本");
    let hash_part = content_hash
        .filter(|h| !h.is_empty())
        .map(|h| format!(" | sha256:{}", &h[..h.len().min(16)]))
        .unwrap_or_default();
    format!("{path} | {ver} | {}{hash_part}", state_label(state))
}

fn diff_only_text(
    store: &ReadonlyStore,
    conn: &rusqlite::Connection,
    file_id: &str,
    revision_id: Option<&str>,
) -> Result<String, GuanlanError> {
    let Some(cur_rev) = revision_id else {
        return Ok("（尚无已采集版本，无变更 Diff）".to_owned());
    };
    let cur_text = read_snapshot_text(store, Some(cur_rev))?;
    let prev_rev: Option<String> = conn
        .query_row(
            "SELECT prev_revision_id, seq FROM revisions WHERE revision_id = ?",
            params![cur_rev],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .ok()
        .and_then(|(prev, seq)| {
            if let Some(p) = prev.filter(|s| !s.trim().is_empty()) {
                return Some(p);
            }
            conn.query_row(
                "SELECT revision_id FROM revisions
                 WHERE file_id = ? AND seq < ?
                 ORDER BY seq DESC LIMIT 1",
                params![file_id, seq],
                |row| row.get::<_, String>(0),
            )
            .ok()
        });

    let Some(prev_rev_id) = prev_rev else {
        let mut out = String::from("（初始版本，尚无历史前驱 Diff；展示首段预览）\n");
        for line in cur_text.lines().take(12) {
            out.push_str("+ ");
            out.push_str(line);
            out.push('\n');
        }
        return Ok(out);
    };

    let prev_text = read_snapshot_text(store, Some(&prev_rev_id))?;
    if prev_text.is_empty() && !cur_text.is_empty() {
        let mut out = format!("（前驱版本 {prev_rev_id} 快照不可用；展示当前版前段预览）\n");
        for line in cur_text.lines().take(12) {
            out.push_str("+ ");
            out.push_str(line);
            out.push('\n');
        }
        return Ok(out);
    }
    if prev_text == cur_text {
        return Ok(format!(
            "（与前驱版本 {prev_rev_id} 逐字节一致，无内容变更）"
        ));
    }

    let diff = compute_diff(&prev_text, &cur_text, &[], &[]);
    let mut out = format!("对比基线：{prev_rev_id} → {cur_rev}\n");
    let mut emitted_lines = 0usize;
    for section in &diff.sections {
        if emitted_lines >= DIFF_SNIPPET_MAX_LINES || out.len() >= DIFF_SNIPPET_MAX_BYTES {
            out.push_str("…（变更行超出单文件 Diff 预算上限，已截断）\n");
            break;
        }
        if !section.title.is_empty() {
            out.push_str(&format!("@@ {} @@\n", section.title));
        }
        for line in &section.lines {
            if emitted_lines >= DIFF_SNIPPET_MAX_LINES || out.len() >= DIFF_SNIPPET_MAX_BYTES {
                break;
            }
            match line {
                DiffLine::Add(text) => {
                    out.push_str("+ ");
                    out.push_str(text);
                    out.push('\n');
                    emitted_lines += 1;
                }
                DiffLine::Del(text) => {
                    out.push_str("- ");
                    out.push_str(text);
                    out.push('\n');
                    emitted_lines += 1;
                }
                DiffLine::Same(_) => {}
            }
        }
    }
    if diff.truncated {
        out.push_str("…（单版超 2000 行预算，仅对比前 2000 行）\n");
    }
    Ok(out)
}

fn upstream_target_file_ids(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    focus_file_id: &str,
    revision_id: &str,
) -> Result<Vec<String>, GuanlanError> {
    let mut stmt = conn
        .prepare(
            "SELECT e.target_file_id, e.kind FROM edges e
             JOIN revisions r ON r.revision_id = e.source_revision_id
             WHERE r.workspace_id = ? AND e.source_file_id = ? AND e.source_revision_id = ?
             ORDER BY CASE e.kind
                WHEN 'derived_from_context' THEN 0
                WHEN 'decision_basis' THEN 1
                ELSE 2 END, e.target_file_id ASC",
        )
        .map_err(internal_sql)?;
    let rows = stmt
        .query_map(params![workspace_id, focus_file_id, revision_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(internal_sql)?;
    let mut out = Vec::new();
    for row in rows {
        let target = row.map_err(internal_sql)?;
        if target.starts_with("unresolved:") || target == focus_file_id || out.contains(&target) {
            continue;
        }
        out.push(target);
    }
    Ok(out)
}

fn collect_upstream_snippets(
    store: &ReadonlyStore,
    conn: &rusqlite::Connection,
    workspace_id: &str,
    view: &WorkspaceView,
    selected: &[(String, ContextGranularity)],
    request: &ContextRequest,
) -> Result<(Vec<UpstreamReferenceSnippet>, usize), GuanlanError> {
    let mut source_revs: Vec<(String, String)> = Vec::new();
    if let Some(focus) = &request.focus_file_id {
        if let Some(meta) = view.files.get(focus) {
            if let Some(rev) = &meta.last_revision_id {
                source_revs.push((focus.clone(), rev.clone()));
            }
        }
    }
    for (fid, _) in selected {
        if source_revs.iter().any(|(id, _)| id == fid) {
            continue;
        }
        if let Some(meta) = view.files.get(fid) {
            if let Some(rev) = &meta.last_revision_id {
                source_revs.push((fid.clone(), rev.clone()));
            }
        }
    }
    if source_revs.is_empty() {
        return Ok((Vec::new(), 0));
    }

    let mut stmt = conn
        .prepare(
            "SELECT e.source_file_id, e.target_file_id, e.kind, e.reason FROM edges e
             JOIN revisions r ON r.revision_id = e.source_revision_id
             WHERE r.workspace_id = ? AND e.source_file_id = ? AND e.source_revision_id = ?",
        )
        .map_err(internal_sql)?;

    let mut candidates: Vec<(u8, String, String, String, String)> = Vec::new();
    let mut seen_targets: Vec<String> = Vec::new();
    for (src_id, rev_id) in &source_revs {
        let rows = stmt
            .query_map(params![workspace_id, src_id, rev_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(internal_sql)?;
        for row in rows {
            let (_s, target_id, rel_type, reason) = row.map_err(internal_sql)?;
            if target_id.starts_with("unresolved:")
                || request.focus_file_id.as_deref() == Some(target_id.as_str())
                || seen_targets.contains(&target_id)
            {
                continue;
            }
            let Some(meta) = view.files.get(&target_id) else {
                continue;
            };
            if meta.status != "active" || is_sensitive_secret_path(&meta.path) {
                continue;
            }
            seen_targets.push(target_id.clone());
            let lower = format!("{} {}", meta.path.to_lowercase(), meta.title.to_lowercase());
            let is_norm = lower.contains("规范")
                || lower.contains("标准")
                || lower.contains("架构")
                || lower.contains("契约")
                || lower.contains("spec")
                || lower.contains("prd")
                || lower.contains("contract")
                || lower.contains("readme");
            let rank = if is_norm {
                4
            } else if rel_type == "derived_from_context" {
                3
            } else if rel_type == "decision_basis" {
                2
            } else {
                1
            };
            candidates.push((rank, meta.path.clone(), target_id, rel_type, reason));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let mut out = Vec::new();
    let mut redacted_total = 0usize;
    for (_, _, target_id, rel_type, reason) in candidates.into_iter().take(UPSTREAM_SNIPPET_CAP) {
        let Some(meta) = view.files.get(&target_id) else {
            continue;
        };
        let rev_id = meta.last_revision_id.clone();
        let content_hash = rev_id
            .as_deref()
            .and_then(|rev| lookup_revision_hash(conn, rev));
        let version_label = rev_id
            .as_deref()
            .and_then(|id| id.rsplit("_r").next())
            .and_then(|s| s.parse::<i64>().ok())
            .map(|seq| format!("v{seq}"));
        let raw_text = read_snapshot_text(store, rev_id.as_deref())?;
        let excerpt_raw = summary_text(&raw_text);
        let truncated_raw: String = excerpt_raw
            .chars()
            .take(UPSTREAM_SNIPPET_MAX_CHARS)
            .collect();
        let (snippet, hits) = sanitize_context_text(truncated_raw.trim());
        redacted_total += hits;
        if snippet.is_empty() {
            continue;
        }
        let est_chars = snippet.chars().count() as u64;
        let est_tokens = estimate_tokens(&snippet);
        out.push(UpstreamReferenceSnippet {
            file_id: target_id,
            path: meta.path.clone(),
            title: meta.title.clone(),
            version_label,
            content_hash,
            relation_type: rel_type,
            reason,
            snippet,
            est_chars,
            est_tokens,
        });
    }
    Ok((out, redacted_total))
}

/// 停机红线护栏：判定路径是否属于本机密钥/环境变量敏感文件（绝不自动装入上下文包）
pub fn is_sensitive_secret_path(path: &str) -> bool {
    let norm = path.replace('\\', "/").to_lowercase();
    let base = norm.rsplit('/').next().unwrap_or(&norm);
    if base == ".env"
        || (base.starts_with(".env.")
            && !base.ends_with(".example")
            && !base.ends_with(".sample")
            && !base.ends_with(".template"))
    {
        return true;
    }
    if matches!(
        base,
        ".npmrc"
            | ".pypirc"
            | ".netrc"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | "credentials.json"
            | "secrets.json"
            | "secrets.yaml"
            | "secrets.yml"
            | "secrets.toml"
            | "service-account.json"
    ) {
        return true;
    }
    if base.ends_with(".pem")
        || base.ends_with(".key")
        || base.ends_with(".p12")
        || base.ends_with(".pfx")
        || base.ends_with(".keystore")
    {
        return true;
    }
    norm.contains("/.ssh/")
        || norm.starts_with(".ssh/")
        || norm.contains("/.aws/")
        || norm.starts_with(".aws/")
}

/// 停机红线护栏：确定性密钥与环境变量凭证脱敏器（零正则 crate 依赖）。
/// 返回 `(脱敏后文本, 拦截次数)`；任何 PEM 私钥块、云厂商/模型 API Key、Bearer 令牌、
/// URL 内嵌密码、`.env`/YAML/JSON 中的敏感键值行一律替换为 `[REDACTED_SECRET]`。
pub fn sanitize_context_text(input: &str) -> (String, usize) {
    if input.is_empty() {
        return (String::new(), 0);
    }
    let mut hits = 0usize;
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_pem_block = false;

    for raw_line in input.split('\n') {
        let trimmed = raw_line.trim();
        if in_pem_block {
            if trimmed.starts_with("-----END ") && trimmed.contains("PRIVATE KEY-----") {
                in_pem_block = false;
            }
            continue;
        }
        if trimmed.starts_with("-----BEGIN ") && trimmed.contains("PRIVATE KEY-----") {
            in_pem_block = true;
            hits += 1;
            out_lines.push(REDACTED_SECRET_MARKER.to_owned());
            continue;
        }
        let (mut line, line_hits) = redact_sensitive_kv_line(raw_line);
        hits += line_hits;
        let (line2, url_hits) = redact_url_credentials(&line);
        line = line2;
        hits += url_hits;
        let (line3, tok_hits) = redact_known_secret_tokens(&line);
        line = line3;
        hits += tok_hits;
        out_lines.push(line);
    }
    (out_lines.join("\n"), hits)
}

fn is_sensitive_env_key(raw_key: &str) -> bool {
    let key = raw_key
        .trim()
        .trim_start_matches("export ")
        .trim_start_matches("set ")
        .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '-' || c == '*' || c == ' ')
        .to_ascii_uppercase();
    if key.is_empty() || key.len() > 64 {
        return false;
    }
    if !key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
    {
        return false;
    }
    const SENSITIVE_FRAGMENTS: &[&str] = &[
        "API_KEY",
        "APIKEY",
        "API_SECRET",
        "ACCESS_KEY",
        "SECRET_KEY",
        "PRIVATE_KEY",
        "AUTH_TOKEN",
        "ACCESS_TOKEN",
        "REFRESH_TOKEN",
        "CLIENT_SECRET",
        "BEARER_TOKEN",
        "BOT_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "NPM_TOKEN",
        "OPENAI_KEY",
        "ANTHROPIC_KEY",
        "PASSWORD",
        "PASSWD",
        "DB_PASS",
        "CREDENTIAL",
        "SIGNING_SECRET",
        "WEBHOOK_SECRET",
        "ENCRYPTION_KEY",
        "MASTER_KEY",
    ];
    if SENSITIVE_FRAGMENTS.iter().any(|frag| key.contains(frag)) {
        return true;
    }
    key.ends_with("_SECRET") || key.ends_with("_TOKEN") || key == "SECRET" || key == "TOKEN"
}

fn is_placeholder_value(val: &str) -> bool {
    let v = val
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == ',' || c == ';')
        .trim();
    if v.is_empty() {
        return true;
    }
    let lower = v.to_ascii_lowercase();
    v == REDACTED_SECRET_MARKER
        || v.chars()
            .all(|c| c == '_' || c == '*' || c == 'x' || c == 'X' || c == '·' || c == '.')
        || lower.starts_with("<your")
        || lower.starts_with("${")
        || lower.starts_with("$env:")
        || matches!(
            lower.as_str(),
            "null"
                | "none"
                | "false"
                | "true"
                | "changeme"
                | "example"
                | "placeholder"
                | "todo"
                | "redacted"
        )
}

fn redact_sensitive_kv_line(line: &str) -> (String, usize) {
    for sep in ['=', ':'] {
        if let Some(pos) = line.find(sep) {
            let left = &line[..pos];
            let right = &line[pos + 1..];
            // 避免把 URL 的 `https://` 误判为 YAML key: value
            if sep == ':' && right.starts_with("//") {
                continue;
            }
            if !is_sensitive_env_key(left) {
                continue;
            }
            let trimmed_right = right.trim();
            if is_placeholder_value(trimmed_right) {
                return (line.to_owned(), 0);
            }
            let trailing_comma = if trimmed_right.ends_with(',') {
                ","
            } else {
                ""
            };
            let quoted = trimmed_right.starts_with('"') || trimmed_right.starts_with('\'');
            let spacer = if right.starts_with(' ') { " " } else { "" };
            let replacement = if quoted {
                format!("{left}{sep}{spacer}\"{REDACTED_SECRET_MARKER}\"{trailing_comma}")
            } else {
                format!("{left}{sep}{spacer}{REDACTED_SECRET_MARKER}{trailing_comma}")
            };
            return (replacement, 1);
        }
    }
    (line.to_owned(), 0)
}

fn redact_url_credentials(line: &str) -> (String, usize) {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    let mut hits = 0usize;
    while let Some(scheme_pos) = rest.find("://") {
        let after_scheme = &rest[scheme_pos + 3..];
        let end_of_authority = after_scheme
            .find(['/', ' ', '\t', '"', '\'', ')', ']'])
            .unwrap_or(after_scheme.len());
        let authority = &after_scheme[..end_of_authority];
        if let Some(at_pos) = authority.rfind('@') {
            let userinfo = &authority[..at_pos];
            if let Some(colon_pos) = userinfo.find(':') {
                let pass = &userinfo[colon_pos + 1..];
                if !pass.is_empty() && pass != REDACTED_SECRET_MARKER {
                    out.push_str(&rest[..scheme_pos + 3]);
                    out.push_str(&userinfo[..colon_pos + 1]);
                    out.push_str(REDACTED_SECRET_MARKER);
                    out.push_str(&authority[at_pos..]);
                    rest = &after_scheme[end_of_authority..];
                    hits += 1;
                    continue;
                }
            }
        }
        out.push_str(&rest[..scheme_pos + 3]);
        rest = after_scheme;
    }
    out.push_str(rest);
    (out, hits)
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+' | b'/' | b'=')
}

fn redact_known_secret_tokens(line: &str) -> (String, usize) {
    const PREFIXES: &[(&str, usize)] = &[
        ("github_pat_", 20),
        ("sk-ant-", 16),
        ("sk-proj-", 16),
        ("sk-live-", 16),
        ("sk-", 20),
        ("ghp_", 20),
        ("gho_", 20),
        ("ghu_", 20),
        ("ghs_", 20),
        ("glpat-", 16),
        ("xoxb-", 12),
        ("xoxp-", 12),
        ("xoxa-", 12),
        ("xoxr-", 12),
        ("xoxs-", 12),
        ("AIza", 20),
        ("AKIA", 16),
        ("ASIA", 16),
    ];

    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    let mut hits = 0usize;
    while i < bytes.len() {
        if line[i..].starts_with("Bearer ") {
            let tok_start = i + "Bearer ".len();
            let mut tok_end = tok_start;
            while tok_end < bytes.len() && is_token_char(bytes[tok_end]) {
                tok_end += 1;
            }
            let tok = &line[tok_start..tok_end];
            if tok.len() >= 16 && tok != REDACTED_SECRET_MARKER {
                out.push_str("Bearer ");
                out.push_str(REDACTED_SECRET_MARKER);
                i = tok_end;
                hits += 1;
                continue;
            }
        }
        let mut matched = false;
        let boundary_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if boundary_ok {
            for (prefix, min_tail) in PREFIXES {
                if line[i..].starts_with(prefix) {
                    let tail_start = i + prefix.len();
                    let mut end = tail_start;
                    while end < bytes.len() && is_token_char(bytes[end]) {
                        end += 1;
                    }
                    if end - tail_start >= *min_tail {
                        out.push_str(REDACTED_SECRET_MARKER);
                        i = end;
                        hits += 1;
                        matched = true;
                        break;
                    }
                }
            }
        }
        if !matched {
            let ch = line[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    (out, hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e03_sanitize_context_text_redacts_keys_env_urls_and_pem_without_false_positives() {
        let sample = "\
# 架构说明\n\
正常文本：使用 sha256:0123456789abcdef 校验文件，非密钥。\n\
OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456\n\
export GITHUB_TOKEN=ghp_1234567890abcdefghij1234567890abcd\n\
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig\n\
DATABASE_URL=postgres://admin:SuperSecretPass99@db.internal:5432/prod\n\
aws_key: AKIAIOSFODNN7EXAMPLE\n\
-----BEGIN RSA PRIVATE KEY-----\n\
MIIEpAIBAAKCAQEA1234567890abcdef\n\
-----END RSA PRIVATE KEY-----\n\
API_KEY=<your-api-key>\n";
        let (clean, hits) = sanitize_context_text(sample);
        assert!(
            hits >= 6,
            "应拦截全部 6 处真实密钥，实际 hits={hits}\n{clean}"
        );
        assert!(!clean.contains("sk-proj-AbCdEf"));
        assert!(!clean.contains("ghp_1234567890"));
        assert!(!clean.contains("eyJhbGciOiJIUzI1Ni"));
        assert!(!clean.contains("SuperSecretPass99"));
        assert!(!clean.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(!clean.contains("MIIEpAIBAAKCAQEA"));
        assert!(
            clean.contains("sha256:0123456789abcdef"),
            "普通哈希不得误杀"
        );
        assert!(clean.contains("API_KEY=<your-api-key>"), "占位符允许保留");
        assert!(clean.contains(REDACTED_SECRET_MARKER));
    }

    #[test]
    fn e03_sensitive_secret_paths_are_blocked_while_templates_and_docs_pass() {
        assert!(is_sensitive_secret_path(".env"));
        assert!(is_sensitive_secret_path("config/.env.local"));
        assert!(is_sensitive_secret_path("certs/prod.pem"));
        assert!(is_sensitive_secret_path("secrets/server.key"));
        assert!(is_sensitive_secret_path(".ssh/id_ed25519"));
        assert!(!is_sensitive_secret_path(".env.example"));
        assert!(!is_sensitive_secret_path("docs/01-架构规范.md"));
        assert!(!is_sensitive_secret_path("04-智能体代码/PLAN.md"));
    }

    #[test]
    fn e03_granularity_parse_covers_all_five_modes() {
        assert_eq!(
            ContextGranularity::parse("full"),
            Some(ContextGranularity::Full)
        );
        assert_eq!(
            ContextGranularity::parse("summary"),
            Some(ContextGranularity::Summary)
        );
        assert_eq!(
            ContextGranularity::parse("diff_only"),
            Some(ContextGranularity::DiffOnly)
        );
        assert_eq!(
            ContextGranularity::parse("metadata_only"),
            Some(ContextGranularity::MetadataOnly)
        );
        assert_eq!(
            ContextGranularity::parse("decisions_only"),
            Some(ContextGranularity::DecisionsOnly)
        );
        assert_eq!(ContextGranularity::parse("unknown"), None);
    }
}
