//! 测试夹具（仅 #[cfg(test)] 编译）。
//!
//! 「测试建库除外」允许范围内的唯一写路径：按 contract-storage.md §1.1 DDL 原文
//! 在临时目录建库插数，供只读路径的单元测试使用。测试结束后目录随系统临时区废弃。

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::GuanlanError;
use crate::storage::ReadonlyStore;

pub(crate) const CONTRACT_DDL: &str = r#"
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
CREATE INDEX IF NOT EXISTS idx_rev_hash ON revisions(content_hash);

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
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(source_file_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) struct FixtureDb {
    pub dir: PathBuf,
    pub db_path: PathBuf,
    /// 可写连接：仅用于建库与插入夹具数据（测试建库除外）
    pub conn: Connection,
}

impl FixtureDb {
    pub fn new(tag: &str) -> Self {
        let seq = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "guanlan-core-{tag}-{}-{seq}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let db_path = dir.join("index.db");
        let conn = Connection::open(&db_path).expect("打开夹具库失败");
        conn.execute_batch(CONTRACT_DDL)
            .expect("按契约 DDL 建表失败");
        conn.execute_batch(crate::index::search_index::SEARCH_DDL)
            .expect("按契约 DDL 建检索索引表失败");
        Self { dir, db_path, conn }
    }

    /// 绝对测试根目录（cwd 无关，rootKey 确定）
    pub fn root(&self) -> String {
        format!(
            "H:\\guanlan-core-fixture\\{}",
            self.dir.file_name().expect("目录名").to_string_lossy()
        )
    }

