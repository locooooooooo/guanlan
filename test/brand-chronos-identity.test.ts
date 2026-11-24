/**
 * 司辰品牌口径：图标母题与 Slogan 的单一出口。
 * 把品牌常量改回旧文案，或把品牌徽改回同心涟漪圆，本文件会失败。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandMark } from '../src/components/BrandMark';
import { TopHeader } from '../src/components/TopHeader';
import { WorkspaceGateModal } from '../src/components/WorkspaceGateModal';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import {
  BRAND_NAME,
  BRAND_SLOGAN,
  BRAND_SLOGAN_EN,
  BRAND_SLOGAN_NOTE,
  BRAND_TITLE_FULL,
} from '../src/utils/brandIdentity';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('品牌口径：司辰 Slogan 是单一出口，不再使用旧的知识工作台文案', () => {
  assert.equal(BRAND_NAME, '观澜');
  assert.equal(BRAND_SLOGAN, '司辰记时，观澜见脉');
  assert.equal(BRAND_SLOGAN_NOTE, '让每一次演变与拍板都有迹可循');
  assert.equal(BRAND_SLOGAN_EN, 'Chronos keeps time. Guanlan reveals the trace.');
  assert.equal(BRAND_TITLE_FULL, '观澜 Guanlan · 司辰记时，观澜见脉');
  assert.equal(BRAND_SLOGAN.includes('可追溯知识工作台'), false);
  assert.equal(BRAND_SLOGAN.includes('用时间线找到变化'), false);
});

test('司辰星盘沙漏徽 SSR：新月环、权杖琥珀珠与流沙，不是旧的同心涟漪圆点', () => {
  const html = renderToStaticMarkup(React.createElement(BrandMark, { size: 'md' }));
  assert.ok(html.includes('data-brand-mark="md"'), '尺寸应落到 data-brand-mark');
  assert.ok(html.includes('fill-rule="evenodd"'), '新月星盘应是偏心圆环，不是实心圆点');
  assert.ok(html.includes('#F3843E'), '12 点权杖核心应为司辰琥珀珠');
  assert.ok(html.includes('#F27E3B') && html.includes('#D65222'), '沙漏流沙应为暖琥珀渐变');
  assert.equal(html.includes('animate'), false, '品牌徽保持静态');
  assert.equal(/<circle[^>]*r="2\.1"/.test(html), false, '不得退回旧版中心实点圆徽');
});

test('顶栏与首启引导渲染司辰 Slogan，并挂上新品牌徽', () => {
  const header = renderToStaticMarkup(
    React.createElement(TopHeader, {
      activeTab: 'home',
      onSelectTab: () => {},
      searchQuery: '',
      onSearchChange: () => {},
      searchHits: [],
      onSelectSearchHit: () => {},
      unreadFilesCount: 0,
      contextBasketCount: 0,
      eventCount: 0,
      decisions: [],
      onOpenDecision: () => {},
      config: EMPTY_WORKSPACE_CONFIG,
      dataSource: 'loading',
      scanSummary: '',
      dataError: null,
      files: [],
      sidebarFilters: { quickScope: 'all', folder: 'all', format: 'all', role: 'all', topic: 'all' },
      onUpdateSidebarFilters: () => {},
      onResetSidebarFilters: () => {},
      libraryMode: 'read',
      onLibraryModeChange: () => {},
      onOpenSettings: () => {},
      onOpenMcpConsole: () => {},
      onOpenContextDrawer: () => {},
    })
  );
  assert.match(
    header,
    /leading-\[var\(--lh-micro\)\][^>]*>司辰记时，观澜见脉</,
    '顶栏品牌名下方应可见司辰 Slogan，不能只写在 title 里'
  );
  assert.ok(header.includes('data-brand-mark="sm"'), '顶栏品牌徽应换成司辰星盘沙漏');
  assert.equal(header.includes('观澜 X-Ray'), false);

  const gate = renderToStaticMarkup(
    React.createElement(WorkspaceGateModal, {
      session: {
        status: 'unconfigured',
        endpoint: '',
        root: null,
        workspaceName: null,
        recentWorkspaces: [],
      },
      onPickFolder: () => {},
      onOpenRoot: () => {},
    })
  );
  assert.ok(gate.includes(`欢迎使用${BRAND_NAME}`));
  assert.ok(gate.includes(BRAND_SLOGAN));
  assert.ok(gate.includes('data-brand-mark="lg"'));
  assert.equal(gate.includes('欢迎使用观澜 · 选择本地工作区'), false);

  const home = readFileSync(resolve(repoRoot, 'src/components/HomeView.tsx'), 'utf8');
  assert.ok(
    home.includes('data-brand-slogan') && home.includes('{BRAND_SLOGAN}'),
    '首页问候下应挂司辰 Slogan，而不是另写一套文案'
  );
});

test('窗口标题、安装包短描述与 README 引用同一句司辰 Slogan', () => {
  const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
  assert.ok(html.includes(`<title>${BRAND_TITLE_FULL}</title>`));
  assert.ok(html.includes('%23F3843E'), '浏览器图标应带司辰琥珀珠，而不是旧涟漪圆点');
  assert.equal(html.includes('可追溯知识工作台'), false);

  const tauri = JSON.parse(
    readFileSync(resolve(repoRoot, 'native/crates/guanlan-desktop/tauri.conf.json'), 'utf8')
  ) as { bundle: { shortDescription: string; longDescription: string } };
  assert.ok(tauri.bundle.shortDescription.includes(BRAND_SLOGAN));
  assert.ok(tauri.bundle.longDescription.includes(BRAND_SLOGAN_NOTE));
  assert.equal(tauri.bundle.shortDescription.includes('时空因果型'), false);

  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
  const readmeEn = readFileSync(resolve(repoRoot, 'README.en.md'), 'utf8');
  assert.ok(readme.includes(BRAND_SLOGAN));
  assert.ok(readmeEn.includes(BRAND_SLOGAN_EN));

  const png = readFileSync(resolve(repoRoot, 'native/crates/guanlan-desktop/app-icon.png'));
  assert.equal(png.readUInt32BE(16), 1024, '桌面图标源图应为 1024×1024');
  assert.equal(png.readUInt32BE(20), 1024);
  assert.ok(png.length > 100_000, '司辰星盘沙漏源图应取代 60KB 的旧涟漪圆徽');
  const generator = readFileSync(
    resolve(repoRoot, 'native/crates/guanlan-desktop/gen-icon.mjs'),
    'utf8'
  );
  assert.ok(generator.includes('司辰星盘沙漏徽'));
  assert.equal(generator.includes('深蓝圆徽 + 三圈涟漪'), false);
});
