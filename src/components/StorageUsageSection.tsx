import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Download,
  FileArchive,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Sliders,
  Trash2,
} from 'lucide-react';
import type { WorkspaceConfig } from '../types/guanlan';
import {
  diagnosticZipDownloadUrl,
  exportDiagnosticZip,
  exportWorkspaceOpenArchive,
  fetchStorageStats,
  runStorageGc,
  updateStoragePolicy,
  verifyStorageIntegrity,
} from '../services/workspaceClient';
import type {
  BlobIntegrityReport,
  DiagnosticZipResponse,
  StorageGcResponse,
  StorageStatsResponse,
  WorkspaceOpenExportResponse,
} from '../services/apiTypes';
import { formatClassLabel, type FormatClass } from '../utils/formatMeta';
import { formatByteSize } from './NonLegacyFilePreviewPanel';
import {
  canExecuteStorageGc,
  normalizeGcParams,
  summarizeIntegrityReport,
} from '../utils/storageMaintenanceHelpers';

export interface StorageUsageSectionProps {
  config: WorkspaceConfig;
  isOpen: boolean;
}

type StorageStatsListener = (stats: StorageStatsResponse | null) => void;
const storageStatsListeners = new Set<StorageStatsListener>();
let latestStorageStats: StorageStatsResponse | null = null;

/** 供 WorkspaceSettingsModal 顶栏配额条实时对齐 StorageUsageSection 的最新实测口径 */
export function subscribeStorageStatsSnapshot(listener: StorageStatsListener): () => void {
  storageStatsListeners.add(listener);
  if (latestStorageStats) {
    listener(latestStorageStats);
  }
  return () => {
    storageStatsListeners.delete(listener);
  };
}

function publishStorageStatsSnapshot(stats: StorageStatsResponse | null): void {
  latestStorageStats = stats;
  for (const listener of storageStatsListeners) {
    listener(stats);
  }
}

const KNOWN_FORMAT_CLASSES = new Set<string>([
  'markdown',
  'text',
  'code',
  'vector',
  'image',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'audio',
  'video',
  'font',
  'binary',
]);

function displayClassLabel(cls: string, fallbackLabel?: string): string {
  if (fallbackLabel && fallbackLabel.trim().length > 0) {
    return fallbackLabel;
  }
  if (KNOWN_FORMAT_CLASSES.has(cls)) {
    return formatClassLabel(cls as FormatClass);
  }
  return cls;
}

/**
 * 设置面板中的真实存储占用、全格式分类分布、`.gitignore` 状态与三档快照阈值配置。
 * 数据源自 `GET /api/v1/storage/stats` 与 `POST /api/v1/storage/policy`。
 */
