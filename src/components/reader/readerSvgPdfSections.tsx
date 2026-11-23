/**
 * D01-a 拆解 · 阅读器 SVG / PDF 格式专用插件层（任务卡 D01-a ②）。
 *
 * 从 ReaderView.tsx（原 4208-4683）原样迁入：
 *  - ReaderSvgSection：受限安全矢量预览（缩放/全宽/源文本切换 + 提取文字检索层）
 *  - ReaderPdfSection：PDF 能力横幅 + 原版版式 iframe / 页级文本 PdfReaderView 双视图
 *  - ReaderNonLegacySection：非 md/svg/pdf 的 L0 预览面板接线（NonLegacyFilePreviewPanel）
 * 迁移纪律：JSX 与类名逐字一致（像素回归护栏）。
 */

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
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

/** === SUBMODE C / Format 2: SVG SAFE VIEWER (§4.2: 受限图片方式加载，缩放平移，提取文字检索 vs 仅文件名可检索) === */
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
    // D04 · SVG 框选批注层
    svgAnnotations,
    svgAnnotateMode,
    setSvgAnnotateMode,
    annotateFromSvgRegion,
    flashAnnotationId,
  } = ctx;
  return (
    <div
      className={`flex-1 overflow-y-auto p-6 space-y-5 ${
        paperLightMode
          ? 'bg-[#FAF9F5] text-[#1F1E1D]'
          : 'bg-[#1A1917] text-[#F4F3EE]'
      }`}
    >
      <div
        className={`${
          svgFullWidth ? 'max-w-full' : 'max-w-[var(--measure-read)]'
        } mx-auto space-y-4`}
      >
        {/* SVG Toolbar（§4.1：图标钮＝IconButton，开合钮＝Button primary/ghost） */}
        <div className="px-1 py-2 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3">
            <span
              className={`font-semibold ${
                paperLightMode ? 'text-[#1F1E1D]' : 'text-[#F4F3EE]'
              }`}
            >
              受限安全矢量预览（已禁用脚本、事件处理与外部资源）
            </span>
            <span
              aria-hidden="true"
              className={paperLightMode ? 'text-[#8A857C]' : 'text-[#6E6D68]'}
            >
              ·
            </span>
            <span
              className={`${
                paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]'
              }`}
            >
              {currentRev.svgExtractedTexts &&
              currentRev.svgExtractedTexts.length > 0
                ? `可提取文字节点：${currentRev.svgExtractedTexts.length} 项（已加入全文检索）`
                : '无内嵌 <text> 节点 · 仅文件名可检索'}
            </span>
          </div>

          <div className="flex items-center gap-2 tabular-nums">
            <IconButton
              label="缩小 SVG"
              onClick={() => setSvgZoom((z) => Math.max(50, z - 25))}
            >
              <ZoomOut />
            </IconButton>
            <span
              className={`px-2 ${
                paperLightMode ? 'text-[#1F1E1D]' : 'text-[#F4F3EE]'
              }`}
            >
              {svgZoom}%
            </span>
            <IconButton
              label="放大 SVG"
              onClick={() => setSvgZoom((z) => Math.min(200, z + 25))}
            >
              <ZoomIn />
            </IconButton>
            <Button variant="secondary" size="sm" onClick={() => setSvgZoom(100)}>
              100% 原尺寸
            </Button>
            <Button
              variant={svgFullWidth ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setSvgFullWidth((v) => !v)}
            >
              {svgFullWidth ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5" />
                  <span>常规宽度</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>全宽模式</span>
                </>
              )}
            </Button>
            <Button
              variant={showSvgSourceDiff ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setShowSvgSourceDiff((v) => !v)}
            >
              {showSvgSourceDiff ? '返回图像预览' : '查看 SVG 源文本'}
            </Button>
            {/* D04：框选批注开合（叠加层 crosshair；保存区域恒百分比定位，原图字节零改动） */}
            <Button
              variant={svgAnnotateMode ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setSvgAnnotateMode((v) => !v)}
              data-svg-annotate-toggle
            >
              {svgAnnotateMode ? '退出框选批注' : '框选批注'}
            </Button>
          </div>
        </div>

        {/* Restricted Image Rendering via Data URI (Never injecting arbitrary SVG into DOM) */}
        {!showSvgSourceDiff ? (
          <div
            className={`rounded-lg border p-6 overflow-auto flex items-center justify-center min-h-[380px] ${
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
                /* D04：relative w-fit 包裹层精确贴合图像盒（img 转块级消除基线空隙），
                    框选/批注区域叠加层 inset-0 与图像逐像素对齐，缩放无关 */
                <div className="relative w-fit" data-svg-annotation-host>
                  <img
                    src={dataUri}
                    alt={activeFile.title}
                    referrerPolicy="no-referrer"
                    style={{ width: `${svgZoom}%`, maxWidth: 'none' }}
                    className="block rounded shadow-lg transition-all"
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
            className={`p-4 rounded-lg font-mono text-[13px] leading-[1.6] overflow-x-auto border ${
              paperLightMode
                ? 'bg-[#F0EEE6] text-[#1F1E1D] border-[#DDD9CF]'
                : 'bg-[#262524] text-[#C9C5BD] border-[#383633]'
            }`}
          >
            {currentRev.svgSource}
          </pre>
        )}

        {/* Extracted Text Nodes Panel（契约⑧⑤：默认折叠为一行头部，点击展开原气泡墙） */}
        <div
          className={`pt-3 border-t space-y-2 ${
            paperLightMode ? 'border-[#E3E0D8]' : 'border-[#383633]'
          }`}
        >
          <button
            type="button"
            onClick={() => setSvgTextsExpanded((v) => !v)}
            className={`w-full text-xs font-semibold flex items-center justify-between gap-2 ${
              paperLightMode ? 'text-[#1F1E1D]' : 'text-[#F4F3EE]'
            }`}
          >
            <span>
              SVG 可提取文字检索层（
              {currentRev.svgExtractedTexts?.length ?? 0} 项 ·{' '}
              {svgTextsExpanded ? '点击收起' : '点击展开'}）
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span
                className={`font-mono ${
                  paperLightMode ? 'text-[#8A857C]' : 'text-[#6E6D68]'
                }`}
              >
                coverage={activeFile.coverage}
              </span>
              {svgTextsExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </span>
          </button>
          {svgTextsExpanded && (
            <>
              {currentRev.svgExtractedTexts &&
              currentRev.svgExtractedTexts.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {currentRev.svgExtractedTexts.map((txt, idx) => (
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
                      className={`px-3 py-1.5 rounded border text-xs flex items-center gap-1.5 transition-colors ${
                        paperLightMode
                          ? 'bg-white/60 border-[#E3E0D8] hover:border-[#9A6A45] text-[#4A463F]'
                          : 'bg-white/60 border-[color:var(--glass-hairline)] hover:border-[#D99B52] text-[color:var(--ink-strong)]'
                      }`}
                    >
                      <span>{txt}</span>
                      <PlusCircle
                        className={`w-3 h-3 ${
                          paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
                        }`}
                      />
                    </button>
                  ))}
                </div>
              ) : (
                <div
                  className={`text-xs ${
                    paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
                  }`}
                >
                  仅文件名可检索：当前 SVG 仅包含矢量路径 (&lt;path&gt; / &lt;circle&gt;)，无内嵌文本层，观澜不承诺图形语义猜测。
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** === SUBMODE C / Format 3: PDF READER (§4.3: 阅读能力与全文检索状态分别显示) === */
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
    // D04 · PDF 页批注与到达闪烁
    flashPdfPage,
    pdfAnnotationsByPage,
    flashAnnotationId,
    annotateFromPdfPage,
  } = ctx;
  // D04：页级文本选中文字 → 「批注选中文字」浮条（摘录进本地证据表，原文零改写）。
  // mouseup 时读取选区；批注卡经 ctx.composer 挂 ReaderView 根。
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
  return (
    <div
      className={`flex-1 overflow-y-auto p-6 space-y-5 ${
        paperLightMode
          ? 'bg-[#EDEBE5] text-[#1F1E1D]'
          : 'bg-[#262524] text-[#F4F3EE]'
      }`}
    >
      <div className="max-w-[var(--measure-read)] mx-auto space-y-4">
        {/* PDF Capability & Index Separation Status Banner */}
        <div className="px-1 py-2 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <span
                className={paperLightMode ? 'text-[#1F1E1D]' : 'text-[#F4F3EE]'}
              >
                阅读能力：内嵌阅读器可用 + 原文件入口就绪
              </span>
              <span
                aria-hidden="true"
                className={paperLightMode ? 'text-[#8A857C]' : 'text-[#6E6D68]'}
              >
                ·
              </span>
              <span
                className={
                  activeFile.pdfStatus === 'page_indexed'
                    ? paperLightMode
                      ? 'text-emerald-600'
                      : 'text-emerald-400'
                    : paperLightMode
                      ? 'text-[color:var(--stage-ink-decision-text)]'
                      : 'text-amber-400'
                }
              >
                检索索引状态：
                {activeFile.pdfStatus === 'page_indexed'
                  ? '已按需抽取文本层（含页码来源）'
                  : activeFile.pdfStatus === 'unindexed'
                    ? '正文尚未索引（初始仅检索文件名和已知元数据）'
                    : '字符提取失败（中文提取失败不直接判定为扫描件）'}
              </span>
            </div>
            <p
              className={`text-xs ${
                paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]'
              }`}
            >
              {activeFile.pdfStatusReason}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* B04：原版版式 / 页级文本双视图切换（pdfAnchor 到达时自动切页级文本） */}
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
                  className={`px-3 py-1.5 cursor-pointer transition-colors ${
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
            <Button
              variant="primary"
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
              <span>引用当前页给智能体</span>
            </Button>
            {/* D04：本页批注入口（选中页内文字后也可经浮条带摘录批注） */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => annotateFromPdfPage(activePdfPage, pdfSelectionQuote)}
              data-pdf-annotate-page
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>批注此页</span>
            </Button>
          </div>
        </div>

        {/* Embedded PDF Page Viewer —— v0.3 真实原页渲染 */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-1 space-y-2">
            <div
              className={`text-xs font-semibold ${
                paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]'
              }`}
            >
              版本与本地文件入口
            </div>

            {/* 批次一：任意路径直读（/api/workspace/file）已随旧插件移除（契约 §4），
                「打开原 PDF」一律按版本快照直读（/api/v1/revisions/<id>/content?raw=1） */}
            <a
              href={revisionRawUrl(currentRev.revision_id)}
              target="_blank"
              rel="noreferrer"
              className={`w-full text-left p-2.5 rounded border text-xs flex items-center justify-between transition-colors ${
                paperLightMode
                  ? 'text-[#9A6A45] border-[#D8B79B] hover:bg-[#F5F0E8]'
                  : 'text-[#D99B52] border-[#8A6A4F] hover:bg-[#232220]'
              }`}
            >
              <span>在新窗口打开原 PDF</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>

            {(currentRev.pdfPages || []).map((p) => (
              <button
                key={p.pageNumber}
                type="button"
                onClick={() => setActivePdfPage(p.pageNumber)}
                className={`w-full text-left p-2.5 rounded border text-xs transition-colors ${
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
                  Page {p.pageNumber}
                </div>
                <div className="truncate mt-0.5">{p.heading}</div>
              </button>
            ))}
          </div>

          <div
            className={`lg:col-span-3 rounded-lg border overflow-hidden min-h-[480px] flex flex-col ${
              // D04：决定 pdfAnchor 到达时整卡闪两轮琥珀描边（flashPdfPage，2.2s 自动摘除）
              flashPdfPage !== undefined ? 'glx-anchor-flash' : ''
            } ${
              paperLightMode
                ? 'bg-white border-[#DDD9CF] shadow-[var(--glass-shadow)]' /* 评审第 1 轮 #9④：阴影任意值归 L1 令牌 */
                : 'bg-[#262524] border-[#383633]'
            }`}
          >
            <div
              className={`px-3 py-2 border-b text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono flex items-center justify-between tabular-nums ${
                paperLightMode
                  ? 'border-[#E3E0D8] text-[#8A857C]'
                  : 'border-[#383633] text-[#6E6D68]'
              }`}
            >
              <span className="truncate">{activeFile.relative_path}</span>
              <span className="text-emerald-400 font-sans">
                真实 PDF 原页 · 按版本 {currentRev.revision_id} 快照直读
              </span>
            </div>
            {/* D04：当前页批注 chips（本页有批注才渲染；定位闪烁逐条消费） */}
            <div className="px-3 pt-2">
              <PdfPageAnnotations
                annotations={pdfAnnotationsByPage.get(activePdfPage) ?? []}
                flashAnnotationId={flashAnnotationId}
                paperLightMode={paperLightMode}
              />
            </div>
            {currentRev.snapshotAvailable && pdfViewMode === 'structured' ? (
              /* B04：页级文本结构化视图（/revisions/{id}/pdf）——
                 页码导航、扫描页诚实标注、pdfAnchor 直达高亮与 #page=N 引用。
                 D04：mouseup 采集页内选中文字 → 「批注选中文字」浮条 */
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
              /* 快照已淘汰：明确提示，不用磁盘当前文件冒充钉住的历史版本 */
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
