//! 派生索引：决策陈述、引用关系、文档自述日期。
//!
//! 移植自 `server/derive.ts` 与 `src/services/WorkspaceTransformer.ts`。
//!
//! 身份口径（决定「不产生第二套历史」的关键，方案 §5）：
//! - 每条来源陈述都有独立 `statement_id`（同编号不同问题绝不共用身份）
//! - 业务决定 ID 由「命名空间 + 归一化问题」推导，只有同问题才归入同一决定
//! - 引用绑定到来源版本，并记录目标版本是否已知
//!
//! **UTF-16 切片口径**：TS 的 `String#slice` 按 UTF-16 码元计，Rust 的 `chars()`
//! 按码点计。本模块的 [`slice_utf16`] 复刻 JS 语义（含截断代理对时以 U+FFFD
//! 收尾——与 Node 把落单代理项编码成 UTF-8 时的行为一致）。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::index::ident::stable_key;
use crate::storage::{EdgeRow, StatementRow};

/// 派生输入
#[derive(Debug, Clone)]
pub struct DeriveInput<'a> {
    pub workspace_id: &'a str,
    pub file_id: &'a str,
    pub revision_id: &'a str,
    pub relative_path: &'a str,
    pub folder: &'a str,
    pub title: &'a str,
    pub format: &'a str,
    pub content: &'a str,
    pub observed_at: &'a str,
    /// 工作区根目录：把原文中的绝对路径链接映射回工作区相对路径
    pub root_path: &'a str,
    /// 已知文件路径 → file_id
    pub path_index: &'a HashMap<String, String>,
    /// 目标文件当时的最新版本
    pub target_revision_index: &'a HashMap<String, String>,
}

/// 文档自述时间
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentTime {
    pub occurred_at: Option<String>,
    pub precision: String,
    pub source: Option<String>,
}

/// 编译一次、全局复用的正则集
struct Patterns {
    /// 格式 A 章节标题：`## N 标题`
    section_a: Regex,
    /// 章节正文边界：`#{1,3} 标题`
    heading: Regex,
    /// 格式 B 标题：`### Q01：标题`
    section_b: Regex,
    /// 编号提取：`Q01`
    code: Regex,
    /// markdown 大纲标题
    outline: Regex,
    /// 行内链接
    link: Regex,
    /// 外链前缀
    external: Regex,
    /// 状态：已确认
    status_confirmed: Regex,
    /// 状态：回执状态已确认
    status_receipt_confirmed: Regex,
    /// 状态：已否决
    status_rejected: Regex,
    /// 状态：已搁置
    status_shelved: Regex,
    /// 状态：已取代
    status_superseded: Regex,
    /// 状态：来源不一致
    status_conflict: Regex,
    /// 状态：待确认
    status_pending: Regex,
    /// 状态：[P1 - 已确认] 卡点块回写后的括号形态（PRD 3.3；v0.4.3 无此规则，
    /// 仅影响新增版本的派生——不 bump EXTRACT_RULE_VERSION，登记 §4.3）
    status_bracket_confirmed: Regex,
    /// 问题归一化时剔除的标点
    question_punctuation: Regex,
    /// 选项行：`- **选项 A**：…`
    option_line: Regex,
    /// 确认人
    confirmer: Regex,
    /// front matter
    front_matter: Regex,
    /// front matter 内的日期行
    front_matter_date: Regex,
    /// 文档日期
    doc_date: Regex,
    /// ISO 日期
    iso_date: Regex,
    /// 纯日期
    plain_date: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        section_a: Regex::new(r"^##\s+(\d+[.、\s].+)$").expect("section_a"),
        heading: Regex::new(r"^#{1,3}\s+").expect("heading"),
        section_b: Regex::new(r"^###\s+(Q\d+)\s*[:：]\s*(.+)$").expect("section_b"),
        code: Regex::new(r"(?i)q\s*\d+").expect("code"),
        outline: Regex::new(r"^(#{1,3})\s+(.+)$").expect("outline"),
        link: Regex::new(r#"\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)"#)
            .expect("link"),
        external: Regex::new(r"(?i)^(https?:|mailto:|data:)").expect("external"),
        status_confirmed: Regex::new(r"状态[：:]\s*已确认").expect("status_confirmed"),
        status_receipt_confirmed: Regex::new(r"回执状态[：:]\s*已确认")
            .expect("status_receipt_confirmed"),
        status_rejected: Regex::new(r"状态[：:]\s*已否决").expect("status_rejected"),
        status_shelved: Regex::new(r"状态[：:]\s*已搁置").expect("status_shelved"),
        status_superseded: Regex::new(r"状态[：:]\s*已取代").expect("status_superseded"),
        status_conflict: Regex::new(r"来源不一致").expect("status_conflict"),
        status_pending: Regex::new(r"待确认").expect("status_pending"),
        status_bracket_confirmed: Regex::new(r"\[\s*P\s*\d\s*[-—–]?\s*已确认\s*\]")
            .expect("status_bracket_confirmed"),
        question_punctuation: Regex::new(r#"[：:，,。.、；;（）()【】\[\]"'"']"#)
            .expect("question_punctuation"),
        option_line: Regex::new(r"[-*]\s*\*\*选项\s*([A-Z])[*]{0,2}[：:]\s*(.+)")
            .expect("option_line"),
        confirmer: Regex::new(r"确认人[：:]\s*([^\n，,；;]{2,40})").expect("confirmer"),
        front_matter: Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").expect("front_matter"),
        front_matter_date: Regex::new(r"(?m)^(?:date|updated|created)\s*:\s*(.+)$")
            .expect("front_matter_date"),
        doc_date: Regex::new(r"文档日期[：:]\s*(\d{4}-\d{2}-\d{2})").expect("doc_date"),
        iso_date: Regex::new(r"(\d{4}-\d{2}-\d{2})").expect("iso_date"),
        plain_date: Regex::new(r"^(\d{4})-(\d{2})-(\d{2})").expect("plain_date"),
    })
}

