//! 统一状态机 SSOT（参见 `native/docs/contract-storage.md` §4.3）。
//!
//! 三层结构中的**第②层（纯函数）**：
//! ①存储 = `initiatives` / `artifact_states` / `task_nodes` / `checkpoints` 表
//!   （[`crate::index::writer`]，`contract-storage.md` §4.3）；
//! ②本模块 = 六态枚举、迁移规则、五槽位声明式重算、checklist 计数、专项识别、
//!   token 估算——全部无 IO 纯函数，单测穷举；
//! ③前端投影 = `src/utils/stateProjection.ts`（与本模块同规则镜像）。
//!
//! 迁移规则（穷举表）：
//! - Draft→PendingReview 当 (pending_p0+pending_p1)>0；
//! - PendingReview→ApprovedRevision 当 p0==0 && p1==0 && has_selected_revision；
//! - ApprovedRevision→Executing 当 task_running（= 执行槽或交付槽 running，
//!   跨轮持久维持）；
//! - Executing→Delivered 当 checklist_total>0 && checklist_done==checklist_total
//!   && p0+p1==0 && 执行槽 completed && 交付槽 completed（具体槽位判据）；
//! - Delivered→Archived 当 user_accepted（唯一来源=archive 写线程置位）或
//!   last_activity_days>30；
//! - 逆向回流唯一边：state∈{executing,delivered} 且新未决 P0/P1>0 → PendingReview；
//! - Archived 终态仅 reopen 离开（写侧显式操作，不在本函数内）。
//!
//! signals 不落持久列：archive 一次性入参传入，每轮重算（避免双写源）。

use std::sync::OnceLock;

use regex::Regex;

use crate::domain::normalize_rel_path;
use crate::index::ident::stable_key;

/// 统一文档与专项状态机（SSOT）。wire 词为 snake_case。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocState {
    Draft,
    PendingReview,
    ApprovedRevision,
    Executing,
    Delivered,
    Archived,
}

impl DocState {
    pub fn as_str(self) -> &'static str {
        match self {
            DocState::Draft => "draft",
            DocState::PendingReview => "pending_review",
            DocState::ApprovedRevision => "approved_revision",
            DocState::Executing => "executing",
            DocState::Delivered => "delivered",
            DocState::Archived => "archived",
        }
    }

    /// 解析 wire 词；未知词返回 None（调用方按「待分类/未知」兜底或报错）
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "draft" => Some(DocState::Draft),
            "pending_review" => Some(DocState::PendingReview),
            "approved_revision" => Some(DocState::ApprovedRevision),
            "executing" => Some(DocState::Executing),
            "delivered" => Some(DocState::Delivered),
            "archived" => Some(DocState::Archived),
            _ => None,
        }
    }
}

/// 专项阶段。wire 词为中文（`current_stage`）。
/// 排序即流水线次序：待分类 < 蓝图 < 计划 < 决策 < 执行 < 交付
/// （`current_stage` 取已归类文档的最靠后阶段，详见 `contract-storage.md` §4.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Stage {
    Unclassified,
    Blueprint,
    Plan,
    Decision,
    Executing,
    Delivery,
}

/// 五个标准阶段槽位的固定次序（`task_nodes` 五槽位）。
pub const PIPELINE_STAGES: [Stage; 5] = [
    Stage::Blueprint,
    Stage::Plan,
    Stage::Decision,
    Stage::Executing,
    Stage::Delivery,
];

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Unclassified => "待分类",
            Stage::Blueprint => "蓝图",
            Stage::Plan => "计划",
            Stage::Decision => "决策",
            Stage::Executing => "执行",
            Stage::Delivery => "交付",
        }
    }

    /// 解析中文 wire 词；未知词返回 None
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "待分类" => Some(Stage::Unclassified),
            "蓝图" => Some(Stage::Blueprint),
            "计划" => Some(Stage::Plan),
            "决策" => Some(Stage::Decision),
            "执行" => Some(Stage::Executing),
            "交付" => Some(Stage::Delivery),
            _ => None,
        }
    }

    /// 阶段 → 槽位类型（`node_kind` 按阶段固定）：
    /// 蓝图→derive、计划→derive、决策→await_decision、执行→generate、交付→deliver
    pub fn slot_kind(self) -> Option<SlotKind> {
        match self {
            Stage::Blueprint | Stage::Plan => Some(SlotKind::Derive),
            Stage::Decision => Some(SlotKind::AwaitDecision),
            Stage::Executing => Some(SlotKind::Generate),
            Stage::Delivery => Some(SlotKind::Deliver),
            Stage::Unclassified => None,
        }
    }
}

