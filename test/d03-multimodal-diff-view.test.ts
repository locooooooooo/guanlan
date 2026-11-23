/**
 * D03 · 多模态 Diff 面板渲染契约（SSR 冒烟，与 commandPaletteView.test.ts 同风格）。
 * 交互逻辑（拖拽分隔线/模式切换）在客户端，此处锁定静态结构契约：
 * MD 人类视图三块与源码行折叠 / SVG 双图层+叠加框+模式钮 / 表格变化格高亮+数值 Δ+XLSX 工作表 tab。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffSidePane } from '../src/components/timemachine/DiffSidePane';
import { MdHumanDiffPanel } from '../src/components/timemachine/MdHumanDiffPanel';
import { SvgComparePanel } from '../src/components/timemachine/SvgComparePanel';
import { TableDiffPanel } from '../src/components/timemachine/TableDiffPanel';
import { buildMarkdownHumanDiff, buildSvgDiff, buildTableDiff, buildXlsxDiff } from '../src/utils/multimodalDiff';

const MD_OLD = [
  '# 登录方案',
  '## 背景',
  '旧背景描述',
  '- [P1 - 待确认] 存储选型',
  '- [ ] 评审未完成',
].join('\n');
const MD_NEW = [
  '# 登录方案',
  '## 背景',
  '新背景描述（已补充合规要求）',
  '- [P1 - 已确认] 存储选型',
  '- [x] 评审未完成',
  '- [ ] 新增回归验证',
].join('\n');

test('MD 人类视图：标题结构徽标/决定状态变化/勾选翻转/关键增删段齐备', () => {
  const result = buildMarkdownHumanDiff(MD_OLD, MD_NEW);
  const html = renderToStaticMarkup(
    React.createElement(MdHumanDiffPanel, { result, mode: 'human' as const })
  );
  assert.ok(html.includes('data-machine-md-human'));
  assert.ok(html.includes('标题结构'));
  assert.ok(html.includes('[修改]')); // 背景章
  assert.ok(html.includes('决定 / 待办变化'));
  assert.ok(html.includes('状态变化')); // P1 存储选型 待确认→已确认
  assert.ok(html.includes('勾选翻转')); // 评审未完成
  assert.ok(html.includes('新增待办'));
  assert.ok(html.includes('关键增删段'));
  assert.ok(html.includes('+ 新背景描述（已补充合规要求）')); // 增行
  assert.ok(html.includes('- 旧背景描述')); // 删行
});

test('MD 源码行模式：折叠行渲染且变化行全量呈现', () => {
  const result = buildMarkdownHumanDiff(MD_OLD, MD_NEW);
  const html = renderToStaticMarkup(
    React.createElement(MdHumanDiffPanel, { result, mode: 'source' as const })
  );
  assert.ok(html.includes('data-machine-md-source'));
  assert.ok(html.includes('+ 新背景描述（已补充合规要求）'));
  assert.ok(html.includes('- [P1 - 待确认] 存储选型'));
});

test('DiffSidePane：受控开合两态与徽标/副标题渲染', () => {
  const open = renderToStaticMarkup(
    React.createElement(DiffSidePane, {
      badge: 'SVG', subtitle: 'v1 → v2', title: '叠影对比', open: true, onToggle: () => {},
    }, React.createElement('div', {}, 'body-content'))
  );
  assert.ok(open.includes('data-machine-diff-pane="open"'));
  assert.ok(open.includes('SVG'));
  assert.ok(open.includes('v1 → v2'));
  assert.ok(open.includes('body-content'));
  assert.ok(open.includes('data-machine-diff-pane-close'));
  const collapsed = renderToStaticMarkup(
    React.createElement(DiffSidePane, {
      badge: 'CSV', subtitle: 'v1 → v2', title: '表格对比', open: false, onToggle: () => {},
    }, React.createElement('div', {}, 'body-content'))
  );
  assert.ok(collapsed.includes('data-machine-diff-pane="collapsed"'));
  assert.ok(!collapsed.includes('body-content'));
});

const SVG_OLD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect id="bg" x="0" y="0" width="200" height="100" fill="#111"/><circle cx="50" cy="50" r="20" fill="#4C8DFF"/><script>alert(1)</script></svg>';
const SVG_NEW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect id="bg" x="0" y="0" width="200" height="110" fill="#111"/><circle cx="90" cy="50" r="20" fill="#4C8DFF"/><polygon points="0,0 10,0 5,9"/></svg>';

test('SVG 对比面板：双 data:URI 图层/叠加框/模式钮/清洗不注入脚本', () => {
  const diff = buildSvgDiff(SVG_OLD, SVG_NEW);
  assert.ok(diff.ok);
  const html = renderToStaticMarkup(
    React.createElement(SvgComparePanel, {
      oldSvg: SVG_OLD, newSvg: SVG_NEW, diff,
      oldLabel: 'v1', newLabel: 'v2',
    })
  );
  assert.ok(html.includes('data-machine-svg-compare'));
  // 两版图层（基底层 + 上层）都以 data:URI <img> 呈现
  const imgCount = (html.match(/data:image\/svg\+xml/g) ?? []).length;
  assert.ok(imgCount >= 2);
  // sanitize：脚本内容不得原样出现在可执行形态（<script> 被剥离后编码）
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('data-machine-svg-overlays')); // units 已知 → 几何叠加层渲染
  assert.ok(html.includes('data-machine-svg-mode="onion"'));
  assert.ok(html.includes('data-machine-svg-mode="swipe"'));
  assert.ok(html.includes('叠影'));
  assert.ok(html.includes('擦除'));
  // 改动清单含三类徽标
  assert.ok(html.includes('[修改]'));
  assert.ok(html.includes('[新增]'));
  assert.ok(html.includes('data-machine-svg-changes'));
});

test('SVG 无坐标系：不渲染几何叠加层，诚实文字提示', () => {
  const oldSvg = '<svg><rect id="r" x="1" y="1" width="2" height="2"/></svg>';
  const newSvg = '<svg><rect id="r" x="1" y="1" width="3" height="2"/></svg>';
  const diff = buildSvgDiff(oldSvg, newSvg);
  assert.ok(diff.ok);
  const html = renderToStaticMarkup(
    React.createElement(SvgComparePanel, { oldSvg, newSvg, diff, oldLabel: 'v1', newLabel: 'v2' })
  );
  assert.ok(!html.includes('data-machine-svg-overlays'));
  assert.ok(html.includes('无法定位图元坐标'));
});

const CSV_OLD = ['物料,数量', '螺栓,100', '螺母,50'].join('\n');
const CSV_NEW = ['物料,数量', '螺栓,150', '平垫,20'].join('\n');

test('表格面板：变化格高亮/数值 Δ chip/增删行徽标/汇总 chips', () => {
  const result = buildTableDiff(CSV_OLD, CSV_NEW, ',');
  assert.ok(result.ok);
  const html = renderToStaticMarkup(
    React.createElement(TableDiffPanel, { result, format: 'csv' as const })
  );
  assert.ok(html.includes('data-machine-table-diff'));
  assert.ok(html.includes('data-machine-table-cell-changed'));
  assert.ok(html.includes('data-machine-table-delta')); // Δ+50
  assert.ok(html.includes('Δ+50'));
  assert.ok(html.includes('data-machine-table-row="added"'));
  assert.ok(html.includes('data-machine-table-row="removed"'));
  assert.ok(html.includes('1 行有变'));
  assert.ok(html.includes('数值变化 1 格'));
});

test('XLSX 面板：工作表 tab/新增删除名单/诚实拒绝文案', () => {
  const mk = (name: string, v: string) => ({
    sheets: [{
      name, index: 0, headers: ['名称', '数值'], row_count: 1, col_count: 2,
      numeric_summaries: [], truncated: false,
      rows: [{ row_num: 2, cells: [
        { ref_id: 'A2', col_idx: 0, value: '螺栓', is_numeric: false },
        { ref_id: 'B2', col_idx: 1, value: v, is_numeric: true },
      ] }],
    }],
    total_sheets: 1,
    truncated: false,
  });
  const diff = buildXlsxDiff(mk('报价', '100'), mk('报价', '180'));
  assert.ok(diff.ok);
  const html = renderToStaticMarkup(
    React.createElement(TableDiffPanel, { result: diff, format: 'xlsx' as const })
  );
  assert.ok(html.includes('data-machine-xlsx-diff'));
  assert.ok(html.includes('报价'));
  assert.ok(html.includes('Δ+80'));

  const refused = buildXlsxDiff(undefined, mk('报价', '100'));
  assert.equal(refused.ok, false);
  const refusedHtml = renderToStaticMarkup(
    React.createElement(TableDiffPanel, { result: refused, format: 'xlsx' as const })
  );
  assert.ok(refusedHtml.includes('诚实拒绝'));
  assert.ok(refusedHtml.includes('绝不以当前文件冒充历史版本'));
});
