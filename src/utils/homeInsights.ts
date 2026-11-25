/**
 * 首页可视化驾驶舱纯函数模型（零 React / CSS 依赖，可直进 node:test 单测）。
 *
 * 所有图表数字与几何全部从工作区真实事实派生（零造数、零估算外推）：
 * 1. 事件演进构成（PulseComposition）：把 eventDays 的真实 by_kind 拆为新增纳入 / 决策拍板 /
 *    内容演进三层，与 computeTrunkAccumulation 与 buildChronosTodaySummary 保持同源分类；
 *    缺失 by_kind 时诚实标记 hasKindBreakdown = false，绝不捏造比例；
 * 2. 阅读覆盖环（ReadingCoverageModel）：复用 guanlanEngine.hasUnreadChanges 三态 SSOT，
 *    严格守恒 read + updated + unread === files.length，并产出 SVG 圆环弧段几何；
 * 3. 拍板态势条（DecisionGaugeModel）：复用 stateProjection 未决口径，服务端全库总数高于
 *    当前已加载样本时单独留出 unloadedUnresolved，绝不拿样本外推全库分布；
 * 4. 五阶段推进流（StageFlowModel）：按 taskPackages.STAGE_SLOT_ORDER 统计真实专项与文档分布；
 * 5. 格式构成图谱（FormatAtlasModel）：按 formatMeta.formatUiMeta 聚合，主视图收敛在 3–5 项内，
 *    其余低频格式收拢至「其它格式」并保留明细供悬浮提示展示；
 * 6. 首页 SVG 封面预水合候选（pickHomeCoverSvgCandidates）：有界抽取每包首份未加载 SVG，
 *    让专项橱窗与专题卡打开瞬间就能展示真实架构图，而非退回空线条。
 */

import type { DecisionAssertion, FileRecord, ReadingState } from '../types/guanlan';
import type { EventDayGroup, EventDaysResult } from '../services/apiTypes';
import { formatUiMeta, type FormatClass } from './formatMeta';
import { hasUnreadChanges } from './guanlanEngine';
import {
  DECISION_STATUS_CONFLICT,
  DECISION_STATUS_PENDING,
  unresolvedDecisionCount,
} from './stateProjection';
import {
  STAGE_ACCENT,
  STAGE_SLOT_ORDER,
  type StageRole,
  type TaskPackage,
} from './taskPackages';

/** 与 HomeView 走势柱模型结构兼容的最小输入形状（避免反向依赖组件层）。 */
export interface PulseTrendBarInput {
  date: string;
  count: number;
  jumpable: boolean;
}

/** 与 buildChronosTodaySummary / computeTrunkAccumulation 同源的「新增/首次纳入」事件 kind。 */
const PULSE_ADDED_KINDS = ['appeared', 'discovered', 'workspace_baseline'] as const;

export const PULSE_CURVE_VIEWBOX_W = 480;
export const PULSE_CURVE_VIEWBOX_H = 148;

export interface PulseDayPoint {
  date: string;
  count: number;
  jumpable: boolean;
  added: number;
  decision: number;
  evolved: number;
  /** 该桶是否携带真实的 by_kind 明细；false 时渲染单色柱，不虚构拆分 */
  hasKindBreakdown: boolean;
  /** 桶内独立决策数（含 decision_total 提示） */
  decisionTotal: number;
  /** 桶内首条真实事件标题/文件名（悬浮提示用，无则 null） */
  sampleHeadline: string | null;
  /** 窗口内从左至右累计事件数 */
  cumulative: number;
  /** 累计曲线 SVG 坐标 */
  curveX: number;
  curveY: number;
}

export interface PulseCompositionModel {
  points: PulseDayPoint[];
  totalEvents: number;
  totalAdded: number;
  totalDecision: number;
  totalEvolved: number;
  hasAnyBreakdown: boolean;
  activeBuckets: number;
  avgPerActive: number;
  peakCount: number;
  peakDate: string | null;
  /** 日均参考线距底部的百分比（0–100，用于柱图横向虚线定位） */
  avgLineBottomPct: number;
  cumulativePolyline: string;
  cumulativeArea: string;
}

