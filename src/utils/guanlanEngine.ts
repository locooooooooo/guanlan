import {
  CoverageKind,
  DecisionAssertion,
  EvidencePointer,
  FileFormat,
  FileRecord,
  MarkdownSection,
  McpErrorCode,
  McpToolName,
  ReadingState,
  RelationEdge,
  Revision,
  TimelineEvent,
  WorkspaceConfig,
} from '../types/guanlan';
import { formatLocalClock, formatLocalStamp } from './timeFormat';

/**
 * 1. 中文双字切分 (Bigram) 候选与短语回源校验
 * SQLite FTS5 trigram 对少于 3 个字符的中文词（如“决策”“验收”）无法直接 MATCH，
 * 因此采用双字切分候选 + 原文连续短语核验，编号走精确匹配，单字走有界回退。
 */
export function generateChineseBigrams(text: string): string[] {
  const normalized = text.replace(/\s+/g, '');
  if (normalized.length < 2) {
    return normalized.length === 1 ? [normalized] : [];
  }
  const bigrams: string[] = [];
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.push(normalized.slice(i, i + 2));
  }
  return Array.from(new Set(bigrams));
}

const MD_LINE_CACHE_CAPACITY = 2048;

interface MdLineCacheEntry {
  lines: string[];
  linesLower: string[];
}

const mdLineCache = new Map<string, MdLineCacheEntry>();

function getCachedMdLines(revisionId: string, body: string): MdLineCacheEntry {
  const cached = mdLineCache.get(revisionId);
  if (cached) {
    mdLineCache.delete(revisionId);
    mdLineCache.set(revisionId, cached);
    return cached;
  }
  const lines = body.split('\n');
  const linesLower = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    linesLower[i] = lines[i].toLowerCase();
  }
  const entry: MdLineCacheEntry = { lines, linesLower };
  mdLineCache.set(revisionId, entry);
  if (mdLineCache.size > MD_LINE_CACHE_CAPACITY) {
    const oldest = mdLineCache.keys().next();
    if (!oldest.done) mdLineCache.delete(oldest.value);
  }
  return entry;
}

export interface SearchHit {
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  format: FileFormat;
  coverage: CoverageKind;
  matchStrategy: 'exact_code' | 'bigram_phrase_verified' | 'single_char_bounded' | 'filename_match';
  locator:
    | { kind: 'lines'; start: number; end: number }
    | { kind: 'svg_text'; fragment: string }
    | { kind: 'pdf_page'; page: number }
    | { kind: 'file' };
  snippet: string;
  stale: boolean;
}

export function searchWorkspace(
  files: FileRecord[],
  query: string,
  options?: {
    format?: FileFormat | 'all';
    topic?: string | 'all';
    folder?: string | 'all';
    role?: string | 'all';
  },
  contentCache?: Record<string, string>,
  limit?: number
): SearchHit[] {
  const rawQuery = query.trim();
  if (!rawQuery) return [];

  const qLower = rawQuery.toLowerCase();
  const isCodeQuery = /^(q\d+|t-\d+|cand-\d+|rev_\w+|file_\w+)$/i.test(rawQuery);
  const queryBigrams = generateChineseBigrams(qLower);

  const hits: SearchHit[] = [];

  const hitCountByFileId = new Map<string, number>();
  const pushHit = (hit: SearchHit): void => {
    hits.push(hit);
    hitCountByFileId.set(hit.file_id, (hitCountByFileId.get(hit.file_id) ?? 0) + 1);
  };

  for (const file of files) {
    if (limit !== undefined && hits.length > limit) {
      break;
    }
    if (options?.format && options.format !== 'all' && file.format !== options.format) continue;
    if (options?.folder && options.folder !== 'all' && file.folder !== options.folder) continue;
    if (options?.role && options.role !== 'all' && file.role !== options.role) continue;
    if (
      options?.topic &&
      options.topic !== 'all' &&
      !file.topics.some((t) => t.name === options.topic)
    ) {
      continue;
    }

    const currentRev =
      file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
      file.revisions[file.revisions.length - 1];

    const pathMatches =
      file.relative_path.toLowerCase().includes(qLower) ||
      file.title.toLowerCase().includes(qLower);

    const mdBodyText =
      currentRev?.markdownContent ??
      (currentRev && contentCache
        ? contentCache[currentRev.revision_id]
        : undefined);
    if (file.format === 'md' && mdBodyText) {
      const { lines, linesLower } = getCachedMdLines(currentRev.revision_id, mdBodyText);
      let matchedInBody = false;

      for (let idx = 0; idx < lines.length; idx++) {
        const lineLower = linesLower[idx];

        const hasAllBigrams =
          queryBigrams.length === 0 || queryBigrams.every((bg) => lineLower.includes(bg));
        if (hasAllBigrams && lineLower.includes(qLower)) {
          matchedInBody = true;
          const startLine = Math.max(1, idx);
          const endLine = Math.min(lines.length, idx + 2);
          pushHit({
            file_id: file.file_id,
            revision_id: currentRev.revision_id,
            relative_path: file.relative_path,
            title: file.title,
            format: 'md',
            coverage: 'full_text',
            matchStrategy: isCodeQuery
              ? 'exact_code'
              : rawQuery.length === 1
                ? 'single_char_bounded'
                : 'bigram_phrase_verified',
            locator: { kind: 'lines', start: startLine, end: endLine },
            snippet: lines[idx].trim(),
            stale: false,
          });
          if ((hitCountByFileId.get(file.file_id) ?? 0) >= 3) break;
        }
      }

      if (!matchedInBody && pathMatches) {
        pushHit({
          file_id: file.file_id,
          revision_id: currentRev.revision_id,
          relative_path: file.relative_path,
          title: file.title,
          format: 'md',
          coverage: 'full_text',
          matchStrategy: 'filename_match',
          locator: { kind: 'lines', start: 1, end: 5 },
          snippet: `文件名命中：${file.relative_path}`,
          stale: false,
        });
      }
    }

    if (file.format === 'svg' && currentRev) {
      const extracted = currentRev.svgExtractedTexts || [];
      let matchedSvgText = false;

      for (const frag of extracted) {
        if (frag.toLowerCase().includes(qLower)) {
          matchedSvgText = true;
          pushHit({
            file_id: file.file_id,
            revision_id: currentRev.revision_id,
            relative_path: file.relative_path,
            title: file.title,
            format: 'svg',
            coverage: 'svg_text',
            matchStrategy: isCodeQuery ? 'exact_code' : 'bigram_phrase_verified',
            locator: { kind: 'svg_text', fragment: frag },
            snippet: `SVG 可提取文字命中：「${frag}」`,
            stale: false,
          });
        }
      }

      if (!matchedSvgText && pathMatches) {
        pushHit({
          file_id: file.file_id,
          revision_id: currentRev.revision_id,
          relative_path: file.relative_path,
          title: file.title,
          format: 'svg',
          coverage: extracted.length > 0 ? 'svg_text' : 'filename_only',
          matchStrategy: 'filename_match',
          locator: { kind: 'file' },
          snippet:
            extracted.length > 0
              ? `SVG 文件名命中：${file.relative_path}`
              : `仅文件名可检索（该 SVG 无内嵌 <text> 文本层）：${file.relative_path}`,
          stale: false,
        });
      }
    }

    if (file.format === 'pdf' && currentRev) {
      let matchedPdfPage = false;
      if (file.pdfStatus === 'page_indexed' && currentRev.pdfPages) {
        for (const p of currentRev.pdfPages) {
          if (
            p.extractedText.toLowerCase().includes(qLower) ||
            p.heading.toLowerCase().includes(qLower)
          ) {
            matchedPdfPage = true;
            pushHit({
              file_id: file.file_id,
              revision_id: currentRev.revision_id,
              relative_path: file.relative_path,
              title: file.title,
              format: 'pdf',
              coverage: 'pdf_page_text',
              matchStrategy: isCodeQuery ? 'exact_code' : 'bigram_phrase_verified',
              locator: { kind: 'pdf_page', page: p.pageNumber },
              snippet: `第 ${p.pageNumber} 页命中：${p.extractedText.slice(0, 95)}…`,
              stale: false,
            });
          }
        }
      }

      if (!matchedPdfPage && pathMatches) {
        pushHit({
          file_id: file.file_id,
          revision_id: currentRev.revision_id,
          relative_path: file.relative_path,
          title: file.title,
          format: 'pdf',
          coverage: file.pdfStatus === 'page_indexed' ? 'pdf_page_text' : 'filename_only',
          matchStrategy: 'filename_match',
          locator: { kind: 'file' },
          snippet:
            file.pdfStatus === 'page_indexed'
              ? `PDF 文件名命中（已抽取页文本）：${file.relative_path}`
              : `PDF 文件名命中（正文尚未索引，仅文件名与元数据可检索）：${file.relative_path}`,
          stale: false,
        });
      }
    }
  }

  return hits;
}

