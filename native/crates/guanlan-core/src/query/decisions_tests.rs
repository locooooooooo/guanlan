//! 决定列表与全量引用边的单元测试：同口径归并主陈述、状态秩排序、
//! 筛选与分页、确认依据、unresolved 过滤与 label 口径（契约 §1.9/§1.10）。

use crate::query::{decisions, relations, DecisionsQuery};
use crate::test_support::{cleanup_dir, open_store, FixtureDb};

const H1: &str = "aa0000000000000000000000000000000000000000000000000000000000aaaa";
const H2: &str = "bb0000000000000000000000000000000000000000000000000000000000bbbb";

fn setup_decisions(tag: &str) -> (FixtureDb, String, crate::storage::ReadonlyStore) {
    let fixture = FixtureDb::new(tag);
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);
    fixture.blob(H1, 5, 1);
    fixture.blob(H2, 7, 1);

    fixture.file(&ws_id, "f_x", "docs/x.md", "md", "方案", "active", None);
    let rx = fixture.revision(
        &ws_id,
        "f_x",
        1,
        H1,
        5,
        Some("2026-01-01"),
        "day",
        None,
        1,
        "2026-01-01T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_x'",
            rusqlite::params![rx],
        )
        .expect("回填失败");
    fixture.file(&ws_id, "f_y", "docs/y.md", "md", "方案", "active", None);
    let ry = fixture.revision(
        &ws_id,
        "f_y",
        1,
        H2,
        7,
        Some("2026-01-03"),
        "day",
        None,
        1,
        "2026-01-03T00:00:00.000Z",
    );
    fixture
        .conn
        .execute(
            "UPDATE files SET last_revision_id = ?1 WHERE file_id = 'f_y'",
            rusqlite::params![ry],
        )
        .expect("回填失败");

    fixture.statement(
        &ws_id,
        "st_old",
        "f_x",
        &rx,
        "Q1",
        "项目 / 决策集",
        "用哪种方案？",
        "待确认",
        "> 用 A 方案",
        10,
        12,
        Some("dec_1"),
        "{}",
        "2026-01-01T00:00:00.000Z",
    );
    fixture.statement(
        &ws_id,
        "st_new",
        "f_y",
        &ry,
        "Q1",
        "项目 / 决策集",
        "用哪种方案？",
        "已确认",
        "> 已确认用 B 方案",
        5,
        5,
        Some("dec_1"),
        r#"{"confirmer":"评审会","impactBlocked":["发布"]}"#,
        "2026-01-03T00:00:00.000Z",
    );
    fixture.statement(
        &ws_id,
        "st_conflict",
        "f_x",
        &rx,
        "Q2",
        "项目 / 决策集",
        "何时发布？",
        "来源不一致",
        "> 两处口径不同",
        20,
        22,
        Some("dec_2"),
        "{}",
        "2026-01-01T00:00:00.000Z",
    );
    fixture.statement(
        &ws_id,
        "st_rejected",
        "f_x",
        &rx,
        "Q3",
        "项目 / 决策集",
        "是否引入依赖？",
        "已否决",
        "> 不引入",
        30,
        30,
        Some("dec_3"),
        "{}",
        "2026-01-01T00:00:00.000Z",
    );

    fixture.edge(
        &ws_id,
        "e1",
        "f_x",
        &rx,
        "f_y",
        "collected_version",
        Some((10, 12)),
        "显式链接",
    );
    fixture.edge(
        &ws_id,
        "e2",
        "f_x",
        &rx,
        "f_z",
        "current_path_only",
        None,
        "仅路径命中",
    );
    fixture.edge(
        &ws_id,
        "e3",
        "f_x",
        &rx,
        "unresolved:外部",
        "unresolved",
        Some((9, 9)),
        "外链",
    );

    let store = open_store(&fixture, &root);
    (fixture, ws_id, store)
}

