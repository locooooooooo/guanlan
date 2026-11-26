
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guanlanDir = path.resolve(__dirname, '..');
const benchRoot = path.resolve(guanlanDir, 'native/testdata/bench/f04-1k');
const wsRoot = path.join(benchRoot, 'workspace');
const dataRoot = path.join(benchRoot, 'data');
const distDir = path.resolve(guanlanDir, 'dist');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const exePath = path.resolve(
  guanlanDir,
  argValue('--exe') || 'native/target/release/guanlan.exe'
);
const requestedPort = Number(argValue('--port') || '0');
const keepAlive = process.argv.includes('--keep-alive');
const skipSeed = process.argv.includes('--skip-seed');

function makeMinimalPdf2Pages(): Buffer {
  const objects: string[] = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n');
  objects.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n'
  );
  objects.push(
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n'
  );
  const s1 = 'BT /F1 14 Tf 50 760 Td (Guanlan Payment Gateway Compliance Standard - Page 1 Overview) Tj ET\n';
  const s2 =
    'BT /F1 14 Tf 50 760 Td (Clause 2.4 Idempotency Key TTL must be >= 24h with Redis Sentinel failover) Tj ET\n';
  objects.push(`5 0 obj\n<< /Length ${Buffer.byteLength(s1)} >>\nstream\n${s1}endstream\nendobj\n`);
  objects.push(`6 0 obj\n<< /Length ${Buffer.byteLength(s2)} >>\nstream\n${s2}endstream\nendobj\n`);
  objects.push('7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += obj;
  }
  const xrefPos = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