/** 从真实 by_kind / samples / decision_total 构建事件演进构成与累计脉冲几何。 */
export function buildPulseComposition(
  bars: readonly PulseTrendBarInput[],
  eventDays: EventDaysResult | null
): PulseCompositionModel {
  const groupByDate = new Map<string, EventDayGroup>();
  for (const g of eventDays?.groups ?? []) {
    if (g.date) groupByDate.set(g.date, g);
  }

  let runningCumulative = 0;
  let totalEvents = 0;
  let totalAdded = 0;
  let totalDecision = 0;
  let totalEvolved = 0;
  let hasAnyBreakdown = false;
  let activeBuckets = 0;
  let peakCount = 0;
  let peakDate: string | null = null;

  const rawPoints = bars.map((bar) => {
    const count = Number.isFinite(bar.count) ? Math.max(0, bar.count) : 0;
    const group = groupByDate.get(bar.date);
    const kinds = group?.by_kind ?? {};
    const kindSum = Object.values(kinds).reduce(
      (sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0),
      0
    );
    const hasKindBreakdown = count > 0 && kindSum > 0;

    let added = 0;
    let decision = 0;
    let evolved = 0;

    if (hasKindBreakdown) {
      hasAnyBreakdown = true;
      const rawAdded = PULSE_ADDED_KINDS.reduce((sum, k) => sum + Math.max(0, kinds[k] ?? 0), 0);
      const rawDecision = Object.entries(kinds).reduce(
        (sum, [k, v]) => sum + (k.startsWith('decision') && Number.isFinite(v) && v > 0 ? v : 0),
        0
      );
      added = Math.min(count, rawAdded);
      decision = Math.min(Math.max(0, count - added), rawDecision);
      evolved = Math.max(0, count - added - decision);
    }

    const decisionTotal = Math.max(
      decision,
      typeof group?.decision_total === 'number' && Number.isFinite(group.decision_total)
        ? Math.max(0, group.decision_total)
        : 0
    );

    const firstSample = group?.samples?.[0];
    const sampleHeadline =
      firstSample?.headline?.trim() || firstSample?.file_title?.trim() || null;

    runningCumulative += count;
    totalEvents += count;
    totalAdded += added;
    totalDecision += decision;
    totalEvolved += evolved;
    if (count > 0) activeBuckets += 1;
    if (count > peakCount) {
      peakCount = count;
      peakDate = bar.date;
    }

    return {
      date: bar.date,
      count,
      jumpable: bar.jumpable,
      added,
      decision,
      evolved,
      hasKindBreakdown,
      decisionTotal,
      sampleHeadline,
      cumulative: runningCumulative,
    };
  });

  const maxCumulative = Math.max(1, runningCumulative);
  const padX = 14;
  const padTop = 14;
  const padBottom = 14;
  const plotW = PULSE_CURVE_VIEWBOX_W - padX * 2;
  const plotH = PULSE_CURVE_VIEWBOX_H - padTop - padBottom;
  const n = rawPoints.length;

  const points: PulseDayPoint[] = rawPoints.map((pt, idx) => {
    const curveX =
      n <= 1
        ? Number((padX + plotW / 2).toFixed(1))
        : Number((padX + (idx / (n - 1)) * plotW).toFixed(1));
    const ratio = totalEvents > 0 ? pt.cumulative / maxCumulative : 0;
    const curveY = Number((padTop + (1 - ratio) * plotH).toFixed(1));
    return { ...pt, curveX, curveY };
  });

  const baseY = PULSE_CURVE_VIEWBOX_H - padBottom;
  const cumulativePolyline = points.map((p) => `${p.curveX},${p.curveY}`).join(' ');
  const cumulativeArea =
    points.length > 0
      ? `${points[0].curveX},${baseY} ${cumulativePolyline} ${points[points.length - 1].curveX},${baseY}`
      : '';

  const avgPerActive = activeBuckets > 0 ? totalEvents / activeBuckets : 0;
  const avgLineBottomPct =
    peakCount > 0 ? Number(Math.min(94, Math.max(8, (avgPerActive / peakCount) * 100)).toFixed(1)) : 0;

  return {
    points,
    totalEvents,
    totalAdded,
    totalDecision,
    totalEvolved,
    hasAnyBreakdown,
    activeBuckets,
    avgPerActive,
    peakCount,
    peakDate,
    avgLineBottomPct,
    cumulativePolyline,
    cumulativeArea,
  };
}

