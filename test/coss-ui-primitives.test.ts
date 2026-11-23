/**
 * V01 · coss.com/ui 原语基座、全局明暗令牌与 appThemeStore 契约测试
 *
 * 覆盖：
 * 1. cn() 样式合并与 Tailwind 冲突消解；
 * 2. appThemeStore 三态解析（light / dark / system）、订阅通知与同值短路；
 * 3. V01 首批 11 个 coss 原语 SSR 渲染、data-slot 槽位契约、Base UI useRender 多态与 reduced-motion；
 * 4. src/index.css 的 @theme inline、:root/.dark 语义令牌完备性与 reduced-motion 停帧覆盖。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cn } from '../src/lib/cn';
import {
  applyAppTheme,
  getAppThemeMode,
  getResolvedAppTheme,
  resolveEffectiveAppTheme,
  subscribeAppTheme,
} from '../src/stores/appThemeStore';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardFrame,
  CardFrameHeader,
  CardFrameTitle,
  CardHeader,
  CardPanel,
  CardTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
  GlassSkeleton,
  Group,
  GroupSeparator,
  GroupText,
  Kbd,
  KbdGroup,
  Separator,
  Skeleton,
  Spinner,
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from '../src/components/ui/index';

function readSrc(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relPath}`, import.meta.url)), 'utf8');
}

test('V01 cn()：支持条件拼接与 Tailwind 冲突类后者覆盖', () => {
  assert.equal(cn('px-2 py-1', false && 'hidden', 'px-4'), 'py-1 px-4');
  assert.equal(cn('rounded-lg border', 'rounded-xl'), 'border rounded-xl');
});

test('V01 appThemeStore：三态解析纯函数、订阅通知与同值短路', () => {
  assert.equal(resolveEffectiveAppTheme('light', true), 'light');
  assert.equal(resolveEffectiveAppTheme('dark', false), 'dark');
  assert.equal(resolveEffectiveAppTheme('system', false), 'light');
  assert.equal(resolveEffectiveAppTheme('system', true), 'dark');

  const events: Array<[string, string]> = [];
  const off = subscribeAppTheme(() => {
    events.push([getAppThemeMode(), getResolvedAppTheme()]);
  });

  // 初始默认 light
  assert.equal(getAppThemeMode(), 'light');
  assert.equal(getResolvedAppTheme(), 'light');

  applyAppTheme('dark', false);
  assert.equal(getAppThemeMode(), 'dark');
  assert.equal(getResolvedAppTheme(), 'dark');

  // 同值再次 apply 短路不重复通知
  applyAppTheme('dark', false);
  assert.equal(events.length, 1);

  applyAppTheme('system', true);
  assert.equal(getResolvedAppTheme(), 'dark');
  assert.equal(events.length, 2);

  off();
  // 还原默认 light 且退订后不再收到通知
  applyAppTheme('light', false);
  assert.equal(events.length, 2);
  assert.equal(getAppThemeMode(), 'light');
});

test('V01 Button：多变体、loading 态、Base UI render 多态与 motion-reduce 契约', () => {
  const baseHtml = renderToStaticMarkup(createElement(Button, { variant: 'outline' }, '打开文档'));
  assert.ok(baseHtml.includes('data-slot="button"'));
  assert.ok(baseHtml.includes('bg-clip-padding'));
  assert.ok(baseHtml.includes('motion-reduce:transition-none'));
  assert.ok(baseHtml.includes('打开文档'));

  const loadingHtml = renderToStaticMarkup(
    createElement(Button, { loading: true, variant: 'brand' }, '保存中'),
  );
  assert.ok(loadingHtml.includes('data-loading=""'));
  assert.ok(loadingHtml.includes('data-slot="button-loading-indicator"'));
  assert.ok(loadingHtml.includes('disabled=""'));

  const linkHtml = renderToStaticMarkup(
    createElement(Button, { render: createElement('a', { href: '#doc' }), variant: 'ghost' }, '溯源'),
  );
  assert.ok(linkHtml.startsWith('<a '));
  assert.ok(linkHtml.includes('href="#doc"'));
  assert.ok(linkHtml.includes('data-slot="button"'));
});

test('V01 Badge / Kbd / Separator / Spinner / Skeleton 原语 SSR 契约', () => {
  const badgeHtml = renderToStaticMarkup(
    createElement(Badge, { variant: 'success', size: 'sm' }, '已同步'),
  );
  assert.ok(badgeHtml.includes('data-slot="badge"'));
  assert.ok(badgeHtml.includes('已同步'));

  const kbdHtml = renderToStaticMarkup(
    createElement(KbdGroup, null, createElement(Kbd, null, 'Ctrl'), createElement(Kbd, null, 'K')),
  );
  assert.ok(kbdHtml.includes('data-slot="kbd-group"'));
  assert.ok(kbdHtml.includes('data-slot="kbd"'));

  const sepHtml = renderToStaticMarkup(createElement(Separator, { orientation: 'vertical' }));
  assert.ok(sepHtml.includes('data-slot="separator"'));

  const spinHtml = renderToStaticMarkup(createElement(Spinner, null));
  assert.ok(spinHtml.includes('data-slot="spinner"'));
  assert.ok(spinHtml.includes('motion-reduce:animate-none'));

  const skelHtml = renderToStaticMarkup(createElement(Skeleton, { className: 'h-4 w-32' }));
  assert.ok(skelHtml.includes('data-slot="skeleton"'));
  assert.ok(skelHtml.includes('glx-skeleton'));
  assert.ok(skelHtml.includes('aria-hidden="true"'));

  // 确认 GlassSkeleton 经统一入口可直引无回归
  const glassHtml = renderToStaticMarkup(createElement(GlassSkeleton, { lines: 2 }));
  assert.ok(glassHtml.includes('data-glass-skeleton=""'));
});

test('V01 Frame / CardFrame / Group / Toolbar / Empty 三卡扇形空态 SSR 契约', () => {
  const frameHtml = renderToStaticMarkup(
    createElement(
      Frame,
      null,
      createElement(
        FrameHeader,
        null,
        createElement(FrameTitle, null, '多项目工作台'),
        createElement(FrameDescription, null, '1 项目 · 5519 资产'),
      ),
      createElement(FramePanel, null, '面板正文'),
      createElement(FrameFooter, null, '底栏'),
    ),
  );
  assert.ok(frameHtml.includes('data-slot="frame"'));
  assert.ok(frameHtml.includes('data-slot="frame-panel"'));
  assert.ok(frameHtml.includes('data-slot="frame-panel-header"'));
  assert.ok(frameHtml.includes('data-slot="frame-panel-footer"'));

  const cardFrameHtml = renderToStaticMarkup(
    createElement(
      CardFrame,
      null,
      createElement(CardFrameHeader, null, createElement(CardFrameTitle, null, '文档日历')),
      createElement(
        Card,
        null,
        createElement(
          CardHeader,
          null,
          createElement(CardTitle, null, '01-方案文档'),
          createElement(CardDescription, null, '1306 份'),
        ),
        createElement(CardPanel, null, '主轴内容'),
        createElement(CardFooter, null, '统计'),
      ),
    ),
  );
  assert.ok(cardFrameHtml.includes('data-slot="card-frame"'));
  assert.ok(cardFrameHtml.includes('data-slot="card"'));
  assert.ok(cardFrameHtml.includes('data-slot="card-panel"'));

  const groupHtml = renderToStaticMarkup(
    createElement(
      Toolbar,
      null,
      createElement(
        ToolbarGroup,
        null,
        createElement(
          Group,
          null,
          createElement(GroupText, null, '域'),
          createElement(GroupSeparator, null),
          createElement(ToolbarButton, { render: createElement(Button, { size: 'xs', variant: 'outline' }) }, '业务文档'),
        ),
      ),
      createElement(ToolbarSeparator, null),
    ),
  );
  assert.ok(groupHtml.includes('data-slot="toolbar"'));
  assert.ok(groupHtml.includes('data-slot="group"'));
  assert.ok(groupHtml.includes('data-slot="toolbar-separator"'));

  const emptyHtml = renderToStaticMarkup(
    createElement(
      Empty,
      null,
      createElement(
        EmptyHeader,
        null,
        createElement(EmptyMedia, { variant: 'icon' }, createElement('span', null, '★')),
        createElement(EmptyTitle, null, '暂无待拍板项'),
        createElement(EmptyDescription, null, '当前目录所有决策均已明确'),
      ),
      createElement(EmptyContent, null, createElement(Button, { size: 'sm' }, '返回星图')),
    ),
  );
  assert.ok(emptyHtml.includes('data-slot="empty"'));
  assert.ok(emptyHtml.includes('data-slot="empty-media"'));
  assert.ok(emptyHtml.includes('-rotate-10') && emptyHtml.includes('rotate-10'), '三卡扇形叠影图标栈');
});

test('V01 index.css 契约：@theme inline、:root/.dark 语义令牌配对与 reduced-motion 停帧', () => {
  const css = readSrc('index.css');
  assert.ok(css.includes('@theme inline {'), '应声明 Tailwind v4 @theme inline 映射层');
  assert.ok(css.includes('.dark {'), '应声明全局 .dark 语义令牌块');

  const requiredTokens = [
    '--background',
    '--foreground',
    '--card',
    '--card-foreground',
    '--popover',
    '--popover-foreground',
    '--primary',
    '--primary-foreground',
    '--secondary',
    '--muted',
    '--muted-foreground',
    '--accent',
    '--brand',
    '--destructive',
    '--info',
    '--success',
    '--warning',
    '--border',
    '--input',
    '--ring',
    '--sidebar',
  ];
  const rootStart = css.indexOf(':root {');
  const darkStart = css.indexOf('.dark {');
  const darkEnd = css.indexOf('  body {', darkStart);
  assert.ok(rootStart >= 0 && darkStart > rootStart && darkEnd > darkStart);
  const rootBlock = css.slice(rootStart, darkStart);
  const darkBlock = css.slice(darkStart, darkEnd);

  for (const token of requiredTokens) {
    assert.ok(rootBlock.includes(`${token}:`), `:root 缺少语义令牌 ${token}`);
    assert.ok(darkBlock.includes(`${token}:`), `.dark 缺少语义令牌 ${token}`);
  }

  assert.ok(
    css.includes('.animate-toast-success-odd') && css.includes('@media (prefers-reduced-motion: reduce)'),
    'Toast 微反馈动画必须登记 reduced-motion 停帧',
  );
});
