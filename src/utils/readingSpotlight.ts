import type { FileRecord, ReadingState } from '../types/guanlan';
import type { ArtifactStateView } from '../services/apiTypes';
import { hasUnreadChanges } from './guanlanEngine';

/**
 * 「我离开后发生了什么」增量聚光灯纯函数引擎（阅读状态模块单一派生出口）。
 *
 * 一键开启聚光灯后：上次离开前已读且未变的节点退为低对比度背景骨架，仅高亮
 * 三类「读后真实变化」：
 *  - revision_update  新增版本：有阅读基线且当前版更新（updated_since_last_read）；
 *  - pending_decision 新挂起决定：有阅读基线且状态机投影 pending_p0+pending_p1 > 0；
 *  - agent_draft      Agent 新草案：待审草案（mcp/agent）挂在后未批阅。
 *
 * 停机红线护栏：「首次收录」与「读后变更」绝不混同——
 *  - never_read（未读新件）文件【不】进变化清单、【不】参与 M 计数，也不降亮度
 *    （它们是首次收录态，有自己的语义，不属于「我离开后发生的读后变化」）；
 *  - M 只统计读后真实变化处数（一个文件可同时命中多类，按类分条）。
 *
 * 排序契约：「按时间逐条批阅」——atMs 降序（新→旧），无时间的诚实排后；
 * 同 ms 平局按 kind 枚举序再按 title zh 字典序，纯函数两次调用逐项全等（确定性单测锁定）。
 */

/** 读后真实变化三分类（聚光灯高亮语义，与未读两态术语正交：只认读后变更）。 */
export type SpotlightChangeKind = 'revision_update' | 'pending_decision' | 'agent_draft';

/** 三类高亮的固定展示措辞（司辰旁导航条 kind 徽标单一出口）。 */
export function spotlightKindLabel(kind: SpotlightChangeKind): string {
  if (kind === 'revision_update') return '新增版本';
  if (kind === 'pending_decision') return '新挂起决定';
  return 'Agent 新草案';
}

export interface SpotlightChangeItem {
  file_id: string;
  kind: SpotlightChangeKind;
  /** 变化排序时间（ms）；时间不可知时为 null（诚实排后，不伪造时间）。 */
  atMs: number | null;
  /** 排序平局兜底的展示名（文件 title），纯派生不另造词。 */
  title: string;
}

export interface SpotlightInput {
  files: readonly FileRecord[];
  readingStates: Readonly<Record<string, ReadingState>>;
  /** /api/v1/state-overview 投影索引（file_id → 行）；null = 投影未就绪（诚实跳过）。 */
  artifactsByFileId: ReadonlyMap<string, ArtifactStateView> | null;
  /** 待审草案 file_id → 最新 created_at（ISO）；空表 = 无草案数据。 */
  agentDraftAtByFileId: ReadonlyMap<string, string>;
  /** 排序基准时刻（单测注入固定值保证确定性；仅用于时间解析合法性兜底）。 */
  nowMs: number;
}

/** ISO → ms；非法/缺失返回 null（诚实排后，绝不伪造时间）。 */
function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** kind 枚举序（平局第一优先级）。 */
const KIND_ORDER: Record<SpotlightChangeKind, number> = {
  revision_update: 0,
  pending_decision: 1,
  agent_draft: 2,
};

/**
 * 读后真实变化清单一次派生（O(n) 单遍 files + O(drafts) 草案补扫）。
 * 文件已从 files 消失（被删/移动出工作区）时其草案/决定条目不凭空出现——
 * 以 files 为主表遍历，绝不拿投影行冒充工作区文件。
 */
