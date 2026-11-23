/**
 * 观澜 v0.4 第二轮 —— 工程画布的事件场景映射
 *
 * 方案 §2：把真实时间绑定到现有 X-Ray 主干。
 * - 标尺刻度 = 真实日期（不是固定的 0:00 / 1:00 / 2:00）
 * - 中央卡片 = 发生了什么（日期、事项、依据版本）
 * - 虚线折叠组 = 一天内同一明确事项的事件；无事项标识时只按日期分组
 * - 司辰沿当前筛选后的真实序列移动（由 activeDate + navigator 驱动）
 *
 * 这里只做纯映射，不碰任何坐标、曲线或动效；渲染仍由 GraphCanvasView 负责。
 */

import type {
  EventDayGranularity,
  EventDayGroup,
  EventDayItem,
  EventDaysResult,
} from '../services/workspaceClient';
import type { FileFormat, FileRecord, TimelineEvent } from '../types/guanlan';
// TA-03：画布角标与日期标签统一按本地时区取值
import { formatLocalClock, localDay } from './timeFormat';
// wf_2：同日同文件合并（语义聚合层既有导出）——mergeDayRevisions 按 file_id+本地日历日成桶，
// dayMergeLabel 产出 DoD2 逐字口径标签；版本号由调用方经 resolveVersion 注入，本层不伪造
import { mergeDayRevisions, type DayRevisionMerge } from './taskPackages';
// v0.8 任务空间桌面：任务包分组容器与富预览卡数据——分组判定/核心结论/缩略图清洗全部
// 复用既有单源导出（taskPackages.groupFilesIntoPackages / extractCoreSummary /
// filePreviewCache 的 SVG 清洗编码与正文预览），本层只做画布形态的装配，禁止复写任何判定逻辑
import {
  groupFilesIntoPackages,
  type PackageKind,
  type StageRole,
} from './taskPackages';
// 预览物化（SVG dataUri / 正文前三行）走 per-file 缓存单一出口——原本层私有
// markdownBodyPreview 与行内 SVG 编码已迁入该模块（依赖方向 graphEvents→cache→guanlanEngine 无环）
import { getFilePreviewEntry } from './filePreviewCache';

export type CanvasCapability = 'MD' | 'DEC' | 'REV' | 'SVG' | 'TIM' | 'PDF' | 'REL';

export interface CanvasEventCard {
  /** 兼容现有画布的 8 个布局槽位（sub_01..sub_08） */
  slotId: string;
  eventId: string;
  fileId: string;
  revisionId: string | null;
  decisionId: string | null;
  kind: string;
  kindLabel: string;
  /** 卡片第一行大字：文件类事件=文件名（shortPath）；决策类=`${code} ${kindLabel}`（如 Q02 来源不一致） */
  fileName: string;
  /** 同组内重名文件的目录前缀（如 run-A）；空串=无歧义不加前缀 */
  dirPrefix: string;
  /** 第一行右随的灰色变更段（如 v2 → v3 / 新出现 v1）。
   *  GE 层恒为空串：EventDayItem 没有真实版本号，禁止伪造；
   *  由画布（GraphCanvasView）按 revisionId → FileRecord.revisions[].versionNumber 解析回填 */
  changeLabel: string;
  /** 底部角标：HH:MM（当天时刻，不重复完整日期；tf_4/D3 起[分类]前缀删除，语义由徽章行独家承载） */
  cornerLabel: string;
  /** R1-identity-dedup：>1 时为「同基名拷贝并组卡」——N = 本桶已取回样本内并掉的同基名拷贝数
   *  （诚实口径：样本内计数，绝不冒充全桶计数；全桶余量由组头「N 条待展开」承载） */
  mergedCount?: number;
  /** R1-identity-dedup：并组卡所属桶的事件总数（供调用方与 mergedCount 对照，不全可样本不足时如实透出） */
  mergedBucketTotal?: number;
  /** wf_2：同 file_id 同日合并记录（mergeDayRevisions 产出，含 vFirst/vLast/evolutionCount）。
   *  仅当日 ≥2 条事件且 buildCanvasEventScene 注入 resolveVersion 时存在——此时该卡代表
   *  同一文件当日全部小版本演进，changeLabel 由画布按 dayMergeLabel 渲染（v1 → v3 · 今日演进 2 次）；
   *  缺省（未注入 resolveVersion）恒缺省，逐字保留旧逐卡行为。 */
  mergedDay?: DayRevisionMerge;
  /** 当天时刻 HH:MM（observed_at 时刻分量，右栏行尾复用） */
  observedClock: string;
  /** 行 2 右侧/右栏 timeRange 展示的事件日期（occurred 日 YYYY-MM-DD / 日期待考） */
  dateLabel: string;
  /** 所属组桶键（day=YYYY-MM-DD；week=周一；month=YYYY-MM；''=待考）——
   *  tf_6/F2：画布选中调光按桶键比对（isNodeInActiveTimeSlice），与 dateLabel 分离，
   *  observed 口径/周月聚合下不再因卡片日期与桶键格式不同而整组误降透明度 */
  bucketDate: string;
  /** 事件真实格式；null = 无法判定（工作区级事件/旧数据）→ UI 落中性，不再猜成 md */
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
  /** 桶键：day=YYYY-MM-DD；week=该周周一；month=YYYY-MM；空字符串表示日期待考 */
  date: string;
  label: string;
  count: number;
  /** 当桶不同事项数（按业务决定 ID 去重） */
  matterCount: number;
  kinds: Record<string, number>;
  /** 当桶文件格式分布（md/svg/pdf 计数，决策事件已由服务端回填） */
  formats: Record<string, number>;
  matters: Array<{ id: string; code: string; status: string; count: number }>;
  cards: CanvasEventCard[];
  /** 未在首屏展开的事件数（方案 §5：超出的事项进入既有折叠组） */
  more: number;
}

