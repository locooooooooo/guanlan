//! 事件查询（契约 §1.4/§1.5/§1.6）。
//!
//! 行为准绳：server/queries.ts（queryEvents :173-312、eventTimeRange
//! :318-353、queryEventDays :459-653）。SQL 形状、过滤顺序、排序与统计口径
//! 与该文件逐字等价；只读执行。

use rusqlite::types::Value;

use super::sql_text;
use rusqlite::{params_from_iter, Connection};

use crate::dto::{
    EventDayDecision, EventDayGroup, EventDayItem, EventDaysResult, EventPage, EventPageItem,
    EventTimeRange, EventTimeRangeResponse, EventWindow,
};
use crate::error::GuanlanError;
use crate::query::cursor::{
    clamp_limit, cursor_stale_fingerprint, decode_event_cursor, encode_event_cursor,
    events_fingerprint, local_day_expr, non_empty, safe_json,
};
use crate::query::{EventDaysQuery, EventGranularity, EventOrder, EventQuery};
use crate::storage::{internal_sql, ReadonlyStore};

const FORMAT_EXPR: &str = "COALESCE(f.format, df.format)";

const EVENT_DAY_DECISION_CAP: i64 = 20;

#[derive(Debug, Clone)]
struct WindowStats {
    total_in_window: u64,
    undated_count: u64,
}

type WindowStatsCacheKey = (String, i64, i64, String);
type WindowStatsCache =
    std::sync::Mutex<std::collections::HashMap<WindowStatsCacheKey, WindowStats>>;

const WINDOW_STATS_CACHE_CAPACITY: usize = 64;

fn window_stats_cache() -> &'static WindowStatsCache {
    static CACHE: std::sync::OnceLock<WindowStatsCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn event_window_filter(
    workspace_id: &str,
    query: &EventQuery,
    snap_bound: Option<i64>,
    date_expr: &str,
) -> (Vec<String>, Vec<Value>) {
    let mut clauses: Vec<String> = vec!["e.workspace_id = ?".to_owned()];
    let mut params: Vec<Value> = vec![sql_text(workspace_id)];
    if let Some(snap) = snap_bound {
        clauses.push("e.seq <= ?".to_owned());
        params.push(Value::from(snap));
    }

    if let Some(from) = non_empty(&query.from) {
        clauses.push(format!("{date_expr} >= ?"));
        params.push(sql_text(from));
    }
    if let Some(to) = non_empty(&query.to) {
        clauses.push(format!("{date_expr} <= ?"));
        params.push(sql_text(to));
    }
    if query.undated {
        clauses.push("e.occurred_at IS NULL".to_owned());
    }
    if !query.kinds.is_empty() {
        clauses.push(format!(
            "e.kind IN ({})",
            vec!["?"; query.kinds.len()].join(",")
        ));
        params.extend(query.kinds.iter().map(|k| sql_text(k.as_str())));
    }
    if let Some(fmt) = non_empty(&query.format) {
        clauses.push(format!("{FORMAT_EXPR} = ?"));
        params.push(sql_text(fmt));
    }
    if let Some(q) = non_empty(&query.q) {
        clauses.push("(e.headline LIKE ? OR e.detail LIKE ?)".to_owned());
        params.push(Value::from(format!("%{q}%")));
        params.push(Value::from(format!("%{q}%")));
    }
    (clauses, params)
}

/// 事件分页（契约 §1.4：queryEvents 映射，绑定筛选指纹与 snapshot_max_seq）
pub fn query_events(store: &ReadonlyStore, query: &EventQuery) -> Result<EventPage, GuanlanError> {
    store.read_txn(|_conn| query_events_tx(store, query))
}

