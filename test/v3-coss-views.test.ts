/**
 * V3 批次（V07–V09）· 全站 coss 原语统一、全站明暗双态与实机穿帮清零单测集。
 *
 * V07 覆盖：
 * 1. buildPackageVisualFingerprint：近 14 天变更 Sparkline（零造数：安静包全 0 水平线、活跃包精确逐日计数）、
 *    格式构成彩带严格 MECE 守恒（∑count === docs.length）、清晰更新相对时间与去重防线；
 * 2. appThemeStore 三态轮换（light → dark → system → light）与持久化；
 * 3. TopHeader：coss Toolbar / Group / GroupSeparator / Kbd 紧凑编组 + 全站一键明暗切换按钮；
 * 4. MultiProjectOverviewStrip：coss Frame/Group 重构 + 全指标 whitespace-nowrap 根治「720 文\n件」折行；
 * 5. FeaturedFocusCards：双层决策卡上下零重叠分离（layer=0/layer=1 消除后卡漏出孤字）；
 * 6. TaskPackageGallery & HomeView：coss Frame/CardFrame + 真实数据指纹封面 + 「60 份」防截断。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileRecord, WorkspaceConfig } from '../src/types/guanlan';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import type { TaskPackage } from '../src/utils/taskPackages';
import {
  buildPackageVisualFingerprint,
  buildSparklineGeometry,
  buildTrailing14Days,
  SPARKLINE_VIEWBOX_H,
} from '../src/utils/packageFingerprint';
import {
  appThemeModeLabel,
  applyAppTheme,
  getAppThemeMode,
  getResolvedAppTheme,
  nextAppThemeMode,
} from '../src/stores/appThemeStore';
import { TopHeader } from '../src/components/TopHeader';
import { MultiProjectOverviewStrip } from '../src/components/MultiProjectOverviewStrip';
import FeaturedFocusCards from '../src/components/FeaturedFocusCards';
import TaskPackageGallery from '../src/components/TaskPackageGallery';
import HomeView from '../src/components/HomeView';
import {
  CommandPalette,
  formatPaletteVersionBadge,
  isOpaqueInternalHash,
  palettePreviewModel,
  sanitizePaletteDisplayText,
} from '../src/components/CommandPalette';
import {
  AgentContextDrawer,
  McpConsoleModal,
  SETTINGS_TABS,
  WorkspaceSettingsModal,
} from '../src/components/ModalsAndDrawers';
import ReviewBoardDrawer from '../src/components/ReviewBoardDrawer';
import { FileTimelineDrawer } from '../src/components/FileTimelineDrawer';
import { QuickPreviewModal } from '../src/components/QuickPreviewModal';
import { ContextCapsuleModal } from '../src/components/ContextCapsuleModal';
import {
  groupTimelineRenderItemsByDay,
  TimelineView,
} from '../src/components/TimelineView';
import {
  ATLAS_LARGE_FOLDER_CAP,
  AtlasView,
  sliceAtlasFolderItems,
} from '../src/components/AtlasView';
import { ReaderView } from '../src/components/ReaderView';

function makeFile(
  id: string,
  relPath: string,
  format: FileRecord['format'],
  revisions: Array<{ id: string; v: number; observedAt: string }>
): FileRecord {
  const title = relPath.split('/').pop() ?? relPath;
  const revObjs = revisions.map((r) => ({
    revision_id: r.id,
    file_id: id,
    versionNumber: r.v,
    content_sha256: `hash_${r.id}`,
    sizeBytes: 256,
    observed_at: r.observedAt,
    source_time: r.observedAt,
    source_time_kind: 'mtime' as const,
    snapshotAvailable: true,
    summaryNote: '',
    changedSectionsFromPrev: [],
  }));
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
    current_revision_id: revObjs[0]?.revision_id ?? `rev_${id}`,
    revisions: revObjs,
  };
}

function makeConfig(): WorkspaceConfig {
  return {
    ...EMPTY_WORKSPACE_CONFIG,
    rootPath: 'H:/workspace/demo',
    enumSnapshot: {
      ...EMPTY_WORKSPACE_CONFIG.enumSnapshot,
      date: '2026-11-23',
      totalCount: 120,
      mdCount: 60,
      svgCount: 20,
      pdfCount: 10,
      indexedSuccessCount: 120,
    },
    runtimeStatus: {
      ...EMPTY_WORKSPACE_CONFIG.runtimeStatus,
      serviceState: 'monitoring',
      indexGeneration: 7,
    },
  };
}

// ===== V07 · 真实数据驱动微视觉指纹（零造数） =====

test('V07 · buildPackageVisualFingerprint：近 14 天 Sparkline 精确计数、重复 revision 去重与安静包全 0 基线', () => {
  const anchorIso = '2026-11-23T12:00:00+08:00';
  const days = buildTrailing14Days(anchorIso);
  assert.equal(days.length, 14);
  assert.equal(days[0], '2026-11-10');
  assert.equal(days[13], '2026-11-23');

  const f1 = makeFile('f1', '01-方案文档/产品需求与任务包/A/spec.md', 'md', [
    { id: 'r1_3', v: 3, observedAt: '2026-11-23T09:10:00+08:00' },
    { id: 'r1_2', v: 2, observedAt: '2026-11-23T08:00:00+08:00' },
    // 刻意重复同 revision_id 验证去重
    { id: 'r1_2', v: 2, observedAt: '2026-11-23T08:00:00+08:00' },
    { id: 'r1_1', v: 1, observedAt: '2026-11-15T14:00:00+08:00' },
    // 超出 14 天窗口的旧版本不应落入 14 日计数
    { id: 'r1_0', v: 0, observedAt: '2026-10-01T10:00:00+08:00' },
  ]);
  const f2 = makeFile('f2', '01-方案文档/产品需求与任务包/A/arch.svg', 'svg', [
    { id: 'r2_1', v: 1, observedAt: '2026-11-20T16:30:00+08:00' },
  ]);
  const f3 = makeFile('f3', '01-方案文档/产品需求与任务包/A/runner.ts', 'ts', [
    { id: 'r3_1', v: 1, observedAt: '2026-11-23T11:20:00+08:00' },
  ]);

  const fileById = new Map<string, FileRecord>([
    [f1.file_id, f1],
    [f2.file_id, f2],
    [f3.file_id, f3],
  ]);

  const activePkg: TaskPackage = {
    id: '01-方案文档/产品需求与任务包/A',
    name: '专项 A',
    kind: 'spec',
    stage: '执行',
    docs: [
      { fileId: 'f1', title: 'spec.md', format: 'md', stage: '计划', conclusion: '结论 A', versionNumber: 3 },
      { fileId: 'f2', title: 'arch.svg', format: 'svg', stage: '蓝图', conclusion: '', versionNumber: 1 },
      { fileId: 'f3', title: 'runner.ts', format: 'ts', stage: '执行', conclusion: '', versionNumber: 1 },
    ],
    eventCount: 5,
    lastActivity: '2026-11-23T11:20:00+08:00',
    latestConclusion: '结论 A',
    readingOrder: [],
  };

  const fp = buildPackageVisualFingerprint(activePkg, fileById, anchorIso);
  assert.equal(fp.sparkline14d.totalChanges, 5, '14 日内真实修订应为 5（2026-11-23×3 + 2026-11-20×1 + 2026-11-15×1）');
  assert.equal(fp.sparkline14d.activeDays, 3);
  assert.equal(fp.sparkline14d.maxCount, 3);
  assert.equal(fp.sparkline14d.counts[13], 3, '末日 2026-11-23 应计 3 次');
  assert.equal(fp.sparkline14d.counts[10], 1, '2026-11-20 应计 1 次');
  assert.equal(fp.sparkline14d.counts[5], 1, '2026-11-15 应计 1 次');

  // 格式构成严格 MECE 守恒
  const sumCount = fp.formatSegments.reduce((acc, s) => acc + s.count, 0);
  const sumRatio = fp.formatSegments.reduce((acc, s) => acc + s.ratio, 0);
  assert.equal(sumCount, activePkg.docs.length, '格式段计数和必须严格等于 docs.length');
  assert.ok(Math.abs(sumRatio - 1) < 1e-6, '格式比例和必须等于 1');
  assert.equal(fp.docCountLabel, '3 份');
  assert.ok(fp.updatedRelativeLabel.length > 0 && fp.updatedRelativeLabel !== '待更新');

  // 远古安静包：近 14 天零改动 → 全 0 水平基线（严禁伪造波纹）
  const quietFile = makeFile('f_old', '01-方案文档/旧档/old.md', 'md', [
    { id: 'r_old', v: 1, observedAt: '2025-05-01T10:00:00+08:00' },
  ]);
  const quietPkg: TaskPackage = {
    id: '01-方案文档/旧档',
    name: '历史归档',
    kind: 'report',
    stage: '交付',
    docs: [{ fileId: 'f_old', title: 'old.md', format: 'md', stage: '交付', conclusion: '', versionNumber: 1 }],
    eventCount: 0,
    lastActivity: '2025-05-01T10:00:00+08:00',
    latestConclusion: '',
    readingOrder: [],
  };
  const quietFp = buildPackageVisualFingerprint(
    quietPkg,
    new Map([[quietFile.file_id, quietFile]]),
    anchorIso
  );
  assert.equal(quietFp.sparkline14d.totalChanges, 0);
  assert.equal(quietFp.sparkline14d.activeDays, 0);
  assert.ok(quietFp.sparkline14d.counts.every((c) => c === 0));
  const flatGeom = buildSparklineGeometry(quietFp.sparkline14d.counts);
  const yValues = flatGeom.polylinePoints.split(' ').map((p) => Number(p.split(',')[1]));
  assert.ok(yValues.every((y) => y === SPARKLINE_VIEWBOX_H - 2), '全 0 序列必须平贴底线，零假波动');
});

// ===== V07 · 全站明暗主题三态轮换与 TopHeader coss Toolbar/Group 重排 =====

test('V07 · appThemeStore 三态轮换（light→dark→system→light）与 TopHeader Toolbar/Group/Kbd 渲染', () => {
  assert.equal(nextAppThemeMode('light'), 'dark');
  assert.equal(nextAppThemeMode('dark'), 'system');
  assert.equal(nextAppThemeMode('system'), 'light');
  assert.equal(appThemeModeLabel('light'), '浅色');
  assert.equal(appThemeModeLabel('dark'), '深色');
  assert.equal(appThemeModeLabel('system'), '跟随系统');

  // 应用切换并验证立即生效（随后复原 light，避免污染后续测试）
  assert.equal(applyAppTheme('dark', false), 'dark');
  assert.equal(getAppThemeMode(), 'dark');
  assert.equal(getResolvedAppTheme(), 'dark');
  assert.equal(applyAppTheme('light', false), 'light');
  assert.equal(getAppThemeMode(), 'light');

  const headerHtml = renderToStaticMarkup(
    React.createElement(TopHeader, {
      activeTab: 'home',
      onSelectTab: () => {},
      searchQuery: '',
      onSearchChange: () => {},
      searchHits: [],
      onSelectSearchHit: () => {},
      unreadFilesCount: 4,
      contextBasketCount: 2,
      eventCount: 42,
      decisions: [],
      decisionsUnresolvedTotal: 5,
      onOpenDecision: () => {},
      config: makeConfig(),
      dataSource: 'real',
      scanSummary: '已同步 120 份',
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
      onOpenReviewBoard: () => {},
      reviewBoardAttentionCount: 3,
    })
  );

  assert.ok(headerHtml.includes('data-slot="toolbar"'), '顶栏右侧应换装 coss Toolbar');
  assert.ok(headerHtml.includes('data-header-sync-group=""'), '同步遥测应使用 coss Group');
  assert.ok(headerHtml.includes('data-header-tool-group=""'), '主题/帮助/设置应拼接为紧凑 coss Group');
  assert.ok(headerHtml.includes('data-app-theme-toggle=""'), '顶栏应渲染全站一键明暗切换按钮');
  assert.ok(headerHtml.includes('data-app-theme-mode="light"'));
  assert.ok(headerHtml.includes('data-slot="kbd"'), '检索提示应使用 coss Kbd 原语');
});

// ===== V07 · 首页 Frame/CardFrame + 多项目零折行 + 叠卡零孤字 + 专项指纹橱窗 =====

test('V07 · MultiProjectOverviewStrip / FeaturedFocusCards / TaskPackageGallery / HomeView 结构与防穿帮验收', () => {
  // 1. 多项目工作台：coss Frame + 全指标 whitespace-nowrap（根治 720 文\n件）
  const mpHtml = renderToStaticMarkup(
    React.createElement(MultiProjectOverviewStrip, {
      overview: null,
      projects: [
        {
          project_id: 'p1',
          name: '拥抱AI真实大工程',
          root_path: 'H:/workspace/ai-repo',
          status: 'online',
          is_active: true,
          readonly: false,
          is_scanning: false,
          index_generation: 5,
          added_at: '2026-11-01T10:00:00+08:00',
          last_opened_at: '2026-11-23T10:00:00+08:00',
          file_count: 5519,
          folder_count: 212,
          pending_decisions_count: 288,
          last_scan_at: '2026-11-23T10:00:00+08:00',
        },
        {
          project_id: 'p2',
          name: '第二协作项目',
          root_path: 'H:/workspace/collab',
          status: 'online',
          is_active: false,
          readonly: false,
          is_scanning: false,
          index_generation: 2,
          added_at: '2026-11-10T10:00:00+08:00',
          last_opened_at: '2026-11-23T09:00:00+08:00',
          file_count: 720,
          folder_count: 42,
          pending_decisions_count: 14,
          last_scan_at: '2026-11-23T09:00:00+08:00',
        },
      ],
      activeProjectId: 'p1',
      onAddProject: () => {},
      onFocusProject: () => {},
      onOpenCrossDecision: () => {},
      onOpenCrossFile: () => {},
    })
  );
  assert.ok(mpHtml.includes('data-slot="frame"'), '多项目工作台应接入 coss Frame');
  assert.ok(mpHtml.includes('data-slot="frame-panel"'), '多项目工作台应接入 coss FramePanel');
  assert.ok(mpHtml.includes('data-slot="group"'), '星图/资料入口应使用 coss Group');
  assert.ok(mpHtml.includes('whitespace-nowrap shrink-0">720 文件<'), '文件计数必须强制 whitespace-nowrap 防止 720 文\\n件折行');
  assert.ok(
    mpHtml.includes('whitespace-nowrap shrink-0 text-[color:var(--accent-wave)] font-medium">288 待拍板<'),
    '待拍板计数必须强制 whitespace-nowrap'
  );

  // 2. FeaturedFocusCards：双层决策卡上下分离零重叠（layer=0 top-0.5 h=70 / layer=1 bottom-0.5 h=44）
  const fcHtml = renderToStaticMarkup(
    React.createElement(FeaturedFocusCards, {
      decisionItems: [
        { decisionId: 'd1', question: '是否全站启用 coss 精密容器？', status: '待确认' },
        { decisionId: 'd2', question: '5500 份超大工程日历默认窗口档位', status: '来源不一致' },
      ],
      decisionCount: 288,
      activePackage: {
        id: 'pkg1',
        name: '观澜 v1.2 升级专项',
        stage: '执行',
        docCount: 60,
        awaitingAcceptance: 4,
        badgeLine: 'v8 · 执行中',
      },
      onOpenDecision: () => {},
      onOpenPackageBoard: () => {},
    })
  );
  assert.ok(fcHtml.includes('data-featured-mini-layer="0"'));
  assert.ok(fcHtml.includes('data-featured-mini-layer="1"'));
  assert.ok(fcHtml.includes('h-[70px]') && fcHtml.includes('h-[44px]'), '上下分离微卡高度和=114px < 120px 舞台高度，零重叠零孤字');

  // 3. TaskPackageGallery：coss Frame + CardFrame + 真实数据指纹（Sparkline + 格式彩带）+ 「60 份」不截断
  const f1 = makeFile('f1', '01-方案文档/产品需求与任务包/A/spec.md', 'md', [
    { id: 'r1', v: 2, observedAt: '2026-11-23T09:00:00+08:00' },
  ]);
  const f2 = makeFile('f2', '01-方案文档/产品需求与任务包/A/code.ts', 'ts', [
    { id: 'r2', v: 1, observedAt: '2026-11-22T15:00:00+08:00' },
  ]);
  const docs60 = [
    { fileId: 'f1', title: 'spec.md', format: 'md' as const, stage: '计划' as const, conclusion: '核心结论', versionNumber: 2 },
    ...Array.from({ length: 59 }, (_, i) => ({
      fileId: i === 0 ? 'f2' : `f_extra_${i}`,
      title: `file_${i}.ts`,
      format: 'ts' as const,
      stage: '执行' as const,
      conclusion: '',
      versionNumber: 1,
    })),
  ];
  const pkg60: TaskPackage = {
    id: '01-方案文档/产品需求与任务包/A',
    name: '超大专项',
    kind: 'spec',
    stage: '执行',
    docs: docs60,
    eventCount: 12,
    lastActivity: '2026-11-23T09:00:00+08:00',
    latestConclusion: '核心结论',
    readingOrder: [docs60[0]],
  };
  const galleryHtml = renderToStaticMarkup(
    React.createElement(TaskPackageGallery, {
      packages: [pkg60],
      fileById: new Map([
        [f1.file_id, f1],
        [f2.file_id, f2],
      ]),
      onOpenDoc: () => {},
      nowIso: '2026-11-23T12:00:00+08:00',
    })
  );
  assert.ok(galleryHtml.includes('data-slot="frame"'), '专项橱窗应接入 coss Frame');
  assert.ok(galleryHtml.includes('data-slot="card-frame"'), '专项卡片应接入 coss CardFrame');
  assert.ok(galleryHtml.includes('data-fingerprint-sparkline=""'), '无 SVG 封面专项应呈现近 14 天变更微折线');
  assert.ok(galleryHtml.includes('data-fingerprint-ribbon=""'), '专项封面应呈现格式构成比例彩带');
  assert.ok(galleryHtml.includes('data-fingerprint-segment="markdown"'));
  assert.ok(galleryHtml.includes('data-fingerprint-segment="code"'));
  assert.ok(galleryHtml.includes('60 份'), '60 份计数必须完整展示，杜绝 60... 截断');

  // 4. HomeView：整体接入 Frame + CardFrame
  const homeHtml = renderToStaticMarkup(
    React.createElement(HomeView, {
      files: [f1, f2],
      readingStates: {},
      events: [],
      summary: null,
      eventDays: null,
      recentItems: [],
      decisions: [],
      decisionsUnresolvedTotal: 0,
      onOpenDoc: () => {},
      onResumeReading: () => {},
      onMarkFullyRead: () => {},
      onOpenPackageBoard: () => {},
      onOpenPanorama: () => {},
    })
  );
  assert.ok(homeHtml.includes('data-slot="frame"'));
  assert.ok(homeHtml.includes('data-slot="card-frame"'));
});

// ===== V08 · CommandPanel 双栏 L4A 富预览、零 f_ 裸哈希、Sheet (inset) 嵌套栈与 ModalsAndDrawers 拆解 =====

test('V08 · CommandPalette：零 f_/rev_ 裸哈希泄露 + L4A 摘要与大纲派生 + 无摘要优雅回退 + CommandPanel/Kbd 双栏渲染', () => {
  // 1. 内部裸哈希识别与净化
  assert.equal(isOpaqueInternalHash('f_0114325c93a8b7c6'), true);
  assert.equal(isOpaqueInternalHash('rev_aabbccdd11223344'), true);
  assert.equal(isOpaqueInternalHash('0123456789abcdef01234567'), true);
  assert.equal(isOpaqueInternalHash('架构设计总纲.md'), false);
  assert.equal(sanitizePaletteDisplayText('f_0114325c93a8b7c6', '未命名文档'), '未命名文档');
  assert.equal(
    sanitizePaletteDisplayText('架构方案 f_0114325c93a8b7c6 终稿'),
    '架构方案 终稿'
  );

  // 2. 带完整 FileRecord（含 L4A 摘要与 Markdown 大纲）的富预览模型
  const richFile: FileRecord = {
    ...makeFile('f_0114325c93a8b7c6', '01-方案文档/核心架构/观澜v1.2架构总纲.md', 'md', [
      { id: 'rev_aabbccdd11223344', v: 4, observedAt: '2026-11-23T09:30:00+08:00' },
      { id: 'rev_0000111122223333', v: 3, observedAt: '2026-11-22T18:00:00+08:00' },
    ]),
    revisions: [
      {
        revision_id: 'rev_aabbccdd11223344',
        file_id: 'f_0114325c93a8b7c6',
        versionNumber: 4,
        content_sha256: 'sha_v4',
        sizeBytes: 4096,
        observed_at: '2026-11-23T09:30:00+08:00',
        source_time: '2026-11-23T09:30:00+08:00',
        snapshotAvailable: true,
        summaryNote: '统一采用 coss 原语体系与本地优先双时间护栏',
        changedSectionsFromPrev: [],
        markdownContent: '# 总体目标\n\n统一采用 coss 原语体系。\n\n## 一、核心架构\n\n## 二、降噪策略\n',
      },
    ],
  };

  const richItem = {
    key: 'file:f_0114325c93a8b7c6',
    kind: 'file' as const,
    fileId: 'f_0114325c93a8b7c6',
    revisionId: 'rev_aabbccdd11223344',
    title: '观澜v1.2架构总纲.md',
    subtitle: 'f_0114325c93a8b7c6',
    relativePath: '01-方案文档/核心架构/观澜v1.2架构总纲.md',
    format: 'md',
    pendingDecisions: 2,
    score: 100,
  };

  assert.equal(formatPaletteVersionBadge(richItem, richFile), 'v4 · 最新');
  assert.equal(formatPaletteVersionBadge(richItem), '当前版本', '无 FileRecord 时裸 rev_ 哈希回退为人类可读「当前版本」');

  const richModel = palettePreviewModel(richItem, '架构', richFile);
  assert.equal(richModel.humanVersionLabel, 'v4 · 最新');
  assert.ok(richModel.l4aSummary && richModel.l4aSummary.includes('coss'), '应派生真实 L4A/核心结论摘要');
  assert.ok(richModel.outlineHeadings.includes('总体目标'), '应派生 Markdown 大纲条目');
  assert.ok(richModel.packageName && richModel.packageName.length > 0);
  assert.equal(richModel.snippetFallback, null, '已有 L4A 摘要时不渲染空回退提示');

  // 3. 无 L4A 摘要且无全文 snippet 时优雅回退
  const bareFile = makeFile('f_deadbeef99887766', 'docs/notes.txt', 'txt', [
    { id: 'rev_deadbeef11223344', v: 1, observedAt: '2026-11-23T08:00:00+08:00' },
  ]);
  const bareItem = {
    key: 'file:f_deadbeef99887766',
    kind: 'file' as const,
    fileId: 'f_deadbeef99887766',
    revisionId: 'rev_deadbeef11223344',
    title: 'f_deadbeef99887766',
    subtitle: 'docs/notes.txt',
    relativePath: 'docs/notes.txt',
    format: 'txt',
    score: 50,
  };
  const bareModel = palettePreviewModel(bareItem, 'notes', bareFile);
  assert.equal(bareModel.title, 'notes.txt', '裸 f_ 标题必须净化回退为真实文件名');
  assert.equal(bareModel.l4aSummary, null);
  assert.ok(bareModel.snippetFallback && bareModel.snippetFallback.includes('本地索引命中'), '无摘要时必须诚实优雅回退');

  // 4. SSR 渲染 CommandPalette：内亮板 CommandPanel + Kbd + 零裸哈希泄露 + 时光机按钮
  const paletteHtml = renderToStaticMarkup(
    React.createElement(CommandPalette, {
      isOpen: true,
      query: '架构',
      items: [richItem],
      searching: false,
      files: [richFile],
      onQueryChange: () => {},
      onClose: () => {},
      onOpenFile: () => {},
      onOpenTimeMachine: () => {},
      onLocate: () => {},
      onAddToBasket: () => {},
      onRunAction: () => {},
    })
  );
  assert.ok(paletteHtml.includes('data-slot="command-panel"'), '应渲染 coss CommandPanel 内亮板');
  assert.ok(paletteHtml.includes('data-slot="command-footer"'), '应渲染 coss CommandFooter 底栏');
  assert.ok(paletteHtml.includes('data-slot="kbd"'), '快捷键提示应使用 coss Kbd');
  assert.ok(paletteHtml.includes('v4 · 最新'), '预览窗应展示人类可读版本号 v4 · 最新');
  assert.ok(paletteHtml.includes('data-palette-action-timemachine="true"'), '应提供 Shift+Enter 时光机入口');
  assert.ok(!paletteHtml.includes('f_0114325c93a8b7c6'), 'SSR 渲染文本绝不可泄露 f_ 内部裸哈希');
  assert.ok(!paletteHtml.includes('rev_aabbccdd11223344'), 'SSR 渲染文本绝不可泄露 rev_ 内部裸哈希');
});

test('V08 · ModalsAndDrawers 巨石拆解(<120行) + 分栏设置弹窗 + Sheet (inset) & --nested-dialogs 全浮层栈', () => {
  // 1. ModalsAndDrawers.tsx 行数严格 < 120 且导出向后兼容
  const facadeSrc = readFileSync(
    new URL('../src/components/ModalsAndDrawers.tsx', import.meta.url),
    'utf8'
  );
  const facadeLines = facadeSrc.split(/\r?\n/).length;
  assert.ok(facadeLines < 120, `ModalsAndDrawers.tsx 行数应 < 120（当前 ${facadeLines} 行）`);
  assert.equal(typeof WorkspaceSettingsModal, 'function');
  assert.equal(typeof McpConsoleModal, 'function');
  assert.equal(typeof AgentContextDrawer, 'function');
  assert.equal(SETTINGS_TABS.length, 5, '设置弹窗应拆为 5 大垂直分栏');

  // 2. WorkspaceSettingsModal：垂直 Tabs + Frame 表单 + 静默目录治理页
  const settingsHtml = renderToStaticMarkup(
    React.createElement(WorkspaceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      config: makeConfig(),
      mutedFolders: ['04-智能体代码/node_modules_bak', 'legacy/logs'],
      onUnmuteFolder: () => {},
      onClearMutedFolders: () => {},
      initialTab: 'noise',
    })
  );
  assert.ok(settingsHtml.includes('data-settings-modal="open"'));
  assert.ok(settingsHtml.includes('data-dialog-nested-stack=""'));
  assert.ok(settingsHtml.includes('--nested-dialogs:0'));
  assert.ok(settingsHtml.includes('data-slot="frame"'), '设置分栏表单应使用 coss Frame');
  assert.ok(settingsHtml.includes('工作区') && settingsHtml.includes('降噪与忽略') && settingsHtml.includes('关于观澜'));
  assert.ok(settingsHtml.includes('04-智能体代码/node_modules_bak'), '降噪分栏应列出已静默目录');

  // 3. ReviewBoardDrawer / FileTimelineDrawer / AgentContextDrawer：统一 coss Sheet (inset) + Empty 三卡空态
  const reviewHtml = renderToStaticMarkup(
    React.createElement(ReviewBoardDrawer, {
      isOpen: true,
      onClose: () => {},
      board: {
        ok: true,
        index_generation: 1,
        stall_threshold_secs: 600,
        generated_at: '2026-11-23T12:00:00+08:00',
        counts: {
          pending_decision: 0,
          dispatchable: 0,
          agent_running: 0,
          awaiting_receipt: 0,
          completed: 0,
          unknown: 0,
          total: 0,
        },
        items: [],
      },
      loading: false,
      error: null,
      busyKey: null,
      notice: null,
      onRefresh: () => {},
      onJumpToStatement: () => {},
      onAcknowledgeStatement: () => {},
      onInspectDraft: () => {},
      onRepairOrphan: () => {},
    })
  );
  assert.ok(reviewHtml.includes('data-sheet-variant="inset"'), 'ReviewBoardDrawer 应采用 Sheet inset 材质');
  assert.ok(reviewHtml.includes('data-slot="empty"'), 'ReviewBoardDrawer 空态应接入 coss Empty');

  const timelineDrawerHtml = renderToStaticMarkup(
    React.createElement(FileTimelineDrawer, {
      isOpen: true,
      fileId: 'f1',
      onClose: () => {},
      onOpenRevision: () => {},
    })
  );
  assert.ok(timelineDrawerHtml.includes('data-sheet-variant="inset"'), 'FileTimelineDrawer 应采用 Sheet inset 材质');

  const agentDrawerHtml = renderToStaticMarkup(
    React.createElement(AgentContextDrawer, {
      isOpen: true,
      onClose: () => {},
      pointers: [],
      onRemovePointer: () => {},
      onClearPointers: () => {},
      workspaceRoot: 'H:/workspace/demo',
      onUpdatePointerGranularity: () => {},
      presetPointers: [],
      recommendedMounts: [],
      onMountPointers: () => {},
      intent: 'global',
      intentTemplate: '首页总览默认上下文',
      confirmedDecisions: [],
      pendingBlockers: [],
    })
  );
  assert.ok(agentDrawerHtml.includes('data-sheet-variant="inset"'), 'AgentContextDrawer 应采用 Sheet inset 材质');
  assert.ok(agentDrawerHtml.includes('data-slot="empty"'), 'AgentContextDrawer 空态应接入 coss Empty');

  // 4. QuickPreviewModal & ContextCapsuleModal：--nested-dialogs 嵌套景深锚点
  const f1 = makeFile('f1', 'docs/demo.md', 'md', [
    { id: 'r1', v: 1, observedAt: '2026-11-23T10:00:00+08:00' },
  ]);
  const quickHtml = renderToStaticMarkup(
    React.createElement(QuickPreviewModal, {
      isOpen: true,
      target: { fileId: 'f1', revisionId: 'r1' },
      queue: [{ fileId: 'f1', revisionId: 'r1' }],
      files: [f1],
      indexGeneration: 1,
      onClose: () => {},
      onNavigate: () => {},
      onOpenFullReader: () => {},
    })
  );
  assert.ok(quickHtml.includes('data-dialog-nested-stack=""'), 'QuickPreviewModal 应挂载嵌套景深栈锚点');

  const capsuleHtml = renderToStaticMarkup(
    React.createElement(ContextCapsuleModal, {
      isOpen: true,
      preset: { mode: 'export', title: '测试胶囊' },
      onClose: () => {},
    })
  );
  assert.ok(capsuleHtml.includes('data-dialog-nested-stack=""'), 'ContextCapsuleModal 应挂载嵌套景深栈锚点');
});

// ===== V09 · 全景列表司辰时光流、资产库概览折叠护栏与星图/时光机/阅读器实机精修 =====

test('V09 · TimelineView 司辰时光流：按日 Frame 聚组 + Toolbar/SegmentedControl + 「在星图定位此日」直跳', () => {
  // 1. 纯函数按日聚组（保序不重排 + 精确事件计和 + undated 分流）
  const buckets = groupTimelineRenderItemsByDay(
    [
      { id: 'e1', day: '2026-11-23', count: 1 },
      { id: 'e2', day: '2026-11-23', count: 3 },
      { id: 'e3', day: '2026-11-22', count: 2 },
      { id: 'e4', day: '', count: 1 },
    ],
    (x) => ({ day: x.day, eventCount: x.count })
  );
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].day, '2026-11-23');
  assert.equal(buckets[0].eventCount, 4);
  assert.equal(buckets[0].items.length, 2);
  assert.equal(buckets[1].day, '2026-11-22');
  assert.equal(buckets[2].day, 'undated');
  assert.equal(buckets[2].label, '日期待考');

  // 2. SSR 渲染：coss Frame + Toolbar + SegmentedControl + 一键星图定位此日 + 守住核心文档开关
  const f1 = makeFile('f1', '01-方案文档/架构/spec.md', 'md', [
    { id: 'r1', v: 2, observedAt: '2026-11-23T09:15:00+08:00' },
  ]);
  const html = renderToStaticMarkup(
    React.createElement(TimelineView, {
      events: [
        {
          event_id: 'ev1',
          kind: 'modified',
          file_id: 'f1',
          revision_id: 'r1',
          observed_at: '2026-11-23T09:15:00+08:00',
          source_time: '2026-11-23',
          occurred_source: 'document_self',
          occurred_precision: 'day',
          topic_lane: '01-方案文档/架构',
          headline: 'spec.md 更新了核心架构章节',
          detail: '补充 coss 原语体系说明',
          format: 'md',
        },
      ],
      eventOrder: 'occurred',
      onToggleOrder: () => {},
      kindFilter: 'all',
      onKindFilterChange: () => {},
      files: [f1],
      readingStates: {},
      selectedEventId: 'ev1',
      onSelectEvent: () => {},
      onOpenFileFromTimeline: () => {},
      onOpenDecisionFromTimeline: () => {},
      onJumpToStarMap: () => {},
    })
  );
  assert.ok(html.includes('data-timeline-chronos-stream=""'), '应渲染司辰时光流根锚点');
  assert.ok(html.includes('data-slot="toolbar"'), '顶部筛选条应统一为 coss Toolbar');
  assert.ok(html.includes('data-slot="segmented-control"'), '时间口径与日期范围应使用 SegmentedControl');
  assert.ok(html.includes('data-slot="frame"'), '日级沉淀卡组应使用 coss Frame');
  assert.ok(html.includes('data-timeline-day-frame="2026-11-23"'));
  assert.ok(html.includes('data-timeline-jump-starmap="2026-11-23"'), '应提供一键「在星图定位此日」直跳入口');
  assert.ok(html.includes('data-testid="core-only-toggle"'), '必须守住「仅看核心文档」开关');

  // 3. 空态走 coss Empty
  const emptyHtml = renderToStaticMarkup(
    React.createElement(TimelineView, {
      events: [],
      kindFilter: 'all',
      onKindFilterChange: () => {},
      files: [],
      readingStates: {},
      selectedEventId: '',
      onSelectEvent: () => {},
      onOpenFileFromTimeline: () => {},
      onOpenDecisionFromTimeline: () => {},
    })
  );
  assert.ok(emptyHtml.includes('data-slot="empty"'), '空筛选结果应使用 coss Empty');
});

test('V09 · AtlasView 资产库概览：超大目录代表件折叠 60fps 护栏 + CardFrame 数据指纹 + Toolbar 模式切换', () => {
  // 1. 纯函数代表件折叠：优先未读，其次最新 observedAt，严格截断到 ATLAS_LARGE_FOLDER_CAP=12
  assert.equal(ATLAS_LARGE_FOLDER_CAP, 12);
  const rawItems = Array.from({ length: 30 }, (_, i) => ({
    id: `item_${i}`,
    unread: i === 25 || i === 28,
    observedAt: `2026-11-${String((i % 20) + 1).padStart(2, '0')}T10:00:00+08:00`,
  }));
  const collapsed = sliceAtlasFolderItems(rawItems, false);
  assert.equal(collapsed.isTruncated, true);
  assert.equal(collapsed.visible.length, 12);
  assert.equal(collapsed.hiddenCount, 18);
  assert.equal(collapsed.visible[0].unread, true, '未读代表件必须排在折叠首屏最前');
  assert.equal(collapsed.visible[1].unread, true);
  const expanded = sliceAtlasFolderItems(rawItems, true);
  assert.equal(expanded.isTruncated, false);
  assert.equal(expanded.visible.length, 30);
  assert.equal(expanded.hiddenCount, 0);

  // 2. SSR 渲染：CardFrame + 数据指纹彩带 + 展开剩余 18 份按钮 + Toolbar + 紧凑网格/画布导览切换
  const bigFolderFiles: FileRecord[] = Array.from({ length: 30 }, (_, i) =>
    makeFile(`big_${i}`, `src/components/Comp${i}.${i % 3 === 0 ? 'md' : 'ts'}`, i % 3 === 0 ? 'md' : 'ts', [
      { id: `rev_big_${i}`, v: 1, observedAt: '2026-11-23T10:00:00+08:00' },
    ])
  );
  const atlasHtml = renderToStaticMarkup(
    React.createElement(AtlasView, {
      files: bigFolderFiles,
      readingStates: {},
      onOpenFile: () => {},
      activeFileId: 'big_0',
      variant: 'embedded',
    })
  );
  assert.ok(atlasHtml.includes('data-slot="toolbar"'), '资产库概览应使用统一 coss Toolbar');
  assert.ok(atlasHtml.includes('data-slot="segmented-control"'), '应支持画布导览 / 紧凑网格切换');
  assert.ok(atlasHtml.includes('data-slot="card-frame"'), '目录概览卡片应采用 CardFrame');
  assert.ok(atlasHtml.includes('data-atlas-format-ribbon=""'), '目录卡应带格式构成数据指纹彩带');
  assert.ok(atlasHtml.includes('data-atlas-folder-toggle="src/components"'), '超大目录默认折叠并提供展开剩余按钮');
  assert.ok(atlasHtml.includes('展开剩余 18 份'));
});

test('V09 · 时光机 ≥360px 防截断 + 星图首尾安全区/预览卡 + 阅读器 Toolbar/Group 与全局明暗同步', () => {
  // 1. 时光机防右缘截断护栏（守住 ≥360px 宽、xMinYMid 避让、Toolbar/SegmentedControl 语义与 overflow:hidden）
  const tmSrc = readFileSync(
    new URL('../src/components/DocumentTimeMachineView.tsx', import.meta.url),
    'utf8'
  );
  const diffPaneSrc = readFileSync(
    new URL('../src/components/timemachine/DiffSidePane.tsx', import.meta.url),
    'utf8'
  );
  const egCss = readFileSync(
    new URL('../src/components/eventGraph.css', import.meta.url),
    'utf8'
  );
  // 统一右侧检查/对比栏已从悬浮覆盖升级为独立网格列（画布居中且 ≥420px，零压盖截断）
  assert.ok(tmSrc.includes('preserveAspectRatio="xMidYMid meet"') && tmSrc.includes('data-machine-unified-inspector=""'));
  assert.ok(tmSrc.includes('data-slot="toolbar"') && tmSrc.includes('data-slot="segmented-control"'));
  assert.ok(diffPaneSrc.includes('calc(100% - 360px)'), 'DiffSidePane 必须为左栏版本链保留 ≥360px 可视宽度');
  assert.ok(egCss.includes('minmax(420px, 1fr)'), 'eventGraph.css 必须锁定版本链列 ≥420px（超越原 360px 底线）');
  assert.ok(egCss.includes('box-sizing: border-box; overflow: hidden;'));

  // 2. 星图 4 处版面精修锚点
  const trunkSrc = readFileSync(
    new URL('../src/components/graph/GraphSceneTrunk.tsx', import.meta.url),
    'utf8'
  );
  const backdropSrc = readFileSync(
    new URL('../src/components/graph/GraphSceneBackdrop.tsx', import.meta.url),
    'utf8'
  );
  const overlaySrc = readFileSync(
    new URL('../src/components/graph/GraphOverlayLayer.tsx', import.meta.url),
    'utf8'
  );
  assert.ok(backdropSrc.includes('data-trunk-open-reader-chip=""'), '「打开阅读器 →」应收整为锚定胶囊');
  assert.ok(trunkSrc.includes('y={TRUNK_AXIS_TOP - 22}'), '「此刻 · 最新沉淀」应与脊顶留出充足呼吸间距');
  assert.ok(trunkSrc.includes('y={TRUNK_AXIS_BOTTOM - 2}'), '「时光起点」应抬离底部浮坞安全区');
  assert.ok(overlaySrc.includes('data-slot="preview-card"'), '星图节点悬停速览应接入 PreviewCard 语义');

  // 3. 阅读器 Toolbar/Group 与全站明暗主题平滑衔接
  const f1 = makeFile('f_reader', 'docs/v09.md', 'md', [
    { id: 'r_reader', v: 1, observedAt: '2026-11-23T10:00:00+08:00' },
  ]);
  f1.revisions[0].markdownContent = '# V09 标题\n\n测试正文。';

  // 全局暗夜模式下，阅读器首帧自动落入暗夜阅读纸
  applyAppTheme('dark', false);
  const darkReaderHtml = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [f1],
      activeFile: f1,
      pinnedRevisionId: 'r_reader',
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
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
  assert.ok(darkReaderHtml.includes('data-reader-toolbar=""'), '阅读器顶栏应换装 coss Toolbar');
  assert.ok(darkReaderHtml.includes('data-slot="group"'), '阅读器操作组应换装 coss Group');
  assert.ok(darkReaderHtml.includes('切换到纸面浅色'), '全站暗夜模式下阅读器应自动同步至暗夜阅读纸');

  // 切回浅色模式复原状态
  applyAppTheme('light', false);
  const lightReaderHtml = renderToStaticMarkup(
    React.createElement(ReaderView, {
      files: [f1],
      activeFile: f1,
      pinnedRevisionId: 'r_reader',
      onChangeRevision: () => {},
      subMode: 'read',
      onChangeSubMode: () => {},
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
  assert.ok(lightReaderHtml.includes('切换到深色阅读纸'), '全站浅色模式下阅读器应自动呈现暖宣纸');
});
