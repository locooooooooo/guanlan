import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Copy,
  FileSpreadsheet,
  FileText,
  Hash,
  Loader2,
  Lock,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import type {
  EvidencePointer,
  FileRecord,
  OfficeEvidenceAnchor,
  Revision,
} from '../types/guanlan';
import type {
  DocxComment,
  OfficeContentResponse,
  XlsxNumericColSummary,
  XlsxSheetData,
} from '../services/apiTypes';
import { fetchRevisionOffice } from '../services/workspaceClient';
import { copyTextWithDesktopFallback } from '../services/desktopBridge';
import { preferredScrollBehavior } from '../utils/keyboardShortcuts';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import {
  buildCellRangeFromCoords,
  colIdxToLetters,
  formatOfficeAnchorLabel,
  isCellInRange,
  parseCellRef,
  parseXlsxRangeBounds,
} from '../utils/officeAnchor';
import { formatByteSize } from './NonLegacyFilePreviewPanel';

export interface OfficeReaderViewProps {
  activeFile: FileRecord;
  currentRev: Revision;
  paperLightMode: boolean;
  indexGeneration: number;
  officeAnchor?: OfficeEvidenceAnchor | null;
  systemActions?: DesktopFileActionCallbacks;
  onAddEvidencePointer?: (pointer: EvidencePointer) => void | Promise<boolean> | boolean;
}

/** 按工作表名或索引解析要激活的 Sheet */
function resolveInitialSheetIdx(
  sheets: XlsxSheetData[],
  anchor?: OfficeEvidenceAnchor | null
): number {
  if (sheets.length === 0) return 0;
  if (anchor?.kind === 'xlsx_range' && anchor.sheet) {
    const targetLower = anchor.sheet.trim().toLowerCase();
    const matched = sheets.findIndex((s) => s.name.trim().toLowerCase() === targetLower);
    if (matched >= 0) return matched;
  }
  return 0;
}

/**
 * B03 · Office（`.docx` / `.xlsx`）独立只读结构化阅读子视图。
 * - `.docx`：大纲导航、1-based 段落序号（`¶ N`）、内嵌批注、修订增删摘要、段级跳转高亮与证据引用生成；
 * - `.xlsx`：Sheet 标签切换、数值列汇总卡片（min/max/sum + cell_range）、表格网格只读浏览、
 *   单元格/矩形选区交互与 `Sheet!CellRange` 一键锚定与高亮跳转；
 * - 损坏、加密或超配额大文件诚实降级为 L0 提示卡，引导调用系统默认程序查看。
 */
