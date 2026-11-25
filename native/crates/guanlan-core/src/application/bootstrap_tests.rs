//! bootstrap / status 的单元测试（契约 §1.1/§1.2）：一个短读事务内的合成响应、
//! 各计数口径、以及「不含正文/版本链/SVG 原文」的硬约束。

use crate::application::{bootstrap, status, BootstrapQuery};
use crate::query::{DecisionsQuery, FileListQuery};
use crate::storage::ReadonlyStore;
use crate::test_support::{cleanup_dir, collect_forbidden_keys, open_store, FixtureDb};

const H1: &str = "aa0000000000000000000000000000000000000000000000000000000000aa";

fn setup_workspace(tag: &str) -> (FixtureDb, String, ReadonlyStore) {
    let fixture = FixtureDb::new(tag);
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 7, Some("2026-06-01T12:34:56.000Z"));
    fixture.blob(H1, 3 * 1024 * 1024, 1); // 3 MiB（quota 断言用）
    fixture.write_blob_file(H1, b"# body text");
    fixture.file(&ws_id, "f_a", "docs/a.md", "md", "方案", "active", None);
    let ra = fixture.revision(
        &ws_id,
        "f_a",
        1,
        H1,
        3 * 1024 * 1024,
        Some("2026-06-01"),
        "day",
        Some("document_self"),
        1,
        "2026-06-01T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_a'",
            rusqlite::params![ra],
        )
        .expect("回填失败");
    fixture.file(&ws_id, "f_b", "notes/b.md", "md", "交接", "active", None);
    fixture.file(&ws_id, "f_c", "assets/c.pdf", "pdf", "交接", "active", None);
    fixture.file(&ws_id, "f_d", "old/d.md", "md", "方案", "missing", None);
    fixture.event(
        &ws_id,
        "modified",
        "revision",
        &ra,
        Some(&ra),
        Some("2026-06-01"),
        "day",
        Some("document_self"),
        "2026-06-01T00:00:00.000Z",
        "修改 a",
        "",
        r#"{"path":"docs/a.md","format":"md"}"#,
    );
    fixture.event(
        &ws_id,
        "workspace_baseline",
        "workspace",
        &ws_id,
        None,
        Some("2026-06-01"),
        "day",
        Some("collector"),
        "2026-06-01T00:00:00.000Z",
        "首次纳入 3 份资料",
        "",
        "{}",
    );
    fixture.statement(
        &ws_id,
        "st_1",
        "f_a",
        &ra,
        "Q1",
        "项目 / 集",
        "问题？",
        "待确认",
        "> 待确认",
        1,
        2,
        Some("dec_1"),
        "{}",
        "2026-06-01T00:00:00.000Z",
    );
    fixture.edge(
        &ws_id,
        "e1",
        "f_a",
        &ra,
        "f_b",
        "collected_version",
        Some((1, 2)),
        "链接",
    );
    fixture.edge(
        &ws_id,
        "e2",
        "f_a",
        &ra,
        "unresolved:x",
        "unresolved",
        Some((3, 3)),
        "外链",
    );
    let store = open_store(&fixture, &root);
    (fixture, ws_id, store)
}