/// 子任务节点持久态（`task_nodes.state`）。`suspended_on_hitl` 是**节点持久态**，
/// 只存在于 `task_nodes` 层——job 是瞬时执行载体，不承载挂起语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeState {
    Queued,
    Running,
    Completed,
    SuspendedOnHitl,
    Cancelled,
    Failed,
}

impl NodeState {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeState::Queued => "queued",
            NodeState::Running => "running",
            NodeState::Completed => "completed",
            NodeState::SuspendedOnHitl => "suspended_on_hitl",
            NodeState::Cancelled => "cancelled",
            NodeState::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "queued" => Some(NodeState::Queued),
            "running" => Some(NodeState::Running),
            "completed" => Some(NodeState::Completed),
            "suspended_on_hitl" => Some(NodeState::SuspendedOnHitl),
            "cancelled" => Some(NodeState::Cancelled),
            "failed" => Some(NodeState::Failed),
            _ => None,
        }
    }
}

/// 槽位类型（task_nodes.node_kind，按阶段固定）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SlotKind {
    Derive,
    AwaitDecision,
    Generate,
    Deliver,
}

impl SlotKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SlotKind::Derive => "derive",
            SlotKind::AwaitDecision => "await_decision",
            SlotKind::Generate => "generate",
            SlotKind::Deliver => "deliver",
        }
    }

    /// 槽位标题（task_nodes.title；确定性生成，登记 §4.3）
    pub fn title_word(self) -> &'static str {
        match self {
            SlotKind::Derive => "派生",
            SlotKind::AwaitDecision => "等待人工拍板",
            SlotKind::Generate => "生成执行",
            SlotKind::Deliver => "交付核验",
        }
    }
}

/// 状态迁移信号（纯函数入参；不落持久列，每轮重算）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StateSignals {
    pub pending_p0: u32,
    pub pending_p1: u32,
    pub pending_p2: u32,
    pub checklist_done: u32,
    pub checklist_total: u32,
    /// 是否存在已捕获版本（`selected_revision_id = files.last_revision_id`）
    pub has_selected_revision: bool,
    /// 该专项执行槽或交付槽 state=='running'（持久生产端：每轮 reconcile 重算维持）
    pub task_running: bool,
    /// 距最近活动（最新版本 occurred_at）的天数；无活动记录时为 0（不做超期归档）
    pub last_activity_days: u32,
}

/// 槽位门禁（Executing→Delivered 的具体槽位判据）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SlotGates {
    pub exec_completed: bool,
    pub deliver_completed: bool,
}

/// 超期自动归档阈值（天）。
pub const ARCHIVE_AFTER_IDLE_DAYS: u32 = 30;

/// 单步状态迁移（穷举表，见模块注释）。返回 None = 维持现状。
///
/// 迁移优先级：逆向回流边优先于正向边（executing/delivered 出现新的阻塞级
/// 未决时先回 PendingReview）；Archived 为终态，仅写侧显式 reopen 离开。
pub fn next_artifact_state(
    current: DocState,
    signals: &StateSignals,
    gates: &SlotGates,
    user_accepted: bool,
) -> Option<DocState> {
    let blocking_pending = signals.pending_p0 > 0 || signals.pending_p1 > 0;
    match current {
        DocState::Archived => None,
        DocState::Delivered => {
            if blocking_pending {
                Some(DocState::PendingReview)
            } else if user_accepted || signals.last_activity_days > ARCHIVE_AFTER_IDLE_DAYS {
                Some(DocState::Archived)
            } else {
                None
            }
        }
        DocState::Executing => {
            if blocking_pending {
                Some(DocState::PendingReview)
            } else if signals.checklist_total > 0
                && signals.checklist_done == signals.checklist_total
                && !blocking_pending
                && gates.exec_completed
                && gates.deliver_completed
            {
                Some(DocState::Delivered)
            } else {
                None
            }
        }
        DocState::ApprovedRevision => {
            if signals.task_running {
                Some(DocState::Executing)
            } else {
                None
            }
        }
        DocState::PendingReview => {
            if signals.pending_p0 == 0 && signals.pending_p1 == 0 && signals.has_selected_revision {
                Some(DocState::ApprovedRevision)
            } else {
                None
            }
        }
        DocState::Draft => {
            if blocking_pending {
                Some(DocState::PendingReview)
            } else {
                None
            }
        }
    }
}

