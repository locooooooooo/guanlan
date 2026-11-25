//! 对账主流程的端到端测试（写入侧）。
//!
//! 覆盖契约 §5 的历史语义：内容未变不增版本、纯日期不补午夜、A→B→A 三次版本
//! 两份内容、首次扫描只发一条基线卡、范围不完整不判缺失、重复扫描不增事件。

use std::fs;
use std::path::{Path, PathBuf};

use crate::index::{reconcile, ReconcileOptions, Writer};

/// 临时目录（进程号 + 用例名隔离）
struct TempWorkspace {
    root: PathBuf,
    data: PathBuf,
}

impl TempWorkspace {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!("guanlan-index-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("workspace");
        let data = base.join("data");
        fs::create_dir_all(&root).expect("建工作区目录");
        fs::create_dir_all(&data).expect("建数据目录");
        Self { root, data }
    }

    fn root_str(&self) -> String {
        self.root.to_string_lossy().replace('\\', "/")
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("建父目录");
        }
        fs::write(path, content).expect("写文件");
    }

    fn remove(&self, rel: &str) {
        let _ = fs::remove_file(self.root.join(rel));
    }

    fn writer(&self) -> Writer {
        Writer::open_at(&self.data, &self.root_str()).expect("打开写库")
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        if let Some(base) = self.root.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }
}

/// 用固定时刻跑一轮对账（便于断言时间语义）
fn run(writer: &mut Writer, observed_at: &str) -> crate::index::ReconcileReport {
    reconcile(
        writer,
        &ReconcileOptions {
            observed_at: Some(observed_at.to_owned()),
            ..Default::default()
        },
    )
    .expect("对账不应失败")
}

#[test]
fn first_scan_creates_baseline_and_versions() {
    let ws = TempWorkspace::new("baseline");
    ws.write("a.md", "# A\n\n正文 2026-01-02 的材料\n");
    ws.write("docs/b.md", "# B\n");
    ws.write("c.svg", "<svg></svg>");

    let mut writer = ws.writer();
    let report = run(&mut writer, "2026-11-17T00:00:00.000Z");

    assert!(report.initial_baseline, "首次扫描应是基线");
    assert_eq!(report.scanned, 3);
    assert_eq!(report.by_format.md, 2);
    assert_eq!(report.by_format.svg, 1);
    assert_eq!(report.new_files, 3);
    assert_eq!(report.new_revisions, 3);
    assert_eq!(report.snapshots_written, 3);
    // 基线卡一条；正文有自述日期的那份单独入轴（appeared），另一份无日期依据不刷屏
    let events = writer
        .list_events_of_subject(
            &report.workspace_id,
            &report.workspace_id,
            &["workspace_baseline"],
        )
        .expect("查基线事件");
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].headline, "首次纳入 3 份资料",
        "基线卡标题应覆盖全部三份"
    );

    // 版本与文件行都在
    let files = writer
        .list_files(&report.workspace_id, true)
        .expect("查文件");
    assert_eq!(files.len(), 3);
    assert!(files.iter().all(|row| row.status == "active"));
    assert!(files
        .iter()
        .any(|row| row.role == "决策" || row.role == "其他"));
}

#[test]
fn second_scan_is_idempotent() {
    let ws = TempWorkspace::new("idempotent");
    ws.write("a.md", "# A\n");
    ws.write("b.md", "# B\n");

    let mut writer = ws.writer();
    let first = run(&mut writer, "2026-11-17T00:00:00.000Z");
    assert_eq!(first.new_revisions, 2);

    let second = run(&mut writer, "2026-11-17T01:00:00.000Z");
    assert_eq!(second.new_revisions, 0, "内容未变不增版本");
    assert_eq!(second.new_files, 0);
    assert_eq!(second.unchanged, 2);
    assert_eq!(second.events_inserted, 0, "重扫不增事件");
    assert_eq!(second.generation, first.generation, "无变化不推进索引代");
    assert_eq!(
        writer
            .list_events_of_subject(
                &second.workspace_id,
                &second.workspace_id,
                &["workspace_baseline"]
            )
            .expect("查基线事件")
            .len(),
        1,
        "基线卡不重复"
    );
}

#[test]
fn content_change_creates_second_version_and_modified_event() {
    let ws = TempWorkspace::new("modified");
    ws.write("a.md", "# A\n\n## 一\n内容\n");

    let mut writer = ws.writer();
    run(&mut writer, "2026-11-17T00:00:00.000Z");
    ws.write("a.md", "# A\n\n## 一\n内容\n\n## 二\n新增\n");
    let report = run(&mut writer, "2026-11-17T01:00:00.000Z");

    assert_eq!(report.new_revisions, 1);
    assert_eq!(report.content_changed, 1);
    assert_eq!(report.appeared, 0);
    assert_eq!(report.events_inserted, 1, "一条 modified 事件");

    let files = writer
        .list_files(&report.workspace_id, true)
        .expect("查文件");
    let row = files
        .iter()
        .find(|row| row.current_path == "a.md")
        .expect("a.md 在库");
    let revisions = writer.revisions_of_file(&row.file_id).expect("取版本链");
    assert_eq!(revisions.len(), 2, "内容变了要出第二版");
    assert_eq!(revisions[1].seq, 2);
    assert_eq!(
        revisions[1].prev_revision_id.as_deref(),
        Some(revisions[0].revision_id.as_str()),
        "版本链要接上前一版"
    );
}

