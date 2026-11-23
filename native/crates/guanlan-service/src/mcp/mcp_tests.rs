//! MCP stdio 代理测试（契约 K）：
//! - 协议面：initialize 回显 / tools/list 四工具逐字序 / 未知方法 -32601 /
//!   未知工具 -32602 / 通知无响应 / 解析错误 -32700；
//! - 四工具转发：mock 后端断言上游 method/path/body 逐字（含 job 有界轮询）；
//! - 手写 HTTP 客户端：对真实本地 TcpListener 端到端（Content-Length 与 chunked 两种响应）；
//! - 端点解析：--endpoint 参数 > GUANLAN_ENDPOINT env > 缺失报错（不猜端口）。

use std::sync::Mutex;

use serde_json::{json, Value};

use super::*;

// ---------- mock 后端（记录请求 + 按序回放响应） ----------

type Responder = Box<dyn Fn(&McpHttpRequest) -> Result<McpHttpResponse, String> + Send + Sync>;

struct MockBackend {
    calls: Mutex<Vec<McpHttpRequest>>,
    responder: Responder,
}

impl MockBackend {
    fn new(
        responder: impl Fn(&McpHttpRequest) -> Result<McpHttpResponse, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            responder: Box::new(responder),
        }
    }

    fn ok(status: u16, body: Value) -> McpHttpResponse {
        let raw = body.to_string();
        McpHttpResponse {
            status,
            body,
            raw_text: raw,
        }
    }

    fn recorded(&self) -> Vec<McpHttpRequest> {
        self.calls.lock().expect("mock 调用表锁").clone()
    }
}

impl McpBackend for MockBackend {
    fn call(&self, req: McpHttpRequest) -> Result<McpHttpResponse, String> {
        self.calls.lock().expect("mock 调用表锁").push(req.clone());
        (self.responder)(&req)
    }
}

fn request(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params })
}

fn result_payload(response: &Value) -> Value {
    response.get("result").cloned().expect("响应应带 result")
}

fn content_text(response: &Value) -> String {
    let result = response.get("result").expect("工具响应应带 result");
    result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .expect("工具响应应带文本 content")
        .to_string()
}

