#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'dist-release', '.git', 'public']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.rs']);

/** 注释默认是噪音，只有这五类留下。键是报告里的判定名，值是给人看的原因。 */
export const KEEP = {
  license: '许可头',
  doc: '公开 API 契约',
  reference: 'Issue / RFC 链接',
  prettier: 'prettier-ignore',
  safety: 'FFI / 平台约束',
};

const CODE_START = /^\s*\/\/\s*(?:const|let|var|function|if|for|while|return|import|export|await|else|try|catch|switch|case|break|continue|throw|class|interface|type|fn|pub|impl|use|struct|enum|match|mod)\b/;
const BANNER = /^\s*(?:\/\/+|\/\*+)\s*[-=*#~_+]{3,}/;
const SUPPRESSION = /eslint-disable|@ts-(?:ignore|expect-error|nocheck)/;

function lineEnd(text, from) {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

function skipQuoted(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    if (ch === '\n') return j;
    j += 1;
  }
  return j;
}

function prevCodeIndex(text, i, comments) {
  let j = i - 1;
  let ci = comments.length - 1;
  for (;;) {
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    while (ci >= 0 && comments[ci].start > j) ci -= 1;
    if (ci >= 0 && j >= comments[ci].start && j < comments[ci].end) {
      j = comments[ci].start - 1;
      ci -= 1;
      continue;
    }
    return j;
  }
}

function regexAllowedAfter(text, i, comments) {
  const j = prevCodeIndex(text, i, comments);
  if (j < 0) return true;
  if ('(,=:[!&|?{};+-*%~^<>'.includes(text[j])) return true;
  return /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(
    text.slice(Math.max(0, j - 10), j + 1),
  );
}

function jsxAllowedAfter(text, i, comments) {
  const j = prevCodeIndex(text, i, comments);
  if (j < 0) return true;
  const prev = text[j];
  if (prev === '>' && j > 0 && text[j - 1] === '=') return true;
  if ('(,=:[!&|?{};'.includes(prev)) return true;
  return /\b(?:return|case|default|else|yield|await|throw|do)$/.test(
    text.slice(Math.max(0, j - 10), j + 1),
  );
}

function skipJsxTypeArgs(text, i) {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '"' || ch === "'") {
      j = skipQuoted(text, j);
      continue;
    }
    if (ch === '=' && text[j + 1] === '>') {
      j += 2;
      continue;
    }
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return j + 1;
    } else if (ch === ';') {
      return -1;
    }
    j += 1;
  }
  return -1;
}

function tryScanJsxOpenTag(text, i, local) {
  const frag = /^<\s*>/.exec(text.slice(i, i + 16));
  if (frag) return { tag: '', selfClosing: false, end: i + frag[0].length };

  const nameMatch = /^<([A-Za-z_$][\w$.:-]*)/.exec(text.slice(i, i + 128));
  if (!nameMatch) return null;
  const tag = nameMatch[1];
  let j = i + nameMatch[0].length;

  if (text[j] === '<') {
    const afterArgs = skipJsxTypeArgs(text, j);
    if (afterArgs === -1) return null;
    j = afterArgs;
  }

  if (j < text.length && !/[\s/>]/.test(text[j])) return null;
  if (/^\s+extends(?:\s|$)/.test(text.slice(j, j + 24)) && !/^\s+extends\s*=/.test(text.slice(j, j + 24))) {
    return null;
  }

  while (j < text.length) {
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (j >= text.length) return null;
    if (text[j] === '/' && text[j + 1] === '>') return { tag, selfClosing: true, end: j + 2 };
    if (text[j] === '>') return { tag, selfClosing: false, end: j + 1 };
    if (text[j] === '/' && text[j + 1] === '/') {
      const end = lineEnd(text, j);
      local.push({ start: j, end, kind: 'line', body: text.slice(j, end) });
      j = end;
      continue;
    }
    if (text[j] === '/' && text[j + 1] === '*') {
      const close = text.indexOf('*/', j + 2);
      if (close === -1) return null;
      const end = close + 2;
      const jsdoc = text[j + 2] === '*' && text[j + 3] !== '/';
      local.push({ start: j, end, kind: jsdoc ? 'jsdoc' : 'block', body: text.slice(j, end) });
      j = end;
      continue;
    }
    if (text[j] === '{') {
      j = scanTsCode(text, j + 1, true, true, local);
      continue;
    }
    const attrMatch = /^[A-Za-z_$][\w$:-]*/.exec(text.slice(j, j + 128));
    if (!attrMatch) return null;
    j += attrMatch[0].length;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] === '=') {
      j += 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '"' || text[j] === "'") {
        const close = text.indexOf(text[j], j + 1);
        if (close === -1) return null;
        j = close + 1;
      } else if (text[j] === '{') {
        j = scanTsCode(text, j + 1, true, true, local);
      } else {
        return null;
      }
    }
  }
  return null;
}

