//! 决定列表与全量引用边（契约 §1.9/§1.10）。
//!
//! 行为准绳：server/project.ts（groupStatementsIntoDecisions :343-431、
//! relations 投影 :249-263）。
//! 归并规则逐字迁移：同一 decision_id 的陈述按「来源文件最新版本观察时间 →
//! 陈述观察时间 → 行号」取主陈述（不能跨文件比 per-file seq，project.ts:356-367）。
//! 排序：来源不一致 < 待确认 < 已确认 < 其他，再按编号（project.ts:428-429）。

use std::collections::HashMap;

use rusqlite::params_from_iter;
use rusqlite::types::Value;

use crate::dto::{
    DecisionAssertion, DecisionConfirmationBasis, DecisionSourceEvidence, DecisionsResponse,
    RelationEdge, RelationLocator, RelationsResponse,
};
use crate::error::GuanlanError;
use crate::query::cursor::{
    clamp_limit, cursor_stale_fingerprint, cursor_stale_snapshot, decisions_fingerprint,
    decode_key_cursor, encode_key_cursor, non_empty,
};
use crate::query::{sql_text, DecisionsQuery};
use crate::storage::{edge_row, internal_sql, statement_row, EdgeRow, ReadonlyStore, StatementRow};

/// 决策状态排序（project.ts:428）：来源不一致 0 < 待确认 1 < 已确认 2 < 其他 3
fn status_rank(status: &str) -> u8 {
    match status {
        "来源不一致" => 0,
        "待确认" => 1,
        "已确认" => 2,
        _ => 3,
    }
}

