
import type { InitiativeStateView } from '../services/apiTypes';

/** 已交付专项（按 updated_at 降序；最近更新的排前，供一键归档提示取首项） */
export function deliveredInitiativesOf(
  initiatives: readonly InitiativeStateView[]
): InitiativeStateView[] {
  return initiatives
    .filter((initiative) => initiative.state === 'delivered')
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * 归档 job result 的服务端 warn（`result.initiative.warn`）：
 * 非对象/缺字段/空串一律 null；有值原样返回，由 UI 如实展示。
 */
export function initiativeArchiveWarn(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const initiative = (result as { initiative?: unknown }).initiative;
  if (!initiative || typeof initiative !== 'object') return null;
  const warn = (initiative as { warn?: unknown }).warn;
  return typeof warn === 'string' && warn.trim() ? warn : null;
}
