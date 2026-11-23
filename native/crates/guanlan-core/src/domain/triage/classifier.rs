//! 四车道可解释分流器与 E7 入厅降噪（与 `workflow-triage.js` 规则 100% 逐项对齐）。
//!
//! - 显式声明（Frontmatter `workflow / route / needs` 或任务级 `lane`）优先于关键词推断；
//! - 确定性四组规则按固定优先级求值：`login` → `decide` → `inform` → `delegate` → 保守回退 `inform`；
//! - E7 降噪：签字栏/日期下划线占位行与 `ARCH、PO` 会签残行进 `filtered(template)`；
//!   带验收口吻且缩进挂靠父任务或 30 行内紧随真任务的勾选项并入父任务 `acceptance_criteria`；
//!   宁可漏放（当真任务）也不误杀，所有被过滤条目留证于 `WorkflowIndex.filtered`；
//! - B03 人工分栏完备性需求表（`human_field_requirements` / `human_readiness_hints`）与规划器同源。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::domain::sha256_hex;

/// 丞相台四车道枚举（`inform / login / decide / delegate`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriageLane {
    Inform,
    Login,
    Decide,
    Delegate,
}

/// 排序固定优先级（与 `workflow-triage.js::LANE_ORDER` 一致：决策 → 登录 → 知悉 → 可交 Agent）。
pub const LANE_ORDER: [TriageLane; 4] = [
    TriageLane::Decide,
    TriageLane::Login,
    TriageLane::Inform,
    TriageLane::Delegate,
];

/// 单车道静态元信息（与 `workflow-triage.js::LANES` 逐字一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LaneMetadata {
    pub id: TriageLane,
    pub label: &'static str,
    pub icon: &'static str,
    pub description: &'static str,
}

impl TriageLane {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inform => "inform",
            Self::Login => "login",
            Self::Decide => "decide",
            Self::Delegate => "delegate",
        }
    }

    pub const fn metadata(self) -> LaneMetadata {
        match self {
            Self::Inform => LaneMetadata {
                id: Self::Inform,
                label: "朕要知道",
                icon: "eye",
                description: "需要你阅读、掌握或留档的内容",
            },
            Self::Login => LaneMetadata {
                id: Self::Login,
                label: "需要登录",
                icon: "key-round",
                description: "需要你亲自登录账号、授权或处理验证码",
            },
            Self::Decide => LaneMetadata {
                id: Self::Decide,
                label: "等我决策",
                icon: "scale",
                description: "需要你确认、取舍、批准或给出方向",
            },
            Self::Delegate => LaneMetadata {
                id: Self::Delegate,
                label: "可交给 Agent",
                icon: "send",
                description: "目标和验收相对明确，可以整理成执行卡",
            },
        }
    }

    pub const fn order_rank(self) -> usize {
        match self {
            Self::Decide => 0,
            Self::Login => 1,
            Self::Inform => 2,
            Self::Delegate => 3,
        }
    }

    /// 是否属人工闭环车道（`inform / login / decide` 均禁止绕过人工直接自动派发）。
    pub const fn is_human_lane(self) -> bool {
        !matches!(self, Self::Delegate)
    }
}

struct LaneRule {
    lane: TriageLane,
    words: &'static [&'static str],
}

/// 确定性关键词规则表（顺序与词条与 `workflow-triage.js::RULES` 逐项一致，绝不包装成黑盒概率）。
const RULES: &[LaneRule] = &[
    LaneRule {
        lane: TriageLane::Login,
        words: &[
            "登录",
            "登陆",
            "账号",
            "密码",
            "验证码",
            "二次验证",
            "2fa",
            "授权",
            "token",
            "cookie",
            "控制台",
            "后台",
            "签到",
        ],
    },
    LaneRule {
        lane: TriageLane::Decide,
        words: &[
            "决策",
            "请示",
            "待定",
            "选择",
            "是否",
            "方案",
            "批准",
            "同意",
            "确认",
            "要不要",
            "取舍",
            "预算",
            "价格",
            "发布",
        ],
    },
    LaneRule {
        lane: TriageLane::Inform,
        words: &[
            "汇报", "简报", "摘要", "结论", "知悉", "了解", "备忘", "复盘", "日报", "周报", "通知",
            "公告",
        ],
    },
    LaneRule {
        lane: TriageLane::Delegate,
        words: &[
            "修复", "开发", "实现", "测试", "整理", "生成", "编写", "调研", "执行", "重构", "迁移",
            "补齐", "检查", "清理",
        ],
    },
];

