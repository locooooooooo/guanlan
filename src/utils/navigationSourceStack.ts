/**
 * Esc「按来源栈精确返回」——导航来源栈（纯函数模块）。
 *
 * 无论从哪层视图进入深视图，按 `Esc` 均可精确返回真实来源视图。
 *
 * 覆盖全应用所有深视图跃迁入口：
 *  - 星图 / 时间轴 / 日历 / 首页 / 命令面板 / 文件时间线打开阅读器；
 *  - 左栏 / 右缘悬浮岛「继续阅读」（openDocResumeReading）；
 *  - 决策雷达 / 首页 / 星图 / 阅读器点击决策引用跳证据原文（handleJumpToSourceEvidence）；
 *  - 阅读器正文内部链接跳转关联文档（A → B → C 支持多级嵌套原路回退）；
 *  - 跨视图按 D 进入多模态版本时光机（enteredTimeMachine 标记：退出时光机一步回原视图）；
 *  - 星图某日跳转时间轴列表（handleJumpToDayInTimeline）。
 *
 * 栈深上限 32（超出丢最旧，防止决策连点无限增长），连续压入同一视图与同一文件时
 * 自动去重，工作区切换或手动顶栏主导航切换时整栈清空。
 */

/** 来源视图快照（进入深视图前的完整可恢复上下文）。 */
export interface NavSourceEntry {
  activeTab: 'home' | 'panorama' | 'library';
  panoramaMode: 'canvas' | 'list' | 'calendar';
  libraryMode: 'read' | 'overview';
  /** 来源视图聚焦的文件（'' = 无文件语境，如全景画布/首页）。 */
  fileId: string;
  revisionId: string;
  /** 可选章节定位（正文内部链接跳回原段落时恢复）。 */
  sectionId?: string;
  /** true = 从非星图视图经 D 键进入多模态时光机；退出时光机后自动弹栈回原视图。 */
  enteredTimeMachine?: boolean;
  /** 压栈入口的人类可读标签（诚实描述从哪来，绝不猜）。 */
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
