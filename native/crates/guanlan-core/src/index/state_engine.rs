//! 状态机落库引擎（SSOT 三层的执行器）：声明式槽位重算、三级状态迁移记账、
//! checkpoint 同步受理。
//!
//! 职责：
//! - [`state_machine_recompute`]：每轮 reconcile 收尾对**全部专项**做五槽位
//!   声明式重算与三级状态迁移（专项/文档/节点），迁移才记账、首建静默；
//! - [`commit_checkpoint`]：POST /checkpoints 的同步受理核心——校验、插行、
//!   事件、槽位推进与重算同事务提交；`node_id` 缺省时按 `(initiative_id, stage)`
//!   反查槽位；checkpoint `seq` 由库内已有行数派生。
//!
//! **首建静默**：`artifact_states`/`task_nodes`/`initiatives`
//! 无既有行时首次落库不发迁移事件、不计 changed、不 bump generation——
//! 多级迁移记账仅适用于两个已持久状态之间的重算。recompute 在 reconcile 的
//! 代际判定**之前**执行，迁移事件计入 `ReconcileReport.events_inserted`，
//! 由既有「有变化才 bump」口径统一推进代际。
//!
//! 纯函数规则全部在 [`crate::index::state_machine`]（单测穷举）；本模块只做
//! 库内行推导与落库。
//!
//! **调用约定**：[`commit_checkpoint`] 与 [`recompute_inner`] 不开自有事务——
//! 前者由服务层 CheckpointCommit 处理器在 `Writer::transaction` 内调用
//! （校验、插行、事件、推进与重算原子提交），后者由
//! [`state_machine_recompute`] 包装。

use std::collections::HashMap;

use rusqlite::params;

use crate::error::GuanlanError;
use crate::index::clock;
use crate::index::derive::{json_object, json_string};
use crate::index::ident::stable_short;
use crate::index::state_machine::{
    advance_to_fixpoint, initiative_id_of, node_id_of, recognize_initiative, slot_state,
    stage_from_path, task_running, DocState, NodeState, SlotGates, SlotKind, SlotRules, Stage,
    StateSignals, PIPELINE_STAGES,
};
use crate::index::writer::{CheckpointInput, NewEvent, Writer, CHECKPOINT_STATUSES};
use crate::storage::{internal_sql, ArtifactStateRow, InitiativeRow, TaskNodeRow};

/// 派生段产出的 checklist 计数（全文已在内存时同步计数，避免二次读 blob；
/// 未变文件沿用 artifact_states 既有值）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedChecklist {
    pub file_id: String,
    pub done: u32,
    pub total: u32,
}

/// 一次状态迁移（记账与 SSE 共用的最小事实）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    /// 事件 kind：`state_changed` | `task_node_moved`
    pub kind: &'static str,
    /// 事件主体：`artifact` | `initiative` | `task_node`
    pub subject_kind: &'static str,
    /// 迁移身份编码：`{id}:{from}->{to}`（确保多级迁移各单步身份互异）
    pub subject_id: String,
    pub from: String,
    pub to: String,
    pub initiative_id: Option<String>,
    pub headline: String,
}

/// 重算结果
#[derive(Debug, Clone, Default)]
pub struct RecomputeOutcome {
    pub initiatives_upserted: usize,
    pub artifacts_upserted: usize,
    pub nodes_upserted: usize,
    pub transitions: Vec<Transition>,
    pub events_inserted: usize,
    pub events_skipped: usize,
}

/// checkpoint 受理结果（同步 201 通道的回传体）
#[derive(Debug, Clone)]
pub struct CheckpointCommitOutcome {
    pub checkpoint_id: String,
    /// 推进后该槽位节点的状态（节点尚不存在时为 None）
    pub node_state: Option<String>,
    pub transitions: Vec<Transition>,
}

// ---------- 文件信号（库内行推导） ----------

/// 单个文件的投影信号（纯推导，不落库）
struct FileSignals {
    file_id: String,
    title: String,
    stage: Stage,
    /// 识别出的首段目录名（未识别为 None）
    initiative_dir: Option<String>,
    /// initiative_id = init_ + stable_key(目录名)
    initiative_id: Option<String>,
    last_revision_id: Option<String>,
    checklist_done: u32,
    checklist_total: u32,
    pending_p0: u32,
    pending_p1: u32,
    pending_p2: u32,
    last_activity_at: Option<String>,
    /// 最新版本 size_bytes>0（stage_has_content 的 v1 口径）
    has_content: bool,
}

impl FileSignals {
    fn blocking_pending(&self) -> u32 {
        self.pending_p0 + self.pending_p1
    }
}

