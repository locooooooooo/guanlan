/**
 * 专项生命周期提示（PRD §2.2 / F24）——纯函数层。
 *
 * PRD 状态机：Delivered 已交付 ──(用户确认验收 / 超期自动归档)──► Archived 已归档；
 * 「系统自动将文档状态由待用户确认推进为已交付，并提示一键归档」。
 *
 * 本模块只做提示所需的数据判定：
 *  - deliveredInitiativesOf：从 /state-overview 专项行筛出 delivered，按 updated_at
 *    降序（最近更新的先提示）；
 *  - initiativeArchiveWarn：从归档 job result 提取服务端 warn（如「当前非已交付态」），
 *    缺失/非字符串如实 null。
 *
 * 纪律：纯函数（node --test 直跑，禁 .css/React）；不读服务、不造状态。
 */

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
