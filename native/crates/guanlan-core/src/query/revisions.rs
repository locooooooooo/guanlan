//! 版本链分页、阅读器兼容视图与按版本内容定位（契约 §1.7/§1.8）。
//!
//! 行为准绳：server/project.ts（projectFileHistory :451-541、
//! readRevisionContent :543-570、toRevision :132-172）。
//!
//! 职责边界：按版本内容只**定位**快照路径，正文/原始字节由 guanlan-service 按路径
//! 流式返回（不整读大文件）；JSON 形状字段（raw_url 等）按契约 §1.8 由服务层拼装。

use rusqlite::params_from_iter;
use rusqlite::types::Value;

use super::sql_text;

use crate::dto::{
    EdgeRef, FileDetailResponse, FileHistoryHeader, FileRecordRevision, FileRevisionsResponse,
    RevisionContentResponse, RevisionSummary, StatementRef,
};
use crate::error::GuanlanError;
use crate::query::cursor::{
    clamp_limit, cursor_stale_fingerprint, cursor_stale_snapshot, decode_key_cursor,
    encode_key_cursor, revisions_fingerprint, safe_json,
};
use crate::query::{FileRevisionsQuery, RevisionContentQuery, RevisionOrder};
use crate::storage::{
    edge_row, event_row, internal_sql, statement_row, EventRow, FileRow, ReadonlyStore, RevisionRow,
};

fn file_header(file: &FileRow) -> FileHistoryHeader {
    FileHistoryHeader {
        file_id: file.file_id.clone(),
        current_path: file.current_path.clone(),
        title: file.title.clone(),
        format: file.format.clone(),
        role: file.role.clone(),
        status: file.status.clone(),
        first_observed_at: file.first_observed_at.clone(),
        last_observed_at: file.last_observed_at.clone(),
        last_revision_id: file.last_revision_id.clone(),
    }
}

fn revision_summary(rev: &RevisionRow) -> RevisionSummary {
    RevisionSummary {
        revision_id: rev.revision_id.clone(),
        seq: rev.seq,
        prev_revision_id: rev.prev_revision_id.clone(),
        content_hash: rev.content_hash.clone(),
        size_bytes: rev.size_bytes,
        observed_at: rev.observed_at.clone(),
        occurred_at: rev.occurred_at.clone(),
        occurred_precision: rev.occurred_precision.clone(),
        occurred_source: rev.occurred_source.clone(),
        snapshot_available: rev.snapshot_available != 0,
    }
}

pub(crate) fn events_of_file(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    file: &FileRow,
) -> Result<Vec<EventRow>, GuanlanError> {
    let sql = "SELECT * FROM ( \
                 SELECT * FROM events WHERE workspace_id = ?1 AND subject_id = ?2 \
                 UNION \
                 SELECT e.* FROM revisions r CROSS JOIN events e \
                   WHERE r.file_id = ?2 AND e.revision_id = r.revision_id AND e.workspace_id = ?1 \
                 UNION \
                 SELECT * FROM events WHERE workspace_id = ?1 \
                   AND json_extract(payload_json,'$.file_id') = ?2 \
                 UNION \
                 SELECT * FROM events WHERE workspace_id = ?1 \
                   AND subject_id = 'path:' || (SELECT current_path FROM files WHERE file_id = ?2) \
               ) ORDER BY seq ASC";
    let mut stmt = conn.prepare(sql).map_err(internal_sql)?;
    let rows = stmt
        .query_map(
            params_from_iter([sql_text(workspace_id), sql_text(file.file_id.as_str())]),
            event_row,
        )
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    Ok(rows)
}

pub(crate) fn file_history_event(ev: &EventRow) -> crate::dto::FileHistoryEvent {
    crate::dto::FileHistoryEvent {
        seq: ev.seq,
        event_id: ev.event_id.clone(),
        kind: ev.kind.clone(),
        revision_id: ev.revision_id.clone(),
        occurred_at: ev.occurred_at.clone(),
        occurred_precision: ev.occurred_precision.clone(),
        occurred_source: ev.occurred_source.clone(),
        observed_at: ev.observed_at.clone(),
        headline: ev.headline.clone(),
        detail: ev.detail.clone(),
        payload: safe_json(&ev.payload_json),
    }
}

