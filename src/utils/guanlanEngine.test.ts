import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RightInspector } from '../components/RightInspector';
import {
  buildLocalRelationGraph,
  buildNodeHoverPreviewData,
  computeDynamicEdgePath,
  computeFanOutBounds,
  computeMarkdownDiff,
  detectRollbackRevision,
  evaluateDecisionPhraseSemantics,
  executeMcpTool,
  findDecisionsByCode,
  formatContextForAgent,
  generateChineseBigrams,
  getActionablePendingDecisions,
  hasUnreadChanges,
  sanitizeSvgForPreview,
  searchWorkspace,
  unreadStatusLabel,
  validateRootBoundary,
} from './guanlanEngine';
import type {
  DecisionAssertion,
  FileRecord,
  ReadingState,
  RelationEdge,
  TimelineEvent,
  WorkspaceConfig,
} from '../types/guanlan';

// ============================================================
// 本地自建测试夹具：等价迁移自已删除的演示数据文件 src/data/sampleWorkspace.ts。
// 生产代码已删除样本回退（App.tsx 在接口失败时展示空态与错误横幅），
// 测试不得再 import 生产演示数据；以下夹具仅供本测试文件构造等价输入，
// 内容与原样本逐字一致，保证既有断言行为不变。
// ============================================================
export const INITIAL_WORKSPACE_CONFIG: WorkspaceConfig = {
  rootPath: 'C:\\Users\\34689\\Downloads\\拥抱AI',
  rootKey: 'ws_yongbao_ai_9f3a2c',
  dataDirPath: '%LOCALAPPDATA%/Guanlan/workspaces/ws_yongbao_ai_9f3a2c/',
  excludedDirs: [
    'node_modules',
    '.git',
    '.venv',
    '.playwright*',
    'dist',
    'build*',
    'runtime',
    'releases',
    'backups',
    'tmp',
    '_软件安装包',
    '_spike',
  ],
  disableGitIgnore: true,
  gitIgnoreWarning:
    '源目录 .gitignore 第 24 行包含无法被 rg 解析的扩展通配模式 (**/[!a-z0-9_-)；观澜已按附录 A 启用显式排除规则并禁用 Git ignore，避免静默漏扫文件。',
  enumSnapshot: {
    date: '2026-11-05',
    mdCount: 373,
    svgCount: 158,
    pdfCount: 35,
    totalCount: 566,
    indexedSuccessCount: 530,
    parseFailedCount: 1,
    pdfUnindexedCount: 35,
  },
  quota: {
    maxTotalMiB: 500,
    usedTotalMiB: 68.4,
    maxSingleBinaryMiB: 20,
    protectedSnapshotsCount: 24,
    evictedSnapshotsCount: 1,
  },
  runtimeStatus: {
    connectionMode: 'magpie_router',
    serviceState: 'monitoring',
    sseSeq: 108,
    indexGeneration: 42,
    activeAgents: ['Claude Code (stdio via Magpie)', 'Cursor Agent (shared router)'],
    loopbackUrl: 'http://127.0.0.1:54182/session/gl_tok_88a1f',
  },
};

