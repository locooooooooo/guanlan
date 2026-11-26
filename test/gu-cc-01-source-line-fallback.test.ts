import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSourceLineFallbackNotice,
  pickNearestSourceLineAnchor,
} from '../src/components/ReaderView';


function deriveAnchorLines(lines: string[]): number[] {
  const anchors: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      anchors.push(lineNo);
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) i++;
      i++;
      continue;
    }
    if (trimmed.startsWith('|')) {
      const start = lineNo;
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim());
        i++;
      }
      anchors.push(start);
      rows.slice(1).forEach((text, idx) => {
        if (!/^\|[\s\-:|]+\|$/.test(text)) anchors.push(start + 1 + idx);
      });
      continue;
    }
    if (!trimmed) {
      i++;
      continue;
    }
    anchors.push(lineNo);
    i++;
  }
  return anchors;
}


test('围栏内部行：落点回退到 codeStart 锚点，文案逐字中性、不含「无正文」', () => {
  const codeStart = 3;
  const fenceBody = Array.from({ length: 50 }, (_, k) => `const step_${k + 1} = ${k + 1};`);
  const lines = [
    '# 观澜证据定位走查',
    '',
    '```ts',
    ...fenceBody,
    '```',
    '',
    '## 收尾章节',
  ];
  const anchors = deriveAnchorLines(lines);
  const targetLine = codeStart + 10;

  assert.ok(anchors.includes(codeStart), 'codeStart 应是围栏整块唯一锚点');
  assert.ok(!anchors.includes(targetLine), '围栏内部行不应有锚点');

  const landed = pickNearestSourceLineAnchor(anchors, targetLine);
  assert.equal(landed, codeStart, '滚动落点必须是 codeStart 锚点行');

  const notice = formatSourceLineFallbackNotice(targetLine, landed as number);
  assert.equal(notice, 'L13 无对应定位点，已就近定位到 L3');
  assert.equal(
    notice,
    `L${targetLine} 无对应定位点，已就近定位到 L${landed}`,
    '文案模板必须逐字等于「L{目标行} 无对应定位点，已就近定位到 L{实际行}」'
  );
  assert.ok(!notice.includes('无正文'), '文案绝不能出现「无正文」（围栏内部行正文存在，缺的只是定位点）');
  assert.ok(!notice.includes('附近'), '文案不得用「附近」等未量化词，行号一律写实');
});


test('目标行自身有锚点：纯函数幂等返回该行（命中路径先行，无需回退）', () => {
  const lines = ['# 观澜证据定位走查', '', '## 收尾章节'];
  const anchors = deriveAnchorLines(lines);
  const anchoredTarget = 3;
  assert.ok(anchors.includes(anchoredTarget));

  assert.equal(pickNearestSourceLineAnchor(anchors, anchoredTarget), anchoredTarget);
});


test('之前无任何锚点：取之后最近锚点，提示行号为实际落点行号', () => {
  const lines = ['', '', '```text', 'alpha', 'beta', '```', '第一段正文'];
  const anchors = deriveAnchorLines(lines);
  assert.deepEqual(anchors, [3, 7]);

  assert.equal(pickNearestSourceLineAnchor(anchors, 2), 3, 'L2 之前无锚点 → 取之后最近的 L3');
  assert.equal(pickNearestSourceLineAnchor(anchors, 1), 3, 'L1 同理');

  const notice = formatSourceLineFallbackNotice(2, 3);
  assert.equal(notice, 'L2 无对应定位点，已就近定位到 L3');
  assert.ok(!notice.includes('无正文'));
});


test('就近规则：之前取 ≤ 目标的最大锚点，之前为空取 > 目标的最小锚点', () => {
  const anchors = [1, 3, 7, 20, 42];
  assert.equal(pickNearestSourceLineAnchor(anchors, 30), 20);
  assert.equal(pickNearestSourceLineAnchor(anchors, 21), 20);
  assert.equal(pickNearestSourceLineAnchor(anchors, 19), 7);
  assert.equal(pickNearestSourceLineAnchor(anchors, 4), 3);
  assert.equal(pickNearestSourceLineAnchor(anchors, 0), 1);
  assert.equal(pickNearestSourceLineAnchor(anchors, 2), 1);
  assert.equal(pickNearestSourceLineAnchor(anchors, 20), 20);
  assert.equal(pickNearestSourceLineAnchor([42, 7, 20, 1, 3], 30), 20);
  assert.equal(pickNearestSourceLineAnchor([9, 4], 2), 4);
});

test('全文件无锚点：返回 null（调用方不滚动、不出提示，绝不假装定位成功）', () => {
  assert.equal(pickNearestSourceLineAnchor([], 5), null, '空锚点集合必须返回 null');
  assert.deepEqual(deriveAnchorLines(['', '', '']), []);
  assert.equal(pickNearestSourceLineAnchor(deriveAnchorLines(['', '']), 1), null);
});


test('表格分隔行：回退到表头行的整块锚点，正文行锚点不受影响', () => {
  const lines = ['# 表格走查', '', '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'];
  const anchors = deriveAnchorLines(lines);
  assert.deepEqual(anchors, [1, 3, 5, 6]);

  assert.equal(pickNearestSourceLineAnchor(anchors, 4), 3, '分隔行 → 之前最近的 L3 表头锚点');
  assert.equal(pickNearestSourceLineAnchor(anchors, 5), 5, '正文行自身有锚点，幂等');
});