function tryScanJsxElement(text, i, comments) {
  const local = [];
  const open = tryScanJsxOpenTag(text, i, local);
  if (!open) return -1;
  if (open.selfClosing) {
    comments.push(...local);
    return open.end;
  }
  let j = open.end;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '{') {
      j = scanTsCode(text, j + 1, true, true, local);
      continue;
    }
    if (ch === '<') {
      if (text[j + 1] === '/') {
        const closeMatch = /^<\/\s*([A-Za-z_$][\w$.:-]*)?\s*>/.exec(text.slice(j, j + 128));
        if (closeMatch && (closeMatch[1] ?? '') === open.tag) {
          comments.push(...local);
          return j + closeMatch[0].length;
        }
        return -1;
      }
      const childEnd = tryScanJsxElement(text, j, local);
      if (childEnd !== -1) {
        j = childEnd;
        continue;
      }
    }
    j += 1;
  }
  return -1;
}

function skipRegex(text, i) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '\n') return j;
    if (inClass) {
      if (ch === ']') inClass = false;
      j += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      j += 1;
      continue;
    }
    if (ch === '/') return j + 1;
    j += 1;
  }
  return j;
}

function skipTemplate(text, from, jsx, comments) {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && text[i + 1] === '{') {
      i = scanTsCode(text, i + 2, true, jsx, comments);
      continue;
    }
    i += 1;
  }
  return i;
}

function scanTsCode(text, start, stopAtBrace, jsx, comments) {
  let i = start;
  let braces = 0;
  while (i < text.length) {
    const ch = text[i];
    if (stopAtBrace) {
      if (ch === '{') {
        braces += 1;
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (braces === 0) return i + 1;
        braces -= 1;
        i += 1;
        continue;
      }
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = lineEnd(text, i);
      comments.push({ start: i, end, kind: 'line', body: text.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        i += 2;
        continue;
      }
      const end = close + 2;
      const jsdoc = text[i + 2] === '*' && text[i + 3] !== '/';
      comments.push({ start: i, end, kind: jsdoc ? 'jsdoc' : 'block', body: text.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(text, i + 1, jsx, comments);
      continue;
    }
    if (jsx && ch === '<' && jsxAllowedAfter(text, i, comments)) {
      const end = tryScanJsxElement(text, i, comments);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (ch === '/' && regexAllowedAfter(text, i, comments)) {
      i = skipRegex(text, i);
      continue;
    }
    i += 1;
  }
  return i;
}

/** 扫描 TS / TSX / JS 源码，返回每条注释的起止偏移与种类。字符串、模板字面量、正则与 JSX 文本里的斜杠不算注释。 */
export function scanTs(text, jsx = false) {
  const comments = [];
  scanTsCode(text, 0, false, jsx, comments);
  return comments.sort((a, b) => a.start - b.start);
}

function rawStringEnd(text, i) {
  const match = /^(?:b|c)?r(#{0,16})"/.exec(text.slice(i, i + 24));
  if (!match) return -1;
  const close = `"${match[1]}`;
  const closeAt = text.indexOf(close, i + match[0].length);
  return closeAt === -1 ? text.length : closeAt + close.length;
}

function skipRustString(text, i) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] === '"') return j + 1;
    j += 1;
  }
  return j;
}

function skipRustQuote(text, i) {
  if (text[i + 1] === '\\') {
    let j = i + 2;
    while (j < text.length && text[j] !== "'") j += 1;
    return j + 1;
  }
  if (text[i + 1] !== undefined && text[i + 2] === "'" && text[i + 1] !== '\n') return i + 3;
  let j = i + 1;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
  return j;
}

/** 扫描 Rust 源码。认得原生字符串、字节字符串、字符字面量、生命周期与可嵌套的块注释。 */
export function scanRust(text) {
  const comments = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const end = lineEnd(text, i);
      const third = text[i + 2];
      const kind = third === '/' ? 'outer-doc' : third === '!' ? 'inner-doc' : 'line';
      comments.push({ start: i, end, kind, body: text.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      let level = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === '/' && text[j + 1] === '*') {
          level += 1;
          j += 2;
          continue;
        }
        if (text[j] === '*' && text[j + 1] === '/') {
          level -= 1;
          j += 2;
          if (level === 0) break;
          continue;
        }
        j += 1;
      }
      if (level !== 0) {
        i += 2;
        continue;
      }
      comments.push({ start: i, end: j, kind: 'block', body: text.slice(i, j) });
      i = j;
      continue;
    }
    const rawEnd = ch === 'r' || ch === 'b' || ch === 'c' ? rawStringEnd(text, i) : -1;
    if (rawEnd !== -1) {
      i = rawEnd;
      continue;
    }
    if (ch === '"') {
      i = skipRustString(text, i);
      continue;
    }
    if (ch === "'") {
      i = skipRustQuote(text, i);
      continue;
    }
    i += 1;
  }
  return comments;
}

