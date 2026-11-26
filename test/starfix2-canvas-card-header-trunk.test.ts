import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCanvasEventScene,
  canvasChangeDigestLine,
  dedupeTicksByDate,
  fanOutDayHeaderLine,
  FANOUT_DAY_HEADER_TAIL,
  versionSpanCapsule,
  type CanvasRulerTick,
} from '../src/utils/graphEvents';
import type { DayRevisionMerge } from '../src/utils/taskPackages';
import {
  DEFAULT_NODE_POSITIONS,
  EVENT_CARD_COL_GAP,
  EVENT_CARD_H,
  EVENT_CARD_ROW_GAP,
  EVENT_CARD_W,
  FANOUT_HEADER_BUTTON_LEFT_GAP_W,
  FANOUT_HEADER_TEXT_LEFT,
  TRUNK_META_TEXT_Y,
  fanOutHeaderCapsuleWidth,
  fanOutHeaderTextWidth,
} from '../src/components/GraphCanvasView';
import type { EventDayGroup, EventDayItem, EventDaysResult } from '../src/services/apiTypes';


function item(over: Partial<EventDayItem> & Pick<EventDayItem, 'event_id'>): EventDayItem {
  return {
    kind: 'appeared',
    headline: '',
    revision_id: null,
    file_id: null,
    file_path: null,
    file_title: null,
    file_role: null,
    format: null,
    occurred_at: null,
    occurred_precision: 'day',
    observed_at: '2026-11-06T05:07:40.170Z',
    time_basis: null,
    action: null,
    decision_id: null,
    code: null,
    status: null,
    ref_count: 0,
    version_count: 1,
    statement_count: 0,
    ...over,
  };
}

function group(over: Partial<EventDayGroup> & Pick<EventDayGroup, 'date'>): EventDayGroup {
  return {
    count: 0,
    by_kind: {},
    formats: {},
    decisions: [],
    samples: [],
    ...over,
  };
}

function daysResult(groups: EventDayGroup[]): EventDaysResult {
  return {
    ok: true,
    index_generation: 1,
    order: 'occurred',
    granularity: 'day',
    from: null,
    to: null,
    total: groups.reduce((sum, g) => sum + g.count, 0),
    hidden_days: 0,
    undated_count: groups.filter((g) => g.date === '').reduce((sum, g) => sum + g.count, 0),
    groups,
  };
}

function tick(over: Partial<CanvasRulerTick> & Pick<CanvasRulerTick, 'date'>): CanvasRulerTick {
  return {
    label: over.date?.slice(5) ?? '',
    count: 0,
    kinds: {},
    formats: {},
    hasEvents: false,
    ...over,
  };
}


test('T4 dedupeTicksByDate：同日重复刻度只留首现（11-13×2 / 11-14 / 11-15×2 → 各 1）', () => {
  const ticks = [
    tick({ date: '2026-11-15', label: '11-15', count: 3, hasEvents: true }),
    tick({ date: '2026-11-15', label: '11-15', count: 9, hasEvents: true }),
    tick({ date: '2026-11-14', label: '11-14', count: 1, hasEvents: true }),
    tick({ date: '2026-11-13', label: '11-13', count: 2, hasEvents: true }),
    tick({ date: '2026-11-13', label: '11-13', count: 5, hasEvents: true }),
  ];
  const deduped = dedupeTicksByDate(ticks);

  assert.deepEqual(
    deduped.map((t) => t.date),
    ['2026-11-15', '2026-11-14', '2026-11-13']
  );
  assert.equal(deduped[0].count, 3, '保留首现刻度（不拿重复桶计数冒充）');
  assert.equal(deduped[2].count, 2, '保留首现刻度');
  assert.equal(new Set(deduped.map((t) => t.date)).size, deduped.length, '同日期 ≤1');
});

test('T4 无重复时零改写：逐字等价返回（既有行为回归）', () => {
  const ticks = [
    tick({ date: '2026-11-15', count: 1, hasEvents: true }),
    tick({ date: '2026-11-14', count: 0 }),
  ];
  assert.deepEqual(dedupeTicksByDate(ticks), ticks);
});

