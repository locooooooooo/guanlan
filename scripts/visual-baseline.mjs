
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUANLAN_ROOT = path.resolve(HERE, '..');
const EXE = path.join(GUANLAN_ROOT, 'native/target/release/guanlan.exe');
const DIST_DIR = path.join(GUANLAN_ROOT, 'dist');
const BASELINE_DIR = path.join(HERE, 'visual-baseline');
const FAIL_DIR = path.join(HERE, '.visual-fail');

const VISUAL_DECLARED_SHIFTS = {};

const DIFF_RATIO_GATE = 0.001;

const SHOT_NOISE_FLOOR = {
  'graph-folded-groups': 0.002,
  'time-machine-night': 0.002,
  'time-machine-paper': 0.002,
  'home-trend-jump': 0.002,
};
const NOISE_MAX_DELTA = 170;

const FIXED_CLOCK_ISO = '2026-11-21T09:00:00';
const FIXED_CLOCK_DATE = FIXED_CLOCK_ISO.slice(0, 10);
const REWRITTEN_TIME_KEYS = [
  'observed_at',
  'first_observed_at',
  'last_observed_at',
  'last_synced_at',
  'generated_at',
  'updated_at',
  'occurred_at',
];
const FIXED_OCCURRED_ISO = '2026-11-10T10:00:00';
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const FIXTURE_MTIME_BASE = Date.parse('2026-11-10T10:00:00');
const GEN_MTIME_BASE = Date.parse('2026-11-21T10:00:00');

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Chrome/Edge 可执行文件');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时 (${label}): ${lastErr ? lastErr.message : 'returned falsy'}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventBindings = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.method && this.eventBindings.length > 0) {
        for (const { method, fn } of this.eventBindings) {
          if (msg.method === method) {
            try {
              fn(msg.params);
            } catch {
            }
          }
        }
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  onEvent(method, fn) {
    this.eventBindings.push({ method, fn });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`CDP eval exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}


class ConsoleGate {
  constructor() {
    this.entries = [];
    this.seen = new Set();
  }

  attach(cdp) {
    cdp.onEvent('Runtime.consoleAPICalled', (p) => {
      const type = p.type;
      if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ');
      this.push(`console.${type}`, 'javascript', text);
    });
    cdp.onEvent('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const text = d.exception?.description || d.text || 'uncaught exception';
      this.push('exception', d.url || 'javascript', text);
    });
    cdp.onEvent('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level !== 'error' && e.level !== 'warning') return;
      this.push(`log.${e.level}`, e.source || 'browser', e.text || '');
    });
  }

  push(kind, source, text) {
    const trimmed = String(text || '').slice(0, 300);
    const key = `${kind}|${source}|${trimmed}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.entries.push({ kind, source, text: trimmed });
  }

  get errorCount() {
    return this.entries.filter((e) => e.kind !== 'console.warning' && e.kind !== 'log.warning').length;
  }

  get warningCount() {
    return this.entries.filter((e) => e.kind === 'console.warning' || e.kind === 'log.warning').length;
  }

  get clean() {
    return this.entries.length === 0;
  }

  report() {
    if (this.clean) return ['Console: 0 error / 0 warning ✓'];
    const errors = this.entries.filter((e) => e.kind !== 'console.warning' && e.kind !== 'log.warning');
    const warns = this.entries.filter((e) => e.kind === 'console.warning' || e.kind === 'log.warning');
    const lines = [`Console: ${errors.length} error / ${warns.length} warning ✗（去重后）`];
    for (const e of this.entries.slice(0, 12)) {
      lines.push(`  [${e.kind}] ${e.source}: ${e.text.split('\n')[0]}`);
    }
    return lines;
  }
}


const FIXTURE_FILES = [
  {
    rel: '04-星图引擎/00-需求蓝图.md',
    body: [
      '---',
      'revision: 2',
      '---',
      '# 需求蓝图',
      '',
      '愿景：把星图引擎做成观澜的画布内核。',
      '联动方案见 [BOM与图纸联动方案](01-方案设计.md)。',
      '',
      '[P1 - 待确认] 引擎渲染分层口径',
      '决定：___',
      '确认人：___',
      '',
      '核心结论：分层口径待拍板后进入方案细化。',
    ].join('\n'),
  },
  {
    rel: '04-星图引擎/01-方案设计.md',
    body: [
      '---',
      'revision: 1',
      '---',
      '# BOM与图纸联动方案',
      '',
      '本方案基于 [字段映射表](../08-数据格式规范/字段映射表.md) 同步物料属性。',
      '',
      '核心结论：采用四层拆解——几何引擎 / Scene / Overlay / Chrome。',
    ].join('\n'),
  },
  {
    rel: '04-星图引擎/05-交付验收清单.md',
    body: [
      '---',
      'revision: 1',
      '---',
      '# 交付验收清单',
      '',
      '- [x] 像素基线固化',
      '- [ ] 帧率护栏实测',
    ].join('\n'),
  },
  {
    rel: '08-数据格式规范/字段映射表.md',
    body: [
      '---',
      'revision: 3',
      '---',
      '# 字段映射表',
      '',
      '定义 BOM 字段与图纸属性的统一口径。',
      '',
      '核心结论：字段口径已冻结第三版。',
    ].join('\n'),
  },
  {
    rel: '08-数据格式规范/坐标规范.md',
    body: [
      '---',
      'revision: 1',
      '---',
      '# 坐标规范',
      '',
      '世界坐标以主干为 X 轴原点，日期卡走左轨。',
      '',
      '核心结论：坐标口径与几何引擎单测同源。',
    ].join('\n'),
  },
  {
    rel: '12-验收与回执/回执模板.md',
    body: [
      '---',
      'revision: 1',
      '---',
      '# 回执模板',
      '',
      '每轮回执含目标结果 / 改动文件 / 验证命令三段。',
      '',
      '核心结论：模板沿用 §4.3 统一格式。',
    ].join('\n'),
  },
  {
    rel: '设计图纸/星图分层架构.svg',
    body: [
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240">',
      '  <rect width="480" height="240" fill="#14130f"/>',
      '  <rect x="24" y="24" width="200" height="80" rx="10" fill="#1f2b22" stroke="#3e6b52"/>',
      '  <text x="40" y="60" fill="#d8e6d0" font-size="16" font-family="sans-serif">geometry</text>',
      '  <rect x="256" y="24" width="200" height="80" rx="10" fill="#241f30" stroke="#6b5a9e"/>',
      '  <text x="272" y="60" fill="#e4def2" font-size="16" font-family="sans-serif">scene layer</text>',
      '  <rect x="24" y="136" width="200" height="80" rx="10" fill="#2b2416" stroke="#9e7d3a"/>',
      '  <text x="40" y="172" fill="#f0e6cf" font-size="16" font-family="sans-serif">overlay</text>',
      '  <rect x="256" y="136" width="200" height="80" rx="10" fill="#1c2530" stroke="#3a6b8c"/>',
      '  <text x="272" y="172" fill="#d5e6f2" font-size="16" font-family="sans-serif">chrome</text>',
      '</svg>',
    ].join('\n'),
  },
];