/// 迁移到不动点：从持久化当前态出发逐步推进，返回**每一单步迁移**的路径
/// （同一文件的多级状态迁移身份互异，全部记账）。上限 = 6（六态环上
/// 最多 5 步；超出视为规则抖动，防御性截断）。
pub fn advance_to_fixpoint(
    current: DocState,
    signals: &StateSignals,
    gates: &SlotGates,
    user_accepted: bool,
) -> Vec<DocState> {
    let mut path = Vec::new();
    let mut state = current;
    for _ in 0..6 {
        let Some(next) = next_artifact_state(state, signals, gates, user_accepted) else {
            break;
        };
        path.push(next);
        state = next;
    }
    path
}

/// 槽位重算输入（各槽位判据，调用方从库内行推导）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SlotRules {
    /// 前置阶段槽位是否 completed（五槽位链式门禁；蓝图槽无前置，恒 true）
    pub upstream_completed: bool,
    /// 该阶段至少一个文档
    pub has_artifact: bool,
    /// 该阶段至少一个文档且有内容（以最新版本 `size_bytes > 0` 判定）
    pub stage_has_content: bool,
    /// 未决阻塞级事项数（P0+P1；决策槽与交付槽共用）
    pub pending_p0_p1: u32,
    /// 执行槽：是否存在 SUCCESS checkpoint（唯一完成通道）
    pub has_success_checkpoint: bool,
    /// 交付槽：该阶段文档 checklist 聚合（done/total）
    pub checklist_done: u32,
    pub checklist_total: u32,
}

/// 槽位状态声明式重算（单测穷举）。
///
/// **幂等性即 running 的持久性**：同输入重算结果稳定——每轮 reconcile 重算
/// 维持 running，直至完成条件满足或外部 checkpoint 到达。
pub fn slot_state(kind: SlotKind, r: &SlotRules) -> NodeState {
    if !r.upstream_completed {
        return NodeState::Queued;
    }
    match kind {
        SlotKind::Derive => {
            if !r.has_artifact {
                NodeState::Queued
            } else if !r.stage_has_content {
                NodeState::Running
            } else {
                NodeState::Completed
            }
        }
        SlotKind::AwaitDecision => {
            if r.pending_p0_p1 > 0 {
                NodeState::SuspendedOnHitl
            } else if r.has_artifact {
                NodeState::Completed
            } else {
                NodeState::Queued
            }
        }
        SlotKind::Generate => {
            if r.has_success_checkpoint {
                NodeState::Completed
            } else if r.has_artifact {
                NodeState::Running
            } else {
                NodeState::Queued
            }
        }
        SlotKind::Deliver => {
            if !r.has_artifact {
                NodeState::Queued
            } else if r.checklist_total > 0
                && r.checklist_done == r.checklist_total
                && r.pending_p0_p1 == 0
            {
                NodeState::Completed
            } else {
                NodeState::Running
            }
        }
    }
}

/// 节点 ID：`node_` + `stable_key(initiative_id|stage|slot)`，
/// 幂等可对拍（每轮重算同一节点得到同一 ID）。
pub fn node_id_of(initiative_id: &str, stage: Stage, kind: SlotKind) -> String {
    format!(
        "node_{}",
        stable_key(&format!(
            "{initiative_id}|{}|{}",
            stage.as_str(),
            kind.as_str()
        ))
    )
}

/// `task_running` 信号定义：该专项执行槽或交付槽 `state == "running"`
/// （持久生产端）。
pub fn task_running(generate: NodeState, deliver: NodeState) -> bool {
    generate == NodeState::Running || deliver == NodeState::Running
}

/// 交付清单计数：markdown 任务列表 `- [ ]` / `- [x]`。
/// 返回 (已完成, 总数)。跳过代码围栏内的行。
pub fn derive_checklist(content: &str) -> (u32, u32) {
    static CHECKLIST: OnceLock<Regex> = OnceLock::new();
    let item = CHECKLIST
        .get_or_init(|| Regex::new(r"(?m)^[ \t]*[-*][ \t]+\[([xX ])\]").expect("checklist 正则"));
    let mut done = 0u32;
    let mut total = 0u32;
    let mut in_fence = false;
    for line in content.split('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(captures) = item.captures(line) {
            total += 1;
            let mark = captures.get(1).map(|m| m.as_str()).unwrap_or(" ");
            if mark.eq_ignore_ascii_case("x") {
                done += 1;
            }
        }
    }
    (done, total)
}

