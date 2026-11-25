//! 应用服务：bootstrap、status、diff、context、草案、批阅看板与资料胶囊。
//!
//! bootstrap 在一个短读快照内生成：配置、统计、首批文件摘要、首批事件、决定首批、
//! 关系总数与任务状态，全部在同一 BEGIN DEFERRED 读事务内完成；响应任何位置不出现
//! svgSource、markdownContent、revisions[]（不含正文、完整版本链、全量关系、历史 SVG 原文）。

/// 智能体上下文组装（POST /api/v1/context）
pub mod context;

/// 语义级版本 Diff
pub mod diff;

/// 外部智能体修订草案 CAS 安全网与 `derived_from_context` 因果边
pub mod proposals;

/// 原位拍板（HITL）唤醒任务与五态批阅看板 + 孤儿/失联诚实诊断与修复
pub mod review_board;

/// 事项资料胶囊（Context Capsule）两阶段预览/脱敏/导出与离线秒开核验
pub mod capsule;

use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::dto::{
    BootstrapResponse, EnumSnapshot, FormatClassUsage, IndexCoverage, Quota, RuntimeStatus,
    SnapshotTierPolicyDto, StatusResponse, StorageStatsResponse, WorkspaceConfig,
};
use crate::error::GuanlanError;
use crate::index::file_format::{class_of_token, FormatClass, SnapshotPolicy};
use crate::query::{
    cursor::clamp_limit, decisions_tx, event_time_range_inner, list_files_tx, query_event_days_tx,
    query_events_tx, relations_total, DecisionsQuery, EventDaysQuery, EventGranularity, EventOrder,
    EventQuery, FileListQuery,
};
use crate::storage::{internal_sql, ReadonlyStore};

/// GET /api/v1/bootstrap 请求参数（契约 §1.1 请求参数表）
#[derive(Debug, Clone)]
pub struct BootstrapQuery {
    /// days_limit：画布聚合桶数上限，int ≤120（默认 30；现状前端传 120）
    pub days_limit: u32,
    /// days_samples：每桶样本卡片数，1..12（默认 4；现状前端传 6）
    pub days_samples: u32,
    /// days_granularity：day | week | month（默认 day）
    pub days_granularity: EventGranularity,
    /// files_page_size：首批文件摘要条数（默认 100）
    pub files_page_size: u32,
    /// events_limit：首页事件条数，≤200（默认 50）
    pub events_limit: u32,
}

impl Default for BootstrapQuery {
    fn default() -> Self {
        Self {
            days_limit: 30,
            days_samples: 4,
            days_granularity: EventGranularity::Day,
            files_page_size: 100,
            events_limit: 50,
        }
    }
}

/// GET /api/v1/bootstrap：在一个短读快照内生成（契约 §1.1）。
pub fn bootstrap(
    store: &ReadonlyStore,
    query: &BootstrapQuery,
) -> Result<BootstrapResponse, GuanlanError> {
    let days_limit = clamp_limit(Some(query.days_limit), 30, 120);
    let days_samples = clamp_limit(Some(query.days_samples), 4, 12);
    let files_page_size = clamp_limit(Some(query.files_page_size), 100, 500);
    let events_limit = clamp_limit(Some(query.events_limit), 50, 200);

    // 短读事务：同一一致性视图内完成全部读取（契约 §1.1；只读连接上的
    // DEFERRED 事务不产生任何写行为，契约 §4-1 只读边界不变）
    store.read_txn(|_conn| {
        let ws = store.workspace()?.clone();
        let ws_id = ws.workspace_id.as_str();
        let conn = store.conn();

        let baseline = store.has_baseline(ws_id)?;
        let counts = store.counts(ws_id)?;
        let time_range = event_time_range_inner(conn, ws_id)?;

        // bootstrap 已在自身 read_txn 内，调 *_tx 变体避免嵌套事务
        let event_days = query_event_days_tx(
            store,
            &EventDaysQuery {
                limit_days: Some(days_limit),
                samples: Some(days_samples),
                granularity: query.days_granularity,
                order: EventOrder::Occurred,
                ..Default::default()
            },
        )?;
        // bootstrap 已在自身 read_txn 内，调 query_events_tx 避免嵌套事务
        let events = query_events_tx(
            store,
            &EventQuery {
                limit: Some(events_limit),
                ..Default::default()
            },
        )?;
        let files = list_files_tx(
            store,
            &FileListQuery {
                limit: Some(files_page_size),
                ..Default::default()
            },
        )?;
        // 决定首批（前端首屏要 selectedDecisionId，App.tsx:336-338；批量上限取
        // §1.9 默认 limit 100），同时透出全库未决待拍板真实总数
        let decisions_page = decisions_tx(store, &DecisionsQuery::default())?;
        let decisions_unresolved_total = decisions_page.unresolved_total;
        let decisions = decisions_page.items;
        let relations = relations_total(conn, ws_id)?;

        // active 文件总数（WorkspaceStore.ts:540-548 的计数口径）
        let files_total: i64 = conn
            .query_row(
                "SELECT COUNT(*) AS n FROM files WHERE workspace_id = ? AND status = 'active'",
                [ws_id],
                |r| r.get(0),
            )
            .map_err(internal_sql)?;

        let config = workspace_config(store, &ws)?;
        let recoverable_file_ids = store.recoverable_file_ids(ws_id)?;

        Ok(BootstrapResponse {
            ok: true,
            workspace: ws,
            baseline,
            counts,
            time_range,
            event_days,
            events,
            files,
            files_total: files_total.max(0) as u64,
            decisions,
            decisions_unresolved_total,
            relations_total: relations,
            config,
            index_jobs: Vec::new(),
            recoverable_file_ids,
        })
    })
}

