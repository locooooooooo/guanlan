import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearFilePreviewCacheForTest,
  filePreviewCacheStatsForTest,
  getFilePreviewEntry,
  markdownBodyPreview,
  setFilePreviewClockForTest,
} from './filePreviewCache';
import type { FileRecord, Revision } from '../types/guanlan';

function revision(over: Partial<Revision> & Pick<Revision, 'revision_id'>): Revision {
  return {
    file_id: 'f_prev31',
    versionNumber: 1,
    content_sha256: `sha-${over.revision_id}`,
    observed_at: '2026-11-16T10:00:00+08:00',
    sizeBytes: 100,
    snapshotAvailable: true,
    summaryNote: 'v1',
    ...over,
  };
}

function fileOf(format: FileRecord['format'], revisions: Revision[]): FileRecord {
  return {
    file_id: 'f_prev31',
    relative_path: `preview/card.${format}`,
    title: '预览卡',
    format,
    folder: 'preview',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revisions[revisions.length - 1].revision_id,
    revisions,
    coverage: 'full_text',
  };
}

test('SVG 未加载不落缓存：占位版本行先到不产生终态命中，正文补齐后立即派生', () => {
  clearFilePreviewCacheForTest();
  const placeholder = revision({ revision_id: 'rev_svg1', sizeBytes: 0, content_sha256: '' });
  const file = fileOf('svg', [placeholder]);

  const first = getFilePreviewEntry(file);
  assert.equal(first.svgDataUri, undefined);
  assert.equal(filePreviewCacheStatsForTest().entries, 0);

  const loaded: FileRecord = {
    ...file,
    revisions: [revision({ revision_id: 'rev_svg1', svgSource: '<svg><text>封面</text></svg>' })],
  };
  const second = getFilePreviewEntry(loaded);
  assert.equal(second.state, 'ready');
  assert.match(second.svgDataUri ?? '', /^data:image\/svg\+xml/);
  assert.equal(filePreviewCacheStatsForTest().entries, 1);

  const third = getFilePreviewEntry(loaded);
  assert.equal(third.svgDataUri, second.svgDataUri);
  assert.equal(filePreviewCacheStatsForTest().entries, 1);
});

test('MD 同版本正文补齐后 bodyPreview 及时出现；已加载为空为 unavailable 终态', () => {
  clearFilePreviewCacheForTest();
  const placeholder = revision({ revision_id: 'rev_md1', sizeBytes: 0, content_sha256: '' });
  const file = fileOf('md', [placeholder]);
  assert.equal(getFilePreviewEntry(file).bodyPreview, undefined);
  assert.equal(filePreviewCacheStatsForTest().entries, 0);

  const loaded: FileRecord = {
    ...file,
    revisions: [
      revision({ revision_id: 'rev_md1', markdownContent: '# 标题\n第一行。\n第二行。\n第三行。\n第四行。' }),
    ],
  };
  const entry = getFilePreviewEntry(loaded);
  assert.equal(entry.state, 'ready');
  assert.deepEqual(entry.bodyPreview, ['标题', '第一行。', '第二行。']);

  const emptyLoaded: FileRecord = {
    ...file,
    revisions: [revision({ revision_id: 'rev_md_empty', markdownContent: '' })],
    current_revision_id: 'rev_md_empty',
  };
  const emptyEntry = getFilePreviewEntry(emptyLoaded);
  assert.equal(emptyEntry.state, 'unavailable');
  assert.equal(emptyEntry.bodyPreview?.length ?? 0, 0);
  assert.equal(filePreviewCacheStatsForTest().entries, 2);
});

test('PDF 恒可判定：首页抽取文字缺失时给元数据占位词，缓存生效', () => {
  clearFilePreviewCacheForTest();
  const file = fileOf('pdf', [revision({ revision_id: 'rev_pdf1' })]);
  const entry = getFilePreviewEntry(file);
  assert.equal(entry.state, 'ready');
  assert.deepEqual(entry.bodyPreview, ['正文尚未索引 · 仅元数据可检索']);
  assert.equal(filePreviewCacheStatsForTest().entries, 1);
});