/// bootstrap 短读事务合成（契约 §1.1）：配置、统计、首批文件摘要、首批事件、
/// 决定首批、任务状态占位；不含正文/完整版本链/全量关系/历史 SVG 原文
#[test]
fn bootstrap_composes_single_snapshot() {
    let (fixture, ws_id, store) = setup_workspace("boot-compose");
    let query = BootstrapQuery {
        days_limit: 120,
        days_samples: 6,
        files_page_size: 2,
        events_limit: 1,
        ..Default::default()
    };
    let boot = bootstrap(&store, &query).expect("bootstrap 失败");
    assert!(boot.ok);
    assert_eq!(boot.workspace.workspace_id, ws_id);
    assert_eq!(boot.workspace.index_generation, 7);
    assert_eq!(
        boot.workspace.last_scan_at.as_deref(),
        Some("2026-06-01T12:34:56.000Z")
    );
    assert!(boot.baseline, "workspace_baseline 事件存在 → baseline true");

    // 统计口径（契约 §1.4）：files 按 ws 过滤（含 missing）；revisions/blobs 全表
    assert_eq!(boot.counts.files, 4);
    assert_eq!(boot.counts.revisions, 1);
    assert_eq!(boot.counts.events, 2);
    assert_eq!(boot.counts.blobs, 1);
    assert_eq!(boot.counts.statements, 1);
    assert_eq!(boot.counts.edges, 2);

    // files_total = active 总数（不含 missing，契约 §1.1）
    assert_eq!(boot.files_total, 3);
    // 首批文件摘要按 files_page_size 截断
    assert_eq!(boot.files.items.len(), 2);
    assert!(boot.files.has_more);
    assert_eq!(boot.files.total_matched, 3);
    // 首页事件按 events_limit 截断
    assert_eq!(boot.events.items.len(), 1);
    // 决定首批（默认 limit 100 → 全量 1 个）
    assert_eq!(boot.decisions.len(), 1);
    assert_eq!(boot.decisions[0].code, "Q1");
    // 关系总数：过滤 unresolved 后的计数
    assert_eq!(boot.relations_total, 1);
    // 任务状态占位
    assert!(boot.index_jobs.is_empty());

    // time_range（camelCase 键保留现状）
    assert_eq!(boot.time_range.occurred_min.as_deref(), Some("2026-06-01"));
    assert_eq!(boot.time_range.undated_count, 0);

    // config 投影（project.ts:274-310）
    let config = &boot.config;
    assert_eq!(config.root_path, fixture.root());
    assert_eq!(
        config.enum_snapshot.date, "2026-06-01",
        "last_scan_at 前 10 字符"
    );
    assert_eq!(config.enum_snapshot.total_count, 3);
    assert_eq!(config.enum_snapshot.md_count, 2);
    assert_eq!(config.enum_snapshot.pdf_count, 1);
    assert_eq!(
        config.enum_snapshot.indexed_success_count, 2,
        "现状口径：仅 md 记成功"
    );
    assert_eq!(config.enum_snapshot.pdf_unindexed_count, 1);
    assert_eq!(config.quota.used_total_mib, 3.0, "3 MiB 快照 → toFixed(1)");
    assert_eq!(
        config.quota.max_single_binary_mib,
        super::policy_dto(store.snapshot_policy())
            .binary_max_mib
            .max(1),
        "bootstrap 配额上限应与三档快照策略一致"
    );
    assert_eq!(config.quota.protected_snapshots_count, 1);
    assert_eq!(config.runtime_status.index_generation, 7);

    // 硬约束（契约 §1.1）：响应任何位置不出现 revisions[] / svgSource / markdownContent
    let json = serde_json::to_value(&boot).expect("序列化");
    // 禁正文/SVG 原文键；counts.revisions 是数量字段（契约 §1.1/§1.4 显式包含），
    // 被禁止的是「revisions[] 版本链数组」本身
    assert_eq!(
        collect_forbidden_keys(&json, &["svgSource", "markdownContent"]),
        Vec::<String>::new(),
        "bootstrap 不得携带正文/SVG 原文"
    );
    for path in collect_forbidden_keys(&json, &["revisions"]) {
        assert_eq!(
            path, "/counts/revisions",
            "bootstrap 不得携带版本链数组，出现：{path}"
        );
    }
    assert_eq!(
        json.get("counts")
            .and_then(|c| c.get("revisions"))
            .and_then(|v| v.as_u64()),
        Some(1),
        "counts.revisions 数量口径（全表计数，契约 §1.4）"
    );

    // 与独立端点同口径：files 首批 / decisions 首批一致
    let files_alone = crate::query::list_files(&store, &FileListQuery::default()).expect("files");
    assert_eq!(files_alone.total_matched, 3);
    let decisions_alone =
        crate::query::decisions(&store, &DecisionsQuery::default()).expect("decisions");
    assert_eq!(decisions_alone.total, 1);
    cleanup_dir(&fixture.dir);
}

