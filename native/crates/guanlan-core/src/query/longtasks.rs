//! 长任务引擎只读查询：`statements`、`checkpoints`、`task_nodes`、`revision_drafts`、
//! `summary` 与 `archived` 主体检查。
//!
//! 全部只读 SQL（`contract-storage.md` §4 边界不变）；分页游标沿用
//! [`crate::query::cursor`] 的 base64url 偏移键游标（created_at+id 排序键）。

use rusqlite::params;

use crate::application::proposals::{
    draft_version_label, parse_context_hashes_json, MAX_DRAFT_PREVIEW_BYTES,
};
use crate::domain::sha256_hex;
use crate::dto::{
    CheckpointDetail, CheckpointsPage, DecisionsDigest, DraftContentResponse, DraftDetail,
    DraftsPage, OutlineEntry, StatementDetail, StatementsResponse, SummaryDetail, TaskNodeDetail,
    TasksResponse,
};
use crate::error::GuanlanError;
use crate::index::derive::parse_markdown_outline;
use crate::query::cursor;
use crate::storage::{checkpoint_row, internal_sql, task_node_row, ReadonlyStore};

/// `statements` 的 `status` wire 词映射（固定词表）：
/// `pending→'待确认'`、`confirmed→'已确认'`、`rejected→'已否决'`、`shelved→'已搁置'`、
/// `superseded→'已取代'`；其余或未传表示全部。
pub fn map_status_wire(raw: Option<&str>) -> Option<String> {
    match raw {
        Some("pending") => Some("待确认".to_owned()),
        Some("confirmed") => Some("已确认".to_owned()),
        Some("rejected") => Some("已否决".to_owned()),
        Some("shelved") => Some("已搁置".to_owned()),
        Some("superseded") => Some("已取代".to_owned()),
        _ => None,
    }
}

pub(crate) fn statement_priority(detail_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(detail_json)
        .ok()
        .and_then(|value| {
            value
                .get("priority")
                .and_then(|p| p.as_str())
                .map(str::to_owned)
        })
        .filter(|p| matches!(p.as_str(), "P0" | "P1" | "P2"))
        .unwrap_or_else(|| "P2".to_owned())
}

/// `GET /api/v1/statements`：`file_id` 必选、`status` 走 wire 词映射、
/// `limit` 默认 50 上限 200（与文件分页同口径）。
pub fn statements(
    store: &ReadonlyStore,
    file_id: &str,
    status_wire: Option<&str>,
    limit: Option<u32>,
) -> Result<StatementsResponse, GuanlanError> {
    let ws = store.workspace()?;
    let mapped = map_status_wire(status_wire);
    let limit = clamp(limit, 50, 200);
    store.read_txn(|conn| {
        let mut sql = "SELECT * FROM statements WHERE workspace_id = ? AND file_id = ?".to_owned();
        if mapped.is_some() {
            sql.push_str(" AND status = ?");
        }
        sql.push_str(" ORDER BY line_start ASC, code ASC LIMIT ?");
        let mut stmt = conn.prepare(&sql).map_err(internal_sql)?;
        let map = |row: &rusqlite::Row<'_>| {
            Ok((
                row.get::<_, String>("statement_id")?,
                row.get::<_, String>("revision_id")?,
                row.get::<_, String>("code")?,
                row.get::<_, String>("question")?,
                row.get::<_, String>("status")?,
                row.get::<_, i64>("line_start")?,
                row.get::<_, i64>("line_end")?,
                row.get::<_, Option<String>>("decision_id")?,
                row.get::<_, String>("detail_json")?,
            ))
        };
        let rows = if let Some(status) = &mapped {
            stmt.query_map(params![ws.workspace_id, file_id, status, limit], map)
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?
        } else {
            stmt.query_map(params![ws.workspace_id, file_id, limit], map)
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?
        };
        let items = rows
            .into_iter()
            .map(
                |(
                    statement_id,
                    revision_id,
                    code,
                    question,
                    status,
                    line_start,
                    line_end,
                    decision_id,
                    detail_json,
                )| {
                    let detail: serde_json::Value =
                        serde_json::from_str(&detail_json).unwrap_or(serde_json::Value::Null);
                    let get_list = |key: &str| -> Option<Vec<String>> {
                        detail.get(key).and_then(|v| v.as_array()).map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(str::to_owned))
                                .collect()
                        })
                    };
                    StatementDetail {
                        statement_id,
                        revision_id,
                        code,
                        question,
                        status,
                        line_start,
                        line_end,
                        decision_id,
                        options: get_list("options"),
                        recommendation: detail
                            .get("recommendation")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned),
                        impact_blocked: get_list("impactBlocked"),
                        impact_allowed: get_list("impactAllowed"),
                        confirmer_hint: detail
                            .get("confirmer")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty() && !is_placeholder(s))
                            .map(str::to_owned),
                    }
                },
            )
            .collect();
        Ok(StatementsResponse {
            ok: true,
            index_generation: ws.index_generation,
            items,
        })
    })
}

