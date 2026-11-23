/**
 * 观澜 v0.4 第一轮 —— 事件分页查询
 *
 * 方案 §5：支持日期、事项、格式、事件种类、时间口径和游标。
 * - 首屏返回事件摘要与下一页游标
 * - 游标绑定筛选与首次查询时的最大事件序号
 * - 新增事件先提示「有新变化」，用户刷新后进入新的查询窗口
 */

import { createHash } from 'node:crypto';
import type { WorkspaceStore } from './WorkspaceStore';

export type EventOrder = 'occurred' | 'observed';

export interface EventQuery {
  workspaceId: string;
  /** 发生时间窗口（含端点，YYYY-MM-DD） */
  from?: string;
  to?: string;
  kinds?: string[];
  /** 按关联文件格式过滤；工作区级事件（如基线）不计入 */
  format?: 'md' | 'svg' | 'pdf';
  /** occurred = 按材料记载时间；observed = 按观澜采集时间 */
  order?: EventOrder;
  /** 只看日期待考（occurred_at 为空） */
  undated?: boolean;
  /** 关键词：标题或详情 */
  q?: string;
  limit?: number;
  /** 不透明游标（绑定筛选与快照） */
  cursor?: string | null;
}

export interface EventPageItem {
  seq: number;
  event_id: string;
  kind: string;
  subject_kind: string;
  subject_id: string;
  revision_id: string | null;
  occurred_at: string | null;
  occurred_precision: string;
  occurred_source: string | null;
  observed_at: string;
  headline: string;
  detail: string;
  payload: Record<string, unknown>;
  file_id: string | null;
  file_path: string | null;
  file_title: string | null;
  format: string | null;
}

export interface EventPage {
  ok: true;
  index_generation: number;
  window: {
    order: EventOrder;
    from: string | null;
    to: string | null;
    kinds: string[];
    format: string | null;
    undated: boolean;
    q: string | null;
  };
  snapshot_max_seq: number;
  items: EventPageItem[];
  next_cursor: string | null;
  has_more: boolean;
  total_in_window: number;
  undated_count: number;
  /** 首次查询之后新增的事件数（用于「有新变化」提示） */
  newer_count: number;
}

interface CursorPayload {
  snap: number;
  k: string;
  s: number;
  fp: string;
}

