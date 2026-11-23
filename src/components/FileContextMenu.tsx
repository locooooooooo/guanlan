import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  CheckCheck,
  ClipboardCopy,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FilePlus2,
  FolderInput,
  FolderPlus,
  FolderSearch,
  History,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button } from './ui/primitives';

export interface FileOpActionTarget {
  fileId: string;
  relativePath: string;
  title: string;
}

export type FileContextMenuTarget =
  | {
      kind: 'file';
      relativePath: string;
      title: string;
      fileId?: string;
      revisionId?: string;
    }
  | {
      kind: 'folder';
      relativePath: string;
      title: string;
    };

export interface FileContextMenuState {
  x: number;
  y: number;
  target: FileContextMenuTarget;
}

export interface DesktopFileActionCallbacks {
  onRevealInExplorer?: (relativePath: string) => void;
  onOpenWithDefaultApp?: (relativePath: string) => void;
  onCopyRelativePath?: (relativePath: string) => void;
  onCopyAbsolutePath?: (relativePath: string) => void;
  onImportIntoFolder?: (folderRelativePath: string) => void;
  onOpenFileContextMenu?: (e: React.MouseEvent, target: FileContextMenuTarget) => void;
  onRenameFile?: (target: FileOpActionTarget) => void;
  onMoveFile?: (target: FileOpActionTarget) => void;
  onTrashFile?: (target: FileOpActionTarget) => void;
  desktopSystemSupported?: boolean;
  hasWorkspaceRoot?: boolean;
}

interface FileContextMenuProps {
  menu: FileContextMenuState | null;
  onClose: () => void;
  desktopSupported: boolean;
  hasRootPath: boolean;
  onRevealInExplorer: (relativePath: string) => void;
  onOpenWithDefaultApp: (relativePath: string) => void;
  onCopyRelativePath: (relativePath: string) => void;
  onCopyAbsolutePath: (relativePath: string) => void;
  onImportIntoFolder?: (folderRelativePath: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  onOpenRead?: (fileId: string, revisionId?: string) => void;
  onOpenTimeline?: (fileId: string) => void;
  onRenameFile?: (target: FileOpActionTarget) => void;
  onMoveFile?: (target: FileOpActionTarget) => void;
  onTrashFile?: (target: FileOpActionTarget) => void;
  /** Quiet.md 目录操控：文件置顶 / 文件夹增删改移 */
  isPinnedFile?: (fileId: string) => boolean;
  onTogglePinFile?: (fileId: string) => void;
  onCreateDocumentInFolder?: (folderRelativePath: string) => void;
  onCreateSubfolder?: (folderRelativePath: string) => void;
  onRenameFolder?: (folderRelativePath: string) => void;
  onMoveFolder?: (folderRelativePath: string) => void;
  onTrashFolder?: (folderRelativePath: string) => void;
  /** 单文件已读态判定与标已读/标未读切换（GL-01 同源口径） */
  isFileUnread?: (fileId: string) => boolean;
  onMarkFileRead?: (fileId: string, revisionId?: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  /** V04：本目录全部标为已读（推进该目录下活跃文件的已读基线，8 秒可撤销） */
  onMarkFolderRead?: (folderRelativePath: string) => void;
  /** 本目录全部标为未读（清除该目录下活跃文件的已读基线，8 秒可撤销） */
  onMarkFolderUnread?: (folderRelativePath: string) => void;
  /** V06：工作区私有目录静默治理（时间轴/星图隐藏噪点，磁盘零写入，随时恢复） */
  isFolderMuted?: (folderRelativePath: string) => boolean;
  onToggleMuteFolder?: (folderRelativePath: string) => void;
}

const MENU_ITEM_CLS =
  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--r-ctl)] text-left text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-strong)] hover:bg-[color:var(--btn-ghost-bg-hover)] disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer transition-colors';

