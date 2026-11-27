import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import CanvasNarrativeDrawer from '../src/components/canvas/CanvasNarrativeDrawer';
import { ChronosMascotNode } from '../src/components/ChronosMascotNode';
import { GraphTopBar } from '../src/components/graph/graphCanvasChrome';
import {
  GraphChronosDropBubble,
  GraphHoverPreviewCard,
  GraphNarrativeLinkOverlay,
} from '../src/components/graph/GraphOverlayLayer';
import { GraphSpotlightBar } from '../src/components/graph/GraphSpotlightBar';
import { useGraphCanvasNarrative } from '../src/components/graph/graphCanvasNarrative';
import type { FileRecord, RelationEdge } from '../src/types/guanlan';
import type { CanvasEventScene } from '../src/utils/graphEvents';

function readSrc(relPath: string): string {
  return readFileSync(new URL(`../src/${relPath}`, import.meta.url), 'utf8');
}

function makeFile(id: string, title: string, relativePath: string): FileRecord {
  return {
    file_id: id,
    title,
    relative_path: relativePath,
    format: 'md',
    role: '方案',
    current_revision_id: `${id}_r1`,
    coverage: 'full',
    revisions: [
      {
        revision_id: `${id}_r1`,
        versionNumber: 1,
        observed_at: '2026-11-23T20:29:00+08:00',
        content_sha256: 'abc123',
        size_bytes: 1200,
        summaryNote: '初版记录',
        changedSectionsFromPrev: [],
      },
    ],
  } as unknown as FileRecord;
}

const EMPTY_SCENE: CanvasEventScene = {
  hasRealEvents: true,
  activeDate: '2026-11-23',
  active: null,
  days: [],
  ruler: [],
  navigator: [],
  granularity: 'day',
  totals: { events: 1, days: 1, matters: 1, undated: 0 },
};

