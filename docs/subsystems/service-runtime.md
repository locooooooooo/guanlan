# 服务运行时

`guanlan serve` 与桌面壳共用同一条启动流程：校验工作区、解析数据目录、取工作区排他锁、让唯一写线程与只读连接池就位、绑定回环端口、装配路由。读请求经有界查询通道落在只读连接上；写请求全部排队到唯一写线程；写线程的产物经通知桥变成 SSE 事件。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 启动编排 | `start_readonly_service` 读 `ServeConfig` 并调用 `start_service_with_projects_file`，后者是 CLI 与桌面壳共用的唯一启动实现。 | [`lib.rs`](../../native/crates/guanlan-service/src/lib.rs) |
| 工作区排他锁 | `acquire_workspace_lock` 在 `<数据目录>/service.lock` 上取 OS 级排他锁（Windows `LockFileEx`、Unix `flock`）。占用判定只看锁，不看文件内容；pid 与取锁时间写进 `service.lock.info`，仅供诊断。 | [`runtime/mod.rs`](../../native/crates/guanlan-service/src/runtime/mod.rs) |
| 数据目录 | `default_data_dir` 解析为 `<base>/<rootKey>`。`base` 是 `GUANLAN_DATA_DIR`（整体替换，不是追加）或 `%LOCALAPPDATA%\Guanlan\workspaces`。 | [`storage/mod.rs`](../../native/crates/guanlan-core/src/storage/mod.rs) |
| 唯一写线程 | `IndexJobManager` 持有进程里唯一一条可写连接，线程名 `guanlan-index-writer`。所有写库都排队到这里，见[索引](indexing.md)。 | [`index_jobs.rs`](../../native/crates/guanlan-service/src/index_jobs.rs) |
| 通知中枢 | `NoticeHub` 是容量 64 的 broadcast 通道；写线程经 `SseNotice` 投递，`notice_seq` 是与业务 `events.seq` 无关的传输层序号。桥线程名 `guanlan-notice-bridge`。 | [`runtime/mod.rs`](../../native/crates/guanlan-service/src/runtime/mod.rs) |
| 只读连接池 | 启动时开 `pool_size_from_env()` 条独立只读连接（默认 4），每条各自认领同一工作区行。`ReadonlyStore` 没有任何写方法。 | [`query_exec.rs`](../../native/crates/guanlan-service/src/http/query_exec.rs)、[`storage/mod.rs`](../../native/crates/guanlan-core/src/storage/mod.rs) |
| 监听地址 | 写死 `127.0.0.1`，`port = 0` 时由内核分配。没有改成监听其他地址的开关。 | [`lib.rs`](../../native/crates/guanlan-service/src/lib.rs) |
| 标准输出约定 | `run_serve` 只向 stdout 打一行 `GUANLAN_ENDPOINT=http://127.0.0.1:<port>`，其余诊断全走 stderr。启动器与 MCP 代理都靠这一行拿到权威端口。 | [`main.rs`](../../native/crates/guanlan-service/src/main.rs) |
| 实例身份 | `generate_instance_id` 由 pid、纳秒时钟、端口与根目录派生出 `inst_` 加 16 位十六进制。 | [`runtime/mod.rs`](../../native/crates/guanlan-service/src/runtime/mod.rs) |
| 静态资源 | `resolve_dist_dir` 取 `GUANLAN_DIST_DIR` 或可执行文件同级的 `dist/`；目录存在才挂载，否则非 `/api` 路径返回 404 包络。 | [`runtime/mod.rs`](../../native/crates/guanlan-service/src/runtime/mod.rs)、[`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs) |
| 多项目并存 | `ProjectHub` 管理多个 `ProjectRuntime`，每个项目有自己的数据目录、锁、写线程与连接池。项目表在 `projects.json`（`default_projects_file_path`）。 | [`projects.rs`](../../native/crates/guanlan-service/src/projects.rs) |
| 只读挂载 | `MountRegistry` 以只读方式打开参考工作区，状态在主区数据目录的 `mounts.json`。 | [`mounts.rs`](../../native/crates/guanlan-service/src/mounts.rs) |
| 桌面壳跨源 | `build_router_with_desktop_cors` 只为 `tauri.localhost` 与本机开发端口放行 CORS。CLI 模式用 `build_router`。 | [`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs) |
| 停机 | `RunningService::shutdown` 关闭通知中枢、触发 axum 优雅停机，再由 `ProjectHub::shutdown_all` 逐个释放锁、写线程与监听。 | [`lib.rs`](../../native/crates/guanlan-service/src/lib.rs)、[`projects.rs`](../../native/crates/guanlan-service/src/projects.rs) |

## 运行路径

### 启动

`guanlan serve --root <目录> [--port N] [--watch]` 进入 `run_serve`，以 `cors_desktop: false`、`background_index: watch` 调用启动流程。桌面壳以 `cors_desktop: true`、`background_index: true` 调用同一个函数。

1. 校验 `--root` 是目录，否则 `NOT_FOUND`。
2. 解析数据目录；对主区根做 `normalize_mount_root`，作为挂载互斥的基准。
3. 取工作区锁。被占用返回 `ROOT_IN_USE`。
4. `Writer::open_at` 打开或创建可写库：先过 schema 版本门禁，再跑迁移与备份，见[存储](storage.md)。
5. 建通知中枢与桥线程，`IndexJobManager::start_with_options` 把写连接移进写线程。
6. 开只读连接池并认领工作区行。库里登记的 `root_key` 与请求的不一致时只在 stderr 告警，不拒绝服务。
7. 绑定 `127.0.0.1`，再由实际端口生成实例身份。
8. 装配 `AppState` 与路由。
9. 仅当 `background_index` 为真：启动 watcher，先把上一轮遗留的 queued / running 任务重新入队（`recover_from_job_runs`），再入队一次 `VerifyAll`。为假时不扫描、不监听，只提供既有数据的读取与写回端点。

