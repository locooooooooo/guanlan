/**
 * starfix T5/T6 · 日期轴源头去重 + 事件卡变更摘要派生 单测。
 *
 * 守住两件事：
 *  ① 日期轴铁律：同一桶键（YYYY-MM-DD / 周一 / YYYY-MM / '' 待考）在画布场景
 *     （scene.days 折叠组、navigator 日期卡、主干 ruler 刻度）只允许出现 1 次——
 *     上游给出重复日期桶时在 buildCanvasEventScene 入口并组（计数求和、样本/决策拼接），
 *     互异日期桶逐字不变（回归 v04-canvas-events 既有断言口径）。
 *  ② 「检测到更新」事件卡摘要直出：deriveCanvasChangeSummary 只从既有
 *     changedSections/diff 链派生（章节描述 + 服务端 detail 定式回收 +/- 行数），
 *     派生不出就返回空——绝不伪造行数、绝不渲染空洞占位。
 *
 * 与 gc-12-date-rail / wf2-same-day-merge 同款形制：纯函数断言，不渲染 SVG。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCanvasEventScene,
  dedupeEventGroupsByDate,
  deriveCanvasChangeSummary,
} from '../src/utils/graphEvents';
import type { EventDayGroup, EventDayItem, EventDaysResult } from '../src/services/apiTypes';

// ---------- fixtures ----------

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

function daysResult(groups: EventDayGroup[], granularity: 'day' | 'week' = 'day'): EventDaysResult {
  return {
    ok: true,
    index_generation: 1,
    order: 'occurred',
    granularity,
    from: null,
    to: null,
    total: groups.reduce((sum, g) => sum + g.count, 0),
    hidden_days: 0,
    undated_count: groups.filter((g) => g.date === '').reduce((sum, g) => sum + g.count, 0),
    groups,
  };
}

// ---------- T5 · dedupeEventGroupsByDate 纯函数 ----------

test('T5 同日期重复桶并组：计数求和、by_kind/formats 求和、样本/决策按出现序拼接', () => {
  const a = group({
    date: '2026-11-13',
    count: 3,
    by_kind: { modified: 2, decision_raised: 1 },
    formats: { md: 3 },
    decisions: [{ decision_id: 'dec_q1', code: 'Q1', status: '待确认', count: 1 }],
    samples: [item({ event_id: 'a1' }), item({ event_id: 'a2', kind: 'modified' })],
  });
  const b = group({
    date: '2026-11-13',
    count: 2,
    by_kind: { modified: 2 },
    formats: { md: 1, svg: 1 },
    decisions: [{ decision_id: 'dec_q2', code: 'Q2', status: '待确认', count: 1 }],
    samples: [item({ event_id: 'b1', kind: 'modified' })],
  });
  const c = group({
    date: '2026-11-14',
    count: 1,
    by_kind: { appeared: 1 },
    formats: { pdf: 1 },
    samples: [item({ event_id: 'c1' })],
  });

  const merged = dedupeEventGroupsByDate([a, b, c]);

  // 同日只留 1 桶，且保持首现位置（11-13 在前、11-14 在后）
  assert.deepEqual(
    merged.map((g) => g.date),
    ['2026-11-13', '2026-11-14']
  );
  const day13 = merged[0];
  assert.equal(day13.count, 5, 'count = 3+2 求和');
  assert.deepEqual(day13.by_kind, { modified: 4, decision_raised: 1 }, 'by_kind 求和');
  assert.deepEqual(day13.formats, { md: 4, svg: 1 }, 'formats 求和');
  assert.deepEqual(
    day13.samples.map((s) => s.event_id),
    ['a1', 'a2', 'b1'],
    'samples 按原相对序拼接'
  );
  assert.deepEqual(
    day13.decisions.map((d) => d.decision_id),
    ['dec_q1', 'dec_q2'],
    'decisions 按出现序拼接'
  );
  // 互异日期桶逐字不变（回归口径）
  assert.equal(merged[1].count, 1);
  assert.deepEqual(merged[1].samples.map((s) => s.event_id), ['c1']);
});

test('T5 无重复时零改写：逐字返回等价桶（既有行为回归）', () => {
  const a = group({ date: '2026-11-13', count: 2, samples: [item({ event_id: 'a1' })] });
  const b = group({ date: '2026-11-14', count: 1, samples: [item({ event_id: 'b1' })] });
  const merged = dedupeEventGroupsByDate([a, b]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged, [a, b]);
});

test('T5 「日期待考」桶同样只允许 1 个（空串键并组）', () => {
  const a = group({ date: '', count: 1, samples: [item({ event_id: 'u1' })] });
  const b = group({ date: '', count: 2, samples: [item({ event_id: 'u2' })] });
  const merged = dedupeEventGroupsByDate([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 3);
  assert.deepEqual(merged[0].samples.map((s) => s.event_id), ['u1', 'u2']);
});

// ---------- T5 · buildCanvasEventScene 出口不变量 ----------

test('T5 场景出口：scene.days / navigator / ruler 三个日期轴同日期均只出现 1 次', () => {
  const scene = buildCanvasEventScene(
    daysResult([
      group({
        date: '2026-11-13',
        count: 2,
        by_kind: { modified: 2 },
        formats: { md: 2 },
        samples: [item({ event_id: 'a1', kind: 'modified' }), item({ event_id: 'a2', kind: 'modified' })],
      }),
      group({
        date: '2026-11-13',
        count: 1,
        by_kind: { modified: 1 },
        formats: { md: 1 },
        samples: [item({ event_id: 'a3', kind: 'modified' })],
      }),
      group({ date: '2026-11-14', count: 1, samples: [item({ event_id: 'b1' })] }),
    ])
  );

  // 折叠组：同日 1 组，计数合并（scene.days 保持上游输入序；「新→旧」由上游排序保证）
  assert.deepEqual(
    scene.days.map((d) => d.date),
    ['2026-11-13', '2026-11-14'],
    '同日并组后各 1 次'
  );
  const day13 = scene.days.find((d) => d.date === '2026-11-13')!;
  assert.equal(day13.count, 3);

  // 日期导航卡：无重复日期
  const navDates = scene.navigator.map((n) => n.date);
  assert.equal(new Set(navDates).size, navDates.length, 'navigator 日期唯一');

  // 主干标尺：day 粒度逐日展开，同一日期刻度唯一（重复渲染 11-13/11-14 的穿帮根除）
  const rulerDates = scene.ruler.map((t) => t.date);
  assert.equal(new Set(rulerDates).size, rulerDates.length, 'ruler 刻度日期唯一');
  const tick13 = scene.ruler.filter((t) => t.date === '2026-11-13');
  assert.equal(tick13.length, 1);
  assert.equal(tick13[0].count, 3, '刻度计数取并组后的真实总数');
});

test('T5 week 粒度聚合桶重复键同样收敛（一桶一刻度）', () => {
  const scene = buildCanvasEventScene(
    daysResult(
      [
        group({ date: '2026-11-09', count: 2, samples: [item({ event_id: 'w1' })] }),
        group({ date: '2026-11-09', count: 1, samples: [item({ event_id: 'w2' })] }),
        group({ date: '2026-11-02', count: 1, samples: [item({ event_id: 'w3' })] }),
      ],
      'week'
    )
  );
  const dates = scene.ruler.map((t) => t.date);
  assert.equal(new Set(dates).size, dates.length, '周桶刻度唯一');
  assert.deepEqual(dates, ['2026-11-09', '2026-11-02'], '新→旧一桶一刻度');
  const week = scene.ruler.find((t) => t.date === '2026-11-09')!;
  assert.equal(week.count, 3);
});

// ---------- T6 · deriveCanvasChangeSummary ----------

test('T6 章节链派生：首章节一句描述，多章节补计数', () => {
  const one = deriveCanvasChangeSummary({ changedSections: ['发布机构建文档头部'] });
  assert.deepEqual(one, { counts: null, description: '修改发布机构建文档头部' });

  const many = deriveCanvasChangeSummary({
    changedSections: ['发布机构建文档头部', '检索策略', '边缘裁剪'],
  });
  assert.equal(many.description, '修改发布机构建文档头部 等 3 处章节');
  assert.equal(many.counts, null, '章节分支无行数就不排行数（不伪造）');
});

test('T6 行数回收：只认服务端 detail 的「（+N/-M 行）」定式', () => {
  const fromDetail = deriveCanvasChangeSummary({
    changedSections: ['文档头部'],
    detail: '内容哈希变化（+1/-1 行）',
  });
  assert.deepEqual(fromDetail.counts, { added: 1, removed: 1 });
  assert.equal(fromDetail.description, '修改文档头部');

  // 半角括号与多余空白同样成立（容错，不放宽到任意文本）
  const halfWidth = deriveCanvasChangeSummary({
    detail: '内容哈希变化(+12 /-3行)',
  });
  assert.deepEqual(halfWidth.counts, { added: 12, removed: 3 });

  // 无章节纯哈希变化：行数即摘要本体，描述留空
  const hashOnly = deriveCanvasChangeSummary({ detail: '内容哈希变化（+4/-2 行）' });
  assert.deepEqual(hashOnly.counts, { added: 4, removed: 2 });
  assert.equal(hashOnly.description, '');
});

test('T6 无可诚实透出时返回空（调用方回退 headline，不制造空洞占位）', () => {
  assert.deepEqual(deriveCanvasChangeSummary({}), { counts: null, description: '' });
  assert.deepEqual(deriveCanvasChangeSummary({ changedSections: [], detail: '' }), {
    counts: null,
    description: '',
  });
  // 含「+N/-M」但不是服务端行数定式的文本，不误回收
  const notCounts = deriveCanvasChangeSummary({ detail: '变更章节：检索策略' });
  assert.deepEqual(notCounts, { counts: null, description: '' });
  // 空白章节名过滤
  const blank = deriveCanvasChangeSummary({ changedSections: ['  ', ''] });
  assert.deepEqual(blank, { counts: null, description: '' });
});