/// 事务内执行体（bootstrap 复用：它已在自身 read_txn 内，调本函数避免嵌套）。
pub fn query_events_tx(
    store: &ReadonlyStore,
    query: &EventQuery,
) -> Result<EventPage, GuanlanError> {
    let ws = store.workspace()?.clone();
    let ws_id = ws.workspace_id.as_str();
    let order = query.order;
    let observed = order == EventOrder::Observed;
    let limit = clamp_limit(query.limit, 50, 200);
    let fp = events_fingerprint(query);
    let current_max = store.max_event_seq(ws_id)?;

    let cursor = match query.cursor.as_deref() {
        Some(raw) if !raw.is_empty() => Some(decode_event_cursor(raw)?),
        _ => None,
    };
    let snap = cursor.as_ref().map_or(current_max, |c| c.snap);
    if let Some(c) = &cursor {
        if c.fp != fp {
            return Err(cursor_stale_fingerprint());
        }
    }
    let snap_bound = (snap < current_max).then_some(snap);

    let sort_expr = if observed {
        "e.observed_at".to_owned()
    } else {
        "COALESCE(e.occurred_at, '')".to_owned()
    };
    let date_expr = if observed {
        local_day_expr("e.observed_at")
    } else {
        local_day_expr("e.occurred_at")
    };

    let (mut clauses, mut params) = event_window_filter(ws_id, query, snap_bound, &date_expr);
    if let Some(c) = &cursor {
        clauses.push(format!(
            "({sort_expr} < ? OR ({sort_expr} = ? AND e.seq < ?))"
        ));
        params.push(Value::from(c.k.clone()));
        params.push(Value::from(c.k.clone()));
        params.push(Value::from(c.s));
    }

    let sql = format!(
        "SELECT e.*, r.file_id AS file_id, f.current_path AS file_path, f.title AS file_title, \
                {FORMAT_EXPR} AS format \
         FROM events e \
         LEFT JOIN revisions r ON e.revision_id = r.revision_id \
         LEFT JOIN files f ON r.file_id = f.file_id \
         LEFT JOIN files df ON df.file_id = json_extract(e.payload_json,'$.file_id') \
         WHERE {} \
         ORDER BY {sort_expr} DESC, e.seq DESC \
         LIMIT ?",
        clauses.join(" AND ")
    );
    params.push(Value::from((limit + 1) as i64));

    let conn = store.conn();
    let mut stmt = conn.prepare(&sql).map_err(internal_sql)?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok(EventPageItem {
                seq: row.get("seq")?,
                event_id: row.get("event_id")?,
                kind: row.get("kind")?,
                subject_kind: row.get("subject_kind")?,
                subject_id: row.get("subject_id")?,
                revision_id: row.get("revision_id")?,
                occurred_at: row.get("occurred_at")?,
                occurred_precision: row.get("occurred_precision")?,
                occurred_source: row.get("occurred_source")?,
                observed_at: row.get("observed_at")?,
                headline: row.get("headline")?,
                detail: row.get("detail")?,
                payload: safe_json(&row.get::<_, String>("payload_json")?),
                file_id: row.get("file_id")?,
                file_path: row.get("file_path")?,
                file_title: row.get("file_title")?,
                format: row.get("format")?,
            })
        })
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;

    let has_more = rows.len() > limit as usize;
    let items: Vec<EventPageItem> = rows.into_iter().take(limit as usize).collect();

    let next_cursor = if has_more {
        items.last().map(|last| {
            let k = if observed {
                last.observed_at.clone()
            } else {
                last.occurred_at.clone().unwrap_or_default()
            };
            encode_event_cursor(&crate::query::cursor::EventCursor {
                snap,
                k,
                s: last.seq,
                fp: fp.clone(),
            })
        })
    } else {
        None
    };

    let window_stats = {
        let key = (
            ws_id.to_owned(),
            ws.index_generation as i64,
            snap,
            fp.clone(),
        );
        let cached = window_stats_cache()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
            .cloned();
        match cached {
            Some(stats) => stats,
            None => {
                let (count_clauses, count_params) =
                    event_window_filter(ws_id, query, snap_bound, &date_expr);
                let count_sql = format!(
                    "SELECT COUNT(*) AS n FROM events e \
                     LEFT JOIN revisions r ON e.revision_id = r.revision_id \
                     LEFT JOIN files f ON r.file_id = f.file_id \
                     LEFT JOIN files df ON df.file_id = json_extract(e.payload_json,'$.file_id') \
                     WHERE {}",
                    count_clauses.join(" AND ")
                );
                let total_in_window: i64 = conn
                    .query_row(&count_sql, params_from_iter(count_params.iter()), |r| {
                        r.get(0)
                    })
                    .map_err(internal_sql)?;
                let mut undated_clauses: Vec<String> = vec![
                    "e.workspace_id = ?".to_owned(),
                    "e.occurred_at IS NULL".to_owned(),
                ];
                let mut undated_params: Vec<Value> = vec![sql_text(ws_id)];
                if !query.kinds.is_empty() {
                    undated_clauses.push(format!(
                        "e.kind IN ({})",
                        vec!["?"; query.kinds.len()].join(",")
                    ));
                    undated_params.extend(query.kinds.iter().map(|k| sql_text(k.as_str())));
                }
                let undated_sql = format!(
                    "SELECT COUNT(*) AS n FROM events e \
                     LEFT JOIN revisions r ON e.revision_id = r.revision_id \
                     LEFT JOIN files f ON r.file_id = f.file_id \
                     WHERE {}",
                    undated_clauses.join(" AND ")
                );
                let undated_count: i64 = conn
                    .query_row(&undated_sql, params_from_iter(undated_params.iter()), |r| {
                        r.get(0)
                    })
                    .map_err(internal_sql)?;
                let stats = WindowStats {
                    total_in_window: total_in_window.max(0) as u64,
                    undated_count: undated_count.max(0) as u64,
                };
                {
                    let mut cache = window_stats_cache()
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    if cache.len() >= WINDOW_STATS_CACHE_CAPACITY && !cache.contains_key(&key) {
                        if let Some(oldest) = cache.keys().next().cloned() {
                            cache.remove(&oldest);
                        }
                    }
                    cache.insert(key, stats.clone());
                }
                stats
            }
        }
    };
    let total_in_window = window_stats.total_in_window as i64;
    let undated_count = window_stats.undated_count as i64;

    Ok(EventPage {
        ok: true,
        index_generation: ws.index_generation,
        window: EventWindow {
            order: order.as_str().to_owned(),
            from: non_empty(&query.from).map(str::to_owned),
            to: non_empty(&query.to).map(str::to_owned),
            kinds: query.kinds.clone(),
            format: non_empty(&query.format).map(str::to_owned),
            undated: query.undated,
            q: non_empty(&query.q).map(str::to_owned),
        },
        snapshot_max_seq: snap,
        next_cursor,
        has_more,
        items,
        total_in_window: total_in_window.max(0) as u64,
        undated_count: undated_count.max(0) as u64,
        newer_count: (current_max - snap).max(0) as u64,
    })
}

