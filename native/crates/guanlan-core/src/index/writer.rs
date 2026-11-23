//! 写入侧：唯一写连接、schema 确保与全部写库语句。
//!
//! 契约：native/docs/contract-storage.md §1（DDL）、§2（身份）、
//! §3（快照落盘）、§4（写入顺序）。SQL 与 `server/WorkspaceStore.ts` 逐字一致，
//! 改动前先对 TS 源。
//!
//! **唯一写入者**：本结构持有库里唯一的一条可写连接，由服务层的写线程独占
//! （方案 §0「唯一写入线程：rusqlite 写连接只属于这一线程」）。读侧仍走
//! `storage::ReadonlyStore` 的只读连接池，两侧靠 WAL 并行。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use std::collections::HashMap;

use rusqlite::{params, Connection, OpenFlags};
use sha2::{Digest, Sha256};

use crate::domain::{resolve_root, root_key_of_resolved, workspace_id_of};
use crate::dto::WorkspaceRecord;
use crate::error::GuanlanError;
use crate::index::clock;
use crate::index::ident::stable_key;
use crate::storage::{
    artifact_state_row, checkpoint_row, default_data_dir, edge_row, event_row, file_row,
    initiative_row, internal_sql, job_run_row, revision_draft_row, revision_row, statement_row,
    summary_job_row, task_node_row, ArtifactStateRow, CheckpointRow, EdgeRow, EventRow, FileRow,
    InitiativeRow, JobRunRow, RevisionDraftRow, RevisionRow, StatementRow, SummaryJobRow,
    TaskNodeRow,
};

/// `office_extracts` 缓存命中行
#[derive(Debug, Clone)]
pub struct CachedOfficeRow {
    pub status: String,
    pub error_reason: Option<String>,
    pub extract_json: String,
    pub plain_text: String,
}

/// C01 · 候选成员行
#[derive(Debug, Clone)]
pub struct CandidateMemberRow {
    pub file_id: String,
    pub role: String,
    /// JSON 数组：`[{signal, detail}]`（理由胶囊明细）
    pub signals_json: String,
}

/// C01 · 候选行
#[derive(Debug, Clone)]
pub struct CandidateRow {
    pub candidate_id: String,
    pub workspace_id: String,
    /// 结构化簇键（排序成员 file_id 的 sha 前 16）——排除表按它"重扫不反弹"
    pub candidate_key: String,
    pub title: String,
    pub reason_summary: String,
    pub signal_mask: i64,
    pub score: i64,
    pub member_count: i64,
    /// candidate | adopted | dismissed
    pub state: String,
    pub updated_at: String,
}

/// C01 · 候选整包（行 + 成员，wire 组装用）
#[derive(Debug, Clone)]
pub struct CandidateFull {
    pub row: CandidateRow,
    pub members: Vec<CandidateMemberRow>,
}

/// `pdf_extracts` 缓存命中行（B04）
#[derive(Debug, Clone)]
pub struct CachedPdfRow {
    pub status: String,
    pub error_reason: Option<String>,
    pub page_count: u64,
    pub extract_json: String,
    pub plain_text: String,
}

/// 抽取规则版本（`WorkspaceStore.ts:131`）：规则升级时重建派生索引并记录。
///
/// 本次落地**沿用既有版本号**：升版本会触发全量重派生（删边 + 重抽），
/// 属于独立变更，不应与「写入侧接管」混在一次提交里。
pub const EXTRACT_RULE_VERSION: &str = "v0.4.3";

/// 幂等 DDL（`WorkspaceStore.ts:133-284` 原文）。
///
/// 全部 `IF NOT EXISTS`——对既有库是空操作，只在首次建库时真正建表。
const SCHEMA: &str = r#"
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

-- ===== schema v2：PRD v2.0 长任务引擎与证道阁上下文基座新增（contract-storage.md §4.3） =====
-- 全部幂等 IF NOT EXISTS：对既有库（Node 管线建的 v0/v1 库）是空操作，
-- 不迁移、不重建任何既有表/列。冻结契约 storageChanges 的 7 张新表。

-- ① 专项（PRD 2.1）：跨天长任务的一级容器。UNIQUE(workspace_id, root_dir)
--    保证同一工作区同一根目录只有一行。
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

-- ② 文档级状态投影（PRD 2.2 统一状态机 SSOT 存储层）。file_id 复用 files 主键
--    ——禁止第二套文件身份。
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

-- ③ 子任务节点（PRD 3.1 五槽位 DAG）。state 是声明式跨轮持久态，每轮
--    reconcile 由 state_engine::recompute 幂等重算维持（阻塞1 修复）。
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

-- ④ 执行快照（PRD 3.2 断点续跑）。checkpoint_id 主键的 seq 由库内既有行数派生
--    （约束2：重启安全）；恢复 = 取节点/initiative+stage 最近一次 SUCCESS。
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

