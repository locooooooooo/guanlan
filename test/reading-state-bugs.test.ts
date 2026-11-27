
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileRecord, ReadingState } from '../src/types/guanlan';
import type { ArtifactStateView } from '../src/services/apiTypes';
import { hasUnreadChanges, type UnreadReason } from '../src/utils/guanlanEngine';
import {
  applyBatchMarkUnread,
  applyBatchReadingBaseline,
  markFileUnreadState,
  mergeServerReadingStates,
  restoreReadingStatesSnapshot,
  type ReadingStateMap,
} from '../src/utils/readingStateStore';
import { buildMergedFolderTree, sortFolderTreeNodes } from '../src/utils/sidebarTree';
import {
  collectFolderActivitySummaries,
  collectUnreadFileIds,
  FolderTreeRows,
  LeftSidebar,
} from '../src/components/LeftSidebar';
import { ReadingIslandPanel } from '../src/components/ReadingIsland';
import { computeReadingIslandStats } from '../src/utils/readingIslandStats';
import { ReaderView } from '../src/components/ReaderView';
import { FileContextMenu } from '../src/components/FileContextMenu';
import { AtlasView } from '../src/components/AtlasView';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(THIS_DIR, '../src');

function makeFile(
  id: string,
  title: string,
  folder: string,
  revId = `rev_${id}_1`,
  extraRevs: Array<{ revision_id: string; versionNumber: number }> = []
): FileRecord {
  const rel = folder === '.' ? `${title}.md` : `${folder}/${title}.md`;
  const revisions = [
    ...extraRevs.map((r) => ({
      revision_id: r.revision_id,
      file_id: id,
      versionNumber: r.versionNumber,
      content_sha256: `sha_${r.revision_id}`,
      observed_at: '2026-11-22T09:00:00+08:00',
      sizeBytes: 120,
      snapshotAvailable: true,
      summaryNote: `v${r.versionNumber}`,
      markdownContent: `# ${title}\n\n旧版内容`,
    })),
    {
      revision_id: revId,
      file_id: id,
      versionNumber: extraRevs.length + 1,
      content_sha256: `sha_${revId}`,
      observed_at: '2026-11-23T10:00:00+08:00',
      sizeBytes: 240,
      snapshotAvailable: true,
      summaryNote: `v${extraRevs.length + 1}`,
      markdownContent: `# ${title}\n\n最新内容`,
    },
  ];
  return {
    file_id: id,
    relative_path: rel,
    title,
    format: 'md',
    folder,
    role: '报告',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revId,
    revisions,
    coverage: 'full_text',
  };
}

function makeArtifact(fileId: string, lastActivityAt: string): ArtifactStateView {
  return {
    file_id: fileId,
    initiative_id: null,
    current_path: `${fileId}.md`,
    title: fileId,
    stage: '计划',
    state: 'draft',
    selected_revision_id: null,
    checklist_done: 0,
    checklist_total: 0,
    pending_p0: 0,
    pending_p1: 0,
    pending_p2: 0,
    last_activity_at: lastActivityAt,
  };
}

