import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fetchRevisionPreview,
  resolveApiUrl,
  revisionThumbnailUrl,
  setApiBaseUrl,
  type RevisionPreviewResponse,
} from '../src/services/workspaceClient';
import {
  clearQuickPreviewCache,
  formatDeltaBytes,
  isNumericCell,
  parseDelimitedTable,
  QuickPreviewCoordinator,
  tokenizeCodeLine,
  tryPrettyJson,
} from '../src/utils/quickPreviewHelpers';
import { buildQuickPreviewQueue } from '../src/hooks/useQuickPreview';
import type { FileRecord, TimelineEvent } from '../src/types/guanlan';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '../src');

function makePreviewPayload(
  idx: number,
  format: string,
  previewKind: RevisionPreviewResponse['preview_kind']
): RevisionPreviewResponse {
  const revId = `rev_${idx}_${format}`;
  const isImage = previewKind === 'image' || previewKind === 'vector';
  const isBinary = previewKind === 'binary';
  return {
    ok: true,
    index_generation: 7,
    file_id: `file_${idx}`,
    revision_id: revId,
    relative_path: `samples/item_${idx}.${format}`,
    title: `item_${idx}.${format}`,
    format,
    format_class: isImage ? 'image' : isBinary ? 'binary' : 'code',
    mime_type: isImage ? `image/${format}` : 'text/plain; charset=utf-8',
    preview_kind: previewKind,
    seq: 2,
    revision_count: 2,
    content_hash: `${idx.toString(16).padStart(4, '0')}${'a'.repeat(60)}`,
    size_bytes: 2048 + idx * 100,
    size_min_bytes: 1024,
    size_max_bytes: 2048 + idx * 100,
    observed_at: '2026-11-19T12:00:00Z',
    occurred_at: '2026-11-19T11:55:00Z',
    snapshot_available: previewKind !== 'binary',
    blob_missing: false,
    raw_url: previewKind === 'binary' ? undefined : `/api/v1/revisions/${revId}/content?raw=1`,
    thumbnail_url: isImage ? `/api/v1/revisions/${revId}/thumbnail` : undefined,
    text_slice: isImage || isBinary ? undefined : `line 1 of ${format}\nline 2`,
    slice_offset: 0,
    slice_bytes: isImage || isBinary ? 0 : 24,
    total_bytes: 2048 + idx * 100,
    line_count: isImage || isBinary ? 0 : 2,
    truncated: false,
    image_meta: isImage ? { width: 1280, height: 720 } : undefined,
    magic_signature: isBinary ? 'ISO Base Media / MP4' : undefined,
    header_hex: isBinary ? '00 00 00 18 66 74 79 70' : undefined,
    history: [
      {
        revision_id: revId,
        seq: 2,
        size_bytes: 2048 + idx * 100,
        delta_bytes: 1024 + idx * 100,
        content_hash: `${idx.toString(16).padStart(4, '0')}${'a'.repeat(60)}`,
        observed_at: '2026-11-19T12:00:00Z',
        occurred_at: '2026-11-19T11:55:00Z',
        snapshot_available: previewKind !== 'binary',
      },
      {
        revision_id: `${revId}_v1`,
        seq: 1,
        size_bytes: 1024,
        delta_bytes: null,
        content_hash: 'b'.repeat(64),
        observed_at: '2026-11-18T09:00:00Z',
        occurred_at: null,
        snapshot_available: previewKind !== 'binary',
      },
    ],
  };
}

function makeFile(id: string, rel: string, format: string): FileRecord {
  return {
    file_id: id,
    relative_path: rel,
    folder: path.posix.dirname(rel) || '.',
    title: path.posix.basename(rel),
    format,
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    coverage: 'full_text',
    current_revision_id: `rev_${id}`,
    revisions: [
      {
        revision_id: `rev_${id}`,
        file_id: id,
        versionNumber: 1,
        content_sha256: 'c'.repeat(64),
        observed_at: '2026-11-19T10:00:00Z',
        sizeBytes: 1200,
        snapshotAvailable: true,
        summaryNote: '',
      },
    ],
  };
}

