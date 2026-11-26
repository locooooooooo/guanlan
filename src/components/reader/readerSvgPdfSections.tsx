
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Maximize2,
  Minimize2,
  PlusCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button, IconButton } from '../ui/primitives';
import { sanitizeSvgForPreview } from '../../utils/guanlanEngine';
import { revisionRawUrl } from '../../services/workspaceClient';
import { NonLegacyFilePreviewPanel } from '../NonLegacyFilePreviewPanel';
import { PdfReaderView } from '../PdfReaderView';
import {
  PdfPageAnnotations,
  SvgAnnotationOverlay,
} from './readerAnchorLayer';
import type { ReaderCtx } from './useReaderController';

/** SVG 安全预览分节（受限图片方式加载，支持缩放、提取文字检索与框选批注） */
export function ReaderSvgSection({ ctx }: { ctx: ReaderCtx }) {
  const {
    paperLightMode,
    svgFullWidth,
    currentRev,
    svgZoom,
    setSvgZoom,
    svgTextsExpanded,
    setSvgTextsExpanded,
    showSvgSourceDiff,
    setShowSvgSourceDiff,
    setSvgFullWidth,
    activeFile,
    onAddEvidencePointer,
    indexGeneration,
    svgAnnotations,
    svgAnnotateMode,
    setSvgAnnotateMode,
    annotateFromSvgRegion,
    flashAnnotationId,
  } = ctx;
  const extractedTexts = currentRev.svgExtractedTexts ?? [];
  return (
    <div
      className={`flex-1 overflow-y-auto px-4 py-3 space-y-2.5 ${
        paperLightMode
          ? 'bg-[#FAF9F5] text-[#1F1E1D]'
          : 'bg-[#1A1917] text-[#F4F3EE]'
      }`}
    >
      <div
        className={`${
          svgFullWidth ? 'max-w-full' : 'max-w-[var(--measure-read)]'
        } mx-auto space-y-2.5`}
      >
        <div
          data-svg-toolbar=""
          className="flex flex-wrap items-center justify-end gap-1.5 text-xs tabular-nums"
        >
          <div className="inline-flex items-center gap-0.5">
            <IconButton
              label="缩小 SVG"
              onClick={() => setSvgZoom((z) => Math.max(50, z - 25))}
            >
              <ZoomOut />
            </IconButton>
            <button
              type="button"
              onClick={() => setSvgZoom(100)}
              title={svgZoom === 100 ? '当前 100% 原尺寸' : '点击恢复 100% 原尺寸'}
              className={`min-w-[44px] h-7 px-1.5 rounded-md text-xs font-mono text-center cursor-pointer transition-colors ${
                paperLightMode
                  ? 'text-[#1F1E1D] hover:bg-black/[0.05]'
                  : 'text-[#F4F3EE] hover:bg-white/[0.08]'
              }`}
            >
              {svgZoom}%
            </button>
            <IconButton
              label="放大 SVG"
              onClick={() => setSvgZoom((z) => Math.min(200, z + 25))}
            >
              <ZoomIn />
            </IconButton>
          </div>
          <span
            aria-hidden="true"
            className="mx-0.5 h-3.5 w-px bg-[color:var(--glass-hairline)]"
          />
          <Button
            variant={svgFullWidth ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSvgFullWidth((v) => !v)}
            title={svgFullWidth ? '恢复常规阅读宽度' : '横向铺满视口'}
          >
            {svgFullWidth ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                <span>适宽</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5" />
                <span>全宽</span>
              </>
            )}
          </Button>
          <Button
            variant={showSvgSourceDiff ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setShowSvgSourceDiff((v) => !v)}
            title={showSvgSourceDiff ? '返回矢量图像预览' : '查看 SVG 源文本'}
          >
            {showSvgSourceDiff ? '图像' : '源码'}
          </Button>
          <Button
            variant={svgAnnotateMode ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSvgAnnotateMode((v) => !v)}
            data-svg-annotate-toggle
          >
            {svgAnnotateMode ? '退出批注' : '框选批注'}
          </Button>
          {extractedTexts.length > 0 && (
            <Button
              variant={svgTextsExpanded ? 'primary' : 'ghost'}
              size="sm"
              data-svg-extracted-texts-toggle=""
              aria-expanded={svgTextsExpanded}
              onClick={() => setSvgTextsExpanded((v) => !v)}
              title="展开图中提取的文字节点，点击可加入证据篮"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>文字 ({extractedTexts.length})</span>
            </Button>
          )}
        </div>

        {!showSvgSourceDiff ? (
          <div
            className={`rounded-xl border p-4 overflow-auto flex items-center justify-center min-h-[420px] ${
              paperLightMode
                ? 'bg-white border-[#DDD9CF]'
                : 'bg-[#262524] border-[#383633]'
            }`}
          >
            {(() => {
              const { sanitizedSvg } = sanitizeSvgForPreview(
                currentRev.svgSource || ''
              );
              const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(
                sanitizedSvg
              )}`;
              return (
                <div className="relative w-fit" data-svg-annotation-host>
                  <img
                    src={dataUri}
                    alt={activeFile.title}
                    referrerPolicy="no-referrer"
                    style={{ width: `${svgZoom}%`, maxWidth: 'none' }}
                    className="block rounded shadow-sm transition-all"
                  />
                  <SvgAnnotationOverlay
                    annotations={svgAnnotations}
                    annotateMode={svgAnnotateMode}
                    paperLightMode={paperLightMode}
                    flashAnnotationId={flashAnnotationId}
                    onRegionSelected={annotateFromSvgRegion}
                  />
                </div>
              );
            })()}
          </div>
        ) : (
          <pre
            className={`p-4 rounded-xl font-mono text-[13px] leading-[1.6] overflow-x-auto border ${
              paperLightMode
                ? 'bg-[#F0EEE6] text-[#1F1E1D] border-[#DDD9CF]'
                : 'bg-[#262524] text-[#C9C5BD] border-[#383633]'
            }`}
          >
            {currentRev.svgSource}
          </pre>
        )}

        {svgTextsExpanded && extractedTexts.length > 0 && (
          <div
            data-svg-extracted-texts-panel=""
            className={`pt-2.5 border-t space-y-2 ${
              paperLightMode ? 'border-[#E3E0D8]' : 'border-[#383633]'
            }`}
          >
            <div className="flex flex-wrap gap-1.5">
              {extractedTexts.map((txt, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() =>
                    onAddEvidencePointer({
                      file_id: activeFile.file_id,
                      revision_id: currentRev.revision_id,
                      relative_path: activeFile.relative_path,
                      content_sha256: currentRev.content_sha256,
                      locator: { kind: 'svg_text', fragment: txt },
                      evidence_kind: 'svg_label',
                      index_generation: indexGeneration,
                      observed_at: currentRev.observed_at,
                      coverage: 'svg_text',
                      stale: false,
                      excerpt: `SVG 节点文本：「${txt}」`,
                    })
                  }
                  className={`px-2.5 py-1 rounded-md border text-xs flex items-center gap-1.5 cursor-pointer transition-colors ${
                    paperLightMode
                      ? 'bg-white/80 border-[#E3E0D8] hover:border-[#9A6A45] text-[#4A463F]'
                      : 'bg-[#232220] border-[#383633] hover:border-[#D99B52] text-[#E6E5E0]'
                  }`}
                >
                  <span>{txt}</span>
                  <PlusCircle
                    className={`w-3 h-3 shrink-0 ${
                      paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
                    }`}
                  />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** PDF 阅读分节（原版版式与页级文本双视图，阅读能力与全文检索状态分别呈现） */
export function ReaderPdfSection({ ctx }: { ctx: ReaderCtx }) {
  const {
    paperLightMode,
    activeFile,
    currentRev,
    pdfViewMode,
    setPdfViewMode,
    activePdfPage,
    setActivePdfPage,
    handleAddSectionToContext,
    pdfAnchor,
    systemActions,
    onAddEvidencePointer,
    indexGeneration,
    flashPdfPage,
    pdfAnnotationsByPage,
    flashAnnotationId,
    annotateFromPdfPage,
  } = ctx;
  const [pdfSelectionQuote, setPdfSelectionQuote] = useState<string>('');
  useEffect(() => {
    setPdfSelectionQuote('');
  }, [activePdfPage, currentRev.revision_id]);
  const capturePdfSelection = () => {
    if (typeof window === 'undefined') return;
    const text = window.getSelection()?.toString() ?? '';
    const cleaned = text.replace(/\s+/g, ' ').trim();
    setPdfSelectionQuote(cleaned.length >= 2 ? cleaned.slice(0, 480) : '');
  };
  const pdfPages = currentRev.pdfPages ?? [];
  const hasPdfPageList = pdfPages.length > 0;
  const pdfIndexWarning =
    activeFile.pdfStatus === 'unindexed'
      ? '正文尚未索引'
      : activeFile.pdfStatus && activeFile.pdfStatus !== 'page_indexed'
        ? '字符提取受限'
        : null;
  return (
    <div
      className={`flex-1 overflow-y-auto px-4 py-3 space-y-2.5 ${
        paperLightMode
          ? 'bg-[#EDEBE5] text-[#1F1E1D]'
          : 'bg-[#262524] text-[#F4F3EE]'
      }`}
    >
      <div className="max-w-[var(--measure-read)] mx-auto space-y-2.5">
        <div
          data-pdf-toolbar=""
          className="flex flex-wrap items-center justify-between gap-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <div
              className={`flex rounded-lg border overflow-hidden text-xs ${
                paperLightMode ? 'border-[#D8B79B]' : 'border-[#383633]'
              }`}
            >
              {(
                [
                  ['raw', '原版版式'],
                  ['structured', '页级文本'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPdfViewMode(mode)}
                  className={`px-2.5 py-1 cursor-pointer transition-colors ${
                    pdfViewMode === mode
                      ? paperLightMode
                        ? 'bg-[#EDE4D7] text-[#1F1E1D] font-medium'
                        : 'bg-[#2E2B27] text-[#D99B52] font-medium'
                      : paperLightMode
                        ? 'bg-white text-[#6E6A61] hover:text-[#1F1E1D]'
                        : 'bg-[#232220] text-[#A1A09A] hover:text-[#F4F3EE]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {pdfIndexWarning && (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
                  paperLightMode
                    ? 'bg-amber-50 text-[color:var(--stage-ink-decision-text)]'
                    : 'bg-amber-500/12 text-amber-300'
                }`}
                title={activeFile.pdfStatusReason || pdfIndexWarning}
              >
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span>{pdfIndexWarning}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {currentRev.snapshotAvailable && (
              <a
                href={revisionRawUrl(currentRev.revision_id)}
                target="_blank"
                rel="noreferrer"
                title="在新窗口打开此版本原 PDF"
                className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
                  paperLightMode
                    ? 'text-[#6E6A61] hover:bg-black/[0.05] hover:text-[#1F1E1D]'
                    : 'text-[#A1A09A] hover:bg-white/[0.08] hover:text-[#F4F3EE]'
                }`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>新窗口打开</span>
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                handleAddSectionToContext(
                  1,
                  1,
                  currentRev.pdfPages?.[0]?.extractedText || activeFile.title,
                  `PDF 第 ${activePdfPage} 页引用`
                )
              }
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>引用此页</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => annotateFromPdfPage(activePdfPage, pdfSelectionQuote)}
              data-pdf-annotate-page
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>批注此页</span>
            </Button>
          </div>
        </div>

        <div
          className={`grid grid-cols-1 ${
            hasPdfPageList ? 'lg:grid-cols-4' : ''
          } gap-3`}
        >
          {hasPdfPageList && (
            <div className="lg:col-span-1 space-y-1.5">
              <div
                className={`text-[11px] font-medium px-1 ${
                  paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]'
                }`}
              >
                页面目录
              </div>
              {pdfPages.map((p) => (
                <button
                  key={p.pageNumber}
                  type="button"
                  onClick={() => setActivePdfPage(p.pageNumber)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                    activePdfPage === p.pageNumber
                      ? paperLightMode
                        ? 'bg-[#EDE4D7] border-[#9A6A45]/50 text-[#1F1E1D]'
                        : 'bg-[#2E2B27] border-[#D99B52]/50 text-[#D99B52]'
                      : paperLightMode
                        ? 'bg-white border-[#E3E0D8] text-[#6E6A61] hover:text-[#1F1E1D]'
                        : 'bg-[#232220] border-[#383633] text-[#A1A09A] hover:text-[#F4F3EE]'
                  }`}
                >
                  <div
                    className={`font-mono font-semibold ${
                      activePdfPage === p.pageNumber
                        ? paperLightMode
                          ? 'text-[#9A5B33]'
                          : 'text-[#D99B52]'
                        : paperLightMode
                          ? 'text-[#6E6A61]'
                          : 'text-[#A1A09A]'
                    }`}
                  >
                    第 {p.pageNumber} 页
                  </div>
                  {p.heading && <div className="truncate mt-0.5">{p.heading}</div>}
                </button>
              ))}
            </div>
          )}

          <div
            className={`${
              hasPdfPageList ? 'lg:col-span-3' : ''
            } rounded-xl border overflow-hidden min-h-[540px] flex flex-col ${
              flashPdfPage !== undefined ? 'glx-anchor-flash' : ''
            } ${
              paperLightMode
                ? 'bg-white border-[#DDD9CF] shadow-[var(--glass-shadow)]'
                : 'bg-[#262524] border-[#383633]'
            }`}
          >
            {(pdfAnnotationsByPage.get(activePdfPage)?.length ?? 0) > 0 && (
              <div className="px-3 pt-2">
                <PdfPageAnnotations
                  annotations={pdfAnnotationsByPage.get(activePdfPage) ?? []}
                  flashAnnotationId={flashAnnotationId}
                  paperLightMode={paperLightMode}
                />
              </div>
            )}
            {currentRev.snapshotAvailable && pdfViewMode === 'structured' ? (
              <div
                className={`flex-1 overflow-y-auto p-3 ${
                  paperLightMode ? 'bg-white' : 'bg-[#1A1917]'
                }`}
                onMouseUp={capturePdfSelection}
              >
                {pdfSelectionQuote && (
                  <div
                    data-pdf-selection-annotate
                    className="sticky top-0 z-10 mb-2 flex items-center justify-between gap-2 rounded-lg border border-[#D8B79B] bg-[#FBF6EE]/95 px-2.5 py-1.5 text-xs backdrop-blur"
                  >
                    <span className="truncate text-[#9A6A45]">
                      已选中「{pdfSelectionQuote.slice(0, 40)}
                      {pdfSelectionQuote.length > 40 ? '…' : ''}」
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          annotateFromPdfPage(activePdfPage, pdfSelectionQuote);
                          setPdfSelectionQuote('');
                        }}
                      >
                        <PlusCircle className="w-3.5 h-3.5" />
                        <span>批注选中文字</span>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPdfSelectionQuote('')}>
                        取消
                      </Button>
                    </span>
                  </div>
                )}
                <PdfReaderView
                  activeFile={activeFile}
                  currentRev={currentRev}
                  paperLightMode={paperLightMode}
                  indexGeneration={indexGeneration}
                  pdfAnchor={pdfAnchor}
                  systemActions={systemActions}
                  onAddEvidencePointer={onAddEvidencePointer}
                  onActivePageChange={setActivePdfPage}
                />
              </div>
            ) : currentRev.snapshotAvailable ? (
              <iframe
                key={activeFile.file_id + currentRev.revision_id}
                title={`PDF Viewer · ${activeFile.title}`}
                src={`${revisionRawUrl(currentRev.revision_id)}#toolbar=0&navpanes=0&view=FitH${
                  activePdfPage > 1 ? `&page=${activePdfPage}` : ''
                }`}
                className={`flex-1 w-full ${
                  paperLightMode ? 'bg-white' : 'bg-[#1A1917]'
                }`}
              />
            ) : (
              <div
                className={`flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center ${
                  paperLightMode ? 'bg-[#F2F0EA]' : 'bg-[#232220]'
                }`}
              >
                <AlertTriangle className="w-6 h-6 text-amber-400" />
                <p className="text-sm font-semibold text-amber-200">
                  此版本快照已过保留期，无法按版本直读原页
                </p>
                <p
                  className={`text-xs tabular-nums ${
                    paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]'
                  }`}
                >
                  版本 {currentRev.revision_id} 仅保留元数据（大小 / SHA-256 / 观察时间）
                </p>
                <p
                  className={`text-xs ${
                    paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]'
                  }`}
                >
                  可切换到仍保留快照的版本阅读；侧栏「在新窗口打开原 PDF」按版本快照直读，此版本已无快照可开。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** === SUBMODE C / 其他格式：NonLegacyFilePreviewPanel（L0 诚实元数据卡） === */
export function ReaderNonLegacySection({ ctx }: { ctx: ReaderCtx }) {
  const {
    activeFile,
    currentRev,
    paperLightMode,
    indexGeneration,
    officeAnchor,
    systemActions,
    onAddEvidencePointer,
  } = ctx;
  return (
    <NonLegacyFilePreviewPanel
      activeFile={activeFile}
      currentRev={currentRev}
      paperLightMode={paperLightMode}
      indexGeneration={indexGeneration}
      officeAnchor={officeAnchor}
      systemActions={systemActions}
      onAddEvidencePointer={onAddEvidencePointer}
      workspaceFiles={ctx.files}
    />
  );
}