fn is_placeholder(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c == '_' || c == '…' || c == '—' || c == '－' || c == '·')
}

/// `GET /api/v1/checkpoints`：`initiative_id` 必选，`node_id`/`status` 可选过滤，
/// `created_at DESC` 排序（最近 SUCCESS 在前，便于恢复查询）。
pub fn checkpoints(
    store: &ReadonlyStore,
    initiative_id: &str,
    node_id: Option<&str>,
    status: Option<&str>,
    limit: Option<u32>,
) -> Result<CheckpointsPage, GuanlanError> {
    let ws = store.workspace()?;
    let limit = clamp(limit, 50, 200);
    store.read_txn(|conn| {
        let mut sql =
            "SELECT * FROM checkpoints WHERE workspace_id = ? AND initiative_id = ?".to_owned();
        if node_id.is_some() {
            sql.push_str(" AND node_id = ?");
        }
        if status.is_some() {
            sql.push_str(" AND status = ?");
        }
        sql.push_str(" ORDER BY created_at DESC, rowid DESC LIMIT ?");
        let mut stmt = conn.prepare(&sql).map_err(internal_sql)?;
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(ws.workspace_id.clone()),
            Box::new(initiative_id.to_owned()),
        ];
        if let Some(node_id) = node_id {
            values.push(Box::new(node_id.to_owned()));
        }
        if let Some(status) = status {
            values.push(Box::new(status.to_owned()));
        }
        values.push(Box::new(limit));
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values.iter()), checkpoint_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        let mut version_stmt = conn
            .prepare("SELECT seq FROM revisions WHERE revision_id = ?")
            .map_err(internal_sql)?;
        let version_of =
            |stmt: &mut rusqlite::Statement<'_>, revision_id: Option<&str>| -> Option<String> {
                revision_id.and_then(|id| {
                    stmt.query_row(params![id], |row| row.get::<_, i64>(0))
                        .ok()
                        .map(|seq| format!("v{seq}"))
                })
            };
        let items = rows
            .into_iter()
            .map(|row| {
                let output_artifact_version =
                    version_of(&mut version_stmt, row.output_revision_id.as_deref());
                CheckpointDetail {
                    checkpoint_id: row.checkpoint_id,
                    node_id: row.node_id,
                    initiative_id: row.initiative_id,
                    stage: row.stage,
                    status: row.status,
                    input_context_hash: row.input_context_hash,
                    output_revision_id: row.output_revision_id,
                    output_artifact_version,
                    token_usage: row.token_usage,
                    elapsed_ms: row.elapsed_ms,
                    note: row.note,
                    created_at: row.created_at,
                }
            })
            .collect();
        Ok(CheckpointsPage {
            ok: true,
            index_generation: ws.index_generation,
            items,
            next_cursor: None,
        })
    })
}

