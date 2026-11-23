import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';

import {
  buildDecisionResolvePayload,
  extractDecisionOptions,
  isBlockingCleared,
  loadDecisionIdentityMemory,
  matchStatementToBlock,
  parseDecisionBlocks,
  pendingDecisionBlocksOf,
  rememberDecisionIdentity,
  remainingBlockingCount,
  type DecisionBlock,
} from '../src/utils/decisionBlocks';
import {
  extractJobBranch,
  pollJobUntilSettled,
  postDecisionResolve,
  setApiBaseUrl,
  type JobReportAdopt,
  type JobReportWriteback,
  type StatementDetailDTO,
} from '../src/services/workspaceClient';

/**
 * decision-resolve-01：Inline 拍板闭环（PRD 3.3 / 方案 F5）。
 *
 * 覆盖：
 * - 卡点块解析：[P0/P1/P2 - 待确认] 标记 + PRD 3.3 标准字段行 + 围栏字面量不识别
 *   + 已定案块 + 组合优先级（blocking 语义）；
 * - 「可选方案/推荐理由」预设选项提取（章节列表 / 行内标签 / 推荐理由不进选项）；
 * - 拍板载荷组装（trim、空可选省略键、范围+日期合并）；
 * - 确认人/角色本机记忆（node 无 window 安全降级 + 去重上限）；
 * - statement ↔ 区块行号匹配；阻塞清零判定（AC-03 本地口径）；
 * - 契约 C 全链（本地 http 桩）：恒 202 → job 轮询 → report.writeback 三分支
 *   （cas_ok=true / cas_ok=false 存草案 / 任务失败）+ 409 CONFLICT（archived 主体）
 *   + 轮询超时 JOB_POLL_TIMEOUT。
 */

// ---------- http 桩（workspace-client-v1 同款起桩纪律） ----------

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

async function startStub(
  routes: Array<{ match: (url: URL, req: IncomingMessage) => boolean; handler: Handler }>
) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://stub.local');
    const route = routes.find((r) => r.match(url, req));
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: 'stub 无此路由' }));
      return;
    }
    route.handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------- 夹具 ----------

const DECISION_DOC = [
  '# 03-待确认事项',
  '',
  '## 属性字典与历史更新策略',
  '',
  '[P1 - 待确认] 属性字典与历史更新策略',
  '- 决定：___',
  '- 确认人：___',
  '- 角色：___',
  '- 现运行条件：___',
  '- 新运行条件：___',
  '- 生效范围与日期：___',
  '',
  '[P0/P1 - 待确认] 流程条件与生命周期',
  '- 决定：___',
  '- 确认人：___',
  '',
  '[P2 - 待确认] 文档配图风格',
  '- 决定：___',
  '',
  '[P1 - 已确认] 存储桶命名',
  '- 决定：采用两阶段状态锁',
  '- 确认人：架构组',
  '',
  '```',
  '[P1 - 待确认] 这是代码示例里的字符串字面量',
  '```',
  '',
  '## 可选方案',
  '- 方案A：两阶段状态锁',
  '- 方案B：测试环境自动放行',
  '- 方案A：两阶段状态锁',
  '',
  '推荐理由：方案A 风险更低',
].join('\n');

function blockAtLine(blocks: DecisionBlock[], line: number): DecisionBlock {
  const b = blocks.find((x) => x.line === line);
  assert.ok(b, `期望行 ${line} 有卡点块`);
  return b;
}

// ---------- 解析 ----------

describe('parseDecisionBlocks 卡点块解析', () => {
  const blocks = parseDecisionBlocks(DECISION_DOC);

  test('识别三个待确认标记与一个已确认标记；围栏字面量不识别', () => {
    assert.equal(blocks.length, 4);
    assert.deepEqual(
      blocks.map((b) => [b.line, b.status]),
      [
        [5, '待确认'],
        [13, '待确认'],
        [17, '待确认'],
        [20, '已确认'],
      ]
    );
  });

  test('P1 块：行范围、标题、六类字段行号齐备', () => {
    const b = blockAtLine(blocks, 5);
    assert.deepEqual(b.range, [5, 11]);
    assert.equal(b.priority, 'P1');
    assert.equal(b.blocking, true);
    assert.equal(b.title, '属性字典与历史更新策略');
    assert.deepEqual(b.fields, {
      decision: 6,
      confirmer: 7,
      role: 8,
      currentCondition: 9,
      newCondition: 10,
      effectiveScopeDate: 11,
    });
  });

  test('组合优先级 [P0/P1]：blocking=true、代表优先级取首个；P2 不构成阻塞', () => {
    const combo = blockAtLine(blocks, 13);
    assert.deepEqual(combo.priorities, ['P0', 'P1']);
    assert.equal(combo.priority, 'P0');
    assert.equal(combo.blocking, true);
    const p2 = blockAtLine(blocks, 17);
    assert.equal(p2.blocking, false);
    assert.equal(p2.priority, 'P2');
  });

  test('区块在空行/下一标记处收口（已确认块 range 覆盖其字段行、不吞后续正文）', () => {
    const confirmed = blockAtLine(blocks, 20);
    assert.deepEqual(confirmed.range, [20, 22]);
  });

  test('pendingDecisionBlocksOf 只留待确认块', () => {
    assert.deepEqual(
      pendingDecisionBlocksOf(DECISION_DOC).map((b) => b.line),
      [5, 13, 17]
    );
  });
});