/// 单条分类输入（对应 `workflow-triage.js::classifyWorkflowItem` 的字段集）。
#[derive(Debug, Clone, Default)]
pub struct ClassificationInput<'a> {
    pub text: Option<&'a str>,
    pub raw_text: Option<&'a str>,
    pub title: Option<&'a str>,
    pub name: Option<&'a str>,
    pub category: Option<&'a str>,
    pub subject: Option<&'a str>,
    pub doc_type: Option<&'a str>,
    pub workflow: Option<&'a str>,
    pub route: Option<&'a str>,
    pub needs: Option<&'a str>,
    pub lane: Option<&'a str>,
}

/// 可解释分流判定结果（纯确定性理由 + 命中词列表，绝无黑盒 AI 概率分数）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriageClassification {
    pub lane: TriageLane,
    pub reason: String,
    pub matched: Vec<String>,
    /// true = 来自 Frontmatter / 来源显式指定，而非关键词命中。
    pub explicit: bool,
}

fn normalize_text(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_lowercase()
}

/// 解析显式车道声明（支持中英文 12 项别名，与 `workflow-triage.js::explicitLane` 逐字一致）。
pub fn explicit_lane(
    workflow: Option<&str>,
    route: Option<&str>,
    needs: Option<&str>,
    lane: Option<&str>,
) -> Option<TriageLane> {
    let raw = [workflow, route, needs, lane]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())?;
    let value = raw.trim().to_lowercase();
    if value.is_empty() {
        return None;
    }
    match value.as_str() {
        "inform" | "knowledge" | "朕要知道" => Some(TriageLane::Inform),
        "login" | "auth" | "需要登录" => Some(TriageLane::Login),
        "decide" | "decision" | "等我决策" => Some(TriageLane::Decide),
        "delegate" | "agent" | "可交给 agent" => Some(TriageLane::Delegate),
        _ => None,
    }
}

/// 确定性四车道分流（显式覆盖 → 登录 → 决策 → 知悉 → 可交 Agent → 默认知悉）。
pub fn classify_workflow_item(input: &ClassificationInput<'_>) -> TriageClassification {
    if let Some(lane) = explicit_lane(input.workflow, input.route, input.needs, input.lane) {
        return TriageClassification {
            lane,
            reason: "来源明确指定分栏".to_owned(),
            matched: Vec::new(),
            explicit: true,
        };
    }

    let source = [
        input.text,
        input.raw_text,
        input.title,
        input.name,
        input.category,
        input.subject,
        input.doc_type,
    ]
    .into_iter()
    .map(normalize_text)
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ");

    for rule in RULES {
        let matched: Vec<String> = rule
            .words
            .iter()
            .filter(|word| source.contains(&word.to_lowercase()))
            .map(|word| (*word).to_owned())
            .collect();
        if !matched.is_empty() {
            let shown = matched
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join("、");
            return TriageClassification {
                lane: rule.lane,
                reason: format!("命中关键词：{shown}"),
                matched,
                explicit: false,
            };
        }
    }

    TriageClassification {
        lane: TriageLane::Inform,
        reason: "暂未识别为登录、决策或明确执行事项".to_owned(),
        matched: Vec::new(),
        explicit: false,
    }
}

fn template_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?:签名|签字|签署)[：:]?\s*(?:[_＿*—﹣﹏─\-·.．]{4,}|请在此处)")
                .expect("valid template pattern 1"),
            Regex::new(r"(?i)(?:日期|date)[：:]?\s*[_＿*—﹣﹏─\-·.．]{4,}")
                .expect("valid template pattern 2"),
            Regex::new(r"[_＿—﹣─]{4,}\s*[，,]?\s*[_＿—﹣─]{4,}\s*日期")
                .expect("valid template pattern 3"),
            Regex::new(r"^[_＿—﹣─\s]{6,}$").expect("valid template pattern 4"),
            Regex::new(r"(?i)\barch\b[、,，\s]+\bpo\b").expect("valid template pattern 5"),
        ]
    })
}