function fingerprint(q: EventQuery): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        from: q.from || null,
        to: q.to || null,
        kinds: (q.kinds || []).slice().sort(),
        format: q.format || null,
        order: q.order || 'occurred',
        undated: Boolean(q.undated),
        q: q.q || null,
      })
    )
    .digest('hex')
    .slice(0, 16);
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
    if (typeof parsed?.snap === 'number' && typeof parsed?.k === 'string' && typeof parsed?.s === 'number') {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * TA-03 · 本地日历日表达式（服务端唯一口径）。
 *
 * observed_at 由 reconcile 以 `new Date().toISOString()` 写入（UTC），直接 substr 会按
 * UTC 日归属窗口——本机 +08 下凌晨事件会被算到前一天。occurred_at 可能只是纯日期
 * （材料只记载到日），纯日期必须短路、绝不参与时区换算（负时区会把 11-02 移成 11-01）。
 *
 * 因此：长度 ≤ 10 视为纯日期原样返回；含时刻的 ISO 交 SQLite date(...,'localtime') 取
 * 服务端本地日历日（观澜是本地应用，server 与渲染层同机，口径与用户本地日历一致）。
 */
function localDayExpr(column: string): string {
  return `(CASE WHEN length(${column}) <= 10 THEN ${column} ELSE date(${column}, 'localtime') END)`;
}

/**
 * 事件窗口过滤构建器：页查询与窗口计数（total_in_window）共用同一份条件，
 * 消除两处手写过滤链的复写漂移。生成 SQL 与原先逐条复写的实现逐字等价
 * （不含游标条件；游标条件由页查询单独追加）。
 */
function eventWindowFilter(
  query: EventQuery,
  snap: number,
  dateExpr: string,
  formatExpr: string
): { where: string[]; params: Array<string | number> } {
  const where: string[] = ['e.workspace_id = ?', 'e.seq <= ?'];
  const params: Array<string | number> = [query.workspaceId, snap];

  if (query.from) {
    where.push(`${dateExpr} >= ?`);
    params.push(query.from);
  }
  if (query.to) {
    where.push(`${dateExpr} <= ?`);
    params.push(query.to);
  }
  if (query.undated) {
    where.push('e.occurred_at IS NULL');
  }
  if (query.kinds && query.kinds.length) {
    where.push(`e.kind IN (${query.kinds.map(() => '?').join(',')})`);
    params.push(...query.kinds);
  }
  if (query.format) {
    where.push(`${formatExpr} = ?`);
    params.push(query.format);
  }
  if (query.q) {
    where.push('(e.headline LIKE ? OR e.detail LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  return { where, params };
}

export function queryEvents(store: WorkspaceStore, query: EventQuery): EventPage {
  const order: EventOrder = query.order || 'occurred';
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
  const fp = fingerprint(query);
  const ws = store.getWorkspace(query.workspaceId);
  if (!ws) {
    throw Object.assign(new Error('NOT_FOUND'), {
      code: 'NOT_FOUND',
      detail: `未找到工作区 ${query.workspaceId}`,
    });
  }

  const currentMax = store.maxEventSeq(query.workspaceId);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const snap = cursor?.snap ?? currentMax;

  if (cursor && cursor.fp !== fp) {
    // 游标与筛选不一致：拒绝复用，避免跨筛选串页
    throw Object.assign(new Error('INDEX_STALE'), {
      code: 'INDEX_STALE',
      detail: '分页游标绑定的筛选条件与本次请求不一致，请从第一页重新查询。',
    });
  }

  const sortExpr = order === 'observed' ? 'e.observed_at' : "COALESCE(e.occurred_at, '')";
  // TA-03：窗口按本地日历日归属（纯日期短路，含时刻 ISO 按 localtime 取日）
  const dateExpr = order === 'observed' ? localDayExpr('e.observed_at') : localDayExpr('e.occurred_at');
  // 决策事件（revision_id 为空）经 r→f 联表后格式必为 null，从 payload 的 file_id 回填来源文件格式
  const formatExpr = "COALESCE(f.format, df.format)";

  const { where, params } = eventWindowFilter(query, snap, dateExpr, formatExpr);
  if (cursor) {
    where.push(`(${sortExpr} < ? OR (${sortExpr} = ? AND e.seq < ?))`);
    params.push(cursor.k, cursor.k, cursor.s);
  }

  const sql = `
    SELECT e.*, r.file_id AS file_id, f.current_path AS file_path, f.title AS file_title, ${formatExpr} AS format
    FROM events e
    LEFT JOIN revisions r ON e.revision_id = r.revision_id
    LEFT JOIN files f ON r.file_id = f.file_id
    LEFT JOIN files df ON df.file_id = json_extract(e.payload_json,'$.file_id')
    WHERE ${where.join(' AND ')}
    ORDER BY ${sortExpr} DESC, e.seq DESC
    LIMIT ?
  `;

  const rows = store.db.prepare(sql).all(...params, limit + 1) as unknown as Array<
    Record<string, unknown>
  >;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: EventPageItem[] = pageRows.map((row) => ({
    seq: Number(row.seq),
    event_id: String(row.event_id),
    kind: String(row.kind),
    subject_kind: String(row.subject_kind),
    subject_id: String(row.subject_id),
    revision_id: row.revision_id == null ? null : String(row.revision_id),
    occurred_at: row.occurred_at == null ? null : String(row.occurred_at),
    occurred_precision: String(row.occurred_precision),
    occurred_source: row.occurred_source == null ? null : String(row.occurred_source),
    observed_at: String(row.observed_at),
    headline: String(row.headline),
    detail: String(row.detail),
    payload: safeJson(String(row.payload_json ?? '{}')),
    file_id: row.file_id == null ? null : String(row.file_id),
    file_path: row.file_path == null ? null : String(row.file_path),
    file_title: row.file_title == null ? null : String(row.file_title),
    format: row.format == null ? null : String(row.format),
  }));

  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          snap,
          k: order === 'observed' ? last.observed_at : last.occurred_at ?? '',
          s: last.seq,
          fp,
        })
      : null;

  // 窗口统计（不含游标条件）：与页查询共用过滤构建器
  const { where: countWhere, params: countParams } = eventWindowFilter(
    query,
    snap,
    dateExpr,
    formatExpr
  );

  const totalRow = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
       LEFT JOIN revisions r ON e.revision_id = r.revision_id
       LEFT JOIN files f ON r.file_id = f.file_id
       LEFT JOIN files df ON df.file_id = json_extract(e.payload_json,'$.file_id')
       WHERE ${countWhere.join(' AND ')}`
    )
    .get(...countParams) as unknown as { n: number };

  // pm_3：「日期待考 N」与当前类型筛选同口径，否则筛了「提出问题」仍把其他类型的待考事件算进来
  const undatedWhere: string[] = ['e.workspace_id = ?', 'e.occurred_at IS NULL'];
  const undatedParams: Array<string | number> = [query.workspaceId];
  if (query.kinds && query.kinds.length) {
    undatedWhere.push(`e.kind IN (${query.kinds.map(() => '?').join(',')})`);
    undatedParams.push(...query.kinds);
  }

  const undatedRow = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
       LEFT JOIN revisions r ON e.revision_id = r.revision_id
       LEFT JOIN files f ON r.file_id = f.file_id
       WHERE ${undatedWhere.join(' AND ')}`
    )
    .get(...undatedParams) as unknown as { n: number };

  return {
    ok: true,
    index_generation: ws.index_generation,
    window: {
      order,
      from: query.from || null,
      to: query.to || null,
      kinds: query.kinds || [],
      format: query.format || null,
      undated: Boolean(query.undated),
      q: query.q || null,
    },
    snapshot_max_seq: snap,
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    total_in_window: Number(totalRow.n),
    undated_count: Number(undatedRow.n),
    newer_count: Math.max(0, currentMax - snap),
  };
}

