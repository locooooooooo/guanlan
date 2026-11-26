
/** fetcher 的返回形状（与 workspaceClient.fetchRevisionContent 对齐） */
export interface ContentFetchResult {
  ok: boolean;
  text?: string;
  error?: string;
  code?: string;
}

export interface RevisionContentEntry {
  state: 'ready' | 'failed';
  text?: string;
  error?: string;
  code?: string;
  bytes: number;
  format?: 'md' | 'svg';
}

const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const entries = new Map<string, RevisionContentEntry>();
const inFlight = new Map<string, Promise<string | null>>();
const pinned = new Set<string>();
let totalBytes = 0;
let testByteBudget = 0;

function entryBytes(entry: RevisionContentEntry): number {
  return entry.state === 'ready' ? entry.text?.length ?? 0 : 0;
}

function effectiveBudget(): number {
  return testByteBudget > 0 ? testByteBudget : MAX_TOTAL_BYTES;
}

function renew(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  entries.set(id, entry);
}

function evictBeyondBudget(justInserted?: string): void {
  if (totalBytes <= effectiveBudget()) return;
  for (const [id, entry] of entries) {
    if (totalBytes <= effectiveBudget()) break;
    if (pinned.has(id) || id === justInserted) continue;
    totalBytes -= entryBytes(entry);
    entries.delete(id);
  }
}

function storeReady(id: string, text: string, format?: 'md' | 'svg'): void {
  const prev = entries.get(id);
  if (prev) totalBytes -= entryBytes(prev);
  const entry: RevisionContentEntry = { state: 'ready', text, bytes: text.length, format };
  entries.set(id, entry);
  totalBytes += entryBytes(entry);
  renew(id);
  evictBeyondBudget(id);
}

function storeFailed(
  id: string,
  error: string,
  format?: 'md' | 'svg',
  code?: string
): void {
  const prev = entries.get(id);
  if (prev) totalBytes -= entryBytes(prev);
  entries.set(id, { state: 'failed', error, code, bytes: 0, format });
  renew(id);
}

/** 读取已入库条目（LRU 访问续期）；无条目返回 undefined */
export function getRevisionContent(revisionId: string): RevisionContentEntry | undefined {
  renew(revisionId);
  return entries.get(revisionId);
}

/** pin：当前阅读/对比版本不被字节预算逐出 */
export function pinRevisionContent(revisionId: string): void {
  if (revisionId) pinned.add(revisionId);
}

export function unpinRevisionContent(revisionId: string): void {
  pinned.delete(revisionId);
}

/**
 * 按需取回版本正文（统一入口）：
 * - ready 命中：立即返回缓存文本（O(1)，不重复请求）；
 * - in-flight 命中：返回进行中的同一 Promise（同版并发读取合并为一次底层请求）；
 * - failed 命中：**不短路**——重新发起请求（失败不永久锁死；调用方按需重试，
 *   SNAPSHOT_UNAVAILABLE 这类终态错误由调用方的重试策略决定是否再打）；
 * - 无条目：发起请求，成功入 ready + 字节预算，失败入 failed。
 */
export function requestRevisionContent(
  revisionId: string,
  fetch: (id: string) => Promise<ContentFetchResult>,
  format?: 'md' | 'svg'
): Promise<string | null> {
  if (!revisionId) return Promise.resolve(null);
  const cached = entries.get(revisionId);
  if (cached?.state === 'ready') return Promise.resolve(cached.text ?? '');
  const running = inFlight.get(revisionId);
  if (running) return running;
  const promise = (async () => {
    try {
      const result = await fetch(revisionId);
      if (result.ok && typeof result.text === 'string') {
        storeReady(revisionId, result.text, format);
        return result.text;
      }
      storeFailed(revisionId, result.error || '按版本读取正文失败', format, result.code);
      return null;
    } catch (e) {
      storeFailed(revisionId, e instanceof Error ? e.message : '按版本读取正文失败', format);
      return null;
    } finally {
      inFlight.delete(revisionId);
    }
  })();
  inFlight.set(revisionId, promise);
  return promise;
}

/**
 * 批量取回（并发 worker）：existing 中已有的 id 跳过；ready 条目直接回填。
 * 返回 { contents, failed }——失败项写入 failed，不污染正文结果。
 */
