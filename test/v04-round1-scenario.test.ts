import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { reconcileWorkspace } from '../server/reconcile';
import { WorkspaceStore } from '../server/WorkspaceStore';


const A_CONTENT = [
  '# 统一验收入口修复方案',
  '',
  '文档日期：2026-11-05',
  '状态：只读调查完成，实施范围待确认。',
  '',
  '## 核心结论',
  '沿用现有 3091 固定验收入口。',
  '',
  '## 已核实的原因',
  '启动脚本与候选发布进程各自记账。',
  '',
  '## 需你决策',
  '### Q02：实施范围是否包含候选发布',
  '- **当前状态**：待确认',
  '- **选项 A**：先修启动脚本',
  '- **选项 B**：同时纳入候选发布',
].join('\n');

const B_CONTENT = A_CONTENT.replace(
  '状态：只读调查完成，实施范围待确认。',
  '状态：已按选项 A 执行，等待用户验收。'
).replace(
  '## 已核实的原因\n启动脚本与候选发布进程各自记账。',
  '## 已核实的原因\n启动脚本与候选发布进程各自记账；4.2 补充：release 清单与实际 PID 不一致。'
);

const C_CONTENT = A_CONTENT;

const SVG_CONTENT = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">',
  '  <rect width="200" height="120" fill="#0f172a"/>',
  '  <text x="100" y="60" fill="#f8fafc" text-anchor="middle">固定验收入口方案</text>',
  '</svg>',
].join('\n');

const PDF_BYTES = Buffer.from(
  ['%PDF-1.4', '1 0 obj', '<< /Type /Catalog /Pages 2 0 R >>', 'endobj', '%%EOF'].join('\n'),
  'latin1'
);

interface Fixture {
  root: string;
  dataDir: string;
}

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-r1-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, '.data');
  fs.mkdirSync(root, { recursive: true });

  fs.mkdirSync(path.join(root, '01-方案文档'), { recursive: true });
  fs.writeFileSync(path.join(root, '01-方案文档', '01-修复方案.md'), A_CONTENT, 'utf-8');
  fs.writeFileSync(path.join(root, '01-方案文档', '固定验收入口方案.svg'), SVG_CONTENT, 'utf-8');
  fs.mkdirSync(path.join(root, '02-规范'), { recursive: true });
  fs.writeFileSync(path.join(root, '02-规范', '接口规范.pdf'), PDF_BYTES);

  return { root, dataDir };
}

function eventRows(store: WorkspaceStore): Array<{ kind: string; seq: number; headline: string }> {
  return store.db
    .prepare('SELECT kind, seq, headline FROM events ORDER BY seq ASC')
    .all() as unknown as Array<{ kind: string; seq: number; headline: string }>;
}

function fileByPath(store: WorkspaceStore, relPath: string) {
  const row = store.db
    .prepare('SELECT * FROM files WHERE current_path = ?')
    .get(relPath) as unknown as { file_id: string } | undefined;
  assert.ok(row, `应能按路径找到文件：${relPath}`);
  return row!;
}

function versionsOf(store: WorkspaceStore, fileId: string) {
  return store.revisionsOfFile(fileId);
}

function textOfRevision(store: WorkspaceStore, revisionId: string): string {
  const rev = store.getRevision(revisionId);
  assert.ok(rev, `版本应存在：${revisionId}`);
  const buf = store.readSnapshot(rev!.content_hash);
  assert.ok(buf, `版本快照应可读取：${revisionId}`);
  return buf!.toString('utf-8');
}

