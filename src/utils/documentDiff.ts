/**
 * 文档版本时光机的纯函数层：版本链组装 + 章节级 Diff。
 *
 * 契约边界：
 * - 不 import guanlanEngine.ts（其 computeMarkdownDiff 的 currentHeading 只从新版行跟踪，
 *   整章删除时 removed 行会记到新版后一章名上）——本文件自带章节对齐 + 行级 LCS；
 * - 章节切分复用 documentEvents.ts 已导出的 markdownLines（跳 YAML/围栏且保留行号）与
 *   documentEvents（单 H1 下沉，章节事件含 line/end）；
 * - 正文由调用方按 revision_id 从持久快照按需拉取后传入，绝不用当前磁盘内容冒充旧版
 *   （FileTimelineDrawer.tsx 准则）。
 */
import { documentEvents, markdownLines } from './documentEvents';
import { formatLocalStamp, localDay, timeBasisLabel } from './timeFormat';
import type { FileHistory, FileHistoryRevision } from '../services/workspaceClient';

// ---------- 时间口径 ----------

/**
 * 观察时刻标注：含时刻 ISO 按本地时区取『MM-DD HH:mm』；纯日期取『MM-DD』（无尾空格）。
 * 是否『仅日期』由调用方读 precisionDay（occurred_precision === 'day'），不再靠字符串长度判断；
 * 锚点 occurred_at 为空的版本不调用本函数，直接显示『日期待考』。
 */
export function formatObservedAt(iso: string): string {
  return formatLocalStamp(iso);
}

export { timeBasisLabel };

// ---------- 版本链 ----------

export interface VersionNode {
  revisionId: string;
  seq: number;
  /** 'v{seq}'，与 FileTimelineDrawer.tsx:319 的 v{seq} 口径一致 */
  label: string;
  /** 链接锚点 occurred_at ?? observed_at（只用于显示，不参与排序） */
  anchorAt: string;
  /** 无 occurred_at（日期待考）时为 null */
  occurredAt: string | null;
  /** formatObservedAt(anchorAt) */
  observedAtLabel: string;
  /** occurred_at 存在时的时间口径标注（文档自述/文件时间/采集）；为空串表示日期待考 */
  timeBasis: string;
  /** occurred_precision === 'day'（锚点为纯日期） */
  precisionDay: boolean;
  snapshotAvailable: boolean;
  sizeBytes: number;
  /** 无父版（prevRevisionId === null，即修订链起点）＝初始基线 */
  isBaseline: boolean;
  /** 父版：prev_revision_id 命中当前集合时用之，悬空时回退 seq 前驱；链首为 null */
  prevRevisionId: string | null;
}

/**
 * 按『上新下旧』组装版本链：以 seq 降序为主序（capture / 修订链顺序），
 * 与 reconcile.ts 的 seq=latest.seq+1、prev=latest.revision_id 同源，不再按锚点字符串排序。
 * 父版取该版 prev_revision_id（必须在当前 revisions 集合中命中），悬空时回退
 * 『seq 小于它的最大 seq 版本』；再无则为 null（修订链起点＝初始基线）。
 * 这样选中某版做 Diff 时对比的是真正的文本父版，而不是时间上相邻的版本。
 */
