/**
 * V4 批次（V10–V11）· 司辰时光步进回放、今日/本周沉淀手记、全站键盘流与 5,500 份虚拟化护栏单测集。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DecisionAssertion,
  FileRecord,
  TimelineEvent,
} from '../src/types/guanlan';
import {
  buildChronosDigest,
  chronosReplayIntervalMs,
  stepChronosReplayIndex,
} from '../src/utils/chronosDigest';
import ChronosDigestDrawer from '../src/components/ChronosDigestDrawer';
import HomeView from '../src/components/HomeView';
import ShortcutsCheatSheetModal from '../src/components/ShortcutsCheatSheetModal';
import { VirtualFileSlice } from '../src/components/sidebar/ProjectTreeBranch';
import { CalendarBoardView } from '../src/components/CalendarBoardView';
import { AppBanners } from '../src/components/app/AppBanners';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import type { EventPage } from '../src/services/workspaceClient';
import {
  isShortcutChordPrefix,
  resolveShortcutAction,
  resolveShortcutChord,
  SHORTCUT_CHEATSHEET_GROUPS,
  STORE_SHORTCUT_ACTIONS,
  type RawKeyInput,
} from '../src/utils/keyboardShortcuts';
import {
  CALENDAR_ROW_SLICE_THRESHOLD,
  computeChunkedListSlice,
  computeVirtualWindowSlice,
  mergeIncrementalEventPage,
  SIDEBAR_FILE_SLICE_THRESHOLD,
} from '../src/utils/virtualSlice';

function makeFile(
  id: string,
  relPath: string,
  format: FileRecord['format'],
  summaryNote = '',
  versionNumber = 1
): FileRecord {
  const title = relPath.split('/').pop() ?? relPath;
  const revId = `rev_${id}_v${versionNumber}`;
  return {
    file_id: id,
    relative_path: relPath,
    title,
    format,
    folder: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.',
    role: '方案',
    roleProvenance: '来自路径',
    coverage: 'full_text',
    topics: [],
    current_revision_id: revId,
    revisions: [
      {
        revision_id: revId,
        file_id: id,
        versionNumber,
        content_sha256: `sha_${revId}`,
        sizeBytes: 512,
        observed_at: '2026-11-23T10:00:00+08:00',
        source_time: '2026-11-23',
        snapshotAvailable: true,
        summaryNote,
        changedSectionsFromPrev: [],
      },
    ],
  };
}

function makeEvent(
  id: string,
  fileId: string,
  kind: TimelineEvent['kind'],
  day: string,
  detail = ''
): TimelineEvent {
  return {
    event_id: id,
    kind,
    file_id: fileId,
    revision_id: `rev_${fileId}_v1`,
    observed_at: `${day}T09:30:00+08:00`,
    source_time: day,
    occurred_source: 'document_self',
    occurred_precision: 'day',
    topic_lane: 'docs',
    headline: `事件 ${id}`,
    detail,
    format: 'md',
  };
}

// ===== V10 · 司辰时光步进回放纯函数 =====

test('V10 · stepChronosReplayIndex 与 chronosReplayIntervalMs：日/周步进与倍速护栏', () => {
  // 空/单日边界
  assert.equal(stepChronosReplayIndex([], 0, 1, 'day'), -1);
  assert.equal(stepChronosReplayIndex(['2026-11-23'], 0, 1, 'day'), 0);
  assert.equal(stepChronosReplayIndex(['2026-11-23'], 0, -1, 'week'), 0);

  const dates = [
    '2026-11-01',
    '2026-11-03',
    '2026-11-05',
    '2026-11-08', // +7 days from 11-01
    '2026-11-12',
    '2026-11-16', // +8 days from 11-08
    '2026-11-23', // +7 days from 11-16
  ];

  // 按日步进 + 边界钳位
  assert.equal(stepChronosReplayIndex(dates, 0, 1, 'day'), 1);
  assert.equal(stepChronosReplayIndex(dates, 0, -1, 'day'), 0);
  assert.equal(stepChronosReplayIndex(dates, 6, 1, 'day'), 6);
  assert.equal(stepChronosReplayIndex(dates, 6, -1, 'day'), 5);

  // 按周步进（跨越 >= 7 自然日）
  assert.equal(stepChronosReplayIndex(dates, 0, 1, 'week'), 3, '11-01 +1周应落至 11-08');
  assert.equal(stepChronosReplayIndex(dates, 3, 1, 'week'), 5, '11-08 +1周应落至 11-16');
  assert.equal(stepChronosReplayIndex(dates, 5, 1, 'week'), 6, '11-16 +1周应落至 11-23');
  assert.equal(stepChronosReplayIndex(dates, 6, -1, 'week'), 5, '11-23 -1周应回退至 11-16');
  assert.equal(stepChronosReplayIndex(dates, 5, -1, 'week'), 3, '11-16 -1周应回退至 11-08');
  assert.equal(stepChronosReplayIndex(dates, 2, -1, 'week'), 0, '不足7天应钳位到最早日 0');

  // 倍速节拍 + reduced-motion 安全下限
  assert.equal(chronosReplayIntervalMs(1, false), 1850);
  assert.equal(chronosReplayIntervalMs(2, false), 920);
  assert.ok(chronosReplayIntervalMs(2, true) >= 1400, 'reduced-motion 下 2x 需保底放缓避免频闪');
});

// ===== V10 · 司辰沉淀手记纯函数（空窗 / 单日 / 近 7 日高密 + Markdown 零造数） =====

test('V10 · buildChronosDigest：空窗口、今日与近 7 日高密窗口汇总及标准 Markdown 可溯源导出', () => {
  // 1. 空窗口：零造数、诚实空态
  const emptyDigest = buildChronosDigest([], [], [], 'today', '2026-11-23');
  assert.equal(emptyDigest.totalEvents, 0);
  assert.equal(emptyDigest.addedDocs.length, 0);
  assert.equal(emptyDigest.evolvedDocs.length, 0);
  assert.equal(emptyDigest.topPackages.length, 0);
  assert.ok(emptyDigest.markdown.includes('暂无新的文档演进'));

  // 2. 构造多专项高密真实样本（含噪音路径与候选决策验证过滤）
  const files: FileRecord[] = [
    makeFile('f1', '01-方案文档/架构/核心设计.md', 'md', '确立 coss 原语架构与双时间口径', 3),
    makeFile('f2', '01-方案文档/架构/接口清单.md', 'md', '新增只读快照 API 规范', 1),
    makeFile('f3', '02-研发执行/存储引擎/wal_backup.md', 'md', '升级前 SQLite Backup API 保留 5 份', 2),
    makeFile('f4', '03-测试验收/盲测/report.md', 'md', '1058 份混合文件 5 大任务全绿', 1),
    makeFile('f_noise', 'logs/run-2026112301/tmp.md', 'md', '运行态缓存不应进入手记', 1),
  ];

  const events: TimelineEvent[] = [
    makeEvent('e1', 'f1', 'modified', '2026-11-23', '更新原语章节'),
    makeEvent('e2', 'f1', 'modified', '2026-11-23', '补充暗夜令牌'),
    makeEvent('e3', 'f2', 'appeared', '2026-11-23', '新出现'),
    makeEvent('e4', 'f3', 'modified', '2026-11-20', '补充一致性恢复测试'),
    makeEvent('e5', 'f4', 'appeared', '2026-11-18', '新出现'),
    makeEvent('e_old', 'f4', 'modified', '2026-10-01', '超 7 天窗口'),
    makeEvent('e_noise', 'f_noise', 'appeared', '2026-11-23', '缓存噪音'),
  ];

  const decisions: DecisionAssertion[] = [
    {
      decision_id: 'd1',
      code: 'D-01',
      namespace: 'demo / arch',
      question: '是否全站统一 coss 明暗语义令牌？',
      status: '已确认',
      isCandidateOnly: false,
      options: ['采用'],
      recommendation: '推荐采用',
      confirmationBasis: {
        recordText: '全站采用 OKLCH 语义令牌与一键三态切换',
        confirmer: '架构评审',
        confirmedAt: '2026-11-23T11:00:00+08:00',
        file_id: 'f1',
        revision_id: 'rev_f1_v3',
        lineRange: [12, 18],
      },
      evidences: [
        {
          source_id: 's1',
          file_id: 'f1',
          revision_id: 'rev_f1_v3',
          relative_path: '01-方案文档/架构/核心设计.md',
          lineStart: 12,
          lineEnd: 18,
          observed_at: '2026-11-23T10:00:00+08:00',
          claimedStatus: '已确认',
          exactQuote: '全站采用 OKLCH 语义令牌',
          note: '',
        },
      ],
      impactBlocked: [],
      impactAllowed: [],
      topic: '架构',
    },
    {
      decision_id: 'd2',
      code: 'D-02',
      namespace: 'demo / perf',
      question: '5500+ 目录默认展开切片上限？',
      status: '待确认',
      isCandidateOnly: false,
      options: ['150'],
      recommendation: '建议 150',
      evidences: [
        {
          source_id: 's2',
          file_id: 'f3',
          revision_id: 'rev_f3_v2',
          relative_path: '02-研发执行/存储引擎/wal_backup.md',
          lineStart: 40,
          lineEnd: 44,
          observed_at: '2026-11-20T10:00:00+08:00',
          claimedStatus: '待确认',
          exactQuote: '超过 150 条自动切片',
          note: '',
        },
      ],
      impactBlocked: ['性能验收'],
      impactAllowed: [],
      topic: '性能',
    },
    {
      decision_id: 'd_cand',
      code: 'C-99',
      namespace: 'demo / cand',
      question: '疑似候选不应混入待拍板',
      status: '待确认',
      isCandidateOnly: true,
      options: [],
      recommendation: '',
      evidences: [],
      impactBlocked: [],
      impactAllowed: [],
      topic: '候选',
    },
  ];

  // 今日窗口（2026-11-23）：命中 e1/e2/e3（自动过滤 e_noise、排除 11-20/11-18/10-01）
  const todayDigest = buildChronosDigest(events, files, decisions, 'today', '2026-11-23');
  assert.equal(todayDigest.startDay, '2026-11-23');
  assert.equal(todayDigest.endDay, '2026-11-23');
  assert.equal(todayDigest.totalEvents, 3, '今日应精准统计 3 条核心事件（排除噪音与非今日）');
  assert.equal(todayDigest.addedDocs.length, 1);
  assert.equal(todayDigest.addedDocs[0].fileId, 'f2');
  assert.equal(todayDigest.evolvedDocs.length, 1);
  assert.equal(todayDigest.evolvedDocs[0].fileId, 'f1');
  assert.equal(todayDigest.evolvedDocs[0].versionLabel, 'v3');
  assert.equal(todayDigest.resolvedDecisions.length, 1);
  assert.equal(todayDigest.pendingDecisions.length, 1, '候选决策 isCandidateOnly 必须排除');

  // 近 7 日窗口（2026-11-17 ~ 2026-11-23）：命中 5 条事件（含 11-23 / 11-20 / 11-18，排除 10-01）
  const weekDigest = buildChronosDigest(events, files, decisions, 'week', '2026-11-23');
  assert.equal(weekDigest.startDay, '2026-11-17');
  assert.equal(weekDigest.endDay, '2026-11-23');
  assert.equal(weekDigest.totalEvents, 5);
  assert.equal(weekDigest.activeDaysCount, 3);
  assert.ok(weekDigest.topPackages.length <= 3 && weekDigest.topPackages.length >= 2);
  assert.ok(weekDigest.markdown.includes('guanlan://01-方案文档/架构/核心设计.md'), 'Markdown 必须带可溯源原文链接');
  assert.ok(weekDigest.markdown.includes('最活跃专项 Top 3'));
  assert.ok(weekDigest.markdown.includes('D-01') && weekDigest.markdown.includes('D-02'));
  assert.ok(!weekDigest.markdown.includes('C-99'), '候选决策不得泄露进手记导出');
});

// ===== V10 · ChronosDigestDrawer SSR & 星图回放微轨接线验收 =====

test('V10 · ChronosDigestDrawer (Sheet inset) 与 HomeView / 星图回放微轨接线', () => {
  const f1 = makeFile('f1', '01-方案文档/架构/核心设计.md', 'md', '司辰手记摘要验证', 2);
  const ev1 = makeEvent('e1', 'f1', 'modified', '2026-11-23', '更新章节');

  const drawerHtml = renderToStaticMarkup(
    React.createElement(ChronosDigestDrawer, {
      isOpen: true,
      onClose: () => {},
      events: [ev1],
      files: [f1],
      decisions: [],
      onOpenDocument: () => {},
      onOpenDecision: () => {},
      initialRange: 'today',
      anchorDate: '2026-11-23',
    })
  );
  assert.ok(drawerHtml.includes('data-chronos-digest-drawer="open"'));
  assert.ok(drawerHtml.includes('data-sheet-variant="inset"'), '司辰手记必须采用 coss Sheet inset 悬浮抽屉');
  assert.ok(drawerHtml.includes('data-digest-range="today"') && drawerHtml.includes('data-digest-range="week"'));
  assert.ok(drawerHtml.includes('data-digest-copy-markdown=""'), '必须渲染一键复制 Markdown 按钮');
  assert.ok(drawerHtml.includes('核心设计.md'));

  // HomeView 渲染「司辰手记」入口
  const homeHtml = renderToStaticMarkup(
    React.createElement(HomeView, {
      files: [f1],
      readingStates: {},
      events: [ev1],
      summary: null,
      eventDays: null,
      recentItems: [],
      decisions: [],
      onOpenDoc: () => {},
      onResumeReading: () => {},
      onMarkFullyRead: () => {},
      onOpenPackageBoard: () => {},
      onOpenPanorama: () => {},
      onOpenChronosDigest: () => {},
    })
  );
  assert.ok(homeHtml.includes('data-open-chronos-digest=""'), '首页应渲染「司辰手记」入口');

  // 星图 chrome 具备步进回放微轨（按日/按周 + 1x/2x 倍速 + 司辰手记入口）
  const chromeSrc = readFileSync(
    new URL('../src/components/graph/graphCanvasChrome.tsx', import.meta.url),
    'utf8'
  );
  assert.ok(chromeSrc.includes('data-chronos-replay-rail=""'));
  assert.ok(chromeSrc.includes('data-replay-unit={unit}'));
  assert.ok(chromeSrc.includes('data-replay-speed={spd}'));
  assert.ok(chromeSrc.includes('data-open-chronos-digest=""'));
});

// ===== V11 · 全站键盘流（1/2/3 · G S/C/L · [/]）与输入态/浮层静默保护 =====

function rawKey(
  k: string,
  mods: Partial<Omit<RawKeyInput, 'key'>> = {}
): RawKeyInput {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    isComposing: mods.isComposing ?? false,
  };
}

test('V11 · 全站快捷键（1/2/3、G S/C/L、[/]）解析与输入态/浮层/组字静默保护', () => {
  const openCtx = { editableTarget: false, overlayOpen: false };
  const editCtx = { editableTarget: true, overlayOpen: false };
  const overlayCtx = { editableTarget: false, overlayOpen: true };

  // 单键：主工作区切换 + 左右侧栏折展
  assert.equal(resolveShortcutAction(rawKey('1'), openCtx), 'nav-tab-home');
  assert.equal(resolveShortcutAction(rawKey('2'), openCtx), 'nav-tab-panorama');
  assert.equal(resolveShortcutAction(rawKey('3'), openCtx), 'nav-tab-library');
  assert.equal(resolveShortcutAction(rawKey('['), openCtx), 'toggle-left-sidebar');
  assert.equal(resolveShortcutAction(rawKey(']'), openCtx), 'toggle-right-inspector');

  // 全部归入 STORE_SHORTCUT_ACTIONS
  for (const act of [
    'nav-tab-home',
    'nav-tab-panorama',
    'nav-tab-library',
    'nav-panorama-star',
    'nav-panorama-calendar',
    'nav-panorama-list',
    'toggle-left-sidebar',
    'toggle-right-inspector',
  ] as const) {
    assert.ok(STORE_SHORTCUT_ACTIONS.has(act), `STORE_SHORTCUT_ACTIONS 应包含 ${act}`);
  }

  // 两键和弦：G S / G C / G L
  assert.equal(isShortcutChordPrefix(rawKey('g'), openCtx), 'g');
  assert.equal(isShortcutChordPrefix(rawKey('G'), openCtx), 'g');
  assert.equal(resolveShortcutChord('g', rawKey('s'), openCtx), 'nav-panorama-star');
  assert.equal(resolveShortcutChord('g', rawKey('C'), openCtx), 'nav-panorama-calendar');
  assert.equal(resolveShortcutChord('g', rawKey('l'), openCtx), 'nav-panorama-list');
  assert.equal(resolveShortcutChord('g', rawKey('x'), openCtx), null);

  // 停机线：输入框聚焦 / 浮层打开 / 输入法组字 / 修饰键全部静默让路
  for (const ctx of [editCtx, overlayCtx]) {
    assert.equal(resolveShortcutAction(rawKey('1'), ctx), null);
    assert.equal(resolveShortcutAction(rawKey('['), ctx), null);
    assert.equal(resolveShortcutAction(rawKey(']'), ctx), null);
    assert.equal(isShortcutChordPrefix(rawKey('g'), ctx), null);
    assert.equal(resolveShortcutChord('g', rawKey('s'), ctx), null);
  }
  assert.equal(resolveShortcutAction(rawKey('1', { isComposing: true }), openCtx), null);
  assert.equal(isShortcutChordPrefix(rawKey('g', { ctrlKey: true }), openCtx), null);
  assert.equal(resolveShortcutChord('g', rawKey('c', { metaKey: true }), openCtx), null);
});

// ===== V11 · ShortcutsCheatSheetModal (coss Dialog + Frame + Kbd) SSR =====

test('V11 · ShortcutsCheatSheetModal 渲染完整 Frame 分组、Kbd 徽章与工作区快照', () => {
  const closed = renderToStaticMarkup(
    React.createElement(ShortcutsCheatSheetModal, {
      isOpen: false,
      onClose: () => {},
      activeTab: 'panorama',
      config: EMPTY_WORKSPACE_CONFIG,
      lastScanAt: null,
    })
  );
  assert.equal(closed, '', '关闭态零 DOM');

  const html = renderToStaticMarkup(
    React.createElement(ShortcutsCheatSheetModal, {
      isOpen: true,
      onClose: () => {},
      activeTab: 'panorama',
      config: EMPTY_WORKSPACE_CONFIG,
      lastScanAt: '2026-11-23T10:00:00+08:00',
    })
  );
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('data-shortcuts-dialog="open"'));
  assert.ok(html.includes('data-testid="shortcut-cheatsheet-popover"'));
  assert.ok(html.includes('data-esc-layer="open"'));
  assert.ok(html.includes('data-slot="frame"'), '速查分组必须使用 coss Frame 原语');
  assert.ok(html.includes('data-slot="kbd"'), '快捷键徽章必须使用 coss Kbd 原语');
  for (const group of SHORTCUT_CHEATSHEET_GROUPS) {
    assert.ok(html.includes(`data-shortcut-group="${group.id}"`), `缺少分组 ${group.id}`);
  }
  for (const expectedKey of ['1 / 2 / 3', 'G S', 'G C', 'G L', '[ / ]', 'Z']) {
    assert.ok(html.includes(`data-shortcut-item="${expectedKey}"`), `缺少 V11 键位 ${expectedKey}`);
  }
});

// ===== V11 · 无痛增量事件并入（保留分页与滚动位）与 AppBanners 双选项 =====

test('V11 · mergeIncrementalEventPage 与 AppBanners「静默并入（保持当前位置）」双按钮契约', () => {
  const baseWindow = {
    order: 'occurred' as const,
    from: null,
    to: null,
    kinds: [],
    format: null,
    undated: false,
    q: null,
  };
  const prevPage: EventPage = {
    ok: true,
    index_generation: 1,
    window: baseWindow,
    snapshot_max_seq: 20,
    undated_count: 0,
    newer_count: 1,
    items: [
      {
        event_id: 'ev_2',
        seq: 20,
        kind: 'modified',
        subject_kind: 'file',
        subject_id: 'f1',
        file_id: 'f1',
        revision_id: 'rev_2',
        occurred_at: '2026-11-23',
        observed_at: '2026-11-23T10:00:00+08:00',
        occurred_source: 'document_self',
        occurred_precision: 'day',
        headline: '已有事件 2',
        detail: '',
        payload: {},
        format: 'md',
        file_path: '01-方案文档/架构/核心设计.md',
        file_title: '核心设计.md',
      },
      {
        event_id: 'ev_1',
        seq: 19,
        kind: 'appeared',
        subject_kind: 'file',
        subject_id: 'f1',
        file_id: 'f1',
        revision_id: 'rev_1',
        occurred_at: '2026-11-22',
        observed_at: '2026-11-22T10:00:00+08:00',
        occurred_source: 'document_self',
        occurred_precision: 'day',
        headline: '已有事件 1',
        detail: '',
        payload: {},
        format: 'md',
        file_path: '01-方案文档/架构/核心设计.md',
        file_title: '核心设计.md',
      },
    ],
    total_in_window: 120,
    has_more: true,
    next_cursor: 'cursor_page_2',
  };
  const incomingPage: EventPage = {
    ok: true,
    index_generation: 1,
    window: baseWindow,
    snapshot_max_seq: 21,
    undated_count: 0,
    newer_count: 0,
    items: [
      {
        event_id: 'ev_3',
        seq: 21,
        kind: 'modified',
        subject_kind: 'file',
        subject_id: 'f2',
        file_id: 'f2',
        revision_id: 'rev_3',
        occurred_at: '2026-11-23',
        observed_at: '2026-11-23T11:00:00+08:00',
        occurred_source: 'document_self',
        occurred_precision: 'day',
        headline: '新到达事件 3',
        detail: '',
        payload: {},
        format: 'md',
        file_path: '01-方案文档/架构/接口清单.md',
        file_title: '接口清单.md',
      },
      prevPage.items[0], // 重复项必须去重
    ],
    total_in_window: 121,
    has_more: true,
    next_cursor: 'cursor_page_1_new',
  };

  const { mergedPage, addedCount, addedItems } = mergeIncrementalEventPage(prevPage, incomingPage);
  assert.equal(addedCount, 1, '应仅新增 1 条未见事件并自动去重');
  assert.equal(addedItems[0].event_id, 'ev_3');
  assert.equal(mergedPage.items.length, 3);
  assert.equal(mergedPage.items[0].event_id, 'ev_3');
  assert.equal(mergedPage.next_cursor, 'cursor_page_2', '必须保留原有分页游标，绝不丢滚动/翻页位置');
  assert.equal(mergedPage.total_in_window, 121);

  // AppBanners 同时渲染「静默并入（保持当前位置）」与「刷新进入新窗口」
  const bannerHtml = renderToStaticMarkup(
    React.createElement(AppBanners, {
      ctx: {
        rescanState: 'idle',
        rescanError: '',
        handleRescan: async () => {},
        l4aProgress: null,
        hitlClearedAt: null,
        deliveredInitiative: null,
        deliveredInitiatives: [],
        initiativeLifecycle: null,
        runInitiativeLifecycle: async () => {},
        activeInitiative: null,
        changeNotice: { count: 3, at: '2026-11-23T11:00:00+08:00' },
        refreshEvents: async () => {},
        silentMergeNewEvents: async () => {},
        silentMergingEvents: false,
        dataSource: 'real',
        files: [],
        dataError: '',
        activeTab: 'library',
      } as never,
    })
  );
  assert.ok(bannerHtml.includes('data-silent-merge-events=""'), '必须提供静默并入按钮');
  assert.ok(bannerHtml.includes('静默并入（保持当前位置）'));
  assert.ok(bannerHtml.includes('data-refresh-events-window=""'), '必须保留刷新进入新窗口原契约');
  assert.ok(bannerHtml.includes('刷新进入新窗口'));
});

// ===== V11 · 5,500 份虚拟窗口切片索引边界、渲染预算与日历多目录行护栏 =====

test('V11 · computeVirtualWindowSlice / VirtualFileSlice / CalendarBoardView：5,500 份渲染预算与边界护栏', () => {
  // 1. 低于等于 150 条不虚拟化（零 DOM 变化）
  const small = computeVirtualWindowSlice({
    totalCount: SIDEBAR_FILE_SLICE_THRESHOLD,
    scrollTop: 0,
    viewportHeight: 420,
    rowHeight: 28,
  });
  assert.equal(small.virtualized, false);
  assert.equal(small.startIndex, 0);
  assert.equal(small.endIndex, SIDEBAR_FILE_SLICE_THRESHOLD);

  // 2. 5,500 份文件：顶/中/底/越界滚动渲染预算恒 <= 40 项（稳守 60fps）
  const topSlice = computeVirtualWindowSlice({
    totalCount: 5500,
    scrollTop: -200, // 负滚动自动钳位到 0
    viewportHeight: 420,
    rowHeight: 28,
    overscan: 10,
  });
  assert.equal(topSlice.virtualized, true);
  assert.equal(topSlice.startIndex, 0);
  assert.equal(topSlice.topSpacerPx, 0);
  assert.ok(topSlice.visibleCount <= 36, `顶部渲染数应 <=36，实际 ${topSlice.visibleCount}`);

  const midSlice = computeVirtualWindowSlice({
    totalCount: 5500,
    scrollTop: 2800 * 28,
    viewportHeight: 420,
    rowHeight: 28,
    overscan: 10,
  });
  assert.equal(midSlice.virtualized, true);
  assert.equal(midSlice.startIndex, 2790);
  assert.ok(midSlice.visibleCount <= 36);
  assert.equal(
    midSlice.topSpacerPx + midSlice.visibleCount * 28 + midSlice.bottomSpacerPx,
    5500 * 28,
    '顶部占位 + 渲染区 + 底部占位高度必须严格等于总高度'
  );

  const endSlice = computeVirtualWindowSlice({
    totalCount: 5500,
    scrollTop: 9999999, // 超底滚动自动钳位
    viewportHeight: 420,
    rowHeight: 28,
    overscan: 10,
  });
  assert.equal(endSlice.endIndex, 5500);
  assert.equal(endSlice.bottomSpacerPx, 0);
  assert.ok(endSlice.visibleCount <= 36);

  // 3. VirtualFileSlice SSR 实测 5,500 项：单帧仅挂载 25 项（而非 5,500 项）且耗时极短
  const t0 = performance.now();
  const massiveItems = Array.from({ length: 5500 }, (_, i) => ({
    id: `f_${i}`,
    label: `文档_${i}.md`,
  }));
  const sliceHtml = renderToStaticMarkup(
    React.createElement(
      VirtualFileSlice<{ id: string; label: string }>,
      {
        items: massiveItems,
        getKey: (x) => x.id,
        renderItem: (x) => React.createElement('div', { 'data-vrow': x.id }, x.label),
      }
    )
  );
  const elapsedMs = performance.now() - t0;
  assert.ok(sliceHtml.includes('data-virtual-file-slice="active"'));
  assert.ok(sliceHtml.includes('data-total-files="5500"'));
  const mountedRows = (sliceHtml.match(/data-vrow="/g) || []).length;
  assert.ok(mountedRows > 0 && mountedRows <= 40, `5500 项虚拟切片首帧渲染应 <=40 项，实际 ${mountedRows}`);
  assert.ok(elapsedMs < 250, `5500 项虚拟切片 SSR 应极速完成，实际 ${elapsedMs.toFixed(1)}ms`);

  // 4. 日历多目录行分批切片护栏（>48 行自动切片）
  const chunk = computeChunkedListSlice(80, CALENDAR_ROW_SLICE_THRESHOLD);
  assert.equal(chunk.sliced, true);
  assert.equal(chunk.visibleCount, CALENDAR_ROW_SLICE_THRESHOLD);
  assert.equal(chunk.remainingCount, 32);

  const manyFolderFiles = Array.from({ length: 65 }, (_, i) =>
    makeFile(`cf_${i}`, `dir_${String(i).padStart(2, '0')}/doc_${i}.md`, 'md')
  );
  const calHtml = renderToStaticMarkup(
    React.createElement(CalendarBoardView, {
      files: manyFolderFiles,
      events: [],
      onOpenDocument: () => {},
    })
  );
  assert.ok(calHtml.includes('data-cal-row-slice="active"'), '超过 48 个目录行时日历必须启用分批切片护栏');
  assert.ok(calHtml.includes('data-total-rows="65"'));
  assert.ok(calHtml.includes(`data-rendered-rows="${CALENDAR_ROW_SLICE_THRESHOLD}"`));
});
