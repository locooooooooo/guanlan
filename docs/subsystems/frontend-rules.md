# 前端规则与跨语言镜像

观澜有九条规则在两种语言里各有一份实现。它们必须给出同样的结果，但**只有三条有自动化的保证**，其余靠人工同步。改任何一条规则之前，先在这张表里找到它的另一侧。

## 跨语言镜像一览

| 规则 | 前端 | 另一侧 | 什么在保证一致 |
| --- | --- | --- | --- |
| 六态状态迁移 | `nextDocState`，[`stateProjection.ts`](../../src/utils/stateProjection.ts) | `next_artifact_state`，[`state_machine.rs`](../../native/crates/guanlan-core/src/index/state_machine.rs) | 没有自动对拍。`test/state-machine-01.test.ts` 与 `src/utils/stateProjection.test.ts` 锁前端的词与规则，Rust 侧有自己的穷举单测。改规则必须两侧同步。 |
| Token 估算 | `estimateTokensFromText`，[`contextBudget.ts`](../../src/utils/contextBudget.ts) | `estimate_tokens`，[`state_machine.rs`](../../native/crates/guanlan-core/src/index/state_machine.rs) | 共享向量 [`token-vectors.json`](../../native/testdata/token-vectors.json)：TS 用 `readFileSync` 读，Rust 用 `include_str!` 编译期读。 |
| 阶段分类 | `stageOfPath`，[`taskPackages.ts`](../../src/utils/taskPackages.ts) | `stage_from_path`，[`state_machine.rs`](../../native/crates/guanlan-core/src/index/state_machine.rs) | 共享向量 [`stage-vectors.json`](../../native/testdata/stage-vectors.json)。两套实现的规则**有意存在分歧**，分歧登记在向量文件里；`stage_from_path_keeps_registered_divergences` 与 `test/stage-classify-01.test.ts` 各自守着。要收敛分歧，先改向量文件，再两侧同步实现。 |
| 卡点块解析 | `parseDecisionBlocks`，[`decisionBlocks.ts`](../../src/utils/decisionBlocks.ts) | `parse_decision_blocks`，[`decision_block.rs`](../../native/crates/guanlan-core/src/index/decision_block.rs) | 没有对拍。各自的测试覆盖。标记正则、字段行与选项行的口径必须一致。 |
| 未读判定 | `hasUnreadChanges`，[`guanlanEngine.ts`](../../src/utils/guanlanEngine.ts) | 服务端只存 `reading_states` 基线，不做比较 | 不是镜像，是分工：服务端记 `last_read_revision_id`，前端拿它和 `current_revision_id` 比较。 |
| 密钥脱敏 | `isSensitiveSecretPath`、`sanitizeContextText`，[`contextSanitizer.ts`](../../src/utils/contextSanitizer.ts) | `is_sensitive_secret_path`、`sanitize_context_text`，[`context.rs`](../../native/crates/guanlan-core/src/application/context.rs) | 没有对拍。两套独立实现的敏感路径清单与密钥片段规则。新增一种密钥形态要两侧都加。 |
| 全文检索 | `searchWorkspace`，[`guanlanEngine.ts`](../../src/utils/guanlanEngine.ts) | `search_index.rs` 与 `search_tokens.rs` | 独立实现，口径本就不同：前端是本地二元分词，服务端是混合倒排索引。 |
| 响应 DTO | `apiTypes.ts` | `dto.rs` | 手工镜像，见[查询接口](query-api.md)。 |
| 身份公式 | 旧 Node 的 `rootKeyOf`（[`server/WorkspaceStore.ts`](../../server/WorkspaceStore.ts)）与 `stableFileId`、`revisionIdOf`（[`server/reconcile.ts`](../../server/reconcile.ts)） | `root_key_of`、`stable_file_id`、`revision_id_of`，[`domain/mod.rs`](../../native/crates/guanlan-core/src/domain/mod.rs) | `scripts/parity-reconcile.ts` 逐表对拍，加 `identity-vectors.json`，见[旧 Node 管线与对拍](legacy-node-pipeline.md)。 |

## 各条规则的要点

### 六态状态迁移

`nextDocState` 是 Rust `next_artifact_state` 的逐字镜像：先判逆向回流边（执行中或已交付出现新的阻塞级未决就回到待确认），再按当前态走正向边。`Archived` 恒返回 `null`。信号里的 `exec_slot_completed`、`deliver_slot_completed`、`user_accepted` 是可选的一次性入参。

