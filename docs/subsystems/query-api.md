# 查询接口

前端与 MCP 代理都只通过 `http://127.0.0.1:<port>/api/v1/*` 与观澜服务交互。端点的逐字段契约在 [`contract-query-api.md`](../../native/docs/contract-query-api.md)，这份参考讲的是横跨所有端点的东西：路由怎么装配、请求怎么落到只读连接、错误包络与分页游标的语义、响应 DTO 如何与前端类型保持一致。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 路由装配 | `build_router` 注册全部 `/api/v1` 路由并在 `dist` 存在时挂载静态资源；`projects_routes` 是多项目端点。 | [`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs)、[`http/projects_api.rs`](../../native/crates/guanlan-service/src/http/projects_api.rs) |
| 应用状态 | `AppState` 持有查询执行器、响应预算、任务管理器、通知中枢、挂载表与项目中枢。`active_exec()`、`active_jobs()`、`active_mounts()` 把请求路由到当前激活的项目。 | [`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs) |
| 错误包络 | `ApiError` 把 `GuanlanError` 转成 HTTP 响应，并补上执行器缓存的 `index_generation`。 | [`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs)、[`error.rs`](../../native/crates/guanlan-core/src/error.rs) |
| 只读查询 | `guanlan_core::query` 下的各模块，全部只执行只读 SQL。 | [`query/mod.rs`](../../native/crates/guanlan-core/src/query/mod.rs) |
| 分页游标 | `EventCursor`、`KeyCursor` 及其编解码与筛选指纹。 | [`query/cursor.rs`](../../native/crates/guanlan-core/src/query/cursor.rs) |
| 响应 DTO | `guanlan_core::dto` 的 serde 字段名与契约逐字对齐。 | [`dto.rs`](../../native/crates/guanlan-core/src/dto.rs) |
| 前端类型镜像 | `apiTypes.ts` 手工镜像 Rust DTO，`workspaceClient.ts` 是唯一发 `fetch` 与 `EventSource` 的模块。 | [`apiTypes.ts`](../../src/services/apiTypes.ts)、[`workspaceClient.ts`](../../src/services/workspaceClient.ts) |
| 流式与条件请求 | `serve_snapshot_stream` 与 `range` 里的纯函数。 | [`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs)、[`http/range.rs`](../../native/crates/guanlan-service/src/http/range.rs) |
| 响应预算 | `ResponseBudget` 限制内联正文的字节数。 | [`http/response_budget.rs`](../../native/crates/guanlan-service/src/http/response_budget.rs) |

## 路由分组

全部路由都在 `/api/v1` 下，注册集中在 `build_router` 与 `projects_routes` 两个函数里。

| 分组 | 代表端点 | 说明 |
| --- | --- | --- |
| 工作区 | `GET /bootstrap`、`GET /status`、`GET /stream` | 首屏快照、实例身份与进度、SSE |
| 文件与版本 | `GET /files`、`GET /files/{id}/revisions`、`GET /files/{id}/detail`、`GET /revisions/{id}/content` | 摘要分页、版本链、阅读器视图、正文 |
| 预览与阅读 | `GET /revisions/{id}/preview`、`/thumbnail`、`/office`、`/pdf` | 轻预览、缩略图、Office 与 PDF 结构化阅读 |
| 事件 | `GET /events`、`/events/days`、`/events/range` | 分页事件、按日分桶、时间范围 |
| 决定与关系 | `GET /decisions`、`/relations`、`/statements` | 决定列表、引用边、拍板表单数据源 |
| 文件夹操作 | `/files/{id}/rename`、`/move`、`/trash`、`/files/create`、`/folders*`、批量操作 | 见[工作区写入](workspace-writes.md) |
| 长任务 | `/state-overview`、`/checkpoints`、`/revision-proposals*`、`/initiatives/*`、`/initiative-candidates*`、`/review-board*`、`/diff`、`/context`、`/summary/{id}` | 见[长任务引擎](longtask-engine.md) |
| 任务 | `POST /index-jobs`、`GET /jobs/{id}`、`POST /jobs/{id}/cancel`、`GET /jobs/{id}/result` | 后台任务提交、轮询、取消 |
| 存储维护 | `/storage/stats`、`/policy`、`/integrity`、`/backups`、`/gc`、`/diagnostic-zip`、`POST /export/workspace` | 见[存储](storage.md) |
| 胶囊 | `POST /capsules/preview`、`/export`、`/inspect`、`/file` | 离线资料包 |
| 检索与挂载 | `GET /search`、`POST /search/rebuild`、`/mounts`、`GET /search/cross` | 混合倒排检索、只读参考工作区 |
| 诊断 | `GET /audit/ledger`、`POST /mcp/host-config` | 账本与沙箱审计、写 MCP 宿主配置 |
| 多项目 | `/projects`、`/projects/{id}/activate`、`/rescan`、`/tree`、`/overview`、`/search` 及项目内的文件操作 | 见[服务运行时](service-runtime.md) |
| 未实现 | `GET /graph` | 唯一的 501 桩 |

