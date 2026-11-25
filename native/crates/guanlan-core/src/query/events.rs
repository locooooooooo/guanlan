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

/// 决策事件的格式回填表达式（queries.ts:201）：决策事件（revision_id 为空）经
/// r→f 联表后格式必为 null，从 payload 的 file_id 回填来源文件格式。
const FORMAT_EXPR: &str = "COALESCE(f.format, df.format)";

/// 桶内决定样本上限：与 samples 独立——一个桶可能有几十个决定，
/// 不再无界塞进嵌套集合；超出时 decision_total/decisions_truncated 如实标注，
/// 客户端可经有界分页的 /api/v1/events 继续读该桶。
const EVENT_DAY_DECISION_CAP: i64 = 20;

/// 窗口统计缓存条目：total_in_window + undated_count
#[derive(Debug, Clone)]
struct WindowStats {
    total_in_window: u64,
    undated_count: u64,
}

/// 窗口统计缓存键与映射类型（独立别名避免复杂返回类型内联）
type WindowStatsCacheKey = (String, i64, i64, String);
type WindowStatsCache =
    std::sync::Mutex<std::collections::HashMap<WindowStatsCacheKey, WindowStats>>;

/// 窗口统计缓存容量（窗口×筛选并存上限；超出按插入序逐最旧）
const WINDOW_STATS_CACHE_CAPACITY: usize = 64;

/// 窗口统计缓存：`(ws_id, generation, snapshot_max_seq, 筛选指纹) → 统计`。
/// 事件只增不改且新事件不进已签发窗口（seq <= snap），同代际同窗口同筛选下
/// 统计恒定，可安全复用。
fn window_stats_cache() -> &'static WindowStatsCache {
    static CACHE: std::sync::OnceLock<WindowStatsCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 事件窗口过滤构建器（queries.ts:138-171 eventWindowFilter 逐字对齐）：