pub(crate) fn statements_of_file(
    conn: &rusqlite::Connection,
    file_id: &str,
) -> Result<Vec<StatementRef>, GuanlanError> {
    let sql = "SELECT * FROM statements WHERE file_id = ? ORDER BY revision_id, line_start";
    let mut stmt = conn.prepare(sql).map_err(internal_sql)?;
    let rows = stmt
        .query_map([file_id], statement_row)
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    Ok(rows
        .iter()
        .map(|s| StatementRef {
            statement_id: s.statement_id.clone(),
            revision_id: s.revision_id.clone(),
            code: s.code.clone(),
            question: s.question.clone(),
            status: s.status.clone(),
            line_start: s.line_start,
            line_end: s.line_end,
            decision_id: s.decision_id.clone(),
        })
        .collect())
}

pub(crate) fn edges_of_file(
    conn: &rusqlite::Connection,
    file_id: &str,
) -> Result<Vec<EdgeRef>, GuanlanError> {
    let sql = "SELECT * FROM edges WHERE source_file_id = ?";
    let mut stmt = conn.prepare(sql).map_err(internal_sql)?;
    let rows = stmt
        .query_map([file_id], edge_row)
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    Ok(rows
        .iter()
        .map(|e| EdgeRef {
            edge_id: e.edge_id.clone(),
            source_revision_id: e.source_revision_id.clone(),
            target_file_id: e.target_file_id.clone(),
            target_revision_id: e.target_revision_id.clone(),
            resolution: e.resolution.clone(),
            locator_start: e.locator_start,
            reason: e.reason.clone(),
        })
        .collect())
}

/// 指定文件版本链分页（契约 §1.7：projectFileHistory 映射）
/// 使用短读事务包装。
pub fn file_revisions(
    store: &ReadonlyStore,
    file_id: &str,
    query: &FileRevisionsQuery,
) -> Result<FileRevisionsResponse, GuanlanError> {
    store.read_txn(|_conn| file_revisions_tx(store, file_id, query))
}

