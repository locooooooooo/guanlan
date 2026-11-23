import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyCanvasTheme,
  CANVAS_THEME_STORAGE_KEY,
  getCanvasTheme,
  readCanvasTheme,
  saveCanvasTheme,
  subscribeCanvasTheme,
  type CanvasTheme,
} from '../src/utils/canvasThemeStore';
import { LANE_COLORS } from '../src/components/GraphCanvasView';
import {
  KIND_COLOR,
  SELECT_COLOR,
  REF_OUT_COLOR,
  REF_IN_COLOR,
  EVICT_COLOR,
  MUTED_COLOR,
  TRUNK_COLOR,
} from '../src/components/DocumentTimeMachineView';

/**
 * 画布主题契约（v0.7 设计增补 §4-5 新建，补勘察 §5.4-2 零测试覆盖）：
 *
 * 1) canvasThemeStore 三类回退：非法值回 xray-dark / 非 JSON 裸值宽容收下 /
 *    读异常回默认；写失败静默——持久化是增强能力，绝不让画布起不来（§1.2 表）。
 * 2) 泳道/时光机色常量值契约：值必须是 `var(--cv-*)` 令牌引用（增补 §1.1「TSX
 *    零 hex/rgba」红线；泳道=文档分类数据编码轴，令牌名逐字锁定，别名化会静默
 *    串写编码——V7-D15 白名单登记理由）。
 *
 * node 裸环境无 window：store 的 DOM 守卫直接回默认；回退逻辑用 mock window
 * 驱动真实代码路径（store 在调用时才读 window.localStorage，导入期零副作用）。
 */

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** 临时挂一个带 localStorage 的 mock window（node 无 window；用完必须卸载） */
function installWindow(storage: StorageLike | null): void {
  (globalThis as { window?: unknown }).window = { localStorage: storage };
}
function uninstallWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

/** 内存版 localStorage：可注入故障（读抛/写抛）以覆盖异常回退分支 */
function mockStorage(options?: { getThrows?: boolean; setThrows?: boolean }): StorageLike & {
  read: (key: string) => string | null;
  written: () => string;
} {
  const backing = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      if (options?.getThrows) throw new Error('storage read failure');
      return backing.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (options?.setThrows) throw new Error('storage write failure');
      backing.set(key, value);
    },
    read: (key: string) => backing.get(key) ?? null,
    written: () => backing.get(CANVAS_THEME_STORAGE_KEY) ?? '',
  };
}

// ---------- 1 · 持久化契约 ----------

test('存储键名契约：guanlan.canvasTheme.v1（防被当全局主题复用）', () => {
  assert.equal(CANVAS_THEME_STORAGE_KEY, 'guanlan.canvasTheme.v1');
});

test('node 裸环境（无 window）：读回默认夜航，不抛错', () => {
  uninstallWindow();
  assert.equal(readCanvasTheme(), 'xray-dark');
});

test('localStorage 空值：回 xray-dark', () => {
  const storage = mockStorage();
  installWindow(storage);
  try {
    assert.equal(readCanvasTheme(), 'xray-dark');
  } finally {
    uninstallWindow();
  }
});

test('JSON 主形态读回：保存的纸面偏好原样还原', () => {
  const storage = mockStorage();
  installWindow(storage);
  try {
    saveCanvasTheme('xray-light');
    assert.equal(storage.written(), '"xray-light"');
    assert.equal(readCanvasTheme(), 'xray-light');
  } finally {
    uninstallWindow();
  }
});

test('非法值回 xray-dark：JSON 合法但不在枚举内 / 裸值不在枚举内', () => {
  for (const junk of ['"dark"', '"light"', 'nonsense', '']) {
    const storage = mockStorage();
    installWindow(storage);
    try {
      storage.setItem(CANVAS_THEME_STORAGE_KEY, junk);
      assert.equal(readCanvasTheme(), 'xray-dark', `非法值 ${JSON.stringify(junk)} 应回默认`);
    } finally {
      uninstallWindow();
    }
  }
});

