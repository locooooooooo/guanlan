/**
 * D01-b · 比例锚点绑定与正交避障连线引擎（任务卡 D01 阶段 b）。
 *
 * 在 D01-a 拆出的纯函数几何层（geometry.ts）旁边落地的第二块纯函数几何引擎：
 * 零 React / 零 DOM 依赖、确定性（同输入恒同输出）、全部可单测。三大能力：
 *  ① 归一化比例锚点绑定（FixedPointBinding + bindingGap 呼吸间距）——
 *    连线出口/端点以 0..1 比例绑定宿主卡片矩形，卡片移动/展开/缩放时重算即自动跟随；
 *  ② 稀疏非均匀网格 A* 正交圆角避障路由——直线 → 单拐 L → 双拐 Z → A* 分层择优
 *    （最少拐点启发 = bendPenalty 权重），自动绕开卡片本体；网格线取自障碍膨胀边界
 *    与起终点坐标（非均匀、稀疏），探索量有保险丝；
 *  ③ 线上镂空语义微标签——标签放在路由折线段上，对文字包围盒做线体裁切
 *    （cutout 永不重叠：文字区域处的线被切开）。
 *
 * 兼容纪律（D01-a 像素基线护栏）：走廊无障碍时逐字节返回
 * guanlanEngine.computeDynamicEdgePath 的既有贝塞尔（test/d01b-edge-routing.test.ts
 * 的「基线场景零偏移矩阵」单测锁定）。命中障碍才升级为绑定锚点 + 避障路由。
 *
 * 与 guanlanEngine 的依赖方向保持 components → utils（同 geometry.ts 先例），
 * 绝不反向；guanlanEngine 本文件零改动（该文件历史遗留字面 NUL 字节使 Read/Edit
 * 工具链按二进制拒绝——本引擎因此落位 components/graph/，交接台账已登记）。
 */

import { computeDynamicEdgePath } from '../../utils/guanlanEngine';

// ================= 公共几何原语 =================

export interface RoutePt {
  x: number;
  y: number;
}

export interface HostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObstacleRect extends HostRect {
  /** 调试/ exclusion 用 id（引擎按几何判定，不依赖 id） */
  id?: string;
}

/** 闭式包围盒（左/右/上/下），内部几何运算统一表示 */
interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

function boxOf(rect: HostRect): Box {
  return {
    l: rect.x,
    r: rect.x + rect.width,
    t: rect.y,
    b: rect.y + rect.height,
  };
}

function inflateBox(box: Box, m: number): Box {
  return { l: box.l - m, r: box.r + m, t: box.t - m, b: box.b + m };
}

/** 点是否落在（按 margin 膨胀后的）矩形内——闭式判定，用于端点宿主排除 */
function rectContainsPoint(rect: HostRect, p: RoutePt, margin: number): boolean {
  return (
    p.x >= rect.x - margin &&
    p.x <= rect.x + rect.width + margin &&
    p.y >= rect.y - margin &&
    p.y <= rect.y + rect.height + margin
  );
}

/** 点是否严格落在盒内部（边界不算）——网格节点/贝塞尔采样的阻断判定：
 *  恰好贴膨胀边界 = 允许「贴边呼吸」，浮点值全部来自同一批边界常量的精确拷贝，
 *  严格比较跨平台确定。 */
function pointStrictlyInside(box: Box, p: RoutePt): boolean {
  return p.x > box.l && p.x < box.r && p.y > box.t && p.y < box.b;
}

/** 水平线段 (x1..x2 @ y) 是否与任一盒严格相交（贴边不阻断） */
function hSegClear(x1: number, x2: number, y: number, boxes: Box[]): boolean {
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  for (const box of boxes) {
    if (y > box.t && y < box.b && hi > box.l && lo < box.r) return false;
  }
  return true;
}

/** 垂直线段 (y1..y2 @ x) 是否与任一盒严格相交（贴边不阻断） */
function vSegClear(y1: number, y2: number, x: number, boxes: Box[]): boolean {
  const lo = Math.min(y1, y2);
  const hi = Math.max(y1, y2);
  for (const box of boxes) {
    if (x > box.l && x < box.r && hi > box.t && lo < box.b) return false;
  }
  return true;
}

// ================= ① FixedPointBinding：归一化比例锚点绑定 =================

/** 出线边（宿主矩形哪条边出线，锚点沿该边法线外推呼吸间距） */
export type AnchorSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * 归一化比例锚点绑定：fx/fy ∈ [0,1] 是沿宿主矩形宽/高的相对位置（side 决定读哪个分量）。
 * 宿主矩形随卡片移动/展开/缩放变化时，用同一 binding 重算即得新锚点——
 * 结构上保证「绑定连线 100% 实时跟随不脱钩」（渲染期纯派生，无缓存态可脱钩）。
 */
