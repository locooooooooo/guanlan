//! 原位拍板（HITL）唤醒任务与批次「批阅看板」核心（五态分栏 + `unknown` 孤儿诊断与修复）。
//!
//! 五态分栏：
//! - `pending_decision`（待拍板）：存在未决 P0/P1 或决策槽处于 `suspended_on_hitl`（含人工孤儿挂起）；
//! - `awaiting_receipt`（待批阅回执）：存在待审的 Agent 修订草案（`status='proposed'`）——
//!   **停机红线**：有待批阅回执或未决 P0/P1 时绝不跳过人工审阅直接完结；
//! - `unknown`（状态未知）：运行中节点无有效完成回执且超时失联、或最近 checkpoint 为
//!   `FAILED_RETRYABLE`/`SUSPENDED_HITL` 且无后续恢复、或节点带错误——一律诚实标 `unknown`
//!   并给出安全孤儿修复入口；
//! - `agent_running`（Agent 运行中）：执行/交付槽处于 `running` 且距最近活动在失联阈值内；
//! - `completed`（已办结）：`delivered` / `archived`，且必须无未决 P0/P1、无待审草案、无失联节点；
//! - `dispatchable`（可派发）：所有阻塞已解除且无失联/待审，准备交办下一步任务。

use std::collections::HashMap;

use rusqlite::params;

use crate::application::proposals::draft_version_label;
use crate::dto::{
    OrphanDiagnostic, ReviewBoardCard, ReviewBoardCounts, ReviewBoardDraftBrief,
    ReviewBoardPendingStatement, ReviewBoardResponse, ReviewBoardSlotBrief,
};
use crate::error::GuanlanError;
use crate::index::clock;
use crate::index::derive::{json_object, json_string};
use crate::index::ident::stable_key;
use crate::index::writer::{NewEvent, Writer};
use crate::query::longtasks::statement_priority;
use crate::storage::{internal_sql, ReadonlyStore};

/// 默认失联判定阈值：30 分钟（1800 秒）无新回执/活动即视为孤儿/失联，诚实标 `unknown`
pub const DEFAULT_ORPHAN_STALL_SECS: i64 = 1800;

/// 允许的人工孤儿修复动作白名单（停机红线：严禁出现任何直接完结/跳过审阅动作）
pub const ALLOWED_ORPHAN_REPAIR_ACTIONS: [&str; 2] =
    ["reset_to_dispatchable", "mark_suspended_hitl"];

/// 批阅看板分栏枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReviewBoardBucket {
    PendingDecision,
    Dispatchable,
    AgentRunning,
    AwaitingReceipt,
    Completed,
    Unknown,
}

impl ReviewBoardBucket {
    pub fn as_str(self) -> &'static str {
        match self {
            ReviewBoardBucket::PendingDecision => "pending_decision",
            ReviewBoardBucket::Dispatchable => "dispatchable",
            ReviewBoardBucket::AgentRunning => "agent_running",
            ReviewBoardBucket::AwaitingReceipt => "awaiting_receipt",
            ReviewBoardBucket::Completed => "completed",
            ReviewBoardBucket::Unknown => "unknown",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ReviewBoardBucket::PendingDecision => "待拍板",
            ReviewBoardBucket::Dispatchable => "可派发",
            ReviewBoardBucket::AgentRunning => "Agent 运行中",
            ReviewBoardBucket::AwaitingReceipt => "待批阅回执",
            ReviewBoardBucket::Completed => "已办结",
            ReviewBoardBucket::Unknown => "状态未知",
        }
    }

    /// 展示排序权重（紧急度：unknown / pending_decision / awaiting_receipt / agent_running / dispatchable / completed）
    fn urgency_rank(self) -> u8 {
        match self {
            ReviewBoardBucket::Unknown => 0,
            ReviewBoardBucket::PendingDecision => 1,
            ReviewBoardBucket::AwaitingReceipt => 2,
            ReviewBoardBucket::AgentRunning => 3,
            ReviewBoardBucket::Dispatchable => 4,
            ReviewBoardBucket::Completed => 5,
        }
    }
}

