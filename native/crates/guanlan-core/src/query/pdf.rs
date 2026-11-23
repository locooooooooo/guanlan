//! B04 · PDF 页级正文只读查询与轻预览摘要。
//!
//! 优先级：
//! 1. 优先从 `pdf_extracts` 按 `content_hash` 直接读取索引时产出的页级结构；
//! 2. 若打开 B04 之前采集的旧库尚未有 `pdf_extracts` 行且 `snapshot_available != 0`
//!    （且快照体积在安全上限内），在只读路径按需解析内存快照返回，绝不写库。

use crate::dto::{PdfContentResponse, PdfPreviewSummary};
use crate::error::GuanlanError;
use crate::index::pdf::{extract_pdf_from_bytes, PdfExtractRecord};
use crate::query::files::title_of;
use crate::storage::{ReadonlyStore, RevisionRow};

/// 只读按需解析兜底的大小上限（32 MiB，与 Office L2 快照上限一致）
const MAX_ONDEMAND_PDF_BYTES: u64 = 32 * 1024 * 1024;

/// 读取指定 `content_hash` 在 `pdf_extracts` 里的状态（供 `files.rs` 覆盖与徽标判定）
pub(crate) fn cached_pdf_status(store: &ReadonlyStore, content_hash: &str) -> Option<String> {
    store
        .conn()
        .query_row(
            "SELECT status FROM pdf_extracts WHERE content_hash = ?",
            [content_hash],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

/// 按版本加载 PDF 页级提取结构；未命中缓存时按快照门禁安全兜底解析（只读不写库）
pub(crate) fn load_pdf_extract_for_revision(
    store: &ReadonlyStore,
    rev: &RevisionRow,
) -> PdfExtractRecord {
    let cached: Option<(String, Option<String>, String, String)> = store
        .conn()
        .query_row(
            "SELECT status, error_reason, extract_json, plain_text
             FROM pdf_extracts WHERE content_hash = ?",
            [rev.content_hash.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();
    if let Some((status, error_reason, extract_json, plain_text)) = cached {
        if let Ok(mut rec) = serde_json::from_str::<PdfExtractRecord>(&extract_json) {
            rec.status = status;
            rec.error_reason = error_reason;
            if rec.plain_text.is_empty() && !plain_text.is_empty() {
                rec.plain_text = plain_text;
            }
            return rec;
        }
    }

    if rev.snapshot_available == 0 {
        return PdfExtractRecord::metadata_only(
            "文件超出快照阈值，按 L0 元数据入库，不加载全文到内存",
        );
    }

    let Ok(blob_path) = store.blob_path_for(&rev.content_hash) else {
        return PdfExtractRecord::degraded("corrupted", "非法快照哈希，无法定位文件");
    };
    let Ok(meta) = std::fs::metadata(&blob_path) else {
        return PdfExtractRecord::metadata_only("快照文件缺失或已被清理，已降级为 L0 元数据卡");
    };
    if meta.len() > MAX_ONDEMAND_PDF_BYTES {
        return PdfExtractRecord::metadata_only(
            "PDF 体积超出 L2 页文本解析安全上限，请直接用外部应用打开",
        );
    }
    let Ok(bytes) = std::fs::read(&blob_path) else {
        return PdfExtractRecord::degraded("corrupted", "读取快照字节失败");
    };
    extract_pdf_from_bytes(&bytes)
}

/// 生成供 QuickLook 轻预览端点使用的紧凑 PDF 摘要
pub(crate) fn summarize_pdf(rec: &PdfExtractRecord) -> PdfPreviewSummary {
    let mut text_preview = String::new();
    for ch in rec.plain_text.chars().take(1200) {
        text_preview.push(ch);
    }
    if rec.plain_text.chars().count() > 1200 {
        text_preview.push('…');
    }

    PdfPreviewSummary {
        status: rec.status.clone(),
        error_reason: rec.error_reason.clone(),
        page_count: rec.page_count as usize,
        text_page_count: rec.text_page_count as usize,
        image_only_page_count: rec.image_only_page_count as usize,
        extract_failed_page_count: rec.extract_failed_page_count as usize,
        headings_preview: rec
            .pages
            .iter()
            .take(8)
            .map(|p| p.heading.clone())
            .collect(),
        text_preview,
    }
}

/// 读取指定版本的 PDF 页级文本视图（`GET /api/v1/revisions/{id}/pdf`）
pub fn revision_pdf(
    store: &ReadonlyStore,
    revision_id: &str,
) -> Result<PdfContentResponse, GuanlanError> {
    store.read_txn(|_conn| revision_pdf_tx(store, revision_id))
}

pub fn revision_pdf_tx(
    store: &ReadonlyStore,
    revision_id: &str,
) -> Result<PdfContentResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let rev = store
        .revision_by_id(revision_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到版本 {revision_id}")))?;
    let file = store
        .file_by_id(&rev.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到版本所属文件 {}", rev.file_id)))?;

    if file.format != "pdf" {
        return Err(GuanlanError::BadRequest(format!(
            "格式 {} 不支持 PDF 页级文本阅读",
            file.format
        )));
    }

    let title = if file.title.is_empty() {
        title_of(&file.current_path)
    } else {
        file.title.clone()
    };
    let rec = load_pdf_extract_for_revision(store, &rev);

    Ok(PdfContentResponse {
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
        page_count: rec.page_count,
        text_page_count: rec.text_page_count,
        image_only_page_count: rec.image_only_page_count,
        extract_failed_page_count: rec.extract_failed_page_count,
        pages: rec.pages,
        plain_text: rec.plain_text,
    })
}
