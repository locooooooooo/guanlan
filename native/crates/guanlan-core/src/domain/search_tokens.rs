//! 混合倒排索引 · 纯函数分词器（契约 contract-query-api.md §2.4）。
//!
//! 建索引侧（`index/search_index.rs`）与查询侧（`query/search.rs`）共用同一套
//! 归一化与分词规则——词项进得去就一定查得出，这是「中文双字与专有编号召回
//! 准确率 100%」的结构保证；短语级准确性由查询侧对 `search_docs.body_text`
//! 的行级回源核验兜底（候选宽、核验严）。
//!
//! 规则口径（对齐前端 `searchWorkspace` / `generateChineseBigrams`，
//! `src/utils/guanlanEngine.ts`）：
//! - 中文：连续 CJK 段做双字 Bigram（另索引单字供有界回退）；
//! - 英文/数字：`[a-z0-9_#-]+` 连续段为词元（小写化）；
//! - 专有编号：`ac-03` / `rfc_2616` / `#39` / 前端内部 ID 四式（`q\d+|t-\d+|cand-\d+|rev_\w+|file_\w+`）
//!   整体成词，查询走精确编号核验；
//! - 路径/标题：按分隔符切段，英文段另产首字母缩写词（`user-auth-service` → `uas`），
//!   中文段产 Bigram——文件名缩写/子串均可召回。
//! - 空白折叠：查询与正文的匹配统一在「小写化 + 连续空白折叠为单个空格」的
//!   norm 口径上进行（前端 `qLower` 保留空格语义的确定化版本）。

use std::collections::BTreeSet;

/// 查询模式（契约 §2.4 mode；matchStrategy 四态由此派生）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryMode {
    Empty,
    Code,
    Single,
    Phrase,
}

/// 查询计划：postings 交集词项与回源核验材料
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryPlan {
    /// 原始查询（trim 后）
    pub raw: String,
    /// 小写化 + 连续空白折叠为单个空格（行级核验统一口径）
    pub norm: String,
    pub mode: QueryMode,
    /// 精确编号词项（Code 模式非空；Phrase 模式内嵌编号时也可有）
    pub code_term: Option<String>,
    /// 单字（Single 模式恰一个 char）
    pub singles: Vec<char>,
    /// CJK 双字 Bigram（Phrase 模式；去重升序）
    pub bigrams: Vec<String>,
    /// ASCII 词元（Phrase 模式；去重升序，含查询内嵌编号词）
    pub words: Vec<String>,
}

impl QueryPlan {
    /// postings 交集词项全集（按模式；均小写）
    pub fn intersection_terms(&self) -> Vec<String> {
        match self.mode {
            QueryMode::Empty => Vec::new(),
            QueryMode::Code => self.code_term.clone().into_iter().collect(),
            QueryMode::Single => self.singles.iter().map(|c| c.to_string()).collect(),
            QueryMode::Phrase => {
                let mut terms: BTreeSet<String> = BTreeSet::new();
                terms.extend(self.bigrams.iter().cloned());
                terms.extend(self.words.iter().cloned());
                if let Some(code) = &self.code_term {
                    terms.insert(code.clone());
                }
                terms.into_iter().collect()
            }
        }
    }
}

/// 判定 CJK（对齐 `is_cjk_codepoint` 的主区段：表意文字 + 全角标点 + 兼容表意）
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF01..=0xFF5E)
}

fn is_word_byte(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '#' || c == '-'
}

/// 小写化 + 连续空白折叠为单个空格 + trim（行级核验与 filename 核验的统一口径）
pub fn normalize_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.extend(c.to_lowercase());
        }
    }
    out
}

fn is_internal_id(norm: &str) -> bool {
    let lower = norm.to_ascii_lowercase();
    let digits_only = |r: &str| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit());
    if let Some(r) = lower.strip_prefix('q') {
        if digits_only(r) {
            return true;
        }
    }
    if let Some(r) = lower.strip_prefix("t-") {
        if digits_only(r) {
            return true;
        }
    }
    if let Some(r) = lower.strip_prefix("cand-") {
        if digits_only(r) {
            return true;
        }
    }
    for prefix in ["rev_", "file_"] {
        if let Some(r) = lower.strip_prefix(prefix) {
            if !r.is_empty() && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return true;
            }
        }
    }
    false
}

fn is_generic_code(norm: &str) -> bool {
    let bytes = norm.as_bytes();
    if bytes.len() < 3 || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let sep = bytes.iter().position(|&b| b == b'-' || b == b'_');
    let Some(sep) = sep else {
        return false;
    };
    if sep == 0
        || !bytes[..sep]
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return false;
    }
    let digits = &bytes[sep + 1..];
    !digits.is_empty() && digits.len() <= 6 && digits.iter().all(u8::is_ascii_digit)
}

/// 整查询是否为专有编号（Code 模式判定）
pub fn classify_code(norm: &str) -> bool {
    if let Some(digits) = norm.strip_prefix('#') {
        return !digits.is_empty()
            && digits.len() <= 8
            && digits.bytes().all(|b| b.is_ascii_digit());
    }
    is_internal_id(norm) || is_generic_code(norm)
}

