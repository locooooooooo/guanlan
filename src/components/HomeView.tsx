import React, { useMemo } from 'react';
import { AlertTriangle, ArrowRight, BookMarked, CalendarDays, Check, Hourglass, Layers, Orbit, RotateCw } from 'lucide-react';
import type {
  DecisionAssertion,
  FileFormat,
  FileRecord,
  ReadingState,
  TimelineEvent,
} from '../types/guanlan';
import type { EventDaysResult, WorkspaceSummary } from '../services/workspaceClient';
import type {
  CrossProjectDecisionItemDto,
  CrossProjectRecentFileDto,
  ProjectEntryDto,
  ProjectsOverviewResponseDto,
  StateOverviewResponse,
} from '../services/apiTypes';
import { MultiProjectOverviewStrip } from './MultiProjectOverviewStrip';
import { formatUiMeta } from '../utils/formatMeta';
// 首页聚合口径全部复用既有单一出口：未读三态走 GL-01，任务包分组同概览看板，
// 高价值待阅走统计契约（computeHighValueReading/highValueReadingHeading）——
// 组件内零造数，不新建任何判定或接口。
import { hasUnreadChanges } from '../utils/guanlanEngine';
// SVG 封面编码走 per-file 预览缓存单一出口（原组件内 AtlasView 同式拷贝退役）
import { getFilePreviewEntry } from '../utils/filePreviewCache';
import { computeHighValueReading, highValueReadingHeading } from '../utils/highValueReading';
// 统一状态机 SSOT（方案 F2）：决策状态词与未决口径单一出口（与 DecisionRadar 同源，AC-01）
import {
  DECISION_STATUS_CONFLICT,
  DECISION_STATUS_PENDING,
  unresolvedDecisionCount,
} from '../utils/stateProjection';
import {
  enrichPackagesWithEvents,
  groupFilesIntoPackages,
  packageBadgeLine,
  STAGE_ACCENT,
} from '../utils/taskPackages';
import type { PackageDoc, TaskPackage } from '../utils/taskPackages';
import { localDay } from '../utils/timeFormat';
import { BRAND_SLOGAN, BRAND_SLOGAN_NOTE } from '../utils/brandIdentity';
// v0.6 品牌界面升级 + V07 coss Frame/CardFrame 容器
import { Button, IconButton } from './ui/primitives';
import { Badge, CardFrame, Frame, FramePanel } from './ui';
// v0.8 专题橱窗：两张微渐变专题卡（C1）+ 任务包视觉预览网格（C2，替换原「任务动态」节）
import FeaturedFocusCards from './FeaturedFocusCards';
import type { FeaturedDecisionItem, FeaturedPackageInfo } from './FeaturedFocusCards';
import TaskPackageGallery from './TaskPackageGallery';
import type { DesktopFileActionCallbacks } from './FileContextMenu';

export interface HomeRecentItem {
  file_id: string;
  title: string;
  date: string;
  format: FileFormat;
}

interface HomeViewProps {
  files: FileRecord[];
  readingStates: Record<string, ReadingState>;
  events: TimelineEvent[];
  /** /summary 的真实计数；v0.8 首页已不再展示统计大数字（R1），字段保留待总装票统一改接线 */
  summary: WorkspaceSummary | null;
  /** /events/days 按日聚合——事件走势小图的唯一数据源 */
  eventDays: EventDaysResult | null;
  /** App 已算好的「最近 7 天」列表（文档日期 = revisions[0].source_time 本地日历日） */
  recentItems: HomeRecentItem[];
  /** 待拍板决策原始数组（总装票接线；接线前缺省 []——N=0 渲染空态，不炸不造数） */
  decisions?: DecisionAssertion[];
  /** V03 SSOT：服务端全库未决待拍板真实总数（消除 288 vs 100 分页分裂） */
  decisionsUnresolvedTotal?: number | null;
  onOpenDoc: (fileId: string) => void;
  /** 续读入口：与左栏目录 / 悬浮岛同一链路（钉回上次读到的版本） */
  onResumeReading: (fileId: string) => void;
  onMarkFullyRead: (fileId: string, revisionId: string) => void;
  onOpenPackageBoard: () => void;
  onOpenPanorama: () => void;
  /** U10：带日期直飞全景星图（锁定 activeDate 语义，绝不 toggle）——
      司辰徽记「今日切片」与事件走势柱图共用同一接线点；
      缺省时点击降级为无日期的 onOpenPanorama（仍诚实可达，不锁定具体日） */
  onOpenPanoramaAt?: (date: string) => void;
  /** U10：带日期直飞全景日历（锁定 activeDate + 聚焦当日沉淀卡）——
      走势区「日历看该日」次级入口；缺省时该入口不渲染 */
  onOpenCalendarAt?: (date: string) => void;
  /** 点击卡 A 斜叠决策微型卡 → 顶栏雷达对应项（总装票接线；接线前缺省 no-op） */
  onOpenDecision?: (decisionId: string) => void;
  /** V10：打开「司辰手记」今日/本周沉淀简报抽屉 */
  onOpenChronosDigest?: () => void;
  /** F1（AC-01）：App 级 /state-overview 唯一数据源，透传任务包橱窗渲染六态徽标 */
  stateOverview?: StateOverviewResponse | null;
  /** A04：文件右键菜单 */
  systemActions?: DesktopFileActionCallbacks;
  /** Quiet.md 多项目并存总览：存在时首页顶部展示跨项目工作台与汇总脉搏 */
  multiProject?: {
    overview: ProjectsOverviewResponseDto | null;
    projects: ProjectEntryDto[];
    activeProjectId: string;
    onAddProject: () => void;
    onFocusProject: (projectId: string, targetTab?: 'home' | 'panorama' | 'library') => void;
    onOpenCrossDecision: (item: CrossProjectDecisionItemDto) => void;
    onOpenCrossFile: (item: CrossProjectRecentFileDto) => void;
  };
  /** 后端连接状态与错误重试（断连时诚实显示错误态，绝不伪装成空工作区） */
  dataSource?: 'loading' | 'real' | 'error';
  dataError?: string | null;
  retryingConnection?: boolean;
  onRetryConnection?: () => void;
}

