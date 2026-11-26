//! 索引与对账：采集、稳定读取、对账、陈述与引用抽取。
//!
//! 这里是**唯一写入路径**：把工作区目录与持久库对账，写入版本、
//! 事件与证据。语义与既有 TS 管线（`server/reconcile.ts` + `server/derive.ts`）
//! 逐字对齐——同一套表、同一套身份规则、同一套事件去重身份。契约 §2.1 第 2 条
//! 明令「不生成第二套历史」：任何身份公式的偏差都会让库里出现两套事实。
//!
//! 写入顺序（契约 §0）：
//! 稳定读取 → 保存并校验内容快照 → 事务提交版本与事件及证据 → 发出更新通知。
//!
//! 与 TS 的两处有意差异：
//! - **未变文件批量提交**：TS 对每个未变文件各开一次事务（2709 个文件 = 2709 次
//!   事务）；这里合并成一次，取消逐文件独立事务以降低写事务开销。
//! - **目录项按名排序**：TS 用 OS 目录序；这里按名排序，保证扫描顺序可复现。

pub mod clock;
pub mod collector;
pub mod decision_block;
pub mod derive;
pub mod file_format;
pub mod file_ops;
pub mod ident;
pub mod ignore;
pub mod office;
pub mod pdf;
pub mod search_index;
pub mod state_engine;
pub mod state_machine;
pub mod writeback;
pub mod writer;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use rusqlite::params;

use crate::domain::{normalize_rel_path, revision_id_of, stable_file_id};
use crate::dto::WorkspaceRecord;
use crate::error::GuanlanError;
use crate::storage::{FileRow, RevisionRow, StatementRow};

use collector::CollectedFile;
use derive::{derive_document_time, derive_edges, derive_statements, DeriveInput};
pub use file_format::{FileFormat, FormatClass, SnapshotPolicy, SnapshotTier};
pub use file_ops::{
    batch_move_files, batch_trash_files_with, create_document, create_folder, move_file,
    move_folder, rename_file, rename_folder, trash_file, trash_folder, trash_folder_with,
    BatchMoveFilesInput, BatchTrashFilesInput, CreateDocumentInput, CreateFolderInput,
    MoveFileInput, MoveFolderInput, RenameFileInput, RenameFolderInput, TrashFileInput,
    TrashFolderInput,
};
use ident::{detect_role, folder_from_path, stable_short, title_from_path};
pub use state_engine::{
    commit_checkpoint, state_machine_recompute, CheckpointCommitOutcome, DerivedChecklist,
    RecomputeOutcome, Transition,
};
pub use state_machine::{
    derive_checklist, estimate_tokens, next_artifact_state, slot_state, DocState, NodeState,
    SlotKind, SlotRules, Stage, StateSignals,
};
pub use writeback::{
    apply_decision_writeback, ensure_not_archived, CasConflict, WritebackInput, WritebackOutcome,
};
pub use writer::{CheckpointInput, NewEvent, SnapshotOutcome, Writer, EXTRACT_RULE_VERSION};

/// 对账选项
#[derive(Debug, Clone)]
pub struct ReconcileOptions {
    /// 额外排除的目录名
    pub excluded_dirs: Vec<String>,
    /// 文件数上限
    pub max_files: usize,
    /// 目录深度上限
    pub max_depth: usize,
    /// 注入采集时刻（测试重放用）
    pub observed_at: Option<String>,
    /// 快照配额策略（三档存储策略：文本 <10MB / 二进制 <50MB 全量快照，
    /// 音视频与未知二进制只记元数据）。为 `None` 时自动按「环境变量 → 工作区 `meta`
    /// → 默认 10MB/50MB」结算。
    pub snapshot_policy: Option<SnapshotPolicy>,
    /// 协作式取消标志（服务停机/切换工作区/用户取消任务时置 true）。
    /// 仅在采集、身份规划、事务外快照写入等阶段间隙生效；进入 SQLite 事务提交点后不再中断。
    pub cancel: Option<Arc<AtomicBool>>,
}

impl Default for ReconcileOptions {
    fn default() -> Self {
        Self {
            excluded_dirs: Vec::new(),
            max_files: collector::DEFAULT_MAX_FILES,
            max_depth: collector::DEFAULT_MAX_DEPTH,
            observed_at: None,
            snapshot_policy: None,
            cancel: None,
        }
    }
}

impl ReconcileOptions {
    /// 当前是否已请求协作式取消
    pub fn is_cancelled(&self) -> bool {
        self.cancel
            .as_deref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
    }

    /// 按环境变量覆盖采集上限与快照阈值。
    ///
    /// - `GUANLAN_MAX_FILES`：文件数上限。**触顶即视为范围不完整**——不判缺失，
    ///   但范围外的文件这轮进不来（工作区比上限大时要调高）。
    /// - `GUANLAN_MAX_DEPTH`：目录深度上限（根目录算第 0 层）。
    /// - `GUANLAN_SNAPSHOT_TEXT_MAX_MB` / `GUANLAN_SNAPSHOT_BINARY_MAX_MB`：
    ///   三档快照阈值（默认 10MB / 50MB），可按工作区上调；仅当显式设置时覆盖工作区配置。
    pub fn from_env() -> Self {
        let mut options = Self::default();
        if let Some(value) = read_env_usize("GUANLAN_MAX_FILES") {
            if value > 0 {
                options.max_files = value;
            }
        }
        if let Some(value) = read_env_usize("GUANLAN_MAX_DEPTH") {
            if value > 0 {
                options.max_depth = value;
            }
        }
        if SnapshotPolicy::env_override_present() {
            options.snapshot_policy = Some(SnapshotPolicy::from_env());
        }
        options
    }
}

fn read_env_usize(key: &str) -> Option<usize> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
}

/// 对账报告（字段与 TS 的 `ReconcileReport` 一一对应）
#[derive(Debug, Clone, Default)]
pub struct ReconcileReport {
    pub workspace_id: String,
    pub generation: u64,
    pub initial_baseline: bool,
    pub scanned: usize,
    pub by_format: FormatCounts,
    pub new_files: usize,
    pub new_revisions: usize,
    pub unchanged: usize,
    pub mtime_only: usize,
    pub content_changed: usize,
    pub appeared: usize,
    pub missing: usize,
    pub recovered: usize,
    pub unstable_reads: usize,
    pub events_inserted: usize,
    pub events_skipped: usize,
    pub decision_events_inserted: usize,
    pub statements_upserted: usize,
    pub edges_upserted: usize,
    pub snapshots_written: usize,
    /// 本轮「只记元数据不存快照」的版本数（第三档元数据策略与超限降级）
    pub metadata_only_revisions: usize,
    /// 本轮被 `.gitignore` 排除的路径数（诊断用）
    pub ignored_paths: usize,
    pub derived_rebuilt: bool,
    pub backfilled_doc_date_events: usize,
    /// 状态机重算落库行数：initiatives + artifact_states + task_nodes（每轮幂等重算）
    pub state_rows_upserted: usize,
    /// 状态机迁移事件条数（首次建行静默不计）
    pub state_transitions: usize,
    /// 本轮出现新版本的 md 文件 id（L4A 后台沉淀队列入队依据）
    pub changed_file_ids: Vec<String>,
    /// 状态机迁移事件种类（去重，供 SSE `kinds` 字段推送）
    pub state_event_kinds: Vec<String>,
    /// 派生检索索引本轮同步的文档数（含差分同步与全量重建；派生变化不推代际）
    pub search_docs_synced: usize,
    /// 派生检索索引本轮是否全量重建（规则版本不符 / 首建 / 显式重建）
    pub search_index_rebuilt: bool,
    pub duration_ms: u64,
}

