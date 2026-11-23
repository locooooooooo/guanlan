/**
 * 统计聚合层 · 首页「近期待阅：核心方案与决策」（统计工匠）。
 *
 * 首页待阅清单曾同时承担两种口径：人类该读的方案/决策文档，与 draw_edge/draw_ms
 * 这类工具脚本产物（它们只服务画布域与原始数据，不该出现在「该读什么」里）。
 * 这里把口径收进一个纯函数层：
 *  - 噪音过滤（isToolNoisePath）：按路径形态拦截工具脚本产物——draw 前缀段与
 *    下划线系统目录；output/ 不整体拦（交付物可落 output/）；
 *  - 高价值判定＝零新造：直接复用 stageOfPath 的 STAGE_KEYWORDS 三阶段族
 *    （计划/决策/交付），不另写第二套关键词（taskPackages.ts:252-271）；
 *  - 待阅判定＝GL-01 三态复用：hasUnreadChanges 的 reason !== 'up_to_date'
 *    记待阅（guanlanEngine.ts:1275），已读高价值文档不进 entries；
 *  - 排序＝「近期」修饰排序而非集合：决策>交付>计划，同级按当前版本
 *    observed_at 降序、无版本置尾、路径升序保稳定（镜像 readingIslandStats
 *    的稳定序纪律）。N 为全部高价值待阅的诚实全量，不因时间窗虚减；
 *    展示层自行截取（如 slice(0,6)），统计层不截断。
 *
 * 只做聚合：不改写任何判定本身（stageOfPath / hasUnreadChanges / minimalDirPrefix
 * 原样调用），组件层零过滤——噪音在本层拦干净后，消费方拿到的 entries 即终稿。
 */

import type { FileFormat, FileRecord } from '../types/guanlan';
import { hasUnreadChanges } from './guanlanEngine';
// 同前缀复用 R1 身份工具：重名拷贝的 dirPrefix 与 readingIslandStats.ts:84 同式，
// 让重名条目互相可指认（reading-island.test.ts:134-136 同口径）。
import { isToolNoisePath, minimalDirPrefix } from './documentIdentity';
import { stageOfPath, type StageRole } from './taskPackages';
import type { ReadingStateMap } from './readingStateStore';

// ================= 高价值类别 =================

/** 高价值三类别＝规格「PLAN、交付与复验、未决决策」对应的三阶段（StageRole 子集）。 */
export type HighValueCategory = '计划' | '决策' | '交付';

/** 展示优先级序（口径 §4）：决策 > 交付 > 计划。 */
export const HIGH_VALUE_STAGES: readonly HighValueCategory[] = ['决策', '交付', '计划'];

/** StageRole 是否高价值：本文件不另写关键词，直接判 stageOfPath 的产出。 */
function isHighValueStage(stage: StageRole): stage is HighValueCategory {
  return (HIGH_VALUE_STAGES as readonly string[]).includes(stage);
}

// ================= 工具脚本噪音过滤 =================

/**
 * 噪音判定已上移 documentIdentity.isToolNoisePath 作单一出口（DoD3：任务包统计
 * groupFilesIntoPackages 同口径复用，避免第二套路径形态判定漂移）；
 * 既有 import 供本层单趟过滤（:130 一带）继续调用，再导出保持本层 API 与
 * 既有测试锚点（highValueReading.test.ts:86-98）不变。
 */
export { isToolNoisePath };

// ================= 聚合输出 =================

export interface HighValueReadingEntry {
  fileId: string;
  title: string;
  /** 同标题拷贝的最小区分前缀（minimalDirPrefix 同源）；无重名冲突为 '' */
  dirPrefix: string;
  format: FileFormat;
  category: HighValueCategory;
  /** entries 只收待阅，恒为 'unread'；字段保留供调用方透传（口径与悬浮岛一致） */
  readStatus: 'unread' | 'read';
  /** 当前版本 observed_at；无版本为 '' */
  latestObservedAt: string;
}

export interface HighValueReadingStats {
  /** 「近期待阅（N 份）」的 N：高价值 ∩ 未读，全量计数不截断 */
  pendingCount: number;
  /** 仅待阅条目，排序见 HIGH_VALUE_STAGES 与口径 §4 */
  entries: HighValueReadingEntry[];
  /** 噪音过滤前参与判定的文档总数（title 溯源用，不进 UI 大字） */
  scannedCount: number;
}

/** 当前版本回退口径与 readingIslandStats.ts:52-57 同款：先按 current_revision_id 查，缺失取末版 */
function currentRevisionOf(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

/** 排序键：ISO 串转时刻；''（无版本）与不可解析串都置尾（-Infinity） */
function observedAtSortKey(observedAt: string): number {
  if (!observedAt) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(observedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * 首页「近期待阅：核心方案与决策」聚合：
 * 高价值（stageOfPath ∈ 决策/交付/计划）∩ 未读（GL-01 reason !== 'up_to_date'）。
 * pendingCount === entries.length 且为全量（诚实呈现纪律 v0.6 原则⑤：不虚减、不截断）。
 */
export function computeHighValueReading(
  files: FileRecord[],
  readingStates: ReadingStateMap
): HighValueReadingStats {
  // 同标题拷贝的碰撞集在全量 files 上建（与 readingIslandStats.ts:69-74 同式）：
  // 噪音文档虽不进 entries，但同名碰撞仍参与前缀区分，保证前缀语义与悬浮岛一致
  const sameTitlePathsByTitle = new Map<string, string[]>();
  for (const file of files) {
    const bucket = sameTitlePathsByTitle.get(file.title);
    if (bucket) bucket.push(file.relative_path);
    else sameTitlePathsByTitle.set(file.title, [file.relative_path]);
  }

  // 单趟扫描逐层淘汰：噪音 → 非高价值 → 已读最新；stageOfPath 每份只算一次
  const decorated: { entry: HighValueReadingEntry; path: string }[] = [];
  for (const file of files) {
    if (isToolNoisePath(file.relative_path)) continue;
    const stage = stageOfPath(file.relative_path);
    if (!isHighValueStage(stage)) continue;
    const unreadInfo = hasUnreadChanges(file, readingStates[file.file_id]);
    if (unreadInfo.reason === 'up_to_date') continue; // 高价值已读不进 entries
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
    if (timeA !== timeB) return timeB - timeA; // 降序；''(-Infinity) 置尾
    return a.path.localeCompare(b.path); // 同值按路径升序，跨渲染稳定
  });

  const entries = decorated.map((d) => d.entry);
  return {
    pendingCount: entries.length,
    entries,
    scannedCount: files.length,
  };
}

// ================= 文案单一出口 =================

/**
 * 「近期待阅」标题的唯一出口（GL-01 同族惯例：组件不拼字串）。
 * n=0 时仍返回该句——空态的副文（改由组件层给）不复用标题措辞。
 */
export function highValueReadingHeading(stats: { pendingCount: number }): string {
  return `近期待阅：核心方案与决策（${stats.pendingCount} 份）`;
}
