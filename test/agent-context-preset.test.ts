/**
 * 智能体上下文三入口默认包 + 双模导出单元测试。
 *
 * - 三入口意图推导与默认包（典型工作区已选 ≥2）；
 * - 推荐挂载 reason 词表与确定性排序（本文引用 > 同专项引用 > 命名关联）；
 * - 模式 A <guanlan_context> 结构（objective/confirmed_decisions/pending_blockers
 *   count/reference_files count/writeback_protocol）；
 * - 模式 B guanlan-mcp/v1 载荷形状（uri/hash 前 16 位/4 工具/guardrails）；
 * - mcp.json 模板（GUANLAN_ENDPOINT + serve --port 提示）。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildAgentContextPreset,
  buildIntentTemplate,
  deriveAgentContextIntent,
  type PresetPackageInfo,
  type PresetUnresolvedDecision,
} from '../src/utils/agentContextPresets';
import {
  buildGuanlanContextMarkdown,
  buildMcpJsonConfig,
  buildMcpPayload,
  GUANLAN_MCP_ALLOWED_TOOLS,
  GUANLAN_MCP_DEFAULT_ENDPOINT,
  WRITEBACK_PROTOCOL_TEXT,
} from '../src/utils/agentContextExport';

// ---------- 夹具（04-智能体代码 / BOM与图纸联动方案） ----------

const PKG_04: PresetPackageInfo = {
  id: '04-智能体代码',
  name: '04-智能体代码',
  stage: '执行',
  lastActivity: '2026-11-18T01:00:00Z',
  eventCount: 20,
  docIds: ['readme_04', 'bom_doc', 'todo_03', 'impl_doc'],
  coreDocId: 'readme_04',
  stageDocIds: ['impl_doc'],
};
const PKG_08: PresetPackageInfo = {
  id: '08-数据格式规范',
  name: '08-数据格式规范',
  stage: '计划',
  lastActivity: '2026-11-17T09:00:00Z',
  eventCount: 5,
  docIds: ['readme_08', 'field_map'],
  coreDocId: 'readme_08',
  stageDocIds: ['field_map'],
};
const PKG_IDLE: PresetPackageInfo = {
  id: '02-空闲包',
  name: '02-空闲包',
  stage: '待分类',
  lastActivity: '',
  eventCount: 0,
  docIds: ['idle_doc'],
  stageDocIds: [],
};
const DECISIONS: PresetUnresolvedDecision[] = [
  { decisionId: 'dec_1', fileId: 'todo_03', code: 'D-01', question: '属性字典与历史更新策略', isBlocking: true },
  { decisionId: 'dec_2', fileId: 'bom_doc', code: 'D-02', question: '流程条件与生命周期', isBlocking: true },
  { decisionId: 'dec_3', fileId: 'field_map', code: 'D-03', question: '字段映射口径', isBlocking: false },
];

describe('deriveAgentContextIntent 三入口推导', () => {
  test('文档正文页 / 专项详情 / 首页总览', () => {
    assert.equal(deriveAgentContextIntent({ activeFileId: 'bom_doc', activePackage: PKG_04, packages: [], unresolvedDecisions: [] }), 'document');
    assert.equal(deriveAgentContextIntent({ activeFileId: null, activePackage: PKG_04, packages: [], unresolvedDecisions: [] }), 'initiative');
    assert.equal(deriveAgentContextIntent({ activeFileId: null, activePackage: null, packages: [PKG_04], unresolvedDecisions: [] }), 'global');
  });

  test('意图模板逐字', () => {
    assert.equal(buildIntentTemplate('document'), '基于当前方案文档与未决约束，推进下一阶段执行/代码实现');
    assert.equal(
      buildIntentTemplate('initiative', '04-智能体代码'),
      '接管专项 [04-智能体代码] 当前阶段长任务，检视卡点并输出推进计划'
    );
    assert.equal(buildIntentTemplate('global'), '全局工程状态巡检与今日高优长任务拆解');
  });
});

describe('buildAgentContextPreset 三入口默认包（已选 ≥2）', () => {
  test('文档正文页：当前文档全文 + 包核心摘要 + 包域未决事项（decisions_only）', () => {
    const preset = buildAgentContextPreset({
      activeFileId: 'bom_doc',
      activePackage: PKG_04,
      packages: [PKG_04, PKG_08, PKG_IDLE],
      unresolvedDecisions: DECISIONS,
      relations: [],
    });
    assert.equal(preset.intent, 'document');
    // 1. 当前文档 full；2. 包核心（readme_04）summary；3. 包域未决（todo_03/bom_doc）decisions_only
    assert.deepEqual(preset.items, [
      { fileId: 'bom_doc', granularity: 'full' },
      { fileId: 'readme_04', granularity: 'summary' },
      { fileId: 'todo_03', granularity: 'decisions_only' },
    ]);
    assert.equal(preset.meetsAc04, true);
  });

  test('专项详情：各阶段定版摘要 + 当前阶段全文 + 全部未决', () => {
    const preset = buildAgentContextPreset({
      activeFileId: null,
      activePackage: PKG_04,
      packages: [PKG_04],
      unresolvedDecisions: DECISIONS,
    });
    assert.equal(preset.intent, 'initiative');
    const granularities = new Map(preset.items.map((it) => [it.fileId, it.granularity]));
    // 定版摘要（阅读顺序前 6）
    assert.equal(granularities.get('readme_04'), 'summary');
    // bom_doc 同时命中定版摘要与未决事项 → 粒度优先级取高档（decisions_only > summary）
    assert.equal(granularities.get('bom_doc'), 'decisions_only');
    // 当前阶段全量正文
    assert.equal(granularities.get('impl_doc'), 'full');
    // 全部未决
    assert.equal(granularities.get('todo_03'), 'decisions_only');
    assert.equal(preset.meetsAc04, true);
  });

  test('首页总览：Top-3 活跃包核心摘要（lastActivity 降序）+ 全局阻塞事项', () => {
    const preset = buildAgentContextPreset({
      activeFileId: null,
      activePackage: null,
      packages: [PKG_04, PKG_08, PKG_IDLE],
      unresolvedDecisions: DECISIONS,
    });
    assert.equal(preset.intent, 'global');
    // Top-3 = PKG_04(11-18) > PKG_08(11-17) > PKG_IDLE(无活动垫底)——仅三个包时 IDLE 也在列
    assert.deepEqual(preset.items, [
      { fileId: 'readme_04', granularity: 'summary' },
      { fileId: 'readme_08', granularity: 'summary' },
      { fileId: 'idle_doc', granularity: 'summary' },
      { fileId: 'todo_03', granularity: 'decisions_only' },
      { fileId: 'bom_doc', granularity: 'decisions_only' },
    ]);
    // 全局汇总只收阻塞项（isBlocking=true）：dec_3（field_map，非阻塞）不进
    assert.ok(!preset.items.some((it) => it.fileId === 'field_map'));
  });

  test('首页总览：活跃包 >3 时无活动包被挤出 Top-3', () => {
    const hotFourth: PresetPackageInfo = {
      ...PKG_IDLE,
      id: '09-热点包',
      name: '09-热点包',
      lastActivity: '2026-11-16T08:00:00Z',
      eventCount: 9,
      docIds: ['hot_doc'],
    };
    const preset = buildAgentContextPreset({
      activeFileId: null,
      activePackage: null,
      packages: [PKG_04, PKG_08, PKG_IDLE, hotFourth],
      unresolvedDecisions: [],
    });
    // PKG_04 > PKG_08 > 09-热点包(11-16) > PKG_IDLE(无活动)——IDLE 被挤出
    assert.deepEqual(
      preset.items.map((it) => it.fileId),
      ['readme_04', 'readme_08', 'hot_doc']
    );
  });

  test('单文档退化工作区如实 meetsAc04=false（不造假条目）', () => {
    const lonely: PresetPackageInfo = { ...PKG_IDLE, docIds: ['idle_doc'] };
    const preset = buildAgentContextPreset({
      activeFileId: 'idle_doc',
      activePackage: lonely,
      packages: [lonely],
      unresolvedDecisions: [],
    });
    assert.deepEqual(preset.items, [{ fileId: 'idle_doc', granularity: 'full' }]);
    assert.equal(preset.meetsAc04, false);
  });

  test('推荐挂载：排除默认勾选、reason 排序（本文引用 > 同专项引用 > 命名关联）、去重、cap 6', () => {
    const preset = buildAgentContextPreset({
      activeFileId: 'bom_doc',
      activePackage: PKG_04,
      packages: [PKG_04, PKG_08, PKG_IDLE],
      unresolvedDecisions: [],
      relations: [
        { sourceFileId: 'bom_doc', targetFileId: 'readme_04' }, // 已在默认包（核心摘要）→ 排除
        { sourceFileId: 'bom_doc', targetFileId: 'field_map' }, // 出边跨包 → 本文引用
        { sourceFileId: 'idle_doc', targetFileId: 'bom_doc' }, // 入边 → 同包？idle_doc 不在包 → 命名关联
        { sourceFileId: 'impl_doc', targetFileId: 'bom_doc' }, // 入边、同包 → 同专项引用
        { sourceFileId: 'bom_doc', targetFileId: 'todo_03' }, // 出边（本测例无未决→todo_03 不在默认包）→ 本文引用
      ],
    });
    assert.deepEqual(
      preset.recommended.map((r) => [r.fileId, r.reason]),
      [
        ['field_map', '本文引用'],
        ['todo_03', '本文引用'],
        ['impl_doc', '同专项引用'],
        ['idle_doc', '命名关联'],
      ]
    );
  });
});

describe('模式 A：<guanlan_context> 结构化清单', () => {
  const markdown = buildGuanlanContextMarkdown({
    workspaceRoot: 'D:\\workspace\\guanlan-project',
    initiative: { name: '04-智能体代码', stage: '执行' },
    confirmedDecisions: [
      {
        priority: 'P1',
        statusLabel: '已确认',
        text: '流程条件与生命周期：采用两阶段状态锁',
        confirmer: '架构组',
        effectiveDate: '2026-11-18',
      },
    ],
    pendingBlockers: [
      {
        priority: 'P1',
        statusLabel: '待确认',
        text: '属性字典与历史更新策略',
        fileRef: 'docs/04-智能体代码/03-待确认事项.md#L42',
      },
    ],
    referenceFiles: [
      { path: 'docs/04-智能体代码/README.md', granularityLabel: '全文', versionLabel: 'v2', stateLabel: '选中修订' },
      { path: 'docs/08-数据格式规范/字段映射表.md', granularityLabel: '摘要' },
    ],
  });

  test('根标签属性 + 五段结构齐备（路径+粒度标识）', () => {
    assert.ok(markdown.includes('<guanlan_context workspace="D:\\workspace\\guanlan-project" initiative="04-智能体代码" stage="执行">'));
    assert.ok(markdown.includes('<objective>'));
    assert.ok(markdown.includes('<confirmed_decisions>'));
    assert.ok(markdown.includes('<pending_blockers count="1">'));
    assert.ok(markdown.includes('<reference_files count="2">'));
    assert.ok(markdown.includes('<writeback_protocol>'));
    assert.ok(markdown.trimEnd().endsWith('</guanlan_context>'));
  });

  test('决策/卡点/引用行格式逐字（[P1-已确认]…（确认人：…，生效日期：…））', () => {
    assert.ok(markdown.includes('- [P1-已确认] 流程条件与生命周期：采用两阶段状态锁（确认人：架构组，生效日期：2026-11-18）'));
    assert.ok(markdown.includes('- [P1-待确认] 属性字典与历史更新策略（文件路径：docs/04-智能体代码/03-待确认事项.md#L42）'));
    assert.ok(markdown.includes('1. [全文] docs/04-智能体代码/README.md (v2 · 选中修订)'));
    assert.ok(markdown.includes('2. [摘要] docs/08-数据格式规范/字段映射表.md'));
  });

  test('writeback_protocol 逐字 + 空集合段体为空、count=0', () => {
    assert.ok(markdown.includes(WRITEBACK_PROTOCOL_TEXT));
    const empty = buildGuanlanContextMarkdown({
      workspaceRoot: 'D:\\ws',
      initiative: null,
      confirmedDecisions: [],
      pendingBlockers: [],
      referenceFiles: [],
    });
    assert.ok(empty.includes('<pending_blockers count="0">'));
    assert.ok(empty.includes('<reference_files count="0">'));
    assert.ok(!empty.includes('workspace_root'));
  });
});

describe('模式 B：guanlan-mcp/v1 载荷与 mcp.json', () => {
  const payload = buildMcpPayload({
    workspaceRoot: 'D:\\workspace\\guanlan-project',
    initiative: { id: 'init_04_agent_code', name: '04-智能体代码', stage: '执行' },
    contextBundle: [
      { path: 'docs/04-智能体代码/03-待确认事项.md', granularity: 'full', versionLabel: 'v1', contentHash: '8f94e2abcdef1234567890' },
      { path: 'docs/08-数据格式规范/字段映射表.md', granularity: 'summary', versionLabel: 'v3' },
    ],
    sessionCheckpointId: null,
  });

  test('协议/根/专项/context_bundle（uri=guanlan://、hash=sha256:<前16>）', () => {
    assert.equal(payload.protocol, 'guanlan-mcp/v1');
    assert.equal(payload.workspace_root, 'D:\\workspace\\guanlan-project');
    assert.deepEqual(payload.initiative, { id: 'init_04_agent_code', name: '04-智能体代码', current_stage: '执行' });
    assert.equal(payload.context_bundle[0].uri, 'guanlan://docs/04-智能体代码/03-待确认事项.md');
    assert.equal(payload.context_bundle[0].hash, 'sha256:8f94e2abcdef1234');
    assert.equal(payload.context_bundle[1].version, 'v3');
    assert.equal(payload.session_checkpoint_id, null);
  });

  test('4 工具白名单 + guardrails', () => {
    assert.deepEqual(payload.allowed_mcp_tools, [...GUANLAN_MCP_ALLOWED_TOOLS]);
    assert.deepEqual(payload.guardrails, {
      block_write_on_unresolved_p0: true,
      require_version_bump: true,
    });
    assert.deepEqual(GUANLAN_MCP_ALLOWED_TOOLS, [
      'guanlan.read_artifact',
      'guanlan.propose_revision',
      'guanlan.resolve_decision',
      'guanlan.commit_checkpoint',
    ]);
  });

  test('mcp.json：guanlan mcp stdio + GUANLAN_ENDPOINT（缺省端点 + serve --port 提示）', () => {
    const config = buildMcpJsonConfig();
    assert.ok(config.includes('"command": "guanlan"'));
    assert.ok(config.includes('"args": [\n    "mcp"\n  ]') || config.includes('"mcp"'));
    assert.ok(config.includes(`"GUANLAN_ENDPOINT": "${GUANLAN_MCP_DEFAULT_ENDPOINT}"`));
    assert.equal(GUANLAN_MCP_DEFAULT_ENDPOINT, 'http://127.0.0.1:39120');
    assert.ok(config.includes('serve --port 39120'));
    // 自定义端点可注入（用户显式指定时以权威 stdout 值为准）
    const custom = buildMcpJsonConfig('http://127.0.0.1:50000');
    assert.ok(custom.includes('"GUANLAN_ENDPOINT": "http://127.0.0.1:50000"'));
  });
});
