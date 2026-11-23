import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isFolderMoveBlocked } from '../utils/sidebarTree';

/**
 * C04 · 左栏目录树内拖拽整理 Hook（§5 C04 ①；quiet-md sidebar_drag/sidebar_drop
 * 手感移植；围栏内独立 Hook，§4.2 防膨胀）。
 *
 * 职责边界：本 Hook 只承载**拖拽 UI 状态机**（谁在拖、悬停谁、自动展开计时、
 * 边缘自动滚屏、落地微反馈）与**防成环拦截**；真正的跨目录移动 IO 由宿主
 * （LeftSidebar → App 接线）在 onDropMove 回调里直连 A05 `/move` 完成——
 * file_id / 版本链 / 阅读进度 100% 不断链由 A05 身份保真语义保证。
 *
 * 交互契约（量化验收口径）：
 * - 「拖入目标文件夹」：目标行高亮 + 悬停折叠目录 450ms 自动展开 + 释放落地微反馈；
 * - 「行间落点」仅目录行是合法目标（文件行不吸掷）；拖向自身当前所在目录
 *   （无变化落点）100% 拦截，不高亮、不吸掷、drop 拒绝；
 * - 指针靠近滚动区上/下 24px 边缘时按帧自动滚屏（drag 全程 rAF 常驻，dragend 收敛）。
 */

/** 悬停多少毫秒后自动展开折叠目录。 */
export const AUTO_EXPAND_DELAY_MS = 450;
/** 距滚动区上/下边缘多少像素内触发自动滚屏。 */
export const AUTO_SCROLL_EDGE_PX = 24;
/** 自动滚屏每帧步长（px）。 */
const AUTO_SCROLL_STEP_PX = 9;
/** 落地微反馈高亮持续（ms）。 */
export const DROP_FLASH_MS = 900;

/** HTML5 拖拽 MIME（自体校验用；拒绝外部来源拖入）。 */
export const SIDEBAR_DRAG_MIME = 'application/x-guanlan-file-move';
/** 文件夹行拖拽 MIME。 */
export const SIDEBAR_FOLDER_DRAG_MIME = 'application/x-guanlan-folder-move';

export interface SidebarTreeDragOptions {
  /** 悬停 450ms 后展开折叠目录（宿主接入 expandedFolders）。 */
  onAutoExpand: (folderPath: string) => void;
  /** 滚动容器（树滚动区）；用于边缘自动滚屏。 */
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** 释放落点（文件）：直连 A05 /move（宿主接线；有引用时宿主转确认弹窗）。 */
  onDropMove: (fileId: string, targetDir: string) => void;
  /** 释放落点（文件夹）：直连 /api/v1/folders/move（防成环拦截后回调）。 */
  onDropMoveFolder?: (folderPath: string, targetParentDir: string) => void;
  /** 拖拽是否启用（未接线移动能力时整组拖拽关闭）。 */
  enabled?: boolean;
}

export interface SidebarTreeDragState {
  /** 正在拖拽的 file_id（null＝非文件拖拽中）。 */
  draggingFileId: string | null;
  /** 正在拖拽的文件夹路径（null＝非文件夹拖拽中）。 */
  draggingFolderPath: string | null;
  /** 是否正处于任一树内拖拽中。 */
  isDragging: boolean;
  /** 被拖文件当前所在目录（防成环判定基准；''＝根）。 */
  draggingFromDir: string | null;
  /** 当前合法悬停目标目录（''＝根；null＝不在合法目标上）。 */
  dropTargetDir: string | null;
  /** 刚落地成功的目录（微反馈窗口内；宿主渲染闪烁高亮）。 */
  dropFlashDir: string | null;
}

/**
 * 目标目录是否为「被拖文件当前所在目录」（文件级防成环：同目录落点＝无变化，
 * A05 会报「目标路径与当前文件位置相同」——前端先行 100% 拦截）。
 * 目录段比较一律大小写无关（Windows 工作区口径，与 A05 collide 校验
 * eq_ignore_ascii_case 同语义；中文/非 ASCII 段不受影响）。
 */
export function isMoveBlockedBySelfDrag(fromDir: string | null, targetDir: string): boolean {
  if (fromDir === null) return false;
  const normalize = (value: string) =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(fromDir) === normalize(targetDir);
}

export interface SidebarTreeDragApi extends SidebarTreeDragState {
  /** 文件行 dragstart（宿主置 draggable）。 */
  beginDrag: (event: React.DragEvent, file: { file_id: string; folder: string }) => void;
  /** 文件夹行 dragstart（宿主置 draggable）。 */
  beginFolderDrag: (event: React.DragEvent, folderPath: string) => void;
  /** 目录行 dragover：高亮 + 450ms 自动展开计时 + 边缘滚屏坐标更新。 */
  handleFolderDragOver: (event: React.DragEvent, folderPath: string) => void;
  /** 目录行 dragleave：清高亮与自动展开计时。 */
  handleFolderDragLeave: (event: React.DragEvent, folderPath: string) => void;
  /** 目录行 drop：防成环拦截后回调 onDropMove / onDropMoveFolder；成功记微反馈。 */
  handleFolderDrop: (event: React.DragEvent, folderPath: string) => void;
  /** dragend：全部收敛（计数器、rAF、状态）。 */
  endDrag: () => void;
  /** 目录行是否为当前合法落点（宿主染目标高亮）。 */
  isDropTarget: (folderPath: string) => boolean;
  /** 目录行是否被防成环拦截（宿主可用 title 提示）。 */
  isDropBlocked: (folderPath: string) => boolean;
  /** 目录行是否处于落地微反馈窗口（宿主染闪烁）。 */
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

  // 拖拽全程 rAF 循环：靠近容器上/下 24px 边缘按帧滚屏（quiet-md 手感）
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
      // 拒绝文本/链接默认拖拽语义；自体 MIME 校验（drop 端只认本 MIME）
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(SIDEBAR_DRAG_MIME, file.file_id);
      } catch {
        /* 某些 WebView 对自定义 MIME 受限时退化为仅内部状态判定 */
      }
      setDraggingFolderPath(null);
      setDraggingFileId(file.file_id);
      // FileRecord.folder 与 LeftSidebar FolderNode.path 同一口径（'.' → '' 根）
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
        /* WebView 受限时退化为内部状态判定 */
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
      event.preventDefault(); // 允许 drop
      event.dataTransfer.dropEffect = 'move';
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      setDropTargetDir(folderPath);
      // 悬停同一折叠目录累计 450ms 自动展开（根目录 '' 无需展开）
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

      // 落地微反馈：目标行短促高亮
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
