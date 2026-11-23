//! 文件摘要分页与筛选（契约 §1.3）。
//!
//! 对应现状：projectWorkspace.files（server/project.ts:174-207）去掉
//! revisions 数组的分页版。排序固化为 relative_path ASC + file_id ASC
//! （契约 §1.3：现状 listFiles 无排序保证，v1 固化为可稳定分页的序）。
//!
//! 口径决定（批次一，见返回说明）：列表与 facets 的基础集合为 active 文件
//! （与 projectWorkspace.files 的现状投影一致）；bootstrap.files_total 同口径。

use std::collections::HashMap;

use rusqlite::types::Value;

use super::sql_text;
use rusqlite::params_from_iter;

use crate::dto::{FileFacets, FileSummary, FileSummaryPage};
use crate::error::GuanlanError;
use crate::query::cursor::{
    cursor_stale_fingerprint, cursor_stale_snapshot, decode_key_cursor, encode_key_cursor,
    files_fingerprint,
};
use crate::query::FileListQuery;
use crate::storage::{file_row, internal_sql, ReadonlyStore, RevisionRow};

/// 内联上限（project.ts:25 INLINE_LIMIT_BYTES）：coverage 判定与 SVG 内联只读
/// 该上限以内的快照，超过者按 filename_only / 不内联处理（与现状一致）
pub(crate) const INLINE_LIMIT_BYTES: i64 = 256 * 1024;

/// folderOf（project.ts:50-54）：反斜杠归一为正斜杠后取最后一段之前的部分；
/// 无分隔符返回 '.'
pub(crate) fn folder_of(relative_path: &str) -> String {
    let rel = relative_path.replace('\\', "/");
    match rel.rfind('/') {
        Some(idx) => rel[..idx].to_owned(),
        None => ".".to_owned(),
    }
}

/// titleOf（project.ts:56-59）：取路径末段并去掉 .md/.markdown/.svg/.pdf 扩展名
/// （大小写无关）
pub(crate) fn title_of(relative_path: &str) -> String {
    let base = relative_path
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(relative_path)
        .to_owned();
    let lower = base.to_lowercase();
    for ext in [".md", ".markdown", ".svg", ".pdf"] {
        if lower.ends_with(ext) {
            return base[..base.len() - ext.len()].to_owned();
        }
    }
    base
}

/// svgHasText（project.ts:61-63）：`/<text[\s>]/i`
pub(crate) fn svg_has_text(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0usize;
    while let Some(pos) = find_sub(&bytes[from..], b"<text") {
        let after = from + pos + 5;
        match bytes.get(after) {
            Some(&c) if c == b'>' || c.is_ascii_whitespace() => return true,
            None => return false,
            _ => from = after,
        }
    }
    false
}

