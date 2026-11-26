
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export type EventKind =
  | 'workspace_baseline'
  | 'appeared'
  | 'modified'
  | 'missing'
  | 'read_error'
  | 'read_recovered'
  | 'decision_raised'
  | 'decision_changed';

export type TimePrecision = 'second' | 'minute' | 'day' | 'unknown';
export type TimeSource =
  | 'collector'
  | 'document_self'
  | 'manifest'
  | 'git_commit'
  | 'file_mtime';

export interface WorkspaceRecord {
  workspace_id: string;
  root_path: string;
  root_key: string;
  created_at: string;
  last_scan_at: string | null;
  index_generation: number;
}

export interface FileRow {
  file_id: string;
  workspace_id: string;
  current_path: string;
  format: string;
  title: string;
  role: string;
  first_observed_at: string;
  last_observed_at: string;
  last_mtime_ms: number;
  last_revision_id: string | null;
  status: 'active' | 'missing';
}

export interface RevisionRow {
  revision_id: string;
  file_id: string;
  workspace_id: string;
  seq: number;
  prev_revision_id: string | null;
  content_hash: string;
  size_bytes: number;
  observed_at: string;
  occurred_at: string | null;
  occurred_precision: TimePrecision;
  occurred_source: TimeSource | null;
  snapshot_hash: string;
  snapshot_available: number;
  extract_rule_version: string;
}

export interface EventRow {
  seq: number;
  event_id: string;
  workspace_id: string;
  kind: EventKind;
  subject_kind: 'workspace' | 'file' | 'revision' | 'decision';
  subject_id: string;
  revision_id: string | null;
  occurred_at: string | null;
  occurred_precision: TimePrecision;
  occurred_source: TimeSource | null;
  observed_at: string;
  headline: string;
  detail: string;
  payload_json: string;
  batch_id: string | null;
}

export interface StatementRow {
  statement_id: string;
  workspace_id: string;
  file_id: string;
  revision_id: string;
  code: string;
  namespace: string;
  question: string;
  status: string;
  quote: string;
  line_start: number;
  line_end: number;
  decision_id: string | null;
  detail_json: string;
  extract_rule_version: string;
  observed_at: string;
}

export interface EdgeRow {
  edge_id: string;
  workspace_id: string;
  source_file_id: string;
  source_revision_id: string;
  target_file_id: string;
  target_revision_id: string | null;
  kind: string;
  resolution: 'pinned_version' | 'collected_version' | 'current_path_only' | 'unresolved';
  locator_start: number | null;
  locator_end: number | null;
  reason: string;
}

