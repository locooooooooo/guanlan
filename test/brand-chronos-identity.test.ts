/**
 * 司辰品牌口径：图标母题（曜石银匣文件夹 + 折耳权杖朱砂眼 + 象牙夹页 + 对称银翼与朱砂沙漏）与 Slogan 的单一出口。
 * 把品牌常量改回旧文案，或把品牌徽改回无司辰双翼/亮宝蓝塑料文件夹/旧星盘圆徽，本文件会失败。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandMark } from '../src/components/BrandMark';
import { TopHeader } from '../src/components/TopHeader';
import { WorkspaceGateModal } from '../src/components/WorkspaceGateModal';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import {
  BRAND_ICON_MOTIF,
  BRAND_NAME,
  BRAND_SLOGAN,
  BRAND_SLOGAN_EN,
  BRAND_SLOGAN_NOTE,
  BRAND_TITLE_FULL,
} from '../src/utils/brandIdentity';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 解码 gen-icon.mjs 产出的 1024×1024 RGBA（filter 0）PNG，供校验透明外缘与核心配色。 */
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

test('品牌口径：司辰 Slogan 是单一出口，不再使用旧的知识工作台文案', () => {
  assert.equal(BRAND_NAME, '观澜');
  assert.equal(BRAND_SLOGAN, '司辰记时，观澜见脉');
  assert.equal(BRAND_SLOGAN_NOTE, '让每一次演变与拍板都有迹可循');
  assert.equal(BRAND_SLOGAN_EN, 'Chronos keeps time. Guanlan reveals the trace.');
  assert.equal(BRAND_TITLE_FULL, '观澜 Guanlan · 司辰记时，观澜见脉');
  assert.ok(
    BRAND_ICON_MOTIF.includes('文件夹') &&
      BRAND_ICON_MOTIF.includes('银翼') &&
      BRAND_ICON_MOTIF.includes('沙漏')
  );
  assert.equal(BRAND_SLOGAN.includes('可追溯知识工作台'), false);
  assert.equal(BRAND_SLOGAN.includes('用时间线找到变化'), false);
});

test('司辰翼漏银匣徽 SSR：透明底曜石文件夹 + 折耳朱砂眼 + 象牙夹页 + 司辰双翼沙漏，防挤压不退回旧版', () => {
  const html = renderToStaticMarkup(React.createElement(BrandMark, { size: 'md' }));
  assert.ok(html.includes('data-brand-mark="md"'), '尺寸应落到 data-brand-mark');
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
  assert.ok(html.includes('#3E455A') && html.includes('#161A25'), '文件夹前板应为曜石缎面灰蓝渐变');
  assert.ok(html.includes('#F5F1EA'), '夹层应含温润象牙纸页');
  assert.ok(html.includes('#E8ECF8') && html.includes('#BDC4D9'), '应含司辰对称拉丝银翼渐变');
  assert.ok(html.includes('#F07440') && html.includes('#D44E2A'), '沙漏流沙与折耳眼应为司辰朱砂琥珀');
  assert.equal(html.includes('#5868DA'), false, '不得退回高饱和塑料宝蓝');
  assert.equal(html.includes('animate'), false, '品牌徽保持静态');
  assert.equal(html.includes('fill-rule="evenodd"'), false, '不得退回旧版偏心新月星盘环');
  assert.equal(/<circle[^>]*r="2\.1"/.test(html), false, '不得退回旧版中心实点圆徽');
});

test('顶栏与首启引导渲染司辰 Slogan，并挂上防压缩司辰翼漏文件夹品牌徽', () => {
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
  assert.ok(gate.includes(BRAND_SLOGAN));
  assert.ok(gate.includes('data-brand-mark="lg"'));
  assert.equal(gate.includes('欢迎使用观澜 · 选择本地工作区'), false);

  const home = readFileSync(resolve(repoRoot, 'src/components/HomeView.tsx'), 'utf8');
  assert.ok(
    home.includes('data-brand-slogan') && home.includes('{BRAND_SLOGAN}'),
    '首页问候下应挂司辰 Slogan，而不是另写一套文案'
  );
});

