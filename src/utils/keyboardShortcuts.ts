/**
 * 全键盘无鼠工作流——键→动作解析单一语义源 + 速查清单 + 无障碍动效节律（纯函数，零 UI 依赖）。
 *
 * 快捷键分发层语义核心：
 *  - J / K        上一 / 下一事件（时间轴线性遍历；画布增量批阅开启时由聚光灯同键承担）
 *  - H / L        收起 / 展开当前选中事件所属事项组（批次 / 身份簇 / 同文件同日版本组）
 *  - Space        原位轻预览（useQuickPreview 既有监听独占，本文件不解析）
 *  - Enter        深度阅读当前焦点文件（阅读器 + 来源栈返回）
 *  - D            打开当前焦点文件的版本对比（MD→阅读器差异 / SVG·表格→时光机 / 其余→版本链抽屉）
 *  - C            当前焦点文件加入上下文篮
 *  - Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z   文件操作 Undo / Redo（独立 FileOpHistory 账本）
 *  - Alt+方向键   星图画布沿引用/因果连线空间漫游（canvasSpatialNav 消费，本文件不解析）
 *  - Esc          按来源栈逐级精确返回（useWorkspaceStore Esc 阶梯独占）
 *  - ?            开关快捷键速查浮层（useWorkspaceStore 独占）
 *
 * 停机红线护栏：编辑态文本编辑（input/textarea/select/contenteditable）与
 * 输入法组字（isComposing）里【一切】键都不解析——Ctrl+Z 恒留给原生文本撤销；任何浮层
 * （[data-esc-layer="open"] 或 [role="dialog"]）打开时不解析；原生可激活元素
 * （button/a/summary/role="button"）聚焦时不抢 Enter（单字母导航键无原生行为，照常生效）。
 */

/** 全局/视图快捷键动作（与 Space 轻预览 / Ctrl+K 面板 / Esc 阶梯正交，绝不重复解析）。 */
export type ShortcutAction =
  | 'event-next'
  | 'event-prev'
  | 'collapse-focus'
  | 'expand-focus'
  | 'deep-read-focus'
  | 'open-version-diff'
  | 'add-focus-to-basket'
  | 'undo-op'
  | 'redo-op'
  // 全站工作区导航与左右侧栏折展
  | 'nav-tab-home'
  | 'nav-tab-panorama'
  | 'nav-tab-library'
  | 'nav-panorama-star'
  | 'nav-panorama-calendar'
  | 'nav-panorama-list'
  | 'toggle-left-sidebar'
  | 'toggle-right-inspector';

/** Store 级全局监听（useGlobalShortcuts）消费的动作集合；J/K/H/L 归视图级监听，绝不互抢。 */
export const STORE_SHORTCUT_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'deep-read-focus',
  'open-version-diff',
  'add-focus-to-basket',
  'undo-op',
  'redo-op',
  'nav-tab-home',
  'nav-tab-panorama',
  'nav-tab-library',
  'nav-panorama-star',
  'nav-panorama-calendar',
  'nav-panorama-list',
  'toggle-left-sidebar',
  'toggle-right-inspector',
]);

/** 两键和弦（G S / G C / G L）有效时间窗口（ms）。 */
export const SHORTCUT_CHORD_WINDOW_MS = 900;

/** 解析输入（KeyboardEvent 的最小鸭子类型——node 测试链无 DOM 全局，SSR 同构安全）。 */
export interface RawKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** 解析守卫上下文（由调用方按当前 DOM/应用态快照提供）。 */
export interface ShortcutGuardContext {
  /** 焦点在文本编辑面（input/textarea/select/contenteditable）：一切键让路。 */
  editableTarget: boolean;
  /** 任一浮层/对话框打开（data-esc-layer="open" 或 role="dialog"）：整层让路。 */
  overlayOpen: boolean;
}

/** 单字母/数字/括号/Enter 类动作键（无 Ctrl/Meta/Alt 修饰键时才解析）。 */
const LETTER_ACTIONS: Record<string, ShortcutAction> = {
  j: 'event-next',
  k: 'event-prev',
  h: 'collapse-focus',
  l: 'expand-focus',
  enter: 'deep-read-focus',
  d: 'open-version-diff',
  c: 'add-focus-to-basket',
  // 全站导航与侧栏折展
  '1': 'nav-tab-home',
  '2': 'nav-tab-panorama',
  '3': 'nav-tab-library',
  '[': 'toggle-left-sidebar',
  ']': 'toggle-right-inspector',
};

