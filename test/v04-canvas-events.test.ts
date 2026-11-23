import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCanvasEventScene,
  eventKindLabel,
  toCanvasCard,
} from '../src/utils/graphEvents';
import type { EventDayItem, EventDaysResult } from '../src/services/workspaceClient';

function item(over: Partial<EventDayItem> = {}): EventDayItem {
  return {
    event_id: 'evt_1',
    kind: 'appeared',
    headline: '文档自述日期：方案 A（2026-11-05）',
    revision_id: 'rev_1',
    file_id: 'f_1',
    file_path: '01-方案文档/方案 A.md',
    file_title: '方案 A',
    file_role: '方案',
    format: 'md',
    occurred_at: '2026-11-05',
    occurred_precision: 'day',
    observed_at: '2026-11-06T05:07:40.170Z',
    time_basis: 'document_self',
    action: null,
    decision_id: null,
    code: null,
    status: null,
    ref_count: 3,
    version_count: 2,
    statement_count: 1,
    ...over,
  };
}

function daysFixture(): EventDaysResult {
  return {
    ok: true,
    index_generation: 3,
    order: 'occurred',
    granularity: 'day',
    from: null,
    to: null,
    total: 5,
    hidden_days: 0,
    undated_count: 1,
    groups: [
      {
        date: '2026-11-05',
        count: 3,
        by_kind: { appeared: 2, decision_raised: 1 },
        formats: { md: 3 },
        decisions: [
          { decision_id: 'dec_q01', code: 'Q01', status: '待确认', count: 1 },
          { decision_id: 'dec_q02', code: 'Q02', status: '待确认', count: 1 },
        ],
        samples: [
          item({ event_id: 'e1' }),
          item({
            event_id: 'e2',
            kind: 'decision_raised',
            action: 'raised',
            decision_id: 'dec_q01',
            code: 'Q01',
            status: '待确认',
            revision_id: null,
            headline: '提出问题：Q01 · 过渡期',
          }),
          item({
            event_id: 'e3',
            kind: 'decision_raised',
            action: 'conflicted',
            decision_id: 'dec_q02',
            code: 'Q02',
            status: '来源不一致',
            revision_id: null,
            headline: '来源不一致：Q02 · 检索策略',
          }),
        ],
      },
      {
        date: '2026-11-04',
        count: 1,
        by_kind: { modified: 1 },
        formats: { md: 1 },
        decisions: [],
        samples: [item({ event_id: 'e4', kind: 'modified', time_basis: 'collector', occurred_at: '2026-11-04' })],
      },
      {
        date: '',
        count: 1,
        by_kind: { read_error: 1 },
        formats: {},
        decisions: [],
        samples: [item({ event_id: 'e5', kind: 'read_error', occurred_at: null, time_basis: null })],
      },
    ],
  } as EventDaysResult;
}

test('界面用词按 §3 的证据口径区分', () => {
  assert.equal(eventKindLabel({ kind: 'workspace_baseline', time_basis: null, action: null }), '首次接入');
  assert.equal(eventKindLabel({ kind: 'appeared', time_basis: 'document_self', action: null }), '文档自述日期');
  assert.equal(eventKindLabel({ kind: 'appeared', time_basis: 'file_mtime', action: null }), '新出现（文件时间）');
  assert.equal(eventKindLabel({ kind: 'modified', time_basis: 'collector', action: null }), '内容修改');
  assert.equal(eventKindLabel({ kind: 'decision_raised', time_basis: null, action: 'raised' }), '提出问题');
  assert.equal(eventKindLabel({ kind: 'decision_raised', time_basis: null, action: 'conflicted' }), '来源不一致');
  assert.equal(eventKindLabel({ kind: 'decision_changed', time_basis: null, action: 'confirmed' }), '来源记载已确认');
  assert.equal(eventKindLabel({ kind: 'decision_changed', time_basis: null, action: 'rejected' }), '被否决');
  assert.equal(eventKindLabel({ kind: 'read_error', time_basis: null, action: null }), '读取问题');
});