/** 当前版本解析：与 AtlasView/RightInspector 同款口径（current_revision_id 优先，缺失取末版） */
function currentRevisionOf(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

/** 按时段问候 + 本地长日期（zh-CN；展示层自取当下时刻，不参与任何数据口径） */
function greetingHeader(): { greeting: string; dateLabel: string } {
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const dateLabel = now.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  return { greeting, dateLabel };
}

/** 近 7 天本地日历日窗口（含今天），键为 YYYY-MM-DD——与 App.recentItems 同一套本地拼接口径 */
function lastSevenDays(): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    );
  }
  return days;
}

// ══════════════════════════════════════════════════════════════════════════
// U10 纯函数出口（无 DOM 依赖，test/ui-ux-polish-04-polish.test.ts 直测）：
// 走势柱模型（可点击时光入口）与司辰今日徽记摘要全部真实派生，组件内零造数。
// 新增/演进分类与 graphEvents.computeTrunkAccumulation 同一语义出处
// （appeared/discovered/workspace_baseline = 新增·首次纳入，其余 = 内容演进）。
// ══════════════════════════════════════════════════════════════════════════

/** 走势柱图桶数上限：近 24 天（day 粒度） */
export const HOME_TREND_BAR_LIMIT = 24;

/** 「今日新增/首次纳入」类事件 kind——与 computeTrunkAccumulation 的 added 口径逐字同源 */
const CHRONOS_ADDED_KINDS = ['appeared', 'discovered', 'workspace_baseline'] as const;

/** 精确 YYYY-MM-DD 校验（含真实历法日：02-30 等伪日期拒绝；'' 日期待考恒 false） */
export function isExactDayDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

/** 事件走势柱模型：进图桶（'' 日期待考恒排除）+ 直跳可行性判定 */
export interface HomeTrendBar {
  /** YYYY-MM-DD（或服务端给出的其他非空桶键；非法键 jumpable=false） */
  date: string;
  count: number;
  /** day 粒度且日期为精确 YYYY-MM-DD 才可作直跳载荷；
      week/month 聚合桶与畸形键诚实禁跳（apiTypes 契约：只有 day 桶能定位到某日） */
  jumpable: boolean;
}

/**
 * 走势柱模型聚合（U10 可点击时光入口）：
 * ''（日期待考）桶恒排除 → 按日期升序 → 取最近 HOME_TREND_BAR_LIMIT 桶；
 * count 负值/NaN 钳 0（诚实下界），jumpable 按 apiTypes 契约逐桶判定。
 */
export function buildHomeTrendBars(eventDays: EventDaysResult | null): HomeTrendBar[] {
  const groups = (eventDays?.groups ?? [])
    .filter((g) => g.date !== '')
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return groups.slice(-HOME_TREND_BAR_LIMIT).map((g) => ({
    date: g.date,
    count: Number.isFinite(g.count) ? Math.max(0, g.count) : 0,
    jumpable: eventDays?.granularity === 'day' && isExactDayDate(g.date),
  }));
}

/** 司辰今日徽记摘要：全部从真实 eventDays 今日桶派生，零造数 */
export interface ChronosTodaySummary {
  /** 今日本地日历日（YYYY-MM-DD，与 lastSevenDays 同一口径，不引 UTC 日界） */
  date: string;
  /** eventDays 存在今日 day 粒度桶；false = 徽记诚实降级为「今日暂无新动态」 */
  found: boolean;
  dayCount: number;
  /** 今日新增/首次纳入（appeared + discovered + workspace_baseline） */
  addedCount: number;
  /** 今日内容演进（其余非新增事件） */
  modifiedCount: number;
  /** 事件聚合口径（occurred=业务发生 / observed=系统采集）——徽记文案显式声明，绝不混写 */
  order: 'occurred' | 'observed' | null;
}

/** 司辰今日徽记摘要聚合：非 day 粒度或无今日桶时诚实回未命中态，绝不伪造计数 */
export function buildChronosTodaySummary(
  eventDays: EventDaysResult | null,
  today: string
): ChronosTodaySummary {
  const order = eventDays?.order ?? null;
  if (!eventDays || eventDays.granularity !== 'day') {
    return { date: today, found: false, dayCount: 0, addedCount: 0, modifiedCount: 0, order };
  }
  const bucket = eventDays.groups.find((g) => g.date === today);
  if (!bucket) {
    return { date: today, found: false, dayCount: 0, addedCount: 0, modifiedCount: 0, order };
  }
  const dayCount = Number.isFinite(bucket.count) ? Math.max(0, bucket.count) : 0;
  const kinds = bucket.by_kind ?? {};
  const rawAdded = CHRONOS_ADDED_KINDS.reduce((sum, kind) => sum + (kinds[kind] ?? 0), 0);
  const addedCount = Math.min(dayCount, Math.max(0, rawAdded));
  const modifiedCount = Math.max(0, dayCount - addedCount);
  return { date: today, found: true, dayCount, addedCount, modifiedCount, order };
}

