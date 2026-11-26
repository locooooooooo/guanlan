import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isFolderMoveBlocked } from '../utils/sidebarTree';


/** 悬停多少毫秒后自动展开折叠目录。 */
export const AUTO_EXPAND_DELAY_MS = 450;
/** 距滚动区上/下边缘多少像素内触发自动滚屏。 */
export const AUTO_SCROLL_EDGE_PX = 24;
const AUTO_SCROLL_STEP_PX = 9;
/** 落地微反馈高亮持续（ms）。 */
export const DROP_FLASH_MS = 900;

/** HTML5 拖拽 MIME（自体校验用；拒绝外部来源拖入）。 */
export const SIDEBAR_DRAG_MIME = 'application/x-guanlan-file-move';
/** 文件夹行拖拽 MIME。 */
export const SIDEBAR_FOLDER_DRAG_MIME = 'application/x-guanlan-folder-move';

export interface SidebarTreeDragOptions {
  onAutoExpand: (folderPath: string) => void;
  scrollContainerRef: RefObject<HTMLElement | null>;
  onDropMove: (fileId: string, targetDir: string) => void;
  onDropMoveFolder?: (folderPath: string, targetParentDir: string) => void;
  enabled?: boolean;
}

export interface SidebarTreeDragState {
  draggingFileId: string | null;
  draggingFolderPath: string | null;
  isDragging: boolean;
  draggingFromDir: string | null;
  dropTargetDir: string | null;
  dropFlashDir: string | null;
}

/**
 * 目标目录是否为「被拖文件当前所在目录」（文件级防成环：同目录落点＝无变化，
 * 服务端移动接口会报「目标路径与当前文件位置相同」——前端先行 100% 拦截）。
 * 目录段比较一律大小写无关（Windows 工作区口径，与服务端冲突校验
 * eq_ignore_ascii_case 同语义；中文/非 ASCII 段不受影响）。
 */
export function isMoveBlockedBySelfDrag(fromDir: string | null, targetDir: string): boolean {
  if (fromDir === null) return false;
  const normalize = (value: string) =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(fromDir) === normalize(targetDir);
}

export interface SidebarTreeDragApi extends SidebarTreeDragState {
  beginDrag: (event: React.DragEvent, file: { file_id: string; folder: string }) => void;
  beginFolderDrag: (event: React.DragEvent, folderPath: string) => void;
  handleFolderDragOver: (event: React.DragEvent, folderPath: string) => void;
  handleFolderDragLeave: (event: React.DragEvent, folderPath: string) => void;
  handleFolderDrop: (event: React.DragEvent, folderPath: string) => void;
  endDrag: () => void;
  isDropTarget: (folderPath: string) => boolean;
  isDropBlocked: (folderPath: string) => boolean;
  isDropFlash: (folderPath: string) => boolean;
}

