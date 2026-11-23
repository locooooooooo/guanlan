/**
 * 观澜批次一端到端冒烟 —— /api/v1 逐端点比对 expected/ 期望结果
 *
 * 用法（在仓库根目录执行，不新增依赖）：
 *   node node_modules/tsx/dist/cli.mjs scripts/smoke-v1.ts --exe <guanlan.exe 路径>
 * 可选参数：
 *   --fixture <目录>  夹具目录（缺省 native/testdata/fixture/workspace；传含
 *                     workspace/ 子目录的父目录如 testdata/fixture 亦可，自动取子目录为服务根）
 *   --data <目录>     GUANLAN_DATA_DIR（缺省 native/testdata/fixture/data）
 *   --port <N>        固定端口（缺省让服务绑随机端口，从 GUANLAN_ENDPOINT 行解析）
 *   --boot-timeout <毫秒>  等端点行的超时（缺省 30000）
 *   --keep            不断服务（调试用；缺省冒烟结束即终止子进程）
 *
 * 过程：spawn `guanlan serve --root <夹具>`（env GUANLAN_DATA_DIR=<数据目录>），
 * 解析 stdout 的 `GUANLAN_ENDPOINT=http://127.0.0.1:<port>` 行拿端点（main.rs 约定），
 * 然后 fetch 逐端点与 native/testdata/expected/ 的期望结果比对：
 *   status / bootstrap / files 全页遍历+筛选 / events 全页遍历（含游标损坏与指纹不符）/
 *   events/days / events/range / 版本链（A→B→A）/ revision content 字节 / decisions /
 *   错误包络（NOT_FOUND、坏游标 CURSOR_STALE）。
 * 任一断言失败：逐条列差异并以非零码退出。
 *
 * 本脚本刻意不 import 任何 guanlan/server 实现：被测对象是 Rust 服务，
 * 期望值一律读 seed-fixture.ts 冻结的 JSON（同一次生成，同一份口径）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

// ---------- 路径与参数 ----------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SCRIPT_DIR, '..');
const TESTDATA = path.join(PKG_ROOT, 'native', 'testdata');
const DEFAULT_FIXTURE = path.join(TESTDATA, 'fixture', 'workspace');
const DEFAULT_DATA = path.join(TESTDATA, 'fixture', 'data');
const EXPECTED_DIR = path.join(TESTDATA, 'expected');

interface Args {
  exe: string;
  fixture: string;
  data: string;
  port?: number;
  bootTimeoutMs: number;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { exe: '', fixture: DEFAULT_FIXTURE, data: DEFAULT_DATA, bootTimeoutMs: 30000, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--exe': args.exe = v ?? ''; i++; break;
      case '--fixture': args.fixture = path.resolve(v ?? ''); i++; break;
      case '--data': args.data = path.resolve(v ?? ''); i++; break;
      case '--port': args.port = Number(v); i++; break;
      case '--boot-timeout': args.bootTimeoutMs = Number(v); i++; break;
      case '--keep': args.keep = true; break;
      default:
        console.error(`未知参数：${argv[i]}`);
        process.exit(2);
    }
  }
  if (!args.exe) {
    console.error('用法：node node_modules/tsx/dist/cli.mjs scripts/smoke-v1.ts --exe <guanlan.exe 路径> [--fixture <目录>] [--data <目录>] [--port N]');
    process.exit(2);
  }
  return args;
}

/**
 * 夹具根归一：seed-fixture.ts 把工作区落在 <夹具目录>/workspace（WS_ROOT）。
 * 调用方传 testdata/fixture（父目录，其下并列 workspace/ 与 data/）或直接传工作区根
 * 两种形式都接受；以「传入目录下存在 workspace/ 子目录」判定，命中则取子目录为 --root，
 * 保证 Rust 端 root_key 认领与期望产物记录的 root_path（= WS_ROOT）一致。
 */
function resolveFixtureRoot(fixtureArg: string): string {
  const withWorkspace = path.join(fixtureArg, 'workspace');
  return fs.existsSync(withWorkspace) ? withWorkspace : fixtureArg;
}

/**
 * 工作区数据目录解析（契约 contract-storage.md §3.1，WorkspaceStore.ts:267-274 同口径）：
 * GUANLAN_DATA_DIR 只是 base，其下还须挂 rootKeyOf(root) 子目录才是 index.db/blobs 所在。
 * rootKey = sha256(path.resolve(root)) 前 16 位 hex（contract-storage.md §2.3）。
 * 本脚本刻意不 import guanlan/server 实现，故按同一公式本地重算。
 */
function workspaceDataDir(dataBase: string, fixtureRoot: string): string {
  const rootKey = createHash('sha256').update(path.resolve(fixtureRoot)).digest('hex').slice(0, 16);
  return path.join(dataBase, rootKey);
}

// ---------- 深比对：对象按键集合比（无序），数组按序；差异以 $.path 定位 ----------

interface Diff {
  at: string;
  expected: string;
  actual: string;
}

interface CompareOpts {
  /** 返回 true 的路径按无序集合比对数组元素（如 days 组内 decisions，Node 端无排序保证） */
  unorderedAt?: (at: string) => boolean;
  /** 跳过比对的键（如首页包络里的 next_cursor，只另行验型） */
  skipKey?: (at: string, key: string) => boolean;
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 160 ? s.slice(0, 157) + '…' : s;
};

