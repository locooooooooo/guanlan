//! 长任务引擎与上下文基座端点的 http 集成测试（contract-query-api.md §2.2）。
//!
//! 与 http_tests.rs 的区别：本模块用**真实写线程**（IndexJobManager::start +
//! Writer::open_at 同一夹具库），覆盖 202 → 轮询 → 终态的全链路（回写 CAS 两
//! 分支、checkpoint 同步 201/404、archive/reopen、diff、context、SSE hello）。
//! 夹具库含 schema v2 全部新表（contract-storage.md §4.3）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use rusqlite::Connection;
use tower::ServiceExt;

use super::{build_router, AppState};
use guanlan_core::storage::ReadonlyStore;

const DDL: &str = include_str!("longtask_fixture.ddl.sql");

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    dir: PathBuf,
    db_path: PathBuf,
    conn: Connection,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "guanlan-lt-{tag}-{}-{seq}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let db_path = dir.join("index.db");
        let conn = Connection::open(&db_path).expect("打开夹具库失败");
        conn.execute_batch(DDL).expect("按 DDL 建表失败");
        conn.execute_batch("PRAGMA user_version = 2;")
            .expect("登记夹具 schema 版本失败");
        Self { dir, db_path, conn }
    }

    fn root(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }

    fn workspace(&self, root: &str) -> String {
        let resolved = guanlan_core::domain::resolve_root_with(root, "H:\\");
        let root_key = guanlan_core::domain::root_key_of_resolved(&resolved);
        let ws_id = guanlan_core::domain::workspace_id_of(&root_key);
        self.conn
            .execute(
                "INSERT INTO workspaces (workspace_id, root_path, root_key, created_at, last_scan_at, index_generation) \
                 VALUES (?1, ?2, ?3, '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 7)",
                rusqlite::params![ws_id, resolved, root_key],
            )
            .expect("插入工作区行失败");
        ws_id
    }

    #[allow(clippy::too_many_arguments)]
    fn file(&self, ws_id: &str, file_id: &str, path: &str, revision_id: Option<&str>) {
        self.conn
            .execute(
                "INSERT INTO files (file_id, workspace_id, current_path, format, title, role, \
                    first_observed_at, last_observed_at, last_mtime_ms, last_revision_id, status) \
                 VALUES (?1, ?2, ?3, 'md', ?4, '决策', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 0, ?5, 'active')",
                rusqlite::params![file_id, ws_id, path, path.trim_end_matches(".md"), revision_id],
            )
            .expect("插入文件行失败");
    }

    fn revision(&self, ws_id: &str, file_id: &str, seq: i64, content_hash: &str) -> String {
        let revision_id = guanlan_core::domain::revision_id_of(file_id, seq);
        self.conn
            .execute(
                "INSERT INTO revisions (revision_id, file_id, workspace_id, seq, prev_revision_id, \
                    content_hash, size_bytes, observed_at, occurred_at, occurred_precision, \
                    occurred_source, snapshot_hash, snapshot_available, extract_rule_version) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 100, '2026-06-01T00:00:00.000Z', '2026-01-02', 'day', 'document_self', ?6, 1, 'v0.4.3')",
                rusqlite::params![
                    revision_id,
                    file_id,
                    ws_id,
                    seq,
                    if seq > 1 { Some(guanlan_core::domain::revision_id_of(file_id, seq - 1)) } else { None },
                    content_hash
                ],
            )
            .expect("插入版本行失败");
        revision_id
    }

    #[allow(clippy::too_many_arguments)]
    fn statement(
        &self,
        ws_id: &str,
        statement_id: &str,
        file_id: &str,
        revision_id: &str,
        code: &str,
        question: &str,
        status: &str,
        line_start: i64,
        line_end: i64,
        detail_json: &str,
    ) {
        let decision_id = format!(
            "dec_{}",
            guanlan_core::index::ident::stable_key(&format!("ns::{question}"))
        );
        self.conn
            .execute(
                "INSERT INTO statements (statement_id, workspace_id, file_id, revision_id, code, \
                    namespace, question, status, quote, line_start, line_end, decision_id, \
                    detail_json, extract_rule_version, observed_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, '01-演示专项 / 待确认', ?6, ?7, '> 原文', ?8, ?9, ?10, ?11, 'v0.4.3', '2026-06-01T00:00:00.000Z')",
                rusqlite::params![
                    statement_id,
                    ws_id,
                    file_id,
                    revision_id,
                    code,
                    question,
                    status,
                    line_start,
                    line_end,
                    decision_id,
                    detail_json
                ],
            )
            .expect("插入陈述行失败");
    }

    fn initiative(&self, ws_id: &str, dir_name: &str, state: &str) -> String {
        self.initiative_with_stage(ws_id, dir_name, "决策", state)
    }

    fn initiative_with_stage(
        &self,
        ws_id: &str,
        dir_name: &str,
        current_stage: &str,
        state: &str,
    ) -> String {
        let initiative_id = format!("init_{}", guanlan_core::index::ident::stable_key(dir_name));
        self.conn
            .execute(
                "INSERT INTO initiatives (initiative_id, workspace_id, name, root_dir, current_stage, \
                    state, artifact_count, pending_p0, pending_p1, pending_p2, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?3, ?4, ?5, 1, 0, 0, 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')",
                rusqlite::params![initiative_id, ws_id, dir_name, current_stage, state],
            )
            .expect("插入专项行失败");
        initiative_id
    }

    fn artifact_state(
        &self,
        file_id: &str,
        ws_id: &str,
        initiative_id: &str,
        stage: &str,
        state: &str,
    ) {
        self.conn
            .execute(
                "INSERT INTO artifact_states (file_id, workspace_id, initiative_id, stage, state, \
                    selected_revision_id, checklist_done, checklist_total, pending_p0, pending_p1, \
                    pending_p2, last_activity_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0, 0, 0, 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')",
                rusqlite::params![file_id, ws_id, initiative_id, stage, state],
            )
            .expect("插入文档状态行失败");
    }

    fn task_node(&self, ws_id: &str, initiative_id: &str, node_id: &str, stage: &str, state: &str) {
        self.conn
            .execute(
                "INSERT INTO task_nodes (node_id, workspace_id, initiative_id, stage, title, node_kind, \
                    state, depends_json, payload_json, latest_checkpoint_id, error, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?4, 'await_decision', ?5, '[]', '{}', NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')",
                rusqlite::params![node_id, ws_id, initiative_id, stage, state],
            )
            .expect("插入节点行失败");
    }

    fn write_blob(&self, hash: &str, content: &[u8]) {
        let path = self.dir.join("blobs").join(&hash[..2]).join(hash);
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("建 blobs 目录");
        std::fs::write(path, content).expect("写快照");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn app_with_real_jobs(fixture: &Fixture, root: &str) -> axum::Router {
    let store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库");
    let mut claimed = store;
    claimed.claim_workspace(root).expect("认领工作区");
    let writer = guanlan_core::index::Writer::open_at(&fixture.dir, root).expect("打开写库");
    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(super::ResponseBudget::new(
            64 * 1024 * 1024,
            8 * 1024 * 1024,
        )),
        exec: Arc::new(super::QueryExecutor::with_config(
            vec![claimed],
            test_exec_config(),
        )),
        instance_id: "inst_lt".to_owned(),
        jobs,
        dist: None,
        watcher: None,
        notices: Some(crate::runtime::NoticeHub::new()),
    })
}

async fn get(app: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .expect("请求构建"),
        )
        .await
        .expect("oneshot");
    let status = response.status();
    let body = response.into_body().collect().await.expect("读 body");
    (
        status,
        serde_json::from_slice(&body.to_bytes()).unwrap_or(serde_json::Value::Null),
    )
}

async fn post_json(app: &axum::Router, uri: &str, body: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_owned()))
                .expect("请求构建"),
        )
        .await
        .expect("oneshot");
    let status = response.status();
    let body = response.into_body().collect().await.expect("读 body");
    (
        status,
        serde_json::from_slice(&body.to_bytes()).unwrap_or(serde_json::Value::Null),
    )
}

async fn poll_job(app: &axum::Router, job_id: &str) -> serde_json::Value {
    for _ in 0..50 {
        let (_, json) = get(app, &format!("/api/v1/jobs/{job_id}")).await;
        let state = json["state"].as_str().unwrap_or("");
        if matches!(state, "completed" | "failed" | "cancelled") {
            return json;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    panic!("任务 {job_id} 未在 5s 内到达终态");
}

fn sha256_of(content: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(content.as_bytes()))
}

#[tokio::test]
async fn state_overview_returns_projection() {
    let fixture = Fixture::new("overview");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "pending_review");
    fixture.file(&ws_id, "f_doc", "01-演示专项/03-待确认事项.md", None);
    fixture.artifact_state("f_doc", &ws_id, &initiative_id, "决策", "pending_review");
    let app = app_for_readonly(&fixture, &root);

    let (status, json) = get(&app, "/api/v1/state-overview").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["ok"], true);
    assert_eq!(json["index_generation"], 7);
    assert!(json["generated_at"].is_string());
    assert_eq!(
        json["initiatives"].as_array().expect("initiatives").len(),
        1
    );
    assert_eq!(json["initiatives"][0]["current_stage"], "决策");
    assert_eq!(json["initiatives"][0]["state"], "pending_review");
    assert_eq!(json["artifacts"].as_array().expect("artifacts").len(), 1);
    assert_eq!(json["artifacts"][0]["stage"], "决策");
    assert_eq!(json["artifacts"][0]["file_id"], "f_doc");

    let (_, filtered) = get(
        &app,
        &format!("/api/v1/state-overview?initiative_id={initiative_id}"),
    )
    .await;
    assert_eq!(
        filtered["artifacts"].as_array().expect("artifacts").len(),
        1
    );
}

fn app_for_readonly(fixture: &Fixture, root: &str) -> axum::Router {
    let store = ReadonlyStore::open(&fixture.db_path).expect("打开夹具库");
    let mut claimed = store;
    claimed.claim_workspace(root).expect("认领工作区");
    build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(super::ResponseBudget::new(
            64 * 1024 * 1024,
            8 * 1024 * 1024,
        )),
        exec: Arc::new(super::QueryExecutor::with_config(
            vec![claimed],
            test_exec_config(),
        )),
        instance_id: "inst_lt_ro".to_owned(),
        jobs: crate::index_jobs::IndexJobManager::idle(),
        dist: None,
        watcher: None,
        notices: None,
    })
}

