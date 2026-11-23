/**
 * V2 批次 · V04 存量降噪、智能中段省略、>= 15 高密边界、批量已读基线与撤销还原、LeftSidebar coss 升级单测
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildMergedFolderTree,
  computeSiblingSharedPrefixMap,
  filterFolderTreeByQuery,
  filterOutMutedFolders,
  filterPanoramaEventDays,
  filterPanoramaEventPage,
  formatMiddleEllipsisName,
  isFileInMutedFolder,
  isFolderMuted,
  mutedFoldersStorageKey,
  sortFolderTreeNodes,
  splitQuickFilterHighlight,
  toggleMutedFolderList,
} from '../src/utils/sidebarTree';
import { RightInspector } from '../src/components/RightInspector';
import type { EventDaysResult, EventPage } from '../src/services/apiTypes';
import {
  applyBatchReadingBaseline,
  mergeServerReadingStates,
  restoreReadingStatesSnapshot,
  type ReadingStateMap,
} from '../src/utils/readingStateStore';
import { hasUnreadChanges } from '../src/utils/guanlanEngine';
import {
  LeftSidebar,
  summarizeFolderActivity,
} from '../src/components/LeftSidebar';
import { SIDEBAR_DENSE_FOLDER_THRESHOLD } from '../src/components/sidebar/ProjectTreeBranch';
import { FileContextMenu } from '../src/components/FileContextMenu';
import {
  CALENDAR_SLOT_HEAT_DOT_MAX_PX,
  CALENDAR_SLOT_PILLS_CHIP_MIN_PX,
  CALENDAR_WINDOW_DEFAULT,
  CALENDAR_WINDOW_FORTNIGHT,
  CALENDAR_WINDOW_OPTIONS,
  CALENDAR_WINDOW_SHORT,
  CALENDAR_WINDOW_WEEK,
  CalendarBoardView,
  resolveCalendarSlotMode,
} from '../src/components/CalendarBoardView';
import {
  CalendarSidePanels,
  partitionCalendarDensityMonths,
} from '../src/components/CalendarSidePanels';
import {
  classifyAssetDomain,
  countAssetsByDomain,
  filterAssetsByDomain,
} from '../src/utils/formatMeta';
import type { FileRecord, ReadingState, TimelineEvent } from '../src/types/guanlan';

function makeFile(
  id: string,
  title: string,
  folder = '01-方案',
  rev = 'r1',
  format: FileRecord['format'] = 'md'
): FileRecord {
  const rel = folder === '.' ? `${title}.${format}` : `${folder}/${title}.${format}`;
  return {
    file_id: id,
    relative_path: rel,
    title,
    format,
    folder,
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: rev,
    revisions: [
      {
        revision_id: rev,
        file_id: id,
        versionNumber: 1,
        observed_at: '2026-11-23T08:00:00Z',
        content_sha256: `sha_${id}_${rev}`,
        sizeBytes: 128,
        snapshotAvailable: true,
        summaryNote: title,
      },
    ],
    coverage: 'full_text',
  };
}

test('V04 · formatMiddleEllipsisName 覆盖中英文、带扩展名、短文件名与同前缀差异保留', () => {
  // 短文件名原样返回
  assert.equal(formatMiddleEllipsisName('README.md', 0, 22), 'README.md');
  assert.equal(formatMiddleEllipsisName('架构设计说明.md', 0, 22), '架构设计说明.md');

  // 真实 5500+ 同前缀长 SVG 文件名：必须保留后缀差异词与扩展名，避免全列撞成同一前缀
  const names = [
    '2D与3D绘制预览优化方案-v1.svg',
    '2D与3D绘制预览优化方案-v2.svg',
    '2D与3D绘制预览优化方案-final.svg',
    'README.md', // 异类兄弟不应干扰同簇前缀识别
  ];
  const prefixMap = computeSiblingSharedPrefixMap(names);
  assert.ok(
    (prefixMap.get('2D与3D绘制预览优化方案-v1.svg') ?? 0) >= 12,
    '同簇兄弟应准确识别公共前缀长度（不被 README.md 归零）'
  );
  assert.equal(prefixMap.get('README.md'), 0, '异类 README.md 不应误计共享前缀');

  const outV1 = formatMiddleEllipsisName(
    '2D与3D绘制预览优化方案-v1.svg',
    prefixMap.get('2D与3D绘制预览优化方案-v1.svg') ?? 0,
    14
  );
  const outV2 = formatMiddleEllipsisName(
    '2D与3D绘制预览优化方案-v2.svg',
    prefixMap.get('2D与3D绘制预览优化方案-v2.svg') ?? 0,
    14
  );
  assert.ok(outV1.includes('…'), '超长文件名应中段省略');
  assert.ok(outV1.endsWith('-v1.svg') || outV1.endsWith('v1.svg'), `应保留差异后缀与扩展名，实际：${outV1}`);
  assert.ok(outV2.endsWith('-v2.svg') || outV2.endsWith('v2.svg'), `应保留差异后缀与扩展名，实际：${outV2}`);
  assert.notEqual(outV1, outV2, '同前缀不同版本的省略结果必须清晰可区分');
  assert.ok(Array.from(outV1).length <= 14, `省略后字符数应不超过 maxChars=14，实际：${Array.from(outV1).length}`);

  // 英文长文件名带扩展名
  const en = formatMiddleEllipsisName('architecture-migration-proposal-phase-2-revised.tsx', 31, 22);
  assert.ok(en.endsWith('.tsx'), `英文文件应保留扩展名，实际：${en}`);
  assert.ok(en.includes('…'));
  assert.ok(Array.from(en).length <= 22);

  // 无扩展名中文长标题（无共享前缀）
  const cnNoExt = formatMiddleEllipsisName('面向万级工作区文件治理的全链路性能基准分析报告终版', 0, 16);
  assert.ok(cnNoExt.includes('…'));
  assert.ok(Array.from(cnNoExt).length <= 16);
  assert.ok(cnNoExt.startsWith('面向'), '应保留开头主题词');
  assert.ok(cnNoExt.endsWith('终版'), '应保留尾部差异词');
});

test('V04 · 高密目录降噪阈值调优至 >= 15（14 否、15 是、16 是）', () => {
  assert.equal(SIDEBAR_DENSE_FOLDER_THRESHOLD, 15);
  const makeBatch = (n: number) =>
    Array.from({ length: n }, (_, i) => makeFile(`f_${i}`, `doc-${i}`));

  const s14 = summarizeFolderActivity({
    directFiles: makeBatch(14),
    readingStates: {},
    artifactsByFileId: null,
    nowMs: Date.now(),
  });
  const s15 = summarizeFolderActivity({
    directFiles: makeBatch(15),
    readingStates: {},
    artifactsByFileId: null,
    nowMs: Date.now(),
  });
  const s16 = summarizeFolderActivity({
    directFiles: makeBatch(16),
    readingStates: {},
    artifactsByFileId: null,
    nowMs: Date.now(),
  });
  assert.equal(s14.isDense, false, '14 份直接子文件不应触发高密降噪');
  assert.equal(s15.isDense, true, '15 份直接子文件即触发 >= 15 高密降噪');
  assert.equal(s16.isDense, true, '16 份直接子文件触发高密降噪');
});

test('V04 · 批量确立已读基线不伪造 scrollPercent、不丢收藏批注、撤销 100% 无损还原且新改文件重新亮起未读', () => {
  const f1 = makeFile('f1', '已读旧版', '01-方案', 'r1_v2');
  const f2 = makeFile('f2', '从未读过', '01-方案', 'r2_v1');

  const initial: ReadingStateMap = {
    f1: {
      file_id: 'f1',
      last_read_revision_id: 'r1_v1',
      scrollPercent: 48,
      isFullyRead: false,
      bookmarked: true,
      personalNote: '重要批注',
      updated_at: '2026-11-22T10:00:00+08:00',
    },
  };

  const { next, previousSnapshot } = applyBatchReadingBaseline(initial, [
    { file_id: 'f1', last_read_revision_id: 'r1_v2', updated_at: '2026-11-23T09:00:00Z' },
    { file_id: 'f2', last_read_revision_id: 'r2_v1', updated_at: '2026-11-23T09:00:00Z' },
  ]);

  // 两份均变为已读基线最新
  assert.equal(hasUnreadChanges(f1, next.f1).isUnread, false);
  assert.equal(hasUnreadChanges(f2, next.f2).isUnread, false);

  // f1 原有进度/收藏/批注完好保留；f2 绝不伪造 scrollPercent，且标记 baselineOnly
  assert.equal(next.f1.scrollPercent, 48);
  assert.equal(next.f1.bookmarked, true);
  assert.equal(next.f1.personalNote, '重要批注');
  assert.equal(next.f2.scrollPercent, 0, '绝不伪造 scrollPercent');
  assert.equal(next.f2.isFullyRead, false);
  assert.equal(next.f2.baselineOnly, true);
  assert.equal(next.f2.updated_at, '', '不污染最近浏览排序');

  // 后续仅 f2 产生新版本 r2_v2 -> 仅 f2 重新亮起未读
  const f2Updated = makeFile('f2', '从未读过', '01-方案', 'r2_v2');
  assert.equal(hasUnreadChanges(f1, next.f1).isUnread, false);
  assert.equal(hasUnreadChanges(f2Updated, next.f2).isUnread, true);
  assert.equal(hasUnreadChanges(f2Updated, next.f2).reason, 'updated_since_last_read');

  // 撤销还原：100% 回到原状（f1 回到 r1_v1，f2 彻底删除键）
  const restored = restoreReadingStatesSnapshot(next, previousSnapshot);
  assert.equal(restored.f1?.last_read_revision_id, 'r1_v1');
  assert.equal(restored.f1?.bookmarked, true);
  assert.equal(restored.f2, undefined, '原未读文件撤销后应完全恢复未读（无残留键）');

  // mergeServerReadingStates 合并验证
  const merged = mergeServerReadingStates(initial, [
    { file_id: 'f1', last_read_revision_id: 'r1_v2', updated_at: '2026-11-23T09:00:00Z' },
    { file_id: 'f2', last_read_revision_id: 'r2_v1', updated_at: '2026-11-23T09:00:00Z' },
  ]);
  assert.equal(merged.f1.last_read_revision_id, 'r1_v2');
  assert.equal(merged.f1.personalNote, '重要批注');
  assert.equal(merged.f2.scrollPercent, 0);
  assert.equal(merged.f2.baselineOnly, true);
});

test('V04 · LeftSidebar 渲染 coss SegmentedControl / ScrollArea / 确立已读基线入口，且目录右键菜单含「本目录全部标为已读」', () => {
  const files = [
    makeFile('f1', '2D与3D绘制预览优化方案-v1.svg', '.', 'r1', 'svg'),
    makeFile('f2', '2D与3D绘制预览优化方案-v2.svg', '.', 'r1', 'svg'),
  ];
  const readingStates: Record<string, ReadingState> = {
    f2: {
      file_id: 'f2',
      last_read_revision_id: 'r1',
      scrollPercent: 0,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '',
      baselineOnly: true,
    },
  };
  const sidebarHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files,
      readingStates,
      activeFileId: 'f1',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
      onMarkReadingBaseline: () => {},
    })
  );

  assert.ok(sidebarHtml.includes('data-slot="segmented-control"'), '顶栏范围筛选应换装 coss SegmentedControl');
  assert.ok(sidebarHtml.includes('data-slot="scroll-area"'), '目录树应接入 coss ScrollArea');
  assert.ok(sidebarHtml.includes('data-mark-baseline-trigger=""'), '存在未读时应展示确立已读基线入口');
  assert.ok(
    !sidebarHtml.includes('data-continue-reading-row="f2"'),
    '纯 baselineOnly 文件不得污染「继续阅读」区'
  );

  const menuHtml = renderToStaticMarkup(
    React.createElement(FileContextMenu, {
      menu: { x: 100, y: 100, target: { kind: 'folder', relativePath: '01-方案', title: '01-方案' } },
      onClose: () => {},
      desktopSupported: true,
      hasRootPath: true,
      onRevealInExplorer: () => {},
      onOpenWithDefaultApp: () => {},
      onCopyRelativePath: () => {},
      onCopyAbsolutePath: () => {},
      onMarkFolderRead: () => {},
    })
  );
  assert.ok(menuHtml.includes('data-menu-action="mark-folder-read"'), '目录右键菜单应含「本目录全部标为已读」');
  assert.ok(menuHtml.includes('本目录全部标为已读'));
});

// ===== V05 · 5,500+ 高密日历 CardFrame 重构、零碰撞分流、四档窗口、域过滤守恒与空月归档 =====

function makeDatedFile(
  id: string,
  day: string,
  folder = '01-业务方案',
  format: FileRecord['format'] = 'md'
): FileRecord {
  const f = makeFile(id, `${id}`, folder, `rev_${id}`, format);
  f.revisions[0].source_time = day;
  return f;
}

function makeEvent(id: string, fileId: string, day: string): TimelineEvent {
  return {
    event_id: id,
    kind: 'modified',
    file_id: fileId,
    revision_id: `rev_${fileId}`,
    observed_at: `${day}T09:00:00Z`,
    source_time: day,
    topic_lane: 'docs',
    headline: `变动 ${id}`,
    detail: '',
  } as unknown as TimelineEvent;
}

test('V05 · resolveCalendarSlotMode 四档列宽零碰撞分流与 15 天连续百文日渲染验证', () => {
  assert.deepEqual([...CALENDAR_WINDOW_OPTIONS], [7, 14, 30, 90]);
  assert.equal(CALENDAR_WINDOW_WEEK, 7);
  assert.equal(CALENDAR_WINDOW_FORTNIGHT, 14);
  assert.equal(CALENDAR_WINDOW_SHORT, 30);
  assert.equal(CALENDAR_WINDOW_DEFAULT, 90);

  // ≤3 份一律 pills
  assert.equal(resolveCalendarSlotMode(22, 1, true), 'pills');
  assert.equal(resolveCalendarSlotMode(22, 3, true), 'pills');
  // 极窄 90 天宽窗 (<= 13px) → heat_dot
  assert.equal(resolveCalendarSlotMode(CALENDAR_SLOT_HEAT_DOT_MAX_PX, 100, true), 'heat_dot');
  assert.equal(resolveCalendarSlotMode(7.3, 152, false), 'heat_dot');
  // 连续 15 天百文日在 30 天(22px) / 14 天(47px) → 确定性退化为 compact_heat（绝不撞车）
  assert.equal(resolveCalendarSlotMode(22, 100, true), 'compact_heat');
  assert.equal(resolveCalendarSlotMode(47, 100, true), 'compact_heat');
  assert.equal(resolveCalendarSlotMode(CALENDAR_SLOT_PILLS_CHIP_MIN_PX - 1, 36, true), 'compact_heat');
  // 宽列（近 7 天 ~94px）或无 2 日内邻槽的孤立槽 → pills_with_chip
  assert.equal(resolveCalendarSlotMode(CALENDAR_SLOT_PILLS_CHIP_MIN_PX, 100, true), 'pills_with_chip');
  assert.equal(resolveCalendarSlotMode(94, 100, true), 'pills_with_chip');
  assert.equal(resolveCalendarSlotMode(22, 7, false), 'pills_with_chip');

  // 真实 15 天连续每天 100 份文件（1,500 份）在默认 30 天窗口渲染：全部转为紧凑热力格（99+），零宽芯片撞车
  const files15Days: FileRecord[] = [];
  for (let d = 8; d <= 22; d += 1) {
    const day = `2026-11-${String(d).padStart(2, '0')}`;
    for (let k = 0; k < 100; k += 1) {
      files15Days.push(makeDatedFile(`d${d}_f${k}`, day, '01-高频迭代'));
    }
  }
  const html = renderToStaticMarkup(
    React.createElement(CalendarBoardView, {
      files: files15Days,
      events: [makeEvent('ev1', 'd22_f0', '2026-11-22')],
      onOpenDocument: () => {},
    })
  );
  assert.ok(html.includes('data-slot="card-frame"'), '日历主板应使用 coss CardFrame');
  assert.ok(html.includes('data-slot="toolbar"'), '顶栏控件应接入 coss Toolbar');
  assert.ok(html.includes('data-slot="segmented-control"'), '四档窗口切换应使用 coss SegmentedControl');
  assert.ok(html.includes('data-slot="scroll-area"'), '主体应使用 coss ScrollArea');
  for (const n of [7, 14, 30, 90]) {
    assert.ok(html.includes(`data-window-days="${n}"`), `应存在近 ${n} 天切换档`);
  }
  const compactMatches = html.match(/data-slot-compact="100"/g) ?? [];
  assert.equal(compactMatches.length, 15, '连续 15 天百文日必须 100% 退化为 15 枚居中紧凑热力格');
  assert.ok(!html.includes('>+100</button>'), '连续百文日不得出现必然撞车的 +100 宽芯片');
  // 事件刻度位于 sticky bottom-0 栈内，防止被下方摘要条裁切
  const stickyIdx = html.indexOf('sticky bottom-0');
  const eventsRowIdx = html.indexOf('data-cal-row="__events__"');
  assert.ok(stickyIdx > 0 && eventsRowIdx > stickyIdx, '事件刻度行应纳入 sticky bottom-0 栈顶，杜绝裁切');
});

test('V05 · 域过滤 SSOT 严格满足 MECE 计数守恒（all === business + code）并一键滤除工程代码噪点', () => {
  const files: FileRecord[] = [
    ...Array.from({ length: 120 }, (_, i) => makeDatedFile(`biz_md_${i}`, '2026-11-20', '01-产品方案', 'md')),
    ...Array.from({ length: 40 }, (_, i) => makeDatedFile(`biz_svg_${i}`, '2026-11-20', '02-图纸', 'svg')),
    ...Array.from({ length: 15 }, (_, i) => makeDatedFile(`biz_pdf_${i}`, '2026-11-21', '03-交付', 'pdf')),
    ...Array.from({ length: 340 }, (_, i) => makeDatedFile(`code_ts_${i}`, '2026-11-21', '04-智能体代码', 'ts')),
    ...Array.from({ length: 25 }, (_, i) => makeDatedFile(`code_json_${i}`, '2026-11-22', '04-智能体代码', 'json')),
  ];
  const events: TimelineEvent[] = [
    makeEvent('e1', 'biz_md_0', '2026-11-20'),
    makeEvent('e2', 'biz_svg_0', '2026-11-20'),
    makeEvent('e3', 'code_ts_0', '2026-11-21'),
    makeEvent('e4', 'code_json_0', '2026-11-22'),
  ];

  assert.equal(classifyAssetDomain('md'), 'business');
  assert.equal(classifyAssetDomain('svg'), 'business');
  assert.equal(classifyAssetDomain('pdf'), 'business');
  assert.equal(classifyAssetDomain('docx'), 'business');
  assert.equal(classifyAssetDomain('ts'), 'code');
  assert.equal(classifyAssetDomain('py'), 'code');
  assert.equal(classifyAssetDomain('json'), 'code');

  const counts = countAssetsByDomain(files);
  assert.equal(counts.all, 540);
  assert.equal(counts.business, 175);
  assert.equal(counts.code, 365);
  assert.equal(counts.business + counts.code, counts.all, '业务文档 + 工程代码 === 全部资产（严格守恒）');

  const bizOnly = filterAssetsByDomain(files, events, 'business');
  assert.equal(bizOnly.files.length, 175);
  assert.equal(bizOnly.events.length, 2, '仅保留业务文档关联事件，源码事件一并滤除');
  assert.ok(bizOnly.files.every((f) => f.folder !== '04-智能体代码'));

  const codeOnly = filterAssetsByDomain(files, events, 'code');
  assert.equal(codeOnly.files.length, 365);
  assert.equal(codeOnly.events.length, 2);

  const all = filterAssetsByDomain(files, events, 'all');
  assert.equal(all.files.length, 540);
  assert.equal(all.events.length, 4);
});

test('V05 · 迷你热力月历超 12 个连续空月折叠为「更早归档」胶囊，消除「跳过 149 个空月」噪音', () => {
  const partitioned = partitionCalendarDensityMonths([
    { month: '2026-11' },
    { month: '2026-10' }, // 0 空月：不折叠
    { month: '2026-03' }, // 6 空月 (<= 12)：不折叠
    { month: '2013-10' }, // 148 空月 (> 12)：插入「更早归档」胶囊
  ]);
  assert.equal(partitioned.hasAncientGap, true);
  assert.equal(partitioned.ancientGapCount, 1);
  assert.equal(partitioned.entries.length, 5);
  const gap = partitioned.entries[3];
  assert.equal(gap.kind, 'archive_gap');
  if (gap.kind === 'archive_gap') {
    assert.equal(gap.emptyMonths, 148);
    assert.ok(gap.label.includes('更早归档'));
  }

  // 渲染验证：存在 149+ 空月跨度时，可见文案展示「含更早归档」+ 胶囊，不展示刺眼的「· 跳过 156 个空月」正文
  const sideHtml = renderToStaticMarkup(
    React.createElement(CalendarSidePanels, {
      files: [makeDatedFile('a', '2026-11-20')],
      events: [
        makeEvent('ev_old', 'a', '2013-10-16'),
        makeEvent('ev_new', 'a', '2026-11-20'),
      ],
      recentItems: [],
      onOpenDocument: () => {},
    })
  );
  assert.ok(sideHtml.includes('data-slot="scroll-area"'), '右侧栏应接入 coss ScrollArea');
  assert.ok(sideHtml.includes('data-density-archive-gap="156"'), '应渲染「更早归档」断层胶囊');
  assert.ok(sideHtml.includes('含更早归档'), '顶部次行改为优雅的「含更早归档」');
  assert.ok(!sideHtml.includes('· 跳过 156 个空月'), '消除「· 跳过 156 个空月」可见文本噪音');
});

// =========================================================================
// V06 · 目录级静默与忽略治理 UI + 左栏 InputGroup 快筛、三态排序与 PreviewCard 速览
// =========================================================================

test('V06 · 目录静默清单同源过滤一致性（星图/日历/列表 + EventPage + EventDays + 嵌套子目录继承）', () => {
  // 工作区私有存储键独立隔离（不向业务目录写磁盘文件）
  assert.equal(mutedFoldersStorageKey('ws_alpha'), 'guanlan.mutedFolders.v1.ws_alpha');
  assert.notEqual(mutedFoldersStorageKey('ws_alpha'), mutedFoldersStorageKey('ws_beta'));

  const muted = toggleMutedFolderList([], '04-智能体代码/');
  assert.deepEqual(muted, ['04-智能体代码']);
  assert.equal(isFolderMuted('04-智能体代码', muted), true);
  assert.equal(isFolderMuted('04-智能体代码/src/agents', muted), true, '子目录应继承父目录静默态');
  assert.equal(isFolderMuted('04-智能体代码-说明', muted), false, '不应误伤前缀相似的兄弟目录');

  const files: FileRecord[] = [
    makeFile('f_biz', '产品方案', '01-方案', 'r1', 'md'),
    makeFile('f_code_root', 'agent', '04-智能体代码', 'r2', 'ts'),
    makeFile('f_code_nested', 'helper', '04-智能体代码/utils', 'r3', 'py'),
    makeFile('f_keep_sibling', '说明', '04-智能体代码-说明', 'r4', 'md'),
  ];
  const events: TimelineEvent[] = [
    makeEvent('e_biz', 'f_biz', '2026-11-23'),
    makeEvent('e_code_root', 'f_code_root', '2026-11-23'),
    makeEvent('e_code_nested', 'f_code_nested', '2026-11-22'),
    makeEvent('e_keep_sibling', 'f_keep_sibling', '2026-11-22'),
    // 工作区基线事件（无关联 file_id）应保留
    makeEvent('e_ws_base', '', '2026-11-20'),
  ];

  // 星图 / 日历同源过滤
  const filtered = filterOutMutedFolders(files, events, muted);
  assert.equal(filtered.mutedFileCount, 2);
  assert.deepEqual(
    filtered.files.map((f) => f.file_id),
    ['f_biz', 'f_keep_sibling']
  );
  assert.deepEqual(
    filtered.events.map((e) => e.event_id),
    ['e_biz', 'e_keep_sibling', 'e_ws_base']
  );
  assert.equal(isFileInMutedFolder(files[2], muted), true);
  assert.equal(isFileInMutedFolder(files[3], muted), false);

  // 列表分页 EventPage 同源过滤（静默 + 资产域联合）
  const mockPage: EventPage = {
    ok: true,
    index_generation: 1,
    window: { order: 'occurred', from: null, to: null, kinds: [], format: null, undated: false, q: null },
    snapshot_max_seq: 10,
    total_in_window: 4,
    undated_count: 0,
    newer_count: 0,
    next_cursor: null,
    has_more: false,
    items: [
      {
        seq: 1,
        event_id: 'e_biz',
        kind: 'modified',
        subject_kind: 'file',
        subject_id: 'f_biz',
        revision_id: 'r1',
        occurred_at: '2026-11-23T08:00:00Z',
        occurred_precision: 'day',
        occurred_source: 'file_mtime',
        observed_at: '2026-11-23T08:00:00Z',
        headline: '产品方案',
        detail: '',
        payload: {},
        file_id: 'f_biz',
        file_path: '01-方案/产品方案.md',
        file_title: '产品方案',
        format: 'md',
      },
      {
        seq: 2,
        event_id: 'e_code_nested',
        kind: 'modified',
        subject_kind: 'file',
        subject_id: 'f_code_nested',
        revision_id: 'r3',
        occurred_at: '2026-11-22T08:00:00Z',
        occurred_precision: 'day',
        occurred_source: 'file_mtime',
        observed_at: '2026-11-22T08:00:00Z',
        headline: 'helper',
        detail: '',
        payload: {},
        file_id: 'f_code_nested',
        file_path: '04-智能体代码/utils/helper.py',
        file_title: 'helper',
        format: 'py',
      },
      {
        seq: 3,
        event_id: 'e_ws_base',
        kind: 'workspace_baseline',
        subject_kind: 'workspace',
        subject_id: 'ws_1',
        revision_id: null,
        occurred_at: '2026-11-20T08:00:00Z',
        occurred_precision: 'day',
        occurred_source: 'collector',
        observed_at: '2026-11-20T08:00:00Z',
        headline: '基线建立',
        detail: '',
        payload: {},
        file_id: null,
        file_path: null,
        file_title: null,
        format: null,
      },
    ],
  };
  const pageFiltered = filterPanoramaEventPage(mockPage, muted, 'all');
  assert.ok(pageFiltered);
  assert.deepEqual(
    pageFiltered.items.map((it) => it.event_id),
    ['e_biz', 'e_ws_base'],
    '列表分页 EventPage 应与星图/日历执行完全一致的静默目录排除'
  );

  // 星图日桶 EventDaysResult 同源过滤
  const mockDays: EventDaysResult = {
    ok: true,
    index_generation: 1,
    order: 'occurred',
    granularity: 'day',
    from: null,
    to: null,
    total: 2,
    hidden_days: 0,
    undated_count: 0,
    groups: [
      {
        date: '2026-11-23',
        count: 1,
        by_kind: { modified: 1 },
        formats: { md: 1 },
        decisions: [],
        samples: [
          {
            event_id: 'e_biz',
            kind: 'modified',
            headline: '产品方案',
            revision_id: 'r1',
            file_id: 'f_biz',
            file_path: '01-方案/产品方案.md',
            file_title: '产品方案',
            file_role: '方案',
            format: 'md',
            occurred_at: '2026-11-23T08:00:00Z',
            occurred_precision: 'day',
            observed_at: '2026-11-23T08:00:00Z',
            time_basis: 'file_mtime',
            action: null,
            decision_id: null,
            code: null,
            status: null,
            ref_count: 0,
            version_count: 1,
            statement_count: 0,
          },
        ],
      },
      {
        date: '2026-11-22',
        count: 1,
        by_kind: { modified: 1 },
        formats: { py: 1 },
        decisions: [],
        samples: [
          {
            event_id: 'e_code_nested',
            kind: 'modified',
            headline: 'helper',
            revision_id: 'r3',
            file_id: 'f_code_nested',
            file_path: '04-智能体代码/utils/helper.py',
            file_title: 'helper',
            file_role: '源码',
            format: 'py',
            occurred_at: '2026-11-22T08:00:00Z',
            occurred_precision: 'day',
            observed_at: '2026-11-22T08:00:00Z',
            time_basis: 'file_mtime',
            action: null,
            decision_id: null,
            code: null,
            status: null,
            ref_count: 0,
            version_count: 1,
            statement_count: 0,
          },
        ],
      },
    ],
  };
  const daysFiltered = filterPanoramaEventDays(mockDays, muted, 'all');
  assert.ok(daysFiltered);
  assert.deepEqual(
    daysFiltered.groups.map((g) => g.date),
    ['2026-11-23'],
    '全样本均属静默目录的日期桶应从星图与日历桶中干净剔除'
  );

  // 取消静默后完整还原
  const restored = toggleMutedFolderList(muted, '04-智能体代码');
  assert.deepEqual(restored, []);
});

test('V06 · 目录三态排序（name / active7d / unread）确定性与子树指标聚合上浮', () => {
  const files: FileRecord[] = [
    makeFile('f_a', '方案A', '01-归档', 'r1'),
    makeFile('f_b', '接口B', '02-研发/子模块', 'r2'),
    makeFile('f_c', '日报C', '03-运营', 'r3'),
  ];
  const { nodes } = buildMergedFolderTree(files, []);
  const metrics = new Map([
    ['01-归档', { unreadCount: 1, active7dCount: 0 }],
    ['02-研发', { unreadCount: 0, active7dCount: 0 }],
    ['02-研发/子模块', { unreadCount: 2, active7dCount: 9 }],
    ['03-运营', { unreadCount: 6, active7dCount: 3 }],
  ]);

  const byName = sortFolderTreeNodes(nodes, 'name', metrics);
  assert.deepEqual(
    byName.map((n) => n.name),
    ['01-归档', '02-研发', '03-运营']
  );

  // active7d：02-研发 通过子树聚合拿到 9，必须上浮至首位，其次 03-运营 (3)，最后 01-归档 (0)
  const byActive = sortFolderTreeNodes(nodes, 'active7d', metrics);
  assert.deepEqual(
    byActive.map((n) => n.name),
    ['02-研发', '03-运营', '01-归档']
  );

  // unread：03-运营 (6) > 02-研发 (子树 2) > 01-归档 (1)
  const byUnread = sortFolderTreeNodes(nodes, 'unread', metrics);
  assert.deepEqual(
    byUnread.map((n) => n.name),
    ['03-运营', '02-研发', '01-归档']
  );
});

test('V06 · 左栏即时快筛 + 关键词高亮切分 + 5,500 份文件单遍快筛响应 < 30ms', () => {
  const segs = splitQuickFilterHighlight('2D与3D绘制预览优化方案-v2.svg', '优化方案');
  assert.deepEqual(segs, [
    { text: '2D与3D绘制预览', hit: false },
    { text: '优化方案', hit: true },
    { text: '-v2.svg', hit: false },
  ]);

  // 构造 5,500 份分布于 55 个子目录的真实量级工作区
  const bigFiles: FileRecord[] = [];
  for (let i = 0; i < 5500; i += 1) {
    const dir = `0${(i % 5) + 1}-专项/子组-${String(i % 11).padStart(2, '0')}`;
    const title = i === 4321 ? '司辰星图架构总纲-v2' : `工程文档-${i}`;
    bigFiles.push(makeFile(`f_${i}`, title, dir, `r_${i}`, i % 3 === 0 ? 'ts' : 'md'));
  }
  const { nodes, rootFiles } = buildMergedFolderTree(bigFiles, []);

  const t0 = performance.now();
  const res = filterFolderTreeByQuery(nodes, rootFiles, '司辰星图');
  const elapsedMs = performance.now() - t0;

  assert.equal(res.matchedFileCount, 1);
  assert.equal(res.nodes.length, 1);
  assert.ok(res.autoExpandedPaths.has('02-专项'), '命中深层文件应自动收集祖先目录展开路径');
  assert.ok(elapsedMs < 30, `5,500 份目录即时快筛应 < 30ms，实测：${elapsedMs.toFixed(2)}ms`);
});

test('V06 · UI 渲染验收：左栏 InputGroup 快筛/三态排序/静默徽标与胶囊 + FileContextMenu + PreviewCard', () => {
  const f1 = makeFile('f1', '架构方案', '01-方案', 'r1', 'md');
  const f2 = makeFile('f2', 'agent_runner', '04-智能体代码', 'r2', 'ts');

  const sidebarHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: [f1, f2],
      readingStates: {},
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      activeFileId: 'f1',
      onOpenFileToRead: () => {},
      mutedFolders: ['04-智能体代码'],
      onToggleMuteFolder: () => {},
      onUnmuteFolder: () => {},
      onClearMutedFolders: () => {},
    })
  );
  assert.ok(sidebarHtml.includes('data-sidebar-quick-filter'), '左栏应渲染 InputGroup 即时目录/文件快筛');
  assert.ok(sidebarHtml.includes('data-sidebar-sort-group'), '左栏应渲染三态排序 Group 控件');
  assert.ok(sidebarHtml.includes('data-sort-option="active7d"'), '应包含「近7日活跃」排序切换');
  assert.ok(sidebarHtml.includes('data-sort-option="unread"'), '应包含「未读数」排序切换');
  assert.ok(sidebarHtml.includes('data-folder-muted="true"'), '已静默目录在左栏应以温和灰阶标注');
  assert.ok(sidebarHtml.includes('已静默'), '左栏应显示「已静默」徽标');
  assert.ok(sidebarHtml.includes('data-muted-folders-pill="1"'), '左栏底缘应渲染「已静默 1 个目录」轻胶囊');

  // 右键目录菜单：静默 / 取消静默
  const menuMuteHtml = renderToStaticMarkup(
    React.createElement(FileContextMenu, {
      menu: { x: 120, y: 120, target: { kind: 'folder', relativePath: '04-智能体代码', title: '04-智能体代码' } },
      onClose: () => {},
      desktopSupported: true,
      hasRootPath: true,
      onRevealInExplorer: () => {},
      onOpenWithDefaultApp: () => {},
      onCopyRelativePath: () => {},
      onCopyAbsolutePath: () => {},
      isFolderMuted: () => false,
      onToggleMuteFolder: () => {},
    })
  );
  assert.ok(menuMuteHtml.includes('data-menu-action="toggle-mute-folder"'));
  assert.ok(menuMuteHtml.includes('在时间轴与星图静默此目录'));

  const menuUnmuteHtml = renderToStaticMarkup(
    React.createElement(FileContextMenu, {
      menu: { x: 120, y: 120, target: { kind: 'folder', relativePath: '04-智能体代码', title: '04-智能体代码' } },
      onClose: () => {},
      desktopSupported: true,
      hasRootPath: true,
      onRevealInExplorer: () => {},
      onOpenWithDefaultApp: () => {},
      onCopyRelativePath: () => {},
      onCopyAbsolutePath: () => {},
      isFolderMuted: () => true,
      onToggleMuteFolder: () => {},
    })
  );
  assert.ok(menuUnmuteHtml.includes('取消静默此目录'));

  // 右检查器渲染双向引用卡无 SSR 报错（已接入 Base UI PreviewCardTrigger）
  const inspectorHtml = renderToStaticMarkup(
    React.createElement(RightInspector, {
      selectedFile: f1,
      files: [f1, f2],
      decisions: [],
      relations: [
        {
          edge_id: 'e1',
          source_id: 'f1',
          target_id: 'f2',
          type: 'explicit_reference',
          isInferred: false,
          label: '引用',
          reason: '文档正文显式引用',
          locator: { startLine: 10, endLine: 12 },
        },
      ],
      readingState: undefined,
      onSavePersonalNote: () => {},
      onCopyObjectToAgent: async () => true,
      indexGeneration: 1,
      onOpenFile: () => {},
      onOpenDecision: () => {},
      onViewRelationsGraph: () => {},
    })
  );
  assert.ok(inspectorHtml.includes('agent_runner'), '右检查器双向引用卡应正确渲染且兼容 PreviewCardTrigger');
});

