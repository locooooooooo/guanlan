

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


const TOOL_NOISE_SEGMENT_RE = /^draw([_.\-\d]|$)/i;

const RUN_CACHE_SEGMENT_RE = /^run-\d{8,}$/i;

const LONG_HEX_SEGMENT_RE = /^[0-9a-f]{32,}$/i;
const UUID_HYPHENATED_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_EXTENSION_RE = /\.[a-z0-9]{1,8}$/i;

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
 * 工具脚本噪音判定（首页待读清单与任务包统计共用的单一出口——
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


export interface IdentityItem<T> {
  item: T;
  path: string;
  hash?: string | null;
}

export interface IdentityGroup<T> {
  key: string;
  displayName: string;
  prefix: string;
  members: T[];
  paths: string[];
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
    let displayName = '';
    let best = 0;
    for (const [name, count] of nameCount) {
      if (count > best) {
        best = count;
        displayName = name;
      }
    }
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