test('卡片两行制映射：文件名+角标+摘要原文，不伪造指标与版本段，口径前缀不再上卡', () => {
  const card = toCanvasCard(item({ ref_count: 7, version_count: 3, statement_count: 2 }), 1);
  assert.equal(card.slotId, 'sub_02');
  // 行1 大字 = 文件名（shortPath）；变更段由画布按 revisionId 解析真实版本号，GE 层留空不伪造
  assert.equal(card.fileName, '方案 A');
  assert.equal(card.dirPrefix, '');
  assert.equal(card.changeLabel, '');
  // 行2 = 摘要原文（headline 原样透出，不另造数）
  assert.equal(card.detail, '文档自述日期：方案 A（2026-11-05）');
  // 底行角标 = HH:MM（observed_at 的本地时钟分量，不重复完整日期）；
  // TA-03：期望值由 Node 的 Date 本地字段独立算出（不再直接截 UTC 串）
  const observedDate = new Date(item().observed_at);
  const localClock = `${String(observedDate.getHours()).padStart(2, '0')}:${String(
    observedDate.getMinutes()
  ).padStart(2, '0')}`;
  // tf_4/D3 起[分类]前缀删除（与卡底首枚语义徽章恒同源、同卡重复），分类由徽章行独家承载：
  // 文档自述日期首枚徽章 TIM=轮次、modified 首枚 REV=版本、决策首枚 DEC=决策，均不再拼进角标
  assert.equal(card.observedClock, localClock);
  assert.equal(card.cornerLabel, localClock);
  assert.equal(card.refs, 7);
  assert.equal(card.versions, 3);
  assert.equal(card.statements, 2);
  assert.deepEqual(card.highlightedBadges, ['TIM']);
  // statusLine/title/subtitle/observedLabel 旧字段已删；口径前缀（文件时间/原文记为/检测）不再由 GE 生成
  assert.ok(!('statusLine' in card));
  assert.ok(!('observedLabel' in card));
  const cardText = [card.fileName, card.changeLabel, card.cornerLabel, card.observedClock].join('\n');
  assert.ok(!cardText.includes('文件时间'), '不应出现「文件时间」口径前缀');
  assert.ok(!cardText.includes('原文记为'), '不应出现「原文记为」口径前缀');
  assert.ok(!cardText.includes('检测'), '不应出现「检测」口径前缀');
  assert.ok(!cardText.includes('2026-11-05'), '卡内不再重复完整日期');

  const modified = toCanvasCard(item({ kind: 'modified', time_basis: 'collector' }), 0);
  assert.deepEqual(modified.highlightedBadges.sort(), ['MD', 'REV']);
  assert.ok(modified.activeBadges.includes('REV'));
  assert.ok(modified.activeBadges.includes('TIM'));
  assert.equal(modified.fileName, '方案 A', '文件类事件第一行仍是文件名');
  assert.equal(modified.cornerLabel, localClock, '角标仅时刻（本地时钟）；modified 首枚语义徽章 REV=版本由徽章行承载');

  const decision = toCanvasCard(
    item({ kind: 'decision_changed', action: 'confirmed', decision_id: 'dec_1', code: 'Q02', status: '已确认' }),
    2
  );
  // 决策类第一行 = 编号 + 状态变化（Q02 来源记载已确认），变更段/目录前缀为空
  assert.equal(decision.fileName, 'Q02 来源记载已确认');
  assert.ok(decision.fileName.includes('Q02'));
  assert.equal(decision.changeLabel, '', '决策事件无版本段');
  assert.equal(decision.dirPrefix, '', '决策事件无目录前缀');
  assert.equal(decision.cornerLabel, localClock, '角标仅时刻（本地时钟）；决策首枚语义徽章 DEC=决策由徽章行承载');
  assert.ok(decision.activeBadges.includes('DEC'));
  assert.ok(decision.activeBadges.includes('REL'));
  assert.deepEqual(decision.highlightedBadges, ['DEC']);
});

test('场景默认落在最新有日期的一天，日期待考单独成组且不会被误选', () => {
  const scene = buildCanvasEventScene(daysFixture());
  assert.ok(scene.hasRealEvents);
  assert.equal(scene.activeDate, '2026-11-05', '默认选最新有日期的一天');
  assert.equal(scene.active?.count, 3);
  assert.equal(scene.active?.matterCount, 2, '两个不同业务决定 = 两个事项');
  // tf_4/D2 排序权重：决策类（e2/e3，tier 0）恒先于新出现类（e1，tier 1）；同层内保持时刻降序
  assert.deepEqual(scene.active?.cards.map((c) => c.eventId), ['e2', 'e3', 'e1']);
  assert.equal(scene.totals.events, 5);
  assert.equal(scene.totals.days, 2);
  assert.equal(scene.totals.undated, 1);
  assert.equal(scene.totals.matters, 2);

  const undated = buildCanvasEventScene(daysFixture(), { activeDate: '' });
  assert.equal(undated.activeDate, '', '显式请求时选中日期待考组');
  assert.equal(undated.active?.label, '日期待考');
  assert.equal(undated.active?.cards[0].dateLabel, '日期待考');
});

