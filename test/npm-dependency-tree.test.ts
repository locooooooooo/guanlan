/**
 * npm 依赖树的守卫。
 *
 * CI 用 Node 22，自带的 npm 10 对无效的同伴依赖零容忍：`npm ci` 直接以 ERESOLVE 退出。npm 11
 * （Node 24）会放行，所以在本机通过不代表 CI 能过。仓库里曾有一个没人用的 `esbuild ^0.25`
 * 顶层钉子，与 vite 8 和 tsx 需要的 0.28 冲突：Node 24 下 `npm ci` 能过，Node 22 下第一步就失败。
 *
 * `npm ls` 不联网，只读 node_modules 与锁文件；它只有在无效、缺失这类真问题时才以非零退出，
 * 其他平台的可选依赖没有安装不算。node_modules 与锁文件不同步（比如本地多装了包）时这里也会红，
 * 那是应该的：先在仓库根目录执行 npm ci。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');

describe('npm 依赖树', () => {
  it('没有被 npm 判为无效或缺失的依赖——CI 的 Node 22 自带 npm 10，它的 npm ci 遇到无效的同伴依赖会直接失败', () => {
    // 经 shell 执行：Windows 上 npm 是 npm.cmd，不能直接 spawn
    const out = spawnSync('npm ls --all', { cwd: repo, encoding: 'utf8', shell: true, timeout: 120_000 });
    assert.ifError(out.error);
    const text = `${out.stdout}${out.stderr}`;
    const problems = text
      .split('\n')
      .filter((line) => /\binvalid\b|\bmissing\b|ERESOLVE/.test(line))
      .map((line) => line.trim());
    assert.deepEqual(problems.slice(0, 5), [], 'npm 认为下面的依赖无效或缺失');
    assert.equal(
      out.status,
      0,
      `npm ls 以 ${out.status} 退出。node_modules 与锁文件不同步时先执行 npm ci；其余输出：\n${text.split('\n').slice(-12).join('\n')}`,
    );
  });
});
