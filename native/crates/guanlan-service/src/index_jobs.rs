//! 索引任务：唯一写入线程与任务状态机（contract-query-api.md §2.1 / §2.2
//! 写入与长任务端点的写线程执行体）。
//!
//! 唯一写入线程（contract-storage.md §4.2）：rusqlite 写连接只属于这一条线程，
//! 线程消费任务、核对基准版本、分配版本号与事件序号，并用短事务分批提交。读侧仍走
//! 独立的只读连接池，两侧靠 WAL 并行。
//!
//! 任务语义：
//! - 外部可提 `verify_all | changed_paths | l4a_summary | set_initiative_dirs`；
//!   内部 kind（decision_writeback/propose_revision/adopt_draft/archive_initiative/
//!   reopen_initiative/diff）直提 400；checkpoint_commit 走同步命令通道不占 job；
//! - **按 kind 合并**：跨 kind 永不合并（新任务入队串行执行）；verify_all 单飞与
//!   changed_paths 合并仅在**同类 active 任务**间生效；set_initiative_dirs 幂等覆盖；
//!   其余不合并；
//! - JobState 四态不变（挂起语义只存在于 task_nodes 层，job 是瞬时执行载体）；
//!   取消按「已取消」落到 failed+error 口径（见 `cancel` 注释）；
//! - `JobCommand::{Run, CheckpointCommit}`——checkpoint 走同事务同步受理命令通道，
//!   唤醒=recompute 同步函数调用，无 Resume、无 job 载体；
//! - job_runs 持久化：每次状态迁移 UPSERT；重启后 queued/running 重入队，启动
//!   verify_all 收尾 recompute 对全部 suspended/running 节点幂等重判（重启孤儿闭合）。

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use guanlan_core::dto::{
    BatchFileMutationResponse, CreateDocumentResponse, FileMutationResponse,
    FolderMutationResponse, IndexJobReport, IndexJobStatusResponse, UpdateStoragePolicyResponse,
};
use guanlan_core::error::GuanlanError;
use guanlan_core::index::file_ops::{
    batch_move_files, batch_trash_files_with, create_document, create_folder, move_file,
    move_folder, rename_file, rename_folder, trash_file_with, trash_folder_with,
    BatchMoveFilesInput, BatchTrashFilesInput, CreateDocumentInput, CreateFolderInput,
    MoveFileInput, MoveFolderInput, OsTrashDriver, RenameFileInput, RenameFolderInput, TrashDriver,
    TrashFileInput, TrashFolderInput,
};
use guanlan_core::index::state_engine::state_machine_recompute;
use guanlan_core::index::writeback::apply_decision_writeback;
use guanlan_core::index::{
    reconcile, reconcile_paths, CheckpointInput, ReconcileOptions, WritebackInput, Writer,
};

/// SSE 通知（写线程经桥回传；runtime 模块广播给订阅者）
#[derive(Debug, Clone)]
pub struct SseNotice {
    pub index_generation: Option<u64>,
    pub new_events: u64,
    pub new_revisions: u64,
    /// 事件时刻（ISO）
    pub at: String,
    /// watcher | decision_writeback | proposal | l4a | state | task
    pub kinds: Vec<String>,
}

/// 任务类型（payload 内聚在变体里）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobKind {
    VerifyAll,
    ChangedPaths(Vec<String>),
    L4ASummary,
    SetInitiativeDirs(Vec<String>),
    DecisionWriteback {
        statement_id: String,
        decision: String,
        confirmer: String,
        role: Option<String>,
        effective_scope: Option<String>,
        effective_date: Option<String>,
        note: Option<String>,
    },
    Diff {
        file_id: String,
        baseline_revision_id: String,
        target_revision_id: String,
    },
    ProposeRevision {
        file_id: String,
        base_revision_id: String,
        content: String,
        note: Option<String>,
        input_context_hashes: Vec<String>,
        receipt_summary: Option<String>,
    },
    AdoptDraft {
        draft_id: String,
    },
    DismissDraft {
        draft_id: String,
        reason: Option<String>,
    },
    AdoptCandidate {
        candidate_id: String,
    },
    DismissCandidate {
        candidate_id: String,
    },
    ExcludeCandidateMember {
        candidate_id: String,
        file_id: String,
    },
    ArchiveInitiative {
        initiative_id: String,
        note: Option<String>,
    },
    ReopenInitiative {
        initiative_id: String,
    },
    RebuildSearchIndex,
    RepairOrphan {
        initiative_id: String,
        node_id: Option<String>,
        action: String,
        note: Option<String>,
    },
}

impl JobKind {
    /// 外部 wire 类型解析（未知 kind → None，HTTP 层给 400）。
    /// 内部 kind 直提一律拒绝。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "verify_all" | "" => Some(JobKind::VerifyAll),
            "changed_paths" => Some(JobKind::ChangedPaths(Vec::new())),
            "l4a_summary" => Some(JobKind::L4ASummary),
            "set_initiative_dirs" => Some(JobKind::SetInitiativeDirs(Vec::new())),
            _ => None,
        }
    }

    /// wire 形状
    pub fn as_str(&self) -> &'static str {
        match self {
            JobKind::VerifyAll => "verify_all",
            JobKind::ChangedPaths(_) => "changed_paths",
            JobKind::L4ASummary => "l4a_summary",
            JobKind::SetInitiativeDirs(_) => "set_initiative_dirs",
            JobKind::DecisionWriteback { .. } => "decision_writeback",
            JobKind::Diff { .. } => "diff",
            JobKind::ProposeRevision { .. } => "propose_revision",
            JobKind::AdoptCandidate { .. } => "adopt_candidate",
            JobKind::DismissCandidate { .. } => "dismiss_candidate",
            JobKind::ExcludeCandidateMember { .. } => "exclude_candidate_member",
            JobKind::AdoptDraft { .. } => "adopt_draft",
            JobKind::DismissDraft { .. } => "dismiss_draft",
            JobKind::ArchiveInitiative { .. } => "archive_initiative",
            JobKind::ReopenInitiative { .. } => "reopen_initiative",
            JobKind::RebuildSearchIndex => "rebuild_search_index",
            JobKind::RepairOrphan { .. } => "repair_orphan",
        }
    }

    /// 是否外部可提（HTTP 校验用）
    pub fn is_external(&self) -> bool {
        matches!(
            self,
            JobKind::VerifyAll
                | JobKind::ChangedPaths(_)
                | JobKind::L4ASummary
                | JobKind::SetInitiativeDirs(_)
        )
    }

    fn merge_tag(&self) -> Option<&'static str> {
        match self {
            JobKind::VerifyAll => Some("verify_all"),
            JobKind::ChangedPaths(_) => Some("changed_paths"),
            JobKind::SetInitiativeDirs(_) => Some("set_initiative_dirs"),
            _ => None,
        }
    }

    /// 持久化请求体（job_runs.request_json；重启重入队用）
    pub fn to_request_json(&self) -> String {
        let value = match self {
            JobKind::VerifyAll => serde_json::json!({ "kind": "verify_all" }),
            JobKind::ChangedPaths(paths) => {
                serde_json::json!({ "kind": "changed_paths", "paths": paths })
            }
            JobKind::L4ASummary => serde_json::json!({ "kind": "l4a_summary" }),
            JobKind::SetInitiativeDirs(dirs) => {
                serde_json::json!({ "kind": "set_initiative_dirs", "dirs": dirs })
            }
            JobKind::DecisionWriteback {
                statement_id,
                decision,
                confirmer,
                role,
                effective_scope,
                effective_date,
                note,
            } => serde_json::json!({
                "kind": "decision_writeback", "statement_id": statement_id, "decision": decision,
                "confirmer": confirmer, "role": role, "effective_scope": effective_scope,
                "effective_date": effective_date, "note": note,
            }),
            JobKind::Diff {
                file_id,
                baseline_revision_id,
                target_revision_id,
            } => serde_json::json!({
                "kind": "diff", "file_id": file_id, "baseline_revision_id": baseline_revision_id,
                "target_revision_id": target_revision_id,
            }),
            JobKind::ProposeRevision {
                file_id,
                base_revision_id,
                content,
                note,
                input_context_hashes,
                receipt_summary,
            } => serde_json::json!({
                "kind": "propose_revision",
                "file_id": file_id,
                "base_revision_id": base_revision_id,
                "content": content,
                "note": note,
                "input_context_hashes": input_context_hashes,
                "receipt_summary": receipt_summary,
            }),
            JobKind::AdoptCandidate { candidate_id } => {
                serde_json::json!({ "kind": "adopt_candidate", "candidate_id": candidate_id })
            }
            JobKind::DismissCandidate { candidate_id } => {
                serde_json::json!({ "kind": "dismiss_candidate", "candidate_id": candidate_id })
            }
            JobKind::ExcludeCandidateMember {
                candidate_id,
                file_id,
            } => {
                serde_json::json!({ "kind": "exclude_candidate_member", "candidate_id": candidate_id, "file_id": file_id })
            }
            JobKind::AdoptDraft { draft_id } => {
                serde_json::json!({ "kind": "adopt_draft", "draft_id": draft_id })
            }
            JobKind::DismissDraft { draft_id, reason } => {
                serde_json::json!({ "kind": "dismiss_draft", "draft_id": draft_id, "reason": reason })
            }
            JobKind::ArchiveInitiative {
                initiative_id,
                note,
            } => serde_json::json!({
                "kind": "archive_initiative", "initiative_id": initiative_id, "note": note,
            }),
            JobKind::ReopenInitiative { initiative_id } => serde_json::json!({
                "kind": "reopen_initiative", "initiative_id": initiative_id,
            }),
            JobKind::RebuildSearchIndex => serde_json::json!({ "kind": "rebuild_search_index" }),
            JobKind::RepairOrphan {
                initiative_id,
                node_id,
                action,
                note,
            } => serde_json::json!({
                "kind": "repair_orphan",
                "initiative_id": initiative_id,
                "node_id": node_id,
                "action": action,
                "note": note,
            }),
        };
        value.to_string()
    }

    /// 从持久化请求体重建（启动恢复；重建失败返回 None → 该行按失败记账）
    pub fn from_request_json(raw: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(raw).ok()?;
        let kind = value.get("kind")?.as_str()?.to_owned();
        let strings = |key: &str| -> Option<Vec<String>> {
            Some(
                value
                    .get(key)?
                    .as_array()?
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect(),
            )
        };
        let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
        match kind.as_str() {
            "verify_all" => Some(JobKind::VerifyAll),
            "changed_paths" => Some(JobKind::ChangedPaths(strings("paths")?)),
            "l4a_summary" => Some(JobKind::L4ASummary),
            "set_initiative_dirs" => Some(JobKind::SetInitiativeDirs(strings("dirs")?)),
            "decision_writeback" => Some(JobKind::DecisionWriteback {
                statement_id: text("statement_id")?,
                decision: text("decision")?,
                confirmer: text("confirmer")?,
                role: text("role"),
                effective_scope: text("effective_scope"),
                effective_date: text("effective_date"),
                note: text("note"),
            }),
            "diff" => Some(JobKind::Diff {
                file_id: text("file_id")?,
                baseline_revision_id: text("baseline_revision_id")?,
                target_revision_id: text("target_revision_id")?,
            }),
            "propose_revision" => Some(JobKind::ProposeRevision {
                file_id: text("file_id")?,
                base_revision_id: text("base_revision_id")?,
                content: text("content")?,
                note: text("note"),
                input_context_hashes: strings("input_context_hashes").unwrap_or_default(),
                receipt_summary: text("receipt_summary"),
            }),
            "adopt_draft" => Some(JobKind::AdoptDraft {
                draft_id: text("draft_id")?,
            }),
            "dismiss_draft" => Some(JobKind::DismissDraft {
                draft_id: text("draft_id")?,
                reason: text("reason"),
            }),
            "archive_initiative" => Some(JobKind::ArchiveInitiative {
                initiative_id: text("initiative_id")?,
                note: text("note"),
            }),
            "reopen_initiative" => Some(JobKind::ReopenInitiative {
                initiative_id: text("initiative_id")?,
            }),
            "rebuild_search_index" => Some(JobKind::RebuildSearchIndex),
            "repair_orphan" => Some(JobKind::RepairOrphan {
                initiative_id: text("initiative_id")?,
                node_id: text("node_id"),
                action: text("action")?,
                note: text("note"),
            }),
            _ => None,
        }
    }
}

/// 任务状态（四态不变；挂起语义只在 task_nodes 层）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Running => "running",
            JobState::Completed => "completed",
            JobState::Failed => "failed",
        }
    }

    /// 是否仍在进行中
    pub fn is_active(self) -> bool {
        matches!(self, JobState::Queued | JobState::Running)
    }
}

/// 任务快照（管理器与写线程之间共享的状态）
#[derive(Debug, Clone)]
pub struct IndexJob {
    pub job_id: String,
    pub kind: JobKind,
    pub state: JobState,
    pub phase: String,
    pub discovered: u64,
    pub processed: u64,
    pub failed_items: Vec<String>,
    pub error: Option<String>,
    pub index_generation: Option<u64>,
    pub last_scan_at: Option<String>,
    pub report: Option<IndexJobReport>,
    /// 各 kind 的结果分支（writeback/proposal/adopt/diff/l4a/initiative）
    pub result: Option<serde_json::Value>,
    /// 已取消标记（四态模型下的取消口径：终态 failed + error=已取消；
    /// 活跃期 wire state 报 cancelled，见 `to_response`）
    pub cancelled: bool,
    cancel_flag: Arc<std::sync::atomic::AtomicBool>,
}

