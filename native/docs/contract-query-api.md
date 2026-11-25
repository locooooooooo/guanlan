# /api/v1 查询接口契约

供 Rust 服务（`guanlan-service` HTTP 模块）与前端 `workspaceClient.ts` 共用的接口契约。

---

## 0. 总则

### 0.1 v1 命名原则

- **字段名与既定 wire 格式保持兼容**：`/events`、`/events/days`、`/events/range`、版本链、按版本内容与前端 `workspaceClient.ts` 的 `EventPage`、`FileHistory`、`EventDaysResult` 对齐。
- **新增 DTO 统一 snake_case**（`bootstrap`、`status`、`files` 摘要），Rust DTO 与前端 `apiTypes.ts` 手工保持一致。
- 遗留 camelCase（`FileRecord.revisions` 的 `versionNumber/svgSource/...`）只保留在**文件详情/阅读器链路**的兼容视图里；`files` 列表摘要不下发 revisions 数组，由 `files/{id}/revisions` 与 `revisions/{id}/content` 按需补充。

### 0.2 统一错误包络

错误包络统一输出：

```json
{ "ok": false, "code": "CURSOR_STALE", "error": "人类可读信息", "detail": "可选补充", "index_generation": 12 }
```

| code | HTTP | 触发时机 |
|---|---|---|
| `ROOT_IN_USE` | 409 | 第二个服务实例对同一工作区抢锁 |
| `NOT_FOUND` | 404 | workspace/file/revision/decision 等主体不存在 |
| `SNAPSHOT_UNAVAILABLE` | 410 | 版本元数据在但快照已过保留期/磁盘缺失；**不拿当前内容冒充旧版本** |
| `INDEX_STALE` | 409 | 客户端携带的 `index_generation`/游标快照与服务端当前代际不符，需整窗重查 |
| `CURSOR_STALE` | 409 | 游标不可解码、游标绑定筛选与本次请求不一致、或可变列表（files/decisions）自游标签发后发生使其失效的相关提交 |
| `CONFLICT` | 409 | **主体状态不允许该操作**：resolve/propose/checkpoint 命中 archived 专项（「已归档文档需先人工重开」）、对已结束任务 cancel；**CAS 内容冲突不占错误码、走 job report** |
| `INDEX_BUSY` | 503（附 `Retry-After`） | 查询/索引有界队列饱和，队列满时返回可重试，前端保留已显示数据 |

成功包络：顶层恒含 `ok: true`。

### 0.3 分页游标总语义（events 为准绳）

以 `queryEvents` 实现为契约源（`server/queries.ts:173-312`）：

1. **snapshot_max_seq 绑定**：首次查询取 `snapshot_max_seq = max(events.seq)`；此后每一页都带 `e.seq <= snap` 过滤，确保新事件不进入已打开窗口、窗口稳定。
2. **游标载体**：不透明 base64url(JSON `{snap, k, s, fp}`)（`CursorPayload` `queries.ts:76-81`，`encodeCursor/decodeCursor` `:100-114`）。`k` = 本页最后一行的排序键（occurred 口径为 `occurred_at ?? ''`，observed 口径为 `observed_at`），`s` = 该行 `seq`，键集分页条件 `(k', s') < (k, s)`（`queries.ts:204-207`）。
3. **筛选指纹 fp**：对 `{from,to,kinds(排序后),format,order,undated,q}` 做 SHA-256 取 16 hex（`fingerprint` `queries.ts:83-98`）。续页请求参数集必须逐项一致；不一致 → `CURSOR_STALE`（现状 `INDEX_STALE`，`queries.ts:189-195`）。前端已在注释里固化此约束：`App.tsx:173-177`（"游标指纹含 kinds，漏传会被判 INDEX_STALE"）、续页携带同参 `App.tsx:1005-1015`。
4. **newer_count**：`max(0, 当前max(seq) − snapshot_max_seq)`（`queries.ts:310`），首屏后新增事件数，驱动「有新变化」提示（`App.tsx:1188-1201` 的横幅，SSE `newEvents` 计数 `App.tsx:379-386`）。
5. **每响应必带**：`index_generation`（`queries.ts:294`）、`window`（回显归一化筛选，`:295-303`）、`snapshot_max_seq`、`next_cursor`（末页为 null，`:246-255`）、`has_more`、`total_in_window`（不含游标条件的窗口计数，`:257-273`）。
6. **限幅**：events `limit` 默认 50、上限 200（`queries.ts:116-117`、clamp `:175`）；前端单日窗口用 200（`App.tsx:798-806` 注释）。
7. **本地日历日**：窗口过滤与桶键一律 `localDayExpr`——长度≤10 纯日期短路不换时区，含时刻 ISO 经 SQLite `date(...,'localtime')`（`queries.ts:129-131` 及注释 `:119-128`）。Rust 必须逐字复刻该语义，不能统一按 UTC 取日。

### 0.4 index_generation 与 instance

- `index_generation` 存于 `workspaces` 表，每轮对账 `bumpGeneration` 自增。它是**当前代际计数，不是历史数据库快照**。
- SSE 通知携带 `instance_id + notice_seq + index_generation`，`notice_seq` 独立于业务 `events.seq`（详见 §2.2-J，hello/workspace-change/15s 心跳）。

---

## 1. 核心只读端点定义

### 1.1 GET /api/v1/bootstrap

一个短读快照内生成：合并返回时间范围、按日事件桶、统计摘要、首页事件、首批文件摘要、决定列表与运行配置，**不含正文与完整版本链**。

**请求参数**

| 参数 | 类型 | 说明 |
|---|---|---|
| `days_limit` | int ≤120（默认 30） | 画布聚合桶数上限；现状前端传 120（`App.tsx:104-106` `DAYS_QUERY_LIMIT`，映射 `queryEventDays.limitDays`，`queries.ts:471`） |
| `days_samples` | int 1..12（默认 4） | 每桶样本卡片数；前端传 6（`App.tsx:268`，映射 `samplesPerDay`，`queries.ts:472`） |
| `days_granularity` | `day\|week\|month`（默认 day） | `queries.ts:466-467` |
| `files_page_size` | int（默认 100） | 首批文件摘要条数 |
| `events_limit` | int ≤200（默认 50） | 首页事件条数（`App.tsx:274` 现传 50） |

**响应**

```jsonc
{
  "ok": true,
  "workspace": {                       // WorkspaceRecord，WorkspaceStore.ts:39-46
    "workspace_id": "ws_<rootKey>",    // ensureWorkspace，WorkspaceStore.ts:328-350
    "root_path": "…", "root_key": "…", // rootKey = sha256(path.resolve(root)) 前 16 hex，:276-278
    "created_at": "…", "last_scan_at": "…|null",
    "index_generation": 12
  },
  "baseline": false,                   // hasBaseline，WorkspaceStore.ts:374-379
  "counts": { "files":0,"revisions":0,"events":0,"blobs":0,"statements":0,"edges":0 },
                                       // store.counts，WorkspaceStore.ts:766-779
  "time_range": {                      // eventTimeRange，queries.ts:318-353（键为 camelCase，保留现状）
    "occurredMin":null,"occurredMax":null,"observedMin":null,"observedMax":null,"undatedCount":0
  },
  "event_days": { …EventDaysResult… }, // queries.ts:412-425，结构同 §1.5
  "events": { …EventPage… },           // queries.ts:54-74，结构同 §1.4（首页，无 cursor 入参）
  "files": { …FileSummaryPage… },      // 结构同 §1.3，首批摘要
  "files_total": 0,                    // active 文件总数（listFiles，WorkspaceStore.ts:540-548）
  "decisions": [ …DecisionAssertion… ],// §1.9 首批（前端首屏要 selectedDecisionId，App.tsx:336-338）
  "relations_total": 0,                // 关系总数；全量关系走 §1.10
  "config": { …WorkspaceConfig… },     // 工作区配置投影
  "index_jobs": [],                    // 进行中的后台索引任务
  "recoverable_file_ids": ["…"]        // 可选（空时省略）：处于 missing|trashed 可恢复态的 file_id，供前端剪枝阅读进度时保留
}
```

**约束**

- 不含正文、完整版本链、全量关系、历史 SVG 原文。即响应中任何位置不出现 `svgSource`、`markdownContent`、`revisions[]`。
- 「已保存数据先显示，后台对账不阻塞」：bootstrap 只读已提交数据，不等待对账。
- 空工作区（首次建索引）各计数为 0、`baseline:false`，前端按「尚未覆盖」渲染而非报错。

### 1.2 GET /api/v1/status

工作区状态与服务实例健康信息。

**响应**