test('标尺按真实日期降序（上新下旧）、导航只取最近四天、折叠组保留未展开数量', () => {
  const fixture = daysFixture();
  // 超过四天用来验证导航截断
  fixture.groups.unshift({
    date: '2026-11-06',
    count: 9,
    by_kind: { appeared: 9 },
    formats: { svg: 9 },
    decisions: [],
    samples: [item({ event_id: 'e6', file_path: 'a/图.svg' })],
  });
  const scene = buildCanvasEventScene(fixture, { maxCardsPerGroup: 2 });
  assert.deepEqual(scene.navigator.map((n) => n.date), ['2026-11-06', '2026-11-05', '2026-11-04', '']);
  // 全画布统一「上新下旧」：标尺 index 0 = 最新日期（11-06），向下越旧
  assert.deepEqual(scene.ruler.map((r) => r.date), ['2026-11-06', '2026-11-05', '2026-11-04']);
  assert.equal(scene.days[0].cards.length, 1);
  assert.equal(scene.days[0].more, 8, '组标题需要显示真实总数，卡片可折叠');
  assert.equal(scene.days[1].more, 1, '样本 3 条 / 上限 2 条 → 剩余 1 条');
});

test('截断刻度（更早 N 天）位于标尺数组尾=主干最底端，week/month 同向降序', () => {
  const truncated = daysFixture();
  truncated.hidden_days = 3;
  const scene = buildCanvasEventScene(truncated);
  const last = scene.ruler[scene.ruler.length - 1];
  assert.equal(last.isTruncation, true, '截断提示刻度在数组尾（渲染为主干最底端）');
  assert.match(last.label, /更早 3 天/);
  assert.equal(scene.ruler[0].date, '2026-11-05', '数组头仍是最最新一天');
  assert.ok(scene.ruler.filter((r) => r.isTruncation).length === 1);

  // week 聚合桶同向：新 → 旧
  const weekly = daysFixture();
  weekly.granularity = 'week';
  const sceneWeek = buildCanvasEventScene(weekly);
  assert.deepEqual(
    sceneWeek.ruler.map((r) => r.date),
    ['2026-11-05', '2026-11-04']
  );

  // 周粒度 + 截断：截断桶仍在尾
  const weeklyHidden = daysFixture();
  weeklyHidden.granularity = 'week';
  weeklyHidden.hidden_days = 5;
  const sceneWeekHidden = buildCanvasEventScene(weeklyHidden);
  assert.equal(sceneWeekHidden.ruler[sceneWeekHidden.ruler.length - 1].isTruncation, true);
});

test('详情框卡片自左上到右下由新到旧（同日样本按时刻降序）', () => {
  const fixture = daysFixture();
  fixture.groups = fixture.groups.filter((g) => g.date === '2026-11-05');
  // e1 在 11-05 当天 05:07 观测；补两个更晚/更早时刻的同日样本验证排序键 (occurred_at || observed_at)
  fixture.groups[0].samples = [
    item({ event_id: 'late', occurred_at: '2026-11-05T18:00:00.000Z' }),
    item({ event_id: 'mid', occurred_at: '2026-11-05T12:00:00.000Z' }),
    item({ event_id: 'early', occurred_at: '2026-11-05T06:00:00.000Z' }),
  ];
  const scene = buildCanvasEventScene(fixture, { maxCardsPerGroup: 3 });
  assert.deepEqual(
    scene.active?.cards.map((c) => c.eventId),
    ['late', 'mid', 'early'],
    '同组卡片按发生时刻降序排列：新 → 旧'
  );
});

test('详情框排序权重：modified 与无 occurred 的 appeared 混排 modified 在前（同层仍时刻降序）', () => {
  const fixture = daysFixture();
  fixture.groups = fixture.groups.filter((g) => g.date === '2026-11-05');
  // modified：occurred=09:00（内容修改类，tier 0）
  // appeared×2：occurred_at=null/time_basis=file_mtime（首扫新出现，tier 1），观测时刻 18:00 与 05:07
  // 纯时刻降序会把 18:00 的 appeared 排最前；tier 主键生效后 modified 恒居首屏前部
  fixture.groups[0].samples = [
    item({
      event_id: 'appear_late',
      kind: 'appeared',
      time_basis: 'file_mtime',
      occurred_at: null,
      observed_at: '2026-11-05T18:00:00.000Z',
    }),
    item({
      event_id: 'modified_9am',
      kind: 'modified',
      time_basis: 'collector',
      occurred_at: '2026-11-05T09:00:00.000Z',
    }),
    item({
      event_id: 'appear_early',
      kind: 'appeared',
      time_basis: 'file_mtime',
      occurred_at: null,
      observed_at: '2026-11-05T05:07:40.170Z',
    }),
  ];
  const scene = buildCanvasEventScene(fixture, { maxCardsPerGroup: 3 });
  assert.deepEqual(
    scene.active?.cards.map((c) => c.eventId),
    ['modified_9am', 'appear_late', 'appear_early'],
    '决策/内容修改类恒先于新出现类；同为新出现类时仍按时刻新 → 旧'
  );
});