test('T4 场景出口 → 渲染入口全链：重复日期桶经 scene 后主干刻度恒恰好 1 枚/日', () => {
  const scene = buildCanvasEventScene(
    daysResult([
      group({
        date: '2026-11-13',
        count: 2,
        samples: [item({ event_id: 'a1', kind: 'modified' }), item({ event_id: 'a2', kind: 'modified' })],
      }),
      group({ date: '2026-11-13', count: 1, samples: [item({ event_id: 'a3', kind: 'modified' })] }),
      group({ date: '2026-11-14', count: 1, samples: [item({ event_id: 'b1' })] }),
      group({ date: '2026-11-15', count: 1, samples: [item({ event_id: 'c1' })] }),
    ])
  );
  const renderTicks = dedupeTicksByDate(scene.ruler);
  const dates = renderTicks.map((t) => t.date);
  assert.equal(new Set(dates).size, dates.length, '渲染入口产物同日期 ≤1');
  for (const day of ['2026-11-15', '2026-11-14', '2026-11-13']) {
    assert.equal(renderTicks.filter((t) => t.date === day).length, 1, `${day} 恰好 1 枚刻度`);
  }
  assert.ok(renderTicks.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date)));
});


test('T1 事件卡几何：280x116 贴富预览卡栅格（280~300px 带内），常量单一出处', () => {
  assert.ok(EVENT_CARD_W >= 280 && EVENT_CARD_W <= 300, `卡宽 ${EVENT_CARD_W} 在 280~300 带内`);
  assert.equal(EVENT_CARD_W, 280, '与 canvas/RichDocPreviewCard RICH_CARD_W 同栅格');
  assert.ok(EVENT_CARD_H >= 100, `卡高 ${EVENT_CARD_H} 容纳四行内容`);
});

test('T1 槽位堆叠间距铁律：同行列距 ≥ 卡宽+24，同列行距 ≥ 卡高+24（280px 宽卡零重叠）', () => {
  const slots = ['sub_01', 'sub_02', 'sub_03', 'sub_04', 'sub_05', 'sub_06', 'sub_07', 'sub_08'];
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const a = DEFAULT_NODE_POSITIONS[slots[i]!]!;
      const b = DEFAULT_NODE_POSITIONS[slots[j]!]!;
      const sameRow = a.y === b.y;
      const sameCol = a.x === b.x;
      if (sameRow) {
        const gapX = Math.abs(a.x - b.x);
        assert.ok(
          gapX >= EVENT_CARD_W + 24,
          `同行槽 ${slots[i]}/${slots[j]} 列距 ${gapX} < 卡宽 ${EVENT_CARD_W}+24 → 横向重叠`
        );
        assert.ok(gapX >= EVENT_CARD_W + EVENT_CARD_COL_GAP);
      }
      if (sameCol) {
        const gapY = Math.abs(a.y - b.y);
        assert.ok(
          gapY >= EVENT_CARD_H + 24,
          `同列槽 ${slots[i]}/${slots[j]} 行距 ${gapY} < 卡高 ${EVENT_CARD_H}+24 → 纵向重叠/热区串行`
        );
        assert.ok(gapY >= EVENT_CARD_H + EVENT_CARD_ROW_GAP);
      }
      const sepX =
        a.x >= b.x + EVENT_CARD_W + 24 || b.x >= a.x + EVENT_CARD_W + 24;
      const sepY =
        a.y >= b.y + EVENT_CARD_H + 24 || b.y >= a.y + EVENT_CARD_H + 24;
      assert.ok(sepX || sepY, `槽 ${slots[i]}/${slots[j]} 卡矩形间距 <24px`);
    }
  }
});

test('T1 版本跨度胶囊（versionSpanCapsule）：合并卡 v6 → v8 (2次)，单一出口新措辞', () => {
  const merged: DayRevisionMerge = {
    fileId: 'f1',
    day: '2026-11-13',
    vFirst: 6,
    vLast: 8,
    evolutionCount: 2,
    headline: '',
    revisionIds: ['r6', 'r7', 'r8'],
    eventCount: 3,
    merged: true,
  };
  assert.equal(versionSpanCapsule({ merged }), 'v6 → v8 (2次)');
  assert.equal(
    versionSpanCapsule({ merged: { ...merged, vFirst: null, evolutionCount: 2 } }),
    'v8'
  );
  assert.equal(
    versionSpanCapsule({ merged: { ...merged, vFirst: 8, vLast: 8, evolutionCount: 0 } }),
    'v8'
  );
  assert.equal(versionSpanCapsule({ kind: 'modified', version: 8 }), 'v7 → v8');
  assert.equal(versionSpanCapsule({ kind: 'modified', version: 1 }), 'v1');
  assert.equal(versionSpanCapsule({ kind: 'appeared', version: 3 }), '新出现 v3');
  assert.equal(versionSpanCapsule({ kind: 'modified', version: null }), '');
  assert.equal(versionSpanCapsule({}), '');
  assert.equal(versionSpanCapsule({ kind: 'decision_raised', version: 4 }), '');
});

