import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandMark } from '../src/components/BrandMark';
import { TopHeader } from '../src/components/TopHeader';
import { WorkspaceGateModal } from '../src/components/WorkspaceGateModal';
import { WorkspaceSettingsModal } from '../src/components/modals/WorkspaceSettingsModal';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import {
  BRAND_ICON_MOTIF,
  BRAND_LONG_DESCRIPTION,
  BRAND_NAME,
  BRAND_NAME_EN,
  BRAND_SHORT_DESCRIPTION,
  BRAND_SLOGAN,
  BRAND_SLOGAN_EN,
  BRAND_SLOGAN_EXTENDED,
  BRAND_SLOGAN_EXTENDED_EN,
  BRAND_SLOGAN_NOTE,
  BRAND_SLOGAN_NOTE_EN,
  BRAND_TITLE_FULL,
} from '../src/utils/brandIdentity';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function decodeRgbaPng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const idatChunks: Buffer[] = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') {
      idatChunks.push(buf.subarray(pos + 8, pos + 8 + len));
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idatChunks));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, rgba };
}

test('品牌口径：司辰中英 Slogan 与「档案在本地」副句是单一出口，不再残留旧文案', () => {
  assert.equal(BRAND_NAME, '观澜');
  assert.equal(BRAND_NAME_EN, 'Guanlan');
  assert.equal(BRAND_SLOGAN, '司辰记时，观澜见脉');
  assert.equal(BRAND_SLOGAN_NOTE, '档案在本地，每次改动与拍板都有迹可循');
  assert.equal(BRAND_SLOGAN_EXTENDED, '司辰记时，观澜见脉 · 档案在本地，每次改动与拍板都有迹可循');
  assert.equal(BRAND_SLOGAN_EN, 'Chronos keeps time. Guanlan reveals the trace.');
  assert.equal(
    BRAND_SLOGAN_NOTE_EN,
    'Your folders stay local — every change and decision stays traceable.'
  );
  assert.equal(
    BRAND_SLOGAN_EXTENDED_EN,
    'Chronos keeps time. Guanlan reveals the trace. Your folders stay local — every change and decision stays traceable.'
  );
  assert.equal(BRAND_TITLE_FULL, '观澜 Guanlan · 司辰记时，观澜见脉');
  assert.ok(BRAND_SHORT_DESCRIPTION.includes(BRAND_SLOGAN));
  assert.ok(BRAND_LONG_DESCRIPTION.includes(BRAND_SLOGAN_NOTE));
  assert.ok(
    BRAND_ICON_MOTIF.includes('文件夹') &&
      BRAND_ICON_MOTIF.includes('银翼') &&
      BRAND_ICON_MOTIF.includes('沙漏')
  );
  assert.equal(BRAND_SLOGAN.includes('可追溯知识工作台'), false);
  assert.equal(BRAND_SLOGAN_NOTE.includes('让每一次演变'), false);
});

test('司辰翼漏银匣徽 SSR 与独立矢量标 public/guanlan-logo.svg：四档规格完整且防挤压不退回旧版', () => {
  for (const size of ['sm', 'md', 'lg', 'xl'] as const) {
    const html = renderToStaticMarkup(React.createElement(BrandMark, { size }));
    assert.ok(html.includes(`data-brand-mark="${size}"`), `规格 ${size} 应落到 data-brand-mark`);
    assert.ok(
      html.includes('data-brand-motif="folder-hourglass"'),
      '品牌徽应标明文件夹+沙漏母题'
    );
    assert.ok(
      html.includes('data-chronos-emblem="wings-tab-eye"'),
      '品牌徽应标明司辰双翼与折耳朱砂眼元素'
    );
    assert.ok(
      html.includes('aspect-square') && html.includes('shrink-0'),
      '容器必须锁等比防压缩'
    );
    assert.ok(
      html.includes('preserveAspectRatio="xMidYMid meet"'),
      'SVG 必须锁定等比居中缩放'
    );
    assert.ok(html.includes('#545C78') && html.includes('#202534'), '文件夹前板应为提亮后的曜石缎面灰蓝渐变');
    assert.ok(html.includes('#F5F1EA'), '夹层应含温润象牙纸页');
    assert.ok(html.includes('#F0F3FB') && html.includes('#C9CFE2'), '应含司辰对称拉丝银翼渐变');
    assert.ok(html.includes('#F07440') && html.includes('#D44E2A'), '沙漏流沙与折耳眼应为司辰朱砂琥珀');
    assert.equal(html.includes('#5868DA'), false, '不得退回高饱和塑料宝蓝');
    assert.equal(html.includes('#3E455A'), false, '不得退回提亮前的旧前板深灰');
    assert.equal(html.includes('animate'), false, '品牌徽保持静态');
    assert.equal(html.includes('fill-rule="evenodd"'), false, '不得退回旧版偏心新月星盘环');
    assert.equal(/<circle[^>]*r="2\.1"/.test(html), false, '不得退回旧版中心实点圆徽');
  }

  const logoSvgPath = resolve(repoRoot, 'public/guanlan-logo.svg');
  assert.ok(existsSync(logoSvgPath), 'public/guanlan-logo.svg 应存在');
  const logoSvg = readFileSync(logoSvgPath, 'utf8');
  assert.ok(
    logoSvg.includes('#545C78') &&
      logoSvg.includes('#F5F1EA') &&
      logoSvg.includes('#F0F3FB') &&
      logoSvg.includes('#F07440'),
    '独立矢量标应与 BrandMark 配色和母题一致'
  );
});

