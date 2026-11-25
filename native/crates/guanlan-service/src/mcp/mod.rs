//! MCP stdio 代理（contract-query-api.md §2.2；外部智能体通过 MCP 读取与回写的承载实现）。
//!
//! 设计约定：
//! - 手写 JSON-RPC 2.0 over stdio（无 SDK；stdio 传输 = 按行分隔的 JSON 消息）；
//! - 端点 = `--endpoint` 参数或 `GUANLAN_ENDPOINT` env，两者皆缺 → stderr 一行
//!   统一错误包络 + 退出码 1（不猜端口：serve 缺省 port=0 内核随机分配，端点
//!   权威值仅在启动 stdout 的 GUANLAN_ENDPOINT 行）；
//! - 6 工具：四个基础读写与检查点工具（`guanlan.read_artifact` /
//!   `guanlan.propose_revision` / `guanlan.resolve_decision` / `guanlan.commit_checkpoint`）
//!   加上下文包组装 `guanlan.get_context_bundle` 与全文检索 `guanlan.search_workspace`，
//!   全部转发到同一工作区服务的 HTTP 等价端点——代理不开数据库、
//!   不扫目录、不维护另一套历史；
//! - HTTP 客户端同样手写（std::net::TcpStream 阻塞 + Connection: close）：
//!   端点恒为本地 http（127.0.0.1），不引入额外第三方 crate。
//!
//! 工具语义（与服务端 HTTP 端点一一对应）：
//! - read_artifact：path/uri（guanlan://<相对路径>）→ GET /files?q= 精确匹配 →
//!   GET /revisions/{id}/content（md/svg 内联 text；413 超预算回退 raw=1 纯文本；
//!   pdf 返回 raw_url 指引）；
//! - propose_revision：content + file_id|path（base 缺省取当前版）→ POST
//!   /revision-proposals（202）→ 有界轮询 /jobs/{id} 至终态，回报 report.proposal；
//! - resolve_decision：statement_id/decision/confirmer → POST
//!   /decisions/{id}/resolve（恒 202）→ 轮询至终态，回报 report.writeback（含 CAS）；
//! - commit_checkpoint：载荷直传 → POST /checkpoints（同步 201）；
//! - get_context_bundle：path/uri 先解析为 file_id → POST /context（Token 预算感知
//!   上下文包，与观澜前端预览区同源）；
//! - search_workspace：q + path_prefix/format/limit → GET /search（path_prefix 经
//!   沙箱校验，结果里的敏感凭据路径再过滤一遍）。
//!
//! 协议面：initialize（回显客户端 protocolVersion，缺省钉 2024-11-05——stdio 传输
//! 逐行 JSON 与版本无关，回显为最大兼容口径）/ initialized 通知忽略 / tools/list /
//! tools/call / ping；未知方法 → -32601，未知工具名 → -32602，解析失败 → -32700。
//! 工具级失败（HTTP 4xx/5xx、路径未命中、任务失败）以 isError 结果回传，不断协议。

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{json, Value};

use guanlan_core::error::GuanlanError;

/// 四个基础读写/检查点工具（固定顺序）+ 上下文包组装 + 全文检索（全量受路径沙箱护栏约束）
pub(crate) const TOOL_NAMES: [&str; 6] = [
    "guanlan.read_artifact",
    "guanlan.propose_revision",
    "guanlan.resolve_decision",
    "guanlan.commit_checkpoint",
    "guanlan.get_context_bundle",
    "guanlan.search_workspace",
];

/// 单次 HTTP 代理响应体读取硬上限（16 MiB），防止异常大包击穿 MCP 代理进程内存
const MCP_MAX_HTTP_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
/// `guanlan.read_artifact` 返回文本有界截断上限（256 KiB），超限按 UTF-8 字符边界安全截断并显式标注
const MCP_MAX_READ_TEXT_BYTES: usize = 256 * 1024;

/// initialize 未回显客户端版本时的钉定协议版本
const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";

/// 单请求读写超时（本地回环；job 轮询是多次独立请求，不是单请求长挂）
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
/// 连接超时（服务未启动时快速失败）
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// 提交类工具（202 job）的有界轮询：300ms × 33 ≈ 10s 封顶
const JOB_POLL_ATTEMPTS: u32 = 33;
const JOB_POLL_INTERVAL: Duration = Duration::from_millis(300);

// ================= 端点解析（不猜端口） =================

