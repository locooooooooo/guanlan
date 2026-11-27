import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCopy,
  Copy,
  Database,
  ExternalLink,
  FolderSearch,
  HardDrive,
  ListTree,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import type {
  EvidencePointer,
  FileRecord,
  OfficeEvidenceAnchor,
  Revision,
} from '../types/guanlan';
import { fetchRevisionContent, revisionRawUrl } from '../services/workspaceClient';
import { copyTextWithDesktopFallback } from '../services/desktopBridge';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import { HtmlReaderView } from './HtmlReaderView';
import { OfficeReaderView } from './OfficeReaderView';
import {
  formatByteSize,
  formatClassOf,
  formatUiMeta,
  isPreviewableHtmlFormat,
  isPreviewableImageFormat,
  isStructuredOfficeFormat,
  isUtf8TextFormat,
  snapshotTierDescription,
} from '../utils/formatMeta';
import {
  computeFoldableRanges,
  extractCodeSymbols,
  findCodeMatches,
  tokenizeCodeLines,
  type CodeSearchMatch,
  type CodeTokenKind,
} from '../utils/codeSyntax';
import { localDay } from '../utils/timeFormat';

export { formatByteSize };

export interface NonLegacyFilePreviewPanelProps {
  activeFile: FileRecord;
  currentRev: Revision;
  paperLightMode: boolean;
  indexGeneration: number;
  sourceLine?: number;
  officeAnchor?: OfficeEvidenceAnchor | null;
  systemActions?: DesktopFileActionCallbacks;
  onAddEvidencePointer?: (pointer: EvidencePointer) => void | Promise<boolean> | boolean;
  workspaceFiles?: readonly FileRecord[];
}

export type NonLegacyPreviewMode = 'image' | 'html' | 'text' | 'office' | 'metadata_only';

/** 按格式与快照可用性确定 L0/L1/L2 预览模式（与后端三档快照策略对齐） */
export function resolveNonLegacyPreviewMode(
  format: string,
  snapshotAvailable: boolean
): NonLegacyPreviewMode {
  if (!snapshotAvailable) return 'metadata_only';
  if (isPreviewableImageFormat(format)) return 'image';
  if (isPreviewableHtmlFormat(format)) return 'html';
  if (isStructuredOfficeFormat(format)) return 'office';
  if (isUtf8TextFormat(format)) return 'text';
  return 'metadata_only';
}

const MAX_INLINE_TEXT_CHARS = 120_000;

const TOKEN_CLS_LIGHT: Record<CodeTokenKind, string> = {
  plain: 'text-[#26243D]',
  keyword: 'text-[#7A3E9D] font-medium',
  string: 'text-[#1E6F50]',
  comment: 'text-[#7A776F] italic',
  number: 'text-[#B45309]',
  type: 'text-[#0B6E8C]',
  attr: 'text-[#9A5B13]',
  punct: 'text-[#6A6778]',
};

const TOKEN_CLS_DARK: Record<CodeTokenKind, string> = {
  plain: 'text-[#E6E5E0]',
  keyword: 'text-[#C792EA] font-medium',
  string: 'text-[#8FD19E]',
  comment: 'text-[#7D8291] italic',
  number: 'text-[#F6B978]',
  type: 'text-[#72D0EB]',
  attr: 'text-[#E5C07B]',
  punct: 'text-[#9A9BA8]',
};

function renderHighlightedLineTokens(
  tokens: ReadonlyArray<{ text: string; kind: CodeTokenKind }>,
  lineMatches: readonly CodeSearchMatch[],
  activeMatch: CodeSearchMatch | null,
  tokenPalette: Record<CodeTokenKind, string>
): React.ReactNode {
  if (tokens.length === 0) return '\u00A0';
  if (lineMatches.length === 0) {
    return tokens.map((tok, i) => (
      <span key={i} data-token-kind={tok.kind} className={tokenPalette[tok.kind]}>
        {tok.text}
      </span>
    ));
  }

  const out: React.ReactNode[] = [];
  let offset = 0;
  let mIdx = 0;
  tokens.forEach((tok, tIdx) => {
    const tStart = offset;
    const tEnd = offset + tok.text.length;
    offset = tEnd;
    let cursor = tStart;
    while (mIdx < lineMatches.length && lineMatches[mIdx].end <= tStart) mIdx += 1;
    let probe = mIdx;
    while (probe < lineMatches.length && lineMatches[probe].start < tEnd) {
      const m = lineMatches[probe];
      const hitStart = Math.max(tStart, m.start);
      const hitEnd = Math.min(tEnd, m.end);
      if (hitStart > cursor) {
        out.push(
          <span
            key={`${tIdx}-${cursor}`}
            data-token-kind={tok.kind}
            className={tokenPalette[tok.kind]}
          >
            {tok.text.slice(cursor - tStart, hitStart - tStart)}
          </span>
        );
      }
      const isActive =
        activeMatch !== null &&
        activeMatch.line === m.line &&
        activeMatch.start === m.start &&
        activeMatch.end === m.end;
      out.push(
        <mark
          key={`${tIdx}-m-${hitStart}`}
          data-code-search-hit={isActive ? 'active' : 'true'}
          className={`rounded-[2px] px-0.5 ${
            isActive
              ? 'bg-[#F59E0B]/45 text-inherit ring-1 ring-[#F59E0B]'
              : 'bg-[#F59E0B]/22 text-inherit'
          }`}
        >
          {tok.text.slice(hitStart - tStart, hitEnd - tStart)}
        </mark>
      );
      cursor = hitEnd;
      if (m.end <= tEnd) {
        probe += 1;
      } else {
        break;
      }
    }
    if (cursor < tEnd) {
      out.push(
        <span
          key={`${tIdx}-tail`}
          data-token-kind={tok.kind}
          className={tokenPalette[tok.kind]}
        >
          {tok.text.slice(cursor - tStart)}
        </span>
      );
    }
  });
  return out;
}