/// SQLite LIKE 的默认口径：ASCII 大小写无关的子串包含（question/namespace 的 q 筛选）
fn like_contains(hay: &str, needle: &str) -> bool {
    hay.to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

/// 决定列表（契约 §1.9）。游标语义按可变列表处理：游标绑定代际与筛选指纹，
/// 相关提交使游标失效 → CURSOR_STALE（契约 §0.2/§1.9）。
/// issue #33：短读事务包装——摘要与证据读取同一快照。
pub fn decisions(
    store: &ReadonlyStore,
    query: &DecisionsQuery,
) -> Result<DecisionsResponse, GuanlanError> {
    store.read_txn(|_conn| decisions_tx(store, query))
}

/// 事务内执行体（bootstrap 等已持有读事务的调用方直接用本函数，避免嵌套）。
pub fn decisions_tx(
    store: &ReadonlyStore,
    query: &DecisionsQuery,
) -> Result<DecisionsResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let conn = store.conn();
    let ws_id = ws.workspace_id.as_str();
    let limit = clamp_limit(query.limit, 100, 500);
    let fp = decisions_fingerprint(query);
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

    // issue #23：两级投影——先取「一行一决定」的摘要（SQL 窗口函数按
    // 「来源文件最新版本观察时间 → 陈述观察时间 → 行号」选主陈述，project.ts:356-367
    // 口径不变），筛选/排序/分页全部作用于摘要；只为本页决定构造完整证据
    // （页外/未命中决定不再装载 statements 全量、不复制 quote、不建全库版本映射）。
    let summary_sql = "SELECT decision_id, status, code, question, namespace, \
         CASE status WHEN '来源不一致' THEN 0 WHEN '待确认' THEN 1 WHEN '已确认' THEN 2 ELSE 3 END AS _rank, \
         _file_status \
       FROM ( \
         SELECT s.*, COALESCE(f.status, 'active') AS _file_status, ROW_NUMBER() OVER ( \
           PARTITION BY s.decision_id \
           ORDER BY COALESCE(r.observed_at, s.observed_at) DESC, s.observed_at DESC, s.line_start ASC \
         ) AS _rn \
         FROM statements s \
         LEFT JOIN files f ON f.file_id = s.file_id \
         LEFT JOIN revisions r ON r.revision_id = s.revision_id \
         WHERE s.workspace_id = ? AND s.decision_id IS NOT NULL \
       ) WHERE _rn = 1";
    let mut stmt = conn.prepare(summary_sql).map_err(internal_sql)?;
    let summaries: Vec<DecisionSummary> = stmt
        .query_map([ws_id], |row| {
            Ok(DecisionSummary {
                decision_id: row.get("decision_id")?,
                status: row.get("status")?,
                code: row.get("code")?,
                question: row.get("question")?,
                namespace: row.get("namespace")?,
                rank: row.get::<_, i64>("_rank")? as u8,
                file_active: row.get::<_, String>("_file_status")? == "active",
            })
        })
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;

    // 筛选（契约 §1.9：status 精确 / code 精确 / q 为 question·namespace LIKE，
    // like_contains 与 SQL LIKE 同为 ASCII 大小写无关包含——沿用 Rust 口径）
    let status_filter = non_empty(&query.status);
    let code_filter = non_empty(&query.code);
    let q_filter = non_empty(&query.q);
    let mut items: Vec<DecisionSummary> = summaries
        .into_iter()
        .filter(|d| {
            status_filter.is_none_or(|s| d.status == s)
                && code_filter.is_none_or(|c| d.code == c)
                && q_filter
                    .is_none_or(|q| like_contains(&d.question, q) || like_contains(&d.namespace, q))
        })
        .collect();

    // 排序：状态秩 → 编号（JS localeCompare 以字节序近似：编号为 ASCII 大写时恒等）
    items.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.code.cmp(&b.code))
            .then_with(|| a.decision_id.cmp(&b.decision_id))
    });

    // 键集分页（内存摘要列表）：排序键 (status_rank, code, decision_id)；
    // 游标 k 编码为 "{rank}|{code}"（游标不透明，前端不解析）
    let total = items.len() as u64;
    // V03 SSOT：与 query/projects.rs pending_decisions_count 同口径（活跃文件 ∧ 来源不一致|待确认），
    // 在分页截断前全量计数，彻底消除 288 vs 100 跨视图分裂
    let unresolved_total = items
        .iter()
        .filter(|d| d.file_active && d.rank <= 1)
        .count() as u64;
    let mut start = 0usize;
    if let Some(c) = &cursor {
        let (rank_str, code_str) = c.k.split_once('|').unwrap_or(("", ""));
        start = items
            .iter()
            .position(|d| {
                (
                    d.rank.to_string().as_str(),
                    d.code.as_str(),
                    d.decision_id.as_str(),
                ) > (rank_str, code_str, c.s.as_str())
            })
            .unwrap_or(items.len());
    }
    let page_summaries: Vec<DecisionSummary> =
        items.into_iter().skip(start).take(limit as usize).collect();
    let page_len = page_summaries.len();
    let has_more = start + page_len < total as usize;

    // 本页决定的完整证据：按 decision_id IN 取陈述（含历史陈述与 missing/缺行文件——
    // LEFT JOIN 保持证据不丢弃），revision 观察时间由关联子查询给出（不建全库映射）
    let decision_ids: Vec<&str> = page_summaries
        .iter()
        .map(|d| d.decision_id.as_str())
        .collect();
    let mut page_items: Vec<DecisionAssertion> = Vec::with_capacity(page_len);
    if !decision_ids.is_empty() {
        let evidence_sql = format!(
            "SELECT s.*, COALESCE(f.current_path, '') AS _path, \
                COALESCE((SELECT r.observed_at FROM revisions r WHERE r.revision_id = s.revision_id), s.observed_at) AS _rev_time \
             FROM statements s \
             LEFT JOIN files f ON f.file_id = s.file_id \
             WHERE s.workspace_id = ? AND s.decision_id IN ({})",
            vec!["?"; decision_ids.len()].join(",")
        );
        let mut evidence_params: Vec<Value> = vec![sql_text(ws_id)];
        evidence_params.extend(decision_ids.iter().map(|id| sql_text(*id)));
        let mut stmt = conn.prepare(&evidence_sql).map_err(internal_sql)?;
        let rows = stmt
            .query_map(params_from_iter(evidence_params.iter()), |row| {
                Ok(StatementMeta {
                    row: statement_row(row)?,
                    path: row.get::<_, Option<String>>("_path")?.unwrap_or_default(),
                    rev_time: row.get("_rev_time")?,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;

        // 按本页决定顺序归并（同一 decision_id 的全部陈述进同一组）
        let mut grouped: HashMap<String, Vec<StatementMeta>> = HashMap::new();
        for meta in rows {
            // SQL 已过滤 decision_id IS NOT NULL，此处按 Some 展开（防御性跳过 None）
            if let Some(decision_id) = meta.row.decision_id.clone() {
                grouped.entry(decision_id).or_default().push(meta);
            }
        }
        for summary in &page_summaries {
            let list = grouped
                .remove(summary.decision_id.as_str())
                .unwrap_or_default();
            page_items.push(build_decision(summary.decision_id.clone(), list));
        }
    }

    let next_cursor = has_more.then(|| {
        let last = page_items.last().expect("has_more 时页非空");
        encode_key_cursor(&crate::query::cursor::KeyCursor {
            snap: snapshot_generation as i64,
            k: format!("{}|{}", status_rank(&last.status), last.code),
            s: last.decision_id.clone(),
            fp: fp.clone(),
            // files/decisions 不使用 total（issue #24 仅版本链游标携带），序列化时省略
            total: None,
        })
    });

    Ok(DecisionsResponse {
        ok: true,
        index_generation: ws.index_generation,
        snapshot_generation,
        items: page_items,
        next_cursor,
        has_more,
        total,
        unresolved_total,
    })
}

/// 单个业务决定的归并投影（project.ts:355-425 逐字迁移）。
/// issue #23：只为本页决定调用；陈述携带关联好的来源路径与版本观察时间
/// （SQL 内联子查询），不再需要全库 file/revision 映射。
fn build_decision(decision_id: String, list: Vec<StatementMeta>) -> DecisionAssertion {
    // 以「来源文件最新版本」的陈述作为当前口径；同版本内按行号先后。
    // 跨文件比较新旧不能用 per-file seq：先比版本观察时间，同时间再比陈述观察
    // 时间，最后按行号（project.ts:356-367 注释）
    let mut sorted = list;
    sorted.sort_by(|a, b| {
        let t_a = a.rev_time.as_str();
        let t_b = b.rev_time.as_str();
        // 降序：tA < tB 则 a 排后（JS `tA < tB ? 1 : -1`）
        t_b.cmp(t_a)
            .then_with(|| b.row.observed_at.cmp(&a.row.observed_at))
            // 行号升序（JS `a.line_start - b.line_start`）
            .then_with(|| a.row.line_start.cmp(&b.row.line_start))
    });
    let primary = &sorted[0].row;

    let detail: serde_json::Value = serde_json::from_str(if primary.detail_json.is_empty() {
        "{}"
    } else {
        &primary.detail_json
    })
    .unwrap_or_else(|_| serde_json::json!({}));
    let get_str = |key: &str| detail.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    let get_str_list = |key: &str| -> Vec<String> {
        detail
            .get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let confirmer = get_str("confirmer");

    let mut evidences: Vec<DecisionSourceEvidence> = Vec::with_capacity(sorted.len());
    for meta in &sorted {
        let s = &meta.row;
        let meta_detail: serde_json::Value = if s.detail_json.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&s.detail_json).unwrap_or_else(|_| serde_json::json!({}))
        };
        let direct_anchor: Option<crate::dto::OfficeEvidenceAnchor> = meta_detail
            .get("office_anchor")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        let direct_pdf_anchor: Option<crate::dto::PdfEvidenceAnchor> = meta_detail
            .get("pdf_anchor")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());

        evidences.push(DecisionSourceEvidence {
            source_id: s.statement_id.clone(),
            file_id: s.file_id.clone(),
            revision_id: s.revision_id.clone(),
            relative_path: meta.path.clone(),
            line_start: s.line_start.max(0) as u64,
            line_end: s.line_end.max(0) as u64,
            observed_at: s.observed_at.clone(),
            // source_time = observed_at 前 10 字符（project.ts:392）
            source_time: Some(s.observed_at.chars().take(10).collect()),
            claimed_status: s.status.clone(),
            exact_quote: s.quote.clone(),
            // detail 为主陈述的 detail（project.ts:382-398 闭包捕获）
            confirmer: confirmer.clone(),
            note: format!("陈述 {} · 版本 {} · {}", s.code, s.revision_id, s.namespace),
            office_anchor: direct_anchor,
            pdf_anchor: direct_pdf_anchor,
        });

        // 若 Markdown 陈述显式链接了 `.xlsx#Sheet!Range` / `.docx#para=N`，追加一条可直跳 Office 锚点卡片的关联证据
        if let Some(linked) = meta_detail.get("linkedOffice") {
            let target_file_id = linked.get("file_id").and_then(|v| v.as_str());
            let target_revision_id = linked.get("revision_id").and_then(|v| v.as_str());
            let target_path = linked.get("relative_path").and_then(|v| v.as_str());
            let linked_anchor: Option<crate::dto::OfficeEvidenceAnchor> = linked
                .get("office_anchor")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            if let (Some(fid), Some(rid), Some(rpath), Some(anchor)) = (
                target_file_id,
                target_revision_id,
                target_path,
                linked_anchor,
            ) {
                let anchor_desc = match (&anchor.sheet, &anchor.cell_range, anchor.paragraph) {
                    (Some(sh), Some(cr), _) => format!("{sh}!{cr}"),
                    (None, Some(cr), _) => cr.clone(),
                    (_, _, Some(p)) => format!("第 {p} 段"),
                    _ => "Office 锚点".to_owned(),
                };
                evidences.push(DecisionSourceEvidence {
                    source_id: format!("{}_office", s.statement_id),
                    file_id: fid.to_owned(),
                    revision_id: rid.to_owned(),
                    relative_path: rpath.to_owned(),
                    line_start: anchor.paragraph.unwrap_or(1),
                    line_end: anchor.paragraph.unwrap_or(1),
                    observed_at: s.observed_at.clone(),
                    source_time: Some(s.observed_at.chars().take(10).collect()),
                    claimed_status: s.status.clone(),
                    exact_quote: s.quote.clone(),
                    confirmer: confirmer.clone(),
                    note: format!(
                        "陈述 {} 引用 Office 锚点：{} ({})",
                        s.code, anchor_desc, meta.path
                    ),
                    office_anchor: Some(anchor),
                    pdf_anchor: None,
                });
            }
        }

        // 若 Markdown 陈述显式链接了 `.pdf#page=N`，追加一条可直跳 PDF 页码锚点的关联证据（B04）
        if let Some(linked) = meta_detail.get("linkedPdf") {
            let target_file_id = linked.get("file_id").and_then(|v| v.as_str());
            let target_revision_id = linked.get("revision_id").and_then(|v| v.as_str());
            let target_path = linked.get("relative_path").and_then(|v| v.as_str());
            let linked_anchor: Option<crate::dto::PdfEvidenceAnchor> = linked
                .get("pdf_anchor")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            if let (Some(fid), Some(rid), Some(rpath), Some(anchor)) = (
                target_file_id,
                target_revision_id,
                target_path,
                linked_anchor,
            ) {
                let anchor_desc = format!("第 {} 页", anchor.page);
                evidences.push(DecisionSourceEvidence {
                    source_id: format!("{}_pdf", s.statement_id),
                    file_id: fid.to_owned(),
                    revision_id: rid.to_owned(),
                    relative_path: rpath.to_owned(),
                    line_start: anchor.page,
                    line_end: anchor.page,
                    observed_at: s.observed_at.clone(),
                    source_time: Some(s.observed_at.chars().take(10).collect()),
                    claimed_status: s.status.clone(),
                    exact_quote: s.quote.clone(),
                    confirmer: confirmer.clone(),
                    note: format!(
                        "陈述 {} 引用 PDF 页码锚点：{} ({})",
                        s.code, anchor_desc, meta.path
                    ),
                    office_anchor: None,
                    pdf_anchor: Some(anchor),
                });
            }
        }
    }

    let confirmation_basis =
        (primary.status == "已确认")
            .then_some(())
            .and(confirmer.as_ref().map(|confirmer| {
                DecisionConfirmationBasis {
                    record_text: primary.quote.chars().take(200).collect(),
                    confirmer: confirmer.clone(),
                    // confirmedAt = observed_at 前 16 字符并把第一个 T 换成空格（project.ts:416）
                    confirmed_at: primary
                        .observed_at
                        .chars()
                        .take(16)
                        .collect::<String>()
                        .replacen('T', " ", 1),
                    file_id: primary.file_id.clone(),
                    revision_id: primary.revision_id.clone(),
                    line_range: (
                        primary.line_start.max(0) as u64,
                        primary.line_end.max(0) as u64,
                    ),
                }
            }));

    DecisionAssertion {
        decision_id,
        code: primary.code.clone(),
        namespace: primary.namespace.clone(),
        question: primary.question.clone(),
        status: primary.status.clone(),
        is_candidate_only: false,
        options: get_str_list("options"),
        recommendation: get_str("recommendation")
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "原文未给出显式推荐。".to_owned()),
        impact_blocked: get_str_list("impactBlocked"),
        impact_allowed: get_str_list("impactAllowed"),
        confirmation_basis,
        evidences,
        conflict_explanation: None,
        topic: primary.namespace.clone(),
    }
}