/// `--endpoint <url>` 参数优先，其次 `GUANLAN_ENDPOINT` env（测试注入，不读进程环境）；
/// 两者皆缺 → Err（调用方 stderr 包络 + 退出码 1）。仅接受 http://（本地回环口径；
/// https 无 TLS 客户端实现，显式报错而非静默降级）。
fn resolve_endpoint(args: &[String], env: Option<&str>) -> Result<String, GuanlanError> {
    let mut from_args: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--endpoint" {
            from_args = args.get(i + 1).cloned();
            i += 2;
            continue;
        }
        if let Some(rest) = arg.strip_prefix("--endpoint=") {
            from_args = Some(rest.to_owned());
        }
        i += 1;
    }
    let raw = from_args
        .or_else(|| env.map(str::to_owned))
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            GuanlanError::BadRequest(
                "guanlan mcp 需要服务端点：--endpoint 参数或 GUANLAN_ENDPOINT 环境变量（权威值见 guanlan serve 启动输出的 GUANLAN_ENDPOINT 行）".to_owned(),
            )
        })?;
    let trimmed = raw.trim().trim_end_matches('/').to_owned();
    if !trimmed.starts_with("http://") {
        return Err(GuanlanError::BadRequest(format!(
            "MCP 代理仅支持本地 http 端点，收到「{raw}」"
        )));
    }
    let rest = &trimmed["http://".len()..];
    // host:port（IPv4/localhost 口径；本地服务恒为 127.0.0.1 或 localhost）
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => {
            return Err(GuanlanError::BadRequest(format!(
                "端点缺端口：{raw}（如 http://127.0.0.1:39120）"
            )))
        }
    };
    if host.is_empty() || port.parse::<u16>().is_err() {
        return Err(GuanlanError::BadRequest(format!(
            "端点 host:port 无法解析：{raw}"
        )));
    }
    Ok(trimmed)
}

// ================= 最小 HTTP/1.1 客户端（手写，无新依赖） =================

/// 代理发往服务的请求（method 限定已知集合故用 &'static str）
#[derive(Debug, Clone)]
pub(crate) struct McpHttpRequest {
    pub method: &'static str,
    /// 含查询串，如 `/api/v1/files?q=...`
    pub path: String,
    pub body: Option<Value>,
}

/// 服务响应：status + 尽力 JSON（非 JSON 响应如 raw=1 纯文本落 `raw_text`）
#[derive(Debug, Clone)]
pub(crate) struct McpHttpResponse {
    pub status: u16,
    pub body: Value,
    /// 响应体原文（JSON 解析失败时工具层可用，如 raw=1 纯文本）
    pub raw_text: String,
}

impl McpHttpResponse {
    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// 统一错误包络提取（契约 §0.2 {ok,code,error,detail}）→ 工具错误文案
    fn error_text(&self) -> String {
        let code = self.body.get("code").and_then(Value::as_str).unwrap_or("");
        let error = self.body.get("error").and_then(Value::as_str).unwrap_or("");
        if code.is_empty() && error.is_empty() {
            format!("HTTP {}", self.status)
        } else {
            format!("HTTP {} {}: {}", self.status, code, error)
        }
    }
}

/// 代理后端（HTTP 客户端与测试 mock 的共同接口）
pub(crate) trait McpBackend {
    fn call(&self, req: McpHttpRequest) -> Result<McpHttpResponse, String>;
}

/// 阻塞式 HTTP 后端：每请求一条连接（Connection: close），读至对端关闭。
struct HttpBackend {
    endpoint: String,
}

impl HttpBackend {
    fn new(endpoint: String) -> Self {
        Self { endpoint }
    }

    fn host_port(&self) -> Result<(String, u16), String> {
        let rest = &self.endpoint["http://".len()..];
        let (host, port) = rest
            .rsplit_once(':')
            .ok_or_else(|| format!("端点缺端口：{}", self.endpoint))?;
        let port = port
            .parse::<u16>()
            .map_err(|_| format!("端点端口无法解析：{}", self.endpoint))?;
        Ok((host.to_owned(), port))
    }
}

impl McpBackend for HttpBackend {
    fn call(&self, req: McpHttpRequest) -> Result<McpHttpResponse, String> {
        let (host, port) = self.host_port()?;
        let body_bytes = match &req.body {
            Some(value) => serde_json::to_vec(value).map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        let mut stream = std::net::TcpStream::connect_timeout(
            &format!("{host}:{port}")
                .parse()
                .map_err(|e| format!("端点解析失败：{e}"))?,
            CONNECT_TIMEOUT,
        )
        .map_err(|e| format!("连接服务失败 {host}:{port}：{e}"))?;
        stream
            .set_read_timeout(Some(HTTP_TIMEOUT))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(HTTP_TIMEOUT))
            .map_err(|e| e.to_string())?;

        let mut head = format!(
            "{} {} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n",
            req.method, req.path
        );
        if !body_bytes.is_empty() {
            head.push_str("Content-Type: application/json\r\n");
            head.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
        }
        head.push_str("\r\n");
        stream
            .write_all(head.as_bytes())
            .map_err(|e| format!("请求发送失败：{e}"))?;
        if !body_bytes.is_empty() {
            stream
                .write_all(&body_bytes)
                .map_err(|e| format!("请求体发送失败：{e}"))?;
        }

        let mut raw = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(&mut stream, MCP_MAX_HTTP_RESPONSE_BYTES + 1),
            &mut raw,
        )
        .map_err(|e| format!("响应读取失败：{e}"))?;
        if raw.len() as u64 > MCP_MAX_HTTP_RESPONSE_BYTES {
            return Err(format!(
                "MCP 响应体超过单次代理预算上限 {} 字节（已截断拒绝，请缩小请求范围）",
                MCP_MAX_HTTP_RESPONSE_BYTES
            ));
        }
        parse_http_response(&raw)
    }
}

