/**
 * D01-a 拆解 · ReaderView 薄装配层（任务卡 D01-a ②）。
 *
 * 巨石（4689 行）已按层拆入 reader/ 目录：
 *  - reader/readerMarkdownModel.ts      纯函数 Markdown 行模型层（零 UI 依赖、可单测）
 *  - reader/useReaderController.tsx     单一行为控制器（state/memo/effect/handler + 行渲染闭包 → ctx）
 *  - reader/readerChromeSections.tsx    浮动 Chrome（返回横幅/新版本告警/双层文件头）
 *  - reader/readerDiffRelationsSections.tsx  diff / relations 子模式面板
 *  - reader/readerMarkdownSection.tsx   MD 阅读纸（格式插件层 · markdown）
 *  - reader/readerSvgPdfSections.tsx    SVG / PDF 格式插件层
 *  - reader/readerShared.tsx            共享类型 + CopyIdButton
 *
 * 本文件只保留：测试兼容再导出（decision-receipt-01、02 与 gu-cc-01 既有导入路径不变）
 * + 分节装配（DOM 嵌套结构与拆解前逐字一致，像素回归护栏覆盖）。
 */

import React from 'react';
// 测试兼容再导出：纯函数层单一出处（reader/readerMarkdownModel.ts）
export {
  buildLinkParts,
  buildMarkdownBlocks,
  collectRenderedSourceLineAnchors,
  formatSourceLineFallbackNotice,
  pickNearestSourceLineAnchor,
  resolveMarkdownHref,
  scrollToSourceLine,
  tokenizeInline,
  STAGE_STEPS,
} from './reader/readerMarkdownModel';
export {
  buildDecisionReceiptInstruction,
  buildWrittenBackMarkdown,
  DECISION_RECEIPT_STORAGE_KEY,
  fillPromptOf,
  loadDecisionReceiptSnapshot,
  parseDecisionFormItems,
  saveDecisionReceiptSnapshot,
} from './reader/readerDecisionModel';
export type {
  DecisionFormItem,
  DecisionReceiptBasketPayload,
  DecisionReceiptSnapshot,
  DecisionSaveFileRequest,
} from './reader/readerDecisionModel';
export type {
  InlineToken,
  LinkPart,
  MarkdownBlock,
  MarkdownLinkIndex,
} from './reader/readerMarkdownModel';
// 测试兼容再导出：共享类型与轻组件
export { CopyIdButton } from './reader/readerShared';
export type { ReaderSubMode, ReturnBreadcrumb } from './reader/readerShared';
// 旧名兼容再导出：RightInspector.tsx:31 仍从本模块 import formatObservedAt（相对时间口径，
// 与迁移前逐字一致）；改名与迁址只动了事实源位置，不改任何输出。
export { formatRelativeObservedAt as formatObservedAt } from '../utils/timeFormat';
export type { ReaderViewProps, ReaderCtx } from './reader/useReaderController';
import type { ReaderViewProps } from './reader/useReaderController';
import { useReaderController } from './reader/useReaderController';

import { NonLegacyFilePreviewPanel } from './NonLegacyFilePreviewPanel';
import { ReaderFileHeaderSection, ReaderTopBannerSection } from './reader/readerChromeSections';
import { ReaderDiffSection } from './reader/readerDiffSection';
import { ReaderRelationsSection } from './reader/readerRelationsSection';
import { ReaderMarkdownSection } from './reader/readerMarkdownSection';
import { ReaderPdfSection, ReaderSvgSection } from './reader/readerSvgPdfSections';
// D04 · 锚点批注层挂载点（最薄接线：组件本体在 reader/readerAnchorLayer.tsx）
import {
  ReaderAnnotationComposer,
  ReaderAnnotationDrawer,
} from './reader/readerAnchorLayer';
import { formatAnnotationLocatorLabel } from '../utils/readerAnnotations';
import { StickyNote } from 'lucide-react';

/**
 * 阅读器（四层装配）。§3.2：paper-light / dark 双态阅读纸；四种格式专用插件分节。
 * AC-02：shell 与首屏测量挂根节点（firstScreenRootRef），正文读取不阻塞首屏。
 * D04：根节点补 position:relative（无偏移零视觉变化），承载批注抽屉/撰写卡浮动层；
 * 两者关闭态零 DOM——D01-a 像素基线结构性零扰动。
 */
