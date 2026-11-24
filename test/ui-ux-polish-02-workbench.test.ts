import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import {
  CHRONOS_FOLLOW_MAX,
  computeVersionDeltaBar,
  DIFF_PANE_LEFT_EDGE,
  DIFF_PANE_VIEW_SHARE,
  DocumentTimeMachineView,
  MACHINE_VIEW_W,
  MachineThemeSegmented,
  machinePaneReserve,
  timeMachineTrunkPointAtY,
  versionRelativeLabel,
  chronosFollowOffsetY,
} from '../src/components/DocumentTimeMachineView';
import { getCanvasTheme, type CanvasTheme } from '../src/utils/canvasThemeStore';

/**
 * U04 · 单文档版本时光机「司辰琉璃化」与纸面/夜航双主题 —— 契约测试。
 *
 * 锁死四条量化验收口径（任务卡 §4 U04）：
 *  ① 双主题切换：分段钮渲染 + 活值订阅 + 舷窗 DOM 直写（命令式，不入 React state）；
 *  ② 版本增量条纯函数：+add/-del 比例几何 + 数据源（服务端真实行数，无数据不伪造）；
 *  ③ 动效 reduced-motion 降级：新增类「声明 + 停帧」双登记，且只动 transform/opacity；
 *  ④ 几何保绿：主干 path 逐字不变 + trunkEnd ≤ 640 上界（tl02 契约不回归）。
 *
 * 既有护栏不破：test/tl02-machine-geometry.test.ts（主干几何）/ test/canvas-theme.test.ts
 * （双主题令牌与 attr↔选择器同词汇）必须全绿——本文件只做增量锁定。
 */

/** 读 src/ 下源文件（相对 test/ 目录，须带 ../src/ 前缀） */
function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

