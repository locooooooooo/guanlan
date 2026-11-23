//! 版本链分页、阅读器兼容视图与按版本内容定位（契约 §1.7/§1.8）。
//!
//! 行为准绳：server/project.ts（projectFileHistory :451-541、
//! readRevisionContent :543-570、toRevision :132-172）。
//!
//! 批次一决定（见返回说明）：按版本内容只**定位**快照路径，正文/原始字节由
//! guanlan-service 按路径流式返回（不整读大文件）；JSON 形状字段（raw_url 等）
//! 仍按契约 §1.8 由服务层拼装。

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

/// 文件头（project.ts:513-523）
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

/// 版本行摘要（project.ts:454-466 字段逐字保留；不下发 snapshot_path）
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

/// 事件覆盖四类（缺一不可，否则版本链天生不完整；project.ts:468-485）：
/// 1) subject_id = file_id（file 主体事件）
/// 2) revision_id 属于该文件（revision 主体事件）
/// 3) payload_json.file_id = file_id（决策事件：file_id 只在 payload）
/// 4) subject_id = 'path:' + current_path（read_error / read_recovered 以路径为主体）
pub(crate) fn events_of_file(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    file: &FileRow,
) -> Result<Vec<EventRow>, GuanlanError> {
    // issue #26：四路 OR 改为 UNION——每路各有匹配索引可走，不再对整个工作区
    // 逐条求值四路 OR；UNION 按 rowid 天然去重（seq 为 INTEGER PRIMARY KEY），
    // 外层 ORDER BY seq ASC 与既有历史顺序一致，四路来源全部保留。
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
/// issue #33：短读事务包装。
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

    // issue #24：精确总数首页 COUNT 一次，随游标携带给续页复用（不再每页重复
    // COUNT 整条版本链）；同代际内无写入（writer 每次 bump generation），总数不漂。
    // COUNT 而非 MAX(seq)：seq 空洞下仍准确（契约验收）。旧游标无 total 字段时
    // 回退现算（行为正确，只是不省）。
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

    // 版本链按 per-file seq 排序；seq 在 (file_id, seq) 唯一约束下无并列，
    // 键集只需 seq 比较（契约 §1.7 order：默认 seq_desc，时间机器 v3→v2→v1）
    let (cmp_op, dir) = match order {
        RevisionOrder::SeqAsc => (">", "ASC"),
        RevisionOrder::SeqDesc => ("<", "DESC"),
    };
    let mut clauses = vec!["file_id = ?".to_owned()];
    let mut params: Vec<Value> = vec![sql_text(file_id)];
    if let Some(c) = &cursor {
        // k 存 seq（字符串形态），s 存 revision_id（键集第二键，防御性保留）
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

    // include=events,statements,edges（契约 §1.7：文件级完整集合，首页一次带回）。
    // issue #24：只在首页携带——续页请求不再重复查询/传输整文件关联集合
    // （此前 Θ(V²/p) 的重复统计/传输主因）；客户端按首页取用的口径不变。
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

/// 阅读器兼容视图的版本行（project.ts:132-172 toRevision，camelCase 派生字段）。
/// issue #20：不再内联任何正文（此前对每个 SVG 版本读快照内联 svgSource）——
/// 单次响应不随版本数线性增长，正文一律经 §1.8 按版本端点单独取。
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
                // occurred_at.replace('T',' ').slice(0,19)：只替换第一个 T
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

/// 文件详情/阅读器兼容视图（契约 §1.7 末段）——issue #20 契约迁移后：
/// 只返回文件头 + 当前版（last_revision_id 命中优先，最高 seq 回退），
/// 不读完整版本链、不内联任何正文（SVG 也不再逐版本读取，正文一律经 §1.8
/// 按版本端点单独取）；附集合（events/statements/edges）限额 200 条作兼容
/// 退场策略。版本链独立分页走 §1.7 `/files/{id}/revisions`。
/// issue #33：短读事务包装。
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

    // 当前版：last_revision_id 命中优先，缺失/悬空回退最高 seq（与摘要投影同口径）
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
            // changedSectionsFromPrev 与摘要同源：只查当前版 modified 事件 payload
            let changed = changed_sections_of_revision(conn, &ws.workspace_id, &rev.revision_id);
            // issue #38：isRollback 不下发到版本行（信息挂在事件上），不再传占位参数
            vec![file_record_revision(rev, &file, changed.as_ref())]
        }
        None => Vec::new(),
    };

    // 附集合限额（兼容保留；应用内已迁移到 §1.7 分页通道，不再消费本端点附集合）
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

/// 当前版 modified 事件的 changed_sections（project.ts:102-114 同源，单版本口径）
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
/// issue #33：短读事务包装（只定位快照路径；文件 I/O 在事务外由服务层完成）。
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
        // 现状提示文案（workspace-plugin.ts:345），v1 码改名 SNAPSHOT_UNAVAILABLE
        return Err(GuanlanError::SnapshotUnavailable(
            "此版本正文已过保留期，仅保留版本元数据；可打开当前版本或查看其他仍可用的版本。"
                .to_owned(),
        ));
    }
    // issue #36：非法 hash 返回明确错误（此前按字节切片可能 panic）
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
        // 非 UTF-8 文本格式（PDF / 图片 / Office / 归档等）：raw_url 指向自身 v1 raw=1 流式路径
        raw_url: is_binary.then(|| {
            format!(
                "/api/v1/revisions/{}/content?raw=1",
                url_path_component(revision_id)
            )
        }),
        format,
        revision_id: rev.revision_id.clone(),
        // 正文不整读：UTF-8 文本格式由服务层按 snapshot_path 流式 utf-8 返回
        text: None,
        snapshot_path: (!is_binary || query.raw).then_some(snapshot_path),
        // issue #37：稳定 ETag 的来源（内容寻址）
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
