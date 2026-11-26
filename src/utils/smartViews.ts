import type { FileRecord, ReadingState } from '../types/guanlan';
import type { ArtifactStateView } from '../services/apiTypes';
import { hasUnreadChanges } from './guanlanEngine';

/**
 * 五类虚拟智能视图（Smart Views）纯函数派生。
 *
 * 零维护成本的动态视图——成员与计数全部由同一份输入即时派生，绝无手工维护清单。
 * 守恒契约：任一智能视图的「列表计数 = 顶部徽标数 = 画布/列表过滤
 * 节点数」三处共用本模块同一函数的同一输出（App.filteredFiles 与 LeftSidebar 徽标
 * 都消费 computeSmartViewFiles 的结果），误差恒 = 0。
 *
 * 数据源（全部已在 App 内存中，零新增 IO）：
 * - 读后有更新：hasUnreadChanges 的 updated_since_last_read 态（引擎单一出口，
 *   有阅读基线且当前版更新；从未读过 never_read 不算「读后有更新」）；
 * - 等我拍板（P0/P1）：/api/v1/state-overview 的 ArtifactStateView.pending_p0+pending_p1>0
 *   （与命令面板 `status:待拍板` 语法同一口径）；
 * - 近 7 天活跃产物：artifact.last_activity_at（服务端状态机活动时间）落在
 *   [now-7d, now] 窗口（时间解析失败诚实不算，不伪造活跃）；
 * - Agent 待审草案：revision_drafts 待审清单（source=mcp|agent）的 file_id 集；
 * - 游离未归属资料：artifact.initiative_id === null（服务端状态机未归属；
 *   artifact 行缺失＝服务端尚未投影，诚实不归入，不冒充「游离」）。
 */

export type SmartViewId =
  | 'updated_after_read'
  | 'awaiting_decision'
  | 'recent_active'
  | 'agent_drafts'
  | 'unassigned';

export interface SmartViewDef {
  id: SmartViewId;
  label: string;
  title: string;
}

/** 近 7 天活跃窗口（毫秒）。 */
export const RECENT_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const SMART_VIEWS: readonly SmartViewDef[] = [
  {
    id: 'updated_after_read',
    label: '读后有更新',
    title: '已建立阅读基线且当前版本有更新',
  },
  {
    id: 'awaiting_decision',
    label: '等我拍板',
    title: '状态机投影 pending_p0 + pending_p1 > 0 的产物（P2 待决不占此视图）',
  },
  {
    id: 'recent_active',
    label: '近 7 天活跃',
    title: '服务端状态机 last_activity_at 落在最近 7 天窗口内的产物',
  },
  {
    id: 'agent_drafts',
    label: 'Agent 待审草案',
    title: '经 MCP/Agent 提交、等待人工审阅的修订草案（乐观并发保护，绝不静默覆盖原稿）',
  },
  {
    id: 'unassigned',
    label: '游离未归属',
    title: '状态机投影中不属于任何事项（initiative_id 为空）的资料',
  },
] as const;

export const SMART_VIEW_IDS: readonly SmartViewId[] = SMART_VIEWS.map((v) => v.id);

/** 左栏 quickScope 联合类型守卫：字符串是否为智能视图作用域。 */
export function isSmartViewScope(value: string): value is SmartViewId {
  return (SMART_VIEW_IDS as readonly string[]).includes(value);
}

export interface SmartViewMembershipInput {
  files: readonly FileRecord[];
  readingStates: Readonly<Record<string, ReadingState>>;
  artifactsByFileId: ReadonlyMap<string, ArtifactStateView> | null;
  agentDraftFileIds: ReadonlySet<string> | null;
  nowMs: number;
}

export type SmartViewFiles = Readonly<Record<SmartViewId, FileRecord[]>>;

const emptyFiles = (): FileRecord[] => [];

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 五类视图成员一次派生（单次遍历 files，O(n)）。
 * 计数=成员列表长度（同一输出），左栏徽标与 App 过滤消费同一结果 → 100% 守恒。
 */
export function computeSmartViewFiles(input: SmartViewMembershipInput): SmartViewFiles {
  const result: Record<SmartViewId, FileRecord[]> = {
    updated_after_read: [],
    awaiting_decision: [],
    recent_active: [],
    agent_drafts: [],
    unassigned: [],
  };
  const nowMs = input.nowMs;
  const windowStart = nowMs - RECENT_ACTIVE_WINDOW_MS;
  for (const file of input.files) {
    const st = input.readingStates[file.file_id];
    if (st && hasUnreadChanges(file, st).reason === 'updated_since_last_read') {
      result.updated_after_read.push(file);
    }
    const artifact = input.artifactsByFileId?.get(file.file_id) ?? null;
    if (artifact) {
      const pending = (artifact.pending_p0 ?? 0) + (artifact.pending_p1 ?? 0);
      if (pending > 0) result.awaiting_decision.push(file);
      const activityMs = parseTimeMs(artifact.last_activity_at);
      if (activityMs !== null && activityMs >= windowStart && activityMs <= nowMs) {
        result.recent_active.push(file);
      }
      if (artifact.initiative_id === null) result.unassigned.push(file);
    }
    if (input.agentDraftFileIds?.has(file.file_id)) result.agent_drafts.push(file);
  }
  for (const key of SMART_VIEW_IDS) {
    result[key].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }
  return result;
}

/**
 * 五类视图计数（直接由 computeSmartViewFiles 的同一输出取长度派生——
 * 计数与成员列表永远同源，杜绝「空态数字与角标打架」的停机条件）。
 */
export function computeSmartViewCounts(files: SmartViewFiles): Record<SmartViewId, number> {
  return {
    updated_after_read: files.updated_after_read.length,
    awaiting_decision: files.awaiting_decision.length,
    recent_active: files.recent_active.length,
    agent_drafts: files.agent_drafts.length,
    unassigned: files.unassigned.length,
  };
}

/** App.filteredFiles 便捷成员集（quickScope 命中智能视图时的 O(1) 判定用）。 */
export function smartViewIdSet(files: SmartViewFiles, id: SmartViewId): Set<string> {
  return new Set((files[id] ?? emptyFiles()).map((f) => f.file_id));
}
