/**
 * D05 · 全景时间轴（列表态）J/K 上下事件 · H/L 收起展开事项——视图级键盘导航 Hook。
 *
 * 任务卡 D05 改动与产物①：J/K 上下事件、H/L 收起展开事项。监听挂在 TimelineView
 * （事项组折叠状态 collapsedBatches / openIdentityClusters / openVersionHistories 与
 * 选中事件的组归属都在视图内，事件卡点击链 onSelectEvent 直写 store selectedEventId）。
 *
 * 键位（keyboardShortcuts.resolveShortcutActionFromEvent 单一语义源）：
 *  - J = 下一可见事件（列表上新下旧，视觉向下 = 更旧）；K = 上一可见事件（更新）；
 *    折叠态的事项组只占 1 步（代表首事件），按 L 展开后再逐条进入子事件；两端不绕回；
 *  - H = 收起选中事件所属事项组（并将焦点吸附至组头首事件保持高亮可见）；
 *  - L = 展开选中事件所属事项组；无组（single 卡）则仅滚动定位；
 *  - 步进后把选中卡滚入视口（prefers-reduced-motion 动态降级为 behavior:'auto'）。
 *
 * 停机护栏：编辑面 / 浮层打开（hasBlockingDomOverlay + shortcutTargetYields）不生效。
 */
import { useEffect, useRef } from 'react';
import {
  hasBlockingDomOverlay,
  preferredScrollBehavior,
  resolveShortcutActionFromEvent,
  shortcutTargetYields,
} from '../utils/keyboardShortcuts';
import type { TimelineEvent } from '../types/guanlan';

/** 选中事件所属事项组（H/L 折叠目标）。 */
export interface TimelineFocusGroup {
  kind: 'batch' | 'cluster' | 'version';
  /** collapsedBatches / openIdentityClusters / openVersionHistories 的键。 */
  key: string;
  /** 组内首条（最新）事件，收起时吸附焦点到该条使高亮环仍可见。 */
  headEvent: TimelineEvent;
}

export interface TimelineRenderGroupSnapshot {
  kind: 'single' | 'batch' | 'cluster' | 'version';
  /** 组内按展示序排列的全部事件（single 长度 1）。 */
  members: readonly TimelineEvent[];
  /** true = 展开（所有成员可见）；false = 折叠（只停靠首条代表事件）。 */
  isOpen: boolean;
}

/**
 * 渲染分组列表 → 键盘可步进的可见事件序列（纯函数，单测锁定）：
 * 展开组输出全部成员，折叠组只输出首条代表事件——避免按 J 被 87 条折叠拷贝卡住。
 */
export function collectNavigableTimelineEvents(
  groups: readonly TimelineRenderGroupSnapshot[]
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const group of groups) {
    if (group.members.length === 0) continue;
    if (group.kind === 'single' || group.isOpen) {
      for (const ev of group.members) out.push(ev);
    } else {
      out.push(group.members[0]);
    }
  }
  return out;
}

