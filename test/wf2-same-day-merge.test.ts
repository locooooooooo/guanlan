import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCanvasEventScene, type CanvasEventCard } from '../src/utils/graphEvents';
import { dayMergeLabel, stageOfPath, taskPackageOf } from '../src/utils/taskPackages';
import { basenameOf } from '../src/utils/documentIdentity';
import type { EventDayItem, EventDaysResult } from '../src/services/workspaceClient';
// 组头胶囊几何常量与纯函数（复用 tl02/gu-cc 既有 exported 几何常量断言风格）
import {
  FANOUT_HEADER_BUTTON_W,
  FANOUT_HEADER_CAPSULE_H,
  FANOUT_HEADER_CHRONOS_GAP_MIN,
  FANOUT_HEADER_TEXT_BUDGET_OFFSET,
  fanOutHeaderButtonLeft,
  fanOutHeaderCapsuleY,
  fanOutHeaderTextMaxWidth,
  fitFanOutHeaderText,
} from '../src/components/GraphCanvasView';

/**
 * WF-2：全景溯源——同日同文件合并为一张卡（v1 → v3 · 今日演进 N 次）+
 * 组头日期胶囊几何（文本预算 / 按钮右缘 / 司辰留白三组常量）。
 *
 * 合并为可选开启：buildCanvasEventScene 注入 resolveVersion 才合并；缺省逐卡旧行为
 * （v04-canvas-events 既有断言不动，本文件单独验证两档口径）。
 */

function item(over: Partial<EventDayItem> = {}): EventDayItem {
  return {
    event_id: 'evt_1',
    kind: 'modified',
    headline: '内容修改：需求单更新',
    revision_id: 'r1',
    file_id: 'f_1',
    file_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md',
    file_title: null,
    file_role: '方案',
    format: 'md',
    occurred_at: '2026-11-05',
    occurred_precision: 'day',
    observed_at: '2026-11-05T08:00:00+08:00',
    time_basis: 'collector',
    action: null,
    decision_id: null,
    code: null,
    status: null,
    ref_count: 3,
    version_count: 3,
    statement_count: 1,
    ...over,
  };
}

/** 同 file_id 一日三版：r1→v1、r2→v2、r3→v3（EventDayItem 无版本号，由调用方注入查表） */
const resolve = (revisionId: string | null): number | null =>
  revisionId === 'r1' ? 1 : revisionId === 'r2' ? 2 : revisionId === 'r3' ? 3 : null;

function singleDayFixture(samples: EventDayItem[]): EventDaysResult {
  return {
    ok: true,
    index_generation: 1,
    order: 'occurred',
    granularity: 'day',
    from: null,
    to: null,
    total: samples.length,
    hidden_days: 0,
    undated_count: 0,
    groups: [
      {
        date: '2026-11-05',
        count: samples.length,
        by_kind: { modified: samples.length },
        formats: { md: samples.length },
        decisions: [],
        samples,
      },
    ],
  } as EventDaysResult;
}

// ---------- 验收：同 file_id 同日合并（DoD2 逐字口径） ----------

test('wf_2 同 file_id 同日三版 → 1 张合并卡，changeLabel=v1 → v3 · 今日演进 2 次', () => {
  const samples = [
    item({ event_id: 'e1', revision_id: 'r1', observed_at: '2026-11-05T08:00:00+08:00' }),
    item({ event_id: 'e2', revision_id: 'r2', observed_at: '2026-11-05T09:00:00+08:00' }),
    item({ event_id: 'e3', revision_id: 'r3', observed_at: '2026-11-05T10:00:00+08:00' }),
  ];
  const scene = buildCanvasEventScene(singleDayFixture(samples), {
    maxCardsPerGroup: 6,
    resolveVersion: resolve,
  });
  const cards = (scene.active?.cards ?? []) as CanvasEventCard[];
  assert.equal(cards.length, 1, '同日三版样本合并为一张卡，不再各自成卡');
  assert.equal(cards[0].fileId, 'f_1');
  assert.equal(cards[0].mergedDay?.vFirst, 1, 'vFirst=桶内最小版本号');
  assert.equal(cards[0].mergedDay?.vLast, 3, 'vLast=桶内最大版本号');
  assert.equal(cards[0].mergedDay?.evolutionCount, 2, '今日演进 2 次（3 版 - 1）');
  assert.equal(dayMergeLabel(cards[0].mergedDay!), 'v1 → v3 · 今日演进 2 次', 'DoD2 逐字口径');
  assert.equal(cards[0].revisionId, 'r3', '代表样本 = 当日最后一次写入（observed_at 最大）');
  assert.equal(scene.active?.more, 0, '合并卡承载全部 3 条样本，无未展开余量');
});