test('字节预算：大 dataUri 超预算按 LRU 逐最旧，总量回到预算内', () => {
  clearFilePreviewCacheForTest();
  const bigSource = `<svg>${'<text>字'.repeat(1024 * 1024)}</svg>`;
  for (let i = 0; i < 20; i++) {
    const rid = `rev_big_${i}`;
    const f = fileOf('svg', [revision({ revision_id: rid, svgSource: bigSource })]);
    (f as { file_id: string }).file_id = `f_big_${i}`;
    getFilePreviewEntry(f);
  }
  const stats = filePreviewCacheStatsForTest();
  assert.equal(stats.totalBytes <= 24 * 1024 * 1024, true);
  assert.equal(stats.entries <= 2048, true);
});

test('修订变更即换键：旧键留表由容量/预算逐出，新键现算', () => {
  clearFilePreviewCacheForTest();
  const rev1 = revision({ revision_id: 'rev_a', svgSource: '<svg><text>A</text></svg>' });
  const rev2 = revision({ revision_id: 'rev_b', svgSource: '<svg><text>B</text></svg>' });
  const file = fileOf('svg', [rev1]);
  const first = getFilePreviewEntry(file);
  const bumped: FileRecord = { ...file, revisions: [rev1, rev2], current_revision_id: 'rev_b' };
  const second = getFilePreviewEntry(bumped);
  assert.notEqual(first.svgDataUri, second.svgDataUri);
  assert.match(second.svgDataUri ?? '', /B/);
});

test('markdownBodyPreview 剥离口径回归（迁移自 graphEvents 原实现）', () => {
  assert.deepEqual(
    markdownBodyPreview('# 大标题\n> 引用句\n- 列表项\n1. 有序项\n\n普通段落\n```code```\n第四行预览', 3),
    ['大标题', '引用句', '列表项']
  );
});


test('离屏 30s 回收：超时未消费的条目在下次访问时逐出，正在消费的条目永不回收', () => {
  clearFilePreviewCacheForTest();
  let clock = 1_000_000;
  setFilePreviewClockForTest(() => clock);
  try {
    const mk = (rid: string) => fileOf('pdf', [revision({ revision_id: rid })]);
    getFilePreviewEntry(mk('rev_a'));
    getFilePreviewEntry(mk('rev_b'));
    getFilePreviewEntry(mk('rev_c'));
    assert.equal(filePreviewCacheStatsForTest().entries, 3);

    clock += 29_000;
    const a = getFilePreviewEntry(mk('rev_a'));
    assert.equal(a.state, 'ready');
    assert.equal(filePreviewCacheStatsForTest().entries, 3);

    clock += 31_000;
    getFilePreviewEntry(mk('rev_a'));
    const stats = filePreviewCacheStatsForTest();
    assert.equal(stats.entries, 1, 'b/c 超时被回收，仅 a（刚续期）保留');
    assert.equal(stats.totalBytes <= 24 * 1024 * 1024, true);
  } finally {
    setFilePreviewClockForTest(null);
    clearFilePreviewCacheForTest();
  }
});

test('离屏回收与 LRU 预算并存：回收不复活超预算逐出，消费续期不丢热条目', () => {
  clearFilePreviewCacheForTest();
  let clock = 2_000_000;
  setFilePreviewClockForTest(() => clock);
  try {
    const bigSource = `<svg>${'<text>字'.repeat(64 * 1024)}</svg>`;
    for (let i = 0; i < 12; i++) {
      const f = fileOf('svg', [revision({ revision_id: `rev_h_${i}`, svgSource: bigSource })]);
      (f as { file_id: string }).file_id = `f_h_${i}`;
      getFilePreviewEntry(f);
    }
    const hotStats = filePreviewCacheStatsForTest();
    assert.ok(hotStats.entries >= 2 && hotStats.totalBytes <= 24 * 1024 * 1024, '预算内驻留');

    clock += 31_000;
    const f0 = fileOf('svg', [revision({ revision_id: 'rev_h_0', svgSource: bigSource })]);
    (f0 as { file_id: string }).file_id = 'f_h_0';
    getFilePreviewEntry(f0);
    const swept = filePreviewCacheStatsForTest();
    assert.ok(swept.entries < hotStats.entries, '离屏条目被回收，内存回落');
  } finally {
    setFilePreviewClockForTest(null);
    clearFilePreviewCacheForTest();
  }
});