function makeTopologySvg(v2: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" width="640" height="320">
  <rect x="0" y="0" width="640" height="320" rx="16" fill="#F8F7FC"/>
  <text x="24" y="34" font-size="16" font-weight="700" fill="#182030">支付网关系统拓扑 (${v2 ? 'v2 含哨兵容灾' : 'v1 初版'})</text>
  <rect x="36" y="72" width="150" height="72" rx="12" fill="#FFFFFF" stroke="#6D5BD0" stroke-width="2"/>
  <text x="64" y="114" font-size="14" fill="#182030">API 接入网关</text>
  <rect x="244" y="72" width="160" height="72" rx="12" fill="#FFFFFF" stroke="#3E9B6B" stroke-width="2"/>
  <text x="272" y="114" font-size="14" fill="#182030">幂等账本核心</text>
  <line x1="186" y1="108" x2="244" y2="108" stroke="#6D5BD0" stroke-width="2"/>
  ${
    v2
      ? `<rect x="456" y="72" width="152" height="72" rx="12" fill="#FFF7ED" stroke="#D97757" stroke-width="2"/>
  <text x="478" y="106" font-size="13" fill="#9A3412">Redis Sentinel</text>
  <text x="488" y="126" font-size="11" fill="#9A3412">TTL=24h 容灾</text>
  <line x1="404" y1="108" x2="456" y2="108" stroke="#D97757" stroke-width="2"/>`
      : ''
  }
</svg>`;
}

function writeFileAt(rel: string, content: string | Buffer, mtimeIso: string): void {
  const full = path.join(wsRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  const d = new Date(mtimeIso);
  fs.utimesSync(full, d, d);
}

function runScan(env: NodeJS.ProcessEnv): number {
  const t0 = performance.now();
  execFileSync(
    exePath,
    [
      'scan',
      '--root',
      wsRoot,
      '--initiative-dir',
      '01-支付网关重构',
      '--initiative-dir',
      '02-风控引擎二期',
    ],
    { env, stdio: 'pipe' }
  );
  return performance.now() - t0;
}

async function waitForEndpoint(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      reject(new Error(`guanlan serve 启动超时\nstderr: ${stderrBuf}`));
    }, 20000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const match = stdoutBuf.match(/GUANLAN_ENDPOINT=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`guanlan serve 提前退出 code=${code}\n${stderrBuf}`));
    });
  });
}

async function fetchJson<T>(base: string, urlPath: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${urlPath}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${urlPath}: ${body}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  if (!fs.existsSync(exePath)) {
    throw new Error(`未找到 release 二进制：${exePath}`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GUANLAN_DATA_DIR: dataRoot,
    GUANLAN_DIST_DIR: distDir,
  };

  let day1ScanMs = 0;
  let day2ScanMs = 0;

  if (!skipSeed) {
    fs.rmSync(benchRoot, { recursive: true, force: true });
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });

    console.log('[golden-tasks] 1/4 生成 1,050 份十族混合格式工程夹具...');
    execFileSync(
      process.execPath,
      [
        path.resolve(guanlanDir, 'node_modules/tsx/dist/cli.mjs'),
        path.resolve(guanlanDir, 'scripts/seed-bench-volume.ts'),
        wsRoot,
        '--total',
        '1050',
        '--clean',
      ],
      { stdio: 'pipe' }
    );

    const day1Iso = '2026-11-20T10:00:00.000Z';
    writeFileAt(
      '01-支付网关重构/01-架构设计方案.md',
      `# 支付网关重构 · 架构设计方案（v1）

日期：2026-11-20

## 一、总体架构
详见拓扑图 [系统拓扑图](02-系统拓扑图.svg) 与合规条款 [合规安全规范第 2 页](03-合规安全规范.pdf#page=2)。

## 二、幂等防重设计
- [P1 - 待确认] 幂等键持久化方案（待评审确认 Redis Sentinel 24h TTL 还是本地落盘）
  - 决定：___ · 确认人：___

## 三、灾备切换
主备切换 RTO 目标 < 15s。
`,
      day1Iso
    );
    writeFileAt('01-支付网关重构/02-系统拓扑图.svg', makeTopologySvg(false), day1Iso);
    writeFileAt('01-支付网关重构/03-合规安全规范.pdf', makeMinimalPdf2Pages(), day1Iso);

    writeFileAt(
      '02-风控引擎二期/01-定稿规范与决策依据.md',
      `# 风控引擎二期 · 定稿规范与决策依据

日期：2026-11-20

## 一、核心结论（当前生效定稿）
本专项采用**流式滑动窗口规则引擎 v2**，取代离线批处理 ETL，实测 P99 延迟从 420ms 降至 18ms，数据基准见 [风控指标台账](02-风控指标台账.csv)。

## 二、已拍板决策与采用依据
- [P1 - 已确认] 规则计算引擎选型（决定：采用流式滑动窗口引擎 v2，放弃离线批处理；采用依据：实测压测 P99=18ms 远优于 SLA 50ms 且零漏报 · 确认人：架构评审组 · 生效日期：2026-11-20）
- [P0 - 已确认] 灰度发布回滚闸门（决定：错杀率超 0.05% 自动切回旧链路 · 确认人：风控负责人 · 生效日期：2026-11-20）

## 三、执行检查清单
- [x] 完成压测台账核验
- [x] 完成拓扑链路评审 [风控链路图](03-风控链路图.svg)
`,
      day1Iso
    );
    writeFileAt(
      '02-风控引擎二期/02-风控指标台账.csv',
      '引擎方案,P50_ms,P99_ms,误杀率,吞吐QPS\n离线批处理ETL,180,420,0.08%,1200\n流式滑动窗口v2,6,18,0.01%,18500\n',
      day1Iso
    );
    writeFileAt('02-风控引擎二期/03-风控链路图.svg', makeTopologySvg(true), day1Iso);

    console.log('[golden-tasks] 2/4 执行 Day 1 基线入库扫描（1,056 份混合文件）...');
    day1ScanMs = runScan(env);

    const day2Iso = '2026-11-21T16:30:00.000Z';
    writeFileAt(
      '01-支付网关重构/01-架构设计方案.md',
      `# 支付网关重构 · 架构设计方案（v2 定稿）

日期：2026-11-21

## 一、总体架构
详见新版拓扑图 [系统拓扑图](02-系统拓扑图.svg) 与合规条款 [合规安全规范第 2 页](03-合规安全规范.pdf#page=2)。

## 二、幂等防重设计
已完成压测验证，幂等键统一走双活 Redis Sentinel，TTL 严格 >= 24 小时，符合合规条款 2.4。
- [P1 - 已确认] 幂等键持久化方案（决定：采用 Redis Sentinel 24h TTL + 异步落库双保险；确认人：支付架构组；生效日期：2026-11-21）

## 三、熔断与灾备切换
- [P0 - 待确认] 第三方渠道超时熔断阈值（建议 3 秒连续 5 次触发半开）
  - 决定：___ · 确认人：___

主备切换 RTO 目标 < 10s，演练记录见 [隔夜联调纪要](04-隔夜联调纪要.md)。
`,
      day2Iso
    );
    writeFileAt('01-支付网关重构/02-系统拓扑图.svg', makeTopologySvg(true), day2Iso);
    writeFileAt(
      '01-支付网关重构/04-隔夜联调纪要.md',
      `# 隔夜联调纪要（2026-11-21）

日期：2026-11-21

## 核心变化摘要
1. 支付网关完成 Redis Sentinel 24h 幂等键切换演练，主备切换耗时 4.2s；
2. 更新 [架构设计方案](01-架构设计方案.md) 至 v2，确认幂等键方案并新提熔断阈值待拍板项。
`,
      day2Iso
    );

    console.log('[golden-tasks] 3/4 执行 Day 2 隔夜增量变更入库扫描...');
    day2ScanMs = runScan(env);
  }

  console.log('[golden-tasks] 4/4 启动 release guanlan.exe 服务并执行五大黄金任务实机计时...');
  const serveArgs = ['serve', '--root', wsRoot];
  if (requestedPort > 0) {
    serveArgs.push('--port', String(requestedPort));
  }
  const server = spawn(exePath, serveArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = await waitForEndpoint(server);
  console.log(`[golden-tasks] 实时服务已就绪：${endpoint}`);

  try {
    const rebuildJob = await fetchJson<{ job_id: string }>(endpoint, '/api/v1/search/rebuild', {
      method: 'POST',
    });
    for (let i = 0; i < 120; i += 1) {
      const st = await fetchJson<{ state: string }>(endpoint, `/api/v1/jobs/${rebuildJob.job_id}`);
      if (st.state === 'completed' || st.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const bootstrap = await fetchJson<{
      files_total: number;
      events_total: number;
      decisions_total: number;
    }>(endpoint, '/api/v1/bootstrap');

    const searchGateway = await fetchJson<{
      items: Array<{ file_id: string; relative_path: string }>;
    }>(endpoint, `/api/v1/search?q=${encodeURIComponent('架构设计方案')}&limit=10`);
    const gatewayFile = searchGateway.items.find((f) =>
      f.relative_path.includes('01-支付网关重构/01-架构设计方案.md')
    );
    if (!gatewayFile) throw new Error('未找到 01-支付网关重构/01-架构设计方案.md');

    let staleVersionUsed = 0;

    const t1Start = performance.now();
    const bootT1 = await fetchJson<{ ok: boolean }>(endpoint, '/api/v1/bootstrap');
    const revChainT1 = await fetchJson<{
      revisions: Array<{ revision_id: string; seq: number }>;
    }>(endpoint, `/api/v1/files/${encodeURIComponent(gatewayFile.file_id)}/revisions?include_sections=1`);
    const latestRevT1 = revChainT1.revisions[0];
    const contentT1 = await fetchJson<{ text: string }>(
      endpoint,
      `/api/v1/revisions/${encodeURIComponent(latestRevT1.revision_id)}/content`
    );
    const t1Ms = performance.now() - t1Start;
    if (!bootT1.ok || latestRevT1.seq !== 2 || !contentT1.text.includes('幂等防重设计')) {
      staleVersionUsed += 1;
    }

    const t2Start = performance.now();
    const daysT2 = await fetchJson<{
      groups: Array<{ day: string; event_count: number; samples: Array<{ headline: string }> }>;
    }>(endpoint, '/api/v1/events/days?order=occurred&limit=30&samples=6');
    const eventsT2 = await fetchJson<{
      items: Array<{ kind: string; headline: string; occurred_at: string | null }>;
    }>(endpoint, '/api/v1/events?order=occurred&from=2026-11-21&limit=50');
    const t2Ms = performance.now() - t2Start;
    const foundSubstantive = eventsT2.items.some(
      (e) => e.headline.includes('架构设计方案') || e.headline.includes('隔夜联调纪要')
    );
    if (!foundSubstantive || daysT2.groups.length === 0) {
      throw new Error('任务 2 未检出离开后的实质变更');
    }

    const t3Start = performance.now();
    const overviewT3 = await fetchJson<{
      initiatives: Array<{ initiative_id: string; name: string; root_dir: string; state: string }>;
    }>(endpoint, '/api/v1/state-overview');
    const searchRisk = await fetchJson<{
      items: Array<{ file_id: string; relative_path: string }>;
    }>(endpoint, `/api/v1/search?q=${encodeURIComponent('风控引擎二期')}&limit=10`);
    const riskDoc = searchRisk.items.find((f) =>
      f.relative_path.includes('02-风控引擎二期/01-定稿规范与决策依据.md')
    );
    if (!riskDoc) throw new Error('任务 3 未搜到陌生事项定稿');
    const riskRevs = await fetchJson<{
      revisions: Array<{ revision_id: string; seq: number }>;
    }>(endpoint, `/api/v1/files/${encodeURIComponent(riskDoc.file_id)}/revisions`);
    const riskDecisions = await fetchJson<{
      items: Array<{
        status: string;
        question: string;
        confirmationBasis?: { recordText: string; confirmer: string };
        evidences: Array<{ exactQuote: string; relative_path: string; lineStart: number }>;
      }>;
    }>(endpoint, `/api/v1/decisions?status=${encodeURIComponent('已确认')}&limit=50`);
    const t3Ms = performance.now() - t3Start;
    const riskConfirmed = riskDecisions.items.find((d) => d.question.includes('规则计算引擎选型'));
    const riskQuote =
      riskConfirmed?.evidences?.[0]?.exactQuote ||
      riskConfirmed?.confirmationBasis?.recordText ||
      '';
    if (!riskConfirmed || !riskQuote.includes('P99=18ms')) {
      throw new Error(`任务 3 未定位到采用依据：${JSON.stringify(riskConfirmed)}`);
    }
    if (riskRevs.revisions[0].seq < 1 || overviewT3.initiatives.length < 2) {
      staleVersionUsed += 1;
    }

    const t4Start = performance.now();
    const decListT4 = await fetchJson<{
      items: Array<{
        question: string;
        evidences: Array<{
          file_id: string;
          revision_id: string;
          relative_path: string;
          lineStart: number;
        }>;
      }>;
    }>(endpoint, `/api/v1/decisions?status=${encodeURIComponent('已确认')}&limit=50`);
    const targetDec = decListT4.items.find((d) => d.question.includes('幂等键持久化方案'));
    if (!targetDec || targetDec.evidences.length === 0) {
      throw new Error('任务 4 未找到幂等键持久化方案决定');
    }
    const ev = targetDec.evidences[0];
    const evContent = await fetchJson<{ text: string }>(
      endpoint,
      `/api/v1/revisions/${encodeURIComponent(ev.revision_id)}/content`
    );
    const lines = evContent.text.split(/\r?\n/);
    const exactLine = lines[Math.max(0, ev.lineStart - 1)] || '';
    const searchPdf = await fetchJson<{
      items: Array<{ file_id: string; relative_path: string }>;
    }>(endpoint, `/api/v1/search?q=${encodeURIComponent('合规安全规范')}&limit=5`);
    const pdfFile = searchPdf.items.find((f) => f.relative_path.endsWith('.pdf'));
    let pdfPage2Verified = false;
    if (pdfFile) {
      const pdfRevs = await fetchJson<{ revisions: Array<{ revision_id: string }> }>(
        endpoint,
        `/api/v1/files/${encodeURIComponent(pdfFile.file_id)}/revisions`
      );
      const pdfData = await fetchJson<{
        pages: Array<{ page_number: number; extracted_text: string }>;
      }>(endpoint, `/api/v1/revisions/${encodeURIComponent(pdfRevs.revisions[0].revision_id)}/pdf`);
      pdfPage2Verified = pdfData.pages.some(
        (p) => p.page_number === 2 && p.extracted_text.includes('Idempotency Key TTL')
      );
    }
    const t4Ms = performance.now() - t4Start;
    if (!exactLine.includes('幂等键持久化方案') || !pdfPage2Verified) {
      staleVersionUsed += 1;
    }

    const t5Start = performance.now();
    const gwInit = overviewT3.initiatives.find((i) => i.root_dir.includes('01-支付网关重构'));
    const ctxResp = await fetchJson<{
      ok: boolean;
      preset: {
        items: Array<{ path: string; revision_id: string | null; content_hash?: string | null }>;
      };
      token_budget: { total_tokens: number };
      markdown: string | null;
    }>(endpoint, '/api/v1/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'initiative',
        focus_file_id: gatewayFile.file_id,
        initiative_id: gwInit?.initiative_id ?? undefined,
        mode: 'both',
      }),
    });
    const t5Ms = performance.now() - t5Start;
    const bundledGw = ctxResp.preset.items.find((f) =>
      f.path.includes('01-支付网关重构/01-架构设计方案.md')
    );
    if (!ctxResp.ok || !bundledGw || bundledGw.revision_id !== latestRevT1.revision_id) {
      staleVersionUsed += 1;
    }

    const report = {
      workspace_files_total: bootstrap.files_total,
      events_total: bootstrap.events_total,
      decisions_total: bootstrap.decisions_total,
      day1_cold_scan_ms: Math.round(day1ScanMs),
      day2_incremental_scan_ms: Math.round(day2ScanMs),
      stale_version_used: staleVersionUsed,
      tasks: [
        {
          id: 'T1',
          name: '隔天回来恢复上次阅读版本与段落',
          target: '< 10,000 ms',
          measured_ms: Number(t1Ms.toFixed(1)),
          steps: 1,
          pass: t1Ms < 10_000 && staleVersionUsed === 0,
        },
        {
          id: 'T2',
          name: '找出离开后发生的全部实质变更',
          target: '< 30,000 ms',
          measured_ms: Number(t2Ms.toFixed(1)),
          steps: 1,
          matched_overnight_events: eventsT2.items.length,
          pass: t2Ms < 30_000,
        },
        {
          id: 'T3',
          name: '在陌生事项确认当前生效定稿及采用依据',
          target: '< 60,000 ms',
          measured_ms: Number(t3Ms.toFixed(1)),
          steps: 2,
          pass: t3Ms < 60_000,
        },
        {
          id: 'T4',
          name: '从任一历史决定追到当时版本的原文/原图/原表页',
          target: '≤ 3 步',
          measured_ms: Number(t4Ms.toFixed(1)),
          steps: 3,
          pdf_page2_verified: pdfPage2Verified,
          exact_line: ev.lineStart,
          pass: pdfPage2Verified && staleVersionUsed === 0,
        },
        {
          id: 'T5',
          name: '组装准确上下文包交给智能体继续推进',
          target: '< 30,000 ms',
          measured_ms: Number(t5Ms.toFixed(1)),
          steps: 2,
          est_tokens: ctxResp.token_budget.total_tokens,
          files_included: ctxResp.preset.items.length,
          pass: t5Ms < 30_000 && staleVersionUsed === 0,
        },
      ],
    };

    console.log('\n========== 千级混合文件五大黄金任务引擎实测 ==========');
    console.log(JSON.stringify(report, null, 2));

    if (staleVersionUsed !== 0 || report.tasks.some((t) => !t.pass)) {
      throw new Error('存在未达标项或误用过期版本！');
    }

    if (keepAlive) {
      console.log(`\n[golden-tasks] --keep-alive 常驻中，请在浏览器打开：${endpoint}`);
      await new Promise(() => {});
    }
  } finally {
    if (!keepAlive) {
      server.kill();
    }
  }
}

main().catch((err) => {
  console.error('[golden-tasks] 失败：', err);
  process.exit(1);
});
