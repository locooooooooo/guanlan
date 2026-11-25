# 旧 Node 管线与对拍

`server/` 是观澜早期的 Node 实现：采集、对账、查询、Vite 开发中间件。它早已不是运行时的一部分，**但它不能删**。它是 Rust 写入器的参照实现：Rust 接管索引后必须在同一套表上产出同一套事实，而验证这一点的脚本只导入旧管线、只跑 Rust 二进制，两边不共享任何代码。

## 职责与事实来源

| 文件 | 职责 | 现在还有谁在用 |
| --- | --- | --- |
| [`server/WorkspaceStore.ts`](../../server/WorkspaceStore.ts) | 持久层：`node:sqlite`、schema、`rootKeyOf`、`defaultDataDir`、`EXTRACT_RULE_VERSION` | 下表全部 |
| [`server/reconcile.ts`](../../server/reconcile.ts) | 对账与历史写入；`stableFileId`、`revisionIdOf` 在这里 | 下表全部 |
| [`server/derive.ts`](../../server/derive.ts) | 决策陈述与引用关系的派生 | 对拍、夹具 |
| [`server/queries.ts`](../../server/queries.ts) | 事件分页查询与按日分桶 | 夹具、三个 v04 测试 |
| [`server/project.ts`](../../server/project.ts) | 持久库到前端契约的投影 | 夹具、历史脚本 |
| [`server/watcher.ts`](../../server/watcher.ts) | 文件监听与增量对账 | 一个 v04 测试 |
| [`server/workspace-plugin.ts`](../../server/workspace-plugin.ts) | Vite 开发服务器中间件 | **没有任何导入者** |
| [`src/services/FileScanner.ts`](../../src/services/FileScanner.ts) | 旧采集器 | 只有 `server/reconcile.ts` |
| [`src/services/WorkspaceTransformer.ts`](../../src/services/WorkspaceTransformer.ts) | 只剩章节大纲解析还在用 | 只有 `server/reconcile.ts` |

| 使用者 | 用它做什么 |
| --- | --- |
| [`scripts/parity-reconcile.ts`](../../scripts/parity-reconcile.ts) | Node ↔ Rust 写入对拍 |
| [`scripts/seed-fixture.ts`](../../scripts/seed-fixture.ts) | 生成夹具工作区、期望结果与身份向量 |
| `test/v04-events-query.test.ts`、`test/v04-round2-server.test.ts`、`test/v04-round1-scenario.test.ts` | 对旧管线自身的回归测试，随 `npm test` 一起跑 |

`vite.config.ts` 不再挂载 `guanlanWorkspacePlugin`，只把 `/api` 代理到 Rust 服务。旧中间件服务的是 `/api/workspace/*`，前端只调用 `/api/v1/*`，所以把插件重新挂回去也对接不上。

## 对拍是怎么做的

`scripts/parity-reconcile.ts`：

1. 同一个工作区（默认 `native/testdata/fixture/workspace`），交给 `server/reconcile.ts` 的 `reconcileWorkspace` 写进一个临时数据目录。
2. 再交给 `guanlan scan --root` 写进另一个临时数据目录（`GUANLAN_DATA_DIR` 指过去）。
3. 用 `node:sqlite` 只读打开两个 `index.db`，逐表导出 `files`、`path_aliases`、`revisions`、`events`、`statements`、`edges`、`blobs`。
4. 剔除采集时刻一类必然不同的字段（`observed_at`、`last_scan_at`、`seq` 等），按主键排序后比对。
5. 任一差异逐条列出，非零退出。

它不碰真实数据目录。两侧的 `rootKey` 口径一致，所以 Rust 侧的数据目录同样是 `<base>/<rootKey>`。

## 为什么必须逐字兼容

契约里标 **[逐字兼容]** 的规则，Rust 实现必须与 Node 现行为完全一致，字节级，不得用等价近似替代。落在实现上：

- **`rootKey`** 是 `sha256(path.resolve(rootPath))` 的前 16 个十六进制字符，恒按 Node win32 `path.resolve` 的规则求值，在所有平台上都一样。Rust 侧是 `domain/path_win32.rs` 里的逐字移植，连 Node 的一个怪癖都照抄了（`slice(0, -1)` 是去掉最后一个字符）。
- **不能用 `canonicalize`** 求 `rootKey`。Windows 上它会引入 `\\?\` 前缀，哈希就变了。
- **路径与标题按 UTF-16 码元迭代**。Rust 必须用 `encode_utf16()`，用 `chars()` 会让含 emoji 的路径算出不同的 ID。
- **`detail_json` 的键序固定**（`options, recommendation, impactBlocked, impactAllowed, confirmer`）。`serde_json` 的 Map 默认按键排序，所以这里是手工拼串。
- **`mtime` 要按浮点读**。真实库里 `mtime` 多数存成 REAL，少数是 INTEGER。
- **日归属按本地日**，纯日期不参与时区换算。

任何一处偏差都会让库里出现两套并存的记录，也就是「第二套历史」。

## 规则版本

两侧各有一个 `EXTRACT_RULE_VERSION`，目前都是 `v0.4.3`（Node 在 `server/WorkspaceStore.ts`，Rust 在 `index/writer.rs`）。版本号变化会触发全量重派生（删边加重抽），所以它是一次独立的变更，不与其他改动混在一起。卡点块解析器加入时刻意没有升这个版本：它只影响新版本的派生，存量工作区要等文件内容变化产生新版本后才会抽出陈述。

## 约束

- **不要删 `server/`、`FileScanner.ts`、`WorkspaceTransformer.ts`。** 它们看起来像死代码，实际是对拍的基准与夹具的生成器。
- **不要「现代化」旧管线。** 它的价值在于冻结；它的行为变了，对拍就失去意义。Rust 侧的行为要与它对齐，而不是反过来。
- **改任何身份公式、采集范围、对账判定、派生规则之后必须跑对拍。** 这是那道约束唯一的硬保证。
- **对拍脚本刻意不共享实现**：TS 侧只导入旧管线，Rust 侧只跑二进制。
- **`npm test` 依赖 `node:sqlite`**，所以 Node 至少要 22.13。
- 三个 v04 测试会在临时目录建真实的 SQLite 库，是 `npm test` 里最慢的一批。

## 验证

```sh
cargo build --release --locked -p guanlan-service   # 在 native/ 下
npm run seed
npx tsx scripts/parity-reconcile.ts --exe native/target/release/guanlan.exe
npx tsx scripts/smoke-v1.ts --exe native/target/release/guanlan.exe
npm test
```

CI 的 `smoke` 作业在 Ubuntu 与 Windows 上各跑一遍对拍与冒烟，从干净 checkout 重新生成夹具。`smoke-v1.ts` 从外部对 Rust 服务逐端点比对 `npm run seed` 导出的期望结果，它同样刻意不导入任何观澜实现。
