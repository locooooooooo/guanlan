import type { FileRecord, ReadingState } from '../types/guanlan';
import type { ReadingStateEntryDto } from '../services/apiTypes';

/**
 * 阅读状态本机持久化（多工作区独立保留）。
 *
 * 只存 ReadingState（含 personalNote / bookmark），不存正文；
 * 按 `workspaceId` 分桶持久化（`guanlan.readingState.v1.<workspaceId>`），
 * 确保在多个工作区之间来回切换并执行 `pruneReadingStates` 时，各自阅读进度、
 * 收藏与批注独立保留、绝不互相覆盖或清空。
 */
export const READING_STATE_STORAGE_KEY = 'guanlan.readingState.v1';

/**
 * 阅读状态落盘合批窗口（毫秒）。
 *
 * 滚动进度会高频改写整张表；每次变化都 `JSON.stringify` 全表，在数万条记录时
 * 会占满主线程。合批只推迟写入时机，最终状态仍会落盘（尾沿 / 页面隐藏 / 切换工作区）。
 */
export const READING_STATE_PERSIST_DEBOUNCE_MS = 800;

export type ReadingStateMap = Record<string, ReadingState>;

export function readingStateStorageKey(workspaceId?: string): string {
  const clean = workspaceId?.trim();
  return clean ? `${READING_STATE_STORAGE_KEY}.${clean}` : READING_STATE_STORAGE_KEY;
}

function isValidState(value: unknown): value is ReadingState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReadingState>;
  return typeof candidate.file_id === 'string' && candidate.file_id.length > 0;
}

function parseReadingStateJson(raw: string | null): ReadingStateMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: ReadingStateMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidState(value)) next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

/** 启动或切换工作区时水合：损坏/不可用时退回空表。
 *  传 `workspaceId` 时先读专属键，缺失再从旧单键迁移初始副本（随后由当前工作区 files 剪枝落新键）。 */
export function loadReadingStates(workspaceId?: string): ReadingStateMap {
  if (typeof window === 'undefined') return {};
  try {
    const key = readingStateStorageKey(workspaceId);
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      return parseReadingStateJson(raw);
    }
    if (workspaceId?.trim()) {
      return parseReadingStateJson(window.localStorage.getItem(READING_STATE_STORAGE_KEY));
    }
    return {};
  } catch {
    return {};
  }
}

/** 每次阅读状态变化写回对应工作区槽位；写失败（隐私模式/配额满）静默，不打断阅读。 */
export function saveReadingStates(states: ReadingStateMap, workspaceId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(readingStateStorageKey(workspaceId), JSON.stringify(states));
  } catch {
    /* 忽略：持久化是增强能力，不是阅读的前置条件 */
  }
}

/**
 * 按当前工作区扫描结果剪枝：保留当前 `files` 里仍存在的 `file_id`，以及服务端
 * 处于 `missing` / `trashed` 可恢复态的 `file_id`（从系统回收站还原后可无损重连原进度）。
 * 空工作区（`files.length === 0 && preservedFileIds.length === 0`）不触发剪枝。
 * 无变化时返回原对象，避免多余写入。
 */
export function pruneReadingStates(
  states: ReadingStateMap,
  files: FileRecord[],
  preservedFileIds: readonly string[] = []
): ReadingStateMap {
  if (files.length === 0 && preservedFileIds.length === 0) return states;
  const ids = new Set(files.map((f) => f.file_id));
  for (const id of preservedFileIds) ids.add(id);
  const next: ReadingStateMap = {};
  let changed = false;
  for (const [key, state] of Object.entries(states)) {
    if (ids.has(key)) next[key] = state;
    else changed = true;
  }
  return changed ? next : states;
}

/**
 * 本地时刻的带偏移 ISO 字符串：14:32 就写成 14:32。
 */