#[tokio::test]
async fn statements_wire_mapping_and_detail_projection() {
    let fixture = Fixture::new("stmts");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let hash = sha256_of("# 决策文档");
    fixture.write_blob(&hash, "# 决策文档".as_bytes());
    let revision_id = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(
        &ws_id,
        "f_d",
        "01-演示专项/03-待确认事项.md",
        Some(&revision_id),
    );
    fixture.statement(
        &ws_id,
        "stmt_p1",
        "f_d",
        &revision_id,
        "P1",
        "属性字典与历史更新策略",
        "待确认",
        7,
        11,
        r#"{"options":["甲","乙"],"recommendation":"先做甲","impactBlocked":["后端"],"impactAllowed":["前端"],"confirmer":"张三","priority":"P1"}"#,
    );
    let app = app_for_readonly(&fixture, &root);

    let (status, json) = get(&app, "/api/v1/statements?file_id=f_d&status=pending").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let items = json["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "pending → 待确认（wire 词映射）");
    assert_eq!(items[0]["status"], "待确认");
    assert_eq!(items[0]["options"].as_array().expect("options").len(), 2);
    assert_eq!(items[0]["recommendation"], "先做甲");
    assert_eq!(
        items[0]["impact_blocked"]
            .as_array()
            .expect("blocked")
            .len(),
        1
    );
    assert_eq!(
        items[0]["impact_allowed"]
            .as_array()
            .expect("allowed")
            .len(),
        1
    );
    assert_eq!(items[0]["confirmer_hint"], "张三");
    assert_eq!(items[0]["line_start"], 7);

    let (_, empty) = get(&app, "/api/v1/statements?file_id=f_d&status=confirmed").await;
    assert_eq!(empty["items"].as_array().expect("items").len(), 0);

    let (status, _) = get(&app, "/api/v1/statements").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn resolve_returns_202_and_writeback_completes_with_new_revision() {
    let fixture = Fixture::new("resolve");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "pending_review");

    let content = "---\nrevision: 1\n---\n\n# 03-待确认事项\n\n[P1 - 待确认] 属性字典与历史更新策略\n决定：___\n确认人：___\n";
    let hash = sha256_of(content);
    fixture.write_blob(&hash, content.as_bytes());
    let revision_id = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(
        &ws_id,
        "f_d",
        "01-演示专项/03-待确认事项.md",
        Some(&revision_id),
    );
    fixture.artifact_state("f_d", &ws_id, &initiative_id, "决策", "pending_review");
    fixture.statement(
        &ws_id,
        "stmt_p1",
        "f_d",
        &revision_id,
        "P1",
        "属性字典与历史更新策略",
        "待确认",
        7,
        10,
        r#"{"priority":"P1"}"#,
    );
    let blueprint_content = "# 需求单

范围与边界
";
    let blueprint_hash = sha256_of(blueprint_content);
    fixture.write_blob(&blueprint_hash, blueprint_content.as_bytes());
    let blueprint_revision = fixture.revision(&ws_id, "f_b", 1, &blueprint_hash);
    fixture.file(
        &ws_id,
        "f_b",
        "01-演示专项/需求单.md",
        Some(&blueprint_revision),
    );
    fixture.artifact_state("f_b", &ws_id, &initiative_id, "蓝图", "completed");
    let plan_content = "# 方案

两阶段状态锁设计
";
    let plan_hash = sha256_of(plan_content);
    fixture.write_blob(&plan_hash, plan_content.as_bytes());
    let plan_revision = fixture.revision(&ws_id, "f_p", 1, &plan_hash);
    fixture.file(&ws_id, "f_p", "01-演示专项/方案.md", Some(&plan_revision));
    fixture.artifact_state("f_p", &ws_id, &initiative_id, "计划", "completed");
    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建专项目录");
    std::fs::write(
        fixture.dir.join("01-演示专项").join("方案.md"),
        plan_content,
    )
    .expect("写计划阶段磁盘文件");
    let decision_node_id = format!(
        "node_{}",
        guanlan_core::index::ident::stable_key(&format!("{initiative_id}|决策|await_decision"))
    );
    fixture.task_node(
        &ws_id,
        &initiative_id,
        &decision_node_id,
        "决策",
        "suspended_on_hitl",
    );
    std::fs::write(
        fixture.dir.join("01-演示专项").join("03-待确认事项.md"),
        content,
    )
    .expect("写磁盘工作区文件");

    let app = app_with_real_jobs(&fixture, &root);
    let (status, json) = post_json(
        &app,
        "/api/v1/decisions/stmt_p1/resolve",
        r#"{"decision":"采用两阶段状态锁","confirmer":"架构组","effective_date":"2026-11-18"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{json}");
    assert_eq!(json["ok"], true);
    assert_eq!(json["statement_id"], "stmt_p1");
    assert!(json["decision_id"]
        .as_str()
        .expect("decision_id")
        .starts_with("dec_"));

    let final_json = poll_job(&app, json["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_json["state"], "completed", "{final_json}");
    let writeback = &final_json["result"]["writeback"];
    assert_eq!(writeback["cas_ok"], true, "{final_json}");
    assert_eq!(writeback["file_changed"], true);
    assert!(writeback["new_revision_id"].is_string());
    assert_eq!(final_json["error"], serde_json::Value::Null, "error 恒空");
    assert_eq!(
        final_json["failed_items"].as_array().expect("恒空").len(),
        0
    );

    let updated = std::fs::read_to_string(fixture.dir.join("01-演示专项").join("03-待确认事项.md"))
        .expect("读回写文件");
    assert!(updated.contains("[P1 - 已确认]"), "{updated}");
    assert!(updated.contains("决定：采用两阶段状态锁"));
    assert!(updated.contains("确认人：架构组"));
    assert!(updated.contains("revision: 2"));

    let (status, events) = get(&app, "/api/v1/events?kinds=task_node_moved&limit=50").await;
    assert_eq!(status, StatusCode::OK);
    let moved = events["items"]
        .as_array()
        .expect("events")
        .iter()
        .any(|event| {
            event["subject_id"]
                .as_str()
                .map(|id| id.contains(":suspended_on_hitl->completed"))
                .unwrap_or(false)
        });
    assert!(
        moved,
        "应存在 suspended_on_hitl→completed 迁移事件：{events}"
    );
}

#[tokio::test]
async fn resolve_cas_conflict_lands_draft_branch() {
    let fixture = Fixture::new("cas");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "pending_review");
    let content = "[P1 - 待确认] 属性字典与历史更新策略\n决定：___\n确认人：___\n";
    let hash = sha256_of(content);
    fixture.write_blob(&hash, content.as_bytes());
    let revision_id = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(
        &ws_id,
        "f_d",
        "01-演示专项/03-待确认事项.md",
        Some(&revision_id),
    );
    fixture.artifact_state("f_d", &ws_id, &initiative_id, "决策", "pending_review");
    fixture.statement(
        &ws_id,
        "stmt_p1",
        "f_d",
        &revision_id,
        "P1",
        "属性字典与历史更新策略",
        "待确认",
        1,
        3,
        r#"{"priority":"P1"}"#,
    );
    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建目录");
    std::fs::write(
        fixture.dir.join("01-演示专项").join("03-待确认事项.md"),
        "[P1 - 待确认] 属性字典\n决定：___\n确认人：___\n外部修改痕迹\n",
    )
    .expect("写磁盘");

    let app = app_with_real_jobs(&fixture, &root);
    let (status, json) = post_json(
        &app,
        "/api/v1/decisions/stmt_p1/resolve",
        r#"{"decision":"决定A","confirmer":"张三"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{json}");

    let final_json = poll_job(&app, json["job_id"].as_str().expect("job_id")).await;
    assert_eq!(
        final_json["state"], "completed",
        "CAS 失败仍是 completed：{final_json}"
    );
    let writeback = &final_json["result"]["writeback"];
    assert_eq!(writeback["cas_ok"], false);
    assert_eq!(writeback["file_changed"], false);
    assert!(writeback["new_revision_id"].is_null());
    assert!(writeback["cas_conflict"]["expected_content_hash"].is_string());
    assert!(writeback["cas_conflict"]["disk_content_hash"].is_string());
    assert!(writeback["draft_id"].is_string());

    let (_, drafts) = get(&app, "/api/v1/revision-proposals?status=proposed").await;
    assert_eq!(drafts["items"].as_array().expect("items").len(), 1);
    assert_eq!(drafts["items"][0]["conflict"], true);
    let disk = std::fs::read_to_string(fixture.dir.join("01-演示专项").join("03-待确认事项.md"))
        .expect("读磁盘");
    assert!(disk.contains("外部修改痕迹"), "绝不静默覆盖：{disk}");
}

#[tokio::test]
async fn resolve_on_archived_initiative_is_conflict() {
    let fixture = Fixture::new("archived");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "archived");
    let hash = sha256_of("# 内容");
    fixture.write_blob(&hash, "# 内容".as_bytes());
    let revision_id = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(
        &ws_id,
        "f_d",
        "01-演示专项/03-待确认事项.md",
        Some(&revision_id),
    );
    fixture.artifact_state("f_d", &ws_id, &initiative_id, "决策", "archived");
    fixture.statement(
        &ws_id,
        "stmt_p1",
        "f_d",
        &revision_id,
        "P1",
        "问题",
        "待确认",
        1,
        2,
        r#"{"priority":"P1"}"#,
    );
    let app = app_for_readonly(&fixture, &root);
    let (status, json) = post_json(
        &app,
        "/api/v1/decisions/stmt_p1/resolve",
        r#"{"decision":"决定A","confirmer":"张三"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{json}");
    assert_eq!(json["code"], "CONFLICT");
}

#[tokio::test]
async fn checkpoint_commit_is_synchronous_201_and_advances_node() {
    let fixture = Fixture::new("ckpt");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "executing");
    let node_id = format!(
        "node_{}",
        guanlan_core::index::ident::stable_key(&format!("{initiative_id}|执行|generate"))
    );
    fixture.task_node(&ws_id, &initiative_id, &node_id, "执行", "running");
    let app = app_with_real_jobs(&fixture, &root);

    let real_initiative = fixture
        .conn
        .query_row("SELECT initiative_id FROM initiatives LIMIT 1", [], |row| {
            row.get::<_, String>(0)
        })
        .expect("initiative");
    let (status, json) = post_json(
        &app,
        "/api/v1/checkpoints",
        &format!(
            r#"{{"initiative_id":"{real_initiative}","stage":"执行","status":"SUCCESS","input_context_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","token_usage":1024,"elapsed_ms":5000}}"#
        ),
    )
    .await;
    let _ = initiative_id;
    assert_eq!(status, StatusCode::CREATED, "{json}");
    assert_eq!(json["ok"], true);
    assert!(json["checkpoint_id"]
        .as_str()
        .expect("ckpt")
        .starts_with("ckpt_"));
    assert_eq!(json["node_state"], "completed", "{json}");

    let (_, list) = get(
        &app,
        &format!("/api/v1/checkpoints?initiative_id={real_initiative}&status=SUCCESS"),
    )
    .await;
    assert_eq!(list["items"].as_array().expect("items").len(), 1);

    let (_, tasks) = get(
        &app,
        &format!("/api/v1/initiatives/{real_initiative}/tasks"),
    )
    .await;
    let nodes = tasks["nodes"].as_array().expect("nodes");
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0]["state"], "completed");
    assert_eq!(nodes[0]["node_kind"], "await_decision", "夹具行原样透传");
    assert!(nodes[0]["depends"].is_array());

    let (status, json) = post_json(
        &app,
        "/api/v1/checkpoints",
        r#"{"initiative_id":"init_不存在","stage":"执行","status":"SUCCESS","input_context_hash":"bbbb"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{json}");
    assert_eq!(json["code"], "NOT_FOUND");
}

#[tokio::test]
async fn revision_proposals_full_chain() {
    let fixture = Fixture::new("drafts");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "approved_revision");
    let content = "# 方案 v1\n\n正文\n";
    let hash = sha256_of(content);
    fixture.write_blob(&hash, content.as_bytes());
    let base_revision = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(&ws_id, "f_d", "01-演示专项/方案.md", Some(&base_revision));
    fixture.artifact_state("f_d", &ws_id, &initiative_id, "计划", "approved_revision");
    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建目录");
    std::fs::write(fixture.dir.join("01-演示专项").join("方案.md"), content)
        .expect("写磁盘（与基准一致 → conflict=false 预览）");

    let app = app_with_real_jobs(&fixture, &root);
    let (status, json) = post_json(
        &app,
        "/api/v1/revision-proposals",
        &format!(
            r##"{{"file_id":"f_d","base_revision_id":"{base_revision}","content":"# 方案 v2\n\nAgent 改写\n","note":"v2"}}"##
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{json}");
    assert_eq!(json["conflict"], false, "磁盘与基准一致 → 无冲突预览");
    let draft_id = json["draft_id"].as_str().expect("draft_id").to_owned();

    let final_json = poll_job(&app, json["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_json["state"], "completed", "{final_json}");
    assert_eq!(final_json["result"]["proposal"]["cas_ok"], true);
    assert_eq!(final_json["result"]["proposal"]["status"], "proposed");

    let (_, list) = get(&app, "/api/v1/revision-proposals?status=proposed").await;
    assert_eq!(list["items"].as_array().expect("items").len(), 1);
    assert_eq!(list["items"][0]["source"], "agent");
    assert_eq!(list["items"][0]["path"], "01-演示专项/方案.md");

    let (status, adopt) = post_json(
        &app,
        &format!("/api/v1/revision-proposals/{draft_id}/adopt"),
        "{}",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let adopt_final = poll_job(&app, adopt["job_id"].as_str().expect("job_id")).await;
    assert_eq!(adopt_final["state"], "completed", "{adopt_final}");
    assert_eq!(adopt_final["result"]["adopt"]["cas_ok"], true);
    assert!(adopt_final["result"]["adopt"]["new_revision_id"].is_string());

    let disk =
        std::fs::read_to_string(fixture.dir.join("01-演示专项").join("方案.md")).expect("读磁盘");
    assert!(disk.contains("Agent 改写"), "{disk}");

    let (_status, create2) = post_json(
        &app,
        "/api/v1/revision-proposals",
        &format!(
            r##"{{"file_id":"f_d","base_revision_id":"{base_revision}","content":"# 方案 v3\n"}}"##
        ),
    )
    .await;
    let _ = status;
    let (_, dismiss) = post_json(
        &app,
        &format!(
            "/api/v1/revision-proposals/{}/dismiss",
            create2["draft_id"].as_str().expect("d2")
        ),
        "{}",
    )
    .await;
    let dismiss_final = poll_job(&app, dismiss["job_id"].as_str().expect("job_id")).await;
    assert_eq!(dismiss_final["state"], "completed");
    assert_eq!(dismiss_final["result"]["dismiss"]["status"], "dismissed");
}

#[tokio::test]
async fn adopt_auto_generates_execution_checkpoint_with_artifact_version() {
    let fixture = Fixture::new("adopt_ckpt");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "executing");
    let content = "# 方案 v1\n\n正文\n";
    let hash = sha256_of(content);
    fixture.write_blob(&hash, content.as_bytes());
    let base_revision = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(&ws_id, "f_d", "01-演示专项/方案.md", Some(&base_revision));
    fixture.artifact_state("f_d", &ws_id, &initiative_id, "计划", "executing");
    let bp_content = "# 需求总览\n";
    let bp_hash = sha256_of(bp_content);
    fixture.write_blob(&bp_hash, bp_content.as_bytes());
    let bp_rev = fixture.revision(&ws_id, "f_bp", 1, &bp_hash);
    fixture.file(&ws_id, "f_bp", "01-演示专项/需求总览.md", Some(&bp_rev));
    fixture.file(&ws_id, "f_dc", "01-演示专项/03-待确认事项.md", None);
    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建目录");
    std::fs::write(fixture.dir.join("01-演示专项").join("方案.md"), content).expect("写磁盘");

    let app = app_with_real_jobs(&fixture, &root);
    let (_, create) = post_json(
        &app,
        "/api/v1/revision-proposals",
        &format!(
            r##"{{"file_id":"f_d","base_revision_id":"{base_revision}","content":"# 方案 v2\n\nAgent 改写\n"}}"##
        ),
    )
    .await;
    let draft_id = create["draft_id"].as_str().expect("draft_id").to_owned();
    let (_, adopt) = post_json(
        &app,
        &format!("/api/v1/revision-proposals/{draft_id}/adopt"),
        "{}",
    )
    .await;
    let adopt_final = poll_job(&app, adopt["job_id"].as_str().expect("job_id")).await;
    assert_eq!(adopt_final["state"], "completed", "{adopt_final}");
    assert_eq!(adopt_final["result"]["adopt"]["cas_ok"], true);
    let new_revision = adopt_final["result"]["adopt"]["new_revision_id"]
        .as_str()
        .expect("落版 id")
        .to_owned();

    let auto_ckpt = &adopt_final["result"]["adopt"]["auto_checkpoint"];
    let checkpoint_id = auto_ckpt["checkpoint_id"]
        .as_str()
        .expect("采纳应自动落 checkpoint：{adopt_final}")
        .to_owned();
    assert!(checkpoint_id.starts_with("ckpt_"), "{auto_ckpt}");
    assert_eq!(auto_ckpt["node_state"], "completed", "{auto_ckpt}");

    let (_, list) = get(
        &app,
        &format!("/api/v1/checkpoints?initiative_id={initiative_id}&status=SUCCESS"),
    )
    .await;
    let items = list["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "采纳自动检查点恰一条：{list}");
    assert_eq!(items[0]["checkpoint_id"], checkpoint_id);
    assert_eq!(items[0]["stage"], "执行");
    assert_eq!(items[0]["output_revision_id"], new_revision);
    assert_eq!(
        items[0]["output_artifact_version"], "v2",
        "版本号由产出修订 seq 派生：{list}"
    );
    assert!(
        items[0]["note"]
            .as_str()
            .unwrap_or_default()
            .contains("自动"),
        "备注自述自动落点：{list}"
    );

    let (_, events) = get(&app, "/api/v1/events?kinds=checkpoint_committed&limit=10").await;
    let committed = events["items"].as_array().expect("events");
    assert_eq!(committed.len(), 1, "{events}");
    assert_eq!(committed[0]["subject_id"], checkpoint_id);
}

#[tokio::test]
async fn archive_then_reopen_initiative() {
    let fixture = Fixture::new("archive");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative(&ws_id, "01-演示专项", "delivered");
    fixture.file(&ws_id, "f_d", "01-演示专项/03-待确认事项.md", None);
    fixture.artifact_state("f_d", &ws_id, &initiative_id, "决策", "delivered");
    let app = app_with_real_jobs(&fixture, &root);

    let (status, json) = post_json(
        &app,
        &format!("/api/v1/initiatives/{initiative_id}/archive"),
        r#"{"note":"验收完成"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{json}");
    let final_json = poll_job(&app, json["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_json["state"], "completed", "{final_json}");
    assert_eq!(final_json["result"]["initiative"]["state"], "archived");
    assert!(
        final_json["result"]["initiative"].get("warn").is_none(),
        "已交付态归档无 warn：{final_json}"
    );

    let (status, reopen) = post_json(
        &app,
        &format!("/api/v1/initiatives/{initiative_id}/reopen"),
        "{}",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let reopen_final = poll_job(&app, reopen["job_id"].as_str().expect("job_id")).await;
    assert_eq!(reopen_final["result"]["initiative"]["state"], "draft");
    let (status, archive2) = post_json(
        &app,
        &format!("/api/v1/initiatives/{initiative_id}/archive"),
        "{}",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let archive2_final = poll_job(&app, archive2["job_id"].as_str().expect("job_id")).await;
    assert_eq!(
        archive2_final["result"]["initiative"]["warn"], "当前非已交付态",
        "重开后为 draft，归档应带 warn：{archive2_final}"
    );

    let (status, events) = get(&app, "/api/v1/events?kinds=initiative_archived&limit=50").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        events["items"].as_array().expect("events").len(),
        2,
        "两次归档各一条：{events}"
    );
}

#[tokio::test]
async fn diff_job_produces_summary_card_and_sections() {
    let fixture = Fixture::new("diff");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let baseline = "# 标题\n- [x] 旧项\n正文基线\n";
    let target = "# 标题\n- [x] 旧项\n- [x] 新交付\n正文目标\n";
    let h_base = sha256_of(baseline);
    let h_target = sha256_of(target);
    fixture.write_blob(&h_base, baseline.as_bytes());
    fixture.write_blob(&h_target, target.as_bytes());
    let r1 = fixture.revision(&ws_id, "f_d", 1, &h_base);
    let r2 = fixture.revision(&ws_id, "f_d", 2, &h_target);
    fixture.file(&ws_id, "f_d", "01-演示专项/交付清单.md", Some(&r2));
    let app = app_with_real_jobs(&fixture, &root);

    let (status, json) = post_json(
        &app,
        "/api/v1/diff",
        &format!(
            r##"{{"file_id":"f_d","baseline_revision_id":"{r1}","target_revision_id":"{r2}"}}"##
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{json}");
    let final_json = poll_job(&app, json["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_json["state"], "completed", "{final_json}");
    let result = &final_json["result"];
    let items = result["summary"]["items"].as_array().expect("items");
    assert_eq!(items.len(), 3, "三项语义指标：{final_json}");
    assert_eq!(items[0]["label"], "新增交付项");
    assert_eq!(items[0]["count"], 1, "checklist 1→2");
    assert_eq!(result["truncated"], false);
    assert!(
        !result["sections"].as_array().expect("sections").is_empty(),
        "至少一个差异区块"
    );

    let (_, result_json) = get(
        &app,
        &format!(
            "/api/v1/jobs/{}/result",
            json["job_id"].as_str().expect("job_id")
        ),
    )
    .await;
    assert_eq!(result_json["ok"], true);
    assert!(result_json["result"]["summary"].is_object());
    assert_eq!(result_json["next_cursor"], serde_json::Value::Null);
}

#[tokio::test]
async fn e02_propose_creates_independent_draft_branch_without_touching_disk_and_exposes_diff_content(
) {
    let fixture = Fixture::new("e02_branch");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);

    let spec_text = "# 架构规范\n所有写盘必须走 CAS 校验。\n";
    let spec_hash = sha256_of(spec_text);
    fixture.write_blob(&spec_hash, spec_text.as_bytes());
    let spec_rev = fixture.revision(&ws_id, "f_spec", 1, &spec_hash);
    fixture.file(
        &ws_id,
        "f_spec",
        "01-演示专项/01-架构规范.md",
        Some(&spec_rev),
    );

    let plan_v1 = "# 实施计划\n- [ ] 初稿步骤\n";
    let plan_v1_hash = sha256_of(plan_v1);
    fixture.write_blob(&plan_v1_hash, plan_v1.as_bytes());
    let plan_rev1 = fixture.revision(&ws_id, "f_plan", 1, &plan_v1_hash);
    fixture.file(
        &ws_id,
        "f_plan",
        "01-演示专项/02-实施计划.md",
        Some(&plan_rev1),
    );

    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建目录");
    std::fs::write(
        fixture.dir.join("01-演示专项").join("01-架构规范.md"),
        spec_text,
    )
    .expect("写规范");
    std::fs::write(
        fixture.dir.join("01-演示专项").join("02-实施计划.md"),
        plan_v1,
    )
    .expect("写计划");

    let app = app_with_real_jobs(&fixture, &root);
    let proposed_body = "# 实施计划\n- [x] 初稿步骤\n- [ ] 新增 CAS 安全校验\n";
    let spec_prefix = format!("sha256:{}", &spec_hash[..16]);

    let (status, accepted) = post_json(
        &app,
        "/api/v1/revision-proposals",
        &serde_json::json!({
            "file_id": "f_plan",
            "base_revision_id": plan_rev1,
            "content": proposed_body,
            "note": "补齐计划勾选",
            "input_context_hashes": [spec_prefix],
            "receipt_summary": "已依据架构规范补全实施步骤与校验项"
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    assert_eq!(accepted["draft_version_label"], "v2-agent-draft");
    assert_eq!(accepted["conflict"], false);

    let final_job = poll_job(&app, accepted["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_job["state"], "completed", "{final_job}");
    assert_eq!(
        final_job["result"]["proposal"]["draft_version_label"],
        "v2-agent-draft"
    );

    let disk_after_propose =
        std::fs::read_to_string(fixture.dir.join("01-演示专项").join("02-实施计划.md"))
            .expect("读磁盘");
    assert_eq!(disk_after_propose, plan_v1, "未经采纳不得改动磁盘原稿");

    let draft_id = accepted["draft_id"].as_str().expect("draft_id");
    let (status, list_json) = get(&app, "/api/v1/revision-proposals?status=proposed").await;
    assert_eq!(status, StatusCode::OK, "{list_json}");
    assert_eq!(
        list_json["items"][0]["draft_version_label"],
        "v2-agent-draft"
    );
    assert_eq!(
        list_json["items"][0]["receipt_summary"],
        "已依据架构规范补全实施步骤与校验项"
    );
    assert_eq!(
        list_json["items"][0]["input_context_hashes"][0],
        format!("sha256:{}", &spec_hash[..16])
    );

    let (status, content_json) = get(
        &app,
        &format!("/api/v1/revision-proposals/{draft_id}/content"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{content_json}");
    assert_eq!(content_json["draft_version_label"], "v2-agent-draft");
    assert_eq!(content_json["conflict"], false);
    assert_eq!(content_json["base_text"], plan_v1);
    assert_eq!(content_json["disk_text"], plan_v1);
    assert_eq!(content_json["proposed_text"], proposed_body);
    assert_eq!(content_json["truncated"], false);
}

#[tokio::test]
async fn e02_concurrent_human_edit_blocks_adopt_via_cas_without_losing_any_character() {
    let fixture = Fixture::new("e02_cas");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);

    let v1 = "# 设计文档\n初始条目\n";
    let h1 = sha256_of(v1);
    fixture.write_blob(&h1, v1.as_bytes());
    let rev1 = fixture.revision(&ws_id, "f_doc", 1, &h1);
    fixture.file(&ws_id, "f_doc", "01-演示专项/02-设计文档.md", Some(&rev1));
    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建目录");
    let doc_path = fixture.dir.join("01-演示专项").join("02-设计文档.md");
    std::fs::write(&doc_path, v1).expect("写初始稿");

    let app = app_with_real_jobs(&fixture, &root);

    let agent_draft = "# 设计文档\n初始条目\nAgent 新增方案段落\n";
    let (status, accepted) = post_json(
        &app,
        "/api/v1/revision-proposals",
        &serde_json::json!({
            "file_id": "f_doc",
            "base_revision_id": rev1,
            "content": agent_draft,
            "receipt_summary": "Agent 扩写方案段落"
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let propose_job = poll_job(&app, accepted["job_id"].as_str().expect("job_id")).await;
    assert_eq!(propose_job["state"], "completed");
    let draft_id = accepted["draft_id"].as_str().expect("draft_id");

    let human_edit = "# 设计文档\n初始条目\n人类刚补充的关键红线条款（绝不可丢失）\n";
    std::fs::write(&doc_path, human_edit).expect("模拟人类并发编辑");

    let (status, diff_json) = get(
        &app,
        &format!("/api/v1/revision-proposals/{draft_id}/content"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{diff_json}");
    assert_eq!(diff_json["conflict"], true, "应实时检出并发冲突");
    assert_eq!(diff_json["disk_text"], human_edit);
    assert_eq!(diff_json["proposed_text"], agent_draft);

    let (status, adopt_accepted) = post_json(
        &app,
        &format!("/api/v1/revision-proposals/{draft_id}/adopt"),
        "{}",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let adopt_job = poll_job(&app, adopt_accepted["job_id"].as_str().expect("job_id")).await;
    assert_eq!(adopt_job["state"], "completed", "{adopt_job}");
    assert_eq!(adopt_job["result"]["adopt"]["cas_ok"], false);
    assert!(adopt_job["result"]["adopt"]["new_revision_id"].is_null());
    assert_eq!(
        adopt_job["result"]["adopt"]["cas_conflict"]["expected_content_hash"],
        h1
    );
    assert_eq!(
        adopt_job["result"]["adopt"]["cas_conflict"]["disk_content_hash"],
        sha256_of(human_edit)
    );

    let disk_final = std::fs::read_to_string(&doc_path).expect("读磁盘");
    assert_eq!(disk_final, human_edit, "CAS 冲突下绝不可丢字或覆盖人类编辑");
    let (_, drafts) = get(&app, "/api/v1/revision-proposals?status=proposed").await;
    assert_eq!(drafts["items"][0]["conflict"], true);
}

#[tokio::test]
async fn e02_adopt_advances_version_backs_up_original_and_writes_derived_from_context_edges() {
    let fixture = Fixture::new("e02_adopt_edges");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);

    let spec_text = "# 上游协议\n接口版本号统一 v2。\n";
    let spec_hash = sha256_of(spec_text);
    fixture.write_blob(&spec_hash, spec_text.as_bytes());
    let spec_rev = fixture.revision(&ws_id, "f_spec", 1, &spec_hash);
    fixture.file(
        &ws_id,
        "f_spec",
        "01-演示专项/01-上游协议.md",
        Some(&spec_rev),
    );

    let plan_v1 = "# 实施文档\n接口版本 v1。\n";
    let plan_v1_hash = sha256_of(plan_v1);
    fixture.write_blob(&plan_v1_hash, plan_v1.as_bytes());
    let plan_rev1 = fixture.revision(&ws_id, "f_plan", 1, &plan_v1_hash);
    fixture.file(
        &ws_id,
        "f_plan",
        "01-演示专项/02-实施文档.md",
        Some(&plan_rev1),
    );

    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建目录");
    std::fs::write(
        fixture.dir.join("01-演示专项").join("01-上游协议.md"),
        spec_text,
    )
    .expect("写协议");
    let plan_path = fixture.dir.join("01-演示专项").join("02-实施文档.md");
    std::fs::write(&plan_path, plan_v1).expect("写实施文档");

    let app = app_with_real_jobs(&fixture, &root);
    let plan_v2 = "# 实施文档\n接口版本升级为 v2（与上游协议对齐）。\n";
    let (status, accepted) = post_json(
        &app,
        "/api/v1/revision-proposals",
        &serde_json::json!({
            "file_id": "f_plan",
            "base_revision_id": plan_rev1,
            "content": plan_v2,
            "input_context_hashes": [format!("sha256:{}", &spec_hash[..16])],
            "receipt_summary": "对齐上游协议 v2"
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let propose_job = poll_job(&app, accepted["job_id"].as_str().expect("job_id")).await;
    assert_eq!(propose_job["state"], "completed");
    let draft_id = accepted["draft_id"].as_str().expect("draft_id");

    let (status, adopt_accepted) = post_json(
        &app,
        &format!("/api/v1/revision-proposals/{draft_id}/adopt"),
        "{}",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let adopt_job = poll_job(&app, adopt_accepted["job_id"].as_str().expect("job_id")).await;
    assert_eq!(adopt_job["state"], "completed", "{adopt_job}");
    assert_eq!(adopt_job["result"]["adopt"]["cas_ok"], true);
    assert!(adopt_job["result"]["adopt"]["new_revision_id"].is_string());
    assert!(
        adopt_job["result"]["adopt"]["derived_edges_written"]
            .as_u64()
            .unwrap_or(0)
            >= 2,
        "应至少写入上游规范 + 基线版本 2 条 derived_from_context 因果边：{adopt_job}"
    );

    assert_eq!(std::fs::read_to_string(&plan_path).expect("读盘"), plan_v2);
    let backup_blob = fixture
        .db_path
        .parent()
        .expect("data_dir")
        .join("blobs")
        .join(&plan_v1_hash[..2])
        .join(&plan_v1_hash);
    assert_eq!(
        std::fs::read_to_string(&backup_blob).expect("原稿备份应完好"),
        plan_v1
    );

    let (status, revs) = get(&app, "/api/v1/files/f_plan/revisions").await;
    assert_eq!(status, StatusCode::OK, "{revs}");
    assert_eq!(revs["revisions"].as_array().expect("revisions").len(), 2);

    let (status, rels) = get(&app, "/api/v1/relations").await;
    assert_eq!(status, StatusCode::OK, "{rels}");
    let derived_edge = rels["items"]
        .as_array()
        .expect("relations")
        .iter()
        .find(|e| {
            e["source_id"] == "f_plan"
                && e["target_id"] == "f_spec"
                && e["type"] == "derived_from_context"
        })
        .expect("应存在 f_plan -> f_spec 的 derived_from_context 因果边");
    assert_eq!(derived_edge["label"], "源自上下文");
    assert!(
        derived_edge["reason"]
            .as_str()
            .unwrap_or("")
            .contains("v2-agent-draft"),
        "因果边理由应记录草案分支标签：{derived_edge}"
    );
}

#[tokio::test]
async fn e02_dismiss_rejects_draft_with_reason_and_never_touches_disk() {
    let fixture = Fixture::new("e02_dismiss");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);

    let v1 = "# 发布单\n当前保持人工审批步骤。\n";
    let h1 = sha256_of(v1);
    fixture.write_blob(&h1, v1.as_bytes());
    let rev1 = fixture.revision(&ws_id, "f_rel", 1, &h1);
    fixture.file(&ws_id, "f_rel", "01-演示专项/04-发布单.md", Some(&rev1));
    std::fs::create_dir_all(fixture.dir.join("01-演示专项")).expect("建目录");
    let rel_path = fixture.dir.join("01-演示专项").join("04-发布单.md");
    std::fs::write(&rel_path, v1).expect("写发布单");

    let app = app_with_real_jobs(&fixture, &root);
    let (status, accepted) = post_json(
        &app,
        "/api/v1/revision-proposals",
        &serde_json::json!({
            "file_id": "f_rel",
            "base_revision_id": rev1,
            "content": "# 发布单\n跳过人工审批。\n",
            "receipt_summary": "建议简化发布步骤"
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let _ = poll_job(&app, accepted["job_id"].as_str().expect("job_id")).await;
    let draft_id = accepted["draft_id"].as_str().expect("draft_id");

    let (status, dismiss_accepted) = post_json(
        &app,
        &format!("/api/v1/revision-proposals/{draft_id}/dismiss"),
        r#"{"reason":"不得删除人工审批步骤，请保留并补充回滚预案"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let dismiss_job = poll_job(&app, dismiss_accepted["job_id"].as_str().expect("job_id")).await;
    assert_eq!(dismiss_job["state"], "completed", "{dismiss_job}");
    assert_eq!(dismiss_job["result"]["dismiss"]["status"], "dismissed");
    assert_eq!(
        dismiss_job["result"]["dismiss"]["reason"],
        "不得删除人工审批步骤，请保留并补充回滚预案"
    );

    let (_, proposed) = get(&app, "/api/v1/revision-proposals?status=proposed").await;
    assert_eq!(proposed["items"].as_array().expect("items").len(), 0);
    assert_eq!(std::fs::read_to_string(&rel_path).expect("读盘"), v1);

    let (_, events) = get(&app, "/api/v1/events?kinds=proposal_dismissed&limit=10").await;
    assert_eq!(events["items"].as_array().expect("events").len(), 1);
}

#[tokio::test]
async fn context_assembles_initiative_preset_with_both_modes() {
    let fixture = Fixture::new("context");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id =
        fixture.initiative_with_stage(&ws_id, "01-演示专项", "计划", "pending_review");
    let content = "# 方案\n\n两阶段状态锁设计\n\n[P1 - 待确认] 属性字典与历史更新策略\n决定：___\n";
    let hash = sha256_of(content);
    fixture.write_blob(&hash, content.as_bytes());
    let revision_id = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(&ws_id, "f_d", "01-演示专项/方案.md", Some(&revision_id));
    fixture.artifact_state("f_d", &ws_id, &initiative_id, "计划", "pending_review");
    fixture.statement(
        &ws_id,
        "stmt_p1",
        "f_d",
        &revision_id,
        "P1",
        "属性字典与历史更新策略",
        "待确认",
        5,
        6,
        r#"{"priority":"P1"}"#,
    );
    let plan_content = "# 需求单

范围与边界
";
    let plan_hash = sha256_of(plan_content);
    fixture.write_blob(&plan_hash, plan_content.as_bytes());
    let plan_revision = fixture.revision(&ws_id, "f_p", 1, &plan_hash);
    fixture.file(&ws_id, "f_p", "01-演示专项/需求单.md", Some(&plan_revision));
    fixture.artifact_state("f_p", &ws_id, &initiative_id, "蓝图", "completed");
    let app = app_for_readonly(&fixture, &root);
    let real = fixture
        .conn
        .query_row("SELECT initiative_id FROM initiatives LIMIT 1", [], |row| {
            row.get::<_, String>(0)
        })
        .expect("initiative");
    let (status, json) = post_json(
        &app,
        "/api/v1/context",
        &format!(r##"{{"intent":"initiative","initiative_id":"{real}","mode":"both"}}"##),
    )
    .await;
    let _ = status;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["ok"], true);
    assert_eq!(json["intent"], "initiative");
    let items = json["preset"]["items"].as_array().expect("items");
    assert!(
        items.len() >= 2,
        "默认勾选 ≥2（各阶段摘要 + 当前阶段全量）：{json}"
    );
    assert!(
        items.iter().any(|item| item["granularity"] == "full"),
        "当前阶段全量正文：{json}"
    );
    assert!(
        items.iter().any(|item| item["granularity"] == "summary"),
        "各阶段摘要"
    );
    let pending = json["decisions"]["pending"].as_array().expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["priority"], "P1");
    assert_eq!(json["token_budget"]["threshold"], 65536);
    assert!(json["token_budget"]["est_tokens"].as_u64().expect("est") > 0);
    let markdown = json["markdown"].as_str().expect("markdown");
    assert!(markdown.starts_with("<guanlan_context "), "{markdown}");
    assert!(markdown.contains("<confirmed_decisions"));
    assert!(markdown.contains("<pending_blockers"));
    assert!(markdown.contains("<reference_files"));
    assert!(markdown.contains("<writeback_protocol"));
    let payload = &json["payload"];
    assert_eq!(payload["protocol"], "guanlan-mcp/v1");
    assert!(
        payload["session_checkpoint_id"].is_null() || payload["session_checkpoint_id"].is_string()
    );
    assert_eq!(
        payload["allowed_mcp_tools"]
            .as_array()
            .expect("tools")
            .len(),
        4
    );
    assert_eq!(payload["guardrails"]["block_write_on_unresolved_p0"], true);
    assert_eq!(payload["guardrails"]["require_version_bump"], true);
    assert_eq!(payload["initiative"]["id"], real);

    let (status, _) = post_json(&app, "/api/v1/context", r#"{"intent":"document"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn e03_context_four_granularities_upstream_snippets_secret_redaction_and_zero_empty_list() {
    let fixture = Fixture::new("e03_context");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);

    let spec_body = "# 01-系统架构规范\n结论：全部本地写回必须经 CAS 冲突检查与脱敏护栏。\n## 安全红线\n绝不允许在上下文包内泄露本机密钥。\n";
    let spec_hash = sha256_of(spec_body);
    fixture.write_blob(&spec_hash, spec_body.as_bytes());
    let spec_rev = fixture.revision(&ws_id, "f_spec", 1, &spec_hash);
    fixture.file(
        &ws_id,
        "f_spec",
        "02-上下文引擎/01-系统架构规范.md",
        Some(&spec_rev),
    );

    let plan_v1 = "# 02-实施计划\n- [ ] 实现基础组装器\n旧版临时方案。\n";
    let plan_v1_hash = sha256_of(plan_v1);
    fixture.write_blob(&plan_v1_hash, plan_v1.as_bytes());
    let plan_rev1 = fixture.revision(&ws_id, "f_plan", 1, &plan_v1_hash);

    let plan_v2 = "# 02-实施计划\n结论：采用四档注入粒度与服务端单一真相源。\n- [x] 实现基础组装器\n- [ ] 上线四档粒度切换\n参考 [系统架构规范](01-系统架构规范.md)\nOPENAI_API_KEY=sk-proj-RealLeakTest1234567890abcdef\nAuthorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.leak.sig\n";
    let plan_v2_hash = sha256_of(plan_v2);
    fixture.write_blob(&plan_v2_hash, plan_v2.as_bytes());
    let plan_rev2 = fixture.revision(&ws_id, "f_plan", 2, &plan_v2_hash);
    fixture
        .conn
        .execute(
            "UPDATE revisions SET prev_revision_id = ?1 WHERE revision_id = ?2",
            rusqlite::params![plan_rev1, plan_rev2],
        )
        .expect("连前驱版");
    fixture.file(
        &ws_id,
        "f_plan",
        "02-上下文引擎/02-实施计划.md",
        Some(&plan_rev2),
    );

    let env_body = "AWS_SECRET_ACCESS_KEY=SuperSecretAwsKey999999999999\n";
    let env_hash = sha256_of(env_body);
    fixture.write_blob(&env_hash, env_body.as_bytes());
    let env_rev = fixture.revision(&ws_id, "f_env", 1, &env_hash);
    fixture.file(&ws_id, "f_env", ".env", Some(&env_rev));

    let init_id = "init_e03";
    fixture
        .conn
        .execute(
            "INSERT INTO initiatives (initiative_id, workspace_id, name, root_dir, current_stage, state, created_at, updated_at) \
             VALUES (?1, ?2, '02-上下文引擎', '02-上下文引擎', '待分类', 'draft', '2026-11-21T10:00:00Z', '2026-11-21T10:00:00Z')",
            rusqlite::params![init_id, ws_id],
        )
        .expect("插专项");
    fixture.artifact_state("f_spec", &ws_id, init_id, "待分类", "draft");
    fixture.artifact_state("f_plan", &ws_id, init_id, "待分类", "draft");

    fixture
        .conn
        .execute(
            "INSERT INTO edges (edge_id, workspace_id, source_file_id, source_revision_id, target_file_id, kind, resolution, reason) \
             VALUES ('e_e03_1', ?1, 'f_plan', ?2, 'f_spec', 'explicit_reference', 'resolved', '显式引用上游架构规范')",
            rusqlite::params![ws_id, plan_rev2],
        )
        .expect("插边");

    let app = app_for_readonly(&fixture, &root);

    let (status, init_resp) = post_json(
        &app,
        "/api/v1/context",
        r#"{"intent":"initiative","initiative_id":"init_e03","mode":"both"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{init_resp}");
    let init_items = init_resp["preset"]["items"].as_array().expect("items");
    assert!(
        !init_items.is_empty(),
        "非标准阶段专项也绝不得为空：{init_resp}"
    );
    assert!(
        !init_items.iter().any(|it| it["file_id"] == "f_env"),
        "敏感 .env 文件绝不得被自动预选"
    );

    let (status, doc_resp) = post_json(
        &app,
        "/api/v1/context",
        r#"{"intent":"document","focus_file_id":"f_plan","mode":"both"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{doc_resp}");
    let doc_md = doc_resp["markdown"].as_str().expect("markdown");
    assert!(
        doc_resp["redacted_secrets_count"].as_u64().unwrap_or(0) >= 2,
        "应拦截并统计密钥脱敏次数：{doc_resp}"
    );
    assert!(
        !doc_md.contains("sk-proj-RealLeakTest"),
        "绝不得泄露 API Key"
    );
    assert!(
        !doc_md.contains("eyJhbGciOiJIUzI1Ni"),
        "绝不得泄露 Bearer Token"
    );
    assert!(doc_md.contains("[REDACTED_SECRET]"), "应替换为统一脱敏标记");
    assert!(
        !doc_resp["upstream_snippets"]
            .as_array()
            .expect("upstream_snippets")
            .is_empty(),
        "应自动抽取上游规范引用片段：{doc_resp}"
    );
    assert!(
        doc_md.contains("<upstream_references"),
        "Markdown 含上游规范段"
    );
    assert!(
        doc_resp["token_budget"]["est_chars"].as_u64().unwrap_or(0) > 0,
        "预算含实时字符数"
    );
    let expected_hash_prefix = format!("sha256:{}", &plan_v2_hash[..16]);
    assert_eq!(
        doc_resp["payload"]["context_bundle"][0]["hash"],
        expected_hash_prefix
    );

    let (_, doc_resp_2) = post_json(
        &app,
        "/api/v1/context",
        r#"{"intent":"document","focus_file_id":"f_plan","mode":"both"}"#,
    )
    .await;
    assert_eq!(doc_resp["markdown"], doc_resp_2["markdown"]);
    assert_eq!(doc_resp["payload"], doc_resp_2["payload"]);

    let (_, full_r) = post_json(
        &app,
        "/api/v1/context",
        r#"{"intent":"document","focus_file_id":"f_plan","items":[{"file_id":"f_plan","granularity":"full"}],"mode":"both"}"#,
    )
    .await;
    let (_, diff_r) = post_json(
        &app,
        "/api/v1/context",
        r#"{"intent":"document","focus_file_id":"f_plan","items":[{"file_id":"f_plan","granularity":"diff_only"}],"mode":"both"}"#,
    )
    .await;
    let (_, meta_r) = post_json(
        &app,
        "/api/v1/context",
        r#"{"intent":"document","focus_file_id":"f_plan","items":[{"file_id":"f_plan","granularity":"metadata_only"}],"mode":"both"}"#,
    )
    .await;
    let diff_snippet = diff_r["preset"]["items"][0]["snippet"]
        .as_str()
        .expect("diff snippet");
    assert!(
        diff_snippet.contains("+ - [x] 实现基础组装器")
            && diff_snippet.contains("- 旧版临时方案。"),
        "diff_only 应输出与前驱版本的真实增删行：{diff_snippet}"
    );
    assert!(
        !diff_snippet.contains("sk-proj-RealLeakTest"),
        "diff_only 也必须经过脱敏护栏"
    );
    assert!(
        meta_r["preset"]["items"][0]["est_tokens"].as_u64().unwrap()
            < full_r["preset"]["items"][0]["est_tokens"].as_u64().unwrap(),
        "metadata_only Token 预算必须显著低于 full"
    );
    assert!(
        !meta_r["markdown"]
            .as_str()
            .unwrap()
            .contains("<context_excerpts"),
        "仅元数据路径不得内联正文片段"
    );

    let (status, env_resp) = post_json(
        &app,
        "/api/v1/context",
        r#"{"intent":"document","focus_file_id":"f_env","items":[{"file_id":"f_env","granularity":"full"}],"mode":"both"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{env_resp}");
    assert!(
        !env_resp["markdown"]
            .as_str()
            .unwrap()
            .contains("SuperSecretAwsKey"),
        "显式传入 .env 也绝不得泄露真实密钥"
    );
}

#[tokio::test]
async fn e03_mcp_host_config_merges_existing_servers_and_rejects_remote_endpoint() {
    let fixture = Fixture::new("e03_mcp_host");
    let root = fixture.root();
    let _ws = fixture.workspace(&root);
    let app = app_for_readonly(&fixture, &root);

    let existing = r#"{"mcpServers":{"otherTool":{"command":"node","args":["other.js"]}}}"#;
    std::fs::write(fixture.dir.join(".mcp.json"), existing).expect("写初始 .mcp.json");

    let (status, bad) = post_json(
        &app,
        "/api/v1/mcp/host-config",
        r#"{"host":"zcode","endpoint":"https://evil.example:443","dry_run":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");

    let (status, no_confirm) = post_json(
        &app,
        "/api/v1/mcp/host-config",
        r#"{"host":"zcode","endpoint":"http://127.0.0.1:39120","dry_run":false,"confirm":false}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{no_confirm}");

    let (status, zcode_res) = post_json(
        &app,
        "/api/v1/mcp/host-config",
        r#"{"host":"zcode","endpoint":"http://127.0.0.1:41234","dry_run":false,"confirm":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{zcode_res}");
    assert_eq!(zcode_res["written"], true);
    assert_eq!(zcode_res["merged_existing"], true);
    assert_eq!(zcode_res["target_relative_path"], ".mcp.json");
    let disk_raw = std::fs::read_to_string(fixture.dir.join(".mcp.json")).expect("读盘");
    let parsed: serde_json::Value = serde_json::from_str(&disk_raw).expect("合法 JSON");
    assert_eq!(parsed["mcpServers"]["otherTool"]["command"], "node");
    assert_eq!(parsed["mcpServers"]["guanlan"]["command"], "guanlan");
    assert_eq!(
        parsed["mcpServers"]["guanlan"]["env"]["GUANLAN_ENDPOINT"],
        "http://127.0.0.1:41234"
    );
    assert_eq!(
        parsed["mcpServers"]["guanlan"]["env"]
            .as_object()
            .unwrap()
            .len(),
        1,
        "env 仅允许 GUANLAN_ENDPOINT，绝不混入本机环境变量"
    );

    let (status, cursor_res) = post_json(
        &app,
        "/api/v1/mcp/host-config",
        r#"{"host":"cursor","endpoint":"http://127.0.0.1:41234","dry_run":false,"confirm":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cursor_res}");
    assert_eq!(cursor_res["target_relative_path"], ".cursor/mcp.json");
    assert!(fixture.dir.join(".cursor").join("mcp.json").exists());
}

#[tokio::test]
async fn e04_hitl_writeback_syncs_md_sqlite_and_review_board_under_200ms_and_unlocks_downstream() {
    let fixture = Fixture::new("e04_hitl_unlock");
    let root = fixture.root();
    let _ws = fixture.workspace(&root);

    let init_dir = fixture.dir.join("03-批阅专项");
    std::fs::create_dir_all(&init_dir).expect("建目录");
    std::fs::write(init_dir.join("01-需求蓝图.md"), "# 蓝图\n核心目标清晰。\n").expect("写蓝图");
    std::fs::write(init_dir.join("02-实施计划.md"), "# 计划\n按阶段交付。\n").expect("写计划");
    let decision_md = "---\nrevision: 1\n---\n# 决策卡点\n\n### [P1 - 待确认] 是否开放孤儿自动修复入口\n- 决定：_____\n- 确认人：_____\n- 生效范围与日期：_____\n";
    let decision_path = init_dir.join("03-待确认决策.md");
    std::fs::write(&decision_path, decision_md).expect("写决策");

    let app = app_with_real_jobs(&fixture, &root);
    let (status, job) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"verify_all"}"#).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let settled = poll_job(&app, job["job_id"].as_str().expect("job_id")).await;
    assert_eq!(settled["state"], "completed", "{settled}");

    let (status, board_before) = get(&app, "/api/v1/review-board").await;
    assert_eq!(status, StatusCode::OK, "{board_before}");
    assert_eq!(
        board_before["counts"]["pending_decision"], 1,
        "{board_before}"
    );
    let card_before = &board_before["items"][0];
    assert_eq!(card_before["bucket"], "pending_decision");
    assert_eq!(card_before["pending_p1"], 1);
    let statement_id = card_before["pending_statements"][0]["statement_id"]
        .as_str()
        .expect("statement_id")
        .to_owned();
    let init_id = card_before["initiative_id"]
        .as_str()
        .expect("initiative_id")
        .to_owned();

    let wall_start = std::time::Instant::now();
    let (status, accepted) = post_json(
        &app,
        &format!("/api/v1/decisions/{statement_id}/resolve"),
        r#"{"decision":"采用人工显式孤儿修复入口","confirmer":"总架构师","effective_scope":"全量专项","effective_date":"2026-11-21"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    let final_job = poll_job(&app, accepted["job_id"].as_str().expect("job_id")).await;
    let wall_elapsed = wall_start.elapsed().as_millis() as u64;
    assert_eq!(final_job["state"], "completed", "{final_job}");

    let wb = &final_job["result"]["writeback"];
    assert_eq!(wb["cas_ok"], true, "{wb}");
    assert_eq!(wb["file_changed"], true, "{wb}");
    assert_eq!(wb["initiative_id"], init_id, "{wb}");
    assert_eq!(wb["remaining_pending_p0_p1"], 0, "{wb}");
    assert_eq!(
        wb["unlocked_downstream"], true,
        "拍板后必须解锁下游被阻塞专项：{wb}"
    );
    let core_elapsed_ms = wb["elapsed_ms"].as_u64().expect("elapsed_ms");
    assert!(
        core_elapsed_ms < 200,
        "拍板写回 + SQLite 版本提交 + 状态机重算应 <200ms，实测 core={core_elapsed_ms}ms wall={wall_elapsed}ms"
    );

    let disk_after = std::fs::read_to_string(&decision_path).expect("读回 .md");
    assert!(disk_after.contains("[P1 - 已确认]"), "{disk_after}");
    assert!(
        disk_after.contains("采用人工显式孤儿修复入口"),
        "{disk_after}"
    );
    assert!(disk_after.contains("revision: 2"), "{disk_after}");

    let file_id = card_before["pending_statements"][0]["file_id"]
        .as_str()
        .expect("file_id");
    let (_, revs) = get(&app, &format!("/api/v1/files/{file_id}/revisions")).await;
    assert_eq!(revs["revisions"].as_array().expect("revs").len(), 2);

    let (status, board_after) = get(&app, "/api/v1/review-board").await;
    assert_eq!(status, StatusCode::OK, "{board_after}");
    assert_eq!(
        board_after["counts"]["pending_decision"], 0,
        "{board_after}"
    );
    assert_eq!(
        board_after["items"][0]["bucket"], "dispatchable",
        "{board_after}"
    );
    assert_eq!(board_after["items"][0]["pending_p1"], 0);
}

#[tokio::test]
async fn e04_review_board_unknown_orphan_detection_repair_and_anti_skip_review_guard() {
    let fixture = Fixture::new("e04_orphan_guard");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);

    let body = "# 执行产物\n- [x] 已完成实现\n";
    let h = sha256_of(body);
    fixture.write_blob(&h, body.as_bytes());
    let rev = fixture.revision(&ws_id, "f_exec", 1, &h);
    fixture.file(&ws_id, "f_exec", "04-失联专项/04-执行实现.md", Some(&rev));

    let init_id = "init_e04_orphan";
    fixture
        .conn
        .execute(
            "INSERT INTO initiatives (initiative_id, workspace_id, name, root_dir, current_stage, state, artifact_count, created_at, updated_at) \
             VALUES (?1, ?2, '04-失联专项', '04-失联专项', '执行', 'executing', 1, '2026-11-21T08:00:00Z', '2026-11-21T08:00:00Z')",
            rusqlite::params![init_id, ws_id],
        )
        .expect("插专项");
    fixture.artifact_state("f_exec", &ws_id, init_id, "执行", "executing");
    fixture
        .conn
        .execute(
            "INSERT INTO task_nodes (node_id, workspace_id, initiative_id, stage, title, node_kind, state, depends_json, payload_json, created_at, updated_at) \
             VALUES ('node_orphan_exec', ?1, ?2, '执行', '执行·生成执行', 'generate', 'running', '[]', '{}', '2026-11-21T08:00:00Z', '2026-11-21T08:00:00Z')",
            rusqlite::params![ws_id, init_id],
        )
        .expect("插孤儿节点");

    let app = app_with_real_jobs(&fixture, &root);

    let (status, board) = get(
        &app,
        "/api/v1/review-board?now=2026-11-21T09:00:00Z&stall_threshold_secs=1800",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{board}");
    assert_eq!(board["counts"]["unknown"], 1, "{board}");
    assert_eq!(board["items"][0]["bucket"], "unknown");
    assert_eq!(board["items"][0]["orphan"]["node_id"], "node_orphan_exec");
    assert!(
        board["items"][0]["orphan"]["stalled_seconds"]
            .as_i64()
            .unwrap_or(0)
            >= 3600
    );

    let (status, bad_repair) = post_json(
        &app,
        &format!("/api/v1/review-board/{init_id}/repair-orphan"),
        r#"{"action":"completed"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad_repair}");

    let (status, repair_acc) = post_json(
        &app,
        &format!("/api/v1/review-board/{init_id}/repair-orphan"),
        r#"{"action":"reset_to_dispatchable","node_id":"node_orphan_exec","note":"确认进程已退出，重置重跑"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{repair_acc}");
    let repair_job = poll_job(&app, repair_acc["job_id"].as_str().expect("job_id")).await;
    assert_eq!(repair_job["state"], "completed", "{repair_job}");
    assert_eq!(
        repair_job["result"]["repair"]["new_board_bucket"],
        "dispatchable"
    );

    let (_, board_repaired) = get(&app, "/api/v1/review-board").await;
    assert_eq!(board_repaired["counts"]["unknown"], 0, "{board_repaired}");
    assert_eq!(
        board_repaired["items"][0]["bucket"], "dispatchable",
        "{board_repaired}"
    );

    fixture
        .conn
        .execute(
            "UPDATE initiatives SET state = 'delivered' WHERE initiative_id = ?1",
            rusqlite::params![init_id],
        )
        .expect("改 delivered");
    fixture
        .conn
        .execute(
            "INSERT INTO revision_drafts (draft_id, workspace_id, file_id, base_revision_id, base_content_hash, proposed_content_hash, snapshot_rel_path, source, status, conflict, draft_version_label, input_context_hashes_json, created_at, updated_at) \
             VALUES ('draft_guard_1', ?1, 'f_exec', ?2, ?3, ?3, 'blobs/xx/xx', 'agent', 'proposed', 0, 'v2-agent-draft', '[]', '2026-11-21T09:10:00Z', '2026-11-21T09:10:00Z')",
            rusqlite::params![ws_id, rev, h],
        )
        .expect("插待审草案");
    let (_, board_draft) = get(&app, "/api/v1/review-board").await;
    assert_eq!(
        board_draft["items"][0]["bucket"], "awaiting_receipt",
        "存在未批阅回执绝不可跳过人工审阅进入 completed：{board_draft}"
    );
}

#[tokio::test]
async fn file_summary_reads_persisted_summary() {
    let fixture = Fixture::new("summary");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let hash = sha256_of("# A\n## B\n");
    fixture.write_blob(&hash, b"# A\n## B\n");
    let revision_id = fixture.revision(&ws_id, "f_d", 1, &hash);
    fixture.file(&ws_id, "f_d", "docs/a.md", Some(&revision_id));
    fixture
        .conn
        .execute(
            "INSERT INTO summary_jobs (job_id, workspace_id, file_id, content_hash, priority, state, summary_json, attempts, created_at, updated_at) \
             VALUES ('sj_1', ?1, 'f_d', ?2, 10, 'done', ?3, 1, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')",
            rusqlite::params![
                ws_id,
                hash,
                r#"{"core_summary":"核心摘要","outline":[{"level":1,"title":"A","line":1},{"level":2,"title":"B","line":2}],"decisions_digest":{"confirmed":1,"pending":2,"p0":1,"p1":1},"generated_by":"local_deterministic","extract_rule_version":"l4a-v0.1.0"}"#
            ],
        )
        .expect("插摘要行");
    let app = app_for_readonly(&fixture, &root);

    let (status, json) = get(&app, "/api/v1/summary/f_d").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["queued"], false);
    let summary = &json["summary"];
    assert_eq!(summary["generated_by"], "local_deterministic");
    assert_eq!(summary["extract_rule_version"], "l4a-v0.1.0");
    assert_eq!(summary["outline"].as_array().expect("outline").len(), 2);
    assert_eq!(summary["decisions_digest"]["confirmed"], 1);
    assert_eq!(summary["decisions_digest"]["p0"], 1);
}

#[tokio::test]
async fn index_jobs_external_kinds_and_validation() {
    let fixture = Fixture::new("jobsx");
    let root = fixture.root();
    let _ws = fixture.workspace(&root);
    let app = app_with_real_jobs(&fixture, &root);

    let (status, json) = post_json(
        &app,
        "/api/v1/index-jobs",
        r#"{"kind":"set_initiative_dirs","dirs":["BOM与图纸联动方案","01-演示专项"]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{json}");
    let final_json = poll_job(&app, json["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_json["state"], "completed", "{final_json}");

    let (status, json) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"changed_paths"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{json}");

    let (status, json) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"l4a_summary"}"#).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let final_json = poll_job(&app, json["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_json["state"], "completed");
    assert!(
        final_json["result"].is_null() || final_json["result"].is_object(),
        "l4a 结果分支可空可对象"
    );

    let (status, json) = post_json(
        &app,
        "/api/v1/index-jobs",
        r#"{"kind":"decision_writeback"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"]
        .as_str()
        .expect("err")
        .contains("decision_writeback"));

    let (status, json) = post_json(
        &app,
        "/api/v1/index-jobs",
        r#"{"kind":"metadata_reconcile"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json["error"]
        .as_str()
        .expect("err")
        .contains("metadata_reconcile"));

    let (_, done) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"l4a_summary"}"#).await;
    let final_json = poll_job(&app, done["job_id"].as_str().expect("job_id")).await;
    assert_eq!(final_json["state"], "completed");
    let (status, cancel_json) = post_json(
        &app,
        &format!(
            "/api/v1/jobs/{}/cancel",
            done["job_id"].as_str().expect("job_id")
        ),
        "{}",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{cancel_json}");
    assert_eq!(cancel_json["code"], "CONFLICT");

    let (status, _) = post_json(&app, "/api/v1/jobs/job_不存在/cancel", "{}").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sse_stream_sends_hello() {
    let fixture = Fixture::new("sse");
    let root = fixture.root();
    let _ws = fixture.workspace(&root);
    let app = app_with_real_jobs(&fixture, &root);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/stream")
                .body(Body::empty())
                .expect("请求构建"),
        )
        .await
        .expect("oneshot");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("text/event-stream"),
        "SSE content-type 应为 text/event-stream"
    );
    let mut body = response.into_body();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
        .await
        .expect("hello 帧 2s 内到达")
        .expect("frame")
        .expect("data");
    let bytes = frame.into_data().expect("data frame");
    let text = String::from_utf8_lossy(&bytes).into_owned();
    assert!(text.contains("event: hello"), "{text}");
    assert!(text.contains("\"type\":\"hello\""), "{text}");
    assert!(text.contains("\"instance_id\":\"inst_lt\""), "{text}");
}

#[tokio::test]
async fn resume_context_endpoint_returns_delta_and_latest_decisions() {
    let fixture = Fixture::new("resume");
    let root = fixture.root();
    let ws_id = fixture.workspace(&root);
    let initiative_id = fixture.initiative_with_stage(&ws_id, "01-演示专项", "执行", "executing");
    let revision_id = fixture.revision(
        &ws_id,
        "f_resume",
        1,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    fixture.file(
        &ws_id,
        "f_resume",
        "01-演示专项/README.md",
        Some(&revision_id),
    );
    fixture.artifact_state(
        "f_resume",
        &ws_id,
        &initiative_id,
        "执行",
        "approved_revision",
    );
    fixture
        .conn
        .execute(
            "INSERT INTO checkpoints (checkpoint_id, node_id, workspace_id, initiative_id, stage, \
                status, input_context_hash, output_revision_id, token_usage, elapsed_ms, note, created_at) \
             VALUES ('ckpt_resume', NULL, ?1, ?2, '执行', 'SUCCESS', 'ctx_hash', NULL, NULL, NULL, NULL, \
                '2026-05-01T00:00:00.000Z')",
            rusqlite::params![ws_id, initiative_id],
        )
        .expect("插入 checkpoint 失败");
    fixture.statement(
        &ws_id,
        "st_resume",
        "f_resume",
        &revision_id,
        "D-01",
        "是否继续？",
        "已确认",
        1,
        2,
        "{\"priority\":\"P1\"}",
    );

    let app = app_for_readonly(&fixture, &root);
    let (status, json) = get(
        &app,
        &format!("/api/v1/initiatives/{initiative_id}/resume-context?stage=执行"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["checkpoint"]["checkpoint_id"], "ckpt_resume");
    assert_eq!(json["delta"].as_array().expect("delta").len(), 1);
    assert_eq!(json["delta"][0]["path"], "01-演示专项/README.md");
    assert_eq!(json["latest_decisions"][0]["status"], "已确认");
    assert!(json["prompt_context"]
        .as_str()
        .expect("prompt")
        .contains("delta_since_checkpoint count=\"1\""));

    let (status, _) = get(&app, "/api/v1/initiatives/init_missing/resume-context").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

struct IsolatedTrashDriver {
    trash_dir: PathBuf,
}

impl guanlan_core::index::file_ops::TrashDriver for IsolatedTrashDriver {
    fn move_to_trash(
        &self,
        abs_path: &std::path::Path,
    ) -> Result<&'static str, guanlan_core::error::GuanlanError> {
        std::fs::create_dir_all(&self.trash_dir).map_err(|e| {
            guanlan_core::error::GuanlanError::Internal(format!("创建隔离回收站失败：{e}"))
        })?;
        let name = abs_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| {
                guanlan_core::error::GuanlanError::BadRequest("无效文件名".to_owned())
            })?;
        std::fs::rename(abs_path, self.trash_dir.join(name)).map_err(|e| {
            guanlan_core::error::GuanlanError::Internal(format!("模拟回收站移动失败：{e}"))
        })?;
        Ok("isolated_test_trash")
    }
}

#[tokio::test]
async fn a05_file_rename_move_trash_and_restore_roundtrip() {
    let fixture = Fixture::new("a05-http");
    let ws_root_dir = fixture.dir.join("workspace");
    let trash_dir = fixture.dir.join("trash");
    let data_dir = fixture.dir.join("data");
    std::fs::create_dir_all(ws_root_dir.join("01-演示专项")).expect("建工作区");
    std::fs::create_dir_all(&data_dir).expect("建数据目录");
    std::fs::write(
        ws_root_dir.join("01-演示专项/03-待确认事项.md"),
        "---\ndate: 2026-05-01\n---\n# 03-待确认事项\n\n## 1. 接口策略\n沿用编号：Q01\n状态：待确认\n",
    )
    .expect("写测试文档");

    let root = ws_root_dir.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &root).expect("开写库");
    let report = guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .expect("首次扫描");
    assert_eq!(report.new_files, 1);
    let file_row = writer
        .find_file_by_path(&report.workspace_id, "01-演示专项/03-待确认事项.md")
        .expect("查文件")
        .expect("存在");
    let file_id = file_row.file_id.clone();

    let mut store = ReadonlyStore::open(&data_dir.join("index.db")).expect("开只读库");
    store.claim_workspace(&root).expect("认领工作区");
    let jobs = crate::index_jobs::IndexJobManager::start_with_trash_driver_for_test(
        writer,
        None,
        Arc::new(IsolatedTrashDriver {
            trash_dir: trash_dir.clone(),
        }),
    );
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(super::ResponseBudget::new(
            64 * 1024 * 1024,
            8 * 1024 * 1024,
        )),
        exec: Arc::new(super::QueryExecutor::with_config(
            vec![store],
            test_exec_config(),
        )),
        instance_id: "inst_a05".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: Some(crate::runtime::NoticeHub::new()),
    });

    let (status, bad) = post_json(
        &app,
        &format!("/api/v1/files/{file_id}/rename"),
        r#"{"new_name":"../evil.md"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    assert_eq!(bad["code"], "BAD_REQUEST");

    let (status, renamed) = post_json(
        &app,
        &format!("/api/v1/files/{file_id}/rename"),
        r#"{"new_name":"03-拍板清单.md"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["operation"], "file_renamed");
    assert_eq!(renamed["file_id"], file_id);
    assert_eq!(renamed["new_path"], "01-演示专项/03-拍板清单.md");
    assert!(ws_root_dir.join("01-演示专项/03-拍板清单.md").is_file());

    let (status, bad_move) = post_json(
        &app,
        &format!("/api/v1/files/{file_id}/move"),
        r#"{"target_dir":"node_modules/sub"}"#,
    )
    .await;
    assert_eq!(bad_move["code"], "BAD_REQUEST", "{bad_move}");
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, moved) = post_json(
        &app,
        &format!("/api/v1/files/{file_id}/move"),
        r#"{"target_dir":"02-归档专项/定稿"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["operation"], "file_moved");
    assert_eq!(moved["file_id"], file_id);
    assert_eq!(moved["new_path"], "02-归档专项/定稿/03-拍板清单.md");

    let (status, rev_json) = get(
        &app,
        &format!("/api/v1/files/{file_id}/revisions?include=events,aliases"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rev_json}");
    assert_eq!(rev_json["revisions"].as_array().expect("revs").len(), 1);
    let aliases: Vec<&str> = rev_json["aliases"]
        .as_array()
        .expect("aliases")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(aliases.contains(&"01-演示专项/03-待确认事项.md"));
    assert!(aliases.contains(&"01-演示专项/03-拍板清单.md"));
    assert!(aliases.contains(&"02-归档专项/定稿/03-拍板清单.md"));
    let (status, dec_json) = get(&app, "/api/v1/decisions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        dec_json["items"][0]["evidences"][0]["relative_path"],
        "02-归档专项/定稿/03-拍板清单.md"
    );

    let (status, unconfirmed) = post_json(
        &app,
        &format!("/api/v1/files/{file_id}/trash"),
        r#"{"confirm":false}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{unconfirmed}");

    let (status, trashed) = post_json(
        &app,
        &format!("/api/v1/files/{file_id}/trash"),
        r#"{"confirm":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{trashed}");
    assert_eq!(trashed["operation"], "file_trashed");
    assert_eq!(trashed["status"], "trashed");
    assert_eq!(trashed["trash_recoverable"], true);
    assert!(trash_dir.join("03-拍板清单.md").is_file());

    let (status, boot) = get(&app, "/api/v1/bootstrap").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(boot["files_total"], 0);
    assert_eq!(boot["recoverable_file_ids"][0], file_id);
    let (status, rec_page) = get(&app, "/api/v1/files?status=recoverable").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rec_page["total_matched"], 1);
    assert_eq!(rec_page["items"][0]["status"], "trashed");

    std::fs::rename(
        trash_dir.join("03-拍板清单.md"),
        ws_root_dir.join("02-归档专项/定稿/03-拍板清单.md"),
    )
    .expect("从回收站还原");
    let (status, job_acc) = post_json(&app, "/api/v1/index-jobs", r#"{"kind":"verify_all"}"#).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let job_done = poll_job(&app, job_acc["job_id"].as_str().expect("job_id")).await;
    assert_eq!(job_done["state"], "completed", "{job_done}");

    let (status, boot_after) = get(&app, "/api/v1/bootstrap").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(boot_after["files_total"], 1);
    assert_eq!(boot_after["files"]["items"][0]["file_id"], file_id);
    assert!(boot_after.get("recoverable_file_ids").is_none());

    jobs.shutdown();
}

#[tokio::test]
async fn f01_context_capsule_preview_export_inspect_and_file_read() {
    let base = std::env::temp_dir().join(format!(
        "guanlan-f01-http-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let ws_root_dir = base.join("ws");
    let data_dir = base.join("data");
    let out_dir = base.join("capsule-out");
    std::fs::create_dir_all(ws_root_dir.join("01-胶囊交付/secrets")).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(
        ws_root_dir.join("01-胶囊交付/01-定稿方案.md"),
        "# 胶囊定稿方案\n\n## 关键决定\n- [P1 - 已确认] 采用开放目录胶囊结构（决定：TIMELINE.md + capsule-manifest.json）\n\n调试令牌：ghp_1234567890abcdefghijklmnop1234567890\n",
    )
    .unwrap();
    std::fs::write(
        ws_root_dir.join("01-胶囊交付/.env"),
        "SECRET_API_KEY=sk-proj-mustneverbundle1234567890123456\n",
    )
    .unwrap();
    std::fs::write(
        ws_root_dir.join("01-胶囊交付/secrets/prod.txt"),
        "PRIVATE_TOKEN=topsecret\n",
    )
    .unwrap();

    let ws_root = ws_root_dir.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &ws_root).expect("创建可写库");
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .expect("首次扫描");
    let mut store = ReadonlyStore::open(&data_dir.join("index.db")).expect("开只读库");
    store.claim_workspace(&ws_root).expect("认领工作区");
    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(super::ResponseBudget::new(
            64 * 1024 * 1024,
            8 * 1024 * 1024,
        )),
        exec: Arc::new(super::QueryExecutor::with_config(
            vec![store],
            test_exec_config(),
        )),
        instance_id: "inst_f01".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: Some(crate::runtime::NoticeHub::new()),
    });

    let (status, err_json) = post_json(
        &app,
        "/api/v1/capsules/export",
        &serde_json::json!({
            "mode": "with_snapshots",
            "confirmed_preview": false,
            "preview_token": "",
            "output_dir": out_dir.to_string_lossy(),
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err_json}");
    assert!(
        err_json["error"]
            .as_str()
            .unwrap_or("")
            .contains("PREVIEW_REQUIRED"),
        "{err_json}"
    );

    let (status, preview) = post_json(
        &app,
        "/api/v1/capsules/preview",
        r#"{"mode":"with_snapshots","sanitize_secrets":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let token = preview["preview_token"].as_str().unwrap().to_owned();
    assert!(!token.is_empty());
    assert_eq!(preview["selected_file_count"], 1, "{preview}");
    assert!(
        preview["sensitive_excluded_count"].as_u64().unwrap() >= 1,
        "{preview}"
    );
    assert!(
        preview["inline_redaction_count"].as_u64().unwrap() >= 1,
        "{preview}"
    );

    let (status, exported) = post_json(
        &app,
        "/api/v1/capsules/export",
        &serde_json::json!({
            "mode": "with_snapshots",
            "sanitize_secrets": true,
            "preview_token": token,
            "confirmed_preview": true,
            "output_dir": out_dir.to_string_lossy(),
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{exported}");
    assert_eq!(exported["files_exported"], 1, "{exported}");
    assert_eq!(exported["snapshots_written"], 1, "{exported}");
    assert!(exported["redactions_applied"].as_u64().unwrap() >= 1);
    assert!(!out_dir.join("files/01-胶囊交付/.env").exists());
    assert!(!out_dir.join("files/01-胶囊交付/secrets/prod.txt").exists());

    let (status, inspected) = post_json(
        &app,
        "/api/v1/capsules/inspect",
        &serde_json::json!({ "capsule_dir": out_dir.to_string_lossy() }).to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{inspected}");
    assert_eq!(inspected["integrity_ok"], true, "{inspected}");
    assert_eq!(inspected["checked_snapshots"], 1, "{inspected}");
    let bundled_rel = inspected["manifest"]["files"][0]["bundled_rel_path"]
        .as_str()
        .unwrap()
        .to_owned();

    let (status, file_resp) = post_json(
        &app,
        "/api/v1/capsules/file",
        &serde_json::json!({
            "capsule_dir": out_dir.to_string_lossy(),
            "bundled_rel_path": bundled_rel,
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{file_resp}");
    let text = file_resp["text"].as_str().unwrap();
    assert!(text.contains("[REDACTED_SECRET]"), "{text}");
    assert!(!text.contains("ghp_1234567890"), "{text}");

    let (status, jail_err) = post_json(
        &app,
        "/api/v1/capsules/file",
        &serde_json::json!({
            "capsule_dir": out_dir.to_string_lossy(),
            "bundled_rel_path": "../capsule-manifest.json",
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{jail_err}");

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn f02_storage_integrity_iron_law_gc_open_export_and_diagnostic_zip() {
    let base = std::env::temp_dir().join(format!(
        "guanlan-f02-http-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let ws_root_dir = base.join("ws");
    let data_dir = base.join("data");
    std::fs::create_dir_all(ws_root_dir.join("01-归档专项")).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();
    let doc_path = ws_root_dir.join("01-归档专项/01-定稿.md");

    let ws_root = ws_root_dir.to_string_lossy().into_owned();
    let mut writer = guanlan_core::index::Writer::open_at(&data_dir, &ws_root).expect("创建可写库");

    std::fs::write(&doc_path, "# 定稿 v1\n基线初稿\n").unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();
    std::fs::write(&doc_path, "# 定稿 v2\n纯过程草稿，将被安全瘦身\n").unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();
    std::fs::write(
        &doc_path,
        "# 定稿 v3\n- [P1 - 已确认] 开放导出格式（决定：JSONL + Markdown + 去重快照）\n",
    )
    .unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();
    std::fs::write(&doc_path, "# 定稿 v4\n当前最新正文\n").unwrap();
    guanlan_core::index::reconcile(
        &mut writer,
        &guanlan_core::index::ReconcileOptions::default(),
    )
    .unwrap();

    writer
        .conn()
        .execute(
            "UPDATE revisions SET observed_at = '2024-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();

    let mut store = ReadonlyStore::open(&data_dir.join("index.db")).expect("开只读库");
    store.claim_workspace(&ws_root).expect("认领工作区");
    let jobs = crate::index_jobs::IndexJobManager::start(writer);
    let app = build_router(AppState {
        mounts: crate::mounts::MountRegistry::idle(),
        projects: None,
        budget: Arc::new(super::ResponseBudget::new(
            64 * 1024 * 1024,
            8 * 1024 * 1024,
        )),
        exec: Arc::new(super::QueryExecutor::with_config(
            vec![store],
            test_exec_config(),
        )),
        instance_id: "inst_f02".to_owned(),
        jobs: jobs.clone(),
        dist: None,
        watcher: None,
        notices: Some(crate::runtime::NoticeHub::new()),
    });

    let (status, integ) = get(&app, "/api/v1/storage/integrity").await;
    assert_eq!(status, StatusCode::OK, "{integ}");
    assert_eq!(integ["ok"], true, "{integ}");
    assert_eq!(integ["healthy_blobs"], 4, "{integ}");

    let (status, gc_dry) = post_json(
        &app,
        "/api/v1/storage/gc",
        r#"{"older_than_days":30,"keep_recent_per_file":1,"remove_orphan_blobs":true,"dry_run":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{gc_dry}");
    assert_eq!(gc_dry["dry_run"], true);
    assert_eq!(
        gc_dry["pruned_revisions_count"], 1,
        "只应清理 v2，绝不碰 v1/v3/v4：{gc_dry}"
    );
    assert!(
        gc_dry["protected_decision_evidence_count"]
            .as_u64()
            .unwrap()
            >= 1
    );

    let (status, gc_exec) = post_json(
        &app,
        "/api/v1/storage/gc",
        r#"{"older_than_days":30,"keep_recent_per_file":1,"remove_orphan_blobs":true,"dry_run":false}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{gc_exec}");
    assert_eq!(gc_exec["dry_run"], false);
    assert_eq!(gc_exec["deleted_blobs_count"], 1);

    let (status, integ2) = get(&app, "/api/v1/storage/integrity").await;
    assert_eq!(status, StatusCode::OK, "{integ2}");
    assert_eq!(integ2["ok"], true, "{integ2}");
    assert_eq!(integ2["healthy_blobs"], 3, "{integ2}");

    let export_dir = base.join("open-export");
    let (status, exp) = post_json(
        &app,
        "/api/v1/export/workspace",
        &serde_json::json!({
            "include_snapshots": true,
            "output_dir": export_dir.to_string_lossy(),
        })
        .to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{exp}");
    assert_eq!(exp["snapshots_exported"], 3, "{exp}");
    assert!(export_dir.join("ledger/events.jsonl").is_file());
    assert!(export_dir.join("ledger/DECISIONS.md").is_file());

    let diag_path = base.join("diag.zip");
    let (status, diag) = post_json(
        &app,
        "/api/v1/storage/diagnostic-zip",
        &serde_json::json!({ "output_path": diag_path.to_string_lossy() }).to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{diag}");
    assert_eq!(diag["ok"], true);
    assert!(diag_path.is_file());

    let resp = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/api/v1/storage/diagnostic-zip")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .unwrap(),
        "application/zip"
    );
    let body_bytes = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    assert!(
        body_bytes.starts_with(b"PK\x03\x04"),
        "必须是合法 ZIP 文件头"
    );

    jobs.shutdown();
    let _ = std::fs::remove_dir_all(&base);
}

fn test_exec_config() -> super::query_exec::QueryConfig {
    super::query_exec::QueryConfig {
        wait_deadline: std::time::Duration::from_secs(5),
        exec_deadline: std::time::Duration::from_secs(10),
        max_waiters: 64,
    }
}
