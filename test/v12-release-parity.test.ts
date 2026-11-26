
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  APP_BUILD_INFO,
  formatBuildFingerprint,
  formatBuildTimestamp,
} from '../src/utils/appBuildInfo';
import { WorkspaceSettingsModal } from '../src/components/modals/WorkspaceSettingsModal';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import {
  classifyAssetDomain,
  countAssetsByDomain,
  filterAssetsByDomain,
  resolveCalendarSlotMode,
} from '../src/components/CalendarBoardView';
import {
  formatMiddleEllipsisName,
  isFolderMuted,
} from '../src/utils/sidebarTree';
import {
  computeChunkedListSlice,
  computeVirtualWindowSlice,
  SIDEBAR_FILE_SLICE_THRESHOLD,
} from '../src/utils/virtualSlice';
import {
  isShortcutChordPrefix,
  resolveShortcutAction,
  resolveShortcutChord,
  type RawKeyInput,
} from '../src/utils/keyboardShortcuts';
import {
  buildChronosDigest,
  chronosReplayIntervalMs,
  stepChronosReplayIndex,
} from '../src/utils/chronosDigest';
import {
  appThemeModeLabel,
  nextAppThemeMode,
  resolveEffectiveAppTheme,
} from '../src/stores/appThemeStore';
import type { FileRecord } from '../src/types/guanlan';

function makeDummyFile(id: string, relPath: string, format: FileRecord['format']): FileRecord {
  const title = relPath.split('/').pop() ?? relPath;
  const revId = `rev_${id}`;
  return {
    file_id: id,
    relative_path: relPath,
    title,
    format,
    folder: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.',
    role: '方案',
    roleProvenance: '来自路径',
    coverage: 'full_text',
    topics: [],
    current_revision_id: revId,
    revisions: [
      {
        revision_id: revId,
        file_id: id,
        versionNumber: 1,
        content_sha256: `sha_${id}`,
        sizeBytes: 256,
        observed_at: '2026-11-23T10:00:00+08:00',
        source_time: '2026-11-23',
        snapshotAvailable: true,
        summaryNote: '',
        changedSectionsFromPrev: [],
      },
    ],
  };
}

function keyInput(
  key: string,
  mods: Partial<Omit<RawKeyInput, 'key'>> = {}
): RawKeyInput {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    isComposing: mods.isComposing ?? false,
  };
}


test('package.json 版本号已升级至 1.2.3', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version: string; name: string };
  assert.equal(pkg.version, '1.2.3');
  assert.equal(pkg.name, 'guanlan');
});

test('native/Cargo.toml workspace.package.version 已同步升级至 1.2.3', () => {
  const toml = readFileSync(new URL('../native/Cargo.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[workspace\.package\][\s\S]*?version\s*=\s*"1\.2\.3"/);
});

test('tauri.conf.json 版本号已同步升级至 1.2.3 且保持 NSIS+MSI 与右键菜单钩子', () => {
  const conf = JSON.parse(
    readFileSync(
      new URL('../native/crates/guanlan-desktop/tauri.conf.json', import.meta.url),
      'utf8'
    )
  ) as {
    productName: string;
    version: string;
    bundle: { targets: string[]; windows: { nsis: { installerHooks: string } } };
  };
  assert.equal(conf.productName, 'Guanlan');
  assert.equal(conf.version, '1.2.3');
  assert.ok(conf.bundle.targets.includes('nsis'));
  assert.ok(conf.bundle.targets.includes('msi'));
  assert.equal(conf.bundle.windows.nsis.installerHooks, './installer/windows-context-menu.nsh');
});

test('vite.config.ts 静态注入 __GUANLAN_APP_VERSION__ / __GUANLAN_GIT_SHA__ / __GUANLAN_BUILD_TIME__', () => {
  const viteSrc = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.ok(viteSrc.includes('__GUANLAN_APP_VERSION__'));
  assert.ok(viteSrc.includes('__GUANLAN_GIT_SHA__'));
  assert.ok(viteSrc.includes('__GUANLAN_BUILD_TIME__'));
  assert.ok(viteSrc.includes('git rev-parse --short HEAD'));
});

test('tauri.release.conf.json 与 windows-context-menu.nsh 资产齐备', () => {
  const relConfUrl = new URL(
    '../native/crates/guanlan-desktop/tauri.release.conf.json',
    import.meta.url
  );
  const hookUrl = new URL(
    '../native/crates/guanlan-desktop/installer/windows-context-menu.nsh',
    import.meta.url
  );
  assert.ok(existsSync(relConfUrl));
  assert.ok(existsSync(hookUrl));
  const relConf = JSON.parse(readFileSync(relConfUrl, 'utf8')) as {
    bundle: { externalBin: string[] };
  };
  assert.ok(relConf.bundle.externalBin.includes('binaries/guanlan'));
});


test('APP_BUILD_INFO 与 formatBuildTimestamp / formatBuildFingerprint 口径稳定', () => {
  assert.equal(APP_BUILD_INFO.version, '1.2.3');
  assert.equal(APP_BUILD_INFO.versionTag, 'v1.2.3');
  assert.ok(APP_BUILD_INFO.gitSha.length > 0);
  assert.equal(formatBuildTimestamp('2026-11-23T17:30:45.123Z'), '2026-11-23 17:30 UTC');
  assert.equal(formatBuildTimestamp(''), '—');
  const fp = formatBuildFingerprint({
    version: '1.2.3',
    versionTag: 'v1.2.3',
    gitSha: '8d8e4ab',
    buildTime: '2026-11-23T17:30:00.000Z',
  });
  assert.equal(fp, 'v1.2.3 (8d8e4ab) · 2026-11-23 17:30 UTC');
});

test('WorkspaceSettingsModal「关于观澜」清晰透出 v1.2.3 / git-sha / 构建时间戳且零 v1.2-dev 残留', () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      config: EMPTY_WORKSPACE_CONFIG,
      initialTab: 'about',
    })
  );
  assert.ok(html.includes('data-about-version="1.2.3"'));
  assert.ok(html.includes('v1.2.3'));
  assert.ok(html.includes('data-about-git-sha='));
  assert.ok(html.includes('data-about-build-time='));
  assert.equal(html.includes('v1.2-dev'), false, '正式版不得残留 v1.2-dev');
});


