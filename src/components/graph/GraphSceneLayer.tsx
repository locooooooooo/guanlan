
import React from 'react';
import type { GraphCanvasCtx } from './useGraphCanvasController';
import { GraphSceneBackdrop } from './GraphSceneBackdrop';
import { GraphSceneTrunk } from './GraphSceneTrunk';
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
        canvasTool === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      }`}
      style={{
        backgroundColor: 'var(--cv-void)',
        backgroundImage:
          'radial-gradient(var(--cv-dot) 1px, transparent 1px)',
        backgroundSize: '26px 26px',
      }}
    >
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