#[test]
fn decisions_merge_primary_by_revision_observed_at() {
    let (fixture, _ws, store) = setup_decisions("dec-merge");
    let page = decisions(&store, &DecisionsQuery::default()).expect("决定列表失败");
    assert!(page.ok);
    assert_eq!(page.total, 3, "三个业务决定");

    let d1 = page
        .items
        .iter()
        .find(|d| d.decision_id == "dec_1")
        .expect("dec_1");
    assert_eq!(d1.code, "Q1");
    assert_eq!(
        d1.status, "已确认",
        "主陈述取自最新版本（f_y 01-03），不是旧版待确认"
    );
    assert_eq!(d1.evidences.len(), 2, "两条来源证据都在");
    assert_eq!(d1.evidences[0].revision_id, "f_y_r1".to_string());
    assert_eq!(d1.evidences[0].claimed_status, "已确认");
    assert_eq!(d1.evidences[0].source_time.as_deref(), Some("2026-01-03"));
    let basis = d1.confirmation_basis.as_ref().expect("确认依据");
    assert_eq!(basis.confirmer, "评审会");
    assert_eq!(
        basis.confirmed_at, "2026-01-03 00:00",
        "observed_at 前 16 字符并把 T 换空格"
    );
    assert_eq!(basis.line_range, (5, 5));
    assert!(basis.record_text.contains("已确认用 B 方案"));
    assert_eq!(d1.impact_blocked, vec!["发布".to_owned()]);
    assert!(d1
        .evidences
        .iter()
        .all(|e| e.confirmer.as_deref() == Some("评审会")));
    cleanup_dir(&fixture.dir);
}

#[test]
fn decisions_rank_order_pagination_and_binding() {
    let (fixture, ws_id, store) = setup_decisions("dec-rank");
    let page = decisions(&store, &DecisionsQuery::default()).expect("决定列表失败");
    let codes: Vec<&str> = page.items.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(
        codes,
        ["Q2", "Q1", "Q3"],
        "来源不一致→已确认→其他（已否决属其他秩）"
    );

    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let p = decisions(
            &store,
            &DecisionsQuery {
                limit: Some(1),
                cursor: cursor.clone(),
                ..Default::default()
            },
        )
        .expect("分页失败");
        assert_eq!(p.items.len(), 1);
        seen.push(p.items[0].code.clone());
        if !p.has_more {
            assert!(p.next_cursor.is_none());
            break;
        }
        cursor = p.next_cursor;
    }
    assert_eq!(seen, vec!["Q2", "Q1", "Q3"], "分页无重复无遗漏");

    let only = decisions(
        &store,
        &DecisionsQuery {
            status: Some("来源不一致".to_owned()),
            ..Default::default()
        },
    )
    .expect("状态筛选失败");
    assert_eq!(only.total, 1);
    assert_eq!(only.items[0].code, "Q2");
    let by_code = decisions(
        &store,
        &DecisionsQuery {
            code: Some("Q3".to_owned()),
            ..Default::default()
        },
    )
    .expect("编号筛选失败");
    assert_eq!(by_code.total, 1);
    let by_q = decisions(
        &store,
        &DecisionsQuery {
            q: Some("发布".to_owned()),
            ..Default::default()
        },
    )
    .expect("关键字筛选失败");
    assert_eq!(by_q.total, 1, "何时发布？命中 Q2");

    let first = decisions(
        &store,
        &DecisionsQuery {
            limit: Some(1),
            ..Default::default()
        },
    )
    .expect("首页");
    assert!(first.has_more);
    fixture
        .conn
        .execute(
            "UPDATE workspaces SET index_generation = index_generation + 1 WHERE workspace_id = ?1",
            rusqlite::params![ws_id],
        )
        .expect("bump 失败");
    let err = decisions(
        &store,
        &DecisionsQuery {
            limit: Some(1),
            cursor: first.next_cursor.clone(),
            ..Default::default()
        },
    )
    .expect_err("应报代际过期");
    assert_eq!(err.code(), "CURSOR_STALE");
    cleanup_dir(&fixture.dir);
}