```jsonc
{
  "ok": true,
  "instance_id": "…",            // 服务实例身份（SSE 三元组用）
  "api_version": "v1",
  "schema_version": 2,           // 数据库 schema 版本（contract-storage.md §4.3.1）
  "workspace_id": "…", "root_path": "…", "data_dir": "…",
  "index_generation": 12,
  "last_scan_at": "…|null",
  "baseline": false,
  "counts": { … 同 §1.1 counts … },
  "time_range": { … 同 §1.1 … },
  "index_coverage": { "active_files":0, "missing_files":0 },
  "active_jobs": [],                        // 进行中的索引任务
  "watcher": {                               // 文件监听状态
    "enabled": true,
    "last_poll_at": "…|null",
    "changed_paths_pending": 0,
    "l4a_queue_depth": 0
  },
  "l4a_progress": { "done": 0, "total": 0, "percent": 100 } // total=0 时 percent=100
}
```

前端消费对应 `WorkspaceSummary` 类型（`workspaceClient.ts`）。

### 1.3 GET /api/v1/files

文件摘要分页，支持目录/格式/事项/关键字筛选；**摘要包含当前版本 ID 与版本数**。筛选维度对应服务端可判定的子集（folder/format/role/q；unread/bookmarked 属浏览器个人态）。

**请求参数**

| 参数 | 说明 | 对应现状 |
|---|---|---|
| `cursor` | 不透明游标 | 结构同 0.3，`snap` 为签发时的 `index_generation` |
| `limit` | 默认 100，上限 500 | 分页上限 |
| `dir` | 目录前缀（相对路径，含子目录） | 含子目录语义 |
| `format` | 扩展名 token 或 `class:<族名>` | `files.format` |
| `matter` | 事项/角色，如 `需求\|方案\|…` | `files.role` |
| `q` | 关键字：标题或路径 LIKE | 标题与路径匹配 |
| `status` | 可选：`active\|missing\|trashed\|recoverable`（默认 `active`；`recoverable` 等价 `missing OR trashed`） | 游标指纹纳入 `status` |

**响应**（`FileSummary` = snake_case DTO）

```jsonc
{
  "ok": true, "index_generation": 12,
  "snapshot_generation": 12,          // 游标绑定代际；续页时 != 当前代际 → CURSOR_STALE
  "items": [{
    "file_id": "…",
    "relative_path": "docs/a.md",     // files.current_path
    "title": "…",                     // files.title
    "format": "md", "folder": "docs", "role": "方案",
    "status": "active",               // active|missing|trashed
    "current_revision_id": "…",       // files.last_revision_id
    "revision_count": 3,
    "first_observed_at": "…", "last_observed_at": "…",
    "first_source_time": "2026-11-04|",
      // 最早版本 occurred_at（revisions 按 seq ASC 的第一条 occurred_at），供日历 recentItems 使用
    "coverage": "full_text|svg_text|pdf_page_text|office_structured|filename_only|unindexed",
    "pdf_status": "unindexed",        // PDF 明确覆盖状态（见 §7）
    "snapshot_available": true        // 当前版快照可用
  }],
  "next_cursor": null, "has_more": false,
  "total_matched": 0,                 // 与筛选同口径的计数；侧栏「全部文件」数量来自服务
  "facets": {                          // 侧栏筛选项计数
    "folders": { "docs": 12, "docs/plan": 3 },
    "formats": { "md": 20, "svg": 8, "pdf": 2 },
    "matters": { "需求": 10, "方案": 8 }
  }
}
```

**排序**：`relative_path` ASC，游标键 `(relative_path, file_id)`。

**有界摘要查询口径**：摘要页不装载页内文件的完整版本链，只查本页必需的三组有界集合：精确版本计数（`COUNT(*) GROUP BY`）、首版行（`MIN(seq)` 连接取 `revision_id`/`occurred_at`）、当前版行（`last_revision_id` 命中优先，缺失/悬空回退最高 seq）。`coverage` 判定加 stat 门禁与 `format+content_hash` 判定缓存：blob 缺失或 `snapshot_available=0` 直接如实降级 `filename_only`。

### 1.4 GET /api/v1/events

事件分页查询，继承分页、时间窗口与发生/采集双时间口径。

**请求参数**（query string）

| 参数 | 说明 | 现状 |
|---|---|---|
| `from` / `to` | YYYY-MM-DD 含端点，按 0.3-7 本地日归属 | `EventQuery.from/to`，`queries.ts:18-19` |
| `kinds` | 逗号分隔事件种类（`EventKind` 枚举 `WorkspaceStore.ts:21-29`） | `queries.ts:20`；别名 `kind` 兼容 `workspace-plugin.ts:290` |
| `format` | `md\|svg\|pdf`；工作区级事件不计入 | `queries.ts:22-23`；决策事件格式从 payload.file_id 回填 `COALESCE(f.format, df.format)`（`queries.ts:201,214`） |
| `order` | `occurred`（材料记载）/`observed`（采集），默认 occurred | `queries.ts:24,174` |
| `undated` | `1` 只看日期待考（occurred_at IS NULL） | `queries.ts:26,155-157` |
| `q` | headline/detail LIKE `%q%` | `queries.ts:28,166-169` |
| `limit` | 默认 50，clamp 1..200 | `queries.ts:116-117,175` |
| `cursor` | 不透明游标 | `queries.ts:31,186-187` |

**响应** = 现有 `EventPage`（`queries.ts:54-74`，wire 类型镜像 `workspaceClient.ts:158-177`）：

```jsonc
{
  "ok": true, "index_generation": 12,
  "window": { "order":"occurred","from":null,"to":null,"kinds":[],"format":null,"undated":false,"q":null },
  "snapshot_max_seq": 341,
  "items": [{                        // EventPageItem，queries.ts:34-52；join 见 :209-218
    "seq":341,"event_id":"…","kind":"modified","subject_kind":"revision","subject_id":"…",
    "revision_id":"…|null","occurred_at":"…|null","occurred_precision":"day|second|minute|unknown",
    "occurred_source":"document_self|file_mtime|collector|manifest|git_commit|null",
    "observed_at":"…(UTC ISO)","headline":"…","detail":"…","payload":{…},
    "file_id":"…|null","file_path":"…|null","file_title":"…|null","format":"md|null"
  }],
  "next_cursor":"…|null","has_more":false,
  "total_in_window":57,"undated_count":3,"newer_count":0
}
```

错误：`CURSOR_STALE`（指纹不符/游标损坏，0.2/0.3）、`NOT_FOUND`（workspace 不存在，`queries.ts:178-183`）。

### 1.5 GET /api/v1/events/days

`queryEventDays` 映射（`queries.ts:459-653`；路由 `workspace-plugin.ts:262-285`）。

**请求参数**：`from`/`to`/`kinds`/`format`/`order` 同 §1.4；另有 `granularity`=`day|week|month`（默认 day，桶键：day=YYYY-MM-DD、week=该周周一、month=YYYY-MM，`eventDayBucketExpr` `queries.ts:451-457`）、`limit_days`（默认 30，clamp 1..120，`:471`）、`samples`（每桶样本数，默认 4，clamp 1..12，`:472`；query 名沿用现状 `samples`，`workspace-plugin.ts:281`）。

**响应** = `EventDaysResult`（`queries.ts:412-425`；wire 镜像 `workspaceClient.ts:437-450`）：

```jsonc
{
  "ok":true,"index_generation":12,"order":"occurred","granularity":"day","from":null,"to":null,
  "groups": [{                       // EventDayGroup，queries.ts:402-410
    "date":"2026-11-12",             // ""=日期待考，恒排最后（:628-639）
    "count":9,"by_kind":{"modified":4,"appeared":5},"formats":{"md":6,"svg":3},
    "decisions":[{"decision_id":"…","code":"Q03","status":"已确认","count":2}],   // :514-541，code/status 取组内 MAX(seq) 行
    "samples":[{                     // EventDayItem，queries.ts:374-398；取样优先决策/modified（:559-564）
      "event_id":"…","kind":"…","headline":"…","revision_id":null,
      "file_id":"…|null","file_path":"…|null","file_title":"…|null","file_role":"…|null","format":"…|null",
      "occurred_at":null,"occurred_precision":"unknown","observed_at":"…",
      "time_basis":"document_self|file_mtime|collector|null","action":"raised|conflicted|confirmed|rejected|superseded|shelved|null",
      "decision_id":"…|null","code":"…|null","status":"…|null",
      "ref_count":2,"version_count":5,"statement_count":3
    }]
  }],
  "total": 42, "hidden_days": 0, "undated_count": 3   // hidden_days=超 limit_days 折叠的更早桶数（:636-637）
}
```

