import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Copy,
  FileText,
  Image as ImageIcon,
  Loader2,
  Lock,
} from 'lucide-react';
import type {
  EvidencePointer,
  FileRecord,
  PdfEvidenceAnchor,
  Revision,
} from '../types/guanlan';
import type { PdfContentResponse, PdfPageExtract } from '../services/apiTypes';
import { fetchRevisionPdf } from '../services/workspaceClient';
import { copyTextWithDesktopFallback } from '../services/desktopBridge';
import { preferredScrollBehavior } from '../utils/keyboardShortcuts';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import { buildPdfHref, formatPdfAnchorLabel } from '../utils/pdfAnchor';
import { formatByteSize } from './NonLegacyFilePreviewPanel';

export interface PdfReaderViewProps {
  activeFile: FileRecord;
  currentRev: Revision;
  paperLightMode: boolean;
  indexGeneration: number;
  pdfAnchor?: PdfEvidenceAnchor | null;
  systemActions?: DesktopFileActionCallbacks;
  onAddEvidencePointer?: (pointer: EvidencePointer) => void | Promise<boolean> | boolean;
  /** 页码变化回调：供阅读器 iframe 原版视图同步 `#page=N` 跳转 */
  onActivePageChange?: (page: number) => void;
}

/** 页类型 → 展示徽标（诚实口径：image_only / extract_failed / empty 绝不冒充文本页） */
function pageKindBadge(kind: string): { label: string; cls: string } {
  switch (kind) {
    case 'text':
      return { label: '文本页', cls: 'text-[#7AA2F7] border-[#7AA2F7]/40' };
    case 'mixed':
      return { label: '图文混排', cls: 'text-[#7AA2F7] border-[#7AA2F7]/40' };
    case 'image_only':
      return { label: '纯图像页', cls: 'text-[#D99B52] border-[#D99B52]/40' };
    case 'extract_failed':
      return { label: '字符提取失败', cls: 'text-[#D99B52] border-[#D99B52]/40' };
    case 'empty':
      return { label: '空白页', cls: 'text-[#8A8A93] border-[#3A3A40]' };
    default:
      return { label: kind, cls: 'text-[#8A8A93] border-[#3A3A40]' };
  }
}

/**
 * B04 · PDF 页级正文只读结构化子视图。
 * - 1-based 精确页码导航与 `#page=N` 引用生成 / 证据入篮；
 * - 决定或 Markdown 链接传入 `pdfAnchor` 时自动跳到目标页并高亮；
 * - 扫描页（image_only）、字符提取失败页诚实标注，绝不假阳性；
 * - 加密/损坏/超配额 L0 文件诚实降级为提示卡，引导系统默认程序打开。
 */