/// 专项级五槽位的重算结果
struct InitiativePlan {
    initiative_id: String,
    dir_name: String,
    member_indices: Vec<usize>,
    /// 五槽位（按 PIPELINE_STAGES 次序）：(stage, kind, state, latest_success_ckpt)
    slots: Vec<(Stage, SlotKind, NodeState, Option<String>)>,
    gates: SlotGates,
    running: bool,
}

/// 从库内行推导全部文件信号
fn collect_file_signals(
    writer: &Writer,
    workspace_id: &str,
    derived: &[DerivedChecklist],
    init_checklists: &HashMap<String, (u32, u32)>,
    existing_artifacts: &HashMap<String, ArtifactStateRow>,
) -> Result<Vec<FileSignals>, GuanlanError> {
    let initiative_dirs = writer.initiative_dirs()?;

    // 未决分级：当前版本的待确认陈述按 detail_json.priority 聚合
    let mut pending: HashMap<String, [u32; 3]> = HashMap::new();
    {
        let mut stmt = writer
            .conn()
            .prepare(
                "SELECT s.file_id, s.detail_json FROM statements s
                 JOIN files f ON f.file_id = s.file_id AND f.workspace_id = s.workspace_id
                 WHERE s.workspace_id = ? AND s.revision_id = f.last_revision_id
                   AND s.status = '待确认'",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(internal_sql)?;
        for row in rows {
            let (file_id, detail_json) = row.map_err(internal_sql)?;
            let bucket = pending_bucket(&detail_json);
            let buckets = pending.entry(file_id).or_insert([0, 0, 0]);
            buckets[bucket] += 1;
        }
    }

    // 活动时刻与内容标记：最新版本的 occurred_at / size_bytes
    let mut revisions_meta: HashMap<String, (Option<String>, i64)> = HashMap::new();
    {
        let mut stmt = writer
            .conn()
            .prepare(
                "SELECT f.file_id, r.occurred_at, r.size_bytes FROM files f
                 LEFT JOIN revisions r ON r.revision_id = f.last_revision_id
                 WHERE f.workspace_id = ?",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(internal_sql)?;
        for row in rows {
            let (file_id, occurred_at, size) = row.map_err(internal_sql)?;
            revisions_meta.insert(file_id, (occurred_at, size.unwrap_or(0)));
        }
    }

    let derived_map: HashMap<&str, (u32, u32)> = derived
        .iter()
        .map(|row| (row.file_id.as_str(), (row.done, row.total)))
        .collect();

    // 已采纳候选事项的成员归属优先于路径规则（用户显式确认的映射，重算固化不回退；
    // 未覆盖的文件仍走 `recognize_initiative` 路径规则）
    let adopted_map = writer.adopted_candidate_map(workspace_id)?;

    let mut signals: Vec<FileSignals> = Vec::new();
    for file in writer.list_files(workspace_id, true)? {
        if file.status == "trashed" {
            continue;
        }
        let (initiative_dir, initiative_id) = if let Some(title) = adopted_map.get(&file.file_id) {
            (Some(title.clone()), Some(initiative_id_of(title)))
        } else {
            let initiative_dir = recognize_initiative(&file.current_path, &initiative_dirs);
            let initiative_id = initiative_dir.as_deref().map(initiative_id_of);
            (initiative_dir, initiative_id)
        };
        let (checklist_done, checklist_total) =
            if let Some((done, total)) = derived_map.get(file.file_id.as_str()) {
                (*done, *total)
            } else if let Some((done, total)) = init_checklists.get(&file.file_id) {
                (*done, *total)
            } else {
                // 有既有状态行：沿用既有值，避免二次读 blob
                match existing_artifacts.get(file.file_id.as_str()) {
                    Some(row) => (
                        row.checklist_done.max(0) as u32,
                        row.checklist_total.max(0) as u32,
                    ),
                    None => (0, 0),
                }
            };
        let (last_activity_at, size_bytes) = revisions_meta
            .get(&file.file_id)
            .cloned()
            .unwrap_or((None, 0));
        let buckets = pending.get(&file.file_id).copied().unwrap_or([0, 0, 0]);
        signals.push(FileSignals {
            file_id: file.file_id.clone(),
            title: file.title.clone(),
            stage: stage_from_path(&file.current_path),
            initiative_dir,
            initiative_id,
            last_revision_id: file.last_revision_id.clone(),
            checklist_done,
            checklist_total,
            pending_p0: buckets[0],
            pending_p1: buckets[1],
            pending_p2: buckets[2],
            last_activity_at,
            has_content: size_bytes > 0,
        });
    }
    Ok(signals)
}

/// 载荷优先级解析：detail_json 的 `priority` 键（P0/P1/P2）；无键按 P2 计
/// （旧抽取规则产出的陈述不含优先级字段，不作为阻塞项处理，见 `contract-storage.md` §4.3）
fn pending_bucket(detail_json: &str) -> usize {
    serde_json::from_str::<serde_json::Value>(detail_json)
        .ok()
        .and_then(|value| {
            value
                .get("priority")
                .and_then(|p| p.as_str())
                .and_then(crate::domain::model::DecisionPriority::parse)
        })
        .map(|p| match p {
            crate::domain::model::DecisionPriority::P0 => 0usize,
            crate::domain::model::DecisionPriority::P1 => 1usize,
            crate::domain::model::DecisionPriority::P2 => 2usize,
        })
        .unwrap_or(2usize)
}

/// 某阶段成员的 checklist 聚合
fn stage_checklist(members: &[usize], signals: &[FileSignals], stage: Stage) -> (u32, u32) {
    members
        .iter()
        .filter_map(|&index| signals.get(index))
        .filter(|signal| signal.stage == stage)
        .fold((0u32, 0u32), |(done, total), signal| {
            (done + signal.checklist_done, total + signal.checklist_total)
        })
}

/// 某阶段是否有文档 / 是否有内容
fn stage_presence(members: &[usize], signals: &[FileSignals], stage: Stage) -> (bool, bool) {
    let mut has_artifact = false;
    let mut has_content = false;
    for &index in members {
        if let Some(signal) = signals.get(index) {
            if signal.stage == stage {
                has_artifact = true;
                has_content |= signal.has_content;
            }
        }
    }
    (has_artifact, has_content)
}

/// 该专项各阶段最近一次 SUCCESS checkpoint（按 created_at/rowid 倒序取首个）
fn success_checkpoint_by_stage(
    writer: &Writer,
    workspace_id: &str,
    initiative_id: &str,
) -> Result<HashMap<String, String>, GuanlanError> {
    let rows = writer.list_checkpoints(workspace_id, initiative_id)?;
    let mut map: HashMap<String, String> = HashMap::new();
    for row in rows {
        if row.status == "SUCCESS" {
            map.entry(row.stage).or_insert(row.checkpoint_id);
        }
    }
    Ok(map)
}

/// 计算单个专项的五槽位（蓝图→计划→决策→执行→交付，链式前置门禁）
fn compute_slots(
    members: &[usize],
    signals: &[FileSignals],
    success_stages: &HashMap<String, String>,
    pending_p0_p1: u32,
) -> Vec<(Stage, SlotKind, NodeState, Option<String>)> {
    let mut slots: Vec<(Stage, SlotKind, NodeState, Option<String>)> = Vec::new();
    let mut upstream_completed = true;
    for stage in PIPELINE_STAGES {
        let kind = stage.slot_kind().expect("五个流水线阶段均有槽位");
        let (has_artifact, stage_has_content) = stage_presence(members, signals, stage);
        let latest_checkpoint = success_stages.get(stage.as_str()).cloned();
        let (deliver_done, deliver_total) = if kind == SlotKind::Deliver {
            stage_checklist(members, signals, stage)
        } else {
            (0, 0)
        };
        let rules = SlotRules {
            upstream_completed,
            has_artifact,
            stage_has_content,
            pending_p0_p1,
            has_success_checkpoint: latest_checkpoint.is_some(),
            checklist_done: deliver_done,
            checklist_total: deliver_total,
        };
        let state = slot_state(kind, &rules);
        slots.push((stage, kind, state, latest_checkpoint));
        upstream_completed = state == NodeState::Completed;
    }
    slots
}

/// 迁移事件落库（身份编码：subject_id=`{id}:{from}->{to}`；
/// occurred_at=迁移时刻（clock::now_iso）；同迁移重试同身份由
/// uniq_event_identity 去重跳过——幂等成立）
fn write_transition_event(
    writer: &Writer,
    workspace_id: &str,
    transition: &Transition,
    outcome: &mut RecomputeOutcome,
) -> Result<(), GuanlanError> {
    let moved_at = clock::now_iso();
    let raw_id = transition.subject_id.split(':').next().unwrap_or("");
    let id_key = match transition.subject_kind {
        "task_node" => "node_id",
        "initiative" => "initiative_id",
        _ => "file_id",
    };
    let payload = json_object(&[
        (id_key, json_string(raw_id)),
        ("from_state", json_string(&transition.from)),
        ("to_state", json_string(&transition.to)),
        (
            "initiative_id",
            match &transition.initiative_id {
                Some(id) => json_string(id),
                None => "null".to_owned(),
            },
        ),
    ]);
    let event = NewEvent {
        event_id: format!(
            "evt_{}_{}",
            transition.kind,
            stable_short(&format!("{}|{}", transition.subject_id, moved_at))
        ),
        workspace_id: workspace_id.to_owned(),
        kind: transition.kind.to_owned(),
        subject_kind: transition.subject_kind.to_owned(),
        subject_id: transition.subject_id.clone(),
        revision_id: None,
        occurred_at: Some(moved_at.clone()),
        occurred_precision: "second".to_owned(),
        // 迁移由状态机引擎判定（扩展 occurred_source 枚举，见 `contract-storage.md` §4.3）
        occurred_source: Some("state_machine".to_owned()),
        observed_at: moved_at,
        headline: transition.headline.clone(),
        detail: format!(
            "统一状态机重算：{} → {}（声明式槽位与三级投影，每轮幂等重算）",
            transition.from, transition.to
        ),
        payload_json: payload,
        batch_id: None,
    };
    if writer.insert_event(&event)? {
        outcome.events_inserted += 1;
    } else {
        outcome.events_skipped += 1;
    }
    outcome.transitions.push(transition.clone());
    Ok(())
}

/// 距今天数（超期归档判据）：`last_activity_days = max(0, 今天 - 最近活动日)`；
/// 无活动记录返回 0（不做超期归档）。时区口径：UTC 天差。
fn days_since(activity_at: Option<&str>, today_days: i64) -> u32 {
    activity_at
        .and_then(clock::days_since_epoch_of_iso)
        .map(|days| (today_days - days).max(0) as u32)
        .unwrap_or(0)
}

/// 从持久化状态词出发重算到不动点；无既有行时从初始态静默推导。
/// 返回（最终态，单步迁移路径）。
fn resolve_state_path(
    persisted: Option<&str>,
    initial: DocState,
    signals: &StateSignals,
    gates: &SlotGates,
    user_accepted: bool,
) -> (String, Vec<DocState>) {
    let start = persisted.and_then(DocState::parse).unwrap_or(initial);
    let path = advance_to_fixpoint(start, signals, gates, user_accepted);
    let final_state = path.last().copied().unwrap_or(start);
    (final_state.as_str().to_owned(), path)
}

/// 每轮 reconcile 收尾的重算入口（自有事务）。
///
/// 位置：reconcile 的代际判定**之前**；迁移事件计入
/// `ReconcileReport.events_inserted`，与既有「有变化才 bump」口径一致。
pub fn state_machine_recompute(
    writer: &mut Writer,
    workspace_id: &str,
    observed_at: &str,
    derived_checklists: &[DerivedChecklist],
) -> Result<RecomputeOutcome, GuanlanError> {
    // 事务外 IO：首轮初始化的 checklist 读一次快照（无既有行可沿用时的兜底读取）
    // 既有状态行全量只读一次，init 检查 / signals 收集 / 重算核心三处共用，
    // 不再逐文件 get_artifact_state 点查（大工作区可显著减少点查次数）。
    let existing_artifacts: HashMap<String, ArtifactStateRow> = writer
        .list_artifact_states(workspace_id)?
        .into_iter()
        .map(|row| (row.file_id.clone(), row))
        .collect();
    let init_checklists = prepare_init_checklists(
        writer,
        workspace_id,
        derived_checklists,
        &existing_artifacts,
    )?;
    writer.transaction(|writer| {
        recompute_inner(
            writer,
            workspace_id,
            observed_at,
            derived_checklists,
            &init_checklists,
            &existing_artifacts,
        )
    })
}

/// 首轮初始化 checklist：无既有 artifact_states 行、又不在本轮派生清单里的
/// md 文件，读一次快照计数；有既有行则沿用既有值
fn prepare_init_checklists(
    writer: &Writer,
    workspace_id: &str,
    derived: &[DerivedChecklist],
    existing_artifacts: &HashMap<String, ArtifactStateRow>,
) -> Result<HashMap<String, (u32, u32)>, GuanlanError> {
    let mut init = HashMap::new();
    let derived_ids: Vec<&str> = derived.iter().map(|row| row.file_id.as_str()).collect();
    for file in writer.list_files(workspace_id, true)? {
        if file.format != "md" || derived_ids.contains(&file.file_id.as_str()) {
            continue;
        }
        if existing_artifacts.contains_key(&file.file_id) {
            continue;
        }
        let Some(revision_id) = file.last_revision_id.as_deref() else {
            continue;
        };
        let Some(revision) = writer.get_revision(revision_id)? else {
            continue;
        };
        let Some(bytes) = writer.read_snapshot(&revision.content_hash) else {
            continue;
        };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let (done, total) = crate::index::state_machine::derive_checklist(&content);
        init.insert(file.file_id, (done, total));
    }
    Ok(init)
}

/// 事务内全量重算的便捷入口（供文件操作/节点唤醒等调用方复用：内部一次性加载
/// 既有状态行全表后走 [`recompute_inner`]，避免逐文件点查）
pub(crate) fn recompute_full(
    writer: &mut Writer,
    workspace_id: &str,
    observed_at: &str,
) -> Result<RecomputeOutcome, GuanlanError> {
    let existing_artifacts: HashMap<String, ArtifactStateRow> = writer
        .list_artifact_states(workspace_id)?
        .into_iter()
        .map(|row| (row.file_id.clone(), row))
        .collect();
    recompute_inner(
        writer,
        workspace_id,
        observed_at,
        &[],
        &HashMap::new(),
        &existing_artifacts,
    )
}

/// 重算核心（无自有事务；调用方必须在 `Writer::transaction` 内调用）
pub(crate) fn recompute_inner(
    writer: &mut Writer,
    workspace_id: &str,
    observed_at: &str,
    derived_checklists: &[DerivedChecklist],
    init_checklists: &HashMap<String, (u32, u32)>,
    existing_artifacts: &HashMap<String, ArtifactStateRow>,
) -> Result<RecomputeOutcome, GuanlanError> {
    let mut outcome = RecomputeOutcome::default();
    let signals = collect_file_signals(
        writer,
        workspace_id,
        derived_checklists,
        init_checklists,
        existing_artifacts,
    )?;
    let existing_initiatives: HashMap<String, InitiativeRow> = writer
        .list_initiatives(workspace_id)?
        .into_iter()
        .map(|row| (row.initiative_id.clone(), row))
        .collect();
    let existing_nodes: HashMap<(String, String), TaskNodeRow> = writer
        .list_task_nodes(workspace_id)?
        .into_iter()
        .map(|row| ((row.initiative_id.clone(), row.stage.clone()), row))
        .collect();

    // 按专项分组（未识别专项的文件只有文档级行）
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, signal) in signals.iter().enumerate() {
        if let Some(initiative_id) = &signal.initiative_id {
            groups.entry(initiative_id.clone()).or_default().push(index);
        }
    }
    // 专项按 ID 排序处理（输出与事件顺序稳定）
    let mut group_ids: Vec<String> = groups.keys().cloned().collect();
    group_ids.sort();
    let now_for_today = clock::now_iso();
    let today_days = clock::days_since_epoch_of_iso(&now_for_today).unwrap_or(0);

    // ---------- 五槽位重算（同输入重算结果稳定，running 持久跨轮） ----------
    let mut plans: Vec<InitiativePlan> = Vec::new();
    for initiative_id in &group_ids {
        let members = groups.get(initiative_id).expect("分组键来自信号表");
        let pending_p0_p1: u32 = members
            .iter()
            .filter_map(|&index| signals.get(index))
            .map(FileSignals::blocking_pending)
            .sum();
        let success_stages = success_checkpoint_by_stage(writer, workspace_id, initiative_id)?;
        let slots = compute_slots(members, &signals, &success_stages, pending_p0_p1);
        let generate_state = slots
            .iter()
            .find(|(stage, _, _, _)| *stage == Stage::Executing)
            .map(|(_, _, state, _)| *state)
            .expect("执行槽必在五槽位中");
        let deliver_state = slots
            .iter()
            .find(|(stage, _, _, _)| *stage == Stage::Delivery)
            .map(|(_, _, state, _)| *state)
            .expect("交付槽必在五槽位中");
        plans.push(InitiativePlan {
            initiative_id: initiative_id.clone(),
            dir_name: signals
                .get(members[0])
                .and_then(|signal| signal.initiative_dir.clone())
                .unwrap_or_default(),
            member_indices: members.clone(),
            slots,
            gates: SlotGates {
                exec_completed: generate_state == NodeState::Completed,
                deliver_completed: deliver_state == NodeState::Completed,
            },
            running: task_running(generate_state, deliver_state),
        });
    }

    // ---------- 专项行（三级投影之第一级）：pending 聚合 + 状态迁移 ----------
    for plan in &plans {
        let existing = existing_initiatives.get(&plan.initiative_id);
        let pending_p0: i64 = plan
            .member_indices
            .iter()
            .filter_map(|&index| signals.get(index))
            .map(|signal| signal.pending_p0 as i64)
            .sum();
        let pending_p1: i64 = plan
            .member_indices
            .iter()
            .filter_map(|&index| signals.get(index))
            .map(|signal| signal.pending_p1 as i64)
            .sum();
        let pending_p2: i64 = plan
            .member_indices
            .iter()
            .filter_map(|&index| signals.get(index))
            .map(|signal| signal.pending_p2 as i64)
            .sum();
        let current_stage = plan
            .member_indices
            .iter()
            .filter_map(|&index| signals.get(index))
            .map(|signal| signal.stage)
            .max()
            .unwrap_or(Stage::Unclassified);
        // 专项级信号：checklist 用交付段聚合（与 deliver_completed 门禁同口径），
        // last_activity_days 取成员最近活动的最大间隔
        let (deliver_done, deliver_total) =
            stage_checklist(&plan.member_indices, &signals, Stage::Delivery);
        let latest_activity = plan
            .member_indices
            .iter()
            .filter_map(|&index| signals.get(index))
            .filter_map(|signal| signal.last_activity_at.as_deref())
            .max()
            .map(str::to_owned);
        let initiative_signals = StateSignals {
            pending_p0: pending_p0.max(0) as u32,
            pending_p1: pending_p1.max(0) as u32,
            pending_p2: pending_p2.max(0) as u32,
            checklist_done: deliver_done,
            checklist_total: deliver_total,
            has_selected_revision: plan
                .member_indices
                .iter()
                .filter_map(|&index| signals.get(index))
                .any(|signal| signal.last_revision_id.is_some()),
            task_running: plan.running,
            last_activity_days: days_since(latest_activity.as_deref(), today_days),
        };
        let (state, _path) = resolve_state_path(
            existing.map(|row| row.state.as_str()),
            DocState::Draft,
            &initiative_signals,
            &plan.gates,
            // user_accepted 唯一来源 = archive 写线程置位；重算恒 false
            false,
        );
        let initiative_row = InitiativeRow {
            initiative_id: plan.initiative_id.clone(),
            workspace_id: workspace_id.to_owned(),
            name: plan.dir_name.clone(),
            root_dir: plan.dir_name.clone(),
            current_stage: current_stage.as_str().to_owned(),
            state,
            artifact_count: plan.member_indices.len() as i64,
            pending_p0,
            pending_p1,
            pending_p2,
            created_at: existing
                .map(|row| row.created_at.clone())
                .unwrap_or_else(|| observed_at.to_owned()),
            updated_at: observed_at.to_owned(),
        };
        writer.upsert_initiative(&initiative_row)?;
        outcome.initiatives_upserted += 1;
        if let Some(old) = existing {
            if old.state != initiative_row.state {
                let transition = Transition {
                    kind: "state_changed",
                    subject_kind: "initiative",
                    subject_id: format!(
                        "{}:{}->{}",
                        plan.initiative_id, old.state, initiative_row.state
                    ),
                    from: old.state.clone(),
                    to: initiative_row.state.clone(),
                    initiative_id: Some(plan.initiative_id.clone()),
                    headline: format!(
                        "专项状态迁移：{} {}→{}",
                        plan.dir_name, old.state, initiative_row.state
                    ),
                };
                write_transition_event(writer, workspace_id, &transition, &mut outcome)?;
            }
        }
    }

    // ---------- 节点行（task_nodes 五槽位）：UPSERT + 迁移记账（首建静默） ----------
    for plan in &plans {
        for (stage, kind, state, latest_checkpoint) in &plan.slots {
            let node_id = node_id_of(&plan.initiative_id, *stage, *kind);
            let title = format!("{}·{}", stage.as_str(), kind.title_word());
            let depends: Vec<String> = match PIPELINE_STAGES.iter().position(|s| s == stage) {
                Some(0) | None => Vec::new(),
                Some(index) => {
                    let upstream = PIPELINE_STAGES[index - 1];
                    vec![node_id_of(
                        &plan.initiative_id,
                        upstream,
                        upstream.slot_kind().expect("流水线阶段均有槽位"),
                    )]
                }
            };
            let depends_json = serde_json::to_string(&depends)
                .map_err(|e| GuanlanError::Internal(format!("序列化 depends 失败：{e}")))?;
            let existing_node =
                existing_nodes.get(&(plan.initiative_id.clone(), stage.as_str().to_owned()));
            let row = TaskNodeRow {
                node_id: node_id.clone(),
                workspace_id: workspace_id.to_owned(),
                initiative_id: plan.initiative_id.clone(),
                stage: stage.as_str().to_owned(),
                title: title.clone(),
                node_kind: kind.as_str().to_owned(),
                state: state.as_str().to_owned(),
                depends_json,
                payload_json: existing_node
                    .map(|row| row.payload_json.clone())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "{}".to_owned()),
                latest_checkpoint_id: latest_checkpoint.clone(),
                error: None,
                created_at: existing_node
                    .map(|row| row.created_at.clone())
                    .unwrap_or_else(|| observed_at.to_owned()),
                updated_at: observed_at.to_owned(),
            };
            writer.upsert_task_node(&row)?;
            outcome.nodes_upserted += 1;
            if let Some(old) = existing_node {
                if old.state != row.state {
                    let transition = Transition {
                        kind: "task_node_moved",
                        subject_kind: "task_node",
                        subject_id: format!("{}:{}->{}", node_id, old.state, row.state),
                        from: old.state.clone(),
                        to: row.state.clone(),
                        initiative_id: Some(plan.initiative_id.clone()),
                        headline: format!(
                            "槽位迁移：{} · {} {}→{}",
                            stage.as_str(),
                            title,
                            old.state,
                            row.state
                        ),
                    };
                    write_transition_event(writer, workspace_id, &transition, &mut outcome)?;
                }
            }
        }
    }

    // ---------- 文档行（三级投影之第三级）：迁移才记账，首建静默 ----------
    let plan_by_initiative: HashMap<&str, &InitiativePlan> = plans
        .iter()
        .map(|plan| (plan.initiative_id.as_str(), plan))
        .collect();
    for signal in &signals {
        let existing = existing_artifacts.get(&signal.file_id);
        let plan = signal
            .initiative_id
            .as_deref()
            .and_then(|id| plan_by_initiative.get(id));
        let stage_signals = StateSignals {
            pending_p0: signal.pending_p0,
            pending_p1: signal.pending_p1,
            pending_p2: signal.pending_p2,
            checklist_done: signal.checklist_done,
            checklist_total: signal.checklist_total,
            has_selected_revision: signal.last_revision_id.is_some(),
            task_running: plan.map(|plan| plan.running).unwrap_or(false),
            last_activity_days: days_since(signal.last_activity_at.as_deref(), today_days),
        };
        let gates = plan.map(|plan| plan.gates).unwrap_or_default();
        let (state, path) = resolve_state_path(
            existing.map(|row| row.state.as_str()),
            DocState::Draft,
            &stage_signals,
            &gates,
            false,
        );
        let row = ArtifactStateRow {
            file_id: signal.file_id.clone(),
            workspace_id: workspace_id.to_owned(),
            initiative_id: signal.initiative_id.clone(),
            stage: signal.stage.as_str().to_owned(),
            state: state.clone(),
            selected_revision_id: signal.last_revision_id.clone(),
            checklist_done: signal.checklist_done as i64,
            checklist_total: signal.checklist_total as i64,
            pending_p0: signal.pending_p0 as i64,
            pending_p1: signal.pending_p1 as i64,
            pending_p2: signal.pending_p2 as i64,
            last_activity_at: signal.last_activity_at.clone(),
            updated_at: observed_at.to_owned(),
        };
        writer.upsert_artifact_state(&row)?;
        outcome.artifacts_upserted += 1;

        // 多级迁移逐步记账：fixpoint 的每一单步身份互异
        if existing.is_some() {
            let mut from = existing
                .and_then(|row| DocState::parse(&row.state))
                .unwrap_or(DocState::Draft);
            for step in path {
                let transition = Transition {
                    kind: "state_changed",
                    subject_kind: "artifact",
                    subject_id: format!("{}:{}->{}", signal.file_id, from.as_str(), step.as_str()),
                    from: from.as_str().to_owned(),
                    to: step.as_str().to_owned(),
                    initiative_id: signal.initiative_id.clone(),
                    headline: format!(
                        "状态迁移：{} {}→{}",
                        signal.title,
                        from.as_str(),
                        step.as_str()
                    ),
                };
                write_transition_event(writer, workspace_id, &transition, &mut outcome)?;
                from = step;
            }
        }
    }

    Ok(outcome)
}

