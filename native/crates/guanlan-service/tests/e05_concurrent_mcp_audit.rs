//! 多智能体并发 MCP 压测、权限沙箱审计与防篡改账本端到端集成测试。
//!
//! 量化验收口径：
//! 1. 启动真实 `guanlan serve` + **5 个并发 `guanlan mcp` stdio 子进程** + **2 条并发人类 UI HTTP 线程**，
//!    混合执行查询上下文（`get_context_bundle`）、全文检索（`search_workspace`）、读大文件（响应字节预算截断）、
//!    提交修订草案（CAS 护栏）、提交检查点、以及人类在 UI 浏览与原位拍板回写，累计 **>= 500 次真实请求**：
//!    - 零 panic、零死锁（有界耗时断言）、零 5xx、零锁死失败、响应字节预算 0 泄漏；
//!    - 全部路径逃逸与敏感凭据探测（`../outside-canary.txt`、盘符绝对路径、UNC、编码穿越、`.env`）100% 拦截，
//!      工作区外部金丝雀文件丝毫未动且零内容泄漏；
//!    - 并发 Agent 草案提交绝不覆写磁盘原稿；
//! 2. 账本哈希链与篡改诊断：
//!    - 压测完成后 `GET /api/v1/audit/ledger` 与 `guanlan audit --root <ws> --json` 均为 `ok: true`；
//!    - 人为篡改 SQLite 中任一条关键决定事件（`decision_writeback`），`GET /api/v1/audit/ledger` 与
//!      `guanlan audit` 均立即检出 `event_content_tampered` 并返回非零退出码（3）。

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const BIN_PATH: &str = env!("CARGO_BIN_EXE_guanlan");

struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self(Some(child))
    }

    fn as_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("child guard")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct TempEnv {
    base_dir: PathBuf,
    ws_root: PathBuf,
    data_dir: PathBuf,
    outside_canary: PathBuf,
}

impl TempEnv {
    fn new(tag: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base_dir =
            std::env::temp_dir().join(format!("guanlan-e05-{tag}-{}-{nonce}", std::process::id()));
        let ws_root = base_dir.join("workspace");
        let data_dir = base_dir.join("data");
        let outside_canary = base_dir.join("outside-canary.txt");
        fs::create_dir_all(ws_root.join("01-演示专项")).expect("创建工作区目录");
        fs::create_dir_all(&data_dir).expect("创建数据目录");
        fs::write(
            &outside_canary,
            "CANARY_OUTSIDE_WORKSPACE_DO_NOT_TOUCH_E05\n",
        )
        .expect("写外部金丝雀文件");
        Self {
            base_dir,
            ws_root,
            data_dir,
            outside_canary,
        }
    }
}

impl Drop for TempEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base_dir);
    }
}

/// 极简同步 HTTP/1.1 客户端（直连 127.0.0.1，零第三方依赖）
fn http_call(endpoint: &str, method: &str, path: &str, body: Option<&Value>) -> (u16, Value) {
    let rest = endpoint.strip_prefix("http://").expect("http endpoint");
    let mut stream = TcpStream::connect(rest).expect("连接测试服务");
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("读超时");
    stream
        .set_write_timeout(Some(Duration::from_secs(20)))
        .expect("写超时");
    let body_bytes = body
        .map(|v| serde_json::to_vec(v).expect("序列化 JSON"))
        .unwrap_or_default();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {rest}\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if !body_bytes.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).expect("发送请求头");
    if !body_bytes.is_empty() {
        stream.write_all(&body_bytes).expect("发送请求体");
    }
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("读取响应");
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("HTTP 头分隔符");
    let head = String::from_utf8_lossy(&raw[..sep]);
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .expect("状态码");
    let is_chunked = head.lines().any(|l| {
        l.to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
    });
    let body_slice = &raw[sep + 4..];
    let decoded = if is_chunked {
        decode_chunked(body_slice)
    } else {
        body_slice.to_vec()
    };
    let parsed = serde_json::from_slice(&decoded).unwrap_or(Value::Null);
    (status, parsed)
}

