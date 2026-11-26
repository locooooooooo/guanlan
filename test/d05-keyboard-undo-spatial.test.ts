import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildTimelineFocusGroups,
  collectNavigableTimelineEvents,
} from '../src/hooks/useTimelineKeyboardNav';
import {
  buildSpatialNavCards,
  resolveActiveSpatialCard,
} from '../src/components/graph/useCanvasSpatialNav';
import { TopHeader } from '../src/components/TopHeader';
import { TimelineView } from '../src/components/TimelineView';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import type { FileRecord, TimelineEvent } from '../src/types/guanlan';

function makeEvent(id: string, fileId: string, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    event_id: id,
    kind: 'modified',
    file_id: fileId,
    revision_id: `${fileId}_r1`,
    observed_at: '2026-11-21T08:00:00Z',
    source_time: '2026-11-21T08:00:00Z',
    topic_lane: 'docs',
    headline: `更新 ${id}`,
    detail: '变更细节',
    ...extra,
  };
}

function makeFile(fileId: string, relPath: string): FileRecord {
  return {
    file_id: fileId,
    relative_path: relPath,
    title: relPath.split('/').pop() || relPath,
    folder: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.',
    format: 'md',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    coverage: 'full_text',
    current_revision_id: `${fileId}_r1`,
    revisions: [
      {
        revision_id: `${fileId}_r1`,
        file_id: fileId,
        versionNumber: 1,
        observed_at: '2026-11-21T08:00:00Z',
        content_sha256: `sha_${fileId}`,
        sizeBytes: 128,
        snapshotAvailable: true,
        summaryNote: '首版',
      },
    ],
  };
}

test('useTimelineKeyboardNav：折叠组只占 1 步，展开后遍历全成员；三类组归属映射精确', () => {
  const e1 = makeEvent('ev_1', 'f1');
  const b1 = makeEvent('ev_b1', 'f2', { batch_id: 'batch_9' });
  const b2 = makeEvent('ev_b2', 'f3', { batch_id: 'batch_9' });
  const v1 = makeEvent('ev_v1', 'f4');
  const v2 = makeEvent('ev_v2', 'f4');
  const c1 = makeEvent('ev_c1', 'f5');
  const c2 = makeEvent('ev_c2', 'f6');

  const collapsedSeq = collectNavigableTimelineEvents([
    { kind: 'single', members: [e1], isOpen: true },
    { kind: 'batch', members: [b1, b2], isOpen: false },
    { kind: 'version', members: [v1, v2], isOpen: false },
    { kind: 'cluster', members: [c1, c2], isOpen: false },
  ]);
  assert.deepEqual(
    collapsedSeq.map((e) => e.event_id),
    ['ev_1', 'ev_b1', 'ev_v1', 'ev_c1']
  );

  const expandedSeq = collectNavigableTimelineEvents([
    { kind: 'single', members: [e1], isOpen: true },
    { kind: 'batch', members: [b1, b2], isOpen: true },
    { kind: 'version', members: [v1, v2], isOpen: true },
    { kind: 'cluster', members: [c1, c2], isOpen: false },
  ]);
  assert.deepEqual(
    expandedSeq.map((e) => e.event_id),
    ['ev_1', 'ev_b1', 'ev_b2', 'ev_v1', 'ev_v2', 'ev_c1']
  );

  const groups = buildTimelineFocusGroups({
    events: [e1, b1, b2, v1, v2, c1, c2],
    versionGroups: [{ key: 'f4|2026-11-21', members: [v1, v2] }],
    clusterMembers: [{ key: 'ident_x', members: [c1, c2] }],
  });
  assert.equal(groups.has('ev_1'), false);
  assert.equal(groups.get('ev_b2')?.kind, 'batch');
  assert.equal(groups.get('ev_b2')?.headEvent.event_id, 'ev_b1');
  assert.equal(groups.get('ev_v2')?.kind, 'version');
  assert.equal(groups.get('ev_v2')?.headEvent.event_id, 'ev_v1');
  assert.equal(groups.get('ev_c2')?.kind, 'cluster');
  assert.equal(groups.get('ev_c2')?.headEvent.event_id, 'ev_c1');
});

