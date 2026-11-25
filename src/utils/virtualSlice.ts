/**
 * 5,500+ 真实超大工程轻量视窗切片 / 分批渲染与无痛增量事件并入纯函数。
 *
 * 设计原则：
 *  - 零 DOM / 零第三方依赖，Node SSR 与浏览器客户端 100% 同构；
 *  - 低于阈值（目录直接子文件 <= 150 / 日历目录行 <= 48）时零包裹、零开销，保持既有 DOM 与基线不变；
 *  - 超过阈值时将真实渲染节点数严格压制在视窗预算内（如 5,500 份文件单帧仅渲染 ~35 项），稳守 60fps。
 */

import type { EventPage, EventPageItem } from '../services/workspaceClient';

/** 左栏单目录直接子文件触发轻量视窗切片的阈值（> 150 自动切片）。 */
export const SIDEBAR_FILE_SLICE_THRESHOLD = 150;

/** 左栏虚拟切片默认行高（px，与 SidebarFileLeaf / BranchFileRow py-1 + 12px 文本对齐）。 */
export const SIDEBAR_VIRTUAL_ROW_HEIGHT_PX = 28;

/** 左栏虚拟切片视窗上限高度（px）。 */
export const SIDEBAR_VIRTUAL_VIEWPORT_PX = 420;

/** 左栏虚拟切片上下缓冲行数（overscan）。 */
export const SIDEBAR_VIRTUAL_OVERSCAN = 10;

/** 日历多目录行触发分批渲染护栏的阈值。 */
export const CALENDAR_ROW_SLICE_THRESHOLD = 48;

/** 日历多目录行每次增量展开步长。 */
export const CALENDAR_ROW_SLICE_STEP = 48;

export interface VirtualWindowInput {
  /** 总条目数 */
  totalCount: number;
  /** 当前滚动容器 scrollTop（px） */
  scrollTop: number;
  /** 滚动视窗高度（px） */
  viewportHeight: number;
  /** 单行固定高度（px） */
  rowHeight: number;
  /** 上下预渲染缓冲行数（默认 10） */
  overscan?: number;
  /** 触发虚拟切片的最小条目阈值（默认 150） */
  threshold?: number;
}

export interface VirtualWindowResult {
  /** 是否进入虚拟视窗切片态（totalCount > threshold） */
  virtualized: boolean;
  /** 起始渲染索引（含） */
  startIndex: number;
  /** 结束渲染索引（不含） */
  endIndex: number;
  /** 本帧实际渲染节点数 */
  visibleCount: number;
  /** 顶部占位高度（px） */
  topSpacerPx: number;
  /** 底部占位高度（px） */
  bottomSpacerPx: number;
  /** 虚拟列表总高度（px） */
  totalHeightPx: number;
}

/**
 * 计算固定行高视窗切片边界（纯函数）。
 * 边界护栏：
 *  - totalCount <= 0 → 空切片（全 0）；
 *  - totalCount <= threshold → 不虚拟化，全量 [0, totalCount)；
 *  - 负 scrollTop / 超出底部的 scrollTop → 自动钳位至合法区间 [0, totalCount]；
 *  - 渲染预算恒满足 visibleCount <= ceil(viewportHeight / rowHeight) + 2 * overscan + 1。
 */
