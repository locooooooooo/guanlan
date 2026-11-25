/**
 * DerivedSummary 缓存与发布粒度验收测试：
 * - 派生摘要按版本身份缓存：同版同内容引用复用（不再全量重解析）；
 * - 「未加载 → 已加载」状态跃迁触发一次重算，此后复用；
 * - 新版本 = 新条目；缓存 LRU 容量生效；
 * - extractCoreSummary 各格式（md/svg/pdf）口径不因缓存改变（回归）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearDerivedSummaryCacheForTest,
  derivedSummaryCacheStatsForTest,
  extractCoreSummary,
  groupFilesIntoPackages,
} from '../src/utils/taskPackages';
import type { FileRecord, Revision } from '../src/types/guanlan';

let seq = 0;
function revision(over: Partial<Revision> & Pick<Revision, 'revision_id'>): Revision {
  seq += 1;
  return {
    file_id: 'f_ds30',
    versionNumber: seq,
    content_sha256: `sha-${over.revision_id}`,
    observed_at: '2026-11-17T10:00:00+08:00',
    sizeBytes: 100,
    snapshotAvailable: true,
    summaryNote: 'v1 · 元数据串',
    ...over,
  };
}

function fileOf(revisions: Revision[], currentId?: string, format: FileRecord['format'] = 'md'): FileRecord {
  return {
    file_id: 'f_ds30',
    relative_path: '01-方案文档/摘要缓存.md',
    title: '摘要缓存',
    format,
    folder: '01-方案文档',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: currentId ?? revisions[revisions.length - 1].revision_id,
    revisions,
    coverage: 'full_text',
  };
}

const CONTENT_A = '# 核心结论\n采用方案 B，两周内落地。\n\n## 背景\n背景正文。';
const CONTENT_B = '# 核心结论\n改用方案 C。\n\n## 背景\n新背景。';

test('#30 同版同内容引用：重复调用命中缓存（不重复解析，条目数不变）', () => {
  clearDerivedSummaryCacheForTest();
  const rev = revision({ revision_id: 'rev_a', markdownContent: CONTENT_A });
  const file = fileOf([rev]);

  const first = extractCoreSummary(file);
  assert.equal(first.includes('方案 B'), true, '从核心结论章节摘取');
  const entriesAfterFirst = derivedSummaryCacheStatsForTest();
  assert.equal(entriesAfterFirst, 1);

  // 同一字符串实例反复调用（模拟每次发布/画布卡片/任务包分组各自调用一次）
  for (let i = 0; i < 5; i++) {
    assert.equal(extractCoreSummary(file), first, '缓存命中返回同一产物');
  }
  assert.equal(derivedSummaryCacheStatsForTest(), 1, '不新增条目');
});

test('#30 未加载 → 已加载跃迁：正文到达触发一次重算，此后复用', () => {
  clearDerivedSummaryCacheForTest();
  const rev = revision({ revision_id: 'rev_b' }); // 未加载：无 markdownContent
  const file = fileOf([rev]);
  const unloaded = extractCoreSummary(file);
  assert.equal(unloaded.includes('元数据'), false, 'summaryNote 元数据串被 condense 治理');

  // 正文补齐（revisionContentStore 返回的新字符串实例）
  const loadedRev = revision({ revision_id: 'rev_b', markdownContent: CONTENT_A });
  const loaded = extractCoreSummary(fileOf([loadedRev]));
  assert.equal(loaded.includes('方案 B'), true, '正文到达后从真实内容摘取');

  // 此后复用（同引用）
  assert.equal(extractCoreSummary(fileOf([loadedRev])), loaded);
  assert.equal(derivedSummaryCacheStatsForTest(), 1, '同版只占一个条目');
});

test('#30 新版本 = 新条目；旧版条目保留（LRU 内）', () => {
  clearDerivedSummaryCacheForTest();
  const r1 = revision({ revision_id: 'rev_v1', markdownContent: CONTENT_A });
  const r2 = revision({ revision_id: 'rev_v2', markdownContent: CONTENT_B });
  const s1 = extractCoreSummary(fileOf([r1]));
  const s2 = extractCoreSummary(fileOf([r1, r2], 'rev_v2'));
  assert.equal(s1.includes('方案 B'), true);
  assert.equal(s2.includes('方案 C'), true, '新版本按新内容摘取');
  assert.equal(derivedSummaryCacheStatsForTest(), 2);

  // 回滚到 v1（A→B→A 场景）：命中既有条目
  assert.equal(extractCoreSummary(fileOf([r1, r2], 'rev_v1')), s1);
  assert.equal(derivedSummaryCacheStatsForTest(), 2);
});

test('#30 内容变化（同版不同字符串实例，如 detail 重并入）触发重算且产物一致', () => {
  clearDerivedSummaryCacheForTest();
  const rev = revision({ revision_id: 'rev_c', markdownContent: CONTENT_A });
  const file = fileOf([rev]);
  const first = extractCoreSummary(file);

  // 同内容的新字符串实例（detail 重并入路径会产生新实例；slice 断开 V8 驻留）
  const revReloaded = revision({ revision_id: 'rev_c', markdownContent: CONTENT_A.slice() });
  const second = extractCoreSummary(fileOf([revReloaded]));
  assert.equal(second, first, '同内容派生结果一致（重算一次后归一）');
});

test('#30 各格式口径回归：svg 抽取文本 / pdf 首页文字 不因缓存改变', () => {
  clearDerivedSummaryCacheForTest();
  const svgRev = revision({
    revision_id: 'rev_svg',
    svgExtractedTexts: ['标注一', '标注二', '标注三', '标注四'],
  });
  const svgFile = fileOf([svgRev], undefined, 'svg');
  const svgSummary = extractCoreSummary(svgFile);
  assert.equal(svgSummary.includes('标注一'), true);
  assert.equal(extractCoreSummary(svgFile), svgSummary, 'svg 缓存命中');

  const pdfRev = revision({
    revision_id: 'rev_pdf',
    pdfPages: [{ pageNumber: 1, heading: '首页', extractedText: '验收条款第一条', visualSummary: '' }],
  });
  const pdfFile: FileRecord = {
    ...fileOf([pdfRev], undefined, 'pdf'),
    pdfStatusReason: '正文尚未索引，当前仅文件名与元数据可检索（阅读器可打开原文件预览）',
  };
  const pdfSummary = extractCoreSummary(pdfFile);
  assert.equal(pdfSummary.includes('验收条款'), true, 'pdf 取首页抽取文字');
  assert.equal(extractCoreSummary(pdfFile), pdfSummary, 'pdf 缓存命中');
});

test('#30 单文件正文变化只重算该文件派生结果，分组其余文件复用（集成口径）', () => {
  clearDerivedSummaryCacheForTest();
  const mk = (id: string, path: string, content: string): FileRecord => {
    const rev = revision({ revision_id: `rev_${id}`, markdownContent: content });
    return { ...fileOf([rev]), file_id: id, relative_path: path, current_revision_id: rev.revision_id };
  };
  const a = mk('f_a', '01-方案文档/a.md', CONTENT_A);
  const b = mk('f_b', '01-方案文档/b.md', CONTENT_B);

  // 第一次发布：全量解析（缓存冷）
  groupFilesIntoPackages([a, b]);
  const entriesAfterFirst = derivedSummaryCacheStatsForTest();
  assert.equal(entriesAfterFirst, 2, '两文件各占一个条目');

  // 单文件正文补齐 = 新版本（rev_f_b_r2）：分组重跑时 a 复用缓存，只新增 b 的条目
  const rev = revision({ revision_id: 'rev_f_b_r2', markdownContent: '# 核心结论\nB 的最新结论。\n\n## 背景\nx。' });
  const bReloaded: FileRecord = { ...b, revisions: [...b.revisions, rev], current_revision_id: rev.revision_id };
  groupFilesIntoPackages([a, bReloaded]);
  assert.equal(derivedSummaryCacheStatsForTest(), entriesAfterFirst + 1, '只新增 b 的条目');
});