/**
 * 顶栏快速检索的全局命中上限。
 *
 * 顶栏扫的是客户端已缓存的全部文件与已并入的正文；短词在数万文件上可以命中
 * 上万条，之前没有总上限，列表逐条渲染直接卡住。上限只截断「展示」，命中本身
 * 仍按既有逐文件逻辑产出；`truncated` 让界面明说「未列全」，不拿截断后的
 * 空集冒充「没有命中」。
 */
export const TOPBAR_SEARCH_LIMIT = 100;

export interface WorkspaceSearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

export function searchWorkspaceCapped(
  files: FileRecord[],
  query: string,
  limit: number = TOPBAR_SEARCH_LIMIT
): WorkspaceSearchResult {
  const probe = searchWorkspace(files, query, undefined, undefined, limit);
  const truncated = probe.length > limit;
  return {
    hits: truncated ? probe.slice(0, limit) : probe,
    truncated,
  };
}

/**
 * 2. Markdown 章节大纲与显式提要段落识别
 * 跳过代码块内的 # 注释（避免把模板示例当作真实章节或决策）。
 */
export function parseMarkdownOutline(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (match) {
      const level = match[1].length as 1 | 2 | 3;
      const title = match[2].trim();
      const lineNum = i + 1;

      if (sections.length > 0) {
        sections[sections.length - 1].endLine = lineNum - 1;
      }

      let isExplicitCallout: MarkdownSection['isExplicitCallout'];
      if (title.includes('核心结论')) isExplicitCallout = '核心结论';
      else if (title.includes('需你决策')) isExplicitCallout = '需你决策';
      else if (title.includes('推荐及理由')) isExplicitCallout = '推荐及理由';
      else if (title.includes('影响与等待范围')) isExplicitCallout = '影响与等待范围';

      sections.push({
        id: title,
        title,
        level,
        startLine: lineNum,
        endLine: lines.length,
        isExplicitCallout,
      });
    }
  }

  for (const sec of sections) {
    const bodyLines = lines
      .slice(sec.startLine, sec.endLine)
      .map((l) =>
        l
          .trim()
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .replace(/\|/g, ' · ')
      )
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith('```') &&
          !l.includes('---')
      );
    sec.summaryText = bodyLines.slice(0, 2).join(' ').slice(0, 140);
  }

  return sections;
}

/**
 * 3. 版本身份（A -> B -> A 恢复检测）与行级文本差异
 */
export function detectRollbackRevision(revisions: Revision[], targetRevisionId: string): {
  isRollback: boolean;
  matchesEarlierRevisionId?: string;
} {
  const idx = revisions.findIndex((r) => r.revision_id === targetRevisionId);
  if (idx < 2) return { isRollback: false };

  const target = revisions[idx];
  const immediatePrev = revisions[idx - 1];
  if (target.content_sha256 === immediatePrev.content_sha256) {
    return { isRollback: false };
  }

  for (let i = 0; i < idx - 1; i++) {
    if (revisions[i].content_sha256 === target.content_sha256) {
      return {
        isRollback: true,
        matchesEarlierRevisionId: revisions[i].revision_id,
      };
    }
  }
  return { isRollback: false };
}

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
  sectionContext?: string;
}

export interface DiffResult {
  ok: boolean;
  errorCode?: McpErrorCode;
  errorMessage?: string;
  fromRevision?: Revision;
  toRevision?: Revision;
  changedSections: string[];
  addedCount: number;
  removedCount: number;
  lines: DiffLine[];
}

/**
 * 差异预算：普通徽章/计数不再进入本函数；真正进入 diff 视图时，
 * 行数与 DP 单元数设硬上限，超限明确拒绝（DIFF_TOO_LARGE），不用空 diff 冒充成功。
 * 上限内的 DP 行数组用 Int32Array（值域 ≤ 行数），内存 16MB 封顶，不再无界分配。
 */
export const DIFF_MAX_LINES_PER_SIDE = 20_000;
export const DIFF_MAX_DP_CELLS = 4_000_000;

function revisionTextOf(
  rev: Revision,
  contentCache?: Record<string, string>
): string | null {
  if (rev.markdownContent !== undefined) return rev.markdownContent;
  const cached = contentCache?.[rev.revision_id];
  if (cached !== undefined) return cached;
  if (rev.svgSource !== undefined) return rev.svgSource;
  return null;
}