    /// 插入工作区行（root_key 用与生产一致的 rootKeyOf 计算，供 claim_workspace 认领）
    pub fn workspace(
        &self,
        root: &str,
        index_generation: i64,
        last_scan_at: Option<&str>,
    ) -> String {
        let resolved = crate::domain::resolve_root_with(root, "H:\\");
        let root_key = crate::domain::root_key_of_resolved(&resolved);
        let ws_id = crate::domain::workspace_id_of(&root_key);
        self.conn
            .execute(
                "INSERT INTO workspaces (workspace_id, root_path, root_key, created_at, last_scan_at, index_generation) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    ws_id,
                    resolved,
                    root_key,
                    "2026-01-01T00:00:00.000Z",
                    last_scan_at,
                    index_generation
                ],
            )
            .expect("插入工作区行失败");
        ws_id
    }

    /// 插入文件行；返回 file_id
    #[allow(clippy::too_many_arguments)]
    pub fn file(
        &self,
        ws_id: &str,
        file_id: &str,
        current_path: &str,
        format: &str,
        role: &str,
        status: &str,
        last_revision_id: Option<&str>,
    ) -> String {
        self.conn
            .execute(
                "INSERT INTO files (file_id, workspace_id, current_path, format, title, role, \
                    first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)",
                rusqlite::params![
                    file_id,
                    ws_id,
                    current_path,
                    format,
                    crate::query::files::title_of(current_path),
                    role,
                    "2026-01-01T00:00:00.000Z",
                    "2026-01-02T00:00:00.000Z",
                    last_revision_id,
                    status
                ],
            )
            .expect("插入文件行失败");
        file_id.to_owned()
    }

    /// 插入 blobs 行（登记元数据）；磁盘文件由 [`Self::write_blob_file`] 显式落盘
    pub fn blob(&self, hash: &str, size: i64, ref_count: i64) {
        self.conn
            .execute(
                "INSERT INTO blobs (content_hash, size_bytes, rel_path, ref_count, created_at, verified_at) 
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) 
                 ON CONFLICT (content_hash) DO UPDATE SET ref_count = ref_count + excluded.ref_count",
                rusqlite::params![
                    hash,
                    size,
                    format!("blobs/{}/{}", &hash[..2], hash),
                    ref_count,
                    "2026-01-01T00:00:00.000Z",
                    "2026-01-01T00:00:00.000Z"
                ],
            )
            .expect("插入 blobs 行失败");
    }

    /// 把快照内容写到 blobs 两级路径（内容哈希由调用方保证一致）
    pub fn write_blob_file(&self, hash: &str, content: &[u8]) -> PathBuf {
        let path = self.dir.join("blobs").join(&hash[..2]).join(hash);
        std::fs::create_dir_all(path.parent().expect("blob 父目录")).expect("创建 blobs 目录失败");
        std::fs::write(&path, content).expect("写快照失败");
        path
    }

    /// 插入版本行
    #[allow(clippy::too_many_arguments)]
    pub fn revision(
        &self,
        ws_id: &str,
        file_id: &str,
        seq: i64,
        content_hash: &str,
        size_bytes: i64,
        occurred_at: Option<&str>,
        occurred_precision: &str,
        occurred_source: Option<&str>,
        snapshot_available: i64,
        observed_at: &str,
    ) -> String {
        let revision_id = crate::domain::revision_id_of(file_id, seq);
        self.conn
            .execute(
                "INSERT INTO revisions (revision_id, file_id, workspace_id, seq, prev_revision_id, \
                    content_hash, size_bytes, observed_at, occurred_at, occurred_precision, \
                    occurred_source, snapshot_hash, snapshot_available, extract_rule_version) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?6, ?12, 'v0.4.3')",
                rusqlite::params![
                    revision_id,
                    file_id,
                    ws_id,
                    seq,
                    if seq > 1 { Some(crate::domain::revision_id_of(file_id, seq - 1)) } else { None },
                    content_hash,
                    size_bytes,
                    observed_at,
                    occurred_at,
                    occurred_precision,
                    occurred_source,
                    snapshot_available
                ],
            )
            .expect("插入版本行失败");
        revision_id
    }

    /// 插入事件行（seq 由 AUTOINCREMENT 分配，插入顺序即 seq 序）
    #[allow(clippy::too_many_arguments)]
    pub fn event(
        &self,
        ws_id: &str,
        kind: &str,
        subject_kind: &str,
        subject_id: &str,
        revision_id: Option<&str>,
        occurred_at: Option<&str>,
        occurred_precision: &str,
        occurred_source: Option<&str>,
        observed_at: &str,
        headline: &str,
        detail: &str,
        payload_json: &str,
    ) -> i64 {
        let event_id = format!(
            "evt_test_{kind}_{subject_id}_{}",
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        self.conn
            .execute(
                "INSERT INTO events (event_id, workspace_id, kind, subject_kind, subject_id, \
                    revision_id, occurred_at, occurred_precision, occurred_source, observed_at, \
                    headline, detail, payload_json, batch_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL)",
                rusqlite::params![
                    event_id,
                    ws_id,
                    kind,
                    subject_kind,
                    subject_id,
                    revision_id,
                    occurred_at,
                    occurred_precision,
                    occurred_source,
                    observed_at,
                    headline,
                    detail,
                    payload_json
                ],
            )
            .expect("插入事件行失败");
        self.conn.last_insert_rowid()
    }

    /// 插入陈述行
    #[allow(clippy::too_many_arguments)]
    pub fn statement(
        &self,
        ws_id: &str,
        statement_id: &str,
        file_id: &str,
        revision_id: &str,
        code: &str,
        namespace: &str,
        question: &str,
        status: &str,
        quote: &str,
        line_start: i64,
        line_end: i64,
        decision_id: Option<&str>,
        detail_json: &str,
        observed_at: &str,
    ) {
        self.conn
            .execute(
                "INSERT INTO statements (statement_id, workspace_id, file_id, revision_id, code, \
                    namespace, question, status, quote, line_start, line_end, decision_id, \
                    detail_json, extract_rule_version, observed_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'v0.4.3', ?14)",
                rusqlite::params![
                    statement_id,
                    ws_id,
                    file_id,
                    revision_id,
                    code,
                    namespace,
                    question,
                    status,
                    quote,
                    line_start,
                    line_end,
                    decision_id,
                    detail_json,
                    observed_at
                ],
            )
            .expect("插入陈述行失败");
    }

    /// 插入引用边行
    #[allow(clippy::too_many_arguments)]
    pub fn edge(
        &self,
        ws_id: &str,
        edge_id: &str,
        source_file_id: &str,
        source_revision_id: &str,
        target_file_id: &str,
        resolution: &str,
        locator: Option<(i64, i64)>,
        reason: &str,
    ) {
        self.conn
            .execute(
                "INSERT INTO edges (edge_id, workspace_id, source_file_id, source_revision_id, \
                    target_file_id, target_revision_id, kind, resolution, locator_start, locator_end, reason) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'explicit_reference', ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    edge_id,
                    ws_id,
                    source_file_id,
                    source_revision_id,
                    target_file_id,
                    resolution,
                    locator.map(|l| l.0),
                    locator.map(|l| l.1),
                    reason
                ],
            )
            .expect("插入引用边失败");
    }
}

pub(crate) fn open_store(fixture: &FixtureDb, root: &str) -> ReadonlyStore {
    let mut store = ReadonlyStore::open(&fixture.db_path).expect("只读打开夹具库失败");
    store.claim_workspace(root).expect("认领夹具工作区失败");
    store
}

pub(crate) fn assert_code(result: Result<(), GuanlanError>, code: &str) {
    let err = result.expect_err("应当报错");
    assert_eq!(err.code(), code, "错误码不符：{err:?}");
}

pub(crate) fn cleanup_dir(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

pub(crate) fn collect_forbidden_keys(value: &serde_json::Value, keys: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    fn walk(v: &serde_json::Value, keys: &[&str], path: &str, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(map) => {
                for (k, val) in map {
                    let child = format!("{path}/{k}");
                    if keys.contains(&k.as_str()) {
                        out.push(child.clone());
                    }
                    walk(val, keys, &child, out);
                }
            }
            serde_json::Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    walk(item, keys, &format!("{path}[{i}]"), out);
                }
            }
            _ => {}
        }
    }
    walk(value, keys, "", &mut found);
    found
}

pub(crate) fn blob_rel(data_dir: &Path, hash: &str) -> PathBuf {
    data_dir.join("blobs").join(&hash[..2]).join(hash)
}