const GEN_DIRS = [
  { dir: '01-产品需求', title: '产品需求' },
  { dir: '02-技术设计', title: '技术设计' },
  { dir: '03-会议纪要', title: '会议纪要' },
  { dir: '05-周报月报', title: '周报月报' },
  { dir: '06-数据报告', title: '数据报告' },
  { dir: '07-用户研究', title: '用户研究' },
  { dir: '09-运维手册', title: '运维手册' },
  { dir: '10-合同法务', title: '合同法务' },
  { dir: '11-培训教材', title: '培训教材' },
  { dir: '13-市场分析', title: '市场分析' },
  { dir: '14-财务预算', title: '财务预算' },
  { dir: '15-知识库', title: '知识库' },
];
const GEN_BIZ_PER_DIR = 175;
const GEN_BIZ_TOTAL = GEN_DIRS.length * GEN_BIZ_PER_DIR;
const GEN_PENDING_DECISIONS = 287;

const GEN_CODE_ROOT = '04-智能体代码';
const GEN_CODE_SUBDIRS = 17;
const GEN_CODE_PER_SUBDIR = 200;
const GEN_CODE_TOTAL = GEN_CODE_SUBDIRS * GEN_CODE_PER_SUBDIR;
const CODE_EXTS = ['ts', 'rs', 'py', 'json'];
const EXPECTED_TOTAL_FILES = FIXTURE_FILES.length + GEN_BIZ_TOTAL + GEN_CODE_TOTAL;
const EXPECTED_BIZ_FILES = FIXTURE_FILES.length + GEN_BIZ_TOTAL;
const EXPECTED_PENDING_DECISIONS = 1 + GEN_PENDING_DECISIONS;

function genBizDayOffset(b) {
  if (b < 900) return b % 15;
  if (b < 1060) return 26 + ((b - 900) % 4);
  return 30 + ((b - 1060) % 56);
}

function genCodeDayOffset(c) {
  if (c < 1350) return c % 15;
  if (c < 1590) return 26 + ((c - 1350) % 4);
  return 30 + ((c - 1590) % 56);
}

function genFileBody(dirIdx, fileIdx, globalIdx) {
  const title = GEN_DIRS[dirIdx].title;
  const no = String(fileIdx).padStart(3, '0');
  const lines = [
    '---',
    'revision: 1',
    '---',
    `# ${title}记录 ${no}`,
    '',
    `本篇是「${title}」目录下的第 ${no} 份工程记录（全局编号 #${globalIdx}），用于 5,500+ 高密工作区压测夹具。`,
    '',
  ];
  if (globalIdx < GEN_PENDING_DECISIONS) {
    const decNo = String(globalIdx + 1).padStart(3, '0');
    lines.push(
      `[P1 - 待确认] 架构收敛议题 ${decNo}：${title}策略边界`,
      '决定：___',
      '确认人：___',
      ''
    );
  }
  lines.push(
    `## 要点 ${(fileIdx % 4) + 1}`,
    '',
    '- 排版与层次以像素基线为准，零截断、零重叠；',
    '- 时间语义遵守「业务发生 / 系统采集」双口径。'
  );
  return lines.join('\n');
}

function genCodeBody(subIdx, fileIdx, ext) {
  const id = `m${String(subIdx).padStart(2, '0')}_${String(fileIdx).padStart(3, '0')}`;
  if (ext === 'json') {
    return `{"module":"${id}","domain":"agent-code","seq":${subIdx * 1000 + fileIdx}}\n`;
  }
  if (ext === 'py') {
    return `def handle_${id}(payload: dict) -> int:\n    return ${subIdx * 1000 + fileIdx}\n`;
  }
  if (ext === 'rs') {
    return `pub const MOD_${id.toUpperCase()}: usize = ${subIdx * 1000 + fileIdx};\n`;
  }
  return `export const mod_${id} = { id: '${id}', seq: ${subIdx * 1000 + fileIdx} } as const;\n`;
}

function buildBulkFixture(wsDir) {
  fs.mkdirSync(wsDir, { recursive: true });
  let b = 0;
  for (let d = 0; d < GEN_DIRS.length; d += 1) {
    const dirAbs = path.join(wsDir, GEN_DIRS[d].dir);
    fs.mkdirSync(dirAbs, { recursive: true });
    for (let k = 0; k < GEN_BIZ_PER_DIR; k += 1) {
      const abs = path.join(dirAbs, `记录-${String(k).padStart(3, '0')}.md`);
      fs.writeFileSync(abs, genFileBody(d, k, b), 'utf8');
      const dayOffset = genBizDayOffset(b);
      const minuteShift = (b % 45) * 60_000;
      const mtime = new Date(GEN_MTIME_BASE - dayOffset * 86_400_000 + minuteShift);
      fs.utimesSync(abs, mtime, mtime);
      b += 1;
    }
  }
  let c = 0;
  for (let s = 0; s < GEN_CODE_SUBDIRS; s += 1) {
    const subAbs = path.join(wsDir, GEN_CODE_ROOT, `mod-${String(s).padStart(2, '0')}`);
    fs.mkdirSync(subAbs, { recursive: true });
    for (let k = 0; k < GEN_CODE_PER_SUBDIR; k += 1) {
      const ext = CODE_EXTS[(s + k) % CODE_EXTS.length];
      const abs = path.join(subAbs, `unit-${String(k).padStart(3, '0')}.${ext}`);
      fs.writeFileSync(abs, genCodeBody(s, k, ext), 'utf8');
      const dayOffset = genCodeDayOffset(c);
      const minuteShift = (c % 45) * 60_000;
      const mtime = new Date(GEN_MTIME_BASE - dayOffset * 86_400_000 + minuteShift);
      fs.utimesSync(abs, mtime, mtime);
      c += 1;
    }
  }
}

function writeCoreFixtureFiles(wsDir) {
  let i = 0;
  for (const f of FIXTURE_FILES) {
    const abs = path.join(wsDir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.body, 'utf8');
    const mtime = new Date(FIXTURE_MTIME_BASE + i * 60_000);
    fs.utimesSync(abs, mtime, mtime);
    i += 1;
  }
}


function runScan(wsDir, env) {
  return new Promise((resolve, reject) => {
    const scan = spawn(EXE, ['scan', '--root', wsDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    scan.stdout.on('data', (d) => { out += d; });
    scan.stderr.on('data', (d) => { err += d; });
    scan.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`scan failed (${code}): ${err}\n${out}`));
    });
  });
}

async function startServe(wsDir, env) {
  const serveProc = spawn(EXE, ['serve', '--root', wsDir, '--watch'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endpoint = await new Promise((resolve, reject) => {
    let stderrBuf = '';
    const rl = readline.createInterface({ input: serveProc.stdout });
    rl.on('line', (line) => {
      if (line.startsWith('GUANLAN_ENDPOINT=')) {
        resolve(line.slice('GUANLAN_ENDPOINT='.length).trim());
      }
    });
    serveProc.stderr.on('data', (d) => { stderrBuf += d; });
    serveProc.on('exit', (code) => {
      reject(new Error(`serve exited early (${code}): ${stderrBuf}`));
    });
  });
  return { serveProc, endpoint };
}

async function startBrowser(endpoint, chromeProfile) {
  const browserBin = findBrowser();
  const debugPort = 39300 + Math.floor(Math.random() * 400);
  const browserProc = spawn(
    browserBin,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${chromeProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--disable-font-subpixel-positioning',
      endpoint,
    ],
    { stdio: 'ignore' }
  );
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    return list.find((t) => t.type === 'page' && t.url.startsWith(endpoint));
  }, { label: 'browser target' });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  return { browserProc, cdp };
}


