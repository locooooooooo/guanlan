/**
 * D01-a 四层拆解 · GraphCanvasView 薄装配层（任务卡 D01-a ②）。
 *
 * 巨石（5027 行）已按四层拆入 graph/ 目录：
 *  - graph/geometry.ts                纯函数几何布局引擎（零 UI 依赖、可单测）
 *  - graph/useGraphCanvasController.tsx 单一行为控制器（state/memo/effect/handler → ctx）
 *  - graph/GraphSceneLayer.tsx        静态 Scene 节点层（整棵 SVG 场景）
 *  - graph/GraphOverlayLayer.tsx      屏幕空间 Overlay 覆盖层
 *  - graph/graphCanvasChrome.tsx      浮动 Chrome 工具栏（顶栏/视图设置/药丸接线）
 *  - graph/GraphSourcesPanel.tsx      浮动 Chrome · Sources 面板
 *
 * 本文件只保留：测试兼容再导出（gc-12/wf2/starfix2/canvas-theme 既有导入路径不变）
 * + 层装配（DOM 嵌套结构与拆解前逐字一致，像素回归护栏覆盖）。
 */

import React from 'react';
// 测试兼容再导出：几何常量与纯函数单一出处（graph/geometry.ts）
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
 * issue #27 验收 4：隐藏时不渲染整棵 SVG（组件保持挂载，选中态/缩放/布局全在控制器
 * state，重新显示即恢复）。派生的分组与卡片在控制器 memo 里同样按 visible 短路。
 */
export const GraphCanvasView: React.FC<GraphCanvasViewProps> = (props) => {
  const ctx = useGraphCanvasController(props);
  if (!props.visible) return null;

  return (
    // 撑满 .dark-porthole 实际可用高（h-full min-h-0），不再写死 100vh-chrome-h——
    // 顶部存在 L4A 进度条或通知横幅时，底部药丸工具栏绝不被挤出视口下缘
    <div className="h-full min-h-0 w-full bg-[color:var(--cv-void)] text-[color:var(--cv-ink)] flex flex-col overflow-hidden select-none relative">
      {/* 全景溯源工作区顶栏：星图/列表/日历 三态切换（契约⑤）+ 画布主题分段钮 + 当前司辰日期。 */}
      <GraphTopBar ctx={ctx} />

      {/* Main Full-Bleed Workspace Stage（stageRef 供选中卡→右栏高亮线取 clientWidth） */}
      <div ref={ctx.stageRef} className="flex-1 relative overflow-hidden">
        {/* LEFT FLOATING PANEL: "Sources"（浮动 Chrome · 来源面板） */}
        <GraphSourcesPanel ctx={ctx} />

        {/* D02 增量聚光灯浮出批阅微条（居中浮于画布顶部，展开时不撑爆顶栏、抽屉滑出时自动让位） */}
        <GraphSpotlightBar ctx={ctx} mode="nav" />

        {/* ② 视图设置弹层（浮动 Chrome） */}
        <GraphViewSettings ctx={ctx} />

        {/* CENTER D3.JS SVG GRAPH CANVAS（静态 Scene 节点层） */}
        <GraphSceneLayer ctx={ctx} />

        {/* D01-a ③ 任务包标题 Overlay（屏幕空间恒定像素字号 + 双击原位改名） */}
        <GraphPackageTitleOverlay ctx={ctx} />

        {/* C4 泳道图例（屏幕空间 Overlay） */}
        <GraphLaneLegend ctx={ctx} />

        {/* C7③/3.1 叙事抽屉「直流电流」连线（屏幕空间 Overlay） */}
        <GraphNarrativeLinkOverlay ctx={ctx} />

        {/* ④ 司辰时间机器摘要气泡（屏幕空间 Overlay） */}
        <GraphChronosDropBubble ctx={ctx} />

        {/* FLOATING HOVER PREVIEW CARD（屏幕空间 Overlay） */}
        <GraphHoverPreviewCard ctx={ctx} />

        {/* v0.8 R5 右上小地图（屏幕空间 Overlay） */}
        <GraphMiniMapSection ctx={ctx} />

        {/* v0.8 R4 底部药丸工具栏（浮动 Chrome） */}
        <GraphPillToolbarSection ctx={ctx} />

        {/* R4⑤ ?快捷键就地轻弹层（屏幕空间 Overlay） */}
        <GraphShortcutsPop ctx={ctx} />

        {/* v0.8 R3 叙事抽屉（屏幕空间 Overlay） */}
        <GraphNarrativeDrawerSection ctx={ctx} />
      </div>
    </div>
  );
};
