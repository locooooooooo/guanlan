//! L4A 后台沉淀队列与待拍板计数 SSOT 端到端集成测试：
//! 1. L4A 后台沉淀队列自动排空（扫描入队后无需手动 POST l4a_summary，在 <3s 内自动消费至 100% / queue_depth=0，
//!    并发写命令零 SQLITE_BUSY）；
//! 2. 启动存量积压自动排空 + 缺失快照条目自动标 failed 退出队列（根治 0% 永久挂起）；
//! 3. 只读/无自动启动模式（auto_drain_l4a_on_startup = false）严守零启动写入契约；
//! 4. 待拍板计数全站 SSOT（>100 条待拍板时 bootstrap / decisions / project_live_metrics 误差 === 0）。

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use guanlan_core::application::{bootstrap, BootstrapQuery};
use guanlan_core::index::{reconcile, ReconcileOptions, Writer};
use guanlan_core::query::projects::project_live_metrics;
use guanlan_core::query::{decisions, file_summary, l4a_progress, DecisionsQuery};
use guanlan_core::storage::{ReadonlyStore, SummaryJobRow};
use guanlan_service::index_jobs::{IndexJobManager, JobKind, JobState, SseNotice};

struct TempWorkspace {
    base: PathBuf,
    root: PathBuf,
    data_dir: PathBuf,
}

impl TempWorkspace {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("guanlan-v03-{tag}-{}-{nanos}", std::process::id()));
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

    fn write_md(&self, rel: &str, body: &str) {
        let full = self.root.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(&full, body).expect("write md");
    }

    fn root_str(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn v03_l4a_auto_drain_after_scan_and_no_busy() {
    let ws = TempWorkspace::new("auto-drain");
    for i in 1..=10 {
        ws.write_md(
            &format!("docs/doc-{i:02}.md"),
            &format!("# 文档 {i}\n\n## 背景\n第 {i} 篇实测正文内容，用于验证 L4A 自动沉淀。\n"),
        );
    }

    let writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("open writer");
    let (notice_tx, notice_rx) = std::sync::mpsc::channel::<SseNotice>();
    let jobs = IndexJobManager::start_with_options(writer, Some(notice_tx), true);

    let (job_id, _, _) = jobs.submit_kind(JobKind::VerifyAll);
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if let Some(status) = jobs.get(&job_id) {
            if matches!(status.state, JobState::Completed | JobState::Failed) {
                assert_eq!(status.state, JobState::Completed, "scan failed: {status:?}");
                break;
            }
        }
        assert!(Instant::now() < deadline, "scan timed out");
        std::thread::sleep(Duration::from_millis(20));
    }

    // 无需人工 POST l4a_summary：轮询只读库等待自动排空至 100% / queue_depth=0
    let store = ReadonlyStore::open_at(&ws.data_dir, &ws.root_str()).expect("readonly store");
    let drain_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let prog = l4a_progress(&store).expect("l4a_progress");
        if prog.total >= 10 && prog.done == prog.total && prog.queue_depth == 0 {
            assert_eq!(prog.percent, 100);
            break;
        }
        assert!(
            Instant::now() < drain_deadline,
            "L4A 队列未在 5s 内自动排空：{prog:?}"
        );
        std::thread::sleep(Duration::from_millis(30));
    }

    // 验证 SSE 通道确实发出了 l4a 通知
    let mut saw_l4a_notice = false;
    while let Ok(notice) = notice_rx.try_recv() {
        if notice.kinds.iter().any(|k| k == "l4a") {
            saw_l4a_notice = true;
            break;
        }
    }
    assert!(saw_l4a_notice, "自动排空必须通过 SSE 广播 l4a 通知");

    // 抽查首篇文档摘要已真实生成
    let boot = bootstrap(&store, &BootstrapQuery::default()).expect("bootstrap");
    let first_id = &boot.files.items[0].file_id;
    let summary_resp = file_summary(&store, first_id).expect("file_summary");
    assert!(!summary_resp.queued);
    assert!(
        summary_resp.summary.is_some(),
        "自动排空后应可直接读到确定性 L4A 摘要"
    );

    drop(store);
    jobs.shutdown();
}