export const ReaderView: React.FC<ReaderViewProps> = (props) => {
  const ctx = useReaderController(props);
  const {
    firstScreenRootRef,
    paperLightMode,
    subMode,
    activeFile,
    currentRev,
    officeAnchor,
    systemActions,
    onAddEvidencePointer,
    indexGeneration,
    // U05 · 专注纸面（Zen）与阅读进度光条
    zenMode,
    readerProgressBarRef,
    readerProgressTrackRef,
    // D04 · 锚点批注层
    annotations,
    annotationsOpen,
    setAnnotationsOpen,
    annotationComposer,
    annotationBusy,
    annotationConvertAvailable,
    annotationConvertDisabledReason,
    closeAnnotationComposer,
    submitAnnotation,
    deleteAnnotation,
    jumpToAnnotation,
  } = ctx;

  const anchorLayerActive =
    subMode === 'read' &&
    (activeFile.format === 'md' || activeFile.format === 'svg' || activeFile.format === 'pdf');

  return (
    <div
      ref={firstScreenRootRef}
      data-reader-shell=""
      data-reader-dark={!paperLightMode ? 'true' : undefined}
      data-reader-zen={zenMode ? 'true' : undefined}
      className={`glx-reader-frame relative flex-1 h-full flex flex-col overflow-hidden ${
        paperLightMode
          ? 'bg-[#FAF9F5] text-[#1F1E1D]'
          : 'bg-[#101218] text-[#F2F1EC]'
      }`}
    >
      {/* 1. Return Breadcrumb & Non-Intrusive New Version Alert Banner（浮动 Chrome） */}
      <ReaderTopBannerSection ctx={ctx} />

      {/* 2. 紧凑双层文件头（浮动 Chrome） */}
      <ReaderFileHeaderSection ctx={ctx} />

      {/* 2.5 U05 · 顶部 2px 琉璃阅读进度光条（紧贴顶栏下沿）：
          只动 transform:scaleX（GPU 合成器无重排，禁动画 width）；
          百分比由 useReaderController.handleMarkdownScroll 已算好的 pct 单向直写，
          滚动期零 React 重渲染；正文文字节点永不挂本文件任何动效类。
          实机走查修复：轨道常驻可见（--ink-faint，随 data-reader-dark 换档；
          实测对壳底 3.15 浅 / 3.71 夜航，≥3:1 图形门槛）——正文停在 scrollTop=0
          （scaleX(0) 零宽）时轨道仍可证明光条本体已渲染，滚动后鸢尾紫填充随之推进。 */}
      <div
        ref={readerProgressTrackRef}
        role="progressbar"
        aria-label="阅读进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        data-reader-progress=""
        className="relative z-30 h-[2px] w-full shrink-0 overflow-hidden bg-[color:var(--ink-faint)]"
      >
        <div
          ref={readerProgressBarRef}
          data-reader-progress-bar=""
          className="glx-reader-progress h-full w-full origin-left bg-[linear-gradient(90deg,var(--accent-iris),var(--accent-iris-deep))]"
          style={{ transform: 'scaleX(0)' }}
        />
      </div>

      {/* 3. Main Content Area by SubMode */}
      <div className="flex-1 flex overflow-hidden">
        {/* === SUBMODE A: DIFF VIEW === */}
        {(subMode === 'diff_since_read' || subMode === 'diff_versions') && (
          <ReaderDiffSection ctx={ctx} />
        )}

        {/* === SUBMODE B: LOCAL RELATION GRAPH === */}
        {subMode === 'relations' && <ReaderRelationsSection ctx={ctx} />}

        {/* === SUBMODE C: PRIMARY READING MODE (MD / SVG / PDF 格式插件层) === */}
        {subMode === 'read' && (
          <>
            {activeFile.format === 'md' && <ReaderMarkdownSection ctx={ctx} />}
            {activeFile.format === 'svg' && <ReaderSvgSection ctx={ctx} />}
            {activeFile.format === 'pdf' && <ReaderPdfSection ctx={ctx} />}
            {activeFile.format !== 'md' &&
              activeFile.format !== 'svg' &&
              activeFile.format !== 'pdf' && (
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
              )}
          </>
        )}
      </div>

      {/* D04 · 锚点批注层（抽屉切换钮/清单抽屉/撰写卡）：
          阅读子模式 + md/svg/pdf 三格式才挂载；无批注时切换钮零 DOM——
          D01-a 像素基线结构性零扰动（发现路径=段落悬停「批注」/SVG「框选批注」/PDF「批注此页」） */}
      {anchorLayerActive && (
        <>
          {!annotationsOpen && !annotationComposer && annotations.length > 0 && (
            <button
              type="button"
              onClick={() => setAnnotationsOpen(true)}
              data-annotation-drawer-toggle
              title="本版本批注清单（按版本哈希绑定）"
              className="absolute bottom-4 right-4 z-20 flex items-center gap-1.5 rounded-full border border-[color:var(--glass-hairline)] bg-white/85 px-3 py-1.5 text-xs font-medium text-[color:var(--ink-strong)] shadow-[var(--glass-shadow)] backdrop-blur hover:border-[#D99B52] cursor-pointer"
            >
              <StickyNote className="w-3.5 h-3.5 text-[#D99B52]" />
              <span className="tabular-nums">批注 {annotations.length}</span>
            </button>
          )}
          <ReaderAnnotationDrawer
            open={annotationsOpen}
            paperLightMode={paperLightMode}
            annotations={annotations}
            onJump={(a) => {
              jumpToAnnotation(a);
              setAnnotationsOpen(false);
            }}
            onDelete={deleteAnnotation}
            onClose={() => setAnnotationsOpen(false)}
          />
          <ReaderAnnotationComposer
            key={annotationComposer ? JSON.stringify(annotationComposer.target) : 'closed'}
            open={Boolean(annotationComposer)}
            anchorLabel={annotationComposer ? formatAnnotationLocatorLabel(annotationComposer.target) : ''}
            paperLightMode={paperLightMode}
            convertAvailable={annotationConvertAvailable}
            convertDisabledReason={annotationConvertDisabledReason}
            busy={annotationBusy}
            notice={annotationComposer?.notice ?? null}
            onSave={(note) => submitAnnotation(note, false)}
            onConvert={(note) => submitAnnotation(note, true)}
            onClose={closeAnnotationComposer}
          />
        </>
      )}
    </div>
  );
};
