//! 决策解析器（PRD v2.0 §3.3；冻结契约 apiContract B5、任务书 3.3）。
//!
//! 解析 Markdown 中的 `[P0/P1/P2 - 待确认]` 卡点块，产出结构化
//! [`crate::domain::model::DecisionItem`]。标准块字段（PRD 3.3 解析语法规则）：
//! 「决定：___」「确认人：___」「角色：___」「现/新运行条件：___」
//! 「生效范围与日期：___」+ 推荐语与选项行。
//!
//! 解析规则（确定性）：
//! - 标记行 = `\[\s*P([012])\s*[-—–]?\s*(待确认|已确认)\s*\]`（状态词决定块状态）；
//! - 块体 = 标记行 + 其后连续的**非空、非标题、非下一标记**行（跳过代码围栏，
//!   上限 16 行防御性截断）；
//! - 字段值：占位（下划线/省略号串）→ [`FieldValue::Placeholder`]，已填 → Filled；
//! - 选项：`可选方案：` 行（`/` 分隔）与 `- **选项 X**：…` 行，与
//!   [`crate::index::derive`] 的抽取口径一致。
//!
//! **不 bump EXTRACT_RULE_VERSION**（评审约束5 三难裁定的本步落地）：本解析器
//! 只影响**新增版本**的派生；存量工作区的卡点块要等文件内容变化产生新版本后
//! 才能抽出陈述。Node+Rust 双侧同版本 bump 需改 server/WorkspaceStore.ts:131
//! （超出本批次文件范围），已登记 contract-storage.md §4.3 待办。夹具不含
//! 卡点块（grep 实证），parity/冒烟不受影响。

use std::sync::OnceLock;

use regex::Regex;

use crate::domain::model::{DecisionItem, DecisionPriority};
use crate::index::derive::decision_id_for;

/// 字段值：占位符或已填内容
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldValue {
    /// 仍是下划线/省略号占位（待人工填写）
    Placeholder,
    Filled(String),
}

impl FieldValue {
    /// 已填内容（占位返回 None）
    pub fn filled(&self) -> Option<&str> {
        match self {
            FieldValue::Placeholder => None,
            FieldValue::Filled(text) => Some(text),
        }
    }
}

/// 一个卡点块（标记行 + 块体）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionBlock {
    pub priority: DecisionPriority,
    /// 标记行状态词：待确认 / 已确认
    pub confirmed: bool,
    /// 卡点标题（标记行 `[P1 - 待确认]` 之后的文字）
    pub question: String,
    /// 决定（PRD 3.3「决定：」）
    pub decision: FieldValue,
    pub confirmer: FieldValue,
    pub role: Option<String>,
    /// 现运行条件
    pub current_condition: Option<String>,
    /// 新运行条件
    pub new_condition: Option<String>,
    /// 生效范围与日期
    pub effective_scope: Option<String>,
    /// 推荐理由（「推荐理由：」或「推荐：」）
    pub recommendation: Option<String>,
    /// 预设选项（「可选方案」+「- **选项 X**：」）
    pub options: Vec<String>,
    /// 块体原文行（**含标记行**——状态词与字段都在其中，陈述 quote/状态判定共用）
    pub body: Vec<String>,
    /// 1 起始行号
    pub line_start: usize,
    /// 1 结束行号（含）
    pub line_end: usize,
}

impl DecisionBlock {
    /// 仍待人工拍板：决定字段仍是占位符
    pub fn is_pending(&self) -> bool {
        matches!(self.decision, FieldValue::Placeholder)
    }

    /// 组装领域模型（decision_id 与 statements 同源：命名空间 + 归一化问题）
    pub fn to_decision_item(&self, namespace_base: &str, status: &str) -> DecisionItem {
        DecisionItem {
            decision_id: decision_id_for(namespace_base, &self.question),
            priority: self.priority,
            question: self.question.clone(),
            status: status.to_owned(),
            line_start: self.line_start,
            line_end: self.line_end,
            decision: self.decision.filled().map(str::to_owned),
            confirmer: self.confirmer.filled().map(str::to_owned),
            role: self.role.clone(),
            current_condition: self.current_condition.clone(),
            new_condition: self.new_condition.clone(),
            effective_scope: self.effective_scope.clone(),
            recommendation: self.recommendation.clone(),
            options: self.options.clone(),
            pending: self.is_pending(),
        }
    }
}

