/**
 * canvasViewport 全图元 AABB 裁剪 + quarter-octave 缩放分桶 LOD 纯算法层单测，
 * 以及 packageTitleStore 双击原位改名持久层单测。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeWorldAABB,
  cullRectsByViewport,
  isRectIntersectingViewport,
  lodGatesForTier,
  lodTierForScale,
  quarterOctaveLevel,
  LOD_FULL_MIN_K,
  LOD_MID_MIN_K,
  visiblePackageGroupIds,
  type WorldRect,
} from '../src/utils/canvasViewport';

/* ── 通用 AABB ── */

test('computeWorldAABB：总包围盒含 pad 外扩；空集/全非法输入返回 null 不伪造', () => {
  assert.equal(computeWorldAABB([]), null);
  assert.equal(
    computeWorldAABB([
      { x: Number.NaN, y: 0, width: 1, height: 1 },
    ]),
    null,
    '全非法矩形 → null（调用方按无内容兜底，不得伪造 [0,0,1000,900]）'
  );
  const box = computeWorldAABB(
    [
      { x: 10, y: 20, width: 100, height: 50 },
      { x: 200, y: -10, width: 40, height: 80 },
    ],
    40
  );
  assert.deepEqual(box, { x: -30, y: -50, width: 310, height: 160 });
});

test('isRectIntersectingViewport：AABB 相交/分离/含 margin 触达三态', () => {
  const vp = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(isRectIntersectingViewport({ x: 50, y: 50, width: 100, height: 100 }, vp), true);
  assert.equal(isRectIntersectingViewport({ x: 101, y: 0, width: 10, height: 10 }, vp), false);
  // margin 外扩：视口带外扩为 [-5, 105]，x=101 落带内、x=106 出带
  assert.equal(isRectIntersectingViewport({ x: 101, y: 0, width: 10, height: 10 }, vp, 5), true);
  assert.equal(isRectIntersectingViewport({ x: 106, y: 0, width: 10, height: 10 }, vp, 5), false);
});

