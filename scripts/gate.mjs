#!/usr/bin/env node
/**
 * 观澜统一门禁 —— 一条命令跑完 CI 的 frontend 与 rust-desktop 作业所跑的全部检查；
 * `--full` 再追加 smoke 作业的那几步。
 *
 * 用法（在仓库根目录执行）：
 *   npm run gate             # 类型检查、前端单测、Vite 构建、安装包配置校验、
 *                            # cargo fmt / clippy / test（整个 workspace）
 *   npm run gate -- --full   # 追加：release 构建 CLI、生成夹具、冒烟、Node ↔ Rust 写入对拍
 *   node scripts/gate.mjs [--full]
 *
 * 替你做三件直接照抄命令时容易漏的事：
 * 1. cargo 一律在 native/ 下执行。rustup 只在 cwd 位于该目录时才读 rust-toolchain.toml，
 *    在仓库根目录跑会用成 rustup 的默认工具链，「本地通过 = CI 通过」就不成立了。
 * 2. 会运行 Rust 代码的步骤统一在一个临时的 GUANLAN_DATA_DIR 下跑，跑完删除。不设它时，
 *    服务与桌面壳的部分测试会写 %LOCALAPPDATA%\Guanlan\workspaces\，也就是已安装的观澜
 *    正在用的数据目录。纯前端的步骤不设它，与 CI 一致。
 * 3. cargo 不在 PATH 上时去 $CARGO_HOME/bin 与 ~/.cargo/bin 找（非交互 shell 常常不带它），
 *    找不到就明确报错。
 *
 * 第一步失败就停，后面没跑的步骤如实列为「未跑」。结束时打印一份运行记录（每步的结果、
 * 耗时、测试数），可以直接贴进提交正文的「运行」一节，格式见 docs/code-standards.md。
 *
 * Rust 测试里提前返回（跳过）的那些算在「通过」里，其实什么都没验证。libtest 会截获通过的测试
 * 打印的内容，扫输出找不到它们的 [skip]。所以 cargo test 那一步设了 GUANLAN_TEST_SKIP_LOG，
 * 测试把自己跳过的原因记进那个文件，运行记录里逐个点名，不计入验证。
 *
 * 已知的偶发失败：npm run build 冷启动时 @tailwindcss/oxide 的提取器偶尔 panic
 * （crates/oxide/src/extractor/boundary.rs，index out of bounds），重跑即过。门禁只对
 * 这一种失败自动重试一次，并在记录里注明重试过；其余失败不重试。
 *
 * 末尾几个纯函数（判定与输出解析）导出给 test/gate-scripts.test.ts；被导入时不执行门禁。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const NATIVE = path.join(REPO, 'native');
const IS_WIN = process.platform === 'win32';
const TSX_CLI = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** 只保留输出的末尾这么多字符用于统计，整个 workspace 的测试输出远小于它。 */
const TAIL_CHARS = 400_000;
/** 安装包脚本产出的 release 版命令行程序（相对仓库根，始终用正斜杠写，运行记录里要贴得出去）。 */
const RELEASE_EXE_REL = 'native/target/release/guanlan.exe';

const USAGE = `观澜统一门禁

用法：
  npm run gate             类型检查、前端单测、Vite 构建、安装包配置校验、cargo fmt / clippy / test
  npm run gate -- --full   追加 release 构建 CLI、生成夹具、冒烟、Node ↔ Rust 写入对拍
  node scripts/gate.mjs [--full]

选项：
  --full       也跑需要 release 构建与夹具的那几步（对应 CI 的 smoke 作业）
  -h, --help   显示这份用法
`;

// ---------- 可被测试的纯函数 ----------

const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g');

/** npm run build 的失败是否是已知的那种偶发崩溃：@tailwindcss/oxide 提取器的 panic。 */
export function isKnownBuildFlake(output) {
  const text = output.replace(ANSI, '');
  return /oxide[\\/]src[\\/]extractor/.test(text) && /panicked/.test(text);
}

