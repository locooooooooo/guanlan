/**
 * wf_2 信息降噪 · 摘要口径单测。
 *
 * 守住三件事（DoD2）：
 *  ① 摘要不得是文件属性串——不含 `9.1 KB`、不含 `01-方案文档/…` 路径、不含 `vN · 日期 · 元数据`；
 *  ② 有正文时取正文首段，去掉 markdown 标记，压成一行 ≤80 字，超出以「…」收口；
 *  ③ 拿不到正文时返回空串（由调用方显式占位「暂无正文摘要」），绝不拿文件属性冒充结论。
 *
 * 以及看板「5 阶段聚合胶囊」的唯一数据源 stageCountsOf。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  condenseSummary,
  extractCoreSummary,
  isFileMetadataText,
  stageCountsOf,
  SUMMARY_MAX_CHARS,
} from '../src/utils/taskPackages';
import type { PackageDoc, StageRole } from '../src/utils/taskPackages';
import type { FileRecord, Revision } from '../src/types/guanlan';

// ---------- fixtures ----------

function revision(
  over: Partial<Revision> & Pick<Revision, 'revision_id' | 'versionNumber' | 'observed_at'>
): Revision {
  return {
    file_id: 'f',
    content_sha256: 'hash',
    sizeBytes: 9318,
    snapshotAvailable: true,
    summaryNote: '',
    ...over,
  };
}

function file(
  over: Partial<FileRecord> & Pick<FileRecord, 'file_id' | 'relative_path'>
): FileRecord {
  return {
    title: '文档',
    format: 'md',
    folder: 'x',
    role: '其他',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'r1',
    revisions: [],
    coverage: 'filename_only',
    ...over,
  };
}

function doc(stage: StageRole, fileId: string): PackageDoc {
  return { fileId, title: `${fileId}.md`, format: 'md', stage, conclusion: '' };
}

/** 服务端 summaryNote 的真实拼装结果（server/project.ts:141-169），逐字。 */
const METADATA_SUMMARY =
  'v2 · 2026-11-12 13:03:13（文件修改时间） · 9.1 KB · 01-方案文档/README.md';

/** 三无断言：不含 KB 体量 / 不含 `/` 路径分隔 / 不是 `vN · 日期 · 元数据` 串。 */
function assertNoFileNoise(summary: string) {
  assert.ok(!/\d+(?:\.\d+)?\s?(?:KB|MB|GB)/i.test(summary), `摘要含 KB 体量：${summary}`);
  assert.ok(!summary.includes('/'), `摘要含路径分隔符：${summary}`);
  assert.ok(!/^v\d+\s*·/.test(summary), `摘要是 vN · 日期 · 元数据串：${summary}`);
}

// ---------- isFileMetadataText ----------

test('isFileMetadataText：服务端 summaryNote / PDF 未索引占位是文件属性，不是结论', () => {
  assert.equal(isFileMetadataText(METADATA_SUMMARY), true);
  assert.equal(isFileMetadataText('v1 · 2026-11-04（原文记载） · 4.5 KB · 01-方案文档/…'), true);
  assert.equal(isFileMetadataText('正文尚未索引，当前仅文件名与元数据可检索（阅读器可打开原文件预览）'), true);
  // 正文不受影响
  assert.equal(isFileMetadataText('本次验收通过，等待复验'), false);
  assert.equal(isFileMetadataText(''), false);
});

// ---------- condenseSummary ----------

test('condenseSummary：元数据串整体丢弃，返回空串（不截断成半截路径）', () => {
  assert.equal(condenseSummary(METADATA_SUMMARY), '');
  assertNoFileNoise(condenseSummary(METADATA_SUMMARY));
});