fn is_error_result(response: &Value) -> bool {
    response
        .get("result")
        .and_then(|r| r.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

// ---------- 协议面 ----------

#[test]
fn initialize_echoes_client_protocol_version() {
    let backend = MockBackend::new(|_| unreachable!("initialize 不发 HTTP"));
    let response = handle_message(
        &request(
            "initialize",
            json!({ "protocolVersion": "2025-06-18", "capabilities": {} }),
        ),
        &backend,
    )
    .expect("initialize 应有响应");
    let result = result_payload(&response);
    assert_eq!(
        result["protocolVersion"], "2025-06-18",
        "回显客户端请求的协议版本"
    );
    assert_eq!(result["serverInfo"]["name"], "guanlan-mcp");
    assert!(
        result["capabilities"]["tools"].is_object(),
        "必须声明 tools 能力"
    );
}

#[test]
fn initialize_without_client_version_pins_default() {
    let backend = MockBackend::new(|_| unreachable!("initialize 不发 HTTP"));
    let response = handle_message(&request("initialize", json!({})), &backend).expect("应有响应");
    assert_eq!(
        result_payload(&response)["protocolVersion"],
        DEFAULT_PROTOCOL_VERSION
    );
}

#[test]
fn tools_list_is_exactly_four_prd_tools_in_order() {
    let backend = MockBackend::new(|_| unreachable!("tools/list 不发 HTTP"));
    let response = handle_message(&request("tools/list", json!({})), &backend).expect("应有响应");
    let tools = result_payload(&response)["tools"]
        .as_array()
        .expect("tools 数组")
        .clone();
    let names: Vec<&str> = tools
        .iter()
        .map(|t| t["name"].as_str().expect("工具名"))
        .collect();
    assert_eq!(names, TOOL_NAMES, "PRD 4.3 allowed_mcp_tools 逐字序");
    for tool in &tools {
        assert!(
            tool["inputSchema"].is_object(),
            "每个工具必须带 inputSchema"
        );
        assert!(tool["description"].is_string());
    }
}

#[test]
fn unknown_method_returns_32601() {
    let backend = MockBackend::new(|_| unreachable!("未知方法不发 HTTP"));
    let response =
        handle_message(&request("resources/list", json!({})), &backend).expect("应有响应");
    assert_eq!(response["error"]["code"], -32601);
}

#[test]
fn unknown_tool_returns_32602() {
    let backend = MockBackend::new(|_| unreachable!("未知工具不发 HTTP"));
    let response = handle_message(
        &request(
            "tools/call",
            json!({ "name": "guanlan.not_a_tool", "arguments": {} }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert_eq!(response["error"]["code"], -32602);
}

#[test]
fn notification_produces_no_response() {
    let backend = MockBackend::new(|_| unreachable!("通知不发 HTTP"));
    let notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    assert!(handle_message(&notification, &backend).is_none());
}

#[test]
fn malformed_json_yields_32700_with_null_id() {
    let error = rpc_error(Value::Null, -32700, "JSON 解析失败：test".to_owned());
    assert_eq!(error["id"], Value::Null);
    assert_eq!(error["error"]["code"], -32700);
    assert!(error["error"]["message"].as_str().unwrap().contains("JSON"));
}

#[test]
fn non_object_message_is_invalid_request() {
    let backend = MockBackend::new(|_| unreachable!());
    let response = handle_message(&json!([1, 2, 3]), &backend).expect("应有响应");
    assert_eq!(response["error"]["code"], -32600);
}

// ---------- 四工具转发 ----------

#[test]
fn commit_checkpoint_forwards_payload_and_returns_201_body() {
    let backend = MockBackend::new(|req| {
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/api/v1/checkpoints");
        let body = req.body.as_ref().expect("应带请求体");
        assert_eq!(body["initiative_id"], "init_04");
        assert_eq!(body["stage"], "执行");
        assert_eq!(body["status"], "SUCCESS");
        assert_eq!(body["input_context_hash"], "sha256:abc");
        assert_eq!(body["token_usage"], 1234);
        assert_eq!(
            body["note"],
            Value::Null,
            "未传可选字段落 null（serde 缺省）"
        );
        Ok(MockBackend::ok(
            201,
            json!({ "ok": true, "checkpoint_id": "ckpt_1", "node_state": "completed" }),
        ))
    });
    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.commit_checkpoint",
                "arguments": {
                    "initiative_id": "init_04",
                    "stage": "执行",
                    "status": "SUCCESS",
                    "input_context_hash": "sha256:abc",
                    "token_usage": 1234,
                },
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(!is_error_result(&response));
    let text = content_text(&response);
    assert!(text.contains("ckpt_1"), "结果应含 checkpoint_id：{text}");
}

#[test]
fn commit_checkpoint_missing_required_field_is_error_result() {
    let backend = MockBackend::new(|_| unreachable!("缺必填字段不应发 HTTP"));
    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.commit_checkpoint",
                "arguments": { "initiative_id": "init_04", "stage": "执行" },
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(is_error_result(&response), "缺必填 → isError 结果");
    assert!(content_text(&response).contains("status"));
}

#[test]
fn propose_revision_resolves_path_posts_then_polls_job() {
    // 第 1 调用：files?q= 精确匹配；第 2 调用：POST revision-proposals；
    // 第 3.. 调用：job 轮询（先 running 后 completed）
    let backend = MockBackend::new(|req| {
        if req.path.starts_with("/api/v1/files?") {
            assert!(req.path.contains("q="), "路径查询须编码进 q 参数");
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "items": [
                        { "file_id": "f_bom", "relative_path": "docs/04/BOM方案.md", "status": "active", "current_revision_id": "rev_2" },
                        { "file_id": "f_other", "relative_path": "docs/04/BOM方案-旧.md", "status": "active", "current_revision_id": "rev_1" }
                    ],
                }),
            ));
        }
        if req.path == "/api/v1/revision-proposals" {
            assert_eq!(req.method, "POST");
            let body = req.body.as_ref().unwrap();
            // 精确匹配命中的文件与当前版基准
            assert_eq!(body["file_id"], "f_bom");
            assert_eq!(body["base_revision_id"], "rev_2");
            assert_eq!(body["content"], "修订后正文");
            return Ok(MockBackend::ok(
                202,
                json!({ "ok": true, "job_id": "job_p1", "draft_id": "draft_9", "conflict": false }),
            ));
        }
        if req.path == "/api/v1/jobs/job_p1" {
            static CALLS: Mutex<u32> = Mutex::new(0);
            let mut calls = CALLS.lock().unwrap();
            *calls += 1;
            if *calls == 1 {
                return Ok(MockBackend::ok(
                    200,
                    json!({ "ok": true, "state": "running" }),
                ));
            }
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "state": "completed",
                    "result": { "proposal": { "draft_id": "draft_9", "cas_ok": true, "status": "proposed", "conflict": false } },
                }),
            ));
        }
        Err(format!("意外请求：{}", req.path))
    });
    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.propose_revision",
                "arguments": {
                    "path": "docs/04/BOM方案.md",
                    "content": "修订后正文",
                },
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(!is_error_result(&response));
    let text = content_text(&response);
    assert!(text.contains("draft_9"));
    assert!(text.contains("cas_ok"), "轮询终态应回报 report.proposal");
    let calls = backend.recorded();
    assert!(
        calls.iter().any(|c| c.path.starts_with("/api/v1/files?")),
        "应先经 files 精确匹配解析 file_id"
    );
}

