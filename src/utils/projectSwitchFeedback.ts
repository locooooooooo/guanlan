/**
 * 切换项目时的过渡反馈时长。
 *
 * 切换请求本身可能几十毫秒就返回，过渡条若随请求结束而消失会只闪一帧，
 * 看上去像卡顿。这里给一段最短可见时长，让「正在切换」一定被看见。
 */
export const PROJECT_SWITCH_FEEDBACK_MIN_MS = 400;

/**
 * 给定切换已耗时多少毫秒，返回还需要维持过渡条多少毫秒。
 */
export function remainingProjectSwitchFeedbackMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return PROJECT_SWITCH_FEEDBACK_MIN_MS;
  }
  return Math.max(0, PROJECT_SWITCH_FEEDBACK_MIN_MS - elapsedMs);
}