export type ReadingBucketKey = 'read' | 'updated' | 'unread';

export interface ReadingCoverageSlice {
  key: ReadingBucketKey;
  label: string;
  hint: string;
  count: number;
  pct: number;
  color: string;
  /** SVG 圆环弧长与起点偏移（半径 = READING_RING_RADIUS） */
  dashArray: string;
  dashOffset: number;
}

export interface ReadingCoverageModel {
  total: number;
  readCount: number;
  updatedCount: number;
  unreadCount: number;
  readPct: number;
  slices: ReadingCoverageSlice[];
}

export const READING_RING_RADIUS = 46;
export const READING_RING_CIRCUMFERENCE = Number((2 * Math.PI * READING_RING_RADIUS).toFixed(2));

/** 按 guanlanEngine.hasUnreadChanges 三态口径计算阅读覆盖率与 SVG 圆环弧段。 */
export function buildReadingCoverageModel(
  files: readonly FileRecord[],
  readingStates: Record<string, ReadingState>
): ReadingCoverageModel {
  let readCount = 0;
  let updatedCount = 0;
  let unreadCount = 0;

  for (const file of files) {
    const status = hasUnreadChanges(file, readingStates[file.file_id]);
    if (status.reason === 'up_to_date') {
      readCount += 1;
    } else if (status.reason === 'updated_since_last_read') {
      updatedCount += 1;
    } else {
      unreadCount += 1;
    }
  }

  const total = files.length;
  const readPct = total > 0 ? Math.round((readCount / total) * 100) : 0;

  const rawDefs: Array<{
    key: ReadingBucketKey;
    label: string;
    hint: string;
    count: number;
    color: string;
  }> = [
    {
      key: 'read',
      label: '已读最新',
      hint: '已读到当前最新版本',
      count: readCount,
      color: 'var(--stage-ink-deliver)',
    },
    {
      key: 'updated',
      label: '更新待复读',
      hint: '上次阅读后内容有新变动',
      count: updatedCount,
      color: 'var(--accent-wave)',
    },
    {
      key: 'unread',
      label: '未读新件',
      hint: '尚未打开建立阅读基线',
      count: unreadCount,
      color: 'var(--accent-iris-deep)',
    },
  ];

  const nonZeroCount = rawDefs.filter((d) => d.count > 0).length;
  const gap = nonZeroCount >= 2 ? 3.5 : 0;
  let cursor = 0;

  const slices: ReadingCoverageSlice[] = rawDefs.map((def) => {
    const share = total > 0 ? def.count / total : 0;
    const rawLen = share * READING_RING_CIRCUMFERENCE;
    const arcLen = def.count > 0 ? Math.max(2, Number((rawLen - gap).toFixed(2))) : 0;
    const dashOffset = Number((-cursor).toFixed(2));
    cursor += rawLen;
    return {
      ...def,
      pct: total > 0 ? Math.round(share * 100) : 0,
      dashArray: `${arcLen} ${READING_RING_CIRCUMFERENCE}`,
      dashOffset,
    };
  });

  return {
    total,
    readCount,
    updatedCount,
    unreadCount,
    readPct,
    slices,
  };
}

export interface DecisionGaugeModel {
  unresolvedTotal: number;
  conflictCount: number;
  pendingCount: number;
  resolvedCount: number;
  /** 服务端全库未决总数中尚未水合明细的差额（诚实留白，绝不拿样本外推比例） */
  unloadedUnresolved: number;
  topUrgentDecisionId: string | null;
}

