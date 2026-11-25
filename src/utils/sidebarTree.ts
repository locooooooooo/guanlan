/**
 * Quiet.md 风格全局常驻目录侧栏的纯函数模块（零 UI / 零网络 IO）：
 * - 合并真实目录清单（含空目录）与已索引文件构建完整文件夹树；
 * - 文件夹移动防成环校验（自身 / 当前父目录 / 任意后代目录 100% 拦截）；
 * - 挂载参考工作区只读目录树构建；
 * - 侧栏宽度/折叠状态与置顶清单的安全本地持久化（SSR 友好）。
 */

import type { FileRecord } from '../types/guanlan';
import type {
  EventDaysResult,
  EventPage,
  MountedFileEntryDto,
  ProjectTreeFileEntryDto,
} from '../services/apiTypes';
import { classifyAssetDomain, type AssetDomainFilter } from './formatMeta';

export interface FolderNode {
  /** 最后一段目录名。 */
  name: string;
  /** 完整目录路径（正斜杠，不含首尾斜杠），用于筛选、拖拽落点与前缀匹配。 */
  path: string;
  /** 直接放在该目录的文件数。 */
  direct: number;
  /** 含子目录的文件总数。 */
  total: number;
  /** 是否为空文件夹（既无文件也无子目录）。 */
  isEmpty: boolean;
  /** 直接归属该目录的文件列表。 */
  directFiles: FileRecord[];
  children: FolderNode[];
}

export interface MountedFolderNode {
  name: string;
  path: string;
  total: number;
  directFiles: MountedFileEntryDto[];
  children: MountedFolderNode[];
}

export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 264;

const SIDEBAR_PREFS_KEY = 'guanlan.sidebarPrefs.v1';
const PINNED_FILES_KEY_PREFIX = 'guanlan.pinnedFiles.v1:';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)));
}

export interface SidebarShellPrefs {
  width: number;
  collapsed: boolean;
}

export function loadSidebarShellPrefs(): SidebarShellPrefs {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { width: SIDEBAR_WIDTH_DEFAULT, collapsed: false };
  }
  try {
    const raw = window.localStorage.getItem(SIDEBAR_PREFS_KEY);
    if (!raw) return { width: SIDEBAR_WIDTH_DEFAULT, collapsed: false };
    const parsed = JSON.parse(raw) as Partial<SidebarShellPrefs>;
    return {
      width: clampSidebarWidth(Number(parsed.width ?? SIDEBAR_WIDTH_DEFAULT)),
      collapsed: Boolean(parsed.collapsed),
    };
  } catch {
    return { width: SIDEBAR_WIDTH_DEFAULT, collapsed: false };
  }
}

export function saveSidebarShellPrefs(prefs: SidebarShellPrefs): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      SIDEBAR_PREFS_KEY,
      JSON.stringify({
        width: clampSidebarWidth(prefs.width),
        collapsed: Boolean(prefs.collapsed),
      })
    );
  } catch {
    // 隐私模式或配额受限时静默降级
  }
}

