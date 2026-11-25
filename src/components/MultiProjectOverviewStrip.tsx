/**
 * 今日首页「多项目工作台」总览条（coss Frame / CardFrame / Group 布局）：
 * - 展示所有已纳入观澜管理的本地项目卡片（在线/扫描/只读/离线状态、文件数、目录数、待拍板数）；
 * - 所有指标项强制 whitespace-nowrap + 响应式换行，根治「720 文\n件」折行穿帮；
 * - 支持一键添加新项目、零重启聚焦到任意项目（首页 / 全景星图 / 知识资产库）；
 * - 汇总其他项目的待拍板决策与最新活跃文档，点击直接跨项目跳转原文或证据。
 */

import React from 'react';
import {
  AlertCircle,
  FileText,
  FolderOpen,
  FolderPlus,
  Layers,
  Loader2,
  Lock,
  Orbit,
} from 'lucide-react';
import type {
  CrossProjectDecisionItemDto,
  CrossProjectRecentFileDto,
  ProjectEntryDto,
  ProjectsOverviewResponseDto,
} from '../services/apiTypes';
import { formatRelativeObservedAt } from '../utils/timeFormat';
import { formatUiMeta } from '../utils/formatMeta';
import { Button } from './ui/primitives';
import { Badge, Frame, FramePanel, Group, GroupSeparator } from './ui';

export interface MultiProjectOverviewStripProps {
  overview: ProjectsOverviewResponseDto | null;
  projects: ProjectEntryDto[];
  activeProjectId: string;
  onAddProject: () => void;
  onFocusProject: (projectId: string, targetTab?: 'home' | 'panorama' | 'library') => void;
  onOpenCrossDecision: (item: CrossProjectDecisionItemDto) => void;
  onOpenCrossFile: (item: CrossProjectRecentFileDto) => void;
}