export async function requestRevisionContentsBatch(
  revisionIds: string[],
  fetch: (id: string) => Promise<ContentFetchResult>,
  opts?: { existing?: Record<string, string>; concurrency?: number; format?: 'md' | 'svg' }
): Promise<{ contents: Record<string, string>; failed: Record<string, string> }> {
  const existing = opts?.existing ?? {};
  const format = opts?.format;
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const id of revisionIds) {
    if (!id || seen.has(id) || id in existing) continue;
    seen.add(id);
    const cached = entries.get(id);
    if (cached?.state === 'ready') continue;
    pending.push(id);
  }
  const contents: Record<string, string> = {};
  const failed: Record<string, string> = {};
  for (const id of seen) {
    const cached = entries.get(id);
    if (cached?.state === 'ready') contents[id] = cached.text ?? '';
  }
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, opts?.concurrency ?? 8), Math.max(pending.length, 1)) },
    async () => {
      while (cursor < pending.length) {
        const id = pending[cursor++];
        const text = await requestRevisionContent(id, fetch, format);
        if (text !== null) {
          contents[id] = text;
        } else {
          failed[id] = entries.get(id)?.error || '按版本读取正文失败';
        }
      }
    }
  );
  await Promise.all(workers);
  return { contents, failed };
}

/**
 * 晚到 FileDetail 与已加载正文的合并（纯函数）：
 * 版本链元数据以 incoming（detail）为准，但已加载的正文绝不丢失——
 * 优先级：incoming 自带 > 既有版本行已并入 > store ready 条目。
 * `format` 是文件级格式（同一文件各版本同格式），决定正文落在哪个字段。
 */
export function mergeDetailRevisionsPreservingContent<
  R extends RevisionLike,
>(existing: R[], incoming: R[], format: 'md' | 'svg'): R[];
export function mergeDetailRevisionsPreservingContent<
  R extends RevisionLike,
>(
  existing: R[],
  incoming: R[],
  format: 'md' | 'svg',
  getContent: (id: string) => RevisionContentEntry | undefined,
  svgTextExtractor?: (source: string) => string[]
): R[];
export function mergeDetailRevisionsPreservingContent<R extends RevisionLike>(
  existing: R[],
  incoming: R[],
  format: 'md' | 'svg',
  getContent?: (id: string) => RevisionContentEntry | undefined,
  svgTextExtractor?: (source: string) => string[]
): R[] {
  const existingById = new Map(existing.map((r) => [r.revision_id, r]));
  return incoming.map((rev) => {
    const prev = existingById.get(rev.revision_id);
    const entry = getContent?.(rev.revision_id);
    const storeText = entry?.state === 'ready' ? entry.text : undefined;
    if (format === 'svg') {
      const prevSource = prev?.svgSource;
      const svgSource = rev.svgSource ?? prevSource ?? storeText;
      const filledFromStore =
        rev.svgSource === undefined && prevSource === undefined && storeText !== undefined;
      const svgExtractedTexts =
        rev.svgExtractedTexts ??
        prev?.svgExtractedTexts ??
        (filledFromStore && svgTextExtractor && svgSource !== undefined
          ? svgTextExtractor(svgSource)
          : undefined);
      return { ...rev, svgSource, svgExtractedTexts };
    }
    const markdownContent =
      rev.markdownContent ?? prev?.markdownContent ?? storeText;
    return markdownContent !== undefined ? { ...rev, markdownContent } : { ...rev };
  });
}

/** 切换工作区时清空内存正文缓存，杜绝跨工作区残留。 */
export function clearRevisionContentStore(): void {
  entries.clear();
  inFlight.clear();
  pinned.clear();
  totalBytes = 0;
}

/** 合并函数输入形状：Revision 视图模型的正文相关字段子集（避免反向依赖类型层） */
export interface RevisionLike {
  revision_id: string;
  markdownContent?: string;
  svgSource?: string;
  svgExtractedTexts?: string[];
}

/** 仅供测试/诊断：临时收紧字节预算（生产代码不调用） */
export function setByteBudgetForTest(bytes: number): void {
  testByteBudget = bytes;
  evictBeyondBudget();
}

/** 仅供测试/诊断 */
export function revisionContentStoreStatsForTest(): {
  entries: number;
  ready: number;
  failed: number;
  totalBytes: number;
  pinned: number;
} {
  let ready = 0;
  let failed = 0;
  for (const entry of entries.values()) {
    if (entry.state === 'ready') ready++;
    else failed++;
  }
  return { entries: entries.size, ready, failed, totalBytes, pinned: pinned.size };
}

/** 仅供测试/诊断 */
export function clearRevisionContentStoreForTest(): void {
  entries.clear();
  inFlight.clear();
  pinned.clear();
  totalBytes = 0;
}