#[test]
fn missing_file_is_marked_only_when_range_complete() {
    let ws = TempWorkspace::new("missing");
    ws.write("a.md", "# A\n");
    ws.write("b.md", "# B\n");

    let mut writer = ws.writer();
    let first = run(&mut writer, "2026-11-17T00:00:00.000Z");
    assert_eq!(first.missing, 0);

    ws.remove("b.md");
    let second = run(&mut writer, "2026-11-17T01:00:00.000Z");
    assert_eq!(second.missing, 1, "范围完整时判缺失");

    let files = writer
        .list_files(&second.workspace_id, true)
        .expect("查文件");
    let missing = files
        .iter()
        .find(|row| row.current_path == "b.md")
        .expect("b.md 在库");
    assert_eq!(missing.status, "missing");
}

#[test]
fn document_self_date_is_preserved_without_midnight() {
    let ws = TempWorkspace::new("selfdate");
    ws.write("a.md", "---\ndate: 2026-03-04\n---\n\n正文\n");

    let mut writer = ws.writer();
    let report = run(&mut writer, "2026-11-17T00:00:00.000Z");

    let files = writer
        .list_files(&report.workspace_id, true)
        .expect("查文件");
    let row = files
        .iter()
        .find(|row| row.current_path == "a.md")
        .expect("a.md 在库");
    let revision = writer
        .get_revision(row.last_revision_id.as_deref().expect("有版本"))
        .expect("取版本")
        .expect("版本存在");
    assert_eq!(
        revision.occurred_at.as_deref(),
        Some("2026-03-04"),
        "正文自述日期只到天，不补零点"
    );
    assert_eq!(revision.occurred_precision, "day");
    assert_eq!(revision.occurred_source.as_deref(), Some("document_self"));
}

#[test]
fn rename_with_same_hash_is_recovered_not_duplicated() {
    // 语义与 TS 逐字一致（node tsx server/reconcile 实测）：
    // 同哈希认领只在「旧路径已被上一轮判为 missing」之后才发生——
    // 改名与删除同轮发生时，两侧先各自记为「新增」与「缺失」，下一轮才认领。
    let ws = TempWorkspace::new("rename");
    ws.write("old.md", "# 内容\n");

    let mut writer = ws.writer();
    let first = run(&mut writer, "2026-11-17T00:00:00.000Z");
    assert_eq!(first.new_files, 1);

    // 旧路径消失 → 判缺失
    ws.remove("old.md");
    let second = run(&mut writer, "2026-11-17T01:00:00.000Z");
    assert_eq!(second.missing, 1);

    // 同内容出现在新路径 → 按同哈希认领旧身份，不产生第二个身份
    ws.write("new.md", "# 内容\n");
    let third = run(&mut writer, "2026-11-17T02:00:00.000Z");
    assert_eq!(third.new_files, 0, "同哈希不得当成新文件");
    assert_eq!(third.recovered, 1, "按同哈希恢复");
    assert_eq!(third.events_inserted, 1, "一条 read_recovered 事件");
    assert_eq!(
        writer
            .list_files(&third.workspace_id, true)
            .expect("查文件")
            .len(),
        1,
        "不产生第二个身份"
    );

    // 再扫一轮：状态稳定，事件不重复
    let fourth = run(&mut writer, "2026-11-17T03:00:00.000Z");
    assert_eq!(fourth.new_files, 0);
    assert_eq!(fourth.events_inserted, 0, "重扫不增事件");
    assert_eq!(fourth.generation, third.generation, "无变化不推进索引代");
}

/// 供外部用例复用：工作区根路径
#[allow(dead_code)]
fn root_of(workspace: &TempWorkspace) -> &Path {
    &workspace.root
}

// ===== 状态机重算 =====

use crate::index::state_engine::{commit_checkpoint, state_machine_recompute};
use crate::index::state_machine::{initiative_id_of, node_id_of, SlotKind, Stage};
use crate::index::CheckpointInput;

/// 决策阶段文档：P1 卡点块（pending）
const DECISION_PENDING_MD: &str = "\
# 03-待确认事项

[P1 - 待确认] 属性字典与历史更新策略
决定：___
确认人：___
";

/// 决策阶段文档：拍板完成（回写后形态）
const DECISION_RESOLVED_MD: &str = "\
# 03-待确认事项