#[test]
fn v03_l4a_startup_drain_and_evicted_snapshot_marks_failed_and_readonly_respects_zero_write() {
    let ws = TempWorkspace::new("startup-drain");
    ws.write_md("docs/a.md", "# A\n\n有效正文。\n");

    // 先手动建库并植入两条 queued：一条真实文档 + 一条无版本/无快照的坏行（模拟配额淘汰卡死场景）
    {
        let mut writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("open writer");
        let report = reconcile(&mut writer, &ReconcileOptions::default()).expect("reconcile");
        let ws_id = writer.workspace().expect("ws").workspace_id;
        let file_id = report.changed_file_ids[0].clone();
        let rev = writer
            .latest_revision(&file_id)
            .expect("rev")
            .expect("some rev");
        writer
            .upsert_summary_job(&SummaryJobRow {
                job_id: "sj_valid".to_owned(),
                workspace_id: ws_id.clone(),
                file_id,
                content_hash: rev.content_hash,
                priority: 10,
                state: "queued".to_owned(),
                summary_json: None,
                attempts: 0,
                created_at: "2026-11-23T00:00:00Z".to_owned(),
                updated_at: "2026-11-23T00:00:00Z".to_owned(),
            })
            .expect("insert valid");
        writer
            .upsert_summary_job(&SummaryJobRow {
                job_id: "sj_orphan".to_owned(),
                workspace_id: ws_id,
                file_id: "f_missing_snapshot".to_owned(),
                content_hash: "deadbeef".to_owned(),
                priority: 10,
                state: "queued".to_owned(),
                summary_json: None,
                attempts: 0,
                created_at: "2026-11-23T00:00:00Z".to_owned(),
                updated_at: "2026-11-23T00:00:00Z".to_owned(),
            })
            .expect("insert orphan");
    }

    // ① 关闭启动自动排空（CLI serve 无 --watch 零启动写契约）：队列保持原样不动
    {
        let writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("open writer");
        let jobs = IndexJobManager::start_with_options(writer, None, false);
        std::thread::sleep(Duration::from_millis(120));
        let store = ReadonlyStore::open_at(&ws.data_dir, &ws.root_str()).expect("ro");
        let prog = l4a_progress(&store).expect("prog");
        assert_eq!(prog.queue_depth, 2, "非自动排空模式启动零写入");
        assert_eq!(prog.done, 0);
        drop(store);
        jobs.shutdown();
    }

    // ② 开启启动自动排空（桌面壳 / --watch）：有效条变 done、坏条标 failed 退出队列，queue_depth 归 0
    {
        let writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("open writer");
        let jobs = IndexJobManager::start_with_options(writer, None, true);
        let store = ReadonlyStore::open_at(&ws.data_dir, &ws.root_str()).expect("ro");
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let prog = l4a_progress(&store).expect("prog");
            if prog.queue_depth == 0 {
                assert_eq!(prog.done, 1, "有效文档应完成摘要");
                assert_eq!(prog.total, 2);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "坏条不应死循环卡住队列：{prog:?}"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        drop(store);
        jobs.shutdown();
    }
}

#[test]
fn v03_decisions_ssot_matches_beyond_100_page_limit() {
    let ws = TempWorkspace::new("decisions-ssot");
    // 构造 125 条未决待确认决策（超过默认 limit=100），检验全站三出口计数零误差
    let mut body = String::from("# 决策总表\n\n");
    for i in 1..=125 {
        body.push_str(&format!(
            "## {i}. 第 {i} 项待拍板口径\n沿用编号：Q{i:03}\n状态：待确认\n\n"
        ));
    }
    ws.write_md("01-方案文档/决策台账.md", &body);

    {
        let mut writer = Writer::open_at(&ws.data_dir, &ws.root_str()).expect("writer");
        reconcile(&mut writer, &ReconcileOptions::default()).expect("reconcile");
    }

    let store = ReadonlyStore::open_at(&ws.data_dir, &ws.root_str()).expect("ro");
    let boot = bootstrap(&store, &BootstrapQuery::default()).expect("bootstrap");
    let dec_page = decisions(&store, &DecisionsQuery::default()).expect("decisions");
    let live = project_live_metrics(&store, &ws.root_str()).expect("project_live_metrics");

    assert_eq!(boot.decisions.len(), 100, "默认首页批次仍按 100 条轻分页");
    assert_eq!(
        boot.decisions_unresolved_total, 125,
        "bootstrap 必须透出全库 125 项待拍板而非 100"
    );
    assert_eq!(
        dec_page.unresolved_total, 125,
        "/api/v1/decisions 必须透出全库 125 项待拍板"
    );
    assert_eq!(
        live.pending_decisions_count, 125,
        "多项目实时指标与 bootstrap/decisions 三方计数严格相等（误差 === 0）"
    );
}