**注意**：本端点**无游标、无 snapshot 绑定**（现状即如此，`queries.ts:459` 起无 snap）；窗口聚合允许看到提交后新桶，前端画布用它做标尺而非历史窗口。

**取数口径与桶内决定边界**：

- **先定桶、再富化**：先一次扫描取全范围计数（`total` / 有日期桶数 / 待考事件数），
  再取 `limit_days+1` 个桶键确定返回集合与 `hidden_days`；桶×种类×格式、决策、
  样本三类查询都加 `d = '' OR d >= min_key` 下界，窗口函数只分区返回桶的行——
  请求少量桶不再处理整个命中窗口。
- `total` 仍为**全范围**事件数（含被 `limit_days` 折叠的更早桶与待考桶），
  `hidden_days` / `undated_count` / 样本优先级 / seq 排序语义不变。
- **桶内决定独立边界**：`decisions[]` 上限 20 条（按桶内事件数降序、decision_id 升序），
  新增 `decision_total`（桶内去重决定总数）与 `decisions_truncated`。截断时客户端可经
  `GET /api/v1/events?from=该桶日期&to=该桶日期&kinds=decision_raised,decision_changed`
  按有界分页继续读取（不新增端点）。
- 样本的 `ref_count`/`version_count`/`statement_count` 仍为按来源文件的关联计数
  （已走 file_id 索引）；后续若出现热点，可改为按最终样本的唯一 file_id 批量聚合。
- 说明：本项为**结构性**收敛（先截断后富化 + 独立边界），COUNT 的实际求值次数
  未做执行计划压测。

### 1.6 GET /api/v1/events/range

`eventTimeRange` 映射（`queries.ts:318-353`；路由 `workspace-plugin.ts:314-318`）。无参数。

**响应**（camelCase 保留现状，`workspaceClient.ts:202-209`）：

```jsonc
{ "ok":true, "occurredMin":"2026-06-01|", "occurredMax":"…|", "observedMin":"…|", "observedMax":"…|", "undatedCount":3, "index_generation":12 }
```

日期取值经 `localDayExpr`（`queries.ts:331-334`），纯日期短路不换时区。

### 1.7 GET /api/v1/files/{file_id}/revisions

指定文件版本链分页。

**请求参数**：`cursor`、`limit`（默认 50，上限 200）、`order`=`seq_asc|seq_desc`（默认 `seq_desc`）、`include`=`events,statements,edges,aliases`（逗号分隔可选；`aliases` 首页返回历史路径别名链）。

**响应**：

```jsonc
{
  "ok":true,"index_generation":12,
  "file": {                          // projectFileHistory.file，project.ts:513-523
    "file_id":"…","current_path":"…","title":"…","format":"md","role":"…",
    "status":"active","first_observed_at":"…","last_observed_at":"…","last_revision_id":"…|null"
  },
  "revisions": [{                    // project.ts:454-466 字段逐字保留（snake_case）
    "revision_id":"…","seq":3,"prev_revision_id":"…|null","content_hash":"…",
    "size_bytes":12345,"observed_at":"…","occurred_at":"…|null",
    "occurred_precision":"day","occurred_source":"document_self|null","snapshot_available":true
    // 不下发 snapshot_path（服务端绝对路径不进 UI，project.ts:465 注释）
  }],
  "next_cursor":null,"has_more":false,"total":3,
  "events":   [ … ],   // 仅 include 含 events：project.ts:473-485 四路覆盖（subject_id / revision 链 / payload.file_id / path: 前缀），字段 project.ts:525-537
  "statements":[ … ],  // 仅 include 含 statements：project.ts:487-498
  "edges":    [ … ],   // 仅 include 含 edges：project.ts:500-510
  "aliases":  [ … ]    // 仅首页且 include 含 aliases：path_aliases 历史路径列表（按首次观测序）
}
```

**契约理由**：`FileTimelineDrawer` 同时需要 file+revisions+events 与按需正文；`DocumentTimeMachineView` 需要版本链+批量正文。单文件数据量小（版本链按文件独立 seq），允许首页 `include=events,statements,edges` 一次带回、`revisions` 仍分页。

**分页与计数语义**：
- `include` 附集合（events/statements/edges，文件级完整口径）**只在首页携带**——续页请求（带 `cursor`）一律不下发，服务端也不再查询。
- `total` 为精确 `COUNT(*)`（非 `MAX(seq)`，seq 空洞下仍准确），首页计算一次后**随游标携带**，续页复用不再重复 COUNT 整条版本链；不含 `total` 字段的游标续页回退现算。

**错误**：`NOT_FOUND`（404，文件不存在）。

**阅读器兼容视图**：`GET /api/v1/files/{file_id}/detail` 收敛为**文件头 + 当前版**（`last_revision_id` 命中优先、最高 seq 回退，与 §1.3 摘要投影同口径），不读取完整版本链、不内联任何正文（正文一律经 §1.8 按版本端点单独取）；附集合（events/statements/edges）限额各 200 条（seq ASC 前 200）；应用内前端已统一走 §1.7 分页通道（`fetchFileHistory`），本端点仅保留作外部兼容视图。

### 1.8 GET /api/v1/revisions/{revision_id}/content

按版本读正文。

**请求参数**：`raw=1`——流式返回原始快照字节（PDF 为 `application/pdf`，UTF-8 文本/SVG 为 `text/plain; charset=utf-8`）。

**响应**：

- PDF 默认（无 raw）：
  ```jsonc
  { "ok":true, "format":"pdf", "revision_id":"…", "raw_url":"/api/v1/revisions/<id>/content?raw=1" }
  ```
- MD/SVG：
  ```jsonc
  { "ok":true, "format":"md|svg", "revision_id":"…", "text":"…" }
  ```

**错误**：`NOT_FOUND`（404，revision 不存在）；`SNAPSHOT_UNAVAILABLE`（410，`snapshot_available=0` 或快照文件缺失）。仅按 `revision_id` 读取，**不提供任意路径下载**。

**响应字节预算**：

- `raw=1` 对 **MD/SVG 同样有效**：快照原字节 `text/plain; charset=utf-8` 分块流式回包（PDF 仍为 `application/pdf`），恒定内存，不受内联上限约束。大正文的推荐读取方式。
- MD/SVG 无 `raw` 时的内联路径有**单响应上限**（默认 8 MiB，`GUANLAN_RESPONSE_MAX_MIB` 可调）：打开快照后以**实际文件大小**判定（不信任 DB 的 `size_bytes`），超限返回 `413 UNSUPPORTED_CONTENT`，`detail` 指向 `raw=1`；不整读后再判断。
- 上限内的读取受**全局字节预算**约束（默认 64 MiB，`GUANLAN_RESPONSE_BUDGET_MIB` 可调）：受理前按实际大小预占，预算耗尽等待上限 5s 后按 `503 INDEX_BUSY` 拒绝（可重试）；许可随响应体（BudgetedBody）被读完/丢弃才归还，覆盖「原始字节 → 文本转换 → JSON 缓冲 → 发送」全生命周期。
- 读取、utf-8 转换与 JSON 序列化全部在阻塞线程池执行（不占异步运行时线程），并在数据库读事务结束后进行。
- `UNSUPPORTED_CONTENT` 为扩展错误码，HTTP 413。

**快照流式响应的范围与条件请求**：

- 所有流式快照响应（`raw=1` 的 MD/SVG/PDF、PDF 默认二进制）带 `Accept-Ranges: bytes`、
  `Content-Length` 与**稳定 ETag**（`"sha256-<content_hash>"`，内容寻址、跨重启稳定）；
  `Cache-Control: private, max-age=0, must-revalidate`（允许条件请求复用，不允许中间层长期缓存）。
- 单区间 `Range` 支持：`bytes=0-99`、开放结尾 `bytes=100-`、后缀 `bytes=-100` →
  `206` + `Content-Range: bytes start-end/len` + `Content-Length`；仍 64KiB 分块流式。
- 不可满足（起点越界 / `end<start` / 空文件）→ `416` + `Content-Range: bytes */len`。
- 多区间或不认识的单位 → **明确回退全量 200**（不做 multipart/byteranges）。
- `If-None-Match` 命中 → `304`（无 body）；`If-Range` 不匹配 → 忽略 Range 返回全量
  （HTTP-date 形式不支持，因为不发布 `Last-Modified`）。
- 快照不可用语义不变：打开/读取失败仍是 `410 SNAPSHOT_UNAVAILABLE`；条件请求不绕过可用性检查。

**快照定位的 hash 形态校验**：`content_hash` 必须是 64 位 ASCII 十六进制；
异常/损坏库里的非法值返回明确错误（`INTERNAL`，消息含「content_hash 格式非法」）而不是
在路径拼接处 panic。coverage 判定遇到非法 hash 时如实降级 `filename_only`。

