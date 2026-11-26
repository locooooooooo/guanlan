import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Binary,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FolderSearch,
  Globe,
  Grid,
  Hash,
  History,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Minus,
  ShieldAlert,
  ShieldCheck,
  Table2,
  X,
} from 'lucide-react';
import type { EvidencePointer, FileRecord } from '../types/guanlan';
import {
  fetchRevisionContent,
  fetchRevisionPreview,
  resolveApiUrl,
  revisionRawUrl,
  revisionThumbnailUrl,
  type RevisionPreviewResponse,
} from '../services/workspaceClient';
import { copyTextWithDesktopFallback } from '../services/desktopBridge';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import { Button, IconButton } from './ui/primitives';
import { anchoredToastManager, Kbd } from './ui';
import {
  formatUiMeta,
  isPreviewableHtmlFormat,
  isStructuredOfficeFormat,
  snapshotTierDescription,
} from '../utils/formatMeta';
import { formatByteSize } from './NonLegacyFilePreviewPanel';
import { buildHtmlSandboxDocument } from '../utils/htmlPreview';
import {
  formatDeltaBytes,
  getCachedQuickPreview,
  isNumericCell,
  parseDelimitedTable,
  QuickPreviewCoordinator,
  tokenizeCodeLine,
  tryPrettyJson,
  type SyntaxTokenKind,
} from '../utils/quickPreviewHelpers';
import { formatRelativeObservedAt } from '../utils/timeFormat';

export interface QuickPreviewTarget {
  fileId: string;
  revisionId?: string;
}

export interface QuickPreviewModalProps {
  isOpen: boolean;
  target: QuickPreviewTarget | null;
  queue: QuickPreviewTarget[];
  files: FileRecord[];
  indexGeneration: number;
  onClose: () => void;
  onNavigate: (next: QuickPreviewTarget) => void;
  onOpenFullReader: (fileId: string, revisionId?: string) => void;
  onAddEvidencePointer?: (pointer: EvidencePointer) => void | Promise<boolean> | boolean;
  systemActions?: DesktopFileActionCallbacks;
}

const TOKEN_CLASS: Record<SyntaxTokenKind, string> = {
  plain: 'text-[color:var(--ink-strong)]',
  keyword: 'text-[color:var(--accent-iris-deep)] font-medium',
  string: 'text-[color:var(--stage-ink-deliver-text)]',
  number: 'text-[color:var(--stage-ink-decision-text)]',
  comment: 'text-[color:var(--ink-soft)] italic',
  key: 'text-[color:var(--stage-ink-blueprint-text)] font-medium',
  heading: 'text-[color:var(--accent-wave)] font-semibold',
  badge:
    'rounded bg-[color:var(--chip-active-bg)] px-1 text-[color:var(--accent-iris-ink)] font-semibold',
};

const MAX_RENDER_LINES = 1500;

