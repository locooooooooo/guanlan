import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronDown,
  ClipboardCopy,
  ClipboardList,
  FileText,
  FolderOpen,
  FolderPlus,
  HelpCircle,
  Loader2,
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
import { buildHighlightSegments } from '../utils/commandPaletteGrammar';
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
import { safeStorageGet } from '../utils/safeStorage';
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
import { Button, IconButton, Tabs } from './ui/primitives';
import type { ChipStage } from './ui/primitives';
import { Group, GroupSeparator, Kbd, Toolbar } from './ui';

export type PrimaryTab = 'home' | 'panorama' | 'library';

export type LibraryMode = 'read' | 'overview';

interface TopHeaderProps {
  activeTab: PrimaryTab;
  onSelectTab: (tab: PrimaryTab) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchHits: SearchHit[];
  searchHitsTruncated?: boolean;
  onSelectSearchHit: (hit: SearchHit) => void;
  unreadFilesCount: number;
  contextBasketCount: number;
  eventCount: number;
  decisions: DecisionAssertion[];
  decisionsUnresolvedTotal?: number | null;
  onOpenDecision: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
  openSignal?: number;
  config: WorkspaceConfig;
  dataSource: 'loading' | WorkspaceSource;
  scanSummary: string;
  dataError: string | null;
  files: FileRecord[];
  facets?: FileFacets | null;
  sidebarFilters: SidebarFilters;
  onUpdateSidebarFilters: (next: Partial<SidebarFilters>) => void;
  onResetSidebarFilters: () => void;
  libraryMode: LibraryMode;
  onLibraryModeChange: (mode: LibraryMode) => void;
  onOpenSettings: () => void;
  onOpenMcpConsole: () => void;
  onOpenContextDrawer: () => void;
  onOpenReviewBoard?: () => void;
  reviewBoardAttentionCount?: number;
  lastScanAt?: string | null;
  isScanning?: boolean;
  onRescan?: () => void;
  watcherEnabled?: boolean;
  desktopWorkspaceSupported?: boolean;
  desktopGateStatus?: DesktopSessionState['status'] | null;
  workspaceName?: string | null;
  recentWorkspaces?: RecentWorkspaceStatus[];
  switchingWorkspace?: boolean;
  workspaceSwitchError?: string | null;
  onPickWorkspaceFolder?: () => void;
  onSwitchWorkspace?: (root: string) => void;
  onRemoveRecentWorkspace?: (root: string) => void;
  helpOpen?: boolean;
  onHelpOpenChange?: (open: boolean) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  managedProjects?: ProjectEntryDto[];
  activeProjectId?: string;
  onActivateProject?: (projectId: string) => void;
  onOpenAddProject?: () => void;
  onRemoveManagedProject?: (projectId: string) => void;
  readingIslandFiles?: FileRecord[];
  readingStates?: ReadingStateMap;
  onOpenDocFromIsland?: (fileId: string) => void;
  onMarkFileReadFromIsland?: (fileId: string, revisionId: string) => void;
  onMarkFileUnreadFromIsland?: (fileId: string) => void;
  onMarkReadingBaselineFromIsland?: () => Promise<boolean> | void;
}


