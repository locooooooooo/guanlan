/**
 * D03 · 多模态 Diff 纯函数层单测（行 Diff / MD 人类视图 / SVG 图元 / 表格数值 / XLSX）。
 * 口径锁定：预算超限诚实拒绝不伪造；行号/坐标确定；三类变化（增/删/改）语义；
 * XLSX 按名称+row_num+col_idx 对齐；CSV 行签名 LCS 对齐；数值增量 Δ。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMarkdownHumanDiff,
  buildSvgDiff,
  buildTableDiff,
  buildXlsxDiff,
  collapseHunks,
  computeLineDiffRows,
  extractTodoItems,
  parseNumericCell,
  LCS_MAX_CELLS,
  SVG_MAX_SHAPES_PER_SIDE,
  type XlsxDiffResult,
} from './multimodalDiff';

// ---------- ① 行级 Diff ----------

test('行Diff：增删行号确定（unchanged 双行号/added 新行号/removed 旧行号）', () => {
  const result = computeLineDiffRows('a\nb\nc', 'a\nX\nb\nc\nd');
  assert.ok(result.ok);
  assert.equal(result.added, 2); // X 与 d（LCS: a,b,c 全配对）
  assert.equal(result.removed, 0);
  const added = result.rows.filter((r) => r.type === 'added').map((r) => r.text);
  const removed = result.rows.filter((r) => r.type === 'removed').map((r) => r.text);
  assert.deepEqual(added.sort(), ['X', 'd'].sort());
  assert.deepEqual(removed, []);
  const unchanged = result.rows.filter((r) => r.type === 'unchanged');
  assert.ok(unchanged.every((r) => r.oldLine !== undefined && r.newLine !== undefined));
  const addedRows = result.rows.filter((r) => r.type === 'added');
  assert.ok(addedRows.every((r) => r.newLine !== undefined && r.oldLine === undefined));
});

test('行Diff：identical 快捷退出全 unchanged，零增删', () => {
  const result = computeLineDiffRows('同\n文', '同\n文');
  assert.ok(result.ok);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((r) => r.type === 'unchanged' && r.oldLine === r.newLine));
});

test('行Diff：空旧版=全新增（不伪造「无变化」）', () => {
  const result = computeLineDiffRows('', 'x\ny');
  assert.ok(result.ok);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 0);
});

test('行Diff：预算超限诚实拒绝（DIFF_TOO_LARGE，不静默截断）', () => {
  // 构造恰好越过 DP 单元预算的最小规模
  const lines = Math.ceil(Math.sqrt(LCS_MAX_CELLS)) + 1;
  const big = Array.from({ length: lines }, (_, i) => `line-${i}`).join('\n');
  const other = big.replace('line-0', 'LINE-0');
  const result = computeLineDiffRows(big, other);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'DIFF_TOO_LARGE');
    assert.match(result.message, /超出预算/);
  }
});

// ---------- collapseHunks ----------

test('collapseHunks：两处远离变化→两窗口；相近变化→合并；无变化→[]', () => {
  const rows = computeLineDiffRows(
    Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n'),
    Array.from({ length: 40 }, (_, i) => (i === 2 ? `X${i + 1}` : i === 30 ? `Y${i + 1}` : `L${i + 1}`)).join('\n')
  );
  assert.ok(rows.ok);
  const hunks = collapseHunks(rows.rows, 2);
  assert.equal(hunks.length, 2);
  assert.ok(hunks[0].startIndex < hunks[0].endIndex);
  // 相邻变化（隔 1 行）应合并为单窗口
  const close = computeLineDiffRows('a\nb\nc\nd\ne', 'a\nB\nC\nd\ne');
  assert.ok(close.ok);
  assert.equal(collapseHunks(close.rows, 1).length, 1);
  // 完全相同 → 无窗口（诚实空）
  const same = computeLineDiffRows('a\nb', 'a\nb');
  assert.ok(same.ok);
  assert.deepEqual(collapseHunks(same.rows, 2), []);
});

// ---------- ② MD 人类可读 Diff ----------

test('MD：决定变化三类（新增/移除/状态变化带 oldStatus）', () => {
  const oldText = [
    '# 方案',
    '- [P1 - 待确认] 登录态存储选型',
    '- [P2 - 已确认] 埋点方案',
  ].join('\n');
  const newText = [
    '# 方案',
    '- [P1 - 已确认] 登录态存储选型',
    '- [P0 - 待确认] 新增的密钥轮换决定',
  ].join('\n');
  const result = buildMarkdownHumanDiff(oldText, newText);
  const byTitle = new Map(result.decisionChanges.map((change) => [change.title, change]));
  const changed = byTitle.get('登录态存储选型');
  assert.ok(changed);
  assert.equal(changed!.kind, 'changed');
  assert.equal(changed!.oldStatus, '待确认');
  assert.equal(changed!.status, '已确认');
  assert.equal(changed!.priority, 'P1');
  const added = byTitle.get('新增的密钥轮换决定');
  assert.ok(added);
  assert.equal(added!.kind, 'added');
  assert.equal(added!.blocking, true);
  const removed = byTitle.get('埋点方案');
  assert.ok(removed);
  assert.equal(removed!.kind, 'removed');
  assert.equal(removed!.priority, 'P2');
});

test('MD：待办变化（新增待办/移除；两版相同项不误报变化）', () => {
  const oldText = '# 计划\n- [ ] 旧待办\n- [ ] 未变项\n- [x] 已完成项';
  const newText = '# 计划\n- [ ] 未变项\n- [x] 已完成项\n- [ ] 新增待办';
  const todos = extractTodoItems(newText);
  assert.equal(todos.length, 3);
  assert.equal(todos[1].checked, true);
  const result = buildMarkdownHumanDiff(oldText, newText);
  const kinds = result.todoChanges.map((change) => `${change.kind}:${change.text}`);
  assert.ok(kinds.includes('added:新增待办'));
  assert.ok(kinds.includes('removed:旧待办'));
  // 两版勾选态相同的同名待办绝不产生 changed（诚实口径）
  assert.ok(!result.todoChanges.some((change) => change.text === '未变项'));
  assert.ok(!result.todoChanges.some((change) => change.text === '已完成项'));
});

test('MD：勾选翻转（[ ] → [x]）产生 changed 且携带新旧勾选态', () => {
  const result = buildMarkdownHumanDiff('- [ ] 交付物验收', '- [x] 交付物验收');
  assert.equal(result.todoChanges.length, 1);
  assert.equal(result.todoChanges[0].kind, 'changed');
  assert.equal(result.todoChanges[0].oldChecked, false);
  assert.equal(result.todoChanges[0].checked, true);
});

test('MD：标题结构 outline 携带逐章徽标；删除章只在 sections 呈现', () => {
  const oldText = '# 方案\n## 背景\n旧背景\n## 算法\n旧算法\n## 移除章\n内容';
  const newText = '# 方案\n## 背景\n新背景\n## 算法\n新算法\n## 新增章\n内容';
  const result = buildMarkdownHumanDiff(oldText, newText);
  const byTitle = new Map(result.outline.map((row) => [row.title, row]));
  assert.equal(byTitle.get('背景')!.changeKind, 'changed');
  assert.equal(byTitle.get('算法')!.changeKind, 'changed');
  assert.equal(byTitle.get('新增章')!.changeKind, 'added');
  assert.ok(!byTitle.has('移除章')); // 新版结构里没有
  const removedSection = result.sections.find((change) => change.title === '移除章');
  assert.ok(removedSection);
  assert.equal(removedSection!.kind, '删除');
  // 关键增删段非空且窗口落在 rows 界内
  assert.ok(result.keySegments.length > 0);
  assert.ok(result.lineDiff.ok);
  const total = result.lineDiff.ok ? result.lineDiff.rows.length : 0;
  for (const window of result.keySegments) {
    assert.ok(window.startIndex >= 0 && window.endIndex < total);
  }
});

// ---------- ③ SVG 图元 Diff ----------

const SVG_A = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">',
  '<rect id="bg" x="0" y="0" width="400" height="300" fill="#111"/>',
  '<circle cx="100" cy="100" r="40" fill="#4C8DFF"/>',
  '<line x1="10" y1="10" x2="90" y2="90" stroke="#888"/>',
  '<text x="200" y="150" font-size="18">登录方案</text>',
  '<path d="M0 0 L50 50 L100 0" fill="none"/>',
  '</svg>',
].join('\n');

const SVG_B = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">',
  '<rect id="bg" x="0" y="0" width="400" height="310" fill="#111"/>', // 改：height
  '<circle cx="180" cy="100" r="40" fill="#4C8DFF"/>', // 无 id 移位 → 签名异
  '<line x1="10" y1="10" x2="90" y2="90" stroke="#888"/>',
  '<text x="200" y="150" font-size="18">登录方案v2</text>', // 文本改
  '<polygon points="0,0 20,0 10,18"/>', // 新增
  '</svg>',
].join('\n');

test('SVG：id 命中改尺寸→changed 取新版盒；新增/删除按签名 LCS；viewBox 单位解析', () => {
  const result = buildSvgDiff(SVG_A, SVG_B);
  assert.ok(result.ok);
  assert.deepEqual(result.units, { width: 400, height: 300 });
  const byLabelTag = (tag: string) => result.ok ? result.changes.filter((c) => c.tag === tag) : [];
  const rect = byLabelTag('rect');
  assert.equal(rect.length, 1);
  assert.equal(rect[0].kind, 'changed');
  assert.equal(rect[0].id, 'bg');
  assert.deepEqual(rect[0].box, { x: 0, y: 0, width: 400, height: 310 }); // 新版盒
  const circle = byLabelTag('circle');
  assert.equal(circle.length, 1);
  assert.equal(circle[0].kind, 'changed'); // 移位=改
  assert.deepEqual(circle[0].box, { x: 140, y: 60, width: 80, height: 80 });
  const text = byLabelTag('text');
  assert.equal(text.length, 1);
  assert.equal(text[0].kind, 'changed');
  const line = byLabelTag('line');
  assert.equal(line.length, 0); // 未变不产出
  const polygon = byLabelTag('polygon');
  assert.equal(polygon.length, 1);
  assert.equal(polygon[0].kind, 'added');
  const path = byLabelTag('path');
  assert.equal(path.length, 1);
  assert.equal(path[0].kind, 'removed');
  if (result.ok) {
    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.changed, 3);
    assert.equal(result.truncated, false);
  }
});

test('SVG：identical 快捷退出零差异；文本盒 CJK 估宽', () => {
  const same = buildSvgDiff(SVG_A, SVG_A);
  assert.ok(same.ok);
  assert.equal(same.changes.length, 0);
  const withText = buildSvgDiff('<svg viewBox="0 0 100 50"><text x="0" y="10" font-size="10">中文四字</text></svg>', '<svg viewBox="0 0 100 50"><text x="0" y="10" font-size="10">中文四字改</text></svg>');
  assert.ok(withText.ok);
  const textChange = withText.ok ? withText.changes[0] : undefined;
  assert.ok(textChange);
  assert.ok(textChange!.box);
  assert.ok(textChange!.box!.width > 0);
});

test('SVG：图元超上限诚实 truncated（前 1500 个对比）', () => {
  const mk = (tag: string) => [
    '<svg viewBox="0 0 5000 100">',
    ...Array.from({ length: SVG_MAX_SHAPES_PER_SIDE + 30 }, (_, i) =>
      tag === 'rect' ? `<rect x="${i}" y="0" width="3" height="3"/>` : `<circle cx="${i}" cy="1" r="2"/>`
    ),
    '</svg>',
  ].join('\n');
  const result = buildSvgDiff(mk('rect'), mk('circle'));
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
});

test('SVG：无 viewBox 且无尺寸 → units=null（不伪造几何框），清单仍可用', () => {
  const result = buildSvgDiff(
    '<svg><rect id="r" x="1" y="1" width="2" height="2"/></svg>',
    '<svg><rect id="r" x="1" y="1" width="3" height="2"/></svg>'
  );
  assert.ok(result.ok);
  assert.equal(result.units, null);
  assert.equal(result.ok ? result.changed : 0, 1);
  const change = result.ok ? result.changes[0] : undefined;
  assert.ok(change);
  assert.ok(change!.box); // 盒仍按用户单位给出，只是 units 缺失不画叠加
});

// ---------- ④ 表格数值 Diff ----------

test('表格：增/删/改行与数值 Δ；表头变化；identical 零变化', () => {
  const oldCsv = [
    '物料,数量,单价',
    '螺栓,100,0.5',
    '螺母,50,0.3',
    '垫片,10,0.1',
  ].join('\n');
  const newCsv = [
    '物料,数量,单价',
    '螺栓,150,0.5', // 数值改 100→150（Δ+50）
    '螺母,50,0.3',
    '平垫,20,0.2', // 新增行
  ].join('\n');
  const result = buildTableDiff(oldCsv, newCsv, ',');
  assert.ok(result.ok);
  assert.equal(result.headerChanges.length, 0);
  assert.equal(result.addedRows, 1); // 平垫
  assert.equal(result.removedRows, 1); // 垫片
  assert.equal(result.changedRows, 1); // 螺栓（首列同键还原为改行）
  assert.equal(result.numericChanges, 1); // 数量 Δ+50（单价同值不改）
  assert.equal(result.cellChanges, 1);
  const changedRow = result.rows.find((row) => row.kind === 'changed');
  assert.ok(changedRow && changedRow.kind === 'changed');
  const change = changedRow.changes[0];
  assert.equal(change.col, 1);
  assert.equal(change.header, '数量');
  assert.ok(change.numeric);
  assert.equal(change.numeric.delta, 50);
  assert.equal(change.numeric.oldValue, 100);
  const addedRow = result.rows.find((row) => row.kind === 'added');
  assert.ok(addedRow && addedRow.kind === 'added');
  assert.equal(addedRow.rowNum, 4); // 新版第 4 行（表头=1，平垫在第 4 行）
  const removedRow = result.rows.find((row) => row.kind === 'removed');
  assert.ok(removedRow && removedRow.kind === 'removed');
  assert.equal(removedRow.oldRowNum, 4);

  const identical = buildTableDiff(oldCsv, oldCsv, ',');
  assert.ok(identical.ok);
  assert.equal(identical.ok ? identical.changedRows : -1, 0);
  assert.equal(identical.ok ? identical.rows.every((row) => row.kind === 'unchanged') : false, true);
});

test('表格：TSV 分隔符与表头变化；货币/百分号数值可解析', () => {
  const oldTsv = '项目\t金额\t占比\nA\t¥1,200\t35%';
  const newTsv = '项目\t预算\t占比\nA\t¥1,800\t40%';
  const result = buildTableDiff(oldTsv, newTsv, '\t');
  assert.ok(result.ok);
  assert.equal(result.delimiter, '\t');
  assert.equal(result.headerChanges.length, 1);
  assert.equal(result.headerChanges[0].oldValue, '金额');
  assert.equal(result.headerChanges[0].newValue, '预算');
  const changedRow = result.ok ? result.rows.find((row) => row.kind === 'changed') : undefined;
  assert.ok(changedRow && changedRow.kind === 'changed');
  const amount = changedRow.changes.find((change) => change.header === '预算');
  assert.ok(amount);
  assert.ok(amount.numeric);
  assert.equal(amount.numeric.delta, 600);
  const ratio = changedRow.changes.find((change) => change.header === '占比');
  assert.ok(ratio);
  assert.ok(ratio.numeric);
  assert.equal(ratio.numeric.delta, 5);
});

test('parseNumericCell：容忍千分位/货币前缀/百分号；不可解析返回 null', () => {
  assert.equal(parseNumericCell('1,234'), 1234);
  assert.equal(parseNumericCell('¥ 99.5'), 99.5);
  assert.equal(parseNumericCell('35%'), 35);
  assert.equal(parseNumericCell('-12.75'), -12.75);
  assert.equal(parseNumericCell(''), null);
  assert.equal(parseNumericCell('N/A'), null);
  assert.equal(parseNumericCell('abc123'), null);
});

test('表格：行数超上限诚实 rowCapped（不冒充全量对比）', () => {
  const rows = (n: number, mark = '') =>
    ['编号,值', ...Array.from({ length: n }, (_, i) => `${i},${mark}${i}`)].join('\n');
  const result = buildTableDiff(rows(1200), rows(1200, 'x'), ',');
  assert.ok(result.ok);
  assert.equal(result.rowCapped, true);
  assert.equal(result.rowCap, 1000);
});

// ---------- ⑤ XLSX Diff ----------

function sheetOf(
  name: string,
  rows: Array<{ row_num: number; cells: Array<{ ref_id: string; col_idx: number; value: string; is_numeric: boolean }> }> = [],
  headers: string[] = ['名称', '数值']
) {
  return {
    name,
    index: 0,
    headers,
    row_count: rows.length,
    col_count: headers.length,
    numeric_summaries: [],
    rows: rows.map((row) => ({ row_num: row.row_num, cells: row.cells })),
    truncated: false,
  };
}

test('XLSX：同名工作表逐格对比（row_num/col_idx 对齐、数值 Δ）；新增/删除工作表名单', () => {
  const oldXlsx = {
    sheets: [
      sheetOf('报价', [
        { row_num: 2, cells: [{ ref_id: 'A2', col_idx: 0, value: '螺栓', is_numeric: false }] },
        { row_num: 3, cells: [{ ref_id: 'A3', col_idx: 0, value: '螺母', is_numeric: false }, { ref_id: 'B3', col_idx: 1, value: '50', is_numeric: true }] },
      ]),
      sheetOf('历史'),
    ],
    total_sheets: 2,
    truncated: false,
  };
  const newXlsx = {
    sheets: [
      sheetOf('报价', [
        { row_num: 2, cells: [{ ref_id: 'A2', col_idx: 0, value: '螺栓', is_numeric: false }] }, // 未变
        { row_num: 3, cells: [{ ref_id: 'A3', col_idx: 0, value: '螺母', is_numeric: false }, { ref_id: 'B3', col_idx: 1, value: '75', is_numeric: true }] }, // B3 改
        { row_num: 4, cells: [{ ref_id: 'A4', col_idx: 0, value: '平垫', is_numeric: false }, { ref_id: 'B4', col_idx: 1, value: '20', is_numeric: true }] }, // 新增行
      ]),
      sheetOf('新增表'),
    ],
    total_sheets: 2,
    truncated: false,
  };
  const result = buildXlsxDiff(oldXlsx, newXlsx);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.addedSheets, ['新增表']);
  assert.deepEqual(result.removedSheets, ['历史']);
  assert.equal(result.sheets.length, 1);
  const sheet = result.sheets[0];
  assert.equal(sheet.sheetName, '报价');
  assert.equal(sheet.table.changedRows, 1);
  assert.equal(sheet.table.addedRows, 1);
  assert.equal(sheet.table.numericChanges, 1);
  const changedRow = sheet.table.rows.find((row) => row.kind === 'changed');
  assert.ok(changedRow && changedRow.kind === 'changed');
  assert.equal(changedRow.rowNum, 3);
  const change = changedRow.changes[0];
  assert.equal(change.col, 1);
  assert.ok(change.numeric);
  assert.equal(change.numeric.delta, 25);
});

test('XLSX：任一侧结构化数据缺失诚实拒绝（OFFICE_UNAVAILABLE，不以当前文件冒充旧版）', () => {
  const onlyNew = {
    sheets: [sheetOf('报价', [{ row_num: 2, cells: [{ ref_id: 'A2', col_idx: 0, value: 'x', is_numeric: false }] }])],
    total_sheets: 1,
    truncated: false,
  };
  const missing = buildXlsxDiff(undefined, onlyNew) as XlsxDiffResult;
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'OFFICE_UNAVAILABLE');
  const noChange = buildXlsxDiff(onlyNew, onlyNew);
  assert.ok(noChange.ok);
  assert.equal(noChange.ok ? noChange.sheets.length : -1, 0);
});
