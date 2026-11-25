/**
 * 全键盘无鼠工作流、来源栈 Esc、FileOpHistory Undo/Redo、画布空间漫游与无障碍动效纯函数单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveMotionDurationMs,
  isEditableLikeTarget,
  isNativeActivatingTarget,
  preferredScrollBehavior,
  resolveShortcutAction,
  resolveShortcutActionFromEvent,
  SHORTCUT_CHEATSHEET_GROUPS,
  shortcutTargetYields,
  STORE_SHORTCUT_ACTIONS,
  type RawKeyInput,
} from './keyboardShortcuts';
import {
  defaultNavSourceLabel,
  describeNavSourceReturn,
  MAX_NAV_SOURCE_DEPTH,
  peekNavSource,
  popNavSource,
  pushNavSource,
  type NavSourceEntry,
} from './navigationSourceStack';
import {
  describeFileOpPlan,
  EMPTY_FILE_OP_HISTORY,
  FILE_OP_MERGE_WINDOW_MS,
  MAX_FILE_OP_HISTORY,
  planRedo,
  planUndo,
  recordFileOp,
  type FileOpHistoryState,
} from './fileOpHistory';
import {
  buildSpatialAdjacency,
  pickSpatialNeighbor,
  type SpatialNavNode,
} from './canvasSpatialNav';

function key(
  k: string,
  mods: Partial<Omit<RawKeyInput, 'key'>> = {}
): RawKeyInput {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    isComposing: mods.isComposing ?? false,
  };
}

const OPEN_CTX = { editableTarget: false, overlayOpen: false };

// ── 1. keyboardShortcuts ──────────────────────────────────────────────────────

test('keyboardShortcuts：全量 9 个动作键解析与 Escape/?/Space/Alt 方向键正交让位', () => {
  assert.equal(resolveShortcutAction(key('j'), OPEN_CTX), 'event-next');
  assert.equal(resolveShortcutAction(key('J'), OPEN_CTX), 'event-next');
  assert.equal(resolveShortcutAction(key('k'), OPEN_CTX), 'event-prev');
  assert.equal(resolveShortcutAction(key('h'), OPEN_CTX), 'collapse-focus');
  assert.equal(resolveShortcutAction(key('l'), OPEN_CTX), 'expand-focus');
  assert.equal(resolveShortcutAction(key('Enter'), OPEN_CTX), 'deep-read-focus');
  assert.equal(resolveShortcutAction(key('d'), OPEN_CTX), 'open-version-diff');
  assert.equal(resolveShortcutAction(key('c'), OPEN_CTX), 'add-focus-to-basket');
  assert.equal(resolveShortcutAction(key('z', { ctrlKey: true }), OPEN_CTX), 'undo-op');
  assert.equal(resolveShortcutAction(key('z', { metaKey: true }), OPEN_CTX), 'undo-op');
  assert.equal(
    resolveShortcutAction(key('Z', { ctrlKey: true, shiftKey: true }), OPEN_CTX),
    'redo-op'
  );
  assert.equal(
    resolveShortcutAction(key('z', { metaKey: true, shiftKey: true }), OPEN_CTX),
    'redo-op'
  );

  // 既有监听独占的键恒返回 null，绝不双解析
  assert.equal(resolveShortcutAction(key('Escape'), OPEN_CTX), null);
  assert.equal(resolveShortcutAction(key('?'), OPEN_CTX), null);
  assert.equal(resolveShortcutAction(key(' '), OPEN_CTX), null);
  assert.equal(resolveShortcutAction(key('ArrowRight', { altKey: true }), OPEN_CTX), null);
  assert.equal(resolveShortcutAction(key('k', { ctrlKey: true }), OPEN_CTX), null);
  assert.equal(resolveShortcutAction(key('z', { ctrlKey: true, altKey: true }), OPEN_CTX), null);

  // Store 动作集不包含视图级 J/K/H/L
  assert.equal(STORE_SHORTCUT_ACTIONS.has('event-next'), false);
  assert.equal(STORE_SHORTCUT_ACTIONS.has('undo-op'), true);
  assert.equal(STORE_SHORTCUT_ACTIONS.has('open-version-diff'), true);
});

test('keyboardShortcuts 停机线①：编辑态（input/textarea/select/contenteditable）与组字态全键让路含 Ctrl+Z', () => {
  const editCtx = { editableTarget: true, overlayOpen: false };
  assert.equal(resolveShortcutAction(key('z', { ctrlKey: true }), editCtx), null);
  assert.equal(
    resolveShortcutAction(key('z', { ctrlKey: true, shiftKey: true }), editCtx),
    null
  );
  assert.equal(resolveShortcutAction(key('j'), editCtx), null);
  assert.equal(resolveShortcutAction(key('Enter'), editCtx), null);
  assert.equal(resolveShortcutAction(key('d'), editCtx), null);
  assert.equal(resolveShortcutAction(key('c'), editCtx), null);
  assert.equal(resolveShortcutAction(key('j', { isComposing: true }), OPEN_CTX), null);

  // 浮层打开时同样全键让路
  const overlayCtx = { editableTarget: false, overlayOpen: true };
  assert.equal(resolveShortcutAction(key('z', { ctrlKey: true }), overlayCtx), null);
  assert.equal(resolveShortcutAction(key('d'), overlayCtx), null);
  assert.equal(resolveShortcutAction(key('Enter'), overlayCtx), null);

  // 编辑元素鸭子判定覆盖全部四类
  assert.equal(isEditableLikeTarget({ tagName: 'INPUT' } as unknown as EventTarget), true);
  assert.equal(isEditableLikeTarget({ tagName: 'textarea' } as unknown as EventTarget), true);
  assert.equal(isEditableLikeTarget({ tagName: 'SELECT' } as unknown as EventTarget), true);
  assert.equal(
    isEditableLikeTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    true
  );
  assert.equal(isEditableLikeTarget({ tagName: 'DIV' } as unknown as EventTarget), false);
  assert.equal(shortcutTargetYields({ tagName: 'INPUT' } as unknown as EventTarget, false), true);
  assert.equal(shortcutTargetYields({ tagName: 'DIV' } as unknown as EventTarget, true), true);
  assert.equal(shortcutTargetYields({ tagName: 'DIV' } as unknown as EventTarget, false), false);
});

test('keyboardShortcuts：原生可激活元素聚焦时只让位 Enter，不阻断 J/K/H/L/D/C 与 Ctrl+Z', () => {
  const buttonTarget = { tagName: 'BUTTON' } as unknown as EventTarget;
  const roleButtonCard = {
    tagName: 'DIV',
    closest: (sel: string) => (sel.includes('[role="button"]') ? {} : null),
  } as unknown as EventTarget;

  assert.equal(isNativeActivatingTarget(buttonTarget), true);
  assert.equal(isNativeActivatingTarget(roleButtonCard), true);

  // Enter 让位给按钮原生激活 / 卡片本地 Enter
  assert.equal(
    resolveShortcutActionFromEvent({ ...key('Enter'), target: buttonTarget }, OPEN_CTX),
    null
  );
  assert.equal(
    resolveShortcutActionFromEvent({ ...key('Enter'), target: roleButtonCard }, OPEN_CTX),
    null
  );
  // 点击事件卡后再按 J/K/H/L/D/C 或 Ctrl+Z 立即生效
  assert.equal(
    resolveShortcutActionFromEvent({ ...key('j'), target: roleButtonCard }, OPEN_CTX),
    'event-next'
  );
  assert.equal(
    resolveShortcutActionFromEvent({ ...key('h'), target: buttonTarget }, OPEN_CTX),
    'collapse-focus'
  );
  assert.equal(
    resolveShortcutActionFromEvent({ ...key('d'), target: roleButtonCard }, OPEN_CTX),
    'open-version-diff'
  );
  assert.equal(
    resolveShortcutActionFromEvent({ ...key('z', { ctrlKey: true }), target: buttonTarget }, OPEN_CTX),
    'undo-op'
  );
});

test('reduced-motion 动效降级纯函数与速查表完整性', () => {
  assert.equal(effectiveMotionDurationMs(260, true), 0);
  assert.equal(effectiveMotionDurationMs(500, true), 0);
  assert.equal(effectiveMotionDurationMs(260, false), 260);
  assert.equal(effectiveMotionDurationMs(0, false), 0);
  assert.equal(preferredScrollBehavior(true), 'auto');
  assert.equal(preferredScrollBehavior(false), 'smooth');

  const allKeys = SHORTCUT_CHEATSHEET_GROUPS.flatMap((g) => g.items.map((i) => i.keys));
  for (const required of ['J / K', 'H / L', 'Alt + ↑↓←→', 'Space', 'Enter', 'D', 'C', 'Ctrl + Z', 'Ctrl + Shift + Z', 'Esc', '?']) {
    assert.ok(allKeys.includes(required), `速查表缺少键位：${required}`);
  }
});

// ── 2. navigationSourceStack ──────────────────────────────────────────────────

test('navigationSourceStack：多层嵌套原路精确返回（星图→文档A→文档B→文档A→星图）与各视图诚实标签', () => {
  assert.equal(defaultNavSourceLabel('home', 'canvas', 'read'), '今日观澜');
  assert.equal(defaultNavSourceLabel('panorama', 'canvas', 'read'), '全景溯源星图');
  assert.equal(defaultNavSourceLabel('panorama', 'list', 'read'), '观察时间线');
  assert.equal(defaultNavSourceLabel('panorama', 'calendar', 'read'), '日历看板');
  assert.equal(defaultNavSourceLabel('library', 'canvas', 'overview'), '任务包概览');
  assert.equal(defaultNavSourceLabel('library', 'canvas', 'read', '架构方案'), '文档：架构方案');

  const eCanvas: NavSourceEntry = {
    activeTab: 'panorama',
    panoramaMode: 'canvas',
    libraryMode: 'read',
    fileId: '',
    revisionId: '',
    label: '全景溯源星图',
    atMs: 1000,
  };
  const eDocA: NavSourceEntry = {
    activeTab: 'library',
    panoramaMode: 'canvas',
    libraryMode: 'read',
    fileId: 'f_a',
    revisionId: 'r_a1',
    sectionId: 'sec_2',
    label: '原段落：方案A · sec_2',
    atMs: 2000,
  };

  let stack: NavSourceEntry[] = [];
  stack = pushNavSource(stack, eCanvas);
  stack = pushNavSource(stack, eDocA);
  // 连续压入同落点去重（不重复堆叠）
  stack = pushNavSource(stack, { ...eDocA, atMs: 2500 });
  assert.equal(stack.length, 2);
  assert.equal(describeNavSourceReturn(peekNavSource(stack)!), '返回原段落：方案A · sec_2');

  const p1 = popNavSource(stack);
  assert.equal(p1.entry?.fileId, 'f_a');
  assert.equal(p1.entry?.sectionId, 'sec_2');
  const p2 = popNavSource(p1.stack);
  assert.equal(p2.entry?.activeTab, 'panorama');
  assert.equal(p2.entry?.panoramaMode, 'canvas');
  const p3 = popNavSource(p2.stack);
  assert.equal(p3.entry, null);
  assert.equal(p3.stack.length, 0);
});

test('navigationSourceStack：超 32 层按最旧丢弃（有界栈深）', () => {
  let stack: NavSourceEntry[] = [];
  for (let i = 0; i < MAX_NAV_SOURCE_DEPTH + 5; i += 1) {
    stack = pushNavSource(stack, {
      activeTab: 'library',
      panoramaMode: 'canvas',
      libraryMode: 'read',
      fileId: `f_${i}`,
      revisionId: `r_${i}`,
      label: `文档 ${i}`,
      atMs: i * 100,
    });
  }
  assert.equal(stack.length, MAX_NAV_SOURCE_DEPTH);
  assert.equal(stack[0].fileId, 'f_5');
  assert.equal(peekNavSource(stack)?.fileId, `f_${MAX_NAV_SOURCE_DEPTH + 4}`);
});

// ── 3. fileOpHistory ──────────────────────────────────────────────────────────

test('fileOpHistory：连续 3 次改名/移动后连按 3 次 Ctrl+Z 100% 原路还原路径与 file_id，并支持 3 次 Redo', () => {
  let state: FileOpHistoryState = EMPTY_FILE_OP_HISTORY;
  const fId = 'file_plan_01';

  // 第 1 步：重命名 docs/plan.md → docs/plan-v2.md
  state = recordFileOp(state, {
    kind: 'rename',
    fileId: fId,
    oldPath: 'docs/plan.md',
    newPath: 'docs/plan-v2.md',
    nowMs: 1000,
  }).state;
  // 第 2 步：移动 docs/plan-v2.md → archive/plan-v2.md
  state = recordFileOp(state, {
    kind: 'move',
    fileId: fId,
    oldPath: 'docs/plan-v2.md',
    newPath: 'archive/plan-v2.md',
    nowMs: 2000,
  }).state;
  // 第 3 步：重命名 archive/plan-v2.md → archive/plan-final.md
  state = recordFileOp(state, {
    kind: 'rename',
    fileId: fId,
    oldPath: 'archive/plan-v2.md',
    newPath: 'archive/plan-final.md',
    nowMs: 3000,
  }).state;

  assert.equal(state.undo.length, 3);
  let diskPath = 'archive/plan-final.md';

  // 连按 3 次 Undo
  const u1 = planUndo(state, [{ file_id: fId, relative_path: diskPath }]);
  assert.equal(u1.ok, true);
  if (u1.ok) {
    assert.deepEqual(u1.request, {
      kind: 'rename',
      fileId: fId,
      targetDir: 'archive',
      newName: 'plan-v2.md',
    });
    assert.match(describeFileOpPlan(u1.entry, 'undo'), /撤销重命名/);
    state = u1.nextState;
    diskPath = 'archive/plan-v2.md';
  }

  const u2 = planUndo(state, [{ file_id: fId, relative_path: diskPath }]);
  assert.equal(u2.ok, true);
  if (u2.ok) {
    assert.deepEqual(u2.request, {
      kind: 'move',
      fileId: fId,
      targetDir: 'docs',
      newName: 'plan-v2.md',
    });
    state = u2.nextState;
    diskPath = 'docs/plan-v2.md';
  }

  const u3 = planUndo(state, [{ file_id: fId, relative_path: diskPath }]);
  assert.equal(u3.ok, true);
  if (u3.ok) {
    assert.deepEqual(u3.request, {
      kind: 'rename',
      fileId: fId,
      targetDir: 'docs',
      newName: 'plan.md',
    });
    state = u3.nextState;
    diskPath = 'docs/plan.md';
  }

  assert.equal(diskPath, 'docs/plan.md');
  assert.equal(state.undo.length, 0);
  assert.equal(state.redo.length, 3);

  // 连按 3 次 Redo 原路重放
  const r1 = planRedo(state, [{ file_id: fId, relative_path: diskPath }]);
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.request.newName, 'plan-v2.md');
    state = r1.nextState;
    diskPath = 'docs/plan-v2.md';
  }
  const r2 = planRedo(state, [{ file_id: fId, relative_path: diskPath }]);
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.request.targetDir, 'archive');
    state = r2.nextState;
    diskPath = 'archive/plan-v2.md';
  }
  const r3 = planRedo(state, [{ file_id: fId, relative_path: diskPath }]);
  assert.equal(r3.ok, true);
  if (r3.ok) {
    assert.equal(r3.request.newName, 'plan-final.md');
    state = r3.nextState;
    diskPath = 'archive/plan-final.md';
  }
  assert.equal(diskPath, 'archive/plan-final.md');
  assert.equal(state.undo.length, 3);
  assert.equal(state.redo.length, 0);
});

test('fileOpHistory：5s 窗口关联动作合并、净零抵消、100 步上限丢最旧与反斜杠归一', () => {
  let state = EMPTY_FILE_OP_HISTORY;
  const r1 = recordFileOp(state, {
    kind: 'rename',
    fileId: 'f1',
    oldPath: 'docs\\a.md',
    newPath: 'docs\\b.md',
    nowMs: 1000,
  });
  assert.equal(r1.merged, false);
  const r2 = recordFileOp(r1.state, {
    kind: 'rename',
    fileId: 'f1',
    oldPath: 'docs/b.md',
    newPath: 'docs/c.md',
    nowMs: 1000 + FILE_OP_MERGE_WINDOW_MS,
  });
  assert.equal(r2.merged, true);
  assert.equal(r2.state.undo.length, 1);
  assert.equal(r2.state.undo[0].oldPath, 'docs/a.md');
  assert.equal(r2.state.undo[0].newPath, 'docs/c.md');
  assert.equal(r2.state.undo[0].mergedCount, 2);

  // 窗口内改回原名 docs/a.md → 净零抵消，不留自环
  const rCancel = recordFileOp(r2.state, {
    kind: 'rename',
    fileId: 'f1',
    oldPath: 'docs/c.md',
    newPath: 'docs/a.md',
    nowMs: 1000 + FILE_OP_MERGE_WINDOW_MS + 500,
  });
  assert.equal(rCancel.merged, true);
  assert.equal(rCancel.state.undo.length, 0);

  // 100 步上限按最旧丢弃并如实计数
  state = EMPTY_FILE_OP_HISTORY;
  let totalEvicted = 0;
  for (let i = 0; i < MAX_FILE_OP_HISTORY + 4; i += 1) {
    const res = recordFileOp(state, {
      kind: 'move',
      fileId: `f_${i}`,
      oldPath: `a/${i}.md`,
      newPath: `b/${i}.md`,
      nowMs: i * 10000,
    });
    state = res.state;
    totalEvicted += res.evicted;
  }
  assert.equal(state.undo.length, MAX_FILE_OP_HISTORY);
  assert.equal(totalEvicted, 4);
  assert.equal(state.undo[0].fileId, 'f_4');
});

test('fileOpHistory 停机线③：文件缺失 / 外部已改路径 / 目标被新文件占用 100% 安全中止且不推进账本', () => {
  const { state } = recordFileOp(EMPTY_FILE_OP_HISTORY, {
    kind: 'move',
    fileId: 'f1',
    oldPath: 'spec.md',
    newPath: 'archive/spec.md',
    nowMs: 1000,
  });

  // 1) 文件已被移入回收站（不在索引中）
  const pMissing = planUndo(state, []);
  assert.equal(pMissing.ok, false);
  if (!pMissing.ok) assert.equal(pMissing.reason, 'file-missing');

  // 2) 文件在外部又被改名（路径漂移）
  const pDrift = planUndo(state, [{ file_id: 'f1', relative_path: 'archive/spec-edited.md' }]);
  assert.equal(pDrift.ok, false);
  if (!pDrift.ok) assert.equal(pDrift.reason, 'path-drifted');

  // 3) 原路径已被他人新文件占用（绝不静默覆盖）
  const pOccupied = planUndo(state, [
    { file_id: 'f1', relative_path: 'archive/spec.md' },
    { file_id: 'f_other', relative_path: 'spec.md' },
  ]);
  assert.equal(pOccupied.ok, false);
  if (!pOccupied.ok) {
    assert.equal(pOccupied.reason, 'target-occupied');
    assert.match(pOccupied.message, /绝不覆盖/);
  }

  // 4) 路径正常且原根路径空置：成功且 targetDir === ''（工作区根）
  const pOk = planUndo(state, [{ file_id: 'f1', relative_path: 'archive\\spec.md' }]);
  assert.equal(pOk.ok, true);
  if (pOk.ok) {
    assert.equal(pOk.request.targetDir, '');
    assert.equal(pOk.request.newName, 'spec.md');
  }
});

// ── 4. canvasSpatialNav ───────────────────────────────────────────────────────

test('canvasSpatialNav：多分支因果星图四方向稳定沿连线跳转，绝不跳向无连线的更近干扰卡', () => {
  const nodes: SpatialNavNode[] = [
    { id: 'c_center', fileId: 'f_center', x: 500, y: 500 },
    { id: 'c_up', fileId: 'f_up', x: 520, y: 200 },
    { id: 'c_down', fileId: 'f_down', x: 490, y: 820 },
    { id: 'c_left', fileId: 'f_left', x: 180, y: 510 },
    { id: 'c_right', fileId: 'f_right', x: 860, y: 495 },
    // 非常近但没有任何连线的干扰卡：必须被忽略
    { id: 'c_decoy', fileId: 'f_decoy', x: 550, y: 500 },
  ];

  const adj = buildSpatialAdjacency([
    { source_id: 'f_center', target_id: 'f_up' },
    { source_id: 'f_center', target_id: 'f_down' },
    { source_id: 'f_left', target_id: 'f_center' }, // 反向有向边同样可无向漫游
    { source_id: 'f_center', target_id: 'f_right' },
    { source_id: 'f_center', target_id: 'f_center' }, // 自环忽略
  ]);
  const neighbors = adj.get('f_center')!;
  assert.equal(neighbors.has('f_center'), false);
  assert.equal(neighbors.has('f_decoy'), false);

  const center = nodes[0];
  assert.equal(
    pickSpatialNeighbor({ currentNode: center, nodes, neighborFileIds: neighbors, direction: 'up' })?.id,
    'c_up'
  );
  assert.equal(
    pickSpatialNeighbor({ currentNode: center, nodes, neighborFileIds: neighbors, direction: 'down' })?.id,
    'c_down'
  );
  assert.equal(
    pickSpatialNeighbor({ currentNode: center, nodes, neighborFileIds: neighbors, direction: 'left' })?.id,
    'c_left'
  );
  assert.equal(
    pickSpatialNeighbor({ currentNode: center, nodes, neighborFileIds: neighbors, direction: 'right' })?.id,
    'c_right'
  );

  // 从右叶节点向右按 Alt+ArrowRight：75° 锥内无连线邻居，诚实返回 null
  const rightNeighbors = adj.get('f_right')!;
  assert.equal(
    pickSpatialNeighbor({ currentNode: nodes[4], nodes, neighborFileIds: rightNeighbors, direction: 'right' }),
    null
  );
  // 向左则沿连线回到中心节点
  assert.equal(
    pickSpatialNeighbor({ currentNode: nodes[4], nodes, neighborFileIds: rightNeighbors, direction: 'left' })?.id,
    'c_center'
  );
});
