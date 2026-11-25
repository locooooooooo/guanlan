/**
 * 观澜 —— Node↔Rust 写入对拍
 *
 * 用途：Rust 写入器接管索引后，必须与旧 Node 管线在**同一套表**上产出**同一套事实**。
 * 契约 §2.1 第 2 条明令「不生成第二套历史」：身份公式（file_id / revision_id /
 * event_id / statement_id / decision_id / edge_id）任一处偏差，都会在库里留下两套
 * 并存的记录。这个脚本是那道约束的唯一硬保证。
 *
 * 用法（在 guanlan/ 下执行）：
 *   node node_modules/tsx/dist/cli.mjs scripts/parity-reconcile.ts \
 *     [--exe <guanlan.exe 路径>] [--workspace <目录>]
 *
 * 过程：
 * 1) 同一工作区，分别交给 TS 管线（server/reconcile.ts）与 Rust 写入器
 *    （`guanlan scan --root`），各自写进独立的数据目录；
 * 2) 逐表导出、归一化（剔除采集时刻等必然不同的字段）后比对；
 * 3) 任一差异逐条列出并以非零码退出。
 *
 * 刻意不共享任何实现：TS 侧只 import 旧管线，Rust 侧只跑二进制。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { reconcileWorkspace } from '../server/reconcile';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SCRIPT_DIR, '..');
const NATIVE_ROOT = path.join(PKG_ROOT, 'native');

// ---------- 参数 ----------

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const exePath =
  argOf('--exe') ??
  path.join(NATIVE_ROOT, 'target', 'debug', process.platform === 'win32' ? 'guanlan.exe' : 'guanlan');
const workspaceArg = argOf('--workspace');
const workspaceRoot = path.resolve(
  workspaceArg ?? path.join(NATIVE_ROOT, 'testdata', 'fixture', 'workspace'),
);

if (!fs.existsSync(exePath)) {
  console.error(`找不到 Rust 可执行文件：${exePath}`);
  console.error('先构建：cd native && cargo build -p guanlan-service');
  process.exit(2);
}
if (!fs.existsSync(workspaceRoot)) {
  console.error(`找不到工作区：${workspaceRoot}`);
  console.error('先生成夹具：npm run seed');
  process.exit(2);
}

// ---------- 临时目录 ----------

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-parity-'));
const tsDataDir = path.join(base, 'ts');
const rustDataBase = path.join(base, 'rust');
fs.mkdirSync(tsDataDir, { recursive: true });
fs.mkdirSync(rustDataBase, { recursive: true });

// ---------- 两侧各跑一轮 ----------

console.log(`工作区：${workspaceRoot}`);
console.log('① TS 管线（server/reconcile.ts）…');
const tsReport = reconcileWorkspace(workspaceRoot, { dataDir: tsDataDir }).report;

console.log('② Rust 写入器（guanlan scan）…');
const rustRun = spawnSync(exePath, ['scan', '--root', workspaceRoot], {
  env: { ...process.env, GUANLAN_DATA_DIR: rustDataBase },
  encoding: 'utf8',
});
if (rustRun.status !== 0) {
  console.error(rustRun.stderr || rustRun.stdout);
  console.error('Rust 侧扫描失败');
  process.exit(1);
}

// Rust 的数据目录同样是 <base>/<rootKey>（两侧 rootKey 口径一致）
const rootKey = fs
  .readdirSync(rustDataBase)
  .find((entry) => fs.existsSync(path.join(rustDataBase, entry, 'index.db')));
if (!rootKey) {
  console.error('Rust 侧未产出 index.db');
  process.exit(1);
}
const rustDataDir = path.join(rustDataBase, rootKey);

// ---------- 导出与归一化 ----------

/** 采集时刻等字段必然随运行时刻变化，比对时剔除 */
const VOLATILE = new Set([
  'observed_at',
  'last_observed_at',
  'first_observed_at',
  'created_at',
  'last_scan_at',
  'verified_at',
  'seq',
]);

function dump(dbPath: string, table: string, columns: string[]): any[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as any[];
    return rows.map((row) => {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (VOLATILE.has(key)) continue;
        normalized[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return normalized;
    });
  } finally {
    db.close();
  }
}

