//! 版本链与按版本内容定位的单元测试：A→B→A 三版两份内容、链分页无重复无遗漏、
//! include 三段、阅读器兼容视图与 SNAPSHOT_UNAVAILABLE 口径。

use crate::query::{
    file_detail, file_revisions, revision_content, FileRevisionsQuery, RevisionContentQuery,
    RevisionIncludeSection, RevisionOrder,
};
use crate::storage::ReadonlyStore;
use crate::test_support::{assert_code, cleanup_dir, open_store, FixtureDb};

const H1: &str = "aa0000000000000000000000000000000000000000000000000000000000aaaa";
const H2: &str = "bb0000000000000000000000000000000000000000000000000000000000bbbb";

/// A→B→A 夹具：三个版本行（h1→h2→h1），blobs 两行（h1 ref_count=2），磁盘两份快照。
/// 事件：appeared（r1）、modified（r2）、read_error（路径主体）供 include=events 断言。
fn setup_chain(tag: &str) -> (FixtureDb, String, ReadonlyStore, String, String, String) {
    let fixture = FixtureDb::new(tag);
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);
    fixture.blob(H1, 21, 2);
    fixture.blob(H2, 17, 1);
    fixture.write_blob_file(H1, b"# original A");
    fixture.write_blob_file(H2, b"# modified B");
    let file_id = "f_chain".to_owned();
    fixture.file(&ws_id, &file_id, "docs/链.md", "md", "方案", "active", None);
    let r1 = fixture.revision(
        &ws_id,
        &file_id,
        1,
        H1,
        21,
        Some("2026-01-01"),
        "day",
        Some("document_self"),
        1,
        "2026-01-01T00:00:00.000Z",
    );
    let r2 = fixture.revision(
        &ws_id,
        &file_id,
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
        &file_id,
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
            rusqlite::params![r3, file_id],
        )
        .expect("回填当前版失败");

    fixture.event(
        &ws_id,
        "appeared",
        "revision",
        &r1,
        Some(&r1),
        Some("2026-01-01"),
        "day",
        Some("document_self"),
        "2026-01-01T00:00:00.000Z",
        "新出现",
        "",
        r#"{"path":"docs/链.md","format":"md"}"#,
    );
    fixture.event(
        &ws_id,
        "modified",
        "revision",
        &r2,
        Some(&r2),
        Some("2026-01-02T10:00:00.000Z"),
        "second",
        Some("file_mtime"),
        "2026-01-02T10:00:00.000Z",
        "内容修改",
        "",
        r###"{"path":"docs/链.md","changed_sections":["## 第二节"]}"###,
    );
    fixture.event(
        &ws_id,
        "read_error",
        "file",
        "path:docs/链.md",
        None,
        None,
        "unknown",
        None,
        "2026-01-05T00:00:00.000Z",
        "读取失败",
        "",
        "{}",
    );

    // 陈述与引用边供 include 断言
    fixture.statement(
        &ws_id,
        "st_1",
        &file_id,
        &r2,
        "Q1",
        "项目 / 决策集",
        "问题文本？",
        "待确认",
        "> 待确认原文",
        12,
        14,
        Some("dec_1"),
        r#"{"options":["A"]}"#,
        "2026-01-02T10:00:00.000Z",
    );
    fixture.edge(
        &ws_id,
        "edge_1",
        &file_id,
        &r2,
        "f_target",
        "collected_version",
        Some((3, 4)),
        "见第 3 行链接",
    );
    fixture.edge(
        &ws_id,
        "edge_2",
        &file_id,
        &r2,
        "unresolved:外部",
        "unresolved",
        Some((6, 6)),
        "外部链接",
    );

    let store = open_store(&fixture, &root);
    (fixture, ws_id, store, file_id, r1, r2)
}