fn underline_run_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[_＿*—﹣﹏─\-·.．]{4,}").expect("valid underline regex"))
}

fn sign_off_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:签名|签字|签署)").expect("valid signoff regex"))
}

fn dated_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:日期|date)").expect("valid dated regex"))
}

fn acceptance_cue_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:验收|通过标准|通过条件|符合以下|满足以下|达成|完成标准|完成定义|支持|包含|覆盖|输出|提供|交付|可校验|可验证|expected|acceptance)",
        )
        .expect("valid acceptance cue regex")
    })
}

fn already_prefixed_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:[-*+]\s+\[[ xX/]\]\s+|TODO:\s*)").expect("valid prefix regex")
    })
}

/// E7 模板占位行判定（与 `workflow-triage.js::isTemplatePlaceholderLine` 逐项一致）。
pub fn is_template_placeholder_line(value: &str) -> bool {
    let text = value.trim();
    if text.is_empty() {
        return false;
    }
    if template_patterns().iter().any(|re| re.is_match(text)) {
        return true;
    }
    let sign_off = sign_off_re().is_match(text);
    let dated = dated_re().is_match(text);
    (sign_off || dated) && underline_run_re().is_match(text)
}

/// 任务语法种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskSyntax {
    Checkbox,
    Progress,
    Todo,
    #[default]
    Document,
}

impl TaskSyntax {
    pub const fn is_nestable(self) -> bool {
        matches!(self, Self::Checkbox | Self::Progress)
    }
}

/// 文档办理元数据（只读 Frontmatter 产物）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowMeta {
    pub account: String,
    pub login_url: String,
    pub question: String,
    pub options: Vec<String>,
    pub impact: String,
    pub acknowledgement: String,
}

/// 单条任务输入。
#[derive(Debug, Clone, Default)]
pub struct TriageTaskInput {
    pub id: String,
    pub path: String,
    pub line: usize,
    pub text: String,
    pub raw_text: String,
    pub completed: bool,
    pub syntax: TaskSyntax,
    pub indent: usize,
    pub workflow: Option<String>,
    pub route: Option<String>,
    pub needs: Option<String>,
    pub lane: Option<String>,
}

/// 单份文档输入。
#[derive(Debug, Clone, Default)]
pub struct TriageFileInput {
    pub path: String,
    pub name: String,
    pub title: String,
    pub doc_type: String,
    pub workflow: Option<String>,
    pub workflow_meta: WorkflowMeta,
    pub category: String,
    pub subject: String,
    pub modified_at: i64,
    pub tasks: Vec<TriageTaskInput>,
}

/// 来源证据定位（保留原文路径、1-based 行号与可核对的 `expected_text`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub stable_id: Option<String>,
    pub path: String,
    pub line: usize,
    pub expected_text: String,
    pub text: String,
    pub syntax: TaskSyntax,
}

