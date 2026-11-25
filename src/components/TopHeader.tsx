import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronDown,
  ClipboardCopy,
  ClipboardList,
  FileText,
  FolderOpen,
  FolderPlus,
  HelpCircle,
  Lock,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import type { DesktopSessionState, RecentWorkspaceStatus } from '../services/desktopBridge';
import type { ProjectEntryDto } from '../services/apiTypes';
import { DecisionAssertion, DecisionSourceEvidence, FileFormat, FileRecord, WorkspaceConfig } from '../types/guanlan';
import { SearchHit, unreadStatusLabel } from '../utils/guanlanEngine';
// 搜索结果只显【任务包名 + 核心文件名】，完整路径进 title
import { basenameOf } from '../utils/documentIdentity';
import { taskPackageOf } from '../utils/taskPackages';
import type { WorkspaceSource, FileFacets } from '../services/workspaceClient';
import { FilterDropdown, SidebarFilters } from './LeftSidebar';
import { DecisionRadar } from './DecisionRadar';
import ReadingIsland from './ReadingIsland';
import { ShortcutsCheatSheetModal } from './ShortcutsCheatSheetModal';
import type { ReadingStateMap } from '../utils/readingStateStore';
import { formatRelativeObservedAt } from '../utils/timeFormat';
import { formatLabel } from '../utils/formatMeta';
import { BRAND_NAME, BRAND_SLOGAN } from '../utils/brandIdentity';
import { BrandMark } from './BrandMark';
// 存储容错：渲染路径禁止裸读 localStorage（阻止所有 Cookie 等环境首访即抛
// SecurityError，TopHeader 渲染失败=App 整树白屏）
import { safeStorageGet } from '../utils/safeStorage';
// 全站明暗主题一键切换（直连 appThemeStore 单一真相源，持久化 + DOM .dark 同步）
import {
  appThemeModeLabel,
  applyAppTheme,
  getAppThemeMode,
  getResolvedAppTheme,
  nextAppThemeMode,
  subscribeAppTheme,
  type AppThemeMode,
  type ResolvedAppTheme,
} from '../stores/appThemeStore';
// 壳层控件一律取 primitives + coss 原语（Toolbar / Group / GroupSeparator / Kbd）
import { Button, IconButton, Tabs } from './ui/primitives';
import type { ChipStage } from './ui/primitives';
import { Group, GroupSeparator, Kbd, Toolbar } from './ui';

// 顶层枚举为三工作区：
// 'home'=今日观澜首页（默认落地；见 HomeView）、
// 'panorama'=全景溯源（星图/列表/日历三态，见 GraphCanvasView 的 PanoramaMode）、
// 'library'=知识资产库（阅读/概览两态，见下方 LibraryMode）
export type PrimaryTab = 'home' | 'panorama' | 'library';

// 知识资产库内部模式：'read'=ReaderView 中栏、'overview'=AtlasView embedded 卡片墙铺满中栏
export type LibraryMode = 'read' | 'overview';

interface TopHeaderProps {
  activeTab: PrimaryTab;
  onSelectTab: (tab: PrimaryTab) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchHits: SearchHit[];
  onSelectSearchHit: (hit: SearchHit) => void;
  unreadFilesCount: number;
  contextBasketCount: number;
  /** 顶栏计数来自真实数据（事件条数），非静态演示数字 */
  eventCount: number;
  /** 未决决策雷达的数据面（只读；候选不计入） */
  decisions: DecisionAssertion[];
  /** 服务端全库未决待拍板真实总数 */
  decisionsUnresolvedTotal?: number | null;
  /** 点一行跳到该决策首条证据原文（复用 App.handleOpenDecisionReference） */
  onOpenDecision: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
  /** 未决决策受控展开信号（App 侧递增计数，如左栏主导航「未决决策」命中）——
   *  本文件只做转发，展开/关闭逻辑归 DecisionRadar 本体 */
  openSignal?: number;
  config: WorkspaceConfig;
  /** 数据同步三态胶囊的数据源：real=已同步 / loading=对账中 / error=同步失败 */
  dataSource: 'loading' | WorkspaceSource;
  /** 胶囊 title 悬浮的对账摘要（rootPath · scanSummary） */
  scanSummary: string;
  /** error 态胶囊 title 展示的失败原因 */
  dataError: string | null;
  /** 筛选下拉的数据面（App 传 filteredFiles，筛选同时驱动阅读列表与概览卡片墙） */
  files: FileRecord[];
  /** 服务侧 facets（/api/v1/files），格式筛选计数优先取之；缺省回退本地计数 */
  facets?: FileFacets | null;
  sidebarFilters: SidebarFilters;
  onUpdateSidebarFilters: (next: Partial<SidebarFilters>) => void;
  onResetSidebarFilters: () => void;
  /** 知识资产库 阅读/概览 切换（仅 activeTab==='library' 时渲染在页签行内） */
  libraryMode: LibraryMode;
  onLibraryModeChange: (mode: LibraryMode) => void;
  onOpenSettings: () => void;
  onOpenMcpConsole: () => void;
  onOpenContextDrawer: () => void;
  /** 批阅看板抽屉入口（五态 + 失联 unknown 提示计数） */
  onOpenReviewBoard?: () => void;
  reviewBoardAttentionCount?: number;
  /** 最后一次索引时间（ISO 串）；null = 从未扫描过 */
  lastScanAt?: string | null;
  /** 是否有索引任务在跑 */
  isScanning?: boolean;
  /** 手动触发一轮整库核验 */
  onRescan?: () => void;
  /** 是否已启用后台 File Watcher（--watch / 桌面壳为 true） */
  watcherEnabled?: boolean;
  /** 多工作区管理（桌面壳注入桥；浏览器端如实展示当前接入工作区） */
  desktopWorkspaceSupported?: boolean;
  desktopGateStatus?: DesktopSessionState['status'] | null;
  workspaceName?: string | null;
  recentWorkspaces?: RecentWorkspaceStatus[];
  switchingWorkspace?: boolean;
  workspaceSwitchError?: string | null;
  onPickWorkspaceFolder?: () => void;
  onSwitchWorkspace?: (root: string) => void;
  onRemoveRecentWorkspace?: (root: string) => void;
  /** 统一顶部「?」帮助与操作提示浮层受控状态（支持快捷键 ? / Esc 同步开合，移除右下角重叠浮钮） */
  helpOpen?: boolean;
  onHelpOpenChange?: (open: boolean) => void;
  /** Quiet.md 全局常驻目录侧栏折叠/展开切换 */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /** Quiet.md 多项目并存：顶栏项目快切列表与添加入口（桌面/浏览器双端一致可用） */
  managedProjects?: ProjectEntryDto[];
  activeProjectId?: string;
  onActivateProject?: (projectId: string) => void;
  onOpenAddProject?: () => void;
  /** 阅读与存档顶栏微胶囊 + Sheet(inset) 入口（替代右缘 fixed 遮挡悬浮条） */
  readingIslandFiles?: FileRecord[];
  readingStates?: ReadingStateMap;
  onOpenDocFromIsland?: (fileId: string) => void;
  onMarkFileReadFromIsland?: (fileId: string, revisionId: string) => void;
  onMarkFileUnreadFromIsland?: (fileId: string) => void;
  onMarkReadingBaselineFromIsland?: () => Promise<boolean> | void;
}

