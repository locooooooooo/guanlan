
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DecisionAssertion,
  DecisionSourceEvidence,
  EvidencePointer,
  FileRecord,
  OfficeEvidenceAnchor,
  PdfEvidenceAnchor,
  ReadingState,
  RelationEdge,
  TimelineEvent,
  TimelineEventKind,
  WorkspaceConfig,
} from '../types/guanlan';
import {
  formatContextForAgent,
  hasUnreadChanges,
  searchWorkspaceCapped,
  SearchHit,
} from '../utils/guanlanEngine';
import {
  fetchBootstrap,
  fetchEventDays,
  fetchEventPage,
  fetchAllFileSummaries,
  fetchIndexJobStatus,
  fetchRelations,
  fetchFileHistory,
  fetchRevisionContent,
  fetchWorkspaceStatus,
  fileSummaryToFileRecord,
  revisionsFromHistory,
  extractSvgTextNodes,
  folderOfRelativePath,
  startIndexJob,
  fetchRevisionProposals,
  fetchRevisionProposalContent,
  fetchReviewBoard,
  fetchStateOverview,
  fetchDecisions,
  fetchCheckpoints,
  fetchServerReadingStates,
  postBatchReadingState,
  postDecisionResolve,
  postInitiativeArchive,
  postInitiativeReopen,
  postRepairOrphan,
  extractJobBranch,
  getApiBaseUrl,
  pollJobUntilSettled,
  postRevisionProposalAdopt,
  postRevisionProposalDismiss,
  setApiBaseUrl,
  subscribeWorkspaceStream,
  WorkspaceSource,
  type EventDayGranularity,
  type EventDaysResult,
  type EventPage,
  type EventPageItem,
  type EventTimeRange,
  type FileSummary,
  type FileFacets,
  type JobReportAdopt,
  type JobReportOrphanRepair,
  type JobReportWriteback,
  type RevisionProposalContentResponse,
  type ReviewBoardResponse,
  type WorkspaceSummary,
  type WorkspaceStatusResponse,
} from '../services/workspaceClient';
import type {
  OrphanRepairAction,
  ReviewBoardDraftBrief,
  ReviewBoardPendingStatement,
  StateOverviewResponse,
} from '../services/apiTypes';
import { bucketRange } from '../utils/graphEvents';
import {
  clearRevisionContentStore,
  getRevisionContent,
  mergeDetailRevisionsPreservingContent,
  requestRevisionContent,
} from '../utils/revisionContentStore';
import { clearFilePreviewCache } from '../utils/filePreviewCache';
import { isL4aProgressActive, resetL4aProgress, setL4aProgress } from '../utils/l4aProgressStore';
import {
  copyTextWithDesktopFallback,
  getInitialDesktopSession,
  importDesktopExternalFiles,
  isDesktopSystemBridgeAvailable,
  isDesktopWorkspaceBridgeAvailable,
  openWithDesktopDefaultApp,
  pickDesktopExternalFiles,
  pickDesktopWorkspaceFolder,
  refreshDesktopSession,
  removeRecentDesktopWorkspace,
  resolveDesktopAbsolutePath,
  revealInDesktopExplorer,
  subscribeNativeDragDrop,
  switchDesktopWorkspace,
  type DesktopSessionState,
} from '../services/desktopBridge';
import {
  displayFolderLabel,
  normalizeRelativeWorkspacePath,
  validateImportTargetDir,
} from '../utils/workspacePaths';
import { fileNameOf } from '../utils/fileOps';
import { extractCoreSummary, groupFilesIntoPackages, taskPackageOf } from '../utils/taskPackages';
import type { TaskPackage } from '../utils/taskPackages';
import { formatLocalClock, localDay } from '../utils/timeFormat';
import { calendarWindowEventQuery } from '../utils/calendarEventWindow';
import {
  applyBatchMarkUnread,
  applyBatchReadingBaseline,
  loadReadingStates,
  markFileUnreadState,
  mergeServerReadingStates,
  nowLocalIso,
  pruneReadingStates,
  READING_STATE_PERSIST_DEBOUNCE_MS,
  restoreReadingStatesSnapshot,
  saveReadingStates,
} from '../utils/readingStateStore';
import { createCoalescedPersist, type CoalescedPersist } from '../utils/coalescedPersist';
import {
  loadMutedFolders,
  normalizeMutedFolderPath,
  saveMutedFolders,
  toggleMutedFolderList,
} from '../utils/sidebarTree';
import {
  buildAgentContextPreset,
  type AgentContextPreset,
  type ContextCandidate,
  type PresetPackageInfo,
  type PresetRelationRef,
  type PresetUnresolvedDecision,
} from '../utils/agentContextPresets';
import { isSensitiveSecretPath } from '../utils/contextSanitizer';
import type { ContextGranularity } from '../services/apiTypes';
import type {
  GuanlanContextBlockerLine,
  GuanlanContextDecisionLine,
} from '../utils/agentContextExport';
import type { ProposalToastData } from '../components/ProposalToast';
import {
  buildDecisionChangeNote,
  decisionChangeNoteFromAssertion,
  type DecisionChangeNote,
} from '../utils/decisionChangeNote';
import {
  DECIDED_DECISION_STATUSES,
  DOC_STATE_LABEL,
  artifactStateOf,
  indexStateOverview,
  initiativeStateOfPackage,
  isUnresolvedDecision,
} from '../utils/stateProjection';
import {
  deliveredInitiativesOf,
  initiativeArchiveWarn,
} from '../utils/initiativeLifecycle';
import { basenameOf } from '../utils/documentIdentity';
import { isTimeMachineFormat } from '../utils/formatMeta';
import {
  applyCanvasTheme,
  getCanvasTheme,
  readCanvasTheme,
  type CanvasTheme,
} from '../utils/canvasThemeStore';
import { LibraryMode, PrimaryTab } from '../components/TopHeader';
import { pageItemToEvent } from '../components/TimelineView';
import type { PanoramaMode } from '../components/GraphCanvasView';
import { enterEventFrame, type EventFrame } from '../components/KnowledgeGraph';
import { SidebarFilters } from '../components/LeftSidebar';
import {
  ReaderSubMode,
  ReturnBreadcrumb,
} from '../components/ReaderView';
import type { DecisionReceiptBasketPayload } from '../components/ReaderView';
import type {
  FileContextMenuState,
  FileContextMenuTarget,
} from '../components/FileContextMenu';
import type { SystemActionFeedbackToast } from '../components/DragDropImportOverlay';
import type { FileOpSubmitPayload, ReferenceImpactState } from '../components/FileOpsModal';
import { useFileOps } from '../hooks/useFileOps';
import { useDirectoryShell } from '../hooks/useDirectoryShell';
import {
  useMultiProjects,
  type PendingCrossProjectTarget,
} from '../hooks/useMultiProjects';
import { collectMergedFolderOptions } from '../utils/sidebarTree';
import { useFileOpHistory } from '../hooks/useFileOpHistory';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { mergeIncrementalEventPage } from '../utils/virtualSlice';
import {
  hasBlockingDomOverlay,
  isEditableLikeTarget,
  type ShortcutAction,
} from '../utils/keyboardShortcuts';
import {
  defaultNavSourceLabel,
  describeNavSourceReturn,
  peekNavSource,
  popNavSource,
  pushNavSource,
  type NavSourceEntry,
} from '../utils/navigationSourceStack';
import { useReferencePathRepair } from '../hooks/useReferencePathRepair';
import {
  computeSmartViewFiles,
  isSmartViewScope,
  smartViewIdSet,
  SMART_VIEWS,
  type SmartViewId,
} from '../utils/smartViews';
import {
  computeSpotlightChanges,
  computeSpotlightDimmedFileIds,
} from '../utils/readingSpotlight';
import type { SpotlightChangeItem } from '../utils/readingSpotlight';
import { useCommandPalette } from '../hooks/useCommandPalette';
import { useMountedWorkspaces } from '../hooks/useMountedWorkspaces';
import { recordMountedReading } from '../utils/mountReadingPositions';
import { localDayOf } from '../utils/commandPaletteGrammar';
import type { PaletteFileLite, PaletteItem } from '../utils/commandPaletteResults';
import { useQuickPreview } from '../hooks/useQuickPreview';
import { Tabs } from '../components/ui/primitives';
import { toastManager } from '../components/ui/toast';

export const EMPTY_WORKSPACE_CONFIG: WorkspaceConfig = {
  rootPath: '',
  rootKey: '',
  dataDirPath: '',
  excludedDirs: [],
  disableGitIgnore: false,
  gitIgnoreWarning: '',
  enumSnapshot: {
    date: '',
    mdCount: 0,
    svgCount: 0,
    pdfCount: 0,
    totalCount: 0,
    indexedSuccessCount: 0,
    parseFailedCount: 0,
    pdfUnindexedCount: 0,
  },
  quota: {
    maxTotalMiB: 0,
    usedTotalMiB: 0,
    maxSingleBinaryMiB: 0,
    protectedSnapshotsCount: 0,
    evictedSnapshotsCount: 0,
  },
  runtimeStatus: {
    connectionMode: 'direct_stdio',
    serviceState: 'disconnected',
    sseSeq: 0,
    indexGeneration: 0,
    activeAgents: [],
    loopbackUrl: '',
  },
};

export const DAYS_QUERY_LIMIT = 120;

export const INITIAL_CANVAS_THEME = readCanvasTheme();

const PANORAMA_MODE_OPTIONS: { value: PanoramaMode; label: string }[] = [
  { value: 'canvas', label: '星图' },
  { value: 'list', label: '列表' },
  { value: 'calendar', label: '日历' },
];

const TIMELINE_RETURN_TARGET: { activeTab: PrimaryTab; panoramaMode: PanoramaMode } = {
  activeTab: 'panorama',
  panoramaMode: 'canvas',
};

/** timeline 家族统一回填返回面包屑（唯一写入口） */
export const timelineReturnBreadcrumb = (label: string): ReturnBreadcrumb => ({
  fromType: 'timeline',
  label,
});

function daysWindow(
  order: 'occurred' | 'observed',
  range: EventTimeRange | null,
  drill: { from: string; to: string } | null
): { from?: string; to?: string } {
  if (drill) return drill;
  if (!range) return {};
  const min = order === 'observed' ? range.observedMin : range.occurredMin;
  const max = order === 'observed' ? range.observedMax : range.occurredMax;
  return { from: min || undefined, to: max || undefined };
}

function sameDayQuery(
  a: {
    granularity: EventDayGranularity;
    order: 'occurred' | 'observed';
    drill: { from: string; to: string } | null;
  },
  b: {
    granularity: EventDayGranularity;
    order: 'occurred' | 'observed';
    drill: { from: string; to: string } | null;
  }
): boolean {
  return (
    a.granularity === b.granularity &&
    a.order === b.order &&
    (a.drill?.from ?? '') === (b.drill?.from ?? '') &&
    (a.drill?.to ?? '') === (b.drill?.to ?? '')
  );
}

function detectDropFolderAt(x: number, y: number): string | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return null;
  }
  const hit = document.elementFromPoint(x, y);
  const folderEl = hit?.closest?.('[data-drop-folder]') as HTMLElement | null;
  if (!folderEl) return null;
  return folderEl.getAttribute('data-drop-folder') ?? null;
}

function draftTimestampIndex(items: { file_id: string; created_at: string }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const item of items) {
    if (!item.created_at || Number.isNaN(Date.parse(item.created_at))) continue;
    const prev = index.get(item.file_id);
    if (prev === undefined || Date.parse(item.created_at) > Date.parse(prev)) {
      index.set(item.file_id, item.created_at);
    }
  }
  return index;
}

const SPOTLIGHT_EMPTY_DIMMED: ReadonlySet<string> = new Set<string>();
const SPOTLIGHT_EMPTY_ITEMS: SpotlightChangeItem[] = [];
const EMPTY_FOLDER_OPTIONS: string[] = [];


