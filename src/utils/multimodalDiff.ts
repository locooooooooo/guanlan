/**
 * 面向人类的多模态 Diff 纯函数层（结论结构 Diff + SVG 叠影对比 + 表格数值 Diff）。
 *
 * 契约边界（与 documentDiff.ts / decisionBlocks.ts 同纪律）：
 * - 不 import React / .css，node --test 直跑（SSR/单测同源）；
 * - 两版正文由调用方按 revision_id 从持久快照按需拉取后传入，绝不用当前磁盘内容冒充旧版
 *   （DocumentTimeMachineView.tsx 准则）；
 * - 所有对比带硬预算（行数×DP 单元 / 图元数 / 表格行数 / 单元格明细条数），超限诚实降级
 *   并携带 truncated / rowCapped 标记或 ok:false 代码——绝不做无界 DP、绝不静默截断、
 *   绝不用空结果冒充「无变化」。预算取值保证常规文档全程 < 100ms（停机口径）；
 * - SVG 图元解析用与 workspaceClient.extractSvgTextNodes 同款正则口径（无 DOMParser，
 *   node/SSR 可跑）；渲染层一律走 guanlanEngine.sanitizeSvgForPreview + data:URI，
 *   绝不把用户 SVG inline 注入 DOM（readerSvgPdfSections.tsx 既有红线）。
 *
 * 已知局限（诚实登记，不冒充全覆盖）：SVG 属性值内含 '>' 会逃出正则捕获；<g transform>
 * 容器级移动不产出图元框（子图元几何未变时不标改）——覆盖不了的场景以 changes 列表
 * 文本兜底，绝不伪造几何定位。
 */

import { parseDecisionBlocks, type DecisionBlockStatus, type DecisionPriority } from './decisionBlocks';
import { markdownLines } from './documentEvents';
import { computeSectionDiff, listBaselineSections, type SectionChange } from './documentDiff';
import { parseDelimitedTable } from './quickPreviewHelpers';
import type { OfficeXlsxData, XlsxSheetData } from '../services/apiTypes';

// ============================================================
// 通用：LCS 匹配对（行 Diff 与表格行对齐共用）
// ============================================================

export const LCS_MAX_CELLS = 2_500_000;

export interface LcsFailure {
  ok: false;
  code: 'DIFF_TOO_LARGE';
  message: string;
}

/**
 * LCS 匹配对：返回 [aIndex, bIndex] 配对列表（按出现顺序），未配对元素即新增/删除。
 * 预算：(a.length+1)*(b.length+1) > maxCells 时明确拒绝（LcsFailure），不分配 DP 表。
 * 表格用 Int32Array（值域 ≤ 长度），内存上限 ≈ maxCells × 4B ≈ 10MB 瞬时。
 */
export function lcsMatchedPairs(
  a: string[],
  b: string[],
  maxCells = LCS_MAX_CELLS
): { ok: true; pairs: Array<[number, number]> } | LcsFailure {
  const m = a.length;
  const n = b.length;
  if ((m + 1) * (n + 1) > maxCells) {
    return {
      ok: false,
      code: 'DIFF_TOO_LARGE',
      message: `对比规模超出预算（${m} × ${n}，上限 ${maxCells} 个 DP 单元），已明确拒绝；请缩小对比范围。`,
    };
  }
  if (m === 0 || n === 0) return { ok: true, pairs: [] };
  // table[i][j] = a[i..] 与 b[j..] 的 LCS 长度（后缀式，便于前向走表）
  const table = new Int32Array((m + 1) * (n + 1));
  const at = (i: number, j: number) => i * (n + 1) + j;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[at(i, j)] = a[i] === b[j]
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return { ok: true, pairs };
}

// ============================================================
// ① 行级 Diff（源码行 Diff 模式 + MD「关键增删段」共用数据源）
// ============================================================

export type DiffRowType = 'unchanged' | 'added' | 'removed';

export interface DiffRow {
  type: DiffRowType;
  /** 旧版 1-based 行号（added 无） */
  oldLine?: number;
  /** 新版 1-based 行号（removed 无） */
  newLine?: number;
  text: string;
}

export interface LineDiffSuccess {
  ok: true;
  rows: DiffRow[];
  added: number;
  removed: number;
}

export type LineDiffResult = LineDiffSuccess | LcsFailure;

/**
 * 行级 Diff：LCS 对齐产出完整行序列（unchanged 双行号 / added / removed）。
 * identical 快捷退出（逐字相等 O(m+n)，零 DP 分配）。
 */