#[test]
fn resolve_decision_forwards_and_polls_writeback_report() {
    let backend = MockBackend::new(|req| {
        if req.path == "/api/v1/decisions/st_1/resolve" {
            let body = req.body.as_ref().unwrap();
            assert_eq!(body["decision"], "采用方案 A");
            assert_eq!(body["confirmer"], "架构组");
            assert_eq!(body["effective_date"], "2026-11-18");
            return Ok(MockBackend::ok(
                202,
                json!({ "ok": true, "job_id": "job_w1", "statement_id": "st_1", "decision_id": "dec_1" }),
            ));
        }
        if req.path == "/api/v1/jobs/job_w1" {
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "state": "completed",
                    "result": { "writeback": { "cas_ok": true, "file_changed": true, "new_revision_id": "rev_3", "decision_id": "dec_1" } },
                }),
            ));
        }
        Err(format!("意外请求：{}", req.path))
    });
    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.resolve_decision",
                "arguments": {
                    "statement_id": "st_1",
                    "decision": "采用方案 A",
                    "confirmer": "架构组",
                    "effective_date": "2026-11-18",
                },
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(!is_error_result(&response));
    let text = content_text(&response);
    assert!(text.contains("rev_3"), "应回报回写新版本：{text}");
}

#[test]
fn read_artifact_strips_guanlan_uri_and_returns_text() {
    let backend = MockBackend::new(|req| {
        if req.path.starts_with("/api/v1/files?") {
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "items": [
                        { "file_id": "f_todo", "relative_path": "docs/04/03-待确认事项.md", "status": "active", "current_revision_id": "rev_7" }
                    ],
                }),
            ));
        }
        if req.path == "/api/v1/revisions/rev_7/content" {
            return Ok(MockBackend::ok(
                200,
                json!({ "ok": true, "format": "md", "revision_id": "rev_7", "text": "- [P1 - 待确认] 属性字典策略" }),
            ));
        }
        Err(format!("意外请求：{}", req.path))
    });
    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.read_artifact",
                "arguments": { "uri": "guanlan://docs\\04\\03-待确认事项.md" },
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(!is_error_result(&response));
    let text = content_text(&response);
    assert!(text.contains("03-待确认事项.md"));
    assert!(text.contains("属性字典策略"), "应内联正文 text");
}

