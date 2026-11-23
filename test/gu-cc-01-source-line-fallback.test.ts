import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSourceLineFallbackNotice,
  pickNearestSourceLineAnchor,
} from '../src/components/ReaderView';

/**
 * GU-CC-01：证据行定位「就近回退」确定性单测。
 *
 * 背景：证据指针 lineStart 可能落在无锚点行上（两类来源）——
 * ① 代码围栏内部行：围栏整块只在 codeStart 挂一个 data-event-source-line（ReaderView
 *    渲染循环 wrapLine 仅在 codeStart 写锚点），内部行全部无锚但正文存在；
 * ② 表格分隔行（|---|）等非渲染行：wrapLine 整块锚点在表头行，<tr> 锚点只挂正文行。
 * 现版对这些行 querySelector 静默失败（真实工作区走查 Q02：scrollTop 停在 0）。
 *
 * 修复语义（本文件只测可确定性化的纯函数层；DOM 层 collectRenderedSourceLineAnchors
 * 与命中路径属浏览器 effect，无法在 node 复跑，见文末「对账」注释）：
 * - 命中（目标行自身有锚点）：querySelector 命中即 scrollIntoView({block:'center'})，
 *   与现版逐字一致（ReaderView 原 284-289），不渲染任何回退提示；
 * - 未命中：回退到「目标行之前最近的已存在锚点」；之前无任何锚点 → 之后最近锚点；
 *   全文件无锚点 → 不滚动、不出提示；
 * - 回退发生时提示文案逐字等于「L{目标行} 无对应定位点，已就近定位到 L{实际落点}」，
 *   绝不出现「无正文」（围栏内部行正文存在，缺的只是定位点）。
 */

// ---------- 描述性镜像：按 ReaderView 渲染循环的锚点粒度从 markdown 夹具推导锚点集合 ----------
// （渲染循环本身无法在 node 复跑；此镜像逐条对应：围栏→仅 codeStart；表格→tableStart+正文行；
//   空行→不渲染无锚；其余已渲染行→自身锚点。若渲染粒度变化，需同步修订此镜像。）
function deriveAnchorLines(lines: string[]): number[] {
  const anchors: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      anchors.push(lineNo); // 围栏整块仅 codeStart 一个锚点
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) i++;
      i++; // 闭合围栏行同样无锚（循环内跳过，不 wrapLine）
      continue;
    }
    if (trimmed.startsWith('|')) {
      const start = lineNo;
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim());
        i++;
      }
      anchors.push(start); // wrapLine 整块锚点挂在表头行
      rows.slice(1).forEach((text, idx) => {
        // 分隔行（|---|）不渲染 <tr> 无锚；正文行锚点 = 实际行号（与 rowLines 一致）
        if (!/^\|[\s\-:|]+\|$/.test(text)) anchors.push(start + 1 + idx);
      });
      continue;
    }
    if (!trimmed) {
      i++; // 空行不渲染占位元素，无锚点
      continue;
    }
    anchors.push(lineNo);
    i++;
  }
  return anchors;
}

// ---------- 验收 1：50 行代码围栏，指针指向围栏内部具体行（写死 codeStart+10） ----------

