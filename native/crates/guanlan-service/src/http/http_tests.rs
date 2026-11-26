//! http 层端到端单测（契约 §1）：路由 → 参数解析 → core 查询 → wire JSON/二进制流。
//!
//! 测试建库「除外」说明：guanlan-core 的 test_support 是 pub(crate)，跨 crate
//! 不可复用；此处按 contract-storage.md §1.1 DDL 原文在临时目录自建夹具库，
//! 与 core 测试同一口径（测试结束随系统临时区废弃）。路由断言用
//! tower::ServiceExt::oneshot（不监听真实端口）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use rusqlite::Connection;
use tower::ServiceExt;

use super::query_exec::{QueryConfig, QueryExecutor};
use super::response_budget::ResponseBudget;
use super::{build_router, AppState};
use guanlan_core::error::GuanlanError;
use guanlan_core::storage::ReadonlyStore;

const H_MD: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
const H_SVG: &str = "aa00000000000000000000000000000000000000000000000000000000000002";
const H_PDF: &str = "aa00000000000000000000000000000000000000000000000000000000000003";
const H_GONE: &str = "aa00000000000000000000000000000000000000000000000000000000000004";
const SVG_SRC: &str = "<svg><text x=\"1\" y=\"2\">\u{6807}\u{9898}A</text><rect/></svg>";

const CONTRACT_DDL: &str = r#"
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
-- ===== schema v2 新表（contract-storage.md §4.3；夹具与生产同构） =====
CREATE TABLE IF NOT EXISTS initiatives (
  initiative_id    TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  name             TEXT NOT NULL,
  root_dir         TEXT NOT NULL,
  current_stage    TEXT NOT NULL DEFAULT '待分类',
  state            TEXT NOT NULL DEFAULT 'draft',
  artifact_count   INTEGER NOT NULL DEFAULT 0,
  pending_p0       INTEGER NOT NULL DEFAULT 0,
  pending_p1       INTEGER NOT NULL DEFAULT 0,
  pending_p2       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, root_dir)
);
CREATE INDEX IF NOT EXISTS idx_initiatives_ws ON initiatives(workspace_id);
CREATE TABLE IF NOT EXISTS artifact_states (
  file_id               TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  initiative_id         TEXT,
  stage                 TEXT NOT NULL DEFAULT '待分类',
  state                 TEXT NOT NULL DEFAULT 'draft',
  selected_revision_id  TEXT,
  checklist_done        INTEGER NOT NULL DEFAULT 0,
  checklist_total       INTEGER NOT NULL DEFAULT 0,
  pending_p0            INTEGER NOT NULL DEFAULT 0,
  pending_p1            INTEGER NOT NULL DEFAULT 0,
  pending_p2            INTEGER NOT NULL DEFAULT 0,
  last_activity_at      TEXT,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_astates_ws_state ON artifact_states(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_astates_initiative ON artifact_states(initiative_id);
CREATE TABLE IF NOT EXISTS task_nodes (
  node_id               TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  initiative_id         TEXT NOT NULL,
  stage                 TEXT NOT NULL,
  title                 TEXT NOT NULL,
  node_kind             TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'queued',
  depends_json          TEXT NOT NULL DEFAULT '[]',
  payload_json          TEXT NOT NULL DEFAULT '{}',
  latest_checkpoint_id  TEXT,
  error                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_init ON task_nodes(initiative_id, stage, state);
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id        TEXT PRIMARY KEY,
  node_id              TEXT,
  workspace_id         TEXT NOT NULL,
  initiative_id        TEXT NOT NULL,
  stage                TEXT NOT NULL,
  status               TEXT NOT NULL,
  input_context_hash   TEXT NOT NULL,
  output_revision_id   TEXT,
  token_usage          INTEGER,
  elapsed_ms           INTEGER,
  note                 TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ckpt_init ON checkpoints(initiative_id, stage, created_at);
CREATE INDEX IF NOT EXISTS idx_ckpt_node ON checkpoints(node_id);
CREATE TABLE IF NOT EXISTS revision_drafts (
  draft_id               TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL,
  file_id                TEXT NOT NULL,
  base_revision_id       TEXT NOT NULL,
  base_content_hash      TEXT NOT NULL,
  proposed_content_hash  TEXT NOT NULL,
  snapshot_rel_path      TEXT NOT NULL,
  source                 TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'proposed',
  conflict               INTEGER NOT NULL DEFAULT 0,
  note                   TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_file ON revision_drafts(file_id, status);
CREATE TABLE IF NOT EXISTS summary_jobs (
  job_id         TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  file_id        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 10,
  state          TEXT NOT NULL DEFAULT 'queued',
  summary_json   TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sjobs_state ON summary_jobs(workspace_id, priority, state);
CREATE TABLE IF NOT EXISTS job_runs (
  job_id         TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  state          TEXT NOT NULL,
  phase          TEXT NOT NULL,
  request_json   TEXT NOT NULL DEFAULT '{}',
  progress_json  TEXT NOT NULL DEFAULT '{}',
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON job_runs(workspace_id, state);
"#;

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    dir: PathBuf,
    db_path: PathBuf,
    conn: Connection,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "guanlan-svc-{tag}-{}-{seq}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let db_path = dir.join("index.db");
        let conn = Connection::open(&db_path).expect("打开夹具库失败");
        conn.execute_batch(CONTRACT_DDL)
            .expect("按契约 DDL 建表失败");
        Self { dir, db_path, conn }
    }

    fn root(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }

    fn workspace(&self, root: &str, index_generation: i64, last_scan_at: Option<&str>) -> String {
        let resolved = guanlan_core::domain::resolve_root_with(root, "H:\\");
        let root_key = guanlan_core::domain::root_key_of_resolved(&resolved);
        let ws_id = guanlan_core::domain::workspace_id_of(&root_key);
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

    #[allow(clippy::too_many_arguments)]
    fn file(
        &self,
        ws_id: &str,
        file_id: &str,
        current_path: &str,
        format: &str,
        role: &str,
        status: &str,
        last_revision_id: Option<&str>,
    ) {
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
                    current_path,
                    role,
                    "2026-01-01T00:00:00.000Z",
                    "2026-06-01T00:00:00.000Z",
                    last_revision_id,
                    status
                ],
            )
            .expect("插入文件行失败");
    }

    #[allow(clippy::too_many_arguments)]
    fn revision(
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
        let revision_id = guanlan_core::domain::revision_id_of(file_id, seq);
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
                    if seq > 1 { Some(guanlan_core::domain::revision_id_of(file_id, seq - 1)) } else { None },
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

    #[allow(clippy::too_many_arguments)]
    fn event(
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
        payload_json: &str,
    ) -> i64 {
        let event_id = format!("evt_svc_{kind}_{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
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
                    String::new(),
                    payload_json
                ],
            )
            .expect("插入事件行失败");
        self.conn.last_insert_rowid()
    }

    #[allow(clippy::too_many_arguments)]
    fn statement(
        &self,
        ws_id: &str,
        statement_id: &str,
        file_id: &str,
        revision_id: &str,
        code: &str,
        question: &str,
        status: &str,
        decision_id: Option<&str>,
        observed_at: &str,
    ) {
        self.conn
            .execute(
                "INSERT INTO statements (statement_id, workspace_id, file_id, revision_id, code, \
                    namespace, question, status, quote, line_start, line_end, decision_id, \
                    detail_json, extract_rule_version, observed_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, '{}', 'v0.4.3', ?13)",
                rusqlite::params![
                    statement_id,
                    ws_id,
                    file_id,
                    revision_id,
                    code,
                    "项目 / 集",
                    question,
                    status,
                    format!("> {question}"),
                    1,
                    2,
                    decision_id,
                    observed_at
                ],
            )
            .expect("插入陈述行失败");
    }

    fn edge(
        &self,
        ws_id: &str,
        edge_id: &str,
        source_file_id: &str,
        source_revision_id: &str,
        target_file_id: &str,
        resolution: &str,
    ) {
        self.conn
            .execute(
                "INSERT INTO edges (edge_id, workspace_id, source_file_id, source_revision_id, \
                    target_file_id, target_revision_id, kind, resolution, locator_start, locator_end, reason) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'explicit_reference', ?6, 1, 2, '链接')",
                rusqlite::params![edge_id, ws_id, source_file_id, source_revision_id, target_file_id, resolution],
            )
            .expect("插入引用边失败");
    }

    fn blob(&self, hash: &str, size: i64) {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO blobs (content_hash, size_bytes, rel_path, ref_count, created_at, verified_at) \
                 VALUES (?1, ?2, ?3, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                rusqlite::params![hash, size, format!("blobs/{}/{}", &hash[..2], hash)],
            )
            .expect("插入 blobs 行失败");
    }

    fn write_blob_file(&self, hash: &str, content: &[u8]) {
        let path = self.dir.join("blobs").join(&hash[..2]).join(hash);
        std::fs::create_dir_all(path.parent().expect("blob 父目录")).expect("创建 blobs 目录失败");
        std::fs::write(&path, content).expect("写快照失败");
    }
}

fn setup_workspace(tag: &str) -> (Fixture, String, String) {
    let fixture = Fixture::new(tag);
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 7, Some("2026-06-01T12:34:56.000Z"));

    fixture.blob(H_MD, 11);
    fixture.write_blob_file(H_MD, b"# body text");
    fixture.blob(H_SVG, SVG_SRC.len() as i64);
    fixture.write_blob_file(H_SVG, SVG_SRC.as_bytes());
    fixture.blob(H_PDF, 8);
    fixture.write_blob_file(H_PDF, b"%PDF-1.4 fake");

    let ra = {
        fixture.file(&ws_id, "f_a", "docs/a.md", "md", "方案", "active", None);
        fixture.revision(
            &ws_id,
            "f_a",
            1,
            H_MD,
            11,
            Some("2026-06-01"),
            "day",
            Some("document_self"),
            1,
            "2026-06-01T00:00:00.000Z",
        )
    };
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_a'",
            rusqlite::params![ra],
        )
        .expect("回填");
    let rb = {
        fixture.file(&ws_id, "f_b", "docs/b.md", "md", "方案", "active", None);
        fixture.revision(
            &ws_id,
            "f_b",
            1,
            H_MD,
            11,
            Some("2026-06-02"),
            "day",
            Some("document_self"),
            1,
            "2026-06-02T00:00:00.000Z",
        )
    };
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_b'",
            rusqlite::params![rb],
        )
        .expect("回填");
    let rc = {
        fixture.file(&ws_id, "f_c", "notes/c.md", "md", "交接", "active", None);
        fixture.revision(
            &ws_id,
            "f_c",
            1,
            H_MD,
            11,
            Some("2026-06-03"),
            "day",
            Some("document_self"),
            1,
            "2026-06-03T00:00:00.000Z",
        )
    };
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_c'",
            rusqlite::params![rc],
        )
        .expect("回填");
    let rs = {
        fixture.file(
            &ws_id,
            "f_svg",
            "assets/logo.svg",
            "svg",
            "交接",
            "active",
            None,
        );
        fixture.revision(
            &ws_id,
            "f_svg",
            1,
            H_SVG,
            48,
            Some("2026-06-01"),
            "day",
            Some("document_self"),
            1,
            "2026-06-01T00:00:00.000Z",
        )
    };
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_svg'",
            rusqlite::params![rs],
        )
        .expect("回填");
    let rp = {
        fixture.file(
            &ws_id,
            "f_pdf",
            "assets/doc.pdf",
            "pdf",
            "交接",
            "active",
            None,
        );
        fixture.revision(
            &ws_id,
            "f_pdf",
            1,
            H_PDF,
            8,
            Some("2026-06-01"),
            "day",
            Some("file_mtime"),
            1,
            "2026-06-01T08:00:00.000Z",
        )
    };
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_pdf'",
            rusqlite::params![rp],
        )
        .expect("回填");
    fixture.file(
        &ws_id,
        "f_missing",
        "old/d.md",
        "md",
        "方案",
        "missing",
        None,
    );
    let rg = {
        fixture.file(&ws_id, "f_gone", "gone/g.md", "md", "方案", "active", None);
        fixture.revision(
            &ws_id,
            "f_gone",
            1,
            H_GONE,
            9,
            Some("2026-05-01"),
            "day",
            Some("document_self"),
            0,
            "2026-05-01T00:00:00.000Z",
        )
    };
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_gone'",
            rusqlite::params![rg],
        )
        .expect("回填");

    fixture.event(
        &ws_id,
        "modified",
        "revision",
        &ra,
        Some(&ra),
        Some("2026-06-01"),
        "day",
        Some("document_self"),
        "2026-06-01T00:00:00.000Z",
        "修改 a.md",
        r#"{"path":"docs/a.md","format":"md"}"#,
    );
    fixture.event(
        &ws_id,
        "modified",
        "revision",
        &rb,
        Some(&rb),
        Some("2026-06-02"),
        "day",
        Some("document_self"),
        "2026-06-02T00:00:00.000Z",
        "修改 b.md",
        r#"{"path":"docs/b.md","format":"md"}"#,
    );
    fixture.event(
        &ws_id,
        "workspace_baseline",
        "workspace",
        &ws_id,
        None,
        Some("2026-06-01"),
        "day",
        Some("collector"),
        "2026-06-01T00:00:00.000Z",
        "首次纳入 5 份资料",
        "{}",
    );

    fixture.statement(
        &ws_id,
        "st_1",
        "f_a",
        &ra,
        "Q1",
        "采用哪套方案？",
        "待确认",
        Some("dec_1"),
        "2026-06-01T00:00:00.000Z",
    );
    fixture.edge(&ws_id, "e1", "f_a", &ra, "f_b", "collected_version");
    fixture.edge(&ws_id, "e2", "f_a", &ra, "unresolved:x", "unresolved");

    (fixture, root, ws_id)
}

fn app_for(fixture: &Fixture, root: &str, instance: &str) -> axum::Router {
    let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
    store.claim_workspace(root).expect("认领夹具工作区失败");
    build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: instance.to_owned(),
        jobs: crate::index_jobs::IndexJobManager::idle(),
        watcher: None,
        notices: None,
        dist: None,
    })
}

