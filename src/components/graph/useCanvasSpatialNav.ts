/**
 * D05 · 星图画布 Alt+方向键 空间漫游——画布侧接线 Hook（挂载于 useGraphCanvasController）。
 *
 * 任务卡 D05 改动与产物③：沿引用/因果连线空间漫游（与线性时间轴 J/K 遍历互补）。
 * 几何判定全在纯函数 utils/canvasSpatialNav（邻接 + 方向锥选邻，单测锁定）；本 Hook 只做：
 *  - window keydown 监听 Alt+方向键（Ctrl/Meta 组合不认；编辑面/浮层让路同全局护栏）；
 *  - 候选节点 = 事件卡（subAgentCards）+ 左侧来源卡 + 任务包富卡（packageGroupLayouts
 *    内渲染槽位），全部自带 zoom 层世界中心坐标——与渲染几何同源，绝不把富卡压成 (0,0)；
 *  - 跳转 = 同步选中态（事件卡/富卡各自落对应 state + onSelectFile 右栏联动）+
 *    applyProgrammaticZoom 居中（遵循 prefers-reduced-motion 动态静默降级 durationMs=0）。
 *
 * 无选中卡 / 无连线邻居 / 方向锥内无候选时静默（诚实无路可走，绝不随机跳无关卡）。
 */
import { useEffect, useRef } from 'react';
import {
  buildSpatialAdjacency,
  pickSpatialNeighbor,
  type SpatialDirection,
  type SpatialNavNode,
} from '../../utils/canvasSpatialNav';
import {
  effectiveMotionDurationMs,
  hasBlockingDomOverlay,
  isEditableLikeTarget,
} from '../../utils/keyboardShortcuts';
import type { RelationEdge } from '../../types/guanlan';
import {
  DATE_CARD_H,
  DATE_CARD_W,
  EVENT_CARD_H,
  EVENT_CARD_W,
  type NodePositionMap,
  type SubAgentCardModel,
} from './geometry';
import { PACKAGE_GROUP_FRAME_H } from '../canvas/PackageGroupFrame';
import { RICH_CARD_W } from '../canvas/RichDocPreviewCard';

export interface CanvasNavCard {
  id: string;
  fileId: string;
  /** zoom 层用户空间中心坐标（与渲染卡片几何同源）。 */
  x: number;
  y: number;
  kind: 'event' | 'rich' | 'source';
  revisionId?: string;
  /** true = 位于折叠扇出箱的第 3 张及以后，跳转前自动展开扇出组。 */
  hiddenInFold?: boolean;
}

export interface UseCanvasSpatialNavOptions {
  enabled: boolean;
  relations: readonly RelationEdge[];
  /** 可漫游卡（带 zoom 层中心坐标），渲染同源顺序。 */
  cards: readonly CanvasNavCard[];
  selectedNodeId: string;
  selectedRichDocFileId: string | null;
  selectedFileId: string;
  /** 选中同步（由 controller 按 card.kind 写 selectedCanvasNodeId / selectedRichDocFileId + onSelectFile）。 */
  onSelectCard: (card: CanvasNavCard) => void;
  /** 目标居中运镜（durationMs 已经 effectiveMotionDurationMs 降级）。 */
  centerOn: (card: CanvasNavCard, durationMs: number) => void;
}

const ARROW_BY_DIRECTION: Record<string, SpatialDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** 定位当前空间漫游起点卡：富卡选中优先于旧事件卡 → 事件卡 ID → 当前聚焦 fileId 兜底。 */
export function resolveActiveSpatialCard(
  cards: readonly CanvasNavCard[],
  selectedNodeId: string,
  selectedRichDocFileId: string | null,
  selectedFileId: string
): CanvasNavCard | undefined {
  if (selectedRichDocFileId) {
    const rich = cards.find((c) => c.kind === 'rich' && c.fileId === selectedRichDocFileId);
    if (rich) return rich;
  }
  if (selectedNodeId) {
    const byId = cards.find((c) => c.id === selectedNodeId);
    if (byId) return byId;
  }
  if (selectedFileId) {
    return cards.find((c) => c.fileId === selectedFileId);
  }
  return undefined;
}

