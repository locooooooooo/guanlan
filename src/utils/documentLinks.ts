import type { FileRecord, RelationEdge } from '../types/guanlan';
import { markdownLines } from './documentEvents';

/** Resolve against indexed paths only. A written absolute path never grants access to a new directory. */
export function documentLinks(files: FileRecord[], root: string) {
  const slash = (value: string) => value.replace(/\\/g, '/');
  const rootPath = slash(root).replace(/\/+$/, '');
  const pathKey = (value: string) => /^[a-z]:/i.test(rootPath) ? value.toLowerCase() : value;
  const byPath = new Map(files.map(file => [pathKey(slash(file.relative_path)), file]));
  function resolve(source: FileRecord, href: string, literal: boolean) {
    let target: string;
    try { target = slash(decodeURIComponent(href.split('#')[0])); } catch { return; }
    if (!target || /^[a-z][a-z\d+.-]*:(?!\/)|^\/\//i.test(target)) return;
    if (/^(?:[a-z]:\/|\/)/i.test(target)) {
      if (!pathKey(target).startsWith(pathKey(rootPath) + '/')) return;
      return byPath.get(pathKey(target.slice(rootPath.length + 1)));
    }
    const parts = slash(source.relative_path).split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (part === '..') { if (!parts.length) return; parts.pop(); }
      else if (part && part !== '.') parts.push(part);
    }
    return byPath.get(pathKey(parts.join('/'))) ?? (literal ? byPath.get(pathKey(target)) : undefined);
  }
  return (source: FileRecord, content: string): RelationEdge[] => {
    const edges: RelationEdge[] = [];
    const seen = new Set<string>();
    markdownLines(content).forEach((line, index) => {
      const links = /`([^`\n]+)`|!?\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^()\s]|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
      for (const match of line.matchAll(links)) {
        const href = match[1] ?? match[3] ?? match[4];
        if (!href || !/\.(?:md|markdown|svg|pdf)(?:#[^\s]*)?$/i.test(href)) continue;
        const target = resolve(source, href, match[1] !== undefined);
        if (!target || target.file_id === source.file_id) continue;
        const id = JSON.stringify([source.file_id, target.file_id, index + 1]);
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({
          edge_id: id, source_id: source.file_id, target_id: target.file_id, type: 'explicit_reference',
          label: match[1] ? '原文路径' : '原文引用', isInferred: false,
          reason: source.relative_path + ' L' + (index + 1) + ' → ' + target.relative_path,
          locator: { startLine: index + 1, endLine: index + 1 },
        });
      }
    });
    return edges;
  };
}
