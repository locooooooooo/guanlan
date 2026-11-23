/**
 * context-budget-01：Token 估算与预算条（方案 F0/F4；契约 B0/B7 冻结公式）。
 *
 * 向量单源 = native/testdata/token-vectors.json（git 内静态文件，与 Rust
 * include_str! 编译期读取同源；无 seed 依赖）。公式：
 *   est_tokens = ceil(cjk_chars*0.7 + non_cjk_bytes/3.5)
 * CJK 码位：U+3000–U+303F ∪ U+4E00–U+9FFF ∪ U+F900–U+FAFF ∪ U+FF01–U+FF5E。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  computeTokenBudget,
  CONTEXT_TOKEN_THRESHOLD,
  DECISIONS_ONLY_GRANULARITY_FACTOR,
  estimateItemTokens,
  estimateTokensFromText,
  formatBudgetLine,
  SUMMARY_GRANULARITY_FACTOR,
} from '../src/utils/contextBudget';

interface TokenVectorFile {
  vectors: Array<[string, number]>;
}

const vectorsPath = new URL('../native/testdata/token-vectors.json', import.meta.url);
const vectorFile = JSON.parse(readFileSync(vectorsPath, 'utf8')) as TokenVectorFile;

describe('estimateTokensFromText 与冻结向量逐条一致（双端同源）', () => {
  test('向量文件存在且非空（无 seed 依赖——git 内静态文件）', () => {
    assert.ok(vectorFile.vectors.length >= 20, `向量条数 ${vectorFile.vectors.length}`);
  });

  for (const [input, expected] of vectorFile.vectors) {
    test(`est(${JSON.stringify(input)}) = ${expected}`, () => {
      assert.equal(estimateTokensFromText(input), expected);
    });
  }

  test('码位边界：U+FF00/U+FF5F 不在区间（非 CJK 按字节）；U+FF01/U+FF5E 在区间', () => {
    // 3 字节 / 3.5 = 0.857 → 1（非 CJK 上界公式）
    assert.equal(estimateTokensFromText('\uFF00'), 1);
    assert.equal(estimateTokensFromText('\uFF5F'), 1);
    // 0.7 → ceil = 1（CJK）
    assert.equal(estimateTokensFromText('\uFF01'), 1);
    assert.equal(estimateTokensFromText('\uFF5E'), 1);
  });
});

describe('三档注入粒度因子与预算视图（PRD 4.2）', () => {
  const TEXT = 'Hello 世界'; // 6 non-cjk bytes + 2 cjk → ceil(6/3.5 + 1.4) = ceil(3.114) = 4

  test('全文 ×1 / 摘要 ×0.2（PRD「降低约 80%」）/ 仅决策 ×0.05（裁定值）', () => {
    assert.equal(SUMMARY_GRANULARITY_FACTOR, 0.2);
    assert.equal(DECISIONS_ONLY_GRANULARITY_FACTOR, 0.05);
    assert.equal(estimateItemTokens({ fileId: 'f', granularity: 'full', text: TEXT }), 4);
    assert.equal(estimateItemTokens({ fileId: 'f', granularity: 'summary', text: TEXT }), Math.ceil(4 * 0.2));
    assert.equal(
      estimateItemTokens({ fileId: 'f', granularity: 'decisions_only', text: TEXT }),
      Math.ceil(4 * 0.05)
    );
  });

  test('无正文按字节上界估算（sizeBytes/3.5）；体量未知按 0', () => {
    assert.equal(estimateItemTokens({ fileId: 'f', granularity: 'full', sizeBytes: 3500 }), 1000);
    assert.equal(estimateItemTokens({ fileId: 'f', granularity: 'full', sizeBytes: null }), 0);
    assert.equal(estimateItemTokens({ fileId: 'f', granularity: 'full' }), 0);
  });

  test('computeTokenBudget：阈值内不高亮；超阈值给确定性降级建议（体量降序、full 可降）', () => {
    const items = [
      { fileId: 'focus', granularity: 'full' as const, sizeBytes: 7000, downgradeEligible: false },
      { fileId: 'big', granularity: 'full' as const, sizeBytes: 35000 },
      { fileId: 'mid', granularity: 'full' as const, sizeBytes: 7000 },
      { fileId: 'small', granularity: 'summary' as const, sizeBytes: 35000 },
    ];
    // est: focus=2000, big=10000, mid=2000, small=2000*0.2=400 → 14400 ≤ 65536 → 不超
    const ok = computeTokenBudget(items);
    assert.equal(ok.overThreshold, false);
    assert.deepEqual(ok.downgradeSuggestions, []);

    const tight = computeTokenBudget(items, 10000);
    assert.equal(tight.overThreshold, true);
    // 降级贪婪序：big(10000) 先降 → 10000→2000，projected=6400 ≤ 10000 收口
    assert.deepEqual(tight.downgradeSuggestions, ['big']);
    assert.equal(tight.threshold, 10000);
    assert.equal(tight.selected, 4);
  });

  test('不可降级（eligible=false 或已摘要）条目耗尽后如实停止（不造假建议）', () => {
    const items = [
      { fileId: 'only', granularity: 'full' as const, sizeBytes: 350000, downgradeEligible: false },
    ];
    const view = computeTokenBudget(items, 1000);
    assert.equal(view.overThreshold, true);
    assert.deepEqual(view.downgradeSuggestions, []);
  });

  test('预算条文案（PRD 4.2 口径）', () => {
    assert.equal(
      formatBudgetLine({ selected: 4, estTokens: 18400, threshold: 65536, overThreshold: false, downgradeSuggestions: [] }),
      '已选 4 项 · 约 18.4k Tokens (推荐阈值 < 64k)'
    );
    assert.equal(
      formatBudgetLine({ selected: 2, estTokens: 900, threshold: CONTEXT_TOKEN_THRESHOLD, overThreshold: false, downgradeSuggestions: [] }),
      '已选 2 项 · 约 900 Tokens (推荐阈值 < 64k)'
    );
  });
});
