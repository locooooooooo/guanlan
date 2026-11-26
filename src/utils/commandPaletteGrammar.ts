
/** 查询语法解析结果 */
export interface PaletteQuery {
  keyword: string;
  dateFrom?: string;
  dateTo?: string;
  types: string[];
  pendingDecisionOnly: boolean;
  initiativeQuery?: string;
  raw: string;
}

/** 高亮分段（hit=true 的片段渲染为高亮） */
export interface SnippetSegment {
  text: string;
  hit: boolean;
}

/** 摘要构建结果 */
export interface SnippetResult {
  segments: SnippetSegment[];
  clippedHead: boolean;
  clippedTail: boolean;
  lines: 1 | 2;
}

const BEFORE_CHARS = 16;
const MAX_WINDOW_CHARS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地日格式化（YYYY-MM-DD；与观测口径一致按本地时区取日） */
export function localDayOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 相对/绝对日期词 → 本地日（YYYY-MM-DD）。
 * 支持：今天 / 昨天 / 前天 / N天前 / N日前 / YYYY-MM-DD；null = 无法解析。
 */
export function resolveRelativeDay(text: string, now: Date): string | null {
  const t = text.trim().toLowerCase();
  if (DATE_RE.test(t)) return t;
  const dayMs = 24 * 60 * 60 * 1000;
  let offset: number | null = null;
  if (t === '今天' || t === 'today' || t === '今日') offset = 0;
  else if (t === '昨天' || t === 'yesterday' || t === '昨日') offset = -1;
  else if (t === '前天') offset = -2;
  else {
    const m = /^(\d{1,3})\s*天(?:前|之前)$/.exec(t);
    if (m) offset = -Number(m[1]);
  }
  if (offset === null) return null;
  return localDayOf(new Date(now.getTime() + offset * dayMs));
}

/**
 * 命令面板查询解析（入口纯函数）。
 * 语法 token 以空白分隔；`type:`/`status:`/`in:` 前缀大小写无关；`@` 必须在 token 首。
 */
export function parsePaletteQuery(rawQuery: string, now: Date = new Date()): PaletteQuery {
  const raw = rawQuery.trim();
  const out: PaletteQuery = {
    keyword: '',
    types: [],
    pendingDecisionOnly: false,
    raw,
  };
  const keywordParts: string[] = [];
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('@') && token.length > 1) {
      const day = resolveRelativeDay(token.slice(1), now);
      if (day) {
        out.dateFrom = day;
        out.dateTo = day;
        continue;
      }
      keywordParts.push(token);
      continue;
    }
    const lower = token.toLowerCase();
    if (lower.startsWith('type:') && lower.length > 5) {
      out.types.push(lower.slice(5));
      continue;
    }
    if (lower.startsWith('status:')) {
      const v = lower.slice(7);
      if (v === '待拍板' || v === 'pending' || v === 'p0' || v === 'p1') {
        out.pendingDecisionOnly = true;
        continue;
      }
      keywordParts.push(token);
      continue;
    }
    if (lower.startsWith('in:') && lower.length > 3) {
      out.initiativeQuery = token.slice(3);
      continue;
    }
    keywordParts.push(token);
  }
  out.keyword = keywordParts.join(' ');
  return out;
}

/**
 * 摘要窗口截取：从首个命中词前 BEFORE_CHARS 字符起，≤2 行、
 * ≤MAX_WINDOW_CHARS 字符（char 边界安全）。无命中词时从头截取（clippedHead=false）。
 */
export function buildSnippet(text: string, queryLower: string): SnippetResult {
  const plain = text;
  const lower = plain.toLowerCase();
  const q = queryLower.trim().toLowerCase();
  const firstHit = q ? lower.indexOf(q) : -1;

  let start = 0;
  let clippedHead = false;
  if (firstHit > BEFORE_CHARS) {
    start = firstHit - BEFORE_CHARS;
    clippedHead = true;
  } else if (firstHit >= 0) {
    start = Math.max(0, firstHit - BEFORE_CHARS);
  }

  let end = Math.min(plain.length, start + MAX_WINDOW_CHARS);
  let clippedTail = end < plain.length;
  {
    let lineNo = 0;
    for (let i = start; i < end; i++) {
      if (plain[i] === '\n') {
        lineNo++;
        if (lineNo === 2) {
          end = i;
          clippedTail = clippedTail || end < plain.length;
          break;
        }
      }
    }
  }
  const windowText = plain.slice(start, end);
  const lines = (windowText.match(/\n/g)?.length ?? 0) + 1;
  return {
    segments: buildHighlightSegments(windowText, q),
    clippedHead,
    clippedTail,
    lines: lines === 2 ? 2 : 1,
  };
}

/**
 * 窗口文本 → 高亮分段：窗口内所有命中词出现处（大小写不敏感）标记 hit。
 * 多词查询（含空格）时逐词标注；空查询整段单段。
 */
export function buildHighlightSegments(windowText: string, queryLower: string): SnippetSegment[] {
  const q = queryLower.trim().toLowerCase();
  if (!q || !windowText) return windowText ? [{ text: windowText, hit: false }] : [];
  const terms = Array.from(new Set(q.split(/\s+/).filter(Boolean)));
  const lower = windowText.toLowerCase();
  const hitMask = new Array<boolean>(windowText.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(term, from);
      if (idx < 0) break;
      for (let i = idx; i < idx + term.length; i++) hitMask[i] = true;
      from = idx + term.length;
    }
  }
  const segments: SnippetSegment[] = [];
  let current = '';
  let currentHit = hitMask[0] ?? false;
  for (let i = 0; i < windowText.length; i++) {
    const hit = hitMask[i];
    if (hit !== currentHit && current) {
      segments.push({ text: current, hit: currentHit });
      current = '';
    }
    currentHit = hit;
    current += windowText[i];
  }
  if (current) segments.push({ text: current, hit: currentHit });
  return segments;
}

/** 是否包含关键词（大小写不敏感子串；空关键词恒 true） */
export function matchesKeyword(haystack: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true;
  return haystack.toLowerCase().includes(k);
}
