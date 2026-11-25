import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 独立开源仓根目录即本仓根（历史 monorepo 布局下曾是 guanlan/ 的父目录）
const repoRoot = resolve(__dirname, '..');
const guanlanDir = repoRoot;

describe('Windows MSI/NSIS 安装包工程化、右键菜单与迁移备份契约', () => {
  it('build-windows-installer.mjs --check-only 完整校验通过', () => {
    const out = execFileSync(
      process.execPath,
      [resolve(guanlanDir, 'scripts/build-windows-installer.mjs'), '--check-only'],
      { encoding: 'utf8' }
    );
    assert.ok(out.includes('配置核验通过'));
    assert.ok(out.includes('nsis+msi'));
    assert.ok(out.includes('binaries/guanlan'));
  });

  it('tauri.conf.json 配置 MSI+NSIS、LZMA 精简压缩、中文语言包与右键菜单钩子', () => {
    const conf = JSON.parse(
      readFileSync(resolve(guanlanDir, 'native/crates/guanlan-desktop/tauri.conf.json'), 'utf8')
    );
    const pkg = JSON.parse(readFileSync(resolve(guanlanDir, 'package.json'), 'utf8'));
    assert.match(conf.version, /^\d+\.\d+\.\d+$/);
    assert.equal(conf.version, pkg.version);
    assert.deepEqual(conf.bundle.targets, ['nsis', 'msi']);
    assert.equal(conf.bundle.windows.nsis.compression, 'lzma');
    assert.equal(conf.bundle.windows.nsis.installMode, 'currentUser');
    assert.equal(
      conf.bundle.windows.nsis.installerHooks,
      './installer/windows-context-menu.nsh'
    );
  });

  it('CI 工作流已纳入 Windows 安装包配置门禁', () => {
    const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(ci.includes('build-windows-installer.mjs --check-only'));
  });
});