/// 解析 HTTP 响应字节：状态行 + 头 + 体（Content-Length 或 chunked 或读到 EOF）。
fn parse_http_response(raw: &[u8]) -> Result<McpHttpResponse, String> {
    let body_start = find_header_end(raw).ok_or_else(|| "响应缺少头部分隔符".to_owned())?;
    let head = String::from_utf8_lossy(&raw[..body_start]).to_string();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("状态行无法解析：{status_line}"))?;
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            content_length = value.parse::<usize>().ok();
        } else if name == "transfer-encoding" && value.eq_ignore_ascii_case("chunked") {
            chunked = true;
        }
    }
    let body_bytes = &raw[body_start..];
    let chunked_body;
    let body_bytes = if chunked {
        chunked_body = decode_chunked(body_bytes);
        chunked_body.as_slice()
    } else if let Some(len) = content_length {
        &body_bytes[..len.min(body_bytes.len())]
    } else {
        body_bytes
    };
    let text = String::from_utf8_lossy(body_bytes).into_owned();
    let body = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(McpHttpResponse {
        status,
        body,
        raw_text: text,
    })
}

/// 定位 `\r\n\r\n`，返回体起始偏移（头部分隔符之后）
fn find_header_end(raw: &[u8]) -> Option<usize> {
    let needle = b"\r\n\r\n";
    (0..=raw.len().saturating_sub(needle.len()))
        .find(|&i| &raw[i..i + 4] == needle)
        .map(|i| i + 4)
}

/// chunked 解码（hex 长度行 + 数据 + CRLF，0 结尾）
fn decode_chunked(mut body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = find_crlf(body) {
        let size_line = String::from_utf8_lossy(&body[..line_end]).into_owned();
        let size_text = size_line.split(';').next().unwrap_or("").trim().to_owned();
        let Ok(size) = usize::from_str_radix(&size_text, 16) else {
            break;
        };
        body = &body[line_end + 2..];
        if size == 0 || body.len() < size {
            break;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size..];
        // 跳过 chunk 数据后的 CRLF
        if body.starts_with(b"\r\n") {
            body = &body[2..];
        }
    }
    out
}

fn find_crlf(raw: &[u8]) -> Option<usize> {
    (0..raw.len().saturating_sub(1)).find(|&i| raw[i] == b'\r' && raw[i + 1] == b'\n')
}

// ================= JSON-RPC 2.0 over stdio（手写，无 SDK） =================

/// `guanlan mcp` 子命令入口（main.rs 调用）：端点缺失 → stderr 包络 + 退出码 1；
/// stdio 通道结束（EOF/写失败）以非零码退出。
pub fn run(args: &[String]) {
    let endpoint = match resolve_endpoint(args, std::env::var("GUANLAN_ENDPOINT").ok().as_deref()) {
        Ok(endpoint) => endpoint,
        Err(err) => {
            let envelope = err.to_envelope(None);
            eprintln!(
                "{}",
                serde_json::to_string(&envelope).unwrap_or_else(|_| format!(
                    "{{\"ok\":false,\"code\":\"{}\",\"error\":\"MCP 启动失败\"}}",
                    err.code()
                ))
            );
            std::process::exit(1);
        }
    };
    eprintln!("guanlan mcp stdio 代理就绪：endpoint={endpoint}");
    let backend = HttpBackend::new(endpoint);
    if let Err(e) = serve_stdio(&backend) {
        eprintln!("MCP stdio 通道结束：{e}");
        std::process::exit(1);
    }
}

/// stdio 主循环：逐行读 JSON-RPC 消息，有响应即写一行（行分隔 JSON 传输）。
/// EOF（客户端断开）正常退出。stderr 只走诊断，不污染 stdout 协议面。
pub(crate) fn serve_stdio<B: McpBackend>(backend: &B) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut out = stdout.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(trimmed) {
            Ok(msg) => handle_message(&msg, backend),
            Err(err) => Some(rpc_error(
                Value::Null,
                -32700,
                format!("JSON 解析失败：{err}"),
            )),
        };
        if let Some(response) = response {
            writeln!(out, "{response}")?;
            out.flush()?;
        }
    }
}

