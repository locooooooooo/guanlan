import assert from 'node:assert/strict';
import { test } from 'node:test';

// 1.2：星图左侧日期汇总卡「独立左侧轨道」几何常量 + 主干日期唯一锚点判定
// （与 wf2-same-day-merge.test.ts / tl02-machine-geometry.test.ts 同款：
//  组件导出几何常量与纯函数，测试只断言口径，不渲染 SVG）
import {
  CHRONOS_MASCOT_WIDTH,
  DATE_CARD_CHRONOS_MIN_GAP,
  DATE_CARD_H,
  DATE_CARD_RAIL_TRUNK_DX,
  DATE_CARD_TRUNK_MIN_GAP,
  DATE_CARD_W,
  dateCardChronosGap,
  dateCardRailX,
  dateCardTrunkGap,
  trunkTickShowsLabel,
} from '../src/components/GraphCanvasView';

/** 主节点默认位 main_hub.x=352，trunkX = main_hub.x + 62 */
const DEFAULT_TRUNK_X = 352 + 62;

const DAY_MS = 86_400_000;

function dayList(newest: string, count: number): string[] {
  const start = Date.parse(`${newest}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start - i * DAY_MS).toISOString().slice(0, 10)
  );
}

test('1.2 日期汇总卡离主干恒 ≥120px（含 main_hub 被拖动后的各种 trunkX）', () => {
  for (const trunkX of [240, 300, 352, 414, 520, 800, 1200]) {
    const gap = dateCardTrunkGap(trunkX);
    assert.ok(
      gap >= DATE_CARD_TRUNK_MIN_GAP,
      `trunkX=${trunkX} 时卡右缘到主干仅 ${gap}px，低于安全距离 ${DATE_CARD_TRUNK_MIN_GAP}px`
    );
  }
  // 默认布局的具体取值（改常量/改默认位都必须同步改这条）
  assert.equal(DEFAULT_TRUNK_X, 414);
  assert.equal(DATE_CARD_RAIL_TRUNK_DX, -292);
  assert.equal(dateCardRailX(DEFAULT_TRUNK_X), 122);
  assert.equal(dateCardTrunkGap(DEFAULT_TRUNK_X), 172);
});

test('1.2 日期汇总卡与司辰立绘零重叠（卡右缘 < 立绘左缘，留 ≥16px 呼吸）', () => {
  for (const trunkX of [240, 300, 414, 800, 1200]) {
    const gap = dateCardChronosGap(trunkX);
    assert.ok(
      gap >= DATE_CARD_CHRONOS_MIN_GAP,
      `trunkX=${trunkX} 时卡右缘到立绘左缘仅 ${gap}px，低于 ${DATE_CARD_CHRONOS_MIN_GAP}px`
    );
  }
  // 旧版把卡放在 x=266：卡横跨 266–386，而立绘是 258–390 → 120px 完全重叠（本次修法的反例）
  const oldCardRight = 266 + DATE_CARD_W;
  const mascotLeft = DEFAULT_TRUNK_X - 156;
  const mascotRight = mascotLeft + CHRONOS_MASCOT_WIDTH;
  assert.ok(oldCardRight > mascotLeft && oldCardRight <= mascotRight, '反例应落在立绘包围盒内');
  // 新轨道：卡整体落在立绘左侧
  assert.ok(dateCardRailX(DEFAULT_TRUNK_X) + DATE_CARD_W <= mascotLeft - DATE_CARD_CHRONOS_MIN_GAP);
  // 立绘横向包围盒：image x=6 w=124 / 徽章 x=4 w=128 / 左翼 12 → 取 132 全覆盖
  assert.equal(DATE_CARD_W, 120);
  assert.equal(DATE_CARD_H, 50);
  assert.equal(CHRONOS_MASCOT_WIDTH, 132);
});

test('1.2 每个日期全画布只允许 1 个锚点文字（主干 label ∪ 日期卡 label 无重复）', () => {
  // 真实量级：4776 天跨度（2013-10-16 → 2026-11-12），4 张日期汇总卡
  const dates = dayList('2026-11-12', 4776);
  const navigatorDates = new Set(dates.slice(0, 4));
  const step = 365; // 与组件 rulerLabelStep 在 n=4776 / 532px 轴高下的取值一致

  const occurrences = new Map<string, number>();
  const bump = (d: string) => occurrences.set(d, (occurrences.get(d) ?? 0) + 1);

  dates.forEach((date, i) => {
    if (trunkTickShowsLabel(i, step, date, navigatorDates)) bump(date);
  });
  navigatorDates.forEach((d) => bump(d));

  const duplicated = [...occurrences.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(duplicated, [], `存在同日多处锚点文字：${JSON.stringify(duplicated)}`);
  // 主干仍有日期文字（不能为了去重把刻度文字全删掉）
  const trunkLabelCount = dates.filter((d, i) =>
    trunkTickShowsLabel(i, step, d, navigatorDates)
  ).length;
  assert.ok(trunkLabelCount > 0, '主干仍有标注');
  assert.equal(trunkLabelCount + navigatorDates.size, occurrences.size);
});

test('1.2 密集刻度（30 天窗口 step=1）下唯一性同样成立，日期卡承载的 4 天从主干让位', () => {
  const dates = dayList('2026-11-12', 30);
  const navigatorDates = new Set(dates.slice(0, 4));
  assert.equal(trunkTickShowsLabel(0, 1, dates[0], navigatorDates), false, 'index 0 让位给日期卡');
  assert.equal(trunkTickShowsLabel(4, 1, dates[4], navigatorDates), true, '非日期卡的日期照常标注');
  assert.equal(trunkTickShowsLabel(0, 1, dates[0], new Set()), true, '无日期卡时 index 0 仍标注');

  const labels = dates.filter((d, i) => trunkTickShowsLabel(i, 1, d, navigatorDates));
  assert.equal(labels.length, 26);
  for (const navDate of navigatorDates) assert.ok(!labels.includes(navDate));
});
