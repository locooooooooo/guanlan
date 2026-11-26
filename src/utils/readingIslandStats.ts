import type { FileFormat, FileRecord, WorkspaceConfig } from '../types/guanlan';
import { hasUnreadChanges, type UnreadReason } from './guanlanEngine';
import { dirSegmentsOf, normalizePath } from './documentIdentity';
import { readingRecency, type ReadingStateMap } from './readingStateStore';

const PATH_COLLATOR = new Intl.Collator();

/**
 * 右缘悬浮岛三环用色（统一引用样式令牌，不再直写 hex）。
 * 浅底对比度校准：岛面使用浅底后，旧暗底三值文字级对比度不足 AA（白 #FFFFFF 下：
 * sage #788C5D 3.68、wave-bright #ED8A50 2.51、lavender #9B8AFB 2.83），
 * 故三值均改用浅底校准令牌：
 * - read → --stage-ink-deliver-text(#56643A)：白上 6.40（paper #FAF9F5 上 6.08），
 *   环/点与 11px 组标文字双过 AA；
 * - unread → --accent-wave(#A84A1A)：白上 5.74（5.45）；
 * - persisted → --accent-iris-deep(#6D5BD0)：白上 5.18（4.91）。
 * 三值全为既有令牌引用，零新增 hex；data-island-section 组标与环描边消费点自动继承。
 */
export const ISLAND_STATUS_COLORS = {
  read: 'var(--stage-ink-deliver-text)',
  unread: 'var(--accent-wave)',
  persisted: 'var(--accent-iris-deep)',
} as const;

export type IslandReadStatus = 'read' | 'unread';

export interface IslandDocEntry {
  fileId: string;
  currentRevisionId?: string;
  title: string;
  dirPrefix: string;
  format: FileFormat;
  readStatus: IslandReadStatus;
  unreadReason: UnreadReason;
  persisted: boolean;
  scrollPercent: number;
}

export interface ReadingIslandSummary {
  total: number;
  read: number;
  unread: number;
  persisted: number;
}

export interface ReadingIslandStats extends ReadingIslandSummary {
  entries: IslandDocEntry[];
}

function currentRevisionOf(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

/**
 * 轻量统计阅读与存档汇总计数（不构造条目清单、不排序、不计算重名目录前缀），供顶栏收起态使用。
 */
export function computeReadingIslandSummary(
  files: FileRecord[],
  readingStates: ReadingStateMap
): ReadingIslandSummary {
  let read = 0;
  let unread = 0;
  let persisted = 0;
  for (const file of files) {
    const unreadInfo = hasUnreadChanges(file, readingStates[file.file_id]);
    if (unreadInfo.reason === 'up_to_date') read += 1;
    else unread += 1;
    const currentRev = currentRevisionOf(file);
    if (currentRev?.snapshotAvailable) persisted += 1;
  }
  return { total: files.length, read, unread, persisted };
}

function resolveMinimalDirPrefixes(files: readonly FileRecord[]): Map<string, string> {
  const byTitle = new Map<string, Set<string>>();
  for (const file of files) {
    const norm = normalizePath(file.relative_path);
    const set = byTitle.get(file.title);
    if (set) set.add(norm);
    else byTitle.set(file.title, new Set([norm]));
  }

  const out = new Map<string, string>();
  for (const uniquePaths of byTitle.values()) {
    if (uniquePaths.size <= 1) continue;
    const suffixCounts = new Map<string, number>();
    const segsByPath = new Map<string, string[]>();
    for (const p of uniquePaths) {
      const segs = dirSegmentsOf(p);
      segsByPath.set(p, segs);
      let acc = '';
      for (let i = segs.length - 1; i >= 0; i -= 1) {
        acc = acc ? `${segs[i]}/${acc}` : segs[i];
        suffixCounts.set(acc, (suffixCounts.get(acc) ?? 0) + 1);
      }
    }
    for (const [p, segs] of segsByPath) {
      if (segs.length === 0) {
        out.set(p, '');
        continue;
      }
      let chosen = '';
      let acc = '';
      for (let i = segs.length - 1; i >= 0; i -= 1) {
        acc = acc ? `${segs[i]}/${acc}` : segs[i];
        if ((suffixCounts.get(acc) ?? 0) === 1) {
          chosen = acc;
          break;
        }
      }
      out.set(p, chosen || segs.join('/'));
    }
  }
  return out;
}

/**
 * 右缘悬浮岛聚合：哪些已读 / 哪些未读 / 哪些已落盘存档。
 * 已读 = hasUnreadChanges 判 up_to_date；未读 = never_read / updated_since_last_read
 * （三态文案展示层必须经 unreadStatusLabel，此处只产出 reason）。
 */
export function computeReadingIslandStats(
  files: FileRecord[],
  readingStates: ReadingStateMap
): ReadingIslandStats {
  const prefixByPath = resolveMinimalDirPrefixes(files);
  let read = 0;
  let unread = 0;
  let persisted = 0;

  const decorated = files.map((file) => {
    const state = readingStates[file.file_id];
    const unreadInfo = hasUnreadChanges(file, state);
    const currentRev = currentRevisionOf(file);
    const rawScroll = state?.scrollPercent ?? 0;
    const isRead = unreadInfo.reason === 'up_to_date';
    const isPersisted = Boolean(currentRev?.snapshotAvailable);
    if (isRead) read += 1;
    else unread += 1;
    if (isPersisted) persisted += 1;
    const entry: IslandDocEntry = {
      fileId: file.file_id,
      currentRevisionId: file.current_revision_id,
      title: file.title,
      dirPrefix: prefixByPath.get(normalizePath(file.relative_path)) ?? '',
      format: file.format,
      readStatus: isRead ? 'read' : 'unread',
      unreadReason: unreadInfo.reason,
      persisted: isPersisted,
      scrollPercent: Math.min(100, Math.max(0, Math.round(rawScroll))),
    };
    return { entry, recency: readingRecency(state), path: file.relative_path };
  });

  decorated.sort((a, b) => {
    if (b.recency !== a.recency) return b.recency - a.recency;
    return PATH_COLLATOR.compare(a.path, b.path);
  });

  return {
    total: decorated.length,
    read,
    unread,
    persisted,
    entries: decorated.map((d) => d.entry),
  };
}

/** count/total 取整百分比；total=0 时返回 0（空工作区悬浮岛不渲染，函数只兜底不炸） */
export function islandPercent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

/** 存档区配额水位一行文案：上限缺失（0）时如实说「上限未知」，不虚构配额 */
export function formatIslandQuotaLine(quota: WorkspaceConfig['quota']): string {
  if (quota.maxTotalMiB > 0) {
    return `存档区 ${quota.usedTotalMiB} / ${quota.maxTotalMiB} MiB`;
  }
  return `存档区 已用 ${quota.usedTotalMiB} MiB · 上限未知`;
}
