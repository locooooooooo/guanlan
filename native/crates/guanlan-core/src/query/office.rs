//! Office（`.docx` / `.xlsx`）结构化只读查询与轻预览摘要。
//!
//! 优先级：
//! 1. 优先从 `office_extracts` 按 `content_hash` 直接读取索引时产出的 L2 结构；
//! 2. 若打开尚未包含 `office_extracts` 行的旧库且 `snapshot_available != 0`
//!    （且快照体积在安全上限内），在只读路径按需解析内存快照返回，绝不写库。

use crate::dto::{OfficeContentResponse, OfficePreviewSummary};
use crate::error::GuanlanError;
use crate::index::file_format::FileFormat;
use crate::index::office::{extract_office_from_bytes, OfficeExtractRecord};
use crate::query::files::title_of;
use crate::storage::{ReadonlyStore, RevisionRow};

const MAX_ONDEMAND_OFFICE_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) fn cached_office_status(store: &ReadonlyStore, content_hash: &str) -> Option<String> {
    store
        .conn()
        .query_row(
            "SELECT status FROM office_extracts WHERE content_hash = ?",
            [content_hash],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

pub(crate) fn load_office_extract_for_revision(
    store: &ReadonlyStore,
    format: &str,
    rev: &RevisionRow,
) -> OfficeExtractRecord {
    let cached: Option<(String, Option<String>, String, String)> = store
        .conn()
        .query_row(
            "SELECT status, error_reason, extract_json, plain_text
             FROM office_extracts WHERE content_hash = ?",
            [rev.content_hash.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();
    if let Some((status, error_reason, extract_json, plain_text)) = cached {
        if let Ok(mut rec) = serde_json::from_str::<OfficeExtractRecord>(&extract_json) {
            rec.status = status;
            rec.error_reason = error_reason;
            if rec.plain_text.is_empty() && !plain_text.is_empty() {
                rec.plain_text = plain_text;
            }
            return rec;
        }
    }

    if rev.snapshot_available == 0 {
        return OfficeExtractRecord::metadata_only(
            format,
            "文件超出快照阈值，按 L0 元数据入库，不加载全文到内存",
        );
    }

    let Ok(blob_path) = store.blob_path_for(&rev.content_hash) else {
        return OfficeExtractRecord::degraded(format, "corrupted", "非法快照哈希，无法定位文件");
    };
    let Ok(meta) = std::fs::metadata(&blob_path) else {
        return OfficeExtractRecord::metadata_only(
            format,
            "快照文件缺失或已被清理，已降级为 L0 元数据卡",
        );
    };
    if meta.len() > MAX_ONDEMAND_OFFICE_BYTES {
        return OfficeExtractRecord::metadata_only(
            format,
            "文件体积超出 L2 结构化预览安全上限，请直接用外部应用打开",
        );
    }
    let Ok(bytes) = std::fs::read(&blob_path) else {
        return OfficeExtractRecord::degraded(format, "corrupted", "读取快照字节失败");
    };
    extract_office_from_bytes(format, &bytes)
}

pub(crate) fn summarize_office(rec: &OfficeExtractRecord) -> OfficePreviewSummary {
    let mut text_preview = String::new();
    for ch in rec.plain_text.chars().take(1200) {
        text_preview.push(ch);
    }
    if rec.plain_text.chars().count() > 1200 {
        text_preview.push('…');
    }

    if let Some(docx) = &rec.docx {
        OfficePreviewSummary {
            status: rec.status.clone(),
            error_reason: rec.error_reason.clone(),
            heading_count: docx.headings.len(),
            paragraph_count: docx.total_paragraphs as usize,
            comment_count: docx.comments.len(),
            tracked_insertions: docx.tracked_changes.insertions as usize,
            tracked_deletions: docx.tracked_changes.deletions as usize,
            sheet_count: 0,
            sheet_names: Vec::new(),
            headings_preview: docx
                .headings
                .iter()
                .take(8)
                .map(|h| h.text.clone())
                .collect(),
            text_preview,
        }
    } else if let Some(xlsx) = &rec.xlsx {
        OfficePreviewSummary {
            status: rec.status.clone(),
            error_reason: rec.error_reason.clone(),
            heading_count: 0,
            paragraph_count: 0,
            comment_count: 0,
            tracked_insertions: 0,
            tracked_deletions: 0,
            sheet_count: xlsx.total_sheets as usize,
            sheet_names: xlsx.sheets.iter().map(|s| s.name.clone()).collect(),
            headings_preview: xlsx
                .sheets
                .first()
                .map(|s| s.headers.clone())
                .unwrap_or_default(),
            text_preview,
        }
    } else {
        OfficePreviewSummary {
            status: rec.status.clone(),
            error_reason: rec.error_reason.clone(),
            heading_count: 0,
            paragraph_count: 0,
            comment_count: 0,
            tracked_insertions: 0,
            tracked_deletions: 0,
            sheet_count: 0,
            sheet_names: Vec::new(),
            headings_preview: Vec::new(),
            text_preview,
        }
    }
}

/// 读取指定版本的 Office 结构化文档/工作簿视图（`GET /api/v1/revisions/{id}/office`）
pub fn revision_office(
    store: &ReadonlyStore,
    revision_id: &str,
) -> Result<OfficeContentResponse, GuanlanError> {
    store.read_txn(|_conn| revision_office_tx(store, revision_id))
}

pub fn revision_office_tx(
    store: &ReadonlyStore,
    revision_id: &str,
) -> Result<OfficeContentResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let rev = store
        .revision_by_id(revision_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到版本 {revision_id}")))?;
    let file = store
        .file_by_id(&rev.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到版本所属文件 {}", rev.file_id)))?;

    let parsed_format =
        FileFormat::parse(&file.format).unwrap_or_else(|| FileFormat::of_extension(&file.format));
    if !parsed_format.is_office_structured() {
        return Err(GuanlanError::BadRequest(format!(
            "格式 {} 不支持 Office L2 结构化阅读",
            file.format
        )));
    }

    let title = if file.title.is_empty() {
        title_of(&file.current_path)
    } else {
        file.title.clone()
    };
    let rec = load_office_extract_for_revision(store, &file.format, &rev);

    Ok(OfficeContentResponse {
        ok: true,
        index_generation: ws.index_generation,
        file_id: file.file_id,
        revision_id: rev.revision_id,
        relative_path: file.current_path,
        title,
        format: file.format,
        seq: rev.seq,
        content_hash: rev.content_hash,
        size_bytes: rev.size_bytes,
        snapshot_available: rev.snapshot_available != 0,
        status: rec.status,
        error_reason: rec.error_reason,
        docx: rec.docx,
        xlsx: rec.xlsx,
        plain_text: rec.plain_text,
    })
}