export const MultiProjectOverviewStrip: React.FC<MultiProjectOverviewStripProps> = ({
  overview,
  projects,
  activeProjectId,
  onAddProject,
  onFocusProject,
  onOpenCrossDecision,
  onOpenCrossFile,
}) => {
  const list = overview?.projects?.length ? overview.projects : projects;
  if (list.length === 0) return null;

  const otherDecisions = (overview?.pending_decisions ?? []).filter(
    (d) => d.project_id !== activeProjectId
  );
  const otherRecentFiles = (overview?.recent_files ?? []).filter(
    (f) => f.project_id !== activeProjectId
  );
  const totalAssets = overview?.total_files ?? list.reduce((a, p) => a + p.file_count, 0);

  // 单项目且无跨项目动态时收拢为单行紧凑工作区条，避免 3 列网格在首屏留出大面积空白，
  // 让核心可视化图表第一时间落入首屏视口；多项目时展开完整卡片矩阵与资产占比微条。
  if (list.length === 1 && otherDecisions.length === 0 && otherRecentFiles.length === 0) {
    const project = list[0];
    const active = project.project_id === activeProjectId;
    const offline =
      project.status === 'offline' ||
      project.status === 'root_in_use' ||
      project.status === 'error';

    return (
      <section aria-label="多项目工作台" data-multi-project-overview="" data-project-layout="compact">
        <Frame className="border border-border/75 shadow-xs">
          <FramePanel className="px-3.5 py-2">
            <div
              data-project-card={project.project_id}
              data-project-card-active={active ? 'true' : 'false'}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onFocusProject(project.project_id, 'home')}
                  className="flex items-center gap-2 shrink-0 max-w-[180px] text-left cursor-pointer group"
                  title={`当前工作区「${project.name}」（${project.root_path}）`}
                >
                  <FolderOpen className="w-4 h-4 shrink-0 text-[color:var(--accent-iris-deep)]" />
                  <span className="text-[13px] font-semibold text-foreground truncate group-hover:text-[color:var(--accent-iris-ink)]">
                    {project.name}
                  </span>
                </button>
                {active && (
                  <Badge variant="brand" size="sm" className="shrink-0 whitespace-nowrap">
                    当前聚焦
                  </Badge>
                )}
                {project.is_scanning && (
                  <Badge variant="brand" size="sm" title="后台正在对账索引" className="shrink-0 whitespace-nowrap">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    同步中
                  </Badge>
                )}
                {project.readonly && (
                  <Badge variant="secondary" size="sm" title="只读归档保护" className="shrink-0 whitespace-nowrap">
                    <Lock className="w-2.5 h-2.5" />
                    只读
                  </Badge>
                )}
                {offline && (
                  <Badge
                    variant="error"
                    size="sm"
                    title={project.error || '目录不可访问'}
                    className="shrink-0 whitespace-nowrap"
                  >
                    <AlertCircle className="w-2.5 h-2.5" />
                    离线
                  </Badge>
                )}
                <span
                  className="hidden xl:inline-block min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={project.root_path}
                >
                  {project.root_path}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <div
                  data-project-metrics=""
                  className="flex items-center gap-1.5 font-sans text-[11.5px] tabular-nums text-muted-foreground"
                >
                  <span className="whitespace-nowrap shrink-0">{project.file_count} 文件</span>
                  <span aria-hidden="true" className="opacity-35 shrink-0">·</span>
                  <span className="whitespace-nowrap shrink-0">{project.folder_count} 目录</span>
                  {project.pending_decisions_count > 0 && (
                    <>
                      <span aria-hidden="true" className="opacity-35 shrink-0">·</span>
                      <span className="whitespace-nowrap shrink-0 text-[color:var(--accent-wave)] font-medium">
                        {project.pending_decisions_count} 待拍板
                      </span>
                    </>
                  )}
                </div>

                {!offline && (
                  <Group
                    aria-label={`${project.name}快捷视图`}
                    className="h-6 shrink-0 rounded-md border border-border bg-muted/45"
                  >
                    <button
                      type="button"
                      onClick={() => onFocusProject(project.project_id, 'panorama')}
                      title={`打开「${project.name}」的全景星图`}
                      className="inline-flex h-full items-center gap-1 whitespace-nowrap rounded-s-[5px] px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-[color:var(--accent-iris-ink)] cursor-pointer motion-safe:transition-colors"
                    >
                      <Orbit className="w-3 h-3 shrink-0" />
                      <span>星图</span>
                    </button>
                    <GroupSeparator className="h-3 self-center" />
                    <button
                      type="button"
                      onClick={() => onFocusProject(project.project_id, 'library')}
                      title={`进入「${project.name}」的知识资产库`}
                      className="inline-flex h-full items-center gap-1 whitespace-nowrap rounded-e-[5px] px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-[color:var(--accent-iris-ink)] cursor-pointer motion-safe:transition-colors"
                    >
                      <Layers className="w-3 h-3 shrink-0" />
                      <span>资料</span>
                    </button>
                  </Group>
                )}

                <Button
                  variant="secondary"
                  size="sm"
                  data-home-add-project-btn=""
                  onClick={onAddProject}
                  className="h-6 px-2 text-[11px] whitespace-nowrap"
                >
                  <FolderPlus className="w-3 h-3 text-[color:var(--accent-iris-deep)]" />
                  <span>添加项目</span>
                </Button>
              </div>
            </div>
          </FramePanel>
        </Frame>
      </section>
    );
  }

  return (
    <section aria-label="多项目工作台" data-multi-project-overview="" data-project-layout="grid">
      <Frame className="border border-border/75 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <h2 className="text-[14.5px] leading-5 font-semibold tracking-tight text-foreground whitespace-nowrap">
              多项目工作台
            </h2>
            <Badge variant="outline" size="sm" className="font-mono tabular-nums whitespace-nowrap">
              {list.length} 项目 · {totalAssets} 资产
            </Badge>
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-home-add-project-btn=""
            onClick={onAddProject}
            className="whitespace-nowrap"
          >
            <FolderPlus className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)]" />
            <span>添加项目</span>
          </Button>
        </div>

        {/* 项目卡片矩阵 */}
        <FramePanel className="p-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {list.map((project) => {
              const active = project.project_id === activeProjectId;
              const offline =
                project.status === 'offline' ||
                project.status === 'root_in_use' ||
                project.status === 'error';
              const sharePct =
                totalAssets > 0 ? Math.max(4, Math.round((project.file_count / totalAssets) * 100)) : 0;
              return (
                <div
                  key={project.project_id}
                  data-project-card={project.project_id}
                  data-project-card-active={active ? 'true' : 'false'}
                  className={`rounded-xl border p-3.5 flex flex-col justify-between gap-3 bg-card text-card-foreground motion-safe:transition-all ${
                    active
                      ? 'border-[color:var(--accent-iris-deep)] ring-1 ring-[color:color-mix(in_srgb,var(--accent-iris)_28%,transparent)] shadow-xs'
                      : 'border-border/80 hover:border-ring/40 hover:shadow-sm'
                  }`}
                >
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onFocusProject(project.project_id, 'home')}
                        className="flex items-center gap-2 min-w-0 text-left cursor-pointer group"
                        title={`聚焦到项目「${project.name}」（${project.root_path}）`}
                      >
                        <FolderOpen
                          className={`w-4 h-4 shrink-0 ${
                            active
                              ? 'text-[color:var(--accent-iris-deep)]'
                              : 'text-[color:var(--ink-faint)] group-hover:text-[color:var(--accent-iris-deep)]'
                          }`}
                        />
                        <span className="text-[13.5px] font-semibold text-foreground truncate group-hover:text-[color:var(--accent-iris-ink)]">
                          {project.name}
                        </span>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        {project.is_scanning && (
                          <Badge variant="brand" size="sm" title="后台正在对账索引" className="whitespace-nowrap">
                            <Loader2 className="w-2.5 h-2.5 animate-spin" />
                            同步中
                          </Badge>
                        )}
                        {project.readonly && (
                          <Badge variant="secondary" size="sm" title="只读归档保护" className="whitespace-nowrap">
                            <Lock className="w-2.5 h-2.5" />
                            只读
                          </Badge>
                        )}
                        {active && (
                          <Badge variant="brand" size="sm" className="whitespace-nowrap">
                            当前聚焦
                          </Badge>
                        )}
                        {offline && (
                          <Badge
                            variant="error"
                            size="sm"
                            title={project.error || '目录不可访问'}
                            className="whitespace-nowrap"
                          >
                            <AlertCircle className="w-2.5 h-2.5" />
                            离线
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div
                      className="font-mono text-[10.5px] text-muted-foreground truncate"
                      title={project.root_path}
                    >
                      {project.root_path}
                    </div>

                    {totalAssets > 0 && (
                      <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70"
                        title={`占全部纳管资产 ${Math.round((project.file_count / totalAssets) * 100)}%（${project.file_count} / ${totalAssets}）`}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${sharePct}%`,
                            backgroundColor: active
                              ? 'var(--accent-iris-deep)'
                              : 'color-mix(in srgb, var(--accent-iris-deep) 45%, transparent)',
                          }}
                        />
                      </div>
                    )}
                  </div>

                  {/* 指标与入口均强制 whitespace-nowrap + 响应式换行，避免「720 文\n件」折行 */}
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 pt-2.5 border-t border-border/70">
                    <div
                      data-project-metrics=""
                      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                    >
                      <span className="whitespace-nowrap shrink-0">{project.file_count} 文件</span>
                      <span aria-hidden="true" className="opacity-35 shrink-0">·</span>
                      <span className="whitespace-nowrap shrink-0">{project.folder_count} 目录</span>
                      {project.pending_decisions_count > 0 && (
                        <>
                          <span aria-hidden="true" className="opacity-35 shrink-0">·</span>
                          <span className="whitespace-nowrap shrink-0 text-[color:var(--accent-wave)] font-medium">
                            {project.pending_decisions_count} 待拍板
                          </span>
                        </>
                      )}
                    </div>

                    {!offline && (
                      <Group
                        aria-label={`${project.name}快捷视图`}
                        className="h-6 shrink-0 rounded-md border border-border bg-muted/45"
                      >
                        <button
                          type="button"
                          onClick={() => onFocusProject(project.project_id, 'panorama')}
                          title={`打开「${project.name}」的全景星图`}
                          className="inline-flex h-full items-center gap-1 whitespace-nowrap rounded-s-[5px] px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-[color:var(--accent-iris-ink)] cursor-pointer motion-safe:transition-colors"
                        >
                          <Orbit className="w-3 h-3 shrink-0" />
                          <span>星图</span>
                        </button>
                        <GroupSeparator className="h-3 self-center" />
                        <button
                          type="button"
                          onClick={() => onFocusProject(project.project_id, 'library')}
                          title={`进入「${project.name}」的知识资产库`}
                          className="inline-flex h-full items-center gap-1 whitespace-nowrap rounded-e-[5px] px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-[color:var(--accent-iris-ink)] cursor-pointer motion-safe:transition-colors"
                        >
                          <Layers className="w-3 h-3 shrink-0" />
                          <span>资料</span>
                        </button>
                      </Group>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 其他项目的待拍板与近期动态（仅当存在其他项目内容时呈现，点击即跨项目秒切跳转） */}
          {(otherDecisions.length > 0 || otherRecentFiles.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 pt-0.5">
              {otherDecisions.length > 0 && (
                <div className="rounded-xl bg-muted/45 border border-border/70 p-3 space-y-1.5">
                  <div className="text-[11px] font-semibold text-muted-foreground">
                    其他项目待拍板（{otherDecisions.length}）
                  </div>
                  <div className="space-y-1">
                    {otherDecisions.slice(0, 4).map((d) => (
                      <button
                        key={`${d.project_id}:${d.decision_id}`}
                        type="button"
                        onClick={() => onOpenCrossDecision(d)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-card text-left cursor-pointer motion-safe:transition-colors"
                      >
                        <Badge variant="brand" size="sm" className="shrink-0 whitespace-nowrap">
                          {d.project_name}
                        </Badge>
                        <span className="flex-1 min-w-0 truncate text-[12px] text-foreground">
                          {d.question || d.code}
                        </span>
                        <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-[color:var(--accent-wave)]">
                          {d.status}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {otherRecentFiles.length > 0 && (
                <div className="rounded-xl bg-muted/45 border border-border/70 p-3 space-y-1.5">
                  <div className="text-[11px] font-semibold text-muted-foreground">
                    其他项目近期动态
                  </div>
                  <div className="space-y-1">
                    {otherRecentFiles.slice(0, 4).map((f) => {
                      const meta = formatUiMeta(f.format);
                      return (
                        <button
                          key={`${f.project_id}:${f.file_id}`}
                          type="button"
                          onClick={() => onOpenCrossFile(f)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-card text-left cursor-pointer motion-safe:transition-colors"
                        >
                          <Badge variant="brand" size="sm" className="shrink-0 whitespace-nowrap">
                            {f.project_name}
                          </Badge>
                          <FileText
                            className="w-3 h-3 shrink-0"
                            style={{ color: meta.dotColor }}
                          />
                          <span className="flex-1 min-w-0 truncate text-[12px] text-foreground">
                            {f.title}
                          </span>
                          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground">
                            {formatRelativeObservedAt(f.observed_at)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </FramePanel>
      </Frame>
    </section>
  );
};
