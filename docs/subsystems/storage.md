# 存储

观澜的全部持久状态在一个工作区数据目录里：一个 WAL 模式的 SQLite 库加一棵按内容哈希寻址的快照目录。读侧只有只读连接，写侧只有唯一写线程；schema 变更带强制备份与原子回滚；关键决定事件进入防篡改哈希链；一切对外暴露的路径都要过沙箱校验。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 数据目录布局 | `<dataDir>/index.db`（WAL，伴随 `-wal`、`-shm`）与 `<dataDir>/blobs/<哈希前两位>/<完整哈希>`。数据目录本身的解析见[服务运行时](service-runtime.md)。 | [`storage/mod.rs`](../../native/crates/guanlan-core/src/storage/mod.rs) |
| 只读句柄 | `ReadonlyStore` 以 `SQLITE_OPEN_READONLY` 打开，没有任何写方法；持有行结构 `FileRow`、`RevisionRow`、`EventRow` 等。 | [`storage/mod.rs`](../../native/crates/guanlan-core/src/storage/mod.rs) |
| 写入侧 | `Writer` 持有唯一可写连接、`SCHEMA` 常量与全部写语句。写事务一律 `BEGIN IMMEDIATE`。 | [`index/writer.rs`](../../native/crates/guanlan-core/src/index/writer.rs) |
| schema 与迁移 | `CURRENT_SCHEMA_VERSION` 是 2。`run_safe_schema_migration` 负责版本门禁、升级前备份、事务内 DDL 与失败回滚。 | [`storage/migration.rs`](../../native/crates/guanlan-core/src/storage/migration.rs) |
| 维护 | `verify_blobs_integrity`、`execute_storage_gc`、`export_workspace_open_archive`、`export_diagnostic_zip`。 | [`storage/maintenance.rs`](../../native/crates/guanlan-core/src/storage/maintenance.rs) |
| 决定账本 | `seal_event_in_ledger` 在写事务内追加链节点；`verify_decision_ledger` 只读审计。 | [`storage/ledger.rs`](../../native/crates/guanlan-core/src/storage/ledger.rs) |
| 路径沙箱 | `validate_workspace_rel_path` 做词法校验；`resolve_existing_file_in_dir_jail` 做磁盘校验；`audit_workspace_file_paths` 审计库里全部路径。 | [`storage/sandbox.rs`](../../native/crates/guanlan-core/src/storage/sandbox.rs) |

数据目录里其余的文件：`service.lock` 与 `service.lock.info`（工作区锁）、`mounts.json`（只读挂载的侧车）、`backups/`（迁移前备份，至多 5 份）、`diagnostics/`（诊断包）、`exports/`（开放导出）。

## 运行路径

### 打开只读连接

`ReadonlyStore::open` 设 `busy_timeout = 5000` 与 `foreign_keys = ON`。`journal_mode = WAL` 是写操作，只读连接不执行，沿用库文件既有模式。随后校验 `PRAGMA user_version` 在 `{0, 1, 2}` 内，否则拒绝打开。

`open_for_root` 解析默认数据目录后调用 `claim_workspace`：先按 `root_key` 精确匹配工作区行；未命中且全表恰好一行时按那一行认领。读侧只认领已有行，从不新建。

`workspace()` **每次现读**工作区行，因为 `index_generation` 与 `last_scan_at` 随时会被写线程推进，读服务不能持有快照值。

### 打开可写连接

`Writer::open_at` 的顺序是固定的：

1. `check_schema_version_writable`：`user_version` 高于当前支持的最高版本时，在任何写操作（包括 WAL PRAGMA 与 DDL）之前以 `SCHEMA_TOO_NEW` 拒绝。
2. 设 `journal_mode = WAL`、`foreign_keys = 1`、`busy_timeout = 5000`。
3. `ensure_schema`，内部调用 `run_safe_schema_migration`。
4. `ensure_workspace`：按 `root_path` 精确查找工作区行，没有就插入。

### 一次 schema 迁移

`run_safe_schema_migration` 先 `probe_schema_migration`。`user_version` 已是 2 但缺少增量列或派生表时，同样算需要迁移。需要迁移且库里已有历史表时，先用 SQLite Online Backup API 在 `backups/` 生成一份通过 `PRAGMA quick_check` 的独立备份，按时间保留最近 5 份。全新空库不备份。然后在一个 `BEGIN IMMEDIATE` 事务里执行 DDL 并推进 `user_version`；任何一步失败就 `ROLLBACK`，原库不变。`restore_backup_to_db` 可以从备份还原。