test('GU-CC-01 围栏内部行：落点回退到 codeStart 锚点，文案逐字中性、不含「无正文」', () => {
  const codeStart = 3; // L1 标题、L2 空行、L3 围栏开头
  const fenceBody = Array.from({ length: 50 }, (_, k) => `const step_${k + 1} = ${k + 1};`);
  const lines = [
    '# 观澜证据定位走查',
    '',
    '```ts',
    ...fenceBody, // L4..L53：围栏内部 50 行，全部无锚点但正文存在
    '```', // L54：闭合围栏，无锚点
    '',
    '## 收尾章节',
  ];
  const anchors = deriveAnchorLines(lines);
  const targetLine = codeStart + 10; // L13：围栏内部具体行（测试写死偏移）

  // 夹具自检：codeStart 有锚点、目标行无锚点
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

// ---------- 验收 2：目标行自身有锚点 → 直接命中该行，不渲染回退提示 ----------

test('GU-CC-01 目标行自身有锚点：纯函数幂等返回该行（命中路径先行，无需回退）', () => {
  const lines = ['# 观澜证据定位走查', '', '## 收尾章节'];
  const anchors = deriveAnchorLines(lines);
  const anchoredTarget = 3; // '## 收尾章节' 自身有锚点
  assert.ok(anchors.includes(anchoredTarget));

  // 组件层：querySelector 命中即 scrollIntoView({block:'center'}) 且 setSourceLineFallback(null)
  //（ReaderView effect 命中分支逐字保留现版语义，不渲染提示）；纯函数契约上幂等返回目标行自身，
  // 保证即便误入回退函数也不会把读者带到别处。
  assert.equal(pickNearestSourceLineAnchor(anchors, anchoredTarget), anchoredTarget);
});

// ---------- 验收 3：目标行之前无任何锚点 → 落点为之后最近锚点，提示行号为实际落点 ----------

test('GU-CC-01 之前无任何锚点：取之后最近锚点，提示行号为实际落点行号', () => {
  // 文件以两行空行开头（空行不渲染无锚点），首个锚点出现在 L3 围栏开头；
  // 指针落在 L1/L2 这类「之前没有任何锚点」的行上
  const lines = ['', '', '```text', 'alpha', 'beta', '```', '第一段正文'];
  const anchors = deriveAnchorLines(lines);
  assert.deepEqual(anchors, [3, 7]);

  assert.equal(pickNearestSourceLineAnchor(anchors, 2), 3, 'L2 之前无锚点 → 取之后最近的 L3');
  assert.equal(pickNearestSourceLineAnchor(anchors, 1), 3, 'L1 同理');

  const notice = formatSourceLineFallbackNotice(2, 3);
  assert.equal(notice, 'L2 无对应定位点，已就近定位到 L3');
  assert.ok(!notice.includes('无正文'));
});

// ---------- 验收 4：「就近」量化为确定性规则（不再用未量化的「附近」） ----------

test('GU-CC-01 就近规则：之前取 ≤ 目标的最大锚点，之前为空取 > 目标的最小锚点', () => {
  const anchors = [1, 3, 7, 20, 42];
  // 之前有多个候选：取之前最近（最大 ≤ 目标），不取更早的、也不越过后面的
  assert.equal(pickNearestSourceLineAnchor(anchors, 30), 20);
  assert.equal(pickNearestSourceLineAnchor(anchors, 21), 20);
  assert.equal(pickNearestSourceLineAnchor(anchors, 19), 7);
  assert.equal(pickNearestSourceLineAnchor(anchors, 4), 3);
  // 目标在首个锚点之前：之前为空 → 取之后最近（最小 > 目标）
  assert.equal(pickNearestSourceLineAnchor(anchors, 0), 1);
  // 目标 L2 之前已有锚点 L1：规则①优先——就近取 L1，不越到之后
  assert.equal(pickNearestSourceLineAnchor(anchors, 2), 1);
  // 目标恰好压在锚点上：返回该行自身（幂等契约）
  assert.equal(pickNearestSourceLineAnchor(anchors, 20), 20);
  // 防御性排序：与传入顺序无关，结果确定
  assert.equal(pickNearestSourceLineAnchor([42, 7, 20, 1, 3], 30), 20);
  // 乱序集合下「之前为空取之后」分支同样确定：目标 2 之前无锚 → 之后最近 4
  assert.equal(pickNearestSourceLineAnchor([9, 4], 2), 4);
});

test('GU-CC-01 全文件无锚点：返回 null（调用方不滚动、不出提示，绝不假装定位成功）', () => {
  assert.equal(pickNearestSourceLineAnchor([], 5), null, '空锚点集合必须返回 null');
  // 纯空行/纯空白文档渲染不出任何锚点
  assert.deepEqual(deriveAnchorLines(['', '', '']), []);
  assert.equal(pickNearestSourceLineAnchor(deriveAnchorLines(['', '']), 1), null);
});

// ---------- 验收 4 补充：表格分隔行（无锚点第二类来源） ----------

test('GU-CC-01 表格分隔行：回退到表头行的整块锚点，正文行锚点不受影响', () => {
  const lines = ['# 表格走查', '', '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'];
  const anchors = deriveAnchorLines(lines);
  // L3 表头（wrapLine 整块锚点）、L5/L6 正文行（<tr> 锚点）；L4 分隔行无锚
  assert.deepEqual(anchors, [1, 3, 5, 6]);

  assert.equal(pickNearestSourceLineAnchor(anchors, 4), 3, '分隔行 → 之前最近的 L3 表头锚点');
  assert.equal(pickNearestSourceLineAnchor(anchors, 5), 5, '正文行自身有锚点，幂等');
});

/*
 * ---------- 浏览器复测对账（本环境无 DOM/无 3100 dev server，不可复跑，逐条文字对账） ----------
 * Q02（真实工作区走查，引自 ask）：决策证据跳转后 scrollTop 停在 0（停在文首），原因是证据
 * lineStart 落在无锚点行时 querySelector('[data-event-source-line=…]') 取不到元素，滚动静默失败。
 * 逐条：
 * 1) scrollTop=0 直接根因已消除：未命中不再静默返回，改为确定性回退 scrollIntoView({block:'center'})
 *    到最近锚点——只要文档存在任一锚点，scrollTop 必然离开 0（ReaderView effect 回退分支）。
 * 2) 围栏内部行（无锚点来源①）：落点=codeStart，横幅逐字显示
 *    「L{目标} 无对应定位点，已就近定位到 L{codeStart}」（本文件验收 1 断言）。
 * 3) 表格分隔行（无锚点来源②）：落点=表头整块锚点（本文件表格用例断言）。
 * 4) 「无正文」误诊不可能出现：文案由 formatSourceLineFallbackNotice 单一来源产出，
 *    逐字断言 + includes('无正文')===false 双重拦截。
 * 5) 有锚点路径回归：命中分支保留现版 querySelector+scrollIntoView({block:'center'}) 原语义
 *    （改动 diff 中逐字可见），锚点命中不出任何提示——由组件层代码保证，本文件验收 2 只测纯函数幂等。
 * 6) 全文件无锚点的极端文档：不滚动、不出提示，用户不会被假定位误导（验收 4 断言）。
 */