### 1.8.1 GET /api/v1/revisions/{revision_id}/preview（QuickLook 轻预览）

用于 `Space` 键 `<100ms` 原位秒预览器：一次请求同时返回格式分类、尺寸元数据（仅解析图像头部 ≤64KiB）、有界 UTF-8 切片（默认 `max_bytes=65536`，上限 `262144`，支持 `offset` 分片续读）、魔数签名 / 64B 十六进制头（二进制），以及同文件最近 24 条修订历史与体积演进 `delta_bytes`。

- `snapshot_available=false`（L0 大二进制或超配额版本）仍返回 `200 OK`（诚实标记 `snapshot_available:false`，不下发 `text_slice`/`raw_url`），供前端直接呈现大二进制体检卡；未知 `revision_id` → `404 NOT_FOUND`。
- 带 `ETag`（绑定内容哈希、代际与切片窗口）+ `If-None-Match` → `304 Not Modified`。

### 1.8.2 GET /api/v1/revisions/{revision_id}/thumbnail（图像/矢量流式缩略）

供轻预览浮层与卡片流式加载 `Image` / `Vector` 快照，支持 `Range`（`206`）、`ETag` / `If-None-Match`（`304`）、`If-Range` 与 64KiB 分块流式回包；非图像格式返回 `413 UNSUPPORTED_CONTENT`，无快照返回 `410 SNAPSHOT_UNAVAILABLE`。

### 1.9 GET /api/v1/decisions

决定列表。

**请求参数**：`cursor`、`limit`（默认 100）、`status`（`待确认|已确认|已否决|已搁置|已取代|来源不一致|未知`）、`code`（编号精确匹配）、`q`（question/namespace LIKE）。

**响应**：

```jsonc
{ "ok":true,"index_generation":12,"snapshot_generation":12,
  "items":[ …DecisionAssertion… ],
  "next_cursor":null,"has_more":false,"total":12 }
```

排序：`来源不一致 < 待确认 < 已确认 < 其他`，再按 code 字典序，并列时以 `decision_id` 字典序定全序（游标键携带末位 `decision_id`，并列组内续页不重不漏）。同一 `decision_id` 的陈述按「来源文件最新版本观察时间 → 陈述观察时间 → 行号」取主陈述。游标语义按可变列表处理：相关提交使游标失效 → `CURSOR_STALE`。

**两级投影取数口径**：先用 SQL 窗口函数（`ROW_NUMBER() OVER (PARTITION BY decision_id ORDER BY COALESCE(r.observed_at, s.observed_at) DESC, s.observed_at DESC, s.line_start ASC)`）产出「一行一决定」的摘要投影，筛选/排序/键集分页全部作用于摘要；随后只为**本页**决定按 `decision_id IN (…)` 取陈述构造完整 `evidences[]`。`missing` 文件或缺失版本行的陈述经 `LEFT JOIN` 保留为证据（`relativePath` 为空串，不伪造路径），历史陈述一并保留。`total` 仍为全量摘要数（不受分页影响）。

### 1.10 GET /api/v1/relations

返回工作区内可落文件的引用边（过滤 `unresolved:` 前缀，`type='explicit_reference'`、`label` 按 resolution、`locator.startLine/endLine`），响应 `{ ok, index_generation, items: RelationEdge[] }`。

---

## 2. 写入、长任务与检索端点

### 2.1 索引任务

| 端点 | 方法 | 状态 | 契约要点 |
|---|---|---|---|
| `/api/v1/index-jobs` | POST | **已交付** | `verify_all` → `202 { ok, job_id, state, merged, index_generation? }`；同工作区重复重扫**合并**（返回同一 `job_id`，`merged:true`），不并发启动第二轮完整对账。同时支持 `changed_paths`、`l4a_summary` 与 `set_initiative_dirs`；`metadata_reconcile` 与未知/内部 kind 返回 `400 BAD_REQUEST`——**不假装已受理** |
| `/api/v1/jobs/{job_id}` | GET | **已交付** | `{ ok, job_id, kind, state, phase, discovered, processed, failed_items, index_generation?, last_scan_at?, error?, report? }`；`state ∈ queued/running/completed/failed`，未知 id → `404 NOT_FOUND` |

`GET /api/v1/status` 的 `active_jobs` 字段同步给出**进行中**的任务；`/api/v1/bootstrap` 的 `config.runtimeStatus.serviceState` 在对账期间为 `reconciling`（其余为 `monitoring`）。

开启后台索引时，服务启动即在写线程上排一轮 `verify_all`（后台对账，不阻塞读路径）。

### 2.2 长任务引擎与上下文基座端点

> 新 DTO 统一 snake_case；错误包络同 §0.2；成功恒 `ok:true`、响应带 `index_generation`。
> 扩展码 `CONFLICT(409)`（见 §0.2 码表）。状态机与长任务事件 kind：`state_changed / decision_writeback /
> proposal_raised / checkpoint_committed / initiative_archived / initiative_reopened /
> task_node_moved`；迁移类事件 subject_id 编码迁移方向（`{id}:{from}->{to}`），首建静默
> （contract-storage.md §4.3.3）。

#### A. GET /api/v1/state-overview?initiative_id= — 统一状态机投影（四视图唯一数据源）

`200 { ok, index_generation, generated_at, initiatives:[{ initiative_id, name, root_dir, current_stage:'蓝图'|'计划'|'决策'|'执行'|'交付'|'待分类', state:'draft'|'pending_review'|'approved_revision'|'executing'|'delivered'|'archived', artifact_count, pending_p0, pending_p1, pending_p2, updated_at }], artifacts:[{ file_id, initiative_id|null, current_path, title, stage, state, selected_revision_id|null, checklist_done, checklist_total, pending_p0, pending_p1, pending_p2, last_activity_at|null }] }`。
schema v2 之前的库返回空投影（首轮 reconcile 后有数）。规则 SSOT：`guanlan-core/src/index/state_machine.rs`；迁移规则与确定性口径见 contract-storage.md §4.3.6。

#### B. POST /api/v1/context — 智能体上下文包（双模输出）

请求：`{ intent:'document'|'initiative'|'global', focus_file_id?, initiative_id?, items?:[{ file_id, revision_id?, granularity:'full'|'summary'|'diff_only'|'metadata_only'|'decisions_only' }], mode:'structured'|'markdown'|'both', budget_tokens?(默认 65536) }`。
items 缺省/空 → 按三入口默认规则组装（document=焦点全文+专项核心摘要+未决；initiative=各阶段摘要+当前阶段**全量**+未决；global=Top-3 专项摘要+全局 P0/P1）。当前阶段文档以全量注入、不重复挂阶段摘要（同一文档去重，保留首现粒度）。
`200 { ok, index_generation, intent, workspace_root, initiative_id|null, preset:{ items:[{ file_id, path, title, revision_id, seq, version_label, state, granularity, snapshot_available, est_tokens, content? }], recommended:[同构+reason∈{本文引用,同专项引用,跨专项引用,命名关联}] }, decisions:{ pending:[{ decision_id, statement_id, code, priority, question, file_id, path, line_start }], confirmed:[{ decision_id, decision_text, confirmer, effective_date|null }] }, token_budget:{ selected, est_tokens, threshold, over_threshold, downgrade_suggestions:[file_id…] }, markdown|null, payload|null }`。
Markdown = 模式 A `<guanlan_context>` XML；payload = 模式 B `guanlan-mcp/v1`（session_checkpoint_id/context_bundle/allowed_mcp_tools/guardrails）。Token 公式双端逐字：`est_tokens = ceil(cjk_chars*0.7 + non_cjk_bytes/3.5)`，CJK 码位写死 U+3000–U+303F∪U+4E00–U+9FFF∪U+F900–U+FAFF∪U+FF01–U+FF5E；向量单源 `native/testdata/token-vectors.json`（Rust include_str! 编译期断言 + 前端 fs.readFileSync 同源）。估算为启发式（±20% 级），64k 阈值判定双端同公式即满足约束。推荐挂载排序：本文引用(3)/同专项引用(3) > 跨专项引用(2) > 命名关联(1)（unresolved 边=命名关联）。intent=document 缺 focus_file_id、intent/mode/granularity 词非法 → 400；initiative/文件不存在 → 404。

#### C. GET /api/v1/statements + POST /api/v1/decisions/{statement_id}/resolve — 拍板表单与回写