fn decode_chunked(mut input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(pos) = input.windows(2).position(|w| w == b"\r\n") {
        let len_str = String::from_utf8_lossy(&input[..pos]);
        let hex_part = len_str.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(hex_part, 16) else {
            break;
        };
        input = &input[pos + 2..];
        if size == 0 || input.len() < size {
            break;
        }
        out.extend_from_slice(&input[..size]);
        input = &input[size..];
        if input.starts_with(b"\r\n") {
            input = &input[2..];
        }
    }
    out
}

fn wait_for_endpoint(stdout: impl Read) -> String {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    for _ in 0..50 {
        line.clear();
        let n = reader.read_line(&mut line).expect("读 serve stdout");
        if n == 0 {
            panic!("guanlan serve 提前退出，未输出 GUANLAN_ENDPOINT");
        }
        if let Some(ep) = line.trim().strip_prefix("GUANLAN_ENDPOINT=") {
            return ep.trim().to_owned();
        }
    }
    panic!("未在预期行数内读到 GUANLAN_ENDPOINT");
}

fn find_index_db(data_dir: &Path) -> PathBuf {
    for entry in fs::read_dir(data_dir).expect("列举 data_dir").flatten() {
        let candidate = entry.path().join("index.db");
        if candidate.is_file() {
            return candidate;
        }
    }
    panic!("未在 {} 下找到 index.db", data_dir.display());
}