test('第一轮纵向场景：基线 → 重扫 → 仅 mtime → 改两次 → A→B→A → 重启后逐版可回看', () => {
  const { root, dataDir } = makeFixture();
  const mdRel = '01-方案文档/01-修复方案.md';

  const scan1 = reconcileWorkspace(root, { dataDir, now: '2026-11-06T09:00:00.000Z' });
  const store1 = scan1.store;
  try {
    assert.equal(scan1.report.initialBaseline, true);
    assert.equal(scan1.report.scanned, 3, '场景应有 3 份资料');
    const events1 = eventRows(store1);
    const baseline = events1.filter((e) => e.kind === 'workspace_baseline');
    assert.equal(baseline.length, 1, '首次扫描只有一张基线卡');
    assert.match(baseline[0].headline, /首次纳入 3 份资料/);

    const dated = events1.filter((e) => e.kind === 'appeared');
    assert.equal(dated.length, 1, '只有带自述日期的材料单独入轴');
    const mdFile = fileByPath(store1, mdRel);
    const v1Rows = versionsOf(store1, mdFile.file_id);
    assert.equal(v1Rows[0].occurred_at, '2026-11-05');
    assert.equal(v1Rows[0].occurred_precision, 'day', '只有日期时保留到天，不补零点');
    assert.equal(v1Rows[0].occurred_source, 'document_self');

    const decisionEvents = events1.filter(
      (e) => e.kind === 'decision_raised' || e.kind === 'decision_changed'
    );
    assert.equal(decisionEvents.length, 1, 'Q02 首次提出应有一条决策事件');

    assert.equal(v1Rows.length, 1);
    assert.equal(v1Rows[0].seq, 1);
    assert.equal(v1Rows[0].prev_revision_id, null);
    assert.equal(textOfRevision(store1, v1Rows[0].revision_id), A_CONTENT, '基线版本正文应与原文一致');

    const allFiles = store1.listFiles(scan1.report.workspaceId);
    assert.equal(allFiles.length, 3);
    for (const f of allFiles) assert.equal(versionsOf(store1, f.file_id).length, 1);
  } finally {
    store1.close();
  }

  const scan2 = reconcileWorkspace(root, { dataDir, now: '2026-11-06T09:05:00.000Z' });
  try {
    assert.equal(scan2.report.eventsInserted, 0, '重复扫描不应插入事件');
    assert.equal(scan2.report.decisionEventsInserted, 0, '同状态复述不应新增决策事件');
    assert.equal(scan2.report.newRevisions, 0, '重复扫描不应新增版本');
    assert.equal(eventRows(scan2.store).length, 3, '基线 + 自述日期 + 决策提出');
  } finally {
    scan2.store.close();
  }

  const mdFull = path.join(root, mdRel);
  fs.utimesSync(mdFull, new Date('2026-11-07T10:00:00Z'), new Date('2026-11-07T10:00:00Z'));
  const scan3 = reconcileWorkspace(root, { dataDir, now: '2026-11-07T10:01:00.000Z' });
  try {
    assert.equal(scan3.report.newRevisions, 0, '仅 mtime 变化不得新增内容版本');
    assert.equal(scan3.report.eventsInserted, 0);
    assert.equal(scan3.report.mtimeOnly, 1, '应识别出「只有时间戳变化」的文件');
    const md = fileByPath(scan3.store, mdRel);
    assert.equal(versionsOf(scan3.store, md.file_id).length, 1);
  } finally {
    scan3.store.close();
  }

  fs.writeFileSync(mdFull, B_CONTENT, 'utf-8');
  fs.utimesSync(mdFull, new Date('2026-11-08T11:00:00Z'), new Date('2026-11-08T11:00:00Z'));
  const scan4 = reconcileWorkspace(root, { dataDir, now: '2026-11-08T11:01:00.000Z' });
  try {
    assert.equal(scan4.report.newRevisions, 1, '第一次修改应产生一个版本');
    assert.equal(scan4.report.eventsInserted, 1, '第一次修改应产生一条修改事件');
    const md = fileByPath(scan4.store, mdRel);
    const versions = versionsOf(scan4.store, md.file_id);
    assert.equal(versions.length, 2);
    assert.equal(versions[1].seq, 2);
    assert.equal(versions[1].prev_revision_id, versions[0].revision_id, '版本链应指向上一版');
    assert.equal(
      versions[1].occurred_source,
      'file_mtime',
      '修改事件的发生时间应回答「这次改动何时发生」，不能沿用文档自述日期'
    );
    assert.equal(versions[0].occurred_source, 'document_self', '首版保留文档自述日期');
    assert.equal(textOfRevision(scan4.store, versions[1].revision_id), B_CONTENT);
    const modified = eventRows(scan4.store).filter((e) => e.kind === 'modified');
    assert.equal(modified.length, 1);
    assert.match(modified[0].headline, /检测到更新/);
  } finally {
    scan4.store.close();
  }

  fs.writeFileSync(mdFull, C_CONTENT, 'utf-8');
  fs.utimesSync(mdFull, new Date('2026-11-09T12:00:00Z'), new Date('2026-11-09T12:00:00Z'));
  const scan5 = reconcileWorkspace(root, { dataDir, now: '2026-11-09T12:01:00.000Z' });
  const store5 = scan5.store;
  try {
    assert.equal(scan5.report.newRevisions, 1, '恢复旧内容仍是一次新的版本出现');
    const md = fileByPath(store5, mdRel);
    const versions = versionsOf(store5, md.file_id);
    assert.equal(versions.length, 3, 'A → B → A 应保留三次版本出现');
    assert.deepEqual(versions.map((v) => v.seq), [1, 2, 3]);

    const hashes = versions.map((v) => v.content_hash);
    assert.equal(hashes[0], hashes[2], 'A → B → A 的首末版本哈希应相同');
    assert.notEqual(hashes[1], hashes[0]);

    const uniqueHashes = new Set(hashes);
    assert.equal(uniqueHashes.size, 2, '三次出现只应有两份不同内容');
    for (const v of versions) {
      const snap = store5.readSnapshot(v.content_hash);
      assert.ok(snap, `每个版本都应能打开对应快照：v${v.seq}`);
    }
    assert.equal(textOfRevision(store5, versions[0].revision_id), A_CONTENT);
    assert.equal(textOfRevision(store5, versions[1].revision_id), B_CONTENT);
    assert.equal(textOfRevision(store5, versions[2].revision_id), C_CONTENT);

    const stmts = store5.listStatements(scan5.report.workspaceId);
    const q02 = stmts.filter((s) => s.code === 'Q02');
    assert.ok(q02.length >= 2, 'v1 与 v3 都含 Q02 陈述');
    assert.equal(new Set(q02.map((s) => s.statement_id)).size, q02.length, '陈述 ID 必须唯一');
    assert.equal(new Set(q02.map((s) => s.decision_id)).size, 1, '同一问题应归入同一业务决定');
  } finally {
    store5.close();
  }

  const reopened = new WorkspaceStore(dataDir);
  try {
    const md = fileByPath(reopened, mdRel);
    const versions = versionsOf(reopened, md.file_id);
    assert.equal(versions.length, 3, '重启后仍应有三个版本');
    assert.equal(textOfRevision(reopened, versions[0].revision_id), A_CONTENT);
    assert.equal(textOfRevision(reopened, versions[1].revision_id), B_CONTENT);
    assert.equal(textOfRevision(reopened, versions[2].revision_id), C_CONTENT);

    const events = eventRows(reopened);
    assert.equal(events.length, 5, '重启后事件不应增加：基线 + 自述日期 + 决策提出 + 两次修改');
    const kinds = events.map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === 'workspace_baseline').length, 1);
    assert.equal(kinds.filter((k) => k === 'appeared').length, 1);
    assert.equal(kinds.filter((k) => k === 'modified').length, 2);
    assert.equal(kinds.filter((k) => k === 'decision_raised').length, 1);

    const scanAgain = reconcileWorkspace(root, { dataDir, now: '2026-11-09T13:00:00.000Z' });
    try {
      assert.equal(scanAgain.report.eventsInserted, 0, '重启后重扫仍不应增加事件');
      assert.equal(scanAgain.report.newRevisions, 0);
    } finally {
      scanAgain.store.close();
    }
  } finally {
    reopened.close();
  }
});