/// 版本链 A→B→A（契约 §5.3）：三版两份内容；默认 seq_desc；分页无重复无遗漏
#[test]
fn chain_aba_three_versions_two_contents() {
    let (fixture, _ws, store, file_id, _r1, _r2) = setup_chain("chain-aba");

    let page =
        file_revisions(&store, &file_id, &FileRevisionsQuery::default()).expect("版本链失败");
    assert!(page.ok);
    assert_eq!(page.total, 3);
    // 默认 seq_desc：时间机器自上而下 v3→v2→v1（契约 §1.7）
    let seqs: Vec<i64> = page.revisions.iter().map(|r| r.seq).collect();
    assert_eq!(seqs, [3, 2, 1]);
    // A→B→A：第 1、3 版同哈希；快照不内联下发（project.ts:465）
    assert_eq!(
        page.revisions[0].content_hash,
        page.revisions[2].content_hash
    );
    assert_eq!(page.revisions[1].content_hash, H2);
    assert_eq!(
        page.revisions[0].prev_revision_id.as_deref(),
        Some(format!("{file_id}_r2").as_str())
    );
    assert_eq!(page.revisions[2].prev_revision_id, None);
    assert!(page.revisions.iter().all(|r| r.snapshot_available));

    // seq_asc：升序翻页无重复无遗漏
    let mut cursor = None;
    let mut seen = Vec::new();
    loop {
        let p = file_revisions(
            &store,
            &file_id,
            &FileRevisionsQuery {
                limit: Some(2),
                order: RevisionOrder::SeqAsc,
                cursor: cursor.clone(),
                include: vec![],
            },
        )
        .expect("升序翻页失败");
        for r in &p.revisions {
            seen.push(r.seq);
        }
        if !p.has_more {
            assert!(p.next_cursor.is_none());
            break;
        }
        cursor = p.next_cursor;
    }
    assert_eq!(seen, vec![1, 2, 3], "升序两页拼接 = [1,2,3]");

    // seq_desc 降序翻页（limit 2 → [3,2] + [1]）
    let p1 = file_revisions(
        &store,
        &file_id,
        &FileRevisionsQuery {
            limit: Some(2),
            ..Default::default()
        },
    )
    .expect("降序首页");
    assert_eq!(
        p1.revisions.iter().map(|r| r.seq).collect::<Vec<_>>(),
        [3, 2]
    );
    let p2 = file_revisions(
        &store,
        &file_id,
        &FileRevisionsQuery {
            limit: Some(2),
            cursor: p1.next_cursor.clone(),
            ..Default::default()
        },
    )
    .expect("降序续页");
    assert_eq!(p2.revisions.iter().map(|r| r.seq).collect::<Vec<_>>(), [1]);
    assert!(!p2.has_more);
    cleanup_dir(&fixture.dir);
}

/// include 三段（契约 §1.7）：事件四路覆盖、陈述、引用边；未 include 不下发
#[test]
fn chain_include_sections() {
    let (fixture, _ws, store, file_id, r1, r2) = setup_chain("chain-include");

    let page = file_revisions(
        &store,
        &file_id,
        &FileRevisionsQuery {
            limit: Some(50),
            include: vec![
                RevisionIncludeSection::Events,
                RevisionIncludeSection::Statements,
                RevisionIncludeSection::Edges,
            ],
            ..Default::default()
        },
    )
    .expect("版本链失败");

    // 事件四路覆盖（project.ts:468-485）：subject_id / revision 链 / payload.file_id / path:
    let events = page.events.as_ref().expect("include=events 应下发");
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    assert!(
        kinds.contains(&"appeared"),
        "revision 链事件（subject_id=rev，rev 亦属链）"
    );
    assert!(kinds.contains(&"modified"), "revision 主体事件");
    assert!(
        kinds.contains(&"read_error"),
        "路径主体事件（subject_id='path:'+current_path）"
    );
    assert!(events
        .iter()
        .any(|e| e.revision_id.as_deref() == Some(r1.as_str())));
    assert!(events
        .iter()
        .any(|e| e.revision_id.as_deref() == Some(r2.as_str())));
    // 事件按 seq ASC（project.ts:483）
    let ev_seqs: Vec<i64> = events.iter().map(|e| e.seq).collect();
    let mut sorted = ev_seqs.clone();
    sorted.sort();
    assert_eq!(ev_seqs, sorted);

    // modified 事件 payload 携带 changed_sections（changedSectionsFromPrev 的数据源）
    let modified = events
        .iter()
        .find(|e| e.kind == "modified")
        .expect("modified 事件");
    assert_eq!(
        modified
            .payload
            .get("changed_sections")
            .and_then(|v| v.as_array())
            .map(|a| a.len()),
        Some(1)
    );

    let statements = page.statements.as_ref().expect("include=statements 应下发");
    assert_eq!(statements.len(), 1);
    assert_eq!(statements[0].code, "Q1");
    assert_eq!(statements[0].decision_id.as_deref(), Some("dec_1"));

    let edges = page.edges.as_ref().expect("include=edges 应下发");
    assert_eq!(
        edges.len(),
        2,
        "edges 表查询不过滤 unresolved（project.ts:500-510 原样）"
    );
    let target_edge = edges
        .iter()
        .find(|e| e.edge_id == "edge_1")
        .expect("可落文件边");
    assert_eq!(target_edge.target_file_id, "f_target");
    assert_eq!(target_edge.resolution, "collected_version");
    assert!(edges.iter().any(|e| e.target_file_id == "unresolved:外部"));

    // 未 include 时三段不出现于 JSON（skip_serializing_if）
    let bare = file_revisions(&store, &file_id, &FileRevisionsQuery::default()).expect("裸版本链");
    let json = serde_json::to_value(&bare).expect("序列化");
    assert!(json.get("events").is_none(), "未 include 不应出现 events");
    assert!(json.get("statements").is_none());
    assert!(json.get("edges").is_none());
    assert_code(
        file_revisions(&store, "f_none", &FileRevisionsQuery::default()).map(|_| ()),
        "NOT_FOUND",
    );
    cleanup_dir(&fixture.dir);
}

