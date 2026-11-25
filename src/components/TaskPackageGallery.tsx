import React, { useMemo, useState } from 'react';
import { FolderOpen, Package } from 'lucide-react';
import type { FileRecord } from '../types/guanlan';
import type { StateOverviewResponse } from '../services/apiTypes';
// 筛选/阶段判定全部消费 taskPackages 产出（零新造判定）
import {
  formatPackageMetaLine,
  packageBadgeLine,
  packageVersionNumber,
  STAGE_ACCENT,
  STAGE_SLOT_ORDER,
} from '../utils/taskPackages';
// 统一状态机 SSOT：筛选胶囊词表来自 stateProjection——executing/awaiting
// 直接取 STAGE_BADGE_PHRASE，与卡片徽标短语同源；胶囊排版骨架
// 亦单一出口（PILL_LAYOUT_BASE——本组件只配颜色/阴影件）。
// /state-overview 投影优先渲染六态词；无服务端行时 projectInitiativeState
// 的 fallback 分支保留既有阶段短语。
import {
  DOC_STATE_LABEL,
  GALLERY_FILTERS,
  PILL_LAYOUT_BASE,
  docStatePillClass,
  indexStateOverview,
  initiativeStateBadgeLine,
  initiativeStateOfPackage,
  projectInitiativeState,
} from '../utils/stateProjection';
import type { GalleryFilterKey } from '../utils/stateProjection';
// 既有消费面保兼容：词表 SSOT 在 stateProjection，此处再导出
export { GALLERY_FILTERS } from '../utils/stateProjection';
export type { GalleryFilterKey } from '../utils/stateProjection';
import type { StageRole, TaskPackage } from '../utils/taskPackages';
import { localDay } from '../utils/timeFormat';
import {
  buildPackageVisualFingerprint,
  SPARKLINE_VIEWBOX_H,
  SPARKLINE_VIEWBOX_W,
  type PackageVisualFingerprint,
} from '../utils/packageFingerprint';
import type { FileContextMenuTarget } from './FileContextMenu';
import ContextCapsuleModal, { type CapsuleTargetPreset } from './ContextCapsuleModal';
import {
  Badge,
  CardFrame,
  Frame,
  FramePanel,
  Group,
  GroupSeparator,
} from './ui';

export { buildPackageVisualFingerprint } from '../utils/packageFingerprint';

// ============================================================
// 任务包视觉预览网格 · 专项橱窗（coss Frame/CardFrame + 真实数据指纹封面）
//   - 首页与知识库概览共用；筛选与状态投影严格复用 stateProjection SSOT；
//   - 封面舞台注入真实数据驱动的微视觉指纹：近 14 天变更微折线（Sparkline）+
//     格式构成比例彩带（Format Ribbon）+ 清晰更新相对时间（零造数、杜绝空白横条与 60... 截断）；
//   - 明暗双态无缝自适应（全部走语义令牌 bg-card / border-border / var(--glass-hairline)）。
// ============================================================

const STAGE_BADGE_PILL_CLASS =
  PILL_LAYOUT_BASE +
  'bg-card/95 text-[color:var(--ink-strong)] border border-border/75 shadow-xs';

export interface TaskPackageGalleryProps {
  packages: TaskPackage[];
  /** 文件索引（封面/文档回查与真实数据指纹派生） */
  fileById: Map<string, FileRecord>;
  /** svg 封面 dataUri 表（file_id → data:image/svg+xml;utf8,…），调用方必传口径见上 */
  svgDataUris?: Record<string, string>;
  onOpenDoc: (fileId: string) => void;
  activeFileId?: string;
  filter?: GalleryFilterKey;
  onFilterChange?: (key: GalleryFilterKey) => void;
  className?: string;
  /** /state-overview 六态投影（App 级唯一数据源）。 */
  stateOverview?: StateOverviewResponse | null;
  /** 右键菜单支持（以包首份核心文件为目标） */
  onOpenFileContextMenu?: (e: React.MouseEvent, target: FileContextMenuTarget) => void;
  /** 可选锚点时间（测试注入固定时刻，生产环境默认当前时间） */
  nowIso?: string;
}