### 封存一条关键事件

`Writer::insert_event` 插入事件成功后，若事件种类在 `LEDGER_SEALED_EVENT_KINDS` 里，就在同一个事务里调用 `seal_event_in_ledger`：

1. 取该工作区链上最后一个 `chain_hash`，没有则用 64 个 `0` 的创世哈希。
2. `record_hash` 是事件载荷的 SHA-256；`chain_hash` 再把前驱哈希、记录哈希、事件 ID 与种类一起哈希。字段一律长度前缀编码，消除字段边界碰撞。
3. 插入 `decision_ledger_chain` 行，并把 `ledger_chain_head_hash` 与 `ledger_chain_head_seq` 写进 `meta` 表。链头锚点让「连同尾部链行与事件行一并截断」也能被发现。

封存的种类共 9 个：`decision_writeback`、`decision_changed`、`proposal_raised`、`proposal_adopted`、`proposal_dismissed`、`checkpoint_committed`、`orphan_repaired`、`initiative_archived`、`initiative_reopened`。

### 一次存储瘦身

`execute_storage_gc` 分两步，顺序不能反：

1. 一个短写事务：把被瘦身的版本 `snapshot_available` 置 0，删除引用计数归零的 `blobs` 行。**不删除任何版本行、事件或决定。**
2. 数据库提交成功之后，才物理删除已无引用的 blob 文件与孤儿文件。

`dry_run` 为真时只返回计划。受保护集合由 `build_gc_plan` 计算；只读预演走 `plan_storage_gc`，实际执行时 `execute_storage_gc` 会重新算一遍计划。

## 约束与失败行为

- **读侧不写库。** 不执行 `SCHEMA`、不 `ALTER TABLE`、不写 `meta`、不推进代际。打开已有数据零扫描，读路径里没有目录枚举或内容哈希。
- **只读连接打不开就失败。** 部署环境连 `-shm` 都不可写时，启动直接失败，不退化为可写连接。
- **高版本库拒绝盲写。** 旧版程序遇到新版库，写侧以 `SCHEMA_TOO_NEW` 拒绝，读侧同样拒绝打开。这两个拒绝走的都是 `INTERNAL` 包络码，靠错误文本里的 `SCHEMA_TOO_NEW` 前缀区分。写侧升级与读侧必须同包发布。
- **瘦身绝不误删。** 被决定陈述、引用边、治理事件、选定的产物版本、待处理草案、文件首版或当前版引用的快照都在保护范围内。某个过程版本被瘦身后，只要它的 `content_hash` 还被任何受保护版本共享，物理文件也不删。
- **完整性诊断完全诚实。** `verify_blobs_integrity` 对每份活跃快照重新计算 SHA-256，报告受影响的文件路径、版本号、关联的决定与事件数。
- **恢复与回收流程不得删除仍被 `revisions` 引用的快照。**
- **账本表不存在时审计结果为通过**，`table_present` 为 `false`。这是旧库的正常状态，但审计报告的 `ok: true` 并不代表链已被验证过，调用方要看 `table_present`。
- **沙箱是词法校验加磁盘校验两层。** 词法层拒绝控制字符、任何冒号（盘符、协议、NTFS 备用数据流）、`%2e` 一类编码穿越、绝对路径、空段与 `..`、Windows 保留设备名。磁盘层逐段解析、拒绝符号链接、每一步规范化并确认仍在根下。任何 MCP 工具、HTTP 端点或后台写回都不得读写授权工作区之外的文件。
- **诊断包会脱敏。** 工作区绝对路径、数据目录、用户主目录与密钥片段在打包前替换掉。
- 开放导出的格式版本是 `guanlan.open_export.v1`，结构变更时要升版本。

## 验证

```sh
cd native
cargo test --locked -p guanlan-core --lib -- storage::migration storage::ledger storage::sandbox
cargo test --locked -p guanlan-core --lib -- readonly_open default_data_dir file_row_reads_real_and_integer_mtime
cargo test --locked -p guanlan-core --lib -- storage::maintenance
cargo test --locked -p guanlan-service --test e05_concurrent_mcp_audit
```

`f03_`、`f02_`、`e05_` 开头的测试分别锁定上述安全、清理与防篡改红线。在真实库上手跑只读审计：`cargo run --locked -p guanlan-service -- audit --root "<工作区目录>"`，检出篡改或越界时退出码为 3。
