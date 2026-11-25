/**
 * stage-classify-01：阶段分类双端共享向量锁。
 *
 * 向量单源 = native/testdata/stage-vectors.json（git 内静态文件，与 Rust
 * include_str! 编译期读取同源——双端同步点从『人工双侧改』机械化为本文件）：
 *  - agree：前端 stageOfPath 与 Rust stage_from_path 必须同判的核心向量；
 *  - divergent_registered：已登记的刻意分叉（[路径, 前端值, Rust值, 说明]）——
 *    本文件断言前端值；Rust 值由 state_machine.rs 内联测试断言。收敛分叉必须
 *    先改向量文件并双侧同步实现。
 *
 * 背景：两套规则此前仅注释互指「镜像」，实际是独立实现
 * （英文关键词/容器兜底/「已确认」词/全路径 vs basename 匹配域均有分叉），无任何
 * 机制防止单侧演进静默漂移——本测试即该机制。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { stageOfPath } from '../src/utils/taskPackages';
import type { StageRole } from '../src/utils/stateProjection';

interface StageVectorFile {
  comment: string;
  agree: Array<[string, StageRole]>;
  divergent_registered: Array<[string, StageRole, StageRole, string]>;
}

const vectorsPath = new URL('../native/testdata/stage-vectors.json', import.meta.url);
const vectorFile = JSON.parse(readFileSync(vectorsPath, 'utf8')) as StageVectorFile;

describe('stageOfPath 与共享 agree 向量逐条一致（双端同判核心）', () => {
  test('向量文件存在且 agree 向量非空（无 seed 依赖——git 内静态文件）', () => {
    assert.ok(vectorFile.agree.length >= 10, `agree 条数 ${vectorFile.agree.length}`);
    assert.ok(
      vectorFile.divergent_registered.length >= 5,
      `登记分叉条数 ${vectorFile.divergent_registered.length}`
    );
  });

  for (const [path, expected] of vectorFile.agree) {
    test(`stageOfPath(${JSON.stringify(path)}) = ${expected}`, () => {
      assert.equal(stageOfPath(path), expected);
    });
  }
});

describe('登记分叉持续存在（收敛须先改 stage-vectors.json 并双侧同步实现）', () => {
  for (const [path, tsExpected, rustExpected, note] of vectorFile.divergent_registered) {
    test(`前端值：${JSON.stringify(path)} = ${tsExpected}（Rust=${rustExpected}）`, () => {
      assert.equal(stageOfPath(path), tsExpected, note);
    });
  }
});
