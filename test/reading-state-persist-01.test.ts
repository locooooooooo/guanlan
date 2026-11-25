import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCoalescedPersist, type CoalescedTimer } from '../src/utils/coalescedPersist';
import { READING_STATE_PERSIST_DEBOUNCE_MS } from '../src/utils/readingStateStore';

/**
 * 阅读状态落盘合批：
 *
 * 背景：`readingStates` 每次变化都整表 `JSON.stringify` 写 localStorage；滚动进度
 * 也在改这张表，几万条记录时主线程在滚动路径上被同步序列化占满。合批只推迟写入
 * 时机，最终状态仍会落盘（尾沿 / 页面隐藏 / 切换工作区）。
 */

function fakeTimer(): CoalescedTimer & {
  fire(): void;
  pendingCount(): number;
} {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimeout(cb) {
      seq += 1;
      pending.set(seq, cb);
      return seq;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
    pendingCount() {
      return pending.size;
    },
  };
}

test('高频 schedule 只保留一个定时器，尾沿写一次', () => {
  let writes = 0;
  const timer = fakeTimer();
  const persist = createCoalescedPersist(() => {
    writes += 1;
  }, READING_STATE_PERSIST_DEBOUNCE_MS, timer);

  for (let i = 0; i < 50; i += 1) persist.schedule();
  assert.equal(writes, 0, '合批窗口内不写');
  assert.equal(timer.pendingCount(), 1, '重复 schedule 只留一个定时器');

  timer.fire();
  assert.equal(writes, 1);
});

test('flush 立即写并取消挂起的定时器，不会写两次', () => {
  let writes = 0;
  const timer = fakeTimer();
  const persist = createCoalescedPersist(() => {
    writes += 1;
  }, 800, timer);

  persist.schedule();
  persist.flush();
  assert.equal(writes, 1);
  assert.equal(timer.pendingCount(), 0);

  timer.fire();
  assert.equal(writes, 1, '已 flush 的挂起定时器不得再写一次');
});

test('cancel 丢弃挂起写入', () => {
  let writes = 0;
  const timer = fakeTimer();
  const persist = createCoalescedPersist(() => {
    writes += 1;
  }, 800, timer);

  persist.schedule();
  persist.cancel();
  timer.fire();
  assert.equal(writes, 0);
});

function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

test('工作区 Store 的阅读状态走合批写入，并在隐藏/切换前补写', () => {
  const src = readSrc('stores/useWorkspaceStore.tsx');
  assert.ok(src.includes('readingPersist.schedule()'), '状态变化应走合批 schedule');
  assert.ok(!src.includes('saveReadingStates(readingStates,'), '不得在变化时同步整表写入');
  assert.ok(src.includes("addEventListener('pagehide'"), '页面隐藏前补写');
  assert.ok(
    /readingPersist\.flush\(\);\s*readingWorkspaceIdRef\.current = null;/.test(src),
    '切换工作区/项目前补写当前工作区的阅读状态'
  );
});
