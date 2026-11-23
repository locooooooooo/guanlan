import React from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { Button } from './ui/primitives';
import {
  DECISION_CHANGE_NOTE_TITLE,
  decisionChangeNoteSummaryLine,
} from '../utils/decisionChangeNote';
import type { DecisionChangeNote } from '../utils/decisionChangeNote';

/**
 * 决策变更单推送通知（PRD 3.3 第 3 步 / AC-03）。
 *
 * Inline 拍板完成（或 SSE decision_writeback 到达）后，App 生成
 * 《最新已拍板决策变更单》并推送到证道阁；本通知条告知用户，并提供
 * 「查看证道阁」入口。与 ProposalToast 同属右下角非侵入通知，错开一档
 * 垂直位置避免两条同时出现时重叠。
 */
export interface DecisionChangeToastProps {
  note: DecisionChangeNote | null;
  onOpenZhendaoge: () => void;
  onDismiss: () => void;
}

const DecisionChangeToast: React.FC<DecisionChangeToastProps> = ({
  note,
  onOpenZhendaoge,
  onDismiss,
}) => {
  if (!note) return null;
  return (
    <div
      data-decision-change-toast=""
      role="status"
      aria-live="polite"
      className="glass-pop glx-slide-up-in fixed bottom-20 right-4 z-50 max-w-sm rounded-[14px] px-4 py-3.5 space-y-2 text-[color:var(--ink-strong)]"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium">
          已向证道阁推送《{DECISION_CHANGE_NOTE_TITLE}》
        </p>
        <button
          type="button"
          aria-label="关闭决策变更单通知"
          onClick={onDismiss}
          className="cursor-pointer text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)]"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
        {decisionChangeNoteSummaryLine(note)}
      </p>
      {note.blockingCleared && (
        <p className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--stage-ink-deliver-text)]">
          本文档阻塞性 P0/P1 已清零，长任务节点已恢复。
        </p>
      )}
      <Button variant="secondary" size="sm" onClick={onOpenZhendaoge} className="cursor-pointer">
        <ArrowUpRight className="w-3.5 h-3.5" />
        <span>查看证道阁</span>
      </Button>
    </div>
  );
};

export default DecisionChangeToast;
