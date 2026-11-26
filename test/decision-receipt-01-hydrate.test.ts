import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  buildDecisionReceiptInstruction,
  fillPromptOf,
  loadDecisionReceiptSnapshot,
  parseDecisionFormItems,
  saveDecisionReceiptSnapshot,
  DECISION_RECEIPT_STORAGE_KEY,
} from '../src/components/ReaderView';



function itemsOf(markdown: string): Map<number, { text: string; checked?: boolean }> {
  const out = new Map<number, { text: string; checked?: boolean }>();
  parseDecisionFormItems(markdown).forEach((item, line) => {
    out.set(line, { text: item.text, checked: item.checkbox?.initialChecked });
  });
  return out;
}

describe('parseDecisionFormItems · 命中与保守回退', () => {
  test('C1 双选项成簇 hydrate，文本逐字', () => {
    const md = ['前言段落。', '', '□ A) 350mm卫生巾', '□ B) 420mm卫生巾', '', '后文。'].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [3, 4]);
    assert.equal(items.get(3)?.text, 'A) 350mm卫生巾');
    assert.equal(items.get(4)?.text, 'B) 420mm卫生巾');
    assert.equal(items.get(3)?.checked, false);
  });

  test('C2 ☑/☒ 原文已选态', () => {
    const md = ['☑ A) 方案一', '☒ B) 方案二'].join('\n');
    const items = itemsOf(md);
    assert.equal(items.get(1)?.checked, true);
    assert.equal(items.get(2)?.checked, true);
  });

  test('C3 任务行成簇 hydrate（含大写 [X]）', () => {
    const md = ['下一步：', '', '- [ ] 联系供应商', '- [x] 已传真确认函', '- [X] 归档回执'].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()].sort(), [3, 4, 5]);
    assert.equal(items.get(3)?.checked, false);
    assert.equal(items.get(4)?.checked, true);
    assert.equal(items.get(5)?.checked, true);
    assert.equal(items.get(4)?.text, '已传真确认函');
  });

  test('C4 填空行自命中关键词', () => {
    const md = ['确认人：___'].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [1]);
    assert.equal(items.get(1)?.text, '确认人：___');
  });

  test('C5 单项 + 前行引语关键词', () => {
    const md = ['请选择卫生巾规格：', '', '□ A) 350mm'].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [3]);
  });

  test('C6 单项 + 最近上方标题关键词', () => {
    const md = [
      '## 背景',
      '',
      '一段长说明文字（无关键词）。',
      '第二行说明。',
      '第三行说明。',
      '',
      '### 需你决策',
      '',
      '□ A) 方案一',
    ].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [9]);
  });

  test('C7 单项无任何语境信号 → 不 hydrate', () => {
    const md = ['会议纪要开头。', '', '□ 出席人员甲', '', '散会。'].join('\n');
    const items = itemsOf(md);
    assert.equal(items.size, 0);
  });

  test('C8 行内提及「□」不强改', () => {
    const md = ['在表格里勾选（□ 表示未选）。全文仅此一处提及。'].join('\n');
    const items = itemsOf(md);
    assert.equal(items.size, 0);
  });

  test('C9 光杆「□」非 item', () => {
    const md = ['□', '', '□ A) 有内容', '□ B) 也有内容'].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [3, 4]);
  });

  test('C10 围栏内不 hydrate', () => {
    const md = [
      '```text',
      '□ A) 这是代码示例',
      '□ B) 同上',
      '```',
      '',
      '□ C) 围栏外真选项',
      '□ D) 同上',
    ].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [6, 7]);
  });

  test('C11 桥接行 ≤2 不断带，>2 断带', () => {
    const md = [
      '□ A) 第一项',
      '说明一行。',
      '说明两行。',
      '□ B) 同带第二项（隔 2 行仍续带）',
      '',
      '间隔文字一。',
      '间隔文字二。',
      '间隔文字三。',
      '□ C) 断带后单项',
    ].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [1, 4]);
    assert.equal(items.get(4)?.text, 'B) 同带第二项（隔 2 行仍续带）');
  });

  test('C12 「3.5mm」类文本逐字保留（无标号误剥）', () => {
    const md = ['□ 3.5mm 转接头', '□ 6.5mm 转接头'].join('\n');
    const items = itemsOf(md);
    assert.equal(items.get(1)?.text, '3.5mm 转接头');
    assert.equal(items.get(2)?.text, '6.5mm 转接头');
  });

  test('C13 「■」装饰字符不识别', () => {
    const md = ['■ 分隔装饰一', '■ 分隔装饰二'].join('\n');
    const items = itemsOf(md);
    assert.equal(items.size, 0);
  });

  test('C14 任务行内嵌填空', () => {
    const md = ['请补齐并勾选：', '', '- [ ] 设备名称：___'].join('\n');
    const items = itemsOf(md);
    assert.deepEqual([...items.keys()], [3]);
    assert.equal(items.get(3)?.text, '设备名称：___');
    assert.equal(items.get(3)?.checked, false);
  });

  test('C15 列表填空行剥一个列表标记', () => {
    const md = ['收货信息（请选择或填写）：', '', '- 联系人：___', '- 电话：___'].join('\n');
    const items = itemsOf(md);
    assert.equal(items.get(3)?.text, '联系人：___');
    assert.equal(items.get(4)?.text, '电话：___');
  });

  test('空正文安全', () => {
    assert.equal(parseDecisionFormItems('').size, 0);
    assert.equal(parseDecisionFormItems(undefined as unknown as string).size, 0);
  });
});


