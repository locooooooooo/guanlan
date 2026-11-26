
import type { FileFormat, FileRecord } from '../types/guanlan';
import { hasUnreadChanges } from './guanlanEngine';
import { isToolNoisePath, minimalDirPrefix } from './documentIdentity';
import { stageOfPath, type StageRole } from './taskPackages';
import type { ReadingStateMap } from './readingStateStore';


/** 高价值三类别＝规格「PLAN、交付与复验、未决决策」对应的三阶段（StageRole 子集）。 */
export type HighValueCategory = '计划' | '决策' | '交付';

/** 展示优先级序：决策 > 交付 > 计划。 */
export const HIGH_VALUE_STAGES: readonly HighValueCategory[] = ['决策', '交付', '计划'];

function isHighValueStage(stage: StageRole): stage is HighValueCategory {
  return (HIGH_VALUE_STAGES as readonly string[]).includes(stage);
}


/**
 * 噪音判定已上移 documentIdentity.isToolNoisePath 作单一出口（任务包统计
 * groupFilesIntoPackages 同口径复用，避免第二套路径形态判定漂移）；
 * 既有 import 供本层单趟过滤继续调用，再导出保持本层 API 与既有测试锚点不变。
 */
export { isToolNoisePath };


export interface HighValueReadingEntry {
  fileId: string;
  title: string;
  dirPrefix: string;
  format: FileFormat;
  category: HighValueCategory;
  readStatus: 'unread' | 'read';
  latestObservedAt: string;
}

export interface HighValueReadingStats {
  pendingCount: number;
  entries: HighValueReadingEntry[];
  scannedCount: number;
}

function currentRevisionOf(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

function observedAtSortKey(observedAt: string): number {
  if (!observedAt) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(observedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * 首页「近期待阅：核心方案与决策」聚合：
 * 高价值（stageOfPath ∈ 决策/交付/计划）∩ 未读（reason !== 'up_to_date'）。
 * pendingCount === entries.length 且为全量（诚实呈现纪律：不虚减、不截断）。
 */
export function computeHighValueReading(
  files: FileRecord[],
  readingStates: ReadingStateMap
): HighValueReadingStats {
  const sameTitlePathsByTitle = new Map<string, string[]>();
  for (const file of files) {
    const bucket = sameTitlePathsByTitle.get(file.title);
    if (bucket) bucket.push(file.relative_path);
    else sameTitlePathsByTitle.set(file.title, [file.relative_path]);
  }

  const decorated: { entry: HighValueReadingEntry; path: string }[] = [];
  for (const file of files) {
    if (isToolNoisePath(file.relative_path)) continue;
    const stage = stageOfPath(file.relative_path);
    if (!isHighValueStage(stage)) continue;
    const unreadInfo = hasUnreadChanges(file, readingStates[file.file_id]);
    if (unreadInfo.reason === 'up_to_date') continue;
    const currentRev = currentRevisionOf(file);
    decorated.push({
      entry: {
        fileId: file.file_id,
        title: file.title,
        dirPrefix: minimalDirPrefix(
          file.relative_path,
          sameTitlePathsByTitle.get(file.title) ?? []
        ),
        format: file.format,
        category: stage,
        readStatus: 'unread',
        latestObservedAt: currentRev?.observed_at ?? '',
      },
      path: file.relative_path,
    });
  }

  decorated.sort((a, b) => {
    const rankA = HIGH_VALUE_STAGES.indexOf(a.entry.category);
    const rankB = HIGH_VALUE_STAGES.indexOf(b.entry.category);
    if (rankA !== rankB) return rankA - rankB;
    const timeA = observedAtSortKey(a.entry.latestObservedAt);
    const timeB = observedAtSortKey(b.entry.latestObservedAt);
    if (timeA !== timeB) return timeB - timeA;
    return a.path.localeCompare(b.path);
  });

  const entries = decorated.map((d) => d.entry);
  return {
    pendingCount: entries.length,
    entries,
    scannedCount: files.length,
  };
}


/**
 * 「近期待阅」标题的唯一出口（组件不拼字串）。
 * n=0 时仍返回该句——空态的副文（改由组件层给）不复用标题措辞。
 */
export function highValueReadingHeading(stats: { pendingCount: number }): string {
  return `近期待阅：核心方案与决策（${stats.pendingCount} 份）`;
}