export const INITIAL_FILES: FileRecord[] = [
  {
    file_id: 'file_01',
    relative_path: '01-方案文档/四专项待确认事项.md',
    title: '四专项待确认事项',
    format: 'md',
    folder: '01-方案文档',
    role: '决策',
    roleProvenance: '来自正文',
    topics: [
      { name: 'PDM', provenance: '来自正文', rule: '显式章节 §1 PDM 主数据与编码专项' },
      { name: '办公协同', provenance: '来自正文', rule: '显式章节 §2 办公协同消息路由专项' },
      { name: '知识库', provenance: '来自正文', rule: '显式章节 §3 知识库抽取边界' },
    ],
    current_revision_id: 'rev_01_03',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_01_01',
        file_id: 'file_01',
        versionNumber: 1,
        content_sha256: 'a8f109c3b2049e77103948102938471029384710293847102938471029384701',
        observed_at: '2026-11-04T19:10:00+08:00',
        source_time: '2026-11-04',
        commit_time: '2026-11-04T18:55:12+08:00',
        author_hint: 'Git: zhangwei (commit 4b19d2)',
        sizeBytes: 5420,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '首次扫描建立基线（discovered）',
        markdownContent: `# 四专项待确认事项（第一阶段汇总）

文档日期：2026-11-04  
所属项目：拥抱AI · 第一阶段专项治理  
关联任务号：T-204、T-208

## 核心结论

1. 四专项当前共梳理出 3 项显式待确认问题（Q01、Q02、Q03），均已整理选项与推荐意见，但**推荐不等于已批准**。
2. 基础核对与历史台账清洗工作**不依赖**正式规则冻结，各专项组应继续推进存量核对，不得因單项“待确认”扩大为全专项停工。

## 需你决策

### Q01：PDM 物料编码一物多码历史过渡期规则
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q01
- **当前状态**：待确认
- **选项 A**：立即冻结旧编码新增权限，存量 BOM 在 14 天内强制切换新码。
- **选项 B**：保留 30 天双轨映射窗口，ERP 接口按对照表自动路由（架构组推荐）。
- **推荐及理由**：推荐采用选项 B（仅作架构组建议，尚未获业务负责人签批）。理由见 [PDM编码与BOM主数据方案](02-PDM专项/PDM编码与BOM主数据方案.md) 及流程图 [PDM与BOM双轨映射图](assets/pdm-bom-flow.svg)。
- **影响与等待范围**：仅阻断“ERP 正式冻结开关上线”；**不阻断**存量物料台账核对与测试环境联调。

### Q03：跨部门知识库 PDF 图纸涉密分级默认策略
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q03
- **当前状态**：待确认
- **选项 A**：未标记密级的历史 PDF 默认按“内部受限”隔离，仅检索文件名。
- **选项 B**：默认全量抽取正文进入公共检索池。
- **推荐及理由**：推荐采用选项 A，依据见 [集团主数据安全红线2026.pdf](docs/集团主数据安全红线2026.pdf)。
- **影响与等待范围**：仅影响历史未标密 PDF 的全文索引入库，不影响 Markdown 方案文档检索。

## 附录：历史代码示例（非当前决策）

\`\`\`markdown
# 模板示例：以下仅作格式示范，不代表验收通过
- Q99：示例条目（已确认）—— 仅供编写回执参考，请勿计入实际决策统计。
\`\`\``,
      },
      {
        revision_id: 'rev_01_02',
        file_id: 'file_01',
        versionNumber: 2,
        content_sha256: 'b9d218e4c3150f88214059213049582130495821304958213049582130495802',
        observed_at: '2026-11-05T11:20:00+08:00',
        source_time: '2026-11-05',
        agent_turn_hint: '轮次 #14 · 梳理决策回执引用与冲突说明',
        sizeBytes: 6180,
        snapshotAvailable: true,
        changedSectionsFromPrev: ['核心结论', '需你决策'],
        summaryNote: '补充 Q01 来源冲突说明与 Q02 确认依据引用',
        markdownContent: `# 四专项待确认事项（第一阶段汇总）

文档日期：2026-11-05  
所属项目：拥抱AI · 第一阶段专项治理  
关联任务号：T-204、T-208

## 核心结论

1. 四专项当前共梳理出 3 项显式决策事项（Q01、Q02、Q03）。其中 **Q02 已获明确回执确认**，Q01 存在两份材料状态记录不一致，Q03 仍待确认。
2. 再次强调：**段落中出现“推荐采用”不等于已经批准；“联调通过”不代表验收通过。**
3. 基础核对与历史台账清洗工作**不依赖**正式规则冻结，各专项组继续推进存量核对。

## 需你决策

### Q01：PDM 物料编码一物多码历史过渡期规则
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q01
- **当前状态**：来源不一致（待核对）
- **选项 A**：立即冻结旧编码新增权限，存量 BOM 在 14 天内强制切换新码。
- **选项 B**：保留 30 天双轨映射窗口，ERP 接口按对照表自动路由（架构组推荐）。
- **推荐及理由**：架构组推荐采用选项 B，并在 [PDM编码与BOM主数据方案](02-PDM专项/PDM编码与BOM主数据方案.md) 中按 30 天窗口编写了接口草案；但 [决策回执](01-方案文档/决策回执.md) 第 19 行记录供应链周会倾向 14 天窗口。参阅流程图 [PDM与BOM双轨映射图](assets/pdm-bom-flow.svg)。
- **影响与等待范围**：仅影响正式冻结规则阈值配置；**不阻断**存量 BOM 基础核对与 ERP 沙箱验证。

### Q02：SVG 架构图与工艺路线图检索安全策略
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q02
- **当前状态**：已确认
- **确认依据**：见 [决策回执](01-方案文档/决策回执.md) 第 32–39 行（确认人：李工 / 架构委员会，2026-11-05 10:15）。明确采用受限图片模式加载 SVG 并提取文本层检索，禁止直接拼入主 DOM。

### Q03：跨部门知识库 PDF 图纸涉密分级默认策略
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q03
- **当前状态**：待确认
- **选项 A**：未标记密级的历史 PDF 默认按“内部受限”隔离，初始仅检索文件名与元数据。
- **选项 B**：默认全量抽取正文进入公共检索池。
- **推荐及理由**：推荐采用选项 A（待安全办最终会签），依据见 [集团主数据安全红线2026.pdf](docs/集团主数据安全红线2026.pdf) 与 [多格式抽取与索引边界说明](04-知识库专项/多格式抽取与索引边界说明.md)。
- **影响与等待范围**：仅影响历史未标密 PDF 的全文索引入库，不影响 Markdown 方案文档与已知 SVG 文字检索。

## 附录：历史代码示例（非当前决策）

\`\`\`markdown
# 模板示例：以下仅作格式示范，不代表验收通过
- Q99：示例条目（已确认）—— 仅供编写回执参考，请勿计入实际决策统计。
\`\`\``,
      },
      {
        revision_id: 'rev_01_03',
        file_id: 'file_01',
        versionNumber: 3,
        content_sha256: 'c7e329f5d4261a99325160324150693241506932415069324150693241506903',
        observed_at: '2026-11-05T14:32:00+08:00',
        source_time: '2026-11-05',
        agent_turn_hint: '轮次 #15 · 增补影响范围矩阵与任务清单对照',
        sizeBytes: 6690,
        snapshotAvailable: true,
        isBaselineProtected: true,
        changedSectionsFromPrev: ['核心结论', '需你决策', '影响与等待范围明细'],
        summaryNote: '新增“影响与等待范围明细”表格，细化可继续事项与等待冻结事项',
        markdownContent: `# 四专项待确认事项（第一阶段汇总）

文档日期：2026-11-05  
所属项目：拥抱AI · 第一阶段专项治理  
关联任务号：T-204、T-208

## 核心结论

1. 四专项当前共梳理出 3 项显式决策事项（Q01、Q02、Q03）。其中 **Q02 已获明确回执确认**，Q01 存在两份材料状态记录不一致（需架构与供应链对齐），Q03 仍待安全办确认。
2. 再次强调：**段落中出现“推荐采用”不等于已经批准；“联调通过”不代表验收通过。**
3. 基础核对与历史台账清洗工作**不依赖**正式规则冻结，各专项组继续推进存量核对。

## 需你决策

### Q01：PDM 物料编码一物多码历史过渡期规则
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q01
- **当前状态**：来源不一致（待核对）
- **选项 A**：立即冻结旧编码新增权限，存量 BOM 在 14 天内强制切换新码。
- **选项 B**：保留 30 天双轨映射窗口，ERP 接口按对照表自动路由（架构组推荐）。
- **推荐及理由**：架构组推荐采用选项 B，并在 [PDM编码与BOM主数据方案](02-PDM专项/PDM编码与BOM主数据方案.md) 中按 30 天窗口编写了接口草案；但 [决策回执](01-方案文档/决策回执.md) 第 19 行记录供应链周会倾向 14 天窗口。参阅流程图 [PDM与BOM双轨映射图](assets/pdm-bom-flow.svg)。
- **影响与等待范围**：仅影响正式冻结规则阈值配置；**不阻断**存量 BOM 基础核对与 ERP 沙箱验证。

### Q02：SVG 架构图与工艺路线图检索安全策略
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q02
- **当前状态**：已确认
- **确认依据**：见 [决策回执](01-方案文档/决策回执.md) 第 32–39 行（确认人：李工 / 架构委员会，2026-11-05 10:15）。明确采用受限图片模式加载 SVG 并提取文本层检索，禁止直接拼入主 DOM。

### Q03：跨部门知识库 PDF 图纸涉密分级默认策略
- **决策集命名空间**：拥抱AI / 四专项待确认事项 :: Q03
- **当前状态**：待确认
- **选项 A**：未标记密级的历史 PDF 默认按“内部受限”隔离，初始仅检索文件名与元数据。
- **选项 B**：默认全量抽取正文进入公共检索池。
- **推荐及理由**：推荐采用选项 A（待安全办最终会签），依据见 [集团主数据安全红线2026.pdf](docs/集团主数据安全红线2026.pdf) 与 [多格式抽取与索引边界说明](04-知识库专项/多格式抽取与索引边界说明.md)。
- **影响与等待范围**：仅影响历史未标密 PDF 的全文索引入库，不影响 Markdown 方案文档与已知 SVG 文字检索。

## 影响与等待范围明细

| 事项编号 | 关联专项 | 等待确认项 | 阻塞范围（需等待） | 非阻塞范围（可继续推进） |
| --- | --- | --- | --- | --- |
| T-204-A | PDM 专项 | 四专项::Q01 | 生产环境旧编码强制拦截开关 | 存量 1.2 万条物料主数据清洗与映射表核对 |
| T-204-B | 知识库专项 | 四专项::Q02 | 无（已确认） | 158 份 SVG 图纸文本抽取与受限预览接入 |
| T-208-C | 知识库专项 | 四专项::Q03 | 35 份历史 PDF 自动全文入库 | 文件名索引、目录分类及显式引用链构建 |

## 附录：历史代码示例（非当前决策）

\`\`\`markdown
# 模板示例：以下仅作格式示范，不代表验收通过
- Q99：示例条目（已确认）—— 仅供编写回执参考，请勿计入实际决策统计。
\`\`\``,
      },
    ],
  },
  {
    file_id: 'file_02',
    relative_path: '02-PDM专项/PDM编码与BOM主数据方案.md',
    title: 'PDM编码与BOM主数据方案',
    format: 'md',
    folder: '02-PDM专项',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [
      { name: 'PDM', provenance: '来自路径', rule: '路径前缀 02-PDM专项/' },
      { name: 'BOM主数据', provenance: '来自正文', rule: '标题与正文高频术语 BOM 主数据' },
    ],
    current_revision_id: 'rev_02_03',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_02_01',
        file_id: 'file_02',
        versionNumber: 1,
        content_sha256: 'd111111111111111111111111111111111111111111111111111111111111101',
        observed_at: '2026-11-04T20:00:00+08:00',
        source_time: '2026-11-04',
        commit_time: '2026-11-04T19:48:00+08:00',
        author_hint: 'Git: chenlei (commit 90a1c4)',
        sizeBytes: 4890,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: 'V1 基线：30 天双轨过渡期与 BOM 核对规则',
        markdownContent: `# PDM 编码与 BOM 主数据治理方案

文档日期：2026-11-04  
任务编号：T-204  
状态：方案草案（沙箱联调通过，不代表验收通过）

## 核心结论

本方案定义 PDM 与 ERP 之间的物料编码归一规则。针对历史“一物多码”台账，**架构组推荐采用 30 天双轨映射窗口**（对应 [四专项待确认事项](01-方案文档/四专项待确认事项.md) 中的 Q01 选项 B）。

## 1. 双轨映射与流转架构

系统通过中间映射表承接旧编码请求，完整数据流见下图：

- 架构配图：[PDM与BOM双轨映射图](assets/pdm-bom-flow.svg)
- 接口协议依据：[ERP-PDM接口规范-v2.4.pdf](docs/ERP-PDM接口规范-v2.4.pdf)

## 2. 过渡期执行边界

- [x] 完成存量 12,400 条 BOM 父子件关联校验（只读任务列表，点击不回写源文件）
- [ ] 待 Q01 最终批准后，写入生产环境冻结阈值参数
- [x] 输出異常编码清单供业务核对

## 3. 推荐及理由

30 天双轨窗口可覆盖月度结账周期，避免车间在制品工单因旧码突停而报错。注意：本节为技术推荐，最终冻结天数以 [决策回执](01-方案文档/决策回执.md) 正式签批为准。`,
      },
      {
        revision_id: 'rev_02_02',
        file_id: 'file_02',
        versionNumber: 2,
        content_sha256: 'd222222222222222222222222222222222222222222222222222222222222202',
        observed_at: '2026-11-05T13:15:00+08:00',
        source_time: '2026-11-05',
        agent_turn_hint: '轮次 #14 · 临时尝试改为 7 天激进切换参数',
        sizeBytes: 4950,
        snapshotAvailable: true,
        changedSectionsFromPrev: ['核心结论', '3. 推荐及理由'],
        summaryNote: '实验性修改：将过渡期参数临时调整为 7 天（后被回滚）',
        markdownContent: `# PDM 编码与 BOM 主数据治理方案

文档日期：2026-11-05  
任务编号：T-204  
状态：方案草案（沙箱联调通过，不代表验收通过）

## 核心结论

本方案定义 PDM 与 ERP 之间的物料编码归一规则。针对历史“一物多码”台账，**临时测试 7 天激进切换窗口**（正在评估车间影响）。

## 1. 双轨映射与流转架构

系统通过中间映射表承接旧编码请求，完整数据流见下图：

- 架构配图：[PDM与BOM双轨映射图](assets/pdm-bom-flow.svg)
- 接口协议依据：[ERP-PDM接口规范-v2.4.pdf](docs/ERP-PDM接口规范-v2.4.pdf)

## 2. 过渡期执行边界

- [x] 完成存量 12,400 条 BOM 父子件关联校验（只读任务列表，点击不回写源文件）
- [ ] 待 Q01 最终批准后，写入生产环境冻结阈值参数
- [x] 输出异常编码清单供业务核对

## 3. 推荐及理由

7 天激进切换仅用于压力测试评估，存在月结工单中断风险。`,
      },
      {
        revision_id: 'rev_02_03',
        file_id: 'file_02',
        versionNumber: 3,
        // Notice: A -> B -> A! Exact same SHA-256 as rev_02_01 to prove A -> B -> A keeps 3 revisions!
        content_sha256: 'd111111111111111111111111111111111111111111111111111111111111101',
        observed_at: '2026-11-05T14:28:00+08:00',
        source_time: '2026-11-05',
        agent_turn_hint: '轮次 #15 · 恢复旧内容（A → B → A 回滚至 30 天双轨草案）',
        sizeBytes: 4890,
        snapshotAvailable: true,
        isBaselineProtected: true,
        changedSectionsFromPrev: ['核心结论', '3. 推荐及理由'],
        summaryNote: '恢复旧内容（A → B → A）：内容哈希与 v1 一致，保留第 3 次版本出现事件',
        markdownContent: `# PDM 编码与 BOM 主数据治理方案

文档日期：2026-11-04  
任务编号：T-204  
状态：方案草案（沙箱联调通过，不代表验收通过）

## 核心结论

本方案定义 PDM 与 ERP 之间的物料编码归一规则。针对历史“一物多码”台账，**架构组推荐采用 30 天双轨映射窗口**（对应 [四专项待确认事项](01-方案文档/四专项待确认事项.md) 中的 Q01 选项 B）。

## 1. 双轨映射与流转架构

系统通过中间映射表承接旧编码请求，完整数据流见下图：

- 架构配图：[PDM与BOM双轨映射图](assets/pdm-bom-flow.svg)
- 接口协议依据：[ERP-PDM接口规范-v2.4.pdf](docs/ERP-PDM接口规范-v2.4.pdf)

## 2. 过渡期执行边界

- [x] 完成存量 12,400 条 BOM 父子件关联校验（只读任务列表，点击不回写源文件）
- [ ] 待 Q01 最终批准后，写入生产环境冻结阈值参数
- [x] 输出异常编码清单供业务核对

## 3. 推荐及理由

30 天双轨窗口可覆盖月度结账周期，避免车间在制品工单因旧码突停而报错。注意：本节为技术推荐，最终冻结天数以 [决策回执](01-方案文档/决策回执.md) 正式签批为准。`,
      },
    ],
  },
  {
    file_id: 'file_03',
    relative_path: '01-方案文档/决策回执.md',
    title: '决策回执（第一阶段登记簿）',
    format: 'md',
    folder: '01-方案文档',
    role: '决策',
    roleProvenance: '来自路径',
    topics: [
      { name: 'PDM', provenance: '来自正文', rule: '回执登记项 Q01' },
      { name: '知识库', provenance: '来自正文', rule: '回执登记项 Q02、Q03' },
    ],
    current_revision_id: 'rev_03_02',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_03_01',
        file_id: 'file_03',
        versionNumber: 1,
        content_sha256: 'e301010101010101010101010101010101010101010101010101010101010101',
        observed_at: '2026-11-04T21:00:00+08:00',
        source_time: '2026-11-04',
        sizeBytes: 3120,
        snapshotAvailable: false, // 模拟旧的未保护快照已被配额淘汰，用于验证 REVISION_UNAVAILABLE
        summaryNote: '初始回执模板（快照已超保留期淘汰，仅保留版本元数据）',
      },
      {
        revision_id: 'rev_03_02',
        file_id: 'file_03',
        versionNumber: 2,
        content_sha256: 'e302020202020202020202020202020202020202020202020202020202020202',
        observed_at: '2026-11-05T10:30:00+08:00',
        source_time: '2026-11-05',
        commit_time: '2026-11-05T10:28:40+08:00',
        author_hint: 'Git: ligong (commit 77c4e1)',
        sizeBytes: 4210,
        snapshotAvailable: true,
        isBaselineProtected: true,
        changedSectionsFromPrev: ['1. 已登记回执明细', '2. 待对齐冲突项'],
        summaryNote: '正式录入 Q02 架构委员会确认回执，并登记 Q01 供应链周会分歧',
        markdownContent: `# 决策回执（第一阶段登记簿）

文档日期：2026-11-05  
命名空间：拥抱AI / 四专项待确认事项  
关联汇总：[四专项待确认事项](01-方案文档/四专项待确认事项.md)

## 核心结论

本文件为《四专项待确认事项》的唯一受支持决策回执登记源。未在本登记簿签署“已确认”的事项，一律不得视为已获批准。

## 1. 待对齐冲突项（Q01）

### Q01：PDM 物料编码一物多码历史过渡期规则
- **回执状态**：待确认（存在来源分歧）
- **供应链周会纪要摘录**：供应链代表倾向采用 **14 天窗口（选项 A）**，担心 30 天双轨期跨月导致财务成本核算口径分裂。
- **架构组方案摘录**：[PDM编码与BOM主数据方案](02-PDM专项/PDM编码与BOM主数据方案.md) 推荐 **30 天窗口（选项 B）**。
- **处理要求**：在供应链与架构组完成联合会签前，状态保持为“来源不一致 / 待确认”，但存量 BOM 核对正常进行。

## 2. 已确认回执（Q02）

### Q02：SVG 架构图与工艺路线图检索安全策略
- **回执状态**：已确认
- **确认决定**：批准采用受限图片模式渲染 SVG（禁用脚本、外部资源与事件处理器），并提取可识别文本层加入全文索引；无文本层时显式标注“仅文件名可检索”。
- **确认人**：李工（架构委员会主任）
- **确认时间**：2026-11-05 10:15
- **关联架构图**：[观澜单进程架构图](assets/mcp-single-process-arch.svg)`,
      },
    ],
  },
  {
    file_id: 'file_04',
    relative_path: '03-办公协同/协同审批与消息路由方案.md',
    title: '协同审批与消息路由方案',
    format: 'md',
    folder: '03-办公协同',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [
      { name: '办公协同', provenance: '来自路径', rule: '路径前缀 03-办公协同/' },
    ],
    current_revision_id: 'rev_04_01',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_04_01',
        file_id: 'file_04',
        versionNumber: 1,
        content_sha256: 'f401010101010101010101010101010101010101010101010101010101010101',
        observed_at: '2026-11-05T09:40:00+08:00',
        source_time: '2026-11-05',
        sizeBytes: 3980,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '包含独立命名空间下的办公协同 Q03 决策与一条疑似决策',
        markdownContent: `# 协同审批与消息路由方案

文档日期：2026-11-05  
任务编号：T-311  
所属专项：办公协同专项

## 核心结论

定义飞书/企微群机器人的通知折叠策略。请注意本专项拥有独立的决策编号序列，**不得与《四专项待确认事项》中的同名编号 Q03 自动合并**。

## 需你决策

### Q03：移动端审批卡片超时免打扰时段设置
- **决策集命名空间**：拥抱AI / 办公协同专项 :: Q03
- **当前状态**：已确认
- **选项与结论**：已由协同产品负责人王敏于 2026-11-04 确认采用“22:00–08:00 默认静默汇总推送”。
- **影响与等待范围**：仅作用于办公协同消息网关，与知识库 PDF 涉密分级（四专项::Q03）完全无关。

## 讨论记录（疑似决策候选）

> 会议随笔：后续是不是可以考虑把周报汇总也接入同一个 Webhook 通道？目前只是口头探讨，尚未形成正式提案，待下周再看。`,
      },
    ],
  },
  {
    file_id: 'file_05',
    relative_path: '04-知识库专项/多格式抽取与索引边界说明.md',
    title: '多格式抽取与索引边界说明',
    format: 'md',
    folder: '04-知识库专项',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [
      { name: '知识库', provenance: '来自路径', rule: '路径前缀 04-知识库专项/' },
      { name: 'MCP架构', provenance: '来自正文', rule: '正文涉及 SQLite FTS5 与双字切分索引' },
    ],
    current_revision_id: 'rev_05_01',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_05_01',
        file_id: 'file_05',
        versionNumber: 1,
        content_sha256: 'a501010101010101010101010101010101010101010101010101010101010101',
        observed_at: '2026-11-05T12:10:00+08:00',
        source_time: '2026-11-05',
        sizeBytes: 4620,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '规定双字切分检索、PDF 索引状态分离及安全边界',
        markdownContent: `# 多格式抽取与索引边界说明

文档日期：2026-11-05  
任务编号：T-208

## 核心结论

1. **中文检索策略**：采用双字切分（Bigram）生成索引候选，再回到原文校验连续短语；任务号（如 T-204、Q03）走精确匹配，单字检索走有界回退。避免直接使用 SQLite FTS5 trigram 处理“决策”“验收”等两字词导致漏检。
2. **PDF 阅读与检索分离**：不能因中文字符提取失败就直接判定为扫描件。

## 关联资料

- 单进程架构图：[观澜单进程架构图](assets/mcp-single-process-arch.svg)
- 决策追溯关系图：[决策与证据追溯图](assets/decision-trace-graph.svg)
- 安全红线依据：[集团主数据安全红线2026.pdf](docs/集团主数据安全红线2026.pdf)
- 接口规范文档：[ERP-PDM接口规范-v2.4.pdf](docs/ERP-PDM接口规范-v2.4.pdf)`,
      },
    ],
  },
  {
    file_id: 'file_06',
    relative_path: 'assets/pdm-bom-flow.svg',
    title: 'PDM与BOM双轨映射图.svg',
    format: 'svg',
    folder: 'assets',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [
      { name: 'PDM', provenance: '来自正文', rule: 'SVG <text> 包含 PDM 编码归一与 ERP 映射' },
      { name: 'BOM主数据', provenance: '来自正文', rule: 'SVG <text> 包含 BOM 双轨过渡窗口' },
    ],
    current_revision_id: 'rev_06_02',
    coverage: 'svg_text',
    revisions: [
      {
        revision_id: 'rev_06_01',
        file_id: 'file_06',
        versionNumber: 1,
        content_sha256: 'ef06010101010101010101010101010101010101010101010101010101010101',
        observed_at: '2026-11-04T19:12:00+08:00',
        source_time: '2026-11-04',
        sizeBytes: 3420,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '首版 PDM→ERP 映射流程图（未标出 Q01 阈值争议点）',
        svgExtractedTexts: [
          'PDM 设计BOM源头',
          '一物多码映射中间表',
          'ERP 生产工单接口 v2.4',
          '存量台账核对通道（非阻塞）',
        ],
        svgSource: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 340" width="100%" height="100%">
  <rect width="820" height="340" rx="12" fill="#0f172a"/>
  <g stroke="#334155" stroke-width="1.5" fill="#1e293b">
    <rect x="40" y="60" width="200" height="90" rx="8"/>
    <rect x="310" y="60" width="210" height="90" rx="8"/>
    <rect x="590" y="60" width="190" height="90" rx="8"/>
    <rect x="310" y="200" width="210" height="84" rx="8" fill="#064e3b" stroke="#10b981"/>
  </g>
  <g fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="600" text-anchor="middle">
    <text x="140" y="100">PDM 设计BOM源头</text>
    <text x="140" y="124" fill="#94a3b8" font-size="12" font-weight="400">存量 12,400 条物料</text>
    <text x="415" y="100">一物多码映射中间表</text>
    <text x="415" y="124" fill="#38bdf8" font-size="12" font-weight="400">双轨自动路由窗口</text>
    <text x="685" y="100">ERP 生产工单接口 v2.4</text>
    <text x="685" y="124" fill="#94a3b8" font-size="12" font-weight="400">按对照表校验入库</text>
    <text x="415" y="236" fill="#ecfdf5">存量台账核对通道（非阻塞）</text>
    <text x="415" y="260" fill="#6ee7b7" font-size="12" font-weight="400">不依赖正式冻结开关</text>
  </g>
  <g stroke="#38bdf8" stroke-width="2" fill="none">
    <line x1="240" y1="105" x2="310" y2="105"/>
    <line x1="520" y1="105" x2="590" y2="105"/>
    <line x1="140" y1="150" x2="140" y2="242" stroke="#10b981" stroke-dasharray="5,5"/>
    <line x1="140" y1="242" x2="310" y2="242" stroke="#10b981" stroke-dasharray="5,5"/>
  </g>
</svg>`,
      },
      {
        revision_id: 'rev_06_02',
        file_id: 'file_06',
        versionNumber: 2,
        content_sha256: 'ef06020202020202020202020202020202020202020202020202020202020202',
        observed_at: '2026-11-05T14:25:00+08:00',
        source_time: '2026-11-05',
        agent_turn_hint: '轮次 #15 · 标注 Q01 待确认阈值与非阻塞核对边界',
        sizeBytes: 3890,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '新增 Q01 待确认标记（14天 vs 30天分歧）与受限安全渲染水印说明',
        svgExtractedTexts: [
          'PDM 设计BOM源头',
          '一物多码映射中间表',
          'Q01 待确认：14天(供应链) vs 30天(架构推荐)',
          'ERP 生产工单接口 v2.4',
          '存量台账核对通道（非阻塞可继续）',
          'T-204 基础核对正常推进',
        ],
        svgSource: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 360" width="100%" height="100%">
  <rect width="820" height="360" rx="12" fill="#0f172a"/>
  <g stroke="#334155" stroke-width="1.5" fill="#1e293b">
    <rect x="40" y="55" width="195" height="92" rx="8"/>
    <rect x="300" y="45" width="230" height="112" rx="8" stroke="#f59e0b" stroke-width="2"/>
    <rect x="595" y="55" width="185" height="92" rx="8"/>
    <rect x="300" y="215" width="230" height="92" rx="8" fill="#064e3b" stroke="#10b981"/>
  </g>
  <g fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="600" text-anchor="middle">
    <text x="137" y="95">PDM 设计BOM源头</text>
    <text x="137" y="120" fill="#94a3b8" font-size="12" font-weight="400">存量 12,400 条物料</text>
    <text x="415" y="80">一物多码映射中间表</text>
    <text x="415" y="106" fill="#fbbf24" font-size="12">Q01 待确认：14天 vs 30天</text>
    <text x="415" y="130" fill="#94a3b8" font-size="11" font-weight="400">仅阻断正式冻结开关</text>
    <text x="687" y="95">ERP 生产工单接口 v2.4</text>
    <text x="687" y="120" fill="#94a3b8" font-size="12" font-weight="400">按对照表校验入库</text>
    <text x="415" y="252" fill="#ecfdf5">存量台账核对通道（非阻塞可继续）</text>
    <text x="415" y="278" fill="#6ee7b7" font-size="12" font-weight="400">T-204 基础核对正常推进</text>
  </g>
  <g stroke="#38bdf8" stroke-width="2.5" fill="none">
    <line x1="235" y1="101" x2="300" y2="101"/>
    <line x1="530" y1="101" x2="595" y2="101"/>
    <line x1="137" y1="147" x2="137" y2="261" stroke="#10b981" stroke-dasharray="6,4"/>
    <line x1="137" y1="261" x2="300" y2="261" stroke="#10b981" stroke-dasharray="6,4"/>
  </g>
</svg>`,
      },
    ],
  },
  {
    file_id: 'file_07',
    relative_path: 'assets/mcp-single-process-arch.svg',
    title: '观澜单进程架构图.svg',
    format: 'svg',
    folder: 'assets',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [
      { name: 'MCP架构', provenance: '来自正文', rule: 'SVG <text> 包含 stdio MCP、Magpie 路由与 SQLite' },
    ],
    current_revision_id: 'rev_07_01',
    coverage: 'svg_text',
    revisions: [
      {
        revision_id: 'rev_07_01',
        file_id: 'file_07',
        versionNumber: 1,
        content_sha256: 'ef07010101010101010101010101010101010101010101010101010101010101',
        observed_at: '2026-11-05T10:05:00+08:00',
        source_time: '2026-11-05',
        sizeBytes: 3650,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '观澜 v0.2 单进程架构：一个根目录、一个服务进程、一套 SQLite 索引',
        svgExtractedTexts: [
          '已配置的工程目录 MD / SVG / PDF',
          '扫描与监听 稳定读取、内容哈希',
          '观澜服务 同一套查询与证据规则',
          'SQLite 索引 版本与阅读状态',
          '内容快照 按哈希去重',
          'Magpie MCP 路由 共享单写入者实例',
          '按需打开的阅读界面 127.0.0.1 HTTP / SSE',
        ],
        svgSource: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 840 340" width="100%" height="100%">
  <rect width="840" height="340" rx="12" fill="#090d16"/>
  <g stroke="#334155" stroke-width="1.5" fill="#1e293b">
    <rect x="30" y="40" width="180" height="75" rx="8"/>
    <rect x="30" y="185" width="180" height="95" rx="8"/>
    <rect x="290" y="100" width="230" height="110" rx="10" stroke="#38bdf8" stroke-width="2"/>
    <rect x="600" y="35" width="205" height="80" rx="8"/>
    <rect x="600" y="135" width="205" height="75" rx="8"/>
    <rect x="600" y="230" width="205" height="75" rx="8" fill="#0f2942" stroke="#38bdf8"/>
  </g>
  <g fill="#f8fafc" font-family="sans-serif" font-size="13" font-weight="600" text-anchor="middle">
    <text x="120" y="72">已配置的工程目录</text>
    <text x="120" y="95" fill="#94a3b8" font-size="11">373 MD / 158 SVG / 35 PDF</text>
    <text x="120" y="218">智能体 / Magpie 路由</text>
    <text x="120" y="242" fill="#38bdf8" font-size="11">stdio MCP 单写入者锁</text>
    <text x="120" y="262" fill="#94a3b8" font-size="11">冲突返回 ROOT_IN_USE</text>
    <text x="405" y="142" font-size="15">观澜核心服务进程</text>
    <text x="405" y="166" fill="#38bdf8" font-size="12">同一套查询与证据规则</text>
    <text x="405" y="190" fill="#94a3b8" font-size="11">有界队列 · 稳定读取 · 防抖对账</text>
    <text x="702" y="70">SQLite 索引 + FTS5</text>
    <text x="702" y="92" fill="#94a3b8" font-size="11">双字切分 + 原文短语核验</text>
    <text x="702" y="168">blobs/ 内容快照</text>
    <text x="702" y="190" fill="#94a3b8" font-size="11">SHA-256 去重 · 500MiB 配额</text>
    <text x="702" y="262" fill="#e0f2fe">按需打开的阅读界面</text>
    <text x="702" y="284" fill="#7dd3fc" font-size="11">127.0.0.1 随机端口 · SSE 序号</text>
  </g>
  <g stroke="#64748b" stroke-width="2" fill="none">
    <line x1="210" y1="78" x2="290" y2="135"/>
    <line x1="210" y1="230" x2="290" y2="175" stroke="#38bdf8"/>
    <line x1="520" y1="130" x2="600" y2="75"/>
    <line x1="520" y1="155" x2="600" y2="172"/>
    <line x1="520" y1="185" x2="600" y2="265" stroke="#38bdf8"/>
  </g>
</svg>`,
      },
    ],
  },
  {
    file_id: 'file_08',
    relative_path: 'assets/legacy-stamp-scan.svg',
    title: '历史盖章件矢量轮廓-无文字层.svg',
    format: 'svg',
    folder: 'assets',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [
      { name: '知识库', provenance: '待核对', rule: '路径归属 assets/，无内嵌 <text> 节点' },
    ],
    current_revision_id: 'rev_08_01',
    coverage: 'filename_only',
    revisions: [
      {
        revision_id: 'rev_08_01',
        file_id: 'file_08',
        versionNumber: 1,
        content_sha256: 'ef08010101010101010101010101010101010101010101010101010101010101',
        observed_at: '2026-11-04T19:15:00+08:00',
        source_time: '2026-11-01',
        sizeBytes: 2140,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '纯路径 <path> 矢量图形，无 <text> 元素，显示“仅文件名可检索”',
        svgExtractedTexts: [],
        svgSource: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 260" width="100%" height="100%">
  <rect width="600" height="260" rx="10" fill="#18181b"/>
  <circle cx="300" cy="130" r="78" fill="none" stroke="#ef4444" stroke-width="4" stroke-dasharray="10,4"/>
  <circle cx="300" cy="130" r="64" fill="none" stroke="#ef4444" stroke-width="1.5"/>
  <polygon points="300,95 310,120 336,120 315,136 323,162 300,146 277,162 285,136 264,120 290,120" fill="#ef4444" opacity="0.85"/>
  <path d="M 120 210 Q 300 185 480 210" stroke="#52525b" stroke-width="2" fill="none"/>
</svg>`,
      },
    ],
  },
  {
    file_id: 'file_09',
    relative_path: 'docs/ERP-PDM接口规范-v2.4.pdf',
    title: 'ERP-PDM接口规范-v2.4.pdf',
    format: 'pdf',
    folder: 'docs',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [
      { name: 'PDM', provenance: '来自路径', rule: '文件名包含 ERP-PDM接口规范' },
      { name: 'BOM主数据', provenance: '来自正文', rule: '已抽取第 1–3 页文本层' },
    ],
    current_revision_id: 'rev_09_02',
    coverage: 'pdf_page_text',
    pdfStatus: 'page_indexed',
    pdfStatusReason: '已按需抽取文本层（共 18 页，已索引页码来源）',
    revisions: [
      {
        revision_id: 'rev_09_01',
        file_id: 'file_09',
        versionNumber: 1,
        content_sha256: 'pdf9010101010101010101010101010101010101010101010101010101010101',
        observed_at: '2026-11-04T19:20:00+08:00',
        source_time: '2026-10-28',
        sizeBytes: 4480200,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: 'v2.4 初始归档版本（4.27 MiB）',
        pdfPages: [
          {
            pageNumber: 1,
            heading: '第 1 页 · ERP-PDM 主数据同步接口总则',
            extractedText:
              '1.1 适用范围：本规范定义拥抱AI工程中 PDM 设计物料编码与 ERP 生产 BOM 的同步报文格式、幂等重试策略与异常回退机制。',
            visualSummary: '封面与总则表格：包含接口版本 v2.4、报文签名头定义',
          },
          {
            pageNumber: 4,
            heading: '第 4 页 · 一物多码过渡期对照表路由规范',
            extractedText:
              '4.2 当启用双轨过渡窗口时，网关根据 material_legacy_code 查询映射表，返回 canonical_code 并记录审计日志。默认窗口参数由配置项 FREEZE_WINDOW_DAYS 决定。',
            visualSummary: '字段映射表：material_legacy_code -> canonical_code -> effective_until',
          },
        ],
      },
      {
        revision_id: 'rev_09_02',
        file_id: 'file_09',
        versionNumber: 2,
        content_sha256: 'pdf9020202020202020202020202020202020202020202020202020202020202',
        observed_at: '2026-11-05T14:18:00+08:00',
        source_time: '2026-11-05',
        agent_turn_hint: '轮次 #15 · 更新附录 B 错误码表 PDF',
        sizeBytes: 4612800,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '更新版二进制快照（4.40 MiB）：新增第 12 页双轨校验错误码说明',
        pdfPages: [
          {
            pageNumber: 1,
            heading: '第 1 页 · ERP-PDM 主数据同步接口总则',
            extractedText:
              '1.1 适用范围：本规范定义拥抱AI工程中 PDM 设计物料编码与 ERP 生产 BOM 的同步报文格式、幂等重试策略与异常回退机制。',
            visualSummary: '封面与总则表格：包含接口版本 v2.4.1、报文签名头定义',
          },
          {
            pageNumber: 4,
            heading: '第 4 页 · 一物多码过渡期对照表路由规范',
            extractedText:
              '4.2 当启用双轨过渡窗口时，网关根据 material_legacy_code 查询映射表，返回 canonical_code 并记录审计日志。默认窗口参数由配置项 FREEZE_WINDOW_DAYS（待 Q01 确认：14 或 30）决定。',
            visualSummary: '字段映射表：material_legacy_code -> canonical_code -> effective_until',
          },
          {
            pageNumber: 12,
            heading: '第 12 页 · 存量核对非阻塞校验响应码',
            extractedText:
              '12.1 验收与核对隔离：在 FREEZE_WINDOW_DAYS 尚未冻结前，批量核对接口返回 WARN_LEGACY_MAPPED，不阻断存量 BOM 对账作业。',
            visualSummary: '状态码矩阵表：200 OK / WARN_LEGACY_MAPPED / ERR_FROZEN_CODE',
          },
        ],
      },
    ],
  },
  {
    file_id: 'file_10',
    relative_path: 'docs/集团主数据安全红线2026.pdf',
    title: '集团主数据安全红线2026.pdf',
    format: 'pdf',
    folder: 'docs',
    role: '决策',
    roleProvenance: '来自路径',
    topics: [
      { name: '知识库', provenance: '来自路径', rule: '关联知识库涉密分级 Q03' },
    ],
    current_revision_id: 'rev_10_01',
    coverage: 'filename_only',
    pdfStatus: 'unindexed',
    pdfStatusReason: '初始状态：正文尚未索引，当前仅检索文件名和已知元数据（等待 Q03 确认后按需抽取文本层）',
    revisions: [
      {
        revision_id: 'rev_10_01',
        file_id: 'file_10',
        versionNumber: 1,
        content_sha256: 'pdf1001010101010101010101010101010101010101010101010101010101010',
        observed_at: '2026-11-04T19:22:00+08:00',
        source_time: '2026-09-15',
        sizeBytes: 8920400,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: '二进制快照已保存（8.51 MiB），正文尚未执行全文索引抽取',
        pdfPages: [
          {
            pageNumber: 1,
            heading: '第 1 页 · 集团研发图纸与技术文档分级保护规定（预览）',
            extractedText:
              '【阅读器内嵌预览可用 · 全文检索尚未建立索引】第 3 条：凡未显式标定公开等级的历史工程 PDF 档案，在接入本地或云端知识库时默认仅开放文件名与目录台账检索，须经安全办会签后方可启用正文抽取。',
            visualSummary: '集团红头文件内嵌阅读视图（阅读能力正常，全文索引状态为 unindexed）',
          },
        ],
      },
    ],
  },
  {
    file_id: 'file_11',
    relative_path: 'docs/历史扫描件-印章备案.pdf',
    title: '历史扫描件-印章备案.pdf',
    format: 'pdf',
    folder: 'docs',
    role: '其他',
    roleProvenance: '待核对',
    topics: [
      { name: '办公协同', provenance: '待核对', rule: '路径归属 docs/，待确认所属专项' },
    ],
    current_revision_id: 'rev_11_01',
    coverage: 'filename_only',
    pdfStatus: 'extract_failed',
    pdfStatusReason: '字符流提取失败：内嵌 Type3 字体缺少 ToUnicode CMap 映射（注：中文提取失败不直接判定为扫描件；后续可按需启用可选 OCR 模块）',
    revisions: [
      {
        revision_id: 'rev_11_01',
        file_id: 'file_11',
        versionNumber: 1,
        content_sha256: 'pdf1101010101010101010101010101010101010101010101010101010101011',
        observed_at: '2026-11-04T19:25:00+08:00',
        source_time: '2025-12-10',
        sizeBytes: 14200000,
        snapshotAvailable: true,
        isBaselineProtected: false,
        summaryNote: 'Type3 字体 CMap 缺失导致字符提取失败，保留原文件阅读入口',
        pdfPages: [
          {
            pageNumber: 1,
            heading: '第 1 页 · 原页核对视图（字符层提取失败）',
            extractedText:
              '【状态说明：文本层字符提取返回乱码/空映射，观澜不将其武断归类为扫描件】您仍可通过浏览器原页阅读器或系统 PDF 阅读器直接查看原始版面。',
            visualSummary: '原页版面预览：印章备案登记表（2025年度）',
          },
        ],
      },
    ],
  },
  {
    file_id: 'file_12',
    relative_path: 'docs/观澜-MCP轻量阅读器设计-v0.2.md',
    title: '观澜 MCP 轻量阅读器设计 v0.2',
    format: 'md',
    folder: 'docs',
    role: '方案',
    roleProvenance: '来自正文',
    topics: [
      { name: 'MCP架构', provenance: '来自正文', rule: '核心架构与 8 工具契约设计提案' },
      { name: '知识库', provenance: '来自正文', rule: '定义 566 份样本工程资料的阅读与追溯规则' },
    ],
    current_revision_id: 'rev_12_01',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_12_01',
        file_id: 'file_12',
        versionNumber: 1,
        content_sha256: 'f120101010101010101010101010101010101010101010101010101010101012',
        observed_at: '2026-11-05T14:35:00+08:00',
        source_time: '2026-11-05',
        sizeBytes: 18450,
        snapshotAvailable: true,
        isBaselineProtected: true,
        summaryNote: 'v0.2 设计提案全文：用时间线找到变化，用关系找到依据，用阅读器理解内容',
        markdownContent: `# 观澜 MCP 轻量阅读器设计 v0.2

日期：2026-11-05（Asia/Shanghai）  
状态：设计提案，当前正在交互验证  
分发方向：通用 MCP；拟评估 Magpie 工具插件渠道，尚未发布。  
目标：在智能体持续修改工程时，让人快速找到资料、看懂变化，并追溯决定的依据。  
样本工程：\`C:\\Users\\34689\\Downloads\\拥抱AI\`

## 核心结论

**观澜是面向支持 MCP 的智能体的本地阅读插件，附带按需打开的阅读界面。** 智能体继续负责修改工程；观澜负责把工程里的文档、图和 PDF，组织成可阅读、可追溯的资料视图。

产品主张：**用时间线找到变化，用关系找到依据，用阅读器理解内容。**

首版采用“一个安装包、一个配置根目录、一个服务进程、一套本地索引”。不引入账号、云服务、向量数据库、任务调度、智能体派发、审批流或文档编辑器。

## 1. 当前资料规模与验证闭环

样本工程按附录 A 口径共枚举 **566** 份文件：**373 份 Markdown**、**158 份 SVG**、**35 份 PDF**。

下一步最值得验证的核心闭环：
1. 一份 Markdown 改完后，用户能否在观澜里立即看到它（见 [四专项待确认事项](01-方案文档/四专项待确认事项.md) 与 [PDM编码与BOM主数据方案](02-PDM专项/PDM编码与BOM主数据方案.md)）。
2. 对比上次读过的版本（支持行级并排/合并 diff，以及 A → B → A 版本恢复识别）。
3. 顺着链接读到 SVG/PDF（如 [PDM与BOM双轨映射图](assets/pdm-bom-flow.svg)、[观澜单进程架构图](assets/mcp-single-process-arch.svg)、[ERP-PDM接口规范-v2.4.pdf](docs/ERP-PDM接口规范-v2.4.pdf)），保留原段落位置一键返回。
4. 查看决策依据与来源冲突（见 [决策回执](01-方案文档/决策回执.md)），并把有关依据带回智能体。`,
      },
    ],
  },
];

