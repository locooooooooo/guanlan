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



function revision(
  seq: number,
  over: Partial<FileHistoryRevision> = {}
): FileHistoryRevision {
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
  return buildVersionChain(historyOf(revs, total));
}


test('TL-02：确定性 fixture 产出连续版本链（8 版，buildVersionChain 路径）', () => {
  const chain = fixtureChain(8);
  assert.equal(chain.length, 8);
  assert.equal(chain[0].label, 'v8');
  assert.equal(chain[7].label, 'v1');
  assert.equal(chain[7].isBaseline, true);
  for (let i = 1; i < chain.length; i++) {
    assert.ok(chain[i].anchorAt < chain[i - 1].anchorAt, `anchor ${i} 应 < ${i - 1}`);
  }
});

test('TL-02：6~12 连续版本链全部节点与 trunkEnd 落在 viewBox 640 内', () => {
  for (let n = 6; n <= 12; n++) {
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
  for (const n of [6, 7, 8, 12]) {
    const sp = timeMachineSpacing(n);
    assert.ok(sp >= 1 && sp <= 96, `len=${n} spacing=${sp}`);
    if (n > 6) assert.ok(timeMachineSpacing(n) <= timeMachineSpacing(6), `len=${n} 应 ≤ len6`);
  }
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


test('版本轴恒显示『按修订链』角标；occurred 与收录顺序矛盾时强制提示', () => {
  const ordered = fixtureChain(6);
  const orderedNotice = versionAxisNotice(ordered);
  assert.equal(orderedNotice.badge, '按修订链');
  assert.equal(orderedNotice.notice, null);

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