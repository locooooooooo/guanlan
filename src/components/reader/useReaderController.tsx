
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DecisionAssertion,
  EvidencePointer,
  FileRecord,
  OfficeEvidenceAnchor,
  PdfEvidenceAnchor,
  ReadingState,
  RelationEdge,
} from '../../types/guanlan';
import {
  buildLocalRelationGraph,
  computeChangedSectionsSinceRead,
  computeMarkdownDiff,
  detectRollbackRevision,
  hasUnreadChanges,
  parseMarkdownOutline,
} from '../../utils/guanlanEngine';
import { groupFilesIntoPackages, stageOfPath } from '../../utils/taskPackages';
import type { PackageDoc, StageRole, TaskPackage } from '../../utils/taskPackages';
import {
  artifactStateOf,
  docStatePillClass,
  indexStateOverview,
  initiativeStateBadgeLine,
  initiativeStateOfPackage,
  projectInitiativeState,
  revisionVersionLabel,
} from '../../utils/stateProjection';
import {
  READER_FIRST_SCREEN_BUDGET_MS,
  readerFirstScreenNowMs,
  recordReaderFirstScreenSample,
  resolveReaderBodyPhase,
} from '../../utils/readerFirstScreen';
import {
  getRevisionContent,
  pinRevisionContent,
  requestRevisionContent,
  unpinRevisionContent,
} from '../../utils/revisionContentStore';
import {
  fetchRevisionContent,
  fetchRevisionContentsBatch,
  fetchDiffSummaryViaJob,
  fetchStatements,
  extractJobBranch,
  pollJobUntilSettled,
  postDecisionResolve,
  type DiffResult,
  type JobReportWriteback,
} from '../../services/workspaceClient';
import { copyTextWithDesktopFallback } from '../../services/desktopBridge';
import {
  buildDecisionResolvePayload,
  extractDecisionOptions,
  matchStatementToBlock,
  parseDecisionBlocks,
  remainingBlockingCount,
  type DecisionBlock,
  type DecisionResolveFormValues,
} from '../../utils/decisionBlocks';
import DecisionResolveCard from '../DecisionResolveCard';
import type { StatementDetailDTO, StateOverviewResponse } from '../../services/apiTypes';
import { useReaderRender } from './readerRender';
import { formatRelativeObservedAt } from '../../utils/timeFormat';
import { FileSystemActionBar, type DesktopFileActionCallbacks } from '../FileContextMenu';
import {
  buildLinkParts,
  buildMarkdownBlocks,
  collectRenderedSourceLineAnchors,
  pickNearestSourceLineAnchor,
} from './readerMarkdownModel';
import {
  buildDecisionReceiptInstruction,
  buildWrittenBackMarkdown,
  parseDecisionFormItems,
  fillPromptOf,
  loadDecisionReceiptSnapshot,
  readDecisionSaveBridge,
  saveDecisionReceiptSnapshot,
  type DecisionFormItem,
} from './readerDecisionModel';
import {
  annotationsOfVersion,
  buildDecisionBlockInsertion,
  formatAnnotationLocatorLabel,
  insertionLineAfterBlock,
  loadAnnotationStore,
  markAnnotationConverted,
  nextAnnotationId,
  normalizeAnnotationNote,
  persistAnnotationStore,
  removeAnnotation,
  upsertAnnotation,
  ANNOTATIONS_PER_VERSION_CAP,
  type ReaderAnnotation,
  type ReaderAnnotationLocator,
} from '../../utils/readerAnnotations';
import {
  scrollToSourceLine,
  type LinkPart,
  type MarkdownBlock,
  type MarkdownLinkIndex,
} from './readerMarkdownModel';
import {
  buildMiniVersionAxis,
  canOpenTimeMachine,
  computeReadingProgressScaleX,
  resolveZenToggle,
  type MiniVersionAxisNode,
  type ZenToggleResult,
  type ZenToggleTrigger,
} from './readerChromeSections';
import type { ReaderSubMode } from './readerShared';
import {
  hasBlockingDomOverlay,
  isEditableLikeTarget,
} from '../../utils/keyboardShortcuts';
import { getResolvedAppTheme, subscribeAppTheme } from '../../stores/appThemeStore';

export interface ReaderViewProps {
  sourceLine?: number;
  officeAnchor?: OfficeEvidenceAnchor | null;
  pdfAnchor?: PdfEvidenceAnchor | null;
  focusSectionId?: string;
  openToScrollPercent?: number;
  files: FileRecord[];
  activeFile: FileRecord;
  pinnedRevisionId: string;
  onChangeRevision: (revId: string) => void;
  subMode: 'read' | 'diff_since_read' | 'diff_versions' | 'relations';
  onChangeSubMode: (mode: 'read' | 'diff_since_read' | 'diff_versions' | 'relations') => void;
  readingState?: ReadingState;
  onMarkReadHere: (fileId: string, revisionId: string, sectionId?: string) => void;
  onMarkFullyRead: (fileId: string, revisionId: string) => void;
  onMarkUnread?: (fileId: string) => void;
  onScrollProgress: (fileId: string, scrollPercent: number) => void;
  onToggleBookmark: (fileId: string) => void;
  onNavigateLinkedFile: (
    targetFileId: string,
    returnOrigin: { fileId: string; revisionId: string; sectionId?: string; title: string },
    officeAnchor?: OfficeEvidenceAnchor,
    pdfAnchor?: PdfEvidenceAnchor
  ) => void;
  returnBreadcrumb: import('./readerShared').ReturnBreadcrumb | null;
  onFollowReturnBreadcrumb: () => void;
  decisions: DecisionAssertion[];
  relations: RelationEdge[];
  onSelectDecision: (decisionId: string) => void;
  onAddEvidencePointer: (pointer: EvidencePointer) => void;
  indexGeneration: number;
  stateOverview?: StateOverviewResponse | null;
  packageContext?: TaskPackage | null;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  onZenModeChange?: (zenMode: boolean) => void;
  onOpenTimeMachine?: () => void;
  readingNotice?: { count: number; at: string } | null;
  onSilentMergeNotice?: () => void;
  silentMergingNotice?: boolean;
  onRefreshNoticeWindow?: () => void;
  onAddDecisionToBasket?: (payload: import('./readerDecisionModel').DecisionReceiptBasketPayload) => void;
  onDecisionResolved?: (payload: {
    decisionId: string;
    statementId: string;
    fileId: string;
    decisionText?: string;
    confirmer?: string;
    effectiveDate?: string;
    blockingCleared?: boolean;
    lineStart?: number;
    lineEnd?: number;
  }) => void;
  onBlockingCleared?: (payload: { fileId: string }) => void;
  systemActions?: DesktopFileActionCallbacks;
}

