
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SCRIPT_DIR, '..');
const TESTDATA = path.join(PKG_ROOT, 'native', 'testdata');
const DEFAULT_FIXTURE = path.join(TESTDATA, 'bench', 'workspace');
const DEFAULT_DATA = path.join(TESTDATA, 'bench', 'data');

interface Args {
  exe: string;
  fixture: string;
  data: string;
  port: number;
  samples: number;
}
function parseArgs(argv: string[]): Args {
  const args: Args = { exe: '', fixture: DEFAULT_FIXTURE, data: DEFAULT_DATA, port: 18411, samples: 300 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--exe': args.exe = v ?? ''; i++; break;
      case '--fixture': args.fixture = path.resolve(v ?? ''); i++; break;
      case '--data': args.data = path.resolve(v ?? ''); i++; break;
      case '--port': args.port = Number(v); i++; break;
      case '--samples': args.samples = Number(v || 300); i++; break;
      default: break;
    }
  }
  return args;
}
const args = parseArgs(process.argv);
if (!args.exe) {
  console.error('用法：npx tsx scripts/bench-search-v1.ts --exe <guanlan.exe> [--fixture <目录>] [--data <目录>] [--port N] [--samples N]');
  process.exit(2);
}
if (!fs.existsSync(path.join(args.fixture, 'docs'))) {
  console.error(`夹具不存在或不像基准夹具：${args.fixture}\n先运行：npx tsx scripts/seed-bench-volume.ts <目录>`);
  process.exit(2);
}