/* 品牌徽见 ./BrandMark.tsx：与桌面壳图标同源的司辰翼漏银匣徽
   （透明底曜石缎面文件夹 + 折耳朱砂眼 + 象牙夹页 + 对称拉丝银翼与铂银朱砂沙漏），由 src/utils/brandIdentity.ts
   的品牌口径驱动顶栏标题与 Slogan。 */

export const TopHeader: React.FC<TopHeaderProps> = ({
  activeTab,
  onSelectTab,
  searchQuery,
  onSearchChange,
  searchHits,
  onSelectSearchHit,
  unreadFilesCount,
  contextBasketCount,
  eventCount,
  decisions,
  decisionsUnresolvedTotal,
  onOpenDecision,
  openSignal,
  config,
  dataSource,
  scanSummary,
  dataError,
  files,
  facets,
  sidebarFilters,
  onUpdateSidebarFilters,
  onResetSidebarFilters,
  libraryMode,
  onLibraryModeChange,
  onOpenSettings,
  onOpenMcpConsole,
  onOpenContextDrawer,
  onOpenReviewBoard,
  reviewBoardAttentionCount = 0,
  lastScanAt,
  isScanning,
  onRescan,
  watcherEnabled,
  desktopWorkspaceSupported = false,
  desktopGateStatus = null,
  workspaceName = null,
  recentWorkspaces = [],
  switchingWorkspace = false,
  workspaceSwitchError = null,
  onPickWorkspaceFolder,
  onSwitchWorkspace,
  onRemoveRecentWorkspace,
  helpOpen,
  onHelpOpenChange,
  sidebarCollapsed = false,
  onToggleSidebar,
  managedProjects = [],
  activeProjectId = '',
  onActivateProject,
  onOpenAddProject,
  readingIslandFiles,
  readingStates,
  onOpenDocFromIsland,
  onMarkFileReadFromIsland,
  onMarkFileUnreadFromIsland,
  onMarkReadingBaselineFromIsland,
}) => {
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false);
  const [workspacePathInput, setWorkspacePathInput] = useState('');
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  // 全站明暗主题细粒度订阅（light / dark / system 三态轮换，SSR 安全默认 light）
  const appThemeMode = useSyncExternalStore<AppThemeMode>(
    subscribeAppTheme,
    getAppThemeMode,
    () => 'light'
  );
  const resolvedAppTheme = useSyncExternalStore<ResolvedAppTheme>(
    subscribeAppTheme,
    getResolvedAppTheme,
    () => 'light'
  );
  const nextThemeMode = nextAppThemeMode(appThemeMode);
  const handleCycleAppTheme = () => {
    applyAppTheme(nextThemeMode);
  };

  /* 证据篮徽标微缩放脉冲（glx-badge-pop）：唯一触发源 = store 实际入篮生效——
     contextBasketCount 派生自 store 的 contextPointers.length（App.tsx 直传），计数
     「仅上升沿」即一次真实入篮落地；移除/清空等减量沿零触发，绝不假乐观伪造成功
     （QuickPreviewModal 的点击回调不在触发链上）。basketPulseSeq 以 key 重挂重播
     动画：上升沿递增 → 重挂 → 播一次 --dur-2 spring 微缩放；减量沿 seq 不动 →
     不重挂不重播。首次挂载（seq=0）不挂动画类，应用启动零空脉冲。 */
  const [basketPulseSeq, setBasketPulseSeq] = useState(0);
  const basketCountPrevRef = useRef<number | null>(null);
  const basketPrev = basketCountPrevRef.current;
  const isBasketInsert = basketPrev !== null && contextBasketCount > basketPrev;
  if (basketPrev !== contextBasketCount) {
    basketCountPrevRef.current = contextBasketCount;
  }
  if (isBasketInsert) {
    setBasketPulseSeq((s) => s + 1);
  }

  /* 统一顶部「?」帮助浮层（融合工作区快照 + 当前视图操作提示 + Esc 优先级，
     彻底消除原右下角悬浮 ? 钮对检查器与日历的遮挡；支持外部 ? 快捷键受控开关）。 */
  const [internalHelpOpen, setInternalHelpOpen] = useState(false);
  const isHelpOpen = helpOpen !== undefined ? helpOpen : internalHelpOpen;
  const setIsHelpOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(isHelpOpen) : next;
    if (onHelpOpenChange) onHelpOpenChange(resolved);
    else setInternalHelpOpen(resolved);
  };
  const helpRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setIsWorkspaceMenuOpen(false);
    setWorkspacePathInput('');
  }, [config.rootPath]);

  useEffect(() => {
    if (!isWorkspaceMenuOpen) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setIsWorkspaceMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setIsWorkspaceMenuOpen(false);
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isWorkspaceMenuOpen]);

  useEffect(() => {
    if (!isHelpOpen) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (helpRootRef.current && !helpRootRef.current.contains(e.target as Node)) {
        setIsHelpOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setIsHelpOpen(false);
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isHelpOpen]);

  const formatCoverageLabel = (
    coverage: SearchHit['coverage'],
    format: FileFormat
  ) => {
    if (coverage === 'full_text') return `${formatLabel(format)} 正文命中`;
    if (coverage === 'svg_text') return 'SVG 可提取文字';
    if (coverage === 'pdf_page_text') return 'PDF 页文本层';
    if (coverage === 'office_structured') return `${formatLabel(format)} 结构化索引`;
    if (format === 'pdf') return '仅文件名命中 (PDF 正文未索引)';
    if (format === 'svg') return '仅文件名命中 (SVG 无文字层)';
    return `仅文件名命中 (${formatLabel(format)})`;
  };

  // 顶栏状态与时效合一胶囊：把「同步态 + 时效 + 重新扫描」收敛成一枚精密分段遥测胶囊，
  // 既保留全部诚实语义与点击入口，又彻底释放 1280/1440px 视口宽度，消除二级页签碰撞。
  const renderTelemetryCluster = () => {
    const scannedAt = lastScanAt ?? null;
    const ageMinutes = scannedAt
      ? Math.floor((Date.now() - new Date(scannedAt).getTime()) / 60000)
      : null;
    const fresh = ageMinutes !== null && ageMinutes < 60;
    const freshnessShort = scannedAt ? formatRelativeObservedAt(scannedAt) : '未扫描';

    const syncMeta: {
      stage: ChipStage;
      dotColor: string;
      textColor: string;
      tintBg: string;
      borderTint: string;
      title: string;
      label: string;
    } =
      desktopGateStatus && desktopGateStatus !== 'ready'
        ? desktopGateStatus === 'root_in_use'
          ? {
              stage: 'decision',
              dotColor: 'var(--stage-ink-decision)',
              textColor: 'var(--stage-ink-decision-text)',
              tintBg: 'color-mix(in srgb, var(--stage-ink-decision) 9%, white)',
              borderTint: 'color-mix(in srgb, var(--stage-ink-decision) 34%, transparent)',
              title: '目标工作区正被另一实例占用，请在面板中选择恢复或换目录',
              label: '目录被占用',
            }
          : desktopGateStatus === 'error'
            ? {
                stage: 'exec',
                dotColor: 'var(--stage-ink-exec)',
                textColor: 'var(--stage-ink-exec-text)',
                tintBg: 'color-mix(in srgb, var(--stage-ink-exec) 10%, var(--card))',
                borderTint: 'color-mix(in srgb, var(--stage-ink-exec) 34%, transparent)',
                title: '工作区接入失败，请重新选择目录',
                label: '接入失败',
              }
            : {
                stage: 'anomaly',
                dotColor: 'var(--stage-ink-anomaly)',
                textColor: 'var(--stage-ink-anomaly-text)',
                tintBg: 'color-mix(in srgb, var(--stage-ink-anomaly) 10%, var(--card))',
                borderTint: 'color-mix(in srgb, var(--stage-ink-anomaly) 34%, transparent)',
                title: '请选择一个本地工作区文件夹开始',
                label: '未选择目录',
              }
        : dataSource === 'real'
          ? isScanning
            ? {
                stage: 'decision',
                dotColor: 'var(--accent-iris-deep)',
                textColor: 'var(--accent-iris-ink)',
                tintBg: 'color-mix(in srgb, var(--accent-iris) 10%, var(--card))',
                borderTint: 'color-mix(in srgb, var(--accent-iris) 30%, transparent)',
                title: '正在扫描工作区，把最新文档并入索引…',
                label: '扫描中…',
              }
            : {
                stage: fresh || !scannedAt ? 'deliver' : 'decision',
                dotColor: fresh || !scannedAt ? 'var(--stage-ink-deliver)' : 'var(--stage-ink-decision)',
                textColor: fresh || !scannedAt ? 'var(--ink-soft)' : 'var(--stage-ink-decision-text)',
                tintBg:
                  fresh || !scannedAt
                    ? 'transparent'
                    : 'color-mix(in srgb, var(--stage-ink-decision) 9%, var(--card))',
                borderTint:
                  fresh || !scannedAt
                    ? 'transparent'
                    : 'color-mix(in srgb, var(--stage-ink-decision) 32%, transparent)',
                title: `${config.rootPath} · ${scanSummary} · 共 ${config.enumSnapshot.totalCount} 份\n${
                  scannedAt
                    ? watcherEnabled
                      ? `最后一次索引：${scannedAt}（${freshnessShort} · 已开启后台监听）`
                      : `最后一次索引：${scannedAt}（${freshnessShort} · 点击右侧可重扫）`
                    : '尚未扫描工作区'
                }`,
                label: '已同步',
              }
          : dataSource === 'error'
            ? {
                stage: 'exec',
                dotColor: 'var(--stage-ink-exec)',
                textColor: 'var(--stage-ink-exec-text)',
                tintBg: 'color-mix(in srgb, var(--stage-ink-exec) 10%, var(--card))',
                borderTint: 'color-mix(in srgb, var(--stage-ink-exec) 34%, transparent)',
                title: dataError ?? '工作区数据加载失败',
                label: '同步失败',
              }
            : {
                stage: 'decision',
                dotColor: 'var(--stage-ink-decision)',
                textColor: 'var(--stage-ink-decision-text)',
                tintBg: 'color-mix(in srgb, var(--stage-ink-decision) 10%, var(--card))',
                borderTint: 'color-mix(in srgb, var(--stage-ink-decision) 32%, transparent)',
                title: '正在读取持久历史（首次对账需要数秒）',
                label: '对账中…',
              };

    const rescanDisabled =
      isScanning || (Boolean(desktopGateStatus) && desktopGateStatus !== 'ready');
    const isLiveSynced =
      (!desktopGateStatus || desktopGateStatus === 'ready') &&
      dataSource === 'real' &&
      !isScanning &&
      (fresh || !scannedAt);
    const isCalmSynced = isLiveSynced;

    if (isCalmSynced) {
      // 常态已同步保持静默：仅以轻刷新图标 + 极微弱状态点呈现，悬浮可见完整同步详情；
      // 仅在扫描中/滞后/未连接/异常时展开完整状态标签。
      return (
        <Group
          aria-label="工作区同步状态"
          data-header-sync-group=""
          className="h-7 shrink-0 border-0 bg-transparent shadow-none"
        >
          <button
            type="button"
            onClick={() => onRescan?.()}
            disabled={rescanDisabled}
            aria-label="重新扫描"
            title={`${syncMeta.title}${scannedAt ? `\n最近同步：${freshnessShort}` : ''}\n点击重新扫描工作区`}
            className="group/refresh relative inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] disabled:cursor-not-allowed disabled:opacity-40 motion-safe:transition-colors"
          >
            <RefreshCw className="size-3.5 shrink-0 motion-safe:transition-transform group-hover/refresh:rotate-45" />
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 size-1.5 rounded-full"
              style={{ backgroundColor: syncMeta.dotColor }}
            />
            <span className="sr-only">{syncMeta.label}</span>
          </button>
        </Group>
      );
    }

    return (
      <Group
        aria-label="工作区同步状态"
        data-header-sync-group=""
        className="h-7 shrink-0 overflow-hidden rounded-lg border shadow-xs motion-safe:transition-colors hover:shadow-sm"
        style={{
          backgroundColor: syncMeta.tintBg,
          borderColor: syncMeta.borderTint,
        }}
      >
        <button
          type="button"
          onClick={onOpenSettings}
          title={`${syncMeta.title}${scannedAt ? `\n最近同步：${freshnessShort}` : ''}`}
          className="inline-flex h-full cursor-pointer items-center gap-1.5 pl-2 pr-1.5 text-[11.5px] leading-none font-medium hover:bg-accent/70 motion-safe:transition-colors"
          style={{ color: syncMeta.textColor }}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${isScanning ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: syncMeta.dotColor, color: syncMeta.dotColor }}
          />
          <span className="whitespace-nowrap">{syncMeta.label}</span>
        </button>
        <GroupSeparator
          className="h-3.5 self-center"
          style={{ backgroundColor: syncMeta.borderTint }}
        />
        <button
          type="button"
          onClick={() => onRescan?.()}
          disabled={rescanDisabled}
          aria-label={isScanning ? '扫描中' : '重新扫描'}
          title={isScanning ? '正在扫描工作区…' : `重新扫描工作区（最近：${freshnessShort}）`}
          className="group/refresh inline-flex h-full cursor-pointer items-center justify-center px-1.5 text-[color:var(--ink-soft)] hover:bg-accent/80 hover:text-[color:var(--ink-strong)] disabled:cursor-not-allowed disabled:opacity-40 motion-safe:transition-colors"
        >
          <RefreshCw className={`size-3 shrink-0 motion-safe:transition-transform ${isScanning ? 'animate-spin text-[color:var(--accent-iris-deep)]' : 'group-hover/refresh:rotate-45'}`} />
        </button>
      </Group>
    );
  };

  return (
    <header className="relative z-30 select-none bg-background dark:bg-background text-[color:var(--ink-strong)] border-b border-border">
      {/* 顶栏紧凑布局（lg 以上单行 --chrome-h 52px；窄屏与 200% 缩放自动折行零裁切） */}
      <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-x-2 gap-y-1.5 px-2.5 sm:px-3.5 py-1.5 lg:py-0 min-h-[var(--chrome-h)] lg:h-[var(--chrome-h)] min-w-0 max-w-full">
        {/* Left Zone: 目录栏开关 + Brand Breadcrumb + 工作区切换 + 工作区页签 */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 min-w-0 max-w-full">
          {onToggleSidebar && (
            <IconButton
              label={sidebarCollapsed ? '展开左侧目录栏' : '收起左侧目录栏'}
              title={sidebarCollapsed ? '展开左侧目录栏 (Ctrl+\\)' : '收起左侧目录栏 (Ctrl+\\)'}
              aria-pressed={!sidebarCollapsed}
              data-toggle-directory-sidebar=""
              onClick={onToggleSidebar}
              className="cursor-pointer !size-7 !rounded-[var(--r-ctl)] shrink-0"
            >
              {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </IconButton>
          )}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              onSelectTab('home');
            }}
            title={`${BRAND_NAME} · ${BRAND_SLOGAN} · 返回今日首页`}
            aria-label={`${BRAND_NAME}，${BRAND_SLOGAN}，返回今日首页`}
            data-brand-lockup="header"
            className="flex items-center gap-2 whitespace-nowrap shrink-0 group cursor-pointer"
          >
            <BrandMark
              size="sm"
              className="motion-safe:transition-transform motion-safe:duration-150 group-hover:scale-[1.04]"
            />
            <span className="flex flex-col leading-none">
              <span className="font-serif-claude whitespace-nowrap text-[14.5px] leading-[16px] font-semibold tracking-[-0.015em] text-[color:var(--ink-strong)] group-hover:text-[color:var(--accent-iris-deep)] motion-safe:transition-colors">
                {BRAND_NAME}
              </span>
              <span className="hidden xl:block mt-0.5 whitespace-nowrap text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium tracking-tight text-[color:var(--ink-soft)]">
                {BRAND_SLOGAN}
              </span>
            </span>
          </a>

          {/* 当前工作区与多工作区秒切菜单 */}
          {(config.rootPath || desktopWorkspaceSupported) && (
            <div className="relative min-w-0 shrink-0" ref={workspaceMenuRef}>
              <button
                type="button"
                data-workspace-switcher
                aria-expanded={isWorkspaceMenuOpen}
                onClick={() => setIsWorkspaceMenuOpen((v) => !v)}
                title={config.rootPath || '管理与切换项目文件夹'}
                className="flex items-center gap-1 max-w-[112px] sm:max-w-[144px] h-7 rounded-[var(--r-ctl)] border border-border bg-card hover:border-ring/40 px-2 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-strong)] cursor-pointer motion-safe:transition-colors overflow-hidden"
              >
                <FolderOpen className="w-3 h-3 shrink-0 text-[color:var(--accent-iris-deep)]" />
                <span className="truncate font-medium">
                  {managedProjects.find((p) => p.project_id === activeProjectId)?.name ||
                    workspaceName ||
                    (config.rootPath
                      ? config.rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || config.rootPath
                      : '未选择项目')}
                </span>
                {managedProjects.length > 1 && (
                  <span className="shrink-0 rounded-full px-1.5 py-0 font-mono text-[10px] tabular-nums bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)]">
                    {managedProjects.length}
                  </span>
                )}
                <ChevronDown
                  className={`w-3 h-3 shrink-0 text-[color:var(--ink-soft)] motion-safe:transition-transform ${
                    isWorkspaceMenuOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {isWorkspaceMenuOpen && (
                <div
                  role="region"
                  aria-label="多项目管理与切换"
                  data-esc-layer="open"
                  className="glass-pop glx-popover-in absolute left-0 top-full mt-2 w-[356px] rounded-[var(--r-card)] z-50 p-3.5 space-y-2.5"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]">
                        当前聚焦项目
                      </span>
                      {onOpenAddProject && (
                        <button
                          type="button"
                          data-switcher-add-project=""
                          onClick={() => {
                            setIsWorkspaceMenuOpen(false);
                            onOpenAddProject();
                          }}
                          className="inline-flex items-center gap-1 rounded-[7px] px-2 py-0.5 text-[11px] font-medium bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] hover:bg-[color:var(--chip-active-border)]/30 cursor-pointer transition-colors"
                        >
                          <FolderPlus className="w-3 h-3" />
                          <span>添加项目</span>
                        </button>
                      )}
                    </div>
                    <div className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-strong)] break-all rounded-[var(--r-ctl)] bg-muted/60 px-2 py-1 border border-[color:var(--glass-hairline)]">
                      {config.rootPath || '尚未接入本地目录'}
                    </div>
                  </div>

                  {/* 多项目并存列表：零重启 1-click 秒切聚焦项目（桌面与浏览器统一可用） */}
                  {managedProjects.length > 0 && (
                    <div className="space-y-1 pt-1.5 border-t border-[color:var(--glass-hairline)]">
                      <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]">
                        已管理项目（{managedProjects.length}）
                      </div>
                      <div className="space-y-1 max-h-52 overflow-y-auto">
                        {managedProjects.map((proj) => {
                          const isCurrent = proj.project_id === activeProjectId;
                          const isOffline =
                            proj.status === 'offline' ||
                            proj.status === 'root_in_use' ||
                            proj.status === 'error';
                          return (
                            <button
                              key={proj.project_id}
                              type="button"
                              disabled={isOffline}
                              data-switcher-project={proj.project_id}
                              onClick={() => {
                                setIsWorkspaceMenuOpen(false);
                                if (!isCurrent) onActivateProject?.(proj.project_id);
                              }}
                              title={proj.root_path}
                              className={`w-full flex items-center justify-between gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left transition-colors ${
                                isCurrent
                                  ? 'bg-[color:var(--chip-active-bg)] border border-[color:var(--chip-active-border)]'
                                  : 'border border-transparent hover:bg-accent cursor-pointer'
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--ink-strong)] truncate">
                                  <span className="truncate">{proj.name}</span>
                                  {proj.readonly && (
                                    <Lock className="w-3 h-3 shrink-0 text-[color:var(--ink-faint)]" />
                                  )}
                                  {isCurrent && (
                                    <span className="text-[10px] text-[color:var(--accent-iris-ink)] shrink-0">
                                      当前
                                    </span>
                                  )}
                                </div>
                                <div className="font-mono text-[10.5px] text-[color:var(--ink-soft)] truncate">
                                  {proj.root_path}
                                </div>
                              </div>
                              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[color:var(--ink-soft)]">
                                {isOffline ? '离线' : `${proj.file_count} 份`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {desktopWorkspaceSupported ? (
                    <>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          fullWidth
                          disabled={switchingWorkspace}
                          data-switcher-pick-folder
                          onClick={() => {
                            setIsWorkspaceMenuOpen(false);
                            onPickWorkspaceFolder?.();
                          }}
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>{switchingWorkspace ? '切换中…' : '打开 / 切换文件夹…'}</span>
                        </Button>
                      </div>

                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const target = workspacePathInput.trim();
                          if (!target || switchingWorkspace) return;
                          onSwitchWorkspace?.(target);
                        }}
                        className="flex items-center gap-1.5"
                      >
                        <input
                          type="text"
                          data-switcher-path-input
                          value={workspacePathInput}
                          onChange={(e) => setWorkspacePathInput(e.target.value)}
                          placeholder="输入或粘贴目录路径…"
                          className="glass-input flex-1 min-w-0 rounded-[var(--r-ctl)] px-2 py-1 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-strong)] focus:outline-none"
                        />
                        <Button
                          type="submit"
                          variant="secondary"
                          size="sm"
                          disabled={switchingWorkspace || !workspacePathInput.trim()}
                          data-switcher-open-path
                        >
                          切换
                        </Button>
                      </form>

                      {workspaceSwitchError && (
                        <div
                          role="alert"
                          className="rounded-[var(--r-ctl)] border border-[color:color-mix(in_srgb,var(--stage-ink-exec)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_10%,transparent)] px-2 py-1.5 text-[length:var(--text-micro)] text-[color:var(--stage-ink-exec-text)] break-all"
                        >
                          {workspaceSwitchError}
                        </div>
                      )}

                      {recentWorkspaces.length > 0 && (
                        <div className="space-y-1 pt-1.5 border-t border-[color:var(--glass-hairline)]">
                          <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]">
                            最近工作区
                          </div>
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            {recentWorkspaces.map((entry) => {
                              const isCurrent =
                                Boolean(config.rootPath) &&
                                entry.root.replace(/\\/g, '/').toLowerCase() ===
                                  config.rootPath.replace(/\\/g, '/').toLowerCase();
                              return (
                                <div
                                  key={entry.root}
                                  className={`flex items-center justify-between gap-1.5 rounded-[var(--r-ctl)] px-2 py-1 ${
                                    isCurrent ? 'bg-[color:var(--chip-active-bg)]' : 'hover:bg-accent'
                                  }`}
                                >
                                  <button
                                    type="button"
                                    disabled={switchingWorkspace || !entry.exists || isCurrent}
                                    data-switcher-recent={entry.root}
                                    onClick={() => {
                                      setIsWorkspaceMenuOpen(false);
                                      onSwitchWorkspace?.(entry.root);
                                    }}
                                    className="flex-1 min-w-0 text-left cursor-pointer disabled:cursor-default disabled:opacity-65"
                                    title={entry.root}
                                  >
                                    <div className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium text-[color:var(--ink-strong)] truncate">
                                      {entry.name}
                                      {isCurrent && (
                                        <span className="ml-1.5 text-[length:var(--text-micro)] text-[color:var(--accent-iris-ink)]">
                                          当前
                                        </span>
                                      )}
                                      {!entry.exists && (
                                        <span className="ml-1.5 text-[length:var(--text-micro)] text-[color:var(--stage-ink-exec-text)]">
                                          目录不存在
                                        </span>
                                      )}
                                    </div>
                                    <div className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] truncate">
                                      {entry.root}
                                    </div>
                                  </button>
                                  {!isCurrent && onRemoveRecentWorkspace && (
                                    <button
                                      type="button"
                                      aria-label={`移除最近工作区 ${entry.name}`}
                                      onClick={() => onRemoveRecentWorkspace(entry.root)}
                                      className="p-0.5 text-[color:var(--ink-faint)] hover:text-[color:var(--ink-strong)] cursor-pointer"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  ) : onOpenAddProject ? (
                    <Button
                      variant="primary"
                      size="sm"
                      fullWidth
                      onClick={() => {
                        setIsWorkspaceMenuOpen(false);
                        onOpenAddProject();
                      }}
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      <span>添加本地项目文件夹…</span>
                    </Button>
                  ) : (
                    <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                      当前通过浏览器接入本地服务，多工作区秒切与原生文件夹选择器请在观澜桌面客户端中使用。
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 工作区页签：首页 / 全景溯源 / 知识资产库（去掉 20272 / 5588 等超大常驻数字，悬停 title 查看总量） */}
          <Tabs
            ariaLabel="主视图切换"
            active={activeTab}
            onChange={(key) => onSelectTab(key as PrimaryTab)}
            className="shrink-0"
            items={[
              { key: 'home', label: <span>首页</span> },
              {
                key: 'panorama',
                label: (
                  <span title={`全景溯源 · 共 ${eventCount} 条事件`}>
                    全景溯源
                  </span>
                ),
              },
              {
                key: 'library',
                label: (
                  <span
                    className="inline-flex items-center"
                    title={
                      unreadFilesCount > 0
                        ? `知识资产库 · 共 ${config.enumSnapshot.totalCount} 份 · 未读 ${unreadFilesCount} 份（${unreadStatusLabel('never_read')} / ${unreadStatusLabel('updated_since_last_read')}）`
                        : `知识资产库 · 共 ${config.enumSnapshot.totalCount} 份`
                    }
                  >
                    <span>知识资产库</span>
                  </span>
                ),
              },
            ]}
          />

          {/* 知识资产库 阅读/概览 切换：嵌在页签行内，仅 library 工作区渲染，采用标线 Tabs 语法 */}
          {activeTab === 'library' && (
            <div className="flex items-center pl-3 border-l border-[color:var(--glass-hairline)] shrink-0">
              <Tabs
                ariaLabel="知识资产库视图切换"
                active={libraryMode}
                onChange={(key) => onLibraryModeChange(key as LibraryMode)}
                items={[
                  { key: 'read', label: <span>阅读</span> },
                  { key: 'overview', label: <span>概览</span> },
                ]}
              />
            </div>
          )}
        </div>

        {/* Right Zone · coss Toolbar + Group 紧凑排布：核心行动组（检索 ⌘K · 筛选 · 未决决策 · 批阅）
            | 唯一发丝隔线 | 静默工具组（同步 Group · 阅读存档微胶囊 · 证据篮 · [主题切换 | ? | 设置] 拼接 Group）。
            确保 1280px / 1440px 明暗双态全程零折行。 */}
        <Toolbar
          aria-label="顶栏操作工具栏"
          data-header-clusters=""
          className="flex flex-wrap lg:flex-nowrap items-center max-w-full lg:shrink-0 !gap-1 !rounded-none !border-0 !bg-transparent !p-0 !shadow-none"
        >
          {/* ── 核心行动组：检索 ⌘K · 未决决策雷达 · 批阅（高频主行动） ── */}
          <div
            className="flex flex-wrap sm:flex-nowrap items-center gap-1 max-w-full"
            data-header-cluster="primary"
            role="group"
            aria-label="核心行动"
          >
            {/* Compact Search Box */}
            <div className="relative">
              <div
                className={`glass-input flex h-7 items-center rounded-[var(--r-ctl)] px-2 focus-within:border-[color:var(--ring)] focus-within:ring-2 focus-within:ring-[color:color-mix(in_srgb,var(--ring)_35%,transparent)] motion-safe:transition-all ${
                  isSearchExpanded || searchQuery
                    ? 'w-36 sm:w-40 border-[color:var(--accent-iris)] ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_22%,transparent)]'
                    : 'w-[84px] sm:w-[92px] xl:w-[108px] hover:border-[color:var(--btn-secondary-border-hover)]'
                }`}
              >
                <Search className="w-3.5 h-3.5 text-[color:var(--ink-soft)] mr-1 shrink-0" />
                <input
                  type="text"
                  aria-label="搜索文件、内容或编号"
                  value={searchQuery}
                  onFocus={() => setIsSearchExpanded(true)}
                  onBlur={() => setIsSearchExpanded(false)}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="检索"
                  className="w-full min-w-0 bg-transparent text-[color:var(--ink-strong)] placeholder-[color:var(--ink-soft)] focus-visible:outline-2 focus-visible:outline-[color:var(--ring)] rounded-[4px] text-[length:var(--text-ui)] leading-[var(--lh-ui)] motion-safe:transition-colors"
                />
                {!isSearchExpanded && !searchQuery && (
                  <Kbd className="hidden sm:inline-flex shrink-0 h-4 min-w-4 px-1 text-[length:var(--text-micro)]">
                    ⌘K
                  </Kbd>
                )}
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="清空搜索"
                    onClick={() => onSearchChange('')}
                    className="cursor-pointer text-[color:var(--ink-faint)] hover:text-[color:var(--ink-strong)] ml-1"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* Search Dropdown Results */}
              {searchQuery.trim().length > 0 && (
                <div
                  role="region"
                  aria-label="搜索结果列表"
                  className="glass-pop glx-popover-in absolute right-0 top-full mt-2 w-[420px] rounded-[var(--r-card)] max-h-96 overflow-y-auto z-50 divide-y divide-[color:var(--glass-hairline)]"
                >
                  <div className="px-3.5 py-2 bg-muted/60 flex items-center justify-between text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                    <span>
                      检索「<strong className="text-[color:var(--ink-strong)]">{searchQuery}</strong>」命中{' '}
                      <strong className="font-mono tabular-nums text-[color:var(--accent-violet-ink)]">
                        {searchHits.length}
                      </strong>{' '}
                      处
                    </span>
                    {/* 索引代际信息由「?」帮助浮层展示，此处不重复打印调试键值对 */}
                  </div>

                  {searchHits.length === 0 ? (
                    <div className="p-4 text-center text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
                      未找到匹配项（已检索 {config.enumSnapshot.mdCount} MD、
                      {config.enumSnapshot.svgCount} SVG 文字及{' '}
                      {config.enumSnapshot.totalCount} 文件名）
                    </div>
                  ) : (
                    searchHits.map((hit, idx) => (
                      <button
                        key={`${hit.file_id}-${idx}`}
                        type="button"
                        onClick={() => onSelectSearchHit(hit)}
                        className="w-full text-left px-3.5 py-2.5 hover:bg-accent/70 motion-safe:transition-colors flex flex-col gap-1 cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-strong)] flex items-center gap-1.5 min-w-0">
                            <FileText className="w-3.5 h-3.5 text-[color:var(--accent-wave)] shrink-0" />
                            <span
                              className="shrink-0 rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 px-1 py-px text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)]"
                              title={`任务包：${taskPackageOf(hit.relative_path).name}`}
                            >
                              {taskPackageOf(hit.relative_path).name}
                            </span>
                            <span className="truncate font-mono" title={hit.relative_path}>
                              {basenameOf(hit.relative_path)}
                            </span>
                          </span>
                          <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] shrink-0">
                            {formatCoverageLabel(hit.coverage, hit.format)}
                          </span>
                        </div>
                        <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] line-clamp-1">
                          {hit.snippet}
                        </p>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* 筛选下拉（格式/角色/主题）——仅 library 工作区渲染，
                随检索同簇（它是检索工作流的一部分） */}
            {activeTab === 'library' && (
              <FilterDropdown
                files={files}
                filters={sidebarFilters}
                onChange={onUpdateSidebarFilters}
                onReset={onResetSidebarFilters}
                facets={facets}
              />
            )}

            {dataSource === 'real' && (
              <DecisionRadar
                decisions={decisions}
                unresolvedTotal={decisionsUnresolvedTotal}
                onOpenDecision={onOpenDecision}
                openSignal={openSignal}
              />
            )}

            {/* 批阅看板入口（待拍板 / 可派发 / 运行中 / 待批阅回执 / 已办结 + 失联孤儿修复） */}
            {onOpenReviewBoard && (
              <Button
                variant={reviewBoardAttentionCount > 0 ? 'secondary' : 'ghost'}
                size="sm"
                onClick={onOpenReviewBoard}
                data-topheader-review-board=""
                title="打开批阅看板（HITL 拍板唤醒与 Agent 回执分流）"
                className="cursor-pointer !h-7 !px-2 !gap-1 whitespace-nowrap"
              >
                <ClipboardList className="w-3.5 h-3.5 text-[color:var(--stage-ink-decision)] shrink-0" />
                <span>批阅</span>
                {reviewBoardAttentionCount !== undefined && reviewBoardAttentionCount > 0 && (
                  <span className="rounded-full bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_18%,transparent)] px-1.5 py-px font-mono text-[10px] leading-none font-semibold tabular-nums text-[color:var(--stage-ink-decision-text)]">
                    {reviewBoardAttentionCount}
                  </span>
                )}
              </Button>
            )}
          </div>

          {/* 簇间极轻发丝竖隔线（右区唯一分区隔线，glass-hairline 相位） */}
          <span
            aria-hidden="true"
            data-header-divider=""
            className="hidden lg:inline-block mx-0.5 h-4 w-px bg-[color:var(--glass-hairline)] shrink-0"
          />

          {/* ── 静默工具组：同步状态 Group · 阅读微胶囊 · 证据篮 · [明暗切换 | ? | 设置] ── */}
          <div
            className="flex items-center gap-0.5"
            data-header-cluster="utility"
            role="group"
            aria-label="静默工具"
          >
            {/* 合一遥测胶囊（同步状态微点 + 时效 + 重扫）整块搬迁不拆（renderTelemetryCluster） */}
            {renderTelemetryCluster()}

            {/* 阅读与存档顶栏紧凑微胶囊（点击唤出 coss Sheet inset 悬浮抽屉，全站零遮挡） */}
            {readingIslandFiles &&
              readingIslandFiles.length > 0 &&
              readingStates &&
              onOpenDocFromIsland && (
                <ReadingIsland
                  placement="header"
                  files={readingIslandFiles}
                  readingStates={readingStates}
                  quota={config.quota}
                  onOpenDoc={onOpenDocFromIsland}
                  onMarkFileRead={onMarkFileReadFromIsland}
                  onMarkFileUnread={onMarkFileUnreadFromIsland}
                  onMarkReadingBaseline={onMarkReadingBaselineFromIsland}
                />
              )}

            {/* 证据篮（零项静默纯图标，有项时以主高亮角标提示） */}
            <Button
              variant={contextBasketCount > 0 ? 'primary' : 'ghost'}
              size="sm"
              onClick={onOpenContextDrawer}
              aria-label={`证据篮（已收集 ${contextBasketCount} 条上下文）`}
              title={`证据篮（已收集 ${contextBasketCount} 条上下文）`}
              className={`cursor-pointer !h-7 whitespace-nowrap ${
                contextBasketCount > 0 ? '!px-2 !gap-1' : '!w-7 !px-0 justify-center'
              }`}
            >
              <ClipboardCopy
                className={`w-3.5 h-3.5 shrink-0 ${
                  contextBasketCount > 0 ? 'text-[color:var(--accent-wave-bright)]' : 'text-[color:var(--ink-soft)]'
                }`}
              />
              <span className={contextBasketCount > 0 ? '' : 'sr-only'}>证据篮</span>
              {contextBasketCount > 0 && (
                <span
                  key={basketPulseSeq > 0 ? `basket-pulse-${basketPulseSeq}` : 'basket-static'}
                  data-context-basket-badge=""
                  aria-label={`已收集 ${contextBasketCount} 条上下文`}
                  className={`rounded-full bg-white/20 dark:bg-black/14 px-1.5 py-px font-mono text-[10px] leading-none font-semibold tabular-nums ${
                    basketPulseSeq > 0 ? 'glx-badge-pop' : ''
                  }`}
                >
                  {contextBasketCount}
                </span>
              )}
            </Button>

            {/* 工具控件静默无框组（全站明暗一键切换 · ? 快捷键速查 · 项目设置） */}
            <Group
              aria-label="外观与系统工具"
              data-header-tool-group=""
              className="h-7 shrink-0 gap-0.5 rounded-lg border-0 bg-transparent shadow-none"
            >
              <button
                type="button"
                data-app-theme-toggle=""
                data-app-theme-mode={appThemeMode}
                data-app-theme-resolved={resolvedAppTheme}
                onClick={handleCycleAppTheme}
                aria-label={`切换全局明暗主题（当前：${appThemeModeLabel(appThemeMode)}，点击切换至${appThemeModeLabel(nextThemeMode)}）`}
                title={`外观主题：${appThemeModeLabel(appThemeMode)} · 点击切换至${appThemeModeLabel(nextThemeMode)}`}
                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] motion-safe:transition-colors"
              >
                {appThemeMode === 'dark' ? (
                  <Moon className="size-3.5 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
                ) : appThemeMode === 'system' ? (
                  <Monitor className="size-3.5" aria-hidden="true" />
                ) : (
                  <Sun className="size-3.5 text-[color:var(--stage-ink-decision)]" aria-hidden="true" />
                )}
              </button>
              {/* 「?」全站快捷键速查 Dialog（融合工作区快照与 Frame + Kbd 分组速查表） */}
              <div className="relative flex h-full items-center" ref={helpRootRef}>
                <button
                  type="button"
                  aria-label="帮助"
                  title="模型、工作区快照与快捷键速查 (?)"
                  aria-expanded={isHelpOpen}
                  onClick={() => setIsHelpOpen((v) => !v)}
                  className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] motion-safe:transition-colors"
                >
                  <HelpCircle className="size-3.5" aria-hidden="true" />
                </button>

                <ShortcutsCheatSheetModal
                  isOpen={isHelpOpen}
                  onClose={() => setIsHelpOpen(false)}
                  activeTab={activeTab}
                  config={config}
                  lastScanAt={lastScanAt}
                />
              </div>
              {/* Utility Buttons——静默工具组内设置按钮 */}
              <button
                type="button"
                aria-label="项目设置"
                onClick={onOpenSettings}
                title="项目扫描范围与快照配额设置"
                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] motion-safe:transition-colors"
              >
                <Settings className="size-3.5" aria-hidden="true" />
              </button>
            </Group>

            {/* MCP 调试入口默认隐藏（与 ModalsAndDrawers 弹层同键门控）；
                本地调试时可在控制台执行 localStorage.setItem('guanlan.debug.mcp', '1') 后刷新。 */}
            {safeStorageGet('guanlan.debug.mcp') === '1' && (
              <IconButton
                label="MCP 契约调试"
                onClick={onOpenMcpConsole}
                title="MCP 8 项工具契约调试台"
                className="cursor-pointer !size-7 !rounded-[8px]"
              >
                <Terminal />
              </IconButton>
            )}
          </div>
        </Toolbar>
      </div>
    </header>
  );
};
