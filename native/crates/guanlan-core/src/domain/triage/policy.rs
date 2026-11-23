//! 政策守门矩阵与五道 fail-closed 安全闸（与 `workflow-policy.js` 规则 100% 逐项对齐）。
//!
//! - B04 六类高风险动作识别矩阵（`publish / payment / deletion / external-auth / account /
//!   irreversible-write`，含 D03 英文风险词表）——只报告匹配证据，绝不代用户决定；
//! - 显式授权校验（`authorize_risky_action`）：必须精确绑定 `task_id + plan_revision`，
//!   错配一律拒绝，本模块从不签发授权；
//! - 抢单大厅五道安全闸 fail-closed 判定（`evaluate_hall_eligibility`）：
//!   1. `delegate-lane`（非人工车道：`inform / login / decide` 与未定车道 100% 拦截）
//!   2. `has-acceptance`（有验收标准）
//!   3. `has-workspace`（有工作目录）
//!   4. `no-risky-actions`（无高风险动作）
//!   5. `no-risk-flags`（无规划风险提示）
//!
//!   五闸全过才返回 `eligible = true`，缺一即拦并附人类可读证据；
//! - B05 依赖图最大并行宽度与预算并发建议（`advisory_only = true`，只建议不强制）。

use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// 六类高风险动作类别（顺序与枚举名与 `workflow-policy.js::RISK_ACTIONS` 逐项一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RiskKind {
    #[serde(rename = "publish")]
    Publish,
    #[serde(rename = "payment")]
    Payment,
    #[serde(rename = "deletion")]
    Deletion,
    #[serde(rename = "external-auth")]
    ExternalAuth,
    #[serde(rename = "account")]
    Account,
    #[serde(rename = "irreversible-write")]
    IrreversibleWrite,
}

impl RiskKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Publish => "publish",
            Self::Payment => "payment",
            Self::Deletion => "deletion",
            Self::ExternalAuth => "external-auth",
            Self::Account => "account",
            Self::IrreversibleWrite => "irreversible-write",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Publish => "发布/上线",
            Self::Payment => "付款/订阅",
            Self::Deletion => "删除/清空",
            Self::ExternalAuth => "外部授权",
            Self::Account => "账号操作",
            Self::IrreversibleWrite => "不可逆写",
        }
    }
}

/// 静态风险类别定义（供 UI 与审计清单读取）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RiskActionDef {
    pub kind: RiskKind,
    pub label: &'static str,
    pub requires: &'static str,
}

const RISK_DEFS: &[RiskActionDef] = &[
    RiskActionDef {
        kind: RiskKind::Publish,
        label: "发布/上线",
        requires: "explicit-confirmation",
    },
    RiskActionDef {
        kind: RiskKind::Payment,
        label: "付款/订阅",
        requires: "explicit-confirmation",
    },
    RiskActionDef {
        kind: RiskKind::Deletion,
        label: "删除/清空",
        requires: "explicit-confirmation",
    },
    RiskActionDef {
        kind: RiskKind::ExternalAuth,
        label: "外部授权",
        requires: "explicit-confirmation",
    },
    RiskActionDef {
        kind: RiskKind::Account,
        label: "账号操作",
        requires: "explicit-confirmation",
    },
    RiskActionDef {
        kind: RiskKind::IrreversibleWrite,
        label: "不可逆写",
        requires: "explicit-confirmation",
    },
];

pub const fn risk_action_definitions() -> &'static [RiskActionDef] {
    RISK_DEFS
}

