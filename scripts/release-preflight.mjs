#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const TARGET = 'x86_64-pc-windows-msvc';

const USAGE = `观澜发版预检

用法：
  node scripts/release-preflight.mjs [--tag vX.Y.Z] [--require-on-main] [--assets <目录>]

选项：
  --tag <标签>        核对标签：必须等于 v<版本>，且存在于本地仓库
  --require-on-main   标签所指的提交必须是 origin/main 的祖先（发布流水线里必带）
  --assets <目录>     核对构建产物：安装包、命令行、SHA256SUMS
  -h, --help          显示这份用法
`;


/** 解析参数；不合法时抛错。 */
export function parseArgs(args) {
  const options = { tag: null, requireOnMain: false, assets: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--require-on-main') {
      options.requireOnMain = true;
      continue;
    }
    if (arg !== '--tag' && arg !== '--assets') throw new Error(`无法识别的参数：${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 后面要跟一个值`);
    options[arg === '--tag' ? 'tag' : 'assets'] = value;
    i += 1;
  }
  return options;
}


const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * 列出仓库里每一处版本号。
 * 返回 { version, sources }：version 取自 package.json，sources 的每项是 { where, version }，
 * 找不到时 version 为 undefined。
 */
export function collectVersions() {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const tauri = JSON.parse(read('native/crates/guanlan-desktop/tauri.conf.json'));
  const cargoToml = read('native/Cargo.toml');
  const cargoLock = read('native/Cargo.lock');
  const buildInfo = read('src/utils/appBuildInfo.ts');

  const workspaceBlock = cargoToml.split('[workspace.package]')[1]?.split(/\r?\n(?=\[)/)[0] ?? '';

  const sources = [
    { where: 'package.json', version: pkg.version },
    { where: 'package-lock.json', version: lock.version },
    { where: 'package-lock.json packages[""]', version: lock.packages?.['']?.version },
    { where: 'native/Cargo.toml [workspace.package]', version: workspaceBlock.match(/version\s*=\s*"([^"]+)"/)?.[1] },
    { where: 'native/crates/guanlan-desktop/tauri.conf.json', version: tauri.version },
    { where: 'src/utils/appBuildInfo.ts', version: buildInfo.match(/resolvedVersion =[\s\S]*?:\s*'([^']+)'/)?.[1] },
  ];
  for (const crate of ['guanlan-core', 'guanlan-service', 'guanlan-desktop']) {
    sources.push({
      where: `native/Cargo.lock ${crate}`,
      version: cargoLock.match(new RegExp(`name = "${crate}"\\r?\\nversion = "([^"]+)"`))?.[1],
    });
  }
  for (const rel of ['vite.config.ts', 'test/v12-release-parity.test.ts', 'scripts/visual-baseline.mjs']) {
    const text = read(rel);
    for (const match of text.matchAll(/'(\d+\.\d+\.\d+)'/g)) {
      sources.push({ where: `${rel}:${lineOf(text, match.index)}`, version: match[1] });
    }
  }
  return { version: pkg.version, sources };
}

/** 某个版本的发布产物应当有的文件名（不含 SHA256SUMS）。 */
export function expectedAssetNames(version) {
  return [
    `Guanlan_${version}_x64-setup.exe`,
    `Guanlan_${version}_x64_zh-CN.msi`,
    `guanlan-cli-${version}-${TARGET}.exe`,
  ];
}

function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 核对一个产物目录：文件齐、不为空、没有多余的文件、SHA-256 与 SHA256SUMS 一致。
 * 返回 { passed, problems }，都是字符串数组。
 */
export function checkAssets(dir, version) {
  const passed = [];
  const problems = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    problems.push(`产物目录不存在：${dir}`);
    return { passed, problems };
  }
  const expected = expectedAssetNames(version);
  const present = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .filter((entry) => entry.name !== 'SHA256SUMS')
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of present) {
    if (entry.directory) problems.push(`产物目录里不该有子目录：${entry.name}`);
    else if (!expected.includes(entry.name)) problems.push(`多出未预期的文件：${entry.name}`);
  }
  for (const name of expected) {
    if (!present.some((entry) => entry.name === name && !entry.directory)) problems.push(`缺少产物：${name}`);
  }

  const sums = new Map();
  const sumsPath = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(sumsPath)) {
    problems.push('缺少 SHA256SUMS');
  } else {
    for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
      if (match) sums.set(match[2].trim(), match[1].toLowerCase());
    }
    passed.push(`SHA256SUMS 列出 ${sums.size} 个文件`);
  }

  for (const { name, directory } of present) {
    if (directory) continue;
    const file = path.join(dir, name);
    const size = fs.statSync(file).size;
    if (size === 0) problems.push(`${name} 是空文件`);
    const recorded = sums.get(name);
    if (recorded === undefined) {
      problems.push(`SHA256SUMS 里没有 ${name}`);
    } else if (sha256Of(file) === recorded) {
      passed.push(`${name}：${(size / 1024 / 1024).toFixed(2)} MiB，SHA-256 与 SHA256SUMS 一致`);
    } else {
      problems.push(`${name}：SHA-256 与 SHA256SUMS 不一致`);
    }
  }
  for (const name of sums.keys()) {
    if (!present.some((entry) => entry.name === name && !entry.directory)) problems.push(`SHA256SUMS 列出了不存在的文件：${name}`);
  }
  return { passed, problems };
}