export const FileContextMenu: React.FC<FileContextMenuProps> = ({
  menu,
  onClose,
  desktopSupported,
  hasRootPath,
  onRevealInExplorer,
  onOpenWithDefaultApp,
  onCopyRelativePath,
  onCopyAbsolutePath,
  onImportIntoFolder,
  onQuickPreview,
  onOpenRead,
  onOpenTimeline,
  onRenameFile,
  onMoveFile,
  onTrashFile,
  isPinnedFile,
  onTogglePinFile,
  onCreateDocumentInFolder,
  onCreateSubfolder,
  onRenameFolder,
  onMoveFolder,
  onTrashFolder,
  isFileUnread,
  onMarkFileRead,
  onMarkFileUnread,
  onMarkFolderRead,
  onMarkFolderUnread,
  isFolderMuted,
  onToggleMuteFolder,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number }>({
    left: menu?.x ?? 0,
    top: menu?.y ?? 0,
  });

  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const width = el?.offsetWidth || 236;
    const height = el?.offsetHeight || 220;
    const left = Math.max(8, Math.min(menu.x, vw - width - 8));
    const top = Math.max(8, Math.min(menu.y, vh - height - 8));
    setCoords({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const { target } = menu;
  const runAndClose = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`操作菜单：${target.title}`}
      data-file-context-menu=""
      data-esc-layer="open"
      style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
      className="glass-pop fixed z-[90] min-w-[228px] max-w-[280px] rounded-[var(--r-card)] p-1.5 shadow-2xl space-y-0.5 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="px-2.5 py-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] truncate border-b border-[color:var(--glass-hairline)] mb-1"
        title={target.relativePath || '工作区根目录'}
      >
        {target.title}
      </div>

      {target.kind === 'file' && target.fileId && onQuickPreview && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="quick-preview"
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onQuickPreview(target.fileId!, target.revisionId))}
        >
          <Eye className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
          <span className="flex-1">轻预览</span>
          <kbd className="font-mono text-[10px] text-[color:var(--ink-soft)] opacity-75">Space</kbd>
        </button>
      )}

      {target.kind === 'file' && target.fileId && onOpenRead && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="open-read"
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onOpenRead(target.fileId!, target.revisionId))}
        >
          <BookOpen className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
          <span>打开阅读</span>
        </button>
      )}

      {target.kind === 'file' && target.fileId && onOpenTimeline && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="open-timeline"
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onOpenTimeline(target.fileId!))}
        >
          <History className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
          <span>文件时间线</span>
        </button>
      )}

      {target.kind === 'file' && (target.fileId && (onQuickPreview || onOpenRead || onOpenTimeline)) && (
        <div className="my-1 border-t border-[color:var(--glass-hairline)]" />
      )}

      <button
        type="button"
        role="menuitem"
        data-menu-action="reveal-explorer"
        disabled={!desktopSupported}
        title={
          desktopSupported
            ? '在系统资源管理器中显示并选中目标'
            : '仅观澜桌面客户端支持调用本地资源管理器'
        }
        className={MENU_ITEM_CLS}
        onClick={() => runAndClose(() => onRevealInExplorer(target.relativePath))}
      >
        <FolderSearch className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
        <span>在资源管理器中显示</span>
      </button>

      {target.kind === 'file' && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="open-default-app"
          disabled={!desktopSupported}
          title={
            desktopSupported
              ? '使用系统默认关联程序打开此文件'
              : '仅观澜桌面客户端支持调用系统默认程序'
          }
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onOpenWithDefaultApp(target.relativePath))}
        >
          <ExternalLink className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
          <span>用系统默认应用打开</span>
        </button>
      )}

      {target.kind === 'file' && target.fileId && (onMarkFileRead || onMarkFileUnread) && (() => {
        const unread = isFileUnread ? isFileUnread(target.fileId!) : true;
        if (unread && onMarkFileRead) {
          return (
            <button
              type="button"
              role="menuitem"
              data-menu-action="mark-file-read"
              title="将此文档当前版本标为已读"
              className={MENU_ITEM_CLS}
              onClick={() => runAndClose(() => onMarkFileRead(target.fileId!, target.revisionId))}
            >
              <Check className="w-3.5 h-3.5 text-[color:var(--status-green)] shrink-0" />
              <span>标为已读</span>
            </button>
          );
        }
        if (!unread && onMarkFileUnread) {
          return (
            <button
              type="button"
              role="menuitem"
              data-menu-action="mark-file-unread"
              title="清除此文档的已读基线（保留收藏与批注）"
              className={MENU_ITEM_CLS}
              onClick={() => runAndClose(() => onMarkFileUnread(target.fileId!))}
            >
              <RotateCcw className="w-3.5 h-3.5 text-[color:var(--accent-wave)] shrink-0" />
              <span>标为未读</span>
            </button>
          );
        }
        return null;
      })()}

      {target.kind === 'folder' && onMarkFolderRead && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="mark-folder-read"
          title="将本目录（含子目录）内全部活跃文档推进为已读基线，8 秒内可撤销"
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onMarkFolderRead(target.relativePath))}
        >
          <CheckCheck className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
          <span>本目录全部标为已读</span>
        </button>
      )}

      {target.kind === 'folder' && onMarkFolderUnread && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="mark-folder-unread"
          title="清除本目录（含子目录）内全部活跃文档的已读基线（保留收藏与批注），8 秒内可撤销"
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onMarkFolderUnread(target.relativePath))}
        >
          <RotateCcw className="w-3.5 h-3.5 text-[color:var(--accent-wave)] shrink-0" />
          <span>本目录全部标为未读</span>
        </button>
      )}

      {target.kind === 'folder' && target.relativePath !== '' && onToggleMuteFolder && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="toggle-mute-folder"
          title={
            isFolderMuted?.(target.relativePath)
              ? '恢复该目录在星图、日历与列表时间线中的显示'
              : '在时间轴、日历与星图中隐藏该目录噪点（磁盘零写入，左栏与 Ctrl+K 仍可随时阅读）'
          }
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onToggleMuteFolder(target.relativePath))}
        >
          {isFolderMuted?.(target.relativePath) ? (
            <>
              <Eye className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
              <span>取消静默此目录</span>
            </>
          ) : (
            <>
              <EyeOff className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
              <span>在时间轴与星图静默此目录</span>
            </>
          )}
        </button>
      )}

      {target.kind === 'folder' && (onCreateDocumentInFolder || onCreateSubfolder) && (
        <>
          {onCreateDocumentInFolder && (
            <button
              type="button"
              role="menuitem"
              data-menu-action="create-doc-in-folder"
              className={MENU_ITEM_CLS}
              onClick={() => runAndClose(() => onCreateDocumentInFolder(target.relativePath))}
            >
              <FilePlus2 className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
              <span>新建文档…</span>
            </button>
          )}
          {onCreateSubfolder && (
            <button
              type="button"
              role="menuitem"
              data-menu-action="create-subfolder"
              className={MENU_ITEM_CLS}
              onClick={() => runAndClose(() => onCreateSubfolder(target.relativePath))}
            >
              <FolderPlus className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
              <span>新建子文件夹…</span>
            </button>
          )}
          <div className="my-1 border-t border-[color:var(--glass-hairline)]" />
        </>
      )}

      {target.kind === 'folder' && onImportIntoFolder && (
        <button
          type="button"
          role="menuitem"
          data-menu-action="import-into-folder"
          disabled={!desktopSupported}
          title={
            desktopSupported
              ? '选择外部文件并拷贝到此工作区目录'
              : '仅观澜桌面客户端支持导入外部文件'
          }
          className={MENU_ITEM_CLS}
          onClick={() => runAndClose(() => onImportIntoFolder(target.relativePath))}
        >
          <FolderInput className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
          <span>导入文件到此目录…</span>
        </button>
      )}

      {target.kind === 'folder' &&
        target.relativePath !== '' &&
        (onRenameFolder || onMoveFolder || onTrashFolder) && (
          <>
            <div className="my-1 border-t border-[color:var(--glass-hairline)]" />
            {onRenameFolder && (
              <button
                type="button"
                role="menuitem"
                data-menu-action="rename-folder"
                title="原子重命名文件夹（子树内所有文件 file_id 保持连续）"
                className={MENU_ITEM_CLS}
                onClick={() => runAndClose(() => onRenameFolder(target.relativePath))}
              >
                <Pencil className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
                <span>重命名文件夹…</span>
              </button>
            )}
            {onMoveFolder && (
              <button
                type="button"
                role="menuitem"
                data-menu-action="move-folder"
                title="移动文件夹到其他目录（自动防成环，子树文件 file_id 保持连续）"
                className={MENU_ITEM_CLS}
                onClick={() => runAndClose(() => onMoveFolder(target.relativePath))}
              >
                <FolderInput className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
                <span>移动文件夹到…</span>
              </button>
            )}
            {onTrashFolder && (
              <button
                type="button"
                role="menuitem"
                data-menu-action="trash-folder"
                title="仅移入操作系统回收站（非永久删除）"
                className={`${MENU_ITEM_CLS} text-[color:var(--btn-danger-ink)]`}
                onClick={() => runAndClose(() => onTrashFolder(target.relativePath))}
              >
                <Trash2 className="w-3.5 h-3.5 text-[color:var(--btn-danger-ink)] shrink-0" />
                <span>移入回收站…</span>
              </button>
            )}
          </>
        )}

      {target.kind === 'file' && target.fileId && onTogglePinFile && (
        <>
          <div className="my-1 border-t border-[color:var(--glass-hairline)]" />
          <button
            type="button"
            role="menuitem"
            data-menu-action="toggle-pin-file"
            className={MENU_ITEM_CLS}
            onClick={() => runAndClose(() => onTogglePinFile(target.fileId!))}
          >
            {isPinnedFile?.(target.fileId) ? (
              <>
                <PinOff className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
                <span>从「置顶」移除</span>
              </>
            ) : (
              <>
                <Pin className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" />
                <span>添加到「置顶」</span>
              </>
            )}
          </button>
        </>
      )}

      {target.kind === 'file' &&
        target.fileId &&
        (onRenameFile || onMoveFile || onTrashFile) && (
          <>
            <div className="my-1 border-t border-[color:var(--glass-hairline)]" />
            {onRenameFile && (
              <button
                type="button"
                role="menuitem"
                data-menu-action="rename-file"
                title="同目录原子重命名（保持 file_id、历史版本与决定关联 100% 连续）"
                className={MENU_ITEM_CLS}
                onClick={() =>
                  runAndClose(() =>
                    onRenameFile({
                      fileId: target.fileId!,
                      relativePath: target.relativePath,
                      title: target.title,
                    })
                  )
                }
              >
                <Pencil className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
                <span>重命名…</span>
              </button>
            )}
            {onMoveFile && (
              <button
                type="button"
                role="menuitem"
                data-menu-action="move-file"
                title="工作区内安全跨目录移动（自动登记路径别名，绝不断链）"
                className={MENU_ITEM_CLS}
                onClick={() =>
                  runAndClose(() =>
                    onMoveFile({
                      fileId: target.fileId!,
                      relativePath: target.relativePath,
                      title: target.title,
                    })
                  )
                }
              >
                <FolderInput className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
                <span>移动到目录…</span>
              </button>
            )}
            {onTrashFile && (
              <button
                type="button"
                role="menuitem"
                data-menu-action="trash-file"
                title="仅移入操作系统回收站（非永久删除，还原后自动重连原 file_id）"
                className={`${MENU_ITEM_CLS} text-[color:var(--btn-danger-ink)]`}
                onClick={() =>
                  runAndClose(() =>
                    onTrashFile({
                      fileId: target.fileId!,
                      relativePath: target.relativePath,
                      title: target.title,
                    })
                  )
                }
              >
                <Trash2 className="w-3.5 h-3.5 text-[color:var(--btn-danger-ink)] shrink-0" />
                <span>移入回收站…</span>
              </button>
            )}
          </>
        )}

      <div className="my-1 border-t border-[color:var(--glass-hairline)]" />

      <button
        type="button"
        role="menuitem"
        data-menu-action="copy-rel-path"
        className={MENU_ITEM_CLS}
        onClick={() => runAndClose(() => onCopyRelativePath(target.relativePath))}
      >
        <Copy className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
        <span>复制相对路径</span>
      </button>

      <button
        type="button"
        role="menuitem"
        data-menu-action="copy-abs-path"
        disabled={!hasRootPath && !desktopSupported}
        title={
          hasRootPath || desktopSupported
            ? '复制工作区内的完整本机路径'
            : '当前未解析工作区绝对根路径'
        }
        className={MENU_ITEM_CLS}
        onClick={() => runAndClose(() => onCopyAbsolutePath(target.relativePath))}
      >
        <ClipboardCopy className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
        <span>复制绝对路径</span>
      </button>
    </div>
  );
};

