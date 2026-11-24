# 工作区写入

观澜对外承诺「不写入、不移动用户的业务文件」，但这不是绝对的。有六条路径会写用户的文件，每一条都带护栏：乐观并发、路径沙箱、人工确认、回收站而非删除、原稿留档。新增任何会写用户文件的路径，都必须挂上同一套护栏。

## 职责与事实来源

| 路径 | 写什么 | 执行位置 | 出处 |
| --- | --- | --- | --- |
| 文件与文件夹操作 | 重命名、移动、新建文件夹与文档、移入回收站 | 唯一写线程，经 `FileOpCommand`、`FolderOpCommand`、`BatchFileOpCommand` | [`index/file_ops.rs`](../../native/crates/guanlan-core/src/index/file_ops.rs) |
| 决策拍板回写 | 就地把 `[P1 - 待确认]` 改成已确认并填上确认人与日期 | 唯一写线程，`JobKind::DecisionWriteback` | [`index/writeback.rs`](../../native/crates/guanlan-core/src/index/writeback.rs) |
| 智能体草案采纳 | 用草案内容替换工作树里的正式定稿 | 唯一写线程，`JobKind::AdoptDraft` | [`index_jobs.rs`](../../native/crates/guanlan-service/src/index_jobs.rs) 的 `execute_adopt` |
| MCP 宿主配置 | 在工作区根写 `.mcp.json` 或 `.cursor/mcp.json` | HTTP 处理器 `mcp_host_config`，直接落盘 | [`http/mod.rs`](../../native/crates/guanlan-service/src/http/mod.rs) |
| 桌面壳保存回写 | 决策回执表单保存 | Tauri 命令 `save_workspace_file` | [`guanlan-desktop/src/main.rs`](../../native/crates/guanlan-desktop/src/main.rs) |
| 外部文件导入 | 把工作区外的文件复制进工作区内的指定目录 | Tauri 命令 `import_external_files` → `import_external_files_impl` | [`guanlan-desktop/src/system_bridge.rs`](../../native/crates/guanlan-desktop/src/system_bridge.rs) |

提交草案（`JobKind::ProposeRevision`）**不写工作树**：它只把内容存成独立的草案分支，等人采纳。

## 运行路径

### 文件与文件夹操作

1. HTTP 处理器先过两道检查：`require_active_writable`（项目开了只读保护则 403）与 `cross_write_preflight`（文件属于只读挂载区则 403）。
2. 命令发给写线程。`execute_relocate` 校验源与目标都在工作区内（拒绝 `..`、绝对路径、盘符、冒号、控制符、Windows 保留名、隐藏目录、排除目录与逃逸的符号链接），然后 `std::fs::rename`。
3. 磁盘成功后，在同一个写事务里更新 `files`（保留原 `file_id`）、登记新旧两个 `path_aliases`、写 `file_renamed` 或 `file_moved` 事件、重算状态机、推进代际。数据库事务失败时把磁盘路径改回去。
4. 删除只有一种实现：`trash_file_with` 要求 `confirm = true`，然后交给 `TrashDriver`。Windows 用 COM `IFileOperation` 并带 `FOFX_RECYCLEONDELETE`，回收站不可用时失败而不永久删除。从回收站还原后，下一轮对账经别名或同哈希候选重新接回原 `file_id`。

事件时间戳由 `monotonic_now_iso` 生成，严格单调递增。同一毫秒内连续操作曾因事件身份碰撞被静默丢弃。

### 决策拍板回写

`apply_decision_writeback` 自管事务边界，调用方不得再包一层事务。

1. `ensure_not_archived`：已归档的文档同步拒绝。
2. `resolve_workspace_file_in_jail`：磁盘路径必须仍在工作区内，且不经过符号链接。
3. **CAS**：磁盘内容的哈希必须等于该文件的最新版本哈希。
4. CAS 失败时不写文件。把「本来想写的内容」存成 `conflict = 1` 的草案并发 `proposal_raised` 事件；任务本身仍是 `completed`。
5. CAS 通过才原地替换，随后走 `reconcile_paths` 产生新版本、重新派生陈述、发 `decision_changed` 与 `decision_writeback` 事件、重算状态机。

### 草案采纳

`execute_adopt` 的顺序是固定的：

