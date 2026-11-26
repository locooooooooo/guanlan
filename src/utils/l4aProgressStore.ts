/**
 * 后台语义整理（L4A）进度的活值层。
 *
 * 背景：这份进度此前是 useWorkspaceStore 的 useState。写线程每处理最多 3 篇就发一条
 * `l4a` 事件，前端每收一条立刻打一次 `/status` 并 setState；另有 2.5 秒轮询兜底。
 * 1,397 篇的队列 ≈ 466 次「整棵 App 树重渲」——App 与五个分节都把 ctx 当 props，
 * 阅读器正文与星图画布因此跟着进度条一起重渲。形制照 canvasThemeStore.ts：
 * 活值住模块内存，横幅叶子经 useSyncExternalStore 订阅，进度更新零重子树重渲。
 *
 * 本模块不引 React（node 测试直接导入）；同值短路让每 2.5 秒的轮询回到同一进度时
 * 不再通知订阅者。
 */
import type { L4aProgress } from '../services/apiTypes';

let currentProgress: L4aProgress | null = null;
const progressListeners = new Set<() => void>();

/** 当前进度；null = 服务未下发 / 队列已排空（横幅不渲染，不造假进度）。 */
export function getL4aProgress(): L4aProgress | null {
  return currentProgress;
}

/** useSyncExternalStore 订阅口；返回退订函数。 */
export function subscribeL4aProgress(listener: () => void): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

function sameProgress(a: L4aProgress | null, b: L4aProgress | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.done === b.done &&
    a.total === b.total &&
    a.percent === b.percent &&
    a.queue_depth === b.queue_depth
  );
}

/** 更新活值并通知横幅；同值短路。 */
export function setL4aProgress(next: L4aProgress | null): void {
  if (sameProgress(currentProgress, next)) return;
  currentProgress = next;
  progressListeners.forEach((listener) => listener());
}

/** 切换工作区或复位时清空。 */
export function resetL4aProgress(): void {
  setL4aProgress(null);
}

/**
 * 「真正还在整理」的口径。两条都不能省：
 * - total=0 是服务端尚未排出队列，不拿 0/0 当 100% 假进度；
 * - 以 queue_depth > 0 为准：缺失快照被标 failed 后 queue_depth 归 0，
 *   若只看 done < total，横幅会永久悬挂在一段不再前进的进度上。
 * 老服务端没有 queue_depth 时才退回 done < total。
 */
export function isL4aProgressActive(progress: L4aProgress | null): boolean {
  if (!progress || progress.total <= 0) return false;
  return typeof progress.queue_depth === 'number'
    ? progress.queue_depth > 0
    : progress.done < progress.total;
}