// ---------- 可选方案提取 ----------

describe('extractDecisionOptions 可选方案/推荐理由', () => {
  test('章节列表收集 + 去重；推荐理由行不进选项', () => {
    assert.deepEqual(extractDecisionOptions(DECISION_DOC), [
      '方案A：两阶段状态锁',
      '方案B：测试环境自动放行',
    ]);
  });

  test('行内标签形态：可选方案：A、B / C', () => {
    const doc = ['## 卡点', '可选方案：方案A、方案B / 保守方案C', ''].join('\n');
    assert.deepEqual(extractDecisionOptions(doc), ['方案A', '方案B', '保守方案C']);
  });

  test('冒号后为空的「可选方案：」是章节收集起点', () => {
    const doc = ['可选方案：', '- 甲', '- 乙', ''].join('\n');
    assert.deepEqual(extractDecisionOptions(doc), ['甲', '乙']);
  });

  test('无锚文档返回空数组（表单只留自定义输入）', () => {
    assert.deepEqual(extractDecisionOptions('# 无卡点的普通文档\n正文'), []);
  });
});

// ---------- 载荷组装 ----------

describe('buildDecisionResolvePayload 契约 C 载荷', () => {
  test('全字段：范围+日期合并进 effective_scope、date 独立透传、空 note 省略', () => {
    const payload = buildDecisionResolvePayload({
      decision: ' 方案A：两阶段状态锁 ',
      confirmer: ' 架构组 ',
      role: ' 负责人 ',
      effectiveScope: '全量专项',
      effectiveDate: '2026-11-18',
      note: '',
    });
    assert.deepEqual(payload, {
      decision: '方案A：两阶段状态锁',
      confirmer: '架构组',
      role: '负责人',
      effective_scope: '全量专项 · 2026-11-18',
      effective_date: '2026-11-18',
    });
  });

  test('只填日期 → effective_scope 承载日期；全空可选 → 只剩必填两键', () => {
    assert.deepEqual(
      buildDecisionResolvePayload({
        decision: '方案B',
        confirmer: '张三',
        role: '',
        effectiveScope: '',
        effectiveDate: '2026-12-01',
        note: '',
      }),
      { decision: '方案B', confirmer: '张三', effective_scope: '2026-12-01', effective_date: '2026-12-01' }
    );
    assert.deepEqual(
      buildDecisionResolvePayload({
        decision: '方案B',
        confirmer: '张三',
        role: '',
        effectiveScope: '',
        effectiveDate: '',
        note: '',
      }),
      { decision: '方案B', confirmer: '张三' }
    );
  });
});

// ---------- 本机记忆 ----------

describe('确认人/角色本机记忆（无成员数据源，偏差登记）', () => {
  test('node 无 window 环境：load 返回空记忆、remember 只更新内存副本不炸', () => {
    const memory = loadDecisionIdentityMemory();
    assert.deepEqual(memory, { confirmers: [], roles: [] });
    const next = rememberDecisionIdentity(memory, '架构组', '负责人');
    assert.deepEqual(next, { confirmers: ['架构组'], roles: ['负责人'] });
    // 原记忆不被改写（纯函数语义）
    assert.deepEqual(memory, { confirmers: [], roles: [] });
  });

  test('去重置顶 + 上限 8', () => {
    let memory: ReturnType<typeof loadDecisionIdentityMemory> = { confirmers: [], roles: [] };
    for (let i = 1; i <= 10; i++) memory = rememberDecisionIdentity(memory, `用户${i}`, '负责人');
    assert.equal(memory.confirmers.length, 8);
    assert.equal(memory.confirmers[0], '用户10');
    memory = rememberDecisionIdentity(memory, '用户3', '负责人');
    assert.equal(memory.confirmers[0], '用户3');
    assert.equal(memory.confirmers.filter((c) => c === '用户3').length, 1);
    // 空白值不入列
    const noBlank = rememberDecisionIdentity(memory, '  ', '');
    assert.deepEqual(noBlank.confirmers, memory.confirmers);
  });
});