`DOC_STATE_LABEL`、`DOC_STATE_STAGE`、`STAGE_DOC_STATE`、`TASK_NODE_STATE_LABEL`、`DECISION_STATUS_*`、`STATEMENT_STATUS_LABEL` 是前端唯一的状态词表出口。专项卡片、专项详情、星图节点、文档顶栏一律从这里取词，禁止自造状态文案。`projectInitiativeState` 与 `projectArtifactState` 是双层投影：有服务端 `/state-overview` 就采信，没有就按本地阶段回退，未决计数如实为 `null`，不拿 `0` 冒充已对账。

### Token 估算

冻结公式：`est_tokens = ceil(cjk_chars × 0.7 + non_cjk_bytes / 3.5)`。CJK 码位区间写死为 U+3000–U+303F、U+4E00–U+9FFF、U+F900–U+FAFF、U+FF01–U+FF5E。阈值 65536。这是一个 ±20% 量级的启发式，只用来判阈值，不冒充精确值。

注入粒度因子：全文 1、摘要 0.2、仅变更 diff 0.15、仅元数据 0.02、仅决策 0.05。

### 未读判定

三态，只比较版本身份，O(1)：没有阅读基线是 `never_read`；`last_read_revision_id` 等于 `current_revision_id` 是 `up_to_date`；否则是 `updated_since_last_read`。章节级细节按需由 `computeChangedSectionsSinceRead` 另算。

这条规则是一次性能修复的产物：此前基线落后的文件每次统计都跑全文二维 LCS，2200 份文件就是 2200 次。

### 工具噪声过滤

`isToolNoisePath`（[`documentIdentity.ts`](../../src/utils/documentIdentity.ts)）把运行产物、长十六进制与 UUID 段、`run-<8 位以上数字>` 一类路径排除出任务包与智能视图。它决定列表计数、徽标数与画布过滤是否守恒。

### Diff 预算

超限一律**明确拒绝**，不静默截断，不拿空结果冒充「无变化」：

- `computeMarkdownDiff`：每侧至多 20000 行，动态规划至多 400 万格，超限返回 `DIFF_TOO_LARGE`。
- [`multimodalDiff.ts`](../../src/utils/multimodalDiff.ts)：`lcsMatchedPairs` 至多 250 万格；SVG 每侧至多 1500 个形状；表格每侧至多 1000 行、4000 条单元格明细。
- 服务端的语义 diff 是另一套预算，见[长任务引擎](longtask-engine.md)。

### 任务包归组

[`taskPackages.ts`](../../src/utils/taskPackages.ts)：每个路径按 G1 → G2 → G3 → G5 恰好落入一个任务包；工具噪声不参与；阶段按「文件名关键词 > 容器目录 > 未分类」判定。五个智能视图在一次遍历里派生，列表计数、顶部徽标数与画布过滤节点数恒等。

### 零捏造

- 版本内容：旧版本快照拿不到就明说，拒绝用当前磁盘内容冒充。
- 摘要与指纹：`packageFingerprint.ts` 的火花图与格式缎带只来自真实版本。
- 阅读岛：从未读过的文件不计入「离开后有变化」，也从不被置灰。

## 约束

- **纯函数模块不得导入 `.css` 或 React。** `stateProjection.ts`、`decisionBlocks.ts`、`multimodalDiff.ts`、`chronosDigest.ts`、`contextBudget.ts` 都要在 node 测试里直接可导入。
- **对 `apiTypes.ts` 只做类型导入**，编译期擦除，避免与 services 层形成运行时回环。
- **`contextSanitizer.ts` 绝不读取 `process.env` 或任何宿主环境变量**，只做确定性的文本与路径检测。
- **改镜像规则时，同一改动里两侧一起改**，并在提交说明里写明另一侧改了什么。
- `DOC_STATE_STAGE` 与 `STAGE_DOC_STATE` 两张映射表是裁定值，文档六态与既有五阶段没有同构映射，待确认。

## 验证

```sh
node node_modules/tsx/dist/cli.mjs --test test/state-machine-01.test.ts src/utils/stateProjection.test.ts
node node_modules/tsx/dist/cli.mjs --test test/context-budget-01.test.ts test/stage-classify-01.test.ts
node node_modules/tsx/dist/cli.mjs --test src/utils/guanlanDiffBudget.test.ts src/utils/multimodalDiff.test.ts
node node_modules/tsx/dist/cli.mjs --test test/listfix-core-filter.test.ts test/smart-views.test.ts
```

`context-budget-01` 与 `stage-classify-01` 直接读 `native/testdata/` 下的两份向量文件，所以 `npm test` 依赖仓库里的 `native/testdata` 目录。要新增一条双端规则，先把向量写进共享文件，再让两侧的测试都读它。
