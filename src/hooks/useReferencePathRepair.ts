import { useCallback, useMemo } from 'react';
import type { DecisionAssertion, FileRecord, RelationEdge } from '../types/guanlan';

/**
 * C04 · 确认制引用路径修复 Hook（§5 C04 ④；围栏内独立 Hook，§4.2 防膨胀）。
 *
 * 语义（严格确认制，绝不静默改写原文档）：
 * - 移动/重命名一个被 Markdown 决定证据引用的附件（.pdf/.xlsx/.docx/.svg，含 md 本身
 *   被引用）时，先由 [`collectAffectedReferences`] 零 IO 列出受影响引用清单
 *   （服务端行级 explicit_reference 边 + 决定条目证据层），交给 FileOpsModal 预览；
 * - 用户在弹窗显式勾选「同步更新引用路径」后才执行 [`repairAfterMutation`]：
 *   逐个受影响文档读取**当前版**正文 → 仅替换解析命中旧路径的 href（保留锚点与
 *   引号/<> 语法）→ 经桌面壳 save_workspace_file CAS 乐观锁写回（磁盘内容必须与
 *   读到的当前版一致，冲突即失败——绝不覆盖外部并发写入）；
 * - 取消（不勾选）＝零改写：正文一个字节都不动；
 * - 桌面壳保存桥不可用（浏览器/CLI dev）＝修复能力诚实禁用，只读预览清单。
 */

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
  /** 引用来源 .md 文档（markdown_link 层）；decision_evidence 层为决定所属证据文档 id。 */
  sourceFileId: string;
  sourcePath: string;
  sourceTitle: string;
  /** 服务端行级边定位（1-based）；决定证据层为证据起始行。 */
  line: number | null;
  /** decision_evidence 层的决定编号/问题（直达清单人话）。 */
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
  /** A05 响应中的旧/新工作区相对路径（rename/move 均有）。 */
  oldPath: string;
  newPath: string;
  /** 弹窗确认标志；false 时本函数不落任何字节（严格确认制）。 */
  updateReferences: boolean;
}

export interface UseReferencePathRepairOptions {
  files: readonly FileRecord[];
  relations: readonly RelationEdge[];
  decisions: readonly DecisionAssertion[];
  /** 按版本读取正文（注入依赖：单测可注入 fake，生产为 workspaceClient.fetchRevisionContent）。 */
  fetchRevisionContent: (
    revisionId: string
  ) => Promise<{ ok: boolean; text?: string; error?: string; code?: string }>;
}

const slash = (value: string) => value.replace(/\\/g, '/');

/** 与 documentLinks 同语义的路径键（Windows 盘符工作区大小写无关）。 */
function pathKeyOf(rootish: string): string {
  return /^[a-z]:/i.test(rootish) ? slash(rootish).toLowerCase() : slash(rootish);
}

/** md 文档所在目录（'a/b/c.md' → 'a/b'；根文件 → ''）。 */
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

/**
 * 解析 href（去锚、解码）落到工作区相对路径键（Windows 工作区大小写无关）。
 * 解析语义与 documentLinks.resolve 完全同款：`./`、`../`、裸相对；绝对/盘符拒绝。
 * literal=true（code span「原文路径」形态）时保留 documentLinks 的字面兜底：
 * 相对解析结果不成立时按 href 原文直接作为工作区相对路径（原文路径≠相对链接语义）。
 */
function resolveHrefToRel(sourcePath: string, href: string, literal: boolean): string | null {
  let target: string;
  try {
    target = slash(decodeURIComponent(href.split('#')[0]));
  } catch {
    return null;
  }
  if (!target || /^[a-z][a-z\d+.-]*:(?!\/)|^\/\//i.test(target)) return null;
  if (/^(?:[a-z]:\/|\/)/i.test(target)) return null; // 绝对路径不授予新目录权限
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
    // documentLinks 同款字面兜底（code span「原文路径」语义）：调用方会同时拿
    // 相对解析与本结果逐一比对 oldKey，任一命中即视为引用该附件
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
    // 逐 match 从右往左替换，避免前段替换改变后段索引
    const matches = Array.from(line.matchAll(links));
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];
      const href = match[1] ?? match[3] ?? match[4];
      if (!href) continue;
      // code span（match[1]）是「原文路径」：先按相对解析、再按字面兜底
      // （documentLinks 同款双语义）；普通链接只按相对解析
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
  /** 桌面壳保存桥是否可用（不可用＝修复能力诚实禁用，只读预览）。 */
  saveAvailable: boolean;
  /** 零 IO 收集受影响引用清单（弹窗预览；同步、可 useMemo）。 */
  collectAffectedReferences: (fileId: string) => AffectedReferenceItem[];
  /**
   * 用户确认后执行修复：仅对 markdown_link 层源文档落笔（decision_evidence 的
   * relative_path 由服务端对账随新正文重派生，无需前端直改库）。updateReferences=false
   * 直接返回零改写结果（严格确认制）。
   */
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
  // 每次渲染现读保存桥（ReaderView readDecisionSaveBridge 同款惰性读取）：
  // 初始化脚本注入时序无关，桥晚到也不误判为不可用
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
      // 层一：服务端行级 explicit_reference 边（reconcile 重派生，reconcile 后即最新）
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
      // 层二：决定条目证据（evidences.file_id 指向该附件的决定）——直达清单人话层
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
        // 严格确认制：未确认＝零改写（连正文都不读改，只在结果中如实记录）
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
          // CAS 冲突 / NOT_TAURI / IO：原文档未动（桌面壳冲突时绝不落任何字节）
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