/// 抽取决策陈述（两种真实格式）
pub fn derive_statements(input: &DeriveInput<'_>) -> Vec<StatementRow> {
    let pat = patterns();
    let lines: Vec<&str> = input.content.split('\n').collect();
    let namespace_base = if input.folder == "." {
        input.title.to_owned()
    } else {
        format!("{} / {}", input.folder, input.title)
    };
    let mut out: Vec<StatementRow> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    // 章节正文：跳过围栏，遇到下一个标题即止
    let body_of = |start: usize, end: usize| -> Vec<&str> { section_body(&lines, start, end) };

    // 格式 A：## N 标题 + 沿用编号
    let mut sections: Vec<(String, usize, Vec<&str>)> = Vec::new();
    let mut current_title = String::new();
    let mut current_start = 0usize;
    for (index, line) in lines.iter().enumerate() {
        let Some(captures) = pat.section_a.captures(line.trim()) else {
            continue;
        };
        if !current_title.is_empty() {
            sections.push((
                current_title.clone(),
                current_start,
                body_of(current_start, index),
            ));
        }
        current_title = captures
            .get(1)
            .map(|m| m.as_str().trim().to_owned())
            .unwrap_or_default();
        current_start = index + 1;
    }
    if !current_title.is_empty() {
        sections.push((
            current_title.clone(),
            current_start,
            body_of(current_start, lines.len()),
        ));
    }

    for (title, start, body) in &sections {
        let Some(code_line) = body
            .iter()
            .find(|line| line.contains("沿用编号") || line.contains("决策编号"))
        else {
            continue;
        };
        let codes = extract_codes(code_line);
        if codes.is_empty() {
            continue;
        }
        let status = detect_status(&body.join("\n"));
        let quote = strip_md(&join_non_empty(body));
        for code in &codes {
            push_statement(
                &mut out,
                &mut seen,
                input,
                &namespace_base,
                code,
                title,
                &status,
                &quote,
                (*start + 1) as i64,
                (*start + body.len()) as i64,
                body,
                None,
            );
        }
    }

    // 格式 B：### Q01：标题
    for (index, line) in lines.iter().enumerate() {
        let Some(captures) = pat.section_b.captures(line.trim()) else {
            continue;
        };
        let code = captures
            .get(1)
            .map(|m| m.as_str().to_uppercase())
            .unwrap_or_default();
        let question = captures
            .get(2)
            .map(|m| m.as_str().trim().to_owned())
            .unwrap_or_default();
        let body = body_of(index + 1, (index + 26).min(lines.len()));
        let status = detect_status(&body.join("\n"));
        let quote = strip_md(&join_non_empty(&body));
        push_statement(
            &mut out,
            &mut seen,
            input,
            &namespace_base,
            &code,
            &question,
            &status,
            &quote,
            (index + 1) as i64,
            (index + body.len()) as i64,
            &body,
            None,
        );
    }

    // 格式 C（PRD v2.0 §3.3）：[P0/P1/P2 - 待确认/已确认] 卡点块。
    // 每块一条陈述，code = 优先级词（P0/P1/P2），detail_json 追加 priority 键；
    // 身份公式与 A/B 两条路径同源（decision_id_for + stable_key）。
    for block in crate::index::decision_block::parse_decision_blocks(input.content) {
        let body_refs: Vec<&str> = block.body.iter().map(|line| line.as_str()).collect();
        let body_text = body_refs.join("\n");
        let status = detect_status(&body_text);
        let quote = strip_md(&join_non_empty(&body_refs));
        let question = if block.question.is_empty() {
            "待确认事项"
        } else {
            &block.question
        };
        push_statement(
            &mut out,
            &mut seen,
            input,
            &namespace_base,
            block.priority.as_str(),
            question,
            &status,
            &quote,
            block.line_start as i64,
            block.line_end as i64,
            &body_refs,
            Some(block.priority.as_str()),
        );
    }

    out
}

/// 业务决定 ID（`derive.ts` 口径）：命名空间 + 归一化问题 —— 同问题才同一决定，
/// 不同问题各自独立。decision_block 解析器与陈述抽取共用，保证卡点块与来源
/// 陈述归入同一决定。
pub(crate) fn decision_id_for(namespace_base: &str, question: &str) -> String {
    format!(
        "dec_{}",
        stable_key(&format!(
            "{namespace_base}::{}",
            normalize_question(question)
        ))
    )
}

/// 写入一条陈述（同 code + 行号只保留一条）
///
/// `priority`：卡点块来源的陈述携带 `P0|P1|P2`（进 detail_json 供状态机聚合
/// 未决分级）；既有 A/B 两条抽取路径传 None，detail_json 与 TS 逐字一致
/// （parity 硬保证）。
#[allow(clippy::too_many_arguments)]
fn push_statement(
    out: &mut Vec<StatementRow>,
    seen: &mut Vec<String>,
    input: &DeriveInput<'_>,
    namespace_base: &str,
    code: &str,
    question: &str,
    status: &str,
    quote: &str,
    line_start: i64,
    line_end: i64,
    body_lines: &[&str],
    priority: Option<&str>,
) {
    let identity = format!("{code}|{line_start}");
    if seen.contains(&identity) {
        return;
    }
    seen.push(identity);

    let decision_id = decision_id_for(namespace_base, question);
    let statement_id = format!(
        "stmt_{}",
        stable_key(&format!("{}::{}::L{line_start}", input.revision_id, code))
    );
    let linked_office = detect_linked_office_evidence(input, body_lines);
    let linked_pdf = detect_linked_pdf_evidence(input, body_lines);
    let detail = extract_detail(
        body_lines,
        priority,
        linked_office.as_deref(),
        linked_pdf.as_deref(),
    );

    out.push(StatementRow {
        statement_id,
        workspace_id: input.workspace_id.to_owned(),
        file_id: input.file_id.to_owned(),
        revision_id: input.revision_id.to_owned(),
        code: code.to_owned(),
        namespace: namespace_base.to_owned(),
        question: slice_utf16(question, 200),
        status: status.to_owned(),
        quote: slice_utf16(quote, 400),
        line_start,
        line_end,
        decision_id: Some(decision_id),
        detail_json: detail,
        extract_rule_version: crate::index::writer::EXTRACT_RULE_VERSION.to_owned(),
        observed_at: input.observed_at.to_owned(),
    });
}

