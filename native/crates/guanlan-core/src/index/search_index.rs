//! Rust 服务端全文 + 路径 + 符号混合倒排索引（参见 contract-query-api.md §2.4、
//! contract-storage.md §12）。
//!
//! 定位：**可随时丢弃重建的派生检索索引**。两表全部可由 `files` + `revisions` +
//! blobs 快照 + `pdf_extracts` / `office_extracts` 完整重算，任意损坏后经
//! `rebuild_all`（`POST /api/v1/search/rebuild`）或下一轮对账尾部自动重建恢复。
//!
//! 口径：
//! - **只索引每个文件的最新版本**（`revisions.seq` 最大者）：检索语义是「找到
//!   当前文件」，历史版本可经版本链端点追溯，不进倒排（规模有界：行数 ∝ 文件数）。
//! - `status != 'active'`（trashed/missing）不建索引行（差分时移除）。
//! - 词项三字段：`title`（权重最高）/ `path`（分段+缩写）/ `content`（Bigram+词元+编号）。
//! - 文本源：UTF-8 文本族走 blobs 快照（SVG 抽 `<text>` 文本行）；PDF 走
//!   `pdf_extracts`（页级文本，行→页锚）；docx/xlsx 走 `office_extracts`
//!   （段落/单元格锚）；第三档 metadata_only 或无文本层 → `has_body=0`，
//!   仅标题/路径可检索（诚实口径，不谎报正文命中）。
//! - 同步时机：`reconcile_collected` 尾部（状态机重算后、代际判定前）轻量差分
//!   ——只重算「版本/路径/状态有变化」的文件；规则版本不符或标记缺失 → 全量重建。
//! - 派生索引变化**不推进 index_generation**（代际只属事实层；检索结果一致性
//!   由「派生自同一事务后的库态」保证）。

use std::collections::{BTreeSet, HashMap};

use rusqlite::params;

use crate::domain::normalize_rel_path;
use crate::domain::search_tokens::{normalize_text, path_field_tokens, tokenize_mixed};
use crate::error::GuanlanError;
use crate::index::file_format::FileFormat;
use crate::index::office::OfficeExtractRecord;
use crate::index::pdf::PdfExtractRecord;
use crate::index::writer::Writer;
use crate::storage::internal_sql;

/// 检索索引规则版本（分词/权重/正文编码规则变化时递增并触发全量重建）
pub const SEARCH_RULE_VERSION: &str = "s1";

/// meta 键：规则版本 / 构建状态（ready | building）/ 已索引文档数
pub const META_RULE_VERSION: &str = "search_rule_version";
pub const META_STATE: &str = "search_state";
pub const META_DOC_COUNT: &str = "search_docs_count";

/// 单文档正文行数保险丝（超限截断，`truncated=1` 诚实标记）
pub const MAX_BODY_LINES: usize = 20_000;
/// 单文档正文字节数保险丝（截断在行边界）
pub const MAX_BODY_BYTES: usize = 512 * 1024;
/// 单文档 content 词项上限（去重后；title/path 词项不受此限——规模小且权重高）
pub const MAX_CONTENT_TOKENS: usize = 4096;
const REBUILD_CHUNK: usize = 500;

/// 词项字段（postings.field；公开给查询侧做字段语义分支）
pub const FIELD_TITLE: &str = "title";
pub const FIELD_PATH: &str = "path";
pub const FIELD_CONTENT: &str = "content";

/// 权重表（postings.weight；查询侧按字段取每文档最大值求和排序）
pub const WEIGHT_TITLE: i64 = 60;
pub const WEIGHT_PATH: i64 = 45;
pub const WEIGHT_CONTENT: i64 = 10;
/// content 里的专有编号整词（ac-03 / #39）略高于普通词元
pub const WEIGHT_CONTENT_CODE: i64 = 15;
/// 单字（CJK 有界回退用，排名靠后）
pub const WEIGHT_SINGLE: i64 = 5;