/// 查询解析（入口纯函数）：norm → 模式 + 交集词项材料
pub fn plan_query(raw_query: &str) -> QueryPlan {
    let raw = raw_query.trim().to_owned();
    let norm = normalize_text(&raw);
    if norm.is_empty() {
        return QueryPlan {
            raw,
            norm,
            mode: QueryMode::Empty,
            code_term: None,
            singles: Vec::new(),
            bigrams: Vec::new(),
            words: Vec::new(),
        };
    }

    let char_count = norm.chars().count();
    if char_count == 1 {
        let c = norm.chars().next().unwrap_or('\u{0}');
        return QueryPlan {
            raw,
            norm,
            mode: QueryMode::Single,
            code_term: None,
            singles: vec![c],
            bigrams: Vec::new(),
            words: Vec::new(),
        };
    }

    if !norm.contains(' ') && classify_code(&norm) {
        return QueryPlan {
            raw,
            norm: norm.clone(),
            mode: QueryMode::Code,
            code_term: Some(norm.clone()),
            singles: Vec::new(),
            bigrams: Vec::new(),
            words: Vec::new(),
        };
    }

    let (bigrams, words) = tokenize_mixed(&norm);
    QueryPlan {
        raw,
        norm,
        mode: QueryMode::Phrase,
        code_term: None,
        singles: Vec::new(),
        bigrams,
        words,
    }
}

/// 混合文本 → (CJK Bigrams, ASCII 词元)。词元含编号整词（`ac-03`）与其拆分词。
/// 供查询侧（Phrase）与建索引侧（行/段分词）共用。
pub fn tokenize_mixed(norm_text: &str) -> (Vec<String>, Vec<String>) {
    let mut bigrams: BTreeSet<String> = BTreeSet::new();
    let mut words: BTreeSet<String> = BTreeSet::new();
    let mut cjk_run = String::new();
    let mut word_run = String::new();

    let flush_cjk = |cjk_run: &mut String, bigrams: &mut BTreeSet<String>| {
        let chars: Vec<char> = cjk_run.chars().collect();
        if chars.len() >= 2 {
            for w in chars.windows(2) {
                bigrams.insert(w.iter().collect::<String>());
            }
        }
        cjk_run.clear();
    };
    let flush_word = |word_run: &mut String, words: &mut BTreeSet<String>| {
        if !word_run.is_empty() {
            words.insert(word_run.clone());
            for part in word_run.split(['-', '_', '#']) {
                if part.len() >= 2 && part.bytes().any(|b| b.is_ascii_alphabetic()) {
                    words.insert(part.to_owned());
                }
            }
            word_run.clear();
        }
    };

    for c in norm_text.chars() {
        if is_cjk(c) {
            flush_word(&mut word_run, &mut words);
            cjk_run.push(c);
        } else if is_word_byte(c) {
            flush_cjk(&mut cjk_run, &mut bigrams);
            word_run.push(c);
        } else {
            flush_cjk(&mut cjk_run, &mut bigrams);
            flush_word(&mut word_run, &mut words);
        }
    }
    flush_cjk(&mut cjk_run, &mut bigrams);
    flush_word(&mut word_run, &mut words);

    (bigrams.into_iter().collect(), words.into_iter().collect())
}

/// 段内首字母缩写词（文件名缩写检索）：`user-auth-service` → `uas`；
/// 段须由 ≥2 个 ASCII 字母开头的子段组成、总长 ≤ 12 才产缩写。
pub fn acronym_of_segment(norm_segment: &str) -> Option<String> {
    let parts: Vec<&str> = norm_segment
        .split(['-', '_', '.'])
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let mut acronym = String::new();
    for part in &parts {
        let first = part.chars().next()?;
        if !first.is_ascii_alphabetic() {
            return None;
        }
        acronym.push(first);
    }
    if acronym.len() >= 2 && acronym.len() <= 12 {
        Some(acronym)
    } else {
        None
    }
}

