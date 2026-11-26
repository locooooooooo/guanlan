import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';

import {
  DIFF_FALLBACK_METRICS,
  diffSummaryCardOf,
  formatDiffMetric,
} from '../src/utils/diffResultAdapter';
import {
  fetchDiffSummaryViaJob,
  setApiBaseUrl,
  type DiffResult,
} from '../src/services/workspaceClient';


const RESULT: DiffResult = {
  summary: {
    headline: 'BOM 联动方案 v2：状态锁与字段映射落地',
    items: [
      { label: '新增交付项', count: 2, sign: '+' },
      { label: '关闭未决事项', count: 1, sign: '-' },
      { label: '修改接口契约', count: 3, sign: '~' },
    ],
    checkpoint_id: 'ckpt_20261118_04_exec_09',
  },
  sections: [
    {
      title: '状态机规则',
      baseline_start: 12,
      target_start: 12,
      lines: [
        { type: 'same', text: '…' },
        { type: 'add', text: '采用两阶段状态锁' },
      ],
    },
  ],
  truncated: false,
  next_cursor: null,
};

describe('diffSummaryCardOf 适配层', () => {
  test('三指标逐字透传 + Checkpoint ID（3.5「标注触发该版本生成的具体任务 Checkpoint ID」）', () => {
    const vm = diffSummaryCardOf(RESULT);
    assert.equal(vm.headline, 'BOM 联动方案 v2：状态锁与字段映射落地');
    assert.equal(vm.metrics.length, 3);
    assert.deepEqual(vm.metrics.map((m) => m.label), ['新增交付项', '关闭未决事项', '修改接口契约']);
    assert.equal(vm.checkpointId, 'ckpt_20261118_04_exec_09');
  });

  test('空 headline 兜底「语义变更摘要」；空 items 给三项 0 值兜底（不编造计数）', () => {
    const vm = diffSummaryCardOf({
      summary: { headline: '', items: [], checkpoint_id: null },
      sections: [],
      truncated: false,
      next_cursor: null,
    });
    assert.equal(vm.headline, '语义变更摘要');
    assert.deepEqual(vm.metrics, [...DIFF_FALLBACK_METRICS]);
    assert.equal(vm.checkpointId, null);
  });

  test('格式化文案：+N / -N / N 处', () => {
    assert.equal(formatDiffMetric({ label: '新增交付项', count: 2, sign: '+' }), '+2 新增交付项');
    assert.equal(formatDiffMetric({ label: '关闭未决事项', count: 1, sign: '-' }), '1 关闭未决事项');
    assert.equal(formatDiffMetric({ label: '修改接口契约', count: 3, sign: '~' }), '3 处修改接口契约');
  });
});


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

describe('fetchDiffSummaryViaJob 全链（契约 H）', () => {
  test('202 受理 → completed → result 三项指标 + Checkpoint', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/diff',
        handler: (_req, res) => {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, job_id: 'job_diff', state: 'queued', merged: false }));
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/jobs/job_diff',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_diff',
              kind: 'diff',
              state: 'completed',
              phase: 'done',
              discovered: 0,
              processed: 0,
              failed_items: [],
            })
          );
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/jobs/job_diff/result',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, job_id: 'job_diff', state: 'completed', kind: 'diff', result: RESULT, next_cursor: null }));
        },
      },
    ]);
    setApiBaseUrl(stub.base);
    try {
      const res = await fetchDiffSummaryViaJob(
        {
          file_id: 'f_bom',
          baseline_revision_id: 'rev_1',
          target_revision_id: 'rev_2',
        },
        { intervalMs: 1, maxAttempts: 10 }
      );
      assert.equal(res.ok, true);
      assert.equal(res.data.summary.checkpoint_id, 'ckpt_20261118_04_exec_09');
      assert.equal(res.data.summary.items.length, 3);
    } finally {
      await stub.close();
    }
  });

  test('任务 failed → DIFF_JOB_FAILED 如实返回（不拿本地 diff 冒充语义摘要）', async () => {
    const stub = await startStub([
      {
        match: (url) => url.pathname === '/api/v1/diff',
        handler: (_req, res) => {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, job_id: 'job_diff_fail', state: 'queued', merged: false }));
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/jobs/job_diff_fail',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              job_id: 'job_diff_fail',
              kind: 'diff',
              state: 'failed',
              phase: 'failed',
              discovered: 0,
              processed: 0,
              failed_items: ['rev_1'],
              error: '快照读取失败',
            })
          );
        },
      },
    ]);
    setApiBaseUrl(stub.base);
    try {
      const res = await fetchDiffSummaryViaJob(
        { file_id: 'f_bom', baseline_revision_id: 'rev_1', target_revision_id: 'rev_2' },
        { intervalMs: 1, maxAttempts: 10 }
      );
      assert.equal(res.ok, false);
      assert.equal(res.code, 'DIFF_JOB_FAILED');
      assert.equal(res.error, '快照读取失败');
    } finally {
      await stub.close();
    }
  });

  test('端点缺失（404 错误包络）→ ok:false 如实透传', async () => {
    const stub = await startStub([]);
    setApiBaseUrl(stub.base);
    try {
      const res = await fetchDiffSummaryViaJob(
        { file_id: 'f_bom', baseline_revision_id: 'rev_1', target_revision_id: 'rev_2' },
        { intervalMs: 1, maxAttempts: 3 }
      );
      assert.equal(res.ok, false);
      assert.equal(res.status, 404);
    } finally {
      await stub.close();
    }
  });
});
