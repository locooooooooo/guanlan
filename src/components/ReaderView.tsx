
import React from 'react';
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
export { CopyIdButton } from './reader/readerShared';
export type { ReaderSubMode, ReturnBreadcrumb } from './reader/readerShared';
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
import {
  ReaderAnnotationComposer,
  ReaderAnnotationDrawer,
} from './reader/readerAnchorLayer';
import { formatAnnotationLocatorLabel } from '../utils/readerAnnotations';
import { StickyNote } from 'lucide-react';

/**
 * 阅读器（分层装配）：paper-light / dark 双态阅读纸，按格式分派专用阅读分节。
 * shell 与首屏测量挂根节点（firstScreenRootRef），正文读取不阻塞首屏。
 * 根节点使用 position:relative 承载批注抽屉与撰写卡浮动层；关闭态不渲染额外 DOM。
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
    zenMode,
    readerProgressBarRef,
    readerProgressTrackRef,
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
      <ReaderTopBannerSection ctx={ctx} />

      <ReaderFileHeaderSection ctx={ctx} />

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

      <div data-reader-content="" className="flex-1 flex overflow-hidden">
        {(subMode === 'diff_since_read' || subMode === 'diff_versions') && (
          <ReaderDiffSection ctx={ctx} />
        )}

        {subMode === 'relations' && <ReaderRelationsSection ctx={ctx} />}

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
