
const STORAGE_KEY = 'guanlan.packageTitles.v1';

let overrides: Record<string, string> = loadOverrides();

type Listener = () => void;
const listeners = new Set<Listener>();

function loadOverrides(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
  }
}

/** 订阅显示名表变化（返回退订函数）。消费方：画布 Overlay 标题层。 */
export function subscribePackageTitles(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前显示名表快照（pkgId → 覆盖名；无覆盖的包由调用方回退派生名）。 */
export function getPackageTitleOverrides(): Record<string, string> {
  return overrides;
}

/** 该任务包的显示名：覆盖名优先，无覆盖回退派生名（纯读，零写入）。 */
export function packageDisplayTitle(pkgId: string, derivedName: string): string {
  return overrides[pkgId] ?? derivedName;
}

/** 固化显示名（空串/全空白 = 清除覆盖，回退派生名）。同值短路不通知。 */
export function setPackageTitleOverride(pkgId: string, name: string): void {
  const trimmed = name.trim();
  if (!pkgId) return;
  const next = trimmed ? trimmed : undefined;
  if ((overrides[pkgId] ?? undefined) === next) return;
  if (next === undefined) {
    const { [pkgId]: _removed, ...rest } = overrides;
    overrides = rest;
  } else {
    overrides = { ...overrides, [pkgId]: next };
  }
  persist();
  listeners.forEach((l) => l());
}

/** 仅供测试：清空全部覆盖（切工作区不需要——pkgId 含目录语义，跨区天然隔离）。 */
export function clearPackageTitleOverridesForTest(): void {
  if (Object.keys(overrides).length === 0) return;
  overrides = {};
  persist();
  listeners.forEach((l) => l());
}