test('目录树未读数与近 7 日活跃点按递归子树汇总，且排序不重复累加', () => {
  const nowMs = Date.parse('2026-11-23T12:00:00Z');
  const recentIso = new Date(nowMs - 3600_000).toISOString();

  const files: FileRecord[] = [
    makeFile('d1', 'root-doc-1', 'docs'),
    makeFile('d2', 'root-doc-2', 'docs'),
    makeFile('g1', 'gl-1', 'docs/guanlan'),
    makeFile('g2', 'gl-2', 'docs/guanlan'),
    makeFile('g3', 'gl-3', 'docs/guanlan'),
    makeFile('g4', 'gl-4', 'docs/guanlan'),
    makeFile('a1', 'asset-1', 'docs/guanlan/assets'),
    makeFile('f1', 'gold-1', 'docs/guanlan/assets/f04'),
    makeFile('f2', 'gold-2', 'docs/guanlan/assets/f04'),
    makeFile('f3', 'gold-3', 'docs/guanlan/assets/f04'),
    ...Array.from({ length: 5 }, (_, i) => makeFile(`c${i}`, `sub-${i}`, 'container/sub')),
  ];

  const readingStates: ReadingStateMap = {
    g4: {
      file_id: 'g4',
      last_read_revision_id: 'rev_g4_1',
      scrollPercent: 100,
      isFullyRead: true,
      bookmarked: false,
      updated_at: recentIso,
    },
  };
  const artifacts = new Map<string, ArtifactStateView>([
    ['f1', makeArtifact('f1', recentIso)],
    ['c0', makeArtifact('c0', recentIso)],
    ['c1', makeArtifact('c1', recentIso)],
  ]);

  const { nodes } = buildMergedFolderTree(files, []);
  const summaries = collectFolderActivitySummaries(nodes, {
    readingStates,
    artifactsByFileId: artifacts,
    nowMs,
  });

  assert.equal(summaries.get('docs')?.unreadCount, 9);
  assert.equal(summaries.get('docs')?.directUnreadCount, 2);
  assert.equal(summaries.get('docs')?.active7dCount, 1, '子目录 f1 的活跃应冒泡到 docs');

  assert.equal(summaries.get('docs/guanlan')?.unreadCount, 7);
  assert.equal(summaries.get('docs/guanlan')?.directUnreadCount, 3);

  assert.equal(summaries.get('docs/guanlan/assets')?.unreadCount, 4);
  assert.equal(summaries.get('docs/guanlan/assets')?.directUnreadCount, 1);

  assert.equal(summaries.get('container')?.unreadCount, 5);
  assert.equal(summaries.get('container')?.directUnreadCount, 0);
  assert.equal(summaries.get('container')?.active7dCount, 2);
  assert.equal(summaries.get('container')?.subtreeAggregated, true);

  const byUnread = sortFolderTreeNodes(nodes, 'unread', summaries);
  assert.deepEqual(byUnread.map((n) => n.name), ['docs', 'container']);
  const byActive = sortFolderTreeNodes(nodes, 'active7d', summaries);
  assert.deepEqual(byActive.map((n) => n.name), ['container', 'docs']);
});

test('LeftSidebar：未读筛选同步过滤目录树、系统目录展示未读数、「继续阅读」不滞留已建基线文档', () => {
  const fUnread = makeFile('f_unread', '待读方案', 'docs/sub');
  const fRead = makeFile('f_read', '已读归档', 'done');
  const fMidBaseline = makeFile('f_mid', '半途已建基线', 'docs');
  const fSysUnread = makeFile('f_sys', '产物日志', '_tools');

  const readingStates: ReadingStateMap = {
    f_read: {
      file_id: 'f_read',
      last_read_revision_id: 'rev_f_read_1',
      scrollPercent: 100,
      isFullyRead: true,
      bookmarked: false,
      updated_at: '2026-11-23T09:00:00+08:00',
    },
    f_mid: {
      file_id: 'f_mid',
      last_read_revision_id: 'rev_f_mid_1',
      scrollPercent: 45,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '2026-11-23T09:30:00+08:00',
    },
  };

  const unreadHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: [fUnread, fRead, fMidBaseline, fSysUnread],
      readingStates,
      activeFileId: 'f_unread',
      filters: { quickScope: 'unread', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
    })
  );

  assert.ok(unreadHtml.includes('data-folder-unread="1"'), 'docs 汇总子目录未读数应为 1');
  assert.ok(!unreadHtml.includes('>done<'), '未读筛选态不应再渲染全部已读的 done 目录');
  assert.ok(
    unreadHtml.includes('data-system-group-unread="1"'),
    '工程与产出物分组头应显示系统目录未读数'
  );
  assert.ok(
    !unreadHtml.includes('data-continue-reading-row="f_mid"'),
    '已处于当前版已读基线的文档即使 scrollPercent=45 也不得滞留于「继续阅读」'
  );

  const allReadStates: ReadingStateMap = {
    ...readingStates,
    f_unread: {
      file_id: 'f_unread',
      last_read_revision_id: 'rev_f_unread_1',
      scrollPercent: 0,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '',
      baselineOnly: true,
    },
    f_sys: {
      file_id: 'f_sys',
      last_read_revision_id: 'rev_f_sys_1',
      scrollPercent: 0,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '',
      baselineOnly: true,
    },
  };
  const allReadUnreadViewHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: [fUnread, fRead, fMidBaseline, fSysUnread],
      readingStates: allReadStates,
      activeFileId: 'f_unread',
      filters: { quickScope: 'unread', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
    })
  );
  assert.ok(
    allReadUnreadViewHtml.includes('当前全部文档已读'),
    '全已读时切到未读筛选应提示「当前全部文档已读」'
  );
});

