/**
 * 星图画布 Alt+方向键 空间漫游——纯函数几何层（零 UI / 零 d3 依赖）。
 *
 * 支持星图画布使用 Alt+方向键 沿引用/因果连线空间漫游（与线性时间轴 J/K 遍历互补），
 * 在多分支因果星图下纯键盘稳定沿连线在上下游关联卡片间跳转。
 *
 * 语义：
 *  - 邻接 = RelationEdge 全集（isInferred 虚线因果边与实线引用边都算「画出来的连线」，
 *    与画布渲染口径一致——画布画了哪条边，键盘就能沿哪条边走），无向遍历；
 *  - 方向选邻 = 只在方向锥（与方向轴夹角 ≤ CONE_HALF_ANGLE_DEG）内取候选，
 *    距离作平局破除，方向偏离角为主排序键——「按方向走」而不是「走最近」；
 *  - 确定性：同输入两次调用逐项全等（平局再按 id 字典序破除），单测锁定。
 */

export type SpatialDirection = 'up' | 'down' | 'left' | 'right';

/** 可漫游节点（画布事件卡 / 任务包富卡的最小投影）。坐标 = zoom 层用户空间。 */
export interface SpatialNavNode {
  id: string;
  fileId: string;
  x: number;
  y: number;
}

/** RelationEdge 的最小鸭子子集（types/guanlan RelationEdge 同字段）。 */
export interface SpatialRelationInput {
  source_id: string;
  target_id: string;
}

/** 与方向轴允许的最大偏离半角（度）。75° 锥 = 只接受「大致朝该方向」的连线邻居。 */
export const SPATIAL_NAV_CONE_HALF_ANGLE_DEG = 75;

/** fileId → 邻接 fileId 集合（无向、去重、不含自环）。 */
export function buildSpatialAdjacency(
  relations: readonly SpatialRelationInput[]
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let set = adj.get(a);
    if (!set) {
      set = new Set<string>();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const edge of relations) {
    if (!edge.source_id || !edge.target_id) continue;
    link(edge.source_id, edge.target_id);
    link(edge.target_id, edge.source_id);
  }
  return adj;
}

function directionVector(direction: SpatialDirection): { dx: number; dy: number } {
  switch (direction) {
    case 'up':
      return { dx: 0, dy: -1 };
    case 'down':
      return { dx: 0, dy: 1 };
    case 'left':
      return { dx: -1, dy: 0 };
    case 'right':
      return { dx: 1, dy: 0 };
  }
}

export interface PickSpatialNeighborInput {
  currentNode: SpatialNavNode;
  nodes: readonly SpatialNavNode[];
  neighborFileIds: ReadonlySet<string>;
  direction: SpatialDirection;
}

/**
 * 方向选邻：连线邻居里挑「最贴合方向」的卡。无邻居 / 锥内无候选返回 null
 * （诚实无路可走，绝不随机跳一个不相连的卡）。
 */
export function pickSpatialNeighbor(input: PickSpatialNeighborInput): SpatialNavNode | null {
  const { currentNode, nodes, neighborFileIds, direction } = input;
  if (neighborFileIds.size === 0) return null;
  const axis = directionVector(direction);
  const halfCos = Math.cos((SPATIAL_NAV_CONE_HALF_ANGLE_DEG * Math.PI) / 180);

  let best: SpatialNavNode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.id === currentNode.id) continue;
    if (!neighborFileIds.has(node.fileId)) continue;
    const dx = node.x - currentNode.x;
    const dy = node.y - currentNode.y;
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    const cos = (dx * axis.dx + dy * axis.dy) / len;
    if (cos < halfCos) continue;
    const angleDeg = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
    const score = angleDeg + len / 1000;
    const isBetter =
      score < bestScore ||
      (score === bestScore && best !== null && node.id < best.id);
    if (isBetter) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}