/// 分流后的工作流条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowItem {
    pub id: String,
    pub lane: TriageLane,
    pub lane_label: String,
    pub lane_icon: String,
    pub reason: String,
    pub matched_keywords: Vec<String>,
    pub title: String,
    pub source: SourceRef,
    pub file_title: String,
    pub category: String,
    pub subject: String,
    pub completed: bool,
    pub updated_at: i64,
    pub workflow_meta: WorkflowMeta,
    pub acceptance_criteria: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilteredKind {
    Template,
    Acceptance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilteredItem {
    pub id: String,
    pub kind: FilteredKind,
    pub title: String,
    pub path: String,
    pub line: usize,
    pub merged_into: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct FilteredSummary {
    pub version: u32,
    pub template: usize,
    pub acceptance: usize,
    pub total: usize,
    pub items: Vec<FilteredItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowIndex {
    pub version: u32,
    pub items: Vec<WorkflowItem>,
    pub counts: BTreeMap<TriageLane, usize>,
    pub filtered: FilteredSummary,
}

fn non_empty_str<'a>(candidates: &[&'a str]) -> &'a str {
    candidates
        .iter()
        .copied()
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

fn stable_workflow_id(explicit_id: &str, path: &str, line: usize, text: &str) -> String {
    if !explicit_id.is_empty() {
        return format!("workflow-{explicit_id}");
    }
    let payload = format!("{path}:{line}:{text}");
    let digest = sha256_hex(payload.as_bytes());
    format!("workflow-{}", &digest[..16])
}

/// 构造来源定位记录（与 `workflow-triage.js::sourceRef` 逐项一致）。
pub fn source_ref(task: &TriageTaskInput, file: &TriageFileInput) -> SourceRef {
    let raw = non_empty_str(&[&task.raw_text, &task.text, &file.title, &file.name]).trim();
    let expected_text = if already_prefixed_re().is_match(raw) {
        raw.to_owned()
    } else {
        match task.syntax {
            TaskSyntax::Todo => format!("TODO: {raw}"),
            TaskSyntax::Progress => format!("- [/] {raw}"),
            TaskSyntax::Checkbox => {
                format!("- [{}] {raw}", if task.completed { "x" } else { " " })
            }
            TaskSyntax::Document => raw.to_owned(),
        }
    };
    let text = non_empty_str(&[&task.text, &task.raw_text, &file.title, &file.name]).to_owned();
    let path = if !task.path.is_empty() {
        task.path.clone()
    } else {
        file.path.clone()
    };
    SourceRef {
        stable_id: if task.id.is_empty() {
            None
        } else {
            Some(task.id.clone())
        },
        path,
        line: task.line,
        expected_text,
        text,
        syntax: task.syntax,
    }
}

/// 单条任务转工作流条目（保留完整来源行号、命中理由与办理元数据）。
pub fn to_workflow_item(task: &TriageTaskInput, file: &TriageFileInput) -> WorkflowItem {
    let workflow_override = task
        .workflow
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| file.workflow.as_deref().filter(|s| !s.is_empty()));
    let classification = classify_workflow_item(&ClassificationInput {
        text: Some(&task.text),
        raw_text: Some(&task.raw_text),
        title: Some(&file.title),
        name: Some(&file.name),
        category: Some(&file.category),
        subject: Some(&file.subject),
        doc_type: Some(&file.doc_type),
        workflow: workflow_override,
        route: task.route.as_deref(),
        needs: task.needs.as_deref(),
        lane: task.lane.as_deref(),
    });
    let sref = source_ref(task, file);
    let id = stable_workflow_id(&task.id, &sref.path, sref.line, &sref.text);
    let meta = classification.lane.metadata();
    let file_title = non_empty_str(&[
        &file.title,
        &file.name,
        sref.path.rsplit(['/', '\\']).next().unwrap_or(&sref.path),
    ])
    .to_owned();
    let mut workflow_meta = file.workflow_meta.clone();
    workflow_meta.options.truncate(8);

    WorkflowItem {
        id,
        lane: classification.lane,
        lane_label: meta.label.to_owned(),
        lane_icon: meta.icon.to_owned(),
        reason: classification.reason,
        matched_keywords: classification.matched,
        title: sref.text.clone(),
        source: sref,
        file_title,
        category: if file.category.is_empty() {
            "未分类".to_owned()
        } else {
            file.category.clone()
        },
        subject: if file.subject.is_empty() {
            "未指定".to_owned()
        } else {
            file.subject.clone()
        },
        completed: task.completed,
        updated_at: file.modified_at,
        workflow_meta,
        acceptance_criteria: Vec::new(),
    }
}

struct AncestorAnchor {
    indent: usize,
    task_id: String,
    item_idx: Option<usize>,
}