export const QuickPreviewModal: React.FC<QuickPreviewModalProps> = ({
  isOpen,
  target,
  queue,
  files,
  indexGeneration,
  onClose,
  onNavigate,
  onOpenFullReader,
  onAddEvidencePointer,
  systemActions,
}) => {
  const fileById = useMemo(() => {
    const map = new Map<string, FileRecord>();
    for (const f of files) map.set(f.file_id, f);
    return map;
  }, [files]);

  const activeFile = target ? fileById.get(target.fileId) ?? null : null;
  const resolvedRevisionId =
    target?.revisionId || activeFile?.current_revision_id || '';
  const activeRevision = useMemo(() => {
    if (!activeFile) return null;
    return (
      activeFile.revisions.find((r) => r.revision_id === resolvedRevisionId) ??
      activeFile.revisions[activeFile.revisions.length - 1] ??
      null
    );
  }, [activeFile, resolvedRevisionId]);

  const currentIndex = useMemo(() => {
    if (!target || queue.length === 0) return -1;
    const exact = queue.findIndex(
      (q) =>
        q.fileId === target.fileId &&
        (!target.revisionId || !q.revisionId || q.revisionId === target.revisionId)
    );
    if (exact >= 0) return exact;
    return queue.findIndex((q) => q.fileId === target.fileId);
  }, [queue, target]);

  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < queue.length - 1;

  const [navSeq, setNavSeq] = useState(0);
  const navPrevRef = useRef<{ open: boolean; index: number }>({ open: false, index: -1 });
  const navPrev = navPrevRef.current;
  const isQueueNav =
    isOpen &&
    navPrev.open &&
    navPrev.index >= 0 &&
    currentIndex >= 0 &&
    navPrev.index !== currentIndex;
  if (navPrev.open !== isOpen || navPrev.index !== currentIndex) {
    navPrevRef.current = { open: isOpen, index: currentIndex };
  }
  if (isQueueNav) {
    setNavSeq((s) => s + 1);
  }

  const coordinatorRef = useRef<QuickPreviewCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new QuickPreviewCoordinator(fetchRevisionPreview);
  }

  const cachedImmediate =
    isOpen && resolvedRevisionId
      ? getCachedQuickPreview(resolvedRevisionId, 0)
      : null;

  const [fetchedPreview, setFetchedPreview] = useState<RevisionPreviewResponse | null>(null);
  const [extraTextSlices, setExtraTextSlices] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [imageZoom, setImageZoom] = useState<'fit' | number>('fit');
  const [naturalImageSize, setNaturalImageSize] = useState<{ width: number; height: number } | null>(
    null
  );
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [checkerboardBg, setCheckerboardBg] = useState(false);
  const [vectorAsSource, setVectorAsSource] = useState(false);
  const [tableAsSource, setTableAsSource] = useState(false);
  const [htmlAsSource, setHtmlAsSource] = useState(false);
  const [htmlAllowScripts, setHtmlAllowScripts] = useState(true);
  const [htmlAllowExternalHttps, setHtmlAllowExternalHttps] = useState(false);
  const [fullHtmlBody, setFullHtmlBody] = useState<{ revisionId: string; text: string } | null>(
    null
  );
  const [fullHtmlLoading, setFullHtmlLoading] = useState(false);
  const [prettyJson, setPrettyJson] = useState(false);
  const [copiedHash, setCopiedHash] = useState(false);
  const [copiedSlice, setCopiedSlice] = useState(false);
  const [copiedEvidence, setCopiedEvidence] = useState(false);

  const preview =
    fetchedPreview && fetchedPreview.revision_id === resolvedRevisionId
      ? fetchedPreview
      : cachedImmediate;

  useEffect(() => {
    setExtraTextSlices([]);
    setLoadingMore(false);
    setFetchError(null);
    setImageZoom('fit');
    setNaturalImageSize(null);
    setImageLoadFailed(false);
    setVectorAsSource(false);
    setTableAsSource(false);
    setHtmlAsSource(false);
    setHtmlAllowExternalHttps(false);
    setFullHtmlBody(null);
    setFullHtmlLoading(false);
    setPrettyJson(false);
    setCopiedHash(false);
    setCopiedSlice(false);
    setCopiedEvidence(false);

    if (!isOpen || !resolvedRevisionId) {
      coordinatorRef.current?.cancelInFlight();
      setShowSpinner(false);
      return;
    }

    const immediate = getCachedQuickPreview(resolvedRevisionId, 0);
    if (immediate) {
      coordinatorRef.current?.cancelInFlight();
      setFetchedPreview(immediate);
      setShowSpinner(false);
      return;
    }

    setFetchedPreview(null);
    let active = true;
    const spinnerTimer = window.setTimeout(() => {
      if (active) setShowSpinner(true);
    }, 80);

    void coordinatorRef.current?.load(resolvedRevisionId, { offset: 0 }).then((outcome) => {
      if (!active) return;
      window.clearTimeout(spinnerTimer);
      setShowSpinner(false);
      if (outcome.status === 'ok' && outcome.data) {
        setFetchedPreview(outcome.data);
        setFetchError(null);
      } else if (outcome.status === 'error') {
        setFetchError(outcome.error || '轻预览读取失败');
      }
    });

    return () => {
      active = false;
      window.clearTimeout(spinnerTimer);
      coordinatorRef.current?.cancelInFlight();
    };
  }, [isOpen, resolvedRevisionId]);

  useEffect(() => {
    if (!isOpen || currentIndex < 0) return;
    const neighbors: string[] = [];
    for (const offset of [1, -1]) {
      const item = queue[currentIndex + offset];
      if (!item) continue;
      const revId = item.revisionId || fileById.get(item.fileId)?.current_revision_id;
      if (revId && !getCachedQuickPreview(revId, 0)) {
        neighbors.push(revId);
      }
    }
    if (neighbors.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const revId of neighbors) {
        void coordinatorRef.current?.prefetch(revId);
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [isOpen, currentIndex, queue, fileById]);

  const stepQueue = useCallback(
    (delta: -1 | 1) => {
      if (currentIndex < 0) return;
      const nextIdx = currentIndex + delta;
      if (nextIdx < 0 || nextIdx >= queue.length) return;
      onNavigate(queue[nextIdx]);
    },
    [currentIndex, queue, onNavigate]
  );

  const effectiveKind = useMemo(() => {
    if (preview) return preview.preview_kind;
    if (!activeFile) return 'binary';
    const meta = formatUiMeta(activeFile.format);
    if (meta.formatClass === 'image') return 'image';
    if (meta.formatClass === 'vector') return 'vector';
    if (meta.formatClass === 'markdown') return 'markdown';
    if (meta.formatClass === 'code') return 'code';
    if (meta.formatClass === 'text') return 'text';
    if (meta.token === 'csv' || meta.token === 'tsv') return 'table';
    if (meta.token === 'pdf') return 'pdf';
    if (isStructuredOfficeFormat(activeFile.format)) return 'office';
    return 'binary';
  }, [preview, activeFile]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      const el = e.target;
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'Escape' || e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        stepQueue(-1);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        stepQueue(1);
        return;
      }
      if (e.key === 'Enter' && target) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        onOpenFullReader(target.fileId, resolvedRevisionId || undefined);
        return;
      }
      if (effectiveKind === 'image' || (effectiveKind === 'vector' && !vectorAsSource)) {
        if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          setImageZoom((z) => {
            const cur = z === 'fit' ? 100 : z;
            return Math.min(400, cur + 25);
          });
        } else if (e.key === '-') {
          e.preventDefault();
          setImageZoom((z) => {
            const cur = z === 'fit' ? 100 : z;
            return Math.max(25, cur - 25);
          });
        } else if (e.key === '0') {
          e.preventDefault();
          setImageZoom('fit');
        }
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [
    isOpen,
    onClose,
    stepQueue,
    target,
    resolvedRevisionId,
    onOpenFullReader,
    effectiveKind,
    vectorAsSource,
  ]);

  const handleLoadNextSlice = async () => {
    if (!preview || !preview.truncated || loadingMore) return;
    const nextOffset = preview.slice_offset + preview.slice_bytes;
    setLoadingMore(true);
    const res = await fetchRevisionPreview(preview.revision_id, { offset: nextOffset });
    setLoadingMore(false);
    if (res.ok && res.data.revision_id === preview.revision_id) {
      const nextData = res.data;
      if (nextData.text_slice) {
        setExtraTextSlices((prev) => [...prev, nextData.text_slice!]);
      }
      setFetchedPreview((prev) =>
        prev && prev.revision_id === nextData.revision_id
          ? {
              ...nextData,
              text_slice: prev.text_slice,
              slice_offset: prev.slice_offset,
              slice_bytes:
                nextData.slice_offset + nextData.slice_bytes - prev.slice_offset,
            }
          : nextData
      );
    }
  };

  const formatToken = preview?.format || activeFile?.format || 'bin';
  const uiMeta = formatUiMeta(formatToken);
  const isHtmlFormat = isPreviewableHtmlFormat(formatToken);

  const combinedText = useMemoTextSlice(preview?.text_slice, extraTextSlices);

  useEffect(() => {
    if (
      !isOpen ||
      !isHtmlFormat ||
      htmlAsSource ||
      !resolvedRevisionId ||
      !preview?.truncated
    ) {
      setFullHtmlLoading(false);
      return;
    }
    if (fullHtmlBody && fullHtmlBody.revisionId === resolvedRevisionId) {
      setFullHtmlLoading(false);
      return;
    }
    let cancelled = false;
    setFullHtmlLoading(true);
    void fetchRevisionContent(resolvedRevisionId).then((res) => {
      if (cancelled) return;
      setFullHtmlLoading(false);
      if (res.ok && typeof res.text === 'string') {
        setFullHtmlBody({ revisionId: resolvedRevisionId, text: res.text });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isHtmlFormat, htmlAsSource, resolvedRevisionId, preview?.truncated, fullHtmlBody]);

  const htmlSourceForRender = useMemo(() => {
    if (!isHtmlFormat || htmlAsSource) return null;
    if (preview?.truncated) {
      return fullHtmlBody && fullHtmlBody.revisionId === resolvedRevisionId
        ? fullHtmlBody.text
        : null;
    }
    return combinedText;
  }, [isHtmlFormat, htmlAsSource, preview?.truncated, fullHtmlBody, resolvedRevisionId, combinedText]);

  const isLatestRevisionForHtml =
    Boolean(activeFile && resolvedRevisionId) &&
    resolvedRevisionId === activeFile?.current_revision_id;

  const preparedHtml = useMemo(() => {
    if (htmlSourceForRender === null) return null;
    const relPath = preview?.relative_path || activeFile?.relative_path || '';
    return buildHtmlSandboxDocument(htmlSourceForRender, {
      allowScripts: htmlAllowScripts,
      allowExternalHttps: htmlAllowExternalHttps,
      relativePath: isLatestRevisionForHtml ? relPath : undefined,
      workspaceFiles: isLatestRevisionForHtml ? files : undefined,
      resolveRevisionRawUrl: revisionRawUrl,
    });
  }, [
    htmlSourceForRender,
    htmlAllowScripts,
    htmlAllowExternalHttps,
    isLatestRevisionForHtml,
    preview?.relative_path,
    activeFile?.relative_path,
    files,
  ]);
  const formattedJsonText = useMemo(() => {
    if (!prettyJson || !combinedText) return null;
    if (preview?.truncated) return null;
    return tryPrettyJson(combinedText);
  }, [prettyJson, combinedText, preview?.truncated]);

  const activeTextToDisplay = formattedJsonText ?? combinedText ?? '';
  const textLines = useMemo(() => {
    if (!activeTextToDisplay) return [];
    return activeTextToDisplay.split(/\r?\n/).slice(0, MAX_RENDER_LINES);
  }, [activeTextToDisplay]);

  const parsedTable = useMemo(() => {
    if (effectiveKind !== 'table' || !combinedText) return null;
    const delim = uiMeta.token === 'tsv' ? '\t' : ',';
    return parseDelimitedTable(combinedText, delim, 250);
  }, [effectiveKind, combinedText, uiMeta.token]);

  if (!isOpen || !target) return null;

  const displayTitle = preview?.title || activeFile?.title || target.fileId;
  const displayPath = preview?.relative_path || activeFile?.relative_path || '';
  const tierInfo = snapshotTierDescription(formatToken);
  const snapshotAvailable = preview
    ? preview.snapshot_available
    : activeRevision?.snapshotAvailable ?? true;
  const displaySize = preview?.size_bytes ?? activeRevision?.sizeBytes ?? 0;
  const displayHash = preview?.content_hash ?? activeRevision?.content_sha256 ?? '';
  const displaySeq = preview?.seq ?? activeRevision?.versionNumber ?? 1;
  const observedAt = preview?.observed_at ?? activeRevision?.observed_at ?? '';

  const isJsonFormat =
    uiMeta.token === 'json' || uiMeta.token === 'json5' || uiMeta.token === 'jsonc';

  const resolvedThumbUrl = preview?.thumbnail_url
    ? resolveApiUrl(preview.thumbnail_url)
    : preview?.raw_url
      ? resolveApiUrl(preview.raw_url)
      : resolvedRevisionId
        ? revisionThumbnailUrl(resolvedRevisionId)
        : '';

  const resolvedPdfUrl = preview?.raw_url
    ? resolveApiUrl(preview.raw_url)
    : resolvedRevisionId
      ? revisionRawUrl(resolvedRevisionId)
      : '';

  const imageDims = preview?.image_meta ?? naturalImageSize;

  const queueProgress = buildQuickQueueProgress(queue, files, currentIndex);

  const handleCopyHash = async () => {
    if (!displayHash) return;
    const res = await copyTextWithDesktopFallback(displayHash);
    if (res.ok) {
      setCopiedHash(true);
      window.setTimeout(() => setCopiedHash(false), 1600);
    }
  };

  const handleCopySlice = async (ev?: React.MouseEvent<HTMLElement>) => {
    if (!activeTextToDisplay) return;
    const res = await copyTextWithDesktopFallback(activeTextToDisplay);
    if (res.ok) {
      setCopiedSlice(true);
      if (ev?.currentTarget) {
        anchoredToastManager.add({
          title: '已复制当前片段',
          type: 'success',
          positionerProps: { anchor: ev.currentTarget },
        });
      }
      window.setTimeout(() => setCopiedSlice(false), 1600);
    }
  };

  const handleAddEvidence = async (ev?: React.MouseEvent<HTMLElement>) => {
    if (!onAddEvidencePointer || !activeFile || !resolvedRevisionId) return;
    const ok = await onAddEvidencePointer({
      file_id: activeFile.file_id,
      revision_id: resolvedRevisionId,
      relative_path: displayPath,
      content_sha256: displayHash,
      locator: { kind: 'file' },
      evidence_kind: snapshotAvailable ? 'explicit_source' : 'metadata_only',
      index_generation: indexGeneration,
      observed_at: observedAt,
      coverage: activeFile.coverage,
      stale: false,
      excerpt: activeTextToDisplay ? activeTextToDisplay.slice(0, 600) : '',
      note: `QuickLook · ${uiMeta.label} v${displaySeq} · ${formatByteSize(displaySize)}`,
      sizeBytes: displaySize,
    });
    if (ok !== false) {
      setCopiedEvidence(true);
      if (ev?.currentTarget) {
        anchoredToastManager.add({
          title: '已加入上下文篮',
          type: 'success',
          positionerProps: { anchor: ev.currentTarget },
        });
      }
      window.setTimeout(() => setCopiedEvidence(false), 1600);
    }
  };

  const renderBody = () => {
    if (fetchError && !preview) {
      return (
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center space-y-3">
          <ShieldAlert className="w-8 h-8 text-[color:var(--stage-ink-exec-text)]" />
          <div className="text-[14px] font-semibold text-[color:var(--ink-strong)]">
            轻预览读取失败
          </div>
          <p className="text-[12px] text-[color:var(--ink-soft)] max-w-md">{fetchError}</p>
        </div>
      );
    }

    if (
      snapshotAvailable &&
      (effectiveKind === 'image' || (effectiveKind === 'vector' && !vectorAsSource))
    ) {
      return (
        <div className="flex flex-col h-full min-h-[420px]">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-[color:var(--glass-hairline)] bg-muted/50 text-[12px]">
            <div className="flex items-center gap-2 text-[color:var(--ink-soft)] font-mono tabular-nums">
              <ImageIcon className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)]" />
              {imageDims ? (
                <span>
                  {imageDims.width} × {imageDims.height} px
                </span>
              ) : (
                <span>正在读取尺寸元数据…</span>
              )}
              <span aria-hidden="true" className="opacity-40">
                ·
              </span>
              <span>{formatByteSize(displaySize)}</span>
            </div>

            <div className="flex items-center gap-1">
              {effectiveKind === 'vector' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setVectorAsSource(true)}
                  title="查看 SVG 文本源码"
                >
                  <Code2 className="w-3.5 h-3.5" />
                  <span>SVG 源码</span>
                </Button>
              )}
              <Button
                variant={checkerboardBg ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setCheckerboardBg((v) => !v)}
                title="切换透明棋盘格底"
              >
                <Grid className="w-3.5 h-3.5" />
                <span>网格底</span>
              </Button>
              <Button
                variant={imageZoom === 'fit' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setImageZoom('fit')}
                title="适应窗口 (0)"
              >
                <Minimize2 className="w-3.5 h-3.5" />
                <span>适应</span>
              </Button>
              <Button
                variant={imageZoom === 100 ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setImageZoom(100)}
                title="原始像素 1:1"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>100%</span>
              </Button>
              <IconButton
                label="缩小"
                onClick={() =>
                  setImageZoom((z) => Math.max(25, (z === 'fit' ? 100 : z) - 25))
                }
                className="!size-7"
              >
                <Minus />
              </IconButton>
              <span className="w-11 text-center font-mono text-[11px] tabular-nums text-[color:var(--ink-strong)]">
                {imageZoom === 'fit' ? '适应' : `${imageZoom}%`}
              </span>
              <IconButton
                label="放大"
                onClick={() =>
                  setImageZoom((z) => Math.min(400, (z === 'fit' ? 100 : z) + 25))
                }
                className="!size-7"
              >
                <Plus />
              </IconButton>
            </div>
          </div>

          <div
            className="flex-1 overflow-auto flex items-center justify-center p-6 min-h-[360px]"
            style={
              checkerboardBg
                ? {
                    backgroundColor: 'var(--depth-0-base)',
                    backgroundImage:
                      'linear-gradient(45deg, rgba(38,36,61,0.06) 25%, transparent 25%), linear-gradient(-45deg, rgba(38,36,61,0.06) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(38,36,61,0.06) 75%), linear-gradient(-45deg, transparent 75%, rgba(38,36,61,0.06) 75%)',
                    backgroundSize: '16px 16px',
                    backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
                  }
                : { backgroundColor: 'var(--paper-light)' }
            }
          >
            {imageLoadFailed ? (
              <div className="text-center space-y-2.5 max-w-md">
                <ShieldAlert className="w-7 h-7 mx-auto text-[color:var(--stage-ink-decision-text)]" />
                <div className="text-[13px] font-semibold text-[color:var(--ink-strong)]">
                  当前图像编码（{uiMeta.label}）暂无法在内核直显
                </div>
                <p className="text-[12px] text-[color:var(--ink-soft)]">
                  已入库完整去重快照（{formatByteSize(displaySize)}
                  {imageDims ? ` · ${imageDims.width}×${imageDims.height}` : ''}），可调用系统默认程序查看。
                </p>
                {systemActions?.desktopSystemSupported && systemActions.onOpenWithDefaultApp && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => systemActions.onOpenWithDefaultApp?.(displayPath)}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>用系统默认应用打开</span>
                  </Button>
                )}
              </div>
            ) : (
              <img
                key={resolvedThumbUrl}
                src={resolvedThumbUrl}
                alt={displayTitle}
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setNaturalImageSize({
                      width: img.naturalWidth,
                      height: img.naturalHeight,
                    });
                  }
                }}
                onError={() => setImageLoadFailed(true)}
                style={
                  imageZoom === 'fit'
                    ? undefined
                    : {
                        width: imageDims
                          ? `${Math.round((imageDims.width * imageZoom) / 100)}px`
                          : `${imageZoom}%`,
                        maxWidth: 'none',
                        maxHeight: 'none',
                      }
                }
                className={
                  imageZoom === 'fit'
                    ? 'max-w-full max-h-[60vh] object-contain rounded-[var(--r-ctl)] shadow-sm'
                    : 'object-contain rounded-[var(--r-ctl)] shadow-sm'
                }
              />
            )}
          </div>
        </div>
      );
    }

    if (snapshotAvailable && effectiveKind === 'table' && !tableAsSource) {
      return (
        <div className="flex flex-col h-full min-h-[420px]">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-[color:var(--glass-hairline)] bg-muted/50 text-[12px]">
            <div className="flex items-center gap-2 text-[color:var(--ink-soft)] font-mono tabular-nums">
              <FileSpreadsheet className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)]" />
              <span>
                {parsedTable
                  ? `${parsedTable.totalParsedRows} 行 × ${parsedTable.columnCount} 列`
                  : '解析表格切片…'}
              </span>
              {preview?.truncated && (
                <span className="rounded bg-[color:var(--depth-1-bg)] px-1.5 py-0.5 text-[11px]">
                  仅载入前 {formatByteSize(preview.slice_bytes)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setTableAsSource(true)}>
                <Code2 className="w-3.5 h-3.5" />
                <span>源码视图</span>
              </Button>
              {preview?.truncated && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void handleLoadNextSlice()}
                >
                  {loadingMore ? '加载中…' : '继续加载 (+64 KiB)'}
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto bg-card/85 min-h-[360px] max-h-[64vh]">
            {!preview && showSpinner ? (
              <div className="flex items-center justify-center py-16 gap-2 text-[12px] text-[color:var(--ink-soft)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>读取表格首片…</span>
              </div>
            ) : parsedTable && parsedTable.headers.length > 0 ? (
              <table className="w-full border-collapse text-left text-[12px]">
                <thead className="sticky top-0 z-10 bg-[color:var(--depth-1-bg)] text-[color:var(--ink-strong)] shadow-[0_1px_0_var(--glass-hairline)]">
                  <tr>
                    <th className="w-11 px-2.5 py-2 text-right font-mono text-[11px] font-medium text-[color:var(--ink-soft)] border-r border-[color:var(--glass-hairline)] tabular-nums">
                      #
                    </th>
                    {Array.from({ length: parsedTable.columnCount }).map((_, cIdx) => (
                      <th
                        key={cIdx}
                        className="px-3 py-2 font-semibold whitespace-nowrap border-r border-[color:var(--glass-hairline)]"
                      >
                        {parsedTable.headers[cIdx] ?? `列 ${cIdx + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--glass-hairline)]">
                  {parsedTable.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="hover:bg-[color:var(--depth-0-base)]/70 transition-colors"
                    >
                      <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-[color:var(--ink-soft)] border-r border-[color:var(--glass-hairline)] tabular-nums">
                        {rIdx + 1}
                      </td>
                      {Array.from({ length: parsedTable.columnCount }).map((_, cIdx) => {
                        const cell = row[cIdx] ?? '';
                        const numeric = isNumericCell(cell);
                        return (
                          <td
                            key={cIdx}
                            className={`px-3 py-1.5 whitespace-nowrap max-w-[260px] truncate border-r border-[color:var(--glass-hairline)] text-[color:var(--ink-strong)] ${
                              numeric ? 'font-mono text-right tabular-nums' : ''
                            }`}
                            title={cell}
                          >
                            {cell}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex items-center justify-center py-16 text-[12px] text-[color:var(--ink-soft)]">
                当前表格内容为空
              </div>
            )}
          </div>
        </div>
      );
    }

    if (snapshotAvailable && isHtmlFormat && !htmlAsSource) {
      return (
        <div className="flex flex-col h-full min-h-[460px]" data-quick-preview-html="">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-[color:var(--glass-hairline)] bg-muted/50 text-[12px]">
            <div className="flex flex-wrap items-center gap-2 text-[color:var(--ink-soft)]">
              <ShieldCheck className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)] shrink-0" />
              <span className="font-medium text-[color:var(--ink-strong)]">HTML 沙盒渲染</span>
              <span className="font-mono text-[11px]">
                {!htmlAllowScripts
                  ? '纯静态'
                  : htmlAllowExternalHttps
                    ? '已放行 HTTPS'
                    : '离线隔离'}
              </span>
              {preparedHtml &&
                preparedHtml.features.externalUrls.length > 0 &&
                !htmlAllowExternalHttps && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setHtmlAllowExternalHttps(true)}
                    title={`已拦截 ${preparedHtml.features.externalUrls.length} 处外部资源，点击放行 HTTPS`}
                  >
                    <Globe className="w-3.5 h-3.5" />
                    <span>允许 HTTPS ({preparedHtml.features.externalUrls.length})</span>
                  </Button>
                )}
              {htmlAllowExternalHttps && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setHtmlAllowExternalHttps(false)}
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span>恢复离线</span>
                </Button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant={htmlAllowScripts ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setHtmlAllowScripts((v) => !v)}
                title="切换沙盒脚本执行（隔离不透明源，无法访问宿主）"
              >
                <span>{htmlAllowScripts ? '脚本：开' : '脚本：关'}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHtmlAsSource(true)}
                title="查看 HTML 文本源码"
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>HTML 源码</span>
              </Button>
              <span className="hidden sm:inline font-mono text-[11px] text-[color:var(--ink-soft)]">
                按 Enter 进完整阅读器
              </span>
            </div>
          </div>

          {(!preview && showSpinner) || fullHtmlLoading ? (
            <div className="flex-1 flex items-center justify-center py-16 gap-2 text-[12px] text-[color:var(--ink-soft)] bg-card min-h-[460px]">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>正在读取 HTML 快照并构建沙盒…</span>
            </div>
          ) : preparedHtml ? (
            <iframe
              key={`${resolvedRevisionId}:${htmlAllowScripts ? 'js' : 'static'}:${
                htmlAllowExternalHttps ? 'https' : 'offline'
              }`}
              title={`QuickLook HTML: ${displayTitle}`}
              sandbox={preparedHtml.sandboxAttr}
              srcDoc={preparedHtml.srcDoc}
              referrerPolicy="no-referrer"
              className="w-full flex-1 min-h-[460px] bg-white border-0"
            />
          ) : preview ? (
            <div className="flex-1 flex items-center justify-center py-16 text-[12px] text-[color:var(--ink-soft)] bg-card min-h-[460px]">
              {preview.truncated
                ? '完整 HTML 快照未能载入，可切换「HTML 源码」或按 Enter 进入完整阅读器查看'
                : 'HTML 文件为空'}
            </div>
          ) : (
            <div className="flex-1 min-h-[460px] bg-card" />
          )}
        </div>
      );
    }

    if (
      snapshotAvailable &&
      (effectiveKind === 'code' ||
        effectiveKind === 'markdown' ||
        effectiveKind === 'text' ||
        (effectiveKind === 'vector' && vectorAsSource) ||
        (effectiveKind === 'table' && tableAsSource))
    ) {
      return (
        <div className="flex flex-col h-full min-h-[420px]">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-[color:var(--glass-hairline)] bg-muted/50 text-[12px]">
            <div className="flex items-center gap-2 text-[color:var(--ink-soft)] font-mono tabular-nums">
              <Code2 className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)]" />
              <span>{uiMeta.label}</span>
              {preview && (
                <>
                  <span aria-hidden="true" className="opacity-40">
                    ·
                  </span>
                  <span>
                    已载 {formatByteSize(preview.slice_bytes)} / {formatByteSize(preview.total_bytes)}
                  </span>
                  <span aria-hidden="true" className="opacity-40">
                    ·
                  </span>
                  <span>{textLines.length} 行</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {effectiveKind === 'vector' && (
                <Button variant="ghost" size="sm" onClick={() => setVectorAsSource(false)}>
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>渲染预览</span>
                </Button>
              )}
              {effectiveKind === 'table' && (
                <Button variant="ghost" size="sm" onClick={() => setTableAsSource(false)}>
                  <Table2 className="w-3.5 h-3.5" />
                  <span>表格视图</span>
                </Button>
              )}
              {isHtmlFormat && (
                <Button variant="ghost" size="sm" onClick={() => setHtmlAsSource(false)}>
                  <Eye className="w-3.5 h-3.5" />
                  <span>页面渲染</span>
                </Button>
              )}
              {isJsonFormat && !preview?.truncated && combinedText && (
                <Button
                  variant={prettyJson ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setPrettyJson((v) => !v)}
                >
                  <span>{prettyJson ? '原始片段' : '格式化 JSON'}</span>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={!activeTextToDisplay}
                onClick={() => void handleCopySlice()}
              >
                {copiedSlice ? (
                  <Check className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedSlice ? '已复制' : '复制片段'}</span>
              </Button>
              {preview?.truncated && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void handleLoadNextSlice()}
                >
                  {loadingMore ? '加载中…' : '继续加载 (+64 KiB)'}
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto bg-[color:var(--paper-light)] px-3 py-3 min-h-[360px] max-h-[64vh] font-mono text-[12px] leading-[1.6]">
            {!preview && showSpinner ? (
              <div className="flex items-center justify-center py-16 gap-2 text-[color:var(--ink-soft)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>读取内容分片…</span>
              </div>
            ) : textLines.length > 0 ? (
              <div className="min-w-max">
                {textLines.map((line, idx) => {
                  const tokens = tokenizeCodeLine(line, formatToken);
                  return (
                    <div
                      key={idx}
                      className="flex gap-3 px-2 py-0.5 rounded hover:bg-[color:var(--depth-1-bg)]/60"
                    >
                      <span className="w-10 shrink-0 select-none text-right text-[11px] text-[color:var(--ink-soft)] opacity-70 tabular-nums">
                        {idx + 1}
                      </span>
                      <span className="whitespace-pre">
                        {tokens.map((tok, tIdx) => (
                          <span key={tIdx} className={TOKEN_CLASS[tok.kind]}>
                            {tok.text}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
                {preview?.truncated && (
                  <div className="mt-3 px-12 py-2 text-[11px] text-[color:var(--ink-soft)]">
                    仅展示前 {formatByteSize(preview.slice_bytes)} 切片（总长{' '}
                    {formatByteSize(preview.total_bytes)}），可点右上角继续加载或按 Enter 打开全文阅读。
                  </div>
                )}
              </div>
            ) : preview ? (
              <div className="py-12 text-center text-[color:var(--ink-soft)]">文件为空</div>
            ) : null}
          </div>
        </div>
      );
    }

    if (snapshotAvailable && effectiveKind === 'pdf') {
      const pdfSummary = preview?.pdf_summary;
      const scannedWhole =
        pdfSummary &&
        pdfSummary.status !== 'page_indexed' &&
        (pdfSummary.status === 'image_only' || pdfSummary.status === 'ocr_pending');
      return (
        <div className="flex flex-col h-full min-h-[460px]">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[color:var(--glass-hairline)] bg-muted/50 text-[12px] text-[color:var(--ink-soft)]">
            <span>PDF 版本快照直览（{formatByteSize(displaySize)}）</span>
            <span className="flex items-center gap-3">
              {pdfSummary?.status === 'page_indexed' && (
                <span className="font-mono text-[11px]">
                  L2 已索引 · 共 {pdfSummary.page_count} 页
                  {pdfSummary.image_only_page_count > 0
                    ? ` · 纯图像 ${pdfSummary.image_only_page_count} 页`
                    : ''}
                </span>
              )}
              {scannedWhole && (
                <span className="text-[color:var(--stage-ink-decision-text)]">
                  纯图像版 PDF，未做文本抽取
                </span>
              )}
              <span className="font-mono text-[11px]">按 Enter 进入完整版式阅读器</span>
            </span>
          </div>
          <iframe
            title={`QuickLook PDF: ${displayTitle}`}
            src={`${resolvedPdfUrl}#toolbar=0&navpanes=0&view=FitH`}
            className="w-full flex-1 min-h-[460px] bg-white"
          />
        </div>
      );
    }

    if (effectiveKind === 'office') {
      const summary = preview?.office_summary;
      const isIndexed = summary?.status === 'indexed';
      const isEncrypted = summary?.status === 'encrypted';
      const isCorrupted = summary?.status === 'corrupted';
      const isXlsx = (summary?.sheet_count ?? 0) > 0 || uiMeta.formatClass === 'spreadsheet';
      return (
        <div className="p-6 space-y-4 overflow-auto max-h-[68vh] min-h-[400px] bg-[color:var(--depth-0-base)]/40">
          <div className="rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] bg-card/85 p-4 flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {isXlsx ? (
                  <FileSpreadsheet className="w-4 h-4 text-[color:var(--stage-ink-deliver-text)] shrink-0" />
                ) : (
                  <BookOpen className="w-4 h-4 text-[color:var(--accent-iris-deep)] shrink-0" />
                )}
                <span className="text-[13px] font-semibold text-[color:var(--ink-strong)]">
                  {isXlsx ? 'Excel 工作簿结构化速览' : 'Word 文档结构化速览'}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${
                    isIndexed
                      ? 'bg-[color:var(--stage-ink-deliver)]/15 text-[color:var(--stage-ink-deliver-text)]'
                      : 'bg-[color:var(--stage-ink-decision)]/15 text-[color:var(--stage-ink-decision-text)]'
                  }`}
                >
                  {isIndexed
                    ? 'L2 已索引'
                    : isEncrypted
                      ? '已加密受保护'
                      : isCorrupted
                        ? '文档结构损坏'
                        : summary
                          ? 'L0 仅元数据'
                          : showSpinner
                            ? '读取摘要中…'
                            : '待打开结构视图'}
                </span>
              </div>
              {summary?.error_reason && (
                <p className="text-[12px] text-[color:var(--ink-soft)]">{summary.error_reason}</p>
              )}
            </div>
            {target && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  onClose();
                  onOpenFullReader(target.fileId, resolvedRevisionId || undefined);
                }}
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>打开完整{isXlsx ? '表格' : '文档'}视图 (Enter)</span>
              </Button>
            )}
          </div>

          {summary && isIndexed && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {isXlsx ? (
                  <>
                    <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
                      <div className="text-[11px] text-[color:var(--ink-soft)]">工作表数</div>
                      <div className="text-[14px] font-mono font-semibold text-[color:var(--ink-strong)] tabular-nums">
                        {summary.sheet_count} 张
                      </div>
                    </div>
                    <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1 col-span-3">
                      <div className="text-[11px] text-[color:var(--ink-soft)]">工作表与首表表头</div>
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {summary.sheet_names.map((name) => (
                          <span
                            key={name}
                            className="rounded bg-[color:var(--depth-1-bg)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--ink-strong)]"
                          >
                            {name}
                          </span>
                        ))}
                        {summary.headings_preview.map((h, i) => (
                          <span
                            key={`${h}-${i}`}
                            className="rounded border border-[color:var(--glass-hairline)] bg-muted/60 px-1.5 py-0.5 text-[11px] text-[color:var(--ink-soft)]"
                          >
                            {h}
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
                      <div className="text-[11px] text-[color:var(--ink-soft)]">章节标题</div>
                      <div className="text-[14px] font-mono font-semibold text-[color:var(--ink-strong)] tabular-nums">
                        {summary.heading_count}
                      </div>
                    </div>
                    <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
                      <div className="text-[11px] text-[color:var(--ink-soft)]">正文段落</div>
                      <div className="text-[14px] font-mono font-semibold text-[color:var(--ink-strong)] tabular-nums">
                        {summary.paragraph_count}
                      </div>
                    </div>
                    <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
                      <div className="text-[11px] text-[color:var(--ink-soft)]">审阅批注</div>
                      <div className="text-[14px] font-mono font-semibold text-[color:var(--ink-strong)] tabular-nums">
                        {summary.comment_count}
                      </div>
                    </div>
                    <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
                      <div className="text-[11px] text-[color:var(--ink-soft)]">修订痕迹</div>
                      <div className="text-[14px] font-mono font-semibold text-[color:var(--ink-strong)] tabular-nums">
                        +{summary.tracked_insertions} / -{summary.tracked_deletions}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {!isXlsx && summary.headings_preview.length > 0 && (
                <div className="rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] bg-card/85 p-3.5 space-y-2">
                  <div className="text-[11px] font-medium text-[color:var(--ink-soft)]">文档大纲摘要</div>
                  <div className="flex flex-wrap gap-1.5">
                    {summary.headings_preview.map((h, i) => (
                      <span
                        key={`${h}-${i}`}
                        className="rounded bg-[color:var(--depth-1-bg)] px-2 py-0.5 text-[11.5px] text-[color:var(--ink-strong)]"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {summary.text_preview && (
                <div className="rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] bg-card/85 p-4 space-y-2">
                  <div className="text-[11px] font-medium text-[color:var(--ink-soft)]">正文 / 数据片段速览</div>
                  <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-[color:var(--ink-strong)] max-h-[34vh] overflow-auto">
                    {summary.text_preview}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    const history = preview?.history ?? [];
    const maxHistSize = Math.max(1, ...history.map((h) => Math.max(0, h.size_bytes)));

    return (
      <div className="p-6 space-y-5 overflow-auto max-h-[68vh] min-h-[400px] bg-[color:var(--depth-0-base)]/40">
        <div className="rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] bg-card/85 p-4 flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2">
              <Binary className="w-4 h-4 text-[color:var(--accent-iris-deep)] shrink-0" />
              <span className="text-[13px] font-semibold text-[color:var(--ink-strong)]">
                {snapshotAvailable ? '二进制快照体检卡' : 'L0 仅元数据体检卡（免拷大文件字节）'}
              </span>
              <span className="rounded-full bg-[color:var(--depth-1-bg)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--ink-soft)]">
                {tierInfo.title}
              </span>
            </div>
            <p className="text-[12px] text-[color:var(--ink-soft)] leading-relaxed">
              {snapshotAvailable
                ? '该格式暂不按纯文本内联渲染；已保留去重快照身份、魔数头与历史体积轨迹。'
                : `${tierInfo.title}；观澜全程采用 64 KiB 恒定内存流式校验 SHA-256，绝不复制大文件字节撑爆本地存储。`}
            </p>
          </div>
          {systemActions?.desktopSystemSupported && systemActions.onOpenWithDefaultApp && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => systemActions.onOpenWithDefaultApp?.(displayPath)}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>用系统默认应用打开</span>
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
            <div className="text-[11px] text-[color:var(--ink-soft)]">当前体积</div>
            <div className="text-[14px] font-mono font-semibold text-[color:var(--ink-strong)] tabular-nums">
              {formatByteSize(displaySize)}
            </div>
            {preview && preview.size_min_bytes !== preview.size_max_bytes && (
              <div className="text-[11px] font-mono text-[color:var(--ink-soft)] tabular-nums">
                范围 {formatByteSize(preview.size_min_bytes)} ~ {formatByteSize(preview.size_max_bytes)}
              </div>
            )}
          </div>

          <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
            <div className="text-[11px] text-[color:var(--ink-soft)]">格式族 / MIME</div>
            <div className="text-[13px] font-semibold text-[color:var(--ink-strong)]">
              {uiMeta.classLabel} ({uiMeta.label})
            </div>
            <div className="text-[11px] font-mono text-[color:var(--ink-soft)] truncate" title={preview?.mime_type}>
              {preview?.mime_type || 'application/octet-stream'}
            </div>
          </div>

          <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
            <div className="text-[11px] text-[color:var(--ink-soft)]">历史版本数</div>
            <div className="text-[14px] font-mono font-semibold text-[color:var(--ink-strong)] tabular-nums">
              {preview?.revision_count ?? activeFile?.revisions.length ?? 1} 版
            </div>
            <div className="text-[11px] font-mono text-[color:var(--ink-soft)]">
              当前 v{displaySeq} · {observedAt ? formatRelativeObservedAt(observedAt) : '刚刚'}
            </div>
          </div>

          <div className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-card/80 p-3 space-y-1">
            <div className="text-[11px] text-[color:var(--ink-soft)]">魔数签名 / 快照状态</div>
            <div className="text-[12.5px] font-medium text-[color:var(--ink-strong)] truncate">
              {preview?.magic_signature || (snapshotAvailable ? '已存去重快照' : 'L0 仅记指纹')}
            </div>
            <div className="text-[11px] font-mono text-[color:var(--ink-soft)]">
              {snapshotAvailable ? 'snapshot_available = 1' : 'snapshot_available = 0'}
            </div>
          </div>
        </div>

        <div className="rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] bg-card/85 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--ink-strong)]">
              <Hash className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)]" />
              <span>SHA-256 内容指纹</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void handleCopyHash()}>
              {copiedHash ? (
                <Check className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)]" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{copiedHash ? '已复制哈希' : '复制哈希'}</span>
            </Button>
          </div>
          <div className="rounded-[var(--r-ctl)] bg-[color:var(--depth-0-base)] px-3 py-2 font-mono text-[11.5px] text-[color:var(--ink-strong)] break-all select-all">
            {displayHash || '未知'}
          </div>

          {preview?.header_hex && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[11px] font-medium text-[color:var(--ink-soft)]">
                前 {Math.min(64, Math.floor(preview.header_hex.split(/\s+/).length))} 字节十六进制头
              </div>
              <pre className="rounded-[var(--r-ctl)] bg-[color:var(--depth-0-base)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[color:var(--ink-soft)] overflow-x-auto">
                {preview.header_hex}
              </pre>
            </div>
          )}
        </div>

        <div className="rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] bg-card/85 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--ink-strong)]">
              <History className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)]" />
              <span>版本记录与体积演进</span>
            </div>
            <span className="font-mono text-[11px] text-[color:var(--ink-soft)] tabular-nums">
              展示最近 {history.length} 条
            </span>
          </div>

          {history.length === 0 ? (
            <div className="py-4 text-center text-[12px] text-[color:var(--ink-soft)]">
              {showSpinner ? '正在加载版本链…' : '暂无额外历史版本记录'}
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((item) => {
                const ratio = Math.max(4, Math.round((Math.max(0, item.size_bytes) / maxHistSize) * 100));
                const deltaText = formatDeltaBytes(item.delta_bytes);
                const deltaTone =
                  item.delta_bytes === null || item.delta_bytes === undefined
                    ? 'text-[color:var(--ink-soft)] bg-[color:var(--depth-1-bg)]'
                    : item.delta_bytes > 0
                      ? 'text-[color:var(--stage-ink-deliver-text)] bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_12%,transparent)]'
                      : item.delta_bytes < 0
                        ? 'text-[color:var(--stage-ink-exec-text)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_12%,transparent)]'
                        : 'text-[color:var(--ink-soft)] bg-[color:var(--depth-1-bg)]';

                return (
                  <div
                    key={item.revision_id}
                    className="rounded-[var(--r-ctl)] border border-[color:var(--glass-hairline)] bg-muted/45 px-3 py-2 space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <div className="flex items-center gap-2 font-mono tabular-nums">
                        <span className="font-semibold text-[color:var(--ink-strong)]">
                          v{item.seq}
                        </span>
                        <span className="text-[color:var(--ink-soft)]">
                          {formatByteSize(item.size_bytes)}
                        </span>
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${deltaTone}`}>
                          {deltaText}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-[11px] text-[color:var(--ink-soft)] tabular-nums">
                        <span>{item.content_hash.slice(0, 12)}</span>
                        <span aria-hidden="true" className="opacity-40">
                          ·
                        </span>
                        <span>
                          {(item.occurred_at || item.observed_at).slice(0, 16).replace('T', ' ')}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[color:var(--depth-1-bg)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[color:var(--accent-iris)] transition-all"
                        style={{ width: `${ratio}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`轻预览：${displayTitle}`}
      data-quick-preview-modal=""
      data-esc-layer="open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="glx-backdrop-in fixed inset-0 z-[85] flex items-center justify-center bg-[color:var(--ink-anchor)]/40 dark:bg-black/62 backdrop-blur-sm p-4 sm:p-6"
    >
      <div
        data-dialog-nested-stack=""
        style={{ '--nested-dialogs': 0 } as React.CSSProperties}
        className="glass-pop glx-popover-in w-full max-w-5xl max-h-[88vh] flex flex-col rounded-[var(--r-card)] overflow-hidden shadow-2xl border border-[color:var(--glass-hairline)]"
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[color:var(--glass-hairline)] bg-card/80 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`shrink-0 rounded-[var(--r-ctl)] px-2 py-0.5 font-mono text-[11px] font-medium ${uiMeta.badgeClass}`}
            >
              {uiMeta.label}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2
                  className="text-[14px] font-semibold text-[color:var(--ink-strong)] truncate"
                  title={displayPath || displayTitle}
                >
                  {displayTitle}
                </h2>
                <span className="shrink-0 rounded bg-[color:var(--depth-1-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--ink-soft)] tabular-nums">
                  v{displaySeq}
                </span>
                {showSpinner && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[color:var(--accent-iris-deep)] shrink-0" />
                )}
              </div>
              <div className="font-mono text-[11px] text-[color:var(--ink-soft)] truncate">
                {displayPath} · {formatByteSize(displaySize)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {queue.length > 1 && currentIndex >= 0 && (
              <div className="flex items-center gap-1 mr-1 rounded-[var(--r-ctl)] bg-[color:var(--depth-1-bg)] p-0.5">
                <IconButton
                  label="上一个文件 (↑)"
                  disabled={!canGoPrev}
                  onClick={() => stepQueue(-1)}
                  className="!size-6"
                >
                  <ArrowUp />
                </IconButton>
                <span className="px-1.5 font-mono text-[11px] text-[color:var(--ink-soft)] tabular-nums">
                  {currentIndex + 1} / {queue.length}
                </span>
                <IconButton
                  label="下一个文件 (↓)"
                  disabled={!canGoNext}
                  onClick={() => stepQueue(1)}
                  className="!size-6"
                >
                  <ArrowDown />
                </IconButton>
              </div>
            )}

            <IconButton
              label="关闭轻预览 (Space / Esc)"
              onClick={onClose}
              className="!size-7"
            >
              <X />
            </IconButton>
          </div>
        </header>

        <div
          key={`qp-nav-${navSeq}`}
          data-quick-preview-body=""
          className={
            navSeq > 0
              ? 'glx-fade-in flex-1 min-h-0 flex flex-col overflow-hidden'
              : 'flex-1 min-h-0 flex flex-col overflow-hidden'
          }
        >
          {renderBody()}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-[color:var(--glass-hairline)] bg-card/80 shrink-0 text-[12px]">
          <div className="flex items-center gap-3 text-[11px] text-[color:var(--ink-soft)] font-mono">
            <span className="inline-flex items-center gap-1">
              <Kbd>Space</Kbd> / Esc 关闭
            </span>
            {queue.length > 1 && (
              <span className="inline-flex items-center gap-1">
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> 切换文件
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> 打开阅读器
            </span>
          </div>

          {queueProgress && (
            <div
              data-quick-preview-queue-pill=""
              aria-label={`队列进度：第 ${queueProgress.position} 份，共 ${queueProgress.total} 份`}
              title={`${queueProgress.prevHint} · ${queueProgress.nextHint}`}
              className="hidden sm:flex min-w-0 max-w-[46ch] items-center gap-2 rounded-full bg-[color:var(--depth-1-bg)] px-2.5 py-1 text-[11px] text-[color:var(--ink-soft)]"
            >
              <span className="shrink-0 font-mono font-medium text-[color:var(--ink-strong)] tabular-nums">
                {queueProgress.progressLabel}
              </span>
              <span aria-hidden="true" className="shrink-0 opacity-45">
                ·
              </span>
              <span className="min-w-0 truncate" title={queueProgress.prevTitle ?? undefined}>
                {queueProgress.prevHint}
              </span>
              <span aria-hidden="true" className="shrink-0 opacity-45">
                ·
              </span>
              <span className="min-w-0 truncate" title={queueProgress.nextTitle ?? undefined}>
                {queueProgress.nextHint}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            {onAddEvidencePointer && activeFile && (
              <Button variant="ghost" size="sm" onClick={(ev) => void handleAddEvidence(ev)}>
                {copiedEvidence ? (
                  <Check className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)]" />
                ) : (
                  <Database className="w-3.5 h-3.5" />
                )}
                <span>{copiedEvidence ? '已加入上下文' : '加入上下文篮'}</span>
              </Button>
            )}
            {systemActions?.desktopSystemSupported && systemActions.onRevealInExplorer && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => systemActions.onRevealInExplorer?.(displayPath)}
              >
                <FolderSearch className="w-3.5 h-3.5" />
                <span>定位目录</span>
              </Button>
            )}
            {systemActions?.desktopSystemSupported && systemActions.onOpenWithDefaultApp && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => systemActions.onOpenWithDefaultApp?.(displayPath)}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>默认打开</span>
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onClose();
                onOpenFullReader(target.fileId, resolvedRevisionId || undefined);
              }}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>打开完整阅读</span>
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
};

function useMemoTextSlice(firstSlice: string | undefined, extraSlices: string[]): string | null {
  return useMemo(() => {
    if (firstSlice === undefined) return null;
    if (extraSlices.length === 0) return firstSlice;
    return [firstSlice, ...extraSlices].join('');
  }, [firstSlice, extraSlices]);
}


/** 「3 / 18」式进度文案；索引非法或队列为空返回空串（调用方据此不渲染胶囊）。 */
export function formatQuickQueueProgressLabel(index: number, total: number): string {
  if (
    !Number.isFinite(index) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    index < 0 ||
    index >= total
  ) {
    return '';
  }
  return `${index + 1} / ${total}`;
}

/** 队列相邻文档标题解析：title → relative_path → file_id 三级诚实回退；越界/null。 */
export function resolveQuickQueueNeighborTitles(
  queue: QuickPreviewTarget[],
  files: FileRecord[],
  currentIndex: number
): { prevTitle: string | null; nextTitle: string | null } {
  const fileById = new Map<string, FileRecord>();
  for (const f of files) fileById.set(f.file_id, f);
  const titleAt = (idx: number): string | null => {
    const item = queue[idx];
    if (!item) return null;
    const file = fileById.get(item.fileId);
    return file?.title || file?.relative_path || item.fileId;
  };
  return {
    prevTitle: currentIndex > 0 ? titleAt(currentIndex - 1) : null,
    nextTitle:
      currentIndex >= 0 && currentIndex < queue.length - 1 ? titleAt(currentIndex + 1) : null,
  };
}

export interface QuickQueueProgressInfo {
  position: number;
  total: number;
  progressLabel: string;
  prevTitle: string | null;
  nextTitle: string | null;
  prevHint: string;
  nextHint: string;
}

/**
 * 底栏队列进度胶囊派生：仅当队列 ≥ 2 份且索引合法时产出（单份/非法诚实回 null，
 * 调用方不渲染胶囊）；边界提示逐字锁定（「已是第一份」/「已是最后一份」）。
 */
export function buildQuickQueueProgress(
  queue: QuickPreviewTarget[],
  files: FileRecord[],
  currentIndex: number
): QuickQueueProgressInfo | null {
  if (!Array.isArray(queue) || queue.length <= 1) return null;
  if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= queue.length) {
    return null;
  }
  const progressLabel = formatQuickQueueProgressLabel(currentIndex, queue.length);
  if (!progressLabel) return null;
  const { prevTitle, nextTitle } = resolveQuickQueueNeighborTitles(queue, files, currentIndex);
  return {
    position: currentIndex + 1,
    total: queue.length,
    progressLabel,
    prevTitle,
    nextTitle,
    prevHint: prevTitle ? `← 上一份：${prevTitle}` : '已是第一份',
    nextHint: nextTitle ? `下一份：${nextTitle} →` : '已是最后一份',
  };
}

export { ChevronLeft, ChevronRight };
