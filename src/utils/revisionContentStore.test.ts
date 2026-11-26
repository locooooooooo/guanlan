import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearRevisionContentStoreForTest,
  getRevisionContent,
  mergeDetailRevisionsPreservingContent,
  pinRevisionContent,
  requestRevisionContent,
  requestRevisionContentsBatch,
  setByteBudgetForTest,
  unpinRevisionContent,
  revisionContentStoreStatsForTest,
  type ContentFetchResult,
} from './revisionContentStore';

function okFetch(text: string): (id: string) => Promise<ContentFetchResult> {
  const seen: string[] = [];
  const fn = async (id: string) => {
    seen.push(id);
    return { ok: true, text };
  };
  return Object.assign(fn, { seen });
}

test('同版本并发读取合并为一次底层请求；ready 命中不再发请求', async () => {
  clearRevisionContentStoreForTest();
  let calls = 0;
  const fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, text: '正文内容' };
  };
  const [a, b] = await Promise.all([
    requestRevisionContent('rev_x', fetch, 'md'),
    requestRevisionContent('rev_x', fetch, 'md'),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, '正文内容');
  assert.equal(b, '正文内容');

  const c = await requestRevisionContent('rev_x', fetch, 'md');
  assert.equal(calls, 1);
  assert.equal(c, '正文内容');
  const stats = revisionContentStoreStatsForTest();
  assert.equal(stats.ready, 1);
});

test('失败不永久锁死：failed 后再次请求重新拉取；wire 错误码保留', async () => {
  clearRevisionContentStoreForTest();
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, code: 'SNAPSHOT_UNAVAILABLE', error: '快照过保留期' };
    }
    return { ok: true, text: '重试成功' };
  };
  const first = await requestRevisionContent('rev_y', fetch, 'md');
  assert.equal(first, null);
  const failedEntry = getRevisionContent('rev_y');
  assert.equal(failedEntry?.state, 'failed');
  assert.equal(failedEntry?.code, 'SNAPSHOT_UNAVAILABLE');

  const second = await requestRevisionContent('rev_y', fetch, 'md');
  assert.equal(calls, 2);
  assert.equal(second, '重试成功');
  assert.equal(getRevisionContent('rev_y')?.state, 'ready');
});

test('字节 LRU：按字节预算逐最旧；pin 的当前阅读版本不被逐出', async () => {
  clearRevisionContentStoreForTest();
  setByteBudgetForTest(100);
  const fetch = okFetch('x'.repeat(60));
  await requestRevisionContent('rev_a', fetch, 'md');
  await requestRevisionContent('rev_b', fetch, 'md');
  assert.equal(getRevisionContent('rev_a'), undefined);
  assert.equal(getRevisionContent('rev_b')?.state, 'ready');

  pinRevisionContent('rev_b');
  await requestRevisionContent('rev_c', fetch, 'md');
  assert.equal(getRevisionContent('rev_b')?.state, 'ready');
  assert.equal(getRevisionContent('rev_c')?.state, 'ready');

  unpinRevisionContent('rev_b');
  await requestRevisionContent('rev_d', fetch, 'md');
  assert.equal(getRevisionContent('rev_b'), undefined);
  assert.equal(getRevisionContent('rev_d')?.state, 'ready');
  setByteBudgetForTest(0);
});

test('晚到 detail 合并：既有已加载正文不丢；store ready 条目兜底回填', async () => {
  clearRevisionContentStoreForTest();
  interface RevLike {
    revision_id: string;
    summaryNote: string;
    markdownContent?: string;
    svgSource?: string;
    svgExtractedTexts?: string[];
  }
  const existing: RevLike[] = [
    { revision_id: 'r1', summaryNote: 'v1', markdownContent: '已加载的第一版正文' },
    { revision_id: 'r2', summaryNote: 'v2' },
  ];
  const incoming: RevLike[] = [
    { revision_id: 'r1', summaryNote: 'v1 · docs/a.md（服务端重组）' },
    { revision_id: 'r2', summaryNote: 'v2 · docs/a.md（服务端重组）' },
    { revision_id: 'r3', summaryNote: 'v3 · docs/a.md（服务端重组）' },
  ];

  const fetch = okFetch('store 里的第三版正文');
  await requestRevisionContent('r3', fetch, 'md');

  const merged = mergeDetailRevisionsPreservingContent(
    existing,
    incoming,
    'md',
    (id) => getRevisionContent(id)
  );
  assert.match(merged[0].summaryNote, /服务端重组/);
  assert.equal(merged[0].markdownContent, '已加载的第一版正文');
  assert.equal(merged[1].markdownContent, undefined);
  assert.equal(merged[2].markdownContent, 'store 里的第三版正文');
});

test('晚到 detail 合并（svg）：store 补源重算抽取文本；detail 自带字段优先', async () => {
  clearRevisionContentStoreForTest();
  interface RevLike {
    revision_id: string;
    summaryNote: string;
    markdownContent?: string;
    svgSource?: string;
    svgExtractedTexts?: string[];
  }
  const extract = (source: string) => [`${source} 提取文本`];
  const existing: RevLike[] = [
    { revision_id: 's1', summaryNote: 'v1', svgSource: '<svg>旧</svg>', svgExtractedTexts: ['旧提取'] },
  ];
  const incoming: RevLike[] = [
    { revision_id: 's1', summaryNote: 'v1 detail' },
    { revision_id: 's2', summaryNote: 'v2 detail' },
  ];
  const fetch = okFetch('<svg>store源</svg>');
  await requestRevisionContent('s2', fetch, 'svg');

  const merged = mergeDetailRevisionsPreservingContent(
    existing,
    incoming,
    'svg',
    (id) => getRevisionContent(id),
    extract
  );
  assert.equal(merged[0].svgSource, '<svg>旧</svg>');
  assert.deepEqual(merged[0].svgExtractedTexts, ['旧提取']);
  assert.equal(merged[1].svgSource, '<svg>store源</svg>');
  assert.deepEqual(merged[1].svgExtractedTexts, ['<svg>store源</svg> 提取文本']);

  const mergedNoStore = mergeDetailRevisionsPreservingContent(existing, incoming, 'svg');
  assert.equal(mergedNoStore[0].svgSource, '<svg>旧</svg>');
});

test('批量通道：existing 跳过、ready 回填、失败写入 failed', async () => {
  clearRevisionContentStoreForTest();
  let calls = 0;
  const fetch = async (id: string) => {
    calls++;
    if (id === 'rev_fail') return { ok: false, error: '读取失败' };
    return { ok: true, text: `text-${id}` };
  };
  await requestRevisionContent('rev_ready', fetch, 'md');
  const result = await requestRevisionContentsBatch(
    ['rev_ready', 'rev_new', 'rev_fail', 'rev_ready'],
    fetch,
    { existing: { rev_existing: '已有' } }
  );
  assert.equal(calls, 3);
  assert.deepEqual(result.contents, { rev_ready: 'text-rev_ready', rev_new: 'text-rev_new' });
  assert.deepEqual(result.failed, { rev_fail: '读取失败' });
});