export function loadPinnedFileIds(workspaceScopeKey: string): string[] {
  if (typeof window === 'undefined' || !window.localStorage || !workspaceScopeKey) return [];
  try {
    const raw = window.localStorage.getItem(`${PINNED_FILES_KEY_PREFIX}${workspaceScopeKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function savePinnedFileIds(workspaceScopeKey: string, ids: readonly string[]): void {
  if (typeof window === 'undefined' || !window.localStorage || !workspaceScopeKey) return;
  try {
    window.localStorage.setItem(
      `${PINNED_FILES_KEY_PREFIX}${workspaceScopeKey}`,
      JSON.stringify(Array.from(new Set(ids)))
    );
  } catch {
    // 隐私模式或配额受限时静默降级
  }
}

export function normalizeFolderPath(raw: string): string {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  return cleaned === '.' ? '' : cleaned;
}

export function parentFolderPathOf(folderPath: string): string {
  const norm = normalizeFolderPath(folderPath);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/**
 * 文件夹级防成环校验（Windows 大小写无关语义）：
 * - 源目录为空（工作区根）→ 禁止移动；
 * - 目标父目录 === 源目录当前父目录 → 无变化落点，拦截；
 * - 目标父目录 === 源目录自身 → 自环拦截；
 * - 目标父目录位于源目录子树下（`<source>/...`）→ 后代成环拦截。
 */
export function isFolderMoveBlocked(sourceFolder: string, targetParentDir: string): boolean {
  const src = normalizeFolderPath(sourceFolder);
  if (!src) return true;
  const target = normalizeFolderPath(targetParentDir);
  const srcLower = src.toLowerCase();
  const targetLower = target.toLowerCase();
  const currentParentLower = parentFolderPathOf(src).toLowerCase();

  if (targetLower === currentParentLower) return true;
  if (targetLower === srcLower) return true;
  if (targetLower.startsWith(`${srcLower}/`)) return true;
  return false;
}

/**
 * 过滤可移动目标目录清单（自动排除源文件夹自身、其当前父目录与所有后代子目录）。
 */
export function filterMovableFolderTargets(
  allFolders: readonly string[],
  sourceFolder: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ['', ...allFolders]) {
    const norm = normalizeFolderPath(raw);
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isFolderMoveBlocked(sourceFolder, norm)) {
      out.push(norm);
    }
  }
  return out;
}

/**
 * 合并已索引文件与真实目录列表（含空目录）构建完整文件夹树。
 * - 空文件夹会如实出现在对应层级（`isEmpty: true`）；
 * - 任意深层目录的中间祖先段自动补齐；
 * - 按中文 Locale 确定性排序。
 */
export function buildMergedFolderTree(
  files: readonly FileRecord[],
  realFolders: readonly string[] = []
): {
  nodes: FolderNode[];
  rootFiles: FileRecord[];
} {
  const root: FolderNode = {
    name: '',
    path: '',
    direct: 0,
    total: 0,
    isEmpty: false,
    directFiles: [],
    children: [],
  };

  const ensureFolderPath = (rawFolder: string): FolderNode => {
    const norm = normalizeFolderPath(rawFolder);
    if (!norm) return root;
    const parts = norm.split('/').filter(Boolean);
    let node = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: acc,
          direct: 0,
          total: 0,
          isEmpty: true,
          directFiles: [],
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };

  for (const rawDir of realFolders) {
    ensureFolderPath(rawDir);
  }

  for (const f of files) {
    const norm = normalizeFolderPath(f.folder);
    const parts = norm ? norm.split('/').filter(Boolean) : [];
    let node = root;
    root.total += 1;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: acc,
          direct: 0,
          total: 0,
          isEmpty: false,
          directFiles: [],
          children: [],
        };
        node.children.push(child);
      }
      child.total += 1;
      node = child;
    }
    node.direct += 1;
    node.directFiles.push(f);
  }

  const finalize = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const n of nodes) {
      n.directFiles.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
      finalize(n.children);
      n.isEmpty = n.total === 0 && n.children.length === 0;
    }
  };
  root.directFiles.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  finalize(root.children);

  return { nodes: root.children, rootFiles: root.directFiles };
}

/** 收集目录节点及其全部后代目录路径（Alt+点击级联展开/收起的作用域）。 */
export function collectSubtreePaths(node: FolderNode): string[] {
  const out: string[] = [node.path];
  for (const child of node.children) out.push(...collectSubtreePaths(child));
  return out;
}

/** 收集目录树下全部文件的 file_id（批量选择整个目录时使用）。 */
export function collectSubtreeFileIds(node: FolderNode): string[] {
  const out: string[] = node.directFiles.map((f) => f.file_id);
  for (const child of node.children) out.push(...collectSubtreeFileIds(child));
  return out;
}

/** 合并文件所在目录 + 真实空目录，产出供移动弹窗/批量移动选择器的有序目录清单（含根目录 ''）。 */
export function collectMergedFolderOptions(
  files: readonly FileRecord[],
  realFolders: readonly string[] = []
): string[] {
  const set = new Set<string>(['']);
  const addWithAncestors = (raw: string) => {
    const norm = normalizeFolderPath(raw);
    if (!norm) return;
    const parts = norm.split('/').filter(Boolean);
    let acc = '';
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      set.add(acc);
    }
  };
  for (const dir of realFolders) addWithAncestors(dir);
  for (const file of files) addWithAncestors(file.folder);
  return Array.from(set).sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });
}

/** 构建挂载参考工作区的只读目录树（侧栏「挂载目录」区渲染用）。 */
export function buildMountedFolderTree(
  items: readonly MountedFileEntryDto[],
  realFolders: readonly string[] = []
): {
  nodes: MountedFolderNode[];
  rootFiles: MountedFileEntryDto[];
} {
  const root: MountedFolderNode = {
    name: '',
    path: '',
    total: 0,
    directFiles: [],
    children: [],
  };

  const ensureDir = (rawDir: string): MountedFolderNode => {
    const norm = normalizeFolderPath(rawDir);
    if (!norm) return root;
    let node = root;
    let acc = '';
    for (const part of norm.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: acc, total: 0, directFiles: [], children: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };

  for (const dir of realFolders) ensureDir(dir);

  for (const item of items) {
    const norm = normalizeFolderPath(item.folder);
    let node = root;
    root.total += 1;
    if (norm) {
      let acc = '';
      for (const part of norm.split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${part}` : part;
        let child = node.children.find((c) => c.name === part);
        if (!child) {
          child = { name: part, path: acc, total: 0, directFiles: [], children: [] };
          node.children.push(child);
        }
        child.total += 1;
        node = child;
      }
    }
    node.directFiles.push(item);
  }

  const sortRec = (nodes: MountedFolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const n of nodes) {
      n.directFiles.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
      sortRec(n.children);
    }
  };
  root.directFiles.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  sortRec(root.children);
  return { nodes: root.children, rootFiles: root.directFiles };
}