/// 各格式文件数。
///
/// 全文件类型采集下格式不再限于三种：`md / svg / pdf` 三个既有计数**逐字保留**
/// （基线事件载荷与既有统计口径不变），其余格式按 token 计入 `by_token`。
#[derive(Debug, Clone, Default)]
pub struct FormatCounts {
    pub md: usize,
    pub svg: usize,
    pub pdf: usize,
    /// 其余格式的 token → 数量（不含 md/svg/pdf）
    pub by_token: std::collections::BTreeMap<String, usize>,
}

impl FormatCounts {
    fn add(&mut self, format: &FileFormat) {
        match format.as_str() {
            "md" => self.md += 1,
            "svg" => self.svg += 1,
            "pdf" => self.pdf += 1,
            other => {
                *self.by_token.entry(other.to_owned()).or_insert(0) += 1;
            }
        }
    }

    /// 全部格式的 token → 数量（含 md/svg/pdf，按数量降序、token 升序）。
    pub fn all_tokens(&self) -> std::collections::BTreeMap<String, usize> {
        let mut out = std::collections::BTreeMap::new();
        if self.md > 0 {
            out.insert("md".to_owned(), self.md);
        }
        if self.svg > 0 {
            out.insert("svg".to_owned(), self.svg);
        }
        if self.pdf > 0 {
            out.insert("pdf".to_owned(), self.pdf);
        }
        for (token, count) in &self.by_token {
            out.insert(token.clone(), *count);
        }
        out
    }
}

#[derive(Debug, Clone)]
struct PendingRevision {
    file: CollectedFile,
    file_id: String,
    is_new_file: bool,
    was_trashed: bool,
    previous_path: Option<String>,
    prev_hash: Option<String>,
    revision: RevisionRow,
}

#[derive(Debug, Clone)]
struct UnchangedUpdate {
    file_id: String,
    rel_path: String,
    mtime_ms: f64,
    revision_id: String,
    recovered: bool,
    was_trashed: bool,
    previous_path: String,
    evidence: String,
}

fn can_claim_file_identity(root: &Path, row: &FileRow, incoming_rel: &str) -> bool {
    let current_norm = normalize_rel_path(&row.current_path);
    let same_path = current_norm == incoming_rel
        || (cfg!(windows) && current_norm.eq_ignore_ascii_case(incoming_rel));
    if same_path {
        return true;
    }
    if row.status == "trashed" {
        return false;
    }
    if row.status == "active" && root.join(&current_norm).is_file() {
        return false;
    }
    true
}

