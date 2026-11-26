
import type { FileRecord, OfficeEvidenceAnchor, PdfEvidenceAnchor } from '../../types/guanlan';
import { parseOfficeLinkHref, resolveMarkdownFileTarget } from '../../utils/officeAnchor';
import { parsePdfLinkHref, resolveMarkdownFileTargetPdf } from '../../utils/pdfAnchor';
import type { StageRole } from '../../utils/taskPackages';

/** 五阶段 Stepper 文案（short 为步点短标签，full 为完整阶段名）。 */
export const STAGE_STEPS: ReadonlyArray<{ role: StageRole; short: string; full: string }> = [
  { role: '蓝图', short: '蓝图', full: '蓝图与需求' },
  { role: '计划', short: '计划', full: '计划与排期' },
  { role: '决策', short: '决策', full: '决策与卡点' },
  { role: '执行', short: '执行', full: '执行与轮次' },
  { role: '交付', short: '交付', full: '交付与复验' },
];

/** 把来源行滚到视口（章节定位与大纲点击共用同一条路径）。 */
export function scrollToSourceLine(line: number, block: ScrollLogicalPosition = 'start') {
  document.querySelector(`[data-event-source-line="${line}"]`)?.scrollIntoView({ block });
}

/**
 * 证据行定位「就近回退」确定性规则（纯函数，便于单测）。
 * 锚点粒度：围栏/表格整块只在起始行挂一个锚（wrapLine 的 codeStart/tableStart），
 * 因此围栏内部行、表格分隔行、空行都无锚点，但正文存在。
 * 目标行无锚点时：
 * ① 取目标行之前最近的已存在锚点（升序扫描取 ≤ 目标的最大行号）；
 * ② 之前没有任何锚点 → 取之后最近的锚点（> 目标的最小行号）；
 * ③ 全文件无锚点 → null（调用方不滚动、不出提示，绝不假装定位成功）。
 * 目标行自身有锚点时正常路径（querySelector 命中）先行，不会走到本函数；
 * 契约上仍返回该行自身，保证幂等。防御性排序：结果与传入顺序无关。
 */
export function pickNearestSourceLineAnchor(
  anchorLines: number[],
  targetLine: number
): number | null {
  if (anchorLines.length === 0) return null;
  const sorted = [...anchorLines].sort((a, b) => a - b);
  let before: number | null = null;
  let after: number | null = null;
  for (const line of sorted) {
    if (line <= targetLine) before = line;
    else if (after === null) after = line;
  }
  return before ?? after;
}

/**
 * 定位回退提示文案（中性）。
 * 围栏内部行正文存在，缺的只是「定位点」——措辞绝不出现「无正文」
 * （把定位缺失误诊为内容缺失），也不用「附近」等未量化词，行号一律写实。
 */
export function formatSourceLineFallbackNotice(
  targetLine: number,
  landedLine: number
): string {
  return `L${targetLine} 无对应定位点，已就近定位到 L${landedLine}`;
}

/**
 * 从已渲染 DOM 收集全部行号锚点（升序去重）。仅浏览器侧 effect 使用；
 * node 单测不经过此函数（无 DOM），决策逻辑收敛在 pickNearestSourceLineAnchor。
 */
export function collectRenderedSourceLineAnchors(root: {
  querySelectorAll: (selectors: string) => NodeListOf<Element>;
}): number[] {
  const seen = new Set<number>();
  root.querySelectorAll('[data-event-source-line]').forEach((el) => {
    const raw = el.getAttribute('data-event-source-line');
    if (raw === null) return;
    const line = Number(raw);
    if (Number.isInteger(line) && line > 0) seen.add(line);
  });
  return Array.from(seen).sort((a, b) => a - b);
}


/**
 * 链接解析索引（useMemo(files) 构建）：记录 relative_path → 首个精确匹配
 * 的文件与序次，并缓存 href → 解析结果。保持按 files 顺序取首个精确或后缀命中的语义。
 */
export interface MarkdownLinkIndex {
  files: FileRecord[];
  sourceFilePath: string;
  exactPath: Map<string, FileRecord>;
  firstExactIdx: Map<string, number>;
  resolveCache: Map<
    string,
    { file: FileRecord; officeAnchor?: OfficeEvidenceAnchor; pdfAnchor?: PdfEvidenceAnchor } | null
  >;
}

/**
 * href 解析：按 files 顺序匹配精确路径或后缀路径。
 * 若链接携带 `#Sheet!Range` / `#para=N` 或 `../` 相对片段，在保留无锚点路径
 * 原有匹配语义的前提下，额外解析目标文件与 `officeAnchor`。
 */