[P1 - 已确认] 属性字典与历史更新策略
决定：采用两阶段状态锁
确认人：架构组
";

#[test]
fn state_machine_first_scan_creates_rows_silently() {
    let ws = TempWorkspace::new("sm-first");
    ws.write("01-演示专项/需求单.md", "# 需求单\n\n范围与边界\n");
    ws.write("01-演示专项/方案.md", "# 方案\n\n两阶段状态锁设计\n");
    ws.write("01-演示专项/03-待确认事项.md", DECISION_PENDING_MD);

    let mut writer = ws.writer();
    let first = run(&mut writer, "2026-11-17T00:00:00.000Z");

    // 首建静默：有落库行、无迁移事件
    assert!(
        first.state_rows_upserted > 0,
        "首轮应落 initiatives/artifact_states/task_nodes 行"
    );
    assert_eq!(first.state_transitions, 0, "首轮建行不发迁移事件");

    // 一专项 + 3 文档 + 5 槽位
    let workspace_id = &first.workspace_id;
    let initiatives = writer.list_initiatives(workspace_id).expect("查专项");
    assert_eq!(initiatives.len(), 1);
    assert_eq!(initiatives[0].root_dir, "01-演示专项");
    assert_eq!(
        initiatives[0].current_stage, "决策",
        "current_stage 取已归类最靠后阶段"
    );
    assert_eq!(
        initiatives[0].state, "pending_review",
        "专项级 P1 未决 → Draft→PendingReview（首建静默推导）"
    );

    let states = writer
        .list_artifact_states(workspace_id)
        .expect("查文档状态");
    assert_eq!(states.len(), 3);
    let decision_state = states.iter().find(|s| s.stage == "决策").expect("决策文档");
    assert_eq!(
        decision_state.state, "pending_review",
        "文档级 P1 未决 → pending_review"
    );
    assert_eq!(decision_state.pending_p1, 1, "P1 卡点块按 priority 计数");

    let nodes = writer.list_task_nodes(workspace_id).expect("查节点");
    assert_eq!(nodes.len(), 5, "五槽位全部建行");
    let by_stage = |stage: &str| {
        nodes
            .iter()
            .find(|n| n.stage == stage)
            .expect("槽位")
            .clone()
    };
    assert_eq!(
        by_stage("蓝图").state,
        "completed",
        "蓝图槽：有文档有内容 → completed"
    );
    assert_eq!(
        by_stage("计划").state,
        "completed",
        "计划槽：前置蓝图完成+有内容 → completed"
    );
    assert_eq!(
        by_stage("决策").state,
        "suspended_on_hitl",
        "决策槽：P1 未决 → suspended_on_hitl（持久）"
    );
    assert_eq!(
        by_stage("执行").state,
        "queued",
        "执行槽：前置决策未完成 → queued"
    );
    assert_eq!(by_stage("交付").state, "queued");
    // 节点 ID 幂等可对拍 + 依赖链
    let exec = by_stage("执行");
    assert_eq!(
        exec.node_id,
        node_id_of(
            &initiative_id_of("01-演示专项"),
            Stage::Executing,
            SlotKind::Generate
        )
    );
    let decision_node = by_stage("决策");
    assert_eq!(
        decision_node.depends_json,
        format!(
            "[\"{}\"]",
            node_id_of(
                &initiative_id_of("01-演示专项"),
                Stage::Plan,
                SlotKind::Derive
            )
        )
    );

    // 幂等：第二轮重扫，行稳定、无事件、代际不进
    let second = run(&mut writer, "2026-11-17T01:00:00.000Z");
    assert_eq!(second.state_transitions, 0, "重算幂等：同输入无迁移");
    assert_eq!(second.events_inserted, 0, "重扫不增事件");
    assert_eq!(second.generation, first.generation, "无变化不推进代际");
    let nodes_again = writer.list_task_nodes(workspace_id).expect("再查节点");
    assert_eq!(nodes_again.len(), 5);
    assert_eq!(
        by_stage("决策").state,
        "suspended_on_hitl",
        "running/suspended 跨轮持久"
    );
}