test('非 JSON 裸值宽容：手写 xray-light 收下，不强制 JSON 形态', () => {
  const storage = mockStorage();
  installWindow(storage);
  try {
    storage.setItem(CANVAS_THEME_STORAGE_KEY, 'xray-light');
    assert.equal(readCanvasTheme(), 'xray-light');
  } finally {
    uninstallWindow();
  }
});

test('读取抛异常：回 xray-dark，不抛错（画布永远起得来）', () => {
  installWindow(mockStorage({ getThrows: true }));
  try {
    assert.equal(readCanvasTheme(), 'xray-dark');
  } finally {
    uninstallWindow();
  }
});

test('写失败静默：隐私模式/配额满下切换不被阻塞', () => {
  const storage = mockStorage({ setThrows: true });
  installWindow(storage);
  try {
    assert.doesNotThrow(() => saveCanvasTheme('xray-light'));
  } finally {
    uninstallWindow();
  }
});

// ---------- 2 · 泳道/时光机色常量值契约 ----------

test('LANE_COLORS：四泳道键齐全，值逐字锁 --cv-lane-* 令牌（数据编码轴不别名化）', () => {
  assert.deepEqual(Object.keys(LANE_COLORS).sort(), ['md', 'pdf', 'svg', 'unknown']);
  assert.equal(LANE_COLORS.md, 'var(--cv-lane-md)');
  assert.equal(LANE_COLORS.svg, 'var(--cv-lane-svg)');
  assert.equal(LANE_COLORS.pdf, 'var(--cv-lane-pdf)');
  assert.equal(LANE_COLORS.unknown, 'var(--cv-lane-unknown)');
});

test('KIND_COLOR：diff 三态值锁令牌（del ≠ --cv-unread：diff 语义 vs 未读点）', () => {
  assert.deepEqual(Object.keys(KIND_COLOR).sort(), ['删除', '修改', '新增'].sort());
  assert.equal(KIND_COLOR['修改'], 'var(--cv-lane-md)');
  assert.equal(KIND_COLOR['新增'], 'var(--cv-add)');
  assert.equal(KIND_COLOR['删除'], 'var(--cv-del)');
});

test('时光机状态色族：全部为 var(--cv-*) 引用（TSX 零 hex/rgba 红线）', () => {
  const family: Record<string, string> = {
    SELECT_COLOR,
    REF_OUT_COLOR,
    REF_IN_COLOR,
    EVICT_COLOR,
    MUTED_COLOR,
    TRUNK_COLOR,
  };
  for (const [name, value] of Object.entries(family)) {
    assert.match(value, /^var\(--cv-/, `${name} 必须引用 --cv-* 令牌，现值 ${value}`);
  }
  assert.equal(SELECT_COLOR, 'var(--cv-lane-unknown)');
  assert.equal(REF_OUT_COLOR, 'var(--cv-ref-out)');
  assert.equal(REF_IN_COLOR, 'var(--cv-lane-svg)');
  assert.equal(EVICT_COLOR, 'var(--cv-lane-pdf)');
  assert.equal(MUTED_COLOR, 'var(--cv-ink-meta)');
  assert.equal(TRUNK_COLOR, 'var(--cv-trunk)');
});

// ---------- 3 · attr↔选择器契约（评审第 1 轮 #1 防再裂） ----------

// 背景：首轮视觉评审实证浅档永不生效——App.tsx 挂 data-canvas-theme={canvasTheme}
//（值=canvasThemeStore 枚举 'xray-dark'|'xray-light'），而 index.css 浅档覆写块
// 字面写作 [data-canvas-theme='light']，attr 恒 'xray-light' → 选择器永不匹配 →
// 开关/持久化全翻转、画布恒夜航。契约：CSS 里出现的每个 data-canvas-theme='X'
// 字面必须是 CanvasTheme 枚举成员（attr 与选择器同词汇，禁止第三套值）。

/** 读 src/ 下源文件（相对 test/ 目录，须带 ../src/ 前缀） */
function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

const CANVAS_THEME_SELECTOR_RE = /\[data-canvas-theme='([^']+)'\]/g;
const THEMES = ['xray-dark', 'xray-light'] as const satisfies readonly CanvasTheme[];

