/**
 * R1-identity-dedup · 文档身份聚合共享工具（纯函数，无依赖）。
 *
 * 工作区里同一份文档常以多份拷贝存在（PLAN.md/HANDOFF.md 被复制进每个 run 目录、
 * 每日开发计划每天一份），逐份渲染让日历日清单、时间线、星图详情、右栏引用被同貌卡淹没。
 * 这里给四处清单一个同一套「身份」口径：
 *   ① 同哈希优先并组——内容完全一致的拷贝是同一身份（即使文件名不同）；
 *   ② 同名再并组——不同内容但同基名的拷贝（93 份 PLAN）折成一组，组内按
 *      「不同内容哈希数」如实标注「K 种内容」；
 *   ③ 最小区分前缀——组标题/引用卡标题带最短父目录尾链（父目录段/任务包名），
 *      让重名条目互相可指认，展开才见每份完整 relative_path。
 *
 * 只做展示层分组：不改写 batch_id / file_id / event_id，不伪造任何服务端数据。
 */

// ---------- 路径基础形态 ----------

/** 统一为 '/' 分隔（工作区在 win32 下可能带回斜杠）。 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** 去掉已知文档扩展名（md/markdown/svg/pdf）后的基名；「LICENSE.md」→「LICENSE」。 */
export function basenameOf(path: string): string {
  const base = normalizePath(path).split('/').pop() || '';
  return base.replace(/\.(md|markdown|svg|pdf)$/i, '');
}

/** 父目录段数组（根级文件为 []）。 */
export function dirSegmentsOf(path: string): string[] {
  const parts = normalizePath(path).split('/');
  return parts.slice(0, -1).filter((seg) => seg.length > 0);
}

// ---------- 工具脚本噪音判定（DoD3 单一出口） ----------

/**
 * draw 形态段：draw 后跟 _ . - 数字或结尾（拦 draw_edge / draw_ms / draw / draw_2）。
 * 刻意不拦 draw 后跟字母的词（drawing-guide 绘图指南 是正常文档）。
 * 这类文件名只存在于用户真实工作区的工具脚本产物里（本仓 src/、test/ 0 命中），
 * 过滤只能按路径形态在统计聚合层做，组件层拿到的已是干净数据。
 */
const TOOL_NOISE_SEGMENT_RE = /^draw([_.\-\d]|$)/i;

/**
 * 运行态缓存 run 段（列表净化扩展）：run- 后跟 ≥8 位纯数字——epoch 毫秒
 * （run-1758…）、纯数字日期（run-20261109）这类机器生成的轮次缓存目录。
 * 刻意要求「纯数字且 ≥8 位」：既有合法任务包名 run-20261109T0928（带 T，任务包
 * G2 形态，task-packages/highValueReading 既有夹具）与 run-42 这类短人工 id
 * 都不会命中——向后兼容由 test/listfix-core-filter.test.ts 锁定。
 */
const RUN_CACHE_SEGMENT_RE = /^run-\d{8,}$/i;

/**
 * 机器哈希段形态（列表净化扩展）：32 位以上纯 hex（无连字符 UUID / sha256 摘要）
 * 或标准连字符 UUID（8-4-4-4-12）。人起的名字不可能整段落进 [0-9a-f] 且长到
 * 32 位（最长英文词也不足 32 字符），长阈值把「正常词被当 hex」的误拦压到零；
 * 16 位短 hex（如短摘要目录）刻意不拦，保守阈值宁可漏放不可误伤正常文档。
 */
const LONG_HEX_SEGMENT_RE = /^[0-9a-f]{32,}$/i;
const UUID_HYPHENATED_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 段尾扩展名（.svg/.md 等 ≤8 位字母数字）——机器产物常直接以哈希为文件名，剥壳后再测。 */
const TAIL_EXTENSION_RE = /\.[a-z0-9]{1,8}$/i;

/** 单段哈希/UUID 形态判定：目录段原样测一次，带扩展名时剥壳后的文件名核再测一次。 */
function isMachineHashSegment(segment: string): boolean {
  if (LONG_HEX_SEGMENT_RE.test(segment) || UUID_HYPHENATED_SEGMENT_RE.test(segment)) {
    return true;
  }
  const core = segment.replace(TAIL_EXTENSION_RE, '');
  return (
    core !== segment &&
    (LONG_HEX_SEGMENT_RE.test(core) || UUID_HYPHENATED_SEGMENT_RE.test(core))
  );
}

/**
 * 工具脚本噪音判定（DoD3：首页待读清单与任务包统计共用的单一出口——
 * 高价值待阅聚合与 groupFilesIntoPackages 分桶都从这里取口径；列表页
 * 「仅看核心文档与计划」开关亦消费本函数，不另设第二口径）：
 * basename 或任一路径段命中 draw 形态，或任一路径段以 `_` 开头
 * （_tools/_qa，与 LeftSidebar.tsx:85 isSystemDirName 的 `/^_/` 同族口径）；
 * 列表净化扩展再拦两类机器生成段——run-<纯数字≥8> 运行态缓存目录、
 * 长 hex/UUID 段（如 output/…/run-1758…/…/<UUID> 的运行态缓存与派生截图）。
 * 向后兼容：签名与返回语义不变，只新增识别形态，draw/`_` 既有判定逐字保留。
 * 注意：output/ 在此**不**整体拦——交付物常落 output/，只拦其中的
 * draw 形态产物与机器哈希段；原始数据与画布域用途不受影响，本函数只服务人类阅读面统计
 * 与任务包统计，不改写画布节点/服务端数据。
 */