#[test]
fn state_machine_transition_events_carry_direction_identity() {
    let ws = TempWorkspace::new("sm-move");
    ws.write("01-演示专项/需求单.md", "# 需求单\n\n范围\n");
    ws.write("01-演示专项/方案.md", "# 方案\n\n设计\n");
    ws.write("01-演示专项/03-待确认事项.md", DECISION_PENDING_MD);

    let mut writer = ws.writer();
    let first = run(&mut writer, "2026-11-17T00:00:00.000Z");
    assert_eq!(first.state_transitions, 0);

    // 拍板完成 → 新版本：文档 pending_review→approved_revision→executing？
    // task_running 此刻仍 false（执行槽 queued），两级迁移到 approved_revision 为止
    ws.write("01-演示专项/03-待确认事项.md", DECISION_RESOLVED_MD);
    let second = run(&mut writer, "2026-11-17T02:00:00.000Z");

    // 回归锁：多级迁移每单步一条、身份互异（subject_id 编码 from→to）
    assert!(
        second.state_transitions >= 3,
        "文档 + 节点 + 专项三条迁移：{}",
        second.state_transitions
    );
    let workspace_id = second.workspace_id.clone();
    let states = writer.list_artifact_states(&workspace_id).expect("查状态");
    let decision_state = states.iter().find(|s| s.stage == "决策").expect("决策文档");
    assert_eq!(
        decision_state.state, "approved_revision",
        "未决清零+有版本 → approved_revision"
    );

    // 文档级迁移事件
    let artifact_events = writer
        .list_events_of_subject(
            &workspace_id,
            &format!(
                "{}:pending_review->approved_revision",
                decision_state.file_id
            ),
            &["state_changed"],
        )
        .expect("查文档迁移事件");
    assert_eq!(
        artifact_events.len(),
        1,
        "pending_review→approved_revision 恰一条"
    );
    // 节点迁移事件（suspended_on_hitl→completed）
    let decision_node = writer
        .find_task_node_by_stage(&workspace_id, &initiative_id_of("01-演示专项"), "决策")
        .expect("查节点")
        .expect("决策槽已建");
    let node_events = writer
        .list_events_of_subject(
            &workspace_id,
            &format!("{}:suspended_on_hitl->completed", decision_node.node_id),
            &["task_node_moved"],
        )
        .expect("查节点迁移事件");
    assert_eq!(node_events.len(), 1);
    assert_eq!(node_events[0].kind, "task_node_moved");

    // 第三轮：无变化 → 无事件、代际稳定
    let third = run(&mut writer, "2026-11-17T03:00:00.000Z");
    assert_eq!(third.state_transitions, 0);
    assert_eq!(third.events_inserted, 0);
    assert_eq!(third.generation, second.generation, "无变化不推进代际");
}

#[test]
fn checkpoint_commit_advances_generate_slot_without_node_id() {
    // POST /checkpoints 不带 node_id 时按 (initiative_id, stage) 反查推进执行槽；
    // seq 由库内派生；验证完整流转：suspended → 拍板 → 唤醒 → checkpoint → completed
    let ws = TempWorkspace::new("sm-ckpt");
    ws.write("01-演示专项/需求单.md", "# 需求单\n\n范围\n");
    ws.write("01-演示专项/方案.md", "# 方案\n\n设计\n");
    ws.write("01-演示专项/03-待确认事项.md", DECISION_PENDING_MD);
    ws.write("01-演示专项/联调记录.md", "# 联调记录\n\n- [ ] 联调项 A\n");

    let mut writer = ws.writer();
    run(&mut writer, "2026-11-17T00:00:00.000Z");
    let workspace_id = writer.workspace().expect("ws").workspace_id;
    let initiative_id = initiative_id_of("01-演示专项");

    // 拍板 → 决策槽 completed → 执行槽（有 artifact 无 checkpoint）→ running
    ws.write("01-演示专项/03-待确认事项.md", DECISION_RESOLVED_MD);
    let second = run(&mut writer, "2026-11-17T02:00:00.000Z");
    let _ = second;
    let exec_node = writer
        .find_task_node_by_stage(&workspace_id, &initiative_id, "执行")
        .expect("查执行槽")
        .expect("执行槽已建");
    assert_eq!(
        exec_node.state, "running",
        "决策清零后执行槽 running（task_running=true）"
    );

    // 文档级 approved_revision→executing（task_running 唤醒）
    let states = writer.list_artifact_states(&workspace_id).expect("查状态");
    let decision_state = states.iter().find(|s| s.stage == "决策").expect("决策文档");
    assert_eq!(
        decision_state.state, "executing",
        "多级迁移：pending_review→approved→executing"
    );

    // checkpoint 提交（node_id 缺省时按阶段反查；先验未知专项 404）
    let bad = CheckpointInput {
        node_id: None,
        workspace_id: workspace_id.clone(),
        initiative_id: "init_不存在".to_owned(),
        stage: "执行".to_owned(),
        status: "SUCCESS".to_owned(),
        input_context_hash: "a".repeat(64),
        output_revision_id: None,
        token_usage: None,
        elapsed_ms: None,
        note: None,
        created_at: "2026-11-17T04:00:00.000Z".to_owned(),
    };
    writer
        .transaction(|writer| commit_checkpoint(writer, &bad))
        .expect_err("未知专项应 404");

    let good = CheckpointInput {
        node_id: None,
        workspace_id: workspace_id.clone(),
        initiative_id: initiative_id.clone(),
        stage: "执行".to_owned(),
        status: "SUCCESS".to_owned(),
        input_context_hash: "b".repeat(64),
        output_revision_id: None,
        token_usage: Some(2048),
        elapsed_ms: Some(12_000),
        note: Some("执行完成".to_owned()),
        created_at: "2026-11-17T04:00:00.000Z".to_owned(),
    };
    let outcome = writer
        .transaction(|writer| commit_checkpoint(writer, &good))
        .expect("受理成功");
    assert!(!outcome.checkpoint_id.is_empty());
    assert_eq!(
        outcome.node_state.as_deref(),
        Some("completed"),
        "SUCCESS 推进执行槽 → completed（同事务）"
    );

    // 节点推进 + checkpoint_committed 事件 + 恢复查询
    let exec_after = writer
        .get_task_node(&exec_node.node_id)
        .expect("查节点")
        .expect("节点存在");
    assert_eq!(exec_after.state, "completed");
    assert_eq!(
        exec_after.latest_checkpoint_id.as_deref(),
        Some(outcome.checkpoint_id.as_str()),
        "latest_checkpoint_id 应指向本次 SUCCESS"
    );
    let ckpt_events = writer
        .list_events_of_subject(
            &workspace_id,
            &outcome.checkpoint_id,
            &["checkpoint_committed"],
        )
        .expect("查 checkpoint 事件");
    assert_eq!(ckpt_events.len(), 1);
    let recovered = writer
        .latest_success_checkpoint(&workspace_id, &initiative_id, "执行", None)
        .expect("查恢复")
        .expect("最近一次 SUCCESS");
    assert_eq!(recovered.checkpoint_id, outcome.checkpoint_id);
    assert!(
        recovered.node_id.is_none(),
        "载荷不含 node_id（按阶段反查槽位通道）"
    );
}