function skipBalanced(text, i, open, close) {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '"' || ch === "'") {
      j = ch === '"' ? skipRustString(text, j) : skipRustQuote(text, j);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return j;
}

function nextTsDeclaration(text, end) {
  let i = end;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== '@') break;
    i += 1;
    while (i < text.length && /[\w$.]/.test(text[i])) i += 1;
    let j = i;
    while (j < text.length && /[ \t]/.test(text[j])) j += 1;
    i = text[j] === '(' ? skipBalanced(text, j, '(', ')') : j;
  }
  return text.slice(i, i + 24);
}

function nextRustDeclaration(text, end) {
  let i = end;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === '#' && text[i + 1] === '[') {
      i = skipBalanced(text, i + 1, '[', ']');
      continue;
    }
    break;
  }
  return text.slice(i, i + 24);
}

function isLicense(body) {
  return /copyright|spdx-license-identifier|licensed under|all rights reserved/i.test(body);
}

function isReference(body) {
  return (
    /https?:\/\//.test(body) ||
    /\b(?:RFC|ADR)[\s-]?\d+/i.test(body) ||
    /\b(?:issues|pull)\/\d+\b/.test(body) ||
    /\b(?:fix(?:es|ed)?|closes|refs?)\s+#\d+/i.test(body)
  );
}