// ---------- checkpoint 同步受理 ----------

/// POST /checkpoints 的同步受理核心。
///
/// **调用方必须在 [`Writer::transaction`] 内调用**：校验、插行、事件、
/// 槽位推进与重算同事务原子提交；HTTP 层在 spawn_blocking 内等命令回执，
/// 超时返回 503——受理与校验原子，校验失败时 checkpoint 不落库、无 job_id。
///
/// - 校验 initiative/stage 存在 → 失败返回 NOT_FOUND（调用方以 404 直接重试）；
/// - `node_id` 缺省时按 `(initiative_id, stage)` 反查槽位推进（外部 agent
///   的提交载荷不含 `node_id` 也能推进执行槽）；
/// - `status=SUCCESS` 且命中节点 → 节点置 completed + latest_checkpoint_id，
///   随后 recompute（generate 槽因 SUCCESS checkpoint 存在保持 completed；
///   derive/await/deliver 槽为声明式，SUCCESS 行不影响其重算判据，详见 `contract-storage.md` §4.3）；
/// - 非 SUCCESS 只落行与事件，不推进节点。
pub fn commit_checkpoint(
    writer: &mut Writer,
    input: &CheckpointInput,
) -> Result<CheckpointCommitOutcome, GuanlanError> {
    if !CHECKPOINT_STATUSES.contains(&input.status.as_str()) {
        return Err(GuanlanError::BadRequest(format!(
            "未知 checkpoint 状态「{}」（允许 {:?}）",
            input.status, CHECKPOINT_STATUSES
        )));
    }
    let workspace_id = input.workspace_id.clone();
    let initiative_id = input.initiative_id.clone();
    let stage = input.stage.clone();

    let initiative = writer
        .get_initiative(&workspace_id, &initiative_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到专项 {initiative_id}")))?;
    if Stage::parse(&stage).map(|parsed| parsed.slot_kind().is_some()) != Some(true) {
        return Err(GuanlanError::NotFound(format!(
            "未知阶段「{stage}」（允许 蓝图/计划/决策/执行/交付）"
        )));
    }

    // node_id 缺省时按 (initiative_id, stage) 反查；给定时必须存在
    let resolved_node = match &input.node_id {
        Some(node_id) => {
            let row = writer
                .get_task_node(node_id)?
                .ok_or_else(|| GuanlanError::NotFound(format!("未找到任务节点 {node_id}")))?;
            if row.initiative_id != initiative_id {
                return Err(GuanlanError::NotFound(format!(
                    "任务节点 {node_id} 不属于专项 {initiative_id}"
                )));
            }
            Some(row)
        }
        None => writer.find_task_node_by_stage(&workspace_id, &initiative_id, &stage)?,
    };

    // 插 checkpoint 行：seq 由库内既有行数派生，重启安全
    let checkpoint_id = writer.insert_checkpoint(input)?;

    // output_artifact_version（版本号如 v2）：由产出修订的 per-file seq
    // 派生（与 TS 侧 versionNumber = revision.seq 同源口径）；无产出修订 → null
    let output_artifact_version = match &input.output_revision_id {
        Some(revision_id) => writer
            .get_revision(revision_id)?
            .map(|row| format!("v{}", row.seq)),
        None => None,
    };

    // checkpoint_committed 事件
    let payload = json_object(&[
        ("checkpoint_id", json_string(&checkpoint_id)),
        ("initiative_id", json_string(&initiative_id)),
        ("stage", json_string(&stage)),
        ("status", json_string(&input.status)),
        (
            "node_id",
            match &input.node_id {
                Some(id) => json_string(id),
                None => "null".to_owned(),
            },
        ),
        ("input_context_hash", json_string(&input.input_context_hash)),
        (
            "output_revision_id",
            match &input.output_revision_id {
                Some(id) => json_string(id),
                None => "null".to_owned(),
            },
        ),
        (
            "output_artifact_version",
            match &output_artifact_version {
                Some(version) => json_string(version),
                None => "null".to_owned(),
            },
        ),
        (
            "token_usage",
            match input.token_usage {
                Some(value) => value.to_string(),
                None => "null".to_owned(),
            },
        ),
        (
            "elapsed_ms",
            match input.elapsed_ms {
                Some(value) => value.to_string(),
                None => "null".to_owned(),
            },
        ),
    ]);
    let event = NewEvent {
        event_id: format!("evt_checkpoint_committed_{}", stable_short(&checkpoint_id)),
        workspace_id: workspace_id.clone(),
        kind: "checkpoint_committed".to_owned(),
        subject_kind: "checkpoint".to_owned(),
        subject_id: checkpoint_id.clone(),
        revision_id: input.output_revision_id.clone(),
        occurred_at: Some(input.created_at.clone()),
        occurred_precision: "second".to_owned(),
        occurred_source: Some("collector".to_owned()),
        observed_at: clock::now_iso(),
        headline: format!("检查点提交：{} · {}", stage, input.status),
        detail: format!(
            "专项 {}（{}）的 {} 阶段检查点 {}；成功快照用于断点续跑恢复。",
            initiative_id, initiative.name, stage, checkpoint_id
        ),
        payload_json: payload,
        batch_id: None,
    };
    writer.insert_event(&event)?;

    // SUCCESS 且命中节点 → 推进 completed（随后 recompute 以声明式口径复核）
    if input.status == "SUCCESS" {
        if let Some(node) = &resolved_node {
            writer.upsert_task_node(&TaskNodeRow {
                state: NodeState::Completed.as_str().to_owned(),
                latest_checkpoint_id: Some(checkpoint_id.clone()),
                updated_at: clock::now_iso(),
                ..node.clone()
            })?;
        }
    }

    // 同事务同步重算（唤醒直接走同步函数调用，无独立后台 job 载体）
    let outcome = recompute_full(writer, &workspace_id, &input.created_at)?;

    // 回传推进后的节点状态
    let node_state = match (&input.node_id, &resolved_node) {
        (Some(node_id), _) => writer.get_task_node(node_id)?.map(|row| row.state),
        (None, Some(node)) => writer.get_task_node(&node.node_id)?.map(|row| row.state),
        (None, None) => {
            // 槽位节点此前不存在：recompute 可能已按五槽位模型建行
            writer
                .find_task_node_by_stage(&workspace_id, &initiative_id, &stage)?
                .map(|row| row.state)
        }
    };

    Ok(CheckpointCommitOutcome {
        checkpoint_id,
        node_state,
        transitions: outcome.transitions,
    })
}
