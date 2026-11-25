import { localDayOf } from './commandPaletteGrammar';

/**
 * 日历窗口事件取数口径。
 *
 * 日历只画主轴窗口内的刻度，不需要整库历史。此前进入日历会沿事件游标一直续拉
 * 到没有下一页，5.6 万文件的工作区就是数千次请求、每页都并进累计事件表并重渲
 * 整棵树。现在只取最近 90 天的一页（≤200 条）；更早历史仍由列表态的「加载更多」
 * 由用户显式触发。
 *
 * 90 天覆盖日历的 30/90 天两档主轴窗口；`from`/`to` 用本地日，与服务端日归属
 * 口径一致（纯日期不做时区换算）。
 */
export const CALENDAR_EVENT_WINDOW_DAYS = 90;
export const CALENDAR_EVENT_PAGE_LIMIT = 200;

export interface CalendarEventWindowQuery {
  from: string;
  to: string;
  limit: number;
  order: 'occurred';
  undated: boolean;
}

/** 以 `today` 为末日，取最近 `windowDays` 个本地日的窗口查询（含首尾两天）。 */
export function calendarWindowEventQuery(
  today: Date,
  windowDays: number = CALENDAR_EVENT_WINDOW_DAYS
): CalendarEventWindowQuery {
  const days = Math.max(1, Math.floor(windowDays));
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - (days - 1)
  );
  return {
    from: localDayOf(start),
    to: localDayOf(today),
    limit: CALENDAR_EVENT_PAGE_LIMIT,
    order: 'occurred',
    undated: false,
  };
}
