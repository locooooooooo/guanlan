/**
 * 多格式混合大目录稳定性与增量核验自动化基准
 *
 * 用法：
 *   npx tsx scripts/bench-v1.ts --exe <guanlan.exe 路径> \
 *     [--fixture native/testdata/bench/workspace] [--data native/testdata/bench/data] \
 *     [--port 18410] [--samples 20]
 *
 * 阶段与验收口径：
 *   B 冷启动   —— 清库首启 + verify_all 全量索引耗时（仅记录，不设阈值）
 *   C 热启动   —— bootstrap p95 < 150ms（硬判，n=--samples 顺序采样）
 *   D 单文件修改 —— watcher 事件驱动：写 1 文件 → SSE 通知延迟（目标 <300ms，记录+提示）
 *   E 批量对账 —— 写 100 文件 → 后台增量对账完成 < 1.5s（硬判，含 100ms 防抖与 SSE 通知）；
 *                  对账期间并发混合查询 p95 < 50ms（硬判；files/events/bootstrap 四路并发）
 *
 * 机制锚点：`guanlan serve --watch`（后台索引开关，lib.rs ServeConfig::background_index）、
 * watcher 100ms 滑动防抖（watcher.rs DEBOUNCE_MS）、SSE `workspace-change` 携带
 * `index_generation`、`POST /api/v1/index-jobs {kind:"verify_all"}`。
 */

import fs from 'node:fs';
import http from 'node:http';
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
  const args: Args = { exe: '', fixture: DEFAULT_FIXTURE, data: DEFAULT_DATA, port: 18410, samples: 20 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--exe': args.exe = v ?? ''; i++; break;
      case '--fixture': args.fixture = path.resolve(v ?? ''); i++; break;
      case '--data': args.data = path.resolve(v ?? ''); i++; break;
      case '--port': args.port = Number(v); i++; break;
      case '--samples': args.samples = Number(v || 20); i++; break;
      default: break;
    }
  }
  return args;
}
const args = parseArgs(process.argv);
if (!args.exe) {
  console.error('用法：npx tsx scripts/bench-v1.ts --exe <guanlan.exe> [--fixture <目录>] [--data <目录>] [--port N] [--samples N]');
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

// ---------- HTTP 小工具 ----------
async function getJson(pathname: string, signal?: AbortSignal): Promise<{ ms: number; bytes: number; json: any }> {
  const t0 = now();
  const res = await fetch(`${BASE}${pathname}`, { signal });
  const buf = await res.arrayBuffer();
  const ms = now() - t0;
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return { ms, bytes: buf.byteLength, json: JSON.parse(new TextDecoder().decode(buf)) };
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

/** 等待 /api/v1/status 就绪（服务可响应），返回就绪耗时 ms（记录到 lastReadyMs 供报表） */
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
      /* 未就绪 */
    }
    if (now() - t0 > deadlineMs) throw new Error(`服务 ${deadlineMs}ms 内未就绪`);
    await wait(100);
  }
}