export function computeLineDiffRows(oldText: string, newText: string): LineDiffResult {
  if (oldText === newText) {
    const rows = oldText.split('\n').map((text, idx): DiffRow => ({
      type: 'unchanged', oldLine: idx + 1, newLine: idx + 1, text,
    }));
    return { ok: true, rows, added: 0, removed: 0 };
  }
  // 空文本 = 零行（而非一个空行）：空基线 → 全新增；清空 → 全删除。这是 diff 的
  // 用户语义（新文件 vs 空基线），不按 split('') 单空行口径误报删除。
  if (oldText === '' || newText === '') {
    const empty = oldText === '';
    const lines = (empty ? newText : oldText).split('\n');
    const rows: DiffRow[] = lines.map((text, idx) =>
      empty
        ? { type: 'added', newLine: idx + 1, text }
        : { type: 'removed', oldLine: idx + 1, text }
    );
    return empty
      ? { ok: true, rows, added: lines.length, removed: 0 }
      : { ok: true, rows, added: 0, removed: lines.length };
  }
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const matched = lcsMatchedPairs(a, b);
  if (!matched.ok) return matched;
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let ai = 0;
  let bi = 0;
  for (const [pa, pb] of matched.pairs) {
    while (ai < pa) {
      rows.push({ type: 'removed', oldLine: ai + 1, text: a[ai] });
      removed++;
      ai++;
    }
    while (bi < pb) {
      rows.push({ type: 'added', newLine: bi + 1, text: b[bi] });
      added++;
      bi++;
    }
    rows.push({ type: 'unchanged', oldLine: pa + 1, newLine: pb + 1, text: a[pa] });
    ai++;
    bi++;
  }
  while (ai < a.length) {
    rows.push({ type: 'removed', oldLine: ai + 1, text: a[ai] });
    removed++;
    ai++;
  }
  while (bi < b.length) {
    rows.push({ type: 'added', newLine: bi + 1, text: b[bi] });
    added++;
    bi++;
  }
  return { ok: true, rows, added, removed };
}

/** 变化聚簇窗口（含上下文；窗口按 rows 索引闭合区间） */
export interface DiffHunkWindow {
  startIndex: number;
  endIndex: number;
  /** 窗口首行旧版行号（窗口全为 added 时 undefined） */
  oldStart?: number;
  /** 窗口首行新版行号（窗口全为 removed 时 undefined） */
  newStart?: number;
}

/**
 * 变化聚簇：把「变化行 ± contextLines」扩窗并合并重叠——
 * 供 MD 人类视图「关键增删段」与源码行 Diff 模式的「省略 N 行未变」折叠。
 * 无任何变化返回 []（诚实空，不伪造窗口）。
 */
export function collapseHunks(rows: DiffRow[], contextLines = 3): DiffHunkWindow[] {
  const changeIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'unchanged') changeIdx.push(i);
  }
  if (!changeIdx.length) return [];
  const windows: DiffHunkWindow[] = [];
  let start = Math.max(0, changeIdx[0] - contextLines);
  let end = Math.min(rows.length - 1, changeIdx[0] + contextLines);
  for (let k = 1; k < changeIdx.length; k++) {
    const lo = Math.max(0, changeIdx[k] - contextLines);
    const hi = Math.min(rows.length - 1, changeIdx[k] + contextLines);
    if (lo <= end + 1) {
      end = Math.max(end, hi);
    } else {
      windows.push(hunkWindowOf(rows, start, end));
      start = lo;
      end = hi;
    }
  }
  windows.push(hunkWindowOf(rows, start, end));
  return windows;
}

/** 窗口元信息：行号取窗口首行（全 removed 窗口 newStart=undefined、全 added 窗口 oldStart=undefined） */
function hunkWindowOf(rows: DiffRow[], startIndex: number, endIndex: number): DiffHunkWindow {
  const first = rows[startIndex];
  return { startIndex, endIndex, oldStart: first.oldLine, newStart: first.newLine };
}

// ============================================================
// ② Markdown 人类可读 Diff（标题结构 + 决定/待办变化 + 关键增删段）
// ============================================================

export type ElementChangeKind = 'added' | 'removed' | 'changed';

export interface DecisionChange {
  kind: ElementChangeKind;
  priority: DecisionPriority;
  title: string;
  /** 新版状态（removed 取旧版） */
  status: DecisionBlockStatus;
  /** status 变化时的旧版状态 */
  oldStatus?: DecisionBlockStatus;
  /** 新版标记行号（removed 取旧版行号） */
  line: number;
  blocking: boolean;
}

export interface TodoChange {
  kind: ElementChangeKind;
  text: string;
  /** 新版勾选态（removed 取旧版） */
  checked: boolean;
  /** changed＝勾选态翻转时的旧值 */
  oldChecked?: boolean;
  line: number;
}

export interface OutlineRow {
  title: string;
  line: number;
  end: number;
  /** 该章节在新版相对旧版的变更（未变章节 undefined） */
  changeKind?: Exclude<ElementChangeKind, 'removed'>;
}

export interface MdHumanDiffResult {
  /** 章节级变更（与画布 Diff 卡同源 computeSectionDiff） */
  sections: SectionChange[];
  /** 新版标题结构（listBaselineSections 口径）+ 变更徽标 */
  outline: OutlineRow[];
  decisionChanges: DecisionChange[];
  todoChanges: TodoChange[];
  /** 关键增删段（变化聚簇 ±2 行上下文；rows 超预算时为 []） */
  keySegments: DiffHunkWindow[];
  /** 行级完整序列（源码行 Diff 模式数据源；超预算 ok:false） */
  lineDiff: LineDiffResult;
  stats: {
    sectionsChanged: number;
    decisionsChanged: number;
    todosChanged: number;
    added: number;
    removed: number;
  };
}

interface TodoItem {
  line: number;
  text: string;
  checked: boolean;
}

const TODO_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)、])[ \t]+\[([ xX])\][ \t]+(.+)$/;

/** 勾选待办提取：走 markdownLines（跳 YAML/围栏保行号），仅收 `- [ ]`/`- [x]` 列表项 */
export function extractTodoItems(markdown: string): TodoItem[] {
  const lines = markdownLines(markdown);
  const items: TodoItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TODO_ITEM_RE.exec(lines[i]);
    if (m) items.push({ line: i + 1, text: m[2].trim(), checked: m[1].toLowerCase() === 'x' });
  }
  return items;
}

