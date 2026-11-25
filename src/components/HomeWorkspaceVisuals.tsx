/**
 * 首页工作区态势图谱（首屏右侧视觉驾驶舱）：
 * 用三组零造数的定制可视化替代散文说明，细节下沉到交互悬浮与模式切换中：
 *  1. 态势环（overview）：SVG 阅读覆盖圆环（已读/更新待复读/未读新件）+ 拍板态势比例条；
 *  2. 阶段流（stages）：五阶段推进流（蓝图 → 计划 → 决策 → 执行 → 交付）横向比例轨；
 *  3. 格式谱（formats）：全库格式构成彩带 + ≤5 项分组明细（低频格式收拢并留悬浮明细）。
 *
 * 所有数值由 src/utils/homeInsights.ts 纯函数严格守恒派生，零虚构估算。
 */

import React, { useMemo, useState } from 'react';
import { ArrowUpRight, CheckCircle2 } from 'lucide-react';
import type { DecisionAssertion, FileRecord, ReadingState } from '../types/guanlan';
import type { TaskPackage } from '../utils/taskPackages';
import {
  READING_RING_CIRCUMFERENCE,
  READING_RING_RADIUS,
  buildDecisionGaugeModel,
  buildFormatAtlasModel,
  buildReadingCoverageModel,
  buildStageFlowModel,
  type ReadingBucketKey,
} from '../utils/homeInsights';
import { CardFrame } from './ui';

export type WorkspaceVisualTab = 'overview' | 'stages' | 'formats';

export interface HomeWorkspaceVisualsProps {
  files: readonly FileRecord[];
  readingStates: Record<string, ReadingState>;
  packages: readonly TaskPackage[];
  decisions: readonly DecisionAssertion[];
  decisionsUnresolvedTotal?: number | null;
  onOpenDecision?: (decisionId: string) => void;
  onOpenDoc: (fileId: string) => void;
  onOpenPackageBoard: () => void;
  className?: string;
}

const VISUAL_TABS: ReadonlyArray<{ key: WorkspaceVisualTab; label: string }> = [
  { key: 'overview', label: '态势环' },
  { key: 'stages', label: '阶段流' },
  { key: 'formats', label: '格式谱' },
];

