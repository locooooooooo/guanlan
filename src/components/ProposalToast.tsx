import React from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, ExternalLink, Eye, RotateCcw, X } from 'lucide-react';
import type { RevisionProposalContentResponse } from '../services/apiTypes';
import {
  buildMarkdownHumanDiff,
  buildSvgDiff,
  buildTableDiff,
  computeLineDiffRows,
} from '../utils/multimodalDiff';
import { Button } from './ui/primitives';

/**
 * 回写通知条（双向回写闭环、CAS 安全网与独立草案分支）：
 * 外部智能体经 guanlan.propose_revision 提交修订草案后，默认落入独立草案态
 * `v(N+1)-agent-draft`（附输入上下文哈希清单与回执摘要），不直接污染工作树正式定稿；
 * 右下角非侵入式通知提供：
 *   「查看多模态 Diff → 一键采纳落盘 / 退回重做」完整批阅闭环。
 */

export interface ProposalToastData {
  draftId: string;
  /** 草案目标文件（查看 Diff / 打开阅读器用） */
  fileId: string;
  /** 文档名（basename；来自 /revision-proposals 的 path） */
  fileName: string;
  /** 草案版本标签（如 `v3-agent-draft`；受理初判无版本号时为 null——文案不造假） */
  versionLabel: string | null;
  conflict: boolean;
  /** Agent 回执摘要（可选） */
  receiptSummary?: string | null;
  /** 变更说明备注（可选） */
  note?: string | null;
  /** 提交本草案所依赖的输入上下文哈希清单（可选） */
  inputContextHashes?: string[];
}

/** 通知标题文案单一出口（测试锁词）：「智能体已提交《X》修订草案」；版本标签非空时缀后缀 */
export function proposalToastTitle(data: {
  fileName: string;
  versionLabel: string | null;
}): string {
  const suffix = data.versionLabel ? `（${data.versionLabel}）` : '';
  return `智能体已提交《${data.fileName}》修订草案${suffix}`;
}

/** 内联多模态 Diff 摘要行（纯数据，无 DOM/CSS 依赖，node --test 可直跑） */
export interface ProposalDiffPreviewLine {
  kind: 'added' | 'removed' | 'meta';
  text: string;
}

/** 多模态 Diff 审阅摘要（复用 multimodalDiff 有界纯函数引擎） */
export interface ProposalMultimodalDiffSummary {
  modeLabel: string;
  compareLabel: string;
  addedCount: number;
  removedCount: number;
  highlights: string[];
  lines: ProposalDiffPreviewLine[];
  truncated: boolean;
  budgetMessage?: string;
}

const MAX_INLINE_DIFF_LINES = 18;

/** 将短哈希格式化为易读芯片（剥离可选 sha256: 前缀后取前 12 位） */
export function shortContextHash(raw: string): string {
  const cleaned = raw.trim().replace(/^sha256:/i, '');
  return cleaned.length > 12 ? cleaned.slice(0, 12) : cleaned;
}

/**
 * 把 `/api/v1/revision-proposals/{id}/content` 转换为面向人类批阅的多模态 Diff 摘要。
 * - 当检测到 CAS 冲突（磁盘已被人工并行修改）时，优先以 `disk_text` 作为左栏基线
 *   （`磁盘现态 ↔ 草案分支`），避免把人工最新修改藏在旧基准背后；
 * - 严格尊重 2 MiB 截断标记与 DP 预算，绝不静默伪造「无变更」。
 */