function isConfirmedEmptyContent(rev: Revision): boolean {
  return rev.sizeBytes === 0 && Boolean(rev.content_sha256);
}

function unchangedDiffResult(
  fromRev: Revision,
  toRev: Revision,
  text: string
): DiffResult {
  const lines = text.split('\n');
  const diffLines: DiffLine[] = lines.map((content, idx) => ({
    type: 'unchanged' as const,
    oldLineNumber: idx + 1,
    newLineNumber: idx + 1,
    content,
    sectionContext: '文档头部',
  }));
  return {
    ok: true,
    fromRevision: fromRev,
    toRevision: toRev,
    changedSections: [],
    addedCount: 0,
    removedCount: 0,
    lines: diffLines,
  };
}

export function computeMarkdownDiff(
  file: FileRecord,
  fromRevisionId: string,
  toRevisionId: string,
  contentCache?: Record<string, string>
): DiffResult {
  const fromRev = file.revisions.find((r) => r.revision_id === fromRevisionId);
  const toRev = file.revisions.find((r) => r.revision_id === toRevisionId);

  if (!fromRev || !toRev) {
    return {
      ok: false,
      errorCode: 'NOT_FOUND',
      errorMessage: `指定的版本记录不存在 (${fromRevisionId} -> ${toRevisionId})`,
      changedSections: [],
      addedCount: 0,
      removedCount: 0,
      lines: [],
    };
  }

  if (!fromRev.snapshotAvailable || !toRev.snapshotAvailable) {
    return {
      ok: false,
      errorCode: 'REVISION_UNAVAILABLE',
      errorMessage: `版本快照已超出保留配额被清理 (${!fromRev.snapshotAvailable ? fromRev.revision_id : toRev.revision_id})，对比基线不可用，拒绝使用当前内容冒充旧版本。`,
      fromRevision: fromRev,
      toRevision: toRev,
      changedSections: [],
      addedCount: 0,
      removedCount: 0,
      lines: [],
    };
  }

  const oldText = revisionTextOf(fromRev, contentCache);
  const newText = revisionTextOf(toRev, contentCache);
  if (oldText === null && !isConfirmedEmptyContent(fromRev)) {
    return {
      ok: false,
      errorCode: 'CONTENT_NOT_LOADED',
      errorMessage: `基线版本正文尚未加载 (${fromRev.revision_id})，等待正文取回后再对比；不以空文档冒充基线。`,
      fromRevision: fromRev,
      toRevision: toRev,
      changedSections: [],
      addedCount: 0,
      removedCount: 0,
      lines: [],
    };
  }
  if (newText === null && !isConfirmedEmptyContent(toRev)) {
    return {
      ok: false,
      errorCode: 'CONTENT_NOT_LOADED',
      errorMessage: `目标版本正文尚未加载 (${toRev.revision_id})，等待正文取回后再对比；不以空文档冒充目标。`,
      fromRevision: fromRev,
      toRevision: toRev,
      changedSections: [],
      addedCount: 0,
      removedCount: 0,
      lines: [],
    };
  }
  const oldContent = oldText ?? '';
  const newContent = newText ?? '';

  if (fromRev.revision_id === toRev.revision_id) {
    return unchangedDiffResult(fromRev, toRev, oldContent);
  }
  if (oldContent === newContent) {
    return unchangedDiffResult(fromRev, toRev, oldContent);
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const m = oldLines.length;
  const n = newLines.length;
  if (m > DIFF_MAX_LINES_PER_SIDE || n > DIFF_MAX_LINES_PER_SIDE) {
    return {
      ok: false,
      errorCode: 'DIFF_TOO_LARGE',
      errorMessage: `文档超过 ${DIFF_MAX_LINES_PER_SIDE} 行 (${m} → ${n})，行级对比被明确拒绝；请缩小对比范围（服务端有界 diff 任务见 /api/v1/diff 交付）。`,
      fromRevision: fromRev,
      toRevision: toRev,
      changedSections: [],
      addedCount: 0,
      removedCount: 0,
      lines: [],
    };
  }
  if ((m + 1) * (n + 1) > DIFF_MAX_DP_CELLS) {
    return {
      ok: false,
      errorCode: 'DIFF_TOO_LARGE',
      errorMessage: `对比规模超出预算 (${m}×${n} 行，上限 ${DIFF_MAX_DP_CELLS} 个 DP 单元)，行级对比被明确拒绝；请缩小对比范围（服务端有界 diff 任务见 /api/v1/diff 交付）。`,
      fromRevision: fromRev,
      toRevision: toRev,
      changedSections: [],
      addedCount: 0,
      removedCount: 0,
      lines: [],
    };
  }

  const dp: Int32Array[] = Array.from(
    { length: m + 1 },
    () => new Int32Array(n + 1)
  );

  for (let i = m - 1; i >= 0; i--) {
    const dpRow = dp[i];
    const dpNext = dp[i + 1];
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dpRow[j] = 1 + dpNext[j + 1];
      } else {
        dpRow[j] = Math.max(dpNext[j], dpRow[j + 1]);
      }
    }
  }

  const diffLines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let addedCount = 0;
  let removedCount = 0;
  let currentHeading = '文档头部';
  const changedSectionsSet = new Set<string>();

  while (i < m && j < n) {
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(newLines[j].trim());
    if (headingMatch) {
      currentHeading = headingMatch[2].trim();
    }

    if (oldLines[i] === newLines[j]) {
      diffLines.push({
        type: 'unchanged',
        oldLineNumber: i + 1,
        newLineNumber: j + 1,
        content: oldLines[i],
        sectionContext: currentHeading,
      });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diffLines.push({
        type: 'removed',
        oldLineNumber: i + 1,
        content: oldLines[i],
        sectionContext: currentHeading,
      });
      removedCount++;
      changedSectionsSet.add(currentHeading);
      i++;
    } else {
      diffLines.push({
        type: 'added',
        newLineNumber: j + 1,
        content: newLines[j],
        sectionContext: currentHeading,
      });
      addedCount++;
      changedSectionsSet.add(currentHeading);
      j++;
    }
  }

  while (i < m) {
    diffLines.push({
      type: 'removed',
      oldLineNumber: i + 1,
      content: oldLines[i],
      sectionContext: currentHeading,
    });
    removedCount++;
    changedSectionsSet.add(currentHeading);
    i++;
  }

  while (j < n) {
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(newLines[j].trim());
    if (headingMatch) currentHeading = headingMatch[2].trim();
    diffLines.push({
      type: 'added',
      newLineNumber: j + 1,
      content: newLines[j],
      sectionContext: currentHeading,
    });
    addedCount++;
    changedSectionsSet.add(currentHeading);
    j++;
  }

  return {
    ok: true,
    fromRevision: fromRev,
    toRevision: toRev,
    changedSections: Array.from(changedSectionsSet),
    addedCount,
    removedCount,
    lines: diffLines,
  };
}