async function settleFrames(cdp, extraMs) {
  await cdp.eval(`
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return true;
  `);
  if (extraMs) await sleep(extraMs);
  await cdp.eval(`
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return true;
  `);
}

async function captureShot(cdp) {
  await cdp.eval(`
    if (document.getAnimations) {
      document.getAnimations().forEach((a) => {
        try {
          const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          const end = timing ? timing.endTime : null;
          if (typeof end === 'number' && Number.isFinite(end)) {
            a.currentTime = end;
          } else {
            a.currentTime = 0;
          }
          a.pause();
        } catch (e) {}
      });
    }
    return true;
  `);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: 1432, y: 6,
  });
  await settleFrames(cdp, 120);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
  return Buffer.from(shot.data, 'base64');
}

async function wheelZoom(cdp, x, y, steps, deltaY = -240) {
  for (let i = 0; i < steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
    });
    await sleep(60);
  }
  await settleFrames(cdp, 250);
}

async function clickPrimaryTab(cdp, label) {
  const ok = await cdp.eval(`
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const tab = tabs.find((t) => t.innerText.trim().includes('${label}'));
    if (!tab) return false;
    tab.click();
    return true;
  `);
  assert.ok(ok, `未找到主页签「${label}」`);
}

async function clickButtonIn(cdp, groupSel, label) {
  const ok = await cdp.eval(`
    const root = document.querySelector(${JSON.stringify(groupSel)});
    if (!root) return false;
    const btn = Array.from(root.querySelectorAll('button')).find((b) => b.innerText.trim() === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  `);
  assert.ok(ok, `在 ${groupSel} 中未找到按钮「${label}」`);
}

async function clickButtonByTitle(cdp, titlePrefix) {
  const ok = await cdp.eval(`
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.getAttribute('title') || '').startsWith(${JSON.stringify(titlePrefix)}));
    if (!btn) return false;
    btn.click();
    return true;
  `);
  assert.ok(ok, `未找到 title 前缀为「${titlePrefix}」的按钮`);
}

async function clickButtonByAria(cdp, ariaLabel) {
  const ok = await cdp.eval(`
    const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
    if (!btn) return false;
    btn.click();
    return true;
  `);
  assert.ok(ok, `未找到 aria-label 为「${ariaLabel}」的按钮`);
}

async function pressRawKey(cdp, { key, code, vk, modifiers = 0 }) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
  });
  await settleFrames(cdp, 200);
}

async function pressEscape(cdp) {
  await pressRawKey(cdp, { key: 'Escape', code: 'Escape', vk: 27 });
}

async function anyEscLayerOpen(cdp) {
  return cdp.eval(`return Boolean(document.querySelector('[data-esc-layer="open"]'));`);
}


const SHOT_SCENES = [
  { scene: '① 首页（5,507 份 + 288 SSOT + 柱图直跳）', shots: ['home-today', 'home-trend-jump'] },
  {
    scene: '② 星图（纸面/夜航）',
    shots: ['graph-panorama', 'graph-folded-groups', 'graph-node-cards', 'graph-paper'],
  },
  {
    scene: '③ 日历（15天连续百文日零碰撞/紧凑活跃/左避让弹层）',
    shots: ['calendar-window', 'calendar-compact', 'calendar-popover'],
  },
  { scene: '④ 列表时光流（TimelineView）', shots: ['timeline-stream'] },
  {
    scene: '⑤ 阅读器（常规/Zen/深浅纸面/迷你版本轴/时光轨迹检查器）',
    shots: [
      'reader-decision',
      'reader-scrolled',
      'reader-dark-paper',
      'reader-zen',
      'reader-version-axis',
      'reader-inspector',
    ],
  },
  { scene: '⑥ 资产库概览（AtlasView）', shots: ['atlas-overview'] },
  { scene: '⑦ 版本时光机（纸面/夜航）', shots: ['time-machine-night', 'time-machine-paper'] },
  { scene: '⑧ Ctrl+K 双栏命令面板（L4A 富预览）', shots: ['palette'] },
  { scene: '⑨ 批阅看板与轻预览', shots: ['review-board', 'quick-preview'] },
  { scene: '⑩ 司辰手记抽屉（Sheet inset）', shots: ['chronos-digest'] },
  { scene: '⑪ 设置弹窗与关于观澜（v1.2.3）', shots: ['settings-about'] },
  {
    scene: '⑫ 全站暗夜沉浸双态（.dark）',
    shots: ['dark-home', 'dark-calendar', 'dark-settings'],
  },
];
const SHOT_PLAN = SHOT_SCENES.flatMap((s) => s.shots);