test('useCanvasSpatialNav：构建事件卡 + 富预览卡真实世界中心坐标，富卡选中优先解析', () => {
  const cards = buildSpatialNavCards({
    subAgentCards: [
      { id: 'ev_card_1', fileId: 'f1', revisionId: 'r1' } as never,
      { id: 'ev_card_2', fileId: 'f2', revisionId: 'r2' } as never,
      { id: 'ev_card_3', fileId: 'f3', revisionId: 'r3' } as never,
    ],
    isFanOutCollapsed: true,
    canvasLayoutMode: 'xray',
    nodePositions: {
      ev_card_1: { x: 600, y: 120 },
      ev_card_2: { x: 600, y: 260 },
      ev_card_3: { x: 600, y: 400 },
    },
    defaultPositions: {},
    leftSourceNodes: [{ id: 'src_1', fileId: 'f_src', x: 100, y: 200 }],
    packageLayouts: [
      {
        pkgId: 'pkg_alpha',
        x: 300,
        y: 782,
        docs: [{ fileId: 'f_rich_1' }, { fileId: 'f_rich_2' }],
      },
    ],
  });

  const c3 = cards.find((c) => c.id === 'ev_card_3');
  assert.equal(c3?.hiddenInFold, true);

  const r1 = cards.find((c) => c.fileId === 'f_rich_1');
  const r2 = cards.find((c) => c.fileId === 'f_rich_2');
  assert.ok(r1 && r2);
  assert.ok(r1.x > 300 && r1.y > 782);
  assert.ok(r2.x > r1.x);

  const activeRich = resolveActiveSpatialCard(cards, 'ev_card_1', 'f_rich_2', 'f_rich_2');
  assert.equal(activeRich?.fileId, 'f_rich_2');
  assert.equal(activeRich?.kind, 'rich');
});

test('TopHeader ? 快捷键速查浮层 SSR：关闭态零 DOM，展开态含完整键位与来源栈说明', () => {
  const baseProps = {
    activeTab: 'panorama' as const,
    onSelectTab: () => {},
    searchQuery: '',
    onSearchChange: () => {},
    searchHits: [],
    onSelectSearchHit: () => {},
    unreadFilesCount: 0,
    contextBasketCount: 0,
    eventCount: 2,
    decisions: [],
    onOpenDecision: () => {},
    config: EMPTY_WORKSPACE_CONFIG,
    dataSource: 'real' as const,
    scanSummary: '',
    dataError: '',
    files: [],
    sidebarFilters: {
      quickScope: 'all' as const,
      folder: 'all',
      format: 'all' as const,
      role: 'all' as const,
      topic: 'all',
    },
    onUpdateSidebarFilters: () => {},
    onResetSidebarFilters: () => {},
    libraryMode: 'read' as const,
    onLibraryModeChange: () => {},
    onOpenSettings: () => {},
    onOpenMcpConsole: () => {},
    onOpenContextDrawer: () => {},
  };

  const closedHtml = renderToStaticMarkup(
    React.createElement(TopHeader, { ...baseProps, helpOpen: false })
  );
  assert.equal(closedHtml.includes('data-testid="shortcut-cheatsheet-popover"'), false);

  const openHtml = renderToStaticMarkup(
    React.createElement(TopHeader, { ...baseProps, helpOpen: true })
  );
  assert.ok(openHtml.includes('data-testid="shortcut-cheatsheet-popover"'));
  assert.ok(openHtml.includes('data-esc-layer="open"'));
  for (const snippet of [
    'J / K',
    'H / L',
    'Alt + ↑↓←→',
    'Space',
    'Enter',
    'Ctrl + Z',
    'Ctrl + Shift + Z',
    '按来源栈返回',
    '减少动态效果',
  ]) {
    assert.ok(openHtml.includes(snippet), `速查浮层缺少文本：${snippet}`);
  }
});

test('TimelineView SSR：事件卡渲染 data-event-id 供 J/K/H/L 键盘滚动锚定', () => {
  const f1 = makeFile('f1', 'docs/spec.md');
  const e1 = makeEvent('ev_alpha', 'f1', { headline: '更新规范文档' });
  const html = renderToStaticMarkup(
    React.createElement(TimelineView, {
      events: [e1],
      kindFilter: 'all',
      onKindFilterChange: () => {},
      files: [f1],
      readingStates: {},
      selectedEventId: 'ev_alpha',
      onSelectEvent: () => {},
      onOpenFileFromTimeline: () => {},
      onOpenDecisionFromTimeline: () => {},
    })
  );
  assert.ok(html.includes('data-event-id="ev_alpha"'));
});
