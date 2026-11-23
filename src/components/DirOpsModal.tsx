/**
 * Quiet.md 风格文件夹与批量文件操作弹窗（独立组件，零裸色值）：
 * - folder-move：可搜索目标目录选择器（自动隐藏自身、当前父目录与全部后代目录防成环）；
 * - folder-trash：强制勾选二次确认，移入系统回收站（绝不永久删除）；
 * - batch-move：可搜索目标目录选择器，一次批量移动多份文件（保持 file_id 连续）；
 * - batch-trash：强制勾选二次确认，批量移入系统回收站。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Folder,
  FolderInput,
  Loader2,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Button, IconButton } from './ui/primitives';
import { displayFolderLabel } from '../utils/workspacePaths';
import { filterMovableFolderTargets } from '../utils/sidebarTree';
import type { DirOpModalRequest } from '../hooks/useDirectoryShell';

export interface DirOpsModalProps {
  request: DirOpModalRequest | null;
  folderOptions: string[];
  submitting: boolean;
  serverError: string | null;
  onClose: () => void;
  onSubmit: (payload: { targetDir?: string; confirm?: boolean }) => Promise<boolean> | void;
}

export const DirOpsModal: React.FC<DirOpsModalProps> = ({
  request,
  folderOptions,
  submitting,
  serverError,
  onClose,
  onSubmit,
}) => {
  const [targetDir, setTargetDir] = useState('');
  const [filterText, setFilterText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  const candidateDirs = useMemo(() => {
    if (!request) return [];
    if (request.kind === 'folder-move') {
      return filterMovableFolderTargets(folderOptions, request.folderPath);
    }
    if (request.kind === 'batch-move') {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of ['', ...folderOptions]) {
        const key = raw.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(raw);
      }
      return out;
    }
    return [];
  }, [folderOptions, request]);

  useEffect(() => {
    if (!request) return;
    setFilterText('');
    setConfirmed(false);
    if (request.kind === 'folder-move' || request.kind === 'batch-move') {
      setTargetDir(candidateDirs[0] ?? '');
      window.setTimeout(() => filterInputRef.current?.focus(), 0);
    } else {
      setTargetDir('');
    }
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredDirs = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return candidateDirs;
    return candidateDirs.filter((dir) => {
      const label = displayFolderLabel(dir).toLowerCase();
      return label.includes(q) || dir.toLowerCase().includes(q);
    });
  }, [candidateDirs, filterText]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, request, submitting]);

  if (!request) return null;

  const isMove = request.kind === 'folder-move' || request.kind === 'batch-move';
  const isTrash = request.kind === 'folder-trash' || request.kind === 'batch-trash';
  const canSubmit = isMove
    ? candidateDirs.length > 0 && candidateDirs.includes(targetDir)
    : confirmed;

  const title =
    request.kind === 'folder-move'
      ? `移动文件夹「${request.folderPath}」`
      : request.kind === 'folder-trash'
        ? `将文件夹移入回收站`
        : request.kind === 'batch-move'
          ? `批量移动 ${request.fileIds.length} 份文件`
          : `批量移入系统回收站（${request.fileIds.length} 份）`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !canSubmit) return;
    if (isMove) {
      void onSubmit({ targetDir });
    } else {
      void onSubmit({ confirm: true });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-dir-ops-modal={request.kind}
      data-esc-layer="open"
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/25 dark:bg-black/62 backdrop-blur-[2px] p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="glass-pop w-full max-w-[460px] rounded-[var(--r-card)] shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="px-4 py-3 border-b border-[color:var(--glass-hairline)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {isMove ? (
              <FolderInput className="w-4 h-4 shrink-0 text-[color:var(--accent-iris-deep)]" />
            ) : (
              <Trash2 className="w-4 h-4 shrink-0 text-[color:var(--stage-ink-exec-text)]" />
            )}
            <h2 className="text-[13.5px] font-semibold text-[color:var(--ink-strong)] truncate">
              {title}
            </h2>
          </div>
          <IconButton label="关闭" onClick={onClose} disabled={submitting}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="p-4 space-y-3">
          {isMove && (
            <>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[color:var(--ink-faint)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={filterInputRef}
                  type="text"
                  aria-label="筛选目标目录"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="输入目录名快速过滤…"
                  className="glass-input w-full pl-8 pr-3 py-1.5 rounded-[var(--r-ctl)] text-[length:var(--text-ui)] text-[color:var(--ink-strong)] focus:outline-none focus:border-[color:var(--accent-iris-deep)]"
                />
              </div>

              {request.kind === 'folder-move' && (
                <p className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                  已自动隐藏当前父目录、本文件夹及其全部子目录（防成环），移动后子树内所有文件的 file_id 与版本历史保持连续。
                </p>
              )}

              <div className="max-h-[240px] overflow-y-auto rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-muted/40 p-1 space-y-0.5">
                {filteredDirs.length === 0 ? (
                  <div className="py-6 text-center text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                    没有可选目标目录
                  </div>
                ) : (
                  filteredDirs.map((dir) => {
                    const selected = targetDir === dir;
                    return (
                      <button
                        key={dir || '__root__'}
                        type="button"
                        onClick={() => setTargetDir(dir)}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[8px] text-left text-[length:var(--text-ui)] cursor-pointer transition-colors ${
                          selected
                            ? 'bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] font-medium'
                            : 'text-[color:var(--ink-strong)] hover:bg-accent'
                        }`}
                      >
                        <Folder className="w-3.5 h-3.5 shrink-0 opacity-75" />
                        <span className="truncate">{displayFolderLabel(dir)}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}

          {isTrash && (
            <div className="space-y-3">
              <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-[color:var(--depth-1-bg-soft)] p-3 space-y-1.5">
                <div className="flex items-start gap-2 text-[length:var(--text-ui)] text-[color:var(--ink-strong)]">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[color:var(--stage-ink-exec-text)]" />
                  <div className="min-w-0">
                    {request.kind === 'folder-trash' ? (
                      <>
                        确认将文件夹 <strong className="font-mono">{request.folderPath}</strong>{' '}
                        （含 <strong>{request.affectedCount}</strong> 份受管文件）移入操作系统回收站？
                      </>
                    ) : (
                      <>
                        确认将已选中的 <strong>{request.fileIds.length}</strong> 份文件移入操作系统回收站？
                      </>
                    )}
                  </div>
                </div>
                {request.kind === 'batch-trash' && request.sampleNames.length > 0 && (
                  <div className="pl-6 text-[length:var(--text-micro)] text-[color:var(--ink-soft)] space-y-0.5">
                    {request.sampleNames.slice(0, 5).map((name, idx) => (
                      <div key={idx} className="truncate">
                        · {name}
                      </div>
                    ))}
                    {request.fileIds.length > 5 && (
                      <div>… 等共 {request.fileIds.length} 份文件</div>
                    )}
                  </div>
                )}
                <div className="pl-6 flex items-center gap-1.5 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
                  <span>绝不永久删除；从系统回收站还原后自动重连原 file_id 与历史版本。</span>
                </div>
              </div>

              <label className="flex items-center gap-2 text-[length:var(--text-ui)] text-[color:var(--ink-strong)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="rounded border-[color:var(--glass-hairline)]"
                />
                <span>我已核对目标，确认移入系统回收站</span>
              </label>
            </div>
          )}

          {serverError && (
            <div className="rounded-[var(--r-ctl)] bg-[color:var(--depth-1-bg)] px-3 py-2 text-[length:var(--text-micro)] text-[color:var(--stage-ink-exec-text)] break-words">
              {serverError}
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-[color:var(--glass-hairline)] flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            disabled={!canSubmit || submitting}
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>{isMove ? '确认移动' : '移入回收站'}</span>
          </Button>
        </div>
      </form>
    </div>
  );
};
