import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PdfPageAnnotations,
  ReaderAnnotationComposer,
  ReaderAnnotationDrawer,
  SvgAnnotationOverlay,
} from '../src/components/reader/readerAnchorLayer';
import { buildDecisionBlockInsertion } from '../src/utils/readerAnnotations';
import { parseDecisionBlocks } from '../src/utils/decisionBlocks';
import type { ReaderAnnotation } from '../src/utils/readerAnnotations';

const mdAnn: ReaderAnnotation = {
  id: 'anno_1',
  note: '这里的口径需要复核',
  created_at: '2026-11-21T00:00:00.000Z',
  converted: false,
  locator: { kind: 'md', startLine: 42, excerpt: '段落摘录' },
};
const svgAnn: ReaderAnnotation = {
  id: 'anno_2',
  note: '这个区域标注有误',
  created_at: '2026-11-21T00:00:00.000Z',
  converted: true,
  decision_text: '这个区域标注有误',
  locator: { kind: 'svg', fx: 0.12, fy: 0.34, fw: 0.25, fh: 0.2 },
};
const pdfAnn: ReaderAnnotation = {
  id: 'anno_3',
  note: '第 3 页这段结论与第 1 页矛盾',
  created_at: '2026-11-21T00:00:00.000Z',
  converted: false,
  locator: { kind: 'pdf', page: 3, quote: '选中文字摘录' },
};

test('撰写卡：锚点标签/保存/转决定项/诚实禁用与理由齐备', () => {
  const html = renderToStaticMarkup(
    React.createElement(ReaderAnnotationComposer, {
      open: true,
      anchorLabel: 'L42',
      paperLightMode: true,
      convertAvailable: false,
      convertDisabledReason: '当前环境不支持回写原文件（无桌面壳命令桥）；可先保存批注。',
      busy: false,
      notice: null,
      onSave: () => {},
      onConvert: () => {},
      onClose: () => {},
    })
  );
  assert.ok(html.includes('data-annotation-composer="open"'));
  assert.ok(html.includes('锚点 L42'));
  assert.ok(html.includes('data-annotation-note-input'));
  assert.ok(html.includes('data-annotation-save'));
  assert.ok(html.includes('data-annotation-convert'));
  assert.ok(html.includes('转为 [P1 - 待确认] 决定项'));
  assert.ok(html.includes('无桌面壳命令桥'));
  assert.ok(html.includes('data-annotation-composer-close'));
});

test('撰写卡：关闭态零 DOM；错误通知如实渲染', () => {
  const closed = renderToStaticMarkup(
    React.createElement(ReaderAnnotationComposer, {
      open: false, anchorLabel: 'L42', paperLightMode: false,
      convertAvailable: true, busy: false, notice: null,
      onSave: () => {}, onConvert: () => {}, onClose: () => {},
    })
  );
  assert.equal(closed, '');
  const noticed = renderToStaticMarkup(
    React.createElement(ReaderAnnotationComposer, {
      open: true, anchorLabel: '框选区（12%, 34%）', paperLightMode: false,
      convertAvailable: true, busy: false,
      notice: { kind: 'error', message: '原文件已被外部修改（磁盘内容与阅读快照不一致）' },
      onSave: () => {}, onConvert: () => {}, onClose: () => {},
    })
  );
  assert.ok(noticed.includes('data-annotation-notice="error"'));
  assert.ok(noticed.includes('磁盘内容与阅读快照不一致'));
});