/** 计算拍板态势：严格区分冲突/待确认/已定案/未展开差额，杜绝以偏概全。 */
export function buildDecisionGaugeModel(
  decisions: readonly DecisionAssertion[],
  decisionsUnresolvedTotal?: number | null
): DecisionGaugeModel {
  const considered = decisions.filter((d) => !d.isCandidateOnly);
  let conflictCount = 0;
  let pendingCount = 0;
  let resolvedCount = 0;
  let firstConflictId: string | null = null;
  let firstPendingId: string | null = null;

  for (const d of considered) {
    if (d.status === DECISION_STATUS_CONFLICT) {
      conflictCount += 1;
      if (!firstConflictId) firstConflictId = d.decision_id;
    } else if (d.status === DECISION_STATUS_PENDING) {
      pendingCount += 1;
      if (!firstPendingId) firstPendingId = d.decision_id;
    } else {
      resolvedCount += 1;
    }
  }

  const loadedUnresolved = conflictCount + pendingCount;
  const unresolvedTotal =
    typeof decisionsUnresolvedTotal === 'number' && decisionsUnresolvedTotal >= 0
      ? decisionsUnresolvedTotal
      : unresolvedDecisionCount(considered);
  const unloadedUnresolved = Math.max(0, unresolvedTotal - loadedUnresolved);

  return {
    unresolvedTotal,
    conflictCount,
    pendingCount,
    resolvedCount,
    unloadedUnresolved,
    topUrgentDecisionId: firstConflictId ?? firstPendingId,
  };
}

export interface StageFlowNode {
  stage: StageRole;
  accent: string;
  packageCount: number;
  docCount: number;
  eventCount: number;
  /** 相对最重阶段的长度百分比（用于水平流条比例） */
  barWidthPct: number;
  topPackages: Array<{ id: string; name: string; docCount: number; leadFileId: string | null }>;
}

export interface StageFlowModel {
  nodes: StageFlowNode[];
  totalPackages: number;
  totalDocs: number;
  dominantStage: StageRole | null;
}

