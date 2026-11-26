//! SQLite Schema 平滑迁移、升级前自动一致性备份（SQLite Backup API，保留最近 5 份）与高版本只读门禁。
//!
//! 停机红线：
//! 1. **高版本门禁拒绝盲写**：打开任意 `PRAGMA user_version > CURRENT_SCHEMA_VERSION` 的库时，
//!    在写入任何字节或执行任何 PRAGMA/DDL 之前立即以 `SCHEMA_TOO_NEW` 拒绝；
//! 2. **升级前强制一致性备份**：对已有历史表的旧版库执行 schema 升级前，必须通过
//!    **SQLite Online Backup API**（`rusqlite::backup::Backup` / `sqlite3_backup_*`）
//!    先在 `<data_dir>/backups/` 生成一份通过 `PRAGMA quick_check` 验证的独立一致性备份，
//!    并按时间滚动保留最近 **5 份**（`MAX_MIGRATION_BACKUPS = 5`）；
//! 3. **原子回滚与无损恢复**：升级 DDL 在 `BEGIN IMMEDIATE ... COMMIT` 事务内执行；
//!    一旦人为或意外触发迁移失败，立即 `ROLLBACK`，原库 100% 完好不丢失任何既有历史事件，
//!    且同时提供 `restore_backup_to_db` 支持从一致性备份文件无损还原。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::error::GuanlanError;
use crate::storage::internal_sql;

/// 本版本观澜支持的最高 SQLite Schema 版本（与 `PRAGMA user_version` 对齐）
pub const CURRENT_SCHEMA_VERSION: i64 = 2;

/// 升级前一致性备份默认最大保留份数（保留最近 5 份）
pub const MAX_MIGRATION_BACKUPS: usize = 5;

/// 单份自动一致性备份条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationBackupEntry {
    pub file_name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_epoch_ms: u64,
}

/// 迁移前探测结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationProbe {
    /// 库内是否已存在核心历史表（`workspaces` / `events`）
    pub existing_db: bool,
    /// 当前 `PRAGMA user_version`
    pub from_version: i64,
    /// 是否需要执行表结构/列升级或版本推进
    pub needs_migration: bool,
}

/// 迁移执行回执
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationOutcome {
    pub from_version: i64,
    pub to_version: i64,
    pub migrated: bool,
    pub backup_created: Option<MigrationBackupEntry>,
    pub backups_retained: usize,
}

/// 高版本只读门禁：在执行任何写入/WAL/DDL 前强校验 `PRAGMA user_version`。
/// 一旦检测到 `user_version > CURRENT_SCHEMA_VERSION`，立即以 `SCHEMA_TOO_NEW` 拒绝盲写！
pub fn check_schema_version_writable(conn: &Connection) -> Result<i64, GuanlanError> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| GuanlanError::Internal(format!("读取 PRAGMA user_version 失败：{e}")))?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(GuanlanError::Internal(format!(
            "SCHEMA_TOO_NEW: 当前数据库 schema 版本 v{version} 高于本程序支持的最高版本 v{CURRENT_SCHEMA_VERSION}，已触发高版本门禁拒绝盲写以保护历史数据；请升级至新版观澜或使用只读导出工具"
        )));
    }
    if version < 0 {
        return Err(GuanlanError::Internal(format!(
            "SCHEMA_INVALID: 检测到非法 schema 版本值 {version}，拒绝打开"
        )));
    }
    Ok(version)
}

