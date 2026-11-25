/**
 * 智能体上下文 · 路由上下文自动感知组装器（纯函数层）。
 *
 * 三入口默认包：
 *  - 文档正文页（intent='document'）：当前文档完整正文（全文）+ 所属专项 README/
 *    核心定位（摘要）+ 当前文档关联的 P0/P1 未决事项（仅决策与契约）；
 *  - 专项详情/筛选视图（intent='initiative'）：该专项下各阶段最新定版文档摘要 +
 *    当前所处阶段的全量正文 + 该专项全部未决事项；
 *  - 首页总览（intent='global'）：最近活跃的 Top-3 专项核心摘要 + 全局最高优先级
 *    （P0/P1）待确认事项汇总。
 *
 * 预置任务意图模板与「推荐挂载（基于星图血缘与代码引用）」折叠区候选
 * （reason ∈ 本文引用/同专项引用/命名关联，排序确定性）同在本层。
 *
 * 纪律：纯函数（node --test 直跑，禁 .css/React）；不读服务——在线时优先采用服务端
 * POST /api/v1/context 组装结果，本模块的输入形状与 ContextRequest
 * items/granularity 词表逐字对齐（'full'|'summary'|'decisions_only'）。
 * 默认包保证已选 ≥2（单文档且无未决的退化工作区如实 meetsAc04=false，不造假条目）。
 */

import type { ContextGranularity } from '../services/apiTypes';
import type { StageRole } from './taskPackages';

export type AgentContextIntent = 'document' | 'initiative' | 'global';

/** 注入粒度词表（与 apiTypes.ContextGranularity 同词） */
export type PresetGranularity = ContextGranularity;

/** 推荐挂载 reason（排序 本文引用 > 同专项引用 > 命名关联） */
export type RecommendedReason = '本文引用' | '同专项引用' | '命名关联';

export interface ContextCandidate {
  fileId: string;
  granularity: PresetGranularity;
}

export interface RecommendedCandidate extends ContextCandidate {
  reason: RecommendedReason;
}

/** 任务包投影（App 由 TaskPackage 摘出；只带本层需要的字段） */
export interface PresetPackageInfo {
  id: string;
  name: string;
  stage: StageRole;
  /** 最近活动 ISO（空串=无事件）；Top-3 排序键 */
  lastActivity: string;
  eventCount: number;
  /** 阅读顺序文档 id（阶段序→标题自然序，groupFilesIntoPackages 产物） */
  docIds: readonly string[];
  /** 核心/定位文档 id（README 等；缺省取 docIds[0]） */
  coreDocId?: string;
  /** 当前主导阶段文档 id */
  stageDocIds: readonly string[];
}

/** 未决决策引用（App 由 DecisionAssertion 摘出：首条证据挂文件） */
export interface PresetUnresolvedDecision {
  decisionId: string;
  /** 首条证据文件（无证据决策不进上下文，不造文件） */
  fileId: string;
  code?: string;
  question?: string;
  /** P0/P1 阻塞性（全局最高优先级过滤键） */
  isBlocking: boolean;
}

/** 星图血缘边投影（App 由 RelationEdge 摘出 file→file 对） */
export interface PresetRelationRef {
  sourceFileId: string;
  targetFileId: string;
}

export interface AgentContextPresetInput {
  /** 当前阅读文件（文档正文页入口锚点） */
  activeFileId?: string | null;
  /** 当前所属专项（阅读器 activePackage 或概览聚焦包；缺省=无专项焦点） */
  activePackage?: PresetPackageInfo | null;
  packages: readonly PresetPackageInfo[];
  unresolvedDecisions: readonly PresetUnresolvedDecision[];
  relations?: readonly PresetRelationRef[];
}

export interface AgentContextPreset {
  intent: AgentContextIntent;
  /** 预置任务意图模板 */
  intentTemplate: string;
  /** 默认勾选清单（典型工作区 ≥2 项） */
  items: ContextCandidate[];
  /** 推荐挂载（已排除默认勾选；去重；≤6） */
  recommended: RecommendedCandidate[];
  /** 默认包达标标注（退化工作区如实 false，不造假条目） */
  meetsAc04: boolean;
}

const RECOMMENDED_CAP = 6;