export const HomeWorkspaceVisuals: React.FC<HomeWorkspaceVisualsProps> = ({
  files,
  readingStates,
  packages,
  decisions,
  decisionsUnresolvedTotal,
  onOpenDecision,
  onOpenDoc,
  onOpenPackageBoard,
  className,
}) => {
  const [tab, setTab] = useState<WorkspaceVisualTab>('overview');
  const [hoveredSlice, setHoveredSlice] = useState<ReadingBucketKey | null>(null);
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);

  const reading = useMemo(
    () => buildReadingCoverageModel(files, readingStates),
    [files, readingStates]
  );
  const decisionGauge = useMemo(
    () => buildDecisionGaugeModel(decisions, decisionsUnresolvedTotal),
    [decisions, decisionsUnresolvedTotal]
  );
  const stageFlow = useMemo(() => buildStageFlowModel(packages), [packages]);
  const formatAtlas = useMemo(
    () => buildFormatAtlasModel(files, readingStates),
    [files, readingStates]
  );

  const activeSlice = hoveredSlice
    ? reading.slices.find((s) => s.key === hoveredSlice) ?? null
    : null;

  const activeStageNode = hoveredStage
    ? stageFlow.nodes.find((n) => n.stage === hoveredStage) ?? null
    : stageFlow.nodes.find((n) => n.docCount > 0) ?? null;

  // 拍板态势比例条分母：已加载决策 + 服务端未展开差额
  const decisionBarDenom =
    decisionGauge.conflictCount +
    decisionGauge.pendingCount +
    decisionGauge.unloadedUnresolved +
    decisionGauge.resolvedCount;

  return (
    <CardFrame
      aria-label="工作区态势图谱"
      data-home-visual-cockpit=""
      className={`flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-5 shadow-xs ${className ?? ''}`}
    >
      {/* 顶栏：极简标题 + 三态图表切换控件 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="text-[15px] leading-[22px] font-semibold tracking-tight text-foreground whitespace-nowrap">
            工作区态势
          </h2>
          <span className="font-mono text-[10.5px] tracking-[0.12em] uppercase text-muted-foreground">
            ATLAS
          </span>
        </div>

        <div
          role="tablist"
          aria-label="态势图表切换"
          className="inline-flex items-center rounded-lg border border-border/80 bg-muted/60 p-0.5"
        >
          {VISUAL_TABS.map((item) => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-home-visual-tab={item.key}
                onClick={() => setTab(item.key)}
                className={`cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] leading-none font-medium motion-safe:transition-colors ${
                  active
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 主图区：三张定制可视化按切换展示 */}
      {tab === 'overview' && (
        <div data-home-visual-panel="overview" className="mt-4 flex flex-1 flex-col justify-between gap-4">
          {reading.total === 0 ? (
            <div className="flex flex-1 min-h-[144px] flex-col items-center justify-center gap-2 text-center">
              <svg viewBox="0 0 120 120" className="size-24" aria-hidden="true">
                <circle
                  cx="60"
                  cy="60"
                  r={READING_RING_RADIUS}
                  fill="none"
                  stroke="var(--glass-hairline)"
                  strokeWidth="10"
                />
              </svg>
              <span className="text-[12px] text-muted-foreground">等待工作区索引就绪</span>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row lg:flex-col xl:flex-row items-center gap-3.5">
              {/* 定制 SVG 阅读覆盖环 */}
              <div className="relative flex shrink-0 items-center justify-center">
                <svg
                  viewBox="0 0 120 120"
                  className="size-[112px] xl:size-[116px] -rotate-90"
                  role="img"
                  aria-label={`阅读覆盖环：已读 ${reading.readCount} 份，更新待复读 ${reading.updatedCount} 份，未读 ${reading.unreadCount} 份`}
                >
                  <circle
                    cx="60"
                    cy="60"
                    r={READING_RING_RADIUS}
                    fill="none"
                    stroke="var(--glass-hairline)"
                    strokeWidth="11"
                  />
                  {reading.slices.map((slice) => {
                    if (slice.count <= 0) return null;
                    const isFocused = hoveredSlice === slice.key;
                    const dimmed = hoveredSlice !== null && !isFocused;
                    return (
                      <circle
                        key={slice.key}
                        cx="60"
                        cy="60"
                        r={READING_RING_RADIUS}
                        fill="none"
                        stroke={slice.color}
                        strokeWidth={isFocused ? 13 : 11}
                        strokeLinecap="round"
                        strokeDasharray={slice.dashArray}
                        strokeDashoffset={slice.dashOffset}
                        strokeOpacity={dimmed ? 0.3 : 1}
                        className="cursor-pointer motion-safe:transition-all"
                        onMouseEnter={() => setHoveredSlice(slice.key)}
                        onMouseLeave={() => setHoveredSlice(null)}
                      >
                        <title>{`${slice.label}：${slice.count} 份（${slice.pct}%）· ${slice.hint}`}</title>
                      </circle>
                    );
                  })}
                </svg>
                {/* 中心读数：默认展示已读覆盖率，悬浮切换为对应分段明细 */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                  <span className="font-mono text-[22px] leading-none font-bold tabular-nums text-foreground">
                    {activeSlice ? `${activeSlice.pct}%` : `${reading.readPct}%`}
                  </span>
                  <span className="mt-1 text-[10.5px] leading-none font-medium text-muted-foreground">
                    {activeSlice ? activeSlice.label : '已读覆盖'}
                  </span>
                  <span className="mt-1 font-mono text-[10px] leading-none tabular-nums text-muted-foreground">
                    {activeSlice
                      ? `${activeSlice.count} / ${reading.total}`
                      : `${reading.readCount} / ${reading.total}`}
                  </span>
                </div>
              </div>

              {/* 右侧三态图例（3 项低认知负荷，悬浮联动圆环高光） */}
              <div className="flex-1 min-w-0 w-full space-y-1.5">
                {reading.slices.map((slice) => {
                  const isFocused = hoveredSlice === slice.key;
                  return (
                    <div
                      key={slice.key}
                      data-reading-slice={slice.key}
                      onMouseEnter={() => setHoveredSlice(slice.key)}
                      onMouseLeave={() => setHoveredSlice(null)}
                      title={`${slice.label}：${slice.count} 份（${slice.pct}%）· ${slice.hint}`}
                      className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 motion-safe:transition-colors ${
                        isFocused ? 'bg-accent/80' : 'bg-muted/35 hover:bg-accent/50'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: slice.color }}
                          aria-hidden="true"
                        />
                        <span className="truncate text-[12px] font-medium text-foreground">
                          {slice.label}
                        </span>
                      </span>
                      <span className="flex items-baseline gap-1.5 shrink-0 font-mono tabular-nums">
                        <span className="text-[12.5px] font-semibold text-foreground">
                          {slice.count}
                        </span>
                        <span className="text-[10.5px] text-muted-foreground w-8 text-right">
                          {slice.pct}%
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 底部伴随视轨：拍板态势比例条（100% 诚实反映冲突 / 待确认 / 未展开差额 / 已定案） */}
          <div
            data-decision-gauge=""
            className="rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground">
                <span>拍板态势</span>
                {decisionGauge.unresolvedTotal > 0 ? (
                  <span className="text-[11px] font-semibold text-[color:var(--accent-wave)]">
                    未决 <span className="font-mono tabular-nums">{decisionGauge.unresolvedTotal}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--stage-ink-deliver)]">
                    <CheckCircle2 className="size-3" aria-hidden="true" />
                    均已定案
                  </span>
                )}
              </span>

              {decisionGauge.topUrgentDecisionId && onOpenDecision ? (
                <button
                  type="button"
                  onClick={() => onOpenDecision(decisionGauge.topUrgentDecisionId!)}
                  className="inline-flex cursor-pointer items-center gap-0.5 text-[11px] font-medium text-[color:var(--accent-iris-deep)] hover:underline"
                  title="直达优先级最高的待拍板决策原文"
                >
                  <span>去拍板</span>
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </button>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {decisionBarDenom > 0 ? (
                    <>
                      已定案 <span className="font-mono tabular-nums">{decisionGauge.resolvedCount}</span>
                    </>
                  ) : (
                    '无记录'
                  )}
                </span>
              )}
            </div>

            {decisionBarDenom > 0 ? (
              <>
                <div
                  className="flex h-2 w-full overflow-hidden rounded-full bg-[color:var(--glass-hairline)]"
                  title={`来源不一致 ${decisionGauge.conflictCount} · 待确认 ${decisionGauge.pendingCount}${
                    decisionGauge.unloadedUnresolved > 0
                      ? ` · 其余未展开明细 ${decisionGauge.unloadedUnresolved}`
                      : ''
                  } · 已定案 ${decisionGauge.resolvedCount}`}
                >
                  {decisionGauge.conflictCount > 0 && (
                    <span
                      style={{
                        width: `${(decisionGauge.conflictCount / decisionBarDenom) * 100}%`,
                        backgroundColor: 'var(--stage-ink-anomaly)',
                      }}
                    />
                  )}
                  {decisionGauge.pendingCount > 0 && (
                    <span
                      style={{
                        width: `${(decisionGauge.pendingCount / decisionBarDenom) * 100}%`,
                        backgroundColor: 'var(--accent-wave)',
                      }}
                    />
                  )}
                  {decisionGauge.unloadedUnresolved > 0 && (
                    <span
                      style={{
                        width: `${(decisionGauge.unloadedUnresolved / decisionBarDenom) * 100}%`,
                        backgroundColor: 'color-mix(in srgb, var(--accent-wave) 42%, transparent)',
                      }}
                    />
                  )}
                  {decisionGauge.resolvedCount > 0 && (
                    <span
                      style={{
                        width: `${(decisionGauge.resolvedCount / decisionBarDenom) * 100}%`,
                        backgroundColor: 'var(--stage-ink-deliver)',
                      }}
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  {decisionGauge.conflictCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: 'var(--stage-ink-anomaly)' }}
                        aria-hidden="true"
                      />
                      冲突 <span className="font-mono tabular-nums">{decisionGauge.conflictCount}</span>
                    </span>
                  )}
                  {decisionGauge.pendingCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: 'var(--accent-wave)' }}
                        aria-hidden="true"
                      />
                      待确认 <span className="font-mono tabular-nums">{decisionGauge.pendingCount}</span>
                    </span>
                  )}
                  {decisionGauge.unloadedUnresolved > 0 && (
                    <span
                      title="来自服务端全库未决计数，首批样本未展开其明细，故不按样本外推分类"
                      className="inline-flex items-center gap-1"
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{
                          backgroundColor: 'color-mix(in srgb, var(--accent-wave) 45%, transparent)',
                        }}
                        aria-hidden="true"
                      />
                      未展开 <span className="font-mono tabular-nums">{decisionGauge.unloadedUnresolved}</span>
                    </span>
                  )}
                  {decisionGauge.resolvedCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: 'var(--stage-ink-deliver)' }}
                        aria-hidden="true"
                      />
                      已定案 <span className="font-mono tabular-nums">{decisionGauge.resolvedCount}</span>
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="h-2 w-full rounded-full bg-[color:var(--glass-hairline)]" aria-hidden="true" />
            )}
          </div>
        </div>
      )}

      {tab === 'stages' && (
        <div data-home-visual-panel="stages" className="mt-4 flex flex-1 flex-col justify-between gap-3">
          {stageFlow.totalPackages === 0 ? (
            <div className="flex flex-1 min-h-[156px] items-center justify-center text-[12px] text-muted-foreground">
              暂无专项阶段分布
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {stageFlow.nodes.map((node) => {
                  const active = activeStageNode?.stage === node.stage;
                  const leadFileId = node.topPackages[0]?.leadFileId ?? null;
                  const tooltipText =
                    node.topPackages.length > 0
                      ? `${node.stage}：${node.packageCount} 项专项 · ${node.docCount} 份文档（${node.topPackages
                          .map((p) => p.name)
                          .join('、')}）`
                      : `${node.stage}：当前无落位专项`;
                  return (
                    <button
                      key={node.stage}
                      type="button"
                      data-stage-flow-row={node.stage}
                      onMouseEnter={() => setHoveredStage(node.stage)}
                      onFocus={() => setHoveredStage(node.stage)}
                      onClick={() => (leadFileId ? onOpenDoc(leadFileId) : onOpenPackageBoard())}
                      title={tooltipText}
                      className={`group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-left motion-safe:transition-colors ${
                        active ? 'bg-accent/70' : 'hover:bg-accent/45'
                      }`}
                    >
                      <span className="flex w-12 shrink-0 items-center gap-1.5">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: node.docCount > 0 ? node.accent : 'var(--glass-hairline)',
                          }}
                          aria-hidden="true"
                        />
                        <span className="text-[12px] font-medium text-foreground whitespace-nowrap">
                          {node.stage}
                        </span>
                      </span>

                      <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted/70">
                        {node.barWidthPct > 0 && (
                          <span
                            className="block h-full rounded-full motion-safe:transition-all"
                            style={{
                              width: `${node.barWidthPct}%`,
                              backgroundColor: node.accent,
                            }}
                          />
                        )}
                      </span>

                      <span className="w-20 shrink-0 text-right text-[11px] text-muted-foreground whitespace-nowrap">
                        <span className="font-mono font-semibold tabular-nums text-foreground">
                          {node.packageCount}
                        </span>
                        <span> 包 · </span>
                        <span className="font-mono tabular-nums">{node.docCount}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 悬浮详情脚条：展示当前聚焦阶段的真实代表专项，点按直达 */}
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-[11px]">
                <span className="min-w-0 truncate text-muted-foreground">
                  {activeStageNode && activeStageNode.topPackages.length > 0 ? (
                    <>
                      <strong className="font-medium text-foreground">{activeStageNode.stage}</strong>
                      <span className="mx-1.5 opacity-40">·</span>
                      {activeStageNode.topPackages.map((p) => p.name).join('、')}
                    </>
                  ) : (
                    `共 ${stageFlow.totalPackages} 项专项 · ${stageFlow.totalDocs} 份文档`
                  )}
                </span>
                <button
                  type="button"
                  onClick={onOpenPackageBoard}
                  className="shrink-0 cursor-pointer font-medium text-[color:var(--accent-iris-deep)] hover:underline whitespace-nowrap"
                >
                  全部看板 →
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'formats' && (
        <div data-home-visual-panel="formats" className="mt-4 flex flex-1 flex-col justify-between gap-3">
          {formatAtlas.total === 0 ? (
            <div className="flex flex-1 min-h-[156px] items-center justify-center text-[12px] text-muted-foreground">
              暂无文件格式分布
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {/* 比例彩带：真实 ∑count === files.length */}
                <div
                  data-format-atlas-ribbon=""
                  className="flex h-3 w-full overflow-hidden rounded-full bg-muted/70"
                >
                  {formatAtlas.entries.map((entry) => (
                    <span
                      key={entry.key}
                      style={{
                        width: `${Math.max(2, (entry.count / formatAtlas.total) * 100)}%`,
                        backgroundColor: entry.color,
                      }}
                      title={`${entry.label}：${entry.count} 份（${entry.sharePct}%，未读 ${entry.unreadCount} 份）`}
                    />
                  ))}
                </div>

                {/* 分组明细（≤5 项，低认知负荷） */}
                <div className="space-y-1.5">
                  {formatAtlas.entries.map((entry) => {
                    const detailTitle = entry.collapsedDetails
                      ? `${entry.label}（${entry.collapsedDetails
                          .map((d) => `${d.label} ${d.count}`)
                          .join(' · ')}）`
                      : `${entry.label}：${entry.count} 份（占比 ${entry.sharePct}%，未读 ${entry.unreadCount} 份）`;
                    return (
                      <div
                        key={entry.key}
                        data-format-atlas-row={entry.key}
                        title={detailTitle}
                        className="flex items-center gap-2.5 rounded-lg bg-muted/30 px-2.5 py-1.5"
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: entry.color }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                          {entry.label}
                        </span>
                        <span className="shrink-0 rounded bg-card px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground border border-border/60">
                          {entry.shortTag}
                        </span>
                        <span className="w-20 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-foreground whitespace-nowrap">
                          {entry.count}{' '}
                          <span className="text-[10.5px] text-muted-foreground">
                            ({entry.sharePct}%)
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/60 pt-2">
                <span>
                  共 <span className="font-mono font-medium tabular-nums text-foreground">{formatAtlas.distinctClasses}</span> 类格式
                </span>
                <span>
                  总计 <span className="font-mono font-medium tabular-nums text-foreground">{formatAtlas.total}</span> 份
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </CardFrame>
  );
};

export default HomeWorkspaceVisuals;
