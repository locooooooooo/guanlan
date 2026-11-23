import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDecisionReceiptInstruction,
  buildWrittenBackMarkdown,
  parseDecisionFormItems,
} from '../src/components/ReaderView';

/* 决策回执补完（回写/单选/指令标记）——starfix2 同代纯函数单测：
   全部走 ReaderView 导出的纯函数，不渲染组件。 */

const parse = (content: string) => parseDecisionFormItems(content);

test('回写：勾选项 □→☑，未命中行逐字保留', () => {
  const content = '□ A) 350mm卫生巾\n□ B) 经期裤\n正文段落不动。';
  const items = parse(content);
  const output = buildWrittenBackMarkdown({
    markdownContent: content,
    items,
    checks: { 1: true },
    fills: {},
  });
  const lines = output.split('\n');
  assert.equal(lines[0], '☑ A) 350mm卫生巾');
  assert.equal(lines[1], '□ B) 经期裤');
  assert.equal(lines[2], '正文段落不动。');
});

test('回写：markdown 任务行 [ ]→[x]（有决策语境标题才 hydrate）', () => {
  const content = '### 需你决策\n\n- [ ] 拍板交付日期\n';
  const output = buildWrittenBackMarkdown({
    markdownContent: content,
    items: parse(content),
    checks: { 3: true },
    fills: {},
  });
  assert.equal(output, '### 需你决策\n\n- [x] 拍板交付日期\n');
});

test('回写：填空按槽序替换，空槽保留原下划线', () => {
  const content = '确认人：___（联系电话：___）\n';
  const output = buildWrittenBackMarkdown({
    markdownContent: content,
    items: parse(content),
    checks: {},
    fills: { '1:0': '张三' },
  });
  assert.equal(output, '确认人：张三（联系电话：___）\n');
  const full = buildWrittenBackMarkdown({
    markdownContent: content,
    items: parse(content),
    checks: {},
    fills: { '1:0': '张三', '1:1': '138xxxx0000' },
  });
  assert.equal(full, '确认人：张三（联系电话：138xxxx0000）\n');
});

test('回写：已选态字符（☑/☒/[x]）不再改写', () => {
  const content = '☑ A) 已选\n☒ B) 否决\n- [x] 已完成任务\n';
  const items = parse(content);
  const output = buildWrittenBackMarkdown({
    markdownContent: content,
    items,
    checks: { 1: true, 2: true, 3: true },
    fills: {},
  });
  assert.equal(output, content);
});

test('回写：零落笔时输出与原文逐字节一致（冲突比对基线可靠）', () => {
  const content = '□ A) 甲\n说明：___\n\n尾段。\n';
  const output = buildWrittenBackMarkdown({
    markdownContent: content,
    items: parse(content),
    checks: {},
    fills: {},
  });
  assert.equal(output, content);
});

test('回写：填写值含 $ 序列按字面落笔（不二次解释替换模式）', () => {
  const content = '代号：___\n';
  const output = buildWrittenBackMarkdown({
    markdownContent: content,
    items: parse(content),
    checks: {},
    fills: { '1:0': '$&$2现价' },
  });
  assert.equal(output, '代号：$&$2现价\n');
});

test('单选门控：带前「二选一」→ 区带复选项标注同一 radio 簇', () => {
  const content = '发布参数请从以下方案中二选一：\n\n□ A) 独立 EXE\n□ B) 安装包\n';
  const items = parse(content);
  const first = items.get(3);
  const second = items.get(4);
  assert.ok(first?.radio, '带前单选措辞必须放行为单选簇');
  assert.ok(second?.radio, '同区带第二项同样入簇');
  assert.equal(first.radio?.zoneId, second.radio?.zoneId);
});

test('单选门控：普通清单（无单选措辞）保持复选语义', () => {
  const content = '### 需你决策\n\n□ A) 甲\n□ B) 乙\n';
  const items = parse(content);
  for (const [, item] of items) {
    assert.equal(item.radio, undefined, '无单选措辞不得误降级为 radio');
  }
});

test('指令构建器：writtenBack 标记如实切换来源行措辞', () => {
  const base = {
    title: '决策回执',
    filePath: 'docs/决策回执.md',
    revisionId: 'rev-1',
    selectedOptions: ['A) 甲'],
    fillValues: [] as { prompt: string; value: string }[],
  };
  const unsaved = buildDecisionReceiptInstruction({ ...base });
  assert.ok(unsaved.includes('只读快照，本回执未回写原文件'));
  const saved = buildDecisionReceiptInstruction({ ...base, writtenBack: true });
  assert.ok(saved.includes('已回写原文件'));
  assert.ok(!saved.includes('未回写原文件'));
});
