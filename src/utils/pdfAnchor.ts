/**
 * PDF（`.pdf#page=N`）页码证据锚点解析、标签格式化与跳转辅助纯函数。
 * 与 `officeAnchor.ts` 同构：fragment 语义与 Rust `derive.rs::parse_pdf_fragment` 同源。
 */

import type { DecisionAssertion, DecisionSourceEvidence, PdfEvidenceAnchor } from '../types/guanlan';
import { normalizeRelativeWorkspacePath } from './officeAnchor';

export interface ParsedPdfHref {
  /** 去掉 `#fragment` 后的路径部分 */
  pathWithoutFragment: string;
  /** 若链接指向受支持的 `.pdf#page=N`，返回页码锚点 */
  anchor?: PdfEvidenceAnchor;
}

/**
 * 解析 PDF 页码 fragment（1-based）。
 * 兼容：`page=14` / `page:14` / `p=14` / `p.14` / 纯数字 `14`，
 * 以及 RFC 3778 参数拼接（取首个可解析页码，如 `page=14&view=FitH`）。
 */
function parsePdfPageToken(fragment: string): number | null {
  const frag = fragment.trim();
  if (!frag) return null;
  for (const part of frag.split('&')) {
    const lower = part.trim().toLowerCase();
    let numStr: string | null = null;
    if (lower.startsWith('page=')) numStr = lower.slice(5);
    else if (lower.startsWith('page:')) numStr = lower.slice(5);
    else if (lower.startsWith('p=')) numStr = lower.slice(2);
    else if (lower.startsWith('p.')) numStr = lower.slice(2);
    else if (/^\d+$/.test(lower)) numStr = lower;
    if (numStr !== null) {
      const n = Number(numStr.trim());
      if (Number.isSafeInteger(n) && n > 0) return n;
    }
  }
  return null;
}

/** 从 Markdown 链接 href 中提取路径与可选 PDF 页码锚点（与 Rust `derive.rs` 同源） */
export function parsePdfLinkHref(hrefRaw: string): ParsedPdfHref {
  let decoded = hrefRaw.trim();
  if (decoded.startsWith('<') && decoded.endsWith('>') && decoded.length >= 2) {
    decoded = decoded.slice(1, -1).trim();
  }
  try {
    if (decoded.includes('%')) decoded = decodeURIComponent(decoded);
  } catch {
    /* 保留原串 */
  }
  const hashIdx = decoded.indexOf('#');
  if (hashIdx < 0) {
    return { pathWithoutFragment: decoded };
  }
  const pathWithoutFragment = decoded.slice(0, hashIdx).trim();
  const fragment = decoded.slice(hashIdx + 1).trim();
  if (!fragment) {
    return { pathWithoutFragment };
  }

  const extMatch = /\.([a-z0-9]+)$/i.exec(pathWithoutFragment);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  if (ext !== 'pdf') {
    return { pathWithoutFragment };
  }
  const page = parsePdfPageToken(fragment);
  if (page === null) {
    return { pathWithoutFragment };
  }
  return {
    pathWithoutFragment,
    anchor: { kind: 'pdf_page', page },
  };
}

/** 将 Markdown 链接 href（支持 `../specs/spec.pdf#page=2`）解析为文件与可选 PDF 锚点 */
export function resolveMarkdownFileTargetPdf<T extends { relative_path: string }>(
  hrefRaw: string,
  sourceFilePath: string,
  files: T[]
): { file: T; anchor?: PdfEvidenceAnchor } | null {
  const parsed = parsePdfLinkHref(hrefRaw);
  const rawPath = parsed.pathWithoutFragment.replace(/\\/g, '/');
  if (!rawPath) return null;

  const normalized = normalizeRelativeWorkspacePath(sourceFilePath, rawPath);
  const file =
    (normalized && files.find((f) => f.relative_path.replace(/\\/g, '/') === normalized)) ||
    files.find((f) => {
      const rp = f.relative_path.replace(/\\/g, '/');
      return rp === rawPath || rp.endsWith(rawPath) || (normalized && rp.endsWith(normalized));
    }) ||
    null;
  if (!file) return null;
  return { file, anchor: parsed.anchor };
}

/** 构造指向指定页码的 Markdown 引用（如 `规范.pdf#page=14`） */
export function buildPdfHref(path: string, page: number): string {
  const cleanPath = path.trim().replace(/\\/g, '/');
  return `${cleanPath}#page=${page}`;
}

/** 格式化 PDF 锚点标签，如 `第 14 页` 或 `第 14 页 · 第三章 冻结窗口` */
export function formatPdfAnchorLabel(anchor: PdfEvidenceAnchor | null | undefined): string {
  if (!anchor) return '';
  if (anchor.heading) return `第 ${anchor.page} 页 · ${anchor.heading}`;
  return `第 ${anchor.page} 页`;
}

/** 返回决策中携带 PDF 页码锚点的全部证据（优先顺序保持） */
export function findPdfEvidences(
  decision: Pick<DecisionAssertion, 'evidences'>
): DecisionSourceEvidence[] {
  return decision.evidences.filter((ev) => Boolean(ev.pdfAnchor));
}

/** 选出决策最优先跳转的 PDF 锚点证据（首条携带 pdfAnchor 的证据） */
export function pickPrimaryPdfEvidence(
  decision: Pick<DecisionAssertion, 'evidences'>
): DecisionSourceEvidence | undefined {
  return decision.evidences.find((ev) => Boolean(ev.pdfAnchor));
}
