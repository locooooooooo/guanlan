
import type {
  EventDayGranularity,
  EventDayGroup,
  EventDayItem,
  EventDaysResult,
} from '../services/workspaceClient';
import type { FileFormat, FileRecord, TimelineEvent } from '../types/guanlan';
import { formatLocalClock, localDay } from './timeFormat';
import { mergeDayRevisions, type DayRevisionMerge } from './taskPackages';
import {
  groupFilesIntoPackages,
  type PackageKind,
  type StageRole,
} from './taskPackages';
import { getFilePreviewEntry } from './filePreviewCache';

export type CanvasCapability = 'MD' | 'DEC' | 'REV' | 'SVG' | 'TIM' | 'PDF' | 'REL';

export interface CanvasEventCard {
  slotId: string;
  eventId: string;
  fileId: string;
  revisionId: string | null;
  decisionId: string | null;
  kind: string;
  kindLabel: string;
  fileName: string;
  dirPrefix: string;
  changeLabel: string;
  cornerLabel: string;
  mergedCount?: number;
  mergedBucketTotal?: number;
  mergedDay?: DayRevisionMerge;
  observedClock: string;
  dateLabel: string;
  bucketDate: string;
  format: string | null;
  roleLabel: string;
  activeBadges: CanvasCapability[];
  highlightedBadges: CanvasCapability[];
  refs: number;
  versions: number;
  statements: number;
  detail: string;
}

export interface CanvasDayGroup {
  date: string;
  label: string;
  count: number;
  matterCount: number;
  kinds: Record<string, number>;
  formats: Record<string, number>;
  matters: Array<{ id: string; code: string; status: string; count: number }>;
  cards: CanvasEventCard[];
  more: number;
}

export interface CanvasNavigatorEntry {
  date: string;
  label: string;
  count: number;
  format: FileFormat | null;
  formats: Record<string, number>;
}

export interface CanvasRulerTick {
  date: string;
  label: string;
  count: number;
  kinds: Record<string, number>;
  formats: Record<string, number>;
  hasEvents: boolean;
  granularity?: EventDayGranularity;
  isTruncation?: boolean;
  hiddenDays?: number;
  isGap?: boolean;
  gapDays?: number;
}

/** 截断提示刻度的哨兵桶键：绝不与真实桶键（YYYY-MM…）碰撞 */
export const TRUNCATION_TICK_DATE = '__earlier__';

export interface CanvasEventScene {
  days: CanvasDayGroup[];
  navigator: CanvasNavigatorEntry[];
  ruler: CanvasRulerTick[];
  active: CanvasDayGroup | null;
  activeDate: string;
  granularity: EventDayGranularity;
  totals: { events: number; days: number; undated: number; matters: number };
  hasRealEvents: boolean;
}

const SLOT_IDS = ['sub_01', 'sub_02', 'sub_03', 'sub_04', 'sub_05', 'sub_06', 'sub_07', 'sub_08'];

/** 事件类型到界面用词的映射。
 *  参数放宽为「kind 必有、time_basis/action 可缺」——列表态事件只保证 kind，
 *  时间依据与动作由服务端 payload 透出。补齐 discovered / moved_or_copied，
 *  避免默认分支把英文 kind 直接当界面词（列表卡与画布同一套词）。 */
export interface EventKindLabelInput {
  kind: string;
  time_basis?: string | null;
  action?: string | null;
}

export function eventKindLabel(item: EventKindLabelInput): string {
  switch (item.kind) {
    case 'discovered':
      return '首次扫描';
    case 'workspace_baseline':
      return '首次接入';
    case 'appeared':
      if (item.time_basis === 'document_self') return '文档自述日期';
      if (item.time_basis === 'file_mtime') return '新出现（文件时间）';
      return '新出现';
    case 'modified':
      return '内容修改';
    case 'moved_or_copied':
      return '同哈希副本';
    case 'file_renamed':
      return '重命名';
    case 'file_moved':
      return '移动路径';
    case 'file_trashed':
      return '移入回收站';
    case 'decision_raised':
      return item.action === 'conflicted' ? '来源不一致' : '提出问题';
    case 'decision_changed':
      switch (item.action) {
        case 'confirmed':
          return '来源记载已确认';
        case 'rejected':
          return '被否决';
        case 'superseded':
          return '被取代';
        case 'shelved':
          return '已搁置';
        default:
          return '决策更新';
      }
    case 'missing':
      return '路径不可访问';
    case 'read_error':
      return '读取问题';
    case 'read_recovered':
      return '读取恢复';
    default:
      return item.kind;
  }
}

function shortPath(path: string | null, title: string | null): string {
  if (title) return title;
  if (!path) return '—';
  const base = path.replace(/\\/g, '/').split('/').pop() || path;
  return base.replace(/\.(md|markdown|svg|pdf)$/i, '');
}

