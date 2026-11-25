import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadReadingStates,
  pruneReadingStates,
  readingStateStorageKey,
  saveReadingStates,
} from '../src/utils/readingStateStore';
import {
  getInitialDesktopSession,
  isDesktopWorkspaceBridgeAvailable,
  pickDesktopWorkspaceFolder,
  refreshDesktopSession,
  removeRecentDesktopWorkspace,
  switchDesktopWorkspace,
  type DesktopSessionState,
} from '../src/services/desktopBridge';
import {
  clearRevisionContentStore,
  getRevisionContent,
  requestRevisionContent,
} from '../src/utils/revisionContentStore';
import {
  clearFilePreviewCache,
  filePreviewCacheStatsForTest,
  getFilePreviewEntry,
} from '../src/utils/filePreviewCache';
import { getApiBaseUrl, setApiBaseUrl } from '../src/services/workspaceClient';
import type { FileRecord, ReadingState } from '../src/types/guanlan';

function makeFile(id: string, path: string, markdownContent?: string): FileRecord {
  const revId = `${id}-r1`;
  return {
    file_id: id,
    relative_path: path,
    title: path,
    format: 'md',
    folder: '',
    role: '说明',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: revId,
    revisions:
      markdownContent !== undefined
        ? [
            {
              revision_id: revId,
              file_id: id,
              versionNumber: 1,
              content_sha256: 'abc',
              observed_at: '2026-11-18T10:00:00+08:00',
              sizeBytes: markdownContent.length,
              snapshotAvailable: true,
              markdownContent,
              summaryNote: '',
            },
          ]
        : [],
    coverage: 'full_text',
  };
}

function makeReading(fileId: string, pct: number, note?: string): ReadingState {
  return {
    file_id: fileId,
    last_read_revision_id: `${fileId}-r1`,
    scrollPercent: pct,
    isFullyRead: pct >= 100,
    bookmarked: pct > 50,
    personalNote: note,
    updated_at: '2026-11-18T10:00:00+08:00',
  };
}

