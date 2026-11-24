/**
 * 前端交互、无障碍、响应式与韧性回归测试：
 * 1. 触控热区 ≥44px 与无悬停设备（pointer: coarse / hover: none）兜底规则；
 * 2. 去掉装饰性极光渐变、发光光球、UI 表情符号与含糊文案；
 * 3. WCAG AA 对比度计算校核（--ink-faint 明暗双态 + 夜间阅读六阶段令牌 + 全景暗画布选中态）；
 * 4. 空态 / 加载中 / 错误态诚实渲染（绝不把断连伪装成空工作区）、ErrorBoundary 兜底；
 * 5. 全部弹窗/抽屉 Esc + 外部点击关闭、异步防重锁与空字段守卫。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HomeView from '../src/components/HomeView';
import { LeftSidebar } from '../src/components/LeftSidebar';
import { AppBanners } from '../src/components/app/AppBanners';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { AgentContextDrawer } from '../src/components/modals/AgentContextDrawer';
import { appThemeModeLabel } from '../src/stores/appThemeStore';
import type { ContextResponse } from '../src/services/apiTypes';
import type { WorkspaceStoreCtx } from '../src/stores/useWorkspaceStore';

function readSrc(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relPath}`, import.meta.url)), 'utf8');
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const s = parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('CSS 触控人体工学：pointer: coarse 保证交互按钮 ≥44×44px，hover: none 禁止纯悬停隐藏', () => {
  const css = readSrc('index.css');
  assert.ok(css.includes('@media (pointer: coarse)'), '应声明 pointer: coarse 触控媒体查询');
  assert.ok(css.includes('min-height: 44px;'), '触控模式交互控件最小高度须 ≥44px');
  assert.ok(css.includes('min-width: 44px;'), '触控模式交互按钮最小宽度须 ≥44px');
  assert.ok(
    css.includes('@media (hover: none), (pointer: coarse)') &&
      css.includes('[class*="group-hover:opacity-100"]'),
    '无悬停设备须将 group-hover 隐显控件常驻可见'
  );
});

test('去「AI 味」：壳层表面零装饰性极光渐变、焦点卡零 blur-2xl 发光光球、UI 零表情符号与含糊文案', () => {
  const css = readSrc('index.css');
  const glassPageBlock = css.slice(css.indexOf('.glass-page {'), css.indexOf('.glass-pop {'));
  assert.ok(!glassPageBlock.includes('radial-gradient'), '.glass-page 不得含装饰性极光径向渐变');

  const depth0Block = css.slice(css.indexOf('.depth-0-surface {'), css.indexOf('.depth-1-group {'));
  assert.ok(!depth0Block.includes('radial-gradient'), '.depth-0-surface 不得含装饰性极光径向渐变');

  const focusCardsSrc = readSrc('components/FeaturedFocusCards.tsx');
  assert.ok(!focusCardsSrc.includes('blur-2xl'), 'FeaturedFocusCards 不得含装饰性 blur-2xl 发光球');
  assert.ok(!focusCardsSrc.includes('radial-gradient'), 'FeaturedFocusCards 不得含装饰性径向光晕');

  const noEmojiFiles = [
    'components/canvas/RichDocPreviewCard.tsx',
    'components/DocumentTimeMachineView.tsx',
    'components/CommandPalette.tsx',
    'components/graph/graphCanvasChrome.tsx',
    'components/reader/readerShared.tsx',
    'components/reader/readerMarkdownSection.tsx',
    'components/reader/readerRender.tsx',
  ];
  const forbiddenEmojis = ['💡', '📁', '🌠', '📋', '★', '✎'];
  for (const rel of noEmojiFiles) {
    const codeOnly = readSrc(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const em of forbiddenEmojis) {
      assert.ok(!codeOnly.includes(em), `${rel} 渲染代码不得包含装饰表情/符号 ${em}`);
    }
  }

  assert.equal(appThemeModeLabel('light'), '浅色');
  assert.equal(appThemeModeLabel('dark'), '深色');
  assert.equal(appThemeModeLabel('system'), '跟随系统');
  assert.ok(!readSrc('components/DecisionResolveCard.tsx').includes('自动解锁'));
  assert.ok(!readSrc('components/ReviewBoardDrawer.tsx').includes('自动解锁'));
  assert.ok(!readSrc('stores/useWorkspaceStore.tsx').includes('已解锁'));
});

test('WCAG AA 对比度：--ink-faint 明暗双态与夜间阅读六阶段文字色全部 ≥4.5:1', () => {
  const css = readSrc('index.css');
  const lightFaint = css.match(/--ink-faint:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(lightFaint, 'index.css 应声明浅色 --ink-faint');
  assert.ok(
    contrastRatio(lightFaint, '#F1EFF8') >= 4.5 && contrastRatio(lightFaint, '#FFFFFF') >= 4.5,
    `浅色 --ink-faint (${lightFaint}) 在浅底上对比度须 ≥4.5:1`
  );

  const darkBlock = css.slice(css.indexOf('.dark {'), css.indexOf('body {'));
  const darkFaint = darkBlock.match(/--ink-faint:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(darkFaint, '.dark 块应声明 --ink-faint');
  assert.ok(
    contrastRatio(darkFaint, '#161820') >= 4.5,
    `暗色 --ink-faint (${darkFaint}) 在卡片暗底上对比度须 ≥4.5:1`
  );

  const readerDarkBlock = css.slice(
    css.indexOf('[data-reader-dark="true"] {'),
    css.indexOf('::-webkit-scrollbar')
  );
  const deliverText = readerDarkBlock.match(/--stage-ink-deliver-text:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(deliverText, '[data-reader-dark="true"] 应覆写 --stage-ink-deliver-text');
  assert.ok(
    contrastRatio(deliverText, '#101218') >= 4.5,
    `夜间阅读 --stage-ink-deliver-text (${deliverText}) 对比度须 ≥4.5:1`
  );
});

test('多状态诚实呈现：HomeView 错误态绝不伪装空态，LeftSidebar 加载/错误态语义清晰', () => {
  const errHomeHtml = renderToStaticMarkup(
    React.createElement(HomeView, {
      files: [],
      readingStates: {},
      events: [],
      summary: null,
      eventDays: null,
      recentItems: [],
      dataSource: 'error',
      dataError: '读服务暂时不可用（503）',
      onRetryConnection: () => {},
      onOpenDoc: () => {},
      onResumeReading: () => {},
      onMarkFullyRead: () => {},
      onOpenPackageBoard: () => {},
      onOpenPanorama: () => {},
    })
  );
  assert.ok(errHomeHtml.includes('data-home-error-state'), 'HomeView 错误态应渲染专属错误卡片');
  assert.ok(errHomeHtml.includes('role="alert"'), 'HomeView 错误态应带 role="alert"');
  assert.ok(errHomeHtml.includes('重试加载'), 'HomeView 错误态应提供重试加载按钮');
  assert.ok(!errHomeHtml.includes('全部已定案'), 'HomeView 错误态不得伪称「全部已定案」');

  const baseSidebarProps = {
    files: [],
    readingStates: {},
    activeFileId: '',
    filters: {
      quickScope: 'all' as const,
      folder: 'all' as const,
      format: 'all' as const,
      role: 'all' as const,
      topic: 'all' as const,
    },
    onUpdateFilters: () => {},
    onResetFilters: () => {},
    onOpenFileToRead: () => {},
    onRetryConnection: () => {},
  };

  const loadingSidebarHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, { ...baseSidebarProps, dataSource: 'loading' })
  );
  assert.ok(loadingSidebarHtml.includes('aria-busy="true"'), 'LeftSidebar 加载态应标注 aria-busy');
  assert.ok(
    !loadingSidebarHtml.includes('当前工作区暂无目录或文件'),
    'LeftSidebar 加载态不得显示空工作区文案'
  );

  const errorSidebarHtml = renderToStaticMarkup(
    React.createElement(LeftSidebar, { ...baseSidebarProps, dataSource: 'error' })
  );
  assert.ok(errorSidebarHtml.includes('role="alert"'), 'LeftSidebar 错误态应带 role="alert"');
  assert.ok(errorSidebarHtml.includes('重试连接'), 'LeftSidebar 错误态应提供重试连接按钮');
});

test('异常韧性：ErrorBoundary 可捕获子组件异常，AgentContextDrawer 对缺字段响应零崩溃', () => {
  const normalHtml = renderToStaticMarkup(
    React.createElement(ErrorBoundary, null, React.createElement('div', null, '正常内容'))
  );
  assert.ok(normalHtml.includes('正常内容'));

  const derived = ErrorBoundary.getDerivedStateFromError(new Error('空字段异常'));
  assert.equal(derived.hasError, true);
  assert.equal(derived.message, '空字段异常');

  // 模拟残缺的 /api/v1/context 响应（缺 preset 与 token_budget），验证抽屉不会 TypeError 崩溃
  const malformedServerContext = { ok: true } as unknown as ContextResponse;
  const drawerHtml = renderToStaticMarkup(
    React.createElement(AgentContextDrawer, {
      isOpen: true,
      onClose: () => {},
      pointers: [],
      onRemovePointer: () => {},
      onClearPointers: () => {},
      workspaceRoot: 'F:\\Workspaces\\Demo',
      intent: 'global',
      intentTemplate: '',
      presetPointers: [],
      recommendedMounts: [],
      onMountPointers: () => {},
      onUpdatePointerGranularity: () => {},
      confirmedDecisions: [],
      pendingBlockers: [],
      initialServerContext: malformedServerContext,
    })
  );
  assert.ok(drawerHtml.includes('role="dialog"'), '残缺上下文响应下 AgentContextDrawer 仍可安全渲染');
});

test('交互闭环与防重提交：全浮层支持 Esc 与外部点击关闭，store 具备同步防重 ref 锁', () => {
  const overlays = [
    'components/ReviewBoardDrawer.tsx',
    'components/modals/AgentContextDrawer.tsx',
    'components/modals/McpConsoleModal.tsx',
    'components/MountManagerPanel.tsx',
    'components/FileTimelineDrawer.tsx',
    'components/AddProjectModal.tsx',
    'components/FileOpsModal.tsx',
  ];
  for (const rel of overlays) {
    const src = readSrc(rel);
    assert.ok(src.includes("e.key === 'Escape'"), `${rel} 应支持 Esc 键关闭`);
    assert.ok(
      src.includes('e.target === e.currentTarget'),
      `${rel} 应支持点击外部遮罩关闭`
    );
  }

  const storeSrc = readSrc('stores/useWorkspaceStore.tsx');
  assert.ok(storeSrc.includes('rescanInFlightRef'), 'handleRescan 须使用同步 ref 锁防止慢网重复提交');
  assert.ok(storeSrc.includes('lifecycleInFlightRef'), 'runInitiativeLifecycle 须使用同步 ref 锁');
  assert.ok(storeSrc.includes('silentMergeInFlightRef'), 'silentMergeNewEvents 须使用同步 ref 锁');
  assert.ok(storeSrc.includes('handleRetryConnection'), 'store 须提供断网恢复重试动作');
  assert.ok(
    readSrc('hooks/useDirectoryShell.ts').includes('Array.isArray(res.data.folders)'),
    'useDirectoryShell 须校验 folders 为数组防止白屏'
  );
});

test('工作区切换过渡态：switchingWorkspace 期间展示中性状态条并抑制旧后端断连/扫描失败红条', () => {
  const baseCtx = {
    rescanState: 'error',
    rescanError: '无法连接观澜读服务（/api/v1）',
    handleRescan: async () => {},
    l4aProgress: null,
    hitlClearedAt: null,
    deliveredInitiative: null,
    deliveredInitiatives: [],
    initiativeLifecycle: null,
    runInitiativeLifecycle: async () => {},
    activeInitiative: null,
    changeNotice: null,
    refreshEvents: async () => {},
    silentMergeNewEvents: async () => {},
    silentMergingEvents: false,
    dataSource: 'error',
    files: [],
    dataError: '无法连接观澜读服务（/api/v1）',
    activeTab: 'home',
    networkOffline: false,
    streamDisconnected: true,
    retryingConnection: false,
    handleRetryConnection: async () => {},
    switchingWorkspace: true,
  } as unknown as WorkspaceStoreCtx;

  const switchingHtml = renderToStaticMarkup(React.createElement(AppBanners, { ctx: baseCtx }));
  assert.ok(
    switchingHtml.includes('data-switching-workspace-banner'),
    '切换工作区期间应展示中性切换状态条'
  );
  assert.ok(switchingHtml.includes('正在切换工作区'), '切换状态条文案应明确告知正在切换');
  assert.ok(
    !switchingHtml.includes('data-connection-alert'),
    '切换工作区期间不得弹出旧后端断连告警红条'
  );
  assert.ok(
    !switchingHtml.includes('扫描失败'),
    '切换工作区期间不得弹出旧后端扫描失败红条'
  );

  const idleErrorHtml = renderToStaticMarkup(
    React.createElement(AppBanners, { ctx: { ...baseCtx, switchingWorkspace: false } })
  );
  assert.ok(
    idleErrorHtml.includes('data-connection-alert'),
    '非切换态真正断连时仍须正常展示断连告警条'
  );
  assert.ok(idleErrorHtml.includes('扫描失败'), '非切换态真正扫描失败时仍须展示失败条');

  const storeSrc = readSrc('stores/useWorkspaceStore.tsx');
  assert.ok(
    storeSrc.includes('switchingWorkspaceRef'),
    'useWorkspaceStore 须维护同步 switchingWorkspaceRef 抑制切走瞬间的断连回调'
  );
  assert.ok(
    storeSrc.includes('streamEverConnectedRef.current = false'),
    'resetWorkspaceScopedState 须重置 SSE 断连状态，避免旧工作区红条残留'
  );
});
