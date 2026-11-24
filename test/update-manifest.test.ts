/**
 * 更新清单 latest.json 的形状与校验，外加构建脚本的演练开关。
 *
 * 清单格式来自 Tauri v2 的静态清单：version / platforms 必填，notes / pub_date 可选；
 * windows 平台的 signature 是 .sig 文件原文，url 指向安装包。这里的校验比插件更严：
 * http 只允许回环地址，避免把明文下载地址写进真实发布清单。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUpdateManifest, generateFromFiles, parseArgs } from '../scripts/gen-update-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const script = resolve(repo, 'scripts', 'gen-update-manifest.mjs');
const SIGNATURE = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRoZSB0ZXN0';

describe('更新清单：形状', () => {
  it('windows-x86_64 平台带签名原文与下载地址，版本与发布时间齐全', () => {
    const manifest = buildUpdateManifest({
      version: '1.2.1',
      signature: `  ${SIGNATURE}\n`,
      url: 'https://example.com/Guanlan_1.2.1_x64-setup.exe',
      notes: '  修好了两处问题  ',
      pubDate: '2026-11-24T00:00:00.000Z',
    });
    assert.equal(manifest.version, '1.2.1');
    assert.equal(manifest.notes, '修好了两处问题');
    assert.equal(manifest.pub_date, '2026-11-24T00:00:00.000Z');
    assert.deepEqual(manifest.platforms['windows-x86_64'], {
      signature: SIGNATURE,
      url: 'https://example.com/Guanlan_1.2.1_x64-setup.exe',
    });
  });

  it('没给说明时不含 notes；发布时间默认取当前时间', () => {
    const before = Date.now();
    const manifest = buildUpdateManifest({ version: '1.2.1', signature: SIGNATURE, url: 'https://example.com/x.exe' });
    assert.equal('notes' in manifest, false);
    const published = Date.parse(manifest.pub_date);
    assert.ok(published >= before - 1000 && published <= Date.now() + 1000, manifest.pub_date);
  });

  it('平台键默认 windows-x86_64，也可以显式给', () => {
    const manifest = buildUpdateManifest({
      version: '1.2.1',
      signature: SIGNATURE,
      url: 'https://example.com/x.exe',
      platform: 'windows-aarch64',
    });
    assert.deepEqual(Object.keys(manifest.platforms), ['windows-aarch64']);
  });
});

describe('更新清单：校验', () => {
  it('版本必须是三段式 SemVer，带 v 前缀或段数不对都拒绝', () => {
    for (const version of ['1.2', 'v1.2.1', '1.2.1-beta', '', '01.2.1']) {
      assert.throws(
        () => buildUpdateManifest({ version, signature: SIGNATURE, url: 'https://example.com/x.exe' }),
        /三段式 SemVer/,
        version,
      );
    }
  });

  it('签名不能为空，也不能只有空白', () => {
    for (const signature of ['', '   \n']) {
      assert.throws(
        () => buildUpdateManifest({ version: '1.2.1', signature, url: 'https://example.com/x.exe' }),
        /签名内容为空/,
      );
    }
  });

  it('下载地址必须能解析，且只接受 https 或回环 http', () => {
    const base = { version: '1.2.1', signature: SIGNATURE };
    assert.throws(() => buildUpdateManifest({ ...base, url: 'not a url' }), /不是合法的 URL/);
    assert.throws(() => buildUpdateManifest({ ...base, url: 'ftp://example.com/x.exe' }), /只支持 https 或回环 http/);
    assert.throws(() => buildUpdateManifest({ ...base, url: 'http://example.com/x.exe' }), /只允许回环地址/);
    for (const url of ['http://127.0.0.1:8788/x.exe', 'http://localhost:8788/x.exe', 'https://example.com/x.exe']) {
      const manifest = buildUpdateManifest({ ...base, url });
      assert.equal(manifest.platforms['windows-x86_64'].url, url);
    }
  });

  it('平台键要像 OS-ARCH', () => {
    assert.throws(
      () => buildUpdateManifest({ version: '1.2.1', signature: SIGNATURE, url: 'https://example.com/x.exe', platform: 'windows x64' }),
      /平台键不合法/,
    );
  });
});

describe('更新清单：命令行', () => {
  it('--help 打印用法；缺参数与未知参数分别报错', () => {
    assert.equal(parseArgs(['--help']).help, true);
    assert.match(String(parseArgs(['--version', '1.2.1']).error), /缺少 --signature-file/);
    assert.match(String(parseArgs(['--bogus', 'x']).error), /无法识别的参数/);
    assert.match(String(parseArgs(['--version', '--out']).error), /--version 后面要跟一个值/);
  });

  it('由 .sig 与说明文件生成清单，CLI 退出 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guanlan-manifest-'));
    try {
      writeFileSync(join(dir, 'setup.exe.sig'), `${SIGNATURE}\n`);
      writeFileSync(join(dir, 'notes.md'), '更新说明\n');
      const out = join(dir, 'latest.json');
      const result = spawnSync(
        process.execPath,
        [script, '--version', '1.2.1', '--signature-file', join(dir, 'setup.exe.sig'), '--url', 'http://127.0.0.1:8788/Guanlan_1.2.1_x64-setup.exe', '--notes-file', join(dir, 'notes.md'), '--out', out],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(manifest.version, '1.2.1');
      assert.equal(manifest.notes, '更新说明');
      assert.equal(manifest.platforms['windows-x86_64'].signature, SIGNATURE);
      assert.match(result.stdout, /已写出/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('签名文件不存在时退出 1，参数不对时退出 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guanlan-manifest-'));
    try {
      const missing = spawnSync(
        process.execPath,
        [script, '--version', '1.2.1', '--signature-file', join(dir, 'nope.sig'), '--url', 'https://example.com/x.exe', '--out', join(dir, 'latest.json')],
        { encoding: 'utf8' },
      );
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /update-manifest:/);
      const badArgs = spawnSync(process.execPath, [script, '--version', '1.2.1'], { encoding: 'utf8' });
      assert.equal(badArgs.status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('构建脚本的演练开关只接受 https 或回环 http，并且要求签名私钥', () => {
    const buildScript = readFileSync(resolve(repo, 'scripts', 'build-windows-installer.mjs'), 'utf8');
    assert.ok(buildScript.includes('--updater-test-endpoint'));
    assert.ok(buildScript.includes('dangerousInsecureTransportProtocol'));
    assert.ok(buildScript.includes('createUpdaterArtifacts'));
    assert.ok(buildScript.includes('TAURI_SIGNING_PRIVATE_KEY'));
  });
});
