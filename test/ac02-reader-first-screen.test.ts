import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToString } from 'react-dom/server';

import { ReaderView } from '../src/components/ReaderView';
import {
  READER_FIRST_SCREEN_BUDGET_MS,
  getLastReaderFirstScreenSample,
  recordReaderFirstScreenSample,
  resetReaderFirstScreenSampleForTest,
  resolveReaderBodyPhase,
} from '../src/utils/readerFirstScreen';
import type { FileRecord } from '../src/types/guanlan';

function coldStartFile(): FileRecord {
  return {
    file_id: 'f_ac02',
    relative_path: '01-方案文档/p1/PLAN.md',
    title: 'PLAN',
    format: 'md',
    folder: '01-方案文档',
    role: '说明',
    current_revision_id: 'rev_ac02',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_ac02',
        versionNumber: 1,
        observed_at: '2026-11-18T10:00:00+08:00',
        source_time: '2026-11-18',
        snapshotAvailable: true,
        summaryNote: '摘要',
        changedSectionsFromPrev: [],
      },
    ],
  } as unknown as FileRecord;
}

function readerProps(file: FileRecord): ComponentProps<typeof ReaderView> {
  return {
    files: [file],
    activeFile: file,
    pinnedRevisionId: file.current_revision_id,
    onChangeRevision: () => {},
    subMode: 'read',
    onChangeSubMode: () => {},
    onMarkReadHere: () => {},
    onMarkFullyRead: () => {},
    onScrollProgress: () => {},
    onToggleBookmark: () => {},
    onNavigateLinkedFile: () => {},
    returnBreadcrumb: null,
    onFollowReturnBreadcrumb: () => {},
    decisions: [],
    relations: [],
    onSelectDecision: () => {},
    onAddEvidencePointer: () => {},
    indexGeneration: 0,
  };
}

test('阅读器首屏预算常量 = 300ms', () => {
  assert.equal(READER_FIRST_SCREEN_BUDGET_MS, 300);
});

test('正文读取态：错误优先于 loading；正文内联优先于两者（shell 始终先渲染）', () => {
  assert.equal(
    resolveReaderBodyPhase({ hasInlineContent: false, hasError: true, pending: true }),
    'error'
  );
  assert.equal(
    resolveReaderBodyPhase({ hasInlineContent: false, hasError: false, pending: true }),
    'loading'
  );
  assert.equal(
    resolveReaderBodyPhase({ hasInlineContent: false, hasError: false, pending: false }),
    'article'
  );
  assert.equal(
    resolveReaderBodyPhase({ hasInlineContent: true, hasError: true, pending: true }),
    'article'
  );
});

test('首屏测量：<300ms 预算内、>=300ms 超预算；最近样本可读', () => {
  resetReaderFirstScreenSampleForTest();
  const ok = recordReaderFirstScreenSample({
    fileId: 'f_ac02',
    revisionId: 'rev_ac02',
    elapsedMs: 120,
    contentPending: true,
  });
  assert.equal(ok.withinBudget, true);
  assert.equal(ok.contentPending, true);
  assert.equal(getLastReaderFirstScreenSample()?.elapsedMs, 120);

  const edge = recordReaderFirstScreenSample({
    fileId: 'f_ac02',
    revisionId: 'rev_ac02',
    elapsedMs: 299,
    contentPending: false,
  });
  assert.equal(edge.withinBudget, true, '299ms 在预算内');

  const boundary = recordReaderFirstScreenSample({
    fileId: 'f_ac02',
    revisionId: 'rev_ac02',
    elapsedMs: 300,
    contentPending: false,
  });
  assert.equal(boundary.withinBudget, false, '300ms 不满足严格 < 300ms');

  const over = recordReaderFirstScreenSample({
    fileId: 'f_ac02',
    revisionId: 'rev_ac02',
    elapsedMs: 301,
    contentPending: false,
  });
  assert.equal(over.withinBudget, false);
  assert.equal(getLastReaderFirstScreenSample()?.elapsedMs, 301);

  const clamped = recordReaderFirstScreenSample({
    fileId: 'f_ac02',
    revisionId: 'rev_ac02',
    elapsedMs: -12,
    contentPending: false,
  });
  assert.equal(clamped.elapsedMs, 0, '异常负值钳到 0，不产生负耗时');
});

test('冷启动正文未内联：ReaderView 首屏 SSR 渲染 < 300ms，shell 与标题立即可见', () => {
  const file = coldStartFile();
  const started = performance.now();
  const html = renderToString(createElement(ReaderView, readerProps(file)));
  const elapsedMs = performance.now() - started;

  assert.ok(html.includes('data-reader-shell'), '首屏 shell 根标记存在');
  assert.ok(html.includes('PLAN'), '文档标题在首屏 HTML 中');
  assert.ok(
    !html.includes('正在向智能体请求正文'),
    '首屏不得出现「正在向智能体请求正文」阻塞遮罩'
  );
  assert.ok(
    elapsedMs < READER_FIRST_SCREEN_BUDGET_MS,
    `首屏渲染 ${elapsedMs.toFixed(1)}ms 应 < ${READER_FIRST_SCREEN_BUDGET_MS}ms`
  );
});

test('ReaderView 接线：首屏测量与正文三态走 readerFirstScreen 单一出口', () => {
  const src = [
    '../src/components/ReaderView.tsx',
    '../src/components/reader/useReaderController.tsx',
    '../src/components/reader/readerMarkdownSection.tsx',
  ]
    .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
    .join('\n');
  for (const token of [
    'READER_FIRST_SCREEN_BUDGET_MS',
    'recordReaderFirstScreenSample',
    'resolveReaderBodyPhase',
    'data-reader-shell',
    'data-reader-first-screen-ms',
    '文档框架已就绪',
  ]) {
    assert.ok(src.includes(token), `ReaderView 缺 ${token}`);
  }
});
