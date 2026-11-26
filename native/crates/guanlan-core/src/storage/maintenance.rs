//! 全量开放导出、决定证据铁律保护存储瘦身（GC）、全量 SHA-256 完整性核验与一键脱敏诊断包 ZIP。
//!
//! 停机红线：
//! 1. **决定证据铁律保护**：任何被 `statements`、`edges`（`source_revision_id`/`target_revision_id`）、
//!    治理/拍板/采纳/检查点关键 `events`、`artifact_states.selected_revision_id`、待处理 `revision_drafts`、
//!    文件首版基线（`seq = 1`）或最新当前版（`files.last_revision_id`）引用的历史版本快照，GC **绝不误删**；
//!    即使某过程版本被瘦身，只要其 `content_hash` 仍被任一受保护/保留版本共享，物理 blob 文件也绝不删除！
//! 2. **100% 诚实完整性诊断**：`verify_blobs_integrity` 对全部活跃快照逐份流式计算 SHA-256，发现缺失或哈希失配时
//!    100% 诚实报告受损 blob 影响的文件路径、版本号、关联决定与事件数，绝不静默跳过或掩盖。
//! 3. **零锁定全量开放导出**：随时将全部历史去重快照与 JSONL/Markdown 事件/决定/因果边/路径别名账本导出到开放目录。
//! 4. **一键脱敏运行诊断包 ZIP**：零额外 crate 依赖（复用已有 `flate2` DEFLATE + CRC32）生成标准 PKWARE ZIP，
//!    自动脱敏工作区绝对路径、数据目录、用户主目录及一切密钥/凭据片段。

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::application::context::sanitize_context_text;
use crate::error::GuanlanError;
use crate::index::clock;
use crate::index::ident::stable_key;
use crate::index::writer::{NewEvent, Writer};
use crate::storage::ledger::verify_decision_ledger;
use crate::storage::sandbox::audit_workspace_file_paths;
use crate::storage::{internal_sql, ReadonlyStore};

/// 工作区全量开放导出协议版本
pub const OPEN_EXPORT_SCHEMA_VERSION: &str = "guanlan.open_export.v1";