/// 按版本内容定位（契约 §1.8）：路径供流式读取；A→B→A 的两份相同内容共享同一
/// 快照文件（契约 §3.3-1）；snapshot_available=0 / 磁盘缺失 → SNAPSHOT_UNAVAILABLE
#[test]
fn revision_content_locates_snapshot_path() {
    let (fixture, _ws, store, file_id, r1, _r2) = setup_chain("chain-content");

    // 当前版（r3，h1）
    let r3 = format!("{file_id}_r3");
    let current =
        revision_content(&store, &r3, &RevisionContentQuery::default()).expect("定位当前版");
    assert!(current.ok);
    assert_eq!(current.format, "md");
    assert_eq!(current.revision_id, r3);
    assert!(
        current.text.is_none(),
        "核心不整读正文，服务层按路径流式返回"
    );
    let path3 = current.snapshot_path.expect("当前版应有快照路径");
    assert!(path3.exists());

    // r1 与 r3 同哈希 → 同一快照文件（A→B→A 两份相同内容共享一份盘上快照）
    let first = revision_content(&store, &r1, &RevisionContentQuery::default()).expect("定位 r1");
    assert_eq!(
        first.snapshot_path,
        Some(path3.clone()),
        "同哈希共享同一快照文件"
    );

    // 快照文本可从路径读回（服务层流式读取的口径预演）
    let text = std::fs::read_to_string(&path3).expect("读快照");
    assert_eq!(text, "# original A");

    // PDF：raw_url 指向 v1 自身路径（契约 §1.8）
    cleanup_dir(&fixture.dir);
    let pdf_fixture = FixtureDb::new("chain-pdf");
    let pdf_root = pdf_fixture.root();
    let pdf_ws = pdf_fixture.workspace(&pdf_root, 0, None);
    let pdf_hash = "ff0000000000000000000000000000000000000000000000000000000000ffff";
    pdf_fixture.blob(pdf_hash, 128, 1);
    pdf_fixture.write_blob_file(pdf_hash, b"%PDF-1.7 fake");
    pdf_fixture.file(&pdf_ws, "f_pdf", "手册.pdf", "pdf", "交接", "active", None);
    let pdf_rev = pdf_fixture.revision(
        &pdf_ws,
        "f_pdf",
        1,
        pdf_hash,
        128,
        Some("2026-01-02"),
        "day",
        None,
        1,
        "2026-01-02T00:00:00.000Z",
    );
    pdf_fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = ?2",
            rusqlite::params![pdf_rev, "f_pdf"],
        )
        .expect("回填失败");
    let pdf_store = open_store(&pdf_fixture, &pdf_root);
    let pdf = revision_content(&pdf_store, &pdf_rev, &RevisionContentQuery { raw: false })
        .expect("PDF 定位");
    assert_eq!(pdf.format, "pdf");
    assert_eq!(
        pdf.raw_url.as_deref(),
        Some("/api/v1/revisions/f_pdf_r1/content?raw=1"),
        "raw_url 指向 v1 自身路径（revision_id 为 URL 安全字符，无需转义）"
    );
    // raw=0：服务层只回 JSON 桩，不需要快照路径；raw=1：给出路径供流式返回字节
    assert!(pdf.snapshot_path.is_none(), "PDF JSON 桩不应携带快照路径");
    let pdf_raw = revision_content(&pdf_store, &pdf_rev, &RevisionContentQuery { raw: true })
        .expect("PDF raw 定位");
    assert_eq!(
        pdf_raw.snapshot_path.as_deref(),
        Some(
            pdf_fixture
                .dir
                .join("blobs")
                .join("ff")
                .join(pdf_hash)
                .as_path()
        ),
        "raw=1 时给出快照路径供流式读取"
    );
    cleanup_dir(&pdf_fixture.dir);
}

