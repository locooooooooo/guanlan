/**
 * C05 · 外挂资料阅读位置持久化（按规范化路径稳定哈希持久保留）。
 *
 * 身份口径（契约 contract-storage.md §13）：桶键取**来源工作区 root_key**
 * （参考区库内工作区行身份哈希 = `ws_<root_key>` 的哈希段，由 plain() 规范化
 * 根路径稳定派生、随跨库检索命中逐条下发）——`\\?\` 长路径 / 混合斜杠写法
 * 哈希恒一致，参考区离线 / 卸载重挂 / 服务重启后阅读位置均可恢复。桶内再按
 * file_id（= 该参考区 rootKey|路径 的稳定哈希）定位。
 *
 * 只存指针（file_id / revision_id / 相对路径 / 标题 / 时间），不存正文；
 * 写失败（隐私模式/配额满）静默——持久化是增强能力，不是阅读的前置条件。
 */

const BASE_KEY = 'guanlan.mountReading.v1';

/** 一条外挂资料阅读位置指针 */
export interface MountedReadingEntry {
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  /** 本地时刻 ISO（recordMountedReading 时生成） */
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
      return false; // 同一版本重复记录：不写入（避免 localStorage 无谓 churn）
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