impl IndexJob {
    fn new(job_id: String, kind: JobKind) -> Self {
        Self {
            job_id,
            kind,
            state: JobState::Queued,
            phase: "queued".to_owned(),
            discovered: 0,
            processed: 0,
            failed_items: Vec::new(),
            error: None,
            index_generation: None,
            last_scan_at: None,
            report: None,
            result: None,
            cancelled: false,
            cancel_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// 转 wire 响应
    pub fn to_response(&self) -> IndexJobStatusResponse {
        let state = if self.cancelled && self.state.is_active() {
            "cancelled".to_owned()
        } else {
            self.state.as_str().to_owned()
        };
        IndexJobStatusResponse {
            ok: true,
            job_id: self.job_id.clone(),
            kind: self.kind.as_str().to_owned(),
            state,
            phase: self.phase.clone(),
            discovered: self.discovered,
            processed: self.processed,
            failed_items: self.failed_items.clone(),
            index_generation: self.index_generation,
            last_scan_at: self.last_scan_at.clone(),
            error: self.error.clone(),
            report: self.report.clone(),
            result: self.result.clone(),
        }
    }
}

/// 同步文件操作命令（经唯一写入线程串行执行：磁盘操作 + 单事务更新）
#[derive(Debug, Clone)]
pub enum FileOpCommand {
    Rename(RenameFileInput),
    Move(MoveFileInput),
    Trash(TrashFileInput),
}

/// 同步文件夹操作命令（创建 / 重命名 / 移动 / 回收站；唯一写线程串行执行）
#[derive(Debug, Clone)]
pub enum FolderOpCommand {
    Create(CreateFolderInput),
    Rename(RenameFolderInput),
    Move(MoveFolderInput),
    Trash(TrashFolderInput),
}

/// 批量文件操作命令（批量移动 / 批量移入回收站）
#[derive(Debug, Clone)]
pub enum BatchFileOpCommand {
    Move(BatchMoveFilesInput),
    Trash(BatchTrashFilesInput),
}

enum JobCommand {
    Run {
        job_id: String,
    },
    CheckpointCommit {
        payload: Box<CheckpointInput>,
        reply: Sender<
            Result<guanlan_core::index::state_engine::CheckpointCommitOutcome, GuanlanError>,
        >,
    },
    FileOp {
        op: Box<FileOpCommand>,
        reply: Sender<Result<FileMutationResponse, GuanlanError>>,
    },
    FolderOp {
        op: Box<FolderOpCommand>,
        reply: Sender<Result<FolderMutationResponse, GuanlanError>>,
    },
    CreateDoc {
        input: Box<CreateDocumentInput>,
        reply: Sender<Result<CreateDocumentResponse, GuanlanError>>,
    },
    BatchFileOp {
        op: Box<BatchFileOpCommand>,
        reply: Sender<Result<BatchFileMutationResponse, GuanlanError>>,
    },
    UpdateStoragePolicy {
        text_max_mib: u64,
        binary_max_mib: u64,
        reply: Sender<Result<UpdateStoragePolicyResponse, GuanlanError>>,
    },
    StorageGc {
        request: guanlan_core::storage::maintenance::StorageGcRequest,
        reply: Sender<Result<guanlan_core::storage::maintenance::StorageGcResponse, GuanlanError>>,
    },
    BatchReadingState {
        request: guanlan_core::dto::ReadingStateBatchRequest,
        reply: Sender<Result<guanlan_core::dto::ReadingStateBatchResponse, GuanlanError>>,
    },
    Shutdown,
}

/// 索引任务管理器
#[derive(Clone)]
pub struct IndexJobManager {
    sender: Sender<JobCommand>,
    jobs: Arc<Mutex<HashMap<String, IndexJob>>>,
    running: Arc<Mutex<Option<String>>>,
    queued: Arc<Mutex<Vec<String>>>,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
    writer_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
}

impl IndexJobManager {
    /// 空管理器：没有写线程（提交的任务会立刻失败）。
    ///
    /// 只给「不需要真正执行对账」的装配场景用（例如只读路径的测试）。
    pub fn idle() -> Self {
        let (sender, receiver) = mpsc::channel::<JobCommand>();
        drop(receiver);
        Self {
            sender,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(None)),
            queued: Arc::new(Mutex::new(Vec::new())),
            shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            writer_thread: Arc::new(Mutex::new(None)),
        }
    }

    /// 启动写线程（写连接随线程移动，进程内只有这一条可写连接）
    pub fn start(writer: Writer) -> Self {
        Self::start_with_bridge(writer, None)
    }

    /// 同 [`start`]，但带 SSE 桥（写线程处理函数经桥回传通知）
    pub fn start_with_bridge(writer: Writer, notices: Option<Sender<SseNotice>>) -> Self {
        Self::start_with_options(writer, notices, false)
    }

    /// 可配置启动时是否自动排空存量 L4A 摘要队列（`background_index=true` 时开启，
    /// 只读/无监听模式默认关闭，严守零启动写入契约；扫描显式入队的新摘要仍自动排空）。
    pub fn start_with_options(
        writer: Writer,
        notices: Option<Sender<SseNotice>>,
        auto_drain_l4a_on_startup: bool,
    ) -> Self {
        Self::start_with_driver(
            writer,
            notices,
            Arc::new(OsTrashDriver),
            auto_drain_l4a_on_startup,
        )
    }

    #[cfg(test)]
    pub(crate) fn start_with_trash_driver_for_test(
        writer: Writer,
        notices: Option<Sender<SseNotice>>,
        trash_driver: Arc<dyn TrashDriver + Send + Sync>,
    ) -> Self {
        Self::start_with_driver(writer, notices, trash_driver, false)
    }

    fn start_with_driver(
        writer: Writer,
        notices: Option<Sender<SseNotice>>,
        trash_driver: Arc<dyn TrashDriver + Send + Sync>,
        auto_drain_l4a_on_startup: bool,
    ) -> Self {
        let (sender, receiver) = mpsc::channel::<JobCommand>();
        let jobs: Arc<Mutex<HashMap<String, IndexJob>>> = Arc::new(Mutex::new(HashMap::new()));
        let running: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let queued: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let shutting_down = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let thread_jobs = Arc::clone(&jobs);
        let thread_running = Arc::clone(&running);
        let thread_queued = Arc::clone(&queued);
        let thread_shutting_down = Arc::clone(&shutting_down);
        let thread_notices = notices.clone();
        let join = std::thread::Builder::new()
            .name("guanlan-index-writer".to_owned())
            .spawn(move || {
                writer_loop(
                    writer,
                    receiver,
                    thread_jobs,
                    thread_running,
                    thread_queued,
                    thread_shutting_down,
                    thread_notices,
                    trash_driver,
                    auto_drain_l4a_on_startup,
                )
            })
            .expect("启动索引写线程失败");

        Self {
            sender,
            jobs,
            running,
            queued,
            shutting_down,
            writer_thread: Arc::new(Mutex::new(Some(join))),
        }
    }

    /// 非阻塞停机通知：立即置位停机标志与所有活跃任务的协作取消标志，并发送 Shutdown，
    /// 让正在采集/哈希大文件的唯一写入线程在毫秒级安全中止，避免切换工作区或退出时卡死。
    pub fn signal_shutdown(&self) {
        self.shutting_down
            .store(true, std::sync::atomic::Ordering::Release);
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                if job.state.is_active() {
                    job.cancel_flag
                        .store(true, std::sync::atomic::Ordering::Release);
                }
            }
        }
        let _ = self.sender.send(JobCommand::Shutdown);
    }

    /// 优雅停机：通知活跃任务协作中止、阻止后续排队的 Run 继续执行，并等待唯一写入线程退出、关闭 SQLite 写连接。
    pub fn shutdown(&self) {
        self.signal_shutdown();
        if let Some(handle) = self.writer_thread.lock().expect("写线程句柄锁").take() {
            let _ = handle.join();
        }
    }

    /// 提交外部类型（HTTP index-jobs；payload 补齐后走 [`Self::submit_kind`]）
    pub fn submit_external(
        &self,
        kind: JobKind,
    ) -> Result<(String, bool, Option<u64>), GuanlanError> {
        if !kind.is_external() {
            return Err(GuanlanError::BadRequest(format!(
                "未知任务类型「{}」：外部可提 verify_all|changed_paths|l4a_summary|set_initiative_dirs",
                kind.as_str()
            )));
        }
        Ok(self.submit_kind(kind))
    }

    /// 提交任务（同类 active 任务按 kind 合并；跨 kind 永不合并）。
    ///
    /// - `verify_all`：同类 active（running/queued）单飞合并；
    /// - `changed_paths`：同类 active 任务**合并去重路径**（≤2000 条）；
    /// - `set_initiative_dirs`：同类 active 任务幂等覆盖；
    /// - 其余 kind：不与任何任务合并，一律新任务入队串行执行。
    pub fn submit_kind(&self, kind: JobKind) -> (String, bool, Option<u64>) {
        let mut jobs = self.jobs.lock().expect("任务表锁");
        let mut running = self.running.lock().expect("执行槽锁");
        let mut queued = self.queued.lock().expect("队列锁");

        if let Some(tag) = kind.merge_tag() {
            let mut candidates: Vec<String> = Vec::new();
            if !matches!(kind, JobKind::ChangedPaths(_)) {
                if let Some(job_id) = running.as_ref() {
                    candidates.push(job_id.clone());
                }
            }
            candidates.extend(queued.iter().cloned());
            for job_id in candidates {
                let Some(job) = jobs.get_mut(&job_id) else {
                    continue;
                };
                if !job.state.is_active() || job.cancelled || job.kind.merge_tag() != Some(tag) {
                    continue;
                }
                if matches!(kind, JobKind::ChangedPaths(_)) && job.state != JobState::Queued {
                    continue;
                }
                match &mut job.kind {
                    JobKind::ChangedPaths(existing) => {
                        if let JobKind::ChangedPaths(incoming) = &kind {
                            let new_count =
                                incoming.iter().filter(|p| !existing.contains(p)).count();
                            if existing.len() + new_count > 2000 {
                                continue;
                            }
                            for path in incoming {
                                if !existing.contains(path) {
                                    existing.push(path.clone());
                                }
                            }
                        }
                    }
                    JobKind::SetInitiativeDirs(existing) => {
                        if let JobKind::SetInitiativeDirs(incoming) = &kind {
                            *existing = incoming.clone();
                        }
                    }
                    _ => {}
                }
                job.result = None;
                return (job_id, true, job.index_generation);
            }
        }

        let job_id = new_job_id();
        jobs.insert(job_id.clone(), IndexJob::new(job_id.clone(), kind));
        queued.push(job_id.clone());
        if running.is_none() {
            *running = Some(job_id.clone());
        }
        if self
            .sender
            .send(JobCommand::Run {
                job_id: job_id.clone(),
            })
            .is_err()
        {
            if let Some(job) = jobs.get_mut(&job_id) {
                job.state = JobState::Failed;
                job.phase = "failed".to_owned();
                job.error = Some("索引写线程已退出，无法执行任务".to_owned());
            }
        }
        (job_id, false, None)
    }

    /// checkpoint 同步受理命令：发送 CheckpointCommit 命令并取回执通道；
    /// HTTP handler 在 spawn_blocking 内 recv_timeout(5s)（超时 → 503 INDEX_BUSY）。
    /// 校验失败（404）经回执原样回传——受理与校验原子，checkpoint 不落库、无 job_id。
    pub fn commit_checkpoint(
        &self,
        payload: CheckpointInput,
    ) -> Result<
        mpsc::Receiver<
            Result<guanlan_core::index::state_engine::CheckpointCommitOutcome, GuanlanError>,
        >,
        GuanlanError,
    > {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::CheckpointCommit {
                payload: Box::new(payload),
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 投递身份保真文件操作（重命名 / 移动 / 回收站移除）至唯一写线程
    pub fn execute_file_op(
        &self,
        op: FileOpCommand,
    ) -> Result<Receiver<Result<FileMutationResponse, GuanlanError>>, GuanlanError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::FileOp {
                op: Box::new(op),
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 投递文件夹操作（新建 / 重命名 / 移动 / 移入回收站）至唯一写线程
    pub fn execute_folder_op(
        &self,
        op: FolderOpCommand,
    ) -> Result<Receiver<Result<FolderMutationResponse, GuanlanError>>, GuanlanError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::FolderOp {
                op: Box::new(op),
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 投递新建 Markdown 文档并立即入库命令至唯一写线程
    pub fn execute_create_doc(
        &self,
        input: CreateDocumentInput,
    ) -> Result<Receiver<Result<CreateDocumentResponse, GuanlanError>>, GuanlanError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::CreateDoc {
                input: Box::new(input),
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 投递批量文件操作（批量移动 / 批量移入回收站）至唯一写线程
    pub fn execute_batch_file_op(
        &self,
        op: BatchFileOpCommand,
    ) -> Result<Receiver<Result<BatchFileMutationResponse, GuanlanError>>, GuanlanError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::BatchFileOp {
                op: Box::new(op),
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 投递工作区快照配额阈值更新至唯一写线程
    pub fn update_storage_policy(
        &self,
        text_max_mib: u64,
        binary_max_mib: u64,
    ) -> Result<Receiver<Result<UpdateStoragePolicyResponse, GuanlanError>>, GuanlanError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::UpdateStoragePolicy {
                text_max_mib,
                binary_max_mib,
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 投递存储瘦身 GC 至唯一写线程（执行阶段先提交 SQLite 再删无引用物理 blob）
    pub fn run_storage_gc(
        &self,
        request: guanlan_core::storage::maintenance::StorageGcRequest,
    ) -> Result<
        Receiver<Result<guanlan_core::storage::maintenance::StorageGcResponse, GuanlanError>>,
        GuanlanError,
    > {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::StorageGc {
                request,
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 投递批量确立已读基线 / 撤销还原至唯一写线程
    pub fn batch_reading_state(
        &self,
        request: guanlan_core::dto::ReadingStateBatchRequest,
    ) -> Result<
        Receiver<Result<guanlan_core::dto::ReadingStateBatchResponse, GuanlanError>>,
        GuanlanError,
    > {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(JobCommand::BatchReadingState {
                request,
                reply: reply_tx,
            })
            .map_err(|_| GuanlanError::IndexBusy)?;
        Ok(reply_rx)
    }

    /// 取任务状态
    pub fn get(&self, job_id: &str) -> Option<IndexJob> {
        self.jobs.lock().expect("任务表锁").get(job_id).cloned()
    }

    /// 进行中的任务（queued / running）
    pub fn active_jobs(&self) -> Vec<IndexJob> {
        let jobs = self.jobs.lock().expect("任务表锁");
        let mut active: Vec<IndexJob> = jobs
            .values()
            .filter(|job| job.state.is_active() && !job.cancelled)
            .cloned()
            .collect();
        active.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        active
    }

    /// 是否有进行中的任务
    pub fn has_active(&self) -> bool {
        !self.active_jobs().is_empty()
    }

    /// 协作式取消：queued 立即生效（不再执行）；running 在写线程
    /// 阶段间隙生效（事务提交点不可中断）；已结束 → CONFLICT。
    ///
    /// 四态模型下的取消口径：任务终态落到 `failed`（error=已取消），wire 在活跃
    /// 期报 `cancelled`（见 [`IndexJob::to_response`]）——不引入第五个 JobState
    /// 变体（job 是瞬时执行载体）。
    pub fn cancel(&self, job_id: &str) -> Result<String, GuanlanError> {
        let mut jobs = self.jobs.lock().expect("任务表锁");
        let mut queued = self.queued.lock().expect("队列锁");
        let Some(job) = jobs.get_mut(job_id) else {
            return Err(GuanlanError::NotFound(format!("索引任务不存在：{job_id}")));
        };
        if !job.state.is_active() {
            return Err(GuanlanError::Conflict(format!(
                "任务已结束（{}），不可取消",
                job.state.as_str()
            )));
        }
        job.cancelled = true;
        job.cancel_flag
            .store(true, std::sync::atomic::Ordering::Release);
        if job.state == JobState::Queued {
            queued.retain(|id| id != job_id);
            job.state = JobState::Failed;
            job.phase = "cancelled".to_owned();
            job.error = Some("任务已取消（排队期立即生效）".to_owned());
            return Ok("cancelled".to_owned());
        }
        Ok("cancelling".to_owned())
    }

    fn finalize_cancellation(jobs: &Arc<Mutex<HashMap<String, IndexJob>>>, job_id: &str) {
        let mut guard = jobs.lock().expect("任务表锁");
        if let Some(job) = guard.get_mut(job_id) {
            if job.cancelled && job.state.is_active() {
                job.state = JobState::Failed;
                job.phase = "cancelled".to_owned();
                job.error =
                    Some("任务已取消（协作式：阶段间隙停止，事务提交点不可中断）".to_owned());
            }
        }
    }

    /// 启动恢复：扫 job_runs（queued/running 重入队）。由装配层在
    /// 拿到持久库工作区 id 后调用——重入队走 submit_kind（不合并）。
    pub fn recover_from_job_runs(&self, writer: &mut Writer, workspace_id: &str) -> usize {
        let rows = match writer.list_active_job_runs(workspace_id) {
            Ok(rows) => rows,
            Err(_) => return 0,
        };
        let mut recovered = 0;
        for row in rows {
            let Some(kind) = JobKind::from_request_json(&row.request_json) else {
                let _ = writer.upsert_job_run(&guanlan_core::storage::JobRunRow {
                    job_id: row.job_id.clone(),
                    workspace_id: workspace_id.to_owned(),
                    kind: row.kind.clone(),
                    state: "failed".to_owned(),
                    phase: "recovery".to_owned(),
                    request_json: row.request_json.clone(),
                    progress_json: "{}".to_owned(),
                    error: Some("重启恢复：请求体不可重建".to_owned()),
                    created_at: row.created_at.clone(),
                    updated_at: guanlan_core::index::clock::now_iso(),
                });
                continue;
            };
            let _ = self.submit_kind(kind);
            recovered += 1;
        }
        recovered
    }
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
const L4A_IDLE_DRAIN_MS: u64 = 40;
const L4A_MAX_ATTEMPTS: i64 = 3;

fn has_pending_l4a(writer: &mut Writer) -> bool {
    let Ok(ws) = writer.workspace() else {
        return false;
    };
    writer
        .list_pending_summary_jobs(&ws.workspace_id, 1)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
}

fn drain_l4a_idle_step(writer: &mut Writer, notices: &Option<Sender<SseNotice>>) -> bool {
    let outcome = process_l4a_batch(writer);
    let has_more = has_pending_l4a(writer);
    if let Ok(val) = outcome {
        let processed_n = val
            .get("processed")
            .and_then(|v| v.as_array())
            .map_or(0, Vec::len);
        let failed_n = val
            .get("failed")
            .and_then(|v| v.as_array())
            .map_or(0, Vec::len);
        if processed_n > 0 || failed_n > 0 {
            if let Some(sender) = notices {
                let index_generation = writer.workspace().ok().map(|ws| ws.index_generation);
                let _ = sender.send(SseNotice {
                    index_generation,
                    new_events: 0,
                    new_revisions: 0,
                    at: guanlan_core::index::clock::now_iso(),
                    kinds: vec!["l4a".to_owned()],
                });
            }
        }
    }
    has_more
}

#[allow(clippy::too_many_arguments)]
fn writer_loop(
    mut writer: Writer,
    receiver: Receiver<JobCommand>,
    jobs: Arc<Mutex<HashMap<String, IndexJob>>>,
    running: Arc<Mutex<Option<String>>>,
    queued: Arc<Mutex<Vec<String>>>,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
    notices: Option<Sender<SseNotice>>,
    trash_driver: Arc<dyn TrashDriver + Send + Sync>,
    auto_drain_l4a_on_startup: bool,
) {
    let mut l4a_pending = auto_drain_l4a_on_startup && has_pending_l4a(&mut writer);

    loop {
        if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
            break;
        }
        let command = match receiver.try_recv() {
            Ok(cmd) => Some(cmd),
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {
                if l4a_pending {
                    match receiver.recv_timeout(std::time::Duration::from_millis(L4A_IDLE_DRAIN_MS))
                    {
                        Ok(cmd) => Some(cmd),
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                                break;
                            }
                            l4a_pending = drain_l4a_idle_step(&mut writer, &notices);
                            None
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                } else {
                    match receiver.recv() {
                        Ok(cmd) => Some(cmd),
                        Err(_) => break,
                    }
                }
            }
        };
        let Some(command) = command else {
            continue;
        };
        match command {
            JobCommand::Run { job_id } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    continue;
                }
                let ran_scan = jobs
                    .lock()
                    .expect("任务表锁")
                    .get(&job_id)
                    .is_some_and(|j| {
                        matches!(j.kind, JobKind::VerifyAll | JobKind::ChangedPaths(_))
                    });
                run_job(
                    &mut writer,
                    &jobs,
                    &running,
                    &queued,
                    &shutting_down,
                    &notices,
                    &job_id,
                );
                if ran_scan
                    && !shutting_down.load(std::sync::atomic::Ordering::Acquire)
                    && has_pending_l4a(&mut writer)
                {
                    l4a_pending = true;
                }
            }
            JobCommand::CheckpointCommit { payload, reply } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝提交检查点".to_owned(),
                    )));
                    continue;
                }
                let outcome = writer.transaction(|writer| {
                    guanlan_core::index::state_engine::commit_checkpoint(writer, &payload)
                });
                publish_notice(
                    &notices,
                    &jobs,
                    None,
                    match &outcome {
                        Ok(commit) => {
                            let _ = commit;
                            vec!["task".to_owned()]
                        }
                        Err(_) => Vec::new(),
                    },
                );
                let _ = reply.send(outcome);
            }
            JobCommand::FileOp { op, reply } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝文件操作".to_owned(),
                    )));
                    continue;
                }
                let outcome = match *op {
                    FileOpCommand::Rename(input) => rename_file(&mut writer, &input),
                    FileOpCommand::Move(input) => move_file(&mut writer, &input),
                    FileOpCommand::Trash(input) => {
                        trash_file_with(&mut writer, &input, trash_driver.as_ref())
                    }
                };
                if let Ok(resp) = &outcome {
                    if let Some(sender) = &notices {
                        let _ = sender.send(SseNotice {
                            index_generation: Some(resp.index_generation),
                            new_events: 1,
                            new_revisions: 0,
                            at: guanlan_core::index::clock::now_iso(),
                            kinds: vec!["file_op".to_owned(), "state".to_owned()],
                        });
                    }
                }
                let _ = reply.send(outcome);
            }
            JobCommand::FolderOp { op, reply } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝文件夹操作".to_owned(),
                    )));
                    continue;
                }
                let outcome = match *op {
                    FolderOpCommand::Create(input) => create_folder(&mut writer, &input),
                    FolderOpCommand::Rename(input) => rename_folder(&mut writer, &input),
                    FolderOpCommand::Move(input) => move_folder(&mut writer, &input),
                    FolderOpCommand::Trash(input) => {
                        trash_folder_with(&mut writer, &input, trash_driver.as_ref())
                    }
                };
                if let Ok(resp) = &outcome {
                    if let Some(sender) = &notices {
                        let _ = sender.send(SseNotice {
                            index_generation: Some(resp.index_generation),
                            new_events: 1,
                            new_revisions: 0,
                            at: guanlan_core::index::clock::now_iso(),
                            kinds: vec!["file_op".to_owned(), "state".to_owned()],
                        });
                    }
                }
                let _ = reply.send(outcome);
            }
            JobCommand::CreateDoc { input, reply } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝新建文档".to_owned(),
                    )));
                    continue;
                }
                let outcome = create_document(&mut writer, &input);
                if let Ok(resp) = &outcome {
                    if let Some(sender) = &notices {
                        let _ = sender.send(SseNotice {
                            index_generation: Some(resp.index_generation),
                            new_events: 1,
                            new_revisions: 1,
                            at: guanlan_core::index::clock::now_iso(),
                            kinds: vec!["file_op".to_owned(), "state".to_owned()],
                        });
                    }
                }
                let _ = reply.send(outcome);
            }
            JobCommand::BatchFileOp { op, reply } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝批量文件操作".to_owned(),
                    )));
                    continue;
                }
                let outcome = match *op {
                    BatchFileOpCommand::Move(input) => batch_move_files(&mut writer, &input),
                    BatchFileOpCommand::Trash(input) => {
                        batch_trash_files_with(&mut writer, &input, trash_driver.as_ref())
                    }
                };
                if let Ok(resp) = &outcome {
                    if !resp.succeeded.is_empty() {
                        if let Some(sender) = &notices {
                            let _ = sender.send(SseNotice {
                                index_generation: Some(resp.index_generation),
                                new_events: resp.succeeded.len() as u64,
                                new_revisions: 0,
                                at: guanlan_core::index::clock::now_iso(),
                                kinds: vec!["file_op".to_owned(), "state".to_owned()],
                            });
                        }
                    }
                }
                let _ = reply.send(outcome);
            }
            JobCommand::UpdateStoragePolicy {
                text_max_mib,
                binary_max_mib,
                reply,
            } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝更新存储策略".to_owned(),
                    )));
                    continue;
                }
                let outcome = (|| -> Result<UpdateStoragePolicyResponse, GuanlanError> {
                    let ws = writer.workspace()?;
                    let policy = writer.set_snapshot_policy(text_max_mib, binary_max_mib)?;
                    Ok(UpdateStoragePolicyResponse {
                        ok: true,
                        workspace_id: ws.workspace_id,
                        policy: guanlan_core::application::policy_dto(policy),
                    })
                })();
                let _ = reply.send(outcome);
            }
            JobCommand::StorageGc { request, reply } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝执行存储瘦身".to_owned(),
                    )));
                    continue;
                }
                let outcome =
                    guanlan_core::storage::maintenance::execute_storage_gc(&mut writer, &request);
                let _ = reply.send(outcome);
            }
            JobCommand::BatchReadingState { request, reply } => {
                if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = reply.send(Err(GuanlanError::Internal(
                        "服务正在停机，已拒绝批量更新已读基线".to_owned(),
                    )));
                    continue;
                }
                let outcome = writer.batch_reading_state(&request);
                let _ = reply.send(outcome);
            }
            JobCommand::Shutdown => break,
        }
    }
}