export const StorageUsageSection: React.FC<StorageUsageSectionProps> = ({
  config,
  isOpen,
}) => {
  const [stats, setStats] = useState<StorageStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textMaxMiB, setTextMaxMiB] = useState('10');
  const [binaryMaxMiB, setBinaryMaxMiB] = useState('50');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [integrityReport, setIntegrityReport] = useState<BlobIntegrityReport | null>(null);
  const [integrityError, setIntegrityError] = useState<string | null>(null);

  const [gcOlderDays, setGcOlderDays] = useState('30');
  const [gcKeepRecent, setGcKeepRecent] = useState('3');
  const [gcRemoveOrphans, setGcRemoveOrphans] = useState(true);
  const [gcBusy, setGcBusy] = useState(false);
  const [gcReport, setGcReport] = useState<StorageGcResponse | null>(null);
  const [gcError, setGcError] = useState<string | null>(null);

  const [exportIncludeSnapshots, setExportIncludeSnapshots] = useState(true);
  const [exportDir, setExportDir] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportReceipt, setExportReceipt] = useState<WorkspaceOpenExportResponse | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [diagBusy, setDiagBusy] = useState(false);
  const [diagReceipt, setDiagReceipt] = useState<DiagnosticZipResponse | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    const res = await fetchStorageStats();
    setLoading(false);
    if (res.ok) {
      setStats(res.data);
      publishStorageStatsSnapshot(res.data);
      setTextMaxMiB(
        String(res.data.policy.text_max_mib || Math.max(1, Math.round(res.data.policy.text_max_bytes / (1024 * 1024))))
      );
      setBinaryMaxMiB(
        String(res.data.policy.binary_max_mib || Math.max(1, Math.round(res.data.policy.binary_max_bytes / (1024 * 1024))))
      );
    } else {
      setError(res.error ?? '读取存储统计失败');
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setSaveMessage(null);
    void loadStats();
  }, [isOpen]);

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedText = Number.parseInt(textMaxMiB, 10);
    const parsedBinary = Number.parseInt(binaryMaxMiB, 10);
    if (!Number.isFinite(parsedText) || parsedText < 1 || !Number.isFinite(parsedBinary) || parsedBinary < 1) {
      setSaveMessage('请输入大于等于 1 的整数 MiB 阈值');
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    const res = await updateStoragePolicy(parsedText, parsedBinary);
    setSaving(false);
    if (res.ok) {
      setSaveMessage('已保存三档快照阈值，下次扫描生效');
      void loadStats();
    } else {
      setSaveMessage(res.error ?? '更新失败');
    }
  };

  const handleVerifyIntegrity = async () => {
    setIntegrityLoading(true);
    setIntegrityError(null);
    const res = await verifyStorageIntegrity();
    setIntegrityLoading(false);
    if (res.ok) {
      setIntegrityReport(res.data);
    } else {
      setIntegrityError(res.error ?? 'SHA-256 完整性校验失败');
    }
  };

  const normalizedGc = normalizeGcParams(gcOlderDays, gcKeepRecent);
  const gcCanExecute = canExecuteStorageGc({
    dryRunReport: gcReport,
    olderThanDays: normalizedGc.olderThanDays,
    keepRecentPerFile: normalizedGc.keepRecentPerFile,
    removeOrphanBlobs: gcRemoveOrphans,
    busy: gcBusy,
  });

  const handleGc = async (dryRun: boolean) => {
    setGcBusy(true);
    setGcError(null);
    const res = await runStorageGc({
      older_than_days: normalizedGc.olderThanDays,
      keep_recent_per_file: normalizedGc.keepRecentPerFile,
      remove_orphan_blobs: gcRemoveOrphans,
      dry_run: dryRun,
    });
    setGcBusy(false);
    if (res.ok) {
      setGcReport(res.data);
      if (!dryRun) {
        void loadStats();
      }
    } else {
      setGcError(res.error ?? (dryRun ? '存储瘦身预演失败' : '存储瘦身执行失败'));
    }
  };

  const handleWorkspaceExport = async () => {
    setExportBusy(true);
    setExportError(null);
    const res = await exportWorkspaceOpenArchive({
      include_snapshots: exportIncludeSnapshots,
      output_dir: exportDir.trim() || null,
    });
    setExportBusy(false);
    if (res.ok) {
      setExportReceipt(res.data);
    } else {
      setExportError(res.error ?? '全量开放导出失败');
    }
  };

  const handleDiagnosticZip = async () => {
    setDiagBusy(true);
    setDiagError(null);
    const res = await exportDiagnosticZip(null);
    setDiagBusy(false);
    if (res.ok) {
      setDiagReceipt(res.data);
    } else {
      setDiagError(res.error ?? '生成脱敏诊断包失败');
    }
  };

  const sortedFormats = stats
    ? Object.entries(stats.by_format).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    : [];

  return (
    <div className="rounded-2xl border border-border/75 bg-card/90 p-4 space-y-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-[length:var(--text-ui-body)] text-[color:var(--ink-strong)]">
          <HardDrive className="w-4 h-4 text-[color:var(--accent-iris)]" />
          <span>本地快照存储与格式级配额</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_12%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--stage-ink-deliver-text)]">
            <ShieldCheck className="w-3 h-3" />
            <span>{stats?.gitignore_respected === false ? '未启用 .gitignore' : '.gitignore 自动尊重'}</span>
          </span>
          <button
            type="button"
            onClick={() => void loadStats()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/45 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer disabled:opacity-50 motion-safe:transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {stats ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-[10px] bg-muted/40 border border-border/75 px-2.5 py-2">
              <div className="text-[10px] font-sans text-muted-foreground">总磁盘占用</div>
              <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-foreground">
                {formatByteSize(stats.total_disk_bytes)}
              </div>
            </div>
            <div className="rounded-[10px] bg-muted/40 border border-border/75 px-2.5 py-2">
              <div className="text-[10px] font-sans text-muted-foreground">
                去重快照 ({stats.blobs_count})
              </div>
              <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-[color:var(--accent-iris-deep)]">
                {formatByteSize(stats.blobs_disk_bytes)}
              </div>
            </div>
            <div className="rounded-[10px] bg-muted/40 border border-border/75 px-2.5 py-2">
              <div className="text-[10px] font-sans text-muted-foreground">索引库 SQLite</div>
              <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-foreground">
                {formatByteSize(stats.db_bytes)}
              </div>
            </div>
            <div className="rounded-[10px] bg-muted/40 border border-border/75 px-2.5 py-2">
              <div className="text-[10px] font-sans text-muted-foreground">仅元数据版本 (L0)</div>
              <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-[color:var(--stage-ink-decision-text)]">
                {stats.metadata_only_revisions} / {stats.revisions_total}
              </div>
            </div>
          </div>

          {stats.by_class.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">
                全类型纳管分类分布（共 {stats.active_files_count} 份活跃文件，快照累计 {formatByteSize(stats.blobs_bytes)}）
              </div>
              <div className="flex flex-wrap gap-1.5">
                {stats.by_class.map((cls) => (
                  <span
                    key={cls.format_class}
                    className="inline-flex items-center gap-1.5 rounded-[8px] border border-border/75 bg-muted/35 px-2 py-1 text-[11px] text-foreground"
                  >
                    <span className="font-sans font-medium">{displayClassLabel(cls.format_class, cls.label)}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {cls.files_count} 份 · {formatByteSize(cls.snapshot_bytes)}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {sortedFormats.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {sortedFormats.slice(0, 12).map(([fmt, count]) => (
                <span
                  key={fmt}
                  className="rounded px-1.5 py-0.5 bg-muted/70 font-mono text-[10px] tabular-nums text-muted-foreground"
                >
                  {fmt.toUpperCase()} {count}
                </span>
              ))}
              {sortedFormats.length > 12 && (
                <span className="rounded px-1.5 py-0.5 bg-muted/70 font-mono text-[10px] text-muted-foreground">
                  +{sortedFormats.length - 12} 格式
                </span>
              )}
            </div>
          )}

          <form onSubmit={handleSavePolicy} className="pt-3 border-t border-border/75 space-y-2.5">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground">
                <Sliders className="w-3.5 h-3.5 text-[color:var(--accent-iris)] shrink-0" />
                <span>三档快照上限配置（音视频 / 字体 / 未知二进制恒为仅元数据入库）</span>
              </div>
              <div
                className="pl-5 font-mono text-[10px] text-muted-foreground truncate"
                title={stats.data_dir_path}
              >
                存储位置：{stats.data_dir_path}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>文本/代码/矢量上限 (MiB)</span>
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={textMaxMiB}
                  onChange={(e) => setTextMaxMiB(e.target.value)}
                  disabled={saving}
                  className="w-20 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground disabled:opacity-60"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>图片/办公/PDF 上限 (MiB)</span>
                <input
                  type="number"
                  min={1}
                  max={2048}
                  value={binaryMaxMiB}
                  onChange={(e) => setBinaryMaxMiB(e.target.value)}
                  disabled={saving}
                  className="w-20 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground disabled:opacity-60"
                />
              </label>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md bg-[color:var(--accent-iris)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 cursor-pointer disabled:opacity-50"
              >
                <Check className="w-3 h-3" />
                <span>{saving ? '保存中…' : '保存策略'}</span>
              </button>
            </div>
            {saveMessage && (
              <div className="text-[11px] text-[color:var(--accent-iris-deep)]">{saveMessage}</div>
            )}
          </form>

          <div className="pt-3 border-t border-border/75 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>快照 SHA-256 完整性校验与铁律保护瘦身</span>
              </div>
              <button
                type="button"
                disabled={integrityLoading}
                onClick={() => void handleVerifyIntegrity()}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-muted/45 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-50 motion-safe:transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${integrityLoading ? 'animate-spin' : ''}`} />
                <span>{integrityLoading ? '正在逐份验算 SHA-256…' : '全量 SHA-256 校验'}</span>
              </button>
            </div>

            {integrityError && (
              <div className="rounded-lg border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-700 dark:text-red-300">
                {integrityError}
              </div>
            )}

            {integrityReport && (() => {
              const summary = summarizeIntegrityReport(integrityReport);
              return (
                <div
                  className={`rounded-lg border px-3 py-2 text-[11px] space-y-1.5 ${
                    summary.status === 'healthy'
                      ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/70 dark:bg-emerald-950/35 text-emerald-900 dark:text-emerald-200'
                      : 'border-red-300 dark:border-red-800/70 bg-red-50/90 dark:bg-red-950/45 text-red-900 dark:text-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 font-medium">
                    <span className="flex items-center gap-1.5">
                      {summary.status === 'healthy' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
                      )}
                      <span>{summary.headline}</span>
                    </span>
                    <span className="font-mono text-[10px] opacity-80">
                      {formatByteSize(integrityReport.total_verified_bytes)}
                    </span>
                  </div>
                  {integrityReport.impacts.length > 0 && (
                    <ul className="list-disc pl-4 space-y-1">
                      {integrityReport.impacts.map((imp) => (
                        <li key={imp.content_hash}>
                          <span className="font-mono font-semibold">
                            [{imp.issue_kind}] {imp.content_hash.slice(0, 12)}…
                          </span>{' '}
                          — {imp.detail}
                          {imp.impacted_revisions.length > 0 && (
                            <div className="font-mono text-[10px] opacity-90">
                              受影响版本：
                              {imp.impacted_revisions
                                .slice(0, 5)
                                .map((r) => `${r.relative_path}@v${r.seq}`)
                                .join('、')}
                            </div>
                          )}
                          {imp.impacted_decisions.length > 0 && (
                            <div className="text-[10px] font-medium">
                              受影响决定：
                              {imp.impacted_decisions
                                .slice(0, 4)
                                .map((d) => `${d.code}(${d.question})`)
                                .join('；')}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}

            <div className="rounded-[10px] border border-border/75 bg-muted/35 p-3 space-y-2.5">
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                <strong className="text-foreground">决定证据铁律保护：</strong>
                凡被决定、因果/引用边、关键治理事件、首版基线及最新定稿锚定的历史快照一律永久豁免，瘦身仅清理超期非关键过程快照与无引用孤儿文件。
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px]">
                <label className="flex items-center gap-1 text-muted-foreground">
                  <span>清理超期天数</span>
                  <input
                    type="number"
                    min={0}
                    max={3650}
                    value={gcOlderDays}
                    onChange={(e) => setGcOlderDays(e.target.value)}
                    className="w-16 rounded border border-input bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                  />
                </label>
                <label className="flex items-center gap-1 text-muted-foreground">
                  <span>每文件保底保留版数</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={gcKeepRecent}
                    onChange={(e) => setGcKeepRecent(e.target.value)}
                    className="w-16 rounded border border-input bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                  />
                </label>
                <label className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={gcRemoveOrphans}
                    onChange={(e) => setGcRemoveOrphans(e.target.checked)}
                  />
                  <span>清理孤儿文件</span>
                </label>
                <button
                  type="button"
                  disabled={gcBusy}
                  onClick={() => void handleGc(true)}
                  className="cursor-pointer rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-50 motion-safe:transition-colors"
                >
                  {gcBusy ? '计算中…' : '预演瘦身'}
                </button>
                <button
                  type="button"
                  disabled={!gcCanExecute}
                  onClick={() => void handleGc(false)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>确认执行瘦身</span>
                </button>
              </div>
              {gcError && <div className="text-[11px] text-red-700 dark:text-red-300">{gcError}</div>}
              {gcReport && (
                <div className="rounded-md bg-muted/65 border border-border/60 px-2.5 py-1.5 font-mono text-[10.5px] text-foreground space-y-0.5">
                  <div>
                    [{gcReport.dry_run ? '预演结果' : '已执行瘦身'}] 可释放/已释放{' '}
                    <strong>{formatByteSize(gcReport.reclaimed_bytes)}</strong> · 清理过程版本{' '}
                    {gcReport.pruned_revisions_count} 个 · 删除独立快照 {gcReport.deleted_blobs_count}{' '}
                    份 · 孤儿文件 {gcReport.deleted_orphan_blobs_count} 份
                  </div>
                  <div className="text-muted-foreground">
                    铁律保护：{gcReport.protected_revisions_count} 个受保护版本（含决定证据{' '}
                    {gcReport.protected_decision_evidence_count} · 因果边证据{' '}
                    {gcReport.protected_edge_evidence_count} · 共享去重保留{' '}
                    {gcReport.skipped_shared_blob_count} 次 · 保留占用{' '}
                    {formatByteSize(gcReport.protected_bytes)}）
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-border/75 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-[10px] border border-border/75 bg-muted/35 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
                <Archive className="w-3.5 h-3.5 text-[color:var(--accent-iris)]" />
                <span>全量开放导出（零锁定）</span>
              </div>
              <div className="text-[10.5px] leading-relaxed text-muted-foreground">
                随时取回全部历史去重快照与 JSONL/Markdown 事件、决定、因果边及更名谱系账本。
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <label className="flex cursor-pointer items-center gap-1 text-foreground">
                  <input
                    type="checkbox"
                    checked={exportIncludeSnapshots}
                    onChange={(e) => setExportIncludeSnapshots(e.target.checked)}
                  />
                  <span>附带全部历史快照</span>
                </label>
                <input
                  type="text"
                  value={exportDir}
                  onChange={(e) => setExportDir(e.target.value)}
                  placeholder="输出目录（留空写至 .guanlan/exports/）"
                  className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-0.5 font-mono text-[10.5px] text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <button
                type="button"
                disabled={exportBusy}
                onClick={() => void handleWorkspaceExport()}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-[color:var(--ink-anchor)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--paper-on-ink)] disabled:opacity-50"
              >
                <Archive className="w-3 h-3" />
                <span>{exportBusy ? '正在导出全量账本与快照…' : '一键全量开放导出'}</span>
              </button>
              {exportError && <div className="text-[10.5px] text-red-700 dark:text-red-300">{exportError}</div>}
              {exportReceipt && (
                <div className="rounded bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1.5 font-mono text-[10px] text-emerald-900 dark:text-emerald-200 break-all">
                  已导出 {exportReceipt.files_count} 文件 / {exportReceipt.events_count} 事件 /{' '}
                  {exportReceipt.decisions_count} 决定 / {exportReceipt.snapshots_exported} 份快照（
                  {formatByteSize(exportReceipt.total_bytes)}）→ {exportReceipt.output_dir}
                </div>
              )}
            </div>

            <div className="rounded-[10px] border border-border/75 bg-muted/35 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
                <FileArchive className="w-3.5 h-3.5 text-[color:var(--accent-iris)]" />
                <span>一键脱敏运行诊断包 ZIP</span>
              </div>
              <div className="text-[10.5px] leading-relaxed text-muted-foreground">
                打包运行摘要、存储统计、SHA-256 体检与决定链审计报告；自动脱敏本机路径、用户名与凭据，零文档正文泄露。
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={diagnosticZipDownloadUrl()}
                  download="guanlan-diagnostic.zip"
                  className="inline-flex items-center gap-1 rounded-md bg-[color:var(--accent-iris)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
                >
                  <Download className="w-3 h-3" />
                  <span>直接下载诊断 ZIP</span>
                </a>
                <button
                  type="button"
                  disabled={diagBusy}
                  onClick={() => void handleDiagnosticZip()}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-50 motion-safe:transition-colors"
                >
                  <span>{diagBusy ? '生成中…' : '落盘保存并查看摘要'}</span>
                </button>
              </div>
              {diagError && <div className="text-[10.5px] text-red-700 dark:text-red-300">{diagError}</div>}
              {diagReceipt && (
                <div className="rounded bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1.5 font-mono text-[10px] text-emerald-900 dark:text-emerald-200 break-all">
                  已生成 {diagReceipt.entries_count} 项（{formatByteSize(diagReceipt.size_bytes)} · 脱敏{' '}
                  {diagReceipt.redactions_applied} 处 · 完整性 {diagReceipt.integrity_ok ? 'PASS' : 'FAIL'}）→{' '}
                  {diagReceipt.zip_path}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="text-xs text-muted-foreground">
          {error
            ? `暂无法从本地服务读取实时存储统计（配额上限 ${config.quota.maxTotalMiB} MiB）：${error}`
            : '正在计算本地工作区磁盘占用…'}
        </div>
      )}
    </div>
  );
};
