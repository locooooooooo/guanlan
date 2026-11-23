import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import type { FileRecord, Revision } from '../types/guanlan';
import { fetchRevisionContent, revisionRawUrl } from '../services/workspaceClient';
import { copyTextWithDesktopFallback } from '../services/desktopBridge';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import { formatByteSize } from './NonLegacyFilePreviewPanel';
import {
  buildHtmlSandboxDocument,
  collectLocalInlineAssetTargets,
} from '../utils/htmlPreview';

export interface HtmlReaderViewProps {
  activeFile: FileRecord;
  currentRev: Revision;
  paperLightMode: boolean;
  workspaceFiles?: readonly FileRecord[];
  systemActions?: DesktopFileActionCallbacks;
  fullWidth?: boolean;
  onToggleFullWidth?: () => void;
  onContentLoaded?: (text: string | null) => void;
}

const MAX_INLINE_SOURCE_CHARS = 160_000;

/**
 * HTML 隔离沙盒绘制与源码双视图独立子组件。
 *
 * 设计口径（与 OfficeReaderView / PdfReaderView 同级解耦）：
 * - 默认进入「页面渲染」视图，在无 `allow-same-origin` 的隔离 `<iframe sandbox srcDoc>` 中绘制；
 * - 默认注入离线 CSP，封锁外部网络与本地 127.0.0.1 API，保护桌面壳与工作区安全；
 * - 检测到外链 CDN（含 Three.js/ECharts importmap/ESM）时提供显式「允许 HTTPS 外链」开关，切文件自动复位；
 * - 一键切换「页面渲染 / HTML 源码」「脚本开/关」「桌面/移动端宽度」「全宽画布」与「重绘」。
 */