/// 纯函数分类输入（单测可零 IO 穷举停机红线）
#[derive(Debug, Clone, Default)]
pub struct BoardClassificationSignals {
    pub doc_state: String,
    pub pending_p0: i64,
    pub pending_p1: i64,
    pub pending_proposal_count: u32,
    pub decision_slot_suspended: bool,
    pub has_live_running_slot: bool,
    pub repair_suspended_hitl: bool,
    pub repair_reset_dispatchable: bool,
    pub orphan_reason: Option<String>,
}

/// 纯函数分类结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardClassificationResult {
    pub bucket: ReviewBoardBucket,
    pub reason: String,
}

/// 批阅看板确定性状态分类器（Fail-Closed，绝不隐式自动完成或跳过人工审阅）
pub fn classify_board_bucket(signals: &BoardClassificationSignals) -> BoardClassificationResult {
    // 1. 停机红线：存在待批阅 Agent 修订草案，必须先由人工审阅采纳或退回，绝不能直接完结
    if signals.pending_proposal_count > 0 {
        return BoardClassificationResult {
            bucket: ReviewBoardBucket::AwaitingReceipt,
            reason: format!(
                "有 {} 份智能体草案回执待人工批阅（采纳/退回前不得完结）",
                signals.pending_proposal_count
            ),
        };
    }

    // 2. 未决 P0/P1 或决策槽挂起（含人工孤儿挂起）→ 待拍板
    let blocking = signals.pending_p0.max(0) + signals.pending_p1.max(0);
    if blocking > 0 || signals.decision_slot_suspended || signals.repair_suspended_hitl {
        let reason = if blocking > 0 {
            format!(
                "尚有 {} 项阻塞级待确认事项（P0:{} / P1:{}），拍板后自动解锁下游",
                blocking, signals.pending_p0, signals.pending_p1
            )
        } else if signals.repair_suspended_hitl {
            "孤儿节点已转人工核查挂起，待确认后恢复派发".to_owned()
        } else {
            "决策槽处于人工挂起态（suspended_on_hitl），待拍板放行".to_owned()
        };
        return BoardClassificationResult {
            bucket: ReviewBoardBucket::PendingDecision,
            reason,
        };
    }

    // 3. 失联/无回执/异常未恢复 → 诚实标 unknown（绝不粉饰为已办结或运行中）
    if let Some(reason) = &signals.orphan_reason {
        return BoardClassificationResult {
            bucket: ReviewBoardBucket::Unknown,
            reason: reason.clone(),
        };
    }

    // 4. 孤儿人工重置为可派发且无新运行信号 → 可派发
    if signals.repair_reset_dispatchable && !signals.has_live_running_slot {
        return BoardClassificationResult {
            bucket: ReviewBoardBucket::Dispatchable,
            reason: "已完成孤儿修复重置，待重新派发或人工推进".to_owned(),
        };
    }

    // 5. 存活运行槽 → Agent 运行中
    if signals.has_live_running_slot {
        return BoardClassificationResult {
            bucket: ReviewBoardBucket::AgentRunning,
            reason: "执行/交付槽运行中，正在等待智能体提交有效回执或 Checkpoint".to_owned(),
        };
    }

    // 6. 严格完结门禁：仅当状态已达 delivered/archived 且零阻塞、零待审、零失联才进已办结
    if matches!(signals.doc_state.as_str(), "delivered" | "archived") {
        let label = if signals.doc_state == "archived" {
            "已归档"
        } else {
            "已交付"
        };
        return BoardClassificationResult {
            bucket: ReviewBoardBucket::Completed,
            reason: format!("全部验收清单、人工拍板与回执核验已完成（{label}）"),
        };
    }

    // 7. 其余无阻塞事项 → 可派发
    BoardClassificationResult {
        bucket: ReviewBoardBucket::Dispatchable,
        reason: "无阻塞待拍板事项与待审回执，可随时交办下一步执行".to_owned(),
    }
}

