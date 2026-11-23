//! C02 有界检索（契约 contract-query-api.md §2.4 /api/v1/search）。
//!
//! 三通道混合：
//! 1. **倒排候选**：`search_postings` 按词项（Bigram/词元/编号/单字）取 posting
//!    列表做跨词项 AND 交集——候选宽，规模与 posting 表成正比；
//! 2. **回源核验**：候选文件的 `search_docs.body_text` 行级扫描——查询短语
//!    必须在**同一行**内原样出现（小写口径），否则丢弃。中文双字与专有编号
//!    的「召回准确率 100%」由这一步保证（宁可漏报候选，绝不虚报命中）；
//! 3. **决定陈述**：编号查询追加 `statements.code` 精确匹配通道（coverage=decision，
//!    携带行号与 quote）。
//!
//! 定位与片段：MD/文本/代码给 1-based 行号；SVG 给文本 fragment；PDF 给行→页锚
//! （`anchor_json.pages`）；docx 给 `#para=N`、xlsx 给 `Sheet!A3`（对齐 B03
//! officeAnchor 语义）。每文件命中上限 3（契约沿用前端语义）。
//!
//! 一致性：派生索引非 `ready`（building/absent——首次建索引中或被清空待重建）
//! 时诚实返回空 items + 状态字段，绝不拿半成品索引冒充结果。

use std::collections::HashMap;

use rusqlite::params;

use crate::domain::search_tokens::{normalize_text, plan_query, QueryMode, QueryPlan};
use crate::dto::{SearchHit, SearchLocator, SearchResponse};
use crate::error::GuanlanError;
use crate::index::file_format::FileFormat;
use crate::index::search_index::{META_RULE_VERSION, META_STATE, SEARCH_RULE_VERSION};
use crate::storage::{internal_sql, ReadonlyStore};

/// GET /api/v1/search 请求参数（契约 §2.4）
#[derive(Debug, Clone, Default)]
pub struct SearchQuery {
    pub q: String,
    /// 小写扩展名 token（`md`/`pdf`/`ts`…）或 `class:<族名>`（`class:image`）
    pub format: Option<String>,
    /// 目录前缀（相对路径，含子目录）
    pub dir: Option<String>,
    /// 默认 30，clamp 1..=100
    pub limit: Option<u32>,
}

const DEFAULT_LIMIT: u32 = 30;
const MAX_LIMIT: u32 = 100;
/// 每文件命中上限（契约沿用前端 searchWorkspace 语义）
const HITS_PER_FILE: usize = 3;
/// 片段最大字符数（char 边界安全截断）
const SNIPPET_MAX_CHARS: usize = 240;
/// 单次核验候选上限（评分排序后截断；防极端共现词把核验拖过预算）
const VERIFY_CAP: usize = 200;
/// 决定陈述命中分（固定置顶；编号拍板是最高价值命中）
const DECISION_SCORE: i64 = 100;

/// 倒排交集的每文件累积状态
#[derive(Debug, Clone, Default)]
struct CandidateScore {
    matched_terms: u32,
    title_weight: i64,
    path_weight: i64,
    content_weight: i64,
}

impl CandidateScore {
    fn score(&self) -> i64 {
        self.title_weight + self.path_weight + self.content_weight
    }
}