/** libtest：累加所有 "test result: … N passed; M failed"。一段都没有时 suites 为 0。 */
export function countRustTests(output) {
  let passed = 0;
  let failed = 0;
  let suites = 0;
  for (const match of output.replace(ANSI, '').matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed/g)) {
    suites += 1;
    passed += Number(match[2]);
    failed += Number(match[3]);
  }
  return { passed, failed, suites };
}

/** node:test：取最后一个 "ℹ pass N" 与 "ℹ fail N"。没有汇总时 suites 为 0。 */
export function countNodeTests(output) {
  const text = output.replace(ANSI, '');
  const pass = [...text.matchAll(/ℹ pass (\d+)/g)];
  const fail = [...text.matchAll(/ℹ fail (\d+)/g)];
  if (pass.length === 0) return { passed: 0, failed: 0, suites: 0 };
  return { passed: Number(pass.at(-1)[1]), failed: Number(fail.at(-1)?.[1] ?? 0), suites: 1 };
}

/** 把一步的结果写成一句话：通过与否、测试数、需要注明的情形。 */
export function describeResult(result, step) {
  const notes = [];
  let tests = '';
  if (step.tests) {
    const counts = step.tests === 'rust' ? countRustTests(result.output) : countNodeTests(result.output);
    if (counts.suites === 0) {
      notes.push('没有解析到测试数');
    } else {
      tests = `，${counts.passed} 通过 / ${counts.failed} 失败`;
    }
  }
  // 被跳过的测试算在「通过」里，但什么都没验证。libtest 会截获通过的测试打印的内容，所以不能
  // 靠扫输出：Rust 测试提前返回时把「测试名: 原因」写进 GUANLAN_TEST_SKIP_LOG，这里读那份记录。
  if (result.skipped !== undefined && result.skipped.length > 0) {
    // 每条是「完整路径::测试名: 原因」，记录里只放测试名；原因在步骤跑完时已经打全了
    const names = result.skipped.map((line) => line.split('::').pop()?.split(': ')[0] ?? line);
    notes.push(`${result.skipped.length} 个测试跳过、什么都没验证（不计入）：${names.join('、')}`);
  }
  if (result.retried) notes.push('重试过一次');
  let verdict = '通过';
  if (result.code !== 0) {
    verdict = result.missingCargo
      ? '未通过（找不到 cargo）'
      : `未通过（退出码 ${result.code}${result.signal ? `，信号 ${result.signal}` : ''}）`;
  }
  return { text: `${verdict}${tests}${notes.length ? `。${notes.join('；')}` : ''}`, ok: result.code === 0 };
}

/**
 * 一步要用的环境变量：cargo 的目录进 PATH；沙箱步骤换成临时的数据目录；收跳过记录的步骤
 * 拿到记录文件的路径。不设 cargoFile 时不动 PATH。
 * @param {{ sandbox?: boolean, skipLog?: boolean }} step
 * @param {{ cargoFile: string | null, sandboxDir: string, skipLogFile: string, base?: NodeJS.ProcessEnv }} context
 */
export function envForStep(step, { cargoFile, sandboxDir, skipLogFile, base = process.env }) {
  const env = { ...base };
  if (cargoFile) env.PATH = `${path.dirname(cargoFile)}${path.delimiter}${env.PATH ?? ''}`;
  if (step.sandbox) env.GUANLAN_DATA_DIR = sandboxDir;
  if (step.skipLog) env.GUANLAN_TEST_SKIP_LOG = skipLogFile;
  return env;
}

/**
 * 运行记录第一行里的命令。全量时必须写 `-- --full`：`npm run gate --full` 会让 npm 把
 * `--full` 当成自己的参数吞掉，照抄的人实际只跑了默认的七步。
 * @param {boolean} full
 */
export function recordCommand(full) {
  return full ? 'npm run gate -- --full' : 'npm run gate';
}

