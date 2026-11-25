/**
 * 时间口径统一的单一出口。
 *
 * 背景：observed_at 由服务端 reconcile 以 `new Date().toISOString()` 写入（UTC），
 * 直接 slice 会显示 UTC 挂钟（本机 +08 下慢 8 小时、跨零点错日）；occurred_at 可能是
 * 纯日期（材料只记载到日）也可能是含时刻的 ISO。两种形态必须分开处理：
 * - 纯日期（长度 ≤ 10）不做时区换算，原样截取，绝不把 11-02 移成 11-01；
 * - 含时刻的 ISO 一律按本地时区（或显式 timeZone）取日历日与时钟。
 *
 * 同时承载卡片时刻口径：列表默认按 occurred 排序，卡片就必须显示 occurred；
 * 三值依据（文档自述 / 文件时间 / 采集）与版本时光机的口径保持同源。
 */

// ---------- 基础格式化 ----------

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // h23：午夜输出 00 而不是 24，避免跨零点错位
      hourCycle: 'h23',
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function localPartsOf(iso: string, timeZone?: string): LocalParts | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const bag: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  const { year, month, day, hour, minute } = bag;
  if (!year || !month || !day || !hour || !minute) return null;
  return { year, month, day, hour, minute };
}

/** 纯日期（如 '2026-11-02'）：不做时区换算。 */
function isDateOnly(iso: string): boolean {
  return iso.length <= 10;
}

/**
 * 展示用时刻：含时刻 ISO 按本地时区输出『MM-DD HH:mm』；
 * 纯日期输出『MM-DD』（无尾空格）。解析失败时原样返回，不抛错。
 */