/// GET /api/v1/search 主入口（只读；`run_query` 有界执行器上跑）
pub fn search(store: &ReadonlyStore, query: &SearchQuery) -> Result<SearchResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let norm = normalize_text(&query.q);
    let mode = match plan_query(&query.q).mode {
        QueryMode::Empty => {
            return Ok(empty_response(
                &ws.index_generation,
                &norm,
                "",
                search_state_of(store)?,
            ));
        }
        QueryMode::Code => "code",
        QueryMode::Single => "single",
        QueryMode::Phrase => "phrase",
    };
    let state = search_state_of(store)?;
    if state != "ready" {
        return Ok(empty_response(&ws.index_generation, &norm, mode, state));
    }

    let plan = plan_query(&query.q);
    let terms = plan.intersection_terms();
    if terms.is_empty() {
        return Ok(empty_response(&ws.index_generation, &norm, mode, state));
    }

    // ---- 通道 1：倒排交集（跨词项 AND；每词项每文件只计一次；字段权重取最大值）----
    let conn = store.conn();
    let mut candidates: HashMap<String, CandidateScore> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT file_id, field, weight FROM search_postings WHERE term = ?1")
            .map_err(internal_sql)?;
        for term in &terms {
            let rows = stmt
                .query_map(params![term], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(internal_sql)?;
            let mut hit_files: std::collections::HashSet<String> = std::collections::HashSet::new();
            for row in rows {
                let (file_id, field, weight) = row.map_err(internal_sql)?;
                let entry = candidates.entry(file_id.clone()).or_default();
                // 同一词项在同一文件命中多字段（标题+正文）只计一次词项数
                if hit_files.insert(file_id.clone()) {
                    entry.matched_terms += 1;
                }
                match field.as_str() {
                    "title" => entry.title_weight = entry.title_weight.max(weight),
                    "path" => entry.path_weight = entry.path_weight.max(weight),
                    _ => entry.content_weight = entry.content_weight.max(weight),
                }
            }
        }
    }
    // AND 语义：必须每个词项都命中。只需 top VERIFY_CAP（核验硬上限）——
    // 高频词候选可达万级，全量排序是无谓成本；部分选择后再小排序。
    let term_total = terms.len() as u32;
    let mut ranked: Vec<(String, CandidateScore)> = candidates
        .into_iter()
        .filter(|(_, s)| s.matched_terms >= term_total)
        .collect();
    let top_n = ranked.len().min(VERIFY_CAP);
    if top_n < ranked.len() {
        ranked.select_nth_unstable_by(top_n, |a, b| {
            b.1.score().cmp(&a.1.score()).then_with(|| a.0.cmp(&b.0))
        });
        ranked.truncate(top_n);
    }
    ranked.sort_by(|a, b| b.1.score().cmp(&a.1.score()).then_with(|| a.0.cmp(&b.0)));

    // ---- 筛选参数 ---
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    // dir 口径对齐契约 §1.3（`docs` 含子树；`'.'` 仅根散文件）；大小写无关
    let dir_norm = query
        .dir
        .as_deref()
        .map(|d| d.replace('\\', "/"))
        .map(|d| d.trim_end_matches('/').to_lowercase())
        .filter(|d| !d.is_empty());
    let format_filter = query.format.as_deref().map(str::to_owned);

    // ---- 通道 2：回源核验（评分序取候选；硬上限 VERIFY_CAP——有界检索口径，
    // total_matched 以核验到的命中文件数封顶并诚实置 truncated）----
    let mut items: Vec<SearchHit> = Vec::new();
    let mut verified = 0usize;
    for (file_id, score) in &ranked {
        if verified >= VERIFY_CAP {
            break;
        }
        let Some(doc) = load_doc(conn, file_id)? else {
            continue;
        };
        // 状态双保险（索引行可能滞后一轮差分）
        if doc.status != "active" {
            continue;
        }
        // format 筛选：精确 token 或 class: 族名（对齐 §1.3 class_of_token 口径）
        if let Some(want) = &format_filter {
            if let Some(class_name) = want.strip_prefix("class:") {
                let matches = FileFormat::parse(&doc.format)
                    .map(|f| {
                        crate::index::file_format::class_of_token(f.as_str()).as_str() == class_name
                    })
                    .unwrap_or(false);
                if !matches {
                    continue;
                }
            } else if &doc.format != want {
                continue;
            }
        }
        // dir 前缀筛选（目录前缀含子目录；'.' 仅工作区根散文件）
        if let Some(dir) = &dir_norm {
            let lower_rel = doc.rel_path.to_lowercase();
            let in_dir = if dir == "." {
                !lower_rel.contains('/')
            } else {
                lower_rel.starts_with(&format!("{dir}/"))
            };
            if !in_dir {
                continue;
            }
        }
        verified += 1;
        let hits = verify_doc(&plan, &doc, score);
        if hits.is_empty() {
            continue;
        }
        if items.len() < limit {
            items.extend(hits);
        }
    }

    // ---- 通道 3：决定陈述精确编号（仅 Code 模式）----
    if plan.mode == QueryMode::Code {
        let code = plan.norm.clone();
        let decision_hits = decision_code_hits(conn, &ws.workspace_id, &code, limit)?;
        items.extend(decision_hits);
    }

    // 排序：分数降序 → file_id 稳定 → 行号稳定；随后按契约每文件上限 3 收口
    items.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.file_id.cmp(&b.file_id))
            .then_with(|| locator_order(a).cmp(&locator_order(b)))
    });
    let mut per_file: HashMap<String, usize> = HashMap::new();
    items.retain(|hit| {
        let count = per_file.entry(hit.file_id.clone()).or_default();
        if *count < HITS_PER_FILE {
            *count += 1;
            true
        } else {
            false
        }
    });
    // 收口后命中文件数 = 各文件首条命中保留后的去重数
    let total_matched = per_file.len();
    items.truncate(limit);

    Ok(SearchResponse {
        ok: true,
        index_generation: ws.index_generation,
        query: norm,
        mode: mode.to_owned(),
        total_matched,
        truncated: total_matched > items.len(),
        items,
        search_state: state,
    })
}

