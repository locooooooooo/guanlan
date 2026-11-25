/**
 * Scene 主干层 · GraphSceneTrunk：
 * 承载四泳道主干、主干里程碑刻度（含 X-Ray 扫线宿主）、来源连线、主干→扇出连接线与泳道计数胶囊。
 * 数据一律来自 controller ctx；d3 zoom/drag effect 仍在控制器（按 data-node-id /
 * .d3-draggable-node 类选择器跨子组件查询，保持稳定 DOM 结构）。
 */
import React from 'react';
import { ChronosMascotNode } from '../ChronosMascotNode';
import PackageGroupFrame, { PACKAGE_GROUP_FRAME_H } from '../canvas/PackageGroupFrame';
import RichDocPreviewCard from '../canvas/RichDocPreviewCard';
import { cleanDisplayText } from '../../utils/displayText';
// Trunk 的两处连线消费点统一走 computeBoundEdgeRoute（./edgeRouting）
import { hasUnreadChanges, unreadStatusLabel } from '../../utils/guanlanEngine';
// 绑定路由入口：走廊无障碍时保留贝塞尔曲线，命中卡片本体时切换为带呼吸间距的正交圆角避障路由
import { computeBoundEdgeRoute } from './edgeRouting';
// 视口裁剪纯函数（Scene 层消费挂载判定与连接线判定）
import { shouldDrawGroupConnector } from '../../utils/canvasViewport';
import {
  artifactStageBadgeText,
  artifactStateOf,
  DOC_STATE_LABEL,
} from '../../utils/stateProjection';
import { FANOUT_DAY_HEADER_TAIL, formatTrunkTickLabel } from '../../utils/graphEvents';
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