/** 筛选口径（按文档阶段/格式实判，与 GALLERY_FILTERS 五项一一对应，不虚造维度）。 */
function matchesFilter(pkg: TaskPackage, key: GalleryFilterKey): boolean {
  if (key === 'all') return true;
  if (key === 'executing') return pkg.stage === '执行';
  if (key === 'awaiting') return pkg.stage === '交付';
  if (key === 'blueprint') return pkg.stage === '蓝图';
  if (key === 'drawings') return pkg.docs.some((d) => d.format === 'svg');
  return true;
}

/** 取该专项首张已编码 SVG 图纸 dataUri（按 readingOrder 优先）。 */
function coverDataUriOf(
  pkg: TaskPackage,
  svgDataUris?: Record<string, string>
): string | null {
  if (!svgDataUris) return null;
  for (const doc of pkg.readingOrder) {
    if (doc.format === 'svg' && svgDataUris[doc.fileId]) {
      return svgDataUris[doc.fileId];
    }
  }
  for (const doc of pkg.docs) {
    if (doc.format === 'svg' && svgDataUris[doc.fileId]) {
      return svgDataUris[doc.fileId];
    }
  }
  return null;
}

/** 五阶段迷你进度轨（aria-hidden 纯装饰，底轨消费 --glass-hairline 适配明暗双态） */
const FiveStageRail: React.FC<{ stage: StageRole }> = ({ stage }) => {
  const reachedRank = STAGE_SLOT_ORDER.indexOf(stage);
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {STAGE_SLOT_ORDER.map((role, i) => (
        <span
          key={role}
          className="h-1 flex-1 rounded-full motion-safe:transition-opacity"
          style={{
            backgroundColor:
              i <= reachedRank ? STAGE_ACCENT[role] : 'var(--glass-hairline)',
          }}
        />
      ))}
    </span>
  );
};

/** 真实数据驱动的 14 天变更微折线 + 格式构成比例彩带 */
const PackageFingerprintVisual: React.FC<{
  pkgId: string;
  stage: StageRole;
  fingerprint: PackageVisualFingerprint;
  compact?: boolean;
}> = ({ pkgId, stage, fingerprint, compact = false }) => {
  const accent = STAGE_ACCENT[stage];
  const { sparkline14d, formatSegments } = fingerprint;
  const gradId = `glx-pkg-spark-${pkgId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <span className="flex flex-col gap-1.5">
      {/* 14 天变更微折线（全 0 诚实平线，有变动真实起伏） */}
      {!compact && (
        <span
          data-fingerprint-sparkline=""
          data-sparkline-changes={sparkline14d.totalChanges}
          data-sparkline-active-days={sparkline14d.activeDays}
          className="relative flex items-center gap-2 rounded-lg border border-border/60 bg-card/85 px-2 py-1"
        >
          <svg
            viewBox={`0 0 ${SPARKLINE_VIEWBOX_W} ${SPARKLINE_VIEWBOX_H}`}
            className="h-[26px] w-full min-w-0 overflow-visible"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity="0.28" />
                <stop offset="100%" stopColor={accent} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {sparkline14d.totalChanges > 0 ? (
              <>
                <polygon points={sparkline14d.areaPoints} fill={`url(#${gradId})`} />
                <polyline
                  points={sparkline14d.polylinePoints}
                  fill="none"
                  stroke={accent}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </>
            ) : (
              <line
                x1="0"
                y1={SPARKLINE_VIEWBOX_H - 3}
                x2={SPARKLINE_VIEWBOX_W}
                y2={SPARKLINE_VIEWBOX_H - 3}
                stroke="var(--glass-hairline-strong)"
                strokeWidth="1.2"
                strokeDasharray="2 3"
              />
            )}
          </svg>
          <span className="shrink-0 whitespace-nowrap font-mono text-[9.5px] leading-none tabular-nums text-muted-foreground">
            {sparkline14d.totalChanges > 0 ? `14日 +${sparkline14d.totalChanges}` : '14日安静'}
          </span>
        </span>
      )}

      {/* 格式构成比例彩带（严格按真实文档格式计数比例分段，零伪造） */}
      <span data-fingerprint-ribbon="" className="flex flex-col gap-1">
        <span
          className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/80"
          aria-hidden="true"
        >
          {formatSegments.map((seg) => (
            <span
              key={seg.formatClass}
              data-fingerprint-segment={seg.formatClass}
              style={{
                width: `${(seg.ratio * 100).toFixed(2)}%`,
                backgroundColor: seg.color,
              }}
              className="h-full first:rounded-s-full last:rounded-e-full"
              title={`${seg.label} ${seg.count} 份（${Math.round(seg.ratio * 100)}%）`}
            />
          ))}
        </span>
        {formatSegments.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9.5px] leading-none tabular-nums text-muted-foreground">
            {formatSegments.slice(0, 3).map((seg) => (
              <span key={seg.formatClass} className="inline-flex items-center gap-1 whitespace-nowrap">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: seg.color }}
                />
                <span>
                  {seg.shortTag} {seg.count}
                </span>
              </span>
            ))}
            {formatSegments.length > 3 && (
              <span className="whitespace-nowrap opacity-75">+{formatSegments.length - 3} 类</span>
            )}
          </span>
        )}
      </span>
    </span>
  );
};