/**
 * 路由意图推导：有阅读文件 → 文档正文页；无阅读文件但有专项焦点 → 专项详情；
 * 两者皆无 → 首页总览。
 */
export function deriveAgentContextIntent(input: AgentContextPresetInput): AgentContextIntent {
  if (input.activeFileId) return 'document';
  if (input.activePackage) return 'initiative';
  return 'global';
}

/** 预置任务意图模板 */
export function buildIntentTemplate(
  intent: AgentContextIntent,
  packageName?: string | null
): string {
  switch (intent) {
    case 'document':
      return '基于当前方案文档与未决约束，推进下一阶段执行/代码实现';
    case 'initiative':
      return `接管专项 [${packageName || '当前专项'}] 当前阶段长任务，检视卡点并输出推进计划`;
    case 'global':
      return '全局工程状态巡检与今日高优长任务拆解';
  }
}

/** 粒度优先级：同文件多意图重叠时取信息量最大的档（full > decisions_only > diff_only > summary > metadata_only） */
const GRANULARITY_PRIORITY: Record<PresetGranularity, number> = {
  full: 5,
  decisions_only: 4,
  diff_only: 3,
  summary: 2,
  metadata_only: 1,
};

/**
 * 候选合并：同文件多入口重叠（如当前阶段正文=full 又在定版摘要清单=summary）
 * 按粒度优先级取高档，Map 保持首插顺序（展示序稳定）。
 */
function dedupeCandidates(items: ContextCandidate[]): ContextCandidate[] {
  const map = new Map<string, ContextCandidate>();
  for (const it of items) {
    const prev = map.get(it.fileId);
    if (!prev || GRANULARITY_PRIORITY[it.granularity] > GRANULARITY_PRIORITY[prev.granularity]) {
      map.set(it.fileId, it);
    }
  }
  return [...map.values()];
}

const REASON_RANK: Record<RecommendedReason, number> = {
  本文引用: 3,
  同专项引用: 2,
  命名关联: 1,
};

/** 推荐挂载（星图血缘）：引用当前文档者最优先；同包引用次之；其余命名关联 */
export function buildRecommendedMounts(input: AgentContextPresetInput): RecommendedCandidate[] {
  const relations = input.relations ?? [];
  if (relations.length === 0) return [];
  const focusId = input.activeFileId ?? null;
  const packageDocIds = new Set<string>(input.activePackage?.docIds ?? []);
  const seen = new Set<string>();
  const out: RecommendedCandidate[] = [];
  for (const edge of relations) {
    // 推荐挂载=与当前焦点相连的文件（星图血缘）；无焦点不推荐（不猜全库）
    const other =
      focusId && edge.sourceFileId === focusId
        ? edge.targetFileId
        : focusId && edge.targetFileId === focusId
          ? edge.sourceFileId
          : null;
    if (!other || other === focusId || seen.has(other)) continue;
    seen.add(other);
    const reason: RecommendedReason =
      focusId && edge.sourceFileId === focusId
        ? '本文引用'
        : packageDocIds.has(other)
          ? '同专项引用'
          : '命名关联';
    out.push({ fileId: other, granularity: 'summary', reason });
  }
  return out
    .sort((a, b) => REASON_RANK[b.reason] - REASON_RANK[a.reason])
    .slice(0, RECOMMENDED_CAP);
}

/** Top-N 活跃包：lastActivity 降序（无活动靠后，按 eventCount 再按 id 定序） */
function topActivePackages(packages: readonly PresetPackageInfo[], n: number): PresetPackageInfo[] {
  return [...packages]
    .sort((a, b) => {
      if (a.lastActivity !== b.lastActivity) return b.lastActivity > a.lastActivity ? 1 : -1;
      if (a.eventCount !== b.eventCount) return b.eventCount - a.eventCount;
      return a.id < b.id ? -1 : 1;
    })
    .slice(0, n);
}

/**
 * 三入口默认包组装。无未决决策引用时以同包其他文档摘要补位到
 * ≥2，单文档退化工作区如实不达标（meetsAc04=false）。
 */