fn empty_response(generation: &u64, query: &str, mode: &str, state: String) -> SearchResponse {
    SearchResponse {
        ok: true,
        index_generation: *generation,
        query: query.to_owned(),
        mode: mode.to_owned(),
        total_matched: 0,
        items: Vec::new(),
        truncated: false,
        search_state: state,
    }
}

/// 派生检索索引状态（C05 挂载摘要复用：`ready` = state 标记 ready 且规则版本现行）。
/// 状态/版本缺失按 `absent`——绝不把半成品索引冒充可用。
pub fn search_state_of(store: &ReadonlyStore) -> Result<String, GuanlanError> {
    let state = store.read_meta(META_STATE)?;
    let version = store.read_meta(META_RULE_VERSION)?;
    let ready =
        state.as_deref() == Some("ready") && version.as_deref() == Some(SEARCH_RULE_VERSION);
    Ok(if ready {
        "ready".to_owned()
    } else {
        state.unwrap_or_else(|| "absent".to_owned())
    })
}

/// search_docs 行（查询侧最小投影）
struct DocRow {
    file_id: String,
    revision_id: String,
    format: String,
    title: String,
    rel_path: String,
    status: String,
    has_body: bool,
    body_text: String,
    anchor_json: String,
}

fn load_doc(conn: &rusqlite::Connection, file_id: &str) -> Result<Option<DocRow>, GuanlanError> {
    let row = conn
        .query_row(
            "SELECT file_id, revision_id, format, title, rel_path, status, has_body, body_text, anchor_json
             FROM search_docs WHERE file_id = ?1",
            params![file_id],
            |r| {
                Ok(DocRow {
                    file_id: r.get(0)?,
                    revision_id: r.get(1)?,
                    format: r.get(2)?,
                    title: r.get(3)?,
                    rel_path: r.get(4)?,
                    status: r.get(5)?,
                    has_body: r.get::<_, i64>(6)? != 0,
                    body_text: r.get(7)?,
                    anchor_json: r.get(8)?,
                })
            },
        )
        .ok();
    Ok(row)
}

