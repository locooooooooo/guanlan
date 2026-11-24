import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 文档链接守卫。规范要求「文档与源码一致，每个链接都要能打开」（docs/code-standards.md
 * 「评审一个改动」），这里让它由测试保证，而不是靠人每次手工点。
 *
 * 查三件事：
 * 1. 每份文档里的相对链接、`@文件` 指向，都指向存在的文件或目录；
 * 2. 链接里的锚点（#后面的部分）对应当前文件或目标文件里确实存在的标题；
 * 3. docs/ 下的每份文档都能从 README.md 或 AGENTS.md 出发，顺着内部链接到达——
 *    写了却没人链得到的文档等于没写。
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 放文档的目录。仓库根只看一层，其余递归。 */
const DOC_ROOTS = ['.', 'docs', '.github', 'native/docs'] as const;
/** 新读者与编码智能体的入口。docs/ 下的文档至少要从其中一份出发能到达。 */
const ENTRY_POINTS = ['README.md', 'AGENTS.md'] as const;

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** 列出全部文档，返回相对仓库根、用正斜杠写的路径。 */
function listDocs(): string[] {
  const out: string[] = [];
  const walk = (dir: string, recursive: boolean) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (recursive) walk(full, recursive);
      } else if (/\.md$/i.test(name)) {
        out.push(toPosix(relative(REPO, full)));
      }
    }
  };
  for (const root of DOC_ROOTS) walk(join(REPO, root), root !== '.');
  return out.sort();
}

/** 去掉围栏代码块与行内代码：里面的方括号和括号不是链接。 */
function stripCode(text: string): string {
  return text.replace(/^```[\s\S]*?^```[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

/** 链接目标：行内链接与图片、引用式定义、独占一行的 `@文件`。外部地址不算。 */
function linkTargets(text: string): string[] {
  const body = stripCode(text);
  const targets: string[] = [];
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(match[1]);
  for (const match of body.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm)) targets.push(match[1]);
  for (const match of text.matchAll(/^@(\S+)\s*$/gm)) targets.push(match[1]);
  return targets.filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

/**
 * GitHub 给标题生成锚点的办法：转小写，去掉字母、数字、连接符与空格之外的字符，
 * 空格换成连字符。重复的标题依次加 -1、-2。
 */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = slugify(match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    const count = seen.get(base) ?? 0;
    out.add(count === 0 ? base : `${base}-${count}`);
    seen.set(base, count + 1);
  }
  return out;
}

const read = (rel: string): string => readFileSync(join(REPO, ...rel.split('/')), 'utf8');

/** 一份文档里打不开的链接，每条写成「行号：目标 → 原因」。 */
function brokenLinks(doc: string): string[] {
  const text = read(doc);
  const dir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/')) : '';
  const broken: string[] = [];
  for (const target of linkTargets(text)) {
    const line = text.slice(0, text.indexOf(target)).split('\n').length;
    const hashAt = target.indexOf('#');
    const pathPart = hashAt >= 0 ? target.slice(0, hashAt) : target;
    const anchor = hashAt >= 0 ? target.slice(hashAt + 1) : '';
    const rel = pathPart === '' ? doc : toPosix(join(dir, ...decodeURIComponent(pathPart).split('/')));
    if (!existsSync(join(REPO, ...rel.split('/')))) {
      broken.push(`${line}: ${target} → 找不到 ${rel}`);
      continue;
    }
    if (anchor && /\.md$/i.test(rel) && !anchorsOf(read(rel)).has(decodeURIComponent(anchor))) {
      broken.push(`${line}: ${target} → ${rel} 里没有这个标题`);
    }
  }
  return broken;
}

/** 从一份入口文档出发，顺着内部链接能到达的全部文档。 */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const doc = queue.shift() as string;
    if (seen.has(doc)) continue;
    seen.add(doc);
    const dir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/')) : '';
    for (const target of linkTargets(read(doc))) {
      const pathPart = target.split('#')[0];
      if (pathPart === '') continue;
      const rel = toPosix(join(dir, ...decodeURIComponent(pathPart).split('/')));
      if (/\.md$/i.test(rel) && existsSync(join(REPO, ...rel.split('/')))) queue.push(rel);
    }
  }
  return seen;
}

const docs = listDocs();

describe('文档链接守卫', () => {
  it('覆盖了仓库根、docs/、.github/ 与 native/docs/ 下的全部 Markdown 文档', () => {
    for (const expected of ['AGENTS.md', 'CLAUDE.md', 'LESSONS.md', 'README.md', 'docs/code-standards.md', 'docs/subsystems/README.md', '.github/PULL_REQUEST_TEMPLATE.md', 'native/docs/contract-storage.md']) {
      assert.ok(docs.includes(expected), `守卫没有覆盖 ${expected}`);
    }
    assert.ok(docs.length >= 20, `只找到 ${docs.length} 份文档`);
  });

  for (const doc of docs) {
    it(`${doc}：相对链接、@指向与锚点都能打开`, () => {
      assert.deepEqual(brokenLinks(doc), []);
    });
  }

  it('docs/ 下的每份文档都能从 README.md 或 AGENTS.md 顺着链接到达', () => {
    const reachable = new Set<string>();
    for (const entry of ENTRY_POINTS) for (const doc of reachableFrom(entry)) reachable.add(doc);
    const orphans = docs.filter((doc) => doc.startsWith('docs/') && !reachable.has(doc));
    assert.deepEqual(orphans, [], '这些文档没有任何入口链得到，写了我没人能找到');
  });
});
