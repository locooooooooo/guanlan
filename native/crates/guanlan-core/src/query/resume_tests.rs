//! `resume_context` 单元测试：最近 SUCCESS checkpoint、增量文件、最新决策、
//! 无 checkpoint 的诚实降级与未知专项 404。

use super::*;
use crate::test_support::{cleanup_dir, open_store, FixtureDb};

const H1: &str = "aa0000000000000000000000000000000000000000000000000000000000aaaa";
const H2: &str = "bb0000000000000000000000000000000000000000000000000000000000bbbb";
const H3: &str = "cc0000000000000000000000000000000000000000000000000000000000cccc";

const V2_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS initiatives (
  initiative_id    TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  name             TEXT NOT NULL,
  root_dir         TEXT NOT NULL,
  current_stage    TEXT NOT NULL DEFAULT '待分类',
  state            TEXT NOT NULL DEFAULT 'draft',
  artifact_count   INTEGER NOT NULL DEFAULT 0,
  pending_p0       INTEGER NOT NULL DEFAULT 0,
  pending_p1       INTEGER NOT NULL DEFAULT 0,
  pending_p2       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, root_dir)
);
CREATE TABLE IF NOT EXISTS artifact_states (
  file_id               TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  initiative_id         TEXT,
  stage                 TEXT NOT NULL DEFAULT '待分类',
  state                 TEXT NOT NULL DEFAULT 'draft',
  selected_revision_id  TEXT,
  checklist_done        INTEGER NOT NULL DEFAULT 0,
  checklist_total       INTEGER NOT NULL DEFAULT 0,
  pending_p0            INTEGER NOT NULL DEFAULT 0,
  pending_p1            INTEGER NOT NULL DEFAULT 0,
  pending_p2            INTEGER NOT NULL DEFAULT 0,
  last_activity_at      TEXT,
  updated_at            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id        TEXT PRIMARY KEY,
  node_id              TEXT,
  workspace_id         TEXT NOT NULL,
  initiative_id        TEXT NOT NULL,
  stage                TEXT NOT NULL,
  status               TEXT NOT NULL,
  input_context_hash   TEXT NOT NULL,
  output_revision_id   TEXT,
  token_usage          INTEGER,
  elapsed_ms           INTEGER,
  note                 TEXT,
  created_at           TEXT NOT NULL
);
"#;

fn setup(tag: &str) -> (FixtureDb, String, ReadonlyStore) {
    let fixture = FixtureDb::new(tag);
    let root = fixture.root();
    let ws_id = fixture.workspace(&root, 5, None);
    fixture.conn.execute_batch(V2_DDL).expect("建 v2 表失败");
    fixture
        .conn
        .execute_batch("PRAGMA user_version = 2;")
        .expect("登记 schema v2 失败");

    fixture
        .conn
        .execute(
            "INSERT INTO initiatives (initiative_id, workspace_id, name, root_dir, current_stage, \
                state, artifact_count, pending_p0, pending_p1, pending_p2, created_at, updated_at) \
             VALUES ('init_x', ?1, '04-智能体代码', '04-智能体代码', '执行', 'executing', 2, 0, 0, 0, \
                '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z')",
            params![ws_id],
        )
        .expect("插入专项失败");

    let r1 = fixture.revision(
        &ws_id,
        "f_readme",
        1,
        H1,
        10,
        Some("2026-01-01"),
        "day",
        None,
        1,
        "2026-01-01T00:00:00.000Z",
    );
    let r2 = fixture.revision(
        &ws_id,
        "f_readme",
        2,
        H2,
        12,
        Some("2026-01-05"),
        "day",
        None,
        1,
        "2026-01-05T00:00:00.000Z",
    );
    let r3 = fixture.revision(
        &ws_id,
        "f_plan",
        1,
        H3,
        8,
        Some("2026-01-04"),
        "day",
        None,
        1,
        "2026-01-04T00:00:00.000Z",
    );
    fixture.file(
        &ws_id,
        "f_readme",
        "04-智能体代码/README.md",
        "md",
        "说明",
        "active",
        Some(&r2),
    );
    fixture.file(
        &ws_id,
        "f_plan",
        "04-智能体代码/PLAN.md",
        "md",
        "计划",
        "active",
        Some(&r3),
    );

    for (file_id, stage, state, revision_id) in [
        ("f_readme", "执行", "approved_revision", r2.as_str()),
        ("f_plan", "计划", "approved_revision", r3.as_str()),
    ] {
        fixture
            .conn
            .execute(
                "INSERT INTO artifact_states (file_id, workspace_id, initiative_id, stage, state, \
                    selected_revision_id, checklist_done, checklist_total, pending_p0, pending_p1, \
                    pending_p2, last_activity_at, updated_at) \
                 VALUES (?1, ?2, 'init_x', ?3, ?4, ?5, 0, 0, 0, 0, 0, NULL, '2026-01-05T00:00:00.000Z')",
                params![file_id, ws_id, stage, state, revision_id],
            )
            .expect("插入文档状态失败");
    }

    // SUCCESS checkpoint（01-03）之后：PLAN v1（01-04）、README v2（01-05）进入 delta；
    // README v1（01-01）在 checkpoint 之前，不应进入 delta。
    fixture
        .conn
        .execute(
            "INSERT INTO checkpoints (checkpoint_id, node_id, workspace_id, initiative_id, stage, \
                status, input_context_hash, output_revision_id, token_usage, elapsed_ms, note, created_at) \
             VALUES ('ckpt_ok', NULL, ?1, 'init_x', '执行', 'SUCCESS', 'ctx_hash', ?2, NULL, NULL, NULL, \
                '2026-01-03T00:00:00.000Z')",
            params![ws_id, r1],
        )
        .expect("插入 SUCCESS checkpoint 失败");
    fixture
        .conn
        .execute(
            "INSERT INTO checkpoints (checkpoint_id, node_id, workspace_id, initiative_id, stage, \
                status, input_context_hash, output_revision_id, token_usage, elapsed_ms, note, created_at) \
             VALUES ('ckpt_failed', NULL, ?1, 'init_x', '执行', 'FAILED_RETRYABLE', 'ctx_hash', NULL, NULL, NULL, NULL, \
                '2026-01-06T00:00:00.000Z')",
            params![ws_id],
        )
        .expect("插入失败 checkpoint 失败");

    // dec_1：旧版待确认（01-01）→ 新版已确认（01-05，主陈述）
    fixture.statement(
        &ws_id,
        "st_old",
        "f_readme",
        &r1,
        "D-01",
        "项目 / 决策集",
        "用哪种方案？",
        "待确认",
        "> 用 A 方案",
        10,
        12,
        Some("dec_1"),
        "{\"priority\":\"P1\"}",
        "2026-01-01T00:00:00.000Z",
    );
    fixture.statement(
        &ws_id,
        "st_new",
        "f_readme",
        &r2,
        "D-01",
        "项目 / 决策集",
        "用哪种方案？",
        "已确认",
        "> 用 B 方案",
        10,
        12,
        Some("dec_1"),
        "{\"priority\":\"P1\"}",
        "2026-01-05T00:00:00.000Z",
    );
    fixture.statement(
        &ws_id,
        "st_plan",
        "f_plan",
        &r3,
        "D-02",
        "项目 / 计划",
        "是否延期？",
        "待确认",
        "> 延期一周",
        3,
        4,
        Some("dec_2"),
        "{\"priority\":\"P0\"}",
        "2026-01-04T00:00:00.000Z",
    );

    let store = open_store(&fixture, &root);
    (fixture, ws_id, store)
}