#[test]
fn state_machine_recompute_direct_entry_is_idempotent() {
    // 直接入口（service DecisionWriteback/adopt 后调用同一重算）：幂等可重复
    let ws = TempWorkspace::new("sm-direct");
    ws.write("01-演示专项/方案.md", "# 方案\n\n设计\n");
    let mut writer = ws.writer();
    run(&mut writer, "2026-11-17T00:00:00.000Z");
    let workspace_id = writer.workspace().expect("ws").workspace_id;

    let first =
        state_machine_recompute(&mut writer, &workspace_id, "2026-11-17T05:00:00.000Z", &[])
            .expect("重算");
    let second =
        state_machine_recompute(&mut writer, &workspace_id, "2026-11-17T05:00:00.000Z", &[])
            .expect("重算");
    assert_eq!(first.initiatives_upserted, second.initiatives_upserted);
    assert_eq!(first.artifacts_upserted, second.artifacts_upserted);
    assert_eq!(first.nodes_upserted, second.nodes_upserted);
    assert_eq!(first.transitions.len(), 0, "重复重算无新迁移");
    assert_eq!(second.transitions.len(), 0);
}

#[test]
fn b01_mixed_formats_gitignore_and_tiered_snapshot_policy() {
    let ws = TempWorkspace::new("b01-tiered");
    // .gitignore 规则 + 目录黑名单
    ws.write(".gitignore", "*.log\nbuild/\n!important.log\n");
    ws.write("sub/.gitignore", "*.tmp\n");
    ws.write("debug.log", "ignored log\n");
    ws.write("important.log", "kept log\n");
    ws.write("build/out.js", "console.log('ignored');\n");
    ws.write("sub/scratch.tmp", "ignored tmp\n");
    ws.write("node_modules/pkg/index.js", "ignored dep\n");
    ws.write("target/debug/app.exe", "ignored build\n");

    // 各类文件：文本、源码、图片、办公、音视频、未知二进制
    ws.write("docs/spec.md", "# 规范\n\n正文\n");
    ws.write("src/app.ts", "export const ok = true;\n");
    ws.write("Makefile", "all:\n\techo hi\n");
    // 二进制样板
    fs::create_dir_all(ws.root.join("assets")).expect("建目录");
    fs::write(
        ws.root.join("assets/photo.png"),
        b"\x89PNG\r\n\x1a\npngdata",
    )
    .expect("写 png");
    fs::write(ws.root.join("assets/contract.docx"), b"PK\x03\x04docx").expect("写 docx");
    fs::write(ws.root.join("assets/clip.mp4"), vec![0xAAu8; 4096]).expect("写 mp4");
    fs::write(ws.root.join("assets/raw.bin"), vec![0xBBu8; 2048]).expect("写 bin");
    // 超过文本阈值（测自定义策略 text_max=100B, binary_max=500B）的大文本与大图片
    ws.write("docs/large.txt", &"x".repeat(256));
    fs::write(ws.root.join("assets/huge.png"), vec![0x89u8; 1024]).expect("写大 png");

    let mut writer = ws.writer();
    let policy = crate::index::SnapshotPolicy {
        text_max_bytes: 100,
        binary_max_bytes: 500,
    };
    let report = reconcile(
        &mut writer,
        &ReconcileOptions {
            observed_at: Some("2026-11-19T08:00:00.000Z".to_owned()),
            snapshot_policy: Some(policy),
            ..Default::default()
        },
    )
    .expect("全文件类型分级对账");

    assert!(report.ignored_paths >= 3, "应排除 .gitignore 命中的路径");
    let files = writer
        .list_files(&report.workspace_id, true)
        .expect("列文件");
    let mut paths: Vec<&str> = files.iter().map(|f| f.current_path.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        vec![
            ".gitignore",
            "Makefile",
            "assets/clip.mp4",
            "assets/contract.docx",
            "assets/huge.png",
            "assets/photo.png",
            "assets/raw.bin",
            "docs/large.txt",
            "docs/spec.md",
            "important.log",
            "src/app.ts",
            "sub/.gitignore",
        ]
    );

    // 验证各文件格式与三档快照可用性
    let check_rev = |rel: &str, expected_fmt: &str, expected_avail: i64| {
        let row = files.iter().find(|f| f.current_path == rel).expect(rel);
        assert_eq!(row.format, expected_fmt, "format mismatch for {rel}");
        let rev = writer
            .latest_revision(&row.file_id)
            .expect("rev")
            .expect("has rev");
        assert_eq!(
            rev.snapshot_available, expected_avail,
            "snapshot_available mismatch for {rel}"
        );
        if expected_avail == 1 {
            assert!(
                writer.read_snapshot(&rev.content_hash).is_some(),
                "{rel} 应落盘快照"
            );
        } else {
            assert!(
                writer.read_snapshot(&rev.content_hash).is_none(),
                "{rel} 绝不复制快照字节"
            );
        }
        rev
    };

    check_rev("docs/spec.md", "md", 1);
    check_rev("src/app.ts", "ts", 1);
    check_rev("Makefile", "make", 1);
    check_rev("assets/photo.png", "png", 1);
    check_rev("assets/contract.docx", "docx", 1);
    check_rev("docs/large.txt", "txt", 0);
    check_rev("assets/huge.png", "png", 0);
    let mp4_v1 = check_rev("assets/clip.mp4", "mp4", 0);
    check_rev("assets/raw.bin", "bin", 0);

    // 音视频修改：生成 v2 仅元数据版本，绝不崩溃、绝不复制快照，事件如实记入
    fs::write(ws.root.join("assets/clip.mp4"), vec![0xCCu8; 4096]).expect("修改 mp4");
    let second = reconcile(
        &mut writer,
        &ReconcileOptions {
            observed_at: Some("2026-11-19T09:00:00.000Z".to_owned()),
            snapshot_policy: Some(policy),
            ..Default::default()
        },
    )
    .expect("mp4 修改重扫");
    assert_eq!(second.new_revisions, 1);
    assert_eq!(second.metadata_only_revisions, 1);
    assert_eq!(second.snapshots_written, 0);
    let mp4_row = files
        .iter()
        .find(|f| f.current_path == "assets/clip.mp4")
        .unwrap();
    let mp4_revs = writer.revisions_of_file(&mp4_row.file_id).unwrap();
    assert_eq!(mp4_revs.len(), 2);
    assert_ne!(mp4_revs[0].content_hash, mp4_revs[1].content_hash);
    assert_eq!(mp4_revs[0].revision_id, mp4_v1.revision_id);
    assert_eq!(mp4_revs[1].snapshot_available, 0);

    // 工作区级持久化配额阈值（meta 读写往返）
    let updated = writer.set_snapshot_policy(32, 128).expect("持久化配额阈值");
    assert_eq!(updated.text_max_bytes, 32 * 1024 * 1024);
    assert_eq!(updated.binary_max_bytes, 128 * 1024 * 1024);
    assert_eq!(writer.snapshot_policy(), updated);
}