const BASE = `http://127.0.0.1:${args.port}`;
const now = (): number => Number(process.hrtime.bigint() / 1000000n);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const fmtMs = (ms: number): string => (ms >= 100 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`);

interface Report {
  lines: string[];
  failures: string[];
}
const report: Report = { lines: [], failures: [] };
function row(label: string, value: string, verdict?: 'PASS' | 'FAIL'): void {
  const tag = verdict ? ` [${verdict}]` : '';
  const line = `  ${label.padEnd(46)} ${value}${tag}`;
  report.lines.push(line);
  console.log(line);
}
function judge(label: string, actualMs: number, budgetMs: number): void {
  const ok = actualMs < budgetMs;
  row(label, `${fmtMs(actualMs)}（预算 <${fmtMs(budgetMs)}）`, ok ? 'PASS' : 'FAIL');
  if (!ok) report.failures.push(`${label}: ${fmtMs(actualMs)} 超出预算 ${fmtMs(budgetMs)}`);
}

async function getJson(pathname: string): Promise<{ ms: number; bytes: number; json: any; status: number }> {
  const t0 = now();
  const res = await fetch(`${BASE}${pathname}`);
  const buf = await res.arrayBuffer();
  const ms = now() - t0;
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return { ms, bytes: buf.byteLength, json: JSON.parse(new TextDecoder().decode(buf)), status: res.status };
}
async function postJson(pathname: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) throw new Error(`${pathname} → HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

let lastReadyMs = 0;
async function waitReady(deadlineMs: number): Promise<number> {
  const t0 = now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/v1/status`);
      if (res.ok) {
        lastReadyMs = now() - t0;
        return lastReadyMs;
      }
    } catch {
    }
    if (now() - t0 > deadlineMs) throw new Error(`服务 ${deadlineMs}ms 内未就绪`);
    await wait(100);
  }
}

async function waitJobTerminal(jobId: string, deadlineMs = 900000): Promise<void> {
  const t0 = now();
  for (;;) {
    const { json } = await getJson(`/api/v1/jobs/${jobId}`);
    const state = json.state ?? json.status ?? '';
    if (state === 'completed') return;
    if (state === 'failed') throw new Error(`任务失败：${JSON.stringify(json).slice(0, 300)}`);
    if (now() - t0 > deadlineMs) throw new Error(`任务 ${deadlineMs}ms 未到终态`);
    await wait(150);
  }
}

let child: ChildProcess | null = null;
async function startServe(): Promise<void> {
  const exeArgs = ['serve', '--root', args.fixture, '--port', String(args.port)];
  child = spawn(args.exe, exeArgs, {
    env: { ...process.env, GUANLAN_DATA_DIR: args.data },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`  [serve] ${d}`));
  await waitReady(60000);
  await wait(150);
}
async function stopServe(): Promise<void> {
  if (!child) return;
  child.kill();
  await wait(600);
  child = null;
}

interface QueryShape {
  label: string;
  q: string;
  format?: string;
  minHits: number;
}
function queryShapes(): QueryShape[] {
  const enc = (s: string): string => encodeURIComponent(s);
  return [
    { label: '中文双字短语（合成样本）', q: enc('合成样本'), minHits: 1 },
    { label: '中文长词（体量基准）', q: enc('体量基准'), minHits: 1 },
    { label: '多词编号（sample_5_7）', q: 'sample_5_7', minHits: 0 },
    { label: 'SKU 编号（sku-0001-00）', q: 'sku-0001-00', minHits: 0 },
    { label: '路径词（specs）', q: 'specs', minHits: 1 },
    { label: '单字有界回退（基）', q: enc('基'), minHits: 1 },
    { label: 'format 筛选（合成样本&md）', q: enc('合成样本'), format: 'md', minHits: 1 },
  ];
}

async function sampleShape(shape: QueryShape, rounds: number, strict: boolean): Promise<number[]> {
  const suffix = shape.format ? `&format=${shape.format}` : '';
  const lat: number[] = [];
  let lastHits = 0;
  for (let i = 0; i < rounds; i++) {
    const { ms, json } = await getJson(`/api/v1/search?q=${shape.q}${suffix}`);
    lat.push(ms);
    lastHits = Number(json.total_matched ?? 0);
    if (json.search_state !== 'ready') throw new Error(`search_state=${json.search_state}（应 ready）`);
  }
  if (strict && lastHits < shape.minHits) {
    throw new Error(`查询「${shape.label}」命中 ${lastHits} < 期望 ${shape.minHits}（召回回归）`);
  }
  return lat;
}

async function main(): Promise<void> {
  console.log(`检索基准：exe=${args.exe}`);
  console.log(`  fixture=${args.fixture}\n  data=${args.data}\n  samples=${args.samples}\n`);

  console.log('── A. 冷启动（清库首启 + verify_all 全量索引 + 检索索引首建）──');
  fs.rmSync(args.data, { recursive: true, force: true });
  await startServe();
  row('A 冷启动·服务就绪（空库）', fmtMs(lastReadyMs));

  const tJob = now();
  const accepted = await postJson('/api/v1/index-jobs', { kind: 'verify_all' });
  const jobId = accepted.job_id ?? accepted.data?.job_id;
  if (!jobId) throw new Error(`verify_all 提交失败：${JSON.stringify(accepted).slice(0, 200)}`);
  await waitJobTerminal(jobId);
  const firstIndexMs = now() - tJob;
  row('A 冷启动·verify_all 全量索引（含检索首建）', fmtMs(firstIndexMs), 'PASS');
  const { json: statusAfter } = await getJson('/api/v1/status');
  row('A index_generation', String(statusAfter.index_generation));

  const probe = await getJson(`/api/v1/search?q=${encodeURIComponent('合成样本')}`);
  if (probe.json.search_state !== 'ready') throw new Error(`检索索引未就绪：${probe.json.search_state}`);
  row('A 检索索引状态', `${probe.json.search_state}（docs=${probe.json.total_matched} 命中）`, 'PASS');

  console.log('\n── B. 检索时延（六类混合；先预热 20 轮）──');
  const shapes = queryShapes();
  for (const shape of shapes) await sampleShape(shape, 20, false);

  const perShape: Array<{ shape: QueryShape; lat: number[] }> = [];
  for (const shape of shapes) {
    const lat = await sampleShape(shape, args.samples, true);
    perShape.push({ shape, lat });
  }
  const all = perShape.flatMap((p) => p.lat).sort((a, b) => a - b);
  for (const { shape, lat } of perShape) {
    const sorted = [...lat].sort((a, b) => a - b);
    row(
      `B ${shape.label}（n=${lat.length}）`,
      `p50 ${fmtMs(percentile(sorted, 50))} / p95 ${fmtMs(percentile(sorted, 95))} / max ${fmtMs(sorted[sorted.length - 1])}`
    );
  }
  judge('B 检索 p95（六类混合，硬判）', percentile(all, 95), 30);
  judge('B 检索 p50', percentile(all, 50), 30);

  console.log('\n── C. 并发检索（4 路并发 × 每路 samples/4）──');
  const workers = 4;
  const per = Math.max(10, Math.floor(args.samples / workers));
  const t0c = now();
  const concResults = await Promise.all(
    Array.from({ length: workers }, async (_w, w) => {
      const shape = shapes[w % shapes.length];
      return sampleShape(shape, per, false);
    })
  );
  const concAll = concResults.flat().sort((a, b) => a - b);
  const concWallMs = now() - t0c;
  row(`C 并发检索（${workers}×${per}，墙钟）`, `${fmtMs(concWallMs)}`);
  row(
    'C 并发检索混合时延',
    `p50 ${fmtMs(percentile(concAll, 50))} / p95 ${fmtMs(percentile(concAll, 95))} / max ${fmtMs(concAll[concAll.length - 1])}`
  );

  console.log('\n── D. 一键重建（派生索引丢弃重建自愈）──');
  const t0d = now();
  const acceptedRebuild = await postJson('/api/v1/search/rebuild', {});
  const rebuildJobId = acceptedRebuild.job_id ?? acceptedRebuild.data?.job_id;
  if (!rebuildJobId) throw new Error(`rebuild 提交失败：${JSON.stringify(acceptedRebuild).slice(0, 200)}`);
  await waitJobTerminal(rebuildJobId);
  const rebuildMs = now() - t0d;
  row('D search/rebuild 全量重建', fmtMs(rebuildMs), 'PASS');
  const postProbe = await sampleShape(shapes[0], 5, true);
  row('D 重建后回归（中文短语 5 次采样 p95）', fmtMs(percentile([...postProbe].sort((a, b) => a - b), 95)), 'PASS');

  console.log('\n========== 检索基准结果 ==========');
  for (const line of report.lines) console.log(line);
  if (report.failures.length) {
    console.log(`\n失败 ${report.failures.length} 项：`);
    for (const f of report.failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\n检索基准全部通过（采样 ${all.length + concAll.length} 次）。`);
  }
  await stopServe();
}

main().catch(async (error) => {
  console.error('基准脚本异常退出：', error instanceof Error ? error.message : error);
  await stopServe();
  process.exit(1);
});