/// 校验孤儿修复动作白名单（停机红线：禁止任何自动完成/跳过审阅动作）
pub fn validate_orphan_repair_action(action: &str) -> Result<&'static str, GuanlanError> {
    match action.trim() {
        "reset_to_dispatchable" => Ok("reset_to_dispatchable"),
        "mark_suspended_hitl" => Ok("mark_suspended_hitl"),
        other => Err(GuanlanError::BadRequest(format!(
            "非法孤儿修复动作「{other}」（仅允许 reset_to_dispatchable | mark_suspended_hitl，严禁跳过人工审阅直接完结）"
        ))),
    }
}

/// ISO-8601 UTC 时间戳转 epoch 秒（YYYY-MM-DDTHH:MM:SS...，无外部 chrono 依赖）
pub(crate) fn parse_iso_epoch_secs(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b'-'
        || b[7] != b'-'
        || (b[10] != b'T' && b[10] != b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year: i64 = s[0..4].parse().ok()?;
    let month: u32 = s[5..7].parse().ok()?;
    let day: u32 = s[8..10].parse().ok()?;
    let hour: i64 = s[11..13].parse().ok()?;
    let min: i64 = s[14..16].parse().ok()?;
    let sec: i64 = s[17..19].parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&min)
        || !(0..=60).contains(&sec)
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + min * 60 + sec)
}

/// Howard Hinnant civil-to-days 算法（与 clock.rs 同源）
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as u64;
    let d = day as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

