import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHighlightSegments,
  buildSnippet,
  localDayOf,
  matchesKeyword,
  parsePaletteQuery,
  resolveRelativeDay,
} from './commandPaletteGrammar';

/** 命令面板查询语法与摘要口径单测。 */

test('parsePaletteQuery：语法 token 拆解与关键词合并', () => {
  const now = new Date('2026-11-20T12:00:00');
  const q = parsePaletteQuery('type:pdf @昨天 in:登录方案 登录网关', now);
  assert.equal(q.keyword, '登录网关');
  assert.equal(q.types.join(','), 'pdf');
  assert.equal(q.initiativeQuery, '登录方案');
  assert.equal(q.dateFrom, '2026-11-19');
  assert.equal(q.dateTo, '2026-11-19');
  assert.equal(q.pendingDecisionOnly, false);

  // 多 type 交集 + 待拍板
  const q2 = parsePaletteQuery('STATUS:待拍板 type:md type:docx 依据', now);
  assert.equal(q2.pendingDecisionOnly, true);
  assert.deepEqual(q2.types, ['md', 'docx']);
  assert.equal(q2.keyword, '依据');

  // 未知 status / @词 诚实回退为关键词
  const q3 = parsePaletteQuery('status:已归档 @下周 方案', now);
  assert.equal(q3.pendingDecisionOnly, false);
  assert.equal(q3.keyword, 'status:已归档 @下周 方案');

  // 空查询
  const q4 = parsePaletteQuery('   ');
  assert.equal(q4.keyword, '');
  assert.equal(q4.types.length, 0);
});

test('resolveRelativeDay：相对词与绝对日期（本地日归属）', () => {
  const now = new Date('2026-11-20T23:30:00');
  assert.equal(resolveRelativeDay('今天', now), '2026-11-20');
  assert.equal(resolveRelativeDay('昨天', now), '2026-11-19');
  assert.equal(resolveRelativeDay('前天', now), '2026-11-18');
  assert.equal(resolveRelativeDay('3天前', now), '2026-11-17');
  assert.equal(resolveRelativeDay('30天之前', now), '2026-10-21');
  assert.equal(resolveRelativeDay('2026-09-01', now), '2026-09-01');
  assert.equal(resolveRelativeDay('上周', now), null);
  assert.equal(resolveRelativeDay('', now), null);
  // 本地日边界：Date 构造按本地时区
  assert.equal(localDayOf(new Date(2026, 10, 20)), '2026-11-20');
});

test('buildSnippet：首个命中词前 16 字起、≤2 行、全量高亮', () => {
  const filler = '后续展开'.repeat(60); // 240 字 filler，保证窗口 200 字上限裁断触发
  const longLine = `这是一段很长的前置铺垫文字用来验证窗口起点，核心结论：登录网关统一由 AC-03 承载，${filler}`;
  const r = buildSnippet(longLine, '登录网关');
  const text = r.segments.map((s) => s.text).join('');
  // 首命中词前 16 字起点
  const hitIdx = longLine.indexOf('登录网关');
  assert.ok(text.includes('登录网关'), '命中词必须可见');
  assert.equal(text.slice(0, 16), longLine.slice(hitIdx - 16, hitIdx), '窗口起点=命中词前 16 字');
  assert.equal(r.clippedHead, true);
  assert.equal(r.clippedTail, true, '窗口 200 字上限裁断长段');
  assert.ok(text.length <= 213, `窗口不超过 200 字（实得 ${text.length}）`);
  // 全量高亮：命中词分段 hit=true 且恰一次出现
  const hits = r.segments.filter((s) => s.hit);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, '登录网关');
  assert.equal(r.lines, 1);
});

test('buildSnippet：两行窗口与行内多次命中全量高亮', () => {
  const text = '首行提到验收标准。\n次行也提验收标准，并且再次出现验收标准字样。\n第三行不该出现在窗口。';
  const r = buildSnippet(text, '验收标准');
  const joined = r.segments.map((s) => s.text).join('');
  assert.equal(r.lines, 2, '窗口恰好 2 行');
  assert.ok(!joined.includes('第三行'), '第 3 行被裁断');
  const hitText = r.segments
    .filter((s) => s.hit)
    .map((s) => s.text)
    .join('|');
  assert.equal(hitText, '验收标准|验收标准|验收标准', '窗口内 3 次出现全部高亮');
  assert.ok(joined.startsWith('首行提到') || joined.startsWith('行提到'), '首命中在第 1 行，窗口回退不超过 16 字');
});

test('buildSnippet：无命中从头截取 + 空查询单段', () => {
  const r = buildSnippet('完全没有命中的普通摘要文本', '不存在词');
  assert.equal(r.clippedHead, false);
  assert.equal(r.segments.filter((s) => s.hit).length, 0);
  const r2 = buildSnippet('一行文本', '');
  assert.deepEqual(r2.segments, [{ text: '一行文本', hit: false }]);
});

test('buildHighlightSegments：多词各自标注 + 大小写无关', () => {
  const segs = buildHighlightSegments('Render pass renders RENDER tree', 'render');
  const hit = segs
    .filter((s) => s.hit)
    .map((s) => s.text)
    .join('|');
  assert.equal(hit, 'Render|render|RENDER');
});

test('matchesKeyword：大小写不敏感子串与空关键词', () => {
  assert.equal(matchesKeyword('docs/登录方案.md', '登录'), true);
  assert.equal(matchesKeyword('docs/Login.md', 'login'), true);
  assert.equal(matchesKeyword('anything', ''), true);
  assert.equal(matchesKeyword('anything', 'missing'), false);
});