#[test]
fn resume_context_returns_latest_success_delta_and_latest_decisions() {
    let (fixture, ws_id, store) = setup("resume-ok");
    let resume = resume_context(&store, &ws_id, "init_x", Some("执行")).expect("恢复上下文");
    assert_eq!(resume.index_generation, 5);
    assert_eq!(resume.initiative_id, "init_x");

    let checkpoint = resume
        .checkpoint
        .as_ref()
        .expect("应命中 SUCCESS checkpoint");
    assert_eq!(checkpoint.checkpoint_id, "ckpt_ok");
    assert_eq!(checkpoint.stage, "执行");
    assert_eq!(
        checkpoint.output_revision_id.as_deref(),
        Some("f_readme_r1")
    );
    assert_eq!(checkpoint.output_artifact_version.as_deref(), Some("v1"));

    // 只含 checkpoint 之后的新版本，每文件最新一版
    assert_eq!(resume.delta.len(), 2);
    assert_eq!(resume.delta[0].path, "04-智能体代码/PLAN.md");
    assert_eq!(resume.delta[0].version, "v1");
    assert_eq!(resume.delta[1].path, "04-智能体代码/README.md");
    assert_eq!(resume.delta[1].version, "v2");

    // 每个 decision 取主陈述：dec_1 已确认（新版），dec_2 待确认
    assert_eq!(resume.latest_decisions.len(), 2);
    assert_eq!(resume.latest_decisions[0].decision_id, "dec_1");
    assert_eq!(resume.latest_decisions[0].status, "已确认");
    assert_eq!(resume.latest_decisions[0].priority, "P1");
    assert_eq!(resume.latest_decisions[1].decision_id, "dec_2");
    assert_eq!(resume.latest_decisions[1].priority, "P0");

    assert!(resume
        .prompt_context
        .contains("delta_since_checkpoint count=\"2\""));
    assert!(resume
        .prompt_context
        .contains("[v2] 04-智能体代码/README.md"));
    assert!(resume.prompt_context.contains("[D-01 - 已确认]"));
    assert!(resume
        .prompt_context
        .contains("仅将以上增量变更与最新决策结果注入下一步 Prompt"));
    cleanup_dir(&fixture.dir);
}

#[test]
fn resume_context_without_matching_checkpoint_is_honest() {
    let (fixture, ws_id, store) = setup("resume-empty");
    let resume = resume_context(&store, &ws_id, "init_x", Some("交付")).expect("恢复上下文");
    assert!(resume.checkpoint.is_none());
    assert!(resume.delta.is_empty());
    // 无 checkpoint 仍返回最新决策结果
    assert_eq!(resume.latest_decisions.len(), 2);
    assert!(resume.prompt_context.contains("无可用 SUCCESS checkpoint"));
    cleanup_dir(&fixture.dir);
}

#[test]
fn resume_context_unknown_initiative_is_not_found() {
    let (fixture, ws_id, store) = setup("resume-missing");
    let err = resume_context(&store, &ws_id, "init_missing", None).expect_err("应 404");
    assert_eq!(err.code(), "NOT_FOUND");
    cleanup_dir(&fixture.dir);
}
