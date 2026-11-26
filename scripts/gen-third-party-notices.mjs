#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findCargo, isKnownBuildFlake } from './gate.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const TARGET = 'x86_64-pc-windows-msvc';
const OUTPUT = 'THIRD_PARTY_NOTICES';
const LOCKFILES = [
  { file: 'package-lock.json', label: 'package-lock.json' },
  { file: path.join('native', 'Cargo.lock'), label: 'native/Cargo.lock' },
];
const NAME_WIDTH = 34;
const VERSION_WIDTH = 18;
const SQLITE_CRATE = 'libsqlite3-sys';
const SQLITE_NOTE = 'rusqlite 启用了 bundled 特性';
const TAILWIND_NOTE = '样式表 dist/assets/*.css 由它生成';
const DIRECT_NOTE = '应用代码导入了它，它自己没有代码进产物';

const USAGE = `生成 THIRD_PARTY_NOTICES（第三方组件的许可索引）

用法：
  npm run notices                                   重新生成 THIRD_PARTY_NOTICES
  node scripts/gen-third-party-notices.mjs --check  只核对；与重新生成的结果不同时以 1 退出

需要先 npm ci，并找得到 cargo（PATH 上没有时去 $CARGO_HOME/bin 与 ~/.cargo/bin 找）。
`;


/**
 * 一条 `cargo tree --prefix none` 的输出是 `名字 v版本`，后面可能跟着 (proc-macro)、去重标记 (*)，
 * 或者路径来源的 crate 的 (路径)。带 features 边时还会有 `名字 feature "特性"` 行，它们不是包。
 * @param {string} line
 * @returns {{ name: string, version: string } | null}
 */
export function parseCargoTreeLine(line) {
  const match = /^(\S+) v(\S+)(?: .*)?$/.exec(line);
  return match ? { name: match[1], version: match[2] } : null;
}

/**
 * 模块 id 或资源的原名 → package-lock.json 里 packages 的键（`node_modules/a/node_modules/b`）。
 * 不在 node_modules 里的返回 null。从仓库根之后找第一个 node_modules，同名包有嵌套安装时以
 * 最深的那个为准，磁盘上实际被加载的就是它。
 * @param {string} id
 * @param {string} repo 仓库根目录
 */