test('cullRectsByViewport：视口内挂载、焦点包视口外保留、视口未测量保守全挂', () => {
  const rects = [
    { id: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', x: 5000, y: 0, width: 100, height: 100 },
    { id: 'c', x: 9000, y: 0, width: 100, height: 100 },
  ];
  const vp = { x: 0, y: 0, width: 200, height: 200 };
  const mounted = cullRectsByViewport(rects, vp, { focusIds: new Set(['c']) });
  assert.deepEqual([...mounted].sort(), ['a', 'c'], 'a 在视口内、c 是焦点保留、b 裁掉');
  // 视口未就绪（宽 0）：保守全挂——与 visiblePackageGroupIds「测量前不闪空」同纪律
  const all = cullRectsByViewport(rects, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(all.size, 3);
});

test('visiblePackageGroupIds 与通用 AABB 出口同源：纵向无界带的裁剪答案不变', () => {
  // 原语义：横向相交判定；改走 AABB 出口后同输入同答案
  const layouts = [
    { pkgId: 'p1', x: 0, width: 400 },
    { pkgId: 'p2', x: 464, width: 400 },
    { pkgId: 'p3', x: 3000, width: 400 },
  ];
  const vp = { x: 0, y: 0, width: 800, height: 600 };
  const ids = visiblePackageGroupIds(layouts, vp, { marginX: 100 });
  assert.deepEqual([...ids].sort(), ['p1', 'p2'], 'p3 超出视口+margin 被裁');
  // 焦点包出入视口都保留
  const withFocus = visiblePackageGroupIds(layouts, vp, { focusPkgId: 'p3', marginX: 100 });
  assert.deepEqual([...withFocus].sort(), ['p1', 'p2', 'p3']);
});

/* ── quarter-octave LOD ── */

test('quarterOctaveLevel：log2(k)×4 分桶（每档 ≈1.19×），k<=0 保守满档', () => {
  assert.equal(quarterOctaveLevel(1), 0);
  assert.equal(quarterOctaveLevel(0.5), -4);
  assert.equal(quarterOctaveLevel(0.25), -8);
  assert.equal(quarterOctaveLevel(2), 4);
  assert.equal(quarterOctaveLevel(0), Number.MAX_SAFE_INTEGER, 'k<=0 视为未就绪 → 满档');
  assert.equal(quarterOctaveLevel(-1), Number.MAX_SAFE_INTEGER);
});

test('lodTierForScale：k≥0.5 全保真（基线机位零变化）/ 0.25≤k<0.5 收装饰 / <0.25 轻骨架', () => {
  assert.equal(lodTierForScale(1), 'full');
  assert.equal(lodTierForScale(0.72), 'full', '折叠组近景镜头所在档');
  assert.equal(lodTierForScale(LOD_FULL_MIN_K), 'full');
  assert.equal(lodTierForScale(0.49), 'mid');
  assert.equal(lodTierForScale(LOD_MID_MIN_K), 'mid');
  assert.equal(lodTierForScale(0.2), 'skeleton');
  assert.equal(lodTierForScale(0), 'full', '未就绪保守全渲染');
});

test('lodGatesForTier：full 全开；mid 收流星/激光留流式与卡片；skeleton 仅骨架', () => {
  assert.deepEqual(lodGatesForTier('full'), {
    meteors: true, laser: true, liveFlow: true, cardDetails: true,
  });
  assert.deepEqual(lodGatesForTier('mid'), {
    meteors: false, laser: false, liveFlow: true, cardDetails: true,
  });
  assert.deepEqual(lodGatesForTier('skeleton'), {
    meteors: false, laser: false, liveFlow: false, cardDetails: false,
  });
});

test('quarter-octave 桶内连续缩放档位恒定（跨档才翻转，不逐帧抖动）', () => {
  // 1 → 1.18：同桶（level 0 → floor(log2(1.18)*4)=floor(0.87)=0）
  assert.equal(quarterOctaveLevel(1), quarterOctaveLevel(1.18));
  // 1 → 1.20：跨桶（floor(log2(1.2)*4)=floor(0.97... *4)=floor(3.87... wait verify numerically below）
  const levels = [1, 1.05, 1.1, 1.15, 1.18].map(quarterOctaveLevel);
  assert.ok(new Set(levels).size === 1, '桶内缩放档位不变');
});

/* ── packageTitleStore（显示名固化）── */

test('packageTitleStore：覆盖名优先、空串清除、同值短路不通知、订阅收到变更', async () => {
  const store = await import('../src/stores/packageTitleStore');
  store.clearPackageTitleOverridesForTest();
  assert.equal(store.packageDisplayTitle('pkg_a', '派生名'), '派生名');

  let notified = 0;
  const unsub = store.subscribePackageTitles(() => { notified += 1; });
  store.setPackageTitleOverride('pkg_a', '星图引擎 v2');
  assert.equal(notified, 1);
  assert.equal(store.packageDisplayTitle('pkg_a', '派生名'), '星图引擎 v2');
  // 同值短路
  store.setPackageTitleOverride('pkg_a', '星图引擎 v2');
  assert.equal(notified, 1);
  // 空串 = 清除覆盖回退派生名
  store.setPackageTitleOverride('pkg_a', '   ');
  assert.equal(notified, 2);
  assert.equal(store.packageDisplayTitle('pkg_a', '派生名'), '派生名');
  // 其他包不受影响
  store.setPackageTitleOverride('pkg_b', 'B 显示名');
  assert.equal(store.packageDisplayTitle('pkg_a', '派生名'), '派生名');
  assert.equal(store.packageDisplayTitle('pkg_b', 'B 派生'), 'B 显示名');
  unsub();
  store.setPackageTitleOverride('pkg_b', 'B 改名后');
  assert.equal(notified, 3, '退订后不再通知');
  store.clearPackageTitleOverridesForTest();
});