/**
 * Markdown 人类可读 Diff：
 * - 标题结构：新版章节清单 + 逐章变更徽标（修改/新增由 SectionChange 映射；删除章不计入
 *   新版结构，只在 sections 列表呈现）；
 * - 决定变化：parseDecisionBlocks 两版对比，键 = 优先级|标题（优先级变动呈现为 旧删+新增，
 *   确定性不猜同义）；状态行变化 → changed（携带 oldStatus）；
 * - 待办变化：勾选项按文本对齐，新增/删除/勾选态翻转三类；
 * - 关键增删段：collapseHunks(rows, 2)；rows 超预算时 keySegments=[] 且 lineDiff.ok=false
 *   （诚实拒绝，不伪造「无变化」）。
 */
export function buildMarkdownHumanDiff(oldText: string, newText: string): MdHumanDiffResult {
  const sections = computeSectionDiff(oldText, newText);

  // 标题结构 + 徽标
  const changeByTitle = new Map<string, NonNullable<OutlineRow['changeKind']>>();
  for (const change of sections) {
    if (change.kind === '删除') continue; // 删除章节不在新版结构里
    if (!changeByTitle.has(change.title)) changeByTitle.set(change.title, change.kind === '修改' ? 'changed' : 'added');
  }
  const outline: OutlineRow[] = listBaselineSections(newText).map((section) => ({
    title: section.title,
    line: section.line,
    end: section.end,
    changeKind: changeByTitle.get(section.title),
  }));

  // 决定变化
  const decisionChanges: DecisionChange[] = [];
  {
    const oldBlocks = parseDecisionBlocks(oldText);
    const newBlocks = parseDecisionBlocks(newText);
    const keyOf = (b: { priority: DecisionPriority; title: string }) => `${b.priority}|${b.title.trim()}`;
    const oldByKey = new Map(oldBlocks.map((b) => [keyOf(b), b]));
    const newByKey = new Map(newBlocks.map((b) => [keyOf(b), b]));
    for (const block of newBlocks) {
      const prev = oldByKey.get(keyOf(block));
      if (!prev) {
        decisionChanges.push({
          kind: 'added', priority: block.priority, title: block.title,
          status: block.status, line: block.line, blocking: block.blocking,
        });
      } else if (prev.status !== block.status) {
        decisionChanges.push({
          kind: 'changed', priority: block.priority, title: block.title,
          status: block.status, oldStatus: prev.status, line: block.line, blocking: block.blocking,
        });
      }
    }
    for (const block of oldBlocks) {
      if (!newByKey.has(keyOf(block))) {
        decisionChanges.push({
          kind: 'removed', priority: block.priority, title: block.title,
          status: block.status, line: block.line, blocking: block.blocking,
        });
      }
    }
  }

  // 待办变化（文本对齐；同名待办勾选态翻转 → changed）
  const todoChanges: TodoChange[] = [];
  {
    const oldTodos = extractTodoItems(oldText);
    const newTodos = extractTodoItems(newText);
    const oldByText = new Map(oldTodos.map((t) => [t.text, t]));
    const newByText = new Map(newTodos.map((t) => [t.text, t]));
    for (const todo of newTodos) {
      const prev = oldByText.get(todo.text);
      if (!prev) {
        todoChanges.push({ kind: 'added', text: todo.text, checked: todo.checked, line: todo.line });
      } else if (prev.checked !== todo.checked) {
        todoChanges.push({
          kind: 'changed', text: todo.text, checked: todo.checked, oldChecked: prev.checked, line: todo.line,
        });
      }
    }
    for (const todo of oldTodos) {
      if (!newByText.has(todo.text)) {
        todoChanges.push({ kind: 'removed', text: todo.text, checked: todo.checked, line: todo.line });
      }
    }
  }

  const lineDiff = computeLineDiffRows(oldText, newText);
  const keySegments = lineDiff.ok ? collapseHunks(lineDiff.rows, 2) : [];

  return {
    sections,
    outline,
    decisionChanges,
    todoChanges,
    keySegments,
    lineDiff,
    stats: {
      sectionsChanged: sections.length,
      decisionsChanged: decisionChanges.length,
      todosChanged: todoChanges.length,
      added: lineDiff.ok ? lineDiff.added : 0,
      removed: lineDiff.ok ? lineDiff.removed : 0,
    },
  };
}

// ============================================================
// ③ SVG 图元 Diff（叠影/擦除对比的改动图元区域）
// ============================================================

export interface SvgBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SvgShapeChange {
  kind: ElementChangeKind;
  tag: string;
  id: string;
  /** 人话标签：<rect #logo> / <text "登录方案"> */
  label: string;
  /** 估计包围盒（用户单位；无法估计时 undefined——诚实缺省，绝不伪造定位） */
  box?: SvgBox;
}

export interface SvgDiffSuccess {
  ok: true;
  /** 叠加层坐标系（viewBox 宽高；root width/height 兜底；都缺为 null → 不渲染几何叠加） */
  units: { width: number; height: number } | null;
  changes: SvgShapeChange[];
  added: number;
  removed: number;
  changed: number;
  /** 单侧图元超上限时 true（仅对前 N 个图元做对比，诚实标注） */
  truncated: boolean;
}

