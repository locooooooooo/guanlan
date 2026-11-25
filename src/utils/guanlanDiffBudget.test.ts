/**
 * 阅读/未读统计与差异计算拆分单测：
 * - 未读判定只比较版本身份（O(1)），不再触发二维 LCS；
 * - computeMarkdownDiff 同版本/同内容快捷退出（不分配 DP、保留行号）；
 * - 正文未加载 ≠ 空文档（CONTENT_NOT_LOADED，不把整份文档误报成全新增）；
 * - 行数与 DP 单元数硬预算，超限明确返回 DIFF_TOO_LARGE（不用空 diff 冒充成功）；
 * - 章节级变更走 computeChangedSectionsSinceRead（章节指纹，O(m+n)），正文未取回返回 []。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeChangedSectionsSinceRead,
  computeMarkdownDiff,
  DIFF_MAX_DP_CELLS,
  DIFF_MAX_LINES_PER_SIDE,
  hasUnreadChanges,
} from './guanlanEngine';
import type { FileRecord, ReadingState, Revision } from '../types/guanlan';

let seq = 0;
function revision(over: Partial<Revision> & Pick<Revision, 'revision_id'>): Revision {
  seq += 1;
  return {
    file_id: 'f_diff18',
    versionNumber: seq,
    content_sha256: `sha-${over.revision_id}`,
    observed_at: '2026-11-16T10:00:00+08:00',
    sizeBytes: 1024,
    snapshotAvailable: true,
    summaryNote: `v${seq}`,
    ...over,
  };
}

function fileOf(revisions: Revision[], currentRevisionId?: string): FileRecord {
  return {
    file_id: 'f_diff18',
    relative_path: 'diff/budget.md',
    title: '差异预算',
    format: 'md',
    folder: 'diff',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: currentRevisionId ?? revisions[revisions.length - 1].revision_id,
    revisions,
    coverage: 'full_text',
  };
}

const BASELINE_TEXT = ['# 标题', '第一段内容。', '', '## 章节 A', 'A 的内容。', 'A 的第二行。', '', '## 章节 B', 'B 的内容。'].join('\n');

function twoVersionFile(
  baselineText: string,
  currentText: string,
  opts?: { baselineContentLoaded?: boolean; currentContentLoaded?: boolean }
) {
  const load = (loaded: boolean | undefined, text: string) =>
    loaded === false ? {} : { markdownContent: text };
  const baseline = revision({
    revision_id: 'rev_base',
    sizeBytes: baselineText.length,
    ...load(opts?.baselineContentLoaded ?? true, baselineText),
  });
  const current = revision({
    revision_id: 'rev_curr',
    sizeBytes: currentText.length,
    ...load(opts?.currentContentLoaded ?? true, currentText),
  });
  return fileOf([baseline, current]);
}

const readState = (baselineId: string, currentId: string): ReadingState =>
  ({
    file_id: 'f_diff18',
    last_read_revision_id: baselineId,
    // 当前版本字段仅用于让判定走 updated 分支；hasUnreadChanges 只看两个 id 是否相等
    last_read_at: '2026-11-16T09:00:00+08:00',
    scrollPercent: 0,
    current_revision_id: currentId,
  }) as unknown as ReadingState;

test('快捷退出①：同版本 ID 不分配 DP，返回全 unchanged 且行号稳定', () => {
  const text = Array.from({ length: 500 }, (_, i) => `第 ${i + 1} 行`).join('\n');
  const file = twoVersionFile(text, text);
  const res = computeMarkdownDiff(file, 'rev_base', 'rev_base');
  assert.equal(res.ok, true);
  assert.equal(res.errorCode, undefined);
  assert.equal(res.addedCount, 0);
  assert.equal(res.removedCount, 0);
  assert.deepEqual(res.changedSections, []);
  // 保留展示需要的行信息：行数与原文一致，行号 1..n 成对
  assert.equal(res.lines.length, 500);
  assert.equal(res.lines[0].type, 'unchanged');
  assert.equal(res.lines[0].oldLineNumber, 1);
  assert.equal(res.lines[0].newLineNumber, 1);
  assert.equal(res.lines[499].oldLineNumber, 500);
  assert.equal(res.lines[499].newLineNumber, 500);
});

test('快捷退出②：不同版本但已就绪内容逐字相同 → 无变化，不冒充有差异', () => {
  const text = '# 标题\n同样的内容。\n## 章节 A\nA。';
  const file = twoVersionFile(text, text);
  assert.notEqual('rev_base', 'rev_curr');
  const res = computeMarkdownDiff(file, 'rev_base', 'rev_curr');
  assert.equal(res.ok, true);
  assert.equal(res.addedCount, 0);
  assert.equal(res.removedCount, 0);
  assert.deepEqual(res.changedSections, []);
  assert.equal(res.lines.every((l) => l.type === 'unchanged'), true);
});

test('未加载守卫：基线正文未取回时返回 CONTENT_NOT_LOADED，不把文档误报成全新增', () => {
  const currentText = '# 新标题\n全部看起来像新增？不。';
  const file = twoVersionFile(BASELINE_TEXT, currentText, {
    baselineContentLoaded: false,
    currentContentLoaded: true,
  });
  const res = computeMarkdownDiff(file, 'rev_base', 'rev_curr');
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'CONTENT_NOT_LOADED');
  assert.equal(res.lines.length, 0);
  assert.equal(res.addedCount, 0);
});

test('未加载守卫：目标正文未取回同样拒绝；占位版本行（空 hash+0 字节）不算确认空文档', () => {
  const file = twoVersionFile(BASELINE_TEXT, '# 目标\n内容。', {
    baselineContentLoaded: true,
    currentContentLoaded: false,
  });
  const res = computeMarkdownDiff(file, 'rev_base', 'rev_curr');
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'CONTENT_NOT_LOADED');

  // 摘要分页产出的占位版本行：content_sha256 为空串、sizeBytes 为 0——
  // 不得被 isConfirmedEmptyContent 当成「确认空文档」绕过守卫
  const placeholder = revision({
    revision_id: 'rev_placeholder',
    content_sha256: '',
    sizeBytes: 0,
  });
  const placeholderFile = fileOf([
    file.revisions[0],
    placeholder,
  ]);
  const res2 = computeMarkdownDiff(placeholderFile, 'rev_base', 'rev_placeholder');
  assert.equal(res2.ok, false);
  assert.equal(res2.errorCode, 'CONTENT_NOT_LOADED');
});

test('确认空文档（0 字节且 hash 非空）可以参与对比：空 → 有内容按真实新增报告', () => {
  const empty = revision({
    revision_id: 'rev_empty',
    content_sha256: 'sha-of-empty',
    sizeBytes: 0,
    markdownContent: '',
  });
  const current = revision({
    revision_id: 'rev_curr',
    sizeBytes: 20,
    markdownContent: '# 新文档\n正文。',
  });
  const file = fileOf([empty, current]);
  const res = computeMarkdownDiff(file, 'rev_empty', 'rev_curr');
  assert.equal(res.ok, true);
  assert.equal(res.errorCode, undefined);
  // 空串按一行空行参与对比：旧「空行」被移除，新文档两行全新增——如实报告，不谎报
  assert.equal(res.addedCount, 2);
  assert.equal(res.removedCount, 1);
});

test('预算①：DP 单元数超限明确拒绝 DIFF_TOO_LARGE，不用空 diff 冒充成功', () => {
  // (m+1)(n+1) > DIFF_MAX_DP_CELLS：两侧 2200 行 → 2201² ≈ 4.84M > 4M
  const side = Math.min(2200, Math.floor(Math.sqrt(DIFF_MAX_DP_CELLS)));
  const oldText = Array.from({ length: side }, (_, i) => `旧 ${i}`).join('\n');
  const newText = Array.from({ length: side }, (_, i) => `新 ${i}`).join('\n');
  const file = twoVersionFile(oldText, newText);
  const res = computeMarkdownDiff(file, 'rev_base', 'rev_curr');
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'DIFF_TOO_LARGE');
  assert.equal(res.lines.length, 0);
});

test('预算②：单侧行数超限同样拒绝', () => {
  const long = Array.from({ length: DIFF_MAX_LINES_PER_SIDE + 1 }, (_, i) => `行 ${i}`).join('\n');
  const file = twoVersionFile(long, '短内容');
  const res = computeMarkdownDiff(file, 'rev_base', 'rev_curr');
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'DIFF_TOO_LARGE');
});

test('预算内真实变更照常计算（Int32Array DP 回归）', () => {
  const oldText = ['# 标题', '第一段内容。', '', '## 章节 A', 'A 的旧内容。', '', '## 章节 B', 'B 的内容。'].join('\n');
  const newText = ['# 标题', '第一段内容。', '', '## 章节 A', 'A 的新内容。', '新增行。', '', '## 章节 B', 'B 的内容。', '', '## 章节 C', '新章节。'].join('\n');
  const file = twoVersionFile(oldText, newText);
  const res = computeMarkdownDiff(file, 'rev_base', 'rev_curr');
  assert.equal(res.ok, true);
  // 新增：A 的新内容。/ 新增行。/ 空行 / ## 章节 C / 新章节。
  assert.equal(res.addedCount, 5);
  assert.equal(res.removedCount, 1); // A 的旧内容。
  // 空行新增落在章节 B 标题之后、章节 C 之前，按行走题口径归入章节 B（与既有 DP 行为一致）
  assert.deepEqual(res.changedSections.sort(), ['章节 A', '章节 B', '章节 C']);
  // 行号稳定性：首行 unchanged 对齐 1↔1
  assert.equal(res.lines[0].type, 'unchanged');
  assert.equal(res.lines[0].oldLineNumber, 1);
  assert.equal(res.lines[0].newLineNumber, 1);
});

test('未读判定只比较版本身份：基线落后但两侧正文都未取回也如实报未读、不触发 diff', () => {
  const file = twoVersionFile(BASELINE_TEXT, '# 当前\n内容。', {
    baselineContentLoaded: false,
    currentContentLoaded: false,
  });
  const st = readState('rev_base', 'rev_curr');
  const info = hasUnreadChanges(file, st);
  assert.equal(info.isUnread, true);
  assert.equal(info.reason, 'updated_since_last_read');
  assert.deepEqual(info.changedSectionsSinceRead, []);
});

test('未读判定三态回归：never_read / up_to_date / updated', () => {
  const file = twoVersionFile(BASELINE_TEXT, '# 当前\n内容。');
  const never = hasUnreadChanges(file, undefined);
  assert.equal(never.reason, 'never_read');

  const upToDate = hasUnreadChanges(file, readState('rev_curr', 'rev_curr'));
  assert.equal(upToDate.isUnread, false);
  assert.equal(upToDate.reason, 'up_to_date');

  const updated = hasUnreadChanges(file, readState('rev_base', 'rev_curr'));
  assert.equal(updated.isUnread, true);
  assert.equal(updated.reason, 'updated_since_last_read');
});

test('章节指纹：按需计算变更章节（改 A、增 C、删 D 各归其位）', () => {
  const baselineText = [
    '# 头',
    '引言。',
    '',
    '## 章节 A',
    'A 旧内容。',
    '',
    '## 章节 B',
    'B 内容不变。',
    '',
    '## 章节 D',
    'D 将被删除。',
  ].join('\n');
  const currentText = [
    '# 头',
    '引言。',
    '',
    '## 章节 A',
    'A 新内容。',
    '',
    '## 章节 B',
    'B 内容不变。',
    '',
    '## 章节 C',
    '新增章节。',
  ].join('\n');
  const file = twoVersionFile(baselineText, currentText);
  const st = readState('rev_base', 'rev_curr');
  const sections = computeChangedSectionsSinceRead(file, st);
  assert.deepEqual(sections.sort(), ['章节 A', '章节 C', '章节 D']);
});

test('章节指纹：正文未取回返回 []（诚实未知，不误报全文档变更）', () => {
  const file = twoVersionFile(BASELINE_TEXT, '# 当前\n内容。', {
    baselineContentLoaded: false,
  });
  const st = readState('rev_base', 'rev_curr');
  assert.deepEqual(computeChangedSectionsSinceRead(file, st), []);

  // 快照淘汰同样返回 []，与 REVISION_UNAVAILABLE 的诚实口径一致
  const evictedFile = fileOf([
    revision({ revision_id: 'rev_base', snapshotAvailable: false, markdownContent: BASELINE_TEXT }),
    revision({ revision_id: 'rev_curr', markdownContent: '# 当前\n内容。' }),
  ]);
  assert.deepEqual(computeChangedSectionsSinceRead(evictedFile, st), []);
});

test('章节指纹：同内容不同版本 → []；从未读过 / 已读最新 → []', () => {
  const text = '# 标题\n内容。\n## A\nA。';
  const file = twoVersionFile(text, text);
  const st = readState('rev_base', 'rev_curr');
  assert.deepEqual(computeChangedSectionsSinceRead(file, st), []);
  assert.deepEqual(computeChangedSectionsSinceRead(file, undefined), []);
  assert.deepEqual(
    computeChangedSectionsSinceRead(file, readState('rev_curr', 'rev_curr')),
    []
  );
});

test('章节指纹：contentCache 回退链生效（MD 正文未内联时按 revision_id 补）', () => {
  const file = twoVersionFile(BASELINE_TEXT, '# 标题\n第一段内容。\n\n## 章节 A\nA 改了。', {
    baselineContentLoaded: false,
    currentContentLoaded: false,
  });
  const st = readState('rev_base', 'rev_curr');
  const sections = computeChangedSectionsSinceRead(file, st, {
    rev_base: BASELINE_TEXT,
    rev_curr: '# 标题\n第一段内容。\n\n## 章节 A\nA 改了。',
  });
  // 章节 A 被改 + 章节 B 被整段删除（基线独有章节如实计入变更）
  assert.deepEqual(sections, ['章节 A', '章节 B']);
});
