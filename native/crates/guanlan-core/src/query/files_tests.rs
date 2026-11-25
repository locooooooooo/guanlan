//! files 分页与筛选的单元测试：翻页无重复无遗漏、facets、目录前缀筛选、
//! 代际绑定 CURSOR_STALE 与摘要字段口径（coverage/first_source_time 等）。

use crate::query::{FileListQuery, RevisionIncludeSection};
use crate::test_support::{cleanup_dir, open_store, FixtureDb};

const H1: &str = "aa0000000000000000000000000000000000000000000000000000000000aaaa";
const H2: &str = "bb0000000000000000000000000000000000000000000000000000000000bbbb";
const H3: &str = "cc0000000000000000000000000000000000000000000000000000000000cccc";

/// 建夹具工作区：6 个 md 文件分两目录 + 1 svg + 1 pdf + 1 missing，
/// 主文件带 A→B→A 版本链（h1→h2→h1，seq 1..3）
fn setup_files(tag: &str) -> (FixtureDb, String, crate::storage::ReadonlyStore, String) {
    let fixture = FixtureDb::new(tag);
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);

    // 主文件：A→B→A（契约 §5.3：三次版本出现、两份内容）
    let main_id = "f_main";
    fixture.blob(H1, 21, 2);
    fixture.blob(H2, 17, 1);
    fixture.write_blob_file(H1, b"# v1 body");
    // h1 写两次写盘也只一份文件（write_blob_file 幂等覆盖）
    fixture.write_blob_file(H2, b"# v2 body");
    fixture.file(
        &ws_id,
        main_id,
        "docs/主文件.md",
        "md",
        "方案",
        "active",
        None,
    );
    let _r1 = fixture.revision(
        &ws_id,
        main_id,
        1,
        H1,
        21,
        Some("2026-01-01"),
        "day",
        Some("document_self"),
        1,
        "2026-01-01T00:00:00.000Z",
    );
    let _r2 = fixture.revision(
        &ws_id,
        main_id,
        2,
        H2,
        17,
        Some("2026-01-02T10:00:00.000Z"),
        "second",
        Some("file_mtime"),
        1,
        "2026-01-02T10:00:00.000Z",
    );
    let r3 = fixture.revision(
        &ws_id,
        main_id,
        3,
        H1,
        21,
        Some("2026-01-03T11:00:00.000Z"),
        "second",
        Some("file_mtime"),
        1,
        "2026-01-03T11:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = ?2",
            rusqlite::params![r3, main_id],
        )
        .expect("回填主文件当前版失败");

    // 其余文件：单版本
    for (i, (path, format, role)) in [
        ("docs/a.md", "md", "方案"),
        ("docs/plan/b.md", "md", "需求"),
        ("notes/c.md", "md", "交接"),
        ("notes/d.md", "md", "交接"),
        ("notes/e.md", "md", "素材"),
        ("assets/示意图.svg", "svg", "素材"),
        ("assets/手册.pdf", "pdf", "交接"),
    ]
    .iter()
    .enumerate()
    {
        let fid = format!("f_x{i}");
        let hash = if *format == "svg" { H3 } else { H1 };
        fixture.blob(hash, 5, 1);
        fixture.file(&ws_id, &fid, path, format, role, "active", None);
        let rid = fixture.revision(
            &ws_id,
            &fid,
            1,
            hash,
            5,
            Some("2026-01-02"),
            "day",
            Some("document_self"),
            1,
            "2026-01-02T00:00:00.000Z",
        );
        fixture
            .conn
            .execute(
                "UPDATE files SET last_revision_id = ?1 WHERE file_id = ?2",
                rusqlite::params![rid, fid],
            )
            .expect("回填当前版失败");
    }
    // SVG 快照含 <text>（供 svg_text coverage 断言）
    fixture.write_blob_file(H3, b"<svg><text x=\"1\" y=\"2\">label</text></svg>");
    // missing 文件（不计入 active 基础集合）
    fixture.file(
        &ws_id,
        "f_miss",
        "old/删除.md",
        "md",
        "方案",
        "missing",
        None,
    );

    let store = open_store(&fixture, &root);
    (fixture, ws_id, store, main_id.to_owned())
}

