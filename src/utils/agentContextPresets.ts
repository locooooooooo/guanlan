
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
  lastActivity: string;
  eventCount: number;
  docIds: readonly string[];
  coreDocId?: string;
  stageDocIds: readonly string[];
}

/** 未决决策引用（App 由 DecisionAssertion 摘出：首条证据挂文件） */
export interface PresetUnresolvedDecision {
  decisionId: string;
  fileId: string;
  code?: string;
  question?: string;
  isBlocking: boolean;
}

/** 星图血缘边投影（App 由 RelationEdge 摘出 file→file 对） */
export interface PresetRelationRef {
  sourceFileId: string;
  targetFileId: string;
}

export interface AgentContextPresetInput {
  activeFileId?: string | null;
  activePackage?: PresetPackageInfo | null;
  packages: readonly PresetPackageInfo[];
  unresolvedDecisions: readonly PresetUnresolvedDecision[];
  relations?: readonly PresetRelationRef[];
}

export interface AgentContextPreset {
  intent: AgentContextIntent;
  intentTemplate: string;
  items: ContextCandidate[];
  recommended: RecommendedCandidate[];
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

const GRANULARITY_PRIORITY: Record<PresetGranularity, number> = {
  full: 5,
  decisions_only: 4,
  diff_only: 3,
  summary: 2,
  metadata_only: 1,
};

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
    items.push({ fileId: input.activeFileId, granularity: 'full' });
    const coreId =
      pkg?.coreDocId && pkg.coreDocId !== input.activeFileId
        ? pkg.coreDocId
        : pkg?.docIds.find((id) => id !== input.activeFileId);
    if (coreId) items.push({ fileId: coreId, granularity: 'summary' });
    const scope = new Set<string>([...(pkg?.docIds ?? []), input.activeFileId]);
    items.push(...unresolvedFor(scope));
    if (pkg) {
      for (const id of pkg.docIds) {
        if (items.length >= 2) break;
        if (items.some((it) => it.fileId === id)) continue;
        items.push({ fileId: id, granularity: 'summary' });
      }
    }
  } else if (intent === 'initiative' && input.activePackage) {
    const pkg = input.activePackage;
    for (const id of pkg.docIds.slice(0, 6)) {
      items.push({ fileId: id, granularity: 'summary' });
    }
    for (const id of pkg.stageDocIds.slice(0, 3)) {
      items.push({ fileId: id, granularity: 'full' });
    }
    items.push(...unresolvedFor(new Set<string>(pkg.docIds)));
  } else {
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