未知的 `/api/*` 路径一律返回 404 错误包络，不会落到静态资源的 SPA 回退。

## 运行路径

### 一次查询

处理器解析参数后调用 `run_query`，进入有界查询通道并在只读连接上执行 core 查询，细节见[服务运行时](service-runtime.md)。成功响应直接是 DTO；失败经 `ApiError::into_response` 变成错误包络。

### 正文的三种形态

`GET /revisions/{id}/content` 按格式与参数分三条路：

1. **PDF**（不带 `raw=1`）：返回 JSON 加 `raw_url`，不内联正文。
2. **任何格式带 `?raw=1`**，或 PDF 本身：`serve_snapshot_stream` 以 64 KiB 分块流式输出，不占内联预算。
3. **Markdown 与 SVG 内联**：打开文件取**实际大小**（不信数据库里的 `size_bytes`），超过单响应上限（默认 8 MiB）直接返回 `UNSUPPORTED_CONTENT`（413）并提示用 `raw=1`；否则预占字节预算，在阻塞线程池里限长读取、转 UTF-8、序列化，预算随响应体释放。

没有快照的版本（`snapshot_available = 0` 或文件缺失）返回 `SNAPSHOT_UNAVAILABLE`（410），不拿当前磁盘内容冒充旧版本。

### 条件请求与范围请求

流式路径带 `ETag`（`"sha256-<内容哈希>"`，跨重启稳定）、`Accept-Ranges: bytes` 与 `Cache-Control: private, max-age=0, must-revalidate`。

- `If-None-Match` 命中返回 304，不读正文。
- `If-Range` 不匹配则忽略 `Range`，返回全量。
- 单区间返回 206 加 `Content-Range`；多区间或语法不可解析回退全量 200；起点越界返回 416。

预览、Office、PDF 三个端点只支持 ETag 与 304，不支持 Range。

## 错误包络

```json
{ "ok": false, "code": "CURSOR_STALE", "error": "人类可读信息", "detail": "可选补充", "index_generation": 12 }
```

| 码 | HTTP | 何时出现 |
| --- | --- | --- |
| `ROOT_IN_USE` | 409 | 同一工作区已有服务实例持有排他锁 |
| `NOT_FOUND` | 404 | 主体不存在，或未知路由 |
| `SNAPSHOT_UNAVAILABLE` | 410 | 版本元数据在，快照不可读 |
| `INDEX_STALE` | 409 | 请求携带的代际与当前不符 |
| `CURSOR_STALE` | 409 | 游标不可解码、筛选指纹不一致、窗口快照过期 |
| `INDEX_BUSY` | 503 | 查询队列、写线程或响应预算饱和；附 `Retry-After: 2` |
| `NOT_IMPLEMENTED` | 501 | 未交付的端点 |
| `UNSUPPORTED_CONTENT` | 413 | 正文超过内联上限 |
| `BAD_REQUEST` | 400 | 参数不合法；路径沙箱拒绝也走它（`PATH_ESCAPE_DENIED`、`SECRET_PATH_DENIED`） |
| `CONFLICT` | 409 | 主体状态不允许该操作 |
| `MOUNT_REJECTED` | 409 | 挂载互斥校验未通过 |
| `CROSS_WORKSPACE_FORBIDDEN` | 403 | 跨挂载边界写入，或项目处于只读保护 |
| `INTERNAL` | 500 | 存储与 IO 错误；`SCHEMA_TOO_NEW` 也在其中 |

