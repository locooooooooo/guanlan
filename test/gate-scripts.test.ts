import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildSteps,
  countNodeTests,
  countRustTests,
  describeResult,
  isKnownBuildFlake,
} from '../scripts/gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gateScript = resolve(__dirname, '..', 'scripts', 'gate.mjs');
const REPO_ROOT = resolve(__dirname, '..');

// 基线跑门禁时 npm run build 真实输出过的那次崩溃（@tailwindcss/oxide 4.3.4），逐字取自日志
const REAL_OXIDE_PANIC = [
  "thread '<unnamed>' (31400) panicked at crates\\oxide\\src\\extractor\\boundary.rs:21:13:",
  'index out of bounds: the len is 0 but the index is 3',
].join('\n');

describe('统一门禁脚本：已知偶发失败的判定', () => {
  it('只有 @tailwindcss/oxide 提取器的 panic 才算已知偶发失败（路径用反斜杠或正斜杠都认）', () => {
    assert.equal(isKnownBuildFlake(REAL_OXIDE_PANIC), true);
    assert.equal(isKnownBuildFlake(REAL_OXIDE_PANIC.replace(/\\/g, '/')), true);
  });

  it('别的失败不重试：TypeScript 报错、别处的 panic、带 ANSI 颜色码的正常输出', () => {
    assert.equal(isKnownBuildFlake('src/x.ts(1,15): error TS1110: Type expected.'), false);
    assert.equal(isKnownBuildFlake("thread 'main' panicked at src/main.rs:2:3: index out of bounds"), false);
    assert.equal(isKnownBuildFlake('\u001b[32m✓ built in 3.27s\u001b[39m'), false);
    // 只提到 oxide 目录但没有 panic，不算
    assert.equal(isKnownBuildFlake('Compiling crates/oxide/src/extractor/boundary.rs'), false);
  });
});

describe('统一门禁脚本：从输出里统计测试数', () => {
  it('libtest：多段 test result 累加，通过与失败分开计', () => {
    const output = [
      'test result: ok. 238 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 31.42s',
      'test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.50s',
      'test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.49s',
    ].join('\n');
    assert.deepEqual(countRustTests(output), { passed: 257, failed: 2, suites: 3 });
  });

  it('libtest：一段结果都没有时 suites 为 0，防止命令没跑到测试却被当成通过', () => {
    assert.deepEqual(countRustTests('    Finished `test` profile\n'), { passed: 0, failed: 0, suites: 0 });
  });

  it('node:test：取最后一组 pass / fail，带不带颜色码都认', () => {
    // 测试文件由子进程跑时，输出里会先出现子进程的汇总、再出现父进程的汇总，数目不同
    const twoSummaries = [
      'ℹ tests 5\nℹ pass 5\nℹ fail 0\n',
      'ℹ tests 901\nℹ pass 901\nℹ fail 0\n',
    ].join('\n');
    assert.deepEqual(countNodeTests(twoSummaries), { passed: 901, failed: 0, suites: 1 });
    const colored = '\u001b[32mℹ pass 884\u001b[39m\n\u001b[32mℹ fail 0\u001b[39m\n';
    assert.deepEqual(countNodeTests(colored), { passed: 884, failed: 0, suites: 1 });
    assert.deepEqual(countNodeTests('ℹ pass 4\nℹ fail 3\n'), { passed: 4, failed: 3, suites: 1 });
    assert.deepEqual(countNodeTests('no summary here'), { passed: 0, failed: 0, suites: 0 });
  });
});