function parentDir(item: EventDayItem): string {
  const path = item.file_path?.replace(/\\/g, '/');
  if (!path) return '';
  const parts = path.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

/** 语义徽章中文分类（与画布 BADGE_SEMANTIC_LABELS 同源；卡角标 [分类] HH:MM 用） */
export const CANVAS_SEMANTIC_LABELS: Record<CanvasCapability, string> = {
  MD: '方案',
  DEC: '决策',
  REV: '版本',
  SVG: '图纸',
  TIM: '轮次',
  PDF: '规范',
  REL: '引用',
};

function formatOf(item: EventDayItem): string | null {
  const f = item.format?.trim().toLowerCase();
  return f ? f : null;
}

function capabilityOfFormat(format: string | null): CanvasCapability | null {
  if (format === 'md' || format === 'markdown') return 'MD';
  if (format === 'svg') return 'SVG';
  if (format === 'pdf') return 'PDF';
  return null;
}

/** 把一条事件映射为画布卡片（两行制：行1 文件名+变更段，行2 摘要，底行 HH:MM 角标）。
 *  ambiguous：同组内重名的文件基名集合，命中时 dirPrefix 补目录前缀区分。 */
export function toCanvasCard(
  item: EventDayItem,
  slotIndex: number,
  ambiguous: Set<string> = new Set(),
  bucketDate: string = ''
): CanvasEventCard {
  const format = formatOf(item);
  const kindLabel = eventKindLabel(item);
  const isDecision = item.kind === 'decision_raised' || item.kind === 'decision_changed';
  const name = shortPath(item.file_path, item.file_title);

  const fileName = isDecision ? `${item.code ?? '—'} ${kindLabel}` : name;
  const dirPrefix = !isDecision && ambiguous.has(name) ? parentDir(item) : '';

  const cap = capabilityOfFormat(format);
  const activeBadges: CanvasCapability[] = [];
  if (isDecision) activeBadges.push('DEC', 'REL');
  else {
    if (cap) activeBadges.push(cap);
    if (item.kind === 'modified') activeBadges.push('REV', 'TIM');
    if (item.kind === 'appeared' && item.time_basis === 'document_self') activeBadges.push('TIM');
    if (item.ref_count > 0) activeBadges.push('REL');
    if (item.version_count > 1) activeBadges.push('REV');
  }

  const highlighted: CanvasCapability[] = [];
  if (isDecision) highlighted.push('DEC');
  else if (item.kind === 'modified') {
    highlighted.push('REV');
    if (cap) highlighted.push(cap);
  } else if (item.time_basis === 'document_self') highlighted.push('TIM');

  const observedClock = formatLocalClock(item.observed_at);
  const cornerLabel = observedClock;

  return {
    slotId: SLOT_IDS[slotIndex % SLOT_IDS.length],
    eventId: item.event_id,
    fileId: item.file_id || '',
    revisionId: item.revision_id,
    decisionId: item.decision_id,
    kind: item.kind,
    kindLabel,
    fileName,
    dirPrefix,
    changeLabel: '',
    cornerLabel,
    observedClock,
    dateLabel: item.occurred_at ? localDay(item.occurred_at) : '日期待考',
    bucketDate,
    format,
    roleLabel: format
      ? item.file_role
        ? `${format.toUpperCase()} ${item.file_role}`
        : format.toUpperCase()
      : item.file_role || '—',
    activeBadges: Array.from(new Set(activeBadges)),
    highlightedBadges: Array.from(new Set(highlighted)),
    refs: item.ref_count,
    versions: item.version_count,
    statements: item.statement_count,
    detail: item.headline,
  };
}

function groupLabel(date: string): string {
  return date || '日期待考';
}

const SAMPLES_MERGE_MIN = 3;

function toGroup(
  group: EventDayGroup,
  slotOffset: number,
  maxCards: number,
  resolveVersion?: (revisionId: string | null) => number | null
): CanvasDayGroup {
  const nameCounts = new Map<string, number>();
  for (const s of group.samples) {
    const n = shortPath(s.file_path, s.file_title);
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  const ambiguous = new Set(
    Array.from(nameCounts.entries())
      .filter(([, c]) => c > 1)
      .map(([n]) => n)
  );

  const tierOf = (s: EventDayItem): number =>
    s.kind === 'decision_raised' || s.kind === 'decision_changed' || s.kind === 'modified' ? 0 : 1;

  const mergedByFile = new Map<
    string,
    { merge: DayRevisionMerge; representative: EventDayItem; consumedCount: number }
  >();
  let samplePool: EventDayItem[];
  if (resolveVersion) {
    samplePool = [];
    for (const m of mergeDayRevisions(group.samples, resolveVersion)) {
      const members = group.samples.filter((s) => s.file_id === m.fileId);
      let rep = members[0];
      for (const x of members) if (x.observed_at > rep.observed_at) rep = x;
      mergedByFile.set(m.fileId, { merge: m, representative: rep, consumedCount: members.length });
      samplePool.push(rep);
    }
    for (const s of group.samples) if (!s.file_id) samplePool.push(s);
  } else {
    samplePool = [...group.samples];
  }

  const orderedSamples = [...samplePool].sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    const ka = a.occurred_at || a.observed_at;
    const kb = b.occurred_at || b.observed_at;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });

  const isDecisionSample = (s: EventDayItem) =>
    s.kind === 'decision_raised' || s.kind === 'decision_changed';
  const distinctFilesByName = new Map<string, Set<string>>();
  for (const s of orderedSamples) {
    if (isDecisionSample(s) || !s.file_id) continue;
    const n = shortPath(s.file_path, s.file_title);
    const set = distinctFilesByName.get(n);
    if (set) set.add(s.file_id);
    else distinctFilesByName.set(n, new Set([s.file_id]));
  }

  const cards: CanvasEventCard[] = [];
  const consumed = new Set<string>();
  let representedSamples = 0;
  for (const s of orderedSamples) {
    if (cards.length >= maxCards) break;
    if (consumed.has(s.event_id)) continue;
    const name = shortPath(s.file_path, s.file_title);
    const distinct = !isDecisionSample(s) && s.file_id ? distinctFilesByName.get(name) : undefined;
    const mergedInfo = s.file_id ? mergedByFile.get(s.file_id) : undefined;
    if (distinct && distinct.size >= SAMPLES_MERGE_MIN) {
      const members: EventDayItem[] = [];
      const seenFiles = new Set<string>();
      for (const x of orderedSamples) {
        if (consumed.has(x.event_id) || isDecisionSample(x) || !x.file_id) continue;
        if (seenFiles.has(x.file_id)) continue;
        if (shortPath(x.file_path, x.file_title) !== name) continue;
        seenFiles.add(x.file_id);
        members.push(x);
      }
      for (const x of members) consumed.add(x.event_id);
      const representative = members[0];
      const merged = toCanvasCard(representative, slotOffset + cards.length, new Set(), group.date);
      const memberRawCount = members.reduce(
        (sum, x) => sum + (mergedByFile.get(x.file_id ?? '')?.consumedCount ?? 1),
        0
      );
      const leadingMerge = representative.file_id
        ? mergedByFile.get(representative.file_id)?.merge
        : undefined;
      cards.push({
        ...merged,
        dirPrefix: '',
        detail: `×${members.length} 样本内同基名拷贝 · ${representative.headline}`,
        mergedCount: members.length,
        mergedBucketTotal: group.count,
        ...(leadingMerge && leadingMerge.merged ? { mergedDay: leadingMerge } : {}),
      });
      representedSamples += memberRawCount;
      continue;
    }
    consumed.add(s.event_id);
    const card = toCanvasCard(s, slotOffset + cards.length, ambiguous, group.date);
    if (mergedInfo && mergedInfo.merge.merged) {
      cards.push({ ...card, mergedDay: mergedInfo.merge });
      representedSamples += mergedInfo.consumedCount;
    } else {
      cards.push(card);
      representedSamples += 1;
    }
  }

  const mattersMap = new Map<string, { id: string; code: string; status: string; count: number }>();
  for (const d of group.decisions) {
    const existing = mattersMap.get(d.decision_id);
    if (existing) existing.count += d.count;
    else mattersMap.set(d.decision_id, { id: d.decision_id, code: d.code, status: d.status, count: d.count });
  }

  return {
    date: group.date,
    label: groupLabel(group.date),
    count: group.count,
    matterCount: mattersMap.size,
    kinds: group.by_kind,
    formats: group.formats || {},
    matters: Array.from(mattersMap.values()),
    cards,
    more: Math.max(0, group.count - representedSamples),
  };
}

