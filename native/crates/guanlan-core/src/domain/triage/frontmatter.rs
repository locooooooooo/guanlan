//! 轻量 Frontmatter 与 Markdown 任务行抽取器（与 `markdown-index.js` 口径逐项对齐）。
//!
//! 负责把原始 Markdown 文本解析为 [`TriageFileInput`]：
//! - 顶部 `---` 围栏 Frontmatter（前 80 行内，无外部 YAML 依赖，单双引号剥离，键小写化）；
//! - `workflowMeta` 办理要素提取（`account / loginUrl / question / options / impact / acknowledgement`）；
//! - 围栏代码块（`` ``` `` / `~~~`）内部行跳过，不误抽示例代码里的 `- [ ]` 或 `TODO:`；
//! - 识别 `- [ ]` / `- [x]` / `- [X]` / `- [/]` / `TODO:`，忽略已取消 `- [-]` 与已推迟 `- [>]`；
//! - 保留 1-based 来源行号、`indent` 缩进宽度、`raw_text` 与清洗后 `text`。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;

use super::classifier::{TaskSyntax, TriageFileInput, TriageTaskInput, WorkflowMeta};

/// 端到端 Markdown 分流输入。
#[derive(Debug, Clone, Copy)]
pub struct MarkdownDocInput<'a> {
    pub path: &'a str,
    pub content: &'a str,
    pub modified_at: i64,
}

fn frontmatter_kv_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$").expect("valid fm kv regex"))
}

fn fence_open_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s{0,3}(`{3,}|~{3,})\s*[^`~]*$").expect("valid fence regex"))
}

fn h1_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*#\s+(.+?)\s*#*\s*$").expect("valid h1 regex"))
}

fn checkbox_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(\s*[-*+]\s+)\[([ xX/\->])\]\s+(.+?)\s*$").expect("valid checkbox regex")
    })
}

fn todo_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^\s*TODO:\s*(.+?)\s*$").expect("valid todo regex"))
}

fn due_at_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\s+@due\(\d{4}-\d{2}-\d{2}\)\s*").expect("valid @due regex"))
}

fn due_colon_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\s+due:\d{4}-\d{2}-\d{2}\s*").expect("valid due: regex"))
}

fn bold_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\*\*([^*]+)\*\*").expect("valid bold regex"))
}

fn code_span_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"`([^`]+)`").expect("valid code span regex"))
}

fn multi_ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").expect("valid ws regex"))
}

fn inline_tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:^|\s)#([\p{L}\p{N}_-]+)").expect("valid inline tag regex"))
}

fn hex_color_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$").expect("valid hex regex"))
}

fn numeric_only_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d+(?:\.\d+)*$").expect("valid numeric regex"))
}

fn strip_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
    {
        &value[1..value.len() - 1]
    } else if bytes.len() == 1 && (bytes[0] == b'\'' || bytes[0] == b'"') {
        ""
    } else {
        value
            .strip_prefix(['\'', '"'])
            .unwrap_or(value)
            .strip_suffix(['\'', '"'])
            .unwrap_or(value)
    }
}

/// 解析顶部轻量 YAML Frontmatter（与 `markdown-index.js::extractFrontMatter` 同口径）。
pub fn extract_frontmatter(content: &str) -> BTreeMap<String, String> {
    let lines: Vec<&str> = content
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return BTreeMap::new();
    }
    let mut map = BTreeMap::new();
    let limit = lines.len().min(80);
    for line in &lines[1..limit] {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(caps) = frontmatter_kv_re().captures(trimmed) {
            let key = caps[1].to_lowercase();
            let val = strip_quotes(&caps[2]).to_owned();
            map.insert(key, val);
        }
    }
    map
}