/// 工作区配置投影（契约 §1.1 config；project.ts:265-310 逐字对齐）
fn workspace_config(
    store: &ReadonlyStore,
    ws: &crate::dto::WorkspaceRecord,
) -> Result<WorkspaceConfig, GuanlanError> {
    let conn = store.conn();
    let ws_id = ws.workspace_id.as_str();

    // active 文件的格式分布（project.ts:266-268）
    let mut stmt = conn
        .prepare("SELECT format, COUNT(*) AS n FROM files WHERE workspace_id = ? AND status = 'active' GROUP BY format")
        .map_err(internal_sql)?;
    let mut by_format: std::collections::HashMap<String, u64> = Default::default();
    let rows = stmt
        .query_map([ws_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(internal_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal_sql)?;
    for (format, n) in rows {
        by_format.insert(format, n.max(0) as u64);
    }
    let md_count = *by_format.get("md").unwrap_or(&0);
    let svg_count = *by_format.get("svg").unwrap_or(&0);
    let pdf_count = *by_format.get("pdf").unwrap_or(&0);
    let active_total: u64 = by_format.values().sum();

    // 快照配额（project.ts:270-272：全表 blob 汇总）
    let (blob_bytes, blob_rows): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(size_bytes),0) AS bytes, COUNT(*) AS n FROM blobs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(internal_sql)?;
    // Number((bytes / 1024 / 1024).toFixed(1))：保留 1 位小数
    let used_total_mib = ((blob_bytes as f64 / 1024.0 / 1024.0) * 10.0).round() / 10.0;

    // runtimeStatus.sseSeq = 最近 2000 条事件计数（project.ts:80-82 eventLimit）
    let sse_seq: i64 = conn
        .query_row(
            "SELECT COUNT(*) AS n FROM (SELECT 1 FROM events WHERE workspace_id = ? LIMIT 2000)",
            [ws_id],
            |row| row.get(0),
        )
        .map_err(internal_sql)?;

    // enumSnapshot.date = last_scan_at 前 10 字符，缺失回退当前 UTC 日期
    // （project.ts:282 `(ws.last_scan_at || new Date().toISOString()).slice(0, 10)`）
    let enum_date = ws
        .last_scan_at
        .as_ref()
        .map(|s| s.chars().take(10).collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(now_utc_date);

    Ok(WorkspaceConfig {
        root_path: ws.root_path.clone(),
        root_key: ws.root_key.clone(),
        data_dir_path: store.data_dir().to_string_lossy().into_owned(),
        excluded_dirs: vec![
            "node_modules".to_owned(),
            ".git".to_owned(),
            "_软件安装包".to_owned(),
            "_spike".to_owned(),
        ],
        disable_git_ignore: true,
        git_ignore_warning: String::new(),
        enum_snapshot: EnumSnapshot {
            date: enum_date,
            md_count,
            svg_count,
            pdf_count,
            total_count: active_total,
            // 现状口径：md 记为索引成功，svg/pdf 记为失败（project.ts:287-291）
            indexed_success_count: md_count,
            parse_failed_count: 0,
            pdf_unindexed_count: pdf_count,
        },
        quota: Quota {
            max_total_mib: 500,
            used_total_mib,
            max_single_binary_mib: policy_dto(store.snapshot_policy()).binary_max_mib.max(1),
            protected_snapshots_count: blob_rows.max(0) as u64,
            evicted_snapshots_count: 0,
        },
        runtime_status: RuntimeStatus {
            connection_mode: "direct_stdio".to_owned(),
            service_state: "monitoring".to_owned(),
            sse_seq: sse_seq.max(0) as u64,
            index_generation: ws.index_generation,
            active_agents: Vec::new(),
            loopback_url: String::new(),
        },
    })
}

/// 当前 UTC 日期 YYYY-MM-DD（无 chrono 依赖的 civil 算法，Howard Hinnant 口径）。
/// 仅用于 last_scan_at 缺失时 enumSnapshot.date 的兜底（project.ts:282 同位）。
fn now_utc_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86400));
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 服务实例身份（契约 §1.2）：进程内 OnceLock 缓存，
/// 以「进程号 + 纳秒时钟」的 SHA-256 前 16 hex 生成。
fn instance_id() -> String {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE
        .get_or_init(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let mut hasher = Sha256::new();
            hasher.update(std::process::id().to_le_bytes());
            hasher.update(nanos.to_le_bytes());
            hex::encode(hasher.finalize())[..16].to_owned()
        })
        .clone()
}