test('契约：src 全部 CSS 的 data-canvas-theme 选择器字面 ∈ CanvasTheme 枚举', () => {
  const cssSources = [
    'index.css',
    'styles/motion.css',
    'components/eventGraph.css',
  ];
  for (const path of cssSources) {
    const css = readSrc(path);
    const literals = [...css.matchAll(CANVAS_THEME_SELECTOR_RE)].map((m) => m[1]);
    for (const literal of literals) {
      assert.ok(
        (THEMES as readonly string[]).includes(literal),
        `${path} 的选择器 [data-canvas-theme='${literal}'] 不是枚举值——` +
          'App.tsx 挂的是 store 枚举原值，CSS 字面必须逐字同词汇',
      );
    }
  }
});

test('契约：浅档覆写块与泳道软滤镜块的选择器逐字= xray-light', () => {
  const css = readSrc('index.css');
  assert.ok(
    css.includes(".dark-porthole[data-canvas-theme='xray-light'] {"),
    'index.css 浅档覆写块选择器必须逐字写 xray-light（store 枚举值）',
  );
  assert.ok(
    css.includes(".dark-porthole[data-canvas-theme='xray-light'] .cv-stream-glow"),
    '浅档泳道光束软滤镜选择器必须逐字写 xray-light',
  );
  assert.ok(
    !css.includes("[data-canvas-theme='light']") && !css.includes("[data-canvas-theme='dark']"),
    "index.css 不得残留 'light'/'dark' 字面（首轮评审裂源）",
  );
});

test('契约：App.tsx 命令式挂 store 枚举值，不做 light/dark 转译（评审第 2 轮）', () => {
  // D01-a 拆层后 App 实现 = 装配层 + 单一 Store——联合文本断言（语义不变）
  const app = [readSrc('App.tsx'), readSrc('stores/useWorkspaceStore.tsx')].join(String.fromCharCode(10))
  assert.ok(
    app.includes('porthole.dataset.canvasTheme = next'),
    'App.tsx 必须经 porthole.dataset.canvasTheme 命令式直写枚举值（挂点唯一，转译会让 DOM 出第三套词汇）',
  );
  assert.ok(
    !app.includes('data-canvas-theme={canvasTheme}'),
    'App.tsx 不得把主题作 React prop 传递（整树重渲是切换延迟根源，评审 v0.7r2-1）',
  );
});

test('活值层：apply 异值更新活值+通知订阅者；同值短路；退订后不再通知', () => {
  // node 裸环境无 window：apply 内的持久化守卫静默跳过，通知逻辑照常走
  const seen: CanvasTheme[] = [];
  const off = subscribeCanvasTheme(() => seen.push(getCanvasTheme()));
  applyCanvasTheme('xray-light');
  assert.equal(getCanvasTheme(), 'xray-light');
  applyCanvasTheme('xray-light'); // 同值：不通知（避免无谓的叶子重渲）
  assert.deepEqual(seen, ['xray-light']);
  off();
  applyCanvasTheme('xray-dark');
  assert.deepEqual(seen, ['xray-light'], '退订后订阅者不得再收到通知');
  assert.equal(getCanvasTheme(), 'xray-dark');
});

// 类型面冒烟：CanvasTheme 枚举只允许两档（编译期即锁，此处断言运行时字形）
const _typeProbe: CanvasTheme[] = ['xray-dark', 'xray-light'];
void _typeProbe;
