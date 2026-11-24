# 索引

索引把工作区目录的现状与持久库对账，写入版本、事件与证据。它是观澜**唯一的写入路径**：监听只负责触发，版本与事件的判定永远由唯一写线程上的对账执行。语义与旧 Node 管线逐字对齐，因为两边必须在同一套表上产出同一套事实，见[旧 Node 管线与对拍](legacy-node-pipeline.md)。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 文件监听 | `watcher::start` 启动 OS 原生监听（Windows `ReadDirectoryChangesW`、Linux `inotify`、其余平台轮询），把事件合并防抖后提交为索引任务。 | [`watcher.rs`](../../native/crates/guanlan-service/src/watcher.rs) |
| 任务队列 | `IndexJobManager` 与 `writer_loop`：单执行槽、串行执行、同类合并、协作式取消、重启恢复。 | [`index_jobs.rs`](../../native/crates/guanlan-service/src/index_jobs.rs) |
| 采集 | `collect_workspace` 与 `collect_specific_paths` 枚举文件、流式计算 SHA-256、判定读取是否稳定。**不做任何版本或事件判定。** | [`collector.rs`](../../native/crates/guanlan-core/src/index/collector.rs) |
| 忽略规则 | `DEFAULT_EXCLUDED` 排除依赖与构建目录；`Gitignore` 与 `IgnoreStack` 实现逐目录生效的 `.gitignore`。 | [`collector.rs`](../../native/crates/guanlan-core/src/index/collector.rs)、[`ignore.rs`](../../native/crates/guanlan-core/src/index/ignore.rs) |
| 对账 | `reconcile`（整库）与 `reconcile_paths`（定向）共用 `reconcile_collected`：识别身份、规划版本、写快照、一个事务提交。 | [`index/mod.rs`](../../native/crates/guanlan-core/src/index/mod.rs) |
| 写库语句 | `Writer` 持有唯一可写连接、`SCHEMA` 常量与全部写语句。 | [`writer.rs`](../../native/crates/guanlan-core/src/index/writer.rs) |
| 身份规则 | `root_key_of`、`stable_file_id`、`revision_id_of` 与 win32 `path` 移植。 | [`domain/mod.rs`](../../native/crates/guanlan-core/src/domain/mod.rs)、[`domain/path_win32.rs`](../../native/crates/guanlan-core/src/domain/path_win32.rs) |
| 格式与快照档位 | `FileFormat`、`FormatClass`、`SnapshotPolicy::tier_for`。 | [`file_format.rs`](../../native/crates/guanlan-core/src/index/file_format.rs) |
| 派生数据 | `derive_statements`、`derive_edges`、`derive_document_time` 从正文抽取决策陈述、引用关系与自述日期。 | [`derive.rs`](../../native/crates/guanlan-core/src/index/derive.rs) |
| 结构化抽取 | `office.rs` 与 `pdf.rs` 把 `.docx`、`.xlsx`、`.pdf` 解析成带锚点的文本，结果缓存在 `office_extracts`、`pdf_extracts`。 | [`office.rs`](../../native/crates/guanlan-core/src/index/office.rs)、[`pdf.rs`](../../native/crates/guanlan-core/src/index/pdf.rs) |
| 状态机 | `state_machine` 是无 IO 的纯函数规则；`state_engine` 负责读库内行、落库与 checkpoint 受理。 | [`state_machine.rs`](../../native/crates/guanlan-core/src/index/state_machine.rs)、[`state_engine.rs`](../../native/crates/guanlan-core/src/index/state_engine.rs) |
| 检索索引 | `search_index` 维护可随时丢弃重建的混合倒排索引。 | [`search_index.rs`](../../native/crates/guanlan-core/src/index/search_index.rs) |

## 运行路径

### 从文件事件到索引任务

1. OS 监听线程收到事件，`EventCoalescer::ingest` 归一化路径并丢弃被忽略的路径与编辑器临时文件。
2. 滑动防抖窗口 100 毫秒（`DEBOUNCE_MS`），连续写入风暴下最长等待 220 毫秒（`MAX_COALESCE_WAIT_MS`）。
3. `flush_coalescer` 把新增与修改按每批至多 2000 条（`MAX_PATHS`）提交为 `JobKind::ChangedPaths`。内核缓冲溢出，或出现目标已不在磁盘上的删除，额外提交一次 `VerifyAll`。
4. 每 300 秒（`FALLBACK_POLL_INTERVAL_MS`）做一次兜底：只 stat 全树并比对 mtime，不计算哈希。

### 一轮对账

`VerifyAll` 走 `reconcile`，`ChangedPaths` 走 `reconcile_paths`，之后都进入 `reconcile_collected`。

1. **采集**。`hash_file_stable` 先 stat、流式读一遍算哈希、再 stat；期间大小或 mtime 变了就重读一次，仍不稳定则标记 `stable = false`。全程只用一个 64 KiB 缓冲。目录项按名排序，同一工作区每次扫描顺序一致。触到文件数或深度上限时 `complete = false`。
2. **识别身份**（第一遍）。依次尝试：精确路径、路径别名、由路径推出的 ID、以及「恰好一个缺失或回收站文件与本文件同哈希」的恢复候选。最后一种命中后立刻从候选池移除，否则同轮第二个同哈希文件会撞唯一约束、回滚整轮对账。
3. **规划版本**。最新版本哈希相同即未变，只更新采集状态；mtime 单独变化不新增版本或事件。否则规划一个新版本：`seq = 最新 seq + 1`，`revision_id = revision_id_of(file_id, seq)`，`prev_revision_id` 指向最新版本。
4. **判定快照档位**。`tier_for` 在采集时刻决定，写进 `revisions.snapshot_available`，之后不再重算：
   - 音频、视频、字体、未知二进制一律 `MetadataOnly`；
   - Markdown、文本、代码、矢量图、表格：小于 `text_max_bytes`（默认 10 MiB）为 `Full`；
   - 位图、版式文档、演示稿、压缩包：小于 `binary_max_bytes`（默认 50 MiB）为 `Full`；
   - 其余 `MetadataOnly`，不复制字节。
