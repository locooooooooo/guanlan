import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';

import {
  extractSvgTextNodes,
  fetchAllFileSummaries,
  fetchBootstrap,
  fetchEventPage,
  fetchFileHistory,
  fetchFileRevisionsPage,
  fetchFileSummaries,
  fetchRevisionContent,
  fetchRevisionContentsBatch,
  fileSummaryToFileRecord,
  folderOfRelativePath,
  revisionsFromHistory,
  revisionRawUrl,
  setApiBaseUrl,
  type FileSummaryPage,
} from '../src/services/workspaceClient';



type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

async function startStub(routes: Array<{ match: (url: URL, req: IncomingMessage) => boolean; handler: Handler }>) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://stub.local');
    const route = routes.find((r) => r.match(url, req));
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: 'stub 无此路由' }));
      return;
    }
    route.handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}


function summaryOf(i: number): FileSummaryPage['items'][number] {
  const n = String(i).padStart(3, '0');
  return {
    file_id: `file_${n}`,
    relative_path: `docs/a${n}.md`,
    title: `文档 ${n}`,
    format: 'md',
    folder: 'docs',
    role: '方案',
    status: 'active',
    current_revision_id: `rev_${n}_v1`,
    revision_count: 1,
    first_observed_at: '2026-11-01T00:00:00.000Z',
    last_observed_at: '2026-11-10T00:00:00.000Z',
    first_source_time: '2026-11-05',
    coverage: 'full_text',
    snapshot_available: true,
  };
}

function filePageFor(url: URL, total: number, pageSize: number): FileSummaryPage {
  const cursor = url.searchParams.get('cursor');
  const limit = Number(url.searchParams.get('limit') || pageSize);
  const offset = cursor ? Number(cursor.replace('cur-', '')) : 0;
  const items = Array.from({ length: total }, (_, i) => summaryOf(i + 1)).slice(offset, offset + limit);
  const hasMore = offset + items.length < total;
  return {
    ok: true,
    index_generation: 12,
    snapshot_generation: 12,
    items,
    next_cursor: hasMore ? `cur-${offset + items.length}` : null,
    has_more: hasMore,
    total_matched: total,
    facets: { folders: { docs: total }, formats: { md: total }, matters: { 方案: total } },
  };
}

