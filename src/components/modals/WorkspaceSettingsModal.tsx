
import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Database,
  Download,
  EyeOff,
  FolderCog,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { StorageStatsResponse } from '../../services/apiTypes';
import type { WorkspaceConfig } from '../../types/guanlan';
import { APP_BUILD_INFO, formatBuildTimestamp } from '../../utils/appBuildInfo';
import { BRAND_NAME, BRAND_NAME_EN, BRAND_SLOGAN, BRAND_SLOGAN_NOTE } from '../../utils/brandIdentity';
import { BrandMark } from '../BrandMark';
import {
  checkDesktopUpdate,
  installDesktopUpdate,
  isDesktopUpdateBridgeAvailable,
  subscribeUpdateProgress,
  type DesktopUpdateCheck,
  type DesktopUpdateProgress,
} from '../../services/desktopBridge';
import { Button, IconButton } from '../ui/primitives';
import {
  StorageUsageSection,
  subscribeStorageStatsSnapshot,
} from '../StorageUsageSection';
import {
  Badge,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Frame,
  FramePanel,
  ScrollArea,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '../ui';

export type SettingsTabId = 'workspace' | 'noise' | 'storage' | 'health' | 'about';

type UpdateUiState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not_configured' }
  | { kind: 'up_to_date'; currentVersion: string }
  | { kind: 'available'; check: DesktopUpdateCheck }
  | { kind: 'installing'; progress: DesktopUpdateProgress }
  | { kind: 'error'; message: string };

export const SETTINGS_TABS: ReadonlyArray<{
  id: SettingsTabId;
  label: string;
  desc: string;
}> = [
  { id: 'workspace', label: '工作区', desc: '根目录与快照枚举' },
  { id: 'noise', label: '降噪与忽略', desc: '静默目录与排除清单' },
  { id: 'storage', label: '存储配额', desc: '快照配额与磁盘占用' },
  { id: 'health', label: '备份与健康', desc: '引擎状态与一致性护栏' },
  { id: 'about', label: '关于观澜', desc: '版本与本地优先说明' },
];

export interface WorkspaceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: WorkspaceConfig;
  mutedFolders?: readonly string[];
  onUnmuteFolder?: (folderPath: string) => void;
  onClearMutedFolders?: () => void;
  initialTab?: SettingsTabId;
}

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  mutedFolders = [],
  onUnmuteFolder,
  onClearMutedFolders,
  initialTab = 'workspace',
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  const [liveStats, setLiveStats] = useState<StorageStatsResponse | null>(null);
  const [updateState, setUpdateState] = useState<UpdateUiState>({ kind: 'idle' });
  const updateBridgeAvailable = isDesktopUpdateBridgeAvailable();

  useEffect(() => {
    if (!isOpen) return;
    return subscribeStorageStatsSnapshot((next) => {
      setLiveStats(next);
    });
  }, [isOpen, config.rootPath]);

  useEffect(() => {
    if (!isOpen) return;
    return subscribeUpdateProgress((progress) => {
      setUpdateState({ kind: 'installing', progress });
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCheckUpdate = async () => {
    setUpdateState({ kind: 'checking' });
    const result = await checkDesktopUpdate();
    if (!result.ok) {
      setUpdateState({ kind: 'error', message: result.error });
      return;
    }
    if (result.data.status === 'available') {
      setUpdateState({ kind: 'available', check: result.data });
    } else if (result.data.status === 'not_configured') {
      setUpdateState({ kind: 'not_configured' });
    } else {
      setUpdateState({ kind: 'up_to_date', currentVersion: result.data.currentVersion });
    }
  };

  const handleInstallUpdate = async () => {
    setUpdateState({
      kind: 'installing',
      progress: { phase: 'downloading', downloaded: 0, total: null },
    });
    const result = await installDesktopUpdate();
    if (!result.ok) {
      setUpdateState({ kind: 'error', message: result.error });
    }
  };

  const effectiveUsedMiB = liveStats
    ? Math.round((liveStats.blobs_disk_bytes / (1024 * 1024)) * 100) / 100
    : config.quota.usedTotalMiB;
  const effectiveProtectedCount = liveStats
    ? liveStats.blobs_count
    : config.quota.protectedSnapshotsCount;
  const effectiveBinaryMaxMiB = liveStats
    ? liveStats.policy.binary_max_mib ||
      Math.max(1, Math.round(liveStats.policy.binary_max_bytes / (1024 * 1024)))
    : config.quota.maxSingleBinaryMiB;
  const effectiveTextMaxMiB = liveStats
    ? liveStats.policy.text_max_mib ||
      Math.max(1, Math.round(liveStats.policy.text_max_bytes / (1024 * 1024)))
    : null;

  const updateStatusText = (() => {
    switch (updateState.kind) {
      case 'idle':
        return updateBridgeAvailable ? '' : '仅桌面客户端支持';
      case 'checking':
        return '正在检查…';
      case 'not_configured':
        return '未配置更新源';
      case 'up_to_date':
        return `已是最新（v${updateState.currentVersion}）`;
      case 'available':
        return `发现 v${updateState.check.version}`;
      case 'installing': {
        const { phase, downloaded, total } = updateState.progress;
        if (phase === 'installing') return '正在安装，应用即将重启…';
        if (total && total > 0) {
          return `正在下载 ${Math.min(100, Math.round((downloaded / total) * 100))}%`;
        }
        return downloaded > 0 ? `正在下载 ${(downloaded / (1024 * 1024)).toFixed(1)} MiB` : '正在下载…';
      }
      case 'error':
        return updateState.message;
    }
  })();

  const quotaRatio = Math.min(
    100,
    Math.max(
      0,
      config.quota.maxTotalMiB > 0
        ? Math.round((effectiveUsedMiB / config.quota.maxTotalMiB) * 100)
        : 0
    )
  );

  const tabIcon = (id: SettingsTabId) => {
    switch (id) {
      case 'workspace':
        return <FolderCog className="size-3.5 shrink-0" aria-hidden="true" />;
      case 'noise':
        return <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />;
      case 'storage':
        return <Database className="size-3.5 shrink-0" aria-hidden="true" />;
      case 'health':
        return <Activity className="size-3.5 shrink-0" aria-hidden="true" />;
      case 'about':
        return <Info className="size-3.5 shrink-0" aria-hidden="true" />;
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="项目扫描口径与本地存储设置"
      data-esc-layer="open"
      data-settings-modal="open"
      className="glx-backdrop-in fixed inset-0 z-50 bg-[color:var(--ink-anchor)]/38 dark:bg-black/62 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-dialog-nested-stack=""
        style={{ '--nested-dialogs': 0 } as React.CSSProperties}
        className="glass-pop glx-modal-in rounded-2xl border border-border/85 w-full max-w-4xl h-[min(86vh,740px)] flex flex-col overflow-hidden text-foreground shadow-2xl"
      >
        <header className="px-5 py-3.5 bg-card/85 backdrop-blur-md border-b border-border/80 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex size-8 items-center justify-center rounded-xl bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] text-[color:var(--accent-iris-deep)] shrink-0">
              <FolderCog className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] leading-5 font-semibold tracking-[-0.01em] truncate">
                工程扫描配置与本地数据目录
              </h2>
              <p className="text-[11px] text-muted-foreground truncate font-mono">
                {config.rootPath || '尚未绑定本地目录'}
              </p>
            </div>
          </div>
          <IconButton label="关闭项目设置" onClick={onClose} className="cursor-pointer shrink-0">
            <X />
          </IconButton>
        </header>

        <Tabs
          orientation="vertical"
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as SettingsTabId)}
          className="flex-1 min-h-0 flex-row gap-0 overflow-hidden"
        >
          <aside
            data-settings-nav="vertical"
            className="w-[188px] shrink-0 border-r border-border/80 bg-muted/35 p-2.5 flex flex-col"
          >
            <TabsList
              variant="underline"
              className="w-full flex-col items-stretch gap-1 bg-transparent p-0"
            >
              {SETTINGS_TABS.map((t) => (
                <TabsTab
                  key={t.id}
                  value={t.id}
                  data-settings-tab={t.id}
                  className="justify-start gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] data-active:bg-card data-active:shadow-xs data-active:border data-active:border-border/80"
                >
                  {tabIcon(t.id)}
                  <span className="flex-1 truncate">{t.label}</span>
                  {t.id === 'noise' && mutedFolders.length > 0 && (
                    <Badge variant="brand" size="sm" className="font-mono tabular-nums">
                      {mutedFolders.length}
                    </Badge>
                  )}
                </TabsTab>
              ))}
            </TabsList>
          </aside>

          <ScrollArea scrollFade scrollbarGutter className="flex-1 min-h-0 bg-background/40">
            <div className="p-5 pb-8 text-xs space-y-4">
              <TabsPanel value="workspace" className="space-y-4">
                {config.gitIgnoreWarning?.trim() ? (
                  <div className="p-3.5 rounded-xl border border-[color:color-mix(in_srgb,var(--stage-ink-decision)_38%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,var(--card))] text-[color:var(--stage-ink-decision-text)] space-y-1">
                    <div className="font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>源目录忽略规则告警（扫描可能不完整，请核对忽略规则）</span>
                    </div>
                    <p className="leading-relaxed">{config.gitIgnoreWarning}</p>
                  </div>
                ) : (
                  <div className="px-3.5 py-2.5 rounded-xl border border-[color:color-mix(in_srgb,var(--stage-ink-deliver)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_8%,var(--card))] text-[color:var(--stage-ink-deliver-text)] flex items-center justify-between gap-2">
                    <span className="font-medium flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5 shrink-0" />
                      <span>源目录扫描边界清晰 · 已按显式排除规则隔离无关目录</span>
                    </span>
                    <span className="font-mono text-[10.5px] opacity-80 shrink-0">NO WARNING</span>
                  </div>
                )}

                <Frame className="border border-border/75">
                  <div className="px-3.5 py-2 text-[12px] font-semibold text-foreground">
                    扫描范围与数据目录
                  </div>
                  <FramePanel
                    className="space-y-2.5"
                    title={
                      config.runtimeStatus.loopbackUrl
                        ? `本地读服务地址：${config.runtimeStatus.loopbackUrl}`
                        : undefined
                    }
                  >
                    <div className="font-mono text-muted-foreground space-y-1.5">
                      <div className="[overflow-wrap:anywhere]">扫描根目录：{config.rootPath}</div>
                      <div className="[overflow-wrap:anywhere]">本地数据目录：{config.dataDirPath}</div>
                    </div>
                    <p className="text-muted-foreground pt-1 leading-relaxed">
                      扫描范围以本页配置为准；外部工具建议的路径仅作发现参考，不会自动扩大访问范围。
                    </p>
                  </FramePanel>
                </Frame>

                <Frame className="border border-border/75">
                  <div className="flex items-center justify-between gap-2 px-3.5 py-2">
                    <span className="text-[12px] font-semibold text-foreground">
                      {config.enumSnapshot.date
                        ? `${config.enumSnapshot.date} 文件枚举快照`
                        : '文件枚举快照'}
                    </span>
                    <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                      共 {config.enumSnapshot.totalCount} 份
                    </Badge>
                  </div>
                  <FramePanel className="space-y-3 font-mono tabular-nums">
                    <div className="grid grid-cols-3 gap-2.5">
                      <div className="rounded-lg border border-border/60 bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,var(--card))] px-3 py-2">
                        <div className="text-[10.5px] font-sans text-muted-foreground">Markdown</div>
                        <div className="mt-0.5 text-[18px] font-semibold leading-tight text-[color:var(--accent-iris-deep)]">
                          {config.enumSnapshot.mdCount}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_10%,var(--card))] px-3 py-2">
                        <div className="text-[10.5px] font-sans text-muted-foreground">SVG 图纸</div>
                        <div className="mt-0.5 text-[18px] font-semibold leading-tight text-[color:var(--stage-ink-deliver-text)]">
                          {config.enumSnapshot.svgCount}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,var(--card))] px-3 py-2">
                        <div className="text-[10.5px] font-sans text-muted-foreground">PDF 文档</div>
                        <div className="mt-0.5 text-[18px] font-semibold leading-tight text-[color:var(--stage-ink-decision-text)]">
                          {config.enumSnapshot.pdfCount}
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-border/70">
                      <span className="font-sans text-muted-foreground">文本索引就绪 / 字符提取告警：</span>
                      <span className="font-semibold text-foreground">
                        {config.enumSnapshot.indexedSuccessCount} / {config.enumSnapshot.parseFailedCount}
                      </span>
                    </div>
                  </FramePanel>
                </Frame>
              </TabsPanel>

              <TabsPanel value="noise" className="space-y-4">
                <Frame className="border border-border/75">
                  <div className="flex items-center justify-between gap-2 px-3.5 py-2">
                    <span className="text-[12px] font-semibold text-foreground">
                      已静默目录清单（仅存本机私有存储，零写入业务目录）
                    </span>
                    {mutedFolders.length > 0 && onClearMutedFolders && (
                      <Button variant="ghost" size="sm" onClick={onClearMutedFolders}>
                        <RotateCcw className="size-3" />
                        <span>全部恢复</span>
                      </Button>
                    )}
                  </div>
                  <FramePanel>
                    {mutedFolders.length === 0 ? (
                      <Empty className="py-6">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <EyeOff className="size-4" />
                          </EmptyMedia>
                          <EmptyTitle>当前暂无静默目录</EmptyTitle>
                          <EmptyDescription>
                            可在左侧目录树右键任意高噪目录选择「在时间轴与星图静默此目录」，随时可在此恢复
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <div className="space-y-1.5">
                        {mutedFolders.map((folder) => (
                          <div
                            key={folder}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border/75 bg-muted/35 px-3 py-2"
                          >
                            <span className="font-mono text-[11.5px] text-foreground truncate">
                              {folder}
                            </span>
                            {onUnmuteFolder && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onUnmuteFolder(folder)}
                              >
                                恢复展示
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </FramePanel>
                </Frame>

                <Frame className="border border-border/75">
                  <div className="px-3.5 py-2 text-[12px] font-semibold text-foreground">
                    忽略规则（自动尊重工作区各级 .gitignore + 显式排除目录）
                  </div>
                  <FramePanel>
                    <div className="flex flex-wrap gap-1.5 font-mono">
                      {config.excludedDirs.map((dir) => (
                        <Badge key={dir} variant="outline" size="sm" className="font-mono">
                          {dir}
                        </Badge>
                      ))}
                    </div>
                  </FramePanel>
                </Frame>
              </TabsPanel>

              <TabsPanel value="storage" className="space-y-4">
                <Frame className="border border-border/75">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
                    <span className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
                      <Database className="w-3.5 h-3.5 text-[color:var(--accent-iris)]" />
                      <span>快照配额与保护策略</span>
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-[color:var(--accent-iris-deep)]">
                      已用 {effectiveUsedMiB} MiB / {config.quota.maxTotalMiB} MiB（
                      {effectiveTextMaxMiB !== null
                        ? `文本上限 ${effectiveTextMaxMiB} MiB · 图片/文档上限 ${effectiveBinaryMaxMiB} MiB`
                        : `单二进制上限 ${effectiveBinaryMaxMiB} MiB`}
                      ）
                    </span>
                  </div>
                  <FramePanel className="space-y-3">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.max(quotaRatio, effectiveUsedMiB > 0 ? 3 : 0)}%`,
                          background:
                            quotaRatio >= 85
                              ? 'var(--stage-ink-decision)'
                              : 'linear-gradient(90deg, var(--accent-iris) 0%, var(--accent-wave) 100%)',
                        }}
                      />
                    </div>
                    <p
                      className="text-muted-foreground leading-relaxed"
                      title="完整写入链路：稳定读取 → 写入临时快照并校验 SHA-256 → 原子落盘 → 事务提交版本、事件和索引 → SSE 通知 UI；已淘汰旧快照访问时返回 SNAPSHOT_UNAVAILABLE；存储实现：SQLite + blobs/"
                    >
                      资料落盘受双重保护：写入即校验完整性，旧快照按配额自动淘汰。当前受保护去重快照共{' '}
                      <strong className="text-foreground">{effectiveProtectedCount}</strong>{' '}
                      份，已淘汰旧快照{' '}
                      <strong className="text-[color:var(--stage-ink-decision-text)]">
                        {config.quota.evictedSnapshotsCount}
                      </strong>{' '}
                      份（旧版本将标注为不可打开）。
                    </p>
                  </FramePanel>
                </Frame>

                <StorageUsageSection config={config} isOpen={isOpen} />
              </TabsPanel>

              <TabsPanel value="health" className="space-y-4">
                <Frame className="border border-border/75">
                  <div className="px-3.5 py-2 text-[12px] font-semibold text-foreground">
                    引擎运行态与 SQLite 一致性备份护栏
                  </div>
                  <FramePanel className="space-y-2.5 font-mono text-[11.5px] tabular-nums">
                    <div className="flex items-center justify-between gap-2 py-1 border-b border-border/60">
                      <span className="font-sans text-muted-foreground">服务运行状态</span>
                      <Badge
                        variant={config.runtimeStatus.serviceState === 'monitoring' ? 'success' : 'warning'}
                        size="sm"
                      >
                        {config.runtimeStatus.serviceState}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-1 border-b border-border/60">
                      <span className="font-sans text-muted-foreground">当前索引代际</span>
                      <span className="text-foreground">第 {config.runtimeStatus.indexGeneration} 代</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-1 border-b border-border/60">
                      <span className="font-sans text-muted-foreground">SSE 事件序号</span>
                      <span className="text-foreground">#{config.runtimeStatus.sseSeq}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-1">
                      <span className="font-sans text-muted-foreground">升级前一致性备份</span>
                      <span className="inline-flex items-center gap-1 font-sans text-[color:var(--stage-ink-deliver-text)]">
                        <ShieldCheck className="size-3.5" aria-hidden="true" />
                        SQLite Backup API 自动保留最近 5 份
                      </span>
                    </div>
                  </FramePanel>
                </Frame>
              </TabsPanel>

              <TabsPanel value="about" className="space-y-4">
                <Frame className="border border-border/75">
                  <div className="px-3.5 py-2 text-[12px] font-semibold text-foreground">
                    关于观澜（Guanlan）
                  </div>
                  <FramePanel className="space-y-3.5">
                    <div
                      data-about-brand-hero=""
                      className="flex items-center gap-3.5 rounded-lg border border-border/70 bg-muted/25 p-3.5"
                    >
                      <BrandMark size="xl" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-baseline gap-2 min-w-0">
                            <span className="font-serif-claude text-[16px] leading-tight font-semibold tracking-tight text-foreground">
                              {BRAND_NAME}
                            </span>
                            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                              {BRAND_NAME_EN}
                            </span>
                          </div>
                          <Badge
                            variant="brand"
                            size="sm"
                            data-about-version={APP_BUILD_INFO.version}
                            className="font-mono tabular-nums shrink-0"
                          >
                            {APP_BUILD_INFO.versionTag}
                          </Badge>
                        </div>
                        <p className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                          <span
                            aria-hidden="true"
                            className="inline-block size-1.5 shrink-0 rounded-full bg-[#E86E3B]"
                          />
                          <span>{BRAND_SLOGAN}</span>
                        </p>
                        <p className="text-[11.5px] leading-snug text-muted-foreground">
                          {BRAND_SLOGAN_NOTE}
                        </p>
                      </div>
                    </div>
                    <p className="text-muted-foreground leading-relaxed">
                      本地优先、只读安全边界与双时间语义护栏：所有索引、版本快照、决策溯源与静默清单均落盘于本机私有数据目录，绝不向用户业务目录写入无关配置文件。
                    </p>
                    <div className="rounded-lg border border-border/70 bg-muted/35 divide-y divide-border/60 font-mono text-[11.5px] tabular-nums">
                      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="font-sans text-muted-foreground">发行版本（三端同步）</span>
                        <span className="text-foreground font-semibold">{APP_BUILD_INFO.versionTag}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="font-sans text-muted-foreground">构建提交（Git SHA）</span>
                        <span data-about-git-sha={APP_BUILD_INFO.gitSha} className="text-foreground">
                          {APP_BUILD_INFO.gitSha}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="font-sans text-muted-foreground">构建时间戳</span>
                        <span
                          data-about-build-time={APP_BUILD_INFO.buildTime}
                          className="text-foreground"
                        >
                          {formatBuildTimestamp(APP_BUILD_INFO.buildTime)}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-2 pt-1" data-about-update="">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={
                            !updateBridgeAvailable ||
                            updateState.kind === 'checking' ||
                            updateState.kind === 'installing'
                          }
                          onClick={() => void handleCheckUpdate()}
                        >
                          <RefreshCw
                            className={`h-3 w-3 ${updateState.kind === 'checking' ? 'animate-spin' : ''}`}
                          />
                          <span>{updateState.kind === 'checking' ? '检查中…' : '检查更新'}</span>
                        </Button>
                        {updateStatusText ? (
                          <span
                            className="text-[11px] text-muted-foreground"
                            data-about-update-status={updateState.kind}
                          >
                            {updateStatusText}
                          </span>
                        ) : null}
                      </div>
                      {updateState.kind === 'available' ? (
                        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/35 px-3 py-2">
                          <div className="text-[12px] font-medium text-foreground">
                            发现新版本 v{updateState.check.version}（当前 v
                            {updateState.check.currentVersion}）
                          </div>
                          {updateState.check.notes ? (
                            <div className="max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                              {updateState.check.notes}
                            </div>
                          ) : null}
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void handleInstallUpdate()}
                          >
                            <Download className="h-3 w-3" />
                            <span>下载并安装</span>
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Badge variant="outline" size="sm">coss.com/ui + @base-ui/react</Badge>
                      <Badge variant="outline" size="sm">Rust SQLite + WAL</Badge>
                      <Badge variant="outline" size="sm">Tauri 2 Desktop</Badge>
                    </div>
                  </FramePanel>
                </Frame>
              </TabsPanel>
            </div>
          </ScrollArea>
        </Tabs>
      </div>
    </div>
  );
};
