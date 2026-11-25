//! 检索查询集成单测（契约 §2.4）。
//!
//! 真实文件 + 真实 `Writer::open_at` + `reconcile`（reconcile 尾部自动同步
//! 派生检索索引）→ `ReadonlyStore` 只读查询。覆盖：
//! 中文双字短语行级核验、专有编号（正文 + 决定陈述双通道）、文件名首字母缩写、
//! 单字有界回退、format/dir 筛选、每文件 3 条上限、非 ready 状态诚实空结果、
//! 损坏一键重建与规则版本自动重建、trashed 移除。

use std::path::PathBuf;

use rusqlite::params;

use crate::index::search_index as si;
use crate::index::{reconcile, ReconcileOptions};
use crate::query::{search, SearchQuery};
use crate::storage::ReadonlyStore;

/// 临时工作区夹具：写文件 → reconcile（含检索索引同步）
struct SearchFixture {
    data_dir: PathBuf,
    root: PathBuf,
}

impl SearchFixture {
    fn setup(files: &[(&str, &str)]) -> Self {
        let seq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!(
            "guanlan-core-c02-search-{}-{seq}",
            std::process::id()
        ));
        let root = base.join("root");
        let data_dir = base.join("data");
        for (rel, content) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().expect("父目录")).expect("建目录失败");
            std::fs::write(&path, content).expect("写文件失败");
        }
        let mut writer = crate::index::writer::Writer::open_at(&data_dir, root.to_str().unwrap())
            .expect("打开可写库失败");
        reconcile(&mut writer, &ReconcileOptions::default()).expect("对账失败");
        drop(writer);
        Self { data_dir, root }
    }

    fn reopen_reconcile(&self) {
        let mut writer =
            crate::index::writer::Writer::open_at(&self.data_dir, self.root.to_str().unwrap())
                .expect("重开可写库失败");
        reconcile(&mut writer, &ReconcileOptions::default()).expect("重对账失败");
        drop(writer);
    }

    /// 直接对底层库执行 SQL（插入决定陈述 / 破坏派生表等）
    fn exec(&self, sql: &str, p: &[&str]) {
        let conn = rusqlite::Connection::open(self.data_dir.join("index.db")).expect("开库失败");
        conn.execute(sql, rusqlite::params_from_iter(params_from(p)))
            .expect("执行 SQL 失败");
    }

    fn store(&self) -> ReadonlyStore {
        let mut store = ReadonlyStore::open_at(&self.data_dir, self.root.to_str().unwrap())
            .expect("只读打开失败");
        store
            .claim_workspace(self.root.to_str().unwrap())
            .expect("认领失败");
        store
    }
}

fn params_from(items: &[&str]) -> Vec<rusqlite::types::Value> {
    items
        .iter()
        .map(|s| rusqlite::types::Value::from((*s).to_owned()))
        .collect()
}

fn do_search(store: &ReadonlyStore, q: &str) -> crate::dto::SearchResponse {
    search(
        store,
        &SearchQuery {
            q: q.to_owned(),
            format: None,
            dir: None,
            limit: None,
        },
    )
    .expect("检索失败")
}