test('全局主题三态循环（light → dark → system → light）与 system 映射', () => {
  assert.equal(nextAppThemeMode('light'), 'dark');
  assert.equal(nextAppThemeMode('dark'), 'system');
  assert.equal(nextAppThemeMode('system'), 'light');
  assert.equal(resolveEffectiveAppTheme('dark', false), 'dark');
  assert.equal(resolveEffectiveAppTheme('light', true), 'light');
  assert.equal(resolveEffectiveAppTheme('system', true), 'dark');
  assert.equal(resolveEffectiveAppTheme('system', false), 'light');
  assert.equal(appThemeModeLabel('light'), '浅色');
  assert.equal(appThemeModeLabel('dark'), '深色');
  assert.equal(appThemeModeLabel('system'), '跟随系统');
});

test('coss 明暗语义令牌表（index.css）具备成对 :root 与 .dark 完整声明', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.ok(css.includes(':root {'));
  assert.ok(css.includes('.dark {'));
  for (const token of ['--background:', '--foreground:', '--card:', '--popover:', '--border:', '--muted:']) {
    assert.ok(css.includes(token), `index.css 缺少核心语义令牌 ${token}`);
  }
});


test('formatMiddleEllipsisName：超长同前缀文件名保留后缀差异词', () => {
  const out = formatMiddleEllipsisName('2D与3D绘制预览优化方案-最终评审版-v2.svg', 12, 20);
  assert.ok(out.includes('…'), `应进行中段省略，实得 ${out}`);
  assert.ok(out.endsWith('.svg') || out.includes('v2'), `应保留尾部差异词/扩展名，实得 ${out}`);
});

test('formatMiddleEllipsisName：短文件名与无公共前缀零误截断', () => {
  assert.equal(formatMiddleEllipsisName('README.md', 0, 22), 'README.md');
  assert.equal(formatMiddleEllipsisName('架构设计.md', 4, 22), '架构设计.md');
});

test('isFolderMuted：精确匹配目标目录与所有嵌套子目录且不误伤兄弟前缀', () => {
  const muted = ['04-智能体代码', 'archive/2025'];
  assert.equal(isFolderMuted('04-智能体代码', muted), true);
  assert.equal(isFolderMuted('04-智能体代码/src/core', muted), true);
  assert.equal(isFolderMuted('04-智能体代码-说明', muted), false, '禁止前缀误伤兄弟目录');
  assert.equal(isFolderMuted('archive/2025/q1', muted), true);
  assert.equal(isFolderMuted('01-方案文档', muted), false);
});


