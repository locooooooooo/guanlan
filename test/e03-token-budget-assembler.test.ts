/**
 * Token 预算感知组装器与零冷启动交接前端契约单测。
 *
 * 覆盖：
 *  1. 停机红线护栏：密钥/环境变量脱敏器（PEM/API Key/Bearer/URL 密码/.env 路径拦截）与零误杀；
 *  2. 四档注入粒度（全文 / 仅大纲与结论 / 仅变更 Diff / 仅元数据路径）字符与 Token 预算递减；
 *  3. 本机三大宿主（ZCode / Claude Code / Cursor）.mcp.json 零冷启动生成与无损合并（绝不混入环境变量）；
 *  4. AgentContextDrawer SSR：预览区与服务端 POST /api/v1/context（同 MCP get_context_bundle）逐字节同源一致，
 *     展示四档粒度切换钮、实时字符+Token 预算、上游规范引用片段、脱敏护栏提示与三宿主配置入口。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentContextDrawer } from '../src/components/ModalsAndDrawers';
import type { ContextResponse } from '../src/services/apiTypes';
import type { EvidencePointer } from '../src/types/guanlan';
import {
  computeTokenBudget,
  DIFF_ONLY_GRANULARITY_FACTOR,
  estimateItemChars,
  estimateItemTokens,
  METADATA_ONLY_GRANULARITY_FACTOR,
} from '../src/utils/contextBudget';
import {
  isSensitiveSecretPath,
  REDACTED_SECRET_MARKER,
  sanitizeContextText,
} from '../src/utils/contextSanitizer';
import {
  buildGuanlanContextMarkdown,
  buildHostMcpJsonConfig,
  MCP_HOST_TARGETS,
  mergeMcpHostConfigJson,
  normalizeLoopbackEndpoint,
} from '../src/utils/agentContextExport';

describe('停机红线护栏：本机密钥与环境变量脱敏器', () => {
  test('精准拦截 API Key / Bearer / URL 密码 / PEM 私钥 / .env 赋值，普通哈希与占位符零误杀', () => {
    const raw = [
      '# 架构说明',
      '正常内容哈希：sha256:0123456789abcdef',
      'OPENAI_API_KEY=sk-proj-TestLeakSecret1234567890abcdef',
      'export GITHUB_TOKEN=ghp_1234567890abcdefghij1234567890abcd',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.body.sig',
      'DATABASE_URL=postgres://root:TopSecretPass88@10.0.0.5:5432/app',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw',
      '-----END PRIVATE KEY-----',
      'API_KEY=<your-key>',
    ].join('\n');
    const { text, redactedCount } = sanitizeContextText(raw);
    assert.ok(redactedCount >= 5, `应至少拦截 5 处敏感凭证，实际 ${redactedCount}`);
    assert.ok(!text.includes('sk-proj-TestLeakSecret'));
    assert.ok(!text.includes('ghp_1234567890'));
    assert.ok(!text.includes('eyJhbGciOiJIUzI1Ni'));
    assert.ok(!text.includes('TopSecretPass88'));
    assert.ok(!text.includes('MIIEvQIBADANBg'));
    assert.ok(text.includes('sha256:0123456789abcdef'), '内容哈希不可误杀');
    assert.ok(text.includes('API_KEY=<your-key>'), '显式占位符允许保留');
    assert.ok(text.includes(REDACTED_SECRET_MARKER));
  });

  test('敏感路径拦截（.env / *.pem / *.key / .ssh），示例模板与正常文档放行', () => {
    assert.equal(isSensitiveSecretPath('.env'), true);
    assert.equal(isSensitiveSecretPath('deploy/.env.production'), true);
    assert.equal(isSensitiveSecretPath('certs/server.pem'), true);
    assert.equal(isSensitiveSecretPath('keys/id_ed25519'), true);
    assert.equal(isSensitiveSecretPath('.env.example'), false);
    assert.equal(isSensitiveSecretPath('02-上下文引擎/01-架构规范.md'), false);
  });

  test('离线降级 buildGuanlanContextMarkdown 也强制过脱敏护栏', () => {
    const md = buildGuanlanContextMarkdown({
      workspaceRoot: 'H:/ws',
      initiative: { name: '02-上下文引擎', stage: '执行' },
      objective: '使用 OPENAI_API_KEY=sk-proj-NeverLeakThisSecret1234567890 调试',
      confirmedDecisions: [],
      pendingBlockers: [],
      referenceFiles: [{ path: 'docs/a.md', granularityLabel: '仅变更 Diff' }],
    });
    assert.ok(!md.includes('NeverLeakThisSecret'));
    assert.ok(md.includes(REDACTED_SECRET_MARKER));
    assert.ok(md.includes('[仅变更 Diff] docs/a.md'));
  });
});

describe('四档注入粒度字符与 Token 实时预算', () => {
  test('full > summary > diff_only > metadata_only 严格递减，附带 estChars', () => {
    assert.equal(DIFF_ONLY_GRANULARITY_FACTOR, 0.15);
    assert.equal(METADATA_ONLY_GRANULARITY_FACTOR, 0.02);
    const sizeBytes = 35_000;
    const tFull = estimateItemTokens({ fileId: 'f', granularity: 'full', sizeBytes });
    const tSummary = estimateItemTokens({ fileId: 'f', granularity: 'summary', sizeBytes });
    const tDiff = estimateItemTokens({ fileId: 'f', granularity: 'diff_only', sizeBytes });
    const tMeta = estimateItemTokens({ fileId: 'f', granularity: 'metadata_only', sizeBytes });
    assert.ok(tFull > tSummary && tSummary > tDiff && tDiff > tMeta);

    const cFull = estimateItemChars({ fileId: 'f', granularity: 'full', sizeBytes });
    const cMeta = estimateItemChars({ fileId: 'f', granularity: 'metadata_only', sizeBytes });
    assert.ok(cFull > cMeta && cMeta > 0);

    const budget = computeTokenBudget([
      { fileId: 'a', granularity: 'full', sizeBytes: 7000 },
      { fileId: 'b', granularity: 'diff_only', sizeBytes: 7000 },
      { fileId: 'c', granularity: 'metadata_only', sizeBytes: 7000 },
    ]);
    assert.equal(budget.selected, 3);
    assert.ok((budget.estChars ?? 0) > 0);
    assert.equal(budget.overThreshold, false);
  });
});

describe('三大宿主 .mcp.json 零冷启动生成与无损合并', () => {
  test('覆盖 ZCode / Claude Code / Cursor 三宿主，env 严格只含 GUANLAN_ENDPOINT', () => {
    assert.deepEqual(
      MCP_HOST_TARGETS.map((h) => [h.id, h.targetPath]),
      [
        ['zcode', '.mcp.json'],
        ['claude_code', '.mcp.json'],
        ['cursor', '.cursor/mcp.json'],
      ]
    );

    const claudeCfg = JSON.parse(buildHostMcpJsonConfig('claude_code', 'http://127.0.0.1:42000'));
    assert.equal(claudeCfg.mcpServers.guanlan.type, 'stdio');
    assert.deepEqual(Object.keys(claudeCfg.mcpServers.guanlan.env), ['GUANLAN_ENDPOINT']);
    assert.equal(claudeCfg.mcpServers.guanlan.env.GUANLAN_ENDPOINT, 'http://127.0.0.1:42000');

    // 无损合并既有宿主配置，不丢其他 MCP server
    const merged = mergeMcpHostConfigJson(
      JSON.stringify({ mcpServers: { existing: { command: 'npx', args: ['-y', 'demo'] } } }),
      'cursor',
      'http://127.0.0.1:42000'
    );
    assert.equal(merged.ok, true);
    if (merged.ok) {
      assert.equal(merged.mergedExisting, true);
      const parsed = JSON.parse(merged.json);
      assert.equal(parsed.mcpServers.existing.command, 'npx');
      assert.equal(parsed.mcpServers.guanlan.command, 'guanlan');
    }

    // 停机护栏：拒绝非回环地址与损坏 JSON
    assert.equal(normalizeLoopbackEndpoint('https://remote.example:443'), null);
    const badRemote = mergeMcpHostConfigJson(null, 'zcode', 'https://remote.example:443');
    assert.equal(badRemote.ok, false);
    const badJson = mergeMcpHostConfigJson('{broken json', 'zcode', 'http://127.0.0.1:39120');
    assert.equal(badJson.ok, false);
  });
});

describe('AgentContextDrawer 服务端逐字节同源与四档粒度 UI', () => {
  const pointer: EvidencePointer = {
    file_id: 'f_plan',
    revision_id: 'rev_f_plan_r2',
    relative_path: '02-上下文引擎/02-实施计划.md',
    content_sha256: '0123456789abcdef0123456789abcdef',
    locator: { kind: 'file' },
    evidence_kind: 'metadata_only',
    index_generation: 9,
    observed_at: '2026-11-21T14:00:00Z',
    coverage: 'full_text',
    stale: false,
    excerpt: '实施计划核心结论',
    granularity: 'diff_only',
    sizeBytes: 4200,
  };

  const serverCanonicalMarkdown =
    '<guanlan_context workspace="H:/ws" initiative="02-上下文引擎" stage="执行">\n' +
    '  <objective>\n    基于服务端同源包推进上下文组装实施\n  </objective>\n' +
    '  <upstream_references count="1">\n' +
    '    <reference path="02-上下文引擎/01-系统架构规范.md" version="v1" relation="explicit_reference">\n' +
    '      结论：全部写回须过 CAS 与脱敏护栏。\n' +
    '    </reference>\n' +
    '  </upstream_references>\n' +
    '  <reference_files count="1">\n' +
    '    1. [仅变更 Diff] 02-上下文引擎/02-实施计划.md (v2 · 选中修订)\n' +
    '  </reference_files>\n' +
    '</guanlan_context>\n';

  const serverContext: ContextResponse = {
    ok: true,
    index_generation: 9,
    intent: 'document',
    workspace_root: 'H:/ws',
    initiative_id: 'init_02',
    preset: {
      items: [
        {
          file_id: 'f_plan',
          path: '02-上下文引擎/02-实施计划.md',
          title: '02-实施计划',
          revision_id: 'rev_f_plan_r2',
          seq: 2,
          version_label: 'v2',
          content_hash: '0123456789abcdef0123456789abcdef',
          state: 'approved_revision',
          granularity: 'diff_only',
          snapshot_available: true,
          est_chars: 320,
          est_tokens: 118,
          content: null,
          snippet: '+ 新增四档注入粒度',
        },
      ],
      recommended: [],
    },
    decisions: { pending: [], confirmed: [] },
    upstream_snippets: [
      {
        file_id: 'f_spec',
        path: '02-上下文引擎/01-系统架构规范.md',
        title: '01-系统架构规范',
        version_label: 'v1',
        content_hash: 'fedcba9876543210fedcba9876543210',
        relation_type: 'explicit_reference',
        reason: '显式引用上游规范',
        snippet: '结论：全部写回须过 CAS 与脱敏护栏。',
        est_chars: 18,
        est_tokens: 12,
      },
    ],
    token_budget: {
      selected: 1,
      est_chars: 338,
      est_tokens: 130,
      threshold: 65536,
      over_threshold: false,
      downgrade_suggestions: [],
    },
    redacted_secrets_count: 2,
    markdown: serverCanonicalMarkdown,
    payload: {
      protocol: 'guanlan-mcp/v1',
      session_checkpoint_id: null,
      workspace_root: 'H:/ws',
      initiative: { id: 'init_02', name: '02-上下文引擎', current_stage: '执行' },
      context_bundle: [
        {
          uri: 'guanlan://02-上下文引擎/02-实施计划.md',
          granularity: 'diff_only',
          version: 'v2',
          hash: 'sha256:0123456789abcdef',
        },
      ],
      allowed_mcp_tools: [
        'guanlan.read_artifact',
        'guanlan.propose_revision',
        'guanlan.resolve_decision',
        'guanlan.commit_checkpoint',
      ],
      guardrails: { block_write_on_unresolved_p0: true, require_version_bump: true },
    },
  };

  test('SSR 预览区与服务端同源输出逐字节一致，并完整呈递四档粒度、上游规范、脱敏提示与三宿主', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentContextDrawer, {
        isOpen: true,
        onClose: () => {},
        pointers: [pointer],
        onRemovePointer: () => {},
        onClearPointers: () => {},
        workspaceRoot: 'H:/ws',
        focusFileId: 'f_plan',
        initiative: { id: 'init_02', name: '02-上下文引擎', stage: '执行' },
        sessionCheckpointId: null,
        referenceMetaOf: () => ({ versionLabel: 'v2', stateLabel: '选中修订' }),
        intent: 'document',
        intentTemplate: '基于当前方案文档与未决约束，推进下一阶段执行/代码实现',
        presetPointers: [pointer],
        recommendedMounts: [],
        onMountPointers: () => {},
        onUpdatePointerGranularity: () => {},
        confirmedDecisions: [],
        pendingBlockers: [],
        decisionChangeNote: null,
        initialServerContext: serverContext,
      })
    );

    // 1. 服务端同源标记 + 预览区逐字节对齐（HTML 实体反转义校验）
    assert.ok(html.includes('data-context-source-parity="server"'));
    assert.ok(html.includes('与 MCP get_context_bundle 逐字节一致'));
    const preMatch = /<pre[^>]*data-context-export-preview=""[^>]*>([\s\S]*?)<\/pre>/.exec(html);
    assert.ok(preMatch, '应渲染 data-context-export-preview');
    const decodedPreview = preMatch[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    assert.equal(decodedPreview, serverCanonicalMarkdown, '预览区内容必须与服务端/MCP 逐字节一致');

    // 2. 四档粒度按钮全部渲染
    assert.ok(html.includes('data-context-granularity="0:full"'));
    assert.ok(html.includes('data-context-granularity="0:summary"'));
    assert.ok(html.includes('data-context-granularity="0:diff_only"'));
    assert.ok(html.includes('data-context-granularity="0:metadata_only"'));
    assert.ok(html.includes('仅大纲与结论'));
    assert.ok(html.includes('仅变更 Diff'));
    assert.ok(html.includes('仅元数据路径'));

    // 3. 上游规范片段、实时字符/Token 预算、脱敏护栏提示、三大宿主选项
    assert.ok(html.includes('data-context-upstream-snippets'));
    assert.ok(html.includes('02-上下文引擎/01-系统架构规范.md'));
    assert.ok(html.includes('338 字符'));
    assert.ok(html.includes('data-context-redacted-notice'));
    assert.ok(html.includes('拦截并隐藏 2 处疑似密钥'));
    assert.ok(html.includes('data-mcp-host-option="zcode"'));
    assert.ok(html.includes('data-mcp-host-option="claude_code"'));
    assert.ok(html.includes('data-mcp-host-option="cursor"'));
  });
});
