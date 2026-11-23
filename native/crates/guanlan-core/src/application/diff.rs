//! 语义级版本 Diff（PRD v2.0 §3.5；冻结契约 H）。
//!
//! 数据源勘误（冻结契约 H 明文）：事件 kind 实为 appeared/modified，payload 仅含
//! changed_sections/added_lines/removed_lines——语义摘要卡**直接比对两版正文与
//! statements**，不依赖事件 payload。
//!
//! 三项指标（确定性 v1 口径，契约登记）：
//! - 新增交付项 = checklist_done(目标) − checklist_done(基线)；
//! - 关闭未决事项 = 基线 pending(P0+P1) − 目标 pending（statements 按 revision_id
//!   过滤聚合，decision 最新状态口径同 record_decision_events）；
//! - 修改接口契约处数 = 两版中 namespace 含『接口』|『数据格式』|『契约』的陈述
//!   行段并集计数。
//!
//! 行级 LCS 预算 ≤2000 行/版，超限 truncated + 分块 cursor。

use crate::index::state_machine::derive_checklist;
use crate::storage::StatementRow;

/// 单版行数预算（冻结契约 H：≤2000 行，超限 truncated）
pub const DIFF_LINE_BUDGET: usize = 2000;
/// 分块预算：单页 sections 的行数上限（超出 → next_cursor 续页）
pub const SECTION_PAGE_LINES: usize = 400;

/// 语义摘要卡单项
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffMetric {
    pub label: String,
    pub count: i64,
    /// +1 / -1（绝对值方向的符号）
    pub sign: i8,
}

/// 差异行
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffLine {
    Same(String),
    Add(String),
    Del(String),
}

impl DiffLine {
    /// wire 词（契约 H：same|add|del）
    pub fn type_str(&self) -> &'static str {
        match self {
            DiffLine::Same(_) => "same",
            DiffLine::Add(_) => "add",
            DiffLine::Del(_) => "del",
        }
    }

    pub fn text(&self) -> &str {
        match self {
            DiffLine::Same(text) | DiffLine::Add(text) | DiffLine::Del(text) => text,
        }
    }
}

/// 一个差异区块
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffSection {
    pub title: String,
    pub baseline_start: i64,
    pub target_start: i64,
    pub lines: Vec<DiffLine>,
}

/// diff 计算结果（service 层补 headline 与 checkpoint_id）
#[derive(Debug, Clone, Default)]
pub struct DiffResult {
    pub items: Vec<DiffMetric>,
    pub sections: Vec<DiffSection>,
    pub truncated: bool,
}

/// 行级 LCS（经典 DP；两版各截断到 [`DIFF_LINE_BUDGET`] 行）
pub fn lcs_lines(baseline: &[&str], target: &[&str]) -> Vec<DiffLine> {
    let n = baseline.len();
    let m = target.len();
    // DP 表：n*m ≤ 2000*2000 = 4e6 u32 = 16MB 上限，一次性分配可接受
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let width = m + 1;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i * width + j] = if baseline[i] == target[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if baseline[i] == target[j] {
            out.push(DiffLine::Same(baseline[i].to_owned()));
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            out.push(DiffLine::Del(baseline[i].to_owned()));
            i += 1;
        } else {
            out.push(DiffLine::Add(target[j].to_owned()));
            j += 1;
        }
    }
    for rest in &baseline[i..] {
        out.push(DiffLine::Del((*rest).to_owned()));
    }
    for rest in &target[j..] {
        out.push(DiffLine::Add((*rest).to_owned()));
    }
    out
}

/// 语义摘要卡三项指标（冻结契约 H 口径）
pub fn summary_metrics(
    baseline_content: &str,
    target_content: &str,
    baseline_statements: &[StatementRow],
    target_statements: &[StatementRow],
) -> Vec<DiffMetric> {
    let (baseline_done, _) = derive_checklist(baseline_content);
    let (target_done, _) = derive_checklist(target_content);
    let checklist_delta = i64::from(target_done) - i64::from(baseline_done);

    let baseline_pending = blocking_pending(baseline_statements);
    let target_pending = blocking_pending(target_statements);
    let closed = i64::from(baseline_pending) - i64::from(target_pending);

    let contract_spans = contract_span_union(baseline_statements, target_statements);

    vec![
        metric("新增交付项", checklist_delta),
        metric("关闭未决事项", closed),
        metric("修改接口契约", contract_spans),
    ]
}

/// 单项组装（count≤0 时 sign=-1，否则 +1；count=0 仍给出条目，前端展示 0）
fn metric(label: &str, count: i64) -> DiffMetric {
    DiffMetric {
        label: label.to_owned(),
        count: count.abs(),
        sign: if count < 0 { -1 } else { 1 },
    }
}