// ---------- 陈述匹配与清零判定 ----------

const STATEMENTS: StatementDetailDTO[] = [
  {
    statement_id: 'stmt_2',
    revision_id: 'rev_1',
    code: 'D-02',
    question: '流程条件与生命周期',
    status: '待确认',
    line_start: 13,
    line_end: 14,
    decision_id: 'dec_2',
    options: ['两阶段状态锁', '自动放行'],
    recommendation: '两阶段状态锁',
    impact_blocked: ['task_exec'],
    impact_allowed: ['check_docs'],
    confirmer_hint: '架构组',
  },
  {
    statement_id: 'stmt_1',
    revision_id: 'rev_1',
    code: 'D-01',
    question: '属性字典与历史更新策略',
    status: '待确认',
    line_start: 5,
    line_end: 10,
    decision_id: 'dec_1',
    options: null,
    recommendation: null,
    impact_blocked: null,
    impact_allowed: null,
    confirmer_hint: null,
  },
];

describe('matchStatementToBlock 与阻塞清零（AC-03 本地口径）', () => {
  test('行号在块范围内命中；范围外返回 null', () => {
    const blocks = parseDecisionBlocks(DECISION_DOC);
    const p1 = blockAtLine(blocks, 5);
    assert.equal(matchStatementToBlock(STATEMENTS, p1)?.statement_id, 'stmt_1');
    const combo = blockAtLine(blocks, 13);
    assert.equal(matchStatementToBlock(STATEMENTS, combo)?.statement_id, 'stmt_2');
    const outOfRange = blockAtLine(blocks, 20);
    assert.equal(matchStatementToBlock(STATEMENTS, outOfRange), null);
    assert.equal(matchStatementToBlock([], p1), null);
  });

  test('剩余阻塞数只数 P0/P1 待确认且未被本会话拍板的块；P2 不计', () => {
    const blocks = parseDecisionBlocks(DECISION_DOC);
    assert.equal(remainingBlockingCount(blocks, new Set()), 2);
    assert.equal(remainingBlockingCount(blocks, new Set([5])), 1);
    assert.equal(remainingBlockingCount(blocks, new Set([5, 13])), 0);
  });

  test('isBlockingCleared：曾有阻塞→清零为 true；从未有阻塞→false', () => {
    const blocks = parseDecisionBlocks(DECISION_DOC);
    assert.equal(isBlockingCleared(blocks, new Set([5, 13])), true);
    assert.equal(isBlockingCleared(blocks, new Set([5])), false);
    const noBlocking = parseDecisionBlocks('[P2 - 待确认] 配图风格\n- 决定：___');
    assert.equal(isBlockingCleared(noBlocking, new Set()), false);
  });
});

// ---------- 契约 C 全链（恒 202 → job 轮询 → report 分支） ----------

