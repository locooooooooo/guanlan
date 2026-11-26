import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  FolderOpen,
  Loader2,
  Package,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  CapsuleExportResponse,
  CapsuleFileContentResponse,
  CapsuleInspectResponse,
  CapsuleManifestDecision,
  CapsuleManifestFile,
  CapsuleMode,
  CapsulePreviewResponse,
} from '../services/apiTypes';
import {
  exportCapsule,
  inspectCapsuleDir,
  previewCapsule,
  readCapsuleFile,
} from '../services/workspaceClient';
import {
  buildCapsulePreviewPayload,
  canConfirmCapsuleExport,
  formatCapsuleBytes,
  sliceCapsuleEvidenceLines,
} from '../utils/contextCapsuleHelpers';

export interface CapsuleTargetPreset {
  mode: 'export' | 'inspect';
  title?: string;
  initiativeId?: string | null;
  fileIds?: string[];
}

export interface ContextCapsuleModalProps {
  isOpen: boolean;
  preset: CapsuleTargetPreset | null;
  onClose: () => void;
  onOpenLocalDoc?: (fileId: string) => void;
}

type ModalTab = 'export' | 'inspect';
type InspectSection = 'timeline' | 'decisions' | 'files';

interface EvidenceReaderState {
  title: string;
  bundledRelPath: string;
  lineStart: number;
  lineEnd: number;
  loading: boolean;
  error: string | null;
  content: CapsuleFileContentResponse | null;
}

/**
 * 事项资料胶囊（Context Capsule）两阶段预览/脱敏导出 + 另一台观澜秒开核验面板。
 *
 * 停机红线护栏：
 * 1. 打开后先执行只读预览（POST /api/v1/capsules/preview），展示预估体积、敏感目录自动排除项与脱敏计数；
 * 2. 任一勾选/模式/时间段/脱敏开关变化立即清空确认勾选并重算 preview_token；
 * 3. 必须同时满足有效 preview_token + 用户显式勾选确认，方允许执行导出（服务端同口径二次 fail-closed 校验）。
 */