test('ReaderView：已读基线按钮与统一已读口径对齐（baselineOnly 也显示当前版已读），且查看历史版不倒退基线', () => {
  const file = makeFile('f1', '架构设计', 'docs', 'rev_v2', [
    { revision_id: 'rev_v1', versionNumber: 1 },
  ]);

  const baselineState: ReadingState = {
    file_id: 'f1',
    last_read_revision_id: 'rev_v2',
    scrollPercent: 0,
    isFullyRead: false,
    bookmarked: false,
    updated_at: '',
    baselineOnly: true,
  };
  const htmlBaselineLatest = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [file],
      activeFile: file,
      pinnedRevisionId: 'rev_v2',
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: baselineState,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onMarkUnread: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 1,
    })
  );
  assert.ok(
    htmlBaselineLatest.includes('data-reader-read-toggle="read"'),
    '批量确立已读基线后的文档在阅读器中必须识别为已读态'
  );
  assert.ok(htmlBaselineLatest.includes('当前版已读'), '当前版处于已读基线时应显示「当前版已读」');

  const htmlHistoricalUnread = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [file],
      activeFile: file,
      pinnedRevisionId: 'rev_v1',
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: undefined,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onMarkUnread: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 1,
    })
  );
  assert.ok(htmlHistoricalUnread.includes('标最新版已读'), '浏览历史版且最新版未读时应显示「标最新版已读」');

  const htmlHistoricalRead = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [file],
      activeFile: file,
      pinnedRevisionId: 'rev_v1',
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: baselineState,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onMarkUnread: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 1,
    })
  );
  assert.ok(htmlHistoricalRead.includes('最新版已读'), '浏览历史版且最新版已读时应显示「最新版已读」');
  assert.ok(htmlHistoricalRead.includes('data-reader-read-toggle="read"'));
});

test('markFileUnreadState / applyBatchMarkUnread / mergeServerReadingStates 无损保留收藏批注并支持权威对账', () => {
  const f1 = makeFile('f1', '方案A', 'docs', 'r1');
  const f2 = makeFile('f2', '方案B', 'docs', 'r2');

  const initial: ReadingStateMap = {
    f1: {
      file_id: 'f1',
      last_read_revision_id: 'r1',
      scrollPercent: 100,
      isFullyRead: true,
      bookmarked: true,
      personalNote: '保留此批注',
      updated_at: '2026-11-23T09:00:00+08:00',
    },
    f2: {
      file_id: 'f2',
      last_read_revision_id: 'r2',
      scrollPercent: 0,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '',
      baselineOnly: true,
    },
  };

  const afterSingle1 = markFileUnreadState(initial, 'f1');
  assert.equal(hasUnreadChanges(f1, afterSingle1.f1).isUnread, true);
  assert.equal(afterSingle1.f1?.bookmarked, true);
  assert.equal(afterSingle1.f1?.personalNote, '保留此批注');
  const afterSingle2 = markFileUnreadState(afterSingle1, 'f2');
  assert.equal(afterSingle2.f2, undefined);
  assert.equal(hasUnreadChanges(f2, afterSingle2.f2).isUnread, true);

  const { next, previousSnapshot } = applyBatchMarkUnread(initial, ['f1', 'f2']);
  assert.equal(hasUnreadChanges(f1, next.f1).isUnread, true);
  assert.equal(hasUnreadChanges(f2, next.f2).isUnread, true);
  const restored = restoreReadingStatesSnapshot(next, previousSnapshot);
  assert.equal(restored.f1?.last_read_revision_id, 'r1');
  assert.equal(restored.f1?.isFullyRead, true);
  assert.equal(restored.f2?.last_read_revision_id, 'r2');
  assert.equal(restored.f2?.baselineOnly, true);

  const synced = mergeServerReadingStates(
    initial,
    [{ file_id: 'f1', last_read_revision_id: 'r1_v2', updated_at: '2026-11-23T12:00:00Z' }],
    { authoritative: true }
  );
  assert.equal(synced.f2, undefined, '服务端已撤销的纯 baselineOnly 应在权威对账后清除');
  assert.equal(synced.f1?.last_read_revision_id, 'r1_v2');
  assert.equal(synced.f1?.isFullyRead, false, '服务端推进新基线版本后不应沿用旧版的 isFullyRead=true');
  assert.equal(synced.f1?.personalNote, '保留此批注');

  const { next: baselined, previousSnapshot: baselineSnap } = applyBatchReadingBaseline({}, [
    { file_id: 'f2', last_read_revision_id: 'r2', updated_at: '2026-11-23T10:00:00Z' },
  ]);
  assert.equal(hasUnreadChanges(f2, baselined.f2).isUnread, false);
  const editedDuringUndoWindow: ReadingStateMap = {
    ...baselined,
    f2: {
      ...baselined.f2,
      bookmarked: true,
      personalNote: '撤销窗口内新加批注',
    },
  };
  const undonePreservingEdits = restoreReadingStatesSnapshot(editedDuringUndoWindow, baselineSnap);
  assert.equal(hasUnreadChanges(f2, undonePreservingEdits.f2).isUnread, true, '撤销后应恢复未读');
  assert.equal(undonePreservingEdits.f2?.bookmarked, true, '撤销窗口内新增收藏不得被覆盖丢失');
  assert.equal(undonePreservingEdits.f2?.personalNote, '撤销窗口内新加批注', '撤销窗口内新增批注不得丢失');

  const cleared = markFileUnreadState(baselined, 'f2');
  assert.equal(cleared.f2, undefined);
});

