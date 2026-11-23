/**
 * issue #27 —— 画布视口渲染与卡片物化验收测试：
 * - 包容器按视口 + 预留边距挂载（不再「每包限 6 卡但全渲染所有包」）；
 * - 焦点包即使出视口也保留挂载（选中态/叙事抽屉不断链）；
 * - 包间流向线只在两端都挂载时画（不产生指向空白的悬空线）；
 * - 卡片描述按包文档一次性物化，与节点位置无关（拖动不重建）；
 * - 组件契约：visible 门控渲染与派生计算、逐卡不再 files.find。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  buildCardDescriptors,
  DEFAULT_CULL_MARGIN_X,
  PACKAGE_GROUP_MAX_CARDS,
  shouldDrawGroupConnector,
  visiblePackageGroupIds,
} from '../src/utils/canvasViewport';

const __dirname = dirname(fileURLToPath(import.meta.url));
// D01-a 巨石拆层后，画布实现 = 薄装配层（GraphCanvasView）+ 行为控制器 + Scene 五分节——
// 组件契约断言读取联合文本（断言原文与语义不变，路径跟随拆分）。
const CANVAS_SRC = [
  'components/GraphCanvasView.tsx',
  'components/graph/useGraphCanvasController.tsx',
  'components/graph/GraphSceneLayer.tsx',
  'components/graph/GraphSceneBackdrop.tsx',
  'components/graph/GraphSceneTrunk.tsx',
  'components/graph/GraphSceneNodes.tsx',
  'components/graph/GraphSceneCards.tsx',
]
  .map((p) => readFileSync(join(__dirname, '..', 'src', p), 'utf8'))
  .join('\n');
const KNOWLEDGE_SRC = readFileSync(join(__dirname, '..', 'src', 'components', 'KnowledgeGraph.tsx'), 'utf8');

/** 造 n 个包：每个宽 300，间距 64，从 x=0 开始横排 */
function layoutsOf(n: number, width = 300, gap = 64) {
  const layouts = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    layouts.push({ pkgId: `pkg_${i}`, x, width });
    x += width + gap;
  }
  return layouts;
}

test('#27 视口裁剪：只挂载与「视口 + 边距」相交的包，其余不挂', () => {
  const layouts = layoutsOf(20); // 总宽 20*364 ≈ 7280
  const viewport = { x: 0, y: 0, width: 800, height: 600 };
  const ids = visiblePackageGroupIds(layouts, viewport, { focusPkgId: undefined });

  // 视口右界 800 + 边距 480 = 1280；pkg_0..pkg_3（x≤1092，右界 1392）之内
  assert.equal(ids.has('pkg_0'), true);
  assert.equal(ids.has('pkg_3'), true, '边距内的相邻包预挂载');
  assert.equal(ids.has('pkg_19'), false, '远端包不挂载');
  assert.ok(ids.size < layouts.length, `应裁掉大部分包，实际挂载 ${ids.size}/${layouts.length}`);
  assert.ok(ids.size >= 3, '近端包必须可见');
});

test('#27 视口裁剪：焦点包即使完全在视口外也保留', () => {
  const layouts = layoutsOf(20);
  // 视口在最左，焦点在很远的最右
  const viewport = { x: 0, y: 0, width: 400, height: 600 };
  const ids = visiblePackageGroupIds(layouts, viewport, { focusPkgId: 'pkg_19' });
  assert.equal(ids.has('pkg_19'), true, '焦点包必须挂载（否则选中态/抽屉目标消失）');
  assert.equal(ids.has('pkg_0'), true, '视口内包仍挂载');
});

test('#27 视口裁剪：视口跟随平移/缩放，滚动后挂载集合随之变化', () => {
  const layouts = layoutsOf(20);
  const left = visiblePackageGroupIds(layouts, { x: 0, y: 0, width: 600, height: 600 });
  const right = visiblePackageGroupIds(layouts, { x: 5000, y: 0, width: 600, height: 600 });
  assert.equal(left.has('pkg_0'), true);
  assert.equal(left.has('pkg_19'), false);
  // 20 包总宽 ≈7216：视口移到 x=5000 时，落在其附近的是 pkg_13（x≈4732）
  assert.equal(right.has('pkg_13'), true, '平移到右侧后该区间的包进入挂载集合');
  assert.equal(right.has('pkg_0'), false, '左侧包移出后卸载');
  assert.equal(right.has('pkg_0') || right.has('pkg_1') || right.has('pkg_2'), false);
});