export const PdfReaderView: React.FC<PdfReaderViewProps> = ({
  activeFile,
  currentRev,
  paperLightMode,
  indexGeneration,
  pdfAnchor,
  systemActions,
  onAddEvidencePointer,
  onActivePageChange,
}) => {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<PdfContentResponse | null>(null);
  const [activePage, setActivePage] = useState<number | null>(null);

  const [copiedPage, setCopiedPage] = useState<number | null>(null);
  const [basketAddedPage, setBasketAddedPage] = useState<number | null>(null);

  useEffect(() => {
    setErrorMsg(null);
    setPdfData(null);
    setActivePage(null);
    setCopiedPage(null);
    setBasketAddedPage(null);

    if (!currentRev.snapshotAvailable) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    fetchRevisionPdf(currentRev.revision_id, controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (res.ok) {
        setPdfData(res.data);
        setErrorMsg(null);
      } else {
        setPdfData(null);
        setErrorMsg(res.error || '未能读取 PDF 页级文本索引');
      }
    });

    return () => {
      controller.abort();
    };
  }, [currentRev.revision_id, currentRev.snapshotAvailable]);

  // 响应外部决定/Markdown 链接传入的 pdfAnchor，自动跳页并滚动高亮
  useEffect(() => {
    if (!pdfData || pdfData.status !== 'page_indexed') return;
    const target = pdfAnchor?.kind === 'pdf_page' ? pdfAnchor.page : null;
    if (!target) return;
    setActivePage(target);
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`);
      el?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pdfData, pdfAnchor]);

  const handleSelectPage = useCallback(
    (page: number) => {
      setActivePage(page);
      onActivePageChange?.(page);
    },
    [onActivePageChange]
  );

  const handleCopyPageRef = async (page: number) => {
    const mdRef = `[${activeFile.title} · 第 ${page} 页](${buildPdfHref(activeFile.relative_path, page)})`;
    await copyTextWithDesktopFallback(mdRef);
    setCopiedPage(page);
    window.setTimeout(() => setCopiedPage((prev) => (prev === page ? null : prev)), 1600);
  };

  const handleAddPageEvidence = async (page: PdfPageExtract) => {
    if (!onAddEvidencePointer) return;
    const label = formatPdfAnchorLabel({
      kind: 'pdf_page',
      page: page.page_number,
      heading: page.heading,
    });
    const ok = await onAddEvidencePointer({
      file_id: activeFile.file_id,
      revision_id: currentRev.revision_id,
      relative_path: activeFile.relative_path,
      content_sha256: currentRev.content_sha256,
      locator: { kind: 'pdf_page', page: page.page_number },
      evidence_kind: 'explicit_source',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: activeFile.coverage,
      stale: false,
      excerpt:
        page.page_kind === 'text' || page.page_kind === 'mixed'
          ? page.extracted_text.slice(0, 600)
          : page.visual_summary,
      note: `${buildPdfHref(activeFile.relative_path, page.page_number)} (${label})`,
      sizeBytes: currentRev.sizeBytes,
    });
    if (ok !== false) {
      setBasketAddedPage(page.page_number);
      window.setTimeout(
        () => setBasketAddedPage((prev) => (prev === page.page_number ? null : prev)),
        1800
      );
    }
  };

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

  const stats = useMemo(() => {
    const pages = pdfData?.pages ?? [];
    const empty = pages.filter((p) => p.page_kind === 'empty').length;
    return { total: pages.length, empty };
  }, [pdfData]);

  if (loading) {
    return (
      <div className={`rounded-xl border p-8 flex items-center justify-center gap-2 text-xs ${cardCls} ${mutedCls}`}>
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>正在加载 PDF 页级文本索引…</span>
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

  // 未存快照或整档降级（image_only / ocr_pending / extract_failed / encrypted / corrupted /
  // metadata_only）→ 诚实降级卡，绝不拿空白文本冒充正文
  if (!currentRev.snapshotAvailable || !pdfData || pdfData.status !== 'page_indexed') {
    const status = !currentRev.snapshotAvailable
      ? 'metadata_only'
      : pdfData?.status ?? 'metadata_only';
    const isScanned = status === 'image_only' || status === 'ocr_pending';
    const isEncrypted = status === 'encrypted';
    const title = isScanned
      ? '纯图像版 PDF（未做文本抽取）'
      : isEncrypted
        ? 'PDF 已加密受保护（降级为 L0 元数据卡）'
        : status === 'corrupted'
          ? 'PDF 容器损坏或非有效文档（降级为 L0 元数据卡）'
          : status === 'extract_failed'
            ? '文本层字符提取失败（字体缺少 ToUnicode 映射）'
            : '该 PDF 版本仅保留 L0 元数据（未加载页级正文）';
    const reason =
      pdfData?.error_reason ||
      (isScanned
        ? '扫描版 PDF 明确提示「纯图像页，未做文本抽取」；可切换原版版式查看，或等待 OCR 能力接入。'
        : '观澜绝不崩溃索引线程；如需查看完整版式，请点击「用系统默认程序打开」。');
    return (
      <div className={`rounded-xl border p-5 space-y-3 ${cardCls}`}>
        <div className="flex items-start gap-3">
          {isEncrypted ? (
            <Lock className="w-5 h-5 text-[#D99B52] shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-[#D99B52] shrink-0 mt-0.5" />
          )}
          <div className="space-y-1 flex-1 min-w-0">
            <div className="text-xs font-semibold">{title}</div>
            <p className={`text-xs leading-relaxed ${mutedCls}`}>{reason}</p>
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

  const pages = pdfData.pages;
  const shown = activePage
    ? pages.find((p) => p.page_number === activePage) ?? pages[0]
    : pages[0];

  return (
    <div className={`rounded-xl border overflow-hidden ${cardCls}`} data-pdf-structured-view="true">
      {/* 摘要头：页统计 + 当前锚点 */}
      <div className={`px-4 py-3 border-b flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] ${headerBarCls}`}>
        <span className="font-semibold text-xs">
          PDF 页级文本 · 共 {pdfData.page_count} 页
        </span>
        <span className={mutedCls}>文本/混排 {pdfData.text_page_count}</span>
        <span className={mutedCls}>纯图像 {pdfData.image_only_page_count}</span>
        {pdfData.extract_failed_page_count > 0 && (
          <span className="text-[#D99B52]">提取失败 {pdfData.extract_failed_page_count}</span>
        )}
        {stats.empty > 0 && <span className={mutedCls}>空白 {stats.empty}</span>}
        {pdfAnchor?.kind === 'pdf_page' && (
          <span className="px-2 py-0.5 rounded-full border text-[10px] text-[#7AA2F7] border-[#7AA2F7]/40">
            已定位 · {formatPdfAnchorLabel(pdfAnchor)}
          </span>
        )}
      </div>

      {/* 页码导航条 */}
      <div className="px-4 py-2 border-b flex flex-wrap gap-1.5" data-pdf-page-nav="true">
        {pages.map((p) => {
          const badge = pageKindBadge(p.page_kind);
          const isActive = shown?.page_number === p.page_number;
          return (
            <button
              key={p.page_number}
              type="button"
              onClick={() => handleSelectPage(p.page_number)}
              title={`${badge.label} · ${p.visual_summary}`}
              className={`px-2 py-1 rounded-lg border text-[11px] font-mono tabular-nums cursor-pointer transition-colors ${
                isActive
                  ? 'border-[color:var(--accent-iris)] text-[color:var(--accent-iris)]'
                  : `${chipBgCls} ${mutedCls} hover:border-[color:var(--accent-iris)]`
              }`}
            >
              {p.page_number}
            </button>
          );
        })}
      </div>

      {/* 当前页正文 */}
      {shown && (
        <div className="p-4 space-y-2" data-pdf-page={shown.page_number}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold">
              第 {shown.page_number} 页{shown.heading ? ` · ${shown.heading}` : ''}
            </span>
            {(() => {
              const badge = pageKindBadge(shown.page_kind);
              return (
                <span className={`px-2 py-0.5 rounded-full border text-[10px] ${badge.cls}`}>
                  {badge.label}
                </span>
              );
            })()}
            <span className={`flex-1 text-[11px] truncate ${mutedCls}`}>{shown.visual_summary}</span>
            <button
              type="button"
              onClick={() => handleCopyPageRef(shown.page_number)}
              title={`复制 Markdown 引用 ${activeFile.relative_path}#page=${shown.page_number}`}
              className={`shrink-0 px-2 py-1 rounded-lg border text-[11px] cursor-pointer transition-colors hover:border-[color:var(--accent-iris)] ${chipBgCls} ${mutedCls}`}
            >
              {copiedPage === shown.page_number ? (
                <span className="flex items-center gap-1 text-[#7AA2F7]">
                  <Check className="w-3 h-3" /> 已复制
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <ClipboardCopy className="w-3 h-3" /> 复制 #page
                </span>
              )}
            </button>
            {onAddEvidencePointer && (
              <button
                type="button"
                onClick={() => handleAddPageEvidence(shown)}
                className={`shrink-0 px-2 py-1 rounded-lg border text-[11px] cursor-pointer transition-colors hover:border-[color:var(--accent-iris)] ${chipBgCls} ${mutedCls}`}
              >
                {basketAddedPage === shown.page_number ? (
                  <span className="flex items-center gap-1 text-[#7AA2F7]">
                    <Check className="w-3 h-3" /> 已入篮
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Copy className="w-3 h-3" /> 证据入篮
                  </span>
                )}
              </button>
            )}
          </div>

          {shown.page_kind === 'image_only' || shown.page_kind === 'empty' || shown.page_kind === 'extract_failed' ? (
            <div className={`rounded-lg border border-dashed p-4 text-xs leading-relaxed ${mutedCls}`}>
              <div className="flex items-center gap-2 mb-1">
                {shown.page_kind === 'image_only' ? (
                  <ImageIcon className="w-4 h-4 text-[#D99B52]" />
                ) : (
                  <FileText className="w-4 h-4 text-[#D99B52]" />
                )}
                <span className="font-medium">
                  {shown.page_kind === 'image_only'
                    ? '纯图像页，未做文本抽取'
                    : shown.page_kind === 'extract_failed'
                      ? '字符提取失败（该页字体缺少 ToUnicode 映射，中文提取失败不判定为扫描件）'
                      : '空白页（无文字与图像）'}
                </span>
              </div>
              <p>{shown.visual_summary}</p>
            </div>
          ) : (
            <pre
              className={`whitespace-pre-wrap break-words rounded-lg p-3 text-xs leading-relaxed font-sans ${
                paperLightMode ? 'bg-[#FAF9F5]' : 'bg-[#161619]'
              }`}
            >
              {shown.extracted_text || shown.visual_summary}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