test('wf_2 缺省（未传 resolveVersion）逐字旧行为：同日三版各自成卡、无 mergedDay', () => {
  const samples = [
    item({
      event_id: 'e1',
      revision_id: 'r1',
      occurred_at: '2026-11-05T08:00:00+08:00',
      observed_at: '2026-11-05T08:00:00+08:00',
    }),
    item({
      event_id: 'e2',
      revision_id: 'r2',
      occurred_at: '2026-11-05T09:00:00+08:00',
      observed_at: '2026-11-05T09:00:00+08:00',
    }),
    item({
      event_id: 'e3',
      revision_id: 'r3',
      occurred_at: '2026-11-05T10:00:00+08:00',
      observed_at: '2026-11-05T10:00:00+08:00',
    }),
  ];
  const scene = buildCanvasEventScene(singleDayFixture(samples), { maxCardsPerGroup: 6 });
  const cards = (scene.active?.cards ?? []) as CanvasEventCard[];
  assert.equal(cards.length, 3, '未注入 resolveVersion → 逐卡旧行为（3 张卡）');
  assert.deepEqual(
    cards.map((c) => c.eventId),
    ['e3', 'e2', 'e1'],
    '同层按 (occurred_at||observed_at) 降序（新 → 旧），排序语义不变'
  );
  assert.ok(cards.every((c) => !c.mergedDay), '缺省档无 mergedDay 字段');
  assert.equal(scene.active?.more, 0);
});

test('wf_2 两规则互不覆盖：先同 file_id 同日合并、再跨 file_id 同基名并组 → 1 张 ×3 卡', () => {
  const samples = [
    item({ event_id: 'a1', file_id: 'fa', revision_id: 'a1r1', file_path: 'runs/run-A/README.md', observed_at: '2026-11-05T08:00:00+08:00' }),
    item({ event_id: 'a2', file_id: 'fa', revision_id: 'a1r2', file_path: 'runs/run-A/README.md', observed_at: '2026-11-05T09:00:00+08:00' }),
    item({ event_id: 'b1', file_id: 'fb', revision_id: 'b1r1', file_path: 'runs/run-B/README.md', observed_at: '2026-11-05T08:00:00+08:00' }),
    item({ event_id: 'b2', file_id: 'fb', revision_id: 'b1r2', file_path: 'runs/run-B/README.md', observed_at: '2026-11-05T09:00:00+08:00' }),
    item({ event_id: 'c1', file_id: 'fc', revision_id: 'c1r1', file_path: 'runs/run-C/README.md', observed_at: '2026-11-05T08:00:00+08:00' }),
    item({ event_id: 'c2', file_id: 'fc', revision_id: 'c1r2', file_path: 'runs/run-C/README.md', observed_at: '2026-11-05T09:00:00+08:00' }),
  ];
  const scene = buildCanvasEventScene(singleDayFixture(samples), {
    maxCardsPerGroup: 6,
    resolveVersion: (id) => (id ? 1 : null),
  });
  const cards = (scene.active?.cards ?? []) as CanvasEventCard[];
  assert.equal(cards.length, 1, '6 条样本：3 文件各自先合并、再同基名并组 → 1 张 ×3 卡');
  assert.equal(cards[0].mergedCount, 3, '并组卡 = 3 个异文件成员');
  assert.match(cards[0].detail, /×3 样本内同基名拷贝/, '行2 前缀如实标注样本内计数');
  assert.equal(cards[0].mergedDay?.merged, true, '并组卡首位代表本身是同日合并文件 → 合并标签随卡透出');
  assert.equal(scene.active?.more, 0, '并组卡承载全部 6 条原始样本，more 口径不变');
});

// ---------- 验收：组头胶囊几何（三组常量在渲染断言中覆盖） ----------

