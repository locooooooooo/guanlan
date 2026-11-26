import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReaderView } from '../src/components/ReaderView';
import { TopHeader } from '../src/components/TopHeader';
import { ReviewBoardDrawer } from '../src/components/ReviewBoardDrawer';
import { ChronosDigestDrawer } from '../src/components/ChronosDigestDrawer';
import { buildLocalRelationGraph } from '../src/utils/guanlanEngine';
import type { FileRecord, WorkspaceConfig } from '../src/types/guanlan';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
}

function makeRollbackFile(): FileRecord {
  return {
    file_id: 'f_batch2_01',
    relative_path: 'docs/Q01-登录决策记录.md',
    title: 'Q01-登录决策记录',
    format: 'md',
    folder: 'docs',
    role: '决策',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'rev_deadbeef0003',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_deadbeef0001',
        file_id: 'f_batch2_01',
        versionNumber: 1,
        content_sha256: 'sha_alpha',
        observed_at: '2026-11-24T09:00:00+08:00',
        source_time: '2026-11-24',
        sizeBytes: 512,
        snapshotAvailable: true,
        summaryNote: '初稿',
      },
      {
        revision_id: 'rev_deadbeef0002',
        file_id: 'f_batch2_01',
        versionNumber: 2,
        content_sha256: 'sha_beta',
        observed_at: '2026-11-25T09:00:00+08:00',
        source_time: '2026-11-25',
        sizeBytes: 640,
        snapshotAvailable: true,
        summaryNote: '修订',
      },
      {
        revision_id: 'rev_deadbeef0003',
        file_id: 'f_batch2_01',
        versionNumber: 3,
        content_sha256: 'sha_alpha',
        observed_at: '2026-11-26T09:00:00+08:00',
        source_time: '2026-11-26',
        sizeBytes: 512,
        snapshotAvailable: true,
        summaryNote: '恢复初稿',
      },
    ],
  } as FileRecord;
}

test('阅读器顶栏容器自适应与叠层顺序：三栏窄宽不挤压标题、进度条不穿透顶栏浮层、回滚标签不泄裸 rev_id', () => {
  const indexCss = readSrc('index.css');
  assert.ok(indexCss.includes('container-name: reader-shell;'), 'Reader 外壳需声明 reader-shell 容器查询');
  assert.ok(indexCss.includes('@container reader-shell (max-width: 980px)'), '≤980px 自动分两行保护文档标题');
  assert.ok(indexCss.includes('@container reader-shell (max-width: 680px)'), '≤680px 进一步收敛次级前缀');

  const file = makeRollbackFile();
  const noop = () => {};
  const html = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [file],
      activeFile: file,
      pinnedRevisionId: file.current_revision_id,
      onChangeRevision: noop,
      subMode: 'read',
      onChangeSubMode: noop,
      onMarkReadHere: noop,
      onMarkFullyRead: noop,
      onScrollProgress: noop,
      onToggleBookmark: noop,
      onNavigateLinkedFile: noop,
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: noop,
      decisions: [],
      relations: [],
      onSelectDecision: noop,
      onAddEvidencePointer: noop,
      indexGeneration: 1,
    })
  );

  assert.ok(html.includes('data-reader-header-identity'), '顶栏身份行锚点在位');
  assert.ok(html.includes('data-reader-header-controls'), '顶栏操作行锚点在位');
  assert.ok(html.includes('data-reader-doc-time-prefix'), '文档日期前缀具可折叠锚点');
  assert.ok(html.includes('恢复自 v1'), '回滚标注应显示人类版本号 v1');
  assert.ok(!html.includes('恢复自 rev_deadbeef0001'), '回滚标注不得泄露裸 revision_id');
  assert.ok(
    html.includes('data-reader-progress="" class="relative z-10'),
    '阅读进度条层级须低于顶栏与阅读器弹出浮层'
  );
});

test('局部关系图：版本节点呈现人类版本号而非裸 revision_id，且支持纸面浅色画布与节点名边提示', () => {
  const file = makeRollbackFile();
  const graph = buildLocalRelationGraph(file.file_id, 1, [file], [], []);
  const revNodes = graph.nodes.filter((n) => n.kind === 'revision');
  assert.equal(revNodes.length, 3);
  assert.equal(revNodes[0].label, 'v1');
  assert.equal(revNodes[2].label, 'v3（最新）');
  assert.ok(
    revNodes.every((n) => !n.label.includes('rev_deadbeef')),
    '关系图版本节点标签不得泄露内部 revision_id'
  );

  const relSrc = readSrc('components/reader/readerRelationsSection.tsx');
  assert.ok(!relSrc.includes('${edge.source_id} → ${edge.target_id}'), '边悬浮提示不得直出内部 ID');
  assert.ok(relSrc.includes("bg-[#F4F1EA]"), '纸面浅色模式关系图须切至浅色底');
  assert.ok(relSrc.includes("node.kind === 'revision'"), '点击版本节点可直接切换版本阅读');
});

