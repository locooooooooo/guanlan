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
  key: string;
  headEvent: TimelineEvent;
}

export interface TimelineRenderGroupSnapshot {
  kind: 'single' | 'batch' | 'cluster' | 'version';
  members: readonly TimelineEvent[];
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
  enabled: boolean;
  events: readonly TimelineEvent[];
  selectedEventId: string;
  onSelectEvent: (event: TimelineEvent) => void;
  groupByEventId: ReadonlyMap<string, TimelineFocusGroup>;
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
        if (currentIdx < 0 && selected) {
          const g = groups.get(selected);
          if (g) currentIdx = list.findIndex((ev) => ev.event_id === g.headEvent.event_id);
        }
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
  versionGroups: ReadonlyArray<{ key: string; members: readonly TimelineEvent[] }>;
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