export function formatLocalStamp(iso: string, timeZone?: string): string {
  if (!iso) return '';
  if (isDateOnly(iso)) return iso.length >= 10 ? iso.slice(5, 10) : iso;
  const parts = localPartsOf(iso, timeZone);
  if (!parts) return iso;
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * 本地日历日（YYYY-MM-DD）：纯日期原样返回；含时刻 ISO 按本地时区取日。
 * 用于日期筛选、日桶与日历定位——与服务端 SQLite 的 date(...,'localtime') 同一口径。
 */
export function localDay(iso: string, timeZone?: string): string {
  if (!iso) return '';
  if (isDateOnly(iso)) return iso;
  const parts = localPartsOf(iso, timeZone);
  if (!parts) return iso.slice(0, 10);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 仅时钟『HH:mm』；纯日期/解析失败返回空串（调用方自行落 '—'）。 */
export function formatLocalClock(iso: string, timeZone?: string): string {
  if (!iso || isDateOnly(iso)) return '';
  const parts = localPartsOf(iso, timeZone);
  return parts ? `${parts.hour}:${parts.minute}` : '';
}

/** 完整本地日期时间『YYYY-MM-DD HH:mm』；纯日期原样返回。 */
export function formatLocalDateTime(iso: string, timeZone?: string): string {
  if (!iso) return '';
  if (isDateOnly(iso)) return iso;
  const parts = localPartsOf(iso, timeZone);
  if (!parts) return iso;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * observed_at（ISO 毫秒串）→ 人话相对时间（ReaderView 域迁入，
 * 消解与 documentDiff.formatObservedAt（绝对戳口径）的同名异义）。
 * 一律按本地时区手拼字段，勿用 toISOString 截断（防 UTC 偏移）。
 * 供阅读器/顶栏/时间线等「多久以前」叙述位复用；绝对戳位走 formatLocalStamp。
 */
export function formatRelativeObservedAt(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const now = new Date();
  const diffMinutes = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (diffMinutes < 60) return `${Math.max(0, diffMinutes)}分钟前`;
  if (diffMinutes < 24 * 60) return `${Math.floor(diffMinutes / 60)}小时前`;

  const pad2 = (value: number) => String(value).padStart(2, '0');
  const hhmm = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  const isSameLocalDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  if (isSameLocalDay(then, now)) return `今天 ${hhmm}`;
  if (isSameLocalDay(then, yesterday)) return `昨天 ${hhmm}`;
  if (then.getFullYear() === now.getFullYear()) {
    return `${pad2(then.getMonth() + 1)}-${pad2(then.getDate())} ${hhmm}`;
  }
  return `${then.getFullYear()}-${pad2(then.getMonth() + 1)}-${pad2(then.getDate())}`;
}

// ---------- 三值时间依据 ----------

export type TimeBasisLabel = '文档自述' | '文件时间' | '采集';

/**
 * 时间依据三值标注（口径同 FileTimelineDrawer.tsx timeBasisLabel：
 * document_self→文档自述、file_mtime→文件时间、其余/缺失→采集）。
 */
export function timeBasisLabel(source: string | null | undefined): TimeBasisLabel {
  if (source === 'document_self') return '文档自述';
  if (source === 'file_mtime') return '文件时间';
  return '采集';
}

// ---------- 列表卡片时刻 ----------

export type EventTimeOrder = 'occurred' | 'observed';

/** eventCardStamp / eventFilterDay 的最小结构，TimelineEvent 与 EventPageItem 映射后均满足。 */
export interface CardTimeEvent {
  observed_at: string;
  source_time?: string;
  occurred_source?: string | null;
  occurred_precision?: string | null;
}

export interface EventCardStamp {
  /** 卡片可见时刻：occurred 口径取发生时间，缺失/observed 口径取采集时间 */
  stamp: string;
  /** 可见时刻的依据：文档自述 / 文件时间 / 采集 */
  basis: TimeBasisLabel;
  /** 作为依据的原始字符串（occurred_at 或 observed_at），供卡根 title 溯源 */
  raw: string;
  /** occurred_precision='day'（或纯日期）时只出日期 */
  dayOnly: boolean;
  /** 可见时刻是否取自 occurred_at */
  fromOccurred: boolean;
  /** 归入的本地日历日（occurred 口径取发生日；observed 口径取观察日） */
  day: string;
}

/**
 * 列表卡片时刻：与页头自述、排序字段同一口径。
 * - occurred 口径且有 occurred_at → 显示 occurred（day 精度只出日期），依据取 occurred_source；
 * - occurred 口径但无 occurred_at → 回退 observed 并标『采集』；
 * - observed 口径 → 显示 observed 并标『采集』。
 */
export function eventCardStamp(
  ev: CardTimeEvent,
  order: EventTimeOrder
): EventCardStamp {
  const occurred = ev.source_time || '';
  if (order === 'occurred' && occurred) {
    const dayOnly = ev.occurred_precision === 'day' || occurred.length <= 10;
    const stamp = dayOnly ? localDay(occurred).slice(5) : formatLocalStamp(occurred);
    return {
      stamp: stamp || occurred,
      basis: timeBasisLabel(ev.occurred_source),
      raw: occurred,
      dayOnly,
      fromOccurred: true,
      day: localDay(occurred),
    };
  }
  const observed = ev.observed_at || '';
  return {
    stamp: formatLocalStamp(observed),
    basis: '采集',
    raw: observed,
    dayOnly: false,
    fromOccurred: false,
    day: localDay(observed),
  };
}

/**
 * 日期筛选的单一口径（与分页态 /events 的服务端 dateExpr 同源）：
 * observed 口径取观察日；occurred 口径取发生日，发生时间缺失（日期待考）不归属任何具体日。
 * 离线兜底不再“observed 或 occurred 任一命中”，避免同一筛选下两套日历口径并存。
 */
export function eventFilterDay(
  ev: CardTimeEvent,
  order: EventTimeOrder
): string | null {
  if (order === 'observed') return localDay(ev.observed_at) || null;
  const occurred = ev.source_time || '';
  return occurred ? localDay(occurred) || null : null;
}
