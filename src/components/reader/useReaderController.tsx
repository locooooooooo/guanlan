/**
 * D01-a 拆解 · ReaderView 行为控制器（任务卡 D01-a ②「格式专用阅读器插件层」的行为出口）。
 *
 * 从 ReaderView.tsx 组件体（原 1148-2641）原样迁入的全部 state / memo / effect /
 * handler 与渲染期闭包（renderMarkdownBlock 等行模型→JSX 函数）。单一行为出口
 * useReaderController(props) 返回 ctx，供 reader/ 分节渲染层消费：
 *  - reader/readerChromeSections.tsx（返回横幅/新版本告警/双层文件头）
 *  - reader/readerDiffSection.tsx（diff 子模式面板）
 *  - reader/readerRelationsSection.tsx（关系子模式面板）
 *  - reader/readerMarkdownSection.tsx（MD 阅读纸 + 决策动作条）
 *  - reader/readerSvgPdfSections.tsx（SVG / PDF 格式插件层）
 * 迁移纪律：hook 顺序、闭包依赖、effect deps 与拆解前逐字一致。
 */

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
// wf_4：语义聚合层纯函数（任务包 / 五阶段）——所属专项 Stepper 数据全部来自这里；
// v0.8 R2：extractCoreSummary 随内嵌抽屉退役（正文摘要收归 RightInspector 承载面）
import { groupFilesIntoPackages, stageOfPath } from '../../utils/taskPackages';
import type { PackageDoc, StageRole, TaskPackage } from '../../utils/taskPackages';
// 统一状态机 SSOT（方案 F2）：版本「（最新）」后缀词单一出口——文件头/模式组/版本
// select 不再各自硬编码（AC-01 四视图同词）。F1/F2：文档顶栏与所属专项详情
// 消费 /state-overview 六态投影（服务端优先，无行回退既有词）。
import {
  artifactStateOf,
  docStatePillClass,
  indexStateOverview,
  initiativeStateBadgeLine,
  initiativeStateOfPackage,
  projectInitiativeState,
  revisionVersionLabel,
} from '../../utils/stateProjection';
// AC-02：首屏渲染预算——正文读取与 shell 解耦；300ms 预算测量/告警（纯函数可单测）
import {
  READER_FIRST_SCREEN_BUDGET_MS,
  readerFirstScreenNowMs,
  recordReaderFirstScreenSample,
  resolveReaderBodyPhase,
} from '../../utils/readerFirstScreen';
// issue #29：版本正文统一仓库——与 App/diff 共享请求协调、字节预算与 pin
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
// Inline 拍板闭环（PRD 3.3 / 方案 F5）：卡点块解析（[P0/P1/P2 - 待确认]）与
// 原位拍板表单；.md 占位符替换由后端拍板 job 完成，本层只组装载荷与展示结果
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
// 契约⑧①：observed_at 相对时间（「X 分钟前/今天 HH:mm」）——单一事实源在 utils/timeFormat.ts
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
// D04 · 阅读器锚点批注层：本地独立证据表（按版本哈希绑定）+ 决定项插入文本 +
// 框选区域几何。读写全部纯函数/薄壳，批注绝不改写用户原始 SVG/PDF 字节。
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
// U05 · 阅读器 chrome 纯函数层（进度光条换算 / 迷你版本轴映射 / Zen 状态机）。
// 纪律：纯函数住在 chrome 分节文件里（渲染层与行为层共用单一出处），本文件只消费不重算。
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
// D05 快捷键纪律同源：编辑面一切键让路 + 浮层内键归浮层自己（只读引用，不改判定口径）
import {
  hasBlockingDomOverlay,
  isEditableLikeTarget,
} from '../../utils/keyboardShortcuts';
import { getResolvedAppTheme, subscribeAppTheme } from '../../stores/appThemeStore';