test('FileContextMenu：单文件标已读/标未读切换，目录支持本目录全部标为已读与标为未读', () => {
  const baseProps = {
    onClose: () => {},
    desktopSupported: true,
    hasRootPath: true,
    onRevealInExplorer: () => {},
    onOpenWithDefaultApp: () => {},
    onCopyRelativePath: () => {},
    onCopyAbsolutePath: () => {},
    onMarkFileRead: () => {},
    onMarkFileUnread: () => {},
    onMarkFolderRead: () => {},
    onMarkFolderUnread: () => {},
  };

  const unreadFileMenu = renderToStaticMarkup(
    React.createElement(FileContextMenu, {
      ...baseProps,
      isFileUnread: () => true,
      menu: { x: 20, y: 20, target: { kind: 'file', fileId: 'f1', revisionId: 'r1', relativePath: 'a.md', title: 'a' } },
    })
  );
  assert.ok(unreadFileMenu.includes('data-menu-action="mark-file-read"'));
  assert.ok(!unreadFileMenu.includes('data-menu-action="mark-file-unread"'));

  const readFileMenu = renderToStaticMarkup(
    React.createElement(FileContextMenu, {
      ...baseProps,
      isFileUnread: () => false,
      menu: { x: 20, y: 20, target: { kind: 'file', fileId: 'f1', revisionId: 'r1', relativePath: 'a.md', title: 'a' } },
    })
  );
  assert.ok(readFileMenu.includes('data-menu-action="mark-file-unread"'));
  assert.ok(!readFileMenu.includes('data-menu-action="mark-file-read"'));

  const folderMenu = renderToStaticMarkup(
    React.createElement(FileContextMenu, {
      ...baseProps,
      menu: { x: 20, y: 20, target: { kind: 'folder', relativePath: 'docs/guanlan', title: 'docs/guanlan' } },
    })
  );
  assert.ok(folderMenu.includes('data-menu-action="mark-folder-read"'));
  assert.ok(folderMenu.includes('data-menu-action="mark-folder-unread"'));
});

test('AtlasView：文件夹卡片展示未读徽标，且筛选条份数不被截断', () => {
  const f1 = makeFile('f1', '报告1', 'docs/guanlan');
  const f2 = makeFile('f2', '报告2', 'docs/guanlan');
  f2.revisions[0].sizeBytes = 11162;
  const files = [f1, f2];
  const html = renderToStaticMarkup(
    React.createElement(AtlasView, {
      variant: 'embedded',
      files,
      readingStates: {},
      onOpenFile: () => {},
      activeFileId: 'f1',
      filterActive: true,
      filterLabel: '未读 · docs/guanlan/very/long/subpath',
      filteredCount: 107,
      onClearFilters: () => {},
    })
  );
  assert.ok(html.includes('data-folder-card-unread="2"'), 'FolderCard 应展示未读徽标');
  assert.ok(
    html.includes('shrink-0 whitespace-nowrap') && html.includes('107'),
    '筛选条中的份数计数应独立于截断标签，避免出现 10...'
  );
  assert.ok(html.includes('240 B') && html.includes('10.9 KiB'), 'AtlasView 文件卡体积单位统一走 formatByteSize (B / KiB)');
  assert.ok(!html.includes(' KB'), 'AtlasView 不再出现 KB 单位');
  assert.ok(html.includes('入库于 '), 'AtlasView 文件卡与资料抽屉日期统一带「入库于」语义前缀');
});