/// 专项识别：默认 `current_path` 首段目录名匹配 `^\d{2}-` 或含「专项」；
/// `meta` 表键 `initiative_dirs`（JSON 字符串数组）追加目录名。
/// 返回首段目录名；顶层文件与未匹配目录返回 None。
///
/// 例如「BOM与图纸联动方案」这类不带数字前缀也不含「专项」的目录，不满足默认规则，
/// 须经 `initiative_dirs` 显式登记（`scan --initiative-dir` 或 `set_initiative_dirs`）。
pub fn recognize_initiative(relative_path: &str, initiative_dirs: &[String]) -> Option<String> {
    let normalized = normalize_rel_path(relative_path);
    let (first, _rest) = normalized.split_once('/')?;
    if first.is_empty() {
        return None;
    }
    if looks_numbered_dir(first) || first.contains("专项") {
        return Some(first.to_owned());
    }
    if initiative_dirs.iter().any(|dir| dir == first) {
        return Some(first.to_owned());
    }
    None
}

fn looks_numbered_dir(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[2] == b'-'
}

/// initiative_id（与 decision_id 同源）：`init_` + stable_key(首段目录名)
pub fn initiative_id_of(dir_name: &str) -> String {
    format!("init_{}", stable_key(dir_name))
}

/// 文档阶段判定（见 `contract-storage.md` §4.3）：按相对路径关键词短路匹配。
/// 次序：决策 → 计划 → 交付 → 蓝图 → 执行 → 待分类。
/// 依据：`detect_role` 的「决策」优先口径与阶段文档常见命名惯例
/// （如 03-待确认事项→决策、方案/计划→计划、交付清单→交付）。
pub fn stage_from_path(relative_path: &str) -> Stage {
    let path = normalize_rel_path(relative_path);
    let lowered = path.to_lowercase();
    if ["待确认", "已确认", "决策", "回执"]
        .iter()
        .any(|kw| lowered.contains(kw))
    {
        return Stage::Decision;
    }
    if ["方案", "计划", "设计"]
        .iter()
        .any(|kw| lowered.contains(kw))
    {
        return Stage::Plan;
    }
    if ["交付", "清单", "验收"]
        .iter()
        .any(|kw| lowered.contains(kw))
    {
        return Stage::Delivery;
    }
    if ["需求", "提案", "蓝图", "概要"]
        .iter()
        .any(|kw| lowered.contains(kw))
    {
        return Stage::Blueprint;
    }
    if ["执行", "实现", "联调"]
        .iter()
        .any(|kw| lowered.contains(kw))
    {
        return Stage::Executing;
    }
    Stage::Unclassified
}

fn is_cjk_codepoint(cp: u32) -> bool {
    (0x3000..=0x303F).contains(&cp)
        || (0x4E00..=0x9FFF).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0xFF01..=0xFF5E).contains(&cp)
}