export type SvgDiffResult = SvgDiffSuccess | LcsFailure;

export const SVG_MAX_SHAPES_PER_SIDE = 1500;
/** 单个 d/points 属性解析坐标数上限（超长路径只取前段做保守包围盒） */
const SVG_MAX_PATH_COORDS = 200;
/** 单元素源码长度上限（超长不参与签名精细对比，按原样保留签名可配对但不估盒） */
const SVG_MAX_ELEMENT_SOURCE = 24_000;

const SVG_SHAPE_RE = /<(rect|circle|ellipse|line|polyline|polygon|path|text|image)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/gi;

interface SvgShape {
  tag: string;
  id: string;
  sig: string;
  box?: SvgBox;
  text: string;
}

function attrOf(attrs: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[2] ?? m[3] ?? '') : '';
}

function numAttr(attrs: string, name: string, fallback?: number): number | undefined {
  const raw = attrOf(attrs, name);
  if (!raw) return fallback;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

function cjkAwareWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? fontSize : fontSize * 0.62;
  return Math.max(width, fontSize);
}

function boxOfShape(tag: string, attrs: string, text: string): SvgBox | undefined {
  const big = (v: number | undefined) => v !== undefined && Number.isFinite(v) && Math.abs(v) < 1e7 ? v : undefined;
  const num = (name: string, fallback?: number) => big(numAttr(attrs, name, fallback));
  switch (tag) {
    case 'rect': {
      const x = num('x', 0) ?? 0;
      const y = num('y', 0) ?? 0;
      const w = num('width');
      const h = num('height');
      if (w === undefined || h === undefined) return undefined;
      return { x, y, width: w, height: h };
    }
    case 'circle': {
      const cx = num('cx');
      const cy = num('cy');
      const r = num('r');
      if (cx === undefined || cy === undefined || r === undefined) return undefined;
      return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
    }
    case 'ellipse': {
      const cx = num('cx');
      const cy = num('cy');
      const rx = num('rx');
      const ry = num('ry');
      if (cx === undefined || cy === undefined || rx === undefined || ry === undefined) return undefined;
      return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
    }
    case 'line': {
      const x1 = num('x1');
      const y1 = num('y1');
      const x2 = num('x2');
      const y2 = num('y2');
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined;
      return {
        x: Math.min(x1, x2), y: Math.min(y1, y2),
        width: Math.abs(x2 - x1) || 1, height: Math.abs(y2 - y1) || 1,
      };
    }
    case 'polyline':
    case 'polygon': {
      const pts = attrOf(attrs, 'points');
      if (!pts) return undefined;
      return boxOfCoordPairs(pts);
    }
    case 'path': {
      const d = attrOf(attrs, 'd');
      if (!d) return undefined;
      return boxOfPathData(d);
    }
    case 'text': {
      const x = num('x', 0) ?? 0;
      const y = num('y', 0) ?? 0;
      const fontSize = num('font-size', 16) ?? 16;
      const height = fontSize * 1.25;
      return { x, y: y - fontSize, width: cjkAwareWidth(text, fontSize), height };
    }
    default:
      return undefined;
  }
}

/** points="x,y x,y ..." → 保守包围盒 */
function boxOfCoordPairs(raw: string): SvgBox | undefined {
  const coords = raw.trim().split(/[\s,]+/).map(Number);
  if (coords.length < 2 || !coords.every((v) => Number.isFinite(v))) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k + 1 < coords.length; k += 2) {
    minX = Math.min(minX, coords[k]);
    maxX = Math.max(maxX, coords[k]);
    minY = Math.min(minY, coords[k + 1]);
    maxY = Math.max(maxY, coords[k + 1]);
  }
  if (!Number.isFinite(minX)) return undefined;
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

