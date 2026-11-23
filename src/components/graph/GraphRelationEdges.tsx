/**
 * D01-b · 线上证据链连线层（任务卡 D01-b ③：跨事项引用与多文档证据链可视化）。
 *
 * 悬停/选中某张事件卡时，同屏渲染该文件与其他**在画布上**的文件卡之间的引用/因果边
 * （relations 单一来源：type 因果类型 + reason 证据理由 + locator 行级锚点）；
 * 连线全部走 D01-b 正交避障引擎（绕开卡片本体、呼吸间距出口），线上语义微标签
 * 对文字包围盒做线体裁切（cutout 永不重叠），悬停放大、常态克制。
 *
 * 降噪纪律（D 批次目标）：无悬停/选中 → 本层渲染 null（零 DOM 零像素）——
 * D01-a 像素基线五镜头均为无交互静置态，本层结构性零偏移。
 * 实时跟随：端点/障碍全部派生自 nodePositions，拖拽/展开/收起经 rAF 合帧 setState
 * 后同帧重算（与既有连线同一派生链，无缓存态可脱钩）。
 */
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

/** 因果类型界面词（逐项死映射；未知类型诚实回退原值） */
const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  explicit_reference: '引用',
  derived_from_context: '源自上下文',
  revision_evolution: '版本演进',
  decision_basis: '决策依据',
  same_topic_or_code: '同主题',
  inferred_candidate: '推断',
};

/** 关系边 → 线上微标签：因果类型词 + 行级锚点（locator）+ 悬停完整理由（reason）。
 *  kind 判定：带 locator=anchor（决定页码/单元格锚点语义）、带 reason=reason（C01
 *  理由胶囊语义）、裸类型=causality（因果关系语义）。 */
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

/** 画布上「可见文件卡」矩形登记表：fileId → 宿主矩形（渲染口径与 Scene 层一致：
 *  折叠时事件卡只取前 2 张 + 分类可见性过滤；日期导航卡（fileId=''）不入表） */
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
  // 焦点节点：事件卡或来源卡的 file_id（画布节点 id → 文件身份）
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
    if (!hostFrom || !hostTo) continue; // 端点不在画布 → 诚实不画（绝不指向空白）
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
    // ctx 为整体对象（控制器每次渲染新引用）；其内部数据源已各自 memo 化，
    // 本层随 Scene 整树同帧渲染，无需更细依赖拆分
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            {/* 线体（镂空后可见段）：文字区域处线被切开，cutout 永不重叠；
                path 命中交互关闭（命中区只留给标签胶囊），推断边虚线语义保留 */}
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