// ===== 多项目侧栏树、跨项目置顶与展开态持久化 =====

export interface ProjectFolderNode {
  name: string;
  path: string;
  total: number;
  isEmpty: boolean;
  directFiles: ProjectTreeFileEntryDto[];
  children: ProjectFolderNode[];
}

export interface GlobalPinnedFile {
  projectId: string;
  projectName: string;
  fileId: string;
  title: string;
  format: string;
  relativePath: string;
}

const GLOBAL_PINS_KEY = 'guanlan.globalPinnedFiles.v1';
const EXPANDED_PROJECTS_KEY = 'guanlan.expandedProjects.v1';

export function loadGlobalPinnedFiles(): GlobalPinnedFile[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(GLOBAL_PINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is GlobalPinnedFile =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof item.projectId === 'string' &&
        typeof item.fileId === 'string' &&
        typeof item.title === 'string'
    );
  } catch {
    return [];
  }
}

export function saveGlobalPinnedFiles(pins: readonly GlobalPinnedFile[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(GLOBAL_PINS_KEY, JSON.stringify(pins));
  } catch {
    // 隐私模式静默降级
  }
}

export function loadExpandedProjects(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(EXPANDED_PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function saveExpandedProjects(ids: readonly string[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // 隐私模式静默降级
  }
}

/**
 * 切换当前聚焦项目后的展开集：新的聚焦项目展开，旧的聚焦项目收起；
 * 其他项目若由用户手动展开则保持原样——多项目同时展开仍是显式能力，
 * 不让每次切换把整列项目树越堆越长。
 */
export function expandedProjectsAfterActivate(
  prev: ReadonlySet<string>,
  previousActiveId: string,
  nextActiveId: string
): string[] {
  const next = new Set(prev);
  if (previousActiveId && previousActiveId !== nextActiveId) {
    next.delete(previousActiveId);
  }
  if (nextActiveId) next.add(nextActiveId);
  return Array.from(next);
}

/** 构建任意非激活项目的完整目录树（合并真实空目录 + 受管文件）。 */
export function buildProjectFolderTree(
  files: readonly ProjectTreeFileEntryDto[],
  realFolders: readonly string[] = []
): {
  nodes: ProjectFolderNode[];
  rootFiles: ProjectTreeFileEntryDto[];
} {
  const root: ProjectFolderNode = {
    name: '',
    path: '',
    total: 0,
    isEmpty: false,
    directFiles: [],
    children: [],
  };

  const ensureDir = (rawDir: string): ProjectFolderNode => {
    const norm = normalizeFolderPath(rawDir);
    if (!norm) return root;
    let node = root;
    let acc = '';
    for (const part of norm.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: acc,
          total: 0,
          isEmpty: true,
          directFiles: [],
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };

  for (const dir of realFolders) ensureDir(dir);

  for (const item of files) {
    const norm = normalizeFolderPath(item.folder);
    let node = root;
    root.total += 1;
    if (norm) {
      let acc = '';
      for (const part of norm.split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${part}` : part;
        let child = node.children.find((c) => c.name === part);
        if (!child) {
          child = {
            name: part,
            path: acc,
            total: 0,
            isEmpty: false,
            directFiles: [],
            children: [],
          };
          node.children.push(child);
        }
        child.total += 1;
        node = child;
      }
    }
    node.directFiles.push(item);
  }

  const finalize = (nodes: ProjectFolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const n of nodes) {
      n.directFiles.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
      finalize(n.children);
      n.isEmpty = n.total === 0 && n.children.length === 0;
    }
  };
  root.directFiles.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  finalize(root.children);
  return { nodes: root.children, rootFiles: root.directFiles };
}

// ===== 同前缀长文件名智能中段省略（保留开头主题词 + 结尾差异词与扩展名） =====

function commonPrefixLengthOfTwo(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 计算同一目录内相邻兄弟文件名的最大公共前缀长度映射（抗单条异类干扰：
 * 即使 15 份 `2D与3D绘制预览优化方案-*.svg` 旁边混着 1 份 `README.md`，
 * 同簇 15 份仍精确识别彼此共享前缀，绝不被 1 份 README 归零）。
 */
export function computeSiblingSharedPrefixMap(names: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (names.length < 2) {
    for (const n of names) result.set(n, 0);
    return result;
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const prevLen = i > 0 ? commonPrefixLengthOfTwo(cur, sorted[i - 1]) : 0;
    const nextLen = i + 1 < sorted.length ? commonPrefixLengthOfTwo(cur, sorted[i + 1]) : 0;
    const shared = Math.max(prevLen, nextLen);
    result.set(cur, shared >= 4 ? shared : 0);
  }
  return result;
}

/**
 * 智能中段省略纯函数：
 * - 短文件名（`name.length <= maxChars`）原样返回；
 * - 存在显著共享前缀（`sharedPrefixLen >= 4`）时，优先保护前缀之后「真正区分彼此的差异尾段 + 扩展名」，
 *   把重复的公共前缀中段折叠为 `…`，避免同目录下全列都是 `2D与3D绘制预览优…`；
 * - 无共享前缀时，仍保留可读开头与后缀扩展名/尾部差异词。
 */
export function formatMiddleEllipsisName(
  name: string,
  sharedPrefixLen: number,
  maxChars = 22
): string {
  const safeMax = Math.max(6, Math.floor(maxChars));
  const chars = Array.from(name);
  if (chars.length <= safeMax) return name;

  // 识别扩展名（如 .md / .svg / .tsx，长度 2..7 且非隐藏点文件）
  const lastDot = name.lastIndexOf('.');
  let ext = '';
  if (lastDot > 0 && name.length - lastDot <= 7) {
    const candidate = name.slice(lastDot);
    if (/^\.[A-Za-z0-9]{1,6}$/.test(candidate)) {
      ext = candidate;
    }
  }
  const stem = ext ? name.slice(0, lastDot) : name;
  const stemChars = Array.from(stem);
  const extChars = Array.from(ext);
  const ellipsis = '…';
  const availForStem = safeMax - extChars.length - 1;
  if (availForStem <= 2) {
    return `${chars.slice(0, safeMax - 1).join('')}${ellipsis}`;
  }

  let clampedShared = Math.max(0, Math.min(Math.floor(sharedPrefixLen), stemChars.length));
  if (clampedShared >= 4 && clampedShared < stemChars.length) {
    // 若公共前缀恰好切在版本词/编号词中间（如 `-v1` 与 `-v2` 共享到 `-v`），回退到词界分隔符处，
    // 完整保留 `-v1` / `-v2` / `-final` 等关键差异词而非裸露单字符 `1`
    let snapped = clampedShared;
    while (snapped > 2 && /[A-Za-z0-9]/.test(stemChars[snapped - 1])) {
      snapped -= 1;
    }
    if (snapped > 2 && /[-_.\s]/.test(stemChars[snapped - 1])) {
      snapped -= 1;
    }
    if (snapped >= 2) clampedShared = snapped;

    const diffTail = stemChars.slice(clampedShared);
    // 差异尾段尽量全保，同时至少留 3 字符给开头锚点
    const minHead = Math.min(4, Math.max(2, Math.floor(availForStem * 0.35)));
    const maxTail = availForStem - minHead;
    if (diffTail.length <= maxTail) {
      // 剩余额度尽量补在开头（和差异段前 1–2 字上下文）
      const headLen = availForStem - diffTail.length;
      return `${stemChars.slice(0, headLen).join('')}${ellipsis}${diffTail.join('')}${ext}`;
    }
    // 差异段本身也很长：保留开头锚点 + 差异段末尾最关键区分词
    const tailSlice = diffTail.slice(diffTail.length - maxTail);
    return `${stemChars.slice(0, minHead).join('')}${ellipsis}${tailSlice.join('')}${ext}`;
  }

  // 无显著共享前缀：60% 开头 + 40% 结尾，保留扩展名
  const headLen = Math.max(2, Math.ceil(availForStem * 0.6));
  const tailLen = Math.max(1, availForStem - headLen);
  return `${stemChars.slice(0, headLen).join('')}${ellipsis}${stemChars
    .slice(stemChars.length - tailLen)
    .join('')}${ext}`;
}

// ===== 工作区私有「目录静默清单（Muted Folders）」SSOT（磁盘零写入用户业务目录） =====

export const MUTED_FOLDERS_STORAGE_KEY = 'guanlan.mutedFolders.v1';

export function mutedFoldersStorageKey(workspaceId?: string): string {
  const clean = workspaceId?.trim();
  return clean ? `${MUTED_FOLDERS_STORAGE_KEY}.${clean}` : MUTED_FOLDERS_STORAGE_KEY;
}

export function normalizeMutedFolderPath(raw: string): string {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  return cleaned === '.' ? '' : cleaned;
}

export function loadMutedFolders(workspaceId?: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(mutedFoldersStorageKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const norm = normalizeMutedFolderPath(item);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveMutedFolders(folders: readonly string[], workspaceId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    const unique = Array.from(
      new Set(folders.map(normalizeMutedFolderPath).filter(Boolean))
    );
    window.localStorage.setItem(mutedFoldersStorageKey(workspaceId), JSON.stringify(unique));
  } catch {
    /* 隐私模式 / 配额满静默降级 */
  }
}

export function toggleMutedFolderList(
  current: readonly string[],
  folderPath: string
): string[] {
  const norm = normalizeMutedFolderPath(folderPath);
  if (!norm) return [...current];
  const exists = current.some((m) => normalizeMutedFolderPath(m) === norm);
  if (exists) {
    return current.filter((m) => normalizeMutedFolderPath(m) !== norm);
  }
  return [...current, norm].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 判定某目录（或其任意祖先目录）是否已被静默。 */
export function isFolderMuted(
  folderPath: string,
  mutedFolders: readonly string[]
): boolean {
  if (mutedFolders.length === 0) return false;
  const norm = normalizeMutedFolderPath(folderPath);
  if (!norm) return false;
  for (const raw of mutedFolders) {
    const m = normalizeMutedFolderPath(raw);
    if (!m) continue;
    if (norm === m || norm.startsWith(`${m}/`)) return true;
  }
  return false;
}

/** 判定某文件是否落入任意已静默目录（兼容 folder 字段或 relative_path 前缀）。 */
export function isFileInMutedFolder(
  file: { folder?: string; relative_path: string },
  mutedFolders: readonly string[]
): boolean {
  if (mutedFolders.length === 0) return false;
  if (file.folder && file.folder !== '.') {
    if (isFolderMuted(file.folder, mutedFolders)) return true;
  }
  const relNorm = file.relative_path.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const raw of mutedFolders) {
    const m = normalizeMutedFolderPath(raw);
    if (!m) continue;
    if (relNorm.startsWith(`${m}/`)) return true;
  }
  return false;
}

/**
 * 全景三视图（星图 / 日历 / 列表）共享的静默目录排除 SSOT：
 * - 仅过滤全景时间线与星图噪点，左栏仍以灰阶「已静默」保留，且可随时点击阅读或 Ctrl+K 检索；
 * - 关联文件处于静默目录的事件同步过滤，保证三视图数字与资产 100% 同源一致。
 */
export function filterOutMutedFolders<
  F extends { file_id: string; folder?: string; relative_path: string },
  E extends { file_id?: string | null }
>(
  files: readonly F[],
  events: readonly E[],
  mutedFolders: readonly string[]
): { files: F[]; events: E[]; mutedFileCount: number } {
  if (mutedFolders.length === 0) {
    return { files: files as F[], events: events as E[], mutedFileCount: 0 };
  }
  const keptFiles: F[] = [];
  const mutedIds = new Set<string>();
  for (const f of files) {
    if (isFileInMutedFolder(f, mutedFolders)) {
      mutedIds.add(f.file_id);
    } else {
      keptFiles.push(f);
    }
  }
  if (mutedIds.size === 0) {
    return { files: files as F[], events: events as E[], mutedFileCount: 0 };
  }
  const keptEvents = events.filter((e) => !e.file_id || !mutedIds.has(e.file_id));
  return {
    files: keptFiles,
    events: keptEvents,
    mutedFileCount: mutedIds.size,
  };
}

function isPanoramaWireItemKept(
  item: { file_id?: string | null; file_path?: string | null; format?: string | null },
  mutedFolders: readonly string[],
  domain: AssetDomainFilter
): boolean {
  // 工作区级/决策级无关联文件事件保留，不受目录静默或代码域过滤误伤
  if (!item.file_id && !item.file_path) return true;
  if (
    mutedFolders.length > 0 &&
    item.file_path &&
    isFileInMutedFolder({ relative_path: item.file_path }, mutedFolders)
  ) {
    return false;
  }
  if (domain !== 'all' && item.format) {
    return classifyAssetDomain(item.format) === domain;
  }
  return true;
}

/**
 * 全景列表分页查询 EventPage 同源过滤：
 * 保证服务端分页加载的 TimelineView 与星图/日历执行完全一致的「静默目录 + 资产域」口径。
 */
export function filterPanoramaEventPage(
  page: EventPage | null | undefined,
  mutedFolders: readonly string[],
  domain: AssetDomainFilter
): EventPage | null {
  if (!page) return null;
  if (mutedFolders.length === 0 && domain === 'all') return page;
  const kept = page.items.filter((item) => isPanoramaWireItemKept(item, mutedFolders, domain));
  const dropped = page.items.length - kept.length;
  return {
    ...page,
    items: kept,
    total_in_window: Math.max(kept.length, page.total_in_window - dropped),
  };
}

/**
 * 全景日桶 EventDaysResult 同源过滤：
 * 保证星图时间标尺与列表日期筛选下拉框不泄露已静默目录或被排除资产域的样本。
 */
export function filterPanoramaEventDays(
  eventDays: EventDaysResult | null | undefined,
  mutedFolders: readonly string[],
  domain: AssetDomainFilter
): EventDaysResult | null {
  if (!eventDays) return null;
  if (mutedFolders.length === 0 && domain === 'all') return eventDays;
  const nextGroups = [];
  let total = 0;
  for (const g of eventDays.groups) {
    const keptSamples = g.samples.filter((s) => isPanoramaWireItemKept(s, mutedFolders, domain));
    const dropped = g.samples.length - keptSamples.length;
    if (keptSamples.length === 0 && g.decisions.length === 0 && g.samples.length > 0) {
      continue;
    }
    const nextCount =
      g.samples.length === g.count
        ? keptSamples.length
        : Math.max(keptSamples.length, g.count - dropped);
    total += nextCount;
    nextGroups.push({
      ...g,
      count: nextCount,
      samples: keptSamples,
    });
  }
  return {
    ...eventDays,
    groups: nextGroups,
    total,
  };
}

// ===== 左栏目录树三态排序（名称 / 近 7 日活跃 / 未读数）与即时快筛 + 高亮 =====

export type SidebarTreeSortMode = 'name' | 'active7d' | 'unread';

export interface FolderSortMetrics {
  unreadCount: number;
  active7dCount: number;
  /** 若调用方传入的指标已是子树递归汇总值（如 collectFolderActivitySummaries），跳过二次累加防重复计数。 */
  subtreeAggregated?: boolean;
}

/** 计算每个目录节点的子树聚合指标（自身 + 全量后代），保证按活跃/未读排序时父目录能上浮。 */
function computeSubtreeSortMetrics(
  nodes: readonly FolderNode[],
  activityMap?: ReadonlyMap<string, FolderSortMetrics>
): Map<string, FolderSortMetrics> {
  const totals = new Map<string, FolderSortMetrics>();
  const walk = (node: FolderNode): FolderSortMetrics => {
    const entry = activityMap?.get(node.path);
    if (entry?.subtreeAggregated) {
      for (const child of node.children) walk(child);
      const res = {
        unreadCount: entry.unreadCount,
        active7dCount: entry.active7dCount,
      };
      totals.set(node.path, res);
      return res;
    }
    const direct = entry ?? { unreadCount: 0, active7dCount: 0 };
    let unreadCount = direct.unreadCount;
    let active7dCount = direct.active7dCount;
    for (const child of node.children) {
      const sub = walk(child);
      unreadCount += sub.unreadCount;
      active7dCount += sub.active7dCount;
    }
    const res = { unreadCount, active7dCount };
    totals.set(node.path, res);
    return res;
  };
  for (const n of nodes) walk(n);
  return totals;
}

/** 确定性递归排序目录树（'name' 按中文/路径字典序；'active7d' 按近 7 日活跃降序；'unread' 按未读数降序）。 */
export function sortFolderTreeNodes(
  nodes: readonly FolderNode[],
  mode: SidebarTreeSortMode,
  activityMap?: ReadonlyMap<string, FolderSortMetrics>
): FolderNode[] {
  if (mode === 'name') {
    const sortByName = (list: readonly FolderNode[]): FolderNode[] =>
      [...list]
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .map((n) => (n.children.length > 0 ? { ...n, children: sortByName(n.children) } : n));
    return sortByName(nodes);
  }
  const totals = computeSubtreeSortMetrics(nodes, activityMap);
  const scoreOf = (node: FolderNode): number => {
    const m = totals.get(node.path);
    if (!m) return 0;
    return mode === 'active7d' ? m.active7dCount : m.unreadCount;
  };
  const sortRecursive = (list: readonly FolderNode[]): FolderNode[] =>
    [...list]
      .sort((a, b) => {
        const diff = scoreOf(b) - scoreOf(a);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      })
      .map((n) => (n.children.length > 0 ? { ...n, children: sortRecursive(n.children) } : n));
  return sortRecursive(nodes);
}

/**
 * 左栏即时目录/文件名快筛（线性单遍，5,500 份文件 < 30ms）：
 * - 目录名命中时整棵子树保留；
 * - 文件名/路径命中时保留祖先链并记入 `autoExpandedPaths` 自动展开定位。
 */
export function filterFolderTreeByQuery(
  nodes: readonly FolderNode[],
  rootFiles: readonly FileRecord[],
  query: string
): {
  nodes: FolderNode[];
  rootFiles: FileRecord[];
  matchedFileCount: number;
  matchedFolderCount: number;
  autoExpandedPaths: Set<string>;
} {
  const q = query.trim().toLowerCase();
  const autoExpandedPaths = new Set<string>();
  if (!q) {
    return {
      nodes: nodes as FolderNode[],
      rootFiles: rootFiles as FileRecord[],
      matchedFileCount: 0,
      matchedFolderCount: 0,
      autoExpandedPaths,
    };
  }

  let matchedFileCount = 0;
  let matchedFolderCount = 0;

  const fileMatches = (f: FileRecord): boolean =>
    f.title.toLowerCase().includes(q) || f.relative_path.toLowerCase().includes(q);

  const filterNode = (node: FolderNode): FolderNode | null => {
    const nameHit =
      node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q);
    if (nameHit) {
      matchedFolderCount += 1;
      // 目录自身命中：保留全部子文件与子目录（方便直接浏览该目录）
      return node;
    }
    const matchedDirectFiles = node.directFiles.filter(fileMatches);
    matchedFileCount += matchedDirectFiles.length;
    const matchedChildren: FolderNode[] = [];
    for (const child of node.children) {
      const kept = filterNode(child);
      if (kept) matchedChildren.push(kept);
    }
    if (matchedDirectFiles.length === 0 && matchedChildren.length === 0) {
      return null;
    }
    autoExpandedPaths.add(node.path);
    const total =
      matchedDirectFiles.length + matchedChildren.reduce((s, c) => s + c.total, 0);
    return {
      ...node,
      direct: matchedDirectFiles.length,
      total,
      isEmpty: total === 0 && matchedChildren.length === 0,
      directFiles: matchedDirectFiles,
      children: matchedChildren,
    };
  };

  const keptNodes: FolderNode[] = [];
  for (const n of nodes) {
    const kept = filterNode(n);
    if (kept) keptNodes.push(kept);
  }
  const keptRootFiles = rootFiles.filter(fileMatches);
  matchedFileCount += keptRootFiles.length;

  return {
    nodes: keptNodes,
    rootFiles: keptRootFiles,
    matchedFileCount,
    matchedFolderCount,
    autoExpandedPaths,
  };
}

/** 切分快筛高亮片段（大小写无关，无命中时返回单段原文本）。 */
export function splitQuickFilterHighlight(
  text: string,
  query: string
): Array<{ text: string; hit: boolean }> {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const segments: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQ, cursor);
    if (idx === -1) {
      segments.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) {
      segments.push({ text: text.slice(cursor, idx), hit: false });
    }
    segments.push({ text: text.slice(idx, idx + q.length), hit: true });
    cursor = idx + q.length;
  }
  return segments.length > 0 ? segments : [{ text, hit: false }];
}

