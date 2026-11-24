#!/usr/bin/env node
/**
 * 生成 Tauri 更新清单 latest.json。发布流水线接上更新源之后由它生成；本地演练也用它。
 *
 * 用法：
 *   node scripts/gen-update-manifest.mjs --version 1.2.1 \
 *     --signature-file <安装包>.exe.sig --url <安装包地址> [--notes-file <说明文件>] \
 *     [--pub-date <RFC 3339>] --out latest.json
 *
 * 清单格式按 Tauri v2 的静态清单：`version`、`platforms` 是必填，`notes`、`pub_date` 可选；
 * windows 平台的 `signature` 是 `.sig` 文件的原文（不是路径），`url` 指向安装包本身。
 *
 * 校验：版本必须是三段式 SemVer；签名不能为空；URL 必须能解析，https 一律接受，http 只
 * 接受回环地址（本地演练），避免把明文地址写进真实发布清单。
 *
 * 纯函数与命令行解析导出给 test/update-manifest.test.ts；被导入时不执行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const USAGE = `生成 Tauri 更新清单 latest.json

用法：
  node scripts/gen-update-manifest.mjs --version <X.Y.Z> --signature-file <path> --url <url> --out <path>
    可选：--notes-file <path>  --pub-date <RFC 3339>  --platform <OS-ARCH>

选项：
  --version        新版本号（三段式 SemVer，不带 v）
  --signature-file 安装包签名文件（Tauri 构建产出的 .sig）
  --url            安装包下载地址；http 只允许回环地址
  --notes-file     更新说明的 Markdown/文本文件
  --pub-date       发布时间（默认当前时间）
  --platform       清单里的平台键，默认 windows-x86_64
  --out            写出的文件路径
  -h, --help       显示这份用法
`;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * @param {{ version: string, signature: string, url: string, notes?: string, pubDate?: string, platform?: string }} input
 */
export function buildUpdateManifest({ version, signature, url, notes, pubDate, platform = 'windows-x86_64' }) {
  if (!SEMVER.test(String(version ?? ''))) {
    throw new Error(`版本号必须是三段式 SemVer，实得 ${JSON.stringify(version)}`);
  }
  const signatureText = String(signature ?? '').trim();
  if (signatureText === '') {
    throw new Error('签名内容为空：--signature-file 指向的 .sig 文件没有内容');
  }
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new Error(`下载地址不是合法的 URL：${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`下载地址只支持 https 或回环 http，实得 ${parsed.protocol}`);
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`http 下载地址只允许回环地址（本地演练），实得主机 ${parsed.hostname}`);
  }
  if (!/^[a-z]+-[a-z0-9_]+$/.test(platform)) {
    throw new Error(`平台键不合法：${JSON.stringify(platform)}`);
  }
  const manifest = {
    version: String(version),
    ...(notes && notes.trim() ? { notes: notes.trim() } : {}),
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      [platform]: {
        signature: signatureText,
        url: parsed.toString(),
      },
    },
  };
  return manifest;
}

/** 解析命令行。返回 { ok: true, options } 或 { ok: false, error }；--help 单独标记。 */
export function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const known = new Set(['--version', '--signature-file', '--url', '--notes-file', '--pub-date', '--platform', '--out']);
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!known.has(flag)) return { ok: false, error: `无法识别的参数：${flag}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} 后面要跟一个值` };
    values[flag.slice(2)] = value;
    i += 1;
  }
  for (const required of ['version', 'signature-file', 'url', 'out']) {
    if (!values[required]) return { ok: false, error: `缺少 --${required}` };
  }
  return {
    ok: true,
    options: {
      version: values.version,
      signatureFile: values['signature-file'],
      url: values.url,
      notesFile: values['notes-file'],
      pubDate: values['pub-date'],
      platform: values.platform ?? 'windows-x86_64',
      out: values.out,
    },
  };
}

/**
 * 由参数生成清单文本。文件读不到、校验不过都抛错，调用方决定怎么报。
 * @param {{ version: string, signatureFile: string, url: string, notesFile?: string, pubDate?: string, platform?: string, out: string }} options
 */
export function generateFromFiles(options) {
  const signature = fs.readFileSync(options.signatureFile, 'utf8');
  const notes = options.notesFile ? fs.readFileSync(options.notesFile, 'utf8') : undefined;
  const manifest = buildUpdateManifest({
    version: options.version,
    signature,
    url: options.url,
    notes,
    pubDate: options.pubDate,
    platform: options.platform,
  });
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (!parsed.ok) {
    console.error(`update-manifest: ${parsed.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  try {
    const text = generateFromFiles(parsed.options);
    fs.writeFileSync(path.resolve(parsed.options.out), text);
    const manifest = JSON.parse(text);
    const platform = manifest.platforms[parsed.options.platform];
    console.log(`已写出 ${parsed.options.out}：version=${manifest.version}，平台 ${parsed.options.platform}，签名 ${platform.signature.length} 字符`);
  } catch (error) {
    console.error(`update-manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT);
if (invokedDirectly) main();
