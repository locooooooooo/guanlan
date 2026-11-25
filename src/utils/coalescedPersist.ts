/**
 * 尾沿合批写入：高频状态（滚动进度、阅读位置）只按最后一版落盘。
 *
 * 为什么：阅读状态整表 `JSON.stringify` 在滚动路径上每帧做一次，几万条记录
 * 时主线程直接发粘。合批只改变落盘时机，不改变语义——每次 schedule 之后
 * 的最终状态一定会写出去（定时器尾沿，或 flush）。
 *
 * 计时器可注入，node 测试用假时钟验证「多次 schedule 只写一次」。
 */
export interface CoalescedTimer {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CoalescedPersist {
  /** 标记有新状态待写；重复调用只保留最后一个定时器 */
  schedule(): void;
  /** 立即写，并取消挂起的定时器 */
  flush(): void;
  /** 取消挂起的定时器，不写 */
  cancel(): void;
}

function defaultTimer(): CoalescedTimer {
  if (typeof window !== 'undefined') {
    return {
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    };
  }
  return {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function createCoalescedPersist(
  write: () => void,
  delayMs: number,
  timer: CoalescedTimer = defaultTimer()
): CoalescedPersist {
  let handle: unknown = null;
  const cancel = (): void => {
    if (handle !== null) {
      timer.clearTimeout(handle);
      handle = null;
    }
  };
  return {
    schedule() {
      cancel();
      handle = timer.setTimeout(() => {
        handle = null;
        write();
      }, delayMs);
    },
    flush() {
      cancel();
      write();
    },
    cancel,
  };
}