#[allow(clippy::too_many_lines)]
fn run_job(
    writer: &mut Writer,
    jobs: &Arc<Mutex<HashMap<String, IndexJob>>>,
    running: &Arc<Mutex<Option<String>>>,
    queued: &Arc<Mutex<Vec<String>>>,
    shutting_down: &Arc<std::sync::atomic::AtomicBool>,
    notices: &Option<Sender<SseNotice>>,
    job_id: &str,
) {
    let (kind, cancel_flag) = {
        let mut guard = jobs.lock().expect("任务表锁");
        let Some(job) = guard.get_mut(job_id) else {
            return;
        };
        if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
            job.cancelled = true;
            job.cancel_flag
                .store(true, std::sync::atomic::Ordering::Release);
        }
        if job.cancelled {
            drop(guard);
            IndexJobManager::finalize_cancellation(jobs, job_id);
            finish_slot(running, queued, job_id);
            return;
        }
        (job.kind.clone(), Arc::clone(&job.cancel_flag))
    };
    update(jobs, job_id, |job| {
        job.state = JobState::Running;
        job.phase = "running".to_owned();
    });

    if shutting_down.load(std::sync::atomic::Ordering::Acquire) {
        cancel_flag.store(true, std::sync::atomic::Ordering::Release);
    }
    if is_cancelled(jobs, job_id) || cancel_flag.load(std::sync::atomic::Ordering::Acquire) {
        IndexJobManager::finalize_cancellation(jobs, job_id);
        finish_slot(running, queued, job_id);
        return;
    }

    let outcome = execute_job(writer, &kind, Arc::clone(&cancel_flag));
    if outcome.is_ok() && is_cancelled(jobs, job_id) {
        IndexJobManager::finalize_cancellation(jobs, job_id);
    }
    match outcome {
        Ok((summary, result, sse_kinds)) => {
            let last_scan_at = writer
                .workspace()
                .ok()
                .and_then(|workspace| workspace.last_scan_at);
            update(jobs, job_id, |job| {
                job.state = JobState::Completed;
                job.phase = "done".to_owned();
                job.discovered = summary.as_ref().map(|s| s.scanned).unwrap_or(0);
                job.processed = summary.as_ref().map(|s| s.scanned).unwrap_or(0);
                if let Some(summary) = summary {
                    job.index_generation = Some(summary.generation);
                    job.report = Some(summary.clone());
                }
                job.last_scan_at = last_scan_at;
                job.result = result;
                let _ = sse_kinds;
            });
            publish_notice(notices, jobs, Some(job_id.to_owned()), sse_kinds);
            persist_job_run(writer, jobs, job_id, "completed", None);
        }
        Err(GuanlanError::Cancelled(reason)) => {
            update(jobs, job_id, |job| {
                job.cancelled = true;
                job.state = JobState::Failed;
                job.phase = "cancelled".to_owned();
                job.error = Some(reason.clone());
                job.failed_items.clear();
            });
            persist_job_run(
                writer,
                jobs,
                job_id,
                "failed",
                Some(GuanlanError::Cancelled(reason)),
            );
        }
        Err(error) => {
            let message = error.to_string();
            update(jobs, job_id, |job| {
                job.state = JobState::Failed;
                job.phase = "failed".to_owned();
                job.error = Some(message.clone());
                job.failed_items = vec![message];
            });
            persist_job_run(writer, jobs, job_id, "failed", Some(error));
        }
    }
    IndexJobManager::finalize_cancellation(jobs, job_id);
    finish_slot(running, queued, job_id);
}

