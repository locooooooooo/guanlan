import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MountedWorkspaceDto } from '../services/apiTypes';
import { latestMountedReadings, type MountedReadingEntry } from '../utils/mountReadingPositions';

/**
 * 挂载参考工作区管理面板（独立组件；App 只留最薄接线）。
 *
 * - 列表：展示名 + 规范化根路径 + root_key 8 位短哈希（快照哈希标识）+
 *   在线/离线徽标 + 最后已知摘要（文件数 / 索引代 / 检索索引状态）+
 *   最近查阅（按挂载身份稳定哈希持久保留的阅读位置，离线可回看）；
 * - 挂载：输入参考目录绝对路径 → 服务端同步受理（父子互斥 / 重复挂载 /
 *   未索引等确定性错误码原样透出在错误行）；
 * - 卸载：只断开只读连接，绝不触碰参考区磁盘。
 */
export interface MountManagerPanelProps {
  isOpen: boolean;
  onClose: () => void;
  mounts: MountedWorkspaceDto[];
  loading: boolean;
  /** Hook 透出的最近一次操作错误（MOUNT_REJECTED / CONFLICT / NOT_FOUND …） */
  error: string;
  onMount: (rootPath: string) => Promise<boolean>;
  onUnmount: (mountId: string) => Promise<boolean>;
}

/** root_key 8 位短哈希（快照哈希标识；验收「明确标注…快照哈希」） */
function shortHash(mount: MountedWorkspaceDto): string {
  const key = mount.root_key || mount.mount_key;
  return key.slice(0, 8);
}

function ReadingHint({ bucketKey }: { bucketKey: string }): React.ReactElement | null {
  const entries = useMemo<MountedReadingEntry[]>(() => latestMountedReadings(bucketKey, 2), [bucketKey]);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 text-[11px] text-[color:var(--ink-3)]">
      最近查阅：
      {entries
        .map((e) => `${e.relative_path}（${e.at.slice(5, 16).replace('T', ' ')}）`)
        .join(' · ')}
    </div>
  );
}

export function MountManagerPanel(props: MountManagerPanelProps): React.ReactElement | null {
  const { isOpen, onClose, mounts, loading, error, onMount, onUnmount } = props;
  const [inputValue, setInputValue] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submitInFlightRef = useRef(false);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
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

  if (!isOpen) return null;

  const submit = async (): Promise<void> => {
    const path = inputValue.trim();
    if (!path || busy || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setBusy(true);
    try {
      const ok = await onMount(path);
      if (ok) setInputValue('');
    } finally {
      submitInFlightRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="挂载参考工作区"
      data-esc-layer="open"
      data-mount-panel="open"
      className="fixed inset-0 z-[85] flex items-center justify-center bg-[color:var(--ink-anchor)]/40 dark:bg-black/62 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-pop mx-4 w-[min(640px,94vw)] rounded-[var(--r-card,14px)] border border-[color:var(--glass-hairline)] p-5 shadow-2xl">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-[16px] font-semibold text-[color:var(--ink-strong)]">
            挂载参考工作区
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-mount-panel-close="true"
            className="rounded px-2 py-1 text-[12px] text-[color:var(--ink-3)] hover:bg-[color:var(--glass-hover,rgba(120,150,255,0.1))]"
          >
            关闭（Esc）
          </button>
        </div>
        <p className="mb-4 text-[12px] leading-5 text-[color:var(--ink-3)]">
          只读挂载其他观澜工作区（须先经观澜索引），跨项目检索历史采纳的规范、架构图与决定依据。
          严禁挂载当前工作区的父/子目录；参考区只读，主/挂载区之间禁止移动与写入。
        </p>

        {/* 挂载输入行 */}
        <div className="mb-3 flex gap-2">
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="参考目录绝对路径，如 D:\\archive\\2024-项目"
            spellCheck={false}
            autoComplete="off"
            data-mount-panel-input="true"
            className="flex-1 rounded-lg border border-[color:var(--glass-hairline)] bg-transparent px-3 py-2 text-[13px] text-[color:var(--ink-strong)] outline-none placeholder:text-[color:var(--ink-3)]/60"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || inputValue.trim() === ''}
            data-mount-panel-submit="true"
            className="rounded-lg px-4 py-2 text-[13px] font-medium text-[color:var(--ink-strong)] ring-1 ring-[color:var(--glass-hairline)] hover:bg-[color:var(--glass-hover,rgba(120,150,255,0.12))] disabled:opacity-40"
          >
            {busy ? '挂载中…' : '挂载'}
          </button>
        </div>

        {/* 确定性错误行（MOUNT_REJECTED / CONFLICT / NOT_FOUND …原样透出） */}
        {error ? (
          <div
            data-mount-panel-error="true"
            className="mb-3 rounded-lg bg-[color:var(--warn-bg,rgba(255,180,80,0.14))] px-3 py-2 text-[12px] leading-5 text-[color:var(--warn,#ffb454)]"
          >
            {error}
          </div>
        ) : null}

        {/* 挂载列表 */}
        <div className="max-h-[42vh] overflow-y-auto overscroll-contain">
          {mounts.length === 0 ? (
            <div className="px-2 py-6 text-center text-[13px] text-[color:var(--ink-3)]">
              {loading ? '正在读取挂载列表…' : '尚未挂载任何参考工作区'}
            </div>
          ) : (
            <ul className="space-y-2">
              {mounts.map((m) => (
                <li
                  key={m.mount_id}
                  data-mount-item={m.mount_id}
                  className="rounded-lg border border-[color:var(--glass-hairline)] px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-[1px] text-[10px] font-semibold ${
                        m.online
                          ? 'bg-[color:var(--glass-hover,rgba(120,200,150,0.16))] text-[color:var(--ink-2)]'
                          : 'bg-[color:var(--warn-bg,rgba(255,180,80,0.16))] text-[color:var(--warn,#ffb454)]'
                      }`}
                    >
                      {m.online ? '在线' : '离线'}
                    </span>
                    <span className="truncate text-[14px] font-medium text-[color:var(--ink-strong)]">
                      {m.name}
                    </span>
                    <span
                      className="rounded px-1 py-[1px] font-mono text-[10px] text-[color:var(--ink-3)] ring-1 ring-[color:var(--glass-hairline)]"
                      title={`挂载身份哈希 ${m.mount_key} · 参考区索引库 root_key ${m.root_key || '（无摘要）'}`}
                    >
                      {shortHash(m)}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-[color:var(--ink-3)]">
                      {m.file_count} 份资料 · 索引代 {m.index_generation} ·{' '}
                      {m.search_state === 'ready' ? '可检索' : m.search_state}
                    </span>
                    <button
                      type="button"
                      onClick={() => void onUnmount(m.mount_id)}
                      data-mount-unmount={m.mount_id}
                      className="shrink-0 rounded px-2 py-1 text-[11px] text-[color:var(--ink-3)] hover:bg-[color:var(--glass-hover,rgba(120,150,255,0.1))]"
                    >
                      卸载
                    </button>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-[color:var(--ink-3)]">
                    {m.root_path}
                  </div>
                  {m.error ? (
                    <div className="mt-1 text-[11px] text-[color:var(--warn,#ffb454)]">
                      {m.error}
                    </div>
                  ) : null}
                  <ReadingHint bucketKey={m.root_key || m.mount_key} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