export function summarizeProposalMultimodalDiff(
  content: RevisionProposalContentResponse
): ProposalMultimodalDiffSummary {
  const compareAgainstDisk = content.conflict && content.disk_text !== null;
  const compareLabel = compareAgainstDisk
    ? '磁盘现态 ↔ 草案分支（冲突比对）'
    : '基准版 ↔ 草案分支';

  if (content.truncated || content.proposed_text === null) {
    return {
      modeLabel: '大文件诚实降级',
      compareLabel,
      addedCount: 0,
      removedCount: 0,
      highlights: ['内容超出 2 MiB 内联预览预算，请点击「阅读器」按需流式检视。'],
      lines: [],
      truncated: true,
    };
  }

  const oldText = compareAgainstDisk
    ? (content.disk_text ?? '')
    : (content.base_text ?? content.disk_text ?? '');
  const newText = content.proposed_text;
  const fmt = (content.format || 'md').toLowerCase();

  if (fmt === 'md' || fmt === 'markdown') {
    const md = buildMarkdownHumanDiff(oldText, newText);
    if (!md.lineDiff.ok) {
      return {
        modeLabel: 'Markdown 语义 Diff',
        compareLabel,
        addedCount: 0,
        removedCount: 0,
        highlights: [md.lineDiff.message],
        lines: [],
        truncated: true,
        budgetMessage: md.lineDiff.message,
      };
    }
    const highlights: string[] = [];
    if (md.decisionChanges.length > 0) {
      highlights.push(`决策条目变化 ${md.decisionChanges.length} 项`);
    }
    if (md.todoChanges.length > 0) {
      highlights.push(`待办清单变化 ${md.todoChanges.length} 项`);
    }
    if (md.sections.length > 0) {
      highlights.push(`涉及 ${md.sections.length} 个章节`);
    }
    const changedLines: ProposalDiffPreviewLine[] = [];
    for (const row of md.lineDiff.rows) {
      if (row.type === 'unchanged') continue;
      if (changedLines.length >= MAX_INLINE_DIFF_LINES) break;
      changedLines.push({
        kind: row.type === 'added' ? 'added' : 'removed',
        text: row.text,
      });
    }
    return {
      modeLabel: 'Markdown 语义 Diff',
      compareLabel,
      addedCount: md.lineDiff.added,
      removedCount: md.lineDiff.removed,
      highlights,
      lines: changedLines,
      truncated: md.lineDiff.added + md.lineDiff.removed > changedLines.length,
    };
  }

  if (fmt === 'svg') {
    const svg = buildSvgDiff(oldText, newText);
    if (!svg.ok) {
      return {
        modeLabel: 'SVG 视觉图元 Diff',
        compareLabel,
        addedCount: 0,
        removedCount: 0,
        highlights: [svg.message],
        lines: [],
        truncated: true,
        budgetMessage: svg.message,
      };
    }
    const highlights = [
      `图元 +${svg.added} / -${svg.removed} / 改动 ${svg.changed}`,
    ];
    const lines: ProposalDiffPreviewLine[] = svg.changes.slice(0, MAX_INLINE_DIFF_LINES).map((ch) => ({
      kind: ch.kind === 'added' ? 'added' : ch.kind === 'removed' ? 'removed' : 'meta',
      text: ch.label || `<${ch.tag}>`,
    }));
    return {
      modeLabel: 'SVG 视觉图元 Diff',
      compareLabel,
      addedCount: svg.added,
      removedCount: svg.removed,
      highlights,
      lines,
      truncated: svg.truncated || svg.changes.length > lines.length,
    };
  }

  if (fmt === 'csv' || fmt === 'tsv') {
    const tbl = buildTableDiff(oldText, newText, fmt === 'tsv' ? '\t' : ',');
    if (!tbl.ok) {
      return {
        modeLabel: '表格数值 Diff',
        compareLabel,
        addedCount: 0,
        removedCount: 0,
        highlights: [tbl.message],
        lines: [],
        truncated: true,
        budgetMessage: tbl.message,
      };
    }
    const highlights = [
      `行 +${tbl.addedRows} / -${tbl.removedRows} · 单元格变更 ${tbl.cellChanges} 处`,
    ];
    const lines: ProposalDiffPreviewLine[] = [];
    for (const row of tbl.rows) {
      if (lines.length >= MAX_INLINE_DIFF_LINES) break;
      if (row.kind === 'changed') {
        for (const cell of row.changes) {
          if (lines.length >= MAX_INLINE_DIFF_LINES) break;
          lines.push({
            kind: 'meta',
            text: `第 ${row.rowNum} 行 ${cell.header || `列${cell.col + 1}`}: ${cell.oldValue} → ${cell.newValue}`,
          });
        }
      } else if (row.kind === 'added') {
        lines.push({ kind: 'added', text: `第 ${row.rowNum} 行: ${row.row.join(' | ')}` });
      } else if (row.kind === 'removed') {
        lines.push({ kind: 'removed', text: `第 ${row.oldRowNum} 行: ${row.oldRow.join(' | ')}` });
      }
    }
    return {
      modeLabel: '表格数值 Diff',
      compareLabel,
      addedCount: tbl.addedRows,
      removedCount: tbl.removedRows,
      highlights,
      lines,
      truncated: tbl.rowCapped || tbl.cellChanges > lines.length,
    };
  }

  const lineDiff = computeLineDiffRows(oldText, newText);
  if (!lineDiff.ok) {
    return {
      modeLabel: '行级文本 Diff',
      compareLabel,
      addedCount: 0,
      removedCount: 0,
      highlights: [lineDiff.message],
      lines: [],
      truncated: true,
      budgetMessage: lineDiff.message,
    };
  }
  const changedLines: ProposalDiffPreviewLine[] = [];
  for (const row of lineDiff.rows) {
    if (row.type === 'unchanged') continue;
    if (changedLines.length >= MAX_INLINE_DIFF_LINES) break;
    changedLines.push({
      kind: row.type === 'added' ? 'added' : 'removed',
      text: row.text,
    });
  }
  return {
    modeLabel: '行级文本 Diff',
    compareLabel,
    addedCount: lineDiff.added,
    removedCount: lineDiff.removed,
    highlights: [],
    lines: changedLines,
    truncated: lineDiff.added + lineDiff.removed > changedLines.length,
  };
}

