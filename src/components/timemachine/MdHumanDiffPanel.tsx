import { useMemo, useState } from 'react';
import { ChevronRight, CircleDot, ListTree } from 'lucide-react';
import type {
  DecisionChange,
  DiffRow,
  LineDiffResult,
  MdHumanDiffResult,
  OutlineRow,
  TodoChange,
} from '../../utils/multimodalDiff';

/**
 * D03 ① · Markdown「结论结构」人类可读 Diff 面板。
 *
 * 默认视图 = 标题结构（逐章变更徽标）+ 决定/待办变化（人话 chip）+ 关键增删段（聚簇 ±2 行）；
 * mode='source' 切源码行 Diff（unchanged 长连续段折叠为「省略 N 行未变」，DOM 有界）。
 * 颜色只走既有 --cv-* 令牌（修改=--cv-lane-md / 新增=--cv-add / 删除=--cv-del），无新裸色值。
 */

export type MdDiffPanelMode = 'human' | 'source';

export interface MdHumanDiffPanelProps {
  result: MdHumanDiffResult;
  mode: MdDiffPanelMode;
  /** 点击章节/决定/待办/代码行时跳转到新版对应行（宿主接 onRead 行级直达） */
  onJumpLine?: (line: number) => void;
}

const CHANGE_LABEL: Record<NonNullable<OutlineRow['changeKind']>, string> = {
  added: '新增',
  changed: '修改',
};
const CHANGE_COLOR: Record<string, string> = {
  added: 'var(--cv-add)',
  changed: 'var(--cv-lane-md)',
  removed: 'var(--cv-del)',
};

/** 源码行模式：unchanged 连续段超过该长度折叠为省略行（DOM 有界护栏） */
const SOURCE_COLLAPSE_RUN = 10;
/** 关键增删段渲染窗口数上限（超预算文档的聚簇可能有几十个；窗口列表有界） */
const MAX_SEGMENT_WINDOWS = 40;

export function MdHumanDiffPanel({ result, mode, onJumpLine }: MdHumanDiffPanelProps) {
  if (mode === 'source') return <SourceRows result={result} onJumpLine={onJumpLine} />;
  return (
    <div className="space-y-3 text-[12px]" data-machine-md-human="">
      <OutlineBlock outline={result.outline} onJumpLine={onJumpLine} />
      <ElementChangesBlock result={result} onJumpLine={onJumpLine} />
      <KeySegmentsBlock result={result} />
    </div>
  );
}

// ---------- 标题结构 ----------