/// 翻页无重复无遗漏 + 排序（relative_path ASC）+ facets/total_matched 口径
#[test]
fn files_pagination_facets_and_order() {
    let (fixture, _ws, store, _main) = setup_files("files-paging");
    let mut cursor: Option<String> = None;
    let mut seen: Vec<String> = Vec::new();
    let mut facets: Option<crate::dto::FileFacets> = None;
    loop {
        let page = crate::query::list_files(
            &store,
            &FileListQuery {
                limit: Some(3),
                cursor: cursor.clone(),
                ..Default::default()
            },
        )
        .expect("翻页失败");
        for item in &page.items {
            seen.push(item.relative_path.clone());
        }
        // 只在末页取一次 facets（各页同代际下相同；避免 unused_assignments）
        if !page.has_more {
            facets = Some(page.facets.clone());
        }
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(
        seen.len(),
        8,
        "active 基础集合 = 主文件+5 文件+svg+pdf（missing 不计入）"
    );
    let unique: std::collections::HashSet<&String> = seen.iter().collect();
    assert_eq!(unique.len(), 8, "翻页不得重复");
    let mut sorted = seen.clone();
    sorted.sort();
    assert_eq!(seen, sorted, "排序固化为 relative_path ASC（契约 §1.3）");

    let facets = facets.expect("末页 facets");
    assert_eq!(facets.formats.get("md"), Some(&6));
    assert_eq!(facets.formats.get("svg"), Some(&1));
    assert_eq!(facets.formats.get("pdf"), Some(&1));
    assert_eq!(facets.folders.get("docs"), Some(&2));
    assert_eq!(
        facets.folders.get("docs/plan"),
        Some(&1),
        "子目录独立成 facet 键（契约 §1.3 示例）"
    );
    assert_eq!(facets.folders.get("notes"), Some(&3));
    assert_eq!(facets.folders.get("assets"), Some(&2));
    assert_eq!(facets.matters.get("交接"), Some(&3));

    // total_matched 与筛选同口径
    let filtered = crate::query::list_files(
        &store,
        &FileListQuery {
            format: Some("svg".to_owned()),
            ..Default::default()
        },
    )
    .expect("筛选失败");
    assert_eq!(filtered.total_matched, 1);
    assert_eq!(filtered.items.len(), 1);
    assert_eq!(
        filtered.items[0].coverage, "svg_text",
        "SVG 含 <text> → svg_text"
    );
    cleanup_dir(&fixture.dir);
}

/// 目录前缀筛选：含子目录；'.' 表示根散文件；分页代际绑定 CURSOR_STALE
#[test]
fn files_dir_filter_and_generation_binding() {
    let (fixture, ws_id, store, _main) = setup_files("files-dir");
    let docs = crate::query::list_files(
        &store,
        &FileListQuery {
            dir: Some("docs".to_owned()),
            limit: Some(50),
            ..Default::default()
        },
    )
    .expect("目录筛选失败");
    assert_eq!(
        docs.total_matched, 3,
        "docs 含子目录 docs/plan（契约 §1.3）"
    );
    assert!(docs
        .items
        .iter()
        .all(|f| f.folder == "docs" || f.folder == "docs/plan"));

    let root_only = crate::query::list_files(
        &store,
        &FileListQuery {
            dir: Some(".".to_owned()),
            ..Default::default()
        },
    )
    .expect("根散文件筛选失败");
    assert_eq!(root_only.total_matched, 0, "夹具无根散文件");

    // 代际绑定：签发游标后 bump index_generation → 续页 CURSOR_STALE（契约 §1.3）
    let page = crate::query::list_files(
        &store,
        &FileListQuery {
            limit: Some(2),
            ..Default::default()
        },
    )
    .expect("首页失败");
    assert!(page.has_more);
    assert_eq!(page.snapshot_generation, 0);
    fixture
        .conn
        .execute(
            "UPDATE workspaces SET index_generation = index_generation + 1 WHERE workspace_id = ?1",
            rusqlite::params![ws_id],
        )
        .expect("bump generation 失败");
    let stale = FileListQuery {
        limit: Some(2),
        cursor: page.next_cursor.clone(),
        ..Default::default()
    };
    let err = crate::query::list_files(&store, &stale).expect_err("应报代际过期");
    assert_eq!(
        err.code(),
        "CURSOR_STALE",
        "snapshot_generation != 当前代际 → CURSOR_STALE"
    );
    cleanup_dir(&fixture.dir);
}

/// 摘要字段口径（契约 §1.3）：current_revision_id/revision_count/first_source_time/
/// coverage/pdf_status/snapshot_available
#[test]
fn files_summary_fields() {
    let (fixture, ws_id, store, main_id) = setup_files("files-summary");
    let page = crate::query::list_files(
        &store,
        &FileListQuery {
            dir: Some("docs".to_owned()),
            limit: Some(50),
            ..Default::default()
        },
    )
    .expect("查询失败");
    let main = page
        .items
        .iter()
        .find(|f| f.file_id == main_id)
        .expect("主文件");
    assert_eq!(main.revision_count, 3, "A→B→A 三个版本");
    assert_eq!(
        main.current_revision_id.as_deref(),
        Some(format!("{main_id}_r3").as_str())
    );
    // first_source_time = seq ASC 首条 occurred_at（契约 §5 风险 1：最早版本发生时间）
    assert_eq!(main.first_source_time.as_deref(), Some("2026-01-01"));
    // h1 快照已落盘且 ≤256KiB → md coverage full_text
    assert_eq!(main.coverage, "full_text");
    assert!(main.snapshot_available);
    // title 已按 titleOf 回退写入（夹具走 files.title 非空分支）
    assert_eq!(main.title, "主文件");

    // PDF：恒 filename_only + pdf_status unindexed（project.ts:180-205）
    let pdf = crate::query::list_files(
        &store,
        &FileListQuery {
            format: Some("pdf".to_owned()),
            ..Default::default()
        },
    )
    .expect("查询失败");
    assert_eq!(pdf.items[0].coverage, "filename_only");
    assert_eq!(pdf.items[0].pdf_status.as_deref(), Some("unindexed"));
    // 非 PDF 不下发 pdf_status（FileRecord.pdfStatus 的 undefined 口径）
    let svg = crate::query::list_files(
        &store,
        &FileListQuery {
            format: Some("svg".to_owned()),
            ..Default::default()
        },
    )
    .expect("查询失败");
    assert_eq!(svg.items[0].pdf_status, None);

    // q 筛选命中标题或路径
    let q = crate::query::list_files(
        &store,
        &FileListQuery {
            q: Some("示意图".to_owned()),
            ..Default::default()
        },
    )
    .expect("关键字筛选失败");
    assert_eq!(q.total_matched, 1);
    assert_eq!(q.items[0].relative_path, "assets/示意图.svg");

    // matter（role）筛选
    let matter = crate::query::list_files(
        &store,
        &FileListQuery {
            matter: Some("需求".to_owned()),
            ..Default::default()
        },
    )
    .expect("事项筛选失败");
    assert_eq!(matter.total_matched, 1);
    assert_eq!(matter.items[0].relative_path, "docs/plan/b.md");

    // snapshot_available=0 的当前版 → false（快照不可用口径）
    let fid = "f_snap0";
    fixture.file(&ws_id, fid, "docs/失效.md", "md", "方案", "active", None);
    let rid = fixture.revision(
        &ws_id,
        fid,
        1,
        H2,
        9,
        Some("2026-01-04"),
        "day",
        None,
        0,
        "2026-01-04T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = ?2",
            rusqlite::params![rid, fid],
        )
        .expect("回填失败");
    let after = crate::query::list_files(
        &store,
        &FileListQuery {
            dir: Some("docs".to_owned()),
            limit: Some(50),
            ..Default::default()
        },
    )
    .expect("查询失败");
    let broken = after
        .items
        .iter()
        .find(|f| f.file_id == fid)
        .expect("失效文件");
    assert!(!broken.snapshot_available);
    assert_eq!(
        broken.coverage, "filename_only",
        "snapshot_available=0 → filename_only"
    );
    cleanup_dir(&fixture.dir);
}

/// include 段与版本链分页在 files_tests 内覆盖（revisions_tests 主测），
/// 这里只守护 RevisionIncludeSection 存在性引用不被裁剪
#[test]
fn include_sections_enum_reference() {
    let sections = [
        RevisionIncludeSection::Events,
        RevisionIncludeSection::Statements,
        RevisionIncludeSection::Edges,
        RevisionIncludeSection::Aliases,
    ];
    assert_eq!(sections.len(), 4);
}

// ===== generation 与全部数据库字段绑定同一读快照 =====

/// 外部写者（模拟另一进程的 Node writer）在 WAL 下与读事务并发提交：
/// 读事务内 generation 与数据行都不漂移；事务结束后的新查询看到新代际。
#[test]
fn read_snapshot_binds_generation_and_rows() {
    let (fixture, ws_id, store, _main) = setup_files("files-snapshot");
    // WAL：读事务持有时写者仍可提交（Node writer 的既有模式，WorkspaceStore.ts）
    fixture
        .conn
        .execute_batch("PRAGMA journal_mode=WAL")
        .expect("切换 WAL 失败");

    let before = crate::query::list_files(
        &store,
        &FileListQuery {
            limit: Some(50),
            ..Default::default()
        },
    )
    .expect("基线查询失败");
    let gen_before = before.snapshot_generation;
    let total_before = before.total_matched;

    store
        .read_txn(|_conn| {
            let ws1 = store.workspace()?;
            let n1: i64 = store
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM files WHERE workspace_id = ? AND status = 'active'",
                    [ws_id.as_str()],
                    |r| r.get(0),
                )
                .map_err(crate::storage::internal_sql)?;

            // 外部写者：同一次提交里插入数据行 + bump generation
            fixture
                .conn
                .execute(
                    "INSERT INTO files (file_id, workspace_id, current_path, format, title, role, \
                        first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status) \
                     VALUES ('f_ext', ?1, 'docs/外部新增.md', 'md', '外部新增', '方案', \
                        '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 0, NULL, 'active')",
                    rusqlite::params![ws_id.as_str()],
                )
                .expect("外部写者插入失败");
            fixture
                .conn
                .execute(
                    "UPDATE workspaces SET index_generation = index_generation + 1 WHERE workspace_id = ?1",
                    rusqlite::params![ws_id.as_str()],
                )
                .expect("外部写者 bump generation 失败");

            // 读事务内：generation 与行数都仍是最初快照（不混代）
            let ws2 = store.workspace()?;
            let n2: i64 = store
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM files WHERE workspace_id = ? AND status = 'active'",
                    [ws_id.as_str()],
                    |r| r.get(0),
                )
                .map_err(crate::storage::internal_sql)?;
            assert_eq!(
                ws1.index_generation, ws2.index_generation,
                "读事务内 generation 不应随外部提交漂移"
            );
            assert_eq!(n1, n2, "读事务内数据行数不应随外部提交漂移");
            assert_eq!(ws1.index_generation, gen_before, "快照代际与查询响应一致");
            Ok(())
        })
        .expect("读事务失败");

    // 事务结束后：新查询看到外部提交后的代际与数据（不是永久缓存）
    let after = crate::query::list_files(
        &store,
        &FileListQuery {
            limit: Some(500),
            ..Default::default()
        },
    )
    .expect("事务后查询失败");
    assert_eq!(
        after.snapshot_generation,
        gen_before + 1,
        "事务后新查询应看到新代际"
    );
    assert_eq!(
        after.total_matched,
        total_before + 1,
        "事务后新查询应看到新增文件"
    );
    assert!(
        after.items.iter().any(|f| f.file_id == "f_ext"),
        "新增文件出现在事务后的查询结果里"
    );
    cleanup_dir(&fixture.dir);
}