test('useWorkspaceStore 关键护栏：新版本失效旧详情缓存、单篇标已读/未读落库、handleMarkReadHere 不静默覆写已读基线', () => {
  const storeSrc = fs.readFileSync(path.join(SRC_ROOT, 'stores/useWorkspaceStore.tsx'), 'utf8');

  const applyStart = storeSrc.indexOf('const applyFileSummaries = useCallback(');
  const applyEnd = storeSrc.indexOf('const mergeEventsPage = useCallback(', applyStart);
  const applyBody = storeSrc.slice(applyStart, applyEnd);
  assert.ok(
    applyBody.includes('detailLoadedIdsRef.current.delete(item.file_id)'),
    'applyFileSummaries 发现新版本时必须清除 detailLoadedIdsRef，防止阅读器卡在旧版导致标已读无效'
  );

  const hereStart = storeSrc.indexOf('const handleMarkReadHere = (');
  const hereEnd = storeSrc.indexOf('const handleMarkFullyRead = (', hereStart);
  const hereBody = storeSrc.slice(hereStart, hereEnd);
  assert.ok(
    !hereBody.includes('next.last_read_revision_id ='),
    'handleMarkReadHere 只记章节锚点，严禁静默覆写 last_read_revision_id 清掉未读更新'
  );

  const fullyStart = hereEnd;
  const unreadEnd = storeSrc.indexOf('const handleMarkFolderUnread =', fullyStart);
  const singleHandlers = storeSrc.slice(fullyStart, unreadEnd);
  assert.ok(singleHandlers.includes("action: 'mark_read'"), 'handleMarkFullyRead 必须同步服务端 mark_read');
  assert.ok(singleHandlers.includes("action: 'mark_unread'"), 'handleMarkUnread 必须同步服务端 mark_unread');
});

test('motion.css §3.30 已读微动效：GPU-only、零硬编码 ms / will-change，且全数登记 prefers-reduced-motion', () => {
  const motionCss = fs.readFileSync(path.join(SRC_ROOT, 'styles/motion.css'), 'utf8');
  const s330Start = motionCss.indexOf('§3.30');
  const s4Start = motionCss.indexOf('§4 prefers-reduced-motion');
  assert.ok(s330Start > 0 && s4Start > s330Start, 'motion.css 应包含 §3.30 已读微动效分节');
  const s330Body = motionCss.slice(s330Start, s4Start).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(s330Body.includes('.glx-read-confirm-pop'), '声明 .glx-read-confirm-pop');
  assert.ok(s330Body.includes('.glx-read-meter-fill'), '声明 .glx-read-meter-fill');
  assert.ok(s330Body.includes('.glx-unread-updated-dot'), '声明 .glx-unread-updated-dot');
  assert.ok(!/\d+ms/.test(s330Body), '§3.30 不得写死 ms 时长，只能消费 :root 令牌');
  assert.ok(!s330Body.includes('will-change'), '§3.30 禁止写入 will-change');

  const reducedSection = motionCss.slice(s4Start);
  assert.ok(reducedSection.includes('.glx-read-confirm-pop'), '§4 reduced-motion 登记 glx-read-confirm-pop');
  assert.ok(reducedSection.includes('.glx-read-meter-fill'), '§4 reduced-motion 登记 glx-read-meter-fill');
  assert.ok(reducedSection.includes('.glx-unread-updated-dot'), '§4 reduced-motion 登记 glx-unread-updated-dot');
});