/**
 * 事件的实际时间范围（供前端日期选择器使用，替代写死的固定时段）
 * 同时给出「有记载日期」与「仅采集时间」的两类边界。
 */
export function eventTimeRange(
  store: WorkspaceStore,
  workspaceId: string
): {
  occurredMin: string | null;
  occurredMax: string | null;
  observedMin: string | null;
  observedMax: string | null;
  undatedCount: number;
} {
  const row = store.db
    .prepare(
      `SELECT
         MIN(${localDayExpr('occurred_at')}) AS occurred_min,
         MAX(${localDayExpr('occurred_at')}) AS occurred_max,
         MIN(${localDayExpr('observed_at')}) AS observed_min,
         MAX(${localDayExpr('observed_at')}) AS observed_max,
         SUM(CASE WHEN occurred_at IS NULL THEN 1 ELSE 0 END) AS undated
       FROM events WHERE workspace_id = ?`
    )
    .get(workspaceId) as unknown as {
    occurred_min: string | null;
    occurred_max: string | null;
    observed_min: string | null;
    observed_max: string | null;
    undated: number | null;
  };

  return {
    occurredMin: row.occurred_min,
    occurredMax: row.occurred_max,
    observedMin: row.observed_min,
    observedMax: row.observed_max,
    undatedCount: Number(row.undated ?? 0),
  };
}

/**
 * payload_json 解析的单一共用实现（queries 与 project 共用）：
 * 空串 / 非对象 / 解析异常一律回退 {}。输出与原先 queries / project 两份
 * 各自手写的实现恒等（两者仅空串入参的内部路径不同，结果一致）。
 */
export function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ============================================================
// 按日/事项聚合：工程画布的标尺刻度与虚线折叠组
// （方案 §2：一天内同一明确事项的事件放进现有虚线折叠组，组标题显示真实数量）
// ============================================================

