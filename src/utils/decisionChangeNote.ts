
import type { DecisionAssertion } from '../types/guanlan';

/** 变更单标题（测试锁词） */
export const DECISION_CHANGE_NOTE_TITLE = '最新已拍板决策变更单';

/** 来源：inline=本端 Inline 拍板；writeback=SSE decision_writeback 观测 */
export type DecisionChangeNoteSource = 'inline' | 'writeback';

export interface DecisionChangeNote {
  decisionId: string;
  code: string | null;
  question: string;
  decisionText: string;
  status: string | null;
  confirmer: string | null;
  effectiveDate: string | null;
  confirmedAt: string | null;
  fileId: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  blockingCleared: boolean;
  source: DecisionChangeNoteSource;
  at: string;
}

export interface DecisionChangeNoteInput {
  decisionId: string;
  code?: string | null;
  question?: string | null;
  decisionText?: string | null;
  status?: string | null;
  confirmer?: string | null;
  effectiveDate?: string | null;
  confirmedAt?: string | null;
  fileId: string;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  blockingCleared?: boolean;
  source: DecisionChangeNoteSource;
  at?: string;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function finiteLine(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 组装变更单（缺字段如实 null，不造数） */
export function buildDecisionChangeNote(input: DecisionChangeNoteInput): DecisionChangeNote {
  const decisionText = nonEmpty(input.decisionText);
  const question = nonEmpty(input.question) ?? decisionText ?? '已拍板决策';
  return {
    decisionId: input.decisionId,
    code: nonEmpty(input.code),
    question,
    decisionText: decisionText ?? '',
    status: nonEmpty(input.status),
    confirmer: nonEmpty(input.confirmer),
    effectiveDate: nonEmpty(input.effectiveDate),
    confirmedAt: nonEmpty(input.confirmedAt),
    fileId: input.fileId,
    filePath: nonEmpty(input.filePath),
    lineStart: finiteLine(input.lineStart),
    lineEnd: finiteLine(input.lineEnd),
    blockingCleared: input.blockingCleared === true,
    source: input.source,
    at: nonEmpty(input.at) ?? new Date().toISOString(),
  };
}

/**
 * 服务端决策行 → 变更单（SSE decision_writeback 路径）。
 * confirmationBasis 存在时取 recordText/confirmer/confirmedAt/lineRange；
 * 缺失时回退问题原文与首条证据定位，绝不伪造确认人。
 */
export function decisionChangeNoteFromAssertion(
  decision: Pick<
    DecisionAssertion,
    'decision_id' | 'code' | 'question' | 'status' | 'confirmationBasis' | 'evidences'
  >,
  options: {
    blockingCleared?: boolean;
    source: DecisionChangeNoteSource;
    at?: string;
  }
): DecisionChangeNote {
  const basis = decision.confirmationBasis;
  const evidence = decision.evidences[0];
  return buildDecisionChangeNote({
    decisionId: decision.decision_id,
    code: decision.code,
    question: decision.question,
    decisionText: basis?.recordText ?? null,
    status: decision.status,
    confirmer: basis?.confirmer ?? null,
    effectiveDate: null,
    confirmedAt: basis?.confirmedAt ?? null,
    fileId: basis?.file_id || evidence?.file_id || '',
    filePath: evidence?.relative_path ?? null,
    lineStart: basis?.lineRange?.[0] ?? evidence?.lineStart ?? null,
    lineEnd: basis?.lineRange?.[1] ?? evidence?.lineEnd ?? null,
    blockingCleared: options.blockingCleared === true,
    source: options.source,
    at: options.at,
  });
}

/** 一行摘要（通知条/抽屉卡共用）：「[D-01] 问题原文」 */
export function decisionChangeNoteSummaryLine(note: DecisionChangeNote): string {
  return `${note.code ? `[${note.code}] ` : ''}${note.question}`;
}
