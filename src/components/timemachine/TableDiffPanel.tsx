import { useState } from 'react';
import type { CSSProperties } from 'react';
import { TableProperties } from 'lucide-react';
import type { TableDiffResult, TableCellChange, TableDiffRow, XlsxDiffResult } from '../../utils/multimodalDiff';

/**
 * CSV/TSV/XLSX 表格数值 Diff 面板：增删行列 + 单元格数值变化高亮。
 *
 * - CSV/TSV：buildTableDiff 结果直渲；XLSX：buildXlsxDiff 逐工作表 tab（只列有变化的工作表，
 *   新增/删除工作表以名单 chip 呈现）；
 * - 变化单元格琥珀高亮 + title 悬浮「旧值 → 新值」；双侧数值可解析时追加 Δ chip
 *   （正增量绿 / 负增量红，走 --cv-add/--cv-del 令牌）；
 * - DOM 护栏：最多渲染 RENDER_MAX_ROWS 行（超出诚实提示），数据层预算在 multimodalDiff。
 */

export interface TableDiffPanelProps {
  result: TableDiffResult | XlsxDiffResult;
  format: 'csv' | 'tsv' | 'xlsx';
}

/** 渲染行数上限（DOM 护栏，与数据预算无关） */
const RENDER_MAX_ROWS = 400;
const RENDER_MAX_HEADER_COLS = 24;

export function TableDiffPanel({ result, format }: TableDiffPanelProps) {
  if (format === 'xlsx') {
    return <XlsxBody result={result as XlsxDiffResult} />;
  }
  return <CsvBody result={result as TableDiffResult} />;
}

// ---------- CSV / TSV ----------