- `GET /api/v1/statements?file_id=&status=&limit=`：`status` wire 词映射：`pending→'待确认'`、`confirmed→'已确认'`、`rejected→'已否决'`、`shelved→'已搁置'`、`superseded→'已取代'`；其余/未传=全部。`200 { ok, index_generation, items:[StatementDetailDTO] }`，StatementDetailDTO=`{ statement_id, revision_id, code, question, status, line_start, line_end, decision_id|null, options|null, recommendation|null, impact_blocked|null, impact_allowed|null, confirmer_hint|null }`。
- `POST /api/v1/decisions/{statement_id}/resolve` body `{ decision, confirmer, role?, effective_scope?, effective_date?('YYYY-MM-DD'), note? }` — **恒 202** `{ ok, job_id, statement_id, decision_id }`（端点永不 409）。job 终态：CAS 成功→`completed`+`report.writeback={cas_ok:true, file_changed:true, new_revision_id, decision_id}`；CAS 失败→同样 `completed`（检测到冲突并存草案），`report.writeback={cas_ok:false, file_changed:false, new_revision_id:null, cas_conflict:{expected_content_hash, disk_content_hash}}`，`error/failed_items` 恒空；CAS 失败同时落 `revision_drafts(status='proposed', conflict=1)`+`proposal_raised` 事件。CAS 成功后写线程内直接重算 → await_decision 槽迁移事件 + SSE。回写内容：状态词变更（`[P1 - 已确认]`）+ 决定/确认人/角色/生效范围与日期占位符回填 + front matter `revision+1`（仅当命中）。
- resolve 命中 archived 专项 → 同步 `409 CONFLICT「已归档文档需先人工重开」`（受理前置检查）。

#### D. /api/v1/revision-proposals — Agent 修订草案

- `POST /api/v1/revision-proposals` body `{ file_id, base_revision_id, content, note? }` — **恒 202** `{ ok, job_id, draft_id, conflict }`（conflict 为受理初判预览，权威结果在 job `report.proposal={draft_id, cas_ok, status:'proposed', conflict}`；cas_ok=false=agent-draft 分支，`revision_drafts.conflict=1`）。archived 主体 → 409。
- `GET /api/v1/revision-proposals?status=&cursor=` — `200 { ok, index_generation, items:[{ draft_id, file_id, path, base_revision_id, proposed_content_hash, source:'mcp'|'agent', status, conflict, note|null, created_at }], next_cursor|null }`。
- `POST /api/v1/revision-proposals/{draft_id}/adopt` — `202 { ok, job_id }`（`report.adopt={cas_ok, new_revision_id|null, cas_conflict|null}`，成功后写线程重算）；`POST .../{draft_id}/dismiss` — `202 { ok, job_id }`。CAS：采纳时磁盘哈希必须等于草案基准哈希，冲突不覆盖。

#### E. /api/v1/checkpoints + /api/v1/initiatives/{id}/tasks — 长任务 DAG 与断点续跑

- `POST /api/v1/checkpoints` body `{ node_id?, initiative_id, stage:'蓝图'|'计划'|'决策'|'执行'|'交付', status:'SUCCESS'|'FAILED_RETRYABLE'|'SUSPENDED_HITL', input_context_hash, output_revision_id?, token_usage?, elapsed_ms?, note? }` — **同步受理**：`201 { ok, checkpoint_id, node_state:string|null }`；校验失败（专项/阶段不存在）→ `404 NOT_FOUND`（checkpoint 不落库）；写线程积压时 handler 等回执 5s 超时 → `503 INDEX_BUSY`。**node_id 缺省时按 (initiative_id, stage) 反查槽位推进**。**外部智能体经 `guanlan.commit_checkpoint` 提交 SUCCESS checkpoint 是执行槽唯一完成通道**。checkpoint seq 由库内行数派生（重启安全）；重复 SUCCESS 追加新行，「最近一次 SUCCESS」恢复 = created_at/rowid 最新。SUCCESS 行落 `checkpoint_committed` 事件。
- `GET /api/v1/checkpoints?initiative_id=&node_id=&status=&limit=` — `200 { ok, index_generation, items:[{ checkpoint_id, node_id|null, initiative_id, stage, status, input_context_hash, output_revision_id|null, token_usage|null, elapsed_ms|null, note|null, created_at }], next_cursor|null }`（恢复=取节点最新 SUCCESS）。
- `GET /api/v1/initiatives/{initiative_id}/tasks` — `200 { ok, index_generation, nodes:[{ node_id, stage, node_kind:'derive'|'await_decision'|'generate'|'deliver', title, state:'queued'|'running'|'completed'|'suspended_on_hitl'|'cancelled'|'failed', depends:[node_id…], latest_checkpoint_id|null, error|null }] }`。五槽位为**声明式跨轮持久态**，每轮 reconcile 幂等重算。FAILED_RETRYABLE 只记录不自愈：derive/deliver/await 槽每轮重算等效重判，generate 槽重试由外部 agent 重新提交。
- `GET /api/v1/initiatives/{initiative_id}/resume-context?stage=` — `200 { ok, index_generation, initiative_id, checkpoint:{ checkpoint_id, stage, output_revision_id|null, output_artifact_version|null, created_at }|null, delta:[{ file_id, path, title, revision_id, version:'vN', observed_at }], latest_decisions:[{ decision_id, code, question, status, priority, quote, file_id, path, line_start, line_end }], prompt_context }`。取最近 SUCCESS checkpoint（stage 可选过滤）之后的增量文件（每文件最新一版）+ 该专项每个 decision 的主陈述；`prompt_context` 为可直接注入外部 Agent 下一步 Prompt 的文本，**引擎不做 Prompt 注入/编排**。无 SUCCESS checkpoint 时 `checkpoint=null`、`delta=[]`，仍返回最新决策并明确提示无可用快照。

#### F. /api/v1/initiatives/{id}/archive + /reopen — 归档与重开

`POST .../archive` body `{ note? }` — `202 { ok, job_id }`（写线程 initiative.state→archived + 其 artifacts→archived + `initiative_archived` 事件 + 重算；非 Delivered 态 `result.initiative.warn='当前非已交付态'`）。`POST .../reopen` — `202 { ok, job_id }`（archived→显式回退 draft，后续状态由状态机按当前信号重算 + `initiative_reopened` 事件）。

#### G. /api/v1/index-jobs 与 /jobs/* 扩展

- 外部可提 kind：`verify_all | changed_paths | l4a_summary | set_initiative_dirs`（`paths?:string[]` changed_paths 必填 ≤2000、`dirs?:string[]` set_initiative_dirs 必填 ≤64，写入 meta.initiative_dirs）。**内部 kind（decision_writeback/propose_revision/adopt_draft/archive_initiative/reopen_initiative/diff/checkpoint_commit）外部直提返回 400**。
- **per-kind 合并**：跨 kind 永不合并（新任务入队串行执行）；`verify_all` 单飞、`changed_paths` 合并去重、`set_initiative_dirs` 幂等覆盖**仅在同类 active 任务间生效**。
- JobState 四态不变（挂起语义只存在于 task_nodes 层，job 是瞬时执行载体）；取消口径：`POST /api/v1/jobs/{job_id}/cancel` — `202 { ok, job_id, state }`（queued 立即生效，wire state 报 `cancelled`；running 协作式——写线程阶段间隙检查取消标记，事务提交点不可中断；已结束 → `409 CONFLICT`）。
- `GET /api/v1/jobs/{job_id}` 响应扩 `result:{...}|null`（writeback/proposal/adopt/dismiss/diff/l4a/initiative 分支）；`GET /api/v1/jobs/{job_id}/result` — `200 { ok, job_id, state, kind, result:{...}|null, next_cursor|null }`。job_runs 持久化：重启后 queued/running 重入队，启动 verify_all 收尾重算闭合重启孤儿。

#### H. POST /api/v1/diff — 语义级版本 Diff 走任务队列

`{ file_id, baseline_revision_id, target_revision_id }` → `202 { ok, job_id }`。JobKind::Diff 写线程执行：两版快照读（单版 8MiB 上限，超限 413 进 job error）→行级 LCS（≤2000 行预算，超限 truncated）→语义摘要卡**直接比对两版正文与 statements**。`result={ summary:{ headline, items:[{ label, count, sign }], checkpoint_id|null }, sections:[{ title, baseline_start, target_start, lines:[{ type:'same'|'add'|'del', text }] }], truncated, next_cursor|null }`。三项指标：新增交付项=checklist_done(目标)−checklist_done(基线)；关闭未决事项=基线 pending(P0+P1)−目标 pending（decision 最新状态口径）；修改接口契约处数=两版中 namespace 含『接口』|『数据格式』|『契约』的陈述行段并集计数。

#### I. GET /api/v1/summary/{file_id} + /status 扩展 — L4A 摘要