/// 事件的实际时间范围（契约 §1.6；queries.ts:318-353 逐字对齐，无参数）
pub fn event_time_range(store: &ReadonlyStore) -> Result<EventTimeRangeResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let range = event_time_range_inner(store.conn(), &ws.workspace_id)?;
    Ok(EventTimeRangeResponse {
        ok: true,
        range,
        index_generation: ws.index_generation,
    })
}

pub(crate) fn event_time_range_inner(
    conn: &Connection,
    workspace_id: &str,
) -> Result<EventTimeRange, GuanlanError> {
    let occurred_day = local_day_expr("occurred_at");
    let observed_day = local_day_expr("observed_at");
    let sql = format!(
        "SELECT \
           MIN({occurred_day}) AS occurred_min, \
           MAX({occurred_day}) AS occurred_max, \
           MIN({observed_day}) AS observed_min, \
           MAX({observed_day}) AS observed_max, \
           SUM(CASE WHEN occurred_at IS NULL THEN 1 ELSE 0 END) AS undated \
         FROM events WHERE workspace_id = ?"
    );
    conn.query_row(&sql, [workspace_id], |row| {
        Ok(EventTimeRange {
            occurred_min: row.get(0)?,
            occurred_max: row.get(1)?,
            observed_min: row.get(2)?,
            observed_max: row.get(3)?,
            undated_count: row.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0) as u64,
        })
    })
    .map_err(internal_sql)
}

fn event_day_bucket_expr(order: EventOrder, granularity: EventGranularity) -> String {
    let anchor = if order == EventOrder::Observed {
        "e.observed_at"
    } else {
        "e.occurred_at"
    };
    let day = format!("COALESCE({}, '')", local_day_expr(anchor));
    match granularity {
        EventGranularity::Month => format!("substr({day},1,7)"),
        EventGranularity::Week => format!("COALESCE(date({day},'-6 days','weekday 1'),'')"),
        EventGranularity::Day => day,
    }
}

/// 事件日桶聚合（契约 §1.5：queryEventDays 映射；无游标、无 snapshot 绑定，短读事务包装）
pub fn query_event_days(
    store: &ReadonlyStore,
    query: &EventDaysQuery,
) -> Result<EventDaysResult, GuanlanError> {
    store.read_txn(|_conn| query_event_days_tx(store, query))
}