async function captureAllShots(endpoint, gate) {
  const { browserProc, cdp } = await startBrowser(endpoint, TMP.chromeProfile);
  const shots = new Map();
  gate.attach(cdp);
  try {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (function () {
          const FIXED = Date.parse('${FIXED_CLOCK_ISO}');
          const FIXED_DAY = '${FIXED_CLOCK_DATE}';
          const FIXED_FALLBACK = '${FIXED_CLOCK_ISO}';
          const KEYS = ${JSON.stringify(REWRITTEN_TIME_KEYS)};
          const ISO = ${ISO_LIKE_RE.toString()};
          const RealDate = Date;
          function ShimDate(...args) {
            if (args.length === 0) return new RealDate(FIXED);
            return new (Function.prototype.bind.apply(RealDate, [null, ...args]))();
          }
          ShimDate.prototype = RealDate.prototype;
          Object.setPrototypeOf(ShimDate, RealDate);
          ShimDate.now = () => FIXED;
          ShimDate.parse = RealDate.parse.bind(RealDate);
          ShimDate.UTC = RealDate.UTC.bind(RealDate);
          window.Date = ShimDate;

          const rewrite = (value) => {
            if (Array.isArray(value)) {
              for (const v of value) rewrite(v);
              return value;
            }
            if (value && typeof value === 'object') {
              for (const k of Object.keys(value)) {
                const v = value[k];
                if (typeof v === 'string' && KEYS.includes(k) && ISO.test(v)) {
                  value[k] =
                    k === 'occurred_at'
                      ? // 夹具 mtime/文档自述派生的发生时间（≤ 固定时钟日）如实放行；
                        // 扫描墙钟派生的系统事件（> 固定时钟日）归一到固定时钟。
                        v.slice(0, 10) <= FIXED_DAY
                        ? v
                        : FIXED_FALLBACK
                      : FIXED_FALLBACK;
                } else {
                  rewrite(v);
                }
              }
            }
            return value;
          };
          window.__visualInflight = 0;
          window.__visualFilesDone = false;
          window.__visualRelationsDone = false;
          const origFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            window.__visualInflight += 1;
            try {
              const res = await origFetch(...args);
              const type = res.headers.get('content-type') || '';
              if (!type.includes('json')) return res;
              const text = await res.text();
              let data;
              try { data = JSON.parse(text); } catch {
                return new Response(text, {
                  status: res.status,
                  headers: { 'content-type': type },
                });
              }
              if (reqUrl.includes('/api/v1/files') && data && data.has_more === false) {
                window.__visualFilesDone = true;
              }
              if (reqUrl.includes('/api/v1/relations') && data && data.ok) {
                window.__visualRelationsDone = true;
              }
              return new Response(JSON.stringify(rewrite(data)), {
                status: res.status,
                headers: { 'content-type': type },
              });
            } finally {
              window.__visualInflight = Math.max(0, window.__visualInflight - 1);
            }
          };
        })();
      `,
    });
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    await cdp.send('Page.navigate', { url: endpoint });
    try {
      await waitFor(
        () => cdp.eval(`return Boolean(document.querySelector('[data-gallery-card]'));`),
        { label: 'HomeView loaded' }
      );
    } catch (e) {
      const diag = await cdp.eval(`
        let probe = null;
        try {
          const r = await fetch('${endpoint}/api/v1/state-overview');
          const t = await r.text();
          probe = { status: r.status, head: t.slice(0, 160) };
        } catch (e) { probe = { fetchError: String(e) }; }
        return {
          bodyHead: (document.body?.innerText || '').slice(0, 200),
          hasReactRoot: Boolean(document.getElementById('root')),
          probe,
        };
      `).catch(() => null);
      console.error('  [诊断] HomeView 未就绪上下文:', JSON.stringify(diag));
      throw e;
    }
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-chronos-badge]'));`),
      { timeoutMs: 30000, label: 'chronos badge' }
    );
    await waitFor(
      () =>
        cdp.eval(
          `return Boolean(document.querySelector('button[data-home-trend-jumpable="true"]'));`
        ),
      { timeoutMs: 30000, label: 'jumpable trend bars' }
    );
    await waitFor(
      () =>
        cdp.eval(
          `return Boolean(window.__visualFilesDone && window.__visualRelationsDone && window.__visualInflight === 0);`
        ),
      { timeoutMs: 45000, label: 'all 5507 files and relations loaded' }
    );
    await cdp.eval(`
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 10000))]);
      }
      return true;
    `);
    await settleFrames(cdp, 1500);

    const ssotCheck = await cdp.eval(`
      const radarBtn = document.querySelector('button[aria-label^="未决决策 "]');
      const cardCount = document.querySelector('[data-feature-count="decision"]');
      return {
        radarAria: radarBtn ? radarBtn.getAttribute('aria-label') : null,
        cardText: cardCount ? cardCount.innerText.trim() : null,
      };
    `);
    assert.equal(
      ssotCheck.radarAria,
      `未决决策 ${EXPECTED_PENDING_DECISIONS}`,
      `顶栏未决决策计数应为 ${EXPECTED_PENDING_DECISIONS}，实得 ${JSON.stringify(ssotCheck)}`
    );
    assert.equal(
      ssotCheck.cardText,
      String(EXPECTED_PENDING_DECISIONS),
      `首页待拍板焦点计数应为 ${EXPECTED_PENDING_DECISIONS}，实得 ${JSON.stringify(ssotCheck)}`
    );
    console.log(
      `  [SSOT 证据] 顶栏「${ssotCheck.radarAria}」=== 首页待拍板「${ssotCheck.cardText}」✓`
    );

    shots.set('home-today', await captureShot(cdp));

    await clickPrimaryTab(cdp, '全景溯源');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('svg'));`),
      { timeoutMs: 30000, label: 'canvas svg' }
    );
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-cv-package-group]'));`),
      { timeoutMs: 30000, label: 'package group frame' }
    );
    await sleep(1500);
    await cdp.eval(`
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '重置');
      btn?.click();
      return true;
    `);
    await sleep(1000);
    await settleFrames(cdp, 500);
    shots.set('graph-panorama', await captureShot(cdp));

    await wheelZoom(cdp, 294, 400, 1, 240);
    shots.set('graph-folded-groups', await captureShot(cdp));

    const cardPt = await cdp.eval(`
      const el = document.querySelector('[data-cv-package-group]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cx = Math.max(120, Math.min(1300, Math.round(r.x + r.width / 2)));
      const cy = Math.max(160, Math.min(780, Math.round(r.y + r.height / 2)));
      return { x: cx, y: cy };
    `);
    assert.ok(cardPt, '缩小后应能在视口内找到任务包折叠组');
    await wheelZoom(cdp, cardPt.x, cardPt.y, 3, -240);
    shots.set('graph-node-cards', await captureShot(cdp));

    await clickButtonByAria(cdp, '切换画布为纸面主题');
    await settleFrames(cdp, 500);
    await waitFor(
      () =>
        cdp.eval(
          `return document.querySelector('[data-canvas-theme]')?.getAttribute('data-canvas-theme') === 'xray-light';`
        ),
      { label: 'porthole xray-light' }
    );
    shots.set('graph-paper', await captureShot(cdp));
    await clickButtonByAria(cdp, '切换画布为夜航主题');
    await settleFrames(cdp, 400);

    await clickButtonIn(cdp, '[aria-label="全景溯源视图切换"]', '日历');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-cal-sticky-header]'));`),
      { timeoutMs: 30000, label: 'calendar sticky header' }
    );
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-calendar-compact]'));`),
      { timeoutMs: 30000, label: 'calendar compact gate chip' }
    );
    await settleFrames(cdp, 700);
    const compactActive = await cdp.eval(`
      const chip = document.querySelector('[data-calendar-compact]');
      return chip ? chip.getAttribute('aria-pressed') === 'true' : null;
    `);
    assert.ok(compactActive !== null, '紧凑活跃开关应存在（夹具空白段须命中智能识别门槛）');
    if (compactActive) {
      await cdp.eval(`
        document.querySelector('[data-calendar-compact]')?.click();
        return true;
      `);
      await waitFor(
        () =>
          cdp.eval(
            `return document.querySelector('[data-calendar-compact]')?.getAttribute('aria-pressed') === 'false';`
          ),
        { label: 'calendar compact disabled' }
      );
      await settleFrames(cdp, 900);
    }

    const calGeo = await cdp.eval(`
      const rows = Array.from(document.querySelectorAll('[data-cal-row]'));
      let totalChips = 0;
      let checkedRows = 0;
      const collisions = [];
      for (const row of rows) {
        const key = row.getAttribute('data-cal-row');
        if (key === '__events__') continue;
        const chips = Array.from(row.querySelectorAll('[data-slot-chip]'));
        if (!chips.length) continue;
        checkedRows += 1;
        totalChips += chips.length;
        const rects = chips
          .map((c) => {
            const r = c.getBoundingClientRect();
            return { date: c.getAttribute('data-slot-chip'), left: r.left, right: r.right, width: r.width };
          })
          .sort((a, b) => a.left - b.left);
        for (let i = 1; i < rects.length; i += 1) {
          const prev = rects[i - 1];
          const cur = rects[i];
          if (prev.right > cur.left + 0.5) {
            collisions.push({ row: key, prev, cur, overlapPx: Number((prev.right - cur.left).toFixed(2)) });
          }
        }
      }
      const evRow = document.querySelector('[data-cal-row="__events__"]');
      const evRect = evRow ? evRow.getBoundingClientRect() : null;
      return {
        checkedRows,
        totalChips,
        collisions,
        eventsRowVisible: Boolean(evRect && evRect.height >= 40 && evRect.bottom <= window.innerHeight + 1),
        eventsRowRect: evRect ? { top: Math.round(evRect.top), bottom: Math.round(evRect.bottom), height: Math.round(evRect.height) } : null,
      };
    `);
    assert.ok(calGeo.totalChips >= 15, `连续 15 天百文日应产出 ≥15 枚热力槽位芯片，实得 ${JSON.stringify(calGeo)}`);
    assert.equal(calGeo.collisions.length, 0, `日历同行槽位存在像素碰撞：${JSON.stringify(calGeo.collisions.slice(0, 5))}`);
    assert.ok(calGeo.eventsRowVisible, `底部事件刻度行应完整可见无裁切，实得 ${JSON.stringify(calGeo.eventsRowRect)}`);
    console.log(
      `  [日历零碰撞证据] ${calGeo.checkedRows} 行 ${calGeo.totalChips} 枚高密热力槽 0px 碰撞 · 事件刻度行 h=${calGeo.eventsRowRect.height}px 完整可见 ✓`
    );

    shots.set('calendar-window', await captureShot(cdp));
    await cdp.eval(`
      document.querySelector('[data-calendar-compact]')?.click();
      return true;
    `);
    await waitFor(
      () =>
        cdp.eval(
          `return document.querySelector('[data-calendar-compact]')?.getAttribute('aria-pressed') === 'true';`
        ),
      { label: 'calendar compact enabled' }
    );
    await settleFrames(cdp, 900);
    shots.set('calendar-compact', await captureShot(cdp));

    const chipInfo = await cdp.eval(`
      const chips = Array.from(document.querySelectorAll('[data-slot-chip]'));
      if (!chips.length) return null;
      const last = chips[chips.length - 1];
      last.scrollIntoView({ block: 'center', inline: 'center' });
      const r = last.getBoundingClientRect();
      return {
        date: last.getAttribute('data-slot-chip'),
        count: last.getAttribute('data-slot-compact'),
        x: Math.round(r.x),
        y: Math.round(r.y),
      };
    `);
    assert.ok(chipInfo, '近 30 天高密带应产出密集芯片（data-slot-chip）');
    await settleFrames(cdp, 200);
    await cdp.eval(`
      const chips = Array.from(document.querySelectorAll('[data-slot-chip]'));
      chips[chips.length - 1]?.click();
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-slot-day-list]'));`),
      { label: 'slot day list popover' }
    );
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-calendar-focus-card]'));`),
      { label: 'calendar focus card' }
    );
    await settleFrames(cdp, 400);
    const popoverGeo = await cdp.eval(`
      const pop = document.querySelector('[data-slot-day-list]');
      const card = document.querySelector('[data-calendar-focus-card]');
      if (!pop || !card) return { hasPop: Boolean(pop), hasCard: Boolean(card) };
      const a = pop.getBoundingClientRect();
      const b = card.getBoundingClientRect();
      const overlap = !(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
      return {
        hasPop: true,
        hasCard: true,
        overlap,
        popRight: Math.round(a.right),
        cardLeft: Math.round(b.left),
      };
    `);
    assert.ok(popoverGeo.hasPop && popoverGeo.hasCard, '弹层与右侧聚焦卡须同屏呈现');
    assert.ok(!popoverGeo.overlap, `弹层不得压盖右侧聚焦卡（实测 ${JSON.stringify(popoverGeo)}）`);
    shots.set('calendar-popover', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(
      () => cdp.eval(`return !document.querySelector('[data-slot-day-list]');`),
      { label: 'popover closed' }
    );

    await clickButtonIn(cdp, '[aria-label="全景溯源视图切换"]', '列表');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-timeline-chronos-stream]'));`),
      { timeoutMs: 25000, label: 'timeline chronos stream' }
    );
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-timeline-day-frame]'));`),
      { timeoutMs: 25000, label: 'timeline day frame' }
    );
    await settleFrames(cdp, 600);
    shots.set('timeline-stream', await captureShot(cdp));

    await clickPrimaryTab(cdp, '知识资产库');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-reader-shell]'));`),
      { timeoutMs: 25000, label: 'library reader' }
    );
    await cdp.eval(`
      const findRow = () => Array.from(document.querySelectorAll('[data-sidebar-file]'))
        .find((r) => r.innerText.includes('00-需求蓝图'));
      if (findRow()) { findRow().scrollIntoView({ block: 'center' }); findRow().click(); return 'row-clicked'; }
      const folderBtn = Array.from(document.querySelectorAll('aside button'))
        .find((b) => b.innerText.trim().startsWith('04-星图引擎'));
      folderBtn?.scrollIntoView({ block: 'center' });
      folderBtn?.click();
      return 'folder-clicked';
    `);
    await waitFor(
      () =>
        cdp.eval(`
          return Boolean(Array.from(document.querySelectorAll('[data-sidebar-file]'))
            .find((r) => r.innerText.includes('00-需求蓝图')));
        `),
      { label: 'blueprint sidebar row' }
    );
    await cdp.eval(`
      const row = Array.from(document.querySelectorAll('[data-sidebar-file]'))
        .find((r) => r.innerText.includes('00-需求蓝图'));
      row?.scrollIntoView({ block: 'center' });
      row?.click();
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-decision-submit]'));`),
      { label: 'reader decision form' }
    );
    await settleFrames(cdp, 900);
    shots.set('reader-decision', await captureShot(cdp));

    await cdp.eval(`
      const shell = document.querySelector('[data-reader-shell]');
      const scroller = shell?.scrollHeight && shell.scrollHeight > shell.clientHeight
        ? shell
        : shell?.querySelector('[class*="overflow-y-auto"], [class*="overflow-auto"]');
      if (scroller) scroller.scrollTop = 700;
      return true;
    `);
    await settleFrames(cdp, 400);
    shots.set('reader-scrolled', await captureShot(cdp));

    await cdp.eval(`
      const shell = document.querySelector('[data-reader-shell]');
      const scroller = shell?.scrollHeight && shell.scrollHeight > shell.clientHeight
        ? shell
        : shell?.querySelector('[class*="overflow-y-auto"], [class*="overflow-auto"]');
      if (scroller) scroller.scrollTop = 0;
      return true;
    `);
    await settleFrames(cdp, 300);
    await clickButtonByAria(cdp, '切换到深色阅读纸');
    await settleFrames(cdp, 500);
    shots.set('reader-dark-paper', await captureShot(cdp));
    await clickButtonByAria(cdp, '切换到纸面浅色');
    await settleFrames(cdp, 400);

    await cdp.eval(`
      document.querySelector('[data-reader-zen-toggle]')?.click();
      return true;
    `);
    await settleFrames(cdp, 600);
    shots.set('reader-zen', await captureShot(cdp));
    await cdp.eval(`
      document.querySelector('[data-reader-zen-toggle]')?.click();
      return true;
    `);
    await settleFrames(cdp, 500);

    await clickButtonByTitle(cdp, '溯源与关联');
    await waitFor(
      () =>
        cdp.eval(
          `return Boolean(document.querySelector('aside[aria-label="所选对象详情检查器"] [data-inspector-time-trail]'));`
        ),
      { label: 'inspector time trail' }
    );
    await settleFrames(cdp, 500);
    shots.set('reader-inspector', await captureShot(cdp));
    await clickButtonByTitle(cdp, '溯源与关联');
    await settleFrames(cdp, 400);

    await cdp.eval(`
      document.querySelector('[data-reader-version-axis-trigger]')?.click();
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-reader-version-axis]'));`),
      { label: 'reader mini version axis' }
    );
    await settleFrames(cdp, 400);
    shots.set('reader-version-axis', await captureShot(cdp));

    await cdp.eval(`
      const btn = document.querySelector('[data-reader-open-time-machine]');
      if (!btn) return false;
      btn.click();
      return true;
    `);
    await waitFor(
      () =>
        cdp.eval(`return Boolean(document.querySelector('section[aria-label="文档版本时光机"]'));`),
      { label: 'document time machine' }
    );
    await settleFrames(cdp, 2100);
    await cdp.eval(`
      const seg = document.querySelector('[data-machine-theme-seg]');
      const darkBtn = seg
        ? Array.from(seg.querySelectorAll('button')).find((b) => b.getAttribute('aria-pressed') === 'false' && (b.getAttribute('aria-label') || '').includes('夜航'))
        : null;
      darkBtn?.click();
      return true;
    `);
    await waitFor(
      () =>
        cdp.eval(
          `return document.querySelector('[data-canvas-theme]')?.getAttribute('data-canvas-theme') === 'xray-dark';`
        ),
      { label: 'machine xray-dark' }
    );
    await settleFrames(cdp, 500);
    shots.set('time-machine-night', await captureShot(cdp));
    await clickButtonByAria(cdp, '切换画布为纸面主题');
    await settleFrames(cdp, 2100);
    shots.set('time-machine-paper', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(
      () =>
        cdp.eval(`return !document.querySelector('section[aria-label="文档版本时光机"]');`),
      { label: 'time machine closed' }
    );

    await clickPrimaryTab(cdp, '知识资产库');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[aria-label="知识资产库视图切换"]'));`),
      { label: 'library mode switch' }
    );
    await cdp.eval(`
      const root = document.querySelector('[aria-label="知识资产库视图切换"]');
      const tab = root && Array.from(root.querySelectorAll('[role="tab"], button')).find((b) => b.innerText.trim() === '概览');
      tab?.click();
      return Boolean(tab);
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-atlas-folder-frame]'));`),
      { timeoutMs: 25000, label: 'atlas folder frames' }
    );
    await settleFrames(cdp, 600);
    shots.set('atlas-overview', await captureShot(cdp));
    await cdp.eval(`
      const root = document.querySelector('[aria-label="知识资产库视图切换"]');
      const tab = root && Array.from(root.querySelectorAll('[role="tab"], button')).find((b) => b.innerText.trim() === '阅读');
      tab?.click();
      return Boolean(tab);
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-reader-shell]'));`),
      { label: 'back to library reader' }
    );
    await settleFrames(cdp, 400);

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
    });
    await pressRawKey(cdp, { key: 'k', code: 'KeyK', vk: 75, modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
    });
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-command-palette-input]'));`),
      { label: 'command palette' }
    );
    await settleFrames(cdp, 500);
    shots.set('palette', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(() => anyEscLayerOpen(cdp).then((v) => !v), { label: 'palette closed' });

    await clickButtonByTitle(cdp, '打开批阅看板');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-review-board-drawer]'));`),
      { label: 'review board drawer' }
    );
    await settleFrames(cdp, 600);
    shots.set('review-board', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(
      () => cdp.eval(`return !document.querySelector('[data-review-board-drawer]');`),
      { label: 'review board closed' }
    );

    const spaceTargetReady = await cdp.eval(`
      const body = document.body;
      body.focus?.();
      return true;
    `);
    assert.ok(spaceTargetReady, 'body 聚焦失败');
    await pressRawKey(cdp, { key: ' ', code: 'Space', vk: 32 });
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-quick-preview-modal]'));`),
      { label: 'quick preview modal' }
    );
    await settleFrames(cdp, 700);
    shots.set('quick-preview', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(
      () => cdp.eval(`return !document.querySelector('[data-quick-preview-modal]');`),
      { label: 'quick preview closed' }
    );

    await clickPrimaryTab(cdp, '首页');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-gallery-card]'));`),
      { label: 'home for chronos digest' }
    );
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-open-chronos-digest]'));`),
      { label: 'chronos digest button' }
    );
    await cdp.eval(`
      document.querySelector('[data-open-chronos-digest]')?.click();
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-chronos-digest-drawer="open"]'));`),
      { label: 'chronos digest drawer' }
    );
    await settleFrames(cdp, 500);
    shots.set('chronos-digest', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(
      () => cdp.eval(`return !document.querySelector('[data-chronos-digest-drawer="open"]');`),
      { label: 'chronos digest closed' }
    );

    await clickButtonByAria(cdp, '项目设置');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-settings-modal="open"]'));`),
      { label: 'settings modal' }
    );
    await cdp.eval(`
      document.querySelector('[data-settings-tab="about"]')?.click();
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-about-version="1.2.3"]'));`),
      { label: 'about v1.2.3 badge' }
    );
    const aboutInfo = await cdp.eval(`
      return {
        version: document.querySelector('[data-about-version]')?.getAttribute('data-about-version') || '',
        gitSha: document.querySelector('[data-about-git-sha]')?.getAttribute('data-about-git-sha') || '',
        buildTime: document.querySelector('[data-about-build-time]')?.getAttribute('data-about-build-time') || '',
      };
    `);
    assert.equal(aboutInfo.version, '1.2.3', `关于页版本应为 1.2.3，实得 ${JSON.stringify(aboutInfo)}`);
    assert.ok(aboutInfo.gitSha.length >= 6, `关于页应透出编译期 git-sha，实得 ${JSON.stringify(aboutInfo)}`);
    assert.ok(aboutInfo.buildTime.length >= 10, `关于页应透出编译期构建时间，实得 ${JSON.stringify(aboutInfo)}`);
    console.log(
      `  [版本透出证据] v${aboutInfo.version} · git-sha=${aboutInfo.gitSha} · built=${aboutInfo.buildTime} ✓`
    );
    await settleFrames(cdp, 400);
    shots.set('settings-about', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(
      () => cdp.eval(`return !document.querySelector('[data-settings-modal="open"]');`),
      { label: 'settings modal closed' }
    );

    const jumpTarget = await cdp.eval(`
      const bar = document.querySelector('button[data-home-trend-jumpable="true"]');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return { date: bar.getAttribute('data-home-trend-bar'), x: Math.round(r.x), y: Math.round(r.y) };
    `);
    assert.ok(jumpTarget, '首页应有可直跳的日粒度走势柱');
    await cdp.eval(`
      const bar = document.querySelector('button[data-home-trend-jumpable="true"]');
      bar?.click();
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('svg'));`),
      { label: 'jump landed on canvas' }
    );
    await waitFor(
      () =>
        cdp.eval(`
          const t = document.querySelector('[data-cv-chronos-stepper]')?.getAttribute('title') || '';
          // 未锁定：司辰 · 全域（…）/ 司辰聚焦时间 · 全域；锁定后必含具体日期（直跳语义）
          return t.length > 0 && !t.includes('全域');
        `),
      { label: 'activeDate locked (chronos stepper)' }
    );
    await settleFrames(cdp, 2100);
    const lockTitle = await cdp.eval(`
      return document.querySelector('[data-cv-chronos-stepper]')?.getAttribute('title') || '';
    `);
    console.log(
      `  [柱图直跳证据] 柱图 ${jumpTarget.date} 直跳 → 星图锁定：${lockTitle.split('（')[0]}`
    );
    shots.set('home-trend-jump', await captureShot(cdp));

    await clickPrimaryTab(cdp, '首页');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-gallery-card]'));`),
      { label: 'home before dark switch' }
    );
    await cdp.eval(`
      const toggle = document.querySelector('[data-app-theme-toggle]');
      if (toggle && !document.documentElement.classList.contains('dark')) {
        toggle.click();
      }
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return document.documentElement.classList.contains('dark');`),
      { label: 'global dark mode active' }
    );
    await settleFrames(cdp, 600);
    shots.set('dark-home', await captureShot(cdp));

    await clickPrimaryTab(cdp, '全景溯源');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[aria-label="全景溯源视图切换"]'));`),
      { label: 'panorama switch in dark' }
    );
    await clickButtonIn(cdp, '[aria-label="全景溯源视图切换"]', '日历');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-cal-sticky-header]'));`),
      { timeoutMs: 30000, label: 'dark calendar sticky header' }
    );
    await settleFrames(cdp, 700);
    shots.set('dark-calendar', await captureShot(cdp));

    await clickButtonByAria(cdp, '项目设置');
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-settings-modal="open"]'));`),
      { label: 'dark settings modal' }
    );
    await cdp.eval(`
      document.querySelector('[data-settings-tab="about"]')?.click();
      return true;
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-about-version="1.2.3"]'));`),
      { label: 'dark about v1.2.3' }
    );
    await settleFrames(cdp, 500);
    shots.set('dark-settings', await captureShot(cdp));
    await pressEscape(cdp);
    await waitFor(
      () => cdp.eval(`return !document.querySelector('[data-settings-modal="open"]');`),
      { label: 'dark settings closed' }
    );
  } finally {
    cdp.close();
    if (!browserProc.killed) browserProc.kill();
    await sleep(300);
  }
  return shots;
}