/// 查询当前工作区的批阅看板快照（单短读事务）
pub fn query_review_board(
    store: &ReadonlyStore,
    now_iso: Option<&str>,
    stall_threshold_secs: Option<i64>,
) -> Result<ReviewBoardResponse, GuanlanError> {
    let threshold = stall_threshold_secs
        .unwrap_or(DEFAULT_ORPHAN_STALL_SECS)
        .max(1);
    let generated_at = now_iso
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(clock::now_iso);
    let now_epoch = parse_iso_epoch_secs(&generated_at);

    store.read_txn(|conn| {
        let ws = store.workspace()?.clone();

        // 1. 文件元信息 + 所属专项映射
        let mut file_path_by_id: HashMap<String, String> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT file_id, current_path FROM files WHERE workspace_id = ?")
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (fid, path) = row.map_err(internal_sql)?;
                file_path_by_id.insert(fid, path);
            }
        }

        let mut file_to_init: HashMap<String, String> = HashMap::new();
        let mut init_last_activity: HashMap<String, String> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT file_id, initiative_id, last_activity_at FROM artifact_states WHERE workspace_id = ?",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (fid, init_id, last_act) = row.map_err(internal_sql)?;
                if let Some(init_id) = init_id {
                    file_to_init.insert(fid, init_id.clone());
                    if let Some(act) = last_act {
                        init_last_activity
                            .entry(init_id)
                            .and_modify(|cur| {
                                if act > *cur {
                                    *cur = act.clone();
                                }
                            })
                            .or_insert(act);
                    }
                }
            }
        }

        // 2. 待审 Agent 草案（按专项分组）
        let mut drafts_by_init: HashMap<String, Vec<ReviewBoardDraftBrief>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT d.draft_id, d.file_id, d.conflict, d.draft_version_label, d.receipt_summary, d.created_at,
                            COALESCE(r.seq, 0) AS base_seq
                     FROM revision_drafts d
                     LEFT JOIN revisions r ON r.revision_id = d.base_revision_id
                     WHERE d.workspace_id = ? AND d.status = 'proposed'
                     ORDER BY d.created_at DESC, d.draft_id ASC",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (draft_id, file_id, conflict, label, receipt_summary, created_at, base_seq) =
                    row.map_err(internal_sql)?;
                if let Some(init_id) = file_to_init.get(&file_id) {
                    let path = file_path_by_id
                        .get(&file_id)
                        .cloned()
                        .unwrap_or_default();
                    let version_label = if label.trim().is_empty() {
                        draft_version_label(base_seq)
                    } else {
                        label
                    };
                    drafts_by_init
                        .entry(init_id.clone())
                        .or_default()
                        .push(ReviewBoardDraftBrief {
                            draft_id,
                            file_id,
                            path,
                            draft_version_label: version_label,
                            conflict: conflict != 0,
                            receipt_summary,
                            created_at,
                        });
                }
            }
        }

        // 3. 待确认语句（最新版本的待确认 statement，按专项分组）
        let mut pending_stmts_by_init: HashMap<String, Vec<ReviewBoardPendingStatement>> =
            HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT s.statement_id, s.decision_id, s.code, s.question, s.file_id, s.line_start, s.detail_json
                     FROM statements s
                     JOIN files f ON f.file_id = s.file_id AND f.last_revision_id = s.revision_id
                     WHERE s.workspace_id = ? AND s.status = '待确认'
                     ORDER BY s.line_start ASC, s.statement_id ASC",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (statement_id, decision_id, code, question, file_id, line_start, detail_json) =
                    row.map_err(internal_sql)?;
                let priority = if matches!(code.trim(), "P0" | "P1" | "P2") {
                    code.trim().to_owned()
                } else {
                    statement_priority(&detail_json)
                };
                if let Some(init_id) = file_to_init.get(&file_id) {
                    let path = file_path_by_id
                        .get(&file_id)
                        .cloned()
                        .unwrap_or_default();
                    pending_stmts_by_init
                        .entry(init_id.clone())
                        .or_default()
                        .push(ReviewBoardPendingStatement {
                            statement_id,
                            decision_id,
                            code,
                            priority,
                            question,
                            file_id,
                            path,
                            line_start,
                        });
                }
            }
        }

        // 4. 检查点最新状态（按 node_id 与 (initiative_id, stage) 索引）
        let mut ckpt_by_id: HashMap<String, (String, String)> = HashMap::new();
        let mut latest_ckpt_by_init_stage: HashMap<(String, String), (String, String, String)> =
            HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT checkpoint_id, initiative_id, stage, status, created_at
                     FROM checkpoints
                     WHERE workspace_id = ?
                     ORDER BY created_at DESC, rowid DESC",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (ckpt_id, init_id, stage, status, created_at) = row.map_err(internal_sql)?;
                ckpt_by_id.insert(ckpt_id.clone(), (status.clone(), created_at.clone()));
                latest_ckpt_by_init_stage
                    .entry((init_id, stage))
                    .or_insert((ckpt_id, status, created_at));
            }
        }

        // 5. 任务节点五槽位
        #[allow(clippy::type_complexity)]
        let mut nodes_by_init: HashMap<
            String,
            Vec<(String, String, String, String, Option<String>, Option<String>, String, String)>,
        > = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT initiative_id, node_id, stage, node_kind, state, latest_checkpoint_id, error, payload_json, updated_at
                     FROM task_nodes
                     WHERE workspace_id = ?
                     ORDER BY CASE stage
                        WHEN '蓝图' THEN 0 WHEN '计划' THEN 1 WHEN '决策' THEN 2 WHEN '执行' THEN 3 WHEN '交付' THEN 4 ELSE 5 END",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map(params![ws.workspace_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                    ))
                })
                .map_err(internal_sql)?;
            for row in rows {
                let (init_id, node_id, stage, kind, state, ckpt_id, err, payload, updated_at) =
                    row.map_err(internal_sql)?;
                nodes_by_init.entry(init_id).or_default().push((
                    node_id, stage, kind, state, ckpt_id, err, payload, updated_at,
                ));
            }
        }

        // 6. 遍历全部专项构造看板卡片
        let mut init_stmt = conn
            .prepare(
                "SELECT initiative_id, name, root_dir, current_stage, state, artifact_count, pending_p0, pending_p1, pending_p2, updated_at
                 FROM initiatives
                 WHERE workspace_id = ?",
            )
            .map_err(internal_sql)?;
        let init_rows = init_stmt
            .query_map(params![ws.workspace_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, String>(9)?,
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;

        let mut cards_with_rank: Vec<(u8, ReviewBoardCard)> = Vec::new();
        let mut counts = ReviewBoardCounts::default();

        for (
            initiative_id,
            name,
            root_dir,
            current_stage,
            doc_state,
            artifact_count,
            pending_p0,
            pending_p1,
            pending_p2,
            updated_at,
        ) in init_rows
        {
            let drafts = drafts_by_init.remove(&initiative_id).unwrap_or_default();
            let pending_proposals = drafts.len() as u32;
            let mut pending_statements = pending_stmts_by_init
                .remove(&initiative_id)
                .unwrap_or_default();
            pending_statements.sort_by(|a, b| {
                a.priority
                    .cmp(&b.priority)
                    .then(a.path.cmp(&b.path))
                    .then(a.line_start.cmp(&b.line_start))
            });

            let raw_nodes = nodes_by_init.remove(&initiative_id).unwrap_or_default();
            let mut slots: Vec<ReviewBoardSlotBrief> = Vec::new();
            let mut decision_slot_suspended = false;
            let mut has_live_running_slot = false;
            let mut repair_suspended_hitl = false;
            let mut repair_reset_dispatchable = false;
            let mut orphan: Option<OrphanDiagnostic> = None;

            let latest_activity_ref = init_last_activity
                .get(&initiative_id)
                .map(String::as_str)
                .unwrap_or(updated_at.as_str());

            for (node_id, stage, node_kind, state, latest_ckpt_id, err, payload_json, node_updated) in
                raw_nodes
            {
                let ckpt_info = latest_ckpt_id
                    .as_deref()
                    .and_then(|id| ckpt_by_id.get(id).map(|(st, ts)| (id.to_owned(), st.clone(), ts.clone())))
                    .or_else(|| {
                        latest_ckpt_by_init_stage
                            .get(&(initiative_id.clone(), stage.clone()))
                            .cloned()
                    });
                let latest_ckpt_status = ckpt_info.as_ref().map(|(_, st, _)| st.clone());
                let latest_ckpt_at = ckpt_info.as_ref().map(|(_, _, ts)| ts.as_str());

                // 检查孤儿修复标记（存在且不早于节点最后活跃时间则生效）
                let repair_meta = serde_json::from_str::<serde_json::Value>(&payload_json)
                    .ok()
                    .and_then(|v| v.get("orphan_repair").cloned());
                let repair_action = repair_meta
                    .as_ref()
                    .and_then(|r| r.get("action").and_then(|a| a.as_str()))
                    .map(str::to_owned);
                let repair_at = repair_meta
                    .as_ref()
                    .and_then(|r| r.get("repaired_at").and_then(|a| a.as_str()))
                    .map(str::to_owned);
                let repair_active = repair_action.is_some()
                    && repair_at
                        .as_deref()
                        .map(|ts| {
                            let latest_signal = latest_ckpt_at
                                .map(|c| c.max(latest_activity_ref))
                                .unwrap_or(latest_activity_ref);
                            ts >= latest_signal
                        })
                        .unwrap_or(true);

                if state == "suspended_on_hitl" {
                    decision_slot_suspended = true;
                }
                if repair_active && repair_action.as_deref() == Some("mark_suspended_hitl") {
                    repair_suspended_hitl = true;
                }
                let is_reset_to_dispatchable =
                    repair_active && repair_action.as_deref() == Some("reset_to_dispatchable");
                if is_reset_to_dispatchable {
                    repair_reset_dispatchable = true;
                }

                // 孤儿 / 失联检测（仅对执行/交付/失败槽做诚实诊断）
                let is_exec_or_deliver = matches!(node_kind.as_str(), "generate" | "deliver");
                if state == "failed" || err.is_some() {
                    if !is_reset_to_dispatchable && orphan.is_none() {
                        orphan = Some(OrphanDiagnostic {
                            node_id: node_id.clone(),
                            stage: stage.clone(),
                            reason: err.clone().unwrap_or_else(|| {
                                format!("槽位「{stage}」异常失败且尚无恢复回执，状态未知")
                            }),
                            stalled_seconds: 0,
                            repair_actions: ALLOWED_ORPHAN_REPAIR_ACTIONS
                                .iter()
                                .map(|s| (*s).to_owned())
                                .collect(),
                        });
                    }
                } else if state == "running" && is_exec_or_deliver && !is_reset_to_dispatchable {
                    let latest_heartbeat = latest_ckpt_at
                        .map(|c| c.max(node_updated.as_str()))
                        .unwrap_or(node_updated.as_str());
                    let stalled_secs = match (now_epoch, parse_iso_epoch_secs(latest_heartbeat)) {
                        (Some(now_s), Some(hb_s)) => (now_s - hb_s).max(0),
                        _ => 0,
                    };
                    let failed_or_suspended_ckpt = matches!(
                        latest_ckpt_status.as_deref(),
                        Some("FAILED_RETRYABLE") | Some("SUSPENDED_HITL")
                    );
                    if failed_or_suspended_ckpt {
                        if orphan.is_none() {
                            orphan = Some(OrphanDiagnostic {
                                node_id: node_id.clone(),
                                stage: stage.clone(),
                                reason: format!(
                                    "槽位「{stage}」最近回执为 {} 且无后续成功回执，进程可能已失联",
                                    latest_ckpt_status.as_deref().unwrap_or("UNKNOWN")
                                ),
                                stalled_seconds: stalled_secs,
                                repair_actions: ALLOWED_ORPHAN_REPAIR_ACTIONS
                                    .iter()
                                    .map(|s| (*s).to_owned())
                                    .collect(),
                            });
                        }
                    } else if stalled_secs >= threshold {
                        if orphan.is_none() {
                            let mins = stalled_secs / 60;
                            orphan = Some(OrphanDiagnostic {
                                node_id: node_id.clone(),
                                stage: stage.clone(),
                                reason: format!(
                                    "槽位「{stage}」运行已超过 {mins} 分钟仍无新回执/Checkpoint（失联阈值 {} 分钟），已诚实标为未知",
                                    threshold / 60
                                ),
                                stalled_seconds: stalled_secs,
                                repair_actions: ALLOWED_ORPHAN_REPAIR_ACTIONS
                                    .iter()
                                    .map(|s| (*s).to_owned())
                                    .collect(),
                            });
                        }
                    } else {
                        has_live_running_slot = true;
                    }
                }

                slots.push(ReviewBoardSlotBrief {
                    node_id,
                    stage,
                    node_kind,
                    state: if is_reset_to_dispatchable && state == "running" {
                        "queued".to_owned()
                    } else {
                        state
                    },
                    latest_checkpoint_id: ckpt_info
                        .as_ref()
                        .map(|(id, _, _)| id.clone())
                        .or(latest_ckpt_id),
                    latest_checkpoint_status: latest_ckpt_status,
                    updated_at: node_updated,
                });
            }

            let classified = classify_board_bucket(&BoardClassificationSignals {
                doc_state: doc_state.clone(),
                pending_p0,
                pending_p1,
                pending_proposal_count: pending_proposals,
                decision_slot_suspended,
                has_live_running_slot,
                repair_suspended_hitl,
                repair_reset_dispatchable,
                orphan_reason: orphan.as_ref().map(|o| o.reason.clone()),
            });

            match classified.bucket {
                ReviewBoardBucket::PendingDecision => counts.pending_decision += 1,
                ReviewBoardBucket::Dispatchable => counts.dispatchable += 1,
                ReviewBoardBucket::AgentRunning => counts.agent_running += 1,
                ReviewBoardBucket::AwaitingReceipt => counts.awaiting_receipt += 1,
                ReviewBoardBucket::Completed => counts.completed += 1,
                ReviewBoardBucket::Unknown => counts.unknown += 1,
            }
            counts.total += 1;

            cards_with_rank.push((
                classified.bucket.urgency_rank(),
                ReviewBoardCard {
                    initiative_id,
                    name,
                    root_dir,
                    current_stage,
                    doc_state,
                    bucket: classified.bucket.as_str().to_owned(),
                    bucket_label: classified.bucket.label().to_owned(),
                    bucket_reason: classified.reason,
                    artifact_count,
                    pending_p0,
                    pending_p1,
                    pending_p2,
                    pending_proposals,
                    pending_statements: pending_statements.into_iter().take(5).collect(),
                    proposed_drafts: drafts.into_iter().take(3).collect(),
                    slots,
                    orphan,
                    updated_at,
                },
            ));
        }

        cards_with_rank.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(b.1.updated_at.cmp(&a.1.updated_at))
                .then(a.1.initiative_id.cmp(&b.1.initiative_id))
        });

        Ok(ReviewBoardResponse {
            ok: true,
            index_generation: ws.index_generation,
            generated_at,
            stall_threshold_secs: threshold,
            counts,
            items: cards_with_rank.into_iter().map(|(_, c)| c).collect(),
        })
    })
}