/// `GET /api/v1/initiatives/{initiative_id}/tasks`（五槽位 DAG）
pub fn task_nodes(
    store: &ReadonlyStore,
    initiative_id: &str,
) -> Result<TasksResponse, GuanlanError> {
    let ws = store.workspace()?;
    store.read_txn(|conn| {
        let rows = conn
            .prepare(
                "SELECT * FROM task_nodes WHERE workspace_id = ? AND initiative_id = ?
                 ORDER BY node_id ASC",
            )
            .map_err(internal_sql)?
            .query_map(params![ws.workspace_id, initiative_id], task_node_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        let nodes = rows
            .into_iter()
            .map(|row| {
                let depends: Vec<String> =
                    serde_json::from_str(&row.depends_json).unwrap_or_default();
                TaskNodeDetail {
                    node_id: row.node_id,
                    stage: row.stage,
                    node_kind: row.node_kind,
                    title: row.title,
                    state: row.state,
                    depends,
                    latest_checkpoint_id: row.latest_checkpoint_id,
                    error: row.error,
                }
            })
            .collect();
        Ok(TasksResponse {
            ok: true,
            index_generation: ws.index_generation,
            nodes,
        })
    })
}

/// `GET /api/v1/revision-proposals`（只读分页，`status` 过滤 + `created_at` 倒序）
pub fn revision_drafts(
    store: &ReadonlyStore,
    status: Option<&str>,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<DraftsPage, GuanlanError> {
    let ws = store.workspace()?;
    let limit = clamp(limit, 50, 200);
    let offset: i64 = cursor
        .map(cursor::decode_key_cursor_offset)
        .transpose()?
        .unwrap_or(0);
    store.read_txn(|conn| {
        let mut sql = "SELECT d.*, f.current_path AS path, COALESCE(r.seq, 0) AS base_seq
             FROM revision_drafts d
             LEFT JOIN files f ON f.file_id = d.file_id AND f.workspace_id = d.workspace_id
             LEFT JOIN revisions r ON r.revision_id = d.base_revision_id
             WHERE d.workspace_id = ?"
            .to_owned();
        if status.is_some() {
            sql.push_str(" AND d.status = ?");
        }
        sql.push_str(" ORDER BY d.created_at DESC, d.rowid DESC LIMIT ? OFFSET ?");
        let mut stmt = conn.prepare(&sql).map_err(internal_sql)?;
        let map = |row: &rusqlite::Row<'_>| {
            let base_seq: i64 = row.get::<_, i64>("base_seq").unwrap_or(0);
            let stored_label = row
                .get::<_, Option<String>>("draft_version_label")
                .ok()
                .flatten()
                .unwrap_or_default();
            let version_label = if stored_label.trim().is_empty() {
                draft_version_label(base_seq)
            } else {
                stored_label
            };
            let hashes_raw = row
                .get::<_, Option<String>>("input_context_hashes_json")
                .ok()
                .flatten()
                .unwrap_or_else(|| "[]".to_owned());
            let receipt_summary = row
                .get::<_, Option<String>>("receipt_summary")
                .ok()
                .flatten();
            Ok(DraftDetail {
                draft_id: row.get("draft_id")?,
                file_id: row.get("file_id")?,
                path: row.get::<_, Option<String>>("path")?.unwrap_or_default(),
                base_revision_id: row.get("base_revision_id")?,
                proposed_content_hash: row.get("proposed_content_hash")?,
                draft_version_label: version_label,
                input_context_hashes: parse_context_hashes_json(&hashes_raw),
                receipt_summary,
                source: row.get("source")?,
                status: row.get("status")?,
                conflict: row.get::<_, i64>("conflict")? != 0,
                note: row.get("note")?,
                created_at: row.get("created_at")?,
            })
        };
        let rows = if let Some(status) = status {
            stmt.query_map(params![ws.workspace_id, status, limit, offset], map)
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?
        } else {
            stmt.query_map(params![ws.workspace_id, limit, offset], map)
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?
        };
        let has_more = rows.len() as i64 == limit;
        let next_cursor = has_more
            .then(|| cursor::encode_key_cursor_offset((offset + limit) as u64))
            .flatten();
        Ok(DraftsPage {
            ok: true,
            index_generation: ws.index_generation,
            items: rows,
            next_cursor,
        })
    })
}

/// `GET /api/v1/revision-proposals/{draft_id}/content`（草案多模态 Diff 审阅只读载荷）
///
/// 在有界字节预算（2 MiB）内返回基准版、磁盘现态与 Agent 草案快照文本及实时 CAS 状态，
/// 供前端 ProposalToast / 审阅面板直接渲染多模态 Diff，绝不触碰磁盘原稿。
pub fn revision_draft_content(
    store: &ReadonlyStore,
    draft_id: &str,
) -> Result<DraftContentResponse, GuanlanError> {
    let ws = store.workspace()?;
    let (row, path, format, base_seq) = store.read_txn(|conn| {
        conn.prepare(
            "SELECT d.*, f.current_path AS path, COALESCE(f.format, 'md') AS format,
                    COALESCE(r.seq, 0) AS base_seq
             FROM revision_drafts d
             LEFT JOIN files f ON f.file_id = d.file_id AND f.workspace_id = d.workspace_id
             LEFT JOIN revisions r ON r.revision_id = d.base_revision_id
             WHERE d.workspace_id = ? AND d.draft_id = ?",
        )
        .map_err(internal_sql)?
        .query_row(params![ws.workspace_id, draft_id], |r| {
            Ok((
                crate::storage::revision_draft_row(r)?,
                r.get::<_, Option<String>>("path")?.unwrap_or_default(),
                r.get::<_, String>("format")?,
                r.get::<_, i64>("base_seq")?,
            ))
        })
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => {
                GuanlanError::NotFound(format!("未找到草案 {draft_id}"))
            }
            other => internal_sql(other),
        })
    })?;

    let mut truncated = false;
    let decode_bounded = |bytes: Vec<u8>, truncated: &mut bool| -> Option<String> {
        if bytes.len() > MAX_DRAFT_PREVIEW_BYTES {
            *truncated = true;
            return None;
        }
        Some(String::from_utf8_lossy(&bytes).into_owned())
    };

    let proposed_bytes = crate::storage::sandbox::resolve_existing_file_in_dir_jail(
        store.data_dir(),
        &row.snapshot_rel_path,
    )
    .ok()
    .and_then(|p| std::fs::read(p).ok())
    .or_else(|| {
        store
            .snapshot_path_for_hash(&row.proposed_content_hash)
            .ok()
            .and_then(|p| std::fs::read(p).ok())
    });
    let proposed_text = proposed_bytes.and_then(|b| decode_bounded(b, &mut truncated));

    let base_bytes = store
        .snapshot_path_for_hash(&row.base_content_hash)
        .ok()
        .and_then(|p| std::fs::read(p).ok());
    let base_text = base_bytes.and_then(|b| decode_bounded(b, &mut truncated));

    let disk_bytes = if path.is_empty() {
        None
    } else {
        crate::storage::sandbox::resolve_workspace_file_in_jail(&ws.root_path, &path)
            .ok()
            .and_then(|p| std::fs::read(p).ok())
    };
    let disk_content_hash = disk_bytes.as_deref().map(sha256_hex).unwrap_or_default();
    let disk_text = disk_bytes.and_then(|b| decode_bounded(b, &mut truncated));

    let live_conflict = row.conflict != 0
        || (!disk_content_hash.is_empty() && disk_content_hash != row.base_content_hash);
    let label = if row.draft_version_label.trim().is_empty() {
        draft_version_label(base_seq)
    } else {
        row.draft_version_label
    };

    Ok(DraftContentResponse {
        ok: true,
        index_generation: ws.index_generation,
        draft_id: row.draft_id,
        file_id: row.file_id,
        path,
        format,
        draft_version_label: label,
        base_revision_id: row.base_revision_id,
        base_content_hash: row.base_content_hash,
        disk_content_hash,
        proposed_content_hash: row.proposed_content_hash,
        source: row.source,
        status: row.status,
        conflict: live_conflict,
        note: row.note,
        receipt_summary: row.receipt_summary,
        input_context_hashes: parse_context_hashes_json(&row.input_context_hashes_json),
        base_text,
        disk_text,
        proposed_text,
        truncated,
        created_at: row.created_at,
    })
}

