/**
 * AC-03 / PRD 3.3 第 3 步：《最新已拍板决策变更单》推送单测。
 *
 * 覆盖三层：
 *  ① 纯数据组装：Inline 表单值 / 服务端 DecisionAssertion → 变更单；
 *  ② 证道阁卡片与推送通知的 SSR 结构（标题、决定、确认人、清零标记、入口）；
 *  ③ 接线回归锁：App 处理 SSE decision_writeback、ReaderView 上抛表单值、
 *     抽屉消费 decisionChangeNote、workspaceClient 提供 fetchDecisions。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import DecisionChangeNoteCard from '../src/components/DecisionChangeNoteCard';
import DecisionChangeToast from '../src/components/DecisionChangeToast';
import {
  DECISION_CHANGE_NOTE_TITLE,
  buildDecisionChangeNote,
  decisionChangeNoteFromAssertion,
  decisionChangeNoteSummaryLine,
} from '../src/utils/decisionChangeNote';
import type { DecisionAssertion } from '../src/types/guanlan';

/** React SSR 在文本节点间插入 <!-- -->，断言前剥离 */
const stripComments = (html: string): string => html.replace(/<!--.*?-->/g, '');

const decisionFixture = {
  decision_id: 'dec_ac03',
  code: 'D-01',
  namespace: '04-智能体代码 / 流程',
  question: '属性字典与历史更新策略',
  status: '已确认',
  isCandidateOnly: false,
  options: ['方案A', '方案B'],
  recommendation: '方案A',
  impactBlocked: [],
  impactAllowed: [],
  confirmationBasis: {
    recordText: '采用两阶段状态锁，测试环境自动放行',
    confirmer: '架构组',
    confirmedAt: '2026-11-18T10:00:00+08:00',
    file_id: 'f_ac03',
    revision_id: 'rev_ac03',
    lineRange: [42, 46] as [number, number],
  },
  evidences: [
    {
      source_id: 'stmt_ac03',
      file_id: 'f_ac03',
      revision_id: 'rev_ac03',
      relative_path: '04-智能体代码/03-待确认事项.md',
      lineStart: 42,
      lineEnd: 46,
      observed_at: '2026-11-18T10:00:00+08:00',
      claimedStatus: '已确认',
      exactQuote: '[P1 - 已确认] 属性字典与历史更新策略',
    },
  ],
  topic: '流程',
} as unknown as DecisionAssertion;

test('服务端决策行 → 变更单：取 confirmationBasis 的确认人/时间/行段与证据路径', () => {
  const note = decisionChangeNoteFromAssertion(decisionFixture, {
    blockingCleared: true,
    source: 'writeback',
    at: '2026-11-18T10:05:00+08:00',
  });
  assert.equal(note.decisionId, 'dec_ac03');
  assert.equal(note.code, 'D-01');
  assert.equal(note.question, '属性字典与历史更新策略');
  assert.equal(note.decisionText, '采用两阶段状态锁，测试环境自动放行');
  assert.equal(note.status, '已确认');
  assert.equal(note.confirmer, '架构组');
  assert.equal(note.confirmedAt, '2026-11-18T10:00:00+08:00');
  assert.equal(note.fileId, 'f_ac03');
  assert.equal(note.filePath, '04-智能体代码/03-待确认事项.md');
  assert.equal(note.lineStart, 42);
  assert.equal(note.lineEnd, 46);
  assert.equal(note.blockingCleared, true);
  assert.equal(note.source, 'writeback');
  assert.equal(note.at, '2026-11-18T10:05:00+08:00');
  assert.equal(
    decisionChangeNoteSummaryLine(note),
    '[D-01] 属性字典与历史更新策略'
  );
});

test('Inline 表单值 → 变更单：决定/确认人/生效日期逐字保留；缺失字段如实 null', () => {
  const note = buildDecisionChangeNote({
    decisionId: 'dec_inline',
    code: 'D-02',
    question: '是否切换两阶段状态锁',
    decisionText: '切换，测试环境自动放行',
    status: '已确认',
    confirmer: '架构组',
    effectiveDate: '2026-11-18',
    confirmedAt: '2026-11-18T10:00:00+08:00',
    fileId: 'f_ac03',
    filePath: '04-智能体代码/03-待确认事项.md',
    lineStart: 10,
    lineEnd: 12,
    blockingCleared: true,
    source: 'inline',
    at: '2026-11-18T10:01:00+08:00',
  });
  assert.equal(note.decisionText, '切换，测试环境自动放行');
  assert.equal(note.confirmer, '架构组');
  assert.equal(note.effectiveDate, '2026-11-18');
  assert.equal(note.blockingCleared, true);
  assert.equal(note.source, 'inline');

  const bare = buildDecisionChangeNote({
    decisionId: 'dec_bare',
    decisionText: '只填了决定文本',
    fileId: 'f_bare',
    source: 'writeback',
  });
  assert.equal(bare.question, '只填了决定文本', '无问题时用决定文本兜底');
  assert.equal(bare.confirmer, null);
  assert.equal(bare.effectiveDate, null);
  assert.equal(bare.confirmedAt, null);
  assert.equal(bare.filePath, null);
  assert.equal(bare.blockingCleared, false);

  const empty = buildDecisionChangeNote({ decisionId: 'dec_empty', fileId: 'f', source: 'inline' });
  assert.equal(empty.question, '已拍板决策');
  assert.equal(empty.decisionText, '', '无决定文本如实空串，不用问题原文冒充');
});