/// GET /api/v1/status（契约 §1.2：实例信息、接口版本、schema 版本、代际与覆盖）
pub fn status(store: &ReadonlyStore) -> Result<StatusResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let ws_id = ws.workspace_id.as_str();
    let conn = store.conn();

    let baseline = store.has_baseline(ws_id)?;
    let counts = store.counts(ws_id)?;
    let time_range = event_time_range_inner(conn, ws_id)?;
    let active_files: i64 = conn
        .query_row(
            "SELECT COUNT(*) AS n FROM files WHERE workspace_id = ? AND status = 'active'",
            [ws_id],
            |r| r.get(0),
        )
        .map_err(internal_sql)?;
    let missing_files: i64 = conn
        .query_row(
            "SELECT COUNT(*) AS n FROM files WHERE workspace_id = ? AND status = 'missing'",
            [ws_id],
            |r| r.get(0),
        )
        .map_err(internal_sql)?;

    Ok(StatusResponse {
        ok: true,
        instance_id: instance_id(),
        api_version: "v1".to_owned(),
        // 数据库 schema 版本（contract-storage.md §4.3.1）
        schema_version: 2,
        workspace_id: ws.workspace_id,
        root_path: ws.root_path,
        data_dir: store.data_dir().to_string_lossy().into_owned(),
        index_generation: ws.index_generation,
        last_scan_at: ws.last_scan_at,
        baseline,
        counts,
        time_range,
        index_coverage: IndexCoverage {
            active_files: active_files.max(0) as u64,
            missing_files: missing_files.max(0) as u64,
        },
        active_jobs: Vec::new(),
        // watcher 与 L4A 进度由服务装配层填充（core 侧先给中性默认值）
        watcher: crate::dto::WatcherStatus {
            enabled: false,
            last_poll_at: None,
            changed_paths_pending: 0,
            l4a_queue_depth: 0,
        },
        l4a_progress: crate::dto::L4aProgress {
            done: 0,
            total: 0,
            percent: 100,
            queue_depth: 0,
        },
    })
}

/// 把 [`SnapshotPolicy`] 转为 wire DTO（供 `/api/v1/storage/stats` 与 `/api/v1/storage/policy` 共用）。
pub fn policy_dto(policy: SnapshotPolicy) -> SnapshotTierPolicyDto {
    SnapshotTierPolicyDto {
        text_max_bytes: policy.text_max_bytes,
        binary_max_bytes: policy.binary_max_bytes,
        text_max_mib: (policy.text_max_bytes.max(0) as u64) / (1024 * 1024),
        binary_max_mib: (policy.binary_max_bytes.max(0) as u64) / (1024 * 1024),
        metadata_only_classes: vec![
            FormatClass::Audio.as_str().to_owned(),
            FormatClass::Video.as_str().to_owned(),
            FormatClass::Font.as_str().to_owned(),
            FormatClass::Binary.as_str().to_owned(),
        ],
    }
}

