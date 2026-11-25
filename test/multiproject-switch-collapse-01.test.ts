import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 多项目聚焦切换：展开集不能越切越多 —— 契约测试。
 *
 * 事故：从 guanlan 切到 GuanLan 后，左侧目录栏里旧聚焦项目的树仍保持展开，
 * 两个项目的文件夹同时占满侧栏；expandedProjects 还会持久化到 localStorage，
 * 重启后依旧两份。
 *
 * 规则（纯函数见 sidebarTree.expandedProjectsAfterActivate）：
 *  ① 新的聚焦项目展开；
 *  ② 旧的聚焦项目收起（即使新项目本来就在展开集里，也不能提前返回）；
 *  ③ 用户手动展开的其他项目保持——多项目同时展开仍是显式能力。
 *
 * 本文件守的是接线：hook 里两个入口（添加并激活 / 切换聚焦）都必须走该纯函数。
 * node:test 没有 DOM/hook 运行器，行为规则由 sidebarTree.test.ts 覆盖，这里按本仓
 * 既有做法用源码子串断言接线。
 */

function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

test('多项目切换：切换聚焦项目与添加并激活都收起旧聚焦项目', () => {
  const hook = readSrc('hooks/useMultiProjects.ts');

  assert.ok(
    hook.includes('expandedProjectsAfterActivate'),
    'hook 必须使用「新聚焦展开、旧聚焦收起」的单一纯函数'
  );

  const addStart = hook.indexOf('const handleAddProject = useCallback');
  const activateStart = hook.indexOf('const handleActivateProject = useCallback');
  const updateStart = hook.indexOf('const handleUpdateProject = useCallback');
  assert.ok(
    addStart > -1 && activateStart > addStart && updateStart > activateStart,
    '两个入口的源码锚点必须存在（处理器被改名时本测试要跟着改，而不是静默放行）'
  );

  const addBody = hook.slice(addStart, activateStart);
  const activateBody = hook.slice(activateStart, updateStart);
  const callsHelperWithPrevActive = (body: string): boolean =>
    /expandedProjectsAfterActivate\(\s*prev,\s*activeProjectId/.test(body);

  assert.ok(
    callsHelperWithPrevActive(addBody),
    '添加并激活（等于一次聚焦切换）必须收起旧聚焦项目'
  );
  assert.ok(
    callsHelperWithPrevActive(activateBody),
    '切换聚焦项目必须收起旧聚焦项目'
  );
  assert.ok(
    !activateBody.includes('if (prev.has(projectId)) return prev;'),
    '新项目已在展开集里时也不能提前返回——旧聚焦项目仍要收起'
  );
});