// ---------- 主流程 ----------

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 按 PATH（Windows 下再按 PATHEXT）找一个可执行文件；找不到返回 null。 */
function findOnPath(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = IS_WIN
    ? [
        `${name}.exe`,
        ...[...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';'), '']
          .filter(Boolean)
          .map((ext) => `${name}${ext.toLowerCase()}`),
      ]
    : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** cargo 的位置：PATH 上优先，其次 $CARGO_HOME/bin 与 ~/.cargo/bin。找不到时 file 为 null。 */
export function findCargo() {
  const onPath = findOnPath('cargo');
  if (onPath) return { file: onPath, onPath: true };
  const binDir = process.env.CARGO_HOME
    ? path.join(process.env.CARGO_HOME, 'bin')
    : path.join(os.homedir(), '.cargo', 'bin');
  const candidate = path.join(binDir, IS_WIN ? 'cargo.exe' : 'cargo');
  return isFile(candidate) ? { file: candidate, onPath: false } : { file: null, onPath: false };
}

/**
 * @typedef {object} GateStep
 * @property {string} id
 * @property {string} label         运行记录里写的命令
 * @property {string | string[]} cmd 字符串经 shell 执行，数组直接执行
 * @property {string} [cwd]         缺省在仓库根目录执行
 * @property {boolean} [shell]
 * @property {'default' | 'full'} group
 * @property {boolean} [sandbox]    为真时在临时的 GUANLAN_DATA_DIR 下跑
 * @property {boolean} [skipLog]    为真时让 Rust 测试把提前返回（跳过）的测试记到沙箱目录下的一个文件
 * @property {'rust' | 'node'} [tests] 按哪种格式从输出里统计测试数
 * @property {(output: string) => boolean} [retryOn] 失败输出命中时重试一次
 */

/**
 * 步骤清单。每一步的含义见 GateStep。
 * cargoFile 是 cargo 的路径，找不到时传 null。
 */
export function buildSteps(cargoFile) {
  const npmScript = (script) => (script === 'test' ? 'npm test' : `npm run ${script}`);
  const cargoStep = (id, group, args, extra = {}) => ({
    id,
    group,
    cmd: [cargoFile ?? 'cargo', ...args],
    cwd: NATIVE,
    shell: false,
    sandbox: true,
    label: `cargo ${args.join(' ')}`,
    ...extra,
  });
  // 运行时用绝对路径，运行记录里写相对仓库的路径：记录是要贴进提交说明的，不该带着本机目录
  const releaseExe = path.join(REPO, ...RELEASE_EXE_REL.split('/'));
  const tsScriptStep = (id, script, scriptArgs, displayArgs) => ({
    id,
    group: 'full',
    cmd: [process.execPath, TSX_CLI, `scripts/${script}.ts`, ...scriptArgs],
    shell: false,
    sandbox: true,
    tests: 'node',
    label: `npx tsx scripts/${script}.ts ${displayArgs.join(' ')}`,
  });
  return /** @type {GateStep[]} */ ([
    { id: 'web:lint', group: 'default', cmd: npmScript('lint'), shell: true, label: 'npm run lint' },
    { id: 'web:test', group: 'default', cmd: npmScript('test'), shell: true, label: 'npm test', tests: 'node' },
    {
      id: 'web:build',
      group: 'default',
      cmd: npmScript('build'),
      shell: true,
      label: 'npm run build',
      retryOn: isKnownBuildFlake,
    },
    {
      id: 'packaging:installer-config',
      group: 'default',
      cmd: [process.execPath, 'scripts/build-windows-installer.mjs', '--check-only'],
      shell: false,
      label: 'node scripts/build-windows-installer.mjs --check-only',
    },
    cargoStep('rust:fmt', 'default', ['fmt', '--all', '--', '--check']),
    cargoStep('rust:clippy', 'default', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']),
    cargoStep('rust:test', 'default', ['test', '--workspace', '--locked'], { tests: 'rust', skipLog: true }),
    cargoStep('rust:build-release', 'full', ['build', '--release', '--locked', '-p', 'guanlan-service']),
    { id: 'fixture:seed', group: 'full', cmd: npmScript('seed'), shell: true, label: 'npm run seed' },
    tsScriptStep('smoke:v1', 'smoke-v1', ['--exe', releaseExe], ['--exe', RELEASE_EXE_REL]),
    tsScriptStep('parity:node-rust', 'parity-reconcile', ['--exe', releaseExe], ['--exe', RELEASE_EXE_REL]),
  ]);
}

/** 取一条命令的输出：字符串时经 shell 执行，数组时直接执行、不经 shell。失败返回空串。 */
function capture(cmd, cwd) {
  const out = Array.isArray(cmd)
    ? spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8' })
    : spawnSync(cmd, { cwd, encoding: 'utf8', shell: true });
  return out.status === 0 ? (out.stdout ?? '').trim() : '';
}

/** 输出原样转给终端，同时留下末尾一段用于统计测试数。 */
function runOnce(step, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    // spawn(command, args, options)：数组形式的命令要拆成可执行文件与参数两部分。
    const command = Array.isArray(step.cmd) ? step.cmd[0] : step.cmd;
    const args = Array.isArray(step.cmd) ? step.cmd.slice(1) : [];
    const child = spawn(command, args, {
      cwd: step.cwd ?? REPO,
      env,
      shell: step.shell,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let tail = '';
    const collect = (stream, chunk) => {
      const text = chunk.toString();
      stream.write(text);
      tail = (tail + text).slice(-TAIL_CHARS);
    };
    child.stdout.on('data', (chunk) => collect(process.stdout, chunk));
    child.stderr.on('data', (chunk) => collect(process.stderr, chunk));
    child.on('error', (error) => {
      const line = `gate: 无法启动 ${step.label}：${error.message}\n`;
      process.stderr.write(line);
      tail += line;
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? 1, signal, secs: (Date.now() - started) / 1000, output: tail });
    });
  });
}

