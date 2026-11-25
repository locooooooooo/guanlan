import React from 'react';
import { FolderInput, Upload } from 'lucide-react';
import { basenameOf } from '../utils/documentIdentity';
import { displayFolderLabel } from '../utils/workspacePaths';

interface DragDropImportOverlayProps {
  active: boolean;
  paths: string[];
  targetDir: string;
  hoveredFolder: string | null;
}

/**
 * 外部文件拖入工作区时的实时视觉引导浮层。
 * pointer-events-none 保持底层目录树/文件夹卡可继续被 elementFromPoint 命中。
 */
export const DragDropImportOverlay: React.FC<DragDropImportOverlayProps> = ({
  active,
  paths,
  targetDir,
  hoveredFolder,
}) => {
  if (!active) return null;

  const effectiveTarget = hoveredFolder !== null ? hoveredFolder : targetDir;
  const previewNames = paths.slice(0, 3).map((p) => basenameOf(p) || p);
  const moreCount = Math.max(0, paths.length - previewNames.length);

  return (
    <div
      data-drag-import-overlay=""
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-[80] flex items-end justify-center p-6 bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,transparent)] backdrop-blur-[1px]"
    >
      <div className="pointer-events-none glass-pop rounded-[var(--r-card)] border-2 border-dashed border-[color:var(--accent-iris-deep)] px-5 py-3.5 shadow-2xl max-w-lg w-full flex items-center gap-3.5">
        <div className="w-10 h-10 rounded-xl bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] flex items-center justify-center shrink-0">
          {hoveredFolder !== null ? (
            <FolderInput className="w-5 h-5" />
          ) : (
            <Upload className="w-5 h-5" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)]">
            松开鼠标将 {paths.length > 0 ? `${paths.length} 份` : ''}外部文件导入工作区
          </div>
          <div className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] flex items-center gap-1.5 flex-wrap">
            <span>目标目录：</span>
            <span className="font-mono text-[color:var(--accent-iris-ink)] font-medium">
              {displayFolderLabel(effectiveTarget)}
            </span>
            {hoveredFolder === null && (
              <span className="text-[length:var(--text-micro)] text-[color:var(--ink-faint)]">
                （拖到左侧目录树文件夹上可精准投放）
              </span>
            )}
          </div>
          {previewNames.length > 0 && (
            <div className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] truncate">
              {previewNames.join(' · ')}
              {moreCount > 0 ? ` 等共 ${paths.length} 份` : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export interface SystemActionFeedbackToast {
  id: number;
  tone: 'ok' | 'warn' | 'error';
  message: string;
  revealPath?: string;
  openPath?: string;
}

interface SystemActionToastProps {
  toast: SystemActionFeedbackToast | null;
  onDismiss: () => void;
  onRevealInExplorer?: (relativePath: string) => void;
  onOpenWithDefaultApp?: (relativePath: string) => void;
}

export const SystemActionToastBanner: React.FC<SystemActionToastProps> = ({
  toast,
  onDismiss,
  onRevealInExplorer,
  onOpenWithDefaultApp,
}) => {
  if (!toast) return null;

  const toneBorder =
    toast.tone === 'error'
      ? 'border-[color:color-mix(in_srgb,var(--stage-ink-anomaly)_45%,transparent)]'
      : toast.tone === 'warn'
        ? 'border-[color:color-mix(in_srgb,var(--stage-ink-decision)_45%,transparent)]'
        : 'border-[color:color-mix(in_srgb,var(--stage-ink-deliver)_45%,transparent)]';

  return (
    <div
      role="status"
      data-system-action-toast=""
      className={`fixed bottom-4 left-4 z-[85] max-w-md glass-pop rounded-[var(--r-card)] border ${toneBorder} px-3.5 py-2.5 shadow-xl flex items-center gap-3 text-[length:var(--text-ui)] leading-[var(--lh-ui)]`}
    >
      <span className="min-w-0 flex-1 text-[color:var(--ink-strong)] break-all">
        {toast.message}
      </span>
      {toast.revealPath && onRevealInExplorer && (
        <button
          type="button"
          onClick={() => onRevealInExplorer(toast.revealPath!)}
          className="shrink-0 text-[length:var(--text-micro)] font-medium text-[color:var(--accent-iris-ink)] hover:underline cursor-pointer"
        >
          定位目录
        </button>
      )}
      {toast.openPath && onOpenWithDefaultApp && (
        <button
          type="button"
          onClick={() => onOpenWithDefaultApp(toast.openPath!)}
          className="shrink-0 text-[length:var(--text-micro)] font-medium text-[color:var(--accent-iris-ink)] hover:underline cursor-pointer"
        >
          打开
        </button>
      )}
      <button
        type="button"
        aria-label="关闭提示"
        onClick={onDismiss}
        className="shrink-0 text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer"
      >
        关闭
      </button>
    </div>
  );
};