/**
 * 4. 决策命名空间隔离与状态边界核验
 * - 编号必须按项目与决策集命名空间区分，不能将两份材料中的 Q03 自动合并。
 * - “推荐采用”不等于“已经确认”；“不代表验收通过”不能被识别成已验收。
 * - “疑似决策”进入候选列表，不能直接增加“待你确认”的真实计数。
 */
export function getActionablePendingDecisions(decisions: DecisionAssertion[]): DecisionAssertion[] {
  return decisions.filter(
    (d) => !d.isCandidateOnly && (d.status === '待确认' || d.status === '来源不一致')
  );
}

export function findDecisionsByCode(
  decisions: DecisionAssertion[],
  code: string,
  namespace?: string
): DecisionAssertion[] {
  return decisions.filter((d) => {
    const codeMatch = d.code.toLowerCase() === code.toLowerCase();
    if (!namespace) return codeMatch;
    return codeMatch && d.namespace === namespace;
  });
}

export function evaluateDecisionPhraseSemantics(rawLine: string, inCodeBlock = false): {
  inferredStatus: '已确认' | '待确认' | '非实际状态（限定或示例）';
  reason: string;
} {
  if (inCodeBlock || rawLine.includes('模板示例') || rawLine.includes('仅供编写回执参考')) {
    return {
      inferredStatus: '非实际状态（限定或示例）',
      reason: '位于代码块或显式标注为模板示例，不作为当前工程状态',
    };
  }
  if (rawLine.includes('不代表验收通过') || rawLine.includes('尚未获业务负责人签批')) {
    return {
      inferredStatus: '待确认',
      reason: '包含“不代表验收通过”或“尚未获签批”否定限定，严禁判定为已批准',
    };
  }
  if (rawLine.includes('推荐采用') && !rawLine.includes('回执状态：已确认')) {
    return {
      inferredStatus: '待确认',
      reason: '“推荐采用”仅表达方案建议，不等于已经确认批准',
    };
  }
  if (rawLine.includes('回执状态：已确认') || rawLine.includes('当前状态：已确认')) {
    return {
      inferredStatus: '已确认',
      reason: '具备显式确认状态声明',
    };
  }
  return {
    inferredStatus: '待确认',
    reason: '未见明确批准回执',
  };
}

/**
 * 5. 局部关系图构建器（默认 1 跳，支持用户展开 2 跳，上限 80 节点，超限聚合）
 */
export interface GraphNode {
  id: string;
  label: string;
  subLabel: string;
  kind: 'file' | 'decision' | 'revision';
  format?: FileFormat;
  hop: 0 | 1 | 2;
}

export interface LocalGraphResult {
  centerId: string;
  depth: 1 | 2;
  nodes: GraphNode[];
  edges: RelationEdge[];
  truncatedCount: number;
  canExpandTwoHop: boolean;
}

export function buildLocalRelationGraph(
  centerId: string,
  depth: 1 | 2,
  files: FileRecord[],
  decisions: DecisionAssertion[],
  allEdges: RelationEdge[],
  maxNodes = 80
): LocalGraphResult {
  const fileById = new Map(files.map((f) => [f.file_id, f]));
  const decisionById = new Map(decisions.map((d) => [d.decision_id, d]));

  const resolveNode = (id: string, hop: 0 | 1 | 2): GraphNode | null => {
    const f = fileById.get(id);
    if (f) {
      return {
        id: f.file_id,
        label: f.title,
        subLabel: f.relative_path,
        kind: 'file',
        format: f.format,
        hop,
      };
    }
    const d = decisionById.get(id);
    if (d) {
      return {
        id: d.decision_id,
        label: `${d.code} · ${d.status}`,
        subLabel: d.namespace,
        kind: 'decision',
        hop,
      };
    }
    return null;
  };

  const nodeMap = new Map<string, GraphNode>();
  const includedEdges: RelationEdge[] = [];
  const includedEdgeIds = new Set<string>();
  const overflowIds = new Set<string>();
  const budgetFull = () => nodeMap.size >= maxNodes;
  const materialize = (node: GraphNode): boolean => {
    if (nodeMap.has(node.id)) return true;
    if (budgetFull()) {
      overflowIds.add(node.id);
      return false;
    }
    nodeMap.set(node.id, node);
    return true;
  };

  const centerNode = resolveNode(centerId, 0);
  if (!centerNode) {
    return {
      centerId,
      depth,
      nodes: [],
      edges: [],
      truncatedCount: 0,
      canExpandTwoHop: false,
    };
  }
  nodeMap.set(centerId, centerNode);

  const adjacency = new Map<string, RelationEdge[]>();
  for (const edge of allEdges) {
    const src = adjacency.get(edge.source_id);
    if (src) src.push(edge);
    else adjacency.set(edge.source_id, [edge]);
    const dst = adjacency.get(edge.target_id);
    if (dst) dst.push(edge);
    else adjacency.set(edge.target_id, [edge]);
  }

  const oneHopIds = new Set<string>();
  for (const edge of adjacency.get(centerId) ?? []) {
    const otherId = edge.source_id === centerId ? edge.target_id : edge.source_id;
    if (otherId === centerId) continue;
    const resolved = resolveNode(otherId, 1);
    if (resolved) {
      materialize(resolved);
      oneHopIds.add(otherId);
      if (!includedEdgeIds.has(edge.edge_id)) {
        includedEdgeIds.add(edge.edge_id);
        includedEdges.push(edge);
      }
    }
  }

  const centerFile = fileById.get(centerId);
  if (centerFile && centerFile.revisions.length > 1) {
    const firstSeenByHash = new Map<string, number>();
    for (let i = 0; i < centerFile.revisions.length; i++) {
      const rev = centerFile.revisions[i];
      const seenAt = firstSeenByHash.get(rev.content_sha256);
      const rollback = seenAt !== undefined && seenAt < i;
      firstSeenByHash.set(rev.content_sha256, i);
      const revNodeId = rev.revision_id;
      const isLatestRev = revNodeId === centerFile.current_revision_id;
      const revNode: GraphNode = {
        id: revNodeId,
        label: isLatestRev ? `v${rev.versionNumber}（最新）` : `v${rev.versionNumber}`,
        subLabel: formatLocalStamp(rev.observed_at),
        kind: 'revision',
        hop: 1,
      };
      materialize(revNode);
      if (i === 0) {
        includedEdges.push({
          edge_id: `rev_edge_${rev.revision_id}`,
          source_id: centerId,
          target_id: revNodeId,
          type: 'revision_evolution',
          isInferred: false,
          label: '基线版本',
          reason: `文件 ${centerFile.relative_path} 的首次捕获版本`,
        });
      } else {
        const prevRev = centerFile.revisions[i - 1];
        includedEdges.push({
          edge_id: `rev_edge_${prevRev.revision_id}_${rev.revision_id}`,
          source_id: prevRev.revision_id,
          target_id: revNodeId,
          type: 'revision_evolution',
          isInferred: false,
          label: rollback ? 'A→B→A 恢复' : '版本演进',
          reason: rev.summaryNote,
        });
      }
    }
  }

  let hasTwoHopCandidates = false;
  const scannedTwoHop = new Set<string>();
  for (const oneHopId of oneHopIds) {
    for (const edge of adjacency.get(oneHopId) ?? []) {
      if (includedEdgeIds.has(edge.edge_id) || scannedTwoHop.has(edge.edge_id)) continue;
      scannedTwoHop.add(edge.edge_id);
      const otherId = edge.source_id === oneHopId ? edge.target_id : edge.source_id;
      if (otherId === centerId || oneHopIds.has(otherId)) continue;
      if (resolveNode(otherId, 2)) {
        hasTwoHopCandidates = true;
        if (depth === 2) {
          if (!includedEdgeIds.has(edge.edge_id)) {
            includedEdgeIds.add(edge.edge_id);
            includedEdges.push(edge);
          }
          materialize(resolveNode(otherId, 2)!);
        }
      }
    }
  }

  const truncatedCount = Math.max(0, nodeMap.size + overflowIds.size - maxNodes);

  const materializedIds = new Set(nodeMap.keys());
  const boundedEdges = includedEdges.filter(
    (e) => materializedIds.has(e.source_id) && materializedIds.has(e.target_id)
  );

  return {
    centerId,
    depth,
    nodes: Array.from(nodeMap.values()),
    edges: boundedEdges,
    truncatedCount,
    canExpandTwoHop: hasTwoHopCandidates,
  };
}

