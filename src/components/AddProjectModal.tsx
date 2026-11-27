
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, Lock, X } from 'lucide-react';
import type { ProjectEntryDto } from '../services/apiTypes';
import type { RecentWorkspaceStatus } from '../services/desktopBridge';
import { Button } from './ui/primitives';

export interface AddProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectEntryDto[];
  recentWorkspaces?: RecentWorkspaceStatus[];
  desktopPickerSupported?: boolean;
  onPickFolder?: () => Promise<string | null>;
  busy?: boolean;
  error?: string | null;
  onSubmit: (input: {
    rootPath: string;
    name?: string;
    readonly?: boolean;
    activate?: boolean;
  }) => Promise<boolean>;
}

function normKey(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export const AddProjectModal: React.FC<AddProjectModalProps> = ({
  isOpen,
  onClose,
  projects,
  recentWorkspaces = [],
  desktopPickerSupported = false,
  onPickFolder,
  busy = false,
  error = null,
  onSubmit,
}) => {
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [readonly, setReadonly] = useState(false);
  const [activate, setActivate] = useState(false);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    setRootPath('');
    setName('');
    setReadonly(false);
    setActivate(false);
    submitInFlightRef.current = false;
    const id = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, busy, onClose]);

  const suggestedRecents = useMemo(() => {
    const existing = new Set(projects.map((p) => normKey(p.root_path)));
    return recentWorkspaces.filter((r) => r.exists && !existing.has(normKey(r.root)));
  }, [projects, recentWorkspaces]);

  if (!isOpen) return null;

  const handlePick = async () => {
    if (!onPickFolder || picking) return;
    setPicking(true);
    try {
      const picked = await onPickFolder();
      if (picked) {
        setRootPath(picked);
      }
    } finally {
      setPicking(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rootPath.trim() || busy || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      await onSubmit({
        rootPath: rootPath.trim(),
        name: name.trim() || undefined,
        readonly,
        activate,
      });
    } finally {
      submitInFlightRef.current = false;
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="添加本地项目文件夹"
      data-esc-layer="open"
      data-add-project-modal="open"
      className="fixed inset-0 z-[88] flex items-center justify-center bg-[color:var(--ink-anchor)]/40 dark:bg-black/62 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="glass-pop glx-popover-in w-[min(560px,95vw)] rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] p-5 shadow-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="size-8 rounded-[10px] bg-[color:var(--chip-active-bg)] border border-[color:var(--chip-active-border)] text-[color:var(--accent-iris-ink)] flex items-center justify-center shrink-0">
              <FolderPlus className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[color:var(--ink-strong)]">
                添加项目文件夹
              </h2>
              <p className="text-[12px] text-[color:var(--ink-soft)] mt-0.5">
                原地接入本机任意项目目录（零复制、自动建索引并实时监听），接入后可在顶部项目下拉中随时切换。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭弹窗"
            className="w-7 h-7 rounded-[8px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleFormSubmit(e)} className="space-y-3.5">
          <div className="space-y-1.5">
            <label
              htmlFor="add-project-path"
              className="block text-[12px] font-medium text-[color:var(--ink-strong)]"
            >
              项目文件夹路径
            </label>
            <div className="flex items-center gap-2">
              <input
                id="add-project-path"
                ref={inputRef}
                type="text"
                data-add-project-path-input=""
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="例如 H:\\项目B 或 D:\\workspace\\client-app"
                spellCheck={false}
                autoComplete="off"
                className="glass-input flex-1 min-w-0 rounded-[var(--r-ctl)] px-3 py-2 font-mono text-[12px] text-[color:var(--ink-strong)] focus:outline-none focus:border-[color:var(--accent-iris-deep)]"
              />
              {desktopPickerSupported && onPickFolder && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || picking}
                  data-add-project-pick-btn=""
                  onClick={() => void handlePick()}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>{picking ? '选择中…' : '浏览…'}</span>
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="add-project-name"
              className="block text-[12px] font-medium text-[color:var(--ink-strong)]"
            >
              项目显示名称 <span className="text-[color:var(--ink-faint)] font-normal">（可选，默认取目录名）</span>
            </label>
            <input
              id="add-project-name"
              type="text"
              data-add-project-name-input=""
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 官网重构 / 客户交付二期"
              maxLength={80}
              className="glass-input w-full rounded-[var(--r-ctl)] px-3 py-1.5 text-[12.5px] text-[color:var(--ink-strong)] focus:outline-none focus:border-[color:var(--accent-iris-deep)]"
            />
          </div>

          <div className="space-y-2 rounded-[10px] bg-muted/45 border border-[color:var(--glass-hairline)] p-3">
            <label className="flex items-start gap-2 cursor-pointer text-[12px] text-[color:var(--ink-strong)]">
              <input
                type="checkbox"
                data-add-project-activate-checkbox=""
                checked={activate}
                onChange={(e) => setActivate(e.target.checked)}
                className="mt-0.5 accent-[color:var(--accent-iris-deep)]"
              />
              <span>
                <span className="font-medium">添加后立即聚焦到该项目</span>
                <span className="block text-[11px] text-[color:var(--ink-soft)]">
                  不勾选则保持当前视图不变，新项目直接在左侧栏展开可查可操作。
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer text-[12px] text-[color:var(--ink-strong)]">
              <input
                type="checkbox"
                data-add-project-readonly-checkbox=""
                checked={readonly}
                onChange={(e) => setReadonly(e.target.checked)}
                className="mt-0.5 accent-[color:var(--accent-iris-deep)]"
              />
              <span>
                <span className="inline-flex items-center gap-1 font-medium">
                  <Lock className="w-3 h-3 text-[color:var(--ink-soft)]" />
                  开启只读归档保护
                </span>
                <span className="block text-[11px] text-[color:var(--ink-soft)]">
                  适合历史归档或公共参考库：允许全文检索与阅读，但拦截新建/改名/移动/删除。
                </span>
              </span>
            </label>
          </div>

          {suggestedRecents.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-[color:var(--ink-soft)]">
                最近打开过的目录（点击一键填入）
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {suggestedRecents.map((item) => (
                  <button
                    key={item.root}
                    type="button"
                    onClick={() => {
                      setRootPath(item.root);
                      if (!name.trim()) setName(item.name);
                    }}
                    title={item.root}
                    className="px-2.5 py-1 rounded-full bg-muted/60 hover:bg-[color:var(--chip-active-bg)] border border-[color:var(--glass-hairline)] text-[11.5px] text-[color:var(--ink-strong)] hover:text-[color:var(--accent-iris-ink)] cursor-pointer transition-colors"
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              data-add-project-error=""
              className="rounded-[var(--r-ctl)] border border-[color:color-mix(in_srgb,var(--stage-ink-exec)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_10%,transparent)] px-3 py-2 text-[12px] text-[color:var(--stage-ink-exec-text)] break-all"
            >
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || !rootPath.trim()}
              data-add-project-submit-btn=""
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>{busy ? '正在接入并建库…' : '加入项目列表'}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