interface FileSystemActionBarProps {
  relativePath: string;
  fileId?: string;
  title?: string;
  desktopSupported: boolean;
  hasRootPath: boolean;
  onRevealInExplorer: (relativePath: string) => void;
  onOpenWithDefaultApp: (relativePath: string) => void;
  onCopyRelativePath: (relativePath: string) => void;
  onCopyAbsolutePath: (relativePath: string) => void;
  onRenameFile?: (target: FileOpActionTarget) => void;
  onMoveFile?: (target: FileOpActionTarget) => void;
  onTrashFile?: (target: FileOpActionTarget) => void;
  compact?: boolean;
}

/**
 * 复用系统操作工具条（ReaderView 顶栏 / RightInspector 详情区共用同一套文案与禁用态）。
 */
export const FileSystemActionBar: React.FC<FileSystemActionBarProps> = ({
  relativePath,
  fileId,
  title,
  desktopSupported,
  hasRootPath,
  onRevealInExplorer,
  onOpenWithDefaultApp,
  onCopyRelativePath,
  onCopyAbsolutePath,
  onRenameFile,
  onMoveFile,
  onTrashFile,
  compact = false,
}) => {
  const [copiedKind, setCopiedKind] = useState<'rel' | 'abs' | null>(null);
  const opTarget: FileOpActionTarget | null = fileId
    ? { fileId, relativePath, title: title || relativePath }
    : null;

  const triggerCopy = (kind: 'rel' | 'abs') => {
    if (kind === 'rel') onCopyRelativePath(relativePath);
    else onCopyAbsolutePath(relativePath);
    setCopiedKind(kind);
    window.setTimeout(() => setCopiedKind((prev) => (prev === kind ? null : prev)), 1500);
  };

  const compactTileClass =
    'justify-start !h-7 px-2 text-[11.5px] bg-[color:var(--depth-1-bg)] hover:bg-white hover:shadow-[0_1px_4px_rgba(38,36,61,0.08)] border border-transparent hover:border-[color:var(--glass-hairline)]';

  return (
    <div
      className={
        compact
          ? 'grid grid-cols-2 gap-1.5'
          : 'flex flex-wrap items-center gap-1 text-xs'
      }
      data-file-system-actions=""
    >
      <Button
        variant="ghost"
        size="sm"
        data-action="reveal-explorer"
        disabled={!desktopSupported}
        className={compact ? compactTileClass : undefined}
        onClick={() => onRevealInExplorer(relativePath)}
        title={
          desktopSupported
            ? '在资源管理器中显示并选中此文件'
            : '仅观澜桌面客户端支持资源管理器定位'
        }
      >
        <FolderSearch className="w-3.5 h-3.5" />
        <span className="truncate">{compact ? '定位目录' : '在资源管理器中显示'}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-action="open-default-app"
        disabled={!desktopSupported}
        className={compact ? compactTileClass : undefined}
        onClick={() => onOpenWithDefaultApp(relativePath)}
        title={
          desktopSupported
            ? '用系统默认应用打开此文件'
            : '仅观澜桌面客户端支持系统默认应用打开'
        }
      >
        <ExternalLink className="w-3.5 h-3.5" />
        <span className="truncate">{compact ? '默认打开' : '默认应用打开'}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-action="copy-rel-path"
        className={compact ? compactTileClass : undefined}
        onClick={() => triggerCopy('rel')}
        title={`复制相对路径：${relativePath}`}
      >
        {copiedKind === 'rel' ? (
          <Check className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)]" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
        <span className="truncate">
          {copiedKind === 'rel' ? '已复制相对' : compact ? '相对路径' : '复制相对路径'}
        </span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-action="copy-abs-path"
        disabled={!hasRootPath && !desktopSupported}
        className={compact ? compactTileClass : undefined}
        onClick={() => triggerCopy('abs')}
        title="复制本机完整绝对路径"
      >
        {copiedKind === 'abs' ? (
          <Check className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)]" />
        ) : (
          <ClipboardCopy className="w-3.5 h-3.5" />
        )}
        <span className="truncate">
          {copiedKind === 'abs' ? '已复制绝对' : compact ? '绝对路径' : '复制绝对路径'}
        </span>
      </Button>
      {opTarget && onRenameFile && (
        <Button
          variant="ghost"
          size="sm"
          data-action="rename-file"
          className={compact ? compactTileClass : undefined}
          onClick={() => onRenameFile(opTarget)}
          title="同目录原子重命名（保持 file_id、历史版本与决定关联连续）"
        >
          <Pencil className="w-3.5 h-3.5" />
          <span className="truncate">重命名</span>
        </Button>
      )}
      {opTarget && onMoveFile && (
        <Button
          variant="ghost"
          size="sm"
          data-action="move-file"
          className={compact ? compactTileClass : undefined}
          onClick={() => onMoveFile(opTarget)}
          title="安全移动到工作区其他目录（自动登记路径别名）"
        >
          <FolderInput className="w-3.5 h-3.5" />
          <span className="truncate">移动</span>
        </Button>
      )}
      {opTarget && onTrashFile && (
        <Button
          variant="ghost"
          size="sm"
          data-action="trash-file"
          className={`text-[color:var(--btn-danger-ink)] enabled:hover:text-[color:var(--btn-danger-ink)] enabled:hover:bg-[color:var(--btn-danger-bg-hover)] ${
            compact
              ? 'col-span-2 justify-center !h-7 px-2 text-[11.5px] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_5%,transparent)] border border-[color:color-mix(in_srgb,var(--stage-ink-exec)_14%,transparent)]'
              : ''
          }`}
          onClick={() => onTrashFile(opTarget)}
          title="移入操作系统回收站（非永久删除，可随时还原重连）"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>移入回收站</span>
        </Button>
      )}
    </div>
  );
};
