/**
 * C03 · Ctrl+K 命令面板——状态 Hook（双层刷新与键盘/热键接线）。
 *
 * 性能口径（任务卡 C03）：
 * - 呼出 <16ms：open() 只置布尔位；空态数据（最近浏览/动作）由 files + readingStates
 *   内存即时组装（assemblePaletteResults 纯函数，微秒级），无任何 IO；
 * - 每敲击 <50ms：**本地层（路径/标题子串 + 语法过滤）同步即时刷新**；全文层
 *   （C02 GET /api/v1/search，服务端 p95 18ms + HTTP）经 130ms 防抖异步并入——
 *   列表先出本地命中，全文命中随后按 score 并入（<50ms 的「刷新」由本地层兑现）。
 *
 * 键盘接线：
 * - 应用内 Ctrl/Cmd+K：window capture 监听（preventDefault 阻止浏览器默认搜索绑定）；
 * - 桌面壳全局热键：subscribeGlobalShortcut（guanlan:global-shortcut CustomEvent，
 *   由 guanlan-desktop tauri-plugin-global-shortcut 原生转发）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parsePaletteQuery } from '../utils/commandPaletteGrammar';
import {
  assemblePaletteResults,
  serverHitsToItems,
  type PaletteFileLite,
  type PaletteItem,
} from '../utils/commandPaletteResults';
import {
  crossHitsToItems,
  projectSearchHitsToItems,
  shouldFetchCrossSearch,
} from '../utils/crossWorkspaceSearch';
import {
  fetchCrossSearch,
  fetchProjectsSearch,
  fetchSearch,
} from '../services/workspaceClient';
import { subscribeGlobalShortcut } from '../services/desktopBridge';
import type {
  ArtifactStateView,
  InitiativeStateView,
  MountedWorkspaceDto,
} from '../services/apiTypes';
import type { ReadingState } from '../types/guanlan';

const SEARCH_DEBOUNCE_MS = 130;
const RESULT_LIMIT = 30;

export interface UseCommandPaletteOptions {
  files: PaletteFileLite[];
  readingStates: Record<string, ReadingState | undefined>;
  initiatives: InitiativeStateView[];
  artifacts: ArtifactStateView[];
  recentWorkspaces: string[];
  /** C05：挂载参考工作区（有在线挂载时全文层同时发 /api/v1/search/cross 跨库层） */
  mountedWorkspaces?: MountedWorkspaceDto[];
  /** 多项目并存：受管项目数 > 1 时并发 /api/v1/projects/search 覆盖全部其他项目 */
  multiProjectCount?: number;
  enabled?: boolean;
}

export interface UseCommandPaletteResult {
  isOpen: boolean;
  /** 打开（Ctrl+K / 全局热键 / 外部按钮） */
  open: () => void;
  close: () => void;
  toggle: () => void;
  query: string;
  setQuery: (q: string) => void;
  /** 组装后的结果（空态=最近浏览+动作；查询态=双层合并） */
  items: PaletteItem[];
  /** 全文层是否仍在加载（UI 显示微进度） */
  searching: boolean;
}

export function useCommandPalette(options: UseCommandPaletteOptions): UseCommandPaletteResult {
  const {
    files,
    readingStates,
    initiatives,
    artifacts,
    recentWorkspaces,
    mountedWorkspaces,
    multiProjectCount = 0,
    enabled = true,
  } = options;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [serverItems, setServerItems] = useState<PaletteItem[]>([]);
  const [crossItems, setCrossItems] = useState<PaletteItem[]>([]);
  const [searching, setSearching] = useState(false);
  /** 每次输入自增；过期响应（慢网）到达后丢弃——与 App 事件页取数的竞态纪律同口径 */
  const fetchSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = useCallback(() => {
    setIsOpen(true);
    setQueryState('');
    setServerItems([]);
    setCrossItems([]);
    setSearching(false);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => {
    setIsOpen((v) => !v);
    setQueryState('');
    setServerItems([]);
    setCrossItems([]);
    setSearching(false);
  }, []);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    // 全文层防抖：清掉上一轮定时与过期结果标记
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const parsed = parsePaletteQuery(q);
    if (!parsed.keyword) {
      setServerItems([]);
      setCrossItems([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++fetchSeqRef.current;
    // C05 + 多项目并存：在线挂载区或多项目数 > 1 时并发跨项目检索
    const wantCross = shouldFetchCrossSearch(mountedWorkspaces ?? []);
    const wantMultiProject = multiProjectCount > 1;
    debounceRef.current = setTimeout(() => {
      void (async () => {
        const primary = fetchSearch(parsed.keyword, { limit: RESULT_LIMIT });
        const cross = wantCross
          ? fetchCrossSearch(parsed.keyword, { limit: RESULT_LIMIT })
          : Promise.resolve(null);
        const multiProj = wantMultiProject
          ? fetchProjectsSearch(parsed.keyword, RESULT_LIMIT)
          : Promise.resolve(null);
        const [result, crossResult, multiProjResult] = await Promise.all([
          primary,
          cross,
          multiProj,
        ]);
        if (seq !== fetchSeqRef.current) return; // 过期响应丢弃
        if (result.ok) {
          setServerItems(serverHitsToItems(result.data.items, RESULT_LIMIT));
        } else {
          // 服务未就绪 / 非桌面环境：静默降级（本地层照常可用）
          setServerItems([]);
        }
        const mergedCross: PaletteItem[] = [];
        if (multiProjResult && multiProjResult.ok && multiProjResult.data) {
          mergedCross.push(...projectSearchHitsToItems(multiProjResult.data, RESULT_LIMIT));
        }
        if (crossResult && crossResult.ok) {
          mergedCross.push(...crossHitsToItems(crossResult.data, RESULT_LIMIT));
        }
        setCrossItems(mergedCross);
        setSearching(false);
      })();
    }, SEARCH_DEBOUNCE_MS);
  }, [mountedWorkspaces, multiProjectCount]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // 应用内 Ctrl/Cmd+K（capture：抢在页面默认行为前）
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, toggle]);

  // 桌面壳全局热键（guanlan-desktop 原生注册 → CustomEvent 转发；浏览器环境静默）
  useEffect(() => {
    if (!enabled) return;
    return subscribeGlobalShortcut(() => {
      setIsOpen(true);
      setQueryState('');
      setServerItems([]);
      setCrossItems([]);
      setSearching(false);
    });
  }, [enabled]);

  const parsed = useMemo(() => parsePaletteQuery(query), [query]);
  const items = useMemo(
    () =>
      assemblePaletteResults({
        query: parsed,
        files,
        readingStates,
        serverItems,
        crossItems,
        initiatives,
        artifacts,
        recentWorkspaces,
        limit: RESULT_LIMIT,
      }),
    [parsed, files, readingStates, serverItems, crossItems, initiatives, artifacts, recentWorkspaces]
  );

  return { isOpen, open, close, toggle, query, setQuery, items, searching };
}