/// 未决阻塞级事项数（decision 最新状态口径：同 decision_id 取最新 observed_at
/// 的陈述——与 record_decision_events 的聚合一致）
fn blocking_pending(statements: &[StatementRow]) -> u32 {
    let mut latest: std::collections::HashMap<String, &StatementRow> =
        std::collections::HashMap::new();
    for statement in statements {
        let Some(decision_id) = statement.decision_id.as_deref() else {
            continue;
        };
        latest
            .entry(decision_id.to_owned())
            .and_modify(|existing| {
                if statement.observed_at > existing.observed_at {
                    *existing = statement;
                }
            })
            .or_insert(statement);
    }
    latest
        .values()
        .filter(|statement| {
            statement.status == "待确认"
                && matches!(
                    statement_priority(&statement.detail_json).as_str(),
                    "P0" | "P1"
                )
        })
        .count() as u32
}

fn statement_priority(detail_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(detail_json)
        .ok()
        .and_then(|value| {
            value
                .get("priority")
                .and_then(|p| p.as_str())
                .map(str::to_owned)
        })
        .filter(|p| matches!(p.as_str(), "P0" | "P1" | "P2"))
        .unwrap_or_else(|| "P2".to_owned())
}

/// 修改接口契约处数：两版中 namespace 含『接口』|『数据格式』|『契约』的陈述
/// 行段**并集**计数（同版内重叠行段合并；跨版按并集去重——确定性 v1 口径）
pub fn contract_span_union(
    baseline_statements: &[StatementRow],
    target_statements: &[StatementRow],
) -> i64 {
    let is_contract = |namespace: &str| {
        namespace.contains("接口") || namespace.contains("数据格式") || namespace.contains("契约")
    };
    let mut spans: Vec<(i64, i64)> = Vec::new();
    for statement in baseline_statements
        .iter()
        .chain(target_statements.iter())
        .filter(|s| is_contract(&s.namespace))
    {
        spans.push((statement.line_start, statement.line_end));
    }
    spans.sort_unstable();
    let mut union_count = 0i64;
    let mut current: Option<(i64, i64)> = None;
    for (start, end) in spans {
        match current {
            Some((cstart, cend)) if start <= cend => {
                current = Some((cstart, cend.max(end)));
            }
            Some(_) => {
                union_count += 1;
                current = Some((start, end));
            }
            None => current = Some((start, end)),
        }
    }
    if current.is_some() {
        union_count += 1;
    }
    union_count
}

/// 完整 diff：正文 LCS + 摘要卡（行预算超限时 truncated）
pub fn compute_diff(
    baseline_content: &str,
    target_content: &str,
    baseline_statements: &[StatementRow],
    target_statements: &[StatementRow],
) -> DiffResult {
    let baseline_lines: Vec<&str> = baseline_content.split('\n').collect();
    let target_lines: Vec<&str> = target_content.split('\n').collect();
    let truncated =
        baseline_lines.len() > DIFF_LINE_BUDGET || target_lines.len() > DIFF_LINE_BUDGET;
    let baseline = &baseline_lines[..baseline_lines.len().min(DIFF_LINE_BUDGET)];
    let target = &target_lines[..target_lines.len().min(DIFF_LINE_BUDGET)];

    let mut items = summary_metrics(
        baseline_content,
        target_content,
        baseline_statements,
        target_statements,
    );
    if truncated {
        items.push(DiffMetric {
            label: "超出行预算（截断）".to_owned(),
            count: 1,
            sign: 1,
        });
    }

    let lines = lcs_lines(baseline, target);
    let sections = group_sections(&lines);
    DiffResult {
        items,
        sections,
        truncated,
    }
}