/// 从编号行提取 `Q01` 形式的编号（去空白、大写、保首次出现序）
fn extract_codes(code_line: &str) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    for found in patterns().code.find_iter(code_line) {
        let normalized: String = found
            .as_str()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_uppercase();
        if !codes.contains(&normalized) {
            codes.push(normalized);
        }
    }
    codes
}

/// 拼接非空行（TS `body.filter(l => l.trim()).join(' ')`）
fn join_non_empty(lines: &[&str]) -> String {
    lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 状态判定（短路顺序即优先级）
fn detect_status(text: &str) -> String {
    let pat = patterns();
    let plain = text.replace("**", "").replace('`', "");
    if pat.status_confirmed.is_match(&plain) || pat.status_receipt_confirmed.is_match(&plain) {
        return "已确认".to_owned();
    }
    // [P1 - 已确认] 卡点块回写后的括号形态（PRD 3.3）
    if pat.status_bracket_confirmed.is_match(&plain) {
        return "已确认".to_owned();
    }
    if pat.status_rejected.is_match(&plain) {
        return "已否决".to_owned();
    }
    if pat.status_shelved.is_match(&plain) {
        return "已搁置".to_owned();
    }
    if pat.status_superseded.is_match(&plain) {
        return "已取代".to_owned();
    }
    if pat.status_conflict.is_match(&plain) {
        return "来源不一致".to_owned();
    }
    if pat.status_pending.is_match(&plain) {
        return "待确认".to_owned();
    }
    "未知".to_owned()
}

/// 归一化问题文本（判定「是否同一项决定」）
fn normalize_question(question: &str) -> String {
    let pat = patterns();
    let no_space: String = question
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    let no_punct = pat.question_punctuation.replace_all(&no_space, "");
    let no_prefix = strip_decision_prefix(no_punct.as_ref());
    slice_utf16(&no_prefix.to_lowercase(), 60)
}

/// 去掉问题开头的编号前缀（TS `replace(/^(Q\d+|q\d+)/, '')`：整段前缀被移除）
fn strip_decision_prefix(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return text.to_owned();
    };
    if first != 'Q' && first != 'q' {
        return text.to_owned();
    }
    let rest: String = chars.collect();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return text.to_owned();
    }
    rest[digits.len()..].to_owned()
}

/// 去掉前缀与其后的可选冒号（TS `replace(/^前缀[：:]?/, '')`）
fn strip_prefix_with_optional_colon(text: &str, prefix: &str) -> String {
    match text.strip_prefix(prefix) {
        Some(rest) => rest
            .strip_prefix('：')
            .or_else(|| rest.strip_prefix(':'))
            .unwrap_or(rest)
            .to_owned(),
        None => text.to_owned(),
    }
}

/// 去掉 Markdown 标记
fn strip_md(text: &str) -> String {
    // 行首的 - / * / 空白
    let trimmed = text.trim_start_matches(|c: char| c == '-' || c == '*' || c.is_whitespace());
    let no_bold = trimmed.replace("**", "");
    let no_code = no_bold.replace('`', "");
    // 折叠空白：JS `\s+` → 单空格
    let mut out = String::with_capacity(no_code.len());
    let mut in_space = false;
    for ch in no_code.chars() {
        if ch.is_whitespace() {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    out.trim().to_owned()
}

/// 章节正文：跳过围栏，遇到下一个标题即止（`derive.ts:176-186`）
fn section_body<'a>(lines: &[&'a str], start: usize, end: usize) -> Vec<&'a str> {
    let mut body: Vec<&str> = Vec::new();
    let mut in_fence = false;
    for (index, line) in lines.iter().enumerate().take(end).skip(start) {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && index > start && patterns().heading.is_match(trimmed) {
            break;
        }
        body.push(line);
    }
    body
}

