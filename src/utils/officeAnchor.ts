/**
 * Office（`.docx` / `.xlsx`）证据锚点解析、单元格区间命中与跳转辅助纯函数。
 */

import type { DecisionAssertion, DecisionSourceEvidence, OfficeEvidenceAnchor } from '../types/guanlan';
import { isStructuredOfficeFormat } from './formatMeta';

export interface ParsedOfficeHref {
  /** 去掉 `#fragment` 后的路径部分 */
  pathWithoutFragment: string;
  /** 若链接指向受支持的 `.xlsx#Sheet!Range` 或 `.docx#para=N`，返回结构化锚点 */
  anchor?: OfficeEvidenceAnchor;
}

export interface CellRangeBounds {
  startCol: number;
  endCol: number;
  startRow: number;
  endRow: number;
}

/** 将 1-based 列序号转为 Excel 列字母（1 -> A, 27 -> AA） */
export function colIdxToLetters(col: number): string {
  if (!Number.isSafeInteger(col) || col <= 0) return 'A';
  let n = col;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 根据起止坐标（1-based col, row）生成规范化 Range（如 `B2:C5` 或单格 `B2`） */
export function buildCellRangeFromCoords(
  a: { col: number; row: number },
  b?: { col: number; row: number }
): string {
  const end = b ?? a;
  const startCol = Math.min(a.col, end.col);
  const endCol = Math.max(a.col, end.col);
  const startRow = Math.min(a.row, end.row);
  const endRow = Math.max(a.row, end.row);
  const startRef = `${colIdxToLetters(startCol)}${startRow}`;
  const endRef = `${colIdxToLetters(endCol)}${endRow}`;
  return startRef === endRef ? startRef : `${startRef}:${endRef}`;
}

/** 将相对链接路径相对于当前源文件所在目录标准化为工作区正斜杠路径 */
export function normalizeRelativeWorkspacePath(
  sourceFilePath: string,
  targetHrefPath: string
): string {
  const cleanTarget = targetHrefPath.trim().replace(/\\/g, '/');
  if (!cleanTarget) return '';
  if (cleanTarget.startsWith('/')) {
    return cleanTarget.replace(/^\/+/, '');
  }
  const normalizedSource = sourceFilePath.replace(/\\/g, '/');
  const slashIdx = normalizedSource.lastIndexOf('/');
  const baseParts =
    slashIdx >= 0 ? normalizedSource.slice(0, slashIdx).split('/').filter(Boolean) : [];
  for (const seg of cleanTarget.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      baseParts.pop();
    } else {
      baseParts.push(seg);
    }
  }
  return baseParts.join('/');
}

/** 将 Markdown 链接 href（支持 `../specs/bom.xlsx#BOM!B2:B3` 与 `.docx#para=2`）解析为文件与可选 Office 锚点 */
export function resolveMarkdownFileTarget<T extends { relative_path: string }>(
  hrefRaw: string,
  sourceFilePath: string,
  files: T[]
): { file: T; anchor?: OfficeEvidenceAnchor } | null {
  const parsed = parseOfficeLinkHref(hrefRaw);
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

/** 将 Excel 列字母 + 行号（如 `$AB$12`）解析为 1-based `(col, row)` */
export function parseCellRef(raw: string): { col: number; row: number } | null {
  const clean = raw.trim().replace(/\$/g, '').toUpperCase();
  if (!clean) return null;
  const match = /^([A-Z]+)(\d+)$/.exec(clean);
  if (!match) return null;
  const letters = match[1];
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row <= 0) return null;
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col > 0 ? { col, row } : null;
}