/// 探测是否属于需要平滑升级的既有库（区别于首次冷建空库）
pub fn probe_schema_migration(conn: &Connection) -> Result<MigrationProbe, GuanlanError> {
    let from_version = check_schema_version_writable(conn)?;
    let existing_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('workspaces', 'files', 'events')",
            [],
            |row| row.get(0),
        )
        .map_err(internal_sql)?;
    let existing_db = existing_tables > 0;

    let mut needs_migration = from_version < CURRENT_SCHEMA_VERSION;
    if !needs_migration && existing_db {
        let missing_detail: i64 = conn
            .query_row(
                "SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('statements') WHERE name = 'detail_json') THEN 0 ELSE 1 END",
                [],
                |row| row.get(0),
            )
            .unwrap_or(1);
        let missing_draft_cols: i64 = conn
            .query_row(
                "SELECT 3 - COUNT(*) FROM pragma_table_info('revision_drafts')
                  WHERE name IN ('draft_version_label', 'input_context_hashes_json', 'receipt_summary')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(3);
        let missing_tables: i64 = conn
            .query_row(
                "SELECT 2 - COUNT(*) FROM sqlite_master
                  WHERE type = 'table' AND name IN ('search_docs', 'decision_ledger_chain')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(2);
        if missing_detail > 0 || missing_draft_cols > 0 || missing_tables > 0 {
            needs_migration = true;
        }
    }

    Ok(MigrationProbe {
        existing_db,
        from_version,
        needs_migration,
    })
}

/// 使用原生 **SQLite Online Backup API**（`sqlite3_backup_init/step/finish`）生成 100% 事务一致性独立备份，
/// 并经 `PRAGMA quick_check` 核验后原子落盘，随后按最近时间滚动保留最多 `max_keep` 份（默认 5 份）。
pub fn create_consistent_sqlite_backup(
    src_conn: &Connection,
    backups_dir: &Path,
    from_version: i64,
    to_version: i64,
    max_keep: usize,
) -> Result<MigrationBackupEntry, GuanlanError> {
    fs::create_dir_all(backups_dir).map_err(|e| {
        GuanlanError::Internal(format!(
            "创建迁移备份目录失败 {}：{e}",
            backups_dir.display()
        ))
    })?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut seq = 0u32;
    let final_name = loop {
        let candidate = if seq == 0 {
            format!("index-pre-v{from_version}-to-v{to_version}-{now_ms}.db")
        } else {
            format!("index-pre-v{from_version}-to-v{to_version}-{now_ms}-{seq}.db")
        };
        if !backups_dir.join(&candidate).exists() {
            break candidate;
        }
        seq += 1;
    };
    let tmp_path = backups_dir.join(format!(".{final_name}.tmp"));
    let final_path = backups_dir.join(&final_name);

    {
        let mut dst_conn = Connection::open_with_flags(
            &tmp_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|e| {
            GuanlanError::Internal(format!(
                "创建 SQLite 备份目标文件失败 {}：{e}",
                tmp_path.display()
            ))
        })?;
        {
            let backup = Backup::new(src_conn, &mut dst_conn).map_err(|e| {
                GuanlanError::Internal(format!("初始化 SQLite Backup API 失败：{e}"))
            })?;
            backup
                .run_to_completion(64, Duration::from_millis(5), None)
                .map_err(|e| {
                    let _ = fs::remove_file(&tmp_path);
                    GuanlanError::Internal(format!("执行 SQLite Backup API 一致性备份失败：{e}"))
                })?;
        }
        let check: String = dst_conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|e| {
                let _ = fs::remove_file(&tmp_path);
                GuanlanError::Internal(format!("备份文件一致性检查失败：{e}"))
            })?;
        if !check.eq_ignore_ascii_case("ok") {
            let _ = fs::remove_file(&tmp_path);
            return Err(GuanlanError::Internal(format!(
                "备份文件一致性校验未通过（quick_check={check}），已中止升级"
            )));
        }
    }

    fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        GuanlanError::Internal(format!(
            "落盘迁移备份失败 {} → {}：{e}",
            tmp_path.display(),
            final_path.display()
        ))
    })?;

    prune_old_backups(backups_dir, max_keep.max(1))?;

    let meta = fs::metadata(&final_path).map_err(|e| {
        GuanlanError::Internal(format!("读取备份元数据失败 {}：{e}", final_path.display()))
    })?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(now_ms as u64);

    Ok(MigrationBackupEntry {
        file_name: final_name,
        path: final_path.to_string_lossy().into_owned(),
        size_bytes: meta.len(),
        modified_epoch_ms: modified_ms,
    })
}

/// 列出 `<data_dir>/backups` 中全部一致性备份（按文件名/时间倒序，最新在前）
pub fn list_migration_backups(data_dir: &Path) -> Result<Vec<MigrationBackupEntry>, GuanlanError> {
    let backups_dir = data_dir.join("backups");
    list_backups_in_dir(&backups_dir)
}

