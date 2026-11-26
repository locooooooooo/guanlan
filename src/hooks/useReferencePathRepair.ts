import { useCallback, useMemo } from 'react';
import type { DecisionAssertion, FileRecord, RelationEdge } from '../types/guanlan';


/** 桌面壳保存桥入参/返回（main.rs SaveWorkspaceFileRequest/Ok 的 TS 侧形状）。 */
export interface ReferenceSaveFileRequest {
  relativePath: string;
  originalContent: string;
  newContent: string;
}

type ReferenceSaveFileBridge = (
  request: ReferenceSaveFileRequest
) => Promise<{ saved: boolean; bytes: number }>;

/** 读桌面壳保存桥（initialization_script 注入 window.__GUANLAN_SAVE_FILE__）；其余环境 null。 */
export function readReferenceSaveBridge(): ReferenceSaveFileBridge | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { __GUANLAN_SAVE_FILE__?: ReferenceSaveFileBridge })
      .__GUANLAN_SAVE_FILE__ ?? null
  );
}

/** 一条受影响引用（弹窗清单行）。 */
export interface AffectedReferenceItem {
  kind: 'markdown_link' | 'decision_evidence';
  sourceFileId: string;
  sourcePath: string;
  sourceTitle: string;
  line: number | null;
  decisionCode: string | null;
  decisionQuestion: string | null;
}

/** 修复执行结果（诚实分型：成功 / 失败 / 无需改写）。 */
export interface ReferenceRepairOutcome {
  repaired: Array<{ relativePath: string; hrefCount: number }>;
  failed: Array<{ relativePath: string; reason: string }>;
  skipped: Array<{ relativePath: string; reason: string }>;
}

export interface ReferenceRepairMutationInput {
  fileId: string;
  oldPath: string;
  newPath: string;
  updateReferences: boolean;
}

export interface UseReferencePathRepairOptions {
  files: readonly FileRecord[];
  relations: readonly RelationEdge[];
  decisions: readonly DecisionAssertion[];
  fetchRevisionContent: (
    revisionId: string
  ) => Promise<{ ok: boolean; text?: string; error?: string; code?: string }>;
}

const slash = (value: string) => value.replace(/\\/g, '/');

function pathKeyOf(rootish: string): string {
  return /^[a-z]:/i.test(rootish) ? slash(rootish).toLowerCase() : slash(rootish);
}

function sourceDirOf(sourcePath: string): string {
  const parts = slash(sourcePath).split('/');
  parts.pop();
  return parts.join('/');
}

/**
 * 由源文档目录计算指向 newRel 的新相对 href（相对路径语义与 documentLinks.resolve
 * 互逆；仅对空格做 %20 转义——裸 href 语法不允许空格，其余字符原样保留风格）。
 */
export function relativeHrefFromDir(sourceDir: string, newRel: string): string {
  const target = slash(newRel);
  if (!sourceDir) return target.replace(/ /g, '%20');
  const from = sourceDir.split('/');
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  const ups = from.length - common;
  const down = to.slice(common).join('/');
  const joined = ups === 0 ? down : `${'../'.repeat(ups)}${down}`;
  return joined.replace(/ /g, '%20');
}

function resolveHrefToRel(sourcePath: string, href: string, literal: boolean): string | null {
  let target: string;
  try {
    target = slash(decodeURIComponent(href.split('#')[0]));
  } catch {
    return null;
  }
  if (!target || /^[a-z][a-z\d+.-]*:(?!\/)|^\/\//i.test(target)) return null;
  if (/^(?:[a-z]:\/|\/)/i.test(target)) return null;
  const parts = slash(sourcePath).split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== '.') {
      parts.push(part);
    }
  }
  if (literal) {
    return pathKeyOf(target);
  }
  return pathKeyOf(parts.join('/'));
}

/**
 * 正文引用改写纯函数（可单测）：逐行按 documentLinks 同款链接语法扫描，
 * 仅替换解析后确指向 oldRel 的 href；返回改写后全文与命中处数。
 * code span（`` `path.svg` ``）、`[t](<url>)`、`[t](url "title")` 三种形态的
 * 定界符/锚点/标题全部原样保留。
 */