/// `GET /api/v1/summary/{file_id}`：该文件当前版本的 L4A 确定性摘要。
/// 只读已沉淀的 `summary_json`，未沉淀且后台任务排队/运行中时返回 `queued = true`。
pub fn file_summary(
    store: &ReadonlyStore,
    file_id: &str,
) -> Result<crate::dto::FileSummaryResponse, GuanlanError> {
    let ws = store.workspace()?;
    store.read_txn(|conn| {
        let file_meta: Option<(String, String)> = conn
            .prepare("SELECT last_revision_id, COALESCE((SELECT content_hash FROM revisions WHERE revision_id = files.last_revision_id), '') FROM files WHERE file_id = ?")
            .map_err(internal_sql)?
            .query_row(params![file_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, String>(1)?,
                ))
            })
            .ok();
        let (revision_id, content_hash) = file_meta.unwrap_or_default();

        let row = conn
            .prepare(
                "SELECT summary_json, state FROM summary_jobs
                 WHERE file_id = ? AND content_hash = ?
                 ORDER BY updated_at DESC, rowid DESC LIMIT 1",
            )
            .map_err(internal_sql)?
            .query_row(params![file_id, content_hash], |row| {
                Ok((
                    row.get::<_, Option<String>>("summary_json")?,
                    row.get::<_, String>("state")?,
                ))
            })
            .ok();
        let (summary_json, job_state) = row.unwrap_or((None, String::new()));
        let summary = summary_json
            .and_then(|json| serde_json::from_str::<SummaryDetail>(&json).ok());
        let queued = summary.is_none()
            && matches!(job_state.as_str(), "queued" | "running");
        Ok(crate::dto::FileSummaryResponse {
            ok: true,
            index_generation: ws.index_generation,
            file_id: file_id.to_owned(),
            revision_id: if revision_id.is_empty() { None } else { Some(revision_id) },
            content_hash: if content_hash.is_empty() { None } else { Some(content_hash) },
            summary,
            queued,
        })
    })
}