export const INITIAL_TIMELINE_EVENTS: TimelineEvent[] = [
  {
    event_id: 'evt_108',
    kind: 'modified',
    file_id: 'file_01',
    revision_id: 'rev_01_03',
    prev_revision_id: 'rev_01_02',
    observed_at: '2026-11-05T14:32:00+08:00',
    source_time: '2026-11-05',
    batch_id: 'batch_turn_15',
    batch_title: '轮次 #15 · 一组相关修改 · 4 个文件（PDM 与四专项对齐）',
    topic_lane: 'PDM / 四专项',
    task_code: 'T-204',
    headline: '四专项待确认事项.md 新增“影响与等待范围明细”表格',
    detail:
      '明确区分 T-204-A 阻塞范围（生产环境冻结开关）与非阻塞范围（1.2 万条存量物料清洗可继续推进）。',
    changedSections: ['核心结论', '需你决策', '影响与等待范围明细'],
    decision_id: 'dec_four_spec_q01',
  },
  {
    event_id: 'evt_107',
    kind: 'modified',
    file_id: 'file_02',
    revision_id: 'rev_02_03',
    prev_revision_id: 'rev_02_02',
    observed_at: '2026-11-05T14:28:00+08:00',
    source_time: '2026-11-05',
    batch_id: 'batch_turn_15',
    batch_title: '轮次 #15 · 一组相关修改 · 4 个文件（PDM 与四专项对齐）',
    topic_lane: 'PDM',
    task_code: 'T-204',
    headline: 'PDM编码与BOM主数据方案.md 恢复旧内容（A → B → A）',
    detail:
      '从 v2（7天激进切换实验）恢复为 v1（30天双轨窗口草案）。内容 SHA-256 与 rev_02_01 相同，系统完整保留 A → B → A 三次版本出现记录。',
    changedSections: ['核心结论', '3. 推荐及理由'],
    isRollback: true,
  },
  {
    event_id: 'evt_106',
    kind: 'modified',
    file_id: 'file_06',
    revision_id: 'rev_06_02',
    prev_revision_id: 'rev_06_01',
    observed_at: '2026-11-05T14:25:00+08:00',
    source_time: '2026-11-05',
    batch_id: 'batch_turn_15',
    batch_title: '轮次 #15 · 一组相关修改 · 4 个文件（PDM 与四专项对齐）',
    topic_lane: 'PDM',
    task_code: 'T-204',
    headline: 'PDM与BOM双轨映射图.svg 更新矢量节点与可检索文本',
    detail:
      '图中新增“Q01 待确认：14天 vs 30天”高亮框及“存量台账核对通道（非阻塞可继续）”文本节点。',
    changedSections: ['SVG 文本层与节点连线'],
  },
  {
    event_id: 'evt_105',
    kind: 'modified',
    file_id: 'file_09',
    revision_id: 'rev_09_02',
    prev_revision_id: 'rev_09_01',
    observed_at: '2026-11-05T14:18:00+08:00',
    source_time: '2026-11-05',
    batch_id: 'batch_turn_15',
    batch_title: '轮次 #15 · 一组相关修改 · 4 个文件（PDM 与四专项对齐）',
    topic_lane: 'PDM',
    task_code: 'T-204',
    headline: '一份 PDF 已更新：ERP-PDM接口规范-v2.4.pdf',
    detail:
      '文件大小由 4.27 MiB 增至 4.40 MiB，新增第 12 页 WARN_LEGACY_MAPPED 非阻塞核对状态码表。',
    changedSections: ['第 4 页', '第 12 页'],
  },
  {
    event_id: 'evt_104',
    kind: 'appeared',
    file_id: 'file_05',
    revision_id: 'rev_05_01',
    observed_at: '2026-11-05T12:10:00+08:00',
    source_time: '2026-11-05',
    topic_lane: '知识库',
    task_code: 'T-208',
    headline: '监测期间新增文件：多格式抽取与索引边界说明.md',
    detail:
      '监测期间出现此前不存在的路径（appeared）；未包含 Git 提交信息，因此不声称知道最初作者。',
  },
  {
    event_id: 'evt_103',
    kind: 'decision_changed',
    file_id: 'file_03',
    revision_id: 'rev_03_02',
    prev_revision_id: 'rev_03_01',
    observed_at: '2026-11-05T10:30:00+08:00',
    source_time: '2026-11-05',
    commit_time: '2026-11-05T10:28:40+08:00',
    topic_lane: '知识库 / 架构',
    task_code: 'T-208',
    headline: '决策来源更新：决策回执.md 正式确认 Q02 并登记 Q01 分歧',
    detail:
      '架构委员会李工确认 Q02（SVG 受限图片加载与文本抽取）；同时记录 Q01 供应链周会（14天）与架构方案（30天）存在来源冲突。',
    decision_id: 'dec_four_spec_q02',
  },
  {
    event_id: 'evt_102',
    kind: 'moved_or_copied',
    file_id: 'file_02',
    revision_id: 'rev_02_01',
    observed_at: '2026-11-05T09:15:00+08:00',
    topic_lane: 'PDM',
    task_code: 'T-204',
    headline: '检测到同哈希副本候选：02-PDM专项/PDM编码与BOM主数据方案.md',
    detail:
      '发现归档目录存在相同 SHA-256 副本；因两处路径各有引用用途，保留各自独立 file_id，仅折叠存储快照并标记候选关联。',
    sameHashCandidatePaths: [
      '02-PDM专项/PDM编码与BOM主数据方案.md',
      '99-历史归档/2026-11-04-PDM编码方案备份.md',
    ],
  },
  {
    event_id: 'evt_101',
    kind: 'discovered',
    file_id: 'file_01',
    revision_id: 'rev_01_01',
    observed_at: '2026-11-04T19:10:00+08:00',
    source_time: '2026-11-04',
    commit_time: '2026-11-04T18:55:12+08:00',
    topic_lane: '系统基线',
    headline: '首次扫描建立工程基线（discovered · 566 份文件）',
    detail:
      '首次接入发现已有 373 MD、158 SVG、35 PDF。按规则标记为 discovered 基线，不伪造为“新建于今天”。',
  },
];