test('星图叙事抽屉：双层底栏 CSS 锁定全宽主 CTA 与不换行次级条（含 4 钮 2×2 栅格）', () => {
  const css = readSrc('components/canvas/canvasWidgets.css');
  assert.match(css, /\.cvw-narrative-foot\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(css, /\.cvw-narrative-foot-primary\s*\{[^}]*width:\s*100%;[^}]*white-space:\s*nowrap;/s);
  assert.match(css, /\.cvw-narrative-foot-btn\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.ok(css.includes('.cvw-narrative-foot-secondary:has(> :nth-child(4))'));
  assert.match(css, /\.cvw-narrative-head\s*\{[^}]*padding:\s*16px 46px 12px 18px;/s);
});

test('星图叙事连线：已退役跨画布 HUD 虚线（GraphNarrativeLinkOverlay 恒返回 null）', () => {
  const html = renderToStaticMarkup(
    React.createElement(GraphNarrativeLinkOverlay, {
      ctx: {
        narrativeDrawerOpen: true,
        stageWidth: 1400,
        zoomTransform: { x: 0, y: 0, k: 1 },
        selectedCardPos: { x: 468, y: 248 },
        activeTickY: 100,
        scene: EMPTY_SCENE,
        trunkX: 300,
        prefersReducedMotion: false,
      } as never,
    })
  );
  assert.equal(html, '');
});

test('星图顶栏防撞：资产域切换以原生 topBarSlot 嵌入顶栏，不再使用绝对定位遮盖工具钮', () => {
  const appMainSrc = readSrc('components/app/AppMainViews.tsx');
  const chromeSrc = readSrc('components/graph/graphCanvasChrome.tsx');
  assert.ok(appMainSrc.includes('topBarSlot={'), 'AppMainViews 应通过 topBarSlot 注入域过滤');
  assert.ok(
    !appMainSrc.includes('absolute top-[13px] left-1/2 -translate-x-1/2 z-30'),
    '不应再以绝对定位居中悬浮压盖 GraphTopBar'
  );
  assert.ok(chromeSrc.includes('{topBarSlot}'), 'GraphTopBar 应渲染 topBarSlot');
  assert.ok(chromeSrc.includes('<GraphSpotlightBar ctx={ctx} mode="toggle" />'));
});

test('增量聚光灯拆层：mode=toggle 仅渲染紧凑开关，mode=nav 独立浮于画布顶部且自带退出钮', () => {
  const baseCtx = {
    visible: true,
    narrativeDrawerOpen: true,
    onSelectFile: () => {},
    spotlight: {
      enabled: true,
      items: [],
      dimmedFileIds: new Set<string>(),
      cursor: 0,
      onToggle: () => {},
      onCursor: () => {},
    },
  } as never;

  const toggleHtml = renderToStaticMarkup(
    React.createElement(GraphSpotlightBar, { ctx: baseCtx, mode: 'toggle' })
  );
  assert.ok(toggleHtml.includes('data-cv-spotlight-toggle'));
  assert.ok(!toggleHtml.includes('data-cv-spotlight-nav'));

  const navHtml = renderToStaticMarkup(
    React.createElement(GraphSpotlightBar, { ctx: baseCtx, mode: 'nav' })
  );
  assert.ok(navHtml.includes('data-cv-spotlight-nav'));
  assert.ok(navHtml.includes('关闭增量聚光灯'));
  assert.ok(!navHtml.includes('data-cv-spotlight-toggle'));
});

test('叙事抽屉引用依据：按目标文档合并重复边、不换行胶囊展示并去重事件变更文案', () => {
  const f1 = makeFile('f_readme', 'README', 'README.md');
  const f2 = makeFile('f_plan', '架构方案', 'docs/架构方案.md');
  const relations: RelationEdge[] = [
    {
      edge_id: 'e1',
      source_id: 'f_readme',
      target_id: 'f_plan',
      type: 'explicit_reference',
      isInferred: false,
      label: '显式引用（收录版本）',
      locator: { startLine: 9, endLine: 9 },
    } as RelationEdge,
    {
      edge_id: 'e2',
      source_id: 'f_readme',
      target_id: 'f_plan',
      type: 'explicit_reference',
      isInferred: false,
      label: '显式引用（收录版本）',
      locator: { startLine: 21, endLine: 21 },
    } as RelationEdge,
  ];

  function Harness() {
    const { narrative } = useGraphCanvasNarrative({
      narrativeTarget: { nodeId: 'sub_01', fileId: 'f_readme' },
      subAgentCards: [
        {
          id: 'sub_01',
          fileId: 'f_readme',
          revisionId: 'f_readme_r1',
          fileName: 'README',
          format: 'md',
          detail: '文档自述日期: README (2026-11-23)',
          timeRange: '2026-11-23',
          observedClock: '20:29',
          peakMetric: 2,
          timeBucket: '2026-11-23',
        } as never,
      ],
      files: [f1, f2],
      decisions: [],
      relations,
      scene: EMPTY_SCENE,
      rulerGranularity: 'day',
      packageGroups: [],
      orderedPackageGroups: [],
      focusedPkgId: '',
      unreadCount: 0,
      workspaceName: 'desktop-organizer',
      onOpenDecisionModal: () => {},
      onSelectCitation: () => {},
      activeFileRecord: f1,
    });
    return React.createElement(CanvasNarrativeDrawer, {
      open: true,
      title: narrative.title,
      metaLine: narrative.metaLine,
      sections: narrative.sections,
      onClose: () => {},
    });
  }

  const html = renderToStaticMarkup(React.createElement(Harness));
  assert.equal((html.match(/cvw-narrative-ref-item/g) ?? []).length, 2);
  assert.ok(html.includes('架构方案'));
  assert.ok(html.includes('显式引用（收录版本） · 2 处'));
  assert.equal((html.match(/文档自述日期: README \(2026-11-23\)/g) ?? []).length, 1);
});

test('星图缩放帧级同步：控制器订阅实时缩放流、标题 Overlay 每帧直写且居中对齐', () => {
  const ctrlSrc = readSrc('components/graph/useGraphCanvasController.tsx');
  const overlaySrc = readSrc('components/graph/GraphOverlayLayer.tsx');
  assert.ok(ctrlSrc.includes('subscribeZoomFrame'));
  assert.ok(ctrlSrc.includes('notifyZoomFrame({ x, y, k })'));
  assert.ok(ctrlSrc.includes('zoomByDelta'));
  assert.ok(overlaySrc.includes('subscribeZoomFrame(syncDom)'));
  assert.ok(overlaySrc.includes("transform: 'translateY(-50%)'"));
});

test('全景溯源顶栏改版：功能分簇、详情按压态与列表/日历域过滤统一隐零', () => {
  const topBarHtml = renderToStaticMarkup(
    React.createElement(GraphTopBar, {
      ctx: {
        panoramaMode: 'canvas',
        onPanoramaModeChange: () => {},
        onCanvasThemeChange: () => {},
        openNarrativeDrawer: () => {},
        narrativeDrawerOpen: true,
        activeDate: '2026-11-23',
        scene: {
          ...EMPTY_SCENE,
          active: {
            date: '2026-11-23',
            label: '11-23',
            count: 5,
            matterCount: 2,
            kinds: {},
            formats: { md: 5 },
            events: [],
          },
        },
        rulerGranularity: 'day',
        onGranularityChange: () => {},
        isTimeFlowPlaying: false,
        toggleTimeFlowPlay: () => {},
        stepChronosDay: () => {},
        canStepOlder: true,
        canStepNewer: false,
        accumulationSummary: {
          date: '2026-11-23',
          addedCount: 2,
          modifiedCount: 3,
          cumulativeEvents: 12,
          totalEvents: 12,
          cumulativePercent: 100,
          chronologicalOrder: 3,
          totalActiveDays: 3,
        },
        onOpenChronosDigest: () => {},
        spotlight: {
          enabled: false,
          items: [],
          dimmedFileIds: new Set<string>(),
          cursor: 0,
          onToggle: () => {},
          onCursor: () => {},
        },
        visible: true,
      } as never,
    })
  );

  assert.ok(topBarHtml.includes('data-panorama-topbar="canvas"'));
  assert.ok(topBarHtml.includes('data-topbar-cluster="view"'));
  assert.ok(topBarHtml.includes('data-topbar-cluster="actions"'));
  assert.ok(topBarHtml.includes('data-topbar-cluster="chronos"'));
  assert.match(
    topBarHtml,
    /<button[^>]*data-cv-topbar-detail(?:="(?:true|)")?[^>]*aria-pressed="true"/
  );
  assert.ok(topBarHtml.includes('11-23'));
  assert.ok(topBarHtml.includes('累计 12'));

  const appMainSrc = readSrc('components/app/AppMainViews.tsx');
  assert.ok(appMainSrc.includes('data-panorama-topbar="list"'));
  assert.ok(appMainSrc.includes('data-panorama-topbar="calendar"'));
  const domainMatches = appMainSrc.match(/domainCounts\.code > 0 && renderDomainToolbar/g) ?? [];
  assert.equal(domainMatches.length, 3, '星图/列表/日历三态均应在无代码文件时隐藏域筛选条');
});

test('司辰信息载体改版：自适应胶囊铭牌、世界坐标纠偏落点气泡与三格遥测悬停卡', () => {
  const mascotHtml = renderToStaticMarkup(
    React.createElement(
      'svg',
      null,
      React.createElement(ChronosMascotNode, {
        x: 100,
        y: 200,
        activeTimeSlice: 'all',
        epochLabel: '11-23 · +5 变动',
        metaText: '第 2/3 日 · 累计 12',
        isHovered: false,
        isSelected: false,
        prefersReducedMotion: true,
        onMouseEnter: () => {},
        onMouseLeave: () => {},
        onClickCycleTime: () => {},
      })
    )
  );
  assert.ok(mascotHtml.includes('data-chronos-carrier="badge"'));
  assert.ok(mascotHtml.includes('11-23 · +5 变动'));
  assert.ok(mascotHtml.includes('第 2/3 日 · 累计 12'));

  const dropHtml = renderToStaticMarkup(
    React.createElement(GraphChronosDropBubble, {
      ctx: {
        chronosDropSummary: {
          date: '2026-11-23',
          count: 5,
          addedCount: 2,
          modifiedCount: 3,
          cumulativeEvents: 12,
          headlines: ['架构定版', '接口对齐'],
          text: '架构定版；接口对齐',
          x: 200,
          y: 260,
        },
        dismissChronosDropSummary: () => {},
        onOpenChronosDigest: () => {},
        zoomTransform: { x: 0, y: 0, k: 1 },
        selectDate: () => {},
        stageWidth: 1280,
        stageHeight: 720,
        narrativeDrawerOpen: false,
      } as never,
    })
  );
  assert.ok(dropHtml.includes('data-chronos-carrier="drop-bubble"'));
  assert.ok(dropHtml.includes('+2 新增'));
  assert.ok(dropHtml.includes('3 演进'));
  assert.ok(dropHtml.includes('累计 12 条'));
  assert.ok(dropHtml.includes('架构定版'));
  assert.ok(dropHtml.includes('关闭司辰日期气泡'));
  assert.ok(dropHtml.includes('查看司辰手记'));

  const hoverHtml = renderToStaticMarkup(
    React.createElement(GraphHoverPreviewCard, {
      ctx: {
        hoverPreviewData: {
          title: '观澜司辰',
          format: 'md',
          relativePath: 'README.md',
          versionNumber: 1,
          totalRevisions: 1,
          modificationRoundLabel: 'v1',
          unreadStatus: { isUnread: false, statusLabel: '已阅', scrollPercent: 100, changedSections: [] },
          coreSummary: '',
        },
        hoveredPreviewAnchor: { fileId: 'f_readme', nodeId: 'chronos_deity', x: 112, y: 266 },
        activeDraggingNodeId: null,
        zoomTransform: { x: 0, y: 0, k: 1 },
        scene: {
          ...EMPTY_SCENE,
          active: {
            date: '2026-11-23',
            label: '11-23',
            count: 5,
            matterCount: 2,
            kinds: {},
            formats: { md: 5 },
            events: [],
          },
          totals: { events: 12, days: 3, matters: 2, undated: 0 },
        },
        activeTimeSlice: 'all',
        files: [makeFile('f_readme', 'README', 'README.md')],
        accumulationSummary: {
          date: '2026-11-23',
          addedCount: 2,
          modifiedCount: 3,
          cumulativeEvents: 12,
          totalEvents: 12,
          cumulativePercent: 100,
          chronologicalOrder: 3,
          totalActiveDays: 3,
        },
        stageWidth: 1280,
        stageHeight: 720,
        narrativeDrawerOpen: false,
      } as never,
    })
  );
  assert.ok(hoverHtml.includes('data-chronos-carrier="hover-card"'));
  assert.ok(hoverHtml.includes('当前刻度'));
  assert.ok(hoverHtml.includes('当日变动'));
  assert.ok(hoverHtml.includes('累计沉淀'));
  assert.ok(hoverHtml.includes('+2 / ↻3'));
  assert.ok(!hoverHtml.includes('当前时间法则'));
  assert.ok(!hoverHtml.includes('SHA-256'));

  const ctrlSrc = readSrc('components/graph/useGraphCanvasController.tsx');
  assert.ok(ctrlSrc.includes('pointerLocalX = (pointerX - transform.x) / k'));
  assert.ok(ctrlSrc.includes('dismissChronosDropSummary'));
});

