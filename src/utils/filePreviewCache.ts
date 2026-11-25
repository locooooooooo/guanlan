/**
 * 观澜 —— per-file 预览缓存（SVG dataUri / 正文前三行）单一出口
 *
 * 为什么收敛到这里：此前 SVG 预览编码（sanitizeSvgForPreview 全文清洗 + encodeURIComponent）
 * 在 AtlasView / HomeView / graphEvents.buildCanvasPackageGroups 三处各持一份实现，
 * 任一次 files 数组身份变化（哪怕内容零变化）就全量重清洗重编码。收敛后：
 * - 键 = `${file_id}:${解析后的当前版本 revision_id}`——修订未变 O(1) 命中；修订变更即新键，
 *   旧键留在表内由容量上限逐出（同键覆盖即天然失效，无需主动失效通道）。
 *   键取「解析后的当前版本 id」而非裸 current_revision_id：后者缺失时回退末版，
 *   末版有变即换键，不留指向旧内容的陈旧条目。
 * - 依赖方向：graphEvents → 本模块 → guanlanEngine（sanitizeSvgForPreview 单源复用），无环。
 *   markdownBodyPreview 函数体自 graphEvents.ts 私有定义原样迁入并由此导出
 *   （graphEvents 若反向持有会让缓存层↔画布事件层成环，故落点在本模块）。
 *
 * 缓存状态纪律：
 * - 只缓存「可判定的终态」：预览就绪（ready，有可派生预览）与已加载为空/不可派生
 *   （unavailable，如 SVG 源已取回但为空串）。两类都带状态标记，消费方可区分。
 * - 「未加载」（svg 无 svgSource / md 无 markdownContent）一律**不落缓存**：
 *   此前占位版本行先到时会缓存空对象，同版本正文补齐后仍命中旧空对象，预览永远缺失。
 *   不落缓存 = 下次调用现算，正文补齐后自然产出 ready 条目并覆盖。
 * - 字节预算：SVG dataUri 单条可达几十 KB，按条数（2048）限制挡不住字节膨胀；
 *   超出字节预算按访问序逐最旧（Map 迭代序=插入序，命中续期即 LRU）。
 *   超过条数上限的固定顺序整库扫描（隐藏画布/首页遍历）不再缓存未加载占位后，
 *   不会把已就绪的热条目整轮挤出的最坏情形被显著缓解。
 */

import type { FileRecord } from '../types/guanlan';
import { sanitizeSvgForPreview } from './guanlanEngine';

/** 预览缓存条目状态：
 * - `ready`：预览可派生且已生成（svgDataUri/bodyPreview 至少一项成立）；
 * - `unavailable`：正文已加载但确认不可派生（如 SVG 源已取回但为空串）——终态，但仍区分于未加载。 */
export type FilePreviewState = 'ready' | 'unavailable';

export interface FilePreviewCacheEntry {
  /** 缓存状态：不返回 not_loaded——未加载的文件不产生缓存条目 */
  state: FilePreviewState;
  /** SVG 预览 dataUri：清洗 → encodeURIComponent 一次成型（含 data: 前缀，三处消费同式） */
  svgDataUri?: string;
  /** 正文前 3 行预览：md=markdownBodyPreview 剥离行；pdf=首页抽取文字行（空则既有占位词汇） */
  bodyPreview?: string[];
  /** 有界内存：最近一次被渲染消费的时刻（Date.now()）。离屏（超时未访问）
   *  的条目由 sweep 在下次访问时回收——概览墙滚走后 30s，高分辨率 SVG dataUri
   *  不再常驻内存（每条可达几十 KB）。0 = 未跟踪（旧条目兼容）。 */
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
/** 允许测试注入的时钟（单测可控推进；生产走 Date.now()） */
let nowMsForTest: (() => number) | null = null;
const nowMs = (): number => (nowMsForTest ? nowMsForTest() : Date.now());

/** 离屏回收：逐出「上次消费距今超过 idleMs」的条目（LRU 访问序，最旧先逐）。
 *  返回本次回收的条目数。每次 getFilePreviewEntry 前调用一次——无需全局定时器，
 *  消费本身就是节拍器（概览墙每帧都会触发），单次 O(n) 扫描 n≤容量上限，开销可忽略。 */
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

/** 当前版本解析：current_revision_id 指向最新版（App.tsx / AtlasView.currentRevisionOf 同口径），
 * 缺失回退末版；revisions 按 seq 升序，seq 1 是基线旧版 */
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

/** 条目字节量：dataUri（编码后 ASCII，1 char ≈ 1 byte）+ 预览行 */
function entryBytes(entry: FilePreviewCacheEntry): number {
  let bytes = entry.svgDataUri?.length ?? 0;
  for (const line of entry.bodyPreview ?? []) bytes += line.length + 1;
  return bytes;
}

/** 超预算逐最旧（访问序 LRU）：字节与条数双上限；兜底不删刚写入的键 */
function evictBeyondBudget(preserveKey: string): void {
  while (
    (cache.size > FILE_PREVIEW_CACHE_CAPACITY || totalBytes > FILE_PREVIEW_CACHE_BYTE_BUDGET) &&
    cache.size > 1
  ) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const key = oldest.value;
    if (key === preserveKey) {
      // 只剩刚写入的键时停止（不自我逐出）；继续删会破坏调用方当次返回值语义
      if (cache.size <= 1) break;
      // preserveKey 不是最旧时不会走到这；真走到（极端全同键）按序找下一个
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
    // 访问续期：移到插入序末尾，热文件不被淘汰（guanlanEngine.getCachedMdLines 同款）
    cache.delete(key);
    cache.set(key, { ...hit, lastAccessAt: nowMs() });
    return hit;
  }

  // 未加载不落缓存——不产生阻止后续补齐的终态命中
  const svgLoaded = file.format === 'svg' && rev?.svgSource !== undefined;
  const mdLoaded = file.format === 'md' && rev?.markdownContent !== undefined;
  if (file.format === 'svg' && !svgLoaded) return { state: 'unavailable' };
  if (file.format === 'md' && !mdLoaded) return { state: 'unavailable' };

  const entry: FilePreviewCacheEntry = { state: 'ready' };
  // SVG：清洗 + 编码是全文级开销（SVG 源可达几十 KB），本缓存存在的核心理由；
  // 已取回但为空串 → 不可派生（unavailable 终态），不产出破损 dataUri
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
  // 正文预览：md=正文行剥离；pdf=首页抽取文字（无则「正文尚未索引 · 仅元数据可检索」——
  // 占位词汇沿用 graphEvents.buildCanvasPackageGroups 原句，不另造词）。
  // pdf 的首页抽取文字随摘要元数据下发，与正文按需加载无关 → pdf 恒可判定
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
  // 新写入条目同样计入「正在消费」窗口（写入即消费——调用方拿到返回值就要渲染）
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