export function useCanvasSpatialNav({
  enabled,
  relations,
  cards,
  selectedNodeId,
  selectedRichDocFileId,
  selectedFileId,
  onSelectCard,
  centerOn,
}: UseCanvasSpatialNavOptions): void {
  const ctxRef = useRef({
    relations,
    cards,
    selectedNodeId,
    selectedRichDocFileId,
    selectedFileId,
    onSelectCard,
    centerOn,
  });
  useEffect(() => {
    ctxRef.current = {
      relations,
      cards,
      selectedNodeId,
      selectedRichDocFileId,
      selectedFileId,
      onSelectCard,
      centerOn,
    };
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const direction = ARROW_BY_DIRECTION[event.key];
      if (!direction) return;
      if (hasBlockingDomOverlay()) return;
      if (isEditableLikeTarget(event.target)) return;

      const {
        relations: edges,
        cards: navCards,
        selectedNodeId: currentId,
        selectedRichDocFileId: currentRichId,
        selectedFileId: currentFileId,
        onSelectCard: selectCard,
        centerOn: focus,
      } = ctxRef.current;
      if (navCards.length === 0) return;

      const currentCard = resolveActiveSpatialCard(
        navCards,
        currentId,
        currentRichId,
        currentFileId
      );
      if (!currentCard || !currentCard.fileId) return;

      const adjacency = buildSpatialAdjacency(edges);
      const neighborFileIds = adjacency.get(currentCard.fileId);
      if (!neighborFileIds || neighborFileIds.size === 0) return;

      const nodes: SpatialNavNode[] = navCards.map((c) => ({
        id: c.id,
        fileId: c.fileId,
        x: c.x,
        y: c.y,
      }));
      const currentNode = nodes.find((n) => n.id === currentCard.id);
      if (!currentNode) return;

      const next = pickSpatialNeighbor({
        currentNode,
        nodes,
        neighborFileIds,
        direction,
      });
      if (!next) return; // 锥内无连线邻居：诚实无路可走，不跳不相干的卡
      event.preventDefault();
      const nextCard = navCards.find((c) => c.id === next.id);
      if (!nextCard) return;
      selectCard(nextCard);
      focus(nextCard, effectiveMotionDurationMs(260));
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);
}

/**
 * 画布全类卡片 → 可漫游卡投影（与 Scene 层几何口径 100% 同源）：
 *  - 事件卡（subAgentCards）：位置取 nodePositions / DEFAULT_NODE_POSITIONS + 半宽高中心；
 *  - 左侧带 fileId 的来源卡（leftSourceNodes）：位置取 resolveLeftSourcePos + 半宽高中心；
 *  - 任务包横排富预览卡（packageGroupLayouts × packageCardsByPkg）：按容器内真实横排槽位
 *    `layout.x + 14 + idx * (RICH_CARD_W + 12) + RICH_CARD_W / 2` 计算世界中心。
 */
export function buildSpatialNavCards(input: {
  subAgentCards: readonly SubAgentCardModel[];
  isFanOutCollapsed: boolean;
  canvasLayoutMode: string;
  nodePositions: NodePositionMap;
  defaultPositions: NodePositionMap;
  leftSourceNodes: ReadonlyArray<{ id: string; fileId?: string; x: number; y: number }>;
  packageLayouts: ReadonlyArray<{
    pkgId: string;
    x: number;
    y: number;
    docs: ReadonlyArray<{ fileId: string }>;
  }>;
}): CanvasNavCard[] {
  const out: CanvasNavCard[] = [];
  const seenIds = new Set<string>();

  input.subAgentCards.forEach((card, idx) => {
    if (!card.fileId || seenIds.has(card.id)) return;
    seenIds.add(card.id);
    const pos = input.nodePositions[card.id] ?? input.defaultPositions[card.id] ?? { x: 0, y: 0 };
    out.push({
      id: card.id,
      fileId: card.fileId,
      x: pos.x + EVENT_CARD_W / 2,
      y: pos.y + EVENT_CARD_H / 2,
      kind: 'event',
      revisionId: card.revisionId ?? undefined,
      hiddenInFold: input.isFanOutCollapsed && input.canvasLayoutMode === 'xray' && idx >= 2,
    });
  });

  for (const src of input.leftSourceNodes) {
    if (!src.fileId || seenIds.has(src.id)) continue;
    seenIds.add(src.id);
    out.push({
      id: src.id,
      fileId: src.fileId,
      x: src.x + DATE_CARD_W / 2,
      y: src.y + DATE_CARD_H / 2,
      kind: 'source',
    });
  }

  for (const layout of input.packageLayouts) {
    layout.docs.forEach((doc, idx) => {
      if (!doc.fileId) return;
      const id = `rich:${layout.pkgId}:${doc.fileId}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);
      out.push({
        id,
        fileId: doc.fileId,
        x: layout.x + 14 + idx * (RICH_CARD_W + 12) + RICH_CARD_W / 2,
        y: layout.y + PACKAGE_GROUP_FRAME_H / 2,
        kind: 'rich',
      });
    });
  }

  return out;
}