/// 摘要投影行（issue #23）：一行一决定，只携带筛选/排序/键集所需字段
struct DecisionSummary {
    decision_id: String,
    status: String,
    code: String,
    question: String,
    namespace: String,
    rank: u8,
    file_active: bool,
}

/// 证据构造的陈述行 + 关联元数据（issue #23）：来源路径与版本观察时间在 SQL 内
/// 关联给出（missing 文件/缺行文件 path 为空串；无版本行的陈述回退陈述观察时间）
struct StatementMeta {
    row: StatementRow,
    path: String,
    rev_time: String,
}

/// 全量可落文件引用边（契约 §1.10：批次一过渡全量；project.ts:249-263 逐字对齐）。
/// 过滤 `unresolved:` 前缀目标；label 按 resolution；locator 两端齐备才下发。
/// 顺序沿用 listEdges 的无 ORDER BY（rowid 序，与 Node 现状一致）。
/// issue #33：短读事务包装。
pub fn relations(store: &ReadonlyStore) -> Result<RelationsResponse, GuanlanError> {
    store.read_txn(|_conn| relations_tx(store))
}

/// 事务内执行体（已持有读事务的调用方直接用本函数，避免嵌套）。
pub fn relations_tx(store: &ReadonlyStore) -> Result<RelationsResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let conn = store.conn();
    let mut stmt = conn
        .prepare("SELECT * FROM edges WHERE workspace_id = ?")
        .map_err(internal_sql)?;
    let edges: Vec<EdgeRow> = stmt
        .query_map([&ws.workspace_id], edge_row)
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;

    let items: Vec<RelationEdge> = edges
        .iter()
        .filter(|e| !e.target_file_id.starts_with("unresolved:"))
        .map(|e| RelationEdge {
            edge_id: e.edge_id.clone(),
            source_id: e.source_file_id.clone(),
            target_id: e.target_file_id.clone(),
            edge_type: if e.kind == crate::application::proposals::DERIVED_FROM_CONTEXT_KIND {
                crate::application::proposals::DERIVED_FROM_CONTEXT_KIND.to_owned()
            } else {
                "explicit_reference".to_owned()
            },
            is_inferred: false,
            label: if e.kind == crate::application::proposals::DERIVED_FROM_CONTEXT_KIND {
                "源自上下文".to_owned()
            } else if e.resolution == "collected_version" {
                "显式引用（收录版本）".to_owned()
            } else {
                "显式引用".to_owned()
            },
            reason: e.reason.clone(),
            locator: match (e.locator_start, e.locator_end) {
                (Some(start), Some(end)) => Some(RelationLocator {
                    start_line: start.max(0) as u64,
                    end_line: end.max(0) as u64,
                }),
                _ => None,
            },
        })
        .collect();

    Ok(RelationsResponse {
        ok: true,
        index_generation: ws.index_generation,
        items,
    })
}

/// relations_total（bootstrap 用）：可落文件的引用边计数
pub(crate) fn relations_total(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> Result<u64, GuanlanError> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) AS n FROM edges WHERE workspace_id = ? AND target_file_id NOT LIKE 'unresolved:%'",
            [workspace_id],
            |r| r.get(0),
        )
        .map_err(internal_sql)?;
    Ok(n.max(0) as u64)
}

#[cfg(test)]
#[path = "decisions_tests.rs"]
mod tests;
