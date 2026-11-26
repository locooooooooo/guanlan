import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CommandPalette,
  PALETTE_GRAMMAR_SUGGESTIONS,
  hasPaletteToken,
  palettePreviewModel,
  paletteTokenTone,
  parsePaletteTokens,
  removePaletteTokenAt,
  shortRevisionId,
  togglePaletteSuggestion,
} from '../components/CommandPalette';
import { parsePaletteQuery } from './commandPaletteGrammar';
import type { PaletteItem } from './commandPaletteResults';


const noop = (): void => {};

function fileItem(overrides: Partial<PaletteItem> = {}): PaletteItem {
  return {
    kind: 'file',
    key: 'srv:f1:rev_f1',
    title: '登录方案',
    subtitle: 'docs/登录方案.md',
    format: 'md',
    matchStrategy: 'bigram_phrase_verified',
    coverage: 'full_text',
    fileId: 'f1',
    revisionId: 'rev_f1',
    relativePath: 'docs/登录方案.md',
    score: 15,
    ...overrides,
  };
}

function renderPalette(
  items: PaletteItem[],
  overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(CommandPalette, {
      isOpen: true,
      query: '登录',
      items,
      searching: false,
      onQueryChange: noop,
      onClose: noop,
      onOpenFile: noop,
      onLocate: noop,
      onAddToBasket: noop,
      onRunAction: noop,
      ...overrides,
    })
  );
}

function listHtmlOf(html: string): string {
  const start = html.indexOf('data-command-palette-list');
  const end = html.indexOf('data-command-palette-preview');
  return html.slice(start, end > start ? end : undefined);
}

test('palette：关闭时渲染 null；打开时具备 esc-layer/输入/底栏键位提示', () => {
  const closed = renderPalette([], { isOpen: false });
  assert.equal(closed, '');
  const html = renderPalette([]);
  assert.ok(html.includes('data-esc-layer="open"'), '浮层标记（App Esc 阶梯/Space 守卫依赖）');
  assert.ok(html.includes('data-command-palette-input'), '输入框存在（呼出即可输入）');
  assert.ok(html.includes('Ctrl+Enter'), '底栏键位提示常驻');
  assert.ok(html.includes('Tab 加入证据篮'), 'Tab 闭环提示');
  assert.ok(html.includes('没有匹配结果'), '空列表占位');
});

test('palette：文件条目 + 命中摘要 2 行 clamp 与全量高亮分段（列表栏 2 处 + 右预览栏 2 处）', () => {
  const snippet =
    '前置铺垫文本（前十六字窗口起点附近）。\n第二行出现登录方案，随后再次出现登录方案字样。\n第三行不该可见。';
  const item = fileItem({ snippetText: snippet });
  const html = renderPalette([item]);
  assert.ok(html.includes('data-command-palette-list'), '结果列表容器');
  assert.ok(html.includes('glx-clamp-2'), '摘要 ≤2 行 CSS clamp');
  assert.ok(html.includes('<mark'), '命中词高亮分段');
  const listHtml = listHtmlOf(html);
  const previewHtml = html.slice(html.indexOf('data-command-palette-preview'));
  assert.equal((listHtml.match(/<mark/g) ?? []).length, 2, '列表栏窗口内两次「登录方案」全量高亮');
  assert.equal(
    (previewHtml.match(/<mark/g) ?? []).length,
    2,
    '右预览栏同窗口两次「登录方案」全量高亮'
  );
  assert.ok(!html.includes('第三行'), '窗口裁断第 3 行不可见');
  assert.ok(html.includes('登录方案'), '命中词可见');
});

test('palette：待拍板徽标与动作条目渲染', () => {
  const items: PaletteItem[] = [
    fileItem({ pendingDecisions: 2 }),
    {
      kind: 'action',
      key: 'action:jump-today',
      title: '跳到今天 · 时间主干',
      actionId: 'jump-today',
      score: 30,
    },
  ];
  const html = renderPalette(items);
  assert.ok(html.includes('待拍板 2'), '待拍板徽标');
  assert.ok(html.includes('跳到今天'), '动作条目标题');
  assert.ok(html.includes('data-palette-kind="action"'), '动作条目 kind 标记');
});