CAS 内容冲突不占错误码，走任务报告里的分支字段。

## 分页游标

- 游标是不透明的 base64url(JSON)。事件游标 `{snap, k, s, fp}`，其他列表是 `{snap, k, s, fp}`，其中 `snap` 换成签发时的 `index_generation`，`s` 是字符串。
- 事件游标的 `snap` 是签发时的 `max(events.seq)`：新事件不会进入已打开的窗口。续页条件是键集分页 `(k', s') < (k, s)`。
- `fp` 是筛选参数集的 SHA-256 前 16 位。续页请求的参数必须逐项一致，否则 `CURSOR_STALE`。
- 版本链首页会做一次精确 `COUNT`，结果由游标携带（`total`），续页不再重复统计；`include` 集合也只在首页返回。
- 只追加的长任务列表用偏移游标 `{o}`。
- 与旧 Node 行为的差别：游标不可解码在 Node 里是静默回首页，v1 是显式 409。

## DTO 与前端类型

Rust DTO 与 `apiTypes.ts` **靠手工保持一致，没有任何自动同步或对拍测试**。改任一侧必须同步另一侧。映射约定：

- 新 DTO 用 snake_case；`/events`、`/events/days`、`/events/range` 的既有键保持 camelCase；决定、关系、工作区配置沿用 `src/types/guanlan.ts` 的字段名，Rust 侧用 `#[serde(rename)]` 镜像。
- `Option<T>` 且恒序列化对应 `T | null`；带 `skip_serializing_if` 的对应可选字段 `?:`，这是为了与旧 Node 输出里 `undefined` 键不出现保持一致。
- `serde_json::Value` 对应 `Record<string, unknown>`；`HashMap<String, u64>` 对应 `Record<string, number>`。

跨端共享的只有两份向量文件：`token-vectors.json` 与 `stage-vectors.json`，由 Rust 的 `include_str!` 与 TS 的 `readFileSync` 同时读取。

## 约束与失败行为

- **字段名与 wire 格式 1:1 保留。** v1 只换前缀与路径归属，不改既有键名。
- **不拿当前内容冒充旧版本。** 旧版本快照不可读时返回 410。
- **bootstrap 的响应里不出现正文。** `bootstrap`、`status` 一类首屏响应不含 `svgSource`、`markdownContent` 或 `revisions[]`，`assert_no_body_content` 守着这条。
- **纯日期不参与时区换算。** 日归属按本地日计算，不能统一按 UTC 取日，否则凌晨的事件会被算到前一天。
- **分页查询的 SQL 形状有索引守卫。** `pagination_uses_expression_sort_indexes` 与 `event_file_association_branches_use_indexes` 用 `EXPLAIN QUERY PLAN` 断言走了索引；改动这些查询的排序或过滤顺序要让它们继续通过。
- **检索索引未就绪时结果为空并带状态字段**，不拿半成品冒充。
- **桌面壳模式下 CORS 只放行 `tauri.localhost` 与本机开发端口**，方法只有 GET、HEAD、POST、OPTIONS。

## 验证

```sh
cd native
cargo test --locked -p guanlan-service --lib -- http::tests
cargo test --locked -p guanlan-service --lib -- http::range http::response_budget
cargo test --locked -p guanlan-core --lib -- query::
cargo test --locked -p guanlan-core --lib -- application::tests
```

`http_tests.rs` 里的测试在临时目录按契约 DDL 自建夹具库，不依赖 `native/testdata`。过滤条件按模块路径写：这个文件在 `http/mod.rs` 里是以 `mod tests` 挂进去的，所以路径是 `http::tests`，不是文件名。`smoke-v1.ts` 从外部对真实服务逐端点比对期望结果，改任何端点的输出形状后必须跑，命令见[索引](indexing.md#验证)。
