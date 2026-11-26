import React from 'react';
import {
  DECISION_CHANGE_NOTE_TITLE,
  decisionChangeNoteSummaryLine,
} from '../utils/decisionChangeNote';
import type { DecisionChangeNote } from '../utils/decisionChangeNote';

/**
 * 上下文清单内的《最新已拍板决策变更单》卡片。
 *
 * 纯展示组件：App 在 Inline 拍板完成或 SSE decision_writeback 到达时生成
 * DecisionChangeNote 并推送到上下文清单；抽屉打开时置顶展示最新一条。
 * 缺失字段如实显示「未记录」，不造确认人/日期。
 */
export const DecisionChangeNoteCard: React.FC<{ note: DecisionChangeNote }> = ({ note }) => {
  const stateLabel = note.blockingCleared
    ? '本文档阻塞已清零 · 长任务已唤醒'
    : note.status ?? (note.source === 'writeback' ? '回写事件' : '已确认');
  const lineRange =
    note.lineStart !== null
      ? `#L${note.lineStart}${note.lineEnd !== null ? `–L${note.lineEnd}` : ''}`
      : '';

  return (
    <section
      data-decision-change-note=""
      aria-label={DECISION_CHANGE_NOTE_TITLE}
      className="rounded-[var(--r-block)] border border-[color:color-mix(in_srgb,var(--stage-ink-deliver)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_8%,transparent)] px-3 py-2.5 space-y-1.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-strong)]">
          {DECISION_CHANGE_NOTE_TITLE}
        </h3>
        <span className="rounded-[var(--r-pill)] bg-card/85 border border-border/70 px-1.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
          {stateLabel}
        </span>
      </div>
      <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium text-[color:var(--ink-strong)]">
        {decisionChangeNoteSummaryLine(note)}
      </p>
      <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
        决定：{note.decisionText || '未记录'}
      </p>
      <p className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
        确认人：{note.confirmer || '未记录'}
        {note.effectiveDate ? ` · 生效日期：${note.effectiveDate}` : ''}
        {note.confirmedAt ? ` · 确认时间：${note.confirmedAt.slice(0, 10)}` : ''}
      </p>
      {note.filePath && (
        <p className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] break-all">
          来源：{note.filePath}
          {lineRange}
        </p>
      )}
    </section>
  );
};

export default DecisionChangeNoteCard;
