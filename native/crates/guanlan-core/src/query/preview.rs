//! QuickLook 轻预览查询与恒定内存头部/切片解析。
//!
//! 职责边界：
//! - DB 查询（[`revision_preview`]）只读 SQLite 元数据与版本历史，不直接读磁盘 blob；
//! - 服务层拿到 `snapshot_path` 后，仅按 `max_bytes`（默认 64 KiB）或图像头/魔数上限
//!   读取局部字节，再调用本模块的纯函数抽取尺寸元数据、UTF-8 切片或魔数签名——绝不把
//!   大型文件整读入内存。

use rusqlite::params;

use super::revisions::url_path_component;
use super::sql_text;
use crate::dto::{
    ImagePreviewMeta, OfficePreviewSummary, PdfPreviewSummary, RevisionPreviewHistoryItem,
    RevisionPreviewResponse,
};
use crate::error::GuanlanError;
use crate::index::file_format::{FileFormat, FormatClass};
use crate::query::files::title_of;
use crate::storage::{internal_sql, revision_row, ReadonlyStore, RevisionRow};
use std::io::Write as _;

/// 轻预览默认切片上限 64 KiB
pub const DEFAULT_PREVIEW_SLICE_BYTES: u64 = 64 * 1024;
/// 轻预览切片下限 1 KiB
pub const MIN_PREVIEW_SLICE_BYTES: u64 = 1024;
/// 轻预览切片上限 256 KiB
pub const MAX_PREVIEW_SLICE_BYTES: u64 = 256 * 1024;

/// GET /api/v1/revisions/{revision_id}/preview 请求参数
#[derive(Debug, Clone, Copy)]
pub struct RevisionPreviewQuery {
    pub offset: u64,
    pub max_bytes: u64,
}

impl Default for RevisionPreviewQuery {
    fn default() -> Self {
        Self {
            offset: 0,
            max_bytes: DEFAULT_PREVIEW_SLICE_BYTES,
        }
    }
}

impl RevisionPreviewQuery {
    pub fn clamped_max_bytes(&self) -> u64 {
        self.max_bytes
            .clamp(MIN_PREVIEW_SLICE_BYTES, MAX_PREVIEW_SLICE_BYTES)
    }
}

/// 按格式族判定轻预览渲染分支
pub fn preview_kind_for(format: &FileFormat) -> &'static str {
    match format.class() {
        FormatClass::Image => "image",
        FormatClass::Vector => "vector",
        FormatClass::Markdown => "markdown",
        FormatClass::Code => "code",
        FormatClass::Text => "text",
        FormatClass::Spreadsheet => match format.as_str() {
            "csv" | "tsv" => "table",
            _ if format.is_office_structured() => "office",
            _ => "binary",
        },
        FormatClass::Document => {
            if format.as_str() == "pdf" {
                "pdf"
            } else if format.is_office_structured() {
                "office"
            } else {
                "binary"
            }
        }
        FormatClass::Presentation
        | FormatClass::Archive
        | FormatClass::Audio
        | FormatClass::Video
        | FormatClass::Font
        | FormatClass::Binary => "binary",
    }
}

/// 在短读事务内汇总轻预览所需的元信息与历史版本体积轨迹。
pub fn revision_preview(
    store: &ReadonlyStore,
    revision_id: &str,
    _query: &RevisionPreviewQuery,
) -> Result<RevisionPreviewResponse, GuanlanError> {
    store.read_txn(|_conn| revision_preview_tx(store, revision_id))
}