test('同一编号不同问题：陈述各自独立，不共用业务决定 ID', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-r1-q-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, '.data');
  fs.mkdirSync(root, { recursive: true });

  const doc = [
    '# 四专项待确认事项',
    '',
    '## 1 号码、唯一性及项目合成',
    '**沿用编号**：`Q02/Q03`。状态：**待确认**。',
    '',
    '**推荐及理由**：推荐先确认每类号码责任。',
    '',
    '## 2 SVG 架构图检索安全策略',
    '**沿用编号**：`Q02`。状态：**待确认**。',
    '',
    '**推荐及理由**：推荐受限图片模式加载。',
  ].join('\n');

  fs.writeFileSync(path.join(root, '待确认事项.md'), doc, 'utf-8');

  const { report, store } = reconcileWorkspace(root, { dataDir, now: '2026-11-06T09:00:00.000Z' });
  try {
    const stmts = store.listStatements(report.workspaceId);
    const q02s = stmts.filter((s) => s.code === 'Q02');
    assert.equal(q02s.length, 2, '两个不同问题各有一条 Q02 陈述');
    assert.notEqual(q02s[0].question, q02s[1].question);
    assert.equal(new Set(q02s.map((s) => s.statement_id)).size, 2, '陈述 ID 必须各自独立');
    assert.equal(
      new Set(q02s.map((s) => s.decision_id)).size,
      2,
      '不同问题绝不能共用同一个业务决定 ID'
    );
    assert.ok(q02s.every((s) => s.status === '待确认'), '「推荐」不等于「已确认」');

    const q03 = stmts.filter((s) => s.code === 'Q03');
    assert.equal(q03.length, 1);

    assert.equal(store.listEdges(report.workspaceId).length, 0);
  } finally {
    store.close();
  }
});