export function buildVersionChain(history: FileHistory): VersionNode[] {
  const anchorOf = (rev: FileHistoryRevision): string => rev.occurred_at || rev.observed_at;
  const revisions = history.revisions;
  const byRevisionId = new Map(revisions.map((rev) => [rev.revision_id, rev]));
  // 主序 = seq 降序（capture 顺序）；occurred 日期逆序时主干日期可能非单调，
  // 由 detectDateDisorder 显式提示，绝不悄悄退回按日期排。
  const sorted = [...revisions].sort((a, b) => b.seq - a.seq);
  /** seq 前驱：严格小于 seq 的最大 seq 版本（已排序集合内天然存在） */
  const seqPredecessorOf = (seq: number): string | null => {
    let best: FileHistoryRevision | null = null;
    for (const rev of revisions) {
      if (rev.seq < seq && (!best || rev.seq > best.seq)) best = rev;
    }
    return best?.revision_id ?? null;
  };

  return sorted.map((rev) => {
    const occurredAt = rev.occurred_at;
    const anchorAt = anchorOf(rev);
    // 父版：prev_revision_id 必须在当前集合命中（防快照/过滤裁剪造成悬空），
    // 悬空或缺失时回退 seq 前驱；链首（无可回退）为 null → 初始基线
    const declaredPrev =
      rev.prev_revision_id &&
      rev.prev_revision_id !== rev.revision_id &&
      byRevisionId.has(rev.prev_revision_id)
        ? rev.prev_revision_id
        : null;
    const prevRevisionId = declaredPrev ?? seqPredecessorOf(rev.seq);
    return {
      revisionId: rev.revision_id,
      seq: rev.seq,
      label: `v${rev.seq}`,
      anchorAt,
      occurredAt,
      observedAtLabel: formatObservedAt(anchorAt),
      timeBasis: occurredAt ? timeBasisLabel(rev.occurred_source) : '',
      precisionDay: rev.occurred_precision === 'day',
      snapshotAvailable: rev.snapshot_available,
      sizeBytes: rev.size_bytes,
      isBaseline: prevRevisionId === null,
      prevRevisionId,
    };
  });
}

/**
 * 取父版节点（供时光机做 Diff）：先按 prevRevisionId 在链中命中；
 * 若链被过滤/裁剪导致悬空，再回退链内『seq 小于当前版的最大 seq』节点；
 * 都没有才返回 null（链首＝初始基线）。
 */
export function resolvePrevNode(
  chain: VersionNode[],
  node: VersionNode | null | undefined
): VersionNode | null {
  if (!node) return null;
  if (node.prevRevisionId && node.prevRevisionId !== node.revisionId) {
    const hit = chain.find((item) => item.revisionId === node.prevRevisionId);
    if (hit) return hit;
  }
  let fallback: VersionNode | null = null;
  for (const candidate of chain) {
    if (candidate.revisionId === node.revisionId) continue;
    if (candidate.seq < node.seq && (!fallback || candidate.seq > fallback.seq)) {
      fallback = candidate;
    }
  }
  return fallback;
}

/**
 * 日期与收录顺序矛盾检测：链按 seq 降序（上新下旧）时，若上方节点的
 * 文档自述日期（occurred_at 本地日历日）早于下方节点，说明材料记载时间与
 * 收录顺序不一致——必须在版本轴上强制提示，不能悄悄换回按日期排。
 * 只比较双方都有 occurred_at 的相邻节点，避免把采集时间混进文档日期口径。
 */
export function detectDateDisorder(chain: VersionNode[]): boolean {
  for (let i = 0; i + 1 < chain.length; i++) {
    const upper = chain[i];
    const lower = chain[i + 1];
    if (!upper.occurredAt || !lower.occurredAt) continue;
    const upperDay = localDay(upper.occurredAt);
    const lowerDay = localDay(lower.occurredAt);
    if (upperDay && lowerDay && upperDay < lowerDay) return true;
  }
  return false;
}

// ---------- 章节级 Diff ----------

export type SectionChangeKind = '修改' | '新增' | '删除';

export interface SectionChange {
  kind: SectionChangeKind;
  /** 章节名：删除取旧版章节名（而非新版本中相邻章节名） */
  title: string;
  /** 卡片行范围：修改/新增用新版 L{line}–L{end}，删除用旧版 */
  line: number;
  end: number;
  /** 修改＝章节内行级 LCS 统计；新增＝含标题行在内的行数；删除＝旧版含标题行行数 */
  added: number;
  removed: number;
  /** 嵌套子节的变更归入顶层章节时，卡片标注『含子节』 */
  containsSubsections: boolean;
}

export interface BaselineSection {
  title: string;
  line: number;
  end: number;
  containsSubsections: boolean;
}

