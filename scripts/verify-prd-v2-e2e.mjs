import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(REPO_ROOT, 'native/target/release/guanlan.exe');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
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

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 150, label = 'condition' } = {}) {
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
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
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

async function main() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-a01-e2e-'));
  const wsDir = path.join(tmpBase, 'workspace');
  const dataDir = path.join(tmpBase, 'data');
  const chromeProfile = path.join(tmpBase, 'chrome-profile');
  fs.mkdirSync(path.join(wsDir, '04-智能体代码'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, '08-数据格式规范'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(chromeProfile, { recursive: true });

  fs.writeFileSync(
    path.join(wsDir, '04-智能体代码', 'README.md'),
    [
      '---',
      'revision: 1',
      '---',
      '# 04-智能体代码',
      '',
      '本专项推进智能体代码与 BOM 联动架构。规范请参见 [字段映射表](../08-数据格式规范/字段映射表.md)。',
      '',
      '核心结论：采用两阶段状态锁与 MCP 草案分支保障并发安全。',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(wsDir, '04-智能体代码', '00-需求蓝图.md'),
    [
      '---',
      'revision: 1',
      '---',
      '# 00-需求蓝图',
      '',
      '明确目标：打通长任务引擎与证道阁上下文闭环。',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(wsDir, '04-智能体代码', '01-方案设计.md'),
    [
      '---',
      'revision: 1',
      '---',
      '# BOM与图纸联动方案',
      '',
      '本方案基于 [字段映射表](../08-数据格式规范/字段映射表.md) 同步物料属性。',
      '',
      '核心结论：初稿完成，待确认策略后进入执行阶段。',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(wsDir, '04-智能体代码', '04-执行联调.md'),
    [
      '---',
      'revision: 1',
      '---',
      '# 04-执行联调',
      '',
      '等待决策门禁解除后推进实现。',
    ].join('\n'),
    'utf8'
  );

  const decisionDocPath = path.join(wsDir, '04-智能体代码', '03-待确认事项.md');

  fs.writeFileSync(
    path.join(wsDir, '04-智能体代码', '05-交付验收清单.md'),
    [
      '---',
      'revision: 1',
      '---',
      '# 05-交付验收清单',
      '',
      '- [x] 状态机六态收敛',
      '- [ ] 联调回归验证',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(wsDir, '08-数据格式规范', '字段映射表.md'),
    [
      '---',
      'revision: 3',
      '---',
      '# 字段映射表',
      '',
      '定义 BOM 字段与图纸属性的统一口径。',
    ].join('\n'),
    'utf8'
  );

  const env = {
    ...process.env,
    GUANLAN_DATA_DIR: dataDir,
    GUANLAN_DIST_DIR: DIST_DIR,
  };

  let serveProc = null;
  let browserProc = null;
  let cdp = null;
  let mcpProc = null;

  try {
    console.log('[1/7] 运行 guanlan scan 初始化测试工作区...');
    const runScan = () =>
      new Promise((resolve, reject) => {
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
    // 先扫 6 份建立基线，再新增 03-待确认事项.md 重扫，使星图画布出现该文档的独立节点
    await runScan();
    fs.writeFileSync(
      decisionDocPath,
      [
        '---',
        'revision: 1',
        '---',
        '# 03-待确认事项',
        '',
        '## 属性字典与历史更新策略',
        '',
        '[P1 - 待确认] 属性字典与历史更新策略',
        '决定：___',
        '确认人：___',
        '角色：___',
        '现运行条件：仅支持静态属性读取',
        '新运行条件：启用增量版本状态锁',
        '生效范围与日期：___',
        '',
        '可选方案：',
        '- 方案A：采用两阶段状态锁',
        '- 方案B：测试环境自动放行',
        '',
        '推荐理由：方案A 风险更低',
      ].join('\n'),
      'utf8'
    );
    await runScan();

    console.log('[2/7] 启动 guanlan serve --watch (挂载前端 dist)...');
    serveProc = spawn(EXE, ['serve', '--root', wsDir, '--watch'], {
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
    console.log('  GUANLAN_ENDPOINT =', endpoint);

    const overviewRes = await fetch(`${endpoint}/api/v1/state-overview`).then((r) => r.json());
    assert.equal(overviewRes.ok, true);
    const init04 = overviewRes.initiatives.find((i) => i.name === '04-智能体代码');
    assert.ok(init04, '应识别 04-智能体代码 专项');
    assert.equal(init04.state, 'pending_review', '含 P1 待确认时专项应为 pending_review');
    assert.equal(init04.pending_p1, 1);

    const tasksBefore = await fetch(`${endpoint}/api/v1/initiatives/${init04.initiative_id}/tasks`).then((r) => r.json());
    const awaitNodeBefore = tasksBefore.nodes.find((n) => n.node_kind === 'await_decision');
    assert.equal(awaitNodeBefore.state, 'suspended_on_hitl', '存在 P1 未决时决策槽应挂起');

    console.log('[3/7] 启动无头浏览器访问真实前端...');
    const browserBin = findBrowser();
    const debugPort = 39222 + Math.floor(Math.random() * 500);
    browserProc = spawn(
      browserBin,
      [
        '--headless=new',
        '--disable-gpu',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${chromeProfile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1440,900',
        endpoint,
      ],
      { stdio: 'ignore' }
    );

    const target = await waitFor(async () => {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
      return list.find((t) => t.type === 'page' && t.url.startsWith(endpoint));
    }, { label: 'browser target' });

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await waitFor(
      () => cdp.eval(`return Boolean(document.body.innerText.includes('04-智能体代码') && document.querySelector('[data-gallery-card]'));`),
      { label: 'HomeView loaded' }
    );

    console.log('[4/7] 验证 AC-01 四视图状态一致 & AC-04 首页证道阁自动勾选...');
    const ac01Home = await cdp.eval(`
      const card = Array.from(document.querySelectorAll('[data-gallery-card]')).find(el => el.innerText.includes('04-智能体代码'));
      const cardState = card?.querySelector('[data-doc-state]')?.getAttribute('data-doc-state');
      const cardStateText = card?.querySelector('[data-doc-state]')?.innerText;
      const radarText = document.body.innerText.match(/未决决策\\s*(\\d+)/)?.[1] ?? null;
      return { cardState, cardStateText, radarText };
    `);
    assert.equal(ac01Home.cardState, 'pending_review');
    assert.equal(ac01Home.cardStateText, '待用户确认');
    assert.equal(ac01Home.radarText, '1', 'TopHeader 未决计数应为 1');

    // 验证全景溯源画布星图节点状态徽标一致
    await cdp.eval(`
      const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
      tabs.find(t => t.innerText.includes('全景溯源'))?.click();
    `);
    const ac01Canvas = await waitFor(
      () => cdp.eval(`
        const badge = document.querySelector('[data-doc-state="pending_review"]');
        if (!badge) return null;
        return { state: badge.getAttribute('data-doc-state'), text: badge.innerText };
      `),
      { label: 'AC-01 GraphCanvasView pending_review badge' }
    );
    assert.equal(ac01Canvas.state, 'pending_review');
    assert.equal(ac01Canvas.text, '待用户确认');

    // 返回首页并打开证道阁（global 意图）
    await cdp.eval(`
      const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
      tabs.find(t => t.innerText.trim() === '首页')?.click();
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-gallery-card]'));`),
      { label: 'back on HomeView' }
    );
    await cdp.eval(`
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('证据篮'));
      btn?.click();
    `);
    const zhendaogeGlobal = await waitFor(
      () => cdp.eval(`
        const dlg = document.querySelector('[role="dialog"][aria-label*="上下文"]');
        if (!dlg) return null;
        const txt = dlg.innerText;
        if (!txt.includes('首页总览')) return null;
        return {
          hasAutoMounted: Boolean(dlg.querySelector('[data-preset-auto-mounted]')),
          text: txt,
        };
      `),
      { label: 'AC-04 global drawer' }
    );
    assert.equal(zhendaogeGlobal.hasAutoMounted, true, '首页总览证道阁首帧必须自动勾选默认包');
    assert.ok(!zhendaogeGlobal.text.includes('(0 项已选)'), '不得出现 0 项已选');
    await cdp.eval(`
      const dlg = document.querySelector('[role="dialog"][aria-label*="上下文"]');
      Array.from(dlg.querySelectorAll('button')).find(b => b.innerText.includes('清空'))?.click();
      document.querySelector('button[aria-label="关闭上下文抽屉"]')?.click();
    `);

    console.log('[5/7] 验证 AC-02 (<300ms 无阻塞首屏) & AC-03 (Inline 拍板回写 + 未决减一 + 解锁)...');
    await cdp.eval(`
      const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
      tabs.find(t => t.innerText.includes('知识资产库'))?.click();
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.querySelector('[data-reader-shell]'));`),
      { label: 'library reader visible' }
    );
    await cdp.eval(`
      const tab = Array.from(document.querySelectorAll('[role="tab"], button')).find(t => t.innerText.trim() === '概览');
      tab?.click();
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(document.body.innerText.includes('03-待确认事项'));`),
      { label: 'overview list visible' }
    );
    await cdp.eval(`
      const el = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => b.innerText.includes('03-待确认事项'));
      el?.click();
    `);

    const readerCheck = await waitFor(
      () => cdp.eval(`
        const shell = document.querySelector('[data-reader-shell]');
        const firstMs = shell?.getAttribute('data-reader-first-screen-ms');
        const submitBtn = document.querySelector('[data-decision-submit]');
        const docStateEl = shell?.querySelector('[data-doc-state]');
        if (!shell || !firstMs || !submitBtn) return null;
        return {
          firstMs: Number(firstMs),
          budget: shell.getAttribute('data-reader-first-screen-budget'),
          hasBlockingMask: document.body.innerText.includes('正在向智能体请求正文'),
          docState: docStateEl?.getAttribute('data-doc-state'),
          docStateText: docStateEl?.innerText,
        };
      `),
      { label: 'ReaderView loaded 03-待确认事项' }
    );
    console.log('  ReaderView 首屏实测耗时 (ms):', readerCheck.firstMs);
    assert.equal(readerCheck.hasBlockingMask, false, '不得出现阻塞遮罩');
    assert.ok(readerCheck.firstMs < 300, `首屏耗时 ${readerCheck.firstMs}ms 必须 < 300ms`);
    assert.equal(readerCheck.budget, 'ok');
    assert.equal(readerCheck.docState, 'pending_review', '文档顶栏六态必须与专项卡片同为 pending_review');
    assert.equal(readerCheck.docStateText, '待用户确认');

    const chosenOpt = await cdp.eval(`
      const setNativeValue = (el, value) => {
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const sel = document.querySelector('[data-decision-choice]');
      const opt = Array.from(sel.options).find(o => o.value && o.value !== '__custom__');
      if (!opt) throw new Error('未提取到预设决定选项: ' + Array.from(sel.options).map(o => o.value).join(','));
      setNativeValue(sel, opt.value);
      const conf = document.querySelector('[data-decision-confirmer]');
      setNativeValue(conf, '架构组');
      const dateEl = document.querySelector('[data-decision-date]');
      if (dateEl) setNativeValue(dateEl, '2026-11-18');
      return opt.value;
    `);
    console.log('  选择预设方案:', chosenOpt);
    await sleep(80);
    await cdp.eval(`document.querySelector('[data-decision-submit]')?.click();`);

    await waitFor(
      () => cdp.eval(`
        const body = document.body.innerText;
        const radarAria = document.querySelector('button[aria-label^="未决决策"]')?.getAttribute('aria-label') || '';
        return body.includes('拍板已回写至源文件') && radarAria === '未决决策 0';
      `),
      { label: 'AC-03 decision resolved in UI' }
    );

    const diskAfterResolve = fs.readFileSync(decisionDocPath, 'utf8');
    assert.ok(diskAfterResolve.includes('[P1 - 已确认]'), '本地 .md 必须更新为 [P1 - 已确认]');
    assert.ok(diskAfterResolve.includes('决定：方案A：采用两阶段状态锁'), '本地 .md 必须回写决定');
    assert.ok(diskAfterResolve.includes('确认人：架构组'), '本地 .md 必须回写确认人');

    const tasksAfterResolve = await fetch(`${endpoint}/api/v1/initiatives/${init04.initiative_id}/tasks`).then((r) => r.json());
    const awaitNodeAfter = tasksAfterResolve.nodes.find((n) => n.node_kind === 'await_decision');
    assert.equal(awaitNodeAfter.state, 'completed', 'P1 清零后决策槽必须自动恢复为 completed');

    console.log('[6/7] 验证 AC-04/AC-05 证道阁双模输出与真实 MCP stdio 回写闭环...');
    await cdp.eval(`
      const homeTab = Array.from(document.querySelectorAll('[role="tab"], button')).find(t => t.innerText.trim() === '首页');
      homeTab?.click();
    `);
    await waitFor(
      () => cdp.eval(`return Boolean(Array.from(document.querySelectorAll('button')).find(el => el.innerText.includes('01-方案设计')));`),
      { label: '01-方案设计 visible on HomeView' }
    );
    await cdp.eval(`
      const item = Array.from(document.querySelectorAll('button')).find(el => el.innerText.includes('01-方案设计'));
      item?.click();
    `);
    await waitFor(
      () => cdp.eval(`return document.querySelector('[data-reader-shell]')?.innerText.includes('BOM与图纸联动方案');`),
      { label: '01-方案设计 opened' }
    );

    await cdp.eval(`
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('证据篮'));
      btn?.click();
    `);
    const zhendaogeDoc = await waitFor(
      () => cdp.eval(`
        const dlg = document.querySelector('[role="dialog"][aria-label*="上下文"]');
        if (!dlg) return null;
        const pre = dlg.querySelector('pre')?.innerText || '';
        if (!pre.includes('<guanlan_context')) return null;
        return {
          hasAutoMounted: Boolean(dlg.querySelector('[data-preset-auto-mounted]')),
          text: dlg.innerText,
          markdown: pre,
        };
      `),
      { label: 'AC-05 Mode A Markdown' }
    );
    assert.equal(zhendaogeDoc.hasAutoMounted, true, '文档入口打开证道阁必须自动勾选上下文');
    assert.ok(zhendaogeDoc.markdown.includes('[全文] 04-智能体代码/01-方案设计.md'), 'Mode A 应包含当前文档完整路径与[全文]标识');
    assert.ok(zhendaogeDoc.markdown.includes('<confirmed_decisions>'), 'Mode A 应包含已拍板段');

    await cdp.eval(`
      const dlg = document.querySelector('[role="dialog"][aria-label*="上下文"]');
      Array.from(dlg.querySelectorAll('button')).find(b => b.innerText.includes('MCP 载荷'))?.click();
    `);
    const zhendaogeJson = await waitFor(
      () => cdp.eval(`
        const dlg = document.querySelector('[role="dialog"][aria-label*="上下文"]');
        const pre = dlg?.querySelector('pre')?.innerText || '';
        if (!pre.includes('"guanlan-mcp/v1"')) return null;
        return JSON.parse(pre);
      `),
      { label: 'AC-05 Mode B JSON' }
    );
    assert.equal(zhendaogeJson.protocol, 'guanlan-mcp/v1');
    assert.deepEqual(zhendaogeJson.allowed_mcp_tools, [
      'guanlan.read_artifact',
      'guanlan.propose_revision',
      'guanlan.resolve_decision',
      'guanlan.commit_checkpoint',
    ]);
    await cdp.eval(`document.querySelector('button[aria-label="关闭上下文抽屉"]')?.click();`);

    mcpProc = spawn(EXE, ['mcp', '--endpoint', endpoint], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const mcpRl = readline.createInterface({ input: mcpProc.stdout });
    const mcpResponses = new Map();
    mcpRl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && mcpResponses.has(msg.id)) {
          mcpResponses.get(msg.id)(msg);
          mcpResponses.delete(msg.id);
        }
      } catch {
        // ignore
      }
    });
    const mcpRpc = (id, method, params) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout for ${method}`)), 10000);
        mcpResponses.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    const initReply = await mcpRpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(initReply.result.serverInfo.name, 'guanlan-mcp');

    const toolsReply = await mcpRpc(2, 'tools/list', {});
    assert.equal(toolsReply.result.tools.length, 4);

    const readReply = await mcpRpc(3, 'tools/call', {
      name: 'guanlan.read_artifact',
      arguments: { uri: 'guanlan://04-智能体代码/01-方案设计.md' },
    });
    assert.equal(readReply.result.isError ?? false, false);
    assert.ok(readReply.result.content[0].text.includes('BOM与图纸联动方案'));

    const proposeStarted = Date.now();
    const proposeReply = await mcpRpc(4, 'tools/call', {
      name: 'guanlan.propose_revision',
      arguments: {
        path: '04-智能体代码/01-方案设计.md',
        content: [
          '---',
          'revision: 2',
          '---',
          '# BOM与图纸联动方案',
          '',
          '核心结论：已按两阶段状态锁完成修订草案，等待人工采纳。',
        ].join('\n'),
        note: 'Agent 提交 BOM 联动方案 v2 草案',
      },
    });
    assert.equal(proposeReply.result.isError ?? false, false);

    const toastText = await waitFor(
      () => cdp.eval(`
        const toast = document.querySelector('[data-proposal-toast]');
        return toast ? toast.innerText : null;
      `),
      { timeoutMs: 5000, label: 'AC-05 ProposalToast within 5s' }
    );
    const toastElapsed = Date.now() - proposeStarted;
    console.log(`  MCP propose_revision → 前端 ProposalToast 弹出耗时: ${toastElapsed}ms`);
    assert.ok(toastText.includes('01-方案设计') && toastText.includes('修订草案'));

    await cdp.eval(`
      const toast = document.querySelector('[data-proposal-toast]');
      Array.from(toast.querySelectorAll('button')).find(b => b.innerText.includes('一键采纳'))?.click();
    `);
    await waitFor(
      () => cdp.eval(`return !document.querySelector('[data-proposal-toast]');`),
      { label: 'ProposalToast adopted and closed' }
    );
    const planDiskAfterAdopt = fs.readFileSync(path.join(wsDir, '04-智能体代码', '01-方案设计.md'), 'utf8');
    assert.ok(planDiskAfterAdopt.includes('revision: 2'), '一键采纳后磁盘原稿应更新到 revision: 2');

    const ckptReply = await mcpRpc(5, 'tools/call', {
      name: 'guanlan.commit_checkpoint',
      arguments: {
        initiative_id: init04.initiative_id,
        stage: '执行',
        status: 'SUCCESS',
        input_context_hash: 'sha256:test',
        note: '执行阶段完成',
      },
    });
    assert.equal(ckptReply.result.isError ?? false, false);
    const tasksAfterCkpt = await fetch(`${endpoint}/api/v1/initiatives/${init04.initiative_id}/tasks`).then((r) => r.json());
    const execNodeAfter = tasksAfterCkpt.nodes.find((n) => n.stage === '执行');
    assert.equal(execNodeAfter.state, 'completed', 'commit_checkpoint SUCCESS 后执行槽应推进为 completed');

    console.log('[7/7] PRD v2.0 AC-01 ~ AC-05 全链路真实浏览器 + MCP + HTTP 实测全部通过！');
  } finally {
    cdp?.close();
    if (mcpProc && !mcpProc.killed) mcpProc.kill();
    if (browserProc && !browserProc.killed) browserProc.kill();
    if (serveProc && !serveProc.killed) serveProc.kill();
    await sleep(300);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
