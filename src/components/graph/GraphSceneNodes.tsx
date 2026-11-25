/**
 * Scene 节点层 · GraphSceneNodes：
 * 承载扇出虚线容器盒（组头胶囊/收起钮）、司辰立绘、主节点与左侧日期导航卡。
 * 数据一律来自 controller ctx；d3 zoom/drag effect 仍在控制器（按 data-node-id /
 * .d3-draggable-node 类选择器跨子组件查询，保持稳定 DOM 结构）。
 */
import React from 'react';
import { Hourglass } from 'lucide-react';
import { ChronosMascotNode } from '../ChronosMascotNode';
import PackageGroupFrame, { PACKAGE_GROUP_FRAME_H } from '../canvas/PackageGroupFrame';
import RichDocPreviewCard from '../canvas/RichDocPreviewCard';
import { cleanDisplayText } from '../../utils/displayText';
import { computeDynamicEdgePath, hasUnreadChanges, unreadStatusLabel } from '../../utils/guanlanEngine';
// 视口裁剪纯函数（Scene 层消费挂载判定与连接线判定）
import { shouldDrawGroupConnector } from '../../utils/canvasViewport';
import {
  artifactStageBadgeText,
  artifactStateOf,
  DOC_STATE_LABEL,
} from '../../utils/stateProjection';
import { FANOUT_DAY_HEADER_TAIL } from '../../utils/graphEvents';
import {
  DATE_CARD_H,
  DATE_CARD_W,
  DEFAULT_NODE_POSITIONS,
  EVENT_CARD_H,
  EVENT_CARD_W,
  FANOUT_HEADER_BUTTON_W,
  FANOUT_HEADER_CAPSULE_H,
  FANOUT_HEADER_TEXT_LEFT,
  LANE_COLORS,
  LANE_OFFSETS,
  milestoneY,
  FIXED_TEXT_TRUNK_DX,
  SPRING_STAGGER_MS,
  TRUNK_META_TEXT_Y,
  fanOutHeaderButtonLeft,
  fanOutHeaderCapsuleWidth,
  fanOutHeaderCapsuleY,
  sceneDateLabel,
  trunkTickShowsLabel,
  type LaneKey,
} from './geometry';
import type { GraphCanvasCtx } from './useGraphCanvasController';