struct CompiledRiskAction {
    def: RiskActionDef,
    patterns: Vec<(&'static str, Regex)>,
}

fn compiled_risk_actions() -> &'static [CompiledRiskAction] {
    static COMPILED: OnceLock<Vec<CompiledRiskAction>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        let specs: &[(RiskActionDef, &[&str])] = &[
            (
                RISK_DEFS[0],
                &[
                    r"(?i)\b(?:publish|deploy|release)\b",
                    r"发布|上线|部署到(?:生产|正式)",
                ],
            ),
            (
                RISK_DEFS[1],
                &[
                    r"(?i)\b(?:pay(?:ment)?|checkout|subscribe)\b",
                    r"付款|支付|转账|购买|订阅收费",
                ],
            ),
            (
                RISK_DEFS[2],
                &[
                    r"(?i)\brm\s+-rf\b",
                    r"(?i)\bdelete\b|\bdrop\s+table\b",
                    r"删除文件|清空|永久移除",
                ],
            ),
            (
                RISK_DEFS[3],
                &[r"(?i)\boauth\b", r"授权(?:登录|第三方)?|关联第三方|开放权限"],
            ),
            (
                RISK_DEFS[4],
                &[
                    r"注销账号|修改密码|改绑(?:手机|邮箱)|绑定账号",
                    r"(?i)\b(?:reset|change)\s+(?:the\s+)?password\b|\b(?:unlink|remove)\s+(?:a\s+)?device\b|\bdelete\s+(?:my\s+)?account\b",
                ],
            ),
            (
                RISK_DEFS[5],
                &[
                    r"不可逆|格式化|覆盖写入|恢复出厂",
                    r"(?i)\bformat\s+(?:the\s+)?(?:disk|drive)\b|\bwipe\s+(?:the\s+)?(?:disk|database|data)\b|\bpermanently\s+(?:delete|overwrite|erase)\b",
                ],
            ),
        ];
        specs
            .iter()
            .map(|(def, raw_patterns)| CompiledRiskAction {
                def: *def,
                patterns: raw_patterns
                    .iter()
                    .map(|p| (*p, Regex::new(p).expect("valid risk regex")))
                    .collect(),
            })
            .collect()
    })
}

/// 政策判定统一任务输入。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PolicyTaskInput {
    pub id: String,
    pub lane: Option<String>,
    pub title: String,
    pub goal: String,
    pub question: String,
    pub impact: String,
    pub acknowledgement: String,
    pub workspace: String,
    pub status: String,
    pub constraints: Vec<String>,
    pub acceptance: Vec<String>,
    pub risks: Vec<String>,
    pub depends_on: Vec<String>,
}

/// 单个命中的高风险类别与正则证据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskHit {
    pub kind: RiskKind,
    pub label: String,
    pub requires: String,
    pub matched: Vec<String>,
}

/// 单任务风险识别报告（只报告证据，不拦截、不代决）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskReport {
    pub task_id: String,
    pub risky: bool,
    pub kinds: Vec<RiskHit>,
}

/// 批次级风险汇总。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskSummary {
    pub risky: bool,
    pub items: Vec<RiskReport>,
    pub counts: BTreeMap<RiskKind, usize>,
    pub risky_task_count: usize,
}

fn task_risk_text(task: &PolicyTaskInput) -> String {
    let mut parts: Vec<&str> =
        Vec::with_capacity(5 + task.constraints.len() + task.acceptance.len());
    parts.push(&task.title);
    parts.push(&task.goal);
    parts.push(&task.question);
    parts.push(&task.impact);
    parts.push(&task.acknowledgement);
    for c in &task.constraints {
        parts.push(c);
    }
    for a in &task.acceptance {
        parts.push(a);
    }
    parts.join("\n")
}

/// B04：识别单个任务命中的高风险动作类别（含中英双语词表，只提示不代决）。
pub fn detect_risky_actions(task: &PolicyTaskInput) -> RiskReport {
    let haystack = task_risk_text(task);
    let mut kinds = Vec::new();
    for action in compiled_risk_actions() {
        let matched: Vec<String> = action
            .patterns
            .iter()
            .filter(|(_, re)| re.is_match(&haystack))
            .map(|(src, _)| (*src).to_owned())
            .collect();
        if !matched.is_empty() {
            kinds.push(RiskHit {
                kind: action.def.kind,
                label: action.def.label.to_owned(),
                requires: action.def.requires.to_owned(),
                matched,
            });
        }
    }
    RiskReport {
        task_id: task.id.clone(),
        risky: !kinds.is_empty(),
        kinds,
    }
}