/// 逐文件降噪构建四车道工作流索引（与 `workflow-triage.js::buildWorkflowIndex` 逐项一致）。
pub fn build_workflow_index(files: &[TriageFileInput]) -> WorkflowIndex {
    let mut items: Vec<WorkflowItem> = Vec::new();
    let mut filtered_items: Vec<FilteredItem> = Vec::new();
    let mut filtered_template = 0usize;
    let mut filtered_acceptance = 0usize;

    for file in files {
        if file.tasks.is_empty() {
            let doc_title = non_empty_str(&[&file.title, &file.name]).to_owned();
            let doc_task = TriageTaskInput {
                id: format!("file-{}", file.path),
                path: file.path.clone(),
                line: 0,
                text: doc_title.clone(),
                raw_text: doc_title,
                completed: false,
                syntax: TaskSyntax::Document,
                indent: 0,
                workflow: None,
                route: None,
                needs: None,
                lane: None,
            };
            items.push(to_workflow_item(&doc_task, file));
            continue;
        }

        let mut ancestors: Vec<AncestorAnchor> = Vec::new();
        let mut last_item_idx: Option<usize> = None;

        for task in &file.tasks {
            let check_text = if !task.raw_text.is_empty() {
                &task.raw_text
            } else {
                &task.text
            };
            if is_template_placeholder_line(check_text) {
                filtered_template += 1;
                filtered_items.push(FilteredItem {
                    id: task.id.clone(),
                    kind: FilteredKind::Template,
                    title: task.text.clone(),
                    path: file.path.clone(),
                    line: task.line,
                    merged_into: None,
                });
                continue;
            }

            let nestable = task.syntax.is_nestable();
            if nestable {
                while ancestors
                    .last()
                    .is_some_and(|anc| anc.indent >= task.indent)
                {
                    ancestors.pop();
                }
            }

            if task.completed {
                if nestable {
                    ancestors.push(AncestorAnchor {
                        indent: task.indent,
                        task_id: task.id.clone(),
                        item_idx: None,
                    });
                }
                continue;
            }

            let cue_match = acceptance_cue_re().is_match(&task.text);
            let parent_anchor = if nestable { ancestors.last() } else { None };
            if cue_match {
                if let Some(anchor) = parent_anchor {
                    let merged_into = if let Some(idx) = anchor.item_idx {
                        items[idx].acceptance_criteria.push(task.text.clone());
                        Some(items[idx].id.clone())
                    } else {
                        Some(anchor.task_id.clone())
                    };
                    filtered_acceptance += 1;
                    filtered_items.push(FilteredItem {
                        id: task.id.clone(),
                        kind: FilteredKind::Acceptance,
                        title: task.text.clone(),
                        path: file.path.clone(),
                        line: task.line,
                        merged_into,
                    });
                    ancestors.push(AncestorAnchor {
                        indent: task.indent,
                        task_id: task.id.clone(),
                        item_idx: None,
                    });
                    continue;
                }
                if let Some(last_idx) = last_item_idx {
                    let last_line = items[last_idx].source.line as i64;
                    if (task.line as i64) - last_line <= 30 {
                        items[last_idx].acceptance_criteria.push(task.text.clone());
                        let merged_id = items[last_idx].id.clone();
                        filtered_acceptance += 1;
                        filtered_items.push(FilteredItem {
                            id: task.id.clone(),
                            kind: FilteredKind::Acceptance,
                            title: task.text.clone(),
                            path: file.path.clone(),
                            line: task.line,
                            merged_into: Some(merged_id),
                        });
                        continue;
                    }
                }
            }

            let item = to_workflow_item(task, file);
            let new_idx = items.len();
            items.push(item);
            last_item_idx = Some(new_idx);
            if nestable {
                ancestors.push(AncestorAnchor {
                    indent: task.indent,
                    task_id: task.id.clone(),
                    item_idx: Some(new_idx),
                });
            }
        }
    }

    items.sort_by(|a, b| {
        a.lane
            .order_rank()
            .cmp(&b.lane.order_rank())
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.title.cmp(&b.title))
    });

    let mut counts = BTreeMap::new();
    for lane in [
        TriageLane::Inform,
        TriageLane::Login,
        TriageLane::Decide,
        TriageLane::Delegate,
    ] {
        let n = items.iter().filter(|item| item.lane == lane).count();
        counts.insert(lane, n);
    }

    WorkflowIndex {
        version: 2,
        items,
        counts,
        filtered: FilteredSummary {
            version: 1,
            template: filtered_template,
            acceptance: filtered_acceptance,
            total: filtered_template + filtered_acceptance,
            items: filtered_items,
        },
    }
}

/// B03 人工分栏完备性缺项级别（`block` 阻塞批准，`warn` 建议补齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HumanFieldSeverity {
    Block,
    Warn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HumanFieldRequirement {
    pub field: &'static str,
    pub label: &'static str,
    pub severity: HumanFieldSeverity,
}