#[test]
fn b01_five_thousand_mixed_formats_100_percent_visible_coverage_and_zero_ignored() {
    let ws = TempWorkspace::new("b01-5000");
    ws.write(".gitignore", "*.tmp\nignored_dir/\n");
    ws.write("node_modules/pkg/index.js", "ignored dep");
    ws.write("ignored_dir/secret.txt", "ignored by gitignore");
    ws.write("scratch.tmp", "ignored tmp");

    let exts = [
        "md", "ts", "rs", "png", "docx", "xlsx", "pdf", "zip", "mp4", "bin",
    ];
    let total_visible = 5050usize;
    for i in 0..total_visible {
        let ext = exts[i % exts.len()];
        let bucket = i / 500;
        let rel = format!("b_{bucket:02}/f_{i:04}.{ext}");
        let full = ws.root.join(&rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("建分桶目录");
        }
        let body = match ext {
            "md" => format!("# Doc {i}\n"),
            "mp4" | "bin" => format!("bin-{i}"),
            _ => format!("payload-{i}"),
        };
        fs::write(&full, body.as_bytes()).expect("写测试文件");
    }

    let mut writer = ws.writer();
    let report = reconcile(&mut writer, &ReconcileOptions::default()).expect("5050 文件对账");
    // 5050 + 1 个根目录 .gitignore = 5051 份非忽略可见文件，100% 纳入且不被旧 5000 上限截断
    assert_eq!(report.scanned, total_visible + 1);
    assert_eq!(report.new_files, total_visible + 1);
    // 每 10 份有 2 份（mp4 + bin）恒走 L0 仅元数据（505 * 2 = 1010）
    assert_eq!(report.metadata_only_revisions, (total_visible / 10) * 2);

    let files = writer
        .list_files(&report.workspace_id, true)
        .expect("列文件");
    assert_eq!(files.len(), total_visible + 1);
    assert!(!files
        .iter()
        .any(|f| f.current_path.contains("node_modules")));
    assert!(!files.iter().any(|f| f.current_path.contains("ignored_dir")));
    assert!(!files.iter().any(|f| f.current_path.ends_with(".tmp")));
}