#[test]
fn e05_five_concurrent_mcp_clients_plus_ui_500_requests_sandbox_and_tamper_audit() {
    let env = TempEnv::new("stress");

    // 1. 构造含方案、待确认决策、大文档（>300KiB 触发 MCP 有界截断）及敏感 .env 的真实工作区
    let arch_orig =
        "# 观澜并发架构方案\n\n核心目标：保障多智能体并发访问零死锁、零越界、零篡改。\n";
    let plan_orig = "# 实施计划\n\n阶段一：并发 MCP 压测与权限沙箱加固。\n";
    let decisions_orig = concat!(
        "# 待确认事项\n\n",
        "- [P0 - 待确认] **并发写入安全网策略**：外部智能体写入必须先落独立草案分支 `v(N+1)-agent-draft`。\n",
        "  - 决定：___ · 确认人：___\n",
        "- [P1 - 待确认] **账本哈希链诊断模式**：CLI 诊断命令默认以只读连接零副作用运行。\n",
        "  - 决定：___ · 确认人：___\n",
    );
    let huge_doc = format!(
        "# 大文档响应预算压测\n\n{}",
        "观澜响应字节预算压测段落-ABCDEFG-0123456789\n".repeat(7_500)
    );
    assert!(
        huge_doc.len() > 300 * 1024,
        "大文档应大于 300KiB 以触发截断"
    );

    let arch_path = env.ws_root.join("01-演示专项/01-架构方案.md");
    fs::write(&arch_path, arch_orig).expect("写架构方案");
    fs::write(env.ws_root.join("01-演示专项/02-实施计划.md"), plan_orig).expect("写实施计划");
    fs::write(
        env.ws_root.join("01-演示专项/03-待确认事项.md"),
        decisions_orig,
    )
    .expect("写待确认事项");
    fs::write(env.ws_root.join("01-演示专项/04-大文档压测.md"), &huge_doc).expect("写大文档");
    fs::write(
        env.ws_root.join(".env"),
        "OPENAI_API_KEY=sk-e05-secret-never-leak-1234567890\n",
    )
    .expect("写敏感 .env");

    // 2. 运行真实 `guanlan scan` 建库并创建派生全文索引
    let scan_out = Command::new(BIN_PATH)
        .args([
            "scan",
            "--root",
            env.ws_root.to_str().unwrap(),
            "--initiative-dir",
            "01-演示专项",
        ])
        .env("GUANLAN_DATA_DIR", &env.data_dir)
        .output()
        .expect("执行 guanlan scan");
    assert!(
        scan_out.status.success(),
        "guanlan scan 失败：stderr={}",
        String::from_utf8_lossy(&scan_out.stderr)
    );

    // 3. 启动真实 `guanlan serve --root <ws> --port 0`
    let mut serve_child = ChildGuard::new(
        Command::new(BIN_PATH)
            .args([
                "serve",
                "--root",
                env.ws_root.to_str().unwrap(),
                "--port",
                "0",
            ])
            .env("GUANLAN_DATA_DIR", &env.data_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("启动 guanlan serve"),
    );
    let serve_stdout = serve_child.as_mut().stdout.take().expect("serve stdout");
    let endpoint = wait_for_endpoint(serve_stdout);

    // 预取待确认陈述 ID 与专项 ID 供并发 UI 拍板与 MCP 检查点使用
    let (st, files_body) = http_call(&endpoint, "GET", "/api/v1/files?limit=50", None);
    assert_eq!(st, 200);
    let decision_file_id = files_body["items"]
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|item| {
                item["relative_path"]
                    .as_str()
                    .map(|p| p.ends_with("03-待确认事项.md"))
                    .unwrap_or(false)
            })
        })
        .and_then(|item| item["file_id"].as_str())
        .expect("应找到 03-待确认事项.md 的 file_id")
        .to_owned();
    let (st, stmt_body) = http_call(
        &endpoint,
        "GET",
        &format!("/api/v1/statements?file_id={decision_file_id}&status=pending"),
        None,
    );
    assert_eq!(st, 200, "查询陈述失败：{stmt_body}");
    let pending_stmt_id = stmt_body["items"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|item| item["statement_id"].as_str())
        .expect("应存在待确认陈述")
        .to_owned();

    let (st, ov_body) = http_call(&endpoint, "GET", "/api/v1/state-overview", None);
    assert_eq!(st, 200);
    let initiative_id = ov_body["initiatives"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|item| item["initiative_id"].as_str())
        .expect("应存在演示专项")
        .to_owned();

    // 4. 并发压测：5 路真实 `guanlan mcp` stdio 客户端（每路 85 次 RPC = 425 次）+ 2 路 UI HTTP 线程（每路 60 次 = 120 次）= 545 次真实请求
    let started = Instant::now();
    let total_requests = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();

    for agent_idx in 0..5usize {
        let ep = endpoint.clone();
        let init_id = initiative_id.clone();
        let outside_abs = env.outside_canary.to_string_lossy().into_owned();
        let counter = Arc::clone(&total_requests);

        handles.push(std::thread::spawn(move || {
            let mut mcp = ChildGuard::new(
                Command::new(BIN_PATH)
                    .args(["mcp", "--endpoint", &ep])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("启动 guanlan mcp"),
            );
            let mut stdin = mcp.as_mut().stdin.take().expect("mcp stdin");
            let stdout = mcp.as_mut().stdout.take().expect("mcp stdout");
            let mut reader = BufReader::new(stdout);
            let mut rpc_id: u64 = 1;

            let mut send_rpc = |method: &str, params: Value| -> Value {
                let id = rpc_id;
                rpc_id += 1;
                let msg = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                });
                writeln!(stdin, "{msg}").expect("写入 MCP stdin");
                stdin.flush().expect("flush MCP stdin");
                let mut line = String::new();
                let n = reader.read_line(&mut line).expect("读取 MCP stdout");
                assert!(n > 0, "Agent {agent_idx} MCP 通道提前 EOF（id={id}）");
                counter.fetch_add(1, Ordering::Relaxed);
                let reply: Value = serde_json::from_str(line.trim()).expect("解析 MCP JSON-RPC 响应");
                assert_eq!(reply["id"], id, "JSON-RPC id 必须一一对应");
                reply
            };

            // (a) 协议握手与工具列举（3 次）
            let init = send_rpc("initialize", json!({ "protocolVersion": "2024-11-05" }));
            assert_eq!(init["result"]["serverInfo"]["name"], "guanlan-mcp");
            let tools = send_rpc("tools/list", json!({}));
            assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 6);
            let _ = send_rpc("ping", json!({}));

            // (b) 权限沙箱与敏感路径攻击探测（6 次）
            let attacks = [
                "../outside-canary.txt".to_owned(),
                "guanlan://../outside-canary.txt".to_owned(),
                outside_abs,
                r"\\evil-share\corp\secret.md".to_owned(),
                "01-演示专项/%2e%2e/outside-canary.txt".to_owned(),
                ".env".to_owned(),
            ];
            for attack in &attacks {
                let r = send_rpc(
                    "tools/call",
                    json!({
                        "name": "guanlan.read_artifact",
                        "arguments": { "path": attack }
                    }),
                );
                assert_eq!(
                    r["result"]["isError"], true,
                    "Agent {agent_idx} 越界/敏感读取必须被拦截：{attack}"
                );
                let txt = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                assert!(
                    txt.contains("PATH_ESCAPE_DENIED") || txt.contains("SECRET_PATH_DENIED"),
                    "应返回明确沙箱拒绝码：{txt}"
                );
                assert!(
                    !txt.contains("CANARY_OUTSIDE_WORKSPACE") && !txt.contains("sk-e05-secret"),
                    "绝不允许任何越界或密钥内容泄漏"
                );
            }

            // (c) 76 次混合高频业务调用（上下文组装 + 全文检索 + 常规读取 + 大包截断 + 草案提交 + 检查点）
            for round in 0..76usize {
                match round % 6 {
                    0 => {
                        let r = send_rpc(
                            "tools/call",
                            json!({
                                "name": "guanlan.get_context_bundle",
                                "arguments": {
                                    "uri": "guanlan://01-演示专项/01-架构方案.md",
                                    "budget_tokens": 4096,
                                    "mode": "both"
                                }
                            }),
                        );
                        assert_ne!(
                            r["result"]["isError"], true,
                            "Agent {agent_idx} get_context_bundle 失败：{r}"
                        );
                    }
                    1 => {
                        let r = send_rpc(
                            "tools/call",
                            json!({
                                "name": "guanlan.search_workspace",
                                "arguments": {
                                    "q": "并发架构",
                                    "path_prefix": "01-演示专项",
                                    "limit": 10
                                }
                            }),
                        );
                        assert_ne!(
                            r["result"]["isError"], true,
                            "Agent {agent_idx} search_workspace 失败：{r}"
                        );
                        let body_text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                        assert!(
                            !body_text.contains(".env"),
                            "MCP 检索结果绝不透出敏感凭据文件"
                        );
                    }
                    2 => {
                        let r = send_rpc(
                            "tools/call",
                            json!({
                                "name": "guanlan.read_artifact",
                                "arguments": { "uri": "guanlan://01-演示专项/02-实施计划.md" }
                            }),
                        );
                        assert_ne!(r["result"]["isError"], true);
                        let body_text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                        assert!(body_text.contains("实施计划"));
                    }
                    3 => {
                        // 大文档读取：验证 MCP 有界截断（256 KiB）
                        let r = send_rpc(
                            "tools/call",
                            json!({
                                "name": "guanlan.read_artifact",
                                "arguments": { "path": "01-演示专项/04-大文档压测.md" }
                            }),
                        );
                        assert_ne!(r["result"]["isError"], true);
                        let parsed: Value = serde_json::from_str(
                            r["result"]["content"][0]["text"].as_str().unwrap_or("{}"),
                        )
                        .expect("大文档 JSON");
                        assert_eq!(parsed["truncated"], true, "大文档必须触发有界截断");
                        let ret_bytes = parsed["returned_bytes"].as_u64().unwrap_or(u64::MAX);
                        assert!(ret_bytes <= 256 * 1024, "返回字节不得超出 256KiB 预算");
                    }
                    4 => {
                        // 仅在少数轮次提交并发草案（避免 5 路频繁写盘拥塞，仍保证多路真实竞争）
                        if round < 12 {
                            let r = send_rpc(
                                "tools/call",
                                json!({
                                    "name": "guanlan.propose_revision",
                                    "arguments": {
                                        "path": "01-演示专项/01-架构方案.md",
                                        "content": format!("# 观澜并发架构方案\n\nAgent {agent_idx} 第 {round} 轮草案提案。\n"),
                                        "note": format!("Agent {agent_idx} 并发草案 #{round}"),
                                        "receipt_summary": format!("并发压测回执 A{agent_idx}-R{round}")
                                    }
                                }),
                            );
                            assert_ne!(
                                r["result"]["isError"], true,
                                "Agent {agent_idx} propose_revision 失败：{r}"
                            );
                        } else {
                            let r = send_rpc(
                                "tools/call",
                                json!({
                                    "name": "guanlan.search_workspace",
                                    "arguments": { "q": "安全网", "limit": 5 }
                                }),
                            );
                            assert_ne!(r["result"]["isError"], true);
                        }
                    }
                    _ => {
                        if round == 5 && agent_idx < 3 {
                            let r = send_rpc(
                                "tools/call",
                                json!({
                                    "name": "guanlan.commit_checkpoint",
                                    "arguments": {
                                        "initiative_id": init_id,
                                        "stage": "执行",
                                        "status": "FAILED_RETRYABLE",
                                        "input_context_hash": format!("e05_ctx_agent_{agent_idx}"),
                                        "note": format!("Agent {agent_idx} 压测检查点")
                                    }
                                }),
                            );
                            assert_ne!(
                                r["result"]["isError"], true,
                                "Agent {agent_idx} commit_checkpoint 失败：{r}"
                            );
                        } else {
                            let r = send_rpc("ping", json!({}));
                            assert!(r["result"].is_object());
                        }
                    }
                }
            }

            // 优雅关闭 stdin，等待子进程正常退出（退出码 0）
            drop(stdin);
            let status = mcp.as_mut().wait().expect("等待 MCP 子进程退出");
            assert!(status.success(), "Agent {agent_idx} MCP 退出码异常：{status}");
        }));
    }

    // 2 条人类 UI 并发线程（模拟浏览面板、检索、批阅看板、与原位拍板回写）
    for ui_idx in 0..2usize {
        let ep = endpoint.clone();
        let stmt_id = pending_stmt_id.clone();
        let counter = Arc::clone(&total_requests);

        handles.push(std::thread::spawn(move || {
            for step in 0..60usize {
                if ui_idx == 0 && step == 10 {
                    // 人类在 5 路 MCP 压测高峰期间原位拍板（写入原 .md + 账本哈希链封存）
                    let (status, body) = http_call(
                        &ep,
                        "POST",
                        &format!("/api/v1/decisions/{stmt_id}/resolve"),
                        Some(&json!({
                            "decision": "确认通过：强制走独立草案分支并启用 CAS",
                            "confirmer": "主公",
                            "role": "负责人"
                        })),
                    );
                    counter.fetch_add(1, Ordering::Relaxed);
                    assert_eq!(status, 202, "原位拍板应受理 202：{body}");
                    let job_id = body["job_id"].as_str().expect("job_id");
                    for _ in 0..50 {
                        let (js, jb) =
                            http_call(&ep, "GET", &format!("/api/v1/jobs/{job_id}"), None);
                        assert_eq!(js, 200);
                        let state = jb["state"].as_str().unwrap_or("");
                        if state == "completed" {
                            break;
                        }
                        assert_ne!(state, "failed", "并发压测期间拍板任务不应失败：{jb}");
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    continue;
                }

                let route = match step % 6 {
                    0 => "/api/v1/state-overview",
                    1 => "/api/v1/review-board",
                    2 => "/api/v1/files?limit=20",
                    3 => "/api/v1/search?q=MCP&limit=10",
                    4 => "/api/v1/revision-proposals",
                    _ => "/api/v1/audit/ledger",
                };
                let (status, body) = http_call(&ep, "GET", route, None);
                counter.fetch_add(1, Ordering::Relaxed);
                assert_eq!(
                    status, 200,
                    "UI 线程 {ui_idx} 请求 {route} 状态异常：{status} body={body}"
                );
                assert_eq!(
                    body["ok"], true,
                    "UI 线程 {ui_idx} 请求 {route} 应返回 ok=true"
                );
            }
        }));
    }

    for handle in handles {
        handle.join().expect("并发工作线程绝不能 panic");
    }

    let elapsed = started.elapsed();
    let total = total_requests.load(Ordering::Relaxed);
    assert!(total >= 500, "并发压测总请求数必须 >= 500，实际：{total}");
    assert!(
        elapsed < Duration::from_secs(90),
        "并发压测耗时过长（疑似死锁或严重锁竞争）：{elapsed:?}"
    );

    // 5. 核验零越界、零原稿覆写、响应字节预算零泄漏、与账本哈希链完好
    assert_eq!(
        fs::read_to_string(&env.outside_canary).expect("读外部金丝雀"),
        "CANARY_OUTSIDE_WORKSPACE_DO_NOT_TOUCH_E05\n",
        "工作区外金丝雀文件绝不能被修改"
    );
    assert_eq!(
        fs::read_to_string(&arch_path).expect("读原稿"),
        arch_orig,
        "并发 Agent 提交的修订草案绝不能直接覆盖工作区磁盘原稿"
    );

    let (audit_status, audit_body) = http_call(&endpoint, "GET", "/api/v1/audit/ledger", None);
    assert_eq!(audit_status, 200);
    assert_eq!(audit_body["ok"], true, "完好账本审计必须通过：{audit_body}");
    assert_eq!(audit_body["ledger"]["ok"], true);
    assert_eq!(audit_body["sandbox"]["ok"], true);
    assert_eq!(
        audit_body["response_budget"]["in_use_bytes"], 0,
        "压测结束后响应字节预算必须 100% 归还"
    );
    let verified_entries = audit_body["ledger"]["verified_entries"]
        .as_u64()
        .unwrap_or(0);
    assert!(
        verified_entries >= 6,
        "应至少封存了拍板 + 多路草案 + 检查点关键事件，实际：{verified_entries}"
    );

    // CLI 诊断命令 `guanlan audit` 完好态退出码 0
    let audit_cli_ok = Command::new(BIN_PATH)
        .args(["audit", "--root", env.ws_root.to_str().unwrap(), "--json"])
        .env("GUANLAN_DATA_DIR", &env.data_dir)
        .output()
        .expect("执行 guanlan audit");
    assert!(
        audit_cli_ok.status.success(),
        "完好账本 guanlan audit 应返回退出码 0：stdout={} stderr={}",
        String::from_utf8_lossy(&audit_cli_ok.stdout),
        String::from_utf8_lossy(&audit_cli_ok.stderr)
    );

    // 6. 篡改核验：直接修改 SQLite 中关键决定事件，HTTP 审计端点与 CLI 诊断命令必须立即检出
    let db_path = find_index_db(&env.data_dir);
    {
        let conn = rusqlite::Connection::open(&db_path).expect("打开 index.db 模拟篡改");
        let changed = conn
            .execute(
                "UPDATE events SET detail = '恶意篡改：跳过人类审阅直接放行' WHERE kind = 'decision_writeback'",
                [],
            )
            .expect("执行篡改 SQL");
        assert!(
            changed >= 1,
            "应存在至少 1 条 decision_writeback 供篡改核验"
        );
    }

    let (tamper_http_status, tamper_http_body) =
        http_call(&endpoint, "GET", "/api/v1/audit/ledger", None);
    assert_eq!(tamper_http_status, 200);
    assert_eq!(
        tamper_http_body["ok"], false,
        "篡改决定账本后 HTTP 审计必须立即报错：{tamper_http_body}"
    );
    let http_issues = tamper_http_body["ledger"]["issues"]
        .as_array()
        .expect("issues");
    assert!(
        http_issues
            .iter()
            .any(|i| i["code"] == "event_content_tampered"),
        "HTTP 审计应定位到 event_content_tampered：{tamper_http_body}"
    );

    let audit_cli_tampered = Command::new(BIN_PATH)
        .args(["audit", "--root", env.ws_root.to_str().unwrap(), "--json"])
        .env("GUANLAN_DATA_DIR", &env.data_dir)
        .output()
        .expect("篡改后执行 guanlan audit");
    assert_eq!(
        audit_cli_tampered.status.code(),
        Some(3),
        "篡改决定账本后 guanlan audit 必须以非零退出码 3 立即报警"
    );
    let cli_json: Value =
        serde_json::from_slice(&audit_cli_tampered.stdout).expect("解析 audit JSON");
    assert_eq!(cli_json["ok"], false);
    assert!(
        cli_json["ledger"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["code"] == "event_content_tampered"),
        "CLI 诊断 JSON 必须明确标出 event_content_tampered：{cli_json}"
    );
}

