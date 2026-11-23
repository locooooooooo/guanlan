/**
 * 画布视口裁剪与卡片描述（issue #27）
 *
 * 为什么抽成纯函数：GraphCanvasView 是 4800 行的巨型组件，视口裁剪与卡片物化
 * 一旦内联就只能在浏览器里「看效果」验证。这里是纯数据变换——输入布局/视口/索引，
 * 输出「该挂载哪些包」与「卡片要什么 props」，可直接单测。
 *
 * 两条纪律：
 * 1. **裁剪不改变世界坐标**：布局坐标仍由完整包序列算出（跨包定位、小地图、
 *    双击打开都依赖全局位置），裁剪只决定「这一帧挂不挂 DOM」。
 * 2. **保留焦点包**：即使焦点包在视口外也挂载——它是选中态与叙事抽屉的目标，
 *    突然消失会让联动断裂。
 */

/** 每包最多展示的卡片数（画布栅格上限；超出由容器头 docCount 诚实承载） */
export const PACKAGE_GROUP_MAX_CARDS = 6;

/** 包容器在世界坐标里的矩形（只需 x/width 做横向裁剪，纵向整条桌面带同高） */
export interface PackageGroupRect {
  pkgId: string;
  x: number;
  width: number;
}

/** 视口（zoom 层用户空间）矩形 */
export interface WorldViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 裁剪参数 */
export interface CullOptions {
  /** 视口外预留边距（世界单位）：拖动/缩放时预挂相邻包，避免入画瞬间空白 */
  marginX?: number;
  /** 焦点任务包 id：即使可视区外也保留挂载 */
  focusPkgId?: string;
  /** 关闭裁剪（小地图全量预览、测试对比用） */
  disabled?: boolean;
}

export const DEFAULT_CULL_MARGIN_X = 480;

/* ═══ D01-a：全图元 AABB 视口裁剪 + 四分之一倍频程（quarter-octave）缩放分桶 LOD ═══
 * 任务卡 D01-a ④：把 issue #27 的「任务包横向裁剪」推广为「任意世界矩形对视口」
 * 的通用 AABB 裁剪，并给缩小鸟瞰加缩放分桶 LOD——桶距取 quarter-octave（log2(k)×4
 * 向下取整，每档 ≈1.19×），LOD 档位只在跨档时翻转（连续缩放不抖动），缩小到
 * 鸟瞰档自动退化为轻骨架（收流星/激光/富卡正文等重排大户，规避 foreignObject 重绘）。
 * 裁剪纪律与 issue #27 一致：只决定「这一帧挂不挂 DOM」，世界坐标照常由完整序列算出。 */

/** 通用世界矩形（x/y 左上角 + 尺寸） */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 全图元 AABB：取世界矩形集合的总包围盒（含 pad 外扩）。空集返回 null
 * （调用方按「无内容」兜底，不得伪造 [0,0,1000,900]）。
 * 消费方：小地图世界框、全图元视口裁剪的输入。
 */
export function computeWorldAABB(
  rects: ReadonlyArray<WorldRect>,
  pad = 0
): WorldRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let hasFinite = false;
  for (const r of rects) {
    if (
      !Number.isFinite(r.x) ||
      !Number.isFinite(r.y) ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height)
    ) {
      continue;
    }
    hasFinite = true;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!hasFinite) return null;
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/**
 * 通用 AABB 视口相交判定：矩形（含 margin 外扩的视口）相交即可见。
 * visiblePackageGroupIds 的单一几何出口（原横向特化判定由此等价替代：
 * 横向相交 ⟺ AABB 相交在「纵向整条带」退化情形下的同一答案）。
 */
export function isRectIntersectingViewport(
  rect: WorldRect,
  viewport: WorldViewport,
  margin = 0
): boolean {
  const left = viewport.x - margin;
  const right = viewport.x + viewport.width + margin;
  const top = viewport.y - margin;
  const bottom = viewport.y + viewport.height + margin;
  return (
    rect.x + rect.width >= left &&
    rect.x <= right &&
    rect.y + rect.height >= top &&
    rect.y <= bottom
  );
}

