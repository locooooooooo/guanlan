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
