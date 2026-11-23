/**
 * 观澜批次一端到端验证 —— 夹具工作区生成 + 期望结果导出 + 身份向量
 *
 * 用法（在仓库根目录执行，不新增依赖）：
 *   node node_modules/tsx/dist/cli.mjs scripts/seed-fixture.ts
 *
 * 做三件事（可重复执行：先整目录清空再重建）：
 *  1. 在 native/testdata/fixture/workspace 下落一套真实文件（md/svg/pdf、
 *     纯日期与带时刻事件、同一文件 A→B→A、仅 mtime 触碰、决策事件、事件量 ≥60 条），
 *     再用现有 Node 对账实现（server/reconcile.ts → FileScanner + WorkspaceStore）
 *     分四轮扫描生成持久库（native/testdata/fixture/data/<rootKey>/index.db，
 *     rootKey 子目录口径见契约 contract-storage.md §3.1）；
 *  2. 用现有 Node 查询实现（server/queries.ts、server/project.ts）导出期望结果 JSON 到
 *     native/testdata/expected/，字段名按 native/docs/contract-query-api.md 的
 *     v1 命名映射（映射表见 expected/_field-map.json）；
 *  3. 用 rootKeyOf 与真实对账管线生成身份向量 native/testdata/identity-vectors.json
 *     （rootKey 与 file_id 样本，覆盖 Windows 反斜杠、大小写混合、正斜杠输入，
 *     算法依据 native/docs/contract-storage.md §2）。
 *
 * 生成器自带不变量断言与公式自检：任一失败以非零码退出，避免把残缺夹具当期望基线。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { rootKeyOf, WorkspaceStore, type FileRow } from '../server/WorkspaceStore';
import {
  queryEvents,
  queryEventDays,
  eventTimeRange,
  type EventQuery,
  type EventDaysQuery,
} from '../server/queries';
import { projectWorkspace, projectFileHistory, readRevisionContent } from '../server/project';
import { reconcileWorkspace, type ReconcileReport } from '../server/reconcile';
import type { FileRecord } from '../src/types/guanlan';

// ---------- 路径：全部相对 guanlan 包根解析，与进程 CWD 无关 ----------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SCRIPT_DIR, '..');
const TESTDATA = path.join(PKG_ROOT, 'native', 'testdata');
const FIXTURE_DIR = path.join(TESTDATA, 'fixture');
const WS_ROOT = path.join(FIXTURE_DIR, 'workspace'); // 夹具工作区根（Rust serve --root 指这里）
// 持久库目录：契约 contract-storage.md §3.1 与 WorkspaceStore.ts:267-274 同口径——
// GUANLAN_DATA_DIR 只是 base，其下还须挂 rootKeyOf(root) 子目录。smoke 以
// GUANLAN_DATA_DIR=<fixture>/data 启动 Rust 服务，服务端 default_data_dir 解析出
// 本目录后只读打开 index.db；夹具生成必须落在同一物理位置
const DATA_DIR = path.join(FIXTURE_DIR, 'data', rootKeyOf(WS_ROOT));
const EXPECTED_DIR = path.join(TESTDATA, 'expected');
const IDENTITY_PATH = path.join(TESTDATA, 'identity-vectors.json');

// 身份向量旁支：独立小工作区，专门产出「大小写混合 / 空格 / 中文」路径的真实 file_id
const IDENTITY_DIR = path.join(FIXTURE_DIR, 'identity');
const ID_ROOT = path.join(IDENTITY_DIR, 'workspace');
const ID_DATA = path.join(IDENTITY_DIR, 'data');

// ---------- 小工具 ----------

/** 固定时刻（UTC ISO）：毫秒用于 utimesSync，字符串用于夹具自述日期 */
const ts = (iso: string): number => new Date(iso).getTime();

const checkFailures: string[] = [];
function check(cond: boolean, message: string): void {
  if (!cond) checkFailures.push(message);
}