async function diffPngPair(cdp, baselineBuf, currentBuf) {
  const b64a = baselineBuf.toString('base64');
  const b64b = currentBuf.toString('base64');
  return cdp.eval(`
    const load = (b64) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('png decode failed'));
      img.src = 'data:image/png;base64,' + b64;
    });
    const [a, b] = await Promise.all([load('${b64a}'), load('${b64b}')]);
    if (a.width !== b.width || a.height !== b.height) {
      return { sizeMismatch: true, sizeA: [a.width, a.height], sizeB: [b.width, b.height] };
    }
    const ca = document.createElement('canvas');
    ca.width = a.width; ca.height = a.height;
    const cb = document.createElement('canvas');
    cb.width = b.width; cb.height = b.height;
    ca.getContext('2d').drawImage(a, 0, 0);
    cb.getContext('2d').drawImage(b, 0, 0);
    const da = ca.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    const db = cb.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    let diffPixels = 0;
    let maxDelta = 0;
    let firstDiff = null;
    let bbox = null;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i+1] - db[i+1]), Math.abs(da[i+2] - db[i+2]), Math.abs(da[i+3] - db[i+3]));
      if (d > 0) {
        diffPixels += 1;
        if (d > maxDelta) maxDelta = d;
        if (!firstDiff) firstDiff = [ (i/4) % a.width, Math.floor((i/4) / a.width), d ];
        const x = (i/4) % a.width;
        const y = Math.floor((i/4) / a.width);
        if (!bbox) bbox = [x, y, x, y];
        else {
          if (x < bbox[0]) bbox[0] = x;
          if (y < bbox[1]) bbox[1] = y;
          if (x > bbox[2]) bbox[2] = x;
          if (y > bbox[3]) bbox[3] = y;
        }
      }
    }
    return {
      sizeMismatch: false,
      totalPixels: da.length / 4,
      diffPixels,
      maxDelta,
      diffRatio: diffPixels / (da.length / 4),
      firstDiff,
      bbox,
    };
  `);
}