export function buildAgentContextPreset(input: AgentContextPresetInput): AgentContextPreset {
  const intent = deriveAgentContextIntent(input);
  const items: ContextCandidate[] = [];

  const unresolvedFor = (fileIds: ReadonlySet<string>): ContextCandidate[] => {
    const seen = new Set<string>();
    const out: ContextCandidate[] = [];
    for (const d of input.unresolvedDecisions) {
      if (!fileIds.has(d.fileId) || seen.has(d.fileId)) continue;
      seen.add(d.fileId);
      out.push({ fileId: d.fileId, granularity: 'decisions_only' });
    }
    return out;
  };

  if (intent === 'document' && input.activeFileId) {
    const pkg = input.activePackage;
    // 1. 当前文档完整正文（最新版本）
    items.push({ fileId: input.activeFileId, granularity: 'full' });
    // 2. 所属专项的 README / 核心定位（缺省取包内另一篇摘要档）
    const coreId =
      pkg?.coreDocId && pkg.coreDocId !== input.activeFileId
        ? pkg.coreDocId
        : pkg?.docIds.find((id) => id !== input.activeFileId);
    if (coreId) items.push({ fileId: coreId, granularity: 'summary' });
    // 3. 当前文档关联的 P0/P1 未决事项（包域 + 当前文件）
    const scope = new Set<string>([...(pkg?.docIds ?? []), input.activeFileId]);
    items.push(...unresolvedFor(scope));
    // 补位：仍 <2 时按阅读顺序追加包内其余文档（摘要档）
    if (pkg) {
      for (const id of pkg.docIds) {
        if (items.length >= 2) break;
        if (items.some((it) => it.fileId === id)) continue;
        items.push({ fileId: id, granularity: 'summary' });
      }
    }
  } else if (intent === 'initiative' && input.activePackage) {
    const pkg = input.activePackage;
    // 1. 该专项下各阶段最新定版（选中修订）文档摘要（阅读顺序前 6；
    //    与阶段全文/未决重叠的文件由合并层按粒度优先级取高档）
    for (const id of pkg.docIds.slice(0, 6)) {
      items.push({ fileId: id, granularity: 'summary' });
    }
    // 2. 当前所处阶段的全量正文
    for (const id of pkg.stageDocIds.slice(0, 3)) {
      items.push({ fileId: id, granularity: 'full' });
    }
    // 3. 该专项全部未决事项
    items.push(...unresolvedFor(new Set<string>(pkg.docIds)));
  } else {
    // global：1. 最近活跃的 Top-3 专项核心摘要；2. 全局 P0/P1 待确认事项汇总
    for (const pkg of topActivePackages(input.packages, 3)) {
      const coreId = pkg.coreDocId ?? pkg.docIds[0];
      if (coreId) items.push({ fileId: coreId, granularity: 'summary' });
    }
    items.push(
      ...input.unresolvedDecisions
        .filter((d) => d.isBlocking)
        .slice(0, 3)
        .map((d) => ({ fileId: d.fileId, granularity: 'decisions_only' as const }))
    );
  }

  const finalItems = dedupeCandidates(items);
  const selectedIds = new Set(finalItems.map((it) => it.fileId));
  const recommended = buildRecommendedMounts(input).filter((it) => !selectedIds.has(it.fileId));
  return {
    intent,
    intentTemplate: buildIntentTemplate(intent, input.activePackage?.name ?? null),
    items: finalItems,
    recommended,
    meetsAc04: finalItems.length >= 2,
  };
}

// ================= 候选 → 证据篮条目（App 装配层） =================

/** 候选挂载所需的最小文件投影（FileRecord 子集，避免本层拖整库类型依赖） */
export interface CandidateFileRef {
  file_id: string;
  current_revision_id: string;
  relative_path: string;
  coverage: string;
}

/**
 * 候选 → EvidencePointer 形状的字段包（App 以此组装入篮条目；无当前版的文件
 * 如实产出 revision_id=''，由调用方决定是否跳过——绝不伪造版本号）。
 */
export function candidatePointerFields(
  candidate: ContextCandidate,
  file: CandidateFileRef
): {
  file_id: string;
  revision_id: string;
  relative_path: string;
  coverage: string;
  locator: { kind: 'file' };
  evidence_kind: 'metadata_only';
  granularity: PresetGranularity;
} {
  return {
    file_id: candidate.fileId,
    revision_id: file.current_revision_id || '',
    relative_path: file.relative_path,
    coverage: file.coverage,
    locator: { kind: 'file' },
    evidence_kind: 'metadata_only',
    granularity: candidate.granularity,
  };
}
