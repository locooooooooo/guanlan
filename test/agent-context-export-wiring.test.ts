import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { AgentContextDrawer } from '../src/components/ModalsAndDrawers';
import { buildMcpPayload } from '../src/utils/agentContextExport';
import type { EvidencePointer } from '../src/types/guanlan';

const stripComments = (html: string): string => html.replace(/<!--.*?-->/g, '');

const pointer: EvidencePointer = {
  file_id: 'f_ac05_readme',
  revision_id: 'rev_ac05_v2',
  relative_path: '04-智能体代码/README.md',
  content_sha256: '0123456789abcdef0123456789abcdef',
  locator: { kind: 'file' },
  evidence_kind: 'metadata_only',
  index_generation: 1,
  observed_at: '2026-11-18T00:00:00+08:00',
  coverage: 'full_text',
  stale: false,
  excerpt: '',
  granularity: 'full',
  sizeBytes: 1024,
};

function drawerProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: () => {},
    pointers: [pointer],
    onRemovePointer: () => {},
    onClearPointers: () => {},
    workspaceRoot: 'H:/ws',
    initiative: { id: 'init_04', name: '04-智能体代码', stage: '执行' },
    sessionCheckpointId: 'ckpt_20261118_04_exec_09',
    referenceMetaOf: () => ({ versionLabel: 'v2', stateLabel: '选中修订' }),
    intent: 'document' as const,
    intentTemplate: '基于当前方案文档与未决约束，推进下一阶段执行/代码实现',
    presetPointers: [pointer],
    recommendedMounts: [],
    onMountPointers: () => {},
    onUpdatePointerGranularity: () => {},
    confirmedDecisions: [],
    pendingBlockers: [],
    decisionChangeNote: null,
    ...overrides,
  };
}

test('上下文抽屉模式 A：根标签带 initiative/stage，引用行带 (v2 · 选中修订)', () => {
  const html = stripComments(
    renderToString(createElement(AgentContextDrawer, drawerProps()))
  );

  assert.ok(html.includes('initiative='), '根标签含 initiative 属性');
  assert.ok(html.includes('04-智能体代码'), 'initiative 名称已装配');
  assert.ok(html.includes('stage='), '根标签含 stage 属性');
  assert.ok(html.includes('执行'), 'stage 值已装配');
  assert.ok(
    html.includes('[全文] 04-智能体代码/README.md (v2 · 选中修订)'),
    '引用行含完整路径 + 粒度 + 版本/状态后缀'
  );
});

test('上下文导出模式 B：session_checkpoint_id / initiative / context_bundle.version 均有值', () => {
  const payload = buildMcpPayload({
    workspaceRoot: 'H:/ws',
    initiative: { id: 'init_04', name: '04-智能体代码', stage: '执行' },
    sessionCheckpointId: 'ckpt_20261118_04_exec_09',
    contextBundle: [
      {
        path: '04-智能体代码/README.md',
        granularity: 'full',
        versionLabel: 'v2',
        contentHash: '0123456789abcdef0123456789abcdef',
      },
    ],
  });

  assert.equal(payload.session_checkpoint_id, 'ckpt_20261118_04_exec_09');
  assert.deepEqual(payload.initiative, {
    id: 'init_04',
    name: '04-智能体代码',
    current_stage: '执行',
  });
  assert.equal(payload.context_bundle[0].version, 'v2');
  assert.equal(payload.context_bundle[0].uri, 'guanlan://04-智能体代码/README.md');
});

test('上下文导出接线：抽屉传齐字段，App 提供 initiative/sessionCheckpoint/referenceMeta', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const drawer = [
    '../src/components/ModalsAndDrawers.tsx',
    '../src/components/modals/AgentContextDrawer.tsx',
  ]
    .map((p) => read(p))
    .join('\n');
  for (const token of [
    'initiative: initiative ? { name: initiative.name, stage: initiative.stage } : null',
    'initiative: initiative ?? null',
    'sessionCheckpointId: sessionCheckpointId ?? null',
    'versionLabel: meta?.versionLabel ?? null',
    'stateLabel: meta?.stateLabel ?? null',
  ]) {
    assert.ok(drawer.includes(token), `AgentContextDrawer 缺 ${token}`);
  }

  const app = ['../src/App.tsx', '../src/stores/useWorkspaceStore.tsx', '../src/components/app/AppModalsStack.tsx']
    .map((p) => read(p))
    .join(String.fromCharCode(10))
  for (const token of [
    'fetchCheckpoints(',
    'initiative={activeInitiative}',
    'sessionCheckpointId={contextSessionCheckpointId}',
    'referenceMetaOf={referenceMetaOf}',
  ]) {
    assert.ok(app.includes(token), `App 缺 ${token}`);
  }
});
