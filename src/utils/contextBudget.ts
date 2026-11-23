/**
 * 证道阁上下文预算 · Token 估算与预算条（方案 F0/F4；契约 B0/B7 冻结公式）。
 *
 * 双端公式逐字（向量单源 native/testdata/token-vectors.json，TS 测试
 * test/context-budget-01.test.ts 用 fs.readFileSync 读，Rust include_str! 编译期读）：
 *   est_tokens = ceil(cjk_chars * 0.7 + non_cjk_bytes / 3.5)
 * CJK 码位写死：U+3000–U+303F ∪ U+4E00–U+9FFF ∪ U+F900–U+FAFF ∪ U+FF01–U+FF5E。
 * 估算为启发式（±20% 级）——阈值判定（<64k）双端同公式即满足 AC，不冒充精确值。
 *
 * 三档注入粒度（PRD 4.2）：全文（×1）/ 核心摘要与大纲（×0.2，PRD「Token 消耗
 * 降低约 80%」）/ 仅决策与契约（×0.05，裁定值——PRD 未给数字）。
 * 无正文可估时按 UTF-8 字节数 / 3.5 取上界（纯 ASCII 形态），粒度因子照乘。
 */

import type { ContextGranularity } from '../services/apiTypes';

/** 推荐阈值（PRD 4.2：<64k） */
export const CONTEXT_TOKEN_THRESHOLD = 65536;

/** 摘要档因子：PRD「Token 消耗降低约 80%」→ 0.2 */
export const SUMMARY_GRANULARITY_FACTOR = 0.2;
/** 仅变更 Diff 档因子（E03：相对全文约降 85%） */
export const DIFF_ONLY_GRANULARITY_FACTOR = 0.15;
/** 仅元数据路径档因子（E03：零正文仅路径+版本+哈希） */
export const METADATA_ONLY_GRANULARITY_FACTOR = 0.02;
/** 仅决策与契约档因子（裁定值：PRD 未给数字） */
export const DECISIONS_ONLY_GRANULARITY_FACTOR = 0.05;

const GRANULARITY_FACTOR: Record<ContextGranularity, number> = {
  full: 1,
  summary: SUMMARY_GRANULARITY_FACTOR,
  diff_only: DIFF_ONLY_GRANULARITY_FACTOR,
  metadata_only: METADATA_ONLY_GRANULARITY_FACTOR,
  decisions_only: DECISIONS_ONLY_GRANULARITY_FACTOR,
};

/** CJK 码位判定（四个区间，逐码点比对） */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff01 && cp <= 0xff5e)
  );
}

/** 非 CJK 字符的 UTF-8 字节数（按码点宽度；代理对 4 字节） */
function utf8ByteLength(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * 冻结公式估算（逐码点）：est_tokens = ceil(cjk_chars*0.7 + non_cjk_bytes/3.5)。
 * 与 token-vectors.json 向量、Rust state_machine.rs 估算逐字同源。
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  let nonCjkBytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) cjkChars += 1;
    else nonCjkBytes += utf8ByteLength(cp);
  }
  return Math.ceil(cjkChars * 0.7 + nonCjkBytes / 3.5);
}

/** 预算条输入项（证道阁每条已选资源） */
export interface BudgetItemInput {
  fileId: string;
  granularity: ContextGranularity;
  /** 正文可估（如抽屉内已有 excerpt/正文）时走精确公式 */
  text?: string | null;
  /** 无正文时按字节上界估算（当前版体量） */
  sizeBytes?: number | null;
  /** 降级候选：全文档才可降级为摘要（焦点文档亦可降，由调用方决定 eligibility） */
  downgradeEligible?: boolean;
}

export interface TokenBudgetView {
  /** 已选条数 */
  selected: number;
  /** E03：估算字符总数（在线态以服务端实算为准，离线按粒度因子估算） */
  estChars?: number;
  estTokens: number;
  threshold: number;
  overThreshold: boolean;
  /** 超阈值时的降级建议（file_id，按体量降序贪婪挑到低于阈值为止） */
  downgradeSuggestions: string[];
}

/** 单条资源的字符数估算（与 estTokens 联动展示实时字符/Token 预算） */
export function estimateItemChars(item: BudgetItemInput): number {
  const factor = GRANULARITY_FACTOR[item.granularity] ?? 1;
  const baseChars = item.text ? item.text.length : item.sizeBytes ? Math.ceil(item.sizeBytes * 0.65) : 0;
  return Math.ceil(baseChars * factor);
}

/** 单条资源的 Token 估算：有 text 走精确公式，否则 sizeBytes/3.5 上界；粒度因子照乘 */
export function estimateItemTokens(item: BudgetItemInput): number {
  const factor = GRANULARITY_FACTOR[item.granularity] ?? 1;
  const base =
    item.text
      ? estimateTokensFromText(item.text)
      : item.sizeBytes
        ? Math.ceil(item.sizeBytes / 3.5)
        : 0;
  return Math.ceil(base * factor);
}

/**
 * 预算视图（PRD 4.2：「已选 N 项 · 约 18.4k Tokens (推荐阈值 < 64k)」，超限高亮
 * 提示将背景文档降级为「核心摘要」）。降级建议确定性：按 base 估算体量降序，
 * 只挑 full 粒度且 downgradeEligible 的条目，逐个假想降级直到 estTokens ≤ 阈值
 * （或无可降条目停止）——纯函数，测试锁行为。
 */
export function computeTokenBudget(
  items: readonly BudgetItemInput[],
  threshold: number = CONTEXT_TOKEN_THRESHOLD
): TokenBudgetView {
  const estTokens = items.reduce((sum, it) => sum + estimateItemTokens(it), 0);
  const estChars = items.reduce((sum, it) => sum + estimateItemChars(it), 0);
  const overThreshold = estTokens > threshold;
  const downgradeSuggestions: string[] = [];
  if (overThreshold) {
    const candidates = items
      .map((it, idx) => ({ idx, it, base: estimateItemTokens(it) }))
      .filter(({ it }) => it.granularity === 'full' && it.downgradeEligible !== false)
      .sort((a, b) => b.base - a.base);
    let projected = estTokens;
    for (const cand of candidates) {
      if (projected <= threshold) break;
      const downgraded = Math.ceil(
        cand.base * GRANULARITY_FACTOR.summary
      );
      projected = projected - cand.base + downgraded;
      downgradeSuggestions.push(cand.it.fileId);
    }
  }
  return { selected: items.length, estChars, estTokens, threshold, overThreshold, downgradeSuggestions };
}

/** 预算条文案：「已选 4 项 · 约 18.4k Tokens (推荐阈值 < 64k)」——阈值 65536=64×1024（KiB 口径） */
export function formatBudgetLine(view: TokenBudgetView): string {
  const k = view.estTokens / 1000;
  const estText = k >= 1 ? `${k.toFixed(1)}k Tokens` : `${view.estTokens} Tokens`;
  return `已选 ${view.selected} 项 · 约 ${estText} (推荐阈值 < ${Math.round(view.threshold / 1024)}k)`;
}