/// SNAPSHOT_UNAVAILABLE 口径（契约 §0.2/§1.8，现状 REVISION_UNAVAILABLE 改名）：
/// snapshot_available=0 或快照文件缺失 → 410 码
#[test]
fn revision_content_unavailable_cases() {
    let fixture = FixtureDb::new("chain-unavailable");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);
    let file_id = "f_gap";
    fixture.file(&ws_id, file_id, "gap.md", "md", "方案", "active", None);
    // 标记不可用的版本
    let r0 = fixture.revision(
        &ws_id,
        file_id,
        1,
        H1,
        5,
        Some("2026-01-01"),
        "day",
        None,
        0,
        "2026-01-01T00:00:00.000Z",
    );
    // 有元数据但磁盘无快照文件的版本
    let missing_hash = "dd0000000000000000000000000000000000000000000000000000000000dddd";
    let r1 = fixture.revision(
        &ws_id,
        file_id,
        2,
        missing_hash,
        5,
        Some("2026-01-02"),
        "day",
        None,
        1,
        "2026-01-02T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = ?2",
            rusqlite::params![r1, file_id],
        )
        .expect("回填失败");

    let store = open_store(&fixture, &root);
    assert_code(
        revision_content(&store, &r0, &RevisionContentQuery::default()).map(|_| ()),
        "SNAPSHOT_UNAVAILABLE",
    );
    assert_code(
        revision_content(&store, &r1, &RevisionContentQuery::default()).map(|_| ()),
        "SNAPSHOT_UNAVAILABLE",
    );
    assert_code(
        revision_content(&store, "f_gap_r9", &RevisionContentQuery::default()).map(|_| ()),
        "NOT_FOUND",
    );
    cleanup_dir(&fixture.dir);
}

/// 阅读器兼容视图（契约 §1.7 末段）：只返回当前版
/// （camelCase 派生字段、changedSectionsFromPrev 单版本口径、summaryNote），
/// 不展开完整版本链、不内联任何正文；附集合限额保留
#[test]
fn file_detail_reader_view() {
    let (fixture, ws, store, file_id, _r1, _r2) = setup_chain("chain-detail");
    let detail = file_detail(&store, &file_id).expect("详情失败");
    assert!(detail.ok);
    // 只返回当前版（last_revision_id → r3），不读完整版本链
    assert_eq!(detail.revisions.len(), 1);
    assert_eq!(detail.revisions[0].version_number, 3);
    assert_eq!(detail.revisions[0].content_sha256, H1);
    assert!(
        !detail.revisions[0].is_baseline_protected,
        "当前版 r3 非基线"
    );
    assert_eq!(
        detail.revisions[0].source_time.as_deref(),
        Some("2026-01-03T11:00:00.000Z")
    );
    assert!(detail.revisions[0].summary_note.contains("docs/链.md"));
    // changedSectionsFromPrev 单版本口径：modified 事件挂在 r2，当前版 r3 无 → 缺省
    assert!(detail.revisions[0].changed_sections_from_prev.is_none());
    // 不内联任何正文（正文一律经 §1.8 按版本端点单独取）
    assert!(detail.revisions.iter().all(|r| r.svg_source.is_none()));
    assert!(detail
        .revisions
        .iter()
        .all(|r| r.svg_extracted_texts.is_none()));
    // 附集合限额保留（兼容退场策略；本夹具全集 < 200 条不受限）
    assert_eq!(detail.statements.len(), 1);
    assert_eq!(detail.edges.len(), 2);
    let _ = ws;

    // SVG 文件同样不内联（单次响应不随版本数线性增长）
    let hash = "ee0000000000000000000000000000000000000000000000000000000000eeee";
    fixture.blob(hash, 44, 1);
    fixture.write_blob_file(hash, b"<svg><text>A</text><rect/><text>B</text></svg>");
    fixture.file(&ws, "f_svg", "assets/图.svg", "svg", "素材", "active", None);
    let rid = fixture.revision(
        &ws,
        "f_svg",
        1,
        hash,
        44,
        Some("2026-01-02"),
        "day",
        None,
        1,
        "2026-01-02T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = ?2",
            rusqlite::params![rid, "f_svg"],
        )
        .expect("回填失败");
    let svg_detail = file_detail(&store, "f_svg").expect("SVG 详情失败");
    assert_eq!(svg_detail.revisions.len(), 1);
    assert!(svg_detail.revisions[0].svg_source.is_none());
    assert!(svg_detail.revisions[0].svg_extracted_texts.is_none());
    cleanup_dir(&fixture.dir);
}
