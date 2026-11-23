/**
 * 阅读器首屏渲染预算（AC-02）——纯函数 + 轻量性能测量，供 ReaderView 与单测共用。
 *
 * AC-02 口径（PRD v2.0 验收表）：点击打开任意本地 Markdown 文档（含首次打开与
 * 切换文档）时「无『正在向智能体请求正文』阻塞遮罩，首屏渲染耗时 < 300ms」。
 *
 * 两层职责：
 *  - resolveReaderBodyPhase：首屏框架（标题/工具栏/纸面）与正文读取态解耦——
 *    正文未内联且仍在读取时只切换纸面内 loading，不阻塞 shell；判定顺序与
 *    ReaderView 既有三元逐字一致（错误优先于 loading，正文内联优先于两者）。
 *  - recordReaderFirstScreenSample：记录「一次文档打开的首屏渲染耗时」，超过
 *    300ms 预算时由调用方告警；同时写入 performance mark/measure，便于 DevTools
 *    与 E2E 复测。模块内只保留最后一次样本，不参与 React 状态，不触发重渲染。
 *
 * 纪律：纯函数模块——禁 import .css / React；性能 API 缺失时回退 Date.now()。
 */

/** AC-02 首屏渲染预算（PRD v2.0 验收表逐字） */
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
  /** 当前版本是否内联了正文（空串按未内联处理，与既有条件逐字一致） */
  hasInlineContent: boolean;
  /** 当前 contentKey 是否已有读取错误 */
  hasError: boolean;
  /** 当前 contentKey 是否请求挂起 */
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
  /** 从 ReaderView 本次 screenKey 首次渲染到提交后 effect 的耗时（ms） */
  elapsedMs: number;
  /** 是否在 AC-02 300ms 预算内 */
  withinBudget: boolean;
  /** 首屏提交时正文是否仍需异步读取（true = shell 先到、正文后到） */
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
 * 返回的 withinBudget 是唯一判定口径（严格 < 300ms，与 PRD 验收表逐字一致）；
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
      /* 旧浏览器/受限环境不支持 mark options 时静默：样本本身仍可用 */
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