export const INITIAL_DECISIONS: DecisionAssertion[] = [
  {
    decision_id: 'dec_four_spec_q01',
    code: 'Q01',
    namespace: '拥抱AI / 四专项待确认事项',
    question: 'PDM 物料编码一物多码历史过渡期规则（14天强制切换 vs 30天双轨映射）',
    status: '来源不一致',
    isCandidateOnly: false,
    options: [
      '选项 A：立即冻结旧编码新增权限，存量 BOM 在 14 天内强制切换新码（供应链周会倾向）',
      '选项 B：保留 30 天双轨映射窗口，ERP 接口按对照表自动路由（架构组方案推荐）',
    ],
    recommendation:
      '架构组推荐采用选项 B（30 天双轨映射窗口），但原文明确限定“仅作架构组建议，尚未获业务负责人签批”，推荐不等于已批准。',
    impactBlocked: [
      '生产环境旧编码强制拦截开关上线（T-204-A 正式规则冻结）',
      'ERP-PDM 接口 FREEZE_WINDOW_DAYS 生产环境最终阈值锁定',
    ],
    impactAllowed: [
      '存量 12,400 条物料主数据清洗与父子件关联核对（基础核对不阻断）',
      'ERP 沙箱环境双轨路由联调与异常编码清单导出',
    ],
    conflictExplanation:
      '《02-PDM专项/PDM编码与BOM主数据方案.md》按 30 天双轨窗口编写推荐方案，而《01-方案文档/决策回执.md》第 19 行记录供应链周会代表倾向 14 天窗口以防跨月财务核算分裂。两份材料状态与口径并列呈现，待联合会签。',
    topic: 'PDM',
    evidences: [
      {
        source_id: 'ev_q01_1',
        file_id: 'file_01',
        revision_id: 'rev_01_03',
        relative_path: '01-方案文档/四专项待确认事项.md',
        lineStart: 16,
        lineEnd: 23,
        observed_at: '2026-11-05T14:32:00+08:00',
        source_time: '2026-11-05',
        claimedStatus: '来源不一致',
        exactQuote:
          '架构组推荐采用选项 B，并在 PDM编码与BOM主数据方案 中按 30 天窗口编写了接口草案；但 决策回执 第 19 行记录供应链周会倾向 14 天窗口。',
        note: '汇总文档显式标注来源冲突与非阻塞核对范围',
      },
      {
        source_id: 'ev_q01_2',
        file_id: 'file_03',
        revision_id: 'rev_03_02',
        relative_path: '01-方案文档/决策回执.md',
        lineStart: 13,
        lineEnd: 20,
        observed_at: '2026-11-05T10:30:00+08:00',
        source_time: '2026-11-05',
        claimedStatus: '待确认',
        exactQuote:
          '供应链代表倾向采用 14 天窗口（选项 A），担心 30 天双轨期跨月导致财务成本核算口径分裂。',
        note: '决策回执登记簿中的供应链侧分歧记录',
      },
      {
        source_id: 'ev_q01_3',
        file_id: 'file_02',
        revision_id: 'rev_02_03',
        relative_path: '02-PDM专项/PDM编码与BOM主数据方案.md',
        lineStart: 7,
        lineEnd: 11,
        observed_at: '2026-11-05T14:28:00+08:00',
        source_time: '2026-11-04',
        claimedStatus: '待确认',
        exactQuote:
          '针对历史“一物多码”台账，架构组推荐采用 30 天双轨映射窗口（沙箱联调通过，不代表验收通过）。',
        note: '专项方案技术推荐（明确保留“不代表验收通过”限定）',
      },
    ],
  },
  {
    decision_id: 'dec_four_spec_q02',
    code: 'Q02',
    namespace: '拥抱AI / 四专项待确认事项',
    question: 'SVG 架构图与工艺路线图检索安全策略',
    status: '已确认',
    isCandidateOnly: false,
    options: [
      '选项 A：以受限图片模式加载 SVG（禁用脚本与外部资源），提取可识别文本加入检索',
      '选项 B：将原始 SVG 直接拼入主页面 DOM 以支持任意图元点击事件',
    ],
    recommendation: '推荐并已批准选项 A，兼顾矢量清晰度、文本可检索性与宿主页面 CSP 安全。',
    impactBlocked: [],
    impactAllowed: [
      '158 份 SVG 图纸缩放平移预览与 <text> 节点全文索引',
      '无文本层 SVG 自动标注“仅文件名可检索”',
    ],
    confirmationBasis: {
      recordText:
        '批准采用受限图片模式渲染 SVG（禁用脚本、外部资源与事件处理器），并提取可识别文本层加入全文索引。',
      confirmer: '李工（架构委员会主任）',
      confirmedAt: '2026-11-05 10:15',
      file_id: 'file_03',
      revision_id: 'rev_03_02',
      lineRange: [24, 31],
    },
    topic: '知识库',
    evidences: [
      {
        source_id: 'ev_q02_1',
        file_id: 'file_03',
        revision_id: 'rev_03_02',
        relative_path: '01-方案文档/决策回执.md',
        lineStart: 24,
        lineEnd: 31,
        observed_at: '2026-11-05T10:30:00+08:00',
        source_time: '2026-11-05',
        claimedStatus: '已确认',
        confirmer: '李工（架构委员会主任）',
        exactQuote:
          '回执状态：已确认。确认人：李工（架构委员会主任），确认时间：2026-11-05 10:15。',
        note: '正式回执签批记录',
      },
    ],
  },
  {
    decision_id: 'dec_four_spec_q03',
    code: 'Q03',
    namespace: '拥抱AI / 四专项待确认事项',
    question: '跨部门知识库 PDF 图纸涉密分级默认策略',
    status: '待确认',
    isCandidateOnly: false,
    options: [
      '选项 A：未标记密级的历史 PDF 默认按“内部受限”隔离，初始仅检索文件名与已知元数据',
      '选项 B：默认全量抽取正文进入公共检索池',
    ],
    recommendation:
      '推荐采用选项 A（待安全办最终会签）。在未获会签前，未标密 PDF 保持“正文尚未索引（仅文件名可检索）”。',
    impactBlocked: ['35 份历史未标密 PDF 自动全量正文入库（T-208-C）'],
    impactAllowed: [
      '浏览器内嵌直接打开阅读 PDF 原件',
      '按需对已授权接口规范（如 ERP-PDM接口规范-v2.4.pdf）抽取带页码的文本层',
    ],
    topic: '知识库',
    evidences: [
      {
        source_id: 'ev_q03_1',
        file_id: 'file_01',
        revision_id: 'rev_01_03',
        relative_path: '01-方案文档/四专项待确认事项.md',
        lineStart: 31,
        lineEnd: 38,
        observed_at: '2026-11-05T14:32:00+08:00',
        source_time: '2026-11-05',
        claimedStatus: '待确认',
        exactQuote:
          '推荐采用选项 A（待安全办最终会签），依据见 集团主数据安全红线2026.pdf。仅影响历史未标密 PDF 的全文索引入库。',
        note: '四专项汇总文档中的 Q03 条目（注意：与办公协同::Q03 属于不同命名空间）',
      },
    ],
  },
  {
    decision_id: 'dec_oa_collab_q03',
    code: 'Q03',
    namespace: '拥抱AI / 办公协同专项',
    question: '移动端审批卡片超时免打扰时段设置',
    status: '已确认',
    isCandidateOnly: false,
    options: [
      '选项 A：22:00–08:00 默认静默汇总推送',
      '选项 B：全天候实时强提醒',
    ],
    recommendation: '已确认采用选项 A（22:00–08:00 默认静默汇总推送）。',
    impactBlocked: [],
    impactAllowed: ['办公协同消息网关免打扰规则配置上线'],
    confirmationBasis: {
      recordText: '已由协同产品负责人王敏于 2026-11-04 确认采用“22:00–08:00 默认静默汇总推送”。',
      confirmer: '王敏（协同产品负责人）',
      confirmedAt: '2026-11-04 17:40',
      file_id: 'file_04',
      revision_id: 'rev_04_01',
      lineRange: [14, 19],
    },
    topic: '办公协同',
    evidences: [
      {
        source_id: 'ev_oa_q03_1',
        file_id: 'file_04',
        revision_id: 'rev_04_01',
        relative_path: '03-办公协同/协同审批与消息路由方案.md',
        lineStart: 14,
        lineEnd: 19,
        observed_at: '2026-11-05T09:40:00+08:00',
        source_time: '2026-11-05',
        claimedStatus: '已确认',
        confirmer: '王敏（协同产品负责人）',
        exactQuote:
          '决策集命名空间：拥抱AI / 办公协同专项 :: Q03。当前状态：已确认。与知识库 PDF 涉密分级（四专项::Q03）完全无关。',
        note: '独立命名空间下的同名编号 Q03，绝不自动合并',
      },
    ],
  },
  {
    decision_id: 'dec_candidate_webhook',
    code: 'CAND-01',
    namespace: '拥抱AI / 办公协同专项（疑似决策候选）',
    question: '是否将周报汇总接入同一个飞书/企微 Webhook 通道？',
    status: '未知',
    isCandidateOnly: true, // 疑似决策候选：不计入“待你确认”真实计数
    options: ['复用现有审批通知 Webhook', '保持独立周报推送通道'],
    recommendation:
      '原文仅为会议随笔探讨（“是不是可以考虑……目前只是口头探讨”），按规则归入疑似决策候选列表，不增加顶部“待你确认”计数。',
    impactBlocked: [],
    impactAllowed: ['现有审批消息路由开发不受影响'],
    topic: '办公协同',
    evidences: [
      {
        source_id: 'ev_cand_1',
        file_id: 'file_04',
        revision_id: 'rev_04_01',
        relative_path: '03-办公协同/协同审批与消息路由方案.md',
        lineStart: 23,
        lineEnd: 24,
        observed_at: '2026-11-05T09:40:00+08:00',
        source_time: '2026-11-05',
        claimedStatus: '未知',
        exactQuote:
          '会议随笔：后续是不是可以考虑把周报汇总也接入同一个 Webhook 通道？目前只是口头探讨，尚未形成正式提案。',
        note: '规则识别为讨论口吻，归入候选核对列表',
      },
    ],
  },
];