function deepCompare(expected: unknown, actual: unknown, at: string, diffs: Diff[], opts: CompareOpts = {}): void {
  if (expected === null || actual === null || expected === undefined || actual === undefined) {
    if (expected !== actual) diffs.push({ at, expected: show(expected), actual: show(actual) });
    return;
  }
  const expT = typeof expected;
  const actT = typeof actual;
  if (expT !== 'object' || actT !== 'object' || Array.isArray(expected) !== Array.isArray(actual)) {
    if (expT === 'number' && actT === 'number') {
      if (expected !== actual) diffs.push({ at, expected: show(expected), actual: show(actual) });
    } else if (expected !== actual) {
      diffs.push({ at, expected: `${expT}: ${show(expected)}`, actual: `${actT}: ${show(actual)}` });
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (opts.unorderedAt?.(at)) {
      const pool = [...actual];
      for (const item of expected) {
        const inner: Diff[] = [];
        const idx = pool.findIndex((candidate) => {
          inner.length = 0;
          deepCompare(item, candidate, at + '[]', inner, { skipKey: opts.skipKey });
          return inner.length === 0;
        });
        if (idx < 0) diffs.push({ at: at + '[]', expected: show(item), actual: '（集合中无匹配元素）' });
        else pool.splice(idx, 1);
      }
      for (const leftover of pool) diffs.push({ at: at + '[]', expected: '（无多余元素）', actual: show(leftover) });
    } else {
      if (expected.length !== actual.length) {
        diffs.push({ at: at + '.length', expected: String(expected.length), actual: String(actual.length) });
      }
      const n = Math.min(expected.length, actual.length);
      for (let i = 0; i < n; i++) deepCompare(expected[i], actual[i], `${at}[${i}]`, diffs, opts);
    }
    return;
  }
  const expObj = expected as Record<string, unknown>;
  const actObj = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(expObj), ...Object.keys(actObj)]);
  for (const key of keys) {
    if (opts.skipKey?.(at, key)) continue;
    deepCompare(expObj[key], actObj[key], `${at}.${key}`, diffs, opts);
  }
}

// ---------- 查询串组装 ----------