/// GET /api/v1/storage/stats（真实本地快照磁盘占用、三档策略与全格式分布统计）。
pub fn storage_stats(store: &ReadonlyStore) -> Result<StorageStatsResponse, GuanlanError> {
    store.read_txn(|_conn| {
        let ws = store.workspace()?.clone();
        let ws_id = ws.workspace_id.as_str();
        let conn = store.conn();

        let (blob_bytes, blob_count): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS n FROM blobs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(internal_sql)?;

        let (revs_total, full_revs, meta_only_revs): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN snapshot_available != 0 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN snapshot_available = 0 THEN 1 ELSE 0 END), 0)
                 FROM revisions WHERE workspace_id = ?",
                [ws_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(internal_sql)?;

        // 各格式 active 文件数
        let mut by_format: std::collections::HashMap<String, u64> = Default::default();
        let mut class_files: std::collections::HashMap<&'static str, u64> = Default::default();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT format, COUNT(*) AS n FROM files
                     WHERE workspace_id = ? AND status = 'active'
                     GROUP BY format",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map([ws_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?;
            for (fmt, count) in rows {
                let n = count.max(0) as u64;
                let cls = class_of_token(&fmt).as_str();
                *class_files.entry(cls).or_insert(0) += n;
                by_format.insert(fmt, n);
            }
        }
        let active_files_count: u64 = by_format.values().sum();

        // 各格式版本与快照字节占用（按 file.format 聚合成 FormatClass）
        let mut class_revs: std::collections::HashMap<&'static str, (u64, u64, u64)> =
            Default::default();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT f.format,
                            COUNT(r.revision_id),
                            COALESCE(SUM(CASE WHEN r.snapshot_available = 0 THEN 1 ELSE 0 END), 0),
                            COALESCE(SUM(CASE WHEN r.snapshot_available != 0 THEN r.size_bytes ELSE 0 END), 0)
                     FROM revisions r
                     JOIN files f ON f.file_id = r.file_id
                     WHERE r.workspace_id = ?
                     GROUP BY f.format",
                )
                .map_err(internal_sql)?;
            let rows = stmt
                .query_map([ws_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })
                .map_err(internal_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal_sql)?;
            for (fmt, rev_n, meta_n, bytes) in rows {
                let cls = class_of_token(&fmt).as_str();
                let entry = class_revs.entry(cls).or_insert((0, 0, 0));
                entry.0 += rev_n.max(0) as u64;
                entry.1 += meta_n.max(0) as u64;
                entry.2 += bytes.max(0) as u64;
            }
        }

        let mut by_class = Vec::new();
        for cls in FormatClass::ALL {
            let key = cls.as_str();
            let files_count = class_files.get(key).copied().unwrap_or(0);
            let (revisions_count, metadata_only_revisions, snapshot_bytes) =
                class_revs.get(key).copied().unwrap_or((0, 0, 0));
            if files_count > 0 || revisions_count > 0 {
                by_class.push(FormatClassUsage {
                    format_class: key.to_owned(),
                    label: cls.label().to_owned(),
                    files_count,
                    revisions_count,
                    metadata_only_revisions,
                    snapshot_bytes,
                });
            }
        }

        let blobs_bytes = blob_bytes.max(0) as u64;
        let blobs_disk_bytes = store.blobs_disk_bytes();
        let db_bytes = store.db_disk_bytes();
        let total_disk_bytes = blobs_disk_bytes.saturating_add(db_bytes);
        let used_total_mib =
            ((total_disk_bytes as f64 / 1024.0 / 1024.0) * 100.0).round() / 100.0;
        let policy = policy_dto(store.snapshot_policy());

        Ok(StorageStatsResponse {
            ok: true,
            index_generation: ws.index_generation,
            workspace_id: ws.workspace_id,
            data_dir_path: store.data_dir().to_string_lossy().into_owned(),
            blobs_bytes,
            blobs_disk_bytes,
            blobs_count: blob_count.max(0) as u64,
            db_bytes,
            total_disk_bytes,
            used_total_mib,
            active_files_count,
            revisions_total: revs_total.max(0) as u64,
            full_snapshot_revisions: full_revs.max(0) as u64,
            metadata_only_revisions: meta_only_revs.max(0) as u64,
            gitignore_respected: true,
            policy,
            by_class,
            by_format,
        })
    })
}

#[cfg(test)]
#[path = "bootstrap_tests.rs"]
mod tests;