test('视觉升级 · LeftSidebar：阅读进度条、全已读态、继续阅读微轨 + 1-click 快捷操作、读后有更新双环点与目录全已读勾', () => {
  const fRead = makeFile('f_read', '已读规范', 'docs', 'r_read');
  const fUpdated = makeFile('f_upd', '迭代计划', 'docs', 'r_upd_v2');
  const fNever = makeFile('f_new', '新草案', 'specs', 'r_new');
  const files = [fRead, fUpdated, fNever];
  const readingStates: ReadingStateMap = {
    f_read: {
      file_id: 'f_read',
      last_read_revision_id: 'r_read',
      scrollPercent: 100,
      isFullyRead: true,
      bookmarked: false,
      updated_at: '2026-11-23T08:00:00+08:00',
    },
    f_upd: {
      file_id: 'f_upd',
      last_read_revision_id: 'r_upd_v1',
      scrollPercent: 45,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '2026-11-23T09:00:00+08:00',
    },
  };

  const htmlAll = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files,
      readingStates,
      activeFileId: '',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
      onMarkReadingBaseline: () => {},
      onMarkFileRead: () => {},
      onMarkFileUnread: () => {},
    })
  );
  assert.ok(!htmlAll.includes('data-sidebar-reading-meter=""'), '「全部」态不重复展示已读进度条');
  assert.ok(htmlAll.includes('继续阅读'), '「继续阅读」以折叠标题保留可达');
  assert.ok(!htmlAll.includes('data-continue-mark-read="f_upd"'), '「继续阅读」默认折叠不挤占目录树');
  assert.ok(!htmlAll.includes('data-sidebar-scope-count="all"'), '「全部」不把总量再印在页签上');
  assert.ok(htmlAll.includes('data-sidebar-scope-count="unread"'), '未读只是子集时仍显示差额');
  assert.ok(htmlAll.includes('全部文档 3 份'), '总量留在悬停说明里');

  const piled = [makeFile('pile_a', '甲', 'shots', 'ra'), makeFile('pile_b', '乙', 'shots', 'rb')];
  const htmlPiled = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: piled,
      readingStates: {},
      activeFileId: '',
      filters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
      onMarkReadingBaseline: () => {},
    })
  );
  assert.ok(!htmlPiled.includes('data-sidebar-scope-count'), '未读等于全部时不再并排两个相同大数');
  assert.ok(!htmlPiled.includes('>MD<'), '清一色目录不重复格式词');
  const htmlPiledUnread = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files: piled,
      readingStates: {},
      activeFileId: '',
      filters: { quickScope: 'unread', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
      onMarkReadingBaseline: () => {},
    })
  );
  assert.ok(htmlPiledUnread.includes('sr-only">待读 2 份'), '零进度时待读句只留给读屏，不再占一行');
  assert.ok(!htmlPiledUnread.includes('存量未读'), '零进度不再写「存量未读 N 份」');

  const htmlUnread = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files,
      readingStates,
      activeFileId: '',
      filters: { quickScope: 'unread', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
      onMarkReadingBaseline: () => {},
      onMarkFileRead: () => {},
      onMarkFileUnread: () => {},
    })
  );
  assert.ok(htmlUnread.includes('data-sidebar-reading-meter=""'), '「未读」态展示已读进度细条');
  assert.ok(htmlUnread.includes('glx-read-meter-fill'), '进度条使用 GPU scaleX 动效类');
  assert.ok(htmlUnread.includes('data-mark-baseline-trigger=""'), '「未读」态提供确立已读基线入口');

  const allReadStates: ReadingStateMap = {
    f_read: readingStates.f_read,
    f_upd: { ...readingStates.f_upd, last_read_revision_id: 'r_upd_v2' },
    f_new: {
      file_id: 'f_new',
      last_read_revision_id: 'r_new',
      scrollPercent: 0,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '',
      baselineOnly: true,
    },
  };
  const htmlAllRead = renderToStaticMarkup(
    React.createElement(LeftSidebar, {
      files,
      readingStates: allReadStates,
      activeFileId: '',
      filters: { quickScope: 'unread', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateFilters: () => {},
      onResetFilters: () => {},
      onOpenFileToRead: () => {},
      onMarkReadingBaseline: () => {},
    })
  );
  assert.ok(htmlAllRead.includes('data-sidebar-all-read=""'), '全已读态展示「全部已读」完成微条');
  assert.ok(!htmlAllRead.includes('data-folder-all-read="docs"'), '已读目录不再堆砌绿勾噪点');

  const { nodes } = buildMergedFolderTree(files);
  const activity = collectFolderActivitySummaries(nodes, {
    readingStates,
    artifactsByFileId: null,
    nowMs: Date.parse('2026-11-23T12:00:00Z'),
  });
  const htmlTree = renderToStaticMarkup(
    React.createElement(FolderTreeRows, {
      nodes,
      depth: 0,
      selected: 'all',
      activeFileId: '',
      expanded: new Set(['docs', 'specs']),
      onToggle: () => {},
      onSelect: () => {},
      onOpenFileToRead: () => {},
      folderActivity: activity,
      unreadFileIds: collectUnreadFileIds(files, readingStates),
      unreadReasonByFileId: new Map<string, UnreadReason>([
        ['f_read', 'up_to_date'],
        ['f_upd', 'updated_since_last_read'],
        ['f_new', 'never_read'],
      ]),
      onMarkFileRead: () => {},
      onMarkFileUnread: () => {},
      onMarkFolderRead: () => {},
    })
  );
  assert.ok(htmlTree.includes('glx-unread-updated-dot'), '读后有更新文件点携带双环微晕类');
  assert.ok(htmlTree.includes('data-sidebar-toggle-read="f_upd"'), '未读文件行提供 1-click 标已读按钮');
  assert.ok(htmlTree.includes('data-sidebar-toggle-read="f_read"'), '已读文件行提供 1-click 标未读按钮');
  assert.ok(htmlTree.includes('data-folder-mark-read="docs"'), '有未读的目录行提供 1-click 目录全标已读');
});

