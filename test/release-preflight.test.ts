import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkAssets,
  collectVersions,
  expectedAssetNames,
  parseArgs,
} from '../scripts/release-preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const preflightScript = resolve(__dirname, '..', 'scripts', 'release-preflight.mjs');

describe('发版预检：版本号收集', () => {
  it('仓库里每一处版本号都一致——升版本时漏改任何一处，这里都会红', () => {
    const { version, sources } = collectVersions();
    assert.match(version, /^\d+\.\d+\.\d+$/);
    // 两份锁文件、三处清单、构建身份的兜底值，以及断言版本的测试与脚本里的字面量
    assert.ok(sources.length >= 15, `只收集到 ${sources.length} 处版本号，少于预期`);
    assert.deepEqual(
      sources.filter((source) => source.version !== version).map((source) => source.where),
      [],
    );
  });

  it('收集范围包含此前没有测试守着的那几处', () => {
    const where = collectVersions().sources.map((source) => source.where);
    for (const expected of [
      'package-lock.json',
      'native/Cargo.lock guanlan-core',
      'native/Cargo.lock guanlan-service',
      'native/Cargo.lock guanlan-desktop',
      'src/utils/appBuildInfo.ts',
    ]) {
      assert.ok(where.includes(expected), `缺少 ${expected}`);
    }
  });
});

describe('发版预检：产物文件名', () => {
  it('与 release.yml 暂存产物时用的名字一致', () => {
    assert.deepEqual(expectedAssetNames('1.2.0'), [
      'Guanlan_1.2.0_x64-setup.exe',
      'Guanlan_1.2.0_x64_zh-CN.msi',
      'guanlan-cli-1.2.0-x86_64-pc-windows-msvc.exe',
    ]);
  });
});

describe('发版预检：产物目录核对', () => {
  const makeAssets = () => {
    const dir = mkdtempSync(join(tmpdir(), 'guanlan-pf-test-'));
    for (const name of expectedAssetNames('1.2.0')) writeFileSync(join(dir, name), `bytes of ${name}`);
    return dir;
  };
  const writeSums = (dir: string) => {
    const lines = expectedAssetNames('1.2.0').map((name) => {
      const hash = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
      return `${hash}  ${name}`;
    });
    writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  };
  const withAssets = (run: (dir: string) => void) => {
    const dir = makeAssets();
    try {
      writeSums(dir);
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('文件齐、校验和一致时没有问题', () => {
    withAssets((dir) => {
      const result = checkAssets(dir, '1.2.0');
      assert.deepEqual(result.problems, []);
      assert.equal(result.passed.length, 4);
    });
  });

  it('文件在校验和写好之后被改过', () => {
    withAssets((dir) => {
      const target = join(dir, 'Guanlan_1.2.0_x64-setup.exe');
      writeFileSync(target, `${readFileSync(target, 'utf8')}plus one more byte`);
      assert.deepEqual(checkAssets(dir, '1.2.0').problems, ['Guanlan_1.2.0_x64-setup.exe：SHA-256 与 SHA256SUMS 不一致']);
    });
  });

  it('缺一个安装包', () => {
    withAssets((dir) => {
      rmSync(join(dir, 'Guanlan_1.2.0_x64_zh-CN.msi'));
      assert.deepEqual(checkAssets(dir, '1.2.0').problems, [
        '缺少产物：Guanlan_1.2.0_x64_zh-CN.msi',
        'SHA256SUMS 列出了不存在的文件：Guanlan_1.2.0_x64_zh-CN.msi',
      ]);
    });
  });

  it('空文件、多余的文件、没有 SHA256SUMS、目录不存在', () => {
    withAssets((dir) => {
      const cli = join(dir, 'guanlan-cli-1.2.0-x86_64-pc-windows-msvc.exe');
      writeFileSync(cli, '');
      assert.ok(checkAssets(dir, '1.2.0').problems.includes('guanlan-cli-1.2.0-x86_64-pc-windows-msvc.exe 是空文件'));
    });
    withAssets((dir) => {
      writeFileSync(join(dir, 'README.txt'), 'stray');
      assert.ok(checkAssets(dir, '1.2.0').problems.includes('多出未预期的文件：README.txt'));
    });
    withAssets((dir) => {
      rmSync(join(dir, 'SHA256SUMS'));
      assert.ok(checkAssets(dir, '1.2.0').problems.includes('缺少 SHA256SUMS'));
    });
    assert.deepEqual(checkAssets(join(tmpdir(), 'guanlan-pf-dir-that-does-not-exist'), '1.2.0').problems, [
      `产物目录不存在：${join(tmpdir(), 'guanlan-pf-dir-that-does-not-exist')}`,
    ]);
  });

  it('版本号对不上时，产物的文件名就对不上——不会拿别的版本的包充数', () => {
    withAssets((dir) => {
      const problems = checkAssets(dir, '9.9.9').problems;
      assert.equal(problems.filter((line) => line.startsWith('缺少产物：')).length, 3);
      assert.equal(problems.filter((line) => line.startsWith('多出未预期的文件：')).length, 3);
    });
  });
});

describe('发版预检：参数与命令行入口', () => {
  it('解析标签、是否要求在 main 上、产物目录', () => {
    assert.deepEqual(parseArgs([]), { tag: null, requireOnMain: false, assets: null });
    assert.deepEqual(parseArgs(['--tag', 'v1.2.0', '--require-on-main', '--assets', 'dist-release']), {
      tag: 'v1.2.0',
      requireOnMain: true,
      assets: 'dist-release',
    });
  });

  it('未识别的参数、缺值的参数都报错，而不是被悄悄忽略', () => {
    assert.throws(() => parseArgs(['--force']), /无法识别的参数：--force/);
    assert.throws(() => parseArgs(['--tag']), /--tag 后面要跟一个值/);
    assert.throws(() => parseArgs(['--assets', '--tag', 'v1.2.0']), /--assets 后面要跟一个值/);
  });

  it('只查版本号：当前仓库通过，退出 0', () => {
    const out = execFileSync(process.execPath, [preflightScript], { encoding: 'utf8' });
    assert.match(out, /发版预检通过/);
  });

  it('参数不合法时退出 2', () => {
    const out = spawnSync(process.execPath, [preflightScript, '--tag'], { encoding: 'utf8' });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /--tag 后面要跟一个值/);
  });
});