function writeJson(rel: string, data: unknown): void {
  const target = path.join(EXPECTED_DIR, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function putFile(rel: string, content: Buffer | string, mtimeIso: string): void {
  const target = path.join(WS_ROOT, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  // utimesSync 接受 Date 对象（数字形态的实参按秒解释，毫秒会 EINVAL）
  const at = new Date(ts(mtimeIso));
  fs.utimesSync(target, at, at);
}

// ---------- 夹具内容模板（确定性：同一份脚本重放得到同一批字节） ----------

const FILLER_COUNT = 50;
/** 批量样本的自述日期：2026-09-20 起循环 30 天（2026-09-20 … 2026-10-19） */
function fillerDate(i: number): string {
  return new Date(Date.UTC(2026, 8, 20 + (i % 30))).toISOString().slice(0, 10);
}

function fillerMd(i: number): string {
  const n = String(i + 1).padStart(2, '0');
  const head = [
    `# 批量样本 ${n}`,
    '',
    `文档日期：${fillerDate(i)}`,
    '',
    `本样本用于批次一端到端验证的事件量与按日聚合检查，内容编号 ${n}，无其他业务语义。`,
    '',
  ];
  // 前 5 份带格式 B 决策节（### Q1Nx：标题，derive.ts 格式 B），其余为普通样本
  if (i < 5) {
    head.push(
      `### Q10${i + 1}：批量决定 ${n}`,
      '当前状态：待确认',
      `推荐及理由：批量样本 ${n} 的推荐语，仅用于决策入轴验证。`,
      ''
    );
  }
  return head.join('\n');
}

const SVG_V1 = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">',
  '  <rect x="8" y="8" width="304" height="144" fill="#f4f6fb" stroke="#8899bb"/>',
  '  <text x="24" y="48" font-size="18">观澜架构示意 v1</text>',
  '  <text x="24" y="84" font-size="12">采集 → 持久 → 查询</text>',
  '  <text x="24" y="116" font-size="12">批次一：独立读服务</text>',
  '</svg>',
  '',
].join('\n');

const SVG_V2 = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
  '  <rect x="8" y="8" width="304" height="164" fill="#eef4ff" stroke="#5577cc"/>',
  '  <text x="24" y="48" font-size="18">观澜架构示意 v2</text>',
  '  <text x="24" y="84" font-size="12">采集 → 持久 → 查询</text>',
  '  <text x="24" y="116" font-size="12">批次一：独立读服务（Rust）</text>',
  '  <text x="24" y="148" font-size="12">events/days/range 游标窗口</text>',
  '</svg>',
  '',
].join('\n');

/** 极简合法 PDF：对象偏移按实际字节计算，xref 自洽 */
function buildPdf(): Buffer {
  const streamBody = 'BT /F1 12 Tf 72 720 Td (Guanlan fixture PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Q01 决策文件：格式 A（## N 标题 + 沿用编号 + 状态，derive.ts 格式 A）
// v1 两节均「待确认」，v2 第一节改「已确认」→ 产生 decision_changed
const Q01_V1 = [
  '# Q01 登录决策记录',
  '',
  '文档日期：2026-10-05',
  '',
  '## 1 登录方式',
  '沿用编号：Q01',
  '状态：待确认',
  '可选方案：统一登录 / 保留本地账户',
  '推荐及理由：统一登录，减少账户漂移。',
  '影响与等待范围：登录页改造期间旧入口不阻断。',
  '',
  '参见 [架构方案](../方案/回滚目标-方案.md) 与 [使用说明](../说明/使用说明.md)。',
  '',
  '## 2 权限复核',
  '沿用编号：Q02',
  '状态：待确认',
  '推荐及理由：每季度复核一次权限清单。',
  '',
].join('\n');

const Q01_V2 = Q01_V1.replace(
  '## 1 登录方式\n沿用编号：Q01\n状态：待确认',
  '## 1 登录方式\n沿用编号：Q01\n状态：已确认'
);

const Q05_MD = [
  '# Q05 导出格式决策',
  '',
  '文档日期：2026-10-07',
  '',
  '### Q05：图片导出采用何种格式',
  '当前状态：已确认',
  '可选方案：SVG / PNG',
  '推荐及理由：矢量优先，SVG 保真。',
  '影响与等待范围：导出模块改造；预览缓存不阻断。',
  '',
].join('\n');

/** A→B→A 目标文件：A 版字节保留在内存，轮 3 原样写回（同哈希共享快照） */
const ROLLBACK_A = [
  '# 回滚目标方案',
  '',
  '文档日期：2026-10-06',
  '',
  '## 背景',
  '这是版本 A 的内容，用于验证 A→B→A 三次版本出现、两份内容快照。',
  '',
  '## 关联',
  '整体结构见 [架构方案](架构方案.md)。',
  '',
].join('\n');

const ROLLBACK_B = [
  '# 回滚目标方案',
  '',
  '文档日期：2026-10-06',
  '',
  '## 背景',
  '这是版本 B 的内容：章节与措辞都已调整，内容哈希应与 A 不同。',
  '',
  '## 变更说明',
  '新增本节用于拉开与 A 版的结构差异。',
  '',
  '## 关联',
  '整体结构见 [架构方案](架构方案.md)。',
  '',
].join('\n');

const ARCH_V1 = [
  '# 架构方案',
  '',
  '文档日期：2026-10-08',
  '',
  '## 总体结构',
  '服务分为采集、持久、查询三层，配图见 [架构图](../assets/架构示意图.svg)。',
  '',
].join('\n');

const ARCH_V2 = [
  '# 架构方案',
  '',
  '文档日期：2026-10-08',
  '',
  '## 总体结构',
  '服务分为采集、持久、查询三层，配图见 [架构图](../assets/架构示意图.svg)。',
  '',
  '## 查询层',
  '分页与游标遵循 contract-query-api.md §0.3 的窗口语义。',
  '',
].join('\n');

const GUIDE_MD = [
  '# 使用说明',
  '',
  '文档日期：2026-10-09',
  '',
  '打开观澜后选择工作区根目录；首次扫描建立基线，后续对账只在内容变化时追加版本。',
  '',
].join('\n');

// ---------- 第一部分：清空并落夹具文件 ----------

function writeFixtureFiles(): void {
  // 可重复生成：夹具目录、期望目录、身份向量一并清空
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(EXPECTED_DIR, { recursive: true, force: true });
  fs.rmSync(IDENTITY_PATH, { force: true });
  fs.mkdirSync(WS_ROOT, { recursive: true });

  // 带自述日期的 md（v1 occurred = 文档日期，纯日期口径）
  putFile('docs/Q01-登录决策记录.md', Q01_V1, '2026-10-05T08:00:00.000Z');
  putFile('docs/Q05-导出格式决策.md', Q05_MD, '2026-10-07T08:30:00.000Z');
  putFile('docs/方案/回滚目标-方案.md', ROLLBACK_A, '2026-10-06T08:00:00.000Z');
  putFile('docs/方案/架构方案.md', ARCH_V1, '2026-10-08T08:00:00.000Z');
  putFile('docs/说明/使用说明.md', GUIDE_MD, '2026-10-09T08:00:00.000Z');
  for (let i = 0; i < FILLER_COUNT; i++) {
    putFile(
      `bulk/批量样本-${String(i + 1).padStart(2, '0')}.md`,
      fillerMd(i),
      '2026-09-18T06:30:00.000Z'
    );
  }
  // svg：一份含 <text>（svg_text 覆盖），一份不含（filename_only）
  putFile('assets/架构示意图.svg', SVG_V1, '2026-10-01T02:00:00.000Z');
  putFile(
    'assets/logo.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#447"/></svg>',
    '2026-09-01T02:00:00.000Z'
  );
  // pdf：恒 filename_only + unindexed
  putFile('manuals/参考手册.pdf', buildPdf(), '2026-08-15T03:00:00.000Z');
}

// ---------- 第二部分：四轮真实对账 ----------

interface RoundReport {
  label: string;
  now: string;
  report: ReconcileReport;
}

function runReconciliation(): { store: WorkspaceStore; wsId: string; rounds: RoundReport[] } {
  const store = new WorkspaceStore(DATA_DIR);
  const rounds: RoundReport[] = [];
  const run = (label: string, now: string): void => {
    const { report } = reconcileWorkspace(WS_ROOT, { dataDir: DATA_DIR, store, now });
    rounds.push({ label, now, report });
  };

  // 轮 1：基线。有自述日期的材料各自入轴（appeared × 55），其余归基线卡；
  // 同时产出决策事件（Q01/Q02/Q101–Q105 raised，Q05 首次即已确认）。
  run('baseline', '2026-11-10T09:00:00.000Z');

  // 轮 2：四处内容变更 → modified（v2，occurred = mtime，带时刻口径），
  // Q01 决策节转「已确认」→ decision_changed。
  putFile('docs/Q01-登录决策记录.md', Q01_V2, '2026-10-12T09:30:00.000Z');
  putFile('docs/方案/回滚目标-方案.md', ROLLBACK_B, '2026-10-13T10:00:00.000Z');
  putFile('docs/方案/架构方案.md', ARCH_V2, '2026-10-14T11:00:00.000Z');
  putFile('assets/架构示意图.svg', SVG_V2, '2026-10-15T12:00:00.000Z');
  run('modify', '2026-11-11T10:00:00.000Z');

  // 轮 3：回滚目标写回 A 版原字节 → 第三个版本，与 v1 共享同一快照（A→B→A）。
  putFile('docs/方案/回滚目标-方案.md', ROLLBACK_A, '2026-10-20T09:00:00.000Z');
  run('rollback', '2026-11-12T11:00:00.000Z');

  // 轮 4：使用说明仅触碰 mtime（内容未变 → 不落版本、不产生事件）；
  // 删除 logo.svg → missing（occurred_at 为空 → undated 事件）。
  const guide = path.join(WS_ROOT, 'docs', '说明', '使用说明.md');
  const at = new Date(ts('2026-10-22T08:00:00.000Z'));
  fs.utimesSync(guide, at, at);
  fs.rmSync(path.join(WS_ROOT, 'assets', 'logo.svg'));
  run('touch-and-missing', '2026-11-13T12:00:00.000Z');

  const ws = store.ensureWorkspace(WS_ROOT);
  return { store, wsId: ws.workspace_id, rounds };
}

// ---------- 第三部分：v1 命名映射（contract-query-api.md §1.3 FileSummary） ----------

/**
 * FileRecord（camelCase 遗留 wire，project.ts:189-206）→ v1 FileSummary（snake_case 新 DTO）。
 * 映射表同时落盘到 expected/_field-map.json，供 Rust DTO 与本脚本对照。
 */
function toFileSummary(rec: FileRecord, row: FileRow): Record<string, unknown> {
  const revs = rec.revisions; // project.ts:77 保证按 seq ASC
  const current = revs.find((r) => r.revision_id === rec.current_revision_id) ?? revs[revs.length - 1];
  return {
    file_id: rec.file_id,
    relative_path: rec.relative_path,
    title: rec.title,
    format: rec.format,
    folder: rec.folder,
    role: rec.role,
    status: row.status,
    current_revision_id: rec.current_revision_id,
    revision_count: revs.length,
    first_observed_at: row.first_observed_at,
    last_observed_at: row.last_observed_at,
    // 契约新增字段：最早版本的 occurred_at（§1.3 first_source_time / §5.1）
    first_source_time: revs[0]?.source_time ?? null,
    coverage: rec.coverage,
    // 非 PDF 不带 pdf_status 键：FileRecord.pdfStatus 为 undefined 口径（project.ts:201-205，
    // Rust dto.rs 同注 skip_serializing_if）；冻结成 null 会被键集合并集深比判成差异
    ...(rec.pdfStatus !== undefined ? { pdf_status: rec.pdfStatus } : {}),
    snapshot_available: current?.snapshotAvailable ?? false,
  };
}

function buildFacets(summaries: Array<Record<string, unknown>>): {
  folders: Record<string, number>;
  formats: Record<string, number>;
  matters: Record<string, number>;
} {
  const folders: Record<string, number> = {};
  const formats: Record<string, number> = {};
  const matters: Record<string, number> = {};
  for (const s of summaries) {
    const f = String(s.folder);
    const fmt = String(s.format);
    const m = String(s.role);
    folders[f] = (folders[f] || 0) + 1;
    formats[fmt] = (formats[fmt] || 0) + 1;
    matters[m] = (matters[m] || 0) + 1;
  }
  return { folders, formats, matters };
}

/** files 全量摘要：relative_path ASC、file_id 兜底（契约 §1.3 排序固化） */
function buildFileSummaries(files: FileRecord[], rows: FileRow[]): Array<Record<string, unknown>> {
  const rowById = new Map(rows.map((r) => [r.file_id, r]));
  return files
    .map((rec) => toFileSummary(rec, rowById.get(rec.file_id)!))
    .sort((a, b) => {
      const pa = String(a.relative_path);
      const pb = String(b.relative_path);
      if (pa !== pb) return pa < pb ? -1 : 1;
      return String(a.file_id) < String(b.file_id) ? -1 : String(a.file_id) > String(b.file_id) ? 1 : 0;
    });
}

/**
 * 事件日桶的决定边界字段（issue #25）：
 * Node 的 `queryEventDays` 不产出 `decision_total` / `decisions_truncated`（这两个字段是
 * v1 契约 §1.5 新增）。期望基线按同一语义补齐：
 * - `decision_total` = 桶内去重 decision_id 数（Node 侧已是「一决定一行」的聚合结果）；
 * - 桶内决定样本上限 20，超出截断并置 `decisions_truncated=true`。
 * 保持「期望值来自 Node 口径 + 契约新增字段」的一致基线，不改动 Node 的查询行为。
 */
const BUCKET_DECISION_CAP = 20;
function withBucketDecisionBoundary<T extends { groups: readonly unknown[] }>(result: T): T {
  return {
    ...result,
    groups: result.groups.map((group) => {
      const g = group as Record<string, unknown>;
      const decisions = Array.isArray(g.decisions)
        ? (g.decisions as Array<Record<string, unknown>>)
        : [];
      const decisionTotal = decisions.length;
      const capped = decisions.slice(0, BUCKET_DECISION_CAP);
      return {
        ...g,
        decisions: capped,
        decision_total: decisionTotal,
        decisions_truncated: decisionTotal > capped.length,
      };
    }),
  };
}

// ---------- 第四部分：期望结果导出 ----------

/** events 全量遍历：limit 200 逐页走到末页（期望只存条目集合与首页统计） */
function walkAllEvents(
  store: WorkspaceStore,
  wsId: string,
  query: Omit<EventQuery, 'workspaceId'>
): ReturnType<typeof queryEvents> {
  let cursor: string | null = null;
  const items: ReturnType<typeof queryEvents>['items'] = [];
  let firstPage: ReturnType<typeof queryEvents> | null = null;
  for (;;) {
    const page = queryEvents(store, { ...query, workspaceId: wsId, limit: 200, cursor });
    if (!firstPage) firstPage = page;
    items.push(...page.items);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return { ...firstPage!, items };
}

function exportExpected(
  store: WorkspaceStore,
  wsId: string,
  files: FileRecord[],
  rows: FileRow[]
): void {
  const ws = store.getWorkspace(wsId)!;
  const projection = projectWorkspace(store, WS_ROOT, {});
  const activeRows = rows.filter((r) => r.status === 'active');
  const summaries = buildFileSummaries(files, activeRows);
  const facets = buildFacets(summaries);
  const indexGeneration = ws.index_generation;

  // ---- status（§1.2 可比字段；instance_id/api_version/schema_version 属 Rust 实例字段，
  //      Node 端产不出，smoke 只验其存在与 api_version==='v1'，不做期望比对） ----
  writeJson('status.json', {
    ok: true,
    workspace_id: ws.workspace_id,
    root_path: ws.root_path,
    data_dir: store.dataDir,
    index_generation: indexGeneration,
    last_scan_at: ws.last_scan_at,
    baseline: store.hasBaseline(wsId),
    counts: store.counts(wsId),
    time_range: eventTimeRange(store, wsId),
    index_coverage: {
      active_files: activeRows.length,
      missing_files: rows.length - activeRows.length,
    },
    // 批次一恒空（contract-query-api.md §1.2）：Rust StatusResponse 恒带 active_jobs: []，
    // 期望基线须含同键，smoke 的键集合并集深比才不会多出 $.active_jobs 差异
    active_jobs: [],
    // PRD v2.0 §3.4 增量字段（contract-query-api.md §1.2）：L4A 非阻塞进度横幅与
    // watcher 状态。Node 管线没有 watcher/后台队列，等价口径即「未启用、队列为空」；
    // 键必须常驻（不按运行模式增删），否则客户端会看到随配置变化的响应形状。
    watcher: {
      enabled: false,
      last_poll_at: null,
      changed_paths_pending: 0,
      l4a_queue_depth: 0,
    },
    l4a_progress: { done: 0, total: 0, percent: 100, queue_depth: 0 },
  });

  // ---- files 全量摘要（§1.3 FileSummaryPage；本夹具一页放下） ----
  const filesPage = {
    ok: true,
    index_generation: indexGeneration,
    snapshot_generation: indexGeneration,
    items: summaries,
    next_cursor: null,
    has_more: false,
    total_matched: summaries.length,
    facets,
  };
  writeJson('files.json', filesPage);

  // ---- events 罐装查询组（§1.4）：smoke 逐组以小页距全页遍历后整体比对 ----
  const eventsQueries: Array<{ name: string; query: Omit<EventQuery, 'workspaceId'> }> = [
    { name: 'events-all-occurred', query: {} },
    { name: 'events-all-observed', query: { order: 'observed' } },
    { name: 'events-kinds-appeared', query: { kinds: ['appeared'] } },
    { name: 'events-kinds-appeared-modified', query: { kinds: ['appeared', 'modified'] } },
    { name: 'events-kinds-decision', query: { kinds: ['decision_raised', 'decision_changed'] } },
    { name: 'events-format-md', query: { format: 'md' } },
    { name: 'events-undated', query: { undated: true } },
    { name: 'events-window', query: { from: '2026-10-12', to: '2026-10-15' } },
    { name: 'events-q-modified', query: { q: '检测到更新' } },
  ];
  for (const { name, query } of eventsQueries) {
    const full = walkAllEvents(store, wsId, query);
    writeJson(`${name}.json`, {
      name,
      query,
      traversal_limit: 7, // smoke 翻页页距：逼出多页与游标路径
      index_generation: full.index_generation,
      snapshot_max_seq: full.snapshot_max_seq,
      total_in_window: full.total_in_window,
      undated_count: full.undated_count,
      window: full.window,
      items: full.items,
    });
  }
  // 首页包络（默认 limit 50）：smoke 对整包逐字段深比（next_cursor 只验型不验值）
  writeJson('events-first-page.json', {
    query: { limit: 50 },
    envelope: queryEvents(store, { workspaceId: wsId, limit: 50 }),
  });

  // ---- events/days（§1.5）：无游标，直接导出整结果 ----
  // run 用 Node 内部属性名（EventDaysQuery.camelCase），query 冻结 v1 线上参数名
  // （契约 §1.5：limit_days；旧插件路由读 limitDays，Rust 路由只认 limit_days），
  // smoke 按冻结值原样重放，两套命名在此解耦
  const daysQueries: Array<{
    name: string;
    run: Omit<EventDaysQuery, 'workspaceId'>;
    query: Record<string, unknown>;
  }> = [
    { name: 'days-default', run: {}, query: {} },
    { name: 'days-week', run: { granularity: 'week' }, query: { granularity: 'week' } },
    { name: 'days-month', run: { granularity: 'month' }, query: { granularity: 'month' } },
    { name: 'days-observed', run: { order: 'observed' }, query: { order: 'observed' } },
    { name: 'days-md', run: { format: 'md' }, query: { format: 'md' } },
    { name: 'days-limit8', run: { limitDays: 8 }, query: { limit_days: 8 } }, // 折叠更早桶：hidden_days > 0
  ];
  for (const { name, run, query } of daysQueries) {
    writeJson(`${name}.json`, {
      name,
      query,
      result: withBucketDecisionBoundary(queryEventDays(store, { workspaceId: wsId, ...run })),
    });
  }

  // ---- events/range（§1.6）：camelCase 保留（§0.1），v1 外层补 index_generation ----
  writeJson('range.json', {
    ok: true,
    ...eventTimeRange(store, wsId),
    index_generation: indexGeneration,
  });

  // ---- 版本链（§1.7）：projectFileHistory 逐字导出（A→B→A 断言在 smoke 做） ----
  const histories: Record<string, unknown> = {};
  for (const row of rows) {
    const h = projectFileHistory(store, row.file_id);
    if (h) histories[row.file_id] = h;
  }
  writeJson('revisions.json', { index_generation: indexGeneration, histories });

  // ---- decisions（§1.9）：DecisionAssertion 遗留 wire 1:1（§0.1） ----
  writeJson('decisions.json', { index_generation: indexGeneration, items: projection.decisions });

  // ---- bootstrap（§1.1）：合并装配；事件/文件为首页，decisions 全量（量小） ----
  const bootstrapEvents = queryEvents(store, { workspaceId: wsId, limit: 50 });
  const bootstrapDays = withBucketDecisionBoundary(
    queryEventDays(store, { workspaceId: wsId, limitDays: 120, samplesPerDay: 6 }),
  );
  // A05：处于 missing / trashed 可恢复态的 file_id，供前端剪枝阅读进度时保留
  const recoverableFileIds = rows
    .filter((r) => r.status === 'missing' || String(r.status) === 'trashed')
    .map((r) => r.file_id)
    .sort();
  writeJson('bootstrap.json', {
    ok: true,
    workspace: {
      workspace_id: ws.workspace_id,
      root_path: ws.root_path,
      root_key: ws.root_key,
      created_at: ws.created_at,
      last_scan_at: ws.last_scan_at,
      index_generation: indexGeneration,
    },
    baseline: store.hasBaseline(wsId),
    counts: store.counts(wsId),
    time_range: eventTimeRange(store, wsId),
    event_days: bootstrapDays,
    events: bootstrapEvents,
    files: filesPage,
    files_total: activeRows.length,
    decisions: projection.decisions,
    relations_total: projection.relations.length,
    config: projection.config,
    index_jobs: [], // §1.1：批次一恒为空数组
    ...(recoverableFileIds.length > 0 ? { recoverable_file_ids: recoverableFileIds } : {}),
  });

  // ---- revision content 样本（§1.8）：md/svg/pdf 各一，字节以 blobs 快照文件为准绳 ----
  const rowByPath = (p: string): FileRow => {
    const r = rows.find((x) => x.current_path === p);
    if (!r) throw new Error(`夹具缺文件行：${p}`);
    return r;
  };
  const sampleOf = (row: FileRow, seq: number): Record<string, unknown> => {
    const rev = store.revisionsOfFile(row.file_id).find((r) => r.seq === seq);
    if (!rev) throw new Error(`夹具缺版本：${row.current_path} r${seq}`);
    const read = readRevisionContent(store, rev.revision_id);
    if (!read.ok) throw new Error(`快照不可读：${rev.revision_id}`);
    const bytes = fs.readFileSync(store.snapshotPath(rev.content_hash));
    return {
      revision_id: rev.revision_id,
      format: read.format ?? null,
      content_hash: rev.content_hash,
      size_bytes: bytes.length,
      // pdf 不返回 text（readRevisionContent 只给 snapshotPath），smoke 改比 raw=1 字节
      text: read.text ?? null,
    };
  };
  writeJson('content.json', {
    md: sampleOf(rowByPath('docs/方案/回滚目标-方案.md'), 1),
    svg: sampleOf(rowByPath('assets/架构示意图.svg'), 2),
    pdf: sampleOf(rowByPath('manuals/参考手册.pdf'), 1),
  });

  // ---- 错误包络样本（§0.2）与 smoke 需要的定位信息 ----
  const rollbackRow = rowByPath('docs/方案/回滚目标-方案.md');
  const rollbackRevs = store.revisionsOfFile(rollbackRow.file_id);
  const svgRow = rowByPath('assets/架构示意图.svg');
  const pdfRow = rowByPath('manuals/参考手册.pdf');
  const q01Row = rowByPath('docs/Q01-登录决策记录.md');
  const guideRow = rowByPath('docs/说明/使用说明.md');
  const missingRow = rows.find((r) => r.status === 'missing');

  writeJson('meta.json', {
    fixture_root: WS_ROOT,
    data_dir: DATA_DIR,
    root_key: ws.root_key,
    workspace_id: ws.workspace_id,
    index_generation: indexGeneration,
    counts: store.counts(wsId),
    key_files: {
      rollback: {
        file_id: rollbackRow.file_id,
        relative_path: rollbackRow.current_path,
        revisions: rollbackRevs.map((r) => ({
          seq: r.seq,
          revision_id: r.revision_id,
          content_hash: r.content_hash,
        })),
      },
      q01_decision: { file_id: q01Row.file_id, relative_path: q01Row.current_path },
      svg_diagram: { file_id: svgRow.file_id, relative_path: svgRow.current_path },
      pdf_reference: { file_id: pdfRow.file_id, relative_path: pdfRow.current_path },
      user_guide: { file_id: guideRow.file_id, relative_path: guideRow.current_path },
      logo_missing: missingRow
        ? { file_id: missingRow.file_id, relative_path: missingRow.current_path }
        : null,
    },
    totals: {
      files_all: rows.length,
      files_active: activeRows.length,
      events: store.counts(wsId).events,
      decisions: projection.decisions.length,
    },
  });

  writeJson('errors.json', {
    not_found: {
      // 不存在的主体：期望 404 + { ok:false, code:'NOT_FOUND' }（§0.2 码表）
      file_id_sample: `f_${'0'.repeat(24)}`,
      revision_id_sample: `f_${'0'.repeat(24)}_r1`,
      expected: { status: 404, code: 'NOT_FOUND' },
    },
    cursor_stale: {
      // 不可解码游标：v1 显式 409 CURSOR_STALE（§0.2/§1.4；旧 Node 实现静默按首页处理，
      // queries.ts:186-187，差异记入 legacy_node_behavior 供对照）
      corrupt_cursor: 'not-a-valid-cursor',
      // 可解码但字段缺失：同样按游标损坏处理
      empty_object_cursor: Buffer.from('{}', 'utf-8').toString('base64url'),
      // 指纹不符：smoke 取任一真实首页游标后改动任一筛选参数重放
      fingerprint_mismatch: '构造于运行时（真实游标 + 换 kinds）',
      expected: { status: 409, code: 'CURSOR_STALE' },
      legacy_node_behavior: {
        code: 'INDEX_STALE',
        reason: '旧实现把指纹不符并进 INDEX_STALE（queries.ts:189-195），v1 拆给 CURSOR_STALE',
      },
    },
  });

  // ---- v1 字段名映射表（供 Rust DTO 与前端改造对照） ----
  writeJson('_field-map.json', {
    basis: 'native/docs/contract-query-api.md（批次一 v1 契约）',
    exports: {
      'bootstrap.json':
        '§1.1 bootstrap；event_days/events/time_range/decisions/config 保留现有 wire 命名（§0.1），workspace/counts 为 snake_case',
      'status.json':
        '§1.2 status；缺 instance_id/api_version/schema_version（Rust 实例字段，Node 端产不出，smoke 只验存在与 api_version=v1）',
      'files.json': '§1.3 FileSummaryPage；FileRecord→FileSummary 重命名见 renames.files',
      'events-*.json': '§1.4 EventPage 原样（queries.ts 直接映射，字段不改名）',
      'days-*.json': '§1.5 EventDaysResult 原样（queryEventDays 直接映射）',
      'range.json': '§1.6 eventTimeRange（camelCase 保留，§0.1）+ v1 补 index_generation',
      'revisions.json': '§1.7 projectFileHistory 逐字（本就是 snake_case），v1 外层补 ok/index_generation',
      'decisions.json': '§1.9 DecisionAssertion 遗留 wire 1:1（§0.1）',
      'content.json': '§1.8 revisions/{id}/content；pdf 无 text，走 raw=1 字节比对',
    },
    renames: {
      files: {
        relative_path: 'relative_path（不变，来源 files.current_path）',
        current_revision_id: 'current_revision_id（来源 project.ts:176-178 current 投影）',
        revision_count: 'revision_count（新：revisions 数组长度）',
        first_observed_at: 'first_observed_at（来源 files 行，WorkspaceStore.ts:55）',
        last_observed_at: 'last_observed_at（来源 files 行，WorkspaceStore.ts:56）',
        first_source_time: 'first_source_time（新：最早版本 occurred_at，契约 §5.1）',
        pdf_status: 'pdfStatus → pdf_status',
        snapshot_available: '当前版 snapshotAvailable → snapshot_available',
        coverage: 'coverage（不变，project.ts:180-187 判定）',
      },
    },
    sortings: {
      files: 'relative_path ASC，file_id 兜底（契约 §1.3）',
      events_occurred: "COALESCE(occurred_at,'') DESC, seq DESC（queries.ts:216）",
      events_observed: 'observed_at DESC, seq DESC',
      decisions: '来源不一致 < 待确认 < 已确认 < 其他，再按 code 字典序（project.ts:428-429）',
    },
    tolerances: {
      'days-*.json groups[].decisions':
        '同组内 decisions 数组 Node 端无排序保证（SQL GROUP BY 输出序，queries.ts:518-541），smoke 按无序集合比对',
      'status.json / bootstrap.json 的 instance 字段':
        'instance_id/api_version/schema_version 为 Rust 实例字段，不做值比对',
    },
  });
}

// ---------- 第五部分：身份向量（native/docs/contract-storage.md §2） ----------

function exportIdentityVectors(fixtureStore: WorkspaceStore, fixtureWsId: string): void {
  const fixtureWs = fixtureStore.getWorkspace(fixtureWsId)!;

  // 旁支小工作区：用真实对账管线产出「大小写混合 / 空格 / 中文」路径的 file_id
  fs.rmSync(IDENTITY_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(ID_ROOT, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(ID_ROOT, '资料 库'), { recursive: true });
  fs.mkdirSync(path.join(ID_ROOT, 'deep', 'path', 'with space'), { recursive: true });
  fs.writeFileSync(path.join(ID_ROOT, 'Notes', 'ReadMe.MD'), '# 身份向量样本\n', 'utf-8');
  fs.writeFileSync(path.join(ID_ROOT, '资料 库', '摘要 文档.MD'), '# 中文路径样本\n', 'utf-8');
  fs.writeFileSync(path.join(ID_ROOT, 'deep', 'path', 'with space', 'Doc v2.md'), '# 深层路径样本\n', 'utf-8');
  const idStore = new WorkspaceStore(ID_DATA);
  reconcileWorkspace(ID_ROOT, { dataDir: ID_DATA, store: idStore, now: '2026-11-01T08:00:00.000Z' });
  const idRootKey = rootKeyOf(ID_ROOT);
  const idRows = idStore.listFiles(idStore.ensureWorkspace(ID_ROOT).workspace_id, true);

  // file_id 归一化公式（contract-storage.md §2.3）：f_ + sha256(rootKey|斜杠规范化小写路径) 前 24 hex
  const fileIdByFormula = (rootKey: string, relPath: string): string =>
    `f_${createHash('sha256')
      .update(`${rootKey}|${relPath.replace(/\\/g, '/').toLowerCase()}`)
      .digest('hex')
      .slice(0, 24)}`;

  // 自检：管线产出的 file_id 必须与公式一致（防夹具身份漂移）
  for (const row of idRows) {
    const computed = fileIdByFormula(idRootKey, row.current_path);
    check(
      computed === row.file_id,
      `file_id 公式自检失败：${row.current_path} 公式=${computed} 管线=${row.file_id}`
    );
  }

  // rootKey 样本：path.resolve 各形态（§2.1-2 逐条）。注意 win32 上 path.join 产物是反斜杠形态。
  const wsFwd = WS_ROOT.replace(/\\/g, '/');
  const resolveVariants = [
    { input: WS_ROOT, note: '原生反斜杠绝对路径（path.join 产物）' },
    { input: wsFwd, note: '正斜杠形态：resolve 后应与反斜杠形态同串同 key' },
    { input: `${WS_ROOT}\\`, note: '结尾分隔符：resolve 应去掉' },
    {
      input: WS_ROOT.replace(/^([a-zA-Z]):/, (m) => `${m.toLowerCase()}`),
      note: '盘符小写：resolve 原样保留盘符大小写 → 与原串不同 → 不同 rootKey（§2.1-2 实测行为）',
    },
    {
      input: WS_ROOT.replace(/^([a-zA-Z]):/, (m) => `${m.toUpperCase()}`),
      note: '盘符大写形态',
    },
    {
      input: path.relative(process.cwd(), WS_ROOT) || '.',
      note: `相对路径：按进程 CWD 解析（cwd=${process.cwd()}）`,
    },
    { input: ID_ROOT, note: '身份旁支工作区根（反斜杠）' },
    { input: 'H:', note: '纯盘符：resolve 到该盘当前目录（§2.1-2）' },
  ];
  const rootKeyCases = resolveVariants.map((v) => {
    const resolved = path.resolve(v.input);
    const key = rootKeyOf(v.input);
    return { input: v.input, resolved, root_key: key, workspace_id: `ws_${key}`, note: v.note };
  });
  // 自检：正斜杠与反斜杠形态的 resolve 结果一致（同一工作区身份），盘符大小写形态必须不同
  const byNote = (frag: string): { resolved: string; root_key: string } => {
    const hit = rootKeyCases.find((c) => c.note.includes(frag));
    if (!hit) throw new Error(`rootKey 样本缺形态：${frag}`);
    return hit;
  };
  const nativeForm = byNote('原生反斜杠');
  const fwdForm = byNote('正斜杠形态');
  check(
    nativeForm.resolved === fwdForm.resolved && nativeForm.root_key === fwdForm.root_key,
    `正斜杠/反斜杠形态 resolve 结果应一致：${nativeForm.resolved} vs ${fwdForm.resolved}`
  );
  const lowerDrive = byNote('盘符小写');
  check(
    lowerDrive.root_key !== nativeForm.root_key,
    '盘符大小写形态应产出不同 rootKey（contract-storage.md §2.1-2）'
  );

  // 便携校验：契约文档中的实测样例（contract-storage.md:236）——与文档不符即失败
  const portableRootKey = rootKeyOf('D:\\notebooks\\demo');
  check(portableRootKey === '6d74a29df40616ec', `rootKey 便携样例与契约文档不符：实得 ${portableRootKey}`);

  // file_id 样本：管线 DB 值为准绳；反斜杠 / 大小写输入变体按归一化公式应得同一 ID
  const fileIdCases: Array<Record<string, unknown>> = [];
  for (const row of idRows) {
    const canonical = row.current_path;
    const forms = [canonical, canonical.replace(/\//g, '\\'), canonical.toUpperCase(), canonical.toLowerCase()];
    for (const form of new Set(forms)) {
      const normalized = form.replace(/\\/g, '/').toLowerCase();
      const computed = fileIdByFormula(idRootKey, form);
      check(computed === row.file_id, `file_id 变体归一化自检失败：${form}`);
      fileIdCases.push({
        root_key: idRootKey,
        input: form,
        normalized_input: normalized,
        file_id: row.file_id,
        expected_source: 'node_pipeline_db + formula_cross_check',
        variant_of: canonical,
      });
    }
  }

  // 夹具文件的 file_id 清单：Rust 存储层批次校验的逐行准绳
  const fixtureFileIds = fixtureStore.listFiles(fixtureWsId, true).map((r) => ({
    relative_path: r.current_path,
    file_id: r.file_id,
  }));
  for (const f of fixtureFileIds) {
    check(
      fileIdByFormula(fixtureWs.root_key, f.relative_path) === f.file_id,
      `夹具 file_id 公式自检失败：${f.relative_path}`
    );
  }

  const vectors = {
    doc: '身份向量：rootKey 与 file_id 的 Node 端期望值。算法依据 native/docs/contract-storage.md §2（[逐字兼容]）。',
    generated_by: 'scripts/seed-fixture.ts',
    node: { version: process.version, platform: process.platform, cwd: process.cwd() },
    root_key_cases: rootKeyCases,
    portable: [
      {
        input: 'D:\\notebooks\\demo',
        root_key: '6d74a29df40616ec',
        source: 'native/docs/contract-storage.md:236（生成时已用 rootKeyOf 实测断言一致）',
      },
    ],
    file_id_cases: fileIdCases,
    fixture_files: fixtureFileIds,
    notes: [
      'file_id 公式（contract-storage.md §2.3）：f_ + sha256(rootKey + "|" + 反斜杠转斜杠后的小写相对路径) 前 24 hex；生成时已对每行用公式交叉自检。',
      '反斜杠 / 大小写输入在 Windows 文件系统上与正斜杠形态是同一文件：expected 值取自对账管线 DB（reconcile 真实产出）。',
      'rootKey 输入是 path.resolve 结果字符串，禁止 canonicalize（contract-storage.md §2.1-1）。',
    ],
  };
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(vectors, null, 2) + '\n', 'utf-8');
  idStore.close();
}

// ---------- 第六部分：夹具不变量断言 ----------

function assertInvariants(store: WorkspaceStore, wsId: string, rounds: RoundReport[]): {
  rollbackRevs: Array<{ seq: number; revision_id: string; content_hash: string }>;
} {
  const counts = store.counts(wsId);
  const kindRows = store.db
    .prepare('SELECT kind, COUNT(*) AS n FROM events WHERE workspace_id = ? GROUP BY kind')
    .all(wsId) as unknown as Array<{ kind: string; n: number }>;
  const kindCount = (k: string): number => kindRows.find((e) => e.kind === k)?.n ?? 0;
  const decisionEvents = kindCount('decision_raised') + kindCount('decision_changed');

  check(counts.events >= 60, `事件量不足 60：实得 ${counts.events}`);
  check(decisionEvents >= 7, `决策事件不足 7：实得 ${decisionEvents}`);
  check(kindCount('appeared') >= 50, `appeared 事件不足 50：实得 ${kindCount('appeared')}`);
  check(kindCount('modified') >= 5, `modified 事件不足 5：实得 ${kindCount('modified')}`);
  check(kindCount('workspace_baseline') === 1, `基线卡应恰 1 条：实得 ${kindCount('workspace_baseline')}`);
  check(kindCount('missing') === 1, `missing 事件应恰 1 条（logo.svg 删除）：实得 ${kindCount('missing')}`);

  // A→B→A：三个版本、两份内容（reconcile.ts 头注释的第一轮通过条件）
  let rollbackRevs: Array<{ seq: number; revision_id: string; content_hash: string }> = [];
  const rollback = store
    .db.prepare('SELECT file_id FROM files WHERE workspace_id = ? AND current_path = ?')
    .get(wsId, 'docs/方案/回滚目标-方案.md') as unknown as { file_id: string } | undefined;
  check(Boolean(rollback), '夹具缺回滚目标文件行');
  if (rollback) {
    rollbackRevs = store.revisionsOfFile(rollback.file_id).map((r) => ({
      seq: r.seq,
      revision_id: r.revision_id,
      content_hash: r.content_hash,
    }));
    check(rollbackRevs.length === 3, `回滚目标应有 3 个版本：实得 ${rollbackRevs.length}`);
    if (rollbackRevs.length === 3) {
      check(
        rollbackRevs[0].content_hash === rollbackRevs[2].content_hash,
        'A→B→A 自检失败：v1 与 v3 哈希不同'
      );
      check(
        rollbackRevs[0].content_hash !== rollbackRevs[1].content_hash,
        'A→B→A 自检失败：v2 与 v1 哈希相同'
      );
      const distinct = new Set(rollbackRevs.map((r) => r.content_hash));
      check(distinct.size === 2, `A→B→A 应恰两份内容：实得 ${distinct.size}`);
    }
  }

  // 仅 mtime 触碰：使用说明仍只有 1 个版本（内容未变不落版本，reconcile.ts:273-285）
  const guide = store
    .db.prepare('SELECT file_id, last_mtime_ms FROM files WHERE workspace_id = ? AND current_path = ?')
    .get(wsId, 'docs/说明/使用说明.md') as unknown as { file_id: string; last_mtime_ms: number } | undefined;
  check(Boolean(guide), '夹具缺使用说明文件行');
  if (guide) {
    const revCount = store.revisionsOfFile(guide.file_id).length;
    check(revCount === 1, `仅 mtime 触碰后版本数应为 1：实得 ${revCount}`);
    check(
      Math.abs(guide.last_mtime_ms - ts('2026-10-22T08:00:00.000Z')) < 2,
      `使用说明 mtime 未按夹具设定落库：实得 ${guide.last_mtime_ms}`
    );
  }
  const touchRound = rounds[rounds.length - 1];
  check(touchRound.report.mtimeOnly >= 1, '轮 4 报告未记录 mtimeOnly 触碰');

  // undated 事件来自 missing（occurred_at 为空）→ 供 undated=1 筛选与「日期待考」桶
  const undated = store.db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND occurred_at IS NULL')
    .get(wsId) as unknown as { n: number };
  check(undated.n >= 1, `undated 事件不足 1：实得 ${undated.n}`);

  return { rollbackRevs };
}

// ---------- 主流程 ----------

function main(): void {
  console.log('[1/5] 清空并写入夹具文件 →', WS_ROOT);
  writeFixtureFiles();

  console.log('[2/5] 四轮对账（baseline / modify / rollback / touch-and-missing）…');
  const { store, wsId, rounds } = runReconciliation();
  for (const r of rounds) {
    console.log(
      `  ${r.label.padEnd(18)} generation=${r.report.generation} 新版本=${r.report.newRevisions} ` +
        `事件+=${r.report.eventsInserted} 跳过=${r.report.eventsSkipped} 决策事件=${r.report.decisionEventsInserted} ` +
        `mtimeOnly=${r.report.mtimeOnly} missing=${r.report.missing}`
    );
  }

  console.log('[3/5] 夹具不变量断言…');
  const files = projectWorkspace(store, WS_ROOT, {}).files;
  const rows = store.listFiles(wsId, true);
  const counts = store.counts(wsId);
  const { rollbackRevs } = assertInvariants(store, wsId, rounds);

  console.log('[4/5] 导出期望结果 →', EXPECTED_DIR);
  exportExpected(store, wsId, files, rows);

  console.log('[5/5] 生成身份向量 →', IDENTITY_PATH);
  exportIdentityVectors(store, wsId);

  store.close();

  if (rollbackRevs.length === 3) {
    console.log('A→B→A：', rollbackRevs.map((r) => `v${r.seq}=${r.content_hash.slice(0, 12)}…`).join(' '));
  }
  console.log(
    `完成：文件 ${counts.files}（active ${rows.filter((r) => r.status === 'active').length}）· ` +
      `版本 ${counts.revisions} · 事件 ${counts.events} · 陈述 ${counts.statements} · 引用 ${counts.edges} · ` +
      `断言失败 ${checkFailures.length}`
  );

  if (checkFailures.length) {
    console.error('\n夹具不变量断言失败：');
    for (const f of checkFailures) console.error('  -', f);
    process.exit(1);
  }
  console.log('\n下一步（批次一服务实现后）：');
  console.log(
    '  node node_modules/tsx/dist/cli.mjs scripts/smoke-v1.ts --exe <guanlan.exe 路径>'
  );
}

main();