#[test]
fn read_artifact_without_exact_match_is_error_result() {
    let backend = MockBackend::new(|req| {
        assert!(req.path.starts_with("/api/v1/files?"));
        Ok(MockBackend::ok(200, json!({ "ok": true, "items": [] })))
    });
    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.read_artifact",
                "arguments": { "path": "docs/不存在.md" },
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(is_error_result(&response), "未命中精确路径 → isError");
    assert!(content_text(&response).contains("未找到文件"));
}

#[test]
fn read_artifact_http_4xx_surfaces_envelope_as_error() {
    let backend = MockBackend::new(|_| {
        Ok(MockBackend::ok(
            404,
            json!({ "ok": false, "code": "NOT_FOUND", "error": "未找到版本 rev_x" }),
        ))
    });
    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.read_artifact",
                "arguments": { "revision_id": "rev_x", "path": "docs/a.md" },
            }),
        ),
        &backend,
    );
    // resolve_file 先查 files（无匹配即报错），这里 items 为空 → 错误落在文件定位
    let response = response.expect("应有响应");
    assert!(is_error_result(&response));
    let text = content_text(&response);
    assert!(
        text.contains("未找到文件") || text.contains("NOT_FOUND"),
        "错误文案含定位失败：{text}"
    );
}

// ---------- 端点解析（契约 K：不猜端口） ----------

#[test]
fn endpoint_flag_wins_over_env() {
    let resolved = resolve_endpoint(
        &[
            "--endpoint".to_owned(),
            "http://127.0.0.1:39120/".to_owned(),
        ],
        Some("http://127.0.0.1:9999"),
    )
    .expect("应解析成功");
    assert_eq!(resolved, "http://127.0.0.1:39120", "参数优先且去尾斜杠");
}

#[test]
fn endpoint_env_fallback_and_inline_form() {
    let env = resolve_endpoint(&[], Some("http://localhost:1234")).expect("env 兜底");
    assert_eq!(env, "http://localhost:1234");
    let inline =
        resolve_endpoint(&["--endpoint=http://127.0.0.1:8080".to_owned()], None).expect("内联形制");
    assert_eq!(inline, "http://127.0.0.1:8080");
}

#[test]
fn e02_propose_revision_forwards_context_hashes_and_receipt_summary() {
    let backend = MockBackend::new(|req| {
        if req.path == "/api/v1/revision-proposals" {
            assert_eq!(req.method, "POST");
            let body = req.body.as_ref().unwrap();
            assert_eq!(body["file_id"], "f_plan");
            assert_eq!(body["base_revision_id"], "rev_2");
            assert_eq!(
                body["input_context_hashes"],
                json!(["sha256:0123456789abcdef", "fedcba9876543210"])
            );
            assert_eq!(body["receipt_summary"], "按架构规范补齐 CAS 状态机守卫");
            return Ok(MockBackend::ok(
                202,
                json!({
                    "ok": true,
                    "job_id": "job_e02",
                    "draft_id": "draft_e02",
                    "draft_version_label": "v3-agent-draft",
                    "conflict": false,
                }),
            ));
        }
        if req.path == "/api/v1/jobs/job_e02" {
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "state": "completed",
                    "result": {
                        "proposal": {
                            "draft_id": "draft_e02",
                            "draft_version_label": "v3-agent-draft",
                            "cas_ok": true,
                            "status": "proposed",
                            "conflict": false,
                            "input_context_hashes": ["sha256:0123456789abcdef", "fedcba9876543210"],
                            "receipt_summary": "按架构规范补齐 CAS 状态机守卫",
                        }
                    },
                }),
            ));
        }
        Err(format!("意外请求：{}", req.path))
    });

    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.propose_revision",
                "arguments": {
                    "file_id": "f_plan",
                    "base_revision_id": "rev_2",
                    "content": "# 计划 v3\n已补齐守卫\n",
                    "note": "E02 测试",
                    "input_context_hashes": ["sha256:0123456789abcdef", "fedcba9876543210"],
                    "receipt_summary": "按架构规范补齐 CAS 状态机守卫",
                },
            }),
        ),
        &backend,
    )
    .expect("应有响应");

    assert!(!is_error_result(&response));
    let text = content_text(&response);
    let parsed: Value = serde_json::from_str(&text).expect("应返回 JSON");
    assert_eq!(parsed["draft_id"], "draft_e02");
    assert_eq!(parsed["draft_version_label"], "v3-agent-draft");
    assert_eq!(parsed["job_state"], "completed");
    assert_eq!(
        parsed["report"]["proposal"]["receipt_summary"],
        "按架构规范补齐 CAS 状态机守卫"
    );
}

