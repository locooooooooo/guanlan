/**
 * proposal-toast-01：回写通知条（PRD 4.3 双向回写闭环 / 方案 F6）。
 *
 * - 标题文案单一出口（proposalToastTitle）：「智能体已提交《…》修订草案」；
 *   版本标签仅在可判定时缀后缀（受理初判无版本信息——不造 v(N+1)，偏差登记）；
 * - notice.kinds 路由词表（契约 J）：'proposal' → 通知条；其余 kinds 不触发；
 * - 组件文件仅 react/lucide/primitives 依赖（无 .css），node --test 可直引。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ProposalToast, { proposalToastTitle, type ProposalToastData } from '../src/components/ProposalToast';
import { subscribeWorkspaceStream, type WorkspaceChangeNotice } from '../src/services/workspaceClient';

describe('proposalToastTitle 文案单一出口', () => {
  test('无版本信息：不带版本后缀（受理初判无 v(N+1) 可判定，不造假）', () => {
    assert.equal(
      proposalToastTitle({ fileName: 'BOM与图纸联动方案', versionLabel: null }),
      '智能体已提交《BOM与图纸联动方案》修订草案'
    );
  });

  test('版本可判定时缀后缀（adopt report 回流新版本号后可补）', () => {
    assert.equal(
      proposalToastTitle({ fileName: 'BOM与图纸联动方案', versionLabel: 'v2' }),
      '智能体已提交《BOM与图纸联动方案》修订草案（v2）'
    );
  });
});

describe('SSE notice kinds 路由（契约 J）', () => {
  /** App 订阅回调的路由判定（与 App.tsx 内联逻辑同口径的纯描述） */
  function isProposalNotice(notice: WorkspaceChangeNotice): boolean {
    return notice.type === 'workspace-change' && !!notice.kinds?.includes('proposal');
  }

  test("kinds 含 'proposal' → 触发通知条数据拉取", () => {
    const notice: WorkspaceChangeNotice = {
      type: 'workspace-change',
      index_generation: 7,
      newEvents: 2,
      newRevisions: 1,
      at: '2026-11-18T00:00:00Z',
      kinds: ['proposal'],
    };
    assert.equal(isProposalNotice(notice), true);
  });

  test("其余 kinds（watcher/l4a/state/task/decision_writeback）与 hello 不触发", () => {
    assert.equal(isProposalNotice({ type: 'workspace-change', kinds: ['watcher', 'l4a'] }), false);
    assert.equal(isProposalNotice({ type: 'workspace-change', kinds: ['decision_writeback'] }), false);
    assert.equal(isProposalNotice({ type: 'workspace-change' }), false);
    assert.equal(isProposalNotice({ type: 'hello', kinds: ['proposal'] }), false);
  });
});

describe('ProposalToast 组件模块面', () => {
  test('默认导出为 React 组件、Props 契约形状齐备（编译锁）', () => {
    assert.equal(typeof ProposalToast, 'function');
    const toast: ProposalToastData = {
      draftId: 'draft_1',
      fileId: 'f_bom',
      fileName: 'BOM与图纸联动方案',
      versionLabel: null,
      conflict: false,
    };
    assert.equal(toast.draftId, 'draft_1');
  });
});

describe('subscribeWorkspaceStream 具名 SSE 事件订阅（契约 J）', () => {
  test('正确订阅 workspace-change / hello 具名事件并兼容 snake_case 计数', () => {
    const listeners = new Map<string, Set<(ev: { data: string }) => void>>();
    let closed = false;
    class FakeEventSource {
      onmessage: ((ev: { data: string }) => void) | null = null;
      constructor(public url: string) {}
      addEventListener(type: string, fn: (ev: { data: string }) => void) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(fn);
      }
      removeEventListener(type: string, fn: (ev: { data: string }) => void) {
        listeners.get(type)?.delete(fn);
      }
      close() {
        closed = true;
      }
    }
    const prevEventSource = (globalThis as Record<string, unknown>).EventSource;
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    const received: WorkspaceChangeNotice[] = [];
    try {
      const unsub = subscribeWorkspaceStream((n) => received.push(n));
      for (const fn of listeners.get('workspace-change') ?? []) {
        fn({
          data: JSON.stringify({
            type: 'workspace-change',
            index_generation: 3,
            new_events: 2,
            new_revisions: 1,
            kinds: ['proposal'],
          }),
        });
      }
      assert.equal(received.length, 1);
      assert.equal(received[0].type, 'workspace-change');
      assert.deepEqual(received[0].kinds, ['proposal']);
      assert.equal(received[0].newEvents, 2);
      assert.equal(received[0].newRevisions, 1);
      unsub();
      assert.equal(closed, true);
    } finally {
      if (prevEventSource === undefined) {
        delete (globalThis as Record<string, unknown>).EventSource;
      } else {
        (globalThis as Record<string, unknown>).EventSource = prevEventSource;
      }
    }
  });
});
