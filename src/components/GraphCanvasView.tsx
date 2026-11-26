
import React from 'react';
export {
  CHRONOS_MASCOT_WIDTH,
  CHRONOS_TRUNK_DX,
  DATE_CARD_CHRONOS_MIN_GAP,
  DATE_CARD_H,
  DATE_CARD_RAIL_TRUNK_DX,
  DATE_CARD_TRUNK_MIN_GAP,
  DATE_CARD_W,
  DEFAULT_NODE_POSITIONS,
  EVENT_CARD_COL_GAP,
  EVENT_CARD_H,
  EVENT_CARD_ROW_GAP,
  EVENT_CARD_W,
  FANOUT_HEADER_BUTTON_LEFT_GAP_W,
  FANOUT_HEADER_BUTTON_MARGIN_RIGHT,
  FANOUT_HEADER_BUTTON_W,
  FANOUT_HEADER_CAPSULE_H,
  FANOUT_HEADER_CAPSULE_TOP,
  FANOUT_HEADER_CHRONOS_GAP_MIN,
  FANOUT_HEADER_TEXT_BUDGET_OFFSET,
  FANOUT_HEADER_TEXT_FONT_PX,
  FANOUT_HEADER_TEXT_LEFT,
  FIXED_TEXT_TRUNK_DX,
  LANE_COLORS,
  LANE_OFFSETS,
  PAN_TRANSITION_MS,
  SOURCES_PANEL_COLLAPSED_LEFT,
  SOURCES_PANEL_SAFE_LEFT,
  SPRING_STAGGER_MS,
  TRUNK_AXIS_PAD,
  TRUNK_META_TEXT_Y,
  dateCardChronosGap,
  dateCardRailX,
  dateCardTrunkGap,
  eventMatchesRulerTick,
  fanOutHeaderButtonLeft,
  fanOutHeaderCapsuleWidth,
  fanOutHeaderCapsuleY,
  fanOutHeaderTextMaxWidth,
  fanOutHeaderTextWidth,
  fitFanOutHeaderText,
  milestoneY,
  sceneDateLabel,
  trunkTickShowsLabel,
} from './graph/geometry';
export type {
  CapabilityCode,
  LaneKey,
  LeftSourceNodeModel,
  NodePositionMap,
  PanoramaMode,
  SubAgentCardModel,
} from './graph/geometry';
export type { GraphCanvasCtx, GraphCanvasViewProps } from './graph/useGraphCanvasController';
import type { GraphCanvasViewProps } from './graph/useGraphCanvasController';
import { useGraphCanvasController } from './graph/useGraphCanvasController';

import { GraphSceneLayer } from './graph/GraphSceneLayer';
import {
  GraphChronosDropBubble,
  GraphHoverPreviewCard,
  GraphLaneLegend,
  GraphMiniMapSection,
  GraphNarrativeDrawerSection,
  GraphNarrativeLinkOverlay,
  GraphPackageTitleOverlay,
  GraphShortcutsPop,
} from './graph/GraphOverlayLayer';
import {
  GraphPillToolbarSection,
  GraphTopBar,
  GraphViewSettings,
} from './graph/graphCanvasChrome';
import { GraphSourcesPanel } from './graph/GraphSourcesPanel';
import { GraphSpotlightBar } from './graph/GraphSpotlightBar';

/**
 * 全景溯源星图画布（四层装配）。
 * 隐藏时不渲染整棵 SVG（组件保持挂载，选中态/缩放/布局全在控制器
 * state，重新显示即恢复）。派生的分组与卡片在控制器 memo 里同样按 visible 短路。
 */
export const GraphCanvasView: React.FC<GraphCanvasViewProps> = (props) => {
  const ctx = useGraphCanvasController(props);
  if (!props.visible) return null;

  return (
    <div className="h-full min-h-0 w-full bg-[color:var(--cv-void)] text-[color:var(--cv-ink)] flex flex-col overflow-hidden select-none relative">
      <GraphTopBar ctx={ctx} />

      <div ref={ctx.stageRef} className="flex-1 relative overflow-hidden">
        <GraphSourcesPanel ctx={ctx} />

        <GraphSpotlightBar ctx={ctx} mode="nav" />

        <GraphViewSettings ctx={ctx} />

        <GraphSceneLayer ctx={ctx} />

        <GraphPackageTitleOverlay ctx={ctx} />

        <GraphLaneLegend ctx={ctx} />

        <GraphNarrativeLinkOverlay ctx={ctx} />

        <GraphChronosDropBubble ctx={ctx} />

        <GraphHoverPreviewCard ctx={ctx} />

        <GraphMiniMapSection ctx={ctx} />

        <GraphPillToolbarSection ctx={ctx} />

        <GraphShortcutsPop ctx={ctx} />

        <GraphNarrativeDrawerSection ctx={ctx} />
      </div>
    </div>
  );
};