export function GraphSceneTrunk({ ctx }: { ctx: GraphCanvasCtx }) {
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
    chronosConduits,
    liveFlowEnabled,
    d3RiverStrands,
    trunkTicks,
    trunkAccumulation,
    accumulationRibbonPath,
    activeTickY,
    isTimeFlowPlaying,
    // 避障障碍清单（与渲染口径同源，见 controller graphObstacleRects）
    graphObstacleRects,
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
        {/* 2.8 时光累积沉淀轮廓带：自底端「时光起点」向顶端「今日」渐次舒展，表达时间流逝化作文档积累 */}
        {accumulationRibbonPath && (
          <g data-testid="trunk-accumulation-ribbon" pointerEvents="none">
            <path
              d={accumulationRibbonPath}
              fill="url(#chronos-accumulation-grad)"
              style={{
                stroke: 'color-mix(in srgb, var(--cv-lav) 20%, transparent)',
              }}
              strokeWidth="0.75"
              opacity={isTimeFlowPlaying ? 0.95 : 0.78}
            />
          </g>
        )}

        {/* 3. Central 4-Lane River Trunk（四根光束对应四个文档分类泳道，
            主干+泳道恒渲染——时间轴本体不随布局消失，详情框仅在 xray 下显示）。
            泳道色取自 --cv-lane-* 令牌（见 LANE_COLORS）；stroke 走 style 形态
            （SVG 表现属性不解析 var()）；光束/传导/流星/光点统一挂 .cv-stream-glow 类，
            按暗档/浅档主题分别应用常规发光与柔光滤镜。 */}
        <g className="animate-river-pulse">
          <path
            d={d3RiverStrands.md}
            fill="none"
            style={{ stroke: LANE_COLORS.md }}
            strokeWidth="3.2"
            strokeLinecap="round"
            className="cv-stream-glow"
          />
          <path
            d={d3RiverStrands.svg}
            fill="none"
            style={{ stroke: LANE_COLORS.svg }}
            strokeWidth="3.6"
            strokeLinecap="round"
            className="cv-stream-glow"
          />
          <path
            d={d3RiverStrands.pdf}
            fill="none"
            style={{ stroke: LANE_COLORS.pdf }}
            strokeWidth="2.8"
            strokeLinecap="round"
            className="cv-stream-glow"
          />
          <path
            d={d3RiverStrands.unknown}
            fill="none"
            style={{ stroke: LANE_COLORS.unknown }}
            strokeWidth="2.4"
            strokeLinecap="round"
            className="cv-stream-glow"
          />

          {/* Streaming Dashed Flow Overlay + High-Speed River Shooting Star Comets */}
          {liveFlowEnabled && lodGates.liveFlow && (
            <>
              <path
                d={d3RiverStrands.md}
                fill="none"
                style={{ stroke: 'var(--cv-ink)' }}
                strokeOpacity="0.5"
                strokeWidth="1.6"
                strokeDasharray="8 28"
                strokeLinecap="round"
                className="animate-dash-flow"
              />
              <path
                d={d3RiverStrands.svg}
                fill="none"
                style={{ stroke: 'var(--cv-lav-ink)' }}
                strokeOpacity="0.6"
                strokeWidth="1.8"
                strokeDasharray="6 32"
                strokeLinecap="round"
                className="animate-dash-flow-fast"
              />
              <g className="cv-stream-glow">
                <path
                  d="M 0,0 L -28,0"
                  stroke="url(#comet-conduit-terracotta)"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <circle r="2.6" style={{ fill: 'var(--cv-ink)' }} />
                <animateMotion
                  dur="3.4s"
                  repeatCount="indefinite"
                  rotate="auto"
                  path={d3RiverStrands.md}
                />
              </g>
              <g className="cv-stream-glow">
                <path
                  d="M 0,0 L -28,0"
                  stroke="url(#comet-conduit-lavender)"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <circle r="2.5" style={{ fill: 'var(--cv-ink)' }} />
                <animateMotion
                  dur="4.0s"
                  repeatCount="indefinite"
                  rotate="auto"
                  path={d3RiverStrands.svg}
                />
              </g>
            </>
          )}
        </g>

        {/* 3.5 Trunk Milestones（全画布唯一日期刻度，画在泳道之上）
            trunkTicks 降序（index 0 = 最新一天 = 轴顶，向下越旧），
            逐刻度一枚发光里程碑节点贴日期文本；有事件日实心光点（大小∝事件数），
            空档日暗淡空心小点，「更早 N 天/周/月」截断在最底端虚线短横且不可点击。
            层内同时承载泳道光点（某天某分类有更新即亮对应色光点）与 X-Ray 扫线宿主。
            渲染序列经 dedupeTicksByDate 去重，保证同日期在主干轴上至多出现一次。 */}
        <g data-testid="trunk-milestones">
          {scene.hasRealEvents &&
            (() => {
              const latestYear =
                trunkTicks.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date))?.date.slice(0, 4) ?? '';
              return trunkTicks.map((tick, i) => {
                const n = trunkTicks.length;
                const y = milestoneY(i, n, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM);
                const active = scene.activeDate === tick.date;
                // 1.2：每日期只允许 1 个唯一锚点文字——该日期已有左侧日期汇总卡承载时，
                // 主干不再重复标注（此前同一 MM-DD 在主干 + 日期卡各写一次）
                const showLabel =
                  tick.isGap ||
                  trunkTickShowsLabel(i, rulerLabelStep, tick.date, navigatorDateSet);
                const tickAggregated = Boolean(tick.granularity && tick.granularity !== 'day');
                const tickDisplayLabel = formatTrunkTickLabel(tick, latestYear, rulerLabelStep);

                // 逐日选中/再点取消；周/月聚合刻度下钻到日；截断/空档刻度无操作
                const clickTick = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  if (tick.isTruncation || tick.isGap) return;
                  if (tick.granularity && tick.granularity !== 'day') {
                    onDrillToBucket?.(tick.date, tick.granularity);
                    return;
                  }
                  selectDate(scene.activeDate === tick.date ? undefined : tick.date);
                };

                const titleFormats = (['md', 'svg', 'pdf'] as const)
                  .map((f) => [f, tick.formats[f] ?? 0] as const)
                  .filter(([, c]) => c > 0)
                  .map(([f, c]) => `${f.toUpperCase()} ${c}`)
                  .join(' · ');
                const titleKinds = Object.entries(tick.kinds)
                  .sort((a, b) => b[1] - a[1])
                  .map(([kind, c]) => `${kind}×${c}`)
                  .join(' ');

                // 泳道光点：该刻度 formats 计数>0 的每个分类在其泳道亮一枚光点；
                // 三格式之和的余量（未判定事件：决策/读取问题等工作区级）落蓝泳道
                const laneDots: Array<{ lane: LaneKey; count: number }> = [];
                if (tick.hasEvents) {
                  let knownShare = 0;
                  (['md', 'svg', 'pdf'] as const).forEach((f) => {
                    const c = tick.formats[f] ?? 0;
                    if (c > 0) {
                      laneDots.push({ lane: f, count: c });
                      knownShare += c;
                    }
                  });
                  if (tick.count - knownShare > 0) {
                    laneDots.push({ lane: 'unknown', count: tick.count - knownShare });
                  }
                }

                {/* 连续长空档断层标记：标签置于主干左侧留白区，绝不被右侧展开框遮挡 */}
                if (tick.isGap) {
                  return (
                    <g key={`milestone-${tick.date}`} className="d3-no-pan">
                      <title>{`跳过 ${tick.gapDays ?? 0} 个无事件空档日`}</title>
                      <line
                        x1={trunkX - 14}
                        y1={y}
                        x2={trunkX + 14}
                        y2={y}
                        style={{ stroke: 'var(--cv-ink-meta)' }}
                        strokeWidth="1"
                        strokeDasharray="2 3"
                        opacity="0.7"
                      />
                      <text
                        x={trunkX - 18}
                        y={y + 3}
                        textAnchor="end"
                        style={{ fill: 'var(--cv-ink-meta)' }}
                        fontSize="8.5"
                        fontFamily="var(--font-mono)"
                      >
                        {tickDisplayLabel}
                      </text>
                    </g>
                  );
                }

                {/* 「更早 N 天/周/月」截断提示刻度——超出取数窗口的更早历史折叠于主干最底端并明示，
                    不可点击、不承载日期；切到更粗粒度可整段回看 */}
                if (tick.isTruncation) {
                  return (
                    <g key={`milestone-${tick.date}`} className="d3-no-pan">
                      <title>{`${tick.label}：更早的历史超出当前取数窗口（120 桶上限）被折叠；切换到更粗粒度（周/月）可整段回看`}</title>
                      <line
                        x1={trunkX - 16}
                        y1={y}
                        x2={trunkX + 16}
                        y2={y}
                        style={{ stroke: 'var(--cv-ink-meta)' }}
                        strokeWidth="1.2"
                        strokeDasharray="3 3"
                        opacity="0.85"
                      />
                      <text
                        x={trunkX + 22}
                        y={y + 3}
                        style={{ fill: 'var(--cv-ink-meta)' }}
                        fontSize="8.5"
                        fontFamily="var(--font-mono)"
                      >
                        {tick.label}
                      </text>
                    </g>
                  );
                }

                const accumPt = trunkAccumulation[i];
                // 每日文档结晶刻度条绘制在主干左肩（朝向司辰沙漏一侧，宽 5..13px → x: trunkX-22..trunkX-9），
                // 既呼应「沙漏流沙化作文档结晶」，又让右侧刻度日期（trunkX+12..450）彻底避让扇出框左缘（452）
                const strataWidth =
                  tick.hasEvents && accumPt
                    ? Math.round(5 + 8 * accumPt.strataIntensity)
                    : 0;
                const strataSegments: Array<{ lane: LaneKey; x: number; w: number }> = [];
                if (strataWidth > 0 && laneDots.length > 0) {
                  const totalLaneWeight = Math.max(
                    1,
                    laneDots.reduce((s, d) => s + Math.max(1, d.count), 0)
                  );
                  let rightEdge = trunkX - 9;
                  laneDots.forEach((dot, segIdx) => {
                    const leftLimit = trunkX - 9 - strataWidth;
                    const segW =
                      segIdx === laneDots.length - 1
                        ? Math.max(2, rightEdge - leftLimit)
                        : Math.max(
                            2,
                            Math.round((Math.max(1, dot.count) / totalLaneWeight) * strataWidth)
                          );
                    const segX = Math.max(leftLimit, rightEdge - segW);
                    const actualW = rightEdge - segX;
                    if (actualW > 0) {
                      strataSegments.push({ lane: dot.lane, x: segX, w: actualW });
                      rightEdge = segX - 1;
                    }
                  });
                }
                const labelX = trunkX + 12;

                return (
                  <g
                    key={`milestone-${tick.date}`}
                    className="d3-no-pan cursor-pointer"
                    onClick={clickTick}
                  >
                    <title>
                      {`${tick.date} · ${tick.count} 变动${
                        accumPt && tick.hasEvents
                          ? `（新增 ${accumPt.addedCount} / 演进 ${accumPt.modifiedCount} · 截至当日累计沉淀 ${accumPt.cumulativeEvents} 条记录）`
                          : ''
                      }${titleFormats ? ` · ${titleFormats}` : ''}${
                        titleKinds ? ` · ${titleKinds}` : ''
                      }${tickAggregated ? ' · 点击下钻到日' : ''}`}
                    </title>
                    {/* 命中热区（覆盖节点+结晶刻度+贴节点日期文本） */}
                    <rect x={trunkX - 14} y={y - 9} width="186" height="18" fill="transparent" />
                    {tick.hasEvents ? (
                      <>
                        {/* 激活日司辰聚焦光环：标识司辰此刻定格的时间刻度 */}
                        {active && (
                          <>
                            <circle
                              cx={trunkX}
                              cy={y}
                              r="9.5"
                              fill="none"
                              style={{ stroke: 'var(--cv-lane-md)' }}
                              strokeWidth="1.2"
                              opacity="0.72"
                              className="animate-sonar-ripple"
                            />
                            <circle
                              cx={trunkX}
                              cy={y}
                              r="6"
                              style={{ fill: 'color-mix(in srgb, var(--cv-lane-md) 18%, transparent)' }}
                            />
                          </>
                        )}
                        {/* 有事件日：实心发光节点，半径随当日事件数增大；activeDate 亮橙 */}
                        <circle
                          cx={trunkX}
                          cy={y}
                          r={2.6 + 1.6 * (tick.count / (rulerMaxCount || 1))}
                          style={{ fill: active ? 'var(--cv-lane-md)' : 'var(--cv-ink)' }}
                          className="cv-stream-glow"
                        />
                        {/* 每日文档结晶刻度条（按格式泳道分段着色，直观呈现每日沉淀厚度） */}
                        {strataSegments.length > 0 && (
                          <g data-testid={active ? 'trunk-active-strata' : undefined}>
                            {strataSegments.map((seg) => (
                              <rect
                                key={seg.lane}
                                x={seg.x}
                                y={active ? y - 2 : y - 1.5}
                                width={seg.w}
                                height={active ? 4 : 3}
                                rx="1.5"
                                style={{ fill: LANE_COLORS[seg.lane] }}
                                opacity={active ? 0.96 : 0.62}
                              />
                            ))}
                          </g>
                        )}
                      </>
                    ) : (
                      // 空档日：钟表微刻度 + 暗淡空心小点，表达时光静静流逝
                      <>
                        <line
                          x1={trunkX - 4.5}
                          y1={y}
                          x2={trunkX + 4.5}
                          y2={y}
                          style={{ stroke: 'var(--cv-ink-meta)' }}
                          strokeWidth="0.7"
                          opacity="0.28"
                        />
                        <circle
                          cx={trunkX}
                          cy={y}
                          r="1.5"
                          fill="none"
                          style={{ stroke: 'var(--cv-ink)' }}
                          strokeWidth="1"
                          opacity="0.35"
                        />
                      </>
                    )}
                    {/* 泳道光点（点击同里程碑） */}
                    {laneDots.map((dot) => (
                      <circle
                        key={dot.lane}
                        cx={trunkX + LANE_OFFSETS[dot.lane]}
                        cy={y}
                        r="2"
                        style={{ fill: LANE_COLORS[dot.lane] }}
                        className="cv-stream-glow"
                      />
                    ))}
                    {/* 贴节点日期文本（让位结晶刻度；最新一天恒标注；跨年补年份杜绝假重复） */}
                    {showLabel && (
                      <text
                        x={labelX}
                        y={y + 3}
                        style={{ fill: active ? 'var(--cv-lane-md)' : 'var(--cv-ink-meta)' }}
                        fontSize="8.5"
                        fontWeight={active ? '600' : '400'}
                        fontFamily="var(--font-mono)"
                      >
                        {tickDisplayLabel}
                      </text>
                    )}
                  </g>
                );
              });
            })()}

          {/* Animated Geek X-Ray Laser Sweep：宿主改挂里程碑层，沿主干自上而下扫过
              （keyframes 纵向平移 520px 不变，仍由 xrayLaserEnabled 门控） */}
          {xrayLaserEnabled && lodGates.laser && (
            <g className="animate-laser-sweep">
              <line
                x1={trunkX - 40}
                y1={TRUNK_AXIS_TOP - 6}
                x2={trunkX + 150}
                y2={TRUNK_AXIS_TOP - 6}
                stroke="url(#xray-laser-grad)"
                strokeWidth="2"
              />
              <circle
                cx={trunkX + 55}
                cy={TRUNK_AXIS_TOP - 6}
                r="2.2"
                style={{ fill: 'var(--cv-brand)' }}
                className="cv-stream-glow"
              />
            </g>
          )}
        </g>

        {/* 4. Dynamic Bezier Edges from Left Sources -> Trunk / Main Hub with Streaming Animation */}
        {leftSourceNodes.map((src, idx) => {
          if (!isNodeVisibleByCategory(src.badge)) return null;
          const pos = resolveLeftSourcePos(src);
          const isHighlighted =
            hoveredCanvasNodeId === src.id ||
            selectedCanvasNodeId === src.id ||
            (activeFileRecord?.file_id || '') === src.fileId;
          const isDimmedByHover =
            Boolean(hoveredCanvasNodeId) &&
            !isHighlighted &&
            hoveredCanvasNodeId !== 'main_hub' &&
            hoveredCanvasNodeId !== 'chronos_deity';
          const inTimeSlice = isNodeInActiveTimeSlice(src.timeBucket);

          const fromPt = { x: pos.x + 118, y: pos.y + 24 };
          const toPt =
            canvasLayoutMode === 'xray'
              ? { x: trunkX - 4, y: src.targetTrunkY }
              : { x: mainHubPos.x + 74, y: mainHubPos.y + 38 };
          // 左侧日期卡 → 时间主干：排除司辰立绘自身矩形，让流光丝线从司辰神座背后丝滑汇聚入时间河，
          // 避免折出僵硬的工业直角框包住左侧日期卡（立绘浮于连线之上，视觉更空灵流畅）
          const sourceEdgeObstacles = graphObstacleRects.filter((o) => o.id !== 'chronos_deity');
          const edgeRoute = computeBoundEdgeRoute({
            from: fromPt,
            to: toPt,
            mode: 'source_to_trunk',
            obstacles: sourceEdgeObstacles,
            hosts: {
              from: { x: pos.x, y: pos.y, width: DATE_CARD_W, height: DATE_CARD_H },
            },
          });
          const edgePath = edgeRoute.path;

          return (
            <g
              key={`src-edge-${src.id}`}
              opacity={!inTimeSlice ? 0.2 : isDimmedByHover ? 0.32 : 1}
            >
              <path
                id={`path-src-${src.id}`}
                d={edgePath}
                fill="none"
                style={{ stroke: isHighlighted ? 'var(--cv-brand)' : 'color-mix(in srgb, var(--cv-ink) 22%, transparent)' }}
                strokeWidth={isHighlighted ? 2.0 : 1.15}
              />
              {liveFlowEnabled && lodGates.liveFlow && inTimeSlice && (
                <>
                  <path
                    d={edgePath}
                    fill="none"
                    style={{ stroke: isHighlighted ? 'var(--cv-ink)' : 'var(--cv-brand)' }}
                    strokeOpacity={isHighlighted ? 0.9 : 0.45}
                    strokeWidth={isHighlighted ? 1.8 : 1.2}
                    strokeDasharray="5 15"
                    strokeLinecap="round"
                    className={isHighlighted ? 'animate-dash-flow-fast' : 'animate-dash-flow'}
                  />
                  <circle
                    r={isHighlighted ? 2.8 : 1.9}
                    style={{ fill: 'var(--cv-brand)' }}
                    className="cv-stream-glow"
                  >
                    <animateMotion
                      dur={`${isHighlighted ? 1.3 : 2.3 + idx * 0.35}s`}
                      repeatCount="indefinite"
                      path={edgePath}
                    />
                  </circle>
                </>
              )}
            </g>
          );
        })}

        {/* 5. Single Trunk → Fan-Out Connector（单线收敛：
            仅绘制一根自激活日主干刻度指向详情框左缘中点的连接线；
            未选中=弱白线；选中日期刻度 / 事件卡 = 橙色定向电流脉冲：
            .anim-pulse-flow 跑 stroke-dashoffset 0→-24（dasharray 6 18 正好一轮 24），
            外加一层柔光 drop-shadow 呼吸（SMIL opacity，不新增 CSS keyframes） */}
        {(() => {
          const hasSelectedCard = subAgentCards.some((c) => c.id === selectedCanvasNodeId);
          // 3.1：选中主干上的某一天（activeDate）或选中事件卡，都点亮这条主干→详情框电流
          const pulseOn = hasSelectedCard || Boolean(scene.activeDate);
          // 锚定当前激活日真实刻度 y（点击历史日或时光流转时，主干→右侧文档的能量束随司辰同频移动）
          const connectorFromY = activeTickY ?? TRUNK_AXIS_TOP;
          const connectorRoute = computeBoundEdgeRoute({
            from: { x: trunkX + 4, y: connectorFromY },
            to: { x: fanOutBounds.x, y: fanOutBounds.y + fanOutBounds.height / 2 },
            mode: 'trunk_to_subagent',
            obstacles: graphObstacleRects,
            hosts: { to: fanOutBounds },
          });
          const connectorPath = connectorRoute.path;
          return (
            <g key="trunk-fanout-connector">
              <path
                d={connectorPath}
                fill="none"
                style={{ stroke: pulseOn ? 'var(--cv-lane-md)' : 'color-mix(in srgb, var(--cv-ink) 22%, transparent)' }}
                strokeWidth={pulseOn ? 1.8 : 1.2}
              />
              {pulseOn && (
                <>
                  {/* 柔光层：只动 opacity（合成器），静态 drop-shadow 负责「发光」质感 */}
                  <path
                    d={connectorPath}
                    fill="none"
                    style={{
                      stroke: 'var(--cv-lane-md)',
                      filter: 'drop-shadow(0 0 6px color-mix(in srgb, var(--cv-lane-md) 60%, transparent))',
                    }}
                    strokeWidth="5"
                    strokeLinecap="round"
                    opacity="0.16"
                  >
                    {!prefersReducedMotion && (
                      <animate
                        attributeName="opacity"
                        values="0.06;0.26;0.06"
                        dur="2.4s"
                        repeatCount="indefinite"
                      />
                    )}
                  </path>
                  <path
                    d={connectorPath}
                    fill="none"
                    style={{ stroke: 'var(--cv-lane-md)' }}
                    strokeOpacity="0.9"
                    strokeWidth="1.8"
                    strokeDasharray="6 18"
                    strokeLinecap="round"
                    className="anim-pulse-flow"
                  />
                </>
              )}
            </g>
          );
        })()}

        {/* 6. 时光方向微锚点与轴脊呼吸光点（置于主干右缘留白位，绝不压过中央时间河光束） */}
        {canvasLayoutMode === 'xray' && scene.hasRealEvents && (
          <g pointerEvents="none">
            <circle
              cx={trunkX}
              cy={TRUNK_AXIS_TOP}
              r="7"
              fill="none"
              style={{ stroke: 'var(--cv-lav)' }}
              strokeWidth="1"
              opacity="0.55"
              className="animate-sonar-ripple"
            />
            {/* 「此刻 · 最新沉淀」上移留足 22px 呼吸间距，不贴压脊顶刻度与波纹 */}
            <text
              x={trunkX + 18}
              y={TRUNK_AXIS_TOP - 22}
              textAnchor="start"
              data-trunk-latest-label=""
              style={{ fill: 'var(--cv-ink-meta)' }}
              fontSize="8.5"
              fontFamily="var(--font-mono)"
              opacity="0.78"
            >
              此刻 · 最新沉淀
            </text>
            <circle
              cx={trunkX}
              cy={TRUNK_AXIS_BOTTOM}
              r="5.5"
              fill="none"
              style={{ stroke: 'var(--cv-link)' }}
              strokeWidth="1"
              opacity="0.45"
              className="animate-sonar-ripple"
            />
            {/* 「时光起点」齐平锚点上移至安全区，避免被底部浮坞压盖 */}
            <text
              x={trunkX + 18}
              y={TRUNK_AXIS_BOTTOM - 2}
              textAnchor="start"
              data-trunk-origin-label=""
              style={{ fill: 'var(--cv-ink-meta)' }}
              fontSize="8.5"
              fontFamily="var(--font-mono)"
              opacity="0.72"
            >
              时光起点
            </text>
          </g>
        )}

    </>
  );
}
