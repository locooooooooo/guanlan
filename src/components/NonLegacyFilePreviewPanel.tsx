import React, { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Database,
  ExternalLink,
  FolderSearch,
  HardDrive,
  Loader2,
  ShieldAlert,
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
  formatUiMeta,
  isPreviewableHtmlFormat,
  isPreviewableImageFormat,
  isStructuredOfficeFormat,
  isUtf8TextFormat,
  snapshotTierDescription,
} from '../utils/formatMeta';

export interface NonLegacyFilePreviewPanelProps {
  activeFile: FileRecord;
  currentRev: Revision;
  paperLightMode: boolean;
  indexGeneration: number;
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

/** 易读字节数格式化 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

const MAX_INLINE_TEXT_CHARS = 120_000;

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

  useEffect(() => {
    setImageFailed(false);
    setTextError(null);
    setCopiedEvidence(false);
    setCopiedText(false);
    setCopiedSha(false);
    setMetaExpanded(false);
    setHtmlFullWidth(false);
    setHtmlExcerpt(null);

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
  const versionDateLabel = `v${currentRev.versionNumber} · ${currentRev.observed_at.slice(0, 10)}`;

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
        <div className={`text-[11px] ${mutedCls}`}>版本 / 观测日期</div>
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

  // 极轻状态条：文本/图像模式沉底作为 28px 底部脚标（让正文顶格首屏直出，消除顶部第三层工具条），
  // HTML/Office 模式保留为简洁单行条；重复的系统打开/定位操作收进「详情」或文件头 ··· 菜单。
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

  // ── 文本 / 源码模式：正文顶格首屏呈现（无顶部重复工具条），快捷复制/入篮轻浮右上角，技术元数据沉底 ──
  if (mode === 'text') {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden px-4 py-2">
        <div
          className={`max-w-[1280px] mx-auto w-full flex-1 min-h-0 flex flex-col rounded-xl border overflow-hidden ${cardCls}`}
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
              {renderFloatingQuickActions()}
              <pre className="flex-1 min-h-0 px-4 py-3.5 overflow-auto font-mono text-[13px] leading-[1.65] whitespace-pre">
                <code>{displaySlice}</code>
              </pre>
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

  // ── 图片模式：图像顶格满高画布，技术元数据沉底 ──
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

  // ── HTML / Office 模式：主内容直出首屏，技术元数据条沉底（消除顶部双层工具条叠加） ──
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

  // ── L0 仅元数据模式（无内联正文可展示时，元数据即为主要内容，默认完整展开） ──
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