pub fn revision_preview_tx(
    store: &ReadonlyStore,
    revision_id: &str,
) -> Result<RevisionPreviewResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let conn = store.conn();
    let rev = store
        .revision_by_id(revision_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到版本 {revision_id}")))?;
    let file = store
        .file_by_id(&rev.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到版本所属文件 {}", rev.file_id)))?;

    let format_token = file.format.clone();
    let parsed_format =
        FileFormat::parse(&format_token).unwrap_or_else(|| FileFormat::of_extension(&format_token));
    let (office_summary, pdf_summary, preview_kind): (
        Option<OfficePreviewSummary>,
        Option<PdfPreviewSummary>,
        String,
    ) = if parsed_format.is_office_structured() {
        let rec =
            crate::query::office::load_office_extract_for_revision(store, &format_token, &rev);
        let kind = if rec.status == "indexed" {
            "office".to_owned()
        } else {
            "binary".to_owned()
        };
        (
            Some(crate::query::office::summarize_office(&rec)),
            None,
            kind,
        )
    } else if format_token == "pdf" {
        let rec = crate::query::pdf::load_pdf_extract_for_revision(store, &rev);
        (
            None,
            Some(crate::query::pdf::summarize_pdf(&rec)),
            "pdf".to_owned(),
        )
    } else {
        (None, None, preview_kind_for(&parsed_format).to_owned())
    };
    let format_class = parsed_format.class().as_str().to_owned();
    let mime_type = parsed_format.mime_type().to_owned();
    let title = if file.title.is_empty() {
        title_of(&file.current_path)
    } else {
        file.title.clone()
    };

    let (revision_count, size_min_bytes, size_max_bytes): (u64, i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MIN(size_bytes), 0), COALESCE(MAX(size_bytes), 0)
             FROM revisions WHERE file_id = ?",
            [sql_text(&file.file_id)],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?.max(0) as u64,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(internal_sql)?;

    const HISTORY_CAP: usize = 24;
    let mut stmt = conn
        .prepare("SELECT * FROM revisions WHERE file_id = ? ORDER BY seq DESC LIMIT ?")
        .map_err(internal_sql)?;
    let fetched: Vec<RevisionRow> = stmt
        .query_map(
            params![file.file_id.as_str(), (HISTORY_CAP + 1) as i64],
            revision_row,
        )
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;

    let mut history = Vec::with_capacity(fetched.len().min(HISTORY_CAP));
    for (idx, row) in fetched.iter().take(HISTORY_CAP).enumerate() {
        let delta_bytes = fetched
            .get(idx + 1)
            .map(|prev| row.size_bytes.saturating_sub(prev.size_bytes));
        history.push(RevisionPreviewHistoryItem {
            revision_id: row.revision_id.clone(),
            seq: row.seq,
            size_bytes: row.size_bytes,
            delta_bytes,
            content_hash: row.content_hash.clone(),
            observed_at: row.observed_at.clone(),
            occurred_at: row.occurred_at.clone(),
            snapshot_available: row.snapshot_available != 0,
        });
    }

    let snapshot_available = rev.snapshot_available != 0;
    let snapshot_path = if snapshot_available {
        store.blob_path_for(&rev.content_hash).ok()
    } else {
        None
    };

    let encoded_id = url_path_component(revision_id);
    let raw_url = snapshot_path
        .is_some()
        .then(|| format!("/api/v1/revisions/{encoded_id}/content?raw=1"));
    let is_thumb_eligible = matches!(
        parsed_format.class(),
        FormatClass::Image | FormatClass::Vector
    );
    let thumbnail_url = (snapshot_path.is_some() && is_thumb_eligible)
        .then(|| format!("/api/v1/revisions/{encoded_id}/thumbnail"));

    Ok(RevisionPreviewResponse {
        ok: true,
        index_generation: ws.index_generation,
        file_id: file.file_id,
        revision_id: rev.revision_id,
        relative_path: file.current_path,
        title,
        format: format_token,
        format_class,
        mime_type,
        preview_kind,
        seq: rev.seq,
        revision_count,
        content_hash: rev.content_hash,
        size_bytes: rev.size_bytes,
        size_min_bytes,
        size_max_bytes,
        observed_at: rev.observed_at,
        occurred_at: rev.occurred_at,
        snapshot_available: snapshot_path.is_some(),
        blob_missing: false,
        raw_url,
        thumbnail_url,
        text_slice: None,
        slice_offset: 0,
        slice_bytes: 0,
        total_bytes: rev.size_bytes.max(0) as u64,
        line_count: 0,
        truncated: false,
        image_meta: None,
        magic_signature: None,
        header_hex: None,
        office_summary,
        pdf_summary,
        history,
        snapshot_path,
    })
}

/// 将读取到的局部字节安全切出完整 UTF-8 字符串，返回 `(text, skipped_start, byte_len, line_count)`。
///
/// - 若 `offset > 0` 且切片开头落在多字节 UTF-8 字符中间，跳过前导最多 3 个续字节 (`10xx_xxxx`)；
/// - 若未到文件尾 (`!reached_eof`) 且切片末尾把多字节字符劈断，回退丢弃末尾残字节；
/// - 非 UTF-8 字节使用 `from_utf8_lossy`。
pub fn slice_utf8_bounded(
    bytes: &[u8],
    offset: u64,
    reached_eof: bool,
) -> (String, usize, usize, u64) {
    if bytes.is_empty() {
        return (String::new(), 0, 0, 0);
    }

    let mut start = 0usize;
    if offset > 0 {
        while start < bytes.len() && start < 3 && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
            start += 1;
        }
    }

    let mut end = bytes.len();
    if !reached_eof && end > start {
        end = trim_incomplete_utf8_tail(&bytes[start..]) + start;
    }

    if end <= start {
        return (String::new(), start, 0, 0);
    }

    let slice = &bytes[start..end];
    let text = String::from_utf8_lossy(slice).into_owned();
    let lines = if text.is_empty() {
        0
    } else {
        text.bytes().filter(|&b| b == b'\n').count() as u64 + 1
    };
    (text, start, end - start, lines)
}

