import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileRecord, TimelineEvent } from '../types/guanlan';
import type { QuickPreviewTarget } from '../components/QuickPreviewModal';
import { clearQuickPreviewCache } from '../utils/quickPreviewHelpers';

export interface BuildQueueInput {
  activeTab: 'home' | 'panorama' | 'library';
  panoramaMode: 'canvas' | 'list' | 'calendar';
  files: FileRecord[];
  filteredFiles: FileRecord[];
  events: TimelineEvent[];
  currentTarget: QuickPreviewTarget | null;
}

/**
 * 为 QuickLook 方向键（↑/↓）构建当前视图的有序文件队列，确保当前目标一定在队列中。
 */
export function buildQuickPreviewQueue({
  activeTab,
  panoramaMode,
  files,
  filteredFiles,
  events,
  currentTarget,
}: BuildQueueInput): QuickPreviewTarget[] {
  let base: QuickPreviewTarget[] = [];

  if (activeTab === 'panorama' && panoramaMode === 'list' && events.length > 0) {
    const seen = new Set<string>();
    for (const ev of events) {
      if (!ev.file_id || seen.has(ev.file_id)) continue;
      seen.add(ev.file_id);
      base.push({
        fileId: ev.file_id,
        revisionId: ev.revision_id || undefined,
      });
    }
  } else if (activeTab === 'library' && filteredFiles.length > 0) {
    base = filteredFiles.map((f) => ({
      fileId: f.file_id,
      revisionId: f.current_revision_id,
    }));
  } else {
    base = files.map((f) => ({
      fileId: f.file_id,
      revisionId: f.current_revision_id,
    }));
  }

  if (currentTarget) {
    const idx = base.findIndex((item) => item.fileId === currentTarget.fileId);
    if (idx === -1) {
      base = [currentTarget, ...base];
    } else if (currentTarget.revisionId) {
      base[idx] = {
        ...base[idx],
        revisionId: currentTarget.revisionId,
      };
    }
  }

  return base;
}

export interface UseQuickPreviewOptions {
  workspaceEpoch: number;
  activeTab: 'home' | 'panorama' | 'library';
  panoramaMode: 'canvas' | 'list' | 'calendar';
  libraryMode: 'read' | 'overview';
  files: FileRecord[];
  filteredFiles: FileRecord[];
  events: TimelineEvent[];
  activeFile: FileRecord | null;
  pinnedRevisionId: string;
  selectedEventId: string;
  hasBlockingOverlay: boolean;
  onSyncSelection: (fileId: string, revisionId?: string) => void;
}

export function useQuickPreview({
  workspaceEpoch,
  activeTab,
  panoramaMode,
  libraryMode,
  files,
  filteredFiles,
  events,
  activeFile,
  pinnedRevisionId,
  selectedEventId,
  hasBlockingOverlay,
  onSyncSelection,
}: UseQuickPreviewOptions) {
  const [target, setTarget] = useState<QuickPreviewTarget | null>(null);

  // 工作区切换时自动关闭轻预览并清空旧工作区预览缓存
  useEffect(() => {
    setTarget(null);
    clearQuickPreviewCache();
  }, [workspaceEpoch]);

  const openQuickPreview = useCallback((fileId: string, revisionId?: string) => {
    if (!fileId) return;
    setTarget({ fileId, revisionId });
  }, []);

  const closeQuickPreview = useCallback(() => {
    setTarget(null);
  }, []);

  const navigateQuickPreview = useCallback(
    (next: QuickPreviewTarget) => {
      setTarget(next);
      onSyncSelection(next.fileId, next.revisionId);
    },
    [onSyncSelection]
  );

  const queue = useMemo(
    () =>
      buildQuickPreviewQueue({
        activeTab,
        panoramaMode,
        files,
        filteredFiles,
        events,
        currentTarget: target,
      }),
    [activeTab, panoramaMode, files, filteredFiles, events, target]
  );

  // 全局 Space 快捷键：画布选中节点 / 时间线选中卡片 / 左栏目录选中文件（不抢输入框与阅读正文滚动）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (target !== null) return;
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (hasBlockingOverlay) return;

      const el = e.target;
      if (el instanceof HTMLElement) {
        if (
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable
        ) {
          return;
        }
        if (document.querySelector('[data-esc-layer="open"]')) return;
        // 顶栏按钮 / 药丸工具条保留原生 Space 触发
        if (el.closest('header')) return;
        if (el.closest('[data-testid="canvas-pill-toolbar"]')) return;
        const insideSidebar = Boolean(el.closest('aside[aria-label="阅读状态与目录树"]'));
        const insideCanvasNode = Boolean(el.closest('[data-node-id]'));
        // 按钮除画布节点与左栏条目外不截断
        if (el.tagName === 'BUTTON' && !insideSidebar && !insideCanvasNode) return;
        // 知识资产库阅读态正文区内，Space 保留翻页滚动（左栏/概览除外）
        if (activeTab === 'library' && libraryMode === 'read' && !insideSidebar) {
          return;
        }
      } else if (activeTab === 'library' && libraryMode === 'read') {
        return;
      }

      if (activeTab === 'home') return;

      let candidateFileId = activeFile?.file_id ?? '';
      let candidateRevId = pinnedRevisionId || activeFile?.current_revision_id;
      if (activeTab === 'panorama' && panoramaMode === 'list' && selectedEventId) {
        const ev = events.find((item) => item.event_id === selectedEventId);
        if (ev?.file_id) {
          candidateFileId = ev.file_id;
          candidateRevId = ev.revision_id || undefined;
        }
      }

      if (!candidateFileId) return;
      e.preventDefault();
      e.stopPropagation();
      openQuickPreview(candidateFileId, candidateRevId);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    target,
    hasBlockingOverlay,
    activeTab,
    panoramaMode,
    libraryMode,
    activeFile,
    pinnedRevisionId,
    selectedEventId,
    events,
    openQuickPreview,
  ]);

  return {
    quickPreviewTarget: target,
    quickPreviewQueue: queue,
    openQuickPreview,
    closeQuickPreview,
    navigateQuickPreview,
  };
}