export interface ProposalToastProps {
  toast: ProposalToastData | null;
  adopting: boolean;
  /** 采纳/退回结果提示（成功/失败文案；null=无提示） */
  adoptNotice: { ok: boolean; message: string } | null;
  onAdopt: (draftId: string) => void;
  onViewDiff: (draftId: string) => void;
  onDismiss: () => void;
  /** 退回重做处理态（可选，保持调用方兼容） */
  rejecting?: boolean;
  /** 点击「退回重做」正式驳回草案（绝不触碰磁盘原稿） */
  onReject?: (draftId: string) => void;
  /** 内联多模态 Diff 面板展开状态 */
  diffExpanded?: boolean;
  /** 内联 Diff 拉取中 */
  diffLoading?: boolean;
  /** 内联 Diff 错误提示 */
  diffError?: string | null;
  /** 草案多模态 Diff 载荷 */
  diffContent?: RevisionProposalContentResponse | null;
  /** 在阅读器中打开全文/历史对比 */
  onOpenInReader?: (fileId: string) => void;
}

const ProposalToast: React.FC<ProposalToastProps> = ({
  toast,
  adopting,
  adoptNotice,
  onAdopt,
  onViewDiff,
  onDismiss,
  rejecting = false,
  onReject,
  diffExpanded = false,
  diffLoading = false,
  diffError = null,
  diffContent = null,
  onOpenInReader,
}) => {
  if (!toast) return null;

  const isConflict = toast.conflict || Boolean(diffContent?.conflict);
  const contextHashes =
    (diffContent?.input_context_hashes?.length
      ? diffContent.input_context_hashes
      : toast.inputContextHashes) ?? [];
  const receiptText = diffContent?.receipt_summary ?? toast.receiptSummary ?? toast.note ?? null;
  const diffSummary = diffExpanded && diffContent ? summarizeProposalMultimodalDiff(diffContent) : null;
  const busy = adopting || rejecting;

  return (
    <div
      data-proposal-toast=""
      role="status"
      aria-live="polite"
      className={`glass-pop glx-slide-up-in fixed bottom-4 right-4 z-50 rounded-[14px] px-4 py-3.5 space-y-2.5 text-[color:var(--ink-strong)] ${
        diffExpanded ? 'w-[min(34rem,calc(100vw-2rem))]' : 'max-w-sm'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium">
            {proposalToastTitle(toast)}
          </p>
          {receiptText && (
            <p
              data-proposal-receipt=""
              className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-muted)] break-words"
            >
              回执：{receiptText}
            </p>
          )}
          {contextHashes.length > 0 && (
            <div
              data-proposal-context-hashes=""
              className="flex flex-wrap items-center gap-1 pt-0.5 text-[length:var(--text-micro)] text-[color:var(--ink-soft)]"
            >
              <span>依据 {contextHashes.length} 份上下文</span>
              {contextHashes.slice(0, 3).map((hash) => (
                <code
                  key={hash}
                  className="rounded px-1.5 py-0.5 bg-[color:var(--surface-subtle)] font-mono text-[10px] text-[color:var(--ink-muted)]"
                >
                  {shortContextHash(hash)}
                </code>
              ))}
              {contextHashes.length > 3 && (
                <span className="text-[10px]">+{contextHashes.length - 3}</span>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭修订草案通知"
          onClick={onDismiss}
          className="cursor-pointer shrink-0 text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)]"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {isConflict && (
        <p
          data-proposal-conflict=""
          className="flex items-start gap-1.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--stage-ink-decision-text)]"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>该草案与磁盘现态存在并发修改冲突（独立草案分支，未覆盖磁盘原稿），请先比对再处理。</span>
        </p>
      )}

      {diffExpanded && (
        <div
          data-proposal-diff-panel=""
          className="rounded-[10px] border border-[color:var(--line-soft)] bg-[color:var(--surface-subtle)] p-2.5 space-y-2 text-[length:var(--text-micro)]"
        >
          {diffLoading && (
            <p className="text-[color:var(--ink-soft)]">正在加载草案多模态 Diff…</p>
          )}
          {!diffLoading && diffError && (
            <p className="text-[color:var(--stage-ink-anomaly-text)]" role="alert">
              {diffError}
            </p>
          )}
          {!diffLoading && diffSummary && (
            <>
              <div className="flex items-center justify-between gap-2 text-[color:var(--ink-muted)]">
                <span className="font-medium">
                  {diffSummary.modeLabel} · {diffSummary.compareLabel}
                </span>
                <span className="font-mono shrink-0">
                  <span className="text-[color:var(--stage-ink-deliver-text)]">
                    +{diffSummary.addedCount}
                  </span>{' '}
                  /{' '}
                  <span className="text-[color:var(--stage-ink-anomaly-text)]">
                    -{diffSummary.removedCount}
                  </span>
                </span>
              </div>
              {diffSummary.highlights.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {diffSummary.highlights.map((item) => (
                    <span
                      key={item}
                      className="rounded-full px-2 py-0.5 bg-[color:var(--surface-card)] text-[color:var(--ink-strong)]"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              )}
              {diffSummary.lines.length > 0 ? (
                <pre className="max-h-48 overflow-auto rounded-[8px] bg-[color:var(--surface-card)] p-2 font-mono text-[11px] leading-[1.45] whitespace-pre-wrap break-words">
                  {diffSummary.lines.map((line, idx) => (
                    <div
                      key={`${line.kind}-${idx}`}
                      className={
                        line.kind === 'added'
                          ? 'text-[color:var(--stage-ink-deliver-text)]'
                          : line.kind === 'removed'
                            ? 'text-[color:var(--stage-ink-anomaly-text)]'
                            : 'text-[color:var(--ink-muted)]'
                      }
                    >
                      {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '· '}
                      {line.text}
                    </div>
                  ))}
                </pre>
              ) : (
                !diffSummary.truncated && (
                  <p className="text-[color:var(--ink-soft)]">草案与基线文本一致（无行级差异）。</p>
                )
              )}
              <div className="flex items-center justify-between gap-2 text-[color:var(--ink-soft)]">
                <span>
                  {diffSummary.truncated ? '仅预览前段变更，完整内容可在阅读器检视。' : '草案尚未写入工作树。'}
                </span>
                {onOpenInReader && (
                  <button
                    type="button"
                    onClick={() => onOpenInReader(toast.fileId)}
                    className="inline-flex items-center gap-1 cursor-pointer text-[color:var(--ink-strong)] hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>阅读器</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {adoptNotice && (
        <p
          className={`text-[length:var(--text-micro)] leading-[var(--lh-micro)] ${
            adoptNotice.ok
              ? 'text-[color:var(--stage-ink-deliver-text)]'
              : 'text-[color:var(--stage-ink-anomaly-text)]'
          }`}
          role={adoptNotice.ok ? undefined : 'alert'}
        >
          {adoptNotice.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onViewDiff(toast.draftId)}
          disabled={busy}
          className="cursor-pointer"
        >
          {diffExpanded ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : diffContent ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
          <span>{diffExpanded ? '收起 Diff' : '查看 Diff'}</span>
        </Button>
        {onReject && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onReject(toast.draftId)}
            disabled={busy}
            className="cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{rejecting ? '退回中…' : '退回重做'}</span>
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => onAdopt(toast.draftId)}
          disabled={busy}
          className="cursor-pointer"
        >
          <Check className="w-3.5 h-3.5" />
          <span>{adopting ? '采纳中…' : '一键采纳'}</span>
        </Button>
      </div>
    </div>
  );
};

export default ProposalToast;
