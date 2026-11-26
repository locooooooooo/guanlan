import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalRelationGraph } from '../src/utils/guanlanEngine';
import type { DecisionAssertion, FileRecord, RelationEdge, Revision } from '../src/types/guanlan';

function revision(over: Partial<Revision> & Pick<Revision, 'revision_id'>): Revision {
  return {
    file_id: 'f',
    versionNumber: 1,
    content_sha256: `sha-${over.revision_id}`,
    observed_at: '2026-11-17T10:00:00+08:00',
    sizeBytes: 100,
    snapshotAvailable: true,
    summaryNote: 'v1',
    ...over,
  };
}

function fileOf(id: string, revisions: Revision[]): FileRecord {
  return {
    file_id: id,
    relative_path: `docs/${id}.md`,
    title: `标题 ${id}`,
    format: 'md',
    folder: 'docs',
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revisions[revisions.length - 1].revision_id,
    revisions,
    coverage: 'full_text',
  };
}

function decisionOf(id: string, code: string, status = '待确认'): DecisionAssertion {
  return {
    decision_id: id,
    code,
    namespace: '项目 / 决策集',
    question: `${code} 的问题？`,
    status,
    isCandidateOnly: false,
    options: [],
    recommendation: '',
    impactBlocked: [],
    impactAllowed: [],
    evidences: [],
    topic: '项目 / 决策集',
  } as DecisionAssertion;
}

function edgeOf(id: string, source: string, target: string): RelationEdge {
  return {
    edge_id: id,
    source_id: source,
    target_id: target,
    type: 'explicit_reference',
    isInferred: false,
    label: '显式引用',
    reason: '正文链接',
  } as RelationEdge;
}

test('节点经 ID Map 解析：1 跳邻居与决定节点都能命中，未知 id 被忽略', () => {
  const files = [fileOf('f_a', [revision({ revision_id: 'f_a_r1' })]), fileOf('f_b', [revision({ revision_id: 'f_b_r1' })])];
  const decisions = [decisionOf('dec_1', 'Q1')];
  const edges = [
    edgeOf('e1', 'f_a', 'f_b'),
    edgeOf('e2', 'f_a', 'dec_1'),
    edgeOf('e3', 'f_a', 'unknown_id'),
  ];
  const graph = buildLocalRelationGraph('f_a', 1, files, decisions, edges);
  const ids = graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['dec_1', 'f_a', 'f_b'], '可解析邻居全部入图，未知 id 忽略');
  assert.equal(graph.nodes.find((n) => n.id === 'f_a')?.hop, 0, '中心节点 hop=0');
  assert.equal(graph.nodes.filter((n) => n.id !== 'f_a').every((n) => n.hop === 1), true);
  assert.deepEqual(graph.edges.map((e) => e.edge_id).sort(), ['e1', 'e2']);
  assert.equal(graph.truncatedCount, 0);
});

test('邻接表：二跳只从一跳节点出发，canExpandTwoHop 与 depth 语义保持', () => {
  const files = ['f_a', 'f_b', 'f_c', 'f_d'].map((id) => fileOf(id, [revision({ revision_id: `${id}_r1` })]));
  const edges = [
    edgeOf('e1', 'f_a', 'f_b'),
    edgeOf('e2', 'f_b', 'f_c'),
    edgeOf('e3', 'f_d', 'f_c'),
  ];

  const depth1 = buildLocalRelationGraph('f_a', 1, files, [], edges);
  assert.equal(depth1.canExpandTwoHop, true, '存在二跳候选');
  assert.deepEqual(depth1.nodes.map((n) => n.id).sort(), ['f_a', 'f_b'], 'depth=1 不含二跳节点');
  assert.deepEqual(depth1.edges.map((e) => e.edge_id), ['e1']);

  const depth2 = buildLocalRelationGraph('f_a', 2, files, [], edges);
  assert.deepEqual(depth2.nodes.map((n) => n.id).sort(), ['f_a', 'f_b', 'f_c'], 'depth=2 纳入 f_c');
  assert.equal(depth2.nodes.find((n) => n.id === 'f_c')?.hop, 2);
  assert.deepEqual(depth2.edges.map((e) => e.edge_id).sort(), ['e1', 'e2'], '只含连通到中心的边');

  assert.equal(depth2.nodes.some((n) => n.id === 'f_d'), false);
});