export interface CanvasNavigatorEntry {
  date: string;
  label: string;
  count: number;
  /** 当桶计数最高的真实格式；无可判定格式时为 null（中性） */
  format: FileFormat | null;
  /** 当桶格式计数，供导航节点透出「MD×n · SVG×n」 */
  formats: Record<string, number>;
}

export interface CanvasRulerTick {
  /** 桶键（day/week=YYYY-MM-DD，month=YYYY-MM）；标尺覆盖首末事件桶之间的每个日历日（day 粒度时空档日也有格子） */
  date: string;
  label: string;
  /** 当桶事件数；空档日为 0 */
  count: number;
  /** 当桶事件类型分布（by_kind）；空档日为空对象 */
  kinds: Record<string, number>;
  /** 当桶文件格式分布（formats）；空档日为空对象 */
  formats: Record<string, number>;
  /** 是否为有事件的日子；false = 空档日占位刻度（表达时间在流逝） */
  hasEvents: boolean;
  /** 本刻度的桶粒度；day 粒度刻度可缺省。week/month 为聚合刻度，点按下钻到日 */
  granularity?: EventDayGranularity;
  /** true = 「更早 N 天/周/月」截断提示刻度：不承载事件、不可选中日期 */
  isTruncation?: boolean;
  /** 截断提示刻度折叠掉的更早桶数 */
  hiddenDays?: number;
  /** true = 连续长空档压缩刻度（把跨越数月/数年的 0 事件空档收束为单枚视觉断层标记） */
  isGap?: boolean;
  /** 空档刻度跨越的空档天数 */
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
  /** 当前标尺桶粒度（来自服务端返回；缺省 day） */
  granularity: EventDayGranularity;
  totals: { events: number; days: number; undated: number; matters: number };
  hasRealEvents: boolean;
}

const SLOT_IDS = ['sub_01', 'sub_02', 'sub_03', 'sub_04', 'sub_05', 'sub_06', 'sub_07', 'sub_08'];

/** 界面用词（方案 §3 表格的「界面用词与证据」一列）。
 *  pm_3：参数放宽为「kind 必有、time_basis/action 可缺」——列表态事件只保证 kind，
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

/**
 * 事件真实格式（T06 / B01）：以服务端随事件返回的 format 为准（决策事件已从 payload 回填）；
 * 无法判定时返回 null，UI 落中性——不再拿文件扩展名猜测、更不会把未知事件当 md。
 */