/// 检索文档行（`search_docs`；派生，可重建）
#[derive(Debug, Clone)]
pub struct SearchDocRow {
    pub file_id: String,
    pub workspace_id: String,
    pub revision_id: String,
    pub content_hash: String,
    pub format: String,
    pub title: String,
    pub rel_path: String,
    pub status: String,
    pub has_body: bool,
    pub body_text: String,
    pub anchor_json: String,
    pub line_count: usize,
    pub truncated: bool,
    pub indexed_at: String,
}

/// 倒排词项行（`search_postings`；派生，可重建）
#[derive(Debug, Clone)]
pub struct SearchPostingRow {
    pub term: String,
    pub field: &'static str,
    pub weight: i64,
}

/// 对账尾部差分候选（files 侧权威字段 vs search_docs 侧现存字段）
#[derive(Debug, Clone)]
pub struct SearchSyncCandidate {
    pub file_id: String,
}

/// 同步结果
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchSyncOutcome {
    pub docs_synced: usize,
    pub docs_removed: usize,
    pub rebuilt: bool,
}

pub const SEARCH_DDL: &str = "
CREATE TABLE IF NOT EXISTS search_docs (
  file_id       TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  revision_id   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  format        TEXT NOT NULL,
  title         TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  status        TEXT NOT NULL,
  has_body      INTEGER NOT NULL DEFAULT 0,
  body_text     TEXT NOT NULL DEFAULT '',
  anchor_json   TEXT NOT NULL DEFAULT '',
  line_count    INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  indexed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sdocs_ws ON search_docs(workspace_id);
CREATE TABLE IF NOT EXISTS search_postings (
  term     TEXT NOT NULL,
  field    TEXT NOT NULL,
  file_id  TEXT NOT NULL,
  weight   INTEGER NOT NULL,
  PRIMARY KEY (term, field, file_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_spost_file ON search_postings(file_id);
";

/// 一份待索引文档的正文材料（行 + 行级锚点 JSON）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocBody {
    /// 按 '\n' 连接的原文行（保持原文大小写——片段高亮需要原文）
    pub body_text: String,
    /// 行级锚点 JSON（"" | pdf.pages[] | docx.paras[] | xlsx.cells[]）
    pub anchor_json: String,
    pub truncated: bool,
}

/// SVG 可提取文本行（对齐前端 extractSvgText 语义：`<text>…</text>` 内容、
/// 去内嵌标签（tspan 等）、基本实体回替、trim；跳过空行）
pub fn svg_text_lines(source: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let lower = source.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0usize;
    while let Some(pos) = find_sub(&bytes[from..], b"<text") {
        let tag_start = from + pos;
        match bytes.get(tag_start + 5) {
            Some(&c) if c == b'>' || c.is_ascii_whitespace() => {}
            _ => {
                from = tag_start + 5;
                continue;
            }
        }
        let Some(gt_rel) = lower[tag_start..].find('>') else {
            break;
        };
        let content_start = tag_start + gt_rel + 1;
        let Some(end_rel) = lower[content_start..].find("</text") else {
            break;
        };
        let content_end = content_start + end_rel;
        let inner = &source[content_start..content_end];
        let text = decode_entities(&strip_inner_tags(inner));
        let text = text.trim();
        if !text.is_empty() {
            lines.push(text.to_owned());
        }
        from = content_end;
    }
    lines
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn strip_inner_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// UTF-8 文本快照 → 正文行（含截断保险丝）
pub fn body_from_text(snapshot: &str) -> DocBody {
    let mut lines: Vec<&str> = snapshot
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut truncated = false;
    if lines.len() > MAX_BODY_LINES {
        lines.truncate(MAX_BODY_LINES);
        truncated = true;
    }
    let mut total = 0usize;
    let mut keep = lines.len();
    for (i, line) in lines.iter().enumerate() {
        total += line.len() + 1;
        if total > MAX_BODY_BYTES {
            keep = i.max(1);
            truncated = true;
            break;
        }
    }
    lines.truncate(keep);
    while lines.last() == Some(&"") {
        lines.pop();
    }
    DocBody {
        body_text: lines.join("\n"),
        anchor_json: String::new(),
        truncated,
    }
}

/// PDF 页级抽取记录 → 正文行 + 行→页锚
pub fn body_from_pdf(record: &PdfExtractRecord) -> DocBody {
    let mut lines: Vec<String> = Vec::new();
    let mut pages: Vec<u64> = Vec::new();
    let mut truncated = false;
    'outer: for page in &record.pages {
        if page.page_kind == "image_only" || page.page_kind == "extract_failed" {
            continue;
        }
        for line in page.extracted_text.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            lines.push(line.to_owned());
            pages.push(page.page_number);
            if lines.len() >= MAX_BODY_LINES || lines.len() * 32 > MAX_BODY_BYTES {
                truncated = true;
                break 'outer;
            }
        }
    }
    DocBody {
        body_text: lines.join("\n"),
        anchor_json: serde_json::json!({ "v": 1, "kind": "pdf", "pages": pages }).to_string(),
        truncated,
    }
}

/// docx 段落 → 正文行 + 段锚（`#para=N`，与 Office 结构化抽取锚点语义一致）
pub fn body_from_docx(record: &OfficeExtractRecord) -> DocBody {
    let mut lines: Vec<String> = Vec::new();
    let mut paras: Vec<u64> = Vec::new();
    let mut truncated = record.docx.as_ref().map(|d| d.truncated).unwrap_or(false);
    if let Some(docx) = &record.docx {
        for para in &docx.paragraphs {
            let text = para.text.trim();
            if text.is_empty() {
                continue;
            }
            lines.push(text.to_owned());
            paras.push(para.para_index);
            if lines.len() >= MAX_BODY_LINES {
                truncated = true;
                break;
            }
        }
    }
    DocBody {
        body_text: lines.join("\n"),
        anchor_json: serde_json::json!({ "v": 1, "kind": "docx", "paras": paras }).to_string(),
        truncated,
    }
}

/// xlsx 单元格 → 正文行（每格一行）+ 单元格锚（`Sheet!A3`，与 Office 结构化抽取锚点语义一致）
pub fn body_from_xlsx(record: &OfficeExtractRecord) -> DocBody {
    #[derive(serde::Serialize)]
    struct CellAnchor<'a> {
        s: u32,
        n: &'a str,
        r: &'a str,
    }
    let mut lines: Vec<String> = Vec::new();
    let mut cells: Vec<CellAnchor<'_>> = Vec::new();
    let mut truncated = record.xlsx.as_ref().map(|d| d.truncated).unwrap_or(false);
    if let Some(xlsx) = &record.xlsx {
        'outer: for sheet in &xlsx.sheets {
            for row in &sheet.rows {
                for cell in &row.cells {
                    let value = cell.value.trim();
                    if value.is_empty() {
                        continue;
                    }
                    lines.push(value.to_owned());
                    cells.push(CellAnchor {
                        s: sheet.index,
                        n: sheet.name.as_str(),
                        r: cell.ref_id.as_str(),
                    });
                    if lines.len() >= MAX_BODY_LINES {
                        truncated = true;
                        break 'outer;
                    }
                }
            }
        }
    }
    DocBody {
        body_text: lines.join("\n"),
        anchor_json: serde_json::json!({ "v": 1, "kind": "xlsx", "cells": cells }).to_string(),
        truncated,
    }
}

