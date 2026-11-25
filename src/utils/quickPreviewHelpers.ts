/**
 * QuickLook 轻预览纯函数工具与零竞态请求协调器。
 *
 * 职责：
 * 1. 线性时间 O(n) 语法词法切分（JSON / YAML / TOML / 代码 / Markdown），绝不用回溯正则；
 * 2. RFC-4180 兼容 CSV / TSV 表格解析与数值列识别；
 * 3. 带 AbortController + 单调序号 + LRU 缓存（上限 64 条）的零竞态轻预览加载器。
 */

import type { ApiResult, RevisionPreviewResponse } from '../services/workspaceClient';

export type SyntaxTokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'key'
  | 'heading'
  | 'badge';

export interface SyntaxToken {
  kind: SyntaxTokenKind;
  text: string;
}

const CODE_KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'crate',
  'def',
  'default',
  'defer',
  'delete',
  'do',
  'elif',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'fn',
  'for',
  'from',
  'func',
  'function',
  'go',
  'if',
  'impl',
  'import',
  'in',
  'interface',
  'is',
  'let',
  'loop',
  'match',
  'mod',
  'mut',
  'new',
  'None',
  'null',
  'package',
  'pass',
  'private',
  'pub',
  'public',
  'raise',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'trait',
  'true',
  'True',
  'False',
  'try',
  'type',
  'typeof',
  'undefined',
  'use',
  'var',
  'void',
  'where',
  'while',
  'with',
  'yield',
]);

const MAX_HIGHLIGHT_LINE_CHARS = 2000;

/**
 * 线性时间单行语法着色（用于 QuickLook 轻预览代码 / JSON / YAML / Markdown）。
 */
export function tokenizeCodeLine(line: string, format: string): SyntaxToken[] {
  if (!line) return [{ kind: 'plain', text: '' }];
  const fmt = format.trim().replace(/^\./, '').toLowerCase();

  if (line.length > MAX_HIGHLIGHT_LINE_CHARS) {
    return [{ kind: 'plain', text: line }];
  }

  // Markdown：标题、列表、引用与待确认决策标记
  if (fmt === 'md' || fmt === 'mdx' || fmt === 'markdown' || fmt === 'rmd') {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      return [{ kind: 'heading', text: line }];
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      return [{ kind: 'comment', text: line }];
    }
    if (trimmed.startsWith('>')) {
      return [{ kind: 'string', text: line }];
    }
    const markerIdx = line.search(/\[P[0-2]\s*[-–—]/);
    if (markerIdx >= 0) {
      const closeIdx = line.indexOf(']', markerIdx);
      if (closeIdx > markerIdx) {
        const tokens: SyntaxToken[] = [];
        if (markerIdx > 0) tokens.push({ kind: 'plain', text: line.slice(0, markerIdx) });
        tokens.push({ kind: 'badge', text: line.slice(markerIdx, closeIdx + 1) });
        if (closeIdx + 1 < line.length) {
          tokens.push({ kind: 'plain', text: line.slice(closeIdx + 1) });
        }
        return tokens;
      }
    }
    return [{ kind: 'plain', text: line }];
  }

  const isYamlLike =
    fmt === 'yaml' || fmt === 'yml' || fmt === 'toml' || fmt === 'ini' || fmt === 'conf' || fmt === 'env';
  const isJsonLike = fmt === 'json' || fmt === 'json5' || fmt === 'jsonc' || fmt === 'jsonl' || fmt === 'ndjson';
  const isHashCommentLang =
    isYamlLike ||
    fmt === 'py' ||
    fmt === 'pyi' ||
    fmt === 'rb' ||
    fmt === 'sh' ||
    fmt === 'bash' ||
    fmt === 'zsh' ||
    fmt === 'fish' ||
    fmt === 'ps1' ||
    fmt === 'r' ||
    fmt === 'dockerfile';

  const tokens: SyntaxToken[] = [];
  const push = (kind: SyntaxTokenKind, text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      tokens.push({ kind, text });
    }
  };

  let i = 0;
  const n = line.length;

  // YAML / TOML key: value 开头快速高亮
  if (isYamlLike) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      return [{ kind: 'comment', text: line }];
    }
    if (trimmed.startsWith('[')) {
      return [{ kind: 'heading', text: line }];
    }
    const colonIdx = line.indexOf(':');
    const eqIdx = line.indexOf('=');
    const sepIdx =
      colonIdx > 0 && (eqIdx < 0 || colonIdx < eqIdx)
        ? colonIdx
        : eqIdx > 0
          ? eqIdx
          : -1;
    if (sepIdx > 0) {
      const before = line.slice(0, sepIdx);
      if (!before.includes('"') && !before.includes("'")) {
        push('key', before);
        push('plain', line[sepIdx]);
        i = sepIdx + 1;
      }
    }
  }

  while (i < n) {
    const ch = line[i];

    // 行内注释 // 或 --（SQL）或 #
    if (ch === '/' && i + 1 < n && line[i + 1] === '/') {
      push('comment', line.slice(i));
      break;
    }
    if (ch === '#' && isHashCommentLang) {
      push('comment', line.slice(i));
      break;
    }
    if (ch === '-' && i + 1 < n && line[i + 1] === '-' && fmt === 'sql') {
      push('comment', line.slice(i));
      break;
    }

    // 字符串字面量 "..." / '...' / `...`
    if (ch === '"' || ch === '\'' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const lit = line.slice(i, j);
      // JSON key 识别："key": ...
      let isJsonKey = false;
      if (isJsonLike && quote === '"') {
        let k = j;
        while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
        if (k < n && line[k] === ':') isJsonKey = true;
      }
      push(isJsonKey ? 'key' : 'string', lit);
      i = j;
      continue;
    }

    // 数字字面量
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '-' && i + 1 < n && line[i + 1] >= '0' && line[i + 1] <= '9' && (i === 0 || !isIdentChar(line[i - 1])))
    ) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXbBoO._]/.test(line[j])) {
        j += 1;
      }
      push('number', line.slice(i, j));
      i = j;
      continue;
    }

    // 标识符与关键字
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentChar(line[j])) j += 1;
      const word = line.slice(i, j);
      if (CODE_KEYWORDS.has(word)) {
        push('keyword', word);
      } else {
        push('plain', word);
      }
      i = j;
      continue;
    }

    push('plain', ch);
    i += 1;
  }

  return tokens;
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * 尝试对完整合法 JSON（≤ 64 KiB）做美化排版；截断或不合法时安全返回 null。
 */
