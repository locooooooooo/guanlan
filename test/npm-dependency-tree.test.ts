import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');

describe('npm 依赖树', () => {
  it('没有被 npm 判为无效或缺失的依赖——CI 的 Node 22 自带 npm 10，它的 npm ci 遇到无效的同伴依赖会直接失败', () => {
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