fn list_backups_in_dir(backups_dir: &Path) -> Result<Vec<MigrationBackupEntry>, GuanlanError> {
    if !backups_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<MigrationBackupEntry> = Vec::new();
    let rd = fs::read_dir(backups_dir).map_err(|e| {
        GuanlanError::Internal(format!("读取备份目录失败 {}：{e}", backups_dir.display()))
    })?;
    for item in rd.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !name.starts_with("index-pre-") || !name.ends_with(".db") {
            continue;
        }
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(MigrationBackupEntry {
            file_name: name.to_owned(),
            path: path.to_string_lossy().into_owned(),
            size_bytes: meta.len(),
            modified_epoch_ms: modified_ms,
        });
    }
    entries.sort_by(|a, b| {
        b.modified_epoch_ms
            .cmp(&a.modified_epoch_ms)
            .then_with(|| b.file_name.cmp(&a.file_name))
    });
    Ok(entries)
}

/// 按最新顺序滚动清理超额备份，只保留最近 `max_keep` 份（默认 5 份）
pub fn prune_old_backups(backups_dir: &Path, max_keep: usize) -> Result<usize, GuanlanError> {
    let entries = list_backups_in_dir(backups_dir)?;
    let mut removed = 0usize;
    for old in entries.iter().skip(max_keep) {
        if fs::remove_file(&old.path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 原子事务化安全迁移器：
/// 1. 强校验高版本门禁（`user_version > CURRENT_SCHEMA_VERSION` 立即拒写）；
/// 2. 对已有历史数据的库执行升级前，先调 SQLite Online Backup API 落盘验证备份（最多留 5 份）；
/// 3. 在 `BEGIN IMMEDIATE ... COMMIT` 事务内执行 `apply_ddl` 并推进 `PRAGMA user_version`；
/// 4. 任何步骤失败立即 `ROLLBACK`，保证原库 100% 完好零丢事件。
pub fn run_safe_schema_migration<F>(
    conn: &Connection,
    data_dir: &Path,
    apply_ddl: F,
) -> Result<MigrationOutcome, GuanlanError>
where
    F: FnOnce(&Connection) -> Result<(), GuanlanError>,
{
    let probe = probe_schema_migration(conn)?;
    if !probe.needs_migration && probe.existing_db {
        let retained = list_migration_backups(data_dir)?.len();
        return Ok(MigrationOutcome {
            from_version: probe.from_version,
            to_version: probe.from_version,
            migrated: false,
            backup_created: None,
            backups_retained: retained,
        });
    }

    let backup_created = if probe.existing_db && probe.needs_migration {
        let entry = create_consistent_sqlite_backup(
            conn,
            &data_dir.join("backups"),
            probe.from_version,
            CURRENT_SCHEMA_VERSION,
            MAX_MIGRATION_BACKUPS,
        )?;
        Some(entry)
    } else {
        None
    };

    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| GuanlanError::Internal(format!("开启迁移写事务失败：{e}")))?;

    let outcome = (|| -> Result<(), GuanlanError> {
        apply_ddl(conn)?;
        if probe.from_version < CURRENT_SCHEMA_VERSION {
            conn.execute_batch(&format!("PRAGMA user_version = {CURRENT_SCHEMA_VERSION};"))
                .map_err(|e| GuanlanError::Internal(format!("推进 schema 版本失败：{e}")))?;
        }
        Ok(())
    })();

    match outcome {
        Ok(()) => {
            conn.execute_batch("COMMIT;")
                .map_err(|e| GuanlanError::Internal(format!("提交迁移事务失败：{e}")))?;
            let retained = list_migration_backups(data_dir)?.len();
            Ok(MigrationOutcome {
                from_version: probe.from_version,
                to_version: CURRENT_SCHEMA_VERSION,
                migrated: true,
                backup_created,
                backups_retained: retained,
            })
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(err)
        }
    }
}

/// 从指定一致性备份文件无损还原到目标 `index.db`（先校验备份完整性再替换，同时清理旧 `-wal`/`-shm`）
pub fn restore_backup_to_db(backup_path: &Path, target_db_path: &Path) -> Result<(), GuanlanError> {
    if !backup_path.is_file() {
        return Err(GuanlanError::NotFound(format!(
            "备份文件不存在：{}",
            backup_path.display()
        )));
    }
    {
        let check_conn = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| GuanlanError::Internal(format!("打开备份文件失败：{e}")))?;
        let res: String = check_conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|e| GuanlanError::Internal(format!("核验备份完整性失败：{e}")))?;
        if !res.eq_ignore_ascii_case("ok") {
            return Err(GuanlanError::Internal(format!(
                "拒绝还原损坏备份（integrity_check={res}）"
            )));
        }
    }
    let wal = PathBuf::from(format!("{}-wal", target_db_path.display()));
    let shm = PathBuf::from(format!("{}-shm", target_db_path.display()));
    let _ = fs::remove_file(&wal);
    let _ = fs::remove_file(&shm);

    let staged = PathBuf::from(format!("{}.restore.tmp", target_db_path.display()));
    fs::copy(backup_path, &staged)
        .map_err(|e| GuanlanError::Internal(format!("暂存还原备份失败：{e}")))?;
    fs::rename(&staged, target_db_path).map_err(|e| {
        let _ = fs::remove_file(&staged);
        GuanlanError::Internal(format!("覆盖还原数据库失败：{e}"))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Writer;
    use crate::storage::ReadonlyStore;

    struct TempMigDir(PathBuf);

    impl TempMigDir {
        fn new(tag: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "guanlan-f03-mig-{tag}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(dir.join("ws")).unwrap();
            fs::create_dir_all(dir.join("data")).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempMigDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seed_legacy_v1_db(db_path: &Path) {
        let conn = Connection::open(db_path).unwrap();
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE workspaces (
              workspace_id TEXT PRIMARY KEY,
              root_path TEXT NOT NULL UNIQUE,
              root_key TEXT NOT NULL,
              created_at TEXT NOT NULL,
              last_scan_at TEXT,
              index_generation INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id TEXT NOT NULL UNIQUE,
              workspace_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              subject_kind TEXT NOT NULL,
              subject_id TEXT NOT NULL,
              revision_id TEXT,
              occurred_at TEXT,
              occurred_precision TEXT NOT NULL DEFAULT 'unknown',
              occurred_source TEXT,
              observed_at TEXT NOT NULL,
              headline TEXT NOT NULL,
              detail TEXT NOT NULL,
              payload_json TEXT NOT NULL DEFAULT '{}',
              batch_id TEXT
            );
            CREATE TABLE statements (
              statement_id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              file_id TEXT NOT NULL,
              revision_id TEXT NOT NULL,
              code TEXT NOT NULL,
              namespace TEXT NOT NULL,
              question TEXT NOT NULL,
              status TEXT NOT NULL,
              quote TEXT NOT NULL,
              line_start INTEGER NOT NULL,
              line_end INTEGER NOT NULL,
              decision_id TEXT,
              extract_rule_version TEXT NOT NULL,
              observed_at TEXT NOT NULL
            );
            INSERT INTO workspaces VALUES ('ws_legacy', 'H:/legacy', 'rk_legacy', '2026-01-01T00:00:00Z', NULL, 7);
            INSERT INTO events (event_id, workspace_id, kind, subject_kind, subject_id, observed_at, headline, detail)
            VALUES
              ('ev_hist_1', 'ws_legacy', 'file_appeared', 'file', 'f1', '2026-01-01T00:00:00Z', '历史事件1', '细节1'),
              ('ev_hist_2', 'ws_legacy', 'decision_confirmed', 'decision', 'd1', '2026-01-02T00:00:00Z', '历史事件2', '细节2'),
              ('ev_hist_3', 'ws_legacy', 'file_modified', 'file', 'f1', '2026-01-03T00:00:00Z', '历史事件3', '细节3');
            PRAGMA user_version = 1;
            "#,
        )
        .unwrap();
    }

    #[test]
    fn f03_high_schema_version_gate_rejects_blind_write_and_readonly_open() {
        let tmp = TempMigDir::new("high-ver");
        let data_dir = tmp.0.join("data");
        let ws_dir = tmp.0.join("ws");
        let db_path = data_dir.join("index.db");
        seed_legacy_v1_db(&db_path);
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        }

        let err = Writer::open_at(&data_dir, ws_dir.to_str().unwrap())
            .expect_err("高版本 v99 必须拒绝盲写");
        assert!(
            err.to_string().contains("SCHEMA_TOO_NEW"),
            "错误信息应明确提示 SCHEMA_TOO_NEW，实得：{err}"
        );

        let ro_err = ReadonlyStore::open(&db_path).expect_err("只读打开高版本 v99 同样应拒绝");
        assert!(
            ro_err.to_string().contains("SCHEMA_TOO_NEW"),
            "只读门禁同样应明确报 SCHEMA_TOO_NEW，实得：{ro_err}"
        );

        let verify = Connection::open(&db_path).unwrap();
        let ver: i64 = verify
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let ev_cnt: i64 = verify
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ver, 99);
        assert_eq!(ev_cnt, 3);
    }

    #[test]
    fn f03_auto_backup_before_upgrade_retains_latest_five_and_preserves_history() {
        let tmp = TempMigDir::new("backup-5");
        let data_dir = tmp.0.join("data");
        let ws_dir = tmp.0.join("ws");
        let db_path = data_dir.join("index.db");
        seed_legacy_v1_db(&db_path);

        let writer = Writer::open_at(&data_dir, ws_dir.to_str().unwrap()).expect("平滑升级成功");
        let ver: i64 = writer
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let ev_cnt: i64 = writer
            .conn()
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ver, CURRENT_SCHEMA_VERSION);
        assert_eq!(ev_cnt, 3, "原地覆盖升级绝不得丢失任何既有历史事件");

        let backups = list_migration_backups(&data_dir).unwrap();
        assert_eq!(backups.len(), 1, "首次升级应自动生成 1 份备份");
        {
            let bk_conn =
                Connection::open_with_flags(&backups[0].path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            let bk_ver: i64 = bk_conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            let bk_ev: i64 = bk_conn
                .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
                .unwrap();
            assert_eq!(bk_ver, 1);
            assert_eq!(bk_ev, 3);
        }

        for i in 0..6 {
            std::thread::sleep(Duration::from_millis(5));
            create_consistent_sqlite_backup(
                writer.conn(),
                &data_dir.join("backups"),
                1,
                2 + i,
                MAX_MIGRATION_BACKUPS,
            )
            .unwrap();
        }
        let after = list_migration_backups(&data_dir).unwrap();
        assert_eq!(
            after.len(),
            MAX_MIGRATION_BACKUPS,
            "自动备份目录必须严格滚动保留最近 5 份"
        );
    }

    #[test]
    fn f03_injected_migration_failure_rolls_back_losslessly_and_backup_restores_cleanly() {
        let tmp = TempMigDir::new("rollback");
        let data_dir = tmp.0.join("data");
        let db_path = data_dir.join("index.db");
        seed_legacy_v1_db(&db_path);

        {
            let conn = Connection::open(&db_path).unwrap();
            let err = run_safe_schema_migration(&conn, &data_dir, |c| {
                c.execute_batch(
                    "CREATE TABLE injected_partial_table (id INTEGER PRIMARY KEY);
                     ALTER TABLE statements ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}';",
                )
                .map_err(internal_sql)?;
                Err(GuanlanError::Internal(
                    "INJECTED_MIGRATION_FAILURE: 模拟升级中途断电/约束失败".to_owned(),
                ))
            })
            .expect_err("注入失败必须返回错误");
            assert!(err.to_string().contains("INJECTED_MIGRATION_FAILURE"));

            let ver: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            let partial_exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'injected_partial_table'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let ev_cnt: i64 = conn
                .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
                .unwrap();
            assert_eq!(ver, 1, "失败后 schema 版本必须原样保持 v1");
            assert_eq!(partial_exists, 0, "失败后半截表必须 100% 回滚");
            assert_eq!(ev_cnt, 3, "失败后 3 条既有历史事件必须 100% 完好");
        }

        let backups = list_migration_backups(&data_dir).unwrap();
        assert_eq!(backups.len(), 1);
        fs::write(&db_path, b"CORRUPTED_LIVE_DB").unwrap();
        restore_backup_to_db(Path::new(&backups[0].path), &db_path).expect("从备份无损恢复");

        let restored = Connection::open(&db_path).unwrap();
        let ev_cnt: i64 = restored
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ev_cnt, 3, "备份恢复后 3 条历史事件 100% 无损");
    }
}
