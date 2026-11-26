//! SQLite 只读存储（契约 native/docs/contract-storage.md §1/§3/§4）。
//!
//! 只读侧边界（契约 §4.1）：
//! 1. 不写库：不 `exec(SCHEMA)`、不 `ALTER TABLE`、不写 `meta`、不 bump generation、不 `markScan`；
//! 2. 不生成第二套历史：身份读取直接以库内行为准；
//! 3. 打开已有数据零扫描：打开后立即开放读取，不在读路径里做目录枚举或内容哈希。
//!
//! 写入侧另起一路：[`crate::index::writer::Writer`] 持库里唯一一条可写连接
//! （由服务层专用写线程独占）。本模块保持**只读**：读侧连接池以
//! `SQLITE_OPEN_READONLY` 打开，两侧靠 WAL 并行（契约 §4.2）。
//!
//! 只读连接按 `SQLITE_OPEN_READONLY` 打开：读服务只做读取，WAL 库在 Windows 上
//! 对 `-shm`/`-wal` 的可写性要求由「读连接首次读时创建/附加 shm」满足；服务级排他锁属
//! guanlan-service 装配层职责，core 不重复实现。若部署环境连 `-shm` 都不可写，
//! 打开会直接失败（fail fast），不会退化为可写连接。
//!
//! 连接 PRAGMA（契约 §1.2）：`journal_mode=WAL` 是写操作，只读连接不执行——WAL
//! 模式沿用库文件既有状态；`busy_timeout=5000` 与 `foreign_keys=ON` 是连接级
//! 设置，照旧执行。
//!
//! 目录布局（契约 §3.2）：`<dataDir>/index.db`（WAL，含 `-wal`/`-shm`）+
//! `<dataDir>/blobs/<hash 前 2 位>/<完整 hash>`；数据目录解析顺序见契约 §3.1。
//! 只读打开时不做 `mkdirSync(blobsDir)`（契约 §3.2）。

pub mod ledger;
pub mod maintenance;
pub mod migration;
pub mod sandbox;

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::domain;
use crate::dto::WorkspaceRecord;
use crate::error::GuanlanError;

/// 库内行结构（镜像 server/WorkspaceStore.ts 的行接口；读取专用）。
/// 这些结构只在 core 内部与服务装配层使用，不直接序列化进 wire。
///
/// files 行（WorkspaceStore.ts:48-60）
#[derive(Debug, Clone)]
pub struct FileRow {
    pub file_id: String,
    pub workspace_id: String,
    pub current_path: String,
    pub format: String,
    pub title: String,
    pub role: String,
    pub first_observed_at: String,
    pub last_observed_at: String,
    pub last_mtime_ms: f64,
    pub last_revision_id: Option<String>,
    pub status: String,
}

/// revisions 行（WorkspaceStore.ts:62-77）
#[derive(Debug, Clone)]
pub struct RevisionRow {
    pub revision_id: String,
    pub file_id: String,
    pub workspace_id: String,
    pub seq: i64,
    pub prev_revision_id: Option<String>,
    pub content_hash: String,
    pub size_bytes: i64,
    pub observed_at: String,
    pub occurred_at: Option<String>,
    pub occurred_precision: String,
    pub occurred_source: Option<String>,
    pub snapshot_hash: String,
    pub snapshot_available: i64,
    pub extract_rule_version: String,
}