/// JSON-RPC 错误响应（id 原样回显；无法关联请求时 id=null）
fn rpc_error(id: Value, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 单条消息 → Option<响应>：请求有响应；通知（无 id）无响应；响应帧忽略。
pub(crate) fn handle_message(msg: &Value, backend: &dyn McpBackend) -> Option<Value> {
    let obj = match msg.as_object() {
        Some(obj) => obj,
        None => {
            return Some(rpc_error(
                Value::Null,
                -32600,
                "消息不是 JSON 对象".to_owned(),
            ))
        }
    };
    let method = obj.get("method").and_then(Value::as_str);
    let has_id = obj.contains_key("id");
    match (method, has_id) {
        // 通知（无 id）：协议生命周期通知一律不回（MCP stdio 传输纪律）
        (Some(_), false) => None,
        // 对端发来的响应帧（无 method 有 id）：本代理不主动发请求，忽略
        (None, true) => None,
        (None, false) => Some(rpc_error(
            Value::Null,
            -32600,
            "消息缺少 method 与 id".to_owned(),
        )),
        (Some(method), true) => {
            let id = obj.get("id").cloned().unwrap_or(Value::Null);
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            Some(dispatch_request(method, &params, &id, backend))
        }
    }
}

fn dispatch_request(method: &str, params: &Value, id: &Value, backend: &dyn McpBackend) -> Value {
    match method {
        "initialize" => {
            // 回显客户端请求的 protocolVersion（stdio 逐行 JSON 传输与版本无关，
            // 回显为最大兼容口径）；客户端未给 → 钉定默认
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .unwrap_or(DEFAULT_PROTOCOL_VERSION)
                .to_owned();
            rpc_result(
                id.clone(),
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "guanlan-mcp",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }),
            )
        }
        "ping" => rpc_result(id.clone(), json!({})),
        "tools/list" => rpc_result(id.clone(), json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            let Some(name) = TOOL_NAMES.iter().find(|t| **t == name) else {
                return rpc_error(
                    id.clone(),
                    -32602,
                    format!("未知工具「{name}」，可用：{}", TOOL_NAMES.join(" / ")),
                );
            };
            let outcome = match *name {
                "guanlan.read_artifact" => tool_read_artifact(&arguments, backend),
                "guanlan.propose_revision" => tool_propose_revision(&arguments, backend),
                "guanlan.resolve_decision" => tool_resolve_decision(&arguments, backend),
                "guanlan.commit_checkpoint" => tool_commit_checkpoint(&arguments, backend),
                "guanlan.get_context_bundle" => tool_get_context_bundle(&arguments, backend),
                _ => tool_search_workspace(&arguments, backend),
            };
            match outcome {
                Ok(result) => rpc_result(
                    id.clone(),
                    json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_default() }],
                    }),
                ),
                Err(message) => rpc_result(
                    id.clone(),
                    json!({
                        "content": [{ "type": "text", "text": message }],
                        "isError": true,
                    }),
                ),
            }
        }
        other => rpc_error(id.clone(), -32601, format!("未知方法「{other}」")),
    }
}