function dayTime(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  return Number.isFinite(t) ? t : null;
}

/** 标尺刻度标签按桶粒度分支（T03）：日=MM-DD；周=MM-DD 周起（周一）；月=YYYY-MM */
export function bucketTickLabel(date: string, granularity: EventDayGranularity): string {
  if (granularity === 'month') return date;
  if (granularity === 'week') return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5)} 周起` : date;
  return date.slice(5);
}

/**
 * 聚合桶 → 日粒度的查询窗口（点聚合刻度「下钻到日」时取数用）：
 * - month（YYYY-MM）→ 当月 1 日至月末
 * - week（该周周一 YYYY-MM-DD）→ 周一至周日
 * - day → 当日
 * 无法识别的桶键返回 null。
 */
export function bucketRange(
  date: string,
  granularity: EventDayGranularity
): { from: string; to: string } | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (granularity === 'month') {
    if (!/^\d{4}-\d{2}$/.test(date)) return null;
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${date}-01`, to: `${date}-${pad(lastDay)}` };
  }
  const t = dayTime(date);
  if (t === null) return null;
  if (granularity === 'week') {
    const to = new Date(t + 6 * 86_400_000).toISOString().slice(0, 10);
    return { from: date, to };
  }
  return { from: date, to: date };
}

function buildCalendarRuler(groups: EventDayGroup[]): CanvasRulerTick[] {
  const datedAsc = groups
    .filter((g) => g.date !== '' && dayTime(g.date) !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (datedAsc.length === 0) return [];

  const byDate = new Map(datedAsc.map((g) => [g.date, g]));
  const startT = dayTime(datedAsc[0].date)!;
  const endT = dayTime(datedAsc[datedAsc.length - 1].date)!;
  const DAY_MS = 86_400_000;

  const ruler: CanvasRulerTick[] = [];
  for (let t = endT; t >= startT; t -= DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const g = byDate.get(date);
    ruler.push(
      g
        ? {
            date,
            label: date.slice(5),
            count: g.count,
            kinds: g.by_kind,
            formats: g.formats,
            hasEvents: true,
          }
        : { date, label: date.slice(5), count: 0, kinds: {}, formats: {}, hasEvents: false }
    );
  }
  return ruler;
}

function buildBucketRuler(groups: EventDayGroup[], granularity: EventDayGranularity): CanvasRulerTick[] {
  return groups
    .filter((g) => g.date !== '')
    .map((g) => ({
      date: g.date,
      label: bucketTickLabel(g.date, granularity),
      count: g.count,
      kinds: g.by_kind,
      formats: g.formats,
      hasEvents: g.count > 0,
      granularity,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function truncationTick(hidden: number, granularity: EventDayGranularity): CanvasRulerTick {
  const unit = granularity === 'month' ? '月' : granularity === 'week' ? '周' : '天';
  return {
    date: TRUNCATION_TICK_DATE,
    label: `更早 ${hidden} ${unit}`,
    count: 0,
    kinds: {},
    formats: {},
    hasEvents: false,
    granularity,
    isTruncation: true,
    hiddenDays: hidden,
  };
}

/** 画布场景构建选项。
 *  resolveVersion 为可选注入——revision_id → versionNumber 解析器（由调用方从
 *  FileRecord.revisions 查表注入；EventDayItem 无版本号，禁止伪造）。缺省 = 同日同文件
 *  合并关闭，toGroup 保持逐卡展示。 */
export interface CanvasSceneBuildOptions {
  activeDate?: string;
  maxCardsPerGroup?: number;
  resolveVersion?: (revisionId: string | null) => number | null;
}

/**
 * 同日期桶去重：日期轴数据源头铁律——同一桶键（YYYY-MM-DD / 周一 /
 * YYYY-MM / '' 待考）在下游（scene.days 折叠组、navigator 日期卡、主干标尺刻度）
 * 只允许出现 1 次。上游若给出重复桶（同日多份分组），主干轴会重复渲染同一日期刻度
 * （如 11-13/11-14 各出现多次的穿帮），故在场景构建入口并组：
 * count / by_kind / formats 求和，decisions / samples 按原相对序拼接，桶位置取首现处。
 * 纯函数、无副作用；不改动互异日期桶的任何字段。
 */
export function dedupeEventGroupsByDate(groups: EventDayGroup[]): EventDayGroup[] {
  const merged = new Map<string, EventDayGroup>();
  const order: string[] = [];
  for (const g of groups) {
    const existing = merged.get(g.date);
    if (!existing) {
      merged.set(g.date, { ...g });
      order.push(g.date);
      continue;
    }
    const byKind = { ...existing.by_kind };
    for (const [kind, n] of Object.entries(g.by_kind)) {
      byKind[kind] = (byKind[kind] ?? 0) + n;
    }
    const formats = { ...existing.formats };
    for (const [f, n] of Object.entries(g.formats)) {
      formats[f] = (formats[f] ?? 0) + n;
    }
    merged.set(g.date, {
      date: existing.date,
      count: existing.count + g.count,
      by_kind: byKind,
      formats,
      decisions: [...existing.decisions, ...g.decisions],
      samples: [...existing.samples, ...g.samples],
    });
  }
  return order.map((date) => merged.get(date)!);
}

/**
 * 主干刻度渲染侧硬护栏：把喂给主干轴渲染的刻度序列按桶键做严格去重
 * ——按日期字符串 Set 保序（保留首现刻度）。
 *
 * 为什么渲染前还要再过一道：scene 入口虽已有 dedupeEventGroupsByDate 源头并组，
 * 但渲染侧仍不信任上游数组：主干里程碑标签、标签步长、司辰锚 y、日期卡锚 y、
 * panToDate 命中 y 全部改为消费本函数产物（GraphCanvasView.trunkTicks 单一序列），
 * 无论上游给出什么，同一日期在主干轴上恒恰好 1 个刻度/标签。
 * 纯函数；无重复桶时零改写（逐字等价返回）。
 */
export function dedupeTicksByDate(ticks: CanvasRulerTick[]): CanvasRulerTick[] {
  const seen = new Set<string>();
  const out: CanvasRulerTick[] = [];
  for (const t of ticks) {
    if (seen.has(t.date)) continue;
    seen.add(t.date);
    out.push(t);
  }
  return out;
}

function formatRulerGapLabel(days: number): string {
  if (days >= 365) {
    const years = Math.max(1, Math.round(days / 365));
    return `⋯ 跨越 ${years} 年 ⋯`;
  }
  if (days >= 60) {
    const months = Math.max(2, Math.round(days / 30));
    return `⋯ 空档 ${months} 个月 ⋯`;
  }
  return `⋯ 空档 ${days} 天 ⋯`;
}

/**
 * 渲染侧主干空档压缩：当逐日标尺中存在超过 `maxEmptyRun` 天的连续 0 事件空档
 * （例如存在 2013 年旧 PDF 导致 2013~2026 展开出 4,700+ 枚空点，把近期活跃日全部压挤到主干顶端 5px 内，
 * 且 365 天步长丢掉年份后造成 11-22 / 11-23 / 11-24 重复标签）时，将每段长空档折叠为
 * 单枚显式断层标记（`isGap: true`）。有事件日、短空档（≤ maxEmptyRun 天）、周/月桶与截断刻度保持原样。
 */
export function compressEmptyRulerGaps(
  ticks: CanvasRulerTick[],
  maxEmptyRun = 14
): CanvasRulerTick[] {
  if (ticks.length <= maxEmptyRun + 2) return ticks;
  const out: CanvasRulerTick[] = [];
  let emptyRun: CanvasRulerTick[] = [];

  const flushRun = () => {
    if (emptyRun.length === 0) return;
    if (emptyRun.length > maxEmptyRun) {
      const newestEmpty = emptyRun[0];
      const oldestEmpty = emptyRun[emptyRun.length - 1];
      out.push({
        date: `__gap__${oldestEmpty.date}..${newestEmpty.date}`,
        label: formatRulerGapLabel(emptyRun.length),
        count: 0,
        kinds: {},
        formats: {},
        hasEvents: false,
        isGap: true,
        gapDays: emptyRun.length,
      });
    } else {
      out.push(...emptyRun);
    }
    emptyRun = [];
  };

  for (const t of ticks) {
    const isCompressibleEmptyDay =
      !t.hasEvents &&
      !t.isTruncation &&
      !t.isGap &&
      (!t.granularity || t.granularity === 'day') &&
      /^\d{4}-\d{2}-\d{2}$/.test(t.date);
    if (isCompressibleEmptyDay) {
      emptyRun.push(t);
    } else {
      flushRun();
      out.push(t);
    }
  }
  flushRun();
  return out;
}

/**
 * 主干刻度展示标签：单年内沿用简洁 `MM-DD`；跨年刻度或大步长跨年时补出年份
 * （`YYYY-MM-DD` / `YYYY-MM`），彻底杜绝闰年 365 步长产出重复的 `11-22 / 11-23 / 11-24`。
 */
export function formatTrunkTickLabel(
  tick: CanvasRulerTick,
  latestYear: string,
  step: number
): string {
  if (tick.isTruncation || tick.isGap) return tick.label;
  if (tick.granularity && tick.granularity !== 'day') return tick.label;
  if (/^\d{4}-\d{2}-\d{2}$/.test(tick.date)) {
    const year = tick.date.slice(0, 4);
    if (step >= 180) return tick.date.slice(0, 7);
    if (latestYear && year !== latestYear) return tick.date;
  }
  return tick.label;
}

/**
 * 构建画布场景。
 * activeDate 指定当前日期（点日期组看当天事项）；未指定时取最新一天。
 * 传 '' 表示查看「日期待考」。
 * 入口先过 dedupeEventGroupsByDate——days/groups 与标尺同源，重复桶
 * 在此一次性收敛，下游 scene.days/navigator/ruler 天然满足「同日期 ≤1 次」。
 */
export function buildCanvasEventScene(
  days: EventDaysResult | null,
  options: CanvasSceneBuildOptions = {}
): CanvasEventScene {
  const maxCards = Math.min(8, Math.max(1, options.maxCardsPerGroup ?? 6));
  const granularity: EventDayGranularity = days?.granularity ?? 'day';

  if (!days || !Array.isArray(days.groups) || days.groups.length === 0) {
    return {
      days: [],
      navigator: [],
      ruler: [],
      active: null,
      activeDate: options.activeDate ?? '',
      granularity,
      totals: { events: 0, days: 0, undated: 0, matters: 0 },
      hasRealEvents: false,
    };
  }

  const dedupedGroups = dedupeEventGroupsByDate(days.groups);
  let slotCursor = 0;
  const groups: CanvasDayGroup[] = dedupedGroups.map((g) => {
    const model = toGroup(g, slotCursor, maxCards, options.resolveVersion);
    slotCursor += model.cards.length;
    return model;
  });

  const requested = options.activeDate;
  const active =
    (requested !== undefined ? groups.find((g) => g.date === requested) : undefined) ??
    groups.find((g) => g.date !== '') ??
    groups[0] ??
    null;

  const dated = groups.filter((g) => g.date !== '');

  const navigator: CanvasNavigatorEntry[] = groups.slice(0, 4).map((g) => {
    const format =
      (Object.entries(g.formats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) as CanvasNavigatorEntry['format'];
    return { date: g.date, label: g.label, count: g.count, format, formats: g.formats };
  });

  const hiddenDays = Math.max(0, Number(days.hidden_days) || 0);
  const ruler: CanvasRulerTick[] =
    granularity === 'day'
      ? buildCalendarRuler(dedupedGroups)
      : buildBucketRuler(dedupedGroups, granularity);
  if (hiddenDays > 0 && ruler.length > 0) {
    ruler.push(truncationTick(hiddenDays, granularity));
  }

  const matters = new Set<string>();
  for (const g of groups) for (const m of g.matters) matters.add(m.id);

  return {
    days: groups,
    navigator,
    ruler,
    active,
    activeDate: active?.date ?? '',
    granularity,
    totals: {
      events: groups.reduce((sum, g) => sum + g.count, 0),
      days: dated.length,
      undated: groups.find((g) => g.date === '')?.count ?? 0,
      matters: matters.size,
    },
    hasRealEvents: true,
  };
}


export interface SameFileDayVersionItem {
  eventId: string;
  fileId: string;
  kind: string;
  day: string;
  versionNumber: number | null;
}

export interface SameFileDayVersionGroup {
  key: string;
  fileId: string;
  day: string;
  indices: number[];
  eventIds: string[];
  count: number;
  versionMin: number | null;
  versionMax: number | null;
}

/** 参与折叠的事件类型：同一文件同一天的「新出现 + 内容修改」= 一次连续演进。
 *  决策、移动/拷贝、缺失、读取问题等语义不同的事件不并入——避免把不同事由
 *  折成一串假版本历史（时间语义只按修订链，不做跨语义合并）。 */
export const VERSION_HISTORY_KINDS: readonly string[] = ['appeared', 'modified'];

/** 把事件序列折叠成「同文件同日多版本」组。
 *  只有成员数 ≥ 2 的桶才成组；单条事件不进 indexToGroup，渲染路径与旧版逐字一致。
 *  返回的 groups 按首个成员下标升序（= 保持「上新下旧」的落位）。 */
export function foldSameFileDayVersions(items: SameFileDayVersionItem[]): {
  groups: SameFileDayVersionGroup[];
  indexToGroup: Map<number, SameFileDayVersionGroup>;
} {
  const buckets = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (!item.fileId || !item.day) return;
    if (!VERSION_HISTORY_KINDS.includes(item.kind)) return;
    const key = `${item.fileId}|${item.day}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });

  const groups: SameFileDayVersionGroup[] = [];
  const indexToGroup = new Map<number, SameFileDayVersionGroup>();

  buckets.forEach((indices, key) => {
    if (indices.length < 2) return;
    const versions = indices
      .map((i) => items[i].versionNumber)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const group: SameFileDayVersionGroup = {
      key,
      fileId: items[indices[0]].fileId,
      day: items[indices[0]].day,
      indices,
      eventIds: indices.map((i) => items[i].eventId),
      count: indices.length,
      versionMin: versions.length > 0 ? Math.min(...versions) : null,
      versionMax: versions.length > 0 ? Math.max(...versions) : null,
    };
    groups.push(group);
    indices.forEach((i) => indexToGroup.set(i, group));
  });

  groups.sort((a, b) => a.indices[0] - b.indices[0]);
  return { groups, indexToGroup };
}

/** 主卡版本跨度文案：「v1 → v20 · 今日共 20 次演进」；版本号缺失时只报次数
 *  （不猜版本，宁缺勿假）。P2-3 字律纪律：分隔符字形统一（全库箭头三形并存收为一形），语义保留。 */
export function versionFoldRangeLabel(
  group: Pick<SameFileDayVersionGroup, 'versionMin' | 'versionMax' | 'count'>
): string {
  const { versionMin: min, versionMax: max, count } = group;
  const range =
    min !== null && max !== null ? (min === max ? `v${max}` : `v${min} → v${max}`) : null;
  return range ? `${range} · 今日共 ${count} 次演进` : `今日共 ${count} 次演进`;
}

/** 主卡完整标题（hover/可用性名称）：「PLAN 检测到连续更新 (v1 → v20 · 今日共 20 次演进)」。 */
export function versionFoldCardTitle(
  subject: string,
  group: Pick<SameFileDayVersionGroup, 'versionMin' | 'versionMax' | 'count'>
): string {
  return `${subject} 检测到连续更新 (${versionFoldRangeLabel(group)})`;
}


/** 「检测到更新」类事件卡的核心变更摘要（CanvasEventCard.changeSummary 承载） */
export interface CanvasChangeSummary {
  counts: { added: number; removed: number } | null;
  description: string;
}

/**
 * 从既有 changedSections/diff 链派生事件卡的 1-2 行核心变更摘要。
 *
 * 数据源（都不新增 wire 字段，全部是既有链路产物）：
 * · changedSections —— TimelineEvent.changedSections / Revision.changedSectionsFromPrev
 *   （modified 事件 payload.changed_sections，服务端 reconcile.summarizeChange 产物）；
 * · detail —— 服务端事件 detail 文本：章节变更为「变更章节：A、B」；纯哈希变化时
 *   为「内容哈希变化（+N/-M 行）」，其中的 +N/-M 就是服务端真实行数统计（reconcile.ts
 *   summarizeChange），此处按定式解析回收——解析不到就返回 counts=null，绝不编数。
 * · addedLines/removedLines —— 事件表的结构化行数（payload added_lines/
 *   removed_lines 直映 TimelineEvent.addedLines/removedLines）：章节变更事件的 detail
 *   无行数定式，此前 counts 恒落 null，靠它才能诚实透出 +/-；优先于 detail 定式。
 *
 * 返回空串 description 且 counts=null 表示无可诚实透出的摘要，调用方保留既有
 * headline 行，绝不渲染空洞占位（诚实呈现纪律）。
 */
export function deriveCanvasChangeSummary(input: {
  changedSections?: string[] | null;
  detail?: string | null;
  addedLines?: number;
  removedLines?: number;
}): CanvasChangeSummary {
  let counts: CanvasChangeSummary['counts'] = null;
  if (
    typeof input.addedLines === 'number' &&
    typeof input.removedLines === 'number' &&
    Number.isFinite(input.addedLines) &&
    Number.isFinite(input.removedLines)
  ) {
    counts = { added: input.addedLines, removed: input.removedLines };
  } else {
    const detailText = input.detail ?? '';
    const countsMatch = detailText.match(/[（(]\+(\d+)\s*\/\s*-(\d+)\s*行[）)]/);
    if (countsMatch) {
      counts = { added: Number(countsMatch[1]), removed: Number(countsMatch[2]) };
    }
  }

  const sections = (input.changedSections ?? []).map((s) => s.trim()).filter(Boolean);
  let description = '';
  if (sections.length > 0) {
    description =
      sections.length > 1
        ? `修改${sections[0]} 等 ${sections.length} 处章节`
        : `修改${sections[0]}`;
  } else if (counts) {
    description = '';
  }
  return { counts, description };
}


/**
 * 事件卡行1 右「版本跨度胶囊」措辞（单一出口）：
 *   同日合并卡：v6 → v8 (2次)（vFirst≠vLast 且 evolutionCount>0）；
 *              v6 → v8（evolutionCount=0 的理论档）；v8（仅末版可解析 / 同版）。
 *   非合并 modified：v7 → v8（>1）；v1（n≤1）。
 *   appeared：新出现 v3（保留既有「新出现」语义词——版本真值来自 revisions 查表）。
 *   无可解析版本 → 空串（调用方不渲染胶囊），绝不伪造版本号。
 * 与 dayMergeLabel 的差异：将「· 今日演进 N 次」后缀改为紧凑「(N次)」括注，
 *   适配 280px 卡行1 右侧轻量灰胶囊的宽度预算。
 */
export function versionSpanCapsule(input: {
  merged?: DayRevisionMerge | null;
  kind?: string;
  version?: number | null;
}): string {
  const m = input.merged;
  if (m && m.merged) {
    const hasRange = m.vFirst !== null && m.vLast !== null && m.vFirst !== m.vLast;
    if (hasRange) {
      return m.evolutionCount > 0
        ? `v${m.vFirst} → v${m.vLast} (${m.evolutionCount}次)`
        : `v${m.vFirst} → v${m.vLast}`;
    }
    if (m.vLast !== null) return `v${m.vLast}`;
    return '';
  }
  const vn = input.version;
  if (typeof vn !== 'number' || !Number.isFinite(vn) || vn <= 0) return '';
  if (input.kind === 'appeared') return `新出现 v${vn}`;
  if (input.kind === 'modified') return vn <= 1 ? 'v1' : `v${vn - 1} → v${vn}`;
  return '';
}

const CHANGE_DIGEST_SECTION_CAP = 3;

/**
 * 事件卡行3「真实修改内容摘要」措辞（单一出口）：
 *   「变更章节：文档头部 / 构建说明 — 修改文档头部」——章节名拼接（≤3 个，多则
 *   「/ …」收口）+ 「 — 」+ 一句描述（deriveCanvasChangeSummary 产物）。
 *   无章节名时透出描述本身；两者皆空 → 空串（调用方回退 headline，绝不只写
 *   +1/-1 行充当摘要——行数在行4 右侧承载，行3 必须是内容）。
 */
export function canvasChangeDigestLine(input: {
  changedSections?: string[] | null;
  description?: string | null;
}): string {
  const sections = (input.changedSections ?? []).map((s) => s.trim()).filter(Boolean);
  const desc = (input.description ?? '').trim();
  if (sections.length === 0) return desc;
  const shown = sections.slice(0, CHANGE_DIGEST_SECTION_CAP).join(' / ');
  const more = sections.length > CHANGE_DIGEST_SECTION_CAP ? ' / …' : '';
  return desc ? `变更章节：${shown}${more} — ${desc}` : `变更章节：${shown}${more}`;
}

const CODE_LIKE_FORMATS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'sql', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'json', 'jsonc', 'json5',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'vue', 'svelte', 'astro',
]);
const PLAIN_TEXT_FORMATS = new Set(['txt', 'text', 'log', 'csv', 'tsv', 'rst', 'adoc']);
const GENERIC_CHANGE_PLACEHOLDERS = new Set([
  '二进制内容变化',
  'SVG 源文本变化',
  '源码内容变化',
  '文本内容变化',
  '文档内容变化',
  '首次捕获正文',
  '仅记录元数据与哈希变化',
  '本轮快照不可读，未计算差异',
]);

/**
 * 纠偏单个变更章节标签：老库中把 `.mjs/.ts/.json` 等文本源码误记为「二进制内容变化」的文案，
 * 在星图事件卡与列表时间线统一按真实格式还原为可读语义。
 */
export function polishChangedSectionTag(
  section: string,
  format?: string | null,
  hasLineDelta = false
): string {
  const s = section.trim();
  if (s !== '二进制内容变化') return s;
  const fmt = (format ?? '').trim().toLowerCase();
  if (CODE_LIKE_FORMATS.has(fmt)) return '源码内容更新';
  if (PLAIN_TEXT_FORMATS.has(fmt) || hasLineDelta) return '文本内容更新';
  if (fmt === 'pdf' || fmt === 'docx' || fmt === 'pptx' || fmt === 'xlsx') return '文档内容更新';
  return '文件内容更新';
}

/**
 * 画布事件卡行 3 展示层净化：
 * 1) 纠偏老库中把 `.mjs/.ts/.json` 等文本源码误记为「二进制内容变化」的文案；
 * 2) 消除「变更章节：X — 修改X」对通用占位语或单章节名的自我重复。
 */
export function polishEventCardDigestLine(input: {
  changedSections?: string[] | null;
  description?: string | null;
  format?: string | null;
  counts?: { added: number; removed: number } | null;
}): string {
  const sections = (input.changedSections ?? []).map((s) => s.trim()).filter(Boolean);
  const hasLineDelta = Boolean(input.counts && (input.counts.added > 0 || input.counts.removed > 0));

  if (sections.length === 1) {
    const only = sections[0];
    if (only === '二进制内容变化') {
      return polishChangedSectionTag(only, input.format, hasLineDelta);
    }
    if (GENERIC_CHANGE_PLACEHOLDERS.has(only)) {
      return only;
    }
    const desc = (input.description ?? '').trim();
    if (!desc || desc === `修改${only}`) {
      return `变更章节：${only}`;
    }
  }
  return canvasChangeDigestLine({
    changedSections: sections.map((sec) => polishChangedSectionTag(sec, input.format, hasLineDelta)),
    description: input.description,
  });
}


/** 组头尾段（彩色 tspan 锚点，与 fanOutDayHeaderLine 同源同串尾——组件按此切分双色） */
export const FANOUT_DAY_HEADER_TAIL = '点击查看全天 →）';

/**
 * 展开框组头措辞（单一出口）：
 *   「2026-11-13 · 共 12 条事件（已合并为 4 份活跃文档 · 点击查看全天 →）」
 * n=当日事件总数（group.count，真实总数非卡数）、m=合并后活跃文档数
 * （group.cards.length——同日同文件合并/同基名并组后每卡一份活跃文档）。
 * 「⑃」前缀由组件拼接（收起态图标保留）。
 */
export function fanOutDayHeaderLine(
  dateLabel: string,
  eventCount: number,
  activeDocCount: number
): string {
  return `${dateLabel} · 共 ${eventCount} 条事件（已合并为 ${activeDocCount} 份活跃文档 · ${FANOUT_DAY_HEADER_TAIL}`;
}


/** 富预览卡数据（CanvasPackageGroup.docs 成员；字段与 RichDocPreviewCardProps 对齐） */
export interface CanvasPackageGroupDoc {
  fileId: string;
  title: string;
  format: FileFormat;
  versionLabel: string;
  conclusion: string;
  bodyPreview?: string[];
  diffSections?: { kind: '修改' | '新增' | '删除'; title: string; line?: number }[];
  svgThumbDataUri?: string;
}

/** 画布任务包分组（横向排布一格；stage=包主导阶段，由 dominantStage 语义聚合层判定） */
export interface CanvasPackageGroup {
  pkgId: string;
  name: string;
  kind: PackageKind;
  stage: StageRole;
  docs: CanvasPackageGroupDoc[];
}

/**
 * 文件集 + 事件流 → 画布任务包分组（R1 纯函数；复用 taskPackages 判定，零复写）。
 * 排序 = 工作流向：包内文档最近事件 observed_at 越新越靠前（'' 置尾），
 * 同刻按 pkgId 升序保证跨渲染稳定（镜像 readingIslandStats 稳定序纪律）。
 * 「焦点任务包置首」由调用方（GraphCanvasView）按 selectedFileId 再排，本层不感知选中态。
 */
export function buildCanvasPackageGroups(
  files: FileRecord[],
  events: TimelineEvent[]
): CanvasPackageGroup[] {
  const packages = groupFilesIntoPackages(files);

  const lastEventAtByFile = new Map<string, string>();
  for (const ev of events) {
    if (!ev.file_id) continue;
    const prev = lastEventAtByFile.get(ev.file_id);
    if (!prev || ev.observed_at > prev) lastEventAtByFile.set(ev.file_id, ev.observed_at);
  }

  const fileById = new Map(files.map((f) => [f.file_id, f]));
  const PACKAGE_GROUP_PREVIEW_LIMIT = 6;
  const groups: CanvasPackageGroup[] = packages.map((pkg) => ({
    pkgId: pkg.id,
    name: pkg.name,
    kind: pkg.kind,
    stage: pkg.stage,
    docs: pkg.docs.map((doc, docIdx) => {
      const file = fileById.get(doc.fileId);
      const rev = file
        ? file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
          file.revisions[file.revisions.length - 1]
        : undefined;
      const item: CanvasPackageGroupDoc = {
        fileId: doc.fileId,
        title: doc.title,
        format: doc.format,
        versionLabel: `BUILD · v${rev?.versionNumber ?? 1}`,
        conclusion: doc.conclusion,
      };
      if (file && docIdx < PACKAGE_GROUP_PREVIEW_LIMIT) {
        const preview = getFilePreviewEntry(file);
        if (preview.bodyPreview) item.bodyPreview = preview.bodyPreview;
        if (preview.svgDataUri) item.svgThumbDataUri = preview.svgDataUri;
        if (rev?.changedSectionsFromPrev?.length) {
          item.diffSections = rev.changedSectionsFromPrev
            .slice(0, 4)
            .map((title) => ({ kind: '修改' as const, title }));
        }
      }
      return item;
    }),
  }));

  const lastActivityOf = (group: CanvasPackageGroup): string => {
    let latest = '';
    for (const doc of group.docs) {
      const at = lastEventAtByFile.get(doc.fileId) ?? '';
      if (at > latest) latest = at;
    }
    return latest;
  };
  return groups
    .map((group) => ({ group, at: lastActivityOf(group) }))
    .sort((a, b) =>
      a.at === b.at
        ? a.group.pkgId < b.group.pkgId
          ? -1
          : 1
        : a.at > b.at
          ? -1
          : 1
    )
    .map(({ group }) => group);
}


export interface TrunkAccumulationPoint {
  date: string;
  dayCount: number;
  addedCount: number;
  modifiedCount: number;
  cumulativeEvents: number;
  accumulationRatio: number;
  strataIntensity: number;
}

export interface ActiveAccumulationSummary {
  date: string;
  cumulativeEvents: number;
  totalEvents: number;
  cumulativePercent: number;
  dayCount: number;
  addedCount: number;
  modifiedCount: number;
  chronologicalOrder: number;
  totalActiveDays: number;
}

/**
 * 沿「上新下旧」的主干刻度序列自底向上（由旧→新）计算每日新增/演进与累积沉淀曲线。
 * 返回数组与输入 `ticks` 1:1 索引对齐，供主干时光沉淀轮廓带、每日文档结晶刻度与司辰徽标同源消费。
 */
export function computeTrunkAccumulation(ticks: CanvasRulerTick[]): TrunkAccumulationPoint[] {
  if (ticks.length === 0) return [];

  let totalEvents = 0;
  let maxDayCount = 0;
  for (const t of ticks) {
    if (t.isGap || t.isTruncation) continue;
    const c = Math.max(0, t.count || 0);
    totalEvents += c;
    if (c > maxDayCount) maxDayCount = c;
  }

  const out: TrunkAccumulationPoint[] = new Array(ticks.length);
  let running = 0;
  const logMax = Math.log1p(Math.max(1, maxDayCount));

  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    const t = ticks[i];
    const isMetaTick = Boolean(t.isGap || t.isTruncation);
    const dayCount = isMetaTick ? 0 : Math.max(0, t.count || 0);
    const kinds = t.kinds || {};
    const rawAdded =
      (kinds.appeared ?? 0) +
      (kinds.discovered ?? 0) +
      (kinds.workspace_baseline ?? 0);
    const addedCount = isMetaTick ? 0 : Math.min(dayCount, Math.max(0, rawAdded));
    const modifiedCount = isMetaTick ? 0 : Math.max(0, dayCount - addedCount);
    running += dayCount;

    const progress = totalEvents > 0 ? running / totalEvents : 0;
    const accumulationRatio = Number((0.16 + 0.84 * progress).toFixed(4));
    const strataIntensity =
      dayCount > 0 ? Number(Math.max(0.24, Math.log1p(dayCount) / logMax).toFixed(4)) : 0;

    out[i] = {
      date: t.date,
      dayCount,
      addedCount,
      modifiedCount,
      cumulativeEvents: running,
      accumulationRatio,
      strataIntensity,
    };
  }
  return out;
}

/** 提取激活日截至时刻的时光沉淀摘要（供司辰徽标、顶栏步进器与扇出底带消费） */
export function activeAccumulationSummary(
  ticks: CanvasRulerTick[],
  points: TrunkAccumulationPoint[],
  activeDate?: string
): ActiveAccumulationSummary | null {
  if (ticks.length === 0 || points.length !== ticks.length) return null;
  const activeIndices: number[] = [];
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    const t = ticks[i];
    if (!t.isGap && !t.isTruncation && t.hasEvents) activeIndices.push(i);
  }
  const totalActiveDays = activeIndices.length;
  const targetIdx = (() => {
    if (activeDate) {
      const exact = ticks.findIndex((t) => t.date === activeDate);
      if (exact >= 0) return exact;
    }
    return activeIndices[activeIndices.length - 1] ?? 0;
  })();

  const pt = points[targetIdx];
  const totalEvents = points[0]?.cumulativeEvents ?? 0;
  const chronoPos = activeIndices.indexOf(targetIdx);
  return {
    date: ticks[targetIdx]?.date ?? activeDate ?? '',
    cumulativeEvents: pt.cumulativeEvents,
    totalEvents,
    cumulativePercent: totalEvents > 0 ? Math.round((pt.cumulativeEvents / totalEvents) * 100) : 0,
    dayCount: pt.dayCount,
    addedCount: pt.addedCount,
    modifiedCount: pt.modifiedCount,
    chronologicalOrder: chronoPos >= 0 ? chronoPos + 1 : totalActiveDays,
    totalActiveDays,
  };
}