export interface EventDayItem {
  event_id: string;
  kind: string;
  headline: string;
  revision_id: string | null;
  file_id: string | null;
  file_path: string | null;
  file_title: string | null;
  file_role: string | null;
  /** 事件真实格式（决策事件从 payload 的 file_id 回填）；无法判定时为 null */
  format: string | null;
  occurred_at: string | null;
  occurred_precision: string;
  observed_at: string;
  /** 时间依据：document_self / file_mtime / collector */
  time_basis: string | null;
  /** 决策动作：raised / conflicted / confirmed / rejected / superseded / shelved */
  action: string | null;
  decision_id: string | null;
  code: string | null;
  status: string | null;
  ref_count: number;
  version_count: number;
  statement_count: number;
}

export type EventDayGranularity = 'day' | 'week' | 'month';

export interface EventDayGroup {
  /** 桶键字符串：day=YYYY-MM-DD；week=该周周一（YYYY-MM-DD）；month=YYYY-MM；空字符串表示「日期待考」 */
  date: string;
  count: number;
  by_kind: Record<string, number>;
  decisions: Array<{ decision_id: string; code: string; status: string; count: number }>;
  formats: Record<string, number>;
  samples: EventDayItem[];
}

export interface EventDaysResult {
  ok: true;
  index_generation: number;
  order: EventOrder;
  /** 本次聚合的桶粒度（day/week/month）；date 字段按此粒度取桶键 */
  granularity: EventDayGranularity;
  from: string | null;
  to: string | null;
  groups: EventDayGroup[];
  total: number;
  /** 因超出 limitDays 而被折叠掉的更早桶数（前端以「更早 N 天/周/月」明示截断） */
  hidden_days: number;
  undated_count: number;
}

export interface EventDaysQuery {
  workspaceId: string;
  from?: string;
  to?: string;
  kinds?: string[];
  format?: 'md' | 'svg' | 'pdf';
  /** 时间口径（与 /events 一致）：occurred = 按材料记载时间；observed = 按观澜采集时间 */
  order?: EventOrder;
  /** 桶粒度：day（默认，逐日）/ week（周一为桶键）/ month（YYYY-MM） */
  granularity?: EventDayGranularity;
  limitDays?: number;
  /** 每桶返回的样本卡片数（画布卡片密度，方案 §5 首屏密度） */
  samplesPerDay?: number;
}

/**
 * 桶键表达式（T03 全工程时间覆盖 + TA-03 本地日口径）：
 * - day = YYYY-MM-DD（本地日历日）
 * - month = YYYY-MM
 * - week = 该日所在周的周一（YYYY-MM-DD）：先回退 6 天再前进到最近的周一，7 天窗口内恰有一个周一
 * occurred 口径锚定 occurred_at（空桶=日期待考）；observed 口径锚定 observed_at。
 * 纯日期不参与时区换算；含时刻 ISO 先经 localDayExpr 取服务端本地日，week/month 基于同一本地日。
 * 空串经 date() 返回 NULL，用 COALESCE 兜回空串桶，保持「日期待考」语义不变。
 */
export function eventDayBucketExpr(order: EventOrder, granularity: EventDayGranularity): string {
  const anchor = order === 'observed' ? 'e.observed_at' : 'e.occurred_at';
  const day = `COALESCE(${localDayExpr(anchor)}, '')`;
  if (granularity === 'month') return `substr(${day},1,7)`;
  if (granularity === 'week') return `COALESCE(date(${day},'-6 days','weekday 1'),'')`;
  return day;
}