// ================= 工具定义（4 个基础工具 + 上下文包/检索扩展工具） =================

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "guanlan.read_artifact",
            "description": "读取观澜工作区中一个文档（md/svg/pdf）当前版本或指定版本的正文。path 或 uri（guanlan://<相对路径>）二选一；给 revision_id 则直接读该版本。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "工作区相对路径，如 docs/04-智能体代码/03-待确认事项.md" },
                    "uri": { "type": "string", "description": "guanlan://<相对路径>（模式 B context_bundle 的 uri 形态）" },
                    "revision_id": { "type": "string", "description": "指定版本 id（缺省读当前版）" },
                },
            },
        }),
        json!({
            "name": "guanlan.propose_revision",
            "description": "向观澜提交修订草案（默认落入独立草案分支 v(N+1)-agent-draft，不直接覆盖工作树正式定稿；异步任务在代理内有界轮询至终态并回报 CAS 结果；磁盘哈希与基准不符时标 conflict=true 交由人类比对采纳）。file_id 或 path 二选一；base_revision_id 缺省取当前版；建议附带 input_context_hashes 与 receipt_summary 以便采纳后记录 derived_from_context 因果边。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "完整修订后正文（UTF-8 全文，非增量 patch）" },
                    "file_id": { "type": "string", "description": "目标文件 id（与 path 二选一）" },
                    "path": { "type": "string", "description": "目标文件工作区相对路径（与 file_id 二选一）" },
                    "base_revision_id": { "type": "string", "description": "基准版本 id（缺省 = 当前版）" },
                    "note": { "type": "string", "description": "变更说明（展示给用户）" },
                    "input_context_hashes": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "本次修订所依据的输入上下文内容哈希清单（采纳后自动记录 derived_from_context 因果边）"
                    },
                    "receipt_summary": { "type": "string", "description": "Agent 回执摘要（一句话概括修改内容与自检结论，供观澜批阅条直接展示）" },
                },
                "required": ["content"],
            },
        }),
        json!({
            "name": "guanlan.resolve_decision",
            "description": "代表用户对一条待确认陈述提交拍板（异步任务，代理内有界轮询至终态并回报回写结果与 CAS 冲突分支）。注意：拍板会写入本地 .md 文件，仅在上下文协议明确授权时调用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "statement_id": { "type": "string", "description": "待确认陈述 id" },
                    "decision": { "type": "string", "description": "拍板决定（下拉预设或自定义文本）" },
                    "confirmer": { "type": "string", "description": "确认人" },
                    "role": { "type": "string", "description": "角色（可选）" },
                    "effective_scope": { "type": "string", "description": "生效范围（可选，如 全量专项/仅当前分支）" },
                    "effective_date": { "type": "string", "description": "生效日期 YYYY-MM-DD（可选）" },
                    "note": { "type": "string", "description": "备注（可选）" },
                },
                "required": ["statement_id", "decision", "confirmer"],
            },
        }),
        json!({
            "name": "guanlan.commit_checkpoint",
            "description": "提交长任务执行槽位 Checkpoint（同步受理 201；SUCCESS 是执行槽唯一完成通道）。node_id 缺省时服务端按 (initiative_id, stage) 反查槽位推进。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "initiative_id": { "type": "string", "description": "专项 id（init_…）" },
                    "stage": { "type": "string", "description": "蓝图|计划|决策|执行|交付" },
                    "status": { "type": "string", "description": "SUCCESS|FAILED_RETRYABLE|SUSPENDED_HITL" },
                    "input_context_hash": { "type": "string", "description": "本轮输入上下文哈希" },
                    "node_id": { "type": "string", "description": "槽位节点 id（缺省按 initiative+stage 反查）" },
                    "output_revision_id": { "type": "string", "description": "产出版本 id（可选）" },
                    "token_usage": { "type": "integer", "description": "token 用量（可选）" },
                    "elapsed_ms": { "type": "integer", "description": "耗时毫秒（可选）" },
                    "note": { "type": "string", "description": "备注（可选）" },
                },
                "required": ["initiative_id", "stage", "status", "input_context_hash"],
            },
        }),
        json!({
            "name": "guanlan.get_context_bundle",
            "description": "获取 Token 预算感知上下文包（与观澜 UI 预览区/一键复制逐字节同源一致）。支持按 document / initiative / global 意图自动预选定稿全文、关联决定摘要、上游规范引用片段与未决问题清单，支持按文件指定 full / summary / diff_only / metadata_only / decisions_only 粒度，并经密钥与环境变量脱敏护栏过滤。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "intent": { "type": "string", "description": "document | initiative | global（缺省按 focus_file_id/path/initiative_id 自动推导）" },
                    "focus_file_id": { "type": "string", "description": "焦点文件 id（document/initiative 入口可选）" },
                    "path": { "type": "string", "description": "焦点文件相对路径（自动解析为 focus_file_id）" },
                    "uri": { "type": "string", "description": "guanlan://<相对路径>（自动解析为 focus_file_id）" },
                    "initiative_id": { "type": "string", "description": "专项 id（initiative 入口可选）" },
                    "items": {
                        "type": "array",
                        "description": "显式条目清单（缺省/空数组时按意图自动预选）",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file_id": { "type": "string" },
                                "path": { "type": "string" },
                                "uri": { "type": "string" },
                                "revision_id": { "type": "string" },
                                "granularity": { "type": "string", "description": "full | summary | diff_only | metadata_only | decisions_only" },
                            },
                        },
                    },
                    "mode": { "type": "string", "description": "both（默认）| markdown | structured" },
                    "budget_tokens": { "type": "integer", "description": "Token 推荐预算阈值（默认 65536）" },
                },
            },
        }),
        json!({
            "name": "guanlan.search_workspace",
            "description": "在观澜授权工作区内检索全文、路径、符号与决定编号（自动遵守路径沙箱并过滤敏感凭据路径）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "q": { "type": "string", "description": "检索关键词、编号或文件名缩写" },
                    "path_prefix": { "type": "string", "description": "可选工作区子目录前缀（严禁越界逃逸）" },
                    "format": { "type": "string", "description": "可选格式过滤，如 md / svg / pdf / code" },
                    "limit": { "type": "integer", "description": "返回文件数上限（1..=50，默认 20）" },
                },
                "required": ["q"],
            },
        }),
    ]
}

/// URL 单路径段安全校验（防止 revision_id / statement_id / file_id 夹带 `/`、`..`、控制字符注入 HTTP 路径）
fn validate_identifier_segment(field: &str, raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} 不能为空"));
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains('?')
        || trimmed.contains('#')
        || trimmed.contains('\0')
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err(format!(
            "PATH_ESCAPE_DENIED: {field} 包含非法路径分隔或控制字符：{trimmed}"
        ));
    }
    Ok(trimmed.to_owned())
}

/// 按字节上限在 UTF-8 字符边界安全截断文本，返回 (截断后切片, 是否发生截断)
fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

// ================= 工具实现 =================