test('视觉升级 · ReaderView 三态玻璃胶囊（已读轻弹、读后有更新琥珀高亮、未读新件）', () => {
  const file = makeFile('f_rv', '评审方案', 'docs', 'r_v2');
  const commonProps = {
    files: [file],
    activeFile: file,
    pinnedRevisionId: 'r_v2',
    onChangeRevision: () => {},
    subMode: 'read' as const,
    onChangeSubMode: () => {},
    onMarkReadHere: () => {},
    onMarkFullyRead: () => {},
    onMarkUnread: () => {},
    onScrollProgress: () => {},
    onToggleBookmark: () => {},
    onNavigateLinkedFile: () => {},
    returnBreadcrumb: null,
    onFollowReturnBreadcrumb: () => {},
    decisions: [],
    relations: [],
    onSelectDecision: () => {},
    onAddEvidencePointer: () => {},
    indexGeneration: 1,
  };

  const htmlRead = renderToStaticMarkup(
    React.createElement(ReaderView, {
      ...commonProps,
      readingState: {
        file_id: 'f_rv',
        last_read_revision_id: 'r_v2',
        scrollPercent: 100,
        isFullyRead: true,
        bookmarked: false,
        updated_at: '2026-11-23T09:00:00+08:00',
      },
    })
  );
  assert.ok(htmlRead.includes('data-reader-read-reason="up_to_date"'));
  assert.ok(htmlRead.includes('glx-read-confirm-pop'), '已读态勾选图标携带单次轻弹动效类');

  const htmlUpdated = renderToStaticMarkup(
    React.createElement(ReaderView, {
      ...commonProps,
      readingState: {
        file_id: 'f_rv',
        last_read_revision_id: 'r_v1',
        scrollPercent: 80,
        isFullyRead: false,
        bookmarked: false,
        updated_at: '2026-11-23T09:00:00+08:00',
      },
    })
  );
  assert.ok(htmlUpdated.includes('data-reader-read-reason="updated_since_last_read"'));
  assert.ok(htmlUpdated.includes('glx-unread-updated-dot'), '读后有更新态展示琥珀双环微点');
});