async function makeDiffContext() {
  const { browserProc, cdp } = await startBrowser('about:blank', TMP.diffProfile);
  try {
    await cdp.eval(`
      document.body.style.margin = '0';
      return true;
    `);
  } catch {
  }
  return {
    cdp,
    close: () => {
      cdp.close();
      if (!browserProc.killed) browserProc.kill();
    },
  };
}


let TMP = null;

async function withTmp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-visual-'));
  const wsDir = path.join(os.tmpdir(), 'guanlan-visual-ws');
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });
  TMP = {
    base,
    wsDir,
    dataDir: path.join(base, 'data'),
    chromeProfile: path.join(base, 'chrome-profile'),
    diffProfile: path.join(base, 'chrome-profile-diff'),
  };
  fs.mkdirSync(TMP.dataDir, { recursive: true });
  fs.mkdirSync(TMP.chromeProfile, { recursive: true });
  fs.mkdirSync(TMP.diffProfile, { recursive: true });
}

async function triggerCoreAndWaitL4aDrain(endpoint, wsDir) {
  await waitFor(async () => {
    const r = await fetch(`${endpoint}/api/v1/status`).then((res) => res.json());
    return Array.isArray(r.active_jobs) && r.active_jobs.length === 0;
  }, { timeoutMs: 45000, intervalMs: 150, label: 'startup jobs idle' });

  writeCoreFixtureFiles(wsDir);
  const submitRes = await fetch(`${endpoint}/api/v1/index-jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'changed_paths',
      paths: FIXTURE_FILES.map((f) => f.rel),
    }),
  });
  assert.ok(
    submitRes.status === 202 || submitRes.status === 200,
    `提交 changed_paths 任务失败：HTTP ${submitRes.status}`
  );

  const expectedL4aMd = FIXTURE_FILES.filter((f) => f.rel.endsWith('.md')).length;
  const settledStatus = await waitFor(async () => {
    const s = await fetch(`${endpoint}/api/v1/status`).then((res) => res.json());
    const jobsIdle = Array.isArray(s.active_jobs) && s.active_jobs.length === 0;
    const l4a = s.l4a_progress;
    if (
      jobsIdle &&
      l4a &&
      l4a.total >= expectedL4aMd &&
      l4a.queue_depth === 0 &&
      l4a.percent === 100 &&
      l4a.done >= expectedL4aMd
    ) {
      return s;
    }
    return null;
  }, { timeoutMs: 45000, intervalMs: 150, label: 'L4A auto-drain to 100%' });

  const boot = await fetch(`${endpoint}/api/v1/bootstrap`).then((res) => res.json());
  assert.equal(
    boot.counts?.files,
    EXPECTED_TOTAL_FILES,
    `bootstrap 文件总数应为 ${EXPECTED_TOTAL_FILES}，实得 ${boot.counts?.files}`
  );
  assert.equal(
    boot.decisions_unresolved_total,
    EXPECTED_PENDING_DECISIONS,
    `bootstrap 待拍板 SSOT 应为 ${EXPECTED_PENDING_DECISIONS}，实得 ${boot.decisions_unresolved_total}`
  );
  const l4a = settledStatus.l4a_progress;
  console.log(
    `  [后端门禁] ${boot.counts.files} 份资产（${EXPECTED_BIZ_FILES} 业务 + ${GEN_CODE_TOTAL} 代码）· 待拍板 SSOT ${boot.decisions_unresolved_total} · L4A 自动排空 ${l4a.done}/${l4a.total} (${l4a.percent}%, queue=${l4a.queue_depth}) ✓`
  );
}

async function main() {
  const mode = process.argv[2] === 'compare' ? 'compare' : process.argv[2] === 'capture' ? 'capture' : null;
  const keepFail = process.argv.includes('--keep');
  if (!mode) {
    console.error('用法: node scripts/visual-baseline.mjs capture|compare [--keep]');
    process.exit(2);
  }
  assert.ok(fs.existsSync(EXE), `缺少 guanlan.exe：${EXE}（先 cargo build --release -p guanlan-service）`);
  assert.ok(fs.existsSync(path.join(DIST_DIR, 'index.html')), `缺少 dist：${DIST_DIR}（先 npm run build）`);

  await withTmp();
  buildBulkFixture(TMP.wsDir);
  const env = {
    ...process.env,
    GUANLAN_DATA_DIR: TMP.dataDir,
    GUANLAN_DIST_DIR: DIST_DIR,
  };

  let serveProc = null;
  const gate = new ConsoleGate();
  try {
    console.log(
      `[1/4] scan + serve + L4A 自动排空（${mode} 模式 · ${EXPECTED_TOTAL_FILES} 份极限高密夹具：${EXPECTED_BIZ_FILES} 业务 + ${GEN_CODE_TOTAL} 代码）...`
    );
    await runScan(TMP.wsDir, env);
    const started = await startServe(TMP.wsDir, env);
    serveProc = started.serveProc;
    const { endpoint } = started;
    console.log('  endpoint =', endpoint);
    await triggerCoreAndWaitL4aDrain(endpoint, TMP.wsDir);

    console.log(`[2/4] 无头浏览器执行视觉回归 · ${SHOT_SCENES.length} 场景 × ${SHOT_PLAN.length} 镜头（明暗双态 × 5,507 份）...`);
    const shots = await captureAllShots(endpoint, gate);
    assert.equal(
      shots.size,
      SHOT_PLAN.length,
      `应产出 ${SHOT_PLAN.length} 个镜头（${SHOT_SCENES.length} 场景全量），实际 ${shots.size}`
    );
    for (const [name] of shots) {
      const outPath = mode === 'capture'
        ? path.join(BASELINE_DIR, `${name}.png`)
        : path.join(TMP.base, `${name}.png`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, shots.get(name));
    }
    for (const { scene, shots: sceneShots } of SHOT_SCENES) {
      console.log(`  ${scene}: ${sceneShots.join(' · ')}`);
    }
    console.log(`  已产出镜头: ${shots.size}/${SHOT_PLAN.length}`);

    if (mode === 'capture') {
      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      console.log('[3/4] 基线已固化到 ' + BASELINE_DIR);
      for (const line of gate.report()) console.log('  ' + line);
      if (!gate.clean) {
        console.error('[4/4] capture 失败：Console 门禁非零（0 Error / 0 Warning 不满足）。');
        process.exitCode = 1;
      } else {
        console.log(`[4/4] capture 完成：${SHOT_SCENES.length} 场景 ${SHOT_PLAN.length} 镜头基线固化 + Console 0 Error / 0 Warning ✓`);
      }
      return;
    }

    console.log('[3/4] 与基线逐像素比对...');
    const diff = await makeDiffContext();
    try {
      let failed = false;
      for (const [name, current] of shots) {
        const baselinePath = path.join(BASELINE_DIR, `${name}.png`);
        if (!fs.existsSync(baselinePath)) {
          console.log(`  ✗ ${name}: 基线缺失 ${baselinePath}（先 capture）`);
          failed = true;
          continue;
        }
        const baseline = fs.readFileSync(baselinePath);
        const r = await diffPngPair(diff.cdp, baseline, current);
        if (r.sizeMismatch) {
          console.log(`  ✗ ${name}: 尺寸不一致 ${JSON.stringify(r.sizeA)} vs ${JSON.stringify(r.sizeB)}`);
          failed = true;
          continue;
        }
        const declared = VISUAL_DECLARED_SHIFTS[name];
        const noiseFloor = SHOT_NOISE_FLOOR[name];
        const ratioOk = noiseFloor !== undefined
          ? r.diffRatio <= noiseFloor && r.maxDelta <= NOISE_MAX_DELTA
          : r.diffRatio <= DIFF_RATIO_GATE;
        const gateLabel = noiseFloor !== undefined
          ? `噪声底 ${(noiseFloor * 100).toFixed(1)}% & maxΔ≤${NOISE_MAX_DELTA}`
          : `闸门 ${(DIFF_RATIO_GATE * 100).toFixed(1)}%`;
        if (r.diffPixels === 0) {
          console.log(`  ✓ ${name}: 逐字节一致 (${r.totalPixels} px)`);
        } else if (ratioOk) {
          console.log(`  ✓ ${name}: 容差内一致（diff=${r.diffPixels} px = ${(r.diffRatio * 100).toFixed(3)}% ≤ ${gateLabel}, maxΔ=${r.maxDelta}, 簇=${JSON.stringify(r.bbox)}）`);
        } else if (declared) {
          console.log(`  ~ ${name}: 已声明偏移（diff=${r.diffPixels} px, ${(r.diffRatio * 100).toFixed(3)}%, maxΔ=${r.maxDelta}）— ${declared}`);
        } else {
          console.log(`  ✗ ${name}: 未声明差异 diff=${r.diffPixels} px (${(r.diffRatio * 100).toFixed(3)}%), maxΔ=${r.maxDelta}, 首差=${JSON.stringify(r.firstDiff)}, 簇包围盒=${JSON.stringify(r.bbox)}`);
          failed = true;
          if (keepFail) {
            fs.mkdirSync(FAIL_DIR, { recursive: true });
            fs.writeFileSync(path.join(FAIL_DIR, `${name}.png`), current);
          }
        }
      }
      for (const line of gate.report()) console.log('  ' + line);
      if (failed || !gate.clean) {
        if (failed) console.log('[4/4] compare 失败：存在未声明的像素差异。');
        if (!gate.clean) console.log('[4/4] compare 失败：Console 门禁非零。');
        process.exitCode = 1;
      } else {
        console.log(`[4/4] compare 通过：${SHOT_PLAN.length} 镜头（明暗双态 × 5,507 份）与基线一致 + Console 0 Error / 0 Warning ✓`);
      }
    } finally {
      diff.close();
    }
  } finally {
    if (serveProc && !serveProc.killed) serveProc.kill();
    await sleep(300);
    fs.rmSync(TMP.base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('VISUAL-BASELINE FAILED:', err);
  process.exit(1);
});
