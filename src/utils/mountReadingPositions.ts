
const BASE_KEY = 'guanlan.mountReading.v1';

/** 一条外挂资料阅读位置指针 */
export interface MountedReadingEntry {
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  at: string;
}

export type MountedReadingMap = Record<string, MountedReadingEntry>;

/** 稳定桶键：来源工作区身份哈希（root_key）为命名空间 */
export function mountReadingStorageKey(workspaceRootKey: string): string {
  const clean = workspaceRootKey.trim();
  return clean ? `${BASE_KEY}.${clean}` : BASE_KEY;
}

function parseEntries(raw: string | null): MountedReadingMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: MountedReadingMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as Partial<MountedReadingEntry>).file_id === 'string' &&
        (value as Partial<MountedReadingEntry>).file_id
      ) {
        next[key] = value as MountedReadingEntry;
      }
    }
    return next;
  } catch {
    return {};
  }
}

/** 读取某参考工作区的阅读位置表（损坏/不可用时退回空表；SSR 安全恒空） */
export function loadMountedReadings(workspaceRootKey: string): MountedReadingMap {
  if (typeof window === 'undefined') return {};
  try {
    return parseEntries(window.localStorage.getItem(mountReadingStorageKey(workspaceRootKey)));
  } catch {
    return {};
  }
}

/** 记录（覆盖同 file_id 旧指针）；写失败静默，不打断阅读。返回是否发生变化。 */
export function recordMountedReading(
  workspaceRootKey: string,
  entry: Omit<MountedReadingEntry, 'at'> & { at?: string }
): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const key = mountReadingStorageKey(workspaceRootKey);
    const map = parseEntries(window.localStorage.getItem(key));
    const next: MountedReadingEntry = {
      file_id: entry.file_id,
      revision_id: entry.revision_id,
      relative_path: entry.relative_path,
      title: entry.title,
      at: entry.at ?? new Date().toISOString(),
    };
    const prev = map[entry.file_id];
    if (
      prev &&
      prev.revision_id === next.revision_id &&
      prev.relative_path === next.relative_path &&
      prev.title === next.title
    ) {
      return false;
    }
    map[entry.file_id] = next;
    window.localStorage.setItem(key, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** 阅读位置表 → 最近查阅条目（at 最新优先；SSR 安全恒空） */
export function latestMountedReadings(
  workspaceRootKey: string,
  limit = 5
): MountedReadingEntry[] {
  const map = loadMountedReadings(workspaceRootKey);
  return Object.values(map)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
