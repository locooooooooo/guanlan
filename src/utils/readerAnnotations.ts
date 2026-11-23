/**
 * D04 · 阅读器锚点批注纯函数层（零 React 依赖，node/SSR 可跑）。
 *
 * 任务卡 D04「原文/原图局部锚点批注」的数据与锚点口径单一出处：
 * · 批注锚点三类：MD 段落（行号区间）、SVG 画布框选区域（渲染盒百分比，缩放无关）、
 *   PDF 指定页选中文字（页码 + 摘录）。
 * · 本地独立证据表（停机条款口径）：批注绝不写进用户原始文件字节；SVG/PDF 批注
 *   只落本地证据表并**按版本哈希（content_sha256）绑定**——换版本互不可见，绝不拿
 *   旧版批注冒充当前版批注。MD 批注「一键转为 [P1 - 待确认] 决定项」走既有桌面壳
 *   save_workspace_file CAS 桥（显式点击 + 冲突诚实拒绝），本层只产插入文本。
 * · 存储纪律与 decisionReceiptSnapshot 同口径：键 guanlan.readerAnnotations.v1 →
 *   Record<"fileId::contentSha256", 批注[]>；读写 try/catch 静默降级（隐私模式、
 *   配额满、损坏 JSON 绝不让阅读器起不来）；node 无 window 环境按未设置处理。
 * · 有界：每版本批注 ≤ ANNOTATIONS_PER_VERSION_CAP（超出丢最旧并如实计数），
 *   单条 note ≤ ANNOTATION_NOTE_MAX 字符。
 */

/** 批注锚点定位器（三类；SVG 区域存渲染盒百分比 0..1，与缩放/分辨率无关）。 */
export type ReaderAnnotationLocator =
  | { kind: 'md'; startLine: number; excerpt: string }
  | { kind: 'svg'; fx: number; fy: number; fw: number; fh: number }
  | { kind: 'pdf'; page: number; quote: string };

export interface ReaderAnnotation {
  id: string;
  note: string;
  created_at: string;
  /** 一键转为决定项：MD=已回写 [P1 - 待确认] 块；SVG/PDF=本地决定草案（绝不写原文）。 */
  converted: boolean;
  /** 转为决定项时的决定文本（converted=false 恒缺省）。 */
  decision_text?: string;
  locator: ReaderAnnotationLocator;
}

/** 本地独立证据表（内存形态；持久化形态为 JSON.stringify(store)）。 */
export type ReaderAnnotationStore = Record<string, ReaderAnnotation[]>;

/** 版本存储键：file_id + 版本内容哈希——批注按版本哈希绑定的唯一判定口径。 */
export function annotationVersionKey(fileId: string, contentSha256: string): string {
  return `${fileId}::${contentSha256}`;
}

export const ANNOTATION_STORAGE_KEY = 'guanlan.readerAnnotations.v1';
/** 每版本批注上限（超出丢最旧，计数如实回报，绝不静默膨胀）。 */
export const ANNOTATIONS_PER_VERSION_CAP = 200;
/** 单条批注正文上限（字符）。 */
export const ANNOTATION_NOTE_MAX = 480;
/** 摘录上限（字符）。 */
export const ANNOTATION_EXCERPT_MAX = 480;
/** SVG 框选退化阈值（占渲染盒比例，低于视为误触）。 */
export const SVG_REGION_MIN_FRACTION = 0.01;

/** 空 evidence 表。 */
export function emptyAnnotationStore(): ReaderAnnotationStore {
  return {};
}

/** 批注 id：时间单调 + 计数器，同毫秒不撞（注入 clock 便于测试确定性）。 */
let annotationSeq = 0;
export function nextAnnotationId(clock: () => number = () => Date.now()): string {
  annotationSeq += 1;
  return `anno_${clock().toString(36)}_${annotationSeq.toString(36)}`;
}

/** note 落笔前归一：换行折叠为空格、去首尾、截断到上限（绝不夹带私货）。 */
export function normalizeAnnotationNote(raw: string): string {
  return (raw || '')
    .replace(/\r?\n+/g, ' ')
    .trim()
    .slice(0, ANNOTATION_NOTE_MAX);
}

/** 摘录归一：同口径截断。 */
export function normalizeAnnotationExcerpt(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim().slice(0, ANNOTATION_EXCERPT_MAX);
}