/// B04：批次/计划级风险汇总。
pub fn summarize_risky_actions(tasks: &[PolicyTaskInput]) -> RiskSummary {
    let items: Vec<RiskReport> = tasks
        .iter()
        .map(detect_risky_actions)
        .filter(|report| report.risky)
        .collect();
    let mut counts: BTreeMap<RiskKind, usize> = BTreeMap::new();
    for item in &items {
        for hit in &item.kinds {
            *counts.entry(hit.kind).or_insert(0) += 1;
        }
    }
    let risky_task_count = items.len();
    RiskSummary {
        risky: risky_task_count > 0,
        items,
        counts,
        risky_task_count,
    }
}

/// 人工显式授权凭证（必须绑定 `task_id` 与 `risky:{task_id}:{plan_revision}` 作用域）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskAuthorization {
    pub task_id: String,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationDecision {
    pub authorized: bool,
    pub reason: String,
    pub kinds: Vec<RiskHit>,
}

/// B04：显式授权校验（错配或缺失一律拒绝，从不自动签发授权）。
pub fn authorize_risky_action(
    task: &PolicyTaskInput,
    authorization: Option<&RiskAuthorization>,
    plan_revision: u64,
) -> AuthorizationDecision {
    let report = detect_risky_actions(task);
    if !report.risky {
        return AuthorizationDecision {
            authorized: true,
            reason: "无高风险动作".to_owned(),
            kinds: Vec::new(),
        };
    }
    let expected = format!("risky:{}:{plan_revision}", report.task_id);
    let Some(record) = authorization else {
        return AuthorizationDecision {
            authorized: false,
            reason: format!(
                "任务 {} 含高风险动作，需按 {expected} 显式确认",
                report.task_id
            ),
            kinds: Vec::new(),
        };
    };
    if record.task_id != report.task_id || record.scope != expected {
        return AuthorizationDecision {
            authorized: false,
            reason: format!("授权范围不匹配：期望 {expected}"),
            kinds: Vec::new(),
        };
    }
    AuthorizationDecision {
        authorized: true,
        reason: "授权匹配".to_owned(),
        kinds: report.kinds,
    }
}

/// 单道安全闸评估证据（通过时 `reason` 为空，拦截时给出人类可读理由）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateEvaluation {
    pub rule: String,
    pub label: String,
    pub passed: bool,
    pub reason: String,
}

/// 五道安全闸综合放行判定（`eligible = true` 当且仅当全部 5 闸通过，fail-closed）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HallEligibilityReport {
    pub task_id: String,
    pub eligible: bool,
    pub gates: Vec<GateEvaluation>,
}

fn gate(rule: &str, label: &str, passed: bool, blocked_reason: String) -> GateEvaluation {
    GateEvaluation {
        rule: rule.to_owned(),
        label: label.to_owned(),
        passed,
        reason: if passed {
            String::new()
        } else {
            blocked_reason
        },
    }
}

/// 抢单大厅五道安全闸 fail-closed 判定（与 `workflow-policy.js::evaluateHallEligibility` 100% 对齐）。
///
/// 任何人工车道（`inform / login / decide` 或空/未知车道）、无验收标准、无工作目录、
/// 命中高风险动作词或带规划风险提示的条目一律返回 `eligible = false`。
pub fn evaluate_hall_eligibility(task: Option<&PolicyTaskInput>) -> HallEligibilityReport {
    let default_task = PolicyTaskInput::default();
    let value = task.unwrap_or(&default_task);
    let lane_raw = value.lane.as_deref().unwrap_or("").trim().to_lowercase();
    // 严格 fail-closed：仅规范车道字面量 `delegate` 通过，任何人工车道/别名/未定一律拦截
    let is_delegate = lane_raw == "delegate";

    let risky = detect_risky_actions(value);
    let has_acceptance = value.acceptance.iter().any(|item| !item.trim().is_empty());
    let has_workspace = !value.workspace.trim().is_empty();
    let risk_flags: Vec<&str> = value
        .risks
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let lane_display = if lane_raw.is_empty() {
        "未定"
    } else {
        lane_raw.as_str()
    };
    let risky_labels = risky
        .kinds
        .iter()
        .map(|k| k.label.as_str())
        .collect::<Vec<_>>()
        .join("、");

    let gates = vec![
        gate(
            "delegate-lane",
            "非人工车道",
            is_delegate,
            format!("车道为「{lane_display}」，人工闭环任务不入厅"),
        ),
        gate(
            "has-acceptance",
            "有验收标准",
            has_acceptance,
            "无验收标准，评分闭环没有对照基线".to_owned(),
        ),
        gate(
            "has-workspace",
            "有工作目录",
            has_workspace,
            "无工作目录，Agent 会空转失败".to_owned(),
        ),
        gate(
            "no-risky-actions",
            "无高风险动作",
            !risky.risky,
            format!("命中高风险动作：{risky_labels}"),
        ),
        gate(
            "no-risk-flags",
            "无规划风险提示",
            risk_flags.is_empty(),
            format!("规划器已标记 {} 条风险提示", risk_flags.len()),
        ),
    ];

    let eligible = gates.iter().all(|g| g.passed);
    HallEligibilityReport {
        task_id: value.id.clone(),
        eligible,
        gates,
    }
}