export const INITIAL_RELATIONS: RelationEdge[] = [
  // Explicit references from file_01 (四专项待确认事项.md)
  {
    edge_id: 'rel_01',
    source_id: 'file_01',
    target_id: 'file_02',
    type: 'explicit_reference',
    isInferred: false,
    label: '显式引用',
    reason: '《四专项待确认事项.md》第 21 行 Markdown 链接指向《PDM编码与BOM主数据方案.md》',
    locator: { startLine: 20, endLine: 22 },
  },
  {
    edge_id: 'rel_02',
    source_id: 'file_01',
    target_id: 'file_06',
    type: 'explicit_reference',
    isInferred: false,
    label: '配图引用',
    reason: '《四专项待确认事项.md》第 21 行引用 SVG《PDM与BOM双轨映射图.svg》',
    locator: { startLine: 20, endLine: 22 },
  },
  {
    edge_id: 'rel_03',
    source_id: 'file_01',
    target_id: 'file_03',
    type: 'explicit_reference',
    isInferred: false,
    label: '回执引用',
    reason: '《四专项待确认事项.md》第 21、27 行引用《决策回执.md》',
    locator: { startLine: 21, endLine: 28 },
  },
  {
    edge_id: 'rel_04',
    source_id: 'file_01',
    target_id: 'file_10',
    type: 'explicit_reference',
    isInferred: false,
    label: '规范引用',
    reason: '《四专项待确认事项.md》第 36 行引用《集团主数据安全红线2026.pdf》',
    locator: { startLine: 35, endLine: 37 },
  },
  {
    edge_id: 'rel_05',
    source_id: 'file_01',
    target_id: 'file_05',
    type: 'explicit_reference',
    isInferred: false,
    label: '显式引用',
    reason: '《四专项待确认事项.md》第 36 行引用《多格式抽取与索引边界说明.md》',
    locator: { startLine: 35, endLine: 37 },
  },
  // Explicit references from file_02 (PDM编码与BOM主数据方案.md)
  {
    edge_id: 'rel_06',
    source_id: 'file_02',
    target_id: 'file_06',
    type: 'explicit_reference',
    isInferred: false,
    label: '架构配图',
    reason: '《PDM编码与BOM主数据方案.md》第 14 行引用《PDM与BOM双轨映射图.svg》',
    locator: { startLine: 13, endLine: 15 },
  },
  {
    edge_id: 'rel_07',
    source_id: 'file_02',
    target_id: 'file_09',
    type: 'explicit_reference',
    isInferred: false,
    label: '接口依据',
    reason: '《PDM编码与BOM主数据方案.md》第 15 行引用《ERP-PDM接口规范-v2.4.pdf》',
    locator: { startLine: 14, endLine: 16 },
  },
  // Explicit references from file_03 (决策回执.md)
  {
    edge_id: 'rel_08',
    source_id: 'file_03',
    target_id: 'file_07',
    type: 'explicit_reference',
    isInferred: false,
    label: '架构图依据',
    reason: '《决策回执.md》第 30 行引用《观澜单进程架构图.svg》',
    locator: { startLine: 29, endLine: 31 },
  },
  // Decision basis edges
  {
    edge_id: 'rel_09',
    source_id: 'dec_four_spec_q01',
    target_id: 'file_01',
    type: 'decision_basis',
    isInferred: false,
    label: '决策汇总源',
    reason: '四专项::Q01 在《四专项待确认事项.md》第 16–23 行定义选项与影响范围',
    locator: { startLine: 16, endLine: 23 },
  },
  {
    edge_id: 'rel_10',
    source_id: 'dec_four_spec_q01',
    target_id: 'file_02',
    type: 'decision_basis',
    isInferred: false,
    label: '架构推荐依据',
    reason: '四专项::Q01 选项 B 依据《PDM编码与BOM主数据方案.md》30天双轨方案',
    locator: { startLine: 7, endLine: 11 },
  },
  {
    edge_id: 'rel_11',
    source_id: 'dec_four_spec_q01',
    target_id: 'file_03',
    type: 'decision_basis',
    isInferred: false,
    label: '冲突回执源',
    reason: '四专项::Q01 供应链 14 天倾向记录于《决策回执.md》第 13–20 行',
    locator: { startLine: 13, endLine: 20 },
  },
  {
    edge_id: 'rel_12',
    source_id: 'dec_four_spec_q02',
    target_id: 'file_03',
    type: 'decision_basis',
    isInferred: false,
    label: '批准回执依据',
    reason: '四专项::Q02 由李工在《决策回执.md》第 24–31 行正式确认',
    locator: { startLine: 24, endLine: 31 },
  },
  {
    edge_id: 'rel_13',
    source_id: 'dec_four_spec_q03',
    target_id: 'file_10',
    type: 'decision_basis',
    isInferred: false,
    label: '安全红线依据',
    reason: '四专项::Q03 引用《集团主数据安全红线2026.pdf》第 3 条规定',
  },
  // Same topic / task code grouping (inferred/grouping edge -> dashed line with explicit reason)
  {
    edge_id: 'rel_14',
    source_id: 'file_02',
    target_id: 'file_09',
    type: 'same_topic_or_code',
    isInferred: true,
    label: '同任务号 T-204',
    reason: '推断分组（虚线）：同属任务编号 T-204 与 PDM 主题，仅作分组关联，不表示因果或替代关系',
  },
  {
    edge_id: 'rel_15',
    source_id: 'file_05',
    target_id: 'file_07',
    type: 'explicit_reference',
    isInferred: false,
    label: '显式引用',
    reason: '《多格式抽取与索引边界说明.md》第 16 行引用《观澜单进程架构图.svg》',
    locator: { startLine: 15, endLine: 17 },
  },
];