export function tryPrettyJson(text: string): string | null {
  if (!text || text.length > 65_536) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

export interface ParsedDelimitedTable {
  headers: string[];
  rows: string[][];
  totalParsedRows: number;
  columnCount: number;
  rowCapped: boolean;
}

/**
 * RFC-4180 兼容 CSV/TSV 解析器（支持引号内逗号与 "" 转义），按需上限截断防卡顿。
 */
export function parseDelimitedTable(
  text: string,
  delimiter: ',' | '\t' = ',',
  maxRows = 250
): ParsedDelimitedTable {
  if (!text) {
    return { headers: [], rows: [], totalParsedRows: 0, columnCount: 0, rowCapped: false };
  }

  const allRows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      row.push(cell);
      cell = '';
      if (row.some((c) => c.length > 0) || row.length > 1) {
        allRows.push(row);
      }
      row = [];
      if (ch === '\r' && i + 1 < n && text[i + 1] === '\n') {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    cell += ch;
    i += 1;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.length > 0) || row.length > 1) {
      allRows.push(row);
    }
  }

  if (allRows.length === 0) {
    return { headers: [], rows: [], totalParsedRows: 0, columnCount: 0, rowCapped: false };
  }

  const headers = allRows[0];
  const body = allRows.slice(1);
  const columnCount = Math.max(headers.length, ...body.slice(0, maxRows).map((r) => r.length));
  const rowCapped = body.length > maxRows;

  return {
    headers,
    rows: body.slice(0, maxRows),
    totalParsedRows: body.length,
    columnCount,
    rowCapped,
  };
}

export function isNumericCell(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^-?\d+(?:\.\d+)?%?$/.test(trimmed);
}