const TaskPackageGallery: React.FC<TaskPackageGalleryProps> = ({
  packages,
  fileById,
  svgDataUris,
  onOpenDoc,
  activeFileId,
  filter,
  onFilterChange,
  className,
  stateOverview,
  onOpenFileContextMenu,
  nowIso,
}) => {
  // App 级 /state-overview 响应 → 常数查索引（一次构建；无响应 → null 回退阶段词）
  const stateIndex = useMemo(() => indexStateOverview(stateOverview), [stateOverview]);
  // 筛选：filter prop 提供即受控值，缺省走内部 useState 自持（onFilterChange 有则总是回调）
  const [innerFilter, setInnerFilter] = useState<GalleryFilterKey>('all');
  // 事项资料胶囊打包 / 秒开校验弹窗状态（挂载在橱窗内，首页与知识库概览自动共享）
  const [capsulePreset, setCapsulePreset] = useState<CapsuleTargetPreset | null>(null);
  const currentFilter = filter ?? innerFilter;
  const changeFilter = (key: GalleryFilterKey) => {
    setInnerFilter(key);
    onFilterChange?.(key);
  };

  // 各筛选胶囊计数徽标（全部按口径实算，不虚报）
  const counts = useMemo(() => {
    const map = {
      all: packages.length,
      executing: 0,
      awaiting: 0,
      blueprint: 0,
      drawings: 0,
    } as Record<GalleryFilterKey, number>;
    for (const pkg of packages) {
      if (matchesFilter(pkg, 'executing')) map.executing += 1;
      if (matchesFilter(pkg, 'awaiting')) map.awaiting += 1;
      if (matchesFilter(pkg, 'blueprint')) map.blueprint += 1;
      if (matchesFilter(pkg, 'drawings')) map.drawings += 1;
    }
    return map;
  }, [packages]);

  const visiblePackages = useMemo(
    () => packages.filter((pkg) => matchesFilter(pkg, currentFilter)),
    [packages, currentFilter]
  );

  // 批量派生可见专项的真实数据微指纹（零造数）
  const fingerprints = useMemo(() => {
    const map = new Map<string, PackageVisualFingerprint>();
    for (const pkg of visiblePackages) {
      map.set(pkg.id, buildPackageVisualFingerprint(pkg, fileById, nowIso));
    }
    return map;
  }, [visiblePackages, fileById, nowIso]);

  return (
    <section aria-label="专项橱窗" className={className ?? ''}>
      <Frame className="border border-border/75 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-[14.5px] leading-5 font-semibold tracking-tight text-foreground whitespace-nowrap">
              专项橱窗
            </h2>
            <Badge variant="outline" size="sm" className="font-mono tabular-nums whitespace-nowrap">
              {packages.length} 项
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* 按时间段打包开放胶囊 / 另一台观澜秒开校验胶囊（coss Group 紧凑拼接） */}
            <Group
              aria-label="事项胶囊工具"
              className="h-7 shrink-0 rounded-lg border border-border bg-card/85 shadow-xs"
            >
              <button
                type="button"
                onClick={() => setCapsulePreset({ mode: 'export', title: '按时间段自定义范围' })}
                className="inline-flex h-full cursor-pointer items-center gap-1 whitespace-nowrap rounded-s-[7px] px-2.5 text-[11px] font-medium text-foreground hover:bg-accent motion-safe:transition-colors"
                title="按选定时间段导出开放事项资料胶囊（含预览体积与脱敏检查）"
              >
                <Package className="h-3 w-3 text-[color:var(--accent-iris-deep)] shrink-0" />
                <span>时段胶囊</span>
              </button>
              <GroupSeparator className="h-3.5 self-center" />
              <button
                type="button"
                onClick={() => setCapsulePreset({ mode: 'inspect' })}
                className="inline-flex h-full cursor-pointer items-center gap-1 whitespace-nowrap rounded-e-[7px] px-2.5 text-[11px] font-medium text-foreground hover:bg-accent motion-safe:transition-colors"
                title="打开并校验另一台观澜导出的 capsule-manifest.json 胶囊目录"
              >
                <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
                <span>打开胶囊</span>
              </button>
            </Group>

            {/* 筛选分段条：coss 精密凹槽 + 高反差选中浮雕胶囊 */}
            <div
              className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border/75 bg-background/70 dark:bg-card/60 p-0.5"
              role="group"
              aria-label="专项筛选"
            >
              {GALLERY_FILTERS.map((f) => {
                const active = f.key === currentFilter;
                const isEmpty = counts[f.key] === 0 && !active;
                return (
                  <button
                    key={f.key}
                    type="button"
                    data-gallery-filter={f.key}
                    aria-pressed={active}
                    onClick={() => changeFilter(f.key)}
                    className={`flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-[11.5px] leading-4 motion-safe:transition-all ${
                      active
                        ? 'bg-[color:var(--ink-anchor)] font-medium text-[color:var(--paper-on-ink)] shadow-xs'
                        : isEmpty
                          ? 'text-muted-foreground opacity-55 hover:opacity-100 hover:bg-accent/70'
                          : 'text-foreground/85 hover:bg-accent/80 hover:text-foreground'
                    }`}
                  >
                    <span>{f.label}</span>
                    <span
                      className={`font-mono text-[10px] tabular-nums ${
                        active ? 'opacity-80' : 'text-muted-foreground'
                      }`}
                    >
                      {counts[f.key]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 筛选切换网格淡入：基于容器可用宽度的自适应列轨（minmax 252px），彻底消除拥挤与截断 */}
        <FramePanel className="p-3.5">
          <div
            key={currentFilter}
            className="glx-fade-in grid grid-cols-[repeat(auto-fill,minmax(252px,1fr))] gap-3"
          >
            {visiblePackages.length === 0 && (
              <p className="col-span-full py-8 text-center text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-muted-foreground">
                {packages.length === 0 ? '工作区数据就绪后展示任务包' : '当前筛选下暂无专项'}
              </p>
            )}
            {visiblePackages.map((pkg, idx) => {
              // 键盘：卡即按钮，Tab+Enter 打开首份核心文档（readingOrder = 推荐阅读顺序首位）
              const firstDoc = pkg.readingOrder[0] ?? pkg.docs[0] ?? null;
              const coverUri = coverDataUriOf(pkg, svgDataUris);
              const initiative = initiativeStateOfPackage(stateIndex, pkg);
              const projection = projectInitiativeState(initiative, { stage: pkg.stage });
              const badgeLine =
                projection.source === 'server'
                  ? initiativeStateBadgeLine(projection.state, packageVersionNumber(pkg))
                  : packageBadgeLine(pkg);
              const badgePillClass =
                projection.source === 'server'
                  ? docStatePillClass(projection.state)
                  : STAGE_BADGE_PILL_CLASS;
              const isActive =
                activeFileId !== undefined && pkg.docs.some((d) => d.fileId === activeFileId);
              const leadFile = firstDoc ? fileById.get(firstDoc.fileId) : undefined;
              const fingerprint =
                fingerprints.get(pkg.id) ?? buildPackageVisualFingerprint(pkg, fileById, nowIso);
              const stageAccent = STAGE_ACCENT[pkg.stage];

              return (
                <CardFrame
                  key={pkg.id}
                  data-gallery-card={pkg.id}
                  style={{ '--glx-delay': `${Math.min(idx, 8) * 36}ms` } as React.CSSProperties}
                  onContextMenu={(e) => {
                    if (!onOpenFileContextMenu || !leadFile) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenFileContextMenu(e, {
                      kind: 'file',
                      relativePath: leadFile.relative_path,
                      title: leadFile.title,
                      fileId: leadFile.file_id,
                      revisionId: leadFile.current_revision_id,
                    });
                  }}
                  className={`group glx-card-in relative flex flex-col overflow-hidden rounded-xl border bg-card p-0 text-left shadow-xs hover:border-ring/45 hover:shadow-md motion-safe:transition-all ${
                    isActive
                      ? 'border-[color:var(--accent-iris)] ring-2 ring-[color:var(--accent-iris)]/35'
                      : 'border-border/80'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => firstDoc && onOpenDoc(firstDoc.fileId)}
                    title={`${pkg.name} · ${pkg.stage} · ${pkg.docs.length} 份文档${
                      projection.source === 'server'
                        ? ` · 状态 ${DOC_STATE_LABEL[projection.state]}`
                        : ''
                    }${pkg.lastActivity ? ` · 最近 ${localDay(pkg.lastActivity)}` : ''}`}
                    className="flex min-h-0 flex-1 cursor-pointer flex-col text-left"
                  >
                    {/* 封面舞台（data-gallery-cover）：真实数据指纹（14天 Sparkline + 格式构成彩带）或 SVG 展台 */}
                    <span
                      data-gallery-cover=""
                      className="relative flex h-[132px] w-full shrink-0 flex-col justify-between overflow-hidden border-b border-border/60 p-3"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${stageAccent} 5%, var(--card))`,
                      }}
                    >
                      <span className="relative z-[1] flex items-center justify-between gap-2 min-w-0">
                        {badgeLine ? (
                          <span className={badgePillClass}>{badgeLine}</span>
                        ) : (
                          <span className="font-mono text-[10px] leading-none text-muted-foreground whitespace-nowrap">
                            {pkg.stage === '待分类' ? '通用专项' : `${pkg.stage}阶段`}
                          </span>
                        )}
                          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] leading-none tabular-nums text-muted-foreground">
                            {pkg.stage === '待分类' ? '专项' : `${pkg.stage}阶段`}
                          </span>
                      </span>

                      {coverUri ? (
                        <>
                          <span className="relative my-1 flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-background/90 p-1">
                            <img
                              src={coverUri}
                              alt=""
                              aria-hidden="true"
                              loading="lazy"
                              className="h-full w-full object-contain motion-safe:transition-transform motion-safe:duration-300 group-hover:scale-105"
                            />
                          </span>
                          <PackageFingerprintVisual
                            pkgId={pkg.id}
                            stage={pkg.stage}
                            fingerprint={fingerprint}
                            compact
                          />
                        </>
                      ) : (
                        <>
                          <PackageFingerprintVisual
                            pkgId={pkg.id}
                            stage={pkg.stage}
                            fingerprint={fingerprint}
                          />
                          <FiveStageRail stage={pkg.stage} />
                        </>
                      )}
                    </span>

                    {/* 信息前两行：包名 / 1 行核心摘要 */}
                    <span className="flex min-h-0 flex-1 flex-col gap-1 px-3.5 pt-3 pb-2">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: stageAccent }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-foreground group-hover:text-[color:var(--accent-iris-deep)] motion-safe:transition-colors">
                          {pkg.name}
                        </span>
                        {projection.source === 'server' && (
                          <span
                            data-doc-state={projection.state}
                            className={`shrink-0 whitespace-nowrap ${docStatePillClass(projection.state)}`}
                            title={`文档状态：${DOC_STATE_LABEL[projection.state]}`}
                          >
                            {DOC_STATE_LABEL[projection.state]}
                          </span>
                        )}
                      </span>
                      {(() => {
                        const summaryText = pkg.latestConclusion
                          ? pkg.latestConclusion
                          : pkg.docs.length > 0
                            ? `收录 ${pkg.docs
                                .slice(0, 2)
                                .map((d) => d.title)
                                .join('、')}${pkg.docs.length > 2 ? ` 等 ${pkg.docs.length} 份` : ''}`
                            : '暂无文档摘要';
                        return (
                          <span
                            className="line-clamp-1 text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-muted-foreground"
                            title={summaryText}
                          >
                            {summaryText}
                          </span>
                        );
                      })()}
                    </span>
                  </button>

                  {/* 元信息底行 + 一键打包胶囊按钮（同级兄弟节点，无嵌套 button；强制不截断「60 份」） */}
                  <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/25 px-3.5 py-2 text-[11px] leading-4 font-mono text-muted-foreground tabular-nums">
                    <span
                      data-gallery-meta=""
                      className="flex items-center gap-1.5 min-w-0"
                      title={formatPackageMetaLine(pkg)}
                    >
                      <span className="whitespace-nowrap shrink-0 font-medium text-foreground/85">
                        {fingerprint.docCountLabel}
                      </span>
                      <span aria-hidden="true" className="opacity-35 shrink-0">·</span>
                      <span className="truncate whitespace-nowrap">
                        {fingerprint.updatedRelativeLabel}
                      </span>
                    </span>
                    <button
                      type="button"
                      data-capsule-export={pkg.id}
                      onClick={() =>
                        setCapsulePreset({
                          mode: 'export',
                          title: pkg.name,
                          initiativeId: initiative?.initiative_id ?? null,
                          fileIds: pkg.docs.map((d) => d.fileId),
                        })
                      }
                      title={`打包「${pkg.name}」为开放事项资料胶囊（先预览体积与脱敏项）`}
                      className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-border/75 bg-card px-2 py-0.5 font-sans text-[10.5px] font-medium text-foreground hover:border-ring/50 hover:bg-accent hover:text-[color:var(--accent-iris-deep)] motion-safe:transition-colors"
                    >
                      <Package className="h-3 w-3 shrink-0" />
                      <span>打包胶囊</span>
                    </button>
                  </div>

                  {/* 轻引导：hover 渐显右上角「进入专项 →」深墨胶囊 */}
                  <span
                    aria-hidden="true"
                    className="glx-t-fade pointer-events-none absolute right-2.5 top-2.5 z-10 rounded-full bg-[color:var(--ink-anchor)] px-2.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--paper-on-ink)] opacity-0 shadow-md group-hover:opacity-100"
                  >
                    进入专项 →
                  </span>
                </CardFrame>
              );
            })}
          </div>
        </FramePanel>
      </Frame>

      <ContextCapsuleModal
        isOpen={capsulePreset !== null}
        preset={capsulePreset}
        onClose={() => setCapsulePreset(null)}
        onOpenLocalDoc={onOpenDoc}
      />
    </section>
  );
};

export default TaskPackageGallery;
