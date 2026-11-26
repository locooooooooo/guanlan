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
const EMPTY_PALETTE_ITEMS: PaletteItem[] = [];

export interface UseCommandPaletteOptions {
  files: PaletteFileLite[];
  readingStates: Record<string, ReadingState | undefined>;
  initiatives: InitiativeStateView[];
  artifacts: ArtifactStateView[];
  recentWorkspaces: string[];
  mountedWorkspaces?: MountedWorkspaceDto[];
  multiProjectCount?: number;
  enabled?: boolean;
}

export interface UseCommandPaletteResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  query: string;
  setQuery: (q: string) => void;
  items: PaletteItem[];
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
        if (seq !== fetchSeqRef.current) return;
        if (result.ok) {
          setServerItems(serverHitsToItems(result.data.items, RESULT_LIMIT));
        } else {
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
      isOpen
        ? assemblePaletteResults({
            query: parsed,
            files,
            readingStates,
            serverItems,
            crossItems,
            initiatives,
            artifacts,
            recentWorkspaces,
            limit: RESULT_LIMIT,
          })
        : EMPTY_PALETTE_ITEMS,
    [isOpen, parsed, files, readingStates, serverItems, crossItems, initiatives, artifacts, recentWorkspaces]
  );

  return { isOpen, open, close, toggle, query, setQuery, items, searching };
}