/** 单条批注形状校验（损坏条目剔除，不抛错）。 */
function isValidAnnotation(value: unknown): value is ReaderAnnotation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Partial<ReaderAnnotation>;
  if (typeof a.id !== 'string' || !a.id) return false;
  if (typeof a.note !== 'string') return false;
  if (typeof a.created_at !== 'string') return false;
  if (typeof a.converted !== 'boolean') return false;
  const loc = a.locator as Partial<ReaderAnnotationLocator> | undefined;
  if (!loc || typeof loc !== 'object') return false;
  if (loc.kind === 'md') {
    return typeof (loc as { startLine?: unknown }).startLine === 'number';
  }
  if (loc.kind === 'svg') {
    const s = loc as { fx?: unknown; fy?: unknown; fw?: unknown; fh?: unknown };
    return (
      typeof s.fx === 'number' && typeof s.fy === 'number' &&
      typeof s.fw === 'number' && typeof s.fh === 'number'
    );
  }
  if (loc.kind === 'pdf') {
    return typeof (loc as { page?: unknown }).page === 'number';
  }
  return false;
}

/** 损坏 JSON → 空表重建（与 decisionReceipt 快照同纪律，不抛错）。 */
export function parseAnnotationStore(raw: unknown): ReaderAnnotationStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ReaderAnnotationStore = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const items = value.filter(isValidAnnotation);
    if (items.length > 0) out[key] = items;
  }
  return out;
}

/** 读某版本批注（键不存在 → 空数组；新表优先返回，调用方零拷贝安全）。 */
export function annotationsOfVersion(
  store: ReaderAnnotationStore,
  fileId: string,
  contentSha256: string
): ReaderAnnotation[] {
  return store[annotationVersionKey(fileId, contentSha256)] ?? [];
}

/** 落笔上限执行：超出 cap 丢最旧，返回 {store, dropped}——dropped 由调用方如实提示。 */
export function upsertAnnotation(
  store: ReaderAnnotationStore,
  fileId: string,
  contentSha256: string,
  annotation: ReaderAnnotation
): { store: ReaderAnnotationStore; dropped: number } {
  const key = annotationVersionKey(fileId, contentSha256);
  const prev = store[key] ?? [];
  const next = [...prev, annotation];
  const dropped = next.length > ANNOTATIONS_PER_VERSION_CAP
    ? next.length - ANNOTATIONS_PER_VERSION_CAP
    : 0;
  const capped = dropped > 0 ? next.slice(dropped) : next;
  return { store: { ...store, [key]: capped }, dropped };
}

/** 删除批注；id 不存在时原样返回（幂等）。 */
export function removeAnnotation(
  store: ReaderAnnotationStore,
  fileId: string,
  contentSha256: string,
  annotationId: string
): ReaderAnnotationStore {
  const key = annotationVersionKey(fileId, contentSha256);
  const prev = store[key];
  if (!prev) return store;
  const next = prev.filter((a) => a.id !== annotationId);
  if (next.length === prev.length) return store;
  return { ...store, [key]: next };
}

/** 标记已转决定项（converted=true + 决定文本）；id 不存在原样返回。 */
export function markAnnotationConverted(
  store: ReaderAnnotationStore,
  fileId: string,
  contentSha256: string,
  annotationId: string,
  decisionText: string
): ReaderAnnotationStore {
  const key = annotationVersionKey(fileId, contentSha256);
  const prev = store[key];
  if (!prev) return store;
  let changed = false;
  const next = prev.map((a) => {
    if (a.id !== annotationId || a.converted) return a;
    changed = true;
    return { ...a, converted: true, decision_text: normalizeAnnotationNote(decisionText) };
  });
  return changed ? { ...store, [key]: next } : store;
}

/* ── 本地持久化薄壳（decisionReceiptSnapshot 同口径；node 无 window 静默） ── */

export function loadAnnotationStore(): ReaderAnnotationStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(ANNOTATION_STORAGE_KEY);
    if (!raw) return {};
    return parseAnnotationStore(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function persistAnnotationStore(store: ReaderAnnotationStore): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ANNOTATION_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 隐私模式/配额满：静默（批注是增强能力，不是阅读前置条件） */
  }
}

/* ── SVG 框选区域几何（渲染盒百分比坐标系） ────────────────────────────── */

