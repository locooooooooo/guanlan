//! 后端集成测试：存量工作区「一键确立已读基线 / 目录全标已读 / 撤销还原」
//!
//! 覆盖验收口径：
//! 1. 5,000 份活跃文件批量确立基线 `< 150ms`、幂等（二次调用 affected=0）；
//! 2. 后续修改 1 份文件并重新对账后，仅该 1 份文件成为未读（再次 mark_baseline 仅更新该 1 份）；
//! 3. `scope=folder` 仅影响指定目录前缀下文件，绝不越界污染其他目录；
//! 4. `action=restore` 按返回的 `undo_items` 100% 无损还原原未读集与旧版本基线。

use std::fs;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use guanlan_core::dto::ReadingStateBatchRequest;
use guanlan_core::index::writer::Writer;
use guanlan_core::index::{reconcile, ReconcileOptions};
use guanlan_core::query;
use guanlan_core::storage::ReadonlyStore;

struct TempWs {
    base: PathBuf,
    root: PathBuf,
    data_dir: PathBuf,
}

impl TempWs {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("guanlan-v04-{tag}-{}-{nanos}", std::process::id()));
        let root = base.join("ws");
        let data_dir = base.join("data");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&data_dir).expect("create data_dir");
        Self {
            base,
            root,
            data_dir,
        }
    }

    fn root_str(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn write_md(&self, rel: &str, body: &str) {
        let full = self.root.join(rel);
        if let Some(p) = full.parent() {
            fs::create_dir_all(p).expect("mkdir");
        }
        fs::write(&full, body).expect("write md");
    }
}

impl Drop for TempWs {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn v04_batch_reading_baseline_5000_files_fast_idempotent_and_exact_undo() {
    let ws = TempWs::new("5000-scale");
    let mut writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("writer");
    let ws_id = writer.workspace().expect("ws").workspace_id;

    // 批量植入 5,000 份活跃文件（分属 alpha / beta 两大目录），模拟真实 5,500+ 超大工程
    writer
        .transaction(|w| {
            let conn = w.conn();
            let mut stmt = conn
                .prepare(
                    "INSERT INTO files (
                        file_id, workspace_id, current_path, format, title, role,
                        first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status
                     ) VALUES (?1, ?2, ?3, 'md', ?4, '文档', '2026-11-23T08:00:00Z',
                               '2026-11-23T08:00:00Z', 1763884800000.0, ?5, 'active')",
                )
                .expect("prep");
            for i in 0..5000usize {
                let dir = if i < 2000 {
                    "01-业务方案"
                } else {
                    "04-智能体代码"
                };
                let fid = format!("f_{i:05}");
                let path = format!("{dir}/doc-{i:05}.md");
                let title = format!("doc-{i:05}");
                let rev = format!("r_{i:05}_v1");
                stmt.execute(rusqlite::params![fid, ws_id, path, title, rev])
                    .expect("insert file");
            }
            Ok(())
        })
        .expect("seed 5000 files");

