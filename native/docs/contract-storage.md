# 观澜存储层契约

- 参照基线：
  - `server/WorkspaceStore.ts`（持久层参照实现）
  - `server/reconcile.ts`（身份与候选判定及历史写入）
  - `server/watcher.ts`（文件监听信号语义）
  - `server/derive.ts`（纯日期抽取，服务于 §5 时间语义）
- 用途：`guanlan-core` 的 `storage` / `domain` / `index` 模块存储契约。凡标 **[逐字兼容]** 的规则，Rust 实现必须与旧 Node 管线保持字节级一致，不得用等价近似替代。

---

## 0. 总体写入顺序（写入侧不变量，读取侧依赖其成立）

稳定读取 → 事务外保存并校验内容快照 → 事务内提交版本、事件、证据 → 发出更新通知。
读取侧依赖该不变量：**读取请求永远不会见到「已有版本但对应快照尚未写好」的半成品**：

1. 第一遍（纯内存）：识别文件身份、规划候选新版本 —— `reconcile.ts:211-336`。
2. 第二遍（事务外 IO）：逐个读文件内容、写快照到磁盘并校验 —— `reconcile.ts:338-365`。
3. 大事务：文件行、别名、blob 登记、版本行、touch、事件、缺失判定一起提交 —— `reconcile.ts:377-498`。
4. 若干小事务：基线卡（`reconcile.ts:500-532`）、读取错误（`534-554`）、派生陈述/关系/不稳定读取/决策事件（`563-627`）。
5. 派生索引按需重建（`reconcile.ts:630-635`）、旧资料回填（`637-643`）、generation 推进（`645-654`）。

事务包装为 `BEGIN IMMEDIATE ... COMMIT / ROLLBACK`，回滚失败不得掩盖原始错误：`WorkspaceStore.ts:310-324`。

---

## 1. SQLite：表结构、索引、schema 版本与迁移

### 1.1 DDL 原文 [逐字兼容]

