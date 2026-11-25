import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  CalendarBoardView,
  SLOT_PILL_LIMIT,
  SlotDayList,
  formatSlotChipLabel,
  splitSlotForRender,
} from '../src/components/CalendarBoardView';
import type { FileRecord, TimelineEvent } from '../src/types/guanlan';

/**
 * 日历板同槽 >3 份文档不可点修复（前 3 枚 pill + 「+N」聚合芯片）。
 *
 * 旧实现（CalendarBoardView 原 251-252）：同槽堆叠用 marginLeft:(j%3)*4、zIndex:(j%3)+1，
 * 第 4 枚起与前 3 枚位置逐像素重合、zIndex 循环，被覆盖者完全不可命中
 * （走查口径单日 206/165 份不可点，引自 ask，本环境不可复跑）。
 * 新实现：同槽只直渲染前 3 枚（偏移 j*4 互不重合，(j%3) 乘积项从样式计算中移除），
 * 第 4 份起由「+N」芯片承载全量入口——N 写该槽总份数；芯片点击展开当日清单 popover，
 * 条目数 = 槽全部份数，逐条回调 onOpenDocument。
 *
 * 测试分两层：纯函数（splitSlotForRender/formatSlotChipLabel）+ renderToString 结构断言
 * （react-dom/server，node 无 DOM 事件——「芯片点击展开/条目点击回调」的接线由代码保证，
 * 见文末对账注释）。
 */

// ---------- 夹具：最小 FileRecord（组件只读 file_id/folder/format/title/revisions[0].source_time） ----------

let seq = 0;
function file(date: string | null): FileRecord {
  seq += 1;
  return {
    file_id: `f_tlcal_${String(seq).padStart(3, '0')}`,
    folder: 'docs',
    title: `文档 ${seq}`,
    relative_path: `docs/doc-${seq}.md`,
    format: 'md',
    current_revision_id: `rev_${seq}`,
    coverage: 'full_text',
    revisions: date ? [{ revision_id: `rev_${seq}`, source_time: date }] : [],
  } as unknown as FileRecord;
}

const SLOT_DATE = '2026-10-01'; // 纯日期：localDay 原样返回，任意时区确定

/** 提取渲染串中全部 margin-left 数值（单位无关：React 19 对 0 不带 px 后缀） */
function marginValues(html: string): number[] {
  return [...html.matchAll(/margin-left:(\d+(?:\.\d+)?)(?:px)?/g)].map((m) => Number(m[1]));
}

// ---------- 验收 1（纯函数层）：7 份拆为前 3 pill + 芯片 N=总份数；(j%3) 口径不复存在 ----------

