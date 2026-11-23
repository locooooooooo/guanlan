/**
 * 画布主题（舷窗局部）本机持久化（v0.7 设计增补 §1.1）。
 *
 * 作用域是 .dark-porthole 画布舷窗，不是全局主题：壳层在两主题下恒浅玻璃
 * （v0.6 冻结「浅壳+暗舷窗」），键名刻意带 canvasTheme 而不是 theme——
 * 防止后来者把它当全局主题复用。值只有两档：'xray-dark'（夜航，默认）/
 * 'xray-light'（纸面）。形制照 readingStateStore.ts：裸字符串 + try/catch，
 * 读取失败/无值/非法值一律回默认，绝不让画布起不来。
 */
export const CANVAS_THEME_STORAGE_KEY = 'guanlan.canvasTheme.v1';

export type CanvasTheme = 'xray-dark' | 'xray-light';

const VALID_THEMES: readonly CanvasTheme[] = ['xray-dark', 'xray-light'];

function isCanvasTheme(value: unknown): value is CanvasTheme {
  return typeof value === 'string' && (VALID_THEMES as readonly string[]).includes(value);
}

/** 启动时同步水合（App useState 初始化器直调，无首帧闪烁）；异常/非法值回 xray-dark。
 *  主形态是 JSON 串（与 readingStateStore 同制）；手写裸值 'xray-light' 也宽容收下。 */
export function readCanvasTheme(): CanvasTheme {
  if (typeof window === 'undefined') return 'xray-dark';
  try {
    const raw = window.localStorage.getItem(CANVAS_THEME_STORAGE_KEY);
    if (!raw) return 'xray-dark';
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isCanvasTheme(parsed)) return parsed;
    } catch {
      /* 非 JSON：继续按裸字符串判 */
    }
    return isCanvasTheme(raw) ? raw : 'xray-dark';
  } catch {
    return 'xray-dark';
  }
}

/** 每次切换写回本机；写失败（隐私模式/配额满）静默——持久化是增强能力，不是切换的前置条件。 */
export function saveCanvasTheme(theme: CanvasTheme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CANVAS_THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    /* 忽略 */
  }
}

/* ── 活值层（评审第 2 轮延迟项新增） ────────────────────────────────────────────
 * 背景：切换此前是 App useState——一次翻转=整棵 App 树两次重渲（canvasTheme 提交 +
 * themeMorphing 类提交），数千 SVG 节点的 reconciliation 与两次全子树样式失效相乘，
 * 评审实测点击→过渡 2.1s、类移除 4.2s。现在主题值住在本模块（内存单例），
 * 舷窗 data-canvas-theme / theme-morphing 由宿主 App 命令式直写 DOM；
 * 只有分段钮与页签 theme 两个叶子经 useSyncExternalStore 订阅——翻转零重子树重渲。
 * node 裸环境（测试）无 window：readCanvasTheme 守卫回默认，订阅层照常可用。 */
let currentTheme: CanvasTheme = readCanvasTheme();
const themeListeners = new Set<() => void>();

/** 当前画布主题（内存单例；首次导入即完成本机水合，无首帧闪烁）。 */
export function getCanvasTheme(): CanvasTheme {
  return currentTheme;
}

/** useSyncExternalStore 订阅口；返回退订函数。 */
export function subscribeCanvasTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

/** 更新活值 + 写本机 + 通知订阅叶子。同值短路（通知者与持久化都不做）。 */
export function applyCanvasTheme(theme: CanvasTheme): void {
  if (theme === currentTheme) return;
  currentTheme = theme;
  saveCanvasTheme(theme);
  themeListeners.forEach((listener) => listener());
}