test('窗口标题、安装包短描述、README 与 1024px 桌面源图保持司辰翼漏文件夹一致口径', () => {
  const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
  assert.ok(html.includes(`<title>${BRAND_TITLE_FULL}</title>`));
  assert.ok(
    html.includes('%23343B4F') &&
      html.includes('%23F2EFE9') &&
      html.includes('%23B8C0D6') &&
      html.includes('%23F07440'),
    '浏览器 favicon 应为曜石文件夹 + 折耳朱砂眼 + 象牙夹页 + 司辰银翼与朱砂沙漏'
  );
  assert.equal(html.includes('%234F5FD0'), false, 'favicon 不得残留旧亮宝蓝');
  assert.equal(html.includes('%23112030'), false, 'favicon 不得残留旧深色方框底');
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

  const pngBuf = readFileSync(resolve(repoRoot, 'native/crates/guanlan-desktop/app-icon.png'));
  const { width, height, rgba } = decodeRgbaPng(pngBuf);
  assert.equal(width, 1024, '桌面图标源图应为 1024×1024');
  assert.equal(height, 1024);

  const pixelAt = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]] as const;
  };
  // 1. 文件夹右上折耳外缺口必须保持透明
  assert.equal(pixelAt(860, 170)[3], 0, '文件夹折耳右侧缺口应为完全透明');
  // 2. 左上折耳空白区（x=340, y=195）应为沉稳深曜石灰蓝
  const tabBgPx = pixelAt(340, 195);
  assert.equal(tabBgPx[3], 255, '文件夹左上折耳区域应不透明');
  assert.ok(
    tabBgPx[0] < 75 && tabBgPx[1] < 80 && tabBgPx[2] < 105 && tabBgPx[2] > tabBgPx[0],
    `折耳底色应呈深曜石灰蓝，实得 rgba(${tabBgPx.join(',')})`
  );
  // 3. 左上折耳司辰权杖朱砂眼中心（x=225, y=207，对应 nx=-0.56, ny=-0.595）应为暖朱砂宝珠
  const eyePx = pixelAt(225, 207);
  assert.equal(eyePx[3], 255, '折耳朱砂眼应不透明');
  assert.ok(
    eyePx[0] > 215 && eyePx[1] > 100 && eyePx[2] < 140 && eyePx[0] > eyePx[2] + 90,
    `折耳权杖核心眼应呈暖朱砂色，实得 rgba(${eyePx.join(',')})`
  );
  // 4. 前后板夹层纸页（x=512, y=300）必须为温润象牙白
  const paperPx = pixelAt(512, 300);
  assert.equal(paperPx[3], 255, '夹层纸页应不透明');
  assert.ok(
    paperPx[0] > 205 && paperPx[1] > 205 && paperPx[2] > 200,
    `夹层纸页应呈温润象牙白，实得 rgba(${paperPx.join(',')})`
  );
  // 5. 司辰左侧主羽中段（x=290, y=540，对应 hx≈-0.43, hy≈-0.15）应为亮铂银色，显著亮于深曜石底
  const wingPx = pixelAt(290, 540);
  assert.equal(wingPx[3], 255, '司辰银翼应不透明');
  assert.ok(
    wingPx[0] > 155 && wingPx[1] > 160 && wingPx[2] > 180,
    `沙漏左侧应可见司辰拉丝银翼，实得 rgba(${wingPx.join(',')})`
  );
  // 6. 居中沙漏下仓（x=512, y=745）必须落到司辰朱砂琥珀流沙丘
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
  assert.ok(generator.includes('司辰翼漏银匣徽'));
  assert.equal(generator.includes('深蓝圆徽 + 三圈涟漪'), false);
});