function CsvBody({ result }: { result: TableDiffResult }) {
  if (!result.ok) {
    return <p role="status" className="text-[11px]" style={{ color: 'var(--cv-ink-meta)' }}>{result.message}</p>;
  }
  const shown = result.rows.slice(0, RENDER_MAX_ROWS);
  const hidden = result.rows.length - shown.length;
  return (
    <div className="space-y-2" data-machine-table-diff="">
      <SummaryChips result={result} />
      {result.headerChanges.length > 0 && (
        <p className="font-mono text-[10px]" style={{ color: 'var(--cv-amber-ink)' }}>
          表头变化：{result.headerChanges.map((c) => `${c.oldValue || '∅'} → ${c.newValue || '∅'}`).join(' · ')}
        </p>
      )}
      {result.rowCapped && (
        <p role="status" className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
          行数超过对比上限，仅对比前 {result.rowCap} 行（诚实截断，不冒充全量）。
        </p>
      )}
      <div className="overflow-x-auto rounded border" style={{ borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 16%, transparent)' }}>
        <table className="w-full border-collapse text-[11px]" data-machine-table-diff-table="">
          <thead>
            <tr>
              <th className="border-b px-1.5 py-1 font-mono text-[9px] font-normal" style={cellHeadStyle}>行</th>
              {result.headers.slice(0, RENDER_MAX_HEADER_COLS).map((header, i) => (
                <th key={`h-${i}`} className="border-b px-1.5 py-1 text-left font-normal" style={cellHeadStyle}>
                  {header || `列${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <TableBodyRow key={`r-${i}`} row={row} colCount={result.headers.length} />
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <p className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }} role="status">
          还有 {hidden} 行变化未渲染（DOM 护栏 {RENDER_MAX_ROWS} 行）——计数已完整含入上方汇总。
        </p>
      )}
    </div>
  );
}

function SummaryChips({ result }: { result: TableDiffResult & { ok: true } }) {
  const chips: { label: string; color: string }[] = [
    { label: `+${result.addedRows} 行`, color: 'var(--cv-add)' },
    { label: `-${result.removedRows} 行`, color: 'var(--cv-del)' },
    { label: `${result.changedRows} 行有变`, color: 'var(--cv-amber-ink)' },
    { label: `${result.cellChanges} 格 · 其中数值变化 ${result.numericChanges} 格`, color: 'var(--cv-ink-3)' },
  ];
  return (
    <div className="flex flex-wrap gap-1.5" data-machine-table-summary="">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="rounded px-1.5 py-0.5 font-mono text-[10px]"
          style={{ background: 'var(--cv-card)', color: chip.color }}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}

const cellHeadStyle: CSSProperties = {
  color: 'var(--cv-ink-meta)',
  background: 'var(--cv-card)',
  borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 12%, transparent)',
  whiteSpace: 'nowrap',
};

function TableBodyRow({ row, colCount }: { row: TableDiffRow; colCount: number }) {
  if (row.kind === 'removed') {
    return (
      <tr data-machine-table-row="removed" style={{ background: 'color-mix(in srgb, var(--cv-del) 8%, transparent)' }}>
        <RowBadgeCell label="−" color="var(--cv-del)" title={`旧版第 ${row.oldRowNum} 行`} />
        {Array.from({ length: Math.max(colCount, row.oldRow.length) }, (_, c) => (
          <td key={c} className="px-1.5 py-0.5 align-top" style={{ color: 'var(--cv-del)', textDecoration: 'line-through' }}>
            {row.oldRow[c] ?? ''}
          </td>
        ))}
      </tr>
    );
  }
  if (row.kind === 'added') {
    return (
      <tr data-machine-table-row="added" style={{ background: 'color-mix(in srgb, var(--cv-add) 8%, transparent)' }}>
        <RowBadgeCell label="＋" color="var(--cv-add)" title={`新版第 ${row.rowNum} 行`} />
        {Array.from({ length: Math.max(colCount, row.row.length) }, (_, c) => (
          <td key={c} className="px-1.5 py-0.5 align-top" style={{ color: 'var(--cv-add)' }}>
            {row.row[c] ?? ''}
          </td>
        ))}
      </tr>
    );
  }
  if (row.kind === 'changed') {
    const changeByCol = new Map(row.changes.map((change) => [change.col, change]));
    return (
      <tr data-machine-table-row="changed">
        <RowBadgeCell label="±" color="var(--cv-amber-ink)" title={`新版第 ${row.rowNum} 行`} />
        {Array.from({ length: Math.max(colCount, row.row.length) }, (_, c) => {
          const change = changeByCol.get(c);
          if (!change) {
            return <td key={c} className="px-1.5 py-0.5 align-top" style={{ color: 'var(--cv-ink-3)' }}>{row.row[c] ?? ''}</td>;
          }
          return <ChangedCell key={c} change={change} />;
        })}
      </tr>
    );
  }
  return (
    <tr data-machine-table-row="unchanged">
      <RowBadgeCell label="" color="var(--cv-ink-meta)" title={`第 ${row.rowNum} 行`} />
      {Array.from({ length: Math.max(colCount, row.row.length) }, (_, c) => (
        <td key={c} className="px-1.5 py-0.5 align-top" style={{ color: 'var(--cv-ink-meta)' }}>{row.row[c] ?? ''}</td>
      ))}
    </tr>
  );
}

function RowBadgeCell({ label, color, title }: { label: string; color: string; title: string }) {
  return (
    <td className="px-1.5 py-0.5 align-top font-mono text-[10px]" style={{ color }} title={title} data-machine-table-badge="">
      {label}
    </td>
  );
}

function ChangedCell({ change }: { change: TableCellChange }) {
  return (
    <td
      className="px-1.5 py-0.5 align-top"
      data-machine-table-cell-changed=""
      style={{
        background: 'color-mix(in srgb, var(--cv-amber) 14%, transparent)',
        color: 'var(--cv-amber-ink)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
      title={`${change.oldValue || '∅'} → ${change.newValue || '∅'}`}
    >
      {change.newValue || '∅'}
      {change.numeric && (
        <span
          className="ml-1 font-mono text-[9px]"
          style={{ color: change.numeric.delta >= 0 ? 'var(--cv-add)' : 'var(--cv-del)' }}
          data-machine-table-delta=""
        >
          Δ{change.numeric.delta >= 0 ? '+' : ''}{formatDelta(change.numeric.delta)}
        </span>
      )}
    </td>
  );
}

function formatDelta(delta: number): string {
  const rounded = Math.round(delta * 1000) / 1000;
  return String(rounded);
}

// ---------- XLSX ----------

function XlsxBody({ result }: { result: XlsxDiffResult }) {
  // hooks 先于任何分支（result 可在 ok/失败两态间翻转，hook 顺序必须恒定）
  const [sheetIndex, setSheetIndex] = useState(0);
  if (!result.ok) {
    return <p role="status" className="text-[11px]" style={{ color: 'var(--cv-ink-meta)' }}>{result.message}</p>;
  }
  const activeSheet = Math.min(sheetIndex, Math.max(result.sheets.length - 1, 0));
  const empty = result.sheets.length === 0 && result.addedSheets.length === 0 && result.removedSheets.length === 0;
  return (
    <div className="space-y-2" data-machine-xlsx-diff="">
      {result.addedSheets.length > 0 && (
        <p className="font-mono text-[10px]" style={{ color: 'var(--cv-add)' }}>新增工作表：{result.addedSheets.join('、')}</p>
      )}
      {result.removedSheets.length > 0 && (
        <p className="font-mono text-[10px]" style={{ color: 'var(--cv-del)' }}>删除工作表：{result.removedSheets.join('、')}</p>
      )}
      {empty && <p className="text-[11px]" style={{ color: 'var(--cv-ink-meta)' }}>各工作表内容无变化。</p>}
      {result.sheets.length > 0 && (
        <>
          {result.sheets.length > 1 && (
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="变化工作表">
              {result.sheets.map((sheet, i) => (
                <button
                  key={sheet.sheetName}
                  type="button"
                  role="tab"
                  aria-selected={i === activeSheet}
                  onClick={() => setSheetIndex(i)}
                  className="rounded px-2 py-0.5 font-mono text-[10px]"
                  style={i === activeSheet
                    ? { background: 'var(--cv-card)', color: 'var(--cv-ink-3)' }
                    : { color: 'var(--cv-ink-meta)' }}
                >
                  {sheet.sheetName}
                </button>
              ))}
            </div>
          )}
          {result.sheets
            .filter((_, i) => result.sheets.length === 1 || i === activeSheet)
            .map((sheet) => (
              <div key={sheet.sheetName} className="space-y-1">
                {result.sheets.length === 1 && (
                  <p className="flex items-center gap-1 font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
                    <TableProperties size={11} /> {sheet.sheetName}
                  </p>
                )}
                {sheet.truncated && (
                  <p role="status" className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
                    该工作表内容超过解析配额或明细超限——变化计数完整，明细有诚实截断。
                  </p>
                )}
                <CsvBody result={sheet.table} />
              </div>
            ))}
        </>
      )}
    </div>
  );
}