/** 把期望文件里记录的 query 对象转查询串；kinds 数组按契约用逗号连接，undated=true 记 1 */
function buildQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length) sp.set(key, value.map(String).join(','));
    } else if (value === true) {
      sp.set(key, '1');
    } else {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---------- HTTP 封装与断言记录 ----------

interface ApiResponse {
  status: number;
  contentType: string;
  json: unknown | null;
  bytes: Buffer | null;
}

class Smoke {
  endpoint = '';
  readonly diffsByCheck = new Map<string, Diff[]>();
  readonly notesByCheck = new Map<string, string[]>();

  constructor(private fetchTimeoutMs = 10000) {}

  async get(pathAndQuery: string): Promise<ApiResponse> {
    const res = await fetch(this.endpoint + pathAndQuery, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      return { status: res.status, contentType, json: await res.json(), bytes: null };
    }
    return { status: res.status, contentType, json: null, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  /** POST JSON（C02：index-jobs 提交与 search/rebuild 用） */
  async post(pathAndQuery: string, body: unknown): Promise<ApiResponse> {
    const res = await fetch(this.endpoint + pathAndQuery, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      return { status: res.status, contentType, json: await res.json(), bytes: null };
    }
    return { status: res.status, contentType, json: null, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  /** 轮询任务到终态（C02：verify_all 建检索索引 / rebuild 自愈用；20s 封顶） */
  async waitJob(jobId: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const res = await this.get('/api/v1/jobs/' + jobId);
      const state =
        (res.json as { state?: string } | null)?.state ??
        (res.json as { status?: string } | null)?.status ??
        '';
      if (state === 'completed' || state === 'failed') return state;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'timeout';
  }

  /** 单点断言：条件不成立记一条差异 */
  expect(checkId: string, cond: boolean, at: string, expected: string, actual: string): void {
    if (!cond) this.diff(checkId, { at, expected, actual });
  }

  diff(checkId: string, d: Diff): void {
    if (!this.diffsByCheck.has(checkId)) this.diffsByCheck.set(checkId, []);
    this.diffsByCheck.get(checkId)!.push(d);
  }

  /** 两值深比对并落差异 */
  compare(checkId: string, expected: unknown, actual: unknown, at: string, opts: CompareOpts = {}): void {
    const diffs: Diff[] = [];
    deepCompare(expected, actual, at, diffs, opts);
    for (const d of diffs) this.diff(checkId, d);
  }

  note(checkId: string, message: string): void {
    if (!this.notesByCheck.has(checkId)) this.notesByCheck.set(checkId, []);
    this.notesByCheck.get(checkId)!.push(message);
  }
}

/** 等待 stdout 的 GUANLAN_ENDPOINT 行（main.rs:90 约定）；超时带 stderr 尾巴报错 */
function waitForEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      reject(new Error(`等待 GUANLAN_ENDPOINT 行超时（${timeoutMs}ms）。stdout=「${out.trim()}」 stderr=「${err.trim().slice(-800)}」`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer): void => {
      out += chunk.toString('utf-8');
      const m = /^GUANLAN_ENDPOINT=(\S+)\s*$/m.exec(out);
      if (m) {
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        resolve(m[1]);
      }
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf-8');
      // 运行诊断走 stderr（main.rs 约定），转发到本进程 stderr，不污染 stdout 解析
      process.stderr.write('[guanlan] ' + chunk.toString('utf-8'));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务进程提前退出（code=${code}）。stderr=「${err.trim().slice(-800)}」`));
    });
  });
}

// ---------- 通用游标遍历：小页距逼出多页；校验 ok/has_more/next_cursor 链自洽 ----------

interface PageEnvelope {
  ok?: boolean;
  index_generation?: number;
  next_cursor?: string | null;
  has_more?: boolean;
  total_matched?: number;
  newer_count?: number;
  [k: string]: unknown;
}

interface WalkResult {
  pages: PageEnvelope[];
  items: Array<Record<string, unknown>>;
}

async function walkPages(
  smoke: Smoke,
  checkId: string,
  basePath: string,
  params: Record<string, unknown>,
  limit: number,
  /** 分页数组键：files/events/decisions 为 items；版本链端点为 revisions（§1.7） */
  itemsKey: 'items' | 'revisions' = 'items',
  maxPages = 500
): Promise<WalkResult> {
  const pages: PageEnvelope[] = [];
  const items: Array<Record<string, unknown>> = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const qs = buildQuery({ ...params, ...(cursor ? { cursor } : {}), limit });
    const res = await smoke.get(basePath + qs);
    smoke.expect(checkId, res.status === 200, '$.http_status', '200', String(res.status));
    const page = res.json as PageEnvelope | null;
    if (!page || res.status !== 200) {
      smoke.expect(checkId, false, '$.body', 'JSON 分页对象', show(res.json));
      break;
    }
    smoke.expect(checkId, page.ok === true, '$.ok', 'true', show(page.ok));
    pages.push(page);
    const pageItems = ((page as Record<string, unknown>)[itemsKey] ?? []) as Array<Record<string, unknown>>;
    items.push(...pageItems);
    if (page.has_more === true) {
      smoke.expect(
        checkId,
        typeof page.next_cursor === 'string' && page.next_cursor.length > 0,
        '$.next_cursor',
        '非空字符串（has_more=true）',
        show(page.next_cursor)
      );
      if (typeof page.next_cursor === 'string') {
        if (seenCursors.has(page.next_cursor)) {
          smoke.expect(checkId, false, '$.next_cursor', '游标不重复（可收敛）', '游标循环：' + page.next_cursor.slice(0, 24) + '…');
          break;
        }
        seenCursors.add(page.next_cursor);
      }
      cursor = page.next_cursor ?? null;
    } else {
      smoke.expect(checkId, page.next_cursor === null, '$.next_cursor', 'null（has_more=false）', show(page.next_cursor));
      cursor = null;
    }
    if (!cursor) break;
    if (pages.length >= maxPages) {
      smoke.expect(checkId, false, '$.pages', `< ${maxPages} 页`, `超过 ${maxPages} 页仍未收敛`);
      break;
    }
  }
  return { pages, items };
}

// ---------- 检查登记与期望产物类型 ----------

const checkResults: Array<{ id: string; title: string }> = [];
function checkOf(id: string, title: string): string {
  checkResults.push({ id, title });
  return id;
}

interface Meta {
  fixture_root: string;
  data_dir: string;
  root_key: string;
  workspace_id: string;
  index_generation: number;
  counts: Record<string, number>;
  key_files: {
    rollback: { file_id: string; relative_path: string; revisions: Array<{ seq: number; revision_id: string; content_hash: string }> };
    q01_decision: { file_id: string; relative_path: string };
    svg_diagram: { file_id: string; relative_path: string };
    pdf_reference: { file_id: string; relative_path: string };
    user_guide: { file_id: string; relative_path: string };
    logo_missing: { file_id: string; relative_path: string } | null;
  };
  totals: Record<string, number>;
}
interface FilesExpected {
  ok: boolean;
  index_generation: number;
  snapshot_generation: number;
  items: Array<Record<string, unknown>>;
  total_matched: number;
  facets: Record<string, Record<string, number>>;
}
interface History {
  file: Record<string, unknown>;
  revisions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  statements: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}
interface ContentSample {
  revision_id: string;
  format: string | null;
  content_hash: string;
  size_bytes: number;
  text: string | null;
}
interface ErrorsExpected {
  not_found: { file_id_sample: string; revision_id_sample: string; expected: { status: number; code: string } };
  cursor_stale: {
    corrupt_cursor: string;
    empty_object_cursor: string;
    expected: { status: number; code: string };
    legacy_node_behavior: { code: string; reason: string };
  };
}

interface CheckContext {
  meta: Meta;
  statusExp: Record<string, unknown>;
  bootstrapExp: Record<string, unknown>;
  filesExp: FilesExpected;
  rangeExp: Record<string, unknown>;
  decisionsExp: { index_generation: number; items: Array<Record<string, unknown>> };
  revisionsExp: { index_generation: number; histories: Record<string, History> };
  contentExp: { md: ContentSample; svg: ContentSample; pdf: ContentSample };
  errorsExp: ErrorsExpected;
  eventsSets: Array<{
    name: string;
    query: Record<string, unknown>;
    traversal_limit: number;
    snapshot_max_seq: number;
    total_in_window: number;
    undated_count: number;
    window: Record<string, unknown>;
    items: Array<Record<string, unknown>>;
  }>;
  daysSets: Array<{ name: string; query: Record<string, unknown>; result: Record<string, unknown> }>;
  eventsFirstPageExp: { query: Record<string, unknown>; envelope: Record<string, unknown> };
  dataDir: string;
}

// ---------- 全部检查 ----------

async function runAllChecks(smoke: Smoke, ctx: CheckContext): Promise<void> {
  // ---------- C1 status（§1.2）：可比字段深比 + 实例字段存在性 ----------
  {
    const id = checkOf('status', 'GET /api/v1/status 与 expected/status.json 一致');
    const res = await smoke.get('/api/v1/status');
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    const body = res.json as Record<string, unknown> | null;
    if (body && res.status === 200) {
      smoke.expect(id, body.ok === true, '$.ok', 'true', show(body.ok));
      // 实例字段：Node 端产不出（expected/status.json 无此三键），只验存在与取值
      smoke.expect(id, typeof body.instance_id === 'string' && (body.instance_id as string).length > 0, '$.instance_id', '非空字符串', show(body.instance_id));
      smoke.expect(id, body.api_version === 'v1', '$.api_version', '"v1"', show(body.api_version));
      smoke.expect(id, typeof body.schema_version === 'number', '$.schema_version', 'number', show(body.schema_version));
      smoke.compare(id, ctx.statusExp, body, '$', {
        skipKey: (_at, key) => ['instance_id', 'api_version', 'schema_version'].includes(key),
      });
    }
  }

  // ---------- C2 bootstrap（§1.1）：整包深比（config/time_range 等沿用现有 wire 命名） ----------
  {
    const id = checkOf('bootstrap', 'GET /api/v1/bootstrap 与 expected/bootstrap.json 一致');
    const res = await smoke.get('/api/v1/bootstrap?days_limit=120&days_samples=6&events_limit=50&files_page_size=100');
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    const body = res.json as Record<string, unknown> | null;
    if (body && res.status === 200) {
      smoke.expect(id, body.ok === true, '$.ok', 'true', show(body.ok));
      // V03 SSOT 增量字段：服务端全库未决待拍板总数须与 expected/decisions.json 未决计数完全一致
      const expectedUnresolved = ctx.decisionsExp.items.filter(
        (d) => d.status !== '已确认' && d.status !== '已归档' && d.status !== '已废弃'
      ).length;
      smoke.expect(
        id,
        body.decisions_unresolved_total === expectedUnresolved,
        '$.decisions_unresolved_total',
        String(expectedUnresolved),
        show(body.decisions_unresolved_total)
      );
      smoke.compare(id, ctx.bootstrapExp, body, '$', {
        skipKey: (_at, key) => key === 'decisions_unresolved_total',
      });
    }
  }

  // ---------- C3 files：全页遍历（limit=20）无重漏 + 四类筛选子集 ----------
  {
    const id = checkOf('files-pagination', 'GET /api/v1/files 全页遍历无重漏 + 与 expected/files.json 一致');
    const walk = await walkPages(smoke, id, '/api/v1/files', {}, 20);
    smoke.compare(id, ctx.filesExp.items, walk.items, '$.items');
    smoke.expect(id, new Set(walk.items.map((i) => i.file_id)).size === walk.items.length, '$.items', 'file_id 无重复', `共 ${walk.items.length} 条`);
    const first = walk.pages[0];
    smoke.expect(id, first?.total_matched === ctx.filesExp.total_matched, '$.total_matched', String(ctx.filesExp.total_matched), show(first?.total_matched));
    smoke.compare(id, ctx.filesExp.facets, first?.facets, '$.facets');
    smoke.expect(id, first?.index_generation === ctx.filesExp.index_generation, '$.index_generation', String(ctx.filesExp.index_generation), show(first?.index_generation));
    smoke.expect(id, first?.snapshot_generation === ctx.filesExp.snapshot_generation, '$.snapshot_generation', String(ctx.filesExp.snapshot_generation), show(first?.snapshot_generation));
  }

  // files 筛选子集：期望子集由 files.json 按契约语义本地推导
  // （§1.3：dir=目录前缀含子目录、format/matter 精确匹配、q=标题或路径 LIKE）
  const filterCases: Array<{ label: string; params: Record<string, unknown>; pred: (item: Record<string, unknown>) => boolean }> = [
    { label: 'dir=docs', params: { dir: 'docs' }, pred: (i) => String(i.relative_path).startsWith('docs/') },
    { label: 'dir=docs/方案', params: { dir: 'docs/方案' }, pred: (i) => String(i.relative_path).startsWith('docs/方案/') },
    { label: 'format=svg', params: { format: 'svg' }, pred: (i) => i.format === 'svg' },
    { label: 'matter=素材', params: { matter: '素材' }, pred: (i) => i.role === '素材' },
    {
      label: 'q=批量样本',
      params: { q: '批量样本' },
      pred: (i) => `${String(i.title)} ${String(i.relative_path)}`.toLowerCase().includes('批量样本'),
    },
  ];
  for (const fc of filterCases) {
    const id = checkOf(`files-filter:${fc.label}`, `GET /api/v1/files?${fc.label} 子集与期望一致`);
    const expectedItems = ctx.filesExp.items.filter(fc.pred);
    const walk = await walkPages(smoke, id, '/api/v1/files', fc.params, 5);
    smoke.compare(id, expectedItems, walk.items, '$.items');
    smoke.expect(id, walk.pages[0]?.total_matched === expectedItems.length, '$.total_matched', String(expectedItems.length), show(walk.pages[0]?.total_matched));
  }

  // ---------- C4 events：罐装查询组全页遍历（发生/采集口径、kinds/format/undated/窗口/q） ----------
  for (const set of ctx.eventsSets) {
    const id = checkOf(`events:${set.name}`, `GET /api/v1/events ${set.name} 全页遍历一致`);
    const walk = await walkPages(smoke, id, '/api/v1/events', set.query, set.traversal_limit);
    smoke.compare(id, set.items, walk.items, '$.items');
    const first = walk.pages[0];
    smoke.expect(id, first?.snapshot_max_seq === set.snapshot_max_seq, '$.snapshot_max_seq', String(set.snapshot_max_seq), show(first?.snapshot_max_seq));
    smoke.expect(id, first?.total_in_window === set.total_in_window, '$.total_in_window', String(set.total_in_window), show(first?.total_in_window));
    smoke.expect(id, first?.undated_count === set.undated_count, '$.undated_count', String(set.undated_count), show(first?.undated_count));
    smoke.compare(id, set.window, first?.window, '$.window');
    smoke.expect(id, first?.index_generation === ctx.meta.index_generation, '$.index_generation', String(ctx.meta.index_generation), show(first?.index_generation));
    // 夹具静态：任何一页出现 newer_count > 0 都说明服务动了夹具（批次一明令打开不重扫）
    const last = walk.pages[walk.pages.length - 1];
    smoke.expect(id, last?.newer_count === 0, '$.newer_count', '0（夹具静态）', show(last?.newer_count));
  }

  // 首页包络（默认 limit=50）整包深比；next_cursor 值依赖签发时刻，只验型
  {
    const id = checkOf('events:first-page-envelope', 'GET /api/v1/events?limit=50 首页包络逐字段一致');
    const res = await smoke.get('/api/v1/events?limit=50');
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    const body = res.json as Record<string, unknown> | null;
    if (body && res.status === 200) {
      smoke.compare(id, ctx.eventsFirstPageExp.envelope, body, '$', {
        skipKey: (_at, key) => key === 'next_cursor',
      });
      const expCursor = (ctx.eventsFirstPageExp.envelope as PageEnvelope).next_cursor;
      if (expCursor !== null && expCursor !== undefined) {
        smoke.expect(id, typeof body.next_cursor === 'string' && (body.next_cursor as string).length > 0, '$.next_cursor', '非空字符串（值不比对）', show(body.next_cursor));
      }
    }
  }

  // ---------- C5 游标失效：指纹不符与损坏游标 → CURSOR_STALE（v1；旧 Node 为 INDEX_STALE/静默首页） ----------
  {
    const id = checkOf('events:cursor-stale', '游标指纹不符 / 损坏游标 → 409 CURSOR_STALE');
    // 构造一：真实游标 + 换 kinds 重放（指纹含 kinds，queries.ts:83-98；v1 码表 §0.2）。
    // 首页取罐装集合 kinds=appeared（期望 events-kinds-appeared.json）；重放换 kinds=modified
    // —— v1 的指纹校验先于任何查询执行（queries.ts:189-195 先于 SQL），故无需该筛选拥有数据。
    const page1 = await smoke.get('/api/v1/events?kinds=appeared&limit=5');
    const p1 = page1.json as PageEnvelope | null;
    if (p1?.next_cursor && typeof p1.next_cursor === 'string') {
      const res = await smoke.get(`/api/v1/events?kinds=modified&limit=5&cursor=${encodeURIComponent(p1.next_cursor)}`);
      smoke.expect(id, res.status === ctx.errorsExp.cursor_stale.expected.status, '$.http_status(指纹不符)', String(ctx.errorsExp.cursor_stale.expected.status), String(res.status));
      const code = (res.json as { code?: string } | null)?.code;
      smoke.expect(id, code === ctx.errorsExp.cursor_stale.expected.code, '$.code(指纹不符)', ctx.errorsExp.cursor_stale.expected.code, show(code));
      smoke.expect(id, (res.json as { ok?: boolean } | null)?.ok === false, '$.ok(指纹不符)', 'false', show((res.json as { ok?: boolean } | null)?.ok));
      smoke.expect(id, typeof (res.json as { error?: string } | null)?.error === 'string', '$.error(指纹不符)', '人类可读信息字符串', show((res.json as { error?: string } | null)?.error));
    } else {
      smoke.expect(id, false, '$.next_cursor(构造前置)', '首页应返回游标', show(p1?.next_cursor));
    }
    // 构造二：不可解码 / 可解码但缺字段的游标（v1 显式 409；旧 Node 静默按首页处理，queries.ts:186-187）
    for (const [label, cursor] of [
      ['不可解码', ctx.errorsExp.cursor_stale.corrupt_cursor],
      ['缺字段', ctx.errorsExp.cursor_stale.empty_object_cursor],
    ] as const) {
      const res = await smoke.get(`/api/v1/events?limit=5&cursor=${encodeURIComponent(cursor)}`);
      smoke.expect(id, res.status === ctx.errorsExp.cursor_stale.expected.status, `$.http_status(${label}游标)`, String(ctx.errorsExp.cursor_stale.expected.status), String(res.status));
      const code = (res.json as { code?: string } | null)?.code;
      smoke.expect(id, code === ctx.errorsExp.cursor_stale.expected.code, `$.code(${label}游标)`, ctx.errorsExp.cursor_stale.expected.code, show(code));
    }
    // files 端点同样绑游标（§1.3 snapshot_generation 语义）
    const resFiles = await smoke.get(`/api/v1/files?limit=5&cursor=${encodeURIComponent(ctx.errorsExp.cursor_stale.corrupt_cursor)}`);
    smoke.expect(id, resFiles.status === 409, '$.http_status(files 坏游标)', '409', String(resFiles.status));
    smoke.note(id, `旧 Node 实现对照（非本轮断言）：指纹不符 → ${ctx.errorsExp.cursor_stale.legacy_node_behavior.code}；坏游标 → 静默首页（queries.ts:186-195）`);
  }

  // ---------- C6 events/days（§1.5）：六组聚合整结果比对（组内 decisions 无序集合） ----------
  for (const set of ctx.daysSets) {
    const id = checkOf(`days:${set.name}`, `GET /api/v1/events/days ${set.name} 一致`);
    const res = await smoke.get('/api/v1/events/days' + buildQuery(set.query));
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    if (res.json && res.status === 200) {
      smoke.compare(id, set.result, res.json, '$', {
        // queries.ts:518-541 组内 decisions 数组无排序保证 → 集合比对（见 _field-map.json tolerances）
        unorderedAt: (at) => /\.groups\[\d+\]\.decisions$/.test(at),
      });
    }
  }

  // ---------- C7 events/range（§1.6） ----------
  {
    const id = checkOf('range', 'GET /api/v1/events/range 与期望一致');
    const res = await smoke.get('/api/v1/events/range');
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    if (res.json && res.status === 200) smoke.compare(id, ctx.rangeExp, res.json, '$');
  }

  // ---------- C8 版本链：A→B→A 三版两份内容 + history 整包一致（§1.7） ----------
  {
    const id = checkOf('revisions:rollback-aba', '回滚目标版本链 A→B→A：三版两份内容 + 与 expected 一致');
    const rb = ctx.meta.key_files.rollback;
    const history = ctx.revisionsExp.histories[rb.file_id];
    const walk = await walkPages(smoke, id, `/api/v1/files/${rb.file_id}/revisions`, { order: 'seq_asc', include: 'events,statements,edges' }, 2, 'revisions');
    // 分页只切 revisions 数组；file/events/statements/edges 属整包部分
    smoke.compare(id, history.revisions, walk.items, '$.revisions');
    const first = walk.pages[0];
    smoke.compare(id, history.file, first?.file, '$.file');
    smoke.compare(id, history.events, first?.events, '$.events');
    smoke.compare(id, history.statements, first?.statements, '$.statements');
    smoke.compare(id, history.edges, first?.edges, '$.edges');
    smoke.expect(id, walk.items.length === 3, '$.revisions.length', '3', String(walk.items.length));
    if (walk.items.length === 3) {
      const hashes = walk.items.map((r) => String(r.content_hash));
      smoke.expect(id, hashes[0] === hashes[2], '$.revisions[0,2].content_hash', 'A 版哈希一致（同哈希共享快照）', `${hashes[0].slice(0, 12)}… vs ${hashes[2].slice(0, 12)}…`);
      smoke.expect(id, hashes[0] !== hashes[1], '$.revisions[1].content_hash', 'B 版哈希不同于 A', `${hashes[1].slice(0, 12)}…`);
      smoke.expect(id, new Set(hashes).size === 2, '$.revisions', '恰两份内容', `${new Set(hashes).size} 份`);
      smoke.expect(id, walk.items[0].prev_revision_id === null, '$.revisions[0].prev_revision_id', 'null', show(walk.items[0].prev_revision_id));
      smoke.expect(id, walk.items[1].prev_revision_id === walk.items[0].revision_id, '$.revisions[1].prev_revision_id', String(walk.items[0].revision_id), show(walk.items[1].prev_revision_id));
      smoke.expect(id, walk.items[2].prev_revision_id === walk.items[1].revision_id, '$.revisions[2].prev_revision_id', String(walk.items[1].revision_id), show(walk.items[2].prev_revision_id));
    }
    // 缺失文件的链仍可读（logo.svg 已 missing，但历史不删）
    if (ctx.meta.key_files.logo_missing) {
      const resMissing = await smoke.get(`/api/v1/files/${ctx.meta.key_files.logo_missing.file_id}/revisions?order=seq_asc`);
      smoke.expect(id, resMissing.status === 200, '$.http_status(missing 文件链)', '200（missing 不影响历史读取）', String(resMissing.status));
    }
  }
  // 其余关键文件的 history 整包比对（Q01 两版决策链 + svg 两版）
  for (const key of ['q01_decision', 'svg_diagram'] as const) {
    const kf = ctx.meta.key_files[key];
    const id = checkOf(`revisions:${key}`, `GET /api/v1/files/{id}/revisions ${kf.relative_path} 整包一致`);
    const history = ctx.revisionsExp.histories[kf.file_id];
    const walk = await walkPages(smoke, id, `/api/v1/files/${kf.file_id}/revisions`, { order: 'seq_asc', include: 'events' }, 1, 'revisions');
    smoke.compare(id, history.revisions, walk.items, '$.revisions');
    smoke.compare(id, history.file, walk.pages[0]?.file, '$.file');
    smoke.compare(id, history.events, walk.pages[0]?.events, '$.events');
  }

  // ---------- C9 revision content：字节与 blobs 快照文件一致（md/svg/pdf 各一，§1.8） ----------
  for (const kind of ['md', 'svg', 'pdf'] as const) {
    const sample = ctx.contentExp[kind];
    const id = checkOf(`content:${kind}`, `GET /api/v1/revisions/{id}/content ${kind} 与快照文件字节一致`);
    const blobPath = path.join(ctx.dataDir, 'blobs', sample.content_hash.slice(0, 2), sample.content_hash);
    const blobExists = fs.existsSync(blobPath);
    smoke.expect(id, blobExists, '$.blob_file', blobPath, blobExists ? blobPath : '（缺失）');
    const blobBytes = blobExists ? fs.readFileSync(blobPath) : Buffer.alloc(0);

    if (kind === 'pdf') {
      // pdf 默认走 JSON 包络 + raw_url（§1.8），raw=1 才是字节
      const res = await smoke.get(`/api/v1/revisions/${sample.revision_id}/content`);
      smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
      const body = res.json as Record<string, unknown> | null;
      smoke.expect(id, body?.format === 'pdf', '$.format', '"pdf"', show(body?.format));
      smoke.expect(id, typeof body?.raw_url === 'string' && String(body.raw_url).includes('raw=1'), '$.raw_url', '含 raw=1 的自指路径', show(body?.raw_url));
      const rawUrl = typeof body?.raw_url === 'string' && body.raw_url.startsWith('/') ? body.raw_url : `/api/v1/revisions/${sample.revision_id}/content?raw=1`;
      const raw = await smoke.get(rawUrl);
      smoke.expect(id, raw.status === 200, '$.raw.http_status', '200', String(raw.status));
      smoke.expect(id, raw.contentType.includes('application/pdf'), '$.raw.content-type', 'application/pdf', raw.contentType);
      smoke.expect(id, raw.bytes !== null && raw.bytes.equals(blobBytes), '$.raw.bytes', `与快照文件一致（${blobBytes.length} 字节）`, `${raw.bytes?.length ?? 'null'} 字节`);
    } else {
      const res = await smoke.get(`/api/v1/revisions/${sample.revision_id}/content`);
      smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
      const body = res.json as { ok?: boolean; format?: string; revision_id?: string; text?: string } | null;
      smoke.expect(id, body?.ok === true, '$.ok', 'true', show(body?.ok));
      smoke.expect(id, body?.format === sample.format, '$.format', show(sample.format), show(body?.format));
      smoke.expect(id, body?.revision_id === sample.revision_id, '$.revision_id', sample.revision_id, show(body?.revision_id));
      // 字节口径：HTTP text 的 UTF-8 字节必须与 blobs 快照文件完全一致
      const textBytes = Buffer.from(body?.text ?? '', 'utf-8');
      smoke.expect(id, textBytes.equals(blobBytes), '$.text 字节', `与快照文件一致（${blobBytes.length} 字节）`, `${textBytes.length} 字节`);
      smoke.expect(id, body?.text === sample.text, '$.text 内容', show((sample.text ?? '').slice(0, 60) + '…'), show((body?.text ?? '').slice(0, 60) + '…'));
    }
  }

  // ---------- C10 decisions（§1.9）：分页遍历 + status/code 筛选 ----------
  {
    const id = checkOf('decisions', 'GET /api/v1/decisions 全页遍历 + 筛选与期望一致');
    const walk = await walkPages(smoke, id, '/api/v1/decisions', {}, 3);
    smoke.compare(id, ctx.decisionsExp.items, walk.items, '$.items');
    smoke.expect(id, walk.pages[0]?.index_generation === ctx.decisionsExp.index_generation, '$.index_generation', String(ctx.decisionsExp.index_generation), show(walk.pages[0]?.index_generation));
    // status 精确筛选：待确认在前（project.ts:428-429 排序），已确认在后
    for (const st of ['待确认', '已确认'] as const) {
      const expectedItems = ctx.decisionsExp.items.filter((d) => d.status === st);
      const w = await walkPages(smoke, id, '/api/v1/decisions', { status: st }, 2);
      smoke.compare(id, expectedItems, w.items, `$.items(status=${st})`);
    }
    // code 精确筛选：Q01 恰一条（已确认）
    const codeItems = ctx.decisionsExp.items.filter((d) => d.code === 'Q01');
    const wCode = await walkPages(smoke, id, '/api/v1/decisions', { code: 'Q01' }, 10);
    smoke.compare(id, codeItems, wCode.items, '$.items(code=Q01)');
  }

  // ---------- C11 错误包络：NOT_FOUND（§0.2） ----------
  {
    const id = checkOf('errors:not-found', '不存在主体 → 404 { ok:false, code:"NOT_FOUND" }');
    const nf = ctx.errorsExp.not_found;
    const resFile = await smoke.get(`/api/v1/files/${nf.file_id_sample}/revisions`);
    smoke.expect(id, resFile.status === nf.expected.status, '$.http_status(文件)', String(nf.expected.status), String(resFile.status));
    smoke.expect(id, (resFile.json as { code?: string } | null)?.code === nf.expected.code, '$.code(文件)', nf.expected.code, show((resFile.json as { code?: string } | null)?.code));
    smoke.expect(id, (resFile.json as { ok?: boolean } | null)?.ok === false, '$.ok(文件)', 'false', show((resFile.json as { ok?: boolean } | null)?.ok));
    smoke.expect(id, typeof (resFile.json as { error?: string } | null)?.error === 'string', '$.error(文件)', '人类可读信息字符串', show((resFile.json as { error?: string } | null)?.error));

    const resRev = await smoke.get(`/api/v1/revisions/${nf.revision_id_sample}/content`);
    smoke.expect(id, resRev.status === nf.expected.status, '$.http_status(版本)', String(nf.expected.status), String(resRev.status));
    smoke.expect(id, (resRev.json as { code?: string } | null)?.code === nf.expected.code, '$.code(版本)', nf.expected.code, show((resRev.json as { code?: string } | null)?.code));
    smoke.expect(id, (resRev.json as { ok?: boolean } | null)?.ok === false, '$.ok(版本)', 'false', show((resRev.json as { ok?: boolean } | null)?.ok));
  }

  // ---------- C02 混合倒排检索（契约 §2.4）----------
  // 用 POST /api/v1/search/rebuild 建检索索引（**零污染**：只写派生表与 search_* meta，
  // 不跑 reconcile——不 touch last_scan_at/last_observed_at，不推进 index_generation，
  // 因此可重复执行且不影响前面的 golden 比对）。置于全部 golden 比对之后。
  {
    const idPre = checkOf('search:rebuild', 'search/rebuild 建索引（零污染） + search_state=ready');
    const sub = await smoke.post('/api/v1/search/rebuild', {});
    smoke.expect(idPre, sub.status === 202, '$.http_status(search/rebuild)', '202', String(sub.status));
    const jobId = (sub.json as { job_id?: string } | null)?.job_id ?? '';
    smoke.expect(idPre, jobId.length > 0, '$.job_id', '非空', jobId);
    const state = jobId ? await smoke.waitJob(jobId) : 'none';
    smoke.expect(idPre, state === 'completed', '$.job_state(search/rebuild)', 'completed', state);

    const qPhrase = encodeURIComponent('统一登录');
    const res = await smoke.get('/api/v1/search?q=' + qPhrase);
    smoke.expect(idPre, res.status === 200, '$.http_status(search)', '200', String(res.status));
    const body = (res.json ?? {}) as {
      ok?: boolean; mode?: string; search_state?: string; items?: Array<Record<string, unknown>>;
    };
    smoke.expect(idPre, body.ok === true, '$.ok', 'true', show(body.ok));
    smoke.expect(idPre, body.search_state === 'ready', '$.search_state', 'ready', show(body.search_state));
  }
  {
    const id = checkOf('search:bigram', '中文双字短语 → bigram_phrase_verified + 1-based 行号');
    const qPhrase = encodeURIComponent('统一登录');
    const res = await smoke.get('/api/v1/search?q=' + qPhrase);
    const body = (res.json ?? {}) as { mode?: string; items?: Array<Record<string, unknown>> };
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    smoke.expect(id, body.mode === 'phrase', '$.mode', 'phrase', show(body.mode));
    const items = body.items ?? [];
    smoke.expect(id, items.length > 0, '$.items.length', '>0', String(items.length));
    const mdHit = items.find((h) => String(h['relative_path'] ?? '').endsWith('Q01-登录决策记录.md'));
    smoke.expect(id, Boolean(mdHit), '$.items[Q01-登录决策记录.md]', '存在', mdHit ? '存在' : '缺失');
    if (mdHit) {
      smoke.expect(id, mdHit['match_strategy'] === 'bigram_phrase_verified', '$.match_strategy', 'bigram_phrase_verified', show(mdHit['match_strategy']));
      smoke.expect(id, mdHit['coverage'] === 'full_text', '$.coverage', 'full_text', show(mdHit['coverage']));
      const locator = (mdHit['locator'] ?? {}) as Record<string, unknown>;
      smoke.expect(id, locator['kind'] === 'lines', '$.locator.kind', 'lines', show(locator['kind']));
      const start = Number(locator['start'] ?? 0);
      smoke.expect(id, start >= 1 && start <= 12, '$.locator.start(1-based 行号)', '1..12', String(start));
      smoke.expect(id, String(mdHit['snippet'] ?? '').includes('统一登录'), '$.snippet 含命中词', '统一登录', show(mdHit['snippet']));
      smoke.expect(id, String(mdHit['revision_id'] ?? '').length > 0, '$.revision_id', '非空', show(mdHit['revision_id']));
    }
  }
  {
    const id = checkOf('search:code', '专有编号 q01 → exact_code 正文命中 + decision 陈述置顶');
    const res = await smoke.get('/api/v1/search?q=q01');
    const body = (res.json ?? {}) as { mode?: string; items?: Array<Record<string, unknown>> };
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    smoke.expect(id, body.mode === 'code', '$.mode', 'code', show(body.mode));
    const items = body.items ?? [];
    const decisionHit = items.find((h) => h['coverage'] === 'decision');
    smoke.expect(id, Boolean(decisionHit), '$.items[coverage=decision]', '存在', decisionHit ? '存在' : '缺失');
    if (decisionHit) {
      smoke.expect(id, decisionHit['match_strategy'] === 'exact_code', '$.match_strategy(decision)', 'exact_code', show(decisionHit['match_strategy']));
      smoke.expect(id, String(decisionHit['snippet'] ?? '').length > 0, '$.snippet(decision quote)', '非空', show(decisionHit['snippet']));
    }
    const codeHit = items.find((h) => h['match_strategy'] === 'exact_code' && h['coverage'] === 'full_text');
    smoke.expect(id, Boolean(codeHit), '$.items[exact_code 正文]', '存在', codeHit ? '存在' : '缺失');
    if (codeHit) {
      const locator = (codeHit['locator'] ?? {}) as Record<string, unknown>;
      smoke.expect(id, locator['kind'] === 'lines', '$.locator.kind(正文)', 'lines', show(locator['kind']));
    }
  }
  {
    const id = checkOf('search:filename-abbrev', '路径段词元 bulk → filename_match（仅文件名可检索口径）');
    const res = await smoke.get('/api/v1/search?q=bulk');
    const body = (res.json ?? {}) as { mode?: string; items?: Array<Record<string, unknown>> };
    smoke.expect(id, res.status === 200, '$.http_status', '200', String(res.status));
    const items = body.items ?? [];
    smoke.expect(id, items.length > 0, '$.items.length', '>0', String(items.length));
    const nameHit = items.find((h) => h['match_strategy'] === 'filename_match');
    smoke.expect(id, Boolean(nameHit), '$.items[filename_match]', '存在', nameHit ? '存在' : '缺失');
    if (nameHit) {
      smoke.expect(id, String(nameHit['relative_path'] ?? '').startsWith('bulk/'), '$.relative_path 前缀', 'bulk/', show(nameHit['relative_path']));
      smoke.expect(id, (nameHit['locator'] as Record<string, unknown> | undefined)?.['kind'] === 'file', '$.locator.kind', 'file', show((nameHit['locator'] as Record<string, unknown> | undefined)?.['kind']));
    }
  }
  {
    const id = checkOf('search:bad-request', '缺 q → 400 BAD_REQUEST 包络');
    const res = await smoke.get('/api/v1/search');
    smoke.expect(id, res.status === 400, '$.http_status', '400', String(res.status));
    const body = (res.json ?? {}) as { ok?: boolean; code?: string };
    smoke.expect(id, body.ok === false, '$.ok', 'false', show(body.ok));
    smoke.expect(id, body.code === 'BAD_REQUEST', '$.code', 'BAD_REQUEST', show(body.code));
  }
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 前置：夹具与期望产物齐备（否则指引先跑 seed-fixture）
  if (!fs.existsSync(args.exe)) {
    console.error(`--exe 不存在：${args.exe}`);
    process.exit(2);
  }
  // 夹具根归一：兼容传父目录（testdata/fixture）与直接传工作区根两种形式
  const fixtureRoot = resolveFixtureRoot(args.fixture);
  if (!fs.existsSync(fixtureRoot)) {
    console.error(`夹具工作区不存在：${fixtureRoot}\n先运行：node node_modules/tsx/dist/cli.mjs scripts/seed-fixture.ts`);
    process.exit(2);
  }
  const need = ['status.json', 'bootstrap.json', 'files.json', 'meta.json', 'content.json', 'decisions.json', 'range.json', 'revisions.json', 'errors.json'];
  for (const f of need) {
    if (!fs.existsSync(path.join(EXPECTED_DIR, f))) {
      console.error(`缺期望产物 expected/${f}\n先运行：node node_modules/tsx/dist/cli.mjs scripts/seed-fixture.ts`);
      process.exit(2);
    }
  }
  const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(EXPECTED_DIR, rel), 'utf-8')) as T;

  const ctx: CheckContext = {
    meta: readJson<Meta>('meta.json'),
    statusExp: readJson<Record<string, unknown>>('status.json'),
    bootstrapExp: readJson<Record<string, unknown>>('bootstrap.json'),
    filesExp: readJson<FilesExpected>('files.json'),
    rangeExp: readJson<Record<string, unknown>>('range.json'),
    decisionsExp: readJson('decisions.json'),
    revisionsExp: readJson('revisions.json'),
    contentExp: readJson('content.json'),
    errorsExp: readJson<ErrorsExpected>('errors.json'),
    eventsSets: [],
    daysSets: [],
    eventsFirstPageExp: readJson('events-first-page.json'),
    // blobs 定位与服务端同口径：GUANLAN_DATA_DIR 之下还有 rootKey 子目录（§3.1）
    dataDir: workspaceDataDir(args.data, fixtureRoot),
  };
  for (const f of fs.readdirSync(EXPECTED_DIR).sort()) {
    if (!f.endsWith('.json')) continue;
    if (/^events-(all|kinds|format|undated|window|q)-/.test(f)) ctx.eventsSets.push(readJson(f));
    if (/^days-/.test(f)) ctx.daysSets.push(readJson(f));
  }

  // 启动服务：guanlan serve --root <夹具>；数据目录经 GUANLAN_DATA_DIR 传入（WorkspaceStore.ts:272 兼容）。
  // 自测辅助：--exe 允许指向 .mjs/.js 脚本（用当前 node 运行），便于在批次一落地前用 mock
  // 服务自测本脚本全链路；正常用法仍是 Rust 二进制。
  const isScript = /\.(mjs|cjs|js)$/i.test(args.exe);
  const launcher = isScript ? process.execPath : args.exe;
  const exeArgs = [...(isScript ? [args.exe] : []), 'serve', '--root', fixtureRoot, ...(args.port ? ['--port', String(args.port)] : [])];
  console.log(`启动服务：${launcher} ${exeArgs.join(' ')}`);
  console.log(`GUANLAN_DATA_DIR=${args.data}`);
  const child = spawn(launcher, exeArgs, {
    env: { ...process.env, GUANLAN_DATA_DIR: args.data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const smoke = new Smoke();
  try {
    const endpoint = await waitForEndpoint(child, args.bootTimeoutMs);
    smoke.endpoint = endpoint;
    console.log(`端点：${endpoint}\n`);
    await runAllChecks(smoke, ctx);
  } catch (error) {
    console.error('冒烟执行失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (!args.keep) {
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    } else {
      console.log(`--keep：服务保留在 ${smoke.endpoint}（进程 pid=${child.pid}），请手动结束。`);
    }
  }

  // ---------- 汇总与非零退出 ----------
  console.log('\n========== 冒烟结果 ==========');
  let failedCount = 0;
  for (const c of checkResults) {
    const diffs = smoke.diffsByCheck.get(c.id) ?? [];
    const mark = diffs.length === 0 ? 'PASS' : 'FAIL';
    if (diffs.length) failedCount++;
    console.log(`${mark}  ${c.id.padEnd(30)} ${c.title}${diffs.length ? `（差异 ${diffs.length} 条）` : ''}`);
    for (const d of diffs.slice(0, 12)) {
      console.log(`      ${d.at}\n        期望: ${d.expected}\n        实得: ${d.actual}`);
    }
    if (diffs.length > 12) console.log(`      …另有 ${diffs.length - 12} 条差异略`);
    for (const note of smoke.notesByCheck.get(c.id) ?? []) console.log(`      注: ${note}`);
  }
  if (process.exitCode === 1) return; // 启动/执行层失败已置非零
  if (failedCount) {
    console.log(`\n冒烟失败：${failedCount}/${checkResults.length} 项检查有差异 → 非零退出`);
    process.exitCode = 1;
  } else {
    console.log(`\n冒烟通过：${checkResults.length} 项检查全部一致`);
  }
}

main().catch((error) => {
  console.error('冒烟脚本异常退出：', error);
  process.exit(1);
});