/// 解析正文里的全部卡点块（按出现顺序；跳过代码围栏）
pub fn parse_decision_blocks(content: &str) -> Vec<DecisionBlock> {
    static PATTERNS: OnceLock<BlockPatterns> = OnceLock::new();
    let pat = PATTERNS.get_or_init(|| BlockPatterns {
        marker: Regex::new(r"\[\s*P([012])\s*[-—–]?\s*(待确认|已确认)\s*\]").expect("卡点标记"),
        field: Regex::new(
            r"(决定|确认人|角色|现运行条件|新运行条件|生效范围与日期|推荐理由|推荐)[：:]\s*(.*)$",
        )
        .expect("卡点字段"),
        heading: Regex::new(r"^#{1,3}\s+").expect("标题"),
    });

    let mut blocks: Vec<DecisionBlock> = Vec::new();
    let mut in_fence = false;
    let lines: Vec<&str> = content.split('\n').collect();
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            index += 1;
            continue;
        }
        if in_fence {
            index += 1;
            continue;
        }
        let Some(captures) = pat.marker.captures(trimmed) else {
            index += 1;
            continue;
        };
        let priority = captures
            .get(1)
            .and_then(|m| DecisionPriority::parse(&format!("P{}", m.as_str())))
            .unwrap_or(DecisionPriority::P2);
        let confirmed = captures.get(2).map(|m| m.as_str()) == Some("已确认");

        // 标记行上的卡点标题：标记之后的文字
        let marker_end = captures.get(0).map(|m| m.end()).unwrap_or(0);
        let question = trimmed
            .get(marker_end..)
            .map(|rest| rest.trim_start_matches(['：', ':', ' ', '\u{3000}']).trim())
            .unwrap_or_default()
            .to_owned();

        // 块体：标记行 + 连续的非空、非标题、非标记行（防御上限 16）
        let mut body: Vec<&str> = vec![line];
        let mut cursor = index + 1;
        while cursor < lines.len() && body.len() < 16 {
            let candidate = lines[cursor];
            let candidate_trim = candidate.trim();
            if candidate_trim.is_empty()
                || candidate_trim.starts_with("```")
                || pat.heading.is_match(candidate_trim)
                || pat.marker.is_match(candidate_trim)
            {
                break;
            }
            body.push(candidate);
            cursor += 1;
        }

        let mut block = DecisionBlock {
            priority,
            confirmed,
            question: if question.is_empty() {
                // 标记行无标题时以首条字段前的原文兜底（确定性口径）
                "待确认事项".to_owned()
            } else {
                question
            },
            decision: FieldValue::Placeholder,
            confirmer: FieldValue::Placeholder,
            role: None,
            current_condition: None,
            new_condition: None,
            effective_scope: None,
            recommendation: None,
            options: Vec::new(),
            body: body.iter().map(|l| (*l).to_owned()).collect(),
            line_start: index + 1,
            line_end: if body.len() <= 1 { index + 1 } else { cursor },
        };
        // 字段抽取跳过标记行本身（第 0 行是标记），标记行上的字段不算
        let field_lines: Vec<&str> = body.iter().skip(1).copied().collect();
        fill_block_fields(&mut block, &field_lines, &pat.field);
        blocks.push(block);
        index = cursor;
    }
    blocks
}

/// 编译一次的块级正则集
struct BlockPatterns {
    marker: Regex,
    field: Regex,
    heading: Regex,
}

/// 从块体行抽取字段与选项（标记行上的字段也算——单行紧凑块）
fn fill_block_fields(block: &mut DecisionBlock, body: &[&str], field: &Regex) {
    for line in body {
        let trimmed = line.trim();
        if let Some(captures) = field.captures(trimmed) {
            let name = captures.get(1).map(|m| m.as_str()).unwrap_or("");
            let raw = captures.get(2).map(|m| m.as_str().trim()).unwrap_or("");
            let value = classify_value(raw);
            match name {
                "决定" => block.decision = value,
                "确认人" => block.confirmer = value,
                "角色" => {
                    block.role = value.filled().map(str::to_owned);
                }
                "现运行条件" => {
                    block.current_condition = value.filled().map(str::to_owned);
                }
                "新运行条件" => {
                    block.new_condition = value.filled().map(str::to_owned);
                }
                "生效范围与日期" => {
                    block.effective_scope = value.filled().map(str::to_owned);
                }
                // 「推荐理由：」与「推荐：」都归推荐语（PRD 3.3 推荐控件的语源）
                "推荐理由" | "推荐" if block.recommendation.is_none() => {
                    block.recommendation = value.filled().map(str::to_owned);
                }
                _ => {}
            }
        }
        collect_options(trimmed, &mut block.options);
    }
}

/// 占位判定：非空且全部字符都是下划线/省略号/破折号（`___`、`……`）
fn classify_value(raw: &str) -> FieldValue {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return FieldValue::Placeholder;
    }
    let is_placeholder = !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|c| c == '_' || c == '…' || c == '—' || c == '－' || c == '·');
    if is_placeholder {
        FieldValue::Placeholder
    } else {
        FieldValue::Filled(trimmed.to_owned())
    }
}

