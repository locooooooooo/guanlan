import { normalizeFormatToken } from './formatMeta';

export type CodeLanguage =
  | 'rust'
  | 'ts'
  | 'python'
  | 'go'
  | 'json'
  | 'toml'
  | 'shell'
  | 'sql'
  | 'css'
  | 'markup'
  | 'plain';

export type CodeTokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'type'
  | 'attr'
  | 'punct';

export interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

export interface TokenizedCodeLine {
  lineNumber: number;
  raw: string;
  tokens: CodeToken[];
}

export interface CodeSymbol {
  line: number;
  name: string;
  kind: 'fn' | 'struct' | 'enum' | 'trait' | 'impl' | 'mod' | 'class' | 'interface' | 'type' | 'const' | 'section';
  indent: number;
}

export interface CodeSearchMatch {
  line: number;
  start: number;
  end: number;
}

const EXT_TO_LANG: Record<string, CodeLanguage> = {
  rs: 'rust',
  ts: 'ts',
  tsx: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  mts: 'ts',
  cts: 'ts',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  go: 'go',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  toml: 'toml',
  ini: 'toml',
  cfg: 'toml',
  conf: 'toml',
  yaml: 'toml',
  yml: 'toml',
  env: 'toml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'shell',
  bat: 'shell',
  cmd: 'shell',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  html: 'markup',
  htm: 'markup',
  xhtml: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
};

const KEYWORDS_BY_LANG: Record<CodeLanguage, ReadonlySet<string>> = {
  rust: new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
    'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move',
    'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true',
    'type', 'unsafe', 'use', 'where', 'while',
  ]),
  ts: new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
    'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new',
    'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'super',
    'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void',
    'while', 'yield',
  ]),
  python: new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while',
    'with', 'yield',
  ]),
  go: new Set([
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'false', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'nil', 'package',
    'range', 'return', 'select', 'struct', 'switch', 'true', 'type', 'var',
  ]),
  json: new Set(['true', 'false', 'null']),
  toml: new Set(['true', 'false', 'null']),
  shell: new Set([
    'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in',
    'local', 'return', 'then', 'until', 'while',
  ]),
  sql: new Set([
    'AND', 'AS', 'ASC', 'BY', 'CREATE', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'FROM', 'GROUP',
    'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'LEFT', 'LIMIT', 'NOT',
    'NULL', 'ON', 'OR', 'ORDER', 'PRIMARY', 'SELECT', 'SET', 'TABLE', 'UNION', 'UPDATE',
    'VALUES', 'WHERE', 'and', 'as', 'asc', 'by', 'create', 'delete', 'desc', 'from', 'group',
    'in', 'insert', 'into', 'is', 'join', 'left', 'limit', 'not', 'null', 'on', 'or', 'order',
    'select', 'set', 'table', 'update', 'values', 'where',
  ]),
  css: new Set(['from', 'to', 'important', 'and', 'not', 'only', 'screen']),
  markup: new Set(['DOCTYPE', 'html', 'svg']),
  plain: new Set(),
};

const TYPE_WORDS = new Set([
  'String', 'str', 'Vec', 'Option', 'Result', 'Box', 'Arc', 'Rc', 'HashMap', 'HashSet',
  'BTreeMap', 'BTreeSet', 'usize', 'isize', 'u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32',
  'i64', 'f32', 'f64', 'bool', 'char', 'React', 'Promise', 'Record', 'Map', 'Set', 'Array',
  'ReadonlyArray', 'ReadonlySet', 'ReadonlyMap', 'Partial', 'number', 'string', 'boolean',
  'unknown', 'never', 'any', 'object', 'Error', 'Date', 'Buffer', 'int', 'float', 'dict', 'list',
  'tuple', 'error', 'byte', 'rune',
]);

/** 按扩展名解析源码高亮语言家族。 */
export function resolveCodeLanguage(format: string | null | undefined): CodeLanguage {
  const token = normalizeFormatToken(format);
  return EXT_TO_LANG[token] ?? 'plain';
}

function lineCommentPrefixOf(lang: CodeLanguage): string | null {
  if (lang === 'python' || lang === 'toml' || lang === 'shell') return '#';
  if (lang === 'sql') return '--';
  if (lang === 'plain' || lang === 'markup') return null;
  return '//';
}

function supportsBlockComments(lang: CodeLanguage): boolean {
  return lang === 'rust' || lang === 'ts' || lang === 'go' || lang === 'css' || lang === 'sql';
}

function pushToken(out: CodeToken[], text: string, kind: CodeTokenKind): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    out.push({ text, kind });
  }
}