/// est_tokens = ceil(cjk_chars*0.7 + non_cjk_bytes/3.5)。
/// 向量源 = `native/testdata/token-vectors.json`（git 内静态文件，
/// 双端同源；下方测试 include_str! 编译期读取，缺文件即编译错误而非运行时 panic）。
pub fn estimate_tokens(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut non_cjk_bytes = 0u64;
    for ch in text.chars() {
        if is_cjk_codepoint(ch as u32) {
            cjk += 1;
        } else {
            non_cjk_bytes += ch.len_utf8() as u64;
        }
    }
    let raw = cjk as f64 * 0.7 + non_cjk_bytes as f64 / 3.5;
    raw.ceil() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signals(
        p0: u32,
        p1: u32,
        done: u32,
        total: u32,
        selected: bool,
        running: bool,
        idle_days: u32,
    ) -> StateSignals {
        StateSignals {
            pending_p0: p0,
            pending_p1: p1,
            pending_p2: 0,
            checklist_done: done,
            checklist_total: total,
            has_selected_revision: selected,
            task_running: running,
            last_activity_days: idle_days,
        }
    }

    #[test]
    fn draft_to_pending_review_on_blocking_pending() {
        let gates = SlotGates::default();
        assert_eq!(
            next_artifact_state(
                DocState::Draft,
                &signals(1, 0, 0, 0, false, false, 0),
                &gates,
                false
            ),
            Some(DocState::PendingReview)
        );
        assert_eq!(
            next_artifact_state(
                DocState::Draft,
                &signals(0, 2, 0, 0, false, false, 0),
                &gates,
                false
            ),
            Some(DocState::PendingReview)
        );
        assert_eq!(
            next_artifact_state(
                DocState::Draft,
                &StateSignals {
                    pending_p2: 3,
                    ..Default::default()
                },
                &gates,
                false
            ),
            None
        );
        assert_eq!(
            next_artifact_state(
                DocState::Draft,
                &signals(0, 0, 0, 0, true, false, 0),
                &gates,
                false
            ),
            None
        );
    }

    #[test]
    fn pending_review_to_approved_requires_clean_and_selected() {
        let gates = SlotGates::default();
        assert_eq!(
            next_artifact_state(
                DocState::PendingReview,
                &signals(0, 0, 0, 0, true, false, 0),
                &gates,
                false
            ),
            Some(DocState::ApprovedRevision)
        );
        assert_eq!(
            next_artifact_state(
                DocState::PendingReview,
                &signals(0, 1, 0, 0, true, false, 0),
                &gates,
                false
            ),
            None
        );
        assert_eq!(
            next_artifact_state(
                DocState::PendingReview,
                &signals(0, 0, 0, 0, false, false, 0),
                &gates,
                false
            ),
            None
        );
    }

    #[test]
    fn approved_to_executing_requires_task_running() {
        let gates = SlotGates::default();
        assert_eq!(
            next_artifact_state(
                DocState::ApprovedRevision,
                &signals(0, 0, 0, 0, true, true, 0),
                &gates,
                false
            ),
            Some(DocState::Executing)
        );
        assert_eq!(
            next_artifact_state(
                DocState::ApprovedRevision,
                &signals(0, 0, 0, 0, true, false, 0),
                &gates,
                false
            ),
            None
        );
    }

    #[test]
    fn executing_to_delivered_requires_slots_and_checklist() {
        let full = SlotGates {
            exec_completed: true,
            deliver_completed: true,
        };
        assert_eq!(
            next_artifact_state(
                DocState::Executing,
                &signals(0, 0, 6, 6, true, false, 0),
                &full,
                false
            ),
            Some(DocState::Delivered)
        );
        assert_eq!(
            next_artifact_state(
                DocState::Executing,
                &signals(0, 0, 5, 6, true, false, 0),
                &full,
                false
            ),
            None
        );
        assert_eq!(
            next_artifact_state(
                DocState::Executing,
                &signals(0, 0, 0, 0, true, false, 0),
                &full,
                false
            ),
            None
        );
        let no_deliver = SlotGates {
            exec_completed: true,
            deliver_completed: false,
        };
        assert_eq!(
            next_artifact_state(
                DocState::Executing,
                &signals(0, 0, 6, 6, true, false, 0),
                &no_deliver,
                false
            ),
            None
        );
        let no_exec = SlotGates {
            exec_completed: false,
            deliver_completed: true,
        };
        assert_eq!(
            next_artifact_state(
                DocState::Executing,
                &signals(0, 0, 6, 6, true, false, 0),
                &no_exec,
                false
            ),
            None
        );
    }

    #[test]
    fn delivered_to_archived_by_accept_or_idle() {
        let gates = SlotGates::default();
        assert_eq!(
            next_artifact_state(
                DocState::Delivered,
                &signals(0, 0, 6, 6, true, false, 0),
                &gates,
                true
            ),
            Some(DocState::Archived)
        );
        assert_eq!(
            next_artifact_state(
                DocState::Delivered,
                &signals(0, 0, 6, 6, true, false, 31),
                &gates,
                false
            ),
            Some(DocState::Archived)
        );
        assert_eq!(
            next_artifact_state(
                DocState::Delivered,
                &signals(0, 0, 6, 6, true, false, 30),
                &gates,
                false
            ),
            None
        );
    }

    #[test]
    fn reverse_edge_executing_and_delivered_back_to_pending_review() {
        let gates = SlotGates::default();
        let full = SlotGates {
            exec_completed: true,
            deliver_completed: true,
        };
        assert_eq!(
            next_artifact_state(
                DocState::Executing,
                &signals(0, 1, 6, 6, true, false, 0),
                &full,
                false
            ),
            Some(DocState::PendingReview)
        );
        assert_eq!(
            next_artifact_state(
                DocState::Delivered,
                &signals(1, 0, 6, 6, true, false, 40),
                &gates,
                true
            ),
            Some(DocState::PendingReview)
        );
    }

    #[test]
    fn archived_is_terminal_only_reopen_leaves() {
        let gates = SlotGates::default();
        assert_eq!(
            next_artifact_state(
                DocState::Archived,
                &signals(1, 1, 6, 6, true, true, 90),
                &gates,
                true
            ),
            None
        );
    }

    #[test]
    fn fixpoint_records_every_single_step() {
        let gates = SlotGates::default();
        let path = advance_to_fixpoint(
            DocState::PendingReview,
            &signals(0, 0, 0, 0, true, true, 0),
            &gates,
            false,
        );
        assert_eq!(path, vec![DocState::ApprovedRevision, DocState::Executing]);
        assert!(advance_to_fixpoint(
            DocState::Archived,
            &signals(0, 0, 0, 0, false, false, 0),
            &gates,
            false
        )
        .is_empty());
    }

    fn rules(upstream: bool, artifact: bool, content: bool, pending: u32) -> SlotRules {
        SlotRules {
            upstream_completed: upstream,
            has_artifact: artifact,
            stage_has_content: content,
            pending_p0_p1: pending,
            has_success_checkpoint: false,
            checklist_done: 0,
            checklist_total: 0,
        }
    }

    #[test]
    fn derive_slot_exhaustive() {
        assert_eq!(
            slot_state(SlotKind::Derive, &rules(true, false, false, 0)),
            NodeState::Queued
        );
        assert_eq!(
            slot_state(SlotKind::Derive, &rules(true, true, false, 0)),
            NodeState::Running
        );
        assert_eq!(
            slot_state(SlotKind::Derive, &rules(true, true, true, 0)),
            NodeState::Completed
        );
        assert_eq!(
            slot_state(SlotKind::Derive, &rules(false, true, true, 0)),
            NodeState::Queued
        );
    }

    #[test]
    fn await_decision_slot_exhaustive() {
        assert_eq!(
            slot_state(SlotKind::AwaitDecision, &rules(true, true, true, 2)),
            NodeState::SuspendedOnHitl
        );
        assert_eq!(
            slot_state(SlotKind::AwaitDecision, &rules(true, true, true, 0)),
            NodeState::Completed
        );
        assert_eq!(
            slot_state(SlotKind::AwaitDecision, &rules(true, false, false, 0)),
            NodeState::Queued
        );
        assert_eq!(
            slot_state(SlotKind::AwaitDecision, &rules(false, true, true, 2)),
            NodeState::Queued
        );
    }

    #[test]
    fn generate_slot_exhaustive() {
        let mut with_ckpt = rules(true, true, true, 0);
        with_ckpt.has_success_checkpoint = true;
        assert_eq!(
            slot_state(SlotKind::Generate, &with_ckpt),
            NodeState::Completed
        );
        assert_eq!(
            slot_state(SlotKind::Generate, &rules(true, true, true, 0)),
            NodeState::Running
        );
        assert_eq!(
            slot_state(SlotKind::Generate, &rules(true, false, false, 0)),
            NodeState::Queued
        );
        assert_eq!(
            slot_state(SlotKind::Generate, &rules(false, true, true, 0)),
            NodeState::Queued
        );
    }

    #[test]
    fn deliver_slot_exhaustive() {
        let full = SlotRules {
            upstream_completed: true,
            has_artifact: true,
            stage_has_content: true,
            pending_p0_p1: 0,
            has_success_checkpoint: false,
            checklist_done: 6,
            checklist_total: 6,
        };
        assert_eq!(slot_state(SlotKind::Deliver, &full), NodeState::Completed);
        let open = SlotRules {
            checklist_done: 4,
            ..full
        };
        assert_eq!(slot_state(SlotKind::Deliver, &open), NodeState::Running);
        let empty = SlotRules {
            checklist_done: 0,
            checklist_total: 0,
            ..full
        };
        assert_eq!(slot_state(SlotKind::Deliver, &empty), NodeState::Running);
        let blocked = SlotRules {
            pending_p0_p1: 1,
            ..full
        };
        assert_eq!(slot_state(SlotKind::Deliver, &blocked), NodeState::Running);
        let gated = SlotRules {
            upstream_completed: false,
            ..full
        };
        assert_eq!(slot_state(SlotKind::Deliver, &gated), NodeState::Queued);
        let none = SlotRules {
            has_artifact: false,
            stage_has_content: false,
            ..full
        };
        assert_eq!(slot_state(SlotKind::Deliver, &none), NodeState::Queued);
    }

    #[test]
    fn slot_recompute_is_idempotent_for_running() {
        let r = rules(true, true, false, 0);
        let first = slot_state(SlotKind::Derive, &r);
        let second = slot_state(SlotKind::Derive, &r);
        assert_eq!(first, NodeState::Running);
        assert_eq!(first, second, "同输入重算必须同结果（running 跨轮维持）");
    }

    #[test]
    fn task_running_signal_definition() {
        assert!(task_running(NodeState::Running, NodeState::Queued));
        assert!(task_running(NodeState::Queued, NodeState::Running));
        assert!(!task_running(NodeState::Completed, NodeState::Completed));
        assert!(!task_running(NodeState::SuspendedOnHitl, NodeState::Queued));
    }

    #[test]
    fn stage_and_slot_mapping_is_fixed() {
        assert_eq!(Stage::Blueprint.slot_kind(), Some(SlotKind::Derive));
        assert_eq!(Stage::Plan.slot_kind(), Some(SlotKind::Derive));
        assert_eq!(Stage::Decision.slot_kind(), Some(SlotKind::AwaitDecision));
        assert_eq!(Stage::Executing.slot_kind(), Some(SlotKind::Generate));
        assert_eq!(Stage::Delivery.slot_kind(), Some(SlotKind::Deliver));
        assert_eq!(Stage::Unclassified.slot_kind(), None);
        assert_eq!(PIPELINE_STAGES.len(), 5);
    }

    #[test]
    fn checklist_counts_task_list_items() {
        let content = "- [x] 完成 A\n- [ ] 待办 B\n* [X] 完成 C\n普通文本 [x] 不算\n";
        assert_eq!(derive_checklist(content), (2, 3));
        let fenced = "```markdown\n- [x] 不算\n```\n- [x] 算\n";
        assert_eq!(derive_checklist(fenced), (1, 1));
        assert_eq!(derive_checklist(""), (0, 0));
        assert_eq!(derive_checklist("  - [x] 缩进项\n"), (1, 1));
    }

    #[test]
    fn numbered_dir_is_recognized() {
        assert_eq!(
            recognize_initiative("04-智能体代码/03-待确认事项.md", &[]),
            Some("04-智能体代码".to_owned())
        );
        assert_eq!(
            recognize_initiative("01-规划/README.md", &[]),
            Some("01-规划".to_owned())
        );
        assert_eq!(recognize_initiative("4-智能体/a.md", &[]), None);
        assert_eq!(recognize_initiative("docs/方案.md", &[]), None);
        assert_eq!(recognize_initiative("README.md", &[]), None);
    }

    #[test]
    fn keyword_and_meta_dirs_are_recognized() {
        assert_eq!(
            recognize_initiative("BOM专项/联动.md", &[]),
            Some("BOM专项".to_owned())
        );
        assert_eq!(recognize_initiative("BOM与图纸联动方案/x.md", &[]), None);
        let dirs = vec!["BOM与图纸联动方案".to_owned()];
        assert_eq!(
            recognize_initiative("BOM与图纸联动方案/x.md", &dirs),
            Some("BOM与图纸联动方案".to_owned())
        );
    }

    #[test]
    fn initiative_id_is_stable_per_dir_name() {
        let a = initiative_id_of("04-智能体代码");
        let b = initiative_id_of("04-智能体代码");
        assert_eq!(a, b);
        assert!(a.starts_with("init_"));
        assert_ne!(
            initiative_id_of("04-智能体代码"),
            initiative_id_of("05-智能体代码")
        );
    }

    #[test]
    fn stage_from_path_keyword_table() {
        assert_eq!(
            stage_from_path("docs/04-智能体代码/03-待确认事项.md"),
            Stage::Decision
        );
        assert_eq!(stage_from_path("docs/决策回执.md"), Stage::Decision);
        assert_eq!(stage_from_path("docs/04-智能体代码/方案.md"), Stage::Plan);
        assert_eq!(stage_from_path("docs/计划书.md"), Stage::Plan);
        assert_eq!(stage_from_path("docs/交付清单.md"), Stage::Delivery);
        assert_eq!(stage_from_path("docs/需求单.md"), Stage::Blueprint);
        assert_eq!(stage_from_path("docs/执行记录.md"), Stage::Executing);
        assert_eq!(stage_from_path("docs/随便.md"), Stage::Unclassified);
    }

    #[test]
    fn node_id_shape_and_wire_words() {
        let id = node_id_of("init_x", Stage::Executing, SlotKind::Generate);
        assert!(id.starts_with("node_"));
        assert_eq!(
            id,
            node_id_of("init_x", Stage::Executing, SlotKind::Generate)
        );
        assert_ne!(node_id_of("init_x", Stage::Plan, SlotKind::Derive), id);

        assert_eq!(DocState::parse("executing"), Some(DocState::Executing));
        assert_eq!(DocState::parse("nope"), None);
        assert_eq!(Stage::parse("蓝图"), Some(Stage::Blueprint));
        assert_eq!(Stage::parse("draft"), None);
        assert_eq!(
            NodeState::parse("suspended_on_hitl"),
            Some(NodeState::SuspendedOnHitl)
        );
        assert_eq!(SlotKind::AwaitDecision.as_str(), "await_decision");
    }

    const TOKEN_VECTORS_RAW: &str = include_str!("../../../../testdata/token-vectors.json");

    #[test]
    fn estimate_tokens_matches_shared_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(TOKEN_VECTORS_RAW).expect("token-vectors.json 不是合法 JSON");
        let rows = vectors["vectors"].as_array().expect("vectors 数组");
        assert!(
            rows.len() >= 12,
            "共享 token 估算向量数应 ≥12：{}",
            rows.len()
        );
        for row in rows {
            let input = row[0].as_str().expect("向量输入");
            let expected = row[1].as_u64().expect("向量期望值");
            assert_eq!(
                estimate_tokens(input),
                expected,
                "est_tokens({input:?}) 与共享向量不符"
            );
        }
    }

    #[test]
    fn estimate_tokens_boundary_codepoints() {
        assert_eq!(estimate_tokens("\u{2FFF}"), 1, "U+2FFF 非区间");
        assert_eq!(estimate_tokens("\u{3000}"), 1, "U+3000 区间内");
        assert_eq!(estimate_tokens("\u{303F}"), 1, "U+303F 区间内");
        assert_eq!(estimate_tokens("\u{4DFF}"), 1, "U+4DFF 非区间");
        assert_eq!(estimate_tokens("\u{4E00}"), 1, "U+4E00 区间内");
        assert_eq!(estimate_tokens("\u{9FFF}"), 1, "U+9FFF 区间内");
        assert_eq!(estimate_tokens("\u{F8FF}"), 1, "U+F8FF 区间内");
        assert_eq!(estimate_tokens("\u{F900}"), 1, "U+F900 区间内");
        assert_eq!(estimate_tokens("\u{FAFF}"), 1, "U+FAFF 区间内");
        assert_eq!(estimate_tokens("\u{FF00}"), 1, "U+FF00 区间内");
        assert_eq!(estimate_tokens("\u{FF01}"), 1, "U+FF01 区间内");
        assert_eq!(estimate_tokens("\u{FF5E}"), 1, "U+FF5E 区间内");
        assert_eq!(estimate_tokens("\u{FF5F}"), 1, "U+FF5F 非区间");
    }

    const STAGE_VECTORS_RAW: &str = include_str!("../../../../testdata/stage-vectors.json");

    #[test]
    fn stage_from_path_matches_shared_agree_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(STAGE_VECTORS_RAW).expect("stage-vectors.json 不是合法 JSON");
        let rows = vectors["agree"].as_array().expect("agree 数组");
        assert!(rows.len() >= 10, "共享同判向量应 ≥10：{}", rows.len());
        for row in rows {
            let path = row[0].as_str().expect("向量路径");
            let expected = row[1].as_str().expect("向量期望阶段");
            assert_eq!(
                stage_from_path(path).as_str(),
                expected,
                "stage_from_path({path}) 与共享向量不符（双端同步点：stage-vectors.json）"
            );
        }
    }

    #[test]
    fn stage_from_path_keeps_registered_divergences() {
        let vectors: serde_json::Value =
            serde_json::from_str(STAGE_VECTORS_RAW).expect("stage-vectors.json 不是合法 JSON");
        let rows = vectors["divergent_registered"]
            .as_array()
            .expect("divergent_registered 数组");
        for row in rows {
            let path = row[0].as_str().expect("向量路径");
            let rust_expected = row[2].as_str().expect("Rust 侧登记值");
            assert_eq!(
                stage_from_path(path).as_str(),
                rust_expected,
                "登记分叉变了：{path}（收敛分叉须先改 stage-vectors.json 并双侧同步实现）"
            );
        }
    }
}