/// events 行（WorkspaceStore.ts:79-95）
#[derive(Debug, Clone)]
pub struct EventRow {
    pub seq: i64,
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

/// statements 行（WorkspaceStore.ts:97-114）
#[derive(Debug, Clone)]
pub struct StatementRow {
    pub statement_id: String,
    pub workspace_id: String,
    pub file_id: String,
    pub revision_id: String,
    pub code: String,
    pub namespace: String,
    pub question: String,
    pub status: String,
    pub quote: String,
    pub line_start: i64,
    pub line_end: i64,
    pub decision_id: Option<String>,
    pub detail_json: String,
    pub extract_rule_version: String,
    pub observed_at: String,
}

/// edges 行（WorkspaceStore.ts:116-128）
#[derive(Debug, Clone)]
pub struct EdgeRow {
    pub edge_id: String,
    pub workspace_id: String,
    pub source_file_id: String,
    pub source_revision_id: String,
    pub target_file_id: String,
    pub target_revision_id: Option<String>,
    pub kind: String,
    pub resolution: String,
    pub locator_start: Option<i64>,
    pub locator_end: Option<i64>,
    pub reason: String,
}

/// initiatives 行（专项；阶段/状态 wire 词见
/// `crate::index::state_machine`）
#[derive(Debug, Clone)]
pub struct InitiativeRow {
    pub initiative_id: String,
    pub workspace_id: String,
    pub name: String,
    pub root_dir: String,
    pub current_stage: String,
    pub state: String,
    pub artifact_count: i64,
    pub pending_p0: i64,
    pub pending_p1: i64,
    pub pending_p2: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// artifact_states 行（文档级状态投影；file_id 复用 files 主键，禁止第二套文件身份）
#[derive(Debug, Clone)]
pub struct ArtifactStateRow {
    pub file_id: String,
    pub workspace_id: String,
    pub initiative_id: Option<String>,
    pub stage: String,
    pub state: String,
    pub selected_revision_id: Option<String>,
    pub checklist_done: i64,
    pub checklist_total: i64,
    pub pending_p0: i64,
    pub pending_p1: i64,
    pub pending_p2: i64,
    pub last_activity_at: Option<String>,
    pub updated_at: String,
}

/// task_nodes 行（长任务 DAG 五槽位；state 由 recompute 声明式重算跨轮维持）
#[derive(Debug, Clone)]
pub struct TaskNodeRow {
    pub node_id: String,
    pub workspace_id: String,
    pub initiative_id: String,
    pub stage: String,
    pub title: String,
    pub node_kind: String,
    pub state: String,
    pub depends_json: String,
    pub payload_json: String,
    pub latest_checkpoint_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// checkpoints 行（断点续跑快照）
#[derive(Debug, Clone)]
pub struct CheckpointRow {
    pub checkpoint_id: String,
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

/// revision_drafts 行（Agent 草案分支）
#[derive(Debug, Clone)]
pub struct RevisionDraftRow {
    pub draft_id: String,
    pub workspace_id: String,
    pub file_id: String,
    pub base_revision_id: String,
    pub base_content_hash: String,
    pub proposed_content_hash: String,
    pub snapshot_rel_path: String,
    /// mcp | agent
    pub source: String,
    /// proposed | adopted | dismissed
    pub status: String,
    pub conflict: i64,
    pub note: Option<String>,
    /// 独立草案分支版本标签（如 `v3-agent-draft`）
    pub draft_version_label: String,
    /// 提交本次草案所依赖的输入上下文哈希清单（JSON 数组串）
    pub input_context_hashes_json: String,
    /// Agent 回执摘要（一句话说明修改意图/验证结论）
    pub receipt_summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// summary_jobs 行（L4A 后台沉淀队列；generated_by 恒为 local_deterministic）
#[derive(Debug, Clone)]
pub struct SummaryJobRow {
    pub job_id: String,
    pub workspace_id: String,
    pub file_id: String,
    pub content_hash: String,
    pub priority: i64,
    /// queued | running | done | failed
    pub state: String,
    pub summary_json: Option<String>,
    pub attempts: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// job_runs 行（长任务持久化：重启后 queued/running 重入队）
#[derive(Debug, Clone)]
pub struct JobRunRow {
    pub job_id: String,
    pub workspace_id: String,
    pub kind: String,
    /// queued | running | completed | failed（四态）
    pub state: String,
    pub phase: String,
    pub request_json: String,
    pub progress_json: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn workspace_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    Ok(WorkspaceRecord {
        workspace_id: row.get("workspace_id")?,
        root_path: row.get("root_path")?,
        root_key: row.get("root_key")?,
        created_at: row.get("created_at")?,
        last_scan_at: row.get("last_scan_at")?,
        index_generation: row.get::<_, i64>("index_generation")?.max(0) as u64,
    })
}

pub(crate) fn file_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileRow> {
    Ok(FileRow {
        file_id: row.get("file_id")?,
        workspace_id: row.get("workspace_id")?,
        current_path: row.get("current_path")?,
        format: row.get("format")?,
        title: row.get("title")?,
        role: row.get("role")?,
        first_observed_at: row.get("first_observed_at")?,
        last_observed_at: row.get("last_observed_at")?,
        last_mtime_ms: row.get("last_mtime_ms")?,
        last_revision_id: row.get("last_revision_id")?,
        status: row.get("status")?,
    })
}

pub(crate) fn revision_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RevisionRow> {
    Ok(RevisionRow {
        revision_id: row.get("revision_id")?,
        file_id: row.get("file_id")?,
        workspace_id: row.get("workspace_id")?,
        seq: row.get("seq")?,
        prev_revision_id: row.get("prev_revision_id")?,
        content_hash: row.get("content_hash")?,
        size_bytes: row.get("size_bytes")?,
        observed_at: row.get("observed_at")?,
        occurred_at: row.get("occurred_at")?,
        occurred_precision: row.get("occurred_precision")?,
        occurred_source: row.get("occurred_source")?,
        snapshot_hash: row.get("snapshot_hash")?,
        snapshot_available: row.get("snapshot_available")?,
        extract_rule_version: row.get("extract_rule_version")?,
    })
}

pub(crate) fn event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        seq: row.get("seq")?,
        event_id: row.get("event_id")?,
        workspace_id: row.get("workspace_id")?,
        kind: row.get("kind")?,
        subject_kind: row.get("subject_kind")?,
        subject_id: row.get("subject_id")?,
        revision_id: row.get("revision_id")?,
        occurred_at: row.get("occurred_at")?,
        occurred_precision: row.get("occurred_precision")?,
        occurred_source: row.get("occurred_source")?,
        observed_at: row.get("observed_at")?,
        headline: row.get("headline")?,
        detail: row.get("detail")?,
        payload_json: row.get("payload_json")?,
        batch_id: row.get("batch_id")?,
    })
}

pub(crate) fn statement_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StatementRow> {
    Ok(StatementRow {
        statement_id: row.get("statement_id")?,
        workspace_id: row.get("workspace_id")?,
        file_id: row.get("file_id")?,
        revision_id: row.get("revision_id")?,
        code: row.get("code")?,
        namespace: row.get("namespace")?,
        question: row.get("question")?,
        status: row.get("status")?,
        quote: row.get("quote")?,
        line_start: row.get("line_start")?,
        line_end: row.get("line_end")?,
        decision_id: row.get("decision_id")?,
        detail_json: row.get("detail_json")?,
        extract_rule_version: row.get("extract_rule_version")?,
        observed_at: row.get("observed_at")?,
    })
}

pub(crate) fn edge_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EdgeRow> {
    Ok(EdgeRow {
        edge_id: row.get("edge_id")?,
        workspace_id: row.get("workspace_id")?,
        source_file_id: row.get("source_file_id")?,
        source_revision_id: row.get("source_revision_id")?,
        target_file_id: row.get("target_file_id")?,
        target_revision_id: row.get("target_revision_id")?,
        kind: row.get("kind")?,
        resolution: row.get("resolution")?,
        locator_start: row.get("locator_start")?,
        locator_end: row.get("locator_end")?,
        reason: row.get("reason")?,
    })
}

pub(crate) fn initiative_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InitiativeRow> {
    Ok(InitiativeRow {
        initiative_id: row.get("initiative_id")?,
        workspace_id: row.get("workspace_id")?,
        name: row.get("name")?,
        root_dir: row.get("root_dir")?,
        current_stage: row.get("current_stage")?,
        state: row.get("state")?,
        artifact_count: row.get("artifact_count")?,
        pending_p0: row.get("pending_p0")?,
        pending_p1: row.get("pending_p1")?,
        pending_p2: row.get("pending_p2")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn artifact_state_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactStateRow> {
    Ok(ArtifactStateRow {
        file_id: row.get("file_id")?,
        workspace_id: row.get("workspace_id")?,
        initiative_id: row.get("initiative_id")?,
        stage: row.get("stage")?,
        state: row.get("state")?,
        selected_revision_id: row.get("selected_revision_id")?,
        checklist_done: row.get("checklist_done")?,
        checklist_total: row.get("checklist_total")?,
        pending_p0: row.get("pending_p0")?,
        pending_p1: row.get("pending_p1")?,
        pending_p2: row.get("pending_p2")?,
        last_activity_at: row.get("last_activity_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn task_node_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskNodeRow> {
    Ok(TaskNodeRow {
        node_id: row.get("node_id")?,
        workspace_id: row.get("workspace_id")?,
        initiative_id: row.get("initiative_id")?,
        stage: row.get("stage")?,
        title: row.get("title")?,
        node_kind: row.get("node_kind")?,
        state: row.get("state")?,
        depends_json: row.get("depends_json")?,
        payload_json: row.get("payload_json")?,
        latest_checkpoint_id: row.get("latest_checkpoint_id")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn checkpoint_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CheckpointRow> {
    Ok(CheckpointRow {
        checkpoint_id: row.get("checkpoint_id")?,
        node_id: row.get("node_id")?,
        workspace_id: row.get("workspace_id")?,
        initiative_id: row.get("initiative_id")?,
        stage: row.get("stage")?,
        status: row.get("status")?,
        input_context_hash: row.get("input_context_hash")?,
        output_revision_id: row.get("output_revision_id")?,
        token_usage: row.get("token_usage")?,
        elapsed_ms: row.get("elapsed_ms")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
    })
}

pub(crate) fn revision_draft_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RevisionDraftRow> {
    Ok(RevisionDraftRow {
        draft_id: row.get("draft_id")?,
        workspace_id: row.get("workspace_id")?,
        file_id: row.get("file_id")?,
        base_revision_id: row.get("base_revision_id")?,
        base_content_hash: row.get("base_content_hash")?,
        proposed_content_hash: row.get("proposed_content_hash")?,
        snapshot_rel_path: row.get("snapshot_rel_path")?,
        source: row.get("source")?,
        status: row.get("status")?,
        conflict: row.get("conflict")?,
        note: row.get("note")?,
        draft_version_label: row
            .get::<_, Option<String>>("draft_version_label")
            .ok()
            .flatten()
            .unwrap_or_default(),
        input_context_hashes_json: row
            .get::<_, Option<String>>("input_context_hashes_json")
            .ok()
            .flatten()
            .unwrap_or_else(|| "[]".to_owned()),
        receipt_summary: row
            .get::<_, Option<String>>("receipt_summary")
            .ok()
            .flatten(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn summary_job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SummaryJobRow> {
    Ok(SummaryJobRow {
        job_id: row.get("job_id")?,
        workspace_id: row.get("workspace_id")?,
        file_id: row.get("file_id")?,
        content_hash: row.get("content_hash")?,
        priority: row.get("priority")?,
        state: row.get("state")?,
        summary_json: row.get("summary_json")?,
        attempts: row.get("attempts")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn job_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRunRow> {
    Ok(JobRunRow {
        job_id: row.get("job_id")?,
        workspace_id: row.get("workspace_id")?,
        kind: row.get("kind")?,
        state: row.get("state")?,
        phase: row.get("phase")?,
        request_json: row.get("request_json")?,
        progress_json: row.get("progress_json")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 只读存储句柄，不提供任何写方法。
#[derive(Debug)]
pub struct ReadonlyStore {
    conn: Connection,
    data_dir: PathBuf,
    blobs_dir: PathBuf,
    workspace: Option<String>,
    root_path: Option<String>,
}

impl ReadonlyStore {
    /// 可接受的 schema 版本：
    /// - `0`：旧 Node 库从未写入版本标记，`PRAGMA user_version` 恒为 0
    ///   （契约 §1.3：唯一迁移方式是幂等 SCHEMA）
    /// - `1`：写入侧接管后的首个版本值（契约 §1.2 status 的 schema_version）
    /// - `2`：长任务扩展 schema（7 张新表：initiatives/artifact_states/task_nodes/
    ///   checkpoints/revision_drafts/summary_jobs/job_runs；contract-storage.md §4.3）
    ///
    /// 其他值直接报错拒绝打开：不迁移、不写入（契约 §4-1）。
    /// 注意：低版本二进制打开已升版库会被版本门禁拒绝，读写侧需同包升级（契约 §4.3）。
    pub const SUPPORTED_SCHEMA_VERSIONS: [i64; 3] = [0, 1, 2];

    /// 以只读方式打开 `index.db` 并做 schema 版本校验。
    /// `data_dir` 取库文件父目录，`blobs/` 同目录（契约 §3.2）。
    pub fn open(db_path: &Path) -> Result<Self, GuanlanError> {
        let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(
            |e| GuanlanError::Internal(format!("打开只读库失败 {}: {e}", db_path.display())),
        )?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| GuanlanError::Internal(format!("设置 busy_timeout 失败: {e}")))?;
        conn.pragma_update(None, "foreign_keys", 1)
            .map_err(|e| GuanlanError::Internal(format!("设置 foreign_keys 失败: {e}")))?;
        Self::validate_schema_version(&conn)?;
        let data_dir = db_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let blobs_dir = data_dir.join("blobs");
        Ok(Self {
            conn,
            data_dir,
            blobs_dir,
            workspace: None,
            root_path: None,
        })
    }

    /// 按根目录打开默认数据目录（契约 §3.1 解析顺序）并认领库内工作区行。
    pub fn open_for_root(root_path: &str) -> Result<Self, GuanlanError> {
        let data_dir = default_data_dir(root_path)?;
        let db_path = data_dir.join("index.db");
        let mut store = Self::open(&db_path)?;
        store.claim_workspace(root_path)?;
        Ok(store)
    }

    /// 同 [`Self::open`]，但数据目录显式给定（服务装配层的 dataDir 参数，
    /// 契约 §3.1「显式 dataDir 参数优先」）。
    pub fn open_at(data_dir: &Path, root_path: &str) -> Result<Self, GuanlanError> {
        let mut store = Self::open(&data_dir.join("index.db"))?;
        store.data_dir = data_dir.to_path_buf();
        store.blobs_dir = data_dir.join("blobs");
        store.claim_workspace(root_path)?;
        Ok(store)
    }

    /// 认领库内工作区行（契约 §2.2/§4-2：读取侧只按库内已有行认领，不新建）。
    ///
    /// 查找顺序：先按 `root_key`（与 ensureWorkspace 写入的 root_key 同源，
    /// WorkspaceStore.ts:336-338）精确匹配；未命中且全表恰有一行时按该唯一行认领
    /// （显式 dataDir 指向既有库的场景）。库内无任何可认领行 → NotFound（只读连接
    /// 不写库，无法补建工作区行；契约 §4-1）。
    pub fn claim_workspace(&mut self, root_path: &str) -> Result<WorkspaceRecord, GuanlanError> {
        let resolved = domain::resolve_root(root_path)?;
        let root_key = domain::root_key_of_resolved(&resolved);
        let by_key = self.workspace_by_root_key(&root_key)?;
        let row = match by_key {
            Some(row) => Some(row),
            None => {
                let all = self.all_workspaces()?;
                if all.len() == 1 {
                    Some(all.into_iter().next().expect("len == 1"))
                } else {
                    None
                }
            }
        };
        match row {
            Some(row) => {
                self.workspace = Some(row.workspace_id.clone());
                self.root_path = Some(root_path.to_owned());
                Ok(row)
            }
            None => Err(GuanlanError::NotFound(format!(
                "未找到工作区（root_key={root_key}；数据目录中无可认领的工作区行，只读连接不写库不新建）"
            ))),
        }
    }

    /// 当前认领的工作区行。行内容**每次现读**（`WHERE workspace_id = ?`）：
    /// 与 Node 端 `getWorkspace`（queries.ts:177）同口径——index_generation 与
    /// last_scan_at 是「当前代际计数」，写入者随时会 bump，读服务不得持有快照值
    /// （契约 contract-query-api.md §0.4）。未认领时按 NOT_FOUND 报错
    /// （对齐 queries.ts:178-183 的「未找到工作区」语义）。
    pub fn workspace(&self) -> Result<WorkspaceRecord, GuanlanError> {
        let Some(ws_id) = self.workspace.as_ref() else {
            return Err(GuanlanError::NotFound(
                "未找到工作区（当前数据目录中没有可认领的工作区行）".to_owned(),
            ));
        };
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt.query([ws_id]).map_err(internal_sql)?;
        match rows.next().map_err(internal_sql)? {
            Some(row) => workspace_row(row).map_err(internal_sql),
            None => Err(GuanlanError::NotFound(format!("未找到工作区 {ws_id}"))),
        }
    }

    fn workspace_by_root_key(
        &self,
        root_key: &str,
    ) -> Result<Option<WorkspaceRecord>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM workspaces WHERE root_key = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt.query([root_key]).map_err(internal_sql)?;
        match rows.next().map_err(internal_sql)? {
            Some(row) => Ok(Some(workspace_row(row).map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    fn all_workspaces(&self) -> Result<Vec<WorkspaceRecord>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM workspaces")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map([], workspace_row)
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 读取 `PRAGMA user_version`（契约 §1.3：现库恒为 0）
    pub fn schema_version(&self) -> Result<i64, GuanlanError> {
        Self::read_schema_version(&self.conn)
    }

    fn validate_schema_version(conn: &Connection) -> Result<(), GuanlanError> {
        let version = Self::read_schema_version(conn)?;
        if version > migration::CURRENT_SCHEMA_VERSION {
            return Err(GuanlanError::Internal(format!(
                "SCHEMA_TOO_NEW: 不支持的 schema 版本 {version}（高于本程序最高支持版本 v{}，已拒绝打开以保护历史数据；请升级观澜）",
                migration::CURRENT_SCHEMA_VERSION
            )));
        }
        if !Self::SUPPORTED_SCHEMA_VERSIONS.contains(&version) {
            return Err(GuanlanError::Internal(format!(
                "不支持的 schema 版本 {version}（支持 {:?}），拒绝打开",
                Self::SUPPORTED_SCHEMA_VERSIONS
            )));
        }
        Ok(())
    }

    fn read_schema_version(conn: &Connection) -> Result<i64, GuanlanError> {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| GuanlanError::Internal(format!("读取 PRAGMA user_version 失败: {e}")))
    }

    /// 数据目录（`<dataDir>/index.db` 与 `<dataDir>/blobs/` 的父目录）
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// 快照目录 `<dataDir>/blobs`
    pub fn blobs_dir(&self) -> &Path {
        &self.blobs_dir
    }

    /// 快照两级路径（契约 §3.2；WorkspaceStore.ts:383-385）：
    /// `<blobsDir>/<hash 前 2 位>/<完整 hash>`
    ///
    /// 先校验 hash 形态（64 位小写/大写十六进制）再切分——直接按字节
    /// 取前两位时，导入/损坏库里以非 ASCII 多字节字符开头的 hash 会落在 UTF-8 边界上
    /// 导致 panic。异常数据返回明确错误，不让进程崩在路径拼接上。
    pub fn blob_path_for(&self, hash: &str) -> Result<PathBuf, GuanlanError> {
        if !is_valid_content_hash(hash) {
            return Err(GuanlanError::Internal(format!(
                "content_hash 格式非法（期望 64 位十六进制）：{}",
                redact_hash(hash)
            )));
        }
        Ok(self.blobs_dir.join(&hash[..2]).join(hash))
    }

    /// 对外快照路径（WorkspaceStore.ts:388-390 的读取侧等价物）
    pub fn snapshot_path_for_hash(&self, hash: &str) -> Result<PathBuf, GuanlanError> {
        self.blob_path_for(hash)
    }

    /// 按 revision_id 定位快照文件：revisions 行 → content_hash → blobs 两级路径。
    /// 返回 (快照路径, 版本行)；版本不存在 → NotFound。
    /// 注意：只定位不读取——正文/原始字节由服务层按路径流式返回（不整读大文件）。
    pub fn snapshot_path_for_revision(
        &self,
        revision_id: &str,
    ) -> Result<(PathBuf, RevisionRow), GuanlanError> {
        let rev = self
            .revision_by_id(revision_id)?
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到该版本 {revision_id}")))?;
        Ok((self.blob_path_for(&rev.content_hash)?, rev))
    }

    /// 按 file_id 定位「当前版本」的快照文件：files.last_revision_id → 同上。
    /// 返回 (快照路径, 版本行)；文件不存在或从未有版本 → NotFound。
    pub fn snapshot_path_for_file(
        &self,
        file_id: &str,
    ) -> Result<(PathBuf, RevisionRow), GuanlanError> {
        let file = self
            .file_by_id(file_id)?
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {file_id}")))?;
        let rev = match &file.last_revision_id {
            Some(rev_id) => self.revision_by_id(rev_id)?,
            None => None,
        };
        let rev =
            rev.ok_or_else(|| GuanlanError::NotFound(format!("文件 {file_id} 尚无已提交版本")))?;
        Ok((self.blob_path_for(&rev.content_hash)?, rev))
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// 安装查询取消守护：SQLite progress handler 每条 VM 指令回调一次 `check`，
    /// 返回 `true` 即打断当前语句执行（执行层在请求断开/执行超时时置位）。
    ///
    /// num_ops 必须为 1：SQLite 的 progress 计数按「单条语句自身的 VM 步数」计
    /// （sqlite3VdbeExec 用 aCounter[VM_STEP] 每语句归零），批量微语句（如按版本
    /// 逐行读的单行 SELECT 只有数条指令）在 num_ops>1 下永远不会触发回调——
    /// 取消可靠性优先于每指令一次 Relaxed 原子读的开销（本地毫秒级查询无感）。
    /// 安装前自动替换旧 handler；归池时务必调用 [`Self::reset_query_state`]。
    pub fn install_query_cancel_guard(
        &mut self,
        check: Box<dyn Fn() -> bool + Send>,
    ) -> Result<(), GuanlanError> {
        self.conn
            .progress_handler(1, Some(check))
            .map_err(|e| GuanlanError::Internal(format!("安装查询取消守护失败: {e}")))
    }

    /// 归池前清理（清除 interrupt 标志与 progress handler）：
    /// 移除 progress handler；再执行平凡语句消费挂起的 interrupt 标志
    /// （SQLite 的中断标志可能残留到下一个语句，重试直到不再报 Interrupted），
    /// 避免上一请求的取消误伤复用连接的新请求。
    pub fn reset_query_state(&mut self) {
        let _ = self.conn.progress_handler(0, None::<fn() -> bool>);
        for _ in 0..3 {
            match self.conn.query_row("SELECT 1", [], |_| Ok(())) {
                Ok(()) => break,
                Err(rusqlite::Error::SqliteFailure(ref e, _))
                    if e.code == rusqlite::ErrorCode::OperationInterrupted =>
                {
                    continue
                }
                Err(_) => break,
            }
        }
    }

    /// 中断句柄（rusqlite `InterruptHandle` 为 Send + Sync）：执行层在请求取消时
    /// 从任意线程调用 `interrupt()`，立即唤醒阻塞中的 SQL step。
    pub fn interrupt_handle(&self) -> rusqlite::InterruptHandle {
        self.conn.get_interrupt_handle()
    }

    pub(crate) fn file_by_id(&self, file_id: &str) -> Result<Option<FileRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM files WHERE file_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt.query([file_id]).map_err(internal_sql)?;
        match rows.next().map_err(internal_sql)? {
            Some(row) => Ok(Some(file_row(row).map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    /// 列出文件在 `path_aliases` 中记录的全部历史/当前路径（按首见序）。
    pub fn path_aliases_for_file(&self, file_id: &str) -> Result<Vec<String>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT path FROM path_aliases WHERE file_id = ?
                 ORDER BY first_observed_at ASC, path ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map([file_id], |row| row.get::<_, String>(0))
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    /// 列出当前处于可恢复状态（`missing` / `trashed`）的文件 ID，供阅读状态保留判断使用。
    pub fn recoverable_file_ids(&self, workspace_id: &str) -> Result<Vec<String>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT file_id FROM files
                 WHERE workspace_id = ? AND status IN ('missing', 'trashed')
                 ORDER BY file_id ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map([workspace_id], |row| row.get::<_, String>(0))
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        Ok(rows)
    }

    pub(crate) fn revision_by_id(
        &self,
        revision_id: &str,
    ) -> Result<Option<RevisionRow>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM revisions WHERE revision_id = ?")
            .map_err(internal_sql)?;
        let mut rows = stmt.query([revision_id]).map_err(internal_sql)?;
        match rows.next().map_err(internal_sql)? {
            Some(row) => Ok(Some(revision_row(row).map_err(internal_sql)?)),
            None => Ok(None),
        }
    }

    pub(crate) fn max_event_seq(&self, workspace_id: &str) -> Result<i64, GuanlanError> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE workspace_id = ?",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(internal_sql)
    }

    pub(crate) fn has_baseline(&self, workspace_id: &str) -> Result<bool, GuanlanError> {
        let n: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'workspace_baseline'",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(internal_sql)?;
        Ok(n > 0)
    }

    pub(crate) fn counts(
        &self,
        workspace_id: &str,
    ) -> Result<crate::dto::WorkspaceCounts, GuanlanError> {
        let one = |sql: &str, ws: &str| -> Result<u64, GuanlanError> {
            let n: i64 = self
                .conn
                .query_row(sql, [ws], |row| row.get(0))
                .map_err(internal_sql)?;
            Ok(n.max(0) as u64)
        };
        let global = |sql: &str| -> Result<u64, GuanlanError> {
            let n: i64 = self
                .conn
                .query_row(sql, [], |row| row.get(0))
                .map_err(internal_sql)?;
            Ok(n.max(0) as u64)
        };
        Ok(crate::dto::WorkspaceCounts {
            files: one(
                "SELECT COUNT(*) AS n FROM files WHERE workspace_id = ?",
                workspace_id,
            )?,
            revisions: global("SELECT COUNT(*) AS n FROM revisions")?,
            events: one(
                "SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?",
                workspace_id,
            )?,
            blobs: global("SELECT COUNT(*) AS n FROM blobs")?,
            statements: one(
                "SELECT COUNT(*) AS n FROM statements WHERE workspace_id = ?",
                workspace_id,
            )?,
            edges: one(
                "SELECT COUNT(*) AS n FROM edges WHERE workspace_id = ?",
                workspace_id,
            )?,
        })
    }

    pub(crate) fn read_txn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, GuanlanError>,
    ) -> Result<T, GuanlanError> {
        let mut guard = ReadTxnGuard::begin(&self.conn)?;
        let value = f(&self.conn)?;
        guard.commit()?;
        Ok(value)
    }

    /// 读 `meta` 键（只读连接专用；缺键返回 `None`）。
    pub fn read_meta(&self, key: &str) -> Result<Option<String>, GuanlanError> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM meta WHERE key = ?")
            .map_err(internal_sql)?;
        match stmt.query_row([key], |row| row.get::<_, String>(0)) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(internal_sql(e)),
        }
    }

    /// 读工作区当前生效的三档快照配额策略（环境变量 > meta 持久化 > 默认 10MB/50MB）。
    pub fn snapshot_policy(&self) -> crate::index::file_format::SnapshotPolicy {
        let text_mb = self
            .read_meta("snapshot_text_max_mb")
            .ok()
            .flatten()
            .and_then(|s| s.trim().parse::<i64>().ok());
        let binary_mb = self
            .read_meta("snapshot_binary_max_mb")
            .ok()
            .flatten()
            .and_then(|s| s.trim().parse::<i64>().ok());
        crate::index::file_format::SnapshotPolicy::from_overrides_and_env(text_mb, binary_mb)
    }

    /// 统计 `<data_dir>/blobs` 在磁盘上真实占用的字节总和（仅 stat，不读内容）。
    pub fn blobs_disk_bytes(&self) -> u64 {
        dir_files_bytes(&self.blobs_dir)
    }

    /// 统计 `<data_dir>/index.db`（含 `-wal` 与 `-shm`）在磁盘上占用的字节总和。
    pub fn db_disk_bytes(&self) -> u64 {
        ["index.db", "index.db-wal", "index.db-shm"]
            .iter()
            .filter_map(|name| std::fs::metadata(self.data_dir.join(name)).ok())
            .map(|m| m.len())
            .sum()
    }

    /// 重建连接：panic 或事务清理失败后，旧连接不再复用——
    /// 关闭后按原 data_dir 重新打开并重新认领工作区（root_path 由 claim 时记下）。
    /// 重建失败返回错误，由调用方把该连接移出池（池逐步缩容，不复用脏连接）。
    pub fn reopen(&self) -> Result<Self, GuanlanError> {
        let root = self
            .root_path
            .as_deref()
            .ok_or_else(|| GuanlanError::Internal("连接未认领工作区，无法重建".to_owned()))?;
        ReadonlyStore::open_at(&self.data_dir, root)
    }
}

pub(crate) struct ReadTxnGuard<'c> {
    conn: &'c Connection,
    done: bool,
}

pub(crate) static TXN_POISONED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

impl<'c> ReadTxnGuard<'c> {
    fn begin(conn: &'c Connection) -> Result<Self, GuanlanError> {
        conn.execute_batch("BEGIN DEFERRED").map_err(internal_sql)?;
        Ok(Self { conn, done: false })
    }

    fn commit(&mut self) -> Result<(), GuanlanError> {
        match self.conn.execute_batch("COMMIT") {
            Ok(()) => {
                self.done = true;
                Ok(())
            }
            Err(e) => {
                self.rollback_or_mark();
                self.done = true;
                Err(internal_sql(e))
            }
        }
    }

    fn rollback_or_mark(&mut self) {
        if self.conn.execute_batch("ROLLBACK").is_err() {
            TXN_POISONED.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

impl Drop for ReadTxnGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.rollback_or_mark();
            self.done = true;
        }
    }
}

fn dir_files_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            total = total.saturating_add(dir_files_bytes(&entry.path()));
        } else if meta.is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// 事务标记（执行器归池前检查）：true 表示曾有事务清理失败/panic，需要重建连接。
pub fn take_txn_poisoned() -> bool {
    TXN_POISONED.swap(false, std::sync::atomic::Ordering::SeqCst)
}

pub(crate) fn is_valid_content_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

fn redact_hash(hash: &str) -> String {
    let shown: String = hash.chars().take(16).collect();
    if hash.chars().count() > 16 {
        format!("{shown}…（共 {} 字符）", hash.chars().count())
    } else {
        shown
    }
}

/// 统一把 rusqlite 错误包装为 INTERNAL（错误包络码表见 error.rs）
pub fn internal_sql(e: rusqlite::Error) -> GuanlanError {
    GuanlanError::Internal(format!("SQL 错误: {e}"))
}

/// 显式 dataDir 缺省时的目录解析（WorkspaceStore.ts:269-274）：
/// ```text
/// localAppData = $LOCALAPPDATA 若非空，否则 join(homedir, 'AppData', 'Local')
/// base         = $GUANLAN_DATA_DIR 若非空，否则 join(localAppData, 'Guanlan', 'workspaces')
/// return       = join(base, rootKeyOf(rootPath))
/// ```
/// **顺序**：GUANLAN_DATA_DIR 整体替换 base（含 Guanlan/workspaces 段），不是在其后追加。
/// join 走 [`domain::path_win32`] 的 win32 `path.join` 移植，保证与 Node 逐字一致。
pub fn default_data_dir_with(
    root_path: &str,
    env: &dyn Fn(&str) -> Option<String>,
    home_dir: Option<&Path>,
) -> Result<PathBuf, GuanlanError> {
    let local_app_data = match env("LOCALAPPDATA") {
        Some(v) if !v.is_empty() => v,
        _ => {
            let home = home_dir
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            domain::path_win32::join_with(&[&home, "AppData", "Local"])
        }
    };
    let base = match env("GUANLAN_DATA_DIR") {
        Some(v) if !v.is_empty() => v,
        _ => domain::path_win32::join_with(&[&local_app_data, "Guanlan", "workspaces"]),
    };
    let root_key = domain::root_key_of(root_path)?;
    Ok(PathBuf::from(domain::path_win32::join_with(&[
        &base, &root_key,
    ])))
}

/// 进程默认版本：读真实环境变量与用户主目录（os.homedir 的 Windows 口径：
/// USERPROFILE 优先，缺省回退 HOMEDRIVE+HOMEPATH）。
pub fn default_data_dir(root_path: &str) -> Result<PathBuf, GuanlanError> {
    default_data_dir_with(
        root_path,
        &|key| std::env::var(key).ok(),
        home_dir().as_deref(),
    )
}

fn home_dir() -> Option<PathBuf> {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile));
        }
    }
    if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        if !drive.is_empty() && !path.is_empty() {
            return Some(PathBuf::from(domain::path_win32::join_with(&[
                &drive, &path,
            ])));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{assert_code, blob_rel, FixtureDb};

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn readonly_open_rejects_unknown_schema_version() {
        let fixture = FixtureDb::new("schema-gate");
        fixture
            .conn
            .execute_batch("PRAGMA user_version = 3")
            .expect("写 user_version 失败");
        let result = ReadonlyStore::open(&fixture.db_path);
        let err = result.expect_err("未知 schema 版本应拒绝打开");
        assert!(
            err.to_string().contains("不支持的 schema 版本 3"),
            "报错应指明版本不符：{err}"
        );
        cleanup(&fixture.dir);
    }

    #[test]
    fn readonly_open_accepts_versions_0_and_1_and_2() {
        let fixture = FixtureDb::new("schema-accept");
        assert_eq!(
            fixture
                .conn
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        ReadonlyStore::open(&fixture.db_path).expect("user_version=0 应放行");

        let fixture1 = FixtureDb::new("schema-accept-1");
        fixture1
            .conn
            .execute_batch("PRAGMA user_version = 1")
            .expect("写版本失败");
        ReadonlyStore::open(&fixture1.db_path).expect("user_version=1 应放行");

        let fixture2 = FixtureDb::new("schema-accept-2");
        fixture2
            .conn
            .execute_batch("PRAGMA user_version = 2")
            .expect("写版本失败");
        let store = ReadonlyStore::open(&fixture2.db_path).expect("user_version=2 应放行");
        assert_eq!(store.schema_version().expect("读版本"), 2);
        cleanup(&fixture.dir);
        cleanup(&fixture1.dir);
        cleanup(&fixture2.dir);
    }

    #[test]
    fn open_missing_db_fails() {
        let dir = std::env::temp_dir().join(format!("guanlan-core-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建目录");
        let result = ReadonlyStore::open(&dir.join("index.db"));
        assert!(result.is_err(), "缺库文件应报错");
        cleanup(&dir);
    }

    #[test]
    fn default_data_dir_resolution_order() {
        let root = r"D:\notebooks\demo";
        let root_key = crate::domain::root_key_of(root).expect("rootKey");
        let home = Path::new(r"C:\Users\测试用户");

        let env = |k: &str| match k {
            "GUANLAN_DATA_DIR" => Some(r"C:\obsidian-data".to_owned()),
            "LOCALAPPDATA" => Some(r"C:\Users\测试用户\AppData\Local".to_owned()),
            _ => None,
        };
        let dir = default_data_dir_with(root, &env, Some(home)).expect("解析失败");
        assert_eq!(
            dir,
            PathBuf::from(format!(r"C:\obsidian-data\{root_key}")),
            "GUANLAN_DATA_DIR 应整体替换 base"
        );

        let env = |k: &str| match k {
            "LOCALAPPDATA" => Some(r"C:\Users\测试用户\AppData\Local".to_owned()),
            _ => None,
        };
        let dir = default_data_dir_with(root, &env, Some(home)).expect("解析失败");
        assert_eq!(
            dir,
            PathBuf::from(format!(
                r"C:\Users\测试用户\AppData\Local\Guanlan\workspaces\{root_key}"
            ))
        );

        let env = |_k: &str| -> Option<String> { None };
        let dir = default_data_dir_with(root, &env, Some(home)).expect("解析失败");
        assert_eq!(
            dir,
            PathBuf::from(format!(
                r"C:\Users\测试用户\AppData\Local\Guanlan\workspaces\{root_key}"
            ))
        );
    }

    #[test]
    fn snapshot_location_by_revision_and_file() {
        let fixture = FixtureDb::new("snapshot-locate");
        let root = fixture.root();
        let ws_id = fixture.workspace(&root, 1, None);
        let hash = "6d74a29df40616ec0000000000000000000000000000000000000000000000ab";
        fixture.blob(hash, 11, 1);
        fixture.write_blob_file(hash, b"hello guanlan");
        let file_id = fixture.file(&ws_id, "f_abc", "docs/a.md", "md", "方案", "active", None);
        let rev_id = fixture.revision(
            &ws_id,
            &file_id,
            1,
            hash,
            11,
            Some("2026-01-02"),
            "day",
            Some("document_self"),
            1,
            "2026-01-02T00:00:00.000Z",
        );
        fixture
            .conn
            .execute(
                "UPDATE files SET last_revision_id = ?1 WHERE file_id = ?2",
                rusqlite::params![rev_id, file_id],
            )
            .expect("回填 last_revision_id 失败");

        let store = open_store(&fixture, &root);
        let (path, rev) = store
            .snapshot_path_for_revision(&rev_id)
            .expect("按版本定位失败");
        assert_eq!(rev.content_hash, hash);
        assert_eq!(path, blob_rel(fixture.dir.as_path(), hash));
        assert!(path.exists(), "快照文件应已落盘");

        let (path2, _) = store
            .snapshot_path_for_file(&file_id)
            .expect("按文件定位失败");
        assert_eq!(path2, path, "两条定位路径应指向同一快照文件");

        assert_code(
            store.snapshot_path_for_revision("f_abc_r9").map(|_| ()),
            "NOT_FOUND",
        );
        assert_code(
            store.snapshot_path_for_file("f_missing").map(|_| ()),
            "NOT_FOUND",
        );

        let file2 = fixture.file(&ws_id, "f_norev", "b.md", "md", "方案", "active", None);
        assert_code(
            store.snapshot_path_for_file(&file2).map(|_| ()),
            "NOT_FOUND",
        );
        cleanup(&fixture.dir);
    }

    #[test]
    fn file_row_reads_real_and_integer_mtime() {
        let fixture = FixtureDb::new("mtime-real");
        let root = fixture.root();
        let ws_id = fixture.workspace(&root, 1, None);
        let file_real = fixture.file(&ws_id, "f_real", "docs/r.md", "md", "方案", "active", None);
        let file_int = fixture.file(&ws_id, "f_int", "docs/i.md", "md", "方案", "active", None);
        fixture
            .conn
            .execute(
                "UPDATE files SET last_mtime_ms = ?1 WHERE file_id = ?2",
                rusqlite::params![1794488593745.4663_f64, file_real],
            )
            .expect("写 REAL mtime 失败");

        let store = open_store(&fixture, &root);
        let row_real = store
            .file_by_id(&file_real)
            .expect("读 REAL 行失败")
            .expect("行应存在");
        assert!(
            (row_real.last_mtime_ms - 1794488593745.4663).abs() < 0.001,
            "REAL 应原值读出：{}",
            row_real.last_mtime_ms
        );
        let row_int = store
            .file_by_id(&file_int)
            .expect("读 INTEGER 行失败")
            .expect("行应存在");
        assert_eq!(row_int.last_mtime_ms, 0.0, "INTEGER 应转浮点读出");
        cleanup(&fixture.dir);
    }

    use crate::test_support::open_store;
}
