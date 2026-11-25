import React, { useState } from 'react';
import { AlertTriangle, FolderOpen, RefreshCw, RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { DesktopSessionState } from '../services/desktopBridge';
import { BRAND_NAME, BRAND_SLOGAN, BRAND_SLOGAN_NOTE } from '../utils/brandIdentity';
import { BrandMark } from './BrandMark';
import { Button } from './ui/primitives';

interface WorkspaceGateModalProps {
  session: DesktopSessionState;
  busy?: boolean;
  actionError?: string | null;
  onPickFolder: () => void;
  onOpenRoot: (root: string) => void;
  onRemoveRecent?: (root: string) => void;
}

/**
 * 桌面壳零配置首启引导与 ROOT_IN_USE 锁冲突恢复面板。
 *
 * - `unconfigured`：首次无配置启动（或记忆目录已不存在），引导选择或输入本地项目目录；
 * - `root_in_use`：目标工作区被另一观澜实例占用，展示锁文件与 PID 诊断，提供重试/切回/另选；
 * - `error`：其余接入失败兜底恢复。
 */
export const WorkspaceGateModal: React.FC<WorkspaceGateModalProps> = ({
  session,
  busy = false,
  actionError = null,
  onPickFolder,
  onOpenRoot,
  onRemoveRecent,
}) => {
  const [manualPath, setManualPath] = useState(session.root ?? '');
  const isConflict = session.status === 'root_in_use';
  const isError = session.status === 'error';
  const err = session.error;

  const handleSubmitPath = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manualPath.trim();
    if (!trimmed || busy) return;
    onOpenRoot(trimmed);
  };

  return (
    <div
      data-workspace-gate={session.status}
      className="depth-0-surface flex-1 min-h-0 flex items-center justify-center p-6 overflow-y-auto"
    >
      <div className="glass-pop glx-modal-in relative w-full max-w-xl rounded-[var(--r-card)] overflow-hidden p-7 space-y-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
          style={{
            backgroundColor:
              isConflict || isError ? 'var(--stage-ink-decision)' : 'var(--accent-iris-deep)',
          }}
        />
        <div className="flex items-start gap-4">
          <div
            className={`w-11 h-11 flex items-center justify-center shrink-0 ${
              isConflict || isError
                ? 'rounded-2xl bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_14%,transparent)] text-[color:var(--stage-ink-decision-text)]'
                : ''
            }`}
          >
            {isConflict || isError ? (
              <AlertTriangle className="w-5 h-5" />
            ) : (
              <BrandMark size="lg" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <h1 className="font-serif-claude text-[22px] leading-[1.3] font-semibold tracking-[-0.02em] text-[color:var(--ink-strong)]">
              {isConflict
                ? '工作区正被另一个观澜实例占用（ROOT_IN_USE）'
                : isError
                  ? '无法接入工作区'
                  : `欢迎使用${BRAND_NAME}`}
            </h1>
            <p className="text-[length:var(--text-ui-body)] leading-[1.6] text-[color:var(--ink-soft)]">
              {isConflict
                ? '同一工作区同一时刻只允许一个写入实例持有排他锁，以防止 SQLite 索引与版本快照竞争。请关闭另一实例后重试，或选择其他目录。'
                : isError
                  ? err?.message || '工作区服务启动失败，请确认目录存在并可读取后重试。'
                  : `${BRAND_SLOGAN} · ${BRAND_SLOGAN_NOTE}。选择任意本地项目或资料文件夹即可开始时空索引与版本回溯——所有索引与快照都保存在本机数据目录，绝不向你的业务目录写入隐藏文件。`}
            </p>
          </div>
        </div>

        {(isConflict || isError) && err && (
          <div className="rounded-[var(--r-block)] border border-[color:var(--glass-hairline)] bg-white/70 p-3.5 space-y-1.5 font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
            <div className="break-all">
              <span className="font-semibold text-[color:var(--ink-strong)]">目标目录：</span>
              {err.root}
            </div>
            {err.lockFilePath && (
              <div className="break-all">
                <span className="font-semibold text-[color:var(--ink-strong)]">锁文件：</span>
                {err.lockFilePath}
              </div>
            )}
            {err.lockInfo && (
              <div className="whitespace-pre-wrap break-all">
                <span className="font-semibold text-[color:var(--ink-strong)]">占用诊断：</span>
                {err.lockInfo}
              </div>
            )}
          </div>
        )}

        {actionError && (
          <div
            role="alert"
            className="rounded-[var(--r-ctl)] border border-[color:color-mix(in_srgb,var(--stage-ink-exec)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_10%,transparent)] px-3 py-2 text-[length:var(--text-ui)] text-[color:var(--stage-ink-exec-text)]"
          >
            {actionError}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          {(isConflict || isError) && session.root && (
            <Button
              variant="primary"
              disabled={busy}
              data-desktop-retry
              onClick={() => onOpenRoot(session.root!)}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              <span>重试接入</span>
            </Button>
          )}
          <Button
            variant={isConflict || isError ? 'secondary' : 'primary'}
            disabled={busy}
            data-desktop-pick-folder
            onClick={onPickFolder}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>{isConflict || isError ? '选择其他文件夹' : '选择本地工作区文件夹'}</span>
          </Button>
          {session.previousRoot && (
            <Button
              variant="secondary"
              disabled={busy}
              data-desktop-restore-prev
              onClick={() => onOpenRoot(session.previousRoot!)}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>恢复上一工作区</span>
            </Button>
          )}
        </div>

        <form onSubmit={handleSubmitPath} className="space-y-1.5">
          <label className="block text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]">
            或直接输入 / 粘贴文件夹路径
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              data-desktop-path-input
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              placeholder="例如 D:\Projects\my-workspace"
              className="glass-input flex-1 min-w-0 rounded-[var(--r-ctl)] px-3 py-1.5 font-mono text-[length:var(--text-ui)] text-[color:var(--ink-strong)] focus:outline-none"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={busy || !manualPath.trim()}
              data-desktop-open-path
            >
              打开目录
            </Button>
          </div>
        </form>

        {session.recentWorkspaces.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-[color:var(--glass-hairline)]">
            <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]">
              最近工作区
            </div>
            <div className="space-y-1 max-h-44 overflow-y-auto">
              {session.recentWorkspaces.map((entry) => (
                <div
                  key={entry.root}
                  className="flex items-center justify-between gap-2 rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-white/60 px-2.5 py-1.5"
                >
                  <button
                    type="button"
                    disabled={busy || !entry.exists}
                    data-recent-workspace={entry.root}
                    onClick={() => onOpenRoot(entry.root)}
                    className="flex-1 min-w-0 text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    title={entry.root}
                  >
                    <div className="text-[length:var(--text-ui)] font-medium text-[color:var(--ink-strong)] truncate">
                      {entry.name}
                      {!entry.exists && (
                        <span className="ml-2 text-[length:var(--text-micro)] text-[color:var(--stage-ink-exec-text)]">
                          （目录不存在）
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] truncate">
                      {entry.root}
                    </div>
                  </button>
                  {onRemoveRecent && (
                    <button
                      type="button"
                      aria-label={`移除最近工作区 ${entry.name}`}
                      onClick={() => onRemoveRecent(entry.root)}
                      className="p-1 text-[color:var(--ink-faint)] hover:text-[color:var(--ink-strong)] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[length:var(--text-micro)] text-[color:var(--ink-soft)] pt-1">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
          <span>零污染承诺：只读索引与安全快照，不锁定或污染原始项目目录</span>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceGateModal;