/// 把 LCS 序列按标题区块分组（标题 = 区块首行所在的大纲标题，确定性）；
/// 无标题的行归「（文档头部）」。区块内行数超预算时按 [`SECTION_PAGE_LINES`]
/// 切片（分块 cursor 由调用方编码）。
fn group_sections(lines: &[DiffLine]) -> Vec<DiffSection> {
    let mut sections: Vec<DiffSection> = Vec::new();
    let mut current_title = "（文档头部）".to_owned();
    let mut current: DiffSection = DiffSection {
        title: current_title.clone(),
        baseline_start: 0,
        target_start: 0,
        lines: Vec::new(),
    };
    let mut baseline_line = 0i64;
    let mut target_line = 0i64;
    let mut is_first = true;
    for line in lines {
        let is_heading = line.text().trim_start().starts_with('#');
        if is_heading {
            // 新标题：先把当前区块收起来（空区块跳过）
            if !current.lines.is_empty() {
                sections.push(std::mem::replace(
                    &mut current,
                    DiffSection {
                        title: String::new(),
                        baseline_start: 0,
                        target_start: 0,
                        lines: Vec::new(),
                    },
                ));
            } else if !is_first {
                // 空区块被标题替换：保持起始行号推进
            }
            current_title = line
                .text()
                .trim_start()
                .trim_start_matches('#')
                .trim()
                .to_owned();
            current.title = current_title.clone();
            current.baseline_start = baseline_line + 1;
            current.target_start = target_line + 1;
            current.lines.push(line.clone());
        } else {
            if is_first && current.lines.is_empty() {
                current.baseline_start = baseline_line + 1;
                current.target_start = target_line + 1;
            }
            current.lines.push(line.clone());
            if current.lines.len() >= SECTION_PAGE_LINES {
                sections.push(std::mem::take(&mut current));
                current.title = format!("{current_title}（续）");
                current.baseline_start = baseline_line + 2;
                current.target_start = target_line + 2;
            }
        }
        if matches!(line, DiffLine::Same(_) | DiffLine::Del(_)) {
            baseline_line += 1;
        }
        if matches!(line, DiffLine::Same(_) | DiffLine::Add(_)) {
            target_line += 1;
        }
        is_first = false;
    }
    if !current.lines.is_empty() {
        sections.push(current);
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statement(
        code: &str,
        namespace: &str,
        status: &str,
        priority: &str,
        start: i64,
        end: i64,
        observed: &str,
    ) -> StatementRow {
        StatementRow {
            statement_id: format!("stmt_{code}_{start}_{status}"),
            workspace_id: "ws".to_owned(),
            file_id: "f".to_owned(),
            revision_id: "r".to_owned(),
            code: code.to_owned(),
            namespace: namespace.to_owned(),
            question: "问题".to_owned(),
            status: status.to_owned(),
            quote: "原文".to_owned(),
            line_start: start,
            line_end: end,
            decision_id: Some(format!("dec_{code}_{start}")),
            detail_json: format!(r#"{{"priority":"{priority}"}}"#),
            extract_rule_version: "v0.4.3".to_owned(),
            observed_at: observed.to_owned(),
        }
    }

    #[test]
    fn lcs_marks_add_del_same() {
        let lines = lcs_lines(&["a", "b", "c"], &["a", "x", "b", "c", "d"]);
        let kinds: Vec<&str> = lines.iter().map(DiffLine::type_str).collect();
        // a 匹配；x 插入；b/c 匹配；d 插入（LCS=a,b,c，无删除）
        assert_eq!(kinds, vec!["same", "add", "same", "same", "add"]);
    }

    #[test]
    fn summary_metrics_counts_three_items() {
        // 新增交付项：目标多 2 个勾选
        let baseline = "- [x] A\n- [ ] B\n";
        let target = "- [x] A\n- [x] B\n- [x] C\n- [x] D\n";
        // 关闭未决：基线 P0+P1 各一 → 目标 P0 已确认
        let base_stmts = vec![
            statement("S1", "ns", "待确认", "P1", 1, 2, "2026-01-01"),
            statement("S2", "接口", "待确认", "P0", 3, 4, "2026-01-01"),
        ];
        let target_stmts = vec![
            statement("S1", "ns", "已确认", "P1", 1, 2, "2026-01-02"),
            statement("S2", "接口", "待确认", "P0", 3, 4, "2026-01-02"),
        ];
        let items = summary_metrics(baseline, target, &base_stmts, &target_stmts);
        assert_eq!(items[0].label, "新增交付项");
        assert_eq!(items[0].count, 3, "checklist done 1→4");
        assert_eq!(items[0].sign, 1);
        assert_eq!(items[1].label, "关闭未决事项");
        assert_eq!(items[1].count, 1, "P1 已确认关闭，P0 仍待确认");
        assert_eq!(items[2].label, "修改接口契约");
        assert_eq!(items[2].count, 1, "两版同一行段并集=1");
    }

    #[test]
    fn contract_span_union_merges_overlaps_across_versions() {
        let base = vec![statement(
            "S1",
            "数据格式",
            "待确认",
            "P2",
            1,
            10,
            "2026-01-01",
        )];
        let target = vec![
            statement("S1", "数据格式", "待确认", "P2", 5, 15, "2026-01-02"),
            statement("S2", "契约", "待确认", "P2", 30, 31, "2026-01-02"),
        ];
        assert_eq!(contract_span_union(&base, &target), 2, "1-15 合并 + 30-31");
    }

    #[test]
    fn compute_diff_groups_sections_by_heading() {
        let baseline = "# 标题\n旧内容\n";
        let target = "# 标题\n新内容\n## 二\n新增\n";
        let result = compute_diff(baseline, target, &[], &[]);
        assert!(!result.truncated);
        assert_eq!(result.items.len(), 3);
        assert!(result
            .items
            .iter()
            .any(|item| item.label == "修改接口契约" && item.count == 0));
        // 区块按标题分组
        let titles: Vec<&str> = result.sections.iter().map(|s| s.title.as_str()).collect();
        assert!(titles.contains(&"标题"));
        assert!(titles.contains(&"二"));
        let del: usize = result
            .sections
            .iter()
            .flat_map(|s| s.lines.iter())
            .filter(|l| l.type_str() == "del")
            .count();
        let add: usize = result
            .sections
            .iter()
            .flat_map(|s| s.lines.iter())
            .filter(|l| l.type_str() == "add")
            .count();
        assert_eq!(del, 1, "旧内容删除");
        assert_eq!(add, 3, "新内容 + ## 二 + 新增");
    }

    #[test]
    fn over_budget_marks_truncated() {
        let big = (0..3000)
            .map(|i| format!("行{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let result = compute_diff(&big, &big, &[], &[]);
        assert!(result.truncated, "超 2000 行预算必须 truncated");
    }
}