export const TopHeader: React.FC<TopHeaderProps> = ({
  activeTab,
  onSelectTab,
  searchQuery,
  onSearchChange,
  searchHits,
  searchHitsTruncated,
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
  onRemoveManagedProject,
  readingIslandFiles,
  readingStates,
  onOpenDocFromIsland,
  onMarkFileReadFromIsland,
  onMarkFileUnreadFromIsland,
  onMarkReadingBaselineFromIsland,
}) => {
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [searchDropdownDismissed, setSearchDropdownDismissed] = useState(false);
  const [activeSearchHitIndex, setActiveSearchHitIndex] = useState(0);
  const searchRootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false);
  const [workspacePathInput, setWorkspacePathInput] = useState('');
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
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

  const searchDropdownOpen = searchQuery.trim().length > 0 && !searchDropdownDismissed;
  const clampedSearchHitIndex =
    searchHits.length > 0 ? Math.min(activeSearchHitIndex, searchHits.length - 1) : 0;

  useEffect(() => {
    setActiveSearchHitIndex(0);
    if (searchQuery.trim().length === 0) {
      setSearchDropdownDismissed(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    if (!searchDropdownOpen) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (searchRootRef.current && !searchRootRef.current.contains(e.target as Node)) {
        setSearchDropdownDismissed(true);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [searchDropdownOpen]);

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
              tintBg: 'color-mix(in srgb, var(--stage-ink-decision) 10%, var(--card))',
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
    <header className="relative z-40 select-none bg-background dark:bg-background text-[color:var(--ink-strong)] border-b border-border">
      <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-x-2 gap-y-1.5 px-2.5 sm:px-3.5 py-1.5 lg:py-0 min-h-[var(--chrome-h)] lg:h-[var(--chrome-h)] min-w-0 max-w-full">
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

          {(config.rootPath || desktopWorkspaceSupported || managedProjects.length > 0) && (
            <div className="relative min-w-0 shrink-0" ref={workspaceMenuRef}>
              <button
                type="button"
                data-workspace-switcher
                aria-expanded={isWorkspaceMenuOpen}
                onClick={() => setIsWorkspaceMenuOpen((v) => !v)}
                title={
                  managedProjects.length > 1
                    ? `${config.rootPath || '当前项目'}（共 ${managedProjects.length} 个项目，点击下拉切换）`
                    : config.rootPath || '管理与切换项目文件夹'
                }
                className="flex items-center gap-1 max-w-[112px] sm:max-w-[144px] h-7 rounded-[var(--r-ctl)] border border-border bg-card hover:border-ring/40 px-2 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-strong)] cursor-pointer motion-safe:transition-colors overflow-hidden"
              >
                <FolderOpen className="w-3 h-3 shrink-0 text-[color:var(--accent-iris-deep)]" />
                <span className="truncate font-medium">
                  {managedProjects.find((p) => p.project_id === activeProjectId)?.name ||
                    managedProjects[0]?.name ||
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
                            <div
                              key={proj.project_id}
                              className={`flex items-center gap-1 rounded-[var(--r-ctl)] border transition-colors ${
                                isCurrent
                                  ? 'bg-[color:var(--chip-active-bg)] border-[color:var(--chip-active-border)]'
                                  : 'border-transparent hover:bg-accent'
                              }`}
                            >
                              <button
                                type="button"
                                disabled={isOffline}
                                data-switcher-project={proj.project_id}
                                onClick={() => {
                                  setIsWorkspaceMenuOpen(false);
                                  if (!isCurrent) onActivateProject?.(proj.project_id);
                                }}
                                title={proj.root_path}
                                className="flex-1 min-w-0 flex items-center justify-between gap-2 px-2 py-1.5 text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--ink-strong)] truncate">
                                    {proj.is_scanning && (
                                      <Loader2 className="w-3 h-3 shrink-0 animate-spin text-[color:var(--accent-iris-deep)]" />
                                    )}
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
                              {managedProjects.length > 1 && onRemoveManagedProject && (
                                <button
                                  type="button"
                                  data-switcher-remove-project={proj.project_id}
                                  aria-label={`移出项目 ${proj.name}`}
                                  title="移出列表（不删磁盘）"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onRemoveManagedProject(proj.project_id);
                                  }}
                                  className="mr-1.5 p-1 rounded-[6px] text-[color:var(--ink-faint)] hover:text-[color:var(--btn-danger-ink)] hover:bg-card/80 cursor-pointer shrink-0"
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

        <Toolbar
          aria-label="顶栏操作工具栏"
          data-header-clusters=""
          className="flex flex-wrap lg:flex-nowrap items-center max-w-full lg:shrink-0 !gap-1 !rounded-none !border-0 !bg-transparent !p-0 !shadow-none"
        >
          <div
            className="flex flex-wrap sm:flex-nowrap items-center gap-1 max-w-full"
            data-header-cluster="primary"
            role="group"
            aria-label="核心行动"
          >
            <div className="relative" ref={searchRootRef} data-topheader-search="">
              <div
                className={`glass-input flex h-7 items-center rounded-[var(--r-ctl)] px-2 focus-within:border-[color:var(--ring)] focus-within:ring-2 focus-within:ring-[color:color-mix(in_srgb,var(--ring)_35%,transparent)] motion-safe:transition-all ${
                  isSearchExpanded || searchQuery
                    ? 'w-36 sm:w-44 border-[color:var(--accent-iris)] ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_22%,transparent)]'
                    : 'w-[84px] sm:w-[92px] xl:w-[108px] hover:border-[color:var(--btn-secondary-border-hover)]'
                }`}
              >
                <Search className="w-3.5 h-3.5 text-[color:var(--ink-soft)] mr-1 shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  aria-label="搜索文件、内容或编号"
                  value={searchQuery}
                  onFocus={() => {
                    setIsSearchExpanded(true);
                    setSearchDropdownDismissed(false);
                  }}
                  onBlur={() => setIsSearchExpanded(false)}
                  onChange={(e) => {
                    setSearchDropdownDismissed(false);
                    onSearchChange(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      if (searchQuery || searchDropdownOpen) {
                        e.preventDefault();
                        e.stopPropagation();
                        onSearchChange('');
                        setSearchDropdownDismissed(false);
                        searchInputRef.current?.blur();
                      }
                      return;
                    }
                    if (!searchDropdownOpen || searchHits.length === 0) return;
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setActiveSearchHitIndex((i) => (i + 1) % searchHits.length);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setActiveSearchHitIndex((i) => (i - 1 + searchHits.length) % searchHits.length);
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      const chosen = searchHits[clampedSearchHitIndex];
                      if (chosen) {
                        onSelectSearchHit(chosen);
                        searchInputRef.current?.blur();
                      }
                    }
                  }}
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
                    onClick={() => {
                      onSearchChange('');
                      setSearchDropdownDismissed(false);
                    }}
                    className="cursor-pointer text-[color:var(--ink-faint)] hover:text-[color:var(--ink-strong)] ml-1"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {searchDropdownOpen && (
                <div
                  role="region"
                  aria-label="搜索结果列表"
                  data-esc-layer="open"
                  className="glass-pop glx-popover-in absolute right-0 top-full mt-2 w-[min(420px,calc(100vw-24px))] rounded-[var(--r-card)] max-h-96 overflow-y-auto z-50 divide-y divide-[color:var(--glass-hairline)]"
                >
                  <div className="px-3.5 py-2 bg-muted/60 flex items-center justify-between gap-2 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                    <span className="truncate">
                      检索「<strong className="text-[color:var(--ink-strong)]">{searchQuery}</strong>」命中{' '}
                      <strong className="font-mono tabular-nums text-[color:var(--accent-violet-ink)]">
                        {searchHits.length}
                      </strong>{' '}
                      处{searchHitsTruncated ? '（已截断）' : ''}
                    </span>
                    <span className="shrink-0 hidden sm:inline font-mono text-[10px] text-[color:var(--ink-faint)]">
                      ↑↓ · Enter · Esc
                    </span>
                  </div>

                  {searchHitsTruncated && (
                    <div className="px-3.5 py-2 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] bg-muted/30">
                      仅列出前 {searchHits.length} 条命中。缩小关键词，或按 Ctrl+K
                      走全库检索查看其余结果。
                    </div>
                  )}

                  {searchHits.length === 0 ? (
                    <div className="p-4 text-center text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
                      未找到匹配项（已检索 {config.enumSnapshot.mdCount} MD、
                      {config.enumSnapshot.svgCount} SVG 文字及{' '}
                      {config.enumSnapshot.totalCount} 文件名）
                    </div>
                  ) : (
                    searchHits.map((hit, idx) => {
                      const isActive = idx === clampedSearchHitIndex;
                      const fileBase = basenameOf(hit.relative_path);
                      const titleSegs = buildHighlightSegments(fileBase, searchQuery);
                      const snippetSegs = buildHighlightSegments(hit.snippet, searchQuery);
                      return (
                        <button
                          key={`${hit.file_id}-${idx}`}
                          type="button"
                          data-search-hit-active={isActive ? 'true' : undefined}
                          onMouseEnter={() => setActiveSearchHitIndex(idx)}
                          onClick={() => onSelectSearchHit(hit)}
                          className={`w-full text-left px-3.5 py-2.5 motion-safe:transition-colors flex flex-col gap-1 cursor-pointer ${
                            isActive ? 'bg-accent/80' : 'hover:bg-accent/70'
                          }`}
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
                                {titleSegs.map((seg, si) =>
                                  seg.hit ? (
                                    <mark
                                      key={si}
                                      className="rounded-[3px] bg-[color:color-mix(in_srgb,var(--accent-iris)_22%,transparent)] px-0.5 text-[color:var(--ink-strong)]"
                                    >
                                      {seg.text}
                                    </mark>
                                  ) : (
                                    <React.Fragment key={si}>{seg.text}</React.Fragment>
                                  )
                                )}
                              </span>
                            </span>
                            <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] shrink-0">
                              {formatCoverageLabel(hit.coverage, hit.format)}
                            </span>
                          </div>
                          <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] line-clamp-1">
                            {snippetSegs.map((seg, si) =>
                              seg.hit ? (
                                <mark
                                  key={si}
                                  className="rounded-[3px] bg-[color:color-mix(in_srgb,var(--accent-iris)_22%,transparent)] px-0.5 font-medium text-[color:var(--ink-strong)]"
                                >
                                  {seg.text}
                                </mark>
                              ) : (
                                <React.Fragment key={si}>{seg.text}</React.Fragment>
                              )
                            )}
                          </p>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

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

            {onOpenReviewBoard && (
              <Button
                variant={reviewBoardAttentionCount > 0 ? 'secondary' : 'ghost'}
                size="sm"
                onClick={onOpenReviewBoard}
                data-topheader-review-board=""
                title="打开批阅看板（人工拍板与智能体回执分流）"
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

          <span
            aria-hidden="true"
            data-header-divider=""
            className="hidden lg:inline-block mx-0.5 h-4 w-px bg-[color:var(--glass-hairline)] shrink-0"
          />

          <div
            className="flex items-center gap-0.5"
            data-header-cluster="utility"
            role="group"
            aria-label="静默工具"
          >
            {renderTelemetryCluster()}

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
                  contextBasketCount > 0 ? 'text-current' : 'text-[color:var(--ink-soft)]'
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