#[test]
fn c02_search_bigram_code_and_abbreviation_end_to_end() {
    let fixture = SearchFixture::setup(&[
        (
            "docs/方案总体/登录方案.md",
            "# 登录方案\n核心结论：登录方案采用统一网关。\n重复行测试登录方案。\n再次重复登录方案。\n第四次出现登录方案。\n验收标准引用 AC-03 编号。\n普通行。\n",
        ),
        (
            "设计/图纸/登录方案-架构.svg",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>登录方案架构总览</text></svg>",
        ),
        (
            "src/auth/user-auth-service.ts",
            "export class UserAuthService {}\n",
        ),
        ("assets/img/logo.png", "\u{89}PNG伪造内容仅为占位"),
    ]);

    let store = fixture.store();

    // ① 中文双字短语：行级核验 + 1-based 行号 + 当前版本号
    let resp = do_search(&store, "登录方案");
    assert!(resp.ok);
    assert_eq!(resp.mode, "phrase");
    assert_eq!(resp.search_state, "ready");
    let md_hits: Vec<_> = resp
        .items
        .iter()
        .filter(|h| h.relative_path.ends_with("登录方案.md"))
        .collect();
    assert!(!md_hits.is_empty(), "应命中 md：{:?}", resp.items);
    let first = md_hits[0];
    assert_eq!(first.match_strategy, "bigram_phrase_verified");
    assert_eq!(first.coverage, "full_text");
    assert!(!first.revision_id.is_empty());
    match &first.locator {
        crate::dto::SearchLocator::Lines { start, end } => {
            assert_eq!(
                *start, 1,
                "首条命中为第 1 行（1-based）：{:?}",
                first.locator
            );
            assert_eq!(*end, 1);
        }
        other => panic!("md 命中应为 Lines 定位：{other:?}"),
    }
    // 每文件命中上限 3（该 md 正文有 4 行含「登录方案」）
    assert!(md_hits.len() <= 3, "每文件上限 3：{}", md_hits.len());

    // ② SVG 文本层命中：svg_text 覆盖与 fragment 定位
    let svg_hits: Vec<_> = resp.items.iter().filter(|h| h.format == "svg").collect();
    assert!(!svg_hits.is_empty(), "svg 应命中：{:?}", resp.items);
    assert_eq!(svg_hits[0].coverage, "svg_text");
    match &svg_hits[0].locator {
        crate::dto::SearchLocator::SvgText { fragment } => {
            assert!(fragment.contains("登录方案"), "fragment={fragment}");
        }
        other => panic!("svg 命中应为 SvgText 定位：{other:?}"),
    }

    // ③ 专有编号：正文核验通道（100% 召回）
    let code_resp = do_search(&store, "AC-03");
    assert_eq!(code_resp.mode, "code");
    let code_hits: Vec<_> = code_resp
        .items
        .iter()
        .filter(|h| h.match_strategy == "exact_code")
        .collect();
    assert!(!code_hits.is_empty(), "编号应命中：{:?}", code_resp.items);
    match &code_hits[0].locator {
        crate::dto::SearchLocator::Lines { start, .. } => assert_eq!(*start, 6),
        other => panic!("编号命中应为行定位：{other:?}"),
    }

    // ④ 文件名首字母缩写（user-auth-service → uas）
    let abbr_resp = do_search(&store, "uas");
    assert!(
        abbr_resp
            .items
            .iter()
            .any(|h| h.relative_path.ends_with("user-auth-service.ts")
                && h.match_strategy == "filename_match"),
        "缩写应命中文件名：{:?}",
        abbr_resp.items
    );

    // ⑤ 单字有界回退
    let single_resp = do_search(&store, "登");
    assert_eq!(single_resp.mode, "single");
    assert!(
        single_resp
            .items
            .iter()
            .any(|h| h.match_strategy == "single_char_bounded"),
        "单字应有界回退命中：{:?}",
        single_resp.items
    );

    // ⑥ format / dir 筛选
    let md_only = search(
        &store,
        &SearchQuery {
            q: "登录方案".to_owned(),
            format: Some("md".to_owned()),
            dir: None,
            limit: None,
        },
    )
    .unwrap();
    assert!(md_only.items.iter().all(|h| h.format == "md"));
    assert!(!md_only.items.is_empty());

    let docs_dir = search(
        &store,
        &SearchQuery {
            q: "登录方案".to_owned(),
            format: None,
            dir: Some("docs".to_owned()),
            limit: None,
        },
    )
    .unwrap();
    assert!(docs_dir
        .items
        .iter()
        .all(|h| h.relative_path.starts_with("docs/")));
    assert!(!docs_dir.items.is_empty());

    let image_class = search(
        &store,
        &SearchQuery {
            q: "登录方案".to_owned(),
            format: Some("class:image".to_owned()),
            dir: None,
            limit: None,
        },
    )
    .unwrap();
    assert!(image_class.items.is_empty(), "图片族不应命中正文短语");
}