export function computeSpotlightChanges(input: SpotlightInput): SpotlightChangeItem[] {
  const items: SpotlightChangeItem[] = [];
  for (const file of input.files) {
    const st = input.readingStates[file.file_id];
    // 停机红线护栏：从未读过（无基线）= 未读新件 = 首次收录，不是读后变化，
    // 三类全部不命中（有基线才判读后变更）
    if (!st || !st.last_read_revision_id) continue;
    const title = file.title;
    // ① 新增版本：updated_since_last_read（有基线且当前版更新），时间取当前版 observed_at
    if (hasUnreadChanges(file, st).reason === 'updated_since_last_read') {
      const currentRev = file.revisions.find((r) => r.revision_id === file.current_revision_id);
      items.push({
        file_id: file.file_id,
        kind: 'revision_update',
        atMs: parseTimeMs(currentRev?.observed_at),
        title,
      });
    }
    // ② 新挂起决定：状态机投影 pending_p0+pending_p1>0，时间取 last_activity_at
    const artifact = input.artifactsByFileId?.get(file.file_id) ?? null;
    if (artifact && (artifact.pending_p0 ?? 0) + (artifact.pending_p1 ?? 0) > 0) {
      items.push({
        file_id: file.file_id,
        kind: 'pending_decision',
        atMs: parseTimeMs(artifact.last_activity_at),
        title,
      });
    }
    // ③ Agent 新草案：待审清单命中，时间取草案 created_at
    const draftAt = input.agentDraftAtByFileId.get(file.file_id);
    if (draftAt !== undefined) {
      items.push({
        file_id: file.file_id,
        kind: 'agent_draft',
        atMs: parseTimeMs(draftAt),
        title,
      });
    }
  }
  // 按时间新→旧；无时间排最后；平局 kind 枚举序 → title zh 字典序（两次调用逐项全等）
  items.sort((a, b) => {
    if (a.atMs !== null && b.atMs !== null && a.atMs !== b.atMs) return b.atMs - a.atMs;
    if (a.atMs !== null && b.atMs === null) return -1;
    if (a.atMs === null && b.atMs !== null) return 1;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.title.localeCompare(b.title, 'zh-Hans-CN') || a.file_id.localeCompare(b.file_id);
  });
  return items;
}

/** 司辰旁导航条摘要：M = 变化处数（items.length），按类分计数。 */
export function computeSpotlightSummary(items: readonly SpotlightChangeItem[]): {
  total: number;
  byKind: Record<SpotlightChangeKind, number>;
} {
  const byKind: Record<SpotlightChangeKind, number> = {
    revision_update: 0,
    pending_decision: 0,
    agent_draft: 0,
  };
  for (const item of items) byKind[item.kind] += 1;
  return { total: items.length, byKind };
}

/**
 * 降亮度集合（「上次离开前已读且未变」的节点退为低对比度背景骨架）：
 * up_to_date（有基线且当前版未变）且不在任何读后变化清单里的文件。
 * never_read（未读新件）不降亮度——首次收录是合法的独立态，绝不冒充背景骨架。
 */
export function computeSpotlightDimmedFileIds(
  files: readonly FileRecord[],
  readingStates: Readonly<Record<string, ReadingState>>,
  items: readonly SpotlightChangeItem[]
): Set<string> {
  const changed = new Set(items.map((item) => item.file_id));
  const dimmed = new Set<string>();
  for (const file of files) {
    if (changed.has(file.file_id)) continue;
    const st = readingStates[file.file_id];
    if (!st || !st.last_read_revision_id) continue; // 未读新件：保持原样
    if (hasUnreadChanges(file, st).reason === 'up_to_date') dimmed.add(file.file_id);
  }
  return dimmed;
}

/**
 * J/K 键盘步进守卫（纯函数，useSpotlightReviewKeys 消费）：
 * 输入焦点在文本编辑面（input/textarea/select/contenteditable）或任意
 * data-esc-layer="open" 浮层打开时，J/K 让路（不抢占编辑与浮层）。
 * 鸭子类型判定 tagName/isContentEditable（node 测试链无 DOM 全局，SSR 同构安全）。
 */
export function shouldIgnoreSpotlightKeys(
  target: EventTarget | null,
  escLayerOpen: boolean
): boolean {
  if (escLayerOpen) return true;
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/** J/K 游标步进（循环）：dir=+1 下一处 / -1 上一处；total=0 时恒 0。 */
export function stepSpotlightCursor(cursor: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (((cursor + dir) % total) + total) % total;
}