export function resolveMarkdownHref(
  href: string,
  index: MarkdownLinkIndex
): { file: FileRecord; officeAnchor?: OfficeEvidenceAnchor; pdfAnchor?: PdfEvidenceAnchor } | null {
  const cached = index.resolveCache.get(href);
  if (cached !== undefined) return cached;

  const parsed = parseOfficeLinkHref(href);
  const pathPart = parsed.pathWithoutFragment;
  const lookup = pathPart || href;

  const exactIdx = index.firstExactIdx.get(lookup);
  let resolvedFile: FileRecord | null;
  if (exactIdx === undefined) {
    resolvedFile = index.files.find((f) => f.relative_path.endsWith(lookup)) ?? null;
  } else {
    const exactHit = index.exactPath.get(lookup);
    resolvedFile = exactHit ?? null;
    for (let k = 0; k < exactIdx; k++) {
      if (index.files[k].relative_path.endsWith(lookup)) {
        resolvedFile = index.files[k];
        break;
      }
    }
  }

  const pdfParsed = parsed.anchor ? null : parsePdfLinkHref(href);

  let out: {
    file: FileRecord;
    officeAnchor?: OfficeEvidenceAnchor;
    pdfAnchor?: PdfEvidenceAnchor;
  } | null = resolvedFile
    ? {
        file: resolvedFile,
        officeAnchor: parsed.anchor,
        pdfAnchor: pdfParsed?.anchor,
      }
    : null;

  if (!out && (href.includes('/') || href.includes('#'))) {
    const relHit = resolveMarkdownFileTarget(href, index.sourceFilePath, index.files);
    if (relHit) {
      out = { file: relHit.file, officeAnchor: relHit.anchor ?? parsed.anchor };
    } else {
      const relPdf = resolveMarkdownFileTargetPdf(href, index.sourceFilePath, index.files);
      if (relPdf) {
        out = { file: relPdf.file, pdfAnchor: relPdf.anchor ?? pdfParsed?.anchor };
      }
    }
  }

  index.resolveCache.set(href, out);
  return out;
}

/** 行内 **bold** / `code` 预切分令牌：at 为令牌在片段内的偏移（用于生成稳定 React key）。 */
export type InlineToken =
  | { kind: 'plain'; text: string }
  | { kind: 'bold'; text: string; at: number }
  | { kind: 'code'; text: string; at: number };

/** 行内格式化模型期：纯切分，不构建 React 元素。 */
export function tokenizeInline(textSegment: string): InlineToken[] {
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  const tokens: InlineToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(textSegment)) !== null) {
    if (m.index > last) {
      tokens.push({ kind: 'plain', text: textSegment.slice(last, m.index) });
    }
    const token = m[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push({ kind: 'bold', text: token.slice(2, -2), at: m.index });
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push({ kind: 'code', text: token.slice(1, -1), at: m.index });
    }
    last = m.index + token.length;
  }
  if (last < textSegment.length) {
    tokens.push({ kind: 'plain', text: textSegment.slice(last) });
  }
  return tokens;
}

/**
 * 一行文本的渲染分段：链接目标已在模型期解析完（target 供渲染期建导航闭包）；
 * inline 段存预切分令牌，key 方案保持稳定（seg-{偏移}/seg-end/seg-all、{href}-{偏移}）。
 */
export type LinkPart =
  | { kind: 'inline'; key: string; text: string; tokens: InlineToken[] }
  | {
      kind: 'link';
      key: string;
      label: string;
      href: string;
      target: FileRecord | null;
      officeAnchor?: OfficeEvidenceAnchor;
      pdfAnchor?: PdfEvidenceAnchor;
    };

/** 链接行渲染的模型期：正则切分链接并解析目标文件。 */
export function buildLinkParts(lineText: string, index: MarkdownLinkIndex): LinkPart[] {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts: LinkPart[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(lineText)) !== null) {
    if (match.index > lastIdx) {
      const segText = lineText.slice(lastIdx, match.index);
      parts.push({
        kind: 'inline',
        key: `seg-${match.index}`,
        text: segText,
        tokens: tokenizeInline(segText),
      });
    }
    const label = match[1];
    const href = match[2];
    const resolved = resolveMarkdownHref(href, index);
    parts.push({
      kind: 'link',
      key: `${href}-${match.index}`,
      label,
      href,
      target: resolved?.file ?? null,
      officeAnchor: resolved?.officeAnchor,
      pdfAnchor: resolved?.pdfAnchor,
    });
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < lineText.length) {
    const segText = lineText.slice(lastIdx);
    parts.push({
      kind: 'inline',
      key: 'seg-end',
      text: segText,
      tokens: tokenizeInline(segText),
    });
  }
  if (parts.length === 0) {
    parts.push({
      kind: 'inline',
      key: 'seg-all',
      text: lineText,
      tokens: tokenizeInline(lineText),
    });
  }
  return parts;
}

/**
 * 行模型：块粒度与旧解析循环一一对应。line=块起始行（wrapLine 的
 * data-event-source-line 锚点行）；excerpt=「+引用此段」按钮的摘录文案
 * （与旧 wrapLine 第三参逐字一致；h1/hr 无摘录）。
 */
