use std::path::PathBuf;
use std::process::Command;

use super::*;

fn base_policy_task(id: &str) -> PolicyTaskInput {
    PolicyTaskInput {
        id: id.to_owned(),
        lane: Some("delegate".to_owned()),
        workspace: "H:/x".to_owned(),
        acceptance: vec!["验收".to_owned()],
        ..Default::default()
    }
}

// ── 1. 四车道可解释分流（1:1 承接 test/workflow-triage.test.js） ──────────────

#[test]
fn triage_keyword_priority_login_beats_delegate_and_decide() {
    let res = classify_workflow_item(&ClassificationInput {
        text: Some("登录后台后检查并修复发布配置"),
        ..Default::default()
    });
    assert_eq!(res.lane, TriageLane::Login);
    assert!(!res.explicit);
    assert!(res.reason.contains("登录"));
    assert!(res.matched.iter().any(|w| w == "登录"));
    assert!(res.matched.iter().any(|w| w == "后台"));
}

#[test]
fn triage_explicit_lane_overrides_keywords_and_supports_all_12_aliases() {
    let res = classify_workflow_item(&ClassificationInput {
        text: Some("登录账号并提交方案"),
        workflow: Some("decide"),
        ..Default::default()
    });
    assert_eq!(res.lane, TriageLane::Decide);
    assert_eq!(res.reason, "来源明确指定分栏");
    assert!(res.explicit);
    assert!(res.matched.is_empty());

    let cases = [
        ("inform", TriageLane::Inform),
        ("knowledge", TriageLane::Inform),
        ("朕要知道", TriageLane::Inform),
        ("login", TriageLane::Login),
        ("auth", TriageLane::Login),
        ("需要登录", TriageLane::Login),
        ("decide", TriageLane::Decide),
        ("decision", TriageLane::Decide),
        ("等我决策", TriageLane::Decide),
        ("delegate", TriageLane::Delegate),
        ("agent", TriageLane::Delegate),
        ("可交给 Agent", TriageLane::Delegate),
    ];
    for (alias, expected) in cases {
        assert_eq!(
            explicit_lane(Some(alias), None, None, None),
            Some(expected),
            "别名解析失配：{alias}"
        );
    }
    assert_eq!(explicit_lane(Some("unknown-lane"), None, None, None), None);
}

#[test]
fn triage_frontmatter_workflow_and_meta_extraction_full_fidelity() {
    let content = [
        "---",
        "workflow: decide",
        "account: 商城后台",
        "login-url: https://example.com/login",
        "question: 是否发布新价格",
        "options: [立即发布, 延后一周]",
        "impact: 会影响本周销售节奏",
        "acknowledgement: 已知悉价格调整风险",
        "---",
        "",
        "# 价格方案",
        "",
        "```markdown",
        "- [ ] 代码块内的示例勾选项绝不能被抽取",
        "TODO: 代码块内 TODO 也不得抽取",
        "```",
        "",
        "- [ ] 请确认是否发布",
        "- [x] 已完成旧价格复盘",
        "- [-] 已取消条目不入列表",
        "- [>] 已推迟条目不入列表",
        "TODO: 补齐回滚预案",
        "",
    ]
    .join("\n");

    let parsed = parse_markdown_for_triage("D:/notes/decision.md", &content, 100);
    assert_eq!(parsed.workflow.as_deref(), Some("decide"));
    assert_eq!(parsed.title, "价格方案");
    assert_eq!(parsed.workflow_meta.account, "商城后台");
    assert_eq!(parsed.workflow_meta.login_url, "https://example.com/login");
    assert_eq!(parsed.workflow_meta.question, "是否发布新价格");
    assert_eq!(
        parsed.workflow_meta.options,
        vec!["立即发布".to_owned(), "延后一周".to_owned()]
    );
    assert_eq!(parsed.workflow_meta.impact, "会影响本周销售节奏");
    assert_eq!(parsed.workflow_meta.acknowledgement, "已知悉价格调整风险");
    // 代码块内与 [-]/[>] 全部被正确跳过：只剩第 18/19/22 行 3 条
    assert_eq!(parsed.tasks.len(), 3);
    assert_eq!(parsed.tasks[0].line, 18);
    assert_eq!(parsed.tasks[1].line, 19);
    assert!(parsed.tasks[1].completed);
    assert_eq!(parsed.tasks[2].line, 22);
    assert_eq!(parsed.tasks[2].syntax, TaskSyntax::Todo);

    let index = build_workflow_index(&[parsed]);
    assert_eq!(index.items.len(), 2);
    for item in &index.items {
        assert_eq!(item.lane, TriageLane::Decide);
        assert_eq!(item.reason, "来源明确指定分栏");
    }
    let checkbox_item = index
        .items
        .iter()
        .find(|i| i.source.line == 18)
        .expect("line 18 item");
    assert_eq!(checkbox_item.source.expected_text, "- [ ] 请确认是否发布");
    let todo_item = index
        .items
        .iter()
        .find(|i| i.source.line == 22)
        .expect("line 22 item");
    assert_eq!(todo_item.source.expected_text, "TODO: 补齐回滚预案");
}