/**
 * 6. 访问与内容安全边界
 * - 只访问显式根目录，拦截越界路径 (.., 跨盘符, UNC, 绝对路径越界)
 * - 清洗 SVG 内容，移除 <script>、onload/onclick 事件属性与外部资源加载
 */
export function validateRootBoundary(
  configuredRoot: string,
  requestedPath: string
): { allowed: boolean; errorCode?: McpErrorCode; reason?: string } {
  const normRoot = configuredRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const raw = requestedPath.trim();

  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return {
      allowed: false,
      errorCode: 'OUT_OF_SCOPE',
      reason: '拒绝访问 UNC 网络路径，观澜仅访问显式配置的本地工程根目录。',
    };
  }

  const normReq = raw.replace(/\\/g, '/');
  if (normReq.split('/').includes('..')) {
    return {
      allowed: false,
      errorCode: 'OUT_OF_SCOPE',
      reason: '检测到路径穿越段 (..)，已拒绝越界读取。',
    };
  }

  if (/^[a-zA-Z]:\//.test(normReq)) {
    if (!normReq.toLowerCase().startsWith(normRoot + '/') && normReq.toLowerCase() !== normRoot) {
      return {
        allowed: false,
        errorCode: 'OUT_OF_SCOPE',
        reason: `绝对路径不在已配置根目录 (${configuredRoot}) 范围内，源文档中的绝对路径不授予新目录权限。`,
      };
    }
  }

  return { allowed: true };
}

