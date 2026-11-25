import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  crossHitsToItems,
  mergeCrossItems,
  onlineMountCount,
  shouldFetchCrossSearch,
} from './crossWorkspaceSearch';
import type { CrossSearchResponseDto, MountedWorkspaceDto } from '../services/apiTypes';
import type { PaletteItem } from './commandPaletteResults';
import { MountManagerPanel } from '../components/MountManagerPanel';

/**
 * 跨项目联合检索行为锁定（纯函数 + SSR 冒烟）：
 * · 跨库命中 → 面板条目携带 sourceWorkspace 徽标数据（工作区名 + 身份哈希）；
 *   主区命中（无 source_workspace）不进入跨库层；
 * · 三层合并 fileId 去重（主区优先）与 score 排序；离线挂载零条目；
 * · 在线挂载判定（离线区不触发 cross 请求）；
 * · MountManagerPanel SSR：挂载行（在线/离线徽标 + 短哈希 + 最后已知摘要）与
 *   错误行按需出现，SSR 安全。
 */

function mount(overrides: Partial<MountedWorkspaceDto> = {}): MountedWorkspaceDto {
  return {
    mount_id: 'm_abc1234567890def',
    mount_key: 'abc1234567890def',
    root_key: 'rk1234567890abcdef',
    root_path: 'D:\\archive\\legacy-a',
    name: 'legacy-a',
    online: true,
    index_generation: 3,
    search_state: 'ready',
    file_count: 12,
    ...overrides,
  };
}

function crossResponse(
  items: CrossSearchResponseDto['items'],
  mounts: MountedWorkspaceDto[]
): CrossSearchResponseDto {
  return {
    ok: true,
    index_generation: 7,
    query: '登录方案',
    mode: 'phrase',
    total_matched: items.length,
    items,
    truncated: false,
    search_state: 'ready',
    mounts,
  };
}

function mountedHit(fileId: string, score: number): CrossSearchResponseDto['items'][number] {
  return {
    file_id: fileId,
    revision_id: `${fileId}_r1`,
    relative_path: `specs/${fileId}.md`,
    title: fileId,
    format: 'md',
    coverage: 'full_text',
    match_strategy: 'bigram_phrase_verified',
    locator: { kind: 'lines', start: 1, end: 1 },
    snippet: '历史采纳：登录方案先走双通道。',
    score,
    stale: false,
    source_workspace: { workspace_id: 'ws_rk1234567890abcdef', root_key: 'rk1234567890abcdef', name: 'legacy-a' },
  };
}

function primaryHit(fileId: string, score: number): CrossSearchResponseDto['items'][number] {
  return { ...mountedHit(fileId, score), source_workspace: undefined };
}

test('crossHitsToItems 携带来源徽标并跳过主区命中', () => {
  const items = crossHitsToItems(
    crossResponse([mountedHit('f_ref', 80), primaryHit('f_main', 60)], [mount()]),
    30
  );
  assert.equal(items.length, 1, '主区命中（无 source_workspace）不进跨库层');
  assert.equal(items[0].fileId, 'f_ref');
  assert.deepEqual(items[0].sourceWorkspace, {
    name: 'legacy-a',
    rootKey: 'rk1234567890abcdef',
  });
  assert.equal(items[0].key.startsWith('cross:'), true, 'key 前缀 cross: 与主区/本地层互不冲突');
});

test('mergeCrossItems 三层合并：fileId 去重主区优先 + score 排序 + 动作行原样保留', () => {
  const cross: PaletteItem[] = crossHitsToItems(
    crossResponse([mountedHit('f_ref', 90), mountedHit('f_dup', 20)], [mount()]),
    30
  );
  const base: PaletteItem[] = [
    {
      kind: 'file',
      key: 'srv:f_dup:r1',
      title: 'dup',
      score: 60,
      fileId: 'f_dup',
    },
    {
      kind: 'action',
      key: 'action:mount-workspace',
      title: '挂载参考工作区',
      score: 27,
      actionId: 'mount-workspace',
    },
  ];
  const merged = mergeCrossItems(cross, base, 30);
  // f_dup 主区保留（同 id 主区优先）；f_ref score 90 在前；动作行保留
  const ids = merged.filter((i) => i.kind === 'file').map((i) => i.fileId);
  assert.deepEqual(ids, ['f_ref', 'f_dup']);
  assert.ok(merged.some((i) => i.kind === 'action' && i.actionId === 'mount-workspace'));
});

test('mergeCrossItems limit 收口', () => {
  const cross = crossHitsToItems(
    crossResponse(
      [mountedHit('a', 5), mountedHit('b', 4), mountedHit('c', 3), mountedHit('d', 2)],
      [mount()]
    ),
    30
  );
  assert.equal(mergeCrossItems(cross, [], 3).length, 3);
});

test('在线挂载判定：离线区不触发 cross 请求', () => {
  const online = [mount(), mount({ mount_id: 'm_2', root_key: 'rk2', online: false })];
  assert.equal(onlineMountCount(online), 1);
  assert.equal(shouldFetchCrossSearch(online), true);
  assert.equal(shouldFetchCrossSearch([mount({ online: false })]), false);
  assert.equal(shouldFetchCrossSearch([]), false);
});

test('MountManagerPanel SSR：挂载行/离线徽标/最后已知摘要/错误行按需出现', () => {
  const html = renderToStaticMarkup(
    React.createElement(MountManagerPanel, {
      isOpen: true,
      onClose: () => {},
      mounts: [
        mount(),
        mount({
          mount_id: 'm_offline',
          mount_key: 'ffffffffffffffff',
          root_key: 'rk_offline',
          root_path: 'Z:\\no-such-dir\\gone-ws',
          name: 'gone-ws',
          online: false,
          search_state: 'ready',
          file_count: 42,
          error: '重启后无法打开索引库，已离线',
        }),
      ],
      loading: false,
      error: '参考目录 D:\\x 位于当前工作区根目录之内：父子目录互相包含互斥',
      onMount: async () => true,
      onUnmount: async () => true,
    })
  );
  assert.ok(html.includes('legacy-a'), '在线挂载行渲染');
  assert.ok(html.includes('在线'), '在线徽标');
  assert.ok(html.includes('离线'), '离线徽标');
  assert.ok(html.includes('42 份资料'), '最后已知摘要（文件数）');
  assert.ok(html.includes('rk123456'), 'root_key 8 位短哈希（快照哈希标识）');
  assert.ok(html.includes('父子目录互相包含互斥'), '确定性错误行透出');
  assert.ok(html.includes('D:\\\\archive\\\\legacy-a') || html.includes('archive'), '规范化根路径展示');
  // 关闭态渲染为空
  const closed = renderToStaticMarkup(
    React.createElement(MountManagerPanel, {
      isOpen: false,
      onClose: () => {},
      mounts: [],
      loading: false,
      error: '',
      onMount: async () => true,
      onUnmount: async () => true,
    })
  );
  assert.equal(closed, '');
});