/// 空工作区 bootstrap（契约 §1.1「空工作区按尚未覆盖渲染而非报错」）：
/// 各计数为 0、baseline false、enumSnapshot.date 回退当日 UTC 日期
#[test]
fn bootstrap_on_empty_workspace() {
    let fixture = FixtureDb::new("boot-empty");
    let root = fixture.root();
    fixture.workspace(&root, 0, None);
    let store = open_store(&fixture, &root);
    let boot = bootstrap(&store, &BootstrapQuery::default()).expect("空工作区不报错");
    assert!(!boot.baseline);
    assert_eq!(boot.counts.files, 0);
    assert_eq!(boot.files_total, 0);
    assert_eq!(boot.events.items.len(), 0);
    assert_eq!(boot.decisions.len(), 0);
    assert_eq!(boot.relations_total, 0);
    assert!(boot.time_range.occurred_min.is_none());
    assert_eq!(boot.time_range.undated_count, 0);
    // last_scan_at 缺失 → enumSnapshot.date 回退当前 UTC 日期（project.ts:282）
    assert_eq!(boot.config.enum_snapshot.date.len(), 10);
    assert_eq!(
        boot.config.enum_snapshot.date.as_bytes().get(4),
        Some(&b'-')
    );
    cleanup_dir(&fixture.dir);
}

/// status（契约 §1.2）：实例信息、api_version、schema_version=2、覆盖计数
#[test]
fn status_reports_instance_and_coverage() {
    let (fixture, ws_id, store) = setup_workspace("boot-status");
    let st = status(&store).expect("status 失败");
    assert!(st.ok);
    assert_eq!(st.instance_id.len(), 16, "instance_id 应为 16 位十六进制");
    assert_eq!(st.api_version, "v1");
    assert_eq!(st.schema_version, 2, "数据库 schema_version 应为 2");
    assert_eq!(st.workspace_id, ws_id);
    assert_eq!(st.data_dir, fixture.dir.to_string_lossy());
    assert_eq!(st.index_generation, 7);
    assert!(st.baseline);
    assert_eq!(st.index_coverage.active_files, 3);
    assert_eq!(st.index_coverage.missing_files, 1);
    assert!(
        st.active_jobs.is_empty(),
        "core 层只读查询返回空 active_jobs"
    );
    assert_eq!(st.counts.events, 2);
    // 进程内 instance_id 稳定
    let st2 = status(&store).expect("二次 status");
    assert_eq!(st.instance_id, st2.instance_id, "同进程 instance_id 不变");
    cleanup_dir(&fixture.dir);
}

/// storage_stats 诚实汇总本地磁盘占用、仅元数据版本计数与格式族分布
#[test]
fn storage_stats_reports_disk_usage_and_format_breakdown() {
    let (fixture, ws_id, _store) = setup_workspace("boot-storage-stats");
    fixture.file(
        &ws_id,
        "f_vid",
        "video/demo.mp4",
        "mp4",
        "其他",
        "active",
        None,
    );
    let rev_vid = fixture.revision(
        &ws_id,
        "f_vid",
        1,
        "bb0000000000000000000000000000000000000000000000000000000000bb",
        2_000_000_000,
        None,
        "unknown",
        None,
        0,
        "2026-06-02T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_vid'",
            rusqlite::params![rev_vid],
        )
        .unwrap();
    let store = open_store(&fixture, &fixture.root());
    let stats = crate::application::storage_stats(&store).expect("storage_stats");
    assert!(stats.ok);
    assert!(stats.gitignore_respected);
    assert_eq!(stats.blobs_count, 1);
    assert_eq!(stats.blobs_bytes, 3 * 1024 * 1024);
    assert!(stats.blobs_disk_bytes > 0);
    assert!(stats.db_bytes > 0);
    assert_eq!(
        stats.total_disk_bytes,
        stats.blobs_disk_bytes + stats.db_bytes
    );
    assert_eq!(stats.active_files_count, 4);
    assert_eq!(stats.revisions_total, 2);
    assert_eq!(stats.full_snapshot_revisions, 1);
    assert_eq!(stats.metadata_only_revisions, 1);
    assert_eq!(stats.policy.text_max_mib, 10);
    assert_eq!(stats.policy.binary_max_mib, 50);
    assert!(stats
        .by_class
        .iter()
        .any(|c| c.format_class == "video" && c.metadata_only_revisions == 1));
    assert_eq!(stats.by_format.get("mp4").copied(), Some(1));
    cleanup_dir(&fixture.dir);
}