- `GET /api/v1/summary/{file_id}` — `200 { ok, index_generation, file_id, revision_id, content_hash, summary:{ core_summary, outline:[{ level, title, line }], decisions_digest:{ confirmed, pending, p0, p1 }, generated_by:'local_deterministic', extract_rule_version:'l4a-v0.1.0' }|null, queued }`。摘要为确定性本地计算（不调用模型），批量 ≤3/轮 + 交错让位。
- `/status` 扩展：`watcher:{ enabled, last_poll_at|null, changed_paths_pending, l4a_queue_depth }` + `l4a_progress:{ done, total, percent(0-100，total=0 时=100) }` + `schema_version:2`。

#### J. GET /api/v1/stream — SSE

`text/event-stream`。hello：`{ type:'hello', instance_id, notice_seq, index_generation }`；workspace-change：`{ type:'workspace-change', index_generation, new_events, new_revisions, at, kinds:string[]∈{'watcher','decision_writeback','proposal','l4a','state','task','candidates','search'} }`；心跳 `: ping` 15s。notice_seq 为传输层取号器（独立于业务 events.seq）。监听语义不变：watcher 只作触发核验信号、不作审计日志，版本判定永远由对账做（OS 原生事件驱动，100ms 滑动防抖 + 220ms 合并上限，300s 兜底轮询只做 mtime stat 比对、不哈希）。

#### K. MCP stdio 代理

`guanlan mcp` 子命令（`mcp/mod.rs`）：手写 JSON-RPC 2.0 over stdio（按行分隔 JSON）与最小 HTTP/1.1 客户端。endpoint = `--endpoint` 参数或 `GUANLAN_ENDPOINT` 环境变量，两者皆缺 → stderr 一行错误包络 + 退出码 1（不猜端口）。协议面：initialize（回显客户端 protocolVersion，缺省 2024-11-05）/ initialized 通知忽略 / tools/list / tools/call / ping；未知方法 -32601、未知工具 -32602、解析失败 -32700；工具级失败以 isError 结果回传不断协议。6 个白名单工具（顺序固定，全部转发到同一服务的 HTTP 等价端点）：
- `guanlan.read_artifact`：path/uri（guanlan://<相对路径>）→ GET /files?q= 精确匹配 → GET /revisions/{id}/content（md/svg 内联 text；413 超预算回退 raw=1 纯文本；pdf 返回 raw_url 指引）；
- `guanlan.propose_revision`：content + file_id|path（base 缺省取当前版）→ POST /revision-proposals（202）→ 有界轮询 /jobs/{id}（300ms×33≈10s 封顶）回报 report.proposal；
- `guanlan.resolve_decision`：POST /decisions/{id}/resolve（恒 202）→ 同轮询回报 report.writeback（含 CAS 分支）；
- `guanlan.commit_checkpoint`：载荷直传 POST /checkpoints（同步 201）；
- `guanlan.get_context_bundle`：POST /context，Token 预算感知的上下文包；
- `guanlan.search_workspace`：GET /search，敏感凭据路径在代理侧二次过滤。

### 2.2.1 身份保真文件操作

经唯一写入线程串行同步执行（磁盘操作 + 单 SQLite 写事务原子落账），成功后推进 `index_generation` 并通过 SSE `workspace-change` 广播 `kinds:["file_op","state"]`；写线程繁忙时等待回执超时返回 `503 INDEX_BUSY`（单文件操作 5s，文件夹操作 10s，批量操作 15s）。

- `POST /api/v1/files/{file_id}/rename` body `{ new_name }` — 同目录原子重命名；拒绝 `..`/斜杠/盘符/冒号/控制符/点号隐藏名/Windows 保留名及不兼容格式扩展名变更（`400 BAD_REQUEST`），目标已存在返回 `409 CONFLICT`。
- `POST /api/v1/files/{file_id}/move` body `{ target_dir, new_name? }` — 工作区边界内安全跨目录移动（`target_dir=""` 或 `"."` 为工作区根；缺失子目录在工作区安全边界内自动创建；拒绝逃逸符号链接、点号隐藏目录与 `DEFAULT_EXCLUDED` 排除目录）。
- `POST /api/v1/files/{file_id}/trash` body `{ confirm: true }` — **仅移入操作系统回收站**（Windows COM `IFileOperation` + `FOFX_RECYCLEONDELETE`，回收站不可用时失败而不永久删除 / macOS Trash / Linux FreeDesktop Trash），强制要求 `confirm: true`（否则 `400 BAD_REQUEST`），严禁任何永久物理删除 API。将 `files.status` 置为 `trashed`；从系统回收站还原后下轮对账经 `files` / `path_aliases` / 同哈希候选自动重连原 `file_id`。
- **统一响应（`FileMutationResponse`，HTTP 200）**：`{ ok:true, operation:"file_renamed"|"file_moved"|"file_trashed", file_id, old_path, new_path:string|null, title, role, status:"active"|"trashed", event_id, index_generation, trash_recoverable:boolean }`。

### 2.2.2 全格式查询、存储统计与三档配额策略

- **`GET /api/v1/files` 与 `GET /api/v1/events` 的 `format` 参数扩展**：不再限制为 `md|svg|pdf`，接受任意合法小写扩展名 token（如 `ts`、`png`、`docx`、`xlsx`、`mp4`）或 `class:<族名>`（仅 `/api/v1/files`，如 `class:image`、`class:code`）。
- **`GET /api/v1/revisions/{revision_id}/content` 非 UTF-8 格式分支**：所有非 UTF-8 文本格式（PDF、图片、Office 文档、归档等）默认返回 `{ ok:true, format, revision_id, raw_url }`，通过 `?raw=1` 按对应 MIME 类型流式分块输出（支持 `ETag` 与 `Range`）；`snapshot_available = 0`（第三档或超阈值降级）诚实返回 `410 SNAPSHOT_UNAVAILABLE`。
- **`GET /api/v1/storage/stats`**：返回当前工作区本地快照占用与全格式分布 `{ ok, index_generation, workspace_id, data_dir_path, blobs_bytes, blobs_disk_bytes, blobs_count, db_bytes, total_disk_bytes, used_total_mib, active_files_count, revisions_total, full_snapshot_revisions, metadata_only_revisions, gitignore_respected, policy, by_class, by_format }`。
- **`POST /api/v1/storage/policy`**：body `{ text_max_mib, binary_max_mib }`（范围分别 `1..512` 与 `1..2048`），通过唯一写线程写入 `meta` 表，立即生效于后续扫描与增量监听。

### 2.3 预留未实现端点（501 桩）

桩响应统一：`501 Not Implemented` + 错误包络 `{ ok:false, code:"NOT_IMPLEMENTED", error:"..." }`：

| 端点 | 方法 | 契约要点 |
|---|---|---|
| `/api/v1/graph` | GET | 局部关系：`center_id + depth(1|2)`，限制跳数/节点数/返回字段；语义参照 `buildLocalRelationGraph`（`guanlanEngine.ts`，maxNodes=80，hop 0/1/2，含 revision_evolution 节点）；布局由前端 D3 负责 |

### 2.4 有界检索：全文 + 路径 + 符号混合倒排索引

**检索索引（可随时丢弃重建的派生层；存储契约见 contract-storage.md §12）**：只索引每个文件的最新版本（`revisions.seq` 最大者——检索语义为「找到当前文件」，历史版本经版本链端点追溯）；`status != 'active'`（trashed/missing）不入索引。词项三字段：`title`（权重 60：整段词/Bigram/缩写）、`path`（权重 45：同规则 + 路径分段 + 首字母缩写 `user-auth-service`→`uas`）、`content`（权重 10；中文双字 Bigram + 英文词元 + 专有编号整词权重 15 + CJK 单字权重 5）。文本源：UTF-8 文本族与 SVG（抽 `<text>` 文本行）走 blobs 快照，PDF 走 `pdf_extracts` 页级文本（行→页锚），docx/xlsx 走 `office_extracts`（段落/单元格锚）；第三档 `metadata_only` 或无文本层 → `has_body=0` 仅标题/路径可检索（诚实口径，PDF 未索引仅文件名语义保留）。

**同步与重建**：`reconcile` 尾部（状态机重算后、代际判定前）轻量差分——只重算「版本/路径/状态有变化」的文件；规则版本（`meta.search_rule_version=s1`）不符或状态标记（`meta.search_state`）缺失 → 自动全量重建。派生索引变化**不推进 index_generation**。显式重建：`POST /api/v1/search/rebuild` → 202 + `JobAccepted`（内部 `JobKind::rebuild_search_index`，SSE kinds 恒含 `search`；job result `{ search_index: { rebuilt, docs_synced } }`）。

**`GET /api/v1/search?q=<关键词>&format=&dir=&limit=`**（缺 `q` / 空白 `q` → 400 BAD_REQUEST；`limit` 默认 30，clamp 1..100）：

