import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppBanners } from '../src/components/app/AppBanners';
import {
  getL4aProgress,
  isL4aProgressActive,
  resetL4aProgress,
  setL4aProgress,
  subscribeL4aProgress,
} from '../src/utils/l4aProgressStore';

/**
 * 后台语义整理的进度与扫描中的多项目刷新不能拖着重子树重渲。
 *
 * 事故形态：进度此前是 useWorkspaceStore 的 useState。1,397 篇队列、写线程每批
 * 3 篇发一条 l4a 事件，前端每收一条就打一次 /status 并 setState，另有 2.5 秒轮询
 * 兜底——约 466 次整棵 App 树重渲，阅读器正文与星图画布跟着进度条一起重渲。
 * 扫描中的项目列表每 1.2 秒刷新一次，还附带重拉所有已展开项目的整棵目录树。
 *
 * 规则：
 *  ① 进度活值住 utils/l4aProgressStore，只有横幅叶子用 useSyncExternalStore 订阅；
 *  ② 同值不通知（轮询回到同一进度时不重渲）；
 *  ③ total=0 或 queue_depth 归 0 即视为排空，横幅收起，不造 100% 假进度；
 *  ④ 扫描中的列表轮询只刷列表与计数，目录树在扫描结束后补一次。
 */

function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

test('L4A 进度：同值短路，排空后回到 null', () => {
  resetL4aProgress();
  let notified = 0;
  const off = subscribeL4aProgress(() => {
    notified += 1;
  });

  setL4aProgress({ done: 3, total: 1397, percent: 0, queue_depth: 1394 });
  assert.equal(notified, 1);
  assert.equal(getL4aProgress()?.done, 3);

  // 下一拍轮询拿到的是新对象、数值没变：不能通知，否则横幅每 2.5 秒白重渲一次
  setL4aProgress({ done: 3, total: 1397, percent: 0, queue_depth: 1394 });
  assert.equal(notified, 1, '进度没变时不通知订阅者');

  setL4aProgress({ done: 6, total: 1397, percent: 0, queue_depth: 1391 });
  assert.equal(notified, 2);

  resetL4aProgress();
  assert.equal(getL4aProgress(), null);
  assert.equal(notified, 3);

  off();
  setL4aProgress({ done: 9, total: 1397, percent: 0, queue_depth: 1388 });
  assert.equal(notified, 3, '退订后不再通知');
  resetL4aProgress();
});

test('L4A 进度：total=0 与 queue_depth 归 0 都算排空', () => {
  assert.equal(isL4aProgressActive(null), false);
  assert.equal(isL4aProgressActive({ done: 0, total: 0, percent: 100 }), false);
  // 缺失快照被标 failed：done < total 但队列已空，不能永久悬挂
  assert.equal(
    isL4aProgressActive({ done: 12, total: 1397, percent: 1, queue_depth: 0 }),
    false
  );
  assert.equal(
    isL4aProgressActive({ done: 12, total: 1397, percent: 1, queue_depth: 1385 }),
    true
  );
  // 老服务端没有 queue_depth 时退回 done < total
  assert.equal(isL4aProgressActive({ done: 12, total: 1397, percent: 1 }), true);
  assert.equal(isL4aProgressActive({ done: 1397, total: 1397, percent: 100 }), false);
});

test('L4A 进度不进 store 状态，横幅叶子自订阅', () => {
  const store = readSrc('stores/useWorkspaceStore.tsx');
  assert.ok(
    !store.includes('useState<L4aProgress'),
    '进度不能是 store 的 React 状态——那会写在带动主视图的 ctx 那一层'
  );
  assert.ok(!/\bl4aProgress\b/.test(store), 'ctx 不再下发 l4aProgress 字段');
  assert.ok(store.includes('setL4aProgress('), '轮询写进外部活值层');
  assert.ok(store.includes('resetL4aProgress()'), '切换工作区时清空外部活值层');

  const banners = readSrc('components/app/AppBanners.tsx');
  assert.ok(
    /useSyncExternalStore\(\s*subscribeL4aProgress,\s*getL4aProgress,\s*getL4aProgress\s*\)/.test(
      banners
    ),
    '横幅必须自己订阅进度并传 getServerSnapshot，更新只重渲横幅且不破坏 SSR'
  );
  assert.ok(
    !/^\s*l4aProgress,/m.test(banners),
    '横幅不能再从 ctx 解构 l4aProgress（那等于把整棵树拉回重渲路径）'
  );
});

test('AppBanners SSR：从外部进度层读到 L4A 进度并正常渲染，清空后不渲染', () => {
  const baseCtx = {
    rescanState: 'idle',
    rescanError: '',
    handleRescan: async () => {},
    hitlClearedAt: null,
    deliveredInitiative: null,
    deliveredInitiatives: [],
    initiativeLifecycle: null,
    runInitiativeLifecycle: async () => {},
    activeInitiative: null,
    changeNotice: null,
    refreshEvents: async () => {},
    silentMergeNewEvents: async () => {},
    silentMergingEvents: false,
    dataSource: 'real',
    files: [],
    dataError: '',
    activeTab: 'library',
    networkOffline: false,
    streamDisconnected: false,
    retryingConnection: false,
    handleRetryConnection: async () => {},
    switchingWorkspace: false,
  } as never;

  try {
    setL4aProgress({ done: 42, total: 100, percent: 42, queue_depth: 58 });
    const activeHtml = renderToStaticMarkup(React.createElement(AppBanners, { ctx: baseCtx }));
    assert.ok(activeHtml.includes('后台语义整理中 (42%)'), '有活跃进度时横幅应渲染百分比');
    assert.ok(activeHtml.includes('42/100 篇'), '有活跃进度时横幅应渲染篇数');

    resetL4aProgress();
    const idleHtml = renderToStaticMarkup(React.createElement(AppBanners, { ctx: baseCtx }));
    assert.ok(!idleHtml.includes('后台语义整理中'), '清空后横幅不渲染进度条');
  } finally {
    resetL4aProgress();
  }
});

test('扫描中的列表轮询不再重拉已展开目录树', () => {
  const hook = readSrc('hooks/useMultiProjects.ts');
  const intervalStart = hook.indexOf('if (!enabled || !anyScanning) return;');
  const intervalEnd = hook.indexOf('}, 1200);');
  assert.ok(
    intervalStart > -1 && intervalEnd > intervalStart,
    '1.2 秒轮询的源码锚点必须存在（改名时本测试要跟着改，而不是静默放行）'
  );
  const intervalBody = hook.slice(intervalStart, intervalEnd);
  assert.ok(intervalBody.includes('void refreshAll();'), '扫描期间仍要刷新列表与总览计数');
  assert.ok(
    !intervalBody.includes('reloadExpandedTrees'),
    '扫描期间不能每拍重拉已展开项目的整棵目录树'
  );

  const doneStart = hook.indexOf('if (wasScanningRef.current && !anyScanning)');
  assert.ok(doneStart > -1, '扫描结束要补一次目录树');
  const doneBody = hook.slice(doneStart, doneStart + 200);
  assert.ok(
    doneBody.includes('reloadExpandedTrees: true'),
    '扫描结束后补的那一次要带上 reloadExpandedTrees'
  );
});