/// 检查指定专项是否存在于当前工作区（HTTP 入口快速 404 校验）
pub fn initiative_exists(store: &ReadonlyStore, initiative_id: &str) -> Result<bool, GuanlanError> {
    let ws_id = store.workspace()?.workspace_id.clone();
    store.read_txn(|conn| {
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM initiatives WHERE workspace_id = ? AND initiative_id = ?",
                params![ws_id, initiative_id],
                |r| r.get(0),
            )
            .map_err(internal_sql)?;
        Ok(found > 0)
    })
}

/// 孤儿节点修复结果
#[derive(Debug, Clone)]
pub struct OrphanRepairOutcome {
    pub initiative_id: String,
    pub node_id: String,
    pub stage: String,
    pub action: String,
    pub new_node_state: String,
    pub new_board_bucket: String,
    pub repaired_at: String,
}

/// 写线程执行：人工孤儿修复（仅允许安全重置为可派发或挂起待人工核查，严禁跳过审阅直接完结）
pub fn repair_orphan_node(
    writer: &mut Writer,
    initiative_id: &str,
    node_id: Option<&str>,
    action: &str,
    note: Option<&str>,
) -> Result<OrphanRepairOutcome, GuanlanError> {
    let valid_action = validate_orphan_repair_action(action)?;
    let ws = writer.workspace()?;
    let workspace_id = ws.workspace_id.clone();

    let _init = writer
        .get_initiative(&workspace_id, initiative_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到专项 {initiative_id}")))?;

    // 定位目标节点：优先显式 node_id，其次按专项内 running/failed 执行/交付槽自动定位
    let mut target = match node_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(nid) => writer
            .get_task_node(nid)?
            .filter(|n| n.initiative_id == initiative_id)
            .ok_or_else(|| GuanlanError::NotFound(format!("未找到任务节点 {nid}")))?,
        None => {
            let candidates = ["执行", "交付", "决策"];
            let mut found = None;
            for stage in candidates {
                if let Some(row) =
                    writer.find_task_node_by_stage(&workspace_id, initiative_id, stage)?
                {
                    if matches!(row.state.as_str(), "running" | "failed") || row.error.is_some() {
                        found = Some(row);
                        break;
                    }
                }
            }
            if found.is_none() {
                found = writer.find_task_node_by_stage(&workspace_id, initiative_id, "执行")?;
            }
            found.ok_or_else(|| {
                GuanlanError::NotFound(format!("专项 {initiative_id} 尚无可修复的任务槽位"))
            })?
        }
    };

    let now = clock::now_iso();
    let new_state = match valid_action {
        "reset_to_dispatchable" => "queued",
        "mark_suspended_hitl" => "suspended_on_hitl",
        _ => unreachable!(),
    };
    let new_bucket = match valid_action {
        "reset_to_dispatchable" => ReviewBoardBucket::Dispatchable.as_str(),
        "mark_suspended_hitl" => ReviewBoardBucket::PendingDecision.as_str(),
        _ => unreachable!(),
    };

    let mut payload_val: serde_json::Value =
        serde_json::from_str(&target.payload_json).unwrap_or_else(|_| serde_json::json!({}));
    if !payload_val.is_object() {
        payload_val = serde_json::json!({});
    }
    payload_val["orphan_repair"] = serde_json::json!({
        "action": valid_action,
        "repaired_at": now,
        "note": note.unwrap_or(""),
        "previous_state": target.state,
    });
    let old_state = target.state.clone();
    target.state = new_state.to_owned();
    target.error = None;
    target.payload_json = serde_json::to_string(&payload_val).unwrap_or_else(|_| "{}".to_owned());
    target.updated_at = now.clone();

    let target_node_id = target.node_id.clone();
    let target_stage = target.stage.clone();
    let reason_note = note.unwrap_or("人工触发孤儿修复");

    writer.transaction(|tx| {
        tx.upsert_task_node(&target)?;
        let evt_payload = json_object(&[
            ("initiative_id", json_string(initiative_id)),
            ("node_id", json_string(&target_node_id)),
            ("stage", json_string(&target_stage)),
            ("action", json_string(valid_action)),
            ("from_state", json_string(&old_state)),
            ("to_state", json_string(new_state)),
            ("note", json_string(reason_note)),
        ]);
        tx.insert_event(&NewEvent {
            event_id: format!(
                "evt_orphan_repaired_{}",
                stable_key(&format!("{target_node_id}|{valid_action}|{now}"))
            ),
            workspace_id,
            kind: "orphan_repaired".to_owned(),
            subject_kind: "task_node".to_owned(),
            subject_id: target_node_id.clone(),
            revision_id: None,
            occurred_at: Some(now.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("state_machine".to_owned()),
            observed_at: now.clone(),
            headline: format!(
                "孤儿节点修复：{}（{} {}→{}）",
                target_stage, valid_action, old_state, new_state
            ),
            detail: reason_note.to_owned(),
            payload_json: evt_payload,
            batch_id: None,
        })?;
        Ok(())
    })?;

    Ok(OrphanRepairOutcome {
        initiative_id: initiative_id.to_owned(),
        node_id: target_node_id,
        stage: target_stage,
        action: valid_action.to_owned(),
        new_node_state: new_state.to_owned(),
        new_board_bucket: new_bucket.to_owned(),
        repaired_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e04_board_classifier_never_skips_human_review_or_auto_completes_pending_work() {
        // 即使 doc_state 标为 delivered，只要有未审 Agent 草案，必须落在待批阅回执（停机红线）
        let with_draft = classify_board_bucket(&BoardClassificationSignals {
            doc_state: "delivered".to_owned(),
            pending_proposal_count: 1,
            ..Default::default()
        });
        assert_eq!(with_draft.bucket, ReviewBoardBucket::AwaitingReceipt);

        // 只要存在 P0/P1 未决，必须落在待拍板
        let with_p1 = classify_board_bucket(&BoardClassificationSignals {
            doc_state: "delivered".to_owned(),
            pending_p1: 1,
            ..Default::default()
        });
        assert_eq!(with_p1.bucket, ReviewBoardBucket::PendingDecision);

        // 失联/无回执一律诚实标 unknown
        let stalled = classify_board_bucket(&BoardClassificationSignals {
            doc_state: "executing".to_owned(),
            orphan_reason: Some("执行槽超时 45 分钟无回执".to_owned()),
            ..Default::default()
        });
        assert_eq!(stalled.bucket, ReviewBoardBucket::Unknown);

        // 仅当 delivered + 零阻塞 + 零待审 + 零失联才进已办结
        let clean_done = classify_board_bucket(&BoardClassificationSignals {
            doc_state: "delivered".to_owned(),
            ..Default::default()
        });
        assert_eq!(clean_done.bucket, ReviewBoardBucket::Completed);
    }

    #[test]
    fn e04_orphan_repair_rejects_skip_review_or_force_complete_actions() {
        assert!(validate_orphan_repair_action("reset_to_dispatchable").is_ok());
        assert!(validate_orphan_repair_action("mark_suspended_hitl").is_ok());
        assert!(validate_orphan_repair_action("complete").is_err());
        assert!(validate_orphan_repair_action("mark_completed").is_err());
        assert!(validate_orphan_repair_action("delivered").is_err());
    }

    #[test]
    fn e04_parse_iso_epoch_secs_computes_exact_stall_duration() {
        let t1 = parse_iso_epoch_secs("2026-11-21T10:00:00Z").expect("t1");
        let t2 = parse_iso_epoch_secs("2026-11-21T10:45:00.123Z").expect("t2");
        assert_eq!(t2 - t1, 2700);
    }
}