function formatOf(item: EventDayItem): string | null {
  const f = item.format?.trim().toLowerCase();
  return f ? f : null;
}

/** 把格式 token 映射为画布既有能力徽标（仅 MD/SVG/PDF 有独立能力位，其余归入卡片 format 字段展示） */
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
  /** tf_6/F2：所属组桶键（toGroup 透传 group.date）；缺省 ''（日期待考） */
  bucketDate: string = ''
): CanvasEventCard {
  const format = formatOf(item);
  const kindLabel = eventKindLabel(item);
  const isDecision = item.kind === 'decision_raised' || item.kind === 'decision_changed';
  const name = shortPath(item.file_path, item.file_title);

  // 行1 大字：决策类事件以「编号 + 状态变化」为主（如 Q02 来源不一致）；
  // 文件类事件以「哪个文件」为主。目录前缀独立成 dirPrefix，不拼进文件名。
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

  // 底部角标：HH:MM（observed_at 时刻分量，tf_4/D3 去重定稿「仅时刻」）——
  // 分类语义由卡底徽章行独家承载（pickSemanticCapabilityCodes 第 1 枚与原 corner 分类代码恒同源，
  // [分类] 前缀在同卡重复显示，删除）；CANVAS_SEMANTIC_LABELS 仍被徽章体系使用，保留不删
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
    // 真实版本号只在 FileRecord.revisions 里；GE 层没有该数据，留空由画布解析，不伪造
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

/**
 * R1-identity-dedup：同基名拷贝样本并组的下限。
 * ≥3 份「不同 file_id」的同基名样本才并成一张 ×N 卡——首扫日 6 个槽位被同一 basename
 * 的拷贝事件占满（六张同貌卡）的解法；恰好 2 份重名仍走既有 dirPrefix 双卡区分
 * （v04-canvas-events 用例写死该行为，2 份不足以判定「拷贝群」）。
 */
const SAMPLES_MERGE_MIN = 3;

function toGroup(
  group: EventDayGroup,
  slotOffset: number,
  maxCards: number,
  /** wf_2：revision_id → versionNumber 解析器；缺省 = 同日同文件合并关闭（逐字旧行为） */
  resolveVersion?: (revisionId: string | null) => number | null
): CanvasDayGroup {
  // 同组内重名的文件（如多个 run 目录各自的 README/PLAN/HANDOFF）加目录前缀区分
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

  // 卡片网格左上→右下由新到旧（全画布统一「上新下旧」）：
  // tf_4/D2：先按语义层级排序——决策/内容修改类恒在前（首屏可见），其余（含全部 appeared：文档自述日期/
  // 新出现（文件时间）/新出现）沉后；同层内仍按 (occurred_at || observed_at) 降序（次级键不变），排序保持稳定。
  // 镜像服务端取样优先级（queries.ts 同一 CASE WHEN 规则）：服务端已被优先选入样本的决策/修改事件，
  // 客户端重排后仍居首屏前部，首扫新出现聚簇不再挤占决策卡位
  const tierOf = (s: EventDayItem): number =>
    s.kind === 'decision_raised' || s.kind === 'decision_changed' || s.kind === 'modified' ? 0 : 1;

  // wf_2：样本池构建——resolveVersion 注入时先做同 file_id 同日合并（mergeDayRevisions），
  // 每个 file_id 至多保留一条代表样本（桶内 observed_at 最大者，与 merge.headline 同源）；
  // 无 file_id 的决策/工作区级事件原样入池。缺省时池 = 原始样本，后续装配逐字同旧。
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

  // R1-identity-dedup：基名 → 异文件样本数（决策事件是独立事项、无 file_id 的事件不参与并组）。
  // 池内每个 file_id 至多一条代表样本，计数即「异文件数」，同 file_id 多版本不再重复计数。
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

  // 卡片装配：遍历全部有序代表样本，同基名拷贝群先并成一张 ×N 卡再计入卡数——
  // 首屏卡位不再被同 basename 拷贝占满（首屏 6 卡=6 份不同事项）。×N 取「样本内」成员数：
  // 服务端取样器不改，样本不足以代表全桶时绝不把 ×N 写成全桶口径（诚实呈现在卡面行2前缀）。
  // wf_2 起「先同 file_id 同日合并、再跨 file_id 同基名并组」两规则互不覆盖；
  // representedSamples 恒按「卡面承载的原始样本数」累计（合并卡 = 桶内事件条数），more 口径不变。
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
      // 收集该基名下未消费且 file_id 互异的代表样本（保持新→旧序；首位最新者为卡面代表）
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
      // 并组卡承载的原始样本数 = 各成员代表样本（未合并为 1，已合并为桶内条数）之和
      const memberRawCount = members.reduce(
        (sum, x) => sum + (mergedByFile.get(x.file_id ?? '')?.consumedCount ?? 1),
        0
      );
      const leadingMerge = representative.file_id
        ? mergedByFile.get(representative.file_id)?.merge
        : undefined;
      cards.push({
        ...merged,
        // 跨目录拷贝无单一目录前缀，置空不伪装；行2 前缀明示样本内计数
        dirPrefix: '',
        detail: `×${members.length} 样本内同基名拷贝 · ${representative.headline}`,
        mergedCount: members.length,
        mergedBucketTotal: group.count,
        // 并组卡首位代表若本身是同日合并文件，合并标签随卡透出（代表=当日最新写入）
        ...(leadingMerge && leadingMerge.merged ? { mergedDay: leadingMerge } : {}),
      });
      representedSamples += memberRawCount;
      continue;
    }
    consumed.add(s.event_id);
    const card = toCanvasCard(s, slotOffset + cards.length, ambiguous, group.date);
    if (mergedInfo && mergedInfo.merge.merged) {
      // 同 file_id 同日合并卡：携带合并记录（画布以 dayMergeLabel 渲染 changeLabel，DoD2 口径）
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
    // 未展开数按「已呈现在卡上的事件数」扣减（并组卡一次承载 N 份样本，不再按卡数虚增）
    more: Math.max(0, group.count - representedSamples),
  };
}

