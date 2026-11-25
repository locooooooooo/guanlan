/**
 * 阅读器锚点批注纯函数层单测（src/utils/readerAnnotations.ts）。
 * 锁定契约：本地证据表按版本哈希绑定 / 有界上限丢最旧如实计数 / 框选区域归一
 * 与退化拒绝 / 决定块插入逐字节不动既有行 / 插入点推算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotationVersionKey,
  annotationsOfVersion,
  ANNOTATIONS_PER_VERSION_CAP,
  buildAnnotationDecisionTitle,
  buildDecisionBlockInsertion,
  emptyAnnotationStore,
  formatAnnotationLocatorLabel,
  insertionLineAfterBlock,
  markAnnotationConverted,
  nextAnnotationId,
  normalizeAnnotationNote,
  normalizeSvgRegion,
  parseAnnotationStore,
  removeAnnotation,
  svgCanvasUnitsOf,
  svgRegionStyle,
  upsertAnnotation,
  type ReaderAnnotation,
} from './readerAnnotations';

function mdAnn(id: string, startLine = 10): ReaderAnnotation {
  return {
    id,
    note: `批注 ${id}`,
    created_at: '2026-11-21T00:00:00.000Z',
    converted: false,
    locator: { kind: 'md', startLine, excerpt: '段落摘录' },
  };
}

test('版本哈希绑定：同文件不同 sha 互不可见', () => {
  let store = emptyAnnotationStore();
  store = upsertAnnotation(store, 'f1', 'sha-a', mdAnn('a1')).store;
  store = upsertAnnotation(store, 'f1', 'sha-b', mdAnn('b1')).store;
  assert.equal(annotationsOfVersion(store, 'f1', 'sha-a').length, 1);
  assert.equal(annotationsOfVersion(store, 'f1', 'sha-b').length, 1);
  assert.equal(annotationsOfVersion(store, 'f1', 'sha-a')[0].id, 'a1');
  // 空哈希（摘要占位行）永不挂批注
  assert.equal(annotationsOfVersion(store, 'f1', '').length, 0);
  assert.equal(annotationVersionKey('f1', 'sha-a'), 'f1::sha-a');
});

test('有界上限：超出丢最旧且如实计数，未超不丢', () => {
  let store = emptyAnnotationStore();
  for (let i = 0; i < ANNOTATIONS_PER_VERSION_CAP; i++) {
    const res = upsertAnnotation(store, 'f1', 'sha', mdAnn(`n${i}`));
    store = res.store;
    assert.equal(res.dropped, 0);
  }
  const overflow = upsertAnnotation(store, 'f1', 'sha', mdAnn('new'));
  assert.equal(overflow.dropped, 1);
  const list = annotationsOfVersion(overflow.store, 'f1', 'sha');
  assert.equal(list.length, ANNOTATIONS_PER_VERSION_CAP);
  assert.equal(list[0].id, 'n1'); // 最旧被淘汰
  assert.equal(list[list.length - 1].id, 'new');
});

test('损坏存储：非法条目剔除、非对象/数组输入重建空表', () => {
  assert.deepEqual(parseAnnotationStore(null), {});
  assert.deepEqual(parseAnnotationStore('x'), {});
  assert.deepEqual(parseAnnotationStore({ f1: 'not-array' }), {});
  const parsed = parseAnnotationStore({
    'f1::sha': [
      mdAnn('ok1'),
      { id: '', note: '缺 id' },
      null,
      { id: 'bad-loc', note: 'n', created_at: 't', converted: false, locator: { kind: 'pdf' } },
    ],
  });
  assert.equal(parsed['f1::sha'].length, 1);
  assert.equal(parsed['f1::sha'][0].id, 'ok1');
});

test('删除幂等与已转标记', () => {
  let store = upsertAnnotation(emptyAnnotationStore(), 'f1', 'sha', mdAnn('a1')).store;
  assert.equal(removeAnnotation(store, 'f1', 'sha', 'nope'), store); // 幂等原样
  store = removeAnnotation(store, 'f1', 'sha', 'a1');
  assert.equal(annotationsOfVersion(store, 'f1', 'sha').length, 0);
  store = upsertAnnotation(emptyAnnotationStore(), 'f1', 'sha', mdAnn('a1')).store;
  const marked = markAnnotationConverted(store, 'f1', 'sha', 'a1', '决定文本');
  assert.equal(marked['f1::sha'][0].converted, true);
  assert.equal(marked['f1::sha'][0].decision_text, '决定文本');
  assert.equal(markAnnotationConverted(marked, 'f1', 'sha', 'nope', 'x'), marked);
});

test('note 归一：换行折叠/截断；id 同毫秒不撞', () => {
  assert.equal(normalizeAnnotationNote('a\n\nb'), 'a b');
  assert.equal(normalizeAnnotationNote('  x  '), 'x');
  assert.equal(normalizeAnnotationNote('y'.repeat(600)).length, 480);
  const clock = () => 1000;
  assert.notEqual(nextAnnotationId(clock), nextAnnotationId(clock));
});

test('SVG 框选区域：任意方向归一、越界 clamp、退化拒绝', () => {
  assert.deepEqual(normalizeSvgRegion(0.8, 0.9, 0.2, 0.4), { fx: 0.2, fy: 0.4, fw: 0.6, fh: 0.5 });
  assert.deepEqual(normalizeSvgRegion(-1, -1, 2, 0.5), { fx: 0, fy: 0, fw: 1, fh: 0.5 });
  assert.equal(normalizeSvgRegion(0.5, 0.5, 0.5, 0.5), null); // 零面积
  assert.equal(normalizeSvgRegion(0, 0, 0.005, 0.5), null); // 低于阈值误触
  const style = svgRegionStyle({ fx: 0.1, fy: 0.25, fw: 0.3, fh: 0.5 });
  assert.deepEqual(style, { left: '10.000%', top: '25.000%', width: '30.000%', height: '50.000%' });
});

test('svgCanvasUnitsOf：viewBox 优先、width/height 兜底、皆缺诚实 null', () => {
  assert.deepEqual(svgCanvasUnitsOf('<svg viewBox="0 0 200 100"><rect/></svg>'), {
    width: 200,
    height: 100,
  });
  assert.deepEqual(svgCanvasUnitsOf('<svg width="640" height="480"></svg>'), {
    width: 640,
    height: 480,
  });
  assert.equal(svgCanvasUnitsOf('<svg><rect/></svg>'), null);
});

test('决定块插入：既有行逐字节不动、块可被标记正则识别、空 note 锚点标签兜底', () => {
  const md = ['# 标题', '第一段', '第二段', '第三段'].join('\n');
  const ins = buildDecisionBlockInsertion({
    markdownContent: md,
    afterLine: 2,
    note: '这里的口径需要复核',
    locatorLabel: 'L2',
  });
  assert.ok(ins.ok);
  if (!ins.ok) return;
  const before = md.split('\n');
  const after = ins.newContent.split('\n');
  // 既有行逐字节不动（只在插入点后追加 3 行）
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  assert.deepEqual(after.slice(5), before.slice(2));
  assert.equal(ins.insertedLines, 3);
  assert.match(after[2], /^- \[P1 - 待确认\] 这里的口径需要复核$/);
  assert.equal(after[3], '决定：这里的口径需要复核');
  assert.equal(after[4], '来源：观澜本地批注 · L2');
  // 空 note：入口已拦截纯空批注，本层按锚点标签兜底（标题/决定字段一致）
  const fallback = buildDecisionBlockInsertion({
    markdownContent: md,
    afterLine: 2,
    note: '   ',
    locatorLabel: 'L2',
  });
  assert.ok(fallback.ok);
  if (fallback.ok) {
    const lines = fallback.newContent.split('\n');
    assert.equal(lines[2], '- [P1 - 待确认] 批注转决定（L2）');
    assert.equal(lines[3], '决定：批注转决定（L2）');
  }
});

test('决定块插入：文末追加带空行分隔；锚点标签兜底标题', () => {
  const ins = buildDecisionBlockInsertion({
    markdownContent: '只有一行',
    afterLine: 99,
    note: '',
    locatorLabel: '框选区（12%, 34%）',
  });
  assert.ok(ins.ok);
  if (!ins.ok) return;
  assert.equal(
    ins.newContent,
    ['只有一行', '', '- [P1 - 待确认] 批注转决定（框选区（12%, 34%））', '决定：批注转决定（框选区（12%, 34%））', '来源：观澜本地批注 · 框选区（12%, 34%）'].join('\n')
  );
  // 空文档不产前置空行
  const empty = buildDecisionBlockInsertion({
    markdownContent: '',
    afterLine: 0,
    note: 'n1',
    locatorLabel: 'L1',
  });
  assert.ok(empty.ok);
  if (empty.ok) assert.equal(empty.newContent.split('\n')[0], '- [P1 - 待确认] n1');
});

test('插入点推算：下一块前 / 文末兜底', () => {
  assert.equal(insertionLineAfterBlock([{ line: 1 }, { line: 5 }], 2, 20), 4);
  assert.equal(insertionLineAfterBlock([{ line: 1 }, { line: 5 }], 5, 20), 20);
  assert.equal(insertionLineAfterBlock([], 1, 9), 9);
  assert.equal(insertionLineAfterBlock([{ line: 3 }], 1, 9), 2);
});

test('锚点标签与决定标题（空 note 兜底锚点标签）', () => {
  assert.equal(formatAnnotationLocatorLabel({ kind: 'md', startLine: 42, excerpt: '' }), 'L42');
  assert.equal(
    formatAnnotationLocatorLabel({ kind: 'pdf', page: 3, quote: 'q' }),
    '第 3 页'
  );
  assert.match(
    formatAnnotationLocatorLabel({ kind: 'svg', fx: 0.123, fy: 0.456, fw: 0.1, fh: 0.1 }),
    /框选区（12%, 46%）/
  );
  assert.equal(buildAnnotationDecisionTitle('', 'L7'), '批注转决定（L7）');
  assert.equal(buildAnnotationDecisionTitle('  正式口径  ', 'L7'), '正式口径');
});