fn trim_incomplete_utf8_tail(buf: &[u8]) -> usize {
    let len = buf.len();
    if len == 0 {
        return 0;
    }
    let check_from = len.saturating_sub(4);
    for idx in (check_from..len).rev() {
        let b = buf[idx];
        if (b & 0b1100_0000) == 0b1000_0000 {
            continue;
        }
        let expected_len = if b < 0x80 {
            1
        } else if (b & 0b1110_0000) == 0b1100_0000 {
            2
        } else if (b & 0b1111_0000) == 0b1110_0000 {
            3
        } else if (b & 0b1111_1000) == 0b1111_0000 {
            4
        } else {
            1
        };
        let available = len - idx;
        if available < expected_len {
            return idx;
        }
        return len;
    }
    len
}

/// 仅凭文件前 ≤64KiB 头部字节抽取 PNG / JPEG / WebP / GIF / BMP / ICO / SVG 像素尺寸。
pub fn inspect_image_dimensions(bytes: &[u8], format: &str) -> Option<ImagePreviewMeta> {
    if bytes.len() >= 24 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        if w > 0 && h > 0 {
            return Some(ImagePreviewMeta {
                width: w,
                height: h,
            });
        }
    }

    if bytes.len() >= 10 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        if w > 0 && h > 0 {
            return Some(ImagePreviewMeta {
                width: w,
                height: h,
            });
        }
    }

    if bytes.len() >= 26 && &bytes[0..2] == b"BM" {
        let w = i32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]).unsigned_abs();
        let h = i32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]).unsigned_abs();
        if w > 0 && h > 0 {
            return Some(ImagePreviewMeta {
                width: w,
                height: h,
            });
        }
    }

    if bytes.len() >= 30 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        if let Some(meta) = parse_webp_dimensions(bytes) {
            return Some(meta);
        }
    }

    if bytes.len() >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        if let Some(meta) = parse_jpeg_dimensions(bytes) {
            return Some(meta);
        }
    }

    if bytes.len() >= 14 && &bytes[0..4] == b"\x00\x00\x01\x00" {
        let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        let mut best: Option<(u32, u32)> = None;
        for i in 0..count.min(32) {
            let off = 6 + i * 16;
            if off + 4 > bytes.len() {
                break;
            }
            let w = if bytes[off] == 0 {
                256
            } else {
                bytes[off] as u32
            };
            let h = if bytes[off + 1] == 0 {
                256
            } else {
                bytes[off + 1] as u32
            };
            if best.is_none_or(|(bw, bh)| w * h > bw * bh) {
                best = Some((w, h));
            }
        }
        if let Some((width, height)) = best {
            return Some(ImagePreviewMeta { width, height });
        }
    }

    if format.eq_ignore_ascii_case("svg") {
        return parse_svg_dimensions(bytes);
    }

    None
}

fn parse_webp_dimensions(bytes: &[u8]) -> Option<ImagePreviewMeta> {
    let chunk = &bytes[12..16];
    if chunk == b"VP8 "
        && bytes.len() >= 30
        && bytes[23] == 0x9D
        && bytes[24] == 0x01
        && bytes[25] == 0x2A
    {
        let w = (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF) as u32;
        let h = (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF) as u32;
        if w > 0 && h > 0 {
            return Some(ImagePreviewMeta {
                width: w,
                height: h,
            });
        }
    } else if chunk == b"VP8L" && bytes.len() >= 25 && bytes[20] == 0x2F {
        let b0 = bytes[21] as u32;
        let b1 = bytes[22] as u32;
        let b2 = bytes[23] as u32;
        let b3 = bytes[24] as u32;
        let bits = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
        let w = (bits & 0x3FFF) + 1;
        let h = ((bits >> 14) & 0x3FFF) + 1;
        if w > 0 && h > 0 {
            return Some(ImagePreviewMeta {
                width: w,
                height: h,
            });
        }
    } else if chunk == b"VP8X" && bytes.len() >= 30 {
        let w = 1 + (bytes[24] as u32 | ((bytes[25] as u32) << 8) | ((bytes[26] as u32) << 16));
        let h = 1 + (bytes[27] as u32 | ((bytes[28] as u32) << 8) | ((bytes[29] as u32) << 16));
        if w > 0 && h > 0 {
            return Some(ImagePreviewMeta {
                width: w,
                height: h,
            });
        }
    }
    None
}

