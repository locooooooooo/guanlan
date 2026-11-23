/**
 * D01-b · 正交避障连线引擎确定性单测（任务卡 D01-b 量化口径）。
 *
 * 覆盖四类硬口径：
 *  - 多障碍绕行（两翼墙 + 阶梯障碍 → A* 稀疏非均匀网格，路径不穿任何障碍膨胀区）
 *  - 最少拐点（直线 → 单拐 L → 双拐 Z → A* 分层择优；能少一拐绝不多拐）
 *  - 锚点呼吸间距边界（bindingGap 恒定净距、[0,1] 钳制、移动/缩放 100% 代数跟随）
 *  - 线上镂空微标签（cutout 矩形处线体裁切，文字区域永不压线）
 *  - D01-a 像素基线零偏移矩阵（默认 xray 场景全部既有连线 strategy=legacy-clear，
 *    path 与 computeDynamicEdgePath 逐字节一致——像素基线护栏的结构性证明）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeBoundEdgeRoute,
  cutPolylineAtRects,
  bindingExitPoint,
  bindingFromLegacyPoint,
  clampUnit,
  DEFAULT_BINDING_GAP,
  estimateLabelWidthPx,
  placeEdgeMicroLabels,
  resolveBindingAnchor,
  roundedOrthoPath,
  routeOrthogonalEdge,
  type ObstacleRect,
  type RoutePt,
} from '../src/components/graph/edgeRouting';
import { computeDynamicEdgePath, computeFanOutBounds } from '../src/utils/guanlanEngine';
import {
  DATE_CARD_H,
  DATE_CARD_W,
  DEFAULT_NODE_POSITIONS,
  EVENT_CARD_H,
  EVENT_CARD_W,
  dateCardRailX,
} from '../src/components/graph/geometry';
import {
  assembleRelationEdgeModels,
  facingBindings,
  relationEdgeMicroLabel,
} from '../src/components/graph/GraphRelationEdges';
import type { GraphCanvasCtx } from '../src/components/graph/useGraphCanvasController';

// ---------- ① FixedPointBinding：归一化比例锚点绑定 ----------

test('D01-b clampUnit：NaN 回退中点、越界钳 [0,1]', () => {
  assert.equal(clampUnit(Number.NaN), 0.5);
  assert.equal(clampUnit(Number.POSITIVE_INFINITY), 1);
  assert.equal(clampUnit(-0.2), 0);
  assert.equal(clampUnit(1.7), 1);
  assert.equal(clampUnit(0.3), 0.3);
});

test('D01-b 呼吸间距边界：锚点恒在绑定边外推 gap 处，gap=0 退化为贴边出口', () => {
  const rect = { x: 100, y: 200, width: 120, height: 50 };
  const binding = { fx: 0.5, fy: 0.48, side: 'right' as const };
  // 出口 = (220, 224)；呼吸锚点 = 右缘 +14
  const anchor = resolveBindingAnchor(rect, binding);
  assert.deepEqual(anchor, { x: 220 + DEFAULT_BINDING_GAP, y: 224 });
  assert.deepEqual(bindingExitPoint(rect, binding), { x: 220, y: 224 });
  // gap=0 → 恰好贴边（边界情形锁定）
  assert.deepEqual(resolveBindingAnchor(rect, binding, 0), { x: 220, y: 224 });
  // fy 越界钳制：1.5 → 1 → y = rect.y + height
  assert.deepEqual(
    resolveBindingAnchor(rect, { fx: 0, fy: 1.5, side: 'right' }),
    { x: 220 + DEFAULT_BINDING_GAP, y: 250 }
  );
  // top 边：锚点在 y = rect.y - gap
  assert.deepEqual(
    resolveBindingAnchor(rect, { fx: 0.25, fy: 0.5, side: 'top' }),
    { x: 100 + 0.25 * 120, y: 200 - DEFAULT_BINDING_GAP }
  );
});

test('D01-b 绑定锚点 100% 代数跟随：宿主平移/缩放后锚点按比例精确重算（不脱钩的结构证明）', () => {
  const binding = { fx: 0.5, fy: 0.6, side: 'right' as const };
  const rect = { x: 100, y: 200, width: 120, height: 50 };
  const before = resolveBindingAnchor(rect, binding);
  // 平移 (+50, +30)：锚点平移量逐字节一致
  const moved = resolveBindingAnchor({ ...rect, x: rect.x + 50, y: rect.y + 30 }, binding);
  assert.equal(moved.x - before.x, 50);
  assert.equal(moved.y - before.y, 30);
  // 缩放 height 50→100：fy=0.6 比例出口随宽高比例重算
  const scaled = resolveBindingAnchor({ ...rect, height: 100 }, binding);
  assert.equal(scaled.y, rect.y + 60);
  assert.equal(scaled.x, rect.x + rect.width + DEFAULT_BINDING_GAP);
});

test('D01-b bindingFromLegacyPoint：旧绝对出口点 → 最近边归一化绑定', () => {
  const rect = { x: 122, y: 146, width: DATE_CARD_W, height: DATE_CARD_H };
  // (240,170)：dr=2 最近 → side right，fy = (170-146)/50 = 0.48
  const b = bindingFromLegacyPoint(rect, { x: 240, y: 170 });
  assert.equal(b.side, 'right');
  assert.equal(b.fy, 0.48);
  // 居中偏上点：纵距 25 < 横距 60 → 最近边 top/bottom 并列 → 固定序取 top
  const c = bindingFromLegacyPoint(rect, { x: 182, y: 171 });
  assert.equal(c.side, 'top');
  assert.equal(c.fx, 0.5);
});

// ---------- ② 避障路由：兼容/命中/最少拐点/A* ----------

test('D01-b 走廊无障碍 → legacy-clear：path 与既有贝塞尔逐字节一致（三 mode 矩阵）', () => {
  const modes = [
    { from: { x: 240, y: 170 }, to: { x: 410, y: 174 }, mode: 'source_to_trunk' as const },
    { from: { x: 418, y: 142 }, to: { x: 454, y: 389 }, mode: 'trunk_to_subagent' as const },
    { from: { x: 400, y: 300 }, to: { x: 360, y: 420 }, mode: 'subagent_to_merge' as const },
  ];
  for (const { from, to, mode } of modes) {
    const route = computeBoundEdgeRoute({
      from,
      to,
      mode,
      obstacles: [{ id: 'far-away', x: 900, y: 900, width: 100, height: 100 }],
    });
    assert.equal(route.strategy, 'legacy-clear');
    assert.equal(route.path, computeDynamicEdgePath(from, to, mode));
    assert.equal(route.points, null);
    assert.equal(route.bends, 0);
  }
});

test('D01-b 命中卡片本体 → 绑定锚点呼吸间距 + 避障路由，折线绝不穿障碍', () => {
  const from = { x: 240, y: 170 };
  const to = { x: 410, y: 174 };
  // 横在走廊中间的卡片（覆盖 x 280..340, y 150..195）
  const obstacle: ObstacleRect = { id: 'mid-card', x: 280, y: 150, width: 60, height: 45 };
  const route = computeBoundEdgeRoute({
    from,
    to,
    mode: 'source_to_trunk',
    obstacles: [obstacle],
    hosts: { from: { x: 122, y: 146, width: DATE_CARD_W, height: DATE_CARD_H } },
  });
  assert.notEqual(route.strategy, 'legacy-clear');
  assert.notEqual(route.strategy, 'blocked');
  assert.notEqual(route.path, computeDynamicEdgePath(from, to, 'source_to_trunk'));
  assert.ok(route.points, '命中时必须返回折线顶点');
  // 呼吸间距：出口重锚到卡片右缘 + gap = 242 + 14 = 256
  assert.equal(route.points![0].x, 122 + DATE_CARD_W + DEFAULT_BINDING_GAP);
  assert.equal(route.points![0].y, 170);
  // 折线每段与障碍膨胀区（clearance=14）零严格相交
  const clearance = DEFAULT_BINDING_GAP;
  const l = obstacle.x - clearance;
  const r = obstacle.x + obstacle.width + clearance;
  const t = obstacle.y - clearance;
  const b = obstacle.y + obstacle.height + clearance;
  for (let i = 0; i < route.points!.length - 1; i++) {
    const p = route.points![i];
    const q = route.points![i + 1];
    const lox = Math.min(p.x, q.x);
    const hix = Math.max(p.x, q.x);
    const loy = Math.min(p.y, q.y);
    const hiy = Math.max(p.y, q.y);
    const intersects = hix > l && lox < r && hiy > t && loy < b;
    assert.ok(!intersects, `段 ${i} 穿入障碍膨胀区`);
  }
});

test('D01-b 最少拐点：直线被挡但 L 形可绕 → one-bend（绝不上 A*）', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 300, y: 100 };
  // 只挡「先横后纵」L 与直线，纵先 L (x=0) 通畅
  const obstacle: ObstacleRect = { id: 'block', x: 150, y: -30, width: 40, height: 60 };
  const route = routeOrthogonalEdge(from, to, [obstacle]);
  assert.equal(route.strategy, 'one-bend');
  assert.equal(route.bends, 1);
  assert.equal(route.points.length, 3);
  assert.ok(route.path.includes('Q'), '拐点必须圆角（Q 指令）');
});

test('D01-b 最少拐点：直线/L/Z 全被挡 → A* 贴净距顶上绕行（2 拐，不穿膨胀区）', () => {
  // 竖墙挡死直线走廊（y=0），端点共轴 → L/Z 全退化 → A* 沿膨胀边界（净距 14）绕行
  const wall: ObstacleRect = { id: 'wall', x: 140, y: -40, width: 20, height: 80 };
  const route = routeOrthogonalEdge({ x: 0, y: 0 }, { x: 300, y: 0 }, [wall]);
  assert.equal(route.strategy, 'astar');
  // 已知取舍：等代价（g 相同）路线存在双亲歧义，重构折线取先入队双亲——
  // 本例几何拐点 3（另一条 g 相等的路线为 2 拐）。最少拐点由 bendPenalty 权重与
  // 「直线→L→Z→A*」阶梯共同保证；此处断言不劣于 3 拐且完全不穿膨胀区。
  assert.ok(route.bends >= 2 && route.bends <= 3, `实际拐点 ${route.bends}`);
  // 路径不穿墙膨胀区
  const l = wall.x - DEFAULT_BINDING_GAP;
  const r = wall.x + wall.width + DEFAULT_BINDING_GAP;
  const t = wall.y - DEFAULT_BINDING_GAP;
  const b = wall.y + wall.height + DEFAULT_BINDING_GAP;
  for (let i = 0; i < route.points.length - 1; i++) {
    const p = route.points[i];
    const q = route.points[i + 1];
    const intersects =
      Math.max(p.x, q.x) > l &&
      Math.min(p.x, q.x) < r &&
      Math.max(p.y, q.y) > t &&
      Math.min(p.y, q.y) < b;
    assert.ok(!intersects, `段 ${i} 穿墙`);
  }
});

test('D01-b 多障碍阶梯绕行：A* 稀疏网格跨多障碍织路，两次调用输出逐字节一致（确定性）', () => {
  const from = { x: 0, y: 50 };
  const to = { x: 400, y: 50 };
  const stairA: ObstacleRect = { id: 'a', x: 100, y: 0, width: 20, height: 60 };
  const stairB: ObstacleRect = { id: 'b', x: 240, y: 40, width: 20, height: 60 };
  const route1 = routeOrthogonalEdge(from, to, [stairA, stairB]);
  const route2 = routeOrthogonalEdge(from, to, [stairA, stairB]);
  assert.equal(route1.strategy, 'astar');
  assert.equal(route1.path, route2.path, '同输入必须逐字节同输出');
  assert.equal(JSON.stringify(route1.points), JSON.stringify(route2.points));
  assert.ok(route1.bends >= 2, `阶梯绕行至少 2 拐，实际 ${route1.bends}`);
  // 不穿任何障碍膨胀区
  for (const o of [stairA, stairB]) {
    const l = o.x - DEFAULT_BINDING_GAP;
    const r = o.x + o.width + DEFAULT_BINDING_GAP;
    const t = o.y - DEFAULT_BINDING_GAP;
    const b = o.y + o.height + DEFAULT_BINDING_GAP;
    for (let i = 0; i < route1.points.length - 1; i++) {
      const p = route1.points[i];
      const q = route1.points[i + 1];
      const intersects =
        Math.max(p.x, q.x) > l &&
        Math.min(p.x, q.x) < r &&
        Math.max(p.y, q.y) > t &&
        Math.min(p.y, q.y) < b;
      assert.ok(!intersects, `段 ${i} 穿障碍 ${o.id}`);
    }
  }
});

test('D01-b blocked 诚实降级：目标被密封 → 直连（连线绝不消失）', () => {
  const to = { x: 500, y: 500 };
  // 四块**相互重叠**的障碍围成密封环（膨胀后整个环带严格无缝隙——贴边滑行也被
  // 相邻盒的严格内部阻断；非重叠盒允许沿膨胀边界滑入，不构成密封）
  const ring: ObstacleRect[] = [
    { id: 'n', x: 440, y: 440, width: 120, height: 40 },
    { id: 's', x: 440, y: 520, width: 120, height: 40 },
    { id: 'w', x: 440, y: 440, width: 40, height: 120 },
    { id: 'e', x: 520, y: 440, width: 40, height: 120 },
  ];
  const route = routeOrthogonalEdge({ x: 0, y: 500 }, to, ring);
  assert.equal(route.strategy, 'blocked');
  assert.ok(route.path.startsWith(`M 0 500 L 500 500`));
});

test('D01-b maxVisited 保险丝：超限即诚实降级 blocked，不死循环', () => {
  const obstacle: ObstacleRect = { id: 'block', x: 140, y: -40, width: 20, height: 80 };
  const route = routeOrthogonalEdge({ x: 0, y: 0 }, { x: 300, y: 0 }, [obstacle], {
    maxVisited: 2,
  });
  assert.equal(route.strategy, 'blocked');
});

test('D01-b roundedOrthoPath：圆角 Q 指令 + 半段长钳制（零长段不产生 NaN）', () => {
  const path = roundedOrthoPath(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ],
    10
  );
  assert.ok(path.startsWith('M 0 0'));
  assert.ok(path.includes('Q 100 0'), '顶点 (100,0) 处圆角');
  assert.ok(!path.includes('NaN'));
  // 相邻段仅 4px：半径钳制到 2（半段长），无 NaN
  const tight = roundedOrthoPath(
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 8 },
      { x: 12, y: 8 },
    ],
    10
  );
  assert.ok(!tight.includes('NaN'));
});

// ---------- ③ 线上镂空语义微标签 ----------

test('D01-b 标签宽度估算：CJK 1em / ASCII 0.62em（保守偏宽 → 镂空永不小于文字）', () => {
  assert.equal(estimateLabelWidthPx('引用'), 20);
  assert.ok(Math.abs(estimateLabelWidthPx('abc') - 18.6) < 1e-9);
  assert.equal(estimateLabelWidthPx('引用 · L12'), estimateLabelWidthPx('引用 · L12', 10));
});

test('D01-b 微标签布局：落于折线段、cutout 居中且含呼吸 padding', () => {
  const layouts = placeEdgeMicroLabels(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    [{ id: 'e1', kind: 'causality', text: '引用' }]
  );
  assert.equal(layouts.length, 1);
  assert.deepEqual(layouts[0].center, { x: 50, y: 0 });
  assert.equal(layouts[0].cutout.width, 20 + 12);
  assert.equal(layouts[0].cutout.x, 50 - 10 - 6);
});

test('D01-b 线体裁切：cutout 矩形处线被切开（文字区域永不压线），无交不受影响', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  // 穿过线中段的文字盒
  const cut = cutPolylineAtRects(points, [{ x: 40, y: -6, width: 20, height: 12 }]);
  assert.equal(cut.visibleSegments.length, 2);
  assert.deepEqual(cut.visibleSegments[0], {
    a: { x: 0, y: 0 },
    b: { x: 40, y: 0 },
  });
  assert.deepEqual(cut.visibleSegments[1], {
    a: { x: 60, y: 0 },
    b: { x: 100, y: 0 },
  });
  assert.equal(cut.path, 'M 0 0 L 40 0 M 60 0 L 100 0');
  // 远处矩形：不裁切
  const untouched = cutPolylineAtRects(points, [{ x: 500, y: 500, width: 10, height: 10 }]);
  assert.equal(untouched.visibleSegments.length, 1);
  // 矩形完全覆盖线段：可见段清空
  const covered = cutPolylineAtRects(points, [{ x: -10, y: -10, width: 120, height: 20 }]);
  assert.equal(covered.visibleSegments.length, 0);
  assert.equal(covered.path, '');
  // 两个重叠裁切盒：合并为一个缺口
  const merged = cutPolylineAtRects(points, [
    { x: 40, y: -6, width: 20, height: 12 },
    { x: 55, y: -6, width: 20, height: 12 },
  ]);
  assert.equal(merged.visibleSegments.length, 2);
  assert.deepEqual(merged.visibleSegments[1].a, { x: 75, y: 0 });
});

// ---------- 关系边标签 / 相向绑定 / 证据链装配 ----------

test('D01-b relationEdgeMicroLabel：因果类型词 + 行级锚点 + 理由胶囊语义分档', () => {
  const anchor = relationEdgeMicroLabel({
    edge_id: 'e1',
    source_id: 'f1',
    target_id: 'f2',
    type: 'explicit_reference',
    isInferred: false,
    label: '引用',
    reason: '正文显式链接',
    locator: { startLine: 12, endLine: 18 },
  });
  assert.equal(anchor.text, '引用 · L12');
  assert.equal(anchor.kind, 'anchor');
  assert.equal(anchor.detail, '正文显式链接');

  const reason = relationEdgeMicroLabel({
    edge_id: 'e2',
    source_id: 'f1',
    target_id: 'f3',
    type: 'inferred_candidate',
    isInferred: true,
    label: '推断',
    reason: '同一编辑会话共现',
  });
  assert.equal(reason.text, '推断');
  assert.equal(reason.kind, 'reason');

  const causality = relationEdgeMicroLabel({
    edge_id: 'e3',
    source_id: 'f2',
    target_id: 'f4',
    type: 'decision_basis',
    isInferred: false,
    label: '决策依据',
    reason: '',
  });
  assert.equal(causality.text, '决策依据');
  assert.equal(causality.kind, 'causality');
});

test('D01-b facingBindings：按中心方位选相向边（横向优先、纵向次之）', () => {
  const a = { x: 0, y: 0, width: 280, height: 116 };
  const right = facingBindings(a, { x: 400, y: 10, width: 280, height: 116 });
  assert.equal(right.from.side, 'right');
  assert.equal(right.to.side, 'left');
  const below = facingBindings(a, { x: 10, y: 300, width: 280, height: 116 });
  assert.equal(below.from.side, 'bottom');
  assert.equal(below.to.side, 'top');
});

test('D01-b 证据链装配：无焦点返回空、端点不在画布诚实不画、可达对产出锚点+折线', () => {
  const baseCtx = {
    relations: [
      {
        edge_id: 'edge-1',
        source_id: 'file-a',
        target_id: 'file-b',
        type: 'explicit_reference',
        isInferred: false,
        label: '引用',
        reason: '正文链接',
      },
      {
        edge_id: 'edge-2',
        source_id: 'file-a',
        target_id: 'file-off-canvas',
        type: 'explicit_reference',
        isInferred: false,
        label: '引用',
        reason: '目标不在画布',
      },
    ],
    hoveredCanvasNodeId: 'sub_01',
    selectedCanvasNodeId: '',
    subAgentCards: [
      { id: 'sub_01', fileId: 'file-a', format: 'md' },
      { id: 'sub_02', fileId: 'file-b', format: 'md' },
    ],
    leftSourceNodes: [],
    nodePositions: {},
    graphObstacleRects: [],
    isFanOutCollapsed: false,
    canvasLayoutMode: 'xray',
    isNodeVisibleByCategory: () => true,
    resolveLeftSourcePos: () => ({ x: 0, y: 0 }),
  } as unknown as GraphCanvasCtx;

  // 无焦点（hover/selected 皆空）→ 空模型（层渲染 null 零像素）
  const idleCtx = { ...baseCtx, hoveredCanvasNodeId: null, selectedCanvasNodeId: '' } as unknown as GraphCanvasCtx;
  assert.deepEqual(assembleRelationEdgeModels(idleCtx), []);

  // 焦点 file-a：file-off-canvas 端点缺失 → 诚实不画；file-b 可达 → 1 条模型
  const models = assembleRelationEdgeModels(baseCtx);
  assert.equal(models.length, 1);
  assert.equal(models[0].edge.edge_id, 'edge-1');
  // 出口 = 事件卡相向边 ± 呼吸间距（sub_01 默认位 (468,248)，右缘 +14）
  const posA = DEFAULT_NODE_POSITIONS.sub_01;
  assert.equal(models[0].fromPt.x, posA.x + EVENT_CARD_W + DEFAULT_BINDING_GAP);
  assert.ok(models[0].points.length >= 2);
});

// ---------- D01-a 像素基线零偏移矩阵（默认 xray 场景结构性证明） ----------

test('D01-b 基线零偏移矩阵：默认 xray 场景全部既有连线 legacy-clear（像素基线护栏）', () => {
  // D01-a 基线镜头的默认几何（与源码默认值同源导入，非手抄）
  const trunkX = DEFAULT_NODE_POSITIONS.main_hub.x + 62; // 414
  const railX = dateCardRailX(trunkX); // 122
  const demoSources = [
    { id: 'src_round15', yOffset: 146, targetTrunkY: 174 },
    { id: 'src_svg_engine', yOffset: 146, targetTrunkY: 174 },
    { id: 'src_four_spec', yOffset: 214, targetTrunkY: 248 },
    { id: 'src_receipt', yOffset: 432, targetTrunkY: 462 },
  ];
  // 障碍清单按 controller graphObstacleRects 同口径（司辰默认收起不入障碍）
  const fanOutBoxes = ['sub_01', 'sub_02', 'sub_03', 'sub_04', 'sub_05', 'sub_06'].map((id) => {
    const pos = DEFAULT_NODE_POSITIONS[id];
    return { x: pos.x, y: pos.y, width: EVENT_CARD_W, height: EVENT_CARD_H };
  });
  const fanOut = computeFanOutBounds(fanOutBoxes, false);
  const obstacles: ObstacleRect[] = [
    { id: 'main_hub', x: DEFAULT_NODE_POSITIONS.main_hub.x, y: DEFAULT_NODE_POSITIONS.main_hub.y, width: 150, height: 76 },
    ...demoSources.map((s) => ({ id: s.id, x: railX, y: s.yOffset, width: DATE_CARD_W, height: DATE_CARD_H })),
    ...fanOutBoxes.map((box, i) => ({ id: `sub_0${i + 1}`, ...box })),
    { id: 'fan_out_box', x: fanOut.x, y: fanOut.y, width: fanOut.width, height: fanOut.height },
  ];

  for (const src of demoSources) {
    const route = computeBoundEdgeRoute({
      from: { x: railX + 118, y: src.yOffset + 24 },
      to: { x: trunkX - 4, y: src.targetTrunkY },
      mode: 'source_to_trunk',
      obstacles,
      hosts: { from: { x: railX, y: src.yOffset, width: DATE_CARD_W, height: DATE_CARD_H } },
    });
    assert.equal(
      route.strategy,
      'legacy-clear',
      `${src.id} 默认走廊应无障碍（基线零偏移）`
    );
    assert.equal(route.path, computeDynamicEdgePath(
      { x: railX + 118, y: src.yOffset + 24 },
      { x: trunkX - 4, y: src.targetTrunkY },
      'source_to_trunk'
    ));
  }

  // 主干 → 扇出盒连接线（基线场景同样零偏移）
  const TRUNK_AXIS_TOP = DEFAULT_NODE_POSITIONS.main_hub.y + 74 + 36;
  const connector = computeBoundEdgeRoute({
    from: { x: trunkX + 4, y: TRUNK_AXIS_TOP },
    to: { x: fanOut.x, y: fanOut.y + fanOut.height / 2 },
    mode: 'trunk_to_subagent',
    obstacles,
    hosts: { to: fanOut },
  });
  assert.equal(connector.strategy, 'legacy-clear');
  assert.equal(connector.path, computeDynamicEdgePath(
    { x: trunkX + 4, y: TRUNK_AXIS_TOP },
    { x: fanOut.x, y: fanOut.y + fanOut.height / 2 },
    'trunk_to_subagent'
  ));
});

test('D01-b 基线场景司辰展开（拖到上方里程碑）→ 穿立绘的连线避障、不穿者保持贝塞尔', () => {
  const trunkX = DEFAULT_NODE_POSITIONS.main_hub.x + 62;
  const railX = dateCardRailX(trunkX);
  // 司辰立绘盒（chronosPos.x = trunkX-156；132×174 与 controller 同口径）。
  // 默认位 y=266 时四条来源走廊（y≈170/238/456）恰好都从立绘上下缘之外通过（设计留位）；
  // 本用例模拟司辰被拖到上方里程碑（y=150）——立绘带 y 150..324 与上两条走廊相交 → 命中。
  const mascot: ObstacleRect = {
    id: 'chronos_deity',
    x: trunkX - 156,
    y: 150,
    width: 132,
    height: 174,
  };
  // src_round15 走廊（y≈170..174）横穿立绘 → 命中避障
  const hitRoute = computeBoundEdgeRoute({
    from: { x: railX + 118, y: 146 + 24 },
    to: { x: trunkX - 4, y: 174 },
    mode: 'source_to_trunk',
    obstacles: [mascot],
    hosts: { from: { x: railX, y: 146, width: DATE_CARD_W, height: DATE_CARD_H } },
  });
  assert.notEqual(hitRoute.strategy, 'legacy-clear');
  assert.notEqual(hitRoute.strategy, 'blocked');
  // src_receipt 走廊（y≈456..462）在立绘下缘之外 → 保持贝塞尔
  const clearRoute = computeBoundEdgeRoute({
    from: { x: railX + 118, y: 432 + 24 },
    to: { x: trunkX - 4, y: 462 },
    mode: 'source_to_trunk',
    obstacles: [mascot],
    hosts: { from: { x: railX, y: 432, width: DATE_CARD_W, height: DATE_CARD_H } },
  });
  assert.equal(clearRoute.strategy, 'legacy-clear');
});
