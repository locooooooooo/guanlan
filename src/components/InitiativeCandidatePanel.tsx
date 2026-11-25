import React, { useCallback, useEffect, useState } from 'react';
import { Check, ClipboardList, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import type { InitiativeCandidateItem, InitiativeCandidateMember } from '../services/apiTypes';
import {
  adoptInitiativeCandidate,
  dismissInitiativeCandidate,
  excludeInitiativeCandidateMember,
  fetchInitiativeCandidates,
} from '../services/workspaceClient';

export interface InitiativeCandidatePanelProps {
  /** 采纳成功后回调（App 侧刷新 state-overview；缺省依赖 SSE 联动） */
  onAdopted?: () => void;
  /** 成员点击跳转（缺省仅展示） */
  onOpenFile?: (fileId: string) => void;
}

/** 信号位掩码 → 徽标文案 */
const SIGNAL_LABELS: Array<{ bit: number; label: string }> = [
  { bit: 0x10, label: 'Agent 批次' },
  { bit: 0x08, label: '会话共现' },
  { bit: 0x04, label: '同名主干' },
  { bit: 0x02, label: '显式链接' },
  { bit: 0x01, label: '目录前缀' },
];

/**
 * 候选事项编织面板（独立组件）。
 * 多信号候选簇：每条关联悬浮显示命中规则的证据胶囊（非黑盒）；采纳 / 否决 / 单成员剔除
 * 全部经用户显式操作（202 任务），绝不移动磁盘文件、绝不擅自改动正式事项归属。
 */
export const InitiativeCandidatePanel: React.FC<InitiativeCandidatePanelProps> = ({
  onAdopted,
  onOpenFile,
}) => {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [items, setItems] = useState<InitiativeCandidateItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetchInitiativeCandidates();
    if (res.ok) {
      setItems(res.data.items);
      setErrorMsg(null);
    } else {
      setErrorMsg(res.error || '未能读取候选事项');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void reload();
    return () => controller.abort();
  }, [reload]);

  /** 提交 202 任务后延迟重拉（写线程完成后 SSE 也会驱动刷新，这里兜底） */
  const act = useCallback(
    async (
      id: string,
      action: () => Promise<{ ok: boolean; error?: string }>,
      after?: () => void
    ) => {
      setBusyId(id);
      const res = await action();
      if (res.ok) {
        after?.();
        window.setTimeout(() => void reload(), 1200);
        window.setTimeout(() => void reload(), 3000);
      } else {
        setErrorMsg(res.error || '操作失败');
      }
      setBusyId(null);
    },
    [reload]
  );

  const handleAdopt = (item: InitiativeCandidateItem) =>
    act(item.candidate_id, () => adoptInitiativeCandidate(item.candidate_id), onAdopted);
  const handleDismiss = (item: InitiativeCandidateItem) =>
    act(item.candidate_id, () => dismissInitiativeCandidate(item.candidate_id));
  const handleExclude = (item: InitiativeCandidateItem, member: InitiativeCandidateMember) =>
    act(item.candidate_id, () =>
      excludeInitiativeCandidateMember(item.candidate_id, member.file_id)
    );

  const active = items.filter((item) => item.state === 'candidate');
  const settled = items.filter((item) => item.state !== 'candidate');

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>正在编织候选事项…</span>
      </div>
    );
  }
  if (errorMsg) {
    return (
      <div className="px-3 py-2 text-[length:var(--text-micro)] text-[color:var(--stage-ink-decision-text)]">
        {errorMsg}
      </div>
    );
  }
  if (active.length === 0) {
    return (
      <div className="px-3 py-2 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
        暂无候选事项——多信号编织器会在对账后自动发现跨目录的隐式事项。
      </div>
    );
  }

  return (
    <div className="space-y-2" data-candidate-panel="true">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5 text-[length:var(--text-micro)] font-semibold text-[color:var(--ink-soft)]">
          <Sparkles className="w-3.5 h-3.5 text-[color:var(--accent-iris)]" />
          编织候选（{active.length}）
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          title="重新拉取候选"
          className="cursor-pointer text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)]"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {active.map((item) => (
        <div
          key={item.candidate_id}
          className="rounded-lg border border-[color:var(--glass-hairline)] bg-white/70 p-2.5 space-y-1.5"
          data-candidate-id={item.candidate_id}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[length:var(--text-ui-body)] font-medium text-[color:var(--ink-strong)] truncate">
                {item.title}
              </div>
              <div className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)] leading-snug">
                {item.reason_summary}
              </div>
            </div>
            <span
              title="置信分"
              className="shrink-0 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--accent-iris-ink)]"
            >
              {item.score}
            </span>
          </div>

          <div className="flex flex-wrap gap-1">
            {SIGNAL_LABELS.filter(({ bit }) => (item.signal_mask & bit) !== 0).map(({ bit, label }) => (
              <span
                key={bit}
                className="rounded border border-[color:var(--glass-hairline)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--ink-soft)]"
              >
                {label}
              </span>
            ))}
            <span className="rounded border border-[color:var(--glass-hairline)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--ink-soft)]">
              {item.member_count} 份
            </span>
          </div>

          <div className="space-y-0.5">
            {item.members.map((member) => (
              <div key={member.file_id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpenFile?.(member.file_id)}
                  title={member.signals.map((s) => `${s.signal}：${s.detail}`).join('\n')}
                  className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,transparent)] hover:text-[color:var(--ink-strong)] cursor-pointer"
                >
                  {member.relative_path}
                </button>
                <button
                  type="button"
                  onClick={() => void handleExclude(item, member)}
                  disabled={busyId === item.candidate_id}
                  title="剔出候选（误聚项；重扫不反弹）"
                  className="shrink-0 rounded-[var(--r-ctl)] p-1 text-[color:var(--ink-soft)] opacity-0 transition-opacity hover:bg-[color:color-mix(in_srgb,var(--stage-ink-anomaly)_10%,transparent)] hover:text-[color:var(--stage-ink-anomaly-text)] group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100 disabled:opacity-40 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => void handleAdopt(item)}
              disabled={busyId === item.candidate_id}
              className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--accent-iris-ink)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_20%,transparent)] disabled:opacity-40 cursor-pointer"
            >
              {busyId === item.candidate_id ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Check className="w-3 h-3" />
              )}
              采纳为事项
            </button>
            <button
              type="button"
              onClick={() => void handleDismiss(item)}
              disabled={busyId === item.candidate_id}
              title="整簇否决（成员间信号对排除，重扫不反弹）"
              className="inline-flex items-center gap-1 rounded-full border border-[color:var(--glass-hairline)] px-2.5 py-1 text-[11px] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] disabled:opacity-40 cursor-pointer"
            >
              <X className="w-3 h-3" />
              否决
            </button>
          </div>
        </div>
      ))}

      {settled.length > 0 && (
        <details className="px-1 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
          <summary className="cursor-pointer inline-flex items-center gap-1">
            <ClipboardList className="w-3 h-3" />
            已处理 {settled.length} 个候选
          </summary>
          <div className="mt-1 space-y-0.5">
            {settled.map((item) => (
              <div key={item.candidate_id} className="flex items-center justify-between">
                <span className="truncate">{item.title}</span>
                <span className="shrink-0 font-mono text-[10px]">
                  {item.state === 'adopted' ? '已采纳' : '已否决'}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};