export function computeVirtualWindowSlice(input: VirtualWindowInput): VirtualWindowResult {
  const totalCount = Math.max(0, Math.floor(Number.isFinite(input.totalCount) ? input.totalCount : 0));
  const rowHeight = Math.max(1, Number.isFinite(input.rowHeight) ? input.rowHeight : SIDEBAR_VIRTUAL_ROW_HEIGHT_PX);
  const threshold = Math.max(1, Math.floor(input.threshold ?? SIDEBAR_FILE_SLICE_THRESHOLD));
  const totalHeightPx = totalCount * rowHeight;

  if (totalCount === 0) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: 0,
      visibleCount: 0,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      totalHeightPx: 0,
    };
  }

  if (totalCount <= threshold) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: totalCount,
      visibleCount: totalCount,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      totalHeightPx,
    };
  }

  const viewportHeight = Math.max(
    rowHeight,
    Number.isFinite(input.viewportHeight) ? input.viewportHeight : SIDEBAR_VIRTUAL_VIEWPORT_PX
  );
  const overscan = Math.max(0, Math.floor(input.overscan ?? SIDEBAR_VIRTUAL_OVERSCAN));
  const maxScrollTop = Math.max(0, totalHeightPx - viewportHeight);
  const clampedScrollTop = Math.min(
    maxScrollTop,
    Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0)
  );

  const firstVisible = Math.floor(clampedScrollTop / rowHeight);
  const visibleRowsInViewport = Math.ceil(viewportHeight / rowHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(totalCount, firstVisible + visibleRowsInViewport + overscan);
  const visibleCount = Math.max(0, endIndex - startIndex);

  return {
    virtualized: true,
    startIndex,
    endIndex,
    visibleCount,
    topSpacerPx: startIndex * rowHeight,
    bottomSpacerPx: Math.max(0, (totalCount - endIndex) * rowHeight),
    totalHeightPx,
  };
}

export interface ChunkedListSliceResult {
  sliced: boolean;
  visibleCount: number;
  remainingCount: number;
  nextLimit: number;
}

/**
 * 分批渲染切片边界（用于日历多目录行等非固定嵌套高度区，> threshold 自动切片）。
 */
export function computeChunkedListSlice(
  totalCount: number,
  loadedLimit: number,
  threshold: number = CALENDAR_ROW_SLICE_THRESHOLD,
  step: number = CALENDAR_ROW_SLICE_STEP
): ChunkedListSliceResult {
  const safeTotal = Math.max(0, Math.floor(totalCount));
  const safeThreshold = Math.max(1, Math.floor(threshold));
  const safeStep = Math.max(1, Math.floor(step));

  if (safeTotal <= safeThreshold) {
    return {
      sliced: false,
      visibleCount: safeTotal,
      remainingCount: 0,
      nextLimit: safeTotal,
    };
  }

  const clampedLimit = Math.min(
    safeTotal,
    Math.max(safeThreshold, Math.floor(Number.isFinite(loadedLimit) ? loadedLimit : safeThreshold))
  );
  const remainingCount = Math.max(0, safeTotal - clampedLimit);
  return {
    sliced: remainingCount > 0,
    visibleCount: clampedLimit,
    remainingCount,
    nextLimit: Math.min(safeTotal, clampedLimit + safeStep),
  };
}

export interface IncrementalEventMergeResult {
  mergedPage: EventPage;
  addedItems: EventPageItem[];
  addedCount: number;
}

/**
 * 无痛静默并入增量事件页（纯函数）：
 * - 保留用户已加载的历史分页与 next_cursor / has_more，不重置滚动窗口；
 * - 仅将 prev 中尚不存在的 event_id 按到达顺序前置并入，避免重复卡片；
 * - 同步抬升 total_in_window，确保分页总数守恒。
 */
export function mergeIncrementalEventPage(
  prev: EventPage | null,
  incoming: EventPage
): IncrementalEventMergeResult {
  if (!prev) {
    return {
      mergedPage: incoming,
      addedItems: incoming.items,
      addedCount: incoming.items.length,
    };
  }
  const seen = new Set(prev.items.map((item) => item.event_id));
  const addedItems = incoming.items.filter((item) => !seen.has(item.event_id));
  if (addedItems.length === 0) {
    return {
      mergedPage: {
        ...prev,
        total_in_window: Math.max(prev.total_in_window, incoming.total_in_window),
      },
      addedItems: [],
      addedCount: 0,
    };
  }
  return {
    mergedPage: {
      ...prev,
      total_in_window: Math.max(
        prev.total_in_window + addedItems.length,
        incoming.total_in_window
      ),
      items: [...addedItems, ...prev.items],
    },
    addedItems,
    addedCount: addedItems.length,
  };
}
