# 长任务引擎

长任务引擎让一份跨天推进的工作在观澜里有确定的形态：文档归入专项与阶段，卡点块变成带优先级的决定，执行进度由五槽位与 checkpoint 表达，需要人工的地方把任务挂起。它由三层组成：存储里的七张表、一组无 IO 的纯函数规则、以及把它们落到库里的执行器。状态机规则在 TypeScript 侧有一份镜像，见[前端规则与跨语言镜像](frontend-rules.md)。

## 职责与事实来源

| 部分 | 职责 | 出处 |
| --- | --- | --- |
| 领域模型 | `Initiative`、`Artifact`、`DecisionItem` 与 `DecisionPriority`。 | [`domain/model.rs`](../../native/crates/guanlan-core/src/domain/model.rs) |
| 状态机规则 | `DocState` 六态、`Stage`、`SlotKind`、`NodeState`、`next_artifact_state`、`slot_state`、`estimate_tokens`。全部是无 IO 的纯函数。 | [`index/state_machine.rs`](../../native/crates/guanlan-core/src/index/state_machine.rs) |
| 状态机执行器 | `state_machine_recompute` 读库内行、算槽位、落状态并记账；`commit_checkpoint` 同步受理 checkpoint。 | [`index/state_engine.rs`](../../native/crates/guanlan-core/src/index/state_engine.rs) |
| 卡点块解析 | `parse_decision_blocks` 把 `[P0/P1/P2 - 待确认]` 块解析成 `DecisionBlock`。 | [`index/decision_block.rs`](../../native/crates/guanlan-core/src/index/decision_block.rs) |
| 候选事项 | `weave_candidates` 用四类信号把散落文件织成候选簇，只产出候选与证据。 | [`domain/candidate_weaver.rs`](../../native/crates/guanlan-core/src/domain/candidate_weaver.rs) |
| 修订草案 | `evaluate_proposal_cas`、`draft_version_label`、`build_derived_context_edges`。 | [`application/proposals.rs`](../../native/crates/guanlan-core/src/application/proposals.rs) |
| 批阅看板 | `classify_board_bucket` 与 `query_review_board`、`repair_orphan_node`。 | [`application/review_board.rs`](../../native/crates/guanlan-core/src/application/review_board.rs) |
| 上下文组装 | `assemble_context` 按 `document`、`initiative`、`global` 三种意图组装 Token 预算感知的上下文包。 | [`application/context.rs`](../../native/crates/guanlan-core/src/application/context.rs) |
| 资料胶囊 | `preview_capsule` 与 `export_capsule` 两阶段导出离线包。 | [`application/capsule.rs`](../../native/crates/guanlan-core/src/application/capsule.rs) |
| 语义 diff | `compute_diff` 的行级 LCS 与分节，单版上限 2000 行。 | [`application/diff.rs`](../../native/crates/guanlan-core/src/application/diff.rs) |
| 只读查询 | 陈述、checkpoint、任务节点、草案、摘要、恢复上下文。 | [`query/longtasks.rs`](../../native/crates/guanlan-core/src/query/longtasks.rs)、[`query/resume.rs`](../../native/crates/guanlan-core/src/query/resume.rs) |
| 写线程执行体 | `execute_propose`、`execute_adopt`、`execute_archive`、`execute_reopen`、`execute_dismiss` 与候选事项的采纳、否决、剔除。 | [`index_jobs.rs`](../../native/crates/guanlan-service/src/index_jobs.rs) |

## 状态

### 文档与专项的六态

`Draft` → `PendingReview` → `ApprovedRevision` → `Executing` → `Delivered` → `Archived`。`next_artifact_state` 一次只走一步，`advance_to_fixpoint` 最多走 6 步并返回**每一单步**。

| 从 | 到 | 条件 |
| --- | --- | --- |
| `Draft` | `PendingReview` | 未决的 P0 或 P1 大于 0 |
| `PendingReview` | `ApprovedRevision` | P0 与 P1 都为 0，且有已选定的版本 |
| `ApprovedRevision` | `Executing` | 执行槽或交付槽正在运行 |
| `Executing` | `Delivered` | 清单非空且全部完成、无阻塞级未决、执行槽与交付槽都已完成 |
| `Executing`、`Delivered` | `PendingReview` | 出现新的阻塞级未决。这是唯一的逆向边，优先于正向边 |
| `Delivered` | `Archived` | 用户验收，或距最近活动超过 30 天（`ARCHIVE_AFTER_IDLE_DAYS`） |

`Archived` 是终态，离开它的唯一方式是写侧显式的 reopen。

### 五槽位

每个专项按流水线次序有五个槽位：蓝图与计划是 `Derive`，决策是 `AwaitDecision`，执行是 `Generate`，交付是 `Deliver`。`slot_state` 是声明式的，同样的输入永远得到同样的结果：

- 前置阶段的槽位未完成，本槽 `Queued`。
- `Derive`：没有文档 `Queued`；有文档但没内容 `Running`；有内容 `Completed`。
- `AwaitDecision`：P0 或 P1 未决大于 0 时 `SuspendedOnHitl`；否则有文档即 `Completed`。
- `Generate`：有 SUCCESS checkpoint 才 `Completed`。这是执行槽**唯一**的完成通道。
- `Deliver`：清单非空且全部完成、无未决才 `Completed`。

