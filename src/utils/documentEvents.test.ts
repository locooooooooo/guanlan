import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileRecord } from '../types/guanlan';
import { documentEvents, orderedEvents } from './documentEvents';
import { documentLinks } from './documentLinks';

test('章节、核查表与清单按原文推进，保留行号、层级和勾选状态', () => {
  const doc = ['# 修复方案', '日期：2026-11-05', '## 原因', '| 现象 | 证据 |', '| --- | --- |',
    '| 入口分散 | 启动记录 |', '## 修复', '- [x] 核对入口', '  - [ ] 复核 PID', '- [ ] 等待验收',
    '~~~md', '## 伪章节', '- [x] 示例', '~~~'].join('\n');
  const [causes, fixes] = documentEvents(doc);
  assert.deepEqual(causes.children.map(e => [e.title, e.line]), [['入口分散', 6]]);
  assert.deepEqual(fixes.children.map(e => [e.title, e.line, e.checked, e.date]),
    [['核对入口', 8, true, undefined], ['等待验收', 10, false, undefined]]);
  assert.equal(fixes.children[0].children[0].line, 9);
});

test('明确日期按时间排序，混合无日期事项沿用原顺序', () => {
  const entries = documentEvents('- 2026-11-06 验收\n- 2026-11-05 核查');
  assert.deepEqual(orderedEvents(entries).map(e => e.line), [2, 1]);
  assert.deepEqual(orderedEvents([...entries, { ...entries[0], date: undefined, line: 3 }]).map(e => e.line), [1, 2, 3]);
});

test('跨文件事件链精确解析绝对链接、相对链接及回执原文路径', () => {
  const paths = ['甲/方案.md', '甲/图 件.svg', '乙/图 件.svg', 'output/run/HANDOFF.md'];
  const files = paths.map((relative_path, i) => ({ file_id: String(i), relative_path }) as FileRecord);
  const links = documentLinks(files, 'C:/项目')(files[0], [
    '[图](<C:/项目/甲/图 件.svg>)', '[重复](图%20件.svg)', '`output/run/HANDOFF.md`',
    '[越界](<C:/项目外/甲/图 件.svg>)', '~~~', '[示例](../乙/图%20件.svg)', '~~~',
  ].join('\n'));
  assert.deepEqual(links.map(e => [e.target_id, e.locator?.startLine]), [['1', 1], ['1', 2], ['3', 3]]);
});