export function GraphSceneNodes({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    svgRef,
    canvasTool,
    zoomLayerRef,
    meteorShowerEnabled,
    meteorBurstKey,
    canvasLayoutMode,
    mainHubPos,
    trunkX,
    openFileReader,
    activeFileRecord,
    scene,
    rulerGranularity,
    onGranularityChange,
    onDrillToBucket,
    chronosSliderOpen,
    isTimeFlowPlaying,
    accumulationSummary,
    chronosConduits,
    liveFlowEnabled,
    d3RiverStrands,
    trunkTicks,
    TRUNK_AXIS_TOP,
    TRUNK_AXIS_BOTTOM,
    rulerMaxCount,
    rulerLabelStep,
    navigatorDateSet,
    selectDate,
    xrayLaserEnabled,
    leftSourceNodes,
    isNodeVisibleByCategory,
    resolveLeftSourcePos,
    hoveredCanvasNodeId,
    selectedCanvasNodeId,
    setSelectedCanvasNodeId,
    nodePositions,
    activeTimeSlice,
    onOpenDayInTimeline,
    isNodeInActiveTimeSlice,
    subAgentCards,
    fanOutBounds,
    fanOutHeaderLine,
    isFanOutCollapsed,
    setIsFanOutCollapsed,
    chronosPos,
    cycleChronosTimeSlice,
    handleNodeMouseEnter,
    handleNodeMouseLeave,
    workspaceName,
    onSelectFile,
    onSelectEvent,
    exploreAfterClick,
    openNarrativeDrawer,
    systemActions,
    readingStates,
    stateIndex,
    files,
    springRevealKey,
    prefersReducedMotion,
    lodGates,
    pkgTitleOverrides,
    packageGroupLayouts,
    mountedPkgIds,
    packageCardsByPkg,
    focusedPkgId,
    selectedRichDocFileId,
    setSelectedRichDocFileId,
    fileById,
  } = ctx;
  return (
    <>
        {/* 7. Fan-Out Dashed Container Box */}
        {canvasLayoutMode === 'xray' && (
          <g
            className="d3-draggable-node cursor-grab active:cursor-grabbing"
            data-node-id="fan_out_box"
            transform={`translate(${fanOutBounds.x}, ${fanOutBounds.y})`}
          >
            <rect
              x="0"
              y="0"
              width={fanOutBounds.width}
              height={fanOutBounds.height}
              rx="18"
              style={{
                fill: 'color-mix(in srgb, var(--cv-panel) 62%, transparent)',
                stroke: 'color-mix(in srgb, var(--cv-hairline-ink) 11%, transparent)',
              }}
              strokeWidth="1"
            />
            <g
              transform={`translate(12, ${fanOutHeaderCapsuleY(fanOutBounds.y, chronosPos.y)})`}
            >
              {/* 事件轴标题框采用 --cv-axis-title-* 三件套（夜航=lav 调制、纸面=白底深灰字）；
                  胶囊宽经 fanOutHeaderCapsuleWidth 按全量文本自适应，避免标题被提前截断，
                  右缘恒在「收起」按钮左缘之前 ≥14px */}
              <rect
                x="0"
                y="0"
                width={fanOutHeaderCapsuleWidth(fanOutHeaderLine, fanOutBounds.width)}
                height={FANOUT_HEADER_CAPSULE_H}
                rx="13"
                style={{
                  fill: 'var(--cv-axis-title-bg)',
                  stroke: 'var(--cv-axis-title-line)',
                }}
                strokeWidth="1"
              />
              {/* 日期组头可点击，一步切到列表态查看当天全部。
                  文案统一由 fanOutDayHeaderLine 生成：
                  「⑃ {日期} · 共 {n} 条事件（已合并为 {m} 份活跃文档 · 点击查看全天 →）」，
                  n 为当日事件总数（active.count），m 为合并后活跃文档数（active.cards.length）；
                  胶囊纵位经 fanOutHeaderCapsuleY 保证与司辰留白 ≥20px。 */}
              <text
                x={FANOUT_HEADER_TEXT_LEFT}
                y="16.5"
                style={{ fill: 'var(--cv-axis-title-ink)' }}
                fontSize="11.5"
                fontFamily="var(--font-mono)"
                className={
                  scene.hasRealEvents && scene.active && onOpenDayInTimeline
                    ? 'd3-no-pan cursor-pointer'
                    : undefined
                }
                onClick={
                  scene.hasRealEvents && scene.active && onOpenDayInTimeline
                    ? (e) => {
                        e.stopPropagation();
                        onOpenDayInTimeline?.(scene.active!.date);
                      }
                    : undefined
                }
              >
                {fanOutHeaderLine.endsWith(FANOUT_DAY_HEADER_TAIL) ? (
                  <>
                    {fanOutHeaderLine.slice(
                      0,
                      fanOutHeaderLine.length - FANOUT_DAY_HEADER_TAIL.length
                    )}
                    {/* 尾串使用文字档 --cv-lav-ink（白底对比度 6.3:1），避免图形档 --cv-lav 在浅底上对比度不足 */}
                    <tspan style={{ fill: 'var(--cv-lav-ink)' }}>
                      {FANOUT_DAY_HEADER_TAIL}
                    </tspan>
                  </>
                ) : (
                  fanOutHeaderLine
                )}
              </text>

              {/* 事件缺失/加载中时展示空态文案，不回退样本卡片（居中基准随自适应胶囊宽） */}
              {subAgentCards.length === 0 && (
                <text
                  x={Math.max(
                    60,
                    fanOutHeaderCapsuleWidth(fanOutHeaderLine, fanOutBounds.width) / 2
                  )}
                  y={Math.max(64, fanOutBounds.height / 2)}
                  textAnchor="middle"
                  style={{ fill: 'var(--cv-ink-dim)' }}
                  fontSize="11.5"
                  fontFamily="var(--font-mono)"
                >
                  暂无可展示的事件卡片 · 等待工程事件接入后在此展示
                </text>
              )}

              <g
                className="d3-no-pan cursor-pointer"
                transform={`translate(${fanOutHeaderButtonLeft(fanOutBounds.width)}, 0)`}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsFanOutCollapsed((v) => !v);
                }}
              >
                <rect
                  x="0"
                  y="0"
                  width={FANOUT_HEADER_BUTTON_W}
                  height={FANOUT_HEADER_CAPSULE_H}
                  rx="13"
                  style={{
                    fill: 'var(--cv-card)',
                    stroke: 'color-mix(in srgb, var(--cv-hairline-ink) 12%, transparent)',
                  }}
                  strokeWidth="1"
                />
                <text
                  x={FANOUT_HEADER_BUTTON_W / 2}
                  y="16.5"
                  textAnchor="middle"
                  style={{ fill: 'var(--cv-ink-3)' }}
                  fontSize="11"
                  fontFamily="var(--font-sans)"
                >
                  {isFanOutCollapsed ? '展开' : '收起'}
                </text>
              </g>
            </g>
          </g>
        )}

        {/* 7.5 CHRONOS · GOD OF TIME MASCOT NODE
            司辰常驻执掌时间轴：与当前激活日刻度同高，沙漏流沙注入主干，单击切换历史日 / 拖拽吸附刻度 */}
        {chronosSliderOpen && (
          <ChronosMascotNode
            x={chronosPos.x}
            y={chronosPos.y}
            activeTimeSlice={activeTimeSlice}
            isPlaying={isTimeFlowPlaying}
            prefersReducedMotion={prefersReducedMotion}
            epochLabel={(() => {
              if (!scene.hasRealEvents) return undefined;
              const raw = sceneDateLabel(scene.activeDate, rulerGranularity);
              const compactDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.slice(5) : raw;
              const count = scene.active?.count ?? 0;
              return `${compactDate} · +${count} 变动`;
            })()}
            isHovered={hoveredCanvasNodeId === 'chronos_deity'}
            isSelected={selectedCanvasNodeId === 'chronos_deity'}
            onMouseEnter={() => {
              // 司辰悬停卡不依赖文件预览数据，锚定第一个文件仅为兼容锚点结构
              const anchorFileId = files[0]?.file_id;
              if (anchorFileId) handleNodeMouseEnter(anchorFileId, 'chronos_deity');
              else handleNodeMouseEnter('', 'chronos_deity');
            }}
            onMouseLeave={handleNodeMouseLeave}
            onClickCycleTime={cycleChronosTimeSlice}
          />
        )}

        {/* 8. MAIN HUB NODE（司辰时间轴冠徽：以沙漏徽记与文档累积沉淀取代冷冰冰终端符号） */}
        <g
          className="d3-draggable-node cursor-grab active:cursor-grabbing"
          data-node-id="main_hub"
          data-testid="graph-node-main_hub"
          transform={`translate(${mainHubPos.x}, ${mainHubPos.y})`}
          onMouseEnter={() => {
            const hubFileId = files[0]?.file_id;
            if (hubFileId) handleNodeMouseEnter(hubFileId, 'main_hub');
          }}
          onMouseLeave={handleNodeMouseLeave}
          onClick={() => {
            setSelectedCanvasNodeId('main_hub');
            const hubFileId = files[0]?.file_id;
            if (hubFileId) onSelectFile(hubFileId);
          }}
        >
          {xrayLaserEnabled && (
            <rect
              x="-3"
              y="-3"
              width="156"
              height="82"
              rx="14"
              fill="none"
              style={{ stroke: 'color-mix(in srgb, var(--cv-brand) 35%, transparent)' }}
              strokeWidth="1"
              className="animate-sonar-ripple"
            />
          )}
          <foreignObject width="150" height="76">
            <button
              type="button"
              aria-label={`${workspaceName} 资料图谱中枢主节点`}
              className={`glx-canvas-card relative overflow-hidden w-full h-full rounded-xl p-2.5 text-left flex flex-col justify-between cursor-grab active:cursor-grabbing ${
                selectedCanvasNodeId === 'main_hub'
                  ? 'bg-[color:var(--cv-card-selected)] border border-[color:color-mix(in_srgb,var(--cv-brand)_65%,transparent)] shadow-[0_6px_22px_color-mix(in_srgb,var(--cv-brand)_22%,transparent)]'
                  : 'bg-[color:var(--cv-card)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_12%,transparent)] shadow-[0_2px_10px_color-mix(in_srgb,var(--cv-hairline-ink)_7%,transparent)] hover:border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_25%,transparent)]'
              }`}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
                style={{
                  background: 'linear-gradient(90deg, var(--cv-lane-md) 0%, var(--cv-amber) 48%, var(--cv-lav) 100%)',
                }}
              />
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-5 h-5 rounded-md bg-[color:color-mix(in_srgb,var(--cv-brand)_12%,var(--cv-panel))] border border-[color:color-mix(in_srgb,var(--cv-brand)_32%,transparent)] flex items-center justify-center text-[color:var(--cv-brand)] shrink-0">
                  <Hourglass className="w-3 h-3" strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className="font-semibold text-[12px] text-[color:var(--cv-ink)] truncate">
                  司辰时间轴
                </span>
              </div>

              <div className="text-[10.5px] font-mono text-[color:var(--cv-ink-dim)] tabular-nums truncate">
                {scene.hasRealEvents
                  ? `${files.length > 0 ? `${files.length} 文档 · ` : ''}${scene.totals.days} 天沉淀`
                  : '等待时光沉淀'}
              </div>
            </button>
          </foreignObject>
        </g>

        {/* 9. LEFT SOURCE NODES (with generous vertical gap above tests/决策回执...)
            1.2：日期汇总卡 = 独立左侧轨道（x 由 dateCardRailX 派生，离主干 ≥120px、
            离司辰立绘左缘 ≥16px）；本组渲染在 ChronosMascotNode（7.5）之后，
            但几何上零重叠，司辰仍是节点层最底层的装饰主体，任何文字都不压立绘 */}
        {leftSourceNodes.map((src, srcIdx) => {
          if (!isNodeVisibleByCategory(src.badge)) return null;
          const pos = resolveLeftSourcePos(src);
          const isSelected =
            selectedCanvasNodeId === src.id ||
            (src.date !== undefined && src.date === scene.activeDate);
          const isHovered = hoveredCanvasNodeId === src.id;
          const inTimeSlice = isNodeInActiveTimeSlice(src.timeBucket);
          const laneDotColor =
            src.badge === 'MD'
              ? LANE_COLORS.md
              : src.badge === 'SVG'
                ? LANE_COLORS.svg
                : src.badge === 'PDF'
                  ? LANE_COLORS.pdf
                  : LANE_COLORS.unknown;

          return (
            <g
              key={src.id}
              className="d3-draggable-node cursor-grab active:cursor-grabbing"
              data-node-id={src.id}
              data-testid={`graph-node-${src.id}`}
              transform={`translate(${pos.x}, ${pos.y})`}
              opacity={inTimeSlice ? 1 : 0.45}
              onMouseEnter={() => {
                if (src.fileId) handleNodeMouseEnter(src.fileId, src.id);
              }}
              onMouseLeave={handleNodeMouseLeave}
              onClick={() => {
                // 日期导航节点切换当前日期；文件入口保持原行为
                if (src.date !== undefined) {
                  selectDate(src.date);
                  return;
                }
                onSelectFile(src.fileId);
                const matched = subAgentCards.find((c) => c.fileId === src.fileId);
                if (matched) setSelectedCanvasNodeId(matched.id);
                exploreAfterClick(src.fileId);
              }}
              onDoubleClick={() => {
                // 双击查看详情（打开叙事抽屉），不直接跳转原文
                if (src.fileId) openNarrativeDrawer({ fileId: src.fileId });
              }}
              onContextMenu={(e) => {
                if (!src.fileId || !systemActions?.onOpenFileContextMenu) return;
                const targetFile = files.find((f) => f.file_id === src.fileId);
                if (!targetFile) return;
                e.preventDefault();
                e.stopPropagation();
                systemActions.onOpenFileContextMenu(e, {
                  kind: 'file',
                  relativePath: targetFile.relative_path,
                  title: targetFile.title,
                  fileId: targetFile.file_id,
                  revisionId: targetFile.current_revision_id,
                });
              }}
            >
              {/* 3.2：外框从锚点弹簧 scale+fade 弹出；子卡按 40ms 递增交错。
                  外层 g 只吃 transform 属性，动画挂在内层 g（CSS transform 会覆盖
                  SVG transform 属性，直接挂外层会让卡片丢位） */}
              <g
                className="anim-spring-pop"
                style={{
                  animationDelay: `${srcIdx * SPRING_STAGGER_MS}ms`,
                  // 锚点 = 卡右缘中心（卡片连着主干那一侧），弹出方向朝主干
                  transformOrigin: 'right center',
                }}
              >
                <foreignObject width={DATE_CARD_W} height={DATE_CARD_H}>
                  <button
                    type="button"
                    title={src.fullMetaTooltip ?? `${src.label} · ${src.tokOrMeta}`}
                    className={`glx-canvas-card relative overflow-hidden w-full h-full rounded-xl pl-3 pr-2.5 py-2 text-left flex flex-col justify-between cursor-grab active:cursor-grabbing ${
                      isSelected || isHovered
                        ? 'bg-[color:var(--cv-card-selected)] border border-[color:color-mix(in_srgb,var(--cv-brand)_65%,transparent)] shadow-[0_6px_16px_color-mix(in_srgb,var(--cv-brand)_16%,transparent)]'
                        : 'bg-[color:var(--cv-card)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_11%,transparent)] shadow-[0_2px_6px_color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)] hover:border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_26%,transparent)]'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-2 left-0 w-[2.5px] rounded-r-full"
                      style={{
                        backgroundColor: laneDotColor,
                        opacity: isSelected || isHovered ? 0.95 : 0.45,
                      }}
                    />
                    <div className="flex items-center gap-1.5 min-w-0">
                      {src.date !== undefined ? (
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: laneDotColor }}
                        />
                      ) : (
                        <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                          {src.shortBadge}
                        </span>
                      )}
                      <span className="text-[12px] font-semibold font-mono tabular-nums text-[color:var(--cv-ink)] truncate">
                        {src.label}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-1 min-w-0">
                      <span className="text-[10px] font-mono text-[color:var(--cv-ink-dim)] tabular-nums truncate">
                        {src.tokOrMeta}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        {src.grainLevel && src.grainLevel > 0 && (
                          <span
                            aria-hidden="true"
                            className="inline-flex items-center gap-[2px]"
                          >
                            {Array.from({ length: src.grainLevel }).map((_, gIdx) => (
                              <span
                                key={gIdx}
                                className="w-[3px] h-[3px] rounded-full"
                                style={{
                                  backgroundColor: laneDotColor,
                                  opacity: 0.45 + gIdx * 0.12,
                                }}
                              />
                            ))}
                          </span>
                        )}
                        {src.dominantFormat && (
                          <span className="shrink-0 rounded px-1 py-px text-[8.5px] font-mono leading-tight bg-[color:var(--cv-slot)] text-[color:var(--cv-ink-3)]">
                            {src.dominantFormat}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </foreignObject>
              </g>
            </g>
          );
        })}

    </>
  );
}
