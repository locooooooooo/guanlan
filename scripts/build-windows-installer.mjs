#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guanlanDir = resolve(__dirname, '..');
const nativeDir = resolve(guanlanDir, 'native');
const desktopDir = resolve(nativeDir, 'crates/guanlan-desktop');
const baseConfPath = resolve(desktopDir, 'tauri.conf.json');
const releaseConfPath = resolve(desktopDir, 'tauri.release.conf.json');
const nsisHookPath = resolve(desktopDir, 'installer/windows-context-menu.nsh');

const argv = process.argv.slice(2);
const args = new Set(argv);
const checkOnly = args.has('--check-only');
const skipBundle = args.has('--stage-only');
function flagValue(name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}
const updaterTestEndpoint = args.has('--updater-test-endpoint')
  ? flagValue('--updater-test-endpoint')
  : undefined;

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
  const updaterPubkey = baseConf?.plugins?.updater?.pubkey;
  if (typeof updaterPubkey !== 'string' || updaterPubkey.trim() === '') {
    fail('tauri.conf.json 缺少 plugins.updater.pubkey');
  }
  if (updaterTestEndpoint !== undefined) {
    let url;
    try {
      url = new URL(updaterTestEndpoint);
    } catch {
      fail(`--updater-test-endpoint 不是合法的 URL：${updaterTestEndpoint}`);
    }
    const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) {
      fail(`--updater-test-endpoint 只接受 https 或回环 http，实得 ${updaterTestEndpoint}`);
    }
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
      fail('--updater-test-endpoint 需要签名私钥：先设置 TAURI_SIGNING_PRIVATE_KEY（私钥路径或内容）');
    }
  } else if (args.has('--updater-test-endpoint')) {
    fail('--updater-test-endpoint 后面要跟一个地址');
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

console.log('[guanlan-installer] 1/3 构建精简前端生产包 (vite build)...');
const viteJs = resolve(guanlanDir, 'node_modules/vite/bin/vite.js');
if (!existsSync(viteJs)) fail(`缺少 vite 入口：${viteJs}`);
execFileSync(process.execPath, [viteJs, 'build'], {
  cwd: guanlanDir,
  stdio: 'inherit',
});

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

console.log('[guanlan-installer] 3/3 打包 Windows MSI / NSIS 安装器...');
const tauriCliJs = resolve(guanlanDir, 'node_modules/@tauri-apps/cli/tauri.js');
let buildConfigPath = releaseConfPath;
let tempConfigPath = null;
if (updaterTestEndpoint) {
  const baseConf = JSON.parse(readFileSync(baseConfPath, 'utf8'));
  const relConf = JSON.parse(readFileSync(releaseConfPath, 'utf8'));
  const merged = {
    ...relConf,
    bundle: { ...(relConf.bundle ?? {}), createUpdaterArtifacts: true },
    plugins: {
      ...(relConf.plugins ?? {}),
      updater: {
        ...(baseConf.plugins?.updater ?? {}),
        endpoints: [updaterTestEndpoint],
        dangerousInsecureTransportProtocol: true,
      },
    },
  };
  tempConfigPath = resolve(os.tmpdir(), `guanlan-tauri-updater-test-${process.pid}.json`);
  writeFileSync(tempConfigPath, JSON.stringify(merged, null, 2));
  buildConfigPath = tempConfigPath;
  console.log(
    `[guanlan-installer] 演练配置：更新源 ${updaterTestEndpoint}（createUpdaterArtifacts=true，仅本次构建）`
  );
}
try {
  if (existsSync(tauriCliJs)) {
    execFileSync(
      process.execPath,
      [tauriCliJs, 'build', '--config', buildConfigPath],
      {
        cwd: desktopDir,
        stdio: 'inherit',
      }
    );
  } else {
    execFileSync(
      'cargo',
      ['tauri', 'build', '--config', buildConfigPath],
      {
        cwd: desktopDir,
        stdio: 'inherit',
      }
    );
  }
} finally {
  if (tempConfigPath) rmSync(tempConfigPath, { force: true });
}

const baseConf = JSON.parse(readFileSync(baseConfPath, 'utf8'));
const ver = baseConf.version;
const nsisOut = resolve(nativeDir, `target/release/bundle/nsis/Guanlan_${ver}_x64-setup.exe`);
const msiOut = resolve(nativeDir, `target/release/bundle/msi/Guanlan_${ver}_x64_zh-CN.msi`);
if (!existsSync(nsisOut)) fail(`未产出 NSIS 安装包：${nsisOut}`);
if (!existsSync(msiOut)) fail(`未产出 MSI 安装包：${msiOut}`);
if (updaterTestEndpoint) {
  const sigOut = `${nsisOut}.sig`;
  if (!existsSync(sigOut)) fail(`演练构建没有产出更新签名：${sigOut}`);
  console.log(`[guanlan-installer] 更新签名：${sigOut}（${statSync(sigOut).size} 字节）`);
}
console.log(`[guanlan-installer] NSIS 产物：${nsisOut}（${formatMiB(statSync(nsisOut).size)}）`);
console.log(`[guanlan-installer] MSI  产物：${msiOut}（${formatMiB(statSync(msiOut).size)}）`);
console.log('[guanlan-installer] Windows MSI / NSIS 安装包构建与校验全部完成！');