/** 构造五阶段推进流（蓝图 → 计划 → 决策 → 执行 → 交付；有未归类专项时才追加待分类槽）。 */
export function buildStageFlowModel(packages: readonly TaskPackage[]): StageFlowModel {
  const bucketMap = new Map<StageRole, TaskPackage[]>();
  for (const stage of STAGE_SLOT_ORDER) {
    bucketMap.set(stage, []);
  }
  const unclassified: TaskPackage[] = [];

  for (const pkg of packages) {
    const arr = bucketMap.get(pkg.stage);
    if (arr) {
      arr.push(pkg);
    } else {
      unclassified.push(pkg);
    }
  }

  const orderedStages: StageRole[] =
    unclassified.length > 0 ? [...STAGE_SLOT_ORDER, '待分类'] : [...STAGE_SLOT_ORDER];

  let totalDocs = 0;
  let maxDocs = 0;
  let dominantStage: StageRole | null = null;
  let dominantDocs = 0;

  const preNodes = orderedStages.map((stage) => {
    const list = stage === '待分类' ? unclassified : (bucketMap.get(stage) ?? []);
    const sorted = list
      .slice()
      .sort((a, b) => b.docs.length - a.docs.length || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const docCount = sorted.reduce((sum, p) => sum + p.docs.length, 0);
    const eventCount = sorted.reduce((sum, p) => sum + p.eventCount, 0);
    totalDocs += docCount;
    if (docCount > maxDocs) maxDocs = docCount;
    if (docCount > dominantDocs) {
      dominantDocs = docCount;
      dominantStage = stage;
    }
    return {
      stage,
      accent: STAGE_ACCENT[stage],
      packageCount: sorted.length,
      docCount,
      eventCount,
      topPackages: sorted.slice(0, 4).map((p) => ({
        id: p.id,
        name: p.name,
        docCount: p.docs.length,
        leadFileId: p.readingOrder[0]?.fileId ?? p.docs[0]?.fileId ?? null,
      })),
    };
  });

  const nodes: StageFlowNode[] = preNodes.map((n) => ({
    ...n,
    barWidthPct:
      n.docCount > 0 && maxDocs > 0 ? Math.max(8, Math.round((n.docCount / maxDocs) * 100)) : 0,
  }));

  return {
    nodes,
    totalPackages: packages.length,
    totalDocs,
    dominantStage,
  };
}

const FORMAT_SHORT_TAG: Record<FormatClass, string> = {
  markdown: 'MD',
  vector: 'SVG',
  document: 'DOC',
  code: 'CODE',
  text: 'TXT',
  image: 'IMG',
  spreadsheet: 'DATA',
  presentation: 'PPT',
  archive: 'ZIP',
  audio: 'AUD',
  video: 'VID',
  font: 'FONT',
  binary: 'BIN',
};

export interface FormatAtlasEntry {
  key: string;
  label: string;
  shortTag: string;
  count: number;
  unreadCount: number;
  sharePct: number;
  color: string;
  /** 合并进「其它格式」时记录真实细项，悬浮提示可读 */
  collapsedDetails?: Array<{ label: string; count: number }>;
}

export interface FormatAtlasModel {
  total: number;
  entries: FormatAtlasEntry[];
  distinctClasses: number;
}

/** 构造格式构成图谱：按 13 族真实分类统计，主列控制在 ≤5 项以降低认知负荷。 */
export function buildFormatAtlasModel(
  files: readonly FileRecord[],
  readingStates: Record<string, ReadingState>
): FormatAtlasModel {
  const map = new Map<
    FormatClass,
    { label: string; shortTag: string; count: number; unreadCount: number; color: string }
  >();

  for (const file of files) {
    const meta = formatUiMeta(file.format);
    const isUnread = hasUnreadChanges(file, readingStates[file.file_id]).reason !== 'up_to_date';
    const prev = map.get(meta.formatClass);
    if (prev) {
      prev.count += 1;
      if (isUnread) prev.unreadCount += 1;
    } else {
      map.set(meta.formatClass, {
        label: meta.classLabel,
        shortTag: FORMAT_SHORT_TAG[meta.formatClass] ?? meta.label.toUpperCase(),
        count: 1,
        unreadCount: isUnread ? 1 : 0,
        color: meta.dotColor,
      });
    }
  }

  const total = files.length;
  const sorted = Array.from(map.entries())
    .map(([formatClass, item]) => ({
      key: formatClass,
      label: item.label,
      shortTag: item.shortTag,
      count: item.count,
      unreadCount: item.unreadCount,
      sharePct: total > 0 ? Math.round((item.count / total) * 100) : 0,
      color: item.color,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  if (sorted.length <= 5) {
    return { total, entries: sorted, distinctClasses: sorted.length };
  }

  const top4 = sorted.slice(0, 4);
  const tail = sorted.slice(4);
  const tailCount = tail.reduce((sum, x) => sum + x.count, 0);
  const tailUnread = tail.reduce((sum, x) => sum + x.unreadCount, 0);

  return {
    total,
    distinctClasses: sorted.length,
    entries: [
      ...top4,
      {
        key: 'other',
        label: '其它格式',
        shortTag: 'OTHER',
        count: tailCount,
        unreadCount: tailUnread,
        sharePct: total > 0 ? Math.round((tailCount / total) * 100) : 0,
        color: 'var(--ink-soft)',
        collapsedDetails: tail.map((x) => ({ label: x.label, count: x.count })),
      },
    ],
  };
}

export interface HomeCoverSvgCandidate {
  fileId: string;
  revisionId: string;
}

/**
 * 选出首页需要预水合的 SVG 封面候选（每包至多 1 份，总量受 limit 硬封顶）。
 * 跳过已有 svgSource 的文件，避免重复请求。
 */
export function pickHomeCoverSvgCandidates(
  packages: readonly TaskPackage[],
  fileById: ReadonlyMap<string, FileRecord>,
  limit = 8
): HomeCoverSvgCandidate[] {
  if (limit <= 0) return [];
  const out: HomeCoverSvgCandidate[] = [];
  const seen = new Set<string>();

  for (const pkg of packages) {
    if (out.length >= limit) break;
    const orderedDocs = [...pkg.readingOrder, ...pkg.docs];
    for (const doc of orderedDocs) {
      if (doc.format !== 'svg' || seen.has(doc.fileId)) continue;
      const file = fileById.get(doc.fileId);
      if (!file) continue;
      const rev =
        file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
        file.revisions[file.revisions.length - 1];
      if (!rev?.revision_id) continue;
      seen.add(doc.fileId);
      // 已经有正文时仍记为本包已就绪（不再多拉第二份 SVG），但无需入请求队列
      if (rev.svgSource === undefined) {
        out.push({ fileId: file.file_id, revisionId: rev.revision_id });
      }
      break;
    }
  }

  return out;
}