/// 文件定位：file_id 直通（先检标识防 URL 穿越）；否则 path/uri（guanlan:// 前缀剥离 + 权限沙箱与敏感凭据拦截）
/// 经 GET /api/v1/files?q= 精确匹配 relative_path。返回 (file_id, path, 当前版 id)。
fn resolve_file(
    args: &Value,
    backend: &dyn McpBackend,
) -> Result<(String, String, String), String> {
    if let Some(file_id) = args
        .get("file_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let clean_id = validate_identifier_segment("file_id", file_id)?;
        // file_id 直通时当前版由提案端点受理侧权威校验；这里不带当前版语义
        return Ok((clean_id, String::new(), String::new()));
    }
    let raw_ref = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| args.get("uri").and_then(Value::as_str))
        .ok_or_else(|| "需要 file_id 或 path/uri 定位目标文件".to_owned())?
        .trim()
        .to_owned();
    // 权限沙箱：在发出任何 HTTP 请求前阻断路径逃逸、绝对路径、UNC、编码穿越与敏感凭据文件
    let path = guanlan_core::storage::sandbox::validate_mcp_rel_path(&raw_ref)
        .map_err(|e| e.to_string())?;
    let response = backend.call(McpHttpRequest {
        method: "GET",
        path: format!("/api/v1/files?q={}", urlencode(&path)),
        body: None,
    })?;
    if !response.is_success() {
        return Err(response.error_text());
    }
    let items = response
        .body
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let matched = items.iter().find(|item| {
        item.get("relative_path").and_then(Value::as_str) == Some(path.as_str())
            && item.get("status").and_then(Value::as_str) != Some("missing")
    });
    let matched = matched.ok_or_else(|| format!("工作区未找到文件「{path}」（精确路径匹配）"))?;
    let file_id = matched
        .get("file_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "文件行缺 file_id".to_owned())?
        .to_owned();
    let current = matched
        .get("current_revision_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok((file_id, path, current))
}

/// 提交类 202 job 的有界轮询：GET /api/v1/jobs/{id} 至 completed/failed/cancelled。
/// 超时返回 Err（代理侧如实报超时，不冒充终态）。
fn poll_job_until_settled(backend: &dyn McpBackend, job_id: &str) -> Result<Value, String> {
    for _ in 0..JOB_POLL_ATTEMPTS {
        let response = backend.call(McpHttpRequest {
            method: "GET",
            path: format!("/api/v1/jobs/{}", urlencode(job_id)),
            body: None,
        })?;
        if !response.is_success() {
            return Err(response.error_text());
        }
        let state = response
            .body
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if matches!(state.as_str(), "completed" | "failed" | "cancelled") {
            return Ok(response.body);
        }
        std::thread::sleep(JOB_POLL_INTERVAL);
    }
    Err(format!(
        "任务 {job_id} 轮询超时（仍在进行中；可用 guanlan 前端或 /jobs/{job_id} 查询终态）"
    ))
}

fn tool_read_artifact(args: &Value, backend: &dyn McpBackend) -> Result<Value, String> {
    let (file_id, path, current) = resolve_file(args, backend)?;
    let explicit_revision = args
        .get("revision_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let revision_id = match explicit_revision {
        Some(id) => validate_identifier_segment("revision_id", &id)?,
        None if !file_id.is_empty() && path.is_empty() => {
            // file_id 直通：没有当前版语义，必须显式给 revision_id
            return Err(
                "file_id 直通读正文需要 revision_id（或改用 path/uri 定位当前版）".to_owned(),
            );
        }
        None if current.is_empty() => {
            return Err(format!("文件「{path}」没有当前版本（从未索引出修订）"));
        }
        None => validate_identifier_segment("revision_id", &current)?,
    };
    let mut response = backend.call(McpHttpRequest {
        method: "GET",
        path: format!("/api/v1/revisions/{}/content", urlencode(&revision_id)),
        body: None,
    })?;
    // 413 内联预算：回退 raw=1 纯文本（契约 §1.8），并按 MCP 文本预算上限安全截断
    if response.status == 413 {
        response = backend.call(McpHttpRequest {
            method: "GET",
            path: format!(
                "/api/v1/revisions/{}/content?raw=1",
                urlencode(&revision_id)
            ),
            body: None,
        })?;
        if !response.is_success() {
            return Err(response.error_text());
        }
        let total_bytes = response.raw_text.len();
        let (bounded, was_cut) = truncate_utf8_bytes(&response.raw_text, MCP_MAX_READ_TEXT_BYTES);
        let hint = if was_cut {
            format!(
                "响应为 raw=1 纯文本并按 MCP 上限 {} 字节截断（原文共 {} 字节）",
                MCP_MAX_READ_TEXT_BYTES, total_bytes
            )
        } else {
            "响应为 raw=1 纯文本（原文超出内联预算）".to_owned()
        };
        return Ok(json!({
            "ok": true,
            "file_id": file_id,
            "path": path,
            "revision_id": revision_id,
            "text": bounded,
            "truncated": true,
            "total_bytes": total_bytes,
            "returned_bytes": bounded.len(),
            "truncated_hint": hint,
        }));
    }
    if !response.is_success() {
        return Err(response.error_text());
    }
    let format = response
        .body
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if format == "pdf" {
        // PDF 不整读：raw_url 指引（契约 §1.8 v1 口径）
        let raw_url = response.body.get("raw_url").cloned().unwrap_or(Value::Null);
        return Ok(json!({
            "ok": true,
            "file_id": file_id,
            "path": path,
            "revision_id": revision_id,
            "format": format,
            "raw_url": raw_url,
            "text": Value::Null,
            "note": "PDF 正文不走内联文本；raw_url 返回原始字节流",
        }));
    }
    let raw_text_val = response.body.get("text").cloned().unwrap_or(Value::Null);
    if let Some(full_str) = raw_text_val.as_str() {
        let total_bytes = full_str.len();
        let (bounded, was_cut) = truncate_utf8_bytes(full_str, MCP_MAX_READ_TEXT_BYTES);
        if was_cut {
            return Ok(json!({
                "ok": true,
                "file_id": file_id,
                "path": path,
                "revision_id": revision_id,
                "format": format,
                "text": bounded,
                "truncated": true,
                "total_bytes": total_bytes,
                "returned_bytes": bounded.len(),
                "truncated_hint": format!(
                    "正文已按 MCP 上限 {} 字节安全截断（原文共 {} 字节）",
                    MCP_MAX_READ_TEXT_BYTES, total_bytes
                ),
            }));
        }
    }
    Ok(json!({
        "ok": true,
        "file_id": file_id,
        "path": path,
        "revision_id": revision_id,
        "format": format,
        "text": raw_text_val,
    }))
}

fn tool_propose_revision(args: &Value, backend: &dyn McpBackend) -> Result<Value, String> {
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "content 为必填（完整修订后正文）".to_owned())?
        .to_owned();
    let (file_id, path, current) = resolve_file(args, backend)?;
    let base_revision_id = match args
        .get("base_revision_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(base) => base.to_owned(),
        None if current.is_empty() => {
            return Err(format!(
                "文件「{path}」没有当前版本可作基准（显式传 base_revision_id）"
            ));
        }
        None => current,
    };
    let note = args.get("note").and_then(Value::as_str).map(str::to_owned);
    let input_context_hashes: Vec<String> = args
        .get("input_context_hashes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let receipt_summary = args
        .get("receipt_summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let mut payload = json!({
        "file_id": file_id,
        "base_revision_id": base_revision_id,
        "content": content,
        "note": note,
    });
    if !input_context_hashes.is_empty() {
        payload["input_context_hashes"] = json!(input_context_hashes);
    }
    if let Some(summary) = receipt_summary {
        payload["receipt_summary"] = json!(summary);
    }
    let accepted = backend.call(McpHttpRequest {
        method: "POST",
        path: "/api/v1/revision-proposals".to_owned(),
        body: Some(payload),
    })?;
    if !accepted.is_success() {
        return Err(accepted.error_text());
    }
    let job_id = accepted
        .body
        .get("job_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let draft_id = accepted
        .body
        .get("draft_id")
        .cloned()
        .unwrap_or(Value::Null);
    let accepted_conflict = accepted
        .body
        .get("conflict")
        .cloned()
        .unwrap_or(Value::Null);
    let draft_version_label = accepted
        .body
        .get("draft_version_label")
        .cloned()
        .unwrap_or(Value::Null);
    let job = poll_job_until_settled(backend, &job_id)?;
    Ok(json!({
        "ok": true,
        "draft_id": draft_id,
        "draft_version_label": draft_version_label,
        "job_id": job_id,
        "accepted_conflict": accepted_conflict,
        "job_state": job.get("state").cloned().unwrap_or(Value::Null),
        "job_error": job.get("error").cloned().unwrap_or(Value::Null),
        "report": job.get("result").cloned().unwrap_or(Value::Null),
    }))
}

fn tool_resolve_decision(args: &Value, backend: &dyn McpBackend) -> Result<Value, String> {
    let raw_statement_id = args
        .get("statement_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "statement_id 为必填".to_owned())?;
    let statement_id = validate_identifier_segment("statement_id", raw_statement_id)?;
    let decision = args
        .get("decision")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "decision 为必填".to_owned())?
        .to_owned();
    let confirmer = args
        .get("confirmer")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "confirmer 为必填".to_owned())?
        .to_owned();
    let str_field = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
    let accepted = backend.call(McpHttpRequest {
        method: "POST",
        path: format!("/api/v1/decisions/{}/resolve", urlencode(&statement_id)),
        body: Some(json!({
            "decision": decision,
            "confirmer": confirmer,
            "role": str_field("role"),
            "effective_scope": str_field("effective_scope"),
            "effective_date": str_field("effective_date"),
            "note": str_field("note"),
        })),
    })?;
    if !accepted.is_success() {
        return Err(accepted.error_text());
    }
    let job_id = accepted
        .body
        .get("job_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let decision_id = accepted
        .body
        .get("decision_id")
        .cloned()
        .unwrap_or(Value::Null);
    let job = poll_job_until_settled(backend, &job_id)?;
    Ok(json!({
        "ok": true,
        "statement_id": statement_id,
        "decision_id": decision_id,
        "job_id": job_id,
        "job_state": job.get("state").cloned().unwrap_or(Value::Null),
        "job_error": job.get("error").cloned().unwrap_or(Value::Null),
        "report": job.get("result").cloned().unwrap_or(Value::Null),
    }))
}

fn tool_commit_checkpoint(args: &Value, backend: &dyn McpBackend) -> Result<Value, String> {
    let required = ["initiative_id", "stage", "status", "input_context_hash"];
    for key in required {
        let missing = args
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true);
        if missing {
            return Err(format!("{key} 为必填"));
        }
    }
    let int_field = |key: &str| {
        args.get(key)
            .and_then(Value::as_i64)
            .map(|v| json!(v))
            .unwrap_or(Value::Null)
    };
    let response = backend.call(McpHttpRequest {
        method: "POST",
        path: "/api/v1/checkpoints".to_owned(),
        body: Some(json!({
            "node_id": args.get("node_id").and_then(Value::as_str).map(str::to_owned),
            "initiative_id": args.get("initiative_id").and_then(Value::as_str).unwrap_or_default(),
            "stage": args.get("stage").and_then(Value::as_str).unwrap_or_default(),
            "status": args.get("status").and_then(Value::as_str).unwrap_or_default(),
            "input_context_hash": args.get("input_context_hash").and_then(Value::as_str).unwrap_or_default(),
            "output_revision_id": args.get("output_revision_id").and_then(Value::as_str).map(str::to_owned),
            "token_usage": int_field("token_usage"),
            "elapsed_ms": int_field("elapsed_ms"),
            "note": args.get("note").and_then(Value::as_str).map(str::to_owned),
        })),
    })?;
    if !response.is_success() {
        return Err(response.error_text());
    }
    Ok(response.body)
}