/** 格式化体积演进差值（如 +12.4 KiB / -512 B / 无变化） */
export function formatDeltaBytes(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return '初版';
  if (delta === 0) return '0 B';
  const sign = delta > 0 ? '+' : '-';
  const abs = Math.abs(delta);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MiB`;
  return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// ===== QuickPreview LRU 缓存与零竞态协调器 =====

const CACHE_CAP = 64;
const previewCache = new Map<string, RevisionPreviewResponse>();

function cacheKey(revisionId: string, offset: number): string {
  return `${revisionId}:${offset}`;
}

export function getCachedQuickPreview(
  revisionId: string,
  offset = 0
): RevisionPreviewResponse | null {
  const key = cacheKey(revisionId, offset);
  const hit = previewCache.get(key);
  if (!hit) return null;
  // LRU refresh
  previewCache.delete(key);
  previewCache.set(key, hit);
  return hit;
}

export function putCachedQuickPreview(
  revisionId: string,
  offset: number,
  data: RevisionPreviewResponse
): void {
  const key = cacheKey(revisionId, offset);
  if (previewCache.has(key)) previewCache.delete(key);
  previewCache.set(key, data);
  while (previewCache.size > CACHE_CAP) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
    else break;
  }
}

export function clearQuickPreviewCache(): void {
  previewCache.clear();
}

export type PreviewFetchFn = (
  revisionId: string,
  opts: { offset?: number; maxBytes?: number; signal?: AbortSignal }
) => Promise<ApiResult<RevisionPreviewResponse>>;

export interface QuickPreviewOutcome {
  status: 'ok' | 'aborted' | 'stale' | 'error';
  data?: RevisionPreviewResponse;
  error?: string;
  code?: string;
  fromCache?: boolean;
}

/**
 * 零竞态轻预览调度器：
 * - 每次 `load()` 立即 abort 上一次仍在途的请求；
 * - 单调递增序号保证即使底层 fetch 未支持 signal，迟到响应也会被标为 stale 丢弃；
 * - 命中 LRU 缓存时同步级直接返回，确保方向键连续切换 20+ 文件零闪烁、零竞态。
 */
export class QuickPreviewCoordinator {
  private activeController: AbortController | null = null;
  private latestSeq = 0;

  constructor(private readonly fetcher: PreviewFetchFn) {}

  cancelInFlight(): void {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
    this.latestSeq += 1;
  }

  async load(
    revisionId: string,
    opts: { offset?: number; maxBytes?: number; bypassCache?: boolean } = {}
  ): Promise<QuickPreviewOutcome> {
    const offset = opts.offset ?? 0;
    this.cancelInFlight();
    const mySeq = this.latestSeq;

    if (!opts.bypassCache) {
      const cached = getCachedQuickPreview(revisionId, offset);
      if (cached) {
        return { status: 'ok', data: cached, fromCache: true };
      }
    }

    const controller = new AbortController();
    this.activeController = controller;

    try {
      const res = await this.fetcher(revisionId, {
        offset,
        maxBytes: opts.maxBytes,
        signal: controller.signal,
      });

      if (res.ok) {
        if (mySeq !== this.latestSeq || controller.signal.aborted) {
          return { status: controller.signal.aborted ? 'aborted' : 'stale' };
        }
        putCachedQuickPreview(revisionId, offset, res.data);
        return { status: 'ok', data: res.data, fromCache: false };
      }

      if (mySeq !== this.latestSeq || controller.signal.aborted || res.code === 'ABORTED') {
        return {
          status: res.code === 'ABORTED' || controller.signal.aborted ? 'aborted' : 'stale',
        };
      }

      return {
        status: 'error',
        code: res.code,
        error: res.error || '轻预览读取失败',
      };
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  async prefetch(revisionId: string): Promise<void> {
    if (!revisionId || getCachedQuickPreview(revisionId, 0)) return;
    try {
      const res = await this.fetcher(revisionId, { offset: 0 });
      if (res.ok) {
        putCachedQuickPreview(revisionId, 0, res.data);
      }
    } catch {
      /* 静默忽略预取失败 */
    }
  }
}
