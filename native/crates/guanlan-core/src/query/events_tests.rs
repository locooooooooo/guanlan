//! events/days/range 的单元测试：自建临时 SQLite 按契约 DDL 建表插数，
//! 覆盖翻页无重复无遗漏、游标绑定快照、纯日期不做时区换算与日桶聚合语义。

use crate::query::cursor::EventCursor;
use crate::query::{EventDaysQuery, EventGranularity, EventQuery};
use crate::storage::ReadonlyStore;
use crate::test_support::{assert_code, open_store, FixtureDb};

/// 建一个带 N 条事件的工作区：occurred_at/observed_at 单调递增且可预测。
/// i=0..n-1 → 日期从 2026-01-01 起逐日推进；偶数序号带时刻（UTC ISO），
/// 奇数序号为纯日期（覆盖 localDayExpr 的两个分支）。
fn setup_events(tag: &str, n: usize) -> (FixtureDb, String, ReadonlyStore) {
    let fixture = FixtureDb::new(tag);
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);
    for i in 0..n {
        let day = format!("2026-01-{:02}", 1 + i);
        let (occurred, precision) = if i % 2 == 1 {
            (day.clone(), "day")
        } else {
            (format!("{day}T09:30:00.000Z"), "second")
        };
        fixture.event(
            &ws_id,
            "modified",
            "revision",
            &format!("rev_{i:03}"),
            None,
            Some(&occurred),
            precision,
            Some("file_mtime"),
            &format!("{day}T10:00:00.000Z"),
            &format!("事件 {i:03}"),
            "夹具事件",
            "{}",
        );
    }
    let store = open_store(&fixture, &root);
    (fixture, ws_id, store)
}