test('#27 视口裁剪：视口尺寸未测量（width<=0）时保守全挂，不误裁', () => {
  const layouts = layoutsOf(5);
  const ids = visiblePackageGroupIds(layouts, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(ids.size, layouts.length, '尺寸未知时不裁剪（避免首帧空画布）');
});

test('#27 视口裁剪：disabled 关闭裁剪时全量挂载（小地图/对比口径）', () => {
  const layouts = layoutsOf(8);
  const ids = visiblePackageGroupIds(layouts, { x: 0, y: 0, width: 100, height: 100 }, {
    disabled: true,
  });
  assert.equal(ids.size, 8);
});

test('#27 连线段：只在两端都挂载时画，避免指向空白的悬空线', () => {
  const mounted = new Set(['pkg_a', 'pkg_b']);
  assert.equal(shouldDrawGroupConnector(undefined, 'pkg_a', mounted), false, '首包无前驱不画');
  assert.equal(shouldDrawGroupConnector('pkg_a', 'pkg_b', mounted), true, '两端都挂载');
  assert.equal(shouldDrawGroupConnector('pkg_a', 'pkg_c', mounted), false, '目标未挂载不画');
  assert.equal(shouldDrawGroupConnector('pkg_z', 'pkg_a', mounted), false, '前驱未挂载不画');
});

test('#27 卡片描述：按包一次性物化，同入参复用（拖动不重建的数据基础）', () => {
  const docs = [
    {
      fileId: 'f1',
      title: '方案 A',
      versionLabel: 'BUILD · v2',
      format: 'md',
      conclusion: '采用 A',
      bodyPreview: ['第一行', '第二行'],
      diffSections: [{ kind: '修改', title: '第二章' }],
      svgThumbDataUri: undefined,
    },
    {
      fileId: 'f2',
      title: '图纸 B',
      versionLabel: 'BUILD · v1',
      format: 'svg',
      conclusion: '图纸说明',
      svgThumbDataUri: 'data:image/svg+xml;utf8,x',
    },
  ];
  const layouts = [{ pkgId: 'pkg_a', shown: 2, docs }];

  const evolution = buildCardDescriptors(layouts, { evolutionView: true });
  const cards = evolution.get('pkg_a')!;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, '方案 A');
  assert.deepEqual(cards[0].diffSections, [{ kind: '修改', title: '第二章' }], '演进视图保留变更章节');
  assert.equal(cards[1].format, 'svg');

  // 版本视图：diffSections 不进入卡片（与旧渲染口径一致）
  const version = buildCardDescriptors(layouts, { evolutionView: false });
  assert.equal(version.get('pkg_a')![0].diffSections, undefined);

  // 同入参再算一次：内容相等（组件侧以 memo 复用，不逐帧重算）
  const again = buildCardDescriptors(layouts, { evolutionView: true });
  assert.deepEqual(again.get('pkg_a'), cards);
});

test('#27 卡片描述：按 shown 截断（每包上限沿用 PACKAGE_GROUP_MAX_CARDS）', () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    fileId: `f${i}`,
    title: `文档 ${i}`,
    versionLabel: `v${i}`,
    format: 'md',
    conclusion: `结论 ${i}`,
  }));
  const shown = Math.min(docs.length, PACKAGE_GROUP_MAX_CARDS);
  const map = buildCardDescriptors([{ pkgId: 'pkg_a', shown, docs }]);
  assert.equal(map.get('pkg_a')!.length, PACKAGE_GROUP_MAX_CARDS);
  assert.equal(PACKAGE_GROUP_MAX_CARDS, 6, '每包 6 卡上限保持');
});

test('#27 组件契约：画布按 visible 门控渲染与派生计算，逐卡不再线性查文件', () => {
  // 隐藏时早退（组件仍挂载，state 不丢；D01-a 拆层后早退在装配层，写法 props.visible）
  assert.match(
    CANVAS_SRC,
    /if \(!props\.visible\) return null;/,
    '隐藏时不应渲染整棵 SVG'
  );
  // 分组与卡片派生按 visible 门控
  assert.match(
    CANVAS_SRC,
    /visible \? buildCanvasPackageGroups\(files, events\) : \[\]/,
    '隐藏时跳过任务包分组构建'
  );
  // 共享 ID Map
  assert.match(CANVAS_SRC, /const fileById = useMemo\(/, '应有共享文件 ID Map');
  assert.match(
    CANVAS_SRC,
    /fileById\.get\(doc\.fileId\)/,
    '卡片应经 ID Map 取文件'
  );
  assert.doesNotMatch(
    CANVAS_SRC,
    /files\.find\(\(f\) => f\.file_id === doc\.fileId\)/,
    '卡片循环内不应再有线性 files.find'
  );
  // 视口裁剪接入渲染
  assert.match(CANVAS_SRC, /mountedPkgIds\.has\(group\.pkgId\)/, '渲染应按挂载集合裁剪');
  assert.match(CANVAS_SRC, /shouldDrawGroupConnector\(/, '连线应经纯函数判定');
  assert.match(CANVAS_SRC, /packageCardsByPkg\.get\(group\.pkgId\)/, '卡片取预建描述');
  // 视口裁剪默认边距
  assert.equal(DEFAULT_CULL_MARGIN_X > 0, true);
});

test('#27 组件契约：知识图谱把可见性透传给画布（隐藏常驻不再全量计算）', () => {
  assert.match(
    KNOWLEDGE_SRC,
    /<GraphCanvasView[^>]*visible=\{visible\}/s,
    'KnowledgeGraph 应透传 visible'
  );
});