/// 路径/标题字段词项（field 由调用方标注）。
/// 两段式切分：先按 `/` `.` `\` 切**路径段**（保留段内 `-`/`_` 连接——整段词
/// 与首字母缩写都在这一层产生），再在段内按 `-`/`_` 拆**子词**（各子词连同
/// 其 CJK Bigram 与单字入词集）。
pub fn path_field_tokens(norm_path: &str) -> Vec<String> {
    let mut tokens: BTreeSet<String> = BTreeSet::new();
    for segment in norm_path.split(['/', '.', '\\']).filter(|s| !s.is_empty()) {
        if segment.len() >= 2
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            tokens.insert(segment.to_owned());
        }
        for part in segment.split(['-', '_']).filter(|p| !p.is_empty()) {
            let chars: Vec<char> = part.chars().collect();
            if part.len() >= 2 && part.bytes().all(|b| b.is_ascii()) {
                tokens.insert(part.to_owned());
            }
            if chars.len() >= 2 {
                for w in chars.windows(2) {
                    tokens.insert(w.iter().collect::<String>());
                }
            }
            for c in &chars {
                tokens.insert(c.to_string());
            }
        }
        if let Some(acronym) = acronym_of_segment(segment) {
            tokens.insert(acronym);
        }
    }
    tokens.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_folds_case_and_whitespace() {
        assert_eq!(normalize_text("  Hello   世界 "), "hello 世界");
        assert_eq!(normalize_text("AC-03"), "ac-03");
        assert_eq!(normalize_text(""), "");
    }

    #[test]
    fn code_classification_matches_internal_ids_and_business_codes() {
        for q in ["q12", "T-204", "cand-9", "rev_ab12", "file_x"] {
            assert!(classify_code(&normalize_text(q)), "{q} 应为编号");
        }
        for q in ["ac-03", "RFC_2616", "#39", "#7"] {
            assert!(classify_code(&normalize_text(q)), "{q} 应为编号");
        }
        for q in [
            "render",
            "ac",
            "ac-",
            "ac-1234567",
            "-03",
            "39#",
            "登录方案",
        ] {
            assert!(!classify_code(&normalize_text(q)), "{q} 不应为编号");
        }
    }

    #[test]
    fn plan_query_modes() {
        assert_eq!(plan_query("   ").mode, QueryMode::Empty);
        let single = plan_query("决");
        assert_eq!(single.mode, QueryMode::Single);
        assert_eq!(single.singles, vec!['决']);
        let code = plan_query(" AC-03 ");
        assert_eq!(code.mode, QueryMode::Code);
        assert_eq!(code.code_term.as_deref(), Some("ac-03"));
        let zh = plan_query("登录方案");
        assert_eq!(zh.mode, QueryMode::Phrase);
        assert_eq!(zh.bigrams, vec!["录方", "方案", "登录"]);
        assert!(zh.words.is_empty());
        let en = plan_query("user auth");
        assert_eq!(en.mode, QueryMode::Phrase);
        assert!(en.bigrams.is_empty());
        assert_eq!(en.words, vec!["auth", "user"]);
        let mixed = plan_query("登录 login");
        assert_eq!(mixed.mode, QueryMode::Phrase);
        assert_eq!(mixed.bigrams, vec!["登录"]);
        assert_eq!(mixed.words, vec!["login"]);
        let mc = plan_query("方案 ac-03");
        assert_eq!(mc.mode, QueryMode::Phrase);
        assert_eq!(mc.bigrams, vec!["方案"]);
        assert!(mc.words.contains(&"ac-03".to_owned()));
    }

    #[test]
    fn tokenize_mixed_extracts_bigrams_words_and_codes() {
        let (bigrams, words) = tokenize_mixed("决策文档 ac-03 #39 review");
        assert!(bigrams.contains(&"决策".to_owned()));
        assert!(bigrams.contains(&"策文".to_owned()));
        assert!(bigrams.contains(&"文档".to_owned()));
        assert!(!bigrams.contains(&"文a".to_owned()));
        assert!(words.contains(&"ac-03".to_owned()));
        assert!(words.contains(&"#39".to_owned()));
        assert!(words.contains(&"review".to_owned()));
        assert!(words.contains(&"ac".to_owned()));
        assert!(!words.contains(&"03".to_owned()));
        let (bigrams2, words2) = tokenize_mixed("决策ac-03");
        assert!(bigrams2.contains(&"决策".to_owned()));
        assert!(words2.contains(&"ac-03".to_owned()));
        assert!(words2.contains(&"ac".to_owned()));
    }

    #[test]
    fn path_tokens_cover_segments_bigrams_and_acronym() {
        let tokens = path_field_tokens(&normalize_text("docs/设计/user-auth-service.ts"));
        assert!(tokens.contains(&"设计".to_owned()));
        assert!(tokens.contains(&"docs".to_owned()));
        assert!(tokens.contains(&"user-auth-service".to_owned()));
        assert!(tokens.contains(&"uas".to_owned()));
        assert!(tokens.contains(&"ts".to_owned()));
        let zh = path_field_tokens(&normalize_text("交付/清单/登录方案-验收清单.docx"));
        assert!(zh.contains(&"登录".to_owned()));
        assert!(zh.contains(&"方案".to_owned()));
        assert!(zh.contains(&"验收".to_owned()));
        assert!(zh.contains(&"登".to_owned()));
    }

    #[test]
    fn intersection_terms_per_mode() {
        let plan = plan_query("ac-03");
        assert_eq!(plan.intersection_terms(), vec!["ac-03".to_owned()]);
        let plan = plan_query("登录方案");
        assert_eq!(
            plan.intersection_terms(),
            vec!["录方".to_owned(), "方案".to_owned(), "登录".to_owned()]
        );
        let plan = plan_query("决");
        assert_eq!(plan.intersection_terms(), vec!["决".to_owned()]);
    }
}