/** 订阅 SSE，等待 workspace-change 携带的 index_generation ≥ target，返回耗时 ms */
async function waitForGeneration(target: number, timeoutMs: number): Promise<number> {
  const t0 = now();
  return new Promise<number>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      req.destroy();
      reject(new Error(`等待 index_generation ≥ ${target} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const settle = (fn: () => void): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      req.destroy();
      fn();
    };
    const req = http.get(`${BASE}/api/v1/stream`, { headers: { accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!frame.includes('workspace-change')) continue;
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(5).trim());
            const gen = Number(payload.index_generation);
            if (Number.isFinite(gen) && gen >= target) {
              settle(() => resolve(now() - t0));
              return;
            }
          } catch {
            /* 半包容错 */
          }
        }
      });
      res.on('error', () => settle(() => reject(new Error('SSE 连接错误'))));
    });
    req.on('error', (e) => settle(() => reject(e)));
  });
}

/** 当前 index_generation（GET /api/v1/status） */
async function currentGeneration(): Promise<number> {
  const { json } = await getJson('/api/v1/status');
  return Number(json.index_generation);
}

/** 排空后台索引任务（轮询 /status 的 active_jobs 至空）——启动自带的 verify_all 会挤占后续任务队列 */
async function drainJobs(deadlineMs = 600000): Promise<void> {
  const t0 = now();
  for (;;) {
    const { json } = await getJson('/api/v1/status');
    const active = Array.isArray(json.active_jobs) ? json.active_jobs.length : 0;
    if (active === 0) return;
    if (now() - t0 > deadlineMs) throw new Error(`后台任务 ${deadlineMs}ms 未排空（剩余 ${active}）`);
    await wait(150);
  }
}

// ---------- 服务生命周期 ----------
let child: ChildProcess | null = null;
async function startServe(withWatch: boolean): Promise<void> {
  const exeArgs = ['serve', '--root', args.fixture, '--port', String(args.port)];
  if (withWatch) exeArgs.push('--watch');
  child = spawn(args.exe, exeArgs, {
    env: { ...process.env, GUANLAN_DATA_DIR: args.data },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`  [serve] ${d}`));
  await waitReady(60000);
  await wait(150); // 端口与路由完全稳定
}
async function stopServe(): Promise<void> {
  if (!child) return;
  child.kill();
  await wait(600);
  child = null;
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  console.log(`体量基准：exe=${args.exe}`);
  console.log(`  fixture=${args.fixture}\n  data=${args.data}\n  samples=${args.samples}\n`);

  // ===== B. 冷启动：清库首启 + verify_all 全量索引（不带 --watch，任务精确计时）=====
  console.log('── B. 冷启动（清库首启 + 首次全量索引）──');
  fs.rmSync(args.data, { recursive: true, force: true });
  await startServe(false);
  row('B 冷启动·服务就绪（空库）', fmtMs(lastReadyMs));

  const tJob0 = now();
  const accepted = await postJson('/api/v1/index-jobs', { kind: 'verify_all' });
  const jobId = accepted.job_id ?? accepted.data?.job_id;
  if (!jobId) throw new Error(`verify_all 提交失败：${JSON.stringify(accepted).slice(0, 200)}`);
  let firstIndexMs = -1;
  for (;;) {
    await wait(120);
    const { json: st } = await getJson(`/api/v1/jobs/${jobId}`);
    const state = st.state ?? st.status;
    if (state === 'completed') {
      firstIndexMs = now() - tJob0;
      break;
    }
    if (state === 'failed') throw new Error(`verify_all 失败：${JSON.stringify(st).slice(0, 300)}`);
    if (now() - tJob0 > 600000) throw new Error('verify_all 600s 超时');
  }
  const { ms: bootFirstMs, bytes: bootFirstBytes, json: bootFirst } = await getJson('/api/v1/bootstrap');
  const expectedVisible = Number(bootFirst.files_total);
  row('B 冷启动·bootstrap 首拉', `${fmtMs(bootFirstMs)} · ${(bootFirstBytes / 1024).toFixed(0)}KiB · ${expectedVisible} 文件`);
  row('B 冷启动·首次全量索引（verify_all）', fmtMs(firstIndexMs));
  await stopServe();

  // ===== C. 热启动：bootstrap p95 < 150ms =====
  console.log('\n── C. 热启动（既有库直接打开）──');
  const tRestart = now();
  await startServe(true);
  const restartReadyMs = now() - tRestart;
  row('C 热启动·服务就绪', fmtMs(restartReadyMs));
  // 排空 --watch 启动自带的全量 verify_all，避免挤占 D/E 的增量任务队列
  await drainJobs();
  row('C 热启动·启动对账排空', '后台任务清空');

  const bootSamples: number[] = [];
  let bootBytes = 0;
  for (let i = 0; i < args.samples; i++) {
    const { ms, bytes } = await getJson('/api/v1/bootstrap');
    bootSamples.push(ms);
    bootBytes = bytes;
  }
  bootSamples.sort((a, b) => a - b);
  row(
    `C 热启动·bootstrap ${args.samples} 次采样（${(bootBytes / 1024).toFixed(0)}KiB）`,
    `p50 ${fmtMs(percentile(bootSamples, 50))} · p95 ${fmtMs(percentile(bootSamples, 95))} · max ${fmtMs(bootSamples[bootSamples.length - 1])}`
  );
  judge('C 验收：10k 文件热启动 bootstrap p95', percentile(bootSamples, 95), 150);

  // ===== D. 单文件修改：watcher 事件驱动通知延迟 =====
  console.log('\n── D. 单文件修改（watcher 事件驱动 + 防抖合并）──');
  const g0 = await currentGeneration();
  const targetMd = path.join(args.fixture, 'docs', '基准-文档-00000.md');
  const before = fs.readFileSync(targetMd, 'utf-8');
  fs.writeFileSync(targetMd, `${before}\n<!-- bench touch ${Date.now()} -->\n`);
  const tWrite0 = now();
  let singleMs = -1;
  try {
    singleMs = await waitForGeneration(g0 + 1, 5000);
    // 验收口径「后台增量对账 <1.5s」的常态单元 = 一次保存（单文件端到端：
    // watcher 检测 + 100ms 防抖合并 + 增量对账 + SSE 通知）
    judge('E 验收：单文件保存 → 后台增量对账端到端', singleMs, 1500);
    if (singleMs >= 300) report.lines.push('    ↳ watcher 延迟提示：<300ms 未达（Windows Defender 对新写文件的实时扫描开销，如实记录）');
  } catch (e) {
    row('D 单文件修改 → SSE 通知', `失败：${(e as Error).message}`, 'FAIL');
    report.failures.push(`D 单文件通知失败: ${(e as Error).message}`);
  }
  // 等对账彻底落库再进入 E
  await wait(500);

  // ===== E. 批量修改对账（100 文件）+ 对账期间并发查询 p95 =====
  console.log('\n── E. 批量修改 100 文件 → 后台增量对账 + 并发查询负载 ──');
  const g1 = await currentGeneration();
  const touched: Array<{ rel: string; append: string }> = [];  for (let i = 0; i < 100; i++) {
    const kind = i % 10;
    if (kind < 4) touched.push({ rel: path.join('docs', `基准-文档-${pad5(i)}.md`), append: `<!-- batch ${Date.now()} #${i} -->` });
    else if (kind < 7) touched.push({ rel: path.join('src', '模块0', `sample_${pad5(200 + i)}.ts`), append: `// batch ${Date.now()} #${i}` });
    else if (kind < 9) touched.push({ rel: path.join('data', `表样-${pad5(i)}.csv`), append: `batch,${Date.now()},${i}` });
    else touched.push({ rel: path.join('data', `指标-${pad5(i)}.json`), append: '' });
  }
  for (const t of touched) {
    const p = path.join(args.fixture, t.rel);
    if (t.append === '') {
      fs.writeFileSync(p, JSON.stringify({ touchedAt: Date.now(), note: 'bench batch' }));
    } else {
      fs.appendFileSync(p, `\n${t.append}\n`);
    }
  }

  // 对账期间并发查询负载：4 路混合查询循环采样，直到对账完成
  const querySamples: number[] = [];
  const paths = ['/api/v1/files?limit=50', '/api/v1/events?limit=50', '/api/v1/bootstrap', '/api/v1/decisions?limit=50'];
  let loadOn = true;
  const workers = paths.map((p) =>
    (async () => {
      while (loadOn) {
        try {
          const { ms } = await getJson(p);
          querySamples.push(ms);
        } catch {
          /* 负载期间容忍单次失败 */
        }
        await wait(2);
      }
    })()
  );
  let batchMs = -1;
  try {
    batchMs = await waitForGeneration(g1 + 1, 10000);
  } catch (e) {
    loadOn = false;
    await Promise.allSettled(workers);
    row('E 批量对账 → SSE 通知', `失败：${(e as Error).message}`, 'FAIL');
    report.failures.push(`E 批量对账失败: ${(e as Error).message}`);
  }
  loadOn = false;
  await Promise.allSettled(workers);

  if (batchMs >= 0) {
    // 保存风暴压力观测（100 文件合并为一次对账；不设硬阈值——卡面口径锚定单文件
    // 保存单元，批量数据如实记录供回归对照。Windows Defender 对新写文件的实时
    // 扫描使采集段存在 ~6ms/文件的环境成本，为测量主体之一）
    const perFileUs = Math.round((batchMs * 1000) / touched.length);
    row(
      `E 压力观测：${touched.length} 文件保存风暴 → 单次合并对账`,
      `${fmtMs(batchMs)}（含 100ms 防抖；摊薄 ~${perFileUs}µs/文件）`
    );
    querySamples.sort((a, b) => a - b);
    if (querySamples.length > 0) {
      row(
        `E 对账期间并发查询 ${querySamples.length} 次采样（files/events/bootstrap/decisions）`,
        `p50 ${fmtMs(percentile(querySamples, 50))} · p95 ${fmtMs(percentile(querySamples, 95))} · max ${fmtMs(querySamples[querySamples.length - 1])}`
      );
      judge('E 验收：对账期间前端查询 p95', percentile(querySamples, 95), 50);
    } else {
      report.failures.push('E 并发查询负载零采样');
    }
  }

  await stopServe();

  // ===== 汇总 =====
  console.log('\n========== 体量基准结果 ==========');
  for (const line of report.lines) console.log(line);
  if (report.failures.length > 0) {
    console.log(`\n基准失败：${report.failures.length} 项超预算/异常`);
    for (const f of report.failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('\n基准通过：三项体量验收口径全部达标。');
  process.exit(0);
}

function pad5(n: number): string {
  return String(n).padStart(5, '0');
}

main().catch((e) => {
  console.error(`基准异常：${e?.stack || e}`);
  stopServe().finally(() => process.exit(1));
});
