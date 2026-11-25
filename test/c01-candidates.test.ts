import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adoptInitiativeCandidate,
  dismissInitiativeCandidate,
  excludeInitiativeCandidateMember,
  fetchInitiativeCandidates,
  setApiBaseUrl,
} from '../src/services/workspaceClient';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '../src');

describe('fetchInitiativeCandidates 客户端契约请求', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    setApiBaseUrl('');
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('正确请求 /api/v1/initiative-candidates 并解析理由胶囊载荷', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/v1/initiative-candidates') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            index_generation: 5,
            items: [
              {
                candidate_id: 'cand_abc',
                title: '登录方案-需求蓝图',
                reason_summary: '4 份文件共享同名主干，命中同名信号',
                signal_mask: 12,
                score: 61,
                state: 'candidate',
                member_count: 2,
                members: [
                  {
                    file_id: 'f1',
                    relative_path: 'docs/登录方案.md',
                    title: '登录方案',
                    signals: [
                      { signal: 'same_stem', detail: '共享同名主干「登录方案」' },
                      { signal: 'session', detail: '最后修改相差 10 分钟（同一编辑会话）' },
                    ],
                  },
                  { file_id: 'f2', relative_path: 'specs/登录方案-架构.svg', title: '登录方案-架构', signals: [] },
                ],
                updated_at: '2026-11-20T08:00:00Z',
              },
            ],
          })
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: 'missing' }));
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    setApiBaseUrl(`http://127.0.0.1:${addr.port}`);

    const hit = await fetchInitiativeCandidates();
    assert.equal(hit.ok, true);
    if (hit.ok) {
      assert.equal(hit.data.items[0].candidate_id, 'cand_abc');
      assert.deepEqual(hit.data.items[0].members[0].signals[0], {
        signal: 'same_stem',
        detail: '共享同名主干「登录方案」',
      });
    }
  });

  it('采纳/否决/剔除 POST 命中对应端点并解析 202 JobAccepted', async () => {
    const hits: string[] = [];
    server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.method === 'POST') {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job_id: 'job_x' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    setApiBaseUrl(`http://127.0.0.1:${addr.port}`);

    const adopt = await adoptInitiativeCandidate('cand_1');
    assert.equal(adopt.ok, true);
    const dismiss = await dismissInitiativeCandidate('cand_1');
    assert.equal(dismiss.ok, true);
    const exclude = await excludeInitiativeCandidateMember('cand_1', 'f2');
    assert.equal(exclude.ok, true);
    assert.ok(hits.includes('POST /api/v1/initiative-candidates/cand_1/adopt'));
    assert.ok(hits.includes('POST /api/v1/initiative-candidates/cand_1/dismiss'));
    assert.ok(hits.includes('POST /api/v1/initiative-candidates/cand_1/members/f2/exclude'));
  });
});

describe('独立面板组件与接线检查', () => {
  it('InitiativeCandidatePanel 独立落地并接入 RightInspector，理由胶囊非黑盒', () => {
    const panelSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/InitiativeCandidatePanel.tsx'),
      'utf8'
    );
    assert.ok(panelSrc.includes('fetchInitiativeCandidates'), '调用候选列表端点');
    assert.ok(panelSrc.includes('adoptInitiativeCandidate'), '采纳动作');
    assert.ok(panelSrc.includes('dismissInitiativeCandidate'), '否决动作');
    assert.ok(panelSrc.includes('excludeInitiativeCandidateMember'), '单成员剔除动作');
    assert.ok(panelSrc.includes('signals.map'), '理由胶囊逐条展示（悬浮可见）');

    const inspectorSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'components/RightInspector.tsx'),
      'utf8'
    );
    assert.ok(
      inspectorSrc.includes('InitiativeCandidatePanel'),
      'RightInspector 挂载候选事项面板'
    );
  });
});