export function useWorkspaceStore() {
  const [desktopSession, setDesktopSession] = useState<DesktopSessionState | null>(() =>
    getInitialDesktopSession()
  );
  const desktopBridgeAvailable = isDesktopWorkspaceBridgeAvailable();
  const desktopSystemAvailable = isDesktopSystemBridgeAvailable();
  const hasActiveBackend = !desktopSession || desktopSession.status === 'ready';
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const switchingWorkspaceRef = useRef(false);
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);
  const readingWorkspaceIdRef = useRef<string | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [systemToast, setSystemToast] = useState<SystemActionFeedbackToast | null>(null);
  const systemToastSeqRef = useRef(0);
  const [dragDropOverlay, setDragDropOverlay] = useState<{
    active: boolean;
    paths: string[];
    hoveredFolder: string | null;
  }>({ active: false, paths: [], hoveredFolder: null });

  const [config, setConfig] = useState<WorkspaceConfig>(EMPTY_WORKSPACE_CONFIG);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [hydratedFilesById, setHydratedFilesById] = useState<Record<string, FileRecord>>({});
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [decisions, setDecisions] = useState<DecisionAssertion[]>([]);
  const [decisionsUnresolvedTotal, setDecisionsUnresolvedTotal] = useState<number | null>(null);
  const [relations, setRelations] = useState<RelationEdge[]>([]);
  const fileCacheRef = useRef(new Map<string, FileRecord>());
  const detailLoadedIdsRef = useRef(new Set<string>());
  const [filesTotal, setFilesTotal] = useState(0);
  const [fileFacets, setFileFacets] = useState<FileFacets | null>(null);
  const [readingStates, setReadingStates] = useState<Record<string, ReadingState>>(() =>
    desktopSession ? {} : loadReadingStates()
  );
  const readingStatesRef = useRef(readingStates);
  readingStatesRef.current = readingStates;
  const resumeReqSeqRef = useRef(0);
  const readingBatchBusyRef = useRef(false);
  const [mutedFolders, setMutedFolders] = useState<string[]>(() =>
    desktopSession ? [] : loadMutedFolders()
  );

  const [dataSource, setDataSource] = useState<'loading' | WorkspaceSource>('loading');
  const [dataError, setDataError] = useState<string | null>(null);
  const [scanSummary, setScanSummary] = useState<string>('');

  const [eventDays, setEventDays] = useState<EventDaysResult | null>(null);
  const [activeDate, setActiveDate] = useState<string | undefined>(undefined);
  const [eventPage, setEventPage] = useState<EventPage | null>(null);
  const [eventPageLoading, setEventPageLoading] = useState(false);
  const [undatedOnly, setUndatedOnly] = useState(false);
  const [eventOrder, setEventOrder] = useState<'occurred' | 'observed'>('occurred');
  const [eventKindFilter, setEventKindFilter] = useState<TimelineEventKind | 'all'>('all');
  const eventKindFilterRef = useRef<TimelineEventKind | 'all'>('all');
  const currentEventKinds = () =>
    eventKindFilterRef.current === 'all' ? undefined : [eventKindFilterRef.current];

  const [dayGranularity, setDayGranularity] = useState<EventDayGranularity>('day');
  const [drillRange, setDrillRange] = useState<{ from: string; to: string } | null>(null);
  const dayQueryRef = useRef<{
    granularity: EventDayGranularity;
    order: 'occurred' | 'observed';
    drill: { from: string; to: string } | null;
  }>({ granularity: 'day', order: 'occurred', drill: null });
  const [changeNotice, setChangeNotice] = useState<{ count: number; at: string } | null>(null);

  const [rescanState, setRescanState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [rescanError, setRescanError] = useState<string>('');
  const [activeJobId, setActiveJobId] = useState<string>('');
  const rescanInFlightRef = useRef(false);
  const lifecycleInFlightRef = useRef(false);
  const silentMergeInFlightRef = useRef(false);
  const retryInFlightRef = useRef(false);
  const [networkOffline, setNetworkOffline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false
  );
  const [streamDisconnected, setStreamDisconnected] = useState<boolean>(false);
  const streamEverConnectedRef = useRef(false);
  const streamDisconnectedRef = useRef(false);
  const [retryingConnection, setRetryingConnection] = useState<boolean>(false);
  const [pollTick, setPollTick] = useState(0);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [serviceStatus, setServiceStatus] = useState<WorkspaceStatusResponse | null>(null);
  const [stateOverview, setStateOverview] = useState<StateOverviewResponse | null>(null);
  const [agentDraftFileIds, setAgentDraftFileIds] = useState<Set<string>>(new Set());
  const [agentDraftAtByFileId, setAgentDraftAtByFileId] = useState<Map<string, string>>(
    new Map()
  );
  const [spotlightEnabled, setSpotlightEnabled] = useState(false);
  const [spotlightCursor, setSpotlightCursor] = useState(0);

  const [eventDataReady, setEventDataReady] = useState(false);
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary | null>(null);
  const [eventRange, setEventRange] = useState<EventTimeRange | null>(null);
  const [dateFilter, setDateFilter] = useState<{ from?: string; to?: string }>({});
  const dateFilterRef = useRef<{ from?: string; to?: string }>({});
  const eventFetchGenRef = useRef(0);
  const [historyFileId, setHistoryFileId] = useState<string>('');

  const [activeTab, setActiveTab] = useState<PrimaryTab>('home');
  const [panoramaMode, setPanoramaMode] = useState<PanoramaMode>('canvas');
  const portholeRef = useRef<HTMLDivElement>(null);
  const handleCanvasThemeChange = (next: CanvasTheme) => {
    if (next === getCanvasTheme()) return;
    const porthole = portholeRef.current;
    if (porthole) {
      porthole.classList.remove('theme-morphing');
      porthole.classList.add('theme-morphing');
      porthole.dataset.canvasTheme = next;
    }
    applyCanvasTheme(next);
  };
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('read');
  const [eventTrail, setEventTrail] = useState<EventFrame[]>([]);
  const [activeFileId, setActiveFileId] = useState<string>('');
  const [pinnedRevisionId, setPinnedRevisionId] = useState<string>('');
  const [readerSubMode, setReaderSubMode] = useState<ReaderSubMode>('read');
  const [readerAnchor, setReaderAnchor] = useState<{
    fileId: string;
    revisionId: string;
    line: number;
    officeAnchor?: OfficeEvidenceAnchor;
    pdfAnchor?: PdfEvidenceAnchor;
  } | null>(null);
  const [readerFocusSection, setReaderFocusSection] = useState<{
    fileId: string;
    sectionId: string;
  } | null>(null);
  const readerScrollPercentRef = useRef<{ fileId: string; scrollPercent: number } | undefined>(undefined);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [selectedDecisionId, setSelectedDecisionId] = useState<string>('');
  const [returnBreadcrumb, setReturnBreadcrumb] =
    useState<ReturnBreadcrumb | null>(null);
  const [navSourceStack, setNavSourceStack] = useState<NavSourceEntry[]>([]);
  const navSourceStackRef = useRef<NavSourceEntry[]>([]);
  const trailEnteredFromStackRef = useRef(false);
  const prevTrailLenRef = useRef(0);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sidebarFilters, setSidebarFilters] = useState<SidebarFilters>({
    quickScope: 'all',
    folder: 'all',
    format: 'all',
    role: 'all',
    topic: 'all',
  });

  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isMcpConsoleOpen, setIsMcpConsoleOpen] = useState<boolean>(false);
  const [isContextDrawerOpen, setIsContextDrawerOpen] = useState<boolean>(false);
  const [isReviewBoardOpen, setIsReviewBoardOpen] = useState<boolean>(false);
  const [isChronosDigestOpen, setIsChronosDigestOpen] = useState<boolean>(false);
  const [reviewBoard, setReviewBoard] = useState<ReviewBoardResponse | null>(null);
  const [reviewBoardLoading, setReviewBoardLoading] = useState<boolean>(false);
  const [reviewBoardError, setReviewBoardError] = useState<string | null>(null);
  const [reviewBoardBusyKey, setReviewBoardBusyKey] = useState<string | null>(null);
  const [reviewBoardNotice, setReviewBoardNotice] = useState<{
    kind: 'ok' | 'error';
    message: string;
  } | null>(null);
  const [isMobileLeftOpen, setIsMobileLeftOpen] = useState<boolean>(false);
  const [isMobileRightOpen, setIsMobileRightOpen] = useState<boolean>(false);
  const [libraryInspectorOpen, setLibraryInspectorOpen] = useState<boolean>(false);
  const [overviewInspectorCollapsed, setOverviewInspectorCollapsed] = useState<boolean>(false);
  const [silentMergingEvents, setSilentMergingEvents] = useState<boolean>(false);
  const [decisionRadarSignal, setDecisionRadarSignal] = useState<number>(0);
  const [contextPointers, setContextPointers] = useState<EvidencePointer[]>([]);
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);

  const paletteFileLite = useMemo<PaletteFileLite[]>(
    () =>
      files.map((f) => ({
        file_id: f.file_id,
        relative_path: f.relative_path,
        title: f.title,
        format: f.format,
        current_revision_id: f.current_revision_id,
        coverage: f.coverage,
        last_observed_at: f.revisions[0]?.observed_at,
        status: 'active',
      })),
    [files]
  );
  const mountedWs = useMountedWorkspaces();
  const [multiProjectCount, setMultiProjectCount] = useState(1);
  const multiProjectsRefreshRef = useRef<(() => void) | null>(null);
  const palette = useCommandPalette({
    files: paletteFileLite,
    readingStates,
    initiatives: stateOverview?.initiatives ?? [],
    artifacts: stateOverview?.artifacts ?? [],
    recentWorkspaces:
      desktopSession?.recentWorkspaces?.map((w) => w.root).filter((r): r is string => Boolean(r)) ?? [],
    mountedWorkspaces: mountedWs.mounts,
    multiProjectCount,
  });
  const { isOpen: isPaletteOpen, close: closePalette } = palette;
  const [isMountPanelOpen, setMountPanelOpen] = useState(false);

  const readingPersistRef = useRef<CoalescedPersist | null>(null);
  if (readingPersistRef.current === null) {
    readingPersistRef.current = createCoalescedPersist(() => {
      const workspaceId = readingWorkspaceIdRef.current;
      if (!workspaceId) return;
      saveReadingStates(readingStatesRef.current, workspaceId);
    }, READING_STATE_PERSIST_DEBOUNCE_MS);
  }
  const readingPersist = readingPersistRef.current;
  useEffect(() => {
    if (!readingWorkspaceIdRef.current) return;
    readingPersist.schedule();
  }, [readingPersist, readingStates]);
  useEffect(() => {
    const flush = () => readingPersist.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [readingPersist]);

  useEffect(() => {
    if (!readingWorkspaceIdRef.current) return;
    saveMutedFolders(mutedFolders, readingWorkspaceIdRef.current);
  }, [mutedFolders]);


  const publishTimerRef = useRef<number | null>(null);
  const publishFiles = useCallback(() => {
    if (publishTimerRef.current !== null) {
      window.clearTimeout(publishTimerRef.current);
    }
    publishTimerRef.current = window.setTimeout(() => {
      publishTimerRef.current = null;
      const list = Array.from(fileCacheRef.current.values()).sort((a, b) =>
        a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0
      );
      setFiles(list);
    }, 150);
  }, []);
  useEffect(() => {
    return () => {
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, []);

  const publishContentFor = useCallback((fileId: string) => {
    const updated = fileCacheRef.current.get(fileId);
    if (!updated) return;
    setFiles((prev) => {
      const idx = prev.findIndex((r) => r.file_id === fileId);
      if (idx < 0) return prev;
      const next = prev.slice();
      next[idx] = updated;
      return next;
    });
  }, []);

  const applyFileSummaries = useCallback(
    (items: FileSummary[]) => {
      const invalidatedHydratedIds: string[] = [];
      const refreshedHydrated = new Map<string, FileRecord>();
      for (const item of items) {
        if (item.status === 'missing' || item.status === 'trashed') {
          if (detailLoadedIdsRef.current.has(item.file_id)) {
            detailLoadedIdsRef.current.delete(item.file_id);
            invalidatedHydratedIds.push(item.file_id);
          }
          continue;
        }
        const existing = fileCacheRef.current.get(item.file_id);
        const next = fileSummaryToFileRecord(item);
        if (existing && detailLoadedIdsRef.current.has(item.file_id)) {
          const hasCurrent =
            !next.current_revision_id ||
            existing.revisions.some((r) => r.revision_id === next.current_revision_id);
          if (existing.current_revision_id === next.current_revision_id && hasCurrent) {
            next.revisions = existing.revisions;
            refreshedHydrated.set(item.file_id, next);
          } else {
            detailLoadedIdsRef.current.delete(item.file_id);
            invalidatedHydratedIds.push(item.file_id);
            const seen = new Set(existing.revisions.map((r) => r.revision_id));
            next.revisions = [
              ...existing.revisions,
              ...next.revisions.filter((r) => !seen.has(r.revision_id)),
            ];
          }
        }
        fileCacheRef.current.set(item.file_id, next);
      }
      if (invalidatedHydratedIds.length > 0 || refreshedHydrated.size > 0) {
        setHydratedFilesById((prev) => {
          let changed = false;
          for (const id of invalidatedHydratedIds) {
            if (id in prev) {
              changed = true;
              break;
            }
          }
          if (!changed) {
            for (const id of refreshedHydrated.keys()) {
              if (id in prev) {
                changed = true;
                break;
              }
            }
          }
          if (!changed) return prev;
          const nextMap = { ...prev };
          for (const id of invalidatedHydratedIds) delete nextMap[id];
          for (const [id, rec] of refreshedHydrated) {
            if (id in nextMap) nextMap[id] = rec;
          }
          return nextMap;
        });
      }
      publishFiles();
    },
    [publishFiles]
  );

  const mergeEventsPage = useCallback((items: EventPageItem[]) => {
    if (!items.length) return;
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.event_id));
      const additions = items.filter((i) => !seen.has(i.event_id)).map(pageItemToEvent);
      return additions.length ? [...additions, ...prev] : prev;
    });
  }, []);

  const ensureFileDetail = useCallback(
    async (fileId: string): Promise<FileRecord | null> => {
      const cached = fileCacheRef.current.get(fileId);
      if (cached && detailLoadedIdsRef.current.has(fileId)) return cached;
      const history = await fetchFileHistory(fileId);
      if (!history) return null;
      const incoming = revisionsFromHistory(fileId, history.revisions, history.events);
      const revisions = mergeDetailRevisionsPreservingContent(
        cached?.revisions ?? [],
        incoming,
        history.file.format === 'svg' ? 'svg' : 'md',
        getRevisionContent,
        extractSvgTextNodes
      ) as FileRecord['revisions'];
      const base: FileRecord =
        cached ??
        ({
          file_id: history.file.file_id,
          relative_path: history.file.current_path,
          title: history.file.title,
          format: history.file.format,
          folder: folderOfRelativePath(history.file.current_path),
          role: history.file.role as FileRecord['role'],
          roleProvenance: '来自路径',
          topics: [],
          current_revision_id: history.file.last_revision_id || '',
          revisions: [],
          coverage: 'filename_only',
          pdfStatus: history.file.format === 'pdf' ? 'unindexed' : undefined,
        } as FileRecord);
      const merged: FileRecord = {
        ...base,
        revisions,
        current_revision_id: history.file.last_revision_id || base.current_revision_id,
      };
      const catalogUnchanged =
        Boolean(cached) &&
        cached!.current_revision_id === merged.current_revision_id &&
        cached!.relative_path === merged.relative_path &&
        cached!.title === merged.title;
      fileCacheRef.current.set(fileId, merged);
      detailLoadedIdsRef.current.add(fileId);
      setHydratedFilesById((prev) => ({ ...prev, [fileId]: merged }));
      if (!catalogUnchanged) {
        publishFiles();
      }
      return merged;
    },
    [publishFiles]
  );

  const ensureRevisionContent = useCallback(
    async (fileId: string, revisionId: string) => {
      const file = fileCacheRef.current.get(fileId);
      const rev = file?.revisions.find((r) => r.revision_id === revisionId);
      if (!file || !rev || !rev.snapshotAvailable) return;
      if (file.format === 'md' && rev.markdownContent !== undefined) return;
      if (file.format === 'svg' && rev.svgSource !== undefined) return;
      if (file.format !== 'md' && file.format !== 'svg') return;
      const format = file.format === 'svg' ? 'svg' : 'md';
      const text = await requestRevisionContent(revisionId, fetchRevisionContent, format);
      if (text === null) return;
      const current = fileCacheRef.current.get(fileId);
      if (!current) return;
      const revisions = current.revisions.map((r) => {
        if (r.revision_id !== revisionId) return r;
        if (current.format === 'md') {
          return r.markdownContent !== undefined ? r : { ...r, markdownContent: text };
        }
        return r.svgSource !== undefined
          ? r
          : { ...r, svgSource: text, svgExtractedTexts: extractSvgTextNodes(text) };
      });
      const updated = { ...current, revisions };
      fileCacheRef.current.set(fileId, updated);
      setHydratedFilesById((prev) => ({ ...prev, [fileId]: updated }));
      if (current.format === 'svg') {
        publishContentFor(fileId);
      }
    },
    [publishContentFor]
  );

  useEffect(() => {
    if (!hasActiveBackend) return;
    let cancelled = false;
    (async () => {
      const dq = dayQueryRef.current;
      const [boot, overview, serverReadingRes] = await Promise.all([
        fetchBootstrap({
          daysLimit: DAYS_QUERY_LIMIT,
          daysSamples: 6,
          daysGranularity: dq.granularity,
          filesPageSize: 100,
          eventsLimit: 50,
        }),
        fetchStateOverview(),
        fetchServerReadingStates(),
      ]);
      if (cancelled) return;
      setStateOverview(overview.ok ? overview.data : null);
      void (async () => {
        const proposals = await fetchRevisionProposals({ status: 'proposed', limit: 100 });
        if (cancelled) return;
        setAgentDraftFileIds(
          proposals.ok
            ? new Set(proposals.data.items.map((item) => item.file_id))
            : new Set()
        );
        setAgentDraftAtByFileId(
          proposals.ok ? draftTimestampIndex(proposals.data.items) : new Map()
        );
      })();
      if (!boot.ok || !boot.data) {
        if (switchingWorkspaceRef.current) return;
        setDataSource('error');
        setDataError(boot.error || '启动对账未完成：读服务无响应。可重启观澜后重试。');
        return;
      }
      const b = boot.data;
      const serverReadingItems = serverReadingRes.ok ? serverReadingRes.data.items : [];
      if (readingWorkspaceIdRef.current !== b.workspace.workspace_id) {
        readingWorkspaceIdRef.current = b.workspace.workspace_id;
        const localLoaded = loadReadingStates(b.workspace.workspace_id);
        setReadingStates(
          mergeServerReadingStates(localLoaded, serverReadingItems, {
            authoritative: serverReadingRes.ok,
          })
        );
        setMutedFolders(loadMutedFolders(b.workspace.workspace_id));
      } else if (serverReadingRes.ok) {
        setReadingStates((prev) =>
          mergeServerReadingStates(prev, serverReadingItems, { authoritative: true })
        );
      }
      if (bootstrapNonce > 0) {
        setEvents([]);
        setChangeNotice(null);
        eventFetchGenRef.current += 1;
      }
      setConfig(b.config);
      setDecisions(b.decisions);
      setDecisionsUnresolvedTotal(
        typeof b.decisions_unresolved_total === 'number' ? b.decisions_unresolved_total : null
      );
      setEventDays(b.event_days);
      setEventPage(b.events);
      setEventRange(b.time_range);
      setWorkspaceSummary({
        ok: true,
        workspace_id: b.workspace.workspace_id,
        root_path: b.workspace.root_path,
        index_generation: b.workspace.index_generation,
        last_scan_at: b.workspace.last_scan_at,
        baseline: b.baseline,
        counts: b.counts,
        time_range: b.time_range,
      });
      mergeEventsPage(b.events.items);
      const seenFileIds = new Set<string>();
      const applyRound = (items: FileSummary[]) => {
        for (const item of items) seenFileIds.add(item.file_id);
        applyFileSummaries(items);
      };
      applyRound(b.files.items);
      setFilesTotal(b.files_total);
      setFileFacets(b.files.facets);
      setEventDataReady(true);
      setDataSource('real');
      setDataError(null);
      setScanSummary(
        [
          `${b.counts.files} 个文件 · ${b.counts.revisions} 个版本`,
          b.baseline ? '基线已建立' : '增量对账',
          `${b.counts.events} 条事件`,
        ]
          .filter(Boolean)
          .join(' · ')
      );
      if (b.decisions.length > 0) {
        setSelectedDecisionId((prev) => prev || b.decisions[0].decision_id);
      }
      setSelectedEventId((prev) => prev || b.events.items[0]?.event_id || '');

      const rest = await fetchAllFileSummaries(
        { limit: 200, cursor: b.files.next_cursor || undefined },
        (page) => {
          if (cancelled) return;
          applyRound(page.items);
          if (page.facets) setFileFacets(page.facets);
          if (typeof page.total_matched === 'number') setFilesTotal(page.total_matched);
        }
      );
      if (cancelled) return;
      const restComplete =
        rest.ok &&
        (typeof rest.total_matched !== 'number' || seenFileIds.size === rest.total_matched);
      if (restComplete) {
        for (const id of Array.from(fileCacheRef.current.keys())) {
          if (!seenFileIds.has(id)) fileCacheRef.current.delete(id);
        }
        publishFiles();
      }
      const all = Array.from(fileCacheRef.current.values()).sort((x, y) =>
        x.relative_path < y.relative_path ? -1 : x.relative_path > y.relative_path ? 1 : 0
      );
      const firstReadable = all.find((f) => f.format === 'md') || all[0] || null;
      if (firstReadable) {
        setActiveFileId((prev) => prev || firstReadable.file_id);
        setPinnedRevisionId((prev) => prev || firstReadable.current_revision_id);
      }
      if (restComplete) {
        setReadingStates((prev) =>
          pruneReadingStates(prev, all, b.recoverable_file_ids ?? [])
        );
      }

      const rel = await fetchRelations();
      if (!cancelled && rel.ok) {
        setRelations(rel.data.items);
      }

      const status = await fetchWorkspaceStatus();
      if (cancelled || !status.ok) return;
      setServiceStatus(status.data);
      const activeJob = status.data.active_jobs[0];
      if (activeJob) {
        setActiveJobId(activeJob.job_id);
        setRescanError('');
        setRescanState('running');
      } else if (status.data.index_generation > b.workspace.index_generation) {
        setBootstrapNonce((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyFileSummaries, bootstrapNonce, hasActiveBackend, mergeEventsPage, publishFiles, workspaceEpoch]);

  const l4aWasActiveRef = useRef(false);
  const pollL4aRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!hasActiveBackend || switchingWorkspace) {
      l4aWasActiveRef.current = false;
      setL4aProgress(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      const status = await fetchWorkspaceStatus();
      if (cancelled) return;
      const progress = status.ok ? (status.data.l4a_progress ?? null) : null;
      const active = isL4aProgressActive(progress);
      if (l4aWasActiveRef.current && !active && progress && progress.done > 0) {
        toastManager.add({
          title: '后台语义沉淀已完成',
          description: `已整理 ${progress.done} 篇文档摘要`,
          type: 'success',
        });
      }
      l4aWasActiveRef.current = active;
      setL4aProgress(active ? progress : null);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), active ? 2500 : 15000);
    };
    pollL4aRef.current = poll;
    void poll();
    return () => {
      cancelled = true;
      pollL4aRef.current = null;
      window.clearTimeout(timer);
    };
  }, [hasActiveBackend, switchingWorkspace, workspaceEpoch]);

  useEffect(() => {
    if (!hasActiveBackend || switchingWorkspace || rescanState !== 'running' || !activeJobId) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const status = await fetchIndexJobStatus(activeJobId);
      if (cancelled || switchingWorkspaceRef.current) return;
      if (!status.ok) {
        rescanInFlightRef.current = false;
        setRescanState('error');
        setRescanError(status.error || '索引任务状态查询失败');
        return;
      }
      const job = status.data;
      if (job.state === 'completed') {
        rescanInFlightRef.current = false;
        setRescanState('done');
        setRescanError('');
        setBootstrapNonce((n) => n + 1);
      } else if (job.state === 'failed') {
        rescanInFlightRef.current = false;
        setRescanState('error');
        setRescanError(job.error || '索引任务失败');
      } else {
        setPollTick((t) => t + 1);
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeJobId, hasActiveBackend, pollTick, rescanState, switchingWorkspace, workspaceEpoch]);

  const handleRescan = useCallback(async () => {
    if (switchingWorkspaceRef.current || rescanInFlightRef.current || rescanState === 'running') {
      return;
    }
    rescanInFlightRef.current = true;
    setRescanState('running');
    setRescanError('');
    const accepted = await startIndexJob('verify_all');
    if (switchingWorkspaceRef.current) {
      rescanInFlightRef.current = false;
      return;
    }
    if (!accepted.ok) {
      rescanInFlightRef.current = false;
      setRescanState('error');
      setRescanError(accepted.error || '索引任务提交失败，请检查网络连接后重试');
      return;
    }
    setActiveJobId(accepted.data.job_id);
  }, [rescanState]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOffline = () => setNetworkOffline(true);
    const handleOnline = () => {
      setNetworkOffline(false);
      setStreamDisconnected(false);
      setBootstrapNonce((n) => n + 1);
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  const handleRetryConnection = useCallback(async () => {
    if (switchingWorkspaceRef.current || retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    setRetryingConnection(true);
    try {
      const status = await fetchWorkspaceStatus();
      if (switchingWorkspaceRef.current) return;
      if (!status.ok) {
        setDataError(status.error || '读服务暂时不可用，请确认服务已启动后重试');
        setDataSource('error');
        return;
      }
      setNetworkOffline(false);
      setStreamDisconnected(false);
      setDataError(null);
      setRescanError('');
      if (rescanState === 'error') {
        rescanInFlightRef.current = false;
        setRescanState('idle');
      }
      setServiceStatus(status.data);
      setBootstrapNonce((n) => n + 1);
    } finally {
      retryInFlightRef.current = false;
      setRetryingConnection(false);
    }
  }, [rescanState]);

  useEffect(() => {
    if (rescanState !== 'done') return;
    const timer = window.setTimeout(() => setRescanState('idle'), 4000);
    return () => window.clearTimeout(timer);
  }, [rescanState]);

  useEffect(() => {
    if (!activeFileId) return;
    void ensureFileDetail(activeFileId);
  }, [activeFileId, ensureFileDetail]);

  const activeHydratedFile = activeFileId ? hydratedFilesById[activeFileId] : undefined;
  useEffect(() => {
    if (!activeFileId) return;
    const file = fileCacheRef.current.get(activeFileId);
    if (!file) return;
    const rev =
      file.revisions.find((r) => r.revision_id === pinnedRevisionId) ||
      file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
      file.revisions[0];
    if (!rev || !rev.snapshotAvailable) return;
    if (file.format === 'md' && rev.markdownContent) return;
    if (file.format === 'svg' && rev.svgSource) return;
    if (file.format !== 'md' && file.format !== 'svg') return;
    void ensureRevisionContent(file.file_id, rev.revision_id);
  }, [activeFileId, activeHydratedFile, files, pinnedRevisionId, ensureRevisionContent]);


  const escKeyDownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '\\') {
        e.preventDefault();
        dirShell.toggleSidebarCollapsed();
        return;
      }
      if (e.key === 'Escape') {
        if (isPaletteOpen) {
          closePalette();
          return;
        }
        if (multiProjects.addProjectModalOpen) {
          multiProjects.setAddProjectModalOpen(false);
          multiProjects.setAddProjectError(null);
          return;
        }
        if (dirShell.dirOpModal) {
          dirShell.closeDirOpModal();
          return;
        }
        if (quickPreviewTarget) {
          closeQuickPreview();
          return;
        }
        if (isMountPanelOpen) {
          setMountPanelOpen(false);
          return;
        }
        if (fileContextMenu) {
          setFileContextMenu(null);
          return;
        }
        if (fileOpModal) {
          closeFileOp();
          return;
        }
        if (historyFileId !== '') return;
        if (isSettingsOpen) {
          setIsSettingsOpen(false);
          return;
        }
        if (isMcpConsoleOpen) {
          setIsMcpConsoleOpen(false);
          return;
        }
        if (isContextDrawerOpen) {
          setIsContextDrawerOpen(false);
          return;
        }
        if (isReviewBoardOpen) {
          setIsReviewBoardOpen(false);
          return;
        }
        if (isChronosDigestOpen) {
          setIsChronosDigestOpen(false);
          return;
        }
        if (isHelpOpen) {
          setIsHelpOpen(false);
          return;
        }
        if (searchQuery) {
          setSearchQuery('');
          return;
        }
        if (returnBreadcrumb) {
          handleFollowReturnBreadcrumb();
          return;
        }
        if (navSourceStackRef.current.length > 0) {
          const popped = popNavSource(navSourceStackRef.current);
          if (popped.entry) {
            navSourceStackRef.current = popped.stack;
            setNavSourceStack(popped.stack);
            restoreNavSourceEntry(popped.entry);
            return;
          }
        }
        if (dateFilterRef.current.from) {
          void applyDayFilter(undefined);
          return;
        }
        if (activeDate !== undefined) {
          setActiveDate(undefined);
          return;
        }
        if (activeTab !== 'panorama') {
          setActiveTab('panorama');
        }
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isEditableLikeTarget(e.target)) {
          return;
        }
        if (!isHelpOpen && hasBlockingDomOverlay()) {
          return;
        }
        e.preventDefault();
        setIsHelpOpen((v) => !v);
      }
    };
    escKeyDownHandlerRef.current = handleKeyDown;
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => escKeyDownHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const smartViewArtifactsByFileId = useMemo(
    () => indexStateOverview(stateOverview)?.artifactsByFileId ?? null,
    [stateOverview]
  );
  const smartViewFiles = useMemo(
    () =>
      computeSmartViewFiles({
        files,
        readingStates,
        artifactsByFileId: smartViewArtifactsByFileId,
        agentDraftFileIds,
        nowMs: Date.now(),
      }),
    [agentDraftFileIds, files, readingStates, smartViewArtifactsByFileId]
  );
  const activeSmartView: SmartViewId | null = isSmartViewScope(sidebarFilters.quickScope)
    ? sidebarFilters.quickScope
    : null;
  const activeSmartMemberIds = useMemo(
    () => (activeSmartView ? smartViewIdSet(smartViewFiles, activeSmartView) : null),
    [activeSmartView, smartViewFiles]
  );

  const spotlightItems = useMemo(
    () =>
      spotlightEnabled
        ? computeSpotlightChanges({
            files,
            readingStates,
            artifactsByFileId: smartViewArtifactsByFileId,
            agentDraftAtByFileId,
            nowMs: Date.now(),
          })
        : SPOTLIGHT_EMPTY_ITEMS,
    [agentDraftAtByFileId, files, readingStates, smartViewArtifactsByFileId, spotlightEnabled]
  );
  const spotlightDimmedFileIds = useMemo(
    () =>
      spotlightEnabled
        ? computeSpotlightDimmedFileIds(files, readingStates, spotlightItems)
        : SPOTLIGHT_EMPTY_DIMMED,
    [files, readingStates, spotlightEnabled, spotlightItems]
  );
  const handleSpotlightToggle = useCallback(() => {
    setSpotlightEnabled((v) => {
      if (!v) setSpotlightCursor(0);
      return !v;
    });
  }, []);
  const handleSpotlightCursor = useCallback((cursor: number) => {
    setSpotlightCursor(cursor);
  }, []);

  const sidebarFilterActive =
    sidebarFilters.quickScope !== 'all' ||
    sidebarFilters.folder !== 'all' ||
    sidebarFilters.format !== 'all' ||
    sidebarFilters.role !== 'all' ||
    sidebarFilters.topic !== 'all';

  const filteredFiles = useMemo(() => {
    if (!sidebarFilterActive) return files;
    return files.filter((f) => {
      const st = readingStates[f.file_id];
      if (activeSmartMemberIds && !activeSmartMemberIds.has(f.file_id)) {
        return false;
      }
      if (
        sidebarFilters.quickScope === 'unread' &&
        !hasUnreadChanges(f, st).isUnread
      ) {
        return false;
      }
      if (sidebarFilters.quickScope === 'bookmarked' && !st?.bookmarked) {
        return false;
      }
      if (
        sidebarFilters.folder !== 'all' &&
        f.folder !== sidebarFilters.folder &&
        !f.folder.startsWith(`${sidebarFilters.folder}/`)
      ) {
        return false;
      }
      if (sidebarFilters.format !== 'all' && f.format !== sidebarFilters.format) {
        return false;
      }
      if (sidebarFilters.role !== 'all' && f.role !== sidebarFilters.role) {
        return false;
      }
      if (
        sidebarFilters.topic !== 'all' &&
        !f.topics.some((t) => t.name === sidebarFilters.topic)
      ) {
        return false;
      }
      return true;
    });
  }, [activeSmartMemberIds, files, readingStates, sidebarFilterActive, sidebarFilters]);

  const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  const activeFile = useMemo(() => {
    const base = (activeFileId ? fileById.get(activeFileId) : undefined) || files[0];
    return base ? hydratedFilesById[base.file_id] ?? base : base;
  }, [activeFileId, fileById, files, hydratedFilesById]);

  const packageList = useMemo<TaskPackage[]>(
    () => groupFilesIntoPackages(files),
    [files]
  );
  const activePackage = useMemo<TaskPackage | null>(() => {
    if (!activeFile) return null;
    const id = taskPackageOf(activeFile.relative_path).id;
    return (
      packageList.find((p) => p.id === id) ??
      packageList.find((p) => p.docs.some((d) => d.fileId === activeFile.file_id)) ??
      null
    );
  }, [packageList, activeFile]);

  const stateOverviewIndex = useMemo(() => indexStateOverview(stateOverview), [stateOverview]);
  const focusedContextTarget = useMemo<{
    fileId: string | null;
    pkg: TaskPackage | null;
  }>(() => {
    if (activeTab === 'library' && libraryMode === 'read') {
      return { fileId: activeFileId || null, pkg: activePackage };
    }
    if (
      activeTab === 'library' &&
      libraryMode === 'overview' &&
      sidebarFilters.folder !== 'all'
    ) {
      const folderNorm = sidebarFilters.folder;
      const pkg =
        packageList.find(
          (p) =>
            p.id === folderNorm ||
            p.name === folderNorm ||
            folderNorm.startsWith(`${p.id}/`)
        ) ?? null;
      return { fileId: null, pkg };
    }
    return { fileId: null, pkg: null };
  }, [activeTab, libraryMode, activeFileId, activePackage, sidebarFilters.folder, packageList]);

  const activeInitiative = useMemo(() => {
    const pkg = focusedContextTarget.pkg;
    if (!pkg || pkg.id === '__root__') return null;
    const row = initiativeStateOfPackage(stateOverviewIndex, pkg);
    return {
      id: row?.initiative_id ?? pkg.id,
      name: row?.name ?? pkg.name,
      stage: row?.current_stage ?? pkg.stage,
      state: row?.state ?? null,
    };
  }, [focusedContextTarget.pkg, stateOverviewIndex]);

  const referenceMetaOf = useCallback((p: EvidencePointer) => {
    const file = fileCacheRef.current.get(p.file_id);
    const revisions = file?.revisions ?? [];
    const rev = revisions.find((r) => r.revision_id === p.revision_id);
    const versionLabel =
      typeof rev?.versionNumber === 'number' ? `v${rev.versionNumber}` : null;
    const isCurrentRevision = file?.current_revision_id === p.revision_id;
    const artifact = artifactStateOf(stateOverviewIndex, p.file_id);
    return {
      versionLabel,
      stateLabel: isCurrentRevision && artifact ? DOC_STATE_LABEL[artifact.state] : null,
    };
  }, [stateOverviewIndex]);

  const [contextSessionCheckpointId, setContextSessionCheckpointId] = useState<string | null>(null);
  const activeInitiativeId = activeInitiative?.id ?? null;
  useEffect(() => {
    if (!hasActiveBackend || !isContextDrawerOpen || !activeInitiativeId) {
      setContextSessionCheckpointId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetchCheckpoints({
        initiative_id: activeInitiativeId,
        status: 'SUCCESS',
        limit: 1,
      });
      if (cancelled) return;
      setContextSessionCheckpointId(res.ok ? res.data.items[0]?.checkpoint_id ?? null : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasActiveBackend, isContextDrawerOpen, activeInitiativeId, workspaceEpoch]);

  const packageInfos = useMemo<PresetPackageInfo[]>(
    () =>
      packageList.map((p) => ({
        id: p.id,
        name: p.name,
        stage: p.stage,
        lastActivity: p.lastActivity,
        eventCount: p.eventCount,
        docIds: p.readingOrder.map((d) => d.fileId),
        coreDocId: p.readingOrder.find((d) => /readme|总览|核心定位/i.test(d.title))?.fileId,
        stageDocIds: p.readingOrder.filter((d) => d.stage === p.stage).map((d) => d.fileId),
      })),
    [packageList]
  );
  const unresolvedDecisionRefs = useMemo<PresetUnresolvedDecision[]>(
    () =>
      decisions
        .filter((d) => isUnresolvedDecision(d))
        .map((d) => ({
          decisionId: d.decision_id,
          fileId: d.evidences[0]?.file_id ?? '',
          code: d.code,
          question: d.question,
          isBlocking: d.impactBlocked.length > 0 || d.code === 'P0' || d.code === 'P1',
        }))
        .filter((d) => d.fileId),
    [decisions]
  );
  const relationRefs = useMemo<PresetRelationRef[]>(
    () =>
      relations
        .filter((r) => fileCacheRef.current.has(r.source_id) && fileCacheRef.current.has(r.target_id))
        .map((r) => ({ sourceFileId: r.source_id, targetFileId: r.target_id })),
    [relations]
  );
  const focusedPackageInfo = useMemo<PresetPackageInfo | null>(
    () =>
      focusedContextTarget.pkg
        ? packageInfos.find((pi) => pi.id === focusedContextTarget.pkg?.id) ?? null
        : null,
    [focusedContextTarget.pkg, packageInfos]
  );
  const agentContextPreset = useMemo<AgentContextPreset>(
    () =>
      buildAgentContextPreset({
        activeFileId: focusedContextTarget.fileId,
        activePackage: focusedPackageInfo,
        packages: packageInfos,
        unresolvedDecisions: unresolvedDecisionRefs,
        relations: relationRefs,
      }),
    [focusedContextTarget.fileId, focusedPackageInfo, packageInfos, unresolvedDecisionRefs, relationRefs]
  );

  const candidateToPointers = useCallback(
    (candidates: readonly ContextCandidate[]): EvidencePointer[] => {
      const out: EvidencePointer[] = [];
      for (const c of candidates) {
        const f = fileCacheRef.current.get(c.fileId);
        if (!f || isSensitiveSecretPath(f.relative_path)) continue;
        const rev =
          f.revisions.find((r) => r.revision_id === f.current_revision_id) ??
          f.revisions[f.revisions.length - 1];
        out.push({
          file_id: f.file_id,
          revision_id: rev?.revision_id ?? '',
          relative_path: f.relative_path,
          content_sha256: rev?.content_sha256 ?? '',
          locator: { kind: 'file' },
          evidence_kind: 'metadata_only',
          index_generation: config.runtimeStatus.indexGeneration,
          observed_at: rev?.observed_at ?? '',
          coverage: f.coverage,
          stale: false,
          excerpt: extractCoreSummary(f),
          granularity: c.granularity,
          sizeBytes: rev?.sizeBytes ?? 0,
        });
      }
      return out;
    },
    [config.runtimeStatus.indexGeneration]
  );
  const presetPointers = useMemo<EvidencePointer[]>(
    () => candidateToPointers(agentContextPreset.items),
    [candidateToPointers, agentContextPreset]
  );
  const recommendedMounts = useMemo<Array<{ pointer: EvidencePointer; reason: string }>>(
    () =>
      agentContextPreset.recommended
        .map((r) => ({ pointer: candidateToPointers([r])[0], reason: r.reason }))
        .filter((x) => x.pointer !== undefined),
    [candidateToPointers, agentContextPreset]
  );

  const handleMountPointers = useCallback((items: EvidencePointer[]) => {
    setContextPointers((prev) => {
      const seen = new Set(prev.map((p) => `${p.file_id}::${p.revision_id}::${p.locator.kind}`));
      const additions = items.filter(
        (p) => !seen.has(`${p.file_id}::${p.revision_id}::${p.locator.kind}`)
      );
      return additions.length ? [...prev, ...additions] : prev;
    });
  }, []);

  const openContextDrawer = useCallback(() => {
    if (presetPointers.length > 0) handleMountPointers(presetPointers);
    setIsContextDrawerOpen(true);
  }, [handleMountPointers, presetPointers]);

  const handleUpdatePointerGranularity = useCallback(
    (index: number, granularity: ContextGranularity) => {
      setContextPointers((prev) =>
        prev.map((p, i) => (i === index ? { ...p, granularity } : p))
      );
    },
    []
  );

  const pendingBlockerLines = useMemo<GuanlanContextBlockerLine[]>(
    () =>
      decisions
        .filter((d) => isUnresolvedDecision(d))
        .slice(0, 6)
        .map((d) => {
          const ev = d.evidences[0];
          return {
            priority: d.code || 'D',
            statusLabel: d.status === '来源不一致' ? '来源不一致' : '待确认',
            text: d.question,
            fileRef: ev ? `${ev.relative_path}#L${ev.lineStart}` : null,
          };
        }),
    [decisions]
  );

  const [proposalToast, setProposalToast] = useState<ProposalToastData | null>(null);
  const [proposalAdopting, setProposalAdopting] = useState(false);
  const [proposalRejecting, setProposalRejecting] = useState(false);
  const [proposalAdoptNotice, setProposalAdoptNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [proposalDiffExpanded, setProposalDiffExpanded] = useState(false);
  const [proposalDiffLoading, setProposalDiffLoading] = useState(false);
  const [proposalDiffError, setProposalDiffError] = useState<string | null>(null);
  const [proposalDiffContent, setProposalDiffContent] =
    useState<RevisionProposalContentResponse | null>(null);

  const [decisionChangeNote, setDecisionChangeNote] = useState<DecisionChangeNote | null>(null);
  const [decisionChangeToast, setDecisionChangeToast] = useState<DecisionChangeNote | null>(null);
  const lastPushedDecisionRef = useRef<{ decisionId: string; at: number } | null>(null);
  const pushDecisionChangeNote = useCallback((note: DecisionChangeNote) => {
    const now = Date.now();
    const last = lastPushedDecisionRef.current;
    const duplicate = last?.decisionId === note.decisionId && now - last.at < 10_000;
    lastPushedDecisionRef.current = { decisionId: note.decisionId, at: now };
    setDecisionChangeNote((prev) => {
      if (duplicate && prev?.source === 'inline' && note.source === 'writeback') return prev;
      return note;
    });
    if (!duplicate) setDecisionChangeToast(note);
  }, []);
  useEffect(() => {
    if (isContextDrawerOpen) setDecisionChangeToast(null);
  }, [isContextDrawerOpen]);

  const confirmedDecisionLines = useMemo<GuanlanContextDecisionLine[]>(
    () =>
      decisions
        .filter((d) => d.status === '已确认' && !d.isCandidateOnly)
        .slice(0, 6)
        .map((d) => {
          const note = decisionChangeNote?.decisionId === d.decision_id ? decisionChangeNote : null;
          return {
            priority: d.code || 'D',
            statusLabel: '已确认',
            text: note?.decisionText || d.confirmationBasis?.recordText || d.question,
            confirmer: note?.confirmer ?? d.confirmationBasis?.confirmer ?? null,
            effectiveDate:
              note?.effectiveDate ??
              d.confirmationBasis?.confirmedAt?.slice(0, 10) ??
              null,
          };
        }),
    [decisions, decisionChangeNote]
  );

  useEffect(() => {
    if (!hasActiveBackend || switchingWorkspace) return;
    return subscribeWorkspaceStream((notice) => {
      if (notice.type !== 'workspace-change') return;
      const kinds = notice.kinds ?? [];
      if (
        kinds.includes('watcher') &&
        ((notice.newEvents ?? 0) > 0 || (notice.newRevisions ?? 0) > 0)
      ) {
        const delta = notice.newEvents || notice.newRevisions || 0;
        setChangeNotice((prev) => ({
          count: (prev?.count ?? 0) + delta,
          at: notice.at || nowLocalIso(),
        }));
      }
      if (kinds.includes('state')) {
        void (async () => {
          const overview = await fetchStateOverview();
          if (overview.ok) setStateOverview(overview.data);
        })();
      }
      if (kinds.includes('proposal')) {
        void (async () => {
          const full = await fetchRevisionProposals({ status: 'proposed', limit: 100 });
          if (full.ok) {
            setAgentDraftFileIds(new Set(full.data.items.map((item) => item.file_id)));
            setAgentDraftAtByFileId(draftTimestampIndex(full.data.items));
            if (full.data.items.length === 0) {
              setProposalToast(null);
              setProposalDiffExpanded(false);
              setProposalDiffContent(null);
              return;
            }
            const draft = full.data.items[0];
            setProposalToast((prev) => {
              const sameDraft = prev?.draftId === draft.draft_id;
              if (!sameDraft) {
                setProposalDiffExpanded(false);
                setProposalDiffContent(null);
                setProposalDiffError(null);
              }
              return {
                draftId: draft.draft_id,
                fileId: draft.file_id,
                fileName: basenameOf(draft.path),
                versionLabel: draft.draft_version_label || null,
                conflict: draft.conflict,
                receiptSummary: draft.receipt_summary ?? null,
                note: draft.note ?? null,
                inputContextHashes: draft.input_context_hashes ?? [],
              };
            });
            setProposalAdoptNotice(null);
          }
        })();
      }
      if (kinds.includes('decision_writeback')) {
        void (async () => {
          const res = await fetchDecisions({ limit: 20 });
          if (!res.ok) return;
          if (typeof res.data.unresolved_total === 'number') {
            setDecisionsUnresolvedTotal(res.data.unresolved_total);
          }
          if (res.data.items.length === 0) return;
          const latest = res.data.items.find((d) =>
            DECIDED_DECISION_STATUSES.includes(d.status)
          );
          if (!latest) return;
          setDecisions((prev) => {
            const idx = prev.findIndex((d) => d.decision_id === latest.decision_id);
            if (idx < 0) return [...prev, latest];
            const next = prev.slice();
            next[idx] = latest;
            return next;
          });
          pushDecisionChangeNote(
            decisionChangeNoteFromAssertion(latest, {
              blockingCleared: false,
              source: 'writeback',
              at: nowLocalIso(),
            })
          );
        })();
      }
      if (kinds.includes('l4a')) {
        void pollL4aRef.current?.();
      }
      if (
        kinds.includes('project_added') ||
        kinds.includes('project_removed') ||
        kinds.includes('project_updated') ||
        kinds.includes('project_activated') ||
        kinds.includes('watcher')
      ) {
        multiProjectsRefreshRef.current?.();
      }
      if (
        kinds.includes('decision_writeback') ||
        kinds.includes('proposal') ||
        kinds.includes('state') ||
        kinds.includes('task')
      ) {
        void (async () => {
          const br = await fetchReviewBoard();
          if (br.ok) setReviewBoard(br.data);
        })();
      }
    }, (connected) => {
      if (connected) {
        const wasDisconnected = streamEverConnectedRef.current && streamDisconnectedRef.current;
        streamEverConnectedRef.current = true;
        streamDisconnectedRef.current = false;
        setStreamDisconnected(false);
        setNetworkOffline(false);
        if (wasDisconnected) {
          setBootstrapNonce((n) => n + 1);
        }
      } else if (streamEverConnectedRef.current && !switchingWorkspaceRef.current) {
        streamDisconnectedRef.current = true;
        setStreamDisconnected(true);
      }
    });
  }, [hasActiveBackend, pushDecisionChangeNote, switchingWorkspace, workspaceEpoch]);

  const refreshReviewBoard = useCallback(async () => {
    if (!hasActiveBackend) return;
    setReviewBoardLoading(true);
    setReviewBoardError(null);
    const res = await fetchReviewBoard();
    setReviewBoardLoading(false);
    if (res.ok) {
      setReviewBoard(res.data);
    } else {
      setReviewBoardError(res.error || '批阅看板查询失败');
    }
  }, [hasActiveBackend]);

  useEffect(() => {
    if (!hasActiveBackend) return;
    void refreshReviewBoard();
  }, [hasActiveBackend, workspaceEpoch, refreshReviewBoard]);

  useEffect(() => {
    if (isReviewBoardOpen) {
      setReviewBoardNotice(null);
      void refreshReviewBoard();
    }
  }, [isReviewBoardOpen, refreshReviewBoard]);

  const handleOpenReviewBoard = useCallback(() => {
    setIsReviewBoardOpen(true);
  }, []);

  const handleBoardAckStatement = useCallback(
    (stmt: ReviewBoardPendingStatement) => {
      if (reviewBoardBusyKey) return;
      const key = `ack:${stmt.statement_id}`;
      setReviewBoardBusyKey(key);
      setReviewBoardNotice(null);
      void (async () => {
        const accepted = await postDecisionResolve(stmt.statement_id, {
          decision: '已知悉（人工确认放行）',
          confirmer: '人工确认',
          effective_scope: '全量专项',
          note: '批阅看板一键已知悉',
        });
        if (!accepted.ok) {
          setReviewBoardBusyKey(null);
          setReviewBoardNotice({
            kind: 'error',
            message: accepted.error || '已知悉写回受理失败',
          });
          return;
        }
        const settled = await pollJobUntilSettled(accepted.data.job_id);
        setReviewBoardBusyKey(null);
        if (!settled.ok || settled.data.state !== 'completed') {
          setReviewBoardNotice({
            kind: 'error',
            message: settled.ok
              ? settled.data.error || '已知悉写回任务失败'
              : settled.error || '任务轮询失败',
          });
          return;
        }
        const wb = extractJobBranch<JobReportWriteback>(settled.data, 'writeback');
        if (wb && !wb.cas_ok) {
          setReviewBoardNotice({
            kind: 'error',
            message: '检测到并发修改（CAS 冲突），已保存为独立草案等待比对，绝不静默覆盖',
          });
        } else {
          const latency = typeof wb?.elapsed_ms === 'number' ? ` · ${wb.elapsed_ms}ms` : '';
          const unlocked = wb?.unlocked_downstream ? ' · 下游事项已解除阻塞' : '';
          setReviewBoardNotice({
            kind: 'ok',
            message: `已原位写回 ${stmt.path} 并同步 SQLite 与看板${unlocked}${latency}`,
          });
        }
        await refreshReviewBoard();
        const ov = await fetchStateOverview();
        if (ov.ok) setStateOverview(ov.data);
      })();
    },
    [reviewBoardBusyKey, refreshReviewBoard]
  );

  const handleBoardRepairOrphan = useCallback(
    (initiativeId: string, nodeId: string, action: OrphanRepairAction) => {
      if (reviewBoardBusyKey) return;
      const key = `repair:${initiativeId}:${action}`;
      setReviewBoardBusyKey(key);
      setReviewBoardNotice(null);
      void (async () => {
        const accepted = await postRepairOrphan(initiativeId, {
          node_id: nodeId,
          action,
          note: action === 'reset_to_dispatchable' ? '人工重置孤儿节点为可派发' : '人工转挂起核查',
        });
        if (!accepted.ok) {
          setReviewBoardBusyKey(null);
          setReviewBoardNotice({
            kind: 'error',
            message: accepted.error || '孤儿修复请求失败',
          });
          return;
        }
        const settled = await pollJobUntilSettled(accepted.data.job_id);
        setReviewBoardBusyKey(null);
        if (!settled.ok || settled.data.state !== 'completed') {
          setReviewBoardNotice({
            kind: 'error',
            message: settled.ok
              ? settled.data.error || '孤儿修复任务失败'
              : settled.error || '任务轮询失败',
          });
          return;
        }
        const rep = extractJobBranch<JobReportOrphanRepair>(settled.data, 'repair');
        setReviewBoardNotice({
          kind: 'ok',
          message:
            rep?.action === 'reset_to_dispatchable'
              ? `孤儿节点（${rep.stage}槽）已重置为可派发，可重新交办`
              : `孤儿节点（${rep?.stage ?? ''}槽）已挂起待人工核查`,
        });
        await refreshReviewBoard();
        const ov = await fetchStateOverview();
        if (ov.ok) setStateOverview(ov.data);
      })();
    },
    [reviewBoardBusyKey, refreshReviewBoard]
  );

  const handleAdoptProposal = useCallback(
    (draftId: string) => {
      if (proposalAdopting || proposalRejecting) return;
      setProposalAdopting(true);
      setProposalAdoptNotice(null);
      void (async () => {
        const accepted = await postRevisionProposalAdopt(draftId);
        if (!accepted.ok) {
          setProposalAdopting(false);
          setProposalAdoptNotice({
            ok: false,
            message:
              accepted.code === 'CONFLICT'
                ? '文档已归档，需先人工重开'
                : accepted.error || '采纳请求提交失败',
          });
          return;
        }
        const settled = await pollJobUntilSettled(accepted.data.job_id);
        setProposalAdopting(false);
        if (!settled.ok) {
          setProposalAdoptNotice({ ok: false, message: settled.error || '采纳任务轮询失败' });
          return;
        }
        if (settled.data.state !== 'completed') {
          setProposalAdoptNotice({
            ok: false,
            message: settled.data.error || '采纳任务失败',
          });
          return;
        }
        const report =
          settled.data.kind === 'adopt_draft'
            ? extractJobBranch<JobReportAdopt>(settled.data, 'adopt')
            : null;
        if (!report || report.cas_ok === false) {
          setProposalToast((prev) =>
            prev && prev.draftId === draftId ? { ...prev, conflict: true } : prev
          );
          setProposalAdoptNotice({
            ok: false,
            message: '文件已被人工或外部修改，草案已保留为冲突分支（未覆盖磁盘原稿），请比对后处理',
          });
          const latestDiff = await fetchRevisionProposalContent(draftId);
          if (latestDiff.ok) {
            setProposalDiffContent(latestDiff.data);
            setProposalDiffExpanded(true);
          }
          return;
        }
        const edgeHint =
          report.derived_edges_written && report.derived_edges_written > 0
            ? `（已记录 ${report.derived_edges_written} 条上下文因果边）`
            : '';
        setProposalAdoptNotice({ ok: true, message: `草案已采纳，正式版本已推进${edgeHint}` });
        setProposalToast(null);
        setProposalDiffExpanded(false);
        setProposalDiffContent(null);
        setBootstrapNonce((n) => n + 1);
      })();
    },
    [proposalAdopting, proposalRejecting]
  );

  const handleRejectProposal = useCallback(
    (draftId: string) => {
      if (proposalAdopting || proposalRejecting) return;
      setProposalRejecting(true);
      setProposalAdoptNotice(null);
      void (async () => {
        const accepted = await postRevisionProposalDismiss(draftId);
        if (!accepted.ok) {
          setProposalRejecting(false);
          setProposalAdoptNotice({
            ok: false,
            message: accepted.error || '退回重做请求提交失败',
          });
          return;
        }
        const settled = await pollJobUntilSettled(accepted.data.job_id);
        setProposalRejecting(false);
        if (!settled.ok) {
          setProposalAdoptNotice({ ok: false, message: settled.error || '退回任务轮询失败' });
          return;
        }
        if (settled.data.state !== 'completed') {
          setProposalAdoptNotice({
            ok: false,
            message: settled.data.error || '退回重做失败',
          });
          return;
        }
        setProposalToast(null);
        setProposalDiffExpanded(false);
        setProposalDiffContent(null);
        setProposalDiffError(null);
        setProposalAdoptNotice(null);
        const remaining = await fetchRevisionProposals({ status: 'proposed', limit: 100 });
        if (remaining.ok) {
          setAgentDraftFileIds(new Set(remaining.data.items.map((item) => item.file_id)));
          setAgentDraftAtByFileId(draftTimestampIndex(remaining.data.items));
        }
      })();
    },
    [proposalAdopting, proposalRejecting]
  );

  const handleViewProposalDiff = useCallback(
    (draftId: string) => {
      const toast = proposalToast;
      if (!toast || toast.draftId !== draftId) return;
      if (proposalDiffExpanded && proposalDiffContent?.draft_id === draftId) {
        setProposalDiffExpanded(false);
        return;
      }
      setProposalDiffExpanded(true);
      if (proposalDiffContent?.draft_id === draftId) return;
      setProposalDiffLoading(true);
      setProposalDiffError(null);
      void (async () => {
        const res = await fetchRevisionProposalContent(draftId);
        setProposalDiffLoading(false);
        if (!res.ok) {
          setProposalDiffError(res.error || '读取草案多模态 Diff 失败');
          return;
        }
        setProposalDiffContent(res.data);
        if (res.data.conflict) {
          setProposalToast((prev) =>
            prev && prev.draftId === draftId ? { ...prev, conflict: true } : prev
          );
        }
      })();
    },
    [proposalToast, proposalDiffExpanded, proposalDiffContent]
  );

  const handleOpenProposalInReader = useCallback((fileId: string) => {
    setActiveTab('library');
    setLibraryMode('read');
    setActiveFileId(fileId);
    setPinnedRevisionId('');
    setReaderSubMode('diff_versions');
    setIsContextDrawerOpen(false);
  }, []);

  const handleDismissProposalToast = useCallback(() => {
    setProposalToast(null);
    setProposalAdoptNotice(null);
    setProposalDiffExpanded(false);
    setProposalDiffContent(null);
    setProposalDiffError(null);
  }, []);

  const activeSmartViewDef =
    activeSmartView !== null
      ? (SMART_VIEWS.find((v) => v.id === activeSmartView) ?? null)
      : null;
  const sidebarFilterLabel = [
    sidebarFilters.quickScope === 'unread' ? '未读' : '',
    sidebarFilters.quickScope === 'bookmarked' ? '收藏' : '',
    activeSmartViewDef ? `智能视图：${activeSmartViewDef.label}` : '',
    sidebarFilters.folder !== 'all' ? sidebarFilters.folder : '',
    sidebarFilters.format !== 'all' ? sidebarFilters.format.toUpperCase() : '',
    sidebarFilters.role !== 'all' ? sidebarFilters.role : '',
    sidebarFilters.topic !== 'all' ? sidebarFilters.topic : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const handleClearSidebarFilters = () => {
    setSidebarFilters({
      quickScope: 'all',
      folder: 'all',
      format: 'all',
      role: 'all',
      topic: 'all',
    });
  };

  const activeFileInFilter = useMemo(
    () =>
      !sidebarFilterActive
        ? Boolean(activeFile)
        : filteredFiles.some((f) => f.file_id === activeFile?.file_id),
    [activeFile, filteredFiles, sidebarFilterActive]
  );

  const readerPaneRef = useRef<HTMLDivElement | null>(null);
  const readerScrollRef = useRef<{
    fileId: string;
    revisionId: string;
    spots: Array<{ el: HTMLElement; top: number; left: number }>;
  } | null>(null);

  const captureReaderScroll = useCallback(() => {
    const root = readerPaneRef.current;
    if (!root || !activeFile) return;
    const spots: Array<{ el: HTMLElement; top: number; left: number }> = [];
    root.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (el.scrollTop > 0 || el.scrollLeft > 0) {
        spots.push({ el, top: el.scrollTop, left: el.scrollLeft });
      }
    });
    readerScrollRef.current = {
      fileId: activeFile.file_id,
      revisionId: pinnedRevisionId,
      spots,
    };
  }, [activeFile, pinnedRevisionId]);

  const handleLibraryModeChange = (mode: LibraryMode) => {
    if (mode === 'overview' && libraryMode === 'read') captureReaderScroll();
    setLibraryMode(mode);
  };

  useLayoutEffect(() => {
    if (libraryMode !== 'read') return;
    const snapshot = readerScrollRef.current;
    readerScrollRef.current = null;
    if (!snapshot) return;
    if (
      snapshot.fileId !== activeFile?.file_id ||
      snapshot.revisionId !== pinnedRevisionId
    ) {
      return;
    }
    const apply = () => {
      for (const spot of snapshot.spots) {
        if (!spot.el.isConnected) continue;
        if (spot.el.scrollTop !== spot.top) spot.el.scrollTop = spot.top;
        if (spot.el.scrollLeft !== spot.left) spot.el.scrollLeft = spot.left;
      }
    };
    apply();
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [libraryMode, activeFile?.file_id, pinnedRevisionId]);

  const sidebarFilterKey = `${sidebarFilters.quickScope}|${sidebarFilters.folder}|${sidebarFilters.format}|${sidebarFilters.role}|${sidebarFilters.topic}`;
  const prevSidebarFilterKeyRef = useRef(sidebarFilterKey);
  useEffect(() => {
    const prevKey = prevSidebarFilterKeyRef.current;
    prevSidebarFilterKeyRef.current = sidebarFilterKey;
    if (prevKey === sidebarFilterKey) return;
    if (!sidebarFilterActive || libraryMode !== 'read') return;
    captureReaderScroll();
    setLibraryMode('overview');
  }, [sidebarFilterKey, sidebarFilterActive, libraryMode, captureReaderScroll]);

  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  useEffect(() => {
    if (!searchQuery) {
      setDebouncedSearchQuery('');
      return;
    }
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 150);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const searchResult = useMemo(
    () => searchWorkspaceCapped(files, debouncedSearchQuery),
    [files, debouncedSearchQuery]
  );
  const searchHits = searchResult.hits;

  const unreadFilesCount = useMemo(() => {
    return files.filter((f) => hasUnreadChanges(f, readingStates[f.file_id]).isUnread)
      .length;
  }, [files, readingStates]);

  const recentItems = useMemo(() => {
    const toDay = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const windowStart = toDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6));
    const windowEnd = toDay(today);
    return files
      .map((f) => {
        const sourceTime = f.revisions[0]?.source_time;
        return { file: f, date: sourceTime ? localDay(sourceTime) : null };
      })
      .filter((x): x is { file: FileRecord; date: string } =>
        x.date !== null && x.date >= windowStart && x.date <= windowEnd
      )
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, 8)
      .map((x) => ({
        file_id: x.file.file_id,
        title: x.file.title,
        date: x.date,
        format: x.file.format,
      }));
  }, [files]);

  const breadcrumbFromNavSource = (entry: NavSourceEntry): ReturnBreadcrumb =>
    entry.activeTab === 'library' && entry.libraryMode === 'read' && entry.fileId
      ? {
          fromType: 'markdown_paragraph',
          label: describeNavSourceReturn(entry),
          fileId: entry.fileId,
          revisionId: entry.revisionId || undefined,
          sectionId: entry.sectionId,
        }
      : timelineReturnBreadcrumb(describeNavSourceReturn(entry));

  const pushCurrentNavSource = (opts?: {
    label?: string;
    sectionId?: string;
    enteredTimeMachine?: boolean;
  }): NavSourceEntry => {
    const currentFileTitle = activeFileId
      ? fileCacheRef.current.get(activeFileId)?.title
      : undefined;
    const entry: NavSourceEntry = {
      activeTab,
      panoramaMode,
      libraryMode,
      fileId: activeTab === 'library' ? activeFileId : '',
      revisionId: activeTab === 'library' ? pinnedRevisionId : '',
      sectionId: opts?.sectionId,
      enteredTimeMachine: opts?.enteredTimeMachine,
      label:
        opts?.label ??
        defaultNavSourceLabel(activeTab, panoramaMode, libraryMode, currentFileTitle),
      atMs: Date.now(),
    };
    const next = pushNavSource(navSourceStackRef.current, entry);
    navSourceStackRef.current = next;
    setNavSourceStack(next);
    return entry;
  };

  const restoreNavSourceEntry = (entry: NavSourceEntry) => {
    setActiveTab(entry.activeTab);
    setPanoramaMode(entry.panoramaMode);
    setLibraryMode(entry.libraryMode);
    if (entry.activeTab === 'library' && entry.fileId) {
      setActiveFileId(entry.fileId);
      if (entry.revisionId) {
        setPinnedRevisionId(entry.revisionId);
      }
      setReaderSubMode('read');
      if (entry.sectionId) {
        setReaderFocusSection({ fileId: entry.fileId, sectionId: entry.sectionId });
      }
    }
  };

  const handleSelectPrimaryTab = (tab: PrimaryTab) => {
    if (tab !== activeTab) {
      navSourceStackRef.current = [];
      setNavSourceStack([]);
      trailEnteredFromStackRef.current = false;
      setReturnBreadcrumb(null);
    }
    setActiveTab(tab);
  };

  useEffect(() => {
    const prev = prevTrailLenRef.current;
    prevTrailLenRef.current = eventTrail.length;
    if (prev > 0 && eventTrail.length === 0 && trailEnteredFromStackRef.current) {
      trailEnteredFromStackRef.current = false;
      const popped = popNavSource(navSourceStackRef.current);
      if (popped.entry && popped.entry.enteredTimeMachine) {
        navSourceStackRef.current = popped.stack;
        setNavSourceStack(popped.stack);
        restoreNavSourceEntry(popped.entry);
      }
    }
  }, [eventTrail.length]);

  const handleSelectSearchHit = (hit: SearchHit) => {
    const match = files.find(file => file.file_id === hit.file_id);
    if (activeTab === 'panorama' && panoramaMode === 'canvas' && match) {
      setActiveFileId(hit.file_id);
      setPinnedRevisionId(hit.revision_id);
      setEventTrail(prev => enterEventFrame(prev, match, undefined, match.title, hit.revision_id));
      setSearchQuery('');
      return;
    }
    const source = pushCurrentNavSource();
    setActiveFileId(hit.file_id);
    setPinnedRevisionId(hit.revision_id);
    setReaderSubMode('read');
    setReturnBreadcrumb(breadcrumbFromNavSource(source));
    setActiveTab('library');
    setLibraryMode('read');
    setSearchQuery('');
  };

  const handleOpenFileFromTimelineOrGraph = (
    fileId: string,
    revisionId: string,
    mode: 'read' | 'diff_since_read' | 'relations' | 'history'
  ) => {
    if (mode === 'history') {
      setHistoryFileId(fileId);
      return;
    }
    const source = pushCurrentNavSource();
    setReaderAnchor(null);
    setActiveFileId(fileId);
    setPinnedRevisionId(revisionId);
    setReaderSubMode(mode);
    setReturnBreadcrumb(breadcrumbFromNavSource(source));
    setActiveTab('library');
    setLibraryMode('read');
  };

  const openDocFromCalendar = (fileId: string) => {
    const t = files.find((f) => f.file_id === fileId);
    if (t) handleOpenFileFromTimelineOrGraph(t.file_id, t.current_revision_id, 'read');
  };

  const openDocResumeReading = async (fileId: string, sectionId?: string) => {
    const listed = files.find((f) => f.file_id === fileId);
    if (!listed) return;
    const reqSeq = ++resumeReqSeqRef.current;
    if (activeTab !== 'library' || libraryMode !== 'read' || activeFileId !== fileId) {
      const source = pushCurrentNavSource();
      if (activeTab !== 'library' || libraryMode !== 'read') {
        setReturnBreadcrumb(breadcrumbFromNavSource(source));
      }
    }
    setActiveFileId(fileId);
    setPinnedRevisionId(listed.current_revision_id);
    setReaderSubMode('read');
    setActiveTab('library');
    setLibraryMode('read');
    setIsMobileLeftOpen(false);
    const target = (await ensureFileDetail(fileId)) || listed;
    if (resumeReqSeqRef.current !== reqSeq) return;
    const st = readingStatesRef.current[fileId];
    const hasMidReadAnchor = Boolean(
      sectionId ||
        st?.last_section_id ||
        (st && !st.baselineOnly && st.scrollPercent > 0 && st.scrollPercent < 100)
    );
    const resumeRevision = hasMidReadAnchor
      ? target.revisions.find((r) => r.revision_id === st?.last_read_revision_id)
      : undefined;
    const resumeRevisionId =
      resumeRevision && (resumeRevision.snapshotAvailable || resumeRevision.markdownContent)
        ? resumeRevision.revision_id
        : target.current_revision_id;
    setPinnedRevisionId(resumeRevisionId);
    setReaderFocusSection(sectionId ? { fileId: target.file_id, sectionId } : null);
    readerScrollPercentRef.current = {
      fileId: target.file_id,
      scrollPercent: st?.scrollPercent ?? 0,
    };
    setReaderSubMode('read');
    setActiveTab('library');
    setLibraryMode('read');
    setIsMobileLeftOpen(false);
  };

  const handleFollowReturnBreadcrumb = () => {
    const stack = navSourceStackRef.current;
    if (!returnBreadcrumb && stack.length === 0) {
      setActiveTab(TIMELINE_RETURN_TARGET.activeTab);
      setPanoramaMode(TIMELINE_RETURN_TARGET.panoramaMode);
      return;
    }
    if (returnBreadcrumb?.fromType === 'markdown_paragraph' && returnBreadcrumb.fileId) {
      const top = peekNavSource(stack);
      let nextStack = stack;
      if (top && top.activeTab === 'library' && top.fileId === returnBreadcrumb.fileId) {
        nextStack = popNavSource(stack).stack;
        navSourceStackRef.current = nextStack;
        setNavSourceStack(nextStack);
      }
      setActiveTab('library');
      setLibraryMode('read');
      setActiveFileId(returnBreadcrumb.fileId);
      if (returnBreadcrumb.revisionId) {
        setPinnedRevisionId(returnBreadcrumb.revisionId);
      }
      if (returnBreadcrumb.sectionId) {
        setReaderFocusSection({
          fileId: returnBreadcrumb.fileId,
          sectionId: returnBreadcrumb.sectionId,
        });
      }
      setReaderSubMode('read');
      const under = peekNavSource(nextStack);
      setReturnBreadcrumb(under ? breadcrumbFromNavSource(under) : null);
      return;
    }
    if (stack.length > 0) {
      const popped = popNavSource(stack);
      navSourceStackRef.current = popped.stack;
      setNavSourceStack(popped.stack);
      if (popped.entry) {
        restoreNavSourceEntry(popped.entry);
        const under = peekNavSource(popped.stack);
        setReturnBreadcrumb(
          popped.entry.activeTab === 'library' && popped.entry.libraryMode === 'read' && under
            ? breadcrumbFromNavSource(under)
            : null
        );
        return;
      }
    }
    setActiveTab(TIMELINE_RETURN_TARGET.activeTab);
    setPanoramaMode(TIMELINE_RETURN_TARGET.panoramaMode);
    setReturnBreadcrumb(null);
  };

  const handleNavigateLinkedFile = (
    targetFileId: string,
    origin: { fileId: string; revisionId: string; title: string; sectionId?: string },
    officeAnchor?: OfficeEvidenceAnchor,
    pdfAnchor?: PdfEvidenceAnchor
  ) => {
    const target = files.find((f) => f.file_id === targetFileId);
    if (!target) return;
    pushCurrentNavSource({
      label: `原段落：${origin.title}${origin.sectionId ? ` · ${origin.sectionId}` : ''}`,
      sectionId: origin.sectionId,
    });
    setReturnBreadcrumb({
      fromType: 'markdown_paragraph',
      label: `返回原段落：${origin.title}${
        origin.sectionId ? ` · ${origin.sectionId}` : ''
      }`,
      fileId: origin.fileId,
      revisionId: origin.revisionId,
      sectionId: origin.sectionId,
    });
    setActiveFileId(target.file_id);
    setPinnedRevisionId(target.current_revision_id);
    setReaderSubMode('read');
    if (officeAnchor) {
      setReaderAnchor({
        fileId: target.file_id,
        revisionId: target.current_revision_id,
        line: officeAnchor.paragraph ?? 1,
        officeAnchor,
      });
    } else if (pdfAnchor) {
      setReaderAnchor({
        fileId: target.file_id,
        revisionId: target.current_revision_id,
        line: pdfAnchor.page,
        pdfAnchor,
      });
    } else {
      setReaderAnchor(null);
    }
  };

  const handleOpenFileTimeline = (fileId: string) => {
    setHistoryFileId(fileId);
  };

  const handleJumpToSourceEvidence = (
    fileId: string,
    revisionId: string,
    lineStart: number,
    officeAnchor?: OfficeEvidenceAnchor,
    pdfAnchor?: PdfEvidenceAnchor
  ) => {
    if (activeTab !== 'library' || libraryMode !== 'read' || activeFileId !== fileId) {
      const source = pushCurrentNavSource();
      setReturnBreadcrumb(breadcrumbFromNavSource(source));
    }
    setActiveFileId(fileId);
    setPinnedRevisionId(revisionId);
    setReaderSubMode('read');
    setReaderAnchor({ fileId, revisionId, line: lineStart, officeAnchor, pdfAnchor });
    setActiveTab('library');
    setLibraryMode('read');
  };

  const handleSelectCanvasDate = (date?: string) => {
    setActiveDate((prev) => (prev !== undefined && prev === date ? undefined : date));
  };

  const applyDayFilter = async (date?: string) => {
    const next = date ? { from: date, to: date } : {};
    eventFetchGenRef.current += 1;
    const gen = eventFetchGenRef.current;
    dateFilterRef.current = next;
    setDateFilter(next);
    setEventPageLoading(true);
    const result = await fetchEventPage({
      limit: next.from ? 200 : 50,
      order: eventOrder,
      undated: undatedOnly,
      from: next.from,
      to: next.to,
      kinds: currentEventKinds(),
    });
    setEventPageLoading(false);
    if (result.page && eventFetchGenRef.current === gen) {
      setEventPage(result.page);
      mergeEventsPage(result.page.items);
      setChangeNotice(null);
    }
  };

  const applyKindFilter = async (kind: TimelineEventKind | 'all') => {
    eventFetchGenRef.current += 1;
    const gen = eventFetchGenRef.current;
    eventKindFilterRef.current = kind;
    setEventKindFilter(kind);
    setEventPageLoading(true);
    const result = await fetchEventPage({
      limit: 50,
      order: eventOrder,
      undated: undatedOnly,
      from: dateFilterRef.current.from,
      to: dateFilterRef.current.to,
      kinds: kind === 'all' ? undefined : [kind],
    });
    setEventPageLoading(false);
    if (result.page && eventFetchGenRef.current === gen) {
      setEventPage(result.page);
      mergeEventsPage(result.page.items);
      setChangeNotice(null);
    }
  };

  const resetEventFilters = async () => {
    eventFetchGenRef.current += 1;
    eventKindFilterRef.current = 'all';
    setEventKindFilter('all');
    dateFilterRef.current = {};
    setDateFilter({});
    setEventPageLoading(true);
    const result = await fetchEventPage({
      limit: 50,
      order: eventOrder,
      undated: undatedOnly,
      kinds: undefined,
    });
    setEventPageLoading(false);
    if (
      result.page &&
      eventKindFilterRef.current === 'all' &&
      !dateFilterRef.current.from &&
      !dateFilterRef.current.to
    ) {
      setEventPage(result.page);
      mergeEventsPage(result.page.items);
      setChangeNotice(null);
    }
  };

  const handleJumpToDayInTimeline = (date: string) => {
    if (activeTab !== 'panorama' || panoramaMode !== 'list') {
      pushCurrentNavSource();
    }
    void applyDayFilter(date);
    setActiveTab('panorama');
    setPanoramaMode('list');
  };

  const handleMarkReadHere = (
    fileId: string,
    _revisionId: string,
    sectionId?: string
  ) => {
    setReadingStates((prev) => {
      const existing = prev[fileId];
      const base = existing || {
        file_id: fileId,
        scrollPercent: 0,
        isFullyRead: false,
        bookmarked: false,
      };
      const next: ReadingState = {
        ...base,
        last_section_id: sectionId,
        updated_at: nowLocalIso(),
        baselineOnly: undefined,
      };
      return { ...prev, [fileId]: next };
    });
  };

  const handleMarkFullyRead = (fileId: string, revisionId: string) => {
    const targetRevId =
      revisionId?.trim() || fileCacheRef.current.get(fileId)?.current_revision_id || '';
    if (!targetRevId) return;
    setReadingStates((prev) => ({
      ...prev,
      [fileId]: {
        ...(prev[fileId] || {
          file_id: fileId,
          bookmarked: false,
        }),
        last_read_revision_id: targetRevId,
        scrollPercent: 100,
        isFullyRead: true,
        updated_at: nowLocalIso(),
        baselineOnly: undefined,
      },
    }));
    if (hasActiveBackend) {
      void postBatchReadingState({
        action: 'mark_read',
        file_ids: [fileId],
        revision_id: targetRevId,
      });
    }
  };

  const handleMarkUnread = (fileId: string) => {
    if (!fileId) return;
    setReadingStates((prev) => markFileUnreadState(prev, fileId));
    if (hasActiveBackend) {
      void postBatchReadingState({
        action: 'mark_unread',
        file_ids: [fileId],
      });
    }
  };

  const handleMarkFolderUnread = async (
    scope: 'workspace' | 'folder',
    folderPrefix?: string
  ): Promise<boolean> => {
    if (readingBatchBusyRef.current) return false;
    readingBatchBusyRef.current = true;
    try {
      return await runMarkFolderUnread(scope, folderPrefix);
    } finally {
      readingBatchBusyRef.current = false;
    }
  };

  const runMarkFolderUnread = async (
    scope: 'workspace' | 'folder',
    folderPrefix?: string
  ): Promise<boolean> => {
    const cleanPrefix =
      scope === 'folder' && folderPrefix
        ? folderPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        : undefined;
    const scopeLabel =
      scope === 'folder' && cleanPrefix
        ? `目录「${cleanPrefix.split('/').pop() || cleanPrefix}」`
        : '当前工作区';

    const localTargetIds = files
      .filter((f) => {
        if (scope === 'folder' && cleanPrefix) {
          const folderNorm = (f.folder || '').replace(/\\/g, '/');
          if (folderNorm !== cleanPrefix && !folderNorm.startsWith(`${cleanPrefix}/`)) {
            return false;
          }
        }
        return Boolean(readingStatesRef.current[f.file_id]?.last_read_revision_id);
      })
      .map((f) => f.file_id);

    if (!hasActiveBackend) {
      if (localTargetIds.length === 0) {
        toastManager.add({
          title: `${scopeLabel}当前均为未读状态`,
          type: 'info',
        });
        return true;
      }
      const { next, previousSnapshot } = applyBatchMarkUnread(
        readingStatesRef.current,
        localTargetIds
      );
      setReadingStates(next);
      let undone = false;
      const toastId = toastManager.add({
        title: `已将${scopeLabel} ${previousSnapshot.size} 份文档标为未读`,
        description: '收藏与批注已保留（8 秒内可撤销）',
        type: 'success',
        timeout: 8000,
        actionProps: {
          children: '撤销',
          onClick: () => {
            if (undone) return;
            undone = true;
            setReadingStates((cur) => restoreReadingStatesSnapshot(cur, previousSnapshot));
            toastManager.close(toastId);
            toastManager.add({
              title: '已撤销，恢复原已读状态',
              type: 'info',
            });
          },
        },
      });
      return true;
    }

    const res = await postBatchReadingState({
      action: 'mark_unread',
      scope,
      folder_prefix: cleanPrefix,
    });
    if (!res.ok) {
      toastManager.add({
        title: '标记未读失败',
        description: res.error || '未能清除已读状态，请稍后重试',
        type: 'error',
      });
      return false;
    }

    const mergedTargetIds = Array.from(
      new Set([...localTargetIds, ...res.data.undo_items.map((it) => it.file_id)])
    );
    if (mergedTargetIds.length === 0) {
      toastManager.add({
        title: `${scopeLabel}当前均为未读状态`,
        type: 'info',
      });
      return true;
    }

    const { next, previousSnapshot } = applyBatchMarkUnread(
      readingStatesRef.current,
      mergedTargetIds
    );
    setReadingStates(next);

    const undoMap = new Map(res.data.undo_items.map((u) => [u.file_id, u]));
    for (const [fid, prev] of previousSnapshot.entries()) {
      if (!undoMap.has(fid) && prev?.last_read_revision_id) {
        undoMap.set(fid, {
          file_id: fid,
          previous_revision_id: prev.last_read_revision_id,
          previous_updated_at: prev.updated_at || null,
        });
      }
    }
    const restoreItems = Array.from(undoMap.values());
    const affectedCount = Math.max(previousSnapshot.size, res.data.affected_count);

    let undone = false;
    const toastId = toastManager.add({
      title: `已将${scopeLabel} ${affectedCount} 份文档标为未读`,
      description: '收藏与批注已保留（8 秒内可撤销）',
      type: 'success',
      timeout: 8000,
      actionProps: {
        children: '撤销',
        onClick: () => {
          if (undone) return;
          undone = true;
          toastManager.close(toastId);
          void (async () => {
            if (restoreItems.length > 0) {
              const restoreRes = await postBatchReadingState({
                action: 'restore',
                restore_items: restoreItems,
              });
              if (!restoreRes.ok) {
                toastManager.add({
                  title: '撤销标为未读失败',
                  description: restoreRes.error || '服务端未能还原原已读状态',
                  type: 'error',
                });
                return;
              }
            }
            setReadingStates((cur) => restoreReadingStatesSnapshot(cur, previousSnapshot));
            toastManager.add({
              title: `已撤销，还原 ${affectedCount} 份文档的原已读状态`,
              type: 'info',
            });
          })();
        },
      },
    });
    return true;
  };

  const handleMarkReadingBaseline = async (
    scope: 'workspace' | 'folder',
    folderPrefix?: string
  ): Promise<boolean> => {
    if (readingBatchBusyRef.current) return false;
    readingBatchBusyRef.current = true;
    try {
      return await runMarkReadingBaseline(scope, folderPrefix);
    } finally {
      readingBatchBusyRef.current = false;
    }
  };

  const runMarkReadingBaseline = async (
    scope: 'workspace' | 'folder',
    folderPrefix?: string
  ): Promise<boolean> => {
    const cleanPrefix =
      scope === 'folder' && folderPrefix
        ? folderPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        : undefined;
    const scopeLabel =
      scope === 'folder' && cleanPrefix
        ? `目录「${cleanPrefix.split('/').pop() || cleanPrefix}」`
        : '当前工作区';

    if (!hasActiveBackend) {
      const targetFiles = files.filter((f) => {
        if (!f.current_revision_id) return false;
        if (scope === 'folder' && cleanPrefix) {
          const folderNorm = (f.folder || '').replace(/\\/g, '/');
          if (folderNorm !== cleanPrefix && !folderNorm.startsWith(`${cleanPrefix}/`)) {
            return false;
          }
        }
        return hasUnreadChanges(f, readingStatesRef.current[f.file_id]).isUnread;
      });
      if (targetFiles.length === 0) {
        toastManager.add({
          title: `${scopeLabel}已全部处于已读基线`,
          type: 'info',
        });
        return true;
      }
      const nowIso = nowLocalIso();
      const updatedItems = targetFiles.map((f) => ({
        file_id: f.file_id,
        last_read_revision_id: f.current_revision_id,
        updated_at: nowIso,
      }));
      const { next, previousSnapshot } = applyBatchReadingBaseline(
        readingStatesRef.current,
        updatedItems
      );
      setReadingStates(next);
      let undone = false;
      const toastId = toastManager.add({
        title: `已确立 ${updatedItems.length} 份文档为已读基线`,
        description: `${scopeLabel}后续新增或改动的文档将自动重新亮起未读`,
        type: 'success',
        timeout: 8000,
        actionProps: {
          children: '撤销',
          onClick: () => {
            if (undone) return;
            undone = true;
            setReadingStates((cur) => restoreReadingStatesSnapshot(cur, previousSnapshot));
            toastManager.close(toastId);
            toastManager.add({
              title: '已撤销，恢复原未读状态',
              type: 'info',
            });
          },
        },
      });
      return true;
    }

    const res = await postBatchReadingState({
      action: 'mark_baseline',
      scope,
      folder_prefix: cleanPrefix,
    });
    if (!res.ok) {
      toastManager.add({
        title: '确立已读基线失败',
        description: res.error || '未能写入已读基线，请稍后重试',
        type: 'error',
      });
      return false;
    }
    const { affected_count, updated_items, undo_items } = res.data;
    if (affected_count === 0 || updated_items.length === 0) {
      toastManager.add({
        title: `${scopeLabel}已全部处于已读基线`,
        type: 'info',
      });
      return true;
    }

    const { next, previousSnapshot } = applyBatchReadingBaseline(
      readingStatesRef.current,
      updated_items
    );
    setReadingStates(next);

    let undone = false;
    const toastId = toastManager.add({
      title:
        scope === 'folder' && cleanPrefix
          ? `已将${scopeLabel} ${affected_count} 份文档标为已读`
          : `已确立 ${affected_count} 份存量文档为已读基线`,
      description: '后续新增或改动的文档将自动重新亮起未读（8 秒内可撤销）',
      type: 'success',
      timeout: 8000,
      actionProps: {
        children: '撤销',
        onClick: () => {
          if (undone) return;
          undone = true;
          toastManager.close(toastId);
          void (async () => {
            const restoreRes = await postBatchReadingState({
              action: 'restore',
              restore_items: undo_items,
            });
            if (!restoreRes.ok) {
              toastManager.add({
                title: '撤销已读基线失败',
                description: restoreRes.error || '服务端未能还原原未读状态',
                type: 'error',
              });
              return;
            }
            setReadingStates((cur) => restoreReadingStatesSnapshot(cur, previousSnapshot));
            toastManager.add({
              title: `已撤销，还原 ${affected_count} 份文档的原未读状态`,
              type: 'info',
            });
          })();
        },
      },
    });
    return true;
  };

  const handleScrollProgress = (fileId: string, scrollPercent: number) => {
    if (scrollPercent < 0 || scrollPercent > 100 || !Number.isFinite(scrollPercent)) {
      return;
    }
    setReadingStates((prev) => {
      const current = prev[fileId];
      if (current) {
        if (current.scrollPercent === scrollPercent && !current.baselineOnly) return prev;
        return {
          ...prev,
          [fileId]: {
            ...current,
            scrollPercent,
            updated_at: nowLocalIso(),
            baselineOnly: undefined,
          },
        };
      }
      return {
        ...prev,
        [fileId]: {
          file_id: fileId,
          scrollPercent,
          isFullyRead: false,
          bookmarked: false,
          updated_at: nowLocalIso(),
        },
      };
    });
  };

  const handleToggleBookmark = (fileId: string) => {
    setReadingStates((prev) => {
      const current = prev[fileId];
      return {
        ...prev,
        [fileId]: {
          ...(current || {
            file_id: fileId,
            scrollPercent: 0,
            isFullyRead: false,
          }),
          bookmarked: !current?.bookmarked,
          updated_at: nowLocalIso(),
          baselineOnly: undefined,
        },
      };
    });
  };

  const handleToggleMuteFolder = (folderPath: string) => {
    const norm = normalizeMutedFolderPath(folderPath);
    if (!norm) return;
    const wasMuted = mutedFolders.some((m) => normalizeMutedFolderPath(m) === norm);
    setMutedFolders((prev) => toggleMutedFolderList(prev, norm));
    toastManager.add({
      title: wasMuted ? `已取消静默目录「${norm}」` : `已静默目录「${norm}」`,
      description: wasMuted
        ? '该目录文档已重新显示在星图、日历与列表时间线中'
        : '已在星图、日历与列表中隐藏该目录；左栏与 Ctrl+K 仍可随时打开',
      type: 'info',
    });
  };

  const handleUnmuteFolder = (folderPath: string) => {
    const norm = normalizeMutedFolderPath(folderPath);
    if (!norm) return;
    setMutedFolders((prev) => prev.filter((m) => normalizeMutedFolderPath(m) !== norm));
    toastManager.add({
      title: `已恢复目录「${norm}」`,
      type: 'info',
    });
  };

  const handleClearMutedFolders = () => {
    if (mutedFolders.length === 0) return;
    const count = mutedFolders.length;
    setMutedFolders([]);
    toastManager.add({
      title: `已恢复全部 ${count} 个静默目录`,
      type: 'info',
    });
  };

  const handleSavePersonalNote = (fileId: string, note: string) => {
    setReadingStates((prev) => ({
      ...prev,
      [fileId]: {
        ...(prev[fileId] || {
          file_id: fileId,
          scrollPercent: 0,
          isFullyRead: false,
          bookmarked: false,
        }),
        personalNote: note,
        updated_at: nowLocalIso(),
        baselineOnly: undefined,
      },
    }));
  };

  const handleOpenDecisionReference = (
    decId: string,
    targetEvidence?: DecisionSourceEvidence
  ) => {
    setSelectedDecisionId(decId);
    const dec = decisions.find((d) => d.decision_id === decId);
    const evidence = targetEvidence ?? dec?.evidences[0];
    if (!evidence) return;
    handleJumpToSourceEvidence(
      evidence.file_id,
      evidence.revision_id,
      evidence.lineStart,
      evidence.officeAnchor,
      evidence.pdfAnchor
    );
    setIsMobileRightOpen(false);
  };

  const handleBoardJumpToStatement = (stmt: ReviewBoardPendingStatement) => {
    setIsReviewBoardOpen(false);
    const cached = fileCacheRef.current.get(stmt.file_id);
    const revId = cached?.current_revision_id || '';
    handleJumpToSourceEvidence(stmt.file_id, revId, stmt.line_start);
  };

  const handleBoardInspectDraft = (draft: ReviewBoardDraftBrief) => {
    setIsReviewBoardOpen(false);
    setProposalToast({
      draftId: draft.draft_id,
      fileId: draft.file_id,
      fileName: basenameOf(draft.path),
      versionLabel: draft.draft_version_label,
      conflict: draft.conflict,
      receiptSummary: draft.receipt_summary,
    });
    setProposalAdoptNotice(null);
    setProposalDiffExpanded(false);
    setProposalDiffContent(null);
    setProposalDiffError(null);
    void handleViewProposalDiff(draft.draft_id);
  };

  const handleDecisionResolved = useCallback(
    (p: {
      decisionId: string;
      statementId: string;
      fileId: string;
      decisionText?: string;
      confirmer?: string;
      effectiveDate?: string;
      blockingCleared?: boolean;
      lineStart?: number;
      lineEnd?: number;
    }) => {
      setDecisions((prev) =>
        prev.map((d) =>
          d.decision_id === p.decisionId ? { ...d, status: '已确认' as const } : d
        )
      );
      const sourceDecision = decisions.find((d) => d.decision_id === p.decisionId);
      const evidence = sourceDecision?.evidences[0];
      const question =
        sourceDecision?.question || p.decisionText?.trim() || '已拍板决策';
      pushDecisionChangeNote(
        buildDecisionChangeNote({
          decisionId: p.decisionId,
          code: sourceDecision?.code ?? null,
          question,
          decisionText:
            p.decisionText ?? sourceDecision?.confirmationBasis?.recordText ?? null,
          status: '已确认',
          confirmer: p.confirmer ?? sourceDecision?.confirmationBasis?.confirmer ?? null,
          effectiveDate: p.effectiveDate ?? null,
          confirmedAt: nowLocalIso(),
          fileId: p.fileId,
          filePath: evidence?.relative_path ?? null,
          lineStart: p.lineStart ?? evidence?.lineStart ?? null,
          lineEnd: p.lineEnd ?? evidence?.lineEnd ?? null,
          blockingCleared: p.blockingCleared === true,
          source: 'inline',
          at: nowLocalIso(),
        })
      );
      void fetchStateOverview().then((overview) => {
        if (overview.ok) setStateOverview(overview.data);
      });
    },
    [decisions, pushDecisionChangeNote]
  );

  const [hitlClearedAt, setHitlClearedAt] = useState<string | null>(null);
  const handleBlockingCleared = useCallback((_p: { fileId: string }) => {
    setHitlClearedAt(nowLocalIso());
  }, []);
  useEffect(() => {
    if (!hitlClearedAt) return;
    const timer = window.setTimeout(() => setHitlClearedAt(null), 8000);
    return () => window.clearTimeout(timer);
  }, [hitlClearedAt]);

  const deliveredInitiatives = useMemo(
    () => deliveredInitiativesOf(stateOverview?.initiatives ?? []),
    [stateOverview]
  );
  const deliveredInitiative = useMemo(() => {
    if (deliveredInitiatives.length === 0) return null;
    if (activeInitiative?.state === 'delivered') {
      const active = deliveredInitiatives.find(
        (row) => row.initiative_id === activeInitiative.id
      );
      if (active) return active;
    }
    return deliveredInitiatives[0];
  }, [deliveredInitiatives, activeInitiative]);
  type InitiativeLifecycleState = {
    initiativeId: string;
    action: 'archive' | 'reopen';
    phase: 'running' | 'error';
    message: string;
  };
  const [initiativeLifecycle, setInitiativeLifecycle] =
    useState<InitiativeLifecycleState | null>(null);
  const runInitiativeLifecycle = useCallback(
    async (initiativeId: string, action: 'archive' | 'reopen') => {
      if (lifecycleInFlightRef.current || initiativeLifecycle?.phase === 'running') return;
      lifecycleInFlightRef.current = true;
      const actionLabel = action === 'archive' ? '归档' : '重开';
      setInitiativeLifecycle({ initiativeId, action, phase: 'running', message: '' });
      try {
        const accepted =
          action === 'archive'
            ? await postInitiativeArchive(initiativeId)
            : await postInitiativeReopen(initiativeId);
        if (!accepted.ok) {
          setInitiativeLifecycle({
            initiativeId,
            action,
            phase: 'error',
            message: accepted.error || `${actionLabel}请求提交失败`,
          });
          return;
        }
        const settled = await pollJobUntilSettled(accepted.data.job_id);
        if (!settled.ok) {
          setInitiativeLifecycle({
            initiativeId,
            action,
            phase: 'error',
            message: settled.error || `${actionLabel}任务轮询失败`,
          });
          return;
        }
        const job = settled.data;
        if (job.state !== 'completed') {
          setInitiativeLifecycle({
            initiativeId,
            action,
            phase: 'error',
            message: job.error || `${actionLabel}任务失败`,
          });
          return;
        }
        const warn = action === 'archive' ? initiativeArchiveWarn(job.result) : null;
        if (warn) {
          console.warn(`[guanlan] ${actionLabel}完成但服务端提示：${warn}`);
        }
        setInitiativeLifecycle(null);
        const nextState = action === 'archive' ? 'archived' : 'draft';
        setStateOverview((prev) =>
          prev
            ? {
                ...prev,
                initiatives: prev.initiatives.map((initiative) =>
                  initiative.initiative_id === initiativeId
                    ? {
                        ...initiative,
                        state: nextState,
                      }
                    : initiative
                ),
              }
            : prev
        );
        const overview = await fetchStateOverview();
        if (overview.ok) setStateOverview(overview.data);
      } finally {
        lifecycleInFlightRef.current = false;
      }
    },
    [initiativeLifecycle?.phase]
  );

  const resetWorkspaceScopedState = useCallback(() => {
    readingPersist.flush();
    readingWorkspaceIdRef.current = null;
    setReadingStates({});
    if (publishTimerRef.current !== null) {
      window.clearTimeout(publishTimerRef.current);
      publishTimerRef.current = null;
    }
    fileCacheRef.current.clear();
    detailLoadedIdsRef.current.clear();
    clearRevisionContentStore();
    clearFilePreviewCache();
    setConfig(EMPTY_WORKSPACE_CONFIG);
    setFiles([]);
    setHydratedFilesById({});
    setFilesTotal(0);
    setFileFacets(null);
    setEvents([]);
    setDecisions([]);
    setRelations([]);
    setDataSource('loading');
    setDataError(null);
    setScanSummary('');
    setEventDays(null);
    setActiveDate(undefined);
    setEventPage(null);
    setEventPageLoading(false);
    setUndatedOnly(false);
    setEventOrder('occurred');
    setEventKindFilter('all');
    eventKindFilterRef.current = 'all';
    setDayGranularity('day');
    setDrillRange(null);
    dayQueryRef.current = { granularity: 'day', order: 'occurred', drill: null };
    setChangeNotice(null);
    streamEverConnectedRef.current = false;
    streamDisconnectedRef.current = false;
    setStreamDisconnected(false);
    rescanInFlightRef.current = false;
    retryInFlightRef.current = false;
    setRetryingConnection(false);
    setRescanState('idle');
    setRescanError('');
    setActiveJobId('');
    setPollTick(0);
    setServiceStatus(null);
    setStateOverview(null);
    resetL4aProgress();
    setEventDataReady(false);
    setWorkspaceSummary(null);
    setEventRange(null);
    setDateFilter({});
    dateFilterRef.current = {};
    eventFetchGenRef.current += 1;
    setHistoryFileId('');
    setActiveTab('home');
    setPanoramaMode('canvas');
    setLibraryMode('read');
    setEventTrail([]);
    setActiveFileId('');
    setPinnedRevisionId('');
    setReaderSubMode('read');
    setReaderAnchor(null);
    setReaderFocusSection(null);
    readerScrollPercentRef.current = undefined;
    readerScrollRef.current = null;
    setSelectedEventId('');
    setSelectedDecisionId('');
    setReturnBreadcrumb(null);
    navSourceStackRef.current = [];
    setNavSourceStack([]);
    trailEnteredFromStackRef.current = false;
    setSearchQuery('');
    setDebouncedSearchQuery('');
    setSidebarFilters({
      quickScope: 'all',
      folder: 'all',
      format: 'all',
      role: 'all',
      topic: 'all',
    });
    setIsSettingsOpen(false);
    setIsMcpConsoleOpen(false);
    setIsContextDrawerOpen(false);
    setIsMobileLeftOpen(false);
    setIsMobileRightOpen(false);
    setLibraryInspectorOpen(false);
    setContextPointers([]);
    setProposalToast(null);
    setProposalAdopting(false);
    setProposalRejecting(false);
    setProposalAdoptNotice(null);
    setProposalDiffExpanded(false);
    setProposalDiffLoading(false);
    setProposalDiffError(null);
    setProposalDiffContent(null);
    setDecisionChangeNote(null);
    setDecisionChangeToast(null);
    lastPushedDecisionRef.current = null;
    setContextSessionCheckpointId(null);
    setHitlClearedAt(null);
    setInitiativeLifecycle(null);
    setFileContextMenu(null);
    setSystemToast(null);
    setDragDropOverlay({ active: false, paths: [], hoveredFolder: null });
  }, [readingPersist]);

  const applyDesktopSessionState = useCallback(
    (next: DesktopSessionState) => {
      const sameReadyTarget =
        desktopSession?.status === 'ready' &&
        next.status === 'ready' &&
        desktopSession.root === next.root &&
        next.endpoint === getApiBaseUrl();
      if (sameReadyTarget) {
        setDesktopSession(next);
        setWorkspaceSwitchError(null);
        return;
      }
      setApiBaseUrl(next.status === 'ready' ? next.endpoint : '');
      resetWorkspaceScopedState();
      setDesktopSession(next);
      setWorkspaceSwitchError(null);
      setWorkspaceEpoch((n) => n + 1);
    },
    [desktopSession?.root, desktopSession?.status, resetWorkspaceScopedState]
  );

  const desktopReconciledRef = useRef(false);
  useEffect(() => {
    if (!desktopBridgeAvailable || desktopReconciledRef.current) return;
    desktopReconciledRef.current = true;
    let cancelled = false;
    void (async () => {
      const live = await refreshDesktopSession();
      if (cancelled || !live) return;
      if (
        live.status !== desktopSession?.status ||
        live.endpoint !== getApiBaseUrl() ||
        live.root !== desktopSession?.root
      ) {
        applyDesktopSessionState(live);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyDesktopSessionState, desktopBridgeAvailable, desktopSession?.root, desktopSession?.status]);

  const handleSwitchWorkspace = useCallback(
    async (root: string) => {
      const target = root.trim();
      if (!target || switchingWorkspaceRef.current || switchingWorkspace) return;
      switchingWorkspaceRef.current = true;
      setSwitchingWorkspace(true);
      setWorkspaceSwitchError(null);
      streamDisconnectedRef.current = false;
      setStreamDisconnected(false);
      try {
        const res = await switchDesktopWorkspace(target);
        if (!res.ok) {
          setWorkspaceSwitchError(res.error.message);
          return;
        }
        applyDesktopSessionState(res.state);
      } finally {
        switchingWorkspaceRef.current = false;
        setSwitchingWorkspace(false);
      }
    },
    [applyDesktopSessionState, switchingWorkspace]
  );

  const handlePickWorkspaceFolder = useCallback(async () => {
    if (switchingWorkspace) return;
    setWorkspaceSwitchError(null);
    const picked = await pickDesktopWorkspaceFolder();
    if (!picked.ok) {
      setWorkspaceSwitchError(picked.error || '打开文件夹选择器失败');
      return;
    }
    if (picked.path) {
      await handleSwitchWorkspace(picked.path);
    }
  }, [handleSwitchWorkspace, switchingWorkspace]);

  const handleRemoveRecentWorkspace = useCallback(async (root: string) => {
    const updated = await removeRecentDesktopWorkspace(root);
    if (!updated) return;
    setDesktopSession((prev) => (prev ? { ...prev, recentWorkspaces: updated } : prev));
  }, []);

  const handleAddEvidencePointer = (pointer: EvidencePointer) => {
    setContextPointers((prev) => [pointer, ...prev]);
  };

  const handleAddDecisionReceiptToBasket = (payload: DecisionReceiptBasketPayload) => {
    const file = files.find((f) => f.file_id === payload.file_id);
    const rev = file?.revisions.find((r) => r.revision_id === payload.revision_id);
    const fillSummary = payload.fillValues.map((f) => `${f.prompt}：${f.value}`).join('；');
    handleAddEvidencePointer({
      file_id: payload.file_id,
      revision_id: payload.revision_id,
      relative_path: file?.relative_path ?? '',
      content_sha256: rev?.content_sha256 ?? '',
      locator: { kind: 'file' },
      evidence_kind: 'decision_record',
      index_generation: config.runtimeStatus.indexGeneration,
      observed_at: rev?.observed_at ?? new Date().toISOString(),
      coverage: file?.format === 'md' ? 'full_text' : 'filename_only',
      stale: false,
      excerpt: payload.selectedOptions.join('\n'),
      note: `决策回执：已勾选 ${payload.selectedOptions.length} 项${
        payload.fillValues.length > 0
          ? ` · 填空 ${payload.fillValues.length} 项（${fillSummary}）`
          : ''
      }`,
    });
  };

  const loadMoreEvents = async (): Promise<boolean> => {
    if (!eventPage?.next_cursor || eventPageLoading) return false;
    setEventPageLoading(true);
    const gen = eventFetchGenRef.current;
    const nextQuery = {
      limit: 50,
      order: eventOrder,
      undated: undatedOnly,
      from: dateFilterRef.current.from,
      to: dateFilterRef.current.to,
      kinds: currentEventKinds(),
    };
    const next = await fetchEventPage({
      ...nextQuery,
      cursor: eventPage.next_cursor,
    });
    if (eventFetchGenRef.current !== gen) {
      setEventPageLoading(false);
      return false;
    }
    if (next.stale) {
      const fresh = await fetchEventPage(nextQuery);
      setEventPageLoading(false);
      if (eventFetchGenRef.current !== gen) return false;
      if (fresh.page) {
        setEventPage(fresh.page);
        mergeEventsPage(fresh.page.items);
        return true;
      }
      return false;
    }
    setEventPageLoading(false);
    if (!next.page) return false;
    const nextPage = next.page;
    const nextItems = nextPage.items;
    setEventPage((prev) =>
      prev ? { ...nextPage, items: [...prev.items, ...nextItems] } : nextPage
    );
    mergeEventsPage(nextItems);
    return true;
  };

  const refreshEvents = async () => {
    eventFetchGenRef.current += 1;
    const gen = eventFetchGenRef.current;
    const dq = dayQueryRef.current;
    const [result, days] = await Promise.all([
      fetchEventPage({
        limit: 50,
        undated: undatedOnly,
        order: eventOrder,
        from: dateFilterRef.current.from,
        to: dateFilterRef.current.to,
        kinds: currentEventKinds(),
      }),
      fetchEventDays({
        limitDays: DAYS_QUERY_LIMIT,
        samplesPerDay: 6,
        granularity: dq.granularity,
        order: dq.order,
        ...daysWindow(dq.order, eventRange, dq.drill),
      }),
    ]);
    if (result.page && eventFetchGenRef.current === gen) {
      setEventPage(result.page);
      mergeEventsPage(result.page.items);
      setChangeNotice(null);
    }
    if (days && sameDayQuery(dayQueryRef.current, dq)) setEventDays(days);
  };

  const silentMergeNewEvents = async () => {
    if (silentMergeInFlightRef.current || silentMergingEvents) return;
    silentMergeInFlightRef.current = true;
    setSilentMergingEvents(true);
    const dq = dayQueryRef.current;
    try {
      const [result, days] = await Promise.all([
        fetchEventPage({
          limit: 50,
          undated: undatedOnly,
          order: eventOrder,
          from: dateFilterRef.current.from,
          to: dateFilterRef.current.to,
          kinds: currentEventKinds(),
        }),
        fetchEventDays({
          limitDays: DAYS_QUERY_LIMIT,
          samplesPerDay: 6,
          granularity: dq.granularity,
          order: dq.order,
          ...daysWindow(dq.order, eventRange, dq.drill),
        }),
      ]);
      let mergedCount = changeNotice?.count ?? 0;
      if (result.page) {
        mergeEventsPage(result.page.items);
        setEventPage((prev) => {
          const { mergedPage, addedCount } = mergeIncrementalEventPage(prev, result.page!);
          if (addedCount > 0) mergedCount = addedCount;
          return mergedPage;
        });
        setChangeNotice(null);
      }
      if (days && sameDayQuery(dayQueryRef.current, dq)) setEventDays(days);
      showSystemToast(
        'ok',
        mergedCount > 0
          ? `已静默并入 ${mergedCount} 条新事件（当前浏览位置未变）`
          : '已同步最新增量事件（当前浏览位置未变）'
      );
    } finally {
      silentMergeInFlightRef.current = false;
      setSilentMergingEvents(false);
    }
  };

  const showSystemToast = useCallback(
    (
      tone: 'ok' | 'warn' | 'error',
      message: string,
      extras?: { revealPath?: string; openPath?: string }
    ) => {
      systemToastSeqRef.current += 1;
      setSystemToast({
        id: systemToastSeqRef.current,
        tone,
        message,
        revealPath: extras?.revealPath,
        openPath: extras?.openPath,
      });
    },
    []
  );

  useEffect(() => {
    if (!systemToast) return;
    const timer = window.setTimeout(() => {
      setSystemToast((prev) => (prev?.id === systemToast.id ? null : prev));
    }, 5200);
    return () => window.clearTimeout(timer);
  }, [systemToast]);

  const defaultImportTargetDir = useMemo(() => {
    if (activeTab === 'library' && sidebarFilters.folder !== 'all') {
      const checked = validateImportTargetDir(sidebarFilters.folder);
      if (checked.ok) return checked.normalized;
    }
    return '';
  }, [activeTab, sidebarFilters.folder]);

  const handleRevealInExplorer = useCallback(
    async (relativePath: string) => {
      const normalized = normalizeRelativeWorkspacePath(relativePath, true);
      if (normalized === null) {
        showSystemToast('error', '拒绝定位工作区之外或包含非法段的路径');
        return;
      }
      const res = await revealInDesktopExplorer(normalized);
      if (!res.ok) {
        showSystemToast('error', res.error);
        return;
      }
      const label = basenameOf(normalized) || displayFolderLabel(normalized);
      showSystemToast('ok', `已在资源管理器中显示：${label}`);
    },
    [showSystemToast]
  );

  const handleOpenWithDefaultApp = useCallback(
    async (relativePath: string) => {
      const normalized = normalizeRelativeWorkspacePath(relativePath, false);
      if (normalized === null) {
        showSystemToast('error', '拒绝用默认应用打开工作区外或非法路径');
        return;
      }
      const res = await openWithDesktopDefaultApp(normalized);
      if (!res.ok) {
        showSystemToast('error', res.error);
        return;
      }
      showSystemToast('ok', `已调用系统默认应用打开：${basenameOf(normalized) || normalized}`);
    },
    [showSystemToast]
  );

  const handleCopyRelativePath = useCallback(
    async (relativePath: string) => {
      const normalized = normalizeRelativeWorkspacePath(relativePath, true);
      if (normalized === null) {
        showSystemToast('error', '拒绝复制非法或越界相对路径');
        return;
      }
      const text = normalized || '.';
      const copied = await copyTextWithDesktopFallback(text);
      if (!copied.ok) {
        showSystemToast('error', copied.error || '复制相对路径失败');
        return;
      }
      showSystemToast('ok', `已复制相对路径：${text}`);
    },
    [showSystemToast]
  );

  const handleCopyAbsolutePath = useCallback(
    async (relativePath: string) => {
      const normalized = normalizeRelativeWorkspacePath(relativePath, true);
      if (normalized === null) {
        showSystemToast('error', '拒绝复制非法或越界绝对路径');
        return;
      }
      const abs = await resolveDesktopAbsolutePath(normalized, config.rootPath);
      if (!abs) {
        showSystemToast('error', '当前未解析到工作区绝对路径');
        return;
      }
      const copied = await copyTextWithDesktopFallback(abs);
      if (!copied.ok) {
        showSystemToast('error', copied.error || '复制绝对路径失败');
        return;
      }
      showSystemToast('ok', `已复制绝对路径：${abs}`);
    },
    [config.rootPath, showSystemToast]
  );

  const handleImportExternalPaths = useCallback(
    async (sourcePaths: string[], rawTargetDir: string) => {
      if (sourcePaths.length === 0) return;
      const validated = validateImportTargetDir(rawTargetDir);
      if (!validated.ok) {
        showSystemToast('error', validated.error);
        return;
      }
      const outcome = await importDesktopExternalFiles(sourcePaths, validated.normalized);
      if (!outcome.ok) {
        showSystemToast('error', outcome.error);
        return;
      }
      const data = outcome.data;
      if (data.jobId) {
        for (let attempt = 0; attempt < 24; attempt += 1) {
          const status = await fetchIndexJobStatus(data.jobId);
          if (!status.ok) break;
          if (status.data.state === 'completed' || status.data.state === 'failed') break;
          await new Promise((resolve) => window.setTimeout(resolve, 25));
        }
        setChangeNotice(null);
        setBootstrapNonce((n) => n + 1);
        if (dateFilterRef.current.from || eventKindFilterRef.current !== 'all') {
          void refreshEvents();
        }
      }

      if (data.imported.length === 0) {
        const reason = data.skipped[0]?.reason || '没有符合条件的常规文件';
        showSystemToast('warn', `未能导入文件：${reason}`);
        return;
      }

      const first = data.imported[0];
      const targetLabel = displayFolderLabel(data.targetDir);
      const indexedCount = data.indexedRelativePaths.length;
      const unindexedCount = data.imported.length - indexedCount;
      const indexNote =
        unindexedCount > 0 && indexedCount === 0
          ? '（已安全落盘，当前索引仅收录 MD/SVG/PDF）'
          : unindexedCount > 0
            ? `（${indexedCount} 份已纳入今日时间线，${unindexedCount} 份非 MD/SVG/PDF 仅落盘）`
            : '（已纳入索引与今日时间线）';
      const skipNote =
        data.skipped.length > 0
          ? `；跳过 ${data.skipped.length} 项（${data.skipped[0].reason}）`
          : '';
      showSystemToast(
        data.skipped.length > 0 ? 'warn' : 'ok',
        `已导入 ${data.imported.length} 份文件到 ${targetLabel}${indexNote}${skipNote}`,
        {
          revealPath: first.relativePath,
          openPath: first.relativePath,
        }
      );
    },
    [showSystemToast]
  );

  const handleImportIntoFolder = useCallback(
    async (folderRelativePath: string) => {
      const picked = await pickDesktopExternalFiles();
      if (!picked.ok) {
        showSystemToast('error', picked.error || '打开文件选择器失败');
        return;
      }
      if (picked.paths.length > 0) {
        await handleImportExternalPaths(picked.paths, folderRelativePath);
      }
    },
    [handleImportExternalPaths, showSystemToast]
  );

  const handleOpenFileContextMenu = useCallback(
    (e: React.MouseEvent, target: FileContextMenuTarget) => {
      setFileContextMenu({ x: e.clientX, y: e.clientY, target });
    },
    []
  );

  const nativeDropHandlerRef = useRef<
    (ev: Parameters<Parameters<typeof subscribeNativeDragDrop>[0]>[0]) => void
  >(() => {});
  nativeDropHandlerRef.current = (ev) => {
    if (!hasActiveBackend || !desktopSystemAvailable) return;
    if (ev.kind === 'enter') {
      setDragDropOverlay({
        active: true,
        paths: ev.paths,
        hoveredFolder: detectDropFolderAt(ev.x, ev.y),
      });
    } else if (ev.kind === 'over') {
      const hovered = detectDropFolderAt(ev.x, ev.y);
      setDragDropOverlay((prev) =>
        prev.active && prev.hoveredFolder === hovered
          ? prev
          : { ...prev, active: true, hoveredFolder: hovered }
      );
    } else if (ev.kind === 'leave') {
      setDragDropOverlay((prev) =>
        !prev.active && prev.paths.length === 0 && prev.hoveredFolder === null
          ? prev
          : { active: false, paths: [], hoveredFolder: null }
      );
    } else if (ev.kind === 'drop') {
      const hovered = detectDropFolderAt(ev.x, ev.y);
      setDragDropOverlay({ active: false, paths: [], hoveredFolder: null });
      const target = hovered !== null ? hovered : defaultImportTargetDir;
      void handleImportExternalPaths(ev.paths, target);
    }
  };

  useEffect(() => {
    return subscribeNativeDragDrop((ev) => nativeDropHandlerRef.current(ev));
  }, []);

  const handleFileOpHistoryApplied = useCallback(
    (resp: import('../services/apiTypes').FileMutationResponse) => {
      detailLoadedIdsRef.current.delete(resp.file_id);
      if (resp.new_path) {
        const nextPath = resp.new_path;
        const existing = fileCacheRef.current.get(resp.file_id);
        if (existing) {
          const prevPaths = Array.from(
            new Set([...(existing.previous_paths ?? []), resp.old_path])
          ).filter((p) => p !== nextPath);
          fileCacheRef.current.set(resp.file_id, {
            ...existing,
            relative_path: nextPath,
            previous_paths: prevPaths.length > 0 ? prevPaths : existing.previous_paths,
            title: resp.title || existing.title,
            folder: folderOfRelativePath(nextPath),
            role: (resp.role as FileRecord['role']) || existing.role,
          });
        }
        publishFiles();
        setContextPointers((prev) =>
          prev.map((p) =>
            p.file_id === resp.file_id ? { ...p, relative_path: nextPath } : p
          )
        );
      }
      setChangeNotice(null);
      setBootstrapNonce((n) => n + 1);
      if (dateFilterRef.current.from || eventKindFilterRef.current !== 'all') {
        void refreshEvents();
      }
    },
    [publishFiles]
  );

  const fileOpHistory = useFileOpHistory({
    workspaceEpoch,
    showToast: showSystemToast,
    onApplied: handleFileOpHistoryApplied,
  });

  const handleFileMutationSuccess = useCallback(
    (resp: import('../services/apiTypes').FileMutationResponse, message: string) => {
      if (resp.operation === 'file_trashed') {
        setActiveFileId((prev) => {
          if (prev !== resp.file_id) return prev;
          const remaining = Array.from(fileCacheRef.current.values()).sort((a, b) =>
            a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0
          );
          const fallback = remaining.find((f) => f.format === 'md') || remaining[0];
          return fallback ? fallback.file_id : '';
        });
        setPinnedRevisionId((prev) => (activeFileId === resp.file_id ? '' : prev));
        setHistoryFileId((prev) => (prev === resp.file_id ? '' : prev));
        setContextPointers((prev) => prev.filter((p) => p.file_id !== resp.file_id));
        showSystemToast('warn', message);
      } else {
        if (
          (resp.operation === 'file_renamed' || resp.operation === 'file_moved') &&
          resp.old_path &&
          resp.new_path
        ) {
          fileOpHistory.recordOp(
            resp.operation === 'file_renamed' ? 'rename' : 'move',
            resp.file_id,
            resp.old_path,
            resp.new_path
          );
        }
        if (resp.new_path) {
          const nextPath = resp.new_path;
          setContextPointers((prev) =>
            prev.map((p) =>
              p.file_id === resp.file_id ? { ...p, relative_path: nextPath } : p
            )
          );
        }
        showSystemToast(
          'ok',
          message,
          desktopSystemAvailable && resp.new_path
            ? { revealPath: resp.new_path, openPath: resp.new_path }
            : undefined
        );
      }
      setChangeNotice(null);
      setBootstrapNonce((n) => n + 1);
      if (dateFilterRef.current.from || eventKindFilterRef.current !== 'all') {
        void refreshEvents();
      }
    },
    [activeFileId, desktopSystemAvailable, fileOpHistory, showSystemToast]
  );

  const {
    fileOpModal,
    fileOpSubmitting,
    fileOpError,
    folderOptions: baseFileOpFolderOptions,
    openFileOp,
    closeFileOp,
    submitFileOp,
  } = useFileOps({
    workspaceEpoch,
    files,
    decisions,
    fileCacheRef,
    detailLoadedIdsRef,
    publishFiles,
    onMutationSuccess: handleFileMutationSuccess,
  });

  const pendingOpenNewFileIdRef = useRef<string | null>(null);
  const [sidebarInlineAction, setSidebarInlineAction] = useState<{
    seq: number;
    kind: 'create-folder' | 'create-doc' | 'rename-folder';
    folderPath: string;
  } | null>(null);
  const triggerSidebarInlineAction = useCallback(
    (kind: 'create-folder' | 'create-doc' | 'rename-folder', folderPath: string) => {
      setSidebarInlineAction((prev) => ({
        seq: (prev?.seq ?? 0) + 1,
        kind,
        folderPath,
      }));
    },
    []
  );
  const handleSyncAfterDirMutation = useCallback(
    (opts?: {
      renamedFolder?: { from: string; to: string };
      trashedFolder?: string;
      openNewFileId?: string;
    }) => {
      if (opts?.renamedFolder) {
        const { from, to } = opts.renamedFolder;
        setSidebarFilters((prev) => {
          if (prev.folder === from) return { ...prev, folder: to };
          if (prev.folder.startsWith(`${from}/`)) {
            return { ...prev, folder: `${to}${prev.folder.slice(from.length)}` };
          }
          return prev;
        });
      }
      if (opts?.trashedFolder) {
        const trashed = opts.trashedFolder;
        setSidebarFilters((prev) =>
          prev.folder === trashed || prev.folder.startsWith(`${trashed}/`)
            ? { ...prev, folder: 'all' }
            : prev
        );
      }
      if (opts?.openNewFileId) {
        pendingOpenNewFileIdRef.current = opts.openNewFileId;
      }
      setChangeNotice(null);
      setBootstrapNonce((n) => n + 1);
      if (dateFilterRef.current.from || eventKindFilterRef.current !== 'all') {
        void refreshEvents();
      }
    },
    [refreshEvents]
  );

  const dirShell = useDirectoryShell({
    enabled: hasActiveBackend && !switchingWorkspace,
    workspaceScopeKey: config.rootPath || 'default',
    workspaceEpoch,
    bootstrapNonce,
    onSyncAfterMutation: handleSyncAfterDirMutation,
    showToast: showSystemToast,
  });

  const pendingCrossProjectRef = useRef<PendingCrossProjectTarget | null>(null);
  const currentActiveProjectIdRef = useRef<string>('');

  const handleProjectActivated = useCallback(
    (projectId: string, pendingTarget?: PendingCrossProjectTarget) => {
      const sameProject =
        Boolean(currentActiveProjectIdRef.current) &&
        currentActiveProjectIdRef.current === projectId;
      currentActiveProjectIdRef.current = projectId;

      if (sameProject) {
        if (pendingTarget) {
          if (pendingTarget.folder !== undefined) {
            setSidebarFilters((prev) => ({
              ...prev,
              folder: pendingTarget.folder || 'all',
              quickScope: 'all',
            }));
            setActiveTab(pendingTarget.openTab ?? 'library');
            setLibraryMode(pendingTarget.libraryMode ?? 'overview');
          } else if (pendingTarget.fileId) {
            setActiveFileId(pendingTarget.fileId);
            setActiveTab('library');
            setLibraryMode('read');
          } else if (pendingTarget.decisionId) {
            handleOpenDecisionReference(pendingTarget.decisionId);
          } else if (pendingTarget.openTab) {
            setActiveTab(pendingTarget.openTab);
            if (pendingTarget.libraryMode) setLibraryMode(pendingTarget.libraryMode);
          }
        }
        return;
      }

      pendingCrossProjectRef.current = pendingTarget ?? null;
      resetWorkspaceScopedState();
      if (pendingTarget?.openTab) {
        setActiveTab(pendingTarget.openTab);
        if (pendingTarget.libraryMode) setLibraryMode(pendingTarget.libraryMode);
      } else if (pendingTarget?.folder !== undefined) {
        setActiveTab('library');
        setLibraryMode('overview');
      } else if (pendingTarget?.fileId) {
        setActiveTab('library');
        setLibraryMode('read');
      }
      setWorkspaceEpoch((e) => e + 1);
    },
    [handleOpenDecisionReference, resetWorkspaceScopedState]
  );

  const multiProjects = useMultiProjects({
    enabled: hasActiveBackend && !switchingWorkspace,
    workspaceEpoch,
    bootstrapNonce,
    onProjectActivated: handleProjectActivated,
    showToast: showSystemToast,
  });

  useEffect(() => {
    currentActiveProjectIdRef.current = multiProjects.activeProjectId;
    setMultiProjectCount(Math.max(1, multiProjects.projects.length));
  }, [multiProjects.activeProjectId, multiProjects.projects.length]);

  useEffect(() => {
    multiProjectsRefreshRef.current = () => {
      void multiProjects.refreshAll({ reloadExpandedTrees: true });
    };
  }, [multiProjects.refreshAll]);

  useEffect(() => {
    const pending = pendingCrossProjectRef.current;
    if (!pending) return;
    if (pending.projectId && multiProjects.activeProjectId && pending.projectId !== multiProjects.activeProjectId) {
      return;
    }
    if (pending.folder !== undefined) {
      const targetFolder = pending.folder;
      pendingCrossProjectRef.current = null;
      setSidebarFilters((prev) => ({
        ...prev,
        folder: targetFolder || 'all',
        quickScope: 'all',
      }));
      setActiveTab(pending.openTab ?? 'library');
      setLibraryMode(pending.libraryMode ?? 'overview');
      return;
    }
    if (pending.fileId) {
      const hit = files.find((f) => f.file_id === pending.fileId);
      if (!hit) return;
      pendingCrossProjectRef.current = null;
      setActiveFileId(hit.file_id);
      setPinnedRevisionId(hit.current_revision_id);
      setActiveTab('library');
      setLibraryMode('read');
      return;
    }
    if (pending.decisionId) {
      const hit = decisions.find((d) => d.decision_id === pending.decisionId);
      if (!hit) return;
      pendingCrossProjectRef.current = null;
      handleOpenDecisionReference(hit.decision_id);
    }
  }, [decisions, files, handleOpenDecisionReference, multiProjects.activeProjectId]);

  useEffect(() => {
    const pendingId = pendingOpenNewFileIdRef.current;
    if (!pendingId) return;
    const hit = files.find((f) => f.file_id === pendingId);
    if (!hit) return;
    pendingOpenNewFileIdRef.current = null;
    setActiveFileId(hit.file_id);
    setPinnedRevisionId(hit.current_revision_id);
    setActiveTab('library');
    setLibraryMode('read');
  }, [files]);

  const folderOptionsNeeded = Boolean(fileOpModal || dirShell.dirOpModal);
  const fileOpFolderOptions = useMemo(
    () =>
      !folderOptionsNeeded
        ? EMPTY_FOLDER_OPTIONS
        : dirShell.realFolders.length > 0
          ? collectMergedFolderOptions(files, dirShell.realFolders)
          : baseFileOpFolderOptions,
    [baseFileOpFolderOptions, dirShell.realFolders, files, folderOptionsNeeded]
  );

  const referenceRepair = useReferencePathRepair({
    files,
    relations,
    decisions,
    fetchRevisionContent,
  });
  const referenceImpact = useMemo<ReferenceImpactState>(() => {
    if (!fileOpModal || (fileOpModal.kind !== 'move' && fileOpModal.kind !== 'rename')) {
      return { loading: false, items: [], saveAvailable: referenceRepair.saveAvailable };
    }
    return {
      loading: false,
      items: referenceRepair.collectAffectedReferences(fileOpModal.fileId),
      saveAvailable: referenceRepair.saveAvailable,
    };
  }, [fileOpModal, referenceRepair]);

  const handleFileOpsSubmit = useCallback(
    async (payload: FileOpSubmitPayload) => {
      const source = fileOpModal;
      const oldPath = source?.relativePath ?? '';
      const ok = await submitFileOp(payload);
      if (!ok) return;
      if (
        (payload.kind === 'move' || payload.kind === 'rename') &&
        payload.updateReferences &&
        oldPath
      ) {
        const baseName = fileNameOf(oldPath);
        const dir =
          payload.kind === 'move'
            ? payload.targetDir
            : oldPath.includes('/')
              ? oldPath.slice(0, oldPath.lastIndexOf('/'))
              : '';
        const finalName =
          payload.kind === 'move' && payload.newName ? payload.newName : baseName;
        const newPath = dir ? `${dir}/${finalName}` : finalName;
        const outcome = await referenceRepair.repairAfterMutation({
          fileId: payload.fileId,
          oldPath,
          newPath,
          updateReferences: true,
        });
        if (outcome.repaired.length > 0) {
          showSystemToast(
            'ok',
            `已同步更新 ${outcome.repaired.length} 个文档中的引用相对路径（共 ${outcome.repaired.reduce((sum, r) => sum + r.hrefCount, 0)} 处）`
          );
        }
        if (outcome.failed.length > 0) {
          showSystemToast(
            'warn',
            `引用路径修复 ${outcome.failed.length} 个文档失败（原文档未改写）：${outcome.failed
              .map((f) => `${f.relativePath}——${f.reason}`)
              .join('；')}`
          );
        }
      }
    },
    [fileOpModal, referenceRepair, showSystemToast, submitFileOp]
  );

  const handleRenameFile = useCallback(
    (target: { fileId: string; relativePath: string; title: string }) => {
      openFileOp('rename', target);
    },
    [openFileOp]
  );

  const handleMoveFile = useCallback(
    (target: { fileId: string; relativePath: string; title: string }) => {
      openFileOp('move', target);
    },
    [openFileOp]
  );

  const handleTrashFile = useCallback(
    (target: { fileId: string; relativePath: string; title: string }) => {
      openFileOp('trash', target);
    },
    [openFileOp]
  );

  const handleTreeMoveFile = useCallback(
    (fileId: string, targetDir: string) => {
      const target = files.find((f) => f.file_id === fileId);
      if (!target) return;
      if (target.folder === (targetDir === '' ? '.' : targetDir)) return;
      const affected = referenceRepair.collectAffectedReferences(fileId);
      if (affected.length > 0) {
        openFileOp('move', {
          fileId,
          relativePath: target.relative_path,
          title: target.title,
        });
        return;
      }
      void submitFileOp({ kind: 'move', fileId, targetDir });
    },
    [files, openFileOp, referenceRepair, submitFileOp]
  );

  const handleSyncQuickPreviewSelection = useCallback(
    (fileId: string, revisionId?: string) => {
      const target = files.find((f) => f.file_id === fileId);
      if (!target) return;
      setActiveFileId(target.file_id);
      setPinnedRevisionId(revisionId || target.current_revision_id);
    },
    [files]
  );

  const {
    quickPreviewTarget,
    quickPreviewQueue,
    openQuickPreview,
    closeQuickPreview,
    navigateQuickPreview,
  } = useQuickPreview({
    workspaceEpoch,
    activeTab,
    panoramaMode,
    libraryMode,
    files,
    filteredFiles,
    events,
    activeFile: activeFile ?? null,
    pinnedRevisionId,
    selectedEventId,
      hasBlockingOverlay: Boolean(
        fileContextMenu ||
          fileOpModal ||
          dirShell.dirOpModal ||
          multiProjects.addProjectModalOpen ||
          historyFileId !== '' ||
          isSettingsOpen ||
          isMcpConsoleOpen ||
          isContextDrawerOpen ||
          isReviewBoardOpen ||
          isChronosDigestOpen ||
          isHelpOpen ||
          isPaletteOpen ||
          isMountPanelOpen
      ),
    onSyncSelection: handleSyncQuickPreviewSelection,
  });

  const resolveFocusedFileForShortcut = (): {
    file: FileRecord;
    revisionId: string;
  } | null => {
    if (activeTab === 'panorama' && panoramaMode === 'canvas' && eventTrail.length > 0) {
      const top = eventTrail[eventTrail.length - 1];
      const f = fileCacheRef.current.get(top.fileId) ?? files.find((item) => item.file_id === top.fileId);
      if (f) return { file: f, revisionId: top.revisionId || f.current_revision_id };
    }
    if (activeTab === 'panorama' && panoramaMode === 'list' && selectedEventId) {
      const ev = events.find((item) => item.event_id === selectedEventId);
      if (ev?.file_id) {
        const f = fileCacheRef.current.get(ev.file_id) ?? files.find((item) => item.file_id === ev.file_id);
        if (f) return { file: f, revisionId: ev.revision_id || f.current_revision_id };
      }
    }
    if (activeFile) {
      return {
        file: activeFile,
        revisionId: pinnedRevisionId || activeFile.current_revision_id,
      };
    }
    return null;
  };

  useGlobalShortcuts({
    enabled: hasActiveBackend,
    onAction: (action: ShortcutAction): boolean => {
      if (action === 'nav-tab-home') {
        handleSelectPrimaryTab('home');
        return true;
      }
      if (action === 'nav-tab-panorama') {
        handleSelectPrimaryTab('panorama');
        return true;
      }
      if (action === 'nav-tab-library') {
        handleSelectPrimaryTab('library');
        return true;
      }
      if (action === 'nav-panorama-star') {
        handleSelectPrimaryTab('panorama');
        setPanoramaMode('canvas');
        return true;
      }
      if (action === 'nav-panorama-calendar') {
        handleSelectPrimaryTab('panorama');
        setPanoramaMode('calendar');
        return true;
      }
      if (action === 'nav-panorama-list') {
        handleSelectPrimaryTab('panorama');
        setPanoramaMode('list');
        return true;
      }
      if (action === 'toggle-left-sidebar') {
        if (activeTab === 'panorama') {
          dirShell.togglePanoramaSidebar();
        } else {
          dirShell.setSidebarCollapsed(!dirShell.sidebarCollapsed);
        }
        return true;
      }
      if (action === 'toggle-right-inspector') {
        if (activeTab === 'library') {
          if (libraryMode === 'overview') {
            setOverviewInspectorCollapsed((v) => !v);
          } else {
            setLibraryInspectorOpen((v) => !v);
          }
          return true;
        }
        return false;
      }

      if (action === 'undo-op') {
        if (!fileOpHistory.canUndo) return false;
        void fileOpHistory.undo(files);
        return true;
      }
      if (action === 'redo-op') {
        if (!fileOpHistory.canRedo) return false;
        void fileOpHistory.redo(files);
        return true;
      }
      const target = resolveFocusedFileForShortcut();
      if (!target) return false;

      if (action === 'deep-read-focus') {
        if (activeTab === 'library' && libraryMode === 'read') return false;
        handleOpenFileFromTimelineOrGraph(target.file.file_id, target.revisionId, 'read');
        return true;
      }

      if (action === 'open-version-diff') {
        if (target.file.format === 'md') {
          if (activeTab === 'library' && libraryMode === 'read') {
            if (readerSubMode === 'diff_since_read' || readerSubMode === 'diff_versions') {
              setHistoryFileId(target.file.file_id);
            } else {
              setReaderSubMode('diff_since_read');
            }
            return true;
          }
          handleOpenFileFromTimelineOrGraph(
            target.file.file_id,
            target.revisionId,
            'diff_since_read'
          );
          return true;
        }
        if (isTimeMachineFormat(target.file.format)) {
          if (activeTab !== 'panorama' || panoramaMode !== 'canvas') {
            pushCurrentNavSource({ enteredTimeMachine: true });
            trailEnteredFromStackRef.current = true;
            setActiveTab('panorama');
            setPanoramaMode('canvas');
          }
          setEventTrail((prev) =>
            enterEventFrame(prev, target.file, undefined, target.file.title, target.revisionId)
          );
          return true;
        }
        setHistoryFileId(target.file.file_id);
        return true;
      }

      if (action === 'add-focus-to-basket') {
        const rev =
          target.file.revisions.find((r) => r.revision_id === target.revisionId) ??
          target.file.revisions[0];
        handleAddEvidencePointer({
          file_id: target.file.file_id,
          revision_id: rev?.revision_id ?? target.file.current_revision_id,
          relative_path: target.file.relative_path,
          content_sha256: rev?.content_sha256 ?? '',
          locator: { kind: 'file' },
          evidence_kind: rev ? 'explicit_source' : 'metadata_only',
          index_generation: stateOverview?.index_generation ?? 0,
          observed_at: rev?.observed_at ?? target.file.revisions[0]?.observed_at ?? '',
          coverage: target.file.coverage,
          stale: false,
          excerpt: rev?.summaryNote ?? target.file.title,
          granularity: 'full',
          sizeBytes: rev?.sizeBytes ?? 0,
        });
        showSystemToast('ok', `已加入上下文篮：${target.file.title}`);
        return true;
      }

      return false;
    },
  });

  const handlePaletteOpenFile = (item: PaletteItem) => {
    if (!item.fileId) return;
    if (item.projectId && item.projectId !== multiProjects.activeProjectId) {
      void multiProjects.handleActivateProject(item.projectId, {
        projectId: item.projectId,
        fileId: item.fileId,
        openTab: 'library',
        libraryMode: 'read',
      });
      return;
    }
    if (item.sourceWorkspace) {
      recordMountedReading(item.sourceWorkspace.rootKey, {
        file_id: item.fileId,
        revision_id: item.revisionId ?? '',
        relative_path: item.relativePath ?? '',
        title: item.title,
      });
      openQuickPreview(item.fileId, item.revisionId);
      return;
    }
    const listed = files.find((f) => f.file_id === item.fileId);
    handleOpenFileFromTimelineOrGraph(
      item.fileId,
      item.revisionId ?? listed?.current_revision_id ?? '',
      'read'
    );
  };

  const handlePaletteLocate = (item: PaletteItem) => {
    void handleRevealInExplorer(item.relativePath ?? '');
  };

  const handlePaletteAddToBasket = (item: PaletteItem) => {
    if (!item.fileId) return;
    const listed = files.find((f) => f.file_id === item.fileId);
    if (!listed) return;
    const rev =
      listed.revisions.find((r) => r.revision_id === (item.revisionId ?? listed.current_revision_id)) ??
      listed.revisions[0];
    const pointer: EvidencePointer = {
      file_id: listed.file_id,
      revision_id: rev?.revision_id ?? listed.current_revision_id,
      relative_path: listed.relative_path,
      content_sha256: rev?.content_sha256 ?? '',
      locator: { kind: 'file' },
      evidence_kind: rev ? 'explicit_source' : 'metadata_only',
      index_generation: stateOverview?.index_generation ?? 0,
      observed_at: rev?.observed_at ?? listed.revisions[0]?.observed_at ?? '',
      coverage: listed.coverage,
      stale: false,
      excerpt: item.snippetText ?? item.subtitle ?? listed.title,
      granularity: 'full',
      sizeBytes: rev?.sizeBytes ?? 0,
    };
    handleAddEvidencePointer(pointer);
  };

  const handlePaletteAction = (item: PaletteItem) => {
    switch (item.actionId) {
      case 'jump-today':
        handleJumpToDayInTimeline(localDayOf(new Date()));
        break;
      case 'open-basket':
        openContextDrawer();
        break;
      case 'locate-root':
        void handleRevealInExplorer('.');
        break;
      case 'switch-workspace':
        if (item.payload) void handleSwitchWorkspace(item.payload);
        break;
      case 'mount-workspace':
        setMountPanelOpen(true);
        break;
      default:
        break;
    }
  };

  const systemActions = useMemo<import('../components/FileContextMenu').DesktopFileActionCallbacks>(
    () => ({
      onRevealInExplorer: (rel) => void handleRevealInExplorer(rel),
      onOpenWithDefaultApp: (rel) => void handleOpenWithDefaultApp(rel),
      onCopyRelativePath: (rel) => void handleCopyRelativePath(rel),
      onCopyAbsolutePath: (rel) => void handleCopyAbsolutePath(rel),
      onImportIntoFolder: (folderRel) => void handleImportIntoFolder(folderRel),
      onOpenFileContextMenu: handleOpenFileContextMenu,
      onRenameFile: handleRenameFile,
      onMoveFile: handleMoveFile,
      onTrashFile: handleTrashFile,
      desktopSystemSupported: desktopSystemAvailable,
      hasWorkspaceRoot: Boolean(config.rootPath),
    }),
    [
      config.rootPath,
      desktopSystemAvailable,
      handleCopyAbsolutePath,
      handleCopyRelativePath,
      handleImportIntoFolder,
      handleMoveFile,
      handleOpenFileContextMenu,
      handleOpenWithDefaultApp,
      handleRenameFile,
      handleRevealInExplorer,
      handleTrashFile,
    ]
  );

  const calendarWindowFetchedRef = useRef('');
  useEffect(() => {
    if (panoramaMode !== 'calendar' || !hasActiveBackend) return;
    const key = `${workspaceEpoch}:${eventFetchGenRef.current}`;
    if (calendarWindowFetchedRef.current === key) return;
    calendarWindowFetchedRef.current = key;
    const gen = eventFetchGenRef.current;
    void (async () => {
      const result = await fetchEventPage(calendarWindowEventQuery(new Date()));
      if (eventFetchGenRef.current !== gen) return;
      if (result.page) mergeEventsPage(result.page.items);
    })();
  }, [hasActiveBackend, mergeEventsPage, panoramaMode, workspaceEpoch]);

  const handleGranularityChange = (granularity: EventDayGranularity) => {
    const dq = dayQueryRef.current;
    if (granularity === dq.granularity && !dq.drill) return;
    dayQueryRef.current = { ...dq, granularity, drill: null };
    setDayGranularity(granularity);
    setDrillRange(null);
    setActiveDate(undefined);
    const issued = dayQueryRef.current;
    void (async () => {
      const days = await fetchEventDays({
        limitDays: DAYS_QUERY_LIMIT,
        samplesPerDay: 6,
        granularity,
        order: issued.order,
        ...daysWindow(issued.order, eventRange, null),
      });
      if (days && sameDayQuery(dayQueryRef.current, issued)) setEventDays(days);
    })();
  };

  const handleDrillToBucket = async (bucketDate: string, bucketGranularity: EventDayGranularity) => {
    const window = bucketRange(bucketDate, bucketGranularity);
    if (!window) return;
    dayQueryRef.current = { ...dayQueryRef.current, granularity: 'day', drill: window };
    setDayGranularity('day');
    setDrillRange(window);
    setActiveDate(undefined);
    const issued = dayQueryRef.current;
    const days = await fetchEventDays({
      limitDays: DAYS_QUERY_LIMIT,
      samplesPerDay: 6,
      granularity: 'day',
      order: issued.order,
      ...window,
    });
    if (days && sameDayQuery(dayQueryRef.current, issued)) {
      setEventDays(days);
      const latest = days.groups.find((g) => g.date !== '');
      if (latest) setActiveDate(latest.date);
    }
  };

  const toggleUndatedEvents = async () => {
    const next = !undatedOnly;
    eventFetchGenRef.current += 1;
    const gen = eventFetchGenRef.current;
    setUndatedOnly(next);
    const result = await fetchEventPage({
      undated: next,
      limit: 50,
      order: eventOrder,
      from: dateFilterRef.current.from,
      to: dateFilterRef.current.to,
      kinds: currentEventKinds(),
    });
    if (result.page && eventFetchGenRef.current === gen) {
      setEventPage(result.page);
      mergeEventsPage(result.page.items);
    }
  };

  const toggleEventOrder = async () => {
    const next = eventOrder === 'occurred' ? 'observed' : 'occurred';
    eventFetchGenRef.current += 1;
    const gen = eventFetchGenRef.current;
    setEventOrder(next);
    dayQueryRef.current = { ...dayQueryRef.current, order: next };
    const dq = dayQueryRef.current;
    const [result, days] = await Promise.all([
      fetchEventPage({
        limit: 50,
        undated: undatedOnly,
        order: next,
        from: dateFilterRef.current.from,
        to: dateFilterRef.current.to,
        kinds: currentEventKinds(),
      }),
      fetchEventDays({
        limitDays: DAYS_QUERY_LIMIT,
        samplesPerDay: 6,
        granularity: dq.granularity,
        order: next,
        ...daysWindow(next, eventRange, dq.drill),
      }),
    ]);
    if (result.page && eventFetchGenRef.current === gen) {
      setEventPage(result.page);
      mergeEventsPage(result.page.items);
      setChangeNotice(null);
    }
    if (days && sameDayQuery(dayQueryRef.current, dq)) setEventDays(days);
  };

  const renderPanoramaModeSwitch = () => (
    <Tabs
      ariaLabel="全景溯源视图切换"
      items={PANORAMA_MODE_OPTIONS.map((option) => ({ key: option.value, label: option.label }))}
      active={panoramaMode}
      onChange={(key) => setPanoramaMode(key as PanoramaMode)}
    />
  );

  return {
    desktopSession, desktopBridgeAvailable, desktopSystemAvailable, hasActiveBackend,
    workspaceEpoch, switchingWorkspace, workspaceSwitchError,
    handlePickWorkspaceFolder, handleSwitchWorkspace, handleRemoveRecentWorkspace,
    config, files, events, decisions, decisionsUnresolvedTotal, relations, filesTotal, fileFacets, readingStates,
    setReadingStates, mutedFolders, handleToggleMuteFolder, handleUnmuteFolder, handleClearMutedFolders,
    dataSource, dataError, scanSummary,
    eventDays, activeDate, setActiveDate, eventPage, eventPageLoading, undatedOnly, eventOrder,
    eventKindFilter, dayGranularity, changeNotice,
    rescanState, rescanError, serviceStatus, stateOverview, setStateOverview,
    agentDraftFileIds, eventDataReady, workspaceSummary, eventRange, dateFilter,
    handleRescan,
    networkOffline, streamDisconnected, retryingConnection, handleRetryConnection,
    activeTab, setActiveTab, handleSelectPrimaryTab, panoramaMode, setPanoramaMode, portholeRef, handleCanvasThemeChange,
    libraryMode, setLibraryMode, eventTrail, setEventTrail,
    activeFileId, setActiveFileId, pinnedRevisionId, setPinnedRevisionId,
    readerSubMode, setReaderSubMode, readerAnchor, setReaderAnchor,
    readerFocusSection, setReaderFocusSection, readerScrollPercentRef,
    selectedEventId, setSelectedEventId, selectedDecisionId, setSelectedDecisionId,
    returnBreadcrumb, setReturnBreadcrumb, navSourceStack, handleNavigateLinkedFile,
    searchQuery, setSearchQuery, sidebarFilters, setSidebarFilters,
    handleClearSidebarFilters, sidebarFilterActive, sidebarFilterLabel, activeFileInFilter,
    smartViewFiles, activeSmartView, filteredFiles,
    spotlightEnabled, spotlightItems, spotlightDimmedFileIds,
    handleSpotlightToggle, handleSpotlightCursor, spotlightCursor,
    isSettingsOpen, setIsSettingsOpen, isMcpConsoleOpen, setIsMcpConsoleOpen,
    isContextDrawerOpen, setIsContextDrawerOpen, isMobileLeftOpen, setIsMobileLeftOpen,
    isMobileRightOpen, setIsMobileRightOpen, libraryInspectorOpen, setLibraryInspectorOpen,
    overviewInspectorCollapsed, setOverviewInspectorCollapsed,
    decisionRadarSignal, setDecisionRadarSignal, isHelpOpen, setIsHelpOpen,
    isMountPanelOpen, setMountPanelOpen, mountedWs,
    isReviewBoardOpen, setIsReviewBoardOpen, reviewBoard, reviewBoardLoading,
    isChronosDigestOpen, setIsChronosDigestOpen,
    reviewBoardError, reviewBoardBusyKey, reviewBoardNotice,
    refreshReviewBoard, handleOpenReviewBoard, handleBoardAckStatement,
    handleBoardRepairOrphan, handleBoardJumpToStatement, handleBoardInspectDraft,
    palette, isPaletteOpen, closePalette,
    handlePaletteOpenFile, handlePaletteLocate, handlePaletteAddToBasket, handlePaletteAction,
    unreadFilesCount, contextPointers, setContextPointers,
    searchHits, searchHitsTruncated: searchResult.truncated, recentItems, activeFile, packageList, activePackage,
    stateOverviewIndex, activeInitiative, agentContextPreset, presetPointers, recommendedMounts,
    focusedContextFileId: focusedContextTarget.fileId,
    confirmedDecisionLines, pendingBlockerLines, referenceMetaOf, contextSessionCheckpointId,
    openContextDrawer, handleMountPointers, handleUpdatePointerGranularity,
    deliveredInitiatives, deliveredInitiative, initiativeLifecycle, runInitiativeLifecycle,
    hitlClearedAt,
    proposalToast, proposalAdopting, proposalRejecting, proposalAdoptNotice,
    proposalDiffExpanded, proposalDiffLoading, proposalDiffError, proposalDiffContent,
    handleAdoptProposal, handleRejectProposal, handleViewProposalDiff,
    handleOpenProposalInReader, handleDismissProposalToast,
    decisionChangeNote, setDecisionChangeNote, decisionChangeToast, setDecisionChangeToast,
    pushDecisionChangeNote,
    handleDecisionResolved, handleBlockingCleared,
    handleAddEvidencePointer, handleAddDecisionReceiptToBasket,
    publishFiles, mergeEventsPage, ensureFileDetail, ensureRevisionContent,
    loadMoreEvents, refreshEvents, silentMergeNewEvents, silentMergingEvents, toggleUndatedEvents, toggleEventOrder,
    applyDayFilter, applyKindFilter, resetEventFilters, handleJumpToDayInTimeline,
    handleGranularityChange, handleDrillToBucket, handleSelectCanvasDate,
    handleSelectSearchHit, handleOpenFileFromTimelineOrGraph, openDocFromCalendar,
    setHistoryFileId, historyFileId,
    openDocResumeReading, handleFollowReturnBreadcrumb, handleOpenFileTimeline,
    handleMarkReadHere, handleMarkFullyRead, handleMarkUnread, handleMarkReadingBaseline, handleMarkFolderUnread, handleScrollProgress, handleToggleBookmark,
    handleSavePersonalNote, handleOpenDecisionReference,
    handleLibraryModeChange, handleTreeMoveFile,
    handleRevealInExplorer, handleOpenWithDefaultApp, handleCopyRelativePath,
    handleCopyAbsolutePath, handleImportIntoFolder, handleOpenFileContextMenu,
    handleRenameFile, handleMoveFile, handleTrashFile,
    fileOpModal, fileOpSubmitting, fileOpError, fileOpFolderOptions, closeFileOp,
    handleFileOpsSubmit, referenceImpact, fileOpHistory,
    showSystemToast, systemToast, setSystemToast, defaultImportTargetDir,
    dragDropOverlay, setFileContextMenu, fileContextMenu,
    quickPreviewTarget, quickPreviewQueue, openQuickPreview, closeQuickPreview, navigateQuickPreview,
    dirShell, multiProjects, sidebarInlineAction, triggerSidebarInlineAction,
    systemActions,
    readerPaneRef,
    renderPanoramaModeSwitch,
  };
}

/** 装配层与分节组件消费的工作区 Store 上下文（类型随控制器自动演化）。 */
export type WorkspaceStoreCtx = ReturnType<typeof useWorkspaceStore>;