export function sanitizeSvgForPreview(rawSvg: string): {
  sanitizedSvg: string;
  removedThreats: string[];
} {
  const removedThreats: string[] = [];
  let cleaned = rawSvg;

  if (/<script[\s>]/i.test(cleaned)) {
    removedThreats.push('已剥离 <script> 脚本标签');
    cleaned = cleaned.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  }
  if (/\son[a-z]+\s*=/i.test(cleaned)) {
    removedThreats.push('已剥离内联事件处理器 (onload/onclick 等)');
    cleaned = cleaned.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  }
  if (/xlink:href\s*=\s*(['"])https?:/i.test(cleaned) || /href\s*=\s*(['"])https?:/i.test(cleaned)) {
    removedThreats.push('已拦截外部网络资源自动加载');
    cleaned = cleaned.replace(/(?:xlink:)?href\s*=\s*(['"])https?:.*?\1/gi, '');
  }

  return { sanitizedSvg: cleaned, removedThreats };
}

/**
 * 7. MCP 8 个标准工具契约执行器
 * 统一从同一套索引和版本体系返回，绑定 index_generation 与标准错误码。
 */
export interface McpToolRequest {
  tool: McpToolName;
  params: Record<string, unknown>;
  clientIndexGeneration?: number;
  simulateRootInUse?: boolean;
  simulateDiskHashDrift?: boolean;
}

export interface McpToolResponse {
  ok: boolean;
  tool: McpToolName;
  error_code?: McpErrorCode;
  error_message?: string;
  index_generation: number;
  truncated: boolean;
  next_cursor: string | null;
  side_effect_notice?: string;
  data?: unknown;
}

export function executeMcpTool(
  req: McpToolRequest,
  context: {
    config: WorkspaceConfig;
    files: FileRecord[];
    events: TimelineEvent[];
    decisions: DecisionAssertion[];
    relations: RelationEdge[];
  },
  options?: { contentCache?: Record<string, string> }
): McpToolResponse {
  const gen = context.config.runtimeStatus.indexGeneration;

  if (req.simulateRootInUse) {
    return {
      ok: false,
      tool: req.tool,
      error_code: 'ROOT_IN_USE',
      error_message: `工程目录 ${context.config.rootPath} 已被另一个观澜核心服务进程持有单写入锁。请通过 Magpie MCP 路由共享同一实例，或关闭冲突进程后重试。`,
      index_generation: gen,
      truncated: false,
      next_cursor: null,
    };
  }

  if (
    req.clientIndexGeneration !== undefined &&
    req.clientIndexGeneration !== gen
  ) {
    return {
      ok: false,
      tool: req.tool,
      error_code: 'INDEX_STALE',
      error_message: `分页游标或客户端绑定的 index_generation (${req.clientIndexGeneration}) 已过期（当前代际为 ${gen}）。请重启查询以避免跨页重复或漏项，严禁沿用旧行号。`,
      index_generation: gen,
      truncated: false,
      next_cursor: null,
    };
  }

  switch (req.tool) {
    case 'overview': {
      const pendingDecisions = getActionablePendingDecisions(context.decisions);
      return {
        ok: true,
        tool: 'overview',
        index_generation: gen,
        truncated: false,
        next_cursor: null,
        data: {
          root_path: context.config.rootPath,
          enum_snapshot: context.config.enumSnapshot,
          recent_events_count: context.events.length,
          actionable_pending_decisions_count: pendingDecisions.length,
          candidate_decisions_count: context.decisions.filter((d) => d.isCandidateOnly).length,
          pending_decisions: pendingDecisions.map((d) => ({
            decision_id: d.decision_id,
            namespace_code: `${d.namespace} :: ${d.code}`,
            status: d.status,
            question: d.question,
          })),
        },
      };
    }

    case 'search': {
      const q = String(req.params.query || '');
      const format = (req.params.format as FileFormat | 'all') || 'all';
      const topic = String(req.params.topic || 'all');
      const hits = searchWorkspace(
        context.files,
        q,
        { format, topic },
        options?.contentCache
      );
      return {
        ok: true,
        tool: 'search',
        index_generation: gen,
        truncated: hits.length > 20,
        next_cursor: hits.length > 20 ? `cur_search_gen_${gen}_offset_20` : null,
        data: {
          query: q,
          total_hits: hits.length,
          items: hits.slice(0, 20),
        },
      };
    }

    case 'read': {
      const requestedPath = req.params.path ? String(req.params.path) : undefined;
      if (requestedPath) {
        const boundary = validateRootBoundary(context.config.rootPath, requestedPath);
        if (!boundary.allowed) {
          return {
            ok: false,
            tool: 'read',
            error_code: boundary.errorCode,
            error_message: boundary.reason,
            index_generation: gen,
            truncated: false,
            next_cursor: null,
          };
        }
      }

      const fileId = String(req.params.file_id || '');
      const file = context.files.find((f) => f.file_id === fileId);
      if (!file) {
        return {
          ok: false,
          tool: 'read',
          error_code: 'NOT_FOUND',
          error_message: `未找到 file_id=${fileId} 的文件记录`,
          index_generation: gen,
          truncated: false,
          next_cursor: null,
        };
      }

      if (req.simulateDiskHashDrift && !req.params.revision_id) {
        return {
          ok: false,
          tool: 'read',
          error_code: 'INDEX_STALE',
          error_message: `读取“当前版本”时重新核验文件哈希发现磁盘内容已变更（与索引代际 ${gen} 不符）。已触发增量刷新，拒绝沿用旧行号。`,
          index_generation: gen,
          truncated: false,
          next_cursor: null,
        };
      }

      const targetRevId = String(req.params.revision_id || file.current_revision_id);
      const rev = file.revisions.find((r) => r.revision_id === targetRevId);
      if (!rev) {
        return {
          ok: false,
          tool: 'read',
          error_code: 'NOT_FOUND',
          error_message: `未找到版本 ${targetRevId}`,
          index_generation: gen,
          truncated: false,
          next_cursor: null,
        };
      }

      if (!rev.snapshotAvailable) {
        return {
          ok: false,
          tool: 'read',
          error_code: 'REVISION_UNAVAILABLE',
          error_message: `历史版本 ${targetRevId} 的内容快照已超过保留期限清理，观澜拒绝展示当前版本冒充旧内容。`,
          index_generation: gen,
          truncated: false,
          next_cursor: null,
        };
      }

      const rawBody =
        rev.markdownContent ||
        options?.contentCache?.[rev.revision_id] ||
        rev.svgSource ||
        rev.pdfPages?.map((p) => `[P${p.pageNumber}] ${p.extractedText}`).join('\n\n') ||
        '';

      const truncated = rawBody.length > 12000;
      const pointer: EvidencePointer = {
        file_id: file.file_id,
        revision_id: rev.revision_id,
        relative_path: file.relative_path,
        content_sha256: rev.content_sha256,
        locator:
          file.format === 'md'
            ? { kind: 'lines', start: 1, end: rawBody.split('\n').length }
            : file.format === 'pdf'
              ? { kind: 'pdf_page', page: 1 }
              : { kind: 'file' },
        evidence_kind: 'explicit_source',
        index_generation: gen,
        observed_at: rev.observed_at,
        coverage: file.coverage,
        stale: false,
        excerpt: rawBody.slice(0, 12000),
      };

      return {
        ok: true,
        tool: 'read',
        index_generation: gen,
        truncated,
        next_cursor: null,
        data: {
          evidence: pointer,
          outline: file.format === 'md' ? parseMarkdownOutline(rawBody) : [],
          pdf_status: file.pdfStatus,
          pdf_status_reason: file.pdfStatusReason,
        },
      };
    }

    case 'timeline': {
      const kindFilter = String(req.params.kind || 'all');
      const filtered =
        kindFilter === 'all'
          ? context.events
          : context.events.filter((e) => e.kind === kindFilter);
      return {
        ok: true,
        tool: 'timeline',
        index_generation: gen,
        truncated: filtered.length > 20,
        next_cursor: filtered.length > 20 ? `cur_tl_gen_${gen}_20` : null,
        data: {
          ordering: 'observed_at DESC (Asia/Shanghai)',
          events: filtered.slice(0, 20),
        },
      };
    }

    case 'diff': {
      const fileId = String(req.params.file_id || '');
      const file = context.files.find((f) => f.file_id === fileId);
      if (!file) {
        return {
          ok: false,
          tool: 'diff',
          error_code: 'NOT_FOUND',
          error_message: `未找到文件 ${fileId}`,
          index_generation: gen,
          truncated: false,
          next_cursor: null,
        };
      }
      const fromRev = String(req.params.from_revision || file.revisions[0]?.revision_id);
      const toRev = String(req.params.to_revision || file.current_revision_id);
      const res = computeMarkdownDiff(file, fromRev, toRev, options?.contentCache);
      if (!res.ok) {
        return {
          ok: false,
          tool: 'diff',
          error_code: res.errorCode,
          error_message: res.errorMessage,
          index_generation: gen,
          truncated: false,
          next_cursor: null,
        };
      }
      return {
        ok: true,
        tool: 'diff',
        index_generation: gen,
        truncated: false,
        next_cursor: null,
        data: {
          file_id: file.file_id,
          relative_path: file.relative_path,
          from_revision: fromRev,
          to_revision: toRev,
          changed_sections: res.changedSections,
          added_lines: res.addedCount,
          removed_lines: res.removedCount,
          diff_preview: res.lines.filter((l) => l.type !== 'unchanged').slice(0, 30),
        },
      };
    }

    case 'decisions': {
      const statusFilter = String(req.params.status || 'all');
      const includeCandidates = Boolean(req.params.include_candidates);
      const list = context.decisions.filter((d) => {
        if (!includeCandidates && d.isCandidateOnly) return false;
        if (statusFilter !== 'all' && d.status !== statusFilter) return false;
        return true;
      });
      return {
        ok: true,
        tool: 'decisions',
        index_generation: gen,
        truncated: false,
        next_cursor: null,
        data: {
          namespace_isolation: 'strict (project :: decision_set :: code)',
          items: list,
        },
      };
    }

    case 'relations': {
      const subjectId = String(req.params.subject_id || '');
      const depth = req.params.depth === 2 ? 2 : 1;
      const graph = buildLocalRelationGraph(
        subjectId,
        depth,
        context.files,
        context.decisions,
        context.relations
      );
      return {
        ok: true,
        tool: 'relations',
        index_generation: gen,
        truncated: graph.truncatedCount > 0,
        next_cursor: null,
        data: graph,
      };
    }

    case 'open_reader': {
      const fileId = String(req.params.file_id || '');
      const revId = String(req.params.revision_id || 'current');
      return {
        ok: true,
        tool: 'open_reader',
        index_generation: gen,
        truncated: false,
        next_cursor: null,
        side_effect_notice:
          '已按需启动本机 127.0.0.1 loopback HTTP/SSE 服务并颁发短期启动凭据（注：open_reader 具有启动监听与建立会话副作用，非纯查询）。',
        data: {
          loopback_entry: `${context.config.runtimeStatus.loopbackUrl}?file_id=${fileId}&revision_id=${revId}`,
          host_origin_policy: 'loopback-only (127.0.0.1) + short-lived token exchange',
        },
      };
    }
  }
}

/**
 * 8. 生成复制给智能体的带版本与行号定位的上下文清单
 */
export function formatContextForAgent(
  pointers: EvidencePointer[],
  workspaceRoot: string
): string {
  if (pointers.length === 0) {
    return '# 观澜上下文清单（当前未选中任何证据条目）';
  }

  const header = [
    `# 观澜 (Guanlan MCP) 证据上下文清单`,
    `- 工程根目录：\`${workspaceRoot}\``,
    `- 导出时间：${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} (+08:00)`,
    `- 条目数量：${pointers.length} 项（均附带独立 file_id、revision_id 与 SHA-256 校验摘要，可在智能体中直接调用 \`read\` / \`diff\` / \`decisions\` 工具核对）`,
    '',
  ];

  const blocks = pointers.map((p, idx) => {
    const locText =
      p.locator.kind === 'lines'
        ? `Lines ${p.locator.start}–${p.locator.end}`
        : p.locator.kind === 'pdf_page'
          ? `Page ${p.locator.page}`
          : p.locator.kind === 'svg_text'
            ? `SVG Text "${p.locator.fragment}"`
            : 'Full File';

    return [
      `### [${idx + 1}] \`${p.relative_path}\` (${locText})`,
      `- **定位凭证**：\`file_id=${p.file_id}\` · \`revision_id=${p.revision_id}\` · \`index_generation=${p.index_generation}\``,
      `- **内容哈希**：\`sha256:${p.content_sha256}\` · **观察时间**：\`${p.observed_at}\` · **覆盖度**：\`${p.coverage}\``,
      p.note ? `- **阅读备注**：${p.note}` : '',
      p.excerpt ? `> ${p.excerpt.replace(/\n/g, '\n> ')}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [...header, ...blocks].join('\n');
}

/**
 * 未读三态文案的唯一出口（右栏 / 悬停预览 / 列表共用同一套措辞）。
 * never_read 绝不能写成『自上次读…』——从未建立的基线不存在“上次读”。
 * 术语两态统一：全应用未读术语收敛为「未读新件」（首次收录、从未读过）
 * 与「读后有更新」（有阅读基线且当前版更新）两态——首次收录与读后变更
 * 绝不混同，up_to_date 已读最新不属未读态。
 */
export type UnreadReason = 'never_read' | 'updated_since_last_read' | 'up_to_date';

export function unreadStatusLabel(reason: UnreadReason): string {
  if (reason === 'never_read') return '未读新件（尚未建立阅读基线）';
  if (reason === 'updated_since_last_read') return '读后有更新';
  return '已读最新';
}

/**
 * 未读三态判定：
 * 只比较版本身份（last_read_revision_id vs current_revision_id），O(1)，
 * 不再触发二维 LCS。全库未读徽章/计数/过滤（App、LeftSidebar、GraphCanvasView、
 * AtlasView、HomeView）都走本函数——避免基线落后的文件每次统计都跑全文对比。
 *
 * 变更章节不再是本函数的产出（始终 []）：需要章节级细节的展示位（阅读器大纲高亮）
 * 请用 [`computeChangedSectionsSinceRead`] 按需计算。
 */
export function hasUnreadChanges(
  file: FileRecord,
  readingState?: ReadingState
): {
  isUnread: boolean;
  reason: UnreadReason;
  changedSectionsSinceRead: string[];
} {
  if (!readingState || !readingState.last_read_revision_id) {
    return {
      isUnread: true,
      reason: 'never_read',
      changedSectionsSinceRead: ['尚未建立已读基线'],
    };
  }
  if (readingState.last_read_revision_id === file.current_revision_id) {
    return {
      isUnread: false,
      reason: 'up_to_date',
      changedSectionsSinceRead: [],
    };
  }
  return {
    isUnread: true,
    reason: 'updated_since_last_read',
    changedSectionsSinceRead: [],
  };
}

function sectionFingerprintOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current = '文档头部';
  let body: string[] = [];
  const flush = () => {
    const joined = `${sections.get(current) ?? ''}\x00${body.join('\x00')}`;
    sections.set(current, joined);
  };
  for (const raw of text.split(/\r?\n/)) {
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(raw.trim());
    if (headingMatch) {
      flush();
      current = headingMatch[2].trim();
      body = [];
    } else {
      const line = raw.trim();
      if (line) body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * 「上次已读基线 → 当前版本」的章节级变更清单（按需计算入口）：
 * 与 computeMarkdownDiff 的二维 LCS 不同，本函数用章节内容指纹比较，
 * O(m+n)、零 DP 分配，供阅读器大纲「自上次读变更」高亮等展示位使用。
 *
 * 诚实边界：基线或当前正文尚未取回（未加载/快照淘汰）时返回 []——
 * 返回「未知」而不是把整份文档误报为全部变更。
 */
export function computeChangedSectionsSinceRead(
  file: FileRecord,
  readingState?: ReadingState,
  contentCache?: Record<string, string>
): string[] {
  if (!readingState || !readingState.last_read_revision_id) return [];
  const baselineId = readingState.last_read_revision_id;
  if (baselineId === file.current_revision_id) return [];

  const fromRev = file.revisions.find((r) => r.revision_id === baselineId);
  const toRev = file.revisions.find((r) => r.revision_id === file.current_revision_id);
  if (!fromRev || !toRev) return [];
  if (!fromRev.snapshotAvailable || !toRev.snapshotAvailable) return [];

  const oldText = revisionTextOf(fromRev, contentCache);
  const newText = revisionTextOf(toRev, contentCache);
  if (oldText === null || newText === null) return [];
  if (oldText === newText) return [];

  const oldSections = sectionFingerprintOf(oldText);
  const newSections = sectionFingerprintOf(newText);
  const changed: string[] = [];
  for (const [title, fingerprint] of newSections) {
    if (oldSections.get(title) !== fingerprint) changed.push(title);
  }
  for (const title of oldSections.keys()) {
    if (!newSections.has(title) && !changed.includes(title)) changed.push(title);
  }
  return changed;
}

/**
 * 9. 节点悬停预览卡片数据生成与动态画布坐标连线计算
 */
export interface NodeHoverPreviewData {
  fileId: string;
  title: string;
  relativePath: string;
  format: FileFormat;
  role: string;
  revisionId: string;
  versionNumber: number;
  totalRevisions: number;
  observedAt: string;
  modificationRoundId: string;
  modificationRoundLabel: string;
  coreSummary: string;
  revisionSummaryNote: string;
  unreadStatus: {
    isUnread: boolean;
    statusLabel: string;
    baselineRevisionId?: string;
    changedSections: string[];
    scrollPercent: number;
  };
}

export function buildNodeHoverPreviewData(
  file: FileRecord,
  readingState?: ReadingState,
  targetRevisionId?: string
): NodeHoverPreviewData {
  const rev =
    file.revisions.find((r) => r.revision_id === (targetRevisionId || file.current_revision_id)) ||
    file.revisions[file.revisions.length - 1];

  const unreadInfo = hasUnreadChanges(file, readingState);

  let coreSummary = rev.summaryNote;
  if (file.format === 'md' && rev.markdownContent) {
    const sections = parseMarkdownOutline(rev.markdownContent);
    const coreSec = sections.find((s) => s.isExplicitCallout === '核心结论') || sections[0];
    if (coreSec?.summaryText) {
      coreSummary = coreSec.summaryText;
    }
  } else if (file.format === 'svg' && rev.svgExtractedTexts && rev.svgExtractedTexts.length > 0) {
    coreSummary = `可检索图形文字 (${rev.svgExtractedTexts.length} 处)：${rev.svgExtractedTexts
      .slice(0, 3)
      .join(' · ')}`;
  } else if (file.format === 'pdf') {
    coreSummary =
      rev.pdfPages?.[0]?.extractedText ||
      file.pdfStatusReason ||
      rev.summaryNote;
  }

  const statusLabel = unreadStatusLabel(unreadInfo.reason);

  const modificationRoundId = rev.agent_turn_hint || rev.revision_id;
  const modificationRoundLabel = rev.agent_turn_hint
    ? `写入轮次 ${rev.agent_turn_hint} · ${formatLocalClock(rev.observed_at)}`
    : `v${rev.versionNumber} · 观察于 ${formatLocalStamp(rev.observed_at)}`;

  return {
    fileId: file.file_id,
    title: file.title,
    relativePath: file.relative_path,
    format: file.format,
    role: file.role,
    revisionId: rev.revision_id,
    versionNumber: rev.versionNumber,
    totalRevisions: file.revisions.length,
    observedAt: formatLocalStamp(rev.observed_at),
    modificationRoundId,
    modificationRoundLabel,
    coreSummary,
    revisionSummaryNote: rev.summaryNote,
    unreadStatus: {
      isUnread: unreadInfo.isUnread,
      statusLabel,
      baselineRevisionId: readingState?.last_read_revision_id,
      changedSections:
        unreadInfo.changedSectionsSinceRead.length > 0
          ? unreadInfo.changedSectionsSinceRead
          : rev.changedSectionsFromPrev || [],
      scrollPercent: readingState?.scrollPercent ?? 0,
    },
  };
}

export function computeDynamicEdgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  mode: 'source_to_trunk' | 'trunk_to_subagent' | 'subagent_to_merge'
): string {
  if (mode === 'source_to_trunk') {
    const dx = Math.max(24, Math.abs(to.x - from.x) * 0.55);
    return `M ${Math.round(from.x)} ${Math.round(from.y)} C ${Math.round(
      from.x + dx
    )} ${Math.round(from.y)}, ${Math.round(to.x - dx * 0.4)} ${Math.round(
      to.y - 14
    )}, ${Math.round(to.x)} ${Math.round(to.y)}`;
  }
  if (mode === 'trunk_to_subagent') {
    const midX = Math.round(from.x + (to.x - from.x) * 0.45);
    return `M ${Math.round(from.x)} ${Math.round(from.y)} C ${midX} ${Math.round(
      from.y
    )}, ${midX} ${Math.round(to.y)}, ${Math.round(to.x)} ${Math.round(to.y)}`;
  }
  const ctrlY1 = Math.round(from.y + (to.y - from.y) * 0.55);
  const ctrlY2 = Math.round(to.y - Math.max(20, (to.y - from.y) * 0.25));
  return `M ${Math.round(from.x)} ${Math.round(from.y)} C ${Math.round(
    from.x - 16
  )} ${ctrlY1}, ${Math.round(to.x + 28)} ${ctrlY2}, ${Math.round(
    to.x
  )} ${Math.round(to.y)}`;
}

export function computeFanOutBounds(
  subagentBoxes: Array<{ x: number; y: number; width: number; height: number }>,
  isCollapsed: boolean
): { x: number; y: number; width: number; height: number } {
  if (subagentBoxes.length === 0) {
    return { x: 418, y: 192, width: 358, height: isCollapsed ? 108 : 374 };
  }
  const minX = Math.min(...subagentBoxes.map((b) => b.x));
  const minY = Math.min(...subagentBoxes.map((b) => b.y));
  const maxX = Math.max(...subagentBoxes.map((b) => b.x + b.width));
  const maxY = Math.max(...subagentBoxes.map((b) => b.y + b.height));

  const padX = 14;
  const headerHeight = 46;
  const padBottom = 14;

  return {
    x: minX - padX,
    y: minY - headerHeight,
    width: Math.max(330, maxX - minX + padX * 2),
    height: isCollapsed ? 108 : maxY - minY + headerHeight + padBottom,
  };
}