#[test]
fn relations_filters_unresolved_and_labels() {
    let (fixture, _ws, store) = setup_decisions("dec-relations");
    let page = relations(&store).expect("关系失败");
    assert!(page.ok);
    assert_eq!(
        page.items.len(),
        2,
        "unresolved: 前缀目标被过滤（project.ts:250）"
    );
    let e1 = page
        .items
        .iter()
        .find(|e| e.edge_id == "e1")
        .expect("收录版本边");
    assert_eq!(e1.edge_type, "explicit_reference");
    assert!(!e1.is_inferred);
    assert_eq!(
        e1.label, "显式引用（收录版本）",
        "collected_version 的 label 口径"
    );
    assert_eq!(
        e1.locator.as_ref().map(|l| (l.start_line, l.end_line)),
        Some((10, 12))
    );
    let e2 = page
        .items
        .iter()
        .find(|e| e.edge_id == "e2")
        .expect("路径命中边");
    assert_eq!(e2.label, "显式引用");
    assert!(
        e2.locator.is_none(),
        "locator 两端齐备才下发（project.ts:259-262）"
    );
    assert!(page
        .items
        .iter()
        .all(|e| !e.target_id.starts_with("unresolved:")));
    cleanup_dir(&fixture.dir);
}

#[test]
fn decision_summary_projection_matches_primary_selection() {
    let (fixture, _ws, store) = setup_decisions("decisions-projection");

    let all = decisions(
        &store,
        &DecisionsQuery {
            limit: Some(500),
            ..Default::default()
        },
    )
    .expect("全量失败");
    let dec1 = all
        .items
        .iter()
        .find(|d| d.decision_id == "dec_1")
        .expect("dec_1");
    assert_eq!(dec1.status, "已确认", "主陈述来自最新版本观察时间");
    assert_eq!(dec1.code, "Q1");
    assert_eq!(
        dec1.evidences.len(),
        2,
        "两条历史陈述都保留为证据（含旧版待确认）"
    );
    let old_ev = dec1
        .evidences
        .iter()
        .find(|e| e.source_id == "st_old")
        .expect("历史证据不丢");
    assert_eq!(old_ev.claimed_status, "待确认", "历史陈述的状态如实保留");
    assert_eq!(old_ev.relative_path, "docs/x.md", "来源路径由 SQL 关联给出");

    let page = decisions(
        &store,
        &DecisionsQuery {
            limit: Some(1),
            ..Default::default()
        },
    )
    .expect("单条分页失败");
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.total, 3, "total 仍为全量摘要数（不受分页影响）");
    assert!(page.has_more);
    let only = &page.items[0];
    assert_eq!(only.decision_id, "dec_2", "状态秩 0（来源不一致）最先");
    assert_eq!(only.evidences.len(), 1, "只构造本页决定的证据");
    assert!(
        only.evidences.iter().all(|e| e.source_id == "st_conflict"),
        "页外决定的陈述不进入本页响应"
    );

    let page2 = decisions(
        &store,
        &DecisionsQuery {
            limit: Some(1),
            cursor: page.next_cursor.clone(),
            ..Default::default()
        },
    )
    .expect("续页失败");
    assert_eq!(page2.items.len(), 1);
    assert_ne!(page2.items[0].decision_id, only.decision_id, "续页不重复");
    assert_eq!(page2.total, 3, "续页 total 一致");
    cleanup_dir(&fixture.dir);
}

#[test]
fn decision_evidence_keeps_missing_files_and_history() {
    let (fixture, ws_id, store) = setup_decisions("decisions-missing");
    fixture.statement(
        &ws_id,
        "st_missing",
        "f_ghost",
        "rev_ghost",
        "Q2",
        "项目 / 决策集",
        "何时发布？",
        "来源不一致",
        "> 已删除文件的陈述",
        1,
        1,
        Some("dec_2"),
        "{}",
        "2026-01-02T00:00:00.000Z",
    );

    let page = decisions(
        &store,
        &DecisionsQuery {
            code: Some("Q2".to_owned()),
            ..Default::default()
        },
    )
    .expect("查询失败");
    let dec2 = &page.items[0];
    assert_eq!(dec2.evidences.len(), 2, "missing 文件的陈述仍作为证据保留");
    let ghost = dec2
        .evidences
        .iter()
        .find(|e| e.source_id == "st_missing")
        .expect("缺行文件证据");
    assert_eq!(
        ghost.relative_path, "",
        "文件行不存在时路径为空串（不伪造路径）"
    );
    assert_eq!(ghost.claimed_status, "来源不一致");
    cleanup_dir(&fixture.dir);
}