#[test]
fn e03_get_context_bundle_resolves_uri_and_returns_byte_identical_bundle() {
    let canonical_markdown = "<guanlan_context workspace=\"H:/ws\" initiative=\"02-证道阁\" stage=\"执行\">\n  <objective>\n    推进任务\n  </objective>\n</guanlan_context>\n";
    let canonical_payload = json!({
        "protocol": "guanlan-mcp/v1",
        "session_checkpoint_id": null,
        "workspace_root": "H:/ws",
        "initiative": { "id": "init_02", "name": "02-证道阁", "current_stage": "执行" },
        "context_bundle": [
            { "uri": "guanlan://02-证道阁/计划.md", "granularity": "diff_only", "version": "v2", "hash": "sha256:0123456789abcdef" }
        ],
        "allowed_mcp_tools": [
            "guanlan.read_artifact",
            "guanlan.propose_revision",
            "guanlan.resolve_decision",
            "guanlan.commit_checkpoint"
        ],
        "guardrails": { "block_write_on_unresolved_p0": true, "require_version_bump": true }
    });
    let md_clone = canonical_markdown.to_owned();
    let payload_clone = canonical_payload.clone();
    let backend = MockBackend::new(move |req| {
        if req.path.starts_with("/api/v1/files?q=") {
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "items": [
                        {
                            "file_id": "f_plan",
                            "relative_path": "02-证道阁/计划.md",
                            "current_revision_id": "rev_f_plan_r2",
                            "status": "active"
                        }
                    ]
                }),
            ));
        }
        if req.path == "/api/v1/context" {
            assert_eq!(req.method, "POST");
            let body = req.body.as_ref().unwrap();
            assert_eq!(body["intent"], "document");
            assert_eq!(body["focus_file_id"], "f_plan");
            assert_eq!(body["items"][0]["file_id"], "f_plan");
            assert_eq!(body["items"][0]["granularity"], "diff_only");
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "index_generation": 8,
                    "intent": "document",
                    "workspace_root": "H:/ws",
                    "initiative_id": "init_02",
                    "preset": { "items": [], "recommended": [] },
                    "decisions": { "pending": [], "confirmed": [] },
                    "upstream_snippets": [],
                    "token_budget": { "selected": 1, "est_chars": 120, "est_tokens": 42, "threshold": 65536, "over_threshold": false, "downgrade_suggestions": [] },
                    "redacted_secrets_count": 0,
                    "markdown": md_clone,
                    "payload": payload_clone,
                }),
            ));
        }
        Err(format!("意外请求：{}", req.path))
    });

    let response = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.get_context_bundle",
                "arguments": {
                    "uri": "guanlan://02-证道阁/计划.md",
                    "items": [
                        { "uri": "guanlan://02-证道阁/计划.md", "granularity": "diff_only" }
                    ],
                    "mode": "both",
                },
            }),
        ),
        &backend,
    )
    .expect("应有响应");

    assert!(!is_error_result(&response));
    let parsed: Value = serde_json::from_str(&content_text(&response)).expect("合法 JSON");
    assert_eq!(
        parsed["markdown"].as_str().expect("markdown"),
        canonical_markdown,
        "MCP get_context_bundle 与 HTTP /api/v1/context markdown 必须逐字节一致"
    );
    assert_eq!(parsed["payload"], canonical_payload);
}

