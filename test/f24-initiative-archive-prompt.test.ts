/**
 * F24 / PRD §2.2：Delivered「一键归档」提示 + Archived「重开」入口。
 *
 * 验收口径：Delivered 已交付态必须有前端「一键归档」提示；归档/重开端点
 * （postInitiativeArchive/postInitiativeReopen）不再零调用方；归档完成后状态
 * 投影刷新，提示消失/切换。
 *
 * 覆盖：
 *  ① 纯函数：deliveredInitiativesOf 只取 delivered 并按 updated_at 降序；
 *     initiativeArchiveWarn 如实提取服务端 warn；
 *  ② 源码接线：App 渲染一键归档/重开提示，调用 archive/reopen job + 轮询 +
 *     state-overview 刷新。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  deliveredInitiativesOf,
  initiativeArchiveWarn,
} from '../src/utils/initiativeLifecycle';
import type { InitiativeStateView } from '../src/services/apiTypes';

function initiative(
  id: string,
  state: InitiativeStateView['state'],
  updatedAt: string
): InitiativeStateView {
  return {
    initiative_id: id,
    name: id,
    root_dir: id,
    current_stage: '执行',
    state,
    artifact_count: 1,
    pending_p0: 0,
    pending_p1: 0,
    pending_p2: 0,
    updated_at: updatedAt,
  };
}

test('deliveredInitiativesOf：只取 delivered，按 updated_at 降序（最近更新先提示）', () => {
  const list = deliveredInitiativesOf([
    initiative('init_old', 'delivered', '2026-11-10T10:00:00+08:00'),
    initiative('init_draft', 'draft', '2026-11-18T10:00:00+08:00'),
    initiative('init_new', 'delivered', '2026-11-18T09:00:00+08:00'),
    initiative('init_archived', 'archived', '2026-11-19T10:00:00+08:00'),
  ]);
  assert.deepEqual(
    list.map((row) => row.initiative_id),
    ['init_new', 'init_old']
  );
  assert.deepEqual(deliveredInitiativesOf([]), []);
});

test('initiativeArchiveWarn：仅提取 result.initiative.warn；缺失/非字符串如实 null', () => {
  assert.equal(
    initiativeArchiveWarn({ initiative: { warn: '当前非已交付态' } }),
    '当前非已交付态'
  );
  assert.equal(initiativeArchiveWarn({ initiative: { state: 'archived' } }), null);
  assert.equal(initiativeArchiveWarn({ initiative: { warn: '' } }), null);
  assert.equal(initiativeArchiveWarn(null), null);
  assert.equal(initiativeArchiveWarn(undefined), null);
  assert.equal(initiativeArchiveWarn('warn'), null);
  assert.equal(initiativeArchiveWarn({}), null);
});

test('F24 接线：App 渲染一键归档/重开提示并调用归档/重开 job', () => {
  // D01-a 拆层后 App 实现 = 装配层 + 单一 Store + 分节组件——联合文本断言（语义不变）
  const app = ['../src/App.tsx', '../src/stores/useWorkspaceStore.tsx', '../src/components/app/AppBanners.tsx']
    .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
    .join(String.fromCharCode(10))

  for (const token of [
    'deliveredInitiativesOf',
    'initiativeArchiveWarn',
    'postInitiativeArchive',
    'postInitiativeReopen',
    'pollJobUntilSettled',
    'data-initiative-archive-prompt',
    '一键归档',
    'data-initiative-reopen-prompt',
    '重开专项',
  ]) {
    assert.ok(app.includes(token), `App 缺 ${token}`);
  }

  assert.match(app, /postInitiativeArchive\(initiativeId\)/, '归档按钮必须调用 archive 端点');
  assert.match(app, /postInitiativeReopen\(initiativeId\)/, '重开按钮必须调用 reopen 端点');
  assert.match(app, /fetchStateOverview\(\)/, '归档/重开后刷新状态投影');
  assert.match(app, /kinds\.includes\('state'\)/, 'SSE state 变更刷新状态投影');
  assert.match(app, /setStateOverview\(\(prev\)/, '完成前乐观更新提示源');
});