describe('workspaceClient /api/v1（本地 http 桩）', () => {
  test('bootstrap 解析：workspace/counts/files 首批/decisions/config 逐字保留（契约 §1.1）', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/bootstrap',
        handler: (_req, res, url) => {
          assert.equal(url.searchParams.get('days_limit'), '120');
          assert.equal(url.searchParams.get('days_samples'), '6');
          assert.equal(url.searchParams.get('events_limit'), '50');
          json(res, 200, {
            ok: true,
            workspace: {
              workspace_id: 'ws_abc',
              root_path: 'H:/proj',
              root_key: 'abc123',
              created_at: '2026-11-01T00:00:00.000Z',
              last_scan_at: null,
              index_generation: 12,
            },
            baseline: false,
            counts: { files: 2, revisions: 2, events: 3, blobs: 2, statements: 1, edges: 0 },
            time_range: {
              occurredMin: '2026-11-01',
              occurredMax: '2026-11-05',
              observedMin: '2026-11-01',
              observedMax: '2026-11-10',
              undatedCount: 0,
            },
            event_days: { ok: true, index_generation: 12, order: 'occurred', granularity: 'day', from: null, to: null, groups: [], total: 3, hidden_days: 0, undated_count: 0 },
            events: { ok: true, index_generation: 12, window: { order: 'occurred', from: null, to: null, kinds: [], format: null, undated: false, q: null }, snapshot_max_seq: 3, items: [], next_cursor: null, has_more: false, total_in_window: 3, undated_count: 0, newer_count: 0 },
            files: { ...filePageFor(url, 2, 100), facets: { folders: {}, formats: {}, matters: {} } },
            files_total: 2,
            decisions: [],
            relations_total: 0,
            config: {},
            index_jobs: [],
          });
        },
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const result = await fetchBootstrap({ daysLimit: 120, daysSamples: 6, filesPageSize: 100, eventsLimit: 50 });
      assert.equal(result.ok, true);
      assert.ok(result.data);
      assert.equal(result.data.workspace.index_generation, 12);
      assert.equal(result.data.baseline, false, '空工作区 baseline=false，前端按「尚未覆盖」渲染');
      assert.equal(result.data.counts.events, 3);
      assert.equal(result.data.files_total, 2);
      assert.equal(JSON.stringify(result.data).includes('svgSource'), false);
      assert.equal(JSON.stringify(result.data).includes('markdownContent'), false);
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('files 分页遍历：多页游标按 file_id 全量合并、有序、 onPage 逐页回调', async () => {
    const requested: Array<string | null> = [];
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/files',
        handler: (_req, res, url) => {
          requested.push(url.searchParams.get('cursor'));
          json(res, 200, filePageFor(url, 7, 3));
        },
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const pages: FileSummaryPage[] = [];
      const result = await fetchAllFileSummaries({ limit: 3 }, (page) => pages.push(page));
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 7, '三页（3+3+1）应合并全部 7 条');
      const paths = result.items.map((i) => i.relative_path);
      assert.deepEqual(paths, [...paths].sort());
      assert.equal(new Set(result.items.map((i) => i.file_id)).size, 7, '按 file_id 去重不缺不重');
      assert.equal(result.total_matched, 7);
      assert.equal(pages.length, 3, 'onPage 每页回调一次');
      assert.deepEqual(requested, [null, 'cur-3', 'cur-6'], '续页携带服务端签发的游标');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('files 游标失效（CURSOR_STALE）：保留已取回页并从头重走，最终取全（契约 §1.3 可变列表）', async () => {
    let generation = 12;
    let servedOldCursor = false;
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/files',
        handler: (_req, res, url) => {
          const cursor = url.searchParams.get('cursor');
          if (cursor === 'cur-2' && !servedOldCursor) {
            servedOldCursor = true;
            generation += 1;
            json(res, 409, {
              ok: false,
              code: 'CURSOR_STALE',
              error: '列表已更新，游标失效',
              index_generation: generation,
            });
            return;
          }
          const page = filePageFor(url, 5, 2);
          json(res, 200, { ...page, index_generation: generation, snapshot_generation: generation });
        },
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const result = await fetchAllFileSummaries({ limit: 2 });
      assert.equal(result.ok, true, '游标失效重走后应成功取全');
      assert.equal(result.items.length, 5);
      assert.ok(servedOldCursor, '夹具必须真的触发过一次 CURSOR_STALE');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('files 非游标类错误如实返回（NOT_FOUND 不重试）', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/files',
        handler: (_req, res) => json(res, 500, { ok: false, code: 'INTERNAL', error: '服务内部错误' }),
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const result = await fetchFileSummaries();
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INTERNAL');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('events 窗口分页：游标续页累计不重不漏，snapshot_max_seq 随页保持（契约 §1.4/§0.3）', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/events',
        handler: (_req, res, url) => {
          const cursor = url.searchParams.get('cursor');
          const offset = cursor ? Number(cursor.replace('ec-', '')) : 0;
          const all = Array.from({ length: 6 }, (_, i) => ({
            seq: 6 - i,
            event_id: `evt_${6 - i}`,
            kind: 'modified',
            subject_kind: 'revision',
            subject_id: `rev_${6 - i}`,
            revision_id: null,
            occurred_at: '2026-11-05',
            occurred_precision: 'day',
            occurred_source: 'document_self',
            observed_at: '2026-11-10T00:00:00.000Z',
            headline: `事件 ${6 - i}`,
            detail: '',
            payload: {},
            file_id: 'file_001',
            file_path: 'docs/a001.md',
            file_title: '文档 001',
            format: 'md',
          }));
          const items = all.slice(offset, offset + 2);
          const hasMore = offset + items.length < all.length;
          json(res, 200, {
            ok: true,
            index_generation: 12,
            window: { order: 'occurred', from: null, to: null, kinds: [], format: null, undated: false, q: null },
            snapshot_max_seq: 6,
            items,
            next_cursor: hasMore ? `ec-${offset + items.length}` : null,
            has_more: hasMore,
            total_in_window: 6,
            undated_count: 0,
            newer_count: 0,
          });
        },
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const first = await fetchEventPage({ limit: 2 });
      assert.equal(first.stale, false);
      assert.ok(first.page);
      assert.equal(first.page.snapshot_max_seq, 6, '窗口快照绑定');
      const seen: number[] = first.page.items.map((i) => i.seq);
      let cursor = first.page.next_cursor;
      let guard = 0;
      while (cursor && guard < 10) {
        const next = await fetchEventPage({ limit: 2, cursor });
        assert.ok(next.page);
        seen.push(...next.page.items.map((i) => i.seq));
        cursor = next.page.next_cursor;
        guard += 1;
      }
      assert.deepEqual(seen.sort((a, b) => b - a), [6, 5, 4, 3, 2, 1], '翻页不重不漏覆盖全窗');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('events 游标失效：fetchEventPage 返回 stale=true 且 page=null（调用方保留数据重取首页）', async () => {
    let invalidateNext = false;
    let issuedCursor: string | null = null;
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/events',
        handler: (_req, res, url) => {
          const cursor = url.searchParams.get('cursor');
          if (cursor && invalidateNext) {
            json(res, 409, { ok: false, code: 'CURSOR_STALE', error: '游标绑定筛选不一致', index_generation: 13 });
            return;
          }
          json(res, 200, {
            ok: true,
            index_generation: 12,
            window: { order: 'occurred', from: null, to: null, kinds: ['modified'], format: null, undated: false, q: null },
            snapshot_max_seq: 4,
            items: [],
            next_cursor: cursor ? null : 'ec-next',
            has_more: !cursor,
            total_in_window: 4,
            undated_count: 0,
            newer_count: 0,
          });
          if (!cursor) issuedCursor = 'ec-next';
        },
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const first = await fetchEventPage({ limit: 2, kinds: ['modified'] });
      assert.equal(first.stale, false);
      assert.ok(first.page?.next_cursor);
      invalidateNext = true;
      const second = await fetchEventPage({ limit: 2, cursor: first.page.next_cursor });
      assert.equal(second.page, null, '游标失效不给页——已显示数据只能由调用方自己保留');
      assert.equal(second.stale, true, 'stale 标记驱动「重取首页」');
      assert.equal(second.code, 'CURSOR_STALE');
      invalidateNext = false;
      const fresh = await fetchEventPage({ limit: 2, kinds: ['modified'] });
      assert.equal(fresh.stale, false);
      assert.ok(fresh.page);
      assert.equal(issuedCursor, 'ec-next');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('版本链分页合并：fetchFileHistory 跨页拼接 seq ASC，include 集合仅随首页带回（契约 §1.7）', async () => {
    const revisions = Array.from({ length: 5 }, (_, i) => ({
      revision_id: `rev_f1_v${i + 1}`,
      seq: i + 1,
      prev_revision_id: i === 0 ? null : `rev_f1_v${i}`,
      content_hash: `h${i + 1}`,
      size_bytes: 100 + i,
      observed_at: '2026-11-10T00:00:00.000Z',
      occurred_at: `2026-11-0${i + 1}`,
      occurred_precision: 'day',
      occurred_source: 'document_self',
      snapshot_available: i !== 1,
    }));
    let pageCalls = 0;
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/files/file_f1/revisions',
        handler: (_req, res, url) => {
          pageCalls += 1;
          assert.equal(url.searchParams.get('order'), 'seq_asc');
          assert.equal(
            url.searchParams.get('include'),
            pageCalls === 1 ? 'events,statements,edges,aliases' : null,
            `第 ${pageCalls} 页的 include 参数`
          );
          const cursor = url.searchParams.get('cursor');
          const offset = cursor ? Number(cursor.replace('rc-', '')) : 0;
          const items = revisions.slice(offset, offset + 2);
          const hasMore = offset + items.length < revisions.length;
          json(res, 200, {
            ok: true,
            index_generation: 12,
            file: {
              file_id: 'file_f1',
              current_path: 'docs/plan.md',
              title: '计划',
              format: 'md',
              role: '方案',
              status: 'active',
              first_observed_at: '2026-11-01T00:00:00.000Z',
              last_observed_at: '2026-11-10T00:00:00.000Z',
              last_revision_id: 'rev_f1_v5',
            },
            revisions: items,
            next_cursor: hasMore ? `rc-${offset + items.length}` : null,
            has_more: hasMore,
            total: revisions.length,
            ...(cursor ? {} : {
              events: [
                {
                  seq: 9,
                  event_id: 'evt_mod_v5',
                  kind: 'modified',
                  revision_id: 'rev_f1_v5',
                  occurred_at: '2026-11-05',
                  occurred_precision: 'day',
                  occurred_source: 'document_self',
                  observed_at: '2026-11-10T00:00:00.000Z',
                  headline: '计划更新',
                  detail: '',
                  payload: { changed_sections: ['第二章'] },
                },
              ],
              statements: [{ statement_id: 'st_1', revision_id: 'rev_f1_v5', code: 'Q03', question: '?', status: '已确认', line_start: 1, line_end: 2, decision_id: 'dec_1' }],
              edges: [],
              aliases: ['docs/old-plan.md', 'docs/plan.md'],
            }),
          });
        },
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const history = await fetchFileHistory('file_f1');
      assert.ok(history, '版本链读取成功');
      assert.equal(pageCalls, 3, '5 条 × 每页 2 → 3 页');
      assert.deepEqual(history.revisions.map((r) => r.seq), [1, 2, 3, 4, 5], '跨页拼接保持 seq ASC');
      assert.equal(history.events.length, 1, '事件集合只在首页取一次');
      assert.equal(history.statements.length, 1);
      assert.deepEqual(history.aliases, ['docs/old-plan.md', 'docs/plan.md']);
      assert.equal(history.file.last_revision_id, 'rev_f1_v5');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('版本链单页直读：fetchFileRevisionsPage 透传游标与 NOT_FOUND 错误包络', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/files/file_x/revisions',
        handler: (_req, res, url) => {
          if (url.searchParams.get('cursor') === 'rc-bad') {
            json(res, 409, { ok: false, code: 'CURSOR_STALE', error: '游标失效' });
            return;
          }
          json(res, 200, {
            ok: true,
            index_generation: 12,
            file: {
              file_id: 'file_x',
              current_path: 'docs/x.md',
              title: 'X',
              format: 'md',
              role: '说明',
              status: 'active',
              first_observed_at: '2026-11-01T00:00:00.000Z',
              last_observed_at: '2026-11-10T00:00:00.000Z',
              last_revision_id: null,
            },
            revisions: [],
            next_cursor: null,
            has_more: false,
            total: 0,
          });
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/files/file_404/revisions',
        handler: (_req, res) => json(res, 404, { ok: false, code: 'NOT_FOUND', error: '文件不存在' }),
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const okPage = await fetchFileRevisionsPage('file_x', { order: 'seq_asc', cursor: 'rc-bad' });
      assert.equal(okPage.ok, false);
      assert.equal(okPage.code, 'CURSOR_STALE', '单页游标失效按包络如实返回');

      const missing = await fetchFileRevisionsPage('file_404');
      assert.equal(missing.ok, false);
      assert.equal(missing.code, 'NOT_FOUND');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('阅读器链路走 /revisions 分页（fetchFileHistory → revisionsFromHistory），include 仅首页发送', async () => {
    const requestedUrls: string[] = [];
    const revisions = [1, 2].map((seq) => ({
      revision_id: `rev_svg_r${seq}`,
      seq,
      prev_revision_id: seq === 1 ? null : 'rev_svg_r1',
      content_hash: seq === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
      size_bytes: seq === 1 ? 386 : 512,
      observed_at: seq === 1 ? '2026-11-10T09:00:00.000Z' : '2026-11-13T12:00:00.000Z',
      occurred_at: seq === 1 ? '2026-10-01' : null,
      occurred_precision: seq === 1 ? 'day' : 'second',
      occurred_source: seq === 1 ? 'document_self' : null,
      snapshot_available: seq === 1,
    }));
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/files/file_svg/revisions',
        handler: (_req, res, url) => {
          requestedUrls.push(`${url.pathname}${url.search}`);
          const cursor = url.searchParams.get('cursor');
          json(res, 200, {
            ok: true,
            index_generation: 4,
            file: {
              file_id: 'file_svg',
              current_path: 'assets/diagram.svg',
              title: '示意图',
              format: 'svg',
              role: '方案',
              status: 'active',
              first_observed_at: '2026-11-10T09:00:00.000Z',
              last_observed_at: '2026-11-13T12:00:00.000Z',
              last_revision_id: 'rev_svg_r2',
            },
            revisions,
            next_cursor: cursor ? null : 'rc-svg-p2',
            has_more: !cursor,
            total: 2,
            ...(cursor
              ? {}
              : {
                  events: [
                    {
                      seq: 7,
                      event_id: 'evt_mod_r2',
                      kind: 'modified',
                      revision_id: 'rev_svg_r2',
                      occurred_at: null,
                      occurred_precision: 'second',
                      occurred_source: null,
                      observed_at: '2026-11-13T12:00:00.000Z',
                      headline: '示意图更新',
                      detail: '',
                      payload: { changed_sections: ['图例'] },
                    },
                  ],
                  statements: [],
                  edges: [],
                }),
          });
        },
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const history = await fetchFileHistory('file_svg');
      assert.ok(history, '版本链读取成功');
      assert.match(requestedUrls[0], /include=events/, '首页携带 include');
      assert.equal(requestedUrls[1]?.includes('include'), false, '续页不再发送 include');

      const fileRows = revisionsFromHistory('file_svg', history.revisions, history.events);
      assert.equal(fileRows[1].versionNumber, 2, 'versionNumber = seq');
      assert.equal(
        fileRows[1].snapshotAvailable,
        false,
        '快照标记如实映射（rev2 快照已淘汰）'
      );
      assert.equal(
        fileRows[1].summaryNote.includes('vundefined'),
        false,
        '摘要不出现 vundefined 假数据'
      );
      assert.equal(fileRows[0].source_time, '2026-10-01', '文档自述日期直传（日历「最近 7 天」依赖）');
      assert.equal(fileRows[0].isBaselineProtected, true, 'seq 1 为基线保护版');
      assert.deepEqual(
        fileRows[1].changedSectionsFromPrev,
        ['图例'],
        'changedSectionsFromPrev 来自 modified 事件 payload'
      );
      assert.equal(fileRows[0].svgSource, undefined, '不再依赖服务端 SVG 内联（正文按 §1.8 单独取）');
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
  });

  test('按需正文：md 文本返回、快照淘汰返回 SNAPSHOT_UNAVAILABLE（契约 §1.8 v1 改名）', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/revisions/rev_md/content',
        handler: (_req, res) => json(res, 200, { ok: true, format: 'md', revision_id: 'rev_md', text: '# 正文' }),
      },
      {
        match: (url) => url.pathname === '/api/v1/revisions/rev_evicted/content',
        handler: (_req, res) =>
          json(res, 410, { ok: false, code: 'SNAPSHOT_UNAVAILABLE', error: '快照已过保留期', index_generation: 12 }),
      },
    ]);
    try {
      setApiBaseUrl(stub.base);
      const md = await fetchRevisionContent('rev_md');
      assert.equal(md.ok, true);
      assert.equal(md.text, '# 正文');
      assert.equal(md.format, 'md');

      const evicted = await fetchRevisionContent('rev_evicted');
      assert.equal(evicted.ok, false);
      assert.equal(evicted.code, 'SNAPSHOT_UNAVAILABLE', 'v1 错误码改名（旧 REVISION_UNAVAILABLE 不再下发）');

      assert.equal(revisionRawUrl('rev_md'), `${stub.base}/api/v1/revisions/rev_md/content?raw=1`);

      const batch = await fetchRevisionContentsBatch(['rev_md', 'rev_evicted']);
      assert.deepEqual(batch.contents, { rev_md: '# 正文' });
      assert.ok(batch.failed['rev_evicted']);
    } finally {
      await stub.close();
      setApiBaseUrl('');
    }
    assert.equal(revisionRawUrl('rev_md'), '/api/v1/revisions/rev_md/content?raw=1');
  });

  test('wire → 视图模型：fileSummaryToFileRecord 以 first_source_time 供日历文档日期', () => {
    const record = fileSummaryToFileRecord(summaryOf(1));
    assert.equal(record.file_id, 'file_001');
    assert.equal(record.relative_path, 'docs/a001.md');
    assert.equal(record.folder, 'docs');
    assert.equal(record.current_revision_id, 'rev_001_v1');
    assert.equal(record.revisions.length, 1);
    assert.equal(record.revisions[0].revision_id, 'rev_001_v1');
    assert.equal(record.revisions[0].source_time, '2026-11-05', 'first_source_time = 最早版本发生时间');
    assert.equal(record.revisions[0].snapshotAvailable, true);
    assert.equal(record.pdfStatus, undefined, '非 PDF 不带 pdfStatus');
  });

  test('wire → 视图模型：revisionsFromHistory 版本号=seq、source_time=occurred_at、changedSections 来自事件 payload', () => {
    const revisions = [
      {
        revision_id: 'rev_v1',
        seq: 1,
        prev_revision_id: null,
        content_hash: 'h1',
        size_bytes: 10,
        observed_at: '2026-11-01T00:00:00.000Z',
        occurred_at: '2026-11-01',
        occurred_precision: 'day',
        occurred_source: 'document_self',
        snapshot_available: true,
      },
      {
        revision_id: 'rev_v2',
        seq: 2,
        prev_revision_id: 'rev_v1',
        content_hash: 'h2',
        size_bytes: 20,
        observed_at: '2026-11-02T00:00:00.000Z',
        occurred_at: '2026-11-02',
        occurred_precision: 'day',
        occurred_source: 'document_self',
        snapshot_available: false,
      },
    ];
    const events = [
      {
        seq: 2,
        event_id: 'evt_2',
        kind: 'modified',
        revision_id: 'rev_v2',
        occurred_at: '2026-11-02',
        occurred_precision: 'day',
        occurred_source: 'document_self',
        observed_at: '2026-11-02T00:00:00.000Z',
        headline: '更新',
        detail: '',
        payload: { changed_sections: ['结论'] },
      },
    ];
    const camel = revisionsFromHistory('file_1', revisions, events);
    assert.equal(camel.length, 2);
    assert.equal(camel[0].versionNumber, 1, 'versionNumber = per-file seq');
    assert.equal(camel[0].file_id, 'file_1');
    assert.equal(camel[1].source_time, '2026-11-02', 'source_time = occurred_at（文档记载），严禁 observed_at');
    assert.equal(camel[1].snapshotAvailable, false);
    assert.deepEqual(camel[1].changedSectionsFromPrev, ['结论'], '变更章节来自 modified 事件 payload');
    assert.equal(camel[0].changedSectionsFromPrev, undefined);
    assert.ok(camel[1].summaryNote.includes('快照已过保留期'));
  });

  test('SVG 文本层提取与 folderOfRelativePath 镜像 server/project.ts 口径', () => {
    const svg = '<svg><text x="1" y="2">需求 Q03</text><g><text>方案&amp;交付</text></g></svg>';
    assert.deepEqual(extractSvgTextNodes(svg), ['需求 Q03', '方案&交付']);
    assert.deepEqual(extractSvgTextNodes('<svg><rect/></svg>'), []);
    assert.equal(folderOfRelativePath('docs/plan/a.md'), 'docs/plan');
    assert.equal(folderOfRelativePath('a.md'), '.', '根目录文件归 "."（旧投影口径）');
    assert.equal(folderOfRelativePath('docs\\win\\b.md'), 'docs/win', '反斜杠路径归一');
  });
});
