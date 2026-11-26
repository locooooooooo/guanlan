
import React from 'react';
import { cleanDisplayText } from '../../utils/displayText';
import { formatOfficeAnchorLabel, pickPrimaryOfficeEvidence } from '../../utils/officeAnchor';
import { formatPdfAnchorLabel, pickPrimaryPdfEvidence } from '../../utils/pdfAnchor';
import { formatLocalClock } from '../../utils/timeFormat';
import { taskPackageOf } from '../../utils/taskPackages';
import type { DecisionAssertion, DecisionSourceEvidence, FileRecord, RelationEdge, TimelineEvent } from '../../types/guanlan';
import type { CanvasEventScene } from '../../utils/graphEvents';
import type { EventDayGranularity } from '../../services/workspaceClient';
import type { CanvasNarrativeSection } from '../canvas/CanvasNarrativeDrawer';
import { sceneDateLabel, type SubAgentCardModel } from './geometry';

interface GraphNarrativeInputs {
  narrativeTarget: { nodeId?: string; fileId?: string } | null;
  subAgentCards: SubAgentCardModel[];
  files: FileRecord[];
  decisions: DecisionAssertion[];
  relations: RelationEdge[];
  scene: CanvasEventScene;
  rulerGranularity: EventDayGranularity;
  packageGroups: Array<{ pkgId: string; name: string; docs: Array<{ fileId: string; title: string }>; stage: unknown }>;
  orderedPackageGroups: Array<{ pkgId: string; name: string; docs: Array<{ fileId: string; title: string }>; stage: unknown }>;
  focusedPkgId: string;
  unreadCount: number;
  workspaceName: string;
  onOpenDecisionModal: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
  onSelectCitation?: (fileId: string) => void;
  activeFileRecord: FileRecord | null;
}