fn finish_slot(
    running: &Arc<Mutex<Option<String>>>,
    queued: &Arc<Mutex<Vec<String>>>,
    job_id: &str,
) {
    let mut running = running.lock().expect("执行槽锁");
    let mut queued = queued.lock().expect("队列锁");
    if running.as_deref() == Some(job_id) {
        *running = None;
    }
    queued.retain(|id| id != job_id);
}

fn is_cancelled(jobs: &Arc<Mutex<HashMap<String, IndexJob>>>, job_id: &str) -> bool {
    jobs.lock()
        .expect("任务表锁")
        .get(job_id)
        .map(|job| job.cancelled)
        .unwrap_or(false)
}

fn reweave_candidate_clusters(
    writer: &mut Writer,
    workspace_id: &str,
) -> Result<usize, GuanlanError> {
    use guanlan_core::domain::candidate_weaver::{weave_candidates, MIN_MEMBERS};
    use guanlan_core::index::writer::{CandidateMemberRow, CandidateRow};
    use guanlan_core::index::{clock, ident};

    let (files, edges) = writer.collect_weaver_inputs(workspace_id)?;
    let excluded_pairs = writer.list_candidate_exclusions(workspace_id)?;
    let clusters = weave_candidates(
        &files,
        &edges,
        |s| {
            let full = ident::stable_key(s);
            full.chars().take(16).collect::<String>()
        },
        &excluded_pairs,
    );
    let observed_at = clock::now_iso();

    let mut rows: Vec<CandidateRow> = Vec::new();
    let mut members_by: std::collections::HashMap<String, Vec<CandidateMemberRow>> =
        std::collections::HashMap::new();
    for cluster in clusters {
        if cluster.members.len() < MIN_MEMBERS {
            continue;
        }
        let candidate_id = format!("cand_{}", cluster.candidate_key);
        let member_rows: Vec<CandidateMemberRow> = cluster
            .members
            .iter()
            .map(|member| CandidateMemberRow {
                file_id: member.file_id.clone(),
                role: "member".to_owned(),
                signals_json: serde_json::to_string(&member.signals)
                    .unwrap_or_else(|_| "[]".to_owned()),
            })
            .collect();
        rows.push(CandidateRow {
            candidate_id: candidate_id.clone(),
            workspace_id: workspace_id.to_owned(),
            candidate_key: cluster.candidate_key.clone(),
            title: cluster.title.clone(),
            reason_summary: cluster.reason_summary.clone(),
            signal_mask: cluster.signal_mask as i64,
            score: cluster.score as i64,
            member_count: member_rows.len() as i64,
            state: "candidate".to_owned(),
            updated_at: observed_at.clone(),
        });
        members_by.insert(candidate_id, member_rows);
    }

    writer.reweave_candidates(workspace_id, &observed_at, &rows, &members_by)?;
    Ok(rows.len())
}

