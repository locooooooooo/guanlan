//! PDF 页级正文抽取与页码证据锚定（纯 Rust 零外部工具依赖，支持流式解压、
//! ToUnicode CMap、PDF 1.5+ ObjStm/XRef 流、扫描件诚实降级与跨版本页码直达）。
//!
//! 设计原则：
//!
//! 1. **永不崩溃唯一写线程**：全部字节切片、流解压与页树遍历均设严格上限并经
//!    `std::panic::catch_unwind` 兜底；损坏、截断或加密 PDF 一律降级为
//!    `corrupted` / `encrypted` / `metadata_only`；
//! 2. **页码 1-based 绝不错位**：严格按 `/Root -> /Pages -> /Kids` 深度优先顺序逐叶节点
//!    编排 `1..=page_count` 页码（含空白页与纯图像页，绝不跳号），绝不向正式库写入错位页码；
//! 3. **扫描件零假阳性**：纯图像页（无文本流且含图像 XObject 或内联图像）诚实标记
//!    `image_only`，`extracted_text` 置空不填伪造词；缺少 `ToUnicode` 的 Type3/CID 字体
//!    标记 `extract_failed`（中文提取失败不误判为扫描件）。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;

use flate2::read::{DeflateDecoder, ZlibDecoder};
use serde::{Deserialize, Serialize};

use crate::index::ident::stable_key;
use crate::index::office::{detect_inline_decision_marker, truncate_utf8_chars};
use crate::index::writer::EXTRACT_RULE_VERSION;
use crate::storage::StatementRow;

fn pdf_trace_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("GUANLAN_PDF_TRACE").is_some())
}

macro_rules! pdf_trace {
    ($($arg:tt)*) => {
        if pdf_trace_enabled() {
            eprintln!("[pdf] {}", format_args!($($arg)*));
        }
    };
}

/// 只读/索引期 PDF 解析体量上限（50 MiB，与 L2 PDF 快照上限对齐）
pub const MAX_PDF_PARSE_BYTES: usize = 50 * 1024 * 1024;
const MAX_PDF_PAGES: usize = 2000;
const MAX_STREAM_DECODE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGE_TEXT_BYTES: usize = 64 * 1024;
const MAX_PAGE_TEXT_ACCUM: usize = 256 * 1024;
const MAX_PAGE_INTERPRET_BYTES: usize = 8 * 1024 * 1024;
const MAX_FORM_INVOCATIONS: usize = 256;
const MAX_CONTENT_TOKENS: usize = 1_000_000;
const MAX_CMAP_TOKENS: usize = 1_000_000;
const MAX_PLAIN_TEXT_BYTES: usize = 512 * 1024;
const MAX_PAGE_TREE_DEPTH: usize = 64;
const MAX_FORM_DEPTH: usize = 8;

/// PDF 页码证据锚点（由 Markdown `#page=N` 链接或 PDF 内嵌 `[P0/P1/P2]` 标记派生）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PdfEvidenceAnchor {
    /// 固定 `"pdf_page"`
    pub kind: String,
    /// 1-based 精确页码
    pub page: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

/// 单页提取结构
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PdfPageExtract {
    pub page_number: u64,
    pub heading: String,
    pub extracted_text: String,
    /// `text` | `mixed` | `image_only` | `extract_failed` | `empty`
    pub page_kind: String,
    pub image_count: u64,
    pub char_count: u64,
    pub visual_summary: String,
}

/// 存入 `pdf_extracts` 表的完整结构化抽取记录
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PdfExtractRecord {
    /// `page_indexed` | `image_only` | `ocr_pending` | `extract_failed` | `encrypted` | `corrupted` | `metadata_only`
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    pub page_count: u64,
    pub text_page_count: u64,
    pub image_only_page_count: u64,
    pub extract_failed_page_count: u64,
    pub pages: Vec<PdfPageExtract>,
    #[serde(skip_serializing, default)]
    pub plain_text: String,
}

impl PdfExtractRecord {
    pub fn metadata_only(reason: impl Into<String>) -> Self {
        Self {
            status: "metadata_only".to_owned(),
            error_reason: Some(reason.into()),
            page_count: 0,
            text_page_count: 0,
            image_only_page_count: 0,
            extract_failed_page_count: 0,
            pages: Vec::new(),
            plain_text: String::new(),
        }
    }

    pub fn degraded(status: &str, reason: impl Into<String>) -> Self {
        Self {
            status: status.to_owned(),
            error_reason: Some(reason.into()),
            page_count: 0,
            text_page_count: 0,
            image_only_page_count: 0,
            extract_failed_page_count: 0,
            pages: Vec::new(),
            plain_text: String::new(),
        }
    }
}

/// 安全入口：从 PDF 字节提取逐页文本与页面分类（绝不 panic）
pub fn extract_pdf_from_bytes(bytes: &[u8]) -> PdfExtractRecord {
    if bytes.len() > MAX_PDF_PARSE_BYTES {
        return PdfExtractRecord::metadata_only(
            "PDF 体积超出 L2 页文本解析上限，按 L0 元数据入库，可直开原页预览",
        );
    }
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| extract_pdf_inner(bytes))) {
        Ok(rec) => rec,
        Err(_) => PdfExtractRecord::degraded(
            "corrupted",
            "PDF 内部对象结构异常，已自动降级为 L0 元数据卡",
        ),
    }
}

fn extract_pdf_inner(bytes: &[u8]) -> PdfExtractRecord {
    let Some(header_pos) = find_pdf_header(bytes) else {
        return PdfExtractRecord::degraded("corrupted", "未检测到 %PDF 文件头，文件可能已损坏");
    };
    let slice = &bytes[header_pos..];
    let mut doc = match PdfDoc::open(slice) {
        Ok(doc) => doc,
        Err(PdfOpenErr::Encrypted) => {
            return PdfExtractRecord::degraded(
                "encrypted",
                "文档已加密受保护，未做正文抽取；可直接用原文件或外部阅读器打开",
            );
        }
        Err(PdfOpenErr::Corrupted(msg)) => {
            return PdfExtractRecord::degraded("corrupted", msg);
        }
    };

    let page_nodes = doc.collect_pages();
    pdf_trace!("collect_pages -> {}", page_nodes.len());
    if page_nodes.is_empty() {
        return PdfExtractRecord::degraded("corrupted", "未在 PDF 中解析到有效页面节点");
    }

    let mut pages = Vec::with_capacity(page_nodes.len());
    let mut text_page_count = 0u64;
    let mut image_only_page_count = 0u64;
    let mut extract_failed_page_count = 0u64;
    let mut plain_buf = String::new();

    for (idx, page_node) in page_nodes.iter().enumerate() {
        let page_num = (idx + 1) as u64;
        pdf_trace!("page {page_num} extract begin");
        let extracted = doc.extract_single_page(page_node, page_num);
        pdf_trace!(
            "page {page_num} extract end kind={} text_len={}",
            extracted.page_kind,
            extracted.extracted_text.len()
        );
        match extracted.page_kind.as_str() {
            "text" | "mixed" => text_page_count += 1,
            "image_only" => image_only_page_count += 1,
            "extract_failed" => extract_failed_page_count += 1,
            _ => {}
        }
        if !extracted.extracted_text.is_empty() && plain_buf.len() < MAX_PLAIN_TEXT_BYTES {
            if !plain_buf.is_empty() {
                plain_buf.push('\n');
            }
            plain_buf.push_str(&format!("[第 {page_num} 页]\n"));
            plain_buf.push_str(&extracted.extracted_text);
        }
        pages.push(extracted);
    }

    let page_count = pages.len() as u64;
    let (status, error_reason) = if text_page_count > 0 {
        (
            "page_indexed".to_owned(),
            if image_only_page_count > 0 {
                Some(format!(
                    "已按需抽取 {text_page_count}/{page_count} 页文本层（另有 {image_only_page_count} 页纯图像页未做文本抽取）"
                ))
            } else {
                None
            },
        )
    } else if image_only_page_count > 0 && extract_failed_page_count == 0 {
        (
            "image_only".to_owned(),
            Some(format!(
                "纯图像页，未做文本抽取（共 {page_count} 页扫描图像，待 OCR；仅文件名与元数据可检索）"
            )),
        )
    } else if extract_failed_page_count > 0 {
        (
            "extract_failed".to_owned(),
            Some(
                "字符流提取失败：字体缺少 ToUnicode 映射（中文提取失败不直接判定为扫描件）"
                    .to_owned(),
            ),
        )
    } else {
        ("page_indexed".to_owned(), None)
    };

    PdfExtractRecord {
        status,
        error_reason,
        page_count,
        text_page_count,
        image_only_page_count,
        extract_failed_page_count,
        pages,
        plain_text: truncate_utf8_chars(&plain_buf, MAX_PLAIN_TEXT_BYTES),
    }
}

/// 从已索引 PDF 的各页正文中抽取显式 `[P0/P1/P2 - 待确认]` 决定陈述，精确锚定 1-based 页码。
pub fn derive_pdf_statements(
    workspace_id: &str,
    file_id: &str,
    revision_id: &str,
    relative_path: &str,
    observed_at: &str,
    extract: &PdfExtractRecord,
) -> Vec<StatementRow> {
    if extract.status != "page_indexed" {
        return Vec::new();
    }
    let mut out = Vec::new();
    let namespace = relative_path
        .rsplit('/')
        .next()
        .unwrap_or(relative_path)
        .to_owned();

    for page in &extract.pages {
        if page.extracted_text.is_empty() {
            continue;
        }
        let mut seen_on_page = HashSet::new();
        for line in page.extracted_text.lines() {
            let Some((code, status, question)) = detect_inline_decision_marker(line) else {
                continue;
            };
            let key = format!("{code}|{question}");
            if !seen_on_page.insert(key) {
                continue;
            }
            let norm_q: String = question
                .chars()
                .filter(|c| !c.is_whitespace() && !matches!(c, '？' | '?' | '。' | '，' | ','))
                .collect::<String>()
                .to_lowercase();
            let line_num = page.page_number as i64;
            let statement_id = format!(
                "stmt_{}",
                stable_key(&format!("{revision_id}|{code}|{line_num}|{norm_q}"))
            );
            let decision_id = format!(
                "dec_{}",
                stable_key(&format!("{namespace}|{code}|{norm_q}"))
            );
            let anchor = PdfEvidenceAnchor {
                kind: "pdf_page".to_owned(),
                page: page.page_number,
                heading: Some(page.heading.clone()),
                excerpt: Some(truncate_utf8_chars(line.trim(), 200)),
            };
            let detail_json = serde_json::json!({
                "priority": code,
                "pdf_anchor": anchor,
            })
            .to_string();

            out.push(StatementRow {
                statement_id,
                workspace_id: workspace_id.to_owned(),
                file_id: file_id.to_owned(),
                revision_id: revision_id.to_owned(),
                code,
                namespace: namespace.clone(),
                question,
                status,
                quote: truncate_utf8_chars(line.trim(), 240),
                line_start: line_num,
                line_end: line_num,
                decision_id: Some(decision_id),
                detail_json,
                extract_rule_version: EXTRACT_RULE_VERSION.to_owned(),
                observed_at: observed_at.to_owned(),
            });
        }
    }

    out
}

#[derive(Debug)]
enum PdfOpenErr {
    Encrypted,
    Corrupted(String),
}

#[derive(Debug, Clone)]
enum PdfObj {
    Null,
    #[allow(dead_code)]
    Bool(bool),
    Int(i64),
    Real(f64),
    Name(String),
    #[allow(dead_code)]
    Str(Vec<u8>),
    Array(Vec<PdfObj>),
    Dict(BTreeMap<String, PdfObj>),
    Stream(BTreeMap<String, PdfObj>, Vec<u8>),
    Ref(u32, u16),
}