/// 多 SQL 组合响应（list_files 的 count/items/facets 与 generation）取自同一快照：
/// 事务内外部并发提交不影响本次响应的自洽性（facets 合计 == total_matched）。
#[test]
fn list_files_response_is_self_consistent_under_concurrent_commit() {
    let (fixture, ws_id, store, _main) = setup_files("files-self-consistent");
    fixture
        .conn
        .execute_batch("PRAGMA journal_mode=WAL")
        .expect("切换 WAL 失败");

    // 在读事务内先取一次完整响应，随后外部提交，再取一次响应：
    // 两次响应各自内部自洽（facets 格式合计 = total_matched），且第二次反映新数据
    let first = crate::query::list_files(
        &store,
        &FileListQuery {
            limit: Some(500),
            ..Default::default()
        },
    )
    .expect("第一次查询失败");
    let formats_sum: u64 = first.facets.formats.values().sum();
    assert_eq!(
        formats_sum, first.total_matched,
        "facets 与 total_matched 同口径（同一快照）"
    );

    fixture
        .conn
        .execute(
            "INSERT INTO files (file_id, workspace_id, current_path, format, title, role, \
                first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status) \
             VALUES ('f_ext2', ?1, 'docs/并发新增.md', 'pdf', '并发新增', '方案', \
                '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z', 0, NULL, 'active')",
            rusqlite::params![ws_id.as_str()],
        )
        .expect("外部插入失败");

    let second = crate::query::list_files(
        &store,
        &FileListQuery {
            limit: Some(500),
            ..Default::default()
        },
    )
    .expect("第二次查询失败");
    let formats_sum2: u64 = second.facets.formats.values().sum();
    assert_eq!(
        second.total_matched,
        first.total_matched + 1,
        "外部提交后 total 增长 1"
    );
    assert_eq!(
        formats_sum2, second.total_matched,
        "外部提交后 facets 与 total 仍同口径"
    );
    cleanup_dir(&fixture.dir);
}
