import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { ReaderView } from '../src/components/ReaderView';
import { buildReaderDocTimeView } from '../src/components/reader/readerChromeSections';
import type { FileRecord } from '../src/types/guanlan';
import { localDay } from '../src/utils/timeFormat';


function makeFile(sourceTime: string | undefined): FileRecord {
  return {
    file_id: 'f_doc_time',
    relative_path: 'docs/subsystems/workspace-writes.md',
    title: '工作区写入',
    format: 'md',
    folder: 'docs',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'rev_doc_time',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_doc_time',
        file_id: 'f_doc_time',
        versionNumber: 1,
        content_sha256: 'sha_doc_time',
        observed_at: '2026-11-24T09:14:00+08:00',
        source_time: sourceTime,
        sizeBytes: 2048,
        snapshotAvailable: true,
        summaryNote: '',
      },
    ],
  } as FileRecord;
}

function readerProps(file: FileRecord) {
  const noop = () => {};
  return {
    files: [file],
    activeFile: file,
    pinnedRevisionId: file.current_revision_id,
    onChangeRevision: noop,
    subMode: 'read' as const,
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
    indexGeneration: 0,
  };
}

test('文档时间：source_time 优先，按本地日历日呈现且不掺采集时刻', () => {
  const declared = buildReaderDocTimeView('2026-11-24', '2026-11-25T02:00:00.000Z');
  assert.equal(declared.basis, 'source_time', '有文档日期时取 source_time 口径');
  assert.equal(declared.label, '文档日期 2026-11-24', '可见文案带口径词与日期');
  assert.equal(declared.dateTime, '2026-11-24', 'time[datetime] 为文档日期');
  assert.match(declared.title, /source_time/, '悬浮说明标注 source_time');
  assert.match(declared.title, /observed_at/, '悬浮说明同时给出采集口径，不合并');

  const iso = '2026-11-24T23:30:00Z';
  const withTime = buildReaderDocTimeView(iso, '2026-11-25T02:00:00.000Z');
  assert.equal(withTime.basis, 'source_time');
  assert.equal(withTime.label, `文档日期 ${localDay(iso)}`, '按本地日历日取日');
});

test('文档时间：source_time 缺失或坏值时如实回退采集时刻，不冒充文章日期', () => {
  const missing = buildReaderDocTimeView(undefined, '2026-11-25T02:00:00.000Z');
  assert.equal(missing.basis, 'observed_at');
  assert.match(missing.label, /^采集于 /, '回退文案显式写「采集于」');
  assert.doesNotMatch(missing.label, /文档日期/, '不得把采集时刻写成文档日期');

  const blank = buildReaderDocTimeView('   ', '2026-11-25T02:00:00.000Z');
  assert.equal(blank.basis, 'observed_at', '空白 source_time 视为未记载');

  const garbage = buildReaderDocTimeView('not-a-date', '2026-11-25T02:00:00.000Z');
  assert.equal(garbage.basis, 'observed_at', '坏日期不冒充文档日期');

  const placeholder = buildReaderDocTimeView('2026-11-01', '2026-11-25T02:00:00.000Z', false);
  assert.equal(placeholder.basis, 'observed_at', '占位行回退采集时刻');
  assert.doesNotMatch(placeholder.label, /2026-11-01/, '占位行不得直出最早版本日期');
});

test('阅读器文件头：有文档日期时首屏可见文档日期胶囊', () => {
  const html = renderToString(createElement(ReaderView, readerProps(makeFile('2026-11-24'))));
  assert.ok(
    html.includes('data-reader-doc-time="source_time"'),
    '首屏 DOM 必须带 source_time 时间胶囊（不再只藏在溯源面板）'
  );
  assert.ok(html.includes('文档日期'), '文件主行直出「文档日期」口径词');
  assert.ok(html.includes('2026-11-24'), '文件主行直出文档日期值');
});

test('阅读器文件头：无文档日期时首屏可见采集时刻胶囊', () => {
  const html = renderToString(createElement(ReaderView, readerProps(makeFile(undefined))));
  assert.ok(
    html.includes('data-reader-doc-time="observed_at"'),
    '无 source_time 时回退 observed_at 胶囊仍在首屏'
  );
  assert.ok(html.includes('采集于 '), '回退态显式标注采集口径');
  assert.ok(!html.includes('文档日期 2026'), '无 source_time 时不得渲染文档日期');
});