/// `guanlan.get_context_bundle` — 转发至 POST /api/v1/context，与观澜前端预览/复制逐字节同源
fn tool_get_context_bundle(args: &Value, backend: &dyn McpBackend) -> Result<Value, String> {
    let mut focus_file_id = args
        .get("focus_file_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if focus_file_id.is_none()
        && (args.get("path").and_then(Value::as_str).is_some()
            || args.get("uri").and_then(Value::as_str).is_some())
    {
        let (resolved_id, _, _) = resolve_file(args, backend)?;
        focus_file_id = Some(resolved_id);
    }
    let initiative_id = args
        .get("initiative_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let intent = args
        .get("intent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if focus_file_id.is_some() {
                "document".to_owned()
            } else if initiative_id.is_some() {
                "initiative".to_owned()
            } else {
                "global".to_owned()
            }
        });
    let mut resolved_items: Vec<Value> = Vec::new();
    if let Some(arr) = args.get("items").and_then(Value::as_array) {
        for raw in arr {
            let file_id = if let Some(fid) = raw
                .get("file_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                fid.to_owned()
            } else {
                let (fid, _, _) = resolve_file(raw, backend)?;
                fid
            };
            let mut item = json!({
                "file_id": file_id,
                "granularity": raw.get("granularity").and_then(Value::as_str).unwrap_or("full"),
            });
            if let Some(rev) = raw
                .get("revision_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                item["revision_id"] = json!(rev);
            }
            resolved_items.push(item);
        }
    }
    let mut body = json!({
        "intent": intent,
        "mode": args.get("mode").and_then(Value::as_str).unwrap_or("both"),
    });
    if let Some(fid) = focus_file_id {
        body["focus_file_id"] = json!(fid);
    }
    if let Some(init) = initiative_id {
        body["initiative_id"] = json!(init);
    }
    if !resolved_items.is_empty() {
        body["items"] = Value::Array(resolved_items);
    }
    if let Some(budget) = args.get("budget_tokens").and_then(Value::as_u64) {
        body["budget_tokens"] = json!(budget);
    }
    let response = backend.call(McpHttpRequest {
        method: "POST",
        path: "/api/v1/context".to_owned(),
        body: Some(body),
    })?;
    if !response.is_success() {
        return Err(response.error_text());
    }
    Ok(response.body)
}

