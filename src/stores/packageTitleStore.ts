/**
 * 任务包标题显示名固化 store（与 PackageGroupFrame 标题 Overlay 配套）。
 *
 * 「双击原位改名」的持久层：按任务包 id（taskPackageOf 派生的稳定 pkgId）固化
 * 用户改定的显示名。边界说明：
 *  - 固化的是「画布显示名」——重新派生（taskPackageOf 路径规则或候选簇
 *    归属固化 adopted_candidate_map）不会把它回退成目录名；
 *  - 不改动磁盘目录名（目录级改名走身份保真移动接口，另行触发）——hover title
 *    恒显真实目录名，绝不冒充文件系统已改名。
 * 模式：canvasThemeStore 同款（localStorage + 内存活值 + 订阅通知；读写全 try/catch
 * 静默降级，node 无 window 环境按空表处理，单测链直接 import 不炸）。
 */

const STORAGE_KEY = 'guanlan.packageTitles.v1';

/** pkgId → 用户固化显示名（空表 = 全部走 taskPackageOf 派生名） */
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
    /* 隐私模式/配额满：静默——显示名固化是增强能力，不是阅读的前置条件 */
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
