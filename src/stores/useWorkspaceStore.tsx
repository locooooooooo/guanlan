/**
 * D01-a 拆解 · 单一工作区状态 Store（任务卡 D01-a ②「单一工作区状态 Store」）。
 *
 * 从 App.tsx 组件体（原 229-3299）原样迁入：全部 state / memo / effect / handler
 * 与模块级常量。单一行为出口 useWorkspaceStore() 返回 ctx，供装配层与分节渲染层消费：
 *  - App.tsx（薄装配：TopHeader / 工作区门禁 / 分节组合）
 *  - components/app/AppBanners.tsx（横幅栈 + 冷启动进度）
 *  - components/app/AppMainViews.tsx（首页 / 全景三态）
 *  - components/app/AppLibraryStage.tsx（知识资产库三栏）
 *  - components/app/AppModalsStack.tsx（抽屉与弹窗栈）
 * 迁移纪律：hook 顺序、闭包依赖、effect deps 与拆解前逐字一致；本 hook 零 props、
 * 零 JSX 返回（JSX 全部在分节层），ctx 为键值全集（分节层按需解构）。
 */

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
  searchWorkspace,
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
  type L4aProgress,
} from '../services/workspaceClient';
// F1/F2（AC-01）：统一状态机投影 wire DTO（App 级唯一取数，四视图共享）
import type {
  OrphanRepairAction,
  ReviewBoardDraftBrief,
  ReviewBoardPendingStatement,
  StateOverviewResponse,
} from '../services/apiTypes';
import { bucketRange } from '../utils/graphEvents';
// issue #29：版本正文统一仓库——App/Reader/diff 共享请求协调（in-flight 合并）、
// 失败可重试与字节预算；晚到 FileDetail 经 mergeDetailRevisionsPreservingContent 不再覆盖已加载正文
import {
  clearRevisionContentStore,
  getRevisionContent,
  mergeDetailRevisionsPreservingContent,
  requestRevisionContent,
} from '../utils/revisionContentStore';
import { clearFilePreviewCache } from '../utils/filePreviewCache';
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
// C04：弹窗提交前的 old→new 路径映射重建（fileNameOf 取真实路径段而非显示 title）
import { fileNameOf } from '../utils/fileOps';
// wf_4：任务包语义层（分组 / 单文件归属反查）——阅读页与看板共用同一份纯函数口径
import { extractCoreSummary, groupFilesIntoPackages, taskPackageOf } from '../utils/taskPackages';
import type { TaskPackage } from '../utils/taskPackages';
// TA-03：新事件提示时刻 / 文档日期统一按本地时区取值
import { formatLocalClock, localDay } from '../utils/timeFormat';
import {
  applyBatchMarkUnread,
  applyBatchReadingBaseline,
  loadReadingStates,
  markFileUnreadState,
  mergeServerReadingStates,
  nowLocalIso,
  pruneReadingStates,
  restoreReadingStatesSnapshot,
  saveReadingStates,
} from '../utils/readingStateStore';
import {
  loadMutedFolders,
  normalizeMutedFolderPath,
  saveMutedFolders,
  toggleMutedFolderList,
} from '../utils/sidebarTree';
// 证道阁（PRD 4.1–4.3 / F4）：三入口默认包组装 + 模式 A/B 决策段行类型
import {
  buildZhendaogePreset,
  type ContextCandidate,
  type PresetPackageInfo,
  type PresetRelationRef,
  type PresetUnresolvedDecision,
  type ZhendaogePreset,
} from '../utils/zhendaogePresets';
import { isSensitiveSecretPath } from '../utils/contextSanitizer';
import type { ContextGranularity } from '../services/apiTypes';
import type {
  GuanlanContextBlockerLine,
  GuanlanContextDecisionLine,
} from '../utils/zhendaogeExport';
// 回写通知条（PRD 4.3 / F6）：SSE kinds 含 proposal → 右下角非侵入提示
import type { ProposalToastData } from '../components/ProposalToast';
// AC-03（PRD 3.3 第 3 步）：拍板完成 → 向证道阁推送《最新已拍板决策变更单》
import {
  buildDecisionChangeNote,
  decisionChangeNoteFromAssertion,
  type DecisionChangeNote,
} from '../utils/decisionChangeNote';
// 未决口径共用出口（DecisionRadar/HomeView/证道阁 pending 段同源）
import {
  DECIDED_DECISION_STATUSES,
  DOC_STATE_LABEL,
  artifactStateOf,
  indexStateOverview,
  initiativeStateOfPackage,
  isUnresolvedDecision,
} from '../utils/stateProjection';
// F24（PRD §2.2）：Delivered 一键归档提示 / Archived 重开入口的纯判定
import {
  deliveredInitiativesOf,
  initiativeArchiveWarn,
} from '../utils/initiativeLifecycle';
import { basenameOf } from '../utils/documentIdentity';
import { isTimeMachineFormat } from '../utils/formatMeta';
// v0.7：画布主题（舷窗局部，非全局）——评审第 2 轮起换出 React state：活值住
// canvasThemeStore，App 只做舷窗 DOM 命令式直写（见 handleCanvasThemeChange）
import {
  applyCanvasTheme,
  getCanvasTheme,
  readCanvasTheme,
  type CanvasTheme,
} from '../utils/canvasThemeStore';
import { LibraryMode, PrimaryTab } from '../components/TopHeader';
// 批次一：wire→视图事件转换与 TimelineView 列表态共用同一份（bootstrap/分页事件并入累计事件表）
import { pageItemToEvent } from '../components/TimelineView';
import type { PanoramaMode } from '../components/GraphCanvasView';
import { enterEventFrame, type EventFrame } from '../components/KnowledgeGraph';
import { SidebarFilters } from '../components/LeftSidebar';
import {
  ReaderSubMode,
  ReturnBreadcrumb,
} from '../components/ReaderView';
// 决策回执 T3 总装接线：篮子装配只消费 payload 形状，组装器（buildDecisionReceiptInstruction）
// 仍归 ReaderView 剪贴板链路，App 侧不重复造
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
// D05：文件操作专属 Undo/Redo 账本 + 全局快捷键分发层 + 导航来源栈
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
// C04：引用路径修复（确认制清单 + 桌面壳 CAS 写回）——受影响引用清单零 IO 收集
import { useReferencePathRepair } from '../hooks/useReferencePathRepair';
// C04：五类智能视图（徽标/列表/画布过滤单一数据源派生 → 100% 守恒）
import {
  computeSmartViewFiles,
  isSmartViewScope,
  smartViewIdSet,
  SMART_VIEWS,
  type SmartViewId,
} from '../utils/smartViews';
// D02：增量聚光灯（读后真实变化三类派生 + 降亮度集合，纯函数单一出口）
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
// v0.6 品牌界面升级（B2）：全景切换＝Tabs 标线语法（§4.3 #3/§5 App 行）
import { Tabs } from '../components/ui/primitives';
import { toastManager } from '../components/ui/toast';

// 数据未接通前的中性空配置：不再使用演示样本兜底，接口失败时各视图展示空状态与错误横幅
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

// T03 全工程时间覆盖：按桶聚合取数拉满服务端上限 120（不再 30 天静默截断）；
// 取数窗口由 /events/time-range 的真实区间驱动，超出上限的更早历史由画布「更早 N 天/周/月」刻度明示
export const DAYS_QUERY_LIMIT = 120;

// v0.7 评审第 2 轮：舷窗 data-canvas-theme 的首帧初值（模块导入即完成本机水合，无首帧闪烁）。
// 它是 React 常量——翻转由 handleCanvasThemeChange 命令式改 DOM 属性，React 重渲 diff
// 值相同不会覆写命令式写入；若放 useState，一次翻转=整棵 App 树重渲（延迟根源，见 handler 注释）
export const INITIAL_CANVAS_THEME = readCanvasTheme();

/** 契约⑤：全景溯源 星图/列表/日历 三态选项（文案恒定；canvas 态的按钮由 GraphCanvasView 渲染） */
const PANORAMA_MODE_OPTIONS: { value: PanoramaMode; label: string }[] = [
  { value: 'canvas', label: '星图' },
  { value: 'list', label: '列表' },
  { value: 'calendar', label: '日历' },
];

/**
 * CORE-BREADCRUMB：来源 → 返回目标 的单一映射表。
 * 所有 timeline 家族入口（星图/画布开文档、搜索结果命中、事件链续读）共用同一来源码
 * ——返回「全景溯源星图」（activeTab=panorama + panoramaMode=canvas）。
 * 搜索结果命中从 canvas 语境下钻、无独立来源视图，显式归入本家族（与现状一致），
 * 杜绝重构后仍裸写漏斗的未定义分支。返回处理 handleFollowReturnBreadcrumb 一律查此表，
 * 不再散落硬编码。禁止在调用点裸写 setReturnBreadcrumb({fromType:'timeline',...}) 之外的自定义目标。
 */
const TIMELINE_RETURN_TARGET: { activeTab: PrimaryTab; panoramaMode: PanoramaMode } = {
  activeTab: 'panorama',
  panoramaMode: 'canvas',
};

/** CORE-BREADCRUMB：timeline 家族统一回填返回面包屑（唯一写入口，消灭裸写漏斗） */
export const timelineReturnBreadcrumb = (label: string): ReturnBreadcrumb => ({
  fromType: 'timeline',
  label,
});

/** 画布聚合取数窗口：下钻窗口优先；否则取当前口径下的真实时间区间（time-range 驱动） */
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

/**
 * 画布查询窗口指纹比较（粒度/口径/下钻）：eventDays 无游标与代际体系，落地守卫只能
 * 用「发起时刻 dayQueryRef 快照 vs 落地时刻现值」比对——期间切粒度/下钻/口径的旧
 * days 响应不得覆盖新窗口（refreshEvents / toggleEventOrder / handleGranularityChange /
 * handleDrillToBucket 四处共用）。
 */
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

/** A04：根据 Tauri 拖拽事件 CSS 逻辑坐标命中带 `[data-drop-folder]` 的目录树/文件夹卡 */
function detectDropFolderAt(x: number, y: number): string | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return null;
  }
  const hit = document.elementFromPoint(x, y);
  const folderEl = hit?.closest?.('[data-drop-folder]') as HTMLElement | null;
  if (!folderEl) return null;
  return folderEl.getAttribute('data-drop-folder') ?? null;
}

/**
 * D02 增量聚光灯：契约 D 待审草案行 → file_id → 最新 created_at 索引。
 * 同文件多枚草案取 created_at 最大的那一枚（聚光灯按时间逐条批阅要真时间）；
 * created_at 非法/缺失的草案行不进索引（诚实缺时间，排序侧排后不伪造）。
 */
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

/** D02：聚光灯关闭态的降亮度集合（共享空集常量，避免每渲染新 Set 触发下游 memo） */
const SPOTLIGHT_EMPTY_DIMMED: ReadonlySet<string> = new Set<string>();

/* eslint-disable react-hooks/exhaustive-deps -- 巨石整体迁入，deps 与拆解前逐字一致 */