/** 将源码文本按行词法切分为带语义 Token 的行数组（支持跨行块注释）。 */
export function tokenizeCodeLines(
  text: string,
  format: string | null | undefined
): TokenizedCodeLine[] {
  const lang = resolveCodeLanguage(format);
  const rawLines = text.split(/\r?\n/);
  const keywords = KEYWORDS_BY_LANG[lang];
  const lineComment = lineCommentPrefixOf(lang);
  const blockComments = supportsBlockComments(lang);
  let inBlockComment = false;

  return rawLines.map((raw, idx) => {
    const tokens: CodeToken[] = [];
    if (lang === 'plain') {
      if (raw) tokens.push({ text: raw, kind: 'plain' });
      return { lineNumber: idx + 1, raw, tokens };
    }

    let i = 0;
    const n = raw.length;
    while (i < n) {
      if (inBlockComment) {
        const endIdx = raw.indexOf('*/', i);
        if (endIdx === -1) {
          pushToken(tokens, raw.slice(i), 'comment');
          i = n;
          break;
        }
        pushToken(tokens, raw.slice(i, endIdx + 2), 'comment');
        i = endIdx + 2;
        inBlockComment = false;
        continue;
      }

      if (blockComments && raw[i] === '/' && raw[i + 1] === '*') {
        const endIdx = raw.indexOf('*/', i + 2);
        if (endIdx === -1) {
          pushToken(tokens, raw.slice(i), 'comment');
          inBlockComment = true;
          break;
        }
        pushToken(tokens, raw.slice(i, endIdx + 2), 'comment');
        i = endIdx + 2;
        continue;
      }

      if (lineComment && raw.startsWith(lineComment, i)) {
        pushToken(tokens, raw.slice(i), 'comment');
        break;
      }

      if (lang === 'markup' && raw.startsWith('<!--', i)) {
        const endIdx = raw.indexOf('-->', i + 4);
        if (endIdx === -1) {
          pushToken(tokens, raw.slice(i), 'comment');
          break;
        }
        pushToken(tokens, raw.slice(i, endIdx + 3), 'comment');
        i = endIdx + 3;
        continue;
      }

      const ch = raw[i];
      if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'ts' || lang === 'go' || lang === 'shell'))) {
        let j = i + 1;
        while (j < n) {
          if (raw[j] === '\\') {
            j += 2;
            continue;
          }
          if (raw[j] === ch) {
            j += 1;
            break;
          }
          j += 1;
        }
        pushToken(tokens, raw.slice(i, j), 'string');
        i = j;
        continue;
      }

      if ((lang === 'rust' && ch === '#' && raw[i + 1] === '[') || (ch === '@' && /[A-Za-z_]/.test(raw[i + 1] ?? ''))) {
        let j = i + 1;
        if (ch === '#') {
          while (j < n && raw[j] !== ']') j += 1;
          if (j < n) j += 1;
        } else {
          while (j < n && /[A-Za-z0-9_.]/.test(raw[j])) j += 1;
        }
        pushToken(tokens, raw.slice(i, j), 'attr');
        i = j;
        continue;
      }

      if (/[0-9]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[0-9a-fA-FxXoObB._]/.test(raw[j])) j += 1;
        pushToken(tokens, raw.slice(i, j), 'number');
        i = j;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_$]/.test(raw[j])) j += 1;
        const word = raw.slice(i, j);
        let kind: CodeTokenKind = 'plain';
        if (keywords.has(word)) {
          kind = 'keyword';
        } else if (TYPE_WORDS.has(word) || (/^[A-Z][A-Za-z0-9_]*$/.test(word) && word.length > 1)) {
          kind = 'type';
        }
        pushToken(tokens, word, kind);
        i = j;
        continue;
      }

      if (/[{}()[\].,:;+\-*/=<>!&|?~^%]/.test(ch)) {
        pushToken(tokens, ch, 'punct');
        i += 1;
        continue;
      }

      let j = i + 1;
      while (j < n && /\s/.test(raw[j])) j += 1;
      pushToken(tokens, raw.slice(i, j), 'plain');
      i = j;
    }

    return { lineNumber: idx + 1, raw, tokens };
  });
}