fn execute_candidate_adopt(
    writer: &mut Writer,
    candidate_id: &str,
) -> Result<serde_json::Value, GuanlanError> {
    use guanlan_core::index::state_machine::initiative_id_of;
    let workspace = writer.workspace()?;
    let workspace_id = workspace.workspace_id.clone();
    let candidate = writer
        .get_candidate_full(candidate_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到候选事项 {candidate_id}")))?;
    if candidate.row.state != "candidate" {
        return Err(GuanlanError::BadRequest(format!(
            "候选 {candidate_id} 当前状态 {}，不可采纳",
            candidate.row.state
        )));
    }
    let now = guanlan_core::index::clock::now_iso();
    let initiative_id = initiative_id_of(&candidate.row.title);

    let existing = writer.find_initiative_by_root_dir(&workspace_id, &candidate.row.title)?;
    let (created_at, current_stage, state, artifact_count) = match &existing {
        Some(row) => (
            row.created_at.clone(),
            row.current_stage.clone(),
            row.state.clone(),
            row.artifact_count,
        ),
        None => (now.clone(), "待分类".to_owned(), "draft".to_owned(), 0),
    };
    writer.transaction(|writer| {
        writer.upsert_initiative(&guanlan_core::storage::InitiativeRow {
            initiative_id: initiative_id.clone(),
            workspace_id: workspace_id.clone(),
            name: candidate.row.title.clone(),
            root_dir: candidate.row.title.clone(),
            current_stage,
            state,
            artifact_count,
            pending_p0: existing.as_ref().map(|r| r.pending_p0).unwrap_or(0),
            pending_p1: existing.as_ref().map(|r| r.pending_p1).unwrap_or(0),
            pending_p2: existing.as_ref().map(|r| r.pending_p2).unwrap_or(0),
            created_at,
            updated_at: now.clone(),
        })?;
        writer.set_candidate_state(candidate_id, "adopted", &now)?;
        writer.insert_event(&guanlan_core::index::writer::NewEvent {
            event_id: format!(
                "evt_candidate_adopted_{}",
                guanlan_core::index::ident::stable_key(&format!("{candidate_id}|{now}"))
            ),
            workspace_id: workspace_id.clone(),
            kind: "initiative_candidate_adopted".to_owned(),
            subject_kind: "initiative".to_owned(),
            subject_id: initiative_id.clone(),
            revision_id: None,
            occurred_at: Some(now.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("state_machine".to_owned()),
            observed_at: now.clone(),
            headline: format!("候选事项已采纳：{}", candidate.row.title),
            detail: format!(
                "候选 {candidate_id}（{} 位成员）经人工确认采纳为正式事项 {initiative_id}；成员归属自本轮重算起固化。",
                candidate.row.member_count
            ),
            payload_json: guanlan_core::index::derive::json_object(&[
                ("candidate_id", guanlan_core::index::derive::json_string(candidate_id)),
                ("initiative_id", guanlan_core::index::derive::json_string(&initiative_id)),
                ("member_count", candidate.row.member_count.to_string()),
            ]),
            batch_id: None,
        })?;
        Ok(())
    })?;

    let outcome = guanlan_core::index::state_engine::state_machine_recompute(
        writer,
        &workspace_id,
        &now,
        &[],
    )?;
    Ok(serde_json::json!({
        "adopt": {
            "candidate_id": candidate_id,
            "initiative_id": initiative_id,
            "member_count": candidate.row.member_count,
            "artifacts_upserted": outcome.artifacts_upserted,
        }
    }))
}

fn execute_candidate_dismiss(
    writer: &mut Writer,
    candidate_id: &str,
) -> Result<serde_json::Value, GuanlanError> {
    let workspace = writer.workspace()?;
    let workspace_id = workspace.workspace_id.clone();
    let candidate = writer
        .get_candidate_full(candidate_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到候选事项 {candidate_id}")))?;
    let now = guanlan_core::index::clock::now_iso();
    let member_ids: Vec<String> = candidate
        .members
        .iter()
        .map(|m| m.file_id.clone())
        .collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for i in 0..member_ids.len() {
        for j in (i + 1)..member_ids.len() {
            pairs.push((member_ids[i].clone(), member_ids[j].clone()));
        }
    }
    writer.insert_candidate_exclusions(&workspace_id, &pairs, &now)?;
    writer.set_candidate_state(candidate_id, "dismissed", &now)?;
    writer.insert_event(&guanlan_core::index::writer::NewEvent {
        event_id: format!(
            "evt_candidate_dismissed_{}",
            guanlan_core::index::ident::stable_key(&format!("{candidate_id}|{now}"))
        ),
        workspace_id: workspace_id.clone(),
        kind: "initiative_candidate_dismissed".to_owned(),
        subject_kind: "candidate".to_owned(),
        subject_id: candidate_id.to_owned(),
        revision_id: None,
        occurred_at: Some(now.clone()),
        occurred_precision: "second".to_owned(),
        occurred_source: Some("state_machine".to_owned()),
        observed_at: now.clone(),
        headline: format!("候选事项已否决：{}", candidate.row.title),
        detail: format!(
            "候选 {candidate_id}（{} 位成员）人工否决；{} 对成员信号已排除，重扫不再反弹。",
            candidate.row.member_count,
            pairs.len()
        ),
        payload_json: guanlan_core::index::derive::json_object(&[
            (
                "candidate_id",
                guanlan_core::index::derive::json_string(candidate_id),
            ),
            ("excluded_pairs", pairs.len().to_string()),
        ]),
        batch_id: None,
    })?;
    Ok(serde_json::json!({
        "dismiss": {
            "candidate_id": candidate_id,
            "excluded_pairs": pairs.len(),
        }
    }))
}

fn execute_candidate_exclude(
    writer: &mut Writer,
    candidate_id: &str,
    file_id: &str,
) -> Result<serde_json::Value, GuanlanError> {
    let workspace = writer.workspace()?;
    let workspace_id = workspace.workspace_id.clone();
    let candidate = writer
        .get_candidate_full(candidate_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到候选事项 {candidate_id}")))?;
    if !candidate.members.iter().any(|m| m.file_id == file_id) {
        return Err(GuanlanError::BadRequest(format!(
            "文件 {file_id} 不是候选 {candidate_id} 的成员"
        )));
    }
    let now = guanlan_core::index::clock::now_iso();
    let others: Vec<String> = candidate
        .members
        .iter()
        .map(|m| m.file_id.clone())
        .filter(|id| id != file_id)
        .collect();
    let mut pairs: Vec<(String, String)> = others
        .iter()
        .map(|other| (file_id.to_owned(), other.clone()))
        .collect();
    let remaining = others.len();
    let dissolved = remaining < 2;
    if dissolved {
        for i in 0..others.len() {
            for j in (i + 1)..others.len() {
                pairs.push((others[i].clone(), others[j].clone()));
            }
        }
    }
    writer.insert_candidate_exclusions(&workspace_id, &pairs, &now)?;
    let surviving_members: Vec<guanlan_core::index::writer::CandidateMemberRow> = candidate
        .members
        .iter()
        .filter(|m| m.file_id != file_id)
        .cloned()
        .collect();
    writer.replace_candidate_members(candidate_id, &surviving_members)?;
    writer.set_candidate_state(
        candidate_id,
        if dissolved { "dismissed" } else { "candidate" },
        &now,
    )?;
    writer.insert_event(&guanlan_core::index::writer::NewEvent {
        event_id: format!(
            "evt_candidate_excluded_{}",
            guanlan_core::index::ident::stable_key(&format!("{candidate_id}|{file_id}|{now}"))
        ),
        workspace_id: workspace_id.clone(),
        kind: "initiative_candidate_member_excluded".to_owned(),
        subject_kind: "candidate".to_owned(),
        subject_id: candidate_id.to_owned(),
        revision_id: None,
        occurred_at: Some(now.clone()),
        occurred_precision: "second".to_owned(),
        occurred_source: Some("state_machine".to_owned()),
        observed_at: now.clone(),
        headline: format!("候选成员已剔除：{file_id}"),
        detail: format!(
            "候选 {candidate_id} 剔除成员 {file_id}（{} 对信号排除）；剩余 {remaining} 位成员{}。",
            pairs.len(),
            if dissolved { "，簇已失效" } else { "" }
        ),
        payload_json: guanlan_core::index::derive::json_object(&[
            (
                "candidate_id",
                guanlan_core::index::derive::json_string(candidate_id),
            ),
            ("file_id", guanlan_core::index::derive::json_string(file_id)),
            (
                "dissolved",
                if dissolved { "true" } else { "false" }.to_owned(),
            ),
        ]),
        batch_id: None,
    })?;
    Ok(serde_json::json!({
        "exclude": {
            "candidate_id": candidate_id,
            "file_id": file_id,
            "excluded_pairs": pairs.len(),
            "remaining_members": remaining,
            "dissolved": dissolved,
        }
    }))
}

#[allow(clippy::type_complexity, clippy::too_many_lines)]
fn execute_job(
    writer: &mut Writer,
    kind: &JobKind,
    cancel_flag: Arc<std::sync::atomic::AtomicBool>,
) -> Result<
    (
        Option<IndexJobReport>,
        Option<serde_json::Value>,
        Vec<String>,
    ),
    GuanlanError,
> {
    match kind {
        JobKind::VerifyAll => {
            let mut options = ReconcileOptions::from_env();
            options.cancel = Some(Arc::clone(&cancel_flag));
            let report = reconcile(writer, &options)?;
            enqueue_l4a(writer, &report.changed_file_ids)?;
            let clusters = if cancel_flag.load(std::sync::atomic::Ordering::Acquire) {
                0
            } else {
                reweave_candidate_clusters(writer, &report.workspace_id)?
            };
            let mut kinds = sse_kinds_from_report(&report);
            if clusters > 0 {
                kinds.push("candidates".to_owned());
            }
            let summary = Some(to_index_job_report(&report));
            Ok((summary, None, kinds))
        }
        JobKind::ChangedPaths(paths) => {
            if paths.is_empty() {
                return Err(GuanlanError::BadRequest(
                    "changed_paths 任务需要 paths（≤2000 条相对路径）".to_owned(),
                ));
            }
            let mut options = ReconcileOptions::from_env();
            options.cancel = Some(Arc::clone(&cancel_flag));
            let report = reconcile_paths(writer, &options, paths)?;
            enqueue_l4a(writer, &report.changed_file_ids)?;
            let clusters = if cancel_flag.load(std::sync::atomic::Ordering::Acquire) {
                0
            } else {
                reweave_candidate_clusters(writer, &report.workspace_id)?
            };
            let mut kinds = vec!["watcher".to_owned()];
            kinds.extend(sse_kinds_from_report(&report));
            if clusters > 0 {
                kinds.push("candidates".to_owned());
            }
            let summary = Some(to_index_job_report(&report));
            Ok((summary, None, kinds))
        }
        JobKind::AdoptCandidate { candidate_id } => {
            let result = execute_candidate_adopt(writer, candidate_id)?;
            Ok((
                None,
                Some(result),
                vec!["state".to_owned(), "candidates".to_owned()],
            ))
        }
        JobKind::DismissCandidate { candidate_id } => {
            let result = execute_candidate_dismiss(writer, candidate_id)?;
            Ok((None, Some(result), vec!["candidates".to_owned()]))
        }
        JobKind::ExcludeCandidateMember {
            candidate_id,
            file_id,
        } => {
            let result = execute_candidate_exclude(writer, candidate_id, file_id)?;
            Ok((None, Some(result), vec!["candidates".to_owned()]))
        }
        JobKind::L4ASummary => {
            let result = process_l4a_batch(writer)?;
            Ok((None, Some(result), vec!["l4a".to_owned()]))
        }
        JobKind::SetInitiativeDirs(dirs) => {
            if dirs.is_empty() {
                return Err(GuanlanError::BadRequest(
                    "set_initiative_dirs 任务需要 dirs（≤64 条目录名）".to_owned(),
                ));
            }
            writer.set_initiative_dirs(dirs)?;
            let mut options = ReconcileOptions::from_env();
            options.cancel = Some(cancel_flag);
            let report = reconcile(writer, &options)?;
            let summary = Some(to_index_job_report(&report));
            Ok((
                summary,
                Some(serde_json::json!({ "initiative_dirs": dirs })),
                sse_kinds_from_report(&report),
            ))
        }
        JobKind::DecisionWriteback {
            statement_id,
            decision,
            confirmer,
            role,
            effective_scope,
            effective_date,
            note,
        } => {
            let input = WritebackInput {
                statement_id: statement_id.clone(),
                decision: decision.clone(),
                confirmer: confirmer.clone(),
                role: role.clone(),
                effective_scope: effective_scope.clone(),
                effective_date: effective_date.clone(),
                note: note.clone(),
            };
            let outcome = apply_decision_writeback(writer, &input)?;
            let result = serde_json::json!({
                "writeback": {
                    "cas_ok": outcome.cas_ok,
                    "file_changed": outcome.file_changed,
                    "new_revision_id": outcome.new_revision_id,
                    "decision_id": outcome.decision_id,
                    "elapsed_ms": outcome.elapsed_ms,
                    "initiative_id": outcome.initiative_id,
                    "remaining_pending_p0_p1": outcome.remaining_pending_p0_p1,
                    "unlocked_downstream": outcome.unlocked_downstream,
                    "initiative_state_after": outcome.initiative_state_after,
                    "cas_conflict": outcome.cas_conflict.map(|conflict| serde_json::json!({
                        "expected_content_hash": conflict.expected_content_hash,
                        "disk_content_hash": conflict.disk_content_hash,
                    })),
                    "draft_id": outcome.draft_id,
                }
            });
            let mut kinds = vec!["decision_writeback".to_owned()];
            if outcome.file_changed {
                kinds.push("state".to_owned());
                kinds.push("task".to_owned());
            }
            Ok((None, Some(result), kinds))
        }
        JobKind::Diff {
            file_id,
            baseline_revision_id,
            target_revision_id,
        } => {
            let result = execute_diff(writer, file_id, baseline_revision_id, target_revision_id)?;
            Ok((None, Some(result), Vec::new()))
        }
        JobKind::ProposeRevision {
            file_id,
            base_revision_id,
            content,
            note,
            input_context_hashes,
            receipt_summary,
        } => {
            let result = execute_propose(
                writer,
                file_id,
                base_revision_id,
                content,
                note.clone(),
                input_context_hashes,
                receipt_summary.as_deref(),
            )?;
            Ok((None, Some(result), vec!["proposal".to_owned()]))
        }
        JobKind::AdoptDraft { draft_id } => {
            let result = execute_adopt(writer, draft_id)?;
            let mut kinds = vec!["proposal".to_owned()];
            kinds.push("state".to_owned());
            kinds.push("task".to_owned());
            Ok((None, Some(result), kinds))
        }
        JobKind::DismissDraft { draft_id, reason } => {
            let result = execute_dismiss(writer, draft_id, reason.as_deref())?;
            Ok((None, Some(result), vec!["proposal".to_owned()]))
        }
        JobKind::ArchiveInitiative {
            initiative_id,
            note,
        } => {
            let result = execute_archive(writer, initiative_id, note.clone())?;
            Ok((
                None,
                Some(result),
                vec!["state".to_owned(), "task".to_owned()],
            ))
        }
        JobKind::ReopenInitiative { initiative_id } => {
            let result = execute_reopen(writer, initiative_id)?;
            Ok((
                None,
                Some(result),
                vec!["state".to_owned(), "task".to_owned()],
            ))
        }
        JobKind::RebuildSearchIndex => {
            let ws_id = writer.workspace()?.workspace_id;
            let outcome = guanlan_core::index::search_index::rebuild_all(writer, &ws_id)?;
            let result = serde_json::json!({
                "search_index": {
                    "rebuilt": outcome.rebuilt,
                    "docs_synced": outcome.docs_synced,
                }
            });
            Ok((None, Some(result), vec!["search".to_owned()]))
        }
        JobKind::RepairOrphan {
            initiative_id,
            node_id,
            action,
            note,
        } => {
            let outcome = guanlan_core::application::review_board::repair_orphan_node(
                writer,
                initiative_id,
                node_id.as_deref(),
                action,
                note.as_deref(),
            )?;
            let result = serde_json::json!({
                "repair": {
                    "initiative_id": outcome.initiative_id,
                    "node_id": outcome.node_id,
                    "stage": outcome.stage,
                    "action": outcome.action,
                    "new_node_state": outcome.new_node_state,
                    "new_board_bucket": outcome.new_board_bucket,
                    "repaired_at": outcome.repaired_at,
                }
            });
            Ok((
                None,
                Some(result),
                vec!["task".to_owned(), "state".to_owned()],
            ))
        }
    }
}

fn to_index_job_report(report: &guanlan_core::index::ReconcileReport) -> IndexJobReport {
    IndexJobReport {
        scanned: report.scanned as u64,
        new_files: report.new_files as u64,
        new_revisions: report.new_revisions as u64,
        unchanged: report.unchanged as u64,
        mtime_only: report.mtime_only as u64,
        content_changed: report.content_changed as u64,
        appeared: report.appeared as u64,
        missing: report.missing as u64,
        recovered: report.recovered as u64,
        unstable_reads: report.unstable_reads as u64,
        events_inserted: report.events_inserted as u64,
        events_skipped: report.events_skipped as u64,
        statements_upserted: report.statements_upserted as u64,
        edges_upserted: report.edges_upserted as u64,
        snapshots_written: report.snapshots_written as u64,
        metadata_only_revisions: report.metadata_only_revisions as u64,
        ignored_paths: report.ignored_paths as u64,
        generation: report.generation,
        duration_ms: report.duration_ms,
    }
}

fn sse_kinds_from_report(report: &guanlan_core::index::ReconcileReport) -> Vec<String> {
    let mut kinds: Vec<String> = Vec::new();
    for kind in &report.state_event_kinds {
        match kind.as_str() {
            "state_changed" => kinds.push("state".to_owned()),
            "task_node_moved" => kinds.push("task".to_owned()),
            _ => {}
        }
    }
    kinds
}

fn enqueue_l4a(writer: &mut Writer, file_ids: &[String]) -> Result<(), GuanlanError> {
    let workspace_id = writer.workspace()?.workspace_id;
    let now = guanlan_core::index::clock::now_iso();
    writer.transaction(|writer| {
        for file_id in file_ids {
            let Some(revision) = writer.latest_revision(file_id)? else {
                continue;
            };
            let job_id = format!(
                "sj_{}",
                guanlan_core::index::ident::stable_key(&format!(
                    "{}|{}",
                    file_id, revision.content_hash
                ))
            );
            writer.upsert_summary_job(&guanlan_core::storage::SummaryJobRow {
                job_id,
                workspace_id: workspace_id.clone(),
                file_id: file_id.clone(),
                content_hash: revision.content_hash.clone(),
                priority: 10,
                state: "queued".to_owned(),
                summary_json: None,
                attempts: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
        }
        Ok(())
    })
}

fn process_l4a_batch(writer: &mut Writer) -> Result<serde_json::Value, GuanlanError> {
    let workspace_id = writer.workspace()?.workspace_id;
    let pending_rows = writer.list_pending_summary_jobs(&workspace_id, 3)?;
    let mut processed: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let now = guanlan_core::index::clock::now_iso();
    for row in pending_rows {
        let next_attempts = row.attempts + 1;
        let revision = writer.latest_revision(&row.file_id)?;
        let Some(revision) = revision else {
            writer.upsert_summary_job(&guanlan_core::storage::SummaryJobRow {
                job_id: row.job_id.clone(),
                workspace_id: workspace_id.clone(),
                file_id: row.file_id.clone(),
                content_hash: row.content_hash.clone(),
                priority: row.priority,
                state: "failed".to_owned(),
                summary_json: None,
                attempts: next_attempts,
                created_at: row.created_at.clone(),
                updated_at: now.clone(),
            })?;
            failed.push(row.file_id.clone());
            continue;
        };
        if revision.content_hash != row.content_hash {
            let next_state = if next_attempts >= L4A_MAX_ATTEMPTS {
                failed.push(row.file_id.clone());
                "failed"
            } else {
                "queued"
            };
            writer.upsert_summary_job(&guanlan_core::storage::SummaryJobRow {
                job_id: row.job_id.clone(),
                workspace_id: workspace_id.clone(),
                file_id: row.file_id.clone(),
                content_hash: revision.content_hash.clone(),
                priority: row.priority,
                state: next_state.to_owned(),
                summary_json: None,
                attempts: next_attempts,
                created_at: row.created_at.clone(),
                updated_at: now.clone(),
            })?;
            continue;
        }
        let Some(bytes) = writer.read_snapshot(&revision.content_hash) else {
            writer.upsert_summary_job(&guanlan_core::storage::SummaryJobRow {
                job_id: row.job_id.clone(),
                workspace_id: workspace_id.clone(),
                file_id: row.file_id.clone(),
                content_hash: row.content_hash.clone(),
                priority: row.priority,
                state: "failed".to_owned(),
                summary_json: None,
                attempts: next_attempts,
                created_at: row.created_at.clone(),
                updated_at: now.clone(),
            })?;
            failed.push(row.file_id.clone());
            continue;
        };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let statements = writer.statements_of_revision(&revision.revision_id)?;
        let detail = guanlan_core::query::longtasks::build_summary_detail(&content, &statements);
        writer.upsert_summary_job(&guanlan_core::storage::SummaryJobRow {
            job_id: row.job_id.clone(),
            workspace_id: workspace_id.clone(),
            file_id: row.file_id.clone(),
            content_hash: row.content_hash.clone(),
            priority: row.priority,
            state: "done".to_owned(),
            summary_json: Some(serde_json::to_string(&detail).unwrap_or_default()),
            attempts: next_attempts,
            created_at: row.created_at.clone(),
            updated_at: now.clone(),
        })?;
        processed.push(row.file_id.clone());
    }
    Ok(serde_json::json!({
        "processed": processed,
        "failed": failed,
        "batch_limit": 3,
    }))
}

fn execute_diff(
    writer: &mut Writer,
    file_id: &str,
    baseline_revision_id: &str,
    target_revision_id: &str,
) -> Result<serde_json::Value, GuanlanError> {
    const DIFF_SNAPSHOT_CAP: usize = 8 * 1024 * 1024;
    let file = writer
        .get_file(file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {file_id}")))?;
    let load =
        |revision_id: &str| -> Result<(String, guanlan_core::storage::RevisionRow), GuanlanError> {
            let revision = writer
                .get_revision(revision_id)?
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到该版本 {revision_id}")))?;
            if revision.file_id != file_id {
                return Err(GuanlanError::BadRequest(format!(
                    "版本 {revision_id} 不属于文件 {file_id}"
                )));
            }
            let bytes = writer
                .read_snapshot(&revision.content_hash)
                .ok_or_else(|| {
                    GuanlanError::SnapshotUnavailable(format!(
                        "版本 {} 的快照不可用（413 口径）",
                        revision_id
                    ))
                })?;
            if bytes.len() > DIFF_SNAPSHOT_CAP {
                return Err(GuanlanError::UnsupportedContent(format!(
                    "版本 {} 快照 {} 字节超过 diff 单版上限 {} 字节",
                    revision_id,
                    bytes.len(),
                    DIFF_SNAPSHOT_CAP
                )));
            }
            Ok((String::from_utf8_lossy(&bytes).into_owned(), revision))
        };
    let (baseline_content, baseline_row) = load(baseline_revision_id)?;
    let (target_content, target_row) = load(target_revision_id)?;
    let baseline_statements = writer.statements_of_revision(baseline_revision_id)?;
    let target_statements = writer.statements_of_revision(target_revision_id)?;
    let result = guanlan_core::application::diff::compute_diff(
        &baseline_content,
        &target_content,
        &baseline_statements,
        &target_statements,
    );
    let checkpoint_id = writer
        .get_artifact_state(file_id)?
        .and_then(|artifact| artifact.initiative_id)
        .and_then(|initiative_id| {
            writer
                .list_checkpoints(&writer.workspace().ok()?.workspace_id, &initiative_id)
                .ok()
                .map(|rows| {
                    rows.into_iter()
                        .find(|row| row.status == "SUCCESS")
                        .map(|row| row.checkpoint_id)
                })
        })
        .flatten();
    let _ = (baseline_row, target_row);
    const SECTION_PAGE: usize = 20;
    let (page, next_cursor) = if result.sections.len() > SECTION_PAGE {
        (
            result.sections[..SECTION_PAGE].to_vec(),
            Some(guanlan_core::query::cursor::encode_key_cursor_offset(
                SECTION_PAGE as u64,
            )),
        )
    } else {
        (result.sections.clone(), None)
    };
    let sections: Vec<serde_json::Value> = page
        .iter()
        .map(|section| {
            serde_json::json!({
                "title": section.title,
                "baseline_start": section.baseline_start,
                "target_start": section.target_start,
                "lines": section.lines.iter().map(|line| serde_json::json!({
                    "type": line.type_str(),
                    "text": line.text(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(serde_json::json!({
        "summary": {
            "headline": format!("{} {}→{}", file.current_path, baseline_revision_id, target_revision_id),
            "items": result.items.iter().map(|item| serde_json::json!({
                "label": item.label,
                "count": item.count,
                "sign": item.sign,
            })).collect::<Vec<_>>(),
            "checkpoint_id": checkpoint_id,
        },
        "sections": sections,
        "truncated": result.truncated,
        "next_cursor": next_cursor,
    }))
}

fn execute_propose(
    writer: &mut Writer,
    file_id: &str,
    base_revision_id: &str,
    content: &str,
    note: Option<String>,
    raw_context_hashes: &[String],
    raw_receipt_summary: Option<&str>,
) -> Result<serde_json::Value, GuanlanError> {
    use guanlan_core::application::proposals::{
        draft_version_label, evaluate_proposal_cas, normalize_context_hashes,
        normalize_receipt_summary, serialize_context_hashes,
    };
    guanlan_core::index::writeback::ensure_not_archived(writer, file_id)?;
    let workspace = writer.workspace()?;
    let file = writer
        .get_file(file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {file_id}")))?;
    let base_revision = writer
        .get_revision(base_revision_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到基准版本 {base_revision_id}")))?;
    if base_revision.file_id != file_id {
        return Err(GuanlanError::BadRequest(format!(
            "基准版本 {base_revision_id} 不属于文件 {file_id}"
        )));
    }
    let latest_seq = writer
        .latest_revision(file_id)?
        .map(|row| row.seq)
        .unwrap_or(base_revision.seq);
    let version_label = draft_version_label(latest_seq.max(base_revision.seq));
    let context_hashes = normalize_context_hashes(raw_context_hashes);
    let context_hashes_json = serialize_context_hashes(&context_hashes);
    let receipt_summary = normalize_receipt_summary(raw_receipt_summary);

    let disk_hash = match guanlan_core::storage::sandbox::resolve_workspace_file_in_jail(
        &workspace.root_path,
        &file.current_path,
    ) {
        Ok(disk_path) => std::fs::read(&disk_path)
            .map(|bytes| guanlan_core::domain::sha256_hex(&bytes))
            .unwrap_or_default(),
        Err(GuanlanError::NotFound(_)) => String::new(),
        Err(err) => return Err(err),
    };
    let proposed_hash = guanlan_core::domain::sha256_hex(content.as_bytes());
    let cas_verdict =
        evaluate_proposal_cas(&base_revision.content_hash, &disk_hash, &proposed_hash);
    let conflict = cas_verdict.is_conflict();
    let cas_ok = !conflict;
    let snapshot_rel = writer.write_snapshot_bytes(content.as_bytes(), &proposed_hash)?;
    let draft_id = format!(
        "draft_{}",
        guanlan_core::index::ident::stable_key(&format!(
            "{}|{}|{}",
            file_id, base_revision_id, proposed_hash
        ))
    );
    let now = guanlan_core::index::clock::now_iso();
    let workspace_id = workspace.workspace_id.clone();
    let rel_path = file.current_path.clone();
    writer.transaction(|writer| {
        writer.upsert_revision_draft(&guanlan_core::storage::RevisionDraftRow {
            draft_id: draft_id.clone(),
            workspace_id: workspace_id.clone(),
            file_id: file_id.to_owned(),
            base_revision_id: base_revision_id.to_owned(),
            base_content_hash: base_revision.content_hash.clone(),
            proposed_content_hash: proposed_hash.clone(),
            snapshot_rel_path: snapshot_rel,
            source: "agent".to_owned(),
            status: "proposed".to_owned(),
            conflict: i64::from(conflict),
            note: note.clone(),
            draft_version_label: version_label.clone(),
            input_context_hashes_json: context_hashes_json.clone(),
            receipt_summary: receipt_summary.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
        })?;
        let payload = guanlan_core::index::derive::json_object(&[
            ("draft_id", guanlan_core::index::derive::json_string(&draft_id)),
            ("file_id", guanlan_core::index::derive::json_string(file_id)),
            ("path", guanlan_core::index::derive::json_string(&rel_path)),
            (
                "base_revision_id",
                guanlan_core::index::derive::json_string(base_revision_id),
            ),
            (
                "draft_version_label",
                guanlan_core::index::derive::json_string(&version_label),
            ),
            (
                "proposed_content_hash",
                guanlan_core::index::derive::json_string(&proposed_hash),
            ),
            (
                "input_context_hashes",
                context_hashes_json.clone(),
            ),
            (
                "receipt_summary",
                receipt_summary
                    .as_deref()
                    .map(guanlan_core::index::derive::json_string)
                    .unwrap_or_else(|| "null".to_owned()),
            ),
            ("source", guanlan_core::index::derive::json_string("agent")),
            (
                "conflict",
                if conflict {
                    "true".to_owned()
                } else {
                    "false".to_owned()
                },
            ),
        ]);
        let receipt_tail = receipt_summary
            .as_deref()
            .map(|s| format!("；回执：{s}"))
            .unwrap_or_default();
        writer.insert_event(&guanlan_core::index::writer::NewEvent {
            event_id: format!(
                "evt_proposal_raised_{}",
                guanlan_core::index::ident::stable_key(&format!("{draft_id}|{now}"))
            ),
            workspace_id,
            kind: "proposal_raised".to_owned(),
            subject_kind: "draft".to_owned(),
            subject_id: draft_id.clone(),
            revision_id: Some(base_revision_id.to_owned()),
            occurred_at: Some(now.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("state_machine".to_owned()),
            observed_at: now,
            headline: format!("智能体已提交修订草案（{}）：{}", version_label, rel_path),
            detail: if conflict {
                format!(
                    "草案 {}（{}）与磁盘当前内容存在分歧（conflict=1，已保留独立草案分支，未覆盖磁盘原稿）{}。",
                    draft_id, version_label, receipt_tail
                )
            } else {
                format!(
                    "草案 {}（{}）基于版本 {}（关联 {} 份输入上下文），待人工批阅采纳{}。",
                    draft_id,
                    version_label,
                    base_revision_id,
                    context_hashes.len(),
                    receipt_tail
                )
            },
            payload_json: payload,
            batch_id: None,
        })?;
        Ok(())
    })?;
    Ok(serde_json::json!({
        "proposal": {
            "draft_id": draft_id,
            "draft_version_label": version_label,
            "cas_ok": cas_ok,
            "status": "proposed",
            "conflict": conflict,
            "input_context_hashes": context_hashes,
            "receipt_summary": receipt_summary,
        }
    }))
}

fn execute_adopt(writer: &mut Writer, draft_id: &str) -> Result<serde_json::Value, GuanlanError> {
    use guanlan_core::application::proposals::{
        build_derived_context_edges, evaluate_proposal_cas, parse_context_hashes_json,
        DerivedContextTarget, ProposalCasVerdict,
    };
    let workspace = writer.workspace()?;
    let draft = writer
        .list_revision_drafts(&workspace.workspace_id, None, None)?
        .into_iter()
        .find(|row| row.draft_id == draft_id)
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到草案 {draft_id}")))?;
    let Some(content_bytes) = writer.read_snapshot_rel(&draft.snapshot_rel_path) else {
        return Err(GuanlanError::SnapshotUnavailable(format!(
            "草案 {} 的内容快照不可用",
            draft_id
        )));
    };
    let content = String::from_utf8_lossy(&content_bytes).into_owned();
    let file = writer
        .get_file(&draft.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {}", draft.file_id)))?;
    guanlan_core::index::writeback::ensure_not_archived(writer, &draft.file_id)?;
    let disk_path = guanlan_core::storage::sandbox::resolve_workspace_file_in_jail(
        &workspace.root_path,
        &file.current_path,
    )?;
    let disk_bytes = std::fs::read(&disk_path).ok();
    let disk_hash = disk_bytes
        .as_deref()
        .map(guanlan_core::domain::sha256_hex)
        .unwrap_or_default();
    let proposed_hash = guanlan_core::domain::sha256_hex(content.as_bytes());

    match evaluate_proposal_cas(&draft.base_content_hash, &disk_hash, &proposed_hash) {
        ProposalCasVerdict::Conflict {
            expected_content_hash,
            disk_content_hash,
        } => {
            if draft.conflict == 0 {
                let _ = mark_draft_conflict(writer, draft_id);
            }
            return Ok(serde_json::json!({
                "adopt": {
                    "cas_ok": false,
                    "new_revision_id": serde_json::Value::Null,
                    "draft_version_label": draft.draft_version_label,
                    "derived_edges_written": 0,
                    "cas_conflict": {
                        "expected_content_hash": expected_content_hash,
                        "disk_content_hash": disk_content_hash,
                    },
                }
            }));
        }
        ProposalCasVerdict::NoOp => {
            mark_draft(writer, draft_id, "adopted", None)?;
            return Ok(serde_json::json!({
                "adopt": {
                    "cas_ok": true,
                    "new_revision_id": serde_json::Value::Null,
                    "draft_version_label": draft.draft_version_label,
                    "derived_edges_written": 0,
                    "cas_conflict": serde_json::Value::Null,
                }
            }));
        }
        ProposalCasVerdict::Clean => {}
    }

    if let Some(orig_bytes) = disk_bytes.as_deref() {
        if !disk_hash.is_empty() {
            let _ = writer.write_snapshot_bytes(orig_bytes, &disk_hash);
        }
    }

    write_workspace_file(&disk_path, content.as_bytes(), &proposed_hash)?;
    let options = ReconcileOptions {
        observed_at: Some(guanlan_core::index::clock::now_iso()),
        ..ReconcileOptions::default()
    };
    let report = reconcile_paths(writer, &options, std::slice::from_ref(&file.current_path))?;
    let _ = report;
    let new_revision_id = writer
        .latest_revision(&draft.file_id)?
        .filter(|row| row.content_hash == proposed_hash)
        .map(|row| row.revision_id);

    let context_hashes = parse_context_hashes_json(&draft.input_context_hashes_json);
    let mut derived_edges_written: usize = 0;
    if let Some(new_rev_id) = new_revision_id.as_deref() {
        let mut targets = Vec::new();
        for hash in &context_hashes {
            if let Some((target_file_id, target_rev_id)) =
                writer.find_revision_by_hash_or_prefix(&workspace.workspace_id, hash)?
            {
                targets.push(DerivedContextTarget {
                    file_id: target_file_id,
                    revision_id: target_rev_id,
                    matched_hash: hash.clone(),
                });
            }
        }
        targets.push(DerivedContextTarget {
            file_id: draft.file_id.clone(),
            revision_id: draft.base_revision_id.clone(),
            matched_hash: draft.base_content_hash.clone(),
        });
        let edges = build_derived_context_edges(
            &workspace.workspace_id,
            &draft.file_id,
            new_rev_id,
            draft_id,
            &draft.draft_version_label,
            draft.receipt_summary.as_deref(),
            &targets,
        );
        derived_edges_written = edges.len();
        let now = guanlan_core::index::clock::now_iso();
        let ws_id = workspace.workspace_id.clone();
        let rel_path = file.current_path.clone();
        let label = draft.draft_version_label.clone();
        let rev_owned = new_rev_id.to_owned();
        writer.transaction(|tx| {
            for edge in &edges {
                tx.upsert_edge(edge)?;
            }
            let payload = guanlan_core::index::derive::json_object(&[
                ("draft_id", guanlan_core::index::derive::json_string(draft_id)),
                ("file_id", guanlan_core::index::derive::json_string(&draft.file_id)),
                ("path", guanlan_core::index::derive::json_string(&rel_path)),
                (
                    "new_revision_id",
                    guanlan_core::index::derive::json_string(&rev_owned),
                ),
                (
                    "draft_version_label",
                    guanlan_core::index::derive::json_string(&label),
                ),
                ("derived_edges_written", derived_edges_written.to_string()),
            ]);
            tx.insert_event(&guanlan_core::index::writer::NewEvent {
                event_id: format!(
                    "evt_proposal_adopted_{}",
                    guanlan_core::index::ident::stable_key(&format!("{draft_id}|{rev_owned}"))
                ),
                workspace_id: ws_id,
                kind: "proposal_adopted".to_owned(),
                subject_kind: "draft".to_owned(),
                subject_id: draft_id.to_owned(),
                revision_id: Some(rev_owned),
                occurred_at: Some(now.clone()),
                occurred_precision: "second".to_owned(),
                occurred_source: Some("state_machine".to_owned()),
                observed_at: now,
                headline: format!("已采纳智能体草案（{}）：{}", label, rel_path),
                detail: format!(
                    "草案 {} 已通过 CAS 校验落盘并推进正式版本，记录 {} 条 derived_from_context 因果边。",
                    draft_id, derived_edges_written
                ),
                payload_json: payload,
                batch_id: None,
            })?;
            Ok(())
        })?;
    }

    mark_draft(writer, draft_id, "adopted", None)?;
    let checkpoint_context_hash = context_hashes
        .first()
        .map(String::as_str)
        .unwrap_or(&draft.base_content_hash);
    let auto_checkpoint = auto_checkpoint_after_adopt(
        writer,
        &workspace.workspace_id,
        &file.current_path,
        checkpoint_context_hash,
        new_revision_id.as_deref(),
    );
    Ok(serde_json::json!({
        "adopt": {
            "cas_ok": true,
            "new_revision_id": new_revision_id,
            "draft_version_label": draft.draft_version_label,
            "derived_edges_written": derived_edges_written,
            "cas_conflict": serde_json::Value::Null,
            "auto_checkpoint": auto_checkpoint,
        }
    }))
}

fn auto_checkpoint_after_adopt(
    writer: &mut Writer,
    workspace_id: &str,
    current_path: &str,
    input_context_hash: &str,
    output_revision_id: Option<&str>,
) -> serde_json::Value {
    use guanlan_core::index::state_machine::{initiative_id_of, recognize_initiative};
    let dirs = writer.initiative_dirs().unwrap_or_default();
    let Some(dir) = recognize_initiative(current_path, &dirs) else {
        return serde_json::Value::Null;
    };
    let input = guanlan_core::index::writer::CheckpointInput {
        node_id: None,
        workspace_id: workspace_id.to_owned(),
        initiative_id: initiative_id_of(&dir),
        stage: "执行".to_owned(),
        status: "SUCCESS".to_owned(),
        input_context_hash: input_context_hash.to_owned(),
        output_revision_id: output_revision_id.map(str::to_owned),
        token_usage: None,
        elapsed_ms: None,
        note: Some("采纳修订草案自动落检查点".to_owned()),
        created_at: guanlan_core::index::clock::now_iso(),
    };
    match writer.transaction(|tx| guanlan_core::index::state_engine::commit_checkpoint(tx, &input))
    {
        Ok(outcome) => serde_json::json!({
            "checkpoint_id": outcome.checkpoint_id,
            "node_state": outcome.node_state,
        }),
        Err(error) => serde_json::json!({ "error": error.to_string() }),
    }
}

fn execute_dismiss(
    writer: &mut Writer,
    draft_id: &str,
    reason: Option<&str>,
) -> Result<serde_json::Value, GuanlanError> {
    let workspace = writer.workspace()?;
    let draft = writer
        .list_revision_drafts(&workspace.workspace_id, None, None)?
        .into_iter()
        .find(|row| row.draft_id == draft_id)
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到草案 {draft_id}")))?;
    let clean_reason = reason
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let next_note = match (&draft.note, &clean_reason) {
        (Some(existing), Some(r)) if !existing.trim().is_empty() => {
            Some(format!("{existing}｜退回重做：{r}"))
        }
        (_, Some(r)) => Some(format!("退回重做：{r}")),
        (existing, None) => existing.clone(),
    };
    let rel_path = writer
        .get_file(&draft.file_id)?
        .map(|f| f.current_path)
        .unwrap_or_default();
    let now = guanlan_core::index::clock::now_iso();
    let ws_id = workspace.workspace_id.clone();
    let label = draft.draft_version_label.clone();
    writer.transaction(|tx| {
        tx.upsert_revision_draft(&guanlan_core::storage::RevisionDraftRow {
            status: "dismissed".to_owned(),
            note: next_note.clone(),
            updated_at: now.clone(),
            ..draft.clone()
        })?;
        let payload = guanlan_core::index::derive::json_object(&[
            (
                "draft_id",
                guanlan_core::index::derive::json_string(draft_id),
            ),
            (
                "file_id",
                guanlan_core::index::derive::json_string(&draft.file_id),
            ),
            ("path", guanlan_core::index::derive::json_string(&rel_path)),
            (
                "draft_version_label",
                guanlan_core::index::derive::json_string(&label),
            ),
            (
                "reason",
                clean_reason
                    .as_deref()
                    .map(guanlan_core::index::derive::json_string)
                    .unwrap_or_else(|| "null".to_owned()),
            ),
        ]);
        tx.insert_event(&guanlan_core::index::writer::NewEvent {
            event_id: format!(
                "evt_proposal_dismissed_{}",
                guanlan_core::index::ident::stable_key(&format!("{draft_id}|{now}"))
            ),
            workspace_id: ws_id,
            kind: "proposal_dismissed".to_owned(),
            subject_kind: "draft".to_owned(),
            subject_id: draft_id.to_owned(),
            revision_id: Some(draft.base_revision_id.clone()),
            occurred_at: Some(now.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("state_machine".to_owned()),
            observed_at: now,
            headline: format!("已退回智能体草案重做（{}）：{}", label, rel_path),
            detail: match clean_reason.as_deref() {
                Some(r) => format!("草案 {} 已退回（未修改磁盘原稿）；原因：{}", draft_id, r),
                None => format!("草案 {} 已退回重做（未修改磁盘原稿）。", draft_id),
            },
            payload_json: payload,
            batch_id: None,
        })?;
        Ok(())
    })?;
    Ok(serde_json::json!({
        "dismiss": {
            "draft_id": draft_id,
            "status": "dismissed",
            "reason": clean_reason,
        }
    }))
}

fn mark_draft(
    writer: &mut Writer,
    draft_id: &str,
    status: &str,
    note_override: Option<String>,
) -> Result<(), GuanlanError> {
    let workspace = writer.workspace()?;
    let row = writer
        .list_revision_drafts(&workspace.workspace_id, None, None)?
        .into_iter()
        .find(|row| row.draft_id == draft_id)
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到草案 {draft_id}")))?;
    let note = note_override.or(row.note.clone());
    writer.upsert_revision_draft(&guanlan_core::storage::RevisionDraftRow {
        status: status.to_owned(),
        note,
        updated_at: guanlan_core::index::clock::now_iso(),
        ..row
    })?;
    Ok(())
}

fn mark_draft_conflict(writer: &mut Writer, draft_id: &str) -> Result<(), GuanlanError> {
    let workspace = writer.workspace()?;
    let row = writer
        .list_revision_drafts(&workspace.workspace_id, None, None)?
        .into_iter()
        .find(|row| row.draft_id == draft_id)
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到草案 {draft_id}")))?;
    writer.upsert_revision_draft(&guanlan_core::storage::RevisionDraftRow {
        conflict: 1,
        updated_at: guanlan_core::index::clock::now_iso(),
        ..row
    })?;
    Ok(())
}

fn write_workspace_file(
    target: &std::path::Path,
    content: &[u8],
    expected_hash: &str,
) -> Result<(), GuanlanError> {
    use std::io::Read;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target.with_extension(format!("guanlan-tmp-{}-{nanos:x}", std::process::id()));
    std::fs::write(&tmp, content)
        .map_err(|e| GuanlanError::Internal(format!("写临时文件失败 {}：{e}", tmp.display())))?;
    let mut verify = Vec::with_capacity(content.len());
    std::fs::File::open(&tmp)
        .and_then(|mut f| f.read_to_end(&mut verify))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            GuanlanError::Internal(format!("重读临时文件失败 {}：{e}", tmp.display()))
        })?;
    if guanlan_core::domain::sha256_hex(&verify) != expected_hash {
        let _ = std::fs::remove_file(&tmp);
        return Err(GuanlanError::Internal(format!(
            "临时文件校验失败：{}",
            target.display()
        )));
    }
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        GuanlanError::Internal(format!("原子改名失败 {}：{e}", target.display()))
    })
}

fn execute_archive(
    writer: &mut Writer,
    initiative_id: &str,
    note: Option<String>,
) -> Result<serde_json::Value, GuanlanError> {
    let workspace = writer.workspace()?;
    let initiative = writer
        .get_initiative(&workspace.workspace_id, initiative_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到专项 {initiative_id}")))?;
    let was_delivered = initiative.state == "delivered";
    let now = guanlan_core::index::clock::now_iso();
    let recompute_at = now.clone();
    let workspace_id = workspace.workspace_id.clone();
    let mut artifact_ids: Vec<String> = Vec::new();
    writer.transaction(|writer| {
        writer.upsert_initiative(&guanlan_core::storage::InitiativeRow {
            state: "archived".to_owned(),
            updated_at: now.clone(),
            ..initiative.clone()
        })?;
        for state_row in writer.list_artifact_states(&workspace_id)? {
            if state_row.initiative_id.as_deref() == Some(initiative_id) {
                artifact_ids.push(state_row.file_id.clone());
                writer.upsert_artifact_state(&guanlan_core::storage::ArtifactStateRow {
                    state: "archived".to_owned(),
                    updated_at: now.clone(),
                    ..state_row
                })?;
            }
        }
        let payload = guanlan_core::index::derive::json_object(&[
            (
                "initiative_id",
                guanlan_core::index::derive::json_string(initiative_id),
            ),
            ("artifact_count", artifact_ids.len().to_string()),
            (
                "note",
                match &note {
                    Some(value) => guanlan_core::index::derive::json_string(value),
                    None => "null".to_owned(),
                },
            ),
        ]);
        writer.insert_event(&guanlan_core::index::writer::NewEvent {
            event_id: format!(
                "evt_initiative_archived_{}",
                guanlan_core::index::ident::stable_key(&format!("{initiative_id}|{now}"))
            ),
            workspace_id,
            kind: "initiative_archived".to_owned(),
            subject_kind: "initiative".to_owned(),
            subject_id: initiative_id.to_owned(),
            revision_id: None,
            occurred_at: Some(now.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("state_machine".to_owned()),
            observed_at: now,
            headline: format!("专项已归档：{}", initiative.name),
            detail: format!(
                "专项 {} 及其 {} 份文档进入归档态；重开需显式 reopen。",
                initiative.name,
                artifact_ids.len()
            ),
            payload_json: payload,
            batch_id: None,
        })?;
        Ok(())
    })?;
    let workspace_id = writer.workspace()?.workspace_id;
    state_machine_recompute(writer, &workspace_id, &recompute_at, &[])?;
    let mut result = serde_json::json!({
        "initiative": {
            "initiative_id": initiative_id,
            "state": "archived",
            "artifacts_archived": artifact_ids.len(),
        }
    });
    if !was_delivered {
        result["initiative"]["warn"] = serde_json::Value::String("当前非已交付态".to_owned());
    }
    Ok(result)
}

fn execute_reopen(
    writer: &mut Writer,
    initiative_id: &str,
) -> Result<serde_json::Value, GuanlanError> {
    let workspace = writer.workspace()?;
    let initiative = writer
        .get_initiative(&workspace.workspace_id, initiative_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到专项 {initiative_id}")))?;
    let now = guanlan_core::index::clock::now_iso();
    let recompute_at = now.clone();
    let workspace_id = workspace.workspace_id.clone();
    let mut artifact_ids: Vec<String> = Vec::new();
    writer.transaction(|writer| {
        writer.upsert_initiative(&guanlan_core::storage::InitiativeRow {
            state: "draft".to_owned(),
            updated_at: now.clone(),
            ..initiative.clone()
        })?;
        for state_row in writer.list_artifact_states(&workspace_id)? {
            if state_row.initiative_id.as_deref() == Some(initiative_id)
                && state_row.state == "archived"
            {
                artifact_ids.push(state_row.file_id.clone());
                writer.upsert_artifact_state(&guanlan_core::storage::ArtifactStateRow {
                    state: "draft".to_owned(),
                    updated_at: now.clone(),
                    ..state_row
                })?;
            }
        }
        let payload = guanlan_core::index::derive::json_object(&[
            (
                "initiative_id",
                guanlan_core::index::derive::json_string(initiative_id),
            ),
            ("artifact_count", artifact_ids.len().to_string()),
        ]);
        writer.insert_event(&guanlan_core::index::writer::NewEvent {
            event_id: format!(
                "evt_initiative_reopened_{}",
                guanlan_core::index::ident::stable_key(&format!("{initiative_id}|{now}"))
            ),
            workspace_id,
            kind: "initiative_reopened".to_owned(),
            subject_kind: "initiative".to_owned(),
            subject_id: initiative_id.to_owned(),
            revision_id: None,
            occurred_at: Some(now.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("state_machine".to_owned()),
            observed_at: now,
            headline: format!("专项已重开：{}", initiative.name),
            detail: format!(
                "专项 {} 从归档态回退 draft；后续状态由状态机按当前信号重算。",
                initiative.name
            ),
            payload_json: payload,
            batch_id: None,
        })?;
        Ok(())
    })?;
    let workspace_id = writer.workspace()?.workspace_id;
    state_machine_recompute(writer, &workspace_id, &recompute_at, &[])?;
    Ok(serde_json::json!({
        "initiative": {
            "initiative_id": initiative_id,
            "state": "draft",
            "artifacts_reopened": artifact_ids.len(),
        }
    }))
}

fn persist_job_run(
    writer: &mut Writer,
    jobs: &Arc<Mutex<HashMap<String, IndexJob>>>,
    job_id: &str,
    state: &str,
    error: Option<GuanlanError>,
) {
    let snapshot = {
        let guard = jobs.lock().expect("任务表锁");
        guard.get(job_id).cloned()
    };
    let Some(job) = snapshot else {
        return;
    };
    let workspace_id = match writer.workspace() {
        Ok(ws) => ws.workspace_id,
        Err(_) => return,
    };
    let now = guanlan_core::index::clock::now_iso();
    let _ = writer.upsert_job_run(&guanlan_core::storage::JobRunRow {
        job_id: job.job_id.clone(),
        workspace_id,
        kind: job.kind.as_str().to_owned(),
        state: state.to_owned(),
        phase: job.phase.clone(),
        request_json: job.kind.to_request_json(),
        progress_json: serde_json::json!({
            "discovered": job.discovered,
            "processed": job.processed,
        })
        .to_string(),
        error: error.map(|e| e.to_string()).or(job.error.clone()),
        created_at: now.clone(),
        updated_at: now,
    });
}

fn publish_notice(
    notices: &Option<Sender<SseNotice>>,
    jobs: &Arc<Mutex<HashMap<String, IndexJob>>>,
    job_id: Option<String>,
    extra_kinds: Vec<String>,
) {
    let Some(sender) = notices else {
        return;
    };
    let mut generation = None;
    let mut new_events = 0u64;
    let mut new_revisions = 0u64;
    if let Some(job_id) = &job_id {
        if let Some(job) = jobs.lock().expect("任务表锁").get(job_id) {
            generation = job.index_generation;
            new_events = job.report.as_ref().map(|r| r.events_inserted).unwrap_or(0);
            new_revisions = job.report.as_ref().map(|r| r.new_revisions).unwrap_or(0);
        }
    }
    let mut kinds = extra_kinds;
    kinds.sort();
    kinds.dedup();
    let notice = SseNotice {
        index_generation: generation,
        new_events,
        new_revisions,
        at: guanlan_core::index::clock::now_iso(),
        kinds,
    };
    let _ = sender.send(notice);
}

fn update(
    jobs: &Arc<Mutex<HashMap<String, IndexJob>>>,
    job_id: &str,
    f: impl FnOnce(&mut IndexJob),
) {
    let mut guard = jobs.lock().expect("任务表锁");
    if let Some(job) = guard.get_mut(job_id) {
        f(job);
    }
}

fn new_job_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("job_{}_{:x}_{seq}", std::process::id(), nanos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_kind_parsing_external_only() {
        assert_eq!(JobKind::parse("verify_all"), Some(JobKind::VerifyAll));
        assert_eq!(JobKind::parse(""), Some(JobKind::VerifyAll));
        assert_eq!(
            JobKind::parse("changed_paths"),
            Some(JobKind::ChangedPaths(Vec::new()))
        );
        assert_eq!(JobKind::parse("l4a_summary"), Some(JobKind::L4ASummary));
        assert_eq!(
            JobKind::parse("set_initiative_dirs"),
            Some(JobKind::SetInitiativeDirs(Vec::new()))
        );
        assert_eq!(JobKind::parse("decision_writeback"), None);
        assert_eq!(JobKind::parse("propose_revision"), None);
        assert_eq!(JobKind::parse("adopt_draft"), None);
        assert_eq!(JobKind::parse("archive_initiative"), None);
        assert_eq!(JobKind::parse("reopen_initiative"), None);
        assert_eq!(JobKind::parse("diff"), None);
        assert_eq!(JobKind::parse("metadata_reconcile"), None);
        assert_eq!(JobKind::parse("checkpoint_commit"), None);
    }

    #[test]
    fn job_state_strings_four_states() {
        assert_eq!(JobState::Queued.as_str(), "queued");
        assert_eq!(JobState::Running.as_str(), "running");
        assert_eq!(JobState::Completed.as_str(), "completed");
        assert_eq!(JobState::Failed.as_str(), "failed");
        assert!(JobState::Queued.is_active());
        assert!(!JobState::Completed.is_active());
    }

    #[test]
    fn job_ids_are_unique() {
        let first = new_job_id();
        let second = new_job_id();
        assert_ne!(first, second);
        assert!(first.starts_with("job_"));
    }

    #[test]
    fn request_json_roundtrip_covers_all_kinds() {
        let kinds = vec![
            JobKind::VerifyAll,
            JobKind::ChangedPaths(vec!["a.md".to_owned(), "b.md".to_owned()]),
            JobKind::L4ASummary,
            JobKind::SetInitiativeDirs(vec!["BOM与图纸联动方案".to_owned()]),
            JobKind::DecisionWriteback {
                statement_id: "stmt_x".to_owned(),
                decision: "决定A".to_owned(),
                confirmer: "张三".to_owned(),
                role: Some("架构组".to_owned()),
                effective_scope: None,
                effective_date: Some("2026-11-18".to_owned()),
                note: None,
            },
            JobKind::Diff {
                file_id: "f_1".to_owned(),
                baseline_revision_id: "f_1_r1".to_owned(),
                target_revision_id: "f_1_r2".to_owned(),
            },
            JobKind::ProposeRevision {
                file_id: "f_1".to_owned(),
                base_revision_id: "f_1_r1".to_owned(),
                content: "# 新内容".to_owned(),
                note: Some("备注".to_owned()),
                input_context_hashes: vec!["sha256:0123456789abcdef".to_owned()],
                receipt_summary: Some("已按规范更新".to_owned()),
            },
            JobKind::AdoptDraft {
                draft_id: "draft_x".to_owned(),
            },
            JobKind::DismissDraft {
                draft_id: "draft_y".to_owned(),
                reason: Some("请保留原有表格列".to_owned()),
            },
            JobKind::ArchiveInitiative {
                initiative_id: "init_x".to_owned(),
                note: None,
            },
            JobKind::ReopenInitiative {
                initiative_id: "init_x".to_owned(),
            },
        ];
        for kind in kinds {
            let json = kind.to_request_json();
            let rebuilt =
                JobKind::from_request_json(&json).unwrap_or_else(|| panic!("重建失败：{json}"));
            assert_eq!(rebuilt.as_str(), kind.as_str());
        }
    }

    #[test]
    fn merge_tags_only_for_verified_kinds() {
        assert!(JobKind::VerifyAll.merge_tag().is_some());
        assert!(JobKind::ChangedPaths(vec![]).merge_tag().is_some());
        assert!(JobKind::SetInitiativeDirs(vec![]).merge_tag().is_some());
        assert!(JobKind::L4ASummary.merge_tag().is_none());
        assert!(JobKind::DecisionWriteback {
            statement_id: String::new(),
            decision: String::new(),
            confirmer: String::new(),
            role: None,
            effective_scope: None,
            effective_date: None,
            note: None,
        }
        .merge_tag()
        .is_none());
        assert!(JobKind::Diff {
            file_id: String::new(),
            baseline_revision_id: String::new(),
            target_revision_id: String::new(),
        }
        .merge_tag()
        .is_none());
        assert!(JobKind::ProposeRevision {
            file_id: String::new(),
            base_revision_id: String::new(),
            content: String::new(),
            note: None,
            input_context_hashes: Vec::new(),
            receipt_summary: None,
        }
        .merge_tag()
        .is_none());
    }

    #[test]
    fn changed_paths_never_merges_into_already_running_job() {
        let (sender, _rx) = mpsc::channel::<JobCommand>();
        let mgr = IndexJobManager {
            sender,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(None)),
            queued: Arc::new(Mutex::new(Vec::new())),
            shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            writer_thread: Arc::new(Mutex::new(None)),
        };

        let (id1, merged1, _) = mgr.submit_kind(JobKind::ChangedPaths(vec!["a.md".to_owned()]));
        assert!(!merged1);
        {
            let mut guard = mgr.jobs.lock().unwrap();
            let job = guard.get_mut(&id1).unwrap();
            job.state = JobState::Running;
        }

        let (id2, merged2, _) = mgr.submit_kind(JobKind::ChangedPaths(vec!["a.md".to_owned()]));
        assert!(!merged2);
        assert_ne!(id1, id2);

        let (id3, merged3, _) = mgr.submit_kind(JobKind::ChangedPaths(vec![
            "a.md".to_owned(),
            "b.md".to_owned(),
        ]));
        assert!(merged3);
        assert_eq!(id3, id2);
        let guard = mgr.jobs.lock().unwrap();
        assert_eq!(
            guard.get(&id2).unwrap().kind,
            JobKind::ChangedPaths(vec!["a.md".to_owned(), "b.md".to_owned()])
        );
    }

    #[test]
    fn shutdown_aborts_in_flight_large_verify_all_promptly() {
        use std::io::Write;
        struct CleanupDir(std::path::PathBuf);
        impl Drop for CleanupDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let base = CleanupDir(std::env::temp_dir().join(format!(
            "guanlan-jobs-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
        let ws = base.0.join("ws");
        let data = base.0.join("data");
        std::fs::create_dir_all(&ws).expect("建工作区");
        let chunk = vec![0xA5u8; 1024 * 1024];
        for i in 0..6 {
            let mut f =
                std::fs::File::create(ws.join(format!("clip_{i:02}.mp4"))).expect("建大文件");
            for _ in 0..16 {
                f.write_all(&chunk).expect("写大文件");
            }
        }

        let writer = Writer::open_at(&data, &ws.to_string_lossy()).expect("打开可写库");
        let mgr = IndexJobManager::start(writer);
        let (job_id, _, _) = mgr.submit_kind(JobKind::VerifyAll);

        let wait_start = std::time::Instant::now();
        while wait_start.elapsed() < std::time::Duration::from_secs(3) {
            if mgr
                .get(&job_id)
                .is_some_and(|job| job.state == JobState::Running)
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let shutdown_start = std::time::Instant::now();
        mgr.shutdown();
        let elapsed_ms = shutdown_start.elapsed().as_millis();

        let job = mgr.get(&job_id).expect("任务快照仍在");
        assert!(
            job.cancelled && job.phase == "cancelled",
            "停机期间正在跑的大目录 VerifyAll 必须被协作中止，而非跑完（state={:?} phase={} elapsed={}ms）",
            job.state,
            job.phase,
            elapsed_ms
        );
        assert!(
            elapsed_ms < 1000,
            "协作取消后 shutdown 应在 1s 内返回，实测 {elapsed_ms}ms"
        );
    }
}