export type MarkdownBlock =
  | { kind: 'code'; line: number; text: string; excerpt: string }
  | {
      kind: 'table';
      line: number;
      headerCells: string[];
      rows: Array<{ line: number; cells: LinkPart[][] }>;
      excerpt: string;
    }
  | { kind: 'h1'; line: number; title: string }
  | { kind: 'h2'; line: number; title: string; excerpt: string }
  | { kind: 'h3'; line: number; title: string; excerpt: string }
  | { kind: 'task'; line: number; checked: boolean; text: string; parts: LinkPart[]; excerpt: string }
  | { kind: 'quote'; line: number; parts: LinkPart[]; excerpt: string }
  | { kind: 'hr'; line: number }
  | { kind: 'ul'; line: number; parts: LinkPart[]; excerpt: string }
  | { kind: 'ol'; line: number; marker: string; parts: LinkPart[]; excerpt: string }
  | { kind: 'p'; line: number; parts: LinkPart[]; excerpt: string };

/**
 * markdownContent → 行模型（纯函数）：按块切分围栏代码块、表格（滤除分隔行）、
 * 空行、各级标题、任务项、引用、分隔线、列表与段落，只输出纯数据结构。
 */
export function buildMarkdownBlocks(
  markdownContent: string,
  linkIndex: MarkdownLinkIndex
): MarkdownBlock[] {
  const rawLines = (markdownContent || '').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const codeStart = lineNum;
      const codeLines: string[] = [];
      i++;
      while (i < rawLines.length && !rawLines[i].trim().startsWith('```')) {
        codeLines.push(rawLines[i]);
        i++;
      }
      i++;
      blocks.push({
        kind: 'code',
        line: codeStart,
        text: codeLines.join('\n'),
        excerpt: codeLines.join(' '),
      });
      continue;
    }

    if (trimmed.startsWith('|')) {
      const tableStart = lineNum;
      const tableRawRows: string[] = [];
      while (i < rawLines.length && rawLines[i].trim().startsWith('|')) {
        tableRawRows.push(rawLines[i].trim());
        i++;
      }
      const parsedRows = tableRawRows
        .filter((r) => !/^\|[\s\-:|]+\|$/.test(r))
        .map((r) =>
          r
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim())
        );
      const headerCells = parsedRows[0] || [];
      const bodyRows = parsedRows.slice(1);
      const rowLines = tableRawRows
        .map((text, rowIdx) => ({ text, line: tableStart + rowIdx }))
        .filter((row) => !/^\|[\s\-:|]+\|$/.test(row.text))
        .slice(1);

      blocks.push({
        kind: 'table',
        line: tableStart,
        headerCells,
        rows: bodyRows.map((row, rIdx) => ({
          line: rowLines[rIdx].line,
          cells: row.map((cell) => buildLinkParts(cell, linkIndex)),
        })),
        excerpt: tableRawRows.join(' '),
      });
      continue;
    }

    if (!trimmed) {
      i++;
      continue;
    }

    if (trimmed.startsWith('# ')) {
      blocks.push({ kind: 'h1', line: lineNum, title: trimmed.slice(2) });
      i++;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      const titleText = trimmed.slice(3);
      blocks.push({ kind: 'h2', line: lineNum, title: titleText, excerpt: titleText });
      i++;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      const titleText = trimmed.slice(4);
      blocks.push({ kind: 'h3', line: lineNum, title: titleText, excerpt: titleText });
      i++;
      continue;
    }

    if (trimmed.startsWith('- [x] ') || trimmed.startsWith('- [ ] ')) {
      const textContent = trimmed.slice(6);
      blocks.push({
        kind: 'task',
        line: lineNum,
        checked: trimmed.startsWith('- [x] '),
        text: textContent,
        parts: buildLinkParts(textContent, linkIndex),
        excerpt: textContent,
      });
      i++;
      continue;
    }

    if (trimmed.startsWith('> ')) {
      const quoteText = trimmed.slice(2);
      blocks.push({
        kind: 'quote',
        line: lineNum,
        parts: buildLinkParts(quoteText, linkIndex),
        excerpt: quoteText,
      });
      i++;
      continue;
    }

    if (trimmed === '---') {
      blocks.push({ kind: 'hr', line: lineNum });
      i++;
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const itemText = trimmed.slice(2);
      blocks.push({
        kind: 'ul',
        line: lineNum,
        parts: buildLinkParts(itemText, linkIndex),
        excerpt: itemText,
      });
      i++;
      continue;
    }

    const orderedMatch = /^(\d+)\. (.+)$/.exec(trimmed);
    if (orderedMatch) {
      blocks.push({
        kind: 'ol',
        line: lineNum,
        marker: orderedMatch[1],
        parts: buildLinkParts(orderedMatch[2], linkIndex),
        excerpt: orderedMatch[2],
      });
      i++;
      continue;
    }

    blocks.push({
      kind: 'p',
      line: lineNum,
      parts: buildLinkParts(line, linkIndex),
      excerpt: trimmed,
    });
    i++;
  }

  return blocks;
}