test('parsePaletteTokens：语法 token 拆解（意图分类 / 原文 / 偏移 / 解析成败诚实标注）', () => {
  const now = new Date('2026-11-20T12:00:00');
  const tokens = parsePaletteTokens('@今天 type:md status:待拍板 in:登录方案 登录网关', now);
  assert.deepEqual(
    tokens.map((t) => [t.kind, t.text, t.start]),
    [
      ['date', '@今天', 0],
      ['type', 'type:md', 4],
      ['status', 'status:待拍板', 12],
      ['in', 'in:登录方案', 23],
      ['keyword', '登录网关', 31],
    ],
    'token 序列：kind / 原文 / 起始偏移'
  );
  assert.equal(tokens[0].parsed, true);
  assert.equal(tokens[0].value, '2026-11-20');
  assert.equal(tokens[1].value, 'md');
  assert.equal(tokens[2].value, '待拍板');
  assert.equal(tokens[3].value, '登录方案');
  assert.equal(tokens[4].kind, 'keyword');

  const bad = parsePaletteTokens('@下周 status:已归档 方案', now);
  assert.equal(bad[0].kind, 'date');
  assert.equal(bad[0].parsed, false, '未收录日期词诚实标注未解析');
  assert.equal(bad[1].kind, 'status');
  assert.equal(bad[1].parsed, false, '未知 status 值诚实标注未解析');
  assert.equal(bad[2].kind, 'keyword');

  const caps = parsePaletteTokens('TYPE:MD', now);
  assert.equal(caps[0].kind, 'type');
  assert.equal(caps[0].value, 'md');
  assert.equal(caps[0].parsed, true);

  assert.deepEqual(parsePaletteTokens('   ', now), []);

  assert.equal(parsePaletteTokens('@近7天', now)[0].parsed, false);
});

test('removePaletteTokenAt：按偏移一键移除并收敛空白（越界/空白偏移防御）', () => {
  assert.equal(removePaletteTokenAt('@今天 type:md 登录', 4), '@今天 登录');
  assert.equal(removePaletteTokenAt('@今天 type:md 登录', 0), 'type:md 登录');
  assert.equal(removePaletteTokenAt('type:md', 0), '');
  assert.equal(removePaletteTokenAt('登录', 0), '');
  assert.equal(removePaletteTokenAt('a b', 1), 'a b', '偏移落在空白上原样返回');
  assert.equal(removePaletteTokenAt('a b', 99), 'a b', '越界偏移原样返回');
});

test('togglePaletteSuggestion / hasPaletteToken：点击补全、再点移除（只改 query 字符串）', () => {
  assert.equal(togglePaletteSuggestion('', '@今天'), '@今天');
  assert.equal(togglePaletteSuggestion('@今天', '@今天'), '');
  assert.equal(togglePaletteSuggestion('登录', 'status:待拍板'), '登录 status:待拍板');
  assert.equal(togglePaletteSuggestion('登录 status:待拍板', 'status:待拍板'), '登录');
  assert.equal(togglePaletteSuggestion('type:md', 'type:svg'), 'type:md type:svg');
  assert.equal(hasPaletteToken('登录 type:md', 'type:md'), true);
  assert.equal(hasPaletteToken('登录 type:mdx', 'type:md'), false, '整词精确匹配，不误伤前缀相同 token');
  const parsed = parsePaletteQuery(togglePaletteSuggestion('登录', 'status:待拍板'));
  assert.equal(parsed.pendingDecisionOnly, true);
  assert.equal(parsed.keyword, '登录');
  const typed = parsePaletteQuery(togglePaletteSuggestion('', 'type:svg'));
  assert.deepEqual(typed.types, ['svg']);
});

test('PALETTE_GRAMMAR_SUGGESTIONS：五枚胶囊逐字锁定 + stage-ink 六色家族色调映射', () => {
  assert.deepEqual(
    PALETTE_GRAMMAR_SUGGESTIONS.map((s) => s.label),
    ['@今天', '@近7天', 'status:待拍板', 'type:md', 'type:svg']
  );
  assert.deepEqual(
    PALETTE_GRAMMAR_SUGGESTIONS.map((s) => s.token),
    ['@今天', '@近7天', 'status:待拍板', 'type:md', 'type:svg']
  );
  assert.deepEqual(
    PALETTE_GRAMMAR_SUGGESTIONS.map((s) => s.tone),
    ['blueprint', 'blueprint', 'decision', 'deliver', 'anomaly'],
    '色调只用 --stage-ink-* 六色家族（时间蓝图蓝 / 拍板琥珀 / 格式交付绿 / svg 玫红）'
  );
  assert.equal(paletteTokenTone('date'), 'blueprint');
  assert.equal(paletteTokenTone('status'), 'decision');
  assert.equal(paletteTokenTone('type', 'md'), 'deliver');
  assert.equal(paletteTokenTone('type', 'svg'), 'anomaly');
  assert.equal(paletteTokenTone('in'), 'plan');
  assert.equal(paletteTokenTone('keyword'), 'neutral');
});