export interface FixedPointBinding {
  fx: number;
  fy: number;
  side: AnchorSide;
}

/** 呼吸间距默认值（px）：出/入点与卡片本体边缘的恒定净距 */
export const DEFAULT_BINDING_GAP = 14;

/** 非法输入钳回 [0,1]：NaN 取中点 0.5（诚实中性，不炸渲染）；±∞ 取对应端点 */
export function clampUnit(v: number): number {
  if (Number.isNaN(v)) return 0.5;
  if (v === Number.POSITIVE_INFINITY) return 1;
  if (v === Number.NEGATIVE_INFINITY) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 绑定边上的出口点（呼吸间距外推前的边上落点） */
export function bindingExitPoint(rect: HostRect, binding: FixedPointBinding): RoutePt {
  const fx = clampUnit(binding.fx);
  const fy = clampUnit(binding.fy);
  switch (binding.side) {
    case 'left':
      return { x: rect.x, y: rect.y + fy * rect.height };
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + fy * rect.height };
    case 'top':
      return { x: rect.x + fx * rect.width, y: rect.y };
    case 'bottom':
      return { x: rect.x + fx * rect.width, y: rect.y + rect.height };
  }
}

/** 绑定锚点 = 出口沿 side 法线外推 bindingGap（呼吸间距）。
 *  gap ≤ 0 退化为贴边出口（边界情形由单测锁定）。 */
export function resolveBindingAnchor(
  rect: HostRect,
  binding: FixedPointBinding,
  gap: number = DEFAULT_BINDING_GAP
): RoutePt {
  const exit = bindingExitPoint(rect, binding);
  const g = Number.isFinite(gap) && gap > 0 ? gap : 0;
  switch (binding.side) {
    case 'left':
      return { x: exit.x - g, y: exit.y };
    case 'right':
      return { x: exit.x + g, y: exit.y };
    case 'top':
      return { x: exit.x, y: exit.y - g };
    case 'bottom':
      return { x: exit.x, y: exit.y + g };
  }
}

/** 便捷派生：由「指向宿主的旧绝对出口点」推导归一化绑定——取宿主四边中最近者作为
 *  side，绝对点投影为该边上的 0..1 比例（迁移既有调用点的桥梁）。 */
export function bindingFromLegacyPoint(rect: HostRect, pt: RoutePt): FixedPointBinding {
  const dl = pt.x - rect.x;
  const dr = rect.x + rect.width - pt.x;
  const dt = pt.y - rect.y;
  const db = rect.y + rect.height - pt.y;
  const minDist = Math.min(dl, dr, dt, db);
  // 并列时按 left < right < top < bottom 固定序取边（确定性）
  let side: AnchorSide;
  if (minDist === dl) side = 'left';
  else if (minDist === dr) side = 'right';
  else if (minDist === dt) side = 'top';
  else side = 'bottom';
  if (side === 'left' || side === 'right') {
    return { fx: 0.5, fy: clampUnit(rect.height > 0 ? (pt.y - rect.y) / rect.height : 0.5), side };
  }
  return { fx: clampUnit(rect.width > 0 ? (pt.x - rect.x) / rect.width : 0.5), fy: 0.5, side };
}

// ================= ② 正交圆角避障路由 =================

export interface OrthoRouteOptions {
  /** 障碍膨胀净距（呼吸），默认 = DEFAULT_BINDING_GAP */
  clearance?: number;
  /** 转角圆角半径（px），默认 10；实际半径钳制 ≤ 相邻半段长 */
  cornerRadius?: number;
  /** 每拐点代价（最少拐点启发权重），默认 24 */
  bendPenalty?: number;
  /** A* 出堆节点数保险丝，默认 4096；超限诚实降级 blocked 直连 */
  maxVisited?: number;
}

export type EdgeRouteStrategy =
  | 'legacy-clear' // 走廊无障碍 → 既有贝塞尔逐字节保留（D01-a 像素零偏移）
  | 'straight' // 正交直线无障碍
  | 'one-bend' // 单拐 L 形
  | 'two-bend' // 双拐 Z 形
  | 'astar' // 稀疏非均匀网格 A* 绕行
  | 'blocked'; // 目标被密封/保险丝超限 → 诚实直连（连线绝不消失）

export interface OrthoRoute {
  points: RoutePt[];
  path: string;
  bends: number;
  strategy: EdgeRouteStrategy;
}