/// 选项行收集：`可选方案：A / B`（`/` 分隔，≥3 字符项）与 `- **选项 X**：…`
/// ——与 derive.rs 的选项抽取同口径
fn collect_options(line: &str, options: &mut Vec<String>) {
    static OPTION_LINE: OnceLock<Regex> = OnceLock::new();
    let option_line = OPTION_LINE.get_or_init(|| {
        Regex::new(r"[-*]\s*\*\*选项\s*([A-Z])[*]{0,2}[：:]\s*(.+)").expect("选项行")
    });

    let stripped = line.trim();
    if let Some(rest) = stripped.strip_prefix("可选方案") {
        let rest = rest.trim_start_matches(['：', ':']).trim();
        for part in rest.split('/') {
            let trimmed = part.trim();
            if trimmed.chars().count() > 2 {
                options.push(trimmed.to_owned());
            }
        }
        return;
    }
    if let Some(captures) = option_line.captures(stripped) {
        let letter = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let body = captures.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        options.push(format!("选项 {letter}：{body}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pending_block_with_placeholders() {
        let content = "\
[P1 - 待确认] 属性字典与历史更新策略
决定：___
确认人：___
角色：___
现运行条件：全量同步
新运行条件：___
生效范围与日期：___
推荐理由：先做两阶段状态锁
可选方案：甲方案 / 乙方案
";
        let blocks = parse_decision_blocks(content);
        assert_eq!(blocks.len(), 1);
        let block = &blocks[0];
        assert_eq!(block.priority, DecisionPriority::P1);
        assert!(!block.confirmed);
        assert_eq!(block.question, "属性字典与历史更新策略");
        assert!(block.is_pending());
        assert_eq!(block.decision, FieldValue::Placeholder);
        assert_eq!(block.confirmer, FieldValue::Placeholder);
        assert_eq!(block.role, None);
        assert_eq!(block.current_condition.as_deref(), Some("全量同步"));
        assert_eq!(block.new_condition, None, "占位 → None");
        assert_eq!(block.effective_scope, None, "占位 → None");
        assert_eq!(block.recommendation.as_deref(), Some("先做两阶段状态锁"));
        assert_eq!(
            block.options,
            vec!["甲方案".to_owned(), "乙方案".to_owned()]
        );
        assert_eq!(block.line_start, 1);
        assert_eq!(block.line_end, 9);
    }

    #[test]
    fn parses_confirmed_block_after_writeback() {
        // 回写后的形态：状态词变更 + 字段已填
        let content = "\
[P1 - 已确认] 属性字典与历史更新策略
决定：采用两阶段状态锁
确认人：架构组
生效范围与日期：全量专项，2026-11-18
";
        let blocks = parse_decision_blocks(content);
        assert_eq!(blocks.len(), 1);
        let block = &blocks[0];
        assert!(block.confirmed);
        assert!(!block.is_pending());
        assert_eq!(block.decision.filled(), Some("采用两阶段状态锁"));
        assert_eq!(block.confirmer.filled(), Some("架构组"));
        assert_eq!(
            block.effective_scope.as_deref(),
            Some("全量专项，2026-11-18")
        );
    }

    #[test]
    fn skips_fences_and_headings_and_separates_blocks() {
        let content = "\
# 标题

```text
[P1 - 待确认] 围栏内不算
```

[P0 - 待确认] 第一个卡点
决定：___

## 下一章

[P2 - 待确认] 第二个卡点
决定：已另行处理
";
        let blocks = parse_decision_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].priority, DecisionPriority::P0);
        assert_eq!(blocks[0].question, "第一个卡点");
        assert_eq!(blocks[0].line_start, 7);
        assert_eq!(blocks[1].priority, DecisionPriority::P2);
        assert_eq!(blocks[1].line_start, 12);
        assert_eq!(blocks[1].decision.filled(), Some("已另行处理"));
    }

    #[test]
    fn questionless_marker_falls_back_and_options_line_form() {
        let content = "[P2 - 待确认]\n决定：___\n- **选项 A**：全量重跑\n";
        let blocks = parse_decision_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].question, "待确认事项");
        assert_eq!(blocks[0].options, vec!["选项 A：全量重跑".to_owned()]);
    }

    #[test]
    fn decision_item_identity_matches_statement_namespace() {
        let blocks = parse_decision_blocks("[P1 - 待确认] 属性字典与历史更新策略\n决定：___\n");
        let item = blocks[0].to_decision_item("docs / 03-待确认事项", "待确认");
        assert!(item.decision_id.starts_with("dec_"));
        assert!(item.is_blocking(), "P1 未决是阻塞级");
        assert_eq!(item.status, "待确认");
        // 同一问题经 statements 口径（derive::decision_id_for）应得到同一 ID
        assert_eq!(
            item.decision_id,
            decision_id_for("docs / 03-待确认事项", "属性字典与历史更新策略")
        );
    }
}