/// 由标题 + 相对路径 + 正文行构建全部词项（title/path 恒收，content 受上限约束）
pub fn build_postings(
    norm_title: &str,
    norm_path: &str,
    body_lines: &[&str],
    has_body: bool,
) -> Vec<SearchPostingRow> {
    let mut out: Vec<SearchPostingRow> = Vec::new();
    let mut seen: BTreeSet<(String, &'static str)> = BTreeSet::new();
    let mut push = |term: String, field: &'static str, weight: i64| {
        if term.is_empty() || term.len() > 64 {
            return;
        }
        if seen.insert((term.clone(), field)) {
            out.push(SearchPostingRow {
                term,
                field,
                weight,
            });
        }
    };

    for term in path_field_tokens(norm_title) {
        let weight = if term.chars().count() == 1 {
            WEIGHT_SINGLE
        } else {
            WEIGHT_TITLE
        };
        push(term, FIELD_TITLE, weight);
    }
    for term in path_field_tokens(norm_path) {
        let weight = if term.chars().count() == 1 {
            WEIGHT_SINGLE
        } else {
            WEIGHT_PATH
        };
        push(term, FIELD_PATH, weight);
    }

    if !has_body {
        return out;
    }

    let joined_lines = body_lines.join("\n");
    let norm_body = normalize_text(&joined_lines);
    let (bigrams, mut words) = tokenize_mixed(&norm_body);
    let mut content: Vec<SearchPostingRow> = Vec::new();
    let mut content_seen: BTreeSet<String> = BTreeSet::new();
    let take = |term: String,
                weight: i64,
                content: &mut Vec<SearchPostingRow>,
                content_seen: &mut BTreeSet<String>| {
        if content.len() >= MAX_CONTENT_TOKENS {
            return;
        }
        if term.is_empty() || term.len() > 64 {
            return;
        }
        if content_seen.insert(term.clone()) {
            content.push(SearchPostingRow {
                term,
                field: FIELD_CONTENT,
                weight,
            });
        }
    };
    for bigram in bigrams {
        take(bigram, WEIGHT_CONTENT, &mut content, &mut content_seen);
    }
    words.sort_by_key(|w| {
        (
            std::cmp::Reverse(is_code_word(w)),
            std::cmp::Reverse(w.len()),
        )
    });
    for word in words {
        let weight = if is_code_word(&word) {
            WEIGHT_CONTENT_CODE
        } else {
            WEIGHT_CONTENT
        };
        take(word, weight, &mut content, &mut content_seen);
    }
    for c in norm_body.chars() {
        if content.len() >= MAX_CONTENT_TOKENS {
            break;
        }
        if crate::domain::search_tokens::is_cjk(c) {
            let s = c.to_string();
            if content_seen.insert(s.clone()) {
                content.push(SearchPostingRow {
                    term: s,
                    field: FIELD_CONTENT,
                    weight: WEIGHT_SINGLE,
                });
            }
        }
    }
    out.extend(content);
    out
}