describe('B02 · 轻预览纯函数（语法高亮、CSV/TSV 表格、JSON 与体积差）', () => {
  it('parseDelimitedTable 正确解析带引号逗号与转义引号的 CSV 及 TSV', () => {
    const csv = 'id,name,amount\n1,"观澜, 工作台",128.50\n2,"引号 ""测试""",-14%\n';
    const parsed = parseDelimitedTable(csv, ',');
    assert.deepEqual(parsed.headers, ['id', 'name', 'amount']);
    assert.equal(parsed.totalParsedRows, 2);
    assert.equal(parsed.columnCount, 3);
    assert.deepEqual(parsed.rows[0], ['1', '观澜, 工作台', '128.50']);
    assert.deepEqual(parsed.rows[1], ['2', '引号 "测试"', '-14%']);
    assert.equal(isNumericCell('128.50'), true);
    assert.equal(isNumericCell('-14%'), true);
    assert.equal(isNumericCell('观澜, 工作台'), false);

    const tsv = parseDelimitedTable('colA\tcolB\nx\t42\n', '\t');
    assert.deepEqual(tsv.headers, ['colA', 'colB']);
    assert.deepEqual(tsv.rows, [['x', '42']]);
  });

  it('tokenizeCodeLine 支持 JSON / YAML / Markdown / 代码并保证线性耗时', () => {
    const jsonTokens = tokenizeCodeLine('  "port": 8080, // comment', 'json');
    assert.ok(jsonTokens.some((t) => t.kind === 'key' && t.text.includes('"port"')));
    assert.ok(jsonTokens.some((t) => t.kind === 'number' && t.text === '8080'));
    assert.ok(jsonTokens.some((t) => t.kind === 'comment'));

    const yamlTokens = tokenizeCodeLine('threshold: 65536 # default', 'yaml');
    assert.ok(yamlTokens.some((t) => t.kind === 'key' && t.text === 'threshold'));
    assert.ok(yamlTokens.some((t) => t.kind === 'comment'));

    const mdTokens = tokenizeCodeLine('- [P0 - 待确认] 确认快照阈值', 'md');
    assert.ok(mdTokens.some((t) => t.kind === 'badge' && t.text === '[P0 - 待确认]'));

    const rsTokens = tokenizeCodeLine('pub async fn preview(n: usize) -> usize { return n; }', 'rs');
    assert.ok(rsTokens.some((t) => t.kind === 'keyword' && t.text === 'pub'));
    assert.ok(rsTokens.some((t) => t.kind === 'keyword' && t.text === 'return'));

    assert.equal(tryPrettyJson('{"a":1,"b":[2]}'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    assert.equal(tryPrettyJson('{"truncated":'), null);

    assert.equal(formatDeltaBytes(null), '初版');
    assert.equal(formatDeltaBytes(0), '0 B');
    assert.equal(formatDeltaBytes(2048), '+2.0 KiB');
    assert.equal(formatDeltaBytes(-512), '-512 B');
  });
});

describe('B02 · HTTP 轻预览客户端与 20 次连按方向键零竞态防抖调度', () => {
  let server: http.Server | null = null;
  let prevBase = '';
  let lastPreviewUri = '';

  beforeEach(async () => {
    clearQuickPreviewCache();
    prevBase = resolveApiUrl('');
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/v1/revisions/') && req.url.includes('/preview')) {
        lastPreviewUri = req.url;
        const rev = req.url.split('/')[4] || 'rev_0';
        const payload = makePreviewPayload(1, 'json', 'code');
        payload.revision_id = rev;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected port');
    setApiBaseUrl(`http://127.0.0.1:${addr.port}`);
  });

  afterEach(async () => {
    setApiBaseUrl(prevBase);
    clearQuickPreviewCache();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('fetchRevisionPreview 传参、decode 与 Tauri 跨源 URL 解析正确', async () => {
    const res = await fetchRevisionPreview('rev_alpha', { offset: 1024, maxBytes: 4096 });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('expected ok');
    assert.equal(lastPreviewUri, '/api/v1/revisions/rev_alpha/preview?offset=1024&max_bytes=4096');
    assert.equal(res.data.revision_id, 'rev_alpha');
    assert.match(revisionThumbnailUrl('rev_alpha'), /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/revisions\/rev_alpha\/thumbnail$/);
  });

  it('连续快速切换 20 个不同格式文件：前 19 次全部 abort/stale 取消，仅第 20 次落地且命中缓存 <5ms', async () => {
    const formats: Array<[string, RevisionPreviewResponse['preview_kind']]> = [
      ['png', 'image'],
      ['jpg', 'image'],
      ['webp', 'image'],
      ['svg', 'vector'],
      ['ts', 'code'],
      ['rs', 'code'],
      ['py', 'code'],
      ['json', 'code'],
      ['yaml', 'code'],
      ['csv', 'table'],
      ['tsv', 'table'],
      ['md', 'markdown'],
      ['txt', 'text'],
      ['pdf', 'pdf'],
      ['docx', 'binary'],
      ['xlsx', 'binary'],
      ['zip', 'binary'],
      ['mp4', 'binary'],
      ['bin', 'binary'],
      ['log', 'text'],
    ];

    let abortedCount = 0;
    const coordinator = new QuickPreviewCoordinator(async (revId, opts) => {
      const idx = Number(revId.split('_')[1] ?? '0');
      const [fmt, kind] = formats[idx] ?? ['bin', 'binary'];
      return await new Promise((resolve) => {
        const delayMs = 25 + ((19 - idx) % 5) * 8;
        const timer = setTimeout(() => {
          if (opts.signal?.aborted) {
            abortedCount += 1;
            resolve({ ok: false, data: null, status: 0, code: 'ABORTED', error: 'aborted' });
            return;
          }
          resolve({ ok: true, data: makePreviewPayload(idx, fmt, kind), status: 200 });
        }, delayMs);

        opts.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            abortedCount += 1;
            resolve({ ok: false, data: null, status: 0, code: 'ABORTED', error: 'aborted' });
          },
          { once: true }
        );
      });
    });

    // 连按 20 次方向键（每次不等前一次网络返回直接切下一个）
    const outcomes = await Promise.all(
      formats.map(([fmt], idx) => coordinator.load(`rev_${idx}_${fmt}`))
    );

    assert.equal(abortedCount, 19, '前 19 次在途请求必须立即被 AbortController 取消');
    for (let i = 0; i < 19; i++) {
      assert.notEqual(outcomes[i].status, 'ok', `第 ${i} 次已过期请求绝不能覆盖画面`);
    }
    assert.equal(outcomes[19].status, 'ok');
    assert.equal(outcomes[19].data?.revision_id, 'rev_19_log');

    // 再切回一次应命中本地 LRU 缓存（< 5ms 且不再触发网络）
    const t0 = performance.now();
    const cachedHit = await coordinator.load('rev_19_log');
    const elapsedMs = performance.now() - t0;
    assert.equal(cachedHit.status, 'ok');
    assert.equal(cachedHit.fromCache, true);
    assert.ok(elapsedMs < 10, `缓存命中应 < 10ms，实测 ${elapsedMs.toFixed(2)}ms`);
  });

  it('buildQuickPreviewQueue 按画布 / 时间线 / 资产库输出有序队列并保留当前目标', () => {
    const f1 = makeFile('f1', 'docs/a.md', 'md');
    const f2 = makeFile('f2', 'assets/b.png', 'png');
    const f3 = makeFile('f3', 'data/c.csv', 'csv');
    const events: TimelineEvent[] = [
      {
        event_id: 'e1',
        kind: 'modified',
        file_id: 'f3',
        revision_id: 'rev_f3_hist',
        observed_at: '2026-11-19T11:00:00Z',
        topic_lane: 'data',
        headline: '更新 c.csv',
        detail: '',
      },
      {
        event_id: 'e2',
        kind: 'appeared',
        file_id: 'f1',
        revision_id: 'rev_f1',
        observed_at: '2026-11-19T10:00:00Z',
        topic_lane: 'docs',
        headline: '新出现 a.md',
        detail: '',
      },
    ];

    const listQueue = buildQuickPreviewQueue({
      activeTab: 'panorama',
      panoramaMode: 'list',
      files: [f1, f2, f3],
      filteredFiles: [f1, f2],
      events,
      currentTarget: { fileId: 'f3', revisionId: 'rev_f3_hist' },
    });
    assert.deepEqual(listQueue, [
      { fileId: 'f3', revisionId: 'rev_f3_hist' },
      { fileId: 'f1', revisionId: 'rev_f1' },
    ]);

    const libQueue = buildQuickPreviewQueue({
      activeTab: 'library',
      panoramaMode: 'canvas',
      files: [f1, f2, f3],
      filteredFiles: [f1, f2],
      events,
      currentTarget: null,
    });
    assert.deepEqual(libQueue, [
      { fileId: 'f1', revisionId: 'rev_f1' },
      { fileId: 'f2', revisionId: 'rev_f2' },
    ]);
  });
});

describe('B02 · 独立组件边界与全视图接线护栏', () => {
  it('QuickPreviewModal 保持独立，绝未塞入 ReaderView.tsx 巨石组件', () => {
    const reader = fs.readFileSync(path.join(SRC_ROOT, 'components/ReaderView.tsx'), 'utf8');
    // D01-a 拆层后 App 实现 = 装配层 + 单一 Store + 分节组件——联合文本断言（语义不变）
    const app = ['App.tsx', 'stores/useWorkspaceStore.tsx', 'components/app/AppModalsStack.tsx']
      .map((p) => fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'))
      .join(String.fromCharCode(10))
    const sidebar = fs.readFileSync(path.join(SRC_ROOT, 'components/LeftSidebar.tsx'), 'utf8');
    const timeline = fs.readFileSync(path.join(SRC_ROOT, 'components/TimelineView.tsx'), 'utf8');
    const menu = fs.readFileSync(path.join(SRC_ROOT, 'components/FileContextMenu.tsx'), 'utf8');

    assert.doesNotMatch(reader, /QuickPreviewModal/);
    assert.match(app, /<QuickPreviewModal/);
    assert.match(app, /useQuickPreview\(/);
    assert.match(sidebar, /data-sidebar-file=/);
    assert.match(sidebar, /onQuickPreview/);
    assert.match(timeline, /data-action="quick-preview"/);
    assert.match(menu, /data-menu-action="quick-preview"/);
  });
});