fn parse_jpeg_dimensions(bytes: &[u8]) -> Option<ImagePreviewMeta> {
    let mut pos = 2usize;
    while pos + 3 < bytes.len() {
        if bytes[pos] != 0xFF {
            pos += 1;
            continue;
        }
        while pos < bytes.len() && bytes[pos] == 0xFF {
            pos += 1;
        }
        if pos >= bytes.len() {
            break;
        }
        let marker = bytes[pos];
        pos += 1;
        if marker == 0x00 || marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
            continue;
        }
        if marker == 0xDA {
            break;
        }
        if pos + 2 > bytes.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
        if seg_len < 2 || pos + seg_len > bytes.len() {
            break;
        }
        let is_sof = matches!(
            marker,
            0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF
        );
        if is_sof && seg_len >= 7 && pos + 7 <= bytes.len() {
            let h = u16::from_be_bytes([bytes[pos + 3], bytes[pos + 4]]) as u32;
            let w = u16::from_be_bytes([bytes[pos + 5], bytes[pos + 6]]) as u32;
            if w > 0 && h > 0 {
                return Some(ImagePreviewMeta {
                    width: w,
                    height: h,
                });
            }
        }
        pos += seg_len;
    }
    None
}

fn parse_svg_dimensions(bytes: &[u8]) -> Option<ImagePreviewMeta> {
    let head = std::str::from_utf8(&bytes[..bytes.len().min(8192)]).ok()?;
    let svg_start = head.find("<svg")?;
    let tag_end = head[svg_start..].find('>')? + svg_start;
    let tag = &head[svg_start..tag_end];
    if let Some(vb) = extract_svg_attr(tag, "viewBox") {
        let nums: Vec<f64> = vb
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse::<f64>().ok())
            .collect();
        if nums.len() == 4 && nums[2] > 0.0 && nums[3] > 0.0 {
            return Some(ImagePreviewMeta {
                width: nums[2].round() as u32,
                height: nums[3].round() as u32,
            });
        }
    }
    let w = extract_svg_attr(tag, "width").and_then(parse_px_number);
    let h = extract_svg_attr(tag, "height").and_then(parse_px_number);
    match (w, h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some(ImagePreviewMeta {
            width: w,
            height: h,
        }),
        _ => None,
    }
}

fn extract_svg_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{}= ", name.to_ascii_lowercase());
    let _ = needle;
    let pat = format!("{}=", name.to_ascii_lowercase());
    let mut idx = 0usize;
    while let Some(found) = lower[idx..].find(&pat) {
        let abs = idx + found;
        let prev_ok = abs == 0
            || tag.as_bytes()[abs - 1].is_ascii_whitespace()
            || tag.as_bytes()[abs - 1] == b'<';
        if prev_ok {
            let after_eq = &tag[abs + pat.len()..];
            let trimmed = after_eq.trim_start();
            if let Some(quote) = trimmed.chars().next().filter(|c| *c == '"' || *c == '\'') {
                let rest = &trimmed[1..];
                if let Some(end) = rest.find(quote) {
                    return Some(&rest[..end]);
                }
            }
        }
        idx = abs + pat.len();
    }
    None
}

fn parse_px_number(raw: &str) -> Option<u32> {
    let cleaned = raw.trim().strip_suffix("px").unwrap_or(raw.trim());
    let val = cleaned.parse::<f64>().ok()?;
    if val > 0.0 && val.is_finite() {
        Some(val.round() as u32)
    } else {
        None
    }
}

