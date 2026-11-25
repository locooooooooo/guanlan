/**
 * 观澜 · ModeTabs 兼容导出
 *
 * `Tabs` 原语定义在 primitives.tsx（含标线共享滑块、双主题与键盘 roving tabindex）。
 * 本文件仅提供 `ModeTabs` 别名导出，不复制实现；新调用方统一从 primitives 引入 `Tabs`。
 */
export { Tabs as ModeTabs, type TabsProps as ModeTabsProps, type TabItem } from './primitives';