export const HtmlReaderView: React.FC<HtmlReaderViewProps> = ({
  activeFile,
  currentRev,
  paperLightMode,
  workspaceFiles,
  systemActions,
  fullWidth = false,
  onToggleFullWidth,
  onContentLoaded,
}) => {
  const [htmlBody, setHtmlBody] = useState<string | null>(
    currentRev.markdownContent !== undefined ? currentRev.markdownContent : null
  );
  const [loading, setLoading] = useState<boolean>(currentRev.markdownContent === undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inlinedAssets, setInlinedAssets] = useState<Record<string, string>>({});
  const [assetsLoading, setAssetsLoading] = useState(false);

  const [viewMode, setViewMode] = useState<'render' | 'source'>('render');
  const [allowScripts, setAllowScripts] = useState(true);
  const [allowExternalHttps, setAllowExternalHttps] = useState(false);
  const [viewportPreset, setViewportPreset] = useState<'desktop' | 'mobile'>('desktop');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [copiedSource, setCopiedSource] = useState(false);

  const isLatestRevision = currentRev.revision_id === activeFile.current_revision_id;
  const onContentLoadedRef = useRef(onContentLoaded);
  onContentLoadedRef.current = onContentLoaded;

  // 切文件 / 切版本时读取对应版本快照，并安全复位外链放行开关
  useEffect(() => {
    setLoadError(null);
    setAllowExternalHttps(false);
    setViewMode('render');
    setViewportPreset('desktop');
    setInlinedAssets({});
    setCopiedSource(false);

    if (currentRev.markdownContent !== undefined) {
      setHtmlBody(currentRev.markdownContent);
      setLoading(false);
      onContentLoadedRef.current?.(currentRev.markdownContent);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setHtmlBody(null);
    onContentLoadedRef.current?.(null);

    void fetchRevisionContent(currentRev.revision_id).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok && typeof res.text === 'string') {
        setHtmlBody(res.text);
        setLoadError(null);
        onContentLoadedRef.current?.(res.text);
      } else {
        setLoadError(res.error || '未能读取 HTML 快照正文');
        onContentLoadedRef.current?.(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentRev.revision_id, currentRev.markdownContent]);

  // 仅当前最新版本按需预取同工作区相对 CSS / 经典 JS，历史版本绝不混入当前磁盘文件
  const inlineTargets = useMemo(() => {
    if (!htmlBody || !isLatestRevision || !workspaceFiles || workspaceFiles.length === 0) {
      return [];
    }
    return collectLocalInlineAssetTargets(htmlBody, activeFile.relative_path, workspaceFiles);
  }, [htmlBody, isLatestRevision, activeFile.relative_path, workspaceFiles]);

  const inlineTargetsKey = useMemo(
    () => inlineTargets.map((t) => `${t.normalizedPath}@${t.revisionId}`).join('|'),
    [inlineTargets]
  );

  useEffect(() => {
    if (inlineTargets.length === 0) {
      setInlinedAssets({});
      setAssetsLoading(false);
      return;
    }
    let cancelled = false;
    setAssetsLoading(true);
    void Promise.all(
      inlineTargets.map(async (target) => {
        const res = await fetchRevisionContent(target.revisionId);
        return res.ok && typeof res.text === 'string'
          ? ([target.normalizedPath, res.text] as const)
          : null;
      })
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const pair of pairs) {
        if (pair) next[pair[0]] = pair[1];
      }
      setInlinedAssets(next);
      setAssetsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [inlineTargetsKey, inlineTargets]);

  const prepared = useMemo(() => {
    if (htmlBody === null) return null;
    return buildHtmlSandboxDocument(htmlBody, {
      allowScripts,
      allowExternalHttps,
      relativePath: isLatestRevision ? activeFile.relative_path : undefined,
      workspaceFiles: isLatestRevision ? workspaceFiles : undefined,
      resolveRevisionRawUrl: revisionRawUrl,
      inlinedAssets: isLatestRevision ? inlinedAssets : undefined,
    });
  }, [
    htmlBody,
    allowScripts,
    allowExternalHttps,
    isLatestRevision,
    activeFile.relative_path,
    workspaceFiles,
    inlinedAssets,
  ]);

  const cardCls = paperLightMode
    ? 'bg-white border-[#E5E3DD] text-[#26243D]'
    : 'bg-[#1D1D20] border-[#2C2C30] text-[#E6E5E0]';
  const barBgCls = paperLightMode
    ? 'border-[#ECEAE4] bg-[#FAF9F5]'
    : 'border-[#2C2C30] bg-[#18181B]';
  const mutedCls = paperLightMode ? 'text-[#6E6A61]' : 'text-[#A1A09A]';
  const btnCls = paperLightMode
    ? 'bg-white border-[#E5E3DD] text-[#26243D] hover:border-[color:var(--accent-iris)]'
    : 'bg-[#252529] border-[#343439] text-[#E6E5E0] hover:border-[color:var(--accent-iris)]';
  const activeTabCls = paperLightMode
    ? 'bg-[#EDE4D7] text-[#1F1E1D] font-semibold'
    : 'bg-[#2E2B27] text-[#D99B52] font-semibold';
  const inactiveTabCls = paperLightMode
    ? 'bg-white text-[#6E6A61] hover:text-[#1F1E1D]'
    : 'bg-[#232220] text-[#A1A09A] hover:text-[#F4F3EE]';

  const displaySource =
    htmlBody !== null && htmlBody.length > MAX_INLINE_SOURCE_CHARS
      ? htmlBody.slice(0, MAX_INLINE_SOURCE_CHARS)
      : htmlBody;
  const isSourceTruncated = htmlBody !== null && htmlBody.length > MAX_INLINE_SOURCE_CHARS;

  const handleCopySource = async () => {
    if (!htmlBody) return;
    const res = await copyTextWithDesktopFallback(htmlBody);
    if (res.ok) {
      setCopiedSource(true);
      window.setTimeout(() => setCopiedSource(false), 1600);
    }
  };

  return (
    <div className={`rounded-xl border overflow-hidden ${cardCls}`} data-html-reader="">
      {/* 顶部工具栏：页面渲染 / HTML 源码 + 沙盒安全开关 + 视口控制 */}
      <div className={`flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5 border-b text-xs ${barBgCls}`}>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={`inline-flex rounded-lg border overflow-hidden ${
              paperLightMode ? 'border-[#D8B79B]' : 'border-[#383633]'
            }`}
          >
            <button
              type="button"
              data-html-view-tab="render"
              aria-pressed={viewMode === 'render'}
              onClick={() => setViewMode('render')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 cursor-pointer transition-colors ${
                viewMode === 'render' ? activeTabCls : inactiveTabCls
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>页面渲染</span>
            </button>
            <button
              type="button"
              data-html-view-tab="source"
              aria-pressed={viewMode === 'source'}
              onClick={() => setViewMode('source')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 cursor-pointer transition-colors ${
                viewMode === 'source' ? activeTabCls : inactiveTabCls
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>HTML 源码</span>
            </button>
          </div>

          {viewMode === 'render' && (
            <>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] ${
                  allowExternalHttps
                    ? 'border-[#D99B52]/45 bg-[#D99B52]/10 text-[#A8762B]'
                    : 'border-[#2E8B57]/35 bg-[#2E8B57]/10 text-[#226B42]'
                }`}
                title="独立不透明沙盒源，与宿主完全隔离，无法访问主窗口、Tauri 桥、本地存储或本机 API"
              >
                <ShieldCheck className="w-3 h-3 shrink-0" />
                <span>
                  {!allowScripts
                    ? '纯静态隔离'
                    : allowExternalHttps
                      ? '沙盒 · 已放行 HTTPS'
                      : '离线沙盒隔离'}
                </span>
              </span>

              {prepared && prepared.features.externalUrls.length > 0 && !allowExternalHttps && (
                <button
                  type="button"
                  data-html-external-toggle=""
                  onClick={() => setAllowExternalHttps(true)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[#D99B52]/50 bg-[#D99B52]/12 text-[#A8762B] hover:bg-[#D99B52]/20 text-[11px] font-medium cursor-pointer transition-colors"
                  title={`已拦截外部资源：\n${prepared.features.externalUrls.slice(0, 5).join('\n')}`}
                >
                  <Globe className="w-3 h-3 shrink-0" />
                  <span>
                    已拦截 {prepared.features.externalUrls.length} 处外链 · 点击允许 HTTPS
                  </span>
                </button>
              )}

              {allowExternalHttps && (
                <button
                  type="button"
                  data-html-external-toggle=""
                  onClick={() => setAllowExternalHttps(false)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] cursor-pointer transition-colors ${btnCls}`}
                >
                  <Globe className="w-3 h-3 shrink-0" />
                  <span>恢复离线隔离</span>
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {viewMode === 'render' ? (
            <>
              <button
                type="button"
                data-html-script-toggle=""
                aria-pressed={allowScripts}
                onClick={() => setAllowScripts((v) => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] cursor-pointer transition-colors ${btnCls}`}
                title={
                  allowScripts
                    ? '当前允许在隔离沙盒内执行脚本（Canvas/WebGL/图表可绘制）；点击切换纯静态模式'
                    : '当前已禁用所有脚本；点击允许在隔离沙盒内运行脚本'
                }
              >
                <span>{allowScripts ? '脚本：开' : '脚本：关'}</span>
              </button>

              <div
                className={`inline-flex rounded-md border overflow-hidden ${
                  paperLightMode ? 'border-[#E5E3DD]' : 'border-[#343439]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setViewportPreset('desktop')}
                  title="桌面宽度"
                  aria-label="桌面宽度"
                  aria-pressed={viewportPreset === 'desktop'}
                  className={`px-2 py-1 cursor-pointer transition-colors ${
                    viewportPreset === 'desktop' ? activeTabCls : inactiveTabCls
                  }`}
                >
                  <Monitor className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewportPreset('mobile')}
                  title="移动端预览宽度 (390px)"
                  aria-label="移动端预览宽度"
                  aria-pressed={viewportPreset === 'mobile'}
                  className={`px-2 py-1 cursor-pointer transition-colors ${
                    viewportPreset === 'mobile' ? activeTabCls : inactiveTabCls
                  }`}
                >
                  <Smartphone className="w-3.5 h-3.5" />
                </button>
              </div>

              {onToggleFullWidth && (
                <button
                  type="button"
                  onClick={onToggleFullWidth}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] cursor-pointer transition-colors ${btnCls}`}
                  title={fullWidth ? '恢复居中宽度' : '全宽展开画布'}
                >
                  {fullWidth ? (
                    <Minimize2 className="w-3 h-3" />
                  ) : (
                    <Maximize2 className="w-3 h-3" />
                  )}
                  <span>{fullWidth ? '收窄' : '全宽'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setReloadNonce((n) => n + 1)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] cursor-pointer transition-colors ${btnCls}`}
                title="重新挂载沙盒页面以重绘动画或交互状态"
              >
                <RotateCw className="w-3 h-3" />
                <span>重绘</span>
              </button>
            </>
          ) : (
            <>
              {htmlBody !== null && (
                <span className={`font-mono tabular-nums ${mutedCls}`}>
                  {htmlBody.split('\n').length} 行 · {formatByteSize(htmlBody.length)}
                </span>
              )}
              <button
                type="button"
                disabled={!htmlBody}
                onClick={() => void handleCopySource()}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] cursor-pointer transition-colors disabled:opacity-50 ${btnCls}`}
              >
                {copiedSource ? (
                  <Check className="w-3 h-3 text-[#2E8B57]" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                <span>{copiedSource ? '已复制' : '复制源码'}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* 加载态 / 错误态 */}
      {loading && (
        <div className={`p-8 flex items-center justify-center gap-2 text-xs ${mutedCls}`}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>正在从去重快照仓读取 HTML 正文…</span>
        </div>
      )}

      {loadError && !loading && (
        <div className={`p-6 flex items-center gap-2.5 text-xs ${mutedCls}`}>
          <ShieldAlert className="w-4 h-4 text-[#D99B52] shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {/* 渲染主画布 */}
      {!loading && !loadError && prepared && viewMode === 'render' && (
        <div className="flex flex-col">
          <div
            className={`w-full overflow-auto ${
              viewportPreset === 'mobile'
                ? paperLightMode
                  ? 'bg-[#F2F0EA] py-5 px-4 flex justify-center'
                  : 'bg-[#141416] py-5 px-4 flex justify-center'
                : 'bg-white'
            }`}
          >
            <div
              className={
                viewportPreset === 'mobile'
                  ? 'w-[390px] max-w-full h-[70vh] min-h-[540px] rounded-xl overflow-hidden border border-[#26243D]/15 shadow-md bg-white resize-y'
                  : fullWidth
                    ? 'w-full h-[78vh] min-h-[580px] bg-white resize-y overflow-hidden'
                    : 'w-full h-[72vh] min-h-[520px] bg-white resize-y overflow-hidden'
              }
            >
              <iframe
                key={`${currentRev.revision_id}:${allowScripts ? 'js' : 'static'}:${
                  allowExternalHttps ? 'https' : 'offline'
                }:${inlineTargetsKey}:${assetsLoading ? 'loading' : 'ready'}:${reloadNonce}`}
                title={`HTML 沙盒渲染 · ${activeFile.title}`}
                sandbox={prepared.sandboxAttr}
                srcDoc={prepared.srcDoc}
                referrerPolicy="no-referrer"
                className="w-full h-full border-0 bg-white block"
              />
            </div>
          </div>

          {/* 诚实状态脚注：本地资源联结、未内联提示、脚本关闭提示 */}
          {(prepared.resolvedLocalAssetCount > 0 ||
            prepared.unresolvedLocalAssets.length > 0 ||
            prepared.features.hasExternalModuleScript ||
            (!allowScripts && prepared.features.hasScript)) && (
            <div
              className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t text-[11px] ${barBgCls} ${mutedCls}`}
            >
              <div className="flex flex-wrap items-center gap-3">
                {prepared.resolvedLocalAssetCount > 0 && (
                  <span>已自动关联 {prepared.resolvedLocalAssetCount} 处同工作区本地资源</span>
                )}
                {!allowScripts && prepared.features.hasScript && (
                  <span className="text-[#A8762B]">
                    此文档包含脚本{prepared.features.hasCanvasOrWebgl ? '与 Canvas 绘制' : ''}，当前为纯静态模式
                  </span>
                )}
                {(prepared.unresolvedLocalAssets.length > 0 ||
                  prepared.features.hasExternalModuleScript) && (
                  <span>
                    {prepared.unresolvedLocalAssets.length > 0
                      ? `存在未内联相对资源（${prepared.unresolvedLocalAssets.slice(0, 3).join('、')}${
                          prepared.unresolvedLocalAssets.length > 3
                            ? ` 等 ${prepared.unresolvedLocalAssets.length} 项`
                            : ''
                        }），若需完整目录上下文可点击「默认应用打开」`
                      : '包含相对 ES 模块脚本，如需完整目录上下文可点击「默认应用打开」'}
                  </span>
                )}
              </div>
              {systemActions?.onOpenWithDefaultApp && (
                <button
                  type="button"
                  onClick={() => systemActions.onOpenWithDefaultApp?.(activeFile.relative_path)}
                  className="inline-flex items-center gap-1 underline hover:opacity-80 cursor-pointer shrink-0"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>在默认浏览器中打开</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* HTML 源码视图 */}
      {!loading && !loadError && displaySource !== null && viewMode === 'source' && (
        <div className="space-y-2">
          <pre className="p-4 overflow-x-auto max-h-[68vh] overflow-y-auto font-mono text-[12.5px] leading-[1.6] whitespace-pre">
            <code>{displaySource}</code>
          </pre>
          {isSourceTruncated && (
            <div className={`px-4 py-2 text-xs border-t ${mutedCls} ${barBgCls}`}>
              源码较长，已截断前 {MAX_INLINE_SOURCE_CHARS.toLocaleString()} 字符显示以保证流畅度；页面渲染已使用完整快照，完整源码可通过「复制源码」或「默认应用打开」查看。
            </div>
          )}
        </div>
      )}
    </div>
  );
};