-- ⑤ 修订草案（PRD 5.1 人机并发冲突：Agent 写入存为草案分支，绝不静默覆盖）
CREATE TABLE IF NOT EXISTS revision_drafts (
  draft_id                   TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL,
  file_id                    TEXT NOT NULL,
  base_revision_id           TEXT NOT NULL,
  base_content_hash          TEXT NOT NULL,
  proposed_content_hash      TEXT NOT NULL,
  snapshot_rel_path          TEXT NOT NULL,
  source                     TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'proposed',
  conflict                   INTEGER NOT NULL DEFAULT 0,
  note                       TEXT,
  draft_version_label        TEXT NOT NULL DEFAULT '',
  input_context_hashes_json  TEXT NOT NULL DEFAULT '[]',
  receipt_summary            TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_file ON revision_drafts(file_id, status);

-- ⑥ L4A 后台沉淀队列（PRD 3.4；v1 = local_deterministic，登记偏差）
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

-- ⑦ 任务持久化（重启后 queued/running 重入队；四态，阻塞3 裁定不扩）
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

CREATE TABLE IF NOT EXISTS office_extracts (
  content_hash         TEXT PRIMARY KEY,
  format               TEXT NOT NULL,
  status               TEXT NOT NULL,
  error_reason         TEXT,
  extract_json         TEXT NOT NULL DEFAULT '{}',
  plain_text           TEXT NOT NULL DEFAULT '',
  extract_rule_version TEXT NOT NULL DEFAULT 'v0.4.3',
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_office_format_status ON office_extracts(format, status);

CREATE TABLE IF NOT EXISTS pdf_extracts (
  content_hash         TEXT PRIMARY KEY,
  status               TEXT NOT NULL,
  error_reason         TEXT,
  page_count           INTEGER NOT NULL DEFAULT 0,
  extract_json         TEXT NOT NULL DEFAULT '{}',
  plain_text           TEXT NOT NULL DEFAULT '',
  extract_rule_version TEXT NOT NULL DEFAULT 'v0.4.3',
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdf_status ON pdf_extracts(status);

-- ④ C01 · 候选事项（多信号编织产物；采纳后才建正式 initiative 行）
CREATE TABLE IF NOT EXISTS initiative_candidates (
  candidate_id    TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  candidate_key   TEXT NOT NULL,
  title           TEXT NOT NULL,
  reason_summary  TEXT NOT NULL,
  signal_mask     INTEGER NOT NULL DEFAULT 0,
  score           INTEGER NOT NULL DEFAULT 0,
  member_count    INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'candidate',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_icand_ws_state ON initiative_candidates(workspace_id, state);

CREATE TABLE IF NOT EXISTS initiative_candidate_members (
  candidate_id  TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  signals_json  TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (candidate_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_icand_member_file ON initiative_candidate_members(file_id);

CREATE TABLE IF NOT EXISTS initiative_candidate_exclusions (
  workspace_id  TEXT NOT NULL,
  file_a        TEXT NOT NULL,
  file_b        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, file_a, file_b)
);

-- ⑤ E05 · 关键决定账本防篡改哈希链（只追加、单向链接，供 audit 诊断秒级检出篡改）
CREATE TABLE IF NOT EXISTS decision_ledger_chain (
  chain_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL,
  event_id      TEXT NOT NULL UNIQUE,
  event_seq     INTEGER NOT NULL,
  event_kind    TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  revision_id   TEXT,
  record_hash   TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  chain_hash    TEXT NOT NULL,
  sealed_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_chain_ws ON decision_ledger_chain(workspace_id, chain_seq);

-- ⑥ V04 · 存量工作区已读基线持久化（只落已读版本与时刻，绝不伪造 scrollPercent）
CREATE TABLE IF NOT EXISTS reading_states (
  workspace_id          TEXT NOT NULL,
  file_id               TEXT NOT NULL,
  last_read_revision_id TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (workspace_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_reading_states_ws ON reading_states(workspace_id);
"#;

/// checkpoint 状态枚举（PRD 3.2）
pub const CHECKPOINT_STATUSES: [&str; 3] = ["SUCCESS", "FAILED_RETRYABLE", "SUSPENDED_HITL"];

/// checkpoint 插入载荷（PRD 3.2 Checkpoint 数据结构 + 冻结契约 E 提交载荷）。
/// `node_id` 可缺省：缺省时由 state_engine 按 (initiative_id, stage) 反查槽位
/// 推进（冻结约束1）。
#[derive(Debug, Clone)]
pub struct CheckpointInput {
    pub node_id: Option<String>,
    pub workspace_id: String,
    pub initiative_id: String,
    pub stage: String,
    /// SUCCESS | FAILED_RETRYABLE | SUSPENDED_HITL
    pub status: String,
    pub input_context_hash: String,
    pub output_revision_id: Option<String>,
    pub token_usage: Option<i64>,
    pub elapsed_ms: Option<i64>,
    pub note: Option<String>,
    pub created_at: String,
}

/// 待插入的事件行（`EventRow` 去掉自增的 seq）
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub event_id: String,
    pub workspace_id: String,
    pub kind: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub revision_id: Option<String>,
    pub occurred_at: Option<String>,
    pub occurred_precision: String,
    pub occurred_source: Option<String>,
    pub observed_at: String,
    pub headline: String,
    pub detail: String,
    pub payload_json: String,
    pub batch_id: Option<String>,
}

/// 快照落盘结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotOutcome {
    /// 新写了快照文件
    Written,
    /// 同哈希快照已存在且校验通过（未重写）
    Existing,
    /// 源文件在采集之后被改写：本轮不落版本，下轮对账会恢复
    Unstable,
}

/// 旧资料回填候选行
#[derive(Debug, Clone)]
pub struct BackfillCandidate {
    pub revision_id: String,
    pub occurred_at: String,
    pub occurred_precision: String,
    pub observed_at: String,
    pub file_id: String,
    pub current_path: String,
    pub title: String,
    pub format: String,
}

/// 写入器：持有库里唯一一条可写连接
#[derive(Debug)]
pub struct Writer {
    conn: Connection,
    data_dir: PathBuf,
    blobs_dir: PathBuf,
    workspace: WorkspaceRecord,
}

impl Writer {
    /// 打开（或创建）工作区的可写库，并确保 schema 与工作区行存在。
    ///
    /// 与只读侧相反：这里允许建库建表——桌面壳要能在没有历史库时直接跑起来。
    pub fn open(root_path: &str) -> Result<Self, GuanlanError> {
        let data_dir = default_data_dir(root_path)?;
        Self::open_at(&data_dir, root_path)
    }

    /// 同 [`Writer::open`]，但数据目录由调用方指定（测试与工具场景用）
    pub fn open_at(data_dir: &Path, root_path: &str) -> Result<Self, GuanlanError> {
        let resolved = resolve_root(root_path)?;
        let root_key = root_key_of_resolved(&resolved);
        fs::create_dir_all(data_dir).map_err(|e| {
            GuanlanError::Internal(format!("创建数据目录失败 {}：{e}", data_dir.display()))
        })?;
        let blobs_dir = data_dir.join("blobs");
        fs::create_dir_all(&blobs_dir).map_err(|e| {
            GuanlanError::Internal(format!("创建快照目录失败 {}：{e}", blobs_dir.display()))
        })?;

        let db_path = data_dir.join("index.db");
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|e| {
            GuanlanError::Internal(format!("打开可写库失败 {}：{e}", db_path.display()))
        })?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| GuanlanError::Internal(format!("设置 busy_timeout 失败：{e}")))?;
        // F03 高版本只读门禁：在任何写操作（含 WAL PRAGMA / DDL）前先验 PRAGMA user_version，
        // 遇到更高版本库立即以 SCHEMA_TOO_NEW 拒绝盲写！
        crate::storage::migration::check_schema_version_writable(&conn)?;
        // journal_mode 必须用字面量赋值：绑定参数在部分 SQLite 版本上不生效
        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(|e| GuanlanError::Internal(format!("设置 WAL 失败：{e}")))?;
        conn.pragma_update(None, "foreign_keys", 1)
            .map_err(|e| GuanlanError::Internal(format!("设置 foreign_keys 失败：{e}")))?;

        let mut writer = Writer {
            conn,
            data_dir: data_dir.to_path_buf(),
            blobs_dir,
            workspace: WorkspaceRecord {
                workspace_id: workspace_id_of(&root_key),
                root_path: resolved.clone(),
                root_key: root_key.clone(),
                created_at: clock::now_iso(),
                last_scan_at: None,
                index_generation: 0,
            },
        };
        writer.ensure_schema()?;
        let workspace = writer.ensure_workspace(&resolved, &root_key)?;
        writer.workspace = workspace;
        Ok(writer)
    }

    /// 当前工作区行（**每次现读**）
    ///
    /// `index_generation` 与 `last_scan_at` 是「当前代际计数」，写入者随时会推进，
    /// 读侧不得持有快照值——对账每轮开头都要拿到当下的代次。
    pub fn workspace(&self) -> Result<WorkspaceRecord, GuanlanError> {
        self.conn
            .query_row(
                "SELECT * FROM workspaces WHERE workspace_id = ?",
                params![self.workspace.workspace_id],
                |row| {
                    Ok(WorkspaceRecord {
                        workspace_id: row.get("workspace_id")?,
                        root_path: row.get("root_path")?,
                        root_key: row.get("root_key")?,
                        created_at: row.get("created_at")?,
                        last_scan_at: row.get("last_scan_at")?,
                        index_generation: row.get::<_, i64>("index_generation")?.max(0) as u64,
                    })
                },
            )
            .map_err(internal_sql)
    }

    /// 数据目录
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// 快照目录
    pub fn blobs_dir(&self) -> &Path {
        &self.blobs_dir
    }

    /// 底层连接（事务内需要直接执行 SQL 时使用）
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// 旧资料回填候选：已入库、正文自述日期、且该版本尚无任何入轴事件
    pub fn query_backfill_candidates(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<BackfillCandidate>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT r.revision_id, r.occurred_at, r.occurred_precision, r.observed_at,
                        f.file_id, f.current_path, f.title, f.format
                 FROM files f
                 JOIN revisions r ON r.revision_id = f.last_revision_id
                 WHERE f.workspace_id = ?
                   AND r.occurred_source = 'document_self'
                   AND NOT EXISTS (
                     SELECT 1 FROM events e WHERE e.revision_id = r.revision_id
                   )",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(BackfillCandidate {
                    revision_id: row.get("revision_id")?,
                    occurred_at: row
                        .get::<_, Option<String>>("occurred_at")?
                        .unwrap_or_default(),
                    occurred_precision: row
                        .get::<_, Option<String>>("occurred_precision")?
                        .unwrap_or_else(|| "day".to_owned()),
                    observed_at: row
                        .get::<_, Option<String>>("observed_at")?
                        .unwrap_or_default(),
                    file_id: row.get("file_id")?,
                    current_path: row.get("current_path")?,
                    title: row.get("title")?,
                    format: row.get("format")?,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 幂等建表 + 增量列迁移（F03：升级前经 SQLite Backup API 自动一致性备份，保留最近 5 份，事务原子回滚）
    fn ensure_schema(&self) -> Result<(), GuanlanError> {
        crate::storage::migration::run_safe_schema_migration(&self.conn, &self.data_dir, |conn| {
            conn.execute_batch(SCHEMA)
                .map_err(|e| GuanlanError::Internal(format!("按契约 DDL 建表失败：{e}")))?;
            // C02 派生检索索引两表（单一来源：crate::index::search_index::SEARCH_DDL）
            conn.execute_batch(crate::index::search_index::SEARCH_DDL)
                .map_err(|e| GuanlanError::Internal(format!("按契约 DDL 建检索索引失败：{e}")))?;
            // 早期库缺 detail_json：补列不重建
            let has_detail: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('statements') WHERE name = 'detail_json'",
                    [],
                    |row| row.get(0),
                )
                .map_err(internal_sql)?;
            if has_detail == 0 {
                conn.execute_batch(
                    "ALTER TABLE statements ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}'",
                )
                .map_err(|e| GuanlanError::Internal(format!("补 detail_json 列失败：{e}")))?;
            }
            // E02：早期库 revision_drafts 缺草案分支标签/上下文哈希清单/回执摘要列——幂等补列不重建
            for (col, ddl) in [
                (
                    "draft_version_label",
                    "ALTER TABLE revision_drafts ADD COLUMN draft_version_label TEXT NOT NULL DEFAULT ''",
                ),
                (
                    "input_context_hashes_json",
                    "ALTER TABLE revision_drafts ADD COLUMN input_context_hashes_json TEXT NOT NULL DEFAULT '[]'",
                ),
                (
                    "receipt_summary",
                    "ALTER TABLE revision_drafts ADD COLUMN receipt_summary TEXT",
                ),
            ] {
                let has_col: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('revision_drafts') WHERE name = ?",
                        params![col],
                        |row| row.get(0),
                    )
                    .map_err(internal_sql)?;
                if has_col == 0 {
                    conn.execute_batch(ddl)
                        .map_err(|e| GuanlanError::Internal(format!("补 {col} 列失败：{e}")))?;
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    /// 工作区行：按 `root_path` 精确匹配，缺失则新建
    fn ensure_workspace(
        &self,
        resolved: &str,
        root_key: &str,
    ) -> Result<WorkspaceRecord, GuanlanError> {
        let existing = self
            .conn
            .query_row(
                "SELECT * FROM workspaces WHERE root_path = ?",
                [resolved],
                |row| {
                    Ok(WorkspaceRecord {
                        workspace_id: row.get("workspace_id")?,
                        root_path: row.get("root_path")?,
                        root_key: row.get("root_key")?,
                        created_at: row.get("created_at")?,
                        last_scan_at: row.get("last_scan_at")?,
                        index_generation: row.get::<_, i64>("index_generation")?.max(0) as u64,
                    })
                },
            )
            .ok();
        if let Some(record) = existing {
            return Ok(record);
        }
        let workspace_id = workspace_id_of(root_key);
        let created_at = clock::now_iso();
        self.conn
            .execute(
                "INSERT INTO workspaces (workspace_id, root_path, root_key, created_at, last_scan_at, index_generation)
                 VALUES (?, ?, ?, ?, NULL, 0)",
                params![workspace_id, resolved, root_key, created_at],
            )
            .map_err(internal_sql)?;
        Ok(WorkspaceRecord {
            workspace_id,
            root_path: resolved.to_owned(),
            root_key: root_key.to_owned(),
            created_at,
            last_scan_at: None,
            index_generation: 0,
        })
    }

    /// 写事务（`BEGIN IMMEDIATE`）
    ///
    /// 与 TS 的 `WorkspaceStore.transaction` 同口径：异常时回滚且回滚失败不掩盖原错误。
    /// 闭包拿到 `&mut Writer`：事务内要调本结构的写方法（它们都只借用 `&self.conn`）。
    pub fn transaction<T>(
        &mut self,
        f: impl FnOnce(&mut Writer) -> Result<T, GuanlanError>,
    ) -> Result<T, GuanlanError> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(internal_sql)?;
        match f(self) {
            Ok(value) => {
                self.conn.execute_batch("COMMIT").map_err(internal_sql)?;
                Ok(value)
            }
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(err)
            }
        }
    }

    // ---------- 读取（写入侧复用，只读同一连接） ----------

    /// 按路径找文件行
    pub fn find_file_by_path(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<Option<FileRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM files WHERE workspace_id = ? AND current_path = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![workspace_id, path], file_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 按别名找文件行
    pub fn resolve_file_by_alias(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<Option<FileRow>, GuanlanError> {
        let file_id: Option<String> = self
            .conn
            .query_row(
                "SELECT file_id FROM path_aliases WHERE workspace_id = ? AND path = ?",
                params![workspace_id, path],
                |row| row.get(0),
            )
            .ok();
        let Some(file_id) = file_id else {
            return Ok(None);
        };
        self.get_file(&file_id)
    }

    /// 按 id 取文件行
    pub fn get_file(&self, file_id: &str) -> Result<Option<FileRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM files WHERE file_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![file_id], file_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 工作区文件清单（`include_missing` 决定是否含缺失文件）
    pub fn list_files(
        &self,
        workspace_id: &str,
        include_missing: bool,
    ) -> Result<Vec<FileRow>, GuanlanError> {
        let sql = if include_missing {
            "SELECT * FROM files WHERE workspace_id = ?"
        } else {
            "SELECT * FROM files WHERE workspace_id = ? AND status = ?"
        };
        let mut stmt = self.conn.prepare(sql).map_err(internal_sql)?;
        let mapper = |row: &rusqlite::Row<'_>| file_row(row);
        let rows = if include_missing {
            stmt.query_map(params![workspace_id], mapper)
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?
        } else {
            stmt.query_map(params![workspace_id, "active"], mapper)
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?
        };
        Ok(rows)
    }

    /// 全库 `(current_path, file_id)` 轻量映射（B05：reconcile 派生索引的路径表专用——
    /// 只取两列，避免整表 FileRow 反序列化；与 `list_files(.., true)` 行集同口径）
    pub fn all_path_ids(&self, workspace_id: &str) -> Result<Vec<(String, String)>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT current_path, file_id FROM files WHERE workspace_id = ?")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 全库 `(file_id, 最新 revision_id)` 映射（B05：单条 GROUP BY 替代逐文件
    /// `latest_revision` 的 N+1 查询——万级库上可把派生索引从秒级降到毫秒级）
    pub fn latest_revision_ids(&self) -> Result<Vec<(String, String)>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT r.file_id, r.revision_id
                 FROM revisions r
                 JOIN (SELECT file_id, MAX(seq) AS max_seq FROM revisions GROUP BY file_id) m
                   ON m.file_id = r.file_id AND m.max_seq = r.seq",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 身份恢复候选（missing / trashed 行；B05：SQL 侧过滤替代全表 FileRow 反序列化）
    pub fn list_recovery_candidates(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<FileRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM files WHERE workspace_id = ? AND status IN ('missing', 'trashed')",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], file_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 文件的最新版本
    pub fn latest_revision(&self, file_id: &str) -> Result<Option<RevisionRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM revisions WHERE file_id = ? ORDER BY seq DESC LIMIT 1")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![file_id], revision_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 按 id 取版本行
    pub fn get_revision(&self, revision_id: &str) -> Result<Option<RevisionRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM revisions WHERE revision_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![revision_id], revision_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 文件的全部版本（按 seq 升序）
    pub fn revisions_of_file(&self, file_id: &str) -> Result<Vec<RevisionRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM revisions WHERE file_id = ? ORDER BY seq ASC")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![file_id], revision_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 是否已有基线事件
    pub fn has_baseline(&self, workspace_id: &str) -> Result<bool, GuanlanError> {
        let n: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'workspace_baseline'",
                params![workspace_id],
                |row| row.get(0),
            )
            .map_err(internal_sql)?;
        Ok(n > 0)
    }

    /// 取元信息
    pub fn get_meta(&self, key: &str) -> Result<Option<String>, GuanlanError> {
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?",
                params![key],
                |row| row.get(0),
            )
            .ok();
        Ok(value)
    }

    /// 事件行（供决策事件比对用）
    pub fn list_events_of_subject(
        &self,
        workspace_id: &str,
        subject_id: &str,
        kinds: &[&str],
    ) -> Result<Vec<EventRow>, GuanlanError> {
        let sql = format!(
            "SELECT * FROM events WHERE workspace_id = ? AND subject_id = ? AND kind IN ({}) ORDER BY seq DESC",
            kinds
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut stmt = self.conn.prepare(&sql).map_err(internal_sql)?;
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(workspace_id.to_owned()),
            Box::new(subject_id.to_owned()),
        ];
        for kind in kinds {
            values.push(Box::new((*kind).to_owned()));
        }
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values.iter()), event_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 陈述行（重建派生索引时按版本查）
    pub fn list_statements(&self, workspace_id: &str) -> Result<Vec<StatementRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM statements WHERE workspace_id = ? ORDER BY code ASC, observed_at ASC")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], statement_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 按 id 取陈述行（决策回写入口）
    pub fn statement_by_id(
        &self,
        statement_id: &str,
    ) -> Result<Option<StatementRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM statements WHERE statement_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![statement_id], statement_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 版本的陈述行（diff 语义摘要卡按版本聚合）
    pub fn statements_of_revision(
        &self,
        revision_id: &str,
    ) -> Result<Vec<StatementRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM statements WHERE revision_id = ? ORDER BY line_start ASC, code ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![revision_id], statement_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 从内存字节写入快照（草案内容：revision_drafts 引用的 blobs 路径）。
    ///
    /// 与 [`Self::write_snapshot_to_disk`] 同一「临时写入 → 重读校验 → 同卷原子
    /// 改名」管线，但**不登记 blobs 行**——草案快照不被 revisions 引用，
    /// ref_count 语义（=revisions 引用数）不得虚增；未引用快照可延后回收
    /// （contract-storage.md §3.4）。
    pub fn write_snapshot_bytes(&self, content: &[u8], hash: &str) -> Result<String, GuanlanError> {
        let target = self.blob_path_for(hash);
        if target.is_file() {
            if let Ok(existing) = hash_file(&target) {
                if existing == hash {
                    return Ok(format!("blobs/{}/{}", &hash[..2], hash));
                }
            }
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                GuanlanError::Internal(format!("创建快照目录失败 {}：{e}", parent.display()))
            })?;
        }
        let tmp = target.with_extension(format!("tmp-{}-{}", std::process::id(), unique_suffix()));
        fs::write(&tmp, content).map_err(|e| {
            GuanlanError::Internal(format!("写临时快照失败 {}：{e}", tmp.display()))
        })?;
        let actual = hash_file(&tmp)?;
        if actual != hash {
            let _ = fs::remove_file(&tmp);
            return Err(GuanlanError::Internal(format!(
                "草案快照校验失败：期望 {} 实得 {}",
                &hash[..16.min(hash.len())],
                &actual[..16.min(actual.len())]
            )));
        }
        fs::rename(&tmp, &target).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            GuanlanError::Internal(format!("快照改名失败 {}：{e}", target.display()))
        })?;
        Ok(format!("blobs/{}/{}", &hash[..2], hash))
    }

    /// 读草案快照内容（按 rel_path，如 `blobs/ab/ab12…`）
    pub fn read_snapshot_rel(&self, rel_path: &str) -> Option<Vec<u8>> {
        fs::read(self.data_dir.join(rel_path)).ok()
    }

    /// 关系行
    pub fn list_edges(&self, workspace_id: &str) -> Result<Vec<EdgeRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM edges WHERE workspace_id = ?")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], edge_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    // ---------- 写入 ----------

    /// 新建文件行
    pub fn insert_file(&self, file: &FileRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO files (file_id, workspace_id, current_path, format, title, role,
                    first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')",
                params![
                    file.file_id,
                    file.workspace_id,
                    file.current_path,
                    file.format,
                    file.title,
                    file.role,
                    file.first_observed_at,
                    file.last_observed_at,
                    file.last_mtime_ms,
                    file.last_revision_id,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 更新采集状态（内容未变时也走这里）
    pub fn touch_file(
        &self,
        file_id: &str,
        observed_at: &str,
        mtime_ms: f64,
        last_revision_id: &str,
    ) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "UPDATE files SET last_observed_at = ?, last_mtime_ms = ?, last_revision_id = ?, status = 'active'
                 WHERE file_id = ?",
                params![observed_at, mtime_ms, last_revision_id, file_id],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 改文件状态
    pub fn mark_file_status(&self, file_id: &str, status: &str) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "UPDATE files SET status = ? WHERE file_id = ?",
                params![status, file_id],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 身份保真更新文件当前路径、标题、角色与观测状态（保留原 file_id 不裂变）
    pub fn update_file_path_identity(
        &self,
        file_id: &str,
        current_path: &str,
        title: &str,
        role: &str,
        observed_at: &str,
        mtime_ms: f64,
    ) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "UPDATE files
                 SET current_path = ?, title = ?, role = ?, last_observed_at = ?, last_mtime_ms = ?, status = 'active'
                 WHERE file_id = ?",
                params![current_path, title, role, observed_at, mtime_ms, file_id],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 检查给定 event_id 是否已存在
    pub fn event_exists(&self, event_id: &str) -> Result<bool, GuanlanError> {
        let exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM events WHERE event_id = ?",
                params![event_id],
                |row| row.get(0),
            )
            .ok();
        Ok(exists.is_some())
    }

    /// 列出文件关联的全部路径别名
    pub fn list_aliases_of_file(&self, file_id: &str) -> Result<Vec<String>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT path FROM path_aliases WHERE file_id = ?
                 ORDER BY first_observed_at ASC, path ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![file_id], |row| row.get::<_, String>(0))
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 登记路径别名
    pub fn upsert_alias(
        &self,
        workspace_id: &str,
        path: &str,
        file_id: &str,
        now: &str,
        evidence: &str,
    ) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO path_aliases (workspace_id, path, file_id, first_observed_at, last_observed_at, evidence)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (workspace_id, path) DO UPDATE SET
                   file_id = excluded.file_id,
                   last_observed_at = excluded.last_observed_at",
                params![workspace_id, path, file_id, now, now, evidence],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 登记快照元数据并维护引用计数
    pub fn register_blob_ref(&self, hash: &str, size_bytes: i64) -> Result<(), GuanlanError> {
        let now = clock::now_iso();
        let rel_path = format!("blobs/{}/{}", &hash[..2], hash);
        let exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 AS x FROM blobs WHERE content_hash = ?",
                params![hash],
                |row| row.get(0),
            )
            .ok();
        if exists.is_some() {
            self.conn
                .execute(
                    "UPDATE blobs SET size_bytes = ?, ref_count = ref_count + 1, verified_at = ? WHERE content_hash = ?",
                    params![size_bytes, now, hash],
                )
                .map_err(internal_sql)?;
            return Ok(());
        }
        self.conn
            .execute(
                "INSERT INTO blobs (content_hash, size_bytes, rel_path, ref_count, created_at, verified_at)
                 VALUES (?, ?, ?, 1, ?, ?)",
                params![hash, size_bytes, rel_path, now, now],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 插入版本行；引用未登记的快照时报错（不变量：版本行存在 ⇒ 快照已在磁盘）
    ///
    /// **B01 例外**：`snapshot_available = 0` 的版本是「只记元数据、不存快照」的
    /// 降级版本（音视频 / 未知二进制 / 超阈值文件）——磁盘上**确实没有**这份
    /// 字节，因此不要求 `blobs` 行。此时 `snapshot_hash` 仍如实记内容哈希，
    /// 读取侧按「快照不可用」诚实返回（契约 §3.5）。
    pub fn insert_revision(&self, rev: &RevisionRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO revisions (revision_id, file_id, workspace_id, seq, prev_revision_id, content_hash,
                    size_bytes, observed_at, occurred_at, occurred_precision, occurred_source,
                    snapshot_hash, snapshot_available, extract_rule_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
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
                    rev.extract_rule_version,
                ],
            )
            .map_err(internal_sql)?;
        if rev.snapshot_available == 0 {
            // 只记元数据的版本：磁盘上没有快照，也就不该有 blobs 行
            return Ok(());
        }
        let registered: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 AS x FROM blobs WHERE content_hash = ?",
                params![rev.content_hash],
                |row| row.get(0),
            )
            .ok();
        if registered.is_none() {
            return Err(GuanlanError::Internal(format!(
                "版本引用了未保存的快照：{}",
                &rev.content_hash[..16.min(rev.content_hash.len())]
            )));
        }
        Ok(())
    }

    /// 插入事件；同身份已存在则跳过（返回 false），绝不中断整轮事务
    pub fn insert_event(&self, event: &NewEvent) -> Result<bool, GuanlanError> {
        let result = self.conn.execute(
            "INSERT INTO events (event_id, workspace_id, kind, subject_kind, subject_id, revision_id,
                occurred_at, occurred_precision, occurred_source, observed_at, headline, detail, payload_json, batch_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
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
                event.batch_id,
            ],
        );
        match result {
            Ok(_) => {
                // E05：关键决定/草案/检查点/治理事件同事务自动封存进防篡改哈希链
                if crate::storage::ledger::is_ledger_sealed_kind(&event.kind) {
                    let event_seq = self.conn.last_insert_rowid();
                    let snapshot = crate::storage::ledger::LedgerEventSnapshot {
                        workspace_id: &event.workspace_id,
                        event_id: &event.event_id,
                        kind: &event.kind,
                        subject_kind: &event.subject_kind,
                        subject_id: &event.subject_id,
                        revision_id: event.revision_id.as_deref(),
                        occurred_at: event.occurred_at.as_deref(),
                        observed_at: &event.observed_at,
                        headline: &event.headline,
                        detail: &event.detail,
                        payload_json: &event.payload_json,
                    };
                    crate::storage::ledger::seal_event_in_ledger(&self.conn, event_seq, &snapshot)?;
                }
                Ok(true)
            }
            // 只写 events 表，唯一约束冲突只可能是重复身份或重复 event_id
            Err(err) if is_unique_violation(&err) => Ok(false),
            Err(err) => Err(internal_sql(err)),
        }
    }

    /// 写入/更新陈述
    pub fn upsert_statement(&self, row: &StatementRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO statements (statement_id, workspace_id, file_id, revision_id, code, namespace,
                    question, status, quote, line_start, line_end, decision_id, detail_json, extract_rule_version, observed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (revision_id, code, line_start) DO UPDATE SET
                   status = excluded.status,
                   quote = excluded.quote,
                   line_end = excluded.line_end,
                   decision_id = excluded.decision_id,
                   detail_json = excluded.detail_json",
                params![
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
                    row.observed_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 写入/更新关系
    pub fn upsert_edge(&self, row: &EdgeRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO edges (edge_id, workspace_id, source_file_id, source_revision_id, target_file_id,
                    target_revision_id, kind, resolution, locator_start, locator_end, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (source_revision_id, target_file_id, locator_start) DO UPDATE SET
                   target_revision_id = excluded.target_revision_id,
                   resolution = excluded.resolution,
                   reason = excluded.reason",
                params![
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
                    row.reason,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    // ===== C02 派生检索索引（search_docs / search_postings；可随时丢弃重建）=====

    /// 原子替换单文件的检索文档与全部词项（差分同步与全量重建共用）
    pub fn replace_search_doc(
        &self,
        doc: &crate::index::search_index::SearchDocRow,
        postings: &[crate::index::search_index::SearchPostingRow],
    ) -> Result<(), GuanlanError> {
        self.upsert_search_doc(doc)?;
        self.delete_search_postings(&doc.file_id)?;
        let mut stmt = self
            .conn
            .prepare("INSERT OR IGNORE INTO search_postings (term, field, file_id, weight) VALUES (?, ?, ?, ?)")
            .map_err(internal_sql)?;
        for posting in postings {
            stmt.execute(params![
                posting.term,
                posting.field,
                doc.file_id,
                posting.weight
            ])
            .map_err(internal_sql)?;
        }
        Ok(())
    }

    /// 删除单文件的检索文档行
    pub fn delete_search_doc(&self, file_id: &str) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "DELETE FROM search_docs WHERE file_id = ?",
                params![file_id],
            )
            .map_err(internal_sql)?;
        self.delete_search_postings(file_id)?;
        Ok(())
    }

    /// 删除单文件的全部检索词项
    pub fn delete_search_postings(&self, file_id: &str) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "DELETE FROM search_postings WHERE file_id = ?",
                params![file_id],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 只写文档行（批量重建路径：词项走 [`Self::bulk_insert_search_postings`] 有序插入）
    pub fn upsert_search_doc(
        &self,
        doc: &crate::index::search_index::SearchDocRow,
    ) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO search_docs (file_id, workspace_id, revision_id, content_hash, format,
                    title, rel_path, status, has_body, body_text, anchor_json, line_count, truncated, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (file_id) DO UPDATE SET
                   revision_id = excluded.revision_id,
                   content_hash = excluded.content_hash,
                   format = excluded.format,
                   title = excluded.title,
                   rel_path = excluded.rel_path,
                   status = excluded.status,
                   has_body = excluded.has_body,
                   body_text = excluded.body_text,
                   anchor_json = excluded.anchor_json,
                   line_count = excluded.line_count,
                   truncated = excluded.truncated,
                   indexed_at = excluded.indexed_at",
                params![
                    doc.file_id,
                    doc.workspace_id,
                    doc.revision_id,
                    doc.content_hash,
                    doc.format,
                    doc.title,
                    doc.rel_path,
                    doc.status,
                    doc.has_body as i64,
                    doc.body_text,
                    doc.anchor_json,
                    doc.line_count as i64,
                    doc.truncated as i64,
                    doc.indexed_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 批量插入检索词项（全量重建专用：调用方按 (term, field, file_id) **预排序**，
    /// 让 WITHOUT ROWID 主键 B-tree 顺序生长，避免万级随机插入的页分裂）
    pub fn bulk_insert_search_postings(
        &self,
        rows: &[(String, String, String, i64)],
    ) -> Result<(), GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("INSERT OR IGNORE INTO search_postings (term, field, file_id, weight) VALUES (?, ?, ?, ?)")
            .map_err(internal_sql)?;
        for (term, field, file_id, weight) in rows {
            stmt.execute(params![term, field, file_id, weight])
                .map_err(internal_sql)?;
        }
        Ok(())
    }

    /// 差分同步候选：files 侧权威（版本/路径/状态）与 search_docs 侧现存不一致的文件
    pub fn search_sync_candidates(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<crate::index::search_index::SearchSyncCandidate>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT f.file_id
                 FROM files f
                 LEFT JOIN search_docs d ON d.file_id = f.file_id
                 WHERE f.workspace_id = ?1
                   AND (d.file_id IS NULL
                        OR d.revision_id IS NOT f.last_revision_id
                        OR d.rel_path IS NOT f.current_path
                        OR d.status IS NOT f.status)",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(crate::index::search_index::SearchSyncCandidate {
                    file_id: row.get(0)?,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 检索侧孤儿：search_docs 有行但 files 表已无对应文件（差分移除）
    pub fn search_stale_file_ids(&self, workspace_id: &str) -> Result<Vec<String>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT d.file_id
                 FROM search_docs d
                 LEFT JOIN files f ON f.file_id = d.file_id
                 WHERE d.workspace_id = ?1 AND f.file_id IS NULL",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| row.get(0))
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 检查某 `content_hash` 是否已缓存 Office 结构化提取结果（同一版本规则）
    pub fn get_office_extract_json(
        &self,
        content_hash: &str,
        extract_rule_version: &str,
    ) -> Result<Option<CachedOfficeRow>, GuanlanError> {
        let row = self
            .conn
            .query_row(
                "SELECT status, error_reason, extract_json, plain_text
                 FROM office_extracts
                 WHERE content_hash = ? AND extract_rule_version = ?",
                params![content_hash, extract_rule_version],
                |r| {
                    Ok(CachedOfficeRow {
                        status: r.get(0)?,
                        error_reason: r.get(1)?,
                        extract_json: r.get(2)?,
                        plain_text: r.get(3)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    /// 写入/更新 Office L2 提取缓存（按 content_hash 内容寻址幂等）
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_office_extract(
        &self,
        content_hash: &str,
        format: &str,
        status: &str,
        error_reason: Option<&str>,
        extract_json: &str,
        plain_text: &str,
        extract_rule_version: &str,
        updated_at: &str,
    ) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO office_extracts (
                    content_hash, format, status, error_reason, extract_json, plain_text,
                    extract_rule_version, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (content_hash) DO UPDATE SET
                    format = excluded.format,
                    status = excluded.status,
                    error_reason = excluded.error_reason,
                    extract_json = excluded.extract_json,
                    plain_text = excluded.plain_text,
                    extract_rule_version = excluded.extract_rule_version,
                    updated_at = excluded.updated_at",
                params![
                    content_hash,
                    format,
                    status,
                    error_reason,
                    extract_json,
                    plain_text,
                    extract_rule_version,
                    updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 检查某 `content_hash` 是否已缓存 PDF 页级文本提取结果（B04，同一版本规则）
    pub fn get_pdf_extract_json(
        &self,
        content_hash: &str,
        extract_rule_version: &str,
    ) -> Result<Option<CachedPdfRow>, GuanlanError> {
        let row = self
            .conn
            .query_row(
                "SELECT status, error_reason, page_count, extract_json, plain_text
                 FROM pdf_extracts
                 WHERE content_hash = ? AND extract_rule_version = ?",
                params![content_hash, extract_rule_version],
                |r| {
                    Ok(CachedPdfRow {
                        status: r.get(0)?,
                        error_reason: r.get(1)?,
                        page_count: r.get::<_, i64>(2)?.max(0) as u64,
                        extract_json: r.get(3)?,
                        plain_text: r.get(4)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    /// 写入/更新 PDF 页级提取缓存（B04，按 content_hash 内容寻址幂等）
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_pdf_extract(
        &self,
        content_hash: &str,
        status: &str,
        error_reason: Option<&str>,
        page_count: u64,
        extract_json: &str,
        plain_text: &str,
        extract_rule_version: &str,
        updated_at: &str,
    ) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO pdf_extracts (
                    content_hash, status, error_reason, page_count, extract_json, plain_text,
                    extract_rule_version, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (content_hash) DO UPDATE SET
                    status = excluded.status,
                    error_reason = excluded.error_reason,
                    page_count = excluded.page_count,
                    extract_json = excluded.extract_json,
                    plain_text = excluded.plain_text,
                    extract_rule_version = excluded.extract_rule_version,
                    updated_at = excluded.updated_at",
                params![
                    content_hash,
                    status,
                    error_reason,
                    page_count as i64,
                    extract_json,
                    plain_text,
                    extract_rule_version,
                    updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 写元信息
    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 推进索引代（同时更新 last_scan_at）
    pub fn bump_generation(&self, workspace_id: &str) -> Result<u64, GuanlanError> {
        let now = clock::now_iso();
        self.conn
            .execute(
                "UPDATE workspaces SET index_generation = index_generation + 1, last_scan_at = ? WHERE workspace_id = ?",
                params![now, workspace_id],
            )
            .map_err(internal_sql)?;
        let generation: i64 = self
            .conn
            .query_row(
                "SELECT index_generation AS g FROM workspaces WHERE workspace_id = ?",
                params![workspace_id],
                |row| row.get(0),
            )
            .map_err(internal_sql)?;
        Ok(generation.max(0) as u64)
    }

    /// 只更新 last_scan_at（不推进代）
    pub fn mark_scan(&self, workspace_id: &str) -> Result<(), GuanlanError> {
        let now = clock::now_iso();
        self.conn
            .execute(
                "UPDATE workspaces SET last_scan_at = ? WHERE workspace_id = ?",
                params![now, workspace_id],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    // ---------- schema v2：状态机与长任务引擎（contract-storage.md §4.3） ----------

    /// 取专项行
    pub fn get_initiative(
        &self,
        workspace_id: &str,
        initiative_id: &str,
    ) -> Result<Option<InitiativeRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM initiatives WHERE workspace_id = ? AND initiative_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![workspace_id, initiative_id], initiative_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 按根目录名找专项行（UNIQUE(workspace_id, root_dir)）
    pub fn find_initiative_by_root_dir(
        &self,
        workspace_id: &str,
        root_dir: &str,
    ) -> Result<Option<InitiativeRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM initiatives WHERE workspace_id = ? AND root_dir = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![workspace_id, root_dir], initiative_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 全部专项行（按 initiative_id 排序，输出稳定）
    pub fn list_initiatives(&self, workspace_id: &str) -> Result<Vec<InitiativeRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM initiatives WHERE workspace_id = ? ORDER BY initiative_id ASC")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], initiative_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 写入/更新专项行（冲突路径不更新 created_at）
    pub fn upsert_initiative(&self, row: &InitiativeRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO initiatives (initiative_id, workspace_id, name, root_dir, current_stage,
                    state, artifact_count, pending_p0, pending_p1, pending_p2, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (initiative_id) DO UPDATE SET
                   name = excluded.name,
                   root_dir = excluded.root_dir,
                   current_stage = excluded.current_stage,
                   state = excluded.state,
                   artifact_count = excluded.artifact_count,
                   pending_p0 = excluded.pending_p0,
                   pending_p1 = excluded.pending_p1,
                   pending_p2 = excluded.pending_p2,
                   updated_at = excluded.updated_at",
                params![
                    row.initiative_id,
                    row.workspace_id,
                    row.name,
                    row.root_dir,
                    row.current_stage,
                    row.state,
                    row.artifact_count,
                    row.pending_p0,
                    row.pending_p1,
                    row.pending_p2,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    // ===== C01 · 候选事项（多信号编织；采纳前绝不写正式归属） =====

    /// 重扫编织：整体替换工作区的 candidate 态候选（adopted/dismissed 不动）。
    /// 同 candidate_key 幂等（重扫再生成的簇保持同 id 与 updated_at 刷新）。
    pub fn reweave_candidates(
        &mut self,
        workspace_id: &str,
        observed_at: &str,
        clusters: &[CandidateRow],
        members_by_candidate: &HashMap<String, Vec<CandidateMemberRow>>,
    ) -> Result<(), GuanlanError> {
        let live_ids: std::collections::HashSet<&str> =
            clusters.iter().map(|c| c.candidate_id.as_str()).collect();
        self.transaction(|tx| {
                // 清掉本轮未再生成的 candidate 态旧簇（成员已变，旧簇失效）
                let mut stmt = tx
                    .conn
                    .prepare("SELECT candidate_id FROM initiative_candidates WHERE workspace_id = ? AND state = 'candidate'")
                    .map_err(internal_sql)?;
                let stale: Vec<String> = stmt
                    .query_map(params![workspace_id], |row| row.get::<_, String>(0))
                    .map_err(internal_sql)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(internal_sql)?
                    .into_iter()
                    .filter(|id| !live_ids.contains(id.as_str()))
                    .collect();
                drop(stmt);
                for id in &stale {
                    tx.conn
                        .execute("DELETE FROM initiative_candidate_members WHERE candidate_id = ?", params![id])
                        .map_err(internal_sql)?;
                    tx.conn
                        .execute("DELETE FROM initiative_candidates WHERE candidate_id = ?", params![id])
                        .map_err(internal_sql)?;
                }

                for row in clusters {
                    tx.conn
                        .execute(
                            "INSERT INTO initiative_candidates (candidate_id, workspace_id, candidate_key,
                                title, reason_summary, signal_mask, score, member_count, state, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
                             ON CONFLICT (candidate_id) DO UPDATE SET
                               title = excluded.title,
                               reason_summary = excluded.reason_summary,
                               signal_mask = excluded.signal_mask,
                               score = excluded.score,
                               member_count = excluded.member_count,
                               updated_at = excluded.updated_at",
                            params![
                                row.candidate_id,
                                row.workspace_id,
                                row.candidate_key,
                                row.title,
                                row.reason_summary,
                                row.signal_mask,
                                row.score,
                                row.member_count,
                                observed_at,
                                observed_at,
                            ],
                        )
                        .map_err(internal_sql)?;
                    tx.conn
                        .execute("DELETE FROM initiative_candidate_members WHERE candidate_id = ?", params![row.candidate_id])
                        .map_err(internal_sql)?;
                    if let Some(members) = members_by_candidate.get(&row.candidate_id) {
                        for member in members {
                            tx.conn
                                .execute(
                                    "INSERT INTO initiative_candidate_members (candidate_id, file_id, role, signals_json)
                                     VALUES (?, ?, ?, ?)",
                                    params![row.candidate_id, member.file_id, member.role, member.signals_json],
                                )
                                .map_err(internal_sql)?;
                        }
                    }
                }
                Ok(())
            })
    }

    /// 工作区候选列表（含成员；`state` 过滤缺省取全部）
    pub fn list_candidates_full(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CandidateFull>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT candidate_id, workspace_id, candidate_key, title, reason_summary,
                            signal_mask, score, member_count, state, updated_at
                     FROM initiative_candidates
                     WHERE workspace_id = ?
                     ORDER BY score DESC, candidate_id ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(CandidateRow {
                    candidate_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    candidate_key: row.get(2)?,
                    title: row.get(3)?,
                    reason_summary: row.get(4)?,
                    signal_mask: row.get(5)?,
                    score: row.get(6)?,
                    member_count: row.get(7)?,
                    state: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;

        let mut members_stmt = self
                .conn
                .prepare(
                    "SELECT candidate_id, file_id, role, signals_json
                     FROM initiative_candidate_members
                     WHERE candidate_id IN (SELECT candidate_id FROM initiative_candidates WHERE workspace_id = ?)
                     ORDER BY file_id ASC",
                )
                .map_err(internal_sql)?;
        let mut members_by: HashMap<String, Vec<CandidateMemberRow>> = HashMap::new();
        let member_rows = members_stmt
            .query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    CandidateMemberRow {
                        file_id: row.get(1)?,
                        role: row.get(2)?,
                        signals_json: row.get(3)?,
                    },
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        drop(members_stmt);
        for (candidate_id, member) in member_rows {
            members_by.entry(candidate_id).or_default().push(member);
        }

        Ok(rows
            .into_iter()
            .map(|row| CandidateFull {
                members: members_by.remove(&row.candidate_id).unwrap_or_default(),
                row,
            })
            .collect())
    }

    /// 取单个候选（含成员）
    pub fn get_candidate_full(
        &self,
        candidate_id: &str,
    ) -> Result<Option<CandidateFull>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT candidate_id, workspace_id, candidate_key, title, reason_summary,
                            signal_mask, score, member_count, state, updated_at
                     FROM initiative_candidates WHERE candidate_id = ?",
            )
            .map_err(internal_sql)?;
        let row = stmt
            .query_row(params![candidate_id], |row| {
                Ok(CandidateRow {
                    candidate_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    candidate_key: row.get(2)?,
                    title: row.get(3)?,
                    reason_summary: row.get(4)?,
                    signal_mask: row.get(5)?,
                    score: row.get(6)?,
                    member_count: row.get(7)?,
                    state: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .ok();
        let Some(row) = row else {
            return Ok(None);
        };
        let mut members_stmt = self
            .conn
            .prepare(
                "SELECT file_id, role, signals_json
                     FROM initiative_candidate_members
                     WHERE candidate_id = ? ORDER BY file_id ASC",
            )
            .map_err(internal_sql)?;
        let members = members_stmt
            .query_map(params![candidate_id], |row| {
                Ok(CandidateMemberRow {
                    file_id: row.get(0)?,
                    role: row.get(1)?,
                    signals_json: row.get(2)?,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        drop(members_stmt);
        Ok(Some(CandidateFull { row, members }))
    }

    /// 候选状态迁移（candidate → adopted/dismissed）
    pub fn set_candidate_state(
        &self,
        candidate_id: &str,
        state: &str,
        updated_at: &str,
    ) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "UPDATE initiative_candidates SET state = ?, updated_at = ? WHERE candidate_id = ?",
                params![state, updated_at, candidate_id],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 重置候选成员（单成员剔除后收缩）
    pub fn replace_candidate_members(
        &mut self,
        candidate_id: &str,
        members: &[CandidateMemberRow],
    ) -> Result<(), GuanlanError> {
        self.transaction(|tx| {
                tx.conn
                    .execute("DELETE FROM initiative_candidate_members WHERE candidate_id = ?", params![candidate_id])
                    .map_err(internal_sql)?;
                for member in members {
                    tx.conn
                        .execute(
                            "INSERT INTO initiative_candidate_members (candidate_id, file_id, role, signals_json)
                             VALUES (?, ?, ?, ?)",
                            params![candidate_id, member.file_id, member.role, member.signals_json],
                        )
                        .map_err(internal_sql)?;
                }
                Ok(())
            })
    }

    /// 记录信号对排除（规范化 file_a ≤ file_b；"误聚项剔除后重扫不反弹"的凭据）
    pub fn insert_candidate_exclusions(
        &mut self,
        workspace_id: &str,
        pairs: &[(String, String)],
        created_at: &str,
    ) -> Result<(), GuanlanError> {
        self.transaction(|tx| {
                for (x, y) in pairs {
                    let (file_a, file_b) = if x <= y { (x, y) } else { (y, x) };
                    tx.conn
                        .execute(
                            "INSERT OR IGNORE INTO initiative_candidate_exclusions (workspace_id, file_a, file_b, created_at)
                             VALUES (?, ?, ?, ?)",
                            params![workspace_id, file_a, file_b, created_at],
                        )
                        .map_err(internal_sql)?;
                }
                Ok(())
            })
    }

    /// 工作区排除对集合（规范化 file_a ≤ file_b）
    pub fn list_candidate_exclusions(
        &self,
        workspace_id: &str,
    ) -> Result<std::collections::HashSet<(String, String)>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT file_a, file_b FROM initiative_candidate_exclusions WHERE workspace_id = ?",
            )
            .map_err(internal_sql)?;
        let mut set = std::collections::HashSet::new();
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        drop(stmt);
        for pair in rows {
            set.insert(pair);
        }
        Ok(set)
    }

    /// 已采纳候选的成员归属映射（file_id → 事项标题；state_engine 固化优先级最高）
    pub fn adopted_candidate_map(
        &self,
        workspace_id: &str,
    ) -> Result<HashMap<String, String>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT m.file_id, c.title FROM initiative_candidate_members m
                     JOIN initiative_candidates c ON c.candidate_id = m.candidate_id
                     WHERE c.workspace_id = ? AND c.state = 'adopted' AND m.role = 'member'",
            )
            .map_err(internal_sql)?;
        let mut map = HashMap::new();
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        drop(stmt);
        for (file_id, title) in rows {
            map.insert(file_id, title);
        }
        Ok(map)
    }

    /// 收集编织输入：active 文件信号 + 已解析显式引用边（C01 编排侧组装）
    pub fn collect_weaver_inputs(
        &self,
        workspace_id: &str,
    ) -> Result<
        (
            Vec<crate::domain::candidate_weaver::WeaverFile>,
            Vec<crate::domain::candidate_weaver::WeaverEdge>,
        ),
        GuanlanError,
    > {
        use crate::domain::candidate_weaver::{WeaverEdge, WeaverFile};

        let mut stmt = self
            .conn
            .prepare(
                "SELECT f.file_id, f.current_path, f.title, f.last_mtime_ms
                     FROM files f
                     WHERE f.workspace_id = ? AND f.status = 'active'
                     ORDER BY f.file_id ASC",
            )
            .map_err(internal_sql)?;
        let files = stmt
            .query_map(params![workspace_id], |row| {
                Ok(WeaverFile {
                    file_id: row.get::<_, String>(0)?,
                    path: row.get::<_, String>(1)?.replace('\\', "/"),
                    title: row.get::<_, String>(2)?,
                    activity_ms: row.get::<_, Option<f64>>(3)?.map(|v| v as i64),
                    batch_id: None,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        drop(stmt);

        let mut edge_stmt = self
                .conn
                .prepare(
                    "SELECT source_file_id, target_file_id FROM edges
                     WHERE workspace_id = ? AND kind = 'explicit_reference' AND resolution != 'unresolved'",
                )
                .map_err(internal_sql)?;
        let edges = edge_stmt
            .query_map(params![workspace_id], |row| {
                Ok(WeaverEdge {
                    source_file_id: row.get(0)?,
                    target_file_id: row.get(1)?,
                })
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        drop(edge_stmt);
        Ok((files, edges))
    }

    /// 取文档状态行
    pub fn get_artifact_state(
        &self,
        file_id: &str,
    ) -> Result<Option<ArtifactStateRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM artifact_states WHERE file_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![file_id], artifact_state_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 全部文档状态行（按 file_id 排序，输出稳定）
    pub fn list_artifact_states(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ArtifactStateRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM artifact_states WHERE workspace_id = ? ORDER BY file_id ASC")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], artifact_state_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 写入/更新文档状态行
    pub fn upsert_artifact_state(&self, row: &ArtifactStateRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO artifact_states (file_id, workspace_id, initiative_id, stage, state,
                    selected_revision_id, checklist_done, checklist_total, pending_p0, pending_p1,
                    pending_p2, last_activity_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (file_id) DO UPDATE SET
                   workspace_id = excluded.workspace_id,
                   initiative_id = excluded.initiative_id,
                   stage = excluded.stage,
                   state = excluded.state,
                   selected_revision_id = excluded.selected_revision_id,
                   checklist_done = excluded.checklist_done,
                   checklist_total = excluded.checklist_total,
                   pending_p0 = excluded.pending_p0,
                   pending_p1 = excluded.pending_p1,
                   pending_p2 = excluded.pending_p2,
                   last_activity_at = excluded.last_activity_at,
                   updated_at = excluded.updated_at",
                params![
                    row.file_id,
                    row.workspace_id,
                    row.initiative_id,
                    row.stage,
                    row.state,
                    row.selected_revision_id,
                    row.checklist_done,
                    row.checklist_total,
                    row.pending_p0,
                    row.pending_p1,
                    row.pending_p2,
                    row.last_activity_at,
                    row.updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 取子任务节点行
    pub fn get_task_node(&self, node_id: &str) -> Result<Option<TaskNodeRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM task_nodes WHERE node_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![node_id], task_node_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 按 (initiative_id, stage) 反查槽位节点（冻结约束1：POST /checkpoints 的
    /// node_id 缺省时按五槽位模型唯一命中）
    pub fn find_task_node_by_stage(
        &self,
        workspace_id: &str,
        initiative_id: &str,
        stage: &str,
    ) -> Result<Option<TaskNodeRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM task_nodes WHERE workspace_id = ? AND initiative_id = ? AND stage = ?
                 ORDER BY node_id ASC LIMIT 1",
            )
            .map_err(internal_sql)?;
        let mut rows = stmt
            .query_map(params![workspace_id, initiative_id, stage], task_node_row)
            .map_err(internal_sql)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 全部节点行（按 node_id 排序，输出稳定）
    pub fn list_task_nodes(&self, workspace_id: &str) -> Result<Vec<TaskNodeRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM task_nodes WHERE workspace_id = ? ORDER BY node_id ASC")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], task_node_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 写入/更新子任务节点行（冲突路径不更新 created_at/error——error 由失败路径独占）
    pub fn upsert_task_node(&self, row: &TaskNodeRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO task_nodes (node_id, workspace_id, initiative_id, stage, title, node_kind,
                    state, depends_json, payload_json, latest_checkpoint_id, error, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (node_id) DO UPDATE SET
                   workspace_id = excluded.workspace_id,
                   initiative_id = excluded.initiative_id,
                   stage = excluded.stage,
                   title = excluded.title,
                   node_kind = excluded.node_kind,
                   state = excluded.state,
                   depends_json = excluded.depends_json,
                   payload_json = excluded.payload_json,
                   latest_checkpoint_id = excluded.latest_checkpoint_id,
                   updated_at = excluded.updated_at",
                params![
                    row.node_id,
                    row.workspace_id,
                    row.initiative_id,
                    row.stage,
                    row.title,
                    row.node_kind,
                    row.state,
                    row.depends_json,
                    row.payload_json,
                    row.latest_checkpoint_id,
                    row.error,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 专项下全部 checkpoint 行（按 created_at 与 rowid 倒序：最新的在前）
    pub fn list_checkpoints(
        &self,
        workspace_id: &str,
        initiative_id: &str,
    ) -> Result<Vec<CheckpointRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM checkpoints WHERE workspace_id = ? AND initiative_id = ?
                 ORDER BY created_at DESC, rowid DESC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id, initiative_id], checkpoint_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 「最近一次 SUCCESS」恢复查询（PRD 3.2）：按 stage（可选再按 node_id）取
    /// 最新成功快照。node_id 为 None 时按 (initiative_id, stage) 命中——与
    /// 约束1 的槽位反查口径一致（提交载荷不含 node_id 也能恢复）。
    pub fn latest_success_checkpoint(
        &self,
        workspace_id: &str,
        initiative_id: &str,
        stage: &str,
        node_id: Option<&str>,
    ) -> Result<Option<CheckpointRow>, GuanlanError> {
        let rows = self.list_checkpoints(workspace_id, initiative_id)?;
        Ok(rows.into_iter().find(|row| {
            row.status == "SUCCESS"
                && row.stage == stage
                && match (node_id, &row.node_id) {
                    (Some(expected), Some(actual)) => expected == actual,
                    (Some(_), None) => false,
                    // 不指定节点时，stage 命中即可（含 node_id 为空的提交）
                    (None, _) => true,
                }
        }))
    }

    /// checkpoint 插入载荷（定义见模块级 [`CheckpointInput`]）
    ///
    /// 插入 checkpoint 行，返回主键（冻结约束2：seq 由库内既有行数派生——
    /// 重启安全，跨进程重启不撞 PRIMARY KEY；重复 SUCCESS 是**追加**新行，
    /// 「最近一次 SUCCESS」按 created_at/rowid 取最新，见
    /// [`Self::latest_success_checkpoint`]）。
    ///
    /// 主键 = `ckpt_` + stable_key(initiative_id|stage|node_id|seq)（冻结契约 E
    /// 模板）；seq 冲突或 stable_key 哈希碰撞时按序递增重试（防御上限 64 次）。
    pub fn insert_checkpoint(&self, input: &CheckpointInput) -> Result<String, GuanlanError> {
        if !CHECKPOINT_STATUSES.contains(&input.status.as_str()) {
            return Err(GuanlanError::BadRequest(format!(
                "未知 checkpoint 状态「{}」（允许 {:?}）",
                input.status, CHECKPOINT_STATUSES
            )));
        }
        let node_key = input.node_id.as_deref().unwrap_or("");
        // seq = 该 (workspace, initiative, stage, node) 已有行数 + 1（DB 派生）
        let mut seq: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM checkpoints
                 WHERE workspace_id = ? AND initiative_id = ? AND stage = ?
                   AND COALESCE(node_id, '') = ?",
                params![
                    input.workspace_id,
                    input.initiative_id,
                    input.stage,
                    node_key
                ],
                |row| row.get(0),
            )
            .map_err(internal_sql)?;
        seq += 1;

        let mut checkpoint_id = format!(
            "ckpt_{}",
            stable_key(&format!(
                "{}|{}|{}|{}",
                input.initiative_id, input.stage, node_key, seq
            ))
        );
        // stable_key 是 32 位哈希：不同元组可能同键；主键已存在则递增 seq 重试
        for _ in 0..64 {
            let exists: Option<i64> = self
                .conn
                .query_row(
                    "SELECT 1 FROM checkpoints WHERE checkpoint_id = ?",
                    params![checkpoint_id],
                    |row| row.get(0),
                )
                .ok();
            if exists.is_none() {
                self.conn
                    .execute(
                        "INSERT INTO checkpoints (checkpoint_id, node_id, workspace_id, initiative_id,
                            stage, status, input_context_hash, output_revision_id, token_usage,
                            elapsed_ms, note, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        params![
                            checkpoint_id,
                            input.node_id,
                            input.workspace_id,
                            input.initiative_id,
                            input.stage,
                            input.status,
                            input.input_context_hash,
                            input.output_revision_id,
                            input.token_usage,
                            input.elapsed_ms,
                            input.note,
                            input.created_at,
                        ],
                    )
                    .map_err(internal_sql)?;
                return Ok(checkpoint_id);
            }
            seq += 1;
            checkpoint_id = format!(
                "ckpt_{}",
                stable_key(&format!(
                    "{}|{}|{}|{}",
                    input.initiative_id, input.stage, node_key, seq
                ))
            );
        }
        Err(GuanlanError::Internal(format!(
            "checkpoint_id 分配失败：{} 的 seq 连续冲突超过上限",
            input.initiative_id
        )))
    }

    /// 写入/更新修订草案行
    pub fn upsert_revision_draft(&self, row: &RevisionDraftRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO revision_drafts (draft_id, workspace_id, file_id, base_revision_id,
                    base_content_hash, proposed_content_hash, snapshot_rel_path, source, status,
                    conflict, note, draft_version_label, input_context_hashes_json, receipt_summary,
                    created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (draft_id) DO UPDATE SET
                   status = excluded.status,
                   conflict = excluded.conflict,
                   note = excluded.note,
                   draft_version_label = CASE
                     WHEN excluded.draft_version_label != '' THEN excluded.draft_version_label
                     ELSE revision_drafts.draft_version_label
                   END,
                   input_context_hashes_json = CASE
                     WHEN excluded.input_context_hashes_json != '[]' THEN excluded.input_context_hashes_json
                     ELSE revision_drafts.input_context_hashes_json
                   END,
                   receipt_summary = COALESCE(excluded.receipt_summary, revision_drafts.receipt_summary),
                   updated_at = excluded.updated_at",
                params![
                    row.draft_id,
                    row.workspace_id,
                    row.file_id,
                    row.base_revision_id,
                    row.base_content_hash,
                    row.proposed_content_hash,
                    row.snapshot_rel_path,
                    row.source,
                    row.status,
                    row.conflict,
                    row.note,
                    row.draft_version_label,
                    row.input_context_hashes_json,
                    row.receipt_summary,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// E02：按内容哈希（完整 64 位或至少 16 位前缀，允许带 `sha256:` 前缀）反查工作区修订 `(file_id, revision_id)`。
    /// 供采纳草案后写入 `derived_from_context` 因果边使用。
    pub fn find_revision_by_hash_or_prefix(
        &self,
        workspace_id: &str,
        hash_or_prefix: &str,
    ) -> Result<Option<(String, String)>, GuanlanError> {
        let clean =
            crate::application::proposals::strip_sha256_prefix(hash_or_prefix).to_ascii_lowercase();
        if clean.len() < 16 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(None);
        }
        let found = if clean.len() == 64 {
            self.conn
                .query_row(
                    "SELECT file_id, revision_id FROM revisions
                     WHERE workspace_id = ? AND lower(content_hash) = ?
                     ORDER BY observed_at DESC, seq DESC LIMIT 1",
                    params![workspace_id, clean],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok()
        } else {
            let pattern = format!("{clean}%");
            self.conn
                .query_row(
                    "SELECT file_id, revision_id FROM revisions
                     WHERE workspace_id = ? AND lower(content_hash) LIKE ?
                     ORDER BY observed_at DESC, seq DESC LIMIT 1",
                    params![workspace_id, pattern],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok()
        };
        Ok(found)
    }

    /// 按文件与状态列草案（分页由调用方切片）
    pub fn list_revision_drafts(
        &self,
        workspace_id: &str,
        file_id: Option<&str>,
        status: Option<&str>,
    ) -> Result<Vec<RevisionDraftRow>, GuanlanError> {
        let mut sql = "SELECT * FROM revision_drafts WHERE workspace_id = ?".to_owned();
        if file_id.is_some() {
            sql.push_str(" AND file_id = ?");
        }
        if status.is_some() {
            sql.push_str(" AND status = ?");
        }
        sql.push_str(" ORDER BY created_at DESC, rowid DESC");
        let mut stmt = self.conn.prepare(&sql).map_err(internal_sql)?;
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_id.to_owned())];
        if let Some(file_id) = file_id {
            values.push(Box::new(file_id.to_owned()));
        }
        if let Some(status) = status {
            values.push(Box::new(status.to_owned()));
        }
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(values.iter()),
                revision_draft_row,
            )
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 写入/更新 L4A 摘要任务行
    pub fn upsert_summary_job(&self, row: &SummaryJobRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO summary_jobs (job_id, workspace_id, file_id, content_hash, priority,
                    state, summary_json, attempts, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (job_id) DO UPDATE SET
                   state = excluded.state,
                   summary_json = excluded.summary_json,
                   attempts = excluded.attempts,
                   updated_at = excluded.updated_at",
                params![
                    row.job_id,
                    row.workspace_id,
                    row.file_id,
                    row.content_hash,
                    row.priority,
                    row.state,
                    row.summary_json,
                    row.attempts,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 待处理的 L4A 摘要任务（按优先级升序，最新内容哈希去重由调用方把关）
    pub fn list_pending_summary_jobs(
        &self,
        workspace_id: &str,
        limit: usize,
    ) -> Result<Vec<SummaryJobRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM summary_jobs WHERE workspace_id = ? AND state IN ('queued', 'running')
                 ORDER BY priority ASC, created_at ASC LIMIT ?",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id, limit as i64], summary_job_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 写入/更新任务持久化行（job_runs）
    pub fn upsert_job_run(&self, row: &JobRunRow) -> Result<(), GuanlanError> {
        self.conn
            .execute(
                "INSERT INTO job_runs (job_id, workspace_id, kind, state, phase, request_json,
                    progress_json, error, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (job_id) DO UPDATE SET
                   state = excluded.state,
                   phase = excluded.phase,
                   progress_json = excluded.progress_json,
                   error = excluded.error,
                   updated_at = excluded.updated_at",
                params![
                    row.job_id,
                    row.workspace_id,
                    row.kind,
                    row.state,
                    row.phase,
                    row.request_json,
                    row.progress_json,
                    row.error,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map_err(internal_sql)?;
        Ok(())
    }

    /// 重启恢复：仍在进行中的任务行（queued/running → 重入队）
    pub fn list_active_job_runs(&self, workspace_id: &str) -> Result<Vec<JobRunRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM job_runs WHERE workspace_id = ? AND state IN ('queued', 'running')
                 ORDER BY created_at ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], job_run_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 读 meta 键 `initiative_dirs`（JSON 字符串数组；缺失/损坏返回空表）
    pub fn initiative_dirs(&self) -> Result<Vec<String>, GuanlanError> {
        let Some(raw) = self.get_meta("initiative_dirs")? else {
            return Ok(Vec::new());
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => return Ok(Vec::new()),
        };
        Ok(parsed
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// 写 meta 键 `initiative_dirs`（幂等覆盖——建议1 的三个写入路径共用）
    pub fn set_initiative_dirs(&self, dirs: &[String]) -> Result<(), GuanlanError> {
        let value = serde_json::to_string(dirs)
            .map_err(|e| GuanlanError::Internal(format!("序列化 initiative_dirs 失败：{e}")))?;
        self.set_meta("initiative_dirs", &value)
    }

    /// 读当前工作区的快照配额策略（优先环境变量，其次 `meta` 持久化阈值，默认 10MB / 50MB）。
    pub fn snapshot_policy(&self) -> crate::index::file_format::SnapshotPolicy {
        let text_mb = self
            .get_meta("snapshot_text_max_mb")
            .ok()
            .flatten()
            .and_then(|s| s.trim().parse::<i64>().ok());
        let binary_mb = self
            .get_meta("snapshot_binary_max_mb")
            .ok()
            .flatten()
            .and_then(|s| s.trim().parse::<i64>().ok());
        crate::index::file_format::SnapshotPolicy::from_overrides_and_env(text_mb, binary_mb)
    }

    /// 持久化工作区级快照配额阈值（单位：MiB；须 > 0 且文本上限 ≤ 512 MiB、二进制上限 ≤ 2048 MiB）。
    pub fn set_snapshot_policy(
        &self,
        text_max_mib: u64,
        binary_max_mib: u64,
    ) -> Result<crate::index::file_format::SnapshotPolicy, GuanlanError> {
        if text_max_mib == 0 || text_max_mib > 512 {
            return Err(GuanlanError::BadRequest(
                "文本类快照阈值须在 1–512 MiB 之间".to_owned(),
            ));
        }
        if binary_max_mib == 0 || binary_max_mib > 2048 {
            return Err(GuanlanError::BadRequest(
                "二进制/办公/图片快照阈值须在 1–2048 MiB 之间".to_owned(),
            ));
        }
        self.set_meta("snapshot_text_max_mb", &text_max_mib.to_string())?;
        self.set_meta("snapshot_binary_max_mb", &binary_max_mib.to_string())?;
        Ok(self.snapshot_policy())
    }

    // ---------- 快照 ----------

    /// 快照路径（契约 §3.2）：`<blobsDir>/<hash 前 2 位>/<完整 hash>`
    pub fn blob_path_for(&self, hash: &str) -> PathBuf {
        self.blobs_dir.join(&hash[..2]).join(hash)
    }

    /// 写入并校验内容快照（契约 §3.3，事务外 IO）。
    ///
    /// 顺序：同哈希已存在且校验通过则不重写 → 写临时文件 → **重读临时文件重算
    /// SHA-256** 校验 → 同卷原子改名。
    ///
    /// 与 TS 的差异：TS 写的是采集阶段已读入内存的字节；Rust 采集阶段不驻留内容
    /// （方案 §165），改为**重读源文件**并流式落盘。因此源文件若在采集之后被
    /// 改写，落盘内容与采集时的哈希不符——此时**不能**写入与哈希不符的快照，
    /// 按「本轮不稳定」处理（[`SnapshotOutcome::Unstable`]），由调用方当读取问题
    /// 记录并等下一轮恢复，而不是让整轮对账失败。
    pub fn write_snapshot_to_disk(
        &self,
        source: &Path,
        hash: &str,
    ) -> Result<SnapshotOutcome, GuanlanError> {
        let target = self.blob_path_for(hash);
        if target.is_file() {
            if let Ok(existing) = hash_file(&target) {
                if existing == hash {
                    return Ok(SnapshotOutcome::Existing);
                }
            }
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                GuanlanError::Internal(format!("创建快照目录失败 {}：{e}", parent.display()))
            })?;
        }
        let tmp = target.with_extension(format!("tmp-{}-{}", std::process::id(), unique_suffix()));
        stream_to_file(source, &tmp)?;
        // 重读校验：磁盘上的字节必须与登记的哈希一致
        let actual = hash_file(&tmp)?;
        if actual != hash {
            let _ = fs::remove_file(&tmp);
            // 源文件在采集之后被改写：本轮不落版本，下轮对账会恢复
            return Ok(SnapshotOutcome::Unstable);
        }
        fs::rename(&tmp, &target).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            GuanlanError::Internal(format!("快照改名失败 {}：{e}", target.display()))
        })?;
        Ok(SnapshotOutcome::Written)
    }

    /// 读快照内容
    pub fn read_snapshot(&self, hash: &str) -> Option<Vec<u8>> {
        fs::read(self.blob_path_for(hash)).ok()
    }

    /// V04 · 批量确立已读基线、单文件/目录标已读与标未读、一键撤销还原（单事务、幂等、绝不伪造 scrollPercent）。
    ///
    /// - `mark_baseline`：`scope = workspace | folder`（配合 `folder_prefix`），只更新
    ///   当前尚无基线或 `last_read_revision_id != files.last_revision_id` 的活跃文件，
    ///   同时返回每条受影响文件的原状 `undo_items`，支持前端 8 秒 Toast 100% 撤销还原；
    /// - `mark_read`：按 `file_ids`（单文件可选 `revision_id`）落库服务端已读基线，消除单篇已读仅存本地导致的分裂；
    /// - `mark_unread`：按 `file_ids` 或 `scope = folder | workspace` 清除 `reading_states` 行并返回 `undo_items`；
    /// - `restore`：严格按 `restore_items` 还原或清除 `reading_states` 行。
    pub fn batch_reading_state(
        &mut self,
        req: &crate::dto::ReadingStateBatchRequest,
    ) -> Result<crate::dto::ReadingStateBatchResponse, GuanlanError> {
        use crate::dto::{ReadingStateBatchResponse, ReadingStateEntry, ReadingStateUndoItem};
        use rusqlite::OptionalExtension;

        fn escape_like_prefix(prefix: &str) -> String {
            let mut out = String::with_capacity(prefix.len() + 4);
            for ch in prefix.chars() {
                match ch {
                    '\\' | '%' | '_' => {
                        out.push('\\');
                        out.push(ch);
                    }
                    _ => out.push(ch),
                }
            }
            out
        }

        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS reading_states (
                    workspace_id          TEXT NOT NULL,
                    file_id               TEXT NOT NULL,
                    last_read_revision_id TEXT NOT NULL,
                    updated_at            TEXT NOT NULL,
                    PRIMARY KEY (workspace_id, file_id)
                );
                CREATE INDEX IF NOT EXISTS idx_reading_states_ws ON reading_states(workspace_id);",
            )
            .map_err(internal_sql)?;

        let ws_id = self.workspace.workspace_id.clone();
        let action = req.action.trim().to_ascii_lowercase();
        let now = clock::now_iso();

        match action.as_str() {
            "restore" => {
                let items = req.restore_items.as_deref().unwrap_or(&[]);
                let tx = self.conn.transaction().map_err(internal_sql)?;
                let mut upsert = tx
                    .prepare(
                        "INSERT INTO reading_states
                           (workspace_id, file_id, last_read_revision_id, updated_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(workspace_id, file_id) DO UPDATE SET
                           last_read_revision_id = excluded.last_read_revision_id,
                           updated_at = excluded.updated_at",
                    )
                    .map_err(internal_sql)?;
                let mut delete = tx
                    .prepare("DELETE FROM reading_states WHERE workspace_id = ?1 AND file_id = ?2")
                    .map_err(internal_sql)?;
                let mut updated_items = Vec::new();
                let mut affected = 0u64;
                for item in items {
                    if let Some(prev_rev) = item.previous_revision_id.as_deref() {
                        let ts = item.previous_updated_at.as_deref().unwrap_or(&now);
                        upsert
                            .execute(params![ws_id, item.file_id, prev_rev, ts])
                            .map_err(internal_sql)?;
                        updated_items.push(ReadingStateEntry {
                            file_id: item.file_id.clone(),
                            last_read_revision_id: prev_rev.to_owned(),
                            updated_at: ts.to_owned(),
                        });
                        affected += 1;
                    } else {
                        let removed = delete
                            .execute(params![ws_id, item.file_id])
                            .map_err(internal_sql)?;
                        if removed > 0 {
                            affected += 1;
                        }
                    }
                }
                drop(upsert);
                drop(delete);
                tx.commit().map_err(internal_sql)?;
                Ok(ReadingStateBatchResponse {
                    ok: true,
                    action: "restore".to_owned(),
                    affected_count: affected,
                    updated_items,
                    undo_items: Vec::new(),
                })
            }
            "mark_read" => {
                let file_ids: Vec<String> = req
                    .file_ids
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect();
                if file_ids.is_empty() {
                    return Err(GuanlanError::BadRequest(
                        "action=mark_read 时必须提供非空 file_ids".to_owned(),
                    ));
                }
                let explicit_rev = req
                    .revision_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let tx = self.conn.transaction().map_err(internal_sql)?;
                let mut lookup = tx
                    .prepare(
                        "SELECT f.last_revision_id, rs.last_read_revision_id, rs.updated_at
                           FROM files f
                           LEFT JOIN reading_states rs
                             ON rs.workspace_id = f.workspace_id
                            AND rs.file_id = f.file_id
                          WHERE f.workspace_id = ?1
                            AND f.file_id = ?2
                            AND f.status = 'active'",
                    )
                    .map_err(internal_sql)?;
                let mut upsert = tx
                    .prepare(
                        "INSERT INTO reading_states
                           (workspace_id, file_id, last_read_revision_id, updated_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(workspace_id, file_id) DO UPDATE SET
                           last_read_revision_id = excluded.last_read_revision_id,
                           updated_at = excluded.updated_at",
                    )
                    .map_err(internal_sql)?;
                let mut updated_items = Vec::new();
                let mut undo_items = Vec::new();
                for fid in &file_ids {
                    let row_opt: Option<(Option<String>, Option<String>, Option<String>)> = lookup
                        .query_row(params![ws_id, fid], |row| {
                            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                        })
                        .optional()
                        .map_err(internal_sql)?;
                    let Some((last_rev, prev_rev, prev_at)) = row_opt else {
                        continue;
                    };
                    let target_rev = if file_ids.len() == 1 {
                        explicit_rev.clone().or(last_rev)
                    } else {
                        last_rev
                    };
                    let Some(target_rev) = target_rev.filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    if prev_rev.as_deref() == Some(target_rev.as_str()) {
                        continue;
                    }
                    upsert
                        .execute(params![ws_id, fid, target_rev, now])
                        .map_err(internal_sql)?;
                    undo_items.push(ReadingStateUndoItem {
                        file_id: fid.clone(),
                        previous_revision_id: prev_rev,
                        previous_updated_at: prev_at,
                    });
                    updated_items.push(ReadingStateEntry {
                        file_id: fid.clone(),
                        last_read_revision_id: target_rev,
                        updated_at: now.clone(),
                    });
                }
                drop(lookup);
                drop(upsert);
                tx.commit().map_err(internal_sql)?;
                Ok(ReadingStateBatchResponse {
                    ok: true,
                    action: "mark_read".to_owned(),
                    affected_count: updated_items.len() as u64,
                    updated_items,
                    undo_items,
                })
            }
            "mark_unread" => {
                let explicit_ids: Vec<String> = req
                    .file_ids
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect();
                let tx = self.conn.transaction().map_err(internal_sql)?;
                let candidates: Vec<(String, String, String)> = if !explicit_ids.is_empty() {
                    let mut lookup = tx
                        .prepare(
                            "SELECT file_id, last_read_revision_id, updated_at
                               FROM reading_states
                              WHERE workspace_id = ?1 AND file_id = ?2",
                        )
                        .map_err(internal_sql)?;
                    let mut out = Vec::new();
                    for fid in &explicit_ids {
                        if let Some(row) = lookup
                            .query_row(params![ws_id, fid], |r| {
                                Ok((
                                    r.get::<_, String>(0)?,
                                    r.get::<_, String>(1)?,
                                    r.get::<_, String>(2)?,
                                ))
                            })
                            .optional()
                            .map_err(internal_sql)?
                        {
                            out.push(row);
                        }
                    }
                    out
                } else {
                    let scope = req
                        .scope
                        .as_deref()
                        .unwrap_or("workspace")
                        .trim()
                        .to_ascii_lowercase();
                    if scope != "workspace" && scope != "folder" {
                        return Err(GuanlanError::BadRequest(format!(
                            "不支持的 scope：{scope}（仅支持 workspace | folder）"
                        )));
                    }
                    if scope == "folder" {
                        let raw = req.folder_prefix.as_deref().unwrap_or("").trim();
                        let cleaned = raw.replace('\\', "/").trim_matches('/').to_owned();
                        if cleaned.is_empty() {
                            return Err(GuanlanError::BadRequest(
                                "scope=folder 时必须提供非空 folder_prefix".to_owned(),
                            ));
                        }
                        let like_pattern = format!("{}/%", escape_like_prefix(&cleaned));
                        let mut stmt = tx
                            .prepare(
                                "SELECT rs.file_id, rs.last_read_revision_id, rs.updated_at
                                   FROM reading_states rs
                                   INNER JOIN files f
                                     ON f.workspace_id = rs.workspace_id
                                    AND f.file_id = rs.file_id
                                  WHERE rs.workspace_id = ?1
                                    AND f.status = 'active'
                                    AND (REPLACE(f.current_path, char(92), '/') = ?2
                                         OR REPLACE(f.current_path, char(92), '/') LIKE ?3 ESCAPE '\\')",
                            )
                            .map_err(internal_sql)?;
                        let rows = stmt
                            .query_map(params![ws_id, cleaned, like_pattern], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, String>(2)?,
                                ))
                            })
                            .map_err(internal_sql)?;
                        rows.collect::<Result<Vec<_>, _>>().map_err(internal_sql)?
                    } else {
                        let mut stmt = tx
                            .prepare(
                                "SELECT file_id, last_read_revision_id, updated_at
                                   FROM reading_states
                                  WHERE workspace_id = ?1",
                            )
                            .map_err(internal_sql)?;
                        let rows = stmt
                            .query_map(params![ws_id], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, String>(2)?,
                                ))
                            })
                            .map_err(internal_sql)?;
                        rows.collect::<Result<Vec<_>, _>>().map_err(internal_sql)?
                    }
                };
                let mut delete = tx
                    .prepare("DELETE FROM reading_states WHERE workspace_id = ?1 AND file_id = ?2")
                    .map_err(internal_sql)?;
                let mut undo_items = Vec::with_capacity(candidates.len());
                for (file_id, prev_rev, prev_at) in candidates {
                    delete
                        .execute(params![ws_id, file_id])
                        .map_err(internal_sql)?;
                    undo_items.push(ReadingStateUndoItem {
                        file_id,
                        previous_revision_id: Some(prev_rev),
                        previous_updated_at: Some(prev_at),
                    });
                }
                drop(delete);
                tx.commit().map_err(internal_sql)?;
                Ok(ReadingStateBatchResponse {
                    ok: true,
                    action: "mark_unread".to_owned(),
                    affected_count: undo_items.len() as u64,
                    updated_items: Vec::new(),
                    undo_items,
                })
            }
            "mark_baseline" | "" => {
                let scope = req
                    .scope
                    .as_deref()
                    .unwrap_or("workspace")
                    .trim()
                    .to_ascii_lowercase();
                if scope != "workspace" && scope != "folder" {
                    return Err(GuanlanError::BadRequest(format!(
                        "不支持的 scope：{scope}（仅支持 workspace | folder）"
                    )));
                }
                let normalized_prefix = if scope == "folder" {
                    let raw = req.folder_prefix.as_deref().unwrap_or("").trim();
                    let cleaned = raw.replace('\\', "/").trim_matches('/').to_owned();
                    if cleaned.is_empty() {
                        return Err(GuanlanError::BadRequest(
                            "scope=folder 时必须提供非空 folder_prefix".to_owned(),
                        ));
                    }
                    Some(cleaned)
                } else {
                    None
                };

                let tx = self.conn.transaction().map_err(internal_sql)?;
                let candidates: Vec<(String, String, Option<String>, Option<String>)> =
                    if let Some(prefix) = &normalized_prefix {
                        let like_pattern = format!("{}/%", escape_like_prefix(prefix));
                        let mut stmt = tx
                            .prepare(
                                "SELECT f.file_id, f.last_revision_id,
                                        rs.last_read_revision_id, rs.updated_at
                                   FROM files f
                                   LEFT JOIN reading_states rs
                                     ON rs.workspace_id = f.workspace_id
                                    AND rs.file_id = f.file_id
                                  WHERE f.workspace_id = ?1
                                    AND f.status = 'active'
                                    AND f.last_revision_id IS NOT NULL
                                    AND f.last_revision_id != ''
                                    AND (REPLACE(f.current_path, char(92), '/') = ?2
                                         OR REPLACE(f.current_path, char(92), '/') LIKE ?3 ESCAPE '\\')
                                    AND (rs.last_read_revision_id IS NULL
                                         OR rs.last_read_revision_id != f.last_revision_id)",
                            )
                            .map_err(internal_sql)?;
                        let rows = stmt
                            .query_map(params![ws_id, prefix, like_pattern], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, Option<String>>(2)?,
                                    row.get::<_, Option<String>>(3)?,
                                ))
                            })
                            .map_err(internal_sql)?;
                        rows.collect::<Result<Vec<_>, _>>().map_err(internal_sql)?
                    } else {
                        let mut stmt = tx
                            .prepare(
                                "SELECT f.file_id, f.last_revision_id,
                                        rs.last_read_revision_id, rs.updated_at
                                   FROM files f
                                   LEFT JOIN reading_states rs
                                     ON rs.workspace_id = f.workspace_id
                                    AND rs.file_id = f.file_id
                                  WHERE f.workspace_id = ?1
                                    AND f.status = 'active'
                                    AND f.last_revision_id IS NOT NULL
                                    AND f.last_revision_id != ''
                                    AND (rs.last_read_revision_id IS NULL
                                         OR rs.last_read_revision_id != f.last_revision_id)",
                            )
                            .map_err(internal_sql)?;
                        let rows = stmt
                            .query_map(params![ws_id], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, Option<String>>(2)?,
                                    row.get::<_, Option<String>>(3)?,
                                ))
                            })
                            .map_err(internal_sql)?;
                        rows.collect::<Result<Vec<_>, _>>().map_err(internal_sql)?
                    };

                let mut upsert = tx
                    .prepare(
                        "INSERT INTO reading_states
                           (workspace_id, file_id, last_read_revision_id, updated_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(workspace_id, file_id) DO UPDATE SET
                           last_read_revision_id = excluded.last_read_revision_id,
                           updated_at = excluded.updated_at",
                    )
                    .map_err(internal_sql)?;

                let mut updated_items = Vec::with_capacity(candidates.len());
                let mut undo_items = Vec::with_capacity(candidates.len());
                for (file_id, latest_rev, prev_rev, prev_at) in candidates {
                    upsert
                        .execute(params![ws_id, file_id, latest_rev, now])
                        .map_err(internal_sql)?;
                    undo_items.push(ReadingStateUndoItem {
                        file_id: file_id.clone(),
                        previous_revision_id: prev_rev,
                        previous_updated_at: prev_at,
                    });
                    updated_items.push(ReadingStateEntry {
                        file_id,
                        last_read_revision_id: latest_rev,
                        updated_at: now.clone(),
                    });
                }
                drop(upsert);
                tx.commit().map_err(internal_sql)?;

                Ok(ReadingStateBatchResponse {
                    ok: true,
                    action: "mark_baseline".to_owned(),
                    affected_count: updated_items.len() as u64,
                    updated_items,
                    undo_items,
                })
            }
            other => Err(GuanlanError::BadRequest(format!(
                "不支持的 action：{other}（仅支持 mark_baseline | mark_read | mark_unread | restore）"
            ))),
        }
    }
}

/// 唯一约束冲突判定（`SQLITE_CONSTRAINT_UNIQUE` = 2067）
fn is_unique_violation(err: &rusqlite::Error) -> bool {
    const SQLITE_CONSTRAINT_UNIQUE: i32 = 2067;
    if err.sqlite_extended_error_code() == Some(SQLITE_CONSTRAINT_UNIQUE) {
        return true;
    }
    match err {
        rusqlite::Error::SqliteFailure(_, Some(message)) => {
            message.contains("UNIQUE constraint failed")
        }
        _ => false,
    }
}

/// 文件内容 SHA-256（流式）
fn hash_file(path: &Path) -> Result<String, GuanlanError> {
    let mut file = fs::File::open(path)
        .map_err(|e| GuanlanError::Internal(format!("读取快照失败 {}：{e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| GuanlanError::Internal(format!("读取快照失败 {}：{e}", path.display())))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 把源文件流式写入目标文件，返回写入字节数
fn stream_to_file(source: &Path, target: &Path) -> Result<u64, GuanlanError> {
    let mut input = fs::File::open(source)
        .map_err(|e| GuanlanError::Internal(format!("读取源文件失败 {}：{e}", source.display())))?;
    let mut output = fs::File::create(target)
        .map_err(|e| GuanlanError::Internal(format!("写临时快照失败 {}：{e}", target.display())))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = input.read(&mut buf).map_err(|e| {
            GuanlanError::Internal(format!("读取源文件失败 {}：{e}", source.display()))
        })?;
        if read == 0 {
            break;
        }
        use std::io::Write;
        output.write_all(&buf[..read]).map_err(|e| {
            GuanlanError::Internal(format!("写临时快照失败 {}：{e}", target.display()))
        })?;
        total += read as u64;
    }
    use std::io::Write;
    output.flush().map_err(|e| {
        GuanlanError::Internal(format!("刷新临时快照失败 {}：{e}", target.display()))
    })?;
    Ok(total)
}

/// 临时文件后缀（进程号 + 纳秒时钟，避免同目录撞名）
fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::state_engine::state_machine_recompute;
    use crate::index::state_machine::{initiative_id_of, DocState, Stage};

    /// v2 schema 幂等建表 + user_version 0→2 单向（约束/契约 §4.3）
    #[test]
    fn ensure_schema_creates_v2_tables_and_bumps_user_version_once() {
        let dir = std::env::temp_dir().join(format!(
            "guanlan-writer-schema-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let root = format!(
            r"H:\guanlan-writer-fixture\{}",
            dir.file_name().expect("名").to_string_lossy()
        );

        let writer = Writer::open_at(&dir, &root).expect("打开写库");
        let version: i64 = writer
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读版本");
        assert_eq!(version, 2, "首次建库应登记 schema v2");

        // 7 张新表全部存在
        for table in [
            "initiatives",
            "artifact_states",
            "task_nodes",
            "checkpoints",
            "revision_drafts",
            "summary_jobs",
            "job_runs",
        ] {
            let count: i64 = writer
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                    params![table],
                    |row| row.get(0),
                )
                .expect("查表");
            assert_eq!(count, 1, "新表 {table} 应存在");
        }

        // 重开（幂等迁移路径）：版本不回退、行不丢
        let writer2 = Writer::open_at(&dir, &root).expect("重开写库");
        let version2: i64 = writer2
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读版本");
        assert_eq!(version2, 2, "重开不回退版本");

        // 人为把版本降回 1（模拟旧批次库）：ensure_schema 只升不降，升回 2
        writer2
            .conn()
            .execute_batch("PRAGMA user_version = 1;")
            .expect("降版本");
        let writer3 = Writer::open_at(&dir, &root).expect("三开写库");
        let version3: i64 = writer3
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读版本");
        assert_eq!(version3, 2, "旧库应被条件升级到 2");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// checkpoint seq 由库内派生（约束2）：重复提交追加新行不撞主键；
    /// node_id 缺省与给定的 seq 各自独立计数
    #[test]
    fn checkpoint_seq_is_db_derived_and_restart_safe() {
        let dir = std::env::temp_dir().join(format!(
            "guanlan-writer-ckpt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let root = format!(
            r"H:\guanlan-writer-fixture\{}",
            dir.file_name().expect("名").to_string_lossy()
        );
        let writer = Writer::open_at(&dir, &root).expect("打开写库");
        let workspace_id = writer.workspace().expect("工作区").workspace_id;
        let initiative_id = initiative_id_of("01-演示专项");

        writer
            .upsert_initiative(&InitiativeRow {
                initiative_id: initiative_id.clone(),
                workspace_id: workspace_id.clone(),
                name: "01-演示专项".to_owned(),
                root_dir: "01-演示专项".to_owned(),
                current_stage: Stage::Executing.as_str().to_owned(),
                state: DocState::Executing.as_str().to_owned(),
                artifact_count: 0,
                pending_p0: 0,
                pending_p1: 0,
                pending_p2: 0,
                created_at: "2026-11-18T00:00:00.000Z".to_owned(),
                updated_at: "2026-11-18T00:00:00.000Z".to_owned(),
            })
            .expect("建专项行");

        let input_of = |note: &str| CheckpointInput {
            node_id: None,
            workspace_id: workspace_id.clone(),
            initiative_id: initiative_id.clone(),
            stage: Stage::Executing.as_str().to_owned(),
            status: "SUCCESS".to_owned(),
            input_context_hash: "a".repeat(64),
            output_revision_id: None,
            token_usage: Some(1024),
            elapsed_ms: Some(5000),
            note: Some(note.to_owned()),
            created_at: clock::now_iso(),
        };

        // 同节点连续两次 SUCCESS：追加两行、主键互异（重启前后同理——seq 来自 COUNT）
        let first = writer
            .insert_checkpoint(&input_of("第一轮"))
            .expect("插第一行");
        let second = writer
            .insert_checkpoint(&input_of("第二轮"))
            .expect("插第二行");
        assert_ne!(
            first, second,
            "两次提交主键必须互异（约束2：撞主键即修复失败）"
        );

        // 模拟重启：新写连接（seq 计数仍来自库）
        let reopened = Writer::open_at(&dir, &root).expect("重启后重开");
        let third = reopened
            .insert_checkpoint(&input_of("重启后"))
            .expect("插第三行");
        assert_ne!(third, first, "重启后同节点再次 SUCCESS 不得复用既有主键");
        assert_ne!(third, second);

        // 恢复查询：最近一次 SUCCESS（按 created_at/rowid 取最新）
        let latest = reopened
            .latest_success_checkpoint(
                &workspace_id,
                &initiative_id,
                Stage::Executing.as_str(),
                None,
            )
            .expect("查恢复快照")
            .expect("应有三行里的最新一行");
        assert_eq!(latest.checkpoint_id, third, "恢复应取最近一次 SUCCESS");

        // 未知状态被拒
        let mut bad = input_of("非法状态");
        bad.status = "DONE".to_owned();
        assert!(reopened.insert_checkpoint(&bad).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// initiative_dirs：meta 键幂等覆盖（建议1）
    #[test]
    fn initiative_dirs_roundtrip_and_cover() {
        let dir = std::env::temp_dir().join(format!(
            "guanlan-writer-dirs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let root = format!(
            r"H:\guanlan-writer-fixture\{}",
            dir.file_name().expect("名").to_string_lossy()
        );
        let writer = Writer::open_at(&dir, &root).expect("打开写库");

        assert!(writer.initiative_dirs().expect("缺键返回空").is_empty());
        writer
            .set_initiative_dirs(&["BOM与图纸联动方案".to_owned(), "99-手工登记".to_owned()])
            .expect("写 dirs");
        assert_eq!(
            writer.initiative_dirs().expect("读 dirs"),
            vec!["BOM与图纸联动方案".to_owned(), "99-手工登记".to_owned()]
        );
        // 幂等覆盖：整表替换不追加
        writer
            .set_initiative_dirs(&["只此一个".to_owned()])
            .expect("覆盖 dirs");
        assert_eq!(
            writer.initiative_dirs().expect("覆盖后读"),
            vec!["只此一个".to_owned()]
        );

        // recompute 消费 meta dirs（PRD 例「BOM与图纸联动方案」）
        let mut writer = writer;
        let workspace_id = writer.workspace().expect("ws").workspace_id;
        let outcome =
            state_machine_recompute(&mut writer, &workspace_id, "2026-11-18T00:00:00.000Z", &[])
                .expect("重算");
        assert_eq!(outcome.initiatives_upserted, 0, "无文件时无专项行");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
