import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ClipboardCopy,
  Clock,
  History,
  Info,
  Link2,
  Network,
  Scale,
  Tag,
} from 'lucide-react';
import {
  DecisionAssertion,
  DecisionSourceEvidence,
  EvidencePointer,
  FileRecord,
  ReadingState,
  RelationEdge,
} from '../types/guanlan';
import { formatOfficeAnchorLabel, pickPrimaryOfficeEvidence } from '../utils/officeAnchor';
import { InitiativeCandidatePanel } from './InitiativeCandidatePanel';
import { formatPdfAnchorLabel, pickPrimaryPdfEvidence } from '../utils/pdfAnchor';
import { hasUnreadChanges, unreadStatusLabel } from '../utils/guanlanEngine';
import { groupFilesIntoPackages, taskPackageOf } from '../utils/taskPackages';
import type { PackageDoc, TaskPackage } from '../utils/taskPackages';
import {
  DECIDED_DECISION_STATUSES,
  DOC_STATE_LABEL,
  artifactStateOf,
  docStatePillClass,
  indexStateOverview,
  isUnresolvedDecision,
  revisionVersionLabel,
} from '../utils/stateProjection';
import { CopyIdButton } from './ReaderView';
import { formatRelativeObservedAt } from '../utils/timeFormat';
import { fetchRevisionContent } from '../services/workspaceClient';
import type { StateOverviewResponse } from '../services/apiTypes';
import { basenameOf, minimalDirPrefix } from '../utils/documentIdentity';
import { Button } from './ui/primitives';
import {
  Badge,
  PreviewCard,
  PreviewCardCreateHandle,
  PreviewCardPopup,
  PreviewCardTrigger,
} from './ui';
import {
  FileSystemActionBar,
  type DesktopFileActionCallbacks,
} from './FileContextMenu';
import { formatUiMeta, isUtf8TextFormat } from '../utils/formatMeta';
import {
  canOpenTimeMachine,
  summarizeMiniVersionChange,
} from './reader/readerChromeSections';


/** 时光轨迹卡展示的版本上限（最近 4 节点；更早版本诚实收纳为计数，不丢不造）。 */
export const TIME_TRAIL_MAX_NODES = 4;

/** 时光轨迹卡消费的版本结构（Revision 的结构子集，便于夹具直构与测试）。 */
export interface TimeTrailRevision {
  revision_id: string;
  versionNumber: number;
  observed_at: string;
  snapshotAvailable?: boolean;
  changedSectionsFromPrev?: string[];
}

/** 节点形态：有章节级变更 / 无变更记录 / 快照已淘汰（仅保留元数据）。 */
export type TimeTrailNodeKind = 'changed' | 'unchanged' | 'evicted';

/** 时光轨迹卡单节点（按修订链序：vN → … → v1）。 */
export interface TimeTrailNode {
  revisionId: string;
  versionNumber: number;
  label: string;
  observedLabel: string;
  isCurrent: boolean;
  isLatest: boolean;
  snapshotAvailable: boolean;
  kind: TimeTrailNodeKind;
  changedSections: string[];
  changedCount: number;
  changeSummary: string;
  diffAvailable: boolean;
}

/** 三边界 + 空链防御：multi（多版本）/ single（唯一版本）/ evicted（快照均已淘汰）/ empty。 */
export type TimeTrailBoundary = 'multi' | 'single' | 'evicted' | 'empty';

export interface TimeTrailModel {
  boundary: TimeTrailBoundary;
  nodes: TimeTrailNode[];
  totalVersions: number;
  hiddenCount: number;
  headline: string;
}

function timeTrailNodeOf(
  rev: TimeTrailRevision,
  currentRevisionId: string,
  latestRevisionId: string
): TimeTrailNode {
  const snapshotAvailable = rev.snapshotAvailable !== false;
  const changedSections = (rev.changedSectionsFromPrev ?? []).filter(
    (section) => typeof section === 'string' && section.trim().length > 0
  );
  const kind: TimeTrailNodeKind = !snapshotAvailable
    ? 'evicted'
    : changedSections.length > 0
      ? 'changed'
      : 'unchanged';
  return {
    revisionId: rev.revision_id,
    versionNumber: rev.versionNumber,
    label: `v${rev.versionNumber}`,
    observedLabel: formatRelativeObservedAt(rev.observed_at),
    isCurrent: rev.revision_id === currentRevisionId,
    isLatest: rev.revision_id === latestRevisionId,
    snapshotAvailable,
    kind,
    changedSections,
    changedCount: changedSections.length,
    changeSummary: summarizeMiniVersionChange(
      snapshotAvailable ? rev : { ...rev, changedSectionsFromPrev: [] }
    ),
    diffAvailable: snapshotAvailable && changedSections.length > 0,
  };
}

/**
 * 时光轨迹卡映射唯一出口：把文件版本集映射为「最近 4 节点」的竖向微型版本链模型。
 * - 多版本：recent 4 节点 + hiddenCount 诚实收纳（完整链入口＝「文件时间线」抽屉）；
 * - 单版本：唯一基线节点（无更早版本可比对，绝不渲染假差异入口）；
 * - 已淘汰快照：全部快照不可用时整卡转入 evicted 边界（节点仅保留元数据，diff 全禁）；
 * - 空链 / 非法输入：empty（零节点，不占位不造数）。
 */