test('顶栏快速检索与工程术语净化：命中高亮 <mark>、z-40 叠层、无 HITL/L4A 及 color-mix white 残留', () => {
  const config: WorkspaceConfig = {
    rootPath: 'F:/demo',
    rootKey: 'f:/demo',
    dataDirPath: 'F:/demo/.guanlan',
    excludedDirs: [],
    disableGitIgnore: false,
    gitIgnoreWarning: '',
    enumSnapshot: {
      date: '2026-11-26',
      totalCount: 2,
      mdCount: 2,
      svgCount: 0,
      pdfCount: 0,
      indexedSuccessCount: 2,
      parseFailedCount: 0,
      pdfUnindexedCount: 0,
    },
    quota: {
      maxTotalMiB: 512,
      usedTotalMiB: 1,
      maxSingleBinaryMiB: 20,
      protectedSnapshotsCount: 0,
      evictedSnapshotsCount: 0,
    },
    runtimeStatus: {
      connectionMode: 'direct_stdio',
      serviceState: 'monitoring',
      sseSeq: 1,
      indexGeneration: 1,
      activeAgents: [],
      loopbackUrl: 'http://127.0.0.1:4193',
    },
  };
  const noop = () => {};
  const headerHtml = renderToStaticMarkup(
    React.createElement(TopHeader, {
      activeTab: 'library',
      onSelectTab: noop,
      libraryMode: 'read',
      onLibraryModeChange: noop,
      searchQuery: '登录',
      onSearchChange: noop,
      searchHits: [
        {
          file_id: 'f_1',
          revision_id: 'rev_1',
          title: 'Q01-登录决策记录',
          relative_path: 'docs/Q01-登录决策记录.md',
          format: 'md',
          coverage: 'full_text',
          matchStrategy: 'bigram_phrase_verified',
          locator: { kind: 'lines', start: 1, end: 1 },
          stale: false,
          snippet: '可选方案：统一登录 / 保留本地账户',
        },
      ],
      onSelectSearchHit: noop,
      config,
      eventCount: 1,
      unreadFilesCount: 0,
      files: [],
      decisions: [],
      onOpenDecision: noop,
      sidebarFilters: {
        quickScope: 'all',
        folder: 'all',
        format: 'all',
        role: 'all',
        topic: 'all',
      },
      onUpdateSidebarFilters: noop,
      onResetSidebarFilters: noop,
      contextBasketCount: 2,
      onOpenContextDrawer: noop,
      onOpenReviewBoard: noop,
      onOpenMcpConsole: noop,
      onOpenSettings: noop,
      dataSource: 'real',
      scanSummary: '',
      dataError: null,
      isScanning: false,
      onRescan: noop,
    })
  );

  assert.ok(headerHtml.includes('<header class="relative z-40'), 'TopHeader 叠层须高于正文与进度条');
  assert.ok(headerHtml.includes('<mark'), '顶栏快速检索命中项须高亮关键词');
  assert.ok(headerHtml.includes('data-esc-layer="open"'), '搜索结果下拉接入全局 Esc 阶梯');
  assert.ok(!headerHtml.includes('HITL'), '顶栏按钮提示不得泄露 HITL 缩写');

  const reviewHtml = renderToStaticMarkup(
    React.createElement(ReviewBoardDrawer, {
      isOpen: true,
      onClose: noop,
      board: null,
      loading: false,
      error: null,
      busyKey: null,
      notice: null,
      onRefresh: noop,
      onJumpToStatement: noop,
      onAcknowledgeStatement: noop,
      onInspectDraft: noop,
      onRepairOrphan: noop,
    })
  );
  assert.ok(reviewHtml.includes('人工拍板与回执联动'));
  assert.ok(reviewHtml.includes('智能体运行中'));
  assert.ok(!reviewHtml.includes('HITL'));

  const digestHtml = renderToStaticMarkup(
    React.createElement(ChronosDigestDrawer, {
      isOpen: true,
      onClose: noop,
      events: [],
      files: [],
      decisions: [],
      onOpenDocument: noop,
      onOpenDecision: noop,
    })
  );
  assert.ok(digestHtml.includes('本地语义摘要'));
  assert.ok(!digestHtml.includes('L4A 摘要'));

  for (const rel of [
    'components/ReviewBoardDrawer.tsx',
    'components/TopHeader.tsx',
    'components/CalendarBoardView.tsx',
  ]) {
    const src = readSrc(rel);
    assert.ok(!/color-mix\([^)]*,\s*white\b/i.test(src), `${rel} 不得残留 color-mix(..., white) 深色漏白`);
  }
});
