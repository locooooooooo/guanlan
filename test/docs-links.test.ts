import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOC_ROOTS = ['.', 'docs', '.github', 'native/docs'] as const;
const ENTRY_POINTS = ['README.md', 'AGENTS.md'] as const;

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

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

function stripCode(text: string): string {
  return text.replace(/^```[\s\S]*?^```[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

function linkTargets(text: string): string[] {
  const body = stripCode(text);
  const targets: string[] = [];
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(match[1]);
  for (const match of body.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm)) targets.push(match[1]);
  for (const match of text.matchAll(/^@(\S+)\s*$/gm)) targets.push(match[1]);
  return targets.filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

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