/// 单文档回源核验：按查询模式给出 ≤3 条命中（正文核验 + 标题/路径回退）。
/// 回退口径：路径/标题**连续子串**命中，或 title/path 字段拿到**非单字词项**
/// 权重（整段词 / 首字母缩写 / Bigram——文件名缩写检索 `uas` →
/// `user-auth-service` 不构成子串，必须走词项级命中）。
///
/// 性能口径：正文核验对整个 body 只做**一次** `to_lowercase`，再用子串查找
/// + 行偏移二分定位行号（高频词候选可达核验上限，逐行 lowercase 会放大分配成本）。
fn verify_doc(plan: &QueryPlan, doc: &DocRow, score: &CandidateScore) -> Vec<SearchHit> {
    let lower_path = doc.rel_path.to_lowercase();
    let lower_title = doc.title.to_lowercase();
    let substring_matched = lower_path.contains(&plan.norm) || lower_title.contains(&plan.norm);
    let field_matched = score.title_weight >= 45 || score.path_weight >= 45;
    let filename_matched = substring_matched || field_matched;
    let base_score = score.score();

    let (coverage_body, coverage_name) = coverage_for(&doc.format, doc.has_body);
    let mut hits: Vec<SearchHit> = Vec::new();

    if doc.has_body {
        let lower = doc.body_text.to_lowercase();
        // 行偏移表（字节偏移 → 0-based 行号下标）
        let mut line_starts: Vec<usize> = vec![0];
        for (i, b) in lower.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }
        // 命中行集合（同一行多次出现只计一次；每文件上限 3）
        let mut found_lines: Vec<usize> = Vec::new();
        let mut from = 0usize;
        while let Some(pos) = lower[from..].find(&plan.norm) {
            let abs = from + pos;
            let line_idx = match line_starts.binary_search(&abs) {
                Ok(i) => i,
                Err(i) => i - 1, // abs 落于 line_starts[i-1]..line_starts[i] 之间
            };
            if found_lines.last() != Some(&line_idx) {
                found_lines.push(line_idx);
                if found_lines.len() >= HITS_PER_FILE {
                    break;
                }
            }
            from = abs + plan.norm.len();
        }
        if !found_lines.is_empty() {
            let lines: Vec<&str> = doc.body_text.split('\n').collect();
            for idx in found_lines {
                let line = lines.get(idx).copied().unwrap_or("").trim();
                let locator = locator_for(&doc.format, &doc.anchor_json, idx, line);
                hits.push(SearchHit {
                    // C05 修复：正文命中携带真实 file_id（C02 曾留空——跨库合并与
                    // 前端「Enter 打开」都按 file_id 去重/路由，空值会让全部正文
                    // 命中挤进同一键；契约 §2.4 SearchHit.file_id 本就要求真实值）
                    file_id: doc.file_id.clone(),
                    revision_id: doc.revision_id.clone(),
                    relative_path: doc.rel_path.clone(),
                    title: doc.title.clone(),
                    format: doc.format.clone(),
                    coverage: coverage_body.clone(),
                    match_strategy: strategy_for(plan),
                    locator,
                    snippet: bounded_snippet(line),
                    score: base_score + 5, // 正文短语核验通过加成
                    stale: false,
                    source_workspace: None,
                });
            }
        }
    }

    // 正文未中（或无正文）但标题/路径命中 → filename_match（对齐前端回退语义）
    if hits.is_empty() && filename_matched {
        hits.push(SearchHit {
            file_id: doc.file_id.clone(),
            revision_id: doc.revision_id.clone(),
            relative_path: doc.rel_path.clone(),
            title: doc.title.clone(),
            format: doc.format.clone(),
            coverage: coverage_name.clone(),
            match_strategy: "filename_match".to_owned(),
            locator: SearchLocator::File,
            snippet: format!("文件名命中：{}", doc.rel_path),
            score: base_score,
            stale: false,
            source_workspace: None,
        });
    }
    hits
}