/** 稳定排序（按主键或标识列），让比对与插入顺序无关 */
function sortRows(rows: any[], key: string): any[] {
  return [...rows].sort((a, b) => {
    const left = String(a[key] ?? '');
    const right = String(b[key] ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

const TABLES: Array<{ table: string; columns: string[]; key: string }> = [
  {
    table: 'files',
    columns: [
      'file_id',
      'current_path',
      'format',
      'title',
      'role',
      'last_mtime_ms',
      'last_revision_id',
      'status',
    ],
    key: 'file_id',
  },
  {
    table: 'path_aliases',
    columns: ['path', 'file_id', 'evidence'],
    key: 'path',
  },
  {
    table: 'revisions',
    columns: [
      'revision_id',
      'file_id',
      'seq',
      'prev_revision_id',
      'content_hash',
      'size_bytes',
      'occurred_at',
      'occurred_precision',
      'occurred_source',
      'snapshot_hash',
      'snapshot_available',
      'extract_rule_version',
    ],
    key: 'revision_id',
  },
  {
    table: 'events',
    columns: [
      'event_id',
      'kind',
      'subject_kind',
      'subject_id',
      'revision_id',
      'occurred_at',
      'occurred_precision',
      'occurred_source',
      'headline',
      'detail',
      'payload_json',
      'batch_id',
    ],
    key: 'event_id',
  },
  {
    table: 'statements',
    columns: [
      'statement_id',
      'file_id',
      'revision_id',
      'code',
      'namespace',
      'question',
      'status',
      'quote',
      'line_start',
      'line_end',
      'decision_id',
      'detail_json',
      'extract_rule_version',
    ],
    key: 'statement_id',
  },
  {
    table: 'edges',
    columns: [
      'edge_id',
      'source_file_id',
      'source_revision_id',
      'target_file_id',
      'target_revision_id',
      'kind',
      'resolution',
      'locator_start',
      'locator_end',
      'reason',
    ],
    key: 'edge_id',
  },
  {
    table: 'blobs',
    columns: ['content_hash', 'size_bytes', 'rel_path', 'ref_count'],
    key: 'content_hash',
  },
];

// ---------- 比对 ----------

let failures = 0;

for (const { table, columns, key } of TABLES) {
  const tsRows = sortRows(dump(path.join(tsDataDir, 'index.db'), table, columns), key);
  const rustRows = sortRows(dump(path.join(rustDataDir, 'index.db'), table, columns), key);

  const tsByKey = new Map(tsRows.map((row) => [String(row[key]), row]));
  const rustByKey = new Map(rustRows.map((row) => [String(row[key]), row]));

  const onlyTs = [...tsByKey.keys()].filter((id) => !rustByKey.has(id));
  const onlyRust = [...rustByKey.keys()].filter((id) => !tsByKey.has(id));
  const differing = [...tsByKey.keys()]
    .filter((id) => rustByKey.has(id))
    .filter((id) => JSON.stringify(tsByKey.get(id)) !== JSON.stringify(rustByKey.get(id)));

  const status = onlyTs.length === 0 && onlyRust.length === 0 && differing.length === 0 ? '✓' : '✗';
  console.log(`${status} ${table}：TS ${tsRows.length} 行 / Rust ${rustRows.length} 行`);
  if (status === '✗') {
    failures += 1;
    for (const id of onlyTs.slice(0, 10)) {
      console.log(`    仅 TS 有：${id}`);
      console.log(`      ${JSON.stringify(tsByKey.get(id))}`);
    }
    for (const id of onlyRust.slice(0, 10)) {
      console.log(`    仅 Rust 有：${id}`);
      console.log(`      ${JSON.stringify(rustByKey.get(id))}`);
    }
    for (const id of differing.slice(0, 10)) {
      console.log(`    内容不同：${id}`);
      console.log(`      TS   ${JSON.stringify(tsByKey.get(id))}`);
      console.log(`      Rust ${JSON.stringify(rustByKey.get(id))}`);
    }
    if (onlyTs.length > 10 || onlyRust.length > 10 || differing.length > 10) {
      console.log('    …（其余差异略）');
    }
  }
}

// ---------- 报告字段对照 ----------

const tsSummary = {
  scanned: tsReport.scanned,
  newFiles: tsReport.newFiles,
  newRevisions: tsReport.newRevisions,
  unchanged: tsReport.unchanged,
  mtimeOnly: tsReport.mtimeOnly,
  contentChanged: tsReport.contentChanged,
  appeared: tsReport.appeared,
  missing: tsReport.missing,
  recovered: tsReport.recovered,
  unstableReads: tsReport.unstableReads,
  eventsInserted: tsReport.eventsInserted,
  eventsSkipped: tsReport.eventsSkipped,
  statementsUpserted: tsReport.statementsUpserted,
  edgesUpserted: tsReport.edgesUpserted,
  snapshotsWritten: tsReport.snapshotsWritten,
};
console.log(`\nTS 本轮统计：${JSON.stringify(tsSummary)}`);

if (failures > 0) {
  console.error(`\n对拍失败：${failures} 张表存在差异`);
  console.error(`临时目录：${base}`);
  process.exit(1);
}
console.log('\n对拍通过：两侧在同一套表上产出了同一套事实。');
// 清理：Windows 上 SQLite 句柄释放有延迟，重试几次即可
for (let attempt = 0; attempt < 5; attempt += 1) {
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    break;
  } catch {
    // 下一轮重试
  }
}