/** SVG 画布单位（viewBox 宽高优先，root width/height 数值兜底，皆缺 null——仅作展示标签，定位恒用百分比）。 */
export function svgCanvasUnitsOf(svg: string): { width: number; height: number } | null {
  const source = svg || '';
  const vb = /<svg\b[^>]*?\bviewBox\s*=\s*["']\s*([^"']+)["']/i.exec(source);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v)) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const root = /<svg\b([^>]*)>/i.exec(source);
  if (root) {
    const w = numAttr(root[1], 'width');
    const h = numAttr(root[1], 'height');
    if (w !== undefined && h !== undefined && w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

function numAttr(attrs: string, name: string): number | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([+\\-0-9.]+)\\s*["']`, 'i').exec(attrs);
  if (!m) return undefined;
  const v = Number.parseFloat(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * 拖拽矩形 → 归一区域：任意拖拽方向收敛为左上原点、各边 clamp 到 [0,1]、
 * 退化（任一边 < SVG_REGION_MIN_FRACTION）→ null（误触不产批注）。
 */
export function normalizeSvgRegion(
  fx0: number,
  fy0: number,
  fx1: number,
  fy1: number
): { fx: number; fy: number; fw: number; fh: number } | null {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  // 1e-6 量化消除拖拽减法的浮点尾差（0.8-0.2=0.6000000000000001 类），
  // 百分比定位最终 toFixed(3)，量化不损失可见精度
  const q = (v: number) => Number(v.toFixed(6));
  const x0 = clamp01(fx0);
  const y0 = clamp01(fy0);
  const x1 = clamp01(fx1);
  const y1 = clamp01(fy1);
  const fx = q(Math.min(x0, x1));
  const fy = q(Math.min(y0, y1));
  const fw = q(Math.abs(x1 - x0));
  const fh = q(Math.abs(y1 - y0));
  if (fw < SVG_REGION_MIN_FRACTION || fh < SVG_REGION_MIN_FRACTION) return null;
  return { fx, fy, fw, fh };
}

/** 区域 → 叠加层百分比定位样式（与渲染盒缩放无关）。 */
export function svgRegionStyle(region: { fx: number; fy: number; fw: number; fh: number }): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: `${(region.fx * 100).toFixed(3)}%`,
    top: `${(region.fy * 100).toFixed(3)}%`,
    width: `${(region.fw * 100).toFixed(3)}%`,
    height: `${(region.fh * 100).toFixed(3)}%`,
  };
}

/* ── 锚点标签与决定项转换 ──────────────────────────────────────────────── */

/** 锚点人话标签（composer/清单共用一处口径）。 */
export function formatAnnotationLocatorLabel(locator: ReaderAnnotationLocator): string {
  switch (locator.kind) {
    case 'md':
      return `L${locator.startLine}`;
    case 'svg': {
      const units = { x: Math.round(locator.fx * 100), y: Math.round(locator.fy * 100) };
      return `框选区（${units.x}%, ${units.y}%）`;
    }
    case 'pdf':
      return `第 ${locator.page} 页`;
  }
}

/** 决定项标题（标记行尾文本）：note 折叠截断，空 note 用锚点标签兜底。 */
export function buildAnnotationDecisionTitle(note: string, locatorLabel: string): string {
  const title = normalizeAnnotationNote(note);
  return title || `批注转决定（${locatorLabel}）`;
}

/**
 * MD 批注 → `[P1 - 待确认]` 决定块插入文本（纯函数可单测）：
 * · 只在 afterLine（1-based）之后**插入**新行，既有行逐字节不动（CAS 冲突比对可靠）；
 * · 标记行可被 parseDecisionBlocks 识别（回流后端 derive → 画布决定节点），
 *   「决定：」字段行落入块字段；来源行如实标注来自本地批注；
 * · note/来源均单行化（换行折叠），绝不夹带空行打断块解析；
 * · afterLine=0 或越界 → 追加到文末（前置空行分隔）。
 */
export function buildDecisionBlockInsertion(input: {
  markdownContent: string;
  afterLine: number;
  note: string;
  locatorLabel: string;
}): { ok: true; newContent: string; insertedLines: number } | { ok: false; reason: string } {
  const content = input.markdownContent ?? '';
  const note = normalizeAnnotationNote(input.note);
  const locatorLabel = input.locatorLabel || '本地批注';
  // 空 note 不拒绝（调用方入口已拦截纯空批注）：标题与决定字段按锚点标签兜底
  const title = buildAnnotationDecisionTitle(note, locatorLabel);
  const decisionText = note || title;
  const titleShort = title.length > 60 ? `${title.slice(0, 60)}…` : title;
  const block = [
    `- [P1 - 待确认] ${titleShort}`,
    `决定：${decisionText}`,
    `来源：观澜本地批注 · ${locatorLabel}`,
  ];
  const lines = content ? content.split('\n') : [];
  const at = input.afterLine;
  if (!Number.isInteger(at) || at <= 0 || at > lines.length) {
    const sep = lines.length > 0 && lines[lines.length - 1].trim() !== '' ? ['', ...block] : block;
    return {
      ok: true,
      newContent: [...lines, ...sep].join('\n'),
      insertedLines: sep.length,
    };
  }
  const next = [...lines.slice(0, at), ...block, ...lines.slice(at)];
  return { ok: true, newContent: next.join('\n'), insertedLines: block.length };
}

/**
 * 插入点推算（纯函数）：批注锚行所在块的下一块起始行 - 1（块间空行区/边界）；
 * 无后续块 → 总行数（文末）。blocks 只需 {line} 升序（markdownBlocks 即满足）。
 */
export function insertionLineAfterBlock(
  blocks: Array<{ line: number }>,
  anchorLine: number,
  totalLines: number
): number {
  for (const block of blocks) {
    if (block.line > anchorLine) return Math.max(0, block.line - 1);
  }
  return Math.max(0, totalLines);
}
