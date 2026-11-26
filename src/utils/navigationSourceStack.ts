
/** 来源视图快照（进入深视图前的完整可恢复上下文）。 */
export interface NavSourceEntry {
  activeTab: 'home' | 'panorama' | 'library';
  panoramaMode: 'canvas' | 'list' | 'calendar';
  libraryMode: 'read' | 'overview';
  fileId: string;
  revisionId: string;
  sectionId?: string;
  enteredTimeMachine?: boolean;
  label: string;
  atMs: number;
}

/** 栈深上限：超出丢最旧（与批注证据表 200 上限同一「丢最旧」纪律）。 */
export const MAX_NAV_SOURCE_DEPTH = 32;

/** 按真实视图坐标生成诚实的来源名称（绝不把首页/列表/日历一律写死成「全景溯源星图」）。 */
export function defaultNavSourceLabel(
  activeTab: NavSourceEntry['activeTab'],
  panoramaMode: NavSourceEntry['panoramaMode'],
  libraryMode: NavSourceEntry['libraryMode'],
  fileTitle?: string
): string {
  if (activeTab === 'home') return '今日观澜';
  if (activeTab === 'panorama') {
    if (panoramaMode === 'list') return '观察时间线';
    if (panoramaMode === 'calendar') return '日历看板';
    return '全景溯源星图';
  }
  if (libraryMode === 'overview') return '任务包概览';
  return fileTitle ? `文档：${fileTitle}` : '知识资产库';
}

/** 两条来源快照是否指向同一可视落点（避免同页重复点击堆叠冗余帧）。 */
export function isSameNavSource(a: NavSourceEntry, b: NavSourceEntry): boolean {
  return (
    a.activeTab === b.activeTab &&
    a.panoramaMode === b.panoramaMode &&
    a.libraryMode === b.libraryMode &&
    a.fileId === b.fileId &&
    a.revisionId === b.revisionId &&
    (a.sectionId ?? '') === (b.sectionId ?? '') &&
    Boolean(a.enteredTimeMachine) === Boolean(b.enteredTimeMachine)
  );
}

export function pushNavSource(
  stack: readonly NavSourceEntry[],
  entry: NavSourceEntry
): NavSourceEntry[] {
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  if (top && isSameNavSource(top, entry)) {
    return [...stack.slice(0, -1), entry];
  }
  const next = [...stack, entry];
  return next.length > MAX_NAV_SOURCE_DEPTH
    ? next.slice(next.length - MAX_NAV_SOURCE_DEPTH)
    : next;
}

export function peekNavSource(stack: readonly NavSourceEntry[]): NavSourceEntry | null {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/** 弹栈（空栈返回 null 与原栈，调用方零特判分支）。 */
export function popNavSource(
  stack: readonly NavSourceEntry[]
): { entry: NavSourceEntry | null; stack: NavSourceEntry[] } {
  if (stack.length === 0) return { entry: null, stack: [...stack] };
  return { entry: stack[stack.length - 1], stack: stack.slice(0, -1) };
}

/** Esc 阶梯③·来源栈回退的用户可读文案（面包屑与帮助浮层同源）。 */
export function describeNavSourceReturn(entry: NavSourceEntry): string {
  return `返回${entry.label}`;
}