/** 从源码中抽取结构化符号大纲（函数、结构体、枚举、类、接口、配置节）。 */
export function extractCodeSymbols(
  text: string,
  format: string | null | undefined
): CodeSymbol[] {
  const lang = resolveCodeLanguage(format);
  const lines = text.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];

  lines.forEach((raw, idx) => {
    const line = idx + 1;
    const indent = raw.search(/\S/);
    if (indent < 0) return;
    const trimmed = raw.trim();

    if (lang === 'rust') {
      const mFn = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (mFn) { symbols.push({ line, name: mFn[1], kind: 'fn', indent }); return; }
      const mStruct = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (mStruct) { symbols.push({ line, name: mStruct[1], kind: 'struct', indent }); return; }
      const mEnum = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (mEnum) { symbols.push({ line, name: mEnum[1], kind: 'enum', indent }); return; }
      const mTrait = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (mTrait) { symbols.push({ line, name: mTrait[1], kind: 'trait', indent }); return; }
      const mImpl = trimmed.match(/^impl(?:<[^>]+>)?\s+(?:([A-Za-z_][A-Za-z0-9_:]*)(?:\s+for\s+([A-Za-z_][A-Za-z0-9_:]*))?)/);
      if (mImpl) {
        const label = mImpl[2] ? `${mImpl[1]} for ${mImpl[2]}` : mImpl[1];
        symbols.push({ line, name: label, kind: 'impl', indent });
        return;
      }
      const mMod = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
      if (mMod) { symbols.push({ line, name: mMod[1], kind: 'mod', indent }); }
      return;
    }

    if (lang === 'ts') {
      const mFn = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (mFn) { symbols.push({ line, name: mFn[1], kind: 'fn', indent }); return; }
      const mClass = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (mClass) { symbols.push({ line, name: mClass[1], kind: 'class', indent }); return; }
      const mIface = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (mIface) { symbols.push({ line, name: mIface[1], kind: 'interface', indent }); return; }
      const mType = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
      if (mType) { symbols.push({ line, name: mType[1], kind: 'type', indent }); return; }
      const mConstFn = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|React\.memo\()/);
      if (mConstFn) { symbols.push({ line, name: mConstFn[1], kind: 'fn', indent }); }
      return;
    }

    if (lang === 'python') {
      const mDef = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (mDef) { symbols.push({ line, name: mDef[1], kind: 'fn', indent }); return; }
      const mCls = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (mCls) { symbols.push({ line, name: mCls[1], kind: 'class', indent }); }
      return;
    }

    if (lang === 'go') {
      const mFunc = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
      if (mFunc) { symbols.push({ line, name: mFunc[1], kind: 'fn', indent }); return; }
      const mStruct = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/);
      if (mStruct) {
        symbols.push({ line, name: mStruct[1], kind: mStruct[2] === 'interface' ? 'interface' : 'struct', indent });
      }
      return;
    }

    if (lang === 'toml') {
      const mSec = trimmed.match(/^\[+([^\]]+)\]+$/);
      if (mSec) { symbols.push({ line, name: mSec[1].trim(), kind: 'section', indent }); }
    }
  });

  return symbols;
}

/** 计算可折叠代码块映射（起始 1-based 行号 -> 结束 1-based 行号，跨度 >= 3 行才入列）。 */
export function computeFoldableRanges(
  text: string,
  format: string | null | undefined
): Map<number, number> {
  const lang = resolveCodeLanguage(format);
  const ranges = new Map<number, number>();
  if (lang === 'plain' || lang === 'markup') return ranges;

  const lines = text.split(/\r?\n/);
  const stack: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNum = i + 1;
    let inString: string | null = null;
    for (let j = 0; j < raw.length; j += 1) {
      const ch = raw[j];
      if (inString) {
        if (ch === '\\') {
          j += 1;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '/' && raw[j + 1] === '/') break;
      if ((lang === 'toml' || lang === 'shell') && ch === '#') break;
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        continue;
      }
      if (ch === '{') {
        stack.push(lineNum);
      } else if (ch === '}' && stack.length > 0) {
        const startLine = stack.pop()!;
        if (lineNum - startLine >= 2 && !ranges.has(startLine)) {
          ranges.set(startLine, lineNum);
        }
      }
    }
  }

  return ranges;
}

export const MAX_CODE_SEARCH_MATCHES = 2000;

/** 大小写不敏感地检索源码行命中区间（1-based line，0-based 列偏移）。 */
export function findCodeMatches(
  lines: readonly string[],
  query: string
): CodeSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: CodeSearchMatch[] = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const hay = lines[idx].toLowerCase();
    let pos = 0;
    while (pos <= hay.length - needle.length) {
      const hit = hay.indexOf(needle, pos);
      if (hit === -1) break;
      matches.push({ line: idx + 1, start: hit, end: hit + needle.length });
      if (matches.length >= MAX_CODE_SEARCH_MATCHES) return matches;
      pos = hit + Math.max(1, needle.length);
    }
  }
  return matches;
}