/** 第一个标题前的内容归入虚拟章节『文档头部』参与 Diff 对齐 */
const HEADER_TITLE = '文档头部';

interface SectionSnapshot {
  title: string;
  line: number;
  end: number;
  /** 章节正文行（不含标题行；嵌套子节整段含在 body 内，变更归入顶层章节） */
  body: string[];
  containsSubsections: boolean;
}

function topSections(content: string): SectionSnapshot[] {
  const lines = markdownLines(content);
  const tops = documentEvents(content).filter((event) => event.kind === '章节');
  const sections: SectionSnapshot[] = [];
  const headerEnd = tops.length ? tops[0].line - 1 : lines.length;
  const headerBody = lines.slice(0, Math.max(headerEnd, 0));
  if (headerBody.some((line) => line.trim())) {
    sections.push({
      title: HEADER_TITLE,
      line: 1,
      end: Math.max(headerEnd, 1),
      body: headerBody,
      containsSubsections: false,
    });
  }
  for (const event of tops) {
    sections.push({
      title: event.title,
      line: event.line,
      end: event.end,
      body: lines.slice(event.line, event.end),
      containsSubsections: event.children.some((child) => child.kind === '章节'),
    });
  }
  return sections;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** 章节内行级 LCS 统计 added/removed（小节体量，O(n·m) 可接受） */
function countLineDiff(a: string[], b: string[]): { added: number; removed: number } {
  const width = b.length;
  let previous = new Int32Array(width + 1);
  let current = new Int32Array(width + 1);
  for (let i = 1; i <= a.length; i++) {
    current = new Int32Array(width + 1);
    for (let j = 1; j <= width; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = a.length === 0 || width === 0 ? 0 : previous[width];
  return { added: width - common, removed: a.length - common };
}

/**
 * 章节级 Diff：按章节标题+顺序对齐（标题序列 LCS，改名呈现为旧名[删除]+新名[新增]）。
 * 新有旧无→[新增]（含标题行计入 added）；旧有新无→[删除]（章节名取旧版，行范围用旧版）；
 * 两边都有但正文行不一致→[修改]（行级 LCS 统计 +added/-removed，行范围用新版）；
 * 未变章节绝不产出。文档头部（首个标题前内容）作为虚拟章节参与对齐。
 */
export function computeSectionDiff(oldContent: string, newContent: string): SectionChange[] {
  const oldSections = topSections(oldContent);
  const newSections = topSections(newContent);
  const a = oldSections.map((section) => section.title);
  const b = newSections.map((section) => section.title);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const changes: SectionChange[] = [];
  const pushRemoved = (section: SectionSnapshot) => changes.push({
    kind: '删除', title: section.title, line: section.line, end: section.end,
    added: 0, removed: section.end - section.line + 1, containsSubsections: section.containsSubsections,
  });
  const pushAdded = (section: SectionSnapshot) => changes.push({
    kind: '新增', title: section.title, line: section.line, end: section.end,
    added: section.end - section.line + 1, removed: 0, containsSubsections: section.containsSubsections,
  });
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      const before = oldSections[i];
      const after = newSections[j];
      if (!sameLines(before.body, after.body)) {
        const { added, removed } = countLineDiff(before.body, after.body);
        changes.push({
          kind: '修改', title: after.title, line: after.line, end: after.end,
          added, removed, containsSubsections: after.containsSubsections,
        });
      }
      i++; j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      pushRemoved(oldSections[i++]);
    } else {
      pushAdded(newSections[j++]);
    }
  }
  while (i < a.length) pushRemoved(oldSections[i++]);
  while (j < b.length) pushAdded(newSections[j++]);
  return changes;
}

/** v1 初始基线的章节清单（汇总卡『[初始基线] N 个章节』的卡内清单，含文档头部） */
export function listBaselineSections(content: string): BaselineSection[] {
  return topSections(content).map(({ title, line, end, containsSubsections }) => ({
    title, line, end, containsSubsections,
  }));
}