/**
 * 非 MD/SVG/PDF 文件的 L0/L1 原位预览面板（全格式可见，绝不将大二进制读入内存）。
 * - 第一档 UTF-8 文本 / 源码 / 配置 / CSV：拉取受配额保护的去重快照正文并展示截断保护代码/文本视口；
 * - 第二档可浏览位图（PNG/JPG/WEBP/GIF/AVIF 等）：直接流式挂载 <img src="/api/v1/revisions/.../raw" />；
 * - 第三档或超出配额（snapshotAvailable=false）：诚实呈现 L0 元数据卡片（路径 / SHA-256 / 尺寸 / 策略说明），支持系统默认应用直开。
 */
export const NonLegacyFilePreviewPanel: React.FC<NonLegacyFilePreviewPanelProps> = ({
  activeFile,
  currentRev,
  paperLightMode,
  indexGeneration,
  sourceLine,
  officeAnchor,
  systemActions,
  onAddEvidencePointer,
  workspaceFiles,
}) => {
  const uiMeta = formatUiMeta(activeFile.format);
  const tierInfo = snapshotTierDescription(activeFile.format);
  const mode = resolveNonLegacyPreviewMode(activeFile.format, currentRev.snapshotAvailable);

  const [textBody, setTextBody] = useState<string | null>(
    mode === 'text' && currentRev.markdownContent !== undefined
      ? currentRev.markdownContent
      : null
  );
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageRetrySeq, setImageRetrySeq] = useState(0);
  const [copiedEvidence, setCopiedEvidence] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedSha, setCopiedSha] = useState(false);
  const [metaExpanded, setMetaExpanded] = useState(false);
  const [htmlFullWidth, setHtmlFullWidth] = useState(false);
  const [htmlExcerpt, setHtmlExcerpt] = useState<string | null>(null);
  const [codeFullWidth, setCodeFullWidth] = useState(() => formatClassOf(activeFile.format) === 'code');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [foldedStarts, setFoldedStarts] = useState<Set<number>>(() => new Set());
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findActiveIdx, setFindActiveIdx] = useState(0);
  const [selectedCodeLine, setSelectedCodeLine] = useState<number | null>(sourceLine ?? null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const codeScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setImageFailed(false);
    setTextError(null);
    setCopiedEvidence(false);
    setCopiedText(false);
    setCopiedSha(false);
    setMetaExpanded(false);
    setHtmlFullWidth(false);
    setHtmlExcerpt(null);
    setCodeFullWidth(formatClassOf(activeFile.format) === 'code');
    setFoldedStarts(new Set());
    setFindOpen(false);
    setFindQuery('');
    setFindActiveIdx(0);
    setSelectedCodeLine(sourceLine ?? null);

    if (mode !== 'text') {
      setTextBody(null);
      setTextLoading(false);
      return;
    }

    if (currentRev.markdownContent !== undefined) {
      setTextBody(currentRev.markdownContent);
      setTextLoading(false);
      return;
    }

    let cancelled = false;
    setTextLoading(true);
    setTextBody(null);
    fetchRevisionContent(currentRev.revision_id).then((res) => {
      if (cancelled) return;
      setTextLoading(false);
      if (res.ok && typeof res.text === 'string') {
        setTextBody(res.text);
        setTextError(null);
      } else {
        setTextError(res.error || '未能读取文本快照');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [mode, currentRev.revision_id, currentRev.markdownContent]);

  const rawUrl = currentRev.snapshotAvailable ? revisionRawUrl(currentRev.revision_id) : '';

  useEffect(() => {
    setImageFailed(false);
  }, [rawUrl]);

  const cardCls = paperLightMode
    ? 'bg-white border-[#E5E3DD] text-[#26243D]'
    : 'bg-[#1D1D20] border-[#2C2C30] text-[#E6E5E0]';
  const barBgCls = paperLightMode
    ? 'border-[#ECEAE4] bg-[#FAF9F5]'
    : 'border-[#2C2C30] bg-[#18181B]';
  const borderCls = paperLightMode ? 'border-[#ECEAE4]' : 'border-[#2C2C30]';
  const mutedCls = paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]';
  const chipBgCls = paperLightMode ? 'bg-[#F5F4EF] border-[#E5E3DD]' : 'bg-[#252529] border-[#343439]';
  const actionBtnCls = `inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11.5px] font-medium cursor-pointer transition-colors hover:border-[color:var(--accent-iris)] ${chipBgCls}`;
  const snapshotBadgeCls = currentRev.snapshotAvailable
    ? paperLightMode
      ? 'border-[#2E8B57]/40 bg-[#2E8B57]/10 text-[#226B42]'
      : 'border-[#4ADE80]/35 bg-[#4ADE80]/12 text-[#86EFAC]'
    : paperLightMode
      ? 'border-[#D99B52]/45 bg-[#D99B52]/10 text-[#A8762B]'
      : 'border-[#F3C46C]/40 bg-[#F3C46C]/12 text-[#F3C46C]';

  const handleAddPointer = async () => {
    if (!onAddEvidencePointer) return;
    const excerpt =
      mode === 'text' && textBody
        ? textBody.slice(0, 600)
        : mode === 'html' && htmlExcerpt
          ? htmlExcerpt.slice(0, 600)
          : '';
    const result = await onAddEvidencePointer({
      file_id: activeFile.file_id,
      revision_id: currentRev.revision_id,
      relative_path: activeFile.relative_path,
      content_sha256: currentRev.content_sha256,
      locator: { kind: 'file' },
      evidence_kind: currentRev.snapshotAvailable ? 'explicit_source' : 'metadata_only',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: activeFile.coverage,
      stale: false,
      excerpt,
      note: currentRev.snapshotAvailable
        ? `${uiMeta.label} (${uiMeta.classLabel}) · ${formatByteSize(currentRev.sizeBytes)}`
        : `L0 仅元数据入库 (${tierInfo.title})`,
      sizeBytes: currentRev.sizeBytes,
    });
    if (result !== false) {
      setCopiedEvidence(true);
      window.setTimeout(() => setCopiedEvidence(false), 1800);
    }
  };

  const handleCopyText = async () => {
    if (!textBody) return;
    const res = await copyTextWithDesktopFallback(textBody);
    if (res.ok) {
      setCopiedText(true);
      window.setTimeout(() => setCopiedText(false), 1600);
    }
  };

  const handleCopySha = async () => {
    const res = await copyTextWithDesktopFallback(currentRev.content_sha256);
    if (res.ok) {
      setCopiedSha(true);
      window.setTimeout(() => setCopiedSha(false), 1600);
    }
  };

  const displaySlice =
    textBody !== null && textBody.length > MAX_INLINE_TEXT_CHARS
      ? textBody.slice(0, MAX_INLINE_TEXT_CHARS)
      : textBody;
  const isTruncated = textBody !== null && textBody.length > MAX_INLINE_TEXT_CHARS;
  const textLineCount = textBody !== null ? textBody.split('\n').length : null;
  const tokenizedLines = useMemo(
    () => (mode === 'text' && displaySlice !== null ? tokenizeCodeLines(displaySlice, activeFile.format) : []),
    [mode, displaySlice, activeFile.format]
  );
  const codeSymbols = useMemo(
    () => (mode === 'text' && displaySlice !== null ? extractCodeSymbols(displaySlice, activeFile.format) : []),
    [mode, displaySlice, activeFile.format]
  );
  const foldableRanges = useMemo(
    () => (mode === 'text' && displaySlice !== null ? computeFoldableRanges(displaySlice, activeFile.format) : new Map<number, number>()),
    [mode, displaySlice, activeFile.format]
  );
  const searchMatches = useMemo(() => {
    if (!findOpen || !findQuery.trim() || tokenizedLines.length === 0) return [];
    return findCodeMatches(
      tokenizedLines.map((l) => l.raw),
      findQuery
    );
  }, [findOpen, findQuery, tokenizedLines]);
  const matchesByLine = useMemo(() => {
    const map = new Map<number, CodeSearchMatch[]>();
    for (const m of searchMatches) {
      const bucket = map.get(m.line);
      if (bucket) bucket.push(m);
      else map.set(m.line, [m]);
    }
    return map;
  }, [searchMatches]);
  const clampedFindIdx = searchMatches.length > 0 ? Math.min(findActiveIdx, searchMatches.length - 1) : 0;
  const activeSearchMatch = searchMatches[clampedFindIdx] ?? null;

  const jumpToCodeLine = (lineNum: number) => {
    setSelectedCodeLine(lineNum);
    setFoldedStarts((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const start of prev) {
        const end = foldableRanges.get(start);
        if (end && lineNum > start && lineNum <= end) {
          next.delete(start);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    const el = codeScrollRef.current?.querySelector(`[data-code-line-number="${lineNum}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center' });
  };

  useEffect(() => {
    if (sourceLine && mode === 'text' && tokenizedLines.length > 0) {
      jumpToCodeLine(sourceLine);
    }
  }, [sourceLine, mode, tokenizedLines.length]);

  useEffect(() => {
    if (activeSearchMatch) {
      jumpToCodeLine(activeSearchMatch.line);
    }
  }, [activeSearchMatch?.line, activeSearchMatch?.start]);

  const observedDay = currentRev.observed_at ? localDay(currentRev.observed_at) : '';
  const versionDateLabel = observedDay
    ? `v${currentRev.versionNumber} · 入库于 ${observedDay}`
    : `v${currentRev.versionNumber}`;

  const renderFloatingQuickActions = () => {
    const hasPrimary =
      (mode === 'text' && textBody !== null) ||
      (mode === 'image' && Boolean(rawUrl) && !imageFailed);
    if (!hasPrimary && !onAddEvidencePointer) return null;
    const floatBtnCls = `inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-colors ${
      paperLightMode
        ? 'bg-white/90 text-[#26243D] border border-[#E5E3DD]/90 hover:border-[color:var(--accent-iris)] shadow-xs'
        : 'bg-[#1D1D20]/90 text-[#E6E5E0] border border-[#343439] hover:border-[color:var(--accent-iris)] shadow-xs'
    }`;
    return (
      <div
        data-preview-floating-actions=""
        className="absolute right-3 top-2.5 z-10 flex items-center gap-1.5 opacity-75 hover:opacity-100 focus-within:opacity-100 transition-opacity"
      >
        {mode === 'text' && textBody !== null && (
          <button
            type="button"
            onClick={() => void handleCopyText()}
            className={floatBtnCls}
            title="复制全文内容"
          >
            {copiedText ? <Check className="w-3 h-3 text-[#2E8B57]" /> : <Copy className="w-3 h-3" />}
            <span>{copiedText ? '已复制' : '复制'}</span>
          </button>
        )}
        {mode === 'image' && rawUrl && !imageFailed && (
          <a
            href={rawUrl}
            target="_blank"
            rel="noreferrer"
            className={floatBtnCls}
            title="在新窗口查看原图"
            aria-label="查看原图"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {onAddEvidencePointer && (
          <button
            type="button"
            onClick={handleAddPointer}
            className={floatBtnCls}
            title="将当前文件加入证据篮"
            aria-label={copiedEvidence ? '已入证据篮' : '加入证据篮'}
          >
            <ClipboardCopy className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  };

  const renderActionButtons = (includeSystemActions = true) => (
    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
      {includeSystemActions && mode === 'text' && textBody !== null && (
        <button
          type="button"
          onClick={() => void handleCopyText()}
          className={actionBtnCls}
          title="复制全文内容"
        >
          {copiedText ? <Check className="w-3 h-3 text-[#2E8B57]" /> : <Copy className="w-3 h-3" />}
          <span>{copiedText ? '已复制' : '复制'}</span>
        </button>
      )}
      {includeSystemActions && mode === 'image' && rawUrl && !imageFailed && (
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          className={actionBtnCls}
          title="在新窗口查看原图"
        >
          <ExternalLink className="w-3 h-3" />
          <span>查看原图</span>
        </a>
      )}
      {includeSystemActions && systemActions?.onOpenWithDefaultApp && (
        <button
          type="button"
          onClick={() => systemActions.onOpenWithDefaultApp?.(activeFile.relative_path)}
          className={actionBtnCls}
        >
          <ExternalLink className="w-3 h-3" />
          <span>默认应用打开</span>
        </button>
      )}
      {includeSystemActions && systemActions?.onRevealInExplorer && (
        <button
          type="button"
          onClick={() => systemActions.onRevealInExplorer?.(activeFile.relative_path)}
          className={actionBtnCls}
        >
          <FolderSearch className="w-3 h-3" />
          <span>在目录中定位</span>
        </button>
      )}
      {(includeSystemActions || mode === 'html') && onAddEvidencePointer && (
        <button
          type="button"
          onClick={handleAddPointer}
          className={actionBtnCls}
        >
          <ClipboardCopy className="w-3 h-3" />
          <span>{copiedEvidence ? '已入证据篮' : '加入证据篮'}</span>
        </button>
      )}
      {mode !== 'metadata_only' && (
        <button
          type="button"
          data-preview-meta-toggle=""
          aria-expanded={metaExpanded}
          onClick={() => setMetaExpanded((v) => !v)}
          title={metaExpanded ? '收起技术元数据与快照策略' : '展开完整路径、SHA-256 指纹与快照策略'}
          className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer transition-colors hover:text-[color:var(--accent-iris-deep)] ${
            metaExpanded ? 'text-[color:var(--accent-iris-deep)] font-medium' : mutedCls
          }`}
        >
          <span>详情</span>
          {metaExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>
      )}
    </div>
  );

  const renderMetadataGrid = (compact = false, borderSide: 'top' | 'bottom' = 'bottom') => (
    <div
      data-preview-meta-drawer=""
      className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-x-4 gap-y-2 text-xs ${
        compact
          ? `px-3.5 py-2.5 ${borderSide === 'top' ? 'border-t' : 'border-b'} ${borderCls} ${barBgCls}`
          : `pt-3 border-t ${borderCls}`
      }`}
    >
      <div className="sm:col-span-2 lg:col-span-5 min-w-0">
        <div className={`text-[11px] ${mutedCls}`}>相对路径</div>
        <div className="mt-0.5 font-mono text-[11.5px] break-all" title={activeFile.relative_path}>
          {activeFile.relative_path}
        </div>
      </div>
      <div className="lg:col-span-2 min-w-0">
        <div className={`text-[11px] ${mutedCls}`}>文件体积 / 类别</div>
        <div className="mt-0.5 font-mono text-[11.5px] tabular-nums">
          {formatByteSize(currentRev.sizeBytes)} · {uiMeta.classLabel}
        </div>
      </div>
      <div className="lg:col-span-3 min-w-0">
        <div className={`text-[11px] ${mutedCls}`}>内容指纹 (SHA-256)</div>
        <button
          type="button"
          onClick={() => void handleCopySha()}
          title={`点击复制完整 SHA-256: ${currentRev.content_sha256}`}
          className="mt-0.5 font-mono text-[11.5px] tabular-nums truncate max-w-full text-left underline decoration-dotted cursor-pointer"
        >
          {copiedSha ? '已复制完整指纹' : `${currentRev.content_sha256.slice(0, 16)}…`}
        </button>
      </div>
      <div className="lg:col-span-2 min-w-0">
        <div className={`text-[11px] ${mutedCls}`}>版本 / 入库日期</div>
        <div
          className="mt-0.5 font-mono text-[11.5px] tabular-nums truncate"
          title={`${currentRev.revision_id} · ${currentRev.observed_at}`}
        >
          {versionDateLabel}
        </div>
      </div>
      {compact && (
        <div className={`sm:col-span-2 lg:col-span-12 flex flex-wrap items-center justify-between gap-2 text-[11px] ${mutedCls}`}>
          <span>快照策略：{tierInfo.title}</span>
          {(systemActions?.onOpenWithDefaultApp || systemActions?.onRevealInExplorer) && (
            <div className="flex items-center gap-1.5">
              {systemActions?.onOpenWithDefaultApp && (
                <button
                  type="button"
                  onClick={() => systemActions.onOpenWithDefaultApp?.(activeFile.relative_path)}
                  className={actionBtnCls}
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>默认应用打开</span>
                </button>
              )}
              {systemActions?.onRevealInExplorer && (
                <button
                  type="button"
                  onClick={() => systemActions.onRevealInExplorer?.(activeFile.relative_path)}
                  className={actionBtnCls}
                >
                  <FolderSearch className="w-3 h-3" />
                  <span>在目录中定位</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderCompactHeaderBar = (
    edge: 'bottom' | 'top' | 'none',
    opts?: { includeSystemActions?: boolean }
  ) => (
    <div
      data-preview-compact-bar=""
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-1.5 text-[11px] shrink-0 ${
        edge === 'bottom'
          ? `border-b ${barBgCls}`
          : edge === 'top'
            ? `border-t ${barBgCls}`
            : ''
      }`}
    >
      <div className={`flex items-center gap-2 min-w-0 flex-1 ${paperLightMode ? '' : 'dark'}`}>
        {mode !== 'image' && (
          <span
            className={`inline-flex items-center px-1.5 py-px rounded font-mono text-[10.5px] font-semibold shrink-0 ${uiMeta.badgeClass}`}
          >
            {uiMeta.label}
          </span>
        )}
        {!currentRev.snapshotAvailable && (
          <span
            className={`text-[10.5px] px-1.5 py-px rounded border shrink-0 ${snapshotBadgeCls}`}
            title={tierInfo.title}
          >
            仅元数据
          </span>
        )}
        <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums shrink-0 ${mutedCls}`}>
          <span>{formatByteSize(currentRev.sizeBytes)}</span>
          {textLineCount !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{textLineCount} 行</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span title={`${currentRev.revision_id} · ${currentRev.observed_at}`}>{versionDateLabel}</span>
        </span>
      </div>

      {renderActionButtons(opts?.includeSystemActions ?? false)}
    </div>
  );

  if (mode === 'text') {
    const tokenPalette = paperLightMode ? TOKEN_CLS_LIGHT : TOKEN_CLS_DARK;
    const toolChipCls = `inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium cursor-pointer transition-colors ${chipBgCls} hover:border-[color:var(--accent-iris)]`;

    const hiddenRanges: Array<{ start: number; end: number }> = [];
    for (const start of foldedStarts) {
      const end = foldableRanges.get(start);
      if (end && end > start) hiddenRanges.push({ start, end });
    }
    const isLineHiddenByFold = (lineNum: number) =>
      hiddenRanges.some((r) => lineNum > r.start && lineNum <= r.end);

    return (
      <div
        className="flex-1 min-h-0 flex flex-col overflow-hidden px-4 py-2"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            e.stopPropagation();
            setFindOpen(true);
            requestAnimationFrame(() => findInputRef.current?.focus());
          }
        }}
      >
        <div
          data-code-wide-mode={codeFullWidth ? 'full' : 'contained'}
          className={`${codeFullWidth ? 'max-w-none' : 'max-w-[1280px]'} mx-auto w-full flex-1 min-h-0 flex flex-col rounded-xl border overflow-hidden ${cardCls}`}
        >
          {textLoading && (
            <div className={`flex-1 p-6 flex items-center gap-2 text-xs ${mutedCls}`}>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>正在从去重快照仓读取正文…</span>
            </div>
          )}
          {textError && !textLoading && (
            <div className={`flex-1 p-5 flex items-center gap-2 text-xs ${mutedCls}`}>
              <ShieldAlert className="w-4 h-4 text-[#D99B52] shrink-0" />
              <span>{textError}</span>
            </div>
          )}
          {displaySlice !== null && !textLoading && (
            <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
              <div
                data-preview-floating-actions=""
                className={`shrink-0 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b text-[11px] ${barBgCls}`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {codeSymbols.length > 0 && (
                    <button
                      type="button"
                      data-code-outline-toggle=""
                      aria-pressed={outlineOpen}
                      onClick={() => setOutlineOpen((v) => !v)}
                      title={outlineOpen ? '收起符号大纲' : `展开符号大纲（共 ${codeSymbols.length} 个符号）`}
                      className={`${toolChipCls} ${
                        outlineOpen ? 'border-[color:var(--accent-iris)] text-[color:var(--accent-iris-ink)]' : ''
                      }`}
                    >
                      <ListTree className="w-3 h-3" />
                      <span>大纲 ({codeSymbols.length})</span>
                    </button>
                  )}
                  <button
                    type="button"
                    data-code-find-toggle=""
                    aria-pressed={findOpen}
                    onClick={() => {
                      const next = !findOpen;
                      setFindOpen(next);
                      if (next) requestAnimationFrame(() => findInputRef.current?.focus());
                    }}
                    title="页内查找（快捷键 Ctrl+F）"
                    className={`${toolChipCls} ${
                      findOpen ? 'border-[color:var(--accent-iris)] text-[color:var(--accent-iris-ink)]' : ''
                    }`}
                  >
                    <Search className="w-3 h-3" />
                    <span>查找</span>
                  </button>
                  <button
                    type="button"
                    data-code-width-toggle=""
                    aria-pressed={codeFullWidth}
                    onClick={() => setCodeFullWidth((v) => !v)}
                    title={codeFullWidth ? '切换为居中 1280px 宽度' : '切换为宽版铺满视口'}
                    className={toolChipCls}
                  >
                    {codeFullWidth ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                    <span>{codeFullWidth ? '收窄' : '宽版'}</span>
                  </button>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {textBody !== null && (
                    <button
                      type="button"
                      onClick={() => void handleCopyText()}
                      className={toolChipCls}
                      title="复制全文内容"
                    >
                      {copiedText ? <Check className="w-3 h-3 text-[#2E8B57]" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedText ? '已复制' : '复制'}</span>
                    </button>
                  )}
                  {onAddEvidencePointer && (
                    <button
                      type="button"
                      onClick={handleAddPointer}
                      className={toolChipCls}
                      title="将当前文件加入证据篮"
                      aria-label={copiedEvidence ? '已入证据篮' : '加入证据篮'}
                    >
                      <ClipboardCopy className="w-3 h-3" />
                      <span>{copiedEvidence ? '已入篮' : '入篮'}</span>
                    </button>
                  )}
                </div>
              </div>

              {findOpen && (
                <div
                  data-code-find-bar=""
                  className={`shrink-0 flex items-center gap-2 px-3 py-1.5 border-b text-xs ${barBgCls}`}
                >
                  <Search className={`w-3.5 h-3.5 shrink-0 ${mutedCls}`} />
                  <input
                    ref={findInputRef}
                    type="text"
                    data-code-find-input=""
                    value={findQuery}
                    onChange={(e) => {
                      setFindQuery(e.target.value);
                      setFindActiveIdx(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setFindOpen(false);
                      } else if (e.key === 'Enter' && searchMatches.length > 0) {
                        e.preventDefault();
                        setFindActiveIdx((i) =>
                          e.shiftKey
                            ? (i - 1 + searchMatches.length) % searchMatches.length
                            : (i + 1) % searchMatches.length
                        );
                      }
                    }}
                    placeholder="在文件内查找…"
                    className={`flex-1 min-w-0 bg-transparent font-mono text-xs focus:outline-none ${
                      paperLightMode ? 'text-[#26243D]' : 'text-[#E6E5E0]'
                    }`}
                  />
                  <span className={`font-mono text-[11px] tabular-nums shrink-0 ${mutedCls}`}>
                    {findQuery.trim()
                      ? searchMatches.length > 0
                        ? `${clampedFindIdx + 1} / ${searchMatches.length}`
                        : '0 命中'
                      : '输入关键词'}
                  </span>
                  <button
                    type="button"
                    disabled={searchMatches.length === 0}
                    aria-label="上一个命中"
                    onClick={() =>
                      setFindActiveIdx((i) => (i - 1 + searchMatches.length) % searchMatches.length)
                    }
                    className={`${toolChipCls} disabled:opacity-40`}
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    disabled={searchMatches.length === 0}
                    aria-label="下一个命中"
                    onClick={() => setFindActiveIdx((i) => (i + 1) % searchMatches.length)}
                    className={`${toolChipCls} disabled:opacity-40`}
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    aria-label="关闭页内查找"
                    onClick={() => setFindOpen(false)}
                    className={`p-1 rounded cursor-pointer ${mutedCls}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <div className="flex-1 min-h-0 flex overflow-hidden">
                {outlineOpen && codeSymbols.length > 0 && (
                  <aside
                    aria-label="源码符号大纲"
                    data-code-outline-panel=""
                    className={`w-56 shrink-0 border-r overflow-y-auto p-2 space-y-0.5 ${borderCls} ${barBgCls}`}
                  >
                    <div className={`px-2 py-1 text-[10.5px] font-semibold ${mutedCls}`}>
                      符号大纲 ({codeSymbols.length})
                    </div>
                    {codeSymbols.map((sym) => (
                      <button
                        key={`${sym.line}-${sym.kind}-${sym.name}`}
                        type="button"
                        data-code-symbol-line={sym.line}
                        onClick={() => jumpToCodeLine(sym.line)}
                        title={`跳至 L${sym.line} · ${sym.kind} ${sym.name}`}
                        className={`w-full flex items-center justify-between gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] cursor-pointer transition-colors ${
                          selectedCodeLine === sym.line
                            ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] text-[color:var(--accent-iris-ink)] font-medium'
                            : `${mutedCls} hover:bg-[color:color-mix(in_srgb,var(--ink-strong)_5%,transparent)]`
                        }`}
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 rounded px-1 py-px font-mono text-[9.5px] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-deep)]">
                            {sym.kind}
                          </span>
                          <span className="truncate font-mono">{sym.name}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-70">
                          L{sym.line}
                        </span>
                      </button>
                    ))}
                  </aside>
                )}

                <div
                  ref={codeScrollRef}
                  role="region"
                  aria-label="源码与文本内容"
                  data-code-reader=""
                  className="flex-1 min-h-0 overflow-auto py-2.5 font-mono text-[13px] leading-[1.6]"
                >
                  {tokenizedLines.map((line) => {
                    if (isLineHiddenByFold(line.lineNumber)) return null;
                    const foldEnd = foldableRanges.get(line.lineNumber);
                    const isFolded = Boolean(foldEnd && foldedStarts.has(line.lineNumber));
                    const isAnchor = sourceLine === line.lineNumber;
                    const isSelected = selectedCodeLine === line.lineNumber && !isAnchor;
                    const lineMatches = matchesByLine.get(line.lineNumber) ?? [];
                    return (
                      <div
                        key={line.lineNumber}
                        data-code-line-number={line.lineNumber}
                        data-anchor-highlight={isAnchor ? 'true' : undefined}
                        data-code-anchor-line={isAnchor ? line.lineNumber : undefined}
                        className={`group flex items-start px-2 min-w-max border-l-[3px] ${
                          isAnchor
                            ? 'border-l-[color:var(--accent-iris-deep)] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)]'
                            : isSelected
                              ? 'border-l-[color:var(--ink-faint)] bg-[color:color-mix(in_srgb,var(--ink-strong)_4%,transparent)]'
                              : 'border-l-transparent hover:bg-[color:color-mix(in_srgb,var(--ink-strong)_3%,transparent)]'
                        }`}
                      >
                        <span className="w-5 shrink-0 flex items-center justify-center pt-0.5 select-none">
                          {foldEnd ? (
                            <button
                              type="button"
                              data-code-fold-toggle={line.lineNumber}
                              aria-label={isFolded ? `展开第 ${line.lineNumber} 行代码块` : `折叠第 ${line.lineNumber} 行代码块`}
                              aria-expanded={!isFolded}
                              onClick={() =>
                                setFoldedStarts((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(line.lineNumber)) next.delete(line.lineNumber);
                                  else next.add(line.lineNumber);
                                  return next;
                                })
                              }
                              className={`w-4 h-4 rounded flex items-center justify-center cursor-pointer ${mutedCls} hover:text-[color:var(--accent-iris-deep)]`}
                            >
                              {isFolded ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </button>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedCodeLine(line.lineNumber)}
                          className={`w-11 pr-3 text-right shrink-0 select-none tabular-nums text-[11.5px] cursor-pointer ${
                            isAnchor
                              ? 'font-semibold text-[color:var(--accent-iris-deep)]'
                              : `${mutedCls} opacity-65 group-hover:opacity-100`
                          }`}
                        >
                          {line.lineNumber}
                        </button>
                        <code className="flex-1 whitespace-pre pr-4">
                          {renderHighlightedLineTokens(
                            line.tokens,
                            lineMatches,
                            activeSearchMatch,
                            tokenPalette
                          )}
                          {isFolded && foldEnd && (
                            <button
                              type="button"
                              data-code-folded-range={`${line.lineNumber}-${foldEnd}`}
                              onClick={() =>
                                setFoldedStarts((prev) => {
                                  const next = new Set(prev);
                                  next.delete(line.lineNumber);
                                  return next;
                                })
                              }
                              className="ml-2 inline-flex items-center rounded px-1.5 py-px text-[10.5px] bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] text-[color:var(--accent-iris-ink)] cursor-pointer"
                            >
                              … 已折叠 {foldEnd - line.lineNumber} 行
                            </button>
                          )}
                        </code>
                        {isAnchor && (
                          <span className="shrink-0 self-center mr-2 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_16%,transparent)] px-1.5 py-px font-sans text-[10px] font-medium text-[color:var(--accent-iris-ink)]">
                            引用锚点
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              {isTruncated && (
                <div className={`px-4 py-1.5 text-xs border-t shrink-0 ${mutedCls} ${borderCls}`}>
                  正文较长，已截断前 {MAX_INLINE_TEXT_CHARS.toLocaleString()} 字符显示以保证流畅度；完整文件可通过「默认应用打开」。
                </div>
              )}
            </div>
          )}
          {metaExpanded && renderMetadataGrid(true, 'top')}
          {renderCompactHeaderBar('top')}
        </div>
      </div>
    );
  }

  if (mode === 'image') {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden px-4 py-2">
        <div
          className={`max-w-[1280px] mx-auto w-full flex-1 min-h-0 flex flex-col rounded-xl border overflow-hidden ${cardCls}`}
        >
          <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
            {renderFloatingQuickActions()}
            {rawUrl && !imageFailed ? (
              <div className={`flex-1 min-h-0 flex items-center justify-center p-4 overflow-auto ${paperLightMode ? 'bg-[#F8F7F3]' : 'bg-[#151518]'}`}>
                <img
                  key={`${rawUrl}#${imageRetrySeq}`}
                  src={rawUrl}
                  alt={activeFile.title}
                  onError={() => setImageFailed(true)}
                  className="max-w-full max-h-full object-contain rounded"
                />
              </div>
            ) : (
              <div className="flex-1 p-6 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-3 min-w-0">
                  <ShieldAlert className="w-4 h-4 text-[#D99B52] shrink-0" />
                  <span className={mutedCls}>
                    该图片快照未能被浏览器直接解码，可点击重试或通过「详情 → 默认应用打开」调用系统看图程序查看。
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setImageFailed(false);
                    setImageRetrySeq((seq) => seq + 1);
                  }}
                  className={actionBtnCls}
                >
                  <span>重新加载</span>
                </button>
              </div>
            )}
          </div>
          {metaExpanded && renderMetadataGrid(true, 'top')}
          {renderCompactHeaderBar('top')}
        </div>
      </div>
    );
  }

  if (mode === 'html' || mode === 'office') {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
        <div
          className={`${
            mode === 'html' && htmlFullWidth ? 'max-w-none' : 'max-w-6xl'
          } mx-auto w-full space-y-2.5`}
        >
          {mode === 'html' && (
            <HtmlReaderView
              activeFile={activeFile}
              currentRev={currentRev}
              paperLightMode={paperLightMode}
              workspaceFiles={workspaceFiles}
              systemActions={systemActions}
              fullWidth={htmlFullWidth}
              onToggleFullWidth={() => setHtmlFullWidth((v) => !v)}
              onContentLoaded={setHtmlExcerpt}
            />
          )}

          {mode === 'office' && (
            <OfficeReaderView
              activeFile={activeFile}
              currentRev={currentRev}
              paperLightMode={paperLightMode}
              indexGeneration={indexGeneration}
              officeAnchor={officeAnchor}
              systemActions={systemActions}
              onAddEvidencePointer={onAddEvidencePointer}
            />
          )}

          <div className={`rounded-xl border overflow-hidden ${cardCls}`}>
            {metaExpanded && renderMetadataGrid(true, 'bottom')}
            {renderCompactHeaderBar('none', { includeSystemActions: false })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        <div className={`rounded-xl border p-5 space-y-4 ${cardCls}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5 min-w-0">
              <div className={`flex flex-wrap items-center gap-2 ${paperLightMode ? '' : 'dark'}`}>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-md font-mono text-[11px] font-semibold ${uiMeta.badgeClass}`}>
                  {uiMeta.label}
                </span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-md border ${chipBgCls}`}>
                  {uiMeta.classLabel}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-md border ${snapshotBadgeCls}`}>
                  {currentRev.snapshotAvailable ? '已保存去重快照' : 'L0 仅元数据入库'}
                </span>
              </div>
              <p className={`text-xs ${mutedCls}`} title={tierInfo.title}>
                {tierInfo.title}
              </p>
            </div>
            {renderActionButtons()}
          </div>
          {renderMetadataGrid(false)}
        </div>

        <div className={`rounded-xl border p-5 space-y-3 ${cardCls}`}>
          <div className="flex items-center gap-2 font-medium text-sm">
            {currentRev.snapshotAvailable ? (
              <Database className="w-4 h-4 text-[color:var(--accent-iris)]" />
            ) : (
              <HardDrive className="w-4 h-4 text-[#D99B52]" />
            )}
            <span>
              {currentRev.snapshotAvailable
                ? '已保全二进制快照（L0 元数据视图）'
                : 'L0 轻量入库模式 · 未复制文件字节进本地快照库'}
            </span>
          </div>
          <p className={`text-xs leading-relaxed ${mutedCls}`}>
            {currentRev.snapshotAvailable
              ? '该格式已完成身份登记与去重快照保全；暂不支持内联文本渲染，可通过下方链接或默认应用查看。'
              : `依据三档快照配额策略（${tierInfo.title}），系统已记录路径、大小与流式 SHA-256 指纹，不额外占用磁盘备份空间。`}
          </p>
          {rawUrl && (
            <div>
              <a
                href={rawUrl}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium hover:border-[color:var(--accent-iris)] ${chipBgCls}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>下载 / 在新标签打开原件</span>
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