#[test]
fn b03_reconcile_indexes_docx_and_xlsx_links_decisions_and_caches_by_hash() {
    use crate::index::office::tests::build_test_zip;
    use crate::query::{decisions as query_decisions, list_files, revision_office, FileListQuery};
    use crate::storage::ReadonlyStore;

    let ws = TempWorkspace::new("b03-office");

    // 1) 真实构造 .xlsx 多工作表工作簿（含公式、数值列统计区间）
    let wb = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="BOM" sheetId="1" r:id="rId1"/>
    <sheet name="Summary" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"#
        .as_bytes();
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#
        .as_bytes();
    let sst = r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Part</t></si>
  <si><t>Qty</t></si>
  <si><t>UnitPrice</t></si>
  <si><t>MCU-A</t></si>
  <si><t>Regulator-B</t></si>
</sst>"#
        .as_bytes();
    let s1 = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>4</v></c><c r="C2"><v>18.5</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>8</v></c><c r="C3"><f>B3*2</f><v>16</v></c></row>
  </sheetData>
</worksheet>"#
        .as_bytes();
    let s2 = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Reviewed</t></is></c></row></sheetData>
</worksheet>"#
        .as_bytes();
    let xlsx_bytes = build_test_zip(&[
        ("xl/workbook.xml", wb),
        ("xl/_rels/workbook.xml.rels", rels),
        ("xl/sharedStrings.xml", sst),
        ("xl/worksheets/sheet1.xml", s1),
        ("xl/worksheets/sheet2.xml", s2),
    ]);

    // 2) 真实构造 .docx 文档 + 损坏的 .docx 文档
    let doc_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>架构评审结论</w:t></w:r></w:p>
    <w:p><w:r><w:t>[P1 - 待确认] 电源冗余设计是否保留双路？</w:t></w:r></w:p>
  </w:body>
</w:document>"#
        .as_bytes();
    let docx_bytes = build_test_zip(&[("word/document.xml", doc_xml)]);

    let xlsx_path = ws.root.join("specs/bom.xlsx");
    let docx_path = ws.root.join("specs/arch.docx");
    let bad_path = ws.root.join("specs/corrupted.docx");
    fs::create_dir_all(xlsx_path.parent().unwrap()).unwrap();
    fs::write(&xlsx_path, &xlsx_bytes).unwrap();
    fs::write(&docx_path, &docx_bytes).unwrap();
    fs::write(&bad_path, b"not-a-valid-zip-docx").unwrap();

    // 3) Markdown 决策显式链接到 BOM 工作簿单元格范围 `#BOM!C2:C3`
    ws.write(
        "decisions/bom-check.md",
        "[P0 - 待确认] MCU 单价核定是否按新版报价执行？\n依据：[BOM 核价表](../specs/bom.xlsx#BOM!C2:C3)\n待确认\n",
    );

    let mut writer = ws.writer();
    let r1 = reconcile(&mut writer, &ReconcileOptions::default()).expect("首次对账 Office");
    assert_eq!(r1.new_files, 4);

    // 拷贝一份相同 .xlsx 到另一个路径，验证同哈希 L2 提取幂等复用
    fs::write(ws.root.join("specs/bom-copy.xlsx"), &xlsx_bytes).unwrap();
    let r2 = reconcile(&mut writer, &ReconcileOptions::default()).expect("复用同哈希缓存");
    assert_eq!(r2.new_files, 1);

    let store = ReadonlyStore::open_at(&ws.data, &ws.root_str()).expect("打开只读库");
    let files_page = list_files(&store, &FileListQuery::default()).expect("列出文件");
    let bom_file = files_page
        .items
        .iter()
        .find(|f| f.relative_path == "specs/bom.xlsx")
        .unwrap();
    let docx_file = files_page
        .items
        .iter()
        .find(|f| f.relative_path == "specs/arch.docx")
        .unwrap();
    let bad_file = files_page
        .items
        .iter()
        .find(|f| f.relative_path == "specs/corrupted.docx")
        .unwrap();
    assert_eq!(bom_file.coverage, "office_structured");
    assert_eq!(docx_file.coverage, "office_structured");
    assert_eq!(bad_file.coverage, "filename_only");

    let bom_rev = writer.latest_revision(&bom_file.file_id).unwrap().unwrap();
    let office_bom = revision_office(&store, &bom_rev.revision_id).expect("读取 XLSX L2");
    assert_eq!(office_bom.status, "indexed");
    let sheet = &office_bom.xlsx.unwrap().sheets[0];
    assert_eq!(sheet.name, "BOM");
    assert_eq!(sheet.numeric_summaries[1].cell_range, "C2:C3");
    assert_eq!(sheet.numeric_summaries[1].sum, 34.5);

    let bad_rev = writer.latest_revision(&bad_file.file_id).unwrap().unwrap();
    let office_bad = revision_office(&store, &bad_rev.revision_id).expect("读取损坏 DOCX 降级结果");
    assert_eq!(office_bad.status, "corrupted");

    // 校验 decisions：既包含 .docx 内嵌决策，也包含 Markdown -> .xlsx#BOM!C2:C3 关联锚点
    let dec_resp =
        query_decisions(&store, &crate::query::DecisionsQuery::default()).expect("查决定");
    let bom_dec = dec_resp
        .items
        .iter()
        .find(|d| d.question.contains("MCU 单价核定"))
        .expect("找到 Markdown -> BOM 决策");
    let linked_ev = bom_dec
        .evidences
        .iter()
        .find(|e| e.relative_path == "specs/bom.xlsx")
        .expect("应产出指向 specs/bom.xlsx 的证据锚点");
    let anchor = linked_ev.office_anchor.as_ref().expect("带 officeAnchor");
    assert_eq!(anchor.kind, "xlsx_range");
    assert_eq!(anchor.sheet.as_deref(), Some("BOM"));
    assert_eq!(anchor.cell_range.as_deref(), Some("C2:C3"));

    let docx_dec = dec_resp
        .items
        .iter()
        .find(|d| d.question.contains("电源冗余设计"))
        .expect("找到 DOCX 内嵌决策");
    let docx_anchor = docx_dec.evidences[0].office_anchor.as_ref().unwrap();
    assert_eq!(docx_anchor.kind, "docx_paragraph");
    assert_eq!(docx_anchor.paragraph, Some(2));
}