/// B05：按依赖图计算最大并行波次宽度（存在环时安全收敛，跨批次未知依赖视为已满足）。
pub fn max_parallel_width(tasks: &[PolicyTaskInput]) -> usize {
    let valid: Vec<&PolicyTaskInput> = tasks.iter().filter(|t| !t.id.is_empty()).collect();
    let known_ids: HashSet<&str> = valid.iter().map(|t| t.id.as_str()).collect();
    let mut done: HashSet<&str> = HashSet::new();
    let mut width = 0usize;

    while done.len() < valid.len() {
        let ready: Vec<&str> = valid
            .iter()
            .filter(|t| {
                !done.contains(t.id.as_str())
                    && t.depends_on
                        .iter()
                        .all(|dep| done.contains(dep.as_str()) || !known_ids.contains(dep.as_str()))
            })
            .map(|t| t.id.as_str())
            .collect();
        if ready.is_empty() {
            break;
        }
        width = width.max(ready.len());
        for id in ready {
            done.insert(id);
        }
    }
    width
}

/// B05：确定性预算与并发建议（恒为 `advisory_only = true`，只建议不强制）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetRecommendation {
    pub suggested_max_concurrency: usize,
    pub estimated_runs: usize,
    pub max_parallel_width: usize,
    pub hints: Vec<String>,
    pub advisory_only: bool,
}

pub fn recommend_workflow_budget(tasks: &[PolicyTaskInput]) -> BudgetRecommendation {
    let lane_of = |t: &PolicyTaskInput| t.lane.as_deref().unwrap_or("").trim().to_lowercase();
    let delegate_count = tasks.iter().filter(|t| lane_of(t) == "delegate").count();
    let human_pending = tasks
        .iter()
        .filter(|t| {
            let l = lane_of(t);
            (l == "login" || l == "decide") && t.status != "completed"
        })
        .count();
    let policy = summarize_risky_actions(tasks);
    let width = max_parallel_width(tasks);

    let mut suggested_max_concurrency = 3usize.min(width.max(1)).min(delegate_count.max(1)).max(1);
    if policy.risky_task_count > 0 {
        suggested_max_concurrency = suggested_max_concurrency.min(2);
    }
    let estimated_runs = delegate_count
        + usize::from(policy.risky_task_count > 0)
        + usize::from(delegate_count >= 4);

    let mut hints = vec![format!(
        "并行宽度 {width}，可交给 Agent 的子任务 {delegate_count} 项"
    )];
    if policy.risky_task_count > 0 {
        hints.push(format!(
            "含 {} 个高风险任务：建议并发不超过 2，且逐项人工显式确认",
            policy.risky_task_count
        ));
    }
    if human_pending > 0 {
        hints.push(format!(
            "{human_pending} 项登录/决策人工事项会阻塞流水线，建议先办理"
        ));
    }

    BudgetRecommendation {
        suggested_max_concurrency,
        estimated_runs,
        max_parallel_width: width,
        hints,
        advisory_only: true,
    }
}