describe('统一门禁脚本：一步结果的描述', () => {
  const step = { label: 'cargo test --workspace --locked', tests: 'rust' };

  it('通过时写明测试数', () => {
    const verdict = describeResult({ code: 0, output: 'test result: ok. 5 passed; 0 failed; 0 ignored;' }, step);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.text, '通过，5 通过 / 0 失败');
  });

  it('失败时写明退出码，不写成通过', () => {
    const verdict = describeResult({ code: 101, output: 'test result: FAILED. 4 passed; 1 failed; 0 ignored;' }, step);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.text, '未通过（退出码 101），4 通过 / 1 失败');
  });

  it('找不到 cargo 时直说，不只给一个退出码', () => {
    const verdict = describeResult({ code: 1, output: '', missingCargo: true }, { label: 'cargo fmt', tests: undefined });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.text, '未通过（找不到 cargo）');
  });

  it('重试过、或输出里有 [skip]，都要注明；没解析到测试数也要注明', () => {
    const retried = describeResult({ code: 0, output: '✓ built', retried: true }, { label: 'npm run build', tests: undefined });
    assert.equal(retried.text, '通过。重试过一次');
    const skipped = describeResult({ code: 0, output: '[skip] 身份数字向量夹具不存在\ntest result: ok. 1 passed; 0 failed;' }, step);
    assert.match(skipped.text, /输出里有 \[skip\]/);
    const unparsed = describeResult({ code: 0, output: '    Finished' }, step);
    assert.match(unparsed.text, /没有解析到测试数/);
  });
});

describe('统一门禁脚本：步骤清单', () => {
  it('默认七步对应 CI 的 frontend 与 rust-desktop 作业，顺序固定；其余四步只在 --full 时跑', () => {
    const steps = buildSteps('cargo');
    assert.deepEqual(
      steps.map((step) => `${step.group}:${step.label}`),
      [
        'default:npm run lint',
        'default:npm test',
        'default:npm run build',
        'default:node scripts/build-windows-installer.mjs --check-only',
        'default:cargo fmt --all -- --check',
        'default:cargo clippy --workspace --all-targets -- -D warnings',
        'default:cargo test --workspace --locked',
        'full:cargo build --release --locked -p guanlan-service',
        'full:npm run seed',
        'full:npx tsx scripts/smoke-v1.ts --exe native/target/release/guanlan.exe',
        'full:npx tsx scripts/parity-reconcile.ts --exe native/target/release/guanlan.exe',
      ],
    );
  });

  it('cargo 步骤都在 native/ 下执行并使用临时的数据目录；前端步骤与 CI 一样不设数据目录', () => {
    for (const step of buildSteps('cargo').filter((entry) => entry.label.startsWith('cargo '))) {
      assert.equal(step.cwd, resolve(__dirname, '..', 'native'), step.label);
      assert.equal(step.sandbox, true, step.label);
      assert.equal(step.shell, false, step.label);
    }
    const web = buildSteps('cargo').filter((entry) => entry.group === 'default' && !entry.label.startsWith('cargo '));
    assert.equal(web.length, 4);
    for (const step of web) assert.equal(step.sandbox, undefined, step.label);
  });

  it('运行记录里 --full 步骤的 exe 写成相对仓库的路径，不带着本机目录', () => {
    for (const step of buildSteps('cargo').filter((entry) => entry.label.includes('--exe'))) {
      assert.match(step.label, /--exe native\/target\/release\/guanlan\.exe$/);
      assert.equal(step.label.includes(REPO_ROOT), false);
      // 实际执行的命令用的仍是能直接传给子进程的绝对路径
      const exe = Array.isArray(step.cmd) ? step.cmd.at(-1) : undefined;
      assert.ok(typeof exe === 'string' && exe.endsWith('guanlan.exe') && isAbsolute(exe), step.label);
    }
  });
});

describe('统一门禁脚本：命令行入口', () => {
  it('--help 退出 0 并打印用法', () => {
    const out = spawnSync(process.execPath, [gateScript, '--help'], { encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /观澜统一门禁/);
  });

  it('未识别的参数退出 2', () => {
    const out = spawnSync(process.execPath, [gateScript, '--bogus'], { encoding: 'utf8' });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /无法识别的参数：--bogus/);
  });

  it('被导入时不执行门禁、不打印开场信息（否则测试一导入就跑完整套检查）', () => {
    // 子进程带着 --help 去导入模块：守卫若失效，导入时就会把用法打出来。
    // Windows 下动态 import 一个绝对路径要用 file:// 形式。
    const script = `import(${JSON.stringify(pathToFileURL(gateScript).href)}).then(() => console.log('imported'));`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', '--help'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'imported');
  });
});
