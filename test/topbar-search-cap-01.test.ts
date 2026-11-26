import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  searchWorkspace,
  searchWorkspaceCapped,
  TOPBAR_SEARCH_LIMIT,
} from '../src/utils/guanlanEngine';
import type { FileRecord } from '../src/types/guanlan';


function fileWithBody(tag: string, index: number, body: string): FileRecord {
  const revisionId = `rev_cap_${tag}_${String(index).padStart(5, '0')}`;
  return {
    file_id: `f_cap_${tag}_${String(index).padStart(5, '0')}`,
    relative_path: `cap-fixtures/文档-${index}.md`,
    title: `文档 ${index}`,
    format: 'md',
    folder: 'cap-fixtures',
    role: '其他',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revisionId,
    coverage: 'full_text',
    revisions: [
      {
        revision_id: revisionId,
        markdownContent: body,
        observed_at: '2026-11-25T00:00:00.000Z',
        snapshotAvailable: true,
      },
    ],
  } as unknown as FileRecord;
}

test('命中数超过上限时截断并标记 truncated', () => {
  const files = Array.from({ length: TOPBAR_SEARCH_LIMIT + 25 }, (_, i) =>
    fileWithBody('over', i, '性能验证行')
  );
  const result = searchWorkspaceCapped(files, '性能');
  assert.equal(result.hits.length, TOPBAR_SEARCH_LIMIT);
  assert.equal(result.truncated, true, '超出上限必须标明未列全');
  assert.ok(searchWorkspace(files, '性能').length > TOPBAR_SEARCH_LIMIT);
});

test('命中数在上限内时原样返回且不标记截断', () => {
  const files = Array.from({ length: 3 }, (_, i) => fileWithBody('within', i, '性能验证行'));
  const result = searchWorkspaceCapped(files, '性能');
  assert.equal(result.hits.length, 3);
  assert.equal(result.truncated, false);
});

test('没有命中时返回空列表而不是「被截断」', () => {
  const files = Array.from({ length: 5 }, (_, i) => fileWithBody('none', i, '无关正文'));
  const result = searchWorkspaceCapped(files, '性能');
  assert.deepEqual(result.hits, []);
  assert.equal(result.truncated, false, '空结果不得冒充截断');
});

test('上限可显式指定', () => {
  const files = Array.from({ length: 10 }, (_, i) => fileWithBody('explicit', i, '性能验证行'));
  const result = searchWorkspaceCapped(files, '性能', 4);
  assert.equal(result.hits.length, 4);
  assert.equal(result.truncated, true);
});