/// 从条目正文提取选项、推荐语与影响范围
///
/// 键序固定为 `options, recommendation, impactBlocked, impactAllowed, confirmer`
/// ——与 TS `JSON.stringify` 的插入序一致（serde_json 的 Map 默认按键排序，
/// 会与此不同，故手工拼串）。
///
/// `priority`：仅卡点块来源的陈述携带（追加 `priority` 键）；既有路径传 None
/// ——detail_json 键序与 TS 逐字一致是 parity 的硬保证，不得改变既有输出。
fn extract_detail(
    body_lines: &[&str],
    priority: Option<&str>,
    linked_office_json: Option<&str>,
    linked_pdf_json: Option<&str>,
) -> String {
    let pat = patterns();
    let body = body_lines.join("\n");

    let mut options: Vec<String> = Vec::new();
    if let Some(option_line) = body_lines.iter().find(|line| line.contains("可选方案")) {
        let raw = strip_prefix_with_optional_colon(&strip_md(option_line), "可选方案");
        for part in raw.split('/') {
            let trimmed = part.trim();
            if trimmed.chars().count() > 2 {
                options.push(trimmed.to_owned());
            }
        }
    }
    for line in body_lines {
        let trimmed = line.trim();
        if let Some(captures) = pat.option_line.captures(trimmed) {
            let letter = captures.get(1).map(|m| m.as_str()).unwrap_or("");
            let body_text = captures.get(2).map(|m| m.as_str().trim()).unwrap_or("");
            options.push(format!("选项 {letter}：{body_text}"));
        }
    }

    let recommendation = body_lines
        .iter()
        .find(|line| line.contains("推荐及理由") || line.contains("推荐采用"))
        .map(|line| {
            let stripped = strip_prefix_with_optional_colon(&strip_md(line), "推荐及理由");
            slice_utf16(&stripped, 300)
        })
        .unwrap_or_default();

    let impact_text = body_lines
        .iter()
        .find(|line| line.contains("影响与等待范围"))
        .map(|line| strip_prefix_with_optional_colon(&strip_md(line), "影响与等待范围"))
        .unwrap_or_default();

    let split_impact = |text: &str| -> Vec<String> {
        text.split(['；', ';', '。'])
            .map(|part| part.trim().to_owned())
            .collect()
    };
    let is_allowed =
        |part: &str| part.contains("不阻断") || part.contains("非阻塞") || part.contains("可继续");
    let impact_blocked: Vec<String> = split_impact(&impact_text)
        .into_iter()
        .filter(|part| !part.is_empty() && !is_allowed(part))
        .take(4)
        .collect();
    let impact_allowed: Vec<String> = split_impact(&impact_text)
        .into_iter()
        .filter(|part| is_allowed(part))
        .take(4)
        .collect();

    let confirmer = pat
        .confirmer
        .captures(&body)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().replace("**", "").trim().to_owned());

    let mut fields: Vec<(&str, String)> = vec![
        ("options", json_array(&options)),
        ("recommendation", json_string(&recommendation)),
        ("impactBlocked", json_array(&impact_blocked)),
        ("impactAllowed", json_array(&impact_allowed)),
        (
            "confirmer",
            match &confirmer {
                Some(text) => json_string(text),
                None => "null".to_owned(),
            },
        ),
    ];
    // 卡点块来源的陈述追加优先级（键序：追加在 confirmer 之后，确定性）
    if let Some(priority) = priority {
        fields.push(("priority", json_string(priority)));
    }
    if let Some(linked_json) = linked_office_json {
        fields.push(("linkedOffice", linked_json.to_owned()));
    }
    if let Some(linked_json) = linked_pdf_json {
        fields.push(("linkedPdf", linked_json.to_owned()));
    }
    json_object(&fields)
}

fn resolve_local_href_parts(
    root_path: &str,
    relative_path: &str,
    href_raw: &str,
) -> Option<(String, Option<String>)> {
    let mut href = href_raw.trim().to_owned();
    if href.starts_with('<') && href.ends_with('>') && href.len() >= 2 {
        href = href[1..href.len() - 1].trim().to_owned();
    }
    if let Some(decoded) = decode_uri_component(&href) {
        href = decoded;
    }
    let (path_part, fragment) = match href.split_once('#') {
        Some((before, frag)) => (before.trim(), Some(frag.trim().to_owned())),
        None => (href.as_str(), None),
    };
    if path_part.is_empty() {
        return None;
    }
    let current_dir = match relative_path.rfind('/') {
        Some(index) => &relative_path[..index],
        None => ".",
    };
    let resolved = resolve_workspace_path(root_path, current_dir, path_part)?;
    Some((resolved, fragment))
}

fn parse_office_fragment(
    resolved_path: &str,
    fragment: &str,
) -> Option<crate::index::office::OfficeEvidenceAnchor> {
    let lower = resolved_path.to_ascii_lowercase();
    let frag = fragment.trim();
    if frag.is_empty() {
        return None;
    }
    if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xltx") {
        let (sheet, range_raw) = match frag.split_once('!') {
            Some((s, r)) => (s.trim().trim_matches('\''), r.trim()),
            None => ("", frag),
        };
        let normalized_range = range_raw.replace('$', "").to_ascii_uppercase();
        if normalized_range.is_empty() {
            return None;
        }
        let mut parts = normalized_range.split(':');
        let first_cell = parts.next()?.trim();
        crate::index::office::parse_cell_ref(first_cell)?;
        if let Some(second_cell) = parts.next() {
            if parts.next().is_some() {
                return None;
            }
            crate::index::office::parse_cell_ref(second_cell.trim())?;
        }
        return Some(crate::index::office::OfficeEvidenceAnchor {
            kind: "xlsx_range".to_owned(),
            sheet: (!sheet.is_empty()).then(|| sheet.to_owned()),
            cell_range: Some(normalized_range),
            paragraph: None,
            heading: None,
        });
    }
    if lower.ends_with(".docx") || lower.ends_with(".docm") || lower.ends_with(".dotx") {
        let num_str = frag
            .strip_prefix("para=")
            .or_else(|| frag.strip_prefix("para:"))
            .or_else(|| frag.strip_prefix("p="))
            .unwrap_or(frag);
        let para = num_str.trim().parse::<u64>().ok().filter(|n| *n > 0)?;
        return Some(crate::index::office::OfficeEvidenceAnchor {
            kind: "docx_paragraph".to_owned(),
            sheet: None,
            cell_range: None,
            paragraph: Some(para),
            heading: None,
        });
    }
    None
}