/// 事务内执行体（bootstrap 等已持有读事务的调用方直接用本函数，避免嵌套）。
pub fn file_revisions_tx(
    store: &ReadonlyStore,
    file_id: &str,
    query: &FileRevisionsQuery,
) -> Result<FileRevisionsResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let conn = store.conn();
    let file = store
        .file_by_id(file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {file_id}")))?;

    let limit = clamp_limit(query.limit, 50, 200);
    let order = query.order;
    let fp = revisions_fingerprint(order);
    let current_gen = ws.index_generation as i64;

    let cursor = match query.cursor.as_deref() {
        Some(raw) if !raw.is_empty() => Some(decode_key_cursor(raw)?),
        _ => None,
    };
    if let Some(c) = &cursor {
        if c.snap != current_gen {
            return Err(cursor_stale_snapshot());
        }
        if c.fp != fp {
            return Err(cursor_stale_fingerprint());
        }
    }
    let snapshot_generation = cursor.as_ref().map_or(current_gen, |c| c.snap) as u64;

    let total: i64 = match cursor.as_ref().and_then(|c| c.total) {
        Some(t) => t as i64,
        None => conn
            .query_row(
                "SELECT COUNT(*) AS n FROM revisions WHERE file_id = ?",
                [file_id],
                |r| r.get(0),
            )
            .map_err(internal_sql)?,
    };

    let (cmp_op, dir) = match order {
        RevisionOrder::SeqAsc => (">", "ASC"),
        RevisionOrder::SeqDesc => ("<", "DESC"),
    };
    let mut clauses = vec!["file_id = ?".to_owned()];
    let mut params: Vec<Value> = vec![sql_text(file_id)];
    if let Some(c) = &cursor {
        clauses.push(format!("seq {cmp_op} ?"));
        params.push(Value::from(c.k.parse::<i64>().map_err(|_| {
            GuanlanError::CursorStale("版本链游标不可解码，请从第一页重新查询。".to_owned())
        })?));
    }
    let sql = format!(
        "SELECT * FROM revisions WHERE {} ORDER BY seq {dir} LIMIT ?",
        clauses.join(" AND ")
    );
    params.push(Value::from((limit + 1) as i64));
    let mut stmt = conn.prepare(&sql).map_err(internal_sql)?;
    let mut revs: Vec<RevisionRow> = stmt
        .query_map(
            params_from_iter(params.iter()),
            crate::storage::revision_row,
        )
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    let has_more = revs.len() > limit as usize;
    if has_more {
        revs.truncate(limit as usize);
    }
    let next_cursor = has_more.then(|| {
        let last = revs.last().expect("has_more 时必有页尾行");
        encode_key_cursor(&crate::query::cursor::KeyCursor {
            snap: snapshot_generation as i64,
            k: last.seq.to_string(),
            s: last.revision_id.clone(),
            fp: fp.clone(),
            total: Some(total.max(0) as u64),
        })
    });

    let revisions: Vec<RevisionSummary> = revs.iter().map(revision_summary).collect();

    let first_page = cursor.is_none();
    let include = &query.include;
    let contains = |section| include.contains(&section);
    let events = if first_page && contains(crate::query::RevisionIncludeSection::Events) {
        Some(
            events_of_file(conn, &ws.workspace_id, &file)?
                .iter()
                .map(file_history_event)
                .collect(),
        )
    } else {
        None
    };
    let statements = if first_page && contains(crate::query::RevisionIncludeSection::Statements) {
        Some(statements_of_file(conn, file_id)?)
    } else {
        None
    };
    let edges = if first_page && contains(crate::query::RevisionIncludeSection::Edges) {
        Some(edges_of_file(conn, file_id)?)
    } else {
        None
    };
    let aliases = if first_page && contains(crate::query::RevisionIncludeSection::Aliases) {
        Some(store.path_aliases_for_file(file_id)?)
    } else {
        None
    };

    Ok(FileRevisionsResponse {
        ok: true,
        index_generation: ws.index_generation,
        file: file_header(&file),
        revisions,
        next_cursor,
        has_more,
        total: total.max(0) as u64,
        events,
        statements,
        edges,
        aliases,
    })
}

fn file_record_revision(
    rev: &RevisionRow,
    file: &FileRow,
    changed: Option<&Vec<String>>,
) -> FileRecordRevision {
    let mut summary_parts: Vec<String> = vec![format!("v{}", rev.seq)];
    match &rev.occurred_at {
        Some(occurred) => {
            if rev.occurred_precision == "day" {
                summary_parts.push(format!("{occurred}（原文记载）"));
            } else {
                let source_label = match rev.occurred_source.as_deref() {
                    Some("file_mtime") => "文件修改时间",
                    Some("document_self") => "文档自述",
                    _ => "采集",
                };
                let stamped: String = occurred.replacen('T', " ", 1).chars().take(19).collect();
                summary_parts.push(format!("{stamped}（{source_label}）"));
            }
        }
        None => summary_parts.push("日期待考".to_owned()),
    }
    summary_parts.push(format!("{:.1} KB", rev.size_bytes as f64 / 1024.0));
    if rev.snapshot_available == 0 {
        summary_parts.push("快照已过保留期".to_owned());
    }
    let summary_note = format!(
        "{}{}",
        summary_parts.join(" · "),
        if file.current_path.is_empty() {
            String::new()
        } else {
            format!(" · {}", file.current_path)
        }
    );

    FileRecordRevision {
        revision_id: rev.revision_id.clone(),
        file_id: rev.file_id.clone(),
        version_number: rev.seq,
        content_sha256: rev.content_hash.clone(),
        observed_at: rev.observed_at.clone(),
        source_time: rev.occurred_at.clone(),
        size_bytes: rev.size_bytes,
        snapshot_available: rev.snapshot_available != 0,
        is_baseline_protected: rev.seq == 1,
        svg_source: None,
        svg_extracted_texts: None,
        changed_sections_from_prev: changed.cloned(),
        summary_note,
    }
}

