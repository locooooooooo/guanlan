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

const SLOT_DATE = '2026-10-01';

function marginValues(html: string): number[] {
  return [...html.matchAll(/margin-left:(\d+(?:\.\d+)?)(?:px)?/g)].map((m) => Number(m[1]));
}


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

  assert.equal(formatSlotChipLabel(7), '+7');
  assert.equal(formatSlotChipLabel(496), '+496');
});


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

  assert.deepEqual(
    marginValues(html).sort((a, b) => a - b),
    [0, 4, 8, 16],
    '恰好 4 个偏移：pill 0/4/8 互不重合，芯片在 16 不压任何 pill'
  );

  assert.ok(html.includes('日期待考'), 'undated 尾槽渲染路径保持原样');
});


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
  assert.ok(
    html.replace(/<!-- -->/g, '').includes(`${SLOT_DATE} · 7 份`),
    '清单头计数与芯片「+7」同一 N 口径'
  );
});


test('日历事件行不受影响：eventTicks 刻度照常按 source_time 落轴渲染', () => {
  const ev = {
    event_id: 'ev_tlcal',
    kind: 'modified',
    file_id: 'f_x',
    revision_id: 'r_x',
    observed_at: '2026-11-01T00:00:00Z',
    source_time: '2026-10-05',
    topic_lane: 'docs',
    headline: '样例事件',
    detail: '',
  } as unknown as TimelineEvent;
  const html = renderToString(
    createElement(CalendarBoardView, {
      files: [file(SLOT_DATE)],
      events: [ev],
      onOpenDocument: () => {},
    })
  );
  assert.ok(
    html.includes('2026-10-05 modified 样例事件'),
    '事件刻度 title 渲染路径与改动前一致'
  );
});
