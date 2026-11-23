/**
 * C03 · Ctrl+K 命令面板——结果组装纯函数（零 React 依赖，node:test 可单测）。
 *
 * 双层刷新口径（验收「每敲击至结果列表刷新 <50ms」）：
 *   - 本地层（同步）：files 全量摘要（App 已在内存）按关键词做路径/标题子串过滤 +
 *     语法过滤（@日期/type:/status:待拍板/in:事项）——每敲击即时刷新；
 *   - 全文层（异步并入）：C02 `GET /api/v1/search` 的正文级命中在防抖后到达，
 *     按 score 优先、file_id 去重合并——列表先出本地结果，全文命中随后并入。
 *   空查询：最近浏览 Top 20（readingStates.updated_at 排序）+ 常驻动作行。
 */

import type { ArtifactStateView, InitiativeStateView, SearchHitDto } from '../services/apiTypes';
import {
  localDayOf,
  matchesKeyword,
  type PaletteQuery,
} from './commandPaletteGrammar';
import { readingRecency } from './readingStateStore';
import type { ReadingState } from '../types/guanlan';

/**
 * 文件源最小接口（调用方适配：App 的 FileRecord 视图模型 / FileSummary 摘要均可投影）。
 * last_observed_at 供 @日期过滤（缺省时不做日期过滤）；status 缺省视为 active。
 */
export interface PaletteFileLite {
  file_id: string;
  relative_path: string;
  title: string;
  format: string;
  current_revision_id: string;
  coverage: string;
  last_observed_at?: string;
  status?: string;
}

/** 面板条目（文件 / 动作 / 提示行统一模型） */
export interface PaletteItem {
  kind: 'file' | 'action';
  /** 稳定 key（列表渲染与键盘选中） */
  key: string;
  title: string;
  subtitle?: string;
  format?: string;
  /** 服务端 matchStrategy（四态；文件名本地命中为 filename_match） */
  matchStrategy?: string;
  /** full_text | svg_text | pdf_page_text | office_structured | filename_only | decision */
  coverage?: string;
  fileId?: string;
  revisionId?: string;
  relativePath?: string;
  /** 命中行原文（服务端 snippet；高亮在组件层按关键词切分段） */
  snippetText?: string;
  /** 待拍板数（artifact pending_p0+p1；仅文件条目携带） */
  pendingDecisions?: number;
  /** C05：命中来源挂载工作区（跨项目命中携带；主区命中缺省） */
  sourceWorkspace?: { name: string; rootKey: string };
  /** 多项目并存：命中来自其他受管项目时携带，Enter 直接零重启切焦点并打开完整阅读器 */
  projectId?: string;
  projectName?: string;
  /** 动作 id（kind=action） */
  actionId?: 'jump-today' | 'open-basket' | 'locate-root' | 'switch-workspace' | 'mount-workspace';
  /** 动作参数（switch-workspace 的 root 等） */
  payload?: string;
  score: number;
}

/** 语法过滤 + 本地文件命中（同步层） */
export function localFileHits(
  files: PaletteFileLite[],
  readingStates: Record<string, ReadingState | undefined>,
  query: PaletteQuery,
  artifacts: ArtifactStateView[],
  limit: number
): PaletteItem[] {
  const artifactByFile = new Map<string, ArtifactStateView>();
  for (const a of artifacts) artifactByFile.set(a.file_id, a);
  const dayFrom = query.dateFrom;
  const dayTo = query.dateTo;

  const items: PaletteItem[] = [];
  for (const file of files) {
    if (file.status && file.status !== 'active') continue;
    const artifact = artifactByFile.get(file.file_id);
    const pending = (artifact?.pending_p0 ?? 0) + (artifact?.pending_p1 ?? 0);
    // ① 语法过滤（先于关键词，便宜且筛除面大）
    if (query.types.length && !query.types.includes(file.format)) continue;
    if (query.pendingDecisionOnly && pending <= 0) continue;
    if (dayFrom && dayTo && file.last_observed_at) {
      // YYYY-MM-DD 字典序即时间序（同日归属按本地日口径）；缺 last_observed_at 不过滤
      const day = localDayOf(new Date(file.last_observed_at));
      if (day < dayFrom || day > dayTo) continue;
    }
    // ② 关键词过滤（路径/标题子串；正文级命中由服务端层补充）
    const kw = query.keyword;
    if (kw && !matchesKeyword(file.relative_path, kw) && !matchesKeyword(file.title, kw)) {
      continue;
    }
    // 排序微调：有阅读记录的文件略靠前（recency 越新越靠前）
    const recency = readingRecency(readingStates[file.file_id]);
    const score = recency > 0 ? 40 + Math.min(10, Math.floor(recency / 86400000)) : 40;
    items.push({
      kind: 'file',
      key: `local:${file.file_id}`,
      title: file.title,
      subtitle: file.relative_path,
      format: file.format,
      matchStrategy: 'filename_match',
      coverage: file.coverage,
      fileId: file.file_id,
      revisionId: file.current_revision_id ?? undefined,
      relativePath: file.relative_path,
      pendingDecisions: pending || undefined,
      score,
    });
    if (items.length >= limit * 2) break;
  }
  // 同分按路径字典序稳定排序（不做复杂打分——搜索主排序来自服务端层）
  items.sort((a, b) => b.score - a.score || a.subtitle!.localeCompare(b.subtitle!));
  return items.slice(0, limit);
}

/** 服务端命中（C02 /search）→ 面板条目（全文层） */
export function serverHitsToItems(hits: SearchHitDto[], limit: number): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const hit of hits) {
    if (items.length >= limit) break;
    items.push({
      kind: 'file',
      key: `srv:${hit.file_id}:${hit.revision_id}`,
      title: hit.title,
      subtitle: hit.relative_path,
      format: hit.format,
      matchStrategy: hit.match_strategy,
      coverage: hit.coverage,
      fileId: hit.file_id,
      revisionId: hit.revision_id,
      relativePath: hit.relative_path,
      snippetText: hit.snippet,
      score: hit.score,
    });
  }
  return items;
}