fn test_exec_config() -> QueryConfig {
    QueryConfig {
        wait_deadline: std::time::Duration::from_secs(5),
        exec_deadline: std::time::Duration::from_secs(10),
        max_waiters: 64,
    }
}

async fn send(
    app: &axum::Router,
    req: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let resp = app.clone().oneshot(req).await.expect("路由执行失败");
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp
        .into_body()
        .collect()
        .await
        .expect("读响应体失败")
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

async fn get(app: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let (status, _headers, bytes) = send(
        app,
        Request::builder()
            .uri(uri)
            .body(Body::empty())
            .expect("请求构建"),
    )
    .await;
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

fn assert_envelope(json: &serde_json::Value, expected_code: &str) {
    assert_eq!(
        json.get("ok").and_then(|v| v.as_bool()),
        Some(false),
        "{json}"
    );
    assert_eq!(
        json.get("code").and_then(|v| v.as_str()),
        Some(expected_code),
        "{json}"
    );
}

fn assert_no_body_content(json: &serde_json::Value) {
    let text = json.to_string();
    assert!(!text.contains("svgSource"), "bootstrap 不得携带 svgSource");
    assert!(
        !text.contains("markdownContent"),
        "bootstrap 不得携带 markdownContent"
    );
    assert!(
        !text.contains("\"revisions\":[") && !text.contains("\"revisions\": ["),
        "bootstrap 不得携带版本链数组"
    );
}

#[tokio::test]
async fn bootstrap_composes_snapshot() {
    let (fixture, root, _ws) = setup_workspace("http-bootstrap");
    let app = app_for(&fixture, &root, "inst_test000000001");

    let (status, json) = get(
        &app,
        "/api/v1/bootstrap?days_limit=1&events_limit=1&files_page_size=2",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json.get("ok").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        json.pointer("/workspace/index_generation")
            .and_then(|v| v.as_u64()),
        Some(7)
    );
    assert_eq!(
        json.pointer("/counts/files").and_then(|v| v.as_u64()),
        Some(7),
        "6 active + 1 missing"
    );
    assert_eq!(
        json.pointer("/counts/revisions").and_then(|v| v.as_u64()),
        Some(6),
        "全表计数口径（契约 §1.4）"
    );
    assert_eq!(
        json.pointer("/counts/events").and_then(|v| v.as_u64()),
        Some(3)
    );
    assert_eq!(
        json.pointer("/files_total").and_then(|v| v.as_u64()),
        Some(6)
    );
    assert_eq!(
        json.pointer("/files/items")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(2)
    );
    assert_eq!(
        json.pointer("/files/total_matched")
            .and_then(|v| v.as_u64()),
        Some(6)
    );
    assert_eq!(
        json.pointer("/events/items")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        json.pointer("/event_days/hidden_days")
            .and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        json.pointer("/decisions")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        json.pointer("/decisions/0/code").and_then(|v| v.as_str()),
        Some("Q1")
    );
    assert_eq!(
        json.pointer("/relations_total").and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        json.pointer("/index_jobs")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(0)
    );
    assert_eq!(
        json.pointer("/baseline").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_no_body_content(&json);
}

#[tokio::test]
async fn status_reports_instance_and_coverage() {
    let (fixture, root, _ws) = setup_workspace("http-status");
    let app = app_for(&fixture, &root, "inst_test000000002");

    let (status, json) = get(&app, "/api/v1/status").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(
        json.pointer("/instance_id").and_then(|v| v.as_str()),
        Some("inst_test000000002"),
        "实例身份应与启动生成一致"
    );
    assert_eq!(
        json.pointer("/api_version").and_then(|v| v.as_str()),
        Some("v1")
    );
    assert_eq!(
        json.pointer("/schema_version").and_then(|v| v.as_u64()),
        Some(2)
    );
    assert!(
        json.pointer("/workspace_id")
            .and_then(|v| v.as_str())
            .map(|s| s.starts_with("ws_"))
            .unwrap_or(false),
        "{json}"
    );
    assert_eq!(
        json.pointer("/index_generation").and_then(|v| v.as_u64()),
        Some(7)
    );
    assert_eq!(
        json.pointer("/index_coverage/active_files")
            .and_then(|v| v.as_u64()),
        Some(6)
    );
    assert_eq!(
        json.pointer("/index_coverage/missing_files")
            .and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        json.pointer("/active_jobs")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(0)
    );
    assert_eq!(
        json.pointer("/time_range/occurredMin")
            .and_then(|v| v.as_str()),
        Some("2026-06-01")
    );
    assert_eq!(
        json.pointer("/time_range/occurredMax")
            .and_then(|v| v.as_str()),
        Some("2026-06-02")
    );
}

#[tokio::test]
async fn files_paginates_and_filters() {
    let (fixture, root, _ws) = setup_workspace("http-files");
    let app = app_for(&fixture, &root, "inst_test000000003");

    let (status, p1) = get(&app, "/api/v1/files?limit=2").await;
    assert_eq!(status, StatusCode::OK, "{p1}");
    assert_eq!(
        p1.pointer("/snapshot_generation").and_then(|v| v.as_u64()),
        Some(7)
    );
    assert_eq!(
        p1.pointer("/total_matched").and_then(|v| v.as_u64()),
        Some(6)
    );
    assert_eq!(
        p1.pointer("/has_more").and_then(|v| v.as_bool()),
        Some(true)
    );
    let items1 = p1
        .pointer("/items")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("items");
    assert_eq!(items1.len(), 2);
    assert_eq!(
        items1[0]["relative_path"], "assets/doc.pdf",
        "首行应为字典序最小路径：{p1}"
    );
    assert_eq!(items1[0]["format"], "pdf");
    assert_eq!(
        items1[0]["coverage"], "filename_only",
        "pdf 恒 filename_only（project.ts:180-187）"
    );
    assert_eq!(items1[0]["pdf_status"], "unindexed");
    assert_eq!(items1[1]["relative_path"], "assets/logo.svg");
    assert_eq!(items1[1]["coverage"], "svg_text", "svg 含 <text>");
    let cursor = p1
        .pointer("/next_cursor")
        .and_then(|v| v.as_str())
        .expect("首页应签发游标")
        .to_owned();

    let (status, p2) = get(&app, &format!("/api/v1/files?limit=2&cursor={cursor}")).await;
    assert_eq!(status, StatusCode::OK, "{p2}");
    let items2 = p2
        .pointer("/items")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("items");
    assert_eq!(items2[0]["relative_path"], "docs/a.md");
    assert!(
        items2[0]
            .get("current_revision_id")
            .and_then(|v| v.as_str())
            .map(|s| s.starts_with("f_a_r1"))
            .unwrap_or(false),
        "{p2}"
    );
    assert_eq!(
        items2[0].get("revision_count").and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        items2[0].get("first_source_time").and_then(|v| v.as_str()),
        Some("2026-06-01")
    );
    assert_eq!(
        items2[0].get("coverage").and_then(|v| v.as_str()),
        Some("full_text")
    );

    let (_status, fd) = get(&app, "/api/v1/files?dir=docs&limit=10").await;
    let dir_items = fd
        .pointer("/items")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("items");
    assert_eq!(dir_items.len(), 2);
    assert_eq!(
        fd.pointer("/total_matched").and_then(|v| v.as_u64()),
        Some(2)
    );
    let (_status, fall) = get(&app, "/api/v1/files?limit=1").await;
    let formats = fall
        .pointer("/facets/formats")
        .and_then(|v| v.as_object())
        .expect("facets.formats");
    assert_eq!(
        formats.get("md").and_then(|v| v.as_u64()),
        Some(4),
        "facets 为 active 全集口径：{fall}"
    );
    assert_eq!(formats.get("svg").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(formats.get("pdf").and_then(|v| v.as_u64()), Some(1));
    let folders = fall
        .pointer("/facets/folders")
        .and_then(|v| v.as_object())
        .expect("facets.folders");
    assert!(
        folders.contains_key("docs"),
        "facets.folders 应含 docs：{fall}"
    );
}

#[tokio::test]
async fn files_marks_unavailable_snapshot() {
    let (fixture, root, _ws) = setup_workspace("http-files-gone");
    let app = app_for(&fixture, &root, "inst_test000000004");
    let (_status, json) = get(&app, "/api/v1/files?q=gone").await;
    let items = json
        .pointer("/items")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]["coverage"], "filename_only",
        "snapshot_available=0 → filename_only"
    );
    assert_eq!(
        items[0].get("snapshot_available").and_then(|v| v.as_bool()),
        Some(false)
    );
}

#[tokio::test]
async fn pagination_uses_expression_sort_indexes() {
    let (fixture, _root, _ws) = setup_workspace("http-explain-plan");
    let conn = &fixture.conn;
    let plan_of = |sql: &str| -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("explain 准备");
        stmt.query_map([], |r| r.get::<_, String>(3))
            .expect("explain 查询")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("explain 收集")
    };

    let plans = plan_of(
        "SELECT f.* FROM files f WHERE f.workspace_id = 'w' AND f.status = 'active'          ORDER BY REPLACE(f.current_path, '\', '/') ASC, f.file_id ASC LIMIT 100",
    );
    assert!(
        plans
            .iter()
            .any(|p| p.contains("idx_files_ws_status_normpath")),
        "文件分页应命中规范化路径表达式索引：{plans:?}"
    );

    let plans = plan_of(
        "SELECT e.* FROM events e WHERE e.workspace_id = 'w'          ORDER BY COALESCE(e.occurred_at, '') DESC, e.seq DESC LIMIT 50",
    );
    assert!(
        plans
            .iter()
            .any(|p| p.contains("idx_events_ws_occurred_sort")),
        "events occurred 排序应命中表达式索引：{plans:?}"
    );

    let plans = plan_of(
        "SELECT e.* FROM events e WHERE e.workspace_id = 'w'          ORDER BY e.observed_at DESC, e.seq DESC LIMIT 50",
    );
    assert!(
        plans
            .iter()
            .any(|p| p.contains("idx_events_ws_observed_sort")),
        "events observed 排序应命中表达式索引：{plans:?}"
    );

    let plans = plan_of(
        "SELECT e.* FROM events e WHERE e.workspace_id = 'w'          AND (COALESCE(e.occurred_at, '') < 'k' OR (COALESCE(e.occurred_at, '') = 'k' AND e.seq < 9))          ORDER BY COALESCE(e.occurred_at, '') DESC, e.seq DESC LIMIT 50",
    );
    assert!(
        plans
            .iter()
            .any(|p| p.contains("idx_events_ws_occurred_sort")),
        "events 游标续页应命中排序表达式索引：{plans:?}"
    );
}

#[tokio::test]
async fn snapshot_stream_supports_range_and_conditional_requests() {
    let (fixture, root, _ws) = setup_workspace("http-range");
    let app = app_for(&fixture, &root, "inst_range00000001");
    let rp = guanlan_core::domain::revision_id_of("f_pdf", 1);
    let body_len = b"%PDF-1.4 fake".len() as u64;

    let req_with = |range: Option<&str>, extra: Option<(&str, &str)>| {
        let mut b = Request::builder().uri(format!("/api/v1/revisions/{rp}/content?raw=1"));
        if let Some(r) = range {
            b = b.header("range", r);
        }
        if let Some((k, v)) = extra {
            b = b.header(k, v);
        }
        b.body(Body::empty()).expect("请求构建")
    };

    let (status, headers, bytes) = send(&app, req_with(None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get("accept-ranges").and_then(|v| v.to_str().ok()),
        Some("bytes")
    );
    assert_eq!(
        headers.get("content-length").and_then(|v| v.to_str().ok()),
        Some("13")
    );
    let etag = headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("应下发稳定 ETag")
        .to_owned();
    assert!(etag.starts_with("\"sha256-"), "ETag 由内容哈希生成：{etag}");
    assert_eq!(bytes.len() as u64, body_len);

    let (status, headers, bytes) = send(&app, req_with(Some("bytes=0-3"), None)).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        headers.get("content-range").and_then(|v| v.to_str().ok()),
        Some("bytes 0-3/13")
    );
    assert_eq!(
        headers.get("content-length").and_then(|v| v.to_str().ok()),
        Some("4")
    );
    assert_eq!(bytes, b"%PDF".to_vec());

    let (status, headers, bytes) = send(&app, req_with(Some("bytes=6-"), None)).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        headers.get("content-range").and_then(|v| v.to_str().ok()),
        Some("bytes 6-12/13")
    );
    assert_eq!(bytes, b".4 fake".to_vec());

    let (status, _headers, bytes) = send(&app, req_with(Some("bytes=-4"), None)).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes, b"fake".to_vec());

    let (status, headers, _bytes) = send(&app, req_with(Some("bytes=99-"), None)).await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        headers.get("content-range").and_then(|v| v.to_str().ok()),
        Some("bytes */13")
    );

    let (status, _h, bytes) = send(&app, req_with(Some("bytes=0-1,3-4"), None)).await;
    assert_eq!(status, StatusCode::OK, "多区间按明确回退全量");
    assert_eq!(bytes.len() as u64, body_len);

    let (status, headers, bytes) = send(&app, req_with(None, Some(("if-none-match", &etag)))).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(bytes.is_empty(), "304 不带 body");
    assert_eq!(
        headers.get("etag").and_then(|v| v.to_str().ok()),
        Some(etag.as_str())
    );

    let (status, _h, bytes) = send(
        &app,
        req_with(Some("bytes=0-3"), Some(("if-range", "\"sha256-other\""))),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes.len() as u64, body_len);

    let (status, _h, bytes) =
        send(&app, req_with(Some("bytes=0-3"), Some(("if-range", &etag)))).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes, b"%PDF".to_vec());
}

