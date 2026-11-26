import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';


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
