# MCP stdio 代理

`guanlan mcp` 让支持 MCP 的智能体读写观澜的工作区。它是一个**代理**：自己不开数据库、不扫目录、不维护另一套历史，只把六个工具的调用转成对本地 `guanlan serve` 的 HTTP 请求。所有安全边界都建立在「代理从不直接读工作区文件」这一点上。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 端点发现 | `resolve_endpoint`：`--endpoint <url>` 或 `--endpoint=<url>` 优先，其次环境变量 `GUANLAN_ENDPOINT`。 | [`mcp/mod.rs`](../../native/crates/guanlan-service/src/mcp/mod.rs) |
| stdio 传输 | `serve_stdio` 逐行读 JSON-RPC 2.0，有响应就写一行；诊断只走 stderr。 | [`mcp/mod.rs`](../../native/crates/guanlan-service/src/mcp/mod.rs) |
| 消息分发 | `handle_message` 与 `dispatch_request` 处理 `initialize`、`ping`、`tools/list`、`tools/call`。 | [`mcp/mod.rs`](../../native/crates/guanlan-service/src/mcp/mod.rs) |
| HTTP 客户端 | `HttpBackend` 是手写的最小 HTTP/1.1 客户端，没有引入任何 crate。 | [`mcp/mod.rs`](../../native/crates/guanlan-service/src/mcp/mod.rs) |
| 工具清单 | `TOOL_NAMES` 与 `tool_definitions`。 | [`mcp/mod.rs`](../../native/crates/guanlan-service/src/mcp/mod.rs) |
| 路径沙箱 | `validate_mcp_rel_path`、`validate_mcp_dir_prefix`、`is_sensitive_secret_path`。 | [`storage/sandbox.rs`](../../native/crates/guanlan-core/src/storage/sandbox.rs)、[`application/context.rs`](../../native/crates/guanlan-core/src/application/context.rs) |
| 宿主配置生成 | HTTP 端点 `mcp_host_config` 替 ZCode、Claude Code、Cursor 写好 `.mcp.json`。 | [`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs) |

## 运行路径

### 启动

`guanlan mcp` 调用 `run`。端点缺失时向 stderr 打一行错误包络并以 1 退出；**不猜端口**，因为 `serve` 默认绑随机端口，权威值只在它启动时输出的 `GUANLAN_ENDPOINT` 行里。只接受 `http://` 开头、主机非空、端口是数字的端点。

### 一次工具调用

1. 客户端写一行 `{"jsonrpc":"2.0","id":…,"method":"tools/call","params":{…}}`。
2. `dispatch_request` 按 `TOOL_NAMES` 找到工具，未知名返回 -32602。
3. 工具函数做参数校验与沙箱校验，然后经 `HttpBackend` 发请求。每个请求一条连接（`Connection: close`），连接超时 5 秒，读写超时 20 秒，响应体上限 16 MiB。
4. 成功结果包成一个 `text` 内容块；失败包成带 `isError: true` 的结果。**工具级失败不断协议。**

提交类工具拿到 202 后轮询 `GET /api/v1/jobs/{id}`：每 300 毫秒一次，至多 33 次，约 10 秒封顶。超时如实报告「仍在进行中」，不冒充终态。

### 协议面

- `initialize` 回显客户端的 `protocolVersion`，没给时钉 `2024-11-05`；`serverInfo` 是 `guanlan-mcp` 加 crate 版本。
- 通知（没有 `id` 的消息）不回。对端发来的响应帧忽略。
- 未知方法 -32601，消息不是对象或缺字段 -32600，JSON 解析失败 -32700。

## 工具

| 工具 | 转发到 | 说明 |
| --- | --- | --- |
| `guanlan.read_artifact` | `GET /files?q=` 精确匹配，再 `GET /revisions/{id}/content` | 读 md、svg、pdf 的当前版或指定版本。文本按 256 KiB 在 UTF-8 边界安全截断；413 时回退 `raw=1`；PDF 返回 `raw_url` 而不内联。 |
| `guanlan.propose_revision` | `POST /revision-proposals` 加轮询 | 提交修订草案到独立分支，不碰工作树。可带 `input_context_hashes` 与 `receipt_summary`。 |
| `guanlan.resolve_decision` | `POST /decisions/{id}/resolve` 加轮询 | 拍板。会写本地 `.md`，工具描述里写明只在协议授权时调用。 |
| `guanlan.commit_checkpoint` | `POST /checkpoints` | 同步受理，201。 |
| `guanlan.get_context_bundle` | `POST /context` | Token 预算感知的上下文包，与观澜界面里预览、复制的内容同源。 |
| `guanlan.search_workspace` | `GET /search` | 全文、路径、符号与决定编号检索；`limit` 夹在 1 到 50，默认 20。 |

`TOOL_NAMES` 的顺序是公开契约的一部分（四个基础工件与检查点工具在前，上下文包与检索工具在后），测试按它逐字断言。

## 约束与失败行为

- **代理不读工作区文件。** 读正文只能通过已索引的版本：先按相对路径精确匹配到 `file_id`，再按 `revision_id` 读。服务端同样只按 `revision_id` 提供，不提供任意路径下载。
- **路径先过沙箱，再发任何 HTTP 请求。** `resolve_file` 在调用后端之前先 `validate_mcp_rel_path`，拒绝路径逃逸、绝对路径、UNC、编码穿越与敏感凭据文件。`search_workspace` 的 `path_prefix` 走 `validate_mcp_dir_prefix`。
- **敏感凭据路径被拒。** 判定以 `is_sensitive_secret_path` 为准，包括 `.env` 与 `.env.*`（`.example`、`.sample`、`.template` 结尾的除外）、`.npmrc`、`.pypirc`、`.netrc`、`id_rsa` 一类私钥、`credentials.json`、`secrets.*`、`service-account.json`、`.pem`、`.key`、`.p12`、`.pfx`、`.keystore`，以及 `.ssh/`、`.aws/` 下的任何路径。命中返回 `SECRET_PATH_DENIED`。检索结果还会再过滤一遍，即使这些路径历史上曾入库也不透出。
- **标识符不能夹带路径分隔符。** `revision_id`、`statement_id`、`file_id` 经 `validate_identifier_segment`，防止把 `/`、`..` 或控制字符注入 URL 路径。
- **端点缺失就失败。** 不回退到某个默认端口。
- **`resolve_endpoint` 不校验主机是否为回环地址。** 模块注释写的是「端点恒为本地」，但代码只检查了 `http://` 前缀与端口格式；回环限制只在 HTTP 端的宿主配置生成器里强制。
- **写宿主配置的端点**（`POST /api/v1/mcp/host-config`）默认端点是 `http://127.0.0.1:39120`，只有 `serve` 恰好以这个端口启动时才可用。它只接受回环主机。
- **桌面应用里一键写入的宿主配置不会一直有效。** 两个原因：桌面壳每次启动都把内嵌服务绑在随机端口上（`switch_to` 传的是 `port: 0`），写进配置的 `GUANLAN_ENDPOINT` 在应用下次启动后就过期；配置里的 `command` 又是不带路径的 `guanlan`，而安装包不修改 `PATH`。界面在写入那一刻传的是当前真实的端点（`getActiveLoopbackEndpoint`）。用固定端口启动 `guanlan serve` 并自己配好 `PATH` 的命令行方式不受影响。

## 验证

```sh
cd native
cargo test --locked -p guanlan-service --lib -- mcp::
cargo test --locked -p guanlan-service --test e05_concurrent_mcp_audit
```

`mcp_tests.rs` 用 mock 后端逐字断言每个工具发出的 method、path 与 body，另有对真实本地 TCP 监听的端到端用例。`e05_concurrent_mcp_audit.rs` 起真实的 `guanlan serve` 与多个 MCP 子进程，覆盖并发、沙箱与账本审计。

手动验证：先 `guanlan serve --root <目录> --port 8787`，再 `GUANLAN_ENDPOINT=http://127.0.0.1:8787 guanlan mcp`，向标准输入贴一行 `tools/list` 请求。
