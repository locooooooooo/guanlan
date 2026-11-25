/**
 * 观澜 · 全局应用主题存储（对齐 coss.com/ui :root / .dark 语义双态体系）。
 *
 * 与既有画布局部主题（utils/canvasThemeStore.ts）职责分明：
 * - appThemeStore 负责整站壳层明暗偏好：'light'（默认素雅精密）| 'dark'（暗夜沉浸）| 'system'（跟随系统）
 * - 默认值恒为 'light'，保证既有视觉基线零漂移；仅当用户显式切换或本机已存偏好时启用暗夜壳层。
 * - 存储纪律同 canvasThemeStore / safeStorage：裸 JSON 串 + 全链路 try/catch，
 *   Node 无 window 测试环境安全回退，支持 React 19 useSyncExternalStore 细粒度订阅。
 */
export const APP_THEME_STORAGE_KEY = 'guanlan.appTheme.v1';

export type AppThemeMode = 'light' | 'dark' | 'system';
export type ResolvedAppTheme = 'light' | 'dark';

const VALID_MODES: readonly AppThemeMode[] = ['light', 'dark', 'system'];

/** 全站主题三态轮换顺序：浅色精密 → 暗夜沉浸 → 跟随系统 → 浅色精密。 */
export function nextAppThemeMode(mode: AppThemeMode): AppThemeMode {
  if (mode === 'light') return 'dark';
  if (mode === 'dark') return 'system';
  return 'light';
}

/** 全站主题中文展示标签（单一语义源）。 */
export function appThemeModeLabel(mode: AppThemeMode): string {
  if (mode === 'dark') return '深色';
  if (mode === 'system') return '跟随系统';
  return '浅色';
}

function isAppThemeMode(value: unknown): value is AppThemeMode {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value);
}

/** 纯函数：按模式与系统暗色信号解析实际生效的明暗态。 */
export function resolveEffectiveAppTheme(
  mode: AppThemeMode,
  systemPrefersDark: boolean,
): ResolvedAppTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}

/** 读取系统暗色偏好（无 window 或无 matchMedia 时安全回 false）。 */
export function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** 启动同步水合；无值 / 非法值 / 隐私模式异常一律回退 'light'。 */
export function readAppThemeMode(): AppThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const raw = window.localStorage.getItem(APP_THEME_STORAGE_KEY);
    if (!raw) return 'light';
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isAppThemeMode(parsed)) return parsed;
    } catch {
      /* 非 JSON 裸串：继续按原值判 */
    }
    return isAppThemeMode(raw) ? raw : 'light';
  } catch {
    return 'light';
  }
}

/** 写回本机；写失败静默降级。 */
export function saveAppThemeMode(mode: AppThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, JSON.stringify(mode));
  } catch {
    /* 忽略配额/隐私模式异常 */
  }
}

/** 命令式将最终主题同步到 document.documentElement（挂 .dark 类与 color-scheme）。 */
export function syncDocumentAppTheme(resolved: ResolvedAppTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

let currentMode: AppThemeMode = readAppThemeMode();
let currentResolved: ResolvedAppTheme = resolveEffectiveAppTheme(
  currentMode,
  readSystemPrefersDark(),
);
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** 当前用户选择的主题模式（'light' | 'dark' | 'system'）。 */
export function getAppThemeMode(): AppThemeMode {
  return currentMode;
}

/** 当前实际生效的明暗态（'light' | 'dark'）。 */
export function getResolvedAppTheme(): ResolvedAppTheme {
  return currentResolved;
}

/** useSyncExternalStore 订阅口；返回退订函数。 */
export function subscribeAppTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 更新主题模式、写回持久化、同步 DOM 并通知订阅者。同值短路。 */
export function applyAppTheme(mode: AppThemeMode, systemPrefersDark?: boolean): ResolvedAppTheme {
  const prefersDark = systemPrefersDark ?? readSystemPrefersDark();
  const nextResolved = resolveEffectiveAppTheme(mode, prefersDark);
  const changed = mode !== currentMode || nextResolved !== currentResolved;
  currentMode = mode;
  currentResolved = nextResolved;
  saveAppThemeMode(mode);
  syncDocumentAppTheme(nextResolved);
  if (changed) notify();
  return nextResolved;
}

/** 启动挂载入口：同步首帧 DOM，并监听系统明暗切换（仅在 'system' 模式下联动）。 */
export function initAppThemeSync(): () => void {
  currentMode = readAppThemeMode();
  currentResolved = resolveEffectiveAppTheme(currentMode, readSystemPrefersDark());
  syncDocumentAppTheme(currentResolved);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (event: MediaQueryListEvent) => {
    if (currentMode !== 'system') return;
    const next = resolveEffectiveAppTheme('system', event.matches);
    if (next !== currentResolved) {
      currentResolved = next;
      syncDocumentAppTheme(next);
      notify();
    }
  };
  mq.addEventListener?.('change', onChange);
  return () => {
    mq.removeEventListener?.('change', onChange);
  };
}