/// 解析 `.pdf#page=14` / `.pdf#p=14` / `.pdf#14` 片段（1-based 精确页码）
fn parse_pdf_fragment(
    resolved_path: &str,
    fragment: &str,
) -> Option<crate::index::pdf::PdfEvidenceAnchor> {
    if !resolved_path.to_ascii_lowercase().ends_with(".pdf") {
        return None;
    }
    let frag = fragment.trim();
    if frag.is_empty() {
        return None;
    }
    // 支持 RFC 3778 参数拼接如 page=14&view=FitH
    let mut page: Option<u64> = None;
    for part in frag.split('&') {
        let p = part.trim();
        let lower = p.to_ascii_lowercase();
        let num_str = if let Some(rest) = lower.strip_prefix("page=") {
            rest
        } else if let Some(rest) = lower.strip_prefix("page:") {
            rest
        } else if let Some(rest) = lower.strip_prefix("p=") {
            rest
        } else if let Some(rest) = lower.strip_prefix("p.") {
            rest
        } else if lower.chars().all(|c| c.is_ascii_digit()) {
            lower.as_str()
        } else {
            continue;
        };
        if let Ok(n) = num_str.trim().parse::<u64>() {
            if n > 0 {
                page = Some(n);
                break;
            }
        }
    }
    let page_num = page?;
    Some(crate::index::pdf::PdfEvidenceAnchor {
        kind: "pdf_page".to_owned(),
        page: page_num,
        heading: None,
        excerpt: None,
    })
}

/// 共享的 Markdown 本地锚点链接提取器（Office / PDF 复用，不重复扫描链接循环）
fn find_linked_anchor_json<A, F>(
    input: &DeriveInput<'_>,
    body_lines: &[&str],
    anchor_key: &str,
    parse_fn: F,
) -> Option<String>
where
    A: serde::Serialize,
    F: Fn(&str, &str) -> Option<A>,
{
    let pat = patterns();
    for line in body_lines {
        for captures in pat.link.captures_iter(line) {
            let Some(href_raw) = captures.get(2).map(|m| m.as_str()) else {
                continue;
            };
            if pat.external.is_match(href_raw) {
                continue;
            }
            let Some((resolved, Some(frag))) =
                resolve_local_href_parts(input.root_path, input.relative_path, href_raw)
            else {
                continue;
            };
            let Some(anchor) = parse_fn(&resolved, &frag) else {
                continue;
            };
            let Some(target_file_id) = input.path_index.get(&resolved) else {
                continue;
            };
            let Some(target_revision_id) = input.target_revision_index.get(target_file_id) else {
                continue;
            };
            let mut map = serde_json::Map::new();
            map.insert(
                "file_id".to_owned(),
                serde_json::Value::String(target_file_id.clone()),
            );
            map.insert(
                "revision_id".to_owned(),
                serde_json::Value::String(target_revision_id.clone()),
            );
            map.insert(
                "relative_path".to_owned(),
                serde_json::Value::String(resolved),
            );
            if let Ok(val) = serde_json::to_value(&anchor) {
                map.insert(anchor_key.to_owned(), val);
            }
            return serde_json::to_string(&serde_json::Value::Object(map)).ok();
        }
    }
    None
}

/// 从 Markdown 陈述正文中识别指向工作区内 `.xlsx#Sheet!CellRange` / `.docx#para=N` 的链接
fn detect_linked_office_evidence(input: &DeriveInput<'_>, body_lines: &[&str]) -> Option<String> {
    find_linked_anchor_json(input, body_lines, "office_anchor", parse_office_fragment)
}

/// 从 Markdown 陈述正文中识别指向工作区内 `.pdf#page=N` 的链接
fn detect_linked_pdf_evidence(input: &DeriveInput<'_>, body_lines: &[&str]) -> Option<String> {
    find_linked_anchor_json(input, body_lines, "pdf_anchor", parse_pdf_fragment)
}

/// 抽取引用关系并绑定到来源版本
pub fn derive_edges(input: &DeriveInput<'_>) -> Vec<EdgeRow> {
    if input.format != "md" {
        return Vec::new();
    }
    let pat = patterns();
    let lines: Vec<&str> = input.content.split('\n').collect();
    let mut edges: Vec<EdgeRow> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        for captures in pat.link.captures_iter(line) {
            let Some(href_raw) = captures.get(2) else {
                continue;
            };
            let href_raw = href_raw.as_str();
            if pat.external.is_match(href_raw) {
                continue;
            }

            let Some((resolved, _)) =
                resolve_local_href_parts(input.root_path, input.relative_path, href_raw)
            else {
                // 工作区之外或空锚点：不授予新目录权限
                continue;
            };

            let target_file_id = input.path_index.get(&resolved);
            let edge_identity = format!("{}|{}|{}", input.revision_id, resolved, index + 1);
            let edge_id = format!("edge_{}", stable_key(&edge_identity));
            if seen.contains(&edge_id) {
                continue;
            }
            seen.push(edge_id.clone());

            let target_revision_id = target_file_id
                .and_then(|file_id| input.target_revision_index.get(file_id))
                .cloned();
            let resolution = match (target_file_id, &target_revision_id) {
                (Some(_), Some(_)) => "collected_version",
                (Some(_), None) => "current_path_only",
                (None, _) => "unresolved",
            };

            edges.push(EdgeRow {
                edge_id,
                workspace_id: input.workspace_id.to_owned(),
                source_file_id: input.file_id.to_owned(),
                source_revision_id: input.revision_id.to_owned(),
                target_file_id: target_file_id
                    .cloned()
                    .unwrap_or_else(|| format!("unresolved:{resolved}")),
                target_revision_id,
                kind: "explicit_reference".to_owned(),
                resolution: resolution.to_owned(),
                locator_start: Some((index + 1) as i64),
                locator_end: Some((index + 1) as i64),
                reason: format!(
                    "{} 第 {} 行链接指向 {}{}",
                    input.relative_path,
                    index + 1,
                    resolved,
                    if resolution == "unresolved" {
                        "（工作区内未找到该路径）"
                    } else {
                        ""
                    }
                ),
            });
        }
    }
    edges
}