test('证道阁卡片 SSR：标题/决定/确认人/生效日期/来源/清零标记齐全', () => {
  const note = buildDecisionChangeNote({
    decisionId: 'dec_ac03',
    code: 'D-01',
    question: '属性字典与历史更新策略',
    decisionText: '采用两阶段状态锁',
    confirmer: '架构组',
    effectiveDate: '2026-11-18',
    confirmedAt: '2026-11-18T10:00:00+08:00',
    fileId: 'f_ac03',
    filePath: '04-智能体代码/03-待确认事项.md',
    lineStart: 42,
    lineEnd: 46,
    blockingCleared: true,
    source: 'inline',
    at: '2026-11-18T10:01:00+08:00',
  });
  const html = stripComments(renderToString(createElement(DecisionChangeNoteCard, { note })));
  assert.ok(html.includes('data-decision-change-note'), '变更单卡片标记存在');
  assert.ok(html.includes(DECISION_CHANGE_NOTE_TITLE), '标题逐字');
  assert.ok(html.includes('[D-01] 属性字典与历史更新策略'), '摘要行');
  assert.ok(html.includes('决定：采用两阶段状态锁'), '决定文本');
  assert.ok(html.includes('确认人：架构组'), '确认人');
  assert.ok(html.includes('生效日期：2026-11-18'), '生效日期');
  assert.ok(html.includes('04-智能体代码/03-待确认事项.md#L42–L46'), '来源路径与行段');
  assert.ok(html.includes('阻塞已清零'), '清零标记');
});

test('推送通知 SSR：告知已推送证道阁并提供查看入口', () => {
  const note = buildDecisionChangeNote({
    decisionId: 'dec_ac03',
    code: 'D-01',
    question: '属性字典与历史更新策略',
    decisionText: '采用两阶段状态锁',
    confirmer: '架构组',
    blockingCleared: true,
    source: 'inline',
    fileId: 'f_ac03',
  });
  const html = stripComments(
    renderToString(
      createElement(DecisionChangeToast, {
        note,
        onOpenZhendaoge: () => {},
        onDismiss: () => {},
      })
    )
  );
  assert.ok(html.includes('data-decision-change-toast'), '通知条标记存在');
  assert.ok(html.includes('已向证道阁推送'), '推送文案');
  assert.ok(html.includes(DECISION_CHANGE_NOTE_TITLE), '变更单标题');
  assert.ok(html.includes('查看证道阁'), '查看入口');
  assert.ok(html.includes('本文档阻塞性 P0/P1 已清零'), '清零说明');
});

test('接线回归：App 处理 decision_writeback 并推送；抽屉/ReaderView 消费变更单', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  // D01-a 拆层后 App 实现 = 装配层 + 单一 Store + 分节组件——联合文本断言（语义不变）
  const app = ['../src/App.tsx', '../src/stores/useWorkspaceStore.tsx', '../src/components/app/AppModalsStack.tsx']
    .map((rel) => read(rel))
    .join(String.fromCharCode(10))
  for (const token of [
    'decision_writeback',
    'fetchDecisions',
    'DecisionChangeToast',
    'decisionChangeNote={decisionChangeNote}',
    'pushDecisionChangeNote',
    'decisionChangeNoteFromAssertion(latest',
  ]) {
    assert.ok(app.includes(token), `App 缺 ${token}`);
  }
  assert.match(app, /kinds\.includes\('decision_writeback'\)/, 'SSE 必须识别 decision_writeback');
  assert.match(app, /kinds\.includes\('proposal'\)/, '既有 proposal 分支保留');

  // D01-a 拆层后拍板回写装配在 reader/useReaderController.tsx——联合文本断言（语义不变）
  const reader = [
    '../src/components/ReaderView.tsx',
    '../src/components/reader/useReaderController.tsx',
  ]
    .map((rel) => read(rel))
    .join('\n');
  for (const token of ['decisionText: values.decision', 'blockingCleared', 'confirmer: values.confirmer']) {
    assert.ok(reader.includes(token), `ReaderView 缺 ${token}`);
  }

  // V08 拆解 ModalsAndDrawers 后，AgentContextDrawer 实现位于 components/modals/AgentContextDrawer.tsx
  const drawer = [
    '../src/components/ModalsAndDrawers.tsx',
    '../src/components/modals/AgentContextDrawer.tsx',
  ]
    .map((p) => read(p))
    .join('\n');
  for (const token of ['DecisionChangeNoteCard', 'decisionChangeNote']) {
    assert.ok(drawer.includes(token), `AgentContextDrawer 缺 ${token}`);
  }

  const client = read('../src/services/workspaceClient.ts');
  assert.ok(client.includes('export async function fetchDecisions'), 'workspaceClient 缺 fetchDecisions');
});