test('批注清单：定位/删除/锚点标签/已转决定项徽标/空态', () => {
  const html = renderToStaticMarkup(
    React.createElement(ReaderAnnotationDrawer, {
      open: true,
      paperLightMode: true,
      annotations: [mdAnn, svgAnn],
      onJump: () => {},
      onDelete: () => {},
      onClose: () => {},
    })
  );
  assert.ok(html.includes('data-annotation-drawer="open"'));
  assert.ok(html.includes('data-annotation-item="anno_1"'));
  assert.ok(html.includes('data-annotation-item="anno_2"'));
  assert.ok(html.includes('L42'));
  assert.ok(html.includes('框选区（12%, 34%）'));
  assert.ok(html.includes('已转决定项'));
  assert.ok(html.includes('决定文本：这个区域标注有误'));
  assert.ok(html.includes('定位'));
  assert.ok(html.includes('本版本批注（2）'));
  const empty = renderToStaticMarkup(
    React.createElement(ReaderAnnotationDrawer, {
      open: true, paperLightMode: false, annotations: [],
      onJump: () => {}, onDelete: () => {}, onClose: () => {},
    })
  );
  assert.ok(empty.includes('本版本还没有批注'));
  const closed = renderToStaticMarkup(
    React.createElement(ReaderAnnotationDrawer, {
      open: false, paperLightMode: false, annotations: [mdAnn],
      onJump: () => {}, onDelete: () => {}, onClose: () => {},
    })
  );
  assert.equal(closed, '');
});

test('SVG 框选叠加层：查看态/框选态两态、已存区域百分比定位、闪烁类', () => {
  const view = renderToStaticMarkup(
    React.createElement(SvgAnnotationOverlay, {
      annotations: [svgAnn],
      annotateMode: false,
      paperLightMode: true,
      flashAnnotationId: 'anno_2',
      onRegionSelected: () => {},
    })
  );
  assert.ok(view.includes('data-svg-annotation-overlay="view"'));
  assert.ok(view.includes('data-svg-annotation-region="anno_2"'));
  assert.ok(view.includes('left:12.000%'));
  assert.ok(view.includes('width:25.000%'));
  assert.ok(view.includes('glx-anchor-flash'));
  assert.ok(!view.includes('data-svg-annotation-draft'));
  const selecting = renderToStaticMarkup(
    React.createElement(SvgAnnotationOverlay, {
      annotations: [],
      annotateMode: true,
      paperLightMode: false,
      flashAnnotationId: null,
      onRegionSelected: () => {},
    })
  );
  assert.ok(selecting.includes('data-svg-annotation-overlay="select"'));
  assert.ok(selecting.includes('框选模式'));
  assert.ok(selecting.includes('crosshair'));
});

test('PDF 页批注 chips：页内摘录前缀/闪烁类/无批注零 DOM', () => {
  const html = renderToStaticMarkup(
    React.createElement(PdfPageAnnotations, {
      annotations: [pdfAnn],
      flashAnnotationId: null,
      paperLightMode: true,
    })
  );
  assert.ok(html.includes('data-pdf-page-annotations="1"'));
  assert.ok(html.includes('data-pdf-annotation-item="anno_3"'));
  assert.ok(html.includes('「选中文字摘录」'));
  assert.ok(html.includes('第 3 页这段结论与第 1 页矛盾'));
  const none = renderToStaticMarkup(
    React.createElement(PdfPageAnnotations, {
      annotations: [],
      flashAnnotationId: null,
      paperLightMode: false,
    })
  );
  assert.equal(none, '');
});

test('决定块插入产物可被 parseDecisionBlocks 识别为待确认决定', () => {
  const ins = buildDecisionBlockInsertion({
    markdownContent: '# 方案\n\n正文段。',
    afterLine: 3,
    note: '存储选型需复核',
    locatorLabel: 'L3',
  });
  assert.ok(ins.ok);
  if (!ins.ok) return;
  const blocks = parseDecisionBlocks(ins.newContent);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].status, '待确认');
  assert.equal(blocks[0].priority, 'P1');
  assert.ok(blocks[0].blocking);
  assert.match(blocks[0].title, /存储选型需复核/);
  assert.equal(ins.newContent.split('\n')[0], '# 方案');
  assert.equal(ins.newContent.split('\n')[1], '');
  assert.equal(ins.newContent.split('\n')[2], '正文段。');
});
