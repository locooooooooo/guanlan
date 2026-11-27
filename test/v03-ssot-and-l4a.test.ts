import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionRadar } from '../src/components/DecisionRadar';
import HomeView from '../src/components/HomeView';
import type { DecisionAssertion } from '../src/types/guanlan';

const ROOT = path.resolve(import.meta.dirname, '..');

function makePendingDecision(idx: number): DecisionAssertion {
  return {
    decision_id: `dec_${idx}`,
    code: `Q${String(idx).padStart(3, '0')}`,
    namespace: '测试项目 / 核心口径',
    question: `关键口径-${idx}`,
    status: '待确认',
    isCandidateOnly: false,
    options: ['方案A', '方案B'],
    recommendation: '方案A',
    impactBlocked: [`模块-${idx}`],
    impactAllowed: [],
    evidences: [],
    topic: `关键口径-${idx}`,
  };
}

test('DecisionRadar displays server SSOT unresolvedTotal over paginated decisions.length', () => {
  const twoItems = [makePendingDecision(1), makePendingDecision(2)];
  const html = renderToStaticMarkup(
    React.createElement(DecisionRadar, {
      decisions: twoItems,
      unresolvedTotal: 288,
      onOpenDecision: () => {},
    }),
  );
  assert.match(html, /待拍板/);
  assert.match(html, />288</);

  const fallbackHtml = renderToStaticMarkup(
    React.createElement(DecisionRadar, {
      decisions: twoItems,
      onOpenDecision: () => {},
    }),
  );
  assert.match(fallbackHtml, />2</);

  const zeroHtml = renderToStaticMarkup(
    React.createElement(DecisionRadar, {
      decisions: [],
      unresolvedTotal: 0,
      onOpenDecision: () => {},
    }),
  );
  assert.ok(zeroHtml.includes('>决策<') && zeroHtml.includes('>0<'), '未决为 0 时仍展示「决策」可见按钮标签');
});

test('HomeView displays server SSOT decisionsUnresolvedTotal consistently in greeting pill and focus card', () => {
  const twoItems = [makePendingDecision(1), makePendingDecision(2)];
  const html = renderToStaticMarkup(
    React.createElement(HomeView, {
      files: [],
      readingStates: {},
      events: [],
      summary: null,
      eventDays: null,
      recentItems: [],
      decisions: twoItems,
      decisionsUnresolvedTotal: 288,
      onOpenDoc: () => {},
      onResumeReading: () => {},
      onMarkFullyRead: () => {},
      onOpenPackageBoard: () => {},
      onOpenPanorama: () => {},
      onOpenDecision: () => {},
    }),
  );
  assert.match(html, /288\s*项待拍板/);
  assert.match(html, />288</);
});

test('useWorkspaceStore polls L4A by queue_depth > 0, reacts to SSE l4a notice, and wires SSOT unresolved_total', () => {
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src/stores/useWorkspaceStore.tsx'), 'utf8');
  assert.ok(
    storeSrc.includes('decisionsUnresolvedTotal'),
    'useWorkspaceStore must track decisionsUnresolvedTotal',
  );
  assert.ok(
    storeSrc.includes('decisions_unresolved_total'),
    'useWorkspaceStore must hydrate decisions_unresolved_total from bootstrap',
  );
  const l4aStoreSrc = fs.readFileSync(path.join(ROOT, 'src/utils/l4aProgressStore.ts'), 'utf8');
  assert.ok(
    storeSrc.includes('isL4aProgressActive(progress)') &&
      l4aStoreSrc.includes('progress.queue_depth > 0'),
    'L4A active polling guard must check queue_depth > 0 so failed/skipped rows never cause infinite 0% polling',
  );
  assert.ok(
    storeSrc.includes("kinds.includes('l4a')"),
    'useWorkspaceStore must react to SSE l4a progress notices',
  );
  assert.ok(
    storeSrc.includes('toastManager.add'),
    'useWorkspaceStore must emit a completion toast when L4A finishes draining',
  );
});