test('已有引用绑定到来源版本；引用随来源版本演进时标注收录版本', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-r1-ref-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, '.data');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });

  fs.writeFileSync(
    path.join(root, '方案.md'),
    ['# 修复方案', '', '配图见 [固定验收入口方案](assets/图.svg)。'].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(path.join(root, 'assets', '图.svg'), SVG_CONTENT, 'utf-8');

  const scan1 = reconcileWorkspace(root, { dataDir, now: '2026-11-06T09:00:00.000Z' });
  scan1.store.close();

  fs.writeFileSync(
    path.join(root, 'assets', '图.svg'),
    SVG_CONTENT.replace('固定验收入口方案', '固定验收入口方案 · v2'),
    'utf-8'
  );
  fs.utimesSync(path.join(root, 'assets', '图.svg'), new Date('2026-11-07T10:00:00Z'), new Date('2026-11-07T10:00:00Z'));

  const scan2 = reconcileWorkspace(root, { dataDir, now: '2026-11-07T10:01:00.000Z' });
  try {
    const edges = scan2.store.listEdges(scan2.report.workspaceId);
    assert.equal(edges.length, 1, '应解析出一条引用');
    const edge = edges[0];
    assert.equal(edge.kind, 'explicit_reference');
    assert.equal(edge.resolution, 'collected_version');
    assert.ok(edge.target_revision_id, '引用应绑定到具体目标版本');
    assert.ok(edge.locator_start && edge.locator_start > 0, '引用应带来源行号');

    const svgFile = fileByPath(scan2.store, 'assets/图.svg');
    const svgVersions = versionsOf(scan2.store, svgFile.file_id);
    assert.equal(svgVersions.length, 2, '图更新应记录为两个版本');
    assert.equal(
      edge.target_revision_id,
      svgVersions[0].revision_id,
      '方案收录时的引用应停留在它当时看到的图版本'
    );
  } finally {
    scan2.store.close();
  }
});