function renderNarrativeCitations(
  fileRelations: RelationEdge[],
  currentFileId: string,
  files: FileRecord[],
  onSelectCitation?: (fileId: string) => void
): React.ReactNode {
  const grouped: Array<{
    key: string;
    otherId: string;
    other: FileRecord | undefined;
    isOutgoing: boolean;
    tag: string;
    count: number;
    firstLine?: number;
  }> = [];
  const byKey = new Map<string, (typeof grouped)[number]>();
  for (const rel of fileRelations) {
    const isOutgoing = rel.source_id === currentFileId;
    const otherId = isOutgoing ? rel.target_id : rel.source_id;
    const tag = rel.label || (isOutgoing ? '引用 →' : '被引用 ←');
    const key = `${isOutgoing ? 'out' : 'in'}:${otherId}:${tag}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.firstLine === undefined && rel.locator?.startLine) {
        existing.firstLine = rel.locator.startLine;
      }
    } else {
      const entry = {
        key,
        otherId,
        other: files.find((f) => f.file_id === otherId),
        isOutgoing,
        tag,
        count: 1,
        firstLine: rel.locator?.startLine,
      };
      byKey.set(key, entry);
      grouped.push(entry);
    }
  }
  const shown = grouped.slice(0, 6);
  const restCount = grouped.length - shown.length;
  return (
    <div className="cvw-narrative-ref-list">
      {shown.map((item) => {
        const title = item.other ? item.other.title : item.otherId;
        const metaSuffix =
          item.count > 1
            ? ` · ${item.count} 处`
            : item.firstLine
              ? ` · L${item.firstLine}`
              : '';
        const tagText = `${item.tag}${metaSuffix}`;
        if (item.other && onSelectCitation) {
          const targetId = item.other.file_id;
          return (
            <button
              type="button"
              key={item.key}
              className="cvw-narrative-ref-item cvw-narrative-ref-item--interactive"
              title={`查看引用文档：${item.other.relative_path || title}`}
              onClick={() => onSelectCitation(targetId)}
            >
              <span className="cvw-narrative-ref-title">{title}</span>
              <span className="cvw-narrative-ref-tag">{tagText}</span>
            </button>
          );
        }
        return (
          <div key={item.key} className="cvw-narrative-ref-item">
            <span className="cvw-narrative-ref-title">{title}</span>
            <span className="cvw-narrative-ref-tag">{tagText}</span>
          </div>
        );
      })}
      {restCount > 0 && (
        <div className="cvw-narrative-ref-more">另有 {restCount} 份引用文档</div>
      )}
    </div>
  );
}

export function useGraphCanvasNarrative({
  narrativeTarget,
  subAgentCards,
  files,
  decisions,
  relations,
  scene,
  rulerGranularity,
  packageGroups,
  orderedPackageGroups,
  focusedPkgId,
  unreadCount,
  workspaceName,
  onOpenDecisionModal,
  onSelectCitation,
  activeFileRecord,
}: GraphNarrativeInputs) {

  const narrative = React.useMemo(() => {
    if (narrativeTarget?.nodeId) {
      const card = subAgentCards.find((c) => c.id === narrativeTarget.nodeId);
      if (card) {
        const file = card.fileId
          ? files.find((f) => f.file_id === card.fileId) ?? null
          : null;
        const rev = file && card.revisionId
          ? file.revisions.find((r) => r.revision_id === card.revisionId)
          : undefined;
        const changedSections = rev?.changedSectionsFromPrev ?? [];
        const decision = card.decisionId
          ? decisions.find((d) => d.decision_id === card.decisionId) ?? null
          : null;
        const fileRelations = file
          ? relations.filter((r) => r.source_id === file.file_id || r.target_id === file.file_id)
          : [];
        const occurText = cleanDisplayText(card.detail) || card.detail || '（本事件未记录 headline）';
        const fallbackSummary = rev?.summaryNote ? cleanDisplayText(rev.summaryNote) : '';
        const sections: CanvasNarrativeSection[] = [
          {
            id: 'occur',
            label: '发生',
            timestamp: `${card.timeRange}${card.observedClock ? ` ${card.observedClock}` : ''}`,
            tone: 'default',
            body: occurText,
          },
          {
            id: 'changes',
            label: '变更章节',
            tone: 'change',
            body:
              changedSections.length > 0 ? (
                changedSections.map((section, i) => (
                  <div className="cvw-narrative-list-row" key={`${section}-${i}`}>
                    <span className="cvw-narrative-list-kind">[修改]</span>
                    <span>{cleanDisplayText(section) || section}</span>
                  </div>
                ))
              ) : fallbackSummary && fallbackSummary !== occurText ? (
                fallbackSummary
              ) : (
                <span className="cvw-narrative-muted">
                  未记录章节级变更（初版收录或仅元数据更新）。
                </span>
              ),
          },
          {
            id: 'decisions',
            label: '关联决策',
            tone: 'decision',
            body: decision ? (
              <div className="space-y-1">
                <button
                  type="button"
                  className="cvw-narrative-action"
                  onClick={() => onOpenDecisionModal(decision.decision_id)}
                >
                  {decision.namespace}::{decision.code}（{decision.status}）· 追溯决策
                </button>
                {(() => {
                  const officeEv = pickPrimaryOfficeEvidence(decision);
                  if (officeEv?.officeAnchor) {
                    const label = formatOfficeAnchorLabel(officeEv.officeAnchor);
                    return (
                      <button
                        type="button"
                        className="cvw-narrative-action"
                        onClick={() => onOpenDecisionModal(decision.decision_id, officeEv)}
                      >
                        直达 Office 依据：{label}
                      </button>
                    );
                  }
                  const pdfEv = pickPrimaryPdfEvidence(decision);
                  if (!pdfEv?.pdfAnchor) return null;
                  return (
                    <button
                      type="button"
                      className="cvw-narrative-action"
                      onClick={() => onOpenDecisionModal(decision.decision_id, pdfEv)}
                    >
                      直达 PDF 依据：{formatPdfAnchorLabel(pdfEv.pdfAnchor)}
                    </button>
                  );
                })()}
              </div>
            ) : (
              '本事件未关联决策断言。'
            ),
          },
          {
            id: 'refs',
            label: '引用依据',
            body:
              fileRelations.length > 0 ? (
                renderNarrativeCitations(fileRelations, file?.file_id ?? '', files, onSelectCitation)
              ) : (
                <span className="cvw-narrative-muted">
                  共 {card.peakMetric} 条引用依据（未解析到具体引用边）。
                </span>
              ),
          },
        ];
        return {
          title: card.dirPrefix ? `${card.dirPrefix}/${card.fileName}` : card.fileName,
          metaLine: '已选中 · 层级 1',
          sections,
          footerFileId: card.fileId || '',
          decisionId: card.decisionId ?? null,
        };
      }
    }

    const fileId = narrativeTarget?.fileId ?? '';
    const file = fileId ? files.find((f) => f.file_id === fileId) ?? null : null;
    if (file) {
      const rev =
        file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
        file.revisions[file.revisions.length - 1];
      const changedSections = rev?.changedSectionsFromPrev ?? [];
      const fileDecisions = decisions.filter((d) =>
        d.evidences.some((e) => e.file_id === file.file_id)
      );
      const fileRelations = relations.filter(
        (r) => r.source_id === file.file_id || r.target_id === file.file_id
      );
      const pkg = taskPackageOf(file.relative_path);
      const sections: CanvasNarrativeSection[] = [
        {
          id: 'occur',
          label: '发生',
          timestamp: rev?.observed_at ? formatLocalClock(rev.observed_at) : undefined,
          tone: 'default',
          body: `「${pkg.name}」${rev ? `v${rev.versionNumber}` : ''} · ${file.role} · ${
            rev?.summaryNote ? rev.summaryNote : '当前版本未记录摘要'
          }`,
        },
        {
          id: 'changes',
          label: '变更章节',
          tone: 'change',
          body:
            changedSections.length > 0 ? (
              changedSections.map((section, i) => (
                <div className="cvw-narrative-list-row" key={`${section}-${i}`}>
                  <span className="cvw-narrative-list-kind">[修改]</span>
                  <span>{section}</span>
                </div>
              ))
            ) : (
              '相对上一版本无章节级变更记录。'
            ),
        },
        {
          id: 'decisions',
          label: '关联决策',
          tone: 'decision',
            body:
              fileDecisions.length > 0 ? (
                fileDecisions.map((d) => {
                  const officeEv = pickPrimaryOfficeEvidence(d);
                  const officeLabel = officeEv?.officeAnchor
                    ? formatOfficeAnchorLabel(officeEv.officeAnchor)
                    : '';
                  const pdfEv = pickPrimaryPdfEvidence(d);
                  const pdfLabel = pdfEv?.pdfAnchor
                    ? formatPdfAnchorLabel(pdfEv.pdfAnchor)
                    : '';
                  return (
                    <div className="space-y-1" key={d.decision_id}>
                      <button
                        type="button"
                        className="cvw-narrative-action"
                        onClick={() => onOpenDecisionModal(d.decision_id)}
                      >
                        {d.namespace}::{d.code}（{d.status}）· 追溯决策
                      </button>
                      {officeEv && officeLabel && (
                        <button
                          type="button"
                          className="cvw-narrative-action"
                          onClick={() => onOpenDecisionModal(d.decision_id, officeEv)}
                        >
                          直达 Office 依据：{officeLabel}
                        </button>
                      )}
                      {pdfEv && pdfLabel && (
                        <button
                          type="button"
                          className="cvw-narrative-action"
                          onClick={() => onOpenDecisionModal(d.decision_id, pdfEv)}
                        >
                          直达 PDF 依据：{pdfLabel}
                        </button>
                      )}
                    </div>
                  );
                })
              ) : (
              '本文件未关联决策断言。'
            ),
        },
        {
          id: 'refs',
          label: '引用依据',
          body:
            fileRelations.length > 0 ? (
              renderNarrativeCitations(fileRelations, file.file_id, files, onSelectCitation)
            ) : (
              <span className="cvw-narrative-muted">未解析到引用边。</span>
            ),
        },
      ];
      return {
        title: file.title,
        metaLine: '已选中 · 层级 1',
        sections,
        footerFileId: file.file_id,
        decisionId: fileDecisions[0]?.decision_id ?? null,
      };
    }

    const focusedGroup = orderedPackageGroups.find((g) => g.pkgId === focusedPkgId) ?? null;
    const sections: CanvasNarrativeSection[] = [
      {
        id: 'overview',
        label: '工程事件轴',
        timestamp: scene.hasRealEvents ? sceneDateLabel(scene.activeDate, rulerGranularity) : undefined,
        tone: 'default',
        body: scene.hasRealEvents
          ? `${scene.totals.events} 条事件 · ${scene.totals.days} 天 · ${scene.totals.matters} 个事项${
              scene.totals.undated ? ` · ${scene.totals.undated} 条待考` : ''
            }`
          : '等待工程事件接入后展示。',
      },
      {
        id: 'packages',
        label: '任务包',
        tone: 'default',
        body: `${packageGroups.length} 个任务包横排于桌面带${
          focusedGroup ? ` · 当前焦点：${focusedGroup.name}（${focusedGroup.docs.length} 份文档）` : ''
        }`,
      },
      {
        id: 'reading',
        label: '待阅',
        tone: 'change',
        body: `${unreadCount} 份未读（未读新件 / 读后有更新）。`,
      },
    ];
    return {
      title: `${workspaceName} · 工程事件轴`,
      metaLine: '已选中 · 层级 0',
      sections,
      footerFileId: files[0]?.file_id ?? '',
      decisionId: null,
    };
  }, [
    narrativeTarget,
    subAgentCards,
    files,
    decisions,
    relations,
    scene,
    rulerGranularity,
    packageGroups,
    orderedPackageGroups,
    focusedPkgId,
    unreadCount,
    workspaceName,
    onOpenDecisionModal,
    onSelectCitation,
  ]);

  const narrativeCopyFileId =
    narrative.footerFileId || activeFileRecord?.file_id || files[0]?.file_id || '';
  return { narrative, narrativeCopyFileId };
}
