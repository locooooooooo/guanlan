//! B03 · Office 核心交付物解析与证据锚定（`.docx` / `.xlsx` L2 接入）。
//!
//! 设计原则：
//!
//! 1. **永不崩溃唯一写线程**：所有 ZIP/XML 解析走边界校验 + 条目体积上限（防压缩炸弹）+ `std::panic::catch_unwind` 兜底；损坏、截断或加密文档一律优雅降级为 `corrupted` / `encrypted` / `metadata_only`；
//! 2. **内容寻址幂等**：提取结构按 `content_hash` 存入 `office_extracts`，同哈希跨路径 / A→B→A 回滚零重复解析；
//! 3. **精确证据锚点**：`.docx` 保留 1-based `para_index` 段落序号、大纲标题与批注关联；`.xlsx` 保留完整 `xl/workbook.xml` + `workbook.xml.rels` 工作表名、表头结构、数值列统计区间（`min / max / sum / cell_range`）与精确到 `Sheet!CellRef` 的单元格坐标。

use std::collections::HashMap;
use std::io::{Cursor, Read};

use flate2::read::DeflateDecoder;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

use crate::index::ident::stable_key;
use crate::index::writer::EXTRACT_RULE_VERSION;
use crate::storage::StatementRow;

/// 单个 XML 条目解压上限（16 MiB），防压缩炸弹撑爆内存
const MAX_XML_ENTRY_BYTES: usize = 16 * 1024 * 1024;
/// 单个归档最多允许扫描的条目数
const MAX_ZIP_ENTRIES: usize = 4096;
/// `.docx` 最多抽取的段落数
const MAX_DOCX_PARAGRAPHS: usize = 2000;
/// `.xlsx` 最多抽取的工作表数
const MAX_XLSX_SHEETS: usize = 24;
/// `.xlsx` 单表最多抽取的行数
const MAX_XLSX_ROWS_PER_SHEET: usize = 500;
/// `.xlsx` 单行最多抽取的列数
const MAX_XLSX_COLS_PER_ROW: usize = 64;
/// `.xlsx` 共享字符串表上限
const MAX_SHARED_STRINGS: usize = 100_000;
/// 提取纯文本总字符上限（供全文/摘要索引）
const MAX_PLAIN_TEXT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocxHeading {
    pub para_index: u64,
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocxParagraph {
    pub para_index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_level: Option<u8>,
    pub text: String,
    pub is_table_row: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocxComment {
    pub id: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub para_index: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DocxTrackedChanges {
    pub insertions: u64,
    pub deletions: u64,
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OfficeDocxData {
    pub headings: Vec<DocxHeading>,
    pub paragraphs: Vec<DocxParagraph>,
    pub comments: Vec<DocxComment>,
    pub tracked_changes: DocxTrackedChanges,
    pub total_paragraphs: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct XlsxNumericColSummary {
    pub col_letter: String,
    pub header: String,
    pub count: u64,
    pub min: f64,
    pub max: f64,
    pub sum: f64,
    pub cell_range: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct XlsxCell {
    pub ref_id: String,
    pub col_idx: u32,
    pub value: String,
    pub is_numeric: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct XlsxRow {
    pub row_num: u32,
    pub cells: Vec<XlsxCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct XlsxSheetData {
    pub name: String,
    pub index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimension_ref: Option<String>,
    pub headers: Vec<String>,
    pub row_count: u64,
    pub col_count: u32,
    pub numeric_summaries: Vec<XlsxNumericColSummary>,
    pub rows: Vec<XlsxRow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OfficeXlsxData {
    pub sheets: Vec<XlsxSheetData>,
    pub total_sheets: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OfficeExtractRecord {
    pub format: String,
    /// indexed | encrypted | corrupted | metadata_only
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docx: Option<OfficeDocxData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xlsx: Option<OfficeXlsxData>,
    pub plain_text: String,
}

impl OfficeExtractRecord {
    pub fn metadata_only(format: &str, reason: impl Into<String>) -> Self {
        Self {
            format: format.to_owned(),
            status: "metadata_only".to_owned(),
            error_reason: Some(reason.into()),
            docx: None,
            xlsx: None,
            plain_text: String::new(),
        }
    }

    pub fn degraded(format: &str, status: &str, reason: impl Into<String>) -> Self {
        Self {
            format: format.to_owned(),
            status: status.to_owned(),
            error_reason: Some(reason.into()),
            docx: None,
            xlsx: None,
            plain_text: String::new(),
        }
    }
}

/// Office 证据定位（精确到 `.xlsx` `Sheet!CellRange` 或 `.docx` 段落序号）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfficeEvidenceAnchor {
    /// xlsx_range | docx_paragraph
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    #[serde(rename = "cellRange", skip_serializing_if = "Option::is_none")]
    pub cell_range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
}

/// 解析 `.docx` / `.xlsx` 字节，带 panic 兜底与加密/损坏降级（绝不崩溃写线程）。
pub fn extract_office_from_bytes(format: &str, bytes: &[u8]) -> OfficeExtractRecord {
    let fmt = format.trim().to_ascii_lowercase();
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        extract_office_inner(&fmt, bytes)
    }));
    match res {
        Ok(record) => record,
        Err(_) => OfficeExtractRecord::degraded(
            &fmt,
            "corrupted",
            "Office 解析遇到异常结构，已安全降级为 L0 元数据卡",
        ),
    }
}

fn extract_office_inner(format: &str, bytes: &[u8]) -> OfficeExtractRecord {
    if bytes.len() < 4 {
        return OfficeExtractRecord::degraded(
            format,
            "corrupted",
            "文件长度过短，不是有效的 OOXML 归档",
        );
    }

    // OLE2 / CFB 魔数头（D0 CF 11 E0 A1 B1 1A E1）：可能是加密 OOXML 容器或旧版 .doc/.xls
    if bytes.len() >= 8 && bytes[0..8] == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] {
        return OfficeExtractRecord::degraded(
            format,
            "encrypted",
            "检测到受保护的复合文档容器（加密或旧版二进制格式），已降级为 L0 元数据卡",
        );
    }

    let entries = match read_zip_index(bytes) {
        Ok(list) => list,
        Err(msg) => return OfficeExtractRecord::degraded(format, "corrupted", msg),
    };

    if entries.iter().any(|e| {
        let lower = e.name.to_ascii_lowercase();
        lower == "encryptioninfo" || lower == "encryptedpackage"
    }) {
        return OfficeExtractRecord::degraded(
            format,
            "encrypted",
            "文档已启用密码/DRM 加密保护，无法抽取明文结构，已降级为 L0 元数据卡",
        );
    }

    let by_name: HashMap<String, &ZipEntry> = entries
        .iter()
        .map(|e| (e.name.trim_start_matches('/').to_owned(), e))
        .collect();

    match format {
        "docx" | "docm" | "dotx" => parse_docx(format, bytes, &by_name),
        "xlsx" | "xlsm" | "xltx" => parse_xlsx(format, bytes, &by_name),
        _ => OfficeExtractRecord::metadata_only(format, "该扩展名未启用 OOXML 结构化抽取"),
    }
}

// ============================================================
// 安全 ZIP 索引与 Deflate 解压器
// ============================================================

#[derive(Debug, Clone)]
struct ZipEntry {
    name: String,
    method: u16,
    compressed_size: usize,
    uncompressed_size: usize,
    local_header_offset: usize,
}

fn read_u16_le(buf: &[u8], off: usize) -> Option<u16> {
    let slice = buf.get(off..off + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(buf: &[u8], off: usize) -> Option<u32> {
    let slice = buf.get(off..off + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_zip_index(bytes: &[u8]) -> Result<Vec<ZipEntry>, String> {
    if bytes.len() < 22 {
        return Err("ZIP 归档不完整（文件头缺失）".to_owned());
    }
    let min_eocd = bytes.len().saturating_sub(65_557);
    let mut eocd_pos: Option<usize> = None;
    let mut pos = bytes.len() - 22;
    loop {
        if bytes.get(pos..pos + 4) == Some(&[0x50, 0x4B, 0x05, 0x06]) {
            eocd_pos = Some(pos);
            break;
        }
        if pos <= min_eocd {
            break;
        }
        pos -= 1;
    }

    let eocd = eocd_pos.ok_or_else(|| "未找到 ZIP 目录尾记录（文件可能已损坏）".to_owned())?;
    let total_entries =
        read_u16_le(bytes, eocd + 10).ok_or_else(|| "ZIP 目录计数越界".to_owned())? as usize;
    let cd_size =
        read_u32_le(bytes, eocd + 12).ok_or_else(|| "ZIP 中央目录长度越界".to_owned())? as usize;
    let cd_offset =
        read_u32_le(bytes, eocd + 16).ok_or_else(|| "ZIP 中央目录偏移越界".to_owned())? as usize;

    if total_entries > MAX_ZIP_ENTRIES {
        return Err(format!(
            "ZIP 条目数过多（{total_entries} > {MAX_ZIP_ENTRIES}）"
        ));
    }
    let cd_end = cd_offset
        .checked_add(cd_size)
        .ok_or_else(|| "ZIP 中央目录偏移溢出".to_owned())?;
    if cd_end > bytes.len() {
        return Err("ZIP 中央目录超出文件边界（文件被截断）".to_owned());
    }

    let mut out = Vec::with_capacity(total_entries.min(256));
    let mut cur = cd_offset;
    for _ in 0..total_entries {
        if bytes.get(cur..cur + 4) != Some(&[0x50, 0x4B, 0x01, 0x02]) {
            return Err("ZIP 中央目录记录签名无效".to_owned());
        }
        let method = read_u16_le(bytes, cur + 10).ok_or_else(|| "ZIP 方法字段越界".to_owned())?;
        let compressed_size =
            read_u32_le(bytes, cur + 20).ok_or_else(|| "ZIP 压缩体积越界".to_owned())? as usize;
        let uncompressed_size =
            read_u32_le(bytes, cur + 24).ok_or_else(|| "ZIP 原文体积越界".to_owned())? as usize;
        let name_len =
            read_u16_le(bytes, cur + 28).ok_or_else(|| "ZIP 文件名长度越界".to_owned())? as usize;
        let extra_len =
            read_u16_le(bytes, cur + 30).ok_or_else(|| "ZIP 扩展区长度越界".to_owned())? as usize;
        let comment_len =
            read_u16_le(bytes, cur + 32).ok_or_else(|| "ZIP 注释长度越界".to_owned())? as usize;
        let local_header_offset =
            read_u32_le(bytes, cur + 42).ok_or_else(|| "ZIP 本地偏移越界".to_owned())? as usize;

        let name_start = cur + 46;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or_else(|| "ZIP 文件名偏移溢出".to_owned())?;
        let name_bytes = bytes
            .get(name_start..name_end)
            .ok_or_else(|| "ZIP 文件名截断".to_owned())?;
        let name = String::from_utf8_lossy(name_bytes).replace('\\', "/");

        out.push(ZipEntry {
            name,
            method,
            compressed_size,
            uncompressed_size,
            local_header_offset,
        });

        cur = name_end
            .checked_add(extra_len)
            .and_then(|v| v.checked_add(comment_len))
            .ok_or_else(|| "ZIP 目录步进溢出".to_owned())?;
    }

    Ok(out)
}

fn extract_zip_entry(bytes: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, String> {
    if entry.uncompressed_size > MAX_XML_ENTRY_BYTES {
        return Err(format!(
            "条目 {} 解压体积（{} B）超出安全上限",
            entry.name, entry.uncompressed_size
        ));
    }
    let off = entry.local_header_offset;
    if bytes.get(off..off + 4) != Some(&[0x50, 0x4B, 0x03, 0x04]) {
        return Err(format!("条目 {} 本地头签名无效", entry.name));
    }
    let fname_len =
        read_u16_le(bytes, off + 26).ok_or_else(|| "本地文件名长度越界".to_owned())? as usize;
    let extra_len =
        read_u16_le(bytes, off + 28).ok_or_else(|| "本地扩展区长度越界".to_owned())? as usize;
    let data_start = off
        .checked_add(30)
        .and_then(|v| v.checked_add(fname_len))
        .and_then(|v| v.checked_add(extra_len))
        .ok_or_else(|| "本地数据偏移溢出".to_owned())?;
    let data_end = data_start
        .checked_add(entry.compressed_size)
        .ok_or_else(|| "压缩数据长度溢出".to_owned())?;
    let payload = bytes
        .get(data_start..data_end)
        .ok_or_else(|| format!("条目 {} 数据区被截断", entry.name))?;

    match entry.method {
        0 => {
            if payload.len() > MAX_XML_ENTRY_BYTES {
                return Err(format!("条目 {} 体积超限", entry.name));
            }
            Ok(payload.to_vec())
        }
        8 => {
            let mut decoder =
                DeflateDecoder::new(Cursor::new(payload)).take((MAX_XML_ENTRY_BYTES + 1) as u64);
            let mut out = Vec::with_capacity(entry.uncompressed_size.min(65_536));
            decoder
                .read_to_end(&mut out)
                .map_err(|e| format!("解压 {} 失败：{e}", entry.name))?;
            if out.len() > MAX_XML_ENTRY_BYTES {
                return Err(format!("条目 {} 触发压缩炸弹上限保护", entry.name));
            }
            Ok(out)
        }
        other => Err(format!("不支持的 ZIP 压缩方式 {other}（{}）", entry.name)),
    }
}

fn read_entry_utf8(
    bytes: &[u8],
    by_name: &HashMap<String, &ZipEntry>,
    name: &str,
) -> Result<Option<String>, String> {
    let Some(entry) = by_name.get(name) else {
        return Ok(None);
    };
    let raw = extract_zip_entry(bytes, entry)?;
    Ok(Some(String::from_utf8_lossy(&raw).into_owned()))
}

// ============================================================
// .docx 解析器（标题、段落序号、表格、批注、修订痕迹）
// ============================================================

fn parse_docx(
    format: &str,
    bytes: &[u8],
    by_name: &HashMap<String, &ZipEntry>,
) -> OfficeExtractRecord {
    let doc_xml = match read_entry_utf8(bytes, by_name, "word/document.xml") {
        Ok(Some(xml)) => xml,
        Ok(None) => {
            return OfficeExtractRecord::degraded(
                format,
                "corrupted",
                "缺少 word/document.xml 主文档部件",
            );
        }
        Err(err) => return OfficeExtractRecord::degraded(format, "corrupted", err),
    };

    let comments_xml = read_entry_utf8(bytes, by_name, "word/comments.xml")
        .ok()
        .flatten();

    let mut headings: Vec<DocxHeading> = Vec::new();
    let mut paragraphs: Vec<DocxParagraph> = Vec::new();
    let mut tracked_changes = DocxTrackedChanges::default();
    let mut comment_para_map: HashMap<String, u64> = HashMap::new();
    let mut total_paragraphs: u64 = 0;
    let mut truncated = false;

    let mut reader = Reader::from_str(&doc_xml);
    reader.config_mut().trim_text(false);

    let mut in_paragraph = false;
    let mut table_depth: usize = 0;
    let mut table_row_cells: Vec<String> = Vec::new();
    let mut in_table_cell = false;
    let mut in_text = false;
    let mut in_ins_depth: usize = 0;
    let mut in_del_depth: usize = 0;
    let mut cur_style: Option<String> = None;
    let mut cur_text = String::new();
    let mut cur_cell_text = String::new();
    let mut cur_ins_buf = String::new();
    let mut cur_del_buf = String::new();
    let mut cur_para_comment_ids: Vec<String> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name_bytes = e.local_name();
                match name_bytes.as_ref() {
                    "tbl" => table_depth += 1,
                    "tr" if table_depth > 0 => table_row_cells.clear(),
                    "tc" if table_depth > 0 => {
                        in_table_cell = true;
                        cur_cell_text.clear();
                    }
                    "p" => {
                        in_paragraph = true;
                        cur_style = None;
                        cur_text.clear();
                        cur_para_comment_ids.clear();
                    }
                    "pStyle" if in_paragraph => {
                        if let Some(val) = attr_value(&e, "val") {
                            cur_style = Some(val);
                        }
                    }
                    "t" | "delText" => in_text = true,
                    "ins" => {
                        in_ins_depth += 1;
                        if in_ins_depth == 1 {
                            tracked_changes.insertions += 1;
                            cur_ins_buf.clear();
                        }
                    }
                    "del" => {
                        in_del_depth += 1;
                        if in_del_depth == 1 {
                            tracked_changes.deletions += 1;
                            cur_del_buf.clear();
                        }
                    }
                    "commentReference" if in_paragraph => {
                        if let Some(cid) = attr_value(&e, "id") {
                            cur_para_comment_ids.push(cid);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name_bytes = e.local_name();
                match name_bytes.as_ref() {
                    "pStyle" if in_paragraph => {
                        if let Some(val) = attr_value(&e, "val") {
                            cur_style = Some(val);
                        }
                    }
                    "tab" if in_paragraph => {
                        if in_table_cell {
                            cur_cell_text.push(' ');
                        } else if in_del_depth == 0 {
                            cur_text.push(' ');
                        }
                    }
                    "br" if in_paragraph => {
                        if in_table_cell {
                            cur_cell_text.push(' ');
                        } else if in_del_depth == 0 {
                            cur_text.push('\n');
                        }
                    }
                    "commentReference" if in_paragraph => {
                        if let Some(cid) = attr_value(&e, "id") {
                            cur_para_comment_ids.push(cid);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_text => {
                let s = decode_text_event(&t);
                if in_del_depth > 0 {
                    cur_del_buf.push_str(&s);
                } else {
                    if in_ins_depth > 0 {
                        cur_ins_buf.push_str(&s);
                    }
                    if in_table_cell {
                        cur_cell_text.push_str(&s);
                    } else if in_paragraph {
                        cur_text.push_str(&s);
                    }
                }
            }
            Ok(Event::GeneralRef(r)) if in_text => {
                if let Some(s) = decode_general_ref(&r) {
                    if in_del_depth > 0 {
                        cur_del_buf.push_str(&s);
                    } else {
                        if in_ins_depth > 0 {
                            cur_ins_buf.push_str(&s);
                        }
                        if in_table_cell {
                            cur_cell_text.push_str(&s);
                        } else if in_paragraph {
                            cur_text.push_str(&s);
                        }
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name_bytes = e.local_name();
                match name_bytes.as_ref() {
                    "t" | "delText" => in_text = false,
                    "ins" => {
                        if in_ins_depth == 1 {
                            let sample = cur_ins_buf.trim();
                            if !sample.is_empty() && tracked_changes.samples.len() < 12 {
                                tracked_changes
                                    .samples
                                    .push(format!("+ {}", truncate_utf8_chars(sample, 80)));
                            }
                        }
                        in_ins_depth = in_ins_depth.saturating_sub(1);
                    }
                    "del" => {
                        if in_del_depth == 1 {
                            let sample = cur_del_buf.trim();
                            if !sample.is_empty() && tracked_changes.samples.len() < 12 {
                                tracked_changes
                                    .samples
                                    .push(format!("- {}", truncate_utf8_chars(sample, 80)));
                            }
                        }
                        in_del_depth = in_del_depth.saturating_sub(1);
                    }
                    "p" if in_paragraph => {
                        in_paragraph = false;
                        if in_table_cell {
                            if !cur_cell_text.ends_with(' ') && !cur_cell_text.is_empty() {
                                cur_cell_text.push(' ');
                            }
                            for cid in cur_para_comment_ids.drain(..) {
                                comment_para_map.insert(cid, total_paragraphs + 1);
                            }
                        } else {
                            let trimmed = cur_text.trim();
                            if !trimmed.is_empty() {
                                total_paragraphs += 1;
                                let p_idx = total_paragraphs;
                                for cid in cur_para_comment_ids.drain(..) {
                                    comment_para_map.insert(cid, p_idx);
                                }
                                let heading_level =
                                    cur_style.as_deref().and_then(docx_heading_level);
                                if let Some(lvl) = heading_level {
                                    headings.push(DocxHeading {
                                        para_index: p_idx,
                                        level: lvl,
                                        text: trimmed.to_owned(),
                                    });
                                }
                                if paragraphs.len() < MAX_DOCX_PARAGRAPHS {
                                    paragraphs.push(DocxParagraph {
                                        para_index: p_idx,
                                        style: cur_style.take(),
                                        heading_level,
                                        text: trimmed.to_owned(),
                                        is_table_row: false,
                                    });
                                } else {
                                    truncated = true;
                                }
                            }
                        }
                    }
                    "tc" if in_table_cell => {
                        in_table_cell = false;
                        let cell_clean = cur_cell_text.trim().to_owned();
                        table_row_cells.push(cell_clean);
                    }
                    "tr" if table_depth > 0 => {
                        let row_line = table_row_cells
                            .iter()
                            .map(|c| c.as_str())
                            .collect::<Vec<_>>()
                            .join(" | ");
                        let trimmed = row_line.trim();
                        if !trimmed.is_empty()
                            && trimmed.chars().any(|c| c != '|' && !c.is_whitespace())
                        {
                            total_paragraphs += 1;
                            let p_idx = total_paragraphs;
                            if paragraphs.len() < MAX_DOCX_PARAGRAPHS {
                                paragraphs.push(DocxParagraph {
                                    para_index: p_idx,
                                    style: Some("TableRow".to_owned()),
                                    heading_level: None,
                                    text: trimmed.to_owned(),
                                    is_table_row: true,
                                });
                            } else {
                                truncated = true;
                            }
                        }
                        table_row_cells.clear();
                    }
                    "tbl" => table_depth = table_depth.saturating_sub(1),
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return OfficeExtractRecord::degraded(
                    format,
                    "corrupted",
                    format!("word/document.xml 解析失败：{e}"),
                );
            }
            _ => {}
        }
    }

    let comments = comments_xml
        .as_deref()
        .map(|xml| parse_docx_comments(xml, &comment_para_map))
        .unwrap_or_default();

    let mut plain = String::new();
    for p in &paragraphs {
        if plain.len() >= MAX_PLAIN_TEXT_BYTES {
            break;
        }
        if !plain.is_empty() {
            plain.push('\n');
        }
        plain.push_str(&p.text);
    }
    for c in &comments {
        if plain.len() >= MAX_PLAIN_TEXT_BYTES {
            break;
        }
        plain.push_str("\n[批注 ");
        plain.push_str(&c.author);
        plain.push_str("] ");
        plain.push_str(&c.text);
    }

    OfficeExtractRecord {
        format: format.to_owned(),
        status: "indexed".to_owned(),
        error_reason: None,
        docx: Some(OfficeDocxData {
            headings,
            paragraphs,
            comments,
            tracked_changes,
            total_paragraphs,
            truncated,
        }),
        xlsx: None,
        plain_text: truncate_utf8_chars(&plain, MAX_PLAIN_TEXT_BYTES),
    }
}

fn parse_docx_comments(xml: &str, para_map: &HashMap<String, u64>) -> Vec<DocxComment> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut cur_id = String::new();
    let mut cur_author = String::new();
    let mut cur_date: Option<String> = None;
    let mut cur_text = String::new();
    let mut in_comment = false;
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name();
                if ln.as_ref() == "comment" {
                    in_comment = true;
                    cur_id = attr_value(&e, "id").unwrap_or_default();
                    cur_author = attr_value(&e, "author").unwrap_or_else(|| "未知作者".to_owned());
                    cur_date = attr_value(&e, "date");
                    cur_text.clear();
                } else if ln.as_ref() == "t" && in_comment {
                    in_text = true;
                }
            }
            Ok(Event::Text(t)) if in_comment && in_text => {
                cur_text.push_str(&decode_text_event(&t));
            }
            Ok(Event::GeneralRef(r)) if in_comment && in_text => {
                if let Some(s) = decode_general_ref(&r) {
                    cur_text.push_str(&s);
                }
            }
            Ok(Event::End(e)) => {
                let ln = e.local_name();
                if ln.as_ref() == "t" {
                    in_text = false;
                } else if ln.as_ref() == "comment" && in_comment {
                    in_comment = false;
                    let text = cur_text.trim().to_owned();
                    if !text.is_empty() {
                        out.push(DocxComment {
                            para_index: para_map.get(&cur_id).copied(),
                            id: cur_id.clone(),
                            author: cur_author.clone(),
                            date: cur_date.take(),
                            text,
                        });
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

fn docx_heading_level(style: &str) -> Option<u8> {
    let lower = style.trim().to_ascii_lowercase();
    if lower == "title" {
        return Some(1);
    }
    if lower == "subtitle" {
        return Some(2);
    }
    if let Some(rest) = lower.strip_prefix("heading") {
        if let Ok(n) = rest.trim().parse::<u8>() {
            if (1..=6).contains(&n) {
                return Some(n);
            }
        }
    }
    if let Some(rest) = style.trim().strip_prefix("标题") {
        if let Ok(n) = rest.trim().parse::<u8>() {
            if (1..=6).contains(&n) {
                return Some(n);
            }
        }
    }
    if let Ok(n) = lower.parse::<u8>() {
        if (1..=6).contains(&n) {
            return Some(n);
        }
    }
    None
}

// ============================================================
// .xlsx 解析器（工作表、表头、数值列区间摘要、精确 Sheet!CellRange）
// ============================================================

fn parse_xlsx(
    format: &str,
    bytes: &[u8],
    by_name: &HashMap<String, &ZipEntry>,
) -> OfficeExtractRecord {
    let wb_xml = match read_entry_utf8(bytes, by_name, "xl/workbook.xml") {
        Ok(Some(xml)) => xml,
        Ok(None) => {
            return OfficeExtractRecord::degraded(
                format,
                "corrupted",
                "缺少 xl/workbook.xml 工作簿定义",
            );
        }
        Err(err) => return OfficeExtractRecord::degraded(format, "corrupted", err),
    };

    let rels_xml = read_entry_utf8(bytes, by_name, "xl/_rels/workbook.xml.rels")
        .ok()
        .flatten();
    let rels_map = rels_xml
        .as_deref()
        .map(parse_workbook_rels)
        .unwrap_or_default();

    let sheet_refs = match parse_workbook_sheets(&wb_xml, &rels_map) {
        Ok(list) => list,
        Err(err) => return OfficeExtractRecord::degraded(format, "corrupted", err),
    };

    let shared_strings = match read_entry_utf8(bytes, by_name, "xl/sharedStrings.xml") {
        Ok(Some(xml)) => parse_shared_strings(&xml),
        Ok(None) => Vec::new(),
        Err(err) => return OfficeExtractRecord::degraded(format, "corrupted", err),
    };

    let total_sheets = sheet_refs.len() as u64;
    let mut sheets = Vec::new();
    let mut wb_truncated = sheet_refs.len() > MAX_XLSX_SHEETS;

    for (idx, (sheet_name, target_path)) in sheet_refs.into_iter().take(MAX_XLSX_SHEETS).enumerate()
    {
        let resolved_path = target_path.or_else(|| {
            let candidate = format!("xl/worksheets/sheet{}.xml", idx + 1);
            by_name.contains_key(&candidate).then_some(candidate)
        });
        let Some(entry_path) = resolved_path else {
            continue;
        };
        let sheet_xml = match read_entry_utf8(bytes, by_name, &entry_path) {
            Ok(Some(xml)) => xml,
            Ok(None) => continue,
            Err(err) => return OfficeExtractRecord::degraded(format, "corrupted", err),
        };
        match parse_worksheet_xml(&sheet_name, (idx + 1) as u32, &sheet_xml, &shared_strings) {
            Ok(sheet) => {
                if sheet.truncated {
                    wb_truncated = true;
                }
                sheets.push(sheet);
            }
            Err(err) => return OfficeExtractRecord::degraded(format, "corrupted", err),
        }
    }

    let mut plain = String::new();
    for sheet in &sheets {
        if plain.len() >= MAX_PLAIN_TEXT_BYTES {
            break;
        }
        if !plain.is_empty() {
            plain.push('\n');
        }
        plain.push_str(&format!("[Sheet: {}]", sheet.name));
        if !sheet.headers.is_empty() {
            plain.push_str(&format!(" 表头: {}", sheet.headers.join(" | ")));
        }
        for ns in &sheet.numeric_summaries {
            plain.push_str(&format!(
                " · {}({}): {}..{}",
                ns.header, ns.cell_range, ns.min, ns.max
            ));
        }
        for row in &sheet.rows {
            if plain.len() >= MAX_PLAIN_TEXT_BYTES {
                break;
            }
            let row_vals: Vec<&str> = row.cells.iter().map(|c| c.value.as_str()).collect();
            if !row_vals.is_empty() {
                plain.push('\n');
                plain.push_str(&row_vals.join(" | "));
            }
        }
    }

    OfficeExtractRecord {
        format: format.to_owned(),
        status: "indexed".to_owned(),
        error_reason: None,
        docx: None,
        xlsx: Some(OfficeXlsxData {
            sheets,
            total_sheets,
            truncated: wb_truncated,
        }),
        plain_text: truncate_utf8_chars(&plain, MAX_PLAIN_TEXT_BYTES),
    }
}

fn parse_workbook_rels(xml: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == "Relationship" {
                    if let (Some(id), Some(target)) =
                        (attr_value(&e, "Id"), attr_value(&e, "Target"))
                    {
                        let normalized = target.trim_start_matches('/').trim_start_matches("./");
                        let full = if normalized.starts_with("xl/") {
                            normalized.to_owned()
                        } else {
                            format!("xl/{normalized}")
                        };
                        map.insert(id, full);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    map
}

fn parse_workbook_sheets(
    xml: &str,
    rels: &HashMap<String, String>,
) -> Result<Vec<(String, Option<String>)>, String> {
    let mut sheets = Vec::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == "sheet" {
                    let name = attr_value(&e, "name")
                        .unwrap_or_else(|| format!("Sheet{}", sheets.len() + 1));
                    let rid = attr_value(&e, "id");
                    let target = rid.and_then(|id| rels.get(&id).cloned());
                    sheets.push((name, target));
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xl/workbook.xml 解析失败：{e}")),
            _ => {}
        }
    }
    Ok(sheets)
}

fn parse_shared_strings(xml: &str) -> Vec<String> {
    let mut list = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut in_si = false;
    let mut in_t = false;
    let mut buf = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name();
                if ln.as_ref() == "si" {
                    in_si = true;
                    buf.clear();
                } else if ln.as_ref() == "t" && in_si {
                    in_t = true;
                }
            }
            Ok(Event::Text(t)) if in_si && in_t => {
                buf.push_str(&decode_text_event(&t));
            }
            Ok(Event::GeneralRef(r)) if in_si && in_t => {
                if let Some(s) = decode_general_ref(&r) {
                    buf.push_str(&s);
                }
            }
            Ok(Event::End(e)) => {
                let ln = e.local_name();
                if ln.as_ref() == "t" {
                    in_t = false;
                } else if ln.as_ref() == "si" && in_si {
                    in_si = false;
                    if list.len() < MAX_SHARED_STRINGS {
                        list.push(buf.clone());
                    } else {
                        break;
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    list
}

fn parse_worksheet_xml(
    sheet_name: &str,
    index: u32,
    xml: &str,
    shared_strings: &[String],
) -> Result<XlsxSheetData, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut dimension_ref: Option<String> = None;
    let mut rows: Vec<XlsxRow> = Vec::new();
    let mut total_rows: u64 = 0;
    let mut max_col: u32 = 0;
    let mut truncated = false;

    let mut in_row = false;
    let mut cur_row_num: u32 = 0;
    let mut cur_cells: Vec<XlsxCell> = Vec::new();

    let mut in_cell = false;
    let mut cur_cell_ref = String::new();
    let mut cur_cell_type = String::new();
    let mut cur_col_idx: u32 = 0;
    let mut in_v = false;
    let mut in_f = false;
    let mut in_is_t = false;
    let mut cur_v = String::new();
    let mut cur_f = String::new();
    let mut cur_is = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name();
                match ln.as_ref() {
                    "dimension" => {
                        if dimension_ref.is_none() {
                            dimension_ref = attr_value(&e, "ref");
                        }
                    }
                    "row" => {
                        in_row = true;
                        cur_row_num = attr_value(&e, "r")
                            .and_then(|v| v.parse::<u32>().ok())
                            .unwrap_or((total_rows + 1) as u32);
                        cur_cells.clear();
                    }
                    "c" if in_row => {
                        in_cell = true;
                        cur_cell_ref = attr_value(&e, "r").unwrap_or_default();
                        cur_cell_type = attr_value(&e, "t").unwrap_or_default();
                        cur_col_idx = parse_cell_ref(&cur_cell_ref)
                            .map(|(col, row)| {
                                if row > 0 {
                                    cur_row_num = row;
                                }
                                col
                            })
                            .unwrap_or((cur_cells.len() + 1) as u32);
                        cur_v.clear();
                        cur_f.clear();
                        cur_is.clear();
                    }
                    "v" if in_cell => in_v = true,
                    "f" if in_cell => in_f = true,
                    "t" if in_cell => in_is_t = true,
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == "dimension" && dimension_ref.is_none() {
                    dimension_ref = attr_value(&e, "ref");
                }
            }
            Ok(Event::Text(t)) if in_cell => {
                let s = decode_text_event(&t);
                if in_v {
                    cur_v.push_str(&s);
                } else if in_f {
                    cur_f.push_str(&s);
                } else if in_is_t {
                    cur_is.push_str(&s);
                }
            }
            Ok(Event::GeneralRef(r)) if in_cell => {
                if let Some(s) = decode_general_ref(&r) {
                    if in_v {
                        cur_v.push_str(&s);
                    } else if in_f {
                        cur_f.push_str(&s);
                    } else if in_is_t {
                        cur_is.push_str(&s);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let ln = e.local_name();
                match ln.as_ref() {
                    "v" => in_v = false,
                    "f" => in_f = false,
                    "t" => in_is_t = false,
                    "c" if in_cell => {
                        in_cell = false;
                        if cur_cells.len() < MAX_XLSX_COLS_PER_ROW {
                            let (value, is_numeric) = resolve_xlsx_cell_value(
                                &cur_cell_type,
                                &cur_v,
                                &cur_is,
                                shared_strings,
                            );
                            if !value.is_empty() || !cur_f.is_empty() {
                                let ref_id = if cur_cell_ref.is_empty() {
                                    format!("{}{}", col_index_to_letters(cur_col_idx), cur_row_num)
                                } else {
                                    cur_cell_ref.clone()
                                };
                                max_col = max_col.max(cur_col_idx);
                                cur_cells.push(XlsxCell {
                                    ref_id,
                                    col_idx: cur_col_idx,
                                    value,
                                    is_numeric,
                                    formula: (!cur_f.is_empty()).then(|| cur_f.clone()),
                                });
                            }
                        }
                    }
                    "row" if in_row => {
                        in_row = false;
                        if !cur_cells.is_empty() {
                            total_rows += 1;
                            if rows.len() < MAX_XLSX_ROWS_PER_SHEET {
                                rows.push(XlsxRow {
                                    row_num: cur_row_num,
                                    cells: std::mem::take(&mut cur_cells),
                                });
                            } else {
                                truncated = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("工作表 {sheet_name} XML 解析失败：{e}")),
            _ => {}
        }
    }

    let headers = extract_sheet_headers(&rows, max_col);
    let numeric_summaries = compute_numeric_summaries(&rows, &headers);
    if dimension_ref.is_none() && !rows.is_empty() && max_col > 0 {
        let first_row = rows.first().map(|r| r.row_num).unwrap_or(1);
        let last_row = rows.last().map(|r| r.row_num).unwrap_or(first_row);
        dimension_ref = Some(format!(
            "A{first_row}:{}{last_row}",
            col_index_to_letters(max_col)
        ));
    }

    Ok(XlsxSheetData {
        name: sheet_name.to_owned(),
        index,
        dimension_ref,
        headers,
        row_count: total_rows,
        col_count: max_col,
        numeric_summaries,
        rows,
        truncated,
    })
}

fn resolve_xlsx_cell_value(
    cell_type: &str,
    v: &str,
    inline: &str,
    shared_strings: &[String],
) -> (String, bool) {
    match cell_type {
        "s" => {
            if let Ok(idx) = v.trim().parse::<usize>() {
                let s = shared_strings.get(idx).cloned().unwrap_or_default();
                (s, false)
            } else {
                (v.to_owned(), false)
            }
        }
        "inlineStr" => (inline.to_owned(), false),
        "str" | "e" => (v.to_owned(), false),
        "b" => {
            let b = match v.trim() {
                "1" | "true" | "TRUE" => "TRUE",
                "0" | "false" | "FALSE" => "FALSE",
                other => other,
            };
            (b.to_owned(), false)
        }
        _ => {
            let trimmed = v.trim();
            let is_num = !trimmed.is_empty() && trimmed.parse::<f64>().is_ok();
            (trimmed.to_owned(), is_num)
        }
    }
}

fn extract_sheet_headers(rows: &[XlsxRow], max_col: u32) -> Vec<String> {
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    let mut headers = Vec::with_capacity(max_col as usize);
    for col in 1..=max_col {
        let label = first
            .cells
            .iter()
            .find(|c| c.col_idx == col)
            .map(|c| c.value.clone())
            .unwrap_or_default();
        headers.push(label);
    }
    headers
}

fn compute_numeric_summaries(rows: &[XlsxRow], headers: &[String]) -> Vec<XlsxNumericColSummary> {
    let header_row_num = rows.first().map(|r| r.row_num).unwrap_or(0);
    // 若首行含非数值表头文本，跳过首行再汇总数值区间
    let first_has_text_header = rows
        .first()
        .is_some_and(|r| r.cells.iter().any(|c| !c.is_numeric && !c.value.is_empty()));

    struct Acc {
        count: u64,
        min: f64,
        max: f64,
        sum: f64,
        min_row: u32,
        max_row: u32,
    }
    let mut by_col: HashMap<u32, Acc> = HashMap::new();
    for row in rows {
        if first_has_text_header && row.row_num == header_row_num {
            continue;
        }
        for cell in &row.cells {
            if !cell.is_numeric {
                continue;
            }
            let Ok(num) = cell.value.parse::<f64>() else {
                continue;
            };
            if !num.is_finite() {
                continue;
            }
            by_col
                .entry(cell.col_idx)
                .and_modify(|acc| {
                    acc.count += 1;
                    if num < acc.min {
                        acc.min = num;
                    }
                    if num > acc.max {
                        acc.max = num;
                    }
                    acc.sum += num;
                    acc.min_row = acc.min_row.min(row.row_num);
                    acc.max_row = acc.max_row.max(row.row_num);
                })
                .or_insert(Acc {
                    count: 1,
                    min: num,
                    max: num,
                    sum: num,
                    min_row: row.row_num,
                    max_row: row.row_num,
                });
        }
    }

    let mut cols: Vec<u32> = by_col.keys().copied().collect();
    cols.sort_unstable();

    cols.into_iter()
        .map(|col| {
            let acc = &by_col[&col];
            let letter = col_index_to_letters(col);
            let header = headers
                .get(col.saturating_sub(1) as usize)
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("列 {letter}"));
            let cell_range = if acc.min_row == acc.max_row {
                format!("{letter}{}", acc.min_row)
            } else {
                format!("{letter}{}:{letter}{}", acc.min_row, acc.max_row)
            };
            XlsxNumericColSummary {
                col_letter: letter,
                header,
                count: acc.count,
                min: round_f64(acc.min),
                max: round_f64(acc.max),
                sum: round_f64(acc.sum),
                cell_range,
            }
        })
        .collect()
}

fn round_f64(val: f64) -> f64 {
    (val * 1_000_000.0).round() / 1_000_000.0
}

/// 将 Excel 单元格坐标（如 `AB12`）拆分为 `(col_idx 1-based, row_num 1-based)`
pub fn parse_cell_ref(raw: &str) -> Option<(u32, u32)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut col: u32 = 0;
    let mut split_at = 0usize;
    for (idx, ch) in trimmed.char_indices() {
        if ch.is_ascii_alphabetic() {
            let v = (ch.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
            col = col.checked_mul(26)?.checked_add(v)?;
            split_at = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    if col == 0 || split_at >= trimmed.len() {
        return None;
    }
    let row = trimmed[split_at..].parse::<u32>().ok()?;
    (row > 0).then_some((col, row))
}

/// 将 1-based 列号转为 Excel 列字母（1 -> A, 27 -> AA）
pub fn col_index_to_letters(mut col: u32) -> String {
    if col == 0 {
        return "A".to_owned();
    }
    let mut chars = Vec::new();
    while col > 0 {
        let rem = (col - 1) % 26;
        chars.push((b'A' + rem as u8) as char);
        col = (col - 1) / 26;
    }
    chars.into_iter().rev().collect()
}

// ============================================================
// Office 决定陈述派生（.docx 段落 / .xlsx 单元格精确锚定）
// ============================================================

/// 从已解析的 `.docx` / `.xlsx` 抽取显式 `[P0/P1/P2 - 待确认]` 或 `Q01：` 决定陈述，
/// 将 `office_anchor`（`para:N` / `Sheet!CellRef`）写入 `detail_json`。
pub fn derive_office_statements(
    workspace_id: &str,
    file_id: &str,
    revision_id: &str,
    relative_path: &str,
    observed_at: &str,
    extract: &OfficeExtractRecord,
) -> Vec<StatementRow> {
    if extract.status != "indexed" {
        return Vec::new();
    }

    let mut out = Vec::new();
    let namespace = relative_path
        .rsplit('/')
        .next()
        .unwrap_or(relative_path)
        .to_owned();

    if let Some(docx) = &extract.docx {
        let mut last_heading: Option<String> = None;
        for p in &docx.paragraphs {
            if p.heading_level.is_some() {
                last_heading = Some(p.text.clone());
            }
            if let Some((code, status, question)) = detect_inline_decision_marker(&p.text) {
                let anchor = OfficeEvidenceAnchor {
                    kind: "docx_paragraph".to_owned(),
                    sheet: None,
                    cell_range: None,
                    paragraph: Some(p.para_index),
                    heading: last_heading.clone(),
                };
                out.push(build_office_statement(
                    workspace_id,
                    file_id,
                    revision_id,
                    &namespace,
                    &code,
                    &status,
                    &question,
                    &p.text,
                    p.para_index as i64,
                    observed_at,
                    &anchor,
                ));
            }
        }
    }

    if let Some(xlsx) = &extract.xlsx {
        for sheet in &xlsx.sheets {
            for row in &sheet.rows {
                for cell in &row.cells {
                    if let Some((code, status, question)) =
                        detect_inline_decision_marker(&cell.value)
                    {
                        let anchor = OfficeEvidenceAnchor {
                            kind: "xlsx_range".to_owned(),
                            sheet: Some(sheet.name.clone()),
                            cell_range: Some(cell.ref_id.clone()),
                            paragraph: None,
                            heading: None,
                        };
                        let seq_line = (sheet.index as i64) * 10_000 + (row.row_num as i64);
                        out.push(build_office_statement(
                            workspace_id,
                            file_id,
                            revision_id,
                            &namespace,
                            &code,
                            &status,
                            &question,
                            &cell.value,
                            seq_line,
                            observed_at,
                            &anchor,
                        ));
                    }
                }
            }
        }
    }

    out
}

#[allow(clippy::too_many_arguments)]
fn build_office_statement(
    workspace_id: &str,
    file_id: &str,
    revision_id: &str,
    namespace: &str,
    code: &str,
    status: &str,
    question: &str,
    quote: &str,
    line_num: i64,
    observed_at: &str,
    anchor: &OfficeEvidenceAnchor,
) -> StatementRow {
    let norm_q: String = question
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '？' | '?' | '。' | '，' | ','))
        .collect::<String>()
        .to_lowercase();
    let statement_id = format!(
        "stmt_{}",
        stable_key(&format!("{revision_id}|{code}|{line_num}|{norm_q}"))
    );
    let decision_id = format!(
        "dec_{}",
        stable_key(&format!("{namespace}|{code}|{norm_q}"))
    );
    let detail_json = serde_json::json!({
        "priority": code,
        "office_anchor": anchor,
    })
    .to_string();

    StatementRow {
        statement_id,
        workspace_id: workspace_id.to_owned(),
        file_id: file_id.to_owned(),
        revision_id: revision_id.to_owned(),
        code: code.to_owned(),
        namespace: namespace.to_owned(),
        question: question.to_owned(),
        status: status.to_owned(),
        quote: truncate_utf8_chars(quote, 240),
        line_start: line_num,
        line_end: line_num,
        decision_id: Some(decision_id),
        detail_json,
        extract_rule_version: EXTRACT_RULE_VERSION.to_owned(),
        observed_at: observed_at.to_owned(),
    }
}

pub(crate) fn detect_inline_decision_marker(text: &str) -> Option<(String, String, String)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    for prio in ["P0", "P1", "P2"] {
        for status_word in ["待确认", "已确认", "已否决"] {
            let pat_dash = format!("[{prio} - {status_word}]");
            if let Some(pos) = trimmed.find(&pat_dash) {
                let q = trimmed[pos + pat_dash.len()..].trim();
                let question = if q.is_empty() { trimmed } else { q };
                return Some((prio.to_owned(), status_word.to_owned(), question.to_owned()));
            }
            let pat_tight = format!("[{prio}-{status_word}]");
            if let Some(pos) = trimmed.find(&pat_tight) {
                let q = trimmed[pos + pat_tight.len()..].trim();
                let question = if q.is_empty() { trimmed } else { q };
                return Some((prio.to_owned(), status_word.to_owned(), question.to_owned()));
            }
        }
    }
    None
}

fn decode_text_event(t: &quick_xml::events::BytesText<'_>) -> String {
    let raw = t.as_ref();
    quick_xml::escape::unescape(raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.to_owned())
}

fn decode_general_ref(r: &quick_xml::events::BytesRef<'_>) -> Option<String> {
    if let Ok(Some(ch)) = r.resolve_char_ref() {
        return Some(ch.to_string());
    }
    quick_xml::escape::resolve_predefined_entity(r.as_ref()).map(str::to_owned)
}

fn attr_value(e: &quick_xml::events::BytesStart<'_>, target_local: &str) -> Option<String> {
    for attr in e.attributes().flatten() {
        if attr.key.local_name().as_ref() == target_local {
            if let Ok(val) = attr.normalized_value(quick_xml::XmlVersion::default()) {
                return Some(val.into_owned());
            }
            return Some(attr.value.into_owned());
        }
    }
    None
}

pub(crate) fn truncate_utf8_chars(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::write::DeflateEncoder;
    use flate2::Compression;
    use std::io::Write;

    /// 测试专用：构造标准最小合法 ZIP（Stored + Deflate）
    pub fn build_test_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        struct EntryMeta {
            name: Vec<u8>,
            crc: u32,
            comp_len: u32,
            uncomp_len: u32,
            offset: u32,
        }
        let mut metas = Vec::new();

        for (name, data) in files {
            let offset = buf.len() as u32;
            let mut enc = DeflateEncoder::new(Vec::new(), Compression::fast());
            enc.write_all(data).unwrap();
            let comp = enc.finish().unwrap();
            let crc = crc32_simple(data);
            let name_bytes = name.as_bytes().to_vec();

            buf.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]);
            buf.extend_from_slice(&20u16.to_le_bytes()); // version
            buf.extend_from_slice(&0u16.to_le_bytes()); // flags
            buf.extend_from_slice(&8u16.to_le_bytes()); // deflate
            buf.extend_from_slice(&0u16.to_le_bytes()); // time
            buf.extend_from_slice(&0u16.to_le_bytes()); // date
            buf.extend_from_slice(&crc.to_le_bytes());
            buf.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
            buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes()); // extra
            buf.extend_from_slice(&name_bytes);
            buf.extend_from_slice(&comp);

            metas.push(EntryMeta {
                name: name_bytes,
                crc,
                comp_len: comp.len() as u32,
                uncomp_len: data.len() as u32,
                offset,
            });
        }

        let cd_offset = buf.len() as u32;
        for m in &metas {
            buf.extend_from_slice(&[0x50, 0x4B, 0x01, 0x02]);
            buf.extend_from_slice(&20u16.to_le_bytes());
            buf.extend_from_slice(&20u16.to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes());
            buf.extend_from_slice(&8u16.to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes());
            buf.extend_from_slice(&m.crc.to_le_bytes());
            buf.extend_from_slice(&m.comp_len.to_le_bytes());
            buf.extend_from_slice(&m.uncomp_len.to_le_bytes());
            buf.extend_from_slice(&(m.name.len() as u16).to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes());
            buf.extend_from_slice(&0u16.to_le_bytes());
            buf.extend_from_slice(&0u32.to_le_bytes());
            buf.extend_from_slice(&m.offset.to_le_bytes());
            buf.extend_from_slice(&m.name);
        }
        let cd_size = (buf.len() as u32) - cd_offset;
        buf.extend_from_slice(&[0x50, 0x4B, 0x05, 0x06]);
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&(metas.len() as u16).to_le_bytes());
        buf.extend_from_slice(&(metas.len() as u16).to_le_bytes());
        buf.extend_from_slice(&cd_size.to_le_bytes());
        buf.extend_from_slice(&cd_offset.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf
    }

    fn crc32_simple(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    #[test]
    fn parses_docx_headings_paragraphs_comments_and_tracked_changes() {
        let doc_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>1. 系统总体方案</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>核心目标是在本地实现毫秒级预览。</w:t></w:r>
      <w:ins w:id="1" w:author="张工"><w:r><w:t>支持批量证据引用。</w:t></w:r></w:ins>
      <w:del w:id="2" w:author="张工"><w:r><w:delText>旧版轮询机制。</w:delText></w:r></w:del>
    </w:p>
    <w:p>
      <w:r><w:t>[P0 - 待确认] 是否采用方案 B 电源芯片？</w:t></w:r>
      <w:commentReference w:id="c1"/>
    </w:p>
  </w:body>
</w:document>"#
            .as_bytes();
        let comments_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="c1" w:author="李架构" w:date="2026-11-19T10:00:00Z">
    <w:p><w:r><w:t>需核对 BOM 报价单价。</w:t></w:r></w:p>
  </w:comment>
</w:comments>"#
            .as_bytes();

        let zip = build_test_zip(&[
            ("word/document.xml", doc_xml),
            ("word/comments.xml", comments_xml),
        ]);

        let rec = extract_office_from_bytes("docx", &zip);
        assert_eq!(rec.status, "indexed");
        let docx = rec.docx.as_ref().unwrap();
        assert_eq!(docx.headings.len(), 1);
        assert_eq!(docx.headings[0].para_index, 1);
        assert_eq!(docx.headings[0].level, 1);
        assert_eq!(docx.paragraphs.len(), 3);
        assert_eq!(docx.comments.len(), 1);
        assert_eq!(docx.comments[0].author, "李架构");
        assert_eq!(docx.comments[0].para_index, Some(3));
        assert_eq!(docx.tracked_changes.insertions, 1);
        assert_eq!(docx.tracked_changes.deletions, 1);

        let stmts = derive_office_statements(
            "ws_1",
            "f_docx",
            "rev_docx_1",
            "docs/方案.docx",
            "2026-11-19T10:05:00Z",
            &rec,
        );
        assert_eq!(stmts.len(), 1);
        assert_eq!(stmts[0].code, "P0");
        assert_eq!(stmts[0].line_start, 3);
        assert!(stmts[0].detail_json.contains("\"docx_paragraph\""));
    }

    #[test]
    fn parses_xlsx_sheets_headers_numeric_summaries_and_cell_anchors() {
        let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="BOM明细" sheetId="1" r:id="rId1"/>
    <sheet name="审批说明" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"#
            .as_bytes();
        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>"#
            .as_bytes();
        let shared_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>物料名称</t></si>
  <si><t>数量</t></si>
  <si><t>单价</t></si>
  <si><t>主控芯片</t></si>
  <si><t>电源模块</t></si>
  <si><t>[P1 - 待确认] 电源模块单价是否锁定？</t></si>
</sst>"#
            .as_bytes();
        let sheet1_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:C3"/>
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>10</v></c><c r="C2"><v>42.5</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>5</v></c><c r="C3"><f>B3*4</f><v>20</v></c></row>
  </sheetData>
</worksheet>"#
            .as_bytes();
        let sheet2_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>5</v></c></row>
  </sheetData>
</worksheet>"#
            .as_bytes();

        let zip = build_test_zip(&[
            ("xl/workbook.xml", workbook_xml),
            ("xl/_rels/workbook.xml.rels", rels_xml),
            ("xl/sharedStrings.xml", shared_xml),
            ("xl/worksheets/sheet1.xml", sheet1_xml),
            ("xl/worksheets/sheet2.xml", sheet2_xml),
        ]);

        let rec = extract_office_from_bytes("xlsx", &zip);
        assert_eq!(rec.status, "indexed");
        let xlsx = rec.xlsx.as_ref().unwrap();
        assert_eq!(xlsx.sheets.len(), 2);
        assert_eq!(xlsx.sheets[0].name, "BOM明细");
        assert_eq!(xlsx.sheets[0].headers, vec!["物料名称", "数量", "单价"]);
        assert_eq!(xlsx.sheets[0].numeric_summaries.len(), 2);
        assert_eq!(xlsx.sheets[0].numeric_summaries[1].header, "单价");
        assert_eq!(xlsx.sheets[0].numeric_summaries[1].cell_range, "C2:C3");
        assert_eq!(xlsx.sheets[0].numeric_summaries[1].sum, 62.5);
        assert_eq!(
            xlsx.sheets[0].rows[2].cells[2].formula.as_deref(),
            Some("B3*4")
        );

        let stmts = derive_office_statements(
            "ws_1",
            "f_xlsx",
            "rev_xlsx_1",
            "docs/BOM报价.xlsx",
            "2026-11-19T10:05:00Z",
            &rec,
        );
        assert_eq!(stmts.len(), 1);
        assert_eq!(stmts[0].code, "P1");
        assert!(stmts[0].detail_json.contains("审批说明"));
        assert!(stmts[0].detail_json.contains("\"A1\""));
    }

    #[test]
    fn degrades_gracefully_on_corrupted_and_encrypted_office_files() {
        let corrupted = extract_office_from_bytes("docx", b"not-a-zip-at-all-1234567890");
        assert_eq!(corrupted.status, "corrupted");
        assert!(corrupted.error_reason.is_some());

        let mut ole_encrypted = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        ole_encrypted.extend_from_slice(&[0u8; 64]);
        let encrypted = extract_office_from_bytes("xlsx", &ole_encrypted);
        assert_eq!(encrypted.status, "encrypted");

        let ooxml_encrypted = build_test_zip(&[
            ("EncryptionInfo", b"encrypted-header"),
            ("EncryptedPackage", b"ciphertext"),
        ]);
        let encrypted2 = extract_office_from_bytes("docx", &ooxml_encrypted);
        assert_eq!(encrypted2.status, "encrypted");
    }
}