test('决策入轴：提出 → 明确确认 → 同状态复述不重复记', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-r1-dec-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, '.data');
  fs.mkdirSync(root, { recursive: true });

  const docA = [
    '# 待确认事项',
    '文档日期：2026-11-04',
    '',
    '### Q02：实施范围是否包含候选发布',
    '',
    '- **当前状态**：待确认',
    '- **选项 A**：先修启动脚本',
    '- **推荐及理由**：推荐先修启动脚本（建议，尚未签批）。',
  ].join('\n');

  const docConfirmed = docA
    .replace('文档日期：2026-11-04', '文档日期：2026-11-05')
    .replace('- **当前状态**：待确认', '- **当前状态**：已确认');

  const docRestated = docConfirmed.replace('文档日期：2026-11-05', '文档日期：2026-11-06');

  const filePath = path.join(root, '待确认事项.md');
  fs.writeFileSync(filePath, docA, 'utf-8');

  const s1 = reconcileWorkspace(root, { dataDir, now: '2026-11-04T10:00:00.000Z' });
  try {
    const ev = eventRows(s1.store);
    const raised = ev.filter((e) => e.kind === 'decision_raised');
    assert.equal(raised.length, 1, '待确认陈述应记为「提出问题」');
    assert.match(raised[0].headline, /提出问题：Q02/);
    assert.equal(ev.filter((e) => e.kind === 'decision_changed').length, 0);
  } finally {
    s1.store.close();
  }

  fs.writeFileSync(filePath, docConfirmed, 'utf-8');
  fs.utimesSync(filePath, new Date('2026-11-05T10:00:00Z'), new Date('2026-11-05T10:00:00Z'));
  const s2 = reconcileWorkspace(root, { dataDir, now: '2026-11-05T10:01:00.000Z' });
  try {
    const ev = eventRows(s2.store);
    const changed = ev.filter((e) => e.kind === 'decision_changed');
    assert.equal(changed.length, 1, '状态转换为已确认应新增决策事件');
    assert.match(changed[0].headline, /来源记载已确认：Q02/);
  } finally {
    s2.store.close();
  }

  fs.writeFileSync(filePath, docRestated, 'utf-8');
  fs.utimesSync(filePath, new Date('2026-11-06T10:00:00Z'), new Date('2026-11-06T10:00:00Z'));
  const s3 = reconcileWorkspace(root, { dataDir, now: '2026-11-06T10:01:00.000Z' });
  try {
    const ev = eventRows(s3.store);
    assert.equal(ev.filter((e) => e.kind === 'decision_raised').length, 1, '提出事件不应重复');
    assert.equal(ev.filter((e) => e.kind === 'decision_changed').length, 1, '同状态复述不应新增');
    assert.equal(s3.report.decisionEventsInserted, 0);

    const stmts = s3.store.listStatements(s3.report.workspaceId);
    const q02 = stmts.filter((s) => s.code === 'Q02');
    assert.equal(q02.length, 3, '每个版本的来源陈述都保留（三次版本）');
    assert.equal(new Set(q02.map((s) => s.decision_id)).size, 1, '同一问题归入同一业务决定');

    const revisions = s3.store.revisionsOfFile(fileByPath(s3.store, '待确认事项.md').file_id);
    const latestSeq = revisions[revisions.length - 1].seq;
    const latestRevisionId = revisions[revisions.length - 1].revision_id;
    const latestStmt = q02.find((s) => s.revision_id === latestRevisionId);
    assert.ok(latestStmt, '最新版本应有 Q02 陈述');
    assert.equal(latestStmt!.status, '已确认', '最新口径为已确认');
    assert.ok(
      q02.some((s) => s.status === '待确认'),
      '首版「待确认」的历史陈述不应被改写'
    );
    assert.ok(latestSeq >= 3);
  } finally {
    s3.store.close();
  }
});