test('视觉升级 · AtlasView 三态文件卡、文件夹进度轨/已读徽标与分区头快捷操作', () => {
  const fRead = makeFile('a_read', '已完成交付', 'done', 'r_1');
  const fUpdated = makeFile('a_upd', '迭代总纲', 'active', 'r_2');
  const fNever = makeFile('a_new', '新需求', 'active', 'r_3');
  const readingStates: ReadingStateMap = {
    a_read: {
      file_id: 'a_read',
      last_read_revision_id: 'r_1',
      scrollPercent: 100,
      isFullyRead: true,
      bookmarked: false,
      updated_at: '2026-11-23T09:00:00+08:00',
    },
    a_upd: {
      file_id: 'a_upd',
      last_read_revision_id: 'r_old',
      scrollPercent: 30,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '2026-11-23T08:00:00+08:00',
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(AtlasView, {
      variant: 'embedded',
      files: [fRead, fUpdated, fNever],
      readingStates,
      onOpenFile: () => {},
      activeFileId: '',
      onMarkFileRead: () => {},
      onMarkFileUnread: () => {},
      onMarkFolderRead: () => {},
      onMarkFolderUnread: () => {},
    })
  );

  assert.ok(html.includes('data-card-read-check=""'), '已读文件卡展示柔和鼠尾草对勾');
  assert.ok(html.includes('data-card-unread-reason="updated_since_last_read"'), '读后更新文件卡展示「有更新」徽标');
  assert.ok(html.includes('data-card-unread-reason="never_read"'), '未读新件文件卡展示暖琥珀点');
  assert.ok(html.includes('data-card-toggle-read="a_upd"'), '文件卡提供悬停 1-click 标已读');
  assert.ok(html.includes('data-card-toggle-read="a_read"'), '已读文件卡提供悬停 1-click 标未读');

  assert.ok(html.includes('data-folder-card-all-read=""'), '全已读文件夹卡展示鼠尾草「已读」胶囊');
  assert.ok(html.includes('data-folder-card-progress=""'), '文件夹卡前板底部展示 GPU 阅读进度轨');

  assert.ok(html.includes('data-atlas-section-mark-read="active"'), '有未读的目录分区头提供「本组已读」');
  assert.ok(html.includes('data-atlas-section-mark-unread="done"'), '全已读的目录分区头提供「标为未读」');
});

test('视觉升级 · ReadingIslandPanel 双色进度轨、筛选胶囊、确立基线 CTA、每行 1-click 切换与超长列表折叠', () => {
  const fRead = makeFile('ri_read', '已读文档', 'docs', 'r_1');
  const fUpdated = makeFile('ri_upd', '有更新文档', 'docs', 'r_2');
  const extraUnread = Array.from({ length: 65 }, (_, i) =>
    makeFile(`ri_extra_${i}`, `长列表文档_${i}`, 'archive', `r_e_${i}`)
  );
  const files = [fRead, fUpdated, ...extraUnread];
  const readingStates: ReadingStateMap = {
    ri_read: {
      file_id: 'ri_read',
      last_read_revision_id: 'r_1',
      scrollPercent: 100,
      isFullyRead: true,
      bookmarked: false,
      updated_at: '2026-11-23T09:00:00+08:00',
    },
    ri_upd: {
      file_id: 'ri_upd',
      last_read_revision_id: 'r_old',
      scrollPercent: 40,
      isFullyRead: false,
      bookmarked: false,
      updated_at: '2026-11-23T08:00:00+08:00',
    },
  };
  const stats = computeReadingIslandStats(files, readingStates);
  const html = renderToStaticMarkup(
    React.createElement(ReadingIslandPanel, {
      inSheet: true,
      stats,
      quota: {
        usedTotalMiB: 12,
        maxTotalMiB: 256,
        maxSingleBinaryMiB: 10,
        protectedSnapshotsCount: 0,
        evictedSnapshotsCount: 0,
      },
      onOpenDoc: () => {},
      onClose: () => {},
      onMarkFileRead: () => {},
      onMarkFileUnread: () => {},
      onMarkReadingBaseline: () => {},
    })
  );

  assert.ok(html.includes('data-island-progress-bar=""'), '抽屉顶部展示双色阅读进度轨');
  assert.ok(html.includes('data-island-filter-bar=""'), '抽屉展示状态筛选胶囊条');
  assert.ok(html.includes('data-island-filter="updated"'), '存在读后有更新时展示「有更新」快捷筛选');
  assert.ok(html.includes('data-island-mark-baseline=""'), '存在未读时展示一键「确立基线」按钮');
  assert.ok(html.includes('data-island-toggle-read="ri_read"'), '已读行提供 1-click 标未读按钮');
  assert.ok(html.includes('data-island-toggle-read="ri_upd"'), '未读行提供 1-click 标已读按钮');
  assert.ok(html.includes('data-island-show-more="未读"'), '超过 60 条的分组默认折叠以保障 60fps 流畅滚动');
});
