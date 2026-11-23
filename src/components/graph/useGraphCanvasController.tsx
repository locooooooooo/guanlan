/**
 * D01-a 四层拆解 · GraphCanvasView 行为控制器（任务卡 D01-a ②）。
 *
 * 从 GraphCanvasView.tsx 组件体原样迁入的全部 state / memo / effect / handler——
 * 单一行为出口 useGraphCanvasController(props) 返回 ctx，供四层消费：
 *  - graph/GraphSceneLayer.tsx（静态 Scene 节点层）
 *  - graph/GraphOverlayLayer.tsx（屏幕空间 Overlay 覆盖层）
 *  - graph/graphCanvasChrome.tsx（浮动 Chrome 工具栏）
 *  - graph/GraphSourcesPanel.tsx（浮动 Chrome · Sources 面板）
 *
 * 迁移纪律：只搬移不改写——hook 顺序、闭包依赖、effect deps 与拆解前逐字一致
 * （原组件把 hooks 全部跑完才做 visible 早退，控制器保持同一形态；早退由
 * GraphCanvasView 装配层承担，像素回归护栏覆盖）。
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import * as d3 from 'd3';
import {
  DecisionAssertion,
  DecisionSourceEvidence,
  EvidencePointer,
  FileRecord,
  ReadingState,
  RelationEdge,
  TimelineEvent,
} from '../../types/guanlan';
import {
  buildNodeHoverPreviewData,
  computeDynamicEdgePath,
  computeFanOutBounds,
  hasUnreadChanges,
} from '../../utils/guanlanEngine';
// TA-03：画布上的时刻/日期统一按本地时区展示（含时刻 ISO 不再直切 UTC 串）
import { formatLocalClock, localDay } from '../../utils/timeFormat';
// D05：星图画布 Alt+方向键 沿连线空间漫游 + prefers-reduced-motion 动态运镜降级
import { effectiveMotionDurationMs } from '../../utils/keyboardShortcuts';
import {
  buildSpatialNavCards,
  useCanvasSpatialNav,
  type CanvasNavCard,
} from './useCanvasSpatialNav';
// issue #27：视口裁剪与卡片物化的纯函数（可单测，组件只做挂载决策）
import {
  buildCardDescriptors,
  PACKAGE_GROUP_MAX_CARDS,
  visiblePackageGroupIds,
  lodGatesForTier,
  lodTierForScale,
} from '../../utils/canvasViewport';
// D01-a ③：任务包标题显示名固化（Overlay 标题层 + 折叠组头行共用同一份覆盖表）
import {
  getPackageTitleOverrides,
  setPackageTitleOverride,
  subscribePackageTitles,
} from '../../stores/packageTitleStore';
import {
  activeAccumulationSummary,
  buildCanvasEventScene,
  buildCanvasPackageGroups,
  compressEmptyRulerGaps,
  computeTrunkAccumulation,
  dedupeTicksByDate,
  deriveCanvasChangeSummary,
  fanOutDayHeaderLine,
  polishEventCardDigestLine,
  versionSpanCapsule,
  type CanvasEventCard,
  type CanvasEventScene,
} from '../../utils/graphEvents';
import type { EventDayGranularity, EventDaysResult } from '../../services/workspaceClient';
import type { StateOverviewResponse } from '../../services/apiTypes';
// wf_2：语义聚合层既有导出——任务包 chip（taskPackageOf 名称 + stageOfPath 阶段标签）与
// 同日合并卡的 changeLabel（dayMergeLabel，DoD2 逐字口径）；documentIdentity 为既有工具；
// starfix2 T1：appeared 卡行3 摘要走 extractCoreSummary 既有回退链（正文核心结论，不造假）
import { dayMergeLabel, extractCoreSummary, stageOfPath, taskPackageOf } from '../../utils/taskPackages';
// 统一状态机 SSOT（方案 F2）：星图卡阶段回退词单一出口（AC-01 四视图同词）；
// F1/F2：有 /state-overview artifact 行时改渲染六态词（服务端优先，无行回退阶段词）。
// 胶囊样式保持画布暗端 --cv-* 件（六态词与亮端同源，配色仍走画布主题令牌）。
import { indexStateOverview } from '../../utils/stateProjection';
// v0.8 任务空间桌面五件（画布工匠）：分组容器/富预览卡/药丸工具栏/小地图/叙事抽屉——
// 新 chrome 全部落新文件，本组件只做外科手术式接入；样式由各组件自带 canvasWidgets.css
import { PACKAGE_GROUP_FRAME_H } from '../canvas/PackageGroupFrame';
import { RICH_CARD_W } from '../canvas/RichDocPreviewCard';
import type { DesktopFileActionCallbacks } from '../FileContextMenu';
import type { CanvasTheme } from '../../utils/canvasThemeStore';
import { useGraphCanvasNarrative } from './graphCanvasNarrative';
import {
  CHRONOS_MASCOT_WIDTH,
  CHRONOS_TRUNK_DX,
  DATE_CARD_H,
  DATE_CARD_W,
  DEFAULT_NODE_POSITIONS,
  EVENT_CARD_H,
  EVENT_CARD_W,
  FIXED_TEXT_TRUNK_DX,
  FANOUT_HEADER_BUTTON_LEFT_GAP_W,
  milestoneY,
  eventMatchesRulerTick,
  sceneDateLabel,
  SOURCES_PANEL_COLLAPSED_LEFT,
  SOURCES_PANEL_SAFE_LEFT,
  PAN_TRANSITION_MS,
  TRUNK_AXIS_PAD,
  dateCardRailX,
  fanOutHeaderCapsuleWidth,
  type CapabilityCode,
  type LeftSourceNodeModel,
  type NodePositionMap,
  type PanoramaMode,
  type SubAgentCardModel,
} from './geometry';
// D01-b：正交避障连线引擎（纯函数几何层第二块；障碍清单与升级连线入口）
import type { ObstacleRect } from './edgeRouting';
// D02：增量聚光灯（读后真实变化条目类型；派生在宿主 store，本层只透传）
import type { SpotlightChangeItem } from '../../utils/readingSpotlight';
// V10：司辰时光步进回放纯函数（日/周步进 + 1x/2x 倍速节拍）
import {
  chronosReplayIntervalMs,
  stepChronosReplayIndex,
  type ChronosReplaySpeed,
  type ChronosReplayUnit,
} from '../../utils/chronosDigest';

export interface GraphCanvasViewProps {
  files: FileRecord[];
  events: TimelineEvent[];
  decisions: DecisionAssertion[];
  relations: RelationEdge[];
  readingStates: Record<string, ReadingState>;
  selectedFileId: string;
  onSelectFile: (fileId: string, revisionId?: string) => void;
  onExploreFile: (fileId: string, revisionId?: string, eventId?: string) => void;
  onOpenReaderModal: (
    fileId: string,
    revisionId: string,
    mode: 'read' | 'diff_since_read' | 'relations'
  ) => void;
  onOpenDecisionModal: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
  onAddEvidencePointer: (pointer: EvidencePointer) => void;
  indexGeneration: number;
  /** v0.4 第二轮：真实工程事件（按日聚合）；缺失时画布展示空态，不再回退样本卡片 */
  eventDays?: EventDaysResult | null;
  /** 当前选中的日期（'' = 日期待考；undefined = 由画布自选最新一天） */
  activeDate?: string;
  /** T05：支持 undefined —— 再次点击当前刻度/日期即取消选中，回到画布自选最新一天 */
  onSelectDate?: (date: string | undefined) => void;
  /** T05：把某天的全部事件在 Timeline 打开（App 以 from=to=该日 下推服务端筛选） */
  onOpenDayInTimeline?: (date: string) => void;
  /** T03：标尺桶粒度（day 逐日 / week 周聚合 / month 月聚合）；取数由上层完成 */
  granularity?: EventDayGranularity;
  /** T03：切换标尺粒度（月/周/日），上层按新粒度重新取数 */
  onGranularityChange?: (granularity: EventDayGranularity) => void;
  /** T03：点 week/month 聚合刻度下钻到日（上层按该桶的日期窗口重新取数） */
  onDrillToBucket?: (bucketDate: string, bucketGranularity: EventDayGranularity) => void;
  selectedEventId?: string;
  onSelectEvent?: (eventId: string) => void;
  /** ⑤ 当前全景模式（宿主 App useState；本组件仅在 'canvas' 态挂载） */
  panoramaMode: PanoramaMode;
  /** ⑤ 切换全景模式（'list'/'calendar' 由上层渲染 TimelineView/CalendarBoardView） */
  onPanoramaModeChange: (mode: PanoramaMode) => void;
  /** v0.7 评审第 2 轮（延迟项）：画布主题值不再作本组件 prop——作 prop 则一次翻转=
   *  本组件（数千 SVG 节点）整树重渲。活值在 canvasThemeStore，需要主题的两个叶子
   *  （页签 theme、分段钮）各自 useSyncExternalStore 订阅；data-canvas-theme 由宿主
   *  App 命令式直写舷窗 DOM。本组件自身零主题感知、翻转零重渲，色值全走 --cv-* */
  /** v0.7：切换画布主题（持久化与活值更新在宿主 handler 内） */
  onCanvasThemeChange?: (theme: CanvasTheme) => void;
  /** P0-3（v0.7 提示文本治理）：工作区根路径——工程名动态化取其尾链；
   *  上层（KnowledgeGraph 持 root）未接线时回退中性「观澜」，绝不再自报演示工程名 */
  root?: string;
  /** issue #27：画布是否在前台可见。隐藏时本组件保持挂载（选中态/缩放/布局不丢），
   *  但停止渲染与昂贵的派生计算（分组、卡片、整棵 SVG）。缺省 true。 */
  visible?: boolean;
  /** F1/F2（AC-01）：App 级 /state-overview 唯一数据源；事件卡有 artifact 行时
   *  行 4 胶囊渲染六态词，无行回退既有阶段词（断连行为与基线一致）。 */
  stateOverview?: StateOverviewResponse | null;
  /** A04：资源管理器定位 / 默认应用打开 / 右键文件操作菜单 */
  systemActions?: DesktopFileActionCallbacks;
  /**
   * D02 增量聚光灯（可选，宿主单一数据源派生后下推）：开启时「上次离开前已读且
   * 未变」的节点退为低对比度背景骨架（dimmedFileIds），仅高亮读后真实变化三类；
   * 司辰旁导航条（GraphSpotlightBar）消费 items/cursor 做按时间逐条批阅。
   * undefined = 关闭/宿主未接线：画布零样式注入（D01-a 像素基线零扰动）。
   */
  spotlight?: {
    enabled: boolean;
    items: SpotlightChangeItem[];
    dimmedFileIds: ReadonlySet<string>;
    cursor: number;
    onToggle: () => void;
    onCursor: (cursor: number) => void;
  };
  /** V10：呼出「司辰手记」今日/本周沉淀简报抽屉 */
  onOpenChronosDigest?: () => void;
  /** 嵌入星图顶栏的域过滤/静默徽标插槽（原生 flex 排布，杜绝绝对定位悬浮压盖顶栏按钮） */
  topBarSlot?: React.ReactNode;
}