function OutlineBlock({ outline, onJumpLine }: { outline: OutlineRow[]; onJumpLine?: (line: number) => void }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const changedRows = outline.filter((row) => Boolean(row.changeKind));
  const unchangedCount = outline.length - changedRows.length;
  const canFoldUnchanged = changedRows.length > 0 && unchangedCount > 0;
  const visibleRows = canFoldUnchanged && !showUnchanged ? changedRows : outline;

  return (
    <section aria-label="标题结构对比">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
          <ListTree size={12} /> 标题结构 · {outline.length} 章 · {changedRows.length} 章有变
        </h4>
        {canFoldUnchanged && (
          <button
            type="button"
            data-outline-unchanged-toggle=""
            aria-expanded={showUnchanged}
            onClick={() => setShowUnchanged((v) => !v)}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[10px] hover:underline"
            style={{ color: 'var(--cv-ink-meta)' }}
          >
            <ChevronRight
              size={11}
              style={{
                transform: showUnchanged ? 'rotate(90deg)' : undefined,
                transition: 'transform 120ms ease',
              }}
            />
            <span>{showUnchanged ? `收起 ${unchangedCount} 未变` : `其余 ${unchangedCount} 章未变`}</span>
          </button>
        )}
      </div>
      {outline.length === 0 ? (
        <p style={{ color: 'var(--cv-ink-meta)' }}>新版没有可识别的标题结构。</p>
      ) : (
        <ul className="space-y-0.5">
          {visibleRows.map((row) => (
            <li key={row.line} className="flex items-baseline gap-2">
              {row.changeKind ? (
                <span
                  className="shrink-0 rounded px-1 font-mono text-[10px]"
                  style={{ color: CHANGE_COLOR[row.changeKind], background: 'var(--cv-card)' }}
                >
                  [{CHANGE_LABEL[row.changeKind]}]
                </span>
              ) : (
                <span className="shrink-0 px-1 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
                  [未变]
                </span>
              )}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left hover:underline"
                style={{ color: row.changeKind ? 'var(--cv-ink-3)' : 'var(--cv-ink-meta)' }}
                title={`跳到新版 L${row.line}`}
                onClick={() => onJumpLine?.(row.line)}
              >
                {row.title}
              </button>
              <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
                L{row.line}
                {row.end !== row.line ? `–${row.end}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- 决定 / 待办变化 ----------

function ElementChangesBlock({ result, onJumpLine }: { result: MdHumanDiffResult; onJumpLine?: (line: number) => void }) {
  const decisions = result.decisionChanges;
  const todos = result.todoChanges;
  const empty = decisions.length === 0 && todos.length === 0;
  if (empty) {
    return (
      <div
        data-element-changes-empty=""
        className="flex items-center gap-1.5 font-mono text-[10px]"
        style={{ color: 'var(--cv-ink-meta)' }}
      >
        <CircleDot size={11} />
        <span>决定 / 待办无变化</span>
      </div>
    );
  }
  return (
    <section aria-label="决定与待办变化">
      <h4 className="mb-1 flex items-center gap-1.5 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
        <CircleDot size={12} /> 决定 / 待办变化 · {decisions.length + todos.length} 处
      </h4>
      <ul className="space-y-1">
        {decisions.map((change) => (
          <DecisionRow key={`d-${change.kind}-${change.line}-${change.title}`} change={change} onJumpLine={onJumpLine} />
        ))}
        {todos.map((change) => (
          <TodoRow key={`t-${change.kind}-${change.line}-${change.text}`} change={change} onJumpLine={onJumpLine} />
        ))}
      </ul>
    </section>
  );
}

function DecisionRow({ change, onJumpLine }: { change: DecisionChange; onJumpLine?: (line: number) => void }) {
  const color = change.kind === 'removed' ? CHANGE_COLOR.removed : change.blocking ? 'var(--cv-amber-ink)' : CHANGE_COLOR.added;
  const verb = change.kind === 'added' ? '新增决定' : change.kind === 'removed' ? '移除决定' : '状态变化';
  return (
    <li className="flex items-baseline gap-2">
      <span className="shrink-0 font-mono text-[10px]" style={{ color }}>{`[${change.priority}]`}</span>
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:underline"
        style={{ color: 'var(--cv-ink-3)' }}
        title={`跳到 L${change.line}`}
        onClick={() => onJumpLine?.(change.line)}
      >
        <span style={{ color }}>{verb}</span> · {change.title}
        {change.kind === 'changed' && change.oldStatus && (
          <span style={{ color: 'var(--cv-ink-meta)' }}>（{change.oldStatus} → {change.status}）</span>
        )}
        {change.kind !== 'changed' && <span style={{ color: 'var(--cv-ink-meta)' }}>（{change.status}）</span>}
      </button>
      <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>L{change.line}</span>
    </li>
  );
}

function TodoRow({ change, onJumpLine }: { change: TodoChange; onJumpLine?: (line: number) => void }) {
  const color = change.kind === 'removed' ? CHANGE_COLOR.removed : change.checked ? CHANGE_COLOR.added : 'var(--cv-ink-3)';
  const verb = change.kind === 'added' ? (change.checked ? '新增已办' : '新增待办') : change.kind === 'removed' ? '移除待办' : '勾选翻转';
  return (
    <li className="flex items-baseline gap-2">
      <span className="shrink-0 font-mono text-[10px]">{change.checked ? '☑' : '☐'}</span>
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:underline"
        style={{ color: 'var(--cv-ink-3)' }}
        title={`跳到 L${change.line}`}
        onClick={() => onJumpLine?.(change.line)}
      >
        <span style={{ color }}>{verb}</span> · {change.text}
        {change.kind === 'changed' && (
          <span style={{ color: 'var(--cv-ink-meta)' }}>（{change.oldChecked ? '已办' : '待办'} → {change.checked ? '已办' : '待办'}）</span>
        )}
      </button>
      <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>L{change.line}</span>
    </li>
  );
}

// ---------- 关键增删段 ----------

function KeySegmentsBlock({ result }: { result: MdHumanDiffResult }) {
  const { lineDiff } = result;
  if (!lineDiff.ok) {
    return (
      <section aria-label="关键增删段">
        <h4 className="mb-1 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>关键增删段</h4>
        <p role="status" style={{ color: 'var(--cv-ink-meta)' }}>{lineDiff.message}</p>
      </section>
    );
  }
  const segments = result.keySegments.slice(0, MAX_SEGMENT_WINDOWS);
  const omitted = result.keySegments.length - segments.length;
  return (
    <section aria-label="关键增删段">
      <h4 className="mb-1 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
        关键增删段 · {result.keySegments.length} 段（+{lineDiff.added}/-{lineDiff.removed} 行）
      </h4>
      {segments.length === 0 ? (
        <p style={{ color: 'var(--cv-ink-meta)' }}>两版之间没有文本级增删。</p>
      ) : (
        <div className="space-y-2">
          {segments.map((window, i) => (
            <div
              key={`seg-${i}`}
              className="overflow-hidden rounded-lg border"
              style={{ borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 16%, transparent)' }}
              data-machine-md-hunk=""
            >
              <div
                className="border-b px-2 py-0.5 font-mono text-[10px]"
                style={{
                  borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 12%, transparent)',
                  color: 'var(--cv-ink-meta)',
                  background: 'var(--cv-card)',
                }}
              >
                {window.oldStart !== undefined ? `旧 L${window.oldStart}` : '旧 —'} → {window.newStart !== undefined ? `新 L${window.newStart}` : '新 —'}
              </div>
              {lineDiff.rows.slice(window.startIndex, window.endIndex + 1).map((row, j) => (
                <RowLine key={`${window.startIndex}-${j}`} row={row} />
              ))}
            </div>
          ))}
          {omitted > 0 && (
            <p className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }} role="status">
              还有 {omitted} 段未展开——请切「源码行 Diff」查看完整对比。
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function RowLine({ row }: { row: DiffRow }) {
  if (row.type === 'unchanged') {
    return (
      <div className="px-2 py-px font-mono text-[11px]" style={{ color: 'var(--cv-ink-meta)' }} title={`L${row.oldLine}`}>
        {'  '}{row.text || ' '}
      </div>
    );
  }
  const isAdded = row.type === 'added';
  return (
    <div
      className="px-2 py-px font-mono text-[11px]"
      style={{
        color: isAdded ? CHANGE_COLOR.added : CHANGE_COLOR.removed,
        background: `color-mix(in srgb, ${isAdded ? 'var(--cv-add)' : 'var(--cv-del)'} 10%, transparent)`,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
      title={isAdded ? `新增于新 L${row.newLine}` : `移除自旧 L${row.oldLine}`}
    >
      {isAdded ? '+ ' : '- '}{row.text || ' '}
    </div>
  );
}

// ---------- 源码行 Diff（MD 源码模式与纯文本/代码时光机共用） ----------

export interface LineDiffViewProps {
  lineDiff: LineDiffResult;
  /** 仅换行符（CRLF/LF）差异但规范化后逐行一致时展示诚实说明 */
  lineEndingOnly?: boolean;
  onJumpLine?: (line: number) => void;
  ariaLabel?: string;
  /** MD 源码模式保留 data-machine-md-source，文本/源码格式传 'text' 挂 data-machine-text-diff */
  variant?: 'md' | 'text';
}

export function LineDiffView({
  lineDiff,
  lineEndingOnly = false,
  onJumpLine,
  ariaLabel = '源码行 Diff',
  variant = 'md',
}: LineDiffViewProps) {
  const rendered = useMemo(
    () => (lineDiff.ok ? collapseUnchangedRuns(lineDiff.rows) : []),
    [lineDiff]
  );
  if (!lineDiff.ok) {
    return <p role="status" className="text-[12px]" style={{ color: 'var(--cv-ink-meta)' }}>{lineDiff.message}</p>;
  }
  const summary =
    lineDiff.added === 0 && lineDiff.removed === 0
      ? lineEndingOnly
        ? `共 ${lineDiff.rows.length} 行 · 仅换行符差异（内容未变）`
        : `共 ${lineDiff.rows.length} 行 · +0/-0（内容无变化）`
      : `共 ${lineDiff.rows.length} 行 · +${lineDiff.added}/-${lineDiff.removed}`;
  return (
    <div
      className="font-mono text-[11px]"
      data-machine-md-source={variant === 'md' ? '' : undefined}
      data-machine-text-diff={variant === 'text' ? '' : undefined}
      aria-label={ariaLabel}
    >
      <p className="mb-1 text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
        {summary}
      </p>
      {rendered.map((item, i) =>
        item.kind === 'rows' ? (
          item.rows.map((row, j) => <RowLine key={`${i}-${j}`} row={row} />)
        ) : (
          <div
            key={i}
            className="px-2 py-px text-center text-[10px]"
            style={{ color: 'var(--cv-ink-meta)' }}
            title={`${item.count} 行未变（${item.fromLine}–${item.toLine}）`}
            onClick={() => onJumpLine?.(item.toLine + 1)}
            role="presentation"
          >
            ··· 省略 {item.count} 行未变 ···
          </div>
        )
      )}
    </div>
  );
}

function SourceRows({ result, onJumpLine }: { result: MdHumanDiffResult; onJumpLine?: (line: number) => void }) {
  return <LineDiffView lineDiff={result.lineDiff} onJumpLine={onJumpLine} variant="md" />;
}

type RenderItem =
  | { kind: 'rows'; rows: DiffRow[] }
  | { kind: 'collapsed'; count: number; fromLine: number; toLine: number };

/** 连续 unchanged 段 > SOURCE_COLLAPSE_RUN 行 → 保留首尾各 3 行 + 省略行（DOM 有界） */
function collapseUnchangedRuns(rows: DiffRow[]): RenderItem[] {
  const items: RenderItem[] = [];
  let run: DiffRow[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length <= SOURCE_COLLAPSE_RUN) {
      items.push({ kind: 'rows', rows: run });
    } else {
      items.push({ kind: 'rows', rows: run.slice(0, 3) });
      items.push({
        kind: 'collapsed',
        count: run.length - 6,
        fromLine: run[3].oldLine ?? run[3].newLine ?? 0,
        toLine: run[run.length - 4].newLine ?? run[run.length - 4].oldLine ?? 0,
      });
      items.push({ kind: 'rows', rows: run.slice(-3) });
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'unchanged') run.push(row);
    else {
      flush();
      items.push({ kind: 'rows', rows: [row] });
    }
  }
  flush();
  return items;
}
