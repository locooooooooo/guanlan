//! E01 · 「丞相台」四车道可解释分流与五道安全闸政策守门（Rust 内核领域模块）。
//!
//! 移植自根目录 `轮序 RINGFLOW` 已验证的确定性规则底座：
//! - `workflow-triage.js`：四车道可解释分流（`inform / login / decide / delegate`）+
//!   E7 入厅前降噪（模板签字占位行过滤 + 缩进/邻近验收子项并入父任务）+
//!   B03 人工分栏完备性需求表（`HUMAN_FIELD_REQUIREMENTS` / `human_readiness_hints`）；
//! - `workflow-policy.js`：B04 六类高风险动作识别矩阵（含 D03 中英双语词表）+
//!   `task_id + plan_revision` 绑定显式授权校验 + 抢单大厅五道安全闸 fail-closed 放行矩阵 +
//!   B05 确定性依赖图并行宽度与预算并发建议（`advisory_only = true`）；
//! - `markdown-index.js`：轻量 YAML Frontmatter + 围栏代码块跳过 + Markdown 勾选项/`TODO:` 抽取。
//!
//! ## 硬红线与停机铁律（E01 契约）
//! 1. **绝不把关键词命中包装成黑盒 AI 概率**：无任何置信度/概率分数，每条分流结果必须保留
//!    明确来源（Frontmatter 显式声明 / 具体命中关键词列表 / 保守默认回退）与来源行号；
//! 2. **五道安全闸 fail-closed**：人工车道（`inform / login / decide` 或未定车道）、
//!    缺少验收标准、缺少工作目录、命中高风险动作词或存在规划风险提示的条目 100% 拦截自动派发；
//! 3. **风险只提示不代决**：高风险动作授权必须精确绑定 `task_id + plan_revision`，内核从不自动签发。

pub mod classifier;
pub mod frontmatter;
pub mod policy;

#[cfg(test)]
mod tests;

pub use classifier::{
    build_workflow_index, check_human_lane_completeness, classify_workflow_item, explicit_lane,
    human_field_requirements, human_readiness_hints, is_template_placeholder_line, source_ref,
    to_workflow_item, ClassificationInput, FilteredItem, FilteredKind, FilteredSummary,
    HumanCompletenessReport, HumanFieldRequirement, HumanFieldSeverity, HumanReadinessHint,
    LaneMetadata, SourceRef, TaskSyntax, TriageClassification, TriageFileInput, TriageLane,
    TriageTaskInput, WorkflowIndex, WorkflowItem, WorkflowMeta, LANE_ORDER,
};
pub use frontmatter::{
    clean_task_text, extract_frontmatter, extract_workflow_meta, parse_markdown_for_triage,
    MarkdownDocInput,
};
pub use policy::{
    authorize_risky_action, detect_risky_actions, evaluate_hall_eligibility, max_parallel_width,
    recommend_workflow_budget, risk_action_definitions, summarize_risky_actions,
    AuthorizationDecision, BudgetRecommendation, GateEvaluation, HallEligibilityReport,
    PolicyTaskInput, RiskActionDef, RiskAuthorization, RiskHit, RiskKind, RiskReport, RiskSummary,
};

/// 端到端便捷入口：把一批原始 Markdown 文档（含 Frontmatter 与勾选项/TODO）解析并构建四车道工作流索引。
pub fn triage_markdown_documents(docs: &[MarkdownDocInput<'_>]) -> WorkflowIndex {
    let parsed: Vec<TriageFileInput> = docs
        .iter()
        .map(|doc| parse_markdown_for_triage(doc.path, doc.content, doc.modified_at))
        .collect();
    build_workflow_index(&parsed)
}
