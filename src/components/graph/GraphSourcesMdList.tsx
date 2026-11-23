/**
 * D01-a 拆解 · Sources 面板 · Instructions(MD) 展开清单（自 GraphSourcesPanel.tsx
 * 原样迁入，行数护栏 <600；迁移纪律：JSX 与类名逐字一致）。
 */
import React from 'react';
import { hasUnreadChanges } from '../../utils/guanlanEngine';
import { taskPackageOf, stageOfPath } from '../../utils/taskPackages';
import { basenameOf } from '../../utils/documentIdentity';
import type { FileRecord, ReadingState } from '../../types/guanlan';
import type { SubAgentCardModel } from './geometry';

interface GraphSourcesMdListProps {
  visibleMdFiles: FileRecord[];
  mdFiles: FileRecord[];
  readingStates: Record<string, ReadingState>;
  subAgentCards: SubAgentCardModel[];
  activeFileRecord: FileRecord | null;
  showAllMdSources: boolean;
  setShowAllMdSources: (updater: (v: boolean) => boolean) => void;
  onSelectFile: (fileId: string, revisionId?: string) => void;
  setSelectedCanvasNodeId: (id: string) => void;
  exploreAfterClick: (fileId: string, revisionId?: string, eventId?: string) => void;
  cancelExplore: () => void;
  openFileReader: (fileId: string, mode?: 'read' | 'diff_since_read' | 'relations', revisionId?: string) => void;
}

/** Instructions(MD) 展开清单：任务包 chip + 核心文档名行 + 展开其余钮。 */
export function GraphSourcesMdList({
  visibleMdFiles,
  mdFiles,
  readingStates,
  subAgentCards,
  activeFileRecord,
  showAllMdSources,
  setShowAllMdSources,
  onSelectFile,
  setSelectedCanvasNodeId,
  exploreAfterClick,
  cancelExplore,
  openFileReader,
}: GraphSourcesMdListProps) {
  return (
    <div className="pl-1 space-y-3">
      {visibleMdFiles.map((file) => {
        const unread = hasUnreadChanges(file, readingStates[file.file_id]).isUnread;
        const matchedCard = subAgentCards.find((c) => c.fileId === file.file_id);
        const isSelected = (activeFileRecord?.file_id || '') === file.file_id;
        const latestRev = file.revisions[file.revisions.length - 1];
        // wf_2（DoD1）：行首不再裸显截断的完整 relative_path——改为「任务包 chip + 核心文档名」，
        // 完整路径收进 title 悬浮（与卡片同源同口径 taskPackageOf/stageOfPath）
        const pkg = taskPackageOf(file.relative_path);
        const docBase = basenameOf(file.relative_path);
        const revKb = Math.max(1, Math.round((latestRev?.sizeBytes || 0) / 1024));
        const revFindings = latestRev?.changedSectionsFromPrev?.length ?? 0;

        return (
          <button
            key={file.file_id}
            type="button"
            onClick={() => {
              onSelectFile(file.file_id);
              if (matchedCard) setSelectedCanvasNodeId(matchedCard.id);
              exploreAfterClick(file.file_id);
            }}
            onDoubleClick={() => {
              // 侧栏行双击仍直开阅读器（旧 readAfterDoubleClick 同行为）；
              // 先取消 pending 单击下钻，防 240ms 后画布被切走
              cancelExplore();
              openFileReader(file.file_id);
            }}
            className={`w-full text-left py-0.5 rounded transition-colors cursor-pointer group ${
              isSelected ? 'text-[color:var(--cv-ink)]' : 'text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)]'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span
                title={file.relative_path}
                className={`flex items-center gap-1.5 min-w-0 text-[11.5px] font-semibold truncate ${
                  isSelected
                    ? 'text-[color:var(--cv-ink)] underline decoration-[color:color-mix(in_srgb,var(--cv-brand)_70%,transparent)] underline-offset-4'
                    : 'text-[color:var(--cv-ink-2)] group-hover:text-[color:var(--cv-ink)]'
                }`}
              >
                <span
                  title={`任务包：${pkg.name} · 路径：${file.relative_path}`}
                  className="shrink-0 max-w-[46%] truncate rounded-[3px] border border-[color:color-mix(in_srgb,var(--cv-lav)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--cv-lav)_10%,var(--cv-panel))] px-1 py-px text-[9px] font-mono font-normal text-[color:var(--cv-lav-ink)]"
                >
                  {pkg.name}
                  {stageOfPath(file.relative_path) !== '待分类'
                    ? `·${stageOfPath(file.relative_path)}`
                    : ''}
                </span>
                <span className="truncate min-w-0">{docBase}</span>
              </span>
              {unread && (
                <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--cv-brand)] shrink-0" />
              )}
            </div>
            <div className="mt-0.5 text-[10.5px] font-mono text-[color:var(--cv-ink-dim)] truncate">
              {revKb} KB · v{latestRev?.versionNumber ?? 1} ·{' '}
              <span className={unread ? 'text-[color:var(--cv-brand)]' : 'text-[color:var(--cv-ink-dim)]'}>
                {revFindings} 处发现
              </span>
            </div>
          </button>
        );
      })}

      {mdFiles.length > 4 && (
        <button
          type="button"
          onClick={() => setShowAllMdSources((v) => !v)}
          className="text-[11px] text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink-3)] pt-0.5 transition-colors cursor-pointer block"
        >
          {showAllMdSources
            ? '收起'
            : `展开其余 ${mdFiles.length - 4} 个`}
        </button>
      )}
    </div>
  );
}