export function buildTimeTrail(
  revisions: readonly TimeTrailRevision[] | null | undefined,
  currentRevisionId: string,
  latestRevisionId: string
): TimeTrailModel {
  if (!Array.isArray(revisions)) {
    return { boundary: 'empty', nodes: [], totalVersions: 0, hiddenCount: 0, headline: '暂无版本记录' };
  }
  const usable = revisions.filter((rev) => Boolean(rev && rev.revision_id));
  if (usable.length === 0) {
    return { boundary: 'empty', nodes: [], totalVersions: 0, hiddenCount: 0, headline: '暂无版本记录' };
  }
  const ordered = [...usable].sort((a, b) => {
    const av = Number.isFinite(a.versionNumber) ? a.versionNumber : 0;
    const bv = Number.isFinite(b.versionNumber) ? b.versionNumber : 0;
    return bv - av;
  });
  const nodes = ordered
    .slice(0, TIME_TRAIL_MAX_NODES)
    .map((rev) => timeTrailNodeOf(rev, currentRevisionId, latestRevisionId));
  const hiddenCount = Math.max(0, usable.length - nodes.length);

  if (usable.every((rev) => rev.snapshotAvailable === false)) {
    return {
      boundary: 'evicted',
      nodes,
      totalVersions: usable.length,
      hiddenCount,
      headline: '快照均已过保留期（仅保留版本元数据）',
    };
  }
  if (usable.length === 1) {
    return {
      boundary: 'single',
      nodes,
      totalVersions: 1,
      hiddenCount: 0,
      headline: '唯一版本 · 初始基线（无更早版本可比对）',
    };
  }
  return {
    boundary: 'multi',
    nodes,
    totalVersions: usable.length,
    hiddenCount,
    headline:
      hiddenCount > 0
        ? `共 ${usable.length} 版 · 展示最近 ${nodes.length} 版`
        : `共 ${usable.length} 版`,
  };
}

/**
 * 双向引用卡悬停预览目标摘要（无 DOM 依赖纯函数，便于单测直接导入）。
 * 文件＝当前版 summaryNote；决策＝决策问题；无摘要如实返回空串（调用方不带 title）。
 * 数据只取既有字段并截断 80 字（悬浮预览不是正文出口，绝不整段倾倒）。
 */
export function peerHoverPreviewOf(
  peerId: string,
  files: readonly FileRecord[],
  decisions: readonly DecisionAssertion[]
): string {
  const peerFile = files.find((item) => item.file_id === peerId);
  if (peerFile) {
    const rev =
      peerFile.revisions.find((r) => r.revision_id === peerFile.current_revision_id) ??
      peerFile.revisions[peerFile.revisions.length - 1];
    const note = (rev?.summaryNote || '').trim();
    return note ? `目标摘要：${note.slice(0, 80)}${note.length > 80 ? '…' : ''}` : '';
  }
  const peerDecision = decisions.find((item) => item.decision_id === peerId);
  if (peerDecision) {
    const question = peerDecision.question.trim();
    return question ? `决策问题：${question.slice(0, 80)}${question.length > 80 ? '…' : ''}` : '';
  }
  return '';
}

const PEER_REF_CARD_META = {
  out: {
    labelColor: 'text-[color:var(--accent-iris-deep)]',
    prefix: '正向引用 →',
    lineTitle: '本文档中的引用行号（去重升序，最多展示 4 个）',
  },
  in: {
    labelColor: 'text-[color:var(--stage-ink-deliver-text)]',
    prefix: '反向被引用 ←',
    lineTitle: '来源文档中的引用行号（去重升序，最多展示 4 个）',
  },
} as const;

interface PeerRefPreviewPayload {
  title: string;
  relativePath?: string;
  formatLabel?: string;
  versionLabel?: string;
  summary: string;
  updatedText?: string;
}

interface PeerRefCardProps {
  direction: 'out' | 'in';
  peerId: string;
  edges: RelationEdge[];
  peerTitle: { title: string; prefix: string };
  lineBadge: string;
  isFileTarget: boolean;
  hoverPreview?: string;
  previewPayload?: PeerRefPreviewPayload;
  previewHandle?: ReturnType<typeof PreviewCardCreateHandle<PeerRefPreviewPayload>>;
  onOpenFile: (fileId: string) => void;
  onOpenDecision: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
}

const PeerRefCard: React.FC<PeerRefCardProps> = ({
  direction,
  peerId,
  edges,
  peerTitle,
  lineBadge,
  isFileTarget,
  hoverPreview,
  previewPayload,
  previewHandle,
  onOpenFile,
  onOpenDecision,
}) => {
  const meta = PEER_REF_CARD_META[direction];
  const cardBtn = (
    <button
      type="button"
      onClick={() => {
        if (isFileTarget) {
          onOpenFile(peerId);
        } else {
          onOpenDecision(peerId);
        }
      }}
      title={hoverPreview}
      className="group w-full text-left p-2.5 rounded-[12px] bg-card/90 border border-border/80 shadow-xs hover:bg-card hover:border-[color:color-mix(in_srgb,var(--accent-iris)_42%,transparent)] hover:-translate-y-[1px] motion-safe:transition-all flex items-center justify-between gap-2 cursor-pointer"
    >
      <div className="min-w-0">
        <div
          className={`font-mono text-[length:var(--text-micro)] ${meta.labelColor} flex items-center gap-1.5 flex-wrap`}
        >
          <span>
            {meta.prefix} {edges[0].label}
          </span>
          {(edges.length > 1 || lineBadge) && (
            <span
              className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]"
              title={meta.lineTitle}
            >
              {edges.length > 1 ? `×${edges.length} 处` : ''}
              {edges.length > 1 && lineBadge ? ' · ' : ''}
              {lineBadge}
            </span>
          )}
        </div>
        <div className="mt-0.5 font-medium text-[color:var(--ink-strong)] truncate">
          {peerTitle.prefix && (
            <span className="font-mono text-[length:var(--text-micro)] font-normal text-[color:var(--ink-soft)]">
              {peerTitle.prefix}/
            </span>
          )}
          {peerTitle.title}
        </div>
      </div>
      <ArrowUpRight className="w-3.5 h-3.5 text-[color:var(--ink-soft)] group-hover:text-[color:var(--accent-iris-deep)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 motion-safe:transition-transform shrink-0" />
    </button>
  );

  if (previewHandle && previewPayload) {
    return (
      <PreviewCardTrigger<PeerRefPreviewPayload>
        handle={previewHandle}
        payload={previewPayload}
        delay={250}
        closeDelay={120}
        render={cardBtn}
      />
    );
  }
  return cardBtn;
};


