/**
 * 画布主题（舷窗局部）本机持久化。
 *
 * 作用域是 .dark-porthole 画布舷窗，不是全局主题：壳层在两主题下恒浅玻璃
 * （保持「浅壳+暗舷窗」结构），键名刻意带 canvasTheme 而不是 theme——
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
  }
}

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