export const INITIAL_READING_STATES: Record<string, ReadingState> = {
  file_01: {
    file_id: 'file_01',
    last_read_revision_id: 'rev_01_01', // 用户上次读的是 v1，当前是 v3，因此有“未读变化”！
    last_section_id: '需你决策',
    scrollPercent: 45,
    isFullyRead: false,
    bookmarked: true,
    personalNote: '关注 Q01 供应链 14 天与架构 30 天的分歧，注意基础核对不阻断',
    updated_at: '2026-11-04T21:15:00+08:00',
  },
  file_02: {
    file_id: 'file_02',
    last_read_revision_id: 'rev_02_02', // 用户上次读过实验版 v2，现在回滚到 v3 (A->B->A)
    last_section_id: '1. 双轨映射与流转架构',
    scrollPercent: 30,
    isFullyRead: false,
    bookmarked: true,
    personalNote: '已核对 A -> B -> A 回滚记录',
    updated_at: '2026-11-05T13:20:00+08:00',
  },
  file_03: {
    file_id: 'file_03',
    last_read_revision_id: 'rev_03_02',
    last_section_id: '2. 已确认回执（Q02）',
    scrollPercent: 100,
    isFullyRead: true,
    bookmarked: false,
    updated_at: '2026-11-05T11:00:00+08:00',
  },
  file_06: {
    file_id: 'file_06',
    last_read_revision_id: 'rev_06_01', // SVG 也有新版本未读变化
    scrollPercent: 100,
    isFullyRead: false,
    bookmarked: false,
    updated_at: '2026-11-04T20:10:00+08:00',
  },
};


test('中文检索：双字切分 (Bigram) 候选与两字词“决策”“验收”及任务编号精确匹配', () => {
  const bigrams = generateChineseBigrams('决策回执');
  assert.deepEqual(bigrams, ['决策', '策回', '回执']);

  // 搜索两字词“决策”应命中正文与对应行段，而非因 trigram <3 字符限制而漏检
  const decisionHits = searchWorkspace(INITIAL_FILES, '决策');
  assert.ok(decisionHits.length >= 3);
  assert.ok(decisionHits.some((h) => h.file_id === 'file_01' && h.coverage === 'full_text'));

  // 搜索两字词“验收”应命中包含“不代表验收通过”的方案与已抽取页文本的 PDF
  const acceptanceHits = searchWorkspace(INITIAL_FILES, '验收');
  assert.ok(acceptanceHits.some((h) => h.file_id === 'file_02'));
  assert.ok(acceptanceHits.some((h) => h.file_id === 'file_09' && h.coverage === 'pdf_page_text'));

  // 搜索任务编号 T-204 应采用 exact_code 策略命中 MD 与 SVG 文字
  const codeHits = searchWorkspace(INITIAL_FILES, 'T-204');
  assert.ok(codeHits.some((h) => h.matchStrategy === 'exact_code' && h.format === 'md'));
  assert.ok(codeHits.some((h) => h.format === 'svg' && h.coverage === 'svg_text'));
});

test('SVG 与 PDF 检索覆盖边界：无文本层 SVG 与未索引 PDF 仅匹配文件名', () => {
  // file_10 (集团主数据安全红线2026.pdf) 状态为 unindexed，搜文件名命中并标记 filename_only
  const pdfFileHits = searchWorkspace(INITIAL_FILES, '安全红线');
  const redlineHit = pdfFileHits.find((h) => h.file_id === 'file_10');
  assert.ok(redlineHit);
  assert.equal(redlineHit.coverage, 'filename_only');

  // file_08 (历史盖章件矢量轮廓-无文字层.svg) 仅文件名可检索
  const svgFileHits = searchWorkspace(INITIAL_FILES, '历史盖章件');
  const stampHit = svgFileHits.find((h) => h.file_id === 'file_08');
  assert.ok(stampHit);
  assert.equal(stampHit.coverage, 'filename_only');
});

// ============================================================
// p3 行为锁定：searchWorkspace 的截断 / 回退 / matchStrategy / 正文缓存语义。
// 性能重构（per-file 命中计数 Map + revision_id 行缓存）前后输出必须逐字段一致。
// ============================================================
interface P3SearchFixtureSpec {
  file_id: string;
  relative_path: string;
  title?: string;
  format?: 'md' | 'svg' | 'pdf';
  markdownContent?: string;
  svgExtractedTexts?: string[];
}