/// 翻页无重复无遗漏（契约 §0.3-6/§1.4）：57 条 ÷ 每页 20 → 20+20+17
#[test]
fn events_pagination_no_duplicates_no_gaps() {
    let (fixture, _ws, store) = setup_events("events-paging", 57);
    let mut cursor: Option<String> = None;
    let mut seen: Vec<i64> = Vec::new();
    let mut pages = 0usize;
    let mut first_snapshot = -1i64;
    loop {
        let page = crate::query::query_events(
            &store,
            &EventQuery {
                limit: Some(20),
                cursor: cursor.clone(),
                ..Default::default()
            },
        )
        .expect("翻页失败");
        if first_snapshot < 0 {
            first_snapshot = page.snapshot_max_seq;
        }
        assert_eq!(
            page.snapshot_max_seq, first_snapshot,
            "全程沿用同一窗口快照"
        );
        for item in &page.items {
            seen.push(item.seq);
        }
        pages += 1;
        if !page.has_more {
            assert!(
                page.next_cursor.is_none(),
                "末页游标应为 null（queries.ts:246-255）"
            );
            break;
        }
        cursor = page.next_cursor;
        assert!(pages < 10, "翻页不收敛");
    }
    assert_eq!(pages, 3, "57 条每页 20 应恰为 3 页");
    assert_eq!(seen.len(), 57);
    let unique: std::collections::HashSet<i64> = seen.iter().copied().collect();
    assert_eq!(unique.len(), 57, "翻页不得出现重复 seq");
    // 排序键倒序：seq 单调递减（夹具的 occurred 互异，排序键无并列）
    let mut sorted_desc = seen.clone();
    sorted_desc.sort_by(|a, b| b.cmp(a));
    assert_eq!(seen, sorted_desc, "翻页拼接结果应保持排序键倒序");
    let total = crate::query::query_events(
        &store,
        &EventQuery {
            limit: Some(200),
            ..Default::default()
        },
    )
    .expect("计数失败");
    assert_eq!(total.total_in_window, 57, "total_in_window 不含游标条件");
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// 游标绑定快照（契约 §0.3-1/§1.4）：翻页期间新增事件不进入已打开窗口；
/// newer_count 报告新增数；snapshot_max_seq 保持签发值
#[test]
fn events_cursor_binds_snapshot_max_seq() {
    let (fixture, ws_id, store) = setup_events("events-snap", 30);
    let first = crate::query::query_events(
        &store,
        &EventQuery {
            limit: Some(10),
            ..Default::default()
        },
    )
    .expect("首页失败");
    let snap = first.snapshot_max_seq;
    assert_eq!(
        first.newer_count, 0,
        "首屏 newer_count 为 0（queries.ts:310）"
    );

    // 翻页期间写入者提交 3 条新事件（另一连接，模拟并发对账）
    for i in 0..3 {
        fixture.event(
            &ws_id,
            "appeared",
            "revision",
            &format!("late_{i}"),
            None,
            Some("2026-02-01"),
            "day",
            Some("collector"),
            &format!("2026-02-0{}T08:00:00.000Z", 1 + i),
            &format!("迟到事件 {i}"),
            "翻页期间新增",
            "{}",
        );
    }

    let second = crate::query::query_events(
        &store,
        &EventQuery {
            limit: Some(10),
            cursor: first.next_cursor.clone(),
            ..Default::default()
        },
    )
    .expect("续页失败");
    assert_eq!(second.snapshot_max_seq, snap, "续页沿用签发快照");
    for item in &second.items {
        assert!(item.seq <= snap, "新事件不得进入已打开窗口");
    }
    assert_eq!(
        second.newer_count, 3,
        "newer_count = max(0, 当前max − snap)"
    );

    // 同筛选重新首页：进入新窗口，newer_count 归 0
    let fresh = crate::query::query_events(
        &store,
        &EventQuery {
            limit: Some(10),
            ..Default::default()
        },
    )
    .expect("新窗口失败");
    assert!(fresh.snapshot_max_seq > snap);
    assert_eq!(fresh.newer_count, 0);
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// 游标绑定筛选（契约 §0.3-3）与损坏游标 → CURSOR_STALE（v1 拆码，契约 §0.2）
#[test]
fn events_cursor_fingerprint_and_corrupt_rejected() {
    let (fixture, _ws, store) = setup_events("events-fp", 15);
    let first = crate::query::query_events(
        &store,
        &EventQuery {
            limit: Some(5),
            ..Default::default()
        },
    )
    .expect("首页失败");
    // 指纹不符：续页换 kinds
    let mismatch = EventQuery {
        limit: Some(5),
        cursor: first.next_cursor.clone(),
        kinds: vec!["appeared".to_owned()],
        ..Default::default()
    };
    assert_code(
        crate::query::query_events(&store, &mismatch).map(|_| ()),
        "CURSOR_STALE",
    );
    // 损坏游标：非 base64url / base64url 但非 JSON
    for raw in ["!!不是游标!!", "eyJzbmFwIjoxfQ"] {
        let q = EventQuery {
            limit: Some(5),
            cursor: Some(raw.to_owned()),
            ..Default::default()
        };
        assert_code(
            crate::query::query_events(&store, &q).map(|_| ()),
            "CURSOR_STALE",
        );
    }
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// 纯日期不做时区换算（契约 §0.3-7/§5.6）：纯日期窗口归属与桶键与机器时区无关
#[test]
fn pure_dates_bypass_timezone_conversion() {
    // 奇数序号（i=1,3,5,7,9）为纯日期 2026-01-02/04/06/08/10
    let (fixture, _ws, store) = setup_events("events-tz", 10);
    let page = crate::query::query_events(
        &store,
        &EventQuery {
            from: Some("2026-01-06".to_owned()),
            to: Some("2026-01-06".to_owned()),
            ..Default::default()
        },
    )
    .expect("窗口过滤失败");
    assert_eq!(page.items.len(), 1, "纯日期窗口应恰命中当日事件");
    assert_eq!(
        page.items[0].occurred_at.as_deref(),
        Some("2026-01-06"),
        "纯日期不得参与时区换算"
    );

    // 事件日桶：纯日期桶键原样
    let days = crate::query::query_event_days(
        &store,
        &EventDaysQuery {
            granularity: EventGranularity::Day,
            ..Default::default()
        },
    )
    .expect("聚合失败");
    let pure_bucket = days
        .groups
        .iter()
        .find(|g| g.date == "2026-01-06")
        .expect("纯日期桶应存在");
    assert_eq!(pure_bucket.count, 1);
    // 桶键形状全部为 YYYY-MM-DD 或 ""（day 粒度，本夹具无待考）
    for g in &days.groups {
        assert!(
            g.date.is_empty() || (g.date.len() == 10 && g.date.as_bytes().get(4) == Some(&b'-')),
            "day 桶键应为 YYYY-MM-DD：{}",
            g.date
        );
    }
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// events/days 聚合（契约 §1.5）：计数、by_kind、决策取组内 MAX(seq) 状态、
/// 样本优先决策/修改类、「日期待考」恒排最后、hidden_days 折叠计数
#[test]
fn event_days_aggregation() {
    let fixture = FixtureDb::new("days-agg");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);

    // 2026-03-01：1 modified + 2 appeared（seq 1/2/3）
    for i in 0..3 {
        let kind = if i == 0 { "modified" } else { "appeared" };
        fixture.event(
            &ws_id,
            kind,
            "revision",
            &format!("rev_day1_{i}"),
            None,
            Some("2026-03-01"),
            "day",
            Some("collector"),
            "2026-03-02T00:00:00.000Z",
            &format!("{kind} 卡片 {i}"),
            "",
            "{}",
        );
    }
    // 决策事件：同桶先 raised（待确认）后 changed（已确认）→ 决策聚合应取已确认
    fixture.event(
        &ws_id,
        "decision_raised",
        "decision",
        "dec_d1",
        None,
        Some("2026-03-01"),
        "day",
        Some("collector"),
        "2026-03-02T00:00:00.000Z",
        "提出 Q9",
        "",
        r#"{"decision_id":"dec_d1","code":"Q9","status":"待确认","action":"raised"}"#,
    );
    fixture.event(
        &ws_id,
        "decision_changed",
        "decision",
        "dec_d1",
        None,
        Some("2026-03-01"),
        "day",
        Some("collector"),
        "2026-03-02T00:01:00.000Z",
        "确认 Q9",
        "",
        r#"{"decision_id":"dec_d1","code":"Q9","status":"已确认","action":"confirmed"}"#,
    );
    // 日期待考（occurred NULL）
    fixture.event(
        &ws_id,
        "missing",
        "file",
        "f_x",
        None,
        None,
        "unknown",
        None,
        "2026-03-03T00:00:00.000Z",
        "缺失",
        "",
        "{}",
    );
    // 更早一天的桶（会被 limit_days=1 折叠）
    fixture.event(
        &ws_id,
        "appeared",
        "revision",
        "old_1",
        None,
        Some("2026-02-20"),
        "day",
        Some("collector"),
        "2026-03-03T00:00:00.000Z",
        "更早",
        "",
        "{}",
    );

    let store = open_store(&fixture, &root);
    let days =
        crate::query::query_event_days(&store, &EventDaysQuery::default()).expect("聚合失败");

    assert_eq!(days.granularity, "day");
    assert_eq!(
        days.total, 7,
        "总数含待考桶（queries.ts:625）：3+2 决策+1 待考+1 更早"
    );
    // 组序：2026-03-01 → 2026-02-20 → ""（日期待考恒最后）
    assert_eq!(days.groups.len(), 3);
    assert_eq!(days.groups[0].date, "2026-03-01");
    assert_eq!(days.groups[1].date, "2026-02-20");
    assert_eq!(days.groups[2].date, "", "「日期待考」恒排最后");
    assert_eq!(days.undated_count, 1);

    let first = &days.groups[0];
    assert_eq!(first.count, 5);
    assert_eq!(first.by_kind.get("modified"), Some(&1));
    assert_eq!(first.by_kind.get("appeared"), Some(&2));
    assert_eq!(first.by_kind.get("decision_raised"), Some(&1));
    assert_eq!(first.by_kind.get("decision_changed"), Some(&1));
    // 决策聚合取组内 MAX(seq) 的状态：已确认（queries.ts:514-533 的防串状态口径）
    let decision = first
        .decisions
        .iter()
        .find(|d| d.decision_id == "dec_d1")
        .expect("决策样本");
    assert_eq!(decision.status, "已确认");
    assert_eq!(decision.count, 2);
    // 样本优先级：modified/decision 类先于 appeared（queries.ts:559-564）
    assert_eq!(
        first.samples[0].kind, "decision_changed",
        "决策事件优先取样"
    );
    assert!(
        first.samples.iter().any(|s| s.kind == "modified"),
        "modified 应先于 appeared"
    );

    // limit_days=1 折叠：仅留 2026-03-01 与待考，hidden_days=1
    let folded = crate::query::query_event_days(
        &store,
        &EventDaysQuery {
            limit_days: Some(1),
            ..Default::default()
        },
    )
    .expect("折叠聚合失败");
    assert_eq!(folded.hidden_days, 1);
    assert_eq!(folded.groups[0].date, "2026-03-01");
    assert_eq!(folded.groups.last().expect("待考在末尾").date, "");
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// events/days 的周/月桶键形状（契约 §1.5：week=该周周一、month=YYYY-MM）
#[test]
fn event_days_week_month_bucket_shapes() {
    let (fixture, _ws, store) = setup_events("days-shape", 5);
    let week = crate::query::query_event_days(
        &store,
        &EventDaysQuery {
            granularity: EventGranularity::Week,
            ..Default::default()
        },
    )
    .expect("周聚合失败");
    assert_eq!(week.granularity, "week");
    for g in &week.groups {
        assert_eq!(g.date.len(), 10, "周键为 YYYY-MM-DD 形状的周一");
    }
    let month = crate::query::query_event_days(
        &store,
        &EventDaysQuery {
            granularity: EventGranularity::Month,
            ..Default::default()
        },
    )
    .expect("月聚合失败");
    assert_eq!(month.granularity, "month");
    assert_eq!(month.groups.len(), 1, "全部事件同月（2026-01）");
    assert_eq!(month.groups[0].date, "2026-01");
    assert_eq!(month.groups[0].count, 5);
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// events/range（契约 §1.6）：纯日期 min/max 原样；undatedCount 计数
#[test]
fn event_time_range_on_pure_dates() {
    let (fixture, ws_id, store) = setup_events("events-range", 6);
    fixture.event(
        &ws_id,
        "missing",
        "file",
        "f_u",
        None,
        None,
        "unknown",
        None,
        "2026-01-07T00:00:00.000Z",
        "缺失",
        "",
        "{}",
    );
    let range = crate::query::event_time_range(&store).expect("range 失败");
    assert!(range.ok);
    // 纯日期短路：min/max 与机器时区无关（queries.ts:331-334）
    assert_eq!(range.range.occurred_min.as_deref(), Some("2026-01-01"));
    assert_eq!(range.range.occurred_max.as_deref(), Some("2026-01-06"));
    assert_eq!(range.range.undated_count, 1);
    assert_eq!(range.index_generation, 0);
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// 空工作区计数为 0；未认领工作区按 NOT_FOUND 报错（queries.ts:178-183 口径）
#[test]
fn events_on_empty_and_unclaimed_store() {
    let fixture = FixtureDb::new("events-empty");
    let root = fixture.root();
    fixture.workspace(&root, 0, None);
    let store = open_store(&fixture, &root);
    let page =
        crate::query::query_events(&store, &EventQuery::default()).expect("空工作区不应报错");
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.total_in_window, 0);
    assert_eq!(page.snapshot_max_seq, 0);
    assert_eq!(page.next_cursor, None);

    // 未认领工作区的 store → NOT_FOUND
    let bare = crate::storage::ReadonlyStore::open(&fixture.db_path).expect("打开");
    assert_code(
        crate::query::query_events(&bare, &EventQuery::default()).map(|_| ()),
        "NOT_FOUND",
    );
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// Node 侧编码的游标（同字段顺序 JSON + base64url）可被本实现续页（契约 §0.3-2）
#[test]
fn node_encoded_cursor_continues_pagination() {
    let (fixture, _ws, store) = setup_events("events-node-cursor", 12);
    let first = crate::query::query_events(
        &store,
        &EventQuery {
            limit: Some(4),
            ..Default::default()
        },
    )
    .expect("首页失败");
    let last = first.items.last().expect("首页尾行");
    let fp = first
        .next_cursor
        .as_ref()
        .map(|c| crate::query::decode_event_cursor(c).expect("游标可解码").fp)
        .expect("有更多页必有游标");
    // 按 Node queries.ts:100-102 encodeCursor 的语义手工构造（字段顺序 snap,k,s,fp）
    let node_json = format!(
        r#"{{"snap":{},"k":"{}","s":{},"fp":"{}"}}"#,
        first.snapshot_max_seq,
        last.occurred_at.clone().unwrap_or_default(),
        last.seq,
        fp
    );
    let node_cursor = crate::query::cursor::b64url_encode(node_json.as_bytes());
    let second = crate::query::query_events(
        &store,
        &EventQuery {
            limit: Some(4),
            cursor: Some(node_cursor),
            ..Default::default()
        },
    )
    .expect("Node 风格游标续页失败");
    assert!(
        second.items.iter().all(|i| i.seq < last.seq),
        "键集分页从游标之后继续"
    );
    crate::test_support::cleanup_dir(&fixture.dir);
}

/// 事件游标结构形状守护（snap/k/s/fp 与 Node CursorPayload 一致）
#[test]
fn cursor_payload_shape_matches_node() {
    let cursor = EventCursor {
        snap: 1,
        k: "k".to_owned(),
        s: 2,
        fp: "f".to_owned(),
    };
    let encoded = crate::query::encode_event_cursor(&cursor);
    let decoded = crate::query::decode_event_cursor(&encoded).expect("往返");
    assert_eq!(decoded, cursor);
}

// ===== 日桶先限展示范围再富化，桶内决定独立边界 =====

/// 请求少量桶时：返回桶与 hidden_days/total/undated 口径不变；
/// 桶内决定受独立上限约束，并提供总数与截断标记（不再无界嵌套集合）。
#[test]
fn event_days_limits_buckets_before_enrichment() {
    let fixture = FixtureDb::new("days-limit-enrich");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);

    // 6 个有日期桶（2026-04-01..06），每桶 1 条事件
    for day in 1..=6 {
        fixture.event(
            &ws_id,
            "appeared",
            "revision",
            &format!("rev_b{day}"),
            None,
            Some(&format!("2026-04-0{day}")),
            "day",
            Some("collector"),
            &format!("2026-04-0{day}T01:00:00.000Z"),
            &format!("第 {day} 天"),
            "",
            "{}",
        );
    }
    // 最新桶（04-06）里塞 25 个不同决定事件 → 决策样本应被独立上限截断
    for i in 0..25 {
        fixture.event(
            &ws_id,
            "decision_raised",
            "decision",
            &format!("dec_cap_{i}"),
            None,
            Some("2026-04-06"),
            "day",
            Some("collector"),
            &format!("2026-04-06T02:{i:02}:00.000Z"),
            &format!("决定 {i}"),
            "",
            &format!(
                r#"{{"decision_id":"dec_cap_{i}","code":"Q{i}","status":"待确认","action":"raised"}}"#
            ),
        );
    }
    // 日期待考 1 条
    fixture.event(
        &ws_id,
        "missing",
        "file",
        "f_undated",
        None,
        None,
        "unknown",
        None,
        "2026-04-07T00:00:00.000Z",
        "日期待考",
        "",
        "{}",
    );

    let store = open_store(&fixture, &root);
    // limit_days=2、samples=4：只返回最新两个日期桶 + 待考桶
    let result = crate::query::query_event_days(
        &store,
        &crate::query::EventDaysQuery {
            limit_days: Some(2),
            samples: Some(4),
            order: crate::query::EventOrder::Occurred,
            ..Default::default()
        },
    )
    .expect("日桶查询失败");

    // 桶数量：2 个日期桶 + 待考桶
    let dated: Vec<_> = result
        .groups
        .iter()
        .filter(|g| !g.date.is_empty())
        .collect();
    assert_eq!(dated.len(), 2, "limit_days=2 只返回两个日期桶");
    assert_eq!(dated[0].date, "2026-04-06", "桶按日期倒序");
    assert_eq!(dated[1].date, "2026-04-05");
    assert_eq!(result.hidden_days, 4, "其余 4 个日期桶计为 hidden_days");
    assert_eq!(result.undated_count, 1, "待考计数保持");
    assert_eq!(
        result.groups.last().map(|g| g.date.as_str()),
        Some(""),
        "待考桶恒排最后"
    );

    // total 仍是全范围事件数（6 天 + 25 决定 + 1 待考 = 32），包含被折叠的桶
    assert_eq!(result.total, 32, "total 为全量事件数，不因 limit_days 缩小");

    // 桶内决定：独立上限 20，且提供总数与截断标记
    let latest = result
        .groups
        .iter()
        .find(|g| g.date == "2026-04-06")
        .expect("最新桶");
    assert_eq!(latest.decision_total, 25, "桶内决定总数如实上报");
    assert_eq!(latest.decisions.len(), 20, "决定样本受独立上限约束");
    assert!(latest.decisions_truncated, "超过上限应标记截断");

    // 样本仍受 samples 上限约束
    assert!(
        latest.samples.len() <= 4,
        "样本受 samples 上限约束，实际 {}",
        latest.samples.len()
    );

    // 未被截断的桶标记为 false（回归：不能一律 true）
    let day5 = result
        .groups
        .iter()
        .find(|g| g.date == "2026-04-05")
        .expect("04-05 桶");
    assert_eq!(day5.decision_total, 0);
    assert!(!day5.decisions_truncated);

    crate::test_support::cleanup_dir(&fixture.dir);
}

/// 小窗口（limit_days 大于桶数）时：所有桶都返回、hidden_days=0，口径与旧实现一致
#[test]
fn event_days_returns_all_buckets_when_under_limit() {
    let fixture = FixtureDb::new("days-limit-all");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 0, None);
    for day in 1..=3 {
        fixture.event(
            &ws_id,
            "appeared",
            "revision",
            &format!("rev_s{day}"),
            None,
            Some(&format!("2026-05-0{day}")),
            "day",
            Some("collector"),
            &format!("2026-05-0{day}T01:00:00.000Z"),
            "x",
            "",
            "{}",
        );
    }
    let store = open_store(&fixture, &root);
    let result = crate::query::query_event_days(
        &store,
        &crate::query::EventDaysQuery {
            limit_days: Some(10),
            ..Default::default()
        },
    )
    .expect("日桶查询失败");
    assert_eq!(result.groups.len(), 3);
    assert_eq!(result.hidden_days, 0);
    assert_eq!(result.total, 3);
    assert_eq!(result.undated_count, 0);

    // 每桶 by_kind 与 count 保持
    for g in &result.groups {
        assert_eq!(g.count, 1);
        assert_eq!(g.by_kind.get("appeared").copied(), Some(1));
    }
    crate::test_support::cleanup_dir(&fixture.dir);
}