const LOGIN_REQUIREMENTS: &[HumanFieldRequirement] = &[
    HumanFieldRequirement {
        field: "question",
        label: "办理问题",
        severity: HumanFieldSeverity::Block,
    },
    HumanFieldRequirement {
        field: "loginUrl",
        label: "登录地址",
        severity: HumanFieldSeverity::Warn,
    },
    HumanFieldRequirement {
        field: "account",
        label: "账号说明",
        severity: HumanFieldSeverity::Warn,
    },
];

const DECIDE_REQUIREMENTS: &[HumanFieldRequirement] = &[
    HumanFieldRequirement {
        field: "question",
        label: "决策问题",
        severity: HumanFieldSeverity::Block,
    },
    HumanFieldRequirement {
        field: "options",
        label: "候选项",
        severity: HumanFieldSeverity::Block,
    },
    HumanFieldRequirement {
        field: "impact",
        label: "影响说明",
        severity: HumanFieldSeverity::Warn,
    },
];

const INFORM_REQUIREMENTS: &[HumanFieldRequirement] = &[
    HumanFieldRequirement {
        field: "acknowledgement",
        label: "确认说明",
        severity: HumanFieldSeverity::Block,
    },
    HumanFieldRequirement {
        field: "impact",
        label: "影响说明",
        severity: HumanFieldSeverity::Warn,
    },
];

/// 单一权威人工分栏完备性需求表（与 `workflow-triage.js::HUMAN_FIELD_REQUIREMENTS` 逐项一致）。
pub const fn human_field_requirements(lane: TriageLane) -> &'static [HumanFieldRequirement] {
    match lane {
        TriageLane::Login => LOGIN_REQUIREMENTS,
        TriageLane::Decide => DECIDE_REQUIREMENTS,
        TriageLane::Inform => INFORM_REQUIREMENTS,
        TriageLane::Delegate => &[],
    }
}

/// 缺失字段提示（只报告，不自动捏造补全）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanReadinessHint {
    pub lane: TriageLane,
    pub field: String,
    pub label: String,
    pub severity: HumanFieldSeverity,
    pub hint: String,
}

/// B03：按 `WorkflowMeta` 报告人工分栏缺失要素（完备项或 `delegate` 车道返回空）。
pub fn human_readiness_hints(lane: TriageLane, meta: &WorkflowMeta) -> Vec<HumanReadinessHint> {
    let requirements = human_field_requirements(lane);
    let mut hints = Vec::new();
    for req in requirements {
        let missing = match req.field {
            "question" => meta.question.trim().is_empty(),
            "loginUrl" => meta.login_url.trim().is_empty(),
            "account" => meta.account.trim().is_empty(),
            "options" => !meta.options.iter().any(|opt| !opt.trim().is_empty()),
            "impact" => meta.impact.trim().is_empty(),
            "acknowledgement" => meta.acknowledgement.trim().is_empty(),
            _ => false,
        };
        if missing {
            hints.push(HumanReadinessHint {
                lane,
                field: req.field.to_owned(),
                label: req.label.to_owned(),
                severity: req.severity,
                hint: format!("缺少{}", req.label),
            });
        }
    }
    hints
}

/// 批次级人工分栏完备性检查报告（与 `workflow-planner.js::checkHumanLaneCompleteness` 同源）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanCompletenessReport {
    pub ok: bool,
    pub blocks: Vec<HumanReadinessHint>,
    pub warns: Vec<HumanReadinessHint>,
}

pub fn check_human_lane_completeness(
    entries: &[(TriageLane, &WorkflowMeta)],
) -> HumanCompletenessReport {
    let mut blocks = Vec::new();
    let mut warns = Vec::new();
    for (lane, meta) in entries {
        for hint in human_readiness_hints(*lane, meta) {
            match hint.severity {
                HumanFieldSeverity::Block => blocks.push(hint),
                HumanFieldSeverity::Warn => warns.push(hint),
            }
        }
    }
    HumanCompletenessReport {
        ok: blocks.is_empty(),
        blocks,
        warns,
    }
}