describe('fillPromptOf', () => {
  test('S1 尾冒号剥离与回退', () => {
    assert.equal(fillPromptOf('确认人：___'), '确认人');
    assert.equal(fillPromptOf('规格 ___ 型号 ___'), '规格 型号');
    assert.equal(fillPromptOf('___'), '___');
  });
});


describe('buildDecisionReceiptInstruction', () => {
  test('I1 全量组装与空段省略', () => {
    const full = buildDecisionReceiptInstruction({
      title: '卫生巾采购确认单',
      filePath: 'docs/采购/确认单.md',
      revisionId: 'rev-abc',
      selectedOptions: ['A) 350mm卫生巾'],
      fillValues: [{ prompt: '确认人', value: '张三' }],
    });
    assert.ok(full.includes('## 决策回执：卫生巾采购确认单'));
    assert.ok(full.includes('- 来源文件：docs/采购/确认单.md'));
    assert.ok(full.includes('- 版本快照：rev-abc'));
    assert.ok(full.includes('（只读快照，本回执未回写原文件）'));
    assert.ok(full.includes('- [x] A) 350mm卫生巾'));
    assert.ok(full.includes('- 确认人：张三'));

    const noFill = buildDecisionReceiptInstruction({
      title: 't',
      filePath: 'p',
      revisionId: 'r',
      selectedOptions: ['A) x'],
      fillValues: [],
    });
    assert.ok(!noFill.includes('### 填空内容'));

    const noChecks = buildDecisionReceiptInstruction({
      title: 't',
      filePath: 'p',
      revisionId: 'r',
      selectedOptions: [],
      fillValues: [{ prompt: 'q', value: 'v' }],
    });
    assert.ok(!noChecks.includes('### 已勾选决策'));
  });
});


describe('决策快照存取', () => {
  test('K1 node 无 window：load null / save 不炸', () => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(loadDecisionReceiptSnapshot('f::r'), null);
    assert.doesNotThrow(() =>
      saveDecisionReceiptSnapshot('f::r', { checks: { '1': true }, fills: {} })
    );
  });

  test('K2 save→load 回环与损坏容错', () => {
    const store = new Map<string, string>();
    const fakeWindow = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
    (globalThis as { window?: unknown }).window = fakeWindow;
    try {
      saveDecisionReceiptSnapshot('fileA::rev1', {
        checks: { '3': true, '4': false },
        fills: { '5:0': '350mm' },
      });
      const snap = loadDecisionReceiptSnapshot('fileA::rev1');
      assert.deepEqual(snap, { checks: { '3': true, '4': false }, fills: { '5:0': '350mm' } });
      assert.equal(loadDecisionReceiptSnapshot('fileA::missing'), null);

      assert.ok(store.has(DECISION_RECEIPT_STORAGE_KEY));

      store.set(DECISION_RECEIPT_STORAGE_KEY, '{not-json');
      assert.equal(loadDecisionReceiptSnapshot('fileA::rev1'), null);

      store.set(
        DECISION_RECEIPT_STORAGE_KEY,
        JSON.stringify({ 'fileA::rev1': { checks: { '3': 'yes' }, fills: {} } })
      );
      assert.equal(loadDecisionReceiptSnapshot('fileA::rev1'), null);

      store.set(DECISION_RECEIPT_STORAGE_KEY, JSON.stringify([1, 2]));
      assert.equal(loadDecisionReceiptSnapshot('fileA::rev1'), null);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