/** G 和弦第二键映射（G S 司辰星图 / G C 日历看板 / G L 时光列表）。 */
const G_CHORD_ACTIONS: Record<string, ShortcutAction> = {
  s: 'nav-panorama-star',
  c: 'nav-panorama-calendar',
  l: 'nav-panorama-list',
};

/** 判断按键是否可作为两键和弦前缀（当前仅 `G`；受编辑态/浮层/修饰键护栏保护）。 */
export function isShortcutChordPrefix(
  input: RawKeyInput,
  ctx: ShortcutGuardContext
): 'g' | null {
  if (input.isComposing || ctx.editableTarget || ctx.overlayOpen) return null;
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.key === 'g' || input.key === 'G') return 'g';
  return null;
}

/** 解析两键和弦（prefix + second key），仅在非编辑态、无浮层、无修饰键时命中。 */
export function resolveShortcutChord(
  prefix: 'g' | null,
  input: RawKeyInput,
  ctx: ShortcutGuardContext
): ShortcutAction | null {
  if (!prefix) return null;
  if (input.isComposing || ctx.editableTarget || ctx.overlayOpen) return null;
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (prefix === 'g') {
    return G_CHORD_ACTIONS[input.key.toLowerCase()] ?? null;
  }
  return null;
}

/** 原生可编辑元素鸭子判定（与 readingSpotlight.shouldIgnoreSpotlightKeys 同法）。 */
export function isEditableLikeTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** 原生可激活元素（button / a / summary / role="button"）：Enter 让位防抢原生/卡片本地激活。 */
export function isNativeActivatingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; closest?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true;
  return (
    typeof el.closest === 'function' &&
    Boolean((el as HTMLElement).closest?.('[role="button"], button, a, summary'))
  );
}

/** DOM 侧阻断浮层检测单一出口（同时覆盖 data-esc-layer="open" 与 role="dialog" 抽屉/弹窗）。 */
export function hasBlockingDomOverlay(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector('[data-esc-layer="open"], [role="dialog"]'));
}

/**
 * 键 → 动作解析（纯函数，不含 target 维度）：
 *  - 输入法组字（isComposing）恒 null；
 *  - Escape / '?' 恒 null（既有 Esc 阶梯与帮助开关独占，绝不双解析）；
 *  - 编辑面（editableTarget）恒 null——停机线：Ctrl+Z 恒留给原生文本撤销；
 *  - 浮层打开（overlayOpen）恒 null——浮层内键归浮层自己（面板/预览/抽屉/弹窗各持键）；
 *  - Ctrl/Cmd+Z 与 Ctrl/Cmd+Shift+Z：非编辑态恒解析；
 *  - 单字母/Enter：无 Ctrl/Meta/Alt 修饰时解析；
 *  - Space / 方向键 / F 键等其余键恒 null（Space 轻预览由 useQuickPreview 独占）。
 */
export function resolveShortcutAction(
  input: RawKeyInput,
  ctx: ShortcutGuardContext
): ShortcutAction | null {
  if (input.isComposing) return null;
  if (ctx.editableTarget) return null;
  if (ctx.overlayOpen) return null;

  const key = input.key;
  // Escape / '?' 既有链路独占
  if (key === 'Escape' || key === '?') return null;

  // 文件操作 Undo / Redo（Ctrl/Cmd [+Shift] + Z；Alt 组合不认——Alt+方向键属画布漫游）
  if ((input.ctrlKey || input.metaKey) && !input.altKey && (key === 'z' || key === 'Z')) {
    return input.shiftKey ? 'redo-op' : 'undo-op';
  }

  // 其余动作只认「无 Ctrl/Meta/Alt」的单键
  if (input.ctrlKey || input.metaKey || input.altKey) return null;

  return LETTER_ACTIONS[key.toLowerCase()] ?? null;
}

/**
 * 事件入口封装：在纯解析之上叠加 target 维度——
 *  - 原生可激活元素（button/a/summary/role="button"）聚焦时仅对 Enter（deep-read-focus）让路，
 *    避免抢按钮激活或与事件卡本地 Enter 双触发；
 *  - 单字母键（J/K/H/L/D/C）与 Ctrl+Z/Shift+Z 在按钮/事件卡聚焦时仍照常生效，
 *    点选一张卡片后立刻按 J/K/H/L/D/C 无需先失焦。
 */