fn normalize_meta_list(value: Option<&String>) -> Vec<String> {
    let raw = match value {
        Some(v) => v.trim(),
        None => return Vec::new(),
    };
    if raw.is_empty() {
        return Vec::new();
    }
    let inner = raw
        .strip_prefix('[')
        .unwrap_or(raw)
        .strip_suffix(']')
        .unwrap_or(raw);
    inner
        .split([',', ';', '，', '；'])
        .map(|item| strip_quotes(item.trim()).to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

fn first_non_empty(fm: &BTreeMap<String, String>, keys: &[&str]) -> String {
    for k in keys {
        if let Some(v) = fm.get(*k) {
            let t = v.trim();
            if !t.is_empty() {
                return t.to_owned();
            }
        }
    }
    String::new()
}

/// 提取人工办理元数据（只读文档 Frontmatter，绝不执行其中任何内容）。
pub fn extract_workflow_meta(frontmatter: &BTreeMap<String, String>) -> WorkflowMeta {
    let account = first_non_empty(frontmatter, &["account", "loginaccount", "login-account"]);
    let login_url = first_non_empty(frontmatter, &["login-url", "loginurl", "url"]);
    let question = first_non_empty(frontmatter, &["question", "decision", "decision-question"]);
    let impact = first_non_empty(frontmatter, &["impact", "decision-impact"]);
    let options_raw = frontmatter
        .get("options")
        .or_else(|| frontmatter.get("choices"))
        .or_else(|| frontmatter.get("decision-options"));
    let mut options = normalize_meta_list(options_raw);
    options.truncate(8);
    let acknowledgement = first_non_empty(frontmatter, &["acknowledgement", "acknowledgment"]);
    WorkflowMeta {
        account,
        login_url,
        question,
        options,
        impact,
        acknowledgement,
    }
}

/// 清洗任务文本（与 `markdown-index.js::cleanTaskText` 一致）。
pub fn clean_task_text(value: &str) -> String {
    let s = due_at_re().replace_all(value, " ");
    let s = due_colon_re().replace_all(&s, " ");
    let s = bold_re().replace_all(&s, "$1");
    let s = code_span_re().replace_all(&s, "$1");
    multi_ws_re().replace_all(&s, " ").trim().to_owned()
}

fn is_meaningful_tag(value: &str) -> bool {
    let tag = value.trim().trim_start_matches('#');
    let char_len = tag.chars().count();
    if !(2..=32).contains(&char_len) {
        return false;
    }
    if hex_color_re().is_match(tag) || numeric_only_re().is_match(tag) {
        return false;
    }
    true
}

fn path_basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn path_stem(path: &str) -> &str {
    let base = path_basename(path);
    match base.rfind('.') {
        Some(idx) if idx > 0 => &base[..idx],
        _ => base,
    }
}

fn path_ext_lower(path: &str) -> String {
    let base = path_basename(path);
    match base.rfind('.') {
        Some(idx) if idx > 0 && idx + 1 < base.len() => base[idx + 1..].to_lowercase(),
        _ => "md".to_owned(),
    }
}

fn derive_category(file_path: &str, fm: &BTreeMap<String, String>) -> String {
    for list in [
        normalize_meta_list(fm.get("category")),
        normalize_meta_list(fm.get("categories")),
    ] {
        if let Some(tag) = list.into_iter().find(|t| is_meaningful_tag(t)) {
            return tag;
        }
    }
    let normalized = file_path.replace('\\', "/");
    let parent = match normalized.rfind('/') {
        Some(idx) if idx > 0 => &normalized[..idx],
        _ => return "未分类".to_owned(),
    };
    let name = parent.rsplit('/').next().unwrap_or("");
    let is_drive =
        name.len() == 2 && name.as_bytes()[0].is_ascii_alphabetic() && name.as_bytes()[1] == b':';
    if name.is_empty() || is_drive {
        "未分类".to_owned()
    } else {
        name.to_owned()
    }
}

fn derive_subject(content: &str, fm: &BTreeMap<String, String>) -> String {
    for key in ["subject", "topic", "tags"] {
        if let Some(tag) = normalize_meta_list(fm.get(key))
            .into_iter()
            .find(|t| is_meaningful_tag(t))
        {
            return tag;
        }
    }
    for caps in inline_tag_re().captures_iter(content) {
        if let Some(m) = caps.get(1) {
            if is_meaningful_tag(m.as_str()) {
                return m.as_str().to_owned();
            }
        }
    }
    "未指定".to_owned()
}

fn is_fence_closer(line: &str, marker: char, min_len: usize) -> bool {
    let trimmed_leading = line.trim_start_matches([' ', '\t']);
    let leading_spaces = line.len() - trimmed_leading.len();
    if leading_spaces > 3 {
        return false;
    }
    let trimmed = trimmed_leading.trim_end();
    trimmed.len() >= min_len && trimmed.chars().all(|c| c == marker)
}

/// 将单篇 Markdown 文档解析为四车道分流输入（Frontmatter + 任务行 + 围栏代码块过滤）。
pub fn parse_markdown_for_triage(path: &str, content: &str, modified_at: i64) -> TriageFileInput {
    let lines: Vec<&str> = content
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .collect();
    let name = path_basename(path).to_owned();
    let file_stem = path_stem(path);
    let extension = path_ext_lower(path);
    let fm = extract_frontmatter(content);
    let workflow_meta = extract_workflow_meta(&fm);

    let mut title = file_stem.to_owned();
    let mut title_found = false;
    let mut tasks = Vec::new();
    let mut active_fence: Option<(char, usize)> = None;

    for (index, line) in lines.iter().enumerate() {
        if let Some((marker, min_len)) = active_fence {
            if is_fence_closer(line, marker, min_len) {
                active_fence = None;
            }
            continue;
        }
        if let Some(caps) = fence_open_re().captures(line) {
            let marker_run = &caps[1];
            let marker = marker_run.chars().next().unwrap_or('`');
            active_fence = Some((marker, marker_run.len()));
            continue;
        }
        if !title_found {
            if let Some(caps) = h1_re().captures(line) {
                title = caps[1].trim().to_owned();
                title_found = true;
            }
        }
        if let Some(caps) = checkbox_re().captures(line) {
            let prefix = &caps[1];
            let mark = &caps[2];
            let raw_body = caps[3].trim();
            if mark == "-" || mark == ">" {
                continue;
            }
            let indent = prefix.chars().take_while(|c| c.is_whitespace()).count();
            let text = clean_task_text(raw_body);
            let (syntax, completed) = if mark == "/" {
                (TaskSyntax::Progress, false)
            } else {
                (TaskSyntax::Checkbox, mark.eq_ignore_ascii_case("x"))
            };
            tasks.push(TriageTaskInput {
                id: String::new(),
                path: path.to_owned(),
                line: index + 1,
                text,
                raw_text: raw_body.to_owned(),
                completed,
                syntax,
                indent,
                workflow: None,
                route: None,
                needs: None,
                lane: None,
            });
            continue;
        }
        if let Some(caps) = todo_re().captures(line) {
            let raw_body = &caps[1];
            let indent = line.chars().take_while(|c| c.is_whitespace()).count();
            let text = clean_task_text(raw_body);
            tasks.push(TriageTaskInput {
                id: String::new(),
                path: path.to_owned(),
                line: index + 1,
                text,
                raw_text: caps[0].trim().to_owned(),
                completed: false,
                syntax: TaskSyntax::Todo,
                indent,
                workflow: None,
                route: None,
                needs: None,
                lane: None,
            });
        }
    }

    let doc_type = first_non_empty(&fm, &["type", "kind"]);
    let workflow = first_non_empty(&fm, &["workflow", "route", "needs"]);

    TriageFileInput {
        path: path.to_owned(),
        name,
        title,
        doc_type: if doc_type.is_empty() {
            extension
        } else {
            doc_type
        },
        workflow: if workflow.is_empty() {
            None
        } else {
            Some(workflow)
        },
        workflow_meta,
        category: derive_category(path, &fm),
        subject: derive_subject(content, &fm),
        modified_at,
        tasks,
    }
}