test('日历同槽聚合纯函数：7 份槽 → 前 3 枚 pill + 芯片 N=7；≤3 份槽不出芯片', () => {
  assert.equal(SLOT_PILL_LIMIT, 3, '可见 pill 上限为 3（与旧版可触达数一致）');

  const seven = splitSlotForRender([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(seven.pills, [1, 2, 3], '只直渲染前 3 枚（保持槽内序）');
  assert.equal(seven.chipTotal, 7, '芯片 N = 该槽总份数（实际总数），不是剩余数');

  const three = splitSlotForRender([1, 2, 3]);
  assert.deepEqual(three.pills, [1, 2, 3]);
  assert.equal(three.chipTotal, null, '恰好 3 份不出现芯片');

  const two = splitSlotForRender([1, 2]);
  assert.equal(two.pills.length, 2);
  assert.equal(two.chipTotal, null, '≤3 份槽与旧版同构、无芯片');

  // 芯片文案与断言写死同一 N 口径：+7；走查口径最大单日 496 份同样成立
  assert.equal(formatSlotChipLabel(7), '+7');
  assert.equal(formatSlotChipLabel(496), '+496');
});

// ---------- 验收 1（渲染层）：7 份槽 = 恰好 3 pill + 1 芯片「+7」，pill 偏移互不重合 ----------

test('日历同槽聚合渲染：7 份槽恰好 3 pill + 1 芯片「+7」，(j%3) 逐像素重合不再发生', () => {
  const files = [...Array.from({ length: 7 }, () => file(SLOT_DATE)), file(null)];
  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );

  assert.equal(
    html.split('data-slot-doc-pill').length - 1,
    3,
    '同槽 7 份只渲染 3 枚可点 pill'
  );
  assert.equal(html.split('data-slot-chip').length - 1, 1, '恰好 1 枚聚合芯片');
  assert.ok(html.includes('>+7</button>'), '芯片文案逐字为「+7」（N=槽总份数）');

  // (j%3) 乘积项已从样式计算中移除：渲染出的 margin 偏移各出现一次，无循环重合
  // （旧实现 7 份会渲染 margins 0,4,8,0,4,8,4 → 7 枚 pill、0 偏移出现 3 次）
  assert.deepEqual(
    marginValues(html).sort((a, b) => a - b),
    [0, 4, 8, 16],
    '恰好 4 个偏移：pill 0/4/8 互不重合，芯片在 16 不压任何 pill'
  );

  // 待考尾槽（原 :266 同款 j%3）本轮不动：undated 文档仍走旧 span 渲染路径
  assert.ok(html.includes('日期待考'), 'undated 尾槽渲染路径保持原样');
});

// ---------- 验收 3：≤3 份的槽渲染与现版同构（不出现芯片；3 份为不出芯片的边界） ----------

test('日历同槽聚合渲染：≤3 份槽不出芯片（2 份/恰好 3 份两档边界）', () => {
  for (const n of [2, 3]) {
    const html = renderToString(
      createElement(CalendarBoardView, {
        files: Array.from({ length: n }, () => file(SLOT_DATE)),
        events: [],
        onOpenDocument: () => {},
      })
    );
    assert.equal(
      html.split('data-slot-doc-pill').length - 1,
      n,
      `${n} 份槽直渲染 ${n} 枚 pill`
    );
    assert.equal(html.split('data-slot-chip').length - 1, 0, `${n} 份槽不出现芯片`);
    assert.deepEqual(
      marginValues(html),
      Array.from({ length: n }, (_, j) => j * 4),
      `${n} 份槽偏移模式与旧版一致（j*4，互不重合）`
    );
  }
});

// ---------- 验收 2（清单层）：芯片展开的清单条目数 = 槽全部份数，逐条携带该槽 fileId ----------

test('日历当日清单：条目数=槽全部份数（7），逐条携带该槽 fileId，头计数同一 N 口径', () => {
  const items = Array.from({ length: 7 }, () => file(SLOT_DATE));
  const html = renderToString(
    createElement(SlotDayList, {
      date: SLOT_DATE,
      items,
      left: 400,
      top: 200,
      onOpenDocument: () => {},
      onClose: () => {},
    })
  );
  assert.equal(
    html.split('data-slot-day-item').length - 1,
    7,
    '清单条目数 = 该槽全部份数（不是 3）'
  );
  for (const f of items) {
    assert.ok(
      html.includes(`data-file-id="${f.file_id}"`),
      `清单逐条携带该槽文件 ${f.file_id}`
    );
  }
  // React SSR 会在相邻文本表达式间插入 <!-- --> 标记，剥离后再做逐字比对
  assert.ok(
    html.replace(/<!-- -->/g, '').includes(`${SLOT_DATE} · 7 份`),
    '清单头计数与芯片「+7」同一 N 口径'
  );
});

// ---------- 验收 4：EVENTS 行（事件刻度）渲染路径不受本次改动影响 ----------

test('日历事件行不受影响：eventTicks 刻度照常按 source_time 落轴渲染', () => {
  const ev = {
    event_id: 'ev_tlcal',
    kind: 'modified',
    file_id: 'f_x',
    revision_id: 'r_x',
    observed_at: '2026-11-01T00:00:00Z', // 采集时间，事件定位不用它
    source_time: '2026-10-05',
    topic_lane: 'docs',
    headline: '样例事件',
    detail: '',
  } as unknown as TimelineEvent;
  const html = renderToString(
    createElement(CalendarBoardView, {
      // files 非空才渲染行区（含 EVENTS 行）；空索引走空状态分支
      files: [file(SLOT_DATE)],
      events: [ev],
      onOpenDocument: () => {},
    })
  );
  // 事件刻度 title 形如「${date} ${kind} ${headline}」（本文件原 EVENTS 行模板，未改动）
  assert.ok(
    html.includes('2026-10-05 modified 样例事件'),
    '事件刻度 title 渲染路径与改动前一致'
  );
});