以下 SQL 是 `server/WorkspaceStore.ts:133-267` 中 `SCHEMA` 模板字符串的**逐字摘录**（含字符串内部的 SQL 块注释，`db.exec(SCHEMA)` 时原样交给 SQLite；Rust 侧如需重建同名索引/表，不得改写列名、类型、约束与默认值）：

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id       TEXT PRIMARY KEY,
  root_path          TEXT NOT NULL UNIQUE,
  root_key           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  last_scan_at       TEXT,
  index_generation   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  file_id            TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  current_path       TEXT NOT NULL,
  format             TEXT NOT NULL,
  title              TEXT NOT NULL,
  role               TEXT NOT NULL,
  first_observed_at  TEXT NOT NULL,
  last_observed_at   TEXT NOT NULL,
  last_mtime_ms      INTEGER NOT NULL DEFAULT 0,
  last_revision_id   TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_files_ws ON files(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_files_ws_status_normpath
  ON files(workspace_id, status, REPLACE(current_path, '', '/'), file_id);

CREATE TABLE IF NOT EXISTS path_aliases (
  workspace_id       TEXT NOT NULL,
  path               TEXT NOT NULL,
  file_id            TEXT NOT NULL,
  first_observed_at  TEXT NOT NULL,
  last_observed_at   TEXT NOT NULL,
  evidence           TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
CREATE INDEX IF NOT EXISTS idx_alias_file ON path_aliases(file_id);

CREATE TABLE IF NOT EXISTS revisions (
  revision_id         TEXT PRIMARY KEY,
  file_id             TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  prev_revision_id    TEXT,
  content_hash        TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  observed_at         TEXT NOT NULL,
  occurred_at         TEXT,
  occurred_precision  TEXT NOT NULL DEFAULT 'unknown',
  occurred_source     TEXT,
  snapshot_hash       TEXT NOT NULL,
  snapshot_available  INTEGER NOT NULL DEFAULT 1,
  extract_rule_version TEXT NOT NULL,
  UNIQUE (file_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_rev_hash ON revisions(content_hash);
-- `revisions` 的 UNIQUE (file_id, seq) 已自带同序 B-tree，
-- 历史上另建的 idx_rev_file 与其完全重复（同列同序），只增加存储与写入维护成本。
-- 已从新库 schema 与测试夹具移除；旧库由写入侧幂等迁移 DROP INDEX IF EXISTS 清理
-- （只读服务启动不执行结构变更，契约 §4.1 边界不变）。版本分页仍走该唯一索引。

CREATE TABLE IF NOT EXISTS blobs (
  content_hash   TEXT PRIMARY KEY,
  size_bytes     INTEGER NOT NULL,
  rel_path       TEXT NOT NULL,
  ref_count      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  verified_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL,
  kind                TEXT NOT NULL,
  subject_kind        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  revision_id         TEXT,
  occurred_at         TEXT,
  occurred_precision  TEXT NOT NULL DEFAULT 'unknown',
  occurred_source     TEXT,
  observed_at         TEXT NOT NULL,
  headline            TEXT NOT NULL,
  detail              TEXT NOT NULL,
  payload_json        TEXT NOT NULL DEFAULT '{}',
  batch_id            TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ws_seq ON events(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(workspace_id, kind);
CREATE INDEX IF NOT EXISTS idx_events_ws_occurred_sort
  ON events(workspace_id, COALESCE(occurred_at, ''), seq);
CREATE INDEX IF NOT EXISTS idx_events_ws_observed_sort ON events(workspace_id, observed_at, seq);
-- 文件事件关联四路各自的匹配访问结构（UNION 各分支可走索引，
-- 不再对整个工作区逐条求值四路 OR）
CREATE INDEX IF NOT EXISTS idx_events_ws_subject_seq
  ON events(workspace_id, subject_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ws_revision_seq
  ON events(workspace_id, revision_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ws_payload_file
  ON events(workspace_id, json_extract(payload_json, '$.file_id'), seq);
/** 同一来源的同一事实只记一次：重扫与重试沿用同一记录标识 */
CREATE UNIQUE INDEX IF NOT EXISTS uniq_event_identity
  ON events(workspace_id, kind, subject_id, COALESCE(revision_id, ''), COALESCE(occurred_at, ''));

CREATE TABLE IF NOT EXISTS statements (
  statement_id         TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  file_id              TEXT NOT NULL,
  revision_id          TEXT NOT NULL,
  code                 TEXT NOT NULL,
  namespace            TEXT NOT NULL,
  question             TEXT NOT NULL,
  status               TEXT NOT NULL,
  quote                TEXT NOT NULL,
  line_start           INTEGER NOT NULL,
  line_end             INTEGER NOT NULL,
  decision_id          TEXT,
  detail_json          TEXT NOT NULL DEFAULT '{}',
  extract_rule_version TEXT NOT NULL,
  observed_at          TEXT NOT NULL,
  UNIQUE (revision_id, code, line_start)
);
CREATE INDEX IF NOT EXISTS idx_stmt_ws ON statements(workspace_id, code);
CREATE INDEX IF NOT EXISTS idx_stmt_decision ON statements(decision_id);
/** events/days 样本查询按 file_id 关联计数走索引（此前为逐行全表扫） */
CREATE INDEX IF NOT EXISTS idx_stmt_file ON statements(file_id);

CREATE TABLE IF NOT EXISTS edges (
  edge_id             TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  source_file_id      TEXT NOT NULL,
  source_revision_id  TEXT NOT NULL,
  target_file_id      TEXT NOT NULL,
  target_revision_id  TEXT,
  kind                TEXT NOT NULL,
  resolution          TEXT NOT NULL,
  locator_start       INTEGER,
  locator_end         INTEGER,
  reason              TEXT NOT NULL,
  UNIQUE (source_revision_id, target_file_id, locator_start)
);
CREATE INDEX IF NOT EXISTS idx_edges_ws ON edges(workspace_id);
/** events/days 样本查询按 source_file_id 关联计数走索引（此前为逐行全表扫） */
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(source_file_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

表职责速览（来源 `WorkspaceStore.ts:7-13` 头注释）：
`revisions` 记录「版本出现」（A→B→A 是三次出现、两份内容）；`blobs` 按完整哈希去重存快照；`events` 用单调 `seq` 支持日历排序、断线恢复、分页游标与去重；`statements` 给每条来源陈述独立身份（`decision_id` 可空，避免同编号不同问题被合并）；`edges` 把引用绑定到来源版本并记录目标版本是否已知（`resolution` 枚举见 `WorkspaceStore.ts:124`：`pinned_version | collected_version | current_path_only | unresolved`）。

事件种类枚举（`WorkspaceStore.ts:21-29`）：`workspace_baseline | appeared | modified | missing | read_error | read_recovered | decision_raised | decision_changed`。事件主体枚举（`WorkspaceStore.ts:84`）：`workspace | file | revision | decision`。文件格式枚举（`WorkspaceStore.ts:53`）：`md | svg | pdf`。

### 1.2 连接 PRAGMA [逐字兼容]

打开 `index.db` 后依次执行（`WorkspaceStore.ts:290-292`）：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### 1.3 schema 版本与迁移

- 幂等建表：写入侧打开连接时按 `CREATE ... IF NOT EXISTS` 确保表与索引存在，并检查列级增量迁移（如 `statements.detail_json`）。
  写入侧同时维护以下幂等索引迁移（只读连接绝不执行任何结构变更）：
  - `idx_files_ws_status_normpath`：规范化路径表达式索引（默认文件分页的排序/游标访问路径）；
  - `idx_events_ws_occurred_sort` / `idx_events_ws_observed_sort`：两种事件排序各一条；
  - `idx_events_ws_subject_seq` / `idx_events_ws_revision_seq` / `idx_events_ws_payload_file`：
    文件事件关联四路 UNION 各自的可检索路径；
  - `DROP INDEX IF EXISTS idx_rev_file`：删除与 `UNIQUE (file_id, seq)` 完全重复的冗余索引。
- `meta` 键值表存储 `extract_rule_version` 等运行元数据。抽取规则版本常量 `EXTRACT_RULE_VERSION = 'v0.4.3'`；规则升级时按版本号差异删除旧派生数据并全量重建。
- **`PRAGMA user_version` 由写入侧条件登记**（0/1 → 2，只升不降），读侧白名单为 `[0, 1, 2]`（见 §4.3.1；旧 Node 管线不读写该值）。
- **只读连接禁止执行任何写路径**：不执行 `SCHEMA`、不 `ALTER TABLE`、不写 `meta`。详见 §4。

### 1.4 统计口径的既有怪癖（读取侧照抄行为即可）

`counts()`（`WorkspaceStore.ts:766-779`）：`files / events / statements / edges` 按 `workspace_id` 过滤计数，但 **`revisions` 与 `blobs` 是全表计数（无 WHERE）**（`WorkspaceStore.ts:771-773, 775`）。Rust 提供统计接口时保持同一口径。

### 1.5 upsert 冲突行为 [逐字兼容]

- `path_aliases`：`ON CONFLICT (workspace_id, path) DO UPDATE SET file_id, last_observed_at`（**不更新** `first_observed_at` 与 `evidence`）—— `WorkspaceStore.ts:494-504`。
- `statements`：`ON CONFLICT (revision_id, code, line_start) DO UPDATE SET status, quote, line_end, decision_id, detail_json`（**不更新** `namespace/question/observed_at` 等）—— `WorkspaceStore.ts:666-696`。
- `edges`：`ON CONFLICT (source_revision_id, target_file_id, locator_start) DO UPDATE SET target_revision_id, resolution, reason` —— `WorkspaceStore.ts:714-738`。
- 事件插入没有 upsert：撞 `event_id` 唯一或 `uniq_event_identity` 一律按「已存在、跳过」处理，绝不把冲突抛回中断整轮事务 —— `WorkspaceStore.ts:615-655`（`errcode === 2067 /* SQLITE_CONSTRAINT_UNIQUE */` 或消息正则匹配，`645-653`）。

---

## 2. 身份规则 [全部逐字兼容]

### 2.1 rootKey

算法（`WorkspaceStore.ts:276-278`）：

```ts
rootKeyOf(rootPath) = createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 16)
```

精确语义，逐项写死：
1. **输入**是 `path.resolve(rootPath)` 的返回字符串，不是原始参数、不是 canonicalize 结果。Rust **禁止**用 `std::fs::canonicalize` 或 `dunce::canonicalize` 替代（Windows 会引入 `\\?\` 前缀导致哈希不同）。
2. `path.resolve` 语义（Node 在 win32 上的规则）：
   - 正斜杠输入规范化为反斜杠：`resolve('d:/notebooks/demo')` → `d:\notebooks\demo`；
   - **盘符大小写原样保留**：`d:\...` 与 `D:\...` 是两个不同字符串 → 两个不同 rootKey（实测）；
   - 去掉结尾分隔符：`D:\notebooks\demo\` → `D:\notebooks\demo`；
   - 相对路径按进程 CWD 解析：`resolve('notebooks\demo')` → `<CWD>\notebooks\demo`；
   - 纯盘符 `D:` → 该盘当前目录，实测返回 `D:\`。Rust 必须复刻 Node `path.win32.resolve` 的全部这些行为。
3. **哈希输入编码**：`update(string)` 无显式 encoding，Node 默认 **UTF-8** 字节。
4. **输出**：`digest('hex')` 为**小写**十六进制（64 字符）；`slice(0, 16)` 取**前 16 个十六进制字符**（即前 8 字节），保持小写。
5. 示例（本次会话用与源码相同的算法实际计算）：

```
rootPath 输入      : D:\notebooks\demo
path.resolve 结果  : D:\notebooks\demo
SHA-256 全量 hex   : 6d74a29df40616ec896ca7b6d6ec83bed4f11411bc5a0fa5b2a2dd284a9debb7
rootKey（16 位）   : 6d74a29df40616ec
```

### 2.2 workspace_id 与工作区行 [逐字兼容]

- `workspace_id = 'ws_' + rootKeyOf(resolved)`（`WorkspaceStore.ts:336`）。上例 → `ws_6d74a29df40616ec`。
- `ensureWorkspace` 按 **`root_path` 精确字符串匹配**查重（`WHERE root_path = ?`，`WorkspaceStore.ts:329-333`），**不是**按 `root_key`；未命中才插入新行，`created_at = new Date().toISOString()`、`last_scan_at = NULL`、`index_generation = 0`（`335-348`）。注意：同目录用不同盘符大小写打开会生成第二个工作区行（`root_path` UNIQUE 挡不住大小写差异）；Rust 读取侧只按库内已有行认领，不新建。

### 2.3 file_id [逐字兼容]

算法（`reconcile.ts:76-78` 与 `84-90`）：

```ts
normalizeRelPath(p) = p.replace(/\\/g, '/')            // 反斜杠 → 正斜杠
stableFileId(rootKey, relativePath) =
  'f_' + createHash('sha256')
          .update(`${rootKey}|${normalizeRelPath(relativePath).toLowerCase()}`)
          .digest('hex')
          .slice(0, 24)
```

精确语义：
1. 拼接串为 `rootKey + '|' + 斜杠规范化后的小写相对路径`，分隔符是**竖线 `|`**（`reconcile.ts:86`）。
2. 大小写：`toLowerCase()` 是 JS 默认 Unicode 小写化（非 locale 感知；ASCII 即简单小写）。目的：适配 Windows 大小写不敏感匹配（`reconcile.ts:81-83` 注释）。
3. 编码 UTF-8；hex 小写；取**前 24 个十六进制字符**（12 字节），前缀 `f_`。总长 26 字符。
4. 相对路径来自扫描器的 `relativePath`。
5. 示例：

```
rootKey          : 6d74a29df40616ec
relativePath 原始: Notes\ReadMe.MD
规范化+小写后    : notes/readme.md
SHA-256 输入串   : 6d74a29df40616ec|notes/readme.md
file_id          : f_b967338b81904b60abf8374e
```

### 2.4 revision_id 与 per-file seq [逐字兼容]

- `revisionIdOf(fileId, seq) = fileId + '_r' + seq`（`reconcile.ts:92-94`）。示例：`f_b967338b81904b60abf8374e_r1`、`..._r2`。
- per-file 版本序号从 1 开始：`seq = (latest?.seq ?? 0) + 1`（`reconcile.ts:311`）；`revisions` 表 `UNIQUE (file_id, seq)`（§1.1）。
- `prev_revision_id` 取上一版的 `revision_id`，无上版为 `NULL`（`reconcile.ts:323`）。文件从 missing 恢复且内容已变时，链直接接在消失前最后版本之后（missing 只产生事件，不在版本链上占位）。
- 内容哈希与快照哈希当前**恒等**：`content_hash` 与 `snapshot_hash` 都写入同一个 SHA-256（`reconcile.ts:324` 与 `330`）；`snapshot_available` 初始 1（`reconcile.ts:331`）。

### 2.5 event_id 生成规则 [逐字兼容]

| 事件 | event_id 模板 | 来源 |
|---|---|---|
| appeared / modified（每新版本一条） | `evt_${kind}_${revision_id}`，如 `evt_modified_f_xxx_r2` | `reconcile.ts:406`（kind 取值）+ `431` |
| workspace_baseline（每工作区至多一条） | `evt_baseline_${workspace_id}` | `reconcile.ts:506` |
| missing（按天命名） | `evt_missing_${file_id}_${observedAt.slice(0,10)}` | `reconcile.ts:481` |
| read_recovered | `evt_recovered_${file_id}` | `reconcile.ts:289` |
| read_error（读取失败） | `evt_read_error_${stableShort(relPath)}_${observedAt.slice(0,13).replace(/[:T]/g,'')}` | `reconcile.ts:538` |
| read_error（不稳定读取） | `evt_unstable_${stableShort(normRelPath)}_${同上小时戳}` | `reconcile.ts:603` |
| appeared（旧资料文档自述回填） | `evt_appeared_${revision_id}` | `reconcile.ts:696` |
| decision_raised / decision_changed | `evt_${kind}_${decision_id}_${stableShort(status)}` | `reconcile.ts:877` |

其中：
- `stableShort(input) = sha256(input) 的 hex 前 12 位`（`reconcile.ts:913-915`），小写。
- 时间戳后缀 `observedAt.slice(0,13).replace(/[:T]/g,'')`：ISO 串 `YYYY-MM-DDTHH:mm` 的前 13 字符（`YYYY-MM-DDTHH`）去掉 `:` 和 `T` → `YYYYMMDDHH`（UTC 小时）。
- **关键**：event_id 中的日期/小时后缀只是命名习惯；真正的幂等由 `uniq_event_identity` 决定（§2.6）。例如同一文件多天 missing 会生成不同 event_id，但 identity（kind=missing, subject=file_id, revision_id=最后版本, occurred_at=NULL）相同而被跳过（`WorkspaceStore.ts:219-220` + `reconcile.ts:640-654`）。

### 2.6 events.seq 与事件去重身份 [逐字兼容]

- `events.seq` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`（§1.1，`WorkspaceStore.ts:199`）：SQLite 行号自增，全表**全局**单调（不按 workspace 分段），删除后不复用。插入成功后取 `lastInsertRowid` 作为 seq 返回（`WorkspaceStore.ts:639`）。历史 `events.seq` 必须原样保留。
- 每工作区当前最大 seq：`SELECT COALESCE(MAX(seq),0) ... WHERE workspace_id = ?`（`WorkspaceStore.ts:657-662`）。
- 去重身份唯一索引（`WorkspaceStore.ts:218-220`）：

```sql
CREATE UNIQUE INDEX uniq_event_identity
  ON events(workspace_id, kind, subject_id, COALESCE(revision_id, ''), COALESCE(occurred_at, ''));
```

  即「同一工作区、同一类事实、同一主体、同一版本、同一发生时间」只记一次；重扫与任务重试沿用同一记录标识，不得再次新增。Rust 写入侧对冲突的处理：跳过并计数，见 §1.5。

### 2.7 generation（index_generation）演进 [逐字兼容]

- 初始 0（DDL DEFAULT，§1.1；`ensureWorkspace` 插入 0：`WorkspaceStore.ts:346`）。
- `bumpGeneration`：`index_generation = index_generation + 1` 且同时写 `last_scan_at = now`（`WorkspaceStore.ts:358-366`）。
- 对账结尾的条件推进：仅当 `newRevisions > 0 || eventsInserted > 0 || derivedRebuilt || initialBaseline` 才 bump，否则保持原值；随后无条件 `markScan`（只更新 `last_scan_at`，不 bump）：`reconcile.ts:645-654`、`WorkspaceStore.ts:368-372`。理由：「索引代只在校验到变化时推进：重复扫描不应让『代』无意义地增长」（`reconcile.ts:645` 注释）。
- 读取侧语义：generation 是「已提交内容代」通知载体，不是历史数据库快照。

### 2.8 候选判定（文件认领顺序）[逐字兼容]

对每个采集到的文件按序判定（`reconcile.ts:218-268`）：
1. `findFileByPath`：`files` 表 `workspace_id + current_path` 精确匹配（`WorkspaceStore.ts:478-482`；调用 `reconcile.ts:221-222`）。
2. `resolveFileByAlias`：`path_aliases` 查表回溯 `files`（`WorkspaceStore.ts:484-492`；调用 `reconcile.ts:223`）。
3. 预测 ID 认领：`stableFileId(root_key, relPath)` 命中已有 `files` 行 → 认领，`evidence = 'same_hash_candidate'`（处理「同 ID 缺失后重现 / 仅大小写差异路径」，`reconcile.ts:229-237`）。
4. 同哈希缺失认领：仅当文件稳定读取（`file.stable`）且**工作区里恰好只有一个** missing 文件的最新版本内容哈希与本文件相同，才关联认领（`recoveredMissing = true`）；命中后立刻把该 file_id 从候选池移除，同轮第二个同哈希新文件按「新增」处理，否则两份计划会算出相同 `(file_id, seq)` 撞 `UNIQUE` 回滚整轮（`reconcile.ts:239-256`，池移除见 `251`，风险注释见 `248-250`）。
5. 以上皆未命中 → 新文件（`reconcile.ts:258-260`）。
6. 不稳定读取（`!file.stable`）：不落版本、不认领，只记 `read_error` 事件并继续（`reconcile.ts:262-266` 与 `599-618`）。
7. 认领/新建后：`upsertAlias(workspace_id, relPath, fileId, now, evidence)`（内容未变且此前 missing 的恢复路径用判定 evidence；新版本统一 `'exact_path'`，`reconcile.ts:280` 与 `398`；SQL 见 §1.5）。

---

## 3. 数据目录布局与快照落盘 [逐字兼容]

### 3.1 目录解析顺序

```
effectiveDataDir = 显式 dataDir 参数 优先；否则 defaultDataDir(rootPath)
defaultDataDir(rootPath)（WorkspaceStore.ts:269-274）:
  localAppData = $LOCALAPPDATA 若非空，否则 join(homedir, 'AppData', 'Local')
  base         = $GUANLAN_DATA_DIR 若非空，否则 join(localAppData, 'Guanlan', 'workspaces')
  return       = join(base, rootKeyOf(rootPath))
```

- **顺序**：显式参数（服务装配层 `workspace-plugin.ts:59`）→ `GUANLAN_DATA_DIR` → `%LOCALAPPDATA%` → `homedir\AppData\Local` 兜底。`GUANLAN_DATA_DIR` **整体替换** base（含 `Guanlan/workspaces` 段），不是在其后追加。
- 沿用 `%LOCALAPPDATA%/Guanlan/workspaces/<rootKey>/index.db` 和 `blobs`，兼容 `GUANLAN_DATA_DIR`。

### 3.2 布局

- `<dataDir>/index.db`（`WorkspaceStore.ts:289`），WAL 模式（含 `index.db-wal`、`index.db-shm`）。
- `<dataDir>/blobs/<hash 前 2 位>/<完整 hash>`：`blobPathFor = join(blobsDir, hash.slice(0,2), hash)`（`WorkspaceStore.ts:287-288`（blobsDir）、`383-385`（两级路径））。
- `blobs.rel_path` 存相对 dataDir 的**正斜杠**路径：`path.relative(dataDir, blobPath).replace(/\\/g,'/')`，如 `blobs/6d/6d74a29d...`（`WorkspaceStore.ts:423`）。
- 目录在写入侧打开时确保存在：`mkdirSync(blobsDir, { recursive: true })`（只读打开时**不得**创建目录，见 §4.1）。

### 3.3 快照落盘规则：「临时写入 → 校验 → 同卷原子改名 → 事务内登记」

`writeSnapshotToDisk(content, hash)`（`WorkspaceStore.ts:397-418`），事务外执行（`reconcile.ts:338-341`）：
1. 目标 `blobs/<h2>/<hash>` 已存在时：**重读磁盘文件重算 SHA-256**，等于 hash 则直接跳过（返回 false，不重复写）——A→B→A 的两份相同内容共享同一快照文件（`WorkspaceStore.ts:402-407` + 注释 `397-399`）。
2. 否则 `mkdir -p` 父目录（`408`）。
3. 临时文件名：`${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2,8)}`，与目标**同目录**（保证同卷，改名才是原子的）（`409`）。
4. `writeFileSync(tmp, content)` 后**重读 tmp 再算 SHA-256**；不等于期望 hash → 删除 tmp 并抛错（错误信息含期望/实得前 16 位 hex），整轮对账中断（`411-415`）。
5. 校验通过 → `renameSync(tmp, target)` 同卷原子改名（`416`）。
6. **事务内登记** `registerBlobRef(hash, size)`（`reconcile.ts:401` 在大事务内调用；SQL 语义 `WorkspaceStore.ts:421-441`）：`blobs` 行存在则 `ref_count = ref_count + 1` 并刷新 `size_bytes/verified_at`，不存在则插入 `ref_count = 1`。
7. 版本插入前的守护：`insertRevision` 检查 `blobs` 表必须已有该 `content_hash` 行，否则抛「版本引用了未保存的快照」（`WorkspaceStore.ts:600-603`）——保证 §0 的不变量「先有快照，后有版本行」。

读取：`readSnapshot(hash)` 直接读 blob 路径，不存在返回 null（`WorkspaceStore.ts:470-474`）；对外路径 `snapshotPath(hash)`（`388-390`），PDF/SVG 按需读取走它（`project.ts:557-568`、`workspace-plugin.ts:350-354`）。

### 3.4 引用计数与回收

- `blobs.ref_count` 只在 `registerBlobRef` 维护（§3.3 第 6 步）；崩溃留下的无引用快照可延后回收，已被 `revisions` 引用的快照绝不能在恢复或回收时误删。

---

## 4. 读写职责边界

### 4.1 读取侧边界

1. **零写 SQL**：只读连接对 `index.db` 不执行任何写 SQL——不 `exec(SCHEMA)`、不 `ALTER`、不写 `meta`、不 bump generation、不 `markScan`。服务层通过工作区排他锁保护同一数据目录。
2. **不生成第二套历史。** 不创建新的 workspaces/files/revisions/events 行，不重算 file_id/revision_id 去认领已有数据；身份读取直接以库内行为准，写入侧沿用 §2 全部身份规则在同一套表上追加。
3. **打开已有数据零扫描。** 启动后立即开放读取，展示最近已保存状态；后台对账不阻塞正文读取与事件查询，不得在 bootstrap 或任何 `/api/v1` 读路径里触发目录枚举或内容哈希。
   - 启动时的整库核验与 File Watcher 由 `ServeConfig::background_index` 显式控制。**CLI `guanlan serve` 默认关闭**（`--watch` 打开），保持「零扫描」语义；桌面壳（`guanlan-desktop`）显式打开，以实现打开即见已存数据并后台并入改动。
   - 与开关无关：Inline 拍板 / MCP 回写等写回端点始终可用（自带写线程队列）。
4. **无引用快照回收**：回收语义以 §3.4 为准（`blobs` 中 `content_hash NOT IN revisions` 者可删），且恢复/回收流程永远不得删除已被 `revisions` 引用的快照；读侧不做任何删除动作。
5. 快照缺失的版本按 `snapshot_available = 0` 呈现（绝不拿当前文件内容冒充旧版本）。
6. 读取完整性依赖 §0 不变量：任何时刻读到「版本行存在」即可断言对应快照已在事务前落盘校验。

### 4.2 写入侧边界（Rust 索引与唯一写入者）

1. **唯一写入线程。** 库内只有一条可写连接，由专用写线程独占（`core::index::writer::Writer` + `service::index_jobs`）；读侧仍是独立的只读连接池，两侧靠 WAL 并行。写事务一律 `BEGIN IMMEDIATE`（§0）。
2. **沿用 §2 全部身份规则，在同一套表上追加。** 不新建表、不新建第二套历史：`file_id` / `revision_id` / `event_id` / `statement_id` / `decision_id` / `edge_id` 的生成公式与旧 Node 管线（`server/reconcile.ts`、`server/derive.ts`）逐字一致。**唯一写入路径的硬保证**是 Node↔Rust 写入对拍脚本（`scripts/parity-reconcile.ts`）：同一工作区两侧各跑一轮，逐表导出比对，任何身份偏差都会让对拍失败。
3. **打开即最新，后台对账不阻塞读取。** 开启后台索引时，服务启动即在写线程上排一轮整库核验（`verify_all`）；读路径立即可用，索引在后台推进。
4. **幂等 DDL 由写入侧拥有。** 写入侧按 §1.1 与 §4.3.2 的 `CREATE … IF NOT EXISTS` 集合确保 schema，做 `statements.detail_json` 增量列迁移，并在末尾条件写入 `PRAGMA user_version = 2`（见 §4.3.1）。
5. **写入顺序不变**：稳定读取 → 保存并校验内容快照 → 事务提交版本与事件及证据（§0）。
6. **采集范围不完整时不判缺失**（§0 末条与 `reconcile.ts:472-497`）：文件数上限（`GUANLAN_MAX_FILES`，默认 200000）或深度上限（`GUANLAN_MAX_DEPTH`，默认 32）触顶时，本轮 `complete=false`，只报告已扫到的范围，**不**把范围外的文件标为缺失。

---

## 4.3 schema v2：长任务引擎与状态机新表

> 实现载体：`guanlan-core/src/index/state_machine.rs`（SSOT 纯函数）、
> `guanlan-core/src/index/state_engine.rs`（落库执行器）、
> `guanlan-core/src/index/writer.rs`（DDL 与全部写语句）。

### 4.3.1 schema 版本门禁：`user_version` 0/1 → 2 [单向条件升级]

- **兼容性**：旧 Node 管线（`server/`）不读写 `user_version`；`scripts/parity-reconcile.ts` 两侧各自写独立临时库逐表 dump 比对，`user_version` 对对拍零影响。
- **写入时机**：`Writer::ensure_schema` 末尾，全部新表幂等建表后**条件写**
  `PRAGMA user_version = 2`——只在当前值 < 2 时写（只升不降，已是 2+ 不回写）。
- **读侧白名单**：`ReadonlyStore::SUPPORTED_SCHEMA_VERSIONS = [0, 1, 2]`（`storage/mod.rs`）。
  未知版本（含 3+）拒绝打开：不迁移、不写入（§4.1 边界不变）。
- **同包发布约束**：写侧升级与读侧必须同包发布；更早版本的读侧遇到更高版本库会以 `SCHEMA_TOO_NEW` 拒绝打开。

### 4.3.2 新表 DDL（7 张，全部幂等 `IF NOT EXISTS`，对既有库空操作）

以下 SQL 与 `guanlan-core/src/index/writer.rs` 的 `SCHEMA` 尾段逐字一致（实现以此为准）：

```sql
-- ① 专项：跨天长任务的一级容器。UNIQUE(workspace_id, root_dir)
--    保证同一工作区同一根目录只有一行。
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
CREATE INDEX IF NOT EXISTS idx_initiatives_ws ON initiatives(workspace_id);

-- ② 文档级状态投影（统一状态机 SSOT 存储层）。file_id 复用 files 主键
--    ——禁止第二套文件身份。
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
CREATE INDEX IF NOT EXISTS idx_astates_ws_state ON artifact_states(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_astates_initiative ON artifact_states(initiative_id);

-- ③ 子任务节点（五槽位 DAG）。state 是声明式跨轮持久态，每轮
--    reconcile 由 state_engine::recompute 幂等重算维持。
CREATE TABLE IF NOT EXISTS task_nodes (
  node_id               TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  initiative_id         TEXT NOT NULL,
  stage                 TEXT NOT NULL,
  title                 TEXT NOT NULL,
  node_kind             TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'queued',
  depends_json          TEXT NOT NULL DEFAULT '[]',
  payload_json          TEXT NOT NULL DEFAULT '{}',
  latest_checkpoint_id  TEXT,
  error                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_init ON task_nodes(initiative_id, stage, state);

-- ④ 执行快照（断点续跑）。checkpoint_id 主键的 seq 由库内既有行数派生
--    （重启安全）；恢复 = 取节点/initiative+stage 最近一次 SUCCESS。
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
CREATE INDEX IF NOT EXISTS idx_ckpt_init ON checkpoints(initiative_id, stage, created_at);
CREATE INDEX IF NOT EXISTS idx_ckpt_node ON checkpoints(node_id);

-- ⑤ 修订草案（人机并发冲突：Agent 写入存为草案分支，绝不静默覆盖）
CREATE TABLE IF NOT EXISTS revision_drafts (
  draft_id               TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL,
  file_id                TEXT NOT NULL,
  base_revision_id       TEXT NOT NULL,
  base_content_hash      TEXT NOT NULL,
  proposed_content_hash  TEXT NOT NULL,
  snapshot_rel_path      TEXT NOT NULL,
  source                 TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'proposed',
  conflict               INTEGER NOT NULL DEFAULT 0,
  note                   TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_file ON revision_drafts(file_id, status);

-- ⑥ L4A 后台沉淀队列（本地确定性摘要引擎）
CREATE TABLE IF NOT EXISTS summary_jobs (
  job_id         TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  file_id        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 10,
  state          TEXT NOT NULL DEFAULT 'queued',
  summary_json   TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sjobs_state ON summary_jobs(workspace_id, priority, state);

-- ⑦ 任务持久化（重启后 queued/running 重入队；四态，阻塞3 裁定不扩）
CREATE TABLE IF NOT EXISTS job_runs (
  job_id         TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  state          TEXT NOT NULL,
  phase          TEXT NOT NULL,
  request_json   TEXT NOT NULL DEFAULT '{}',
  progress_json  TEXT NOT NULL DEFAULT '{}',
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON job_runs(workspace_id, state);
```

`meta` 表新增键 `initiative_dirs`（value = JSON 字符串数组），三个写入路径：
`guanlan scan --initiative-dir <名>`（可多次，幂等覆盖）→
`POST /api/v1/index-jobs {kind:"set_initiative_dirs"}`（服务态写线程）→
seed-fixture 示例值（含 `BOM与图纸联动方案`）。既有键 `extract_rule_version` 不动。

### 4.3.3 状态机迁移事件的身份与记账规则

新增事件 kind：`state_changed` / `task_node_moved`（迁移类）与 `checkpoint_committed`；
新增事件主体 subject_kind：`artifact` / `initiative` / `task_node` / `checkpoint`；
新增 occurred_source：`state_machine`（§5.5 来源枚举扩展）。

- **subject_id 编码迁移方向**：
  - `task_node_moved`：`{node_id}:{from_state}->{to_state}`，如 `node_ab12:queued->running`；
  - `state_changed`（artifact）：`{file_id}:{from_state}->{to_state}`，如
    `f_ab12cd:pending_review->executing`；
  - `state_changed`（initiative）：`{initiative_id}:{from_state}->{to_state}`（同编码规则）。
  `node_id` / `file_id` / `initiative_id` 原值与迁移两端完整进 `payload_json`
  （键：`node_id|file_id|initiative_id` + `from_state` + `to_state`）与 headline。
- **幂等语义**：`uniq_event_identity`（§2.6）下同一迁移重试同身份 → 跳过（幂等成立）；
  同一文件的**多级**状态迁移（如 pending_review→approved_revision→executing）每单步
  一条、身份互异，全部记账；同一节点的 queued→running 与 running→completed 身份互异，
  全部记账。
- `occurred_at` = 迁移时刻（`clock::now_iso`，毫秒三位 ISO）；`occurred_precision` =
  `'second'`、`occurred_source` = `'state_machine'`。
- **首建静默**：`initiatives` / `artifact_states` / `task_nodes` **无既有行**时首次落库不发迁移事件、不计 changed、不 bump generation。多级迁移记账仅适用于**两个已持久状态之间**的重算。`recompute` 在 `reconcile` 的代际判定之前执行（`index/mod.rs`，`backfill_document_self_events` 之后、`changed` 计算之前），迁移事件计入 `events_inserted`，由「有变化才 bump」口径统一推进代际。

### 4.3.4 checkpoints：seq 派生与重复 SUCCESS 语义

- `checkpoint_id = 'ckpt_' + stable_key(initiative_id|stage|node_id|seq)`，其中 **seq 由库内派生**：`COUNT(*)` 该
  `(workspace_id, initiative_id, stage, COALESCE(node_id,''))` 既有行数 + 1。
  进程内 AtomicU64 计数器在重启后归零会让同节点第二次 SUCCESS 生成与重启前相同的
  主键——**禁止**。
- 防御：`stable_key` 是 32 位哈希，主键冲突时按 seq 递增重试（上限 64 次，超限报
  INTERNAL）。
- **重复 SUCCESS 语义**：追加新行（每轮执行一个快照），**不覆盖**；
  「最近一次 SUCCESS」恢复查询 = 按 `created_at DESC, rowid DESC` 取首个
  `status='SUCCESS'` 且 stage（可选 node_id）匹配的行（`Writer::latest_success_checkpoint`）。
- `node_id` 可缺省：缺省时由 `state_engine::commit_checkpoint` 按
  `(workspace_id, initiative_id, stage)` 反查槽位节点推进（外部 agent 的
  `guanlan.commit_checkpoint` 载荷不含 node_id；五槽位模型下
  initiative+stage 唯一命中）。给定时必须存在且属于该专项（否则 404 回传 reply）。
- 非 SUCCESS（FAILED_RETRYABLE / SUSPENDED_HITL）只落行与事件，不推进节点；
  derive/await_decision/deliver 槽为声明式重算，SUCCESS 行不改变其重算判据（仅
  generate 槽以 SUCCESS checkpoint 为唯一完成通道）。
- 校验（initiative/stage 存在、status ∈ `SUCCESS|FAILED_RETRYABLE|SUSPENDED_HITL`）
  与插行、`checkpoint_committed` 事件、槽位推进、recompute 同事务（校验失败不落库）。

### 4.3.5 决策解析器与抽取规则版本

- 卡点块解析：`index/decision_block.rs` 解析 `[P0/P1/P2 - 待确认|已确认]`
  标准块（决定/确认人/角色/现·新运行条件/生效范围与日期/推荐/选项行），产出
  领域模型 `domain::model::DecisionItem`（decision_id 与 statements 同源：
  `dec_` + stable_key(命名空间::归一化问题)）。
- `derive_statements` 支持第三条抽取路径（格式 C）：每卡点块一条陈述，`code` =
  优先级词（`P0|P1|P2`），`detail_json` 在既有五键序尾部追加 `priority` 键。
  **既有 A/B 两条路径输出逐字不变**（priority=None）。
- `detect_status` 支持括号形态 `\[\s*P\s*\d\s*[-—–]?\s*已确认\s*\]` → 「已确认」
  （回写后的块状态判定）。
- **EXTRACT_RULE_VERSION 维持 `v0.4.3` 不 bump**：与 `server/WorkspaceStore.ts` 保持一致以维持 Node↔Rust 写入对拍，且避免触发存量工作区全量重派生。存量工作区已含卡点块的文件在内容变化产生新版本后抽取 P0/P1/P2 陈述。

### 4.3.6 状态机确定性口径

1. **阶段枚举**：`蓝图|计划|决策|执行|交付|待分类`；阶段序 `待分类 < 蓝图 < 计划 < 决策 < 执行 < 交付`。
2. **文档阶段判定**（`state_machine::stage_from_path`）：按相对路径关键词短路——
   决策（待确认/已确认/决策/回执）→ 计划（方案/计划/设计）→ 交付（交付/清单/验收）→
   蓝图（需求/提案/蓝图/概要）→ 执行（执行/实现/联调）→ 待分类。
3. **专项 current_stage**：已归类文档阶段的最靠后者；无文档为「待分类」。
4. **selected_revision_id / has_selected_revision**：取 `files.last_revision_id`（当前版本即选中修订）。
5. **last_activity_at**：该文件最新版本的 `occurred_at`（材料时间口径，§5.5）；无
   版本为 NULL；`last_activity_days` = UTC 天差，无活动记录按 0（不做超期归档）。
6. **未决分级**：待确认陈述按 `detail_json.priority` 键归 P0/P1/P2；无键（既有 A/B
   路径产出）按 **P2 计（不阻塞）**。
7. **stage_has_content**：该阶段文档的最新版本 `size_bytes > 0`。
8. **node 标题**：`{stage}·{派生|等待人工拍板|生成执行|交付核验}`；`node_id` =
   `node_` + stable_key(initiative_id|stage|node_kind)，幂等可对拍。
9. **交付槽完成判据**：交付段文档 checklist 聚合 `total>0 && done==total` 且该专项
   阻塞级未决清零；`total==0`（无清单项）视为未满（与文档级 Executing→Delivered 需
   `total>0` 一致）。
10. **identity-vectors 降级**：`domain/vectors_fixture_test.rs` 在
    `identity-vectors.json` 缺失（干净 checkout 无 seed）时显式跳过（经 `note_skipped` 记入跳测日志）；核心身份公式另由内嵌 `SESSION_VECTORS` 覆盖。`native/testdata/token-vectors.json` 为仓库内静态向量文件，Rust 侧 `include_str!` 编译期读取，TS 侧 `fs.readFileSync` 同源读取。

---

## 4.4 身份保真文件操作与回收站还原契约

不变更 SQLite 表结构（仍保持 `user_version = 2`），在既有 `files`、`path_aliases`、`events` 之上固化以下不变量（实现见 `guanlan-core/src/index/file_ops.rs`）：

1. **`files.status` 扩展枚举**：由 `active | missing` 扩为 `active | missing | trashed`。
   - `active`：当前工作区可见文件；
   - `missing`：扫描期未见但曾收录的文件；
   - `trashed`：经 `POST /api/v1/files/{id}/trash` 移入操作系统回收站的文件。`files` 行、`revisions`、`blobs`、`statements`、`edges` 与 `path_aliases` 均完整保留，仅从默认 `active` 列表隐藏；`/api/v1/bootstrap` 额外下发 `recoverable_file_ids`（`missing | trashed`）防止前端误剪枝阅读进度。
2. **重命名 / 跨目录移动单事务保真**：
   - 先做工作区越界、符号链接逃逸、Windows 保留名、隐藏段与排除目录校验，再执行磁盘 `std::fs::rename`；
   - 随后在**同一写事务**内按原 `file_id` 更新 `files.current_path / title / role / last_observed_at`，同步登记旧路径与新路径两条 `path_aliases`（`evidence = 'file_renamed' | 'file_moved'`），插入 `file_renamed` 或 `file_moved` 事件（严格单调递增时间戳，避免同毫秒碰撞 `uniq_event_identity`），重算统一状态机投影并推进 `index_generation`；
   - **严禁生成新 `file_id`**，确保版本链、关联决定（通过 `file_id` 关联）与前端阅读进度 100% 连续。
3. **非破坏性回收站与自动重连红线**：
   - 删除动作强制 `confirm = true` 且恒走操作系统回收站驱动（`OsTrashDriver`），严禁对用户工作区文件调用永久物理删除 API；
   - 用户在系统回收站执行「还原」后，下轮 `reconcile` 依次按 `files` 原路径、`path_aliases` 与同哈希候选（包含 `trashed` 态文件）识别并恢复为 `status = 'active'`，自动重连原 `file_id` 与全部历史记录。

---

## 4.5 全文件类型分级入库与三档快照配额契约

不改变既有 `files / revisions / blobs` 表 DDL（维持 `user_version = 2`），放开采集白名单并落实三档存储隔离（实现见 `guanlan-core/src/index/file_format.rs`、`ignore.rs`、`collector.rs`、`storage/mod.rs`）：

1. **全格式采集与 `.gitignore` 遵守**：
   - 采集白名单放开至工作区全部常规文件；仅排除系统/依赖目录黑名单（`DEFAULT_EXCLUDED`，含 `node_modules` / `.git` / `target` / `__pycache__` / `.venv` / `dist` 等）及工作区根与逐层子目录 `.gitignore` 命中的路径（越深越优先，支持 `!` 取反、`#` 注释、`dir/` 仅目录、`/` 锚定与 `**` 跨目录）。
   - `files.format` 登记小写无点扩展名 token（无扩展名已知文件如 `Makefile`→`make`、`Dockerfile`→`dockerfile`、PDF 魔数→`pdf`、其余未知→`bin`）；既有的 `md` / `svg` / `pdf` 三值与 `file_id` / `revision_id` 身份公式**逐字保留**，不生成第二套历史。
   - 格式族（`FormatClass`：13 族）由扩展名纯函数派生，不落库。
2. **三档快照配额策略（`SnapshotPolicy`）**：
   - **第一档（文本型：`< 10 MiB` 默认，可按工作区上调）**：`Markdown / Text / Code / Vector / Spreadsheet` 低于阈值时存去重全量快照（`snapshot_available = 1`，写 `blobs/` + 登记 `blobs` 行）。
   - **第二档（二进制交付物：`< 50 MiB` 默认，可按工作区上调）**：`Image / Document / Presentation / Archive` 低于阈值时存去重全量快照（`snapshot_available = 1`）；达到或超过阈值时仅记流式哈希与元数据（`snapshot_available = 0`）。
   - **第三档（流媒体与未知大二进制：永远仅记元数据）**：`Audio / Video / Font / Binary` 一律只记文件身份、尺寸、mtime 与 64KiB 恒定内存流式 SHA-256（`snapshot_available = 0`，**绝不**把字节读入整块内存、**绝不**写 `blobs/` 或登记 `blobs` 行）。
   - 降级版本不违反 §0 不变量：`Writer::insert_revision` 对 `snapshot_available = 0` 的行不要求 `blobs` 存在，读取侧诚实返回 `410 SNAPSHOT_UNAVAILABLE`，绝不拿当前工作区磁盘文件冒充旧版本。
3. **工作区级可调阈值（`meta` 表）**：
   - 键名：`snapshot_text_max_mb`（默认 `10`）、`snapshot_binary_max_mb`（默认 `50`）；可通过 `POST /api/v1/storage/policy` 写入（环境变量 `GUANLAN_SNAPSHOT_TEXT_MAX_MB` / `GUANLAN_SNAPSHOT_BINARY_MAX_MB` 优先级更高）。
   - 历史版本行已落库的 `snapshot_available` 在采集时刻固化，调整阈值只作用于后续新增版本，历史版本不漂移。

---

## 5. 与读取相关的历史语义 [逐字兼容]

### 5.1 内容未变 ⇒ 不增版本、不增业务事件

- 判定式：`latest.content_hash === file.sha256`（`reconcile.ts:273`）→ 仅事务内 `touchFile`（更新 `last_observed_at / last_mtime_ms / last_revision_id / status='active'`，`WorkspaceStore.ts:527-534`），**不插入 revision、不插入内容事件**。连续重扫不增事件。
- 例外（语义上是「恢复」不是「内容」事件）：文件此前 `status='missing'` 且原内容重现 → 追加一条 `read_recovered` 事件（`reconcile.ts:286-304`），identity 为 `(ws,'read_recovered',file_id,last_revision,NULL)` ⇒ 同一文件同一版本终生只此一条。

### 5.2 仅 mtime 变化 ⇒ 不增版本、不增事件

- 内容哈希相同而 `last_mtime_ms !== file.mtimeMs` 时：只更新采集元数据（touchFile），不登记内容版本、不产生事件。仅计数 `mtimeOnly`。

### 5.3 A → B → A ⇒ 三次版本出现、两份去重内容

- 三个 `revisions` 行（seq 1/2/3，`content_hash` h1/h2/h1），`blobs` 里 h1 只有一行、`ref_count` 累加为 2，磁盘上只有一份 h1 快照。读取端版本链按 `revisions(file_id, seq)` 排序展示三次出现。

### 5.4 缺失判定只认完整范围（读取端语义）

- 只有当本轮扫描 `collected.complete`（范围枚举完整、无截断）时才对未见到路径标 `missing` 并发事件；中断或失败不得批量误报删除/缺失。读取端可把 `missing` 事件视为完整范围扫描的结论。

### 5.5 时间字段：发生 / 采集 / 来源 / 精度 四者独立

- 字段分离（版本与事件两表同构）：`observed_at`（采集时刻，NOT NULL）与 `occurred_at / occurred_precision / occurred_source`（发生时刻及其依据，可空/默认 `'unknown'`）：`WorkspaceStore.ts:70-73`（revisions）、`87-90`（events）；DDL §1.1。
- 精度枚举：`'second' | 'minute' | 'day' | 'unknown'`（`WorkspaceStore.ts:31`）。来源枚举：`'collector' | 'document_self' | 'manifest' | 'git_commit' | 'file_mtime'`（`WorkspaceStore.ts:32-37`）；当前实现实际写入的来源只有 `document_self`、`file_mtime`、`collector` 三种（`manifest`/`git_commit` 尚无写入点）。
- 版本发生时间规则（`reconcile.ts:344-364`）：
  - v1（首次捕获）：md 正文自述日期优先（`document_self`）；无自述则回退文件 mtime（`file_mtime`，precision `'second'`）；
  - v2+（后续修改）：一律 mtime，precision `'second'`，source `'file_mtime'`（`349-353`；理由注释 `346-348`：「文档自述日期通常停留在初稿，不能拿来当修改时间」）。
- mtime 时刻的具体格式：`new Date(mtimeMs).toISOString()` —— **UTC、带毫秒**（如 `2026-01-02T03:14:15.926Z`），precision 却标 `'second'`（`reconcile.ts:348,352,360`）。Rust 写入需保持同格式；读取端按 RFC3339 解析、显示按既有规则。
- 事件发生时间继承其版本的发生时间字段（`reconcile.ts:437-439`）；决策事件取来源版本的发生时间（`883-885`）；回填事件的 `observed_at` 取原版本的 `observed_at`（`705`，`722-725`）。

### 5.6 纯日期：不补午夜、不做时区换算

- 正文自述日期抽取（`derive.ts:339-364`）：候选依次为 front matter `date|updated|created` 行（`344-349`）、`文档日期：YYYY-MM-DD`（`350-351`）、正文前 1200 字符内首个 ISO 日期（`352-353`）；引号剥离后按 `^(\d{4})-(\d{2})-(\d{2})` 前缀匹配（`356-357`）。
- 命中即返回**纯日期字符串** `YYYY-MM-DD`，`precision = 'day'`，`source = 'document_self'`——「只有日期：保留到天，不补零点时刻」（`derive.ts:359-360`）。因此 `document_self` 来源的 `occurred_at` 当前恒为纯日期；即使原文带时刻也会被截断为日期（见 §8 待确认 6）。
- 无候选 → `null / 'unknown' / null`，由 mtime 兜底（`derive.ts:363` + `reconcile.ts:359-363`）。
- 全程不做时区换算、不补 `T00:00:00`：基线卡发生时间也是 `observedAt.slice(0,10)` 纯日期，precision `'day'`、source `'collector'`（`reconcile.ts:512-514`）；事件文案显式声明「未补零点时刻」。读取端按精度分组展示，日级事项归日期组。

### 5.7 基线与逐文件事件的分工（首扫语义，读取端会遇到）

- 首次扫描（无 `workspace_baseline` 事件，`reconcile.ts:176` + `WorkspaceStore.ts:374-379`）：正文有自述日期的材料各自发 `appeared` 事件入轴；无日期依据的新文件不发逐文件事件，统一由一条基线卡覆盖（`reconcile.ts:411-412`，事件 `504-531`，headline「首次纳入 N 份资料」）。
- `appeared/modified` 事件 `payload_json` 字段（`reconcile.ts:449-463`）：`path, format, size_bytes, content_hash, mtime_ms, time_basis('document_self'|'file_mtime'|'collector'), changed_sections, added_lines, removed_lines`。`batch_id` 当前恒为 null。

### 5.8 重放与决策事件幂等

- 任务重试依赖 §2.6 去重身份，不得再次新增同一事件（实现 `WorkspaceStore.ts:615-655`）。
- 决策事件只在**状态转换**时新增：每业务决定取最新来源陈述的状态与上一次决策事件 payload 的 `status` 比较，相同则只留 statements 证据、不插事件（`reconcile.ts:833-906`，跳过判定 `871-872`）；状态→事件种类映射 `810-825`。

---

## 6. 监听信号语义（简要，供 `service/runtime` 对齐）

来源 `server/watcher.ts`：

1. 监听只作为「触发核验」的信号，**不作为审计日志**；版本判定永远由对账做（`watcher.ts:4-7` 头注释；`WatchChange.paths` 注释「仅用于提示，不作为事实」`19-20`）。
2. `fs.watch(root, { recursive: true })`；`filename` 为空则忽略；反斜杠规范化为正斜杠后入待处理集合（`watcher.ts:57-62`）。Linux 不支持 recursive 时监听整体失败不致命（`69-71`）；watcher 错误只发 `watch-error`，定时/手动重扫兜底（`64-67`）。
3. 忽略规则：路径任一段属于默认集 `['node_modules','.git','.venv','dist','runtime','backups','tmp']` 或以 `.` 开头（`watcher.ts:81-84`）。
4. 调度：目录级防抖默认 1500ms（`88`）；距上次核验不足 `minIntervalMs`（默认 8000ms）则合并为一次延后核验（`93-98`）；单飞——上一轮未完成只排队一次，不并发对账（`100-104, 121-127`）。
5. flush 时清空并快照待处理路径集，随 `WatchChange { at, scanned, newEvents, newRevisions, generation, paths }` 发出（`107-118`）；对账异常发 `reconcile-error` 不中断后续（`119-120`）。
6. SSE 广播：`ChangeBroadcaster` 向所有客户端写 `data: <JSON>\n\n`，写失败即移除；新连接补发最新 generation，断线重连不丢通知（`131-155`）。通知传输序号独立于业务 `events.seq`。

---

## 7. 存储兼容与注意事项

1. **事件去重身份含 `occurred_at`**：`uniq_event_identity` 把 `COALESCE(occurred_at,'')` 纳入身份（§2.6）；当前 `batch_id` 恒为 null。
2. **`events.seq` 为全表全局自增**，不按 workspace 分段。
3. **时间戳格式**：`occurred_at`（mtime 来源）与 `observed_at` 均为 `Date.toISOString()` 输出（含毫秒 `.SSS`），precision 标 `'second'`（§5.5）；读取端按 RFC3339 宽容解析。
4. **自述日期截断行为**：`deriveDocumentTime` 对带时刻的字符串（如 `2026-01-02T10:30`）取前 10 字符、标 `day` 精度，Rust 写入侧保持逐字兼容。
5. **`root_path` 精确匹配认领**：盘符大小写差异会产生第二个工作区行（§2.2）；读取侧按库内已有行认领。
6. **`statements`/`edges` upsert 不回填的列**（§1.5）：`namespace/question/observed_at` 等首插后不再更新。

---

## 9. `office_extracts` 内容寻址 L2 结构缓存表

- DDL 位于 `writer.rs` `SCHEMA`（通过 `CREATE TABLE IF NOT EXISTS office_extracts` 幂等追加，不破坏现有 7 张核心对账表结构与 v0/v1/v2 只读兼容）：
  - `content_hash TEXT PRIMARY KEY`（与 `blobs`/`revisions.content_hash` 同源，跨路径与 A→B→A 共享零重复解析）
  - `format TEXT NOT NULL`（`docx | xlsx | docm | xlsm ...`）
  - `status TEXT NOT NULL`（`indexed | encrypted | corrupted | metadata_only`）
  - `error_reason TEXT`
  - `extract_json TEXT NOT NULL DEFAULT '{}'`
  - `plain_text TEXT NOT NULL DEFAULT ''`
  - `extract_rule_version TEXT NOT NULL DEFAULT 'v0.4.3'`
  - `updated_at TEXT NOT NULL`
- 提取解析在 `reconcile()` 的 `writer.transaction(...)` **外部**完成，事务内仅写入 `office_extracts` 行与派生的 `statements`。


---

## 10. `pdf_extracts` 内容寻址页级文本缓存表

- DDL 位于 `writer.rs` `SCHEMA`（通过 `CREATE TABLE IF NOT EXISTS pdf_extracts` 幂等追加，不破坏现有核心对账表结构与 v0/v1/v2 只读兼容；附 `idx_pdf_status` 索引）：
  - `content_hash TEXT PRIMARY KEY`（与 `blobs`/`revisions.content_hash` 同源，跨路径与 A→B→A 共享零重复解析）
  - `status TEXT NOT NULL`（`page_indexed | image_only | ocr_pending | extract_failed | encrypted | corrupted | metadata_only`）
  - `error_reason TEXT`
  - `page_count INTEGER NOT NULL DEFAULT 0`
  - `extract_json TEXT NOT NULL DEFAULT '{}'`（`PdfExtractRecord` 全量页级结构：逐页 `page_number/heading/extracted_text/page_kind/image_count/char_count/visual_summary`；`plain_text` 不入 JSON，单独落列）
  - `plain_text TEXT NOT NULL DEFAULT ''`
  - `extract_rule_version TEXT NOT NULL DEFAULT 'v0.4.3'`
  - `updated_at TEXT NOT NULL`
- 提取解析在 `reconcile()` 的 `writer.transaction(...)` **外部**完成（流解压/页面解析绝不占用 SQLite 写锁持有期），事务内仅写入 `pdf_extracts` 行与派生的 `statements`；`snapshot_available = 0` 的大文件只落 `metadata_only` 行，绝不把全文读入内存。
- Markdown `path.pdf#page=N` 链接在 `derive.rs` 派生为陈述 `detail` 的 `linkedPdf` 字段（`{ file_id, revision_id, relative_path, pdf_anchor: { kind: "pdf_page", page } }`），与 `linkedOffice` 同构。

---

## 11. 候选事项三表（多信号编织；采纳前绝不写正式归属）

- `initiative_candidates`：`candidate_id TEXT PK`（`cand_<簇键16>`）、`workspace_id`、`candidate_key`（排序成员 file_id 的 sha 前 16，重扫幂等键）、`title / reason_summary`、`signal_mask`（0x01 目录前缀 | 0x02 显式链接 | 0x04 同名主干 | 0x08 会话共现 | 0x10 Agent 批次）、`score`（0-100）、`member_count`、`state`（`candidate | adopted | dismissed`）、`created_at / updated_at`；索引 `idx_icand_ws_state(workspace_id, state)`。
- `initiative_candidate_members`：`(candidate_id, file_id) PK`、`role`（`member | excluded`）、`signals_json`（理由胶囊数组 `[{signal, detail}]`）；索引 `idx_icand_member_file(file_id)`。
- `initiative_candidate_exclusions`：`(workspace_id, file_a, file_b) PK`（规范化 `file_a ≤ file_b`）、`created_at`——**信号对排除**，weaver 全部 union 前剪除命中对，保证"误聚项剔除后重扫不反弹"。
- 编排在 `guanlan-service::index_jobs::reweave_candidate_clusters`：对账完成后收集 `files(active) + edges(explicit_reference, resolved)` → `domain::candidate_weaver::weave_candidates` 纯函数聚类 → 排除对剪除 → `Writer::reweave_candidates` 事务落库（`candidate` 态整体替换，`adopted/dismissed` 不动）。

---

## 12. 混合倒排检索索引两表（可随时丢弃重建的派生层）

- **派生定位**：两表完全可由 `files + revisions + blobs 快照 + pdf_extracts/office_extracts` 重算，任意损坏经 `POST /api/v1/search/rebuild`（内部 `JobKind::rebuild_search_index`）或下一轮对账尾部自动全量重建恢复；**派生行变化不推进 `index_generation`**（代际只属事实层）。
- `search_docs`：`file_id TEXT PRIMARY KEY`（**每文件仅最新版本**——`revisions.seq` 最大者；检索语义为「找到当前文件」）、`workspace_id`、`revision_id`、`content_hash`、`format`、`title`、`rel_path`（normalize_rel_path 口径）、`status`（同步差分键；非 active 不留行）、`has_body INTEGER`（0=仅标题/路径可检索：metadata_only、无文本层 SVG、无 extracts 缓存）、`body_text TEXT`（按 `\n` 连接的原文行，尾部空行裁除；行号=下标+1 与 statements.line_start 同口径）、`anchor_json TEXT`（行级锚点：`{"v":1,"kind":"pdf","pages":[行→页码]}` / `{"kind":"docx","paras":[行→段号]}` / `{"kind":"xlsx","cells":[{s,n,r} 行→单元格]}`；文本族为空串）、`line_count`、`truncated`（正文保险丝：行数 20,000 / 字节 512KiB）、`indexed_at`；索引 `idx_sdocs_ws(workspace_id)`。DDL 单一来源：`guanlan-core/src/index/search_index.rs SEARCH_DDL`，由 `Writer::ensure_schema` 幂等执行。
- `search_postings`：`(term, field, file_id) PRIMARY KEY`（WITHOUT ROWID）+ `weight`；`field ∈ {title, path, content}`；权重 `title=60 / path=45 / content=10 / 编号整词=15 / 单字=5`；词项构成：中文双字 Bigram + CJK 单字（有界回退）+ 英文词元（`[a-z0-9_#-]+` 小写）+ 专有编号整词（内部 ID 四式 `q\d+|t-\d+|cand-\d+|rev_\w+|file_\w+`、通用 `word[-_]digits`、`#digits`）+ 路径/标题分段词（`/` 与 `.` 切段、段内保 `-_` 连接）+ 首字母缩写（`user-auth-service`→`uas`，≤12 字符）；单文档 content 词项上限 4096（编号词优先保留）；索引 `idx_spost_file(file_id)`。
- **meta 键**：`search_rule_version`（现行 `s1`——分词/权重/正文编码规则版本，变更即全量重建）、`search_state`（`ready | building`，缺失视作 `absent`——查询侧非 ready 诚实空结果）、`search_docs_count`。
- **同步时机与差分**：`reconcile_collected` 尾部（状态机重算后、代际判定前）`sync_after_reconcile`——差分键 = `(revision_id, rel_path, status)` 与 files 权威值不一致的文件 + `search_docs` 侧孤儿行；全量重建按 500 文件/事务分批。
- 快照正文读取复用三档快照口径：`snapshot_available=0` 或快照不可读一律 `has_body=0`，绝不拿当前文件冒充其他版本、绝不谎报正文命中。

---

## 13. 参考工作区只读挂载（mounts.json 侧车与路径规范化）

- **只读第二库**：参考工作区经 `ReadonlyStore::open_at(<参考区数据目录>, <规范化根路径>)` 以 `SQLITE_OPEN_READONLY` 打开，**参考区索引库零写入**（不建表、不写 meta、不动 blobs）；挂载/卸载只增删服务内存登记与侧车文件，绝不动参考区磁盘内容。参考区数据目录解析与生产索引侧同源（GUANLAN_DATA_DIR 整体替换 base）；挂载时解析出的目录随侧车持久化，重启按原目录重开（不受后续环境变量漂移影响）。
- **挂载身份与路径规范化（core `domain/mounts.rs` 纯函数）**：
  - **plain() 语义**：Windows 扩展前缀统一剥离——`\\?\C:\foo` → `C:\foo`、`\\?\UNC\srv\share\x` → `\\srv\share\x`；随后走与 root_key 同源的 win32 `path.resolve` 移植归一（混合斜杠 / 相对段 / `..` / 尾分隔符），规范化结果**无 `\\?\` 泄漏**。`\\.\` 设备路径不属于可 plain 化形态，原样保留交由互斥/存在性校验拒绝。
  - **mount_key** = `sha256(规范化绝对路径)` 前 16 hex——同一目录的长路径 / 混合斜杠 / 尾分隔符写法哈希恒一致（哈希输入是规范化字符串本身，幂等可重复推导）；`mount_id = m_<mount_key>`。**与 root_key 命名空间独立**：主区 root_key（契约 §2.1 Node path.resolve 口径）逐字节不受影响。
  - **父子互斥判定**：组件级、大小写无关的前缀比较（`H:\work` 与 `H:\work2` 无关；`H:\work` 与 `H:\workspace` 不是父子）——挂载前对「主区 ↔ 参考区」「参考区 ↔ 既有挂载区」两两校验，互为祖先/后代一律 409 `MOUNT_REJECTED`（quiet-md 外挂目录隔离纪律，严禁嵌套成环）；同一目录重复挂载（含大小写变体）→ 409 `CONFLICT`。
- **mounts.json 侧车**（`<主区数据目录>/mounts.json`，观澜私有区，**业务目录零散落**）：`{ version: 1, mounts: [{ mount_key, root_path, ref_data_dir, name, added_at, last_known: MountedWorkspaceInfo? }] }`；挂载/卸载时 tmp+rename 原子落盘，写失败仅 stderr 告警（内存登记仍是事实源，挂载是可重建的轻状态）。服务启动 `MountRegistry::load`：逐条按记录的 `ref_data_dir` 重开只读连接，打不开的条目**离线降级**——保留 `last_known` 全部字段并置 `online=false` + `error`（优雅显示最后已知摘要，绝不伪造在线）；侧车缺失/损坏按空挂载表起步（stderr 告警，不阻断启动）。
- **跨库边界**：主/挂载区之间硬性禁止 move/rename/trash 与一切跨库写入（HTTP 受理前置溯源，403 `CROSS_WORKSPACE_FORBIDDEN`）；版本级只读端点按 revision 溯源路由到对应挂载区自己的 `blobs/`。外挂资料阅读位置（前端 localStorage `guanlan.mountReading.v1.<来源工作区 root_key>`）以参考区库内工作区行身份哈希（与 plain() 规范化路径稳定哈希同源派生）为键持久保留——参考区离线/卸载重挂/服务重启后阅读位置与最后已知摘要均可恢复。