async function runStep(step, env) {
  const first = await runOnce(step, env);
  if (first.code === 0 || !step.retryOn || !step.retryOn(first.output)) return first;
  process.stdout.write(`\ngate: ${step.label} 遇到已知的偶发失败（@tailwindcss/oxide 冷启动 panic），重试一次。\n\n`);
  return { ...(await runOnce(step, env)), retried: true };
}

// Windows 上 SQLite 句柄在进程退出后可能晚一点才释放，删不干净就稍后再试几次。
async function removeDir(dir) {
  for (let attempt = 0; attempt < 5 && fs.existsSync(dir); attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return !fs.existsSync(dir);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const unknownArgs = argv.filter((arg) => arg !== '--full');
  if (unknownArgs.length > 0) {
    console.error(`gate: 无法识别的参数：${unknownArgs.join(' ')}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const full = argv.includes('--full');

  const cargo = findCargo();
  const head = capture('git rev-parse --short HEAD', REPO);
  const dirty = capture('git status --porcelain', REPO).length > 0;
  // 在 native/ 下执行，报出来的才是 rust-toolchain.toml 锁定的那个版本。
  const rustcBin = cargo.file ? path.join(path.dirname(cargo.file), IS_WIN ? 'rustc.exe' : 'rustc') : null;
  const toolchain =
    cargo.file === null
      ? ''
      : (rustcBin && isFile(rustcBin) ? capture([rustcBin, '--version'], NATIVE) : capture([cargo.file, '--version'], NATIVE));
  const steps = buildSteps(cargo.file);
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-gate-'));
  // 兜底：无论脚本怎么退出（包括中途抛异常），退出时都试着删掉临时目录。
  process.on('exit', () => {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // 句柄还没释放，删不掉：结尾处会提示手动删除
    }
  });

  console.log('观澜统一门禁');
  console.log(`  HEAD：${head || '未知'}${dirty ? '（工作区有未提交的改动）' : ''}`);
  console.log(`  Node：${process.version}`);
  if (cargo.file) {
    const where = cargo.onPath ? '' : `（不在 PATH 上，取自 ${cargo.file}）`;
    console.log(`  工具链：${toolchain || '已找到 cargo'}${where}`);
  } else {
    console.log('  工具链：找不到 cargo（$CARGO_HOME/bin 与 ~/.cargo/bin 里都没有）');
  }
  console.log(`  范围：${full ? '全量，含 release 构建、冒烟与对拍' : '默认，对应 CI 的 frontend 与 rust-desktop 作业'}`);
  console.log(`  Rust 步骤的数据目录：${sandboxDir}`);
  console.log('');

  // Rust 测试把提前返回（跳过）的测试记在这里，见文件头
  const skipLogFile = path.join(sandboxDir, 'test-skips.log');
  const envFor = (step) => envForStep(step, { cargoFile: cargo.file, sandboxDir, skipLogFile });

  const planned = steps.filter((step) => step.group === 'default' || full);
  const done = [];
  const notRun = [];
  let halted = false;
  for (const step of planned) {
    if (halted) {
      notRun.push(step.label);
      continue;
    }
    console.log(`▶ ${step.label}`);
    let result;
    if (cargo.file === null && step.label.startsWith('cargo ')) {
      const line = 'gate: 找不到 cargo，无法执行这一步。\n';
      process.stderr.write(line);
      result = { code: 1, signal: null, secs: 0, output: line, missingCargo: true };
    } else {
      result = await runStep(step, envFor(step));
      if (step.skipLog && fs.existsSync(skipLogFile)) {
        result.skipped = fs
          .readFileSync(skipLogFile, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        // 先把每条的原因打全，运行记录里只放得下测试名
        for (const line of result.skipped) process.stdout.write(`  跳过的测试：${line}\n`);
      }
    }
    const verdict = describeResult(result, step);
    done.push({ step, result, verdict });
    if (!verdict.ok) halted = true;
    console.log('');
  }
  const sandboxRemoved = await removeDir(sandboxDir);

  const failed = done.filter((entry) => !entry.verdict.ok);
  console.log('────────────────────────────────────────────────────────────');
  for (const { step, result, verdict } of done) {
    console.log(`  ${verdict.ok ? '通过  ' : '未通过'}  ${step.label.padEnd(50)} ${result.secs.toFixed(1).padStart(7)}s`);
  }
  for (const label of notRun) console.log(`  未跑    ${label}`);
  console.log('────────────────────────────────────────────────────────────');
  if (failed.length > 0) console.log(`门禁未通过：${failed.map((entry) => entry.step.label).join('；')}。`);
  else console.log(notRun.length > 0 ? '门禁通过（已跑的步骤都通过）。' : '门禁通过。');
  if (!sandboxRemoved) console.log(`gate: 临时数据目录没删干净，可以手动删除：${sandboxDir}`);
  console.log('');
  console.log('运行记录（可以贴进提交正文的「运行」一节）：');
  console.log('```');
  const conditions = [
    recordCommand(full),
    head ? `HEAD ${head}${dirty ? ' 加未提交的改动' : ''}` : null,
    `Node ${process.version}`,
    toolchain ? toolchain.replace(/ \(.*/, '') : null,
    cargo.file ? 'cargo 在 native/ 下执行' : '找不到 cargo，Rust 步骤没有执行',
    'Rust 步骤的 GUANLAN_DATA_DIR 指向临时目录',
  ].filter(Boolean);
  console.log(`运行（${conditions.join('，')}）：`);
  for (const { step, verdict } of done) console.log(`- ${step.label}：${verdict.text}。`);
  const notSelected = full
    ? []
    : steps.filter((step) => step.group !== 'default').map((step) => `${step.label}（加 --full 运行）`);
  const missing = [
    ...notRun.map((label) => `${label}（前一步失败后停止）`),
    ...notSelected,
  ];
  if (missing.length > 0) console.log(`未跑：${missing.join('；')}。`);
  console.log('```');
  process.exitCode = failed.length > 0 ? 1 : 0;
}

// 只有被直接执行时才跑门禁；被测试文件导入时不跑。
const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT);
if (invokedDirectly) {
  await main();
}