fn is_code_word(word: &str) -> bool {
    crate::domain::search_tokens::classify_code(word)
}

/// 文档标识载荷（build_search_doc 的键材料；sync/rebuild 共用）
#[derive(Debug, Clone)]
pub struct SearchDocInput<'a> {
    pub file_id: &'a str,
    pub workspace_id: &'a str,
    pub revision_id: &'a str,
    pub content_hash: &'a str,
    pub format: &'a str,
    pub title: &'a str,
    pub rel_path: &'a str,
    pub status: &'a str,
    pub indexed_at: &'a str,
}

/// 文档行 + 词项一次构建（sync/rebuild 共用）
/// `body`：正文材料（None → 仅标题/路径可检索）。
pub fn build_search_doc(
    input: &SearchDocInput<'_>,
    body: Option<DocBody>,
) -> (SearchDocRow, Vec<SearchPostingRow>) {
    let norm_title = normalize_text(input.title);
    let norm_rel = normalize_text(&normalize_rel_path(input.rel_path));
    let has_body = body.is_some();
    let (body_text, anchor_json, truncated) = match body {
        Some(b) => (b.body_text, b.anchor_json, b.truncated),
        None => (String::new(), String::new(), false),
    };
    let lines: Vec<&str> = if has_body {
        body_text.split('\n').collect()
    } else {
        Vec::new()
    };
    let postings = build_postings(&norm_title, &norm_rel, &lines, has_body);
    let line_count = lines.len();
    let row = SearchDocRow {
        file_id: input.file_id.to_owned(),
        workspace_id: input.workspace_id.to_owned(),
        revision_id: input.revision_id.to_owned(),
        content_hash: input.content_hash.to_owned(),
        format: input.format.to_owned(),
        title: input.title.to_owned(),
        rel_path: normalize_rel_path(input.rel_path),
        status: input.status.to_owned(),
        has_body,
        line_count,
        body_text,
        anchor_json,
        truncated,
        indexed_at: input.indexed_at.to_owned(),
    };
    (row, postings)
}