describe('多工作区独立状态与桌面桥接', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as unknown as { window?: unknown }).window = originalWindow;
    setApiBaseUrl('');
    clearRevisionContentStore();
    clearFilePreviewCache();
  });

  it('三个工作区来回切换与剪枝后各自阅读进度/收藏/批注独立保留', () => {
    assert.equal(readingStateStorageKey('ws-a'), 'guanlan.readingState.v1.ws-a');
    assert.equal(readingStateStorageKey('ws-b'), 'guanlan.readingState.v1.ws-b');

    saveReadingStates(
      {
        a1: makeReading('a1', 75, 'Alpha 笔记'),
        staleA: makeReading('staleA', 20),
      },
      'ws-a'
    );
    saveReadingStates(
      {
        b1: makeReading('b1', 30, 'Beta 笔记'),
      },
      'ws-b'
    );
    saveReadingStates(
      {
        c1: makeReading('c1', 90, 'Gamma 笔记'),
      },
      'ws-c'
    );

    const filesA = [makeFile('a1', 'a.md')];
    const filesB = [makeFile('b1', 'b.md')];
    const filesC = [makeFile('c1', 'c.md')];

    // 切到 A 并剪枝（淘汰 staleA，绝不碰 B/C）
    const prunedA = pruneReadingStates(loadReadingStates('ws-a'), filesA);
    saveReadingStates(prunedA, 'ws-a');
    assert.deepEqual(Object.keys(prunedA), ['a1']);

    // 切到 B 并剪枝
    const prunedB = pruneReadingStates(loadReadingStates('ws-b'), filesB);
    saveReadingStates(prunedB, 'ws-b');
    assert.deepEqual(Object.keys(prunedB), ['b1']);

    // 切到 C 并剪枝
    const prunedC = pruneReadingStates(loadReadingStates('ws-c'), filesC);
    saveReadingStates(prunedC, 'ws-c');
    assert.deepEqual(Object.keys(prunedC), ['c1']);

    // 切回 A/B/C 验证全部保留且互不窜改
    assert.equal(loadReadingStates('ws-a').a1.personalNote, 'Alpha 笔记');
    assert.equal(loadReadingStates('ws-b').b1.personalNote, 'Beta 笔记');
    assert.equal(loadReadingStates('ws-c').c1.personalNote, 'Gamma 笔记');
  });

  it('切换工作区时清空正文与预览缓存并更新 API 基址', async () => {
    await requestRevisionContent('rev-old', async () => ({ ok: true, text: '# old' }), 'md');
    assert.equal(getRevisionContent('rev-old')?.text, '# old');

    const entry = getFilePreviewEntry(makeFile('file-old', 'old.md', '# Hello\nWorld'));
    assert.equal(entry.state, 'ready');
    assert.equal(filePreviewCacheStatsForTest().entries, 1);

    setApiBaseUrl('http://127.0.0.1:41001/');
    assert.equal(getApiBaseUrl(), 'http://127.0.0.1:41001');

    // 模拟切换工作区清理
    clearRevisionContentStore();
    clearFilePreviewCache();
    setApiBaseUrl('http://127.0.0.1:41002');

    assert.equal(getRevisionContent('rev-old'), undefined);
    assert.equal(filePreviewCacheStatsForTest().entries, 0);
    assert.equal(getApiBaseUrl(), 'http://127.0.0.1:41002');
  });

  it('无桌面桥时安全降级，有桥时正确路由目录选择/切换/冲突与移除', async () => {
    assert.equal(isDesktopWorkspaceBridgeAvailable(), false);
    assert.equal(getInitialDesktopSession(), null);
    const noBridgePick = await pickDesktopWorkspaceFolder();
    assert.equal(noBridgePick.ok, false);

    const conflictState: DesktopSessionState = {
      status: 'root_in_use',
      endpoint: '',
      root: 'D:\\ws-busy',
      workspaceName: 'ws-busy',
      previousRoot: 'D:\\ws-prev',
      recentWorkspaces: [
        { root: 'D:\\ws-prev', name: 'ws-prev', lastOpenedAt: '2026-11-18T10:00:00Z', exists: true },
      ],
      error: {
        code: 'ROOT_IN_USE',
        message: 'occupied',
        root: 'D:\\ws-busy',
        lockFilePath: 'C:\\data\\service.lock',
        lockInfo: 'pid=9999',
      },
    };

    const g = globalThis as unknown as { window: Record<string, unknown> };
    g.window = {
      ...g.window,
      __GUANLAN_BOOT__: {
        status: 'unconfigured',
        endpoint: '',
        root: null,
        workspaceName: null,
        recentWorkspaces: [],
      },
      __GUANLAN_WORKSPACE_BRIDGE__: {
        getState: async () => conflictState,
        pickFolder: async () => 'D:\\ws-picked',
        switchWorkspace: async (root: string) => {
          if (root === 'D:\\missing') {
            throw { code: 'NOT_FOUND', message: '目录不存在', root };
          }
          return {
            status: 'ready',
            endpoint: 'http://127.0.0.1:52001',
            root,
            workspaceName: 'ws-picked',
            recentWorkspaces: [
              { root, name: 'ws-picked', lastOpenedAt: '2026-11-18T10:05:00Z', exists: true },
            ],
          };
        },
        removeRecentWorkspace: async () => [],
      },
    };

    assert.equal(isDesktopWorkspaceBridgeAvailable(), true);
    assert.equal(getInitialDesktopSession()?.status, 'unconfigured');

    const picked = await pickDesktopWorkspaceFolder();
    assert.deepEqual(picked, { ok: true, path: 'D:\\ws-picked' });

    const missing = await switchDesktopWorkspace('D:\\missing');
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, 'NOT_FOUND');

    const switched = await switchDesktopWorkspace('D:\\ws-picked');
    assert.equal(switched.ok, true);
    if (switched.ok) {
      assert.equal(switched.state.status, 'ready');
      assert.equal(switched.state.endpoint, 'http://127.0.0.1:52001');
    }

    const refreshed = await refreshDesktopSession();
    assert.equal(refreshed?.status, 'root_in_use');
    assert.equal(refreshed?.previousRoot, 'D:\\ws-prev');

    const removed = await removeRecentDesktopWorkspace('D:\\ws-prev');
    assert.deepEqual(removed, []);
  });
});