test('T1 变更章节摘要行（canvasChangeDigestLine）：章节名拼接 + 一句描述，严禁只写 +/- 行', () => {
  assert.equal(
    canvasChangeDigestLine({
      changedSections: ['文档头部', '构建说明'],
      description: '修改文档头部',
    }),
    '变更章节：文档头部 / 构建说明 — 修改文档头部'
  );
  assert.equal(
    canvasChangeDigestLine({
      changedSections: ['文档头部', '构建说明', '检索策略'],
      description: '修改文档头部 等 3 处章节',
    }),
    '变更章节：文档头部 / 构建说明 / 检索策略 — 修改文档头部 等 3 处章节'
  );
  assert.equal(
    canvasChangeDigestLine({
      changedSections: ['a', 'b', 'c', 'd', 'e'],
      description: '修改a 等 5 处章节',
    }),
    '变更章节：a / b / c / … — 修改a 等 5 处章节'
  );
  assert.equal(canvasChangeDigestLine({ description: '修改文档头部' }), '修改文档头部');
  assert.equal(canvasChangeDigestLine({ changedSections: [], description: '' }), '');
  assert.equal(canvasChangeDigestLine({}), '');
});


test('T2 组头新措辞逐字（fanOutDayHeaderLine）：共 n 条事件（已合并为 m 份活跃文档 · 点击查看全天 →）', () => {
  assert.equal(
    fanOutDayHeaderLine('2026-11-13', 12, 4),
    '2026-11-13 · 共 12 条事件（已合并为 4 份活跃文档 · 点击查看全天 →）'
  );
  assert.ok(fanOutDayHeaderLine('2026-11-13', 12, 4).endsWith(FANOUT_DAY_HEADER_TAIL));
  assert.equal(FANOUT_DAY_HEADER_TAIL, '点击查看全天 →）');
  const line = fanOutDayHeaderLine('2026-11-13', 12, 4);
  assert.ok(!line.includes('待展开'), '旧「N 条待展开」措辞已废弃');
  assert.ok(!line.includes('个事项'), '旧「N 个事项」措辞已由新句式取代');
});

test('T2 自适应胶囊宽：全量文本 + 内边距，右缘恒在「收起」按钮左缘之前（任何盒宽不重叠）', () => {
  const line = `⑃ ${fanOutDayHeaderLine('2026-11-13', 12, 4)}`;
  assert.ok(fanOutHeaderTextWidth(line) > 0);
  const longer = `${line}！`;
  assert.ok(fanOutHeaderTextWidth(longer) > fanOutHeaderTextWidth(line));
  for (const boxWidth of [330, 358, 500, 624, 1200]) {
    const capsuleW = fanOutHeaderCapsuleWidth(line, boxWidth);
    assert.ok(capsuleW <= Math.max(160, boxWidth - 96), `boxWidth=${boxWidth} 胶囊宽越上界`);
    const capsuleRight = 12 + capsuleW;
    const buttonLeft = boxWidth - 82;
    assert.ok(
      capsuleRight < buttonLeft,
      `boxWidth=${boxWidth} 胶囊右缘 ${capsuleRight} ≥ 按钮左缘 ${buttonLeft}`
    );
    const empty = fanOutHeaderCapsuleWidth('⑃ 扇出 · 暂无事件卡片', boxWidth);
    assert.ok(empty >= 160, `boxWidth=${boxWidth} 空态胶囊宽 ${empty} < 160 下界`);
    if (boxWidth >= 624) {
      assert.equal(
        capsuleW,
        Math.max(160, fanOutHeaderTextWidth(line) + 24),
        '全量文本未被钳制（不再截断）'
      );
    }
  }
  assert.equal(FANOUT_HEADER_TEXT_LEFT, 12, '文本起点常量不变');
  assert.equal(FANOUT_HEADER_BUTTON_LEFT_GAP_W, 96, '胶囊/按钮带隙常量登记（旧固定宽上界来源）');
});


test('T3 固定文字组上移让位：行2 基线 < 主卡顶（CHRONOS·SHA256 · … 同屏零重叠）', () => {
  const hubTop = DEFAULT_NODE_POSITIONS.main_hub!.y;
  assert.equal(hubTop, 32);
  const line2Baseline = TRUNK_META_TEXT_Y + 18;
  assert.ok(
    line2Baseline < hubTop,
    `行2 基线 ${line2Baseline} 落进主卡横带（顶 ${hubTop}）→ CHRONOS·SHA256 被卡面盖住`
  );
  assert.ok(36 + 18 >= hubTop, '旧锚点 36 的行2 基线确实落在主卡横带内（反例成立）');
  assert.ok(TRUNK_META_TEXT_Y > 0);
});