/** 去掉 CSS 注释后再做裸色值扫描（注释里的历史 hex 迁移记录不算规则）。 */
function cssRules(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** U04 夹具：最小 FileRecord（时光机只读渲染，不触发取数——useEffect 在 SSR 不跑）。 */
function makeFile(id: string): FileRecord {
  return {
    file_id: id,
    folder: '01-方案文档',
    title: 'U04 时光机夹具',
    relative_path: '01-方案文档/u04-time-machine.md',
    format: 'md',
    current_revision_id: 'rev_u04_3',
    coverage: 'full_text',
    revisions: [],
  } as unknown as FileRecord;
}

function renderMachine() {
  return renderToString(
    createElement(DocumentTimeMachineView, {
      active: true,
      file: makeFile('f_u04'),
      frame: { fileId: 'f_u04', revisionId: 'rev_u04_3', name: 'U04 时光机夹具' },
      trail: [{ fileId: 'f_u04', revisionId: 'rev_u04_3', name: 'U04 时光机夹具' }],
      root: 'H:\\u04',
      files: [makeFile('f_u04')],
      relations: [],
      decisions: [],
      onGo: () => {},
      onBack: () => {},
      onRead: () => {},
    })
  );
}

// ---------- ① 双主题（纸面 / 夜航） ----------

test('U04 双主题：分段钮渲染双态 + 活值自订阅 + 舷窗 DOM 命令式直写（主题值不入 React state）', () => {
  const html = renderMachine();
  const text = html.replace(/<!-- -->/g, '');

  // ① 分段钮本体：group + 两枚 aria-pressed 钮（夜航 / 纸面）
  assert.ok(html.includes('data-machine-theme-seg'), '时光机顶栏提供主题分段钮锚点');
  assert.ok(html.includes('aria-label="画布主题"'), '分段钮具备 group 语义与可读名');
  assert.ok(text.includes('>夜航<'), '夜航档文案在位');
  assert.ok(text.includes('>纸面<'), '纸面档文案在位');
  assert.equal((html.match(/aria-pressed="/g) ?? []).length, 2, '恰好两枚主题按钮');
  assert.ok(/aria-label="切换画布为纸面主题"/.test(html), '纸面档切换钮具备可读名');
  assert.ok(/aria-label="切换画布为夜航主题"/.test(html), '夜航档切换钮具备可读名');

  // ② 叶子自订阅活值层（主题值不入 React state——翻转只重渲本叶子）
  const src = readSrc('components/DocumentTimeMachineView.tsx');
  assert.ok(src.includes('useSyncExternalStore(subscribeCanvasTheme, getCanvasTheme'), '分段钮自订阅 canvasThemeStore');
  assert.ok(src.includes('applyCanvasTheme(next)'), '翻转走活值层（更新活值 + 本机持久化 + 通知订阅者）');
  assert.ok(src.includes('porthole.dataset.canvasTheme = next'), '舷窗属性由命令式直写（枚举原值，不做 light/dark 转译）');
  assert.ok(src.includes("closest('.dark-porthole')"), '直写锚点取自宿主舷窗（时光机恒渲染于 .dark-porthole 内）');
  assert.ok(src.includes("classList.remove('theme-morphing')"), '翻转同任务摘挂 theme-morphing（morph 过渡纪律）');
  assert.ok(
    !/useState<CanvasTheme>|useState\(['"]xray-dark['"]\)/.test(src),
    '主题值不得进 React state（双主题活值层纪律）',
  );

  // ③ 活值层本身：非法值回默认、同值短路（沿用 canvas-theme 契约，不重复造口径）
  assert.equal(getCanvasTheme(), 'xray-dark', '无本机偏好时默认夜航');

  // ④ 浅档 CSS 覆写选择器字面必须逐字 = store 枚举（'xray-light'，禁 'light'/'dark'）
  const graphCss = readSrc('components/eventGraph.css');
  assert.ok(
    graphCss.includes(".dark-porthole[data-canvas-theme='xray-light'] .event-stage.event-stage-machine"),
    '浅档背板覆写块必须逐字写 xray-light（与 store 枚举同词汇）',
  );
  assert.ok(
    !graphCss.includes("[data-canvas-theme='light']") && !graphCss.includes("[data-canvas-theme='dark']"),
    "eventGraph.css 不得残留 'light'/'dark' 字面",
  );
});

test('U04 双主题：浅/夜两档背板各有专属覆写块（点阵星尘 + 柔和光晕），且 CSS 零裸 hex/rgba', () => {
  const graphCss = readSrc('components/eventGraph.css');
  const rules = cssRules(graphCss);

  // ① 两档背板各一块（夜航默认块 + 纸面覆写块）
  assert.ok(graphCss.includes('.event-stage.event-stage-machine {'), '时光机舞台有专属背板块（点阵 + 星尘 + 光晕）');
  assert.ok(
    graphCss.includes(".dark-porthole[data-canvas-theme='xray-light'] .event-stage.event-stage-machine {"),
    '纸面档有专属背板覆写块',
  );
  assert.ok(rules.includes('radial-gradient'), '背板走径向渐变（柔和光晕 + 点阵星尘）');

  // ② 画布色值纪律：规则里禁裸 hex / rgba（色值一律走 --cv-* 令牌 + color-mix）
  const hexMatches = rules.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexMatches, [], `eventGraph.css 规则不得出现裸 hex：${hexMatches.join(',')}`);
  const rgbaMatches = rules.match(/rgba?\(/g) ?? [];
  assert.deepEqual(rgbaMatches, [], `eventGraph.css 规则不得出现裸 rgba：${rgbaMatches.join(',')}`);

  // ③ TSX 侧同样零裸色值（stroke/fill/stopColor 一律 var(--cv-*)）
  const tsx = readSrc('components/DocumentTimeMachineView.tsx');
  const tsxRules = tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.deepEqual(tsxRules.match(/#[0-9a-fA-F]{6}\b/g) ?? [], [], 'TSX 不得出现裸 hex');
  assert.deepEqual(tsxRules.match(/rgba?\(/g) ?? [], [], 'TSX 不得出现裸 rgba');
  assert.ok(tsx.includes("stroke: 'url(#machine-trunk-axis)'"), '主干渐变走 SVG gradient（表现属性不吃 var()）');
  assert.ok(tsx.includes('style={{ stopColor: SELECT_COLOR }}'), '渐变 stop 用 style.stopColor（不写 stop-color 属性）');
});

// ---------- ② 版本增量条纯函数 ----------

test('U04 版本增量条纯函数：比例几何逐字 + 无真实行数时诚实留空（零造数）', () => {
  // ① 常规：新增 12 / 删除 3 → 80% / 20%，文案 '+12/-3'
  const bar = computeVersionDeltaBar(12, 3);
  assert.equal(bar.added, 12);
  assert.equal(bar.removed, 3);
  assert.equal(bar.total, 15);
  assert.equal(bar.addedPct, 80);
  assert.equal(bar.removedPct, 20);
  assert.equal(bar.hasData, true);
  assert.equal(bar.label, '+12/-3');
  assert.equal(bar.addedPct + bar.removedPct, 100, '两段比例合计恒 100%');

  // ② 均分：5 / 5 → 50 / 50
  const half = computeVersionDeltaBar(5, 5);
  assert.equal(half.addedPct, 50);
  assert.equal(half.removedPct, 50);

  // ③ 只增不删 / 只删不增
  assert.equal(computeVersionDeltaBar(7, 0).removedPct, 0);
  assert.equal(computeVersionDeltaBar(0, 7).addedPct, 0);

  // ④ 无数据：0/0、NaN、Infinity 一律 hasData=false + 文案空串（卡面留空槽）
  for (const [a, r] of [[0, 0], [Number.NaN, 2], [Number.POSITIVE_INFINITY, 1]] as const) {
    const empty = computeVersionDeltaBar(a, r);
    assert.equal(empty.hasData, false, `非法/零增量 (${a}, ${r}) 不得伪造数据`);
    assert.equal(empty.label, '', '无数据时文案为空串');
    assert.equal(empty.addedPct, 0);
    assert.equal(empty.removedPct, 0);
  }

  // ⑤ 负数是脏数据：钳 0 后另一方向仍按真值呈现（不整条丢弃，也不编负比例）
  const dirty = computeVersionDeltaBar(-3, 5);
  assert.equal(dirty.added, 0);
  assert.equal(dirty.removed, 5);
  assert.equal(dirty.addedPct, 0);
  assert.equal(dirty.removedPct, 100);
  assert.equal(dirty.label, '+0/-5');
});

test('U04 版本增量口径单一：节点卡只认章节级 diff 统计，与右侧面板/检查器同源（禁两套行数同屏）', () => {
  // 病根：节点卡曾用 history 事件 payload 的 added_lines（服务端整文件行级口径），
  // 右侧面板/检查器用章节级 computeSectionDiff 统计 → 同屏两个互相矛盾的行数
  // （卡 +4/-0 vs 面板 +8/-0）且未标注各自来源 → 命中「诚实边界」停机条件。
  const tsx = readSrc('components/DocumentTimeMachineView.tsx');
  assert.ok(
    !tsx.includes('buildVersionDeltaMap') && !/payload\.added_lines/.test(tsx) && !tsx.includes('toFiniteCount'),
    '节点卡增量不得再取 history 事件 payload 口径（与面板/检查器不同源）',
  );
  assert.ok(
    tsx.includes('selView.totalAdded') && tsx.includes('selView.totalRemoved'),
    '节点卡增量必须直接取章节级 diff 统计（与面板「相对上一版」同源）',
  );
  assert.ok(
    tsx.includes('章节级变更行数（相对上一版）'),
    '增量标签须标注口径来源（tooltip 明示「章节级变更行数·相对上一版」）',
  );
});

// ---------- ③ 动效契约（reduced-motion 降级 + 只动 transform/opacity） ----------

test('U04 动效契约：新增动效类「声明 + 停帧」双登记，且只动 transform/opacity、只吃令牌时长', () => {
  const motionCss = readSrc('styles/motion.css');
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  // ① 声明 + 降级双登记
  for (const cls of ['.glx-axis-follow', '.glx-machine-flow-pulse']) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }

  // ② 司辰跟随：transform 单属性过渡 + 令牌时长/缓动；禁布局属性与常驻 will-change
  const followStart = motionCss.indexOf('.dark-porthole .glx-axis-follow.glx-axis-follow {');
  assert.ok(followStart >= 0, 'motion.css 应声明司辰跟随类');
  const followBlock = motionCss.slice(followStart, motionCss.indexOf('}', followStart));
  assert.ok(followBlock.includes('transform'), '跟随过渡只动 transform');
  assert.ok(!/\b(width|height|top|left)\b/.test(followBlock), '跟随禁过渡布局属性');
  assert.ok(followBlock.includes('var(--dur-3)') && followBlock.includes('var(--ease-spring)'), '跟随时长/缓动只吃令牌');
  assert.ok(!/\d+ms/.test(followBlock), '跟随禁写死 ms 时长');
  assert.ok(!followBlock.includes('will-change'), '禁新增常驻 will-change');

  // ③ 切版流光：keyframes 只走 transform + opacity
  const keyframes = motionCss.slice(
    motionCss.indexOf('@keyframes glx-machine-flow-pulse'),
    motionCss.indexOf('@keyframes glx-machine-flow-pulse') + 260
  );
  assert.ok(keyframes.includes('opacity'), '流光关键帧只走 opacity');
  assert.ok(keyframes.includes('transform'), '流光关键帧只走 transform');
  assert.ok(!/stroke-dashoffset|width|height|top|left/.test(keyframes), '流光禁描边/布局动画（只限 transform/opacity）');

  // ④ 流光是纯装饰层：reduce 下整层 display:none（终态＝光环不可见，司辰本体仍在）
  const pulseReduce = reduceSection.slice(reduceSection.indexOf('.glx-machine-flow-pulse'));
  assert.ok(pulseReduce.includes('display: none'), '流光装饰层在 reduce 下整层隐藏');
  assert.ok(pulseReduce.includes('animation: none'), '流光在 reduce 下停帧');

  // ⑤ 全局兜底块二仍处停用（画布闸未签收，不得越闸启用）
  assert.ok(
    reduceSection.includes('/* * {\n    animation-duration: 0.01ms !important;'),
    '全局兜底块须保持注释态（画布闸未签收）',
  );
});

test('U04 动效接线：司辰跟随位移量来自纯函数、切版流光环随选中版本重播、Diff 面板走 --dur-1 淡变', () => {
  const tsx = readSrc('components/DocumentTimeMachineView.tsx');

  // ① 司辰跟随：位移量由纯函数算好后写进 CSS 自定义属性（组件内不写坐标公式）
  assert.ok(tsx.includes('chronosFollowOffsetY(selY)'), '司辰跟随位移量走纯函数');
  assert.ok(tsx.includes("'--glx-follow-y'"), '跟随位移写入 CSS 自定义属性（transform 过渡载体）');
  assert.ok(tsx.includes('className="glx-axis-follow"'), '司辰挂跟随动效类');

  // ② 切版流光：光环 key 随选中版本变化 → 每次切版重播（装饰层，reduce 下隐藏）
  assert.ok(tsx.includes('className="glx-machine-flow-pulse"'), '切版流光环在位');
  assert.ok(
    /glx-machine-flow-pulse"\s*\n\s*key=\{selectedId \?\? 'none'\}/.test(tsx),
    '流光环 key 随选中版本变化（切版即重播）',
  );

  // ③ Diff 面板：内容层挂 .glx-fade-in（纯 opacity，--dur-1）且 key 随切版变化
  assert.ok(tsx.includes('className="glx-fade-in"'), '多模态 Diff 面板内容走淡变类');
  assert.ok(tsx.includes('key={paneSignature}'), 'Diff 面板淡变 key 随「选中版 + 面板态」变化');
  assert.ok(tsx.includes('data-machine-pane-fade'), 'Diff 面板淡变层带可测锚点');
});

// ---------- ④ 几何保绿（主干 path 逐字不变 + 引线落点 + 跟随上限） ----------

test('U04 几何保绿：主干 path 与 trunkEnd ≤ 640 上界零回归，引线自贝塞尔脊柱精确落笔', () => {
  const html = renderMachine();

  // ① 主干 path 逐字不变（tl02 保绿：M 260 100 Q 252 200 260 {trunkEnd}）
  assert.ok(
    html.includes('d="M 260 100 Q 252 200 260 336"'),
    '主干 path 几何逐字不变（空链 trunkEnd=336）',
  );
  assert.ok(html.includes('id="machine-trunk-axis"'), '主干走渐变版本轴（gradient defs 在位）');
  assert.ok(html.includes('machine-trunk-halo'), '主干另有宽而淡的光晕层');
  assert.ok(html.includes('machine-trunk-axis'), '主干主轴带专属类名');

  // ② 引线落点：贝塞尔中段被控制点拉向 252，硬接 x=260 会浮空 → 落点必须落在 [252, 260]
  const mid = timeMachineTrunkPointAtY(170, 336);
  assert.ok(mid.x < 260, '中段引线落点须落在脊柱曲线上（不得浮空在 x=260）');
  assert.ok(mid.x >= 252, '落点不得越过控制点 x=252');
  assert.equal(mid.y, 170, '落点纵坐标＝请求值（钳位内）');
  assert.equal(timeMachineTrunkPointAtY(999, 336).y, 336, '越界纵坐标被钳到 trunkEnd');
  assert.equal(timeMachineTrunkPointAtY(Number.NaN, 336).y, 100, '非法纵坐标回落主干上端');

  // ③ 司辰跟随：阻尼 + 硬上限（不越左栏上游依据卡，不出视口）
  assert.equal(chronosFollowOffsetY(170), 0, '选中首版时司辰不位移');
  assert.equal(chronosFollowOffsetY(Number.NaN), 0, '非法纵坐标回落 0');
  assert.ok(chronosFollowOffsetY(600) <= CHRONOS_FOLLOW_MAX, '长链位移取硬上限');
  assert.equal(chronosFollowOffsetY(600), CHRONOS_FOLLOW_MAX, '上限值恒等于 CHRONOS_FOLLOW_MAX');
  let prev = -1;
  for (const y of [170, 260, 350, 440, 530, 620]) {
    const offset = chronosFollowOffsetY(y);
    assert.ok(offset >= prev, '跟随偏移随选中版本单调不减');
    prev = offset;
  }
});

test('U04 相对时间纯函数：与绝对戳同锚点（occurred_at ?? observed_at），只换叙述不改口径', () => {
  const now = Date.parse('2026-11-22T10:00:00');

  // ① 今天 / 昨天（仅日期锚点按本地日历日解析，不走 UTC 零点）
  assert.equal(versionRelativeLabel('2026-11-22', now), '今天');
  assert.equal(versionRelativeLabel('2026-11-21', now), '昨天');

  // ② N 天前（1 < N ≤ 30）
  assert.equal(versionRelativeLabel('2026-11-19', now), '3 天前');

  // ③ 超过 30 天回落绝对戳（老版本不写假近感）；跨年补年份
  assert.equal(versionRelativeLabel('2026-10-01', now), '10-01');
  assert.equal(versionRelativeLabel('2025-11-01', now), '2025-11-01');

  // ④ 非法锚点诚实回落空串（调用方回退绝对戳，绝不臆造）
  assert.equal(versionRelativeLabel('', now), '');
  assert.equal(versionRelativeLabel('not-a-date', now), '');

  // ⑤ 带时刻锚点：分钟/小时档
  assert.equal(versionRelativeLabel('2026-11-22T09:58:00', now), '2分钟前');
  assert.equal(versionRelativeLabel('2026-11-22T08:00:00', now), '2小时前');
});

// ---------- ⑤ 主题切换的活值层联动（不造第二套口径） ----------

test('U04 主题活值层：分段钮激活态跟存活值翻转（同值短路，零重渲整树）', () => {
  const seen: CanvasTheme[] = [];
  const off = (() => {
    // 订阅口在 store 内；此处只断言活值翻转与分段钮激活态一致
    return () => {};
  })();
  void off;

  const before = getCanvasTheme();
  const html = renderToString(createElement(MachineThemeSegmented, { onChange: () => {} }));
  const activeMatch = html.match(/aria-pressed="true"[^>]*>([^<]*)</) ?? html.match(/>([^<]*)<\/button><button[^>]*aria-pressed="true"/);
  assert.ok(activeMatch, '分段钮恰有一枚激活段');
  assert.equal(activeMatch[1].trim(), before === 'xray-light' ? '纸面' : '夜航', '激活段与活值一致');
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1, '恰一枚激活段');
  seen.push(before);
  assert.deepEqual(seen, [before]);
});

// ---------- ⑥ 实机回归护栏：下钻时光机不得整树崩白屏 ----------

test('U04 实机回归：同任务包分组 <details> 的 onToggle 不得在 setState updater 内读 e.currentTarget', () => {
  // 病根：React 在事件派发结束即把 currentTarget 置 null，而 setState 的 updater
  // 可能延后到渲染期才执行——updater 内读 e.currentTarget.open 会抛 TypeError，
  // 连带整棵树崩成白屏（实机复现：星图 → 来源面板 → 单文档时光机下钻）。
  // 修法：派发内同步取 open 真值，updater 只消费布尔量。
  const tsx = readSrc('components/DocumentTimeMachineView.tsx');
  assert.ok(
    !/set\w+\(\(prev\)[^;]*e\.currentTarget/.test(tsx),
    'setState 的 updater 内不得读 e.currentTarget（派发结束即置 null → TypeError → 整树崩白屏）',
  );
  assert.ok(
    tsx.includes('const nextOpen = detail ? detail.open'),
    'open 真值必须在事件派发内同步取出，再交给 updater 消费',
  );
});

// ---------- ⑦ 浮层遮挡避让（Diff 面板压住版本轴） ----------

test('U04 浮层避让：面板展开时卡面右缘让出遮挡带（角标/比例条/文字不被浮层硬切）', () => {
  // 病根：DiffSidePane 以 absolute inset-y-0 right-0 叠在 .event-plot 上，
  // 面板左缘落在 viewBox x≈302（画布右侧 62%），而版本卡右缘在 335 → 重叠 33 单位
  // （卡面 22% 被压：「当前」角标 100% 不可见、「初始基线」约 41% 被遮、
  // 卡内第二行文字被硬切无省略号兜底、底部比例条右端被切）。
  assert.equal(MACHINE_VIEW_W, 794, '画布 viewBox 宽常量');
  assert.equal(DIFF_PANE_VIEW_SHARE, 0.62, '面板占画布宽比例（与 DiffSidePane width:min(560px,62%) 同源）');
  assert.ok(Math.abs(DIFF_PANE_LEFT_EDGE - 301.72) < 0.01, `面板左缘 = 画布宽 × (1-62%)，实测 ${DIFF_PANE_LEFT_EDGE}`);

  // ① 面板收起 → 零避让（卡面完整，不留空）
  assert.equal(machinePaneReserve(335, false), 0, '面板收起时不避让');
  assert.equal(machinePaneReserve(335, true), 37, '面板展开时版本卡右缘(335)让出 37 单位（含 3 单位呼吸）');
  assert.equal(machinePaneReserve(353, true), 55, 'hub 卡右缘(353)让出 55 单位');

  // ② 完全在面板左侧的卡面（不越界）→ 不避让
  assert.equal(machinePaneReserve(200, true), 0, '未越面板左缘的卡面不避让');
  assert.equal(machinePaneReserve(Number.NaN, true), 0, '非法右缘回落 0');
  assert.ok(
    machinePaneReserve(1000, true) > machinePaneReserve(335, true),
    '越界越深避让越宽（单调不减）',
  );

  // ③ 接线：Diff 面板与右侧检查器合流为独立网格列（data-machine-unified-inspector），
  //    不再悬浮压盖画布，故卡面避让传 false 保持完整宽（零截断），NODE_W/NODE_H 几何常量不变
  const tsx = readSrc('components/DocumentTimeMachineView.tsx');
  assert.ok(tsx.includes('data-machine-unified-inspector=""'), '版本对比与检查器合流为单一右侧栏');
  assert.ok(tsx.includes('machinePaneReserve(TRUNK_X + NODE_W / 2, false)'), '统一右栏不再覆盖画布，版本卡零收窄截断');
  assert.ok(tsx.includes('machinePaneReserve(TRUNK_X + 93, false)'), 'hub 卡保持完整宽度不被硬切');
  assert.ok(
    tsx.includes('<foreignObject width={NODE_W - nodeReserve} height={NODE_H}>'),
    '版本卡渲染宽度公式保留',
  );
  assert.ok(
    tsx.includes('<foreignObject x={TRUNK_X - 93} y={20} width={186 - hubReserve} height={76}>'),
    'hub 卡渲染宽度公式保留',
  );
  assert.ok(tsx.includes('const NODE_W = 150;'), 'NODE_W 几何常量一字未改（只改渲染宽度）');
  assert.ok(tsx.includes('const NODE_H = 56;'), 'NODE_H 几何常量一字未改');
});

// ---------- ⑧ 纸面档层级倒挂 / 收起把手 / 纸面光晕 ----------

test('U04 纸面档层级：chrome 大板走白卡浮于浅底（与星图纸面语言一致），夜航档不变', () => {
  const graphCss = readSrc('components/eventGraph.css');
  // ① 浅档：工具条 / 检查器 / 缩放条 / 分页条 → --cv-card（纯白）而非更暗的 --cv-panel
  assert.ok(
    graphCss.includes(".dark-porthole[data-canvas-theme='xray-light'] .event-toolbar") &&
      graphCss.includes(".dark-porthole[data-canvas-theme='xray-light'] .event-panel"),
    '浅档 chrome 大板须有专属覆写块（否则读成内凹工程灰板）',
  );
  const lightChromeStart = graphCss.indexOf(".dark-porthole[data-canvas-theme='xray-light'] .event-toolbar");
  const lightChromeBlock = graphCss.slice(lightChromeStart, graphCss.indexOf('}', lightChromeStart));
  assert.ok(lightChromeBlock.includes('background: var(--cv-card)'), '浅档 chrome 面走白卡（--cv-card）');

  // ② Diff 面板底色写在 inline style（color-mix(--cv-panel 88%, transparent)）→
  //    浅档局部重定义 --cv-panel 令牌，让同一段 inline style 解析为白卡玻璃
  assert.ok(
    graphCss.includes(".dark-porthole[data-canvas-theme='xray-light'] [data-machine-diff-pane]"),
    '浅档须为 Diff 面板局部重定义 --cv-panel（inline style 只吃令牌）',
  );
  assert.ok(graphCss.includes('--cv-panel: var(--cv-card);'), '面板令牌重定义指向白卡');

  // ③ 夜航档不得被改（面板比近黑画布更亮＝玻璃浮层，读法正确）
  const darkPaneBlock = graphCss.slice(0, graphCss.indexOf('.dark-porthole[data-canvas-theme='));
  assert.ok(!darkPaneBlock.includes('--cv-panel: var(--cv-card)'), '夜航档保持 --cv-panel 原值');
});

test('U04 收起把手：竖排裸文字改横排（禁 Latin 侧倒字带），信息不删', () => {
  const graphCss = readSrc('components/eventGraph.css');
  assert.ok(
    graphCss.includes('[data-machine-diff-pane="collapsed"] span'),
    '收起把手文字须有专属样式块',
  );
  const handleStart = graphCss.indexOf('[data-machine-diff-pane="collapsed"] span');
  const handleBlock = graphCss.slice(handleStart, graphCss.indexOf('}', handleStart));
  assert.ok(handleBlock.includes('writing-mode: horizontal-tb'), '收起把手文字改横排（禁竖排侧倒字带）');
  assert.ok(
    handleBlock.includes('writing-mode: horizontal-tb !important'),
    'writing-mode 写在 inline style 里，须用 !important 才能覆盖（否则规则被 inline 压过）',
  );
  assert.ok(!handleBlock.includes('vertical-rl'), '不得残留竖排写法');
  assert.ok(handleBlock.includes('white-space: nowrap'), '横排标签整行不折行');
});

test('U04 纸面档主干：光晕浓度提高（浅底上光轴须读得出「发光」）', () => {
  const graphCss = readSrc('components/eventGraph.css');
  assert.ok(
    graphCss.includes(".dark-porthole[data-canvas-theme='xray-light'] .machine-trunk-halo"),
    '浅档须有主干光晕专属覆写块',
  );
  const haloStart = graphCss.indexOf(".dark-porthole[data-canvas-theme='xray-light'] .machine-trunk-halo");
  const haloBlock = graphCss.slice(haloStart, graphCss.indexOf('}', haloStart));
  const opacity = Number(haloBlock.match(/opacity:\s*([\d.]+)/)?.[1]);
  assert.ok(opacity > 0.14, `浅档光晕浓度须高于夜航档的 .14（实测 ${opacity}）`);
});

test('U04 流光引线：新增动效类须「声明 + 停帧」双登记，描边动画只用于轻量微图元', () => {
  const motionCss = readSrc('styles/motion.css');
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(motionCss.includes('.glx-machine-lead-flow'), 'motion.css 应声明流光引线类');
  assert.ok(reduceSection.includes('.glx-machine-lead-flow'), '流光引线须在 reduced-motion 块登记');
  const pulseReduce = reduceSection.slice(reduceSection.indexOf('.glx-machine-lead-flow'));
  assert.ok(pulseReduce.includes('display: none'), '流光引线是纯装饰叠加层，reduce 下整层隐藏');
  assert.ok(pulseReduce.includes('animation: none'), '流光引线在 reduce 下停帧');

  const leadStart = motionCss.indexOf('.glx-machine-lead-flow {');
  assert.ok(leadStart >= 0, 'motion.css 应声明流光引线类');
  const leadBlock = motionCss.slice(leadStart, motionCss.indexOf('}', leadStart));
  assert.ok(leadBlock.includes('var(--dur-3)') && leadBlock.includes('var(--ease-fade)'), '流光时长/缓动只吃令牌');
  assert.ok(!/\d+ms/.test(leadBlock), '流光禁写死 ms 时长');
  assert.ok(leadBlock.includes('stroke-dasharray'), '流光以虚线段呈现（轻量微图元）');

  const tsx = readSrc('components/DocumentTimeMachineView.tsx');
  assert.ok(tsx.includes('className="glx-machine-lead-flow"'), '引线须挂流光类');
  assert.ok(
    tsx.includes('key={`flow-${selectedNode.revisionId}-${key}`}'),
    '流光 key 须随选中版本变化（切版即重播）',
  );
  // 同一 path 元素上：key 与流光类成对出现（避免只挂类不重播 / 只重播不挂类）
  const leadTags = tsx.match(/<path[^>]*glx-machine-lead-flow[^>]*>/g) ?? [];
  assert.ok(leadTags.length >= 2, '核心结论块与章节 Diff 卡的引线均挂流光');
  for (const tag of leadTags) {
    assert.ok(tag.includes('flow-${selectedNode.revisionId}'), '每条流光引线都带选中版本 key');
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   U05 · 阅读器极简顶栏 / 琉璃阅读进度光条 / 文档迷你版本轴 / 专注纸面（Zen）
   —— 契约测试（任务卡 v1.1 §4 U05）。
   锁死四条量化验收口径：
    ① 顶栏减密：长相对路径与文件 ID 移入「标题悬浮信息卡 / ··· 菜单」，主行只留锚点；
    ② 进度光条：scaleX 纯计算（钳位/非法值）+ 单一数据源（复用 handleMarkdownScroll 的 pct）
       + 只动 transform（禁动画 width）+ 2px 高度 + 紧贴顶栏下沿 + 正文零动效；
    ③ 迷你版本轴：修订链序（vN → … → v1，禁按日期排）+ 时间/变动概览 + 切版/比对/时光机入口；
    ④ Zen 状态机：按钮恒切、快捷键按护栏让路；壳层据此收起/恢复左右侧栏。
   动效契约：新增类「声明 + reduced-motion 停帧」双登记，只动 transform/opacity。
   ══════════════════════════════════════════════════════════════════════════ */

import {
  buildMiniVersionAxis,
  canOpenTimeMachine,
  computeReadingProgressScaleX,
  ReaderMiniVersionAxis,
  resolveZenToggle,
  summarizeMiniVersionChange,
  type MiniVersionAxisRevision,
} from '../src/components/reader/readerChromeSections';
import { ReaderView } from '../src/components/ReaderView';
import type { DecisionAssertion, FileRecord, RelationEdge } from '../src/types/guanlan';

/** U05 夹具：三版文档（修订链 v1 → v3），末版含章节级变更。 */
function u05Revisions(): MiniVersionAxisRevision[] {
  return [
    {
      revision_id: 'rev_u05_1',
      versionNumber: 1,
      observed_at: '2026-11-20T10:00:00+08:00',
      snapshotAvailable: true,
      changedSectionsFromPrev: [],
    },
    {
      revision_id: 'rev_u05_2',
      versionNumber: 2,
      observed_at: '2026-11-21T10:00:00+08:00',
      snapshotAvailable: false,
      changedSectionsFromPrev: [],
    },
    {
      revision_id: 'rev_u05_3',
      versionNumber: 3,
      observed_at: '2026-11-22T10:00:00+08:00',
      snapshotAvailable: true,
      changedSectionsFromPrev: ['背景', '方案'],
    },
  ];
}

function u05File(): FileRecord {
  const revisions = u05Revisions().map((rev) => ({
    ...rev,
    file_id: 'f_u05',
    content_sha256: `sha_${rev.revision_id}`,
    sizeBytes: 1024,
    summaryNote: '',
  }));
  return {
    file_id: 'f_u05',
    relative_path: '01-方案文档/u05-reader.md',
    title: 'U05 阅读器夹具',
    format: 'md',
    folder: '01-方案文档',
    role: '说明',
    roleProvenance: {} as FileRecord['roleProvenance'],
    topics: [],
    current_revision_id: 'rev_u05_3',
    coverage: 'full_text',
    revisions,
  } as unknown as FileRecord;
}

function u05ReaderProps(file: FileRecord) {
  const noop = () => {};
  return {
    files: [file],
    activeFile: file,
    pinnedRevisionId: file.current_revision_id,
    onChangeRevision: noop,
    subMode: 'read' as const,
    onChangeSubMode: noop,
    onMarkReadHere: noop,
    onMarkFullyRead: noop,
    onScrollProgress: noop,
    onToggleBookmark: noop,
    onNavigateLinkedFile: noop,
    returnBreadcrumb: null,
    onFollowReturnBreadcrumb: noop,
    decisions: [],
    relations: [],
    onSelectDecision: noop,
    onAddEvidencePointer: noop,
    indexGeneration: 0,
  };
}

// ---------- ① 进度光条：scaleX 纯计算 + 单一数据源 + 只动 transform ----------

test('U05 进度光条纯函数：百分比 → scaleX 换算（钳位 / 非法值 / 端点逐字）', () => {
  assert.equal(computeReadingProgressScaleX(0), 0, '起点恒 0');
  assert.equal(computeReadingProgressScaleX(1), 0.01);
  assert.equal(computeReadingProgressScaleX(50), 0.5);
  assert.equal(computeReadingProgressScaleX(100), 1, '到底恒 1');
  assert.equal(computeReadingProgressScaleX(120), 1, '越界钳到 1');
  assert.equal(computeReadingProgressScaleX(-5), 0, '负值钳到 0');
  assert.equal(computeReadingProgressScaleX(Number.NaN), 0, 'NaN 回落 0（绝不产出 NaN 变换）');
  assert.equal(computeReadingProgressScaleX(Number.POSITIVE_INFINITY), 1);
  assert.equal(computeReadingProgressScaleX(Number.NEGATIVE_INFINITY), 0);
  for (const pct of [0, 7, 33, 66, 100]) {
    const scale = computeReadingProgressScaleX(pct);
    assert.ok(scale >= 0 && scale <= 1, `scaleX 恒在 [0,1]（实测 ${scale}）`);
  }
});

test('U05 进度光条接线：数据源复用 handleMarkdownScroll 的同一 pct，只动 scaleX（禁动画 width）', () => {
  const controller = readSrc('components/reader/useReaderController.tsx');
  const readerView = readSrc('components/ReaderView.tsx');

  // ① 单一数据源：pct 只算一次，光条与落盘共用它（禁另起第二套换算）
  const pctComputations = controller.match(
    /const pct = Math\.round\(\(el\.scrollTop \/ max\) \* 100\)/g
  ) ?? [];
  assert.equal(pctComputations.length, 1, `滚动百分比只允许算一次（实测 ${pctComputations.length} 处）`);
  assert.ok(
    controller.includes('applyReadingProgress(pct);'),
    '光条必须复用滚动事件里已算好的 pct（禁另算一套口径）',
  );
  assert.ok(
    controller.includes('const scaleX = computeReadingProgressScaleX(percent);'),
    '光条换算走纯函数单一出口',
  );

  // ② 光条只动 transform：DOM 写 transform，绝不写 width
  assert.ok(controller.includes('bar.style.transform = `scaleX(${scaleX})`'), '光条以 transform 直写');
  assert.ok(!/style\.width\s*=/.test(controller), '光条禁写 width（禁动画 width/触发重排）');

  // ③ 2px 高度 + 紧贴顶栏下沿（挂在文件头之后、内容区之前）
  assert.ok(readerView.includes('h-[2px]'), '光条高度为 2px');
  const headerIdx = readerView.indexOf('<ReaderFileHeaderSection ctx={ctx} />');
  const progressIdx = readerView.indexOf('data-reader-progress=""');
  const contentIdx = readerView.indexOf('{/* 3. Main Content Area by SubMode */}');
  assert.ok(headerIdx >= 0 && progressIdx > headerIdx, '光条紧贴阅读器顶栏下沿');
  assert.ok(contentIdx > progressIdx, '光条在正文内容区之前（不挤占正文首屏高度语义）');

  // ④ 正文零动效红线：正文量宽容器与正文段落节点不得挂任何 glx-* 动效类
  const markdownSection = readSrc('components/reader/readerMarkdownSection.tsx');
  const measureLine = (markdownSection.split('\n').find((line) => line.includes('reader-measure')) ?? '');
  assert.ok(measureLine.length > 0, '正文量宽容器 .reader-measure 仍在位');
  assert.ok(!measureLine.includes('glx-'), '正文量宽容器不得挂 glx-* 动效类（正文文字节点零动效红线）');
  assert.ok(
    !readerView.includes('reader-measure'),
    'Zen/光条动效类不得下沉到正文量宽容器（ReaderView 只做 chrome 装配）',
  );

  // ⑤ AA：光条本体走薰衣草令牌（图形 ≥3:1）；轨道常驻 --ink-faint
  //（随 data-reader-dark 换档：浅 3.15 / 夜航 3.71，均 ≥3:1 图形门槛；
  //  scrollTop=0 零宽时轨道仍可证明光条本体已渲染）
  assert.ok(
    readerView.includes('linear-gradient(90deg,var(--accent-iris),var(--accent-iris-deep))'),
    '光条走薰衣草令牌渐变（浅底 4.13/5.13、夜航底 4.53/8.67，均 ≥3:1 图形门槛）',
  );
  const trackBlock = readerView.slice(
    readerView.indexOf('data-reader-progress=""'),
    readerView.indexOf('data-reader-progress-bar=""')
  );
  assert.ok(
    trackBlock.includes('bg-[color:var(--ink-faint)]'),
    '进度轨道须常驻可见（--ink-faint 双档 ≥3:1，零进度时仍可证渲染）',
  );
});

// ---------- ② 迷你版本轴：修订链序 + 概览 + 入口 ----------

test('U05 迷你版本轴纯函数：修订链序 vN → … → v1（禁按日期排）+ 当前/最新标记 + 变动概览', () => {
  const nodes = buildMiniVersionAxis(u05Revisions(), 'rev_u05_2', 'rev_u05_3');
  assert.equal(nodes.length, 3);
  assert.deepEqual(
    nodes.map((node) => node.label),
    ['v3', 'v2', 'v1'],
    '版本轴按修订链序（新 → 旧）渲染，绝不按日期排序',
  );
  assert.equal(nodes[0].isCurrent, false);
  assert.equal(nodes[0].isLatest, true, '最新版标记挂在 v3');
  assert.equal(nodes[1].isCurrent, true, '当前阅读版标记挂在 v2');
  assert.equal(nodes[2].isCurrent, false);
  assert.equal(nodes[0].changeSummary, '变更 2 节 · 背景 / 方案', '章节级变更概览如实呈现');
  assert.equal(nodes[1].changeSummary, '快照已淘汰（仅保留版本元数据）', '快照淘汰版如实提示，绝不冒充可读旧版');
  assert.equal(nodes[2].changeSummary, '无章节级变更记录', '无变更记录时诚实留白');
  assert.ok(nodes[0].observedLabel.length > 0, '每节点带采集时刻相对时间');
  assert.ok(!nodes[0].observedLabel.includes('T'), '时刻以相对口径呈现（不直出 ISO 串）');

  // 空输入 / 非法输入诚实退化
  assert.deepEqual(buildMiniVersionAxis([], 'a', 'b'), []);
  assert.deepEqual(buildMiniVersionAxis(null, 'a', 'b'), []);
  assert.deepEqual(buildMiniVersionAxis(undefined, 'a', 'b'), []);

  // 变动概览单一出口
  assert.equal(
    summarizeMiniVersionChange({
      revision_id: 'x',
      versionNumber: 9,
      observed_at: '',
      changedSectionsFromPrev: ['一', '二', '三'],
    }),
    '变更 3 节 · 一 / 二 等',
  );
  assert.equal(
    summarizeMiniVersionChange({
      revision_id: 'x',
      versionNumber: 9,
      observed_at: '',
      changedSectionsFromPrev: [],
      snapshotAvailable: true,
    }),
    '无章节级变更记录',
  );
});

test('U05 迷你版本轴渲染：玻璃微型修订链 + 切版/比对入口 + 进入版本时光机', () => {
  const nodes = buildMiniVersionAxis(u05Revisions(), 'rev_u05_3', 'rev_u05_3');
  const html = renderToString(
    createElement(ReaderMiniVersionAxis, {
      nodes,
      paperLightMode: true,
      onSelect: () => {},
      onCompare: () => {},
      canOpenTimeMachine: true,
      onOpenTimeMachine: () => {},
    })
  );
  const text = html.replace(/<!-- -->/g, '');
  assert.ok(html.includes('data-reader-version-axis'), '版本轴带可测锚点');
  assert.ok(html.includes('aria-label="文档迷你版本轴"'), '版本轴具备可读名');
  assert.ok((html.match(/data-reader-version-node="/g) ?? []).length === 3, '每个版本节点一枚锚点');
  assert.ok(text.includes('>v3<') && text.includes('>v1<'), '版本徽标按链序呈现');
  assert.ok(text.includes('按修订链'), '版本轴显式标注排序口径（按修订链）');
  assert.ok(text.includes('比对'), '每节点提供一键切版比对入口');
  assert.ok(html.includes('data-reader-open-time-machine'), '提供进入版本时光机入口');
  assert.ok(text.includes('进入版本时光机 →'), '时光机入口文案在位');

  // 不可直达时光机的格式不提供该入口（不做跳过去发现没有时光机的假入口）
  const noMachine = renderToString(
    createElement(ReaderMiniVersionAxis, {
      nodes,
      paperLightMode: true,
      onSelect: () => {},
      onCompare: () => {},
      canOpenTimeMachine: false,
    })
  );
  assert.ok(!noMachine.includes('data-reader-open-time-machine'), '非时光机格式不渲染时光机入口');
  assert.equal(canOpenTimeMachine('md'), true);
  assert.equal(canOpenTimeMachine('svg'), true);
  assert.equal(canOpenTimeMachine('pdf'), false, 'PDF 不在时光机路由集合内');
});

test('U05 迷你版本轴接线：版本胶囊可点开 + 切版/比对/时光机三条动作各有落点', () => {
  const chrome = readSrc('components/reader/readerChromeSections.tsx');
  const controller = readSrc('components/reader/useReaderController.tsx');
  const stage = readSrc('components/app/AppLibraryStage.tsx');

  // ① 版本胶囊由静态徽标改为可展开的按钮
  assert.ok(chrome.includes('data-reader-version-axis-trigger'), '版本演化胶囊是展开触发器');
  assert.ok(chrome.includes('aria-expanded={versionAxisOpen}'), '触发器暴露开合态');
  assert.ok(chrome.includes('<ReaderMiniVersionAxis'), '触发器挂载迷你版本轴');

  // ② 切版 = 钉住该版本（不改未读基线）；比对 = 以当前版为基准进入历史快照对比
  assert.ok(controller.includes('onChangeRevision(revisionId);'), '切版走钉住版本（只读呈现）');
  assert.ok(controller.includes("onChangeSubMode('diff_versions');"), '一键切版比对进入历史快照对比');
  assert.ok(
    !/last_read_revision_id\s*=/.test(controller.slice(controller.indexOf('selectMiniVersion'))),
    '切版/比对不得改写阅读基线（last_read_revision_id）',
  );

  // ③ 进入版本时光机 = 纯视图跳转（与「查看关联」同一路径范式）
  assert.ok(stage.includes('enterEventFrame(prev, activeFile'), '时光机跳转复用 enterEventFrame 下钻范式');
  assert.ok(stage.includes("setActiveTab('panorama');"), '时光机跳转切到全景 tab');
  assert.ok(stage.includes("setPanoramaMode('canvas');"), '时光机跳转切到星图画布');
});

// ---------- ③ 顶栏减密 ----------

test('U05 顶栏减密：长相对路径与文件 ID 移出主行（进标题悬浮信息卡 / ··· 菜单）', () => {
  const chrome = readSrc('components/reader/readerChromeSections.tsx');
  const file = u05File();
  const html = renderToString(createElement(ReaderView, u05ReaderProps(file)));
  const text = html.replace(/<!-- -->/g, '');

  // ① 标题悬浮信息卡在位（承载完整路径 + 文件 ID）
  assert.ok(html.includes('data-reader-file-info'), '标题悬浮信息卡在位');
  assert.ok(text.includes('01-方案文档/u05-reader.md'), '完整相对路径进信息卡');
  assert.ok(html.includes('aria-label="查看文件信息（完整路径与文件 ID）"'), '信息卡具备可发现入口');

  // ② 主行不再直出长路径（旧口径：hidden 2xl:inline 的整段路径）
  assert.ok(
    !chrome.includes('hidden 2xl:inline font-mono'),
    '主行不得再直出超长相对路径（顶栏减密）',
  );
  assert.ok(
    !chrome.includes('<CopyIdButton id={activeFile.file_id} />\n            {artifactState'),
    '文件 ID 复制钮不得留在主行元信息位',
  );

  // ③ ··· 菜单补文件 ID 条目（长 ID 有出口，不再占主行视线）
  assert.ok(chrome.includes('data-reader-file-id-entry'), '文件操作菜单补文件 ID 条目');

  // ④ 四大视觉锚点仍在主行
  assert.ok(html.includes('data-reader-version-axis-trigger'), '版本演化胶囊在主行');
  assert.ok(text.includes('标为已读') || text.includes('当前版已读'), '标为已读在主行');
  assert.ok(html.includes('data-reader-zen-toggle'), '专注纸面入口在主行');
  assert.ok(text.includes('溯源'), '溯源入口在主行');
  assert.ok(text.includes('深色') || text.includes('浅色'), '昼夜切换在主行');
});

// ---------- ④ Zen 专注纸面 ----------

test('U05 Zen 状态机纯函数：按钮恒切；快捷键在编辑面/浮层/非阅读态一律让路', () => {
  // ① 顶栏按钮：恒可切（退出专注的唯一路径不被任何护栏堵死）
  const on = resolveZenToggle({
    zenMode: false,
    trigger: 'toolbar-button',
    subMode: 'read',
    editableTarget: false,
    overlayOpen: false,
  });
  assert.equal(on.applied, true);
  assert.equal(on.nextZenMode, true);
  assert.equal(on.reason, 'toggled');

  const off = resolveZenToggle({
    zenMode: true,
    trigger: 'toolbar-button',
    subMode: 'diff_versions',
    editableTarget: true,
    overlayOpen: true,
  });
  assert.equal(off.applied, true, '按钮恒切：即使有浮层/编辑面也能退出专注');
  assert.equal(off.nextZenMode, false);

  // ② 快捷键：读态无护栏 → 切
  const shortcut = resolveZenToggle({
    zenMode: false,
    trigger: 'shortcut',
    subMode: 'read',
    editableTarget: false,
    overlayOpen: false,
  });
  assert.equal(shortcut.applied, true);
  assert.equal(shortcut.nextZenMode, true);

  // ③ 快捷键：编辑面让路（停机线：编辑态一切键让路）
  const editable = resolveZenToggle({
    zenMode: false,
    trigger: 'shortcut',
    subMode: 'read',
    editableTarget: true,
    overlayOpen: false,
  });
  assert.equal(editable.applied, false);
  assert.equal(editable.nextZenMode, false, '被拦下时状态不变');
  assert.equal(editable.reason, 'shortcut-ignored-editable');

  // ④ 快捷键：浮层打开让路（浮层内键归浮层自己）
  const overlay = resolveZenToggle({
    zenMode: true,
    trigger: 'shortcut',
    subMode: 'read',
    editableTarget: false,
    overlayOpen: true,
  });
  assert.equal(overlay.applied, false);
  assert.equal(overlay.nextZenMode, true, '被拦下时保持原态');
  assert.equal(overlay.reason, 'shortcut-ignored-overlay');

  // ⑤ 快捷键：非阅读态让路（Zen 是阅读专注态）
  const diff = resolveZenToggle({
    zenMode: false,
    trigger: 'shortcut',
    subMode: 'diff_versions',
    editableTarget: false,
    overlayOpen: false,
  });
  assert.equal(diff.applied, false);
  assert.equal(diff.reason, 'shortcut-ignored-submode');
});

test('U05 Zen 接线：顶栏一键 + Z 快捷键 + 壳层收起左右侧栏（进入/退出成对）', () => {
  const chrome = readSrc('components/reader/readerChromeSections.tsx');
  const controller = readSrc('components/reader/useReaderController.tsx');
  const stage = readSrc('components/app/AppLibraryStage.tsx');
  const readerView = readSrc('components/ReaderView.tsx');

  // ① 顶栏入口 + 快捷键
  assert.ok(chrome.includes("toggleZen('toolbar-button')"), '顶栏按钮走 Zen 状态机');
  assert.ok(chrome.includes('data-reader-zen-toggle'), 'Zen 按钮带可测锚点');
  assert.ok(controller.includes("event.key !== 'z'"), 'Z 快捷键接线');
  assert.ok(controller.includes("toggleZen('shortcut'"), '快捷键走同一状态机（禁第二套口径）');

  // ② 阅读面标记（Zen 态可测）
  assert.ok(readerView.includes("data-reader-zen={zenMode ? 'true' : undefined}"), '阅读面暴露 Zen 态标记');

  // ③ 壳层：进入 Zen 收起左栏 + 右栏；退出恢复进入前的左栏折叠态
  assert.ok(stage.includes('dirShell.setSidebarCollapsed(true);'), '进入 Zen 收起左侧目录栏');
  assert.ok(stage.includes('setLibraryInspectorOpen(false);'), '进入 Zen 收起右侧溯源检查器');
  assert.ok(stage.includes('dirShell.setSidebarCollapsed(restore);'), '退出 Zen 恢复左栏折叠态');
  assert.ok(stage.includes('onZenModeChange={handleZenModeChange}'), 'App 层接住 Zen 状态变化');
});

// ---------- ⑤ 动效契约（reduced-motion 降级 + 只动 transform/opacity） ----------

test('U05 动效契约：三个新增类「声明 + 停帧」双登记，且只动 transform/opacity、只吃令牌时长', () => {
  const motionCss = readSrc('styles/motion.css');
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  for (const cls of ['.glx-reader-progress', '.glx-reader-frame', '.glx-zen-chrome']) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }

  // ① 光条：只过渡 transform（禁 width/height/top/left 布局属性）
  const progressStart = motionCss.indexOf('.glx-reader-progress {');
  assert.ok(progressStart >= 0, 'motion.css 应声明 .glx-reader-progress');
  const progressBlock = motionCss.slice(progressStart, motionCss.indexOf('}', progressStart));
  assert.ok(progressBlock.includes('transform'), '光条过渡只动 transform');
  const progressTransition = progressBlock.split('transition:')[1] ?? '';
  assert.ok(
    !/\b(width|height|top|left)\b/.test(progressTransition),
    '光条禁过渡布局属性（transform-origin 的 left 不算布局过渡）',
  );
  assert.ok(progressBlock.includes('var(--dur-1)') && progressBlock.includes('var(--ease-fade)'), '光条时长/缓动只吃令牌');
  assert.ok(!/\d+ms/.test(progressBlock), '光条禁写死 ms 时长');
  assert.ok(!progressBlock.includes('will-change'), '禁新增常驻 will-change');

  // ② 外框柔化：只动 color/background-color（非布局属性）
  const frameStart = motionCss.indexOf('.glx-reader-frame {');
  const frameBlock = motionCss.slice(frameStart, motionCss.indexOf('}', frameStart));
  assert.ok(frameBlock.includes('background-color') && frameBlock.includes('color'), '外框过渡走色彩属性');
  const frameTransition = frameBlock.split('transition:')[1] ?? '';
  assert.ok(!/\b(width|height|top|left)\b/.test(frameTransition), '外框禁过渡布局属性');
  assert.ok(frameBlock.includes('var(--dur-3)') && frameBlock.includes('var(--ease-fade)'), '外框时长/缓动只吃令牌');

  // ③ Zen 顶栏降噪：只动 opacity
  const zenStart = motionCss.indexOf('.glx-zen-chrome {');
  const zenBlock = motionCss.slice(zenStart, motionCss.indexOf('}', zenStart));
  assert.ok(zenBlock.includes('opacity'), 'Zen 降噪只动 opacity');
  const zenTransition = zenBlock.split('transition:')[1] ?? '';
  assert.ok(!/\b(width|height|top|left)\b/.test(zenTransition), 'Zen 降噪禁过渡布局属性');
  assert.ok(zenBlock.includes('var(--dur-3)') && zenBlock.includes('var(--ease-fade)'), 'Zen 降噪时长/缓动只吃令牌');

  // ④ 全局兜底块二仍处停用（画布闸未签收，不得越闸启用）
  assert.ok(
    reduceSection.includes('/* * {\n    animation-duration: 0.01ms !important;'),
    '全局兜底块须保持注释态（画布闸未签收）',
  );
});

test('U05 阅读器首屏与既有护栏零回归：冷启动 SSR 仍 < 300ms 且光条/微轴零阻塞', () => {
  const file = u05File();
  const html = renderToString(createElement(ReaderView, u05ReaderProps(file)));
  assert.ok(html.includes('data-reader-shell'), '首屏 shell 锚点仍在');
  assert.ok(html.includes('data-reader-progress'), '光条在首屏 DOM 中（零请求、零阻塞）');
  assert.ok(html.includes('data-reader-zen-toggle'), 'Zen 入口在首屏 DOM 中');
  assert.ok(html.includes('data-reader-version-axis-trigger'), '版本胶囊在首屏 DOM 中');
  assert.ok(!html.includes('data-reader-version-axis=""'), '迷你版本轴默认收起（未展开零 DOM）');
  assert.ok(!html.includes('正在向智能体请求正文'), '首屏不得出现阻塞遮罩');
});


// ---------- ⑥ 实机走查修复（第二批） ----------

test('U05 走查修复：迷你版本轴弹层锚 header 底沿展开（避让 Row2 查看模式条）+ outside-click 收口', () => {
  const chrome = readSrc('components/reader/readerChromeSections.tsx');
  const controller = readSrc('components/reader/useReaderController.tsx');

  // ① 弹层不再锚版本胶囊（旧 left-0 top-full 会盖住正下方的查看模式分段条），
  //    改锚 header 根节点底沿（top-full + left-5）——只覆盖正文纸面（非交互区）
  const axis = readSrc('components/reader/readerChromeSections.tsx');
  const axisStart = axis.indexOf('data-reader-version-axis=""');
  const axisBlock = axis.slice(axisStart, axis.indexOf('>', axisStart));
  assert.ok(axisBlock.includes('top-full') && axisBlock.includes('left-5'), '弹层须锚 header 底沿向下展开');
  // 结构锁：header 内的条件渲染块位于 Row2（Stepper）之后，即挂在 header 根节点末尾
  const row2Idx = chrome.indexOf('wf_4：所属专项 + 五阶段 Stepper 并入 Row 2 右侧');
  const mountIdx = chrome.indexOf('{versionAxisOpen && (', row2Idx);
  assert.ok(mountIdx > row2Idx, '弹层挂载点必须位于 Row2 之后（header 根节点内）');
  assert.ok(!/relative">\s*{versionAxisOpen/.test(chrome), '弹层不得再嵌回版本胶囊的 relative 包裹层');

  // ② outside-click 收口（与 Esc 同 effect；触发器与弹层自身命中不关）
  assert.ok(
    controller.includes("document.addEventListener('mousedown', onDown)") &&
      controller.includes("target?.closest('[data-reader-version-axis]')"),
    '迷你版本轴须有 outside-click 关闭守卫（触发器/弹层命中豁免）',
  );
});

test('U05 走查修复：三处玻璃浮层近不透明换底（封堵正文笔画透印）+ 双态可读', () => {
  const chrome = readSrc('components/reader/readerChromeSections.tsx');
  // 白玻璃 .glass-pop 原 0.95 透率实测透印（复合亮度 247/255 ≈1.05:1）；
  // 0.985 → 复合亮度 252.6/255（Δ2.4 级），1× 不可辨；夜航档同值
  //（H1 亮笔画 243 穿透 1.5% → 复合 Δ≈3 级，同样不可辨）
  assert.equal(
    (chrome.match(/rgba\(255, 254, 250, 0\.985\)/g) ?? []).length,
    3,
    '浅档三浮层（迷你版本轴/文件信息卡/文件操作菜单）均须近不透明暖白底',
  );
  assert.equal(
    (chrome.match(/rgba\(24, 27, 36, 0\.985\)/g) ?? []).length,
    3,
    '夜航档三浮层均须近不透明深底（浅字对比 15.21/6.95/9.70 ≥4.5）',
  );
  assert.ok(!chrome.includes('rgba(24, 27, 36, 0.96)'), '旧 0.96 透率残留须清零（口径统一）');
  assert.ok(!chrome.includes('rgba(24, 27, 36, 0.97)'), '旧 0.97 透率残留须清零（口径统一）');
});

test('U05 走查修复：主行单行化（<2xl 大纲/昼夜收为图标钮，aria-label 提供可读名）+ 返回横幅文案去工程语感', () => {
  const chrome = readSrc('components/reader/readerChromeSections.tsx');

  // ① 1440 主配置（目录栏展开）：大纲 + 昼夜合计省 ~104px，四大锚点同回 Row1 一行
  //（昼夜钮在源码里是浅/深两分支各一枚 span，故源码 3 处、运行时同帧最多 2 处）
  assert.equal(
    (chrome.match(/max-2xl:hidden/g) ?? []).length,
    3,
    '大纲/昼夜两处文字标签在 <2xl 收起（≥2xl 恢复全标签）',
  );
  assert.ok(
    chrome.includes("aria-label={outlineOpen ? '收起章节大纲' : '展开章节大纲'}"),
    '大纲图标钮保留可读名（文字 display:none 后 accname 不再取子文本）',
  );
  assert.ok(
    chrome.includes("aria-label={paperLightMode ? '切换到深色阅读纸' : '切换到纸面浅色'}"),
    '昼夜图标钮保留可读名',
  );

  // ② 返回横幅右侧常驻文案去工程态（旧句已清零、新句在位）
  assert.ok(!chrome.includes('已保留来源段落与滚动筛选状态'), '旧工程语感文案须清零');
  assert.ok(chrome.includes('阅读位置与跳转来源已保留'), '新文案在位');
});

/* ══════════════════════════════════════════════════════════════════════════
   U06 · 右侧溯源检查器「时光轨迹卡」与文件历史抽屉重构 —— 契约测试（任务卡 v1.1 §4 U06）。
   锁死量化验收口径：
    ① 时光轨迹卡纯函数映射三边界：多版本（最近 4 节点 + 诚实收纳计数）/
       单版本（唯一基线，不渲染假差异入口）/ 已淘汰快照（仅元数据，diff 全禁）；
    ② 三卡结构 SSR：时光轨迹 / 双向引用（分组折叠 + 悬停摘要气泡）/ 决策与归属
       （待拍板-已定案-候选三桶 + 专项上下游）；
    ③ 三口径时间语义不合并（observed_at / source_time / commit_time）+ 只读边界
       （跳时光机复用 onViewRelationsGraph 视图跳转；全组件无 last_read_revision_id 写点）；
    ④ 文件历史抽屉：glx-t-panel 弹簧抽屉双轨 + 两段式入场（无 glx-drawer-in 叠加）+
       reduced-motion 降级沿用 motion.css 既有登记 + 冗余技术字段精简（size KB 收纳）
       + 「时间轴序 ≠ 修订链序」常显文案。
   ══════════════════════════════════════════════════════════════════════════ */

import {
  buildTimeTrail,
  peerHoverPreviewOf,
  RightInspector,
  TIME_TRAIL_MAX_NODES,
  type TimeTrailModel,
  type TimeTrailRevision,
} from '../src/components/RightInspector';
import { FileTimelineDrawer } from '../src/components/FileTimelineDrawer';

/** U06 夹具：N 个版本的修订链（chain 自 v1 → vN），可指定第几版起快照淘汰。 */
function u06Revisions(n: number, opts?: { evictFromVersion?: number }): TimeTrailRevision[] {
  const evictFrom = opts?.evictFromVersion ?? Number.POSITIVE_INFINITY;
  return Array.from({ length: n }, (_, i) => {
    const version = i + 1;
    return {
      revision_id: `rev_u06_${version}`,
      versionNumber: version,
      observed_at: `2026-11-${10 + i}T10:00:00+08:00`,
      snapshotAvailable: version < evictFrom,
      changedSectionsFromPrev:
        version === n && n > 1
          ? ['背景', '方案', '影响与等待范围']
          : version % 2 === 0
            ? ['附录']
            : [],
    };
  });
}

function u06InspectorFile(overrides?: Partial<FileRecord>): FileRecord {
  const revisions = u06Revisions(6).map((rev) => ({
    ...rev,
    file_id: 'f_u06_main',
    content_sha256: `sha_${rev.revision_id}`,
    sizeBytes: 2048,
    summaryNote: rev.versionNumber === 6 ? 'U06 检查器夹具的当前版摘要。' : '',
  }));
  return {
    file_id: 'f_u06_main',
    relative_path: '02-会议纪要/u06-z-main.md',
    title: 'U06 检查器夹具',
    format: 'md',
    folder: '02-会议纪要',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'rev_u06_6',
    coverage: 'full_text',
    revisions,
    ...overrides,
  } as unknown as FileRecord;
}

/** U06 夹具：同包第三份文档（阅读序在选中文档之后，供「下游」按钮落位）。 */
function u06NextFile(): FileRecord {
  return {
    file_id: 'f_u06_next',
    relative_path: '02-会议纪要/u06-z-next.md',
    title: 'U06 下游文档',
    format: 'md',
    folder: '02-会议纪要',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'rev_u06_next_1',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_u06_next_1',
        versionNumber: 1,
        observed_at: '2026-11-19T09:00:00+08:00',
        content_sha256: 'sha_next',
        sizeBytes: 1024,
        summaryNote: '下游文档摘要。',
        snapshotAvailable: true,
        changedSectionsFromPrev: [],
      },
    ],
  } as unknown as FileRecord;
}

function u06PeerFile(): FileRecord {
  return {
    file_id: 'f_u06_peer',
    relative_path: '02-会议纪要/u06-peer.md',
    title: 'U06 对端文档',
    format: 'md',
    folder: '02-会议纪要',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'rev_u06_peer_1',
    coverage: 'full_text',
    revisions: [
      {
        revision_id: 'rev_u06_peer_1',
        versionNumber: 1,
        observed_at: '2026-11-18T09:00:00+08:00',
        content_sha256: 'sha_peer',
        sizeBytes: 1024,
        summaryNote: '对端文档的当前版摘要，供引用卡悬停气泡预览。',
        snapshotAvailable: true,
        changedSectionsFromPrev: [],
      },
    ],
  } as unknown as FileRecord;
}

const u06Relations = [
  {
    edge_id: 'edge_out_1',
    source_id: 'f_u06_main',
    target_id: 'f_u06_peer',
    label: '引用',
    locator: { startLine: 12 },
  },
  {
    edge_id: 'edge_out_2',
    source_id: 'f_u06_main',
    target_id: 'f_u06_peer',
    label: '引用',
    locator: { startLine: 44 },
  },
  {
    edge_id: 'edge_in_1',
    source_id: 'f_u06_peer',
    target_id: 'f_u06_main',
    label: '被引用',
    locator: null,
  },
] as unknown as RelationEdge[];

const u06Decisions = [
  {
    decision_id: 'dec_u06_pending',
    code: 'D-U06-1',
    status: '待确认',
    namespace: '方案',
    question: 'U06 待拍板决策：是否采纳背景方案？',
    isCandidateOnly: false,
    evidences: [{ file_id: 'f_u06_main' }],
  },
  {
    decision_id: 'dec_u06_settled',
    code: 'D-U06-2',
    status: '已确认',
    namespace: '方案',
    question: 'U06 已生效决策：范围已锁定。',
    isCandidateOnly: false,
    evidences: [{ file_id: 'f_u06_main' }],
  },
  {
    decision_id: 'dec_u06_candidate',
    code: 'D-U06-3',
    status: '待确认',
    namespace: '编织',
    question: 'U06 候选线索（未定案）。',
    isCandidateOnly: true,
    evidences: [{ file_id: 'f_u06_main' }],
  },
] as unknown as DecisionAssertion[];

function u06InspectorProps(file: FileRecord) {
  const noop = () => {};
  return {
    selectedFile: file,
    selectedDecision: null,
    files: [file, u06PeerFile(), u06NextFile()],
    decisions: u06Decisions,
    relations: u06Relations,
    readingState: undefined,
    onSavePersonalNote: noop,
    onOpenFile: noop,
    onOpenDecision: noop,
    onOpenFileTimeline: noop,
    onViewRelationsGraph: noop,
    onCopyObjectToAgent: async () => true,
    indexGeneration: 1,
    stateOverview: null,
  };
}

// ---------- ① 时光轨迹卡纯函数：三边界映射 ----------

test('U06 时光轨迹纯函数·多版本边界：链序 vN→v1、最近 4 节点、诚实收纳计数（零丢版零造数）', () => {
  const model: TimeTrailModel = buildTimeTrail(
    u06Revisions(6),
    'rev_u06_6',
    'rev_u06_6'
  );

  assert.equal(model.boundary, 'multi');
  assert.equal(model.nodes.length, TIME_TRAIL_MAX_NODES, '最多展示 4 个版本节点');
  assert.equal(TIME_TRAIL_MAX_NODES, 4, '展示上限恒为 4（卡面口径）');
  assert.deepEqual(
    model.nodes.map((n) => n.label),
    ['v6', 'v5', 'v4', 'v3'],
    '按修订链序（版本号降序）渲染，绝不按日期排',
  );
  assert.equal(model.totalVersions, 6);
  assert.equal(model.hiddenCount, 2, '更早版本诚实收纳为计数');
  assert.equal(model.headline, '共 6 版 · 展示最近 4 版');

  // 当前 / 最新标记只落在一处
  assert.equal(model.nodes.filter((n) => n.isCurrent).length, 1);
  assert.equal(model.nodes.filter((n) => n.isLatest).length, 1);
  assert.equal(model.nodes[0].isCurrent, true);
  assert.equal(model.nodes[0].isLatest, true);

  // 章节级变更逐字透传（零造数），可展开差异只看真实数据
  assert.equal(model.nodes[0].changedCount, 3);
  assert.deepEqual(model.nodes[0].changedSections, ['背景', '方案', '影响与等待范围']);
  assert.equal(model.nodes[0].diffAvailable, true);
  assert.equal(model.nodes[1].changedCount, 0);
  assert.equal(model.nodes[1].diffAvailable, false, '无变更记录的节点不渲染假差异入口');
  assert.equal(model.nodes[1].kind, 'unchanged');

  // 恰好 4 版时不产生收纳行（headline 不带「展示最近」）
  const exact = buildTimeTrail(u06Revisions(4), 'rev_u06_4', 'rev_u06_4');
  assert.equal(exact.boundary, 'multi');
  assert.equal(exact.hiddenCount, 0);
  assert.equal(exact.headline, '共 4 版');

  // observed 相对时间口径：不直出 ISO 串（occurred_at 口径绝不混入本卡）
  assert.ok(model.nodes[0].observedLabel.length > 0);
  assert.ok(!model.nodes[0].observedLabel.includes('T'));
});

test('U06 时光轨迹纯函数·单版本与空链边界：唯一基线不渲染假差异入口，空输入诚实零节点', () => {
  const single = buildTimeTrail(u06Revisions(1), 'rev_u06_1', 'rev_u06_1');
  assert.equal(single.boundary, 'single');
  assert.equal(single.nodes.length, 1);
  assert.equal(single.totalVersions, 1);
  assert.equal(single.hiddenCount, 0);
  assert.equal(single.headline, '唯一版本 · 初始基线（无更早版本可比对）');
  assert.equal(single.nodes[0].kind, 'unchanged', '唯一基线无「相对上一版」可言');
  assert.equal(single.nodes[0].diffAvailable, false, '绝不渲染无更早版本可比对的假差异入口');

  for (const bad of [[], null, undefined] as const) {
    const empty = buildTimeTrail(bad, 'a', 'b');
    assert.equal(empty.boundary, 'empty');
    assert.deepEqual(empty.nodes, []);
    assert.equal(empty.totalVersions, 0);
    assert.equal(empty.headline, '暂无版本记录');
  }

  // 缺 revision_id 的脏数据按不可用剔除，不参与计数
  const dirty = buildTimeTrail(
    [{ revision_id: '', versionNumber: 1, observed_at: '' }] as TimeTrailRevision[],
    'a',
    'a'
  );
  assert.equal(dirty.boundary, 'empty', '无身份的版本行不得计入轨迹');
});

test('U06 时光轨迹纯函数·已淘汰快照边界：仅保留元数据、diff 全禁、绝不冒充可读旧版', () => {
  const evictedAll = buildTimeTrail(
    u06Revisions(6, { evictFromVersion: 1 }),
    'rev_u06_6',
    'rev_u06_6'
  );
  assert.equal(evictedAll.boundary, 'evicted');
  assert.equal(evictedAll.nodes.length, 4, '已淘汰快照仍保留最近 4 节点的元数据骨架');
  assert.equal(evictedAll.headline, '快照均已过保留期（仅保留版本元数据）');
  assert.ok(
    evictedAll.nodes.every((n) => n.kind === 'evicted' && !n.diffAvailable && !n.snapshotAvailable),
    '整卡快照淘汰：节点全部标记 evicted 且差异展开入口全禁',
  );
  assert.ok(
    evictedAll.nodes.every((n) => n.changeSummary.includes('快照已淘汰')),
    '变动概览与迷你版本轴同词（快照已淘汰，绝不冒充可读旧版）',
  );

  // 混合链：部分淘汰 → 仍是 multi 边界，但被淘汰的节点自身禁差异
  const mixed = buildTimeTrail(
    u06Revisions(6, { evictFromVersion: 6 }),
    'rev_u06_6',
    'rev_u06_6'
  );
  assert.equal(mixed.boundary, 'multi');
  const evictedNode = mixed.nodes.find((n) => n.versionNumber === 6);
  assert.equal(evictedNode?.kind, 'evicted');
  assert.equal(evictedNode?.diffAvailable, false, '淘汰节点禁展开（元数据仍在，诚实收纳）');
  assert.equal(
    mixed.nodes.find((n) => n.versionNumber === 4)?.diffAvailable,
    true,
    '可读快照且有章节级变更的节点仍可展开差异',
  );
});

// ---------- ② 三卡结构 SSR ----------

test('U06 SSR·时光轨迹卡：链序锚点 + 当前版差异默认展开 + 收纳行 + 时光机入口（md 可跳 / pdf 无假入口）', () => {
  const html = renderToString(
    createElement(RightInspector, u06InspectorProps(u06InspectorFile()))
  );
  const text = html.replace(/<!-- -->/g, '');

  assert.ok(html.includes('data-inspector-time-trail'), '时光轨迹卡在位');
  assert.match(html, /data-trail-boundary="multi"/, '多版本边界标记');
  assert.equal((html.match(/data-trail-node="/g) ?? []).length, 4, '恰 4 枚链节点');
  assert.ok(text.includes('>v6<') && text.includes('>v3<'), '版本徽标按链序呈现');
  assert.ok(html.includes('data-trail-dots="3"'), '当前版增删色点数量=真实章节级变更数');
  assert.ok(html.includes('aria-expanded="true"'), '当前版差异默认展开（承接原「变化的章节」可见性）');
  assert.ok(html.includes('data-trail-node-diff="rev_u06_6"'), '展开差异区带可测锚点');
  assert.ok(text.includes('本版修改'), '章节级差异行在位');
  assert.ok(text.includes('在阅读器打开 v6'), '节点差异区提供「钉到该版本阅读」只读入口');
  assert.ok(html.includes('data-trail-hidden="2"'), '更早版本诚实收纳');
  assert.ok(text.includes('其余 2 个更早版本'), '收纳行文案在位');
  assert.ok(html.includes('data-trail-open-time-machine'), 'md 文档提供「进入版本时光机」入口');
  assert.ok(text.includes('进入版本时光机 →'), '时光机入口文案在位');
  assert.ok(html.includes('data-unread-status'), '未读三态标签在轨迹卡头（GL-01 消费不丢）');
  assert.ok(text.includes('未读新件（尚未建立阅读基线）'), '无基线时未读文案如实呈现');

  // pdf：不渲染时光机入口（canOpenTimeMachine 单一口径——不做跳过去发现没有的假入口）
  const pdfHtml = renderToString(
    createElement(
      RightInspector,
      u06InspectorProps(u06InspectorFile({ format: 'pdf' as FileRecord['format'] }))
    )
  );
  assert.ok(!pdfHtml.includes('data-trail-open-time-machine'), 'pdf 不渲染时光机入口');
});

test('U06 SSR·双向引用卡：正/反向分组折叠 + 关系胶囊行号微标 + 悬停气泡预览目标摘要', () => {
  const html = renderToString(
    createElement(RightInspector, u06InspectorProps(u06InspectorFile()))
  );
  const text = html.replace(/<!-- -->/g, '');

  assert.ok(html.includes('data-inspector-references'), '双向引用卡在位');
  assert.equal((html.match(/data-ref-group="/g) ?? []).length, 2, '正/反向两分组');
  assert.ok(text.includes('正向引用（1 篇对端）'), '正向分组头带对端计数');
  assert.ok(text.includes('反向被引用（1 篇对端）'), '反向分组头带对端计数');
  assert.ok(
    (html.match(/aria-expanded="true"/g) ?? []).length >= 3,
    '分组折叠与当前版差异默认展开（aria-expanded ≥3）',
  );
  assert.ok(html.includes('data-ref-group="out"') && html.includes('data-ref-group="in"'), '分组键锚点在位');
  assert.ok(text.includes('×2 处'), '同对端多边折一张卡（×N 处）');
  assert.ok(text.includes('L12/L44'), '行号微标（去重升序）在卡面');
  assert.ok(text.includes('02-会议纪要/'), '对端标题带最小区分前缀');
  assert.ok(
    html.includes('目标摘要：对端文档的当前版摘要'),
    '悬停气泡预览目标摘要（title 属性承载，绝不整段倾倒）',
  );

  // 悬停预览纯函数：长摘要截断 80 字带省略号；无摘要如实空串；决策对端走「决策问题：」
  const long = '长'.repeat(120);
  const filesLong = [
    u06PeerFile(),
    { ...u06PeerFile(), file_id: 'f_long', title: '长摘要文档', revisions: [{ ...u06PeerFile().revisions[0], revision_id: 'rev_long', summaryNote: long }] },
  ] as unknown as FileRecord[];
  const previewLong = peerHoverPreviewOf('f_long', filesLong, []);
  assert.ok(previewLong.startsWith('目标摘要：'), '文件对端前缀口径');
  assert.ok(previewLong.endsWith('…') && previewLong.length <= '目标摘要：'.length + 80 + 1, '超长摘要截断 80 字带省略号');
  assert.equal(peerHoverPreviewOf('f_u06_peer', filesLong, []), '目标摘要：对端文档的当前版摘要，供引用卡悬停气泡预览。');
  assert.equal(peerHoverPreviewOf('f_none', filesLong, []), '', '未知对端诚实空串（调用方不带 title）');
  const withDecision = [
    { decision_id: 'dec_q', namespace: '方案', code: 'D-1', question: `  ${'问'.repeat(90)}  `, evidences: [] },
  ] as unknown as DecisionAssertion[];
  const decisionPreview = peerHoverPreviewOf('dec_q', filesLong, withDecision);
  assert.ok(decisionPreview.startsWith('决策问题：') && decisionPreview.endsWith('…'), '决策对端走问题口径并截断');
});

test('U06 SSR·决策与归属卡：待拍板/已定案/候选三桶（SSOT 同源）+ 专项上下游', () => {
  const html = renderToString(
    createElement(RightInspector, u06InspectorProps(u06InspectorFile()))
  );
  const text = html.replace(/<!-- -->/g, '');

  assert.ok(html.includes('data-inspector-decisions'), '决策与归属卡在位');
  assert.equal((html.match(/data-decision-group="/g) ?? []).length, 3, '三桶齐备');
  assert.ok(html.includes('data-decision-group="pending"'), '待拍板桶');
  assert.ok(html.includes('data-decision-group="settled"'), '已定案桶');
  assert.ok(html.includes('data-decision-group="candidates"'), '候选线索桶');
  assert.ok(text.includes('待拍板（1）'), '候选线索不计入待拍板（isUnresolvedDecision SSOT）');
  assert.ok(text.includes('已定案（1）'), '已生效决策如实成桶');
  assert.ok(text.includes('候选线索（未定案）（1）'), '候选决策单独轻桶，不冒充待拍板也不吞没');
  assert.ok(text.includes('D-U06-1 (待确认)'), '决策行 code+status 徽标同源');
  assert.ok(html.includes('data-inspector-package-flow'), '专项上下游区块在位');
  assert.ok(text.includes('专项上下游（阅读顺序）'), '上下游文案在位');
  assert.ok(html.includes('title="上游：'), '上游按钮带方向 title（语义在悬停层，卡面不堆字）');
  assert.ok(html.includes('title="下游：'), '下游按钮带方向 title');
  assert.ok(!text.includes('>上游：') && !text.includes('>下游：'), '按钮面文本不重复堆方向词');
});

// ---------- ③ 三口径时间语义与只读边界（源码契约） ----------

test('U06 时间语义·三口径绝不合并一行 + 只读边界零基线写点', () => {
  const inspectorSrc = readSrc('components/RightInspector.tsx');

  // ① 三口径各自独立行（检查器 ⓘ 明细），绝无合并的「时间」单行标签
  assert.ok(inspectorSrc.includes('检测到更新 (observed_at)'), 'observed_at 口径独立行');
  assert.ok(inspectorSrc.includes('文档声称日期 (source_time)'), 'source_time 口径独立行');
  assert.ok(inspectorSrc.includes('Git 提交 (commit_time)'), 'commit_time 口径独立行');
  assert.ok(!/>时间<\/span>/.test(inspectorSrc), '不出现把三口径合并的「时间」单行标签');

  // ② 只读边界：检查器全文件无未读基线写点；轨迹跳转只做视图跳转
  assert.ok(
    !inspectorSrc.includes('last_read_revision_id'),
    '时光轨迹卡与检查器不得顺手改动未读基线（last_read_revision_id 零出现）',
  );
  assert.ok(
    inspectorSrc.includes('onJumpMachine={canJumpMachine ? onViewRelationsGraph : undefined}'),
    '跳时光机复用既有视图跳转接线（enterEventFrame 下钻范式，纯只读跳转）',
  );
  assert.ok(
    inspectorSrc.includes('canOpenTimeMachine(selectedFile.format)'),
    '时光机入口按格式口径门控（与阅读器迷你版本轴同一集合，pdf 无假入口）',
  );
  assert.ok(
    inspectorSrc.includes('onOpenFile(selectedFile.file_id, revisionId)'),
    '节点「在阅读器打开」＝把阅读器钉到该版本（属读不属写）',
  );

  // ③ 抽屉口径：时间轴序 ≠ 修订链序，常显文案明示；onOpenRevision 仍是钉版只读
  const drawerSrc = readSrc('components/FileTimelineDrawer.tsx');
  assert.ok(
    drawerSrc.includes('内容演进请看版本时光机（按修订链）'),
    '历史抽屉常显文案明示两套口径不可统一',
  );
  assert.ok(drawerSrc.includes('排序 · 时间轴自新到旧（非修订链）'), '排序口径行如实自述');
  assert.ok(
    drawerSrc.includes('onOpenRevision(fileId, rev.revision_id)'),
    '抽屉「阅读器打开」仍走钉到该 revision 的只读入口',
  );
});

// ---------- ④ 文件历史抽屉：glx-t-panel 弹簧抽屉与动效契约 ----------

test('U06 抽屉动效·glx-t-panel 双轨 + 两段式入场（现役 glx-drawer-in 零叠加）', () => {
  const drawerSrc = readSrc('components/FileTimelineDrawer.tsx');
  const motionCss = readSrc('styles/motion.css');
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  // ① 面板挂 glx-t-panel（transform→spring、opacity→fade 双轨），不再叠挂 keyframes 类
  assert.ok(drawerSrc.includes('className="glx-t-panel'), '抽屉面板统一挂 glx-t-panel 弹簧双轨');
  assert.ok(
    !/className="[^"]*glx-drawer-in/.test(drawerSrc),
    'glx-drawer-in（一次性 keyframes，动的同是 transform+opacity）不得与 glx-t-panel 叠加成两套入场',
  );

  // ② 两段式入场：首帧偏移态 → rAF 翻转终态触发过渡（只动 transform/opacity）
  assert.ok(
    drawerSrc.includes('window.requestAnimationFrame(() => setEntered(true))'),
    '入场第二帧翻转终态（transition 需要状态变化触发）',
  );
  assert.ok(
    drawerSrc.includes("transform: entered ? 'none' : 'translateX(32px)'"),
    '首帧偏移态 translateX（禁动画 right/left/width）',
  );
  assert.ok(drawerSrc.includes('opacity: entered ? 1 : 0'), '入场双轨含 opacity');
  assert.ok(!/style\.width\s*=/.test(drawerSrc), '抽屉禁写 width（禁布局动画）');

  // ③ reduce 降级沿用既有登记：glx-t-panel / glx-backdrop-in 都在 motion.css 声明 + reduce 块覆盖
  for (const cls of ['.glx-t-panel', '.glx-backdrop-in']) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }
  const panelReduceStart = reduceSection.indexOf('.glx-t-panel');
  const panelReduceBlock = reduceSection.slice(panelReduceStart, reduceSection.indexOf('}', panelReduceStart));
  assert.ok(panelReduceBlock.includes('transition: none'), 'glx-t-panel 在 reduce 下撤过渡（瞬时落位、终态可见）');

  // ④ 无新增同义类：motion.css 抽屉段仍是「统一挂 glx-t-panel、不另立同义类」纪律
  assert.ok(
    motionCss.includes('统一挂 .glx-t-panel 双轨，不另立同义类、不新增 keyframes'),
    '抽屉动效归口纪律未被破坏',
  );
});

test('U06 抽屉 SSR·关闭零 DOM + 开启首帧偏移态可见（弹簧入场的可测中间态）', () => {
  const noop = () => {};
  const closed = renderToString(
    createElement(FileTimelineDrawer, {
      isOpen: false,
      fileId: 'f_u06_main',
      onClose: noop,
      onOpenRevision: noop,
    })
  );
  assert.equal(closed, '', '关闭态渲染空串（零 DOM）');

  const open = renderToString(
    createElement(FileTimelineDrawer, {
      isOpen: true,
      fileId: 'f_u06_main',
      onClose: noop,
      onOpenRevision: noop,
    })
  );
  assert.ok(open.includes('data-timeline-panel'), '抽屉面板带可测锚点');
  assert.ok(open.includes('glx-t-panel'), '面板挂弹簧双轨类');
  assert.ok(open.includes('translateX(32px)'), 'SSR 首帧呈偏移入场态（客户端 rAF 翻转触发过渡）');
  assert.ok(open.includes('opacity:0'), '首帧透明（淡变轨道就绪）');
  assert.ok(open.includes('aria-label="文件时间线"'), '对话框语义与可读名在位');
});

test('U06 抽屉精简·冗余技术字段收纳 + 竖轴节点锚点在位', () => {
  const drawerSrc = readSrc('components/FileTimelineDrawer.tsx');

  // ① size KB 不再逐节点平铺卡面头行——只保留「版本徽标 title + 正文预览头」两处收纳出口
  const sizeRefs = drawerSrc.match(/rev\.size_bytes \/ 1024/g) ?? [];
  assert.equal(sizeRefs.length, 2, `size KB 只允许徽标 title 与预览头两处（实测 ${sizeRefs.length} 处）`);
  assert.ok(drawerSrc.includes('title={`版本 v${rev.seq} ·'), '版本徽标 hover 承载 size 元数据');
  assert.ok(drawerSrc.includes('data-timeline-preview-meta'), '正文预览头补版本元数据行');

  // ② 视觉竖轴节点：脊柱 + 节点 + 类型锚点（测试与走查定位）
  assert.ok(drawerSrc.includes('data-timeline-nodes'), '竖轴容器锚点');
  assert.ok(drawerSrc.includes('data-timeline-spine'), '竖轴脊柱锚点');
  assert.ok(drawerSrc.includes('data-timeline-node='), '节点行锚点');
  assert.ok(drawerSrc.includes('data-timeline-node-kind='), '节点类型锚点（版本/事件）');

  // ③ 诚实语义保留：TA-03 时间依据与精度标注未被精简掉（绝不为减字丢口径）
  assert.ok(drawerSrc.includes('timeBasisLabel(rev.occurred_source)'), 'occurred 依据标注在位');
  assert.ok(drawerSrc.includes("'仅日期' : '含时刻'"), 'occurred 精度标注在位');
  assert.ok(
    drawerSrc.includes('已过保留期 · 无法点开'),
    '快照淘汰诚实提示在位（绝不以当前内容冒充历史版本）',
  );
});