fn allocate_new_file_id(
    writer: &Writer,
    root_key: &str,
    rel_path: &str,
) -> Result<String, GuanlanError> {
    let base = stable_file_id(root_key, rel_path);
    if writer.get_file(&base)?.is_none() {
        return Ok(base);
    }
    for idx in 1u64..10_000 {
        let candidate = stable_file_id(root_key, &format!("{rel_path}#dup{idx}"));
        if writer.get_file(&candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    Err(GuanlanError::Internal(format!(
        "无法为新文件分配唯一 file_id：{rel_path}"
    )))
}

fn check_cancelled(options: &ReconcileOptions, stage: &str) -> Result<(), GuanlanError> {
    if options.is_cancelled() {
        return Err(GuanlanError::Cancelled(format!(
            "任务已取消（阶段：{stage}，事务提交点前安全中止）"
        )));
    }
    Ok(())
}

pub(crate) struct SeenFiles {
    paths: HashSet<String>,
    ids: HashSet<String>,
}

impl SeenFiles {
    pub(crate) fn new(
        paths: impl IntoIterator<Item = String>,
        ids: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            paths: paths.into_iter().collect(),
            ids: ids.into_iter().collect(),
        }
    }

    pub(crate) fn contains(&self, path: &str, file_id: &str) -> bool {
        self.paths.contains(path) || self.ids.contains(file_id)
    }
}

/// 对账一次扫描，写入持久历史
pub fn reconcile(
    writer: &mut Writer,
    options: &ReconcileOptions,
) -> Result<ReconcileReport, GuanlanError> {
    check_cancelled(options, "启动前")?;
    let started = Instant::now();
    let workspace = writer.workspace()?;
    let collected = collector::collect_workspace_cancellable(
        Path::new(&workspace.root_path),
        &options.excluded_dirs,
        options.max_files,
        options.max_depth,
        options.cancel.as_deref(),
    );
    if collected.cancelled || options.is_cancelled() {
        return Err(GuanlanError::Cancelled(
            "任务已取消（阶段：文件采集，事务提交点前安全中止）".to_owned(),
        ));
    }
    reconcile_collected(writer, options, workspace, collected, started)
}

/// 定向对账：只核对给定相对路径（决策回写或草案采纳后的低延迟单路径对账通道，
/// 目标延迟 <200ms；采集范围不完整 → 不判任何文件缺失）。
pub fn reconcile_paths(
    writer: &mut Writer,
    options: &ReconcileOptions,
    paths: &[String],
) -> Result<ReconcileReport, GuanlanError> {
    check_cancelled(options, "启动前")?;
    let started = Instant::now();
    let workspace = writer.workspace()?;
    let collected = collector::collect_specific_paths_cancellable(
        Path::new(&workspace.root_path),
        paths,
        options.cancel.as_deref(),
    );
    if collected.cancelled || options.is_cancelled() {
        return Err(GuanlanError::Cancelled(
            "任务已取消（阶段：定向采集，事务提交点前安全中止）".to_owned(),
        ));
    }
    reconcile_collected(writer, options, workspace, collected, started)
}

#[allow(clippy::too_many_lines)]
fn reconcile_collected(
    writer: &mut Writer,
    options: &ReconcileOptions,
    workspace: WorkspaceRecord,
    collected: collector::CollectResult,
    started: Instant,
) -> Result<ReconcileReport, GuanlanError> {
    let workspace_id = workspace.workspace_id.clone();
    let observed_at = options.observed_at.clone().unwrap_or_else(clock::now_iso);
    let initial_baseline = !writer.has_baseline(&workspace_id)?;
    let effective_policy = options
        .snapshot_policy
        .unwrap_or_else(|| writer.snapshot_policy());

    let mut report = ReconcileReport {
        workspace_id: workspace_id.clone(),
        generation: workspace.index_generation,
        initial_baseline,
        scanned: collected.files.len(),
        ignored_paths: collected.ignored_count,
        ..Default::default()
    };
    for file in &collected.files {
        report.by_format.add(&file.format);
    }

    let mut pending: Vec<PendingRevision> = Vec::new();
    let mut unchanged: Vec<UnchangedUpdate> = Vec::new();
    let workspace_root = Path::new(&workspace.root_path);
    let mut missing_candidates: Vec<FileRow> = writer.list_recovery_candidates(&workspace_id)?;

    for file in &collected.files {
        check_cancelled(options, "身份识别")?;
        let rel_path = normalize_rel_path(&file.relative_path);

        let mut file_row = match writer.find_file_by_path(&workspace_id, &rel_path)? {
            Some(row) => Some(row),
            None => writer
                .resolve_file_by_alias(&workspace_id, &rel_path)?
                .filter(|row| can_claim_file_identity(workspace_root, row, &rel_path)),
        };
        let mut recovered_missing = false;
        let mut is_new_file = false;
        let mut evidence = "exact_path";

        if file_row.is_none() {
            let predicted_id = stable_file_id(&workspace.root_key, &rel_path);
            if let Some(predicted) = writer.get_file(&predicted_id)? {
                if can_claim_file_identity(workspace_root, &predicted, &rel_path) {
                    file_row = Some(predicted);
                    evidence = "same_hash_candidate";
                }
            }
        }

        if file_row.is_none() && file.stable {
            let mut matched: Option<usize> = None;
            let mut hits = 0usize;
            for (index, candidate) in missing_candidates.iter().enumerate() {
                if let Some(revision) = writer.latest_revision(&candidate.file_id)? {
                    if revision.content_hash == file.sha256 {
                        hits += 1;
                        matched = Some(index);
                    }
                }
            }
            if hits == 1 {
                let index = matched.expect("命中数为 1 时必有匹配下标");
                let candidate = missing_candidates.remove(index);
                file_row = Some(candidate);
                recovered_missing = true;
                evidence = "same_hash_candidate";
            }
        }

        if file_row.is_none() {
            is_new_file = true;
        }

        if !file.stable {
            report.unstable_reads += 1;
            continue;
        }

        let file_id = match &file_row {
            Some(row) => row.file_id.clone(),
            None => allocate_new_file_id(writer, &workspace.root_key, &rel_path)?,
        };
        let latest = writer.latest_revision(&file_id)?;

        if let Some(latest) = latest.clone() {
            if latest.content_hash == file.sha256 {
                let row = file_row.as_ref().expect("有最新版本必有文件行");
                let was_trashed = row.status == "trashed";
                let recovered = row.status != "active" || recovered_missing;
                let mtime_moved = row.last_mtime_ms != file.mtime_ms;
                unchanged.push(UnchangedUpdate {
                    file_id: file_id.clone(),
                    rel_path: rel_path.clone(),
                    mtime_ms: file.mtime_ms,
                    revision_id: latest.revision_id.clone(),
                    recovered,
                    was_trashed,
                    previous_path: row.current_path.clone(),
                    evidence: evidence.to_owned(),
                });
                if recovered {
                    report.recovered += 1;
                }
                if mtime_moved {
                    report.mtime_only += 1;
                } else {
                    report.unchanged += 1;
                }
                continue;
            }
        }

        let seq = latest.as_ref().map(|row| row.seq).unwrap_or(0) + 1;
        let tier = effective_policy.tier_for(file.format.class(), file.size_bytes);
        let snapshot_available = if tier.stores_bytes() { 1 } else { 0 };
        pending.push(PendingRevision {
            file: file.clone(),
            file_id: file_id.clone(),
            is_new_file,
            was_trashed: file_row
                .as_ref()
                .map(|row| row.status == "trashed")
                .unwrap_or(false),
            previous_path: file_row.as_ref().map(|row| row.current_path.clone()),
            prev_hash: latest.as_ref().map(|row| row.content_hash.clone()),
            revision: RevisionRow {
                revision_id: revision_id_of(&file_id, seq),
                file_id: file_id.clone(),
                workspace_id: workspace_id.clone(),
                seq,
                prev_revision_id: latest.as_ref().map(|row| row.revision_id.clone()),
                content_hash: file.sha256.clone(),
                size_bytes: file.size_bytes,
                observed_at: observed_at.clone(),
                occurred_at: None,
                occurred_precision: "unknown".to_owned(),
                occurred_source: None,
                snapshot_hash: file.sha256.clone(),
                snapshot_available,
                extract_rule_version: EXTRACT_RULE_VERSION.to_owned(),
            },
        });
        if is_new_file {
            report.new_files += 1;
        } else if recovered_missing || file_row.as_ref().is_some_and(|row| row.status != "active") {
            report.recovered += 1;
        }
    }

    let mut unstable_during_write: Vec<String> = Vec::new();
    for plan in &mut pending {
        check_cancelled(options, "写入快照")?;
        if plan.revision.snapshot_available == 0 {
            report.metadata_only_revisions += 1;
        } else {
            let outcome = writer
                .write_snapshot_to_disk(&plan.file.absolute_path, &plan.revision.content_hash)?;
            match outcome {
                SnapshotOutcome::Written => report.snapshots_written += 1,
                SnapshotOutcome::Existing => {}
                SnapshotOutcome::Unstable => {
                    unstable_during_write.push(normalize_rel_path(&plan.file.relative_path));
                    continue;
                }
            }
        }

        let mtime_iso = clock::iso_from_epoch_millis(plan.file.mtime_ms.trunc() as i64);
        if plan.revision.seq > 1 {
            plan.revision.occurred_at = Some(mtime_iso);
            plan.revision.occurred_precision = "second".to_owned();
            plan.revision.occurred_source = Some("file_mtime".to_owned());
        } else if plan.file.format.is_markdown() {
            let content = writer
                .read_snapshot(&plan.revision.content_hash)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            let self_time = derive_document_time(&content);
            match self_time.occurred_at {
                Some(occurred_at) => {
                    plan.revision.occurred_at = Some(occurred_at);
                    plan.revision.occurred_precision = self_time.precision;
                    plan.revision.occurred_source = self_time.source;
                }
                None => {
                    plan.revision.occurred_at = Some(mtime_iso);
                    plan.revision.occurred_precision = "second".to_owned();
                    plan.revision.occurred_source = Some("file_mtime".to_owned());
                }
            }
        } else {
            plan.revision.occurred_at = Some(mtime_iso);
            plan.revision.occurred_precision = "second".to_owned();
            plan.revision.occurred_source = Some("file_mtime".to_owned());
        }
    }

    if !unstable_during_write.is_empty() {
        report.unstable_reads += unstable_during_write.len();
        let dropped_new_files = pending
            .iter()
            .filter(|plan| {
                plan.is_new_file
                    && unstable_during_write.contains(&normalize_rel_path(&plan.file.relative_path))
            })
            .count();
        report.new_files = report.new_files.saturating_sub(dropped_new_files);
        pending.retain(|plan| {
            !unstable_during_write.contains(&normalize_rel_path(&plan.file.relative_path))
        });
    }

    check_cancelled(options, "事务提交前")?;
    let mut path_index: HashMap<String, String> = HashMap::new();
    for (current_path, file_id) in writer.all_path_ids(&workspace_id)? {
        path_index.insert(normalize_rel_path(&current_path), file_id);
    }
    for plan in &pending {
        path_index.insert(
            normalize_rel_path(&plan.file.relative_path),
            plan.file_id.clone(),
        );
    }

    let collected_complete = collected.complete;
    let missing_files = if collected_complete {
        Some(writer.list_files(&workspace_id, false)?)
    } else {
        None
    };
    let seen = SeenFiles::new(
        collected
            .files
            .iter()
            .map(|file| normalize_rel_path(&file.relative_path)),
        pending.iter().map(|plan| plan.file_id.clone()),
    );

    let mut new_statements: Vec<StatementRow> = Vec::new();
    let mut derived_statements = 0usize;
    let mut derived_edges = 0usize;
    let mut derived_checklists: Vec<DerivedChecklist> = Vec::new();

    writer.transaction(|writer| {
        for update in &unchanged {
            writer.touch_file(
                &update.file_id,
                &observed_at,
                update.mtime_ms,
                &update.revision_id,
            )?;
            if update.recovered {
                writer.mark_file_status(&update.file_id, "active")?;
                let prev_norm = normalize_rel_path(&update.previous_path);
                if prev_norm != update.rel_path && !workspace_root.join(&prev_norm).is_file() {
                    let next_title = title_from_path(&update.rel_path);
                    let fmt = writer
                        .get_file(&update.file_id)?
                        .map(|r| r.format)
                        .unwrap_or_else(|| "md".to_owned());
                    let next_role = detect_role(&update.rel_path, &next_title, &fmt);
                    writer.update_file_path_identity(
                        &update.file_id,
                        &update.rel_path,
                        &next_title,
                        next_role,
                        &observed_at,
                        update.mtime_ms,
                    )?;
                }
                writer.upsert_alias(
                    &workspace_id,
                    &update.rel_path,
                    &update.file_id,
                    &observed_at,
                    &update.evidence,
                )?;
                let base_event_id = format!("evt_recovered_{}", update.file_id);
                let event_id = if update.was_trashed && writer.event_exists(&base_event_id)? {
                    format!("{base_event_id}_{}", stable_short(&observed_at))
                } else {
                    base_event_id
                };
                let (headline, detail) = if update.was_trashed {
                    (
                        format!("从回收站还原重连：{}", update.rel_path),
                        format!(
                            "{} 已从系统回收站还原并自动重连原 file_id（{}），历史版本链、关联决定与阅读进度全部连续。",
                            update.rel_path, update.file_id
                        ),
                    )
                } else {
                    (
                        format!("路径恢复可访问：{}", update.previous_path),
                        format!(
                            "{} 重新出现在完整扫描中；已有版本与决策依据仍可访问。",
                            update.rel_path
                        ),
                    )
                };
                let event = NewEvent {
                    event_id,
                    workspace_id: workspace_id.clone(),
                    kind: "read_recovered".to_owned(),
                    subject_kind: "file".to_owned(),
                    subject_id: update.file_id.clone(),
                    revision_id: Some(update.revision_id.clone()),
                    occurred_at: if update.was_trashed {
                        Some(observed_at.clone())
                    } else {
                        None
                    },
                    occurred_precision: if update.was_trashed {
                        "second".to_owned()
                    } else {
                        "unknown".to_owned()
                    },
                    occurred_source: if update.was_trashed {
                        Some("collector".to_owned())
                    } else {
                        None
                    },
                    observed_at: observed_at.clone(),
                    headline,
                    detail,
                    payload_json: derive::json_object(&[
                        ("path", derive::json_string(&update.rel_path)),
                        ("file_id", derive::json_string(&update.file_id)),
                        (
                            "from_trash",
                            if update.was_trashed {
                                "true".to_owned()
                            } else {
                                "false".to_owned()
                            },
                        ),
                    ]),
                    batch_id: None,
                };
                if writer.insert_event(&event)? {
                    report.events_inserted += 1;
                } else {
                    report.events_skipped += 1;
                }
            }
        }

        for plan in &pending {
            let rel_path = normalize_rel_path(&plan.file.relative_path);
            let title = title_from_path(&rel_path);
            if plan.is_new_file {
                writer.insert_file(&FileRow {
                    file_id: plan.file_id.clone(),
                    workspace_id: workspace_id.clone(),
                    current_path: rel_path.clone(),
                    format: plan.file.format.as_str().to_owned(),
                    title: title.clone(),
                    role: detect_role(&rel_path, &title, plan.file.format.as_str()).to_owned(),
                    first_observed_at: observed_at.clone(),
                    last_observed_at: observed_at.clone(),
                    last_mtime_ms: plan.file.mtime_ms,
                    last_revision_id: Some(plan.revision.revision_id.clone()),
                    status: "active".to_owned(),
                })?;
            } else {
                writer.mark_file_status(&plan.file_id, "active")?;
                if let Some(prev) = &plan.previous_path {
                    let prev_norm = normalize_rel_path(prev);
                    if prev_norm != rel_path && !workspace_root.join(&prev_norm).is_file() {
                        let role = detect_role(&rel_path, &title, plan.file.format.as_str());
                        writer.update_file_path_identity(
                            &plan.file_id,
                            &rel_path,
                            &title,
                            role,
                            &observed_at,
                            plan.file.mtime_ms,
                        )?;
                    }
                }
                if plan.was_trashed {
                    let base_event_id = format!("evt_recovered_{}", plan.file_id);
                    let event_id = if writer.event_exists(&base_event_id)? {
                        format!("{base_event_id}_{}", stable_short(&observed_at))
                    } else {
                        base_event_id
                    };
                    if writer.insert_event(&NewEvent {
                        event_id,
                        workspace_id: workspace_id.clone(),
                        kind: "read_recovered".to_owned(),
                        subject_kind: "file".to_owned(),
                        subject_id: plan.file_id.clone(),
                        revision_id: Some(plan.revision.revision_id.clone()),
                        occurred_at: Some(observed_at.clone()),
                        occurred_precision: "second".to_owned(),
                        occurred_source: Some("collector".to_owned()),
                        observed_at: observed_at.clone(),
                        headline: format!("从回收站还原重连：{rel_path}"),
                        detail: format!(
                            "{rel_path} 已从系统回收站还原并自动重连原 file_id（{}）。",
                            plan.file_id
                        ),
                        payload_json: derive::json_object(&[
                            ("path", derive::json_string(&rel_path)),
                            ("file_id", derive::json_string(&plan.file_id)),
                            ("from_trash", "true".to_owned()),
                        ]),
                        batch_id: None,
                    })? {
                        report.events_inserted += 1;
                    }
                }
            }
            writer.upsert_alias(
                &workspace_id,
                &rel_path,
                &plan.file_id,
                &observed_at,
                "exact_path",
            )?;

            if plan.revision.snapshot_available != 0 {
                writer.register_blob_ref(&plan.revision.content_hash, plan.revision.size_bytes)?;
            }
            writer.insert_revision(&plan.revision)?;
            writer.touch_file(
                &plan.file_id,
                &observed_at,
                plan.file.mtime_ms,
                &plan.revision.revision_id,
            )?;
            report.new_revisions += 1;

            let kind = if plan.is_new_file {
                "appeared"
            } else {
                "modified"
            };

            let dated_by_self = plan.revision.occurred_source.as_deref() == Some("document_self");
            let skip_baseline_per_file_event =
                initial_baseline && plan.is_new_file && !dated_by_self;

            if !skip_baseline_per_file_event {
                let changed = match (&plan.prev_hash, kind) {
                    (Some(prev_hash), "modified") => {
                        if plan.revision.snapshot_available == 0 {
                            ChangeSummary {
                                changed_sections: vec!["仅记录元数据与哈希变化".to_owned()],
                                added: 0,
                                removed: 0,
                            }
                        } else if plan.file.format.is_utf8_text()
                            || (plan.file.format.as_str() == "pdf"
                                && plan.revision.size_bytes <= 256 * 1024)
                        {
                            let prev_text = writer
                                .read_snapshot(prev_hash)
                                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
                            let new_text = writer
                                .read_snapshot(&plan.revision.content_hash)
                                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
                            summarize_change(
                                prev_text.as_deref(),
                                new_text.as_deref(),
                                plan.file.format.as_str(),
                            )
                        } else {
                            ChangeSummary {
                                changed_sections: vec!["二进制内容变化".to_owned()],
                                added: 0,
                                removed: 0,
                            }
                        }
                    }
                    _ => ChangeSummary::default(),
                };

                let headline = if plan.is_new_file {
                    if dated_by_self {
                        format!(
                            "文档自述日期：{}（{}）",
                            title,
                            plan.revision.occurred_at.as_deref().unwrap_or("")
                        )
                    } else {
                        format!("新出现：{rel_path}")
                    }
                } else {
                    format!("{title} 检测到更新（v{}）", plan.revision.seq)
                };

                let detail = if plan.is_new_file {
                    if dated_by_self {
                        format!(
                            "正文明确记载日期 {}；观澜于 {} 采集到该版本。未补零点时刻。",
                            plan.revision.occurred_at.as_deref().unwrap_or(""),
                            clock::date_part(&observed_at)
                        )
                    } else {
                        format!("完整基线建立后出现此前不存在的路径 {rel_path}")
                    }
                } else if !changed.changed_sections.is_empty() {
                    format!("变更章节：{}", changed.changed_sections.join("、"))
                } else {
                    format!("内容哈希变化（+{}/-{} 行）", changed.added, changed.removed)
                };

                let time_basis = if plan.is_new_file {
                    if dated_by_self {
                        "document_self"
                    } else {
                        "file_mtime"
                    }
                } else {
                    "collector"
                };

                let payload = derive::json_object(&[
                    ("path", derive::json_string(&rel_path)),
                    ("format", derive::json_string(plan.file.format.as_str())),
                    ("size_bytes", plan.revision.size_bytes.to_string()),
                    (
                        "content_hash",
                        derive::json_string(&plan.revision.content_hash),
                    ),
                    ("mtime_ms", format_millis(plan.file.mtime_ms)),
                    ("time_basis", derive::json_string(time_basis)),
                    (
                        "changed_sections",
                        derive::json_array(&changed.changed_sections),
                    ),
                    ("added_lines", changed.added.to_string()),
                    ("removed_lines", changed.removed.to_string()),
                ]);

                let event = NewEvent {
                    event_id: format!("evt_{kind}_{}", plan.revision.revision_id),
                    workspace_id: workspace_id.clone(),
                    kind: kind.to_owned(),
                    subject_kind: "revision".to_owned(),
                    subject_id: plan.revision.revision_id.clone(),
                    revision_id: Some(plan.revision.revision_id.clone()),
                    occurred_at: plan.revision.occurred_at.clone(),
                    occurred_precision: plan.revision.occurred_precision.clone(),
                    occurred_source: plan.revision.occurred_source.clone(),
                    observed_at: observed_at.clone(),
                    headline,
                    detail,
                    payload_json: payload,
                    batch_id: None,
                };
                if writer.insert_event(&event)? {
                    report.events_inserted += 1;
                } else {
                    report.events_skipped += 1;
                }

                if plan.is_new_file {
                    report.appeared += 1;
                }
            }
            if !plan.is_new_file {
                report.content_changed += 1;
            }
            if plan.file.format.is_markdown() {
                report.changed_file_ids.push(plan.file_id.clone());
            }
        }

        if let Some(missing_files) = &missing_files {
            for row in missing_files {
                let current_path = normalize_rel_path(&row.current_path);
                if seen.contains(&current_path, &row.file_id) {
                    continue;
                }
                writer.mark_file_status(&row.file_id, "missing")?;
                report.missing += 1;
                let event = NewEvent {
                    event_id: format!(
                        "evt_missing_{}_{}",
                        row.file_id,
                        clock::date_part(&observed_at)
                    ),
                    workspace_id: workspace_id.clone(),
                    kind: "missing".to_owned(),
                    subject_kind: "file".to_owned(),
                    subject_id: row.file_id.clone(),
                    revision_id: row.last_revision_id.clone(),
                    occurred_at: None,
                    occurred_precision: "unknown".to_owned(),
                    occurred_source: None,
                    observed_at: observed_at.clone(),
                    headline: format!("路径在本轮完整扫描中不可访问：{}", row.current_path),
                    detail: "范围完整遍历后确认该路径消失；已有版本与决策依据仍可查阅。".to_owned(),
                    payload_json: derive::json_object(&[(
                        "path",
                        derive::json_string(&row.current_path),
                    )]),
                    batch_id: None,
                };
                if writer.insert_event(&event)? {
                    report.events_inserted += 1;
                } else {
                    report.events_skipped += 1;
                }
            }
        }

        Ok(())
    })?;

    let dated_self_count = pending
        .iter()
        .filter(|plan| {
            plan.is_new_file && plan.revision.occurred_source.as_deref() == Some("document_self")
        })
        .count();
    writer.transaction(|writer| {
        if initial_baseline {
            let mut detail = format!(
                "{} 份 MD、{} 份 SVG、{} 份 PDF。",
                report.by_format.md, report.by_format.svg, report.by_format.pdf
            );
            let other_total: usize = report
                .by_format
                .by_token
                .values()
                .copied()
                .filter(|count| *count > 0)
                .sum();
            if other_total > 0 {
                let mut parts: Vec<String> = Vec::new();
                for (token, count) in &report.by_format.by_token {
                    if *count > 0 {
                        parts.push(format!("{count} 份 {token}"));
                    }
                }
                detail.push_str(&format!("另有 {} 份其它格式（{}）。", other_total, parts.join("、")));
            }
            detail.push_str(&if dated_self_count > 0 {
                format!(
                    "其中 {dated_self_count} 份按正文自述日期单独入轴；其余 {} 份只有采集依据，归在本卡。单文件基线版本可逐一查看。",
                    collected.files.len() - dated_self_count
                )
            } else {
                "本批材料没有可核验的正文日期，全部只按采集时间记录。单文件基线版本可逐一查看。"
                    .to_owned()
            });
            let mut payload_fields: Vec<(&str, String)> = vec![
                ("total", collected.files.len().to_string()),
                ("md", report.by_format.md.to_string()),
                ("svg", report.by_format.svg.to_string()),
                ("pdf", report.by_format.pdf.to_string()),
                ("dated_by_document_self", dated_self_count.to_string()),
            ];
            for (token, count) in &report.by_format.by_token {
                payload_fields.push((token.as_str(), count.to_string()));
            }
            let payload = derive::json_object(&payload_fields);
            let event = NewEvent {
                event_id: format!("evt_baseline_{workspace_id}"),
                workspace_id: workspace_id.clone(),
                kind: "workspace_baseline".to_owned(),
                subject_kind: "workspace".to_owned(),
                subject_id: workspace_id.clone(),
                revision_id: None,
                occurred_at: Some(clock::date_part(&observed_at)),
                occurred_precision: "day".to_owned(),
                occurred_source: Some("collector".to_owned()),
                observed_at: observed_at.clone(),
                headline: format!("首次纳入 {} 份资料", collected.files.len()),
                detail,
                payload_json: payload,
                batch_id: None,
            };
            if writer.insert_event(&event)? {
                report.events_inserted += 1;
            } else {
                report.events_skipped += 1;
            }
        }
        Ok(())
    })?;

    let hour_stamp = clock::hour_stamp(&observed_at);
    let read_errors = collected.read_errors.clone();
    writer.transaction(|writer| {
        for err in &read_errors {
            let event = NewEvent {
                event_id: format!(
                    "evt_read_error_{}_{hour_stamp}",
                    stable_short(&err.relative_path)
                ),
                workspace_id: workspace_id.clone(),
                kind: "read_error".to_owned(),
                subject_kind: "file".to_owned(),
                subject_id: format!("path:{}", err.relative_path),
                revision_id: None,
                occurred_at: None,
                occurred_precision: "unknown".to_owned(),
                occurred_source: None,
                observed_at: observed_at.clone(),
                headline: format!("读取问题：{}", err.relative_path),
                detail: err.message.clone(),
                payload_json: derive::json_object(&[(
                    "path",
                    derive::json_string(&err.relative_path),
                )]),
                batch_id: None,
            };
            if writer.insert_event(&event)? {
                report.events_inserted += 1;
            } else {
                report.events_skipped += 1;
            }
        }
        Ok(())
    })?;

    let mut target_revision_index: HashMap<String, String> = HashMap::new();
    for (file_id, revision_id) in writer.latest_revision_ids()? {
        target_revision_index.insert(file_id, revision_id);
    }

    let mut unstable_paths: Vec<String> = collected
        .files
        .iter()
        .filter(|file| !file.stable)
        .map(|file| normalize_rel_path(&file.relative_path))
        .collect();
    for path in &unstable_during_write {
        if !unstable_paths.contains(path) {
            unstable_paths.push(path.clone());
        }
    }

    let mut office_parsed: HashMap<String, office::OfficeExtractRecord> = HashMap::new();
    let mut office_newly_cached: HashMap<String, office::OfficeExtractRecord> = HashMap::new();
    for plan in &pending {
        if !plan.file.format.is_office_structured() {
            continue;
        }
        let hash = &plan.revision.content_hash;
        if office_parsed.contains_key(hash) {
            continue;
        }
        if let Some(hit) = writer.get_office_extract_json(hash, writer::EXTRACT_RULE_VERSION)? {
            if let Ok(mut cached) =
                serde_json::from_str::<office::OfficeExtractRecord>(&hit.extract_json)
            {
                cached.status = hit.status;
                cached.error_reason = hit.error_reason;
                cached.plain_text = hit.plain_text;
                office_parsed.insert(hash.clone(), cached);
                continue;
            }
        }
        let record = if plan.revision.snapshot_available == 0 {
            office::OfficeExtractRecord::metadata_only(
                plan.file.format.as_str(),
                "文件超出快照阈值，按 L0 元数据入库，不加载全文到内存",
            )
        } else if let Some(bytes) = writer.read_snapshot(hash) {
            office::extract_office_from_bytes(plan.file.format.as_str(), &bytes)
        } else {
            office::OfficeExtractRecord::metadata_only(
                plan.file.format.as_str(),
                "快照文件不可用，已降级为 L0 元数据卡",
            )
        };
        office_newly_cached.insert(hash.clone(), record.clone());
        office_parsed.insert(hash.clone(), record);
    }

    let mut pdf_parsed: HashMap<String, pdf::PdfExtractRecord> = HashMap::new();
    let mut pdf_newly_cached: HashMap<String, pdf::PdfExtractRecord> = HashMap::new();
    for plan in &pending {
        if plan.file.format.as_str() != "pdf" {
            continue;
        }
        let hash = &plan.revision.content_hash;
        if pdf_parsed.contains_key(hash) {
            continue;
        }
        if let Some(hit) = writer.get_pdf_extract_json(hash, writer::EXTRACT_RULE_VERSION)? {
            if let Ok(mut cached) = serde_json::from_str::<pdf::PdfExtractRecord>(&hit.extract_json)
            {
                cached.status = hit.status;
                cached.error_reason = hit.error_reason;
                cached.plain_text = hit.plain_text;
                pdf_parsed.insert(hash.clone(), cached);
                continue;
            }
        }
        let record = if plan.revision.snapshot_available == 0 {
            pdf::PdfExtractRecord::metadata_only(
                "文件超出快照阈值，按 L0 元数据入库，不加载全文到内存",
            )
        } else if let Some(bytes) = writer.read_snapshot(hash) {
            pdf::extract_pdf_from_bytes(&bytes)
        } else {
            pdf::PdfExtractRecord::metadata_only("快照文件不可用，已降级为 L0 元数据卡")
        };
        pdf_newly_cached.insert(hash.clone(), record.clone());
        pdf_parsed.insert(hash.clone(), record);
    }

    writer.transaction(|writer| {
        for (hash, record) in &office_newly_cached {
            let extract_json = serde_json::to_string(record).unwrap_or_else(|_| "{}".to_owned());
            writer.upsert_office_extract(
                hash,
                &record.format,
                &record.status,
                record.error_reason.as_deref(),
                &extract_json,
                &record.plain_text,
                writer::EXTRACT_RULE_VERSION,
                &observed_at,
            )?;
        }

        for (hash, record) in &pdf_newly_cached {
            let extract_json = serde_json::to_string(record).unwrap_or_else(|_| "{}".to_owned());
            writer.upsert_pdf_extract(
                hash,
                &record.status,
                record.error_reason.as_deref(),
                record.page_count,
                &extract_json,
                &record.plain_text,
                writer::EXTRACT_RULE_VERSION,
                &observed_at,
            )?;
        }

        for plan in &pending {
            let rel_path = normalize_rel_path(&plan.file.relative_path);
            if plan.file.format.is_office_structured() {
                if let Some(record) = office_parsed.get(&plan.revision.content_hash) {
                    for statement in office::derive_office_statements(
                        &workspace_id,
                        &plan.file_id,
                        &plan.revision.revision_id,
                        &rel_path,
                        &observed_at,
                        record,
                    ) {
                        writer.upsert_statement(&statement)?;
                        derived_statements += 1;
                        new_statements.push(statement);
                    }
                }
                continue;
            }
            if plan.file.format.as_str() == "pdf" {
                if let Some(record) = pdf_parsed.get(&plan.revision.content_hash) {
                    for statement in pdf::derive_pdf_statements(
                        &workspace_id,
                        &plan.file_id,
                        &plan.revision.revision_id,
                        &rel_path,
                        &observed_at,
                        record,
                    ) {
                        writer.upsert_statement(&statement)?;
                        derived_statements += 1;
                        new_statements.push(statement);
                    }
                }
                continue;
            }
            if !plan.file.format.is_markdown() {
                continue;
            }
            let Some(bytes) = writer.read_snapshot(&plan.revision.content_hash) else {
                continue;
            };
            let content = String::from_utf8_lossy(&bytes).into_owned();
            let (checklist_done, checklist_total) = derive_checklist(&content);
            derived_checklists.push(DerivedChecklist {
                file_id: plan.file_id.clone(),
                done: checklist_done,
                total: checklist_total,
            });
            let input = DeriveInput {
                workspace_id: &workspace_id,
                file_id: &plan.file_id,
                revision_id: &plan.revision.revision_id,
                relative_path: &rel_path,
                folder: &folder_from_path(&rel_path),
                title: &title_from_path(&rel_path),
                format: plan.file.format.as_str(),
                content: &content,
                observed_at: &observed_at,
                root_path: &workspace.root_path,
                path_index: &path_index,
                target_revision_index: &target_revision_index,
            };

            for statement in derive_statements(&input) {
                writer.upsert_statement(&statement)?;
                derived_statements += 1;
                new_statements.push(statement);
            }
            for edge in derive_edges(&input) {
                writer.upsert_edge(&edge)?;
                derived_edges += 1;
            }
        }

        for path in &unstable_paths {
            let event = NewEvent {
                event_id: format!("evt_unstable_{}_{hour_stamp}", stable_short(path)),
                workspace_id: workspace_id.clone(),
                kind: "read_error".to_owned(),
                subject_kind: "file".to_owned(),
                subject_id: format!("path:{path}"),
                revision_id: None,
                occurred_at: None,
                occurred_precision: "unknown".to_owned(),
                occurred_source: None,
                observed_at: observed_at.clone(),
                headline: format!("稳定读取未达成：{path}"),
                detail: "读取期间文件被改写，本轮不落新版本；下轮对账会恢复。".to_owned(),
                payload_json: derive::json_object(&[("path", derive::json_string(path))]),
                batch_id: None,
            };
            if writer.insert_event(&event)? {
                report.events_inserted += 1;
            } else {
                report.events_skipped += 1;
            }
        }

        report.decision_events_inserted +=
            record_decision_events(writer, &workspace_id, &new_statements, &observed_at)?;
        Ok(())
    })?;
    report.statements_upserted += derived_statements;
    report.edges_upserted += derived_edges;

    let rebuilt =
        rebuild_derived_if_needed(writer, &workspace_id, &workspace.root_path, &observed_at)?;
    if rebuilt.rebuilt {
        report.statements_upserted += rebuilt.statements;
        report.edges_upserted += rebuilt.edges;
        report.derived_rebuilt = true;
    }

    report.backfilled_doc_date_events =
        backfill_document_self_events(writer, &workspace_id, &mut report)?;

    let state_outcome =
        state_machine_recompute(writer, &workspace_id, &observed_at, &derived_checklists)?;
    report.events_inserted += state_outcome.events_inserted;
    report.events_skipped += state_outcome.events_skipped;
    report.state_rows_upserted = state_outcome.initiatives_upserted
        + state_outcome.artifacts_upserted
        + state_outcome.nodes_upserted;
    report.state_transitions = state_outcome.transitions.len();
    report.state_event_kinds = {
        let mut kinds: Vec<String> = state_outcome
            .transitions
            .iter()
            .map(|transition| transition.kind.to_owned())
            .collect();
        kinds.sort();
        kinds.dedup();
        kinds
    };

    let search_outcome = search_index::sync_after_reconcile(writer, &workspace_id)?;
    report.search_docs_synced = search_outcome.docs_synced;
    report.search_index_rebuilt = search_outcome.rebuilt;

    let changed = report.new_revisions > 0
        || report.events_inserted > 0
        || report.derived_rebuilt
        || initial_baseline;
    report.generation = if changed {
        writer.bump_generation(&workspace_id)?
    } else {
        workspace.index_generation
    };
    writer.mark_scan(&workspace_id)?;
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[derive(Debug, Default, Clone)]
struct ChangeSummary {
    changed_sections: Vec<String>,
    added: usize,
    removed: usize,
}

fn summarize_change(
    prev_text: Option<&str>,
    new_text: Option<&str>,
    format: &str,
) -> ChangeSummary {
    let prev_text = match prev_text {
        Some(text) if !text.is_empty() => text,
        _ => {
            return ChangeSummary {
                changed_sections: vec!["首次捕获正文".to_owned()],
                added: 0,
                removed: 0,
            }
        }
    };
    let Some(new_text) = new_text else {
        return ChangeSummary {
            changed_sections: vec!["本轮快照不可读，未计算差异".to_owned()],
            added: 0,
            removed: 0,
        };
    };

    if format != "md" {
        let prev_lines = prev_text.split('\n').count();
        let new_lines = new_text.split('\n').count();
        let fmt = file_format::FileFormat::of_extension(format);
        let summary_label = match fmt.class() {
            file_format::FormatClass::Vector => "SVG 源文本变化",
            file_format::FormatClass::Code => "源码内容变化",
            file_format::FormatClass::Text | file_format::FormatClass::Spreadsheet
                if fmt.is_utf8_text() =>
            {
                "文本内容变化"
            }
            file_format::FormatClass::Document => "文档内容变化",
            _ => "二进制内容变化",
        };
        return ChangeSummary {
            changed_sections: vec![summary_label.to_owned()],
            added: new_lines.saturating_sub(prev_lines),
            removed: prev_lines.saturating_sub(new_lines),
        };
    }

    let prev_sections: Vec<String> = derive::parse_markdown_outline(prev_text)
        .into_iter()
        .map(|(title, _)| title)
        .collect();
    let new_sections = derive::parse_markdown_outline(new_text);
    let mut changed: Vec<String> = Vec::new();
    for (title, _) in &new_sections {
        if !prev_sections.contains(title) {
            changed.push(title.clone());
        }
    }
    for title in &prev_sections {
        if !new_sections.iter().any(|(other, _)| other == title) {
            changed.push(format!("{title}（已移除）"));
        }
    }

    let prev_lines: Vec<&str> = prev_text.split('\n').collect();
    let new_lines: Vec<&str> = new_text.split('\n').collect();
    let mut added = 0usize;
    let mut removed = 0usize;
    for line in &new_lines {
        if !prev_lines.contains(line) {
            added += 1;
        }
    }
    for line in &prev_lines {
        if !new_lines.contains(line) {
            removed += 1;
        }
    }

    changed.truncate(8);
    ChangeSummary {
        changed_sections: changed,
        added,
        removed,
    }
}

fn format_millis(value: f64) -> String {
    format!("{value}")
}

fn decision_action_for(status: &str) -> (&'static str, &'static str, &'static str) {
    match status {
        "已确认" => ("decision_changed", "来源记载已确认", "confirmed"),
        "已否决" => ("decision_changed", "被否决", "rejected"),
        "已取代" => ("decision_changed", "被某项决定取代", "superseded"),
        "已搁置" => ("decision_changed", "已搁置", "shelved"),
        "来源不一致" => ("decision_raised", "来源不一致（提出问题）", "conflicted"),
        _ => ("decision_raised", "提出问题", "raised"),
    }
}

fn record_decision_events(
    writer: &Writer,
    workspace_id: &str,
    statements: &[StatementRow],
    observed_at: &str,
) -> Result<usize, GuanlanError> {
    let mut latest_by_decision: Vec<(String, StatementRow)> = Vec::new();
    for statement in statements {
        let Some(decision_id) = statement.decision_id.clone() else {
            continue;
        };
        match latest_by_decision
            .iter_mut()
            .find(|(id, _)| *id == decision_id)
        {
            Some((_, previous)) => {
                if statement.observed_at > previous.observed_at
                    || (statement.observed_at == previous.observed_at
                        && statement.line_start < previous.line_start)
                {
                    *previous = statement.clone();
                }
            }
            None => latest_by_decision.push((decision_id, statement.clone())),
        }
    }

    let mut inserted = 0usize;
    for (decision_id, statement) in latest_by_decision {
        let last = writer.list_events_of_subject(
            workspace_id,
            &decision_id,
            &["decision_raised", "decision_changed"],
        )?;
        let last_status = last.first().and_then(|event| {
            serde_json::from_str::<serde_json::Value>(&event.payload_json)
                .ok()
                .and_then(|value| {
                    value
                        .get("status")
                        .and_then(|status| status.as_str())
                        .map(str::to_owned)
                })
        });
        if last_status.as_deref() == Some(statement.status.as_str()) {
            continue;
        }

        let (kind, word, action) = decision_action_for(&statement.status);
        let revision = writer.get_revision(&statement.revision_id)?;
        let payload = derive::json_object(&[
            ("decision_id", derive::json_string(&decision_id)),
            ("code", derive::json_string(&statement.code)),
            ("namespace", derive::json_string(&statement.namespace)),
            ("question", derive::json_string(&statement.question)),
            ("status", derive::json_string(&statement.status)),
            ("action", derive::json_string(action)),
            ("statement_id", derive::json_string(&statement.statement_id)),
            ("file_id", derive::json_string(&statement.file_id)),
            ("revision_id", derive::json_string(&statement.revision_id)),
            ("line_start", statement.line_start.to_string()),
            ("line_end", statement.line_end.to_string()),
        ]);
        let event = NewEvent {
            event_id: format!(
                "evt_{kind}_{decision_id}_{}",
                stable_short(&statement.status)
            ),
            workspace_id: workspace_id.to_owned(),
            kind: kind.to_owned(),
            subject_kind: "decision".to_owned(),
            subject_id: decision_id.clone(),
            revision_id: None,
            occurred_at: revision.as_ref().and_then(|row| row.occurred_at.clone()),
            occurred_precision: revision
                .as_ref()
                .map(|row| row.occurred_precision.clone())
                .unwrap_or_else(|| "unknown".to_owned()),
            occurred_source: revision
                .as_ref()
                .and_then(|row| row.occurred_source.clone()),
            observed_at: observed_at.to_owned(),
            headline: format!("{word}：{} · {}", statement.code, statement.question),
            detail: format!(
                "命名空间 {}；来源版本 {} 第 {}–{} 行；当前状态 {}。原文的「推荐」不等于已批准。",
                statement.namespace,
                statement.revision_id,
                statement.line_start,
                statement.line_end,
                statement.status
            ),
            payload_json: payload,
            batch_id: None,
        };
        if writer.insert_event(&event)? {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn rebuild_derived_if_needed(
    writer: &mut Writer,
    workspace_id: &str,
    root_path: &str,
    observed_at: &str,
) -> Result<RebuildOutcome, GuanlanError> {
    if writer.get_meta("extract_rule_version")?.as_deref() == Some(EXTRACT_RULE_VERSION) {
        return Ok(RebuildOutcome::default());
    }

    let files = writer.list_files(workspace_id, true)?;
    let mut path_index: HashMap<String, String> = HashMap::new();
    for (current_path, file_id) in writer.all_path_ids(workspace_id)? {
        path_index.insert(normalize_rel_path(&current_path), file_id);
    }
    let mut target_revision_index: HashMap<String, String> = HashMap::new();
    for (file_id, revision_id) in writer.latest_revision_ids()? {
        target_revision_index.insert(file_id, revision_id);
    }

    writer.transaction(|writer| {
        writer
            .conn()
            .execute("DELETE FROM edges WHERE workspace_id = ?", params![workspace_id])
            .map_err(crate::storage::internal_sql)?;
        writer
            .conn()
            .execute(
                "DELETE FROM statements WHERE workspace_id = ? AND (extract_rule_version IS NULL OR extract_rule_version <> ?)",
                params![workspace_id, EXTRACT_RULE_VERSION],
            )
            .map_err(crate::storage::internal_sql)?;
        Ok(())
    })?;

    let mut statements = 0usize;
    let mut edges = 0usize;
    let mut rebuilt_statements: Vec<StatementRow> = Vec::new();

    writer.transaction(|writer| {
        for row in &files {
            if row.format != "md" {
                continue;
            }
            let rel_path = normalize_rel_path(&row.current_path);
            for revision in writer.revisions_of_file(&row.file_id)? {
                let Some(bytes) = writer.read_snapshot(&revision.content_hash) else {
                    continue;
                };
                let content = String::from_utf8_lossy(&bytes).into_owned();
                let input = DeriveInput {
                    workspace_id,
                    file_id: &row.file_id,
                    revision_id: &revision.revision_id,
                    relative_path: &rel_path,
                    folder: &folder_from_path(&rel_path),
                    title: &title_from_path(&rel_path),
                    format: "md",
                    content: &content,
                    observed_at,
                    root_path,
                    path_index: &path_index,
                    target_revision_index: &target_revision_index,
                };
                for statement in derive_statements(&input) {
                    writer.upsert_statement(&statement)?;
                    rebuilt_statements.push(statement);
                    statements += 1;
                }
                for edge in derive_edges(&input) {
                    writer.upsert_edge(&edge)?;
                    edges += 1;
                }
            }
        }
        record_decision_events(writer, workspace_id, &rebuilt_statements, observed_at)?;
        writer.set_meta("extract_rule_version", EXTRACT_RULE_VERSION)?;
        Ok(())
    })?;

    Ok(RebuildOutcome {
        rebuilt: true,
        statements,
        edges,
    })
}

#[derive(Debug, Default, Clone)]
struct RebuildOutcome {
    rebuilt: bool,
    statements: usize,
    edges: usize,
}

fn backfill_document_self_events(
    writer: &mut Writer,
    workspace_id: &str,
    report: &mut ReconcileReport,
) -> Result<usize, GuanlanError> {
    let rows = writer.query_backfill_candidates(workspace_id)?;
    let mut inserted = 0usize;
    writer.transaction(|writer| {
        for row in rows {
            let rel_path = normalize_rel_path(&row.current_path);
            let payload = derive::json_object(&[
                ("path", derive::json_string(&rel_path)),
                ("format", derive::json_string(&row.format)),
                ("time_basis", derive::json_string("document_self")),
                ("backfilled", "true".to_owned()),
            ]);
            let event = NewEvent {
                event_id: format!("evt_appeared_{}", row.revision_id),
                workspace_id: workspace_id.to_owned(),
                kind: "appeared".to_owned(),
                subject_kind: "revision".to_owned(),
                subject_id: row.revision_id.clone(),
                revision_id: Some(row.revision_id.clone()),
                occurred_at: Some(row.occurred_at.clone()),
                occurred_precision: row.occurred_precision.clone(),
                occurred_source: Some("document_self".to_owned()),
                observed_at: row.observed_at.clone(),
                headline: format!("文档自述日期：{}（{}）", row.title, row.occurred_at),
                detail: format!(
                    "正文明确记载日期 {}；该版本在首次扫描时被采集。未补零点时刻。",
                    row.occurred_at
                ),
                payload_json: payload,
                batch_id: None,
            };
            if writer.insert_event(&event)? {
                report.events_inserted += 1;
            } else {
                report.events_skipped += 1;
            }
            inserted += 1;
        }
        Ok(())
    })?;
    Ok(inserted)
}