test('顶栏、首启引导、关于观澜与首页全链路渲染升级后的品牌锁头与新 Slogan', () => {
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
  assert.ok(header.includes('data-brand-lockup="header"'), '顶栏应渲染统一品牌锁头');
  assert.match(
    header,
    /leading-\[var\(--lh-micro\)\][^>]*>司辰记时，观澜见脉</,
    '顶栏品牌名下方应可见司辰 Slogan，不能只写在 title 里'
  );
  assert.ok(header.includes('data-brand-mark="sm"'), '顶栏品牌徽应使用 sm 规格');
  assert.ok(header.includes('data-chronos-emblem="wings-tab-eye"'), '顶栏应为司辰翼漏徽');
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
  assert.ok(gate.includes('data-gate-slogan=""'), '首启引导应独立呈献品牌 Slogan 行');
  assert.ok(gate.includes(BRAND_SLOGAN) && gate.includes(BRAND_SLOGAN_NOTE));
  assert.ok(gate.includes('data-brand-mark="lg"'));
  assert.equal(gate.includes('欢迎使用观澜 · 选择本地工作区'), false);

  const about = renderToStaticMarkup(
    React.createElement(WorkspaceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      config: EMPTY_WORKSPACE_CONFIG,
      initialTab: 'about',
    })
  );
  assert.ok(about.includes('data-about-brand-hero=""'), '关于观澜应渲染升级后的品牌头图卡');
  assert.ok(about.includes('data-brand-mark="xl"'), '关于观澜品牌头图应使用 xl 规格');
  assert.ok(about.includes(BRAND_SLOGAN) && about.includes(BRAND_SLOGAN_NOTE));

  const home = readFileSync(resolve(repoRoot, 'src/components/HomeView.tsx'), 'utf8');
  assert.ok(
    home.includes('data-brand-slogan') &&
      home.includes('{BRAND_SLOGAN}') &&
      home.includes('{BRAND_SLOGAN_NOTE}'),
    '首页问候下应挂司辰 Slogan 与副句，而不是另写一套文案'
  );
});