export function packageOfModuleId(id, repo) {
  if (id.includes('\0')) return null;
  const file = id.replace(/\\/g, '/').replace(/[?#].*$/, '');
  const base = repo.replace(/\\/g, '/').replace(/\/$/, '');
  const fold = (text) => (process.platform === 'win32' ? text.toLowerCase() : text);
  const start = fold(file).startsWith(`${fold(base)}/`) ? base.length + 1 : 0;
  const first = file.indexOf('node_modules/', start);
  const last = file.lastIndexOf('node_modules/');
  if (first < 0) return null;
  const segments = file.slice(last + 'node_modules/'.length).split('/');
  const name = segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
  return `${file.slice(first, last + 'node_modules/'.length)}${name}`;
}

/**
 * 文件内容的 SHA-256，换行先统一成 LF。两份锁文件在 .gitattributes 里钉的是 LF，但工作区里的副本
 * 被工具改成 CRLF 时不该因此报「声明过期」：提交进仓库的内容并没有变。
 * @param {string | Buffer} content
 */
export function fingerprint(content) {
  const text = (Buffer.isBuffer(content) ? content.toString('utf8') : content).replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @typedef {object} NoticeRow
 * @property {string} name
 * @property {string} version
 * @property {string} license  组件自己声明的许可表达式，照抄
 * @property {string} [note]   需要单独说明时写在这里
 */

const byNameAndVersion = (a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0;

function rowFromLock(lock, key, note) {
  const entry = lock.packages?.[key];
  if (!entry) {
    throw new Error(
      `构建用到了 ${key}，package-lock.json 里却没有这个条目。node_modules 与锁文件不一致：先在仓库根目录执行 npm ci。`,
    );
  }
  if (!entry.license) {
    throw new Error(`package-lock.json 里 ${key}@${entry.version} 没有 license 字段，无法确定它的许可。查清上游声明的许可后，在本脚本里为它写一行有依据的说明，不要猜。`);
  }
  return {
    name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length),
    version: entry.version ?? '',
    license: entry.license,
    ...(note ? { note } : {}),
  };
}

/**
 * 由构建里收集到的模块 id、资源原名与插件名，对照 package-lock.json 得到前端一侧的行。
 * @param {{ packages?: Record<string, { version?: string, license?: string }> }} lock
 * @param {string[]} moduleIds    各 JS chunk 的模块 id
 * @param {string[]} assetNames   各资源的文件名与原名
 * @param {string[]} pluginNames  解析后的插件名
 * @param {string} repo
 * @param {string[]} [directImports] 产物里的应用代码所导入的模块 id
 * @returns {NoticeRow[]}
 */
export function npmRowsFromLock(lock, moduleIds, assetNames, pluginNames, repo, directImports = []) {
  const keys = new Set();
  for (const id of [...moduleIds, ...assetNames]) {
    const key = packageOfModuleId(id, repo);
    if (key) keys.add(key);
  }
  const rows = [...keys].map((key) => rowFromLock(lock, key));
  if (pluginNames.some((name) => name.startsWith('@tailwindcss/vite'))) {
    rows.push(rowFromLock(lock, 'node_modules/tailwindcss', TAILWIND_NOTE));
  }
  for (const id of directImports) {
    const key = packageOfModuleId(id, repo);
    if (key && !keys.has(key)) {
      keys.add(key);
      rows.push(rowFromLock(lock, key, DIRECT_NOTE));
    }
  }
  return rows.sort(byNameAndVersion);
}

/**
 * 由 cargo tree 的输出与 cargo metadata 得到 Rust 一侧的行。
 * @param {string} tree  `cargo tree --prefix none --edges normal,build,features` 的输出
 * @param {{ workspace_members: string[], packages: Array<{ id: string, name: string, version: string, license?: string, license_file?: string }> }} metadata
 * @returns {{ rows: NoticeRow[], bundledSqlite: boolean }}
 */
export function rustRowsFrom(tree, metadata) {
  const members = new Set(metadata.workspace_members);
  const byKey = new Map(metadata.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  const rows = new Map();
  for (const line of tree.split('\n')) {
    const parsed = parseCargoTreeLine(line);
    if (!parsed) continue;
    const key = `${parsed.name}@${parsed.version}`;
    const pkg = byKey.get(key);
    if (!pkg) throw new Error(`cargo tree 列出了 ${key}，cargo metadata 里却没有它。`);
    if (members.has(pkg.id)) continue;
    if (!pkg.license) {
      throw new Error(
        `${key} 没有声明 license 字段${pkg.license_file ? `，只有许可文件 ${pkg.license_file}` : ''}。查清它的许可后在本脚本里写一行有依据的说明，不要猜。`,
      );
    }
    rows.set(key, { name: parsed.name, version: parsed.version, license: pkg.license });
  }
  const bundledSqlite = new RegExp(`^${SQLITE_CRATE} feature "bundled"(?: \\(\\*\\))?$`, 'm').test(tree);
  return { rows: [...rows.values()].sort(byNameAndVersion), bundledSqlite };
}

function displayPad(text, width) {
  const shown = [...text].reduce((sum, char) => sum + (char.codePointAt(0) >= 0x1100 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - shown));
}

const COLUMN_HEADER = `${displayPad('名称', NAME_WIDTH)} ${displayPad('版本', VERSION_WIDTH)} 许可`;
const COLUMN_RULER = `${'-'.repeat(NAME_WIDTH)} ${'-'.repeat(VERSION_WIDTH)} ${'-'.repeat(48)}`;

/**
 * 一张表的 SHA-256：每行是「名字@版本 许可」加备注，不含对齐用的空格。它让「来源」一节与上面的表
 * 绑在一起：许可一栏在测试里没有源头可对（Cargo.lock 不记许可），没有它，手工改写一个许可表达式
 * 不会有任何一项检查发现。
 * @param {NoticeRow[]} rows
 */
export function rowsDigest(rows) {
  const lines = rows.map((row) => `${row.name}@${row.version} ${row.license}${row.note ? ` （${row.note}）` : ''}`);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function formatRows(rows) {
  return rows
    .map(
      (row) =>
        `${row.name.padEnd(NAME_WIDTH)} ${row.version.padEnd(VERSION_WIDTH)} ${row.license}${row.note ? `   （${row.note}）` : ''}`,
    )
    .join('\n');
}

/**
 * @param {object} model
 * @param {NoticeRow[]} model.npm
 * @param {NoticeRow[]} model.rust
 * @param {boolean} model.bundledSqlite
 * @param {Record<string, string>} model.fingerprints 以 LOCKFILES 的 label 为键
 */
export function formatNotices({ npm, rust, bundledSqlite, fingerprints }) {
  const sources = [
    ...LOCKFILES.map(({ label }) => `${label.padEnd(NAME_WIDTH)} sha256:${fingerprints[label]}`),
    `${displayPad('一、前端', NAME_WIDTH)} sha256:${rowsDigest(npm)}`,
    `${displayPad('二、Rust', NAME_WIDTH)} sha256:${rowsDigest(rust)}`,
  ].join('\n');
  const rustRule = [
    `取法：cargo tree 在 ${TARGET} 目标上，沿普通依赖与构建依赖数出来的 crate。`,
    '不含只在测试里用的开发依赖，也不含本仓库自己的 crate。其中有一部分只在构建时参与、不进',
    '发行包，一并列出，宁多勿漏。许可取自 cargo metadata 的 license 字段。',
  ];
  const rustLimits = [
    '组件内部以别的许可捆绑的素材不在许可一栏里，本文件也没有对每个 crate 内部逐一审查。',
    ...(bundledSqlite
      ? [
          `已知的一例：${SQLITE_NOTE}，${SQLITE_CRATE} 编入的 SQLite 源码由其作者声明为放弃版权`,
          `（公有领域），而 ${SQLITE_CRATE} 自己声明的是 MIT。`,
        ]
      : []),
  ];
  return `观澜（Guanlan）第三方组件许可索引
================================

本文件由 \`npm run notices\`（scripts/gen-third-party-notices.mjs）生成，不要手工修改。依赖有变化后
重新生成，并与锁文件一起提交：test/third-party-notices.test.ts 随 npm test 核对文件末尾记着的四个
SHA-256——两份锁文件的，和上面两张表的——是否都对得上。

下面列出随观澜 Windows 桌面版一同分发的第三方组件，以及每个组件在自己的清单文件里声明的许可。
它是索引，不是完整的声明：不含各许可证的全文（全文见各组件的上游仓库）；许可一栏照抄组件声明的
许可表达式，没有归一化，\`MIT/Apache-2.0\`、\`Apache-2.0 OR MIT\` 与 \`MIT OR Apache-2.0\` 在这里算
三种写法。

Third-party notices index for Guanlan. Generated by \`npm run notices\`; do not edit by hand. It lists
the npm packages used by the production bundle and the crates that take part in the Windows x64
build, each with the license its own manifest declares. It is an index only: no full license texts, and
material bundled inside a component under a different license is mentioned only where noted.

一、前端：生产构建里用到的 npm 包（${npm.length} 个）
==========================================================

取法：在内存里跑一遍 \`npm run build\` 所用的生产构建，模块出现在 JS 产物里的包都在这里，由包里的
文件原样发出的资源（字体、图片）也算。应用代码按名字导入、自己却没有代码进产物的包也列，并注明
（入口包只做转发时就是这样）。版本与许可取自 package-lock.json。不按锁文件里的 dev 标记取：
那个标记只区分「是不是只被开发依赖引用」，打包器与各个平台的原生二进制包都算非 dev，而它们并不
进发行包。样式表由 Tailwind CSS 生成，不是模块图里的节点，但它把 tailwindcss 包里的 preflight 与
主题变量整段带进了 dist 的 CSS，所以单列一行并注明。

${COLUMN_HEADER}
${COLUMN_RULER}
${formatRows(npm)}

二、Rust：参与 Windows x64 构建的 crate（${rust.length} 个）
==========================================================

${rustRule.join('\n')}

${rustLimits.join('\n')}

${COLUMN_HEADER}
${COLUMN_RULER}
${formatRows(rust)}

来源
====

前两行是两份锁文件内容的 SHA-256（换行统一为 LF 后计算）。锁文件变了，本文件就要重新生成。
后两行是上面两张表的 SHA-256，表里的任何一处改动都会让它们对不上。

${sources}
`;
}

/**
 * formatNotices 的逆运算：把文件读回模型，用来核对一份写出来的文件。读不了的行直接报错。
 * 摘要与指纹按「来源」一节的标签原样读回，是否与两张表、与锁文件对得上由调用方核对。
 * @param {string} text
 */
export function parseNotices(text) {
  /** @type {{ npm: NoticeRow[], rust: NoticeRow[] }} */
  const sections = { npm: [], rust: [] };
  /** @type {Record<string, string>} 以「来源」一节的标签为键 */
  const hashes = {};
  let current = '';
  let inRows = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (current === 'source') {
      const match = /^(.+?) +sha256:([0-9a-f]{64})$/.exec(line);
      if (match) hashes[match[1]] = match[2];
    } else if (/^一、/.test(line)) {
      current = 'npm';
      inRows = false;
    } else if (/^二、/.test(line)) {
      current = 'rust';
      inRows = false;
    } else if (/^来源$/.test(line)) {
      current = 'source';
    } else if (current !== '' && /^-/.test(line)) {
      inRows = true;
    } else if (current !== '' && inRows && line.trim() !== '') {
      const match = /^(\S+) +(\S+) +(.*?)(?:   （(.+)）)?$/.exec(line);
      if (!match) throw new Error(`THIRD_PARTY_NOTICES 里有读不了的行：${line}`);
      const [, name, version, license, note] = match;
      sections[current].push(note === undefined ? { name, version, license } : { name, version, license, note });
    }
  }
  /** @type {Record<string, string>} 键是 LOCKFILES 的 label */
  const fingerprints = {
    'package-lock.json': hashes['package-lock.json'],
    'native/Cargo.lock': hashes['native/Cargo.lock'],
  };
  /** @type {Record<'npm' | 'rust', string>} 两张表各自的摘要 */
  const digests = { npm: hashes['一、前端'], rust: hashes['二、Rust'] };
  return {
    ...sections,
    fingerprints,
    digests,
    bundledSqlite: text.includes(`已知的一例：${SQLITE_NOTE}`),
  };
}


async function collectFromBuild(repo) {
  const viteEntry = path.join(repo, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  if (!fs.existsSync(viteEntry)) {
    throw new Error(`找不到 ${viteEntry.replace(/\\/g, '/')}。先在仓库根目录执行 npm ci。`);
  }
  const vite = await import(pathToFileURL(viteEntry).href);
  const loaded = await vite.loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(repo, 'vite.config.ts'));
  if (!loaded) throw new Error('读取 vite.config.ts 失败。');
  const moduleIds = new Set();
  const assetNames = new Set();
  const directImports = new Set();
  const state = { pluginNames: [], chunks: 0 };
  const collector = {
    name: 'guanlan-third-party-notices',
    apply: 'build',
    configResolved(config) {
      state.pluginNames = config.plugins.map((plugin) => plugin.name);
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          if (!output.modules) throw new Error('打包器没有给出 chunk 的模块清单，无法确定哪些包进了产物。');
          state.chunks += 1;
          for (const id of Object.keys(output.modules)) moduleIds.add(id);
        } else {
          for (const name of [output.fileName, ...(output.originalFileNames ?? []), ...(output.names ?? [])]) {
            assetNames.add(name);
          }
        }
      }
      for (const id of moduleIds) {
        if (packageOfModuleId(id, repo) !== null) continue;
        for (const dependency of this.getModuleInfo(id)?.importedIds ?? []) directImports.add(dependency);
      }
    },
  };
  const options = {
    ...loaded.config,
    configFile: false,
    root: repo,
    logLevel: 'warn',
    plugins: [loaded.config.plugins, collector],
    build: { ...loaded.config.build, write: false },
  };
  try {
    await vite.build(options);
  } catch (error) {
    if (!isKnownBuildFlake(String(error instanceof Error ? error.stack : error))) throw error;
    await vite.build(options);
  }
  if (state.chunks === 0) throw new Error('生产构建没有产出任何 JS chunk。');
  return {
    moduleIds: [...moduleIds],
    assetNames: [...assetNames],
    pluginNames: state.pluginNames,
    directImports: [...directImports],
  };
}

function cargoInputs(cargoFile, cwd) {
  const env = { ...process.env, PATH: `${path.dirname(cargoFile)}${path.delimiter}${process.env.PATH ?? ''}` };
  const run = (args) => {
    const out = spawnSync(cargoFile, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (out.error) throw out.error;
    if (out.status !== 0) throw new Error(`cargo ${args.join(' ')} 失败（退出码 ${out.status}）：\n${out.stderr.trim()}`);
    return out.stdout;
  };
  return {
    tree: run(['tree', '--locked', '--target', TARGET, '--edges', 'normal,build,features', '--prefix', 'none']),
    metadata: JSON.parse(run(['metadata', '--locked', '--format-version', '1', '--filter-platform', TARGET])),
  };
}

/** 重新生成整份文件的内容。 */
export async function generateNotices(repo, cargoFile) {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  const collected = await collectFromBuild(repo);
  const npm = npmRowsFromLock(lock, collected.moduleIds, collected.assetNames, collected.pluginNames, repo, collected.directImports);
  const { tree, metadata } = cargoInputs(cargoFile, path.join(repo, 'native'));
  const { rows: rust, bundledSqlite } = rustRowsFrom(tree, metadata);
  const fingerprints = Object.fromEntries(
    LOCKFILES.map(({ file, label }) => [label, fingerprint(fs.readFileSync(path.join(repo, file)))]),
  );
  return { text: formatNotices({ npm, rust, bundledSqlite, fingerprints }), npm: npm.length, rust: rust.length };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const unknownArgs = argv.filter((arg) => arg !== '--check');
  if (unknownArgs.length > 0) {
    console.error(`notices: 无法识别的参数：${unknownArgs.join(' ')}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const check = argv.includes('--check');
  const cargo = findCargo();
  if (cargo.file === null) {
    console.error('notices: 找不到 cargo（PATH、$CARGO_HOME/bin 与 ~/.cargo/bin 里都没有），取不到 Rust 一侧的清单。');
    process.exitCode = 1;
    return;
  }
  const { text, npm, rust } = await generateNotices(REPO, cargo.file);
  const target = path.join(REPO, OUTPUT);
  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === text) {
      console.log(`${OUTPUT} 与重新生成的结果一致（前端 ${npm} 个包，Rust ${rust} 个 crate）。`);
      return;
    }
    console.error(`${OUTPUT} 与重新生成的结果不一致：执行 npm run notices 重新生成，并与锁文件一起提交。`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(target, text);
  console.log(`已生成 ${OUTPUT}：前端 ${npm} 个包，Rust ${rust} 个 crate。`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT);
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`notices: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