export function rewriteMarkdownReferences(
  content: string,
  sourcePath: string,
  oldRel: string,
  newRel: string
): { text: string; changed: number } {
  const oldKey = pathKeyOf(oldRel);
  const links =
    /`([^`\n]+)`|!?\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^()\s]|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  let changed = 0;
  const outLines = content.split('\n').map((line) => {
    let out = line;
    const matches = Array.from(line.matchAll(links));
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];
      const href = match[1] ?? match[3] ?? match[4];
      if (!href) continue;
      const isCodeSpan = match[1] !== undefined;
      const hit = resolveHrefToRel(sourcePath, href, false);
      const hitLiteral = isCodeSpan ? resolveHrefToRel(sourcePath, href, true) : null;
      if (hit !== oldKey && hitLiteral !== oldKey) continue;
      const anchorIdx = href.indexOf('#');
      const anchor = anchorIdx >= 0 ? href.slice(anchorIdx) : '';
      const newHref = relativeHrefFromDir(sourceDirOf(sourcePath), newRel) + anchor;
      const start = match.index + match[0].indexOf(href);
      const end = start + href.length;
      out = out.slice(0, start) + newHref + out.slice(end);
      changed += 1;
    }
    return out;
  });
  return { text: outLines.join('\n'), changed };
}

export interface UseReferencePathRepairResult {
  saveAvailable: boolean;
  collectAffectedReferences: (fileId: string) => AffectedReferenceItem[];
  repairAfterMutation: (
    input: ReferenceRepairMutationInput
  ) => Promise<ReferenceRepairOutcome>;
}

export function useReferencePathRepair({
  files,
  relations,
  decisions,
  fetchRevisionContent,
}: UseReferencePathRepairOptions): UseReferencePathRepairResult {
  const saveAvailable = readReferenceSaveBridge() !== null;

  const filesById = useMemo(() => {
    const map = new Map<string, FileRecord>();
    for (const f of files) map.set(f.file_id, f);
    return map;
  }, [files]);

  const collectAffectedReferences = useCallback(
    (fileId: string): AffectedReferenceItem[] => {
      const items: AffectedReferenceItem[] = [];
      const seenSource = new Set<string>();
      for (const edge of relations) {
        if (edge.type !== 'explicit_reference' || edge.target_id !== fileId) continue;
        const source = filesById.get(edge.source_id);
        if (!source || source.format !== 'md') continue;
        const dedupeKey = `${source.file_id}:${edge.locator?.startLine ?? 0}`;
        if (seenSource.has(dedupeKey)) continue;
        seenSource.add(dedupeKey);
        items.push({
          kind: 'markdown_link',
          sourceFileId: source.file_id,
          sourcePath: source.relative_path,
          sourceTitle: source.title,
          line: edge.locator?.startLine ?? null,
          decisionCode: null,
          decisionQuestion: null,
        });
      }
      for (const decision of decisions) {
        const hit = decision.evidences.find((ev) => ev.file_id === fileId);
        if (!hit) continue;
        items.push({
          kind: 'decision_evidence',
          sourceFileId: hit.file_id,
          sourcePath: hit.relative_path,
          sourceTitle: decision.question,
          line: hit.lineStart ?? null,
          decisionCode: decision.code,
          decisionQuestion: decision.question,
        });
      }
      return items;
    },
    [decisions, filesById, relations]
  );

  const repairAfterMutation = useCallback(
    async (input: ReferenceRepairMutationInput): Promise<ReferenceRepairOutcome> => {
      const outcome: ReferenceRepairOutcome = { repaired: [], failed: [], skipped: [] };
      if (!input.updateReferences) {
        outcome.skipped.push({
          relativePath: input.oldPath,
          reason: '用户未确认同步更新引用路径（零改写）',
        });
        return outcome;
      }
      const bridge = readReferenceSaveBridge();
      if (!bridge) {
        outcome.failed.push({
          relativePath: input.oldPath,
          reason: '桌面壳保存桥不可用（浏览器/CLI 只读环境），引用修复未落任何字节',
        });
        return outcome;
      }
      const affected = collectAffectedReferences(input.fileId).filter(
        (item) => item.kind === 'markdown_link'
      );
      const oldKey = pathKeyOf(input.oldPath);
      const newKey = pathKeyOf(input.newPath);
      if (oldKey === newKey) {
        outcome.skipped.push({
          relativePath: input.oldPath,
          reason: '路径未变化，无需改写',
        });
        return outcome;
      }
      for (const item of affected) {
        const source = filesById.get(item.sourceFileId);
        if (!source) {
          outcome.failed.push({
            relativePath: item.sourcePath,
            reason: '引用来源文档不在当前文件清单内，无法安全修复',
          });
          continue;
        }
        const fetched = await fetchRevisionContent(source.current_revision_id);
        if (!fetched.ok || typeof fetched.text !== 'string') {
          outcome.failed.push({
            relativePath: source.relative_path,
            reason: `读取当前版正文失败：${fetched.error ?? fetched.code ?? '未知错误'}`,
          });
          continue;
        }
        const rewritten = rewriteMarkdownReferences(
          fetched.text,
          source.relative_path,
          input.oldPath,
          input.newPath
        );
        if (rewritten.changed === 0) {
          outcome.skipped.push({
            relativePath: source.relative_path,
            reason: '行级边已过期（正文引用早已不存在），无需改写',
          });
          continue;
        }
        try {
          const saved = await bridge({
            relativePath: source.relative_path,
            originalContent: fetched.text,
            newContent: rewritten.text,
          });
          if (!saved?.saved) {
            outcome.failed.push({
              relativePath: source.relative_path,
              reason: '桌面壳保存未确认成功，原文档保持原样',
            });
            continue;
          }
          outcome.repaired.push({
            relativePath: source.relative_path,
            hrefCount: rewritten.changed,
          });
        } catch (error) {
          const message =
            error && typeof error === 'object' && 'message' in error
              ? String((error as { message: unknown }).message)
              : String(error);
          outcome.failed.push({
            relativePath: source.relative_path,
            reason: `写回被拒（原文档未改写）：${message}`,
          });
        }
      }
      return outcome;
    },
    [collectAffectedReferences, fetchRevisionContent, filesById]
  );

  return { saveAvailable, collectAffectedReferences, repairAfterMutation };
}