/// 页查询与窗口计数（total_in_window）共用同一份条件。
/// `snap_bound` 为 None 时省略 seq 上界（首页 `snap == current_max` 时
/// 上界恒真且会让查询规划器放弃排序表达式索引；一致性由 `read_txn` 快照保证）。
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
    // max_event_seq / 页查询 / 窗口统计固定在同一 DEFERRED 读快照内
    // （契约 §0.3-1 snapshot 语义的正确性前提，也为首页省略空转 seq 上界提供
    // 一致性保证）；只读连接上不产生任何写行为（契约 §4-1 边界不变）。
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
    // snapshot_max_seq 绑定（契约 §0.3-1）：续页沿用签发时的快照，新事件不进窗口
    let snap = cursor.as_ref().map_or(current_max, |c| c.snap);
    if let Some(c) = &cursor {
        if c.fp != fp {
            // 游标绑定筛选不一致 → 返回 CURSOR_STALE（契约 §0.2）
            return Err(cursor_stale_fingerprint());
        }
    }
    // seq 上界仅在真正收紧窗口时下发（续页 snap < current_max）；
    // 首页 snap==current_max 时上界恒真，省略后查询规划器才能选用排序表达式
    // 索引（idx_events_ws_occurred_sort / idx_events_ws_observed_sort）避免整窗排序。
    let snap_bound = (snap < current_max).then_some(snap);

    let sort_expr = if observed {
        "e.observed_at".to_owned()
    } else {
        "COALESCE(e.occurred_at, '')".to_owned()
    };
    // 窗口按本地日历日归属（纯日期短路，含时刻 ISO 按 localtime 取日）
    let date_expr = if observed {
        local_day_expr("e.observed_at")
    } else {
        local_day_expr("e.occurred_at")
    };

    let (mut clauses, mut params) = event_window_filter(ws_id, query, snap_bound, &date_expr);
    if let Some(c) = &cursor {
        // 键集分页条件（queries.ts:204-207）：(sort, seq) < (k, s)
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

    // 窗口统计（不含游标条件）：与页查询共用过滤构建器（queries.ts:257-273）。
    // 窗口总数按稳定快照（snapshot_max_seq）与筛选指纹（fp）缓存复用：
    // 同代际内事件只增不改、新事件不进已签发窗口（seq <= snap），同窗口同
    // 筛选的续页不再重复做与窗口总量成正比的统计。
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
                // 「日期待考 N」与当前类型筛选同口径（与 queries.ts 一致）
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
                        // 插入序逐最旧（会话级缓存；容量覆盖多窗口/多筛选并存）
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
        // newer_count（queries.ts:310）：首屏后新增事件数，驱动「有新变化」提示
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

/// 时间范围内部实现（bootstrap 复用；不带响应壳）
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

/// 桶键表达式（queries.ts:451-457 eventDayBucketExpr 逐字对齐）：
/// - day = YYYY-MM-DD（本地日历日）；month = YYYY-MM；
/// - week = 该日所在周的周一（先回退 6 天再前进到最近的周一）；
/// - occurred 口径锚定 occurred_at（空桶=日期待考）；observed 锚定 observed_at；
/// - 纯日期不参与时区换算；空串经 date() 返回 NULL，用 COALESCE 兜回空串桶。
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
    // from/to 窗口恒按「本地日」过滤（与 /events 的 dateExpr 口径一致），
    // 聚合桶粒度只影响分组键（queries.ts:469-470）
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

    // ── 先确定返回桶，再只为这些桶富化样本/详情 ──
    //
    // 先取返回桶集合再按桶下界聚合，避免请求少量桶时对全窗口做无界聚合与样本分区：
    //   ① 一次扫描拿 total / 有日期的桶数 / 待考事件数（全范围计数单独统计）；
    //   ② 再取 top N+1 个桶键（N=limit_days）→ 得到返回集合与 hidden_days；
    //   ③ 桶×种类×格式、决策、样本三类查询都加 `d = '' OR d >= min_key` 下界，
    //      窗口函数只分区返回桶的行（样本不再按全窗口分区）。

    // ① 全范围计数（保 total / hidden_days / undated 语义）
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

    // ② 取返回桶（多取 1 个用于判定 hidden_days，不依赖额外 COUNT）
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
    // 返回桶的最小键：后续富化查询的统一下界（桶键为 YYYY-MM-DD/YYYY-MM，字典序即时序）
    let min_key = dated_keys.last().cloned();

    // ③ 只为返回桶（+ 待考桶）富化；min_key 缺失且无待考 → 直接返回空结果
    let mut group_map: std::collections::HashMap<String, EventDayGroup> =
        std::collections::HashMap::new();

    if let Some(min_key) = min_key.as_deref() {
        // 富化过滤：待考桶恒参与（它不占 limit_days），日期桶只取 >= min_key
        let enrich_clause = format!("({bucket} = '' OR {bucket} >= ?)");
        let mut enrich_params = params.clone();
        enrich_params.push(sql_text(min_key));

        // 3a) 桶 × 种类 × 格式计数
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

        // 3b) 决策聚合（code/status 取组内 seq 最大那条事件）+ 独立上限
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

        // 3c) 每桶最新若干条样本（同桶优先决策与内容修改类，其余按入库序）；
        //     窗口分区只看返回桶的行，不再按全窗口分区
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
        // 没有日期桶但有「日期待考」：仍需待考桶的分组与样本
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

    // 分组收尾（queries.ts:571-623）：空串桶 =「日期待考」，恒排最后。
    // 返回桶已在上面确定，这里只按既有顺序取组，不再做全量 reduce。
    let total = total_events.max(0) as u64;
    let undated = group_map.remove("");
    let mut groups: Vec<EventDayGroup> = dated_keys
        .iter()
        .filter_map(|k| group_map.remove(k))
        .collect();
    for group in groups.iter_mut() {
        // 决定样本截断标记（总数与样本数对比，不用额外查询）
        group.decisions_truncated = (group.decision_total as usize) > group.decisions.len();
    }
    // 先取 count 再 move 组进 groups，避免为读取 count 而克隆整组数据
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

/// 取分组（queries.ts:572-579 ensureGroup 对齐）：不存在则建空组，date 记桶键
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