export function useGraphCanvasController({
  files,
  events,
  decisions,
  relations,
  readingStates,
  selectedFileId,
  onSelectFile,
  onExploreFile,
  onOpenReaderModal,
  onOpenDecisionModal,
  onAddEvidencePointer,
  indexGeneration,
  eventDays = null,
  activeDate: activeDateProp,
  onSelectDate,
  onOpenDayInTimeline,
  granularity,
  onGranularityChange,
  onDrillToBucket,
  selectedEventId,
  onSelectEvent,
  panoramaMode,
  onPanoramaModeChange,
  onCanvasThemeChange,
  root = '',
  visible = true,
  stateOverview = null,
  systemActions,
  spotlight,
  onOpenChronosDigest,
  topBarSlot,
}: GraphCanvasViewProps) {
  // P0-3：三处演示工程名「拥抱AI」动态化——取工作区根路径尾链（增补 §3 终稿口径）；
  // 空根路径回退「观澜」中性名，不再自报他项目名
  const stateIndex = useMemo(() => indexStateOverview(stateOverview), [stateOverview]);
  const workspaceName = root.split(/[\\/]/).filter(Boolean).pop() || '观澜';
  // C7：默认不选中任何卡（''）；subAgentCards 变化时校正 effect 自动落到第一张卡，杜绝「右栏显示 A、画布无选中」
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string>('');
  const [hoveredCanvasNodeId, setHoveredCanvasNodeId] = useState<string | null>(null);
  const [hoveredPreviewAnchor, setHoveredPreviewAnchor] = useState<{
    fileId: string;
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  const [isFanOutCollapsed, setIsFanOutCollapsed] = useState(false);
  const [canvasLayoutMode, setCanvasLayoutMode] = useState<'xray' | 'force' | 'radial'>('xray');
  // C3→R3①：Sources 面板默认收起为窄条（85% 屏幕还给画布）；复用现役收起机制——
  // 切换时画布可视原点随面板宽度 260ms 动画左移/右移避让（SOURCES_PANEL_COLLAPSED_LEFT=36）
  const [sourcesPanelCollapsed, setSourcesPanelCollapsed] = useState(true);
  // v0.8 R3③：叙事抽屉（取代 334px 常驻检视器）。narrativeTarget 显式记录抽屉对象：
  // nodeId=事件卡叙事 / fileId=文件叙事 / 空对象=工程轴中枢叙事；open 只管滑出与否
  const [narrativeDrawerOpen, setNarrativeDrawerOpen] = useState(false);
  const [narrativeTarget, setNarrativeTarget] = useState<{
    nodeId?: string;
    fileId?: string;
  } | null>(null);
  // v0.8 R4：药丸工具栏三态 + 快捷键轻弹层；指针态禁拖拽平移（zoom filter 分流）
  const [canvasTool, setCanvasTool] = useState<'pointer' | 'pan'>('pointer');
  const [versionView, setVersionView] = useState<'latest' | 'evolution'>('latest');
  const [showShortcuts, setShowShortcuts] = useState(false);
  // starfix T3：泳道图例气泡开合（自右下图例栏收敛进药丸「?」钮；与快捷键弹层/视图设置弹层同锚位互斥防叠开）
  const [legendOpen, setLegendOpen] = useState(false);
  // 司辰常驻执掌时间轴：默认显露于主干左侧与激活日同行，并可由药丸工具栏开关显隐
  const [chronosSliderOpen, setChronosSliderOpen] = useState(true);
  // 时光流转重演：自最早沉淀日向今日逐日/逐周推进，展现时间流逝与文件一点一点累积
  const [isTimeFlowPlaying, setIsTimeFlowPlaying] = useState(false);
  // V10：步进粒度（日/周）与播放倍速（1x/2x）
  const [replayUnit, setReplayUnit] = useState<ChronosReplayUnit>('day');
  const [replaySpeed, setReplaySpeed] = useState<ChronosReplaySpeed>(1);
  // v0.8 R2：富预览卡选中（新节点不在 sub_ 槽位体系内，独立记录；顶栏「详情」按它解析目标）
  const [selectedRichDocFileId, setSelectedRichDocFileId] = useState<string | null>(null);
  // v0.8 R5：stage 高度（小地图 viewport 折算需要；与 stageWidth 同一 ResizeObserver）
  const [stageHeight, setStageHeight] = useState(0);
  // v0.4 第二轮：真实事件模式下由「真实日期」驱动；真实事件缺失/加载中的回退仍用原演示时段
  const [localActiveDate, setLocalActiveDate] = useState<string | undefined>(undefined);
  const activeDate = activeDateProp !== undefined ? activeDateProp : localActiveDate;
  // T05：selectDate 支持 undefined —— 取消选中（onSelectDate 通知上层清除 activeDate）
  // 3.4：选中某一天时叠加 500ms 平滑运镜（panToDate 为函数声明，提升后可用；
  // 只在点击/司辰切版本这类离散入口触发，拖拽与滚轮路径不受影响）
  const selectDateInternal = (date: string | undefined, opts?: { keepPlaying?: boolean; pan?: boolean }) => {
    if (!opts?.keepPlaying) setIsTimeFlowPlaying(false);
    setLocalActiveDate(date);
    onSelectDate?.(date);
    if (date && opts?.pan !== false) panToDate(date);
  };
  const selectDate = (date: string | undefined) => selectDateInternal(date);
  // 双源回位：App 侧 Esc（第④级直接 setActiveDate(undefined)，不经 selectDate）清掉 prop 后，
  // activeDate 的取值式回退（prop ?? local）会回吸 localActiveDate 残留的旧日期——画布刻度
  // 高亮、顶栏「司辰·日期」chip 全部停在已清除的那天（「回到全域」钮已随 starfix T3 收敛
  // 退役，出口=再点当前选中刻度）。这里只在
  // 「prop 已清而本地仍有值」时回写一次 undefined（不等守卫防多余渲染；selectDate 双写
  // 路径里 prop 与 local 同进同出，本 effect 恒为空转）。deps 只挂 prop：本地值本身变化
  // 无需重跑，方向恒为 prop→local 单向回位。
  useEffect(() => {
    if (activeDateProp === undefined && localActiveDate !== undefined) {
      setLocalActiveDate(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 单向回位守卫，local 依赖见上注释
  }, [activeDateProp]);
  // T03：标尺刻度点击路由已并入里程碑层 clickTick（截断无操作、周/月下钻、逐日选中/再点取消）

  const [activeTimeSlice, setActiveTimeSlice] = useState<'all' | '0:00' | '1:00' | '2:00'>('all');
  const [liveFlowEnabled, setLiveFlowEnabled] = useState<boolean>(true);
  const [meteorShowerEnabled, setMeteorShowerEnabled] = useState<boolean>(true);
  const [meteorBurstKey, setMeteorBurstKey] = useState<number>(0);
  const [xrayLaserEnabled, setXrayLaserEnabled] = useState<boolean>(true);
  const [showAllMdSources, setShowAllMdSources] = useState<boolean>(false);

  // Match reference screenshot: only "I Instructions · MD" is expanded by default; others are crisp single-line rows
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    MD: true,
    DEC: false,
    REV: false,
    SVG: false,
    TIM: false,
    PDF: false,
    REL: false,
  });
  const [hiddenCategories, setHiddenCategories] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 3.1：柔光呼吸用 SMIL 实现（不新增 CSS keyframes），SMIL 不吃 CSS 的
  // prefers-reduced-motion 降级，这里显式读一次媒体查询；减少动态时只保留 dash 脉冲
  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  );

  // D3 SVG Zoom & Node Drag State
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomLayerRef = useRef<SVGGElement | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // C3：stage 容器尺寸（选中卡→右栏高亮线的屏幕坐标终点需要）
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  // C3：平移钳制的用户空间下界（trunkX-170，随 main_hub 拖动更新；constrain 闭包经 ref 读最新值）
  const minSafeUserXRef = useRef(0);

  // R3①：Sources 默认收起 → 初始可视原点贴窄条右缘（COLLAPSED_LEFT=36），不再让 222px 的
  // 展开位留白；展开面板时 toggleSourcesPanel 仍锚定 SAFE_LEFT（几何常量一字未动）。
  // starfix T4：默认缩放冻结 100%（was 0.91）——真正的初始机位由下方「聚焦最近活跃日期
  // 展开节点」的一次性 effect 运镜落定，这里只是挂载瞬间的同 k 初值，避免首帧闪变
  const [zoomTransform, setZoomTransform] = useState<{ x: number; y: number; k: number }>({
    x: SOURCES_PANEL_COLLAPSED_LEFT,
    y: 48,
    k: 1,
  });
  // D04 · 返回画布视口「丝毫不差」：zoom 'end' 落 React state 的值做了量化
  // （x/y 取整、k 两位小数——仅供小地图/百分比文本展示），若用它恢复 d3 内部
  // transform 会引入 ≤0.5px 平移与 ≤0.5% 缩放漂移。本 ref 保存最后一次手势的
  // 全精度 transform，重挂/切回时用它还原（展示态仍消费量化 state，零变化）。
  const zoomExactRef = useRef<{ x: number; y: number; k: number }>({
    x: SOURCES_PANEL_COLLAPSED_LEFT,
    y: 48,
    k: 1,
  });
  // 帧级缩放/平移订阅器：屏幕空间 Overlay（任务包标题等）直接订阅并在每帧直写 DOM 坐标，
  // 零 React 重渲开销的同时彻底消除缩放/平移/回放动画期间的滞后漂移
  const zoomFrameListenersRef = useRef<Set<(t: { x: number; y: number; k: number }) => void>>(
    new Set()
  );
  const zoomSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribeZoomFrame = useCallback(
    (listener: (t: { x: number; y: number; k: number }) => void) => {
      zoomFrameListenersRef.current.add(listener);
      return () => {
        zoomFrameListenersRef.current.delete(listener);
      };
    },
    []
  );
  const notifyZoomFrame = useCallback((t: { x: number; y: number; k: number }) => {
    zoomExactRef.current = t;
    for (const listener of zoomFrameListenersRef.current) {
      listener(t);
    }
  }, []);
  const commitZoomState = useCallback((t: { x: number; y: number; k: number }) => {
    setZoomTransform({
      x: Math.round(t.x),
      y: Math.round(t.y),
      k: Number(t.k.toFixed(2)),
    });
  }, []);
  const [nodePositions, setNodePositions] = useState<NodePositionMap>(() => ({
    ...DEFAULT_NODE_POSITIONS,
  }));
  const [activeDraggingNodeId, setActiveDraggingNodeId] = useState<string | null>(null);

  // wf_2：revision_id → versionNumber 查表（同日同文件合并的版本解析；EventDayItem 无版本号，
  // 只能由调用方从 FileRecord.revisions 注入——禁止在 GE 层伪造）
  const revisionVersionById = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) {
      for (const rev of f.revisions) {
        if (typeof rev.versionNumber === 'number') map.set(rev.revision_id, rev.versionNumber);
      }
    }
    return map;
  }, [files]);

  // v0.4 第二轮：真实工程事件的画布场景（标尺/折叠组/导航都来自持久事件）
  const scene = useMemo(
    () =>
      buildCanvasEventScene(eventDays, {
        activeDate,
        maxCardsPerGroup: 6,
        // wf_2：注入版本解析器 → 同 file_id 同日多版本合并为一张卡（v1 → v3 · 今日演进 2 次）
        resolveVersion: (revisionId) =>
          revisionId ? revisionVersionById.get(revisionId) ?? null : null,
      }),
    [eventDays, activeDate, revisionVersionById]
  );

  // starfix2 T4：主干刻度渲染入口——scene.ruler 再过一道同桶键严格去重（Set 保序取首现，
  // graphEvents.dedupeTicksByDate）。scene 入口已有 dedupeEventGroupsByDate 源头并组，但
  // 用户实测主干竖轴仍连续出现同日多标签——渲染侧不再信任上游数组：主干里程碑标签、
  // 标签步长、司辰锚 y、日期卡锚 y、panToDate/拖放命中 y 全部消费这一份 trunkTicks，
  // 同一日期在主干轴上恒恰好 1 个刻度/标签（11-13/11-14 连续重复的渲染侧根除）
  const trunkTicks = useMemo(
    () => compressEmptyRulerGaps(dedupeTicksByDate(scene.ruler)),
    [scene.ruler]
  );

  // 司辰时光沉淀曲线：与 trunkTicks 1:1 索引对齐，自底（最早）向顶（最新）累积
  const trunkAccumulation = useMemo(
    () => computeTrunkAccumulation(trunkTicks),
    [trunkTicks]
  );
  const accumulationSummary = useMemo(
    () => activeAccumulationSummary(trunkTicks, trunkAccumulation, scene.activeDate),
    [trunkTicks, trunkAccumulation, scene.activeDate]
  );

  // 有事件的真实日期按时间升序排列（最旧 → 最新），供「时光流转」重演与前/后日步进消费
  const chronologicalActiveDates = useMemo(() => {
    const dated = scene.days
      .map((d) => d.date)
      .filter((d) => Boolean(d));
    return [...dated].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }, [scene.days]);

  // 主干几何（全画布唯一时间轴的骨架）：随 main_hub 拖动更新
  const mainHubPos = nodePositions.main_hub || DEFAULT_NODE_POSITIONS.main_hub;
  const trunkX = mainHubPos.x + 62;
  const trunkStartY = mainHubPos.y + 74;
  const trunkEndY = 710;
  // C1④：里程碑纵轴（轴顶/轴底各留 36px 呼吸位；总高 532 也是日期标注步长的 perDay 基数）
  const TRUNK_AXIS_TOP = trunkStartY + TRUNK_AXIS_PAD;
  const TRUNK_AXIS_BOTTOM = trunkEndY - TRUNK_AXIS_PAD;
  // C2：司辰恒锚定主干左侧（x 不漂移）；纵向 y 渲染期恒等派生（tf_1/B1 契约A）——
  // 非拖拽帧一律贴 activeDate 命中的里程碑刻度（idx<0（日期待考/未命中）落轴顶=最新端；
  // ruler 空回退旧默认 y），拖拽期间读 nodePositions 跟手、松手立即回吸派生值。
  // 徽标 epochLabel 与本 y 同帧同源（同一 activeDate），不再存在「徽标写 A 日、本体悬在 B 高度」的帧。
  // starfix2 T4：索引/长度取 trunkTicks（去重序列），与主干渲染同一份序——司辰悬空高度恒压在画出来的那枚刻度上
  const chronosIdx = trunkTicks.findIndex((t) => t.date === scene.activeDate);
  const chronosPos = {
    x: trunkX + CHRONOS_TRUNK_DX,
    y:
      activeDraggingNodeId === 'chronos_deity'
        ? (nodePositions.chronos_deity?.y ?? DEFAULT_NODE_POSITIONS.chronos_deity.y)
        : trunkTicks.length > 0
          ? milestoneY(
              chronosIdx >= 0 ? chronosIdx : 0,
              trunkTicks.length,
              TRUNK_AXIS_TOP,
              TRUNK_AXIS_BOTTOM
            )
          : DEFAULT_NODE_POSITIONS.chronos_deity.y,
  };

  // C3：平移钳制的用户空间下界 = trunkX - 170（固定文字组锚点），随 main_hub 拖动更新
  useEffect(() => {
    minSafeUserXRef.current = Math.max(0, trunkX + FIXED_TEXT_TRUNK_DX);
  }, [trunkX]);

  // tf_1/B1（契约A）：旧「司辰 y 随 activeDate 的 setNodePositions 同步 effect」已删除——
  // y 改为渲染期派生（见上方 chronosPos），杜绝存储态残留（切布局/重置后闪回旧默认高度的缺口）。
  // nodePositions.chronos_deity 的写路径（拖拽/布局切换）保留，但仅拖拽帧被读取。

  // T02 标尺辅助量：当日最大事件数（驱动里程碑光点大小）与日期标注步长（按密度取 ≥30px 间隔；
  // perDay 基数 = 主干里程碑纵轴高度 532 = TRUNK_AXIS_BOTTOM(674) - TRUNK_AXIS_TOP(142)）。
  // starfix2 T4：两者同源 trunkTicks（去重序列）——步长的 index 口径与渲染序列一致
  const rulerMaxCount = useMemo(
    () => trunkTicks.reduce((max, t) => Math.max(max, t.count), 0),
    [trunkTicks]
  );
  const rulerLabelStep = useMemo(() => {
    const n = trunkTicks.length;
    if (n <= 1) return 1;
    const perDay = 532 / (n - 1);
    return [1, 2, 3, 5, 7, 10, 14, 30, 60, 90, 180, 365].find(
      (step) => step * perDay >= 30
    ) ?? 365;
  }, [trunkTicks]);

  // starfix2 T2：展开框组头全量措辞（graphEvents.fanOutDayHeaderLine 单一出口）——
  // 「{日期} · 共 {n} 条事件（已合并为 {m} 份活跃文档 · 点击查看全天 →）」，
  // n=当日事件总数（active.count 真实总数）、m=合并后活跃文档数（active.cards.length，
  // 同日同文件合并/同基名并组后每卡一份活跃文档）；「⑃」前缀在此拼接（收起态保留）。
  // 渲染按 FANOUT_DAY_HEADER_TAIL 切双色 tspan，不再做任何截断
  const fanOutHeaderLine =
    scene.hasRealEvents && scene.active
      ? `⑃ ${fanOutDayHeaderLine(scene.active.label, scene.active.count, scene.active.cards.length)}`
      : '⑃ 扇出 · 暂无事件卡片';
  // T03：当前标尺粒度（上层状态优先，缺省回退场景自带粒度；空场景为 day）
  const rulerGranularity: EventDayGranularity = granularity ?? scene.granularity ?? 'day';

  // 1.2：唯一锚点文字——左侧日期汇总卡已承载的日期集合，主干刻度的日期文本自动让位
  // （每个日期全画布至多 1 处文字；判定逻辑见 trunkTickShowsLabel，单测覆盖）
  const navigatorDateSet = useMemo(
    () => new Set(scene.navigator.map((nav) => nav.date)),
    [scene.navigator]
  );

  // 3.1：当前选中日期命中的主干刻度 y（用户空间）——主干→右栏电流脉冲的起点
  // starfix2 T4：命中索引同源 trunkTicks（去重序列），与渲染刻度 y 恒一致
  const activeTickY = useMemo(() => {
    if (!scene.hasRealEvents || !scene.activeDate || trunkTicks.length === 0) return null;
    const idx = trunkTicks.findIndex((t) => t.date === scene.activeDate);
    if (idx < 0) return null;
    return milestoneY(idx, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM);
  }, [scene, trunkTicks, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM]);

  // 3.2：弹簧交错展开的触发键——日期切换 / 扇出收起态 / 布局切换时子卡重挂一次，动画从头播放
  const springRevealKey = `${scene.activeDate ?? 'none'}|${isFanOutCollapsed ? 'c' : 'e'}|${canvasLayoutMode}`;

  // 真实事件卡片：占用既有 8 个布局槽位；starfix2 T1 起卡面改四行层级（280x116）。
  // 行1 大字=fileName（documentIdentity.basename 链既有产物，目录前缀不再拼名前——
  //   dirPrefix 降级行2 前缀 + hover title）；行1 右=versionSpan 胶囊
  //   （versionSpanCapsule 单一出口：合并卡 v6 → v8 (2次)、modified v7 → v8、appeared 新出现 vN，
  //   版本号仍由 revisionId → FileRecord.revisions[].versionNumber 查表解析，杜绝伪造）；
  // 行2=pkgPath（taskPackageOf(relative_path).id 所属专项路径）；
  // 行3=digestLine（canvasChangeDigestLine 章节拼接+描述 / appeared=extractCoreSummary 正文核心结论）；
  // 行4 左=packageStage（stageOfPath）右=+N/-M行 · HH:MM（changeCounts + observedClock）。
  const realEventCards: SubAgentCardModel[] | null = useMemo(() => {
    if (!scene.hasRealEvents || !scene.active) return null;
    return scene.active.cards.map((card: CanvasEventCard, cardIdx: number) => {
      const file = files.find((f) => f.file_id === card.fileId);
      let changeLabel = '';
      let versionSpan = '';
      if (card.mergedDay) {
        // wf_2：同 file_id 同日合并卡——changeLabel 保持 DoD2 逐字口径（hover/其他消费方）；
        // 卡面行1 右胶囊走 starfix2 新措辞（versionSpanCapsule：v6 → v8 (2次)）
        changeLabel = dayMergeLabel(card.mergedDay);
        versionSpan = versionSpanCapsule({ merged: card.mergedDay });
      } else if (card.revisionId && !card.decisionId && file) {
        const revIdx = file.revisions.findIndex((r) => r.revision_id === card.revisionId);
        if (revIdx >= 0) {
          const vn = file.revisions[revIdx].versionNumber;
          if (card.kind === 'modified') changeLabel = vn <= 1 ? 'v1' : `v${vn - 1} → v${vn}`;
          else if (card.kind === 'appeared') changeLabel = `新出现 v${vn}`;
          versionSpan = versionSpanCapsule({ kind: card.kind, version: vn });
        }
      }
      // starfix T6：「检测到更新」（modified）类事件卡直出 1-2 行核心变更摘要。
      // changedSections 两条既有链取一：事件表（TimelineEvent.changedSections，payload
      // changed_sections）优先，缺失回退版本链（Revision.changedSectionsFromPrev）；
      // +/- 行数 T5 起优先取事件表结构化真值（TimelineEvent.addedLines/removedLines，
      // payload 直映），缺失回退服务端 detail 定式「（+N/-M 行）」——都缺即 null，不伪造。
      // 非 modified 卡不做派生（appeared/决策卡无 diff 链，硬套就是编造）；
      // 跨目录拷贝并组卡（mergedCount>1）也不做——行3 保留「×N 样本内同基名拷贝」
      // 诚实计数前缀 headline，被摘要替换会丢并组信息。
      let changeSummary = '';
      let changeCounts: { added: number; removed: number } | null = null;
      let digestLine = '';
      if (card.kind === 'modified' && !card.mergedCount) {
        const ev = card.eventId ? events.find((e) => e.event_id === card.eventId) : undefined;
        const changedSections =
          ev?.changedSections ??
          file?.revisions.find((r) => r.revision_id === card.revisionId)?.changedSectionsFromPrev;
        const derived = deriveCanvasChangeSummary({
          changedSections,
          detail: ev?.detail,
          // T5：结构化行数随事件表直入——章节变更卡的 +/- 不再只能靠 detail 定式兜底；
          // changedSections 落版本链回退时 ev 可能无行数 → undefined → 摘要层自行兜底
          addedLines: ev?.addedLines,
          removedLines: ev?.removedLines,
        });
        changeSummary = derived.description;
        changeCounts = derived.counts;
        // starfix2 T1 行3：章节名拼接 + 一句描述（严禁只写 +1/-1 行充当摘要——
        // 行数在行4 右承载）；无章节且无描述时空串回退 detail headline（诚实呈现）
        digestLine = polishEventCardDigestLine({
          changedSections,
          description: derived.description,
          format: card.format ?? file?.format ?? null,
          counts: derived.counts,
        });
      } else if (card.kind === 'appeared' && file && !card.mergedCount) {
        // starfix2 T1 行3（appeared）：新出现文件展示正文第一句核心结论——
        // extractCoreSummary 既有回退链（显式结论章节→逐章节→原文首段→summaryNote），
        // 压完 ≤80 字；拿不到正文返回空串回退 headline，绝不拿文件属性冒充结论
        digestLine = extractCoreSummary(file);
      }
      // wf_2：任务包 chip（DoD1 逐字：任务包名 + 核心文档名，行首不再裸显截断前缀路径）
      const pkg = file ? taskPackageOf(file.relative_path) : null;
      const isBaselineCard = !card.fileId && (card.fileName === '-' || card.fileName === '—' || !card.fileName.trim());
      const resolvedFileName = isBaselineCard ? '工作区基线' : card.fileName;
      // 任意历史日展开时都从 sub_01 起顺排（行1列1起贴近主干），避免跨日累积 slotCursor 把单卡历史日推去右下角
      const normalizedSlotId = `sub_0${(cardIdx % 8) + 1}`;
      return {
        id: normalizedSlotId,
        fileId: card.fileId,
        decisionId: card.decisionId ?? undefined,
        eventId: card.eventId,
        revisionId: card.revisionId,
        fileName: resolvedFileName,
        dirPrefix: card.dirPrefix,
        changeLabel,
        // starfix2 T1：行1 右版本跨度胶囊 / 行2 所属专项路径（taskPackageOf 链）/
        // 行3 内容摘要 / 行2 回退词（决策等无文件事件透出事件类型界面词）
        versionSpan,
        pkgPath: pkg?.id === '__root__' ? '根目录' : (pkg?.id ?? ''),
        digestLine,
        kindLabel: isBaselineCard ? '' : card.kindLabel,
        packageName: pkg?.name,
        packageStage: file ? stageOfPath(file.relative_path) : undefined,
        cornerLabel: card.cornerLabel,
        observedClock: card.observedClock,
        detail: card.detail,
        // starfix T6：核心变更摘要直出（modified 卡；无可诚实透出时为空串回退 headline）
        changeSummary,
        changeCounts,
        format: card.format ?? 'md',
        formatNeutral: card.format == null,
        roleLabel: card.roleLabel,
        peakMetric: `${card.refs}`,
        peakSub: `${card.versions} 个版本 · ${card.statements} 条陈述`,
        secondaryMetric: card.decisionId ? '决策' : card.format ? card.format.toUpperCase() : '—',
        secondarySub: card.cornerLabel,
        activityStats: {
          mdChanges: card.refs,
          svgNodes: card.versions,
          pdfRefs: card.statements,
          decisionLinks: card.decisionId ? 1 : 0,
        },
        outputSummary: card.detail,
        timeRange: card.dateLabel,
        // tf_6/F2：选中调光按桶键（组键）比对，与展示用 dateLabel 分离——
        // observed 口径与周/月桶下本组卡不再因键格式不同被误降透明度
        timeBucket: card.bucketDate,
      };
    });
  }, [scene, files, events]);

  // 真实事件卡片就绪时占用既有 8 个布局槽位；缺失/加载中时为空数组，画布展示空态
  const subAgentCards: SubAgentCardModel[] = realEventCards ?? [];

  // v0.3: 左侧 Sources 四个入口指向真实文件（决策 / SVG / 方案 / 需求）
  // v0.4 第二轮：事件模式下改为「最近四个日期」的导航入口
  const sourceFileNodes: LeftSourceNodeModel[] = useMemo(() => {
    const pick = (
      predicate: (f: FileRecord) => boolean
    ): { fileId: string; label: string; badge: CapabilityCode; roundLabel: string; meta: string } => {
      const file = files.find(predicate);
      if (!file) {
        return {
          fileId: '',
          label: '（未发现）',
          badge: 'MD',
          roundLabel: '—',
          meta: '—',
        };
      }
      const rel = file.relative_path.replace(/\\/g, '/');
      const fileName = rel.slice(rel.lastIndexOf('/') + 1);
      const dir = rel.slice(0, Math.max(0, rel.lastIndexOf('/') + 1));
      const shortLabel = `${dir}${fileName.length > 14 ? fileName.slice(0, 12) + '…' : fileName}`;
      const rev =
        file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
        file.revisions[file.revisions.length - 1];
      const kb = ((rev?.sizeBytes || 0) / 1024).toFixed(0);
      const badge: CapabilityCode =
        file.format === 'svg' ? 'SVG' : file.format === 'pdf' ? 'PDF' : file.role === '决策' ? 'DEC' : 'MD';
      return {
        fileId: file.file_id,
        label: shortLabel,
        badge,
        roundLabel: `${file.role} · v${rev?.versionNumber || 1} · ${rev && rev.observed_at ? formatLocalClock(rev.observed_at) : '—'}`,
        meta: `${kb} KB · ${rel.split('/').length} 层`,
      };
    };

    const dec = pick((f) => f.format === 'md' && f.role === '决策');
    const svg = pick((f) => f.format === 'svg');
    const plan = pick((f) => f.format === 'md' && f.role === '方案');
    const req = pick((f) => f.format === 'md' && f.role === '需求');

    const badgeShort: Record<CapabilityCode, string> = {
      MD: 'I',
      DEC: 'R',
      REV: 'S',
      SVG: 'A',
      TIM: 'M',
      PDF: 'C',
      REL: 'H',
    };

    return [
      {
        id: 'src_round15',
        fileId: dec.fileId,
        badge: dec.badge,
        shortBadge: badgeShort[dec.badge],
        label: dec.label,
        tokOrMeta: dec.meta,
        roundLabel: dec.roundLabel,
        yOffset: 146,
        targetTrunkY: 174,
        timeBucket: '2:00',
      },
      {
        id: 'src_svg_engine',
        fileId: svg.fileId,
        badge: svg.badge,
        shortBadge: badgeShort[svg.badge],
        label: svg.label,
        tokOrMeta: svg.meta,
        roundLabel: svg.roundLabel,
        yOffset: 146,
        targetTrunkY: 174,
        timeBucket: '1:00',
      },
      {
        id: 'src_four_spec',
        fileId: plan.fileId,
        badge: plan.badge,
        shortBadge: badgeShort[plan.badge],
        label: plan.label,
        tokOrMeta: plan.meta,
        roundLabel: plan.roundLabel,
        yOffset: 214,
        targetTrunkY: 248,
        timeBucket: '2:00',
      },
      {
        id: 'src_receipt',
        fileId: req.fileId,
        badge: req.badge,
        shortBadge: badgeShort[req.badge],
        label: req.label,
        tokOrMeta: req.meta,
        roundLabel: req.roundLabel,
        yOffset: 432,
        targetTrunkY: 462,
        timeBucket: '1:00',
      },
    ];
  }, [files]);

  // v0.4 第二轮：事件模式下，左侧四个浮动节点变成「最近四个日期」的导航
  const leftSourceNodes: LeftSourceNodeModel[] = useMemo(() => {
    if (!scene.hasRealEvents || scene.navigator.length === 0) return sourceFileNodes;
    const short: Record<CapabilityCode, string> = {
      MD: 'I', DEC: 'R', REV: 'S', SVG: 'A', TIM: 'M', PDF: 'C', REL: 'H',
    };
    const ids = ['src_round15', 'src_svg_engine', 'src_four_spec', 'src_receipt'];
    // tf_2/B2+B4（契约B）：锚刻度 y 与默认位运行时派生（随 main_hub 拖动重算），不再用旧逐日硬编码
    // 146/146/214/432（yOffsets，死变量）与 targetTrunkY [174,174,248,462]；
    // 待考桶（ruler 无此键）锚位=轴底下方 18px 的 off-timeline 槽位，不指任何日期刻度。
    // starfix2 T4：锚 y 取 trunkTicks（去重序列）——连线终点恒落在画出来的那枚刻度上
    const navAnchorYs = scene.navigator.map((nav) => {
      const idx = trunkTicks.findIndex((t) => t.date === nav.date);
      return idx >= 0
        ? milestoneY(idx, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM)
        : TRUNK_AXIS_BOTTOM + 18;
    });
    // 默认 y = 锚刻度 y − 24（卡片高 50：连线起点 pos.y+24 对齐锚刻度）；密集时按序向下顺延、间隙≥56，只向下不向上挤
    const navDefaultYs: number[] = [];
    scene.navigator.forEach((_, i) => {
      const y0 = navAnchorYs[i] - 24;
      navDefaultYs.push(i === 0 ? y0 : Math.max(y0, navDefaultYs[i - 1] + 56));
    });
    return scene.navigator.map((nav, i) => {
      // T06：徽章读真实格式计数最高者（nav.formats），无可判定格式时落 TIM 中性——
      // 此前把事件种类当格式推导，种类永不等于 svg/pdf，导航器恒显回退值 MD
      const badge: CapabilityCode =
        nav.format === 'svg'
          ? 'SVG'
          : nav.format === 'pdf'
            ? 'PDF'
            : nav.format === 'md'
              ? 'MD'
              : 'TIM';
      const sortedFormats = Object.entries(nav.formats || {}).sort((a, b) => b[1] - a[1]);
      // 「MD×12 · SVG×5」格式计数摘要（放进完整 tooltip，卡面只留简洁主格式徽标防止截断成 MJ...）
      const formatSummary = sortedFormats
        .map(([f, c]) => `${f.toUpperCase()}×${c}`)
        .join(' · ');
      const topFormat = sortedFormats[0]?.[0]?.toUpperCase();
      const latestNavYear = scene.navigator[0]?.date?.slice(0, 4) ?? '';
      const compactNavLabel =
        /^\d{4}-\d{2}-\d{2}$/.test(nav.label) && latestNavYear && nav.label.startsWith(`${latestNavYear}-`)
          ? nav.label.slice(5)
          : nav.label;
      const accumEntry = trunkAccumulation.find((a) => a.date === nav.date);
      const grainLevel = accumEntry
        ? Math.max(1, Math.min(5, Math.round(accumEntry.strataIntensity * 5)))
        : Math.max(1, Math.min(5, Math.ceil(Math.log1p(nav.count))));
      return {
        id: ids[i] || `src_date_${i}`,
        fileId: '',
        date: nav.date,
        badge,
        shortBadge: short[badge],
        label: compactNavLabel,
        tokOrMeta: `${nav.count} 变动`,
        dominantFormat: topFormat,
        grainLevel,
        cumulativeEvents: accumEntry?.cumulativeEvents,
        fullMetaTooltip: `${nav.label} · ${nav.count} 条记录${
          accumEntry ? ` · 截至当日累计沉淀 ${accumEntry.cumulativeEvents} 条` : ''
        }${formatSummary ? ` · ${formatSummary}` : ''}`,
        roundLabel: nav.date ? `日期 ${nav.date}` : '日期待考',
        // yOffset/targetTrunkY：演示模式保留旧默认值；事件模式改派生——
        // targetTrunkY=锚刻度 y（连线终点），yOffset=默认纵向位（节点渲染回退用），见契约B
        yOffset: navDefaultYs[i] ?? 0,
        targetTrunkY: navAnchorYs[i] ?? TRUNK_AXIS_BOTTOM + 18,
        timeBucket: nav.date,
      };
    });
  }, [scene, trunkTicks, trunkAccumulation, sourceFileNodes, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM]);

  // tf_2/B2+B3（契约B）：导航卡位置解析——nodePositions 仍优先（用户拖拽/力导向/星环都产出新对象引用），
  // 但重置与切回 x-ray 写回的是 DEFAULT_NODE_POSITIONS 的同一对象引用（{...DEFAULT_NODE_POSITIONS} 浅拷贝），
  // 视同未拖拽 → 默认位回派生值（事件模式=锚刻度 y−24，见 leftSourceNodes 的 yOffset），
  // 保证「布局重置/切回 x-ray 后回到派生默认」；演示模式（date undefined）回退旧默认，行为不变
  const resolveLeftSourcePos = (
    src: LeftSourceNodeModel
  ): { x: number; y: number } => {
    const storedPos = nodePositions[src.id];
    const baseDefault = DEFAULT_NODE_POSITIONS[src.id];
    if (storedPos && storedPos !== baseDefault) return storedPos;
    if (src.date !== undefined && baseDefault) {
      // 1.2：日期卡恒落在独立左侧轨道（离主干 ≥120px、离司辰立绘 ≥16px），
      // 随 main_hub 拖动实时重算；用户拖过卡则走上面的 storedPos 分支，拖拽交互不回退
      return { x: dateCardRailX(trunkX), y: src.yOffset };
    }
    return storedPos || baseDefault;
  };

  // Sync selectedFileId with subAgentCards
  useEffect(() => {
    const matched = subAgentCards.find((c) => c.fileId === selectedFileId);
    if (matched && selectedCanvasNodeId !== 'main_hub' && selectedCanvasNodeId !== 'chronos_deity') {
      setSelectedCanvasNodeId(matched.id);
    }
  }, [selectedFileId, subAgentCards, selectedCanvasNodeId]);

  // C7②：选中校正——subAgentCards 变化后，selectedCanvasNodeId 不在卡 id 集
  // （且不是 main_hub/chronos_deity）时落到第一张卡；无卡 → ''。
  // 杜绝「右栏显示 A、画布无选中高亮」与换日后选中残留
  useEffect(() => {
    if (subAgentCards.length === 0) {
      if (selectedCanvasNodeId !== '') setSelectedCanvasNodeId('');
      return;
    }
    if (
      selectedCanvasNodeId !== 'main_hub' &&
      selectedCanvasNodeId !== 'chronos_deity' &&
      !subAgentCards.some((c) => c.id === selectedCanvasNodeId)
    ) {
      setSelectedCanvasNodeId(subAgentCards[0].id);
    }
  }, [subAgentCards, selectedCanvasNodeId]);

  // C3：stage 容器宽度 + 高度（选中卡→叙事抽屉电流连线 / R5 小地图 viewport 折算用）
  // 必须依赖 visible：隐藏保活期（visible=false）stageRef 为 null，切入星图时需立刻测量并挂 ResizeObserver
  useEffect(() => {
    if (!visible) return;
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      setStageWidth(el.clientWidth);
      setStageHeight(el.clientHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // R4②：指针态下首次挂载不再重置视图——工具切换重挂 zoom 行为时跳过初始 transform，
  // 否则切一次指针/抓手画布就闪回默认位（zoomInitializedRef 单次守卫）
  const zoomInitializedRef = useRef(false);

  // Configure D3 Zoom on the SVG element（必须依赖 visible：首次隐藏挂载时 svgRef 为 null，显露后重挂并还原当前 transform）
  useEffect(() => {
    if (!visible) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.45, 2.2])
      // C3③ 硬保证绝不压住面板：可视原点 x 永远 ≥ SAFE_LEFT - k*MIN_SAFE_USER_X，
      // 即用户空间 x=MIN_SAFE_USER_X（固定文字组锚点）的屏幕位置不得进入面板带
      .constrain((t) => {
        const minX = SOURCES_PANEL_SAFE_LEFT - t.k * minSafeUserXRef.current;
        return t.x < minX ? new d3.ZoomTransform(t.k, minX, t.y) : t;
      })
      .filter((event: any) => {
        // R4②：wheel 缩放恒放行；指针态禁拖拽平移（点选节点优先），抓手态才放行 drag-pan
        if (event.type === 'wheel') return true;
        if (canvasTool !== 'pan') return false;
        const target = event.target as HTMLElement | null;
        if (!target) return true;
        if (
          target.closest('.d3-draggable-node') ||
          target.closest('.d3-no-pan')
        ) {
          return false;
        }
        return !event.button;
      })
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        // perf：zoom 事件每帧触发，直写 zoomLayer 与屏幕空间 Overlay 坐标，零 React 整树重渲；
        // 同步刷新 zoomExactRef 与 180ms 兜底落定，防止 D3 过渡被打断后 state 长期滞留旧缩放比
        const { x, y, k } = event.transform;
        const zoomLayer = zoomLayerRef.current;
        if (zoomLayer) {
          zoomLayer.setAttribute('transform', `translate(${x}, ${y}) scale(${k})`);
        }
        notifyZoomFrame({ x, y, k });
        if (zoomSettleTimerRef.current !== null) {
          clearTimeout(zoomSettleTimerRef.current);
        }
        zoomSettleTimerRef.current = setTimeout(() => {
          zoomSettleTimerRef.current = null;
          commitZoomState(zoomExactRef.current);
        }, 180);
      })
      .on('end', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        // gesture end 落定 React state（小地图 viewport、缩放百分比、LOD 档位）并取消兜底计时器
        if (zoomSettleTimerRef.current !== null) {
          clearTimeout(zoomSettleTimerRef.current);
          zoomSettleTimerRef.current = null;
        }
        const { x, y, k } = event.transform;
        notifyZoomFrame({ x, y, k });
        commitZoomState({ x, y, k });
      });

    zoomBehaviorRef.current = zoomBehavior;
    const svgSelection = d3.select(svgEl);
    svgSelection.call(zoomBehavior);
    if (!zoomInitializedRef.current) {
      zoomInitializedRef.current = true;
      // R3①：默认收起态初始 transform 贴窄条右缘（与 zoomTransform useState 初值同源）；
      // starfix T4：默认缩放 100%（真实机位由「聚焦展开节点」effect 随后运镜修正）
      svgSelection.call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(SOURCES_PANEL_COLLAPSED_LEFT, 48).scale(1)
      );
    } else {
      // 从隐藏切回或切换工具时，同步恢复 d3 内部 transform 状态。
      // D04：恢复值取 zoomExactRef（最后一次手势的全精度），量化 state 只作展示——
      // 阅读器往返后画布平移/缩放零漂移（任务卡 D04「视口坐标与缩放比丝毫不差」）。
      const exact = zoomExactRef.current;
      svgSelection.call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(exact.x, exact.y).scale(exact.k)
      );
    }

    return () => {
      svgSelection.on('.zoom', null);
      if (zoomSettleTimerRef.current !== null) {
        clearTimeout(zoomSettleTimerRef.current);
        zoomSettleTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomTransform 仅在重挂载/切回时用于还原一次
  }, [canvasTool, visible]);

  // transform 属性已去 React 托管（JSX 不再写 transform），改由本 effect 在挂载/显露时写一次
  // 初始变换：layoutEffect 在首帧绘制前落定，不闪回原点；此后该属性只由 zoom 事件直写。
  // D04：显露时写全精度 ref 值（量化值仅展示面），随后 zoom 行为恢复分支同样全精度。
  useLayoutEffect(() => {
    if (!visible) return;
    const zoomLayer = zoomLayerRef.current;
    if (!zoomLayer) return;
    const exact = zoomExactRef.current;
    zoomLayer.setAttribute(
      'transform',
      `translate(${exact.x}, ${exact.y}) scale(${exact.k})`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载/显露时落定一次
  }, [visible]);

  // ② 视图设置弹层：底部工具条的 x-ray/力导向/星环三钮与流式粒子/流星雨/X-Ray 三开关收拢于此
  const [isViewSettingsOpen, setIsViewSettingsOpen] = useState(false);

  // ④ 司辰时间机器摘要气泡：拖到「有事件的标尺刻度」松手弹出，8s 自动清除，点击选中该日
  const [chronosDropSummary, setChronosDropSummary] = useState<{
    date: string;
    count: number;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const chronosDropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 拖拽行为只在布局类依赖变化时重挂载，end 回调经 ref 读最新场景/事件/主干轴，避免闭包读到旧值
  const chronosDropContextRef = useRef<{
    scene: CanvasEventScene;
    events: TimelineEvent[];
    eventDays: EventDaysResult | null;
    axisTop: number;
    axisBottom: number;
  }>({ scene, events, eventDays, axisTop: TRUNK_AXIS_TOP, axisBottom: TRUNK_AXIS_BOTTOM });
  useEffect(() => {
    chronosDropContextRef.current = {
      scene,
      events,
      eventDays,
      axisTop: TRUNK_AXIS_TOP,
      axisBottom: TRUNK_AXIS_BOTTOM,
    };
  });
  useEffect(
    () => () => {
      if (chronosDropTimerRef.current !== null) {
        clearTimeout(chronosDropTimerRef.current);
        chronosDropTimerRef.current = null;
      }
    },
    []
  );

  /** ④ 拖放落点反解主干里程碑并吸附至该日 + 弹出当天 headline 摘要（与 trunkTicks 压缩序列 1:1 对齐） */
  const showChronosDropSummary = (dragEvent: d3.D3DragEvent<SVGGElement, unknown, unknown>) => {
    const svgEl = svgRef.current;
    // 与渲染主干同源：compressEmptyRulerGaps(dedupeTicksByDate(scene.ruler))
    const rulerTicks = compressEmptyRulerGaps(
      dedupeTicksByDate(chronosDropContextRef.current.scene.ruler)
    );
    if (!svgEl || rulerTicks.length === 0) return;

    const [pointerX, pointerY] = d3.pointer(dragEvent.sourceEvent, svgEl);
    const transform = d3.zoomTransform(svgEl);
    const k = transform.k || 1;
    const pointerLocalY = (pointerY - transform.y) / k;
    const { axisTop, axisBottom } = chronosDropContextRef.current;
    const total = rulerTicks.length;
    let nearestIdx = -1;
    let nearestDist = Number.POSITIVE_INFINITY;
    rulerTicks.forEach((tick, i) => {
      if (tick.isTruncation || tick.isGap || !tick.hasEvents) return;
      const dist = Math.abs(milestoneY(i, total, axisTop, axisBottom) - pointerLocalY);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    });
    const tick = rulerTicks[nearestIdx];
    if (!tick || tick.isTruncation || tick.isGap || !tick.hasEvents) return;

    // 拖放司辰即直达该日：时间轴高亮、司辰回吸落位、右侧当日变动文档立即展开
    selectDateInternal(tick.date, { pan: false });

    // tf_6/F3：锚日按当前时间口径（eventDays.order）取值——observed=采集日、occurred=材料记载日
    // （source_time=occurred_at 的透出，project.ts）；occurred 口径下无 occurred 的事件
    // （source_time 空）不匹配任何刻度（与「待考不进轴」一致），不再串显其他日期采集的事件
    const dropOrder = chronosDropContextRef.current.eventDays?.order ?? 'occurred';
    const tickEvents = chronosDropContextRef.current.events.filter((item) =>
      eventMatchesRulerTick(
        dropOrder === 'observed'
          ? localDay(item.observed_at || '')
          : item.source_time
            ? localDay(item.source_time)
            : '',
        tick
      )
    );
    const headlines = tickEvents.map((item) => item.headline).filter(Boolean);
    // 事件分页窗口（events prop）未必覆盖该刻度（时间机器常去的旧日期）：headline 为空时退回按日聚合样本
    if (headlines.length === 0) {
      const dayGroup = chronosDropContextRef.current.eventDays?.groups.find(
        (g) => g.date === tick.date
      );
      for (const sample of dayGroup?.samples ?? []) {
        if (headlines.length >= 3) break;
        if (sample.headline) headlines.push(sample.headline);
      }
    }
    const text =
      headlines.slice(0, 3).join('；') +
      (headlines.length > 3 ? ` 等 ${headlines.length} 条` : '');

    if (chronosDropTimerRef.current !== null) clearTimeout(chronosDropTimerRef.current);
    chronosDropTimerRef.current = setTimeout(() => {
      setChronosDropSummary(null);
      chronosDropTimerRef.current = null;
    }, 8000);
    setChronosDropSummary({
      date: tick.date,
      count: tick.count,
      text,
      x: pointerX,
      y: pointerY,
    });
  };

  // Configure D3 Drag on all `.d3-draggable-node` SVG groups
  // perf：drag 用 rAF 节流合并——pointermove 一帧可触发多次，此前每事件一次
  // setNodePositions 都拉整树 reconcile。节点位移不能像 zoom 那样纯直写节点 transform：
  // 连线（computeDynamicEdgePath）、扇出盒（fanOutBounds）、主干几何（trunkX）与司辰
  // 跟手位全部派生自 nodePositions state，只直写节点会连线脱节；故保留状态更新、
  // 把一帧内多批增量并成每帧≤1 次 setState（增量先入 ref，flush 时一次落库）。
  const dragRafRef = useRef<number | null>(null);
  const dragDeltasRef = useRef<Map<string, { dx: number; dy: number }>>(new Map());
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const flushDragDeltas = () => {
      dragRafRef.current = null;
      const deltas = dragDeltasRef.current;
      if (deltas.size === 0) return;
      const batch = Array.from(deltas.entries());
      deltas.clear();
      setNodePositions((prev) => {
        const next = { ...prev };
        for (const [dragNodeId, delta] of batch) {
          if (dragNodeId === 'fan_out_box') {
            Object.keys(next).forEach((k) => {
              if (k.startsWith('sub_')) {
                next[k] = {
                  x: Math.round(next[k].x + delta.dx),
                  y: Math.round(next[k].y + delta.dy),
                };
              }
            });
          } else if (dragNodeId === 'chronos_deity') {
            // C2：司辰锚定主干（x 恒等于 trunkX+CHRONOS_TRUNK_DX），拖拽只吃 dy 上下滑动，x 不漂移
            const curr = next[dragNodeId] || { x: 0, y: 0 };
            next[dragNodeId] = {
              x: curr.x,
              y: Math.round(curr.y + delta.dy),
            };
          } else {
            const curr = next[dragNodeId] || { x: 0, y: 0 };
            next[dragNodeId] = {
              x: Math.round(curr.x + delta.dx),
              y: Math.round(curr.y + delta.dy),
            };
          }
        }
        return next;
      });
    };

    const dragBehavior = d3
      .drag<SVGGElement, unknown>()
      .on('start', function (event) {
        event.sourceEvent?.stopPropagation?.();
        const nodeId = this.getAttribute('data-node-id');
        if (nodeId) {
          setActiveDraggingNodeId(nodeId);
          setHoveredPreviewAnchor(null);
        }
      })
      .on('drag', function (event) {
        const nodeId = this.getAttribute('data-node-id');
        if (!nodeId) return;
        const deltas = dragDeltasRef.current;
        const pending = deltas.get(nodeId) || { dx: 0, dy: 0 };
        deltas.set(nodeId, { dx: pending.dx + event.dx, dy: pending.dy + event.dy });
        if (dragRafRef.current === null) {
          dragRafRef.current = requestAnimationFrame(flushDragDeltas);
        }
      })
      .on('end', function (event) {
        // 松手同步冲刷残留增量（cancel 已排的 rAF，直接落库），终位不丢最后一帧位移
        if (dragRafRef.current !== null) {
          cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = null;
        }
        flushDragDeltas();
        setActiveDraggingNodeId(null);
        // ④ 司辰拖到有事件的标尺刻度松手 → 当天 headline 摘要气泡
        if (this.getAttribute('data-node-id') === 'chronos_deity') {
          showChronosDropSummary(event);
        }
      });

    const nodeSelection = d3
      .select(svgEl)
      .selectAll<SVGGElement, unknown>('.d3-draggable-node');
    nodeSelection.call(dragBehavior);

    return () => {
      nodeSelection.on('.drag', null);
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      dragDeltasRef.current.clear();
    };
  }, [isFanOutCollapsed, hiddenCategories, canvasLayoutMode, chronosSliderOpen]);

  // Switch between X-Ray Curated Layout, D3 Force-Directed Layout, and D3 Radial Orbit Layout
  const handleToggleLayoutMode = (mode: 'xray' | 'force' | 'radial') => {
    setCanvasLayoutMode(mode);
    if (mode === 'xray') {
      setNodePositions({ ...DEFAULT_NODE_POSITIONS });
      return;
    }

    if (mode === 'radial') {
      const centerX = 435;
      const centerY = 330;
      const radialPositions: NodePositionMap = {
        main_hub: { x: centerX - 75, y: centerY - 38 },
        chronos_deity: { x: 96, y: 245 },
      };

      leftSourceNodes.forEach((s, idx) => {
        const angle = Math.PI * 0.68 + idx * (Math.PI * 0.22);
        radialPositions[s.id] = {
          x: Math.round(centerX + Math.cos(angle) * 215 - 60),
          y: Math.round(centerY + Math.sin(angle) * 215 - 25),
        };
      });

      subAgentCards.forEach((c, idx) => {
        const angle = -Math.PI * 0.52 + idx * ((Math.PI * 1.15) / 7);
        radialPositions[c.id] = {
          x: Math.round(centerX + Math.cos(angle) * 285 - 75),
          y: Math.round(centerY + Math.sin(angle) * 270 - 44),
        };
      });

      setNodePositions(radialPositions);
      return;
    }

    interface ForceSimNode extends d3.SimulationNodeDatum {
      id: string;
      x: number;
      y: number;
      fx?: number;
      fy?: number;
    }

    const simNodes: ForceSimNode[] = Object.entries(DEFAULT_NODE_POSITIONS).map(
      ([id, pos]) => ({
        id,
        x: pos.x,
        y: pos.y,
        ...(id === 'main_hub' ? { fx: 390, fy: 285 } : {}),
        ...(id === 'chronos_deity' ? { fx: 112, fy: 266 } : {}),
      })
    );

    const simLinks: d3.SimulationLinkDatum<ForceSimNode>[] = [
      ...leftSourceNodes.map((s) => ({ source: s.id, target: 'main_hub' })),
      ...subAgentCards.map((c) => ({ source: 'main_hub', target: c.id })),
      { source: 'chronos_deity', target: 'main_hub' },
      { source: 'sub_01', target: 'sub_02' },
      { source: 'sub_02', target: 'sub_03' },
      { source: 'sub_04', target: 'sub_01' },
      { source: 'sub_05', target: 'sub_02' },
    ];

    const sim = d3
      .forceSimulation<ForceSimNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink<ForceSimNode, d3.SimulationLinkDatum<ForceSimNode>>(simLinks)
          .id((d) => d.id)
          .distance(195)
          .strength(0.75)
      )
      .force('charge', d3.forceManyBody().strength(-720))
      .force('collide', d3.forceCollide().radius(108))
      .force('x', d3.forceX(395).strength(0.12))
      .force('y', d3.forceY(310).strength(0.14))
      .stop();

    for (let i = 0; i < 140; i += 1) {
      sim.tick();
    }

    const nextPositions: NodePositionMap = {};
    simNodes.forEach((n) => {
      nextPositions[n.id] = {
        x: Math.round(n.x),
        y: Math.round(n.y),
      };
    });
    setNodePositions(nextPositions);
  };

  const applyProgrammaticZoom = (
    nextScale: number,
    nextPan?: { x: number; y: number },
    durationMs = 260
  ) => {
    const svgEl = svgRef.current;
    const zoomB = zoomBehaviorRef.current;
    const clampedK = Math.min(2.2, Math.max(0.45, Number(nextScale.toFixed(2))));
    const live = zoomExactRef.current;
    const targetX = nextPan ? nextPan.x : live.x;
    const targetY = nextPan ? nextPan.y : live.y;
    const effectiveMs = effectiveMotionDurationMs(durationMs);

    if (svgEl && zoomB) {
      const targetTransform = d3.zoomIdentity.translate(targetX, targetY).scale(clampedK);
      if (effectiveMs <= 0) {
        // D05 prefers-reduced-motion 静态降级：跳过 D3 transition，零补间即时落位
        d3.select(svgEl).call(zoomB.transform, targetTransform);
      } else {
        d3.select(svgEl)
          .transition()
          .duration(effectiveMs)
          .call(zoomB.transform, targetTransform);
      }
    } else {
      // 画布未挂载的回退分支：ref 与量化 state 同步落（ref 不脱节）
      notifyZoomFrame({ x: targetX, y: targetY, k: clampedK });
      commitZoomState({ x: targetX, y: targetY, k: clampedK });
    }
  };

  const zoomByDelta = (delta: number) => {
    applyProgrammaticZoom(zoomExactRef.current.k + delta);
  };

  /** 3.4 平滑运镜时长：与动效基座的 --dur-pan(500ms) 同值（CSS 变量读不进 d3 transition，
   *  这里以常量对齐；改一处须同改 index.css 的 --dur-pan）。 */
  function panToDate(date: string) {
    const stageEl = stageRef.current;
    // starfix2 T4：命中索引同源 trunkTicks（去重序列）——运镜落点恒在渲染出来的那枚刻度上
    if (!stageEl || trunkTicks.length === 0 || stageWidth <= 0) return;
    const idx = trunkTicks.findIndex((t) => t.date === date);
    if (idx < 0) return;
    const stageH = stageEl.clientHeight;
    if (stageH <= 0) return;

    const tickY = milestoneY(idx, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM);
    const k = zoomExactRef.current.k || 1;
    // 保持「左侧日期卡 — 司辰 — 时间主干 — 当日扇出文档」整幅构图居中可见，纵向柔和追随激活刻度
    const triptychLeft = dateCardRailX(trunkX);
    const triptychRight = Math.max(fanOutBounds.x + fanOutBounds.width, trunkX + 640);
    const triptychCx = (triptychLeft + triptychRight) / 2;
    const rawX = stageWidth / 2 - triptychCx * k;
    const usableH = Math.max(240, stageH - 72);
    const rawY = Math.min(48, Math.max(usableH - 740 * k, usableH * 0.42 - tickY * k));
    const safeLeft = sourcesPanelCollapsed
      ? SOURCES_PANEL_COLLAPSED_LEFT
      : SOURCES_PANEL_SAFE_LEFT;
    const minX = safeLeft - k * Math.max(0, triptychLeft - 12);
    applyProgrammaticZoom(
      k,
      { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
      PAN_TRANSITION_MS
    );
  }

  const handleResetCanvasLayout = () => {
    setNodePositions({ ...DEFAULT_NODE_POSITIONS });
    setCanvasLayoutMode('xray');
    setActiveTimeSlice('all');
    // starfix T4：重置=回到默认 100% 缩放，顶部留 48px 呼吸位防裁切
    applyProgrammaticZoom(1, { x: SOURCES_PANEL_SAFE_LEFT, y: 48 });
  };

  // C3：Sources 面板收起/展开——画布可视原点随面板宽度 260ms 动画右移/左移补位，
  // 面板展开时原点锚定 SAFE_LEFT（面板右缘），收起时回退到窄条右侧
  const toggleSourcesPanel = () => {
    const next = !sourcesPanelCollapsed;
    setSourcesPanelCollapsed(next);
    const live = zoomExactRef.current;
    applyProgrammaticZoom(live.k, {
      x: next ? SOURCES_PANEL_COLLAPSED_LEFT : SOURCES_PANEL_SAFE_LEFT,
      y: live.y,
    });
  };

  const cycleChronosTimeSlice = () => {
    setMeteorBurstKey((k) => k + 1);
    // v0.4：事件模式下司辰沿真实日期序列移动（含「日期待考」），而不是演示时段
    if (scene.hasRealEvents && scene.days.length > 0) {
      const current = scene.activeDate;
      const idx = scene.days.findIndex((d) => d.date === current);
      const next = scene.days[(idx + 1) % scene.days.length];
      if (next) selectDate(next.date);
      return;
    }
    setActiveTimeSlice((prev) =>
      prev === 'all'
        ? '2:00'
        : prev === '2:00'
        ? '1:00'
        : prev === '1:00'
        ? '0:00'
        : 'all'
    );
  };

  // 时光步进（-1 = 更早一日，+1 = 更新一日），按真实时间升序移动司辰与展开文档
  const activeChronoIdx = chronologicalActiveDates.indexOf(scene.activeDate ?? '');
  const canStepOlder = chronologicalActiveDates.length > 1 && (activeChronoIdx < 0 || activeChronoIdx > 0);
  const canStepNewer =
    chronologicalActiveDates.length > 1 &&
    activeChronoIdx >= 0 &&
    activeChronoIdx < chronologicalActiveDates.length - 1;

  const stepChronosDay = (delta: -1 | 1) => {
    if (chronologicalActiveDates.length === 0) return;
    const baseIdx = activeChronoIdx >= 0 ? activeChronoIdx : chronologicalActiveDates.length - 1;
    const nextIdx = stepChronosReplayIndex(chronologicalActiveDates, baseIdx, delta, replayUnit);
    const target = chronologicalActiveDates[nextIdx];
    if (target && target !== scene.activeDate) {
      setMeteorBurstKey((k) => k + 1);
      selectDate(target);
    }
  };

  // 「时光流转」重演开关：唤出司辰并从最早沉淀日（或当前停留日）向今日按日/周推进，直观呈现时间流逝与文件累积
  const toggleTimeFlowPlay = () => {
    if (chronologicalActiveDates.length <= 1) return;
    if (isTimeFlowPlaying) {
      setIsTimeFlowPlaying(false);
      return;
    }
    setChronosSliderOpen(true);
    const curIdx = chronologicalActiveDates.indexOf(scene.activeDate ?? '');
    const startIdx =
      curIdx >= 0 && curIdx < chronologicalActiveDates.length - 1 ? curIdx : 0;
    const startDate = chronologicalActiveDates[startIdx];
    setIsTimeFlowPlaying(true);
    if (startDate && startDate !== scene.activeDate) {
      setMeteorBurstKey((k) => k + 1);
      selectDateInternal(startDate, { keepPlaying: true, pan: !prefersReducedMotion });
    }
  };

  useEffect(() => {
    if (!isTimeFlowPlaying || !visible) return;
    if (chronologicalActiveDates.length <= 1) {
      setIsTimeFlowPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      const curIdx = chronologicalActiveDates.indexOf(scene.activeDate ?? '');
      const nextIdx = stepChronosReplayIndex(
        chronologicalActiveDates,
        curIdx >= 0 ? curIdx : 0,
        1,
        replayUnit
      );
      if (nextIdx < 0 || nextIdx === curIdx) {
        setIsTimeFlowPlaying(false);
        return;
      }
      const nextDate = chronologicalActiveDates[nextIdx];
      if (!nextDate) {
        setIsTimeFlowPlaying(false);
        return;
      }
      setMeteorBurstKey((k) => k + 1);
      selectDateInternal(nextDate, { keepPlaying: true, pan: !prefersReducedMotion });
    }, chronosReplayIntervalMs(replaySpeed, prefersReducedMotion));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按激活日、步进粒度、倍速与重演开关逐拍推进
  }, [
    isTimeFlowPlaying,
    visible,
    scene.activeDate,
    chronologicalActiveDates,
    prefersReducedMotion,
    replayUnit,
    replaySpeed,
  ]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleCategoryVisibility = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    setHiddenCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const expandAllSidebar = () => {
    setExpandedGroups({
      MD: true,
      DEC: true,
      REV: true,
      SVG: true,
      TIM: true,
      PDF: true,
      REL: true,
    });
  };

  const collapseAllSidebar = () => {
    setExpandedGroups({
      MD: false,
      DEC: false,
      REV: false,
      SVG: false,
      TIM: false,
      PDF: false,
      REL: false,
    });
  };

  // C7②：精确 find，不再回退第一张卡——右栏与画布选中严格一致；
  // 换日/无选中时为 undefined，由校正 effect 与右栏空态兜底
  const activeSubAgent = useMemo<SubAgentCardModel | undefined>(() => {
    return subAgentCards.find((c) => c.id === selectedCanvasNodeId);
  }, [subAgentCards, selectedCanvasNodeId]);

  const activeFileRecord = useMemo(() => {
    if (selectedCanvasNodeId === 'main_hub') {
      return files[0] ?? null;
    }
    // 单文件工作区或事件卡未绑定文件时，退回第一个文件而不是 undefined
    return (
      files.find((f) => f.file_id === activeSubAgent?.fileId) || files[0] || null
    );
  }, [files, selectedCanvasNodeId, activeSubAgent]);

  const unreadCount = useMemo(() => {
    return files.filter((f) => hasUnreadChanges(f, readingStates[f.file_id]).isUnread).length;
  }, [files, readingStates]);

  // v0.8：右栏检视器退役后 contextRows/activeEventFile/activeEventChangedSections 三 memo
  // 一并退役；「上下文/变更章节/关联文件」内容在 narrativeMemo（下方）按抽屉目标重排为
  // 时间轴叙事分节（发生→变更章节→关联决策→引用依据）。

  const mdFiles = useMemo(() => files.filter((f) => f.format === 'md'), [files]);
  const svgFiles = useMemo(() => files.filter((f) => f.format === 'svg'), [files]);
  const pdfFiles = useMemo(() => files.filter((f) => f.format === 'pdf'), [files]);

  const visibleMdFiles = useMemo(() => {
    return showAllMdSources ? mdFiles : mdFiles.slice(0, 4);
  }, [mdFiles, showAllMdSources]);

  // W08：findings 用真实统计——MD 文件最新版本的变更章节数之和（替代写死的「93 findings」）
  const mdFindingsCount = useMemo(() => {
    return mdFiles.reduce(
      (sum, f) => sum + (f.revisions[f.revisions.length - 1]?.changedSectionsFromPrev?.length ?? 0),
      0
    );
  }, [mdFiles]);

  const fanOutBounds = useMemo(() => {
    const visibleCards = isFanOutCollapsed ? subAgentCards.slice(0, 2) : subAgentCards;
    const boxes = visibleCards.map((c) => {
      const pos = nodePositions[c.id] || DEFAULT_NODE_POSITIONS[c.id];
      // starfix2 T1：卡几何改吃 EVENT_CARD_W/H 常量（旧 152x90 字面退役）——
      // 展开框尺寸、初始聚焦运镜、小地图世界框全部随之走新四行卡几何
      return {
        x: pos.x,
        y: pos.y,
        width: EVENT_CARD_W,
        height: EVENT_CARD_H,
      };
    });
    const bounds = computeFanOutBounds(boxes, isFanOutCollapsed);
    // starfix2 T2：组头全量渲染的宽度下限连带——单卡日的引擎最小宽（330）装不下
    // 「⑃ …（… · 点击查看全天 →）」全串自适应胶囊（约 410px），会顶进「收起」按钮带；
    // 展开框宽抬到「胶囊全宽 + 左起 12 + 按钮带 82 + 呼吸 38」之下限，保证胶囊右缘
    // 恒在按钮左缘之前 ≥14px（fanOutHeaderCapsuleWidth 的钳制上界在此盒宽下永不触发截字）
    const headerNeed =
      fanOutHeaderCapsuleWidth(fanOutHeaderLine, Number.POSITIVE_INFINITY) + 12 + 82 + 38;
    return { ...bounds, width: Math.max(bounds.width, headerNeed) };
  }, [subAgentCards, nodePositions, isFanOutCollapsed, fanOutHeaderLine]);

  // C7③：选中卡的画布坐标（不存在选中卡时为 null，高亮线不渲染）
  const selectedCardPos = useMemo(() => {
    const sel = subAgentCards.find((c) => c.id === selectedCanvasNodeId);
    if (!sel) return null;
    return nodePositions[sel.id] || DEFAULT_NODE_POSITIONS[sel.id];
  }, [subAgentCards, selectedCanvasNodeId, nodePositions]);

  // starfix T4：进入星图的一次性机位——镜头自动居中聚焦「最近活跃日期的展开节点」。
  // 展开节点 = 当前激活日（scene.active=最新有事件日，未手动选日时的缺省选中）的扇出容器
  // （fanOutBounds），即默认展开的那组事件卡。挂载初值只保证不闪（k=1 贴窄条），等
  // stage 尺寸与场景就绪后按 500ms（--dur-pan 同值）平滑运镜到展开容器居中的机位；
  // 一次性 ref 守卫，之后用户自由平移缩放、点日期走 panToDate 既有链路，本 effect 不再插手。
  const initialFocusDoneRef = useRef(false);
  useEffect(() => {
    if (initialFocusDoneRef.current) return;
    if (stageWidth <= 0 || stageHeight <= 0) return;
    if (!scene.hasRealEvents || !scene.active) return;
    if (fanOutBounds.width <= 0 || fanOutBounds.height <= 0) return;
    initialFocusDoneRef.current = true;
    const k = 1; // 默认视口冻结 100%（工票 T4）
    // 以完整「日期卡 — 司辰 — 时间主干 — 当日文档扇出」四联画居中构图，
    // 让司辰与时光沉淀轴天然位于首屏视觉中心
    const triptychLeft = dateCardRailX(trunkX);
    const triptychRight = fanOutBounds.x + fanOutBounds.width;
    const cx = (triptychLeft + triptychRight) / 2;
    const cy = (TRUNK_AXIS_TOP + fanOutBounds.y + fanOutBounds.height) / 2 - 20;
    const rawX = stageWidth / 2 - cx * k;
    // 预留底部悬浮药丸高度（~72px）与顶部呼吸位（>=32px），防首屏展开卡上下裁切
    const usableH = Math.max(240, stageHeight - 72);
    const rawY = Math.max(28, Math.min(48, usableH / 2 - cy * k));
    const safeLeft = sourcesPanelCollapsed
      ? SOURCES_PANEL_COLLAPSED_LEFT
      : SOURCES_PANEL_SAFE_LEFT;
    const minX = safeLeft - k * Math.max(0, triptychLeft - 12);
    applyProgrammaticZoom(
      k,
      { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
      PAN_TRANSITION_MS
    );
    // 只在「尺寸+场景首次就绪」时落一次机位；fanOutBounds/trunkX 是该次计算的输入而非重跑依据
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 一次性运镜守卫
  }, [stageWidth, stageHeight, scene.hasRealEvents, scene.active]);

  // issue #27：共享文件索引——渲染期按 id 取文件不再逐卡 files.find（O(C×F) → O(C)）
  const fileById = useMemo(
    () => new Map(files.map((f) => [f.file_id, f])),
    [files]
  );

  // ═══ v0.8 任务空间桌面：任务包分组横排布局（R1）═══
  // 分组数据：buildCanvasPackageGroups(files, events) 纯函数（graphEvents 层，判定零复写）；
  // 「焦点任务包置首」在组件层按 selectedFileId 再排——分组数据本身不感知选中态。
  // issue #27：隐藏时不构建（组件仍挂载，state/缩放/布局不受影响）
  const packageGroups = useMemo(
    () => (visible ? buildCanvasPackageGroups(files, events) : []),
    [visible, files, events]
  );

  const focusedPkgId = useMemo(() => {
    const targetId = selectedFileId || files[0]?.file_id || '';
    const target = fileById.get(targetId) ?? files[0];
    return target ? taskPackageOf(target.relative_path).id : '';
  }, [fileById, files, selectedFileId]);

  const orderedPackageGroups = useMemo(() => {
    if (!focusedPkgId) return packageGroups;
    const focused = packageGroups.filter((g) => g.pkgId === focusedPkgId);
    const rest = packageGroups.filter((g) => g.pkgId !== focusedPkgId);
    return [...focused, ...rest];
  }, [packageGroups, focusedPkgId]);

  // 横排几何：起点对齐左侧日期卡轨道（dateCardRailX(trunkX)），y 落主干末端之下的桌面带；
  // 每包容器宽 = 左右 padding + 单行卡片数×卡宽 + 卡距（超 6 卡截断，余量由容器头 docCount 诚实承载）
  const PACKAGE_GROUP_BAND_Y = 782;
  const PACKAGE_GROUP_GAP_X = 64;
  const packageGroupLayouts = useMemo(() => {
    let x = dateCardRailX(trunkX);
    return orderedPackageGroups.map((group) => {
      const shown = Math.min(group.docs.length, PACKAGE_GROUP_MAX_CARDS);
      // 容器宽 = 左右 padding(14×2) + 单行卡片数×280 + 卡距 12；空包/单卡保底 160 宽（头行可读）
      const width = Math.max(
        160,
        14 * 2 + shown * RICH_CARD_W + Math.max(0, shown - 1) * 12
      );
      const layout = { group, x, y: PACKAGE_GROUP_BAND_Y, width, shown };
      x += width + PACKAGE_GROUP_GAP_X;
      return layout;
    });
  }, [orderedPackageGroups, trunkX]);

  // issue #27：卡片描述一次性物化——依赖只看包文档内容，拖动单节点（改 nodePositions
  // → trunkX → 布局坐标）不触发重建，逐帧渲染直接消费
  const packageCardsByPkg = useMemo(
    () =>
      buildCardDescriptors(
        orderedPackageGroups.map((g) => ({
          pkgId: g.pkgId,
          shown: Math.min(g.docs.length, PACKAGE_GROUP_MAX_CARDS),
          docs: g.docs,
        })),
        { evolutionView: versionView === 'evolution' }
      ),
    [orderedPackageGroups, versionView]
  );

  // ═══ v0.8 R5：小地图世界包围盒（zoom 层全部内容锚点：节点位/扇出盒/分组横排/主干）═══
  const canvasWorldBounds = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const grow = (x: number, y: number, w: number, h: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    };
    for (const pos of Object.values(nodePositions)) grow(pos.x, pos.y, 160, 80);
    grow(trunkX, trunkStartY, 1, trunkEndY - trunkStartY);
    grow(fanOutBounds.x, fanOutBounds.y, fanOutBounds.width, fanOutBounds.height);
    for (const layout of packageGroupLayouts) {
      grow(layout.x, layout.y, layout.width, PACKAGE_GROUP_FRAME_H);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return { x: 0, y: 0, width: 1000, height: 900 };
    }
    const pad = 40;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }, [nodePositions, trunkX, trunkStartY, trunkEndY, fanOutBounds, packageGroupLayouts]);

  // ═══ D01-b：画布卡片本体障碍清单（连线避障引擎的 obstacles 输入）═══
  // 与渲染口径逐一同源（折叠时事件卡只取前 2 张、司辰默认收起不入障碍、包容器横排全量）；
  // 纯矩形数组，消费方：GraphSceneTrunk 遗留连线升级 + GraphRelationEdges 证据链连线。
  // 拖拽/展开/收起改 nodePositions → 本清单重算 → 连线路由同帧重算（实时跟随不脱钩）。
  const graphObstacleRects = useMemo<ObstacleRect[]>(() => {
    const rects: ObstacleRect[] = [];
    // 主节点卡（150×76 与 GraphSceneNodes 渲染 foreignObject 同尺寸）
    rects.push({ id: 'main_hub', x: mainHubPos.x, y: mainHubPos.y, width: 150, height: 76 });
    // 司辰立绘（R6 去常驻：滑块收起时不渲染 → 不入障碍；盒宽 CHRONOS_MASCOT_WIDTH=132，
    // 高覆盖立绘 124 + 底部徽标带 translate(4,138)+36 ≈ 174）
    if (chronosSliderOpen) {
      rects.push({
        id: 'chronos_deity',
        x: chronosPos.x,
        y: chronosPos.y,
        width: CHRONOS_MASCOT_WIDTH,
        height: 174,
      });
    }
    // 左侧日期/来源卡（位置解析与渲染同出口 resolveLeftSourcePos）
    for (const src of leftSourceNodes) {
      const p = resolveLeftSourcePos(src);
      rects.push({ id: src.id, x: p.x, y: p.y, width: DATE_CARD_W, height: DATE_CARD_H });
    }
    // 右侧事件卡（折叠口径与 GraphSceneCards 渲染一致：xray 折叠只挂前 2 张）
    const visibleCards =
      isFanOutCollapsed && canvasLayoutMode === 'xray' ? subAgentCards.slice(0, 2) : subAgentCards;
    for (const c of visibleCards) {
      const p = nodePositions[c.id] || DEFAULT_NODE_POSITIONS[c.id];
      rects.push({ id: c.id, x: p.x, y: p.y, width: EVENT_CARD_W, height: EVENT_CARD_H });
    }
    // 扇出虚线容器盒（xray 常驻）
    if (canvasLayoutMode === 'xray') {
      rects.push({
        id: 'fan_out_box',
        x: fanOutBounds.x,
        y: fanOutBounds.y,
        width: fanOutBounds.width,
        height: fanOutBounds.height,
      });
    }
    // 任务包分组容器横排
    for (const layout of packageGroupLayouts) {
      rects.push({
        id: `pkg_${layout.group.pkgId}`,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: PACKAGE_GROUP_FRAME_H,
      });
    }
    return rects;
    // resolveLeftSourcePos 为渲染期普通函数（读 nodePositions/trunkX/src 派生），以
    // nodePositions + trunkX 代理其依赖；其余逐项对齐其消费输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mainHubPos,
    chronosSliderOpen,
    chronosPos.x,
    chronosPos.y,
    leftSourceNodes,
    nodePositions,
    trunkX,
    isFanOutCollapsed,
    canvasLayoutMode,
    subAgentCards,
    fanOutBounds,
    packageGroupLayouts,
  ]);

  // 当前可视矩形（zoom 层用户空间）= transform 反折算
  const minimapViewport = useMemo(() => {
    const k = zoomTransform.k || 1;
    return {
      x: -zoomTransform.x / k,
      y: -zoomTransform.y / k,
      width: stageWidth / k,
      height: stageHeight / k,
    };
  }, [zoomTransform, stageWidth, stageHeight]);

  // issue #27 验收 2：包容器按视口（含预留边距）挂载——不再「每包限 6 卡但把所有包全渲染」。
  // 世界坐标仍由完整布局序列给出（跨包定位/小地图/双击打开不受影响，验收 5）；
  // 裁剪只决定 DOM 挂载。焦点包即使出入视口也保留（选中态与叙事抽屉目标不断链）。
  const mountedPkgIds = useMemo(
    () =>
      visiblePackageGroupIds(
        packageGroupLayouts.map((l) => ({
          pkgId: l.group.pkgId,
          x: l.x,
          width: l.width,
        })),
        minimapViewport,
        { focusPkgId: focusedPkgId }
      ),
    [packageGroupLayouts, minimapViewport, focusedPkgId]
  );

  // R5：小地图跳转 = 目标世界点居中 + 同款左缘钳制（与 panToDate 一致的程序化运镜）
  const handleMinimapJump = (x: number, y: number) => {
    const k = zoomExactRef.current.k || 1;
    const rawX = stageWidth / 2 - x * k;
    const rawY = stageHeight / 2 - y * k;
    const minX = SOURCES_PANEL_SAFE_LEFT - k * Math.max(0, trunkX + FIXED_TEXT_TRUNK_DX);
    applyProgrammaticZoom(
      k,
      { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
      PAN_TRANSITION_MS
    );
  };

  // ═══ D01-a ④：quarter-octave 缩放分桶 LOD（缩小鸟瞰自动退化为轻骨架）═══
  // 档位随 gesture end 落定的 zoomTransform.k 翻转（连续缩放帧内直写 transform 不触发
  // 重渲，档位只在跨 quarter-octave 桶时变化一次）；k ≥ 0.5（基线全部镜头所在档）
  // 恒 full——LOD 只在鸟瞰档收纯装饰/流式层，正常阅读缩放零视觉变化。
  const lodTier = useMemo(() => lodTierForScale(zoomTransform.k), [zoomTransform.k]);
  const lodGates = useMemo(() => lodGatesForTier(lodTier), [lodTier]);

  // ═══ D01-a ③：任务包标题显示名（Overlay 恒定像素字号层 + 折叠组头行同源）═══
  // 活值订阅 packageTitleStore（翻转只重渲消费标题的两个叶子，不拉整树）；
  // 双击原位改名落 store 固化（重 derivation 不回退），磁盘目录名不动（hover 显真名）。
  const pkgTitleOverrides = useSyncExternalStore(
    subscribePackageTitles,
    getPackageTitleOverrides
  );
  const savePkgTitleOverride = useCallback((pkgId: string, name: string) => {
    setPackageTitleOverride(pkgId, name);
  }, []);

  // 叙事抽屉内点击引用条目：同步定位并切换叙事焦点到该引用文件
  const handleSelectNarrativeCitation = useCallback(
    (fileId: string) => {
      if (!fileId) return;
      const matchedSub = subAgentCards.find((c) => c.fileId === fileId);
      if (matchedSub) {
        setSelectedCanvasNodeId(matchedSub.id);
        setSelectedRichDocFileId(null);
        setNarrativeTarget({ nodeId: matchedSub.id, fileId });
      } else {
        setSelectedRichDocFileId(fileId);
        setNarrativeTarget({ fileId });
      }
      onSelectFile(fileId);
      setNarrativeDrawerOpen(true);
    },
    [subAgentCards, onSelectFile]
  );

  // ═══ v0.8 R3：叙事抽屉内容（自包含装配块抽至 graphCanvasNarrative.tsx，输入同源）═══
  const { narrative, narrativeCopyFileId } = useGraphCanvasNarrative({
    narrativeTarget,
    subAgentCards,
    files,
    decisions,
    relations,
    scene,
    rulerGranularity,
    packageGroups,
    orderedPackageGroups,
    focusedPkgId,
    unreadCount,
    workspaceName,
    onOpenDecisionModal,
    onSelectCitation: handleSelectNarrativeCitation,
    activeFileRecord,
  });

  // D3 Curve Generator for the 4-strand central river trunk（四条泳道曲线，x 偏移 -5/-1/+3/+7；
  // hard_3 起泳道语义化：md=橙 / svg=紫 / pdf=黄 / 未判定=蓝，见泳道渲染与图例）
  const d3RiverStrands = useMemo(() => {
    const lineGen = d3.line<[number, number]>().curve(d3.curveBasis);
    return {
      md:
        lineGen([
          [trunkX - 5, trunkStartY],
          [trunkX - 7, 260],
          [trunkX - 4, 480],
          [trunkX - 6, trunkEndY],
        ]) || '',
      svg:
        lineGen([
          [trunkX - 1, trunkStartY],
          [trunkX + 2, 270],
          [trunkX - 1, 490],
          [trunkX, trunkEndY],
        ]) || '',
      pdf:
        lineGen([
          [trunkX + 3, trunkStartY],
          [trunkX + 6, 280],
          [trunkX + 3, 500],
          [trunkX + 5, trunkEndY],
        ]) || '',
      unknown:
        lineGen([
          [trunkX + 7, trunkStartY],
          [trunkX + 9, 290],
          [trunkX + 6, 510],
          [trunkX + 8, trunkEndY],
        ]) || '',
    };
  }, [trunkX, trunkStartY, trunkEndY]);

  // 时光累积沉积轮廓带（由底端最初起点向上逐渐舒展至今日，直观传达「时间流逝 → 文件一点一点累积」）
  const accumulationRibbonPath = useMemo(() => {
    if (!scene.hasRealEvents || trunkTicks.length < 2 || trunkAccumulation.length !== trunkTicks.length) {
      return '';
    }
    const pts: Array<{ y: number; halfW: number }> = trunkTicks.map((_, i) => ({
      y: milestoneY(i, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM),
      halfW: 6 + 18 * (trunkAccumulation[i]?.accumulationRatio ?? 0.2),
    }));
    const areaGen = d3
      .area<{ y: number; halfW: number }>()
      .y((d) => d.y)
      .x0((d) => trunkX - d.halfW)
      .x1((d) => trunkX + d.halfW)
      .curve(d3.curveCatmullRom.alpha(0.5));
    return areaGen(pts) || '';
  }, [scene.hasRealEvents, trunkTicks, trunkAccumulation, trunkX, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM]);

  // Temporal Conduits：司辰沙漏流沙精准注入「当前激活日刻度」，新月权杖优雅引向激活日左卡
  const chronosConduits = useMemo(() => {
    const lineGen = d3.line<[number, number]>().curve(d3.curveBasis);
    const staffGemX = chronosPos.x + 38;
    const staffGemY = chronosPos.y + 30;
    const hourglassX = chronosPos.x + 102;
    const hourglassY = chronosPos.y + 46;
    const riverTargetY = activeTickY ?? TRUNK_AXIS_TOP;

    const activeLeftSrc = leftSourceNodes.find(
      (s) => s.date !== undefined && s.date === scene.activeDate
    );
    const activeLeftPos = activeLeftSrc ? resolveLeftSourcePos(activeLeftSrc) : null;
    const staffTargetX = activeLeftPos
      ? activeLeftPos.x + DATE_CARD_W - 2
      : dateCardRailX(trunkX) + DATE_CARD_W - 2;
    const staffTargetY = activeLeftPos ? activeLeftPos.y + DATE_CARD_H / 2 : riverTargetY;

    return {
      staffToTimeline:
        lineGen([
          [staffGemX, staffGemY],
          [(staffGemX + staffTargetX) / 2, (staffGemY + staffTargetY) / 2 - 12],
          [staffTargetX, staffTargetY],
        ]) || '',
      hourglassToRiver:
        lineGen([
          [hourglassX, hourglassY],
          [(hourglassX + trunkX) / 2 + 4, (hourglassY + riverTargetY) / 2 - 8],
          [trunkX - 5, riverTargetY],
        ]) || '',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveLeftSourcePos 派生自 nodePositions + trunkX
  }, [chronosPos.x, chronosPos.y, trunkX, activeTickY, TRUNK_AXIS_TOP, leftSourceNodes, scene.activeDate, nodePositions]);

  const hoverPreviewData = useMemo(() => {
    if (!hoveredPreviewAnchor || activeDraggingNodeId) return null;
    const targetFile = files.find((f) => f.file_id === hoveredPreviewAnchor.fileId);
    if (!targetFile) return null;
    return buildNodeHoverPreviewData(targetFile, readingStates[targetFile.file_id]);
  }, [hoveredPreviewAnchor, activeDraggingNodeId, files, readingStates]);

  const handleNodeMouseEnter = (fileId: string, nodeId: string) => {
    if (activeDraggingNodeId) return;
    setHoveredCanvasNodeId(nodeId);
    const pos =
      nodeId === 'chronos_deity'
        ? chronosPos
        : nodePositions[nodeId] || { x: 350, y: 200 };
    setHoveredPreviewAnchor({
      fileId,
      nodeId,
      x: pos.x,
      y: pos.y,
    });
  };

  const handleNodeMouseLeave = () => {
    setHoveredCanvasNodeId(null);
    setHoveredPreviewAnchor(null);
  };

  const openFileReader = (
    fileId: string,
    mode: 'read' | 'diff_since_read' | 'relations' = 'read',
    revisionId?: string
  ) => {
    const f = files.find((item) => item.file_id === fileId) || files[0];
    // files 为空（接口失败空态）时无可读文件，直接忽略而不是崩溃
    if (!f) return;
    onOpenReaderModal(f.file_id, revisionId || f.current_revision_id, mode);
  };

  // Keep the existing double-click shortcut while single clicks descend into the file.
  const pendingExplore = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelExplore = () => {
    if (pendingExplore.current !== null) clearTimeout(pendingExplore.current);
    pendingExplore.current = null;
  };
  useEffect(() => () => cancelExplore(), []);
  const exploreAfterClick = (fileId: string, revisionId?: string, eventId?: string) => {
    cancelExplore();
    // v0.4：下钻到具体版本与事件（不是在读磁盘当前内容）
    pendingExplore.current = setTimeout(() => onExploreFile(fileId, revisionId, eventId), 240);
  };
  // v0.8 R3③：双击语义变更——旧「双击直开阅读器」退役（readAfterDoubleClick 删除），改
  // 「双击查看详情」滑出叙事抽屉；「打开原文」迁抽屉 footer 首位钮（复用 openFileReader）。
  // 指名目标优先：nodeId=事件卡叙事；fileId=文件叙事；空对象=按当前选中态解析（工程轴）。
  // 进抽屉先取消 pending 的单击下钻（旧 readAfterDoubleClick 同款 cancelExplore——
  // 否则双击后 240ms 下钻把画布切到 depth-1，抽屉随隐藏层消失）。
  const openNarrativeDrawer = (target?: { nodeId?: string; fileId?: string }) => {
    cancelExplore();
    if (target && (target.nodeId || target.fileId)) {
      setNarrativeTarget(target);
      // 抽屉目标与画布高亮严格 1:1 对齐，杜绝「左卡亮橙框、右栏显另一文件」错位
      if (target.nodeId) {
        setSelectedCanvasNodeId(target.nodeId);
        setSelectedRichDocFileId(null);
      } else if (target.fileId) {
        const matchedSub = subAgentCards.find((c) => c.fileId === target.fileId);
        if (matchedSub) {
          setSelectedCanvasNodeId(matchedSub.id);
          setSelectedRichDocFileId(null);
        } else {
          setSelectedRichDocFileId(target.fileId);
        }
      }
      if (target.fileId) {
        onSelectFile(target.fileId);
      }
    } else {
      const sub = subAgentCards.find((c) => c.id === selectedCanvasNodeId);
      setNarrativeTarget(
        sub
          ? { nodeId: sub.id, fileId: sub.fileId || undefined }
          : selectedRichDocFileId
            ? { fileId: selectedRichDocFileId }
            : {}
      );
    }
    setNarrativeDrawerOpen(true);
  };
  const closeNarrativeDrawer = () => setNarrativeDrawerOpen(false);

  // 叙事抽屉已展开时，画布点击切换选中卡 / 切回司辰主轴后，抽屉内容实时跟随同步
  useEffect(() => {
    if (!narrativeDrawerOpen) return;
    if (selectedRichDocFileId) {
      setNarrativeTarget((prev) =>
        prev?.fileId === selectedRichDocFileId && !prev.nodeId
          ? prev
          : { fileId: selectedRichDocFileId }
      );
      return;
    }
    if (selectedCanvasNodeId === 'main_hub') {
      setNarrativeTarget((prev) =>
        prev && !prev.nodeId && !prev.fileId ? prev : {}
      );
      return;
    }
    const sub = subAgentCards.find((c) => c.id === selectedCanvasNodeId);
    if (sub) {
      setNarrativeTarget((prev) =>
        prev?.nodeId === sub.id && prev?.fileId === (sub.fileId || undefined)
          ? prev
          : { nodeId: sub.id, fileId: sub.fileId || undefined }
      );
    }
  }, [narrativeDrawerOpen, selectedCanvasNodeId, selectedRichDocFileId, subAgentCards]);

  const handleCopyInspectorPointer = (fileId: string, note: string) => {
    const f = files.find((item) => item.file_id === fileId) || files[0];
    // files 为空（接口失败空态）时无可引用文件，直接忽略而不是崩溃
    if (!f) return;
    const currentRev =
      f.revisions.find((r) => r.revision_id === f.current_revision_id) ||
      f.revisions[f.revisions.length - 1];
    onAddEvidencePointer({
      file_id: f.file_id,
      revision_id: currentRev.revision_id,
      relative_path: f.relative_path,
      content_sha256: currentRev.content_sha256,
      locator: { kind: 'lines', start: 1, end: 32 },
      evidence_kind: 'explicit_source',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: f.coverage,
      stale: false,
      excerpt: currentRev.summaryNote,
      note,
    });
    setCopiedId(fileId);
    setTimeout(() => setCopiedId(null), 1600);
  };

  const isNodeVisibleByCategory = (format: string) => {
    const key = format.toUpperCase();
    return !hiddenCategories[key];
  };

  const isNodeInActiveTimeSlice = (bucket: string) => {
    // v0.8 R4③：版本演进视图放开按日调光——演进跨日期展开，不再因选中某日把其余时段降透明
    if (versionView === 'evolution') return true;
    if (scene.hasRealEvents) {
      // 事件模式：卡片都属于当前日期组；左侧日期导航按选中日期高亮
      if (activeDate === undefined) return true;
      if (activeDate === '') return bucket === '日期待考' || bucket === '';
      return bucket === activeDate;
    }
    if (activeTimeSlice === 'all') return true;
    return activeTimeSlice === bucket;
  };

  // ═══ D05：星图画布 Alt+方向键 沿引用/因果连线空间漫游 ═══
  // 候选节点与渲染几何同源（事件卡 + 左侧来源卡 + 任务包横排富预览卡）；
  // 跳转同步右栏选中并居中运镜（reduced-motion 自动 durationMs=0 静态降级）。
  const spatialNavCards = useMemo<CanvasNavCard[]>(() => {
    if (!visible) return [];
    const leftWithPos = leftSourceNodes
      .filter((src) => Boolean(src.fileId))
      .map((src) => {
        const p = resolveLeftSourcePos(src);
        return { id: src.id, fileId: src.fileId, x: p.x, y: p.y };
      });
    const pkgLayouts = packageGroupLayouts.map((layout) => ({
      pkgId: layout.group.pkgId,
      x: layout.x,
      y: layout.y,
      docs: packageCardsByPkg.get(layout.group.pkgId) ?? [],
    }));
    return buildSpatialNavCards({
      subAgentCards,
      isFanOutCollapsed,
      canvasLayoutMode,
      nodePositions,
      defaultPositions: DEFAULT_NODE_POSITIONS,
      leftSourceNodes: leftWithPos,
      packageLayouts: pkgLayouts,
    });
    // resolveLeftSourcePos 派生自 nodePositions + trunkX
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visible,
    subAgentCards,
    isFanOutCollapsed,
    canvasLayoutMode,
    nodePositions,
    leftSourceNodes,
    trunkX,
    packageGroupLayouts,
    packageCardsByPkg,
  ]);

  useCanvasSpatialNav({
    enabled: visible,
    relations,
    cards: spatialNavCards,
    selectedNodeId: selectedCanvasNodeId,
    selectedRichDocFileId,
    selectedFileId,
    onSelectCard: (card) => {
      if (card.hiddenInFold) {
        setIsFanOutCollapsed(false);
      }
      if (card.kind === 'rich') {
        setSelectedRichDocFileId(card.fileId);
        onSelectFile(card.fileId);
      } else {
        setSelectedCanvasNodeId(card.id);
        setSelectedRichDocFileId(null);
        onSelectFile(card.fileId, card.revisionId);
      }
    },
    centerOn: (card, durationMs) => {
      const stageEl = stageRef.current;
      const stageH = stageEl?.clientHeight ?? 0;
      if (stageWidth <= 0 || stageH <= 0) return;
      const k = zoomExactRef.current.k || 1;
      const rawX = stageWidth * 0.5 - card.x * k;
      const rawY = stageH * 0.45 - card.y * k;
      const safeLeft = sourcesPanelCollapsed
        ? SOURCES_PANEL_COLLAPSED_LEFT
        : SOURCES_PANEL_SAFE_LEFT;
      const minX = safeLeft - k * Math.max(0, trunkX + FIXED_TEXT_TRUNK_DX);
      applyProgrammaticZoom(
        k,
        { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
        durationMs
      );
    },
  });

  return {
    // props 透传（层组件按需消费）
    visible,
    files,
    events,
    decisions,
    relations,
    readingStates,
    selectedFileId,
    onSelectFile,
    onExploreFile,
    onOpenDecisionModal,
    onOpenDayInTimeline,
    onGranularityChange,
    onDrillToBucket,
    onSelectEvent,
    panoramaMode,
    onPanoramaModeChange,
    onCanvasThemeChange,
    workspaceName,
    stateIndex,
    systemActions,
    // 状态与派生
    selectedCanvasNodeId,
    setSelectedCanvasNodeId,
    hoveredCanvasNodeId,
    setHoveredCanvasNodeId,
    hoveredPreviewAnchor,
    isFanOutCollapsed,
    setIsFanOutCollapsed,
    canvasLayoutMode,
    sourcesPanelCollapsed,
    narrativeDrawerOpen,
    canvasTool,
    setCanvasTool,
    versionView,
    setVersionView,
    showShortcuts,
    setShowShortcuts,
    legendOpen,
    setLegendOpen,
    chronosSliderOpen,
    setChronosSliderOpen,
    isTimeFlowPlaying,
    toggleTimeFlowPlay,
    stepChronosDay,
    canStepOlder,
    canStepNewer,
    replayUnit,
    setReplayUnit,
    replaySpeed,
    setReplaySpeed,
    onOpenChronosDigest,
    topBarSlot,
    selectedRichDocFileId,
    setSelectedRichDocFileId,
    isViewSettingsOpen,
    setIsViewSettingsOpen,
    chronosDropSummary,
    activeDraggingNodeId,
    stageWidth,
    stageHeight,
    activeDate,
    selectDate,
    activeTimeSlice,
    setActiveTimeSlice,
    liveFlowEnabled,
    setLiveFlowEnabled,
    meteorShowerEnabled,
    setMeteorShowerEnabled,
    meteorBurstKey,
    setMeteorBurstKey,
    xrayLaserEnabled,
    setXrayLaserEnabled,
    showAllMdSources,
    setShowAllMdSources,
    expandedGroups,
    hiddenCategories,
    copiedId,
    prefersReducedMotion,
    zoomTransform,
    nodePositions,
    mdFiles,
    svgFiles,
    pdfFiles,
    visibleMdFiles,
    mdFindingsCount,
    unreadCount,
    scene,
    trunkTicks,
    trunkAccumulation,
    accumulationSummary,
    accumulationRibbonPath,
    // D01-b：卡片本体障碍清单（与渲染口径同源；relations 原已直通 ctx，证据链连线层消费）
    graphObstacleRects,
    mainHubPos,
    trunkX,
    trunkStartY,
    trunkEndY,
    TRUNK_AXIS_TOP,
    TRUNK_AXIS_BOTTOM,
    chronosPos,
    rulerMaxCount,
    rulerLabelStep,
    fanOutHeaderLine,
    rulerGranularity,
    navigatorDateSet,
    activeTickY,
    springRevealKey,
    subAgentCards,
    leftSourceNodes,
    resolveLeftSourcePos,
    activeSubAgent,
    activeFileRecord,
    fanOutBounds,
    selectedCardPos,
    packageGroups,
    focusedPkgId,
    fileById,
    orderedPackageGroups,
    packageGroupLayouts,
    packageCardsByPkg,
    canvasWorldBounds,
    minimapViewport,
    mountedPkgIds,
    lodTier,
    lodGates,
    pkgTitleOverrides,
    savePkgTitleOverride,
    narrative,
    narrativeCopyFileId,
    d3RiverStrands,
    chronosConduits,
    hoverPreviewData,
    // refs（Scene 层挂载点 + chrome 复用）
    svgRef,
    zoomLayerRef,
    zoomExactRef,
    subscribeZoomFrame,
    stageRef,
    // handlers
    handleToggleLayoutMode,
    applyProgrammaticZoom,
    zoomByDelta,
    panToDate,
    handleResetCanvasLayout,
    toggleSourcesPanel,
    cycleChronosTimeSlice,
    toggleGroup,
    toggleCategoryVisibility,
    expandAllSidebar,
    collapseAllSidebar,
    handleMinimapJump,
    handleNodeMouseEnter,
    handleNodeMouseLeave,
    openFileReader,
    exploreAfterClick,
    cancelExplore,
    openNarrativeDrawer,
    closeNarrativeDrawer,
    handleCopyInspectorPointer,
    isNodeVisibleByCategory,
    isNodeInActiveTimeSlice,
    // D02 增量聚光灯（宿主派生，本层透传；undefined = 关闭态零注入）
    spotlight,
  };
}

/** 层组件消费的控制器上下文（类型随控制器自动演化，零手工镜像）。 */
export type GraphCanvasCtx = ReturnType<typeof useGraphCanvasController>;