/// 主体 archived 检查（resolve/propose/checkpoint 命中已归档主体时同步返回 409）。
/// 按 file 查；无状态行或无专项归属视为未归档。
pub fn file_initiative_archived(
    store: &ReadonlyStore,
    file_id: &str,
) -> Result<bool, GuanlanError> {
    let ws = store.workspace()?;
    store.read_txn(|conn| {
        let state_row = conn
            .prepare("SELECT initiative_id FROM artifact_states WHERE file_id = ?")
            .map_err(internal_sql)?
            .query_row(params![file_id], |row| row.get::<_, Option<String>>(0))
            .ok();
        let Some(initiative_id) = state_row.flatten() else {
            return Ok(false);
        };
        let state: Option<String> = conn
            .prepare("SELECT state FROM initiatives WHERE workspace_id = ? AND initiative_id = ?")
            .map_err(internal_sql)?
            .query_row(params![ws.workspace_id, initiative_id], |row| row.get(0))
            .ok();
        Ok(state.as_deref() == Some("archived"))
    })
}

/// L4A 确定性摘要组装（本地离线确定性口径：`generated_by = "local_deterministic"`）。
/// core 大纲 = `parse_markdown_outline`（与 `derive.rs` 同源）；决策摘要按该版本陈述聚合。
pub fn build_summary_detail(
    content: &str,
    statements: &[crate::storage::StatementRow],
) -> SummaryDetail {
    let content_lines: Vec<&str> = content.split('\n').collect();
    let outline: Vec<OutlineEntry> = parse_markdown_outline(content)
        .into_iter()
        .take(50)
        .map(|(title, line)| {
            let level = content_lines
                .get(line.saturating_sub(1))
                .map(|raw| raw.trim_start().matches('#').count().max(1) as u32)
                .unwrap_or(1);
            OutlineEntry {
                level,
                title,
                line: line as i64,
            }
        })
        .collect();
    let mut digest = DecisionsDigest::default();
    let mut latest_by_decision: std::collections::HashMap<String, &crate::storage::StatementRow> =
        std::collections::HashMap::new();
    for statement in statements {
        let Some(decision_id) = statement.decision_id.as_deref() else {
            continue;
        };
        latest_by_decision
            .entry(decision_id.to_owned())
            .and_modify(|existing| {
                if statement.observed_at > existing.observed_at {
                    *existing = statement;
                }
            })
            .or_insert(statement);
    }
    for statement in latest_by_decision.values() {
        match statement.status.as_str() {
            "已确认" => digest.confirmed += 1,
            "待确认" => {
                digest.pending += 1;
                match statement_priority(&statement.detail_json).as_str() {
                    "P0" => digest.p0 += 1,
                    "P1" => digest.p1 += 1,
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let core = if outline.is_empty() {
        format!(
            "本文档共 {} 项已确认决定、{} 项未决事项（P0 {} / P1 {}）。",
            digest.confirmed, digest.pending, digest.p0, digest.p1
        )
    } else {
        let titles: Vec<String> = outline.iter().take(6).map(|e| e.title.clone()).collect();
        format!(
            "{}；共 {} 项已确认决定、{} 项未决事项（P0 {} / P1 {}）。",
            titles.join("、"),
            digest.confirmed,
            digest.pending,
            digest.p0,
            digest.p1
        )
    };
    SummaryDetail {
        core_summary: core,
        outline,
        decisions_digest: digest,
        generated_by: "local_deterministic".to_owned(),
        extract_rule_version: "l4a-v0.1.0".to_owned(),
    }
}

fn clamp(limit: Option<u32>, default: u32, max: u32) -> i64 {
    let value = limit.unwrap_or(default).min(max);
    i64::from(value).max(1)
}

/// 陈述速览（resolve 受理用：decision_id + archived 检查的 file_id）
pub struct StatementBrief {
    pub statement_id: String,
    pub file_id: String,
    pub decision_id: Option<String>,
}

/// 按 id 取陈述速览（读侧；不存在 → None）
pub fn statement_brief(
    store: &ReadonlyStore,
    statement_id: &str,
) -> Result<Option<StatementBrief>, GuanlanError> {
    store.read_txn(|conn| {
        conn.prepare("SELECT file_id, decision_id FROM statements WHERE statement_id = ?")
            .map_err(internal_sql)?
            .query_row(params![statement_id], |row| {
                Ok(StatementBrief {
                    statement_id: statement_id.to_owned(),
                    file_id: row.get(0)?,
                    decision_id: row.get(1)?,
                })
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(internal_sql(other)),
            })
    })
}

/// 专项状态（archived 守卫与 archive/reopen 受理检查）
pub fn initiative_state(
    store: &ReadonlyStore,
    initiative_id: &str,
) -> Result<Option<String>, GuanlanError> {
    let ws = store.workspace()?;
    store.read_txn(|conn| {
        conn.prepare("SELECT state FROM initiatives WHERE workspace_id = ? AND initiative_id = ?")
            .map_err(internal_sql)?
            .query_row(params![ws.workspace_id, initiative_id], |row| {
                row.get::<_, String>(0)
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(internal_sql(other)),
            })
    })
}

/// L4A 队列进度（`done`/`total`/`percent`，`total = 0` 时 `percent = 100`）
pub fn l4a_progress(store: &ReadonlyStore) -> Result<crate::dto::L4aProgress, GuanlanError> {
    if store.schema_version()? < 2 {
        return Ok(crate::dto::L4aProgress {
            done: 0,
            total: 0,
            percent: 100,
            queue_depth: 0,
        });
    }
    let ws = store.workspace()?;
    store.read_txn(|conn| {
        let (done, total, depth): (i64, i64, i64) = conn
            .query_row(
                "SELECT
                   COALESCE(SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END), 0),
                   COUNT(*),
                   COALESCE(SUM(CASE WHEN state IN ('queued','running') THEN 1 ELSE 0 END), 0)
                 FROM summary_jobs WHERE workspace_id = ?",
                params![ws.workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(internal_sql)?;
        let percent = if total == 0 {
            100u32
        } else {
            (((done.max(0) * 100) / total.max(1)).clamp(0, 100)) as u32
        };
        Ok(crate::dto::L4aProgress {
            done: done.max(0) as u32,
            total: total.max(0) as u32,
            percent,
            queue_depth: depth.max(0) as u32,
        })
    })
}

/// watcher 基线：**active** 文件的 (current_path, last_mtime_ms)——missing 文件
/// 不入基线（否则每轮误报变更，小时级 read_error 事件污染事件流；缺失检测
/// 由完整范围对账判定，契约 §5.4）。f64 读，REAL/INTEGER 双存储兼容。
pub fn watch_baseline(
    store: &ReadonlyStore,
) -> Result<std::collections::HashMap<String, f64>, GuanlanError> {
    let ws = store.workspace()?;
    store.read_txn(|conn| {
        let rows = conn
            .prepare("SELECT current_path, last_mtime_ms FROM files WHERE workspace_id = ? AND status = 'active'")
            .map_err(internal_sql)?
            .query_map(params![ws.workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows.into_iter().collect())
    })
}

/// 文件当前相对路径（HTTP 层 CAS 初判用；不存在返回 None）
pub fn file_current_path(store: &ReadonlyStore, file_id: &str) -> Option<String> {
    let ws = store.workspace().ok()?;
    store
        .read_txn(|conn| {
            conn.prepare("SELECT current_path FROM files WHERE workspace_id = ? AND file_id = ?")
                .map_err(internal_sql)?
                .query_row(params![ws.workspace_id, file_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(internal_sql)
        })
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{cleanup_dir, FixtureDb};

    #[test]
    fn status_wire_mapping() {
        assert_eq!(map_status_wire(Some("pending")).as_deref(), Some("待确认"));
        assert_eq!(
            map_status_wire(Some("confirmed")).as_deref(),
            Some("已确认")
        );
        assert_eq!(map_status_wire(Some("rejected")).as_deref(), Some("已否决"));
        assert_eq!(map_status_wire(Some("shelved")).as_deref(), Some("已搁置"));
        assert_eq!(
            map_status_wire(Some("superseded")).as_deref(),
            Some("已取代")
        );
        assert_eq!(map_status_wire(None), None);
        assert_eq!(map_status_wire(Some("全部")), None, "非词表值=全部");
    }

    #[test]
    fn statement_priority_defaults_to_p2() {
        assert_eq!(statement_priority(r#"{"priority":"P0"}"#), "P0");
        assert_eq!(statement_priority("{}"), "P2");
        assert_eq!(statement_priority("不是 JSON"), "P2");
    }

    #[test]
    fn build_summary_digest_counts() {
        let mut statement = sample_statement("已确认");
        statement.detail_json = r#"{"priority":"P1"}"#.to_owned();
        let confirmed = statement;
        let mut pending = sample_statement("待确认");
        pending.decision_id = Some("dec_b".to_owned());
        pending.detail_json = r#"{"priority":"P0"}"#.to_owned();
        let digest = build_summary_detail("# A\n## B\n", &[confirmed, pending]);
        assert_eq!(digest.decisions_digest.confirmed, 1);
        assert_eq!(digest.decisions_digest.pending, 1);
        assert_eq!(digest.decisions_digest.p0, 1);
        assert_eq!(digest.decisions_digest.p1, 0);
        assert_eq!(digest.outline.len(), 2);
        assert_eq!(digest.outline[1].level, 2);
        assert_eq!(digest.extract_rule_version, "l4a-v0.1.0");
    }

    fn sample_statement(status: &str) -> crate::storage::StatementRow {
        crate::storage::StatementRow {
            statement_id: format!("stmt_{}", stable_key_of(status)),
            workspace_id: "ws".to_owned(),
            file_id: "f".to_owned(),
            revision_id: "f_r1".to_owned(),
            code: "P1".to_owned(),
            namespace: "ns".to_owned(),
            question: "问题".to_owned(),
            status: status.to_owned(),
            quote: "原文".to_owned(),
            line_start: 1,
            line_end: 2,
            decision_id: Some("dec_a".to_owned()),
            detail_json: "{}".to_owned(),
            extract_rule_version: "v0.4.3".to_owned(),
            observed_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }
    }

    fn stable_key_of(input: &str) -> String {
        crate::index::ident::stable_key(input)
    }

    #[allow(dead_code)]
    fn unused(fixture: &FixtureDb) {
        let _ = fixture;
        cleanup_dir(&fixture.dir);
    }
}