#[tokio::test]
async fn invalid_content_hash_returns_explicit_error() {
    let (fixture, root, _ws) = setup_workspace("http-badhash");
    fixture
        .conn
        .execute(
            "UPDATE revisions SET content_hash = 'é' || substr(content_hash, 2) WHERE file_id = 'f_a'",
            [],
        )
        .expect("改写 hash 失败");
    let app = app_for(&fixture, &root, "inst_badhash000001");
    let ra = guanlan_core::domain::revision_id_of("f_a", 1);

    let (status, json) = get(&app, &format!("/api/v1/revisions/{ra}/content")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{json}");
    assert_envelope(&json, "INTERNAL");
    let detail = json
        .get("detail")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        detail.contains("content_hash 格式非法"),
        "应返回明确错误而不是 panic：{detail}"
    );

    let (status, _json) = get(&app, "/api/v1/status").await;
    assert_eq!(status, StatusCode::OK, "异常请求后常规查询仍正常");
}

#[tokio::test]
async fn panicking_query_is_contained_and_pool_recovers() {
    let (fixture, root, _ws) = setup_workspace("http-panic");
    let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
    store.claim_workspace(&root).expect("认领夹具工作区失败");
    let exec = Arc::new(QueryExecutor::with_config(vec![store], test_exec_config()));

    let panicked = exec
        .run(|_store| -> Result<u32, GuanlanError> {
            panic!("模拟查询体内 panic");
        })
        .await;
    assert!(
        matches!(&panicked, Err(GuanlanError::Internal(msg)) if msg.contains("panic")),
        "panic 应转为内部错误而不是任务级 JoinError：{panicked:?}"
    );

    let after = exec.run(|store| store.workspace().map(|_| 7u32)).await;
    assert!(
        matches!(after, Ok(7)),
        "panic 后连接应已重建并可用：{after:?}"
    );
    assert_eq!(exec.pool_size(), 1, "池容量保持");
}

#[tokio::test]
async fn content_response_byte_budget_and_streaming_raw() {
    let (fixture, root, _ws) = setup_workspace("http-budget");
    let small_budget_app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(1024, 64)),
        exec: Arc::new(QueryExecutor::with_config(
            vec![{
                let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
                store.claim_workspace(&root).expect("认领夹具工作区失败");
                store
            }],
            test_exec_config(),
        )),
        instance_id: "inst_budget00000001".to_owned(),
        jobs: crate::index_jobs::IndexJobManager::idle(),
        watcher: None,
        notices: None,
        dist: None,
    });
    let ra = guanlan_core::domain::revision_id_of("f_a", 1);

    let (status, json) = get(
        &small_budget_app,
        &format!("/api/v1/revisions/{ra}/content"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(
        json.get("text").and_then(|v| v.as_str()),
        Some("# body text")
    );

    let (status, headers, bytes) = send(
        &small_budget_app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{ra}/content?raw=1"))
            .body(Body::empty())
            .expect("请求构建"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .starts_with("text/plain"),
        "raw=1 的 md 应按纯文本流回包"
    );
    assert_eq!(bytes, b"# body text".to_vec(), "流式原字节与快照一致");

    let tiny_budget_app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(1024, 4)),
        exec: Arc::new(QueryExecutor::with_config(
            vec![{
                let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
                store.claim_workspace(&root).expect("认领夹具工作区失败");
                store
            }],
            test_exec_config(),
        )),
        instance_id: "inst_budget00000002".to_owned(),
        jobs: crate::index_jobs::IndexJobManager::idle(),
        watcher: None,
        notices: None,
        dist: None,
    });
    let (status, over) = get(&tiny_budget_app, &format!("/api/v1/revisions/{ra}/content")).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{over}");
    assert_envelope(&over, "UNSUPPORTED_CONTENT");
    let detail = over
        .get("detail")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(detail.contains("raw=1"), "超限提示应指向流式读取：{detail}");
    assert_eq!(
        over.pointer("/index_generation").and_then(|v| v.as_u64()),
        Some(7)
    );

    let (status, _h, bytes) = send(
        &tiny_budget_app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{ra}/content?raw=1"))
            .body(Body::empty())
            .expect("请求构建"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"# body text".to_vec(), "大正文可用流式 raw 读取");
}

#[tokio::test]
async fn content_uses_actual_file_size_not_db_size() {
    let (fixture, root, _ws) = setup_workspace("http-budget-actual");
    fixture
        .conn
        .execute(
            "UPDATE revisions SET size_bytes = 3 WHERE file_id = 'f_a'",
            [],
        )
        .expect("改写 size_bytes");
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(1024, 8)),
        exec: Arc::new(QueryExecutor::with_config(
            vec![{
                let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
                store.claim_workspace(&root).expect("认领夹具工作区失败");
                store
            }],
            test_exec_config(),
        )),
        instance_id: "inst_budget00000003".to_owned(),
        jobs: crate::index_jobs::IndexJobManager::idle(),
        watcher: None,
        notices: None,
        dist: None,
    });
    let ra = guanlan_core::domain::revision_id_of("f_a", 1);
    let (status, json) = get(&app, &format!("/api/v1/revisions/{ra}/content")).await;
    assert_eq!(
        status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "应按磁盘实际大小判定超限，而不是 DB size_bytes：{json}"
    );
    assert_envelope(&json, "UNSUPPORTED_CONTENT");
}

#[tokio::test]
async fn event_file_association_branches_use_indexes() {
    let (fixture, _root, _ws) = setup_workspace("http-explain-eventfiles");
    let sql = "SELECT * FROM ( \
                 SELECT * FROM events WHERE workspace_id = 'w' AND subject_id = 'f_x' \
                 UNION \
                 SELECT e.* FROM revisions r CROSS JOIN events e \
                   WHERE r.file_id = 'f_x' AND e.revision_id = r.revision_id AND e.workspace_id = 'w' \
                 UNION \
                 SELECT * FROM events WHERE workspace_id = 'w' \
                   AND json_extract(payload_json,'$.file_id') = 'f_x' \
                 UNION \
                 SELECT * FROM events WHERE workspace_id = 'w' \
                   AND subject_id = 'path:' || (SELECT current_path FROM files WHERE file_id = 'f_x') \
               ) ORDER BY seq ASC";
    let mut stmt = fixture
        .conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("explain");
    let plan_text = stmt
        .query_map([], |r| r.get::<_, String>(3))
        .expect("explain 查询")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("explain 收集")
        .join(" | ");
    for expected in [
        "idx_events_ws_subject_seq",
        "idx_events_ws_revision_seq",
        "idx_events_ws_payload_file",
    ] {
        assert!(
            plan_text.contains(expected),
            "四路 UNION 分支应命中 {expected}：{plan_text}"
        );
    }
    assert!(
        !plan_text.contains("SCAN events"),
        "事件关联不应全表扫描：{plan_text}"
    );
}

#[tokio::test]
async fn file_summary_structural_cases() {
    let (fixture, root, ws_id) = setup_workspace("http-files-struct");

    fixture.file(
        &ws_id,
        "f_hist",
        "docs/hist.md",
        "md",
        "方案",
        "active",
        None,
    );
    fixture.revision(
        &ws_id,
        "f_hist",
        1,
        H_MD,
        100,
        Some("2026-06-10"),
        "day",
        Some("document_self"),
        1,
        "2026-06-10T00:00:00.000Z",
    );
    fixture.revision(
        &ws_id,
        "f_hist",
        2,
        H_SVG,
        110,
        Some("2026-06-01"),
        "day",
        Some("document_self"),
        0,
        "2026-06-05T00:00:00.000Z",
    );
    fixture.revision(
        &ws_id,
        "f_hist",
        3,
        H_PDF,
        120,
        Some("2026-06-02"),
        "day",
        Some("document_self"),
        1,
        "2026-06-06T00:00:00.000Z",
    );
    let r5 = fixture.revision(
        &ws_id,
        "f_hist",
        5,
        H_MD,
        130,
        Some("2026-06-03"),
        "day",
        Some("document_self"),
        1,
        "2026-06-08T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_hist'",
            rusqlite::params![r5],
        )
        .expect("回填");

    fixture.file(
        &ws_id,
        "f_nocur",
        "docs/nocur.md",
        "md",
        "交接",
        "active",
        None,
    );
    fixture.revision(
        &ws_id,
        "f_nocur",
        1,
        H_MD,
        10,
        Some("2026-05-01"),
        "day",
        Some("document_self"),
        0,
        "2026-05-01T00:00:00.000Z",
    );
    fixture.revision(
        &ws_id,
        "f_nocur",
        2,
        H_SVG,
        20,
        Some("2026-05-02"),
        "day",
        Some("document_self"),
        1,
        "2026-05-02T00:00:00.000Z",
    );

    let app = app_for(&fixture, &root, "inst_test000000031");
    let (_status, json) = get(&app, "/api/v1/files?dir=docs&q=hist").await;
    assert_eq!(
        json.pointer("/total_matched").and_then(|v| v.as_u64()),
        Some(1),
        "{json}"
    );
    let item = json.pointer("/items/0").cloned().expect("items[0]");

    assert_eq!(item.get("revision_count").and_then(|v| v.as_u64()), Some(4));
    assert_eq!(
        item.get("current_revision_id").and_then(|v| v.as_str()),
        Some(guanlan_core::domain::revision_id_of("f_hist", 5).as_str()),
        "last_revision_id 命中优先"
    );
    assert_eq!(
        item.get("first_source_time").and_then(|v| v.as_str()),
        Some("2026-06-10")
    );
    assert_eq!(
        item.get("snapshot_available").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        item.get("coverage").and_then(|v| v.as_str()),
        Some("full_text")
    );

    let (_status, j2) = get(&app, "/api/v1/files?q=nocur").await;
    let item2 = j2.pointer("/items/0").cloned().expect("items[0]");
    assert_eq!(
        item2.get("revision_count").and_then(|v| v.as_u64()),
        Some(2)
    );
    assert_eq!(
        item2.get("current_revision_id").and_then(|v| v.as_str()),
        Some(guanlan_core::domain::revision_id_of("f_nocur", 2).as_str()),
        "缺失 current 指针回退最高 seq"
    );
    assert_eq!(
        item2.get("snapshot_available").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        item2.get("first_source_time").and_then(|v| v.as_str()),
        Some("2026-05-01")
    );
}