function makeSearchFixtureFile(spec: P3SearchFixtureSpec): FileRecord {
  const format = spec.format ?? 'md';
  const revision: FileRecord['revisions'][number] = {
    revision_id: `${spec.file_id}_r1`,
    file_id: spec.file_id,
    versionNumber: 1,
    content_sha256: 'p'.repeat(64),
    observed_at: '2026-11-05T10:00:00+08:00',
    sizeBytes: 128,
    snapshotAvailable: true,
    summaryNote: 'p3 行为锁定夹具',
  };
  if (format === 'md') revision.markdownContent = spec.markdownContent;
  if (format === 'svg') revision.svgExtractedTexts = spec.svgExtractedTexts;
  return {
    file_id: spec.file_id,
    relative_path: spec.relative_path,
    title: spec.title ?? spec.file_id,
    format,
    folder: 'p3-fixtures',
    role: '其他',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revision.revision_id,
    coverage: 'full_text',
    revisions: [revision],
  };
}

test('检索行为锁定：每文件正文命中 3 行截断、命中后不回退文件名、同 file_id 重复入参计数全局累计', () => {
  const body = Array.from({ length: 10 }, (_, i) => `性能验证行 ${i}`).join('\n');
  const file = makeSearchFixtureFile({
    file_id: 'p3_trunc',
    relative_path: 'p3-fixtures/性能验证.md',
    markdownContent: body,
  });

  const hits = searchWorkspace([file], '性能');
  assert.equal(hits.length, 3); // 每文件正文命中上限 3 条
  assert.ok(hits.every((h) => h.file_id === 'p3_trunc' && h.coverage === 'full_text'));
  assert.ok(hits.every((h) => h.matchStrategy === 'bigram_phrase_verified'));
  assert.ok(hits.every((h) => h.matchStrategy !== 'filename_match')); // 正文已命中不回退
  // 命中按行序取前三条，locator 与 snippet 逐字段保持原语义
  assert.deepEqual(
    hits.map((h) => (h.locator.kind === 'lines' ? [h.locator.start, h.locator.end] : null)),
    [
      [1, 2],
      [1, 3],
      [2, 4],
    ]
  );
  assert.deepEqual(hits.map((h) => h.snippet), ['性能验证行 0', '性能验证行 1', '性能验证行 2']);

  // 同一 file_id 重复出现在入参数组：计数按 file_id 全局累计（3 + 1 = 4），
  // 与原 hits.filter(...).length >= 3 语义逐点一致；若循环内局部重置会错误地输出 3 + 3 = 6
  const duplicated = searchWorkspace([file, file], '性能');
  assert.equal(duplicated.length, 4);
  assert.equal(duplicated.filter((h) => h.matchStrategy !== 'filename_match').length, 4);
});

test('检索行为锁定：无正文命中时 filename_match 回退（locator/snippet 固定输出）', () => {
  const file = makeSearchFixtureFile({
    file_id: 'p3_fnonly',
    relative_path: 'p3-fixtures/年度验收报告.md',
    title: '年度验收报告',
    markdownContent: '正文完全不含检索词\n第二行普通内容',
  });

  const hits = searchWorkspace([file], '验收');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file_id, 'p3_fnonly');
  assert.equal(hits[0].format, 'md');
  assert.equal(hits[0].matchStrategy, 'filename_match');
  assert.equal(hits[0].coverage, 'full_text');
  assert.deepEqual(hits[0].locator, { kind: 'lines', start: 1, end: 5 });
  assert.equal(hits[0].snippet, '文件名命中：p3-fixtures/年度验收报告.md');
  assert.equal(hits[0].stale, false);
});

test('检索行为锁定：matchStrategy 三分支——bigram_phrase_verified / single_char_bounded / exact_code', () => {
  const file = makeSearchFixtureFile({
    file_id: 'p3_strategy',
    relative_path: 'p3-fixtures/策略分支.md',
    markdownContent: ['性能基线说明', '小组讨论记录', 'Q101：待确认事项'].join('\n'),
  });

  // 多字中文词：bigram 候选 + 原文短语核验
  const bigramHits = searchWorkspace([file], '性能');
  assert.equal(bigramHits.length, 1);
  assert.equal(bigramHits[0].matchStrategy, 'bigram_phrase_verified');
  assert.equal(bigramHits[0].snippet, '性能基线说明');

  // 单字：有界回退分支
  const singleHits = searchWorkspace([file], '讨');
  assert.equal(singleHits.length, 1);
  assert.equal(singleHits[0].matchStrategy, 'single_char_bounded');
  assert.equal(singleHits[0].snippet, '小组讨论记录');

  // 编号：q\d+ 精确匹配分支（大小写不敏感）
  const codeHits = searchWorkspace([file], 'q101');
  assert.equal(codeHits.length, 1);
  assert.equal(codeHits[0].matchStrategy, 'exact_code');
  assert.equal(codeHits[0].snippet, 'Q101：待确认事项');
});

test('检索行为锁定：svgExtractedTexts 命中与无文本层 SVG 仅文件名回退', () => {
  const svgWithText = makeSearchFixtureFile({
    file_id: 'p3_svg_text',
    relative_path: 'p3-fixtures/架构图.svg',
    format: 'svg',
    svgExtractedTexts: ['普通文本', '性能与架构设计讨论', '性能复核结论'],
  });

  const textHits = searchWorkspace([svgWithText], '性能');
  assert.equal(textHits.length, 2); // 逐片段命中，不套用每文件 3 行截断
  assert.ok(textHits.every((h) => h.coverage === 'svg_text' && h.format === 'svg'));
  assert.ok(textHits.every((h) => h.matchStrategy === 'bigram_phrase_verified'));
  assert.deepEqual(textHits.map((h) => h.snippet), [
    'SVG 可提取文字命中：「性能与架构设计讨论」',
    'SVG 可提取文字命中：「性能复核结论」',
  ]);
  assert.deepEqual(
    textHits.map((h) => (h.locator.kind === 'svg_text' ? h.locator.fragment : '')),
    ['性能与架构设计讨论', '性能复核结论']
  );

  // 无文本层 SVG：仅文件名可检索
  const svgNoText = makeSearchFixtureFile({
    file_id: 'p3_svg_none',
    relative_path: 'p3-fixtures/历史盖章件.svg',
    format: 'svg',
    svgExtractedTexts: [],
  });
  const noneHits = searchWorkspace([svgNoText], '盖章件');
  assert.equal(noneHits.length, 1);
  assert.equal(noneHits[0].coverage, 'filename_only');
  assert.equal(noneHits[0].matchStrategy, 'filename_match');
  assert.deepEqual(noneHits[0].locator, { kind: 'file' });
  assert.equal(
    noneHits[0].snippet,
    '仅文件名可检索（该 SVG 无内嵌 <text> 文本层）：p3-fixtures/历史盖章件.svg'
  );
});

test('检索行为锁定：contentCache 按 revision_id 参与正文匹配，缺失/版本不符时不产生命中', () => {
  // T01：MD 正文不随 /scan 内联，markdownContent 缺失
  const file = makeSearchFixtureFile({
    file_id: 'p3_cache',
    relative_path: 'p3-fixtures/缓存回退.md',
    markdownContent: undefined,
  });

  // 无缓存：正文源缺失，即使文件名可命中也不产生任何结果
  assert.equal(searchWorkspace([file], '缓存回退').length, 0);

  // 缓存中的 revision_id 与当前版本不符：同样不命中
  const wrongRev = searchWorkspace([file], '缓存回退', undefined, {
    p3_cache_rX: '第一行：缓存回退正文\n第二行',
  });
  assert.equal(wrongRev.length, 0);

  // 按 revision_id 命中缓存正文；snippet 为原行 trim
  const cached = searchWorkspace([file], '缓存回退', undefined, {
    p3_cache_r1: '第一行：缓存回退正文\n  缓存回退缩进行  \n第二行',
  });
  assert.equal(cached.length, 2);
  assert.ok(cached.every((h) => h.revision_id === 'p3_cache_r1' && h.format === 'md'));
  assert.deepEqual(
    cached.map((h) => (h.locator.kind === 'lines' ? [h.locator.start, h.locator.end] : null)),
    [
      [1, 2],
      [1, 3],
    ]
  );
  assert.deepEqual(cached.map((h) => h.snippet), ['第一行：缓存回退正文', '缓存回退缩进行']);
});

test('内容身份：A -> B -> A 恢复旧内容保留三次版本出现，并正确识别回滚', () => {
  const pdmFile = INITIAL_FILES.find((f) => f.file_id === 'file_02')!;
  assert.equal(pdmFile.revisions.length, 3);
  assert.equal(pdmFile.revisions[0].content_sha256, pdmFile.revisions[2].content_sha256);
  assert.notEqual(pdmFile.revisions[0].content_sha256, pdmFile.revisions[1].content_sha256);

  const rollbackCheck = detectRollbackRevision(pdmFile.revisions, 'rev_02_03');
  assert.equal(rollbackCheck.isRollback, true);
  assert.equal(rollbackCheck.matchesEarlierRevisionId, 'rev_02_01');
});

test('版本引用与快照淘汰：快照已淘汰时返回 REVISION_UNAVAILABLE，不冒充当前版本', () => {
  const receiptFile = INITIAL_FILES.find((f) => f.file_id === 'file_03')!;
  const diffRes = computeMarkdownDiff(receiptFile, 'rev_03_01', 'rev_03_02');
  assert.equal(diffRes.ok, false);
  assert.equal(diffRes.errorCode, 'REVISION_UNAVAILABLE');

  const mcpReadRes = executeMcpTool(
    { tool: 'read', params: { file_id: 'file_03', revision_id: 'rev_03_01' } },
    {
      config: INITIAL_WORKSPACE_CONFIG,
      files: INITIAL_FILES,
      events: INITIAL_TIMELINE_EVENTS,
      decisions: INITIAL_DECISIONS,
      relations: INITIAL_RELATIONS,
    }
  );
  assert.equal(mcpReadRes.ok, false);
  assert.equal(mcpReadRes.error_code, 'REVISION_UNAVAILABLE');
});

test('决策准确性：同编号 Q03 按命名空间隔离，“推荐”“不代表验收通过”“代码块示例”不成为已批准，疑似决策不计入待确认数', () => {
  const allQ03 = findDecisionsByCode(INITIAL_DECISIONS, 'Q03');
  assert.equal(allQ03.length, 2);

  const fourSpecQ03 = findDecisionsByCode(
    INITIAL_DECISIONS,
    'Q03',
    '拥抱AI / 四专项待确认事项'
  );
  const oaCollabQ03 = findDecisionsByCode(INITIAL_DECISIONS, 'Q03', '拥抱AI / 办公协同专项');
  assert.equal(fourSpecQ03.length, 1);
  assert.equal(oaCollabQ03.length, 1);
  assert.equal(fourSpecQ03[0].status, '待确认');
  assert.equal(oaCollabQ03[0].status, '已确认');

  // 疑似决策 (isCandidateOnly) 不增加真实待确认计数
  const actionable = getActionablePendingDecisions(INITIAL_DECISIONS);
  assert.equal(actionable.some((d) => d.isCandidateOnly), false);
  assert.equal(actionable.length, 2); // Q01 (来源不一致) + 四专项::Q03 (待确认)

  // 语义边界校验
  assert.equal(
    evaluateDecisionPhraseSemantics('推荐采用选项 B（仅作架构组建议，尚未获业务负责人签批）')
      .inferredStatus,
    '待确认'
  );
  assert.equal(
    evaluateDecisionPhraseSemantics('状态：方案草案（沙箱联调通过，不代表验收通过）')
      .inferredStatus,
    '待确认'
  );
  assert.equal(
    evaluateDecisionPhraseSemantics('- Q99：示例条目（已确认）', true).inferredStatus,
    '非实际状态（限定或示例）'
  );
});

test('访问与内容安全边界：拦截越界路径与清洗危险 SVG 脚本/事件', () => {
  const root = INITIAL_WORKSPACE_CONFIG.rootPath;
  assert.equal(validateRootBoundary(root, '01-方案文档/四专项待确认事项.md').allowed, true);
  assert.equal(validateRootBoundary(root, '../../Windows/System32/cmd.exe').allowed, false);
  assert.equal(validateRootBoundary(root, 'D:\\OtherProject\\secret.md').allowed, false);
  assert.equal(validateRootBoundary(root, '\\\\192.168.1.10\\share\\doc.md').allowed, false);

  const dirtySvg = `<svg onload="alert(1)"><script>fetch("http://evil.com")</script><text>安全节点</text></svg>`;
  const sanitized = sanitizeSvgForPreview(dirtySvg);
  assert.equal(sanitized.sanitizedSvg.includes('<script>'), false);
  assert.equal(sanitized.sanitizedSvg.includes('onload='), false);
  assert.equal(sanitized.removedThreats.length, 2);
});