/**
 * 通用矩形裁剪：返回该挂载的世界矩形 id 集合（视口+margin 相交者），
 * focusIds 中的 id 即使在视口外也保留（焦点不脱钩）。视口未就绪（宽/高 ≤0）
 * 保守全挂——与 visiblePackageGroupIds 的「测量前不闪空」纪律一致。
 */
export function cullRectsByViewport(
  rects: ReadonlyArray<WorldRect & { id: string }>,
  viewport: WorldViewport,
  options: { margin?: number; focusIds?: ReadonlySet<string> } = {}
): Set<string> {
  const ids = new Set<string>();
  if (!(viewport.width > 0 && viewport.height > 0)) {
    for (const r of rects) ids.add(r.id);
    return ids;
  }
  const margin = options.margin ?? 0;
  for (const r of rects) {
    const focused = options.focusIds?.has(r.id) ?? false;
    if (focused || isRectIntersectingViewport(r, viewport, margin)) {
      ids.add(r.id);
    }
  }
  return ids;
}

/* ── quarter-octave 缩放分桶 LOD ── */

/** LOD 满档下限：k ≥ 0.5 全保真（基准机位 k=1 与折叠组近景 k≈0.62 都在此档，
 *  像素基线镜头零变化）；0.25 ≤ k < 0.5 收纯装饰层；k < 0.25 轻骨架。 */
export const LOD_FULL_MIN_K = 0.5;
/** LOD 中档下限：0.25 ≤ k < 0.5 收纯装饰（流星/星闪/激光扫线——缩小后不可辨） */
export const LOD_MID_MIN_K = 0.25;

/** quarter-octave 分桶档位：floor(log2(k) × 4)，每档 ≈ 2^(1/4) ≈ 1.19×。
 *  连续缩放在同档内 LOD 恒定（跨档才翻转），保证缩放过程不出现逐帧装饰层抖动。
 *  k ≤ 0 视为未就绪，回满档（保守全渲染）。 */
export function quarterOctaveLevel(k: number): number {
  if (!(k > 0)) return Number.MAX_SAFE_INTEGER;
  return Math.floor(Math.log2(k) * 4);
}

/** LOD 档位：full 全保真 / mid 收纯装饰 / skeleton 轻骨架（主干+折叠组，规避重排） */
export type CanvasLodTier = 'full' | 'mid' | 'skeleton';

/** 缩放 → LOD 档位（纯函数，quarter-octave 分桶由 quarterOctaveLevel 承担） */
export function lodTierForScale(k: number): CanvasLodTier {
  if (!(k > 0)) return 'full';
  if (k >= LOD_FULL_MIN_K) return 'full';
  if (k >= LOD_MID_MIN_K) return 'mid';
  return 'skeleton';
}

/** 档位 → 各装饰/重组件是否渲染（Scene 层单一出口；true = 保持原渲染）。
 *  mid：收流星雨/星闪/激光扫线/X-Ray 扫描环（纯装饰，缩小后不可辨且是 foreignObject
 *  重绘大户）；skeleton：再收流式粒子/传导线/泳道光点流动（保留主干、里程碑、
 *  折叠组与事件卡骨架——空间语言在鸟瞰仍可辨）。 */
export interface CanvasLodGates {
  /** 流星雨 + 星闪层（0A 场景装饰） */
  meteors: boolean;
  /** X-Ray 激光扫线（里程碑层宿主） */
  laser: boolean;
  /** 流式粒子（传导线/泳道上的 SMIL 光点） */
  liveFlow: boolean;
  /** 事件卡与富预览卡正文细节（skeleton 档保留骨架外壳） */
  cardDetails: boolean;
}