/** path d= 数值流保守包围盒（命令语义不解释；只截前 SVG_MAX_PATH_COORDS 个数值） */
function boxOfPathData(d: string): SvgBox | undefined {
  const nums = d.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
  if (!nums || nums.length < 2) return undefined;
  const cap = Math.min(nums.length, SVG_MAX_PATH_COORDS * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k + 1 < cap; k += 2) {
    const x = Number.parseFloat(nums[k]);
    const y = Number.parseFloat(nums[k + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return undefined;
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

/** 签名：tag + 几何/外观关键属性 + 文本（剔除 id；数值归一化去书写差异）。
 *  签名相等 ⇔ 视觉等价（保守：略去 class/opacity 等次要差异）。 */
function signatureOf(tag: string, attrs: string, text: string): string {
  const parts: string[] = [tag];
  const push = (name: string) => {
    const raw = attrOf(attrs, name);
    if (!raw) return;
    const v = Number.parseFloat(raw);
    parts.push(`${name}=${Number.isFinite(v) ? v : raw}`);
  };
  const perTag: Record<string, string[]> = {
    rect: ['x', 'y', 'width', 'height', 'rx'],
    circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
    line: ['x1', 'y1', 'x2', 'y2'],
    polyline: ['points'],
    polygon: ['points'],
    path: ['d'],
    text: ['x', 'y', 'font-size', 'font-weight'],
    image: ['x', 'y', 'width', 'height'],
  };
  for (const name of perTag[tag] ?? []) push(name);
  for (const name of ['transform', 'fill', 'stroke', 'stroke-width', 'text-anchor']) push(name);
  if (tag === 'text' && text) parts.push(`t=${text}`);
  return parts.join('|');
}

/** 提取图元清单（文档序；超上限截断并回报 truncated） */
function extractSvgShapes(source: string): { shapes: SvgShape[]; truncated: boolean } {
  const shapes: SvgShape[] = [];
  let truncated = false;
  SVG_SHAPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SVG_SHAPE_RE.exec(source)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const inner = m[4] ?? '';
    const text = tag === 'text'
      ? inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
      : '';
    const matchText = m[0];
    const sig = matchText.length > SVG_MAX_ELEMENT_SOURCE
      ? `${tag}|oversize:${matchText.length}` // 超长元素：签名退化仍可配对，不精细比对
      : signatureOf(tag, attrs, text);
    shapes.push({
      tag,
      id: attrOf(attrs, 'id'),
      sig,
      box: boxOfShape(tag, attrs, text),
      text,
    });
    if (shapes.length >= SVG_MAX_SHAPES_PER_SIDE) {
      truncated = SVG_SHAPE_RE.lastIndex < source.length;
      break;
    }
  }
  return { shapes, truncated };
}

function svgShapeLabel(shape: { tag: string; id: string; text: string }): string {
  const idPart = shape.id ? ` #${shape.id}` : '';
  const textPart = shape.text ? ` "${shape.text.length > 12 ? shape.text.slice(0, 12) + '…' : shape.text}"` : '';
  return `<${shape.tag}${idPart}>${textPart}`;
}

/**
 * SVG 图元 Diff：
 * ① 非空 id 双侧命中 → 签名异=changed（取新版盒）/同=配对；
 * ② 其余按签名 LCS 顺序配对；
 * ③ 同标签剩余图元按序 1:1 配对 → changed（无 id 图元改坐标不谎报成删+增）；
 * ④ 配剩下的才是真 removed/added。
 * 两版完全逐字节相等快捷退出（零解析）。
 */
export function buildSvgDiff(oldSvg: string, newSvg: string): SvgDiffResult {
  if (oldSvg === newSvg) {
    return { ok: true, units: svgUnitsOf(oldSvg), changes: [], added: 0, removed: 0, changed: 0, truncated: false };
  }
  const oldParsed = extractSvgShapes(oldSvg);
  const newParsed = extractSvgShapes(newSvg);
  const truncated = oldParsed.truncated || newParsed.truncated;

  const changes: SvgShapeChange[] = [];
  const usedOld = new Array<boolean>(oldParsed.shapes.length).fill(false);
  const usedNew = new Array<boolean>(newParsed.shapes.length).fill(false);
  const idToNew = new Map<string, number>();
  newParsed.shapes.forEach((shape, i) => {
    if (shape.id && !idToNew.has(shape.id)) idToNew.set(shape.id, i);
  });

  // ① id 配对
  for (let i = 0; i < oldParsed.shapes.length; i++) {
    const oldShape = oldParsed.shapes[i];
    if (!oldShape.id) continue;
    const j = idToNew.get(oldShape.id);
    if (j === undefined || usedNew[j]) continue;
    usedOld[i] = true;
    usedNew[j] = true;
    const newShape = newParsed.shapes[j];
    if (oldShape.sig !== newShape.sig) {
      changes.push({
        kind: 'changed', tag: newShape.tag, id: newShape.id,
        label: svgShapeLabel(newShape), box: newShape.box,
      });
    }
  }

  // ② 其余按签名 LCS 顺序配对
  const restOld = oldParsed.shapes.filter((_, i) => !usedOld[i]);
  const restNew = newParsed.shapes.filter((_, i) => !usedNew[i]);
  const matched = lcsMatchedPairs(restOld.map((s) => s.sig), restNew.map((s) => s.sig));
  if (!matched.ok) return matched;
  const consumedOld = new Set<number>();
  const consumedNew = new Set<number>();
  for (const [oi, ni] of matched.pairs) {
    consumedOld.add(oi);
    consumedNew.add(ni);
  }

  // ③ 同标签剩余图元按序配对 → changed（LCS 签名异必然呈现为「删+增」，
  //    无 id 图元改个坐标不该谎报成删除+新增——按标签 1:1 配对呈现为修改）；
  //    配剩下的才是真新增/真删除。
  const restOldLeft: number[] = [];
  const restNewLeft: number[] = [];
  restOld.forEach((_, oi) => {
    if (!consumedOld.has(oi)) restOldLeft.push(oi);
  });
  restNew.forEach((_, ni) => {
    if (!consumedNew.has(ni)) restNewLeft.push(ni);
  });
  const queueByTag = new Map<string, number[]>();
  for (const ni of restNewLeft) queueByTag.set(restNew[ni].tag, [...(queueByTag.get(restNew[ni].tag) ?? []), ni]);
  const pairedNew = new Set<number>();
  for (const oi of restOldLeft) {
    const queue = queueByTag.get(restOld[oi].tag);
    if (queue && queue.length > 0) {
      const ni = queue.shift()!;
      pairedNew.add(ni);
      const newShape = restNew[ni];
      changes.push({
        kind: 'changed', tag: newShape.tag, id: newShape.id,
        label: svgShapeLabel(newShape), box: newShape.box,
      });
    } else {
      const shape = restOld[oi];
      changes.push({ kind: 'removed', tag: shape.tag, id: shape.id, label: svgShapeLabel(shape), box: shape.box });
    }
  }
  for (const ni of restNewLeft) {
    if (pairedNew.has(ni)) continue;
    const shape = restNew[ni];
    changes.push({ kind: 'added', tag: shape.tag, id: shape.id, label: svgShapeLabel(shape), box: shape.box });
  }

  return {
    ok: true,
    units: svgUnitsOf(newSvg) ?? svgUnitsOf(oldSvg),
    changes,
    added: changes.filter((c) => c.kind === 'added').length,
    removed: changes.filter((c) => c.kind === 'removed').length,
    changed: changes.filter((c) => c.kind === 'changed').length,
    truncated,
  };
}

/** 叠加层单位：viewBox 优先（取 width/height），root width/height 数值兜底，皆缺 null */
function svgUnitsOf(svg: string): { width: number; height: number } | null {
  const vb = /<svg\b[^>]*?\bviewBox\s*=\s*["']\s*([^"']+)["']/i.exec(svg);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v)) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const root = /<svg\b([^>]*)>/i.exec(svg);
  if (root) {
    const w = numAttr(root[1], 'width');
    const h = numAttr(root[1], 'height');
    if (w !== undefined && h !== undefined && w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

// ============================================================
// ④ 表格数值 Diff（CSV/TSV 行级对齐 + 单元格变化与数值增量）
// ============================================================

export interface TableCellChange {
  col: number;
  header: string;
  oldValue: string;
  newValue: string;
  /** 双侧均可解析为数值时给出增量（旧→新） */
  numeric?: { oldValue: number; newValue: number; delta: number };
}

export type TableDiffRow =
  | { kind: 'unchanged'; row: string[]; rowNum: number }
  | { kind: 'changed'; row: string[]; oldRow: string[]; rowNum: number; changes: TableCellChange[] }
  | { kind: 'added'; row: string[]; rowNum: number }
  | { kind: 'removed'; oldRow: string[]; oldRowNum: number };

export interface TableDiffSuccess {
  ok: true;
  delimiter: ',' | '\t';
  headers: string[];
  headerChanges: TableCellChange[];
  rows: TableDiffRow[];
  addedRows: number;
  removedRows: number;
  changedRows: number;
  cellChanges: number;
  numericChanges: number;
  /** 单侧行数超上限（仅对比前 rowCap 行，诚实标注） */
  rowCapped: boolean;
  rowCap: number;
}

export type TableDiffResult = TableDiffSuccess | LcsFailure;

export const TABLE_DIFF_MAX_ROWS_PER_SIDE = 1000;
/** 单元格明细条数上限（明细封顶后仍计数，不伪造「无变化」） */
export const TABLE_DIFF_MAX_CELL_DETAILS = 4000;

/** 数值单元格解析：容忍千分位逗号/货币前缀/百分号后缀；不可解析返回 null */
export function parseNumericCell(raw: string): number | null {
  const cleaned = raw.trim().replace(/^[¥$€£]\s*/, '').replace(/,/g, '').replace(/\s*%$/, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const v = Number.parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

/**
 * 表格 Diff（CSV/TSV）：
 * - 解析走 parseDelimitedTable（RFC-4180；上限 TABLE_DIFF_MAX_ROWS_PER_SIDE，rowCapped 诚实回报）；
 * - 行对齐 = 整行签名（\u0001 连接）LCS；对上但内容异 → changed 逐格对比；
 * - 改格行为 LCS 呈现为删+增——按「首列同键」（业务表主键列惯例）按序 1:1 配对还原为
 *   changed 行；配不到同键的才是真增/删行；
 * - 数值双侧可解析 → numeric 增量；表头逐列对比（列数不齐补空串）。
 */
export function buildTableDiff(oldText: string, newText: string, delimiter: ',' | '\t' = ','): TableDiffResult {
  const oldParsed = parseDelimitedTable(oldText, delimiter, TABLE_DIFF_MAX_ROWS_PER_SIDE);
  const newParsed = parseDelimitedTable(newText, delimiter, TABLE_DIFF_MAX_ROWS_PER_SIDE);
  const rowCap = TABLE_DIFF_MAX_ROWS_PER_SIDE;

  // 表头逐列对比（列数不齐以空串参与，呈现为新增/删除列语义）
  const headerLen = Math.max(oldParsed.headers.length, newParsed.headers.length);
  const headerChanges: TableCellChange[] = [];
  for (let c = 0; c < headerLen; c++) {
    const oldValue = oldParsed.headers[c] ?? '';
    const newValue = newParsed.headers[c] ?? '';
    if (oldValue !== newValue) {
      headerChanges.push({ col: c, header: newValue, oldValue, newValue });
    }
  }

  const sigOf = (row: string[]) => row.join('\u0001');
  const matched = lcsMatchedPairs(
    oldParsed.rows.map(sigOf),
    newParsed.rows.map(sigOf)
  );
  // 行签名 DP 受 LCS_MAX_CELLS 约束（1000×1000 ≈ 1M，行上限内正常不触顶）；触顶诚实拒绝
  if (!matched.ok) return matched;

  const rows: TableDiffRow[] = [];
  let addedRows = 0;
  let removedRows = 0;
  let changedRows = 0;
  let cellChanges = 0;
  let numericChanges = 0;
  let oi = 0;
  let ni = 0;
  const pushRemoved = (idx: number) => {
    rows.push({ kind: 'removed', oldRow: oldParsed.rows[idx], oldRowNum: idx + 2 });
    removedRows++;
  };
  const pushAdded = (idx: number) => {
    rows.push({ kind: 'added', row: newParsed.rows[idx], rowNum: idx + 2 });
    addedRows++;
  };
  const compareCellInto = (
    col: number,
    oldValue: string,
    newValue: string,
    changes: TableCellChange[]
  ) => {
    if (oldValue === newValue) return;
    const oldNum = parseNumericCell(oldValue);
    const newNum = parseNumericCell(newValue);
    const change: TableCellChange = {
      col,
      header: newParsed.headers[col] ?? '',
      oldValue,
      newValue,
      numeric: oldNum !== null && newNum !== null
        ? { oldValue: oldNum, newValue: newNum, delta: newNum - oldNum }
        : undefined,
    };
    if (change.numeric) numericChanges++;
    if (changes.length < TABLE_DIFF_MAX_CELL_DETAILS) changes.push(change);
    cellChanges++;
  };

  // 行签名 LCS 视「改一格的行」为删+增——anchor 之间与尾部的每个块内，按「首列同键」
  // （业务表主键列惯例）按序 1:1 配对还原为 changed 行；配不到同键的才是真增/删行。
  let blockOld: number[] = [];
  let blockNew: number[] = [];
  const flushBlock = () => {
    const keyQueue = new Map<string, number[]>();
    for (const idx of blockNew) {
      const key = newParsed.rows[idx][0] ?? '';
      keyQueue.set(key, [...(keyQueue.get(key) ?? []), idx]);
    }
    const pairedNew = new Set<number>();
    for (const idx of blockOld) {
      const key = oldParsed.rows[idx][0] ?? '';
      const queue = keyQueue.get(key);
      if (queue && queue.length > 0) {
        const pb = queue.shift()!;
        pairedNew.add(pb);
        const oldRow = oldParsed.rows[idx];
        const newRow = newParsed.rows[pb];
        const changes: TableCellChange[] = [];
        const cols = Math.max(oldRow.length, newRow.length);
        for (let c = 0; c < cols; c++) {
          compareCellInto(c, oldRow[c] ?? '', newRow[c] ?? '', changes);
        }
        if (changes.length > 0) {
          rows.push({ kind: 'changed', row: newRow, oldRow, rowNum: pb + 2, changes });
          changedRows++;
        } else {
          rows.push({ kind: 'unchanged', row: newRow, rowNum: pb + 2 });
        }
      } else {
        pushRemoved(idx);
      }
    }
    for (const idx of blockNew) {
      if (!pairedNew.has(idx)) pushAdded(idx);
    }
    blockOld = [];
    blockNew = [];
  };

  for (const [pa, pb] of matched.pairs) {
    while (oi < pa) blockOld.push(oi++);
    while (ni < pb) blockNew.push(ni++);
    flushBlock();
    // anchor：签名逐字相等 → unchanged
    rows.push({ kind: 'unchanged', row: newParsed.rows[pb], rowNum: pb + 2 });
    oi++;
    ni++;
  }
  while (oi < oldParsed.rows.length) blockOld.push(oi++);
  while (ni < newParsed.rows.length) blockNew.push(ni++);
  flushBlock();

  return {
    ok: true,
    delimiter,
    headers: newParsed.headers,
    headerChanges,
    rows,
    addedRows,
    removedRows,
    changedRows,
    cellChanges,
    numericChanges,
    rowCapped: oldParsed.rowCapped || newParsed.rowCapped,
    rowCap,
  };
}

// ============================================================
// ⑤ XLSX 工作表 Diff（office 端点 rows 按 row_num/col_idx 对齐）
// ============================================================

export interface XlsxSheetDiff {
  sheetName: string;
  /** 单表逐格对比结果（XLSX 行按 row_num 对齐，构造路径不经过 LCS 拒绝分支） */
  table: TableDiffSuccess;
  /** 上游 rows 截断或明细超限时 true（诚实标注） */
  truncated: boolean;
}

export type XlsxDiffSuccess = {
  ok: true;
  sheets: XlsxSheetDiff[];
  addedSheets: string[];
  removedSheets: string[];
};

export type XlsxDiffResult =
  | XlsxDiffSuccess
  | { ok: false; code: 'OFFICE_UNAVAILABLE'; message: string };

export const XLSX_MAX_CELL_DETAILS_PER_SHEET = 4000;

/**
 * XLSX Diff：工作表按名称对齐（同名异内容 → 逐格对比；新增/删除按名单列）。
 * 行按 row_num 对齐、格按 col_idx 对齐；行内容签名同 CSV（\u0001 连接）。
 * 任一侧 xlsx 数据缺失（加密/损坏/metadata_only）→ ok:false 诚实拒绝。
 */
export function buildXlsxDiff(
  oldXlsx: OfficeXlsxData | undefined,
  newXlsx: OfficeXlsxData | undefined
): XlsxDiffResult {
  if (!oldXlsx || !newXlsx) {
    return {
      ok: false,
      code: 'OFFICE_UNAVAILABLE',
      message: '工作簿结构化数据不可用（加密/损坏或仅元数据），表格 Diff 诚实拒绝；绝不以当前文件冒充历史版本。',
    };
  }
  const oldByName = new Map(oldXlsx.sheets.map((s) => [s.name, s]));
  const newByName = new Map(newXlsx.sheets.map((s) => [s.name, s]));
  const sheets: XlsxSheetDiff[] = [];
  const addedSheets: string[] = [];
  const removedSheets: string[] = [];
  for (const sheet of newXlsx.sheets) {
    const prev = oldByName.get(sheet.name);
    if (!prev) {
      addedSheets.push(sheet.name);
      continue;
    }
    const table = sheetTableDiff(prev, sheet);
    if (table.changedRows > 0 || table.addedRows > 0 || table.removedRows > 0 || table.headerChanges.length > 0) {
      sheets.push({
        sheetName: sheet.name,
        table,
        truncated: sheet.truncated || prev.truncated || table.cellChanges > XLSX_MAX_CELL_DETAILS_PER_SHEET,
      });
    }
  }
  for (const sheet of oldXlsx.sheets) {
    if (!newByName.has(sheet.name)) removedSheets.push(sheet.name);
  }
  return { ok: true, sheets, addedSheets, removedSheets };
}

/** 单工作表 → TableDiffSuccess（headers 用新版；行按 row_num 对齐；removed 排尾按 row_num 升序） */
function sheetTableDiff(oldSheet: XlsxSheetData, newSheet: XlsxSheetData): TableDiffSuccess {
  const headerLen = Math.max(oldSheet.headers.length, newSheet.headers.length);
  const headerChanges: TableCellChange[] = [];
  for (let c = 0; c < headerLen; c++) {
    const oldValue = oldSheet.headers[c] ?? '';
    const newValue = newSheet.headers[c] ?? '';
    if (oldValue !== newValue) {
      headerChanges.push({ col: c, header: newValue, oldValue, newValue });
    }
  }

  const rowTextOf = (sheet: XlsxSheetData, rowNum: number): string => {
    const row = sheet.rows.find((r) => r.row_num === rowNum);
    if (!row) return '';
    return [...row.cells].sort((a, b) => a.col_idx - b.col_idx).map((cell) => cell.value).join('\u0001');
  };

  const rows: TableDiffRow[] = [];
  const oldByRowNum = new Map(oldSheet.rows.map((r) => [r.row_num, r]));
  const consumedOld = new Set<number>();
  let changedRows = 0;
  let cellChanges = 0;
  let numericChanges = 0;
  let detailsCapped = false;

  const cellsOf = (row: { cells: { col_idx: number; value: string }[] }): string[] =>
    [...row.cells].sort((a, b) => a.col_idx - b.col_idx).map((cell) => cell.value);
  const colIndexOf = (row: { cells: { col_idx: number }[] }): number[] =>
    [...row.cells].sort((a, b) => a.col_idx - b.col_idx).map((cell) => cell.col_idx);

  for (const newRow of newSheet.rows) {
    const prev = oldByRowNum.get(newRow.row_num);
    if (!prev) {
      rows.push({ kind: 'added', row: cellsOf(newRow), rowNum: newRow.row_num });
      continue;
    }
    consumedOld.add(prev.row_num);
    const oldValues = cellsOf(prev);
    const newValues = cellsOf(newRow);
    if (rowTextOf(oldSheet, newRow.row_num) === rowTextOf(newSheet, newRow.row_num)) {
      rows.push({ kind: 'unchanged', row: newValues, rowNum: newRow.row_num });
      continue;
    }
    const oldCols = colIndexOf(prev);
    const newCols = colIndexOf(newRow);
    const changes: TableCellChange[] = [];
    const cols = Math.max(oldCols.length, newCols.length);
    for (let k = 0; k < cols; k++) {
      const oldValue = oldValues[k] ?? '';
      const newValue = newValues[k] ?? '';
      const col = oldCols[k] ?? newCols[k] ?? k;
      if (oldValue === newValue) continue;
      const oldNum = parseNumericCell(oldValue);
      const newNum = parseNumericCell(newValue);
      const change: TableCellChange = {
        col,
        header: newSheet.headers[col] ?? '',
        oldValue,
        newValue,
        numeric: oldNum !== null && newNum !== null
          ? { oldValue: oldNum, newValue: newNum, delta: newNum - oldNum }
          : undefined,
      };
      if (change.numeric) numericChanges++;
      if (changes.length < XLSX_MAX_CELL_DETAILS_PER_SHEET) changes.push(change);
      else detailsCapped = true;
      cellChanges++;
    }
    if (changes.length > 0) {
      rows.push({ kind: 'changed', row: newValues, oldRow: oldValues, rowNum: newRow.row_num, changes });
      changedRows++;
    } else {
      rows.push({ kind: 'unchanged', row: newValues, rowNum: newRow.row_num });
    }
  }
  const removedRows = oldSheet.rows
    .filter((r) => !consumedOld.has(r.row_num))
    .sort((a, b) => a.row_num - b.row_num);

  return {
    ok: true,
    delimiter: ',',
    headers: newSheet.headers,
    headerChanges,
    rows: [
      ...rows,
      ...removedRows.map((r): TableDiffRow => ({ kind: 'removed', oldRow: cellsOf(r), oldRowNum: r.row_num })),
    ],
    addedRows: rows.filter((r) => r.kind === 'added').length,
    removedRows: removedRows.length,
    changedRows,
    cellChanges,
    numericChanges,
    rowCapped: newSheet.truncated || oldSheet.truncated || detailsCapped,
    rowCap: Math.max(newSheet.row_count, oldSheet.row_count),
  };
}