/** 定数格式化：先舍入到 2 位小数再输出——同输入恒同字符串（跨平台确定性） */
function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function dist(a: RoutePt, b: RoutePt): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 折线 → 圆角正交 path：内部顶点按 r = min(radius, 相邻半段长) 用 Q 圆角 */
export function roundedOrthoPath(points: RoutePt[], radius: number = 10): string {
  if (points.length < 2) return '';
  let d = `M ${fmtNum(points[0].x)} ${fmtNum(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const inLen = dist(prev, cur);
    const outLen = dist(cur, next);
    const r = Math.max(0, Math.min(radius, inLen / 2, outLen / 2));
    if (r === 0) {
      d += ` L ${fmtNum(cur.x)} ${fmtNum(cur.y)}`;
      continue;
    }
    const p1 = {
      x: cur.x + ((prev.x - cur.x) / inLen) * r,
      y: cur.y + ((prev.y - cur.y) / inLen) * r,
    };
    const p2 = {
      x: cur.x + ((next.x - cur.x) / outLen) * r,
      y: cur.y + ((next.y - cur.y) / outLen) * r,
    };
    d += ` L ${fmtNum(p1.x)} ${fmtNum(p1.y)} Q ${fmtNum(cur.x)} ${fmtNum(cur.y)} ${fmtNum(
      p2.x
    )} ${fmtNum(p2.y)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${fmtNum(last.x)} ${fmtNum(last.y)}`;
  return d;
}

function compressCollinear(points: RoutePt[]): RoutePt[] {
  // 先去重（L/Z 候选在端点共轴时会产生零长段 → 重复点），再做共线压缩
  const dedup: RoutePt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = dedup[dedup.length - 1];
    if (points[i].x !== last.x || points[i].y !== last.y) dedup.push(points[i]);
  }
  if (dedup.length <= 2) return dedup;
  const out: RoutePt[] = [dedup[0]];
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = out[out.length - 1];
    const b = dedup[i];
    const c = dedup[i + 1];
    const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    if (!collinear) out.push(b);
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

interface RouteContext {
  boxes: Box[];
}

function lShapePoints(from: RoutePt, to: RoutePt, verticalFirst: boolean): RoutePt[] {
  const corner = verticalFirst ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
  return [from, corner, to];
}

function segmentsClear(points: RoutePt[], boxes: Box[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.x === b.x) {
      if (!vSegClear(a.y, b.y, a.x, boxes)) return false;
    } else if (a.y === b.y) {
      if (!hSegClear(a.x, b.x, a.y, boxes)) return false;
    } else {
      return false; // 非正交段不该出现在这里
    }
  }
  return true;
}

/** 稀疏非均匀网格 A*：网格线 = 障碍膨胀边界 + 起终点坐标（去重排序，无固定步长）；
 *  代价 = 段长 + bendPenalty×拐点，启发 = 剩余曼哈顿距离（可采纳）；
 *  出堆节点数超保险丝 → null（调用方落 blocked 直连）。 */
function astarRoute(
  from: RoutePt,
  to: RoutePt,
  obstacles: HostRect[],
  opts: Required<OrthoRouteOptions>,
  ctx: RouteContext
): RoutePt[] | null {
  const xsSet = new Set<number>([from.x, to.x]);
  const ysSet = new Set<number>([from.y, to.y]);
  for (const o of obstacles) {
    const box = inflateBox(boxOf(o), opts.clearance);
    xsSet.add(box.l);
    xsSet.add(box.r);
    ysSet.add(box.t);
    ysSet.add(box.b);
  }
  const xs = Array.from(xsSet).sort((a, b) => a - b);
  const ys = Array.from(ysSet).sort((a, b) => a - b);
  const xi = (v: number) => xs.indexOf(v);
  const yi = (v: number) => ys.indexOf(v);
  const si = { i: xi(from.x), j: yi(from.y) };
  const ti = { i: xi(to.x), j: yi(to.y) };
  if (si.i < 0 || si.j < 0 || ti.i < 0 || ti.j < 0) return null;

  const blocked: boolean[] = new Array(xs.length * ys.length).fill(false);
  const boxes = ctx.boxes;
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length; i++) {
      const p = { x: xs[i], y: ys[j] };
      if (boxes.some((box) => pointStrictlyInside(box, p))) {
        blocked[j * xs.length + i] = true;
      }
    }
  }
  const keyOf = (i: number, j: number) => j * xs.length + i;
  // 端点节点恒自由（宿主障碍已在调用方剔除；防御性兜底）
  blocked[keyOf(si.i, si.j)] = false;
  blocked[keyOf(ti.i, ti.j)] = false;

  // 二叉最小堆（f, h, seq 字典序全确定）
  const heap: Array<{ f: number; h: number; seq: number; i: number; j: number; g: number }> = [];
  const swap = (a: number, b: number) => {
    const t = heap[a];
    heap[a] = heap[b];
    heap[b] = t;
  };
  const push = (node: { f: number; h: number; seq: number; i: number; j: number; g: number }) => {
    heap.push(node);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      const pc = heap[p];
      const cc = heap[c];
      if (pc.f < cc.f || (pc.f === cc.f && pc.h < cc.h) || (pc.f === cc.f && pc.h === cc.h && pc.seq < cc.seq)) {
        break;
      }
      swap(p, c);
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        const better = (a: number, b: number) => {
          const A = heap[a];
          const B = heap[b];
          return A.f < B.f || (A.f === B.f && A.h < B.h) || (A.f === B.f && A.h === B.h && A.seq < B.seq);
        };
        if (l < heap.length && better(l, m)) m = l;
        if (r < heap.length && better(r, m)) m = r;
        if (m === p) break;
        swap(p, m);
        p = m;
      }
    }
    return top;
  };

  const bestG = new Map<number, number>();
  const parent = new Map<number, number>();
  let seq = 0;
  const hEstimate = (i: number, j: number) =>
    Math.abs(xs[i] - xs[ti.i]) + Math.abs(ys[j] - ys[ti.j]);
  push({ f: hEstimate(si.i, si.j), h: hEstimate(si.i, si.j), seq: seq++, i: si.i, j: si.j, g: 0 });
  bestG.set(keyOf(si.i, si.j), 0);

  let visited = 0;
  const goalKey = keyOf(ti.i, ti.j);
  while (heap.length > 0) {
    const cur = pop();
    const ck = keyOf(cur.i, cur.j);
    if (ck === goalKey) {
      // 回溯
      const pts: RoutePt[] = [];
      let k: number | undefined = ck;
      while (k !== undefined) {
        pts.push({ x: xs[k % xs.length], y: ys[Math.floor(k / xs.length)] });
        k = parent.get(k);
      }
      pts.reverse();
      return compressCollinear(pts);
    }
    visited++;
    if (visited > opts.maxVisited) return null;
    const g0 = bestG.get(ck)!;
    if (g0 < cur.g) continue; // 已有更优路径
    const prevKey = parent.get(ck);
    const inDir =
      prevKey === undefined
        ? null
        : ({
            dx: Math.sign(xs[cur.i] - xs[prevKey % xs.length]),
            dy: Math.sign(ys[cur.j] - ys[Math.floor(prevKey / xs.length)]),
          } as const);
    const relax = (ni: number, nj: number) => {
      if (ni < 0 || ni >= xs.length || nj < 0 || nj >= ys.length) return;
      const nk = keyOf(ni, nj);
      if (blocked[nk]) return;
      const np = { x: xs[ni], y: ys[nj] };
      const cp = { x: xs[cur.i], y: ys[cur.j] };
      const segClear =
        cp.x === np.x
          ? vSegClear(cp.y, np.y, cp.x, boxes)
          : hSegClear(cp.x, np.x, cp.y, boxes);
      if (!segClear) return;
      // 拐点判定：出段方向与入段方向不同轴（最少拐点启发 = bendPenalty 权重）
      const outDx = Math.sign(np.x - cp.x);
      const outDy = Math.sign(np.y - cp.y);
      const isTurn = inDir !== null && (outDx !== inDir.dx || outDy !== inDir.dy);
      const ng = cur.g + dist(cp, np) + (isTurn ? opts.bendPenalty : 0);
      const old = bestG.get(nk);
      if (old === undefined || ng < old) {
        bestG.set(nk, ng);
        parent.set(nk, ck);
        push({ f: ng + hEstimate(ni, nj), h: hEstimate(ni, nj), seq: seq++, i: ni, j: nj, g: ng });
      }
    };
    relax(cur.i - 1, cur.j);
    relax(cur.i + 1, cur.j);
    relax(cur.i, cur.j - 1);
    relax(cur.i, cur.j + 1);
  }
  return null;
}

/** 正交避障路由主入口：直线 → 单拐 L（两候选）→ 双拐 Z（障碍边界中线上枚举）→
 *  稀疏网格 A* → blocked 诚实直连。全链确定性。 */
export function routeOrthogonalEdge(
  from: RoutePt,
  to: RoutePt,
  obstacles: ObstacleRect[],
  opts?: OrthoRouteOptions
): OrthoRoute {
  const full: Required<OrthoRouteOptions> = {
    clearance: opts?.clearance ?? DEFAULT_BINDING_GAP,
    cornerRadius: opts?.cornerRadius ?? 10,
    bendPenalty: opts?.bendPenalty ?? 24,
    maxVisited: opts?.maxVisited ?? 4096,
  };
  // 退化与无效障碍过滤（零尺寸/非有限值不参与阻断）
  const obstaclesClean = obstacles.filter(
    (o) =>
      Number.isFinite(o.x) &&
      Number.isFinite(o.y) &&
      Number.isFinite(o.width) &&
      Number.isFinite(o.height) &&
      o.width > 0 &&
      o.height > 0
  );
  const boxes = obstaclesClean.map((o) => inflateBox(boxOf(o), full.clearance));
  const ctx: RouteContext = { boxes };

  // L0 直线
  if (from.x === to.x && vSegClear(from.y, to.y, from.x, boxes)) {
    const points = [from, to];
    return {
      points,
      path: roundedOrthoPath(points, full.cornerRadius),
      bends: 0,
      strategy: 'straight',
    };
  }
  if (from.y === to.y && hSegClear(from.x, to.x, from.y, boxes)) {
    const points = [from, to];
    return {
      points,
      path: roundedOrthoPath(points, full.cornerRadius),
      bends: 0,
      strategy: 'straight',
    };
  }

  // L1 单拐 L 形：两候选（先纵后横 / 先横后纵），皆通畅取更短（并列取先试者）
  const lCandidates: Array<{ pts: RoutePt[]; verticalFirst: boolean }> = [
    { pts: lShapePoints(from, to, true), verticalFirst: true },
    { pts: lShapePoints(from, to, false), verticalFirst: false },
  ];
  let bestL: { pts: RoutePt[]; len: number } | null = null;
  for (const cand of lCandidates) {
    if (!segmentsClear(cand.pts, boxes)) continue;
    const len = dist(cand.pts[0], cand.pts[1]) + dist(cand.pts[1], cand.pts[2]);
    if (!bestL || len < bestL.len) bestL = { pts: cand.pts, len };
  }
  if (bestL) {
    return {
      points: bestL.pts,
      path: roundedOrthoPath(bestL.pts, full.cornerRadius),
      bends: 1,
      strategy: 'one-bend',
    };
  }

  // L2 双拐 Z 形：中线候选 = 障碍膨胀边界 + 起终点中点，限于起终点坐标带内；
  // 按离中点距离排序（并列按值），收集通畅候选取最短（并列取枚举序首位）
  const midCandidates: Array<{ m: number; verticalMid: boolean }> = [];
  const xMid = (from.x + to.x) / 2;
  const yMid = (from.y + to.y) / 2;
  for (const box of boxes) {
    if (box.l > Math.min(from.x, to.x) && box.l < Math.max(from.x, to.x)) {
      midCandidates.push({ m: box.l, verticalMid: true });
    }
    if (box.r > Math.min(from.x, to.x) && box.r < Math.max(from.x, to.x)) {
      midCandidates.push({ m: box.r, verticalMid: true });
    }
    if (box.t > Math.min(from.y, to.y) && box.t < Math.max(from.y, to.y)) {
      midCandidates.push({ m: box.t, verticalMid: false });
    }
    if (box.b > Math.min(from.y, to.y) && box.b < Math.max(from.y, to.y)) {
      midCandidates.push({ m: box.b, verticalMid: false });
    }
  }
  midCandidates.push({ m: xMid, verticalMid: true });
  midCandidates.push({ m: yMid, verticalMid: false });
  midCandidates.sort((a, b) => {
    const da = Math.abs(a.m - (a.verticalMid ? xMid : yMid));
    const db = Math.abs(b.m - (b.verticalMid ? xMid : yMid));
    if (da !== db) return da - db;
    if (a.verticalMid !== b.verticalMid) return a.verticalMid ? -1 : 1;
    return a.m - b.m;
  });
  let bestZ: { pts: RoutePt[]; len: number } | null = null;
  for (const cand of midCandidates) {
    const pts = cand.verticalMid
      ? [from, { x: cand.m, y: from.y }, { x: cand.m, y: to.y }, to]
      : [from, { x: from.x, y: cand.m }, { x: to.x, y: cand.m }, to];
    if (!segmentsClear(pts, boxes)) continue;
    const len =
      dist(pts[0], pts[1]) + dist(pts[1], pts[2]) + dist(pts[2], pts[3]);
    if (!bestZ || len < bestZ.len) bestZ = { pts, len };
  }
  if (bestZ) {
    return {
      points: bestZ.pts,
      path: roundedOrthoPath(bestZ.pts, full.cornerRadius),
      bends: 2,
      strategy: 'two-bend',
    };
  }

  // L3 稀疏非均匀网格 A*
  const astar = astarRoute(from, to, obstaclesClean, full, ctx);
  if (astar) {
    return {
      points: astar,
      path: roundedOrthoPath(astar, full.cornerRadius),
      bends: Math.max(0, astar.length - 2),
      strategy: 'astar',
    };
  }

  // 诚实降级：目标被密封或保险丝超限 → 直连（连线绝不消失，与既有行为同语义）
  const points = [from, to];
  return {
    points,
    path: roundedOrthoPath(points, full.cornerRadius),
    bends: 0,
    strategy: 'blocked',
  };
}

// ================= 遗留贝塞尔走廊命中检测 =================

/** computeDynamicEdgePath 三种 mode 的输出恒为 `M x y C ...` 整数格式（Math.round），
 *  解析即得几何真值——控制点单一来源仍是 guanlanEngine，零复制零漂移。 */
const LEGACY_PATH_RE =
  /^M (-?\d+) (-?\d+) C (-?\d+) (-?\d+), (-?\d+) (-?\d+), (-?\d+) (-?\d+)$/;

/** 采样遗留贝塞尔走廊（确定性等步长采样）；解析失败返回 null（调用方保守保留遗留线） */
function sampleLegacyCorridor(
  from: RoutePt,
  to: RoutePt,
  mode: 'source_to_trunk' | 'trunk_to_subagent' | 'subagent_to_merge',
  steps: number
): RoutePt[] | null {
  const d = computeDynamicEdgePath(from, to, mode);
  const m = LEGACY_PATH_RE.exec(d);
  if (!m) return null;
  const p0 = { x: Number(m[1]), y: Number(m[2]) };
  const p1 = { x: Number(m[3]), y: Number(m[4]) };
  const p2 = { x: Number(m[5]), y: Number(m[6]) };
  const p3 = { x: Number(m[7]), y: Number(m[8]) };
  const pts: RoutePt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return pts;
}

/** 走廊采样密度（含端点，步数固定 → 同输入恒同判定） */
export const CORRIDOR_SAMPLES = 64;
/** 走廊命中余量（px）：覆盖线宽 + 抗锯齿呼吸，障碍贴着线走 2px 内才算真挡路 */
export const CORRIDOR_HIT_MARGIN = 2;

// ================= 升级版连线主入口 =================

export interface BoundEdgeArgs {
  from: RoutePt;
  to: RoutePt;
  mode: 'source_to_trunk' | 'trunk_to_subagent' | 'subagent_to_merge';
  /** 画布卡片本体障碍清单（宿主矩形由引擎自动按端点剔除，无需手工排除） */
  obstacles?: ObstacleRect[];
  /** 端点的绑定宿主矩形（提供且走廊命中时，出口/端点按绑定 + 呼吸间距重算） */
  hosts?: { from?: HostRect; to?: HostRect };
  /** 显式绑定（缺省时由宿主 + 旧出口点自动推导，bindingFromLegacyPoint） */
  binding?: { from?: FixedPointBinding; to?: FixedPointBinding };
  /** 呼吸间距（缺省 DEFAULT_BINDING_GAP） */
  bindingGap?: number;
  routeOptions?: OrthoRouteOptions;
}

export interface EdgeRoute {
  path: string;
  /** 命中障碍时为正交折线顶点（微标签/镂空裁切消费）；legacy-clear 时为 null */
  points: RoutePt[] | null;
  bends: number;
  strategy: EdgeRouteStrategy;
}

/**
 * 升级版连线：走廊无障碍 → 逐字节返回既有贝塞尔（D01-a 基线零偏移）；
 * 命中卡片本体 → 绑定锚点（呼吸间距）+ 正交圆角避障路由。
 */
/** 端点宿主剔除（公开口径，relation 直连路由与 computeBoundEdgeRoute 同用）：
 *  含端点（±margin 膨胀闭式判定）的障碍不参与阻断——端点本就贴在宿主边上。 */
export function filterHostObstacles(
  obstacles: ObstacleRect[],
  from: RoutePt,
  to: RoutePt,
  margin: number = CORRIDOR_HIT_MARGIN
): ObstacleRect[] {
  return obstacles.filter(
    (o) => !rectContainsPoint(o, from, margin) && !rectContainsPoint(o, to, margin)
  );
}

export function computeBoundEdgeRoute(args: BoundEdgeArgs): EdgeRoute {
  const { from, to, mode } = args;
  const legacyPath = computeDynamicEdgePath(from, to, mode);
  const blockers = filterHostObstacles(args.obstacles ?? [], from, to);
  if (blockers.length === 0) {
    return { path: legacyPath, points: null, bends: 0, strategy: 'legacy-clear' };
  }
  const samples = sampleLegacyCorridor(from, to, mode, CORRIDOR_SAMPLES);
  const inflated = blockers.map((o) => inflateBox(boxOf(o), CORRIDOR_HIT_MARGIN));
  const hit =
    samples !== null && samples.some((p) => inflated.some((box) => pointStrictlyInside(box, p)));
  if (!hit) {
    return { path: legacyPath, points: null, bends: 0, strategy: 'legacy-clear' };
  }
  // 命中：按绑定宿主 + 呼吸间距重算出口/端点（缺省绑定由旧出口点自动推导）。
  // 拥挤带自适应：重锚点若落在相邻障碍 clearance 膨胀区的严格内部（高密度邻域，
  // 例如卡片间隙 < 呼吸间距），该侧保留原端点——呼吸改由路由净距（clearance）保证，
  // 绝不让锚点困死在膨胀区里导致 blocked。
  const gap = args.bindingGap ?? DEFAULT_BINDING_GAP;
  const routeClearance = args.routeOptions?.clearance ?? DEFAULT_BINDING_GAP;
  const anchorCompromised = (p: RoutePt): boolean => {
    const boxes = blockers.map((o) => inflateBox(boxOf(o), routeClearance));
    return boxes.some((box) => pointStrictlyInside(box, p));
  };
  const from2Raw = args.hosts?.from
    ? resolveBindingAnchor(
        args.hosts.from,
        args.binding?.from ?? bindingFromLegacyPoint(args.hosts.from, from),
        gap
      )
    : from;
  const to2Raw = args.hosts?.to
    ? resolveBindingAnchor(
        args.hosts.to,
        args.binding?.to ?? bindingFromLegacyPoint(args.hosts.to, to),
        gap
      )
    : to;
  const from2 = anchorCompromised(from2Raw) ? from : from2Raw;
  const to2 = anchorCompromised(to2Raw) ? to : to2Raw;
  const blockers2 = filterHostObstacles(blockers, from2, to2);
  const route = routeOrthogonalEdge(from2, to2, blockers2, args.routeOptions);
  return {
    path: route.path,
    points: route.points,
    bends: route.bends,
    strategy: route.strategy,
  };
}

// ================= ③ 线上镂空语义微标签 =================

export type EdgeLabelKind = 'reason' | 'anchor' | 'causality';

export interface EdgeMicroLabel {
  id: string;
  kind: EdgeLabelKind;
  /** 常态克制短文本（如「引用 · L12」「决策依据」）；完整理由走 detail（悬停承载） */
  text: string;
  /** 悬停展开的完整理由（C01 理由胶囊 / 推断原因） */
  detail?: string;
}

export interface EdgeLabelLayout {
  label: EdgeMicroLabel;
  center: RoutePt;
  /** 需从线上镂空的文字包围盒（含呼吸 padding）——cutPolylineAtRects 消费 */
  cutout: HostRect;
  /** 标签落点的折线段序号（渲染定位用） */
  segmentIndex: number;
}

export const EDGE_LABEL_FONT_PX = 10;
export const EDGE_LABEL_CUTOUT_PAD_X = 6;
export const EDGE_LABEL_CUTOUT_PAD_Y = 3;

/** 标签文本宽度估算（px）：CJK/全角 1em、ASCII 0.62em（与 geometry.fanOutHeaderTextWidth
 *  同口径的保守估算——估算 ≥ 实际 → 镂空只会偏宽，文字永不压线） */
export function estimateLabelWidthPx(text: string, fontPx: number = EDGE_LABEL_FONT_PX): number {
  let units = 0;
  for (const ch of text) {
    units += ch.charCodeAt(0) > 0xff ? 1 : 0.62;
  }
  return units * fontPx;
}

/** 微标签布局：标签按「折线段长降序（并列按段序号）」分配到不同段；同段多标签按
 *  固定槽位 [0.5, 0.3, 0.7, 0.25, 0.75] 错开。确定性全链。 */
export function placeEdgeMicroLabels(
  points: RoutePt[],
  labels: EdgeMicroLabel[]
): EdgeLabelLayout[] {
  if (points.length < 2 || labels.length === 0) return [];
  const segs: Array<{ index: number; a: RoutePt; b: RoutePt; len: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = dist(a, b);
    if (len > 0) segs.push({ index: i, a, b, len });
  }
  if (segs.length === 0) return [];
  const order = [...segs].sort((s1, s2) => (s2.len !== s1.len ? s2.len - s1.len : s1.index - s2.index));
  const slots = [0.5, 0.3, 0.7, 0.25, 0.75];
  const perSegCount = new Map<number, number>();
  const layouts: EdgeLabelLayout[] = [];
  for (const label of labels) {
    const rank = layouts.length % order.length;
    const seg = order[rank];
    const m = perSegCount.get(seg.index) ?? 0;
    perSegCount.set(seg.index, m + 1);
    const t = slots[Math.min(m, slots.length - 1)];
    const center = {
      x: seg.a.x + (seg.b.x - seg.a.x) * t,
      y: seg.a.y + (seg.b.y - seg.a.y) * t,
    };
    const w = estimateLabelWidthPx(label.text);
    const h = EDGE_LABEL_FONT_PX + 2 * EDGE_LABEL_CUTOUT_PAD_Y;
    layouts.push({
      label,
      center,
      cutout: {
        x: center.x - w / 2 - EDGE_LABEL_CUTOUT_PAD_X,
        y: center.y - h / 2,
        width: w + 2 * EDGE_LABEL_CUTOUT_PAD_X,
        height: h,
      },
      segmentIndex: seg.index,
    });
  }
  return layouts;
}

export interface VisibleSegment {
  a: RoutePt;
  b: RoutePt;
}

export interface PolylineCutResult {
  visibleSegments: VisibleSegment[];
  path: string;
}

/**
 * 线体裁切：把折线中与任一镂空矩形**严格内部**相交的子段剔除——文字区域处线被切开，
 * 「cutout 永不重叠」。贴着矩形边界的线不算相交（浮点精确比较，跨平台确定）。
 */
export function cutPolylineAtRects(points: RoutePt[], rects: HostRect[]): PolylineCutResult {
  const boxes = rects.map(boxOf);
  const visibleSegments: VisibleSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.abs(dx) + Math.abs(dy);
    if (len === 0) continue;
    const cuts: Array<[number, number]> = [];
    for (const box of boxes) {
      if (dy === 0) {
        // 水平段
        if (a.y > box.t && a.y < box.b) {
          let t0 = (box.l - a.x) / dx;
          let t1 = (box.r - a.x) / dx;
          if (t0 > t1) [t0, t1] = [t1, t0];
          const lo = Math.max(0, t0);
          const hi = Math.min(1, t1);
          if (lo < hi) cuts.push([lo, hi]);
        }
      } else if (dx === 0) {
        // 垂直段
        if (a.x > box.l && a.x < box.r) {
          let t0 = (box.t - a.y) / dy;
          let t1 = (box.b - a.y) / dy;
          if (t0 > t1) [t0, t1] = [t1, t0];
          const lo = Math.max(0, t0);
          const hi = Math.min(1, t1);
          if (lo < hi) cuts.push([lo, hi]);
        }
      }
    }
    if (cuts.length === 0) {
      visibleSegments.push({ a, b });
      continue;
    }
    cuts.sort((c1, c2) => c1[0] - c2[0]);
    // 合并相交区间后输出补集
    const merged: Array<[number, number]> = [];
    for (const c of cuts) {
      const lastCut = merged[merged.length - 1];
      if (lastCut && c[0] <= lastCut[1]) {
        lastCut[1] = Math.max(lastCut[1], c[1]);
      } else {
        merged.push([c[0], c[1]]);
      }
    }
    let cursor = 0;
    for (const [lo, hi] of merged) {
      if (lo > cursor) {
        visibleSegments.push({
          a: { x: a.x + dx * cursor, y: a.y + dy * cursor },
          b: { x: a.x + dx * lo, y: a.y + dy * lo },
        });
      }
      cursor = Math.max(cursor, hi);
    }
    if (cursor < 1) {
      visibleSegments.push({
        a: { x: a.x + dx * cursor, y: a.y + dy * cursor },
        b,
      });
    }
  }
  let path = '';
  for (const seg of visibleSegments) {
    path += `M ${fmtNum(seg.a.x)} ${fmtNum(seg.a.y)} L ${fmtNum(seg.b.x)} ${fmtNum(seg.b.y)} `;
  }
  return { visibleSegments, path: path.trimEnd() };
}