/** 徽记摘要文案：未命中/零事件日诚实降级，绝不显示归零以外的编造数字 */
export function chronosBadgeLine(summary: ChronosTodaySummary): string {
  if (!summary.found || summary.dayCount === 0) return '今日暂无新动态';
  return `今日新增 ${summary.addedCount} · 演进 ${summary.modifiedCount}`;
}

/** 口径声明词（徽记 title/aria 显式声明 occurred=业务发生 / observed=系统采集） */
export function chronosOrderLabel(order: 'occurred' | 'observed' | null): string {
  if (order === 'occurred') return '业务发生';
  if (order === 'observed') return '系统采集';
  return '';
}

/** 「日历看该日」次级入口落点：最近一个有事件的直跳日（真实派生，不造「峰值日」概念） */
export function latestJumpableTrendDate(bars: HomeTrendBar[]): string | null {
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].jumpable && bars[i].count > 0) return bars[i].date;
  }
  return null;
}

const HomeView: React.FC<HomeViewProps> = ({
  files,
  readingStates,
  events,
  eventDays,
  recentItems,
  decisions,
  decisionsUnresolvedTotal,
  onOpenDoc,
  onResumeReading,
  onMarkFullyRead,
  onOpenPackageBoard,
  onOpenPanorama,
  onOpenPanoramaAt,
  onOpenCalendarAt,
  onOpenDecision,
  onOpenChronosDigest,
  stateOverview,
  systemActions,
  multiProject,
  dataSource = 'real',
  dataError = null,
  retryingConnection = false,
  onRetryConnection,
}) => {
  const { greeting, dateLabel } = greetingHeader();

  // U10 司辰今日徽记：今天 = 本地日历日（与 lastSevenDays 同一口径，不引 UTC 日界）；
  // 摘要全部由真实 eventDays 今日桶派生（buildChronosTodaySummary 零造数）
  const today = useMemo(() => localDay(new Date().toISOString()), []);
  const chronos = useMemo(() => buildChronosTodaySummary(eventDays, today), [eventDays, today]);

  // 近 7 天本地日历日窗口（含今天）——卡 B「今日最活跃专项」的事件窗口唯一依据
  const weekDays = useMemo(lastSevenDays, []);
  const windowStart = weekDays[0];

  // 任务包：与 AtlasView 看板同一条纯函数链（group → enrich），事件缺省时不造 eventCount；
  // 分组 base 抽共享 memo——卡 B 近 7 天窗口回填（activePackage）复用同一次分组结果
  const packagesBase = useMemo(() => groupFilesIntoPackages(files), [files]);
  const packages = useMemo(
    () =>
      events.length > 0 ? enrichPackagesWithEvents(packagesBase, events) : packagesBase,
    [packagesBase, events]
  );

  // 文件索引：近期待阅行回查 / 卡 B 待验收计数 / Gallery 契约位共用
  const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  // SVG 封面 dataUri（R5）：per-file 预览缓存单一出口（filePreviewCache）——此处原是
  // AtlasView 同式的又一份拷贝（每次 files 身份变化全量重清洗重编码），已收敛；
  // 修订未变 O(1) 命中，仅新到文件编码一次。同份 map 喂 Gallery 封面与卡 B 斜叠图纸，
  // 规格工作流2 的封面/斜叠图因此同源不缺供，不依赖 optional 静默降级
  const svgDataUris = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of files) {
      if (f.format !== 'svg') continue;
      const uri = getFilePreviewEntry(f).svgDataUri;
      if (uri) map[f.file_id] = uri;
    }
    return map;
  }, [files]);

  // 卡 B：近 7 天窗口（lastSevenDays 首日）内事件回填后 eventCount 最高者。
  // 窗口过滤用 ev.observed_at 本地日——与 enrichPackagesWithEvents 的 lastActivity 同一时间源；
  // 活跃链与旧 activePackages 同式（有动静者按最近活动降序），计数并列时更近期者胜出
  const activePackage = useMemo<TaskPackage | null>(() => {
    const windowedEvents = events.filter((e) => localDay(e.observed_at) >= windowStart);
    const enriched =
      windowedEvents.length > 0
        ? enrichPackagesWithEvents(packagesBase, windowedEvents)
        : packagesBase;
    const active = enriched
      .filter((p) => p.lastActivity)
      .sort((a, b) => (a.lastActivity! < b.lastActivity! ? 1 : -1));
    if (active.length === 0) return null;
    return active.reduce((best, p) => (p.eventCount > best.eventCount ? p : best), active[0]);
  }, [packagesBase, events, windowStart]);

  // 卡 B 契约物化（C1 FeaturedPackageInfo）：待验收 N = 交付阶段文档中 GL-01 未读数
  // （reason !== 'up_to_date'，与统计契约 pending 口径一致）；封面文档 = 有 dataUri 的
  // svg 中当前版最新者（工票 T4「最新 SVG 封面」——docs 是阅读顺序不是时间序，按
  // currentRevisionOf observed_at 取 max，时间全缺则首份兜底），无 svg → 承载
  // latestConclusion 的文档（排版封面），无结论 → 不发 cover；badgeLine = packageBadgeLine
  // 真实派生（工票 T4 斜叠排版封面消费）
  const activePackageInfo = useMemo<FeaturedPackageInfo | null>(() => {
    if (!activePackage) return null;
    const awaitingAcceptance = activePackage.docs.filter((d) => {
      if (d.stage !== '交付') return false;
      const f = fileById.get(d.fileId);
      return !!f && hasUnreadChanges(f, readingStates[d.fileId]).reason !== 'up_to_date';
    }).length;
    let svgDoc: PackageDoc | null = null;
    let svgDocAt = '';
    for (const d of activePackage.docs) {
      if (d.format !== 'svg' || !svgDataUris[d.fileId]) continue;
      const f = fileById.get(d.fileId);
      const at = f ? currentRevisionOf(f)?.observed_at ?? '' : '';
      if (at >= svgDocAt) {
        svgDocAt = at;
        svgDoc = d;
      }
    }
    const coverDoc =
      svgDoc ??
      (activePackage.latestConclusion
        ? activePackage.docs.find((d) => d.conclusion === activePackage.latestConclusion)
        : undefined);
    return {
      id: activePackage.id,
      name: activePackage.name,
      stage: activePackage.stage,
      docCount: activePackage.docs.length,
      awaitingAcceptance,
      badgeLine: packageBadgeLine(activePackage),
      cover: coverDoc
        ? {
            fileId: coverDoc.fileId,
            title: coverDoc.title,
            format: coverDoc.format,
            dataUri: coverDoc.format === 'svg' ? svgDataUris[coverDoc.fileId] : undefined,
            conclusion: activePackage.latestConclusion,
          }
        : undefined,
    };
  }, [activePackage, fileById, readingStates, svgDataUris]);

  // 卡 A（R2）：与 DecisionRadar 同口径——候选（isCandidateOnly）只作线索不计入；
  // 待拍板 = 来源不一致(冲突) + 待确认。方案 F2：状态词与未决过滤收敛到
  // stateProjection 单一出口（UNRESOLVED/DECISION_STATUS_* 常量），不再双份硬编码；
  // 展示序镜像雷达分区（冲突优先，区内 byBlocked 同式排序取前 2；byBlocked 为
  // 雷达模块内私有比较器，此处按其实现镜像并注明出处）
  const decisionItems = useMemo<FeaturedDecisionItem[]>(() => {
    const considered = (decisions ?? []).filter((d) => !d.isCandidateOnly);
    const byBlocked = (a: DecisionAssertion, b: DecisionAssertion) =>
      b.impactBlocked.length - a.impactBlocked.length ||
      a.code.localeCompare(b.code, 'zh-Hans-CN');
    const conflicts = considered
      .filter((d) => d.status === DECISION_STATUS_CONFLICT)
      .sort(byBlocked);
    const pending = considered
      .filter((d) => d.status === DECISION_STATUS_PENDING)
      .sort(byBlocked);
    return [...conflicts, ...pending].slice(0, 2).map((d) => ({
      decisionId: d.decision_id,
      question: d.question,
      status: d.status,
    }));
  }, [decisions]);
  // 未决计数与 DecisionRadar unresolvedCount 同一出口（V03 SSOT：优先消费服务端全库未决总数）
  const decisionCount = useMemo(
    () =>
      typeof decisionsUnresolvedTotal === 'number' && decisionsUnresolvedTotal >= 0
        ? decisionsUnresolvedTotal
        : unresolvedDecisionCount(decisions ?? []),
    [decisions, decisionsUnresolvedTotal]
  );

  // 近期待阅（R4）：统计契约单一出口（高价值∩未读，entries 已排序），展示层只截前 6
  const highValueStats = useMemo(
    () => computeHighValueReading(files, readingStates),
    [files, readingStates]
  );
  const todoEntries = useMemo(() => highValueStats.entries.slice(0, 6), [highValueStats.entries]);

  // 事件走势：纯函数出口（U10 可点击时光入口）——''（日期待考）桶不进图，升序取最近
  // 24 桶；只有 day 粒度且日期为精确 YYYY-MM-DD 的桶才可作直跳载荷（聚合桶诚实禁跳）
  const trendBars = useMemo(() => buildHomeTrendBars(eventDays), [eventDays]);
  const trendMax = Math.max(1, ...trendBars.map((g) => g.count));
  const trendTotal = trendBars.reduce((acc, g) => acc + g.count, 0);
  // 「日历看该日」次级入口落点：最近一个有事件的直跳日（无则不渲染入口）
  const calendarJumpDate = useMemo(() => latestJumpableTrendDate(trendBars), [trendBars]);

  if (dataSource === 'error' && files.length === 0) {
    return (
      <div className="depth-0-surface relative flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl items-center justify-center px-4 py-10 sm:px-6">
          <div
            role="alert"
            data-home-error-state=""
            className="depth-2-card w-full p-6 space-y-4"
          >
            <div className="flex items-start gap-3">
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-ctl)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_12%,transparent)] text-[color:var(--stage-ink-exec-text)]">
                <AlertTriangle className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <h1 className="text-[length:var(--text-item-title)] font-semibold text-[color:var(--ink-strong)]">
                  工作区数据暂无法加载
                </h1>
                <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] break-words">
                  {dataError || '无法连接观澜读服务，请检查服务运行状态后重试。'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onRetryConnection && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={retryingConnection}
                  aria-busy={retryingConnection}
                  onClick={onRetryConnection}
                >
                  <RotateCw className={`size-3.5 ${retryingConnection ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span>{retryingConnection ? '重试中…' : '重试加载'}</span>
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={onOpenPanorama}>
                <Orbit className="size-3.5" aria-hidden="true" />
                <span>查看全景</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="depth-0-surface relative flex-1 min-h-0 overflow-y-auto">
      {/* V07：对称居中画布（ReadingIsland 已于 V02 收编顶栏，取消右侧多余 pr-16 留白） */}
      <div className="relative mx-auto w-full max-w-6xl space-y-6 px-4 pb-14 pt-6 sm:px-6 sm:pt-7">
        {/* 问候头 + 工作区状态胶囊 + 快捷入口 */}
        <header
          className="glx-hero-reveal flex flex-wrap items-end justify-between gap-4"
          style={{ '--glx-stagger': 0 } as React.CSSProperties}
        >
          <div className="min-w-0 max-w-full">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <div className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-border/80 bg-card px-3 py-1 text-[length:var(--text-micro)] leading-none font-medium text-[color:var(--ink-soft)]">
                <CalendarDays className="size-3 shrink-0 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
                <span className="whitespace-nowrap">{dateLabel}</span>
                {multiProject && multiProject.projects.length > 1 && (
                  <>
                    <span aria-hidden="true" className="opacity-35">·</span>
                    <span className="font-mono tabular-nums whitespace-nowrap text-[color:var(--accent-iris-ink)]">
                      {multiProject.projects.length} 个项目
                    </span>
                  </>
                )}
                <span aria-hidden="true" className="opacity-35">·</span>
                <span className="font-mono tabular-nums whitespace-nowrap text-[color:var(--ink-strong)]">
                  {multiProject && multiProject.overview && multiProject.projects.length > 1
                    ? `${multiProject.overview.total_files} 份资产`
                    : `${files.length} 份资产`}
                </span>
                {(multiProject && multiProject.overview && multiProject.projects.length > 1
                  ? multiProject.overview.total_pending_decisions
                  : decisionCount) > 0 && (
                  <>
                    <span aria-hidden="true" className="opacity-35">·</span>
                    <span className="font-mono tabular-nums whitespace-nowrap text-[color:var(--accent-wave)]">
                      {multiProject && multiProject.overview && multiProject.projects.length > 1
                        ? multiProject.overview.total_pending_decisions
                        : decisionCount}{' '}
                      项待拍板
                    </span>
                  </>
                )}
              </div>
              {/* U10 司辰今日徽记胶囊：今日新增/演进微摘要全部真实派生（eventDays 今日桶
                  by_kind，新增分类与 computeTrunkAccumulation 同一语义出处；未命中日诚实
                  降级为「今日暂无新动态」，绝不重复 meta 胶囊的资产/待拍板统计）。
                  悬停轻摇（motion-safe 变换，component 侧过渡不进共享动效层）呼应星图司辰；
                  点击直飞司辰星图今日切片（onOpenPanoramaAt 锁定 activeDate，缺省降级为
                  无日期的 onOpenPanorama——仍诚实可达）。 */}
              <button
                type="button"
                data-chronos-badge={chronos.found ? 'today' : 'idle'}
                data-chronos-order={chronos.order ?? 'unknown'}
                onClick={() =>
                  chronos.found && onOpenPanoramaAt
                    ? onOpenPanoramaAt(chronos.date)
                    : onOpenPanorama()
                }
                title={`${chronosBadgeLine(chronos)}${
                  chronos.order ? ` · 按${chronosOrderLabel(chronos.order)}口径` : ''
                } · 点击前往全景星图${chronos.found ? '今日切片' : ''}`}
                aria-label={`司辰今日徽记：${chronosBadgeLine(chronos)}${
                  chronos.order ? `（按${chronosOrderLabel(chronos.order)}口径统计）` : ''
                }，点击前往全景星图${chronos.found ? '今日切片' : ''}`}
                className="group/badge inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/80 bg-card/85 px-3 py-1 text-[11px] leading-none font-medium text-[color:var(--ink-soft)] shadow-xs backdrop-blur motion-safe:transition-transform motion-safe:hover:-rotate-2 motion-safe:hover:scale-[1.04] hover:text-[color:var(--ink-strong)]"
              >
                <Hourglass className="size-3 shrink-0 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
                <span className="tabular-nums">{chronosBadgeLine(chronos)}</span>
                <ArrowRight
                  className="size-3 shrink-0 text-[color:var(--accent-iris-deep)] opacity-0 motion-safe:transition-opacity group-hover/badge:opacity-100"
                  aria-hidden="true"
                />
              </button>
            </div>
            <h1 className="font-serif-claude text-[length:var(--text-display)] leading-[var(--lh-display)] font-bold tracking-[-0.025em] text-[color:var(--ink-strong)]">
              {greeting}。
            </h1>
            <p
              data-brand-slogan=""
              className="mt-1 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]"
            >
              <span className="font-medium text-[color:var(--ink-strong)]">{BRAND_SLOGAN}</span>
              <span aria-hidden="true" className="mx-1.5 opacity-40">·</span>
              <span>{BRAND_SLOGAN_NOTE}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onOpenChronosDigest && (
              <Button
                variant="secondary"
                data-open-chronos-digest=""
                onClick={onOpenChronosDigest}
                title="查看今日 / 近 7 日沉淀手记，一键复制带原文溯源的 Markdown 日报或周报"
              >
                <BookMarked className="h-3.5 w-3.5 text-[color:var(--accent-iris-deep)]" />
                <span>司辰手记</span>
              </Button>
            )}
            <Button variant="secondary" onClick={onOpenPanorama}>
              <Orbit className="h-3.5 w-3.5 text-[color:var(--accent-iris-deep)]" />
              <span>全景星图</span>
            </Button>
            <Button variant="primary" onClick={onOpenPackageBoard}>
              <Layers className="h-3.5 w-3.5" />
              <span>任务包看板</span>
            </Button>
          </div>
        </header>

        {/* 多项目工作台总览条（Quiet.md 多目录平级卡片 + 跨项目待拍板与动态） */}
        {multiProject && multiProject.projects.length > 0 && (
          <div
            className="glx-hero-reveal"
            style={{ '--glx-stagger': 1 } as React.CSSProperties}
          >
            <MultiProjectOverviewStrip
              overview={multiProject.overview}
              projects={multiProject.projects}
              activeProjectId={multiProject.activeProjectId}
              onAddProject={multiProject.onAddProject}
              onFocusProject={multiProject.onFocusProject}
              onOpenCrossDecision={multiProject.onOpenCrossDecision}
              onOpenCrossFile={multiProject.onOpenCrossFile}
            />
          </div>
        )}

        {/* 专题橱窗（v0.8）：卡 A 待拍板决策 / 卡 B 今日最活跃专项 */}
        <div
          className="glx-hero-reveal"
          style={{ '--glx-stagger': 2 } as React.CSSProperties}
        >
          <FeaturedFocusCards
            decisionItems={decisionItems}
            decisionCount={decisionCount}
            activePackage={activePackageInfo}
            onOpenDecision={onOpenDecision ?? (() => {})}
            onOpenPackageBoard={onOpenPackageBoard}
          />
        </div>

        {/* 任务包橱窗（C2） */}
        <div
          className="glx-hero-reveal"
          style={{ '--glx-stagger': 3 } as React.CSSProperties}
        >
          <TaskPackageGallery
            packages={packages}
            fileById={fileById}
            svgDataUris={svgDataUris}
            onOpenDoc={onOpenDoc}
            stateOverview={stateOverview}
            onOpenFileContextMenu={systemActions?.onOpenFileContextMenu}
          />
        </div>

        {/* 近期待阅：V07 coss Frame + FramePanel 精密托盘，带阶段胶囊与快速已读勾选 */}
        <section
          aria-label="近期待阅"
          className="glx-hero-reveal"
          style={{ '--glx-stagger': 4 } as React.CSSProperties}
        >
          <Frame className="border border-border/75 shadow-xs">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <h2 className="text-[14.5px] leading-5 font-semibold tracking-tight text-foreground">
                  {highValueReadingHeading(highValueStats)}
                </h2>
              </div>
              {highValueStats.pendingCount > todoEntries.length && (
                <Badge variant="outline" size="sm" className="font-mono tabular-nums whitespace-nowrap">
                  展示前 {todoEntries.length} 条
                </Badge>
              )}
            </div>
            <FramePanel className="p-3">
              <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                {todoEntries.length === 0 && (
                  <p className="col-span-full py-6 text-center text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-muted-foreground">
                    {files.length === 0 ? '数据就绪后展示近期待阅' : '核心文档均已读过'}
                  </p>
                )}
                {todoEntries.map((entry) => {
                  const file = fileById.get(entry.fileId);
                  const rev = file ? currentRevisionOf(file) : null;
                  const accent = STAGE_ACCENT[entry.category];
                  return (
                    <div
                      key={entry.fileId}
                      onContextMenu={(e) => {
                        if (!systemActions?.onOpenFileContextMenu || !file) return;
                        e.preventDefault();
                        e.stopPropagation();
                        systemActions.onOpenFileContextMenu(e, {
                          kind: 'file',
                          relativePath: file.relative_path,
                          title: file.title,
                          fileId: file.file_id,
                          revisionId: rev?.revision_id ?? file.current_revision_id,
                        });
                      }}
                      className="group flex items-center gap-3 rounded-xl border border-border/75 bg-card px-3.5 py-2.5 shadow-xs hover:border-ring/40 hover:shadow-sm motion-safe:transition-all"
                    >
                      <span
                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] leading-none font-medium"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${accent} 15%, transparent)`,
                          color: 'var(--ink-strong)',
                        }}
                        aria-hidden="true"
                      >
                        <span
                          className="size-1.5 rounded-full"
                          style={{ backgroundColor: accent }}
                        />
                        {entry.category}
                      </span>
                      <button
                        type="button"
                        onClick={() => onResumeReading(entry.fileId)}
                        title={entry.dirPrefix ? `${entry.dirPrefix}/${entry.title}` : entry.title}
                        className="min-w-0 flex-1 cursor-pointer text-left"
                      >
                        <span className="block truncate text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-foreground group-hover:text-[color:var(--accent-iris-deep)] motion-safe:transition-colors">
                          {entry.title}
                        </span>
                        {entry.dirPrefix && (
                          <span className="block truncate font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-muted-foreground">
                            {entry.dirPrefix}
                          </span>
                        )}
                      </button>
                      <span
                        aria-hidden="true"
                        className="hidden sm:inline-flex shrink-0 items-center gap-0.5 font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-deep)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 motion-safe:transition-opacity"
                      >
                        续读
                        <ArrowRight className="size-3" />
                      </span>
                      <IconButton
                        label={`标记「${entry.title}」整篇已读`}
                        title="标记整篇已读"
                        disabled={!rev}
                        onClick={() => rev && onMarkFullyRead(entry.fileId, rev.revision_id)}
                        className="shrink-0 !size-7 !rounded-full hover:!border-[color:var(--stage-ink-deliver)] hover:!text-[color:var(--stage-ink-deliver-text)]"
                      >
                        <Check />
                      </IconButton>
                    </div>
                  );
                })}
              </div>
            </FramePanel>
          </Frame>
        </section>

        <div
          className="glx-hero-reveal grid grid-cols-1 gap-5 xl:grid-cols-3"
          style={{ '--glx-stagger': 5 } as React.CSSProperties}
        >
          {/* 事件走势：V07 coss CardFrame 自适应渐变柱图 + 峰值暖琥珀加冕 + 底部三指标平衡条 */}
          <CardFrame
            aria-label="事件走势"
            className="flex flex-col rounded-2xl border border-border/80 bg-card p-5 shadow-xs xl:col-span-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[15px] leading-[22px] font-semibold tracking-tight text-foreground">
                事件走势
              </h2>
              <div className="flex items-center gap-1.5">
                {/* U10：日历次级直跳——落点 = 最近一个有事件的直跳日（latestJumpableTrendDate
                    真实派生，不造「峰值日」概念）；缺 onOpenCalendarAt 时入口不渲染 */}
                {calendarJumpDate && onOpenCalendarAt && (
                  <button
                    type="button"
                    data-home-trend-calendar-jump={calendarJumpDate}
                    onClick={() => onOpenCalendarAt(calendarJumpDate)}
                    title={`在全景日历中查看 ${calendarJumpDate} 并锁定聚焦`}
                    aria-label={`在全景日历中查看 ${calendarJumpDate} 并锁定聚焦`}
                    className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--accent-iris-deep)] motion-safe:transition-colors hover:bg-[color:var(--chip-active-bg)]"
                  >
                    <CalendarDays className="size-3" aria-hidden="true" />
                    日历看 {calendarJumpDate.slice(5)}
                  </button>
                )}
                <Badge variant="outline" size="sm" className="font-mono tabular-nums whitespace-nowrap">
                  {eventDays
                    ? `${eventDays.granularity === 'day' ? '近 24 天' : `近 ${trendBars.length} 桶`} · ${trendTotal} 条`
                    : '等待数据'}
                </Badge>
              </div>
            </div>
            <div className="relative mt-6 flex min-h-[156px] flex-1 items-end gap-1.5 pb-1">
              {/* 柔和背景辅助刻度线（明暗双态自适应） */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 bottom-1 flex flex-col justify-between"
              >
                <span className="border-t border-dashed border-border/70" />
                <span className="border-t border-dashed border-border/70" />
                <span className="border-t border-dashed border-border" />
              </div>
              {trendBars.length === 0 && (
                <p className="relative z-[1] w-full self-center text-center text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
                  暂无按日聚合的事件数据
                </p>
              )}
              {trendBars.map((g, idx) => {
                const isPeak = g.count === trendMax && g.count > 0;
                const heightPct = Math.max(8, (g.count / trendMax) * 100);
                // U10：可点击时光入口——jumpable 桶渲染为 button（data-home-trend-bar 承载
                // 精确 YYYY-MM-DD 直跳载荷）；week/month 聚合桶与畸形键保持 div（诚实禁跳，
                // 不可假装能定位到某日）。柱高仍是 inline height:%（视觉量，非动画量——
                // 生长动效只有既有 glx-bar-rise 的 scaleY）。
                const barCore = (
                  <>
                    <div
                      className="glx-bar-rise w-full rounded-t-[var(--r-ctl)] motion-safe:transition-opacity group-hover/bar:opacity-90"
                      style={
                        {
                          '--glx-bar-idx': idx,
                          height: `${heightPct}%`,
                          backgroundColor: isPeak
                            ? 'var(--accent-wave)'
                            : 'var(--accent-iris-deep)',
                          opacity: g.count > 0 ? 1 : 0.22,
                        } as React.CSSProperties
                      }
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -top-7 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md bg-[color:var(--ink-anchor)] px-2 py-0.5 font-mono text-[10px] leading-none text-[color:var(--paper-on-ink)] opacity-0 shadow-md group-hover/bar:opacity-100 motion-safe:transition-opacity tabular-nums"
                    >
                      {g.jumpable
                        ? `${g.date.slice(5)} · ${g.count} 条 · 点击前往该日`
                        : `${g.date.slice(5)} · ${g.count} 条 · 聚合桶不可直跳`}
                    </span>
                  </>
                );
                if (!g.jumpable) {
                  return (
                    <div
                      key={g.date}
                      data-home-trend-bar={g.date}
                      data-home-trend-jumpable="false"
                      className="group/bar relative z-[1] flex h-full min-w-0 flex-1 items-end"
                      title={`${g.date} · ${g.count} 条事件（非按日聚合，不可直跳定位）`}
                    >
                      {barCore}
                    </div>
                  );
                }
                return (
                  <button
                    key={g.date}
                    type="button"
                    data-home-trend-bar={g.date}
                    data-home-trend-jumpable="true"
                    onClick={() =>
                      onOpenPanoramaAt ? onOpenPanoramaAt(g.date) : onOpenPanorama()
                    }
                    aria-label={`${g.date} · ${g.count} 条事件，点击前往该日全景星图`}
                    className="group/bar relative z-[1] flex h-full min-w-0 flex-1 cursor-pointer items-end"
                    title={`${g.date} · ${g.count} 条事件 · 点击前往该日`}
                  >
                    {barCore}
                  </button>
                );
              })}
            </div>
            {trendBars.length > 0 && (() => {
              const activeBuckets = trendBars.filter((b) => b.count > 0).length;
              const avgPerActive = activeBuckets > 0 ? (trendTotal / activeBuckets).toFixed(1) : '0.0';
              return (
                <div className="mt-2.5 space-y-3">
                  <div className="flex items-center justify-between text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono text-[color:var(--ink-soft)] tabular-nums">
                    <span>{trendBars[0].date}</span>
                    <span className="text-[10px] opacity-75">峰值 {trendMax} 条/日</span>
                    <span>{trendBars[trendBars.length - 1].date}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5 border-t border-[color:var(--glass-hairline)] pt-3">
                    <div className="rounded-[10px] bg-[color:var(--depth-0-base)] px-3 py-2">
                      <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--ink-soft)]">
                        活跃时段
                      </span>
                      <span className="mt-0.5 block font-mono text-[15px] font-semibold tabular-nums text-[color:var(--ink-strong)]">
                        {activeBuckets} <span className="font-sans text-[11px] font-normal text-[color:var(--ink-soft)]">{eventDays?.granularity === 'day' ? '天' : '桶'}</span>
                      </span>
                    </div>
                    <div className="rounded-[10px] bg-[color:var(--depth-0-base)] px-3 py-2">
                      <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--ink-soft)]">
                        日均节奏
                      </span>
                      <span className="mt-0.5 block font-mono text-[15px] font-semibold tabular-nums text-[color:var(--ink-strong)]">
                        {avgPerActive} <span className="font-sans text-[11px] font-normal text-[color:var(--ink-soft)]">条</span>
                      </span>
                    </div>
                    <div className="rounded-[10px] bg-[color:var(--depth-0-base)] px-3 py-2">
                      <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--ink-soft)]">
                        单日峰值
                      </span>
                      <span className="mt-0.5 block font-mono text-[15px] font-semibold tabular-nums text-[color:var(--accent-wave)]">
                        {trendMax} <span className="font-sans text-[11px] font-normal text-[color:var(--ink-soft)]">条</span>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </CardFrame>

          {/* 最近 7 天 */}
          <CardFrame
            aria-label="最近七天文档"
            className="flex flex-col rounded-2xl border border-border/80 bg-card p-5 shadow-xs"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[15px] leading-[22px] font-semibold tracking-tight text-foreground">
                  最近 7 天
                </h2>
                <span className="font-mono text-[10.5px] tracking-[0.12em] uppercase text-muted-foreground">
                  RECENT
                </span>
              </div>
              <Badge variant="outline" size="sm" className="font-mono tabular-nums whitespace-nowrap">
                {recentItems.length} 份
              </Badge>
            </div>
            <div className="mt-3 flex-1 space-y-1">
              {recentItems.length === 0 && (
                <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2.5 text-center">
                  <span
                    aria-hidden="true"
                    className="inline-flex size-10 items-center justify-center rounded-full bg-muted"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="size-5">
                      <circle cx="12" cy="12" r="9" stroke="var(--accent-iris)" strokeOpacity="0.35" strokeWidth="1.2" strokeDasharray="2 3" />
                      <circle cx="12" cy="12" r="5" stroke="var(--accent-iris)" strokeOpacity="0.65" strokeWidth="1.2" />
                      <circle cx="12" cy="12" r="2" fill="var(--accent-iris-deep)" />
                    </svg>
                  </span>
                  <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-muted-foreground">
                    近 7 天没有新文档落进工作区
                  </p>
                  <button
                    type="button"
                    onClick={onOpenPanorama}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-[color:var(--accent-iris-deep)] hover:bg-[color:var(--chip-active-bg)] motion-safe:transition-colors"
                  >
                    去全景星图回溯历史
                    <ArrowRight className="size-3" />
                  </button>
                </div>
              )}
              {recentItems.map((item) => {
                const file = fileById.get(item.file_id);
                return (
                <button
                  key={item.file_id}
                  type="button"
                  onClick={() => onOpenDoc(item.file_id)}
                  onContextMenu={(e) => {
                    if (!systemActions?.onOpenFileContextMenu || !file) return;
                    e.preventDefault();
                    e.stopPropagation();
                    systemActions.onOpenFileContextMenu(e, {
                      kind: 'file',
                      relativePath: file.relative_path,
                      title: file.title,
                      fileId: file.file_id,
                      revisionId: file.current_revision_id,
                    });
                  }}
                  title={item.title}
                  className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left motion-safe:transition-colors hover:bg-accent/70"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: formatUiMeta(item.format).dotColor }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium text-foreground group-hover:text-[color:var(--accent-iris-deep)] motion-safe:transition-colors">
                    {item.title}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-muted-foreground group-hover:bg-card motion-safe:transition-colors">
                    {item.format}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono text-muted-foreground tabular-nums">
                    {item.date.slice(5)}
                  </span>
                </button>
                );
              })}
            </div>
          </CardFrame>
        </div>
      </div>
    </div>
  );
};

export default HomeView;
