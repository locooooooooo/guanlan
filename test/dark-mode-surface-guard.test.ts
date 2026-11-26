import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DiffSummaryCard from '../src/components/DiffSummaryCard';
import type { DiffResult } from '../src/services/apiTypes';

const readSrc = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');

const UNGUARDED_LIGHT_BG_RE =
  /\b(?:bg-white(?:\/\d+)?|bg-(?:slate|zinc|gray|neutral|stone|rose|red|amber|yellow|emerald|green|sky|blue|indigo)-50(?:\/\d+)?)\b|color-mix\([^)]*,\s*white\)/i;

const DARK_SAFE_COMPONENTS = [
  'components/RightInspector.tsx',
  'components/modals/AgentContextDrawer.tsx',
  'components/TimelineView.tsx',
  'components/ContextCapsuleModal.tsx',
  'components/WorkspaceGateModal.tsx',
  'components/modals/McpConsoleModal.tsx',
  'components/InitiativeCandidatePanel.tsx',
  'components/DecisionChangeNoteCard.tsx',
  'components/app/AppBanners.tsx',
  'components/FileContextMenu.tsx',
  'components/sidebar/MountedWorkspacesSection.tsx',
  'components/sidebar/ProjectTreeBranch.tsx',
  'components/CalendarBoardView.tsx',
];

test('全站深色适配壳层与抽屉不得残留无 dark: 守护的浅色硬编码背景', () => {
  const leaks: string[] = [];
  for (const rel of DARK_SAFE_COMPONENTS) {
    const lines = readSrc(rel).split('\n');
    lines.forEach((line, idx) => {
      if (UNGUARDED_LIGHT_BG_RE.test(line) && !/\bdark:bg-/.test(line)) {
        leaks.push(`${rel}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(leaks, [], `发现未适配深色模式的硬编码浅色底：\n${leaks.join('\n')}`);
});

test('阅读器对比与关系图在暗夜分支不得误写 bg-white', () => {
  for (const rel of [
    'components/reader/readerDiffSection.tsx',
    'components/reader/readerRelationsSection.tsx',
  ]) {
    const src = readSrc(rel);
    const identicalBranchRe =
      /paperLightMode\s*\?\s*['"][^'"]*bg-white[^'"]*['"]\s*:\s*['"][^'"]*bg-white/g;
    assert.equal(
      identicalBranchRe.test(src),
      false,
      `${rel} 的 paperLightMode 三元分支暗夜侧不得继续使用 bg-white`
    );
    const darkBranchWhiteRe = /:\s*['"][^'"]*bg-white(?:\/\d+)?(?!\/\[)/g;
    assert.equal(
      darkBranchWhiteRe.test(src),
      false,
      `${rel} 暗夜分支不得残留 bg-white`
    );
  }

  const readerSrc = readSrc('components/ReaderView.tsx');
  assert.equal(
    /className="[^"]*bg-white\/85/.test(readerSrc),
    false,
    'ReaderView 批注悬浮钮应按 paperLightMode 切换明暗背景'
  );
  const mdSrc = readSrc('components/reader/readerMarkdownSection.tsx');
  assert.equal(
    /className="[^"]*bg-white\/85/.test(mdSrc),
    false,
    'ReaderMarkdownSection 决策动作条应按 paperLightMode 切换明暗背景'
  );
});

test('AtlasView 文件夹层叠卡片与 DiffSummaryCard 具备明确明暗双态对比', () => {
  const atlasSrc = readSrc('components/AtlasView.tsx');
  assert.ok(
    atlasSrc.includes('dark:from-[#232738]'),
    'FolderPeekPaper 应提供深色模式纸张渐变，避免在暗底呈现刺眼纯白卡片'
  );

  const sampleResult: DiffResult = {
    summary: {
      headline: '测试变更摘要',
      items: [{ label: '新增交付项', count: 1, sign: '+' }],
      checkpoint_id: null,
    },
    sections: [],
    truncated: false,
    next_cursor: null,
  };

  const darkHtml = renderToStaticMarkup(
    React.createElement(DiffSummaryCard, {
      result: sampleResult,
      loading: false,
      error: null,
      paperLightMode: false,
    })
  );
  const lightHtml = renderToStaticMarkup(
    React.createElement(DiffSummaryCard, {
      result: sampleResult,
      loading: false,
      error: null,
      paperLightMode: true,
    })
  );
  assert.ok(darkHtml.includes('text-[#F3F4F8]'), '暗夜模式 DiffSummaryCard 标题应使用高对比浅色字');
  assert.ok(lightHtml.includes('text-[#1F1E1D]'), '纸面浅色模式 DiffSummaryCard 标题应使用高对比深色字');
});