export interface ReaderViewProps {
  sourceLine?: number;
  /** B03：从决定证据或 Markdown `#Sheet!Range` / `#para=N` 跳入 Office 文档时的精确结构化锚点 */
  officeAnchor?: OfficeEvidenceAnchor | null;
  /** B04：从决定证据或 Markdown `#page=N` 跳入 PDF 时的精确页码锚点（1-based） */
  pdfAnchor?: PdfEvidenceAnchor | null;
  /** pm_1：「继续阅读」定位目标——上次读到的章节标题（ReadingState.last_section_id） */
  focusSectionId?: string;
  /** GU-1：「继续阅读」的读行恢复——上次离开时的滚动百分比基线。定位时经大纲反查该行，
   *  章节名找不到/删节时安静留在定位点，不二次猜测；为 0/NaN/缺失时不干扰既有章节定位。 */
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
  /** GU-1：阅读器真实滚动发生的回调——把换算后的滚动百分比回传，父级持久化到 ReadingState.scrollPercent */
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
  /** F1/F2（AC-01）：App 级 /state-overview 唯一数据源。 */
  stateOverview?: StateOverviewResponse | null;
  /** wf_4：所属专项上下文（可选）。 */
  packageContext?: TaskPackage | null;
  /** v0.8 R1：右上角 ⓘ「溯源与关联」入口的开合线程——显隐 state 归 App 级。 */
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  /** U05：专注纸面（Zen）状态变化通知——App 层据此收起/恢复左右侧栏。 */
  onZenModeChange?: (zenMode: boolean) => void;
  /** U05：直达「版本时光机」（U04 画布）——只做视图跳转，不改任何只读语义。 */
  onOpenTimeMachine?: () => void;
  /**
   * 阅读中的新事件提示。并入文件头指挥条，不再另起通栏。
   * 缺省不渲染；暂收状态由文件头自己记住，不回写全景页的横幅。
   */
  readingNotice?: { count: number; at: string } | null;
  onSilentMergeNotice?: () => void;
  silentMergingNotice?: boolean;
  onRefreshNoticeWindow?: () => void;
  /** 决策回执 T3（可选）：把已勾选决策/填空加入证据篮。 */
  onAddDecisionToBasket?: (payload: import('./readerDecisionModel').DecisionReceiptBasketPayload) => void;
  /** Inline 拍板闭环（PRD 3.3 / 方案 F5）：拍板回写成功后回调。 */
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
  /** AC-03：当前文档阻塞性事项（P0/P1）全部拍板清零——App 渲染长任务恢复横幅。 */
  onBlockingCleared?: (payload: { fileId: string }) => void;
  /** A04：资源管理器定位 / 默认应用打开 / 复制相对绝对路径 / 右键菜单 */
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
  // v0.8 R1：右侧「溯源与关联」检查器开合（App 级 RightInspector 显隐）；
  // 缺省=收起/无操作，总装接线前保证本组件独立可渲染
  inspectorOpen = false,
  onToggleInspector = () => {},
  // U05：专注纸面（Zen）状态通知 + 直达版本时光机（可选；未传则对应入口零动作）
  onZenModeChange,
  onOpenTimeMachine,
  readingNotice = null,
  onSilentMergeNotice,
  silentMergingNotice = false,
  onRefreshNoticeWindow,
  // 决策回执 T3：证据篮回调可选——未传只隐藏「加入证据篮」按钮，其余功能完整
  onAddDecisionToBasket,
  // Inline 拍板闭环（F5）：回调可选——未传只更新本组件内状态，不炸
  onDecisionResolved,
  onBlockingCleared,
  stateOverview,
  systemActions,
}: ReaderViewProps) {
  // Long-form reading supports Paper-Light (纸面浅色) vs Dark Neutral (深色中性) per §3.2
  // V09：暖宣纸与暗夜阅读纸随全站主题平滑衔接，并保留阅读器顶栏独立昼夜切换权
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
  // 提要条折叠态（排版实施新增的唯一 state：默认收起，仅控制显隐，不触任何数据逻辑）
  const [calloutsCollapsed, setCalloutsCollapsed] = useState<boolean>(true);
  // R2-reader-structure：章节大纲浮层开合态——默认收起，纸面不再被 224px 常驻大纲列挤压，
  // 46rem 设计行宽在 1366/1440 宽屏可达；「章节大纲」按钮一键开合，浮层不占 flex 布局宽
  const [outlineOpen, setOutlineOpen] = useState<boolean>(false);
  // v0.8 R2：wf_2 的右上角 ⓘ 内嵌抽屉（detailOpen 下横幅）退役——溯源明细收归
  // App 级 RightInspector（右侧滑出面板），开合线程经 inspectorOpen/onToggleInspector 传入
  const [diffLayout, setDiffLayout] = useState<'split' | 'unified'>('split');
  // 顶栏文件操作收拢为「⋯」轻浮层，避免 7 枚系统操作按钮另占整行挤压正文首屏
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

  // ── U05 · 专注纸面（Zen）─────────────────────────────────────────────────
  // 状态归阅读器控制器（唯一行为出口）；App 层只负责「收起/恢复左右侧栏」这一外部动作
  // （onZenModeChange 回调），两侧状态由本层单向驱动，避免壳层与阅读面各记一份。
  const [zenMode, setZenMode] = useState<boolean>(false);
  const zenNotifyRef = useRef<((zen: boolean) => void) | undefined>(onZenModeChange);
  useEffect(() => {
    zenNotifyRef.current = onZenModeChange;
  }, [onZenModeChange]);
  // 阅读器卸载（切概览/切 tab）时若仍处 Zen 态，通知壳层恢复左右侧栏——
  // 否则左栏会永久停在收起态（壳层与阅读面状态脱钩）。
  useEffect(
    () => () => {
      zenNotifyRef.current?.(false);
    },
    []
  );

  /** Zen 切换唯一入口：判定走 resolveZenToggle 纯函数（按钮恒切；快捷键按护栏让路）。 */
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

  // 快捷键：Z 切换专注纸面（阅读器域内快捷键，与全局 J/K/H/L/D/C 正交；
  // 编辑面 / 浮层打开 / 非阅读态一律让路——判定口径与全局快捷键同源）。
  // 监听只注册一次：最新态经 zenStateRef 读取（避免每帧重挂监听）。
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toggleZen 经 ref 读最新态
  }, []);

  // ── U05 · 文档迷你版本轴（点版本胶囊展开的玻璃微型修订链）────────────────
  const [versionAxisOpen, setVersionAxisOpen] = useState(false);
  useEffect(() => {
    setVersionAxisOpen(false);
  }, [activeFile.file_id]);
  // Esc / outside-click 关闭迷你版本轴（与文件操作菜单同级守卫）：
  // 弹层锚在 header 根节点下（避让 Row2），触发器在元信息行——两处均以
  // data-reader-version-axis* 属性识别，命中其一不关，其余点击一律收口。
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

  // Custom revision comparison selectors
  const defaultFromRev =
    readingState?.last_read_revision_id &&
    readingState.last_read_revision_id !== activeFile.current_revision_id
      ? readingState.last_read_revision_id
      : activeFile.revisions[0]?.revision_id || activeFile.current_revision_id;
  const [customFromRevId, setCustomFromRevId] = useState<string>(defaultFromRev);
  const [customToRevId, setCustomToRevId] = useState<string>(activeFile.current_revision_id);

  // SVG Viewer controls (§4.2)
  const [svgZoom, setSvgZoom] = useState<number>(100);
  const [svgFullWidth, setSvgFullWidth] = useState<boolean>(false);
  const [showSvgSourceDiff, setShowSvgSourceDiff] = useState<boolean>(false);
  // 契约⑧⑤：SVG 可提取文字检索层默认折叠为头部一行，点击展开原气泡墙
  const [svgTextsExpanded, setSvgTextsExpanded] = useState<boolean>(false);

  // PDF Viewer controls (§4.3)
  const [activePdfPage, setActivePdfPage] = useState<number>(1);
  // B04：PDF 双视图模式——raw=原版版式（iframe）；structured=页级文本（/pdf 端点结构化视图）
  const [pdfViewMode, setPdfViewMode] = useState<'raw' | 'structured'>('raw');

  // ── U05 · 2px 琉璃阅读进度光条（命令式直写）────────────────────────────
  // 光条只动 transform（scaleX，GPU 合成器无重排）；数据源唯一＝下方 handleMarkdownScroll
  // 已算好的 pct——禁在滚动事件里另起第二套换算口径（防两套口径漂移）。
  // 采用命令式直写（不进 React state）：滚动期零重渲染，长文档不掉帧。
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

  // 切换文件时重置随文件变化的状态：旧文件的 revision_id / 章节定位 / PDF 页码不能带入新文件
  // （否则「历史快照对比」会拿上一个文件的版本号对新文件做 diff，得到 NOT_FOUND 错误态）
  useEffect(() => {
    setActiveSectionId('');
    setActivePdfPage(1);
    // AUTO-ITERATION 积压修复（换文档滚动复位）：切文件把阅读纸滚回文首——
    // 阅读纸容器跨文件常驻（hidden 保活同款），不复位则新文档停在旧文档的滚动深度。
    // 本 effect 先于「继续阅读」恢复链路（openToScrollPercent / focusSectionId 的
    // effect 声明在后、经 rAF 定位），纯换文档复位不覆盖续读定位。
    if (markdownScrollRef.current) {
      markdownScrollRef.current.scrollTop = 0;
    }
    // U05：换文档 → 阅读进度归零（光条与纸面滚动同源，不残留上一份文档的进度）
    applyReadingProgress(0);
    setCustomToRevId(activeFile.current_revision_id);
    setCustomFromRevId(
      readingState?.last_read_revision_id &&
        readingState.last_read_revision_id !== activeFile.current_revision_id
        ? readingState.last_read_revision_id
        : activeFile.revisions[0]?.revision_id || activeFile.current_revision_id
    );
    // 仅在切换文件时重置：阅读状态更新不应打断用户正在进行的版本选择
  }, [activeFile.file_id, applyReadingProgress]);

  // ── D04 · 锚点反向定位闪烁（决定/批注跳转到达信号）────────────────────────
  // 到达即闪两轮琥珀描边（.glx-anchor-flash，CSS 动画），2.2s 后自动摘除——
  // 残影不落 DOM：flash 为 null 时各消费面不渲染任何闪烁属性/类名。
  // MD 行由 wrapLine 消费 flashSourceLine（含 GU-CC-01 就近回退落点）、PDF 页由
  // ReaderPdfSection 页级容器消费 flashPdfPage、SVG/PDF 批注条目由 anchorFlash.annotationId 消费。
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

  // B04：决定/Markdown 证据传入 pdfAnchor 时——自动切到页级文本视图并跳到目标页。
  // D04：到达即对页级容器闪两轮琥珀描边（anchorFlash，2.2s 自动摘除）——
  // 「从决定追到 PDF 页」的到达信号，页级容器由 ReaderPdfSection 消费。
  useEffect(() => {
    if (pdfAnchor?.kind === 'pdf_page' && pdfAnchor.page > 0) {
      setPdfViewMode('structured');
      setActivePdfPage(pdfAnchor.page);
      flashAnchor({ kind: 'pdf', page: pdfAnchor.page });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flashAnchor 经 ref 稳定
  }, [pdfAnchor]);

  // Local Relation Graph controls (§3.2, §6)
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

  // ── U05 · 文档迷你版本轴（修订链序 vN → … → v1）─────────────────────────
  // 数据源＝文件自带版本集（activeFile.revisions）；映射走 chrome 纯函数层，
  // 与版本时光机「按修订链」同一叙事（绝不改按日期排序）。
  const miniVersionAxis: MiniVersionAxisNode[] = useMemo(
    () =>
      buildMiniVersionAxis(
        activeFile.revisions,
        currentRev.revision_id,
        latestRev.revision_id
      ),
    [activeFile.revisions, currentRev.revision_id, latestRev.revision_id]
  );

  /** 该文档格式是否可直达「版本时光机」（非时光机格式不显示该入口，不做假入口）。 */
  const canOpenTimeMachineNow = canOpenTimeMachine(activeFile.format);

  /** 迷你版本轴·切版：把阅读器钉到该版本（只读呈现，不改未读基线）。 */
  const selectMiniVersion = (revisionId: string) => {
    if (!revisionId) return;
    onChangeRevision(revisionId);
    setVersionAxisOpen(false);
  };

  /** 迷你版本轴·一键切版比对：以当前阅读版为基准、该版为目标，进入历史快照对比。 */
  const compareMiniVersion = (revisionId: string) => {
    if (!revisionId) return;
    setCustomFromRevId(currentRev.revision_id);
    setCustomToRevId(revisionId);
    onChangeSubMode('diff_versions');
    setVersionAxisOpen(false);
  };

  /** 迷你版本轴·进入版本时光机：只做视图跳转（U04 画布），不改任何只读语义。 */
  const openVersionTimeMachine = () => {
    setVersionAxisOpen(false);
    onOpenTimeMachine?.();
  };

  // AC-02：首屏渲染计时起点——按 screenKey（文件 + 钉住版本）变更重置；shell
  // 提交后由下方 effect 记录耗时。ref 只作测量戳，不参与渲染输出、不触发重渲染。
  const firstScreenKey = `${activeFile.file_id}::${currentRev.revision_id}`;
  const firstScreenStartRef = useRef<{ key: string; start: number } | null>(null);
  const firstScreenRecordedRef = useRef<string | null>(null);
  const firstScreenRootRef = useRef<HTMLDivElement | null>(null);
  if (firstScreenStartRef.current?.key !== firstScreenKey) {
    firstScreenStartRef.current = { key: firstScreenKey, start: readerFirstScreenNowMs() };
    firstScreenRecordedRef.current = null;
  }

  // wf_4：所属专项上下文——经 taskPackages 现算 activeFile 归属包。
  // packageContext 未传 → 不渲染（与既有版逐字节一致）；传入的包不含 activeFile 时
  // （用户在专项间跳转）经 groupFilesIntoPackages(files) 重算真实归属包；未命中 → 不渲染。
  const activePackage = useMemo<TaskPackage | null>(() => {
    if (packageContext === undefined || packageContext === null) return null;
    if (packageContext.docs.some((d) => d.fileId === activeFile.file_id)) {
      return packageContext;
    }
    const pkgs = groupFilesIntoPackages(files);
    return pkgs.find((p) => p.docs.some((d) => d.fileId === activeFile.file_id)) ?? null;
  }, [packageContext, files, activeFile.file_id]);

  // v0.8 R2：包内 readingOrder 位置与前后相邻文档（prevDoc/nextDoc）计算随内嵌抽屉退役——
  // 上下游「阅读顺序」跳转钮迁入 App 级 RightInspector（迁入实现归总装票，总装-5）
  // wf_4：当前阅读文档自身的阶段（Stepper 上标「当前阅读」位置，与包主导阶段区分）
  const activeFileStage = stageOfPath(activeFile.relative_path);

  // F1/F2（AC-01）：/state-overview 投影——文档顶栏按 artifact.file_id 取六态；
  // 所属专项详情条按包解析 initiative 行（服务端优先，无行回退 dominantStage）。
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

  // v0.3: 大文件正文未内联时按需从本地服务读取（不伪造内容）
  // v0.4: 按 revision_id 读取版本快照（fetchRevisionContent），失败时显示错误态，
  //       绝不拿磁盘当前文件内容冒充钉住的历史版本正文
  // issue #29: 请求协调统一走 revisionContentStore——App/Reader/diff 同版并发读取
  //   合并为一次底层请求；本组件保留本地镜像（渲染同步用），正文预算与重试在 store
  const [fetchedContent, setFetchedContent] = useState<Record<string, string>>({});
  const [fetchError, setFetchError] = useState<Record<string, string>>({});
  // AC-02：冷启动对账期间按版本读取可能较慢——shell 先渲染，正文区用纸面内
  // loading；首屏耗时由 readerFirstScreen 测量/锁定（<300ms），正文到达后自动显示。
  const [fetchPending, setFetchPending] = useState<Record<string, boolean>>({});
  const contentKey = `${activeFile.file_id}::${currentRev.revision_id}`;
  useEffect(() => {
    if (activeFile.format !== 'md') return;
    if (currentRev.markdownContent !== undefined) return;
    if (fetchedContent[contentKey] !== undefined || fetchError[contentKey] !== undefined) return;
    // store 已有 ready 条目（此前读过的版本）直接回填，不再发请求
    const stored = getRevisionContent(currentRev.revision_id);
    if (stored?.state === 'ready') {
      setFetchedContent((prev) => ({ ...prev, [contentKey]: stored.text ?? '' }));
      return;
    }
    // failed 态不自动重试（终态提示如实呈现），仅在无条目时发起（in-flight 由 store 合并）
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

  // AC-02：首屏渲染测量——shell 提交后记录一次（每个 screenKey 一次）；正文是否
  // 已内联不影响本样本（contentPending 如实标记「shell 先到、正文后到」）。
  // 超 300ms 预算只告警、不阻塞交互；属性挂在根节点供 E2E/人工复测读取。
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

  // issue #29：当前阅读版本 pin 在字节预算内不被逐出；切走后解除上一版 pin
  const pinnedRevisionRef = useRef<string | null>(null);
  useEffect(() => {
    const prevPinned = pinnedRevisionRef.current;
    pinnedRevisionRef.current = currentRev.revision_id;
    if (prevPinned && prevPinned !== currentRev.revision_id) unpinRevisionContent(prevPinned);
    pinRevisionContent(currentRev.revision_id);
  }, [currentRev.revision_id]);

  const markdownContent =
    currentRev.markdownContent ?? fetchedContent[contentKey] ?? '';

  // AC-02：正文三态判定与既有三元逐字等价——正文未内联时错误优先于 loading；
  // 无论哪一态，外层标题/工具栏/纸面 shell 都已渲染，正文读取不阻塞首屏。
  const bodyPhase = resolveReaderBodyPhase({
    hasInlineContent: Boolean(currentRev.markdownContent),
    hasError: Boolean(fetchError[contentKey]),
    pending: Boolean(fetchPending[contentKey]),
  });

  // GU-CC-01：证据行定位 + 就近回退。有锚点路径逐字保留现版语义（querySelector 命中即
  // scrollIntoView 居中，原 284-289）；未命中时（围栏内部行/表格分隔行/空行无锚）按
  // pickNearestSourceLineAnchor 的确定性规则回退：之前最近锚点 → 之后最近锚点 → 全无锚不滚动。
  // 回退发生时展示中性横幅（缺的是定位点，不是正文；绝不出现「无正文」）；
  // 回退提示是非阻断横幅，随 sourceLine/内容/子模式变化即重算或清除。
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
      // 回归保护：有锚点路径与现版一致——querySelector 命中即居中滚动，不出任何提示。
      // D04：命中行同时闪两轮琥珀描边（决定跳转到达信号），2.2s 自动摘除。
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
        // 全文件无锚点：不滚动、不出提示，绝不假装定位成功
        setSourceLineFallback(null);
        return;
      }
      document
        .querySelector('[data-event-source-line="' + landed + '"]')
        ?.scrollIntoView({ block: 'center' });
      setSourceLineFallback({ target: sourceLine, landed });
      // 空行/围栏内部行回退：闪烁落在实际到达的最近有效锚点（不是目标行）
      flashAnchor({ kind: 'md', line: landed });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flashAnchor 经 ref 稳定
  }, [sourceLine, subMode, markdownContent, contentKey]);

  const outline = useMemo(() => {
    if (activeFile.format !== 'md' || !markdownContent) return [];
    return parseMarkdownOutline(markdownContent);
  }, [activeFile.format, markdownContent]);

  // perf①：链接解析索引——App 侧 files 是 useState 数组直传（App.tsx files={files}），
  // 身份稳定，索引只在 files 变化时重建（2200 文件一遍 O(n)）；href 解析结果缓存在
  // 索引内随文件集复用，正文换版本（同文件集）时不重扫。
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

  // perf②：markdownContent → 行模型。deps 仅 [markdownContent, 链接索引]——
  // sourceLine 高亮 / activeSectionId / showLineNumbers / paperLightMode /
  // readingState / 各回调等易变输入全部留在渲染期叠加（见 renderMarkdownBlock），
  // 纸面浅色切换、章节高亮、行号开关、证据跳转不再触发万级字符串重解析；
  // 非 md 文件 markdownContent 恒空串 → 空模型，无解析成本。
  const markdownBlocks = useMemo(
    () => buildMarkdownBlocks(markdownContent, markdownLinkIndex),
    [markdownContent, markdownLinkIndex]
  );

  // 决策回执 T1：命中表单项的行号覆盖层——与主行模型并存（buildMarkdownBlocks 零改动），
  // 渲染期 renderMarkdownBlock 按 block.line 查此 Map 决定是否换可交互渲染；
  // 未命中行（绝大多数）走原分支逐字渲染。非 md 文件恒空 Map。
  const decisionFormItems = useMemo<Map<number, DecisionFormItem>>(
    () =>
      activeFile.format === 'md'
        ? parseDecisionFormItems(markdownContent)
        : new Map<number, DecisionFormItem>(),
    [activeFile.format, markdownContent]
  );

  // ── Inline 拍板闭环（PRD 3.3 / 方案 F5）───────────────────────────────────
  // 卡点块解析：[P0/P1/P2 - 待确认] 标记行 + 标准字段行（决定/确认人/角色/
  // 现·新运行条件/生效范围与日期），行号锚定与块模型同坐标系。仅待确认块出
  // 拍板卡；已定案块原文照旧渲染（回写落地后新版本自然消失）。
  const pendingDecisionBlocks = useMemo<DecisionBlock[]>(
    () =>
      activeFile.format === 'md'
        ? parseDecisionBlocks(markdownContent).filter((b) => b.status === '待确认')
        : [],
    [activeFile.format, markdownContent]
  );

  // 决定下拉预设：文档「可选方案/推荐理由」提取（PRD 3.3 自动提取），与
  // statement.options / 决策级 options 在卡片渲染处按块合并去重
  const docDecisionOptions = useMemo<string[]>(
    () => (activeFile.format === 'md' ? extractDecisionOptions(markdownContent) : []),
    [activeFile.format, markdownContent]
  );

  // 服务端陈述（GET /statements?file_id=&status=pending）：拍板端点的 statement_id
  // 来源与 options/recommendation/confirmer_hint/impact 两字段的数据源。
  // 端点不可用（批次二未落地的后端）→ null，表单诚实降级为可预填不可提交
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

  // 区块 ↔ 陈述匹配（statement.line_start ∈ 卡点块行范围，取首条）
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

  // 卡片锚点：原文行保持逐字渲染（卡点块行零改写），拍板卡追加在块范围内
  // 最后一个块之后（与回执层「行号覆盖渲染」互补，buildMarkdownBlocks 零改动）
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

  // 拍板回写流（每卡一条）：submitting（202 已受理，轮询中）→ ok / conflict / error。
  // 契约 C：恒 202 无 409 路径——CAS 冲突是 completed 终态的 report.writeback.cas_ok=false 分支
  const [resolveFlow, setResolveFlow] = useState<{
    blockLine: number;
    phase: 'submitting' | 'ok' | 'conflict' | 'error';
    message: string;
  } | null>(null);
  // 本会话已拍板的卡点标记行（AC-03 清零判定的窗口集；新版本内容到达后由 parse 自然剔除）
  const [resolvedBlockLines, setResolvedBlockLines] = useState<ReadonlySet<number>>(new Set());

  const handleSubmitDecision = (block: DecisionBlock, values: DecisionResolveFormValues) => {
    const statement = statementByBlockLine.get(block.line);
    if (!statement || resolveFlow?.phase === 'submitting') return;
    const payload = buildDecisionResolvePayload(values);
    setResolveFlow({ blockLine: block.line, phase: 'submitting', message: '' });
    void (async () => {
      // 三步原子操作之①：调后端回写端点（恒 202；占位符替换与状态变更在写线程 CAS 完成）
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
      // ②：轮询 job 至终态，读 report.writeback 分支（恒 202 → report，无 409）
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
        // CAS 冲突：『处理拍板请求』本身成功（检测冲突并存草案），引导版本对比
        setResolveFlow({
          blockLine: block.line,
          phase: 'conflict',
          message: '文件已被外部修改，拍板已存为草案——请比对后合并',
        });
        return;
      }
      // ③：cas_ok=true——本组件内记账 + 上抛 App（未决计数实时 -1、清零恢复提示）
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
    // 预设合并：文档「可选方案」提取 ∪ statement.options ∪ 决策级 options（去重）
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

  // 决策回执 T2：勾选/填空本机持久化。state 自带 key（file_id::revision_id）——
  // 切文件/切版本时「载入 effect 先跑、保存 effect 后跑」的同一 commit 里，
  // 旧文件的 state 带旧 key ≠ 当前 key → 保存 effect 跳过，杜绝旧勾选写进新文件键。
  const [receiptState, setReceiptState] = useState<{
    key: string;
    checks: Record<string, boolean>;
    fills: Record<string, string>;
  } | null>(null);
  const receiptStorageKey = `${activeFile.file_id}::${currentRev.revision_id}`;
  useEffect(() => {
    const snapshot = loadDecisionReceiptSnapshot(receiptStorageKey);
    // 基线种子：原文已选态（☑/☒/[x]）先行；快照有记录则覆盖（用户上次的手选为准）
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
    // 即时写（小体量 JSON；打字逐键写可接受，换 300ms 反抖会引入关窗丢尾写风险）
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
      // 单选互斥簇：选中某项时清零同簇其他项（zoneId 由 parse 期门控标注；
      // 取消勾选不触发互斥——允许点选中的项取消，不锁死读者）
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

  // GU-1：读行恢复——按停留比例精确滚回上次离开的读行（scrollTop = pct% × 可滚动量），
  // 而非只到章节首行。同 (文件, 于该文件复位的比例) 只恢复一次；切版本/无关重渲染不再把读者拽走。
  // 比例非法（0/NaN/100）时交给下方 focusSectionId 章节定位，不加猜。
  const appliedScrollPercentRef = useRef<{ fileId: string; pct: number } | null>(null);
  // GU-1：真实滚动采集——MD 阅读纸面的滚动容器引用（换算并持久化滚动百分比）
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
      // 正文不足一屏：没有可滚动距离 → 进度视为到底（不写持久化，语义与既有逻辑一致）
      applyReadingProgress(100);
      return;
    }
    const pct = Math.round((el.scrollTop / max) * 100);
    // 同一口径复用：光条与落盘共用这一个 pct（禁另算一套）
    applyReadingProgress(pct);
    const fid = activeFile.file_id; // 滚动发生时即捕获，防止反抖截止前切文件写错目标
    // 反抖落盘：快速滚动的中间帧不逐次写本地存储
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
    if (max <= 0) return false; // 正文尚未就绪/不可滚动，等下次触发（markdownContent 变化）
    const key = { fileId: activeFile.file_id, pct: openToScrollPercent };
    const applied = appliedScrollPercentRef.current;
    if (applied && applied.fileId === key.fileId && applied.pct === key.pct) return true;
    // 反查比例所在章节用于大纲高亮（仅视觉，不改变滚动目标 = 精确比例）
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
    // 同步执行：在本 commit 的 effect 阶段即设好 marker 与 scrollTop，
    // 使随后同批渲染的 focusSection 章节定位看到 marker 而跳过，避免互相覆盖
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

  // U05：正文到达/换版后同步一次光条进度（续读定位把 scrollTop 直接赋值时，
  // scroll 事件可能尚未派发；此处按同一口径补一次，滚动期仍以 handleMarkdownScroll 为准）。
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

  // pm_1：「继续阅读」点开后直达上次读到的章节首行（不再停在文首）；
  // 章节标题找不到（改名/删节）时安静地留在文首，不做二次猜测。
  // 同一（文件, 章节）只定位一次：切版本或无关重渲染不再把读者拽走。
  // GU-1：若真实滚动恢复（精确读行）已应用在本文件上，则本次不再用章节首行覆盖
  const appliedFocusRef = useRef('');
  useEffect(() => {
    // 证据跳转（sourceLine）优先：两者同时存在时不让章节定位覆盖行定位
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

  // issue #18：差异计算与对比正文预取只按 diff 子模式启用——阅读/关系子模式不再
  // 顺带预算 diff（此前 diffResult memo 无条件计算，普通阅读也要付 Θ(m×n)）
  const diffPanelActive = subMode === 'diff_since_read' || subMode === 'diff_versions';

  // pm_6：只有真的建立过阅读基线（last_read_revision_id）才叫「上次阅读版本」；
  // 从未读过时基线是最早收录的版本（revisions[0]，不一定是文档真实 v1），文案必须如实。
  // 只改措辞与可用态，不改 diff 语义（effectiveFromRevId 仍是 last_read || revisions[0]）。
  // 单版本文件没有可对照的历史版本 → 禁用；已读基线等于当前版本仍可进入
  // （结果如实显示「无变化」，不是拿空 diff 冒充）
  const hasReadBaseline = Boolean(readingState?.last_read_revision_id);
  const compareBaselineRevId =
    readingState?.last_read_revision_id || activeFile.revisions[0]?.revision_id;
  const canCompareSinceRead =
    activeFile.revisions.length > 1 &&
    Boolean(compareBaselineRevId) &&
    (hasReadBaseline || compareBaselineRevId !== activeFile.current_revision_id);

  // T01：/scan 去 MD 内联后，差异所需的两版正文按需回退（镜像上方 fetchedContent 模式）；
  // 快照已淘汰的版本不再请求（computeMarkdownDiff 对其本就返回 REVISION_UNAVAILABLE 错误态）
  // issue #18：仅 diff 子模式才预取对比正文，普通阅读不预取仅供对比的历史正文
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

  // issue #18：非 diff 子模式返回 null——计算不发生（此前 memo 无条件跑二维 LCS）
  const diffResult = useMemo<ReturnType<typeof computeMarkdownDiff> | null>(() => {
    if (!diffPanelActive) return null;
    return computeMarkdownDiff(
      activeFile,
      effectiveFromRevId,
      effectiveToRevId,
      diffContents
    );
  }, [diffPanelActive, activeFile, effectiveFromRevId, effectiveToRevId, diffContents]);

  // ── 语义 Diff 摘要卡（PRD 3.5 / 方案 F7）：版本历史区（diff_versions）的
  // 任务队列口径摘要——POST /diff 202 → 轮询 → result.summary 三项指标 + Checkpoint。
  // 端点未落地时 error 如实展示（本地 computeMarkdownDiff 快路径不受影响）；
  // 只在历史对比子模式且两版齐全时发起（阅读/关系子模式零开销）
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

  // issue #29：对比基线/目标版本同样 pin（diff 面板两版正文不被预算逐出）
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

  // issue #18：大纲「自上次读变更」高亮走章节指纹按需计算（O(m+n)，零 DP）；
  // 当前版正文由阅读器现成提供，基线正文仅在 diffContents 已取回时参与——
  // 未取回时返回 []（诚实未知，不高亮、不误报全文档变更）
  const changedSectionsOutline = useMemo<string[]>(() => {
    return computeChangedSectionsSinceRead(activeFile, readingState, {
      ...diffContents,
      ...(markdownContent ? { [currentRev.revision_id]: markdownContent } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeFile,
    readingState,
    diffContents,
    currentRev.revision_id,
    markdownContent,
  ]);

  // issue #28：只有进入「关系」子模式才构建局部图谱——普通阅读不再为未展示内容
  // 付费（消费点全部位于 subMode==='relations' 渲染门内，null 由下方兜底常量吸收）
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

  // 把当前小节或摘录加入证据篮（P1-6 定名）
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

  // ── 决策回执 T3：动作条数据与动作 ────────────────────────────────────────
  // 已选统计只数当前模型内的表单项（模型外残留快照不计数、不触发动作条）；
  // 换文件/换版本的过渡 commit 里 state.key ≠ 当前键 → 一律按 0 项处理（条隐藏）。
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
  // 已选总数 = 勾选项 + 非空填空（填空也是拍板：有内容即触发动作条与回写）
  const decisionSelectedCount =
    decisionSelectedOptions.length + decisionFillValues.length;

  // 「生成决策指令并复制」：复制成功反馈走 RightInspector「已复制」同款
  // （真实写入 .then 才进入反馈态，2s 后回落；失败静默不打断阅读——CopyIdButton 同口径）
  const [decisionCopied, setDecisionCopied] = useState<boolean>(false);
  // 切文件/切版本时复位复制反馈态（2s 计时未到就换文档时不残留「已复制」）
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

  // ── 保存回写原文件（桌面壳命令桥）：状态与错误就地承载 ───────────────────
  // saved 态持续到切文档（切文件/换版本由 receiptStorageKey effect 复位）；
  // 冲突（CONFLICT）不落任何字节——磁盘内容与阅读快照不一致时引导重开文档。
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
      // 没有任何落笔（无勾选/无填空变化）就不发写请求——诚实零变更
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

  // ── D04 · 本地锚点批注层（独立证据表，按版本哈希绑定）────────────────────
  // 版本哈希未就绪（bootstrap 摘要占位行 content_sha256=''）时诚实空清单并禁用
  // 撰写——绝不把批注挂到空哈希桶冒充当前版。换版本互不可见（键含 sha）。
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
    // annotationStoreRev 手动失效：批注落盘后 bump 重读本地证据表
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return annotationsOfVersion(loadAnnotationStore(), activeFile.file_id, currentRev.content_sha256);
  }, [activeFile.file_id, activeFile.format, currentRev.content_sha256, annotationStoreRev]);

  /** MD 行锚索引（wrapLine 消费：批注徽标）。 */
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

  /** 批注清单抽屉开合（ReaderView 挂载点；关闭态零 DOM）。 */
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  useEffect(() => {
    setAnnotationsOpen(false);
  }, [activeFile.file_id, currentRev.revision_id]);

  /** 撰写卡目标（null=关闭）：MD 行 / SVG 框选区 / PDF 页+摘录。 */
  const [annotationComposer, setAnnotationComposer] = useState<{
    target: ReaderAnnotationLocator;
    notice: { kind: 'ok' | 'error'; message: string } | null;
  } | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  useEffect(() => {
    setAnnotationComposer(null);
    setAnnotationBusy(false);
  }, [activeFile.file_id, currentRev.revision_id]);

  /** SVG 框选模式（ReaderSvgSection 工具栏开合；叠加层 crosshair 由它驱动）。 */
  const [svgAnnotateMode, setSvgAnnotateMode] = useState(false);
  useEffect(() => {
    setSvgAnnotateMode(false);
  }, [activeFile.file_id, currentRev.revision_id]);

  /** 版本哈希未就绪 → 撰写/转换统一禁用的诚实理由。 */
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
  /** MD 块悬停「批注」入口（readerRender wrapLine 消费）。 */
  const annotateFromBlock = (line: number, excerpt: string) => {
    openAnnotationComposer({ kind: 'md', startLine: line, excerpt: excerpt.slice(0, 480) });
  };
  /** SVG 框选完成入口（SvgAnnotationOverlay onRegionSelected）。 */
  const annotateFromSvgRegion = (region: { fx: number; fy: number; fw: number; fh: number }) => {
    openAnnotationComposer({ kind: 'svg', ...region });
  };
  /** PDF 页批注入口（页钮 / 选中文字）。 */
  const annotateFromPdfPage = (page: number, quote: string) => {
    openAnnotationComposer({ kind: 'pdf', page, quote: quote.slice(0, 480) });
  };

  /** 落盘批注并刷新本地清单（薄壳：load→mutate→persist→bump 重读）。 */
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

  /**
   * 提交批注（保存 / 一键转决定项）。
   * MD 转决定项：桌面壳 save_workspace_file CAS 桥——originalContent=当前阅读版正文，
   * 磁盘不一致即 CONFLICT 诚实拒绝（绝不静默覆盖）；SVG/PDF 转决定项：只落本地
   * 决定草案（停机条款：绝不改写原始二进制字节）。
   */
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
    // 保存批注；SVG/PDF 的「转决定项」也在此分支——本地决定草案，零字节回写
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

  /** 批注清单「定位」：滚动 + 闪烁（MD 行 / PDF 页 / SVG 区域）。 */
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

  // ── 渲染期闭包（自包含块抽至 readerRender.tsx；易变态经显式参数同源传入）──
  // D04：调用点在批注块之后——wrapLine 消费 annotationsByLine/flashSourceLine/
  // annotateFromBlock（声明序约束），其余闭包依赖与拆解前逐字一致。
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
    // props 透传
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
    // state
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
    // U05 · 专注纸面（Zen）
    zenMode,
    toggleZen,
    // U05 · 文档迷你版本轴
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
    // 派生
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
    // refs
    firstScreenRootRef,
    markdownScrollRef,
    // U05 · 阅读进度光条（命令式直写，滚动期零重渲染）
    readerProgressBarRef,
    readerProgressTrackRef,
    readingProgressRef,
    // handlers 与渲染期闭包
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
    // D04 · 锚点批注层与反向定位闪烁
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
