
import type { FileRecord } from '../types/guanlan';
import { sanitizeSvgForPreview } from './guanlanEngine';

/** 预览缓存条目状态：
 * - `ready`：预览可派生且已生成（svgDataUri/bodyPreview 至少一项成立）；
 * - `unavailable`：正文已加载但确认不可派生（如 SVG 源已取回但为空串）——终态，但仍区分于未加载。 */
export type FilePreviewState = 'ready' | 'unavailable';

export interface FilePreviewCacheEntry {
  state: FilePreviewState;
  svgDataUri?: string;
  bodyPreview?: string[];
  lastAccessAt?: number;
}

/** 缓存条目数上限：覆盖 2200 张卡量级的概览墙全量驻留，仅防极端增长 */
export const FILE_PREVIEW_CACHE_CAPACITY = 2048;
/** 字节预算：单条 SVG dataUri 可达几十 KB，条数上限挡不住字节膨胀；
 *  24 MiB 约等于 2200 份 × 10KB 的概览墙常规驻留，超出按 LRU 逐最旧 */
export const FILE_PREVIEW_CACHE_BYTE_BUDGET = 24 * 1024 * 1024;
/** 离屏回收窗口：条目超过该时长未被渲染消费即视为离屏，可被回收。
 *  30s 足够覆盖一次滚动画布/翻页的回访间隔（快速滚回不丢缓存），
 *  又保证离开视口的高分辨率条目不无限驻留。 */
export const FILE_PREVIEW_OFFSCREEN_RECYCLE_MS = 30_000;

const cache = new Map<string, FilePreviewCacheEntry>();
let totalBytes = 0;
let nowMsForTest: (() => number) | null = null;
const nowMs = (): number => (nowMsForTest ? nowMsForTest() : Date.now());

function sweepOffscreenEntries(idleMs: number, preserveKey: string): number {
  const now = nowMs();
  let evicted = 0;
  for (const [key, entry] of cache) {
    if (key === preserveKey) continue;
    const last = entry.lastAccessAt ?? 0;
    if (last !== 0 && now - last > idleMs) {
      totalBytes -= entryBytes(entry);
      cache.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}

function resolveCurrentRevision(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

/** 正文前 N 行预览：取非空行、去行首 markdown 标记（#/列表/引用），保留段落原貌。
 *  只做展示级轻剥离——完整语义压缩走 condenseSummary（结论行已另路承载）。
 *  （原 graphEvents.ts 私有 markdownBodyPreview 函数体原样迁入，graphEvents 改从本模块引用） */
export function markdownBodyPreview(markdown: string, maxLines = 3): string[] {
  const lines: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, '')
      .trim();
    if (!line) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function entryBytes(entry: FilePreviewCacheEntry): number {
  let bytes = entry.svgDataUri?.length ?? 0;
  for (const line of entry.bodyPreview ?? []) bytes += line.length + 1;
  return bytes;
}

function evictBeyondBudget(preserveKey: string): void {
  while (
    (cache.size > FILE_PREVIEW_CACHE_CAPACITY || totalBytes > FILE_PREVIEW_CACHE_BYTE_BUDGET) &&
    cache.size > 1
  ) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const key = oldest.value;
    if (key === preserveKey) {
      if (cache.size <= 1) break;
      let skipped = false;
      for (const k of cache.keys()) {
        if (k !== preserveKey) {
          totalBytes -= entryBytes(cache.get(k)!);
          cache.delete(k);
          skipped = true;
          break;
        }
      }
      if (!skipped) break;
      continue;
    }
    totalBytes -= entryBytes(cache.get(key)!);
    cache.delete(key);
  }
}

/** per-file 预览缓存唯一入口。
 *  - 正文未加载（svg 无 svgSource / md 无 markdownContent）：返回空对象且**不写缓存**——
 *    同版本正文补齐后下次调用即派生并缓存；
 *  - 已加载：现算一次并缓存（ready / unavailable），之后 O(1) 命中（修订变更 → 新键 → 重算一次）；
 *  - 有界内存：每次消费前先做离屏回收（超 30s 未访问的条目逐出），命中/写入
 *    都刷新 lastAccessAt——「正在被渲染消费」的条目永不回收，离开视口的 30s 后回收。 */
export function getFilePreviewEntry(file: FileRecord): FilePreviewCacheEntry {
  const rev = resolveCurrentRevision(file);
  const key = `${file.file_id}:${rev?.revision_id ?? ''}`;
  sweepOffscreenEntries(FILE_PREVIEW_OFFSCREEN_RECYCLE_MS, key);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, { ...hit, lastAccessAt: nowMs() });
    return hit;
  }

  const svgLoaded = file.format === 'svg' && rev?.svgSource !== undefined;
  const mdLoaded = file.format === 'md' && rev?.markdownContent !== undefined;
  if (file.format === 'svg' && !svgLoaded) return { state: 'unavailable' };
  if (file.format === 'md' && !mdLoaded) return { state: 'unavailable' };

  const entry: FilePreviewCacheEntry = { state: 'ready' };
  if (file.format === 'svg') {
    const source = rev?.svgSource ?? '';
    if (source === '') {
      entry.state = 'unavailable';
    } else {
      entry.svgDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(
        sanitizeSvgForPreview(source).sanitizedSvg
      )}`;
    }
  }
  if (file.format === 'md') {
    entry.bodyPreview = markdownBodyPreview(rev?.markdownContent ?? '');
    if (entry.bodyPreview.length === 0) entry.state = 'unavailable';
  } else if (file.format === 'pdf') {
    const pdfLines = (rev?.pdfPages?.[0]?.extractedText || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3);
    entry.bodyPreview = pdfLines.length > 0 ? pdfLines : ['正文尚未索引 · 仅元数据可检索'];
  }

  cache.set(key, entry);
  totalBytes += entryBytes(entry);
  evictBeyondBudget(key);
  entry.lastAccessAt = nowMs();
  return entry;
}

/** 仅供测试/诊断：缓存条目数与字节总量（生产代码不调用） */
export function filePreviewCacheStatsForTest(): { entries: number; totalBytes: number } {
  return { entries: cache.size, totalBytes };
}

/** 仅供测试：注入时钟（单测可控推进离屏窗口）；传 null 恢复真实时钟 */
export function setFilePreviewClockForTest(fn: (() => number) | null): void {
  nowMsForTest = fn;
}

/** 切换工作区时清空内存预览缓存，杜绝跨工作区残留。 */
export function clearFilePreviewCache(): void {
  cache.clear();
  totalBytes = 0;
}

/** 仅供测试/诊断：清空缓存（别名） */
export function clearFilePreviewCacheForTest(): void {
  clearFilePreviewCache();
}