/// `guanlan.search_workspace` — 全文/路径/编号有界检索（带路径沙箱校验与敏感凭据路径结果过滤）
fn tool_search_workspace(args: &Value, backend: &dyn McpBackend) -> Result<Value, String> {
    let q = args
        .get("q")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "q 为必填（检索关键词、编号或文件名缩写）".to_owned())?;
    let raw_prefix = args
        .get("path_prefix")
        .and_then(Value::as_str)
        .or_else(|| args.get("dir").and_then(Value::as_str))
        .unwrap_or("");
    let clean_prefix = guanlan_core::storage::sandbox::validate_mcp_dir_prefix(raw_prefix)
        .map_err(|e| e.to_string())?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v.clamp(1, 50))
        .unwrap_or(20);
    let mut query_parts = vec![format!("q={}", urlencode(q)), format!("limit={limit}")];
    if !clean_prefix.is_empty() {
        query_parts.push(format!("dir={}", urlencode(&clean_prefix)));
    }
    if let Some(fmt) = args
        .get("format")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let clean_fmt = validate_identifier_segment("format", fmt)?;
        query_parts.push(format!("format={}", urlencode(&clean_fmt)));
    }
    let response = backend.call(McpHttpRequest {
        method: "GET",
        path: format!("/api/v1/search?{}", query_parts.join("&")),
        body: None,
    })?;
    if !response.is_success() {
        return Err(response.error_text());
    }
    // 敏感凭据路径二次兜底过滤（即使历史曾入库也绝不通过 MCP 透出）
    let mut body = response.body;
    if let Some(items) = body.get_mut("items").and_then(Value::as_array_mut) {
        items.retain(|item| {
            let rel = item
                .get("relative_path")
                .or_else(|| item.get("relativePath"))
                .and_then(Value::as_str)
                .unwrap_or("");
            !guanlan_core::application::context::is_sensitive_secret_path(rel)
        });
    }
    Ok(body)
}

/// query 百分号编码（路径含中文/空格；保留无保留字冲突的直通字符）
fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