test('5,500 份混合资产域分类守恒（business + code === total，耗时 < 120ms）', () => {
  const files: FileRecord[] = [];
  for (let i = 0; i < 2100; i += 1) {
    files.push(makeDummyFile(`b_${i}`, `01-业务文档/doc_${i}.md`, 'md'));
  }
  for (let i = 0; i < 3400; i += 1) {
    files.push(makeDummyFile(`c_${i}`, `04-智能体代码/mod_${i}.ts`, 'code'));
  }
  const t0 = performance.now();
  const counts = countAssetsByDomain(files);
  const biz = filterAssetsByDomain(files, [], 'business');
  const code = filterAssetsByDomain(files, [], 'code');
  const dt = performance.now() - t0;

  assert.equal(counts.all, 5500);
  assert.equal(counts.business, 2100);
  assert.equal(counts.code, 3400);
  assert.equal(counts.business + counts.code, counts.all);
  assert.equal(biz.files.length, 2100);
  assert.equal(code.files.length, 3400);
  assert.ok(dt < 120, `5,500 份域过滤应快速完成，实际 ${dt.toFixed(1)}ms`);
});

test('classifyAssetDomain 准确区分 md/svg/pdf/xlsx/docx 与 code', () => {
  assert.equal(classifyAssetDomain('md'), 'business');
  assert.equal(classifyAssetDomain('svg'), 'business');
  assert.equal(classifyAssetDomain('pdf'), 'business');
  assert.equal(classifyAssetDomain('xlsx'), 'business');
  assert.equal(classifyAssetDomain('docx'), 'business');
  assert.equal(classifyAssetDomain('code'), 'code');
});

test('resolveCalendarSlotMode：≤3 份永远渲染独立胶囊 pills', () => {
  assert.equal(resolveCalendarSlotMode(10, 1, true), 'pills');
  assert.equal(resolveCalendarSlotMode(24, 3, true), 'pills');
  assert.equal(resolveCalendarSlotMode(80, 2, false), 'pills');
});

test('resolveCalendarSlotMode：90 天极窄列（≤13px）自动收敛为 heat_dot', () => {
  assert.equal(resolveCalendarSlotMode(10, 40, true), 'heat_dot');
  assert.equal(resolveCalendarSlotMode(13, 120, false), 'heat_dot');
});

test('resolveCalendarSlotMode：15 天连续百文日（列宽 28px 有邻槽）确定性退化为 compact_heat 零碰撞', () => {
  assert.equal(resolveCalendarSlotMode(28, 100, true), 'compact_heat');
  assert.equal(resolveCalendarSlotMode(42, 36, true), 'compact_heat');
});

test('resolveCalendarSlotMode：近 7 天宽列（≥58px）或孤立槽保留 pills_with_chip', () => {
  assert.equal(resolveCalendarSlotMode(96, 12, true), 'pills_with_chip');
  assert.equal(resolveCalendarSlotMode(30, 12, false), 'pills_with_chip');
});


test('stepChronosReplayIndex 双向边界钳位与按周跨月跳跃', () => {
  const crossMonth = ['2026-10-28', '2026-10-31', '2026-11-02', '2026-11-05', '2026-11-12'];
  assert.equal(stepChronosReplayIndex(crossMonth, 0, 1, 'week'), 3, '10-28 +7 天应跨月落至 11-05');
  assert.equal(stepChronosReplayIndex(crossMonth, 4, -1, 'week'), 3, '11-12 -7 天应回退至 11-05');
  assert.equal(stepChronosReplayIndex(crossMonth, 0, -1, 'day'), 0);
  assert.equal(stepChronosReplayIndex(crossMonth, 4, 1, 'day'), 4);
});

test('chronosReplayIntervalMs 在 1x/2x 与 reduced-motion 下单调安全', () => {
  assert.ok(chronosReplayIntervalMs(1, false) > chronosReplayIntervalMs(2, false));
  assert.ok(chronosReplayIntervalMs(1, true) >= chronosReplayIntervalMs(1, false));
  assert.ok(chronosReplayIntervalMs(2, true) >= 1400);
});

test('buildChronosDigest 在未知日期锚点与全空事件下零崩溃、零造数', () => {
  const digest = buildChronosDigest([], [], [], 'week', '2026-11-23');
  assert.equal(digest.totalEvents, 0);
  assert.equal(digest.activeDaysCount, 0);
  assert.equal(digest.pendingDecisions.length, 0);
  assert.equal(digest.resolvedDecisions.length, 0);
  assert.ok(digest.markdown.includes('2026-11-17') && digest.markdown.includes('2026-11-23'));
});