export function nowLocalIso(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 最近阅读优先的排序键；updated_at 缺失/非法时排到最后。 */
export function readingRecency(state?: ReadingState): number {
  if (!state?.updated_at) return 0;
  const parsed = Date.parse(state.updated_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 合并服务端已读基线记录到本地 ReadingStateMap：
 * - 仅补齐/推进 `last_read_revision_id`，绝不伪造 `scrollPercent` 或 `isFullyRead`；
 * - 服务端独有的基线记录标记 `baselineOnly: true` 且 `updated_at: ''`，
 *   避免 5,000+ 存量建基线污染「继续阅读」与 Ctrl+K「最近浏览」；
 * - 本地已有真实进度/收藏/批注时完整保留这些字段；
 * - 当 `options.authoritative === true`（服务端正常返回当前工作区全量 reading_states）时，
 *   若本地某条纯 `baselineOnly` 记录已不在服务端返回集内（如经撤销或标为未读清除），同步摘除其基线。
 */
export function mergeServerReadingStates(
  local: ReadingStateMap,
  serverItems: readonly ReadingStateEntryDto[],
  options?: { authoritative?: boolean }
): ReadingStateMap {
  if (serverItems.length === 0 && !options?.authoritative) return local;
  let next: ReadingStateMap | null = null;
  const serverIds = options?.authoritative ? new Set<string>() : null;

  for (const item of serverItems) {
    if (!item.file_id || !item.last_read_revision_id) continue;
    serverIds?.add(item.file_id);
    const existing = local[item.file_id];
    if (!existing) {
      if (!next) next = { ...local };
      next[item.file_id] = {
        file_id: item.file_id,
        last_read_revision_id: item.last_read_revision_id,
        scrollPercent: 0,
        isFullyRead: false,
        bookmarked: false,
        updated_at: '',
        baselineOnly: true,
      };
      continue;
    }
    if (existing.last_read_revision_id === item.last_read_revision_id) continue;
    const serverTs = Date.parse(item.updated_at);
    const localTs = readingRecency(existing);
    if (!existing.last_read_revision_id || (!Number.isNaN(serverTs) && serverTs >= localTs)) {
      if (!next) next = { ...local };
      next[item.file_id] = {
        ...existing,
        last_read_revision_id: item.last_read_revision_id,
        isFullyRead: false,
      };
    }
  }

  if (serverIds) {
    for (const [fileId, existing] of Object.entries(local)) {
      if (existing.baselineOnly && existing.last_read_revision_id && !serverIds.has(fileId)) {
        if (!next) next = { ...local };
        const stripped = clearReadBaselineFromState(existing);
        if (stripped) next[fileId] = stripped;
        else delete next[fileId];
      }
    }
  }
  return next ?? local;
}

/** 清除单条阅读状态的已读基线；保留收藏、个人批注与既有阅读位置，全空则返回 null 以便删键。 */
function clearReadBaselineFromState(state: ReadingState): ReadingState | null {
  const cleaned: ReadingState = {
    ...state,
    last_read_revision_id: undefined,
    isFullyRead: false,
    baselineOnly: undefined,
  };
  delete cleaned.last_read_revision_id;
  delete cleaned.baselineOnly;
  const hasUserData =
    Boolean(cleaned.bookmarked) ||
    Boolean(cleaned.personalNote) ||
    cleaned.scrollPercent > 0 ||
    Boolean(cleaned.last_section_id);
  return hasUserData ? cleaned : null;
}

/** 将单个文件标为未读（清除 last_read_revision_id 与 isFullyRead，完整保留收藏与批注）。 */
export function markFileUnreadState(current: ReadingStateMap, fileId: string): ReadingStateMap {
  const existing = current[fileId];
  if (!existing || (!existing.last_read_revision_id && !existing.isFullyRead && !existing.baselineOnly)) {
    return current;
  }
  const next: ReadingStateMap = { ...current };
  const cleaned = clearReadBaselineFromState(existing);
  if (cleaned) next[fileId] = cleaned;
  else delete next[fileId];
  return next;
}

/** 批量将一组文件标为未读，返回逐文件原状快照以支持 8 秒 Toast 100% 无损撤销。 */
export function applyBatchMarkUnread(
  local: ReadingStateMap,
  fileIds: readonly string[]
): {
  next: ReadingStateMap;
  previousSnapshot: Map<string, ReadingState | undefined>;
} {
  const previousSnapshot = new Map<string, ReadingState | undefined>();
  if (fileIds.length === 0) {
    return { next: local, previousSnapshot };
  }
  let next: ReadingStateMap | null = null;
  for (const fileId of fileIds) {
    const existing = local[fileId];
    if (!existing || (!existing.last_read_revision_id && !existing.isFullyRead && !existing.baselineOnly)) {
      continue;
    }
    previousSnapshot.set(fileId, existing);
    if (!next) next = { ...local };
    const cleaned = clearReadBaselineFromState(existing);
    if (cleaned) next[fileId] = cleaned;
    else delete next[fileId];
  }
  return { next: next ?? local, previousSnapshot };
}

/**
 * 前端应用批量确立已读基线结果，并返回逐文件的原状快照（用于 8 秒 Toast 一键 100% 撤销）。
 */
export function applyBatchReadingBaseline(
  local: ReadingStateMap,
  updatedItems: readonly ReadingStateEntryDto[]
): {
  next: ReadingStateMap;
  previousSnapshot: Map<string, ReadingState | undefined>;
} {
  const previousSnapshot = new Map<string, ReadingState | undefined>();
  if (updatedItems.length === 0) {
    return { next: local, previousSnapshot };
  }
  const next: ReadingStateMap = { ...local };
  for (const item of updatedItems) {
    if (!item.file_id || !item.last_read_revision_id) continue;
    const prev = local[item.file_id];
    previousSnapshot.set(item.file_id, prev);
    if (prev) {
      next[item.file_id] = {
        ...prev,
        last_read_revision_id: item.last_read_revision_id,
      };
    } else {
      next[item.file_id] = {
        file_id: item.file_id,
        last_read_revision_id: item.last_read_revision_id,
        scrollPercent: 0,
        isFullyRead: false,
        bookmarked: false,
        updated_at: '',
        baselineOnly: true,
      };
    }
  }
  return { next, previousSnapshot };
}

/**
 * 按原状快照 100% 撤销还原本地 ReadingStateMap：
 * - 精准回退已读基线字段（last_read_revision_id / isFullyRead / baselineOnly）；
 * - 若用户在 8 秒撤销窗口内对某文档新增了收藏、个人批注或滚动位置，还原时予以保留（不丢并发编辑）；
 * - 原未读且未产生任何附加数据的文件彻底删键（无残留）。
 */
export function restoreReadingStatesSnapshot(
  current: ReadingStateMap,
  previousSnapshot: ReadonlyMap<string, ReadingState | undefined>
): ReadingStateMap {
  if (previousSnapshot.size === 0) return current;
  const next: ReadingStateMap = { ...current };
  for (const [fileId, prev] of previousSnapshot.entries()) {
    const cur = current[fileId];
    if (prev === undefined) {
      if (!cur) {
        delete next[fileId];
      } else {
        const cleaned = clearReadBaselineFromState(cur);
        if (cleaned) next[fileId] = cleaned;
        else delete next[fileId];
      }
    } else if (!cur) {
      next[fileId] = prev;
    } else {
      const merged: ReadingState = {
        ...cur,
        last_read_revision_id: prev.last_read_revision_id,
        isFullyRead: prev.isFullyRead,
        baselineOnly: prev.baselineOnly,
      };
      if (prev.last_read_revision_id === undefined) delete merged.last_read_revision_id;
      if (prev.baselineOnly === undefined) delete merged.baselineOnly;
      next[fileId] = merged;
    }
  }
  return next;
}