/// 文件详情/阅读器兼容视图（契约 §1.7 末段）：只返回文件头 + 当前版
/// （last_revision_id 命中优先，最高 seq 回退），不读完整版本链、不内联任何正文
/// （SVG 也不逐版本读取，正文一律经 §1.8 按版本端点单独取）；附集合
/// （events/statements/edges）限额 200 条作兼容退场策略。版本链独立分页走 §1.7
/// `/files/{id}/revisions`。使用短读事务包装。
pub fn file_detail(
    store: &ReadonlyStore,
    file_id: &str,
) -> Result<FileDetailResponse, GuanlanError> {
    store.read_txn(|_conn| file_detail_tx(store, file_id))
}

/// 事务内执行体（bootstrap 等已持有读事务的调用方直接用本函数，避免嵌套）。
pub fn file_detail_tx(
    store: &ReadonlyStore,
    file_id: &str,
) -> Result<FileDetailResponse, GuanlanError> {
    const COMPAT_SECTION_CAP: i64 = 200;
    let ws = store.workspace()?.clone();
    let conn = store.conn();
    let file = store
        .file_by_id(file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {file_id}")))?;

    let current = match file.last_revision_id.as_deref() {
        Some(last_id) => store.revision_by_id(last_id)?,
        None => None,
    };
    let current = match current {
        Some(rev) => Some(rev),
        None => {
            let mut stmt = conn
                .prepare("SELECT * FROM revisions WHERE file_id = ? ORDER BY seq DESC LIMIT 1")
                .map_err(internal_sql)?;
            match stmt.query_row([file_id], crate::storage::revision_row) {
                Ok(rev) => Some(rev),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(e) => return Err(internal_sql(e)),
            }
        }
    };

    let revisions: Vec<FileRecordRevision> = match &current {
        Some(rev) => {
            let changed = changed_sections_of_revision(conn, &ws.workspace_id, &rev.revision_id);
            vec![file_record_revision(rev, &file, changed.as_ref())]
        }
        None => Vec::new(),
    };

    let events_sql = "SELECT * FROM events \
               WHERE workspace_id = ? \
                 AND ( \
                   subject_id = ? \
                   OR revision_id IN (SELECT revision_id FROM revisions WHERE file_id = ?) \
                   OR json_extract(payload_json,'$.file_id') = ? \
                   OR subject_id = 'path:' || (SELECT current_path FROM files WHERE file_id = ?) \
                 ) \
               ORDER BY seq ASC LIMIT ?";
    let mut stmt = conn.prepare(events_sql).map_err(internal_sql)?;
    let event_rows = stmt
        .query_map(
            params_from_iter([
                sql_text(ws.workspace_id.as_str()),
                sql_text(file.file_id.as_str()),
                sql_text(file.file_id.as_str()),
                sql_text(file.file_id.as_str()),
                sql_text(file.file_id.as_str()),
                Value::from(COMPAT_SECTION_CAP),
            ]),
            event_row,
        )
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    let history_events = event_rows.iter().map(file_history_event).collect();

    let statements_sql = "SELECT * FROM statements WHERE file_id = ? LIMIT ?";
    let mut stmt = conn.prepare(statements_sql).map_err(internal_sql)?;
    let statement_rows = stmt
        .query_map(
            params_from_iter([sql_text(file_id), Value::from(COMPAT_SECTION_CAP)]),
            statement_row,
        )
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    let statements = statement_rows
        .iter()
        .map(|s| StatementRef {
            statement_id: s.statement_id.clone(),
            revision_id: s.revision_id.clone(),
            code: s.code.clone(),
            question: s.question.clone(),
            status: s.status.clone(),
            line_start: s.line_start,
            line_end: s.line_end,
            decision_id: s.decision_id.clone(),
        })
        .collect();

    let edges_sql = "SELECT * FROM edges WHERE source_file_id = ? LIMIT ?";
    let mut stmt = conn.prepare(edges_sql).map_err(internal_sql)?;
    let edge_rows = stmt
        .query_map(
            params_from_iter([sql_text(file_id), Value::from(COMPAT_SECTION_CAP)]),
            edge_row,
        )
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    let edges = edge_rows
        .iter()
        .map(|e| EdgeRef {
            edge_id: e.edge_id.clone(),
            source_revision_id: e.source_revision_id.clone(),
            target_file_id: e.target_file_id.clone(),
            target_revision_id: e.target_revision_id.clone(),
            resolution: e.resolution.clone(),
            locator_start: e.locator_start,
            reason: e.reason.clone(),
        })
        .collect();

    Ok(FileDetailResponse {
        ok: true,
        index_generation: ws.index_generation,
        file: file_header(&file),
        revisions,
        events: history_events,
        statements,
        edges,
    })
}

fn changed_sections_of_revision(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    revision_id: &str,
) -> Option<Vec<String>> {
    let sql = "SELECT payload_json FROM events \
               WHERE workspace_id = ? AND revision_id = ? ORDER BY seq ASC";
    let mut stmt = conn.prepare(sql).ok()?;
    let rows = stmt
        .query_map([sql_text(workspace_id), sql_text(revision_id)], |row| {
            row.get::<_, String>(0)
        })
        .ok()?
        .collect::<rusqlite::Result<Vec<_>>>()
        .ok()?;
    for payload_json in rows {
        let payload = safe_json(&payload_json);
        if let Some(sections) = payload.get("changed_sections").and_then(|v| v.as_array()) {
            let items: Vec<String> = sections
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            if !items.is_empty() {
                return Some(items);
            }
        }
    }
    None
}

/// 按版本读正文定位（契约 §1.8：仅按 revision_id 读取，不提供任意路径下载）。
/// 只定位快照路径；服务层按路径流式返回正文/原始字节（不整读大文件）。
/// 使用短读事务包装（只定位快照路径；文件 I/O 在事务外由服务层完成）。
pub fn revision_content(
    store: &ReadonlyStore,
    revision_id: &str,
    query: &RevisionContentQuery,
) -> Result<RevisionContentResponse, GuanlanError> {
    store.read_txn(|_conn| revision_content_tx(store, revision_id, query))
}

/// 事务内执行体（bootstrap 等已持有读事务的调用方直接用本函数，避免嵌套）。
pub fn revision_content_tx(
    store: &ReadonlyStore,
    revision_id: &str,
    query: &RevisionContentQuery,
) -> Result<RevisionContentResponse, GuanlanError> {
    let rev = store
        .revision_by_id(revision_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到该版本 {revision_id}")))?;
    if rev.snapshot_available == 0 {
        return Err(GuanlanError::SnapshotUnavailable(
            "此版本正文已过保留期，仅保留版本元数据；可打开当前版本或查看其他仍可用的版本。"
                .to_owned(),
        ));
    }
    let snapshot_path = store.blob_path_for(&rev.content_hash)?;
    if !snapshot_path.exists() {
        return Err(GuanlanError::SnapshotUnavailable(
            "此版本正文已过保留期，仅保留版本元数据；可打开当前版本或查看其他仍可用的版本。"
                .to_owned(),
        ));
    }
    let format = store
        .file_by_id(&rev.file_id)?
        .map(|f| f.format)
        .unwrap_or_else(|| "md".to_owned());
    let is_utf8_text = crate::index::file_format::FileFormat::parse(&format)
        .is_some_and(|parsed| parsed.is_utf8_text());
    let is_binary = !is_utf8_text;
    Ok(RevisionContentResponse {
        ok: true,
        raw_url: is_binary.then(|| {
            format!(
                "/api/v1/revisions/{}/content?raw=1",
                url_path_component(revision_id)
            )
        }),
        format,
        revision_id: rev.revision_id.clone(),
        text: None,
        snapshot_path: (!is_binary || query.raw).then_some(snapshot_path),
        content_hash: rev.content_hash.clone(),
    })
}

/// revision_id 的 URL 路径段百分号编码（RFC 3986 unreserved 之外全部转义）
pub(crate) fn url_path_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
#[path = "revisions_tests.rs"]
mod tests;
