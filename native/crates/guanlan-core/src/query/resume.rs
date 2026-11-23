//! PRD v2.0 §3.2 恢复机制：最近 SUCCESS checkpoint 的增量变更（Delta）与
//! 最新决策结果装配（GET /api/v1/initiatives/{id}/resume-context）。
//!
//! 边界（与 PRD 字面缺口登记一致）：引擎不组装/注入外部 Agent 的 Prompt，
//! 只输出可直接注入的恢复上下文文本 + 结构化字段；实际注入与编排属外部智能体。
//!
//! 数据源（只读 SQL，单读事务）：
//! - 最近 SUCCESS checkpoint（可按 stage 过滤，created_at/rowid 倒序取首条）；
//! - 自 checkpoint.created_at 之后产生新版本的文件（artifact_states 限定专项；
//!   每文件取最新一版）；
//! - 该专项每个 decision_id 的主陈述（与 decisions.rs 同口径：来源文件最新版本
//!   观察时间 → 陈述观察时间 → 行号）。

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};

use crate::dto::{ResumeCheckpoint, ResumeContextResponse, ResumeDecision, ResumeDeltaFile};
use crate::error::GuanlanError;
use crate::query::longtasks::statement_priority;
use crate::storage::{checkpoint_row, internal_sql, ReadonlyStore};