/// 识别常见二进制魔数签名（供体检卡展示）
pub fn detect_magic_signature(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 4 && &bytes[0..4] == b"PK\x03\x04" {
        return Some("ZIP / OOXML 归档头 (PK\\x03\\x04)");
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"%PDF" {
        return Some("PDF 版式文档头 (%PDF)");
    }
    if bytes.len() >= 16 && bytes.starts_with(b"SQLite format 3\0") {
        return Some("SQLite 3 数据库引擎文件");
    }
    if bytes.len() >= 6 && &bytes[0..6] == b"7z\xBC\xAF\x27\x1C" {
        return Some("7-Zip 归档容器");
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"\x1F\x8B\x08" {
        return Some("GZIP 压缩流");
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"\x7FELF" {
        return Some("ELF 原生可执行/共享库");
    }
    if bytes.len() >= 2 && &bytes[0..2] == b"MZ" {
        return Some("PE/MZ Windows 可执行模块");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("ISO Base Media (MP4/MOV)");
    }
    if bytes.len() >= 4 && (&bytes[0..4] == b"OggS" || &bytes[0..4] == b"fLaC") {
        return Some("无损/开源音频容器");
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"ID3" {
        return Some("MP3 / ID3 音频标签头");
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"wOFF" {
        return Some("WOFF 字体容器");
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"wOF2" {
        return Some("WOFF2 字体容器");
    }
    None
}

/// 格式化前 N 字节为可读十六进制头部摘要
pub fn format_hex_head(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(32)
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub struct DownsampledPng {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum DownsampleError {
    NotPng,
    Corrupt(&'static str),
    Unsupported,
    BadTargetSize,
}

#[allow(dead_code)]
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

#[allow(dead_code)]
fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[allow(dead_code)]
fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(4 + data.len());
    body.extend_from_slice(kind);
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
}

#[allow(dead_code)]
fn channels_of(color_type: u8) -> Option<usize> {
    match color_type {
        0 => Some(1),
        2 => Some(3),
        4 => Some(2),
        6 => Some(4),
        _ => None,
    }
}

#[allow(dead_code)]
fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i32::from(a) + i32::from(b) - i32::from(c);
    let pa = (p - i32::from(a)).abs();
    let pb = (p - i32::from(b)).abs();
    let pc = p.abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

#[allow(dead_code)]
fn unfilter_row(
    filter: u8,
    cur: &mut [u8],
    prev: &[u8],
    bpp: usize,
) -> Result<(), DownsampleError> {
    match filter {
        0 => {}
        1 => {
            for i in bpp..cur.len() {
                cur[i] = cur[i].wrapping_add(cur[i - bpp]);
            }
        }
        2 => {
            for i in 0..cur.len() {
                cur[i] = cur[i].wrapping_add(prev[i]);
            }
        }
        3 => {
            for i in 0..cur.len() {
                let left = if i >= bpp { cur[i - bpp] } else { 0 };
                cur[i] = cur[i].wrapping_add(((u16::from(left) + u16::from(prev[i])) / 2) as u8);
            }
        }
        4 => {
            for i in 0..cur.len() {
                let left = if i >= bpp { cur[i - bpp] } else { 0 };
                let up = prev[i];
                let ul = if i >= bpp { prev[i - bpp] } else { 0 };
                cur[i] = cur[i].wrapping_add(paeth(left, up, ul));
            }
        }
        _ => return Err(DownsampleError::Corrupt("未知行过滤器")),
    }
    Ok(())
}

#[allow(dead_code)]
pub fn downsample_png_rows(
    source: &[u8],
    target_w: u32,
    target_h: u32,
) -> Result<DownsampledPng, DownsampleError> {
    if source.len() < 8 || source[..8] != PNG_SIGNATURE {
        return Err(DownsampleError::NotPng);
    }
    let mut pos = 8usize;
    let mut ihdr: Option<[u8; 13]> = None;
    let mut idat: Vec<u8> = Vec::new();
    let mut saw_iend = false;
    while pos + 8 <= source.len() {
        let len = u32::from_be_bytes([
            source[pos],
            source[pos + 1],
            source[pos + 2],
            source[pos + 3],
        ]) as usize;
        let kind = &source[pos + 4..pos + 8];
        let data_start = pos + 8;
        let data_end = data_start
            .checked_add(len)
            .ok_or(DownsampleError::Corrupt("chunk 长度溢出"))?;
        if data_end > source.len() {
            return Err(DownsampleError::Corrupt("chunk 数据越界"));
        }
        let data = &source[data_start..data_end];
        match kind {
            b"IHDR" => {
                if len != 13 {
                    return Err(DownsampleError::Corrupt("IHDR 长度非法"));
                }
                let mut raw = [0u8; 13];
                raw.copy_from_slice(data);
                ihdr = Some(raw);
            }
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => {
                saw_iend = true;
                break;
            }
            _ => {}
        }
        pos = data_end + 4;
    }
    let ihdr = ihdr.ok_or(DownsampleError::Corrupt("缺 IHDR"))?;
    if !saw_iend {
        return Err(DownsampleError::Corrupt("缺 IEND（截断流，不输出半幅）"));
    }
    let src_w = u32::from_be_bytes([ihdr[0], ihdr[1], ihdr[2], ihdr[3]]);
    let src_h = u32::from_be_bytes([ihdr[4], ihdr[5], ihdr[6], ihdr[7]]);
    let bit_depth = ihdr[8];
    let color_type = ihdr[9];
    let interlace = ihdr[12];
    if bit_depth != 8 || interlace != 0 {
        return Err(DownsampleError::Unsupported);
    }
    let channels = channels_of(color_type).ok_or(DownsampleError::Unsupported)?;
    if src_w == 0 || src_h == 0 || target_w == 0 || target_h == 0 {
        return Err(DownsampleError::BadTargetSize);
    }
    if target_w > src_w || target_h > src_h {
        return Err(DownsampleError::BadTargetSize);
    }

    use std::io::Read;
    let mut decoder = flate2::read::ZlibDecoder::new(&idat[..]);
    let mut compressed_plane: Vec<u8> = Vec::new();
    decoder
        .read_to_end(&mut compressed_plane)
        .map_err(|_| DownsampleError::Corrupt("IDAT zlib 解码失败"))?;

    let stride = src_w as usize * channels;
    let bpp = channels;
    let mut prev_row: Vec<u8> = vec![0; stride];
    let mut cur_row: Vec<u8> = vec![0; stride];
    let mut acc: Vec<u64> = vec![0; target_w as usize * channels];
    let mut col_cnt: Vec<u64> = vec![0; target_w as usize];
    let row_bytes = stride + 1;
    let tw = target_w as usize;
    let th = target_h as usize;
    let mut out_rows: Vec<Vec<u8>> = Vec::with_capacity(th);
    let mut next_out = 0usize;
    let flush_row = |acc: &Vec<u64>, col_cnt: &[u64], out_rows: &mut Vec<Vec<u8>>| {
        let mut row = Vec::with_capacity(tw * channels + 1);
        row.push(0u8);
        for (x, cell) in acc.iter().enumerate() {
            let denom = col_cnt[x / channels].max(1) as f64;
            row.push(((*cell as f64) / denom).round() as u8);
        }
        out_rows.push(row);
    };
    for src_y in 0..src_h as usize {
        let base = src_y * row_bytes;
        if base + row_bytes > compressed_plane.len() {
            return Err(DownsampleError::Corrupt("过滤行流截断"));
        }
        let filter = compressed_plane[base];
        cur_row.copy_from_slice(&compressed_plane[base + 1..base + 1 + stride]);
        unfilter_row(filter, &mut cur_row, &prev_row, bpp)?;
        let out_idx = src_y * th / src_h as usize;
        if out_idx != next_out {
            flush_row(&acc, &col_cnt, &mut out_rows);
            next_out = out_idx;
            for cell in acc.iter_mut() {
                *cell = 0;
            }
            for cell in col_cnt.iter_mut() {
                *cell = 0;
            }
        }
        for x in 0..tw {
            let sx0 = x * src_w as usize / tw;
            let sx1 = (x + 1) * src_w as usize / tw;
            let sx1 = sx1.max(sx0 + 1);
            let in_box = (sx1.min(src_w as usize) - sx0) as u64;
            col_cnt[x] += in_box;
            for sx in sx0..sx1.min(src_w as usize) {
                for c in 0..channels {
                    acc[x * channels + c] += u64::from(cur_row[sx * channels + c]);
                }
            }
        }
        std::mem::swap(&mut prev_row, &mut cur_row);
    }
    flush_row(&acc, &col_cnt, &mut out_rows);
    if out_rows.len() != th {
        return Err(DownsampleError::Corrupt("输出行数不符"));
    }

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&PNG_SIGNATURE);
    let mut ihdr_out = Vec::with_capacity(13);
    ihdr_out.extend_from_slice(&target_w.to_be_bytes());
    ihdr_out.extend_from_slice(&target_h.to_be_bytes());
    ihdr_out.push(8);
    ihdr_out.push(color_type);
    ihdr_out.push(0);
    ihdr_out.push(0);
    ihdr_out.push(0);
    write_chunk(&mut out, b"IHDR", &ihdr_out);
    let mut plane: Vec<u8> = Vec::with_capacity(th * (tw * channels + 1));
    for row in &out_rows {
        plane.extend_from_slice(row);
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&plane).expect("Vec 写入不失败");
    let idat_out = encoder.finish().expect("Vec finish 不失败");
    write_chunk(&mut out, b"IDAT", &idat_out);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(DownsampledPng {
        bytes: out,
        width: target_w,
        height: target_h,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_png_gif_bmp_webp_jpeg_svg_dimensions() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        png.extend_from_slice(&1280u32.to_be_bytes());
        png.extend_from_slice(&720u32.to_be_bytes());
        assert_eq!(
            inspect_image_dimensions(&png, "png"),
            Some(ImagePreviewMeta {
                width: 1280,
                height: 720
            })
        );

        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320u16.to_le_bytes());
        gif.extend_from_slice(&240u16.to_le_bytes());
        assert_eq!(
            inspect_image_dimensions(&gif, "gif"),
            Some(ImagePreviewMeta {
                width: 320,
                height: 240
            })
        );

        let mut webp = b"RIFF\x00\x00\x00\x00WEBPVP8X".to_vec();
        webp.extend_from_slice(&[0u8; 8]);
        let w = 800u32 - 1;
        let h = 600u32 - 1;
        webp.extend_from_slice(&[
            (w & 0xFF) as u8,
            ((w >> 8) & 0xFF) as u8,
            ((w >> 16) & 0xFF) as u8,
            (h & 0xFF) as u8,
            ((h >> 8) & 0xFF) as u8,
            ((h >> 16) & 0xFF) as u8,
        ]);
        assert_eq!(
            inspect_image_dimensions(&webp, "webp"),
            Some(ImagePreviewMeta {
                width: 800,
                height: 600
            })
        );

        let jpeg = vec![
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x01,
            0xE0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00,
        ];
        assert_eq!(
            inspect_image_dimensions(&jpeg, "jpg"),
            Some(ImagePreviewMeta {
                width: 640,
                height: 480
            })
        );

        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"></svg>"#;
        assert_eq!(
            inspect_image_dimensions(svg, "svg"),
            Some(ImagePreviewMeta {
                width: 1024,
                height: 512
            })
        );
    }

    #[test]
    fn slices_utf8_cleanly_at_multibyte_boundaries() {
        let s = "观澜QuickLook预览";
        let bytes = s.as_bytes();
        let (text, start, byte_len, lines) = slice_utf8_bounded(&bytes[..4], 0, false);
        assert_eq!(text, "观");
        assert_eq!(start, 0);
        assert_eq!(byte_len, 3);
        assert_eq!(lines, 1);

        let (rest, skipped, rest_len, _) = slice_utf8_bounded(&bytes[4..], 4, true);
        assert_eq!(rest, "QuickLook预览");
        assert_eq!(skipped, 2);
        assert_eq!(rest_len, "QuickLook预览".len());
    }

    #[test]
    fn detects_magic_signatures() {
        assert!(detect_magic_signature(b"PK\x03\x04rest").is_some());
        assert!(detect_magic_signature(b"SQLite format 3\0").is_some());
        assert_eq!(detect_magic_signature(b"abcd"), None);
    }

    fn build_fixture_png(
        w: u32,
        h: u32,
        color_type: u8,
        pixel: impl Fn(u32, u32, usize) -> u8,
    ) -> Vec<u8> {
        let channels = channels_of(color_type).unwrap();
        let stride = w as usize * channels;
        let mut plane = Vec::with_capacity(h as usize * (stride + 1));
        for y in 0..h {
            plane.push(0u8);
            for x in 0..w {
                for c in 0..channels {
                    plane.push(pixel(x, y, c));
                }
            }
        }
        let mut out = Vec::new();
        out.extend_from_slice(&PNG_SIGNATURE);
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.push(8);
        ihdr.push(color_type);
        ihdr.push(0);
        ihdr.push(0);
        ihdr.push(0);
        write_chunk(&mut out, b"IHDR", &ihdr);
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&plane).unwrap();
        let idat = encoder.finish().unwrap();
        write_chunk(&mut out, b"IDAT", &idat);
        write_chunk(&mut out, b"IEND", &[]);
        out
    }

    fn decode_out_rows(out: &DownsampledPng, color_type: u8) -> Vec<Vec<u8>> {
        let bytes = &out.bytes;
        assert_eq!(&bytes[..8], &PNG_SIGNATURE);
        let mut pos = 8usize;
        let mut dims = (0u32, 0u32);
        let mut idat = Vec::new();
        while pos + 8 <= bytes.len() {
            let len =
                u32::from_be_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]])
                    as usize;
            let kind = &bytes[pos + 4..pos + 8];
            let start = pos + 8;
            let data = &bytes[start..start + len];
            match kind {
                b"IHDR" => {
                    dims = (
                        u32::from_be_bytes([data[0], data[1], data[2], data[3]]),
                        u32::from_be_bytes([data[4], data[5], data[6], data[7]]),
                    );
                    assert_eq!(data[8], 8);
                    assert_eq!(data[9], color_type);
                    assert_eq!(data[12], 0);
                }
                b"IDAT" => idat.extend_from_slice(data),
                _ => {}
            }
            pos = start + len + 4;
        }
        assert_eq!(dims, (out.width, out.height));
        use std::io::Read;
        let mut decoder = flate2::read::ZlibDecoder::new(&idat[..]);
        let mut plane = Vec::new();
        decoder.read_to_end(&mut plane).unwrap();
        let channels = channels_of(color_type).unwrap();
        let stride = out.width as usize * channels;
        let mut rows = Vec::new();
        let mut row = 0usize;
        while row < out.height as usize {
            let base = row * (stride + 1);
            assert_eq!(plane[base], 0, "产物行 filter=0");
            rows.push(plane[base + 1..base + 1 + stride].to_vec());
            row += 1;
        }
        rows
    }

    #[test]
    fn downsample_png_rgb_4x2_to_2x1_box_average_exact() {
        let png = build_fixture_png(4, 2, 2, |x, y, c| match c {
            0 => (x * 10) as u8,
            1 => (y * 100) as u8,
            _ => 7,
        });
        let out = downsample_png_rows(&png, 2, 1).unwrap();
        assert_eq!((out.width, out.height), (2, 1));
        let rows = decode_out_rows(&out, 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][0], 5);
        assert_eq!(rows[0][1], 50);
        assert_eq!(rows[0][2], 7);
        assert_eq!(rows[0][3], 25);
        assert_eq!(rows[0][4], 50);
        assert_eq!(rows[0][5], 7);
    }

    #[test]
    fn downsample_png_identity_size_preserves_pixels() {
        let png = build_fixture_png(3, 2, 6, |x, y, c| {
            ((x * 31 + y * 17 + (c as u32) * 7) % 256) as u8
        });
        let out = downsample_png_rows(&png, 3, 2).unwrap();
        let rows = decode_out_rows(&out, 6);
        for (y, row) in rows.iter().enumerate() {
            for x in 0..3usize {
                for c in 0..4usize {
                    let expect = ((x * 31 + y * 17 + c * 7) % 256) as u8;
                    assert_eq!(row[x * 4 + c], expect, "pixel({x},{y},{c})");
                }
            }
        }
    }

    #[test]
    fn downsample_png_nontrivial_filters_survive() {
        let prev = vec![5u8; 6];
        let mut filtered_sub = vec![10u8; 6];
        unfilter_row(1, &mut filtered_sub, &prev, 3).unwrap();
        assert_eq!(filtered_sub, vec![10, 10, 10, 20, 20, 20]);
        let mut filtered_up = vec![5u8; 6];
        unfilter_row(2, &mut filtered_up, &prev, 3).unwrap();
        assert_eq!(filtered_up, vec![10u8; 6]);
        let mut filtered_avg = vec![3u8; 6];
        unfilter_row(3, &mut filtered_avg, &prev, 3).unwrap();
        assert_eq!(filtered_avg[0], 5);
        assert_eq!(filtered_avg[1], 5);
        assert_eq!(filtered_avg[2], 5);
        assert_eq!(filtered_avg[3], 8);
        assert_eq!(filtered_avg[4], 8);
        assert_eq!(filtered_avg[5], 8);
        assert!(_paeth_self_check());
    }

    fn _paeth_self_check() -> bool {
        paeth(10, 12, 13) == 10 && paeth(0, 0, 0) == 0
    }

    #[test]
    fn downsample_png_rejects_honestly() {
        let png = build_fixture_png(4, 4, 2, |_, _, _| 9);
        assert_eq!(
            downsample_png_rows(b"not a png", 2, 2),
            Err(DownsampleError::NotPng)
        );
        assert_eq!(
            downsample_png_rows(&png, 0, 2),
            Err(DownsampleError::BadTargetSize)
        );
        assert_eq!(
            downsample_png_rows(&png, 8, 4),
            Err(DownsampleError::BadTargetSize)
        );
        let mut ihdr16 = build_fixture_png(4, 4, 2, |_, _, _| 9);
        ihdr16[24] = 16;
        assert_eq!(
            downsample_png_rows(&ihdr16, 2, 2),
            Err(DownsampleError::Unsupported)
        );
        let mut ihdr_il = build_fixture_png(4, 4, 2, |_, _, _| 9);
        ihdr_il[24 + 4] = 1;
        assert_eq!(
            downsample_png_rows(&ihdr_il, 2, 2),
            Err(DownsampleError::Unsupported)
        );
        let mut png_pal = build_fixture_png(4, 4, 2, |_, _, _| 0);
        png_pal[16 + 9] = 3;
        assert_eq!(
            downsample_png_rows(&png_pal, 2, 2),
            Err(DownsampleError::Unsupported)
        );
        let truncated = &png[..png.len() - 6];
        assert!(matches!(
            downsample_png_rows(truncated, 2, 2),
            Err(DownsampleError::Corrupt(_))
        ));
    }

    #[test]
    fn downsample_png_grayscale_8x8_to_2x2_and_bounded_rows() {
        let png = build_fixture_png(8, 8, 0, |x, y, _| ((x + y) % 256) as u8);
        let out = downsample_png_rows(&png, 2, 2).unwrap();
        let rows = decode_out_rows(&out, 0);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].len(), 2);
        assert_eq!(rows[0][0], 3);
        assert_eq!(rows[0][1], 7);
        assert_eq!(rows[1][0], 7);
        assert_eq!(rows[1][1], 11);
    }
}