/** 解析 YYYY-MM-DD 为 UTC 时间戳；非法日期返回 null */
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

/**
 * 把「只有有事件日子」的分组展开成逐日日历序列（新 → 旧，全画布统一「上新下旧」）：
 * index 0 = 最新一天（渲染时落在主干最顶端），向下越旧；
 * 每个日历日一格，空档日为 hasEvents=false 的占位刻度，
 * 有事件的日子携带该日 count / by_kind / formats 供刻度长度与分段颜色驱动。
 * 依赖 Date.UTC 算日差，不受时区/夏令时影响。
 */
function buildCalendarRuler(groups: EventDayGroup[]): CanvasRulerTick[] {
  const datedAsc = groups
    .filter((g) => g.date !== '' && dayTime(g.date) !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (datedAsc.length === 0) return [];

  const byDate = new Map(datedAsc.map((g) => [g.date, g]));
  const startT = dayTime(datedAsc[0].date)!;
  const endT = dayTime(datedAsc[datedAsc.length - 1].date)!;
  const DAY_MS = 86_400_000;

  // 自最新一天（endT）递减迭代：输出 index 0 = 最新日期（升序展开后 reverse 的等价实现）
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

/**
 * week/month 聚合标尺（新 → 旧，与逐日标尺同向「上新下旧」）：一个桶一个刻度，
 * label 带粒度后缀（如「11-02 周起」「2026-10」），
 * 桶内 count / by_kind / formats 合并供刻度长度与分段颜色驱动。
 */
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

/** 「更早 N 天/周/月」截断提示刻度：把超出 limitDays 的更早历史折叠成一个明示截断的桶（T03） */
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
 *  wf_2：resolveVersion 为可选注入——revision_id → versionNumber 解析器（由调用方从
 *  FileRecord.revisions 查表注入；EventDayItem 无版本号，禁止伪造）。缺省 = 同日同文件
 *  合并关闭，toGroup 逐字走旧逐卡行为（v04-canvas-events 既有断言不动）。 */
export interface CanvasSceneBuildOptions {
  activeDate?: string;
  maxCardsPerGroup?: number;
  resolveVersion?: (revisionId: string | null) => number | null;
}

/**
 * 同日期桶去重（starfix T5）：日期轴数据源头铁律——同一桶键（YYYY-MM-DD / 周一 /
 * YYYY-MM / '' 待考）在下游（scene.days 折叠组、navigator 日期卡、主干标尺刻度）
 * 只允许出现 1 次。上游若给出重复桶（同日多份分组），主干轴会重复渲染同一日期刻度
 * （如 11-13/11-14 各出现多次的穿帮），故在场景构建入口并组：
 * count / by_kind / formats 求和，decisions / samples 按原相对序拼接，桶位置取首现处。
 * 纯函数、无副作用；不改动互异日期桶的任何字段（既有行为逐字不变）。
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
    // 同键并组：计数轴求和，样本/决策轴拼接（保持出现序；下游 maxCards 自行截断）
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
 * 主干刻度渲染侧硬护栏（starfix2 T4）：把喂给主干轴渲染的刻度序列按桶键做严格去重
 * ——按日期字符串 Set 保序（保留首现刻度）。
 *
 * 为什么渲染前还要再过一道：scene 入口已有 dedupeEventGroupsByDate 源头并组
 * （starfix T5），但用户实测主干竖轴仍连续出现同一批日期（11-13/11-14/11-15）——
 * 渲染侧不得再信任上游数组：主干里程碑标签、标签步长、司辰锚 y、日期卡锚 y、
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

/** 格式化长空档提示词（例如 4730 天 → 「跨越 13 年」；45 天 → 「空档 45 天」）。 */
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
 * activeDate 指定当前日期（§2「点日期组看当天事项」）；未指定时取最新一天。
 * 传 '' 表示查看「日期待考」。
 * starfix T5：入口先过 dedupeEventGroupsByDate——days/groups 与标尺同源，重复桶
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
    // T06：读真实格式分布（formats）取计数最高者，并透出「MD×n · SVG×n」计数；
    // 之前这里把事件种类（EventKind）当格式推导——种类永不等于 svg/pdf，导航器恒显回退值 md。
    const format =
      (Object.entries(g.formats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) as CanvasNavigatorEntry['format'];
    return { date: g.date, label: g.label, count: g.count, format, formats: g.formats };
  });

  // 时间轴忠实于时间（T02 day 粒度：覆盖首末事件日之间的每个日历日，新 → 旧（index 0 = 最新，画在主干最顶端），
  // 空档日以占位刻度表达时间流逝；日期待考不进轴）。
  // T03：week/month 粒度改为一个聚合桶一个刻度（label 带粒度后缀，点按下钻到日）；
  // 超出 limitDays 被折叠的更早历史，以「更早 N 天/周/月」提示刻度置于轴尾（主干最底端），明示截断不再静默消失。
  const hiddenDays = Math.max(0, Number(days.hidden_days) || 0);
  // starfix T5：标尺与折叠组同源——喂去重后的桶（buildCalendarRuler 内部本就有 Map 去重，
  // 但 buildBucketRuler 是一桶一刻度的直映，喂原始重复桶会渲染重复周/月刻度）
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

// ==================== 1.3：列表「同文件同日多版本」折叠 ====================
// 问题：PLAN.md 一天内演进 20 次 → 旧时间线按「身份 × 分钟」成簇，20 个不同分钟
// 就是 20 张卡逐行刷屏。修法：同一 file_id + 同一日历日（发生/采集单一口径）的
// 「出现 / 内容修改」事件折成 1 条主卡，子版本默认不挂 DOM，点 [展开历史 ▾] 才渲染。
// 纯函数、零 React 依赖：组件只负责取数与渲染，折叠口径在此单一出口，单测覆盖。

export interface SameFileDayVersionItem {
  /** 事件唯一 id（TimelineEvent.event_id） */
  eventId: string;
  fileId: string;
  /** 事件类型（TimelineEvent.kind） */
  kind: string;
  /** 事件在同口径下的日历日（YYYY-MM-DD）；空串 = 日期待考 / 不参与折叠 */
  day: string;
  /** revision 版本号（FileRecord.revisions 查表；查不到为 null，禁止伪造） */
  versionNumber: number | null;
}

export interface SameFileDayVersionGroup {
  /** 组键 = `${fileId}|${day}` */
  key: string;
  fileId: string;
  day: string;
  /** 成员在入参数组中的下标，保持入参顺序（调用方已按「上新下旧」排好） */
  indices: number[];
  /** 成员事件 id（与 indices 同序） */
  eventIds: string[];
  count: number;
  /** 成员版本号最小/最大值；全部查不到时为 null */
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

// ==================== starfix T6：事件卡核心变更摘要直出 ====================

/** 「检测到更新」类事件卡的核心变更摘要（CanvasEventCard.changeSummary 承载） */
export interface CanvasChangeSummary {
  /** +/- 行数（服务端 diff 链真实统计）；无法诚实取得时为 null，UI 不伪造 */
  counts: { added: number; removed: number } | null;
  /** 一句描述（如「修改发布机构建文档头部」）；无章节信息时为空串 */
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
 * · addedLines/removedLines —— T5 起事件表的结构化行数（payload added_lines/
 *   removed_lines 直映 TimelineEvent.addedLines/removedLines）：章节变更事件的 detail
 *   无行数定式，此前 counts 恒落 null，靠它才能诚实透出 +/-；优先于 detail 定式。
 *
 * 返回空串 description 且 counts=null 表示无可诚实透出的摘要，调用方保留既有
 * headline 行，绝不渲染空洞占位（诚实呈现纪律）。
 */
export function deriveCanvasChangeSummary(input: {
  changedSections?: string[] | null;
  /** 服务端事件 detail（TimelineEvent.detail）；缺省/空串安全 */
  detail?: string | null;
  /** T5：事件 payload 结构化行数；两个都到位才采信，缺任一个都不拿半个真值凑数 */
  addedLines?: number;
  removedLines?: number;
}): CanvasChangeSummary {
  // ① +/- 行数：优先结构化 payload 真值（章节变更事件靠它，detail 无定式）；
  // 缺失时回退 detail 的「（+N/-M 行）」定式解析（全半角括号都收，兼容未回填
  // 映射的旧事件），两路都取不到才是 null——绝不编数
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

  // ② 一句描述：取首个变更章节 → 「修改{章节}」；多章节补「等 N 处」计数
  const sections = (input.changedSections ?? []).map((s) => s.trim()).filter(Boolean);
  let description = '';
  if (sections.length > 0) {
    description =
      sections.length > 1
        ? `修改${sections[0]} 等 ${sections.length} 处章节`
        : `修改${sections[0]}`;
  } else if (counts) {
    // 纯哈希变化（无章节名）：行数即摘要本体，描述留空由 UI 只排行数
    description = '';
  }
  return { counts, description };
}

// ==================== starfix2 T1：事件卡行1/行3 措辞单一出口 ====================
// 工票纪律：事件卡新四行布局的措辞禁组件内散写——版本跨度胶囊、变更章节摘要行
// 都在本文件出口；dayMergeLabel（taskPackages）保持 DoD2 旧口径不动（日历/看板
// 消费方口径不变），画布卡用新出口 versionSpanCapsule 产新措辞。

/**
 * 事件卡行1 右「版本跨度胶囊」措辞（starfix2 T1 单一出口）：
 *   同日合并卡：v6 → v8 (2次)（vFirst≠vLast 且 evolutionCount>0）；
 *              v6 → v8（evolutionCount=0 的理论档）；v8（仅末版可解析 / 同版）。
 *   非合并 modified：v7 → v8（>1）；v1（n≤1）。
 *   appeared：新出现 v3（保留既有「新出现」语义词——版本真值来自 revisions 查表）。
 *   无可解析版本 → 空串（调用方不渲染胶囊），绝不伪造版本号。
 * 与 dayMergeLabel 的差异（登记）：旧「· 今日演进 N 次」后缀改为紧凑「(N次)」括注，
 *   适配 280px 卡行1 右侧轻量灰胶囊的宽度预算。
 */
export function versionSpanCapsule(input: {
  /** 同日同文件合并记录（mergeDayRevisions 产物）；存在且 merged=true 时优先采用 */
  merged?: DayRevisionMerge | null;
  /** 事件类型（modified / appeared；merged 生效时忽略） */
  kind?: string;
  /** 事件修订解析出的版本号（EventDayItem 无版本号，由调用方从 FileRecord.revisions 查表注入） */
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

/** 变更章节摘要行的章节名拼接口上限：3 个章节名后以「/ …」收口（总次数由描述段承载） */
const CHANGE_DIGEST_SECTION_CAP = 3;

/**
 * 事件卡行3「真实修改内容摘要」措辞（starfix2 T1 单一出口）：
 *   「变更章节：文档头部 / 构建说明 — 修改文档头部」——章节名拼接（≤3 个，多则
 *   「/ …」收口）+ 「 — 」+ 一句描述（deriveCanvasChangeSummary 产物）。
 *   无章节名时透出描述本身；两者皆空 → 空串（调用方回退 headline，绝不只写
 *   +1/-1 行充当摘要——行数在行4 右侧承载，行3 必须是内容）。
 */
export function canvasChangeDigestLine(input: {
  changedSections?: string[] | null;
  /** deriveCanvasChangeSummary 的 description（「修改X」/「修改X 等 N 处章节」） */
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

// ==================== starfix2 T2：展开框组头全量措辞 ====================

/** 组头尾段（彩色 tspan 锚点，与 fanOutDayHeaderLine 同源同串尾——组件按此切分双色） */
export const FANOUT_DAY_HEADER_TAIL = '点击查看全天 →）';

/**
 * 展开框组头措辞（starfix2 T2 单一出口）：
 *   「2026-11-13 · 共 12 条事件（已合并为 4 份活跃文档 · 点击查看全天 →）」
 * n=当日事件总数（group.count，真实总数非卡数）、m=合并后活跃文档数
 * （group.cards.length——同日同文件合并/同基名并组后每卡一份活跃文档）。
 * 旧「· N 条待展开 · 点击看全天 →」措辞按工票废弃（wf2 旧断言 starfix2 授权留痕）；
 * 「⑃」前缀由组件拼接（收起态图标保留）。
 */
export function fanOutDayHeaderLine(
  dateLabel: string,
  eventCount: number,
  activeDocCount: number
): string {
  return `${dateLabel} · 共 ${eventCount} 条事件（已合并为 ${activeDocCount} 份活跃文档 · ${FANOUT_DAY_HEADER_TAIL}`;
}

// ==================== v0.8 任务空间桌面：任务包分组与富预览卡数据 ====================
// 画布从「竖干+空壳卡」改造为「任务包分组容器横排 + 280px 富预览卡」的数据面：
// 每个任务包一个分组（PackageGroupFrame 渲染），包内每份文档一张富预览卡
// （RichDocPreviewCard 渲染）。判定逻辑零复写——归属/阶段/结论全部来自
// taskPackages 既有导出；本层只补画布形态需要的字段（版本胶囊串/正文前 3 行/
// 变更章节行/SVG 缩略 dataUri）并按工作流向（包内最近事件）排序。

/** 富预览卡数据（CanvasPackageGroup.docs 成员；字段与 RichDocPreviewCardProps 对齐） */
export interface CanvasPackageGroupDoc {
  fileId: string;
  title: string;
  format: FileFormat;
  /** 版本胶囊原串（R2 口径「BUILD · v{N}」；N=当前修订 versionNumber，无修订回 1）——
   *  data-cv-rich-card-version 锚点值即本串原样透出，组件层不得再拼装 */
  versionLabel: string;
  /** 核心结论（taskPackages.extractCoreSummary 产物；无正文为空串，由卡片显式占位） */
  conclusion: string;
  /** 前 3 行正文预览（md=markdown 正文行；pdf=首页抽取文字行；svg 恒缺省） */
  bodyPreview?: string[];
  /** 变更章节行：changedSectionsFromPrev（相对上一版有改动的章节）→ kind 恒『修改』，
   *  色值与 DocumentTimeMachineView.KIND_COLOR 同源令牌（消费点走 canvasWidgets.css） */
  diffSections?: { kind: '修改' | '新增' | '删除'; title: string; line?: number }[];
  /** SVG 缩略图 dataUri：清洗 + 编码走 filePreviewCache 单源（AtlasView/HomeView 同一缓存） */
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
  // ① 任务包归属：groupFilesIntoPackages 已完成 G1→G2→G3→G5 级联与 readingOrder 排序
  const packages = groupFilesIntoPackages(files);

  // ② 文件 → 最近事件时刻（工作流向排序键；无 file_id 的工作区级事件不参与）
  const lastEventAtByFile = new Map<string, string>();
  for (const ev of events) {
    if (!ev.file_id) continue;
    const prev = lastEventAtByFile.get(ev.file_id);
    if (!prev || ev.observed_at > prev) lastEventAtByFile.set(ev.file_id, ev.observed_at);
  }

  const fileById = new Map(files.map((f) => [f.file_id, f]));
  // 物化收敛：画布分组容器每包只渲染前 6 张卡（消费方已核——GraphCanvasView.tsx:1521
  // PACKAGE_GROUP_MAX_CARDS=6、:1525 shown=min(docs.length,6)、:4146 group.docs.slice(0, shown)
  // 唯一渲染点，:4134 docCount 用 docs.length 不依赖预览字段；grep 全仓 + test/ 零其他消费方），
  // 故第 7+ 张卡的 bodyPreview/svgThumbDataUri/diffSections 不再物化（原实现每包全量重算）
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
      // 预览字段走 per-file 缓存单一出口（filePreviewCache.getFilePreviewEntry）：
      // md 正文剥离 / pdf 首页抽取 / SVG 清洗编码判定原样收敛在缓存层，修订未变 O(1) 命中，
      // 避免「任一次 files 身份变化就全量重编码」；此处只做展示卡范围裁剪
      if (file && docIdx < PACKAGE_GROUP_PREVIEW_LIMIT) {
        const preview = getFilePreviewEntry(file);
        if (preview.bodyPreview) item.bodyPreview = preview.bodyPreview;
        if (preview.svgDataUri) item.svgThumbDataUri = preview.svgDataUri;
        // 变更章节行：changedSectionsFromPrev 语义即「相对上一版修改的章节」→ kind 恒『修改』
        if (rev?.changedSectionsFromPrev?.length) {
          item.diffSections = rev.changedSectionsFromPrev
            .slice(0, 4)
            .map((title) => ({ kind: '修改' as const, title }));
        }
      }
      return item;
    }),
  }));

  // ③ 工作流向排序：包内最近事件新→旧；无事件（''）置尾；同刻按 pkgId 升序稳定
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

// ==================== 司辰时光沉淀引擎：时间流逝 → 文件一点一点累积 ====================

export interface TrunkAccumulationPoint {
  date: string;
  dayCount: number;
  /** 当日新增/首次纳入记录数（appeared / discovered / workspace_baseline） */
  addedCount: number;
  /** 当日内容演进/修改记录数（modified 及其他非新增事件） */
  modifiedCount: number;
  /** 自最早历史累积至当日的事件沉淀总数（时间轴自底向上单调递增） */
  cumulativeEvents: number;
  /** 归一化累积沉积比例（0.16..1.0），驱动主干时光沉淀轮廓带由细渐宽 */
  accumulationRatio: number;
  /** 当日结晶层宽强度（0..1，对数缩放保证大小活跃日均有清晰层次） */
  strataIntensity: number;
}

export interface ActiveAccumulationSummary {
  date: string;
  cumulativeEvents: number;
  totalEvents: number;
  /** 截至激活日的累积占比（0..100 整数） */
  cumulativePercent: number;
  dayCount: number;
  addedCount: number;
  modifiedCount: number;
  /** 激活日在全部活跃沉淀日中的时间序位（1 = 最早，totalActiveDays = 最新） */
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

  // 自底（最早）向顶（最新）累积，真实反映时间流逝与文件一点一点沉积的过程
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