1. `ensure_not_archived` 与沙箱校验。
2. 严格 CAS：磁盘哈希必须等于草案的基准哈希。冲突时把草案标为 `conflict = 1` 并中止，绝不覆盖人工编辑。草案内容与磁盘相同时只关闭草案，不造空版本。
3. **先把磁盘原稿的字节写进 `blobs/` 留档**，再动工作树。
4. `write_workspace_file`：写临时文件、重读校验哈希、同卷改名。
5. `reconcile_paths` 推进正式版本号，按 `input_context_hashes` 写 `derived_from_context` 因果边（至少有一条指向基准版），把草案标为 `adopted`，并提交自动检查点。

### MCP 宿主配置

`POST /api/v1/mcp/host-config` 只认三个宿主：`zcode`、`claude_code`、`cursor`。端点只接受 `127.0.0.1` 或 `localhost`。`dry_run = true` 只返回合并结果；落盘必须带 `confirm = true`。写入的是 `mcpServers.guanlan` 一个条目加本地的 `GUANLAN_ENDPOINT`，不注入任何密钥。已有文件解析失败或根节点不是对象时返回 `CONFLICT` 并中止，不覆盖损坏的或人工编辑的配置。落盘走临时文件加改名。

### 桌面壳保存回写

`save_workspace_file_impl`：校验相对路径（拒绝绝对路径与 `..`）→ 读磁盘内容并与前端展示时的原文比对（CRLF 归一后比较，避免换行差异误报冲突）→ 不一致返回 `CONFLICT` 且不落任何字节 → 一致则写临时文件再原子改名。项目开了只读保护时返回 `CROSS_WORKSPACE_FORBIDDEN`。

### 外部文件导入

目标目录必须是工作区内的相对目录。文件先写成同目录的 `.tmp` 再原子改名；同名冲突自动改名为 `stem (1).ext`，不覆盖既有文件。导入成功后立即提交一次 `ChangedPaths` 任务，不等监听防抖。

## 护栏一览

| 护栏 | 拦什么 | 哪些路径有 |
| --- | --- | --- |
| `require_active_writable` | 开了只读保护的项目 | 文件操作、文件夹操作、批量操作、新建文档、桌面壳保存回写 |
| `cross_write_preflight` | 属于只读挂载区的文件 | 单文件的重命名、移动、回收站与批量操作 |
| `ensure_not_archived` | 已归档的文档 | 拍板回写、提交草案、采纳草案 |
| 沙箱（词法 + 磁盘） | 越出工作区、经过符号链接的路径 | 全部写路径 |
| CAS | 覆盖人工编辑 | 拍板回写、草案采纳、桌面壳保存回写 |
| `confirm = true` | 未经确认的破坏性操作 | 移入回收站、写 MCP 宿主配置 |
| 回收站而非删除 | 永久丢失文件 | 全部删除操作 |
| 原稿留档 | 采纳后无法回滚 | 草案采纳 |

**只读保护目前只覆盖文件与文件夹操作。** 拍板回写、草案采纳与 MCP 宿主配置三个端点没有调用 `require_active_writable`，在开了只读保护的项目里仍然会写文件。

## 约束与失败行为

- **严禁对用户工作区文件调用任何永久删除 API。** `remove_file` 与 `remove_dir_all` 只用于清理观澜自己写的临时文件。
- **冲突绝不静默覆盖。** 任何 CAS 失败都不写文件，并把冲突细节放进任务报告或返回码。
- **磁盘成功而数据库失败时要把磁盘改回去**，不让索引与磁盘分叉。
- **`file_id` 不因重命名或移动而裂变。** 历史版本、决定与阅读进度靠它保持连续。
- **预览不产生副作用。** `dry_run` 的任何形态都只读。
- **写盘永远是临时文件加原子改名**，并在改名前重读校验。
- 参考工作区（只读挂载）零写入。主区与挂载区之间禁止移动与跨库写入，只允许只读引用。

## 验证

```sh
cd native
cargo test --locked -p guanlan-core --lib -- index::file_ops index::writeback
cargo test --locked -p guanlan-desktop --bin guanlan-desktop -- save_workspace_file_tests
cargo test --locked -p guanlan-service --lib -- http::longtask_tests
cargo test --locked -p guanlan-service --lib -- http::tests::quiet_md_folder_ops
```

`longtask_tests.rs` 用真实写线程跑完整链路，`e02_concurrent_human_edit_blocks_adopt_via_cas_without_losing_any_character` 是 CAS 护栏的端到端守卫。`e03_mcp_host_config_merges_existing_servers_and_rejects_remote_endpoint` 守宿主配置的合并与回环限制。