export function isToolNoisePath(relativePath: string): boolean {
  const segments = normalizePath(relativePath)
    .split('/')
    .filter((seg) => seg.length > 0);
  for (const seg of segments) {
    if (TOOL_NOISE_SEGMENT_RE.test(seg)) return true;
    if (seg.startsWith('_')) return true;
    if (RUN_CACHE_SEGMENT_RE.test(seg)) return true;
    if (isMachineHashSegment(seg)) return true;
  }
  return false;
}

// ---------- 分组输入/输出 ----------

export interface IdentityItem<T> {
  /** 原始条目（事件 / FileRecord / 边等），原样带回成员列表 */
  item: T;
  /** 参与身份判定的相对路径 */
  path: string;
  /** 内容哈希（缺失/空 = 不参与哈希并组，只按同名分组） */
  hash?: string | null;
}

export interface IdentityGroup<T> {
  /** 稳定键（由并查集根派生；同输入次序下跨渲染一致，可作 React key / 展开态键成分） */
  key: string;
  /** 展示名：组内最常见的基名（并列取先出现者） */
  displayName: string;
  /** 最小区分前缀：成员公共父目录链的末段（如 run-A）；单成员组或无公共目录为 '' */
  prefix: string;
  /** 成员原始条目（按输入次序，即既有「上新下旧」序） */
  members: T[];
  /** 成员完整路径（与 members 一一对应，展开时逐份透出） */
  paths: string[];
  /** 不同内容哈希数；0 = 成员均无哈希（内容差异未知，绝不谎报「同内容」） */
  contentKinds: number;
}

/**
 * 身份并组：同哈希优先并组，再按基名并组（并查集，传递闭包）。
 * 输出按「成员首现位置」排序——调用方传入的次序即渲染次序，聚合不打乱既有时间方向。
 */
export function groupByIdentity<T>(items: IdentityItem<T>[]): IdentityGroup<T>[] {
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 键 → 首个持有该键的成员下标（同键后续成员与它并组）
  const byName = new Map<string, number>();
  const byHash = new Map<string, number>();
  items.forEach((it, i) => {
    const base = basenameOf(it.path);
    if (base) {
      const first = byName.get(base);
      if (first === undefined) byName.set(base, i);
      else union(first, i);
    }
    const hash = it.hash || '';
    if (hash) {
      const first = byHash.get(hash);
      if (first === undefined) byHash.set(hash, i);
      else union(first, i);
    }
  });

  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(i);
    else groups.set(root, [i]);
  });

  const result: IdentityGroup<T>[] = [];
  for (const [root, indexes] of groups) {
    const members: T[] = [];
    const paths: string[] = [];
    const hashes: string[] = [];
    const nameCount = new Map<string, number>();
    for (const i of indexes) {
      const it = items[i];
      members.push(it.item);
      paths.push(normalizePath(it.path));
      if (it.hash) hashes.push(it.hash);
      const base = basenameOf(it.path);
      if (base) nameCount.set(base, (nameCount.get(base) || 0) + 1);
    }
    // 展示名：出现最多的基名（Map 迭代序 = 首现序，并列取先出现）
    let displayName = '';
    let best = 0;
    for (const [name, count] of nameCount) {
      if (count > best) {
        best = count;
        displayName = name;
      }
    }
    // 最小区分前缀：成员公共父目录链的末段（逐段对齐后取最深公共段）
    let prefix = '';
    if (members.length > 1) {
      const dirRows = paths.map(dirSegmentsOf);
      const shortest = Math.min(...dirRows.map((row) => row.length));
      const common: string[] = [];
      for (let k = 0; k < shortest; k += 1) {
        const seg = dirRows[0][k];
        if (dirRows.every((row) => row[k] === seg)) common.push(seg);
        else break;
      }
      prefix = common.length > 0 ? common[common.length - 1] : '';
    }
    result.push({
      key: `idg:${root}`,
      displayName,
      prefix,
      members,
      paths,
      contentKinds: new Set(hashes).size,
    });
  }
  return result;
}

// ---------- 最小区分前缀（引用卡标题用） ----------

/**
 * 在一组同标题（同名拷贝）的路径里，为 path 取能与其余路径区分的最短父目录尾链。
 * 末段优先（如 run-A）；末段撞名时逐段向根扩（sub/x → day1/sub/x）。
 * collisionPaths 为「与本条同展示标题」的其它路径；无冲突（传入空集）返回 ''。
 */
export function minimalDirPrefix(path: string, collisionPaths: string[]): string {
  const self = dirSegmentsOf(path);
  if (self.length === 0) return '';
  const others = collisionPaths
    .filter((p) => normalizePath(p) !== normalizePath(path))
    .map((p) => dirSegmentsOf(p).join('/'));
  if (others.length === 0) return '';
  for (let k = 1; k <= self.length; k += 1) {
    const suffix = self.slice(self.length - k).join('/');
    const hits = others.some((dir) => dir === suffix || dir.endsWith(`/${suffix}`));
    if (!hits) return suffix;
  }
  return self.join('/');
}