const PROTECTED_GOVERNANCE_EVENT_KINDS: &[&str] = &[
    "decision_detected",
    "decision_confirmed",
    "decision_resolved",
    "decision_reopened",
    "decision_superseded",
    "proposal_adopted",
    "proposal_dismissed",
    "checkpoint_created",
    "initiative_archived",
    "initiative_reopened",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImpactedRevisionRef {
    pub file_id: String,
    pub relative_path: String,
    pub revision_id: String,
    pub seq: i64,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImpactedDecisionRef {
    pub statement_id: String,
    pub code: String,
    pub status: String,
    pub question: String,
    pub relative_path: String,
    pub line_start: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorruptedBlobImpact {
    pub content_hash: String,
    /// `missing` | `hash_mismatch` | `read_error`
    pub issue_kind: String,
    pub detail: String,
    pub expected_bytes: u64,
    pub actual_bytes: Option<u64>,
    pub actual_hash: Option<String>,
    pub impacted_revisions: Vec<ImpactedRevisionRef>,
    pub impacted_decisions: Vec<ImpactedDecisionRef>,
    pub impacted_event_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobIntegrityReport {
    pub ok: bool,
    pub verified_at: String,
    pub checked_blobs: usize,
    pub healthy_blobs: usize,
    pub corrupted_count: usize,
    pub missing_count: usize,
    pub orphan_blob_count: usize,
    pub orphan_blob_bytes: u64,
    pub total_verified_bytes: u64,
    pub impacts: Vec<CorruptedBlobImpact>,
}

fn sha256_file_streaming(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.saturating_add(n as u64);
    }
    Ok((hex::encode(hasher.finalize()), total))
}

fn collect_disk_blob_files(blobs_dir: &Path) -> Vec<(String, PathBuf, u64)> {
    let mut out = Vec::new();
    if !blobs_dir.is_dir() {
        return out;
    }
    let Ok(buckets) = fs::read_dir(blobs_dir) else {
        return out;
    };
    for bucket in buckets.flatten() {
        let bpath = bucket.path();
        if !bpath.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&bpath) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push((name.to_owned(), p, size));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// 校验当前工作区全部活跃快照（`snapshot_available = 1`）与 `blobs` 表登记文件的 SHA-256 完整性，
/// 并 100% 诚实报告每条受损/缺失 blob 影响的全部文件、版本、决定证据与事件数量。
pub fn verify_blobs_integrity(store: &ReadonlyStore) -> Result<BlobIntegrityReport, GuanlanError> {
    let ws = store.workspace()?;
    verify_blobs_integrity_on_conn(store.conn(), store.blobs_dir(), &ws.workspace_id)
}

pub(crate) fn verify_blobs_integrity_on_conn(
    conn: &Connection,
    blobs_dir: &Path,
    workspace_id: &str,
) -> Result<BlobIntegrityReport, GuanlanError> {
    let mut file_paths: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT file_id, current_path FROM files WHERE workspace_id = ?1")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (fid, path) = r.map_err(internal_sql)?;
            file_paths.insert(fid, path);
        }
    }

    let mut revs_by_hash: BTreeMap<String, Vec<ImpactedRevisionRef>> = BTreeMap::new();
    let mut expected_bytes_by_hash: HashMap<String, u64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT revision_id, file_id, seq, content_hash, size_bytes, observed_at
                   FROM revisions
                  WHERE workspace_id = ?1 AND snapshot_available = 1 AND content_hash <> ''
                  ORDER BY seq ASC, revision_id ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (rev_id, file_id, seq, hash, size_bytes, observed_at) = r.map_err(internal_sql)?;
            let rel = file_paths
                .get(&file_id)
                .cloned()
                .unwrap_or_else(|| file_id.clone());
            expected_bytes_by_hash
                .entry(hash.clone())
                .or_insert(size_bytes.max(0) as u64);
            revs_by_hash
                .entry(hash)
                .or_default()
                .push(ImpactedRevisionRef {
                    file_id,
                    relative_path: rel,
                    revision_id: rev_id,
                    seq,
                    observed_at,
                });
        }
    }

    let mut all_referenced_hashes: HashSet<String> = revs_by_hash.keys().cloned().collect();
    {
        let mut stmt = conn
            .prepare("SELECT content_hash, size_bytes FROM blobs")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (hash, size) = r.map_err(internal_sql)?;
            expected_bytes_by_hash
                .entry(hash.clone())
                .or_insert(size.max(0) as u64);
            if revs_by_hash.contains_key(&hash) {
                all_referenced_hashes.insert(hash);
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare(
        "SELECT proposed_content_hash FROM revision_drafts WHERE workspace_id = ?1 AND status IN ('proposed', 'pending', 'conflict')",
    ) {
        if let Ok(rows) = stmt.query_map(params![workspace_id], |row| row.get::<_, String>(0)) {
            for h in rows.flatten() {
                if !h.is_empty() {
                    all_referenced_hashes.insert(h);
                }
            }
        }
    }

    let mut checked_blobs: usize = 0;
    let mut healthy_blobs: usize = 0;
    let mut corrupted_count: usize = 0;
    let mut missing_count: usize = 0;
    let mut total_verified_bytes: u64 = 0;
    let mut impacts: Vec<CorruptedBlobImpact> = Vec::new();

    for (hash, impacted_revs) in &revs_by_hash {
        checked_blobs += 1;
        let expected_bytes = expected_bytes_by_hash.get(hash).copied().unwrap_or(0);
        let blob_path = if hash.len() >= 2 {
            blobs_dir.join(&hash[..2]).join(hash)
        } else {
            blobs_dir.join(hash)
        };

        if !blob_path.is_file() {
            missing_count += 1;
            let (decisions, event_count) =
                query_impacts_for_revisions(conn, workspace_id, impacted_revs, &file_paths)?;
            impacts.push(CorruptedBlobImpact {
                content_hash: hash.clone(),
                issue_kind: "missing".to_owned(),
                detail: format!(
                    "磁盘快照文件缺失（{}），影响 {} 个历史版本、{} 条决定证据、{} 条事件",
                    blob_path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(hash),
                    impacted_revs.len(),
                    decisions.len(),
                    event_count
                ),
                expected_bytes,
                actual_bytes: None,
                actual_hash: None,
                impacted_revisions: impacted_revs.clone(),
                impacted_decisions: decisions,
                impacted_event_count: event_count,
            });
            continue;
        }

        match sha256_file_streaming(&blob_path) {
            Ok((actual_hash, actual_bytes)) => {
                total_verified_bytes = total_verified_bytes.saturating_add(actual_bytes);
                if actual_hash.eq_ignore_ascii_case(hash) {
                    healthy_blobs += 1;
                } else {
                    corrupted_count += 1;
                    let (decisions, event_count) = query_impacts_for_revisions(
                        conn,
                        workspace_id,
                        impacted_revs,
                        &file_paths,
                    )?;
                    impacts.push(CorruptedBlobImpact {
                        content_hash: hash.clone(),
                        issue_kind: "hash_mismatch".to_owned(),
                        detail: format!(
                            "SHA-256 校验失败（期望 {}…，实测 {}…），影响 {} 个历史版本、{} 条决定证据",
                            &hash[..12.min(hash.len())],
                            &actual_hash[..12.min(actual_hash.len())],
                            impacted_revs.len(),
                            decisions.len()
                        ),
                        expected_bytes,
                        actual_bytes: Some(actual_bytes),
                        actual_hash: Some(actual_hash),
                        impacted_revisions: impacted_revs.clone(),
                        impacted_decisions: decisions,
                        impacted_event_count: event_count,
                    });
                }
            }
            Err(err) => {
                corrupted_count += 1;
                let (decisions, event_count) =
                    query_impacts_for_revisions(conn, workspace_id, impacted_revs, &file_paths)?;
                impacts.push(CorruptedBlobImpact {
                    content_hash: hash.clone(),
                    issue_kind: "read_error".to_owned(),
                    detail: format!("读取磁盘快照失败：{err}"),
                    expected_bytes,
                    actual_bytes: None,
                    actual_hash: None,
                    impacted_revisions: impacted_revs.clone(),
                    impacted_decisions: decisions,
                    impacted_event_count: event_count,
                });
            }
        }
    }

    let disk_blobs = collect_disk_blob_files(blobs_dir);
    let mut orphan_blob_count: usize = 0;
    let mut orphan_blob_bytes: u64 = 0;
    for (name, _path, size) in &disk_blobs {
        if !all_referenced_hashes.contains(name) {
            orphan_blob_count += 1;
            orphan_blob_bytes = orphan_blob_bytes.saturating_add(*size);
        }
    }

    Ok(BlobIntegrityReport {
        ok: corrupted_count == 0 && missing_count == 0,
        verified_at: clock::now_iso(),
        checked_blobs,
        healthy_blobs,
        corrupted_count,
        missing_count,
        orphan_blob_count,
        orphan_blob_bytes,
        total_verified_bytes,
        impacts,
    })
}

fn query_impacts_for_revisions(
    conn: &Connection,
    workspace_id: &str,
    revs: &[ImpactedRevisionRef],
    file_paths: &HashMap<String, String>,
) -> Result<(Vec<ImpactedDecisionRef>, usize), GuanlanError> {
    let mut decisions = Vec::new();
    let mut seen_stmt: HashSet<String> = HashSet::new();
    let mut event_count: usize = 0;

    let mut stmt_q = conn
        .prepare(
            "SELECT statement_id, code, status, question, file_id, line_start
               FROM statements
              WHERE workspace_id = ?1 AND revision_id = ?2
              ORDER BY line_start ASC",
        )
        .map_err(internal_sql)?;
    let mut ev_q = conn
        .prepare("SELECT COUNT(*) FROM events WHERE workspace_id = ?1 AND revision_id = ?2")
        .map_err(internal_sql)?;

    for rev in revs {
        let rows = stmt_q
            .query_map(params![workspace_id, &rev.revision_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (sid, code, status, question, fid, line_start) = r.map_err(internal_sql)?;
            if seen_stmt.insert(sid.clone()) {
                decisions.push(ImpactedDecisionRef {
                    statement_id: sid,
                    code,
                    status,
                    question,
                    relative_path: file_paths
                        .get(&fid)
                        .cloned()
                        .unwrap_or_else(|| rev.relative_path.clone()),
                    line_start,
                });
            }
        }
        let cnt: i64 = ev_q
            .query_row(params![workspace_id, &rev.revision_id], |r| r.get(0))
            .map_err(internal_sql)?;
        event_count = event_count.saturating_add(cnt.max(0) as usize);
    }

    Ok((decisions, event_count))
}

fn default_older_than_days() -> u32 {
    30
}

fn default_keep_recent_per_file() -> u32 {
    3
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageGcRequest {
    /// 清理超过该天数的非关键过程快照（默认 30 天；传 0 表示立即清理全部超额非受保护过程快照）
    #[serde(default = "default_older_than_days")]
    pub older_than_days: u32,
    /// 每个文件额外保留的最新版本数量（默认 3，最小 1）
    #[serde(default = "default_keep_recent_per_file")]
    pub keep_recent_per_file: u32,
    /// 是否同时清理磁盘上无任何版本引用的孤儿 blob（默认 true）
    #[serde(default = "default_true")]
    pub remove_orphan_blobs: bool,
    /// 预演模式（默认 true，不改库不删盘；确认后显式传 false 执行真正瘦身）
    #[serde(default = "default_true")]
    pub dry_run: bool,
}

impl Default for StorageGcRequest {
    fn default() -> Self {
        Self {
            older_than_days: 30,
            keep_recent_per_file: 3,
            remove_orphan_blobs: true,
            dry_run: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GcPrunedRevisionSample {
    pub file_id: String,
    pub relative_path: String,
    pub revision_id: String,
    pub seq: i64,
    pub observed_at: String,
    pub size_bytes: u64,
    pub blob_shared_retained: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageGcResponse {
    pub ok: bool,
    pub dry_run: bool,
    pub older_than_days: u32,
    pub keep_recent_per_file: u32,
    pub total_revisions_with_snapshot: usize,
    pub protected_revisions_count: usize,
    /// 铁律保护：被 statements（决定/结论）锚定的历史版本数
    pub protected_decision_evidence_count: usize,
    /// 铁律保护：被 edges（因果/引用边）锚定的历史版本数
    pub protected_edge_evidence_count: usize,
    /// 铁律保护：被治理/拍板/检查点事件锚定的历史版本数
    pub protected_governance_event_count: usize,
    pub pruned_revisions_count: usize,
    pub deleted_blobs_count: usize,
    pub deleted_orphan_blobs_count: usize,
    /// 因与其他受保护版本共享去重内容哈希而跳过物理删盘的次数
    pub skipped_shared_blob_count: usize,
    pub reclaimed_bytes: u64,
    pub protected_bytes: u64,
    pub pruned_samples: Vec<GcPrunedRevisionSample>,
}

struct GcPlan {
    summary: StorageGcResponse,
    pruned_revision_ids: Vec<String>,
    hashes_to_delete: Vec<String>,
    orphan_files_to_delete: Vec<(String, PathBuf, u64)>,
}

fn parse_iso_epoch_secs(iso: &str) -> Option<i64> {
    let s = iso.trim();
    if s.len() < 10 {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (hh, mm, ss) = if s.len() >= 19 {
        (
            s.get(11..13)?.parse::<i64>().ok().unwrap_or(0),
            s.get(14..16)?.parse::<i64>().ok().unwrap_or(0),
            s.get(17..19)?.parse::<i64>().ok().unwrap_or(0),
        )
    } else {
        (0, 0, 0)
    };
    let days = days_from_civil(y, m, d);
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m64 = m as u64;
    let doy = (153 * (if m64 > 2 { m64 - 3 } else { m64 + 9 }) + 2) / 5 + (d as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

fn build_gc_plan(
    conn: &Connection,
    blobs_dir: &Path,
    workspace_id: &str,
    req: &StorageGcRequest,
    now_epoch_secs: i64,
) -> Result<GcPlan, GuanlanError> {
    let keep_recent = req.keep_recent_per_file.max(1);
    let cutoff_secs = now_epoch_secs.saturating_sub(i64::from(req.older_than_days) * 86_400);

    let mut file_paths: HashMap<String, String> = HashMap::new();
    let mut latest_rev_ids: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT file_id, current_path, last_revision_id FROM files WHERE workspace_id = ?1",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (fid, path, last_rev) = r.map_err(internal_sql)?;
            file_paths.insert(fid, path);
            if let Some(lr) = last_rev {
                latest_rev_ids.insert(lr);
            }
        }
    }

    let mut decision_evidence_revs: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT DISTINCT revision_id FROM statements WHERE workspace_id = ?1 AND revision_id <> ''")
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| row.get::<_, String>(0))
            .map_err(internal_sql)?;
        for r in rows {
            decision_evidence_revs.insert(r.map_err(internal_sql)?);
        }
    }

    let mut edge_evidence_revs: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT source_revision_id, target_revision_id
                   FROM edges
                  WHERE workspace_id = ?1",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (src, tgt) = r.map_err(internal_sql)?;
            if !src.is_empty() {
                edge_evidence_revs.insert(src);
            }
            if let Some(t) = tgt.filter(|s| !s.is_empty()) {
                edge_evidence_revs.insert(t);
            }
        }
    }

    let mut governance_event_revs: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT kind, revision_id
                   FROM events
                  WHERE workspace_id = ?1 AND revision_id IS NOT NULL AND revision_id <> ''",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (kind, rev_id) = r.map_err(internal_sql)?;
            if PROTECTED_GOVERNANCE_EVENT_KINDS.contains(&kind.as_str()) {
                governance_event_revs.insert(rev_id);
            }
        }
    }

    let mut extra_protected_revs: HashSet<String> = HashSet::new();
    let mut draft_protected_hashes: HashSet<String> = HashSet::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT selected_revision_id FROM artifact_states WHERE workspace_id = ?1 AND selected_revision_id IS NOT NULL",
    ) {
        if let Ok(rows) = stmt.query_map(params![workspace_id], |r| r.get::<_, String>(0)) {
            for rev in rows.flatten() {
                extra_protected_revs.insert(rev);
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare(
        "SELECT output_revision_id FROM checkpoints WHERE workspace_id = ?1 AND output_revision_id IS NOT NULL",
    ) {
        if let Ok(rows) = stmt.query_map(params![workspace_id], |r| r.get::<_, String>(0)) {
            for rev in rows.flatten() {
                extra_protected_revs.insert(rev);
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare(
        "SELECT base_revision_id, proposed_content_hash FROM revision_drafts WHERE workspace_id = ?1 AND status IN ('proposed', 'pending', 'conflict')",
    ) {
        if let Ok(rows) = stmt.query_map(params![workspace_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            for (base_rev, prop_hash) in rows.flatten() {
                if !base_rev.is_empty() {
                    extra_protected_revs.insert(base_rev);
                }
                if !prop_hash.is_empty() {
                    draft_protected_hashes.insert(prop_hash);
                }
            }
        }
    }

    #[derive(Clone)]
    struct RevSnap {
        revision_id: String,
        file_id: String,
        seq: i64,
        content_hash: String,
        size_bytes: u64,
        observed_at: String,
    }

    let mut by_file: BTreeMap<String, Vec<RevSnap>> = BTreeMap::new();
    let mut total_revisions_with_snapshot: usize = 0;
    {
        let mut stmt = conn
            .prepare(
                "SELECT revision_id, file_id, seq, content_hash, size_bytes, observed_at
                   FROM revisions
                  WHERE workspace_id = ?1 AND snapshot_available = 1 AND content_hash <> ''
                  ORDER BY file_id ASC, seq DESC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(RevSnap {
                    revision_id: row.get(0)?,
                    file_id: row.get(1)?,
                    seq: row.get(2)?,
                    content_hash: row.get(3)?,
                    size_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                    observed_at: row.get(5)?,
                })
            })
            .map_err(internal_sql)?;
        for r in rows {
            let rev = r.map_err(internal_sql)?;
            total_revisions_with_snapshot += 1;
            by_file.entry(rev.file_id.clone()).or_default().push(rev);
        }
    }

    let mut retained_hashes: HashSet<String> = draft_protected_hashes;
    let mut protected_revisions_count: usize = 0;
    let mut protected_decision_evidence_count: usize = 0;
    let mut protected_edge_evidence_count: usize = 0;
    let mut protected_governance_event_count: usize = 0;

    let mut candidate_prunes: Vec<RevSnap> = Vec::new();
    let mut retained_revs: Vec<RevSnap> = Vec::new();

    for revs in by_file.values() {
        for (idx_from_latest, rev) in revs.iter().enumerate() {
            let is_baseline = rev.seq == 1;
            let is_latest = latest_rev_ids.contains(&rev.revision_id);
            let is_recent = idx_from_latest < (keep_recent as usize);
            let is_decision_ev = decision_evidence_revs.contains(&rev.revision_id);
            let is_edge_ev = edge_evidence_revs.contains(&rev.revision_id);
            let is_gov_ev = governance_event_revs.contains(&rev.revision_id);
            let is_extra = extra_protected_revs.contains(&rev.revision_id);

            if is_decision_ev {
                protected_decision_evidence_count += 1;
            }
            if is_edge_ev {
                protected_edge_evidence_count += 1;
            }
            if is_gov_ev {
                protected_governance_event_count += 1;
            }

            let iron_protected = is_baseline
                || is_latest
                || is_recent
                || is_decision_ev
                || is_edge_ev
                || is_gov_ev
                || is_extra;

            let is_expired = if req.older_than_days == 0 {
                true
            } else {
                parse_iso_epoch_secs(&rev.observed_at)
                    .map(|ts| ts <= cutoff_secs)
                    .unwrap_or(false)
            };

            if iron_protected || !is_expired {
                if iron_protected {
                    protected_revisions_count += 1;
                }
                retained_hashes.insert(rev.content_hash.clone());
                retained_revs.push(rev.clone());
            } else {
                candidate_prunes.push(rev.clone());
            }
        }
    }

    let mut deletable_hash_sizes: BTreeMap<String, u64> = BTreeMap::new();
    let mut skipped_shared_blob_count: usize = 0;
    let mut pruned_samples: Vec<GcPrunedRevisionSample> = Vec::new();
    let mut pruned_revision_ids: Vec<String> = Vec::new();

    for rev in &candidate_prunes {
        pruned_revision_ids.push(rev.revision_id.clone());
        let shared_retained = retained_hashes.contains(&rev.content_hash);
        if shared_retained {
            skipped_shared_blob_count += 1;
        } else if !deletable_hash_sizes.contains_key(&rev.content_hash) {
            let disk_path = if rev.content_hash.len() >= 2 {
                blobs_dir
                    .join(&rev.content_hash[..2])
                    .join(&rev.content_hash)
            } else {
                blobs_dir.join(&rev.content_hash)
            };
            let bytes = fs::metadata(&disk_path)
                .map(|m| m.len())
                .unwrap_or(rev.size_bytes);
            deletable_hash_sizes.insert(rev.content_hash.clone(), bytes);
        }

        if pruned_samples.len() < 40 {
            pruned_samples.push(GcPrunedRevisionSample {
                file_id: rev.file_id.clone(),
                relative_path: file_paths
                    .get(&rev.file_id)
                    .cloned()
                    .unwrap_or_else(|| rev.file_id.clone()),
                revision_id: rev.revision_id.clone(),
                seq: rev.seq,
                observed_at: rev.observed_at.clone(),
                size_bytes: rev.size_bytes,
                blob_shared_retained: shared_retained,
            });
        }
    }

    let mut protected_unique_hashes: HashSet<String> = HashSet::new();
    let mut protected_bytes: u64 = 0;
    for rev in &retained_revs {
        if protected_unique_hashes.insert(rev.content_hash.clone()) {
            let disk_path = if rev.content_hash.len() >= 2 {
                blobs_dir
                    .join(&rev.content_hash[..2])
                    .join(&rev.content_hash)
            } else {
                blobs_dir.join(&rev.content_hash)
            };
            let bytes = fs::metadata(&disk_path)
                .map(|m| m.len())
                .unwrap_or(rev.size_bytes);
            protected_bytes = protected_bytes.saturating_add(bytes);
        }
    }

    let mut orphan_files_to_delete: Vec<(String, PathBuf, u64)> = Vec::new();
    if req.remove_orphan_blobs {
        for (name, path, size) in collect_disk_blob_files(blobs_dir) {
            if !retained_hashes.contains(&name) && !deletable_hash_sizes.contains_key(&name) {
                orphan_files_to_delete.push((name, path, size));
            }
        }
    }

    let reclaimed_from_blobs: u64 = deletable_hash_sizes.values().copied().sum();
    let reclaimed_from_orphans: u64 = orphan_files_to_delete.iter().map(|(_, _, sz)| *sz).sum();
    let hashes_to_delete: Vec<String> = deletable_hash_sizes.keys().cloned().collect();

    let summary = StorageGcResponse {
        ok: true,
        dry_run: req.dry_run,
        older_than_days: req.older_than_days,
        keep_recent_per_file: keep_recent,
        total_revisions_with_snapshot,
        protected_revisions_count,
        protected_decision_evidence_count,
        protected_edge_evidence_count,
        protected_governance_event_count,
        pruned_revisions_count: pruned_revision_ids.len(),
        deleted_blobs_count: hashes_to_delete.len(),
        deleted_orphan_blobs_count: orphan_files_to_delete.len(),
        skipped_shared_blob_count,
        reclaimed_bytes: reclaimed_from_blobs.saturating_add(reclaimed_from_orphans),
        protected_bytes,
        pruned_samples,
    };

    Ok(GcPlan {
        summary,
        pruned_revision_ids,
        hashes_to_delete,
        orphan_files_to_delete,
    })
}

/// 预演存储瘦身（只读零副作用）
pub fn plan_storage_gc(
    store: &ReadonlyStore,
    req: &StorageGcRequest,
) -> Result<StorageGcResponse, GuanlanError> {
    let ws = store.workspace()?;
    let now_secs = parse_iso_epoch_secs(&clock::now_iso()).unwrap_or(0);
    let mut dry_req = req.clone();
    dry_req.dry_run = true;
    let plan = build_gc_plan(
        store.conn(),
        store.blobs_dir(),
        &ws.workspace_id,
        &dry_req,
        now_secs,
    )?;
    Ok(plan.summary)
}

/// 执行存储瘦身（仅可由唯一写线程调用；严格先改库提交再删物理 blob，绝不误删受铁律保护的决定证据快照）
pub fn execute_storage_gc(
    writer: &mut Writer,
    req: &StorageGcRequest,
) -> Result<StorageGcResponse, GuanlanError> {
    let ws = writer.workspace()?;
    let now_secs = parse_iso_epoch_secs(&clock::now_iso()).unwrap_or(0);
    let plan = build_gc_plan(
        writer.conn(),
        writer.blobs_dir(),
        &ws.workspace_id,
        req,
        now_secs,
    )?;

    if req.dry_run {
        return Ok(plan.summary);
    }

    let pruned_ids = plan.pruned_revision_ids.clone();
    let hashes_to_delete = plan.hashes_to_delete.clone();
    let orphan_hashes: Vec<String> = plan
        .orphan_files_to_delete
        .iter()
        .map(|(h, _, _)| h.clone())
        .collect();
    let now_iso = clock::now_iso();
    let summary_clone = plan.summary.clone();

    writer.transaction(|w| {
        for rev_id in &pruned_ids {
            w.conn()
                .execute(
                    "UPDATE revisions SET snapshot_available = 0 WHERE revision_id = ?1",
                    params![rev_id],
                )
                .map_err(internal_sql)?;
        }
        for hash in &hashes_to_delete {
            w.conn()
                .execute("DELETE FROM blobs WHERE content_hash = ?1", params![hash])
                .map_err(internal_sql)?;
        }
        for hash in &orphan_hashes {
            w.conn()
                .execute("DELETE FROM blobs WHERE content_hash = ?1", params![hash])
                .map_err(internal_sql)?;
        }
        w.conn()
            .execute(
                "UPDATE blobs
                    SET ref_count = COALESCE(
                        (SELECT COUNT(*) FROM revisions r WHERE r.content_hash = blobs.content_hash AND r.snapshot_available = 1),
                        0
                    )",
                [],
            )
            .map_err(internal_sql)?;

        if summary_clone.pruned_revisions_count > 0
            || summary_clone.deleted_blobs_count > 0
            || summary_clone.deleted_orphan_blobs_count > 0
        {
            let ev_id = format!(
                "evt_{}",
                stable_key(&format!(
                    "{}|storage_gc_completed|{}|{}",
                    ws.workspace_id, now_iso, summary_clone.reclaimed_bytes
                ))
            );
            let _ = w.insert_event(&NewEvent {
                event_id: ev_id,
                workspace_id: ws.workspace_id.clone(),
                kind: "storage_gc_completed".to_owned(),
                subject_kind: "workspace".to_owned(),
                subject_id: ws.workspace_id.clone(),
                revision_id: None,
                occurred_at: Some(now_iso.clone()),
                occurred_precision: "exact".to_owned(),
                occurred_source: Some("system".to_owned()),
                observed_at: now_iso.clone(),
                headline: format!(
                    "存储瘦身完成：清理 {} 个超期过程快照、释放 {} 字节（保护 {} 条决定证据版本）",
                    summary_clone.pruned_revisions_count,
                    summary_clone.reclaimed_bytes,
                    summary_clone.protected_decision_evidence_count
                ),
                detail: format!(
                    "规则：超期 {} 天、每文件保留最近 {} 版；跳过共享去重快照 {} 次",
                    summary_clone.older_than_days,
                    summary_clone.keep_recent_per_file,
                    summary_clone.skipped_shared_blob_count
                ),
                payload_json: serde_json::json!({
                    "pruned_revisions_count": summary_clone.pruned_revisions_count,
                    "deleted_blobs_count": summary_clone.deleted_blobs_count,
                    "deleted_orphan_blobs_count": summary_clone.deleted_orphan_blobs_count,
                    "reclaimed_bytes": summary_clone.reclaimed_bytes,
                    "protected_decision_evidence_count": summary_clone.protected_decision_evidence_count,
                    "protected_edge_evidence_count": summary_clone.protected_edge_evidence_count,
                })
                .to_string(),
                batch_id: None,
            })?;
        }
        Ok(())
    })?;

    let blobs_dir = writer.blobs_dir().to_path_buf();
    for hash in &hashes_to_delete {
        let p = if hash.len() >= 2 {
            blobs_dir.join(&hash[..2]).join(hash)
        } else {
            blobs_dir.join(hash)
        };
        if p.is_file() {
            let _ = fs::remove_file(&p);
        }
    }
    for (_hash, path, _size) in &plan.orphan_files_to_delete {
        if path.is_file() {
            let _ = fs::remove_file(path);
        }
    }

    Ok(plan.summary)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceOpenExportRequest {
    /// 是否同时导出全部可用的去重历史版本快照（默认 true）
    #[serde(default = "default_true")]
    pub include_snapshots: bool,
    /// 可选自定义输出目录（缺省写至 `<data_dir>/exports/open-export-<ts>`）
    #[serde(default)]
    pub output_dir: Option<String>,
}

impl Default for WorkspaceOpenExportRequest {
    fn default() -> Self {
        Self {
            include_snapshots: true,
            output_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceOpenExportResponse {
    pub ok: bool,
    pub schema_version: String,
    pub output_dir: String,
    pub manifest_path: String,
    pub events_jsonl_path: String,
    pub decisions_md_path: String,
    pub timeline_md_path: String,
    pub files_count: usize,
    pub revisions_count: usize,
    pub events_count: usize,
    pub decisions_count: usize,
    pub edges_count: usize,
    pub snapshots_exported: usize,
    pub snapshots_missing: usize,
    pub total_bytes: u64,
}

fn resolve_export_dir(
    store: &ReadonlyStore,
    subdir: &str,
    prefix: &str,
    custom: Option<&str>,
) -> Result<PathBuf, GuanlanError> {
    let ws = store.workspace()?;
    let ws_root_canon = fs::canonicalize(&ws.root_path).ok();
    let target = match custom.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => PathBuf::from(raw),
        None => {
            let stamp = clock::now_iso().replace([':', '.'], "-").replace('Z', "");
            store
                .data_dir()
                .join(subdir)
                .join(format!("{prefix}-{stamp}"))
        }
    };
    if let Some(ref root_c) = ws_root_canon {
        if let Ok(target_c) = fs::canonicalize(&target) {
            if &target_c == root_c {
                return Err(GuanlanError::BadRequest(
                    "拒绝将开放导出覆盖写入工作区根目录，请指定独立空目录".to_owned(),
                ));
            }
        }
    }
    Ok(target)
}

/// 零锁定工作区全量开放导出：取回全部历史版本去重快照与 JSONL/Markdown 事件决定账本
pub fn export_workspace_open_archive(
    store: &ReadonlyStore,
    req: &WorkspaceOpenExportRequest,
) -> Result<WorkspaceOpenExportResponse, GuanlanError> {
    let ws = store.workspace()?;
    let out_dir = resolve_export_dir(store, "exports", "open-export", req.output_dir.as_deref())?;
    let ledger_dir = out_dir.join("ledger");
    fs::create_dir_all(&ledger_dir).map_err(|e| {
        GuanlanError::Internal(format!(
            "创建全量导出目录失败 {}：{e}",
            ledger_dir.display()
        ))
    })?;

    let conn = store.conn();
    let mut total_bytes: u64 = 0;

    let mut file_paths: HashMap<String, String> = HashMap::new();
    let mut files_jsonl = String::new();
    let mut files_count: usize = 0;
    {
        let mut stmt = conn
            .prepare(
                "SELECT file_id, current_path, format, title, role, first_observed_at, last_observed_at, last_revision_id, status
                   FROM files
                  WHERE workspace_id = ?1
                  ORDER BY current_path ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![&ws.workspace_id], |row| {
                Ok(serde_json::json!({
                    "file_id": row.get::<_, String>(0)?,
                    "current_path": row.get::<_, String>(1)?,
                    "format": row.get::<_, String>(2)?,
                    "title": row.get::<_, String>(3)?,
                    "role": row.get::<_, String>(4)?,
                    "first_observed_at": row.get::<_, String>(5)?,
                    "last_observed_at": row.get::<_, String>(6)?,
                    "last_revision_id": row.get::<_, Option<String>>(7)?,
                    "status": row.get::<_, String>(8)?,
                }))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let v = r.map_err(internal_sql)?;
            if let (Some(fid), Some(p)) = (v["file_id"].as_str(), v["current_path"].as_str()) {
                file_paths.insert(fid.to_owned(), p.to_owned());
            }
            files_jsonl.push_str(&v.to_string());
            files_jsonl.push('\n');
            files_count += 1;
        }
    }

    let mut aliases_jsonl = String::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT path, file_id, first_observed_at, last_observed_at, evidence
                   FROM path_aliases
                  WHERE workspace_id = ?1
                  ORDER BY file_id ASC, path ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![&ws.workspace_id], |row| {
                Ok(serde_json::json!({
                    "path": row.get::<_, String>(0)?,
                    "file_id": row.get::<_, String>(1)?,
                    "first_observed_at": row.get::<_, String>(2)?,
                    "last_observed_at": row.get::<_, String>(3)?,
                    "evidence": row.get::<_, String>(4)?,
                }))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let v = r.map_err(internal_sql)?;
            aliases_jsonl.push_str(&v.to_string());
            aliases_jsonl.push('\n');
        }
    }

    let mut revisions_jsonl = String::new();
    let mut revisions_count: usize = 0;
    let mut available_hashes: BTreeSet<String> = BTreeSet::new();
    let mut history_md = String::from(
        "# 历史版本快照索引（snapshots/INDEX.md）\n\n| 文件路径 | 版本 | 采集时间 | 业务时间 | SHA-256（前12位） | 快照链接 |\n| :--- | :---: | :--- | :--- | :--- | :--- |\n",
    );
    {
        let mut stmt = conn
            .prepare(
                "SELECT revision_id, file_id, seq, prev_revision_id, content_hash, size_bytes,
                        observed_at, occurred_at, occurred_precision, occurred_source, snapshot_available
                   FROM revisions
                  WHERE workspace_id = ?1
                  ORDER BY file_id ASC, seq ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![&ws.workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (rev_id, file_id, seq, prev_id, hash, size_bytes, obs, occ, prec, src, avail) =
                r.map_err(internal_sql)?;
            let rel_path = file_paths
                .get(&file_id)
                .cloned()
                .unwrap_or_else(|| file_id.clone());
            let blob_rel = if avail == 1 && hash.len() >= 2 {
                available_hashes.insert(hash.clone());
                Some(format!("blobs/{}/{}", &hash[..2], hash))
            } else {
                None
            };
            let v = serde_json::json!({
                "revision_id": rev_id,
                "file_id": file_id,
                "relative_path": rel_path,
                "seq": seq,
                "prev_revision_id": prev_id,
                "content_hash": hash,
                "size_bytes": size_bytes,
                "observed_at": obs,
                "occurred_at": occ,
                "occurred_precision": prec,
                "occurred_source": src,
                "snapshot_available": avail == 1,
                "export_snapshot_rel_path": blob_rel.as_ref().map(|b| format!("snapshots/{b}")),
            });
            revisions_jsonl.push_str(&v.to_string());
            revisions_jsonl.push('\n');
            revisions_count += 1;

            let short_h = &hash[..12.min(hash.len())];
            let link = match blob_rel {
                Some(ref b) if req.include_snapshots => format!("[快照]({b})"),
                Some(_) => "未附带快照（仅账本导出）".to_owned(),
                None => "仅元数据（L0/已清理）".to_owned(),
            };
            history_md.push_str(&format!(
                "| `{}` | v{} | {} | {} | `{}` | {} |\n",
                rel_path,
                seq,
                obs,
                occ.as_deref().unwrap_or("—"),
                short_h,
                link
            ));
        }
    }

    let mut events_jsonl = String::new();
    let mut timeline_md = String::from(
        "# 工作区全量时间演进账本（ledger/TIMELINE.md）\n\n> 保留业务发生时间 `occurred_at` 与系统采集时间 `observed_at` 双口径不混写。\n\n",
    );
    let mut events_count: usize = 0;
    {
        let mut stmt = conn
            .prepare(
                "SELECT seq, event_id, kind, subject_kind, subject_id, revision_id,
                        occurred_at, occurred_precision, occurred_source, observed_at,
                        headline, detail, payload_json
                   FROM events
                  WHERE workspace_id = ?1
                  ORDER BY seq ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![&ws.workspace_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (seq, eid, kind, skind, sid, rev_id, occ, prec, src, obs, head, detail, payload) =
                r.map_err(internal_sql)?;
            let v = serde_json::json!({
                "seq": seq,
                "event_id": eid,
                "kind": kind,
                "subject_kind": skind,
                "subject_id": sid,
                "revision_id": rev_id,
                "occurred_at": occ,
                "occurred_precision": prec,
                "occurred_source": src,
                "observed_at": obs,
                "headline": head,
                "detail": detail,
                "payload": serde_json::from_str::<serde_json::Value>(&payload).unwrap_or(serde_json::Value::String(payload)),
            });
            events_jsonl.push_str(&v.to_string());
            events_jsonl.push('\n');
            timeline_md.push_str(&format!(
                "- **#{seq} [{kind}]** {head}  \n  业务时间：`{}` · 采集时间：`{obs}`\n",
                occ.as_deref().unwrap_or("未记载")
            ));
            events_count += 1;
        }
    }

    let mut decisions_jsonl = String::new();
    let mut decisions_md = String::from(
        "# 工作区全量决定与证据账本（ledger/DECISIONS.md）\n\n| 编号 | 状态 | 事项/问题 | 证据锚点（文件与行号） | 原文摘录 |\n| :--- | :---: | :--- | :--- | :--- |\n",
    );
    let mut decisions_count: usize = 0;
    {
        let mut stmt = conn
            .prepare(
                "SELECT statement_id, decision_id, file_id, revision_id, code, namespace,
                        question, status, quote, line_start, line_end, observed_at
                   FROM statements
                  WHERE workspace_id = ?1
                  ORDER BY observed_at ASC, statement_id ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![&ws.workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (sid, did, fid, rev_id, code, ns, question, status, quote, l1, l2, obs) =
                r.map_err(internal_sql)?;
            let rel = file_paths.get(&fid).cloned().unwrap_or_else(|| fid.clone());
            let v = serde_json::json!({
                "statement_id": sid,
                "decision_id": did,
                "file_id": fid,
                "relative_path": rel,
                "revision_id": rev_id,
                "code": code,
                "namespace": ns,
                "question": question,
                "status": status,
                "quote": quote,
                "line_start": l1,
                "line_end": l2,
                "observed_at": obs,
            });
            decisions_jsonl.push_str(&v.to_string());
            decisions_jsonl.push('\n');
            decisions_md.push_str(&format!(
                "| `{}` | `{}` | {} | `{}` L{}-L{} (`{}`) | {} |\n",
                code,
                status,
                question.replace(['\r', '\n', '|'], " "),
                rel,
                l1,
                l2,
                rev_id,
                quote.replace(['\r', '\n', '|'], " ")
            ));
            decisions_count += 1;
        }
    }

    let mut edges_jsonl = String::new();
    let mut edges_count: usize = 0;
    {
        let mut stmt = conn
            .prepare(
                "SELECT edge_id, source_file_id, source_revision_id, target_file_id, target_revision_id,
                        kind, resolution, locator_start, locator_end, reason
                   FROM edges
                  WHERE workspace_id = ?1
                  ORDER BY edge_id ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![&ws.workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(internal_sql)?;
        for r in rows {
            let (eid, sfid, srev, tfid, trev, kind, res, l1, l2, reason) =
                r.map_err(internal_sql)?;
            let v = serde_json::json!({
                "edge_id": eid,
                "source_file_id": sfid,
                "source_path": file_paths.get(&sfid),
                "source_revision_id": srev,
                "target_file_id": tfid,
                "target_path": file_paths.get(&tfid),
                "target_revision_id": trev,
                "kind": kind,
                "resolution": res,
                "locator_start": l1,
                "locator_end": l2,
                "reason": reason,
            });
            edges_jsonl.push_str(&v.to_string());
            edges_jsonl.push('\n');
            edges_count += 1;
        }
    }

    let mut snapshots_exported: usize = 0;
    let mut snapshots_missing: usize = 0;
    if req.include_snapshots {
        let snap_blobs_root = out_dir.join("snapshots").join("blobs");
        fs::create_dir_all(&snap_blobs_root)
            .map_err(|e| GuanlanError::Internal(format!("创建快照导出目录失败：{e}")))?;
        for hash in &available_hashes {
            if hash.len() < 2 {
                continue;
            }
            let src = store.blobs_dir().join(&hash[..2]).join(hash);
            if !src.is_file() {
                snapshots_missing += 1;
                continue;
            }
            let dst_bucket = snap_blobs_root.join(&hash[..2]);
            fs::create_dir_all(&dst_bucket)
                .map_err(|e| GuanlanError::Internal(format!("创建快照分桶失败：{e}")))?;
            let dst = dst_bucket.join(hash);
            let copied = fs::copy(&src, &dst)
                .map_err(|e| GuanlanError::Internal(format!("复制快照 {hash} 失败：{e}")))?;
            total_bytes = total_bytes.saturating_add(copied);
            snapshots_exported += 1;
        }
    }

    let ledger_audit = verify_decision_ledger(store)?;
    let ledger_audit_json = serde_json::to_string_pretty(&ledger_audit)
        .map_err(|e| GuanlanError::Internal(format!("序列化账本审计失败：{e}")))?;

    let exported_at = clock::now_iso();
    let manifest_json = serde_json::to_string_pretty(&serde_json::json!({
        "schema_version": OPEN_EXPORT_SCHEMA_VERSION,
        "exported_at": exported_at,
        "workspace_id": ws.workspace_id,
        "index_generation": ws.index_generation,
        "include_snapshots": req.include_snapshots,
        "counts": {
            "files": files_count,
            "revisions": revisions_count,
            "events": events_count,
            "decisions": decisions_count,
            "edges": edges_count,
            "snapshots_exported": snapshots_exported,
            "snapshots_missing": snapshots_missing,
        },
        "decision_ledger_ok": ledger_audit.ok,
    }))
    .map_err(|e| GuanlanError::Internal(format!("序列化 manifest 失败：{e}")))?;

    let readme_md = format!(
        "# 观澜全量开放导出包（{OPEN_EXPORT_SCHEMA_VERSION}）\n\n\
        > 零厂商锁定声明：本目录包含完整历史去重快照与标准 JSONL / Markdown 账本，脱离观澜可用任意文本编辑器或脚本永久读取。\n\n\
        - **导出时间**：{exported_at}\n\
        - **文件 / 版本**：{files_count} 份文件 · {revisions_count} 个历史版本\n\
        - **事件 / 决定 / 关系边**：{events_count} 事件 · {decisions_count} 决定 · {edges_count} 因果/引用边\n\
        - **历史快照**：已导出 {snapshots_exported} 份去重原件（缺失 {snapshots_missing} 份）\n\
        - **决定防篡改链**：{}\n\n\
        ## 目录说明\n\
        - `manifest.json`：开放导出清单与规模统计\n\
        - `ledger/events.jsonl` & `ledger/TIMELINE.md`：全量事件时间轴（完整保留业务/采集双时间口径）\n\
        - `ledger/decisions.jsonl` & `ledger/DECISIONS.md`：全量决定与原文行号证据表\n\
        - `ledger/edges.jsonl`、`ledger/files.jsonl`、`ledger/revisions.jsonl`、`ledger/path_aliases.jsonl`：完整实体身份与更名谱系\n\
        - `ledger/decision-chain-audit.json`：关键决定 SHA-256 哈希链审计快照\n\
        - `snapshots/INDEX.md` & `snapshots/blobs/<前2位>/<sha256>`：去重历史快照原件与索引\n",
        if ledger_audit.ok { "PASS（完好无篡改）" } else { "WARN（检测到账本异常，详见 decision-chain-audit.json）" }
    );

    let snapshots_dir = out_dir.join("snapshots");
    fs::create_dir_all(&snapshots_dir)
        .map_err(|e| GuanlanError::Internal(format!("创建 snapshots 目录失败：{e}")))?;

    let manifest_path = out_dir.join("manifest.json");
    let readme_path = out_dir.join("README.md");
    let events_jsonl_path = ledger_dir.join("events.jsonl");
    let decisions_jsonl_path = ledger_dir.join("decisions.jsonl");
    let decisions_md_path = ledger_dir.join("DECISIONS.md");
    let timeline_md_path = ledger_dir.join("TIMELINE.md");
    let edges_jsonl_path = ledger_dir.join("edges.jsonl");
    let files_jsonl_path = ledger_dir.join("files.jsonl");
    let revisions_jsonl_path = ledger_dir.join("revisions.jsonl");
    let aliases_jsonl_path = ledger_dir.join("path_aliases.jsonl");
    let audit_json_path = ledger_dir.join("decision-chain-audit.json");
    let snapshots_index_path = snapshots_dir.join("INDEX.md");

    for (path, content) in [
        (&manifest_path, manifest_json.as_bytes()),
        (&readme_path, readme_md.as_bytes()),
        (&events_jsonl_path, events_jsonl.as_bytes()),
        (&decisions_jsonl_path, decisions_jsonl.as_bytes()),
        (&decisions_md_path, decisions_md.as_bytes()),
        (&timeline_md_path, timeline_md.as_bytes()),
        (&edges_jsonl_path, edges_jsonl.as_bytes()),
        (&files_jsonl_path, files_jsonl.as_bytes()),
        (&revisions_jsonl_path, revisions_jsonl.as_bytes()),
        (&aliases_jsonl_path, aliases_jsonl.as_bytes()),
        (&audit_json_path, ledger_audit_json.as_bytes()),
        (&snapshots_index_path, history_md.as_bytes()),
    ] {
        fs::write(path, content).map_err(|e| {
            GuanlanError::Internal(format!("写入导出文件失败 {}：{e}", path.display()))
        })?;
        total_bytes = total_bytes.saturating_add(content.len() as u64);
    }

    Ok(WorkspaceOpenExportResponse {
        ok: true,
        schema_version: OPEN_EXPORT_SCHEMA_VERSION.to_owned(),
        output_dir: out_dir.to_string_lossy().into_owned(),
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        events_jsonl_path: events_jsonl_path.to_string_lossy().into_owned(),
        decisions_md_path: decisions_md_path.to_string_lossy().into_owned(),
        timeline_md_path: timeline_md_path.to_string_lossy().into_owned(),
        files_count,
        revisions_count,
        events_count,
        decisions_count,
        edges_count,
        snapshots_exported,
        snapshots_missing,
        total_bytes,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticZipResponse {
    pub ok: bool,
    pub zip_path: String,
    pub size_bytes: u64,
    pub entries_count: usize,
    pub redactions_applied: usize,
    pub integrity_ok: bool,
    pub ledger_ok: bool,
    pub sandbox_ok: bool,
}

fn redact_diagnostic_text(raw: &str, ws_root: &str, data_dir: &str) -> (String, usize) {
    let mut text = raw.to_owned();
    let mut hits: usize = 0;

    let mut replacements: Vec<(String, &'static str)> = Vec::new();
    let push_path_variants =
        |out: &mut Vec<(String, &'static str)>, val: &str, tag: &'static str| {
            if val.is_empty() {
                return;
            }
            let fwd = val.replace('\\', "/");
            let bwd = val.replace('/', "\\");
            let json_bwd = bwd.replace('\\', "\\\\");
            out.push((val.to_owned(), tag));
            out.push((fwd, tag));
            out.push((bwd, tag));
            out.push((json_bwd, tag));
        };
    push_path_variants(&mut replacements, ws_root, "<WORKSPACE_ROOT>");
    push_path_variants(&mut replacements, data_dir, "<DATA_DIR>");
    for env_key in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(env_key) {
            if home.len() >= 3 {
                push_path_variants(&mut replacements, &home, "<USER_HOME>");
            }
        }
    }
    replacements.sort_by_key(|a| std::cmp::Reverse(a.0.len()));
    replacements.dedup_by(|a, b| a.0 == b.0);

    for (needle, tag) in &replacements {
        if !needle.is_empty() && text.contains(needle.as_str()) {
            let count = text.matches(needle.as_str()).count();
            text = text.replace(needle.as_str(), tag);
            hits += count;
        }
    }

    let (sanitized, secret_hits) = sanitize_context_text(&text);
    (sanitized, hits + secret_hits)
}

/// 零外部依赖的标准 ZIP 归档生成器（RFC-1951 DEFLATE method 8 + CRC32 + Central Directory + EOCD）
pub(crate) fn build_standard_zip(entries: &[(&str, &[u8])]) -> Result<Vec<u8>, GuanlanError> {
    struct CdRecord {
        name: Vec<u8>,
        crc32: u32,
        compressed_size: u32,
        uncompressed_size: u32,
        local_header_offset: u32,
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut records: Vec<CdRecord> = Vec::with_capacity(entries.len());

    for (name, data) in entries {
        let name_bytes = name.as_bytes().to_vec();
        let mut crc = Crc::new();
        crc.update(data);
        let crc32 = crc.sum();

        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(data)
            .map_err(|e| GuanlanError::Internal(format!("ZIP DEFLATE 压缩失败：{e}")))?;
        let compressed = encoder
            .finish()
            .map_err(|e| GuanlanError::Internal(format!("ZIP DEFLATE 完成失败：{e}")))?;

        let local_offset = u32::try_from(buf.len())
            .map_err(|_| GuanlanError::Internal("诊断包超出 4GiB ZIP32 限制".to_owned()))?;
        let comp_len = u32::try_from(compressed.len())
            .map_err(|_| GuanlanError::Internal("条目超出 ZIP32 限制".to_owned()))?;
        let uncomp_len = u32::try_from(data.len())
            .map_err(|_| GuanlanError::Internal("条目超出 ZIP32 限制".to_owned()))?;
        let name_len = u16::try_from(name_bytes.len())
            .map_err(|_| GuanlanError::Internal("ZIP 文件名过长".to_owned()))?;

        buf.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        buf.extend_from_slice(&20u16.to_le_bytes());
        buf.extend_from_slice(&0x0800u16.to_le_bytes());
        buf.extend_from_slice(&8u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0x5821u16.to_le_bytes());
        buf.extend_from_slice(&crc32.to_le_bytes());
        buf.extend_from_slice(&comp_len.to_le_bytes());
        buf.extend_from_slice(&uncomp_len.to_le_bytes());
        buf.extend_from_slice(&name_len.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&name_bytes);
        buf.extend_from_slice(&compressed);

        records.push(CdRecord {
            name: name_bytes,
            crc32,
            compressed_size: comp_len,
            uncompressed_size: uncomp_len,
            local_header_offset: local_offset,
        });
    }

    let cd_offset =
        u32::try_from(buf.len()).map_err(|_| GuanlanError::Internal("ZIP 偏移溢出".to_owned()))?;

    for rec in &records {
        let name_len = rec.name.len() as u16;
        buf.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        buf.extend_from_slice(&20u16.to_le_bytes());
        buf.extend_from_slice(&20u16.to_le_bytes());
        buf.extend_from_slice(&0x0800u16.to_le_bytes());
        buf.extend_from_slice(&8u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0x5821u16.to_le_bytes());
        buf.extend_from_slice(&rec.crc32.to_le_bytes());
        buf.extend_from_slice(&rec.compressed_size.to_le_bytes());
        buf.extend_from_slice(&rec.uncompressed_size.to_le_bytes());
        buf.extend_from_slice(&name_len.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&rec.local_header_offset.to_le_bytes());
        buf.extend_from_slice(&rec.name);
    }

    let cd_size = u32::try_from(buf.len())
        .map_err(|_| GuanlanError::Internal("ZIP 大小溢出".to_owned()))?
        .saturating_sub(cd_offset);
    let entry_count = u16::try_from(records.len())
        .map_err(|_| GuanlanError::Internal("ZIP 条目数溢出".to_owned()))?;

    buf.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf.extend_from_slice(&entry_count.to_le_bytes());
    buf.extend_from_slice(&entry_count.to_le_bytes());
    buf.extend_from_slice(&cd_size.to_le_bytes());
    buf.extend_from_slice(&cd_offset.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes());

    Ok(buf)
}

/// 生成内存态脱敏诊断包 ZIP 字节流及摘要（供 HTTP 直接下载与落盘复用）
pub fn build_diagnostic_zip_bytes(
    store: &ReadonlyStore,
) -> Result<(Vec<u8>, DiagnosticZipResponse), GuanlanError> {
    let ws = store.workspace()?;
    let data_dir_str = store.data_dir().to_string_lossy().into_owned();
    let stats = crate::application::storage_stats(store)?;
    let integrity = verify_blobs_integrity(store)?;
    let ledger = verify_decision_ledger(store)?;
    let sandbox = audit_workspace_file_paths(store)?;

    let mut recent_jobs: Vec<serde_json::Value> = Vec::new();
    if let Ok(mut stmt) = store.conn().prepare(
        "SELECT job_id, kind, state, phase, created_at, updated_at, error
           FROM job_runs
          WHERE workspace_id = ?1
          ORDER BY created_at DESC
          LIMIT 50",
    ) {
        if let Ok(rows) = stmt.query_map(params![&ws.workspace_id], |row| {
            Ok(serde_json::json!({
                "job_id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "state": row.get::<_, String>(2)?,
                "phase": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
                "error": row.get::<_, Option<String>>(6)?,
            }))
        }) {
            for r in rows.flatten() {
                recent_jobs.push(r);
            }
        }
    }

    let summary_raw = serde_json::to_string_pretty(&serde_json::json!({
        "generated_at": clock::now_iso(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "workspace_id": ws.workspace_id,
        "index_generation": ws.index_generation,
        "schema_version": store.schema_version().unwrap_or(0),
        "integrity_ok": integrity.ok,
        "ledger_ok": ledger.ok,
        "sandbox_ok": sandbox.ok,
        "blobs_count": stats.blobs_count,
        "blobs_disk_bytes": stats.blobs_disk_bytes,
        "db_bytes": stats.db_bytes,
        "active_files_count": stats.active_files_count,
        "revisions_total": stats.revisions_total,
    }))
    .map_err(|e| GuanlanError::Internal(format!("序列化诊断摘要失败：{e}")))?;

    let stats_raw = serde_json::to_string_pretty(&stats)
        .map_err(|e| GuanlanError::Internal(format!("序列化存储统计失败：{e}")))?;
    let integrity_raw = serde_json::to_string_pretty(&integrity)
        .map_err(|e| GuanlanError::Internal(format!("序列化完整性报告失败：{e}")))?;
    let audit_raw = serde_json::to_string_pretty(&serde_json::json!({
        "ledger": ledger,
        "sandbox": sandbox,
    }))
    .map_err(|e| GuanlanError::Internal(format!("序列化审计报告失败：{e}")))?;
    let jobs_raw = serde_json::to_string_pretty(&recent_jobs)
        .map_err(|e| GuanlanError::Internal(format!("序列化任务列表失败：{e}")))?;

    let mut total_redactions: usize = 0;
    let mut sanitize = |raw: &str| -> String {
        let (clean, hits) = redact_diagnostic_text(raw, &ws.root_path, &data_dir_str);
        total_redactions += hits;
        clean
    };

    let summary_clean = sanitize(&summary_raw);
    let stats_clean = sanitize(&stats_raw);
    let integrity_clean = sanitize(&integrity_raw);
    let audit_clean = sanitize(&audit_raw);
    let jobs_clean = sanitize(&jobs_raw);

    let readme = format!(
        "观澜（Guanlan）脱敏运行诊断包\r\n\
         ========================================\r\n\
         生成时间：{}\r\n\
         脱敏保护：已自动替换本机工作区路径、数据目录、用户主目录及全部敏感凭据/密钥片段（共脱敏 {} 处），不含任何用户文档正文。\r\n\
         \r\n\
         包含文件：\r\n\
         - diagnostic-summary.json : 运行环境、Schema 版本与健康总览\r\n\
         - storage-stats.json      : 磁盘占用、全格式分布与三档配额策略\r\n\
         - integrity-report.json   : 全部快照 SHA-256 完整性校验结果与影响范围\r\n\
         - audit-report.json       : 关键决定防篡改哈希链与路径沙箱审计结果\r\n\
         - recent-jobs.json        : 最近 50 条索引/写回任务运行摘要\r\n",
        clock::now_iso(),
        total_redactions
    );

    let entries: Vec<(&str, &[u8])> = vec![
        ("README.txt", readme.as_bytes()),
        ("diagnostic-summary.json", summary_clean.as_bytes()),
        ("storage-stats.json", stats_clean.as_bytes()),
        ("integrity-report.json", integrity_clean.as_bytes()),
        ("audit-report.json", audit_clean.as_bytes()),
        ("recent-jobs.json", jobs_clean.as_bytes()),
    ];
    let zip_bytes = build_standard_zip(&entries)?;

    let receipt = DiagnosticZipResponse {
        ok: true,
        zip_path: String::new(),
        size_bytes: zip_bytes.len() as u64,
        entries_count: entries.len(),
        redactions_applied: total_redactions,
        integrity_ok: integrity.ok,
        ledger_ok: ledger.ok,
        sandbox_ok: sandbox.ok,
    };

    Ok((zip_bytes, receipt))
}

/// 生成并落盘脱敏运行诊断 ZIP 文件
pub fn export_diagnostic_zip(
    store: &ReadonlyStore,
    output_path: Option<&str>,
) -> Result<DiagnosticZipResponse, GuanlanError> {
    let (zip_bytes, mut receipt) = build_diagnostic_zip_bytes(store)?;
    let target = match output_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => PathBuf::from(raw),
        None => {
            let stamp = clock::now_iso().replace([':', '.'], "-").replace('Z', "");
            store
                .data_dir()
                .join("diagnostics")
                .join(format!("guanlan-diagnostic-{stamp}.zip"))
        }
    };
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            GuanlanError::Internal(format!("创建诊断包输出目录失败 {}：{e}", parent.display()))
        })?;
    }
    fs::write(&target, &zip_bytes).map_err(|e| {
        GuanlanError::Internal(format!("写入诊断包 ZIP 失败 {}：{e}", target.display()))
    })?;
    receipt.zip_path = target.to_string_lossy().into_owned();
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{reconcile, ReconcileOptions};
    use flate2::read::DeflateDecoder;

    struct TempMaintWs {
        dir: PathBuf,
        root: PathBuf,
        data: PathBuf,
    }

    impl TempMaintWs {
        fn new(tag: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("guanlan-f02-{tag}-{}-{nonce}", std::process::id()));
            let root = dir.join("ws");
            let data = dir.join("data");
            fs::create_dir_all(root.join("01-核心专项")).unwrap();
            fs::create_dir_all(&data).unwrap();
            Self { dir, root, data }
        }
    }

    impl Drop for TempMaintWs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn read_zip_entries_for_test(zip: &[u8]) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        let mut pos = 0usize;
        while pos + 30 <= zip.len() {
            let sig = u32::from_le_bytes(zip[pos..pos + 4].try_into().unwrap());
            if sig != 0x0403_4b50 {
                break;
            }
            let comp_len = u32::from_le_bytes(zip[pos + 18..pos + 22].try_into().unwrap()) as usize;
            let name_len = u16::from_le_bytes(zip[pos + 26..pos + 28].try_into().unwrap()) as usize;
            let extra_len =
                u16::from_le_bytes(zip[pos + 28..pos + 30].try_into().unwrap()) as usize;
            let name_start = pos + 30;
            let name = String::from_utf8(zip[name_start..name_start + name_len].to_vec()).unwrap();
            let data_start = name_start + name_len + extra_len;
            let comp_slice = &zip[data_start..data_start + comp_len];
            let mut dec = DeflateDecoder::new(comp_slice);
            let mut plain = String::new();
            dec.read_to_string(&mut plain).unwrap();
            out.insert(name, plain);
            pos = data_start + comp_len;
        }
        out
    }

    #[test]
    fn f02_gc_iron_law_protects_decision_and_edge_evidence_snapshots_and_shared_blobs() {
        let ws = TempMaintWs::new("gc-iron-law");
        let plan_path = ws.root.join("01-核心专项/01-架构定稿.md");
        let ref_path = ws.root.join("01-核心专项/02-附录.md");
        fs::write(&ref_path, "# 附录\n基准参考内容。\n").unwrap();

        let mut writer = Writer::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();

        fs::write(&plan_path, "# 架构定稿 v1\n初稿内容。\n").unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();

        fs::write(&plan_path, "# 架构定稿 v2\n纯过程草稿，将被安全瘦身。\n").unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();

        let v3_body =
            "# 架构定稿 v3\n- [P1 - 已确认] 采用铁律保护策略（决定：GC 绝不误删决定依据）\n";
        fs::write(&plan_path, v3_body).unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();

        fs::write(&plan_path, "# 架构定稿 v4\n详见 [附录](02-附录.md)。\n").unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();

        fs::write(&plan_path, v3_body).unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();

        fs::write(&plan_path, "# 架构定稿 v6\n最新稳定正文。\n").unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();

        let ws_rec = writer.workspace().unwrap();
        let file = writer
            .find_file_by_path(&ws_rec.workspace_id, "01-核心专项/01-架构定稿.md")
            .unwrap()
            .unwrap();
        let revs = writer.revisions_of_file(&file.file_id).unwrap();
        assert_eq!(revs.len(), 6, "应生成 6 个历史版本");

        writer
            .conn()
            .execute(
                "UPDATE revisions SET observed_at = '2024-01-01T00:00:00.000Z'",
                [],
            )
            .unwrap();
        let orphan_dir = writer.blobs_dir().join("ff");
        fs::create_dir_all(&orphan_dir).unwrap();
        let orphan_file =
            orphan_dir.join("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        fs::write(&orphan_file, b"orphan-garbage-blob").unwrap();

        let v5_id = &revs[4].revision_id;
        writer
            .conn()
            .execute(
                "DELETE FROM statements WHERE revision_id = ?1",
                params![v5_id],
            )
            .unwrap();
        writer
            .conn()
            .execute("DELETE FROM events WHERE revision_id = ?1", params![v5_id])
            .unwrap();

        let store = ReadonlyStore::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();
        let req = StorageGcRequest {
            older_than_days: 30,
            keep_recent_per_file: 1,
            remove_orphan_blobs: true,
            dry_run: true,
        };
        let preview = plan_storage_gc(&store, &req).unwrap();
        assert!(preview.dry_run);
        assert_eq!(
            preview.pruned_revisions_count, 2,
            "v2 和 v5 应入瘦身候选：{preview:?}"
        );
        assert_eq!(
            preview.deleted_blobs_count, 1,
            "仅 v2 的独立 blob 可删，v5 共享 v3 blob 必须跳过"
        );
        assert_eq!(preview.skipped_shared_blob_count, 1);
        assert_eq!(preview.deleted_orphan_blobs_count, 1);
        assert!(preview.protected_decision_evidence_count >= 1);
        assert!(preview.protected_edge_evidence_count >= 1);

        let exec_res = execute_storage_gc(
            &mut writer,
            &StorageGcRequest {
                dry_run: false,
                ..req
            },
        )
        .unwrap();
        assert!(!exec_res.dry_run);
        assert_eq!(exec_res.pruned_revisions_count, 2);
        assert_eq!(exec_res.deleted_blobs_count, 1);
        assert_eq!(exec_res.deleted_orphan_blobs_count, 1);
        assert!(!orphan_file.exists(), "孤儿 blob 应已清理");

        let revs_after = writer.revisions_of_file(&file.file_id).unwrap();
        for seq_protected in [1i64, 3, 4, 6] {
            let r = revs_after.iter().find(|r| r.seq == seq_protected).unwrap();
            assert_eq!(
                r.snapshot_available, 1,
                "受铁律保护版本 v{seq_protected} 不得被清理"
            );
            let p = store.blob_path_for(&r.content_hash).unwrap();
            assert!(
                p.is_file(),
                "受保护版本 v{seq_protected} 物理快照必须完好存在"
            );
        }
        let v2_after = revs_after.iter().find(|r| r.seq == 2).unwrap();
        assert_eq!(v2_after.snapshot_available, 0);
        assert!(!store
            .blob_path_for(&v2_after.content_hash)
            .unwrap()
            .exists());

        let integrity = verify_blobs_integrity(&store).unwrap();
        assert!(
            integrity.ok,
            "GC 后剩余快照完整性必须 100% 通过：{integrity:?}"
        );
        assert_eq!(integrity.orphan_blob_count, 0);
    }

    #[test]
    fn f02_integrity_check_honestly_reports_corrupted_and_missing_blob_impacts() {
        let ws = TempMaintWs::new("integrity");
        fs::write(
            ws.root.join("01-核心专项/01-决定单.md"),
            "# 决定单\n- [P1 - 已确认] 数据库选型（决定：SQLite WAL 模式）\n",
        )
        .unwrap();
        fs::write(
            ws.root.join("01-核心专项/02-说明.md"),
            "# 说明\n普通内容。\n",
        )
        .unwrap();

        let mut writer = Writer::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();
        fs::write(
            ws.root.join("01-核心专项/01-决定单.md"),
            "# 决定单 v2\n- [P1 - 已确认] 数据库选型（决定：SQLite WAL 模式 + 定时备份）\n",
        )
        .unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();
        let ws_rec = writer.workspace().unwrap();
        let store = ReadonlyStore::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();

        let clean = verify_blobs_integrity(&store).unwrap();
        assert!(clean.ok);
        assert_eq!(clean.healthy_blobs, 3);

        let f1 = writer
            .find_file_by_path(&ws_rec.workspace_id, "01-核心专项/01-决定单.md")
            .unwrap()
            .unwrap();
        let r1 = writer.latest_revision(&f1.file_id).unwrap().unwrap();
        let b1 = store.blob_path_for(&r1.content_hash).unwrap();
        fs::write(&b1, b"CORRUPTED_BYTES").unwrap();

        let f2 = writer
            .find_file_by_path(&ws_rec.workspace_id, "01-核心专项/02-说明.md")
            .unwrap()
            .unwrap();
        let r2 = writer.latest_revision(&f2.file_id).unwrap().unwrap();
        let b2 = store.blob_path_for(&r2.content_hash).unwrap();
        fs::remove_file(&b2).unwrap();

        let broken = verify_blobs_integrity(&store).unwrap();
        assert!(!broken.ok);
        assert_eq!(broken.corrupted_count, 1);
        assert_eq!(broken.missing_count, 1);
        assert_eq!(broken.impacts.len(), 2);

        let mismatch = broken
            .impacts
            .iter()
            .find(|i| i.issue_kind == "hash_mismatch")
            .expect("必须检出哈希失配");
        assert_eq!(
            mismatch.impacted_revisions[0].relative_path,
            "01-核心专项/01-决定单.md"
        );
        assert!(
            !mismatch.impacted_decisions.is_empty(),
            "必须诚实报告受影响的决定证据"
        );
        assert!(mismatch.impacted_event_count >= 1);

        let missing = broken
            .impacts
            .iter()
            .find(|i| i.issue_kind == "missing")
            .expect("必须检出缺失快照");
        assert_eq!(
            missing.impacted_revisions[0].relative_path,
            "01-核心专项/02-说明.md"
        );
    }

    #[test]
    fn f02_open_export_and_sanitized_diagnostic_zip() {
        let ws = TempMaintWs::new("export-diag");
        fs::write(
            ws.root.join("01-核心专项/01-纪要.md"),
            "# 纪要\n- [P1 - 已确认] 全量开放导出（决定：随时带走快照与账本）\n",
        )
        .unwrap();
        let mut writer = Writer::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();
        reconcile(&mut writer, &ReconcileOptions::default()).unwrap();
        let ws_rec = writer.workspace().unwrap();
        writer
            .conn()
            .execute(
                "INSERT INTO job_runs (job_id, workspace_id, kind, state, phase, request_json, progress_json, error, created_at, updated_at)
                 VALUES ('job_test_diag', ?1, 'verify_all', 'failed', 'scan', '{}', '{}', ?2, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z')",
                params![
                    &ws_rec.workspace_id,
                    format!(
                        "read failed at {} with token sk-proj-diagsecretkey1234567890123456",
                        ws.root.display()
                    )
                ],
            )
            .unwrap();

        let store = ReadonlyStore::open_at(&ws.data, ws.root.to_str().unwrap()).unwrap();

        let export_out = ws.dir.join("open-archive");
        let exp = export_workspace_open_archive(
            &store,
            &WorkspaceOpenExportRequest {
                include_snapshots: true,
                output_dir: Some(export_out.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        assert_eq!(exp.files_count, 1);
        assert_eq!(exp.snapshots_exported, 1);
        assert!(exp.events_count >= 1);
        assert!(exp.decisions_count >= 1);
        assert!(Path::new(&exp.events_jsonl_path).is_file());
        assert!(Path::new(&exp.decisions_md_path).is_file());
        assert!(Path::new(&exp.timeline_md_path).is_file());
        assert!(export_out.join("snapshots/INDEX.md").is_file());

        let diag_zip = ws.dir.join("diag.zip");
        let diag = export_diagnostic_zip(&store, Some(diag_zip.to_str().unwrap())).unwrap();
        assert!(diag.ok);
        assert!(diag.integrity_ok);
        assert!(diag.ledger_ok);
        assert!(diag.redactions_applied >= 2);
        let raw_zip = fs::read(&diag_zip).unwrap();
        let entries = read_zip_entries_for_test(&raw_zip);
        assert_eq!(entries.len(), 6);
        let ws_root_str = ws.root.to_string_lossy();
        for (name, content) in &entries {
            assert!(
                !content.contains("sk-proj-diagsecretkey"),
                "诊断包条目 {name} 不得泄露密钥"
            );
            assert!(
                !content.contains(ws_root_str.as_ref()),
                "诊断包条目 {name} 不得泄露本机工作区路径"
            );
        }
        assert!(entries["recent-jobs.json"].contains("<WORKSPACE_ROOT>"));
        assert!(entries["recent-jobs.json"].contains("[REDACTED_SECRET]"));
    }
}