/**
 * 合并本地与全文命中：服务端优先（score + 正文级证据），同 file_id 去重保留服务端条目；
 * 结果按 score 降序（同分 file_id 字典序稳定）。
 */
export function mergeHits(server: PaletteItem[], local: PaletteItem[], limit: number): PaletteItem[] {
  const seen = new Set<string>();
  const out: PaletteItem[] = [];
  for (const item of [...server, ...local]) {
    if (item.kind !== 'file') continue;
    const id = item.fileId ?? item.key;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
    if (out.length >= limit) break;
  }
  out.sort(
    (a, b) => b.score - a.score || (a.fileId ?? '').localeCompare(b.fileId ?? '')
  );
  return out;
}

/** 空查询：最近浏览 Top N（readingStates.updated_at 最新优先；从未读过的文件不出现） */
export function recentViewedItems(
  files: PaletteFileLite[],
  readingStates: Record<string, ReadingState | undefined>,
  limit: number
): PaletteItem[] {
  const entries: Array<{ file: PaletteFileLite; recency: number }> = [];
  for (const file of files) {
    if (file.status && file.status !== 'active') continue;
    const recency = readingRecency(readingStates[file.file_id]);
    if (recency > 0) entries.push({ file, recency });
  }
  entries.sort((a, b) => b.recency - a.recency);
  return entries.slice(0, limit).map(({ file }) => ({
    kind: 'file' as const,
    key: `recent:${file.file_id}`,
    title: file.title,
    subtitle: file.relative_path,
    format: file.format,
    coverage: file.coverage,
    fileId: file.file_id,
    revisionId: file.current_revision_id ?? undefined,
    relativePath: file.relative_path,
    score: 50,
  }));
}

/** 常驻动作行（空态与查询态共用；工作区切换每最近项一行） */
export function builtinActions(recentWorkspaces: string[]): PaletteItem[] {
  const items: PaletteItem[] = [
    {
      kind: 'action',
      key: 'action:jump-today',
      title: '跳到今天 · 时间主干',
      subtitle: '过滤事件与司辰至今日',
      actionId: 'jump-today',
      score: 30,
    },
    {
      kind: 'action',
      key: 'action:open-basket',
      title: '证据篮 · 查看与带走上下文包',
      subtitle: '给智能体的上下文清单',
      actionId: 'open-basket',
      score: 29,
    },
    {
      kind: 'action',
      key: 'action:locate-root',
      title: '定位：工作区根目录',
      subtitle: '在资源管理器中显示',
      actionId: 'locate-root',
      score: 28,
    },
    {
      kind: 'action',
      key: 'action:mount-workspace',
      title: '挂载参考工作区 · 跨项目检索',
      subtitle: '只读挂载其他项目，历史采纳的规范与决定一起搜',
      actionId: 'mount-workspace',
      score: 27,
    },
  ];
  recentWorkspaces.slice(0, 5).forEach((root, i) => {
    const tail = root.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? root;
    items.push({
      kind: 'action',
      key: `action:ws:${i}`,
      title: `切换工作区：${tail}`,
      subtitle: root,
      actionId: 'switch-workspace',
      payload: root,
      score: 20 - i,
    });
  });
  return items;
}

/**
 * 主组装入口：查询态 = 语法过滤（本地层）+ 服务端全文层 + 挂载区跨库层合并；空态 = 最近浏览 + 动作。
 * `initiativeNames` 供 in: 过滤（initiative_id → 名称）。
 */
export function assemblePaletteResults(input: {
  query: PaletteQuery;
  files: PaletteFileLite[];
  readingStates: Record<string, ReadingState | undefined>;
  serverItems: PaletteItem[];
  /** C05：挂载区跨库层（带 sourceWorkspace 来源徽标；无在线挂载时为空） */
  crossItems?: PaletteItem[];
  initiatives: InitiativeStateView[];
  artifacts: ArtifactStateView[];
  recentWorkspaces: string[];
  limit: number;
}): PaletteItem[] {
  const { query, files, readingStates, serverItems, crossItems = [], limit } = input;
  if (!query.keyword && !query.types.length && !query.pendingDecisionOnly && !query.dateFrom && !query.initiativeQuery) {
    // 空态：最近浏览 Top 20 + 常驻动作
    return [...recentViewedItems(files, readingStates, 20), ...builtinActions(input.recentWorkspaces)];
  }

  // in: 事项过滤：把命中该事项的 artifacts file_id 集合作为白名单
  let whitelist: Set<string> | null = null;
  if (query.initiativeQuery) {
    const nameById = new Map<string, string>();
    for (const init of input.initiatives) nameById.set(init.initiative_id, init.name);
    whitelist = new Set(
      input.artifacts
        .filter((a) => {
          const name = a.initiative_id ? nameById.get(a.initiative_id) : undefined;
          const hay = `${name ?? ''}\n${a.title}\n${a.current_path}`;
          return matchesKeyword(hay, query.initiativeQuery ?? '');
        })
        .map((a) => a.file_id)
    );
    if (whitelist.size === 0) return [];
  }

  const inFilter = (item: PaletteItem): boolean =>
    !whitelist || (item.fileId ? whitelist.has(item.fileId) : false);

  const server = serverItems.filter(inFilter);
  const cross = crossItems.filter(inFilter);
  const local = localFileHits(
    files,
    readingStates,
    query,
    input.artifacts,
    limit
  ).filter(inFilter);
  return mergeHits([...server, ...cross], local, limit);
}