#[test]
fn e05_mcp_blocks_all_path_escape_and_secret_paths_before_http() {
    let backend = MockBackend::new(|req| {
        panic!("沙箱拦截应在发 HTTP 前生效，不应收到请求：{req:?}");
    });
    let attack_paths = [
        "../outside-canary.txt",
        "docs/../../outside.md",
        "guanlan://../outside.md",
        "/etc/passwd",
        r"C:\Windows\win.ini",
        r"\\evil-host\share\leak.md",
        "docs/%2e%2e/outside.md",
        "docs/a\0b.md",
        ".env",
        "config/.env.production",
        "keys/id_rsa",
        "certs/private.pem",
    ];
    for attack in attack_paths {
        let read_resp = handle_message(
            &request(
                "tools/call",
                json!({ "name": "guanlan.read_artifact", "arguments": { "path": attack } }),
            ),
            &backend,
        )
        .expect("应有响应");
        assert!(
            is_error_result(&read_resp),
            "read_artifact 必须拦截非法/敏感路径：{attack}"
        );
        let text = content_text(&read_resp);
        assert!(
            text.contains("PATH_ESCAPE_DENIED") || text.contains("SECRET_PATH_DENIED"),
            "错误文案应明确标注沙箱拒绝码 ({attack}): {text}"
        );

        let propose_resp = handle_message(
            &request(
                "tools/call",
                json!({
                    "name": "guanlan.propose_revision",
                    "arguments": { "path": attack, "content": "evil" }
                }),
            ),
            &backend,
        )
        .expect("应有响应");
        assert!(
            is_error_result(&propose_resp),
            "propose_revision 必须拦截非法/敏感路径：{attack}"
        );

        let search_resp = handle_message(
            &request(
                "tools/call",
                json!({
                    "name": "guanlan.search_workspace",
                    "arguments": { "q": "test", "path_prefix": attack }
                }),
            ),
            &backend,
        )
        .expect("应有响应");
        assert!(
            is_error_result(&search_resp),
            "search_workspace 必须拦截非法/敏感目录前缀：{attack}"
        );
    }

    // URL 段注入（revision_id / statement_id 夹带 ../）同样在发 HTTP 前拦截
    let rev_escape = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.read_artifact",
                "arguments": { "file_id": "f_1", "revision_id": "../../audit/ledger" }
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(is_error_result(&rev_escape));
    assert!(content_text(&rev_escape).contains("PATH_ESCAPE_DENIED"));

    let stmt_escape = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.resolve_decision",
                "arguments": {
                    "statement_id": "../evil",
                    "decision": "通过",
                    "confirmer": "agent"
                }
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(is_error_result(&stmt_escape));
    assert!(content_text(&stmt_escape).contains("PATH_ESCAPE_DENIED"));
    assert!(
        backend.recorded().is_empty(),
        "所有沙箱违规请求均不得触达后端"
    );
}