/** 解析单元格范围（如 `B2:C10` 或单格 `C3`）为闭合矩形边界 */
export function parseXlsxRangeBounds(cellRange: string | null | undefined): CellRangeBounds | null {
  if (!cellRange) return null;
  const clean = cellRange.trim().replace(/\$/g, '').toUpperCase();
  if (!clean) return null;
  const parts = clean.split(':');
  if (parts.length > 2) return null;
  const first = parseCellRef(parts[0]);
  if (!first) return null;
  const second = parts[1] ? parseCellRef(parts[1]) : first;
  if (!second) return null;
  return {
    startCol: Math.min(first.col, second.col),
    endCol: Math.max(first.col, second.col),
    startRow: Math.min(first.row, second.row),
    endRow: Math.max(first.row, second.row),
  };
}

/** 判断单元格坐标 `(colIdx, rowNum)` 是否落在目标区间内 */
export function isCellInRange(
  colIdx: number,
  rowNum: number,
  bounds: CellRangeBounds | null
): boolean {
  if (!bounds) return false;
  return (
    colIdx >= bounds.startCol &&
    colIdx <= bounds.endCol &&
    rowNum >= bounds.startRow &&
    rowNum <= bounds.endRow
  );
}

/** 从 Markdown 链接 href 中提取路径与可选的 Office 锚点（与 Rust `derive.rs` 同源） */
export function parseOfficeLinkHref(hrefRaw: string): ParsedOfficeHref {
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
  if (!isStructuredOfficeFormat(ext)) {
    return { pathWithoutFragment };
  }

  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xltx') {
    const bangIdx = fragment.indexOf('!');
    const sheet = bangIdx >= 0 ? fragment.slice(0, bangIdx).trim().replace(/^'+|'+$/g, '') : '';
    const rangeRaw = bangIdx >= 0 ? fragment.slice(bangIdx + 1).trim() : fragment;
    const normalizedRange = rangeRaw.replace(/\$/g, '').toUpperCase();
    if (!parseXlsxRangeBounds(normalizedRange)) {
      return { pathWithoutFragment };
    }
    return {
      pathWithoutFragment,
      anchor: {
        kind: 'xlsx_range',
        ...(sheet ? { sheet } : {}),
        cellRange: normalizedRange,
      },
    };
  }

  // .docx / .docm / .dotx
  const paraToken = fragment
    .replace(/^para[:=]/i, '')
    .replace(/^p=/i, '')
    .trim();
  const paraNum = Number(paraToken);
  if (Number.isSafeInteger(paraNum) && paraNum > 0) {
    return {
      pathWithoutFragment,
      anchor: {
        kind: 'docx_paragraph',
        paragraph: paraNum,
      },
    };
  }
  return { pathWithoutFragment };
}

/** 格式化 Office 锚点标签，如 `BOM!C2:C3` 或 `第 4 段` */
export function formatOfficeAnchorLabel(anchor: OfficeEvidenceAnchor | null | undefined): string {
  if (!anchor) return '';
  if (anchor.kind === 'xlsx_range') {
    if (anchor.sheet && anchor.cellRange) return `${anchor.sheet}!${anchor.cellRange}`;
    return anchor.cellRange || anchor.sheet || '表格选区';
  }
  if (anchor.kind === 'docx_paragraph') {
    if (anchor.paragraph && anchor.heading) {
      return `第 ${anchor.paragraph} 段 · ${anchor.heading}`;
    }
    if (anchor.paragraph) return `第 ${anchor.paragraph} 段`;
    return anchor.heading || '文档段落';
  }
  return '';
}

/** 返回决策中携带 Office 锚点的全部证据（优先顺序保持） */
export function findOfficeEvidences(decision: Pick<DecisionAssertion, 'evidences'>): DecisionSourceEvidence[] {
  return decision.evidences.filter((ev) => Boolean(ev.officeAnchor));
}

/** 选出决策最优先跳转的证据（含 Office 锚点时，若首条本身已是 Office 证据直接走首条；
 *  若来自 Markdown 显式链接，保留 `evidences[0]` 为原文且可用此函数直跳关联 Office 证据） */
export function pickPrimaryOfficeEvidence(
  decision: Pick<DecisionAssertion, 'evidences'>
): DecisionSourceEvidence | undefined {
  return decision.evidences.find((ev) => Boolean(ev.officeAnchor));
}