export const ContextCapsuleModal: React.FC<ContextCapsuleModalProps> = ({
  isOpen,
  preset,
  onClose,
  onOpenLocalDoc,
}) => {
  const [tab, setTab] = useState<ModalTab>('export');
  const [capsuleMode, setCapsuleMode] = useState<CapsuleMode>('with_snapshots');
  const [sanitizeSecrets, setSanitizeSecrets] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [excludedDirs, setExcludedDirs] = useState<string[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[] | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [confirmedPreview, setConfirmedPreview] = useState(false);

  const [preview, setPreview] = useState<CapsulePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportReceipt, setExportReceipt] = useState<CapsuleExportResponse | null>(null);

  const [inspectPath, setInspectPath] = useState('');
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectData, setInspectData] = useState<CapsuleInspectResponse | null>(null);
  const [inspectSection, setInspectSection] = useState<InspectSection>('timeline');
  const [evidenceReader, setEvidenceReader] = useState<EvidenceReaderState | null>(null);

  const previewSeqRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setTab(preset?.mode === 'inspect' ? 'inspect' : 'export');
    setCapsuleMode('with_snapshots');
    setSanitizeSecrets(true);
    setFromDate('');
    setToDate('');
    setExcludedDirs([]);
    setSelectedFileIds(null);
    setOutputDir('');
    setConfirmedPreview(false);
    setPreview(null);
    setPreviewError(null);
    setExportError(null);
    setExportReceipt(null);
    setEvidenceReader(null);
  }, [isOpen, preset]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const previewPayload = useMemo(
    () =>
      buildCapsulePreviewPayload({
        initiativeId: preset?.initiativeId ?? null,
        fileIds: preset?.fileIds ?? [],
        from: fromDate,
        to: toDate,
        mode: capsuleMode,
        sanitizeSecrets,
        excludedDirs,
        selectedFileIds,
      }),
    [
      preset?.initiativeId,
      preset?.fileIds,
      fromDate,
      toDate,
      capsuleMode,
      sanitizeSecrets,
      excludedDirs,
      selectedFileIds,
    ]
  );

  const runPreview = useCallback(async () => {
    const seq = ++previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    setConfirmedPreview(false);
    const res = await previewCapsule(previewPayload);
    if (seq !== previewSeqRef.current) return;
    setPreviewLoading(false);
    if (res.ok) {
      setPreview(res.data);
    } else {
      setPreview(null);
      setPreviewError(res.error || '预览胶囊清单失败');
    }
  }, [previewPayload]);

  useEffect(() => {
    if (!isOpen || tab !== 'export') return;
    void runPreview();
  }, [isOpen, tab, runPreview]);

  const toggleFileSelected = (fileId: string) => {
    if (!preview) return;
    const currentSelected = new Set(
      preview.files.filter((f) => f.selected).map((f) => f.file_id)
    );
    if (currentSelected.has(fileId)) {
      currentSelected.delete(fileId);
    } else {
      currentSelected.add(fileId);
    }
    setSelectedFileIds(Array.from(currentSelected));
  };

  const toggleDirExcluded = (dir: string) => {
    setSelectedFileIds(null);
    setExcludedDirs((prev) =>
      prev.includes(dir) ? prev.filter((d) => d !== dir) : [...prev, dir]
    );
  };

  const exportEnabled = canConfirmCapsuleExport({
    preview,
    previewLoading,
    exporting,
    confirmedPreview,
  });

  const handleExport = async () => {
    if (!exportEnabled || !preview) return;
    setExporting(true);
    setExportError(null);
    const res = await exportCapsule({
      ...previewPayload,
      preview_token: preview.preview_token,
      confirmed_preview: true,
      output_dir: outputDir.trim() || null,
    });
    setExporting(false);
    if (res.ok) {
      setExportReceipt(res.data);
    } else {
      setExportError(res.error || '导出事项资料胶囊失败');
    }
  };

  const handleInspect = useCallback(async (dirToOpen: string) => {
    const clean = dirToOpen.trim();
    if (!clean) {
      setInspectError('请输入包含 capsule-manifest.json 的胶囊目录路径');
      return;
    }
    setInspectLoading(true);
    setInspectError(null);
    setEvidenceReader(null);
    const res = await inspectCapsuleDir(clean);
    setInspectLoading(false);
    if (res.ok) {
      setInspectData(res.data);
      setInspectSection('timeline');
    } else {
      setInspectData(null);
      setInspectError(res.error || '无法读取或校验胶囊目录');
    }
  }, []);

  const openBundledEvidence = async (
    file: CapsuleManifestFile | undefined,
    fallbackTitle: string,
    lineStart: number,
    lineEnd: number,
    localFileId?: string
  ) => {
    if (!inspectData) return;
    if (file?.bundled_rel_path) {
      setEvidenceReader({
        title: file.relative_path,
        bundledRelPath: file.bundled_rel_path,
        lineStart,
        lineEnd,
        loading: true,
        error: null,
        content: null,
      });
      const res = await readCapsuleFile(inspectData.capsule_dir, file.bundled_rel_path);
      if (res.ok) {
        setEvidenceReader({
          title: file.relative_path,
          bundledRelPath: file.bundled_rel_path,
          lineStart,
          lineEnd,
          loading: false,
          error: null,
          content: res.data,
        });
      } else {
        setEvidenceReader({
          title: file.relative_path,
          bundledRelPath: file.bundled_rel_path,
          lineStart,
          lineEnd,
          loading: false,
          error: res.error || '无法读取包内快照文件',
          content: null,
        });
      }
      return;
    }
    if (localFileId && onOpenLocalDoc) {
      onOpenLocalDoc(localFileId);
      onClose();
      return;
    }
    setEvidenceReader({
      title: fallbackTitle,
      bundledRelPath: '',
      lineStart,
      lineEnd,
      loading: false,
      error: '该胶囊以「仅引用清单」模式导出或该文件无附带快照，当前仅展示引用定位与原文摘录。',
      content: null,
    });
  };

  const inspectFileMap = useMemo(() => {
    const map = new Map<string, CapsuleManifestFile>();
    if (inspectData) {
      for (const f of inspectData.manifest.files) {
        map.set(f.file_id, f);
      }
    }
    return map;
  }, [inspectData]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="事项资料胶囊与离线阅读包"
      className="glx-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--ink-anchor)]/40 dark:bg-black/62 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        data-dialog-nested-stack=""
        style={{ '--nested-dialogs': 0 } as React.CSSProperties}
        className="glass-pop glx-popover-in flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-[var(--r-card)] border border-[color:var(--glass-hairline)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Package className="h-4.5 w-4.5 text-[color:var(--accent-iris)]" />
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">
                事项资料胶囊（Context Capsule）
              </h2>
              <p className="text-[11.5px] text-muted-foreground">
                开放目录离线可读（TIMELINE.md + DECISIONS.md + index.html）· 另一台观澜识别 capsule-manifest.json 秒开
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-full bg-muted p-0.5 text-[12px]" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'export'}
                onClick={() => setTab('export')}
                className={`cursor-pointer rounded-full px-3 py-1 transition-colors ${
                  tab === 'export'
                    ? 'bg-[color:var(--ink-anchor)] font-medium text-[color:var(--paper-on-ink)]'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                打包胶囊
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'inspect'}
                onClick={() => setTab('inspect')}
                className={`cursor-pointer rounded-full px-3 py-1 transition-colors ${
                  tab === 'inspect'
                    ? 'bg-[color:var(--ink-anchor)] font-medium text-[color:var(--paper-on-ink)]'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                秒开 / 核验胶囊
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭事项资料胶囊窗口"
              className="cursor-pointer rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {tab === 'export' ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 space-y-4">
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-border/80 bg-muted/35 p-3.5 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-foreground">
                  目标事项：{preset?.title || preview?.title || '按时间段自定义范围'}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-capsule-mode="with_snapshots"
                    onClick={() => setCapsuleMode('with_snapshots')}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                      capsuleMode === 'with_snapshots'
                        ? 'border-[color:var(--accent-iris)] bg-[color:var(--accent-iris)]/14 font-medium text-foreground'
                        : 'border-border bg-card/70 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    带快照原文（离线自包含）
                  </button>
                  <button
                    type="button"
                    data-capsule-mode="manifest_only"
                    onClick={() => setCapsuleMode('manifest_only')}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                      capsuleMode === 'manifest_only'
                        ? 'border-[color:var(--accent-iris)] bg-[color:var(--accent-iris)]/14 font-medium text-foreground'
                        : 'border-border bg-card/70 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    仅带引用清单（轻量脉络）
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <label className="flex items-center gap-1.5 text-muted-foreground">
                    <span>起始日期</span>
                    <input
                      type="date"
                      value={fromDate}
                      onChange={(e) => {
                        setSelectedFileIds(null);
                        setFromDate(e.target.value);
                      }}
                      className="rounded-md border border-input bg-card px-2 py-0.5 text-[12px] text-foreground"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-muted-foreground">
                    <span>截止日期</span>
                    <input
                      type="date"
                      value={toDate}
                      onChange={(e) => {
                        setSelectedFileIds(null);
                        setToDate(e.target.value);
                      }}
                      className="rounded-md border border-input bg-card px-2 py-0.5 text-[12px] text-foreground"
                    />
                  </label>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
                  <input
                    type="checkbox"
                    checked={sanitizeSecrets}
                    onChange={(e) => setSanitizeSecrets(e.target.checked)}
                  />
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>自动脱敏正文中的 API Key / 私钥 / 令牌（默认强开启）</span>
                </label>
              </div>
            </div>

            {previewLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-black/8 p-4 text-[13px] text-[color:var(--ink-soft)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>正在扫描候选文件、检测敏感凭据目录并估算总体积…</span>
              </div>
            ) : previewError ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-red-300 dark:border-red-500/35 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-[12.5px] text-red-700 dark:text-red-300">
                <span>{previewError}</span>
                <button
                  type="button"
                  onClick={() => void runPreview()}
                  className="cursor-pointer rounded-md border border-red-300 dark:border-red-500/40 px-2.5 py-1 text-[12px] hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  重试预览
                </button>
              </div>
            ) : preview ? (
              <>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                  <div className="rounded-xl border border-black/8 px-3 py-2">
                    <div className="text-[11px] text-[color:var(--ink-soft)]">已选文件</div>
                    <div className="font-mono text-[15px] font-semibold text-[color:var(--ink-strong)] tabular-nums">
                      {preview.selected_file_count} / {preview.total_candidate_count}
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/8 px-3 py-2">
                    <div className="text-[11px] text-[color:var(--ink-soft)]">预估总体积</div>
                    <div className="font-mono text-[15px] font-semibold text-[color:var(--ink-strong)] tabular-nums">
                      {formatCapsuleBytes(preview.estimated_total_bytes)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/8 px-3 py-2">
                    <div className="text-[11px] text-[color:var(--ink-soft)]">演进事件 / 决定</div>
                    <div className="font-mono text-[15px] font-semibold text-[color:var(--ink-strong)] tabular-nums">
                      {preview.event_count} / {preview.decision_count}
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/8 px-3 py-2">
                    <div className="text-[11px] text-[color:var(--ink-soft)]">已拦截敏感文件</div>
                    <div className="font-mono text-[15px] font-semibold text-amber-700 tabular-nums">
                      {preview.sensitive_excluded_count}
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/8 px-3 py-2">
                    <div className="text-[11px] text-[color:var(--ink-soft)]">正文待脱敏命中</div>
                    <div className="font-mono text-[15px] font-semibold text-emerald-700 tabular-nums">
                      {preview.inline_redaction_count}
                    </div>
                  </div>
                </div>

                {preview.sensitive_warnings.length > 0 && (
                  <div className="rounded-xl border border-amber-300 dark:border-amber-500/35 bg-amber-50/90 dark:bg-amber-950/35 px-3.5 py-2.5 text-[12px] text-amber-900 dark:text-amber-200">
                    <div className="flex items-center gap-1.5 font-medium">
                      <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
                      <span>脱敏与敏感目录自检告警（已默认取消勾选敏感路径，绝不静默打包）</span>
                    </div>
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                      {preview.sensitive_warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.dirs.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                    <span className="text-[color:var(--ink-soft)]">按目录排除：</span>
                    {preview.dirs.map((dir) => {
                      const excluded = excludedDirs.includes(dir);
                      return (
                        <button
                          key={dir}
                          type="button"
                          onClick={() => toggleDirExcluded(dir)}
                          className={`cursor-pointer rounded-full border px-2.5 py-0.5 font-mono transition-colors ${
                            excluded
                              ? 'border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 line-through'
                              : 'border-border bg-card text-[color:var(--ink-strong)] hover:bg-accent'
                          }`}
                        >
                          {dir}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="overflow-hidden rounded-xl border border-border">
                  <div className="flex items-center justify-between border-b border-border bg-muted/60 px-3 py-2 text-[11.5px] text-[color:var(--ink-soft)]">
                    <span>预览打包清单（可逐项勾选调整，敏感目录默认取消勾选）</span>
                    <span className="font-mono">Token: {preview.preview_token.slice(0, 18)}…</span>
                  </div>
                  <div className="max-h-56 divide-y divide-border/70 overflow-y-auto">
                    {preview.files.length === 0 ? (
                      <div className="p-4 text-center text-[12.5px] text-[color:var(--ink-soft)]">
                        当前范围内未匹配到活跃文件
                      </div>
                    ) : (
                      preview.files.map((f) => (
                        <label
                          key={f.file_id}
                          className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[12px] hover:bg-accent/60 ${
                            f.sensitive_path ? 'bg-amber-50/40 dark:bg-amber-950/25' : ''
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={f.selected}
                              onChange={() => toggleFileSelected(f.file_id)}
                            />
                            <span className="truncate font-mono text-[color:var(--ink-strong)]">
                              {f.relative_path}
                            </span>
                            <span className="shrink-0 rounded bg-black/6 px-1.5 py-0.5 font-mono text-[10px] uppercase text-[color:var(--ink-soft)]">
                              {f.format} · v{f.seq}
                            </span>
                            {f.sensitive_path && (
                              <span
                                title={f.sensitive_reason ?? undefined}
                                className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                              >
                                敏感路径
                              </span>
                            )}
                            {f.inline_secret_hits > 0 && (
                              <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                                {sanitizeSecrets
                                  ? `将脱敏 ${f.inline_secret_hits} 处`
                                  : `含疑似凭据 ${f.inline_secret_hits} 处`}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-[color:var(--ink-soft)] tabular-nums">
                            {formatCapsuleBytes(f.size_bytes)}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                <div className="space-y-2.5 rounded-xl border border-border bg-muted/50 p-3.5">
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                    <label
                      htmlFor="capsule-output-dir"
                      className="shrink-0 text-[12px] font-medium text-[color:var(--ink-strong)]"
                    >
                      目标输出目录（可选）：
                    </label>
                    <input
                      id="capsule-output-dir"
                      type="text"
                      value={outputDir}
                      onChange={(e) => setOutputDir(e.target.value)}
                      placeholder="留空默认输出至工作区数据目录 .guanlan/capsules/<事项>-<时间>"
                      className="min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-[12px] text-[color:var(--ink-strong)]"
                    />
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-[color:var(--ink-strong)]">
                    <input
                      type="checkbox"
                      data-capsule-confirm=""
                      checked={confirmedPreview}
                      onChange={(e) => setConfirmedPreview(e.target.checked)}
                    />
                    <span>
                      我已预览确认以上 {preview.selected_file_count} 份文件、预估体积（
                      {formatCapsuleBytes(preview.estimated_total_bytes)}）与敏感排除清单，允许生成开放资料胶囊
                    </span>
                  </label>
                </div>
              </>
            ) : null}

            {exportError && (
              <div className="rounded-xl border border-red-300 dark:border-red-500/35 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-[12.5px] text-red-700 dark:text-red-300">
                {exportError}
              </div>
            )}

            {exportReceipt && (
              <div className="rounded-xl border border-emerald-300 dark:border-emerald-500/35 bg-emerald-50/90 dark:bg-emerald-950/35 p-3.5 text-[12px] text-emerald-950 dark:text-emerald-200 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span>
                      事项资料胶囊已生成（{exportReceipt.files_exported} 文件 ·{' '}
                      {exportReceipt.snapshots_written} 份原件快照 · 脱敏{' '}
                      {exportReceipt.redactions_applied} 处 ·{' '}
                      {formatCapsuleBytes(exportReceipt.total_bytes)}）
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setInspectPath(exportReceipt.output_dir);
                      setTab('inspect');
                      void handleInspect(exportReceipt.output_dir);
                    }}
                    className="cursor-pointer rounded-lg bg-emerald-700 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-emerald-800"
                  >
                    立即秒开核验 →
                  </button>
                </div>
                <div className="space-y-0.5 font-mono text-[11px] text-emerald-900/90 dark:text-emerald-300/90 break-all">
                  <div>目录：{exportReceipt.output_dir}</div>
                  <div>离线浏览：{exportReceipt.index_html_path}</div>
                  <div>演进脉络：{exportReceipt.timeline_md_path}</div>
                  <div>决定证据：{exportReceipt.decisions_md_path}</div>
                  <div>开放清单：{exportReceipt.manifest_path}</div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={inspectPath}
                onChange={(e) => setInspectPath(e.target.value)}
                placeholder="输入任意开放事项胶囊目录绝对路径（内含 capsule-manifest.json）"
                className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 font-mono text-[12px] text-[color:var(--ink-strong)]"
              />
              <button
                type="button"
                disabled={inspectLoading}
                onClick={() => void handleInspect(inspectPath)}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[color:var(--ink-anchor)] px-4 py-2 text-[12.5px] font-medium text-[color:var(--paper-on-ink)] disabled:opacity-50"
              >
                {inspectLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
                <span>秒开并核验 SHA-256</span>
              </button>
            </div>

            {inspectError && (
              <div className="rounded-xl border border-red-300 dark:border-red-500/35 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-[12.5px] text-red-700 dark:text-red-300">
                {inspectError}
              </div>
            )}

            {inspectData && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/50 px-4 py-3">
                  <div>
                    <div className="text-[14px] font-semibold text-[color:var(--ink-strong)]">
                      {inspectData.manifest.title}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[color:var(--ink-soft)]">
                      {inspectData.manifest.schema_version} · 导出于{' '}
                      {inspectData.manifest.exported_at} ·{' '}
                      {inspectData.manifest.mode === 'with_snapshots'
                        ? '带快照原文'
                        : '仅引用清单'}{' '}
                      · {inspectData.manifest.files.length} 文件 ·{' '}
                      {inspectData.manifest.events.length} 事件 ·{' '}
                      {inspectData.manifest.decisions.length} 决定
                    </div>
                  </div>
                  <div
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium ${
                      inspectData.integrity_ok
                        ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300'
                        : 'bg-red-100 dark:bg-red-950/50 text-red-800 dark:text-red-300'
                    }`}
                  >
                    {inspectData.integrity_ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {inspectData.integrity_ok
                        ? `SHA-256 核验通过（${inspectData.checked_snapshots} 份快照）`
                        : `发现 ${inspectData.integrity_issues.length} 项完整性异常`}
                    </span>
                  </div>
                </div>

                {inspectData.integrity_issues.length > 0 && (
                  <div className="rounded-xl border border-red-300 dark:border-red-500/35 bg-red-50 dark:bg-red-950/40 px-3.5 py-2 text-[12px] text-red-800 dark:text-red-300">
                    <ul className="list-disc pl-5 space-y-0.5">
                      {inspectData.integrity_issues.map((issue, idx) => (
                        <li key={idx}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center gap-1.5 border-b border-black/8 pb-2 text-[12px]">
                  <button
                    type="button"
                    onClick={() => setInspectSection('timeline')}
                    className={`flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1 ${
                      inspectSection === 'timeline'
                        ? 'bg-[color:var(--ink-anchor)] font-medium text-[color:var(--paper-on-ink)]'
                        : 'text-[color:var(--ink-soft)] hover:bg-black/5'
                    }`}
                  >
                    <Clock className="h-3.5 w-3.5" />
                    <span>时间演进主干 ({inspectData.manifest.events.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectSection('decisions')}
                    className={`flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1 ${
                      inspectSection === 'decisions'
                        ? 'bg-[color:var(--ink-anchor)] font-medium text-[color:var(--paper-on-ink)]'
                        : 'text-[color:var(--ink-soft)] hover:bg-black/5'
                    }`}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>决定与原文证据跳转 ({inspectData.manifest.decisions.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectSection('files')}
                    className={`flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1 ${
                      inspectSection === 'files'
                        ? 'bg-[color:var(--ink-anchor)] font-medium text-[color:var(--paper-on-ink)]'
                        : 'text-[color:var(--ink-soft)] hover:bg-black/5'
                    }`}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>收录文件 ({inspectData.manifest.files.length})</span>
                  </button>
                </div>

                {inspectSection === 'timeline' && (
                  <div className="max-h-64 divide-y divide-black/6 overflow-y-auto rounded-xl border border-black/10">
                    {inspectData.manifest.events.length === 0 ? (
                      <div className="p-4 text-center text-[12px] text-[color:var(--ink-soft)]">
                        无事件记录
                      </div>
                    ) : (
                      inspectData.manifest.events.map((ev) => (
                        <div key={ev.event_id} className="px-3.5 py-2.5 text-[12px]">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-black/6 px-1.5 py-0.5 font-mono text-[10.5px]">
                              {ev.kind}
                            </span>
                            <span className="font-medium text-[color:var(--ink-strong)]">
                              {ev.headline}
                            </span>
                          </div>
                          <div className="mt-1 font-mono text-[11px] text-[color:var(--ink-soft)]">
                            业务时间 {ev.occurred_at || '—'} · 采集时间 {ev.observed_at}
                            {ev.relative_path ? ` · ${ev.relative_path}` : ''}
                          </div>
                          {ev.detail && (
                            <div className="mt-1 text-[color:var(--ink-soft)]">{ev.detail}</div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {inspectSection === 'decisions' && (
                  <div className="max-h-64 divide-y divide-black/6 overflow-y-auto rounded-xl border border-black/10">
                    {inspectData.manifest.decisions.length === 0 ? (
                      <div className="p-4 text-center text-[12px] text-[color:var(--ink-soft)]">
                        无决定记录
                      </div>
                    ) : (
                      inspectData.manifest.decisions.map((d: CapsuleManifestDecision) => {
                        const fileEntry = inspectFileMap.get(d.file_id);
                        return (
                          <div
                            key={d.statement_id}
                            className="flex items-start justify-between gap-3 px-3.5 py-2.5 text-[12px]"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] ${
                                    d.status === 'confirmed'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {d.status}
                                </span>
                                <span className="font-mono text-[11px] text-[color:var(--ink-soft)]">
                                  {d.code}
                                </span>
                                <span className="font-medium text-[color:var(--ink-strong)]">
                                  {d.question}
                                </span>
                              </div>
                              <div className="text-[11.5px] text-[color:var(--ink-soft)]">
                                {d.quote}
                              </div>
                              <div className="font-mono text-[11px] text-[color:var(--ink-soft)]">
                                {d.relative_path} L{d.line_start}–L{d.line_end}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                void openBundledEvidence(
                                  fileEntry,
                                  d.relative_path,
                                  d.line_start,
                                  d.line_end,
                                  d.file_id
                                )
                              }
                              className="shrink-0 cursor-pointer rounded-lg border border-[color:var(--accent-iris)]/40 bg-[color:var(--accent-iris)]/10 px-2.5 py-1 text-[11.5px] font-medium text-[color:var(--ink-strong)] hover:bg-[color:var(--accent-iris)]/20"
                            >
                              跳转证据 L{d.line_start}
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {inspectSection === 'files' && (
                  <div className="max-h-64 divide-y divide-black/6 overflow-y-auto rounded-xl border border-black/10">
                    {inspectData.manifest.files.map((f) => (
                      <div
                        key={f.file_id}
                        className="flex items-center justify-between gap-3 px-3.5 py-2 text-[12px]"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[color:var(--ink-strong)]">
                            {f.relative_path}
                          </div>
                          <div className="font-mono text-[11px] text-[color:var(--ink-soft)]">
                            {f.format} · v{f.seq} · {f.content_hash.slice(0, 12)} ·{' '}
                            {formatCapsuleBytes(f.size_bytes)}
                            {f.redactions_applied > 0
                              ? ` · 已脱敏 ${f.redactions_applied} 处`
                              : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            void openBundledEvidence(f, f.relative_path, 1, 1, f.file_id)
                          }
                          className="shrink-0 cursor-pointer rounded-lg border border-black/12 px-2.5 py-1 text-[11.5px] text-[color:var(--ink-strong)] hover:bg-black/5"
                        >
                          {f.bundled_rel_path ? '预览原件' : '仅引用'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {evidenceReader && (
                  <div className="rounded-xl border border-[color:var(--accent-iris)]/35 bg-black/[0.02] p-3">
                    <div className="flex items-center justify-between gap-2 pb-2 text-[12px]">
                      <span className="font-mono font-medium text-[color:var(--ink-strong)]">
                        证据定位：{evidenceReader.title}（L{evidenceReader.lineStart}–L
                        {evidenceReader.lineEnd}）
                      </span>
                      <button
                        type="button"
                        onClick={() => setEvidenceReader(null)}
                        className="cursor-pointer text-[11px] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)]"
                      >
                        收起
                      </button>
                    </div>
                    {evidenceReader.loading ? (
                      <div className="flex items-center gap-2 text-[12px] text-[color:var(--ink-soft)]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>正在读取胶囊附带快照…</span>
                      </div>
                    ) : evidenceReader.error ? (
                      <div className="text-[12px] text-amber-800">{evidenceReader.error}</div>
                    ) : evidenceReader.content?.text != null ? (
                      <div className="max-h-48 overflow-auto rounded-lg border border-border bg-card font-mono text-[11.5px] leading-5">
                        {sliceCapsuleEvidenceLines(
                          evidenceReader.content.text,
                          evidenceReader.lineStart,
                          evidenceReader.lineEnd,
                          5
                        ).map((line) => (
                          <div
                            key={line.lineNumber}
                            className={`flex gap-3 px-2.5 py-0.5 ${
                              line.highlighted
                                ? 'bg-amber-100/90 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200'
                                : 'text-[color:var(--ink-strong)]'
                            }`}
                          >
                            <span className="w-9 shrink-0 select-none text-right text-[color:var(--ink-soft)] tabular-nums">
                              L{line.lineNumber}
                            </span>
                            <span className="whitespace-pre-wrap break-all">{line.text}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[12px] text-[color:var(--ink-soft)]">
                        该附带快照为二进制文件（{formatCapsuleBytes(evidenceReader.content?.size_bytes ?? 0)}），请直接从胶囊目录打开原件查看。
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'export' && (
          <div className="flex items-center justify-between gap-3 border-t border-black/8 px-5 py-3">
            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={previewLoading}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-black/12 px-3 py-1.5 text-[12px] text-[color:var(--ink-strong)] hover:bg-black/5 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${previewLoading ? 'animate-spin' : ''}`} />
              <span>刷新预览</span>
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg border border-black/12 px-3.5 py-1.5 text-[12.5px] text-[color:var(--ink-strong)] hover:bg-black/5"
              >
                关闭
              </button>
              <button
                type="button"
                data-capsule-submit=""
                disabled={!exportEnabled}
                onClick={() => void handleExport()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[color:var(--ink-anchor)] px-4 py-1.5 text-[12.5px] font-medium text-[color:var(--paper-on-ink)] transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
              >
                {exporting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>确认导出开放胶囊</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ContextCapsuleModal;