export function useWorkspaceStore() {
  const [desktopSession, setDesktopSession] = useState<DesktopSessionState | null>(() =>
    getInitialDesktopSession()
  );
  const desktopBridgeAvailable = isDesktopWorkspaceBridgeAvailable();
  const desktopSystemAvailable = isDesktopSystemBridgeAvailable();
  const hasActiveBackend = !desktopSession || desktopSession.status === 'ready';
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);
  const readingWorkspaceIdRef = useRef<string | null>(null);
  // A04：右键系统操作菜单、拖放导入引导浮层与非侵入反馈条
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
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [decisions, setDecisions] = useState<DecisionAssertion[]>([]);
  // V03 SSOT：服务端全库活跃文件未决待拍板真实总数（不受 limit=100 分页截断）
  const [decisionsUnresolvedTotal, setDecisionsUnresolvedTotal] = useState<number | null>(null);
  const [relations, setRelations] = useState<RelationEdge[]>([]);
  // 批次一调整①（方案 §5）：文件不再整表下发——按 file_id 缓存摘要 + 游标分页续拉，
  // 渲染数组从缓存投影（relative_path ASC，与服务端分页序一致）
  const fileCacheRef = useRef(new Map<string, FileRecord>());
  // 已并入版本链详情（/files/{id}/detail）的 file_id：后续摘要翻页不再覆盖其 revisions
  const detailLoadedIdsRef = useRef(new Set<string>());
  // issue #29：按需正文拉取的「失败不重试」永久标记已移除——请求协调与重试策略
  // 统一由 revisionContentStore 承担（in-flight 合并 + failed 可重试 + 字节预算）
  // 服务侧「全部文件」计数与侧栏筛选 facets（契约 §1.3；不再用 files.length 冒充全量）
  const [filesTotal, setFilesTotal] = useState(0);
  const [fileFacets, setFileFacets] = useState<FileFacets | null>(null);
  // pm_1 + A02：阅读状态按 workspace_id 独立分桶持久化；首次水合由 bootstrap 拿到 workspace_id 后落位
  const [readingStates, setReadingStates] = useState<Record<string, ReadingState>>(() =>
    desktopSession ? {} : loadReadingStates()
  );
  const readingStatesRef = useRef(readingStates);
  readingStatesRef.current = readingStates;
  // 防止快速切换文档时 openDocResumeReading 异步 ensureFileDetail 返回顺序竞态覆盖后点的文档
  const resumeReqSeqRef = useRef(0);
  // 防止目录级「全部标已读 / 全部标未读」快速连点并发竞态
  const readingBatchBusyRef = useRef(false);
  // V06：工作区私有「目录静默清单（Muted Folders）」（存观澜私有状态，磁盘零写入用户业务目录）
  const [mutedFolders, setMutedFolders] = useState<string[]>(() =>
    desktopSession ? [] : loadMutedFolders()
  );

  // v0.3 真实数据接入状态；v0.4 增加 loading（bootstrap 前不把空态装成真数据）
  const [dataSource, setDataSource] = useState<'loading' | WorkspaceSource>('loading');
  const [dataError, setDataError] = useState<string | null>(null);
  const [scanSummary, setScanSummary] = useState<string>('');

  // v0.4 第二轮：工程画布的按日事件（与 Timeline 共用同一持久查询）
  const [eventDays, setEventDays] = useState<EventDaysResult | null>(null);
  const [activeDate, setActiveDate] = useState<string | undefined>(undefined);
  // Timeline 与 Graph 共用同一持久查询：事件页 + 游标（方案 §2、§5）
  const [eventPage, setEventPage] = useState<EventPage | null>(null);
  const [eventPageLoading, setEventPageLoading] = useState(false);
  const [undatedOnly, setUndatedOnly] = useState(false);
  const [eventOrder, setEventOrder] = useState<'occurred' | 'observed'>('occurred');
  // pm_3：列表态事件类型筛选——下推服务端 kinds（与 total_in_window/游标指纹同口径）
  const [eventKindFilter, setEventKindFilter] = useState<TimelineEventKind | 'all'>('all');
  // 每次 fetchEventPage 都必须带同一份 kinds：游标指纹含 kinds，漏传会被判 CURSOR_STALE
  // （v1 从 INDEX_STALE 拆出，契约 §0.2）；ref 供异步闭包（后台续拉后的刷新）读到最新筛选值
  const eventKindFilterRef = useRef<TimelineEventKind | 'all'>('all');
  const currentEventKinds = () =>
    eventKindFilterRef.current === 'all' ? undefined : [eventKindFilterRef.current];

  // T03：画布标尺粒度（day 逐日 / week 周聚合 / month 月聚合）与点聚合刻度下钻的日窗口；
  // ref 供异步闭包（首屏轻数据、bootstrap 后的续载刷新）读取最新取数参数
  const [dayGranularity, setDayGranularity] = useState<EventDayGranularity>('day');
  const [drillRange, setDrillRange] = useState<{ from: string; to: string } | null>(null);
  const dayQueryRef = useRef<{
    granularity: EventDayGranularity;
    order: 'occurred' | 'observed';
    drill: { from: string; to: string } | null;
  }>({ granularity: 'day', order: 'occurred', drill: null });
  // 监听提示：新事件先提示，用户确认后才进入新的查询窗口
  const [changeNotice, setChangeNotice] = useState<{ count: number; at: string } | null>(null);

  // ── 批次二：索引任务与数据时效 ──────────────────────────────────────────
  // 服务端启动时会跑一轮后台对账；用户也可手动点「重新扫描」。两者共用同一条
  // 通路：提交任务 → 轮询状态 → 完成后重新取数（bootstrapNonce + 1）。
  const [rescanState, setRescanState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [rescanError, setRescanError] = useState<string>('');
  const [activeJobId, setActiveJobId] = useState<string>('');
  // 同步防重锁：在慢网 / 4x CPU 限速下阻止连点并发提交多个异步请求
  const rescanInFlightRef = useRef(false);
  const lifecycleInFlightRef = useRef(false);
  const silentMergeInFlightRef = useRef(false);
  const retryInFlightRef = useRef(false);
  // 断网与 SSE 断连可恢复状态
  const [networkOffline, setNetworkOffline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false
  );
  const [streamDisconnected, setStreamDisconnected] = useState<boolean>(false);
  const streamEverConnectedRef = useRef(false);
  const streamDisconnectedRef = useRef(false);
  const [retryingConnection, setRetryingConnection] = useState<boolean>(false);
  // 轮询节拍：任务未结束时 +1 触发下一次轮询（effect 依赖它）
  const [pollTick, setPollTick] = useState(0);
  // bootstrap 世代号：+1 触发一次完整重新取数（对账完成后用）
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  // 服务运行状态（含进行中的索引任务与索引代）
  const [serviceStatus, setServiceStatus] = useState<WorkspaceStatusResponse | null>(null);
  // F1（AC-01）：/state-overview 六态投影——App 级唯一取数，专项卡片 / 专项详情 /
  // 星图节点 / 文档顶栏四处共享同一份响应（null = 未接线/断连，视图回退既有阶段词）
  const [stateOverview, setStateOverview] = useState<StateOverviewResponse | null>(null);
  // C04 智能视图「Agent 待审草案」数据源：契约 D 待审草案（mcp/agent）的 file_id 集合。
  // 初始与 SSE proposal 事件时各拉一次（limit 100 单页即可；空集＝诚实无草案视图计数 0）
  const [agentDraftFileIds, setAgentDraftFileIds] = useState<Set<string>>(new Set());
  // D02 增量聚光灯数据源：草案 file_id → 最新 created_at（同文件多草案取最新一枚的
  // created_at——聚光灯「按时间逐条批阅」排序要真时间，绝不伪造）
  const [agentDraftAtByFileId, setAgentDraftAtByFileId] = useState<Map<string, string>>(
    new Map()
  );
  // D02 增量聚光灯 UI 态：一键开（重返工作区后用户手动开，绝不自动暗化打扰）+
  // J/K 游标（循环步进，消费侧按 items.length 取模防列表缩胀越界）
  const [spotlightEnabled, setSpotlightEnabled] = useState(false);
  const [spotlightCursor, setSpotlightCursor] = useState(0);
  // L4A 沉淀进度（PRD §2.2：术语全站规范为 L4A，废弃 LNN 混用）。null = 服务未下发
  // l4a_progress（批次一后端）或当前无进行中的沉淀——横幅不渲染，不造进度
  const [l4aProgress, setL4aProgress] = useState<L4aProgress | null>(null);

  // 批次一调整①：一次 GET /api/v1/bootstrap 即得 event_days/events 首页/time_range/counts/baseline，
  // 文件元数据由 files 分页续拉补齐，不再有 /scan 全量后台对账
  const [eventDataReady, setEventDataReady] = useState(false);
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary | null>(null);
  const [eventRange, setEventRange] = useState<EventTimeRange | null>(null);
  // T05：Timeline 服务端日期窗口（from=to=该日；空对象 = 全域），ref 供异步闭包读取最新值
  const [dateFilter, setDateFilter] = useState<{ from?: string; to?: string }>({});
  const dateFilterRef = useRef<{ from?: string; to?: string }>({});
  // 事件查询代际号（契约 §3.2 游标纪律「类型筛选竞态丢弃过期响应」的推广）：
  // 首页/筛选/刷新每次发起即 +1；续页（loadMoreEvents）在响应到达时比对代际，
  // 不一致说明期间筛选已变，旧游标窗口的页作废，不得 append 进新筛选窗口
  const eventFetchGenRef = useRef(0);
  // T04：文件时间线抽屉（版本链 + 相关事件）
  const [historyFileId, setHistoryFileId] = useState<string>('');

  // 默认首页落在「今日观澜」仪表盘（玻璃改版后新增）；全景溯源星图/知识资产库经顶栏页签进入
  const [activeTab, setActiveTab] = useState<PrimaryTab>('home');
  // 契约⑤：全景溯源内部三态（星图/列表/日历），宿主在 App
  const [panoramaMode, setPanoramaMode] = useState<PanoramaMode>('canvas');
  // v0.7（设计增补 §1.1）：画布主题（夜航/纸面）——与 panoramaMode 同级宿主在 App。
  // v0.7 评审第 2 轮（延迟项重构）：主题完全换出 React 树——活值在 canvasThemeStore，
  // 类与 data-canvas-theme 由本 handler 直写舷窗 DOM（portholeRef），App 零 state、零重渲。
  // 旧实现（App useState）一次切换=整棵 App 树两次重渲（数千 SVG 节点 reconciliation 与
  // 两次全子树样式失效相乘）：评审实测点击→过渡 2.1s、类移除 4.2s；本会话同法基线
  // 点击→提交 723ms、移除 784ms。
  // 作用域仍是舷窗局部不是全局（v0.6 冻结「浅壳+暗舷窗」）。
  const portholeRef = useRef<HTMLDivElement>(null);
  const handleCanvasThemeChange = (next: CanvasTheme) => {
    if (next === getCanvasTheme()) return;
    const porthole = portholeRef.current;
    if (porthole) {
      // 评审方向 b（v0.7r2-1 授权）：morph 类「常驻、下次翻转同任务摘+挂」——
      // remove/add 落在同一同步任务、transition 声明前后不变，浏览器不会为它作废子树，
      // 于是每次翻转只剩 data-canvas-theme 翻转这一次全子树样式失效（旧 320ms 摘类
      // 会再触发一次等量失效+卡顿，评审实测移除时刻 4.2s、本会话 1.7s）。
      // 代价（评审已明示接受）：翻转间隙内 hover 等瞬时色态也带 260ms 渐变——
      // 类只改 transition 声明，不改任何稳态视觉。
      porthole.classList.remove('theme-morphing');
      porthole.classList.add('theme-morphing');
      porthole.dataset.canvasTheme = next;
    }
    applyCanvasTheme(next); // 活值 + 本机持久化 + 通知订阅叶子（分段钮 / 页签 theme）
  };
  // 契约⑥：知识资产库内部两态（阅读/概览），宿主在 App
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('read');
  const [eventTrail, setEventTrail] = useState<EventFrame[]>([]);
  // 选中态初始为空：等真实数据到达后指向第一个可读对象，避免悬空的演示 ID
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
  // pm_1：「继续阅读」点开时要求阅读器滚到上次读到的章节首行（一次性定位目标）
  const [readerFocusSection, setReaderFocusSection] = useState<{
    fileId: string;
    sectionId: string;
  } | null>(null);
  // GU-1：「继续阅读」重开时的滚动百分比基线（真实滚动采集后使用），ReaderView 据此滚回上次读行。
  // 绑定 file_id：避免把 A 文件的停留比例误用到随后打开的 B 文件上
  const readerScrollPercentRef = useRef<{ fileId: string; scrollPercent: number } | undefined>(undefined);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [selectedDecisionId, setSelectedDecisionId] = useState<string>('');
  const [returnBreadcrumb, setReturnBreadcrumb] =
    useState<ReturnBreadcrumb | null>(null);
  // D05：Esc「按来源栈精确返回」——记录进入阅读器/证据定位/跨视图时光机/日列表前的真实来源
  const [navSourceStack, setNavSourceStack] = useState<NavSourceEntry[]>([]);
  const navSourceStackRef = useRef<NavSourceEntry[]>([]);
  const trailEnteredFromStackRef = useRef(false);
  const prevTrailLenRef = useRef(0);

  // Search & 4D Sidebar Filters (for Reader / Library mode)
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sidebarFilters, setSidebarFilters] = useState<SidebarFilters>({
    quickScope: 'all',
    folder: 'all',
    format: 'all',
    role: 'all',
    topic: 'all',
  });

  // Modals & Agent Context Basket & Responsive Drawers
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isMcpConsoleOpen, setIsMcpConsoleOpen] = useState<boolean>(false);
  const [isContextDrawerOpen, setIsContextDrawerOpen] = useState<boolean>(false);
  // E04：轻量「批阅看板」抽屉状态（五态精简版 + unknown 孤儿修复）
  const [isReviewBoardOpen, setIsReviewBoardOpen] = useState<boolean>(false);
  // V10：「司辰手记」今日/近7日沉淀简报抽屉状态
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
  // v0.8 总装-2：阅读态右侧「所选对象详情」检查器默认收起——ReaderView 右上角 ⓘ「溯源与关联」
  // 点开才现；概览态维持 xl+ 常驻（合并条件见 RightInspector 容器），移动端「打开右侧详情」
  // 钮（isMobileRightOpen）行为原样保留。开合线程经 inspectorOpen/onToggleInspector
  // 下传 ReaderView（总装-3）
  const [libraryInspectorOpen, setLibraryInspectorOpen] = useState<boolean>(false);
  // V11：`]` 快捷键在资产库概览态亦可折叠右侧检查器（默认不折叠，零改变既有首屏布局）
  const [overviewInspectorCollapsed, setOverviewInspectorCollapsed] = useState<boolean>(false);
  // V11：无痛静默并入增量事件运行态
  const [silentMergingEvents, setSilentMergingEvents] = useState<boolean>(false);
  // v0.8 总装-6：左栏主导航「未决决策」的雷达受控展开信号——递增计数单向触发
  // DecisionRadar 受控展开（展开/关闭逻辑归雷达本体，TopHeader 只做转发不加工）
  const [decisionRadarSignal, setDecisionRadarSignal] = useState<number>(0);
  const [contextPointers, setContextPointers] = useState<EvidencePointer[]>([]);
  // 契约④：操作提示 ？ 浮窗（全部操作提示的唯一渲染点，三工作区共用）
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);

  // ---------- C03 · Ctrl+K 时空命令面板（Omnibox）----------
  // 只持开关与结果组装；执行回调在下方 systemActions 附近定义（依赖既有 handler）。
  // recentWorkspaces 取桌面会话最近列表（浏览器环境空列表 → 动作行自动隐藏）。
  // FileRecord 视图模型 → 面板最小源（@日期过滤取版本链最新 observed_at）
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
  // C05：只读参考工作区挂载状态（列表 / 挂载 / 卸载 / 错误透出；面板与跨库检索共用）
  const mountedWs = useMountedWorkspaces();
  // 多项目并存数量镜像（供 Ctrl+K 并发跨项目检索，无 hook 顺序耦合）
  const [multiProjectCount, setMultiProjectCount] = useState(1);
  const multiProjectsRefreshRef = useRef<(() => void) | null>(null);
  const palette = useCommandPalette({
    files: paletteFileLite,
    readingStates,
    initiatives: stateOverview?.initiatives ?? [],
    artifacts: stateOverview?.artifacts ?? [],
    recentWorkspaces:
      desktopSession?.recentWorkspaces?.map((w) => w.root).filter((r): r is string => Boolean(r)) ?? [],
    // C05：挂载参考工作区（有在线挂载时全文层并发跨库层，来源徽标「📁 工作区名」）
    mountedWorkspaces: mountedWs.mounts,
    multiProjectCount,
  });
  const { isOpen: isPaletteOpen, close: closePalette } = palette;
  // C05：挂载管理面板开合（入口：命令面板动作行「挂载参考工作区」）
  const [isMountPanelOpen, setMountPanelOpen] = useState(false);

  // pm_1 + A02：阅读状态按当前 workspace_id 独立写回；切换过渡态（ref=null）不落盘，避免写窜
  useEffect(() => {
    if (!readingWorkspaceIdRef.current) return;
    saveReadingStates(readingStates, readingWorkspaceIdRef.current);
  }, [readingStates]);

  // V06：静默目录清单按 workspace_id 独立写回观澜私有存储（绝不触碰用户工作区磁盘）
  useEffect(() => {
    if (!readingWorkspaceIdRef.current) return;
    saveMutedFolders(mutedFolders, readingWorkspaceIdRef.current);
  }, [mutedFolders]);

  // ---------- 批次一调整①：文件缓存与按需详情/正文（wire → 视图模型转换的宿主） ----------

  // 把缓存投影成渲染数组（relative_path ASC 与服务端分页序一致）——150ms 尾沿防抖合批。
  // 为什么防抖：单文件详情/正文合并与逐页摘要续拉每次都触发全量投影，2200 文档 ≈ 12 轮
  // setFiles，每轮级联重算 packageList/filteredFiles/searchHits/最近项/画布分组等全部
  // [files] memo。重复调用只重置定时器，flush 时仍取 fileCacheRef 全量排序投影——语义
  // 零变化（fileCacheRef 始终是事实源，剪枝路径直读缓存不受影响）；选时间窗防抖而非
  // 微任务，是为了把「逐页到达的 12 轮」真正合并。取舍：首屏文件投影延后 ≤150ms
  // （本地读服务下各页到达间隔远小于该窗口）。
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
  // 卸载时丢掉挂起的投影定时器（组件已卸载，flush 只是无谓的残留 setState）
  useEffect(() => {
    return () => {
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, []);

  // issue #30（Content 发布粒度）：正文补齐走目标化行替换——relative_path 序不因
  // 正文变化而变，不再全量重排序投影；除目标文件外的行保持引用身份（memo 化卡片
  // 不失效）。行未进入投影时（摘要页未到）静默跳过：正文已在缓存，元数据发布
  // （applyFileSummaries/ensureFileDetail）时会带上。派生摘要的重算由
  // taskPackages 的 DerivedSummary 缓存按版本身份消化。
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

  // 摘要页合并入缓存（missing / trashed 文件不进活动资产库，同旧 /scan active 投影口径，server/project.ts:73）
  const applyFileSummaries = useCallback(
    (items: FileSummary[]) => {
      for (const item of items) {
        if (item.status === 'missing' || item.status === 'trashed') continue;
        const existing = fileCacheRef.current.get(item.file_id);
        const next = fileSummaryToFileRecord(item);
        // 已并入版本链详情的条目仅在当前版本未前进时保留 revisions；
        // 若磁盘改动带来了新版本（current_revision_id 变化），必须失效旧详情缓存并并入新版本占位，
        // 避免阅读器停留在旧版本导致「标为已读」标错旧版而永远清不掉未读。
        if (existing && detailLoadedIdsRef.current.has(item.file_id)) {
          const hasCurrent =
            !next.current_revision_id ||
            existing.revisions.some((r) => r.revision_id === next.current_revision_id);
          if (existing.current_revision_id === next.current_revision_id && hasCurrent) {
            next.revisions = existing.revisions;
          } else {
            detailLoadedIdsRef.current.delete(item.file_id);
            const seen = new Set(existing.revisions.map((r) => r.revision_id));
            next.revisions = [
              ...existing.revisions,
              ...next.revisions.filter((r) => !seen.has(r.revision_id)),
            ];
          }
        }
        fileCacheRef.current.set(item.file_id, next);
      }
      publishFiles();
    },
    [publishFiles]
  );

  // 事件页 → TimelineEvent 合并（去重、新页在前；页内 seq DESC 与旧 /scan 事件序一致）。
  // TimelineView 的列表消费 eventPage；星图/日历/首页消费这份累计事件表
  const mergeEventsPage = useCallback((items: EventPageItem[]) => {
    if (!items.length) return;
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.event_id));
      const additions = items.filter((i) => !seen.has(i.event_id)).map(pageItemToEvent);
      return additions.length ? [...additions, ...prev] : prev;
    });
  }, []);

  // 阅读器入口（调整② → issue #20 迁移）：版本链元数据改走 §1.7 分页端点
  // （fetchFileHistory 整链遍历），/detail 兼容视图退场不再调用——服务端不再
  // 逐版本内联 SVG，单次打开不随完整版本数线性增长。已并入的文件直接返回缓存。
  const ensureFileDetail = useCallback(
    async (fileId: string): Promise<FileRecord | null> => {
      const cached = fileCacheRef.current.get(fileId);
      if (cached && detailLoadedIdsRef.current.has(fileId)) return cached;
      const history = await fetchFileHistory(fileId);
      if (!history) return null;
      // snake_case 分页 wire → 版本行（seq/occurred_at/size_bytes 口径），
      // changedSectionsFromPrev 由 modified 事件 payload 归档（revisionsFromHistory 内）
      const incoming = revisionsFromHistory(fileId, history.revisions, history.events);
      // issue #29：合并保留已加载正文（store ready 条目兜底回填）；
      // pdf 走 'md' 分支无副作用（pdf 版本行没有 markdownContent/store 条目）
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
      fileCacheRef.current.set(fileId, merged);
      detailLoadedIdsRef.current.add(fileId);
      publishFiles();
      return merged;
    },
    [publishFiles]
  );

  // 阅读器正文（调整②）：md 正文 / svg 源文本按 revision_id 拉取后并入缓存版本行，
  // 使 ReaderView / 检视器 / 本地搜索都能读到「已取回」的内容。
  // issue #29：请求协调统一走 revisionContentStore——同版本并发读取合并为一次
  // 底层请求；失败不再永久标记（contentRequestedRef 已移除），下次显式调用可重试
  // （SNAPSHOT_UNAVAILABLE 的终态提示仍由调用方 UI 如实呈现，不自动循环重试）
  const ensureRevisionContent = useCallback(
    async (fileId: string, revisionId: string) => {
      const file = fileCacheRef.current.get(fileId);
      const rev = file?.revisions.find((r) => r.revision_id === revisionId);
      if (!file || !rev || !rev.snapshotAvailable) return;
      if (file.format === 'md' && rev.markdownContent !== undefined) return;
      if (file.format === 'svg' && rev.svgSource !== undefined) return;
      if (file.format !== 'md' && file.format !== 'svg') return; // pdf 无文本正文，走 raw iframe
      const format = file.format === 'svg' ? 'svg' : 'md';
      const text = await requestRevisionContent(revisionId, fetchRevisionContent, format);
      if (text === null) return; // 失败留在 store（failed 态），不并入缓存；可重试
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
      fileCacheRef.current.set(fileId, { ...current, revisions });
      // issue #30：目标化发布（不再全量重排序，纯元数据行保持引用身份）
      publishContentFor(fileId);
    },
    [publishContentFor]
  );

  // 批次一调整①：初始化 = 一次 GET /api/v1/bootstrap（短读快照，契约 §1.1）；
  // 空工作区（首次建索引）各计数为 0、baseline:false，按「尚未覆盖」渲染而非报错；
  // 文件摘要首批随 bootstrap 到达，余页后台续拉；全量关系走过渡端点 /api/v1/relations
  useEffect(() => {
    if (!hasActiveBackend) return;
    let cancelled = false;
    (async () => {
      const dq = dayQueryRef.current;
      // F1（AC-01）：bootstrap 与 /state-overview 并行取数——六态投影是四视图唯一
      // 数据源，与主数据同轮到达；端点失败（旧库/断连）置 null，视图回退既有阶段词。
      // V04：同轮并行拉取服务端已读基线（GET /api/v1/reading-state，旧库无表零写返空）。
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
      // C04 / E02 智能视图「Agent 待审草案」：只统计 status=proposed 的待批阅草案
      void (async () => {
        const proposals = await fetchRevisionProposals({ status: 'proposed', limit: 100 });
        if (cancelled) return;
        setAgentDraftFileIds(
          proposals.ok
            ? new Set(proposals.data.items.map((item) => item.file_id))
            : new Set()
        );
        // D02 增量聚光灯：草案时间索引同步落位（聚光灯按时间逐条批阅的排序源）
        setAgentDraftAtByFileId(
          proposals.ok ? draftTimestampIndex(proposals.data.items) : new Map()
        );
      })();
      if (!boot.ok || !boot.data) {
        setDataSource('error');
        // P0-2（v0.7 提示文本治理）：内部阶段名「bootstrap」直出改用户语言——
        // 状态句 + 影响句 + 恢复路径（不虚构自动重试）
        setDataError(boot.error || '启动对账未完成：读服务无响应。可重启观澜后重试。');
        return;
      }
      const b = boot.data;
      const serverReadingItems = serverReadingRes.ok ? serverReadingRes.data.items : [];
      // A02 + V04 + V06：按 workspace_id 水合各自独立的阅读状态桶、服务端已读基线与目录静默清单
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
      // 重新取数时把事件列表清空：mergeEventsPage 只增不删，陈旧行会留存
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
      // 本轮见过的 file_id：重新取数完成后据此裁掉服务端已不再列出的文件
      // （merge/apply 都只增不删，陈旧行会一直留在侧栏与资产库里）
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
      // 选中态：决策取 bootstrap 首批；首选文件等分页到齐后再定（与旧 /scan 后选中时点一致）
      if (b.decisions.length > 0) {
        setSelectedDecisionId((prev) => prev || b.decisions[0].decision_id);
      }
      setSelectedEventId((prev) => prev || b.events.items[0]?.event_id || '');

      // 后台续拉：文件摘要余页（游标失效由客户端重走，契约 §1.3 可变列表语义）
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
      // 续拉完整性判定（与下方阅读状态剪枝同口径）
      const restComplete =
        rest.ok &&
        (typeof rest.total_matched !== 'number' || seenFileIds.size === rest.total_matched);
      // 清单完整时裁掉服务端已不再列出的文件（重新取数后的去陈旧）
      if (restComplete) {
        for (const id of Array.from(fileCacheRef.current.keys())) {
          if (!seenFileIds.has(id)) fileCacheRef.current.delete(id);
        }
        publishFiles();
      }
      // 全列表到齐后：选中第一个可读文件（避免悬空 ID），并按已知 file_id 剪枝阅读状态
      // （pm_1：不清空阅读状态——其他工作区/已删除文件的记录自然淘汰）
      const all = Array.from(fileCacheRef.current.values()).sort((x, y) =>
        x.relative_path < y.relative_path ? -1 : x.relative_path > y.relative_path ? 1 : 0
      );
      const firstReadable = all.find((f) => f.format === 'md') || all[0] || null;
      if (firstReadable) {
        setActiveFileId((prev) => prev || firstReadable.file_id);
        setPinnedRevisionId((prev) => prev || firstReadable.current_revision_id);
      }
      // 剪枝完整性守卫：后台续拉失败时 workspaceClient 返回 {ok:false, items, total_matched}
      // （只含已取回页），缓存此时是不完整清单——直接按它剪枝会把未拉到页文件的进度/收藏/
      // 本地批注永久删除，且本 effect 仅启动跑一次、readingStates 每次变更即写回本机，
      // 剪枝结果马上落盘、无补救机会。故仅当「续拉成功且清单完整」（服务端给出计数时
      // 与缓存条数对得上；未给计数视为可信）才执行剪枝；不完整轮次保留全量，等下次
      // 成功全量到齐再自然淘汰（pm_1：不清空阅读状态——已删除文件的记录自然淘汰）。
      if (restComplete) {
        setReadingStates((prev) =>
          pruneReadingStates(prev, all, b.recoverable_file_ids ?? [])
        );
      }
      // 续拉非游标类失败不置全局错误态（首批已可用），留缓存缺口由后续操作按需补

      // 全量引用关系（批次一过渡端点；批次三换局部 /api/v1/graph）
      const rel = await fetchRelations();
      if (!cancelled && rel.ok) {
        setRelations(rel.data.items);
      }

      // ── 批次二：数据时效与后台对账 ──────────────────────────────────────
      // 服务端在启动时已排了一轮后台对账。这里看运行状态：有任务在跑就接管它，
      // 任务结束后自动重新取数；若对账恰好在本轮 bootstrap 之后结束，则立刻重取。
      const status = await fetchWorkspaceStatus();
      if (cancelled || !status.ok) return;
      setServiceStatus(status.data);
      const activeJob = status.data.active_jobs[0];
      if (activeJob) {
        setActiveJobId(activeJob.job_id);
        setRescanError('');
        setRescanState('running');
      } else if (status.data.index_generation > b.workspace.index_generation) {
        // 对账在本轮取数之后完成：我们手里是旧快照 → 重新取一次
        setBootstrapNonce((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyFileSummaries, bootstrapNonce, hasActiveBackend, mergeEventsPage, publishFiles, workspaceEpoch]);

  // ── L4A 沉淀进度轮询（PRD §2.2：非阻塞横幅）──────────────────────────────
  // 沉淀期间不锁定任何交互——横幅只陈述进度，阅读/批注/扫描全部照常（去掉
  // 「锁定结构化写入」旧语义）。/status 是轻端点：沉淀进行中 4s 一拍，
  // 空闲或服务未下发（批次一后端无 l4a_progress 键）15s 一拍慢轮询保活；
  // total=0 或已完成 → 置 null 收起横幅（诚实缺省，不造 100% 假进度）。
  const l4aWasActiveRef = useRef(false);
  const pollL4aRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!hasActiveBackend) {
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
      // V03：以 queue_depth > 0 为真正进行中口径（缺失快照标 failed 后 queue_depth 归 0，
      // 绝不因 done < total 永久悬挂横幅）
      const active =
        !!progress &&
        progress.total > 0 &&
        (typeof progress.queue_depth === 'number'
          ? progress.queue_depth > 0
          : progress.done < progress.total);
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
  }, [hasActiveBackend, workspaceEpoch]);

  // ── 批次二：索引任务轮询 ────────────────────────────────────────────────
  // 启动后台对账与手动「重新扫描」共用这一条通路：任务结束即重新取数。
  useEffect(() => {
    if (!hasActiveBackend || rescanState !== 'running' || !activeJobId) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const status = await fetchIndexJobStatus(activeJobId);
      if (cancelled) return;
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
        // 仍在跑：推进节拍，触发下一次轮询
        setPollTick((t) => t + 1);
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeJobId, hasActiveBackend, pollTick, rescanState, workspaceEpoch]);

  // ── 批次二：手动重新扫描（同步 ref 锁，防止慢网/4x CPU 连点重复提交） ──
  const handleRescan = useCallback(async () => {
    if (rescanInFlightRef.current || rescanState === 'running') return;
    rescanInFlightRef.current = true;
    setRescanState('running');
    setRescanError('');
    const accepted = await startIndexJob('verify_all');
    if (!accepted.ok) {
      rescanInFlightRef.current = false;
      setRescanState('error');
      setRescanError(accepted.error || '索引任务提交失败，请检查网络连接后重试');
      return;
    }
    setActiveJobId(accepted.data.job_id);
  }, [rescanState]);

  // 浏览器离线/在线监听：中途断网即时反馈，恢复在线自动重试同步
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

  // 手动重试连接（断网恢复 / 读服务报错后点击重试，防重提交）
  const handleRetryConnection = useCallback(async () => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    setRetryingConnection(true);
    try {
      const status = await fetchWorkspaceStatus();
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

  // 扫描完成的提示短暂驻留后收起（不长期占位一条横幅）
  useEffect(() => {
    if (rescanState !== 'done') return;
    const timer = window.setTimeout(() => setRescanState('idle'), 4000);
    return () => window.clearTimeout(timer);
  }, [rescanState]);

  // 阅读器（调整②）：选中文件变化即并入版本链元数据——先展示指定版本的版本信息，
  // 正文随后由下方内容效果按需补
  useEffect(() => {
    if (!activeFileId) return;
    void ensureFileDetail(activeFileId);
  }, [activeFileId, ensureFileDetail]);

  // 阅读器正文（调整②）：钉住版本（缺省当前版）的 md/svg 正文按需拉取并并入缓存，
  // 绝不整库批量下载；快照过保留期（SNAPSHOT_UNAVAILABLE）由 ReaderView 展示错误态
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
  }, [activeFileId, files, pinnedRevisionId, ensureRevisionContent]);


  // pm_5：Esc 严格按「关浮层 → 清搜索 → 退事件链 → 清日期 → 回星图」逐级生效，一次只做一件事
  // （帮助浮窗逐字写着同一句；两边必须同步改）
  // perf：handleKeyDown 每次渲染提交后经 ref 同步最新闭包，window 监听只在挂载时 add 一次
  // （旧实现无依赖数组、每次渲染 remove+add 监听）；Escape/'?' 各级行为逐字节不变。
  const escKeyDownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Quiet.md 快捷键：Ctrl+\ / Cmd+\ 一键折叠或展开全局常驻目录侧栏
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '\\') {
        e.preventDefault();
        dirShell.toggleSidebarCollapsed();
        return;
      }
      if (e.key === 'Escape') {
        // C03：命令面板是最高浮层（z-[90]），Esc 首先关它（面板根节点 data-esc-layer="open"）
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
        // C05：挂载管理面板（z-[85]，浮层级仅次于命令面板）
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
        // ① 关浮层：文件时间线抽屉全屏覆盖，Esc 只关它（抽屉自己监听 onClose，这里让位，
        //    不关其它浮层、不切页签、不清搜索）
        if (historyFileId !== '') return;
        // 其余浮层一次只关一层
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
        // ② 清搜索
        if (searchQuery) {
          setSearchQuery('');
          return;
        }
        // ③ 按来源栈精确返回（面包屑优先；无面包屑时直接弹出来源栈回到真实来源视图）
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
        // ④ 清日期（逐级退出，一次按键只清一层）：列表侧服务端日期窗口在前——
        //    dateFilter 有筛选（from 存在）时先走 applyDayFilter(undefined)（空对象=清筛选，
        //    与 TimelineView 日期下拉选「全部日期」同一入口，会 bump gen 并重取未过滤页）
        //    并 return；下一按才清画布选中（undefined 才是「未选」，'' 是「日期待考」语义），
        //    最后才落⑤回星图。帮助文案「清日期」覆盖这两层，无需改动。
        if (dateFilterRef.current.from) {
          void applyDayFilter(undefined);
          return;
        }
        if (activeDate !== undefined) {
          setActiveDate(undefined);
          return;
        }
        // ⑤ 回星图：已在全景溯源时不跳走（不强行改 panoramaMode）
        if (activeTab !== 'panorama') {
          setActiveTab('panorama');
        }
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 输入框/文本域/下拉框/可编辑区里打问号是正常输入，不触发浮窗
        if (isEditableLikeTarget(e.target)) {
          return;
        }
        // 其它阻塞浮层/对话框打开时不从背后弹出帮助浮层（已打开的帮助浮层仍可按 ? 关闭）
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

  // ---------- C04：五类智能视图成员（单一数据源派生；LeftSidebar 徽标与下面
  // filteredFiles 过滤消费同一输出 → 计数=徽标=画布过滤节点数 100% 守恒） ----------
  // stateOverviewIndex 定义在后（1189 行），此处内联同款投影索引避免 TDZ；
  // 两者同源（同一 /state-overview 响应），守恒不受影响
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

  // ---------- D02：增量聚光灯派生（「我离开后发生了什么」） ----------
  // 三类读后真实变化（新增版本/新挂起决定/Agent 新草案）按时间逐条排序，
  // 纯函数单一出口（readingSpotlight.ts）：「首次收录（未读新件）」绝不混入——
  // 有阅读基线才判读后变更（D02 停机条件：两态混同即停）。
  const spotlightItems = useMemo(
    () =>
      computeSpotlightChanges({
        files,
        readingStates,
        artifactsByFileId: smartViewArtifactsByFileId,
        agentDraftAtByFileId,
        nowMs: Date.now(),
      }),
    [agentDraftAtByFileId, files, readingStates, smartViewArtifactsByFileId]
  );
  // 降亮度集合仅在聚光灯开启时产出（关闭态恒空集——画布零样式注入，像素基线零扰动）
  const spotlightDimmedFileIds = useMemo(
    () =>
      spotlightEnabled
        ? computeSpotlightDimmedFileIds(files, readingStates, spotlightItems)
        : SPOTLIGHT_EMPTY_DIMMED,
    [files, readingStates, spotlightEnabled, spotlightItems]
  );
  const handleSpotlightToggle = useCallback(() => {
    setSpotlightEnabled((v) => {
      if (!v) setSpotlightCursor(0); // 开启时游标归零，从最新一处开始批阅
      return !v;
    });
  }, []);
  const handleSpotlightCursor = useCallback((cursor: number) => {
    setSpotlightCursor(cursor);
  }, []);

  // Filtered files according to 4D sidebar filters
  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      const st = readingStates[f.file_id];
      // C04：智能视图作用域（读后有更新/等我拍板/近7天/Agent 草案/游离）——
      // 成员判定走同一纯函数集合，与左栏徽标同源守恒
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
        // 层级文件夹树：选中目录时包含其全部子目录的文件
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
  }, [activeSmartMemberIds, files, readingStates, sidebarFilters]);

  const activeFile = useMemo(() => {
    return files.find((f) => f.file_id === activeFileId) || files[0];
  }, [files, activeFileId]);

  // wf_4：所属专项上下文——files 只在 files 变化时分组一次（不去每帧重算 1061 份路径判定），
  // 再按 activeFile 反查所属包：先命中 groupFilesIntoPackages 的包 id（与分组同源），
  // 兜底按 docs 含 file_id；未命中传 null（ReaderView.tsx:330-337 未命中即不渲染，不回退造包）。
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

  // AC-05：证道阁模式 A/B 的专项上下文——按当前路由聚焦（文档正文页=activePackage；
  // 专项概览筛选=对应目录的任务包；首页总览/全景未选中=null，不把工作区或后台首文档伪装为专项焦点）。
  // 优先取 /state-overview 的真实 initiative（id/name/current_stage）；无服务端行时回退任务包投影。
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
    // 根级散文件或总览无焦点时如实 null，不把「工作区根」伪装成 initiative。
    if (!pkg || pkg.id === '__root__') return null;
    const row = initiativeStateOfPackage(stateOverviewIndex, pkg);
    return {
      id: row?.initiative_id ?? pkg.id,
      name: row?.name ?? pkg.name,
      stage: row?.current_stage ?? pkg.stage,
      state: row?.state ?? null,
    };
  }, [focusedContextTarget.pkg, stateOverviewIndex]);

  // AC-05：引用行版本/状态标签——版本取 files 版本链 versionNumber，状态取
  // /state-overview artifact 六态；任一缺失返回 null（抽屉侧如实省略，不造标签）。
  const referenceMetaOf = useCallback((p: EvidencePointer) => {
    const file = fileCacheRef.current.get(p.file_id);
    const revisions = file?.revisions ?? [];
    // 只按指针携带的 revision_id 精确取版本；缺失/已淘汰时如实 null，不拿当前版冒充
    const rev = revisions.find((r) => r.revision_id === p.revision_id);
    const versionLabel =
      typeof rev?.versionNumber === 'number' ? `v${rev.versionNumber}` : null;
    // 文档六态是「当前文档状态」，仅当前版指针才配对展示；历史版只给 vN，
    // 不把当前状态贴到历史版本上。
    const isCurrentRevision = file?.current_revision_id === p.revision_id;
    const artifact = artifactStateOf(stateOverviewIndex, p.file_id);
    return {
      versionLabel,
      stateLabel: isCurrentRevision && artifact ? DOC_STATE_LABEL[artifact.state] : null,
    };
  }, [stateOverviewIndex]);

  // AC-05：模式 B session_checkpoint_id——抽屉打开时取当前专项最新 SUCCESS checkpoint；
  // 无专项/无记录/查询失败如实 null（不伪造 checkpoint id）。
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

  // ── 证道阁（PRD 4.1–4.3 / 方案 F4）：路由上下文自动感知组装器 ─────────────
  // 任务包投影（zhendaogePresets 输入形状）：README/核心定位文档取 basename 命中
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
  // 未决决策引用：首条证据挂文件（无证据决策不进上下文，不造文件）；
  // isBlocking：有明确阻塞影响面或为 P0/P1 阻塞级待确认项
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
  // 星图血缘边投影：只保留 file→file 边（decision_id 端点不入上下文推荐）
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
  const zhendaogePreset = useMemo<ZhendaogePreset>(
    () =>
      buildZhendaogePreset({
        activeFileId: focusedContextTarget.fileId,
        activePackage: focusedPackageInfo,
        packages: packageInfos,
        unresolvedDecisions: unresolvedDecisionRefs,
        relations: relationRefs,
      }),
    [focusedContextTarget.fileId, focusedPackageInfo, packageInfos, unresolvedDecisionRefs, relationRefs]
  );

  // 候选 → 证据篮条目（fileCache 反查当前版；无版本的候选如实跳过，绝不伪造 revision）
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
    () => candidateToPointers(zhendaogePreset.items),
    [candidateToPointers, zhendaogePreset]
  );
  const recommendedMounts = useMemo<Array<{ pointer: EvidencePointer; reason: string }>>(
    () =>
      zhendaogePreset.recommended
        .map((r) => ({ pointer: candidateToPointers([r])[0], reason: r.reason }))
        .filter((x) => x.pointer !== undefined),
    [candidateToPointers, zhendaogePreset]
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

  // AC-04：三入口默认包「默认自动勾选」——打开抽屉前先挂载预设条目，与
  // setIsContextDrawerOpen 同批提交，抽屉首帧即 N 项已选（不再先显示 0 项、
  // 也不再要求用户再点一次「带入默认上下文」）。
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

  // 未决决策段（PRD 4.3）：问题原文 + 首条证据路径
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

  // ── 回写通知条（PRD 4.3 双向回写闭环 / F6 / E02 CAS 安全网与独立草案分支）────
  const [proposalToast, setProposalToast] = useState<ProposalToastData | null>(null);
  const [proposalAdopting, setProposalAdopting] = useState(false);
  const [proposalRejecting, setProposalRejecting] = useState(false);
  const [proposalAdoptNotice, setProposalAdoptNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [proposalDiffExpanded, setProposalDiffExpanded] = useState(false);
  const [proposalDiffLoading, setProposalDiffLoading] = useState(false);
  const [proposalDiffError, setProposalDiffError] = useState<string | null>(null);
  const [proposalDiffContent, setProposalDiffContent] =
    useState<RevisionProposalContentResponse | null>(null);

  // ── AC-03（PRD 3.3 第 3 步）：最新已拍板决策变更单 ─────────────────────
  // Inline 拍板完成 / SSE decision_writeback 到达 → 生成变更单并推送到证道阁：
  // decisionChangeNote 常驻抽屉（打开即见），decisionChangeToast 做非侵入告知。
  // 同一决策 10s 内的本地+SSE 双通道只推一次（保留信息更全的 inline 版本）。
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
  // 抽屉打开即视为用户已查看变更单，收起右下角推送通知（卡片仍在抽屉内置顶）
  useEffect(() => {
    if (isContextDrawerOpen) setDecisionChangeToast(null);
  }, [isContextDrawerOpen]);

  // 模式 A 已确认决策段（PRD 4.3）：取 confirmationBasis 记录文本（未决段见上）。
  // AC-03：最新变更单与当前决策同 id 时，优先用变更单的决定文本/确认人/生效日期
  // 回填（本地 Inline 拍板后 confirmationBasis 尚未经下一轮 bootstrap 回填）。
  const confirmedDecisionLines = useMemo<GuanlanContextDecisionLine[]>(
    () =>
      decisions
        .filter((d) => d.status === '已确认' && !d.isCandidateOnly)
        .slice(0, 6)
        .map((d) => {
          const note = decisionChangeNote?.decisionId === d.decision_id ? decisionChangeNote : null;
          return {
            // DecisionAssertion 无 P0/P1 字段——优先级位以决策编号承载（登记偏差）
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

  // SSE 订阅恢复（契约 J 批次二）：
  //  - kinds 含 'proposal' → 拉最新草案弹通知条；
  //  - kinds 含 'decision_writeback' → 拉最新决策（不限状态），生成变更单推送证道阁；
  //  - kinds 含 'state' → 刷新 /state-overview（Delivered 一键归档提示随之出现/消失）。
  // 服务未实现 SSE/端点未落地时静默（无数据可名 → 不造提示）；'hello' 与其余
  // kinds 不改既有 changeNotice 横幅口径（横幅复活属 F6 其余票）。
  useEffect(() => {
    if (!hasActiveBackend) return;
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
          // C04 / E02：草案事件只刷新仍处于 proposed 态的待审草案清单
          const full = await fetchRevisionProposals({ status: 'proposed', limit: 100 });
          if (full.ok) {
            setAgentDraftFileIds(new Set(full.data.items.map((item) => item.file_id)));
            // D02 增量聚光灯：草案时间索引同步刷新（与 C04 集合同源同帧）
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
          // 不按 status 过滤：decision_writeback 也可能是否决/搁置；取最近 20 条中
          // 第一条已拍板（服务端按 observed_at 排序），跳过回写前后新插入的待确认行。
          const res = await fetchDecisions({ limit: 20 });
          if (!res.ok) return;
          if (typeof res.data.unresolved_total === 'number') {
            setDecisionsUnresolvedTotal(res.data.unresolved_total);
          }
          if (res.data.items.length === 0) return;
          const latest = res.data.items.find((d) =>
            DECIDED_DECISION_STATUSES.includes(d.status)
          );
          // CAS 冲突/未决回写（status 仍为待确认/来源不一致）不产生「已拍板」变更单：
          // 服务端对冲突也发 decision_writeback kind，但决策并未真正落地。
          if (!latest) return;
          // 本地 decisions 同步到服务端最新行，证道阁 confirmed_decisions 段随之为最新
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
      } else if (streamEverConnectedRef.current) {
        streamDisconnectedRef.current = true;
        setStreamDisconnected(true);
      }
    });
  }, [hasActiveBackend, pushDecisionChangeNote, workspaceEpoch]);

  // E04：批阅看板数据拉取 + 打开/初始刷新 + 一键「已知悉」/ 孤儿修复 / 跳转原文 / 查看草案
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
          // CAS 冲突：绝不覆盖人工编辑；同步标记冲突并自动展开实时磁盘↔草案 Diff
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

  // ---------- pm_2：筛选变化时阅读态自动切到概览，并保住阅读现场 ----------
  const sidebarFilterActive =
    sidebarFilters.quickScope !== 'all' ||
    sidebarFilters.folder !== 'all' ||
    sidebarFilters.format !== 'all' ||
    sidebarFilters.role !== 'all' ||
    sidebarFilters.topic !== 'all';

  // 顶部筛选条的条件摘要：与左栏/顶栏共用同一份 sidebarFilters（概览里不再做二次过滤）。
  // C04：智能视图作用域进摘要（同一张 SMART_VIEWS 词表，与左栏标签逐字一致）
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

  // 当前文章是否仍在筛选结果内（决定阅读态提示，不自动换文章）
  const activeFileInFilter = useMemo(
    () => filteredFiles.some((f) => f.file_id === activeFile?.file_id),
    [filteredFiles, activeFile?.file_id]
  );

  // 阅读器常驻（hidden 切换）后：切走前记录内部滚动容器位置，切回后还原
  // （display:none 不保证浏览器记住 scrollTop，只靠挂载保活会回顶）
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

  // 切回阅读态：还原滚动；文件/版本已变则不还原，避免把新文章拽到旧位置
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

  // 只在筛选真正变化、且新筛选生效时自动切概览：挂载 / 点「阅读」/ 清空筛选都不误切
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

  // 搜索防抖（perf）：每键入一字全量 searchWorkspace（2200 文件扫一遍）改为 150ms 尾沿
  // 防抖——searchQuery 本体保持即时更新（TopHeader 受控输入 value={searchQuery} 的回显、
  // Esc 清搜索、命中面板开合判断均不受影响），全库扫描走防抖镜像 debouncedSearchQuery。
  // 空串立即同步清零，避免清搜索后命中面板残留旧命中。
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  useEffect(() => {
    if (!searchQuery) {
      setDebouncedSearchQuery('');
      return;
    }
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 150);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const searchHits = useMemo(() => {
    // 批次一调整②（方案 §5）：全库批量补正文的旧链路已移除，本地检索只基于
    // 已取回的数据——文件名/路径/标题 + 已并入缓存的正文（阅读器打开过的 md/svg）。
    // 全文检索将由批次三的 /api/v1/search 有界检索端点承接（契约 §3.2）
    return searchWorkspace(files, debouncedSearchQuery);
  }, [files, debouncedSearchQuery]);

  const unreadFilesCount = useMemo(() => {
    return files.filter((f) => hasUnreadChanges(f, readingStates[f.file_id]).isUnread)
      .length;
  }, [files, readingStates]);

  // 日历页右栏「最近 7 天」列表：文档日期取最早版本 revisions[0].source_time（=文档记载日期，
  // server/project.ts 按 seq ASC）；observed_at 是采集时间，严禁当文档日期。
  // 窗口用本地日期手工拼接（勿用 toISOString，避免 UTC 偏移把本地今天算进昨天）
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

  // D05：导航来源栈辅助函数（快照当前真实视图、恢复来源视图、同步面包屑）
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

  // D05：手动点击顶栏主导航页签时清空过期的来源栈与面包屑，避免 Esc 跳回陈旧历史页
  const handleSelectPrimaryTab = (tab: PrimaryTab) => {
    if (tab !== activeTab) {
      navSourceStackRef.current = [];
      setNavSourceStack([]);
      trailEnteredFromStackRef.current = false;
      setReturnBreadcrumb(null);
    }
    setActiveTab(tab);
  };

  // D05：跨视图按 D 进入多模态时光机后，退出时光机（eventTrail 1→0）自动弹栈回到真实来源视图
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventTrail.length]);

  // Handlers
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
    // T04：mode 'history' 打开文件时间线抽屉（版本链 + 相关事件），不打断当前视图
    if (mode === 'history') {
      setHistoryFileId(fileId);
      return;
    }
    const source = pushCurrentNavSource();
    setReaderAnchor(null);
    setActiveFileId(fileId);
    setPinnedRevisionId(revisionId);
    setReaderSubMode(mode);
    // D05：按真实来源生成面包屑并入来源栈（首页/时间轴/日历/星图/资产库全部精确还原）
    setReturnBreadcrumb(breadcrumbFromNavSource(source));
    setActiveTab('library');
    setLibraryMode('read');
  };

  // 日历页（pill / 最近列表）打开文档：复用既有 Timeline/Graph 打开链路，
  // mode 'read' 会记录来源栈 + setReaderSubMode('read') + setActiveTab('library') + 写返回面包屑
  const openDocFromCalendar = (fileId: string) => {
    const t = files.find((f) => f.file_id === fileId);
    if (t) handleOpenFileFromTimelineOrGraph(t.file_id, t.current_revision_id, 'read');
  };

  // 左栏目录与右缘悬浮岛共用的续读入口（pm_1）：仅在确实有未读完的章节/滚动进度时，
  // 若上次读到的版本仍在版本链且快照未淘汰才钉回该版本；否则直接打开当前最新版本，
  // 避免纯已读基线或已读完旧版的文档在更新后打开反而被拽回旧版。
  // 批次一：版本链按需并入（ensureFileDetail）后再判 snapshotAvailable，先导航后钉版本
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
    // GU-1：真实滚动采集后，「继续阅读」重开回到上次读行（滚动百分比基线）。
    // ReaderView 优先用它反查章节并滚到该行；无比例/比例非法时退回章节定位
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
      // 同步弹出匹配栈顶，防止同一层重复回退
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
    // 兜底：无来源栈条目时回退至 CORE-BREADCRUMB 既有映射
    setActiveTab(TIMELINE_RETURN_TARGET.activeTab);
    setPanoramaMode(TIMELINE_RETURN_TARGET.panoramaMode);
    setReturnBreadcrumb(null);
  };

  // D05：阅读器内部链接跳关联文档（同时压来源栈 + 写原段落面包屑，支持多层嵌套 Esc 原路返回）
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

  // T04：文件时间线入口与「打开某时点版本」共用既有 onOpenFileFromTimeline 模式
  const handleOpenFileTimeline = (fileId: string) => {
    setHistoryFileId(fileId);
  };

  // 决策引用跳证据原文：打开阅读器中栏并定位到证据行或 Office/PDF 结构化锚点（供 handleOpenDecisionReference 复用）
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

  // T05：再次点击当前刻度/日期可取消选中（undefined = 画布自选最新一天）
  const handleSelectCanvasDate = (date?: string) => {
    setActiveDate((prev) => (prev !== undefined && prev === date ? undefined : date));
  };

  // T05：把日期筛选下推服务端（/events 支持 from/to），一次看到某天的全部事件。
  // 单日窗口用 200（服务端单页上限），避免当天事件超过 50 条时还要翻页
  const applyDayFilter = async (date?: string) => {
    const next = date ? { from: date, to: date } : {};
    eventFetchGenRef.current += 1; // 在途续页作废（竞态纪律，见 eventFetchGenRef 注释）
    // 完成侧守卫：bump 后立即快照代际，落地不一致（期间又切了类型/日期/口径）丢弃响应——
    // 避免慢请求的整页结果覆盖新筛选窗口（同 loadMoreEvents 的发起代际比对纪律）
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

  // pm_3：类型筛选下推服务端——首屏即该类型的真实首页，页脚 total_in_window 同口径；
  // 不再对已返回的一页做本地过滤（第 1 页没有 ≠ 窗口里没有）
  const applyKindFilter = async (kind: TimelineEventKind | 'all') => {
    eventFetchGenRef.current += 1; // 在途续页作废（竞态纪律，见 eventFetchGenRef 注释）
    // 完成侧守卫：bump 后立即快照代际，落地不一致（期间又切了日期/类型/口径）丢弃响应——
    // 避免 kind 在途时改日期等慢请求的整页结果覆盖新筛选窗口
    // （同 applyDayFilter/loadMoreEvents 的发起代际比对纪律）
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
    // 连续切换类型/日期时丢弃过期响应，避免慢的那次把新筛选窗口的页覆盖掉
    if (result.page && eventFetchGenRef.current === gen) {
      setEventPage(result.page);
      mergeEventsPage(result.page.items);
      setChangeNotice(null);
    }
  };

  // 空态「重置时间线筛选」：类型 + 日期合并成一次查询，避免两次请求互相覆盖
  const resetEventFilters = async () => {
    eventFetchGenRef.current += 1; // 在途续页作废（竞态纪律，见 eventFetchGenRef 注释）
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
    // 期间用户又切了类型/日期：丢弃这次「全部」响应，避免旧页覆盖新筛选
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

  // T05：画布日期组 / 「N 条待展开」/ 命令面板「跳到今天」一步切到全景溯源列表态看当天全部（from=to 服务端下推）
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
    // 仅记录当前读到的章节定位，绝不静默推进 last_read_revision_id：
    // 否则「读后有更新」文档点击大纲任一章节时，会瞬间清掉全部「★ 上次读后有改动」高亮与未读状态。
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

  /** 将单个文件标为未读（清除已读基线，完整保留收藏/批注/滚动进度，并同步服务端 SQLite）。 */
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

  /** 目录 / 工作区一键标为未读（同步清除服务端与本地已读基线，支持 8 秒 Toast 100% 撤销还原）。 */
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

    // 撤销时同时还原服务端 undo_items 与纯本地已读的文档，保证双端一致
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

  /**
   * V04 · 存量工作区/目录一键确立已读基线（后端单事务 <150ms + 8 秒 Toast 一键 100% 撤销）。
   * 仅推进 `last_read_revision_id` 到各自当前版本，绝不伪造 `scrollPercent`。
   */
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
      // 无后端连接（纯演示/单测态）回退本地基线确立，同样支持 8 秒撤销
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

  // GU-1：阅读器真实滚动 → 持久化滚动百分比（替换原先硬编码 60/100/0 常量）。
  // clamp 到 [0,100]，只写 scrollPercent/updated_at，不触碰已读基线 revision 与收藏
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
      // 首次真实滚动即建立阅读状态（不再需要先收藏/标已读才记进度）：
      // 这样纯「打开→滚动→关闭」的文件也会带着真实进度进入「继续阅读」
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

  // V06：目录级静默与恢复治理（仅影响星图/日历/列表噪点；左栏仍灰阶可见，随时可阅读或 Ctrl+K 检索）
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

  // 「待办与决策」工作区已删除：全应用的决策引用（星图/时间线/阅读器/检视器）统一
  // 跳到该决策首条证据的原文定位——溯源语义保留，签批流随工作区一并移除
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

  // E04：批阅看板卡片动作（位于 handleJumpToSourceEvidence 与 handleViewProposalDiff 之后，确保闭包无 TDZ）
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

  // ── Inline 拍板闭环（PRD 3.3 / 方案 F5）：三步原子操作的前端承接 ─────────
  // ①回写与状态变更在后端拍板 job（CAS）完成；②顶部未决计数实时 -1：把对应决策
  // 本地置「已确认」——DecisionRadar/HomeView 经 unresolvedDecisionCount 共用口径
  // 自动 -1（决策不在本地数组时无从 -1，如实不造计数）；③阻塞清零恢复提示见下。
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
      // AC-03：拍板完成即生成《最新已拍板决策变更单》并推送到证道阁。
      // 问题/编号/来源路径优先取本地决策行；决定文本/确认人/生效日期取表单值，
      // 缺字段如实 null（卡片显示「未记录」，不拿问题原文冒充决定）。
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
      // 同步刷新状态机投影，确保四视图徽标与未决计数零延迟对齐
      void fetchStateOverview().then((overview) => {
        if (overview.ok) setStateOverview(overview.data);
      });
    },
    [decisions, pushDecisionChangeNote]
  );

  // AC-03：阻塞性事项（P0/P1）清零 → 长任务恢复横幅（await_decision 槽由写线程
  // recompute_slots 唤醒；前端提示为非阻塞告知，8s 自动收起）
  const [hitlClearedAt, setHitlClearedAt] = useState<string | null>(null);
  const handleBlockingCleared = useCallback((_p: { fileId: string }) => {
    setHitlClearedAt(nowLocalIso());
  }, []);
  useEffect(() => {
    if (!hitlClearedAt) return;
    const timer = window.setTimeout(() => setHitlClearedAt(null), 8000);
    return () => window.clearTimeout(timer);
  }, [hitlClearedAt]);

  // F24（PRD §2.2）：Delivered 一键归档 / Archived 重开。
  // 提示数据来自 /state-overview（AC-01 唯一数据源）；归档/重开走 202 job + 轮询，
  // 完成后乐观更新并重新拉取 state-overview（不触发整库重扫）。
  const deliveredInitiatives = useMemo(
    () => deliveredInitiativesOf(stateOverview?.initiatives ?? []),
    [stateOverview]
  );
  // 当前阅读专项若已交付，优先提示它；否则提示最近更新的已交付专项。
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

  // ── A02：桌面壳多工作区切换与彻底隔离重置 ─────────────────────────────────
  const resetWorkspaceScopedState = useCallback(() => {
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
    setRescanState('idle');
    setRescanError('');
    setActiveJobId('');
    setPollTick(0);
    setServiceStatus(null);
    setStateOverview(null);
    setL4aProgress(null);
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
  }, []);

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

  // WebView 重载（F5）时 initialization_script 会注入启动初值；向 Rust 读取实时会话对账
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
      if (!target || switchingWorkspace) return;
      setSwitchingWorkspace(true);
      setWorkspaceSwitchError(null);
      const res = await switchDesktopWorkspace(target);
      setSwitchingWorkspace(false);
      if (!res.ok) {
        setWorkspaceSwitchError(res.error.message);
        return;
      }
      applyDesktopSessionState(res.state);
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

  // 决策回执 T3 总装接线：阅读器回执层「加入证据篮」→ 装配成 EvidencePointer 走既有
  // 篮子机制（状态/抽屉/导出全复用，不加平行数据链）。篮子形状装得下：evidence_kind
  // 'decision_record' 枚举本就预留（抽屉徽标「决策卡」，ModalsAndDrawers EVIDENCE_KIND_LABEL），
  // locator=整文件（决策勾选针对全文档），excerpt/note 自由文本承载决策内容。
  // 字段不伪造：path/sha/observed_at 一律按 file_id+revision_id 回查工作区真实值；
  // excerpt 只放已勾选项原文逐字（证据摘录语义），填空值属用户产出 → 进 note 不混摘录。
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
      // 回执层只在 md 阅读模式触发（ReaderView 决策层保守放行）→ md=全文覆盖诚实；
      // 理论不可达的非 md 形态降级 filename_only，不冒充全文
      coverage: file?.format === 'md' ? 'full_text' : 'filename_only',
      stale: false,
      excerpt: payload.selectedOptions.join('\n'),
      // 「决策回执」词根与 ReaderView 决策回执层（buildDecisionReceiptInstruction）同源
      note: `决策回执：已勾选 ${payload.selectedOptions.length} 项${
        payload.fillValues.length > 0
          ? ` · 填空 ${payload.fillValues.length} 项（${fillSummary}）`
          : ''
      }`,
    });
  };

  // v0.4 第二轮：分页续页 / 刷新 / 日期待考（Graph 与 Timeline 共用同一查询窗口）
  // 续页与刷新必须带上与首屏一致的筛选指纹（order/undated/kinds/日期窗口），
  // 否则服务端游标校验判定筛选不一致而拒绝（v1 判 CURSOR_STALE，契约 §0.2）
  const loadMoreEvents = async (): Promise<boolean> => {
    if (!eventPage?.next_cursor || eventPageLoading) return false;
    setEventPageLoading(true);
    // 发起时刻的筛选代际：响应到达时不一致即整页作废（期间用户改了类型/日期筛选，
    // 旧游标窗口的事件不得混进新筛选窗口；stale 重取分支同守）
    const gen = eventFetchGenRef.current;
    const nextQuery = {
      limit: 50,
      order: eventOrder,
      undated: undatedOnly,
      // T05：游标绑定筛选指纹，续页必须带上与首页一致的日期窗口
      from: dateFilterRef.current.from,
      to: dateFilterRef.current.to,
      // pm_3：指纹含 kinds，续页漏传会被判 CURSOR_STALE
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
      // 游标失效（INDEX_STALE/CURSOR_STALE）：保留已显示数据不闪空，按同参重取当前窗口首页
      // （新快照整窗重查，契约 §0.2/§6「UI 保留当前位置并重新取数」）
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
    eventFetchGenRef.current += 1; // 刷新开启新窗口，作废在途续页（竞态纪律，见 eventFetchGenRef 注释）
    // 完成侧守卫：bump 后立即快照代际，落地不一致（期间又改了类型/日期/口径）丢弃响应，
    // 避免慢请求的整页结果覆盖新筛选窗口（同 loadMoreEvents 的发起代际比对纪律）
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
    // days 响应按发起时刻画布窗口指纹守卫（eventDays 无代际体系，见 sameDayQuery）：
    // 期间切粒度/下钻/口径的旧 days 不得覆盖新窗口
    if (days && sameDayQuery(dayQueryRef.current, dq)) setEventDays(days);
  };

  /**
   * V11 · 无痛静默并入增量事件（保持当前位置）：
   * - 不递增 eventFetchGenRef 也不清空已翻页列表，阅读器/日历/时间轴滚动位置与游标保持不动；
   * - 仅将新增 event_id 增量合入 events 与 eventPage，并静默更新当日统计后清除提示条。
   */
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

  // ---------- A04：原生系统桥接（定位目录、默认打开、剪贴板、拖入导入） ----------
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

  // D05：文件操作 Undo/Redo 逆向落盘成功后的前端缓存同步（绝不回写 recordOp，防循环入账）
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

  // D05：文件操作专属 Undo/Redo 账本（独立于正文编辑，默认保留 100 步 rename/move）
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
        // D05：rename / move 成功即落 FileOpHistory 账本（trash 绝不入账）
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

  // Quiet.md 全局常驻目录外壳：真实空目录、置顶、挂载树、文件夹增删改移与批量整理
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
    enabled: hasActiveBackend,
    workspaceScopeKey: config.rootPath || 'default',
    workspaceEpoch,
    bootstrapNonce,
    onSyncAfterMutation: handleSyncAfterDirMutation,
    showToast: showSystemToast,
  });

  // ===== 多项目并存（Quiet.md 多目录工作台）：零重启切换焦点 + 跨项目目标落点消费 =====
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

      // 切换到另一个受管项目：零重启（保留 HTTP 服务与 SSE），仅清空旧项目内存态并重拉新激活项目
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
    enabled: hasActiveBackend,
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

  // 跨项目切换完成且新项目 files / decisions 到达后，自动落点到目标文件夹 / 文件 / 决策
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

  // 新建文档落盘并由 bootstrap/分页带回后，自动切入阅读器打开它
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

  // 合并空目录进单文件移动弹窗的可选目标列表（新建空文件夹后即可立刻把文件移进去）
  const fileOpFolderOptions = useMemo(
    () =>
      dirShell.realFolders.length > 0
        ? collectMergedFolderOptions(files, dirShell.realFolders)
        : baseFileOpFolderOptions,
    [baseFileOpFolderOptions, dirShell.realFolders, files]
  );

  // ---------- C04：确认制引用路径修复（移动/改名涉及被 Markdown 决定证据引用的目标） ----------
  // 清单收集零 IO（relations 行级边 + 决定证据，均已在内存）；写回走桌面壳
  // save_workspace_file CAS 乐观锁（冲突绝不覆盖）；浏览器/CLI 无桥＝诚实禁用。
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

  // FileOpsModal 提交包装：移动/重命名成功后按用户确认标志执行引用路径修复；
  // 修复失败诚实 warn（引用在 A05 别名下不断链，但路径口径需修复才直达命中）。
  const handleFileOpsSubmit = useCallback(
    async (payload: FileOpSubmitPayload) => {
      // 提交前固化 old→new 路径映射（弹窗此时仍持有 request；文件名取自真实路径段，
      // 不取 title——title 是显示名，可能与文件名不同）
      const source = fileOpModal;
      const oldPath = source?.relativePath ?? '';
      const ok = await submitFileOp(payload);
      if (!ok) return; // 失败：弹窗保持 + serverError 已显示，引用一个字节不动
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

  // C04 树内拖拽落地：无受影响引用 → 直连 A05 /move（复用 submitFileOp 的移动分支：
  // postMoveFile + fileCache 更新 + publishFiles + 成功事件全链路）；有受影响引用 →
  // 转 FileOpsModal 确认弹窗（引用清单预览 + 用户显式确认，绝不静默断链/改写）。
  const handleTreeMoveFile = useCallback(
    (fileId: string, targetDir: string) => {
      const target = files.find((f) => f.file_id === fileId);
      if (!target) return;
      if (target.folder === (targetDir === '' ? '.' : targetDir)) return; // 同目录无变化落点（防成环双保险）
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

  // ---------- D05 · 全局无鼠快捷键分发层（Enter 深读 / D 版本对比 / C 加入上下文篮 / Ctrl+Z·Shift+Z Undo·Redo） ----------
  const resolveFocusedFileForShortcut = (): {
    file: FileRecord;
    revisionId: string;
  } | null => {
    // 若星图正下钻在事件链/时光机内，优先取栈顶帧文件
    if (activeTab === 'panorama' && panoramaMode === 'canvas' && eventTrail.length > 0) {
      const top = eventTrail[eventTrail.length - 1];
      const f = fileCacheRef.current.get(top.fileId) ?? files.find((item) => item.file_id === top.fileId);
      if (f) return { file: f, revisionId: top.revisionId || f.current_revision_id };
    }
    // 列表态优先取当前 J/K 选中事件的文件
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
      // V11 · 全站导航（1/2/3）与全景三态和弦（G S / G C / G L）与侧栏折展（[ / ]）
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
        // 已在阅读态则不重复打开（避免干扰正文区）
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
        showSystemToast('ok', `已加入证道阁上下文篮：${target.file.title}`);
        return true;
      }

      return false;
    },
  });

  // ---------- C03 · 命令面板执行回调（Enter / Ctrl+Enter / Tab / 动作行） ----------
  // Enter 打开：复用既有打开链路（阅读器 + 返回面包屑），revisionId 缺省时退当前版
  const handlePaletteOpenFile = (item: PaletteItem) => {
    if (!item.fileId) return;
    // 多项目并存命中：零重启切到来源项目并打开完整阅读器
    if (item.projectId && item.projectId !== multiProjects.activeProjectId) {
      void multiProjects.handleActivateProject(item.projectId, {
        projectId: item.projectId,
        fileId: item.fileId,
        openTab: 'library',
        libraryMode: 'read',
      });
      return;
    }
    // C05：挂载区命中——参考工作区资料不在主区文件列表，走 QuickLook 只读预览
    // （版本级端点经服务端按 revision 溯源路由到参考区只读库），并按挂载身份
    // （规范化路径稳定哈希）持久保留阅读位置，离线/重挂后可回看
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

  // Ctrl+Enter 定位所在目录：直连 A04 revealInExplorer（'.' 即工作区根）
  const handlePaletteLocate = (item: PaletteItem) => {
    void handleRevealInExplorer(item.relativePath ?? '');
  };

  // Tab 加入上下文（证据）篮：从内存版本链投影取当前版哈希（零异步）；
  // 缓存缺当前版数据时退化为 metadata_only 文件级指针（诚实口径）
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

  // 动作行：跳到今天 / 证据篮 / 定位根目录 / 切换工作区
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
      // C05：打开挂载参考工作区管理面板（面板自己负责挂载/卸载与错误透出）
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

  // F9（验收审查）：日历态消费的累计事件表在 bootstrap 后只有首页（50 条），
  // 更早日期的事件在日历恒缺（旧链路 /scan 下该数组是全量）。进入日历态即沿当前
  // 窗口游标自动续拉至取尽；列表态的手动「加载更多」保持不变。
  // 链式触发：每页到达（eventPage 变更）后由 effect 接棒下一页；
  // 筛选竞态由 loadMoreEvents 内的代际守卫兜底（期间改筛选的旧页直接作废）。
  const calendarAutoFillLatchRef = useRef(false);
  const calendarAutoFillStoppedRef = useRef(false);
  useEffect(() => {
    if (panoramaMode !== 'calendar') {
      calendarAutoFillLatchRef.current = false;
      calendarAutoFillStoppedRef.current = false;
      return;
    }
    if (calendarAutoFillStoppedRef.current || calendarAutoFillLatchRef.current) return;
    if (!eventPage?.has_more || eventPageLoading) return;
    calendarAutoFillLatchRef.current = true;
    void loadMoreEvents().then((ok) => {
      calendarAutoFillLatchRef.current = false;
      // false = 取页失败或期间筛选变更致在途页作废：停止自动补全（不无限重试），
      // 切出再切回日历态即重新开始；列表态的手动加载不受影响
      if (!ok) calendarAutoFillStoppedRef.current = true;
    });
  }, [panoramaMode, eventPage, eventPageLoading, loadMoreEvents]);

  // T03：标尺粒度切换（月/周/日）。切回全域窗口重新取数，选中日期清空由画布自选最新桶
  const handleGranularityChange = (granularity: EventDayGranularity) => {
    const dq = dayQueryRef.current;
    if (granularity === dq.granularity && !dq.drill) return;
    dayQueryRef.current = { ...dq, granularity, drill: null };
    setDayGranularity(granularity);
    setDrillRange(null);
    setActiveDate(undefined);
    // 发起时刻窗口快照：days 落地时指纹不一致（期间又切粒度/下钻/口径）丢弃响应，
    // 避免旧窗口的 days 覆盖新窗口（eventDays 无代际体系，见 sameDayQuery 纪律）
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

  // T03：点月/周聚合刻度下钻到日——按该桶的日期窗口（月=整月、周=周一至周日）取逐日数据
  const handleDrillToBucket = async (bucketDate: string, bucketGranularity: EventDayGranularity) => {
    const window = bucketRange(bucketDate, bucketGranularity);
    if (!window) return;
    dayQueryRef.current = { ...dayQueryRef.current, granularity: 'day', drill: window };
    setDayGranularity('day');
    setDrillRange(window);
    setActiveDate(undefined);
    // 发起时刻窗口快照：days 落地时指纹不一致（期间又切粒度/下钻/口径）丢弃响应——
    // 连选中日定位一起不落，避免旧桶的逐日数据与 activeDate 覆盖新窗口
    // （eventDays 无代际体系，见 sameDayQuery 纪律）
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
      // 下钻后定位到该桶内最新一个有事件的日子
      const latest = days.groups.find((g) => g.date !== '');
      if (latest) setActiveDate(latest.date);
    }
  };

  const toggleUndatedEvents = async () => {
    const next = !undatedOnly;
    // 发起即 bump 作废旧窗口（竞态纪律，见 eventFetchGenRef 注释；此前漏 bump）：
    // 旧 undated 指纹签发的在途游标续页会把旧窗口事件 append 进新窗口，或整页覆盖
    // 新筛选结果
    eventFetchGenRef.current += 1;
    // 完成侧守卫：落地代际不一致（期间又改了类型/日期/口径）丢弃响应（同 loadMoreEvents）
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
    // 发起即 bump 作废旧窗口（竞态纪律，见 eventFetchGenRef 注释；此前漏 bump）：
    // 旧 order 指纹签发的在途游标续页会把旧窗口事件 append 进新窗口，或整页覆盖
    // 新筛选结果
    eventFetchGenRef.current += 1;
    // 完成侧守卫：落地代际不一致（期间又改了类型/日期/口径）丢弃响应（同 loadMoreEvents）
    const gen = eventFetchGenRef.current;
    setEventOrder(next);
    // T03：画布聚合与 Timeline 同步切换口径（同一持久查询）
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
    // days 响应按发起时刻画布窗口指纹守卫（eventDays 无代际体系，见 sameDayQuery）：
    // 期间切粒度/下钻/口径的旧 days 不得覆盖新窗口
    if (days && sameDayQuery(dayQueryRef.current, dq)) setEventDays(days);
  };

  // 契约⑤：全景溯源 星图/列表/日历 三态切换——浅端宿主组件化为 Tabs（标线语法，§4.3 #3：
  // 去 glass-chip 填充、idle 字 soft）；canvas 态的暗端同契约双端由 GraphCanvasView 渲染
  // （画布闸批次挂 theme=dark 收编，本批不动）；list/calendar 态仍由 TimelineView/CalendarBoardView
  // 顶部渲染同组（文案逐字同契约）。Esc 五级契约（回星图分支）零改动。
  const renderPanoramaModeSwitch = () => (
    <Tabs
      ariaLabel="全景溯源视图切换"
      items={PANORAMA_MODE_OPTIONS.map((option) => ({ key: option.value, label: option.label }))}
      active={panoramaMode}
      onChange={(key) => setPanoramaMode(key as PanoramaMode)}
    />
  );

  return {
    // 桌面会话与桥接
    desktopSession, desktopBridgeAvailable, desktopSystemAvailable, hasActiveBackend,
    workspaceEpoch, switchingWorkspace, workspaceSwitchError,
    handlePickWorkspaceFolder, handleSwitchWorkspace, handleRemoveRecentWorkspace,
    // 数据
    config, files, events, decisions, decisionsUnresolvedTotal, relations, filesTotal, fileFacets, readingStates,
    setReadingStates, mutedFolders, handleToggleMuteFolder, handleUnmuteFolder, handleClearMutedFolders,
    dataSource, dataError, scanSummary,
    // 事件查询
    eventDays, activeDate, setActiveDate, eventPage, eventPageLoading, undatedOnly, eventOrder,
    eventKindFilter, dayGranularity, changeNotice,
    // 任务与投影
    rescanState, rescanError, serviceStatus, stateOverview, setStateOverview,
    agentDraftFileIds, l4aProgress, eventDataReady, workspaceSummary, eventRange, dateFilter,
    handleRescan,
    networkOffline, streamDisconnected, retryingConnection, handleRetryConnection,
    // 导航与选中
    activeTab, setActiveTab, handleSelectPrimaryTab, panoramaMode, setPanoramaMode, portholeRef, handleCanvasThemeChange,
    libraryMode, setLibraryMode, eventTrail, setEventTrail,
    activeFileId, setActiveFileId, pinnedRevisionId, setPinnedRevisionId,
    readerSubMode, setReaderSubMode, readerAnchor, setReaderAnchor,
    readerFocusSection, setReaderFocusSection, readerScrollPercentRef,
    selectedEventId, setSelectedEventId, selectedDecisionId, setSelectedDecisionId,
    returnBreadcrumb, setReturnBreadcrumb, navSourceStack, handleNavigateLinkedFile,
    // 搜索与筛选
    searchQuery, setSearchQuery, sidebarFilters, setSidebarFilters,
    handleClearSidebarFilters, sidebarFilterActive, sidebarFilterLabel, activeFileInFilter,
    smartViewFiles, activeSmartView, filteredFiles,
    // D02 增量聚光灯（司辰旁导航条 + 画布骨架降亮度）
    spotlightEnabled, spotlightItems, spotlightDimmedFileIds,
    handleSpotlightToggle, handleSpotlightCursor, spotlightCursor,
    // 浮层与抽屉
    isSettingsOpen, setIsSettingsOpen, isMcpConsoleOpen, setIsMcpConsoleOpen,
    isContextDrawerOpen, setIsContextDrawerOpen, isMobileLeftOpen, setIsMobileLeftOpen,
    isMobileRightOpen, setIsMobileRightOpen, libraryInspectorOpen, setLibraryInspectorOpen,
    overviewInspectorCollapsed, setOverviewInspectorCollapsed,
    decisionRadarSignal, setDecisionRadarSignal, isHelpOpen, setIsHelpOpen,
    isMountPanelOpen, setMountPanelOpen, mountedWs,
    // E04 批阅看板 + V10 司辰手记
    isReviewBoardOpen, setIsReviewBoardOpen, reviewBoard, reviewBoardLoading,
    isChronosDigestOpen, setIsChronosDigestOpen,
    reviewBoardError, reviewBoardBusyKey, reviewBoardNotice,
    refreshReviewBoard, handleOpenReviewBoard, handleBoardAckStatement,
    handleBoardRepairOrphan, handleBoardJumpToStatement, handleBoardInspectDraft,
    // 命令面板
    palette, isPaletteOpen, closePalette,
    handlePaletteOpenFile, handlePaletteLocate, handlePaletteAddToBasket, handlePaletteAction,
    // 派生数据
    unreadFilesCount, contextPointers, setContextPointers,
    searchHits, recentItems, activeFile, packageList, activePackage,
    stateOverviewIndex, activeInitiative, zhendaogePreset, presetPointers, recommendedMounts,
    focusedContextFileId: focusedContextTarget.fileId,
    confirmedDecisionLines, pendingBlockerLines, referenceMetaOf, contextSessionCheckpointId,
    openContextDrawer, handleMountPointers, handleUpdatePointerGranularity,
    deliveredInitiatives, deliveredInitiative, initiativeLifecycle, runInitiativeLifecycle,
    hitlClearedAt,
    // 变更单与回写
    proposalToast, proposalAdopting, proposalRejecting, proposalAdoptNotice,
    proposalDiffExpanded, proposalDiffLoading, proposalDiffError, proposalDiffContent,
    handleAdoptProposal, handleRejectProposal, handleViewProposalDiff,
    handleOpenProposalInReader, handleDismissProposalToast,
    decisionChangeNote, setDecisionChangeNote, decisionChangeToast, setDecisionChangeToast,
    pushDecisionChangeNote,
    handleDecisionResolved, handleBlockingCleared,
    handleAddEvidencePointer, handleAddDecisionReceiptToBasket,
    // 文件缓存与事件操作
    publishFiles, mergeEventsPage, ensureFileDetail, ensureRevisionContent,
    loadMoreEvents, refreshEvents, silentMergeNewEvents, silentMergingEvents, toggleUndatedEvents, toggleEventOrder,
    applyDayFilter, applyKindFilter, resetEventFilters, handleJumpToDayInTimeline,
    handleGranularityChange, handleDrillToBucket, handleSelectCanvasDate,
    // 处理器
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