/// 事务内执行体（bootstrap 等已持有读事务的调用方直接用本函数，避免嵌套）。
pub fn query_event_days_tx(
    store: &ReadonlyStore,
    query: &EventDaysQuery,
) -> Result<EventDaysResult, GuanlanError> {
    let ws = store.workspace()?.clone();
    let conn = store.conn();
    let ws_id = ws.workspace_id.as_str();

    let order = query.order;
    let observed = order == EventOrder::Observed;
    let granularity = query.granularity;
    let bucket = event_day_bucket_expr(order, granularity);
    let day_expr = local_day_expr(if observed {
        "e.observed_at"
    } else {
        "e.occurred_at"
    });
    let limit_days = clamp_limit(query.limit_days, 30, 120);
    let samples_per_day = clamp_limit(query.samples, 4, 12);

    let mut clauses: Vec<String> = vec!["e.workspace_id = ?".to_owned()];
    let mut params: Vec<Value> = vec![sql_text(ws_id)];
    if let Some(from) = non_empty(&query.from) {
        clauses.push(format!("{day_expr} >= ?"));
        params.push(sql_text(from));
    }
    if let Some(to) = non_empty(&query.to) {
        clauses.push(format!("{day_expr} <= ?"));
        params.push(sql_text(to));
    }
    if !query.kinds.is_empty() {
        clauses.push(format!(
            "e.kind IN ({})",
            vec!["?"; query.kinds.len()].join(",")
        ));
        params.extend(query.kinds.iter().map(|k| sql_text(k.as_str())));
    }
    if let Some(fmt) = non_empty(&query.format) {
        clauses.push(format!("{FORMAT_EXPR} = ?"));
        params.push(sql_text(fmt));
    }
    let base = format!(
        "FROM events e \
         LEFT JOIN revisions r ON e.revision_id = r.revision_id \
         LEFT JOIN files f ON r.file_id = f.file_id \
         LEFT JOIN files df ON df.file_id = json_extract(e.payload_json,'$.file_id') \
         WHERE {}",
        clauses.join(" AND ")
    );

    let totals_sql = format!(
        "SELECT COUNT(*) AS total, \
                COUNT(DISTINCT CASE WHEN {bucket} <> '' THEN {bucket} END) AS dated_buckets, \
                SUM(CASE WHEN {bucket} = '' THEN 1 ELSE 0 END) AS undated \
         {base}"
    );
    let (total_events, dated_bucket_total, undated_events): (i64, i64, i64) = conn
        .query_row(&totals_sql, params_from_iter(params.iter()), |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })
        .map_err(internal_sql)?;

    let keys_sql = format!(
        "SELECT {bucket} AS d {base} AND {bucket} <> '' \
         GROUP BY d ORDER BY d DESC LIMIT ?"
    );
    let mut keys_params = params.clone();
    keys_params.push(Value::from((limit_days + 1) as i64));
    let mut keys_stmt = conn.prepare(&keys_sql).map_err(internal_sql)?;
    let mut dated_keys: Vec<String> = keys_stmt
        .query_map(params_from_iter(keys_params.iter()), |row| {
            row.get::<_, String>("d")
        })
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    let has_hidden = dated_keys.len() > limit_days as usize;
    if has_hidden {
        dated_keys.truncate(limit_days as usize);
    }
    let hidden_days = (dated_bucket_total.max(0) as u64).saturating_sub(dated_keys.len() as u64);
    let min_key = dated_keys.last().cloned();

    let mut group_map: std::collections::HashMap<String, EventDayGroup> =
        std::collections::HashMap::new();

    if let Some(min_key) = min_key.as_deref() {
        let enrich_clause = format!("({bucket} = '' OR {bucket} >= ?)");
        let mut enrich_params = params.clone();
        enrich_params.push(sql_text(min_key));

        let daily_sql = format!(
            "SELECT {bucket} AS d, e.kind AS kind, {FORMAT_EXPR} AS fmt, COUNT(*) AS n \
             {base} AND {enrich_clause} \
             GROUP BY d, e.kind, fmt \
             ORDER BY d DESC"
        );
        let mut daily_stmt = conn.prepare(&daily_sql).map_err(internal_sql)?;
        let daily_rows = daily_stmt
            .query_map(params_from_iter(enrich_params.iter()), |row| {
                Ok((
                    row.get::<_, String>("d")?,
                    row.get::<_, String>("kind")?,
                    row.get::<_, Option<String>>("fmt")?,
                    row.get::<_, i64>("n")?,
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for (d, kind, fmt, n) in daily_rows {
            let g = ensure_group(&mut group_map, &d);
            g.count += n.max(0) as u64;
            *g.by_kind.entry(kind).or_insert(0) += n.max(0) as u64;
            if let Some(fmt) = fmt {
                *g.formats.entry(fmt).or_insert(0) += n.max(0) as u64;
            }
        }

        let decision_sql = format!(
            "SELECT * FROM ( \
               SELECT grouped.d AS d, grouped.decision_id AS decision_id, \
                      json_extract(latest.payload_json,'$.code') AS code, \
                      json_extract(latest.payload_json,'$.status') AS status, \
                      grouped.n AS n, \
                      COUNT(*) OVER (PARTITION BY grouped.d) AS decision_total, \
                      ROW_NUMBER() OVER (PARTITION BY grouped.d ORDER BY grouped.n DESC, grouped.decision_id ASC) AS rn \
               FROM ( \
                 SELECT {bucket} AS d, \
                        json_extract(e.payload_json,'$.decision_id') AS decision_id, \
                        COUNT(*) AS n, \
                        MAX(e.seq) AS latest_seq \
                 {base} AND {enrich_clause} AND e.kind IN ('decision_raised','decision_changed') \
                 GROUP BY d, decision_id \
               ) AS grouped \
               JOIN events latest ON latest.seq = grouped.latest_seq \
             ) WHERE rn <= ?"
        );
        let mut decision_params = enrich_params.clone();
        decision_params.push(Value::from(EVENT_DAY_DECISION_CAP));
        let mut decision_stmt = conn.prepare(&decision_sql).map_err(internal_sql)?;
        let decision_rows = decision_stmt
            .query_map(params_from_iter(decision_params.iter()), |row| {
                Ok((
                    row.get::<_, String>("d")?,
                    row.get::<_, Option<String>>("decision_id")?,
                    row.get::<_, Option<String>>("code")?,
                    row.get::<_, Option<String>>("status")?,
                    row.get::<_, i64>("n")?,
                    row.get::<_, i64>("decision_total")?,
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for (d, decision_id, code, status, n, decision_total) in decision_rows {
            let Some(decision_id) = decision_id else {
                continue;
            };
            let g = ensure_group(&mut group_map, &d);
            g.decision_total = decision_total.max(0) as u64;
            g.decisions.push(EventDayDecision {
                decision_id,
                code: code.unwrap_or_else(|| "—".to_owned()),
                status: status.unwrap_or_else(|| "未知".to_owned()),
                count: n.max(0) as u64,
            });
        }

        let sample_sql = format!(
            "SELECT * FROM ( \
               SELECT e.event_id, e.kind, e.headline, e.revision_id, e.occurred_at, e.occurred_precision, \
                      e.observed_at, e.payload_json, f.file_id AS file_id, f.current_path AS file_path, \
                      f.title AS file_title, f.role AS file_role, {FORMAT_EXPR} AS format, \
                      json_extract(e.payload_json,'$.time_basis') AS time_basis, \
                      json_extract(e.payload_json,'$.action') AS action, \
                      json_extract(e.payload_json,'$.decision_id') AS decision_id, \
                      json_extract(e.payload_json,'$.code') AS code, \
                      json_extract(e.payload_json,'$.status') AS status, \
                      (SELECT COUNT(*) FROM edges ed WHERE ed.source_file_id = f.file_id) AS ref_count, \
                      (SELECT COUNT(*) FROM revisions rv WHERE rv.file_id = f.file_id) AS version_count, \
                      (SELECT COUNT(*) FROM statements st WHERE st.file_id = f.file_id) AS statement_count, \
                      {bucket} AS d, \
                      ROW_NUMBER() OVER ( \
                        PARTITION BY {bucket} \
                        ORDER BY CASE WHEN e.kind IN ('decision_raised','decision_changed','modified') \
                                 THEN 0 ELSE 1 END ASC, e.seq DESC \
                      ) AS rn \
               {base} AND {enrich_clause} \
             ) WHERE rn <= ? \
             ORDER BY d DESC, rn ASC"
        );
        let mut sample_params = enrich_params.clone();
        sample_params.push(Value::from(samples_per_day as i64));
        let mut sample_stmt = conn.prepare(&sample_sql).map_err(internal_sql)?;
        let sample_rows = sample_stmt
            .query_map(params_from_iter(sample_params.iter()), |row| {
                Ok((
                    row.get::<_, String>("d")?,
                    EventDayItem {
                        event_id: row.get("event_id")?,
                        kind: row.get("kind")?,
                        headline: row.get("headline")?,
                        revision_id: row.get("revision_id")?,
                        file_id: row.get("file_id")?,
                        file_path: row.get("file_path")?,
                        file_title: row.get("file_title")?,
                        file_role: row.get("file_role")?,
                        format: row.get("format")?,
                        occurred_at: row.get("occurred_at")?,
                        occurred_precision: row.get("occurred_precision")?,
                        observed_at: row.get("observed_at")?,
                        time_basis: row.get("time_basis")?,
                        action: row.get("action")?,
                        decision_id: row.get("decision_id")?,
                        code: row.get("code")?,
                        status: row.get("status")?,
                        ref_count: row.get::<_, i64>("ref_count")?.max(0) as u64,
                        version_count: row.get::<_, i64>("version_count")?.max(0) as u64,
                        statement_count: row.get::<_, i64>("statement_count")?.max(0) as u64,
                    },
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for (d, item) in sample_rows {
            let g = ensure_group(&mut group_map, &d);
            g.samples.push(item);
        }
    } else if undated_events > 0 {
        let mut enrich_params = params.clone();
        enrich_params.push(sql_text(""));
        let daily_sql = format!(
            "SELECT {bucket} AS d, e.kind AS kind, {FORMAT_EXPR} AS fmt, COUNT(*) AS n \
             {base} AND {bucket} = ? \
             GROUP BY d, e.kind, fmt"
        );
        let mut daily_stmt = conn.prepare(&daily_sql).map_err(internal_sql)?;
        let daily_rows = daily_stmt
            .query_map(params_from_iter(enrich_params.iter()), |row| {
                Ok((
                    row.get::<_, String>("d")?,
                    row.get::<_, String>("kind")?,
                    row.get::<_, Option<String>>("fmt")?,
                    row.get::<_, i64>("n")?,
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for (d, kind, fmt, n) in daily_rows {
            let g = ensure_group(&mut group_map, &d);
            g.count += n.max(0) as u64;
            *g.by_kind.entry(kind).or_insert(0) += n.max(0) as u64;
            if let Some(fmt) = fmt {
                *g.formats.entry(fmt).or_insert(0) += n.max(0) as u64;
            }
        }
    }

    let total = total_events.max(0) as u64;
    let undated = group_map.remove("");
    let mut groups: Vec<EventDayGroup> = dated_keys
        .iter()
        .filter_map(|k| group_map.remove(k))
        .collect();
    for group in groups.iter_mut() {
        group.decisions_truncated = (group.decision_total as usize) > group.decisions.len();
    }
    let undated_count = match undated {
        Some(mut u) if u.count > 0 => {
            u.decisions_truncated = (u.decision_total as usize) > u.decisions.len();
            let count = u.count;
            groups.push(u);
            count
        }
        _ => 0,
    };

    Ok(EventDaysResult {
        ok: true,
        index_generation: ws.index_generation,
        order: order.as_str().to_owned(),
        granularity: match granularity {
            EventGranularity::Day => "day",
            EventGranularity::Week => "week",
            EventGranularity::Month => "month",
        }
        .to_owned(),
        from: non_empty(&query.from).map(str::to_owned),
        to: non_empty(&query.to).map(str::to_owned),
        groups,
        total,
        hidden_days: hidden_days as u64,
        undated_count,
    })
}

fn ensure_group<'m>(
    map: &'m mut std::collections::HashMap<String, EventDayGroup>,
    date: &str,
) -> &'m mut EventDayGroup {
    if !map.contains_key(date) {
        map.insert(
            date.to_owned(),
            EventDayGroup {
                date: date.to_owned(),
                count: 0,
                by_kind: Default::default(),
                decisions: Vec::new(),
                decision_total: 0,
                decisions_truncated: false,
                formats: Default::default(),
                samples: Vec::new(),
            },
        );
    }
    map.get_mut(date).expect("组刚插入")
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