describe('拍板回写全链（http 桩）', () => {
  test('cas_ok=true 分支：202 → completed → report.writeback 落 new_revision_id', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/decisions/stmt_1/resolve',
        handler: (_req, res) => {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, job_id: 'job_ok', statement_id: 'stmt_1', decision_id: 'dec_1' }));
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/jobs/job_ok',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_ok',
              kind: 'decision_writeback',
              state: 'completed',
              phase: 'done',
              discovered: 0,
              processed: 0,
              failed_items: [],
              report: { cas_ok: true, file_changed: true, new_revision_id: 'rev_9' },
            })
          );
        },
      },
    ]);
    setApiBaseUrl(stub.base);
    try {
      const accepted = await postDecisionResolve('stmt_1', {
        decision: '方案A：两阶段状态锁',
        confirmer: '架构组',
      });
      // 恒 202：受理即返回，无 409 路径
      assert.equal(accepted.ok, true);
      assert.equal(accepted.status, 202);
      assert.equal(accepted.data.decision_id, 'dec_1');
      const settled = await pollJobUntilSettled(accepted.data.job_id, {
        intervalMs: 1,
        maxAttempts: 10,
      });
      assert.equal(settled.ok, true);
      assert.equal(settled.data.state, 'completed');
      assert.deepEqual(settled.data.report, {
        cas_ok: true,
        file_changed: true,
        new_revision_id: 'rev_9',
      });
    } finally {
      await stub.close();
    }
  });

  test('cas_ok=false 分支（CAS 冲突）：completed 终态 + cas_conflict 哈希——拍板已存草案', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/decisions/stmt_2/resolve',
        handler: (_req, res) => {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, job_id: 'job_conflict', statement_id: 'stmt_2', decision_id: 'dec_2' }));
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/jobs/job_conflict',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_conflict',
              kind: 'decision_writeback',
              state: 'completed',
              phase: 'done',
              discovered: 0,
              processed: 0,
              failed_items: [],
              report: {
                cas_ok: false,
                file_changed: false,
                new_revision_id: null,
                cas_conflict: {
                  expected_content_hash: 'sha256:aaa',
                  disk_content_hash: 'sha256:bbb',
                },
              },
            })
          );
        },
      },
    ]);
    setApiBaseUrl(stub.base);
    try {
      const accepted = await postDecisionResolve('stmt_2', {
        decision: '自动放行',
        confirmer: '架构组',
      });
      assert.equal(accepted.ok, true);
      const settled = await pollJobUntilSettled(accepted.data.job_id, {
        intervalMs: 1,
        maxAttempts: 10,
      });
      assert.equal(settled.ok, true);
      assert.equal(settled.data.state, 'completed');
      const report = settled.data.report as { cas_ok: boolean; cas_conflict?: unknown };
      assert.equal(report.cas_ok, false);
      assert.deepEqual(report.cas_conflict, {
        expected_content_hash: 'sha256:aaa',
        disk_content_hash: 'sha256:bbb',
      });
    } finally {
      await stub.close();
    }
  });

  test('archived 主体同步 409 CONFLICT（契约 F：需先人工重开）', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/decisions/stmt_x/resolve',
        handler: (_req, res) => {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'CONFLICT', error: '已归档文档需先人工重开' }));
        },
      },
    ]);
    setApiBaseUrl(stub.base);
    try {
      const accepted = await postDecisionResolve('stmt_x', { decision: 'x', confirmer: 'y' });
      assert.equal(accepted.ok, false);
      assert.equal(accepted.code, 'CONFLICT');
    } finally {
      await stub.close();
    }
  });

  test('任务 failed 终态与轮询超时（JOB_POLL_TIMEOUT）如实透传', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/decisions/stmt_f/resolve',
        handler: (_req, res) => {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, job_id: 'job_failed', statement_id: 'stmt_f', decision_id: 'dec_f' }));
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/decisions/stmt_s/resolve',
        handler: (_req, res) => {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, job_id: 'job_stuck', statement_id: 'stmt_s', decision_id: 'dec_s' }));
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/jobs/job_failed',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_failed',
              kind: 'decision_writeback',
              state: 'failed',
              phase: 'failed',
              discovered: 0,
              processed: 0,
              failed_items: ['rev_3'],
              error: '快照写入失败',
            })
          );
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/jobs/job_stuck',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_stuck',
              kind: 'decision_writeback',
              state: 'running',
              phase: 'scanning',
              discovered: 0,
              processed: 0,
              failed_items: [],
            })
          );
        },
      },
    ]);
    setApiBaseUrl(stub.base);
    try {
      const failed = await pollJobUntilSettled('job_failed', { intervalMs: 1, maxAttempts: 5 });
      assert.equal(failed.ok, true);
      assert.equal(failed.data.state, 'failed');
      assert.equal(failed.data.error, '快照写入失败');
      const stuck = await pollJobUntilSettled('job_stuck', { intervalMs: 1, maxAttempts: 3 });
      assert.equal(stuck.ok, false);
      assert.equal(stuck.code, 'JOB_POLL_TIMEOUT');
    } finally {
      await stub.close();
    }
  });

  test('extractJobBranch 兼容真实 Rust result.{writeback,adopt} 与旧桩 report 形状', () => {
    const wb = extractJobBranch<JobReportWriteback>(
      {
        ok: true,
        job_id: 'j1',
        kind: 'decision_writeback',
        state: 'completed',
        phase: 'done',
        discovered: 0,
        processed: 0,
        failed_items: [],
        report: null,
        result: { writeback: { cas_ok: true, file_changed: true, new_revision_id: 'rev_2' } },
      },
      'writeback'
    );
    assert.deepEqual(wb, { cas_ok: true, file_changed: true, new_revision_id: 'rev_2' });

    const adopt = extractJobBranch<JobReportAdopt>(
      {
        ok: true,
        job_id: 'j2',
        kind: 'adopt_draft',
        state: 'completed',
        phase: 'done',
        discovered: 0,
        processed: 0,
        failed_items: [],
        report: null,
        result: { adopt: { cas_ok: true, new_revision_id: 'rev_3', cas_conflict: null } },
      },
      'adopt'
    );
    assert.deepEqual(adopt, { cas_ok: true, new_revision_id: 'rev_3', cas_conflict: null });
  });
});