export function resolveShortcutActionFromEvent(
  event: RawKeyInput & { target: EventTarget | null },
  ctx: ShortcutGuardContext
): ShortcutAction | null {
  const base = resolveShortcutAction(event, ctx);
  if (base === null) return null;
  if (base === 'deep-read-focus' && isNativeActivatingTarget(event.target)) return null;
  return base;
}

/**
 * 视图级监听（TimelineView J/K/H·L、画布 Alt+方向键）共用的让路守卫：
 * 浮层打开或焦点在编辑面时视图键不生效（与 resolveShortcutAction 同一套停机护栏）。
 */
export function shortcutTargetYields(
  target: EventTarget | null,
  overlayOpen: boolean
): boolean {
  if (overlayOpen) return true;
  return isEditableLikeTarget(target);
}

// ── 无障碍动效节律（prefers-reduced-motion 静态降级单一出口） ────────────────────

/** 实时检测系统「减少动态效果」偏好（SSR / node 单测环境安全回退 false）。 */
export function prefersReducedMotionNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 程序化运镜时长（D3 transition 等）：开启减少动态效果时强制归 0（即时静态落位）。 */
export function effectiveMotionDurationMs(
  durationMs: number,
  reducedMotion: boolean = prefersReducedMotionNow()
): number {
  if (reducedMotion || durationMs <= 0) return 0;
  return durationMs;
}

/** 程序化滚动行为：开启减少动态效果时退回 auto（静态瞬达，绝不强行 smooth 滚动）。 */
export function preferredScrollBehavior(
  reducedMotion: boolean = prefersReducedMotionNow()
): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}

// ── ? 快捷键速查浮层单一语义源（TopHeader 帮助浮层与画布快捷键气泡共用口径） ───────

export interface ShortcutCheatsheetItem {
  keys: string;
  desc: string;
}

export interface ShortcutCheatsheetGroup {
  id: 'view' | 'nav' | 'read' | 'ops';
  title: string;
  items: readonly ShortcutCheatsheetItem[];
}

export const SHORTCUT_CHEATSHEET_GROUPS: readonly ShortcutCheatsheetGroup[] = [
  {
    id: 'view',
    title: '视图切换与侧栏折展',
    items: [
      { keys: '1 / 2 / 3', desc: '切换「今日观澜 / 全景溯源 / 知识资产库」' },
      { keys: 'G S', desc: '直达全景 · 司辰星图' },
      { keys: 'G C', desc: '直达全景 · 日历看板' },
      { keys: 'G L', desc: '直达全景 · 时光列表' },
      { keys: '[ / ]', desc: '折展左侧目录栏 / 右侧检查器' },
      { keys: 'Z', desc: '阅读态进退「专注纸面」' },
    ],
  },
  {
    id: 'nav',
    title: '浏览与空间漫游',
    items: [
      { keys: 'J / K', desc: '上一 / 下一事件（时间轴 · 星图聚光灯批阅）' },
      { keys: 'H / L', desc: '收起 / 展开当前事件组（批次 / 拷贝簇 / 版本组）' },
      { keys: 'Alt + ↑↓←→', desc: '星图画布沿引用 / 因果连线空间漫游' },
      { keys: 'Ctrl + K', desc: '打开全局时空命令面板' },
    ],
  },
  {
    id: 'read',
    title: '轻预览、对比与上下文',
    items: [
      { keys: 'Space', desc: '原位轻预览（↑ / ↓ 切上下文件）' },
      { keys: 'Enter', desc: '深度阅读当前焦点文件' },
      { keys: 'D', desc: '打开版本对比（MD 差异 / 图表时光机 / 版本链）' },
      { keys: 'C', desc: '当前焦点文件加入上下文篮' },
    ],
  },
  {
    id: 'ops',
    title: '文件操作与逐级返回',
    items: [
      { keys: 'Ctrl + Z', desc: '撤销上一步重命名 / 移动（独立操作账本）' },
      { keys: 'Ctrl + Shift + Z', desc: '重做已撤销的文件操作' },
      { keys: 'Esc', desc: '关浮层 → 清搜索 → 按来源栈返回 → 清日期 → 回星图' },
      { keys: '?', desc: '开关本快捷键速查浮层' },
    ],
  },
] as const;