test('窗口标题、元数据、安装包描述、中英文 README 与 1024px 桌面源图保持全端一致', () => {
  const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
  assert.ok(html.includes(`<title>${BRAND_TITLE_FULL}</title>`));
  assert.ok(html.includes('href="/guanlan-logo.svg"'), 'index.html 应声明官方矢量图标 apple-touch-icon');
  assert.ok(html.includes('name="theme-color" content="#1A1E29"'), 'theme-color 应匹配曜石品牌主色');
  assert.ok(html.includes(BRAND_SLOGAN_NOTE), 'index.html description 应同步升级后的 Slogan 副句');
  assert.ok(
    html.includes('%23414A63') &&
      html.includes('%23F2EFE9') &&
      html.includes('%23C9CFE2') &&
      html.includes('%23F07440'),
    '浏览器 favicon 应为曜石文件夹 + 折耳朱砂眼 + 象牙夹页 + 司辰银翼与朱砂沙漏'
  );
  assert.equal(html.includes('%234F5FD0'), false, 'favicon 不得残留旧亮宝蓝');
  assert.equal(html.includes('%23112030'), false, 'favicon 不得残留旧深色方框底');
  assert.equal(html.includes('%23343B4F'), false, 'favicon 不得残留提亮前的旧前板深灰');
  assert.equal(html.includes('可追溯知识工作台'), false);

  const tauri = JSON.parse(
    readFileSync(resolve(repoRoot, 'native/crates/guanlan-desktop/tauri.conf.json'), 'utf8')
  ) as { bundle: { shortDescription: string; longDescription: string } };
  assert.equal(tauri.bundle.shortDescription, BRAND_SHORT_DESCRIPTION);
  assert.equal(tauri.bundle.longDescription, BRAND_LONG_DESCRIPTION);

  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
  const readmeEn = readFileSync(resolve(repoRoot, 'README.en.md'), 'utf8');
  assert.ok(
    readme.includes('native/crates/guanlan-desktop/icons/128x128@2x.png'),
    '中文 README 顶部应展示官方品牌 Logo'
  );
  assert.ok(readme.includes(BRAND_SLOGAN) && readme.includes(BRAND_SLOGAN_NOTE));
  assert.ok(
    readmeEn.includes('native/crates/guanlan-desktop/icons/128x128@2x.png'),
    '英文 README 顶部应展示官方品牌 Logo'
  );
  assert.ok(readmeEn.includes(BRAND_SLOGAN_EN) && readmeEn.includes(BRAND_SLOGAN_NOTE_EN));

  const pngBuf = readFileSync(resolve(repoRoot, 'native/crates/guanlan-desktop/app-icon.png'));
  const { width, height, rgba } = decodeRgbaPng(pngBuf);
  assert.equal(width, 1024, '桌面图标源图应为 1024×1024');
  assert.equal(height, 1024);

  const pixelAt = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]] as const;
  };
  assert.equal(pixelAt(860, 170)[3], 0, '文件夹折耳右侧缺口应为完全透明');
  const tabBgPx = pixelAt(340, 195);
  assert.equal(tabBgPx[3], 255, '文件夹左上折耳区域应不透明');
  assert.ok(
    tabBgPx[0] < 75 && tabBgPx[1] < 80 && tabBgPx[2] < 105 && tabBgPx[2] > tabBgPx[0],
    `折耳底色应呈深曜石灰蓝，实得 rgba(${tabBgPx.join(',')})`
  );
  const eyePx = pixelAt(225, 207);
  assert.equal(eyePx[3], 255, '折耳朱砂眼应不透明');
  assert.ok(
    eyePx[0] > 215 && eyePx[1] > 100 && eyePx[2] < 140 && eyePx[0] > eyePx[2] + 90,
    `折耳权杖核心眼应呈暖朱砂色，实得 rgba(${eyePx.join(',')})`
  );
  const eyeRingPx = pixelAt(225, 170);
  assert.equal(eyeRingPx[3], 255, '折耳朱砂眼外环上沿应不透明');
  assert.ok(
    eyeRingPx[0] > 175 && eyeRingPx[1] > 185 && eyeRingPx[2] > 205,
    `折耳眼外环应放大至该点呈精钢银环而非折耳底色，实得 rgba(${eyeRingPx.join(',')})`
  );
  const paperPx = pixelAt(512, 300);
  assert.equal(paperPx[3], 255, '夹层纸页应不透明');
  assert.ok(
    paperPx[0] > 205 && paperPx[1] > 205 && paperPx[2] > 200,
    `夹层纸页应呈温润象牙白，实得 rgba(${paperPx.join(',')})`
  );
  const wingPx = pixelAt(290, 540);
  assert.equal(wingPx[3], 255, '司辰银翼应不透明');
  assert.ok(
    wingPx[0] > 155 && wingPx[1] > 160 && wingPx[2] > 180,
    `沙漏左侧应可见司辰拉丝银翼，实得 rgba(${wingPx.join(',')})`
  );
  const sandPx = pixelAt(512, 745);
  assert.equal(sandPx[3], 255, '居中沙漏下仓流沙应不透明');
  assert.ok(
    sandPx[0] > 205 && sandPx[1] > 70 && sandPx[1] < 150 && sandPx[2] < 85,
    `居中沙漏下仓应为司辰朱砂琥珀，实得 rgba(${sandPx.join(',')})`
  );

  const generator = readFileSync(
    resolve(repoRoot, 'native/crates/guanlan-desktop/gen-icon.mjs'),
    'utf8'
  );
  assert.equal(generator.includes('public/assets/aistudio/'), false, '图标生成脚本不应再引用废弃的 aistudio 目录');
});

test('司辰立绘静态资源路径有效且无废弃设计稿 / u12 过程截图目录残留', () => {
  const mascotSrc = readFileSync(
    resolve(repoRoot, 'src/components/ChronosMascotNode.tsx'),
    'utf8'
  );
  const match = mascotSrc.match(/const MASCOT_SRC\s*=\s*'([^']+)'/);
  assert.ok(match, 'ChronosMascotNode.tsx 应声明 MASCOT_SRC 静态资源路径');
  const assetUrl = match[1];
  assert.equal(assetUrl.includes('aistudio'), false, '司辰立绘不应留在 aistudio 导出稿路径下');
  const assetDiskPath = resolve(repoRoot, 'public', assetUrl.replace(/^\/+/, ''));
  assert.ok(existsSync(assetDiskPath), `MASCOT_SRC 指向的静态资源不存在：${assetDiskPath}`);

  assert.equal(
    existsSync(resolve(repoRoot, 'public/assets/aistudio')),
    false,
    '废弃设计稿目录 public/assets/aistudio 不应残留'
  );
  assert.equal(
    existsSync(resolve(repoRoot, 'scripts/visual-baseline/u12')),
    false,
    '废弃过程截图目录 scripts/visual-baseline/u12 不应残留'
  );
});