#[test]
fn triage_document_without_tasks_defaults_to_inform_line_0() {
    let index = triage_markdown_documents(&[MarkdownDocInput {
        path: "D:/notes/report.md",
        content: "# 周报摘要\n\n本周全部按期交付。\n",
        modified_at: 10,
    }]);
    assert_eq!(index.items.len(), 1);
    assert_eq!(index.items[0].lane, TriageLane::Inform);
    assert_eq!(index.items[0].source.line, 0);
    assert_eq!(index.counts.get(&TriageLane::Inform), Some(&1));
}

#[test]
fn triage_b03_human_readiness_hints_and_completeness() {
    assert!(human_field_requirements(TriageLane::Login)
        .iter()
        .any(|r| r.field == "question" && r.severity == HumanFieldSeverity::Block));
    assert!(human_field_requirements(TriageLane::Decide)
        .iter()
        .any(|r| r.field == "options" && r.severity == HumanFieldSeverity::Block));
    assert!(human_field_requirements(TriageLane::Inform)
        .iter()
        .any(|r| r.field == "acknowledgement" && r.severity == HumanFieldSeverity::Block));
    assert!(human_field_requirements(TriageLane::Delegate).is_empty());

    let partial_decide = WorkflowMeta {
        question: "选 A 还是 B？".to_owned(),
        options: vec!["A".to_owned(), "B".to_owned()],
        ..Default::default()
    };
    let hints = human_readiness_hints(TriageLane::Decide, &partial_decide);
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].field, "impact");
    assert_eq!(hints[0].severity, HumanFieldSeverity::Warn);
    assert_eq!(hints[0].hint, "缺少影响说明");

    let full_decide = WorkflowMeta {
        impact: "影响发布".to_owned(),
        ..partial_decide
    };
    assert!(human_readiness_hints(TriageLane::Decide, &full_decide).is_empty());
    assert!(human_readiness_hints(TriageLane::Delegate, &WorkflowMeta::default()).is_empty());

    let missing_options = WorkflowMeta {
        question: "选谁？".to_owned(),
        ..Default::default()
    };
    let report = check_human_lane_completeness(&[(TriageLane::Decide, &missing_options)]);
    assert!(!report.ok);
    assert!(report.blocks.iter().any(|b| b.field == "options"));
}