/** 抽取规则版本：规则升级时重建派生索引并记录 */
export const EXTRACT_RULE_VERSION = 'v0.4.3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id       TEXT PRIMARY KEY,
  root_path          TEXT NOT NULL UNIQUE,
  root_key           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  last_scan_at       TEXT,
  index_generation   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  file_id            TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  current_path       TEXT NOT NULL,
  format             TEXT NOT NULL,
  title              TEXT NOT NULL,
  role               TEXT NOT NULL,
  first_observed_at  TEXT NOT NULL,
  last_observed_at   TEXT NOT NULL,
  last_mtime_ms      INTEGER NOT NULL DEFAULT 0,
  last_revision_id   TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_files_ws ON files(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_files_ws_status_normpath
  ON files(workspace_id, status, REPLACE(current_path, '', '/'), file_id);

CREATE TABLE IF NOT EXISTS path_aliases (
  workspace_id       TEXT NOT NULL,
  path               TEXT NOT NULL,
  file_id            TEXT NOT NULL,
  first_observed_at  TEXT NOT NULL,
  last_observed_at   TEXT NOT NULL,
  evidence           TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
CREATE INDEX IF NOT EXISTS idx_alias_file ON path_aliases(file_id);

CREATE TABLE IF NOT EXISTS revisions (
  revision_id         TEXT PRIMARY KEY,
  file_id             TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  prev_revision_id    TEXT,
  content_hash        TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  observed_at         TEXT NOT NULL,
  occurred_at         TEXT,
  occurred_precision  TEXT NOT NULL DEFAULT 'unknown',
  occurred_source     TEXT,
  snapshot_hash       TEXT NOT NULL,
  snapshot_available  INTEGER NOT NULL DEFAULT 1,
  extract_rule_version TEXT NOT NULL,
  UNIQUE (file_id, seq)
);

/** 清理与 UNIQUE(file_id, seq) 同列的冗余索引 idx_rev_file：
 *  唯一约束自带同序 B-tree，重复索引只增存储与写入维护成本——在写入侧幂等迁移中
 *  删除（只读服务启动不改库）。 */
CREATE INDEX IF NOT EXISTS idx_rev_hash ON revisions(content_hash);
DROP INDEX IF EXISTS idx_rev_file;

CREATE TABLE IF NOT EXISTS blobs (
  content_hash   TEXT PRIMARY KEY,
  size_bytes     INTEGER NOT NULL,
  rel_path       TEXT NOT NULL,
  ref_count      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  verified_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL,
  kind                TEXT NOT NULL,
  subject_kind        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  revision_id         TEXT,
  occurred_at         TEXT,
  occurred_precision  TEXT NOT NULL DEFAULT 'unknown',
  occurred_source     TEXT,
  observed_at         TEXT NOT NULL,
  headline            TEXT NOT NULL,
  detail              TEXT NOT NULL,
  payload_json        TEXT NOT NULL DEFAULT '{}',
  batch_id            TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ws_seq ON events(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(workspace_id, kind);
CREATE INDEX IF NOT EXISTS idx_events_ws_occurred_sort
  ON events(workspace_id, COALESCE(occurred_at, ''), seq);
CREATE INDEX IF NOT EXISTS idx_events_ws_observed_sort ON events(workspace_id, observed_at, seq);
-- 文件事件关联四路各自的匹配访问结构（UNION 各分支可走索引，
-- 不再对整个工作区逐条求值四路 OR）
CREATE INDEX IF NOT EXISTS idx_events_ws_subject_seq
  ON events(workspace_id, subject_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ws_revision_seq
  ON events(workspace_id, revision_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ws_payload_file
  ON events(workspace_id, json_extract(payload_json, '$.file_id'), seq);
/** 同一来源的同一事实只记一次：重扫与重试沿用同一记录标识 */
CREATE UNIQUE INDEX IF NOT EXISTS uniq_event_identity
  ON events(workspace_id, kind, subject_id, COALESCE(revision_id, ''), COALESCE(occurred_at, ''));

CREATE TABLE IF NOT EXISTS statements (
  statement_id         TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  file_id              TEXT NOT NULL,
  revision_id          TEXT NOT NULL,
  code                 TEXT NOT NULL,
  namespace            TEXT NOT NULL,
  question             TEXT NOT NULL,
  status               TEXT NOT NULL,
  quote                TEXT NOT NULL,
  line_start           INTEGER NOT NULL,
  line_end             INTEGER NOT NULL,
  decision_id          TEXT,
  detail_json          TEXT NOT NULL DEFAULT '{}',
  extract_rule_version TEXT NOT NULL,
  observed_at          TEXT NOT NULL,
  UNIQUE (revision_id, code, line_start)
);
CREATE INDEX IF NOT EXISTS idx_stmt_ws ON statements(workspace_id, code);
CREATE INDEX IF NOT EXISTS idx_stmt_decision ON statements(decision_id);
/** events/days 样本查询按 file_id 关联计数走索引（此前为逐行全表扫） */
CREATE INDEX IF NOT EXISTS idx_stmt_file ON statements(file_id);

CREATE TABLE IF NOT EXISTS edges (
  edge_id             TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  source_file_id      TEXT NOT NULL,
  source_revision_id  TEXT NOT NULL,
  target_file_id      TEXT NOT NULL,
  target_revision_id  TEXT,
  kind                TEXT NOT NULL,
  resolution          TEXT NOT NULL,
  locator_start       INTEGER,
  locator_end         INTEGER,
  reason              TEXT NOT NULL,
  UNIQUE (source_revision_id, target_file_id, locator_start)
);
CREATE INDEX IF NOT EXISTS idx_edges_ws ON edges(workspace_id);
/** events/days 样本查询按 source_file_id 关联计数走索引（此前为逐行全表扫） */
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(source_file_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function defaultDataDir(rootPath: string): string {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = process.env.GUANLAN_DATA_DIR || path.join(localAppData, 'Guanlan', 'workspaces');
  return path.join(base, rootKeyOf(rootPath));
}

export function rootKeyOf(rootPath: string): string {
  return createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 16);
}

export class WorkspaceStore {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly blobsDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.blobsDir = path.join(dataDir, 'blobs');
    fs.mkdirSync(this.blobsDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'index.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.ensureColumn('statements', 'detail_json', "TEXT NOT NULL DEFAULT '{}'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
      }
      throw error;
    }
  }


  ensureWorkspace(rootPath: string): WorkspaceRecord {
    const resolved = path.resolve(rootPath);
    const existing = this.db
      .prepare('SELECT * FROM workspaces WHERE root_path = ?')
      .get(resolved) as unknown as WorkspaceRecord | undefined;
    if (existing) return existing;

    const record: WorkspaceRecord = {
      workspace_id: `ws_${rootKeyOf(resolved)}`,
      root_path: resolved,
      root_key: rootKeyOf(resolved),
      created_at: new Date().toISOString(),
      last_scan_at: null,
      index_generation: 0,
    };
    this.db
      .prepare(
        `INSERT INTO workspaces (workspace_id, root_path, root_key, created_at, last_scan_at, index_generation)
         VALUES (?, ?, ?, ?, NULL, 0)`
      )
      .run(record.workspace_id, record.root_path, record.root_key, record.created_at);
    return record;
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    return this.db
      .prepare('SELECT * FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as unknown as WorkspaceRecord | undefined;
  }

  bumpGeneration(workspaceId: string): number {
    this.db
      .prepare('UPDATE workspaces SET index_generation = index_generation + 1, last_scan_at = ? WHERE workspace_id = ?')
      .run(new Date().toISOString(), workspaceId);
    const row = this.db
      .prepare('SELECT index_generation AS g FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as unknown as { g: number };
    return row.g;
  }

  markScan(workspaceId: string): void {
    this.db
      .prepare('UPDATE workspaces SET last_scan_at = ? WHERE workspace_id = ?')
      .run(new Date().toISOString(), workspaceId);
  }

  hasBaseline(workspaceId: string): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'workspace_baseline'`)
      .get(workspaceId) as unknown as { n: number };
    return row.n > 0;
  }


  private blobPathFor(hash: string): string {
    return path.join(this.blobsDir, hash.slice(0, 2), hash);
  }

  snapshotPath(hash: string): string {
    return this.blobPathFor(hash);
  }

  blobExists(hash: string): boolean {
    const row = this.db.prepare('SELECT content_hash FROM blobs WHERE content_hash = ?').get(hash);
    return Boolean(row) && fs.existsSync(this.blobPathFor(hash));
  }

  writeSnapshotToDisk(content: Buffer, hash: string): boolean {
    const target = this.blobPathFor(hash);
    if (fs.existsSync(target)) {
      const existing = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      if (existing === hash) return false;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, content);
    const written = createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
    if (written !== hash) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`快照校验失败：期望 ${hash.slice(0, 16)}… 实得 ${written.slice(0, 16)}…`);
    }
    fs.renameSync(tmp, target);
    return true;
  }

  registerBlobRef(hash: string, sizeBytes: number): void {
    const now = new Date().toISOString();
    const rel = path.relative(this.dataDir, this.blobPathFor(hash)).replace(/\\/g, '/');
    const existing = this.db
      .prepare('SELECT 1 AS x FROM blobs WHERE content_hash = ?')
      .get(hash) as unknown as { x: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          'UPDATE blobs SET size_bytes = ?, ref_count = ref_count + 1, verified_at = ? WHERE content_hash = ?'
        )
        .run(sizeBytes, now, hash);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO blobs (content_hash, size_bytes, rel_path, ref_count, created_at, verified_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run(hash, sizeBytes, rel, now, now);
  }

  storeSnapshot(content: Buffer, hash: string): boolean {
    const wrote = this.writeSnapshotToDisk(content, hash);
    this.registerBlobRef(hash, content.length);
    return wrote;
  }

  evictUnreferencedSnapshots(): number {
    const orphaned = this.db
      .prepare(
        `SELECT content_hash FROM blobs
         WHERE content_hash NOT IN (SELECT content_hash FROM revisions)`
      )
      .all() as unknown as Array<{ content_hash: string }>;
    let removed = 0;
    for (const row of orphaned) {
      const target = this.blobPathFor(row.content_hash);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        removed++;
      }
      this.db.prepare('DELETE FROM blobs WHERE content_hash = ?').run(row.content_hash);
    }
    return removed;
  }

  readSnapshot(hash: string): Buffer | null {
    const target = this.blobPathFor(hash);
    if (!fs.existsSync(target)) return null;
    return fs.readFileSync(target);
  }


  findFileByPath(workspaceId: string, filePath: string): FileRow | undefined {
    return this.db
      .prepare('SELECT * FROM files WHERE workspace_id = ? AND current_path = ?')
      .get(workspaceId, filePath) as unknown as FileRow | undefined;
  }

  resolveFileByAlias(workspaceId: string, filePath: string): FileRow | undefined {
    const alias = this.db
      .prepare('SELECT file_id FROM path_aliases WHERE workspace_id = ? AND path = ?')
      .get(workspaceId, filePath) as unknown as { file_id: string } | undefined;
    if (!alias) return undefined;
    return this.db
      .prepare('SELECT * FROM files WHERE file_id = ?')
      .get(alias.file_id) as unknown as FileRow | undefined;
  }

  upsertAlias(workspaceId: string, filePath: string, fileId: string, now: string, evidence: string): void {
    this.db
      .prepare(
        `INSERT INTO path_aliases (workspace_id, path, file_id, first_observed_at, last_observed_at, evidence)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, path) DO UPDATE SET
           file_id = excluded.file_id,
           last_observed_at = excluded.last_observed_at`
      )
      .run(workspaceId, filePath, fileId, now, now, evidence);
  }

  insertFile(file: FileRow): void {
    this.db
      .prepare(
        `INSERT INTO files (file_id, workspace_id, current_path, format, title, role,
            first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(
        file.file_id,
        file.workspace_id,
        file.current_path,
        file.format,
        file.title,
        file.role,
        file.first_observed_at,
        file.last_observed_at,
        file.last_mtime_ms,
        file.last_revision_id
      );
  }

  touchFile(fileId: string, now: string, mtimeMs: number, lastRevisionId: string): void {
    this.db
      .prepare(
        `UPDATE files SET last_observed_at = ?, last_mtime_ms = ?, last_revision_id = ?, status = 'active'
         WHERE file_id = ?`
      )
      .run(now, mtimeMs, lastRevisionId, fileId);
  }

  markFileStatus(fileId: string, status: 'active' | 'missing'): void {
    this.db.prepare('UPDATE files SET status = ? WHERE file_id = ?').run(status, fileId);
  }

  listFiles(workspaceId: string, includeMissing = false): FileRow[] {
    const sql = includeMissing
      ? 'SELECT * FROM files WHERE workspace_id = ?'
      : 'SELECT * FROM files WHERE workspace_id = ? AND status = ?';
    const rows = includeMissing
      ? this.db.prepare(sql).all(workspaceId)
      : this.db.prepare(sql).all(workspaceId, 'active');
    return rows as unknown as FileRow[];
  }

  getFile(fileId: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE file_id = ?').get(fileId) as unknown as
      | FileRow
      | undefined;
  }


  revisionsOfFile(fileId: string): RevisionRow[] {
    return this.db
      .prepare('SELECT * FROM revisions WHERE file_id = ? ORDER BY seq ASC')
      .all(fileId) as unknown as RevisionRow[];
  }

  getRevision(revisionId: string): RevisionRow | undefined {
    return this.db.prepare('SELECT * FROM revisions WHERE revision_id = ?').get(revisionId) as unknown as
      | RevisionRow
      | undefined;
  }

  latestRevision(fileId: string): RevisionRow | undefined {
    return this.db
      .prepare('SELECT * FROM revisions WHERE file_id = ? ORDER BY seq DESC LIMIT 1')
      .get(fileId) as unknown as RevisionRow | undefined;
  }

  insertRevision(rev: RevisionRow): void {
    this.db
      .prepare(
        `INSERT INTO revisions (revision_id, file_id, workspace_id, seq, prev_revision_id, content_hash,
            size_bytes, observed_at, occurred_at, occurred_precision, occurred_source,
            snapshot_hash, snapshot_available, extract_rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rev.revision_id,
        rev.file_id,
        rev.workspace_id,
        rev.seq,
        rev.prev_revision_id,
        rev.content_hash,
        rev.size_bytes,
        rev.observed_at,
        rev.occurred_at,
        rev.occurred_precision,
        rev.occurred_source,
        rev.snapshot_hash,
        rev.snapshot_available,
        rev.extract_rule_version
      );
    if (!this.db.prepare('SELECT 1 AS x FROM blobs WHERE content_hash = ?').get(rev.content_hash)) {
      throw new Error(`版本引用了未保存的快照：${rev.content_hash.slice(0, 16)}`);
    }
  }

  markRevisionSnapshotUnavailable(revisionId: string): void {
    this.db
      .prepare('UPDATE revisions SET snapshot_available = 0 WHERE revision_id = ?')
      .run(revisionId);
  }


  insertEvent(event: Omit<EventRow, 'seq'>): { inserted: boolean; seq: number | null } {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO events (event_id, workspace_id, kind, subject_kind, subject_id, revision_id,
              occurred_at, occurred_precision, occurred_source, observed_at, headline, detail, payload_json, batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.event_id,
          event.workspace_id,
          event.kind,
          event.subject_kind,
          event.subject_id,
          event.revision_id,
          event.occurred_at,
          event.occurred_precision,
          event.occurred_source,
          event.observed_at,
          event.headline,
          event.detail,
          event.payload_json,
          event.batch_id
        );
      return { inserted: true, seq: Number(info.lastInsertRowid ?? 0) };
    } catch (error) {
      const errcode = (error as { errcode?: number } | null)?.errcode;
      const message = error instanceof Error ? error.message : String(error);
      if (
        errcode === 2067  ||
        /UNIQUE constraint failed: (?:index ')?(?:uniq_event_identity|events\.event_id)/.test(message)
      ) {
        return { inserted: false, seq: null };
      }
      throw error;
    }
  }

  maxEventSeq(workspaceId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE workspace_id = ?')
      .get(workspaceId) as unknown as { s: number };
    return row.s;
  }


  upsertStatement(row: StatementRow): void {
    this.db
      .prepare(
        `INSERT INTO statements (statement_id, workspace_id, file_id, revision_id, code, namespace,
            question, status, quote, line_start, line_end, decision_id, detail_json, extract_rule_version, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (revision_id, code, line_start) DO UPDATE SET
           status = excluded.status,
           quote = excluded.quote,
           line_end = excluded.line_end,
           decision_id = excluded.decision_id,
           detail_json = excluded.detail_json`
      )
      .run(
        row.statement_id,
        row.workspace_id,
        row.file_id,
        row.revision_id,
        row.code,
        row.namespace,
        row.question,
        row.status,
        row.quote,
        row.line_start,
        row.line_end,
        row.decision_id,
        row.detail_json,
        row.extract_rule_version,
        row.observed_at
      );
  }

  listStatements(workspaceId: string): StatementRow[] {
    return this.db
      .prepare('SELECT * FROM statements WHERE workspace_id = ? ORDER BY code ASC, observed_at ASC')
      .all(workspaceId) as unknown as StatementRow[];
  }

  clearStatementsOfRevision(revisionId: string, ruleVersion: string): number {
    const info = this.db
      .prepare('DELETE FROM statements WHERE revision_id = ? AND extract_rule_version <> ?')
      .run(revisionId, ruleVersion);
    return Number(info.changes ?? 0);
  }


  upsertEdge(row: EdgeRow): void {
    this.db
      .prepare(
        `INSERT INTO edges (edge_id, workspace_id, source_file_id, source_revision_id, target_file_id,
            target_revision_id, kind, resolution, locator_start, locator_end, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_revision_id, target_file_id, locator_start) DO UPDATE SET
           target_revision_id = excluded.target_revision_id,
           resolution = excluded.resolution,
           reason = excluded.reason`
      )
      .run(
        row.edge_id,
        row.workspace_id,
        row.source_file_id,
        row.source_revision_id,
        row.target_file_id,
        row.target_revision_id,
        row.kind,
        row.resolution,
        row.locator_start,
        row.locator_end,
        row.reason
      );
  }

  listEdges(workspaceId: string): EdgeRow[] {
    return this.db
      .prepare('SELECT * FROM edges WHERE workspace_id = ?')
      .all(workspaceId) as unknown as EdgeRow[];
  }


  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }


  counts(workspaceId: string): { files: number; revisions: number; events: number; blobs: number; statements: number; edges: number } {
    const one = (sql: string) =>
      Number((this.db.prepare(sql).get(workspaceId) as unknown as { n: number }).n);
    return {
      files: one('SELECT COUNT(*) AS n FROM files WHERE workspace_id = ?'),
      revisions: Number(
        (this.db.prepare('SELECT COUNT(*) AS n FROM revisions') .get() as unknown as { n: number }).n
      ),
      events: one('SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?'),
      blobs: Number((this.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as unknown as { n: number }).n),
      statements: one('SELECT COUNT(*) AS n FROM statements WHERE workspace_id = ?'),
      edges: one('SELECT COUNT(*) AS n FROM edges WHERE workspace_id = ?'),
    };
  }
}

export function openStore(dataDir?: string): WorkspaceStore {
  return new WorkspaceStore(dataDir || path.join(os.tmpdir(), 'guanlan-store'));
}
