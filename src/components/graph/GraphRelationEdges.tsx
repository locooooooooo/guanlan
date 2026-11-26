import React, { useMemo, useState } from 'react';
import type { RelationEdge, RelationType } from '../../types/guanlan';
import {
  DEFAULT_BINDING_GAP,
  EDGE_LABEL_CUTOUT_PAD_X,
  EDGE_LABEL_FONT_PX,
  estimateLabelWidthPx,
  cutPolylineAtRects,
  filterHostObstacles,
  placeEdgeMicroLabels,
  resolveBindingAnchor,
  routeOrthogonalEdge,
  type EdgeMicroLabel,
  type FixedPointBinding,
  type HostRect,
  type ObstacleRect,
  type RoutePt,
} from './edgeRouting';
import { DATE_CARD_H, DATE_CARD_W, DEFAULT_NODE_POSITIONS, EVENT_CARD_H, EVENT_CARD_W } from './geometry';
import type { GraphCanvasCtx } from './useGraphCanvasController';

const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  explicit_reference: '引用',
  derived_from_context: '源自上下文',
  revision_evolution: '版本演进',
  decision_basis: '决策依据',
  same_topic_or_code: '同主题',
  inferred_candidate: '推断',
};

/** 关系边 → 线上微标签：因果类型词 + 行级锚点（locator）+ 悬停完整理由（reason）。
 *  kind 判定：带 locator=anchor（决定页码/单元格锚点语义）、带 reason=reason（理由胶囊语义）、
 *  裸类型=causality（因果关系语义）。 */
export function relationEdgeMicroLabel(edge: RelationEdge): EdgeMicroLabel {
  const typeWord = RELATION_TYPE_LABELS[edge.type] ?? edge.type;
  const anchorSuffix = edge.locator ? ` · L${edge.locator.startLine}` : '';
  return {
    id: edge.edge_id,
    kind: edge.locator ? 'anchor' : edge.reason ? 'reason' : 'causality',
    text: `${typeWord}${anchorSuffix}`,
    detail: edge.reason || undefined,
  };
}

/** 两张卡的相向绑定（按中心相对方位选边：横向为主、纵向次之；同侧 fx/fy 取中点） */
export function facingBindings(
  a: HostRect,
  b: HostRect
): { from: FixedPointBinding; to: FixedPointBinding } {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? {
          from: { fx: 0.5, fy: 0.5, side: 'right' },
          to: { fx: 0.5, fy: 0.5, side: 'left' },
        }
      : {
          from: { fx: 0.5, fy: 0.5, side: 'left' },
          to: { fx: 0.5, fy: 0.5, side: 'right' },
        };
  }
  return dy >= 0
    ? {
        from: { fx: 0.5, fy: 0.5, side: 'bottom' },
        to: { fx: 0.5, fy: 0.5, side: 'top' },
      }
    : {
        from: { fx: 0.5, fy: 0.5, side: 'top' },
        to: { fx: 0.5, fy: 0.5, side: 'bottom' },
      };
}

function renderedFileCardRects(ctx: GraphCanvasCtx): Map<string, HostRect> {
  const byId = new Map<string, HostRect>();
  const visibleCards =
    ctx.isFanOutCollapsed && ctx.canvasLayoutMode === 'xray'
      ? ctx.subAgentCards.slice(0, 2)
      : ctx.subAgentCards;
  for (const card of visibleCards) {
    if (!card.fileId || !ctx.isNodeVisibleByCategory(card.format)) continue;
    const pos = ctx.nodePositions[card.id] || DEFAULT_NODE_POSITIONS[card.id];
    byId.set(card.fileId, { x: pos.x, y: pos.y, width: EVENT_CARD_W, height: EVENT_CARD_H });
  }
  for (const src of ctx.leftSourceNodes) {
    if (!src.fileId || !ctx.isNodeVisibleByCategory(src.badge)) continue;
    const pos = ctx.resolveLeftSourcePos(src);
    byId.set(src.fileId, { x: pos.x, y: pos.y, width: DATE_CARD_W, height: DATE_CARD_H });
  }
  return byId;
}

interface RelationEdgeModel {
  key: string;
  edge: RelationEdge;
  fromPt: RoutePt;
  toPt: RoutePt;
  points: RoutePt[];
  label: EdgeMicroLabel;
  isInferred: boolean;
}

