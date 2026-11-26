/**
 * localStorage 容错读取。
 *
 * 为什么渲染路径不能裸读 localStorage：Chrome「阻止所有 Cookie」等隐私收紧环境下，
 * 首次访问 window.localStorage 属性即抛 SecurityError——此前 TopHeader/ModalsAndDrawers
 * 在渲染路径里裸读 `localStorage.getItem(...)`，一旦命中异常，TopHeader 渲染失败 =
 * App 整树失败（白屏）。读取失败一律返回 null，调用方按「键未设置」处理。
 * 仓库纪律同源：readingStateStore.ts / canvasThemeStore.ts 的存取均已 try/catch
 * 包裹（「隐私模式、配额满……绝不让阅读器起不来」），本工具把同一口径补齐到
 * 渲染路径的散点裸读。
 */
export function safeStorageGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