#[test]
fn reconcile_aborts_cleanly_on_cancel_without_partial_writes() {
    let dir = TempWorkspace::new("reconcile-cancel");
    dir.write("notes/a.md", "# A\n");
    dir.write("media/video.mp4", &"x".repeat(256 * 1024));

    let mut writer = dir.writer();
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let err = reconcile(
        &mut writer,
        &ReconcileOptions {
            cancel: Some(cancel),
            ..Default::default()
        },
    )
    .expect_err("取消标志置位后对账应返回 Cancelled");
    assert!(
        matches!(err, crate::error::GuanlanError::Cancelled(_)),
        "预期 GuanlanError::Cancelled，实际：{err:?}"
    );
    let ws = writer.workspace().expect("工作区行");
    assert!(
        writer
            .list_files(&ws.workspace_id, true)
            .expect("查文件")
            .is_empty(),
        "事务提交前取消不得留下半成品文件行"
    );
    assert_eq!(ws.index_generation, 0, "取消的对账不得推进代际");
}

#[test]
fn missing_detection_lookup_is_indexed_at_workspace_scale() {
    // 缺失检测对「已入库文件数」次判定；线性扫描在 8 万文件上是数十亿次比较，
    // 而这段判定在写事务里执行。这里用 8 万条已见路径/身份压一次查找，
    // 2 秒上限是给 debug 构建与慢机器的余量（集合判定实际在毫秒级）。
    const N: usize = 80_000;
    let paths: Vec<String> = (0..N)
        .map(|index| format!("资料/{:03}/文档-{index:05}.md", index % 500))
        .collect();
    let ids: Vec<String> = (0..N).map(|index| format!("file_{index:05}")).collect();
    let seen = crate::index::SeenFiles::new(paths.iter().cloned(), ids.iter().cloned());

    let started = std::time::Instant::now();
    let mut hits = 0usize;
    for index in 0..N {
        if seen.contains(&paths[index], &ids[index]) {
            hits += 1;
        }
    }
    let elapsed = started.elapsed();

    assert_eq!(hits, N, "已见路径与已见身份都应命中");
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "8 万次缺失判定耗时 {elapsed:?}：判定必须是集合查找，退回线性扫描会把这轮写事务拖死"
    );
}
