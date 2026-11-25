import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVersionChain } from '../src/utils/documentDiff';
import type { FileHistory, FileHistoryRevision } from '../src/services/workspaceClient';
import {
  MACHINE_VIEW_H,
  timeMachineNodeY,
  timeMachineSpacing,
  timeMachineTrunkEnd,
  versionAxisNotice,
} from '../src/components/DocumentTimeMachineView';

/**
 * TL-02：版本时光机画布几何不溢出（验收两档中的「确定性自动化档」）。
 *
 * 画布 viewBox 固定 0 0 794 640（DocumentTimeMachineView.tsx:312）。
 * 几何由 timeMachineSpacing/timeMachineNodeY/timeMachineTrunkEnd 纯函数决定，
 * 保证任意链长 trunkEnd = nodeY(len-1)+26 ≤ MACHINE_VIEW_H(640)，不收束成溢出截断。
 *
 * 数据源与 derive 同源：fixture 复用 documentDiff.buildVersionChain 产出版本链，
 * 与 v04-round1 所用的 derive 扫描产出同一演进路径（seed 确定性、内容可预知）。
 */

// ---------- 确定性 fixture：≥6 连续版本（每版内容可预知，经 buildVersionChain 演进） ----------

function revision(
  seq: number,
  over: Partial<FileHistoryRevision> = {}
): FileHistoryRevision {
  // fixture 的 seq 与 occurred 日同向（seq 越大日期越晚）；
  // buildVersionChain 主序为 seq 降序，故链天然新→旧，日期恰好同向（几何断言与排序口径无关）
  const day = String(seq).padStart(2, '0');
  return {
    revision_id: `rev_${seq}`,
    seq,
    prev_revision_id: seq > 1 ? `rev_${seq - 1}` : null,
    content_hash: `hash_${seq}`,
    size_bytes: 1024 + seq * 37,
    observed_at: `2026-11-${day}T05:07:40+08:00`,
    occurred_at: `2026-11-${day}`,
    occurred_precision: 'day',
    occurred_source: 'document_self',
    snapshot_available: true,
    ...over,
  };
}

function historyOf(revisions: FileHistoryRevision[], total = revisions.length): FileHistory {
  return {
    ok: true,
    file: {
      file_id: 'f_tm01',
      current_path: 'closeout/TIMELINE.MD',
      title: 'TIMELINE',
      format: 'md',
      role: '方案',
      status: 'active',
      first_observed_at: '2026-11-01T05:07:40+08:00',
      last_observed_at: `2026-11-${String(total).padStart(2, '0')}T05:07:40+08:00`,
      last_revision_id: revisions.at(-1)?.revision_id ?? null,
    },
    revisions,
    events: [],
    statements: [],
    edges: [],
  };
}

function fixtureChain(total: number) {
  const revs: FileHistoryRevision[] = [];
  for (let seq = 1; seq <= total; seq++) revs.push(revision(seq));
  // 传入顺序无关：buildVersionChain 以 seq 降序为主序，组件实际拿到的是该输出，
  // 故这也与真实渲染路径一致。
  return buildVersionChain(historyOf(revs, total));
}

// ---------- 测试 ----------

test('TL-02：确定性 fixture 产出连续版本链（8 版，buildVersionChain 路径）', () => {
  const chain = fixtureChain(8);
  assert.equal(chain.length, 8);
  assert.equal(chain[0].label, 'v8'); // 新 → 旧
  assert.equal(chain[7].label, 'v1');
  assert.equal(chain[7].isBaseline, true);
  // 锚点单调降序（上新下旧）
  for (let i = 1; i < chain.length; i++) {
    assert.ok(chain[i].anchorAt < chain[i - 1].anchorAt, `anchor ${i} 应 < ${i - 1}`);
  }
});

test('TL-02：6~12 连续版本链全部节点与 trunkEnd 落在 viewBox 640 内', () => {
  for (let n = 6; n <= 12; n++) {
    // 真实组件按 buildVersionChain 输出取 chain.length
    const chain = fixtureChain(n);
    const len = chain.length;
    for (let i = 0; i < len; i++) {
      const y = timeMachineNodeY(i, len);
      assert.ok(y >= 0 && y <= MACHINE_VIEW_H, `len=${len} node[${i}] y=${y} 越界`);
      assert.equal(y, 170 + i * timeMachineSpacing(len), 'nodeY = NODE_Y0 + i*spacing');
    }
    const end = timeMachineTrunkEnd(len);
    assert.equal(end, timeMachineNodeY(len - 1, len) + 26, 'trunkEnd = nodeY(n-1)+26');
    assert.ok(end <= MACHINE_VIEW_H, `len=${n} trunkEnd=${end} > 640 溢出`);
  }
});

test('TL-02：spacing 按链长收束（>7 不再用 96/64 粗档，细致收束保证不溢出）', () => {
  // 旧实现在 len=6（96）trunkEnd=676、len=8（64）trunkEnd=644 均溢出；
  // 新实现下 spacing ≤ 原有 96/64，且小于等于「装得下的上限」
  for (const n of [6, 7, 8, 12]) {
    const sp = timeMachineSpacing(n);
    assert.ok(sp >= 1 && sp <= 96, `len=${n} spacing=${sp}`);
    // 单调收束：链越长间距越紧
    if (n > 6) assert.ok(timeMachineSpacing(n) <= timeMachineSpacing(6), `len=${n} 应 ≤ len6`);
  }
  // 长链仍收敛在视图内：20 链也不溢出
  assert.ok(timeMachineTrunkEnd(20) <= MACHINE_VIEW_H);
});

test('TL-02：节点自上而下严格单调（上新下旧视觉方向）', () => {
  for (const n of [6, 12]) {
    let prev = timeMachineNodeY(0, n);
    for (let i = 1; i < n; i++) {
      const y = timeMachineNodeY(i, n);
      assert.ok(y > prev, `len=${n} node${i} 未向下移动`);
      prev = y;
    }
  }
});

// ---------- 版本轴强制标注排序口径 ----------

test('版本轴恒显示『按修订链』角标；occurred 与收录顺序矛盾时强制提示', () => {
  // 顺序 fixture：seq 越大 occurred 日越晚 → 无矛盾，但角标仍必须出现
  const ordered = fixtureChain(6);
  const orderedNotice = versionAxisNotice(ordered);
  assert.equal(orderedNotice.badge, '按修订链');
  assert.equal(orderedNotice.notice, null);

  // 逆序 fixture：seq 越大 occurred 日越早（文档自述日期与收录顺序相反）
  const reversedRevs: FileHistoryRevision[] = [];
  for (let seq = 1; seq <= 6; seq++) {
    reversedRevs.push(revision(seq, { occurred_at: `2026-11-${String(7 - seq).padStart(2, '0')}` }));
  }
  const reversed = buildVersionChain(historyOf(reversedRevs, 6));
  assert.deepEqual(reversed.map((node) => node.label), ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']);
  const reversedNotice = versionAxisNotice(reversed);
  assert.equal(reversedNotice.badge, '按修订链', '矛盾时角标同样必须在场');
  assert.equal(reversedNotice.notice, '文档自述日期与收录顺序不一致');
});