test('palettePreviewModel：完整路径 / 版本短码 / 待拍板 / SVG 微缩图 / 高亮分段 / 诚实空摘要', () => {
  const md = palettePreviewModel(
    fileItem({
      snippetText: '登录网关统一由 AC-03 承载，包含重试与降级策略的完整说明文本。',
      revisionId: 'rev_login_8f3a91c2',
      pendingDecisions: 2,
      coverage: 'full_text',
      matchStrategy: 'bigram_phrase_verified',
    }),
    '登录'
  );
  assert.equal(md.isAction, false);
  assert.equal(md.path, 'docs/登录方案.md', '完整路径（relativePath）');
  assert.equal(md.revisionShort, 'rev_login_8f…', '版本短码 = revisionId 前 12 字符 + 省略号');
  assert.equal(md.pendingDecisions, 2);
  assert.equal(md.thumbnailUrl, null, '非 svg 不出缩略图');
  assert.ok(md.snippet, '命中正文高亮分段存在');
  assert.ok(md.snippet!.segments.some((s) => s.hit), '分段含命中高亮');
  assert.equal(md.snippetFallback, null);
  assert.equal(md.coverageLabel, '全文命中');
  assert.equal(md.matchStrategyLabel, '短语校验命中');
  assert.deepEqual(md.hints, ['Enter 打开', 'Ctrl+Enter 定位目录', 'Tab 加入证据篮']);

  const svg = palettePreviewModel(
    fileItem({ format: 'svg', revisionId: 'rev_svg_1', snippetText: undefined, coverage: 'svg_text' }),
    '登录'
  );
  assert.ok(
    svg.thumbnailUrl!.includes('/api/v1/revisions/rev_svg_1/thumbnail'),
    'SVG 微缩图 = 懒加载缩略地址直拼（revisionThumbnailUrl）'
  );
  assert.equal(svg.snippet, null);
  assert.equal(
    svg.snippetFallback,
    '本地索引命中（路径/标题）——正文摘要由全文检索层提供',
    '本地层无 snippet 时诚实说明，不伪造正文'
  );
  assert.equal(svg.coverageLabel, 'SVG 文本命中');

  const action = palettePreviewModel(
    { kind: 'action', key: 'a', title: '跳到今天 · 时间主干', actionId: 'jump-today', score: 30 },
    ''
  );
  assert.equal(action.isAction, true);
  assert.equal(action.revisionShort, null);
  assert.equal(action.path, null);
  assert.ok(action.hints.includes('Enter 执行动作'), '动作条目提示切换为执行口径');
  assert.equal(shortRevisionId('a1b2c3d4e5f6g7h8'), 'a1b2c3d4e5f6…');
  assert.equal(shortRevisionId('rev_f1'), 'rev_f1');
});


test('SSR 双栏：lg 60/40 右预览窗渲染（路径/版本徽标/缩略图/动作提示）+ 语法胶囊行五枚', () => {
  const items = [
    fileItem({
      format: 'svg',
      revisionId: 'rev_svg9',
      coverage: 'svg_text',
      snippetText: '登录方案里的第二行提到登录方案字样。',
    }),
  ];
  const html = renderPalette(items, { query: '登录 type:md' });
  assert.ok(html.includes('data-command-palette-preview'), '右实时预览窗（lg ≥1024px）');
  assert.ok(html.includes('lg:w-[60%]'), '左结果列表 60%');
  assert.ok(html.includes('lg:w-[40%]'), '右预览窗 40%');
  assert.ok(html.includes('data-command-palette-preview-path="docs/登录方案.md"'), '完整路径透出');
  assert.ok(html.includes('data-command-palette-revision'), '版本徽标');
  assert.ok(html.includes('data-command-palette-thumb'), 'SVG 微缩图');
  assert.ok(html.includes('loading="lazy"'), '缩略图懒加载（键盘游走零 fetch 竞态）');
  assert.ok(html.includes('data-command-palette-preview-snippet'), '命中正文高亮段落');
  assert.ok(html.includes('data-command-palette-preview-hints'), '快捷动作提示');
  assert.ok(html.includes('Ctrl+Enter 定位目录') && html.includes('Tab 加入证据篮'));
  assert.ok(html.includes('data-command-palette-grammar'), '常驻语法胶囊行');
  assert.equal((html.match(/data-palette-suggest=/g) ?? []).length, 5, '五枚胶囊');
  assert.ok(html.includes('data-palette-suggest="@近7天"'));
  assert.ok(html.includes('aria-pressed="false"'));
  assert.ok(html.includes('data-palette-token="type:md"'));
  assert.ok(html.includes('data-palette-token-parsed="true"'));
  assert.ok(html.includes('data-palette-token-remove'), '点 × 一键移除');
  assert.ok(html.includes('glx-popover-in'), '面板 glx-popover-in 柔和缩放淡入');
  assert.ok(html.includes('glx-backdrop-in'), '遮罩淡入');
});

test('SSR Token 微标签：未识别诚实标注 + 无语法 token 不渲染 chip 容器', () => {
  const html = renderPalette([], { query: '@近7天 status:已归档' });
  assert.ok(html.includes('data-palette-token="@近7天"'));
  assert.ok(html.includes('data-palette-token-parsed="false"'), '冻结语法无区间档 → 诚实未识别');
  assert.ok(html.includes('未识别'));
  assert.ok(html.includes('data-palette-token="status:已归档"'));
  assert.ok(html.includes('data-palette-token-parsed="false"'));
  const plain = renderPalette([], { query: '登录' });
  assert.ok(!plain.includes('data-command-palette-tokens'));
  assert.equal(renderPalette([], { isOpen: false }), '');
});