- 响应壳：`{ ok, index_generation, query, mode, total_matched, items: SearchHit[], truncated, search_state }`——`mode ∈ {code, single, phrase}`；`truncated = total_matched > items.length`；`search_state ∈ {ready, building, absent}`，**非 ready 时 items 恒空**（绝不拿半成品索引冒充结果）。
- 检索管线三通道：① `search_postings` 跨词项 AND 交集（候选宽）；② 候选文档 `body_text` 行级回源核验——查询短语必须**在同一行内**小写化原样出现，否则丢弃（中文双字与专有编号召回准确率 100% 由该步锁定）；③ 编号查询（`mode=code`）追加 `statements.code` 精确通道（`coverage=decision`，分数恒置顶）。
- matchStrategy 四态（沿用前端 `guanlanEngine.ts:72-87` 语义）：`exact_code`（编号：内部 ID 正则 `^(q\d+|t-\d+|cand-\d+|rev_\w+|file_\w+)$` + 通用业务编号 `word[-_]digits` + `#digits`；正文/决定回源核验通过）、`bigram_phrase_verified`（≥2 字符短语行级核验通过）、`single_char_bounded`（单字有界回退）、`filename_match`（标题/路径子串命中，或 title/path 字段拿到整段词/缩写/Bigram 级词项——文件名缩写检索由此承载）。
- `SearchHit`：`{ file_id, revision_id, relative_path, title, format, coverage, match_strategy, locator, snippet, score, stale:false }`；`coverage ∈ {full_text, svg_text, pdf_page_text, office_structured, filename_only, decision}`。`locator` 按 `kind` 判别（**行号/页码一律 1-based**）：`{kind:'lines',start,end}`（md/文本/代码/csv/json）、`{kind:'svg_text',fragment}`、`{kind:'pdf_page',page}`（行→页锚）、`{kind:'office',anchor}`（`#para=N` / `Sheet!A3`，对齐 officeAnchor）、`{kind:'file'}`（无正文定位）。`snippet` = 命中行原文 trim 后 ≤240 字符（决定陈述命中为 quote）。
- 有界口径：每文件命中上限 3；单次核验候选上限 200（评分序截断）；无游标分页（单页 top N）。
- 筛选参数：`format` 接受小写扩展名 token 或 `class:<族名>`（对齐 §1.3 族名口径）；`dir` 为目录前缀含子目录（`'.'` 仅根散文件，对齐 §1.3）。
- 一致性：派生索引非 ready（building/absent）时诚实空结果；`index_generation` 来自只读认领行（派生层不推代际）。

**测试锁定**：core `query::search_tests` 5 例（Bigram 行级核验与行号 / 编号双通道置顶 / 缩写回退 / 非 ready 诚实空与自动重建 / 损坏一键重建恢复 / trashed 移除）+ service `c02_search_hybrid_index_and_rebuild_end_to_end`（HTTP 全链路：四态策略 / 筛选 / 损坏 → 202 重建 → 恢复）。

### 2.5 跨项目只读挂载与联合检索

**挂载参考工作区（只读第二库）**：允许把其他已被观澜索引过的工作区以只读方式挂到当前会话，跨项目检索历史已采纳的规范、架构图与决定依据。参考区经 `ReadonlyStore::open_at`（`SQLITE_OPEN_READONLY`）打开其数据目录下的 `index.db`——**参考区零写入**，与主区唯一写线程互不相干；路径规范化与挂载身份规则见 contract-storage.md §13（plain() 语义，`\\?\` 长路径 / 混合斜杠 / 尾分隔符写法身份哈希恒一致）。

**`GET /api/v1/mounts`** → `{ ok, index_generation, items: MountedWorkspaceInfo[] }`；**`POST /api/v1/mounts`**（body `{ root_path }`，同步受理）→ `{ ok, mount: MountedWorkspaceInfo }`；**`DELETE /api/v1/mounts/{mount_id}`** → `{ ok, mount_id }`（只断开只读连接，绝不动参考区磁盘与索引库；未知 mount_id → 404）。

- `MountedWorkspaceInfo`：`{ mount_id（`m_<mount_key>`）, mount_key, root_key（参考区库内身份哈希）, root_path（plain() 规范化）, name（根路径末段）, online, index_generation, search_state, file_count, error?, last_seen_at? }`。`online=false` 为**离线降级**：其余字段是最后已知摘要（重启装载失败 / 在线探测失败时保留），`error` 带人类可读原因——优雅离线，绝不伪造在线数据。
- 挂载校验顺序（确定性错误码优先于磁盘 IO）：① 与当前工作区父子互斥 / 自我挂载 → **409 `MOUNT_REJECTED`**；② 与既有挂载父子互斥 → **409 `MOUNT_REJECTED`**（挂载区之间同样禁止嵌套成环）；③ 同一目录重复挂载（大小写变体视为同目录）→ **409 `CONFLICT`**；④ 目录不存在 → 404；⑤ 参考区无观澜索引库 → 404（提示先用观澜索引）。

**`GET /api/v1/search/cross?q=&format=&dir=&limit=`**（缺 `q` → 400）：主区 + 全部在线挂载区的联合检索，预算 **< 80ms**（主区走有界执行器混合倒排管线，挂载区在阻塞线程串行执行同一管线；任一挂载区检索失败原位降级离线，不拖垮整体）。响应：`{ ok, index_generation（主区）, query, mode（主区模式）, total_matched（各来源命中文件数之和，跨库不去重计数）, items, truncated（任一来源截断即为 true）, search_state（主区状态）, mounts: MountedWorkspaceInfo[] }`。合并口径：score 降序、file_id 全局去重（同 id 主区优先）、`limit`（默认 30，clamp 1..100）收口；**挂载区命中逐条携带 `source_workspace: { workspace_id, root_key, name }` 来源标注（工作区名 + 身份哈希），主区命中不带该字段**（逐字节兼容 `/api/v1/search` wire 形状）。

**版本级只读路由**：`/api/v1/revisions/{revision_id}/content|preview|thumbnail|office|pdf` 先按 `revision_id` 点查在线挂载区 `revisions` 主键溯源，命中即在对应挂载区只读连接上执行（快照走该区自己的 `blobs/`）；未命中回落主区——引用的外部工作区资料经既有 QuickLook / 正文管线可读，天然只读。挂载区离线 → 404（指向 `/api/v1/mounts` 的最后已知摘要）。

**跨挂载边界写拦截（确定性拒绝）**：`POST /api/v1/files/{file_id}/rename|move|trash` 受理前按 `file_id` 点查在线挂载区溯源，命中 → **403 `CROSS_WORKSPACE_FORBIDDEN`**（参考工作区只读，主/挂载区之间硬性禁止改名、移动与删除；仅允许只读引用）。

**测试锁定**：core `domain::mounts::tests` 6 例（plain() 长路径/混合斜杠哈希稳定 / 相对路径 resolve / 展示名 / 组件级互斥判定 / 设备路径不剥 / cwd fail-fast）+ `query::cross_search::tests` 3 例（来源标注 / 去重与 total 联合 / limit 收口）+ service `mounts::tests` 3 例（互斥与重复挂载矩阵 / 侧车 roundtrip 与溯源 / 离线最后已知摘要）+ `c05_mounts_cross_search_and_guardrails_end_to_end`（HTTP 全链路：挂载 → 规范化收敛 CONFLICT → 四类互斥 MOUNT_REJECTED → 联合检索来源标注与 <80ms → rename/move/trash 403 → 版本级读路由 → 卸载 404 → 离线降级摘要保留）。

---

## 3. 前端取数路径与游标纪律

1. **初始化与分页**：前端通过 `GET /api/v1/bootstrap` 一次取得首屏所需的 `event_days / events / time_range / counts / baseline / files 首批摘要 / decisions`，文件摘要按 `file_id` 建缓存 Map 并按需后台续页；侧栏筛选计数来自 `/api/v1/files` 的 `total_matched / facets`；日历近期文件使用摘要字段 `first_source_time`。
2. **正文与版本按需加载**：阅读器先展示版本元数据，再按 `revision_id` 经 `GET /api/v1/revisions/{revision_id}/content`（或 `/preview`、`/office`、`/pdf`）拉取正文；`fetchRevisionContentsBatch` 仅限当前文件版本链范围，不再全库批量下载正文。
3. **SSE 增量同步**：`subscribeWorkspaceStream` 收到 `workspace-change` 后仅按当前窗口重取 `events / event_days` 或按 `file_id` 合并摘要，不整工作区替换状态。
4. **游标纪律**：续页必须携带完整筛选指纹；`order / undated` 切换即放弃旧游标重取首页；筛选竞态丢弃过期响应；收到 `CURSOR_STALE` 时保留已显示数据并回首页重取。
5. **开发代理与数据目录**：`vite.config.ts` 将 `/api/v1` 代理到本地 `guanlan serve` 端点（SSE 代理关闭缓冲）；数据目录为 `%LOCALAPPDATA%/Guanlan/workspaces/<rootKey>/index.db` + `blobs`（受 `GUANLAN_DATA_DIR` 覆盖），`rootKey` 为 `sha256(path.resolve(rootPath))` 前 16 位十六进制字符。

---

## 6. Office（`.docx`/`.xlsx`）L2 结构化提取与证据锚定扩展

- **新增只读端点**：`GET /api/v1/revisions/{revision_id}/office`（支持 `ETag` + `If-None-Match` 304）。
  - 仅对受支持的 OOXML 文档/表格格式（`docx / docm / dotx / xlsx / xlsm / xltx`）开放，非 Office 格式返回 `400 BAD_REQUEST`。
  - 优先复用 `office_extracts` 缓存；若遇到历史库未写缓存且 `snapshot_available != 0`，只在 32 MiB 上限内按需只读解析。
  - 返回 `OfficeContentResponse`：`status` 为 `indexed | encrypted | corrupted | metadata_only`，携带 `docx`（`headings` / `paragraphs` / `comments` / `tracked_changes`）或 `xlsx`（`sheets`：表头、数值列统计 `min/max/sum/cell_range`、行列网格与公式）。加密/损坏文件绝不抛错崩溃，降级返回对应状态与 `error_reason`。
- **`GET /api/v1/revisions/{revision_id}/preview` 扩展**：对结构化 Office 文件返回 `preview_kind = "office"`（已加密/损坏/元数据档回退 `"binary"`）并附带紧凑 `office_summary` 供 QuickLook 原位摘要展示。
- **`GET /api/v1/files` `coverage` 口径扩展**：结构化 `.docx`/`.xlsx` 若已完成 L2 索引（`status = "indexed"`），返回 `coverage = "office_structured"`；原有 `md` (`full_text`) / `svg` (`svg_text`) / `pdf` (`filename_only`) 判定保持不变。
- **`DecisionSourceEvidence` 扩展**：可选 `officeAnchor` 字段（`{ kind: "xlsx_range" | "docx_paragraph", sheet?, cellRange?, paragraph?, heading? }`），支持从 Office 内嵌 `[P0/P1/P2 - 待确认]` 标记或 Markdown 显式链接（`path.xlsx#Sheet!A1:C3`、`path.docx#para=3`）直接跳转到阅读器高亮锚点。