/// 对账尾部入口：差分同步（规则不符自动全量重建）
pub fn sync_after_reconcile(
    writer: &mut Writer,
    workspace_id: &str,
) -> Result<SearchSyncOutcome, GuanlanError> {
    let rule_ok = writer.get_meta(META_RULE_VERSION)?.as_deref() == Some(SEARCH_RULE_VERSION);
    let state_ok = writer.get_meta(META_STATE)?.as_deref() == Some("ready");
    if !rule_ok || !state_ok {
        return rebuild_all(writer, workspace_id);
    }
    let candidates = writer.search_sync_candidates(workspace_id)?;
    let stale = writer.search_stale_file_ids(workspace_id)?;
    if candidates.is_empty() && stale.is_empty() {
        return Ok(SearchSyncOutcome::default());
    }
    sync_files(writer, workspace_id, &candidates)?;
    remove_stale_docs(writer, &stale)?;
    refresh_doc_count(writer, workspace_id)?;
    Ok(SearchSyncOutcome {
        docs_synced: candidates.len(),
        docs_removed: stale.len(),
        rebuilt: false,
    })
}

/// 一键重建：清空两表后全量重算（`POST /api/v1/search/rebuild`；损坏自愈路径）
pub fn rebuild_all(
    writer: &mut Writer,
    workspace_id: &str,
) -> Result<SearchSyncOutcome, GuanlanError> {
    writer.transaction(|writer| {
        writer
            .conn()
            .execute("DELETE FROM search_postings", [])
            .map_err(internal_sql)?;
        writer
            .conn()
            .execute("DELETE FROM search_docs", [])
            .map_err(internal_sql)?;
        writer.set_meta(META_STATE, "building")?;
        Ok(())
    })?;

    let files = writer.list_files(workspace_id, true)?;
    let latest: HashMap<String, String> = writer.latest_revision_ids()?.into_iter().collect();

    let mut synced = 0usize;
    for chunk in files.chunks(REBUILD_CHUNK) {
        let mut built: Vec<(SearchDocRow, Vec<SearchPostingRow>)> = Vec::with_capacity(chunk.len());
        let mut removes: Vec<String> = Vec::new();
        for row in chunk {
            let Some(revision_id) = latest.get(&row.file_id) else {
                continue;
            };
            match build_doc_for_file(writer, workspace_id, row, revision_id)? {
                IndexOne::Remove => removes.push(row.file_id.clone()),
                IndexOne::Skip => {}
                IndexOne::Built(boxed) => built.push(*boxed),
            }
        }
        writer.transaction(|writer| {
            for file_id in &removes {
                writer.delete_search_doc(file_id)?;
            }
            let mut bulk: Vec<(String, String, String, i64)> = Vec::new();
            for (doc, postings) in &built {
                writer.upsert_search_doc(doc)?;
                writer.delete_search_postings(&doc.file_id)?;
                for posting in postings {
                    bulk.push((
                        posting.term.clone(),
                        posting.field.to_owned(),
                        doc.file_id.clone(),
                        posting.weight,
                    ));
                }
            }
            bulk.sort();
            writer.bulk_insert_search_postings(&bulk)?;
            synced += built.len();
            Ok(())
        })?;
    }

    writer.transaction(|writer| {
        writer.set_meta(META_RULE_VERSION, SEARCH_RULE_VERSION)?;
        writer.set_meta(META_STATE, "ready")?;
        refresh_doc_count(writer, workspace_id)?;
        Ok(())
    })?;
    Ok(SearchSyncOutcome {
        docs_synced: synced,
        docs_removed: 0,
        rebuilt: true,
    })
}