    // 先对 01-业务方案 做目录级确立已读基线（仅影响 2000 份，不越界）
    let folder_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("folder".to_owned()),
            folder_prefix: Some("01-业务方案".to_owned()),
            ..Default::default()
        })
        .expect("folder baseline");
    assert_eq!(folder_resp.affected_count, 2000);
    assert_eq!(folder_resp.undo_items.len(), 2000);

    // 撤销还原 01-业务方案，恢复 5000 份全未读以测全库 5,000 份耗时
    let restore_folder = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "restore".to_owned(),
            restore_items: Some(folder_resp.undo_items),
            ..Default::default()
        })
        .expect("restore folder");
    assert_eq!(restore_folder.affected_count, 2000);

    // 预置 1 条旧已读记录（模拟已读过 v0，现文件已是 v1）以验证撤销能 100% 还原旧版本
    writer
        .conn()
        .execute(
            "INSERT INTO reading_states (workspace_id, file_id, last_read_revision_id, updated_at)
             VALUES (?1, 'f_00000', 'r_00000_v0', '2026-11-22T10:00:00Z')",
            [&ws_id],
        )
        .expect("seed old read state");

    // 5,000 份全库一键确立已读基线：必须 < 150ms
    let t0 = Instant::now();
    let full_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("workspace".to_owned()),
            ..Default::default()
        })
        .expect("workspace baseline");
    let elapsed_ms = t0.elapsed().as_millis();
    assert_eq!(full_resp.affected_count, 5000);
    assert_eq!(full_resp.undo_items.len(), 5000);
    assert!(
        elapsed_ms < 150,
        "5,000 份批量确立已读基线耗时 {elapsed_ms}ms 超过 150ms 预算"
    );

    // 幂等性验证：二次调用受影响数量恒为 0
    let second_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("workspace".to_owned()),
            ..Default::default()
        })
        .expect("second idempotent call");
    assert_eq!(second_resp.affected_count, 0, "重复确立基线必须严格幂等");

    // 模拟 1 份文件产生新版本 v2 -> 仅该 1 份重新亮起未读
    writer
        .conn()
        .execute(
            "UPDATE files SET last_revision_id = 'r_00042_v2'
              WHERE workspace_id = ?1 AND file_id = 'f_00042'",
            [&ws_id],
        )
        .expect("bump one file");
    let delta_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("workspace".to_owned()),
            ..Default::default()
        })
        .expect("delta mark");
    assert_eq!(delta_resp.affected_count, 1);
    assert_eq!(delta_resp.updated_items[0].file_id, "f_00042");
    assert_eq!(
        delta_resp.updated_items[0].last_read_revision_id,
        "r_00042_v2"
    );

    // 撤销还原整批 5,000 份：验证 f_00000 回到 r_00000_v0，其余 4,999 份恢复未读（清空）
    let undo_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "restore".to_owned(),
            restore_items: Some(full_resp.undo_items),
            ..Default::default()
        })
        .expect("undo full baseline");
    assert_eq!(undo_resp.affected_count, 5000);

    let ro = ReadonlyStore::open_at(&ws.data_dir, &ws.root_str()).expect("ro");
    let list = query::reading_states(&ro).expect("query reading_states");
    assert_eq!(list.items.len(), 1, "撤销后应仅剩原先那 1 条旧已读记录");
    assert_eq!(list.items[0].file_id, "f_00000");
    assert_eq!(list.items[0].last_read_revision_id, "r_00000_v0");
}

#[test]
fn v04_real_reconcile_change_lights_up_only_modified_file() {
    let ws = TempWs::new("real-reconcile");
    ws.write_md("01-方案/a.md", "# A\n\n第一版内容\n");
    ws.write_md("01-方案/b.md", "# B\n\n第一版内容\n");
    ws.write_md("02-记录/c.md", "# C\n\n第一版内容\n");

    let mut writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("writer");
    reconcile(&mut writer, &ReconcileOptions::default()).expect("initial reconcile");

    let baseline = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("workspace".to_owned()),
            ..Default::default()
        })
        .expect("mark baseline");
    assert_eq!(baseline.affected_count, 3);

    // 真实修改 01-方案/b.md 并再次对账
    ws.write_md("01-方案/b.md", "# B\n\n第二版新增结论：采用方案 A。\n");
    reconcile(&mut writer, &ReconcileOptions::default()).expect("second reconcile");

    let after_edit = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("workspace".to_owned()),
            ..Default::default()
        })
        .expect("post edit mark");
    assert_eq!(
        after_edit.affected_count, 1,
        "修改 1 份文档后仅该 1 份需要重新确立已读"
    );
}

