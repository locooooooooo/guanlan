/**
 * D01-a 拆解 · Scene 层 · GraphSceneCards（从 GraphCanvasView.tsx 原样迁入的 右侧 280x116 事件卡 + 任务包分组容器横排（富预览卡））。
 * 迁移纪律：JSX 与类名逐字一致（像素回归护栏）；数据一律来自 controller ctx；
 * d3 zoom/drag effect 仍在控制器（按 data-node-id / .d3-draggable-node 类选择器跨
 * 子组件查询，DOM 结构不变即行为不变）。
 */
import React from 'react';
import { BookOpen, GitBranch } from 'lucide-react';
import { ChronosMascotNode } from '../ChronosMascotNode';
import PackageGroupFrame, { PACKAGE_GROUP_FRAME_H } from '../canvas/PackageGroupFrame';
import RichDocPreviewCard from '../canvas/RichDocPreviewCard';
import { cleanDisplayText } from '../../utils/displayText';
import { computeDynamicEdgePath, hasUnreadChanges, unreadStatusLabel } from '../../utils/guanlanEngine';
// issue #27：视口裁剪纯函数（Scene 层消费挂载判定与连接线判定）
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


export function GraphSceneCards({ ctx }: { ctx: GraphCanvasCtx }) {
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
    spotlight,
  } = ctx;
  // D02 增量聚光灯：当前批阅条目的 file_id（关闭态恒 null → 卡面零样式注入，像素基线零扰动）。
  // 游标对列表长度取模（与 GraphSpotlightBar 同一归一式，数据缩胀永不越界）
  const spotlightCurrentFileId = (() => {
    if (!spotlight?.enabled || spotlight.items.length === 0) return null;
    const n = spotlight.items.length;
    return spotlight.items[((spotlight.cursor % n) + n) % n].file_id;
  })();
  const spotlightDim = (fileId: string | null | undefined): boolean =>
    Boolean(spotlight?.enabled && fileId && spotlight.dimmedFileIds.has(fileId));
  return (
    <>
        {/* 10. RIGHT FAN-OUT SUB-AGENT / DOCUMENT NODES
            starfix2 T1：280x116 四行事件卡（旧 152x90 两行卡退役）——
            行1 flex 两端对齐：左=加粗完整核心文档名（basename 链既有产物，目录前缀严禁拼名前，
            dirPrefix 降级为行2 前缀 + hover title）；右=轻量灰胶囊版本跨度（versionSpanCapsule）。
            行2=11px 浅灰所属专项路径（taskPackageOf(relative_path).id），独立一行不与标题抢位。
            行3=真实修改内容摘要限 2 行（modified=章节拼接+描述；appeared=extractCoreSummary
            正文核心结论；皆空回退 headline——严禁只写 +1/-1 行充当摘要）。
            行4 两端对齐：左=语义标签胶囊（stageOfPath 阶段；决策卡=决策）；右=+N/-M行 · HH:MM。
            槽位/展开框/命中区已随 EVENT_CARD_W/H 与槽位重排连带核对（双列 x=468/784、行距 140）；
            starfix2 T1 追记：叙事抽屉「直流电流」连线起点（:4404 sx=卡左缘+EVENT_CARD_W）
            亦随卡宽常量化连带核对，旧 152 字面退役 */}
        {(isFanOutCollapsed && canvasLayoutMode === 'xray'
          ? subAgentCards.slice(0, 2)
          : subAgentCards
        ).map((card, cardIdx) => {
          if (!isNodeVisibleByCategory(card.format)) return null;
          const pos = nodePositions[card.id] || DEFAULT_NODE_POSITIONS[card.id];
          const isSelected = selectedCanvasNodeId === card.id;
          const fileRec = files.find((f) => f.file_id === card.fileId);
          const unreadInfo = fileRec
            ? hasUnreadChanges(fileRec, readingStates[card.fileId])
            : null;
          const isUnread = unreadInfo?.isUnread ?? false;
          // D02 增量聚光灯：已读未变 → 低对比度背景骨架（仅聚光灯开启时注入类，零基线扰动）；
          // 当前批阅条目 → 琥珀描边高亮（行动信号保留全对比度）
          const spotlightDimmed = spotlightDim(card.fileId);
          const spotlightCurrent = Boolean(card.fileId && card.fileId === spotlightCurrentFileId);
          const inTimeSlice = isNodeInActiveTimeSlice(card.timeBucket);
          // starfix2 T1 行4 左：阶段语义胶囊词——stageOfPath 链既有产物（待分类沿用既有
          // 惯例不渲染，与旧任务包 chip 同口径）；决策/无文件事件退「决策」（卡本体即决策纸）。
          // F1/F2（AC-01）：有 /state-overview artifact 行 → 六态词（胶囊形制仍走画布暗端件）；
          // 无行 → stateProjection.artifactStageBadgeText 阶段回退词（既有基线逐字不变）。
          const artifactState = artifactStateOf(stateIndex, card.fileId);
          const stageBadgeText = artifactState
            ? DOC_STATE_LABEL[artifactState.state]
            : artifactStageBadgeText(card.packageStage, Boolean(card.decisionId));
          // 胶囊形制走克制磨砂轻底（淡化满屏重复「草稿」棕框视觉噪点）
          const stageBadgePillClass =
            'shrink-0 rounded-full bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)] px-1.5 py-px text-[9.5px] font-mono leading-[1.45] text-[color:var(--cv-ink-meta)]';
          const cardLaneColor = card.decisionId
            ? 'var(--cv-lav)'
            : card.format === 'svg'
              ? LANE_COLORS.svg
              : card.format === 'pdf'
                ? LANE_COLORS.pdf
                : card.format === 'md'
                  ? LANE_COLORS.md
                  : LANE_COLORS.unknown;
          // starfix2 T1 行1 hover：完整定位串（dirPrefix 存在时补目录前缀——重名拷贝互相可指认）
          const cardTitle = card.dirPrefix
            ? `${card.dirPrefix}/${card.fileName}`
            : card.fileName;
          // starfix2 T1 行2：所属专项路径；同组重名拷贝时前置目录段保住区分度
          const pkgLine = card.dirPrefix
            ? `${card.dirPrefix} · ${card.pkgPath || card.kindLabel || ''}`
            : card.pkgPath || card.kindLabel || '';

          return (
            <g
              key={card.id}
              className="d3-draggable-node cursor-grab active:cursor-grabbing"
              data-node-id={card.id}
              data-testid={`graph-node-${card.id}`}
              transform={`translate(${pos.x}, ${pos.y})`}
              opacity={inTimeSlice ? 1 : 0.3}
              onMouseEnter={() => {
                if (card.fileId) handleNodeMouseEnter(card.fileId, card.id);
              }}
              onMouseLeave={handleNodeMouseLeave}
              onClick={() => {
                setSelectedCanvasNodeId(card.id);
                setSelectedRichDocFileId(null);
                if (card.eventId) onSelectEvent?.(card.eventId);
                if (card.fileId) onSelectFile(card.fileId, card.revisionId ?? undefined);
                if (card.fileId) exploreAfterClick(card.fileId, card.revisionId ?? undefined, card.eventId);
              }}
              onDoubleClick={() => {
                // v0.8 R3③：双击=查看详情（叙事抽屉滑出），「打开原文」迁抽屉 footer 首位钮
                if (card.fileId) {
                  openNarrativeDrawer({ nodeId: card.id, fileId: card.fileId });
                } else if (card.decisionId) {
                  openNarrativeDrawer({ nodeId: card.id });
                }
              }}
              onContextMenu={(e) => {
                if (!card.fileId || !systemActions?.onOpenFileContextMenu) return;
                const targetFile = files.find((f) => f.file_id === card.fileId);
                if (!targetFile) return;
                e.preventDefault();
                e.stopPropagation();
                systemActions.onOpenFileContextMenu(e, {
                  kind: 'file',
                  relativePath: targetFile.relative_path,
                  title: targetFile.title,
                  fileId: targetFile.file_id,
                  revisionId: card.revisionId || targetFile.current_revision_id,
                });
              }}
            >
              {/* 3.2：展开某天 → 外框从锚点弹簧 scale+fade 弹出，内部子卡按 40ms 递增浮现。
                  key 带 springRevealKey：切日期/收起展开/换布局时重挂一次，动画从头播放；
                  动画挂内层 g（外层 g 的 translate 属性不能被 CSS transform 覆盖） */}
              <g
                key={`${card.id}-${springRevealKey}`}
                className="anim-spring-pop"
                style={{
                  animationDelay: `${cardIdx * SPRING_STAGGER_MS}ms`,
                  // 锚点 = 卡左缘中心（扇出组从主干那一侧弹出）
                  transformOrigin: 'left center',
                }}
              >
              {/* C7① 强选中唯一化：发光圈仅 isSelected 触发（hover 只剩边框），描边改橙——
                  全画布同一时刻至多一张卡带橙色发光圈。
                  starfix2 T1：圈随卡几何走 EVENT_CARD_W/H（旧 158x96 字面退役） */}
              {isSelected && xrayLaserEnabled && (
                <rect
                  x="-3"
                  y="-3"
                  width={EVENT_CARD_W + 6}
                  height={EVENT_CARD_H + 6}
                  rx="14"
                  fill="none"
                  style={{ stroke: 'color-mix(in srgb, var(--cv-lane-md) 45%, transparent)' }}
                  strokeWidth="1"
                  className="animate-sonar-ripple"
                />
              )}
              <foreignObject width={EVENT_CARD_W} height={EVENT_CARD_H}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={cardTitle}
                  title={cardTitle}
                  data-spotlight-dimmed={spotlightDimmed ? 'true' : undefined}
                  data-spotlight-current={spotlightCurrent ? 'true' : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openNarrativeDrawer({ nodeId: card.id, fileId: card.fileId });
                    }
                  }}
                  className={`group/evcard glx-canvas-card relative overflow-hidden w-full h-full rounded-xl pl-3.5 pr-2.5 py-2.5 text-left flex flex-col justify-between gap-1 cursor-grab active:cursor-grabbing ${
                    isSelected
                      ? 'bg-[color:var(--cv-card-selected)] border border-[color:color-mix(in_srgb,var(--cv-lane-md)_90%,transparent)] shadow-[0_8px_22px_color-mix(in_srgb,var(--cv-lane-md)_20%,transparent)]'
                      : 'bg-[color:var(--cv-card)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_11%,transparent)] shadow-[0_2px_8px_color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)] hover:border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_25%,transparent)] hover:shadow-[0_8px_20px_-4px_color-mix(in_srgb,var(--cv-hairline-ink)_12%,transparent)]'
                  } ${
                    spotlightDimmed
                      ? 'opacity-[0.38] saturate-[0.35]'
                      : ''
                  } ${
                    spotlightCurrent
                      ? 'ring-1 ring-[color:var(--cv-amber)] shadow-[0_0_14px_color-mix(in_srgb,var(--cv-amber)_28%,transparent)]'
                      : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-2.5 left-0 w-[3px] rounded-r-full"
                    style={{
                      backgroundColor: cardLaneColor,
                      opacity: isSelected ? 1 : 0.65,
                    }}
                  />
                  {/* 行1 两端对齐：左=加粗完整核心文档名；右=带脉络微点的版本跨度胶囊 */}
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span
                      className="text-[12.5px] font-semibold text-[color:var(--cv-ink)] leading-[1.3] truncate min-w-0"
                    >
                      {card.fileName}
                    </span>
                    {card.versionSpan && (
                      <span
                        className="shrink-0 max-w-[48%] inline-flex items-center gap-1 truncate rounded-full border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_14%,transparent)] bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_5%,transparent)] px-1.5 text-[9.5px] font-mono tabular-nums leading-[1.6] text-[color:var(--cv-ink-meta)]"
                      >
                        <span
                          aria-hidden="true"
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: cardLaneColor, opacity: 0.85 }}
                        />
                        <span className="truncate">{card.versionSpan}</span>
                      </span>
                    )}
                  </div>

                  {/* 行2：所属专项路径（taskPackageOf 链），11px 浅灰独立一行不与标题抢位 */}
                  {pkgLine && (
                    <div className="text-[11px] leading-[1.2] text-[color:var(--cv-ink-meta)] font-mono truncate min-w-0">
                      {pkgLine}
                    </div>
                  )}

                  {/* 行3：真实修改内容摘要（限 2 行）——modified=「变更章节：A / B — 描述」
                      （canvasChangeDigestLine 单一出口）；appeared=正文核心结论
                      （extractCoreSummary）；皆空回退 headline detail（诚实呈现，
                      绝不只写 +1/-1 行充当摘要——行数在行4 右承载）；cleanDisplayText 剥离原始 Markdown 噪声 */}
                  <div className="text-[10.5px] leading-[1.35] line-clamp-2 min-w-0 text-[color:var(--cv-ink-2)]">
                    {cleanDisplayText(card.digestLine || card.detail) || card.digestLine || card.detail}
                  </div>

                  {/* 行4 两端对齐：左=语义标签胶囊 + 悬停直达「溯源/原文」操作轨，右=+N/-M · HH:MM */}
                  <div className="flex items-center justify-between gap-1.5 w-full min-w-0">
                    <div className="flex items-center gap-1 min-w-0">
                      {stageBadgeText ? (
                        <span
                          data-doc-state={artifactState ? artifactState.state : undefined}
                          className={stageBadgePillClass}
                        >
                          {stageBadgeText}
                        </span>
                      ) : null}
                      {/* 静置零干扰；悬停/选中平滑浮现「溯源」「原文」直达按钮 */}
                      <span
                        className={`d3-no-pan inline-flex items-center gap-1 transition-opacity duration-150 ${
                          isSelected
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/evcard:opacity-100 group-focus-within/evcard:opacity-100'
                        }`}
                      >
                        <button
                          type="button"
                          data-cv-card-trace={card.id}
                          title="追溯此条记录的版本脉络与来源证据"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCanvasNodeId(card.id);
                            if (card.fileId) onSelectFile(card.fileId, card.revisionId ?? undefined);
                            openNarrativeDrawer({ nodeId: card.id, fileId: card.fileId });
                          }}
                          className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] font-medium bg-[color:color-mix(in_srgb,var(--cv-lav)_12%,transparent)] text-[color:var(--cv-lav-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-lav)_22%,transparent)] cursor-pointer"
                        >
                          <GitBranch className="w-2.5 h-2.5" strokeWidth={1.7} aria-hidden="true" />
                          <span>溯源</span>
                        </button>
                        {card.fileId && (
                          <button
                            type="button"
                            data-cv-card-read={card.id}
                            title="在阅读器中打开原文"
                            onClick={(e) => {
                              e.stopPropagation();
                              openFileReader(card.fileId, 'read');
                            }}
                            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] font-medium bg-[color:color-mix(in_srgb,var(--cv-brand)_11%,transparent)] text-[color:var(--cv-brand-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-brand)_20%,transparent)] cursor-pointer"
                          >
                            <BookOpen className="w-2.5 h-2.5" strokeWidth={1.7} aria-hidden="true" />
                            <span>原文</span>
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 min-w-0">
                      {isUnread && !isSelected && unreadInfo && (
                        <span
                          /* R3：未读角标措辞走 GL-01 单一出口，不再自造「未读更新」 */
                          title={unreadStatusLabel(unreadInfo.reason)}
                          className="w-1.5 h-1.5 rounded-full bg-[color:var(--cv-unread)] shrink-0"
                        />
                      )}
                      <span className="text-[10px] font-mono text-[color:var(--cv-ink-meta)] tabular-nums truncate inline-flex items-center gap-1">
                        {card.changeCounts ? (
                          <>
                            {card.changeCounts.added > 0 && (
                              <span style={{ color: 'var(--cv-add)' }}>
                                +{card.changeCounts.added}
                              </span>
                            )}
                            {card.changeCounts.removed > 0 && (
                              <span style={{ color: 'var(--cv-del)' }}>
                                -{card.changeCounts.removed}
                              </span>
                            )}
                            {card.changeCounts.added === 0 && card.changeCounts.removed === 0 && (
                              <span>±0</span>
                            )}
                            <span className="opacity-50">·</span>
                            <span>{card.observedClock}</span>
                          </>
                        ) : (
                          card.observedClock
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </foreignObject>
              </g>
            </g>
          );
        })}

        {/* 11. 任务包分组容器横排（v0.8 R1 任务空间桌面主场景）：
            焦点任务包置首，其余按包内最近事件新→旧（buildCanvasPackageGroups 工作流向）；
            容器间贝塞尔连线（C 命令）+ dasharray 6 18 + .anim-pulse-flow（与旧 dash-flow
            同速纪律，1.1s linear），光点流动表达「蓝图→交付」工作流向（左→右）。
            starfix2 T1：上方事件卡改 280x116 四行卡（EVENT_CARD_W/H + 槽位重排），
            富预览卡在分组容器内承载「不点开就能看懂」的文档面（R2，280 同栅格）。 */}
        {canvasLayoutMode === 'xray' &&
          packageGroupLayouts.map(({ group, x, y, width }, groupIdx) => {
            // issue #27：视口外的包不挂载（焦点包除外，由 mountedPkgIds 保证）
            if (!mountedPkgIds.has(group.pkgId)) return null;
            const cards = packageCardsByPkg.get(group.pkgId) ?? [];
            return (
            <React.Fragment key={`pkg-group-${group.pkgId}`}>
              {groupIdx > 0 &&
                (() => {
                  const prev = packageGroupLayouts[groupIdx - 1];
                  // 两端都挂载才画流向线（只挂一端会指向空白，比不画更误导）
                  if (!shouldDrawGroupConnector(prev.group.pkgId, group.pkgId, mountedPkgIds)) {
                    return null;
                  }
                  const sy = y + PACKAGE_GROUP_FRAME_H / 2;
                  const sx = prev.x + prev.width;
                  const ex = x;
                  const lead = Math.max(24, (ex - sx) * 0.5);
                  const d = `M ${sx} ${sy} C ${sx + lead} ${sy}, ${ex - lead} ${sy}, ${ex} ${sy}`;
                  return (
                    <path
                      d={d}
                      fill="none"
                      style={{ stroke: 'var(--cv-lav)' }}
                      strokeOpacity="0.55"
                      strokeWidth="1.4"
                      strokeDasharray="6 18"
                      strokeLinecap="round"
                      className="anim-pulse-flow cv-stream-glow"
                    />
                  );
                })()}
              <PackageGroupFrame
                pkgId={group.pkgId}
                name={pkgTitleOverrides[group.pkgId] ?? group.name}
                docCount={group.docs.length}
                stage={group.stage}
                x={x}
                y={y}
                width={width}
                titleAsOverlay
                selected={group.pkgId === focusedPkgId}
                onSelect={() => {
                  // 选中分组 = 焦点切到包内首位文档（联动 Sources 高亮与叙事抽屉目标）
                  const first = group.docs[0];
                  if (first) onSelectFile(first.fileId);
                }}
              >
                {cards.map((doc) => {
                  // issue #27：共享 ID Map 取文件（不再逐卡 files.find）
                  const fileRec = fileById.get(doc.fileId);
                  const isSelectedRich = selectedRichDocFileId === doc.fileId;
                  // D02 增量聚光灯：已读未变退骨架 / 当前批阅条目琥珀描边（关闭态两参恒 false，零注入）
                  const richDimmed = spotlightDim(doc.fileId);
                  const richCurrent = Boolean(doc.fileId && doc.fileId === spotlightCurrentFileId);
                  return (
                    <RichDocPreviewCard
                      key={doc.fileId}
                      title={doc.title}
                      versionLabel={doc.versionLabel}
                      lane={
                        doc.format === 'md' || doc.format === 'svg' || doc.format === 'pdf'
                          ? doc.format
                          : 'unknown'
                      }
                      conclusion={doc.conclusion}
                      bodyPreview={doc.bodyPreview}
                      diffSections={doc.diffSections as React.ComponentProps<typeof RichDocPreviewCard>['diffSections']}
                      svgThumbDataUri={doc.svgThumbDataUri}
                      selected={isSelectedRich}
                      dimmed={richDimmed}
                      spotlightCurrent={richCurrent}
                      onClick={() => {
                        // v0.8 R2：单击选中并下钻进事件链（与事件卡同语义）；
                        // 冒泡截断在卡片组件内部（契约 onClick 无事件参）
                        setSelectedRichDocFileId(doc.fileId);
                        if (fileRec) {
                          onSelectFile(fileRec.file_id);
                          exploreAfterClick(fileRec.file_id);
                        }
                      }}
                      onDoubleClick={() => {
                        // v0.8 R3③：双击=查看详情（文件叙事抽屉）
                        openNarrativeDrawer({ fileId: doc.fileId });
                      }}
                      onContextMenu={(e) => {
                        if (!fileRec || !systemActions?.onOpenFileContextMenu) return;
                        e.preventDefault();
                        e.stopPropagation();
                        systemActions.onOpenFileContextMenu(e, {
                          kind: 'file',
                          relativePath: fileRec.relative_path,
                          title: fileRec.title,
                          fileId: fileRec.file_id,
                          revisionId: fileRec.current_revision_id,
                        });
                      }}
                    />
                  );
                })}
              </PackageGroupFrame>
            </React.Fragment>
            );
          })}
    </>
  );
}