/// extractSvgText（project.ts:433-448）：`/<text[^>]*>([\s\S]*?)<\/text>/gi`，
/// 去内嵌标签、实体回替、trim
/// 字节序列查找（全部按 ASCII 模式匹配，边界安全）
fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// 当前版快照的 utf-8 文本（project.ts:124-130 readRevisionText 的读取侧等价物）：
/// snapshot_available=0 / 超内联上限 / 磁盘缺失 → None。只读 ≤256KiB 的小快照，
/// 不整读大文件。
pub(crate) fn inline_revision_text(store: &ReadonlyStore, rev: &RevisionRow) -> Option<String> {
    if rev.snapshot_available == 0 {
        return None;
    }
    if rev.size_bytes > INLINE_LIMIT_BYTES {
        return None;
    }
    // issue #36：非法 hash 走「不可读」分支（不 panic、不猜路径）
    let bytes = std::fs::read(store.blob_path_for(&rev.content_hash).ok()?).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// coverage 判定（project.ts:180-187）：md=当前版快照可读→full_text；
/// svg=含<text>→svg_text；B04 起 pdf=L2 页级抽取 page_indexed→pdf_page_text，否则 filename_only。
///
/// issue #19：不再逐页整读正文——
/// - stat 门禁先行：snapshot_available=0 / 超内联上限 / blob 缺失（外部删除）
///   直接判不可读，不发起了读取；
/// - 判定缓存按「format + content_hash」记忆（判定与格式相关；同格式同 hash
///   即同字节同判定），每个唯一内容只读一次；外部删除后 stat 失败即降级并
///   清除缓存项，不谎报可读。
fn coverage_of(store: &ReadonlyStore, format: &str, current: Option<&RevisionRow>) -> String {
    let Some(rev) = current else {
        return "filename_only".to_owned();
    };
    if rev.snapshot_available == 0 {
        return "filename_only".to_owned();
    }
    // B03：受支持的结构化 Office 文档（.docx / .xlsx）在 snapshot_available != 0 时不受
    // INLINE_LIMIT_BYTES (256KiB) 限制，只要 L2 抽取状态为 indexed 即判 office_structured。
    if matches!(format, "docx" | "docm" | "dotx" | "xlsx" | "xlsm" | "xltx") {
        if let Some(status) = crate::query::office::cached_office_status(store, &rev.content_hash) {
            return if status == "indexed" {
                "office_structured".to_owned()
            } else {
                "filename_only".to_owned()
            };
        }
        let rec = crate::query::office::load_office_extract_for_revision(store, format, rev);
        return if rec.status == "indexed" {
            "office_structured".to_owned()
        } else {
            "filename_only".to_owned()
        };
    }
    // B04：文本型 PDF 在 snapshot_available != 0 时不受 INLINE_LIMIT_BYTES 限制，
    // 只要 L2 页级抽取状态为 page_indexed 即判 pdf_page_text；扫描件/解析失败如实降级。
    if format == "pdf" {
        if let Some(status) = crate::query::pdf::cached_pdf_status(store, &rev.content_hash) {
            return if status == "page_indexed" {
                "pdf_page_text".to_owned()
            } else {
                "filename_only".to_owned()
            };
        }
        let rec = crate::query::pdf::load_pdf_extract_for_revision(store, rev);
        return if rec.status == "page_indexed" {
            "pdf_page_text".to_owned()
        } else {
            "filename_only".to_owned()
        };
    }
    if rev.size_bytes > INLINE_LIMIT_BYTES {
        return "filename_only".to_owned();
    }
    // md/svg 之外的格式不读快照也不进缓存（判定恒 filename_only，缓存只服务 md/svg）
    if format != "md" && format != "svg" {
        return "filename_only".to_owned();
    }
    let cache_key = format!("{format}\u{0}{}", rev.content_hash);
    let Ok(blob_path) = store.blob_path_for(&rev.content_hash) else {
        // issue #36：异常库里的非法 hash —— 如实判不可读，不让路径拼接崩进程
        return "filename_only".to_owned();
    };
    if std::fs::metadata(&blob_path).is_err() {
        // 快照被外部清理：清除该内容的记忆（若曾读过），如实降级
        coverage_cache()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&cache_key);
        return "filename_only".to_owned();
    }
    let cache = coverage_cache().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(cached) = cache.get(&cache_key) {
        return cached.clone();
    }
    drop(cache);
    let verdict = match format {
        "md" => match inline_revision_text(store, rev) {
            Some(_) => "full_text".to_owned(),
            None => "filename_only".to_owned(),
        },
        // svg 已由外层格式门禁限定
        _ => match inline_revision_text(store, rev) {
            Some(text) if svg_has_text(&text) => "svg_text".to_owned(),
            _ => "filename_only".to_owned(),
        },
    };
    let mut cache = coverage_cache().lock().unwrap_or_else(|p| p.into_inner());
    if cache.len() >= COVERAGE_CACHE_CAPACITY && !cache.contains_key(&cache_key) {
        // Map 迭代序=插入序：逐出最旧（会话级缓存，容量防极端增长）
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(cache_key, verdict.clone());
    verdict
}

/// coverage 判定缓存（issue #19）：content_hash → 判定（内容寻址，同 hash 同字节）
fn coverage_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// coverage 缓存容量（唯一内容数上限；超出按插入序逐最旧）
const COVERAGE_CACHE_CAPACITY: usize = 8192;

/// facets 缓存（issue #21，issue #33 加固）：workspace_id → (generation, active 计数, facets)。
/// facets 只依赖完整 active 集合；命中时要求代际与 active 计数都一致——同代际内的
/// 数据漂移（外部提交未 bump generation）也能被廉价计数识别并重算。
type FacetsCache = std::sync::Mutex<std::collections::HashMap<String, (i64, i64, FileFacets)>>;

fn facets_cache() -> &'static FacetsCache {
    static CACHE: std::sync::OnceLock<FacetsCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 归一化相对路径的 SQL 表达式（current_path 里可能存反斜杠，排序/筛选统一按
/// 正斜杠口径；SQLite 字符串字面量中反斜杠无转义含义）
const NORM_EXPR: &str = "REPLACE(f.current_path, '\\', '/')";

/// 目录前缀筛选（契约 §1.3：dir=目录前缀，含子目录；'.' 表示工作区根的散文件）
fn dir_clause(dir: &str) -> Option<(String, Vec<Value>)> {
    let dir = dir.replace('\\', "/");
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        return None;
    }
    if dir == "." {
        return Some((format!("({NORM_EXPR} NOT LIKE ?)"), vec![sql_text("%/%")]));
    }
    // LIKE 通配符转义（用户输入的 % _ \ 按字面匹配）
    let mut escaped = String::with_capacity(dir.len());
    for ch in dir.chars() {
        if ch == '%' || ch == '_' || ch == '\\' {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    Some((
        format!("({NORM_EXPR} LIKE ? ESCAPE '\\')"),
        vec![Value::from(format!("{escaped}/%"))],
    ))
}

/// 文件摘要分页（契约 §1.3；排序 relative_path ASC，游标键 (relative_path, file_id)）
/// issue #33：短读事务包装——generation 与 count/items/facets 在同一快照内读取。
pub fn list_files(
    store: &ReadonlyStore,
    query: &FileListQuery,
) -> Result<FileSummaryPage, GuanlanError> {
    store.read_txn(|_conn| list_files_tx(store, query))
}

/// 事务内执行体（bootstrap 等已持有读事务的调用方直接用本函数，避免嵌套）。
pub fn list_files_tx(
    store: &ReadonlyStore,
    query: &FileListQuery,
) -> Result<FileSummaryPage, GuanlanError> {
    let ws = store.workspace()?.clone();
    let ws_id = ws.workspace_id.as_str();
    let conn = store.conn();
    let limit = crate::query::cursor::clamp_limit(query.limit, 100, 500);
    let fp = files_fingerprint(query);
    let current_gen = ws.index_generation as i64;

    let cursor = match query.cursor.as_deref() {
        Some(raw) if !raw.is_empty() => Some(decode_key_cursor(raw)?),
        _ => None,
    };
    // 续页代际校验（契约 §1.3：snapshot_generation != 当前代际 → CURSOR_STALE）
    if let Some(c) = &cursor {
        if c.snap != current_gen {
            return Err(cursor_stale_snapshot());
        }
        if c.fp != fp {
            return Err(cursor_stale_fingerprint());
        }
    }
    let snapshot_generation = cursor.as_ref().map_or(current_gen, |c| c.snap) as u64;

    // 过滤构建（契约 §1.3 参数表：dir/format/matter/q；A05 扩展可选 status）
    let mut clauses: Vec<String> = vec!["f.workspace_id = ?".to_owned()];
    let mut params: Vec<Value> = vec![sql_text(ws_id)];
    match crate::query::cursor::non_empty(&query.status) {
        None | Some("active") => {
            clauses.push("f.status = 'active'".to_owned());
        }
        Some("trashed") => {
            clauses.push("f.status = 'trashed'".to_owned());
        }
        Some("missing") => {
            clauses.push("f.status = 'missing'".to_owned());
        }
        Some("recoverable") => {
            clauses.push("f.status IN ('missing', 'trashed')".to_owned());
        }
        Some("all") => {}
        Some(_) => {
            clauses.push("f.status = 'active'".to_owned());
        }
    }
    if let Some(dir) = crate::query::cursor::non_empty(&query.dir) {
        if let Some((clause, mut vals)) = dir_clause(dir) {
            clauses.push(clause);
            params.append(&mut vals);
        }
    }
    if let Some(fmt) = crate::query::cursor::non_empty(&query.format) {
        if let Some(target_class) = fmt.strip_prefix("class:") {
            let mut fstmt = conn
                .prepare("SELECT DISTINCT format FROM files WHERE workspace_id = ?")
                .map_err(internal_sql)?;
            let distinct: Vec<String> = fstmt
                .query_map([ws_id], |r| r.get::<_, String>(0))
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?;
            let matched: Vec<String> = distinct
                .into_iter()
                .filter(|tok| {
                    crate::index::file_format::class_of_token(tok).as_str() == target_class
                })
                .collect();
            if matched.is_empty() {
                clauses.push("1 = 0".to_owned());
            } else {
                let ph = vec!["?"; matched.len()].join(",");
                clauses.push(format!("f.format IN ({ph})"));
                for tok in matched {
                    params.push(sql_text(tok));
                }
            }
        } else {
            clauses.push("f.format = ?".to_owned());
            params.push(sql_text(fmt));
        }
    }
    if let Some(matter) = crate::query::cursor::non_empty(&query.matter) {
        clauses.push("f.role = ?".to_owned());
        params.push(sql_text(matter));
    }
    if let Some(q) = crate::query::cursor::non_empty(&query.q) {
        // 关键字：标题或路径 LIKE（现状口径，无通配符转义）
        clauses.push(format!("(f.title LIKE ? OR {NORM_EXPR} LIKE ?)"));
        params.push(Value::from(format!("%{q}%")));
        params.push(Value::from(format!("%{q}%")));
    }

    // 与筛选同口径的计数（契约 §1.3 total_matched）：不含游标条件，
    // 在追加游标条件之前先备份筛选参数
    let filter_clauses = clauses.clone();
    let filter_params = params.clone();

    if let Some(c) = &cursor {
        // 键集分页：(relative_path, file_id) > (k, s)
        clauses.push(format!(
            "({NORM_EXPR} > ? OR ({NORM_EXPR} = ? AND f.file_id > ?))"
        ));
        params.push(Value::from(c.k.clone()));
        params.push(Value::from(c.k.clone()));
        params.push(Value::from(c.s.clone()));
    }

    let page_sql = format!(
        "SELECT f.* FROM files f WHERE {} \
         ORDER BY {NORM_EXPR} ASC, f.file_id ASC \
         LIMIT ?",
        clauses.join(" AND ")
    );
    let mut page_params = params;
    page_params.push(Value::from((limit + 1) as i64));
    let mut stmt = conn.prepare(&page_sql).map_err(internal_sql)?;
    let mut files: Vec<_> = stmt
        .query_map(params_from_iter(page_params.iter()), file_row)
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    let has_more = files.len() > limit as usize;
    if has_more {
        files.truncate(limit as usize);
    }

    // 页内文件的版本必需信息（issue #19：不构造页内文件全部 RevisionRow，
    // 三组有界集合查询按需取数，历史增长不使摘要对象随完整版本链增长）
    let placeholders = vec!["?"; files.len()].join(",");
    let file_ids: Vec<Value> = files.iter().map(|f| sql_text(f.file_id.as_str())).collect();

    // ① 精确版本计数：COUNT(*) GROUP BY（不用 MAX(seq) 冒充，seq 空洞下仍准确）
    let mut counts: HashMap<String, i64> = HashMap::new();
    if !files.is_empty() {
        let count_sql = format!(
            "SELECT file_id, COUNT(*) FROM revisions WHERE file_id IN ({placeholders}) GROUP BY file_id"
        );
        let mut stmt = conn.prepare(&count_sql).map_err(internal_sql)?;
        let rows = stmt
            .query_map(params_from_iter(file_ids.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        counts.extend(rows);
    }

    // ② 首版行：MIN(seq)（不用 MIN(occurred_at) 冒充首版时间——seq 是修订链顺序）
    let mut firsts: HashMap<String, (String, Option<String>)> = HashMap::new();
    if !files.is_empty() {
        let first_sql = format!(
            "SELECT r.file_id, r.revision_id, r.occurred_at FROM revisions r \
             JOIN (SELECT file_id, MIN(seq) AS seq FROM revisions WHERE file_id IN ({placeholders}) GROUP BY file_id) m \
               ON m.file_id = r.file_id AND m.seq = r.seq"
        );
        let mut stmt = conn.prepare(&first_sql).map_err(internal_sql)?;
        let rows = stmt
            .query_map(params_from_iter(file_ids.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        firsts.extend(rows.into_iter().map(|(fid, rid, occ)| (fid, (rid, occ))));
    }

    // ③ 当前行：last_revision_id 命中优先（project.ts:176-178 同口径），
    //    未命中的文件回退最高 seq（防御悬空指针/缺失回填）
    let last_ids: Vec<Value> = files
        .iter()
        .filter_map(|f| f.last_revision_id.as_deref().map(sql_text))
        .collect();
    let mut currents: HashMap<String, RevisionRow> = HashMap::new();
    if !last_ids.is_empty() {
        let cur_sql = format!(
            "SELECT * FROM revisions WHERE revision_id IN ({})",
            vec!["?"; last_ids.len()].join(",")
        );
        let mut stmt = conn.prepare(&cur_sql).map_err(internal_sql)?;
        let rows = stmt
            .query_map(
                params_from_iter(last_ids.iter()),
                crate::storage::revision_row,
            )
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for rev in rows {
            currents.insert(rev.file_id.clone(), rev);
        }
    }
    let fallback_files: Vec<Value> = files
        .iter()
        .filter(|f| {
            f.last_revision_id.is_none()
                || currents
                    .get(f.file_id.as_str())
                    .map(|c| Some(&c.revision_id) != f.last_revision_id.as_ref())
                    .unwrap_or(true)
        })
        .map(|f| sql_text(f.file_id.as_str()))
        .collect();
    if !fallback_files.is_empty() {
        let fb_sql = format!(
            "SELECT r.* FROM revisions r \
             JOIN (SELECT file_id, MAX(seq) AS seq FROM revisions WHERE file_id IN ({}) GROUP BY file_id) m \
               ON m.file_id = r.file_id AND m.seq = r.seq",
            vec!["?"; fallback_files.len()].join(",")
        );
        let mut stmt = conn.prepare(&fb_sql).map_err(internal_sql)?;
        let rows = stmt
            .query_map(
                params_from_iter(fallback_files.iter()),
                crate::storage::revision_row,
            )
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for rev in rows {
            currents.insert(rev.file_id.clone(), rev);
        }
    }

    let items: Vec<FileSummary> = files
        .iter()
        .map(|f| {
            // 现行投影 current（project.ts:176-178）：last_revision_id 命中用之，
            // 否则取最高 seq 版
            let current = currents.get(f.file_id.as_str());
            let title = if f.title.is_empty() {
                title_of(&f.current_path)
            } else {
                f.title.clone()
            };
            FileSummary {
                file_id: f.file_id.clone(),
                relative_path: f.current_path.clone(),
                title,
                format: f.format.clone(),
                folder: folder_of(&f.current_path),
                role: f.role.clone(),
                status: f.status.clone(),
                current_revision_id: Some(
                    current
                        .map(|r| r.revision_id.clone())
                        .or_else(|| f.last_revision_id.clone())
                        .unwrap_or_default(),
                ),
                revision_count: counts.get(f.file_id.as_str()).copied().unwrap_or(0).max(0) as u64,
                first_observed_at: f.first_observed_at.clone(),
                last_observed_at: f.last_observed_at.clone(),
                // 最早版本发生时间：MIN(seq) 首版行的 occurred_at（契约 §1.3/§5 风险 1）
                first_source_time: firsts
                    .get(f.file_id.as_str())
                    .and_then(|(_, occ)| occ.clone()),
                coverage: coverage_of(store, &f.format, current),
                // B04：PDF 徽标改为真实缓存状态（page_indexed/image_only/ocr_pending/
                // extract_failed/encrypted/corrupted/metadata_only），未入库时仍报 unindexed
                pdf_status: if f.format == "pdf" {
                    Some(match current {
                        Some(rev) => crate::query::pdf::cached_pdf_status(store, &rev.content_hash)
                            .unwrap_or_else(|| "unindexed".to_owned()),
                        None => "unindexed".to_owned(),
                    })
                } else {
                    None
                },
                snapshot_available: current.map(|r| r.snapshot_available != 0).unwrap_or(false),
            }
        })
        .collect();

    // 与筛选同口径的全量计数（不含游标条件）
    let count_sql = format!(
        "SELECT COUNT(*) AS n FROM files f WHERE {}",
        filter_clauses.join(" AND ")
    );
    let mut count_stmt = conn.prepare(&count_sql).map_err(internal_sql)?;
    let total_matched: i64 = count_stmt
        .query_row(params_from_iter(filter_params.iter()), |r| r.get(0))
        .map_err(internal_sql)?;

    // 侧栏筛选项计数（契约 §1.3 facets）：active 基础集合上的目录/格式/事项分布。
    // issue #21：facets 只依赖完整 active 集合与代际（writer 每次提交 bump
    // generation），按 workspace+generation 缓存复用——不再每页全量重读全部
    // 活跃文件（此前 Θ(F²/p) 的分页累计主因）；口径不变：仍是全集分布，
    // 不是当前页/当前筛选子集。
    let facets = {
        let current_gen = ws.index_generation as i64;
        // issue #33：同代际内也可能存在「数据变、generation 未变」的外部提交
        // （旧 Node writer 未按契约同事务 bump，或同代内补写）。缓存命中时用一次
        // 索引计数（idx_files_ws 上的 COUNT，O(log n)）核对 active 集合规模，
        // 规模不符即视为漂移并重算——不依赖「写者必然 bump generation」的假设。
        let active_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE workspace_id = ? AND status = 'active'",
                [ws_id],
                |r| r.get(0),
            )
            .map_err(internal_sql)?;
        let cached = {
            let mut cache = facets_cache().lock().unwrap_or_else(|p| p.into_inner());
            match cache.get(ws_id) {
                Some((gen, count, facets)) if *gen == current_gen && *count == active_count => {
                    Some(facets.clone())
                }
                Some(_) => {
                    cache.remove(ws_id);
                    None
                }
                None => None,
            }
        };
        match cached {
            Some(facets) => facets,
            None => {
                let facet_sql = format!(
                    "SELECT {NORM_EXPR} AS norm_path, f.format AS format, f.role AS role \
                     FROM files f WHERE f.workspace_id = ? AND f.status = 'active'"
                );
                let mut facet_stmt = conn.prepare(&facet_sql).map_err(internal_sql)?;
                let facet_rows = facet_stmt
                    .query_map([ws_id], |row| {
                        Ok((
                            row.get::<_, String>("norm_path")?,
                            row.get::<_, String>("format")?,
                            row.get::<_, String>("role")?,
                        ))
                    })
                    .map_err(internal_sql)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(internal_sql)?;
                let mut computed = FileFacets::default();
                for (norm_path, format, role) in facet_rows {
                    let folder = match norm_path.rfind('/') {
                        Some(idx) => norm_path[..idx].to_owned(),
                        None => ".".to_owned(),
                    };
                    *computed.folders.entry(folder).or_insert(0) += 1;
                    *computed.formats.entry(format).or_insert(0) += 1;
                    *computed.matters.entry(role).or_insert(0) += 1;
                }
                facets_cache()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(
                        ws_id.to_owned(),
                        (current_gen, active_count, computed.clone()),
                    );
                computed
            }
        }
    };

    let next_cursor = has_more.then(|| {
        let last = items.last().expect("has_more 时必有页尾行");
        encode_key_cursor(&crate::query::cursor::KeyCursor {
            snap: snapshot_generation as i64,
            k: last.relative_path.replace('\\', "/"),
            s: last.file_id.clone(),
            fp: fp.clone(),
            // files/decisions 不使用 total（issue #24 仅版本链游标携带），序列化时省略
            total: None,
        })
    });

    Ok(FileSummaryPage {
        ok: true,
        index_generation: ws.index_generation,
        snapshot_generation,
        items,
        next_cursor,
        has_more,
        total_matched: total_matched.max(0) as u64,
        facets,
    })
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