/** 装配证据链连线模型（纯数据，渲染薄壳消费；无焦点/无可达对 → 空数组 = 层渲染 null） */
export function assembleRelationEdgeModels(ctx: GraphCanvasCtx): RelationEdgeModel[] {
  const focusNodeId = ctx.hoveredCanvasNodeId || ctx.selectedCanvasNodeId;
  if (!focusNodeId || focusNodeId === 'main_hub' || focusNodeId === 'chronos_deity') return [];
  const rects = renderedFileCardRects(ctx);
  const focusFileId =
    ctx.subAgentCards.find((c) => c.id === focusNodeId)?.fileId ??
    ctx.leftSourceNodes.find((s) => s.id === focusNodeId)?.fileId ??
    '';
  if (!focusFileId) return [];
  const models: RelationEdgeModel[] = [];
  const seen = new Set<string>();
  for (const edge of ctx.relations) {
    const otherId = edge.source_id === focusFileId ? edge.target_id : edge.target_id === focusFileId ? edge.source_id : null;
    if (!otherId) continue;
    const hostFrom = rects.get(edge.source_id);
    const hostTo = rects.get(edge.target_id);
    if (!hostFrom || !hostTo) continue;
    const dedupeKey = `${edge.source_id}->${edge.target_id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const binding = facingBindings(hostFrom, hostTo);
    const fromPt = resolveBindingAnchor(hostFrom, binding.from, DEFAULT_BINDING_GAP);
    const toPt = resolveBindingAnchor(hostTo, binding.to, DEFAULT_BINDING_GAP);
    const obstacles: ObstacleRect[] = filterHostObstacles(ctx.graphObstacleRects, fromPt, toPt);
    const route = routeOrthogonalEdge(fromPt, toPt, obstacles, { clearance: DEFAULT_BINDING_GAP });
    models.push({
      key: edge.edge_id,
      edge,
      fromPt,
      toPt,
      points: route.points,
      label: relationEdgeMicroLabel(edge),
      isInferred: edge.isInferred,
    });
  }
  return models;
}

export function GraphRelationEdges({ ctx }: { ctx: GraphCanvasCtx }) {
  const models = useMemo(
    () => assembleRelationEdgeModels(ctx),
    [ctx]
  );
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  if (models.length === 0) return null;
  return (
    <g data-testid="graph-relation-edges">
      {models.map((model) => {
        const layouts = placeEdgeMicroLabels(model.points, [model.label]);
        const cutPath =
          layouts.length > 0
            ? cutPolylineAtRects(model.points, layouts.map((l) => l.cutout)).path
            : '';
        const hovered = hoveredEdgeId === model.key;
        const fontPx = hovered ? 11.5 : EDGE_LABEL_FONT_PX;
        return (
          <g
            key={model.key}
            opacity={hovered ? 1 : 0.85}
            onMouseEnter={() => setHoveredEdgeId(model.key)}
            onMouseLeave={() => setHoveredEdgeId((v) => (v === model.key ? null : v))}
          >
            <title>
              {`${model.label.text}${model.label.detail ? ` — ${model.label.detail}` : ''}`}
            </title>
            <path
              d={cutPath}
              fill="none"
              style={{ stroke: 'var(--cv-link)' }}
              strokeWidth="1.3"
              strokeDasharray={model.isInferred ? '4 4' : undefined}
              opacity={model.isInferred ? 0.6 : 0.8}
              pointerEvents="none"
            />
            {layouts.map((layout) => {
              const pillW = estimateLabelWidthPx(model.label.text, fontPx) + 2 * EDGE_LABEL_CUTOUT_PAD_X;
              const pillH = fontPx + 4;
              return (
                <g key={layout.label.id} transform={`translate(${layout.center.x}, ${layout.center.y})`}>
                  <rect
                    x={-pillW / 2}
                    y={-pillH / 2}
                    width={pillW}
                    height={pillH}
                    rx={pillH / 2}
                    style={{
                      fill: 'var(--cv-card)',
                      stroke: 'color-mix(in srgb, var(--cv-hairline-ink) 14%, transparent)',
                    }}
                    strokeWidth="1"
                  />
                  <text
                    textAnchor="middle"
                    y={fontPx * 0.36}
                    style={{ fill: hovered ? 'var(--cv-link)' : 'var(--cv-ink-2)' }}
                    fontSize={fontPx}
                    fontFamily="var(--font-mono)"
                  >
                    {model.label.text}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
