import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('A03 OS watcher SSE 通知接线', () => {
  it('App.tsx 监听 watcher workspace-change 并驱动变更提示条（不干扰既有 proposal/writeback 路由）', () => {
    // D01-a 拆层后 App 实现 = 装配层 + 单一 Store——联合文本断言（语义不变）
    const src = ['App.tsx', 'stores/useWorkspaceStore.tsx']
      .map((p) => fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', p), 'utf8'))
      .join(String.fromCharCode(10))
    assert.match(src, /kinds\.includes\('watcher'\)/);
    assert.match(src, /setChangeNotice/);
  });
});