节点 ID 由 `node_id_of` 从专项 ID、阶段与槽位类型派生，每轮重算得到同一个 ID。**幂等性就是 running 的持久性**：每轮对账用同样的输入重算，running 得以维持，直到完成条件满足。

### 信号从哪来

`StateSignals` 不落持久列，每轮重算，避免双写源。`user_accepted` 的唯一来源是 archive 写线程置位。checklist 计数来自 Markdown 任务列表 `- [ ]` 与 `- [x]`，跳过代码围栏。

### 归属与阶段

`recognize_initiative`：路径首段目录名形如 `^\d{2}-`、包含「专项」，或登记在 `initiative_dirs` 里，就算一个专项。`initiative_id` 是 `init_` 加首段目录名的稳定键。`stage_from_path` 按关键词短路匹配，次序是决策、计划、交付、蓝图、执行、待分类。

## 运行路径

### 每轮对账收尾的重算

对账事务提交之后、代际判定之前，`state_machine_recompute` 对**全部专项**做三件事：重算五槽位、推进专项与文档的状态、为每一次迁移写事件。

**首次落库是静默的**：`initiatives`、`artifact_states`、`task_nodes` 没有既有行时，第一次写入不发迁移事件、不计入变化、不推进代际。迁移记账只发生在两个已持久状态之间。

### 提交一个 checkpoint

`POST /api/v1/checkpoints` 把 `CheckpointCommit` 命令发给写线程，在一个写事务里完成校验、插行、写事件、槽位推进与重算，返回 201。`node_id` 缺省时按专项与阶段反查槽位。状态只有三种：`SUCCESS`、`FAILED_RETRYABLE`、`SUSPENDED_HITL`。

### 恢复上下文

`resume_context` 取最近一次 SUCCESS checkpoint，列出此后产生新版本的文件，再附上该专项每个决定的最新结果。没有 SUCCESS checkpoint 时 `checkpoint` 为空、增量列表为空，但决定照常返回，提示文本写明「无可用 checkpoint」，不伪造增量。引擎不组装也不注入外部智能体的提示词，只产出可以直接注入的文本与结构化字段。

### L4A 摘要

摘要是确定性的本地计算，不调用任何模型：核心摘要、大纲、决定摘要。`summary_jobs` 排队，写线程空闲时每批至多 3 篇。单条摘要至多重试 3 次，超过就标为失败，避免缺失快照或频繁改写把队列卡在 0%。

## 约束与失败行为

- **有待批阅的草案或未决的 P0 / P1 时，绝不跳过人工审阅直接完结。** 批阅看板的分类器有测试守着这条。
- **人工修复只有两个动作**：`reset_to_dispatchable` 与 `mark_suspended_hitl`。没有任何直接完结或强制完成的动作。
- **失联的节点如实标为 `unknown`。** 默认 30 分钟（`DEFAULT_ORPHAN_STALL_SECS`）没有新回执即视为失联，不粉饰为已办结或运行中。
- **候选事项从不自动采纳。** 编织器只产出候选与证据，不移动磁盘文件，不写正式归属；采纳与否决由用户显式触发。每条关联都带可解释的证据，不做黑盒打分。
- **草案走独立分支。** 版本标签是 `v(N+1)-agent-draft`，提交草案不碰工作树。采纳时的 CAS 与原稿留档见[工作区写入](workspace-writes.md)。
- **采纳后记录因果边。** 按 `input_context_hashes` 写 `derived_from_context` 边，至少有一条指向基准版，让每次智能体产出都能溯源到「读了哪几份快照、在哪个基线上生成」。
- **上下文包里的密钥绝不外泄。** 敏感凭证路径即使用户显式传入也强制脱敏为 `[REDACTED_SECRET]`；超预算时只给降级建议，不自动截断。
- **Token 估算公式是跨端契约**：`ceil(cjk × 0.7 + non_cjk_bytes / 3.5)`，Rust 的 `estimate_tokens` 与前端的 `contextBudget.ts` 必须同公式，向量文件 `token-vectors.json` 双端同读。
- **胶囊导出是两阶段的。** 先预览拿到 `preview_token`，再带 `confirmed_preview = true` 导出；参数漂移即以 `PREVIEW_REQUIRED` 拒绝。快照缺失时不拿磁盘现态冒充。
- **diff 有预算。** 行级 LCS 每版至多 2000 行，超限标记 `truncated` 并给出分块游标。
- v0 与 v1 的库里没有长任务表。恢复上下文、状态总览与 L4A 进度在这类库上如实返回空，不报「无此表」。

## 验证

```sh
cd native
cargo test --locked -p guanlan-core --lib -- state_machine:: state_engine::
cargo test --locked -p guanlan-core --lib -- review_board:: proposals:: capsule:: resume_tests
cargo test --locked -p guanlan-core --lib -- candidate_weaver::
cargo test --locked -p guanlan-core --lib -- state_machine_first_scan state_machine_transition state_machine_recompute
cargo test --locked -p guanlan-service --lib -- http::longtask_tests
cargo test --locked -p guanlan-service --test v03_l4a_and_decisions_ssot
```

`stage_from_path` 的关键词表与前端并非逐字镜像，两边有意保留的分歧登记在 `stage-vectors.json` 里；`stage_from_path_keeps_registered_divergences` 守着这些分歧不被无意抹平。