test('空数据时不伪造事件，交由调用方回退样本', () => {
  const scene = buildCanvasEventScene(null);
  assert.equal(scene.hasRealEvents, false);
  assert.equal(scene.active, null);
  assert.equal(scene.days.length, 0);
  assert.equal(scene.totals.events, 0);
});

test('同组重名文件自动加目录前缀区分（独立 dirPrefix 字段）', () => {
  const a = item({ event_id: 'a', file_path: 'runs/run-A/README.md', file_title: null });
  const b = item({ event_id: 'b', file_path: 'runs/run-B/README.md', file_title: null });
  const c = item({ event_id: 'c', file_path: 'docs/唯一文档.md', file_title: null });
  const scene = buildCanvasEventScene(
    {
      ok: true,
      index_generation: 1,
      order: 'occurred',
      granularity: 'day',
      from: null,
      to: null,
      total: 3,
      hidden_days: 0,
      undated_count: 0,
      groups: [
        {
          date: '2026-11-05',
          count: 3,
          by_kind: { appeared: 3 },
          formats: { md: 3 },
          decisions: [],
          samples: [a, b, c],
        },
      ],
    } as EventDaysResult,
    { maxCardsPerGroup: 3 }
  );
  const cards = scene.active?.cards || [];
  const readmeCards = cards.filter((c) => c.fileName === 'README');
  assert.equal(readmeCards.length, 2, '重名的两个 README 都以文件名为第一行大字');
  assert.ok(
    readmeCards.every((c) => /run-A|run-B/.test(c.dirPrefix)),
    '重名卡片的 dirPrefix 应带目录前缀区分'
  );
  assert.notEqual(readmeCards[0].dirPrefix, readmeCards[1].dirPrefix, '两个 README 的目录前缀互不相同');
  const unique = cards.find((c) => c.fileName === '唯一文档');
  assert.ok(unique, '不重名文件存在');
  assert.equal(unique!.dirPrefix, '', '不重名的文件不加目录前缀');
});

test('bucketDate 与 dateLabel 分离：桶键随服务端分组口径，dateLabel 恒为 occurred 日', () => {
  // 同一条事件：occurred_at=2026-11-04（材料记载日）、observed_at=2026-11-05T05:07（采集日）
  const split = item({
    event_id: 'split',
    time_basis: 'collector',
    occurred_at: '2026-11-04',
    observed_at: '2026-11-05T05:07:40.170Z',
  });

  // observed 口径：服务端按 observed 日分桶（组键 2026-11-05）——bucketDate=桶键，dateLabel=occurred 日
  const observedCard = toCanvasCard(split, 0, new Set(), '2026-11-05');
  assert.equal(observedCard.bucketDate, '2026-11-05', 'bucketDate=所属组桶键（observed 口径服务端分组）');
  assert.equal(observedCard.dateLabel, '2026-11-04', 'dateLabel 仍为 occurred 日（供 timeRange 展示）');

  // occurred 口径：服务端按 occurred 日分桶（组键 2026-11-04）——bucketDate=dateLabel=组键
  const occurredCard = toCanvasCard(split, 1, new Set(), '2026-11-04');
  assert.equal(occurredCard.bucketDate, '2026-11-04');
  assert.equal(occurredCard.dateLabel, '2026-11-04');
  assert.equal(occurredCard.bucketDate, occurredCard.dateLabel);

  // 缺省第 4 参：bucketDate 回退 ''（日期待考口径）
  assert.equal(toCanvasCard(split, 2).bucketDate, '');

  // 场景映射：toGroup 把 group.date 透传为该组全部卡片的 bucketDate（含日期待考组）
  const scene = buildCanvasEventScene(daysFixture());
  const nov5 = scene.days.find((g) => g.date === '2026-11-05');
  assert.ok(nov5);
  assert.ok(nov5!.cards.every((c) => c.bucketDate === '2026-11-05'));
  const undated = buildCanvasEventScene(daysFixture(), { activeDate: '' });
  assert.equal(undated.days.find((g) => g.date === '')!.cards[0].bucketDate, '');
});