#[test]
fn e05_mcp_search_workspace_forwards_and_strips_secret_paths() {
    let backend = MockBackend::new(|req| {
        assert_eq!(req.method, "GET");
        assert!(req.path.starts_with("/api/v1/search?"));
        assert!(req.path.contains("dir=01-docs"));
        Ok(MockBackend::ok(
            200,
            json!({
                "ok": true,
                "items": [
                    { "file_id": "f_ok", "relative_path": "01-docs/plan.md", "hits": [] },
                    { "file_id": "f_sec", "relative_path": "01-docs/.env.local", "hits": [] },
                    { "file_id": "f_key", "relative_path": "01-docs/server.pem", "hits": [] }
                ]
            }),
        ))
    });
    let resp = handle_message(
        &request(
            "tools/call",
            json!({
                "name": "guanlan.search_workspace",
                "arguments": { "q": "计划", "path_prefix": "01-docs/", "limit": 10 }
            }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(!is_error_result(&resp));
    let parsed: Value = serde_json::from_str(&content_text(&resp)).expect("合法 JSON");
    let items = parsed["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "敏感凭据路径必须在 MCP 返回前剔除");
    assert_eq!(items[0]["relative_path"], "01-docs/plan.md");
}

#[test]
fn e05_mcp_read_artifact_truncates_oversized_413_raw_response_within_budget() {
    let big_payload = "观澜大包截断压测文本-".repeat(15_000); // > 400 KiB
    let big_for_closure = big_payload.clone();
    let backend = MockBackend::new(move |req| {
        if req.path.starts_with("/api/v1/files?q=") {
            return Ok(MockBackend::ok(
                200,
                json!({
                    "ok": true,
                    "items": [{
                        "file_id": "f_big",
                        "relative_path": "docs/huge.md",
                        "current_revision_id": "rev_big_1",
                        "status": "active"
                    }]
                }),
            ));
        }
        if req.path == "/api/v1/revisions/rev_big_1/content" {
            return Ok(MockBackend::ok(
                413,
                json!({ "ok": false, "code": "UNSUPPORTED_CONTENT" }),
            ));
        }
        if req.path == "/api/v1/revisions/rev_big_1/content?raw=1" {
            return Ok(McpHttpResponse {
                status: 200,
                body: Value::Null,
                raw_text: big_for_closure.clone(),
            });
        }
        Err(format!("意外请求：{}", req.path))
    });

    let resp = handle_message(
        &request(
            "tools/call",
            json!({ "name": "guanlan.read_artifact", "arguments": { "path": "docs/huge.md" } }),
        ),
        &backend,
    )
    .expect("应有响应");
    assert!(!is_error_result(&resp));
    let parsed: Value = serde_json::from_str(&content_text(&resp)).expect("合法 JSON");
    assert_eq!(parsed["truncated"], true);
    let returned = parsed["text"].as_str().expect("text");
    assert!(returned.len() <= MCP_MAX_READ_TEXT_BYTES);
    assert_eq!(
        parsed["total_bytes"].as_u64(),
        Some(big_payload.len() as u64)
    );
    assert_eq!(
        parsed["returned_bytes"].as_u64(),
        Some(returned.len() as u64)
    );
}

#[test]
fn endpoint_missing_or_https_or_bad_port_fails() {
    assert!(
        resolve_endpoint(&[], None).is_err(),
        "两者皆缺 → Err（退出码 1 由 run 落）"
    );
    assert!(resolve_endpoint(
        &["--endpoint".to_owned(), "https://127.0.0.1:1".to_owned()],
        None
    )
    .is_err());
    assert!(resolve_endpoint(
        &["--endpoint".to_owned(), "http://127.0.0.1".to_owned()],
        None
    )
    .is_err());
    assert!(resolve_endpoint(
        &["--endpoint".to_owned(), "http://127.0.0.1:abc".to_owned()],
        None
    )
    .is_err());
}

// ---------- 手写 HTTP 客户端端到端（真实本地 TCP 服务） ----------

/// 起一个极小 HTTP 服务线程：读请求头 + Content-Length 体，回 canned 响应后关闭。
fn spawn_canned_server(
    response: &'static [u8],
    request_log: std::sync::Arc<Mutex<Vec<String>>>,
) -> u16 {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").expect("本地回环监听");
    let port = listener.local_addr().expect("端口").port();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        // 读到头结束
        loop {
            let n = std::io::Read::read(&mut stream, &mut chunk).expect("读请求");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if find_header_end(&buf).is_some() {
                break;
            }
        }
        // 按 Content-Length 补读请求体
        let head = String::from_utf8_lossy(&buf).into_owned();
        let length = head
            .split("\r\n")
            .find_map(|l| {
                let (name, value) = l.split_once(':')?;
                if name.trim().eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let body_start = find_header_end(&buf).unwrap_or(buf.len());
        while buf.len() < body_start + length {
            let n = std::io::Read::read(&mut stream, &mut chunk).expect("读请求体");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        request_log.lock().expect("请求日志锁").push(text);
        std::io::Write::write_all(&mut stream, response).expect("写响应");
    });
    port
}

#[test]
fn http_client_roundtrip_content_length_response() {
    use std::sync::Arc;
    let log = Arc::new(Mutex::new(Vec::new()));
    let body = br#"{"ok":true,"checkpoint_id":"ckpt_e2e","node_state":null}"#;
    let response = format!(
        "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut wire = response.into_bytes();
    wire.extend_from_slice(body);
    let wire: &'static [u8] = Box::leak(wire.into_boxed_slice());
    let port = spawn_canned_server(wire, log.clone());
    let backend = HttpBackend::new(format!("http://127.0.0.1:{port}"));
    let response = backend
        .call(McpHttpRequest {
            method: "POST",
            path: "/api/v1/checkpoints".to_owned(),
            body: Some(json!({ "initiative_id": "init_x", "stage": "执行", "status": "SUCCESS", "input_context_hash": "h" })),
        })
        .expect("端到端请求应成功");
    assert_eq!(response.status, 201);
    assert_eq!(response.body["checkpoint_id"], "ckpt_e2e");
    let sent = log.lock().unwrap().join("");
    assert!(sent.starts_with("POST /api/v1/checkpoints HTTP/1.1\r\n"));
    assert!(sent.contains("Host: 127.0.0.1:"));
    assert!(sent.contains("Connection: close"));
    assert!(sent.contains("\"initiative_id\":\"init_x\""));
}

#[test]
fn http_client_decodes_chunked_response() {
    use std::sync::Arc;
    let log = Arc::new(Mutex::new(Vec::new()));
    let payload = "{\"ok\":true,\"text\":\"分块正文\"}".as_bytes();
    let chunk1 = &payload[..10];
    let chunk2 = &payload[10..];
    let wire = format!(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
        chunk1.len(),
        String::from_utf8_lossy(chunk1),
        chunk2.len(),
        String::from_utf8_lossy(chunk2),
    );
    let wire: &'static [u8] = Box::leak(wire.into_bytes().into_boxed_slice());
    let port = spawn_canned_server(wire, log.clone());
    let backend = HttpBackend::new(format!("http://127.0.0.1:{port}"));
    let response = backend
        .call(McpHttpRequest {
            method: "GET",
            path: "/api/v1/revisions/r/content".to_owned(),
            body: None,
        })
        .expect("chunked 响应应解码");
    assert_eq!(response.status, 200);
    assert_eq!(response.body["text"], "分块正文");
}

#[test]
fn http_client_non_json_response_lands_in_raw_text() {
    use std::sync::Arc;
    let log = Arc::new(Mutex::new(Vec::new()));
    let wire: &'static [u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello";
    let port = spawn_canned_server(wire, log.clone());
    let backend = HttpBackend::new(format!("http://127.0.0.1:{port}"));
    let response = backend
        .call(McpHttpRequest {
            method: "GET",
            path: "/api/v1/revisions/r/content?raw=1".to_owned(),
            body: None,
        })
        .expect("纯文本响应应成功");
    assert_eq!(response.status, 200);
    assert_eq!(response.body, Value::Null, "非 JSON → body 落 Null");
    assert_eq!(response.raw_text, "hello");
}

// ---------- urlencode ----------

#[test]
fn urlencode_keeps_path_chars_and_escapes_cjk_space() {
    assert_eq!(urlencode("docs/04/a.md"), "docs/04/a.md");
    assert_eq!(
        urlencode("docs/待 确认.md"),
        "docs/%E5%BE%85%20%E7%A1%AE%E8%AE%A4.md"
    );
}