#[test]
fn e05_response_budget_413_fallback_and_forged_unsealed_event_audit() {
    let env = TempEnv::new("budget413");
    // 构造 > 1 MiB 文本文件，配合 GUANLAN_RESPONSE_MAX_MIB=1 触发服务端真实 413 内联预算拒收 → MCP raw=1 流式回退 + 256KiB 截断
    let mega_doc = format!(
        "# 兆字节大文档预算测试\n\n{}",
        "观澜大包响应预算与流式回退验证行-0123456789ABCDEF\n".repeat(24_000)
    );
    assert!(mega_doc.len() > 1024 * 1024);
    fs::write(env.ws_root.join("01-演示专项/mega.md"), &mega_doc).expect("写 1MiB+ 文件");

    let scan = Command::new(BIN_PATH)
        .args(["scan", "--root", env.ws_root.to_str().unwrap()])
        .env("GUANLAN_DATA_DIR", &env.data_dir)
        .output()
        .expect("scan");
    assert!(scan.status.success());

    let mut serve = ChildGuard::new(
        Command::new(BIN_PATH)
            .args([
                "serve",
                "--root",
                env.ws_root.to_str().unwrap(),
                "--port",
                "0",
            ])
            .env("GUANLAN_DATA_DIR", &env.data_dir)
            .env("GUANLAN_RESPONSE_MAX_MIB", "1")
            .env("GUANLAN_RESPONSE_BUDGET_MIB", "2")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("serve"),
    );
    let ep = wait_for_endpoint(serve.as_mut().stdout.take().expect("stdout"));

    // 1. 直接 HTTP 读内联内容应返回 413（UNSUPPORTED_CONTENT）
    let (st, files_body) = http_call(&ep, "GET", "/api/v1/files?limit=10", None);
    assert_eq!(st, 200);
    let rev_id = files_body["items"][0]["current_revision_id"]
        .as_str()
        .expect("rev_id");
    let (inline_st, inline_body) = http_call(
        &ep,
        "GET",
        &format!("/api/v1/revisions/{rev_id}/content"),
        None,
    );
    assert_eq!(
        inline_st, 413,
        "超过单响应 1MiB 预算必须返回 413：{inline_body}"
    );

    // 2. 通过真实 `guanlan mcp` 调用 read_artifact 应自动回退 raw=1 并按 256 KiB 截断
    let mut mcp = ChildGuard::new(
        Command::new(BIN_PATH)
            .args(["mcp", "--endpoint", &ep])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("mcp"),
    );
    let mut stdin = mcp.as_mut().stdin.take().unwrap();
    let mut reader = BufReader::new(mcp.as_mut().stdout.take().unwrap());
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "guanlan.read_artifact",
            "arguments": { "path": "01-演示专项/mega.md" }
        }
    });
    writeln!(stdin, "{req}").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(line.trim()).unwrap();
    assert_ne!(reply["result"]["isError"], true);
    let payload: Value =
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(payload["truncated"], true);
    assert!(payload["returned_bytes"].as_u64().unwrap() <= 256 * 1024);
    assert!(
        payload["total_bytes"].as_u64().unwrap() > 1024 * 1024,
        "应如实报告原始总字节"
    );
    drop(stdin);
    assert!(mcp.as_mut().wait().unwrap().success());

    // 3. 验证预算 0 泄漏 + 绕过账本伪造未封存 decision_writeback 可被 `guanlan audit` 立即拦截
    let (_, audit_clean) = http_call(&ep, "GET", "/api/v1/audit/ledger", None);
    assert_eq!(audit_clean["response_budget"]["in_use_bytes"], 0);
    assert_eq!(audit_clean["ok"], true);

    let db_path = find_index_db(&env.data_dir);
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let ws_id: String = conn
            .query_row("SELECT workspace_id FROM workspaces LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        // 先写入一条 meta head（模拟链曾启用）并伪造未封存决策事件
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('ledger_chain_head_seq', '1')
             ON CONFLICT (key) DO UPDATE SET value = '1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO events (event_id, workspace_id, kind, subject_kind, subject_id, revision_id,
                occurred_at, occurred_precision, occurred_source, observed_at, headline, detail, payload_json, batch_id)
             VALUES ('evt_forged_e05', ?, 'decision_writeback', 'decision', 'dec_forged', NULL,
                     '2026-11-21T23:55:00Z', 'second', 'system', '2026-11-21T23:55:00Z', '伪造拍板', '绕过账本注入', '{}', NULL)",
            [&ws_id],
        )
        .unwrap();
    }

    let cli_forged = Command::new(BIN_PATH)
        .args(["audit", "--root", env.ws_root.to_str().unwrap(), "--json"])
        .env("GUANLAN_DATA_DIR", &env.data_dir)
        .output()
        .unwrap();
    assert_eq!(cli_forged.status.code(), Some(3));
    let forged_json: Value = serde_json::from_slice(&cli_forged.stdout).unwrap();
    assert_eq!(forged_json["ok"], false);
    assert!(
        forged_json["ledger"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["code"] == "unsealed_decision_event"),
        "应检出绕过账本伪造的决定事件：{forged_json}"
    );
}