#[test]
fn reading_state_mark_read_mark_unread_and_like_escape_windows_paths() {
    let ws = TempWs::new("mark-read-unread-escape");
    let mut writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("writer");
    let ws_id = writer.workspace().expect("ws").workspace_id;

    writer
        .transaction(|w| {
            let conn = w.conn();
            let mut stmt = conn
                .prepare(
                    "INSERT INTO files (
                        file_id, workspace_id, current_path, format, title, role,
                        first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status
                     ) VALUES (?1, ?2, ?3, 'md', ?4, '文档', '2026-11-23T08:00:00Z',
                               '2026-11-23T08:00:00Z', 1763884800000.0, ?5, 'active')",
                )
                .expect("prep");
            // 含下划线 `_` 与 `%` 的目录名、以及 Windows 反斜杠路径，用于检验 LIKE 转义与跨分隔符匹配
            let rows = [
                ("f_under", "_qa/report.md", "report", "r_under_1"),
                ("f_similar", "xqa/other.md", "other", "r_similar_1"),
                ("f_pct", "100%_done/ok.md", "ok", "r_pct_1"),
                ("f_pct_other", "100abc_done/no.md", "no", "r_pct_other_1"),
                ("f_win", "docs\\win_dir\\note.md", "note", "r_win_1"),
            ];
            for (fid, path, title, rev) in rows {
                stmt.execute(rusqlite::params![fid, ws_id, path, title, rev])
                    .expect("insert");
            }
            Ok(())
        })
        .expect("seed");

    // 1. `_qa` 绝不可误伤 `xqa`
    let under_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("folder".to_owned()),
            folder_prefix: Some("_qa".to_owned()),
            ..Default::default()
        })
        .expect("_qa mark_baseline");
    assert_eq!(under_resp.affected_count, 1);
    assert_eq!(under_resp.updated_items[0].file_id, "f_under");

    // 2. `100%_done` 绝不可误伤 `100abc_done`
    let pct_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("folder".to_owned()),
            folder_prefix: Some("100%_done".to_owned()),
            ..Default::default()
        })
        .expect("100%_done mark_baseline");
    assert_eq!(pct_resp.affected_count, 1);
    assert_eq!(pct_resp.updated_items[0].file_id, "f_pct");

    // 3. Windows 反斜杠路径也能被 `/` 前缀准确命中
    let win_resp = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_baseline".to_owned(),
            scope: Some("folder".to_owned()),
            folder_prefix: Some("docs/win_dir".to_owned()),
            ..Default::default()
        })
        .expect("win path mark_baseline");
    assert_eq!(win_resp.affected_count, 1);
    assert_eq!(win_resp.updated_items[0].file_id, "f_win");

    // 4. 单文件 mark_read 落库 + 幂等
    let single_read = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_read".to_owned(),
            file_ids: Some(vec!["f_similar".to_owned()]),
            revision_id: Some("r_similar_1".to_owned()),
            ..Default::default()
        })
        .expect("single mark_read");
    assert_eq!(single_read.affected_count, 1);
    assert_eq!(
        single_read.updated_items[0].last_read_revision_id,
        "r_similar_1"
    );
    let single_read_again = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_read".to_owned(),
            file_ids: Some(vec!["f_similar".to_owned()]),
            revision_id: Some("r_similar_1".to_owned()),
            ..Default::default()
        })
        .expect("idempotent mark_read");
    assert_eq!(single_read_again.affected_count, 0);

    // 5. 单文件 mark_unread 精确清除 + restore 撤销还原
    let single_unread = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_unread".to_owned(),
            file_ids: Some(vec!["f_similar".to_owned()]),
            ..Default::default()
        })
        .expect("single mark_unread");
    assert_eq!(single_unread.affected_count, 1);
    assert_eq!(single_unread.undo_items.len(), 1);
    assert_eq!(
        single_unread.undo_items[0].previous_revision_id.as_deref(),
        Some("r_similar_1")
    );

    let ro = ReadonlyStore::open_at(&ws.data_dir, &ws.root_str()).expect("ro");
    let list_after_unread = query::reading_states(&ro).expect("query");
    assert!(!list_after_unread
        .items
        .iter()
        .any(|it| it.file_id == "f_similar"));

    // 6. 目录级 mark_unread（含转义）+ restore 撤销还原
    let folder_unread = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "mark_unread".to_owned(),
            scope: Some("folder".to_owned()),
            folder_prefix: Some("_qa".to_owned()),
            ..Default::default()
        })
        .expect("folder mark_unread");
    assert_eq!(folder_unread.affected_count, 1);
    assert_eq!(folder_unread.undo_items[0].file_id, "f_under");

    let undo_folder_unread = writer
        .batch_reading_state(&ReadingStateBatchRequest {
            action: "restore".to_owned(),
            restore_items: Some(folder_unread.undo_items),
            ..Default::default()
        })
        .expect("undo folder mark_unread");
    assert_eq!(undo_folder_unread.affected_count, 1);
    let list_after_restore = query::reading_states(&ro).expect("query after restore");
    assert!(list_after_restore
        .items
        .iter()
        .any(|it| it.file_id == "f_under" && it.last_read_revision_id == "r_under_1"));
}