impl PdfObj {
    fn as_dict(&self) -> Option<&BTreeMap<String, PdfObj>> {
        match self {
            PdfObj::Dict(d) | PdfObj::Stream(d, _) => Some(d),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&[PdfObj]> {
        match self {
            PdfObj::Array(arr) => Some(arr),
            _ => None,
        }
    }

    fn as_name(&self) -> Option<&str> {
        match self {
            PdfObj::Name(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_int(&self) -> Option<i64> {
        match self {
            PdfObj::Int(n) => Some(*n),
            PdfObj::Real(f) if f.is_finite() => Some(*f as i64),
            _ => None,
        }
    }

    fn as_ref(&self) -> Option<(u32, u16)> {
        match self {
            PdfObj::Ref(n, g) => Some((*n, *g)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum ObjLoc {
    Offset(usize),
    Compressed {
        objstm: u32,
        #[allow(dead_code)]
        index: usize,
    },
}

#[derive(Debug, Clone)]
struct PageNode {
    dict: BTreeMap<String, PdfObj>,
    inherited_fonts: BTreeMap<String, PdfObj>,
    inherited_xobjects: BTreeMap<String, PdfObj>,
}

#[derive(Debug, Clone)]
struct FontDecoder {
    to_unicode: HashMap<(u8, u32), String>,
    has_to_unicode: bool,
    code_lengths: Vec<u8>,
    is_cid: bool,
    is_type3: bool,
    base_encoding: FontBaseEncoding,
    differences: HashMap<u8, char>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FontBaseEncoding {
    WinAnsi,
    MacRoman,
    Standard,
    Identity,
}

struct PdfDoc<'a> {
    bytes: &'a [u8],
    locs: HashMap<u32, ObjLoc>,
    cache: HashMap<u32, PdfObj>,
    objstm_cache: HashMap<u32, HashMap<u32, PdfObj>>,
    font_cache: HashMap<u32, FontDecoder>,
    root_ref: Option<(u32, u16)>,
}

impl<'a> PdfDoc<'a> {
    fn open(bytes: &'a [u8]) -> Result<Self, PdfOpenErr> {
        let mut doc = Self {
            bytes,
            locs: HashMap::new(),
            cache: HashMap::new(),
            objstm_cache: HashMap::new(),
            font_cache: HashMap::new(),
            root_ref: None,
        };

        let mut encrypted = false;
        doc.load_xref_chain(&mut encrypted);
        if encrypted {
            return Err(PdfOpenErr::Encrypted);
        }

        if doc.locs.is_empty() || doc.root_ref.is_none() {
            doc.linear_scan_fallback(&mut encrypted);
            if encrypted {
                return Err(PdfOpenErr::Encrypted);
            }
        }

        if doc.root_ref.is_none() && doc.locs.is_empty() {
            return Err(PdfOpenErr::Corrupted(
                "未找到 PDF 对象索引与文档根目录".to_owned(),
            ));
        }

        Ok(doc)
    }

    fn load_xref_chain(&mut self, encrypted: &mut bool) {
        let Some(mut xref_off) = find_startxref(self.bytes) else {
            return;
        };
        let mut visited = HashSet::new();
        for _ in 0..32 {
            if xref_off >= self.bytes.len() || !visited.insert(xref_off) {
                break;
            }
            let pos = skip_ws(self.bytes, xref_off);
            if pos >= self.bytes.len() {
                break;
            }
            if self.bytes[pos..].starts_with(b"xref") {
                if let Some(trailer) = self.parse_classic_xref(pos) {
                    if trailer.contains_key("Encrypt") {
                        *encrypted = true;
                        return;
                    }
                    if self.root_ref.is_none() {
                        self.root_ref = trailer.get("Root").and_then(|o| o.as_ref());
                    }
                    if let Some(xref_stm_off) = trailer
                        .get("XRefStm")
                        .and_then(|o| o.as_int())
                        .filter(|&v| v >= 0)
                    {
                        let stm_pos = skip_ws(self.bytes, xref_stm_off as usize);
                        let _ = self.parse_xref_stream(stm_pos, encrypted);
                    }
                    if let Some(prev) = trailer
                        .get("Prev")
                        .and_then(|o| o.as_int())
                        .filter(|&v| v >= 0)
                    {
                        xref_off = prev as usize;
                        continue;
                    }
                }
                break;
            } else {
                match self.parse_xref_stream(pos, encrypted) {
                    Some(Some(prev)) => {
                        xref_off = prev;
                        continue;
                    }
                    _ => break,
                }
            }
        }
    }

    fn parse_classic_xref(&mut self, start: usize) -> Option<BTreeMap<String, PdfObj>> {
        let mut pos = start + 4;
        loop {
            pos = skip_ws(self.bytes, pos);
            if pos >= self.bytes.len() {
                return None;
            }
            if self.bytes[pos..].starts_with(b"trailer") {
                pos += 7;
                pos = skip_ws(self.bytes, pos);
                let (obj, _) = parse_value(self.bytes, pos, None)?;
                return obj.as_dict().cloned();
            }
            let (first_id, next_pos) = parse_uint_token(self.bytes, pos)?;
            let (count, entry_pos) = parse_uint_token(self.bytes, next_pos)?;
            pos = skip_ws(self.bytes, entry_pos);
            let count_usize = (count as usize).min(1_000_000);
            for idx in 0..count_usize {
                pos = skip_ws(self.bytes, pos);
                if pos + 18 > self.bytes.len() {
                    break;
                }
                let line_end = find_line_end(self.bytes, pos).min(pos + 24);
                let line = &self.bytes[pos..line_end];
                if let Some((offset, flag)) = parse_xref_entry_line(line) {
                    let obj_num = first_id.saturating_add(idx as u32);
                    if flag == b'n' && offset > 0 && offset < self.bytes.len() {
                        self.locs.entry(obj_num).or_insert(ObjLoc::Offset(offset));
                    }
                }
                pos = skip_eol(self.bytes, line_end);
            }
        }
    }

    fn parse_xref_stream(&mut self, pos: usize, encrypted: &mut bool) -> Option<Option<usize>> {
        let mut guard = HashSet::new();
        let (_, _, obj) = self.parse_indirect_at(pos, &mut guard)?;
        let PdfObj::Stream(dict, raw_data) = obj else {
            return None;
        };
        if dict.get("Type").and_then(|o| o.as_name()) != Some("XRef") {
            return None;
        }
        if dict.contains_key("Encrypt") {
            *encrypted = true;
            return None;
        }
        if self.root_ref.is_none() {
            self.root_ref = dict.get("Root").and_then(|o| o.as_ref());
        }

        let w_arr = dict.get("W")?.as_array()?;
        if w_arr.len() < 3 {
            return None;
        }
        let w0 = w_arr[0].as_int()?.max(0) as usize;
        let w1 = w_arr[1].as_int()?.max(0) as usize;
        let w2 = w_arr[2].as_int()?.max(0) as usize;
        let row_len = w0 + w1 + w2;
        if row_len == 0 || row_len > 32 {
            return None;
        }

        let size = dict
            .get("Size")
            .and_then(|o| o.as_int())
            .unwrap_or(0)
            .max(0) as u32;
        let mut index_pairs: Vec<(u32, u32)> = Vec::new();
        if let Some(arr) = dict.get("Index").and_then(|o| o.as_array()) {
            for chunk in arr.as_chunks::<2>().0 {
                if let (Some(a), Some(b)) = (chunk[0].as_int(), chunk[1].as_int()) {
                    if a >= 0 && b >= 0 {
                        index_pairs.push((a as u32, b as u32));
                    }
                }
            }
        } else {
            index_pairs.push((0, size));
        }

        let decoded = decode_stream_bytes(&dict, &raw_data).ok()?;
        let mut cursor = 0usize;
        for (start_id, count) in index_pairs {
            let count_usize = (count as usize).min(1_000_000);
            for i in 0..count_usize {
                if cursor + row_len > decoded.len() {
                    break;
                }
                let entry = &decoded[cursor..cursor + row_len];
                cursor += row_len;
                let f0 = if w0 == 0 {
                    1
                } else {
                    read_be_u64(&entry[..w0])
                };
                let f1 = read_be_u64(&entry[w0..w0 + w1]);
                let f2 = read_be_u64(&entry[w0 + w1..]);
                let obj_num = start_id.saturating_add(i as u32);
                match f0 {
                    1 => {
                        let off = f1 as usize;
                        if off > 0 && off < self.bytes.len() {
                            self.locs.entry(obj_num).or_insert(ObjLoc::Offset(off));
                        }
                    }
                    2 => {
                        self.locs.entry(obj_num).or_insert(ObjLoc::Compressed {
                            objstm: f1 as u32,
                            index: f2 as usize,
                        });
                    }
                    _ => {}
                }
            }
        }

        let prev = dict
            .get("Prev")
            .and_then(|o| o.as_int())
            .filter(|&v| v >= 0)
            .map(|v| v as usize);
        Some(prev)
    }

    fn linear_scan_fallback(&mut self, encrypted: &mut bool) {
        let mut pos = 0usize;
        let len = self.bytes.len();
        while pos < len {
            if let Some((obj_num, _, obj_off)) = find_next_obj_header(self.bytes, pos) {
                self.locs.entry(obj_num).or_insert(ObjLoc::Offset(obj_off));
                pos = obj_off + 6;
                let window = &self.bytes[pos..len.min(pos + 4096)];
                let endobj_rel = find_subslice(window, b"endobj");
                if let Some(stream_rel) = find_subslice(window, b"stream") {
                    if endobj_rel.is_none_or(|e| stream_rel < e) {
                        let s_pos = pos + stream_rel + 6;
                        if let Some(end_rel) = find_subslice(&self.bytes[s_pos..], b"endstream") {
                            pos = s_pos + end_rel + 9;
                        }
                    }
                }
            } else {
                break;
            }
        }
        if let Some(tr_pos) = rfind_subslice(self.bytes, b"trailer") {
            let val_pos = skip_ws(self.bytes, tr_pos + 7);
            if let Some((obj, _)) = parse_value(self.bytes, val_pos, None) {
                if let Some(d) = obj.as_dict() {
                    if d.contains_key("Encrypt") {
                        *encrypted = true;
                        return;
                    }
                    if self.root_ref.is_none() {
                        self.root_ref = d.get("Root").and_then(|o| o.as_ref());
                    }
                }
            }
        }
        if self.root_ref.is_none() {
            let keys: Vec<u32> = self.locs.keys().copied().collect();
            for obj_num in keys {
                if let Some(obj) = self.get_object(obj_num) {
                    if let Some(d) = obj.as_dict() {
                        if d.get("Type").and_then(|o| o.as_name()) == Some("Catalog") {
                            self.root_ref = Some((obj_num, 0));
                            break;
                        }
                    }
                }
            }
        }
    }

    fn get_object(&mut self, obj_num: u32) -> Option<PdfObj> {
        let mut guard = HashSet::new();
        self.get_object_with_guard(obj_num, &mut guard)
    }

    fn get_object_with_guard(&mut self, obj_num: u32, guard: &mut HashSet<u32>) -> Option<PdfObj> {
        if let Some(cached) = self.cache.get(&obj_num) {
            return Some(cached.clone());
        }
        if !guard.insert(obj_num) {
            return None;
        }
        let loc = *self.locs.get(&obj_num)?;
        let out = match loc {
            ObjLoc::Offset(off) => {
                let (_, _, obj) = self.parse_indirect_at(off, guard)?;
                obj
            }
            ObjLoc::Compressed { objstm, index: _ } => {
                self.load_objstm(objstm, guard);
                self.objstm_cache
                    .get(&objstm)
                    .and_then(|m| m.get(&obj_num))
                    .cloned()?
            }
        };
        guard.remove(&obj_num);
        self.cache.insert(obj_num, out.clone());
        Some(out)
    }

    fn load_objstm(&mut self, objstm_num: u32, guard: &mut HashSet<u32>) {
        if self.objstm_cache.contains_key(&objstm_num) {
            return;
        }
        let Some(PdfObj::Stream(dict, raw)) = self.get_object_with_guard(objstm_num, guard) else {
            return;
        };
        let n = dict.get("N").and_then(|o| o.as_int()).unwrap_or(0).max(0) as usize;
        let first = dict
            .get("First")
            .and_then(|o| o.as_int())
            .unwrap_or(0)
            .max(0) as usize;
        let Ok(decoded) = decode_stream_bytes(&dict, &raw) else {
            return;
        };
        if first > decoded.len() {
            return;
        }
        let mut hdr_pos = 0usize;
        let mut entries = Vec::with_capacity(n.min(4096));
        for _ in 0..n.min(4096) {
            let Some((id, p1)) = parse_uint_token(&decoded[..first], hdr_pos) else {
                break;
            };
            let Some((rel_off, p2)) = parse_uint_token(&decoded[..first], p1) else {
                break;
            };
            entries.push((id, first.saturating_add(rel_off as usize)));
            hdr_pos = p2;
        }
        let mut map = HashMap::new();
        for (id, off) in entries {
            if off < decoded.len() {
                if let Some((obj, _)) = parse_value(&decoded, off, None) {
                    map.insert(id, obj);
                }
            }
        }
        self.objstm_cache.insert(objstm_num, map);
    }

    fn parse_indirect_at(
        &mut self,
        offset: usize,
        guard: &mut HashSet<u32>,
    ) -> Option<(u32, u16, PdfObj)> {
        let pos = skip_ws(self.bytes, offset);
        let (obj_num, p1) = parse_uint_token(self.bytes, pos)?;
        let (gen_num, p2) = parse_uint_token(self.bytes, p1)?;
        let p3 = skip_ws(self.bytes, p2);
        if !self.bytes[p3..].starts_with(b"obj") {
            return None;
        }
        let body_start = skip_ws(self.bytes, p3 + 3);
        let (val, after_val) = parse_value(self.bytes, body_start, None)?;
        if let PdfObj::Dict(dict) = val {
            let after_ws = skip_ws(self.bytes, after_val);
            if self.bytes[after_ws..].starts_with(b"stream")
                && is_pdf_delim_or_ws(self.bytes.get(after_ws + 6).copied())
            {
                let mut data_start = after_ws + 6;
                if self.bytes.get(data_start) == Some(&b'\r')
                    && self.bytes.get(data_start + 1) == Some(&b'\n')
                {
                    data_start += 2;
                } else if self.bytes.get(data_start) == Some(&b'\n')
                    || self.bytes.get(data_start) == Some(&b'\r')
                {
                    data_start += 1;
                }

                let explicit_len = match dict.get("Length") {
                    Some(PdfObj::Int(n)) if *n >= 0 => Some(*n as usize),
                    Some(PdfObj::Ref(len_num, _)) => self
                        .get_object_with_guard(*len_num, guard)
                        .and_then(|o| o.as_int())
                        .filter(|&n| n >= 0)
                        .map(|n| n as usize),
                    _ => None,
                };

                let stream_bytes = if let Some(len) = explicit_len {
                    let end = data_start.saturating_add(len);
                    if end <= self.bytes.len() && has_endstream_near(&self.bytes[end..]) {
                        &self.bytes[data_start..end]
                    } else {
                        slice_until_endstream(&self.bytes[data_start..])
                    }
                } else {
                    slice_until_endstream(&self.bytes[data_start..])
                };
                return Some((
                    obj_num,
                    gen_num as u16,
                    PdfObj::Stream(dict, stream_bytes.to_vec()),
                ));
            }
            return Some((obj_num, gen_num as u16, PdfObj::Dict(dict)));
        }
        Some((obj_num, gen_num as u16, val))
    }

    fn resolve(&mut self, obj: &PdfObj) -> Option<PdfObj> {
        match obj {
            PdfObj::Ref(n, _) => self.get_object(*n),
            other => Some(other.clone()),
        }
    }

    fn collect_pages(&mut self) -> Vec<PageNode> {
        let Some((root_id, _)) = self.root_ref else {
            return Vec::new();
        };
        let Some(root_obj) = self.get_object(root_id) else {
            return Vec::new();
        };
        let Some(root_dict) = root_obj.as_dict() else {
            return Vec::new();
        };
        let Some((pages_id, _)) = root_dict.get("Pages").and_then(|o| o.as_ref()) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut visited = HashSet::new();
        self.walk_page_tree(
            pages_id,
            BTreeMap::new(),
            BTreeMap::new(),
            0,
            &mut visited,
            &mut out,
        );
        out
    }

    fn walk_page_tree(
        &mut self,
        node_id: u32,
        parent_fonts: BTreeMap<String, PdfObj>,
        parent_xobjects: BTreeMap<String, PdfObj>,
        depth: usize,
        visited: &mut HashSet<u32>,
        out: &mut Vec<PageNode>,
    ) {
        if depth > MAX_PAGE_TREE_DEPTH || out.len() >= MAX_PDF_PAGES || !visited.insert(node_id) {
            return;
        }
        let Some(node_obj) = self.get_object(node_id) else {
            return;
        };
        let Some(dict) = node_obj.as_dict().cloned() else {
            return;
        };
        let (fonts, xobjects) = self.merge_resources(&dict, parent_fonts, parent_xobjects);

        let node_type = dict.get("Type").and_then(|o| o.as_name()).unwrap_or("");
        if node_type == "Page" || !dict.contains_key("Kids") {
            if node_type == "Pages" {
                return;
            }
            out.push(PageNode {
                dict,
                inherited_fonts: fonts,
                inherited_xobjects: xobjects,
            });
            return;
        }

        if let Some(kids) = dict.get("Kids").and_then(|o| o.as_array()) {
            for kid in kids {
                if out.len() >= MAX_PDF_PAGES {
                    break;
                }
                if let Some((kid_id, _)) = kid.as_ref() {
                    self.walk_page_tree(
                        kid_id,
                        fonts.clone(),
                        xobjects.clone(),
                        depth + 1,
                        visited,
                        out,
                    );
                }
            }
        }
    }

    fn merge_resources(
        &mut self,
        dict: &BTreeMap<String, PdfObj>,
        mut fonts: BTreeMap<String, PdfObj>,
        mut xobjects: BTreeMap<String, PdfObj>,
    ) -> (BTreeMap<String, PdfObj>, BTreeMap<String, PdfObj>) {
        let Some(res_raw) = dict.get("Resources") else {
            return (fonts, xobjects);
        };
        let Some(res_obj) = self.resolve(res_raw) else {
            return (fonts, xobjects);
        };
        let Some(res_dict) = res_obj.as_dict() else {
            return (fonts, xobjects);
        };
        if let Some(font_raw) = res_dict.get("Font") {
            if let Some(font_obj) = self.resolve(font_raw) {
                if let Some(font_map) = font_obj.as_dict() {
                    for (k, v) in font_map {
                        fonts.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        if let Some(xo_raw) = res_dict.get("XObject") {
            if let Some(xo_obj) = self.resolve(xo_raw) {
                if let Some(xo_map) = xo_obj.as_dict() {
                    for (k, v) in xo_map {
                        xobjects.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (fonts, xobjects)
    }

    fn load_font(&mut self, font_obj: &PdfObj) -> FontDecoder {
        if let PdfObj::Ref(id, _) = font_obj {
            if let Some(cached) = self.font_cache.get(id) {
                return cached.clone();
            }
        }
        let resolved = self.resolve(font_obj);
        let decoder = match resolved.as_ref().and_then(|o| o.as_dict()) {
            Some(dict) => self.build_font_decoder(dict),
            None => FontDecoder::default(),
        };
        if let PdfObj::Ref(id, _) = font_obj {
            self.font_cache.insert(*id, decoder.clone());
        }
        decoder
    }

    fn build_font_decoder(&mut self, dict: &BTreeMap<String, PdfObj>) -> FontDecoder {
        let subtype = dict.get("Subtype").and_then(|o| o.as_name()).unwrap_or("");
        let is_cid = subtype == "Type0";
        let is_type3 = subtype == "Type3";

        let mut base_encoding = FontBaseEncoding::WinAnsi;
        let mut differences = HashMap::new();
        if let Some(enc_raw) = dict.get("Encoding") {
            if let Some(name) = enc_raw.as_name() {
                base_encoding = match name {
                    "MacRomanEncoding" => FontBaseEncoding::MacRoman,
                    "StandardEncoding" => FontBaseEncoding::Standard,
                    "Identity-H" | "Identity-V" => FontBaseEncoding::Identity,
                    _ => FontBaseEncoding::WinAnsi,
                };
            } else if let Some(enc_obj) = self.resolve(enc_raw) {
                if let Some(enc_dict) = enc_obj.as_dict() {
                    if let Some(base_name) = enc_dict.get("BaseEncoding").and_then(|o| o.as_name())
                    {
                        base_encoding = match base_name {
                            "MacRomanEncoding" => FontBaseEncoding::MacRoman,
                            "StandardEncoding" => FontBaseEncoding::Standard,
                            "Identity-H" | "Identity-V" => FontBaseEncoding::Identity,
                            _ => FontBaseEncoding::WinAnsi,
                        };
                    }
                    if let Some(diffs) = enc_dict.get("Differences").and_then(|o| o.as_array()) {
                        let mut code: i64 = 0;
                        for item in diffs {
                            match item {
                                PdfObj::Int(n) => code = *n,
                                PdfObj::Name(gname) => {
                                    if (0..=255).contains(&code) {
                                        if let Some(ch) = adobe_glyph_to_char(gname) {
                                            differences.insert(code as u8, ch);
                                        }
                                    }
                                    code += 1;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        } else if is_cid {
            base_encoding = FontBaseEncoding::Identity;
        }

        let mut to_unicode = HashMap::new();
        let mut code_lengths = Vec::new();
        let mut has_to_unicode = false;
        if let Some(tu_raw) = dict.get("ToUnicode") {
            if let Some(PdfObj::Stream(tu_dict, tu_bytes)) = self.resolve(tu_raw) {
                if let Ok(cmap_bytes) = decode_stream_bytes(&tu_dict, &tu_bytes) {
                    let parsed = parse_tounicode_cmap(&cmap_bytes);
                    if !parsed.map.is_empty() {
                        has_to_unicode = true;
                        to_unicode = parsed.map;
                        code_lengths = parsed.code_lengths;
                    }
                }
            }
        }

        FontDecoder {
            to_unicode,
            has_to_unicode,
            code_lengths,
            is_cid: is_cid || base_encoding == FontBaseEncoding::Identity,
            is_type3,
            base_encoding,
            differences,
        }
    }

    fn extract_single_page(&mut self, page: &PageNode, page_number: u64) -> PdfPageExtract {
        let mut streams: Vec<Vec<u8>> = Vec::new();
        if let Some(contents) = page.dict.get("Contents") {
            match contents {
                PdfObj::Ref(id, _) => {
                    if let Some(PdfObj::Stream(d, raw)) = self.get_object(*id) {
                        if let Ok(dec) = decode_stream_bytes(&d, &raw) {
                            streams.push(dec);
                        }
                    }
                }
                PdfObj::Array(arr) => {
                    for item in arr {
                        if let Some((id, _)) = item.as_ref() {
                            if let Some(PdfObj::Stream(d, raw)) = self.get_object(id) {
                                if let Ok(dec) = decode_stream_bytes(&d, &raw) {
                                    streams.push(dec);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        let mut ctx = PageExtractCtx::default();
        for stream_bytes in &streams {
            self.interpret_content_stream(
                stream_bytes,
                &page.inherited_fonts,
                &page.inherited_xobjects,
                0,
                &mut ctx,
            );
        }

        let cleaned = normalize_extracted_text(&ctx.out);
        let char_count = cleaned.chars().filter(|c| !c.is_whitespace()).count() as u64;

        let (page_kind, extracted_text, heading, visual_summary) = if char_count > 0 {
            let trimmed = truncate_utf8_chars(&cleaned, MAX_PAGE_TEXT_BYTES);
            let first_line = trimmed
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("");
            let heading = if first_line.is_empty() {
                format!("第 {page_number} 页")
            } else {
                truncate_utf8_chars(first_line, 96)
            };
            let kind = if ctx.image_count > 0 { "mixed" } else { "text" };
            let summary = if ctx.image_count > 0 {
                format!("图文混排页（{char_count} 字 · {} 张图像）", ctx.image_count)
            } else {
                format!("文本页（{char_count} 字）")
            };
            (kind.to_owned(), trimmed, heading, summary)
        } else if ctx.unmapped_glyph_ops > 0 && ctx.image_count == 0 {
            (
                "extract_failed".to_owned(),
                String::new(),
                format!("第 {page_number} 页 · 字符提取失败"),
                "字符提取失败（字体缺少 ToUnicode 映射；中文提取失败不直接判定为扫描件）"
                    .to_owned(),
            )
        } else if ctx.image_count > 0 {
            (
                "image_only".to_owned(),
                String::new(),
                format!("第 {page_number} 页 · 纯图像页"),
                format!(
                    "纯图像页，未做文本抽取（{} 张图像，待 OCR）",
                    ctx.image_count
                ),
            )
        } else if ctx.unmapped_glyph_ops > 0 {
            (
                "extract_failed".to_owned(),
                String::new(),
                format!("第 {page_number} 页 · 字符提取失败"),
                "字符提取失败（字体缺少 ToUnicode 映射）".to_owned(),
            )
        } else {
            (
                "empty".to_owned(),
                String::new(),
                format!("第 {page_number} 页 · 空白页"),
                "空白页（无文字与图像）".to_owned(),
            )
        };

        let text_present = !extracted_text.is_empty();
        PdfPageExtract {
            page_number,
            heading,
            extracted_text,
            page_kind,
            image_count: ctx.image_count,
            char_count: if text_present { char_count } else { 0 },
            visual_summary,
        }
    }

    fn interpret_content_stream(
        &mut self,
        stream_bytes: &[u8],
        fonts: &BTreeMap<String, PdfObj>,
        xobjects: &BTreeMap<String, PdfObj>,
        depth: usize,
        ctx: &mut PageExtractCtx,
    ) {
        if depth > MAX_FORM_DEPTH || ctx.work_budget == 0 {
            return;
        }
        ctx.work_budget = ctx.work_budget.saturating_sub(stream_bytes.len());
        pdf_trace!(
            "interp begin depth={depth} bytes={} budget={}",
            stream_bytes.len(),
            ctx.work_budget
        );
        let tokens = tokenize_content_stream(stream_bytes);
        let mut operands: Vec<ContentTok> = Vec::new();
        let mut font_stack: Vec<(Option<FontDecoder>, f64)> = Vec::new();
        let mut cur_font: Option<FontDecoder> = None;
        let mut cur_font_size: f64 = 12.0;
        let mut cur_y: Option<f64> = None;
        let mut cur_x: Option<f64> = None;
        let mut in_text = false;

        let mut i = 0usize;
        while i < tokens.len() {
            if ctx.out.len() >= MAX_PAGE_TEXT_ACCUM {
                break;
            }
            let tok = &tokens[i];
            match tok {
                ContentTok::Op(op) => {
                    match op.as_str() {
                        "q" => font_stack.push((cur_font.clone(), cur_font_size)),
                        "Q" => {
                            if let Some((f, s)) = font_stack.pop() {
                                cur_font = f;
                                cur_font_size = s;
                            }
                        }
                        "BT" => {
                            in_text = true;
                            cur_x = None;
                            cur_y = None;
                        }
                        "ET" => {
                            if in_text && !ctx.out.ends_with('\n') && !ctx.out.is_empty() {
                                ctx.out.push('\n');
                            }
                            in_text = false;
                        }
                        "Tf" => {
                            if operands.len() >= 2 {
                                if let Some(sz) = operands.last().and_then(|t| t.as_num()) {
                                    if sz > 0.0 {
                                        cur_font_size = sz;
                                    }
                                }
                                if let Some(fname) =
                                    operands.get(operands.len() - 2).and_then(|t| t.as_name())
                                {
                                    cur_font = fonts.get(fname).map(|fobj| self.load_font(fobj));
                                }
                            }
                        }
                        "Td" | "TD" => {
                            if operands.len() >= 2 {
                                let tx = operands
                                    .get(operands.len() - 2)
                                    .and_then(|t| t.as_num())
                                    .unwrap_or(0.0);
                                let ty = operands.last().and_then(|t| t.as_num()).unwrap_or(0.0);
                                if ty.abs() > 0.35 * cur_font_size.max(6.0) {
                                    if !ctx.out.ends_with('\n') && !ctx.out.is_empty() {
                                        ctx.out.push('\n');
                                    }
                                } else if tx > 0.25 * cur_font_size.max(6.0)
                                    && !ctx.out.ends_with(|c: char| c.is_whitespace())
                                    && !ctx.out.is_empty()
                                {
                                    ctx.out.push(' ');
                                }
                                cur_x = Some(cur_x.unwrap_or(0.0) + tx);
                                cur_y = Some(cur_y.unwrap_or(0.0) + ty);
                            }
                        }
                        "Tm" => {
                            if operands.len() >= 6 {
                                let nx = operands
                                    .get(operands.len() - 2)
                                    .and_then(|t| t.as_num())
                                    .unwrap_or(0.0);
                                let ny = operands.last().and_then(|t| t.as_num()).unwrap_or(0.0);
                                if let Some(py) = cur_y {
                                    if (ny - py).abs() > 0.35 * cur_font_size.max(6.0) {
                                        if !ctx.out.ends_with('\n') && !ctx.out.is_empty() {
                                            ctx.out.push('\n');
                                        }
                                    } else if let Some(px) = cur_x {
                                        if (nx - px) > 0.25 * cur_font_size.max(6.0)
                                            && !ctx.out.ends_with(|c: char| c.is_whitespace())
                                            && !ctx.out.is_empty()
                                        {
                                            ctx.out.push(' ');
                                        }
                                    }
                                }
                                cur_x = Some(nx);
                                cur_y = Some(ny);
                            }
                        }
                        "T*" => {
                            if !ctx.out.ends_with('\n') && !ctx.out.is_empty() {
                                ctx.out.push('\n');
                            }
                        }
                        "Tj" => {
                            if let Some(ContentTok::Str(bytes)) = operands.last() {
                                emit_decoded_bytes(bytes, cur_font.as_ref(), ctx);
                            }
                        }
                        "'" => {
                            if !ctx.out.ends_with('\n') && !ctx.out.is_empty() {
                                ctx.out.push('\n');
                            }
                            if let Some(ContentTok::Str(bytes)) = operands.last() {
                                emit_decoded_bytes(bytes, cur_font.as_ref(), ctx);
                            }
                        }
                        "\"" => {
                            if !ctx.out.ends_with('\n') && !ctx.out.is_empty() {
                                ctx.out.push('\n');
                            }
                            if let Some(ContentTok::Str(bytes)) = operands.last() {
                                emit_decoded_bytes(bytes, cur_font.as_ref(), ctx);
                            }
                        }
                        "TJ" => {
                            if let Some(ContentTok::Array(items)) = operands.last() {
                                for item in items {
                                    match item {
                                        ContentTok::Str(bytes) => {
                                            emit_decoded_bytes(bytes, cur_font.as_ref(), ctx);
                                        }
                                        ContentTok::Num(adj)
                                            if *adj <= -180.0
                                                && !ctx
                                                    .out
                                                    .ends_with(|c: char| c.is_whitespace())
                                                && !ctx.out.is_empty() =>
                                        {
                                            ctx.out.push(' ');
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        "Do" => {
                            if let Some(xname) = operands.last().and_then(|t| t.as_name()) {
                                if let Some(xobj_ref) = xobjects.get(xname).cloned() {
                                    if let Some(PdfObj::Stream(xdict, xraw)) =
                                        self.resolve(&xobj_ref)
                                    {
                                        match xdict.get("Subtype").and_then(|o| o.as_name()) {
                                            Some("Image") => {
                                                ctx.image_count += 1;
                                            }
                                            Some("Form")
                                                if ctx.form_invocations < MAX_FORM_INVOCATIONS
                                                    && ctx.work_budget > 0 =>
                                            {
                                                ctx.form_invocations += 1;
                                                let (sub_fonts, sub_xobjs) = self.merge_resources(
                                                    &xdict,
                                                    fonts.clone(),
                                                    xobjects.clone(),
                                                );
                                                if let Ok(sub_bytes) =
                                                    decode_stream_bytes(&xdict, &xraw)
                                                {
                                                    self.interpret_content_stream(
                                                        &sub_bytes,
                                                        &sub_fonts,
                                                        &sub_xobjs,
                                                        depth + 1,
                                                        ctx,
                                                    );
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                        }
                        "INLINE_IMAGE" => {
                            ctx.image_count += 1;
                        }
                        _ => {}
                    }
                    operands.clear();
                }
                other => operands.push(other.clone()),
            }
            i += 1;
        }
        pdf_trace!(
            "interp done depth={depth} tokens={} out={}",
            tokens.len(),
            ctx.out.len()
        );
    }
}

struct PageExtractCtx {
    out: String,
    image_count: u64,
    unmapped_glyph_ops: u64,
    work_budget: usize,
    form_invocations: usize,
}

impl Default for PageExtractCtx {
    fn default() -> Self {
        Self {
            out: String::new(),
            image_count: 0,
            unmapped_glyph_ops: 0,
            work_budget: MAX_PAGE_INTERPRET_BYTES,
            form_invocations: 0,
        }
    }
}

impl PageExtractCtx {
    fn push_text(&mut self, text: &str) {
        let remaining = MAX_PAGE_TEXT_ACCUM.saturating_sub(self.out.len());
        if remaining == 0 {
            return;
        }
        if text.len() <= remaining {
            self.out.push_str(text);
        } else {
            let mut end = remaining;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            self.out.push_str(&text[..end]);
        }
    }

    fn push_char(&mut self, ch: char) {
        if self.out.len() + ch.len_utf8() <= MAX_PAGE_TEXT_ACCUM {
            self.out.push(ch);
        }
    }
}

impl Default for FontDecoder {
    fn default() -> Self {
        Self {
            to_unicode: HashMap::new(),
            has_to_unicode: false,
            code_lengths: Vec::new(),
            is_cid: false,
            is_type3: false,
            base_encoding: FontBaseEncoding::WinAnsi,
            differences: HashMap::new(),
        }
    }
}

fn emit_decoded_bytes(bytes: &[u8], font: Option<&FontDecoder>, ctx: &mut PageExtractCtx) {
    if bytes.is_empty() {
        return;
    }
    if bytes.starts_with(&[0xFE, 0xFF]) && bytes.len() >= 4 {
        let text = decode_utf16_be(&bytes[2..]);
        ctx.push_text(&text);
        return;
    }

    let Some(font) = font else {
        for &b in bytes {
            ctx.push_char(winansi_byte_to_char(b));
        }
        return;
    };

    if font.has_to_unicode {
        let decoded = font.decode_with_tounicode(bytes);
        if decoded.is_empty() && !bytes.is_empty() {
            ctx.unmapped_glyph_ops += 1;
        } else {
            ctx.push_text(&decoded);
        }
        return;
    }

    if font.is_cid || font.is_type3 {
        ctx.unmapped_glyph_ops += 1;
        return;
    }

    for &b in bytes {
        if let Some(&ch) = font.differences.get(&b) {
            ctx.push_char(ch);
        } else {
            let ch = match font.base_encoding {
                FontBaseEncoding::MacRoman => macroman_byte_to_char(b),
                FontBaseEncoding::Standard | FontBaseEncoding::WinAnsi => winansi_byte_to_char(b),
                FontBaseEncoding::Identity => winansi_byte_to_char(b),
            };
            ctx.push_char(ch);
        }
    }
}

impl FontDecoder {
    fn decode_with_tounicode(&self, bytes: &[u8]) -> String {
        let mut out = String::new();
        let mut i = 0usize;
        let prefer_two = self.is_cid || self.code_lengths.contains(&2);
        while i < bytes.len() {
            let mut matched = false;
            if prefer_two && i + 1 < bytes.len() {
                let code = u32::from_be_bytes([0, 0, bytes[i], bytes[i + 1]]);
                if let Some(s) = self.to_unicode.get(&(2, code)) {
                    out.push_str(s);
                    i += 2;
                    matched = true;
                }
            }
            if !matched {
                let code1 = bytes[i] as u32;
                if let Some(s) = self.to_unicode.get(&(1, code1)) {
                    out.push_str(s);
                    i += 1;
                    matched = true;
                }
            }
            if !matched && !prefer_two && i + 1 < bytes.len() {
                let code = u32::from_be_bytes([0, 0, bytes[i], bytes[i + 1]]);
                if let Some(s) = self.to_unicode.get(&(2, code)) {
                    out.push_str(s);
                    i += 2;
                    matched = true;
                }
            }
            if !matched {
                if prefer_two && i + 1 < bytes.len() {
                    i += 2;
                } else {
                    let b = bytes[i];
                    if (0x20..=0x7E).contains(&b) {
                        out.push(b as char);
                    }
                    i += 1;
                }
            }
        }
        out
    }
}

struct ParsedCMap {
    map: HashMap<(u8, u32), String>,
    code_lengths: Vec<u8>,
}

fn parse_tounicode_cmap(bytes: &[u8]) -> ParsedCMap {
    let mut map = HashMap::new();
    let mut code_lengths = Vec::new();
    let toks = tokenize_cmap(bytes);
    let mut i = 0usize;
    while i < toks.len() {
        match toks[i].as_str() {
            "begincodespacerange" => {
                i += 1;
                while i + 1 < toks.len() && toks[i] != "endcodespacerange" {
                    if let Some((len, _)) = parse_hex_tok(&toks[i]) {
                        if !code_lengths.contains(&len) {
                            code_lengths.push(len);
                        }
                    }
                    i += 2;
                }
            }
            "beginbfchar" => {
                i += 1;
                while i + 1 < toks.len() && toks[i] != "endbfchar" {
                    if let (Some((src_len, src_code)), Some(dst)) =
                        (parse_hex_tok(&toks[i]), parse_hex_bytes(&toks[i + 1]))
                    {
                        let text = decode_utf16_be(&dst);
                        if !text.is_empty() {
                            map.insert((src_len, src_code), text);
                        }
                    }
                    i += 2;
                }
            }
            "beginbfrange" => {
                i += 1;
                while i + 2 < toks.len() && toks[i] != "endbfrange" {
                    let start_tok = &toks[i];
                    let end_tok = &toks[i + 1];
                    if let (Some((src_len, start_code)), Some((_, end_code))) =
                        (parse_hex_tok(start_tok), parse_hex_tok(end_tok))
                    {
                        if toks[i + 2] == "[" {
                            let mut j = i + 3;
                            let mut offset = 0u32;
                            while j < toks.len() && toks[j] != "]" {
                                let code = start_code.saturating_add(offset);
                                if code <= end_code {
                                    if let Some(dst) = parse_hex_bytes(&toks[j]) {
                                        let text = decode_utf16_be(&dst);
                                        if !text.is_empty() {
                                            map.insert((src_len, code), text);
                                        }
                                    }
                                }
                                offset += 1;
                                j += 1;
                            }
                            i = j + 1;
                            continue;
                        } else if let Some(dst_bytes) = parse_hex_bytes(&toks[i + 2]) {
                            let span = end_code.saturating_sub(start_code).min(65535);
                            if !dst_bytes.is_empty() {
                                let base_u32 = read_be_u64(&dst_bytes) as u32;
                                for step in 0..=span {
                                    let code = start_code.saturating_add(step);
                                    let dst_val = base_u32.saturating_add(step);
                                    let text = if dst_bytes.len() <= 2 {
                                        char::from_u32(dst_val)
                                            .map(|c| c.to_string())
                                            .unwrap_or_default()
                                    } else {
                                        let mut buf = dst_bytes.clone();
                                        let len = buf.len();
                                        let last_u16 =
                                            u16::from_be_bytes([buf[len - 2], buf[len - 1]])
                                                .wrapping_add(step as u16);
                                        let bytes_be = last_u16.to_be_bytes();
                                        buf[len - 2] = bytes_be[0];
                                        buf[len - 1] = bytes_be[1];
                                        decode_utf16_be(&buf)
                                    };
                                    if !text.is_empty() {
                                        map.insert((src_len, code), text);
                                    }
                                }
                            }
                            i += 3;
                            continue;
                        }
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    ParsedCMap { map, code_lengths }
}

fn tokenize_cmap(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if out.len() >= MAX_CMAP_TOKENS {
            break;
        }
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b == b'%' {
            while i < bytes.len() && bytes[i] != b'\n' && bytes[i] != b'\r' {
                i += 1;
            }
            continue;
        }
        if b == b'<' {
            let start = i;
            i += 1;
            while i < bytes.len() && bytes[i] != b'>' {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            out.push(String::from_utf8_lossy(&bytes[start..i]).into_owned());
            continue;
        }
        if b == b'>' {
            i += 1;
            continue;
        }
        if b == b'[' || b == b']' {
            out.push((b as char).to_string());
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && !matches!(bytes[i], b'<' | b'>' | b'[' | b']' | b'%')
        {
            i += 1;
        }
        if i == start {
            i += 1;
            continue;
        }
        out.push(String::from_utf8_lossy(&bytes[start..i]).into_owned());
    }
    out
}

fn parse_hex_bytes(tok: &str) -> Option<Vec<u8>> {
    let inner = tok.strip_prefix('<')?.strip_suffix('>')?;
    let hex: Vec<u8> = inner.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if hex.is_empty() {
        return None;
    }
    let mut padded = hex;
    if padded.len() % 2 == 1 {
        padded.push(b'0');
    }
    let mut out = Vec::with_capacity(padded.len() / 2);
    for pair in padded.as_chunks::<2>().0 {
        let hi = hex_nibble(pair[0])?;
        let lo = hex_nibble(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn parse_hex_tok(tok: &str) -> Option<(u8, u32)> {
    let bytes = parse_hex_bytes(tok)?;
    if bytes.is_empty() || bytes.len() > 4 {
        return None;
    }
    let val = read_be_u64(&bytes) as u32;
    Some((bytes.len() as u8, val))
}

fn decode_utf16_be(bytes: &[u8]) -> String {
    let mut units = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.as_chunks::<2>().0 {
        units.push(u16::from_be_bytes([pair[0], pair[1]]));
    }
    if units.is_empty() && bytes.len() == 1 {
        return winansi_byte_to_char(bytes[0]).to_string();
    }
    String::from_utf16_lossy(&units)
}

fn decode_stream_bytes(dict: &BTreeMap<String, PdfObj>, raw: &[u8]) -> Result<Vec<u8>, String> {
    let filters: Vec<String> = match dict.get("Filter") {
        None => Vec::new(),
        Some(PdfObj::Name(n)) => vec![n.clone()],
        Some(PdfObj::Array(arr)) => arr
            .iter()
            .filter_map(|o| o.as_name().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };

    let mut data = raw.to_vec();
    for (idx, filter) in filters.iter().enumerate() {
        match filter.as_str() {
            "FlateDecode" | "Fl" => {
                data = flate_decompress_capped(&data)?;
                let params = match dict.get("DecodeParms") {
                    Some(PdfObj::Dict(d)) => Some(d),
                    Some(PdfObj::Array(arr)) => arr.get(idx).and_then(|o| o.as_dict()),
                    _ => None,
                };
                if let Some(pdict) = params {
                    data = apply_predictor(pdict, data);
                }
            }
            "ASCIIHexDecode" | "AHx" => {
                data = ascii_hex_decode(&data);
            }
            "ASCII85Decode" | "A85" => {
                data = ascii85_decode(&data);
            }
            _ => {
                return Err(format!("不支持的 PDF 流过滤器：{filter}"));
            }
        }
    }
    Ok(data)
}

fn flate_decompress_capped(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut zlib = ZlibDecoder::new(input);
    let mut limited = (&mut zlib).take((MAX_STREAM_DECODE_BYTES + 1) as u64);
    if limited.read_to_end(&mut out).is_ok() && !out.is_empty() {
        if out.len() > MAX_STREAM_DECODE_BYTES {
            out.truncate(MAX_STREAM_DECODE_BYTES);
        }
        return Ok(out);
    }

    out.clear();
    let mut raw_deflate = DeflateDecoder::new(input);
    let mut limited_raw = (&mut raw_deflate).take((MAX_STREAM_DECODE_BYTES + 1) as u64);
    limited_raw
        .read_to_end(&mut out)
        .map_err(|e| format!("Flate 解压失败：{e}"))?;
    if out.len() > MAX_STREAM_DECODE_BYTES {
        out.truncate(MAX_STREAM_DECODE_BYTES);
    }
    Ok(out)
}

fn apply_predictor(params: &BTreeMap<String, PdfObj>, data: Vec<u8>) -> Vec<u8> {
    let predictor = params
        .get("Predictor")
        .and_then(|o| o.as_int())
        .unwrap_or(1);
    if predictor < 10 {
        return data;
    }
    let columns = params
        .get("Columns")
        .and_then(|o| o.as_int())
        .unwrap_or(1)
        .max(1) as usize;
    let colors = params
        .get("Colors")
        .and_then(|o| o.as_int())
        .unwrap_or(1)
        .clamp(1, 16) as usize;
    let bpc = params
        .get("BitsPerComponent")
        .and_then(|o| o.as_int())
        .unwrap_or(8)
        .clamp(1, 16) as usize;
    let bpp = (colors * bpc).div_ceil(8).max(1);
    let row_bytes = (columns * colors * bpc).div_ceil(8).max(1);
    let stride = 1 + row_bytes;
    if data.len() < stride {
        return data;
    }

    let mut out = Vec::with_capacity((data.len() / stride) * row_bytes);
    let mut prev = vec![0u8; row_bytes];
    for row in data.chunks_exact(stride) {
        let filter = row[0];
        let src = &row[1..];
        let mut cur = vec![0u8; row_bytes];
        for i in 0..row_bytes {
            let left = if i >= bpp { cur[i - bpp] } else { 0 };
            let up = prev[i];
            let up_left = if i >= bpp { prev[i - bpp] } else { 0 };
            let recon = match filter {
                0 => src[i],
                1 => src[i].wrapping_add(left),
                2 => src[i].wrapping_add(up),
                3 => src[i].wrapping_add((((left as u16) + (up as u16)) / 2) as u8),
                4 => src[i].wrapping_add(paeth_predictor(left, up, up_left)),
                _ => src[i],
            };
            cur[i] = recon;
        }
        out.extend_from_slice(&cur);
        prev = cur;
    }
    out
}

fn paeth_predictor(a: u8, b: u8, c: u8) -> u8 {
    let a = a as i32;
    let b = b as i32;
    let c = c as i32;
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

fn ascii_hex_decode(input: &[u8]) -> Vec<u8> {
    let mut hex = Vec::new();
    for &b in input {
        if b == b'>' {
            break;
        }
        if !b.is_ascii_whitespace() {
            hex.push(b);
        }
    }
    if hex.len() % 2 == 1 {
        hex.push(b'0');
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_chunks::<2>().0 {
        if let (Some(h), Some(l)) = (hex_nibble(pair[0]), hex_nibble(pair[1])) {
            out.push((h << 4) | l);
        }
    }
    out
}

fn ascii85_decode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut group = [0u32; 5];
    let mut count = 0usize;
    let mut i = 0usize;
    if input.starts_with(b"<~") {
        i = 2;
    }
    while i < input.len() {
        let b = input[i];
        i += 1;
        if b == b'~' && input.get(i) == Some(&b'>') {
            break;
        }
        if b.is_ascii_whitespace() {
            continue;
        }
        if b == b'z' && count == 0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if (b'!'..=b'u').contains(&b) {
            group[count] = (b - b'!') as u32;
            count += 1;
            if count == 5 {
                let mut v = 0u64;
                for &g in &group {
                    v = v * 85 + g as u64;
                }
                out.extend_from_slice(&(v as u32).to_be_bytes());
                count = 0;
            }
        }
    }
    if count > 1 {
        for slot in group.iter_mut().skip(count) {
            *slot = 84;
        }
        let mut v = 0u64;
        for &g in &group {
            v = v * 85 + g as u64;
        }
        let bytes = (v as u32).to_be_bytes();
        out.extend_from_slice(&bytes[..count - 1]);
    }
    out
}

fn parse_value(bytes: &[u8], pos: usize, _depth_marker: Option<usize>) -> Option<(PdfObj, usize)> {
    parse_value_depth(bytes, pos, 0)
}

fn parse_value_depth(bytes: &[u8], mut pos: usize, depth: usize) -> Option<(PdfObj, usize)> {
    if depth > 64 {
        return None;
    }
    pos = skip_ws(bytes, pos);
    let b = *bytes.get(pos)?;
    if b == b'<' && bytes.get(pos + 1) == Some(&b'<') {
        pos += 2;
        let mut dict = BTreeMap::new();
        loop {
            pos = skip_ws(bytes, pos);
            if pos >= bytes.len() {
                break;
            }
            if bytes[pos..].starts_with(b">>") {
                pos += 2;
                break;
            }
            let (key_obj, after_key) = parse_value_depth(bytes, pos, depth + 1)?;
            let Some(key) = key_obj.as_name().map(str::to_owned) else {
                pos = after_key;
                continue;
            };
            let (val_obj, after_val) = parse_value_depth(bytes, after_key, depth + 1)?;
            dict.insert(key, val_obj);
            pos = after_val;
        }
        return Some((PdfObj::Dict(dict), pos));
    }

    if b == b'[' {
        pos += 1;
        let mut arr = Vec::new();
        loop {
            pos = skip_ws(bytes, pos);
            if pos >= bytes.len() {
                break;
            }
            if bytes[pos] == b']' {
                pos += 1;
                break;
            }
            let (item, next_pos) = parse_value_depth(bytes, pos, depth + 1)?;
            arr.push(item);
            pos = next_pos;
        }
        return Some((PdfObj::Array(arr), pos));
    }

    if b == b'/' {
        let (name, next_pos) = parse_name_token(bytes, pos);
        return Some((PdfObj::Name(name), next_pos));
    }

    if b == b'(' {
        let (lit, next_pos) = parse_literal_string(bytes, pos);
        return Some((PdfObj::Str(lit), next_pos));
    }

    if b == b'<' {
        let (hex_bytes, next_pos) = parse_hex_string(bytes, pos);
        return Some((PdfObj::Str(hex_bytes), next_pos));
    }

    if b == b't'
        && bytes[pos..].starts_with(b"true")
        && is_pdf_delim_or_ws(bytes.get(pos + 4).copied())
    {
        return Some((PdfObj::Bool(true), pos + 4));
    }
    if b == b'f'
        && bytes[pos..].starts_with(b"false")
        && is_pdf_delim_or_ws(bytes.get(pos + 5).copied())
    {
        return Some((PdfObj::Bool(false), pos + 5));
    }
    if b == b'n'
        && bytes[pos..].starts_with(b"null")
        && is_pdf_delim_or_ws(bytes.get(pos + 4).copied())
    {
        return Some((PdfObj::Null, pos + 4));
    }

    let start = pos;
    while pos < bytes.len() && !is_pdf_delim_or_ws(Some(bytes[pos])) {
        pos += 1;
    }
    let word = std::str::from_utf8(&bytes[start..pos]).ok()?;
    if let Ok(n) = word.parse::<i64>() {
        let p1 = skip_ws(bytes, pos);
        if n >= 0 {
            if let Some((gen_num, p2)) = parse_uint_token(bytes, p1) {
                let p3 = skip_ws(bytes, p2);
                if bytes.get(p3) == Some(&b'R') && is_pdf_delim_or_ws(bytes.get(p3 + 1).copied()) {
                    return Some((PdfObj::Ref(n as u32, gen_num as u16), p3 + 1));
                }
            }
        }
        return Some((PdfObj::Int(n), pos));
    }
    if let Ok(f) = word.parse::<f64>() {
        return Some((PdfObj::Real(f), pos));
    }
    Some((PdfObj::Name(word.to_owned()), pos))
}

#[derive(Debug, Clone)]
enum ContentTok {
    Str(Vec<u8>),
    Name(String),
    Num(f64),
    Array(Vec<ContentTok>),
    Op(String),
}

impl ContentTok {
    fn as_num(&self) -> Option<f64> {
        match self {
            ContentTok::Num(n) => Some(*n),
            _ => None,
        }
    }

    fn as_name(&self) -> Option<&str> {
        match self {
            ContentTok::Name(n) => Some(n.as_str()),
            _ => None,
        }
    }
}

fn tokenize_content_stream(bytes: &[u8]) -> Vec<ContentTok> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        if out.len() >= MAX_CONTENT_TOKENS {
            break;
        }
        pos = skip_ws(bytes, pos);
        if pos >= bytes.len() {
            break;
        }
        let b = bytes[pos];
        if b == b'(' {
            let (s, next) = parse_literal_string(bytes, pos);
            out.push(ContentTok::Str(s));
            pos = next;
        } else if b == b'<' {
            if bytes.get(pos + 1) == Some(&b'<') {
                let (_, next) = parse_value_depth(bytes, pos, 0).unwrap_or((PdfObj::Null, pos + 2));
                pos = next.max(pos + 2);
            } else {
                let (s, next) = parse_hex_string(bytes, pos);
                out.push(ContentTok::Str(s));
                pos = next;
            }
        } else if b == b'/' {
            let (name, next) = parse_name_token(bytes, pos);
            out.push(ContentTok::Name(name));
            pos = next;
        } else if b == b'[' {
            let (arr, next) = parse_content_array(bytes, pos);
            out.push(ContentTok::Array(arr));
            pos = next;
        } else if b == b']' || b == b'>' {
            pos += 1;
        } else {
            let start = pos;
            while pos < bytes.len() && !is_pdf_delim_or_ws(Some(bytes[pos])) {
                pos += 1;
            }
            let word = String::from_utf8_lossy(&bytes[start..pos]).into_owned();
            if word == "BI" {
                if let Some(id_rel) = find_subslice(&bytes[pos..], b"ID") {
                    let mut p = pos + id_rel + 2;
                    if p < bytes.len() && bytes[p].is_ascii_whitespace() {
                        p += 1;
                    }
                    if let Some(ei_pos) = find_inline_image_end(&bytes[p..]) {
                        out.push(ContentTok::Op("INLINE_IMAGE".to_owned()));
                        pos = p + ei_pos + 2;
                        continue;
                    }
                }
                out.push(ContentTok::Op("INLINE_IMAGE".to_owned()));
                pos = bytes.len();
                continue;
            }
            if let Ok(n) = word.parse::<f64>() {
                out.push(ContentTok::Num(n));
            } else if !word.is_empty() {
                out.push(ContentTok::Op(word));
            }
        }
    }
    out
}

fn parse_content_array(bytes: &[u8], mut pos: usize) -> (Vec<ContentTok>, usize) {
    pos += 1;
    let mut items = Vec::new();
    while pos < bytes.len() {
        pos = skip_ws(bytes, pos);
        if pos >= bytes.len() {
            break;
        }
        let b = bytes[pos];
        if b == b']' {
            pos += 1;
            break;
        } else if b == b'(' {
            let (s, next) = parse_literal_string(bytes, pos);
            items.push(ContentTok::Str(s));
            pos = next;
        } else if b == b'<' {
            let (s, next) = parse_hex_string(bytes, pos);
            items.push(ContentTok::Str(s));
            pos = next;
        } else if b == b'/' {
            let (n, next) = parse_name_token(bytes, pos);
            items.push(ContentTok::Name(n));
            pos = next;
        } else if b == b'[' {
            let (sub, next) = parse_content_array(bytes, pos);
            items.push(ContentTok::Array(sub));
            pos = next;
        } else {
            let start = pos;
            while pos < bytes.len() && !is_pdf_delim_or_ws(Some(bytes[pos])) {
                pos += 1;
            }
            let w = String::from_utf8_lossy(&bytes[start..pos]);
            if let Ok(n) = w.parse::<f64>() {
                items.push(ContentTok::Num(n));
            }
        }
    }
    (items, pos)
}

fn find_inline_image_end(bytes: &[u8]) -> Option<usize> {
    let mut i = 0usize;
    while i + 2 < bytes.len() {
        if bytes[i].is_ascii_whitespace()
            && bytes[i + 1] == b'E'
            && bytes[i + 2] == b'I'
            && bytes.get(i + 3).is_none_or(|b| b.is_ascii_whitespace())
        {
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

fn parse_literal_string(bytes: &[u8], mut pos: usize) -> (Vec<u8>, usize) {
    pos += 1;
    let mut out = Vec::new();
    let mut depth = 1usize;
    while pos < bytes.len() {
        let b = bytes[pos];
        pos += 1;
        if b == b'\\' {
            if pos >= bytes.len() {
                break;
            }
            let esc = bytes[pos];
            pos += 1;
            match esc {
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'b' => out.push(0x08),
                b'f' => out.push(0x0C),
                b'(' => out.push(b'('),
                b')' => out.push(b')'),
                b'\\' => out.push(b'\\'),
                b'\r' => {
                    if bytes.get(pos) == Some(&b'\n') {
                        pos += 1;
                    }
                }
                b'\n' => {}
                b'0'..=b'7' => {
                    let mut val = (esc - b'0') as u16;
                    for _ in 0..2 {
                        if let Some(&d) = bytes.get(pos) {
                            if (b'0'..=b'7').contains(&d) {
                                val = val * 8 + (d - b'0') as u16;
                                pos += 1;
                                continue;
                            }
                        }
                        break;
                    }
                    out.push((val & 0xFF) as u8);
                }
                other => out.push(other),
            }
        } else if b == b'(' {
            depth += 1;
            out.push(b'(');
        } else if b == b')' {
            depth -= 1;
            if depth == 0 {
                break;
            }
            out.push(b')');
        } else {
            out.push(b);
        }
    }
    (out, pos)
}

fn parse_hex_string(bytes: &[u8], mut pos: usize) -> (Vec<u8>, usize) {
    pos += 1;
    let mut hex = Vec::new();
    while pos < bytes.len() {
        let b = bytes[pos];
        pos += 1;
        if b == b'>' {
            break;
        }
        if !b.is_ascii_whitespace() {
            hex.push(b);
        }
    }
    if hex.len() % 2 == 1 {
        hex.push(b'0');
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_chunks::<2>().0 {
        if let (Some(h), Some(l)) = (hex_nibble(pair[0]), hex_nibble(pair[1])) {
            out.push((h << 4) | l);
        }
    }
    (out, pos)
}

fn parse_name_token(bytes: &[u8], mut pos: usize) -> (String, usize) {
    pos += 1;
    let mut raw = Vec::new();
    while pos < bytes.len() && !is_pdf_delim_or_ws(Some(bytes[pos])) {
        if bytes[pos] == b'#' && pos + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_nibble(bytes[pos + 1]), hex_nibble(bytes[pos + 2])) {
                raw.push((h << 4) | l);
                pos += 3;
                continue;
            }
        }
        raw.push(bytes[pos]);
        pos += 1;
    }
    (String::from_utf8_lossy(&raw).into_owned(), pos)
}

fn find_pdf_header(bytes: &[u8]) -> Option<usize> {
    let limit = bytes.len().min(1024);
    find_subslice(&bytes[..limit], b"%PDF-")
}

fn find_startxref(bytes: &[u8]) -> Option<usize> {
    let tail_start = bytes.len().saturating_sub(4096);
    let rel = rfind_subslice(&bytes[tail_start..], b"startxref")?;
    let pos = skip_ws(bytes, tail_start + rel + 9);
    let (off, _) = parse_uint_token(bytes, pos)?;
    Some(off as usize)
}

fn find_next_obj_header(bytes: &[u8], from: usize) -> Option<(u32, u16, usize)> {
    let mut pos = from;
    while pos < bytes.len() {
        let b = bytes[pos];
        if b.is_ascii_digit()
            && (pos == 0
                || bytes[pos - 1].is_ascii_whitespace()
                || is_pdf_delim_or_ws(Some(bytes[pos - 1])))
        {
            if let Some((obj_num, p1)) = parse_uint_token(bytes, pos) {
                if let Some((gen_num, p2)) = parse_uint_token(bytes, p1) {
                    let p3 = skip_ws(bytes, p2);
                    if bytes[p3..].starts_with(b"obj")
                        && is_pdf_delim_or_ws(bytes.get(p3 + 3).copied())
                    {
                        return Some((obj_num, gen_num as u16, pos));
                    }
                }
            }
        }
        pos += 1;
    }
    None
}

fn has_endstream_near(slice: &[u8]) -> bool {
    let probe = &slice[..slice.len().min(16)];
    let pos = skip_ws(probe, 0);
    probe[pos..].starts_with(b"endstream")
}

fn slice_until_endstream(bytes: &[u8]) -> &[u8] {
    if let Some(rel) = find_subslice(bytes, b"\r\nendstream") {
        return &bytes[..rel];
    }
    if let Some(rel) = find_subslice(bytes, b"\nendstream") {
        return &bytes[..rel];
    }
    if let Some(rel) = find_subslice(bytes, b"endstream") {
        return &bytes[..rel];
    }
    &[]
}

fn parse_xref_entry_line(line: &[u8]) -> Option<(usize, u8)> {
    let s = std::str::from_utf8(line).ok()?.trim();
    let mut parts = s.split_whitespace();
    let off = parts.next()?.parse::<usize>().ok()?;
    let _gen = parts.next()?.parse::<u16>().ok()?;
    let flag = parts.next()?.as_bytes().first().copied()?;
    Some((off, flag))
}

fn parse_uint_token(bytes: &[u8], mut pos: usize) -> Option<(u32, usize)> {
    pos = skip_ws(bytes, pos);
    let start = pos;
    while pos < bytes.len() && bytes[pos].is_ascii_digit() {
        pos += 1;
    }
    if pos == start {
        return None;
    }
    let n = std::str::from_utf8(&bytes[start..pos])
        .ok()?
        .parse::<u32>()
        .ok()?;
    Some((n, pos))
}

fn skip_ws(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() {
        let b = bytes[pos];
        if b.is_ascii_whitespace() || b == 0 {
            pos += 1;
        } else if b == b'%' {
            while pos < bytes.len() && bytes[pos] != b'\n' && bytes[pos] != b'\r' {
                pos += 1;
            }
        } else {
            break;
        }
    }
    pos
}

fn find_line_end(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() && bytes[pos] != b'\n' && bytes[pos] != b'\r' {
        pos += 1;
    }
    pos
}

fn skip_eol(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() && (bytes[pos] == b'\r' || bytes[pos] == b'\n') {
        pos += 1;
    }
    pos
}

fn is_pdf_delim_or_ws(b: Option<u8>) -> bool {
    let Some(b) = b else {
        return true;
    };
    b.is_ascii_whitespace()
        || b == 0
        || matches!(
            b,
            b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
        )
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn read_be_u64(bytes: &[u8]) -> u64 {
    let mut v = 0u64;
    for &b in bytes {
        v = (v << 8) | (b as u64);
    }
    v
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn rfind_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(haystack.len());
    }
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

fn normalize_extracted_text(raw: &str) -> String {
    let mut lines = Vec::new();
    for line in raw.lines() {
        let mut collapsed = String::new();
        let mut prev_space = false;
        for ch in line.chars() {
            if ch == '\u{0}' || (ch.is_control() && ch != '\t') {
                continue;
            }
            if ch.is_whitespace() {
                if !prev_space {
                    collapsed.push(' ');
                    prev_space = true;
                }
            } else {
                collapsed.push(ch);
                prev_space = false;
            }
        }
        let trimmed = collapsed.trim();
        if !trimmed.is_empty() {
            lines.push(trimmed.to_owned());
        }
    }
    lines.join("\n")
}

fn winansi_byte_to_char(b: u8) -> char {
    match b {
        0x80 => '\u{20AC}',
        0x82 => '\u{201A}',
        0x83 => '\u{0192}',
        0x84 => '\u{201E}',
        0x85 => '\u{2026}',
        0x86 => '\u{2020}',
        0x87 => '\u{2021}',
        0x88 => '\u{02C6}',
        0x89 => '\u{2030}',
        0x8A => '\u{0160}',
        0x8B => '\u{2039}',
        0x8C => '\u{0152}',
        0x8E => '\u{017D}',
        0x91 => '\u{2018}',
        0x92 => '\u{2019}',
        0x93 => '\u{201C}',
        0x94 => '\u{201D}',
        0x95 => '\u{2022}',
        0x96 => '\u{2013}',
        0x97 => '\u{2014}',
        0x98 => '\u{02DC}',
        0x99 => '\u{2122}',
        0x9A => '\u{0161}',
        0x9B => '\u{203A}',
        0x9C => '\u{0153}',
        0x9E => '\u{017E}',
        0x9F => '\u{0178}',
        0x00..=0x1F => {
            if b == b'\n' || b == b'\r' || b == b'\t' {
                b as char
            } else {
                ' '
            }
        }
        other => other as char,
    }
}

fn macroman_byte_to_char(b: u8) -> char {
    if b < 0x80 {
        return winansi_byte_to_char(b);
    }
    const MAC_UPPER: [char; 128] = [
        'Ä', 'Å', 'Ç', 'É', 'Ñ', 'Ö', 'Ü', 'á', 'à', 'â', 'ä', 'ã', 'å', 'ç', 'é', 'è', 'ê', 'ë',
        'í', 'ì', 'î', 'ï', 'ñ', 'ó', 'ò', 'ô', 'ö', 'õ', 'ú', 'ù', 'û', 'ü', '†', '°', '¢', '£',
        '§', '•', '¶', 'ß', '®', '©', '™', '´', '¨', '≠', 'Æ', 'Ø', '∞', '±', '≤', '≥', '¥', 'µ',
        '∂', '∑', '∏', 'π', '∫', 'ª', 'º', 'Ω', 'æ', 'ø', '¿', '¡', '¬', '√', 'ƒ', '≈', '∆', '«',
        '»', '…', '\u{00A0}', 'À', 'Ã', 'Õ', 'Œ', 'œ', '–', '—', '“', '”', '‘', '’', '÷', '◊', 'ÿ',
        'Ÿ', '⁄', '€', '‹', '›', 'ﬁ', 'ﬂ', '‡', '·', '‚', '„', '‰', 'Â', 'Ê', 'Á', 'Ë', 'È', 'Í',
        'Î', 'Ï', 'Ì', 'Ó', 'Ô', '\u{F8FF}', 'Ò', 'Ú', 'Û', 'Ù', 'ı', 'ˆ', '˜', '¯', '˘', '˙', '˚',
        '¸', '˝', '˛', 'ˇ',
    ];
    MAC_UPPER[(b - 0x80) as usize]
}

fn adobe_glyph_to_char(name: &str) -> Option<char> {
    if name.len() == 1 {
        return name.chars().next();
    }
    if let Some(hex) = name.strip_prefix("uni") {
        if hex.len() == 4 {
            if let Ok(cp) = u32::from_str_radix(hex, 16) {
                return char::from_u32(cp);
            }
        }
    }
    match name {
        "space" => Some(' '),
        "period" => Some('.'),
        "comma" => Some(','),
        "colon" => Some(':'),
        "semicolon" => Some(';'),
        "hyphen" | "minus" => Some('-'),
        "endash" => Some('–'),
        "emdash" => Some('—'),
        "slash" => Some('/'),
        "backslash" => Some('\\'),
        "parenleft" => Some('('),
        "parenright" => Some(')'),
        "bracketleft" => Some('['),
        "bracketright" => Some(']'),
        "braceleft" => Some('{'),
        "braceright" => Some('}'),
        "quotedbl" => Some('"'),
        "quotesingle" => Some('\''),
        "quoteleft" => Some('‘'),
        "quoteright" => Some('’'),
        "quotedblleft" => Some('“'),
        "quotedblright" => Some('”'),
        "bullet" => Some('•'),
        "percent" => Some('%'),
        "numbersign" => Some('#'),
        "dollar" => Some('$'),
        "ampersand" => Some('&'),
        "asterisk" => Some('*'),
        "plus" => Some('+'),
        "equal" => Some('='),
        "less" => Some('<'),
        "greater" => Some('>'),
        "question" => Some('?'),
        "exclam" => Some('!'),
        "at" => Some('@'),
        "underscore" => Some('_'),
        "zero" => Some('0'),
        "one" => Some('1'),
        "two" => Some('2'),
        "three" => Some('3'),
        "four" => Some('4'),
        "five" => Some('5'),
        "six" => Some('6'),
        "seven" => Some('7'),
        "eight" => Some('8'),
        "nine" => Some('9'),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    pub(crate) fn zlib_compress(data: &[u8]) -> Vec<u8> {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data).expect("zlib 压缩");
        enc.finish().expect("zlib 收尾")
    }

    pub(crate) fn build_test_pdf(pages_bodies: &[&[u8]], compressed: bool) -> Vec<u8> {
        let mut objects: Vec<Vec<u8>> = Vec::new();
        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        objects.push(Vec::new());
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());

        let mut kid_refs = Vec::new();
        for body in pages_bodies {
            let page_id = objects.len() + 1;
            let content_id = page_id + 1;
            kid_refs.push(format!("{page_id} 0 R"));
            objects.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
                )
                .into_bytes(),
            );
            if compressed {
                let z = zlib_compress(body);
                let mut stream =
                    format!("<< /Length {} /Filter /FlateDecode >>\nstream\n", z.len())
                        .into_bytes();
                stream.extend_from_slice(&z);
                stream.extend_from_slice(b"\nendstream");
                objects.push(stream);
            } else {
                let mut stream = format!("<< /Length {} >>\nstream\n", body.len()).into_bytes();
                stream.extend_from_slice(body);
                stream.extend_from_slice(b"\nendstream");
                objects.push(stream);
            }
        }
        objects[1] = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kid_refs.join(" "),
            pages_bodies.len()
        )
        .into_bytes();

        assemble_pdf(&objects)
    }

    fn assemble_pdf(objects: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"%PDF-1.4\n");
        let mut offsets = Vec::with_capacity(objects.len());
        for (idx, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", idx + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_off = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for off in offsets {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_off}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }

    #[test]
    fn multipage_compressed_pdf_keeps_exact_1_based_page_numbers() {
        let mut bodies: Vec<Vec<u8>> = Vec::new();
        for p in 1..=16 {
            if p == 2 {
                bodies.push(Vec::new());
            } else if p == 14 {
                bodies.push(
                    b"BT /F1 12 Tf 72 720 Td (Page 14 Spec: Freeze Window 30d) Tj ET".to_vec(),
                );
            } else {
                bodies
                    .push(format!("BT /F1 12 Tf 72 720 Td (Section Page {p}) Tj ET").into_bytes());
            }
        }
        let refs: Vec<&[u8]> = bodies.iter().map(|b| b.as_slice()).collect();
        let pdf = build_test_pdf(&refs, true);
        let rec = extract_pdf_from_bytes(&pdf);
        assert_eq!(rec.status, "page_indexed");
        assert_eq!(rec.page_count, 16);
        assert_eq!(rec.pages[1].page_number, 2);
        assert_eq!(rec.pages[1].page_kind, "empty");
        assert_eq!(rec.pages[13].page_number, 14);
        assert!(rec.pages[13]
            .extracted_text
            .contains("Page 14 Spec: Freeze Window 30d"));
    }

    #[test]
    fn tounicode_cmap_and_tj_kerning_extract_cjk_cleanly() {
        let cmap = br#"/CIDInit /ProcSet findresource begin
12 dict begin begincmap
1 begincodespacerange <0001> <00FF> endcodespacerange
3 beginbfchar
<0001> <89C2>
<0002> <6F9C>
<0003> <6D4B>
endbfchar
1 beginbfrange
<0010> <0011> <8BD56587>
endbfrange
endcmap"#;
        let mut objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>".to_vec(),
            b"<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 5 0 R >>".to_vec(),
        ];
        let z_cmap = zlib_compress(cmap);
        let mut cmap_stm = format!(
            "<< /Length {} /Filter /FlateDecode >>\nstream\n",
            z_cmap.len()
        )
        .into_bytes();
        cmap_stm.extend_from_slice(&z_cmap);
        cmap_stm.extend_from_slice(b"\nendstream");
        objects.push(cmap_stm);

        let content = b"BT /F1 12 Tf 72 720 Td [(<0001><0002>) -240 (<0003>)] TJ ET";
        let content_real = b"BT /F1 12 Tf 72 720 Td [<00010002> -240 <0003>] TJ ET";
        let _ = content;
        let z_body = zlib_compress(content_real);
        let mut body_stm = format!(
            "<< /Length {} /Filter /FlateDecode >>\nstream\n",
            z_body.len()
        )
        .into_bytes();
        body_stm.extend_from_slice(&z_body);
        body_stm.extend_from_slice(b"\nendstream");
        objects.push(body_stm);

        let pdf = assemble_pdf(&objects);
        let rec = extract_pdf_from_bytes(&pdf);
        assert_eq!(rec.status, "page_indexed");
        assert_eq!(rec.pages.len(), 1);
        assert!(rec.pages[0].extracted_text.contains("观澜 测"));
    }

    #[test]
    fn scanned_image_only_pdf_reports_honest_zero_false_positive() {
        let objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>".to_vec(),
            b"<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /Length 4 >>\nstream\n\x00\x00\x00\x00\nendstream".to_vec(),
            b"<< /Length 16 >>\nstream\nq 100 0 0 100 0 0 cm /Im1 Do Q\nendstream".to_vec(),
        ];

        let pdf = assemble_pdf(&objects);
        let rec = extract_pdf_from_bytes(&pdf);
        assert_eq!(rec.status, "image_only");
        assert_eq!(rec.page_count, 1);
        assert_eq!(rec.text_page_count, 0);
        assert_eq!(rec.image_only_page_count, 1);
        assert_eq!(rec.pages[0].page_kind, "image_only");
        assert_eq!(rec.pages[0].extracted_text, "");
        assert!(rec
            .error_reason
            .as_deref()
            .unwrap_or("")
            .contains("纯图像页，未做文本抽取"));
    }

    #[test]
    fn missing_tounicode_cid_font_reports_extract_failed_not_scanned() {
        let objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_vec(),
            b"<< /Type /Font /Subtype /Type0 /Encoding /Identity-H >>".to_vec(),
            b"<< /Length 38 >>\nstream\nBT /F1 12 Tf 72 720 Td <001A001B> Tj ET\nendstream".to_vec(),
        ];

        let pdf = assemble_pdf(&objects);
        let rec = extract_pdf_from_bytes(&pdf);
        assert_eq!(rec.status, "extract_failed");
        assert_eq!(rec.pages[0].page_kind, "extract_failed");
    }

    #[test]
    fn encrypted_and_corrupted_pdfs_degrade_gracefully() {
        let encrypted = b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Size 3 /Root 1 0 R /Encrypt 99 0 R >>\nstartxref\n0\n%%EOF";
        let rec_enc = extract_pdf_from_bytes(encrypted);
        assert_eq!(rec_enc.status, "encrypted");

        let rec_bad = extract_pdf_from_bytes(b"not a pdf at all!!!");
        assert_eq!(rec_bad.status, "corrupted");

        let rec_trunc = extract_pdf_from_bytes(b"%PDF-1.4\n1 0 obj << /Broken");
        assert_eq!(rec_trunc.status, "corrupted");
    }

    #[test]
    fn pdf15_xref_stream_and_objstm_with_png_predictor_work() {
        let obj1 = b"<< /Type /Catalog /Pages 2 0 R >>";
        let obj2 = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
        let objstm_header = b"3 0 ";
        let obj3_body = b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
        let first_off = objstm_header.len();
        let mut objstm_plain = Vec::new();
        objstm_plain.extend_from_slice(objstm_header);
        objstm_plain.extend_from_slice(obj3_body);
        let z_objstm = zlib_compress(&objstm_plain);

        let obj4 = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
        let obj5_body = b"BT /F1 12 Tf 72 720 Td (ObjStm Page 1 OK) Tj ET";

        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.5\n");

        let off1 = pdf.len();
        pdf.extend_from_slice(b"1 0 obj\n");
        pdf.extend_from_slice(obj1);
        pdf.extend_from_slice(b"\nendobj\n");

        let off2 = pdf.len();
        pdf.extend_from_slice(b"2 0 obj\n");
        pdf.extend_from_slice(obj2);
        pdf.extend_from_slice(b"\nendobj\n");

        let off4 = pdf.len();
        pdf.extend_from_slice(b"4 0 obj\n");
        pdf.extend_from_slice(obj4);
        pdf.extend_from_slice(b"\nendobj\n");

        let off5 = pdf.len();
        pdf.extend_from_slice(
            format!("5 0 obj\n<< /Length {} >>\nstream\n", obj5_body.len()).as_bytes(),
        );
        pdf.extend_from_slice(obj5_body);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");

        let off6 = pdf.len();
        pdf.extend_from_slice(
            format!(
                "6 0 obj\n<< /Type /ObjStm /N 1 /First {first_off} /Length {} /Filter /FlateDecode >>\nstream\n",
                z_objstm.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&z_objstm);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");

        let xref_off = pdf.len();
        let rows: [(u8, u32, u16); 8] = [
            (0, 0, 65535),
            (1, off1 as u32, 0),
            (1, off2 as u32, 0),
            (2, 6, 0),
            (1, off4 as u32, 0),
            (1, off5 as u32, 0),
            (1, off6 as u32, 0),
            (1, xref_off as u32, 0),
        ];
        let mut raw_xref = Vec::new();
        for (t, f1, f2) in rows {
            raw_xref.push(0);
            raw_xref.push(t);
            raw_xref.extend_from_slice(&f1.to_be_bytes());
            raw_xref.extend_from_slice(&f2.to_be_bytes());
        }
        let z_xref = zlib_compress(&raw_xref);
        pdf.extend_from_slice(
            format!(
                "7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length {} >>\nstream\n",
                z_xref.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&z_xref);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        pdf.extend_from_slice(format!("startxref\n{xref_off}\n%%EOF\n").as_bytes());

        let rec = extract_pdf_from_bytes(&pdf);
        assert_eq!(rec.status, "page_indexed");
        assert_eq!(rec.pages.len(), 1);
        assert!(rec.pages[0].extracted_text.contains("ObjStm Page 1 OK"));
    }

    #[test]
    fn stray_gt_in_cmap_terminates_tokenization() {
        let mut cmap = b"begincmap /CIDSystemInfo << /Registry (Adobe) >> 1 begincodespacerange <0000> <FFFF> endcodespacerange endcmap".to_vec();
        cmap.extend_from_slice(b"> >>>> trailing");
        let toks = tokenize_cmap(&cmap);
        assert!(
            toks.len() < 100,
            "游离 '>' 必须前进，实得 {} tokens",
            toks.len()
        );
        assert!(!toks.iter().any(|t| t.is_empty()));
    }

    #[test]
    fn inline_image_without_ei_terminates_tokenization() {
        let mut body =
            b"BT /F1 12 Tf 72 720 Td (Before) Tj ET BI /W 4 /H 4 /BPC 8 /CS /G ID ".to_vec();
        body.extend_from_slice(&[0u8; 64]);
        let toks = tokenize_content_stream(&body);
        assert!(
            toks.len() < 100,
            "畸形 BI 必须终止词法解析，实得 {} tokens",
            toks.len()
        );
        assert!(matches!(
            toks.last(),
            Some(ContentTok::Op(op)) if op == "INLINE_IMAGE"
        ));
    }

    #[test]
    fn page_text_accumulation_is_hard_capped() {
        let mut ctx = PageExtractCtx::default();
        ctx.push_text(&"x".repeat(MAX_PAGE_TEXT_ACCUM * 3));
        assert_eq!(ctx.out.len(), MAX_PAGE_TEXT_ACCUM);
        ctx.push_char('y');
        assert_eq!(ctx.out.len(), MAX_PAGE_TEXT_ACCUM);
        ctx.out.truncate(MAX_PAGE_TEXT_ACCUM - 1);
        ctx.push_text("拥抱");
        assert!(ctx.out.len() <= MAX_PAGE_TEXT_ACCUM);
        assert!(ctx.out.is_char_boundary(ctx.out.len()));
    }

    #[test]
    fn default_extract_budget_is_bounded() {
        let ctx = PageExtractCtx::default();
        assert_eq!(ctx.work_budget, MAX_PAGE_INTERPRET_BYTES);
        assert_eq!(ctx.form_invocations, 0);
        const { assert!(MAX_PAGE_INTERPRET_BYTES <= 16 * 1024 * 1024) };
    }
}