---

## 7. PDF 页级正文抽取与页码证据直达扩展

- **新增只读端点**：`GET /api/v1/revisions/{revision_id}/pdf`（支持 `ETag`（形如 `"pdf-<content_hash>-<index_generation>"`）+ `If-None-Match` 304）。
  - 仅对 `format = "pdf"` 开放，其他格式返回 `400 BAD_REQUEST`；版本不存在返回 `404 NOT_FOUND`。
  - 优先复用 `pdf_extracts` 缓存；历史库未写缓存且 `snapshot_available != 0` 时，只在 32 MiB 上限内按需只读解析，绝不写库。
  - 返回 `PdfContentResponse`：`status` 为 `page_indexed | image_only | ocr_pending | extract_failed | encrypted | corrupted | metadata_only`，`pages` 为 1-based 精确页码数组（每页含 `page_number / heading / extracted_text / page_kind / image_count / char_count / visual_summary`）。
  - **零假阳性口径**：扫描页（`image_only`）的 `visual_summary` 明确标注「纯图像页，未做文本抽取（待 OCR）」；字体缺 ToUnicode 映射的中文本页标 `extract_failed`（**不**判为扫描件）；空白页标 `empty`；页码绝不为空页/失败页发生偏移。
- **`GET /api/v1/revisions/{revision_id}/preview` 扩展**：PDF 文件附带紧凑 `pdf_summary`（`page_count / text_page_count / image_only_page_count / extract_failed_page_count / headings_preview / text_preview`）；`preview_kind` 保持 `"pdf"`（预览主体仍走原版 PDF 流式端点）。
- **`GET /api/v1/files` 口径扩展**：
  - `coverage`：文本型 PDF 若已完成页级索引（`pdf_extracts.status = "page_indexed"`）返回 `coverage = "pdf_page_text"`（沿用 `project.ts` 既定码表），否则仍 `filename_only`；`md`/`svg`/Office 判定不受影响。
  - `pdf_status`：由恒定 `"unindexed"` 升级为真实缓存状态（`page_indexed | image_only | ocr_pending | extract_failed | encrypted | corrupted | metadata_only`；未入库时仍 `"unindexed"`）。
- **`DecisionSourceEvidence` 扩展**：可选 `pdfAnchor` 字段（`{ kind: "pdf_page", page: number, heading?, excerpt? }`）。来源两种：① Markdown 显式链接 `path.pdf#page=14`（兼容 `#p=14`、`#14` 与 RFC 3778 `#page=14&view=FitH` 形式，`page` 恒为 1-based）；② PDF 内嵌 `[P0/P1/P2 - 待确认]` 决定标记的页级陈述。关联证据卡 `source_id` 后缀 `_pdf`，点击直达对应历史版本第 N 页。

---

## 8. 候选事项（多信号编织；采纳前绝不写正式归属）

- **新增只读端点**：`GET /api/v1/initiative-candidates`。返回 `InitiativeCandidatesResponse`：`items[]` 每项含 `candidate_id / title / reason_summary / signal_mask / score / state / member_count / members[]`；`members[]` 每项含 `file_id / relative_path / title / signals[]`（理由胶囊：`{signal, detail}`，signal ∈ `dir_prefix | link | same_stem | session | agent_batch`，detail 为人话证据）。`signal_mask` 位定义：`0x01 目录前缀 | 0x02 显式链接 | 0x04 同名主干 | 0x08 会话共现 | 0x10 Agent 批次`。
- **新增写端点（均 202 + JobAccepted，写线程串行）**：
  - `POST /api/v1/initiative-candidates/{candidate_id}/adopt`：建/并入正式 initiative（同名 root_dir 已存在则并入且不篡改既有状态）→ 候选置 `adopted` → 事件 `initiative_candidate_adopted` → 收尾状态机重算。**归属固化语义**：`collect_file_signals` 的 `adopted_candidate_map` 优先于 `recognize_initiative` 路径规则——用户显式确认的映射每轮重算保持，未覆盖文件仍走路径规则。
  - `POST /api/v1/initiative-candidates/{candidate_id}/dismiss`：整簇否决 → 置 `dismissed` + 簇内成员两两信号对排除（≤276 对）→ 事件 `initiative_candidate_dismissed`。
  - `POST /api/v1/initiative-candidates/{candidate_id}/members/{file_id}/exclude`：单成员剔除 → 与簇内其余成员两两排除 + 成员收缩；剩余 <2 则簇失效（`dismissed` + 全员互斥）→ 事件 `initiative_candidate_member_excluded`。
  - 候选不存在返回 `404 NOT_FOUND`；非 `candidate` 态采纳返回 `400 BAD_REQUEST`。
- **编织信号（`domain/candidate_weaver.rs` 纯函数）**：S1 同目录编号/语义前缀（`0x01`）、S2 Markdown 显式链接边（`0x02`）、S3 跨目录同名主干（主干 = 去扩展名/两位编号前缀/变体段，`0x04`）、S4 文件 mtime 相差 ≤45 分钟（会话窗口，`0x08`）、S5 同 `batch_id`（预留，`0x10`）。并查集连通分量 ≥2 且 ≤24 成员才成候选；簇键 = 排序成员 file_id 的 sha 前 16（重扫幂等）。
- **排除语义（"误聚项剔除后重扫不反弹"）**：`initiative_candidate_exclusions` 表持久化**规范化信号对** `(file_a ≤ file_b)`；`weave_candidates` 的所有 union 前剪除命中对——被剔文件天然从簇解连，若仍有其他信号则如实流入其他候选。
- **对账挂钩**：`verify_all` / `changed_paths` 对账完成后自动重扫编织（`reweave_candidate_clusters`）；`candidate` 态且本轮未再生成的旧簇清理，`adopted/dismissed` 保留。SSE `kinds` 增加 `candidates`。
- **存储（contract-storage.md §11）**：`initiative_candidates` / `initiative_candidate_members` / `initiative_candidate_exclusions` 三表（幂等 DDL 追加）。
- **红线**：采纳/否决/剔除全部经 HTTP 显式触发；绝不移动磁盘文件；绝不擅自改动既有正式事项归属（adopted 映射只作用于成员归属的固化）。