#[test]
fn triage_e7_template_placeholder_filter_and_acceptance_folding() {
    assert!(!is_template_placeholder_line("请批复：是否同意发布"));
    assert!(is_template_placeholder_line("ARCH、PO 同意（签名／日期）"));
    assert!(is_template_placeholder_line("签字：____________"));
    assert!(!is_template_placeholder_line("修复登录超时"));

    let contract_file = TriageFileInput {
        path: "D:/notes/contract.md".to_owned(),
        name: "contract.md".to_owned(),
        title: "合同会签".to_owned(),
        modified_at: 10,
        tasks: vec![
            TriageTaskInput {
                id: "t1".to_owned(),
                path: "D:/notes/contract.md".to_owned(),
                line: 3,
                text: "ARCH、PO 同意（签名／日期）".to_owned(),
                raw_text: "- [ ] ARCH、PO 同意（签名／日期）".to_owned(),
                syntax: TaskSyntax::Checkbox,
                ..Default::default()
            },
            TriageTaskInput {
                id: "t2".to_owned(),
                path: "D:/notes/contract.md".to_owned(),
                line: 4,
                text: "签名：______ 日期：______".to_owned(),
                raw_text: "- [ ] 签名：______ 日期：______".to_owned(),
                syntax: TaskSyntax::Checkbox,
                ..Default::default()
            },
            TriageTaskInput {
                id: "t3".to_owned(),
                path: "D:/notes/contract.md".to_owned(),
                line: 5,
                text: "整理会签意见并归档".to_owned(),
                raw_text: "- [ ] 整理会签意见并归档".to_owned(),
                syntax: TaskSyntax::Checkbox,
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let contract_idx = build_workflow_index(&[contract_file]);
    assert_eq!(contract_idx.filtered.template, 2);
    assert_eq!(contract_idx.filtered.total, 2);
    assert_eq!(contract_idx.items.len(), 1);
    assert_eq!(contract_idx.items[0].title, "整理会签意见并归档");

    // 缩进验收子项 + 顶层 30 行内验收 + 超 30 行不误吞 + 完成父任务挂靠
    let fold_file = TriageFileInput {
        path: "D:/notes/fix.md".to_owned(),
        name: "fix.md".to_owned(),
        title: "修复清单".to_owned(),
        modified_at: 10,
        tasks: vec![
            TriageTaskInput {
                id: "p".to_owned(),
                path: "D:/notes/fix.md".to_owned(),
                line: 3,
                text: "修复导出功能".to_owned(),
                raw_text: "- [ ] 修复导出功能".to_owned(),
                syntax: TaskSyntax::Checkbox,
                indent: 0,
                ..Default::default()
            },
            TriageTaskInput {
                id: "a1".to_owned(),
                path: "D:/notes/fix.md".to_owned(),
                line: 4,
                text: "验收：导出包含全部字段".to_owned(),
                raw_text: "  - [ ] 验收：导出包含全部字段".to_owned(),
                syntax: TaskSyntax::Checkbox,
                indent: 2,
                ..Default::default()
            },
            TriageTaskInput {
                id: "a2".to_owned(),
                path: "D:/notes/fix.md".to_owned(),
                line: 8,
                text: "验收：10MB 文件 5 秒内完成".to_owned(),
                raw_text: "- [ ] 验收：10MB 文件 5 秒内完成".to_owned(),
                syntax: TaskSyntax::Checkbox,
                indent: 0,
                ..Default::default()
            },
            TriageTaskInput {
                id: "done".to_owned(),
                path: "D:/notes/fix.md".to_owned(),
                line: 12,
                text: "主体改造已完成".to_owned(),
                raw_text: "- [x] 主体改造已完成".to_owned(),
                completed: true,
                syntax: TaskSyntax::Checkbox,
                indent: 0,
                ..Default::default()
            },
            TriageTaskInput {
                id: "done_child".to_owned(),
                path: "D:/notes/fix.md".to_owned(),
                line: 13,
                text: "验收：回归通过".to_owned(),
                raw_text: "  - [ ] 验收：回归通过".to_owned(),
                syntax: TaskSyntax::Checkbox,
                indent: 2,
                ..Default::default()
            },
            TriageTaskInput {
                id: "late".to_owned(),
                path: "D:/notes/fix.md".to_owned(),
                line: 50,
                text: "验收：超 30 行后独立条目".to_owned(),
                raw_text: "- [ ] 验收：超 30 行后独立条目".to_owned(),
                syntax: TaskSyntax::Checkbox,
                indent: 0,
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let fold_idx = build_workflow_index(&[fold_file]);
    assert_eq!(fold_idx.items.len(), 2);
    assert_eq!(fold_idx.filtered.acceptance, 3);
    let main_item = fold_idx
        .items
        .iter()
        .find(|i| i.id == "workflow-p")
        .expect("workflow-p");
    assert_eq!(
        main_item.acceptance_criteria,
        vec![
            "验收：导出包含全部字段".to_owned(),
            "验收：10MB 文件 5 秒内完成".to_owned()
        ]
    );
    assert_eq!(
        fold_idx
            .filtered
            .items
            .iter()
            .find(|f| f.id == "done_child")
            .and_then(|f| f.merged_into.as_deref()),
        Some("done")
    );
}

// ── 2. 高风险识别、显式授权与五道安全闸 fail-closed（1:1 承接 workflow-policy） ──

#[test]
fn policy_b04_and_d03_risk_matrix_zh_en_coverage_and_zero_false_positives() {
    let defs = risk_action_definitions();
    assert_eq!(
        defs.iter().map(|d| d.kind).collect::<Vec<_>>(),
        vec![
            RiskKind::Publish,
            RiskKind::Payment,
            RiskKind::Deletion,
            RiskKind::ExternalAuth,
            RiskKind::Account,
            RiskKind::IrreversibleWrite,
        ]
    );

    let zh_cases = [
        ("pub", "deploy 到生产环境并发布上线", RiskKind::Publish),
        ("pay", "调用支付接口完成付款", RiskKind::Payment),
        (
            "del",
            "rm -rf 清理旧产物；删除文件前先备份",
            RiskKind::Deletion,
        ),
        ("auth", "使用 OAuth 授权第三方登录", RiskKind::ExternalAuth),
        ("acct", "修改密码并绑定账号", RiskKind::Account),
        (
            "irrev",
            "覆盖写入用户配置，属于不可逆操作",
            RiskKind::IrreversibleWrite,
        ),
    ];
    for (id, goal, expected) in zh_cases {
        let rep = detect_risky_actions(&PolicyTaskInput {
            id: id.to_owned(),
            goal: goal.to_owned(),
            ..Default::default()
        });
        assert!(rep.risky, "{id} 应命中风险");
        assert_eq!(rep.kinds[0].kind, expected);
    }

    // D03 英文风险词表全覆盖
    let en_cases: &[(&str, &[RiskKind])] = &[
        ("rm -rf dist && delete all logs", &[RiskKind::Deletion]),
        (
            "Complete OAuth authorization flow and grant access",
            &[RiskKind::ExternalAuth],
        ),
        ("reset password and unlink device", &[RiskKind::Account]),
        (
            "format the disk and wipe the database",
            &[RiskKind::IrreversibleWrite],
        ),
        (
            "permanently delete the staging bucket",
            &[RiskKind::Deletion, RiskKind::IrreversibleWrite],
        ),
    ];
    for (title, expected) in en_cases {
        let rep = detect_risky_actions(&PolicyTaskInput {
            id: "x".to_owned(),
            title: (*title).to_owned(),
            ..Default::default()
        });
        let mut got: Vec<RiskKind> = rep.kinds.iter().map(|k| k.kind).collect();
        got.sort();
        let mut exp = expected.to_vec();
        exp.sort();
        assert_eq!(got, exp, "英文词表漏检：{title}");
    }

    // 普通任务与「删除线样式」零误报
    assert!(
        !detect_risky_actions(&PolicyTaskInput {
            id: "clean".to_owned(),
            title: "给标题加删除线样式".to_owned(),
            ..Default::default()
        })
        .risky
    );
    assert!(
        !detect_risky_actions(&PolicyTaskInput {
            id: "plain".to_owned(),
            title: "整理归档并输出周报".to_owned(),
            ..Default::default()
        })
        .risky
    );
}

#[test]
fn policy_explicit_authorization_requires_exact_task_id_and_plan_revision() {
    let risky_task = PolicyTaskInput {
        id: "a".to_owned(),
        title: "发布版本".to_owned(),
        ..Default::default()
    };
    assert!(!authorize_risky_action(&risky_task, None, 3).authorized);
    assert!(
        !authorize_risky_action(
            &risky_task,
            Some(&RiskAuthorization {
                task_id: "a".to_owned(),
                scope: "risky:a:2".to_owned(),
            }),
            3
        )
        .authorized
    );
    assert!(
        !authorize_risky_action(
            &risky_task,
            Some(&RiskAuthorization {
                task_id: "b".to_owned(),
                scope: "risky:a:3".to_owned(),
            }),
            3
        )
        .authorized
    );
    let ok = authorize_risky_action(
        &risky_task,
        Some(&RiskAuthorization {
            task_id: "a".to_owned(),
            scope: "risky:a:3".to_owned(),
        }),
        3,
    );
    assert!(ok.authorized);
    assert_eq!(ok.kinds[0].kind, RiskKind::Publish);
    assert!(
        authorize_risky_action(
            &PolicyTaskInput {
                id: "z".to_owned(),
                title: "读文档".to_owned(),
                ..Default::default()
            },
            None,
            0
        )
        .authorized
    );
}

#[test]
fn policy_five_fail_closed_gates_block_human_lanes_missing_criteria_and_risky_actions() {
    // 1) 五闸全过才放行
    let clean = PolicyTaskInput {
        id: "ok-1".to_owned(),
        lane: Some("delegate".to_owned()),
        title: "整理归档".to_owned(),
        goal: "按月归档笔记".to_owned(),
        workspace: "H:/notes".to_owned(),
        acceptance: vec!["目录按月命名".to_owned()],
        risks: vec![],
        ..Default::default()
    };
    let ok_rep = evaluate_hall_eligibility(Some(&clean));
    assert!(ok_rep.eligible);
    assert_eq!(
        ok_rep
            .gates
            .iter()
            .map(|g| g.rule.as_str())
            .collect::<Vec<_>>(),
        vec![
            "delegate-lane",
            "has-acceptance",
            "has-workspace",
            "no-risky-actions",
            "no-risk-flags",
        ]
    );
    assert!(ok_rep.gates.iter().all(|g| g.passed && g.reason.is_empty()));

    // 2) 所有人工车道（inform / login / decide / 别名 / 空）100% 拦截
    for human_lane in ["inform", "login", "decide", "agent", ""] {
        let mut t = base_policy_task("human");
        t.lane = Some(human_lane.to_owned());
        let rep = evaluate_hall_eligibility(Some(&t));
        assert!(!rep.eligible, "人工/非规范车道必须拦截：{human_lane}");
        assert!(!rep.gates[0].passed);
        assert!(rep.gates[0].reason.contains("人工闭环"));
    }

    // 3) 缺验收标准 / 缺工作目录 / 含高危动作 / 有规划风险提示各自独立拦截
    let mut no_acc = base_policy_task("acc-1");
    no_acc.acceptance.clear();
    let rep_acc = evaluate_hall_eligibility(Some(&no_acc));
    assert!(!rep_acc.eligible);
    assert!(!rep_acc.gates[1].passed);

    let mut no_ws = base_policy_task("ws-1");
    no_ws.workspace = "   ".to_owned();
    let rep_ws = evaluate_hall_eligibility(Some(&no_ws));
    assert!(!rep_ws.eligible);
    assert!(!rep_ws.gates[2].passed);

    let mut risky = base_policy_task("risk-1");
    risky.goal = "发布到生产环境".to_owned();
    let rep_risk = evaluate_hall_eligibility(Some(&risky));
    assert!(!rep_risk.eligible);
    assert!(!rep_risk.gates[3].passed);
    assert!(rep_risk.gates[3].reason.contains("发布/上线"));

    let mut flagged = base_policy_task("flag-1");
    flagged.risks = vec!["来源不唯一".to_owned()];
    let rep_flag = evaluate_hall_eligibility(Some(&flagged));
    assert!(!rep_flag.eligible);
    assert!(!rep_flag.gates[4].passed);

    // 4) None / 空结构体保守拦截（fail-closed）
    assert!(!evaluate_hall_eligibility(None).eligible);
    assert!(!evaluate_hall_eligibility(Some(&PolicyTaskInput::default())).eligible);
}

#[test]
fn policy_b05_parallel_width_and_advisory_budget() {
    let diamond = vec![
        PolicyTaskInput {
            id: "a".to_owned(),
            ..Default::default()
        },
        PolicyTaskInput {
            id: "b".to_owned(),
            depends_on: vec!["a".to_owned()],
            ..Default::default()
        },
        PolicyTaskInput {
            id: "c".to_owned(),
            depends_on: vec!["a".to_owned()],
            ..Default::default()
        },
        PolicyTaskInput {
            id: "d".to_owned(),
            depends_on: vec!["b".to_owned(), "c".to_owned()],
            ..Default::default()
        },
    ];
    assert_eq!(max_parallel_width(&diamond), 2);

    let cycle = vec![
        PolicyTaskInput {
            id: "a".to_owned(),
            depends_on: vec!["b".to_owned()],
            ..Default::default()
        },
        PolicyTaskInput {
            id: "b".to_owned(),
            depends_on: vec!["a".to_owned()],
            ..Default::default()
        },
    ];
    assert_eq!(max_parallel_width(&cycle), 0);

    let risky_batch = vec![
        PolicyTaskInput {
            id: "a".to_owned(),
            lane: Some("delegate".to_owned()),
            title: "发布上线".to_owned(),
            ..Default::default()
        },
        PolicyTaskInput {
            id: "b".to_owned(),
            lane: Some("delegate".to_owned()),
            title: "付款购买域名".to_owned(),
            ..Default::default()
        },
        PolicyTaskInput {
            id: "h".to_owned(),
            lane: Some("decide".to_owned()),
            status: "blocked".to_owned(),
            ..Default::default()
        },
    ];
    let rec = recommend_workflow_budget(&risky_batch);
    assert_eq!(rec.suggested_max_concurrency, 2);
    assert_eq!(rec.estimated_runs, 3);
    assert!(rec.advisory_only);
    assert!(rec.hints.iter().any(|h| h.contains("2 个高风险任务")));
    assert!(rec
        .hints
        .iter()
        .any(|h| h.contains("1 项登录/决策人工事项")));
}

// ── 3. Node↔Rust 100% 实机一致性对拍（直接调用主仓 workflow-triage.js & workflow-policy.js） ──

#[test]
fn parity_100_percent_against_ringflow_node_js_engine() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize();
    let Ok(root) = repo_root else {
        crate::domain::note_skipped("无法定位主仓根目录，跳过 Node↔Rust 实时对拍");
        return;
    };
    let triage_js = root.join("workflow-triage.js");
    let policy_js = root.join("workflow-policy.js");
    if !triage_js.exists() || !policy_js.exists() {
        crate::domain::note_skipped(
            "未找到主仓 workflow-triage.js / workflow-policy.js，跳过实时对拍",
        );
        return;
    }

    // 覆盖四车道 + 优先级冲突 + 显式别名 + 保守回退 + E7 模板/验收 + 中英六类高危 + 五道安全闸
    let node_script = r#"
const triage = require('./workflow-triage');
const policy = require('./workflow-policy');

const classifyCases = [
  { text: '登录后台后检查并修复发布配置' },
  { text: '登录账号并提交方案', workflow: 'decide' },
  { text: '整理文档并输出周报摘要', workflow: '可交给 Agent' },
  { text: '请确认预算方案是否批准发布' },
  { text: '本周复盘简报与结论汇报' },
  { text: '重构导出模块并补齐单元测试' },
  { text: '买一盆绿植放工位' },
  { text: '检查 2FA 验证码与 token 刷新' },
  { text: '随便记录', route: 'auth' },
  { text: '随便记录', needs: 'decision' },
  { text: '随便记录', lane: 'knowledge' },
];

const indexFiles = [
  {
    path: 'D:/notes/contract.md', name: 'contract.md', title: '合同会签', mtime: 10,
    tasks: [
      { id: 't1', path: 'D:/notes/contract.md', line: 3, text: 'ARCH、PO 同意（签名／日期）', rawText: '- [ ] ARCH、PO 同意（签名／日期）', completed: false, syntax: 'checkbox', indent: 0 },
      { id: 't2', path: 'D:/notes/contract.md', line: 4, text: '签名：______ 日期：______', rawText: '- [ ] 签名：______ 日期：______', completed: false, syntax: 'checkbox', indent: 0 },
      { id: 't3', path: 'D:/notes/contract.md', line: 5, text: '整理会签意见并归档', rawText: '- [ ] 整理会签意见并归档', completed: false, syntax: 'checkbox', indent: 0 },
      { id: 't4', path: 'D:/notes/contract.md', line: 6, text: '验收：覆盖全部签字意见', rawText: '  - [ ] 验收：覆盖全部签字意见', completed: false, syntax: 'checkbox', indent: 2 },
    ],
  },
  {
    path: 'D:/notes/brief.md', name: 'brief.md', title: '发布简报', workflow: 'inform', mtime: 20,
    tasks: [
      { id: 'b1', path: 'D:/notes/brief.md', line: 4, text: '请确认是否发布', rawText: '- [ ] 请确认是否发布', completed: false, syntax: 'checkbox', indent: 0 },
    ],
  },
  {
    path: 'D:/notes/plain.md', name: 'plain.md', title: '周报摘要', mtime: 5, tasks: [],
  },
];

const policyCases = [
  { id: 'p1', lane: 'delegate', title: '整理归档', goal: '按月整理', workspace: 'H:/ws', acceptance: ['按月分目录'], risks: [] },
  { id: 'p2', lane: 'login', title: '登录控制台', workspace: 'H:/ws', acceptance: ['登录成功'], risks: [] },
  { id: 'p3', lane: 'decide', title: '确认预算方案', workspace: 'H:/ws', acceptance: ['已拍板'], risks: [] },
  { id: 'p4', lane: 'inform', title: '阅读周报', workspace: 'H:/ws', acceptance: ['已知悉'], risks: [] },
  { id: 'p5', lane: 'delegate', title: '修复按钮样式', workspace: 'H:/ws', acceptance: [], risks: [] },
  { id: 'p6', lane: 'delegate', title: '修复按钮样式', workspace: '   ', acceptance: ['视觉还原'], risks: [] },
  { id: 'p7', lane: 'delegate', title: '发布到生产环境并 deploy', workspace: 'H:/ws', acceptance: ['上线完成'], risks: [] },
  { id: 'p8', lane: 'delegate', title: 'permanently delete the staging bucket', workspace: 'H:/ws', acceptance: ['已清理'], risks: [] },
  { id: 'p9', lane: 'delegate', title: 'Complete OAuth flow and reset password', workspace: 'H:/ws', acceptance: ['授权完成'], risks: [] },
  { id: 'p10', lane: 'delegate', title: '给标题加删除线样式', workspace: 'H:/ws', acceptance: ['渲染正确'], risks: [] },
  { id: 'p11', lane: 'delegate', title: '整理笔记', workspace: 'H:/ws', acceptance: ['归档完毕'], risks: ['存在外部依赖冲突'] },
  { id: 'p12', lane: '', title: '无车道任务', workspace: 'H:/ws', acceptance: ['完成'], risks: [] },
];

const out = {
  classify: classifyCases.map((c) => ({ input: c, result: triage.classifyWorkflowItem(c) })),
  index: triage.buildWorkflowIndex({ files: indexFiles }),
  policy: policyCases.map((t) => ({
    task: t,
    risk: policy.detectRiskyActions(t),
    hall: policy.evaluateHallEligibility(t),
  })),
};
process.stdout.write(JSON.stringify(out));
"#;

    let output = match Command::new("node")
        .current_dir(&root)
        .arg("-e")
        .arg(node_script)
        .output()
    {
        Ok(o) if o.status.success() => o,
        Ok(o) => panic!(
            "Node 对拍脚本执行失败：{}",
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => {
            crate::domain::note_skipped(format!("本机未找到 node 可执行文件，跳过实时对拍：{e}"));
            return;
        }
    };

    let expected: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("Node 对拍输出应为合法 JSON");

    // 1) 对拍 classifyWorkflowItem（11 组用例，lane / reason / matched 逐项一致）
    let classify_arr = expected["classify"].as_array().expect("classify array");
    for entry in classify_arr {
        let inp = &entry["input"];
        let js_res = &entry["result"];
        let rust_res = classify_workflow_item(&ClassificationInput {
            text: inp["text"].as_str(),
            workflow: inp["workflow"].as_str(),
            route: inp["route"].as_str(),
            needs: inp["needs"].as_str(),
            lane: inp["lane"].as_str(),
            ..Default::default()
        });
        assert_eq!(
            rust_res.lane.as_str(),
            js_res["lane"].as_str().unwrap(),
            "lane 对拍失配：{inp}"
        );
        assert_eq!(
            rust_res.reason,
            js_res["reason"].as_str().unwrap(),
            "reason 对拍失配：{inp}"
        );
        let js_matched: Vec<&str> = js_res["matched"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let rust_matched: Vec<&str> = rust_res.matched.iter().map(|s| s.as_str()).collect();
        assert_eq!(rust_matched, js_matched, "matched 对拍失配：{inp}");
    }

    // 2) 对拍 buildWorkflowIndex（3 文档：模板过滤 + 验收折叠 + Frontmatter 覆盖 + 无任务默认 inform）
    let rust_index = build_workflow_index(&[
        TriageFileInput {
            path: "D:/notes/contract.md".to_owned(),
            name: "contract.md".to_owned(),
            title: "合同会签".to_owned(),
            modified_at: 10,
            tasks: vec![
                TriageTaskInput {
                    id: "t1".to_owned(),
                    path: "D:/notes/contract.md".to_owned(),
                    line: 3,
                    text: "ARCH、PO 同意（签名／日期）".to_owned(),
                    raw_text: "- [ ] ARCH、PO 同意（签名／日期）".to_owned(),
                    syntax: TaskSyntax::Checkbox,
                    ..Default::default()
                },
                TriageTaskInput {
                    id: "t2".to_owned(),
                    path: "D:/notes/contract.md".to_owned(),
                    line: 4,
                    text: "签名：______ 日期：______".to_owned(),
                    raw_text: "- [ ] 签名：______ 日期：______".to_owned(),
                    syntax: TaskSyntax::Checkbox,
                    ..Default::default()
                },
                TriageTaskInput {
                    id: "t3".to_owned(),
                    path: "D:/notes/contract.md".to_owned(),
                    line: 5,
                    text: "整理会签意见并归档".to_owned(),
                    raw_text: "- [ ] 整理会签意见并归档".to_owned(),
                    syntax: TaskSyntax::Checkbox,
                    ..Default::default()
                },
                TriageTaskInput {
                    id: "t4".to_owned(),
                    path: "D:/notes/contract.md".to_owned(),
                    line: 6,
                    text: "验收：覆盖全部签字意见".to_owned(),
                    raw_text: "  - [ ] 验收：覆盖全部签字意见".to_owned(),
                    syntax: TaskSyntax::Checkbox,
                    indent: 2,
                    ..Default::default()
                },
            ],
            ..Default::default()
        },
        TriageFileInput {
            path: "D:/notes/brief.md".to_owned(),
            name: "brief.md".to_owned(),
            title: "发布简报".to_owned(),
            workflow: Some("inform".to_owned()),
            modified_at: 20,
            tasks: vec![TriageTaskInput {
                id: "b1".to_owned(),
                path: "D:/notes/brief.md".to_owned(),
                line: 4,
                text: "请确认是否发布".to_owned(),
                raw_text: "- [ ] 请确认是否发布".to_owned(),
                syntax: TaskSyntax::Checkbox,
                ..Default::default()
            }],
            ..Default::default()
        },
        TriageFileInput {
            path: "D:/notes/plain.md".to_owned(),
            name: "plain.md".to_owned(),
            title: "周报摘要".to_owned(),
            modified_at: 5,
            tasks: vec![],
            ..Default::default()
        },
    ]);
    let js_idx = &expected["index"];
    assert_eq!(
        rust_index.filtered.template as u64,
        js_idx["filtered"]["template"].as_u64().unwrap()
    );
    assert_eq!(
        rust_index.filtered.acceptance as u64,
        js_idx["filtered"]["acceptance"].as_u64().unwrap()
    );
    let js_items = js_idx["items"].as_array().unwrap();
    assert_eq!(rust_index.items.len(), js_items.len());
    for (r_item, j_item) in rust_index.items.iter().zip(js_items.iter()) {
        assert_eq!(r_item.id, j_item["id"].as_str().unwrap());
        assert_eq!(r_item.lane.as_str(), j_item["lane"].as_str().unwrap());
        assert_eq!(r_item.reason, j_item["reason"].as_str().unwrap());
        assert_eq!(
            r_item.source.line as u64,
            j_item["source"]["line"].as_u64().unwrap()
        );
        assert_eq!(
            r_item.source.expected_text,
            j_item["source"]["expectedText"].as_str().unwrap()
        );
        let j_acc: Vec<&str> = j_item["acceptanceCriteria"]
            .as_array()
            .map(|arr| arr.iter().map(|v| v.as_str().unwrap()).collect())
            .unwrap_or_default();
        let r_acc: Vec<&str> = r_item
            .acceptance_criteria
            .iter()
            .map(|s| s.as_str())
            .collect();
        assert_eq!(r_acc, j_acc);
    }

    // 3) 对拍 detectRiskyActions + evaluateHallEligibility（12 组用例 × 5 道安全闸 = 60 闸次 100% 一致）
    let policy_arr = expected["policy"].as_array().expect("policy array");
    for entry in policy_arr {
        let t = &entry["task"];
        let input = PolicyTaskInput {
            id: t["id"].as_str().unwrap_or("").to_owned(),
            lane: t["lane"].as_str().map(str::to_owned),
            title: t["title"].as_str().unwrap_or("").to_owned(),
            goal: t["goal"].as_str().unwrap_or("").to_owned(),
            workspace: t["workspace"].as_str().unwrap_or("").to_owned(),
            acceptance: t["acceptance"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            risks: t["risks"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            ..Default::default()
        };

        let rust_risk = detect_risky_actions(&input);
        let js_risk = &entry["risk"];
        assert_eq!(rust_risk.risky, js_risk["risky"].as_bool().unwrap());
        let r_kinds: Vec<&str> = rust_risk.kinds.iter().map(|k| k.kind.as_str()).collect();
        let j_kinds: Vec<&str> = js_risk["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k["kind"].as_str().unwrap())
            .collect();
        assert_eq!(r_kinds, j_kinds, "风险类别对拍失配：{}", input.id);

        let rust_hall = evaluate_hall_eligibility(Some(&input));
        let js_hall = &entry["hall"];
        assert_eq!(
            rust_hall.eligible,
            js_hall["eligible"].as_bool().unwrap(),
            "大厅放行对拍失配：{}",
            input.id
        );
        let js_gates = js_hall["gates"].as_array().unwrap();
        assert_eq!(rust_hall.gates.len(), js_gates.len());
        for (rg, jg) in rust_hall.gates.iter().zip(js_gates.iter()) {
            assert_eq!(rg.rule, jg["rule"].as_str().unwrap());
            assert_eq!(
                rg.passed,
                jg["passed"].as_bool().unwrap(),
                "闸门结果失配：{} / {}",
                input.id,
                rg.rule
            );
            assert_eq!(
                rg.reason,
                jg["reason"].as_str().unwrap(),
                "闸门理由失配：{} / {}",
                input.id,
                rg.rule
            );
        }
    }
}

#[test]
fn parity_raw_markdown_documents_against_markdown_index_and_triage_js() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize();
    let Ok(root) = repo_root else {
        crate::domain::note_skipped("无法定位主仓根目录，跳过原始 Markdown 文档的实时对拍");
        return;
    };
    if !root.join("markdown-index.js").exists() || !root.join("workflow-triage.js").exists() {
        crate::domain::note_skipped(
            "未找到主仓 markdown-index.js / workflow-triage.js，跳过实时对拍",
        );
        return;
    }

    let doc1 = [
        "---",
        "workflow: decide",
        "category: 架构评审",
        "subject: Guanlan",
        "question: 是否采用四车道分流内核",
        "options: [采纳, 延后]",
        "impact: 统一人工与 Agent 守门语义",
        "---",
        "",
        "# 架构评审单",
        "",
        "```markdown",
        "- [ ] 示例代码块里的勾选项不得被抽取",
        "```",
        "",
        "- [ ] 确认最终发布方案",
        "- [/] 核对 **接口契约** @due(2026-11-30)",
        "- [-] 已取消历史议题",
        "TODO: 补齐回滚测试脚本",
    ]
    .join("\n");

    let doc2 = [
        "# 运维交接",
        "",
        "- [ ] 登录生产控制台刷新 OAuth token",
        "- [ ] 重构快照清理模块",
        "  - [ ] 验收：零误删被决定引用的快照",
        "- [ ] 签名：__________ 日期：__________",
        "- [ ] ARCH、PO 同意（签名／日期）",
    ]
    .join("\n");

    let doc3 = "# 本周进展复盘\n\n全部目标按期完成，无阻塞。\n".to_owned();

    let docs = [
        ("D:/ws/review.md", doc1.as_str(), 300i64),
        ("D:/ws/ops.md", doc2.as_str(), 200i64),
        ("D:/ws/summary.md", doc3.as_str(), 100i64),
    ];

    let rust_idx = triage_markdown_documents(
        &docs
            .iter()
            .map(|(p, c, m)| MarkdownDocInput {
                path: p,
                content: c,
                modified_at: *m,
            })
            .collect::<Vec<_>>(),
    );

    let payload = serde_json::json!(docs
        .iter()
        .map(|(p, c, m)| serde_json::json!({ "path": p, "content": c, "mtime": m }))
        .collect::<Vec<_>>());

    let node_script = r#"
const fs = require('node:fs');
const { parseMarkdown } = require('./markdown-index');
const { buildWorkflowIndex } = require('./workflow-triage');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const files = input.map((d) => parseMarkdown(d.content, d.path, { mtimeMs: d.mtime, size: Buffer.byteLength(d.content, 'utf8') }));
const idx = buildWorkflowIndex({ files });
process.stdout.write(JSON.stringify(idx));
"#;

    let mut child = match Command::new("node")
        .current_dir(&root)
        .arg("-e")
        .arg(node_script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin piped");
        stdin
            .write_all(payload.to_string().as_bytes())
            .expect("write payload");
    }
    let output = child.wait_with_output().expect("wait node");
    assert!(
        output.status.success(),
        "Node Markdown 对拍失败：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let js_idx: serde_json::Value = serde_json::from_slice(&output.stdout).expect("valid json");

    assert_eq!(
        rust_idx.filtered.template as u64,
        js_idx["filtered"]["template"].as_u64().unwrap()
    );
    assert_eq!(
        rust_idx.filtered.acceptance as u64,
        js_idx["filtered"]["acceptance"].as_u64().unwrap()
    );
    let js_items = js_idx["items"].as_array().unwrap();
    assert_eq!(rust_idx.items.len(), js_items.len());
    // 校验主排序键（LANE_ORDER → updated_at 降序）完全一致；同车道同时间戳下按 (path, line) 逐项对拍
    // （避免 Node ICU 'zh' 拼音序与 Rust UTF-8 码点序在平局标题上的无关差异）
    for pair in rust_idx.items.windows(2) {
        let a = &pair[0];
        let b = &pair[1];
        assert!(
            a.lane.order_rank() < b.lane.order_rank()
                || (a.lane.order_rank() == b.lane.order_rank() && a.updated_at >= b.updated_at)
        );
    }
    for j in js_items {
        let j_path = j["source"]["path"].as_str().unwrap();
        let j_line = j["source"]["line"].as_u64().unwrap() as usize;
        let r = rust_idx
            .items
            .iter()
            .find(|item| item.source.path == j_path && item.source.line == j_line)
            .unwrap_or_else(|| panic!("Rust 索引缺少条目：{j_path}:{j_line}"));
        assert_eq!(r.lane.as_str(), j["lane"].as_str().unwrap());
        assert_eq!(r.reason, j["reason"].as_str().unwrap());
        assert_eq!(r.title, j["title"].as_str().unwrap());
        assert_eq!(
            r.source.expected_text,
            j["source"]["expectedText"].as_str().unwrap()
        );
        let j_acc: Vec<&str> = j["acceptanceCriteria"]
            .as_array()
            .map(|arr| arr.iter().map(|v| v.as_str().unwrap()).collect())
            .unwrap_or_default();
        let r_acc: Vec<&str> = r.acceptance_criteria.iter().map(|s| s.as_str()).collect();
        assert_eq!(r_acc, j_acc);
    }
}