/// 决定陈述通道：编号精确匹配 statements.code（workspace 扫描 + 小写比较；
/// statements 规模 = 决定块量级，扫描代价可忽略）
fn decision_code_hits(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    code: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, GuanlanError> {
    let mut stmt = conn
        .prepare(
            "SELECT s.statement_id, s.file_id, s.revision_id, s.code, s.quote,
                    s.line_start, s.line_end, f.title, f.current_path, f.format
             FROM statements s
             JOIN files f ON f.file_id = s.file_id
             WHERE s.workspace_id = ?1 AND f.status = 'active'
             ORDER BY s.line_start ASC",
        )
        .map_err(internal_sql)?;
    let rows = stmt
        .query_map(params![workspace_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
            ))
        })
        .map_err(internal_sql)?;
    let mut hits = Vec::new();
    for row in rows {
        let (
            _sid,
            file_id,
            revision_id,
            code_col,
            quote,
            line_start,
            line_end,
            title,
            path,
            format,
        ) = row.map_err(internal_sql)?;
        if code_col.to_lowercase() != code {
            continue;
        }
        hits.push(SearchHit {
            file_id,
            revision_id,
            relative_path: crate::domain::normalize_rel_path(&path),
            title,
            format,
            coverage: "decision".to_owned(),
            match_strategy: "exact_code".to_owned(),
            locator: SearchLocator::Lines {
                start: line_start,
                end: line_end,
            },
            snippet: bounded_snippet(quote.trim()),
            score: DECISION_SCORE,
            stale: false,
            source_workspace: None,
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

fn strategy_for(plan: &QueryPlan) -> String {
    match plan.mode {
        QueryMode::Code => "exact_code".to_owned(),
        QueryMode::Single => "single_char_bounded".to_owned(),
        _ => "bigram_phrase_verified".to_owned(),
    }
}

/// coverage 双值：(正文命中时, 文件名命中时)
fn coverage_for(format: &str, has_body: bool) -> (String, String) {
    let fmt = FileFormat::parse(format);
    let body = if !has_body {
        "filename_only".to_owned()
    } else if format == "svg" {
        "svg_text".to_owned()
    } else if format == "pdf" {
        "pdf_page_text".to_owned()
    } else if fmt
        .as_ref()
        .map(|f| f.is_office_structured())
        .unwrap_or(false)
    {
        "office_structured".to_owned()
    } else {
        "full_text".to_owned()
    };
    let name = if has_body && format == "svg" {
        "svg_text".to_owned()
    } else if has_body && format == "pdf" {
        "pdf_page_text".to_owned()
    } else if fmt
        .as_ref()
        .map(|f| f.is_office_structured())
        .unwrap_or(false)
    {
        "office_structured".to_owned()
    } else {
        "filename_only".to_owned()
    };
    (body, name)
}

/// 行级定位器：按格式解释 anchor_json
fn locator_for(format: &str, anchor_json: &str, line_idx: usize, line: &str) -> SearchLocator {
    match format {
        "svg" => SearchLocator::SvgText {
            fragment: line.to_owned(),
        },
        "pdf" => SearchLocator::PdfPage {
            page: anchor_page(anchor_json, line_idx).unwrap_or(1),
        },
        f if f.starts_with("xl") => SearchLocator::Office {
            anchor: anchor_xlsx(anchor_json, line_idx).unwrap_or_else(|| "未知工作表".to_owned()),
        },
        f if is_docx_family(f) => SearchLocator::Office {
            anchor: format!("#para={}", anchor_para(anchor_json, line_idx)),
        },
        _ => {
            let no = (line_idx + 1) as i64;
            SearchLocator::Lines { start: no, end: no }
        }
    }
}

fn is_docx_family(format: &str) -> bool {
    FileFormat::parse(format)
        .map(|f| f.is_office_structured())
        .unwrap_or(false)
        && !format.starts_with("xl")
}

fn parse_anchor(anchor_json: &str) -> Option<serde_json::Value> {
    if anchor_json.is_empty() {
        return None;
    }
    serde_json::from_str(anchor_json).ok()
}

fn anchor_page(anchor_json: &str, line_idx: usize) -> Option<u64> {
    let v = parse_anchor(anchor_json)?;
    v.get("pages")?.get(line_idx)?.as_u64()
}

fn anchor_para(anchor_json: &str, line_idx: usize) -> u64 {
    parse_anchor(anchor_json)
        .and_then(|v| v.get("paras")?.get(line_idx)?.as_u64())
        .unwrap_or((line_idx + 1) as u64)
}

fn anchor_xlsx(anchor_json: &str, line_idx: usize) -> Option<String> {
    let v = parse_anchor(anchor_json)?;
    let cell = v.get("cells")?.get(line_idx)?;
    let name = cell.get("n")?.as_str()?;
    let reference = cell.get("r")?.as_str()?;
    Some(format!("{name}!{reference}"))
}

/// 排序次键：行号越小越靠前；File 定位器排最后
fn locator_order(hit: &SearchHit) -> i64 {
    match &hit.locator {
        SearchLocator::Lines { start, .. } => *start,
        SearchLocator::PdfPage { page } => *page as i64,
        SearchLocator::SvgText { .. } | SearchLocator::Office { .. } => 0,
        SearchLocator::File => i64::MAX,
    }
}

/// char 边界安全截断（≤ SNIPPET_MAX_CHARS）
fn bounded_snippet(s: &str) -> String {
    if s.chars().count() <= SNIPPET_MAX_CHARS {
        return s.to_owned();
    }
    s.chars().take(SNIPPET_MAX_CHARS).collect()
}