/// 恢复上下文：最近成功快照 + 增量文件 + 最新决策。
///
/// `stage` 缺省时取该专项最近一次 SUCCESS（任意阶段）；给定时只取该阶段。
/// 无 SUCCESS checkpoint 时 checkpoint=null、delta 为空，但仍返回最新决策，
/// prompt_context 明确「无可用 checkpoint」，不伪造增量。
pub fn resume_context(
    store: &ReadonlyStore,
    workspace_id: &str,
    initiative_id: &str,
    stage: Option<&str>,
) -> Result<ResumeContextResponse, GuanlanError> {
    let ws = store.workspace()?;
    if store.schema_version()? < 2 {
        // v0/v1 库：长任务表尚未建出；如实返回空恢复上下文，不报「无此表」。
        let prompt_context = render_prompt(initiative_id, None, &[], &[]);
        return Ok(ResumeContextResponse {
            ok: true,
            index_generation: ws.index_generation,
            initiative_id: initiative_id.to_owned(),
            checkpoint: None,
            delta: Vec::new(),
            latest_decisions: Vec::new(),
            prompt_context,
        });
    }
    store.read_txn(|conn| {
        let initiative_exists: Option<String> = conn
            .query_row(
                "SELECT initiative_id FROM initiatives WHERE workspace_id = ? AND initiative_id = ?",
                params![workspace_id, initiative_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(internal_sql)?;
        if initiative_exists.is_none() {
            return Err(GuanlanError::NotFound(format!(
                "未找到专项 {initiative_id}"
            )));
        }

        let checkpoint_row_value = conn
            .query_row(
                "SELECT * FROM checkpoints
                 WHERE workspace_id = ? AND initiative_id = ? AND status = 'SUCCESS'
                   AND (? IS NULL OR stage = ?)
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![workspace_id, initiative_id, stage, stage],
                checkpoint_row,
            )
            .optional()
            .map_err(internal_sql)?;

        let output_artifact_version = checkpoint_row_value
            .as_ref()
            .and_then(|row| row.output_revision_id.as_deref())
            .and_then(|revision_id| {
                conn.query_row(
                    "SELECT seq FROM revisions WHERE revision_id = ?",
                    params![revision_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .ok()
                .flatten()
            })
            .map(|seq| format!("v{seq}"));

        let checkpoint = checkpoint_row_value.as_ref().map(|row| ResumeCheckpoint {
            checkpoint_id: row.checkpoint_id.clone(),
            stage: row.stage.clone(),
            output_revision_id: row.output_revision_id.clone(),
            output_artifact_version: output_artifact_version.clone(),
            created_at: row.created_at.clone(),
        });

        let delta = if let Some(row) = &checkpoint_row_value {
            let mut stmt = conn
                .prepare(
                    "SELECT f.file_id, f.current_path, f.title, r.revision_id, r.seq, r.observed_at
                     FROM revisions r
                     JOIN files f ON f.file_id = r.file_id AND f.workspace_id = r.workspace_id
                     JOIN artifact_states a ON a.file_id = f.file_id AND a.workspace_id = f.workspace_id
                     WHERE f.workspace_id = ? AND a.initiative_id = ? AND r.observed_at > ?
                     ORDER BY r.observed_at ASC, r.seq ASC",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![workspace_id, initiative_id, row.created_at], |row| {
                    Ok(ResumeDeltaFile {
                        file_id: row.get(0)?,
                        path: row.get(1)?,
                        title: row.get(2)?,
                        revision_id: row.get(3)?,
                        version: format!("v{}", row.get::<_, i64>(4)?),
                        observed_at: row.get(5)?,
                    })
                })
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?;
            // 同一文件 checkpoint 后可能有多版：按文件去重，保留最新一版（行按时间升序）。
            let mut by_file: HashMap<String, ResumeDeltaFile> = HashMap::new();
            for row in rows {
                by_file.insert(row.file_id.clone(), row);
            }
            let mut delta: Vec<ResumeDeltaFile> = by_file.into_values().collect();
            delta.sort_by(|a, b| a.path.cmp(&b.path));
            delta
        } else {
            Vec::new()
        };

        let mut stmt = conn
            .prepare(
                "SELECT decision_id, code, question, status, quote, file_id, current_path,
                        line_start, line_end, detail_json, observed_at
                 FROM (
                   SELECT s.decision_id, s.code, s.question, s.status, s.quote, s.file_id,
                          f.current_path, s.line_start, s.line_end, s.detail_json, s.observed_at,
                          ROW_NUMBER() OVER (
                            PARTITION BY s.decision_id
                            ORDER BY COALESCE(r.observed_at, s.observed_at) DESC,
                                     s.observed_at DESC, s.line_start ASC
                          ) AS _rn
                   FROM statements s
                   LEFT JOIN revisions r ON r.revision_id = s.revision_id
                   JOIN files f ON f.file_id = s.file_id AND f.workspace_id = s.workspace_id
                   JOIN artifact_states a ON a.file_id = f.file_id AND a.workspace_id = f.workspace_id
                   WHERE s.workspace_id = ? AND a.initiative_id = ?
                     AND s.decision_id IS NOT NULL
                 ) WHERE _rn = 1
                 ORDER BY observed_at DESC, code ASC
                 LIMIT 100",
            )
            .map_err(internal_sql)?;
        let latest_decisions = stmt
            .query_map(params![workspace_id, initiative_id], |row| {
                let detail_json: String = row.get(9)?;
                Ok(ResumeDecision {
                    decision_id: row.get(0)?,
                    code: row.get(1)?,
                    question: row.get(2)?,
                    status: row.get(3)?,
                    priority: statement_priority(&detail_json),
                    quote: row.get(4)?,
                    file_id: row.get(5)?,
                    path: row.get(6)?,
                    line_start: row.get(7)?,
                    line_end: row.get(8)?,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;

        let prompt_context = render_prompt(
            initiative_id,
            checkpoint.as_ref(),
            &delta,
            &latest_decisions,
        );

        Ok(ResumeContextResponse {
            ok: true,
            index_generation: ws.index_generation,
            initiative_id: initiative_id.to_owned(),
            checkpoint,
            delta,
            latest_decisions,
            prompt_context,
        })
    })
}

/// 恢复上下文文本（外部 Agent 可原样注入下一步 Prompt；引擎不做注入）。
fn render_prompt(
    initiative_id: &str,
    checkpoint: Option<&ResumeCheckpoint>,
    delta: &[ResumeDeltaFile],
    decisions: &[ResumeDecision],
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "<guanlan_resume_context initiative=\"{}\"",
        xml_attr(initiative_id)
    ));
    match checkpoint {
        Some(row) => {
            out.push_str(&format!(
                " checkpoint=\"{}\" stage=\"{}\"",
                xml_attr(&row.checkpoint_id),
                xml_attr(&row.stage)
            ));
        }
        None => out.push_str(" checkpoint=\"none\" stage=\"none\""),
    }
    out.push_str(">\n");

    out.push_str(&format!(
        "  <delta_since_checkpoint count=\"{}\">\n",
        delta.len()
    ));
    for file in delta {
        out.push_str(&format!(
            "    - [{}] {} ({})\n",
            file.version,
            xml_text(&file.path),
            xml_text(&file.observed_at)
        ));
    }
    out.push_str("  </delta_since_checkpoint>\n\n");

    out.push_str(&format!(
        "  <latest_decisions count=\"{}\">\n",
        decisions.len()
    ));
    for decision in decisions {
        let quote: String = xml_text(&decision.quote).chars().take(160).collect();
        out.push_str(&format!(
            "    - [{} - {}] {}（{}；{}#L{}）\n",
            xml_text(&decision.code),
            xml_text(&decision.status),
            xml_text(&decision.question),
            quote,
            xml_text(&decision.path),
            decision.line_start
        ));
    }
    out.push_str("  </latest_decisions>\n\n");

    out.push_str("  <instruction>\n");
    if checkpoint.is_some() {
        out.push_str(
            "    仅将以上增量变更与最新决策结果注入下一步 Prompt；不要重传全量历史上下文。\n",
        );
    } else {
        out.push_str(
            "    无可用 SUCCESS checkpoint；请从当前任务节点最新状态开始，仅注入以上最新决策结果。\n",
        );
    }
    out.push_str("  </instruction>\n");
    out.push_str("</guanlan_resume_context>\n");
    out
}

fn xml_attr(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
#[path = "resume_tests.rs"]
mod tests;