#[test]
fn c02_search_decision_code_channel_and_scoring() {
    let fixture = SearchFixture::setup(&[(
        "docs/登录方案.md",
        "# 登录方案\n正文提及 AC-03 但作为普通引用。\n",
    )]);
    // 直接插一条决定陈述（code=AC-03）——决策编号通道置顶
    fixture.exec(
        "INSERT INTO statements (statement_id, workspace_id, file_id, revision_id, code, namespace, \
         question, status, quote, line_start, line_end, decision_id, detail_json, extract_rule_version, observed_at) \
         SELECT 'stmt_c02', workspace_id, file_id, last_revision_id, 'AC-03', '登录', \
         '网关选型是什么？', '待确认', '> [P1] 登录网关统一由 AC-03 承载。', 2, 2, NULL, '{}', 'v0.4.3', '2026-01-01T00:00:00.000Z' \
         FROM files LIMIT 1",
        &[],
    );

    let store = fixture.store();
    let resp = do_search(&store, "AC-03");
    assert_eq!(resp.mode, "code");
    assert!(!resp.items.is_empty());
    // 决定陈述命中分最高，排首位
    let top = &resp.items[0];
    assert_eq!(top.coverage, "decision", "首位应为决定陈述：{:?}", top);
    assert_eq!(top.match_strategy, "exact_code");
    match &top.locator {
        crate::dto::SearchLocator::Lines { start, end } => {
            assert_eq!(*start, 2);
            assert_eq!(*end, 2);
        }
        other => panic!("决定陈述应为行定位：{other:?}"),
    }
    assert!(top.snippet.contains("AC-03"));
    // 正文命中的普通文件也在结果里（决定 + 正文双通道）
    assert!(
        resp.items.iter().any(|h| h.coverage == "full_text"),
        "正文通道也应命中：{:?}",
        resp.items
    );
}

#[test]
fn c02_search_not_ready_returns_honest_empty() {
    let fixture = SearchFixture::setup(&[("a.md", "含有关键词的文档\n")]);
    // 模拟「建索引中」：清空状态标记
    fixture.exec("DELETE FROM meta WHERE key = 'search_state'", &[]);
    let store = fixture.store();
    let resp = do_search(&store, "关键词");
    assert!(resp.items.is_empty());
    assert_eq!(resp.search_state, "absent");
    assert!(resp.ok);

    // 规则版本不符 → 下一轮对账自动重建恢复
    fixture.reopen_reconcile();
    let store = fixture.store();
    let resp = do_search(&store, "关键词");
    assert_eq!(resp.search_state, "ready");
    assert!(!resp.items.is_empty(), "自动重建后应命中");
}

#[test]
fn c02_search_corruption_rebuild_restores_hits() {
    let fixture = SearchFixture::setup(&[("docs/验收清单.md", "验收要点：登录网关必须幂等。\n")]);
    let store = fixture.store();
    assert!(!do_search(&store, "登录网关").items.is_empty());
    drop(store);

    // 模拟损坏：清空词项表（文档行仍在——差分不会发现）
    fixture.exec("DELETE FROM search_postings", &[]);
    let store = fixture.store();
    assert!(
        do_search(&store, "登录网关").items.is_empty(),
        "损坏后诚实为空"
    );
    drop(store);

    // 一键重建（POST /api/v1/search/rebuild 的内核等价入口）
    {
        let mut writer = crate::index::writer::Writer::open_at(
            &fixture.data_dir,
            fixture.root.to_str().unwrap(),
        )
        .expect("重开可写库失败");
        let ws_id = writer.workspace().expect("工作区行").workspace_id;
        let outcome = si::rebuild_all(&mut writer, &ws_id).expect("重建失败");
        assert!(outcome.rebuilt);
        assert!(outcome.docs_synced >= 1);
    }
    let store = fixture.store();
    let resp = do_search(&store, "登录网关");
    assert_eq!(resp.search_state, "ready");
    assert!(!resp.items.is_empty(), "一键重建后应恢复命中：{resp:?}");
}

#[test]
fn c02_search_trashed_file_removed_from_index() {
    let fixture = SearchFixture::setup(&[("docs/废弃方案.md", "废弃方案里的登录设计。\n")]);
    let store = fixture.store();
    assert!(!do_search(&store, "登录设计").items.is_empty());
    drop(store);

    // 移入回收站并移除磁盘文件 → 下一轮对账差分移除检索行
    {
        let conn = rusqlite::Connection::open(fixture.data_dir.join("index.db")).expect("开库失败");
        conn.execute("UPDATE files SET status = 'trashed'", params![])
            .expect("置回收站失败");
        std::fs::remove_file(fixture.root.join("docs/废弃方案.md")).expect("移除磁盘文件失败");
    }
    fixture.reopen_reconcile();
    let store = fixture.store();
    let resp = do_search(&store, "登录设计");
    assert!(
        resp.items.is_empty(),
        "回收站文件不应出现在检索结果：{:?}",
        resp.items
    );
}