test('局部关系图与复制给智能体：支持一跳/二跳展开并输出完整定位凭证', () => {
  const g1 = buildLocalRelationGraph(
    'file_01',
    1,
    INITIAL_FILES,
    INITIAL_DECISIONS,
    INITIAL_RELATIONS
  );
  const g2 = buildLocalRelationGraph(
    'file_01',
    2,
    INITIAL_FILES,
    INITIAL_DECISIONS,
    INITIAL_RELATIONS
  );
  assert.ok(g2.nodes.length >= g1.nodes.length);

  const formatted = formatContextForAgent(
    [
      {
        file_id: 'file_01',
        revision_id: 'rev_01_03',
        relative_path: '01-方案文档/四专项待确认事项.md',
        content_sha256: 'c7e329f5d4261a99325160324150693241506932415069324150693241506903',
        locator: { kind: 'lines', start: 16, end: 23 },
        evidence_kind: 'explicit_source',
        index_generation: 42,
        observed_at: '2026-11-05T14:32:00+08:00',
        coverage: 'full_text',
        stale: false,
        excerpt: 'Q01：PDM 物料编码一物多码历史过渡期规则',
      },
    ],
    INITIAL_WORKSPACE_CONFIG.rootPath
  );
  assert.ok(formatted.includes('file_id=file_01'));
  assert.ok(formatted.includes('revision_id=rev_01_03'));
  assert.ok(formatted.includes('Lines 16–23'));

  // 导出时间必须是真实的 Asia/Shanghai 挂钟时间，与 Intl 独立计算一致（容忍跨分钟竞态 1 分钟）。
  // 旧实现 toISOString().replace('Z', '+08:00') 把 UTC 时刻错标成北京时间，差 8 小时。
  const exportedLine = formatted.split('\n').find((l) => l.startsWith('- 导出时间：'))!;
  const m = /- 导出时间：(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \(\+08:00\)$/.exec(exportedLine);
  assert.ok(m, `导出时间行应为「YYYY-MM-DD HH:MM (+08:00)」，实际为：${exportedLine}`);
  const expectedBeijing = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  const actualStamp = `${m[1]} ${m[2]}`;
  const driftMinutes = Math.abs(
    (Date.parse(actualStamp.replace(' ', 'T')) - Date.parse(expectedBeijing.replace(' ', 'T'))) / 60000
  );
  assert.ok(
    driftMinutes <= 1,
    `导出时间应等于此刻北京时间：actual=${actualStamp}, expected=${expectedBeijing}`
  );

  // GU-CC-02：sha256 输出完整 64 位十六进制（原 slice(0,16)+「...」截断让校验凭证形同虚设）
  assert.ok(
    formatted.includes('sha256:c7e329f5d4261a99325160324150693241506932415069324150693241506903'),
    '内容哈希必须逐字输出完整 64 位，不得截断'
  );
  assert.ok(!formatted.includes('...`'), '哈希行不得再带截断省略号');

  // GU-CC-02：唯一输出——本地挂钟手拼的时间字段不得存在（buildStructuredPrompt 已删除，
  // 其「生成于 HH:MM (+08:00)」标记为非 +08:00 时区机器错标 8 小时的来源）；
  // (+08:00) 只允许出现在受上方 Intl 守卫的导出时间行
  assert.ok(!formatted.includes('生成于'), '不得残留本地挂钟手拼时间标记「生成于」');
  assert.equal(
    formatted.split('\n').filter((l) => l.includes('(+08:00)')).length,
    1,
    '(+08:00) 只允许出现在导出时间行'
  );
});

// GU-CC-02：统一证据导出器契约——单一函数单一字符串（「复制」「生成结构化 Prompt」、
// RightInspector 入口全部经由 formatContextForAgent），sha256 全长、摘录逐字不截断
test('GU-CC-02 统一导出器：sha256 完整 64 位、摘录逐字不截断、整文件凭证与指针字段一致', () => {
  // 真实形态的 64 位十六进制（空串 sha256）
  const sha64 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  // >120 字且含换行的摘录：旧的 buildStructuredPrompt 会 slice(0,120) 截断，
  // 统一导出器必须逐字完整输出（完整性优先，折叠/上限策略延后到积压）
  const longExcerpt =
    '这是一段超过一百二十字的证据摘录，用于证明统一导出器不再做 slice(0, 120) 截断：' +
    '观澜把每一次版本变化都变成可溯源事件。'.repeat(8) +
    '\n第二行也必须逐字完整出现。';
  const pointer = {
    file_id: 'f_gucc02',
    revision_id: 'rev_gucc02_a',
    relative_path: '01-方案文档/gu-cc-02.md',
    content_sha256: sha64,
    locator: { kind: 'file' as const },
    evidence_kind: 'explicit_source' as const,
    index_generation: 7,
    observed_at: '2026-11-12T09:30:00+08:00',
    coverage: 'full_text' as const,
    stale: false,
    excerpt: longExcerpt,
  };
  const out = formatContextForAgent([pointer], INITIAL_WORKSPACE_CONFIG.rootPath);

  // 指针字段逐字出现且一致（验收 2）
  assert.ok(out.includes(`sha256:${sha64}`), '完整 64 位 sha256 必须逐字出现');
  assert.ok(!out.includes(`${sha64.slice(0, 16)}...`), '不得残留 16 位截断形态');
  assert.ok(out.includes('file_id=f_gucc02'));
  assert.ok(out.includes('revision_id=rev_gucc02_a'));
  assert.ok(out.includes('Full File'), "locator.kind === 'file' 输出整文件定位段");
  assert.ok(out.includes(`\`${pointer.observed_at}\``), '观察时间逐字出现');

  // 摘录逐字不截断（验收 5）：整块引用（含换行续引）与输入一致
  assert.ok(
    out.includes(`> ${longExcerpt.replace(/\n/g, '\n> ')}`),
    '摘录必须逐字完整出现（含换行续引），不得 slice 截断'
  );
  assert.ok(out.length > 200, '导出文本长度应容纳完整摘录');

  // 空摘录诚实化：内容不可用时不输出空引用行、不虚构占位文本
  const emptyOut = formatContextForAgent(
    [{ ...pointer, excerpt: '' }],
    INITIAL_WORKSPACE_CONFIG.rootPath
  );
  assert.ok(!emptyOut.includes('\n> '), '无可用正文时不得输出空引用块');
});

test('Graph 节点悬停预览与动态拖拽连线计算：返回核心结论摘要、未读变化状态、修改轮次与实时贝塞尔路径', () => {
  const file01 = INITIAL_FILES.find((f) => f.file_id === 'file_01')!;
  const preview = buildNodeHoverPreviewData(file01, INITIAL_READING_STATES.file_01);
  assert.equal(preview.fileId, 'file_01');
  assert.equal(preview.unreadStatus.isUnread, true);
  // 修改轮次标签必须来自修订记录真实的 agent_turn_hint（夹具见第 210 行），
  // 引擎不虚构“第 N 轮”式文案（见 guanlanEngine.ts 悬停预览注释）
  assert.ok(preview.modificationRoundLabel.includes('轮次 #15'));
  assert.ok(preview.coreSummary.includes('3 项显式决策事项'));
  assert.ok(preview.unreadStatus.changedSections.length > 0);

  // 已读最新版本的节点（file_03）应显示 isUnread === false → 『已读最新』
  const file03 = INITIAL_FILES.find((f) => f.file_id === 'file_03')!;
  const previewRead = buildNodeHoverPreviewData(file03, INITIAL_READING_STATES.file_03);
  assert.equal(previewRead.unreadStatus.isUnread, false);
  assert.equal(previewRead.unreadStatus.statusLabel, '已读最新');

  const pathStr = computeDynamicEdgePath({ x: 406, y: 220 }, { x: 520, y: 280 }, 'trunk_to_subagent');
  assert.ok(pathStr.startsWith('M 406 220 C '));

  const bounds = computeFanOutBounds(
    [
      { x: 432, y: 238, width: 164, height: 74 },
      { x: 650, y: 500, width: 164, height: 74 },
    ],
    false
  );
  assert.ok(bounds.width >= 380);
  assert.ok(bounds.height >= 340);
});

// ---------- GL-01：未读三态文案单一出口 ----------

test('GL-01 unreadStatusLabel：三态映射正确，never_read 不含「上次读」字样', () => {
  // D02 术语两态统一：未读新件（首次收录）/ 读后有更新（读后变更）——绝不混同
  assert.equal(unreadStatusLabel('never_read'), '未读新件（尚未建立阅读基线）');
  assert.equal(unreadStatusLabel('updated_since_last_read'), '读后有更新');
  assert.equal(unreadStatusLabel('up_to_date'), '已读最新');
  assert.ok(
    !unreadStatusLabel('never_read').includes('上次读'),
    '从未读过不存在“上次读”，文案不得谎称'
  );
  assert.ok(
    !unreadStatusLabel('never_read').includes('读后有更新') &&
      !unreadStatusLabel('updated_since_last_read').includes('未读新件'),
    '两态措辞互斥：首次收录与读后变更不得混同（D02 停机条件）'
  );
});

test('GL-01 未读文案按 reason 渲染：右栏与悬停预览共用同一措辞', () => {
  const file01 = INITIAL_FILES.find((f) => f.file_id === 'file_01')!;

  // 从未建立阅读基线 → never_read（右栏用 unreadStatusLabel(unreadInfo.reason) 渲染此值）
  const never = hasUnreadChanges(file01);
  assert.equal(never.reason, 'never_read');
  assert.equal(unreadStatusLabel(never.reason), '未读新件（尚未建立阅读基线）');

  // 读后有更新 → updated_since_last_read
  const updated = hasUnreadChanges(file01, INITIAL_READING_STATES.file_01);
  assert.equal(updated.reason, 'updated_since_last_read');
  assert.equal(unreadStatusLabel(updated.reason), '读后有更新');

  // 已读最新 → up_to_date
  const file03 = INITIAL_FILES.find((f) => f.file_id === 'file_03')!;
  const upToDate = hasUnreadChanges(file03, INITIAL_READING_STATES.file_03);
  assert.equal(upToDate.reason, 'up_to_date');
  assert.equal(unreadStatusLabel(upToDate.reason), '已读最新');

  // 悬停预览与右栏同源：同一 reason 得到同一措辞（不再维护第二套文案）
  assert.equal(
    buildNodeHoverPreviewData(file01, INITIAL_READING_STATES.file_01).unreadStatus.statusLabel,
    unreadStatusLabel(updated.reason)
  );
  assert.equal(
    buildNodeHoverPreviewData(file01).unreadStatus.statusLabel,
    unreadStatusLabel(never.reason)
  );
});

test('GL-01 组件断言：右栏按 reason 如实渲染 never_read 与读后更新两种文案', () => {
  const file: FileRecord = {
    file_id: 'f_gl01',
    relative_path: 'gl/right-inspector.md',
    title: '右栏未读文案',
    format: 'md',
    folder: 'gl',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'r2',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'r1', file_id: 'f_gl01', versionNumber: 1, content_sha256: 'h1',
        observed_at: '2026-11-01T10:00:00+08:00', sizeBytes: 10, snapshotAvailable: true,
        summaryNote: 'v1', markdownContent: '# A\n## x\n1',
      },
      {
        revision_id: 'r2', file_id: 'f_gl01', versionNumber: 2, content_sha256: 'h2',
        observed_at: '2026-11-02T10:00:00+08:00', sizeBytes: 10, snapshotAvailable: true,
        summaryNote: 'v2', markdownContent: '# A\n## x\n2',
      },
    ],
  };
  const baseProps = {
    selectedFile: file,
    files: [file],
    decisions: [],
    relations: [],
    onSavePersonalNote: () => {},
    onOpenFile: () => {},
    onOpenDecision: () => {},
    onViewRelationsGraph: () => {},
    onCopyObjectToAgent: async () => true,
    indexGeneration: 1,
  };

  // 从未建立阅读基线：右栏必须说真话，不得出现「读后有更新」（D02 两态互斥）
  const neverHtml = renderToStaticMarkup(React.createElement(RightInspector, baseProps));
  assert.ok(neverHtml.includes('未读新件（尚未建立阅读基线）'));
  assert.ok(!neverHtml.includes('读后有更新'));

  // 读后有更新：渲染「读后有更新」
  const readingState: ReadingState = {
    file_id: 'f_gl01',
    last_read_revision_id: 'r1',
    scrollPercent: 0,
    isFullyRead: false,
    bookmarked: false,
    updated_at: '2026-11-01T11:00:00+08:00',
  };
  const updatedHtml = renderToStaticMarkup(
    React.createElement(RightInspector, { ...baseProps, readingState })
  );
  assert.ok(updatedHtml.includes('读后有更新'));
  assert.ok(!updatedHtml.includes('未读新件（尚未建立阅读基线）'));
});