/// 从正文抽取「材料记载的发生时间」及其来源与精度
///
/// 优先级：front matter date / 文档日期 / 正文声明日期；都没有则返回 None 由
/// mtime 兜底。只有日期：保留到天，不补零点时刻。
pub fn derive_document_time(content: &str) -> DocumentTime {
    let pat = patterns();
    let mut candidates: Vec<String> = Vec::new();

    if let Some(fm) = pat.front_matter.captures(content) {
        let body = fm.get(1).map(|m| m.as_str()).unwrap_or("");
        if let Some(date_line) = pat.front_matter_date.captures(body) {
            if let Some(value) = date_line.get(1) {
                candidates.push(value.as_str().to_owned());
            }
        }
    }
    if let Some(doc_date) = pat.doc_date.captures(content) {
        if let Some(value) = doc_date.get(1) {
            candidates.push(value.as_str().to_owned());
        }
    }
    let head = slice_utf16(content, 1200);
    if let Some(iso) = pat.iso_date.captures(&head) {
        if let Some(value) = iso.get(1) {
            candidates.push(value.as_str().to_owned());
        }
    }

    for raw in candidates {
        let cleaned: String = raw
            .trim()
            .chars()
            .filter(|c| *c != '"' && *c != '\'')
            .collect();
        if let Some(captures) = pat.plain_date.captures(&cleaned) {
            let year = captures.get(1).map(|m| m.as_str()).unwrap_or("");
            let month = captures.get(2).map(|m| m.as_str()).unwrap_or("");
            let day = captures.get(3).map(|m| m.as_str()).unwrap_or("");
            return DocumentTime {
                occurred_at: Some(format!("{year}-{month}-{day}")),
                precision: "day".to_owned(),
                source: Some("document_self".to_owned()),
            };
        }
    }
    DocumentTime {
        occurred_at: None,
        precision: "unknown".to_owned(),
        source: None,
    }
}

/// Markdown 章节大纲（跳过代码块；`WorkspaceTransformer.ts:14-41`）
pub fn parse_markdown_outline(markdown: &str) -> Vec<(String, usize)> {
    let pat = patterns();
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut sections: Vec<(String, usize)> = Vec::new();
    let mut in_fence = false;
    for (index, raw) in lines.iter().enumerate() {
        let trimmed = raw.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(captures) = pat.outline.captures(trimmed) else {
            continue;
        };
        let title = captures
            .get(2)
            .map(|m| m.as_str().trim().to_owned())
            .unwrap_or_default();
        sections.push((title, index + 1));
    }
    sections
}

/// 把原文链接解析成工作区相对路径
fn resolve_workspace_path(root_path: &str, current_dir: &str, href: &str) -> Option<String> {
    let unix = href.replace('\\', "/");
    let norm_root = root_path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();

    let is_drive_absolute = {
        let bytes = unix.as_bytes();
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
    };
    if is_drive_absolute {
        let lower_unix = unix.to_lowercase();
        let lower_root = norm_root.to_lowercase();
        if lower_unix.starts_with(&format!("{lower_root}/")) {
            // 根路径前缀的字节长度与原串未必相同（小写化可能改变长度），
            // 用 get 取剩余部分：切点不是字符边界时返回 None（视为越界）。
            return unix
                .get(norm_root.len() + 1..)
                .map(|rest| normalize_join(".", rest));
        }
        if lower_unix == lower_root {
            return Some(String::new());
        }
        return None;
    }
    if let Some(rest) = unix.strip_prefix('/') {
        return Some(normalize_join(".", rest));
    }
    Some(normalize_join(current_dir, &unix))
}