#[tokio::test]
async fn events_pagination_and_cursor_stale() {
    let (fixture, root, _ws) = setup_workspace("http-events");
    let app = app_for(&fixture, &root, "inst_test000000005");

    let (status, p1) = get(&app, "/api/v1/events?kinds=modified&limit=1").await;
    assert_eq!(status, StatusCode::OK, "{p1}");
    assert_eq!(p1.pointer("/ok").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        p1.pointer("/index_generation").and_then(|v| v.as_u64()),
        Some(7)
    );
    assert_eq!(
        p1.pointer("/window/order").and_then(|v| v.as_str()),
        Some("occurred")
    );
    assert_eq!(
        p1.pointer("/window/kinds")
            .and_then(|v| v.as_array())
            .map(|a| a.len()),
        Some(1)
    );
    assert!(p1
        .pointer("/snapshot_max_seq")
        .and_then(|v| v.as_u64())
        .is_some());
    let items = p1
        .pointer("/items")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["occurred_at"], "2026-06-02");
    assert_eq!(items[0]["file_path"], "docs/b.md");
    assert_eq!(items[0]["format"], "md");
    assert_eq!(
        p1.pointer("/total_in_window").and_then(|v| v.as_u64()),
        Some(2)
    );
    assert_eq!(
        p1.pointer("/has_more").and_then(|v| v.as_bool()),
        Some(true)
    );
    let cursor = p1
        .pointer("/next_cursor")
        .and_then(|v| v.as_str())
        .expect("游标")
        .to_owned();

    let (status, p2) = get(
        &app,
        &format!("/api/v1/events?kinds=modified&limit=1&cursor={cursor}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{p2}");
    assert_eq!(
        p2.pointer("/items/0/occurred_at").and_then(|v| v.as_str()),
        Some("2026-06-01")
    );
    assert_eq!(
        p2.pointer("/has_more").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert!(
        p2.pointer("/next_cursor")
            .map(|v| v.is_null())
            .unwrap_or(false),
        "末页游标应为 null：{p2}"
    );

    let (status, bad) = get(
        &app,
        &format!("/api/v1/events?kinds=appeared&limit=1&cursor={cursor}"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_envelope(&bad, "CURSOR_STALE");
    assert_eq!(
        bad.pointer("/index_generation").and_then(|v| v.as_u64()),
        Some(7),
        "错误包络应携带 index_generation：{bad}"
    );

    let (status, bad2) = get(&app, "/api/v1/events?cursor=not-a-cursor").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_envelope(&bad2, "CURSOR_STALE");

    let (_status, u) = get(&app, "/api/v1/events?undated=1").await;
    assert_eq!(
        u.pointer("/window/undated").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        u.pointer("/items").and_then(|v| v.as_array()).map(Vec::len),
        Some(0)
    );
}

#[tokio::test]
async fn event_days_groups() {
    let (fixture, root, _ws) = setup_workspace("http-event-days");
    let app = app_for(&fixture, &root, "inst_test000000006");

    let (status, json) = get(&app, "/api/v1/events/days").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json.pointer("/ok").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        json.pointer("/granularity").and_then(|v| v.as_str()),
        Some("day")
    );
    assert_eq!(
        json.pointer("/order").and_then(|v| v.as_str()),
        Some("occurred")
    );
    let groups = json
        .pointer("/groups")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("groups");
    assert_eq!(groups.len(), 2, "两个有日期桶：{json}");
    assert_eq!(groups[0]["date"], "2026-06-02", "桶按日期倒序");
    assert_eq!(groups[0].get("count").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(
        groups[0]["by_kind"]
            .get("modified")
            .and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(groups[0]["samples"].as_array().map(Vec::len), Some(1));
    assert_eq!(groups[1]["date"], "2026-06-01", "基线+修改同桶");
    assert_eq!(groups[1].get("count").and_then(|v| v.as_u64()), Some(2));
    assert_eq!(json.pointer("/total").and_then(|v| v.as_u64()), Some(3));
    assert_eq!(
        json.pointer("/hidden_days").and_then(|v| v.as_u64()),
        Some(0)
    );
    assert_eq!(
        json.pointer("/undated_count").and_then(|v| v.as_u64()),
        Some(0)
    );

    let (_status, s1) = get(&app, "/api/v1/events/days?samples=1&limit_days=1").await;
    let g1 = s1
        .pointer("/groups")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("groups");
    assert_eq!(g1.len(), 1, "limit_days=1 只留最近一桶：{s1}");
    assert_eq!(s1.pointer("/hidden_days").and_then(|v| v.as_u64()), Some(1));
}

#[tokio::test]
async fn event_range_keeps_camel_case() {
    let (fixture, root, _ws) = setup_workspace("http-event-range");
    let app = app_for(&fixture, &root, "inst_test000000007");
    let (status, json) = get(&app, "/api/v1/events/range").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json.get("ok").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        json.get("occurredMin").and_then(|v| v.as_str()),
        Some("2026-06-01")
    );
    assert_eq!(
        json.get("occurredMax").and_then(|v| v.as_str()),
        Some("2026-06-02")
    );
    assert_eq!(json.get("undatedCount").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(
        json.get("index_generation").and_then(|v| v.as_u64()),
        Some(7)
    );
}

#[tokio::test]
async fn file_revisions_with_include() {
    let (fixture, root, _ws) = setup_workspace("http-revisions");
    let app = app_for(&fixture, &root, "inst_test000000008");

    let (status, json) = get(
        &app,
        "/api/v1/files/f_a/revisions?include=events,statements,edges",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(
        json.pointer("/file/file_id").and_then(|v| v.as_str()),
        Some("f_a")
    );
    assert_eq!(
        json.pointer("/file/current_path").and_then(|v| v.as_str()),
        Some("docs/a.md")
    );
    let revs = json
        .pointer("/revisions")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("revisions");
    assert_eq!(revs.len(), 1);
    assert_eq!(revs[0].get("seq").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(
        revs[0].get("snapshot_available").and_then(|v| v.as_bool()),
        Some(true)
    );
    let text = json.to_string();
    assert!(
        !text.contains("snapshot_path"),
        "版本行不下发服务端路径：{text}"
    );
    assert_eq!(
        json.pointer("/events")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(1),
        "四路覆盖只含 revision 链事件：{json}"
    );
    assert_eq!(
        json.pointer("/statements")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        json.pointer("/edges")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(2),
        "edges 按来源文件（e1+e2）"
    );

    let (_status, plain) = get(&app, "/api/v1/files/f_a/revisions").await;
    let plain_text = plain.to_string();
    assert!(
        !plain_text.contains("\"events\":"),
        "未请求 include 时不下发 events 段：{plain_text}"
    );

    let (status, nf) = get(&app, "/api/v1/files/f_nope/revisions").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_envelope(&nf, "NOT_FOUND");
}

#[tokio::test]
async fn file_revisions_total_travels_with_cursor_and_include_first_page_only() {
    let (fixture, root, ws_id) = setup_workspace("http-rev-total");
    let rb2 = fixture.revision(
        &ws_id,
        "f_a",
        2,
        H_MD,
        20,
        Some("2026-06-03"),
        "day",
        Some("document_self"),
        1,
        "2026-06-03T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_a'",
            rusqlite::params![rb2],
        )
        .expect("回填");
    let app = app_for(&fixture, &root, "inst_test000000021");

    let (status, p1) = get(
        &app,
        "/api/v1/files/f_a/revisions?order=seq_asc&limit=1&include=events",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{p1}");
    assert_eq!(
        p1.pointer("/total").and_then(|v| v.as_u64()),
        Some(2),
        "精确 COUNT（非 MAX(seq)）"
    );
    assert_eq!(
        p1.pointer("/events")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(1),
        "首页携带文件级事件集合"
    );
    let cursor = p1
        .pointer("/next_cursor")
        .and_then(|v| v.as_str())
        .expect("has_more 时必有游标")
        .to_owned();

    let (status, p2) = get(
        &app,
        &format!(
            "/api/v1/files/f_a/revisions?order=seq_asc&limit=1&include=events&cursor={cursor}"
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{p2}");
    assert_eq!(
        p2.pointer("/total").and_then(|v| v.as_u64()),
        Some(2),
        "total 随游标携带，续页一致"
    );
    assert!(
        p2.get("events").is_none(),
        "续页不携带 include 附集合：{p2}"
    );
    assert_eq!(
        p2.pointer("/revisions/0/seq").and_then(|v| v.as_i64()),
        Some(2)
    );
    assert_eq!(
        p2.pointer("/has_more").and_then(|v| v.as_bool()),
        Some(false)
    );
}

#[tokio::test]
async fn file_detail_reader_compat() {
    let (fixture, root, _ws) = setup_workspace("http-detail");
    let app = app_for(&fixture, &root, "inst_test000000009");

    let (status, json) = get(&app, "/api/v1/files/f_svg/detail").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let revs = json
        .pointer("/revisions")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("revisions");
    assert_eq!(revs.len(), 1, "只返回当前版（夹具单版本文件）");
    assert_eq!(
        revs[0].get("versionNumber").and_then(|v| v.as_i64()),
        Some(1),
        "阅读器链路保留 camelCase"
    );
    assert_eq!(
        revs[0].get("snapshotAvailable").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        revs[0].get("isBaselineProtected").and_then(|v| v.as_bool()),
        Some(true),
        "v1 受基线保护"
    );
    assert!(
        revs[0].get("svgSource").is_none(),
        "SVG 也不内联正文：{json}"
    );
    assert!(revs[0].get("svgExtractedTexts").is_none());
    let detail_text = json.to_string();
    assert!(
        !detail_text.contains(SVG_SRC),
        "detail 不携带 SVG 快照源文：{detail_text}"
    );
    assert!(json.get("events").is_some(), "附集合字段保留（限额 200）");

    let (_status, md) = get(&app, "/api/v1/files/f_a/detail").await;
    assert!(
        md.pointer("/revisions/0/svgSource").is_none(),
        "MD 不内联正文：{md}"
    );
    assert!(
        !md.to_string().contains("body text"),
        "detail 不携带 md 正文（按需经 content 端点）"
    );
}

#[tokio::test]
async fn revision_content_three_shapes() {
    let (fixture, root, _ws) = setup_workspace("http-content");
    let app = app_for(&fixture, &root, "inst_test000000010");
    let ra = guanlan_core::domain::revision_id_of("f_a", 1);
    let rp = guanlan_core::domain::revision_id_of("f_pdf", 1);
    let rg = guanlan_core::domain::revision_id_of("f_gone", 1);

    let (status, json) = get(&app, &format!("/api/v1/revisions/{ra}/content")).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json.get("format").and_then(|v| v.as_str()), Some("md"));
    assert_eq!(
        json.get("text").and_then(|v| v.as_str()),
        Some("# body text")
    );
    assert!(
        json.get("raw_url").is_none(),
        "非 PDF 不出现 raw_url：{json}"
    );

    let (status, pdf) = get(&app, &format!("/api/v1/revisions/{rp}/content")).await;
    assert_eq!(status, StatusCode::OK, "{pdf}");
    assert_eq!(pdf.get("format").and_then(|v| v.as_str()), Some("pdf"));
    assert_eq!(
        pdf.get("raw_url").and_then(|v| v.as_str()),
        Some(format!("/api/v1/revisions/{rp}/content?raw=1").as_str()),
        "raw_url 指自身 v1 路径（契约 §1.8）"
    );
    assert!(pdf.get("text").is_none(), "PDF 默认不带 text：{pdf}");

    let (status, headers, bytes) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{rp}/content?raw=1"))
            .body(Body::empty())
            .expect("请求构建"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get("content-type").and_then(|v| v.to_str().ok()),
        Some("application/pdf")
    );
    assert_eq!(bytes, b"%PDF-1.4 fake".to_vec(), "raw 流应为快照原字节");

    let (status, gone) = get(&app, &format!("/api/v1/revisions/{rg}/content")).await;
    assert_eq!(status, StatusCode::GONE);
    assert_envelope(&gone, "SNAPSHOT_UNAVAILABLE");
    assert_eq!(
        gone.pointer("/index_generation").and_then(|v| v.as_u64()),
        Some(7)
    );

    let (status, nf) = get(&app, "/api/v1/revisions/f_a_r99/content").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_envelope(&nf, "NOT_FOUND");
}

#[tokio::test]
async fn decisions_and_relations() {
    let (fixture, root, _ws) = setup_workspace("http-decisions");
    let app = app_for(&fixture, &root, "inst_test000000011");

    let (status, json) = get(&app, "/api/v1/decisions").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json.pointer("/total").and_then(|v| v.as_u64()), Some(1));
    let items = json
        .pointer("/items")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("items");
    assert_eq!(items[0]["code"], "Q1");
    assert_eq!(items[0]["status"], "待确认");
    assert_eq!(
        items[0].get("isCandidateOnly").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        items[0]
            .get("evidences")
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(items[0]["evidences"][0]["claimedStatus"], "待确认");
    assert_eq!(
        json.pointer("/snapshot_generation")
            .and_then(|v| v.as_u64()),
        Some(7)
    );

    let (_status, hit) = get(&app, "/api/v1/decisions?code=Q1").await;
    assert_eq!(hit.pointer("/total").and_then(|v| v.as_u64()), Some(1));
    let (_status, miss) = get(&app, "/api/v1/decisions?code=Q9").await;
    assert_eq!(miss.pointer("/total").and_then(|v| v.as_u64()), Some(0));

    let (status, rel) = get(&app, "/api/v1/relations").await;
    assert_eq!(status, StatusCode::OK, "{rel}");
    let items = rel
        .pointer("/items")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("items");
    assert_eq!(items.len(), 1, "unresolved:x 应被过滤：{rel}");
    assert_eq!(items[0]["type"], "explicit_reference");
    assert_eq!(items[0]["target_id"], "f_b");
    assert_eq!(items[0]["label"], "显式引用（收录版本）");
    assert_eq!(
        items[0]["locator"]
            .get("startLine")
            .and_then(|v| v.as_u64()),
        Some(1),
        "locator camelCase"
    );
}

#[tokio::test]
async fn stubs_and_unknown_routes() {
    let (fixture, root, _ws) = setup_workspace("http-stubs");
    let app = app_for(&fixture, &root, "inst_test000000012");

    let (status, json) = get(&app, "/api/v1/search").await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "search 已交付，缺 q 走 400"
    );
    assert_envelope(&json, "BAD_REQUEST");

    let (status, json) = get(&app, "/api/v1/graph").await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "graph 端点维持 501");
    assert_envelope(&json, "NOT_IMPLEMENTED");

    let (status, _json) = send(
        &app,
        Request::builder()
            .method("POST")
            .uri("/api/v1/diff")
            .body(Body::empty())
            .expect("请求构建"),
    )
    .await
    .pipe(|(s, _h, b)| {
        (
            s,
            serde_json::from_slice::<serde_json::Value>(&b).unwrap_or(serde_json::Value::Null),
        )
    });
    assert_ne!(
        status,
        StatusCode::NOT_IMPLEMENTED,
        "diff 已实现（缺 body 走 400）"
    );

    let (status, json) = get(&app, "/api/v1/unknown").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_envelope(&json, "NOT_FOUND");
}

#[tokio::test]
async fn dist_static_mounting() {
    let (fixture, root, _ws) = setup_workspace("http-dist");
    let dist_dir = fixture.dir.join("dist");
    std::fs::create_dir_all(dist_dir.join("assets")).expect("建 dist 目录");
    std::fs::write(
        dist_dir.join("index.html"),
        "<!doctype html><title>guanlan</title>",
    )
    .expect("写 index.html");
    std::fs::write(dist_dir.join("assets").join("app.js"), "console.log('ok');")
        .expect("写 app.js");

    let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
    store.claim_workspace(&root).expect("认领");
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_test000000013".to_owned(),
        jobs: crate::index_jobs::IndexJobManager::idle(),
        watcher: None,
        notices: None,
        dist: Some(dist_dir.clone()),
    });

    let (status, headers, bytes) = send(
        &app,
        Request::builder().uri("/").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ctype = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(
        ctype.starts_with("text/html"),
        "index.html 应按 text/html 回：{ctype}"
    );
    assert!(std::str::from_utf8(&bytes).unwrap().contains("guanlan"));

    let (status, headers, bytes) = send(
        &app,
        Request::builder()
            .uri("/assets/app.js")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .contains("javascript"));
    assert_eq!(bytes, b"console.log('ok');".to_vec());

    let (status, _h, bytes) = send(
        &app,
        Request::builder()
            .uri("/some/spa/route")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "SPA 回退应返回 index.html");
    assert!(std::str::from_utf8(&bytes).unwrap().contains("guanlan"));

    let (status, json) = get(&app, "/api/v1/unknown").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_envelope(&json, "NOT_FOUND");

    let (status, json) = get(&app, "/api/v1/status").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json.pointer("/ok").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn no_dist_falls_back_to_envelope() {
    let (fixture, root, _ws) = setup_workspace("http-no-dist");
    let app = app_for(&fixture, &root, "inst_test000000014");
    let (status, _h, bytes) = send(
        &app,
        Request::builder().uri("/").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json =
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or(serde_json::Value::Null);
    assert_envelope(&json, "NOT_FOUND");
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

fn exec_config(wait_ms: u64, exec_ms: u64, max_waiters: usize) -> QueryConfig {
    QueryConfig {
        wait_deadline: std::time::Duration::from_millis(wait_ms),
        exec_deadline: std::time::Duration::from_millis(exec_ms),
        max_waiters,
    }
}

fn exec_for(fixture: &Fixture, root: &str, pool: usize, config: QueryConfig) -> Arc<QueryExecutor> {
    let stores = (0..pool)
        .map(|_| {
            let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
            store.claim_workspace(root).expect("认领夹具工作区失败");
            store
        })
        .collect();
    Arc::new(QueryExecutor::with_config(stores, config))
}

#[tokio::test]
async fn bounded_executor_saturates_deterministically() {
    let (fixture, root, _ws) = setup_workspace("http-exec-sat");
    let exec = exec_for(&fixture, &root, 1, exec_config(120, 10_000, 1));

    let exec_a = exec.clone();
    let heavy = tokio::spawn(async move {
        exec_a
            .run(|_store| {
                std::thread::sleep(std::time::Duration::from_millis(350));
                Ok(0u32)
            })
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;

    let exec_b = exec.clone();
    let queued = tokio::spawn(async move { exec_b.run(|_store| Ok(1u32)).await });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;

    let c_started = std::time::Instant::now();
    let rejected = exec.run(|_store| Ok(2u32)).await;
    assert!(
        matches!(rejected, Err(GuanlanError::IndexBusy)),
        "队列满员应立即返回 INDEX_BUSY，实际 {rejected:?}"
    );
    assert!(
        c_started.elapsed() < std::time::Duration::from_millis(50),
        "满员拒绝应是确定性的，实际耗时 {:?}",
        c_started.elapsed()
    );

    let b_result = tokio::time::timeout(std::time::Duration::from_secs(3), queued)
        .await
        .expect("排队 deadline 后应返回而非挂起");
    assert!(matches!(b_result, Ok(Err(GuanlanError::IndexBusy))));

    let heavy_result = tokio::time::timeout(std::time::Duration::from_secs(3), heavy)
        .await
        .expect("重查询应完成");
    assert!(matches!(heavy_result, Ok(Ok(0))));

    let after = exec.run(|store| store.workspace().map(|_| 3u32)).await;
    assert!(matches!(after, Ok(3)), "归池后应可继续服务，实际 {after:?}");
}

#[tokio::test]
async fn light_request_proceeds_while_heavy_query_holds_one_connection() {
    let (fixture, root, _ws) = setup_workspace("http-exec-iso");
    let exec = exec_for(&fixture, &root, 2, exec_config(5_000, 30_000, 8));

    let exec_a = exec.clone();
    let heavy = tokio::spawn(async move {
        exec_a
            .run(|_store| {
                std::thread::sleep(std::time::Duration::from_millis(400));
                Ok(0u32)
            })
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;

    let started = std::time::Instant::now();
    let light = exec.run(|store| store.workspace().map(|_| 1u32)).await;
    let elapsed = started.elapsed();
    assert!(matches!(light, Ok(1)), "轻量请求应成功，实际 {light:?}");
    assert!(
        elapsed < std::time::Duration::from_millis(250),
        "轻量请求不应等待重查询（隔离读连接），实际耗时 {elapsed:?}"
    );
    heavy
        .await
        .expect("重查询任务应完成")
        .expect("重查询应成功");
}

#[tokio::test]
async fn cancel_releases_capacity_promptly() {
    let (fixture, root, _ws) = setup_workspace("http-exec-cancel");
    let exec = exec_for(&fixture, &root, 1, exec_config(5_000, 30_000, 8));

    let heavy = exec.run(|store| {
        for _ in 0..500_000 {
            store.workspace()?;
        }
        Ok(0u32)
    });
    let raced = tokio::time::timeout(std::time::Duration::from_millis(80), heavy).await;
    assert!(raced.is_err(), "长查询 80ms 内不会自然完成，应被丢弃");

    let started = std::time::Instant::now();
    let after = exec.run(|store| store.workspace().map(|_| 7u32)).await;
    assert!(matches!(after, Ok(7)), "取消后应能继续服务，实际 {after:?}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "取消后容量应尽快归还，实际耗时 {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn generation_cached_for_error_envelope_on_first_request() {
    let (fixture, root, _ws) = setup_workspace("http-exec-gen");
    let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
    store.claim_workspace(&root).expect("认领夹具工作区失败");
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_gen0000000001".to_owned(),
        jobs: crate::index_jobs::IndexJobManager::idle(),
        watcher: None,
        notices: None,
        dist: None,
    });
    let (status, _h, bytes) = send(
        &app,
        Request::builder()
            .uri("/api/v1/files/no-such-file-id/revisions")
            .body(Body::empty())
            .expect("请求构建"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json =
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or(serde_json::Value::Null);
    assert_envelope(&json, "NOT_FOUND");
    assert_eq!(
        json["index_generation"], 7,
        "错误包络应携带查询内刷新的代际"
    );
}

async fn post_json(app: &axum::Router, uri: &str, body: &str) -> (StatusCode, serde_json::Value) {
    let (status, _headers, bytes) = send(
        app,
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .expect("请求构建"),
    )
    .await;
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

fn app_with_jobs(tag: &str) -> (axum::Router, String, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!("guanlan-svc-jobs-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws_root = base.join("workspace");
    let data_dir = base.join("data");
    std::fs::create_dir_all(&ws_root).expect("建工作区目录");
    std::fs::create_dir_all(&data_dir).expect("建数据目录");
    std::fs::write(ws_root.join("a.md"), "# A\n\n正文 2026-01-02 的材料\n").expect("写文件");
    std::fs::create_dir_all(ws_root.join("docs")).expect("建子目录");
    std::fs::write(ws_root.join("docs/b.md"), "# B\n").expect("写文件");
    let root = ws_root.to_string_lossy().into_owned();

    let writer = guanlan_core::index::Writer::open_at(&data_dir, &root).expect("打开写库失败");
    let jobs = crate::index_jobs::IndexJobManager::start(writer);

    let (fixture, fixture_root, _ws) = setup_workspace(tag);
    let mut store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库失败");
    store
        .claim_workspace(&fixture_root)
        .expect("认领夹具工作区失败");
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_jobs".to_owned(),
        jobs,
        dist: None,
        watcher: None,
        notices: None,
    });
    (app, root, base)
}

#[tokio::test]
async fn index_jobs_accept_and_run_to_completion() {
    let (app, _root, base) = app_with_jobs("run");

    let (status, json) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"verify_all"}"#).await;
    assert_eq!(status, StatusCode::ACCEPTED, "受理应回 202：{json}");
    assert_eq!(json["ok"], true);
    let job_id = json["job_id"].as_str().expect("应有 job_id").to_owned();
    assert!(!job_id.is_empty());

    let mut final_json = serde_json::Value::Null;
    for _ in 0..100 {
        let (status, body) = get(&app, &format!("/api/v1/jobs/{job_id}")).await;
        assert_eq!(status, StatusCode::OK, "查任务状态应 200");
        let state = body["state"].as_str().unwrap_or("").to_owned();
        if state == "completed" || state == "failed" {
            final_json = body;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(final_json["state"], "completed", "对账应完成：{final_json}");
    assert_eq!(final_json["kind"], "verify_all");
    assert_eq!(final_json["phase"], "done");
    assert_eq!(final_json["report"]["scanned"], 2);
    assert_eq!(final_json["report"]["new_files"], 2);
    assert!(
        final_json["index_generation"].as_u64().unwrap_or(0) >= 1,
        "完成后应有索引代：{final_json}"
    );
    assert!(final_json["last_scan_at"].is_string());

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn index_jobs_merge_duplicate_submissions() {
    let (app, _root, base) = app_with_jobs("merge");

    let (_status, first) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"verify_all"}"#).await;
    let (_status, second) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"verify_all"}"#).await;
    let first_id = first["job_id"].as_str().unwrap_or("").to_owned();
    let second_id = second["job_id"].as_str().unwrap_or("").to_owned();
    assert_eq!(first_id, second_id, "重复重扫应并入同一任务");
    assert_eq!(second["merged"], true);

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn index_jobs_reject_unsupported_kind() {
    let (app, _root, base) = app_with_jobs("reject");

    let (status, json) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"changed_paths"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_envelope(&json, "BAD_REQUEST");

    let (status, json) = post_json(&app, "/api/v1/index-jobs", "{not json").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_envelope(&json, "BAD_REQUEST");

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn job_status_unknown_id_is_not_found() {
    let (app, _root, base) = app_with_jobs("unknown");
    let (status, json) = get(&app, "/api/v1/jobs/job_nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_envelope(&json, "NOT_FOUND");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn b01_open_formats_storage_stats_and_policy_roundtrip() {
    let base = std::env::temp_dir().join(format!("guanlan-svc-b01-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws_root = base.join("workspace");
    let data_dir = base.join("data");
    std::fs::create_dir_all(ws_root.join("src")).unwrap();
    std::fs::create_dir_all(ws_root.join("assets")).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(ws_root.join(".gitignore"), "*.log\n").unwrap();
    std::fs::write(ws_root.join("skip.log"), "ignored").unwrap();
    std::fs::write(ws_root.join("src/index.ts"), "export const x = 1;\n").unwrap();
    let png_bytes = b"\x89PNG\r\n\x1a\nfake-png-bytes";
    std::fs::write(ws_root.join("assets/logo.png"), png_bytes).unwrap();
    std::fs::write(ws_root.join("assets/video.mp4"), b"fake-mp4-video").unwrap();

    let root = ws_root.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root).unwrap();
    let report = guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();
    assert_eq!(report.metadata_only_revisions, 1);

    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let mut store = ReadonlyStore::open_at(&data_dir, &root).unwrap();
    store.claim_workspace(&root).unwrap();
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_b01".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st_ts, j_ts) = get(&app, "/api/v1/files?format=ts").await;
    assert_eq!(st_ts, StatusCode::OK);
    assert_eq!(j_ts["items"].as_array().unwrap().len(), 1);
    assert_eq!(j_ts["items"][0]["relative_path"], "src/index.ts");

    let (st_cls, j_cls) = get(&app, "/api/v1/files?format=class:image").await;
    assert_eq!(st_cls, StatusCode::OK);
    assert_eq!(j_cls["items"].as_array().unwrap().len(), 1);
    assert_eq!(j_cls["items"][0]["relative_path"], "assets/logo.png");
    let png_rev = j_cls["items"][0]["current_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (st_vid, j_vid) = get(&app, "/api/v1/files?format=mp4").await;
    assert_eq!(st_vid, StatusCode::OK);
    assert_eq!(j_vid["items"][0]["snapshot_available"], false);
    let mp4_rev = j_vid["items"][0]["current_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (st_png_meta, j_png_meta) =
        get(&app, &format!("/api/v1/revisions/{png_rev}/content")).await;
    assert_eq!(st_png_meta, StatusCode::OK);
    assert!(j_png_meta["raw_url"].as_str().unwrap().contains("raw=1"));
    let (st_png_raw, headers_png, bytes_png) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{png_rev}/content?raw=1"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_png_raw, StatusCode::OK);
    assert_eq!(
        headers_png
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("image/png")
    );
    assert_eq!(bytes_png.as_slice(), png_bytes);

    let (st_mp4, j_mp4) = get(&app, &format!("/api/v1/revisions/{mp4_rev}/content")).await;
    assert_eq!(st_mp4, StatusCode::GONE);
    assert_envelope(&j_mp4, "SNAPSHOT_UNAVAILABLE");

    let (st_stats, j_stats) = get(&app, "/api/v1/storage/stats").await;
    assert_eq!(st_stats, StatusCode::OK);
    assert_eq!(j_stats["gitignore_respected"], true);
    assert_eq!(j_stats["metadata_only_revisions"], 1);
    assert!(j_stats["total_disk_bytes"].as_u64().unwrap() > 0);
    assert_eq!(j_stats["policy"]["text_max_mib"], 10);
    assert_eq!(j_stats["policy"]["binary_max_mib"], 50);

    let (st_bad, j_bad) = post_json(
        &app,
        "/api/v1/storage/policy",
        r#"{"text_max_mib":0,"binary_max_mib":50}"#,
    )
    .await;
    assert_eq!(st_bad, StatusCode::BAD_REQUEST);
    assert_envelope(&j_bad, "BAD_REQUEST");

    let (st_pol, j_pol) = post_json(
        &app,
        "/api/v1/storage/policy",
        r#"{"text_max_mib":25,"binary_max_mib":120}"#,
    )
    .await;
    assert_eq!(st_pol, StatusCode::OK);
    assert_eq!(j_pol["policy"]["text_max_mib"], 25);
    assert_eq!(j_pol["policy"]["binary_max_mib"], 120);

    let (st_stats2, j_stats2) = get(&app, "/api/v1/storage/stats").await;
    assert_eq!(st_stats2, StatusCode::OK);
    assert_eq!(j_stats2["policy"]["text_max_mib"], 25);
    assert_eq!(j_stats2["policy"]["binary_max_mib"], 120);

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn b02_quick_preview_and_thumbnail_endpoints() {
    let base = std::env::temp_dir().join(format!("guanlan-svc-b02-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws_root = base.join("workspace");
    let data_dir = base.join("data");
    std::fs::create_dir_all(ws_root.join("src")).unwrap();
    std::fs::create_dir_all(ws_root.join("assets")).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();

    let mut csv_body = String::from("id,name,amount\n");
    for i in 1..=120 {
        csv_body.push_str(&format!("{i},观澜条目-{i},{:.2}\n", i as f64 * 1.5));
    }
    std::fs::write(ws_root.join("src/ledger.csv"), &csv_body).unwrap();

    let mut png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png_bytes.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
    png_bytes.extend_from_slice(&640u32.to_be_bytes());
    png_bytes.extend_from_slice(&360u32.to_be_bytes());
    png_bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    std::fs::write(ws_root.join("assets/banner.png"), &png_bytes).unwrap();

    std::fs::write(ws_root.join("assets/demo.mp4"), b"MP4-v1-bytes-12345").unwrap();

    let root = ws_root.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root).unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();

    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(
        ws_root.join("assets/demo.mp4"),
        b"MP4-v2-bytes-longer-payload-1234567890",
    )
    .unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();

    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let mut store = ReadonlyStore::open_at(&data_dir, &root).unwrap();
    store.claim_workspace(&root).unwrap();
    let app = crate::http::build_router_with_desktop_cors(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_b02".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st_files, j_files) = get(&app, "/api/v1/files?limit=20").await;
    assert_eq!(st_files, StatusCode::OK);
    let items = j_files["items"].as_array().unwrap();
    let csv_rev = items
        .iter()
        .find(|i| i["relative_path"] == "src/ledger.csv")
        .unwrap()["current_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let png_rev = items
        .iter()
        .find(|i| i["relative_path"] == "assets/banner.png")
        .unwrap()["current_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mp4_rev = items
        .iter()
        .find(|i| i["relative_path"] == "assets/demo.mp4")
        .unwrap()["current_revision_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (st_csv1, h_csv1, b_csv1) = send(
        &app,
        Request::builder()
            .uri(format!(
                "/api/v1/revisions/{csv_rev}/preview?max_bytes=1024"
            ))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_csv1, StatusCode::OK);
    let j_csv1: serde_json::Value = serde_json::from_slice(&b_csv1).unwrap();
    assert_eq!(j_csv1["preview_kind"], "table");
    assert_eq!(j_csv1["truncated"], true);
    let slice1 = j_csv1["text_slice"].as_str().unwrap();
    assert!(!slice1.is_empty());
    let next_off =
        j_csv1["slice_offset"].as_u64().unwrap() + j_csv1["slice_bytes"].as_u64().unwrap();
    assert!(next_off <= 1024);

    let etag_csv = h_csv1.get("etag").unwrap().to_str().unwrap().to_owned();
    let (st_304, _, _) = send(
        &app,
        Request::builder()
            .uri(format!(
                "/api/v1/revisions/{csv_rev}/preview?max_bytes=1024"
            ))
            .header("if-none-match", etag_csv)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_304, StatusCode::NOT_MODIFIED);

    let (st_png, j_png) = get(&app, &format!("/api/v1/revisions/{png_rev}/preview")).await;
    assert_eq!(st_png, StatusCode::OK);
    assert_eq!(j_png["preview_kind"], "image");
    assert_eq!(j_png["image_meta"]["width"], 640);
    assert_eq!(j_png["image_meta"]["height"], 360);
    assert!(j_png["thumbnail_url"]
        .as_str()
        .unwrap()
        .ends_with("/thumbnail"));

    let (st_th_range, h_th_range, b_th_range) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{png_rev}/thumbnail"))
            .header("origin", "http://tauri.localhost")
            .header("range", "bytes=0-7")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_th_range, StatusCode::PARTIAL_CONTENT);
    assert_eq!(b_th_range.as_slice(), &png_bytes[0..8]);
    assert_eq!(
        h_th_range.get("content-range").unwrap().to_str().unwrap(),
        format!("bytes 0-7/{}", png_bytes.len())
    );
    assert!(h_th_range.get("access-control-expose-headers").is_some());

    let (st_th_csv, j_th_csv) = get(&app, &format!("/api/v1/revisions/{csv_rev}/thumbnail")).await;
    assert_eq!(st_th_csv, StatusCode::PAYLOAD_TOO_LARGE);
    assert_envelope(&j_th_csv, "UNSUPPORTED_CONTENT");

    let (st_mp4, j_mp4) = get(&app, &format!("/api/v1/revisions/{mp4_rev}/preview")).await;
    assert_eq!(st_mp4, StatusCode::OK);
    assert_eq!(j_mp4["preview_kind"], "binary");
    assert_eq!(j_mp4["snapshot_available"], false);
    assert_eq!(j_mp4["revision_count"], 2);
    let hist = j_mp4["history"].as_array().unwrap();
    assert_eq!(hist.len(), 2);
    assert_eq!(hist[0]["seq"], 2);
    assert!(hist[0]["delta_bytes"].as_i64().unwrap() > 0);
    assert_eq!(hist[1]["seq"], 1);
    assert!(hist[1]["delta_bytes"].is_null());

    let (st_th_mp4, j_th_mp4) = get(&app, &format!("/api/v1/revisions/{mp4_rev}/thumbnail")).await;
    assert_eq!(st_th_mp4, StatusCode::GONE);
    assert_envelope(&j_th_mp4, "SNAPSHOT_UNAVAILABLE");

    let (st_missing, j_missing) = get(&app, "/api/v1/revisions/rev_does_not_exist/preview").await;
    assert_eq!(st_missing, StatusCode::NOT_FOUND);
    assert_envelope(&j_missing, "NOT_FOUND");

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}

fn build_stored_zip_for_http_test(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    struct Meta {
        name: Vec<u8>,
        len: u32,
        offset: u32,
    }
    let mut metas = Vec::new();
    for (name, data) in files {
        let offset = buf.len() as u32;
        let name_bytes = name.as_bytes().to_vec();
        let len = data.len() as u32;
        buf.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]);
        buf.extend_from_slice(&20u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&len.to_le_bytes());
        buf.extend_from_slice(&len.to_le_bytes());
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&name_bytes);
        buf.extend_from_slice(data);
        metas.push(Meta {
            name: name_bytes,
            len,
            offset,
        });
    }
    let cd_offset = buf.len() as u32;
    for m in &metas {
        buf.extend_from_slice(&[0x50, 0x4B, 0x01, 0x02]);
        buf.extend_from_slice(&20u16.to_le_bytes());
        buf.extend_from_slice(&20u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&m.len.to_le_bytes());
        buf.extend_from_slice(&m.len.to_le_bytes());
        buf.extend_from_slice(&(m.name.len() as u16).to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&m.offset.to_le_bytes());
        buf.extend_from_slice(&m.name);
    }
    let cd_size = (buf.len() as u32) - cd_offset;
    let count = metas.len() as u16;
    buf.extend_from_slice(&[0x50, 0x4B, 0x05, 0x06]);
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf.extend_from_slice(&count.to_le_bytes());
    buf.extend_from_slice(&count.to_le_bytes());
    buf.extend_from_slice(&cd_size.to_le_bytes());
    buf.extend_from_slice(&cd_offset.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf
}

#[tokio::test]
async fn b03_office_endpoints_and_decision_evidence_anchoring() {
    let base = std::env::temp_dir().join(format!("guanlan-svc-b03-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws_root = base.join("workspace");
    let data_dir = base.join("data");
    std::fs::create_dir_all(ws_root.join("specs")).unwrap();
    std::fs::create_dir_all(ws_root.join("decisions")).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();

    let wb = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="BOM" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
    let sst = r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Item</t></si>
  <si><t>Total</t></si>
  <si><t>Sensor</t></si>
</sst>"#;
    let s1 = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42.5</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Cable</t></is></c><c r="B3"><f>B2*2</f><v>85</v></c></row>
  </sheetData>
</worksheet>"#;
    let xlsx_bytes = build_stored_zip_for_http_test(&[
        ("xl/workbook.xml", wb.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
        ("xl/sharedStrings.xml", sst.as_bytes()),
        ("xl/worksheets/sheet1.xml", s1.as_bytes()),
    ]);

    let doc_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>方案评审</w:t></w:r></w:p>
    <w:p><w:r><w:t>[P1 - 待确认] 接口协议是否冻结？</w:t></w:r></w:p>
  </w:body>
</w:document>"#;
    let docx_bytes = build_stored_zip_for_http_test(&[("word/document.xml", doc_xml.as_bytes())]);

    std::fs::write(ws_root.join("specs/bom.xlsx"), &xlsx_bytes).unwrap();
    std::fs::write(ws_root.join("specs/plan.docx"), &docx_bytes).unwrap();
    std::fs::write(
        ws_root.join("specs/locked.docx"),
        [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00],
    )
    .unwrap();
    std::fs::write(
        ws_root.join("decisions/cost.md"),
        "[P0 - 待确认] 核定 BOM 预算是否按 B2:B3 执行？\n参考：[BOM 表](../specs/bom.xlsx#BOM!B2:B3)\n待确认\n",
    )
    .unwrap();

    let root = ws_root.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root).unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();

    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let mut store = ReadonlyStore::open_at(&data_dir, &root).unwrap();
    store.claim_workspace(&root).unwrap();
    let app = crate::http::build_router_with_desktop_cors(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_b03".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st_files, j_files) = get(&app, "/api/v1/files?limit=50").await;
    assert_eq!(st_files, StatusCode::OK);
    let items = j_files["items"].as_array().unwrap();
    let bom_item = items
        .iter()
        .find(|i| i["relative_path"] == "specs/bom.xlsx")
        .unwrap();
    let docx_item = items
        .iter()
        .find(|i| i["relative_path"] == "specs/plan.docx")
        .unwrap();
    let locked_item = items
        .iter()
        .find(|i| i["relative_path"] == "specs/locked.docx")
        .unwrap();
    let md_item = items
        .iter()
        .find(|i| i["relative_path"] == "decisions/cost.md")
        .unwrap();
    assert_eq!(bom_item["coverage"], "office_structured");
    assert_eq!(docx_item["coverage"], "office_structured");
    assert_eq!(locked_item["coverage"], "filename_only");

    let bom_rev = bom_item["current_revision_id"].as_str().unwrap();
    let docx_rev = docx_item["current_revision_id"].as_str().unwrap();
    let locked_rev = locked_item["current_revision_id"].as_str().unwrap();
    let md_rev = md_item["current_revision_id"].as_str().unwrap();

    let (st_prev, j_prev) = get(&app, &format!("/api/v1/revisions/{bom_rev}/preview")).await;
    assert_eq!(st_prev, StatusCode::OK);
    assert_eq!(j_prev["preview_kind"], "office");
    assert_eq!(j_prev["office_summary"]["status"], "indexed");
    assert_eq!(j_prev["office_summary"]["sheet_names"][0], "BOM");

    let (st_prev_locked, j_prev_locked) =
        get(&app, &format!("/api/v1/revisions/{locked_rev}/preview")).await;
    assert_eq!(st_prev_locked, StatusCode::OK);
    assert_eq!(j_prev_locked["preview_kind"], "binary");
    assert_eq!(j_prev_locked["office_summary"]["status"], "encrypted");

    let (st_off, h_off, b_off) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{bom_rev}/office"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_off, StatusCode::OK);
    let j_off: serde_json::Value = serde_json::from_slice(&b_off).unwrap();
    assert_eq!(j_off["status"], "indexed");
    assert_eq!(j_off["xlsx"]["sheets"][0]["name"], "BOM");
    assert_eq!(
        j_off["xlsx"]["sheets"][0]["numeric_summaries"][0]["cell_range"],
        "B2:B3"
    );

    let etag_off = h_off.get("etag").unwrap().to_str().unwrap().to_owned();
    let (st_off_304, _, _) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{bom_rev}/office"))
            .header("if-none-match", etag_off)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_off_304, StatusCode::NOT_MODIFIED);

    let (st_docx, j_docx) = get(&app, &format!("/api/v1/revisions/{docx_rev}/office")).await;
    assert_eq!(st_docx, StatusCode::OK);
    assert_eq!(j_docx["docx"]["headings"][0]["text"], "方案评审");

    let (st_md_err, j_md_err) = get(&app, &format!("/api/v1/revisions/{md_rev}/office")).await;
    assert_eq!(st_md_err, StatusCode::BAD_REQUEST);
    assert_envelope(&j_md_err, "BAD_REQUEST");

    let (st_nf, j_nf) = get(&app, "/api/v1/revisions/rev_missing/office").await;
    assert_eq!(st_nf, StatusCode::NOT_FOUND);
    assert_envelope(&j_nf, "NOT_FOUND");

    let (st_dec, j_dec) = get(&app, "/api/v1/decisions").await;
    assert_eq!(st_dec, StatusCode::OK);
    let decs = j_dec["items"].as_array().unwrap();
    let cost_dec = decs
        .iter()
        .find(|d| d["question"].as_str().unwrap().contains("核定 BOM 预算"))
        .unwrap();
    let bom_ev = cost_dec["evidences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["relative_path"] == "specs/bom.xlsx")
        .unwrap();
    assert_eq!(bom_ev["officeAnchor"]["kind"], "xlsx_range");
    assert_eq!(bom_ev["officeAnchor"]["sheet"], "BOM");
    assert_eq!(bom_ev["officeAnchor"]["cellRange"], "B2:B3");

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}

fn build_simple_pdf_for_http_test(page_bodies: &[&[u8]]) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = Vec::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(Vec::new());
    let n = page_bodies.len();
    let font_obj = 3 + n * 2;
    let mut kids = Vec::new();
    for (i, body) in page_bodies.iter().enumerate() {
        let page_obj = 3 + i * 2;
        let cont_obj = page_obj + 1;
        kids.push(format!("{page_obj} 0 R"));
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_obj} 0 R >> >> /Contents {cont_obj} 0 R >>"
            )
            .into_bytes(),
        );
        let mut stream = format!("<< /Length {} >>\nstream\n", body.len()).into_bytes();
        stream.extend_from_slice(body);
        stream.extend_from_slice(b"\nendstream");
        objects.push(stream);
    }
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());
    objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), n).into_bytes();

    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n");
    let mut offsets = Vec::with_capacity(objects.len());
    for (idx, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", idx + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_off = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_off}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

#[tokio::test]
async fn b04_pdf_page_extracts_and_decision_evidence_anchoring() {
    let base = std::env::temp_dir().join(format!("guanlan-svc-b04-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws_root = base.join("workspace");
    let data_dir = base.join("data");
    std::fs::create_dir_all(ws_root.join("specs")).unwrap();
    std::fs::create_dir_all(ws_root.join("decisions")).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();

    let spec_pdf = build_simple_pdf_for_http_test(&[
        b"BT /F1 12 Tf 72 720 Td (Spec Freeze Window 30d) Tj ET",
        b"q BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x11\x22\x33 EI Q",
    ]);
    std::fs::write(ws_root.join("specs/spec.pdf"), &spec_pdf).unwrap();
    std::fs::write(
        ws_root.join("decisions/plan.md"),
        "[P1 - 待确认] 规范冻结窗口 30 天是否按第 2 页执行？\n依据：[规范](../specs/spec.pdf#page=2)\n待确认\n",
    )
    .unwrap();

    let root = ws_root.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root).unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();

    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let mut store = ReadonlyStore::open_at(&data_dir, &root).unwrap();
    store.claim_workspace(&root).unwrap();
    let app = crate::http::build_router_with_desktop_cors(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_b04".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st_files, j_files) = get(&app, "/api/v1/files?limit=50").await;
    assert_eq!(st_files, StatusCode::OK);
    let items = j_files["items"].as_array().unwrap();
    let spec_item = items
        .iter()
        .find(|i| i["relative_path"] == "specs/spec.pdf")
        .unwrap();
    let md_item = items
        .iter()
        .find(|i| i["relative_path"] == "decisions/plan.md")
        .unwrap();
    assert_eq!(spec_item["coverage"], "pdf_page_text");
    assert_eq!(spec_item["pdf_status"], "page_indexed");

    let spec_rev = spec_item["current_revision_id"].as_str().unwrap();
    let md_rev = md_item["current_revision_id"].as_str().unwrap();

    let (st_prev, j_prev) = get(&app, &format!("/api/v1/revisions/{spec_rev}/preview")).await;
    assert_eq!(st_prev, StatusCode::OK);
    assert_eq!(j_prev["preview_kind"], "pdf");
    assert_eq!(j_prev["pdf_summary"]["status"], "page_indexed");
    assert_eq!(j_prev["pdf_summary"]["page_count"], 2);
    assert_eq!(j_prev["pdf_summary"]["text_page_count"], 1);
    assert_eq!(j_prev["pdf_summary"]["image_only_page_count"], 1);

    let (st_pdf, h_pdf, b_pdf) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{spec_rev}/pdf"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_pdf, StatusCode::OK);
    let j_pdf: serde_json::Value = serde_json::from_slice(&b_pdf).unwrap();
    assert_eq!(j_pdf["status"], "page_indexed");
    let pages = j_pdf["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0]["page_number"], 1);
    assert_eq!(pages[0]["page_kind"], "text");
    assert!(pages[0]["extracted_text"]
        .as_str()
        .unwrap()
        .contains("Spec Freeze Window 30d"));
    assert_eq!(pages[1]["page_number"], 2);
    assert_eq!(pages[1]["page_kind"], "image_only");
    assert!(pages[1]["visual_summary"]
        .as_str()
        .unwrap()
        .contains("纯图像页"));

    let etag_pdf = h_pdf.get("etag").unwrap().to_str().unwrap().to_owned();
    let (st_pdf_304, _, _) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{spec_rev}/pdf"))
            .header("if-none-match", etag_pdf)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st_pdf_304, StatusCode::NOT_MODIFIED);

    let (st_md_err, j_md_err) = get(&app, &format!("/api/v1/revisions/{md_rev}/pdf")).await;
    assert_eq!(st_md_err, StatusCode::BAD_REQUEST);
    assert_envelope(&j_md_err, "BAD_REQUEST");
    let (st_nf, j_nf) = get(&app, "/api/v1/revisions/rev_missing/pdf").await;
    assert_eq!(st_nf, StatusCode::NOT_FOUND);
    assert_envelope(&j_nf, "NOT_FOUND");

    let (st_dec, j_dec) = get(&app, "/api/v1/decisions").await;
    assert_eq!(st_dec, StatusCode::OK);
    let decs = j_dec["items"].as_array().unwrap();
    let plan_dec = decs
        .iter()
        .find(|d| d["question"].as_str().unwrap().contains("冻结窗口"))
        .unwrap();
    let pdf_ev = plan_dec["evidences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["relative_path"] == "specs/spec.pdf")
        .unwrap();
    assert_eq!(pdf_ev["pdfAnchor"]["kind"], "pdf_page");
    assert_eq!(pdf_ev["pdfAnchor"]["page"], 2);

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn c01_initiative_candidates_weave_adopt_and_exclude() {
    let base = std::env::temp_dir().join(format!("guanlan-svc-c01-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws_root = base.join("workspace");
    let data_dir = base.join("data");
    for dir in [
        "docs/方案总体",
        "设计/图纸",
        "交付/清单",
        "需求/提案",
        "misc",
    ] {
        std::fs::create_dir_all(ws_root.join(dir)).unwrap();
    }
    std::fs::create_dir_all(&data_dir).unwrap();

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let put = |rel: &str, content: &str, minutes_ago: i64| {
        let path = ws_root.join(rel);
        std::fs::write(&path, content).unwrap();
        let t = (now_ms - minutes_ago * 60_000).max(0);
        let times = std::fs::FileTimes::new()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(t as u64))
            .set_accessed(std::time::UNIX_EPOCH + std::time::Duration::from_millis(t as u64));
        std::fs::set_times(&path, times).unwrap();
    };
    put(
        "docs/方案总体/登录方案.md",
        "# 登录方案
",
        41,
    );
    put(
        "设计/图纸/登录方案-架构.svg",
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
        29,
    );
    put("交付/清单/登录方案-验收清单.docx", "验收占位", 18);
    put(
        "需求/提案/登录方案-需求蓝图.md",
        "# 需求蓝图
",
        10,
    );
    put(
        "misc/团队周报.md",
        "# 周报
",
        60 * 24 * 3,
    );

    let root = ws_root.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root).unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();

    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let mut store = ReadonlyStore::open_at(&data_dir, &root).unwrap();
    store.claim_workspace(&root).unwrap();
    let app = crate::http::build_router_with_desktop_cors(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_c01".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st_submit, j_submit) = post_json(
        &app,
        "/api/v1/index-jobs",
        &serde_json::json!({ "kind": "verify_all" }).to_string(),
    )
    .await;
    assert_eq!(st_submit, StatusCode::ACCEPTED);
    wait_job_terminal(&app, j_submit["job_id"].as_str().unwrap()).await;

    let (st_list, j_list) = get(&app, "/api/v1/initiative-candidates").await;
    assert_eq!(st_list, StatusCode::OK);
    let items = j_list["items"].as_array().unwrap();
    let cluster = items
        .iter()
        .find(|c| c["member_count"] == 4 && c["state"] == "candidate")
        .unwrap_or_else(|| {
            panic!(
                "应存在 4 成员候选簇：{}",
                serde_json::to_string(&j_list).unwrap()
            )
        });
    assert_eq!(cluster["title"], "登录方案-需求蓝图");
    assert!(cluster["score"].as_u64().unwrap() > 0);
    let candidate_id = cluster["candidate_id"].as_str().unwrap().to_owned();
    let members = cluster["members"].as_array().unwrap();
    assert_eq!(members.len(), 4);
    for member in members {
        assert!(
            !member["signals"].as_array().unwrap().is_empty(),
            "每个成员都携带理由胶囊（非黑盒）"
        );
        assert!(member["relative_path"].as_str().is_some());
    }

    let blueprint_file_id = members
        .iter()
        .find(|m| {
            m["relative_path"]
                .as_str()
                .unwrap()
                .ends_with("登录方案-需求蓝图.md")
        })
        .unwrap()["file_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (st_excl, j_excl) = post_json(
        &app,
        &format!(
            "/api/v1/initiative-candidates/{candidate_id}/members/{blueprint_file_id}/exclude"
        ),
        &serde_json::json!({}).to_string(),
    )
    .await;
    assert_eq!(st_excl, StatusCode::ACCEPTED, "剔除受理：{j_excl}");
    wait_job_terminal(&app, j_excl["job_id"].as_str().unwrap()).await;

    let (st_resub, j_resub) = post_json(
        &app,
        "/api/v1/index-jobs",
        &serde_json::json!({ "kind": "verify_all" }).to_string(),
    )
    .await;
    assert_eq!(st_resub, StatusCode::ACCEPTED);
    wait_job_terminal(&app, j_resub["job_id"].as_str().unwrap()).await;
    let (_, j_after) = get(&app, "/api/v1/initiative-candidates").await;
    let rebound = j_after["items"].as_array().unwrap().iter().any(|c| {
        c["state"] == "candidate"
            && c["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["file_id"] == blueprint_file_id)
    });
    assert!(!rebound, "误聚项剔除后重扫不得反弹");

    let (_, j_final) = get(&app, "/api/v1/initiative-candidates").await;
    let final_items = j_final["items"].as_array().unwrap();
    let adoptable = final_items
        .iter()
        .find(|c| c["state"] == "candidate")
        .unwrap_or_else(|| {
            panic!(
                "重扫后应仍有可采纳候选：{}",
                serde_json::to_string(&j_final).unwrap()
            )
        });
    let adopt_id = adoptable["candidate_id"].as_str().unwrap().to_owned();
    let (st_adopt, j_adopt) = post_json(
        &app,
        &format!("/api/v1/initiative-candidates/{adopt_id}/adopt"),
        &serde_json::json!({}).to_string(),
    )
    .await;
    assert_eq!(st_adopt, StatusCode::ACCEPTED, "采纳受理：{j_adopt}");
    wait_job_terminal(&app, j_adopt["job_id"].as_str().unwrap()).await;

    let (_, j_adopted) = get(&app, "/api/v1/initiative-candidates").await;
    let adopted_state = j_adopted["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["candidate_id"] == adopt_id)
        .map(|c| c["state"].clone());
    assert_eq!(adopted_state, Some(serde_json::json!("adopted")));

    let (st_nf, j_nf) = post_json(
        &app,
        "/api/v1/initiative-candidates/cand_missing/adopt",
        &serde_json::json!({}).to_string(),
    )
    .await;
    assert_eq!(st_nf, StatusCode::NOT_FOUND);
    assert_envelope(&j_nf, "NOT_FOUND");

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}

async fn wait_job_terminal(app: &axum::Router, job_id: &str) {
    for _ in 0..200 {
        let (_, j) = get(app, &format!("/api/v1/jobs/{job_id}")).await;
        let state = j["state"]
            .as_str()
            .or_else(|| j["status"].as_str())
            .unwrap_or("")
            .to_owned();
        if state == "completed" {
            return;
        }
        if state == "failed" {
            panic!("任务失败：{}", serde_json::to_string(&j).unwrap());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("任务 20s 未到终态");
}

#[tokio::test]
async fn c02_search_hybrid_index_and_rebuild_end_to_end() {
    let base = std::env::temp_dir().join(format!("guanlan-svc-c02-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws_root = base.join("workspace");
    let data_dir = base.join("data");
    for dir in ["docs/方案总体", "设计/图纸", "src/auth", "assets/img"] {
        std::fs::create_dir_all(ws_root.join(dir)).unwrap();
    }
    std::fs::create_dir_all(&data_dir).unwrap();

    std::fs::write(
        ws_root.join("docs/方案总体/登录方案.md"),
        "# 登录方案\n核心结论：登录方案采用统一网关。\n验收标准引用 REQ-03 编号。\n",
    )
    .unwrap();
    std::fs::write(
        ws_root.join("设计/图纸/登录方案-架构.svg"),
        "<svg xmlns='http://www.w3.org/2000/svg'><text>登录方案架构总览</text></svg>",
    )
    .unwrap();
    std::fs::write(
        ws_root.join("src/auth/user-auth-service.ts"),
        "export class UserAuthService {}\n",
    )
    .unwrap();
    std::fs::write(ws_root.join("assets/img/logo.png"), "\u{89}PNG占位").unwrap();

    let root = ws_root.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root).unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();

    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let mut store = ReadonlyStore::open_at(&data_dir, &root).unwrap();
    store.claim_workspace(&root).unwrap();
    let app = crate::http::build_router_with_desktop_cors(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_c02".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st, j) = get(
        &app,
        "/api/v1/search?q=%E7%99%BB%E5%BD%95%E6%96%B9%E6%A1%88",
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(j["ok"], true);
    assert_eq!(j["mode"], "phrase");
    assert_eq!(j["search_state"], "ready");
    let items = j["items"].as_array().unwrap();
    assert!(!items.is_empty(), "应有命中：{j}");
    let md_hit = items
        .iter()
        .find(|h| {
            h["relative_path"]
                .as_str()
                .unwrap_or("")
                .ends_with("登录方案.md")
        })
        .expect("md 应命中");
    assert_eq!(md_hit["match_strategy"], "bigram_phrase_verified");
    assert_eq!(md_hit["coverage"], "full_text");
    assert!(!md_hit["revision_id"].as_str().unwrap().is_empty());
    assert_eq!(md_hit["locator"]["kind"], "lines");
    assert_eq!(md_hit["locator"]["start"], 1, "1-based 行号");
    assert!(md_hit["snippet"].as_str().unwrap().contains("登录方案"));

    let svg_hit = items
        .iter()
        .find(|h| h["format"] == "svg")
        .expect("svg 应命中");
    assert_eq!(svg_hit["coverage"], "svg_text");
    assert_eq!(svg_hit["locator"]["kind"], "svg_text");
    assert!(svg_hit["locator"]["fragment"]
        .as_str()
        .unwrap()
        .contains("登录方案"));

    let (st, j) = get(&app, "/api/v1/search?q=REQ-03").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(j["mode"], "code");
    let code_hit = j["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["match_strategy"] == "exact_code")
        .expect("编号应 exact_code 命中");
    assert_eq!(code_hit["locator"]["kind"], "lines");
    assert_eq!(code_hit["locator"]["start"], 3, "编号在第 3 行");

    let (st, j) = get(&app, "/api/v1/search?q=uas").await;
    assert_eq!(st, StatusCode::OK);
    let abbr_hit = j["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| {
            h["relative_path"]
                .as_str()
                .unwrap_or("")
                .ends_with("user-auth-service.ts")
                && h["match_strategy"] == "filename_match"
        })
        .expect("缩写应命中文件名");
    assert_eq!(abbr_hit["locator"]["kind"], "file");

    let (st, j) = get(
        &app,
        "/api/v1/search?q=%E7%99%BB%E5%BD%95%E6%96%B9%E6%A1%88&format=md",
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(j["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|h| h["format"] == "md"));
    assert!(!j["items"].as_array().unwrap().is_empty());

    let (st, j) = get(
        &app,
        "/api/v1/search?q=%E7%99%BB%E5%BD%95%E6%96%B9%E6%A1%88&dir=src",
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(
        j["items"].as_array().unwrap().is_empty(),
        "src 下无该短语正文"
    );

    {
        let conn = rusqlite::Connection::open(data_dir.join("index.db")).unwrap();
        conn.execute("DELETE FROM search_postings", []).unwrap();
    }
    let (st, j) = get(&app, "/api/v1/search?q=REQ-03").await;
    assert_eq!(st, StatusCode::OK);
    assert!(j["items"].as_array().unwrap().is_empty(), "损坏后诚实为空");

    let (st_rebuild, j_rebuild) = post_json(
        &app,
        "/api/v1/search/rebuild",
        &serde_json::json!({}).to_string(),
    )
    .await;
    assert_eq!(st_rebuild, StatusCode::ACCEPTED);
    wait_job_terminal(&app, j_rebuild["job_id"].as_str().unwrap()).await;

    let (st, j) = get(&app, "/api/v1/search?q=REQ-03").await;
    assert_eq!(st, StatusCode::OK);
    assert!(
        !j["items"].as_array().unwrap().is_empty(),
        "一键重建后应恢复：{j}"
    );
    assert_eq!(j["search_state"], "ready");
}

fn c05_build_workspace(
    base: &std::path::Path,
    tag: &str,
    docs: &[(&str, &str)],
) -> (String, std::path::PathBuf) {
    let root = base.join(tag);
    for (rel, _content) in docs {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
    }
    let data_dir = base.join(format!("{tag}-guanlan-data"));
    std::fs::create_dir_all(&data_dir).unwrap();
    for (rel, content) in docs {
        std::fs::write(root.join(rel), content).unwrap();
    }
    let root_str = root.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root_str).unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();
    drop(writer);
    (root_str, data_dir)
}

#[tokio::test]
async fn c05_mounts_cross_search_and_guardrails_end_to_end() {
    let base = std::env::temp_dir().join(format!("guanlan-svc-c05-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();

    let (primary_root, primary_data) = c05_build_workspace(
        &base,
        "primary",
        &[(
            "docs/方案总体/登录方案.md",
            "# 登录方案\n主区结论：登录方案采用统一网关。\n",
        )],
    );
    let (ref_a_root, ref_a_data) = c05_build_workspace(
        &base,
        "ref-a",
        &[(
            "specs/登录方案-历史采纳.md",
            "# 历史采纳\n上一项目结论：登录方案先走双通道。\n",
        )],
    );
    let (ref_b_root, ref_b_data) = c05_build_workspace(
        &base,
        "ref-b",
        &[("notes/采购台账.md", "# 采购台账\n另一项目的台账笔记。\n")],
    );

    let primary_normalized =
        guanlan_core::domain::mounts::normalize_mount_root(&primary_root).unwrap();
    let registry = crate::mounts::MountRegistry::load(&primary_data, &primary_normalized);
    registry.set_test_data_dirs(std::collections::HashMap::from([
        (
            guanlan_core::domain::mounts::normalize_mount_root(&ref_a_root).unwrap(),
            ref_a_data.clone(),
        ),
        (
            guanlan_core::domain::mounts::normalize_mount_root(&ref_b_root).unwrap(),
            ref_b_data.clone(),
        ),
    ]));
    let jobs = crate::index_jobs::IndexJobManager::idle();
    let mut store = ReadonlyStore::open_at(&primary_data, &primary_root).unwrap();
    store.claim_workspace(&primary_root).unwrap();
    let app = crate::http::build_router_with_desktop_cors(AppState {
        mounts: registry.clone(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_c05".to_owned(),
        jobs,
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st, j) = get(&app, "/api/v1/mounts").await;
    assert_eq!(st, StatusCode::OK);
    assert!(j["items"].as_array().unwrap().is_empty());

    let (st, j) = post_json(
        &app,
        "/api/v1/mounts",
        &serde_json::json!({ "root_path": ref_a_root }).to_string(),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "挂载 ref-a 受理：{j}");
    assert_eq!(j["mount"]["online"], true);
    assert_eq!(j["mount"]["file_count"], 1);
    assert_eq!(j["mount"]["search_state"], "ready", "对账尾部已建检索索引");
    assert_eq!(j["mount"]["name"], "ref-a");
    let mount_a_id = j["mount"]["mount_id"].as_str().unwrap().to_owned();
    assert!(mount_a_id.starts_with("m_"));

    let (st, j) = post_json(
        &app,
        "/api/v1/mounts",
        &serde_json::json!({ "root_path": format!(r"\\?\{}", ref_a_root.replace('\\', "/")) })
            .to_string(),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT, "变体写法必须收敛为重复挂载：{j}");
    assert_envelope(&j, "CONFLICT");

    let (st, j) = post_json(
        &app,
        "/api/v1/mounts",
        &serde_json::json!({ "root_path": ref_b_root }).to_string(),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "挂载 ref-b 受理：{j}");

    for (candidate, why) in [
        (primary_root.clone(), "自我挂载"),
        (format!(r"{primary_root}\nested"), "主区子目录"),
        (
            std::path::Path::new(&primary_root)
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "主区父目录",
        ),
        (format!(r"{ref_a_root}\nested"), "既有挂载子目录"),
    ] {
        let (st, j) = post_json(
            &app,
            "/api/v1/mounts",
            &serde_json::json!({ "root_path": candidate }).to_string(),
        )
        .await;
        assert_eq!(st, StatusCode::CONFLICT, "{why} 必须拒绝：{j}");
        assert_envelope(&j, "MOUNT_REJECTED");
    }

    let started = std::time::Instant::now();
    let (st, j) = get(
        &app,
        "/api/v1/search/cross?q=%E7%99%BB%E5%BD%95%E6%96%B9%E6%A1%88",
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis();
    assert_eq!(st, StatusCode::OK, "联合检索失败：{j}");
    let items = j["items"].as_array().unwrap();
    assert!(!items.is_empty(), "联合检索应有命中：{j}");
    let primary_hit = items
        .iter()
        .find(|h| h["source_workspace"].is_null())
        .expect("主区命中不带来源标注");
    assert!(primary_hit["relative_path"]
        .as_str()
        .unwrap()
        .ends_with("登录方案.md"));
    let mounted_hit = items
        .iter()
        .find(|h| !h["source_workspace"].is_null())
        .unwrap_or_else(|| panic!("挂载区命中应带来源标注：{j}"));
    assert_eq!(mounted_hit["source_workspace"]["name"], "ref-a");
    assert!(
        mounted_hit["source_workspace"]["root_key"]
            .as_str()
            .unwrap()
            .len()
            == 16,
        "来源标注含 16 位身份哈希"
    );
    assert_eq!(mounted_hit["coverage"], "full_text");
    let mounts = j["mounts"].as_array().unwrap();
    assert_eq!(mounts.len(), 2, "两个挂载区都在 mounts 数组中");
    assert!(
        mounts.iter().all(|m| m["online"] == true),
        "两挂载区在线：{j}"
    );
    assert!(elapsed_ms < 80, "联合检索实测 {elapsed_ms}ms 超预算 80ms");
    eprintln!("c05 联合检索实测：{elapsed_ms}ms（预算 80ms，2 挂载区 + 主区）");

    let mounted_file_id = mounted_hit["file_id"].as_str().unwrap().to_owned();
    for (uri, body) in [
        (
            format!("/api/v1/files/{mounted_file_id}/rename"),
            serde_json::json!({ "new_name": "steal.md" }).to_string(),
        ),
        (
            format!("/api/v1/files/{mounted_file_id}/move"),
            serde_json::json!({ "target_dir": "docs" }).to_string(),
        ),
        (
            format!("/api/v1/files/{mounted_file_id}/trash"),
            serde_json::json!({ "confirm": true }).to_string(),
        ),
    ] {
        let (st, j) = post_json(&app, &uri, &body).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "跨挂载写必须 403：{j}");
        assert_envelope(&j, "CROSS_WORKSPACE_FORBIDDEN");
    }

    let mounted_rev = mounted_hit["revision_id"].as_str().unwrap().to_owned();
    let (st, j) = get(&app, &format!("/api/v1/revisions/{mounted_rev}/preview")).await;
    assert_eq!(st, StatusCode::OK, "挂载区版本轻预览：{j}");
    assert_eq!(j["ok"], true);
    assert!(j["text_slice"]
        .as_str()
        .unwrap_or_default()
        .contains("登录方案"));
    let (st, _headers, bytes) = send(
        &app,
        Request::builder()
            .uri(format!("/api/v1/revisions/{mounted_rev}/content?raw=1"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "挂载区版本 raw 正文：{bytes:?}");
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("登录方案"), "raw 正文应为参考区快照原文");

    let delete_mount = |mount_id: &str| {
        Request::builder()
            .method("DELETE")
            .uri(format!("/api/v1/mounts/{mount_id}"))
            .body(Body::empty())
            .unwrap()
    };
    let (st, _h, _body) = send(&app, delete_mount(&mount_a_id)).await;
    assert_eq!(st, StatusCode::OK, "卸载 ref-a");
    let (st, _h, body) = send(&app, delete_mount(&mount_a_id)).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "重复卸载 404");
    let j: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_envelope(&j, "NOT_FOUND");
    let (st, j) = get(&app, "/api/v1/mounts").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(j["items"].as_array().unwrap().len(), 1, "卸载后仅剩 ref-b");

    let sidecar = serde_json::json!({
        "version": 1,
        "mounts": [{
            "mount_key": "feedface00000001",
            "root_path": r"Z:\no-such-dir\gone-ws",
            "ref_data_dir": r"C:\no-such-data\gone-ws",
            "name": "gone-ws",
            "added_at": "2026-11-21T09:00:00.000+08:00",
            "last_known": {
                "mount_id": "m_feedface00000001",
                "mount_key": "feedface00000001",
                "root_key": "rk_was_online",
                "root_path": r"Z:\no-such-dir\gone-ws",
                "name": "gone-ws",
                "online": true,
                "index_generation": 5,
                "search_state": "ready",
                "file_count": 42,
                "error": null,
                "last_seen_at": "2026-11-20T18:00:00.000+08:00"
            }
        }]
    });
    let offline_data = base.join("offline-data");
    std::fs::create_dir_all(&offline_data).unwrap();
    std::fs::write(
        offline_data.join("mounts.json"),
        serde_json::to_string_pretty(&sidecar).unwrap(),
    )
    .unwrap();
    let offline_registry = crate::mounts::MountRegistry::load(&offline_data, &primary_normalized);
    let listed = offline_registry.list();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].online, "索引库不可达必须诚实离线");
    assert_eq!(listed[0].file_count, 42, "最后已知摘要保留");
    assert_eq!(listed[0].root_key, "rk_was_online");
    assert!(listed[0].error.is_some());

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn quiet_md_folder_ops_create_doc_batch_and_mount_tree_end_to_end() {
    let base =
        std::env::temp_dir().join(format!("guanlan-svc-quiet-folders-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();

    let (primary_root, primary_data) =
        c05_build_workspace(&base, "primary", &[("docs/alpha.md", "# Alpha\n\nhello\n")]);
    let (ref_root, ref_data) = c05_build_workspace(
        &base,
        "ref-tree",
        &[("archive/old-spec.md", "# Old Spec\n\narchive\n")],
    );
    std::fs::create_dir_all(std::path::Path::new(&primary_root).join("empty-folder")).unwrap();
    std::fs::create_dir_all(std::path::Path::new(&ref_root).join("empty-ref")).unwrap();

    let primary_normalized =
        guanlan_core::domain::mounts::normalize_mount_root(&primary_root).unwrap();
    let registry = crate::mounts::MountRegistry::load(&primary_data, &primary_normalized);
    registry.set_test_data_dirs(std::collections::HashMap::from([(
        guanlan_core::domain::mounts::normalize_mount_root(&ref_root).unwrap(),
        ref_data.clone(),
    )]));

    let writer = guanlan_core::index::Writer::open_at(&primary_data, &primary_root).unwrap();
    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let mut store = ReadonlyStore::open_at(&primary_data, &primary_root).unwrap();
    store.claim_workspace(&primary_root).unwrap();
    let app = crate::http::build_router_with_desktop_cors(AppState {
        mounts: registry.clone(),
        projects: None,
        budget: Arc::new(ResponseBudget::new(64 * 1024 * 1024, 8 * 1024 * 1024)),
        exec: Arc::new(QueryExecutor::with_config(vec![store], test_exec_config())),
        instance_id: "inst_quiet_dir".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: None,
    });

    let (st, j) = get(&app, "/api/v1/folders").await;
    assert_eq!(st, StatusCode::OK);
    let folders: Vec<String> = j["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert!(folders.contains(&"empty-folder".to_owned()));
    assert!(folders.contains(&"docs".to_owned()));

    let (st, j) = post_json(
        &app,
        "/api/v1/folders",
        r#"{"parent_dir":"empty-folder","name":"notes"}"#,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(j["new_path"], "empty-folder/notes");

    let (st, j) = post_json(
        &app,
        "/api/v1/files/create",
        r#"{"target_dir":"empty-folder/notes","name":"周会纪要"}"#,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(j["relative_path"], "empty-folder/notes/周会纪要.md");
    let created_id = j["file_id"].as_str().unwrap().to_owned();

    let (st, j) = post_json(
        &app,
        "/api/v1/folders/rename",
        r#"{"folder_path":"empty-folder/notes","new_name":"meetings"}"#,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(j["new_path"], "empty-folder/meetings");
    assert_eq!(j["affected_files"], 1);

    let (st, _) = post_json(
        &app,
        "/api/v1/folders/move",
        r#"{"folder_path":"empty-folder","target_parent_dir":"empty-folder/meetings"}"#,
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "移动文件夹进自身子目录必拒");

    let (st, j) = post_json(
        &app,
        "/api/v1/files/batch-move",
        &serde_json::json!({
            "file_ids": [created_id],
            "target_dir": "docs"
        })
        .to_string(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(j["succeeded"].as_array().unwrap().len(), 1);
    assert_eq!(j["succeeded"][0]["new_path"], "docs/周会纪要.md");

    let (st, m_resp) = post_json(
        &app,
        "/api/v1/mounts",
        &serde_json::json!({ "root_path": ref_root }).to_string(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let mount_id = m_resp["mount"]["mount_id"].as_str().unwrap().to_owned();
    let (st, mf) = get(&app, &format!("/api/v1/mounts/{mount_id}/files")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(mf["items"].as_array().unwrap().len(), 1);
    assert_eq!(mf["items"][0]["relative_path"], "archive/old-spec.md");
    assert!(mf["folders"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "empty-ref"));

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}
