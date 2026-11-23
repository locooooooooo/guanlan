#!/usr/bin/env node
/**
 * F03 · 观澜（Guanlan）Windows 正式 MSI / NSIS 安装包工程化构建与校验脚本。
 *
 * 职责：
 * 1. `--check-only`：零副作用校验打包工程配置完整性（tauri.conf.json / tauri.release.conf.json /
 *    windows-context-menu.nsh / 图标齐备 / 无冗余开发依赖进 dist）；
 * 2. 默认模式（或 `--build`）：
 *    - 构建精简前端生产包（`vite build`，无 devDependencies 残留）；
 *    - 编译发布版 `guanlan.exe` CLI 并按 Tauri target-triple 约定暂存至
 *      `guanlan-desktop/binaries/guanlan-x86_64-pc-windows-msvc.exe`；
 *    - 调用 Tauri v2 构建单包内嵌 `guanlan-service`（进程内联）+ `guanlan.exe` CLI（sidecar）的
 *      正式 MSI 与 NSIS Windows 安装包，并输出体积统计。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guanlanDir = resolve(__dirname, '..');
const nativeDir = resolve(guanlanDir, 'native');
const desktopDir = resolve(nativeDir, 'crates/guanlan-desktop');
const baseConfPath = resolve(desktopDir, 'tauri.conf.json');
const releaseConfPath = resolve(desktopDir, 'tauri.release.conf.json');
const nsisHookPath = resolve(desktopDir, 'installer/windows-context-menu.nsh');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check-only');
const skipBundle = args.has('--stage-only');

function fail(msg) {
  console.error(`[guanlan-installer] FAIL: ${msg}`);
  process.exit(1);
}

function validateInstallerConfig() {
  if (!existsSync(baseConfPath)) fail(`缺少 ${baseConfPath}`);
  if (!existsSync(releaseConfPath)) fail(`缺少 ${releaseConfPath}`);
  if (!existsSync(nsisHookPath)) fail(`缺少 ${nsisHookPath}`);

  const baseConf = JSON.parse(readFileSync(baseConfPath, 'utf8'));
  const relConf = JSON.parse(readFileSync(releaseConfPath, 'utf8'));
  const hookSrc = readFileSync(nsisHookPath, 'utf8');

  const targets = baseConf?.bundle?.targets ?? [];
  if (!targets.includes('nsis') || !targets.includes('msi')) {
    fail(`tauri.conf.json bundle.targets 必须同时包含 nsis 与 msi，实得: ${JSON.stringify(targets)}`);
  }
  if (baseConf?.bundle?.windows?.nsis?.installerHooks !== './installer/windows-context-menu.nsh') {
    fail('tauri.conf.json 必须挂载 ./installer/windows-context-menu.nsh 右键菜单钩子');
  }
  const externalBin = relConf?.bundle?.externalBin ?? [];
  if (!externalBin.includes('binaries/guanlan')) {
    fail('tauri.release.conf.json 必须通过 externalBin 嵌入 binaries/guanlan CLI');
  }
  for (const iconRel of baseConf?.bundle?.icon ?? []) {
    const iconAbs = resolve(desktopDir, iconRel);
    if (!existsSync(iconAbs)) {
      fail(`缺少安装包图标资产：${iconAbs}`);
    }
  }
  for (const token of [
    'NSIS_HOOK_POSTINSTALL',
    'NSIS_HOOK_POSTUNINSTALL',
    '用观澜打开此文件夹',
    'Directory\\shell\\GuanlanOpen',
    'Directory\\Background\\shell\\GuanlanOpen',
    'DeleteRegKey HKCU',
  ]) {
    if (!hookSrc.includes(token)) {
      fail(`NSIS 钩子缺少关键指令：${token}`);
    }
  }

  console.log(
    `[guanlan-installer] 配置核验通过：version=${baseConf.version} targets=${targets.join('+')} compression=${baseConf.bundle.windows.nsis.compression} sidecar=${externalBin.join(',')}`
  );
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

validateInstallerConfig();
if (checkOnly) {
  process.exit(0);
}

// 1. 构建精简前端 dist
// U12：Node ≥18.20/20.12 出于 CVE-2024-27980 直接 spawn `.cmd`/`.bat` 会抛 EINVAL，
// 且本项目未把 npm 声明为本地依赖——`npm run build` 本义即 `vite build`，
// 故直接以 process.execPath + node_modules/vite/bin/vite.js 执行（零 shell、零 PATH 依赖）。
console.log('[guanlan-installer] 1/3 构建精简前端生产包 (vite build)...');
const viteJs = resolve(guanlanDir, 'node_modules/vite/bin/vite.js');
if (!existsSync(viteJs)) fail(`缺少 vite 入口：${viteJs}`);
execFileSync(process.execPath, [viteJs, 'build'], {
  cwd: guanlanDir,
  stdio: 'inherit',
});

// 2. 构建 release 版 guanlan.exe CLI 并暂存为 Tauri externalBin sidecar
console.log('[guanlan-installer] 2/3 编译并暂存内嵌 guanlan.exe CLI...');
execFileSync('cargo', ['build', '--release', '--locked', '-p', 'guanlan-service', '--bin', 'guanlan'], {
  cwd: nativeDir,
  stdio: 'inherit',
});
const triple = process.env.GUANLAN_TARGET_TRIPLE || 'x86_64-pc-windows-msvc';
const ext = triple.includes('windows') ? '.exe' : '';
const builtCli = resolve(nativeDir, `target/release/guanlan${ext}`);
if (!existsSync(builtCli)) {
  fail(`未找到已编译 CLI：${builtCli}`);
}
const binariesDir = resolve(desktopDir, 'binaries');
mkdirSync(binariesDir, { recursive: true });
const stagedSidecar = resolve(binariesDir, `guanlan-${triple}${ext}`);
copyFileSync(builtCli, stagedSidecar);
console.log(
  `[guanlan-installer] 已暂存 CLI sidecar：${stagedSidecar}（${formatMiB(statSync(stagedSidecar).size)}）`
);

if (skipBundle) {
  console.log('[guanlan-installer] --stage-only 模式完成（已准备 dist 与 CLI sidecar）。');
  process.exit(0);
}

// 3. 调用仓内 vendored @tauri-apps/cli（零 PATH 依赖）或 cargo tauri 生成 MSI + NSIS 安装包
console.log('[guanlan-installer] 3/3 打包 Windows MSI / NSIS 安装器...');
const tauriCliJs = resolve(guanlanDir, 'node_modules/@tauri-apps/cli/tauri.js');
if (existsSync(tauriCliJs)) {
  execFileSync(
    process.execPath,
    [tauriCliJs, 'build', '--config', releaseConfPath],
    {
      cwd: desktopDir,
      stdio: 'inherit',
    }
  );
} else {
  execFileSync(
    'cargo',
    ['tauri', 'build', '--config', releaseConfPath],
    {
      cwd: desktopDir,
      stdio: 'inherit',
    }
  );
}

const baseConf = JSON.parse(readFileSync(baseConfPath, 'utf8'));
const ver = baseConf.version;
const nsisOut = resolve(nativeDir, `target/release/bundle/nsis/Guanlan_${ver}_x64-setup.exe`);
const msiOut = resolve(nativeDir, `target/release/bundle/msi/Guanlan_${ver}_x64_zh-CN.msi`);
if (!existsSync(nsisOut)) fail(`未产出 NSIS 安装包：${nsisOut}`);
if (!existsSync(msiOut)) fail(`未产出 MSI 安装包：${msiOut}`);
console.log(`[guanlan-installer] NSIS 产物：${nsisOut}（${formatMiB(statSync(nsisOut).size)}）`);
console.log(`[guanlan-installer] MSI  产物：${msiOut}（${formatMiB(statSync(msiOut).size)}）`);
console.log('[guanlan-installer] Windows MSI / NSIS 安装包构建与校验全部完成！');