test('边去重：同一事件对间的多条边不重复入列（边 Set 语义）', () => {
  const files = ['f_a', 'f_b'].map((id) => fileOf(id, [revision({ revision_id: `${id}_r1` })]));
  const edges = [edgeOf('e1', 'f_a', 'f_b')];
  const graph = buildLocalRelationGraph('f_a', 2, files, [], edges);
  assert.equal(graph.edges.length, 1, '同一条边不重复');
  assert.equal(graph.truncatedCount, 0);
});

test('回滚标记单遍索引：A→B→A 恢复与相邻相同 hash 两种语义保持', () => {
  const H_A = 'hash-a';
  const H_B = 'hash-b';
  const revs = [
    revision({ revision_id: 'r1', content_sha256: H_A, versionNumber: 1 }),
    revision({ revision_id: 'r2', content_sha256: H_B, versionNumber: 2 }),
    revision({ revision_id: 'r3', content_sha256: H_A, versionNumber: 3 }),
  ];
  const graph = buildLocalRelationGraph(
    'f_roll',
    1,
    [fileOf('f_roll', revs)],
    [],
    []
  );
  const evolutionLabels = graph.edges.map((e) => e.label);
  assert.equal(evolutionLabels.includes('A→B→A 恢复'), true, '第三版标记恢复');
  assert.equal(evolutionLabels.filter((l) => l === '版本演进').length, 1, '第二版为普通演进');

  const revs2 = [
    revision({ revision_id: 'q1', content_sha256: 'x', versionNumber: 1 }),
    revision({ revision_id: 'q2', content_sha256: 'y', versionNumber: 2 }),
    revision({ revision_id: 'q3', content_sha256: 'y', versionNumber: 3 }),
  ];
  const graph2 = buildLocalRelationGraph('f_roll2', 1, [fileOf('f_roll2', revs2)], [], []);
  assert.equal(
    graph2.edges.filter((e) => e.label === 'A→B→A 恢复').length,
    1,
    '相邻相同内容同样识别为恢复（内容重复出现）'
  );
});

test('预算在物化过程中生效：maxNodes 限制节点数，truncatedCount 独立统计不虚报', () => {
  const center = fileOf('f_center', [revision({ revision_id: 'f_center_r1' })]);
  const neighbors = Array.from({ length: 20 }, (_, i) =>
    fileOf(`f_n${i}`, [revision({ revision_id: `f_n${i}_r1` })])
  );
  const edges = neighbors.map((n, i) => edgeOf(`e${i}`, 'f_center', n.file_id));

  const graph = buildLocalRelationGraph('f_center', 1, [center, ...neighbors], [], edges, 5);
  assert.equal(graph.nodes.length, 5, '物化节点数不超过预算');
  assert.equal(graph.nodes[0].id, 'f_center', '中心节点必在其中');
  assert.equal(
    graph.truncatedCount,
    21 - 5,
    '溢出计数 = 可解析节点总数 - 预算（独立统计，不因早停虚报）'
  );
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.equal(
    graph.edges.every((e) => ids.has(e.source_id) && ids.has(e.target_id)),
    true,
    '不含端点未物化的悬空边'
  );
});

test('版本演进节点同样受预算约束：版本多时不突破 maxNodes', () => {
  const revs = Array.from({ length: 10 }, (_, i) =>
    revision({ revision_id: `rr${i}`, versionNumber: i + 1, content_sha256: `h${i}` })
  );
  const graph = buildLocalRelationGraph('f_many', 1, [fileOf('f_many', revs)], [], [], 4);
  assert.equal(graph.nodes.length, 4, '中心 + 版本节点总数受预算');
  assert.equal(graph.truncatedCount, 10 - 3, '未物化的 7 个版本节点进入溢出计数');
});

test('中心节点不存在：返回空图且不虚报 canExpandTwoHop', () => {
  const graph = buildLocalRelationGraph('nope', 2, [fileOf('f_a', [revision({ revision_id: 'r1' })])], [], []);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.equal(graph.truncatedCount, 0);
  assert.equal(graph.canExpandTwoHop, false);
});