export function lodGatesForTier(tier: CanvasLodTier): CanvasLodGates {
  if (tier === 'full') return { meteors: true, laser: true, liveFlow: true, cardDetails: true };
  if (tier === 'mid') return { meteors: false, laser: false, liveFlow: true, cardDetails: true };
  return { meteors: false, laser: false, liveFlow: false, cardDetails: false };
}

/**
 * 返回该挂载的包 id 集合。
 * 判定：包矩形与「视口 + margin」横向相交；焦点包始终保留。
 * D01-a：横向特化判定改由通用 AABB 出口 isRectIntersectingViewport 承担——
 * 包容器纵向是整条桌面带（y 无界矩形），AABB 纵向恒相交，答案与旧横向判定逐一同源。
 */
export function visiblePackageGroupIds(
  layouts: PackageGroupRect[],
  viewport: WorldViewport,
  options: CullOptions = {}
): Set<string> {
  const ids = new Set<string>();
  if (options.disabled) {
    for (const layout of layouts) ids.add(layout.pkgId);
    return ids;
  }
  const margin = options.marginX ?? DEFAULT_CULL_MARGIN_X;
  // 视口宽度异常（尚未测量）时保守全挂
  if (!(viewport.width > 0)) {
    for (const layout of layouts) ids.add(layout.pkgId);
    return ids;
  }
  for (const layout of layouts) {
    const focused = Boolean(options.focusPkgId && layout.pkgId === options.focusPkgId);
    // 纵向「整条桌面带」用有限极大带表达（±Infinity 相加会产生 NaN 使判定恒 false）；
    // MAX_VALUE 覆盖任何有限视口 y → 纵向恒相交，与旧横向特化判定同源
    const rect: WorldRect = {
      x: layout.x,
      y: 0,
      width: layout.width,
      height: Number.MAX_VALUE,
    };
    if (focused || isRectIntersectingViewport(rect, viewport, margin)) {
      ids.add(layout.pkgId);
    }
  }
  return ids;
}

/**
 * 包间流向连线是否该画：两端都挂载才画。
 * 只挂一端时画出去会指向空白（悬空线），比不画更误导。
 */
export function shouldDrawGroupConnector(
  prevPkgId: string | undefined,
  currPkgId: string,
  mountedIds: Set<string>
): boolean {
  if (!prevPkgId) return false;
  return mountedIds.has(prevPkgId) && mountedIds.has(currPkgId);
}

/** 卡片描述：从包文档一次性物化，供渲染期直接消费（不含选中态等易变态） */
export interface CardDescriptor {
  fileId: string;
  title: string;
  versionLabel: string;
  format: string;
  conclusion: string;
  bodyPreview?: string[];
  diffSections?: unknown;
  svgThumbDataUri?: string;
}

/**
 * 按包 id 物化卡片描述。
 * 依赖纪律（issue #27 验收 3）：只看「包文档内容」，不看节点位置——拖动单节点
 * 只改 nodePositions，本函数结果被复用，逐帧不重做卡片构造。
 */
export function buildCardDescriptors<
  D extends {
    fileId: string;
    title: string;
    versionLabel: string;
    format: string;
    conclusion: string;
    bodyPreview?: string[];
    diffSections?: unknown;
    svgThumbDataUri?: string;
  },
>(
  layouts: Array<{ pkgId: string; shown: number; docs: D[] }>,
  options: { evolutionView: boolean } = { evolutionView: true }
): Map<string, CardDescriptor[]> {
  const map = new Map<string, CardDescriptor[]>();
  for (const layout of layouts) {
    const cards = layout.docs.slice(0, layout.shown).map((doc) => ({
      fileId: doc.fileId,
      title: doc.title,
      versionLabel: doc.versionLabel,
      format: doc.format,
      conclusion: doc.conclusion,
      bodyPreview: doc.bodyPreview,
      diffSections: options.evolutionView ? doc.diffSections : undefined,
      svgThumbDataUri: doc.svgThumbDataUri,
    }));
    map.set(layout.pkgId, cards);
  }
  return map;
}