interface TimeTrailCardProps {
  model: TimeTrailModel;
  unreadLabel: string | null;
  expandedIds: Record<string, boolean>;
  onToggleNode: (node: TimeTrailNode) => void;
  onOpenRevision: (revisionId: string) => void;
  onOpenTimeline?: () => void;
  canJumpMachine: boolean;
  onJumpMachine?: () => void;
}

const TimeTrailCard: React.FC<TimeTrailCardProps> = ({
  model,
  unreadLabel,
  expandedIds,
  onToggleNode,
  onOpenRevision,
  onOpenTimeline,
  canJumpMachine,
  onJumpMachine,
}) => {
  if (model.boundary === 'empty') {
    return (
      <section className="space-y-2" data-inspector-time-trail="" data-trail-boundary="empty">
        <div className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-soft)] flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-[color:var(--accent-iris)]" />
          <span>时光轨迹</span>
        </div>
        <div className="depth-2-card p-3.5 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">
          该文档暂无版本记录。
        </div>
      </section>
    );
  }

  const isExpanded = (node: TimeTrailNode) =>
    expandedIds[node.revisionId] ?? (node.isCurrent && node.diffAvailable);

  return (
    <section
      className="space-y-2"
      data-inspector-time-trail=""
      data-trail-boundary={model.boundary}
    >
      <div className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-soft)] flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-[color:var(--accent-iris)]" />
          <span>时光轨迹</span>
        </span>
        <span className="flex items-center gap-2">
          {unreadLabel && (
            <span
              data-unread-status=""
              className="font-mono text-[length:var(--text-micro)] text-[color:var(--stage-ink-decision-text)]"
            >
              {unreadLabel}
            </span>
          )}
          <span
            className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]"
            title={model.headline}
          >
            {model.headline}
          </span>
        </span>
      </div>

      <div className="depth-2-card p-3">
        <div className="relative pl-5 space-y-1" data-trail-chain="">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-[3px] top-2 bottom-2 w-[1.5px] rounded-full"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--accent-iris) 50%, transparent) 0%, color-mix(in srgb, var(--ink-faint) 40%, transparent) 85%, transparent 100%)',
            }}
          />
          {model.nodes.map((node) => {
            const expanded = isExpanded(node);
            const head = (
              <>
                <span
                  aria-hidden="true"
                  className={`absolute -left-[19px] top-1/2 -translate-y-1/2 size-2 rounded-full ${
                    node.kind === 'evicted'
                      ? 'bg-[color:var(--stage-ink-decision)]'
                      : node.kind === 'changed'
                        ? 'bg-[color:var(--accent-iris)]'
                        : 'bg-[color:var(--ink-faint)]'
                  }`}
                />
                <span
                  className={`px-1.5 py-0.5 rounded-[var(--r-ctl)] font-mono text-[length:var(--text-micro)] tabular-nums shrink-0 ${
                    node.isCurrent
                      ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-ink)] font-medium'
                      : 'bg-muted/80 border border-border/70 text-[color:var(--ink-soft)]'
                  }`}
                >
                  {node.label}
                </span>
                {node.isCurrent && (
                  <span className="px-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-ink)] shrink-0">
                    当前
                  </span>
                )}
                {node.isLatest && !node.isCurrent && (
                  <span className="px-1 rounded-full bg-muted/80 border border-border/70 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] shrink-0">
                    最新
                  </span>
                )}
                {node.kind === 'changed' && (
                  <span
                    className="flex items-center gap-[3px] shrink-0"
                    title={`本版相对上一版变更 ${node.changedCount} 节`}
                    data-trail-dots={String(node.changedCount)}
                  >
                    {Array.from({ length: Math.min(node.changedCount, 4) }).map((_, i) => (
                      <span
                        key={i}
                        className="size-1.5 rounded-full bg-[color:var(--accent-iris)]"
                      />
                    ))}
                  </span>
                )}
                <span className="flex-1 min-w-0 truncate text-left text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                  {node.kind === 'evicted'
                    ? '快照已淘汰'
                    : node.kind === 'changed'
                      ? `变更 ${node.changedCount} 节`
                      : '无章节级变更记录'}
                </span>
                <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)] shrink-0">
                  {node.observedLabel}
                </span>
                {node.diffAvailable ? (
                  <ChevronDown
                    className={`w-3 h-3 shrink-0 text-[color:var(--ink-soft)] motion-safe:transition-transform ${
                      expanded ? 'rotate-180' : ''
                    }`}
                  />
                ) : (
                  node.kind === 'evicted' && (
                    <span
                      className="font-mono text-[length:var(--text-micro)] text-[color:var(--stage-ink-decision-text)] shrink-0"
                      title="快照已过保留期，仅保留版本元数据；内容演进请看版本时光机（按修订链）"
                    >
                      已过保留期
                    </span>
                  )
                )}
              </>
            );
            return (
              <div
                key={node.revisionId}
                data-trail-node={node.revisionId}
                data-trail-node-kind={node.kind}
                className="relative"
              >
                {node.diffAvailable ? (
                <button
                  type="button"
                  onClick={() => onToggleNode(node)}
                  aria-expanded={expanded}
                  data-trail-node-toggle={node.revisionId}
                  title={`展开/收起「${node.label}」相对上一版的章节级差异`}
                  className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded-[var(--r-ctl)] cursor-pointer text-left ${
                    expanded
                      ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)]'
                      : 'hover:bg-accent/80'
                  } motion-safe:transition-colors`}
                >
                  {head}
                </button>
                ) : (
                  <div
                    className="w-full flex items-center gap-1.5 px-1.5 py-1 text-left"
                    data-trail-node-static={node.revisionId}
                  >
                    {head}
                  </div>
                )}
                {expanded && node.diffAvailable && (
                  <div
                    className="mt-0.5 mb-1 ml-6 space-y-0.5"
                    data-trail-node-diff={node.revisionId}
                  >
                    {node.changedSections.map((sec) => (
                      <div
                        key={sec}
                        className="px-2 py-1 rounded bg-muted/75 border border-border/70 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-strong)] flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{sec}</span>
                        <span className="font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-deep)] shrink-0">
                          本版修改
                        </span>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => onOpenRevision(node.revisionId)}
                      className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_18%,transparent)] px-2 py-0.5 font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-ink)] cursor-pointer motion-safe:transition-colors"
                      title={`把阅读器钉到该版本阅读（只读；不改未读基线）`}
                    >
                      在阅读器打开 {node.label}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {model.hiddenCount > 0 && (
          <div
            className="mt-2 pt-2 flex items-center justify-between gap-2 border-t border-[color:var(--glass-hairline)] font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]"
            data-trail-hidden={String(model.hiddenCount)}
          >
            <span>其余 {model.hiddenCount} 个更早版本</span>
            {onOpenTimeline && (
              <button
                type="button"
                onClick={onOpenTimeline}
                className="font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-deep)] hover:text-[color:var(--accent-iris-ink)] cursor-pointer shrink-0"
                title="打开文件时间线抽屉查看完整版本链与相关事件"
              >
                完整链 · 文件时间线 →
              </button>
            )}
          </div>
        )}
        {model.boundary === 'single' && (
          <div className="mt-2 pt-2 border-t border-[color:var(--glass-hairline)] font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
            {model.headline}
          </div>
        )}
        {model.boundary === 'evicted' && (
          <div className="mt-2 pt-2 border-t border-[color:var(--glass-hairline)] font-mono text-[length:var(--text-micro)] text-[color:var(--stage-ink-decision-text)]">
            {model.headline}
          </div>
        )}
        {canJumpMachine && onJumpMachine && (
          <div className="mt-2 pt-2 border-t border-[color:var(--glass-hairline)]">
            <button
              type="button"
              onClick={onJumpMachine}
              data-trail-open-time-machine=""
              className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_18%,transparent)] px-2.5 py-1 font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-ink)] cursor-pointer motion-safe:transition-colors"
              title="跳转全景画布：以当前文档为焦点查看版本时光机（按修订链；只读视图跳转，不改未读基线）"
            >
              <span>进入版本时光机 →</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
};

interface RightInspectorProps {
  selectedFile: FileRecord;
  selectedDecision?: DecisionAssertion | null;
  files: FileRecord[];
  decisions: DecisionAssertion[];
  relations: RelationEdge[];
  readingState?: ReadingState;
  onSavePersonalNote: (fileId: string, note: string) => void;
  onOpenFile: (fileId: string, revisionId?: string) => void;
  onOpenDecision: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
  onOpenFileTimeline?: (fileId: string) => void;
  onViewRelationsGraph: () => void;
  onCopyObjectToAgent: (pointer: EvidencePointer) => Promise<boolean>;
  indexGeneration: number;
  stateOverview?: StateOverviewResponse | null;
  systemActions?: DesktopFileActionCallbacks;
  packages?: TaskPackage[];
}

export const RightInspector: React.FC<RightInspectorProps> = ({
  selectedFile,
  selectedDecision,
  files,
  decisions,
  relations,
  readingState,
  onSavePersonalNote,
  onOpenFile,
  onOpenDecision,
  onOpenFileTimeline,
  onViewRelationsGraph,
  onCopyObjectToAgent,
  indexGeneration,
  stateOverview,
  systemActions,
  packages,
}) => {
  const [expandFullPath, setExpandFullPath] = useState(false);
  const [noteInput, setNoteInput] = useState(readingState?.personalNote || '');
  const [metaExpanded, setMetaExpanded] = useState<boolean>(false);
  const [refsOpen, setRefsOpen] = useState<{ out: boolean; in: boolean }>({ out: true, in: true });
  const refPreviewHandle = useMemo(() => PreviewCardCreateHandle<PeerRefPreviewPayload>(), []);
  const [trailExpanded, setTrailExpanded] = useState<Record<string, boolean>>({});

  React.useEffect(() => {
    setNoteInput(readingState?.personalNote || '');
  }, [selectedFile.file_id, readingState?.personalNote]);

  React.useEffect(() => {
    setMetaExpanded(false);
    setTrailExpanded({});
  }, [selectedFile.file_id]);

  const currentRev =
    selectedFile.revisions.find(
      (r) => r.revision_id === selectedFile.current_revision_id
    ) || selectedFile.revisions[selectedFile.revisions.length - 1];

  const stateIndex = useMemo(() => indexStateOverview(stateOverview), [stateOverview]);
  const artifactState = artifactStateOf(stateIndex, selectedFile.file_id);

  const [copiedToAgent, setCopiedToAgent] = useState(false);

  const handleCopyObjectToAgent = async () => {
    let excerpt = '';
    if (selectedFile.format === 'pdf') {
      excerpt = (currentRev.pdfPages ?? []).map((pg) => pg.extractedText).join('\n');
    } else if (selectedFile.format === 'svg') {
      excerpt = (currentRev.svgExtractedTexts ?? []).join('\n');
    } else if (isUtf8TextFormat(selectedFile.format)) {
      excerpt = currentRev.markdownContent ?? '';
      if (!excerpt && currentRev.snapshotAvailable) {
        const result = await fetchRevisionContent(currentRev.revision_id);
        if (result.ok && typeof result.text === 'string') excerpt = result.text;
      }
    }
    const written = await onCopyObjectToAgent({
      file_id: selectedFile.file_id,
      revision_id: currentRev.revision_id,
      relative_path: selectedFile.relative_path,
      content_sha256: currentRev.content_sha256,
      locator: { kind: 'file' },
      evidence_kind: currentRev.snapshotAvailable ? 'explicit_source' : 'metadata_only',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: selectedFile.coverage,
      stale: false,
      excerpt,
      note: noteInput || undefined,
    });
    if (written) {
      setCopiedToAgent(true);
      window.setTimeout(() => setCopiedToAgent(false), 2000);
    }
  };

  const unreadInfo = hasUnreadChanges(selectedFile, readingState);
  const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  const packageListLocal = useMemo(
    () => packages ?? groupFilesIntoPackages(files),
    [packages, files]
  );
  const packageOfSelected = useMemo(() => {
    const id = taskPackageOf(selectedFile.relative_path).id;
    return (
      packageListLocal.find((p) => p.id === id) ??
      packageListLocal.find((p) => p.docs.some((d) => d.fileId === selectedFile.file_id)) ??
      null
    );
  }, [packageListLocal, selectedFile.relative_path, selectedFile.file_id]);
  const activeDocIndex = packageOfSelected
    ? packageOfSelected.readingOrder.findIndex((d) => d.fileId === selectedFile.file_id)
    : -1;
  const prevDoc: PackageDoc | null =
    packageOfSelected && activeDocIndex > 0
      ? packageOfSelected.readingOrder[activeDocIndex - 1]
      : null;
  const nextDoc: PackageDoc | null =
    packageOfSelected &&
    activeDocIndex >= 0 &&
    activeDocIndex < packageOfSelected.readingOrder.length - 1
      ? packageOfSelected.readingOrder[activeDocIndex + 1]
      : null;

  const latestRevisionId =
    selectedFile.revisions[selectedFile.revisions.length - 1]?.revision_id ?? '';
  const isLatestRev =
    selectedFile.revisions.length > 0 && currentRev.revision_id === latestRevisionId;

  const trailModel = useMemo(
    () => buildTimeTrail(selectedFile.revisions, currentRev.revision_id, latestRevisionId),
    [selectedFile.revisions, currentRev.revision_id, latestRevisionId]
  );
  const handleToggleTrailNode = (node: TimeTrailNode) => {
    setTrailExpanded((prev) => {
      const def = node.isCurrent && node.diffAvailable;
      return { ...prev, [node.revisionId]: !(prev[node.revisionId] ?? def) };
    });
  };

  const outgoingEdges = relations.filter((r) => r.source_id === selectedFile.file_id);
  const incomingEdges = relations.filter((r) => r.target_id === selectedFile.file_id);

  const peerGroupsOf = (edges: RelationEdge[], peerOf: (e: RelationEdge) => string) => {
    const order: string[] = [];
    const byPeer = new Map<string, RelationEdge[]>();
    for (const edge of edges) {
      const peer = peerOf(edge);
      const bucket = byPeer.get(peer);
      if (bucket) bucket.push(edge);
      else {
        byPeer.set(peer, [edge]);
        order.push(peer);
      }
    }
    return order.map((peerId) => ({ peerId, edges: byPeer.get(peerId)! }));
  };
  const outgoingPeerGroups = peerGroupsOf(outgoingEdges, (e) => e.target_id);
  const incomingPeerGroups = peerGroupsOf(incomingEdges, (e) => e.source_id);
  const peerDocCount = outgoingPeerGroups.length + incomingPeerGroups.length;

  const peerTitleOf = (peerId: string): { title: string; prefix: string } => {
    const peerFile = fileById.get(peerId);
    if (peerFile) {
      const sameTitlePaths = files
        .filter((item) => item.title === peerFile.title)
        .map((item) => item.relative_path);
      return {
        title: peerFile.title,
        prefix: minimalDirPrefix(peerFile.relative_path, sameTitlePaths),
      };
    }
    const peerDecision = decisions.find((item) => item.decision_id === peerId);
    if (peerDecision) {
      return { title: `${peerDecision.namespace} :: ${peerDecision.code}`, prefix: '' };
    }
    return { title: peerId, prefix: '' };
  };

  const peerPreviewOf = (peerId: string): string =>
    peerHoverPreviewOf(peerId, files, decisions);

  const lineBadgeOf = (edges: RelationEdge[]): string => {
    const lines = Array.from(
      new Set(
        edges
          .map((e) => e.locator?.startLine)
          .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      )
    ).sort((a, b) => a - b);
    if (lines.length === 0) return '';
    const shown = lines.slice(0, 4).map((n) => `L${n}`).join('/');
    return lines.length > 4 ? `${shown}/…` : shown;
  };

  const linkedDecisions = decisions.filter((d) =>
    d.evidences.some((ev) => ev.file_id === selectedFile.file_id)
  );

  const linkedPending = linkedDecisions.filter((d) => isUnresolvedDecision(d));
  const linkedSettled = linkedDecisions.filter(
    (d) => !isUnresolvedDecision(d) && DECIDED_DECISION_STATUSES.includes(d.status)
  );
  const linkedCandidates = linkedDecisions.filter(
    (d) => !isUnresolvedDecision(d) && !DECIDED_DECISION_STATUSES.includes(d.status)
  );

  const isFileId = (id: string) => fileById.has(id);

  const canJumpMachine = canOpenTimeMachine(selectedFile.format);

  const renderDecisionRow = (dec: DecisionAssertion) => {
    const officeEv = pickPrimaryOfficeEvidence(dec);
    const officeLabel = officeEv?.officeAnchor
      ? formatOfficeAnchorLabel(officeEv.officeAnchor)
      : '';
    const pdfEv = pickPrimaryPdfEvidence(dec);
    const pdfLabel = pdfEv?.pdfAnchor
      ? formatPdfAnchorLabel(pdfEv.pdfAnchor)
      : '';
    return (
      <div
        key={dec.decision_id}
        className={`rounded border transition-colors ${
          selectedDecision?.decision_id === dec.decision_id
            ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_15%,transparent)] border-[color:color-mix(in_srgb,var(--accent-iris)_70%,transparent)]'
            : 'bg-muted/70 border-[color:var(--glass-hairline)] hover:border-[color:var(--glass-hairline-strong)]'
        }`}
      >
        <button
          type="button"
          onClick={() => onOpenDecision(dec.decision_id)}
          className="w-full text-left p-2.5 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] cursor-pointer"
        >
          <div className="flex items-center justify-between font-mono text-[11px]">
            <span className="text-[color:var(--accent-iris-deep)] font-semibold">
              {dec.code} ({dec.status})
            </span>
            <span className="text-[color:var(--ink-soft)] truncate max-w-[140px]">
              {dec.namespace}
            </span>
          </div>
          <div className="text-[color:var(--ink-strong)] line-clamp-2 mt-1">
            {dec.question}
          </div>
        </button>
        {officeEv && officeLabel && (
          <div className="px-2.5 pb-2 -mt-0.5 flex items-center">
            <button
              type="button"
              onClick={() => onOpenDecision(dec.decision_id, officeEv)}
              title={`一键直达高亮：${officeEv.relative_path}#${officeLabel}`}
              className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_20%,transparent)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--accent-iris-ink)] cursor-pointer transition-colors"
            >
              <span>直达表/段：{officeLabel}</span>
            </button>
          </div>
        )}
        {pdfEv && pdfLabel && (
          <div className="px-2.5 pb-2 -mt-0.5 flex items-center">
            <button
              type="button"
              onClick={() => onOpenDecision(dec.decision_id, pdfEv)}
              title={`一键直达高亮：${pdfEv.relative_path}#page=${pdfEv.pdfAnchor?.page}`}
              className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_20%,transparent)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--accent-iris-ink)] cursor-pointer transition-colors"
            >
              <span>直达页：{pdfLabel}</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderDecisionGroup = (
    groupKey: 'pending' | 'settled' | 'candidates',
    label: string,
    items: DecisionAssertion[],
    tone: string
  ) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-1.5" data-decision-group={groupKey}>
        <div className={`font-mono text-[length:var(--text-micro)] ${tone}`}>
          {label}（{items.length}）
        </div>
        {items.map(renderDecisionRow)}
      </div>
    );
  };

  return (
    <aside
      aria-label="所选对象详情检查器"
      className="w-80 shrink-0 bg-[color:var(--glass-bg)] backdrop-blur-xl border-l border-border text-[color:var(--ink-strong)] flex flex-col h-full overflow-hidden select-none"
    >
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <section className="space-y-2 pb-1">
          <InitiativeCandidatePanel onOpenFile={onOpenFile} />
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
            <span className="font-semibold tracking-wider">所选对象详情</span>
            {metaExpanded ? (
              <button
                type="button"
                onClick={() => setMetaExpanded(false)}
                className="font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-ink)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] px-2 py-0.5 rounded-full cursor-pointer flex items-center gap-1 transition-colors"
                title="收起元数据明细"
              >
                <Info className="w-3 h-3" />
                <span>收起明细</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setMetaExpanded(true)}
                className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer flex items-center gap-1 transition-colors"
              >
                <Info className="w-3 h-3" />
                <span>详情/溯源</span>
              </button>
            )}
          </div>

          <div
            className="depth-2-card p-3.5 space-y-2.5"
            onContextMenu={(e) => {
              if (!systemActions?.onOpenFileContextMenu) return;
              e.preventDefault();
              e.stopPropagation();
              systemActions.onOpenFileContextMenu(e, {
                kind: 'file',
                relativePath: selectedFile.relative_path,
                title: selectedFile.title,
                fileId: selectedFile.file_id,
                revisionId: currentRev.revision_id,
              });
            }}
          >
            <h2
              onClick={() => setExpandFullPath((v) => !v)}
              className={`text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)] cursor-pointer ${
                expandFullPath ? '' : 'line-clamp-2'
              }`}
              title="点击展开/收起完整路径"
            >
              {selectedFile.title}
            </h2>
            {(() => {
              const base = basenameOf(selectedFile.relative_path);
              const subLabel = expandFullPath
                ? selectedFile.relative_path
                : base === selectedFile.title
                  ? selectedFile.relative_path
                  : base;
              return (
                <div
                  className={`text-[11.5px] leading-[17px] font-mono text-[color:var(--ink-soft)] ${
                    expandFullPath ? 'break-all' : 'truncate'
                  }`}
                  title={selectedFile.relative_path}
                >
                  {subLabel}
                </div>
              );
            })()}
            {artifactState && (
              <div className="flex items-center gap-1.5">
                <span
                  data-doc-state={artifactState.state}
                  className={docStatePillClass(artifactState.state)}
                  title={`文档状态：${DOC_STATE_LABEL[artifactState.state]}`}
                >
                  {DOC_STATE_LABEL[artifactState.state]}
                </span>
              </div>
            )}
            <p className="text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)] pt-1 border-t border-[color:var(--glass-hairline)]">
              {currentRev.summaryNote}
            </p>
            <div className="p-2.5 rounded-[var(--r-block)] bg-muted/70 border border-border/70 space-y-1.5 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)]">
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--ink-soft)] flex items-center gap-1">
                  <Tag className="w-3 h-3" />
                  <span>角色：{selectedFile.role}</span>
                </span>
                <span className="font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-deep)]">
                  {selectedFile.roleProvenance}
                </span>
              </div>
              {selectedFile.topics.map((t) => (
                <div key={t.name} className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                  主题「<strong className="text-[color:var(--ink-strong)]">{t.name}</strong>」·{' '}
                  <span className="text-[color:var(--stage-ink-deliver-text)]">{t.provenance}</span>（{t.rule}）
                </div>
              ))}
            </div>
            {systemActions &&
              systemActions.onRevealInExplorer &&
              systemActions.onOpenWithDefaultApp &&
              systemActions.onCopyRelativePath &&
              systemActions.onCopyAbsolutePath && (
                <div className="pt-2 border-t border-[color:var(--glass-hairline)]">
                  <FileSystemActionBar
                    compact
                    relativePath={selectedFile.relative_path}
                    fileId={selectedFile.file_id}
                    title={selectedFile.title}
                    desktopSupported={Boolean(systemActions.desktopSystemSupported)}
                    hasRootPath={Boolean(systemActions.hasWorkspaceRoot)}
                    onRevealInExplorer={systemActions.onRevealInExplorer}
                    onOpenWithDefaultApp={systemActions.onOpenWithDefaultApp}
                    onCopyRelativePath={systemActions.onCopyRelativePath}
                    onCopyAbsolutePath={systemActions.onCopyAbsolutePath}
                    onRenameFile={systemActions.onRenameFile}
                    onMoveFile={systemActions.onMoveFile}
                    onTrashFile={systemActions.onTrashFile}
                  />
                </div>
              )}
          </div>

          {metaExpanded ? (
            <div className="p-3 rounded-[var(--r-block)] bg-muted/70 border border-border/70 space-y-1.5 text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-mono tabular-nums">
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--ink-soft)] font-sans">检测到更新 (observed_at)</span>
                <span className="text-[color:var(--accent-iris-deep)]">{formatRelativeObservedAt(currentRev.observed_at)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--ink-soft)] font-sans">文档声称日期 (source_time)</span>
                <span className="text-[color:var(--ink-strong)]">{currentRev.source_time || '未声明'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--ink-soft)] font-sans">Git 提交 (commit_time)</span>
                <span className="text-[color:var(--ink-strong)]">
                  {currentRev.commit_time
                    ? currentRev.commit_time.slice(5, 16).replace('T', ' ')
                    : '未知 (无提交记录)'}
                </span>
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-[color:var(--glass-hairline)]">
                <span className="text-[color:var(--ink-soft)] font-sans">作者 / 智能体轮次</span>
                <span className="text-[color:var(--ink-soft)] truncate max-w-[145px]">
                  {currentRev.agent_turn_hint || currentRev.author_hint || '未知'}
                </span>
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-[color:var(--glass-hairline)]">
                <span className="text-[color:var(--ink-soft)] font-sans">版本</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[color:var(--ink-strong)]">
                    {revisionVersionLabel(currentRev.versionNumber, isLatestRev)}
                  </span>
                  <CopyIdButton id={currentRev.revision_id} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--ink-soft)] font-sans">文件大小</span>
                <span className="text-[color:var(--ink-strong)]">
                  {(currentRev.sizeBytes / 1024).toFixed(1)} KB
                </span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-[color:var(--ink-soft)] font-sans shrink-0">完整路径</span>
                <span className="text-[color:var(--ink-strong)] break-all text-right min-w-0">
                  {selectedFile.relative_path}
                </span>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setMetaExpanded(true)}
              className="w-full px-2.5 py-1.5 rounded-[9px] bg-[color:var(--depth-1-bg)] hover:bg-accent border border-transparent hover:border-border font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer flex items-center justify-between transition-all"
            >
              <span className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-[color:var(--accent-iris)]" />
                <span>展开时间戳与版本溯源明细</span>
              </span>
              <span className="text-[10px] opacity-65">v{currentRev.versionNumber}</span>
            </button>
          )}
        </section>

        <TimeTrailCard
          model={trailModel}
          unreadLabel={unreadStatusLabel(unreadInfo.reason)}
          expandedIds={trailExpanded}
          onToggleNode={handleToggleTrailNode}
          onOpenRevision={(revisionId) => onOpenFile(selectedFile.file_id, revisionId)}
          onOpenTimeline={
            onOpenFileTimeline
              ? () => onOpenFileTimeline(selectedFile.file_id)
              : undefined
          }
          canJumpMachine={canJumpMachine}
          onJumpMachine={canJumpMachine ? onViewRelationsGraph : undefined}
        />

        <section className="space-y-2" data-inspector-references="">
          <div className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-soft)] flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-[color:var(--accent-iris)]" />
            <span>
              引用与反向引用（{peerDocCount} 篇对端 ·{' '}
              {outgoingEdges.length + incomingEdges.length} 处）
            </span>
          </div>

          <div className="depth-2-card p-3 space-y-2 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)]">
            {outgoingPeerGroups.length > 0 && (
              <div data-ref-group="out">
                <button
                  type="button"
                  onClick={() => setRefsOpen((prev) => ({ ...prev, out: !prev.out }))}
                  aria-expanded={refsOpen.out}
                  aria-label={
                    refsOpen.out ? '收起正向引用分组' : '展开正向引用分组'
                  }
                  className="w-full flex items-center gap-1.5 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer py-1"
                >
                  <ChevronDown
                    className={`w-3 h-3 motion-safe:transition-transform ${refsOpen.out ? 'rotate-180' : ''}`}
                  />
                  <span>正向引用（{outgoingPeerGroups.length} 篇对端）</span>
                </button>
                {refsOpen.out && (
                  <div className="mt-1 space-y-1.5">
                    {outgoingPeerGroups.map(({ peerId, edges }) => {
                      const targetFile = fileById.get(peerId);
                      const targetRev =
                        targetFile?.revisions.find((r) => r.revision_id === targetFile.current_revision_id) ??
                        targetFile?.revisions[0];
                      const previewText = peerPreviewOf(peerId) || undefined;
                      const pt = peerTitleOf(peerId);
                      const previewPayload: PeerRefPreviewPayload = {
                        title: pt.title,
                        relativePath: targetFile?.relative_path,
                        formatLabel: targetFile ? formatUiMeta(targetFile.format).label : '决策',
                        versionLabel: targetRev ? `v${targetRev.versionNumber || 1}` : undefined,
                        summary: previewText || '暂无摘要',
                        updatedText: targetRev?.source_time
                          ? targetRev.source_time.slice(0, 10)
                          : targetRev?.observed_at
                            ? formatRelativeObservedAt(targetRev.observed_at)
                            : undefined,
                      };
                      return (
                        <PeerRefCard
                          key={peerId}
                          direction="out"
                          peerId={peerId}
                          edges={edges}
                          peerTitle={pt}
                          lineBadge={lineBadgeOf(edges)}
                          isFileTarget={isFileId(peerId)}
                          hoverPreview={previewText}
                          previewPayload={previewPayload}
                          previewHandle={refPreviewHandle}
                          onOpenFile={onOpenFile}
                          onOpenDecision={onOpenDecision}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {incomingPeerGroups.length > 0 && (
              <div data-ref-group="in">
                <button
                  type="button"
                  onClick={() => setRefsOpen((prev) => ({ ...prev, in: !prev.in }))}
                  aria-expanded={refsOpen.in}
                  aria-label={
                    refsOpen.in ? '收起反向被引用分组' : '展开反向被引用分组'
                  }
                  className="w-full flex items-center gap-1.5 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer py-1"
                >
                  <ChevronDown
                    className={`w-3 h-3 motion-safe:transition-transform ${refsOpen.in ? 'rotate-180' : ''}`}
                  />
                  <span>反向被引用（{incomingPeerGroups.length} 篇对端）</span>
                </button>
                {refsOpen.in && (
                  <div className="mt-1 space-y-1.5">
                    {incomingPeerGroups.map(({ peerId, edges }) => {
                      const targetFile = fileById.get(peerId);
                      const targetRev =
                        targetFile?.revisions.find((r) => r.revision_id === targetFile.current_revision_id) ??
                        targetFile?.revisions[0];
                      const previewText = peerPreviewOf(peerId) || undefined;
                      const pt = peerTitleOf(peerId);
                      const previewPayload: PeerRefPreviewPayload = {
                        title: pt.title,
                        relativePath: targetFile?.relative_path,
                        formatLabel: targetFile ? formatUiMeta(targetFile.format).label : '决策',
                        versionLabel: targetRev ? `v${targetRev.versionNumber || 1}` : undefined,
                        summary: previewText || '暂无摘要',
                        updatedText: targetRev?.source_time
                          ? targetRev.source_time.slice(0, 10)
                          : targetRev?.observed_at
                            ? formatRelativeObservedAt(targetRev.observed_at)
                            : undefined,
                      };
                      return (
                        <PeerRefCard
                          key={peerId}
                          direction="in"
                          peerId={peerId}
                          edges={edges}
                          peerTitle={pt}
                          lineBadge={lineBadgeOf(edges)}
                          isFileTarget={isFileId(peerId)}
                          hoverPreview={previewText}
                          previewPayload={previewPayload}
                          previewHandle={refPreviewHandle}
                          onOpenFile={onOpenFile}
                          onOpenDecision={onOpenDecision}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {peerDocCount === 0 && (
              <div className="text-[color:var(--ink-soft)]">暂无引用与反引用</div>
            )}
          </div>
        </section>

        <section className="space-y-2" data-inspector-decisions="">
          <div className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-soft)] flex items-center gap-1.5">
            <Scale className="w-3.5 h-3.5 text-[color:var(--stage-ink-decision)]" />
            <span>决策与归属（{linkedDecisions.length}）</span>
          </div>

          <div className="depth-2-card p-3 space-y-2.5 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)]">
            {linkedDecisions.length === 0 ? (
              <div className="text-[color:var(--ink-soft)]">暂无直接关联的显式决策卡</div>
            ) : (
              <>
                {renderDecisionGroup('pending', '待拍板', linkedPending, 'text-[color:var(--stage-ink-decision-text)]')}
                {renderDecisionGroup('settled', '已定案', linkedSettled, 'text-[color:var(--stage-ink-deliver-text)]')}
                {renderDecisionGroup('candidates', '候选线索（未定案）', linkedCandidates, 'text-[color:var(--ink-soft)]')}
              </>
            )}

            {(prevDoc || nextDoc) && (
              <div className="space-y-1.5 pt-1 border-t border-[color:var(--glass-hairline)]" data-inspector-package-flow="">
                <div className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] pt-1">
                  专项上下游（阅读顺序）
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {prevDoc && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenFile(prevDoc.fileId)}
                      title={`上游：${prevDoc.title}`}
                    >
                      <ArrowLeft className="w-3 h-3" />
                      <span className="truncate max-w-[200px]">{prevDoc.title}</span>
                    </Button>
                  )}
                  {nextDoc && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenFile(nextDoc.fileId)}
                      title={`下游：${nextDoc.title}`}
                    >
                      <span className="truncate max-w-[200px]">{nextDoc.title}</span>
                      <ArrowRight className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-1.5">
          <label className="block text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-soft)]">
            个人阅读备注（仅保存本地 SQLite，不写回源文档）
          </label>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="添加个人核对备注..."
              className="glass-input flex-1 rounded px-2.5 py-1.5 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] focus:outline-none focus:border-[color:var(--accent-iris-deep)]"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSavePersonalNote(selectedFile.file_id, noteInput)}
              className="shrink-0"
            >
              保存
            </Button>
          </div>
        </section>
      </div>

      <div className="p-3.5 border-t border-[color:var(--glass-hairline)] bg-[color:var(--glass-bg-panel)] backdrop-blur-xl space-y-2">
        {onOpenFileTimeline && (
          <Button
            variant="secondary"
            fullWidth
            onClick={() => onOpenFileTimeline(selectedFile.file_id)}
            className="whitespace-nowrap"
          >
            <History className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
            <span>文件时间线 · 版本链与相关事件</span>
          </Button>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onViewRelationsGraph} className="whitespace-nowrap">
            <Network className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris)]" />
            <span>查看关联</span>
          </Button>

          <Button onClick={handleCopyObjectToAgent} className="whitespace-nowrap">
            {copiedToAgent ? (
              <>
                <Check className="w-3.5 h-3.5 shrink-0" />
                <span>已复制到剪贴板</span>
              </>
            ) : (
              <>
                <ClipboardCopy className="w-3.5 h-3.5 shrink-0" />
                <span>复制给智能体</span>
              </>
            )}
          </Button>
        </div>
      </div>
      <PreviewCard<PeerRefPreviewPayload> handle={refPreviewHandle}>
        {({ payload }) => {
          if (!payload) return null;
          return (
            <PreviewCardPopup side="left" align="center" sideOffset={10} data-inspector-preview-card="">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[12.5px] text-foreground leading-snug line-clamp-2">
                    {payload.title}
                  </div>
                  {payload.relativePath && (
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground truncate">
                      {payload.relativePath}
                    </div>
                  )}
                </div>
                {payload.formatLabel && (
                  <Badge variant="secondary" size="sm" className="font-mono text-[9.5px] shrink-0">
                    {payload.formatLabel}
                  </Badge>
                )}
              </div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground line-clamp-3">
                {payload.summary}
              </p>
              {(payload.versionLabel || payload.updatedText) && (
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-border text-[10px] font-mono text-muted-foreground tabular-nums">
                  <span>{payload.versionLabel ?? ''}</span>
                  <span>{payload.updatedText ?? ''}</span>
                </div>
              )}
            </PreviewCardPopup>
          );
        }}
      </PreviewCard>
    </aside>
  );
};