/** 判定一条注释留不留。返回 KEEP 的键，或 null 表示该删。 */
export function classify(comment, text, isFirst) {
  const body = comment.body;
  if (isFirst && isLicense(body)) return 'license';
  if (/prettier-ignore/.test(body)) return 'prettier';
  if (isReference(body)) return 'reference';
  if (comment.kind === 'jsdoc' && /@(?:typedef|callback|type|satisfies|template)\b/.test(body)) return 'doc';
  if (comment.kind === 'jsdoc' && /^export\b/.test(nextTsDeclaration(text, comment.end).trimStart())) return 'doc';
  if (comment.kind === 'outer-doc' && /^pub\s+[^\s(]/.test(nextRustDeclaration(text, comment.end).trimStart())) return 'doc';
  if (comment.kind === 'inner-doc') return 'doc';
  if (comment.kind === 'line' && /^\s*\/\/\s*SAFETY:/.test(body)) return 'safety';
  return null;
}

/** 判定名：报告里说明一条注释为什么该删。 */
export function killReason(comment) {
  if (SUPPRESSION.test(comment.body)) return 'lint 抑制';
  if (BANNER.test(comment.body)) return '横幅分隔';
  if (CODE_START.test(comment.body)) return '被注释掉的代码';
  return '叙述';
}

function pair(text, comments) {
  const blocks = [];
  const runs = new Map();
  for (let i = 0; i < comments.length; i += 1) {
    const comment = comments[i];
    if (comment.kind !== 'outer-doc' && comment.kind !== 'inner-doc') continue;
    if (runs.has(comment.start)) continue;
    let end = comment.end;
    let j = i;
    while (j + 1 < comments.length && comments[j + 1].kind === comment.kind) {
      const between = text.slice(comments[j].end, comments[j + 1].start);
      if (!/^\r?\n[ \t]*$/.test(between)) break;
      end = comments[j + 1].end;
      j += 1;
    }
    for (let k = i; k <= j; k += 1) runs.set(comments[k].start, end);
  }
  for (let i = 0; i < comments.length; i += 1) {
    const comment = comments[i];
    const docEnd = runs.get(comment.start);
    const probe = docEnd === undefined ? comment : { ...comment, end: docEnd };
    blocks.push({ ...comment, keep: classify(probe, text, i === 0) });
  }
  return blocks;
}

/** 扫描并判定一份源码里的全部注释。`file` 只用来选语言。 */
export function lintText(text, file = 'a.ts') {
  const jsx = file.endsWith('.tsx') || file.endsWith('.jsx');
  const comments = file.endsWith('.rs') ? scanRust(text) : scanTs(text, jsx);
  return pair(text, comments);
}

function removalRange(text, block, jsx) {
  const tight = jsx && text[block.start - 1] === '{' && text[block.end] === '}';
  return tight ? { start: block.start - 1, end: block.end + 1 } : { start: block.start, end: block.end };
}

/** 按偏移删除注释；整行只剩注释的连同换行一起丢掉。返回修好的源码。 */
export function fixText(text, blocks, file = '') {
  const jsx = file.endsWith('.tsx') || file.endsWith('.jsx');
  const ranges = blocks
    .filter((block) => block.keep === null)
    .map((block) => removalRange(text, block, jsx))
    .sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return text;
  const lines = [];
  let lineStart = 0;
  for (;;) {
    const terminated = text.indexOf('\n', lineStart) !== -1;
    const lineEnd = terminated ? text.indexOf('\n', lineStart) : text.length;
    const raw = text.slice(lineStart, lineEnd);
    const cr = raw.endsWith('\r') ? '\r' : '';
    const content = cr ? raw.slice(0, -1) : raw;
    const rendered = renderLine(content, lineStart, ranges, jsx);
    if (rendered !== null) lines.push(rendered + cr + (terminated ? '\n' : ''));
    if (!terminated) break;
    lineStart = lineEnd + 1;
  }
  return lines.join('');
}

function renderLine(content, offset, ranges, jsx) {
  const end = offset + content.length;
  const covered = new Array(content.length).fill(false);
  let hit = false;
  for (const range of ranges) {
    if (range.end <= offset || range.start >= end) continue;
    hit = true;
    const from = Math.max(range.start, offset) - offset;
    const to = Math.min(range.end, end) - offset;
    for (let i = from; i < to; i += 1) covered[i] = true;
  }
  if (!hit) return content;
  let visible = false;
  for (let i = 0; i < content.length; i += 1) {
    if (!covered[i] && !/\s/.test(content[i])) {
      visible = true;
      break;
    }
  }
  if (!visible) return null;
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (!covered[i]) {
      out += content[i];
      i += 1;
      continue;
    }
    let j = i;
    while (j < content.length && covered[j]) j += 1;
    const before = i > 0 ? content[i - 1] : '';
    const after = j < content.length ? content[j] : '';
    if (/[A-Za-z0-9_$'"`]/.test(before) && /[A-Za-z0-9_$'"`]/.test(after)) out += ' ';
    i = j;
  }
  if (jsx && /^\{\s*\}$/.test(out.trim())) return null;
  return out.replace(/[ \t]+$/, '');
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, files);
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
}

function collect(root) {
  const files = [];
  walk(root, files);
  return files;
}

function relative(file) {
  return path.relative(REPO, file).split(path.sep).join('/');
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function main(argv) {
  const fix = argv.includes('--fix');
  const quiet = argv.includes('--quiet');
  const unknown = argv.filter((arg) => !['--fix', '--quiet', '-h', '--help'].includes(arg));
  if (argv.includes('-h') || argv.includes('--help') || unknown.length > 0) {
    console.log('用法：node scripts/lint-comments.mjs [--fix] [--quiet]');
    if (unknown.length > 0) {
      console.error(`无法识别的参数：${unknown.join(' ')}`);
      process.exitCode = 2;
    }
    return;
  }

  const files = collect(REPO);
  const findings = [];
  const totals = new Map();
  let kept = 0;
  let comments = 0;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const blocks = lintText(text, file);
    comments += blocks.length;
    const violations = blocks.filter((block) => block.keep === null);
    kept += blocks.length - violations.length;
    if (violations.length === 0) continue;
    if (fix) fs.writeFileSync(file, fixText(text, blocks, file));
    for (const block of violations) {
      const reason = killReason(block);
      totals.set(reason, (totals.get(reason) ?? 0) + 1);
      findings.push(`${relative(file)}:${lineOf(text, block.start)}  ${reason}`);
    }
  }

  if (findings.length === 0) {
    console.log(`注释门禁：${files.length} 个文件，${comments} 条注释，${kept} 条在豁免清单内，其余为 0。`);
    return;
  }
  if (!quiet) {
    for (const finding of findings) console.log(finding);
    console.log('');
  }
  const summary = [...totals.entries()].map(([reason, count]) => `${reason} ${count}`).join('，');
  if (fix) {
    console.error(`注释门禁：删掉了 ${findings.length} 条（${summary}）。再跑一次确认。`);
    process.exitCode = 1;
    return;
  }
  console.error(`注释门禁：${findings.length} 条注释不在豁免清单内（${summary}）。用 --fix 删除。`);
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT);
if (invokedDirectly) main(process.argv.slice(2));
