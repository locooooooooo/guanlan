
/** 首屏渲染预算（300ms） */
export const READER_FIRST_SCREEN_BUDGET_MS = 300;

/** 纸面正文三态：错误 / 读取中 / 可渲染文章（含空正文的诚实空纸面） */
export type ReaderBodyPhase = 'error' | 'loading' | 'article';

/**
 * 正文渲染态判定（与 ReaderView 原三元逐字等价）：
 *  ① 正文未内联且已有读取错误 → error（不渲染空文档）；
 *  ② 正文未内联且请求挂起 → loading（纸面内 loading，shell 已可见）；
 *  ③ 其余 → article（内联正文 / 已取回正文 / 首帧尚未发起请求的空纸面）。
 */
export function resolveReaderBodyPhase(input: {
  hasInlineContent: boolean;
  hasError: boolean;
  pending: boolean;
}): ReaderBodyPhase {
  if (!input.hasInlineContent && input.hasError) return 'error';
  if (!input.hasInlineContent && input.pending) return 'loading';
  return 'article';
}

/** 一次文档打开的首屏渲染样本 */
export interface ReaderFirstScreenSample {
  fileId: string;
  revisionId: string;
  elapsedMs: number;
  withinBudget: boolean;
  contentPending: boolean;
}

let lastSample: ReaderFirstScreenSample | null = null;

/** 单调时钟：浏览器/Node 的 performance.now；缺失时回退 Date.now（仅测量用） */
export function readerFirstScreenNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * 记录一次首屏渲染样本并写入 performance 时间线。
 * 返回的 withinBudget 是唯一判定口径（严格 < 300ms）；
 * 超预算不抛错，由调用方告警。
 */
export function recordReaderFirstScreenSample(input: {
  fileId: string;
  revisionId: string;
  elapsedMs: number;
  contentPending: boolean;
}): ReaderFirstScreenSample {
  const elapsedMs = Number.isFinite(input.elapsedMs) ? Math.max(0, input.elapsedMs) : 0;
  const sample: ReaderFirstScreenSample = {
    fileId: input.fileId,
    revisionId: input.revisionId,
    elapsedMs,
    withinBudget: elapsedMs < READER_FIRST_SCREEN_BUDGET_MS,
    contentPending: input.contentPending,
  };
  lastSample = sample;

  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      const end = typeof performance.now === 'function' ? performance.now() : Date.now();
      performance.mark('guanlan:reader-first-screen:start', { startTime: end - elapsedMs });
      performance.mark('guanlan:reader-first-screen:end');
      performance.measure(
        'guanlan:reader-first-screen',
        'guanlan:reader-first-screen:start',
        'guanlan:reader-first-screen:end'
      );
    } catch {
    }
  }
  return sample;
}

/** 最近一次首屏样本（E2E / 单测读取；未记录过返回 null） */
export function getLastReaderFirstScreenSample(): ReaderFirstScreenSample | null {
  return lastSample;
}

/** 单测隔离：清空最近样本（生产代码无需调用） */
export function resetReaderFirstScreenSampleForTest(): void {
  lastSample = null;
}
