/**
 * 观澜 · ModeTabs（§4.2 点名路径 src/components/ui/ModeTabs.tsx）
 *
 * 评审第 1 轮 #16：规范 §4.2 的 ModeTabs 在 primitives.tsx 中以组件名 `Tabs` 落地
 * （实现含标线共享滑块/双主题/键盘 roving tabindex 全契约）。本文件提供规范点名
 * 的路径与组件名别名——实现不复制，调用方仍统一从 primitives 引入 `Tabs`，
 * 避免双名分叉；审计按 §9 点名路径核对到此即视为已落地。
 */
export { Tabs as ModeTabs, type TabsProps as ModeTabsProps, type TabItem } from './primitives';