export function useReaderController({
  sourceLine,
  officeAnchor,
  pdfAnchor,
  focusSectionId,
  openToScrollPercent,
  files,
  activeFile,
  pinnedRevisionId,
  onChangeRevision,
  subMode,
  onChangeSubMode,
  readingState,
  onMarkReadHere,
  onMarkFullyRead,
  onMarkUnread,
  onScrollProgress,
  onToggleBookmark,
  onNavigateLinkedFile,
  returnBreadcrumb,
  onFollowReturnBreadcrumb,
  decisions,
  relations,
  onSelectDecision,
  onAddEvidencePointer,
  indexGeneration,
  packageContext,
  inspectorOpen = false,
  onToggleInspector = () => {},
  onZenModeChange,
  onOpenTimeMachine,
  readingNotice = null,
  onSilentMergeNotice,
  silentMergingNotice = false,
  onRefreshNoticeWindow,
  onAddDecisionToBasket,
  onDecisionResolved,
  onBlockingCleared,
  stateOverview,
  systemActions,
}: ReaderViewProps) {
  const [paperLightMode, setPaperLightMode] = useState<boolean>(
    () => getResolvedAppTheme() !== 'dark'
  );
  useEffect(() => {
    return subscribeAppTheme(() => {
      setPaperLightMode(getResolvedAppTheme() !== 'dark');
    });
  }, []);
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(false);
  const [activeSectionId, setActiveSectionId] = useState<string>('');
  const [calloutsCollapsed, setCalloutsCollapsed] = useState<boolean>(true);
  const [outlineOpen, setOutlineOpen] = useState<boolean>(false);
  const [diffLayout, setDiffLayout] = useState<'split' | 'unified'>('split');
  const [fileActionsOpen, setFileActionsOpen] = useState(false);
  const fileActionsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setFileActionsOpen(false);
  }, [activeFile.file_id]);
  useEffect(() => {
    if (!fileActionsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (fileActionsRef.current && !fileActionsRef.current.contains(e.target as Node)) {
        setFileActionsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setFileActionsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [fileActionsOpen]);

  const [zenMode, setZenMode] = useState<boolean>(false);
  const zenNotifyRef = useRef<((zen: boolean) => void) | undefined>(onZenModeChange);
  useEffect(() => {
    zenNotifyRef.current = onZenModeChange;
  }, [onZenModeChange]);
  useEffect(
    () => () => {
      zenNotifyRef.current?.(false);
    },
    []
  );

  const zenStateRef = useRef<{ zenMode: boolean; subMode: ReaderSubMode }>({
    zenMode: false,
    subMode: 'read',
  });
  zenStateRef.current = { zenMode, subMode };
  const toggleZen = (
    trigger: ZenToggleTrigger,
    guards?: { editableTarget?: boolean; overlayOpen?: boolean }
  ): ZenToggleResult => {
    const result = resolveZenToggle({
      zenMode: zenStateRef.current.zenMode,
      trigger,
      subMode: zenStateRef.current.subMode,
      editableTarget: Boolean(guards?.editableTarget),
      overlayOpen: Boolean(guards?.overlayOpen),
    });
    if (!result.applied) return result;
    setZenMode(result.nextZenMode);
    zenNotifyRef.current?.(result.nextZenMode);
    return result;
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'z' && event.key !== 'Z') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const result = toggleZen('shortcut', {
        editableTarget: isEditableLikeTarget(event.target),
        overlayOpen: hasBlockingDomOverlay(),
      });
      if (result.applied) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const [versionAxisOpen, setVersionAxisOpen] = useState(false);
  useEffect(() => {
    setVersionAxisOpen(false);
  }, [activeFile.file_id]);
  useEffect(() => {
    if (!versionAxisOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setVersionAxisOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest('[data-reader-version-axis]') ||
        target?.closest('[data-reader-version-axis-trigger]')
      ) {
        return;
      }
      setVersionAxisOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [versionAxisOpen]);

  const defaultFromRev =
    readingState?.last_read_revision_id &&
    readingState.last_read_revision_id !== activeFile.current_revision_id
      ? readingState.last_read_revision_id
      : activeFile.revisions[0]?.revision_id || activeFile.current_revision_id;
  const [customFromRevId, setCustomFromRevId] = useState<string>(defaultFromRev);
  const [customToRevId, setCustomToRevId] = useState<string>(activeFile.current_revision_id);

  const [svgZoom, setSvgZoom] = useState<number>(100);
  const [svgFullWidth, setSvgFullWidth] = useState<boolean>(false);
  const [showSvgSourceDiff, setShowSvgSourceDiff] = useState<boolean>(false);
  const [svgTextsExpanded, setSvgTextsExpanded] = useState<boolean>(false);

  const [activePdfPage, setActivePdfPage] = useState<number>(1);
  const [pdfViewMode, setPdfViewMode] = useState<'raw' | 'structured'>('raw');

  const readerProgressBarRef = useRef<HTMLDivElement | null>(null);
  const readerProgressTrackRef = useRef<HTMLDivElement | null>(null);
  const readingProgressRef = useRef<number>(0);
  const applyReadingProgress = useCallback((percent: number) => {
    const scaleX = computeReadingProgressScaleX(percent);
    readingProgressRef.current = percent;
    const bar = readerProgressBarRef.current;
    if (bar) bar.style.transform = `scaleX(${scaleX})`;
    const track = readerProgressTrackRef.current;
    if (track) {
      const rounded = Math.round(scaleX * 100);
      track.setAttribute('aria-valuenow', String(rounded));
      track.setAttribute('aria-valuetext', `${rounded}%`);
    }
  }, []);

  useEffect(() => {
    setActiveSectionId('');
    setActivePdfPage(1);
    if (markdownScrollRef.current) {
      markdownScrollRef.current.scrollTop = 0;
    }
    applyReadingProgress(0);
    setCustomToRevId(activeFile.current_revision_id);
    setCustomFromRevId(
      readingState?.last_read_revision_id &&
        readingState.last_read_revision_id !== activeFile.current_revision_id
        ? readingState.last_read_revision_id
        : activeFile.revisions[0]?.revision_id || activeFile.current_revision_id
    );
  }, [activeFile.file_id, applyReadingProgress]);

  const [anchorFlash, setAnchorFlash] = useState<{
    kind: 'md' | 'pdf' | 'svg';
    line?: number;
    page?: number;
    annotationId?: string;
  } | null>(null);
  const anchorFlashTimerRef = useRef(0);
  const flashAnchor = (flash: { kind: 'md' | 'pdf' | 'svg'; line?: number; page?: number; annotationId?: string } | null) => {
    window.clearTimeout(anchorFlashTimerRef.current);
    setAnchorFlash(flash);
    if (flash) {
      anchorFlashTimerRef.current = window.setTimeout(() => setAnchorFlash(null), 2200);
    }
  };
  useEffect(
    () => () => {
      window.clearTimeout(anchorFlashTimerRef.current);
    },
    []
  );
  const flashSourceLine =
    anchorFlash?.kind === 'md' && anchorFlash.line ? anchorFlash.line : undefined;
  const flashPdfPage =
    anchorFlash?.kind === 'pdf' && anchorFlash.page ? anchorFlash.page : undefined;
  const flashAnnotationId = anchorFlash?.annotationId ?? null;

  useEffect(() => {
    if (pdfAnchor?.kind === 'pdf_page' && pdfAnchor.page > 0) {
      setPdfViewMode('structured');
      setActivePdfPage(pdfAnchor.page);
      flashAnchor({ kind: 'pdf', page: pdfAnchor.page });
    }
  }, [pdfAnchor]);

  const [graphHopDepth, setGraphHopDepth] = useState<1 | 2>(1);

  const currentRev =
    activeFile.revisions.find((r) => r.revision_id === pinnedRevisionId) ||
    activeFile.revisions.find((r) => r.revision_id === activeFile.current_revision_id) ||
    activeFile.revisions[activeFile.revisions.length - 1];

  const latestRev =
    activeFile.revisions.find((r) => r.revision_id === activeFile.current_revision_id) ||
    activeFile.revisions[activeFile.revisions.length - 1];

  const hasNewerRevisionWhileReading = currentRev.revision_id !== latestRev.revision_id;
  const unreadStatus = hasUnreadChanges(activeFile, readingState);
  const rollbackInfo = detectRollbackRevision(activeFile.revisions, currentRev.revision_id);

  const miniVersionAxis: MiniVersionAxisNode[] = useMemo(
    () =>
      buildMiniVersionAxis(
        activeFile.revisions,
        currentRev.revision_id,
        latestRev.revision_id
      ),
    [activeFile.revisions, currentRev.revision_id, latestRev.revision_id]
  );

  const canOpenTimeMachineNow = canOpenTimeMachine(activeFile.format);

  const selectMiniVersion = (revisionId: string) => {
    if (!revisionId) return;
    onChangeRevision(revisionId);
    setVersionAxisOpen(false);
  };

  const compareMiniVersion = (revisionId: string) => {
    if (!revisionId) return;
    setCustomFromRevId(currentRev.revision_id);
    setCustomToRevId(revisionId);
    onChangeSubMode('diff_versions');
    setVersionAxisOpen(false);
  };

  const openVersionTimeMachine = () => {
    setVersionAxisOpen(false);
    onOpenTimeMachine?.();
  };

  const firstScreenKey = `${activeFile.file_id}::${currentRev.revision_id}`;
  const firstScreenStartRef = useRef<{ key: string; start: number } | null>(null);
  const firstScreenRecordedRef = useRef<string | null>(null);
  const firstScreenRootRef = useRef<HTMLDivElement | null>(null);
  if (firstScreenStartRef.current?.key !== firstScreenKey) {
    firstScreenStartRef.current = { key: firstScreenKey, start: readerFirstScreenNowMs() };
    firstScreenRecordedRef.current = null;
  }

  const activePackage = useMemo<TaskPackage | null>(() => {
    if (packageContext === undefined || packageContext === null) return null;
    if (packageContext.docs.some((d) => d.fileId === activeFile.file_id)) {
      return packageContext;
    }
    const pkgs = groupFilesIntoPackages(files);
    return pkgs.find((p) => p.docs.some((d) => d.fileId === activeFile.file_id)) ?? null;
  }, [packageContext, files, activeFile.file_id]);

  const activeFileStage = stageOfPath(activeFile.relative_path);

  const stateIndex = useMemo(() => indexStateOverview(stateOverview), [stateOverview]);
  const artifactState = artifactStateOf(stateIndex, activeFile.file_id);
  const activePackageProjection = useMemo(() => {
    if (!activePackage) return null;
    return projectInitiativeState(initiativeStateOfPackage(stateIndex, activePackage), {
      stage: activePackage.stage,
    });
  }, [activePackage, stateIndex]);

  const navigateToPackageDoc = (doc: PackageDoc) => {
    if (!doc || doc.fileId === activeFile.file_id) return;
    onNavigateLinkedFile(doc.fileId, {
      fileId: activeFile.file_id,
      revisionId: currentRev.revision_id,
      sectionId: activeSectionId || undefined,
      title: activeFile.title,
    });

  };
  
  const jumpToStageDoc = (role: StageRole) => {
    if (!activePackage) return;
    const doc = activePackage.readingOrder.find((d) => d.stage === role) ?? null;
    if (!doc) return;
    navigateToPackageDoc(doc);
  };

  const [fetchedContent, setFetchedContent] = useState<Record<string, string>>({});
  const [fetchError, setFetchError] = useState<Record<string, string>>({});
  const [fetchPending, setFetchPending] = useState<Record<string, boolean>>({});
  const contentKey = `${activeFile.file_id}::${currentRev.revision_id}`;
  useEffect(() => {
    if (activeFile.format !== 'md') return;
    if (currentRev.markdownContent !== undefined) return;
    if (fetchedContent[contentKey] !== undefined || fetchError[contentKey] !== undefined) return;
    const stored = getRevisionContent(currentRev.revision_id);
    if (stored?.state === 'ready') {
      setFetchedContent((prev) => ({ ...prev, [contentKey]: stored.text ?? '' }));
      return;
    }
    if (stored?.state === 'failed') {
      setFetchError((prev) => ({ ...prev, [contentKey]: stored.error || '按版本读取正文失败' }));
      return;
    }
    let cancelled = false;
    setFetchPending((prev) => ({ ...prev, [contentKey]: true }));
    requestRevisionContent(currentRev.revision_id, fetchRevisionContent, 'md').then((text) => {
      if (cancelled) return;
      setFetchPending((prev) => ({ ...prev, [contentKey]: false }));
      if (text === null) {
        const failedEntry = getRevisionContent(currentRev.revision_id);
        setFetchError((prev) => ({
          ...prev,
          [contentKey]:
            failedEntry?.code === 'SNAPSHOT_UNAVAILABLE'
              ? '此版本正文已过保留期（快照未内联且已被淘汰），仅保留版本元数据；可切换到仍保留快照的版本阅读。'
              : failedEntry?.error || '按版本读取正文失败',
        }));
        return;
      }
      setFetchedContent((prev) => ({ ...prev, [contentKey]: text }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeFile.format,
    contentKey,
    currentRev.revision_id,
    currentRev.markdownContent,
    fetchedContent,
    fetchError,
  ]);

  useEffect(() => {
    const start = firstScreenStartRef.current;
    if (!start || start.key !== firstScreenKey) return;
    if (firstScreenRecordedRef.current === firstScreenKey) return;
    firstScreenRecordedRef.current = firstScreenKey;
    const elapsedMs = readerFirstScreenNowMs() - start.start;
    const sample = recordReaderFirstScreenSample({
      fileId: activeFile.file_id,
      revisionId: currentRev.revision_id,
      elapsedMs,
      contentPending: !currentRev.markdownContent,
    });
    const root = firstScreenRootRef.current;
    if (root) {
      root.setAttribute('data-reader-first-screen-ms', String(Math.round(elapsedMs)));
      root.setAttribute('data-reader-first-screen-budget', sample.withinBudget ? 'ok' : 'over');
    }
    if (!sample.withinBudget) {
      console.warn(
        `[guanlan] ReaderView 首屏渲染 ${Math.round(elapsedMs)}ms 超出 ${READER_FIRST_SCREEN_BUDGET_MS}ms 预算`
      );
    }
  }, [firstScreenKey, activeFile.file_id, currentRev.revision_id, currentRev.markdownContent]);

  const pinnedRevisionRef = useRef<string | null>(null);
  useEffect(() => {
    const prevPinned = pinnedRevisionRef.current;
    pinnedRevisionRef.current = currentRev.revision_id;
    if (prevPinned && prevPinned !== currentRev.revision_id) unpinRevisionContent(prevPinned);
    pinRevisionContent(currentRev.revision_id);
  }, [currentRev.revision_id]);

  const markdownContent =
    currentRev.markdownContent ?? fetchedContent[contentKey] ?? '';

  const bodyPhase = resolveReaderBodyPhase({
    hasInlineContent: Boolean(currentRev.markdownContent),
    hasError: Boolean(fetchError[contentKey]),
    pending: Boolean(fetchPending[contentKey]),
  });

  const [sourceLineFallback, setSourceLineFallback] = useState<{
    target: number;
    landed: number;
  } | null>(null);
  useEffect(() => {
    if (!sourceLine || subMode !== 'read' || !markdownContent) {
      setSourceLineFallback(null);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const exact = document.querySelector(
        '[data-event-source-line="' + sourceLine + '"]'
      );
      if (exact) {
        exact.scrollIntoView({ block: 'center' });
        setSourceLineFallback(null);
        flashAnchor({ kind: 'md', line: sourceLine });
        return;
      }
      const landed = pickNearestSourceLineAnchor(
        collectRenderedSourceLineAnchors(document),
        sourceLine
      );
      if (landed === null) {
        setSourceLineFallback(null);
        return;
      }
      document
        .querySelector('[data-event-source-line="' + landed + '"]')
        ?.scrollIntoView({ block: 'center' });
      setSourceLineFallback({ target: sourceLine, landed });
      flashAnchor({ kind: 'md', line: landed });
    });
    return () => cancelAnimationFrame(frame);
  }, [sourceLine, subMode, markdownContent, contentKey]);

  const outline = useMemo(() => {
    if (activeFile.format !== 'md' || !markdownContent) return [];
    return parseMarkdownOutline(markdownContent);
  }, [activeFile.format, markdownContent]);

  const markdownLinkIndex = useMemo<MarkdownLinkIndex>(() => {
    const exactPath = new Map<string, FileRecord>();
    const firstExactIdx = new Map<string, number>();
    files.forEach((f, idx) => {
      if (!exactPath.has(f.relative_path)) {
        exactPath.set(f.relative_path, f);
        firstExactIdx.set(f.relative_path, idx);
      }
    });
    return {
      files,
      sourceFilePath: activeFile.relative_path,
      exactPath,
      firstExactIdx,
      resolveCache: new Map(),
    };
  }, [files, activeFile.relative_path]);

  const markdownBlocks = useMemo(
    () => buildMarkdownBlocks(markdownContent, markdownLinkIndex),
    [markdownContent, markdownLinkIndex]
  );

  const decisionFormItems = useMemo<Map<number, DecisionFormItem>>(
    () =>
      activeFile.format === 'md'
        ? parseDecisionFormItems(markdownContent)
        : new Map<number, DecisionFormItem>(),
    [activeFile.format, markdownContent]
  );

  const pendingDecisionBlocks = useMemo<DecisionBlock[]>(
    () =>
      activeFile.format === 'md'
        ? parseDecisionBlocks(markdownContent).filter((b) => b.status === '待确认')
        : [],
    [activeFile.format, markdownContent]
  );

  const docDecisionOptions = useMemo<string[]>(
    () => (activeFile.format === 'md' ? extractDecisionOptions(markdownContent) : []),
    [activeFile.format, markdownContent]
  );

  const [pendingStatements, setPendingStatements] = useState<StatementDetailDTO[] | null>(null);
  useEffect(() => {
    if (activeFile.format !== 'md' || !activeFile.file_id || !markdownContent) {
      setPendingStatements(null);
      return;
    }
    let cancelled = false;
    setPendingStatements(null);
    void (async () => {
      const res = await fetchStatements({
        file_id: activeFile.file_id,
        status: 'pending',
      });
      if (!cancelled) setPendingStatements(res.ok ? res.data.items : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFile.file_id, activeFile.format, markdownContent]);

  const statementByBlockLine = useMemo<Map<number, StatementDetailDTO>>(() => {
    const map = new Map<number, StatementDetailDTO>();
    if (pendingStatements) {
      for (const block of pendingDecisionBlocks) {
        const st = matchStatementToBlock(pendingStatements, block);
        if (st) map.set(block.line, st);
      }
    }
    return map;
  }, [pendingStatements, pendingDecisionBlocks]);

  const resolveCardByAnchor = useMemo<Map<number, DecisionBlock>>(() => {
    const map = new Map<number, DecisionBlock>();
    if (pendingDecisionBlocks.length === 0) return map;
    for (const block of pendingDecisionBlocks) {
      let anchor = block.line;
      for (const b of markdownBlocks) {
        if (b.line >= block.range[0] && b.line <= block.range[1]) anchor = Math.max(anchor, b.line);
      }
      map.set(anchor, block);
    }
    return map;
  }, [pendingDecisionBlocks, markdownBlocks]);

  const [resolveFlow, setResolveFlow] = useState<{
    blockLine: number;
    phase: 'submitting' | 'ok' | 'conflict' | 'error';
    message: string;
  } | null>(null);
  const [resolvedBlockLines, setResolvedBlockLines] = useState<ReadonlySet<number>>(new Set());

  const handleSubmitDecision = (block: DecisionBlock, values: DecisionResolveFormValues) => {
    const statement = statementByBlockLine.get(block.line);
    if (!statement || resolveFlow?.phase === 'submitting') return;
    const payload = buildDecisionResolvePayload(values);
    setResolveFlow({ blockLine: block.line, phase: 'submitting', message: '' });
    void (async () => {
      const accepted = await postDecisionResolve(statement.statement_id, payload);
      if (!accepted.ok) {
        setResolveFlow({
          blockLine: block.line,
          phase: 'error',
          message:
            accepted.code === 'CONFLICT'
              ? '该文档已归档，需先人工重开才能拍板'
              : accepted.error || '拍板请求提交失败',
        });
        return;
      }
      const settled = await pollJobUntilSettled(accepted.data.job_id);
      if (!settled.ok) {
        setResolveFlow({
          blockLine: block.line,
          phase: 'error',
          message: settled.error || '拍板任务轮询失败',
        });
        return;
      }
      const job = settled.data;
      if (job.state !== 'completed') {
        setResolveFlow({
          blockLine: block.line,
          phase: 'error',
          message: job.error || '拍板回写任务失败',
        });
        return;
      }
      const writeback =
        job.kind === 'decision_writeback'
          ? extractJobBranch<JobReportWriteback>(job, 'writeback')
          : null;
      if (!writeback || writeback.cas_ok === false) {
        setResolveFlow({
          blockLine: block.line,
          phase: 'conflict',
          message: '文件已被外部修改，拍板已存为草案——请比对后合并',
        });
        return;
      }
      setResolveFlow({
        blockLine: block.line,
        phase: 'ok',
        message: '拍板已回写至源文件，状态已变更为已确认',
      });
      setResolvedBlockLines((prev) => new Set(prev).add(block.line));
      const nextResolved = new Set(resolvedBlockLines).add(block.line);
      const blockingCleared = remainingBlockingCount(pendingDecisionBlocks, nextResolved) === 0;
      onDecisionResolved?.({
        decisionId: accepted.data.decision_id,
        statementId: statement.statement_id,
        fileId: activeFile.file_id,
        decisionText: values.decision,
        confirmer: values.confirmer,
        effectiveDate: values.effectiveDate,
        blockingCleared,
        lineStart: statement.line_start,
        lineEnd: statement.line_end,
      });
      if (blockingCleared) {
        onBlockingCleared?.({ fileId: activeFile.file_id });
      }
    })();
  };

  const renderDecisionResolveCard = (block: DecisionBlock): React.ReactNode => {
    const statement = statementByBlockLine.get(block.line) ?? null;
    const flow = resolveFlow?.blockLine === block.line ? resolveFlow : null;
    const linkedDecision = statement?.decision_id
      ? decisions.find((d) => d.decision_id === statement.decision_id)
      : undefined;
    const presetOptions = [
      ...new Set([
        ...docDecisionOptions,
        ...(statement?.options ?? []),
        ...(linkedDecision?.options ?? []),
      ]),
    ];
    return (
      <DecisionResolveCard
        block={block}
        statement={statement}
        presetOptions={presetOptions}
        recommendation={statement?.recommendation}
        impactBlocked={statement?.impact_blocked}
        impactAllowed={statement?.impact_allowed}
        paperLightMode={paperLightMode}
        submitting={flow?.phase === 'submitting'}
        onSubmit={(values) => handleSubmitDecision(block, values)}
        notice={
          flow && flow.phase !== 'submitting'
            ? {
                kind: flow.phase === 'ok' ? 'ok' : flow.phase === 'conflict' ? 'conflict' : 'error',
                message: flow.message,
              }
            : null
        }
        onShowDiff={flow?.phase === 'conflict' ? () => onChangeSubMode('diff_versions') : undefined}
      />
    );
  };

  const [receiptState, setReceiptState] = useState<{
    key: string;
    checks: Record<string, boolean>;
    fills: Record<string, string>;
  } | null>(null);
  const receiptStorageKey = `${activeFile.file_id}::${currentRev.revision_id}`;
  useEffect(() => {
    const snapshot = loadDecisionReceiptSnapshot(receiptStorageKey);
    const seedChecks: Record<string, boolean> = {};
    decisionFormItems.forEach((item, line) => {
      if (item.checkbox) seedChecks[line] = item.checkbox.initialChecked;
    });
    setReceiptState({
      key: receiptStorageKey,
      checks: { ...seedChecks, ...(snapshot?.checks ?? {}) },
      fills: snapshot?.fills ?? {},
    });
  }, [receiptStorageKey, decisionFormItems]);
  useEffect(() => {
    if (!receiptState || receiptState.key !== receiptStorageKey) return;
    saveDecisionReceiptSnapshot(receiptStorageKey, {
      checks: receiptState.checks,
      fills: receiptState.fills,
    });
  }, [receiptStorageKey, receiptState]);

  const toggleDecisionCheck = (line: number) => {
    setReceiptState((prev) => {
      if (!prev || prev.key !== receiptStorageKey) return prev;
      const nextChecks: Record<string, boolean> = {
        ...prev.checks,
        [line]: !prev.checks[line],
      };
      if (nextChecks[line]) {
        const zone = decisionFormItems.get(line)?.radio?.zoneId;
        if (zone !== undefined) {
          decisionFormItems.forEach((other, otherLine) => {
            if (otherLine !== line && other.radio?.zoneId === zone) {
              nextChecks[otherLine] = false;
            }
          });
        }
      }
      return { ...prev, checks: nextChecks };
    });
  };
  const setDecisionFillValue = (slotKey: string, value: string) => {
    setReceiptState((prev) => {
      if (!prev || prev.key !== receiptStorageKey) return prev;
      return { ...prev, fills: { ...prev.fills, [slotKey]: value } };
    });
  };

  const appliedScrollPercentRef = useRef<{ fileId: string; pct: number } | null>(null);
  const markdownScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
    };
  }, []);
  const handleMarkdownScroll = () => {
    const el = markdownScrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      applyReadingProgress(100);
      return;
    }
    const pct = Math.round((el.scrollTop / max) * 100);
    applyReadingProgress(pct);
    const fid = activeFile.file_id;
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
    }
    scrollSaveTimerRef.current = window.setTimeout(() => {
      scrollSaveTimerRef.current = null;
      onScrollProgress(fid, pct);
    }, 400);
  };
  const restoreByScrollPercent = () => {
    if (
      !openToScrollPercent ||
      openToScrollPercent <= 0 ||
      openToScrollPercent >= 100 ||
      sourceLine ||
      subMode !== 'read' ||
      activeFile.format !== 'md'
    ) {
      return false;
    }
    const el = markdownScrollRef.current;
    if (!el) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return false;
    const key = { fileId: activeFile.file_id, pct: openToScrollPercent };
    const applied = appliedScrollPercentRef.current;
    if (applied && applied.fileId === key.fileId && applied.pct === key.pct) return true;
    const totalLines = Math.max(1, (markdownContent || '').split('\n').length - 1);
    const secAt = outline.find((s) => s.startLine / totalLines >= openToScrollPercent / 100);
    if (secAt) setActiveSectionId(secAt.title);
    el.scrollTop = Math.round((openToScrollPercent / 100) * max);
    appliedScrollPercentRef.current = key;
    return true;
  };
  useEffect(() => {
    if (!openToScrollPercent || openToScrollPercent <= 0 || openToScrollPercent >= 100) return;
    if (sourceLine || subMode !== 'read' || activeFile.format !== 'md') return;
    restoreByScrollPercent();
  }, [
    openToScrollPercent,
    sourceLine,
    subMode,
    activeFile.format,
    activeFile.file_id,
    markdownContent,
    outline,
  ]);

  useEffect(() => {
    const el = markdownScrollRef.current;
    if (!el) {
      applyReadingProgress(0);
      return;
    }
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      applyReadingProgress(100);
      return;
    }
    applyReadingProgress(Math.round((el.scrollTop / max) * 100));
  }, [markdownContent, contentKey, applyReadingProgress]);

  const appliedFocusRef = useRef('');
  useEffect(() => {
    if (!focusSectionId || sourceLine || subMode !== 'read' || activeFile.format !== 'md') return;
    if (!markdownContent) return;
    const key = `${activeFile.file_id}::${focusSectionId}`;
    if (appliedFocusRef.current === key) return;
    const restored = appliedScrollPercentRef.current;
    if (restored && restored.fileId === activeFile.file_id && openToScrollPercent) return;
    const section = outline.find((s) => s.title === focusSectionId);
    if (!section) return;
    appliedFocusRef.current = key;
    setActiveSectionId(focusSectionId);
    const frame = requestAnimationFrame(() => scrollToSourceLine(section.startLine));
    return () => cancelAnimationFrame(frame);
  }, [focusSectionId, sourceLine, subMode, activeFile.format, markdownContent, outline, contentKey, activeFile.file_id, openToScrollPercent]);

  const effectiveFromRevId =
    subMode === 'diff_since_read'
      ? readingState?.last_read_revision_id || activeFile.revisions[0]?.revision_id
      : customFromRevId;
  const effectiveToRevId =
    subMode === 'diff_since_read' ? activeFile.current_revision_id : customToRevId;

  const diffPanelActive = subMode === 'diff_since_read' || subMode === 'diff_versions';

  const hasReadBaseline = Boolean(readingState?.last_read_revision_id);
  const compareBaselineRevId =
    readingState?.last_read_revision_id || activeFile.revisions[0]?.revision_id;
  const canCompareSinceRead =
    activeFile.revisions.length > 1 &&
    Boolean(compareBaselineRevId) &&
    (hasReadBaseline || compareBaselineRevId !== activeFile.current_revision_id);

  const [diffContents, setDiffContents] = useState<Record<string, string>>({});
  const [diffFetchFailed, setDiffFetchFailed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!diffPanelActive || activeFile.format !== 'md') return;
    const missing = [effectiveFromRevId, effectiveToRevId].filter((id) => {
      if (!id) return false;
      const rev = activeFile.revisions.find((r) => r.revision_id === id);
      if (!rev || !rev.snapshotAvailable || rev.markdownContent) return false;
      return diffContents[id] === undefined && !diffFetchFailed[id];
    });
    if (missing.length === 0) return;
    let cancelled = false;
    void fetchRevisionContentsBatch(missing).then(({ contents, failed }) => {
      if (cancelled) return;
      if (Object.keys(contents).length > 0) {
        setDiffContents((prev) => ({ ...prev, ...contents }));
      }
      if (Object.keys(failed).length > 0) {
        setDiffFetchFailed((prev) => ({
          ...prev,
          ...Object.fromEntries(Object.keys(failed).map((id) => [id, true])),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    diffPanelActive,
    activeFile.format,
    activeFile.revisions,
    effectiveFromRevId,
    effectiveToRevId,
    diffContents,
    diffFetchFailed,
  ]);

  const diffResult = useMemo<ReturnType<typeof computeMarkdownDiff> | null>(() => {
    if (!diffPanelActive) return null;
    return computeMarkdownDiff(
      activeFile,
      effectiveFromRevId,
      effectiveToRevId,
      diffContents
    );
  }, [diffPanelActive, activeFile, effectiveFromRevId, effectiveToRevId, diffContents]);

  const [semanticDiff, setSemanticDiff] = useState<{
    loading: boolean;
    result: DiffResult | null;
    error: string | null;
  }>({ loading: false, result: null, error: null });
  useEffect(() => {
    if (subMode !== 'diff_versions' || activeFile.format !== 'md') {
      setSemanticDiff({ loading: false, result: null, error: null });
      return;
    }
    if (!effectiveFromRevId || !effectiveToRevId || effectiveFromRevId === effectiveToRevId) {
      setSemanticDiff({ loading: false, result: null, error: null });
      return;
    }
    let cancelled = false;
    setSemanticDiff({ loading: true, result: null, error: null });
    void fetchDiffSummaryViaJob({
      file_id: activeFile.file_id,
      baseline_revision_id: effectiveFromRevId,
      target_revision_id: effectiveToRevId,
    }).then((res) => {
      if (cancelled) return;
      setSemanticDiff(
        res.ok
          ? { loading: false, result: res.data, error: null }
          : { loading: false, result: null, error: res.error || '任务队列不可用' }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [subMode, activeFile.format, activeFile.file_id, effectiveFromRevId, effectiveToRevId]);

  const pinnedDiffRef = useRef<string[]>([]);
  useEffect(() => {
    const next = [effectiveFromRevId, effectiveToRevId].filter(
      (id): id is string => Boolean(id)
    );
    for (const id of pinnedDiffRef.current) {
      if (!next.includes(id)) unpinRevisionContent(id);
    }
    for (const id of next) pinRevisionContent(id);
    pinnedDiffRef.current = next;
  }, [effectiveFromRevId, effectiveToRevId]);

  const changedSectionsOutline = useMemo<string[]>(() => {
    return computeChangedSectionsSinceRead(activeFile, readingState, {
      ...diffContents,
      ...(markdownContent ? { [currentRev.revision_id]: markdownContent } : {}),
    });
  }, [
    activeFile,
    readingState,
    diffContents,
    currentRev.revision_id,
    markdownContent,
  ]);

  const localGraphOrNull = useMemo<ReturnType<typeof buildLocalRelationGraph> | null>(() => {
    if (subMode !== 'relations') return null;
    return buildLocalRelationGraph(
      activeFile.file_id,
      graphHopDepth,
      files,
      decisions,
      relations
    );
  }, [subMode, activeFile.file_id, graphHopDepth, files, decisions, relations]);
  const localGraph =
    localGraphOrNull ??
    ({
      centerId: activeFile.file_id,
      depth: graphHopDepth,
      nodes: [],
      edges: [],
      truncatedCount: 0,
      canExpandTwoHop: false,
    } as ReturnType<typeof buildLocalRelationGraph>);

  const handleAddSectionToContext = (
    startLine: number,
    endLine: number,
    excerptText: string,
    noteText?: string
  ) => {
    onAddEvidencePointer({
      file_id: activeFile.file_id,
      revision_id: currentRev.revision_id,
      relative_path: activeFile.relative_path,
      content_sha256: currentRev.content_sha256,
      locator:
        activeFile.format === 'md'
          ? { kind: 'lines', start: startLine, end: endLine }
          : activeFile.format === 'pdf'
            ? { kind: 'pdf_page', page: activePdfPage }
            : { kind: 'file' },
      evidence_kind: 'explicit_source',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: activeFile.coverage,
      stale: hasNewerRevisionWhileReading,
      excerpt: excerptText.slice(0, 480),
      note: noteText,
    });
  };

  const decisionSelectedOptions: string[] = [];
  decisionFormItems.forEach((item, line) => {
    if (
      item.checkbox &&
      receiptState?.key === receiptStorageKey &&
      receiptState.checks[line]
    ) {
      decisionSelectedOptions.push(item.text);
    }
  });
  const decisionFillValues = (
    receiptState?.key === receiptStorageKey ? Object.entries(receiptState.fills) : []
  )
    .filter(([slotKey, value]) => value.trim().length > 0)
    .map(([slotKey, value]) => {
      const item = decisionFormItems.get(Number(slotKey.split(':')[0]));
      return item ? { prompt: fillPromptOf(item.text), value: value.trim() } : null;
    })
    .filter((v): v is { prompt: string; value: string } => v !== null);
  const decisionSelectedCount =
    decisionSelectedOptions.length + decisionFillValues.length;

  const [decisionCopied, setDecisionCopied] = useState<boolean>(false);
  useEffect(() => {
    setDecisionCopied(false);
  }, [receiptStorageKey]);
  const handleCopyDecisionInstruction = () => {
    const markdown = buildDecisionReceiptInstruction({
      title: activeFile.title,
      filePath: activeFile.relative_path,
      revisionId: currentRev.revision_id,
      selectedOptions: decisionSelectedOptions,
      fillValues: decisionFillValues,
      writtenBack: decisionSave === 'saved',
    });
    void copyTextWithDesktopFallback(markdown).then((res) => {
      if (!res.ok) return;
      setDecisionCopied(true);
      window.setTimeout(() => setDecisionCopied(false), 2000);
    });
  };
  const handleAddDecisionToBasket = () => {
    onAddDecisionToBasket?.({
      file_id: activeFile.file_id,
      title: activeFile.title,
      revision_id: currentRev.revision_id,
      selectedOptions: decisionSelectedOptions,
      fillValues: decisionFillValues,
    });
  };

  const decisionSaveBridge = readDecisionSaveBridge();
  const [decisionSave, setDecisionSave] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [decisionSaveError, setDecisionSaveError] = useState<string>('');
  useEffect(() => {
    setDecisionSave('idle');
    setDecisionSaveError('');
  }, [receiptStorageKey]);
  const handleSaveDecisionReceipt = () => {
    if (!decisionSaveBridge || decisionSave === 'saving') return;
    const newContent = buildWrittenBackMarkdown({
      markdownContent,
      items: decisionFormItems,
      checks: receiptState?.key === receiptStorageKey ? receiptState.checks : {},
      fills: receiptState?.key === receiptStorageKey ? receiptState.fills : {},
    });
    if (newContent === markdownContent) {
      setDecisionSaveError('没有可回写的变更：先勾选项或填写空栏。');
      return;
    }
    setDecisionSave('saving');
    setDecisionSaveError('');
    decisionSaveBridge({
      relativePath: activeFile.relative_path,
      originalContent: markdownContent,
      newContent,
    })
      .then(() => {
        setDecisionSave('saved');
      })
      .catch((err: unknown) => {
        setDecisionSave('idle');
        const errShape = (err ?? {}) as { code?: unknown; message?: unknown };
        const code = typeof errShape.code === 'string' ? errShape.code : '';
        const message =
          err instanceof Error
            ? err.message
            : typeof errShape.message === 'string'
              ? errShape.message
              : String(err);
        setDecisionSaveError(
          message === 'NOT_TAURI'
            ? '当前环境不支持回写原文件。'
            : code === 'CONFLICT'
              ? '原文件已被外部修改（磁盘内容与阅读快照不一致），请重开该文档后再试。'
              : `保存失败：${message || code || '未知错误'}`,
        );
      });
  };

  const [annotationStoreRev, setAnnotationStoreRev] = useState(0);
  const annotations = useMemo<ReaderAnnotation[]>(() => {
    if (
      activeFile.format !== 'md' &&
      activeFile.format !== 'svg' &&
      activeFile.format !== 'pdf'
    ) {
      return [];
    }
    if (!currentRev.content_sha256) return [];
    return annotationsOfVersion(loadAnnotationStore(), activeFile.file_id, currentRev.content_sha256);
  }, [activeFile.file_id, activeFile.format, currentRev.content_sha256, annotationStoreRev]);

  const annotationsByLine = useMemo<Map<number, ReaderAnnotation[]>>(() => {
    const map = new Map<number, ReaderAnnotation[]>();
    for (const a of annotations) {
      if (a.locator.kind !== 'md') continue;
      map.set(a.locator.startLine, [...(map.get(a.locator.startLine) ?? []), a]);
    }
    return map;
  }, [annotations]);
  const svgAnnotations = useMemo(
    () => annotations.filter((a) => a.locator.kind === 'svg'),
    [annotations]
  );
  const pdfAnnotationsByPage = useMemo<Map<number, ReaderAnnotation[]>>(() => {
    const map = new Map<number, ReaderAnnotation[]>();
    for (const a of annotations) {
      if (a.locator.kind !== 'pdf') continue;
      map.set(a.locator.page, [...(map.get(a.locator.page) ?? []), a]);
    }
    return map;
  }, [annotations]);

  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  useEffect(() => {
    setAnnotationsOpen(false);
  }, [activeFile.file_id, currentRev.revision_id]);

  const [annotationComposer, setAnnotationComposer] = useState<{
    target: ReaderAnnotationLocator;
    notice: { kind: 'ok' | 'error'; message: string } | null;
  } | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  useEffect(() => {
    setAnnotationComposer(null);
    setAnnotationBusy(false);
  }, [activeFile.file_id, currentRev.revision_id]);

  const [svgAnnotateMode, setSvgAnnotateMode] = useState(false);
  useEffect(() => {
    setSvgAnnotateMode(false);
  }, [activeFile.file_id, currentRev.revision_id]);

  const annotationReady = Boolean(currentRev.content_sha256);
  const annotationConvertAvailable = annotationReady && Boolean(decisionSaveBridge);
  const annotationConvertDisabledReason = !annotationReady
    ? '版本元数据加载中（内容哈希未就绪），暂不能批注。'
    : !decisionSaveBridge
      ? '当前环境不支持回写原文件（无桌面壳命令桥）；可先保存批注。'
      : '';

  const openAnnotationComposer = (target: ReaderAnnotationLocator) => {
    setAnnotationComposer({ target, notice: null });
  };
  const closeAnnotationComposer = () => setAnnotationComposer(null);
  const annotateFromBlock = (line: number, excerpt: string) => {
    openAnnotationComposer({ kind: 'md', startLine: line, excerpt: excerpt.slice(0, 480) });
  };
  const annotateFromSvgRegion = (region: { fx: number; fy: number; fw: number; fh: number }) => {
    openAnnotationComposer({ kind: 'svg', ...region });
  };
  const annotateFromPdfPage = (page: number, quote: string) => {
    openAnnotationComposer({ kind: 'pdf', page, quote: quote.slice(0, 480) });
  };

  const mutateAnnotationStore = (
    mutate: (store: ReturnType<typeof loadAnnotationStore>) => ReturnType<typeof loadAnnotationStore>
  ) => {
    persistAnnotationStore(mutate(loadAnnotationStore()));
    setAnnotationStoreRev((v) => v + 1);
  };

  const deleteAnnotation = (annotationId: string) => {
    if (!currentRev.content_sha256) return;
    mutateAnnotationStore((store) =>
      removeAnnotation(store, activeFile.file_id, currentRev.content_sha256, annotationId)
    );
  };

  const submitAnnotation = (noteRaw: string, convert: boolean) => {
    const target = annotationComposer?.target;
    if (!target || annotationBusy) return;
    const sha = currentRev.content_sha256;
    if (!sha) {
      setAnnotationComposer({
        target,
        notice: { kind: 'error', message: '版本元数据加载中（内容哈希未就绪），暂不能批注。' },
      });
      return;
    }
    const note = normalizeAnnotationNote(noteRaw);
    if (!note) {
      setAnnotationComposer({
        target,
        notice: { kind: 'error', message: '先写一句批注再保存或转决定项。' },
      });
      return;
    }
    const locatorLabel = formatAnnotationLocatorLabel(target);
    if (convert && target.kind === 'md') {
      const bridge = decisionSaveBridge;
      if (!bridge) {
        setAnnotationComposer({
          target,
          notice: {
            kind: 'error',
            message: annotationConvertDisabledReason || '当前环境不支持回写原文件。',
          },
        });
        return;
      }
      const insertAfter = insertionLineAfterBlock(
        markdownBlocks,
        target.kind === 'md' ? target.startLine : 0,
        (markdownContent || '').split('\n').length
      );
      const insertion = buildDecisionBlockInsertion({
        markdownContent,
        afterLine: insertAfter,
        note,
        locatorLabel,
      });
      if (!insertion.ok) {
        setAnnotationComposer({ target, notice: { kind: 'error', message: insertion.reason } });
        return;
      }
      setAnnotationBusy(true);
      bridge({
        relativePath: activeFile.relative_path,
        originalContent: markdownContent,
        newContent: insertion.newContent,
      })
        .then(() => {
          const annotationId = nextAnnotationId();
          mutateAnnotationStore((store) =>
            markAnnotationConverted(
              upsertAnnotation(store, activeFile.file_id, sha, {
                id: annotationId,
                note,
                created_at: new Date().toISOString(),
                converted: true,
                decision_text: note,
                locator: target,
              }).store,
              activeFile.file_id,
              sha,
              annotationId,
              note
            )
          );
          setAnnotationBusy(false);
          setAnnotationComposer({
            target,
            notice: {
              kind: 'ok',
              message: `已写入 [P1 - 待确认] 决定块（${locatorLabel} 后插入）；重扫后生成画布决定节点，点击即可反向定位回这里。`,
            },
          });
        })
        .catch((err: unknown) => {
          setAnnotationBusy(false);
          const errShape = (err ?? {}) as { code?: unknown; message?: unknown };
          const code = typeof errShape.code === 'string' ? errShape.code : '';
          const message =
            err instanceof Error
              ? err.message
              : typeof errShape.message === 'string'
                ? errShape.message
                : String(err);
          setAnnotationComposer({
            target,
            notice: {
              kind: 'error',
              message:
                code === 'CONFLICT'
                  ? '原文件已被外部修改（磁盘内容与阅读快照不一致），本次转换未落笔，请重开文档后再试。'
                  : `转换失败：${message || code || '未知错误'}`,
            },
          });
        });
      return;
    }
    const { store: nextStore, dropped } = upsertAnnotation(
      loadAnnotationStore(),
      activeFile.file_id,
      sha,
      {
        id: nextAnnotationId(),
        note,
        created_at: new Date().toISOString(),
        converted: convert && target.kind !== 'md',
        decision_text: convert && target.kind !== 'md' ? note : undefined,
        locator: target,
      }
    );
    persistAnnotationStore(nextStore);
    setAnnotationStoreRev((v) => v + 1);
    setAnnotationComposer({
      target,
      notice: {
        kind: 'ok',
        message:
          convert && target.kind !== 'md'
            ? '已存为本地决定草案（按版本哈希绑定；原始 SVG/PDF 字节零改动）。'
            : dropped > 0
              ? `批注已保存（超出 ${ANNOTATIONS_PER_VERSION_CAP} 条上限，本版本最旧 ${dropped} 条已淘汰）。`
              : `批注已保存（本地证据表，按版本哈希绑定 ${locatorLabel}）。`,
      },
    });
  };

  const jumpToAnnotation = (annotation: ReaderAnnotation) => {
    const loc = annotation.locator;
    if (loc.kind === 'md') {
      document
        .querySelector(`[data-event-source-line="${loc.startLine}"]`)
        ?.scrollIntoView({ block: 'center' });
      flashAnchor({ kind: 'md', line: loc.startLine, annotationId: annotation.id });
    } else if (loc.kind === 'pdf') {
      setActivePdfPage(loc.page);
      flashAnchor({ kind: 'pdf', page: loc.page, annotationId: annotation.id });
    } else {
      flashAnchor({ kind: 'svg', annotationId: annotation.id });
    }
  };

  const {
    renderInlineTokens,
    renderLinkParts,
    wrapLine,
    renderDecisionItemRow,
    renderMarkdownBlock,
  } = useReaderRender({
    paperLightMode,
    sourceLine,
    flashSourceLine,
    annotationsByLine,
    onAnnotateBlock: annotateFromBlock,
    onOpenAnnotations: () => setAnnotationsOpen(true),
    showLineNumbers,
    activeSectionId,
    activeFile,
    currentRev,
    receiptState,
    receiptStorageKey,
    decisionFormItems,
    markdownLinkIndex,
    markdownScrollRef,
    onNavigateLinkedFile,
    onMarkReadHere,
    readingState,
    handleAddSectionToContext,
    toggleDecisionCheck,
    setDecisionFillValue,
  });

  return {
    sourceLine,
    officeAnchor,
    pdfAnchor,
    files,
    activeFile,
    onChangeRevision,
    subMode,
    onChangeSubMode,
    readingState,
    onMarkReadHere,
    onMarkFullyRead,
    onMarkUnread,
    onToggleBookmark,
    onNavigateLinkedFile,
    returnBreadcrumb,
    onFollowReturnBreadcrumb,
    decisions,
    relations,
    onSelectDecision,
    onAddEvidencePointer,
    indexGeneration,
    inspectorOpen,
    onToggleInspector,
    onAddDecisionToBasket,
    systemActions,
    paperLightMode,
    setPaperLightMode,
    showLineNumbers,
    setShowLineNumbers,
    activeSectionId,
    setActiveSectionId,
    calloutsCollapsed,
    setCalloutsCollapsed,
    outlineOpen,
    setOutlineOpen,
    diffLayout,
    setDiffLayout,
    fileActionsOpen,
    setFileActionsOpen,
    fileActionsRef,
    zenMode,
    toggleZen,
    versionAxisOpen,
    setVersionAxisOpen,
    miniVersionAxis,
    selectMiniVersion,
    compareMiniVersion,
    canOpenTimeMachine: canOpenTimeMachineNow,
    onOpenTimeMachine: openVersionTimeMachine,
    readingNotice,
    onSilentMergeNotice,
    silentMergingNotice,
    onRefreshNoticeWindow,
    customFromRevId,
    setCustomFromRevId,
    customToRevId,
    setCustomToRevId,
    svgZoom,
    setSvgZoom,
    svgFullWidth,
    setSvgFullWidth,
    showSvgSourceDiff,
    setShowSvgSourceDiff,
    svgTextsExpanded,
    setSvgTextsExpanded,
    activePdfPage,
    setActivePdfPage,
    pdfViewMode,
    setPdfViewMode,
    graphHopDepth,
    setGraphHopDepth,
    currentRev,
    latestRev,
    hasNewerRevisionWhileReading,
    unreadStatus,
    rollbackInfo,
    activePackage,
    activeFileStage,
    artifactState,
    activePackageProjection,
    markdownContent,
    bodyPhase,
    sourceLineFallback,
    setSourceLineFallback,
    outline,
    markdownLinkIndex,
    markdownBlocks,
    decisionFormItems,
    pendingDecisionBlocks,
    docDecisionOptions,
    statementByBlockLine,
    resolveCardByAnchor,
    resolveFlow,
    receiptState,
    receiptStorageKey,
    effectiveFromRevId,
    effectiveToRevId,
    diffPanelActive,
    hasReadBaseline,
    canCompareSinceRead,
    diffResult,
    semanticDiff,
    changedSectionsOutline,
    localGraph,
    decisionSelectedOptions,
    decisionFillValues,
    decisionSelectedCount,
    decisionCopied,
    decisionSaveBridge,
    decisionSave,
    decisionSaveError,
    fetchError,
    setFetchError,
    contentKey,
    firstScreenRootRef,
    markdownScrollRef,
    readerProgressBarRef,
    readerProgressTrackRef,
    readingProgressRef,
    handleMarkdownScroll,
    toggleDecisionCheck,
    setDecisionFillValue,
    handleAddSectionToContext,
    renderInlineTokens,
    renderLinkParts,
    wrapLine,
    renderDecisionItemRow,
    renderMarkdownBlock,
    renderDecisionResolveCard,
    handleCopyDecisionInstruction,
    handleAddDecisionToBasket,
    handleSaveDecisionReceipt,
    jumpToStageDoc,
    anchorFlash,
    flashSourceLine,
    flashPdfPage,
    flashAnnotationId,
    annotations,
    annotationsByLine,
    svgAnnotations,
    pdfAnnotationsByPage,
    annotationsOpen,
    setAnnotationsOpen,
    annotationComposer,
    annotationBusy,
    annotationConvertAvailable,
    annotationConvertDisabledReason,
    svgAnnotateMode,
    setSvgAnnotateMode,
    annotateFromBlock,
    annotateFromSvgRegion,
    annotateFromPdfPage,
    closeAnnotationComposer,
    submitAnnotation,
    deleteAnnotation,
    jumpToAnnotation,
  };
}

/** 阅读器分节渲染层消费的控制器上下文（类型随控制器自动演化，零手工镜像）。 */
export type ReaderCtx = ReturnType<typeof useReaderController>;