function git(...args) {
  const out = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return { status: out.status, text: (out.stdout ?? '').trim() };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`release-preflight: ${error.message}\n\n${USAGE}`);
    return 2;
  }

  const passed = [];
  const problems = [];
  const notes = [];

  let version = null;
  try {
    const collected = collectVersions();
    version = collected.version;
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      problems.push(`package.json 的 version 不是 x.y.z 形式：${JSON.stringify(version)}`);
    } else {
      passed.push(`package.json 的版本号：${version}`);
    }
    for (const source of collected.sources) {
      if (source.version === version) passed.push(`${source.where}：${version}`);
      else if (source.version === undefined) problems.push(`${source.where}：找不到版本号`);
      else problems.push(`${source.where}：${source.version}，应为 ${version}`);
    }
  } catch (error) {
    problems.push(`读版本号时出错：${error.message}`);
  }

  if (options.tag !== null) {
    const expected = `v${version}`;
    if (options.tag === expected) passed.push(`标签 ${options.tag} 等于 v${version}`);
    else problems.push(`标签 ${options.tag} 与版本号不符，应为 ${expected}`);

    const tagged = git('rev-parse', '-q', '--verify', `refs/tags/${options.tag}^{commit}`);
    if (tagged.status !== 0) {
      problems.push(`标签 ${options.tag} 不存在于本地仓库`);
    } else {
      passed.push(`标签 ${options.tag} 指向提交 ${tagged.text.slice(0, 12)}`);
      const main = git('rev-parse', '-q', '--verify', 'refs/remotes/origin/main');
      const judgeable = main.status === 0;
      const onMain = judgeable && git('merge-base', '--is-ancestor', tagged.text, main.text).status === 0;
      const unjudgeable = '无法判断标签是否在 main 上：本地没有 refs/remotes/origin/main';
      if (onMain) {
        passed.push('标签所指的提交在 origin/main 上');
      } else if (options.requireOnMain) {
        problems.push(judgeable ? `标签 ${options.tag} 所指的提交不在 origin/main 上，标签必须打在 main 上` : unjudgeable);
      } else {
        notes.push(judgeable ? `标签 ${options.tag} 所指的提交不在 origin/main 上` : unjudgeable);
      }
    }
  }

  if (options.assets !== null) {
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      problems.push('版本号读不出来，无法核对构建产物');
    } else {
      const result = checkAssets(path.resolve(REPO, options.assets), version);
      passed.push(...result.passed);
      problems.push(...result.problems);
    }
  }

  for (const line of passed) console.log(`  通过  ${line}`);
  for (const line of notes) console.log(`  提示  ${line}`);
  for (const line of problems) console.error(`  问题  ${line}`);
  console.log(problems.length === 0 ? `发版预检通过（${passed.length} 项）。` : `发版预检未通过：${problems.length} 项问题。`);
  return problems.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT);
if (invokedDirectly) {
  process.exitCode = main();
}