fn sync_files(
    writer: &mut Writer,
    workspace_id: &str,
    candidates: &[SearchSyncCandidate],
) -> Result<(), GuanlanError> {
    let latest: HashMap<String, String> = writer.latest_revision_ids()?.into_iter().collect();
    let mut by_id: HashMap<String, crate::storage::FileRow> = HashMap::new();
    for row in writer.list_files(workspace_id, true)? {
        by_id.insert(row.file_id.clone(), row);
    }
    for chunk in candidates.chunks(REBUILD_CHUNK) {
        writer.transaction(|writer| {
            for candidate in chunk {
                let Some(row) = by_id.get(&candidate.file_id) else {
                    writer.delete_search_doc(&candidate.file_id)?;
                    continue;
                };
                let Some(revision_id) = latest.get(&row.file_id) else {
                    continue;
                };
                match build_doc_for_file(writer, workspace_id, row, revision_id)? {
                    IndexOne::Remove => writer.delete_search_doc(&row.file_id)?,
                    IndexOne::Skip => {}
                    IndexOne::Built(boxed) => {
                        let (doc, postings) = *boxed;
                        writer.replace_search_doc(&doc, &postings)?
                    }
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

enum IndexOne {
    Remove,
    Skip,
    Built(Box<(SearchDocRow, Vec<SearchPostingRow>)>),
}

fn build_doc_for_file(
    writer: &Writer,
    workspace_id: &str,
    row: &crate::storage::FileRow,
    revision_id: &str,
) -> Result<IndexOne, GuanlanError> {
    if row.status != "active" {
        return Ok(IndexOne::Remove);
    }
    let Some(rev) = writer.get_revision(revision_id)? else {
        return Ok(IndexOne::Skip);
    };
    let fmt = FileFormat::parse(&row.format);
    let format = row.format.clone();
    let rel_path = normalize_rel_path(&row.current_path);
    let title = row.title.clone();

    let body: Option<DocBody> = if rev.snapshot_available == 0 {
        None
    } else if format == "svg" {
        writer
            .read_snapshot(&rev.content_hash)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|src| {
                let lines = svg_text_lines(&src);
                if lines.is_empty() {
                    None
                } else {
                    Some(DocBody {
                        body_text: lines.join("\n"),
                        anchor_json: String::new(),
                        truncated: false,
                    })
                }
            })
    } else if fmt.as_ref().map(|f| f.is_utf8_text()).unwrap_or(false) {
        writer
            .read_snapshot(&rev.content_hash)
            .map(|bytes| body_from_text(&String::from_utf8_lossy(&bytes)))
    } else if fmt
        .as_ref()
        .map(|f| f.is_office_structured())
        .unwrap_or(false)
    {
        match writer.get_office_extract_json(
            &rev.content_hash,
            crate::index::writer::EXTRACT_RULE_VERSION,
        )? {
            Some(cached) => match serde_json::from_str::<OfficeExtractRecord>(&cached.extract_json)
            {
                Ok(record) if record.status == "indexed" => {
                    if format.starts_with("xl") {
                        Some(body_from_xlsx(&record))
                    } else {
                        Some(body_from_docx(&record))
                    }
                }
                _ => None,
            },
            None => None,
        }
    } else if format == "pdf" {
        match writer.get_pdf_extract_json(
            &rev.content_hash,
            crate::index::writer::EXTRACT_RULE_VERSION,
        )? {
            Some(cached) => match serde_json::from_str::<PdfExtractRecord>(&cached.extract_json) {
                Ok(record) if record.status == "page_indexed" => Some(body_from_pdf(&record)),
                _ => None,
            },
            None => None,
        }
    } else {
        None
    };

    let indexed_at = rev.observed_at.clone();
    let (doc_row, postings) = build_search_doc(
        &SearchDocInput {
            file_id: &row.file_id,
            workspace_id,
            revision_id: &rev.revision_id,
            content_hash: &rev.content_hash,
            format: &format,
            title: &title,
            rel_path: &rel_path,
            status: &row.status,
            indexed_at: &indexed_at,
        },
        body,
    );
    Ok(IndexOne::Built(Box::new((doc_row, postings))))
}

fn remove_stale_docs(writer: &mut Writer, stale: &[String]) -> Result<(), GuanlanError> {
    if stale.is_empty() {
        return Ok(());
    }
    writer.transaction(|writer| {
        for file_id in stale {
            writer.delete_search_doc(file_id)?;
        }
        Ok(())
    })
}

fn refresh_doc_count(writer: &mut Writer, workspace_id: &str) -> Result<(), GuanlanError> {
    let n: i64 = writer
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM search_docs WHERE workspace_id = ?",
            params![workspace_id],
            |row| row.get(0),
        )
        .map_err(internal_sql)?;
    writer.set_meta(META_DOC_COUNT, &n.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::pdf::PdfPageExtract;

    #[test]
    fn svg_text_lines_extract_text_and_tspan_content() {
        let src = r#"<svg xmlns="http://www.w3.org/2000/svg">
  <text x="1" y="2">历史<tspan dy="4">盖章件</tspan></text>
  <text x="1" y="8">A &amp; B</text>
  <rect width="3" height="3"/>
  <text>   </text>
</svg>"#;
        let lines = svg_text_lines(src);
        assert_eq!(lines.len(), 2, "空白 text 跳过：{lines:?}");
        assert_eq!(lines[0], "历史盖章件");
        assert_eq!(lines[1], "A & B");
    }

    #[test]
    fn body_from_text_keeps_original_case_and_counts_lines() {
        let body = body_from_text("第一行 Header\r\n第二行 ac-03 引用\n");
        assert_eq!(body.body_text, "第一行 Header\n第二行 ac-03 引用");
        assert_eq!(body.body_text.split('\n').count(), 2);
        assert!(!body.truncated);
    }

    #[test]
    fn body_from_text_truncates_at_line_boundaries() {
        let long = (0..50_000)
            .map(|i| format!("行{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let body = body_from_text(&long);
        assert!(body.truncated);
        assert_eq!(body.body_text.split('\n').count(), MAX_BODY_LINES);
    }

    #[test]
    fn body_from_pdf_records_page_anchor_per_line() {
        let record = PdfExtractRecord {
            status: "page_indexed".to_owned(),
            error_reason: None,
            page_count: 2,
            text_page_count: 2,
            image_only_page_count: 0,
            extract_failed_page_count: 0,
            pages: vec![
                PdfPageExtract {
                    page_number: 1,
                    heading: String::new(),
                    extracted_text: "第一页内容\n第二行".to_owned(),
                    page_kind: "text".to_owned(),
                    image_count: 0,
                    char_count: 10,
                    visual_summary: String::new(),
                },
                PdfPageExtract {
                    page_number: 2,
                    heading: String::new(),
                    extracted_text: "第二页内容".to_owned(),
                    page_kind: "text".to_owned(),
                    image_count: 0,
                    char_count: 5,
                    visual_summary: String::new(),
                },
            ],
            plain_text: String::new(),
        };
        let body = body_from_pdf(&record);
        assert_eq!(body.body_text.split('\n').count(), 3);
        let anchor: serde_json::Value = serde_json::from_str(&body.anchor_json).unwrap();
        assert_eq!(anchor["pages"][0], 1);
        assert_eq!(anchor["pages"][2], 2);
    }

    #[test]
    fn build_postings_weights_and_caps() {
        let postings = build_postings(
            &normalize_text("登录方案"),
            &normalize_text("docs/设计/user-auth-service.ts"),
            &[
                "正文里的登录方案引用",
                "export function render() { let ac_03 = 1; }",
            ],
            true,
        );
        let title_hit = postings
            .iter()
            .find(|p| p.term == "登录" && p.field == FIELD_TITLE)
            .unwrap();
        let content_hit = postings
            .iter()
            .find(|p| p.term == "登录" && p.field == FIELD_CONTENT)
            .unwrap();
        assert_eq!(title_hit.weight, WEIGHT_TITLE);
        assert_eq!(content_hit.weight, WEIGHT_CONTENT);
        assert!(postings
            .iter()
            .any(|p| p.term == "uas" && p.field == FIELD_PATH));
        let code_hit = postings
            .iter()
            .find(|p| p.term == "ac_03" && p.field == FIELD_CONTENT)
            .unwrap();
        assert_eq!(code_hit.weight, WEIGHT_CONTENT_CODE);

        let huge_line: String = (0..30_000)
            .map(|i| format!("词{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let lines: Vec<&str> = vec![&huge_line];
        let postings = build_postings("t", "p.txt", &lines, true);
        let content_count = postings.iter().filter(|p| p.field == FIELD_CONTENT).count();
        assert!(content_count <= MAX_CONTENT_TOKENS);
    }

    #[test]
    fn has_body_false_docs_still_get_title_path_tokens() {
        let (row, postings) = build_search_doc(
            &SearchDocInput {
                file_id: "file_1",
                workspace_id: "ws",
                revision_id: "rev_1",
                content_hash: "hash",
                format: "png",
                title: "logo",
                rel_path: "assets/img/logo.png",
                status: "active",
                indexed_at: "2026-11-20T00:00:00",
            },
            None,
        );
        assert!(!row.has_body);
        assert_eq!(row.body_text, "");
        assert!(postings
            .iter()
            .any(|p| p.field == FIELD_TITLE && p.term == "logo"));
        assert!(postings
            .iter()
            .any(|p| p.field == FIELD_PATH && p.term == "png"));
        assert!(postings.iter().all(|p| p.field != FIELD_CONTENT));
    }

    #[test]
    fn office_and_pdf_bodies_carry_anchors() {
        let docx = OfficeExtractRecord {
            format: "docx".to_owned(),
            status: "indexed".to_owned(),
            error_reason: None,
            docx: Some(crate::index::office::OfficeDocxData {
                headings: Vec::new(),
                paragraphs: vec![crate::index::office::DocxParagraph {
                    para_index: 3,
                    style: None,
                    heading_level: None,
                    text: "验收结论段落".to_owned(),
                    is_table_row: false,
                }],
                comments: Vec::new(),
                tracked_changes: Default::default(),
                total_paragraphs: 1,
                truncated: false,
            }),
            xlsx: None,
            plain_text: String::new(),
        };
        let body = body_from_docx(&docx);
        assert_eq!(body.body_text, "验收结论段落");
        let anchor: serde_json::Value = serde_json::from_str(&body.anchor_json).unwrap();
        assert_eq!(anchor["paras"][0], 3);

        let xlsx = OfficeExtractRecord {
            format: "xlsx".to_owned(),
            status: "indexed".to_owned(),
            error_reason: None,
            docx: None,
            xlsx: Some(crate::index::office::OfficeXlsxData {
                sheets: vec![crate::index::office::XlsxSheetData {
                    name: "预算".to_owned(),
                    index: 0,
                    dimension_ref: None,
                    headers: Vec::new(),
                    row_count: 1,
                    col_count: 1,
                    numeric_summaries: Vec::new(),
                    rows: vec![crate::index::office::XlsxRow {
                        row_num: 3,
                        cells: vec![crate::index::office::XlsxCell {
                            ref_id: "A3".to_owned(),
                            col_idx: 0,
                            value: "12400".to_owned(),
                            is_numeric: true,
                            formula: None,
                        }],
                    }],
                    truncated: false,
                }],
                total_sheets: 1,
                truncated: false,
            }),
            plain_text: String::new(),
        };
        let body = body_from_xlsx(&xlsx);
        let anchor: serde_json::Value = serde_json::from_str(&body.anchor_json).unwrap();
        assert_eq!(anchor["cells"][0]["r"], "A3");
        assert_eq!(anchor["cells"][0]["n"], "预算");
    }
}
