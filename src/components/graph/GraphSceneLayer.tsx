/**
 * 静态 SVG 场景节点层（薄装配）：
 *
 * 整棵 SVG 场景按功能分节组合：
 *  - GraphSceneBackdrop.tsx  defs 渐变/滤镜 + 流星雨星闪 + 星轨 + 固定文字组 + 传导线
 *  - GraphSceneTrunk.tsx     四泳道主干 + 里程碑刻度 + 来源连线 + 计数胶囊
 *  - GraphSceneNodes.tsx     扇出盒 + 司辰 + 主节点 + 左侧日期卡
 *  - GraphSceneCards.tsx     事件卡 + 任务包分组横排
 * 保持 svg > g[zoom 层] > 分节子树的稳定 DOM 嵌套结构。
 */

import React from 'react';
import type { GraphCanvasCtx } from './useGraphCanvasController';
import { GraphSceneBackdrop } from './GraphSceneBackdrop';
import { GraphSceneTrunk } from './GraphSceneTrunk';
// 证据链连线层（悬停/选中的关系边 + 镂空微标签；静置态渲染 null 零像素）
import { GraphRelationEdges } from './GraphRelationEdges';
import { GraphSceneNodes } from './GraphSceneNodes';
import { GraphSceneCards } from './GraphSceneCards';

/** 整棵 SVG 场景（CENTER D3.JS SVG GRAPH CANVAS）。 */
export function GraphSceneLayer({ ctx }: { ctx: GraphCanvasCtx }) {
  const { svgRef, canvasTool, zoomLayerRef } = ctx;
  return (
    <svg
      ref={svgRef}
      data-testid="d3-graph-svg"
      className={`w-full h-full block select-none ${
        // 抓手态保留 grab 光标；指针态光标落 default（点选优先，拖拽平移关闭）
        canvasTool === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      }`}
      style={{
        backgroundColor: 'var(--cv-void)',
        backgroundImage:
          'radial-gradient(var(--cv-dot) 1px, transparent 1px)',
        backgroundSize: '26px 26px',
      }}
    >
      {/* D3 Zoomable & Pannable Group
          perf：transform 属性去 React 托管——挂载时由 useLayoutEffect 写一次初始变换，
          之后只由 zoom 事件帧内直写；若保留 JSX 绑定，zoomTransform state 虽只在
          gesture end 更新，但其他 state（选中/悬浮/开关）触发的整树重渲都会用旧值
          抹掉命令式写入，画布瞬间跳回上一次落定位 */}
      <g ref={zoomLayerRef} data-testid="graph-transform-layer">
        <GraphSceneBackdrop ctx={ctx} />
        <GraphSceneTrunk ctx={ctx} />
        <GraphRelationEdges ctx={ctx} />
        <GraphSceneNodes ctx={ctx} />
        <GraphSceneCards ctx={ctx} />
      </g>
    </svg>
  );
}