export function useSidebarTreeDrag(options: SidebarTreeDragOptions): SidebarTreeDragApi {
  const { onAutoExpand, scrollContainerRef, onDropMove, onDropMoveFolder, enabled = true } = options;
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null);
  const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(null);
  const [draggingFromDir, setDraggingFromDir] = useState<string | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const [dropFlashDir, setDropFlashDir] = useState<string | null>(null);

  const isDragging = draggingFileId !== null || draggingFolderPath !== null;

  const hoverTimerRef = useRef<number | null>(null);
  const hoverPathRef = useRef<string | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverPathRef.current = null;
  }, []);

  const stopScrollLoop = useCallback(() => {
    lastPointerRef.current = null;
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isDragging) {
      stopScrollLoop();
      return;
    }
    const tick = () => {
      const container = scrollContainerRef.current;
      const pointer = lastPointerRef.current;
      if (container && pointer) {
        const rect = container.getBoundingClientRect();
        if (pointer.y - rect.top <= AUTO_SCROLL_EDGE_PX) {
          container.scrollTop -= AUTO_SCROLL_STEP_PX;
        } else if (rect.bottom - pointer.y <= AUTO_SCROLL_EDGE_PX) {
          container.scrollTop += AUTO_SCROLL_STEP_PX;
        }
      }
      scrollRafRef.current = requestAnimationFrame(tick);
    };
    scrollRafRef.current = requestAnimationFrame(tick);
    return () => {
      stopScrollLoop();
    };
  }, [isDragging, scrollContainerRef, stopScrollLoop]);

  useEffect(() => {
    return () => {
      clearHoverTimer();
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, [clearHoverTimer]);

  const endDragInternal = useCallback(() => {
    clearHoverTimer();
    stopScrollLoop();
    setDraggingFileId(null);
    setDraggingFolderPath(null);
    setDraggingFromDir(null);
    setDropTargetDir(null);
  }, [clearHoverTimer, stopScrollLoop]);

  const isTargetBlocked = useCallback(
    (targetDir: string) => {
      if (draggingFileId !== null) {
        return isMoveBlockedBySelfDrag(draggingFromDir, targetDir);
      }
      if (draggingFolderPath !== null) {
        return isFolderMoveBlocked(draggingFolderPath, targetDir);
      }
      return false;
    },
    [draggingFileId, draggingFolderPath, draggingFromDir]
  );

  const beginDrag = useCallback(
    (event: React.DragEvent, file: { file_id: string; folder: string }) => {
      if (!enabled) return;
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(SIDEBAR_DRAG_MIME, file.file_id);
      } catch {
      }
      setDraggingFolderPath(null);
      setDraggingFileId(file.file_id);
      const fromDir = file.folder === '.' ? '' : file.folder;
      setDraggingFromDir(fromDir);
    },
    [enabled]
  );

  const beginFolderDrag = useCallback(
    (event: React.DragEvent, folderPath: string) => {
      if (!enabled || !onDropMoveFolder || !folderPath) return;
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(SIDEBAR_FOLDER_DRAG_MIME, folderPath);
      } catch {
      }
      setDraggingFileId(null);
      setDraggingFromDir(null);
      setDraggingFolderPath(folderPath);
    },
    [enabled, onDropMoveFolder]
  );

  const handleFolderDragOver = useCallback(
    (event: React.DragEvent, folderPath: string) => {
      if (!isDragging) return;
      if (isTargetBlocked(folderPath)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      setDropTargetDir(folderPath);
      if (folderPath && hoverPathRef.current !== folderPath) {
        clearHoverTimer();
        hoverPathRef.current = folderPath;
        hoverTimerRef.current = window.setTimeout(() => {
          onAutoExpand(folderPath);
          clearHoverTimer();
        }, AUTO_EXPAND_DELAY_MS);
      }
    },
    [clearHoverTimer, isDragging, isTargetBlocked, onAutoExpand]
  );

  const handleFolderDragLeave = useCallback(
    (_event: React.DragEvent, folderPath: string) => {
      if (!isDragging) return;
      if (dropTargetDir === folderPath) setDropTargetDir(null);
      if (hoverPathRef.current === folderPath) clearHoverTimer();
      lastPointerRef.current = null;
    },
    [clearHoverTimer, dropTargetDir, isDragging]
  );

  const handleFolderDrop = useCallback(
    (event: React.DragEvent, folderPath: string) => {
      if (!isDragging) return;
      event.preventDefault();
      event.stopPropagation();
      const fileId = draggingFileId;
      const fromDir = draggingFromDir;
      const srcFolder = draggingFolderPath;
      endDragInternal();

      if (fileId !== null) {
        if (isMoveBlockedBySelfDrag(fromDir, folderPath)) return;
        onDropMove(fileId, folderPath);
      } else if (srcFolder !== null && onDropMoveFolder) {
        if (isFolderMoveBlocked(srcFolder, folderPath)) return;
        onDropMoveFolder(srcFolder, folderPath);
      } else {
        return;
      }

      setDropFlashDir(folderPath);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => {
        setDropFlashDir(null);
        flashTimerRef.current = null;
      }, DROP_FLASH_MS);
    },
    [
      draggingFileId,
      draggingFolderPath,
      draggingFromDir,
      endDragInternal,
      isDragging,
      onDropMove,
      onDropMoveFolder,
    ]
  );

  const endDrag = useCallback(() => {
    endDragInternal();
  }, [endDragInternal]);

  const isDropTarget = useCallback(
    (folderPath: string) =>
      isDragging && dropTargetDir === folderPath && !isTargetBlocked(folderPath),
    [dropTargetDir, isDragging, isTargetBlocked]
  );

  const isDropBlocked = useCallback(
    (folderPath: string) => isTargetBlocked(folderPath),
    [isTargetBlocked]
  );

  const isDropFlash = useCallback(
    (folderPath: string) => dropFlashDir === folderPath,
    [dropFlashDir]
  );

  return {
    draggingFileId,
    draggingFolderPath,
    isDragging,
    draggingFromDir,
    dropTargetDir,
    dropFlashDir,
    beginDrag,
    beginFolderDrag,
    handleFolderDragOver,
    handleFolderDragLeave,
    handleFolderDrop,
    endDrag,
    isDropTarget,
    isDropBlocked,
    isDropFlash,
  };
}