export function queryEventDays(store: WorkspaceStore, query: EventDaysQuery): EventDaysResult {
  const ws = store.getWorkspace(query.workspaceId);
  if (!ws) {
    throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND', detail: '未找到工作区' });
  }

  const order: EventOrder = query.order === 'observed' ? 'observed' : 'occurred';
  const granularity: EventDayGranularity =
    query.granularity === 'week' || query.granularity === 'month' ? query.granularity : 'day';
  const bucket = eventDayBucketExpr(order, granularity);
  // from/to 窗口恒按「本地日」过滤（与 /events 的 dateExpr 口径一致），聚合桶粒度只影响分组键
  const dayExpr = localDayExpr(order === 'observed' ? 'e.observed_at' : 'e.occurred_at');
  const limitDays = Math.min(120, Math.max(1, query.limitDays ?? 30));
  const samplesPerDay = Math.min(12, Math.max(1, query.samplesPerDay ?? 4));

  // 决策事件（revision_id 为空）的格式从 payload 的 file_id 回填（df 联表），格式过滤同步生效
  const formatExpr = 'COALESCE(f.format, df.format)';

  const where: string[] = ['e.workspace_id = ?'];
  const params: Array<string | number> = [query.workspaceId];
  if (query.from) {
    where.push(`${dayExpr} >= ?`);
    params.push(query.from);
  }
  if (query.to) {
    where.push(`${dayExpr} <= ?`);
    params.push(query.to);
  }
  if (query.kinds && query.kinds.length) {
    where.push(`e.kind IN (${query.kinds.map(() => '?').join(',')})`);
    params.push(...query.kinds);
  }
  if (query.format) {
    where.push(`${formatExpr} = ?`);
    params.push(query.format);
  }

  const base = `
    FROM events e
    LEFT JOIN revisions r ON e.revision_id = r.revision_id
    LEFT JOIN files f ON r.file_id = f.file_id
    LEFT JOIN files df ON df.file_id = json_extract(e.payload_json,'$.file_id')
    WHERE ${where.join(' AND ')}`;

  // 1) 按桶 × 种类 × 格式计数
  const dailyRows = store.db
    .prepare(
      `SELECT ${bucket} AS d,
              e.kind AS kind, ${formatExpr} AS fmt, COUNT(*) AS n
       ${base}
       GROUP BY d, e.kind, fmt
       ORDER BY d DESC`
    )
    .all(...params) as unknown as Array<{ d: string; kind: string; fmt: string | null; n: number }>;

  // 2) 决策聚合（同一决定在某桶内的事件数）
  //    code/status 必须取组内 seq 最大那条事件的值：同一桶先 decision_raised（待确认）
  //    后 decision_changed（已确认）时，裸列 + GROUP BY (d, decision_id) 会从组内任取一行，
  //    画布会把当天已确认的决定显示成旧状态。这里先聚合出 MAX(e.seq)，再按 seq 精确取该行。
  const decisionRows = store.db
    .prepare(
      `SELECT grouped.d AS d,
              grouped.decision_id AS decision_id,
              json_extract(latest.payload_json,'$.code') AS code,
              json_extract(latest.payload_json,'$.status') AS status,
              grouped.n AS n
       FROM (
         SELECT ${bucket} AS d,
                json_extract(e.payload_json,'$.decision_id') AS decision_id,
                COUNT(*) AS n,
                MAX(e.seq) AS latest_seq
         ${base} AND e.kind IN ('decision_raised','decision_changed')
         GROUP BY d, decision_id
       ) AS grouped
       JOIN events latest ON latest.seq = grouped.latest_seq`
    )
    .all(...params) as unknown as Array<{
    d: string;
    decision_id: string | null;
    code: string | null;
    status: string | null;
    n: number;
  }>;

  // 3) 每桶取最新若干条作为画布卡片样本（窗口函数）
  const sampleRows = store.db
    .prepare(
      `SELECT * FROM (
         SELECT e.event_id, e.kind, e.headline, e.revision_id, e.occurred_at, e.occurred_precision,
                e.observed_at, e.payload_json, f.file_id AS file_id, f.current_path AS file_path,
                f.title AS file_title, f.role AS file_role, ${formatExpr} AS format,
                json_extract(e.payload_json,'$.time_basis') AS time_basis,
                json_extract(e.payload_json,'$.action') AS action,
                json_extract(e.payload_json,'$.decision_id') AS decision_id,
                json_extract(e.payload_json,'$.code') AS code,
                json_extract(e.payload_json,'$.status') AS status,
                (SELECT COUNT(*) FROM edges ed WHERE ed.source_file_id = f.file_id) AS ref_count,
                (SELECT COUNT(*) FROM revisions rv WHERE rv.file_id = f.file_id) AS version_count,
                (SELECT COUNT(*) FROM statements st WHERE st.file_id = f.file_id) AS statement_count,
                ${bucket} AS d,
                ROW_NUMBER() OVER (
                  PARTITION BY ${bucket}
                  -- tf_4/D1：同桶取样优先决策与内容修改类（先于「入库序更新」的首扫新出现），
                  -- 决策/修改事件不再被 seq 更晚的大量 appeared 挤出样本窗口；其余按入库序
                  ORDER BY CASE WHEN e.kind IN ('decision_raised','decision_changed','modified') THEN 0 ELSE 1 END ASC, e.seq DESC
                ) AS rn
         ${base}
       ) WHERE rn <= ?
       ORDER BY d DESC, rn ASC`
    )
    .all(...params, samplesPerDay) as unknown as Array<Record<string, unknown>>;

  const groupMap = new Map<string, EventDayGroup>();
  const ensureGroup = (date: string): EventDayGroup => {
    let g = groupMap.get(date);
    if (!g) {
      g = { date, count: 0, by_kind: {}, decisions: [], formats: {}, samples: [] };
      groupMap.set(date, g);
    }
    return g;
  };

  for (const row of dailyRows) {
    const g = ensureGroup(row.d || '');
    g.count += Number(row.n);
    g.by_kind[row.kind] = (g.by_kind[row.kind] || 0) + Number(row.n);
    if (row.fmt) g.formats[row.fmt] = (g.formats[row.fmt] || 0) + Number(row.n);
  }

  for (const row of decisionRows) {
    if (!row.decision_id) continue;
    const g = ensureGroup(row.d || '');
    g.decisions.push({
      decision_id: row.decision_id,
      code: row.code || '—',
      status: row.status || '未知',
      count: Number(row.n),
    });
  }

  for (const row of sampleRows) {
    const g = ensureGroup(String(row.d || ''));
    g.samples.push({
      event_id: String(row.event_id),
      kind: String(row.kind),
      headline: String(row.headline),
      revision_id: row.revision_id == null ? null : String(row.revision_id),
      file_id: row.file_id == null ? null : String(row.file_id),
      file_path: row.file_path == null ? null : String(row.file_path),
      file_title: row.file_title == null ? null : String(row.file_title),
      file_role: row.file_role == null ? null : String(row.file_role),
      format: row.format == null ? null : String(row.format),
      occurred_at: row.occurred_at == null ? null : String(row.occurred_at),
      occurred_precision: String(row.occurred_precision),
      observed_at: String(row.observed_at),
      time_basis: row.time_basis == null ? null : String(row.time_basis),
      action: row.action == null ? null : String(row.action),
      decision_id: row.decision_id == null ? null : String(row.decision_id),
      code: row.code == null ? null : String(row.code),
      status: row.status == null ? null : String(row.status),
      ref_count: Number(row.ref_count || 0),
      version_count: Number(row.version_count || 0),
      statement_count: Number(row.statement_count || 0),
    });
  }

  const total = Array.from(groupMap.values()).reduce((sum, g) => sum + g.count, 0);
  const undated = groupMap.get('');

  // 有日期的组按桶键倒序（day/month/week 的键均为可排序的 YYYY-MM-DD / YYYY-MM）；
  // 「日期待考」永远排在最后（方案 §3）
  const groups = Array.from(groupMap.values())
    .filter((g) => g.date !== '')
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limitDays);

  // 因 limitDays 截断掉的更早桶数：前端据此给出「更早 N 天/周/月」提示刻度，不再静默消失
  const datedBucketTotal = Array.from(groupMap.keys()).filter((k) => k !== '').length;
  const hiddenDays = Math.max(0, datedBucketTotal - groups.length);

  if (undated && undated.count > 0) groups.push(undated);

  return {
    ok: true,
    index_generation: ws.index_generation,
    order,
    granularity,
    from: query.from || null,
    to: query.to || null,
    groups,
    total,
    hidden_days: hiddenDays,
    undated_count: undated?.count ?? 0,
  };
}