5. **写快照**（第二遍，事务之外）。`write_snapshot_to_disk` 写到 `blobs/<哈希前两位>/<完整哈希>`：同哈希已存在且校验通过就不重写；否则流式写临时文件、重读临时文件重算哈希、再原子改名。重算结果与登记哈希不符时返回 `SnapshotOutcome::Unstable`，这个版本本轮不落。
6. **解析 Office 与 PDF**。在写事务之外完成，或按内容哈希复用缓存。
7. **一个事务提交**。`Writer::transaction` 用 `BEGIN IMMEDIATE`：批量更新未变文件；逐个版本写文件行、别名、blob 引用计数、版本行、`appeared` / `modified` 事件；**只有采集完整时**才做缺失检测。
8. **事务之后**，依次是：规则版本变化时重建派生数据、回填文档自述日期事件、`state_machine_recompute`、`search_index::sync_after_reconcile`。
9. **代际**。有新版本、有新事件、做了派生重建，或这是首轮基线，才 `bump_generation`。重复扫描不推进代际。

### 事件与账本

`Writer::insert_event` 遇到唯一约束冲突返回 `Ok(false)` 并跳过，不中断整轮事务。属于封存类型的事件在同一个事务里由 `seal_event_in_ledger` 写入哈希链，见[存储](storage.md)。

## 状态

任务的四态、合并规则、取消与重启恢复见[服务运行时](service-runtime.md)。文档与事项的六态、五槽位与 checkpoint 见[长任务引擎](longtask-engine.md)。

`index_generation` 是「事实层发生了变化」的计数。只读服务每次都现读它，不持有快照值。派生检索索引的变化**不**推进代际。

## 约束与失败行为

- **不生成第二套历史。** `rootKey`、`file_id`、`revision_id`、`event_id` 的公式是与旧 Node 管线逐字兼容的契约。`rootKey` 恒按 win32 `path.resolve` 规则求值，在所有平台上都一样；不能用 `std::fs::canonicalize` 替代，Windows 上它会引入 `\\?\` 前缀让哈希不同。路径与标题按 UTF-16 码元迭代，用 `chars()` 会让含 emoji 的路径算出不同的 ID。唯一的硬保证是 `scripts/parity-reconcile.ts`。
- **不完整的范围不得判定缺失。** 触顶、定向对账、目录读不到，都只报告已扫到的范围。读不到的目录保留原有记录并报告问题。
- **读取不稳定就不落版本。** 采集期间或写快照期间被改写的文件按读取问题记账，等下一轮对账恢复；绝不写入与哈希不符的快照。
- **版本行存在，意味着快照已在磁盘。** `insert_revision` 对引用了未登记快照的版本报错；`snapshot_available = 0` 的版本是唯一例外，它们本来就不存字节。
- **解析器不能拖垮写线程。** Office 与 PDF 解析包在 `catch_unwind` 里，并设有硬上限：PDF 每页文本累计 256 KiB（`MAX_PAGE_TEXT_ACCUM`）、单页 Form XObject 至多调用 256 次（`MAX_FORM_INVOCATIONS`）、单个流解压至多 16 MiB（`MAX_STREAM_DECODE_BYTES`）。解压与解析计算不进写锁持有期。这些上限都对应过真实事故：词法器在畸形 PDF 上原地打转，曾把进程内存推到数十 GB 后崩溃。
- **快照档位一经判定不再变。** 阈值可以按工作区或环境变量上调，但已有版本的 `snapshot_available` 保持原值。
- **忽略规则只决定「少看哪些文件」。** 没有实现 `core.excludesFile`、`.git/info/exclude` 与索引内的忽略规则，这些只会少收文件，不会错误入库。定向通道同样遵守 `.gitignore`，否则会把整树扫描排除掉的文件又塞回库里，造成「收录 / 缺失」来回抖动。
- **排除名单只排构建产物、依赖缓存与系统目录**，绝不排用户可能放资料的目录名。
- **检索索引非 ready 时，检索端点诚实返回空结果加状态字段**，不拿半成品冒充。
- **已读状态**存在 `reading_states` 表。未读的判定（当前版本是否等于 `last_read_revision_id`）在前端做，见[前端规则与跨语言镜像](frontend-rules.md)。

## 验证

```sh
cd native
cargo test --locked -p guanlan-core --lib -- index::tests
cargo test --locked -p guanlan-core --lib -- collector::
cargo test --locked -p guanlan-core --lib -- state_machine:: state_engine:: search_index::
cargo test --locked -p guanlan-core --lib -- index::file_format index::ident index::derive
cargo test --locked -p guanlan-service --lib -- watcher:: index_jobs::tests
cargo test --locked -p guanlan-service --test v03_l4a_and_decisions_ssot
```

对拍是身份规则的唯一硬保证，改任何身份公式、采集范围或对账判定后必须跑：

```sh
cargo build --release --locked -p guanlan-service
cd .. && npm run seed
npx tsx scripts/parity-reconcile.ts --exe native/target/release/guanlan.exe
npx tsx scripts/smoke-v1.ts --exe native/target/release/guanlan.exe
```

`native/testdata/identity-vectors.json` 由 `npm run seed` 生成，不入库；没有它时 `identity_vectors_from_fixture` 会打印 `[skip]` 并直接返回，所以干净 checkout 上的 `cargo test` 并没有验证夹具身份。