export const OfficeReaderView: React.FC<OfficeReaderViewProps> = ({
  activeFile,
  currentRev,
  paperLightMode,
  indexGeneration,
  officeAnchor,
  systemActions,
  onAddEvidencePointer,
}) => {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [officeData, setOfficeData] = useState<OfficeContentResponse | null>(null);

  // .docx 交互态
  const [activePara, setActivePara] = useState<number | null>(null);
  const [showTrackedSamples, setShowTrackedSamples] = useState(false);

  // .xlsx 交互态
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [selectedRange, setSelectedRange] = useState<string>('');
  const [anchorCell, setAnchorCell] = useState<{ col: number; row: number } | null>(null);

  // 反馈提示
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [basketAddedId, setBasketAddedId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setErrorMsg(null);
    setOfficeData(null);
    setShowTrackedSamples(false);
    setCopiedId(null);
    setBasketAddedId(null);

    if (!currentRev.snapshotAvailable) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    fetchRevisionOffice(currentRev.revision_id, controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (res.ok) {
        setOfficeData(res.data);
        setErrorMsg(null);
      } else {
        setOfficeData(null);
        setErrorMsg(res.error || '未能读取 Office 结构化索引');
      }
    });

    return () => {
      controller.abort();
    };
  }, [currentRev.revision_id, currentRev.snapshotAvailable]);

  // 响应外部决定/Markdown 链接传入的 officeAnchor，自动切 Sheet / 选区 / 滚动高亮
  useEffect(() => {
    if (!officeData || officeData.status !== 'indexed') return;

    if (officeData.docx) {
      const targetPara =
        officeAnchor?.kind === 'docx_paragraph' ? officeAnchor.paragraph ?? null : null;
      setActivePara(targetPara);
      if (targetPara) {
        const timer = window.setTimeout(() => {
          const el = containerRef.current?.querySelector<HTMLElement>(
            `[data-office-para="${targetPara}"]`
          );
          el?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' });
        }, 60);
        return () => window.clearTimeout(timer);
      }
    }

    if (officeData.xlsx) {
      const sheets = officeData.xlsx.sheets;
      const nextIdx = resolveInitialSheetIdx(sheets, officeAnchor);
      setActiveSheetIdx(nextIdx);

      const targetSheet = sheets[nextIdx];
      const nextRange =
        officeAnchor?.kind === 'xlsx_range' && officeAnchor.cellRange
          ? officeAnchor.cellRange
          : targetSheet?.numeric_summaries[0]?.cell_range ?? '';
      setSelectedRange(nextRange);

      if (nextRange && officeAnchor?.kind === 'xlsx_range') {
        const bounds = parseXlsxRangeBounds(nextRange);
        if (bounds) {
          const firstRef = `${colIdxToLetters(bounds.startCol)}${bounds.startRow}`;
          const timer = window.setTimeout(() => {
            const cellEl =
              containerRef.current?.querySelector<HTMLElement>(
                `[data-xlsx-cell="${firstRef}"]`
              ) ??
              containerRef.current?.querySelector<HTMLElement>('[data-xlsx-highlighted="true"]');
            cellEl?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center', inline: 'center' });
          }, 80);
          return () => window.clearTimeout(timer);
        }
      }
    }
    return undefined;
  }, [officeData, officeAnchor]);

  const cardCls = paperLightMode
    ? 'bg-white border-[#E5E3DD] text-[#26243D]'
    : 'bg-[#1D1D20] border-[#2C2C30] text-[#E6E5E0]';
  const mutedCls = paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]';
  const chipBgCls = paperLightMode
    ? 'bg-[#F5F4EF] border-[#E5E3DD]'
    : 'bg-[#252529] border-[#343439]';
  const headerBarCls = paperLightMode
    ? 'border-[#ECEAE4] bg-[#FAF9F5]'
    : 'border-[#2C2C30] bg-[#18181B]';

  const markCopied = useCallback((id: string) => {
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1600);
  }, []);

  const markBasketAdded = useCallback((id: string) => {
    setBasketAddedId(id);
    window.setTimeout(() => setBasketAddedId((prev) => (prev === id ? null : prev)), 1800);
  }, []);

  const activeSheet: XlsxSheetData | null = useMemo(() => {
    const sheets = officeData?.xlsx?.sheets ?? [];
    if (sheets.length === 0) return null;
    return sheets[activeSheetIdx] ?? sheets[0];
  }, [officeData, activeSheetIdx]);

  const activeBounds = useMemo(() => parseXlsxRangeBounds(selectedRange), [selectedRange]);

  const activeRangeExcerpt = useMemo(() => {
    if (!activeSheet || !activeBounds) return '';
    const lines: string[] = [];
    for (const row of activeSheet.rows) {
      if (row.row_num < activeBounds.startRow || row.row_num > activeBounds.endRow) continue;
      const cells = row.cells
        .filter((c) => c.col_idx >= activeBounds.startCol && c.col_idx <= activeBounds.endCol)
        .map((c) => `${c.ref_id}=${c.value}`);
      if (cells.length > 0) {
        lines.push(cells.join(' | '));
      }
      if (lines.length >= 12) break;
    }
    return lines.join('\n');
  }, [activeSheet, activeBounds]);

  const handleCopyDocxRef = async (paraIndex: number) => {
    const mdRef = `[${activeFile.title} · 第 ${paraIndex} 段](${activeFile.relative_path}#para=${paraIndex})`;
    await copyTextWithDesktopFallback(mdRef);
    markCopied(`para-${paraIndex}`);
  };

  const handleAddDocxEvidence = async (paraIndex: number, text: string, headingText?: string) => {
    if (!onAddEvidencePointer) return;
    const label = headingText ? `${headingText} · 第 ${paraIndex} 段` : `第 ${paraIndex} 段`;
    const ok = await onAddEvidencePointer({
      file_id: activeFile.file_id,
      revision_id: currentRev.revision_id,
      relative_path: activeFile.relative_path,
      content_sha256: currentRev.content_sha256,
      locator: {
        kind: 'lines',
        start: paraIndex,
        end: paraIndex,
      },
      evidence_kind: 'explicit_source',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: activeFile.coverage,
      stale: false,
      excerpt: text.slice(0, 600),
      note: `${activeFile.relative_path}#para=${paraIndex} (${label})`,
      sizeBytes: currentRev.sizeBytes,
    });
    if (ok !== false) markBasketAdded(`para-${paraIndex}`);
  };

  const handleCopyXlsxRef = async (sheetName: string, cellRange: string) => {
    const mdRef = `[${activeFile.title} · ${sheetName}!${cellRange}](${activeFile.relative_path}#${sheetName}!${cellRange})`;
    await copyTextWithDesktopFallback(mdRef);
    markCopied(`${sheetName}!${cellRange}`);
  };

  const handleAddXlsxEvidence = async (
    sheetName: string,
    cellRange: string,
    summaryNote?: string
  ) => {
    if (!onAddEvidencePointer) return;
    const bounds = parseXlsxRangeBounds(cellRange);
    const excerpt =
      summaryNote ||
      activeRangeExcerpt ||
      `${sheetName}!${cellRange}（${activeFile.relative_path}）`;
    const ok = await onAddEvidencePointer({
      file_id: activeFile.file_id,
      revision_id: currentRev.revision_id,
      relative_path: activeFile.relative_path,
      content_sha256: currentRev.content_sha256,
      locator: {
        kind: 'lines',
        start: bounds?.startRow ?? 1,
        end: bounds?.endRow ?? 1,
      },
      evidence_kind: 'explicit_source',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: activeFile.coverage,
      stale: false,
      excerpt: excerpt.slice(0, 600),
      note: `${activeFile.relative_path}#${sheetName}!${cellRange}`,
      sizeBytes: currentRev.sizeBytes,
    });
    if (ok !== false) markBasketAdded(`${sheetName}!${cellRange}`);
  };

  if (loading) {
    return (
      <div className={`rounded-xl border p-8 flex items-center justify-center gap-2 text-xs ${cardCls} ${mutedCls}`}>
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>正在加载 Office 结构化索引视图…</span>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div className={`rounded-xl border p-5 flex items-center gap-3 text-xs ${cardCls}`}>
        <AlertTriangle className="w-4 h-4 text-[#D99B52] shrink-0" />
        <span className={mutedCls}>{errorMsg}</span>
      </div>
    );
  }

  // 未存快照或解析降级（encrypted / corrupted / metadata_only）→ 诚实 L0 元数据降级卡
  if (!currentRev.snapshotAvailable || !officeData || officeData.status !== 'indexed') {
    const status = !currentRev.snapshotAvailable
      ? 'metadata_only'
      : officeData?.status ?? 'metadata_only';
    const isEncrypted = status === 'encrypted';
    const isCorrupted = status === 'corrupted';
    return (
      <div className={`rounded-xl border p-5 space-y-3 ${cardCls}`}>
        <div className="flex items-start gap-3">
          {isEncrypted ? (
            <Lock className="w-5 h-5 text-[#D99B52] shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-[#D99B52] shrink-0 mt-0.5" />
          )}
          <div className="space-y-1 flex-1 min-w-0">
            <div className="text-xs font-semibold">
              {isEncrypted
                ? '文档已加密受保护（降级为 L0 元数据卡）'
                : isCorrupted
                  ? 'Office 文档容器损坏或非有效 OOXML（降级为 L0 元数据卡）'
                  : '该 Office 版本仅保留 L0 元数据（未加载结构化正文）'}
            </div>
            <p className={`text-xs leading-relaxed ${mutedCls}`}>
              {officeData?.error_reason ||
                '观澜绝不跳过加密验证或崩溃索引线程；如需查看完整版式，请点击上方「默认应用打开」。'}
            </p>
            <div className={`text-[11px] font-mono tabular-nums pt-1 ${mutedCls}`}>
              体积 {formatByteSize(currentRev.sizeBytes)} · SHA-256 {currentRev.content_sha256.slice(0, 16)}…
            </div>
          </div>
          {systemActions?.onOpenWithDefaultApp && (
            <button
              type="button"
              onClick={() => systemActions.onOpenWithDefaultApp?.(activeFile.relative_path)}
              className={`shrink-0 px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-colors hover:border-[color:var(--accent-iris)] ${chipBgCls}`}
            >
              用系统默认程序打开
            </button>
          )}
        </div>
      </div>
    );
  }

  // ==================== 1. Word (.docx) L2 结构化阅读 ====================
  if (officeData.docx) {
    const docx = officeData.docx;
    const commentsByPara = new Map<number, DocxComment[]>();
    const unanchoredComments: DocxComment[] = [];
    for (const c of docx.comments) {
      if (typeof c.para_index === 'number' && c.para_index > 0) {
        const list = commentsByPara.get(c.para_index) ?? [];
        list.push(c);
        commentsByPara.set(c.para_index, list);
      } else {
        unanchoredComments.push(c);
      }
    }

    return (
      <div ref={containerRef} className="space-y-4">
        {/* 顶栏结构摘要与外部锚点提示 */}
        <div className={`rounded-xl border p-4 space-y-3 ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <FileText className="w-4 h-4 text-[color:var(--accent-iris)]" />
              <span className={`font-mono text-[11px] tabular-nums ${mutedCls}`}>
                {docx.headings.length} 标题 · {docx.total_paragraphs} 段落
                {docx.comments.length > 0 ? ` · ${docx.comments.length} 批注` : ''}
              </span>
              {(docx.tracked_changes.insertions > 0 || docx.tracked_changes.deletions > 0) && (
                <button
                  type="button"
                  onClick={() => setShowTrackedSamples((v) => !v)}
                  className={`px-2 py-0.5 rounded-md border font-mono text-[11px] tabular-nums cursor-pointer ${chipBgCls}`}
                  title="查看 Word 修订增删摘要"
                >
                  修订 +{docx.tracked_changes.insertions} / -{docx.tracked_changes.deletions}
                </button>
              )}
            </div>
            {officeAnchor?.kind === 'docx_paragraph' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] px-2.5 py-0.5 text-[11px] font-mono font-medium text-[color:var(--accent-iris-ink)]">
                <Sparkles className="w-3 h-3" />
                <span>已锚定：{formatOfficeAnchorLabel(officeAnchor)}</span>
              </span>
            )}
          </div>

          {showTrackedSamples && docx.tracked_changes.samples.length > 0 && (
            <div className={`rounded-lg border p-3 space-y-1 text-xs font-mono ${chipBgCls}`}>
              <div className={`text-[11px] font-sans font-medium ${mutedCls}`}>修订样本</div>
              {docx.tracked_changes.samples.map((s, idx) => (
                <div key={idx} className="truncate">
                  {s}
                </div>
              ))}
            </div>
          )}

          {docx.headings.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className={`text-[11px] mr-1 ${mutedCls}`}>大纲导航:</span>
              {docx.headings.map((h) => (
                <button
                  key={`${h.para_index}-${h.text}`}
                  type="button"
                  onClick={() => {
                    setActivePara(h.para_index);
                    const el = containerRef.current?.querySelector<HTMLElement>(
                      `[data-office-para="${h.para_index}"]`
                    );
                    el?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' });
                  }}
                  className={`px-2 py-0.5 rounded-md border text-[11px] cursor-pointer transition-colors hover:border-[color:var(--accent-iris)] ${
                    activePara === h.para_index
                      ? 'border-[color:var(--accent-iris)] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] font-semibold'
                      : chipBgCls
                  }`}
                >
                  H{h.level} · {h.text}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 段落正文（带 1-based ¶ 序号与证据锚点生成） */}
        <div className={`rounded-xl border divide-y ${cardCls} ${paperLightMode ? 'divide-[#ECEAE4]' : 'divide-[#2C2C30]'}`}>
          {docx.paragraphs.length === 0 ? (
            <div className={`p-8 text-center text-xs ${mutedCls}`}>该 Word 文档未抽取到可读文本段落</div>
          ) : (
            docx.paragraphs.map((p) => {
              const isHighlighted = activePara === p.para_index;
              const attachedComments = commentsByPara.get(p.para_index) ?? [];
              const paraKey = `para-${p.para_index}`;
              return (
                <div
                  key={p.para_index}
                  data-office-para={p.para_index}
                  onClick={() => setActivePara(p.para_index)}
                  className={`group px-4 py-3 transition-colors ${
                    isHighlighted
                      ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] ring-2 ring-inset ring-[color:var(--accent-iris)]'
                      : paperLightMode
                        ? 'hover:bg-[#FAF9F5]'
                        : 'hover:bg-[#232327]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`shrink-0 w-10 pt-0.5 text-right font-mono text-[11px] tabular-nums select-none ${mutedCls}`}>
                      ¶{p.para_index}
                    </span>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div
                          className={`min-w-0 break-words leading-relaxed ${
                            p.heading_level === 1
                              ? 'text-base font-bold'
                              : p.heading_level === 2
                                ? 'text-sm font-semibold'
                                : p.heading_level
                                  ? 'text-xs font-semibold'
                                  : 'text-[13px]'
                          }`}
                        >
                          {p.is_table_row && (
                            <span className={`inline-block mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono border align-middle ${chipBgCls}`}>
                              表格行
                            </span>
                          )}
                          <span>{p.text}</span>
                        </div>
                        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleCopyDocxRef(p.para_index);
                            }}
                            title={`复制 Markdown 锚点引用 (${activeFile.relative_path}#para=${p.para_index})`}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] cursor-pointer ${chipBgCls}`}
                          >
                            {copiedId === paraKey ? (
                              <Check className="w-3 h-3 text-[#226B42]" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            <span>{copiedId === paraKey ? '已复制' : `#para=${p.para_index}`}</span>
                          </button>
                          {onAddEvidencePointer && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleAddDocxEvidence(p.para_index, p.text);
                              }}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] cursor-pointer ${chipBgCls}`}
                            >
                              <ClipboardCopy className="w-3 h-3" />
                              <span>{basketAddedId === paraKey ? '已入篮' : '引用此段'}</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {attachedComments.map((c) => (
                        <div
                          key={c.id}
                          className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] ${chipBgCls}`}
                        >
                          <MessageSquare className="w-3.5 h-3.5 text-[#D99B52] shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <span className="font-semibold">{c.author || '审阅批注'}</span>
                            {c.date && <span className={`ml-1.5 font-mono text-[10.5px] ${mutedCls}`}>{c.date.slice(0, 10)}</span>}
                            <div className="mt-0.5 break-words">{c.text}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          {docx.truncated && (
            <div className={`px-4 py-2.5 text-[11px] ${mutedCls}`}>
              文档共有 {docx.total_paragraphs} 段，当前结构化预览展示前 {docx.paragraphs.length} 段。
            </div>
          )}
        </div>

        {unanchoredComments.length > 0 && (
          <div className={`rounded-xl border p-4 space-y-2 ${cardCls}`}>
            <div className="text-xs font-semibold flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-[#D99B52]" />
              <span>文档级批注 ({unanchoredComments.length})</span>
            </div>
            <div className="space-y-1.5">
              {unanchoredComments.map((c) => (
                <div key={c.id} className={`rounded-lg border px-3 py-2 text-xs ${chipBgCls}`}>
                  <span className="font-semibold">{c.author || '审阅者'}</span>
                  {c.date && <span className={`ml-2 font-mono text-[11px] ${mutedCls}`}>{c.date.slice(0, 10)}</span>}
                  <p className="mt-1">{c.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==================== 2. Excel (.xlsx) L2 结构化阅读 ====================
  if (officeData.xlsx && activeSheet) {
    const sheets = officeData.xlsx.sheets;
    const maxCols = Math.max(
      activeSheet.col_count,
      activeSheet.headers.length,
      ...activeSheet.rows.map((r) => r.cells.reduce((m, c) => Math.max(m, c.col_idx), 0)),
      1
    );
    const activeTargetLabel = selectedRange ? `${activeSheet.name}!${selectedRange}` : '';

    const handleCellClick = (colIdx: number, rowNum: number, shiftKey: boolean) => {
      const clicked = { col: colIdx, row: rowNum };
      if (shiftKey && anchorCell) {
        setSelectedRange(buildCellRangeFromCoords(anchorCell, clicked));
      } else {
        setAnchorCell(clicked);
        setSelectedRange(buildCellRangeFromCoords(clicked));
      }
    };

    const handleSelectSummary = (summary: XlsxNumericColSummary) => {
      setSelectedRange(summary.cell_range);
      const bounds = parseXlsxRangeBounds(summary.cell_range);
      if (bounds) {
        const firstRef = `${colIdxToLetters(bounds.startCol)}${bounds.startRow}`;
        containerRef.current
          ?.querySelector<HTMLElement>(`[data-xlsx-cell="${firstRef}"]`)
          ?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center', inline: 'center' });
      }
    };

    return (
      <div ref={containerRef} className="space-y-4">
        {/* 工作表标签栏 + 当前选中区域引用生成条 */}
        <div className={`rounded-xl border p-4 space-y-3 ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <FileSpreadsheet className="w-4 h-4 text-[#2E8B57] mr-1" />
              {sheets.map((sheet, idx) => (
                <button
                  key={`${sheet.index}-${sheet.name}`}
                  type="button"
                  onClick={() => {
                    setActiveSheetIdx(idx);
                    setAnchorCell(null);
                    setSelectedRange(sheet.numeric_summaries[0]?.cell_range ?? '');
                  }}
                  className={`px-2.5 py-1 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                    idx === activeSheetIdx
                      ? 'border-[color:var(--accent-iris)] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-ink)] font-semibold'
                      : chipBgCls
                  }`}
                >
                  <span>{sheet.name}</span>
                  <span className={`ml-1.5 font-mono text-[10.5px] tabular-nums ${mutedCls}`}>
                    {sheet.row_count}×{sheet.col_count}
                  </span>
                </button>
              ))}
            </div>

            {officeAnchor?.kind === 'xlsx_range' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] px-2.5 py-0.5 text-[11px] font-mono font-medium text-[color:var(--accent-iris-ink)]">
                <Sparkles className="w-3 h-3" />
                <span>已定位：{formatOfficeAnchorLabel(officeAnchor)}</span>
              </span>
            )}
          </div>

          {/* 选中区域操作条（单机选格，Shift+点击选矩形区域） */}
          <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${chipBgCls}`}>
            <div className="flex items-center gap-2 min-w-0">
              <Hash className="w-3.5 h-3.5 text-[color:var(--accent-iris)] shrink-0" />
              <span className="font-mono font-semibold truncate">
                {activeTargetLabel || `${activeSheet.name}（点击单元格或 Shift+点击生成区间引用）`}
              </span>
              {activeSheet.dimension_ref && (
                <span className={`font-mono text-[11px] ${mutedCls}`}>
                  维度 {activeSheet.dimension_ref}
                </span>
              )}
            </div>
            {selectedRange && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleCopyXlsxRef(activeSheet.name, selectedRange)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer transition-colors hover:border-[color:var(--accent-iris)] ${cardCls}`}
                >
                  {copiedId === activeTargetLabel ? (
                    <Check className="w-3 h-3 text-[#226B42]" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>
                    {copiedId === activeTargetLabel
                      ? '已复制锚点链接'
                      : `复制 #${activeTargetLabel}`}
                  </span>
                </button>
                {onAddEvidencePointer && (
                  <button
                    type="button"
                    onClick={() => void handleAddXlsxEvidence(activeSheet.name, selectedRange)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer transition-colors hover:border-[color:var(--accent-iris)] ${cardCls}`}
                  >
                    <ClipboardCopy className="w-3 h-3" />
                    <span>{basketAddedId === activeTargetLabel ? '已入证据篮' : '引用此区入篮'}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 数值列关键摘要卡片 */}
          {activeSheet.numeric_summaries.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1">
              {activeSheet.numeric_summaries.map((sum) => {
                const isActive = selectedRange === sum.cell_range;
                return (
                  <div
                    key={`${sum.col_letter}-${sum.cell_range}`}
                    onClick={() => handleSelectSummary(sum)}
                    className={`rounded-lg border p-2.5 text-xs cursor-pointer transition-colors ${
                      isActive
                        ? 'border-[color:var(--accent-iris)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)]'
                        : `${chipBgCls} hover:border-[color:var(--accent-iris)]`
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold truncate">
                        {sum.header} ({sum.col_letter})
                      </span>
                      <span className="font-mono text-[11px] text-[color:var(--accent-iris-ink)] shrink-0">
                        {sum.cell_range}
                      </span>
                    </div>
                    <div className={`mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums ${mutedCls}`}>
                      <span>计数 {sum.count}</span>
                      <span>min {sum.min}</span>
                      <span>max {sum.max}</span>
                      <span>sum {Number(sum.sum.toFixed(4))}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 只读表格网格 */}
        <div className={`rounded-xl border overflow-hidden ${cardCls}`}>
          <div className={`flex items-center justify-between px-4 py-2 border-b text-xs ${headerBarCls}`}>
            <span className="font-medium">
              工作表「{activeSheet.name}」只读浏览（单击选中单元格，Shift+单击选连续区域）
            </span>
            <span className={`font-mono text-[11px] tabular-nums ${mutedCls}`}>
              {activeSheet.rows.length} / {activeSheet.row_count} 行 · {maxCols} 列
            </span>
          </div>
          <div className="overflow-auto max-h-[62vh]">
            {activeSheet.rows.length === 0 ? (
              <div className={`p-8 text-center text-xs ${mutedCls}`}>当前工作表为空</div>
            ) : (
              <table className="w-full border-collapse text-left text-xs">
                <thead className={`sticky top-0 z-10 ${headerBarCls}`}>
                  <tr>
                    <th className={`w-12 px-2.5 py-2 text-right font-mono text-[11px] border-b border-r tabular-nums ${mutedCls} ${paperLightMode ? 'border-[#ECEAE4]' : 'border-[#2C2C30]'}`}>
                      #
                    </th>
                    {Array.from({ length: maxCols }).map((_, i) => {
                      const colNum = i + 1;
                      const letter = colIdxToLetters(colNum);
                      return (
                        <th
                          key={letter}
                          className={`px-3 py-2 font-mono text-[11px] font-semibold whitespace-nowrap border-b border-r ${paperLightMode ? 'border-[#ECEAE4]' : 'border-[#2C2C30]'}`}
                        >
                          {letter}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {activeSheet.rows.map((row) => {
                    const cellMap = new Map(row.cells.map((c) => [c.col_idx, c]));
                    return (
                      <tr
                        key={row.row_num}
                        className={paperLightMode ? 'hover:bg-[#FAF9F5]' : 'hover:bg-[#232327]'}
                      >
                        <td className={`px-2.5 py-1.5 text-right font-mono text-[11px] border-b border-r tabular-nums select-none ${mutedCls} ${paperLightMode ? 'border-[#ECEAE4] bg-[#FAF9F5]' : 'border-[#2C2C30] bg-[#18181B]'}`}>
                          {row.row_num}
                        </td>
                        {Array.from({ length: maxCols }).map((_, i) => {
                          const colNum = i + 1;
                          const cell = cellMap.get(colNum);
                          const refId = cell?.ref_id || `${colIdxToLetters(colNum)}${row.row_num}`;
                          const coords = parseCellRef(refId) ?? { col: colNum, row: row.row_num };
                          const highlighted = isCellInRange(coords.col, coords.row, activeBounds);
                          return (
                            <td
                              key={refId}
                              data-xlsx-cell={refId}
                              data-xlsx-highlighted={highlighted ? 'true' : undefined}
                              onClick={(e) => handleCellClick(coords.col, coords.row, e.shiftKey)}
                              title={cell?.formula ? `${refId} · 公式: =${cell.formula}` : refId}
                              className={`px-3 py-1.5 border-b border-r whitespace-nowrap cursor-pointer transition-colors ${
                                paperLightMode ? 'border-[#ECEAE4]' : 'border-[#2C2C30]'
                              } ${
                                cell?.is_numeric ? 'text-right font-mono tabular-nums' : ''
                              } ${
                                highlighted
                                  ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_16%,transparent)] ring-2 ring-inset ring-[color:var(--accent-iris)] font-medium'
                                  : ''
                              }`}
                            >
                              <div className="inline-flex items-center gap-1.5 max-w-[320px] truncate">
                                <span className="truncate">{cell?.value ?? ''}</span>
                                {cell?.formula && (
                                  <span className={`px-1 rounded text-[9.5px] font-mono border ${chipBgCls}`}>
                                    fx
                                  </span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {activeSheet.truncated && (
            <div className={`px-4 py-2 border-t text-[11px] ${mutedCls} ${paperLightMode ? 'border-[#ECEAE4]' : 'border-[#2C2C30]'}`}>
              工作表共 {activeSheet.row_count} 行，结构化阅读已展示前 {activeSheet.rows.length} 行。
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
};