CLI 最后打印端点行并 `join`。桌面壳持有 `RunningService`，切换或退出时调用 `shutdown`。

### 一次读请求

处理器调用 `run_query`，经 `AppState::active_exec()` 拿到激活项目的执行器，再进 `QueryExecutor::run`：

1. **准入**：排队数达到 `max_waiters`（`GUANLAN_QUERY_MAX_QUEUE`，默认 64）立即返回 `INDEX_BUSY`。
2. **排队**：等许可最多 `wait_deadline`（`GUANLAN_QUERY_WAIT_MS`，默认 5000 毫秒），超时同样 `INDEX_BUSY`。
3. **取连接**：许可数等于连接数，拿到许可必有一条连接。
4. **安装取消守护**：响应 future 被丢弃（客户端断开）时 `CancelGuard` 调 `interrupt`；progress handler 同时检查取消标志与 `exec_deadline`（`GUANLAN_QUERY_EXEC_MS`，默认 30000 毫秒）。
5. **阻塞任务**：刷新缓存的 `index_generation`，在 `catch_unwind` 里执行查询体，归池清理后先还连接、再放许可。

查询体在 `ReadonlyStore::read_txn` 的同一个 DEFERRED 读事务里执行，多条 SELECT 落在同一一致性视图上。

### 一次写命令

需要写库的端点不直接碰库：处理器调用 `active_jobs()` 上的 `execute_file_op`、`commit_checkpoint`、`run_storage_gc`、`batch_reading_state` 等方法，把命令连同回执通道发给写线程，然后在 `spawn_blocking` 里 `recv_timeout` 等回执。超时返回 `INDEX_BUSY`。后台任务走 `submit_kind`，得到 `job_id` 后由调用方轮询 `/api/v1/jobs/{id}`。

### SSE

`GET /api/v1/stream` 连接即发 `hello`（`instance_id`、`notice_seq`、`index_generation`），之后每条通知作为 `workspace-change` 事件发出，每 15 秒一个 `ping` 注释行保活。慢订阅者被 broadcast 丢弃旧通知时只跳过，不报错。

## 状态

任务只有四态：`Queued`、`Running`、`Completed`、`Failed`。挂起、等待人工这类语义属于任务节点层，见[长任务引擎](longtask-engine.md)。

- **同类合并**：`verify_all` 单飞；`changed_paths` 只并入仍在排队的同类任务，合并后不超过 2000 条；`set_initiative_dirs` 幂等覆盖；其余类型永不合并。
- **取消**是协作式的。排队中的任务立即落到 `Failed`；运行中的任务在阶段间隙停下，同样落到 `Failed` 并标注已取消。事务提交点不可中断。对外的状态在活跃期报 `cancelled`。
- **重启恢复**：`recover_from_job_runs` 读 `job_runs` 表，把上一轮的 queued / running 任务重新入队；请求体无法重建的标为失败。
- **写线程调度**：`writer_loop` 先服务显式命令；没有命令且 L4A 摘要有积压时，每空闲 40 毫秒处理一小批（至多 3 篇），任何交互式命令都能立刻抢占。

## 约束与失败行为

- 只监听回环地址。stdout 只有一行端点约定，新增诊断信息必须走 stderr。
- `background_index` 默认关闭。开启后的启动核验会改写 `last_observed_at` 等观测事实，`smoke-v1` 的 Node ↔ Rust 端点比对依赖「打开已有数据零扫描」这个口径。
- 同一数据目录的第二个实例得到 `ROOT_IN_USE`（409）。进程崩溃留下的锁文件不构成占用，内核随句柄释放锁。
- 只读连接打不开时启动直接失败，不退化为可写连接；`user_version` 不在 `{0, 1, 2}` 内同样拒绝打开。
- 饱和一律是 `INDEX_BUSY`（503）并带 `Retry-After: 2`：队列满、排队超时、响应预算等待超时、写线程回执超时都用它。
- 查询体 panic 不再让连接随任务消失：`catch_unwind` 接住后丢弃该连接、重建并重新认领工作区，对外返回 500（issue #36）。
- 内联正文受响应字节预算约束，见[查询接口](query-api.md)。
- `projects.json` 与 `mounts.json` 损坏或缺失都按空表起步，不阻断启动。某个项目遇 `ROOT_IN_USE` 或目录缺失时只是该项目离线，不拖垮其他项目。

## 验证

```sh
cd native
cargo test --locked -p guanlan-service --lib -- lifecycle_tests runtime::tests
cargo test --locked -p guanlan-service --lib -- bounded_executor_saturates_deterministically cancel_releases_capacity_promptly panicking_query_is_contained_and_pool_recovers generation_cached_for_error_envelope_on_first_request
cargo test --locked -p guanlan-service --lib -- response_budget
cargo test --locked -p guanlan-service --lib -- multi_project_hub_end_to_end_lifecycle
cargo test --locked -p guanlan-service --lib -- background_index_false_keeps_readonly_zero_scan_contract
cargo test --locked -p guanlan-service --test v03_l4a_and_decisions_ssot
```

`cargo test` 在 `native/` 下执行才会用上 `rust-toolchain.toml` 锁定的工具链。这些测试会启动真实服务并写工作区数据目录；跑之前把 `GUANLAN_DATA_DIR` 指到临时目录，否则写的是本机真实的数据目录。