test('快捷键修饰键隔离（Ctrl/Meta/Alt + 1/2/3/[/] 不误触发导航）', () => {
  const ctx = { editableTarget: false, overlayOpen: false };
  assert.equal(resolveShortcutAction(keyInput('1', { ctrlKey: true }), ctx), null);
  assert.equal(resolveShortcutAction(keyInput('2', { metaKey: true }), ctx), null);
  assert.equal(resolveShortcutAction(keyInput('3', { altKey: true }), ctx), null);
  assert.equal(resolveShortcutAction(keyInput('[', { ctrlKey: true }), ctx), null);
  assert.equal(resolveShortcutAction(keyInput(']', { altKey: true }), ctx), null);
});

test('G 和弦在 null 前缀或修饰键按下时不误触发', () => {
  const ctx = { editableTarget: false, overlayOpen: false };
  assert.equal(resolveShortcutChord(null, keyInput('s'), ctx), null);
  assert.equal(resolveShortcutChord('g', keyInput('s', { ctrlKey: true }), ctx), null);
  assert.equal(resolveShortcutChord('g', keyInput('l', { altKey: true }), ctx), null);
  assert.equal(isShortcutChordPrefix(keyInput('g', { isComposing: true }), ctx), null);
});

test('computeVirtualWindowSlice 零条目与非法数值输入绝对安全', () => {
  const zero = computeVirtualWindowSlice({
    totalCount: 0,
    scrollTop: 100,
    viewportHeight: 420,
    rowHeight: 28,
  });
  assert.equal(zero.virtualized, false);
  assert.equal(zero.visibleCount, 0);
  assert.equal(zero.totalHeightPx, 0);

  const nanSafe = computeVirtualWindowSlice({
    totalCount: 5500,
    scrollTop: Number.NaN,
    viewportHeight: 420,
    rowHeight: 28,
  });
  assert.equal(nanSafe.virtualized, true);
  assert.equal(nanSafe.startIndex, 0);
  assert.ok(nanSafe.visibleCount > 0 && nanSafe.visibleCount <= 40);
});

test('computeVirtualWindowSlice 在 150 vs 151 边界精准切换虚拟化态', () => {
  const atThreshold = computeVirtualWindowSlice({
    totalCount: SIDEBAR_FILE_SLICE_THRESHOLD,
    scrollTop: 0,
    viewportHeight: 420,
    rowHeight: 28,
  });
  const overThreshold = computeVirtualWindowSlice({
    totalCount: SIDEBAR_FILE_SLICE_THRESHOLD + 1,
    scrollTop: 0,
    viewportHeight: 420,
    rowHeight: 28,
  });
  assert.equal(atThreshold.virtualized, false);
  assert.equal(overThreshold.virtualized, true);
  assert.ok(overThreshold.visibleCount < SIDEBAR_FILE_SLICE_THRESHOLD);
});

test('computeChunkedListSlice 在展开至总量时精确清零 remainingCount', () => {
  const s1 = computeChunkedListSlice(120, 48, 48, 48);
  assert.equal(s1.sliced, true);
  assert.equal(s1.visibleCount, 48);
  assert.equal(s1.remainingCount, 72);
  assert.equal(s1.nextLimit, 96);

  const s2 = computeChunkedListSlice(120, 96, 48, 48);
  assert.equal(s2.sliced, true);
  assert.equal(s2.nextLimit, 120);

  const s3 = computeChunkedListSlice(120, 120, 48, 48);
  assert.equal(s3.sliced, false);
  assert.equal(s3.remainingCount, 0);
});

test('ModalsAndDrawers 保持薄导出入口（≤ 40 行，无巨石回流）', () => {
  const src = readFileSync(new URL('../src/components/ModalsAndDrawers.tsx', import.meta.url), 'utf8');
  const lines = src.trim().split('\n').length;
  assert.ok(lines <= 40, `ModalsAndDrawers.tsx 应维持薄导出出口，实测 ${lines} 行`);
});

test('build-windows-installer.mjs 具备 vendored @tauri-apps/cli 零 PATH 打包与双产物校验', () => {
  const script = readFileSync(
    new URL('../scripts/build-windows-installer.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(script.includes('@tauri-apps/cli/tauri.js'));
  assert.ok(script.includes('Guanlan_${ver}_x64-setup.exe'));
  assert.ok(script.includes('Guanlan_${ver}_x64_zh-CN.msi'));
});