/// 规范化相对路径拼接（`..` 越过根时是空操作）
fn normalize_join(dir: &str, rel: &str) -> String {
    let combined = match rel.strip_prefix('/') {
        Some(rest) => rest.to_owned(),
        None => format!("{dir}/{rel}"),
    };
    let mut stack: Vec<&str> = Vec::new();
    for part in combined.split('/') {
        if part == "." || part.is_empty() {
            continue;
        }
        if part == ".." {
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    stack.join("/")
}

/// `decodeURIComponent` 等价实现：失败返回 None（调用方保留原串）
fn decode_uri_component(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_owned());
    }
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = (bytes[index + 1] as char).to_digit(16)?;
            let low = (bytes[index + 2] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// UTF-16 码元切片（JS `String#slice` 语义）
///
/// 截断落在代理对中间时，JS 会留下落单代理项；Node 在写 UTF-8 时把它编码成
/// U+FFFD。Rust 的 `String` 无法表示落单代理项，故直接以 U+FFFD 收尾。
pub fn slice_utf16(text: &str, limit: usize) -> String {
    let mut out = String::with_capacity(text.len().min(limit * 3));
    let mut used = 0usize;
    for ch in text.chars() {
        let units = ch.len_utf16();
        if used + units > limit {
            if units == 2 {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(ch);
        used += units;
    }
    out
}

/// 手工拼 JSON 字符串（键序 = 给定顺序，与 TS `JSON.stringify` 插入序一致）
pub fn json_object(fields: &[(&str, String)]) -> String {
    let body = fields
        .iter()
        .map(|(key, value)| format!("{}:{}", json_string(key), value))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

/// JSON 字符串值（转义与 `JSON.stringify` 一致）
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// JSON 数组
pub fn json_array(items: &[String]) -> String {
    let body = items
        .iter()
        .map(|item| json_string(item))
        .collect::<Vec<_>>()
        .join(",");
    format!("[{body}]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_maps() -> (HashMap<String, String>, HashMap<String, String>) {
        (HashMap::new(), HashMap::new())
    }

    #[test]
    fn derives_format_a_statements() {
        let content = "\
# 标题

## 1 核心结论
**沿用编号**：Q01/Q02
状态：**待确认**

可选方案：甲 / 乙丙丁
推荐及理由：先做甲
影响与等待范围：需要后端接口；不阻断前端
确认人：张三
";
        let (path_index, target_index) = empty_maps();
        let input = DeriveInput {
            workspace_id: "ws_1",
            file_id: "f_1",
            revision_id: "f_1_r1",
            relative_path: "docs/a.md",
            folder: "docs",
            title: "a",
            format: "md",
            content,
            observed_at: "2026-11-17T00:00:00.000Z",
            root_path: "C:/root",
            path_index: &path_index,
            target_revision_index: &target_index,
        };
        let statements = derive_statements(&input);
        assert_eq!(statements.len(), 2);
        assert_eq!(statements[0].code, "Q01");
        assert_eq!(statements[1].code, "Q02");
        assert_eq!(statements[0].status, "待确认");
        assert_eq!(statements[0].namespace, "docs / a");
        assert_eq!(statements[0].line_start, 4);
        assert_eq!(statements[0].line_end, 11);
        // 身份与 TS 逐字一致（node tsx server/derive 实测值）：
        // 任何偏差都会与库里既有的 statement/decision 行分裂成第二套身份
        assert_eq!(statements[0].statement_id, "stmt_12ejv4h");
        assert_eq!(statements[1].statement_id, "stmt_5bgu70");
        assert_eq!(statements[0].decision_id.as_deref(), Some("dec_13m2itf"));
        // 同编号同问题归入同一决定
        assert_eq!(statements[0].decision_id, statements[1].decision_id);
        // detail_json 的键序固定；「甲」只有一个字，不满足 TS 的 >2 长度门槛
        assert_eq!(
            statements[0].detail_json,
            "{\"options\":[\"乙丙丁\"],\"recommendation\":\"先做甲\",\"impactBlocked\":[\"需要后端接口\"],\"impactAllowed\":[\"不阻断前端\"],\"confirmer\":\"张三\"}"
        );
    }

    #[test]
    fn derives_format_b_statements() {
        let content = "\
### Q07：是否发布新价格
状态：**已确认**
确认人：李四
";
        let (path_index, target_index) = empty_maps();
        let input = DeriveInput {
            workspace_id: "ws_1",
            file_id: "f_1",
            revision_id: "f_1_r1",
            relative_path: "a.md",
            folder: ".",
            title: "a",
            format: "md",
            content,
            observed_at: "2026-11-17T00:00:00.000Z",
            root_path: "C:/root",
            path_index: &path_index,
            target_revision_index: &target_index,
        };
        let statements = derive_statements(&input);
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].code, "Q07");
        assert_eq!(statements[0].question, "是否发布新价格");
        assert_eq!(statements[0].status, "已确认");
        assert_eq!(statements[0].line_start, 1);
        assert_eq!(statements[0].line_end, 3);
        // 身份与 TS 逐字一致（node tsx server/derive 实测值）
        assert_eq!(statements[0].statement_id, "stmt_1ffz02g");
        assert_eq!(statements[0].decision_id.as_deref(), Some("dec_1bm8in4"));
        assert_eq!(statements[0].quote, "状态：已确认 确认人：李四");
        assert_eq!(
            statements[0].detail_json,
            "{\"options\":[],\"recommendation\":\"\",\"impactBlocked\":[],\"impactAllowed\":[],\"confirmer\":\"李四\"}"
        );
        // 顶层文件的命名空间不带目录前缀
        assert_eq!(statements[0].namespace, "a");
    }

    #[test]
    fn derives_edges_with_workspace_paths() {
        let content =
            "看 [方案](./方案.md) 与 [绝对](<C:/root/docs/b.md>) 与 [外链](https://x.dev/a)。\n";
        let mut path_index = HashMap::new();
        path_index.insert("docs/方案.md".to_owned(), "f_a".to_owned());
        path_index.insert("docs/b.md".to_owned(), "f_b".to_owned());
        let mut target_index = HashMap::new();
        target_index.insert("f_a".to_owned(), "f_a_r1".to_owned());
        let input = DeriveInput {
            workspace_id: "ws_1",
            file_id: "f_1",
            revision_id: "f_1_r1",
            relative_path: "docs/a.md",
            folder: "docs",
            title: "a",
            format: "md",
            content,
            observed_at: "2026-11-17T00:00:00.000Z",
            root_path: "C:/root",
            path_index: &path_index,
            target_revision_index: &target_index,
        };
        let edges = derive_edges(&input);
        assert_eq!(edges.len(), 2);
        // 相对路径按当前文档目录解析
        let first = edges
            .iter()
            .find(|e| e.target_file_id == "f_a")
            .expect("相对链接应有边");
        assert_eq!(first.resolution, "collected_version");
        assert_eq!(first.target_revision_id.as_deref(), Some("f_a_r1"));
        assert_eq!(first.reason, "docs/a.md 第 1 行链接指向 docs/方案.md");
        // 绝对路径落在工作区内才映射
        let second = edges
            .iter()
            .find(|e| e.target_file_id == "f_b")
            .expect("工作区内绝对链接应有边");
        assert_eq!(second.resolution, "current_path_only");
        assert_eq!(second.reason, "docs/a.md 第 1 行链接指向 docs/b.md");
        // 外链不成边
        assert!(edges.iter().all(|e| !e.reason.contains("x.dev")));
    }

    #[test]
    fn document_time_priority() {
        // front matter 优先
        let time = derive_document_time("---\ndate: 2026-01-02\n---\n\n文档日期：2026-03-04");
        assert_eq!(time.occurred_at.as_deref(), Some("2026-01-02"));
        assert_eq!(time.precision, "day");
        assert_eq!(time.source.as_deref(), Some("document_self"));

        // 无 front matter 时取文档日期
        let time = derive_document_time("正文\n\n文档日期：2026-03-04\n");
        assert_eq!(time.occurred_at.as_deref(), Some("2026-03-04"));

        // 都没有时取正文前 1200 字符里的首个 ISO 日期
        let time = derive_document_time("开篇 2026-05-06 提了一句");
        assert_eq!(time.occurred_at.as_deref(), Some("2026-05-06"));

        // 没有日期
        let time = derive_document_time("没有任何日期");
        assert_eq!(time.occurred_at, None);
        assert_eq!(time.precision, "unknown");
    }

    #[test]
    fn utf16_slice_matches_js() {
        // JS '😀'.slice(0,1) 留下落单代理项，编码成 UTF-8 时是 U+FFFD
        assert_eq!(slice_utf16("😀", 1), "\u{FFFD}");
        assert_eq!(slice_utf16("😀", 2), "😀");
        assert_eq!(slice_utf16("中文", 1), "中");
    }

    #[test]
    fn outline_skips_code_fences() {
        let outline = parse_markdown_outline("# A\n```\n# not a heading\n```\n## B\n");
        let titles: Vec<&str> = outline.iter().map(|(title, _)| title.as_str()).collect();
        assert_eq!(titles, vec!["A", "B"]);
    }

    #[test]
    fn json_helpers_escape_like_json_stringify() {
        assert_eq!(json_string("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
        assert_eq!(json_array(&["x".to_owned()]), "[\"x\"]");
    }
}

#[cfg(test)]
mod decision_block_statement_tests {
    use super::*;

    fn empty_maps() -> (HashMap<String, String>, HashMap<String, String>) {
        (HashMap::new(), HashMap::new())
    }

    /// 格式 C（PRD v2.0 §3.3 卡点块）→ StatementRow：code=优先级词、detail_json 追加
    /// priority 键、status 由括号形态判定；A/B 路径的 detail_json 不受影响
    #[test]
    fn derives_decision_block_statements_with_priority() {
        let pending = "[P1 - 待确认] 属性字典与历史更新策略\n决定：___\n确认人：___\n可选方案：甲方案 / 乙方案\n";
        let (path_index, target_index) = empty_maps();
        let input = DeriveInput {
            workspace_id: "ws_1",
            file_id: "f_1",
            revision_id: "f_1_r1",
            relative_path: "docs/03-待确认事项.md",
            folder: "docs",
            title: "03-待确认事项",
            format: "md",
            content: pending,
            observed_at: "2026-11-17T00:00:00.000Z",
            root_path: "C:/root",
            path_index: &path_index,
            target_revision_index: &target_index,
        };
        let statements = derive_statements(&input);
        assert_eq!(statements.len(), 1);
        let row = &statements[0];
        assert_eq!(row.code, "P1", "卡点块陈述的 code = 优先级词");
        assert_eq!(row.status, "待确认");
        assert_eq!(row.line_start, 1);
        assert_eq!(row.line_end, 4);
        // detail_json：既有五键序不变、尾部追加 priority（仅卡点块携带）
        assert_eq!(
            row.detail_json,
            "{\"options\":[\"甲方案\",\"乙方案\"],\"recommendation\":\"\",\"impactBlocked\":[],\"impactAllowed\":[],\"confirmer\":\"___\",\"priority\":\"P1\"}"
        );
        let decision_id = row.decision_id.clone().expect("卡点块必有 decision_id");
        assert!(decision_id.starts_with("dec_"));
        // 与 decision_block 解析器同源：同问题同决定
        let block = crate::index::decision_block::parse_decision_blocks(pending);
        assert_eq!(
            block[0]
                .to_decision_item(row.namespace.as_str(), "待确认")
                .decision_id,
            decision_id
        );

        // 回写后形态：括号已确认 → status 已确认（detect_status 新括号规则）
        let confirmed =
            "[P1 - 已确认] 属性字典与历史更新策略\n决定：采用两阶段状态锁\n确认人：架构组\n";
        let input = DeriveInput {
            content: confirmed,
            revision_id: "f_1_r2",
            ..input
        };
        let statements = derive_statements(&input);
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].status, "已确认");
        assert!(
            !statements[0].detail_json.contains("\"decision\""),
            "detail_json 不含 decision 字段（拍板结果走回写与 decision 事件，不进陈述）"
        );
    }

    /// 既有格式 A/B 的 detail_json 不受 priority 参数影响（parity 硬保证）
    #[test]
    fn format_a_detail_json_unchanged_without_priority() {
        let content = "\
## 1 核心结论
**沿用编号**：Q01
状态：**待确认**
确认人：张三
";
        let (path_index, target_index) = empty_maps();
        let input = DeriveInput {
            workspace_id: "ws_1",
            file_id: "f_1",
            revision_id: "f_1_r1",
            relative_path: "docs/a.md",
            folder: "docs",
            title: "a",
            format: "md",
            content,
            observed_at: "2026-11-17T00:00:00.000Z",
            root_path: "C:/root",
            path_index: &path_index,
            target_revision_index: &target_index,
        };
        let statements = derive_statements(&input);
        assert_eq!(statements.len(), 1);
        assert_eq!(
            statements[0].detail_json,
            "{\"options\":[],\"recommendation\":\"\",\"impactBlocked\":[],\"impactAllowed\":[],\"confirmer\":\"张三\"}",
            "A/B 路径 detail_json 无 priority 键（与 TS 逐字一致）"
        );
    }
}
