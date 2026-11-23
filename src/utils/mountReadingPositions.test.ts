import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMountedReadings,
  latestMountedReadings,
  mountReadingStorageKey,
  recordMountedReading,
} from './mountReadingPositions';

/**
 * C05 行为锁定：外挂资料阅读位置按规范化路径稳定哈希（来源工作区 root_key）
 * 分桶持久保留——
 * · 桶键稳定：同 rootKey 同键（`guanlan.mountReading.v1.<rootKey>`）；
 * · record/load roundtrip：同文件覆盖、不同文件并存、同版本重复记录零写入；
 * · SSR 安全：window 未定义恒空表 / 恒不写入；
 * · 损坏 JSON 恒空表（隐私模式/配额满静默降级语义）。
 */

/** 每测试独立 localStorage 隔离（node 环境无 window，测试内自建桩） */
function withWindow(fn: (store: Map<string, string>) => void): void {
  const store = new Map<string, string>();
  const fakeWindow = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    fn(store);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

test('桶键稳定：同 rootKey 同键，键含固定前缀', () => {
  assert.equal(
    mountReadingStorageKey('rk1234567890abcdef'),
    'guanlan.mountReading.v1.rk1234567890abcdef'
  );
  assert.equal(mountReadingStorageKey('  rk1234567890abcdef '), mountReadingStorageKey('rk1234567890abcdef'));
  assert.equal(mountReadingStorageKey(''), 'guanlan.mountReading.v1');
});

test('record/load roundtrip：同文件覆盖、不同文件并存、同版本重复记录零写入', () => {
  withWindow((store) => {
    const rk = 'rk_stable_hash_01';
    const entry = {
      file_id: 'f_ref_a',
      revision_id: 'f_ref_a_r1',
      relative_path: 'specs/登录方案-历史采纳.md',
      title: '历史采纳',
    };
    assert.equal(recordMountedReading(rk, entry), true, '首次记录写入');
    assert.equal(
      recordMountedReading(rk, { ...entry, revision_id: 'f_ref_a_r2' }),
      true,
      '新版本覆盖写入'
    );
    assert.equal(
      recordMountedReading(rk, { ...entry, revision_id: 'f_ref_a_r2' }),
      false,
      '同版本重复记录零写入'
    );
    recordMountedReading(rk, {
      file_id: 'f_ref_b',
      revision_id: 'f_ref_b_r1',
      relative_path: 'specs/架构图.svg',
      title: '架构图',
    });
    const map = loadMountedReadings(rk);
    assert.equal(map.f_ref_a.revision_id, 'f_ref_a_r2', '同文件覆盖');
    assert.equal(map.f_ref_b.title, '架构图', '不同文件并存');
    // 桶隔离：另一参考工作区互不可见
    assert.deepEqual(loadMountedReadings('rk_other_bucket'), {});
    // 最近查阅：at 最新优先
    const latest = latestMountedReadings(rk, 5);
    assert.equal(latest.length, 2);
    assert.ok(latest.every((e) => typeof e.at === 'string' && e.at.length > 0));
    // 存储键即前缀 + rootKey
    assert.equal(store.size, 1);
    assert.ok(store.has('guanlan.mountReading.v1.rk_stable_hash_01'));
  });
});

test('SSR 安全：window 未定义恒空表、恒不写入', () => {
  assert.deepEqual(loadMountedReadings('rk_any'), {});
  assert.equal(
    recordMountedReading('rk_any', {
      file_id: 'f',
      revision_id: 'f_r1',
      relative_path: 'p',
      title: 't',
    }),
    false
  );
  assert.deepEqual(latestMountedReadings('rk_any'), []);
});

test('损坏 JSON 恒空表（隐私模式/配额满静默降级同语义）', () => {
  withWindow((store) => {
    store.set('guanlan.mountReading.v1.rk_bad', '{not-json');
    assert.deepEqual(loadMountedReadings('rk_bad'), {});
    store.set('guanlan.mountReading.v1.rk_array', '[1,2]');
    assert.deepEqual(loadMountedReadings('rk_array'), {});
  });
});