test('wf_2 组头胶囊几何：文本预算 / 按钮右缘 / 司辰留白三组常量，任何盒宽不重叠', () => {
  // 文本预算（ask 逐字口径）：fanOutBounds.width - 96 - 58（按钮宽）- 16
  assert.equal(FANOUT_HEADER_TEXT_BUDGET_OFFSET, 96 + FANOUT_HEADER_BUTTON_W + 16);
  assert.equal(FANOUT_HEADER_BUTTON_W, 58);

  for (const w of [330, 358, 500, 640, 1200]) {
    const textMax = fanOutHeaderTextMaxWidth(w);
    assert.equal(textMax, Math.max(0, w - 96 - 58 - 16), `w=${w} 文本预算 = 盒宽 - 96 - 58 - 16`);
    // 文本终点（左缘 12 + 预算）恒在按钮左缘（盒宽 - 82）之前 → 『点击看全天 →』与『收起』永不重叠
    const textEnd = 12 + textMax;
    const btnLeft = fanOutHeaderButtonLeft(w);
    assert.ok(textEnd < btnLeft, `w=${w} 文本终点 ${textEnd} < 按钮左缘 ${btnLeft}`);
    // 按钮右缘恒贴胶囊右缘（盒宽 - 24 = 82 - 58）
    assert.equal(btnLeft + FANOUT_HEADER_BUTTON_W, w - 24, '按钮右缘 = 盒宽 - 24，恒贴胶囊右缘');
  }

  // 超长省略：超预算文本以「…」收尾（em 预算保守估算，永不溢出）；未超预算原样
  const long = '⑃ 2026-11-05 · 187 条事件 · 5 个事项 · 60 条待展开 · 点击看全天 →';
  const budgetChars = Math.max(1, Math.floor(330 / 11.5));
  assert.ok(long.length > budgetChars, 'more>0 长文案确实超出预算');
  const fitted = fitFanOutHeaderText(long, 330);
  assert.equal(fitted, `${long.slice(0, budgetChars - 1)}…`, '超长以「…」收尾（保留前段）');
  assert.ok(long.startsWith(fitted.slice(0, -1)), '截断保留原文案前段（日期信息不丢）');
  const short = '⑃ 2026-11-05 · 3 条事件';
  assert.equal(fitFanOutHeaderText(short, 330), short, '未超预算原样返回（双色 tspan 结构保留）');

  // 胶囊底与司辰留白 ≥ 20px：fanOutHeaderCapsuleY 只上推胶囊（盒内钳制），不改司辰派生
  assert.ok(FANOUT_HEADER_CHRONOS_GAP_MIN >= 20, '留白常量下限 20px');
  // 间距可达的样本（chronosY ≥ boxTop + 46，上推可在盒内补足）：留白 ≥ 20 恒成立
  for (const [boxTop, chronosY] of [
    [202, 266], // 默认布局：卡片顶 248 - 46 头高 = 202；司辰默认 266
    [202, 248.4], // 6 日标尺、次新日（原布局留白不足 10.4 的触发样本）
    [192, 266], // 空态默认盒
    [202, 250], // gap 12 → 上推 8 → 恰好 20
  ]) {
    const capsuleY = fanOutHeaderCapsuleY(boxTop, chronosY);
    const capsuleBottom = boxTop + capsuleY + FANOUT_HEADER_CAPSULE_H;
    assert.ok(
      chronosY - capsuleBottom >= FANOUT_HEADER_CHRONOS_GAP_MIN,
      `boxTop=${boxTop} chronosY=${chronosY}：留白 ${chronosY - capsuleBottom} ≥ 20`
    );
  }
  // 间距充足的样本：胶囊原位不动（10）
  assert.equal(fanOutHeaderCapsuleY(202, 266), 10);
  assert.equal(fanOutHeaderCapsuleY(192, 266), 10);
  // 触发样本：上推到恰好 20px 留白（0.4 = 10 - (20 - 10.4)）
  assert.ok(
    Math.abs(fanOutHeaderCapsuleY(202, 248.4) - 0.4) < 1e-9,
    'gap=10.4 → 上推 9.6 → 胶囊 y=0.4（恰好 20px 留白）'
  );
  // 司辰被拖入盒区/盒上方（盒内不可补足）：钳制在盒顶 0，胶囊永不越出盒顶
  for (const [boxTop, chronosY] of [
    [300, 300],
    [202, 238],
    [202, 230],
  ]) {
    const capsuleY = fanOutHeaderCapsuleY(boxTop, chronosY);
    assert.ok(capsuleY >= 0, `boxTop=${boxTop} chronosY=${chronosY} 胶囊不越出盒顶（0 ≤ y ≤ 10）`);
    assert.ok(capsuleY <= 10, '胶囊不上推越过盒顶');
  }
});

// ---------- 验收：DoD1 抽查（任务包名 + 核心文档名替代截断前缀路径） ----------

test('wf_2 DoD1 抽查：ask 原例路径 → 任务包名+核心文档名，行首不含连续截断前缀', () => {
  const p = '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md';
  const pkg = taskPackageOf(p);
  assert.equal(pkg.name, 'PDM四专项需求核对_2026-11-04', '任务包名 = 专项名_日期（ask 原例逐字）');
  assert.equal(basenameOf(p), '01-需求单', '核心文档名 = basename 去扩展名');
  assert.equal(stageOfPath(p), '蓝图', '01-需求单 → 蓝图阶段（关键词优先）');

  // 行首展示 = 任务包名 + 核心文档名（chips 同源口径）；容器前缀只收进完整路径（title 悬浮）
  const chipLine = `${pkg.name}·${stageOfPath(p)} ${basenameOf(p)}`;
  assert.ok(!chipLine.includes('01-方案文档/产品需求与任务包'), '行首不再裸显容器前缀路径');
  assert.ok(!chipLine.includes('01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04'), '连续同前缀路径不再出现');

  // 连续 10 个同容器文件的行首（DoD1 场景）：每行 = 包名 + 各自文档名，无「蜈蚣列表」
  const tenDocs = Array.from({ length: 10 }, (_, i) =>
    `01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/0${i + 1}-文档${i + 1}.md`
  );
  const lines = tenDocs.map(
    (path) => `${taskPackageOf(path).name} ${basenameOf(path)}`
  );
  assert.equal(new Set(lines).size, 10, '10 行互不重复（文档名各异，包名相同不构成重复前缀堆叠）');
  assert.ok(lines.every((l) => !l.includes('/')), '行首无路径分隔符（不裸显目录前缀）');
});
