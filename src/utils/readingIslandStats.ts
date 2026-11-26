import type { FileFormat, FileRecord, WorkspaceConfig } from '../types/guanlan';
import { hasUnreadChanges, type UnreadReason } from './guanlanEngine';
import { minimalDirPrefix } from './documentIdentity';
import { readingRecency, type ReadingStateMap } from './readingStateStore';

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

export interface ReadingIslandStats {
  total: number;
  read: number;
  unread: number;
  persisted: number;
  entries: IslandDocEntry[];
}

function currentRevisionOf(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
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
  const sameTitlePathsByTitle = new Map<string, string[]>();
  for (const file of files) {
    const bucket = sameTitlePathsByTitle.get(file.title);
    if (bucket) bucket.push(file.relative_path);
    else sameTitlePathsByTitle.set(file.title, [file.relative_path]);
  }

  const decorated = files.map((file) => {
    const state = readingStates[file.file_id];
    const unreadInfo = hasUnreadChanges(file, state);
    const currentRev = currentRevisionOf(file);
    const rawScroll = state?.scrollPercent ?? 0;
    const entry: IslandDocEntry = {
      fileId: file.file_id,
      currentRevisionId: file.current_revision_id,
      title: file.title,
      dirPrefix: minimalDirPrefix(file.relative_path, sameTitlePathsByTitle.get(file.title) ?? []),
      format: file.format,
      readStatus: unreadInfo.reason === 'up_to_date' ? 'read' : 'unread',
      unreadReason: unreadInfo.reason,
      persisted: Boolean(currentRev?.snapshotAvailable),
      scrollPercent: Math.min(100, Math.max(0, Math.round(rawScroll))),
    };
    return { entry, recency: readingRecency(state), path: file.relative_path };
  });

  decorated.sort((a, b) => {
    if (b.recency !== a.recency) return b.recency - a.recency;
    return a.path.localeCompare(b.path);
  });

  const entries = decorated.map((d) => d.entry);
  return {
    total: entries.length,
    read: entries.filter((e) => e.readStatus === 'read').length,
    unread: entries.filter((e) => e.readStatus === 'unread').length,
    persisted: entries.filter((e) => e.persisted).length,
    entries,
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