test('condenseSummary：去 markdown 标记（标题/加粗/链接地址/列表符）压成一行', () => {
  const raw = [
    '## 背景',
    '本文档定义**验收口径**与[契约](https://example.com/doc)，共 3 项。',
    '- 第一条要点：先验收再发布',
  ].join('\n');

  const out = condenseSummary(raw);
  assert.ok(!out.includes('#'), `残留标题井号：${out}`);
  assert.ok(!out.includes('**'), `残留加粗标记：${out}`);
  assert.ok(!out.includes(']('), `残留链接地址：${out}`);
  assert.ok(!out.includes('\n'), `未压成一行：${out}`);
  assert.ok(out.includes('验收口径'), `丢了正文：${out}`);
  assert.ok(out.includes('第一条要点'), `丢了列表正文：${out}`);
  assert.ok(!out.startsWith('-'), `行首列表符未去除：${out}`);
});

test('condenseSummary：正文里的体量数字被剥离（KB 不算摘要内容）', () => {
  const out = condenseSummary('本次快照 9.1 KB 已归档，等待复验');
  assert.ok(!/KB/i.test(out), `残留 KB：${out}`);
  assert.ok(out.includes('已归档'), `误删正文：${out}`);
});

test('condenseSummary：超过 80 字截断并以「…」收口', () => {
  const long = '验收'.repeat(120); // 240 字
  const out = condenseSummary(long);
  assert.equal(out.length, SUMMARY_MAX_CHARS + 1, '应为 80 字 + 省略号');
  assert.ok(out.endsWith('…'), `缺少省略号：${out}`);
});

// ---------- extractCoreSummary ----------

test('extractCoreSummary：脏 summaryNote 不得冒充结论（DoD2 三无断言）', () => {
  // md 但正文未内联（/scan 的常态）→ 只剩 summaryNote，必须判为噪音返回空串
  const noisy = file({
    file_id: 'f-noisy',
    relative_path: '01-方案文档/README.md',
    format: 'md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 2,
        observed_at: '2026-11-12T13:03:13+08:00',
        summaryNote: METADATA_SUMMARY,
      }),
    ],
  });
  const summary = extractCoreSummary(noisy);
  assert.equal(summary, '');
  assertNoFileNoise(summary);
});

test('extractCoreSummary：有正文时取正文首段，过 condense 后仍是三无文本', () => {
  const withBody = file({
    file_id: 'f-body',
    relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md',
    format: 'md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-12T10:00:00+08:00',
        summaryNote: METADATA_SUMMARY,
        markdownContent: [
          '# 需求单',
          '## 核心结论',
          '四专项需求核对完成，**结论**：先做 PDM 再看协同。',
        ].join('\n'),
      }),
    ],
  });
  const summary = extractCoreSummary(withBody);
  assert.ok(summary.includes('四专项需求核对完成'), `未取到核心结论段：${summary}`);
  assert.ok(!summary.includes('**'), `残留加粗标记：${summary}`);
  assertNoFileNoise(summary);
});

test('extractCoreSummary：PDF 未索引占位句 → 空串（状态句不是摘要）', () => {
  const pdf = file({
    file_id: 'f-pdf',
    relative_path: '调研/扫描件.pdf',
    format: 'pdf',
    current_revision_id: 'r1',
    pdfStatusReason: '正文尚未索引，当前仅文件名与元数据可检索（阅读器可打开原文件预览）',
    revisions: [
      revision({ revision_id: 'r1', versionNumber: 1, observed_at: '2026-11-12T09:00:00+08:00' }),
    ],
  });
  assert.equal(extractCoreSummary(pdf), '');
});

// ---------- stageCountsOf ----------

test('stageCountsOf：五阶段计数（蓝图 1 → 计划 1 → 决策 1 → 执行 8 → 交付 2）', () => {
  const docs = [
    doc('蓝图', 'a'),
    doc('计划', 'b'),
    doc('决策', 'c'),
    ...Array.from({ length: 8 }, (_, i) => doc('执行', `run-${i}`)),
    doc('交付', 'h1'),
    doc('交付', 'h2'),
    doc('待分类', 'z'),
  ];
  const counts = stageCountsOf(docs);
  assert.deepEqual(counts, {
    蓝图: 1,
    计划: 1,
    决策: 1,
    执行: 8,
    交付: 2,
    待分类: 1,
  });
  assert.deepEqual(stageCountsOf([]), {
    蓝图: 0,
    计划: 0,
    决策: 0,
    执行: 0,
    交付: 0,
    待分类: 0,
  });
});