export interface UseTimelineKeyboardNavOptions {
  /** 列表态可见时启用。 */
  enabled: boolean;
  /** 当前可见可步进事件序列（collectNavigableTimelineEvents 产物）。 */
  events: readonly TimelineEvent[];
  selectedEventId: string;
  onSelectEvent: (event: TimelineEvent) => void;
  /** 事件 → 所属事项组（视图内 memo 构建；无组事件不在表中）。 */
  groupByEventId: ReadonlyMap<string, TimelineFocusGroup>;
  /** H 折叠 / L 展开（视图内按 group.kind 分派到三个折叠状态表）。 */
  onCollapseGroup: (group: TimelineFocusGroup, collapsed: boolean) => void;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

export function useTimelineKeyboardNav({
  enabled,
  events,
  selectedEventId,
  onSelectEvent,
  groupByEventId,
  onCollapseGroup,
}: UseTimelineKeyboardNavOptions): void {
  const ctxRef = useRef({
    events,
    selectedEventId,
    onSelectEvent,
    groupByEventId,
    onCollapseGroup,
  });
  useEffect(() => {
    ctxRef.current = {
      events,
      selectedEventId,
      onSelectEvent,
      groupByEventId,
      onCollapseGroup,
    };
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    const scrollSelectedIntoView = (eventId: string) => {
      if (typeof document === 'undefined' || !eventId) return;
      const el = document.querySelector(`[data-event-id="${escapeAttrValue(eventId)}"]`);
      el?.scrollIntoView({
        block: 'nearest',
        behavior: preferredScrollBehavior(),
      });
    };

    const handleKey = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      const overlayOpen = hasBlockingDomOverlay();
      if (shortcutTargetYields(event.target, overlayOpen)) return;
      const action = resolveShortcutActionFromEvent(event, {
        editableTarget: false,
        overlayOpen,
      });
      if (
        action !== 'event-next' &&
        action !== 'event-prev' &&
        action !== 'collapse-focus' &&
        action !== 'expand-focus'
      ) {
        return;
      }
      const {
        events: list,
        selectedEventId: selected,
        onSelectEvent: select,
        groupByEventId: groups,
        onCollapseGroup: collapse,
      } = ctxRef.current;
      if (list.length === 0) return;

      if (action === 'event-next' || action === 'event-prev') {
        const delta = action === 'event-next' ? 1 : -1;
        let currentIdx = list.findIndex((ev) => ev.event_id === selected);
        // 若当前选中事件位于某个已折叠组内部，先折算到其组头位置
        if (currentIdx < 0 && selected) {
          const g = groups.get(selected);
          if (g) currentIdx = list.findIndex((ev) => ev.event_id === g.headEvent.event_id);
        }
        // 无选中：J 落首条（最新），K 落末条；有选中：越界原地（不绕回）
        let nextIdx: number;
        if (currentIdx < 0) {
          nextIdx = delta > 0 ? 0 : list.length - 1;
        } else {
          nextIdx = currentIdx + delta;
          if (nextIdx < 0 || nextIdx >= list.length) return;
        }
        const next = list[nextIdx];
        if (!next) return;
        event.preventDefault();
        select(next);
        scrollSelectedIntoView(next.event_id);
        return;
      }

      // H/L：选中事件所属事项组折叠；无组（single 卡）只滚动定位（诚实无组可折）
      const targetId = selected || (list[0]?.event_id ?? '');
      const group = groups.get(targetId);
      event.preventDefault();
      if (group) {
        const shouldCollapse = action === 'collapse-focus';
        collapse(group, shouldCollapse);
        if (shouldCollapse && group.headEvent.event_id !== targetId) {
          select(group.headEvent);
          scrollSelectedIntoView(group.headEvent.event_id);
          return;
        }
      }
      if (targetId) scrollSelectedIntoView(targetId);
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);
}

/**
 * 事件 → 事项组归属表（视图内构建 helper，TimelineView 以 useMemo 消费；
 * 与渲染分组同源输入：batch_id / versionFold / identityClusters，绝不另造分组规则）。
 */
export function buildTimelineFocusGroups(input: {
  events: readonly TimelineEvent[];
  /** 同文件同日版本组：key → 成员事件列表（首位最新）。 */
  versionGroups: ReadonlyArray<{ key: string; members: readonly TimelineEvent[] }>;
  /** 身份簇（仅 members.length > 1 成簇）：clusterKey → 成员事件列表（首位最新）。 */
  clusterMembers: ReadonlyArray<{ key: string; members: readonly TimelineEvent[] }>;
}): Map<string, TimelineFocusGroup> {
  const map = new Map<string, TimelineFocusGroup>();
  const batchHeads = new Map<string, TimelineEvent>();
  for (const ev of input.events) {
    if (!ev.batch_id) continue;
    let head = batchHeads.get(ev.batch_id);
    if (!head) {
      head = ev;
      batchHeads.set(ev.batch_id, head);
    }
    map.set(ev.event_id, { kind: 'batch', key: ev.batch_id, headEvent: head });
  }
  for (const group of input.versionGroups) {
    const head = group.members[0];
    if (!head) continue;
    for (const ev of group.members) {
      if (!map.has(ev.event_id)) {
        map.set(ev.event_id, { kind: 'version', key: group.key, headEvent: head });
      }
    }
  }
  for (const cluster of input.clusterMembers) {
    if (cluster.members.length <= 1) continue;
    const head = cluster.members[0];
    for (const ev of cluster.members) {
      if (!map.has(ev.event_id)) {
        map.set(ev.event_id, { kind: 'cluster', key: cluster.key, headEvent: head });
      }
    }
  }
  return map;
}
