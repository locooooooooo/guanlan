/**
 * v1.2.0 细节打磨回归防线：
 *  1. ShortcutsCheatSheetModal：Portal 挂载逃逸 TopHeader backdrop-blur / z-30 裁切与进度条横穿、
 *     真实构建版本透出（清零硬编码模型名）与暗夜深色遮罩；
 *  2. AppLibraryStage：目录面包屑栏与提示横幅清零硬编码 bg-white，暗夜模式不再刺眼发白；
 *  3. NonLegacyFilePreviewPanel + formatMeta：暗夜态快照徽标与全 13 类格式徽标双态高对比、
 *     版本与观测日期不被长 revision_id 截断、图片加载失败提供重试入口；
 *  4. WorkspaceSettingsModal + StorageUsageSection：清零内部代号与表名、
 *     清零硬编码 bg-white、实时配额口径与下方存储面板一致、全站弹层暗夜遮罩统一。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShortcutsCheatSheetModal from '../src/components/ShortcutsCheatSheetModal';
import { NonLegacyFilePreviewPanel } from '../src/components/NonLegacyFilePreviewPanel';
import { ReaderView } from '../src/components/ReaderView';
import { AppBanners } from '../src/components/app/AppBanners';
import { TopHeader } from '../src/components/TopHeader';
import { MdHumanDiffPanel } from '../src/components/timemachine/MdHumanDiffPanel';
import { buildMarkdownHumanDiff } from '../src/utils/multimodalDiff';
import { groupFilesIntoPackages } from '../src/utils/taskPackages';
import { WorkspaceSettingsModal } from '../src/components/modals/WorkspaceSettingsModal';
import { APP_BUILD_INFO } from '../src/utils/appBuildInfo';
import { formatUiMeta } from '../src/utils/formatMeta';
import type { FileRecord, Revision, WorkspaceConfig } from '../src/types/guanlan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

function makeConfig(): WorkspaceConfig {
  return {
    rootPath: 'H:/desktop-organizer',
    rootKey: 'ws_demo',
    dataDirPath: 'C:/Users/demo/AppData/Local/Guanlan/data',
    excludedDirs: ['node_modules', '.git'],
    disableGitIgnore: false,
    gitIgnoreWarning: '',
    enumSnapshot: {
      date: '2026-11-23',
      mdCount: 62,
      svgCount: 4,
      pdfCount: 1,
      totalCount: 846,
      indexedSuccessCount: 62,
      parseFailedCount: 0,
      pdfUnindexedCount: 0,
    },
    quota: {
      maxTotalMiB: 500,
      usedTotalMiB: 46.5,
      maxSingleBinaryMiB: 50,
      protectedSnapshotsCount: 862,
      evictedSnapshotsCount: 0,
    },
    runtimeStatus: {
      connectionMode: 'direct_stdio',
      serviceState: 'monitoring',
      sseSeq: 42,
      indexGeneration: 12,
      activeAgents: [],
      loopbackUrl: 'http://127.0.0.1:43123',
    },
  };
}

test('Polish-01 · ShortcutsCheatSheetModal 通过 createPortal 逃逸顶栏裁切并透出真实版本身份', () => {
  const src = readSrc('components/ShortcutsCheatSheetModal.tsx');
  assert.ok(src.includes('createPortal('), '必须使用 createPortal 挂到 document.body 防顶栏 backdrop-blur 裁切');
  assert.ok(src.includes('dark:bg-black/62'), '暗夜模式遮罩必须使用深色半透底，禁退化为白雾');
  assert.ok(!src.includes('Claude Opus'), '快捷键速查浮层不得硬编码无关模型名');

  const html = renderToStaticMarkup(
    React.createElement(ShortcutsCheatSheetModal, {
      isOpen: true,
      onClose: () => {},
      activeTab: 'library',
      config: makeConfig(),
      lastScanAt: '2026-11-23T20:00:00+08:00',
    })
  );
  assert.ok(html.includes(APP_BUILD_INFO.versionTag), '应透出真实构建版本号');
  assert.ok(html.includes('z-[70]'), '浮层层级应高于顶栏与阅读进度条 (z-30)');
});

test('Polish-02 · AppLibraryStage 目录面包屑栏与暗夜模式格式/快照徽标零白条返亮', () => {
  const stageSrc = readSrc('components/app/AppLibraryStage.tsx');
  assert.equal(/\bbg-white(?:\/\d+)?\b/.test(stageSrc), false, 'AppLibraryStage 不得残留硬编码 bg-white');

  const sampleFormats = ['md', 'txt', 'ts', 'svg', 'png', 'pdf', 'xlsx', 'pptx', 'zip', 'mp3', 'mp4', 'woff2', 'bin'];
  for (const fmt of sampleFormats) {
    const meta = formatUiMeta(fmt);
    assert.ok(
      meta.badgeClass.includes('dark:bg-') && meta.badgeClass.includes('dark:text-'),
      `格式 ${fmt} 的 badgeClass 必须提供 dark: 暗夜高对比色阶`
    );
  }

  const rev: Revision = {
    revision_id: 'f_02e19809ea6f_r1',
    file_id: 'f_02e19809ea6f',
    versionNumber: 1,
    content_sha256: '420951c1bf9303c4000000000000000000000000000000000000000000000000',
    observed_at: '2026-11-22T01:39:00Z',
    source_time: '2026-11-22T01:39:00Z',
    sizeBytes: 405141,
    snapshotAvailable: true,
    isBaselineProtected: true,
    summaryNote: 'v1',
  };
  const file: FileRecord = {
    file_id: 'f_02e19809ea6f',
    relative_path: 'docs/guanlan/assets/f04-golden-tasks/bonus-f01-context-capsule.png',
    title: 'bonus-f01-context-capsule.png',
    format: 'png',
    folder: 'docs/guanlan/assets/f04-golden-tasks',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: rev.revision_id,
    revisions: [rev],
    coverage: 'filename_only',
  };

  const darkHtml = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: file,
      currentRev: rev,
      paperLightMode: false,
      indexGeneration: 12,
    })
  );
  assert.ok(!darkHtml.includes('已保存去重快照'), '常态图片预览脚标不再铺陈内部「已保存去重快照」术语');
  assert.ok(darkHtml.includes('v1 · 2026-11-22'), '版本与观测日期应完整呈现，不再被长 revision_id 挤截');
  assert.ok(!darkHtml.includes('>PNG<'), '图片脚下不再重复格式徽标');
  assert.ok(!darkHtml.includes('>查看原图<'), '查看原图只留图标，不压在画面上');
  assert.ok(darkHtml.includes('aria-label="查看原图"'), '原图入口仍可发现');

  const binDarkHtml = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: { ...file, format: 'zip', title: 'archive.zip', relative_path: 'dist/archive.zip' },
      currentRev: rev,
      paperLightMode: false,
      indexGeneration: 12,
    })
  );
  assert.ok(binDarkHtml.includes('text-[#86EFAC]'), '暗夜态元数据卡片的快照徽标必须使用亮绿高对比色');
});

test('Polish-03 · 设置面板存储配额去工程代号、暗夜适配且配额口径实时对齐', () => {
  const storageSrc = readSrc('components/StorageUsageSection.tsx');
  assert.equal(/\bbg-white(?:\/\d+)?\b/.test(storageSrc), false, 'StorageUsageSection 不得残留硬编码 bg-white');
  for (const leak of ['（B01）', '（F02）', '（statements）', '（edges）']) {
    assert.equal(storageSrc.includes(leak), false, `用户界面不得泄露内部工程代号或表名：${leak}`);
  }
  assert.ok(storageSrc.includes('subscribeStorageStatsSnapshot'), '应暴露实时统计订阅供顶栏配额条同步');

  const settingsSrc = readSrc('components/modals/WorkspaceSettingsModal.tsx');
  assert.ok(settingsSrc.includes('subscribeStorageStatsSnapshot'), 'WorkspaceSettingsModal 应订阅实时存储统计');
  assert.ok(settingsSrc.includes('dark:bg-black/62'), '设置弹层遮罩应适配暗夜深色半透底');

  const html = renderToStaticMarkup(
    React.createElement(WorkspaceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      config: makeConfig(),
      initialTab: 'storage',
    })
  );
  assert.ok(html.includes('单二进制上限 50 MiB'), '初始配额条应呈现与策略一致的 50 MiB 上限');
  assert.ok(!html.includes('（B01）'), '渲染产物不得包含（B01）内部代号');
});

test('Polish-04 · 内容优先排版：源码/预览收折技术元数据、阅读态去双层横幅、返回来源并入标题行与事件条可暂收', () => {
  const tsRev: Revision = {
    revision_id: 'rev_ts_v1',
    file_id: 'f_ts_01',
    versionNumber: 1,
    content_sha256: 'df1169f66f6a8c0a000000000000000000000000000000000000000000000000',
    observed_at: '2026-11-21T12:00:00Z',
    source_time: '2026-11-21T12:00:00Z',
    sizeBytes: 7372,
    snapshotAvailable: true,
    isBaselineProtected: true,
    summaryNote: 'v1',
    markdownContent: "import test from 'node:test';\nexport const ok = true;\n",
  };
  const tsFile: FileRecord = {
    file_id: 'f_ts_01',
    relative_path: 'src/utils/smartViews.test.ts',
    title: 'smartViews.test.ts',
    format: 'ts',
    folder: 'src/utils',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: tsRev.revision_id,
    revisions: [tsRev],
    coverage: 'full_text',
  };

  // 1. 文本/源码预览：顶部压缩为单行工具条，SHA-256 与策略说明默认折叠，不再叠放旧版双头与 64vh 嵌套限高
  const textHtml = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: tsFile,
      currentRev: tsRev,
      paperLightMode: true,
      indexGeneration: 12,
    })
  );
  assert.ok(textHtml.includes('data-preview-compact-bar=""'), '源码预览应渲染单行紧凑顶条');
  assert.ok(
    textHtml.includes('data-preview-meta-toggle=""') && textHtml.includes('aria-expanded="false"'),
    '技术元数据（SHA-256/快照策略）应默认收起并支持按需展开'
  );
  assert.ok(!textHtml.includes('data-preview-meta-drawer=""'), '默认态不得在正文上方展开占高元数据抽屉');
  assert.ok(!textHtml.includes('UTF-8 源码 / 文本快照预览'), '不得再在源码区上方叠放重复的二级标题栏');
  assert.ok(!textHtml.includes('max-h-[64vh]'), '源码区应占满剩余阅读视口高度，不再硬裁 64vh');
  assert.ok(textHtml.includes('export const ok = true;'), '源码正文应直接呈现');

  // 2. 纯元数据模式（无内联正文可展示时）默认展开完整 L0 元数据卡片
  const binRev: Revision = { ...tsRev, revision_id: 'rev_bin_v1', snapshotAvailable: false };
  const binFile: FileRecord = {
    ...tsFile,
    file_id: 'f_bin_01',
    title: 'archive.zip',
    relative_path: 'dist/archive.zip',
    format: 'zip',
    current_revision_id: binRev.revision_id,
    revisions: [binRev],
  };
  const metaOnlyHtml = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: binFile,
      currentRev: binRev,
      paperLightMode: true,
      indexGeneration: 12,
    })
  );
  assert.ok(metaOnlyHtml.includes('data-preview-meta-drawer=""'), '无内联正文时 L0 元数据网格应默认展开');

  // 3. AppLibraryStage：目录工作栏仅概览态渲染，阅读态与筛选不匹配提示合流为单条
  const stageSrc = readSrc('components/app/AppLibraryStage.tsx');
  assert.ok(
    stageSrc.includes("libraryMode === 'overview' && sidebarFilters.folder !== 'all'"),
    '目录面包屑工作栏应仅在 overview 概览态显示，阅读态不再压占正文高度'
  );
  assert.ok(stageSrc.includes('data-reader-filter-mismatch=""'), '阅读态筛选不匹配应提供紧凑单条提示');

  // 4. ReaderView：返回面包屑并入 Row 1 标题行 + 单版本文件隐藏无效的「无可比较的版本 / 历史快照 (1)」
  const readerHtmlSingle = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [tsFile],
      activeFile: tsFile,
      pinnedRevisionId: tsRev.revision_id,
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: undefined,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: { fromType: 'timeline', label: '返回任务包概览' },
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 12,
    })
  );
  assert.ok(readerHtmlSingle.includes('data-reader-return-breadcrumb=""'), '返回来源胶囊应内联于文件头 Row 1');
  assert.ok(!readerHtmlSingle.includes('无可比较的版本'), '单版本文件不得用置灰的「无可比较的版本」占位');
  assert.ok(!readerHtmlSingle.includes('历史快照 (1)'), '单版本文件不得在 Row 2 重复展示「历史快照 (1)」');

  // 多版本文件正常展示历史快照入口
  const tsRev2: Revision = { ...tsRev, revision_id: 'rev_ts_v2', versionNumber: 2 };
  const multiRevFile: FileRecord = {
    ...tsFile,
    current_revision_id: tsRev2.revision_id,
    revisions: [tsRev, tsRev2],
  };
  const readerHtmlMulti = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [multiRevFile],
      activeFile: multiRevFile,
      pinnedRevisionId: tsRev2.revision_id,
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: undefined,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 12,
    })
  );
  assert.ok(readerHtmlMulti.includes('历史快照 (2)'), '多版本文件应正常展示历史快照入口');

  // 5. AppBanners：全景溯源页签新事件细条精简冗余说明并提供一键暂收入口；阅读态不弹窗打断
  const bannerHtml = renderToStaticMarkup(
    React.createElement(AppBanners, {
      ctx: {
        rescanState: 'idle',
        rescanError: '',
        handleRescan: async () => {},
        l4aProgress: null,
        hitlClearedAt: null,
        deliveredInitiative: null,
        deliveredInitiatives: [],
        initiativeLifecycle: null,
        runInitiativeLifecycle: async () => {},
        activeInitiative: null,
        changeNotice: { count: 165, at: '2026-11-23T21:33:00+08:00' },
        refreshEvents: async () => {},
        silentMergeNewEvents: async () => {},
        silentMergingEvents: false,
        dataSource: 'real',
        files: [],
        dataError: '',
        activeTab: 'panorama',
      } as never,
    })
  );
  assert.ok(bannerHtml.includes('data-dismiss-change-notice=""'), '新事件细条应支持一键暂收，避免长期压占视口');
  assert.ok(!bannerHtml.includes('可静默并入保持当前位置，或刷新切入最新分页窗口</span>'), '应去除冗长说明文案，保持细条精炼');
});

test('Polish-05 · 信息降密：扫描态并入同步胶囊、时光机合流单右栏与未变章节折叠、预览工具条沉底与专项胶囊收拢', () => {
  // 1. 后台扫描中不再顶出通栏横幅（收编入 TopHeader 同步胶囊）；扫描失败保留重试横幅
  const runningBannerHtml = renderToStaticMarkup(
    React.createElement(AppBanners, {
      ctx: {
        rescanState: 'running',
        rescanError: '',
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
        dataSource: 'real',
        files: [],
        dataError: '',
        activeTab: 'library',
      } as never,
    })
  );
  assert.ok(!runningBannerHtml.includes('正在扫描工作区'), '扫描中不再顶出全宽通栏横幅压占视口');

  const scanningHeaderHtml = renderToStaticMarkup(
    React.createElement(TopHeader, {
      activeTab: 'panorama',
      onSelectTab: () => {},
      searchQuery: '',
      onSearchChange: () => {},
      searchHits: [],
      onSelectSearchHit: () => {},
      unreadFilesCount: 0,
      contextBasketCount: 0,
      eventCount: 10,
      decisions: [],
      onOpenDecision: () => {},
      config: makeConfig(),
      dataSource: 'real',
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
      isScanning: true,
    })
  );
  assert.ok(scanningHeaderHtml.includes('扫描中…'), '扫描进度应直接体现在 TopHeader 同步胶囊内');

  // 2. MdHumanDiffPanel：有变与未变章节并存时默认折叠未变章节；决定/待办 0 变化压缩为单行轻提示
  const mdDiff = buildMarkdownHumanDiff(
    ['# 文档', '## 未变章 A', '原文 A', '## 改动章 B', '旧内容 B', '## 未变章 C', '原文 C'].join('\n'),
    ['# 文档', '## 未变章 A', '原文 A', '## 改动章 B', '新内容 B', '## 未变章 C', '原文 C'].join('\n')
  );
  const mdHtml = renderToStaticMarkup(
    React.createElement(MdHumanDiffPanel, { result: mdDiff, mode: 'human' })
  );
  assert.ok(mdHtml.includes('data-outline-unchanged-toggle=""'), '应提供未变章节折叠开关');
  assert.ok(mdHtml.includes('改动章 B'), '改动章节默认可见');
  assert.ok(!mdHtml.includes('未变章 A'), '未变章节默认折叠以降低垂直密度');
  assert.ok(mdHtml.includes('data-element-changes-empty=""'), '决定/待办无变化时压缩为单行静默提示');

  // 3. NonLegacyFilePreviewPanel：文本正文置顶，工具条沉底并浮出轻量复制/入篮操作
  const tsRev: Revision = {
    revision_id: 'rev_p5_v1',
    file_id: 'f_p5_01',
    versionNumber: 1,
    content_sha256: 'ab1169f66f6a8c0a000000000000000000000000000000000000000000000000',
    observed_at: '2026-11-23T12:00:00Z',
    source_time: '2026-11-23T12:00:00Z',
    sizeBytes: 1024,
    snapshotAvailable: true,
    isBaselineProtected: true,
    summaryNote: 'v1',
    markdownContent: 'export const alpha = 1;\n',
  };
  const tsFile: FileRecord = {
    file_id: 'f_p5_01',
    relative_path: '04-智能体代码/src/Overview.tsx',
    title: 'Overview.tsx',
    format: 'tsx',
    folder: '04-智能体代码/src',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: tsRev.revision_id,
    revisions: [tsRev],
    coverage: 'full_text',
  };
  const codeHtml = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: tsFile,
      currentRev: tsRev,
      paperLightMode: true,
      indexGeneration: 1,
      systemActions: {
        desktopSystemSupported: true,
        hasWorkspaceRoot: true,
        onOpenWithDefaultApp: () => {},
        onRevealInExplorer: () => {},
        onCopyRelativePath: () => {},
        onCopyAbsolutePath: () => {},
      },
      onAddEvidencePointer: () => true,
    })
  );
  const codeIdx = codeHtml.indexOf('export const alpha = 1;');
  const footerIdx = codeHtml.indexOf('data-preview-compact-bar=""');
  assert.ok(codeIdx > 0 && footerIdx > codeIdx, '源码正文应位于底部状态脚标之前（首屏正文顶格直出）');
  assert.ok(codeHtml.includes('data-preview-floating-actions=""'), '应提供右上角轻悬浮复制/入篮入口');

  // 4. ReaderView：所属专项五阶段 Stepper 默认收拢为单枚下拉胶囊，不再平铺 5 步按钮
  const pkg = groupFilesIntoPackages([tsFile])[0] ?? null;
  const readerHtml = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [tsFile],
      activeFile: tsFile,
      pinnedRevisionId: tsRev.revision_id,
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: undefined,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 1,
      packageContext: pkg,
    })
  );
  assert.ok(readerHtml.includes('data-reader-initiative-pill=""'), '专项五阶段应默认收拢为紧凑胶囊触发器');
  assert.ok(!readerHtml.includes('aria-label="五阶段进度 Stepper"'), '未点击展开前不应在 Row 2 常驻铺满五阶段 Stepper');

  // 5. 全景/画布视图默认收起左侧目录栏（释放横向空间，用户可随时一键展开）
  const sidebarShellSrc = readSrc('components/app/GlobalDirectorySidebar.tsx');
  assert.ok(
    sidebarShellSrc.includes("activeTab === 'panorama' ? !dirShell.panoramaSidebarOpen : dirShell.sidebarCollapsed"),
    '全景/时光机视图默认收起左侧目录栏，让出空间'
  );
});

test('Polish-06 · 全局视图去噪：清零 SVG/PDF/MD 工程黑话与 coverage 键值、阅读态屏蔽事件通栏、顶栏去大数字与静默态收拢', () => {
  // 1. SVG 阅读器：不再展示「受限安全矢量预览」「可提取文字节点」「SVG 可提取文字检索层」「coverage=svg_text」
  const svgRev: Revision = {
    revision_id: 'rev_svg_p6',
    file_id: 'f_svg_p6',
    versionNumber: 1,
    content_sha256: 'ab1169f66f6a8c0a000000000000000000000000000000000000000000000000',
    observed_at: '2026-11-24T10:00:00Z',
    source_time: '2026-11-24T10:00:00Z',
    sizeBytes: 20480,
    snapshotAvailable: true,
    isBaselineProtected: true,
    summaryNote: 'v1',
    svgSource: '<svg xmlns="http://www.w3.org/2000/svg"><text>标题</text></svg>',
    svgExtractedTexts: ['标题', '方案一'],
  };
  const svgFile: FileRecord = {
    file_id: 'f_svg_p6',
    relative_path: '01-方案文档/preview.svg',
    title: '2D与3D绘制预览优化方案草案',
    format: 'svg',
    folder: '01-方案文档',
    role: '素材',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: svgRev.revision_id,
    revisions: [svgRev],
    coverage: 'svg_text',
  };
  const svgReaderHtml = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [svgFile],
      activeFile: svgFile,
      pinnedRevisionId: svgRev.revision_id,
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: undefined,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 1,
    })
  );
  assert.ok(!svgReaderHtml.includes('受限安全矢量预览'), 'SVG 画布不得堆砌安全免责说明');
  assert.ok(!svgReaderHtml.includes('coverage=svg_text'), 'SVG 画布绝不向用户暴露内部 coverage= 键值');
  assert.ok(!svgReaderHtml.includes('SVG 可提取文字检索层'), 'SVG 底部不再占行渲染工程检索层条');
  assert.ok(!svgReaderHtml.includes('100% 原尺寸</span>'), '不重复并列 100% 与 100% 原尺寸两枚按钮');
  assert.ok(svgReaderHtml.includes('data-svg-extracted-texts-toggle=""'), '有提取文字时在工具栏提供按需展开开关');
  assert.ok(svgReaderHtml.includes('v1</button>'), '单版本文件顶栏以极淡 v1 呈现，不加橙底「(最新)」噪音');

  // 2. PDF 阅读器：索引正常态不再铺陈「阅读能力：内嵌阅读器可用」「检索索引状态」「按版本 rev_xxx 快照直读」
  const pdfRev: Revision = {
    revision_id: 'rev_pdf_p6',
    file_id: 'f_pdf_p6',
    versionNumber: 1,
    content_sha256: 'cd1169f66f6a8c0a000000000000000000000000000000000000000000000000',
    observed_at: '2026-11-24T10:00:00Z',
    source_time: '2026-11-24T10:00:00Z',
    sizeBytes: 102400,
    snapshotAvailable: true,
    isBaselineProtected: true,
    summaryNote: 'v1',
  };
  const pdfFile: FileRecord = {
    file_id: 'f_pdf_p6',
    relative_path: '01-方案文档/spec.pdf',
    title: '规范文档',
    format: 'pdf',
    folder: '01-方案文档',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: pdfRev.revision_id,
    revisions: [pdfRev],
    coverage: 'full_text',
    pdfStatus: 'page_indexed',
    pdfStatusReason: '已按页抽取',
  };
  const pdfReaderHtml = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [pdfFile],
      activeFile: pdfFile,
      pinnedRevisionId: pdfRev.revision_id,
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
      readingState: undefined,
      onMarkReadHere: () => {},
      onMarkFullyRead: () => {},
      onScrollProgress: () => {},
      onToggleBookmark: () => {},
      onNavigateLinkedFile: () => {},
      returnBreadcrumb: null,
      onFollowReturnBreadcrumb: () => {},
      decisions: [],
      relations: [],
      onSelectDecision: () => {},
      onAddEvidencePointer: () => {},
      indexGeneration: 1,
    })
  );
  assert.ok(!pdfReaderHtml.includes('阅读能力：内嵌阅读器可用'), 'PDF 画布不得展示内部能力清单文案');
  assert.ok(!pdfReaderHtml.includes('检索索引状态'), 'PDF 索引正常态不展示技术索引状态条');
  assert.ok(!pdfReaderHtml.includes('真实 PDF 原页 · 按版本'), 'PDF 卡片头部不再泄露内部 revision_id');

  // 3. TopHeader：主导航 Tab 不再常驻 20272 / 5588 超大数字；常态同步走静默图标；空证据篮走纯图标
  const calmHeaderHtml = renderToStaticMarkup(
    React.createElement(TopHeader, {
      activeTab: 'library',
      onSelectTab: () => {},
      searchQuery: '',
      onSearchChange: () => {},
      searchHits: [],
      onSelectSearchHit: () => {},
      unreadFilesCount: 4981,
      contextBasketCount: 0,
      eventCount: 20272,
      decisions: [],
      onOpenDecision: () => {},
      config: {
        ...makeConfig(),
        enumSnapshot: { ...makeConfig().enumSnapshot, totalCount: 5588 },
      },
      dataSource: 'real',
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
      readingIslandFiles: [svgFile],
      readingStates: {},
      onOpenDocFromIsland: () => {},
    })
  );
  assert.ok(!calmHeaderHtml.includes('>20272<'), '顶栏全景溯源 Tab 不再常驻超大事件数');
  assert.ok(!calmHeaderHtml.includes('>5588<'), '顶栏知识资产库 Tab 不再重复展示总文档数');
  assert.ok(calmHeaderHtml.includes('class="sr-only">已同步</span>'), '常态已同步收拢为静默图标（语义保留给读屏）');
  assert.ok(calmHeaderHtml.includes('class="sr-only">证据篮</span>'), '空证据篮收拢为静默图标，有收集项时再展文字与角标');
  assert.ok(!calmHeaderHtml.includes('data-island-ring'), '顶栏阅读抽屉入口收拢为单图标，不再渲染三枚彩色圆环');

  // 4. HTML / Office 预览：技术元数据条沉底，不再在阅读器顶栏与内容工具栏之间叠出第三条横栏
  const htmlRev: Revision = {
    ...svgRev,
    revision_id: 'rev_html_p6',
    file_id: 'f_html_p6',
    markdownContent: '<html><body><h1>Hello</h1></body></html>',
  };
  const htmlFile: FileRecord = {
    ...svgFile,
    file_id: 'f_html_p6',
    relative_path: '01-方案文档/demo.html',
    title: 'demo.html',
    format: 'html',
    current_revision_id: htmlRev.revision_id,
    revisions: [htmlRev],
  };
  const htmlPreview = renderToStaticMarkup(
    React.createElement(NonLegacyFilePreviewPanel, {
      activeFile: htmlFile,
      currentRev: htmlRev,
      paperLightMode: true,
      indexGeneration: 1,
    })
  );
  const htmlReaderIdx = htmlPreview.indexOf('data-html-reader=""');
  const htmlFooterIdx = htmlPreview.indexOf('data-preview-compact-bar=""');
  assert.ok(htmlReaderIdx > 0 && htmlFooterIdx > htmlReaderIdx, 'HTML 预览主内容应置顶，技术脚标沉底');
  assert.ok(!htmlPreview.includes('离线沙盒隔离</span>'), '常态 HTML 预览不常驻绿底「离线沙盒隔离」胶囊');
});


