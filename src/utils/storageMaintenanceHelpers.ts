
import type { BlobIntegrityReport, StorageGcResponse } from '../services/apiTypes';

/**
 * 强门禁：执行真正磁盘瘦身前，必须先跑完 dry-run 预演，且预演结果确实有可清理项。
 */
export function canExecuteStorageGc(opts: {
  dryRunReport: StorageGcResponse | null;
  olderThanDays: number;
  keepRecentPerFile: number;
  removeOrphanBlobs: boolean;
  busy: boolean;
}): boolean {
  if (opts.busy || !opts.dryRunReport || !opts.dryRunReport.dry_run) return false;
  if (opts.dryRunReport.older_than_days !== opts.olderThanDays) return false;
  if (opts.dryRunReport.keep_recent_per_file !== opts.keepRecentPerFile) return false;
  return (
    opts.dryRunReport.pruned_revisions_count > 0 ||
    opts.dryRunReport.deleted_blobs_count > 0 ||
    opts.dryRunReport.deleted_orphan_blobs_count > 0
  );
}

/**
 * 汇总 SHA-256 完整性体检一句话诚实结论。
 */
export function summarizeIntegrityReport(report: BlobIntegrityReport): {
  status: 'healthy' | 'degraded';
  headline: string;
} {
  if (report.ok) {
    return {
      status: 'healthy',
      headline: `全部 ${report.healthy_blobs} 份活跃快照 SHA-256 校验通过${
        report.orphan_blob_count > 0
          ? `（另有 ${report.orphan_blob_count} 份无引用孤儿文件可安全清理）`
          : ''
      }`,
    };
  }
  return {
    status: 'degraded',
    headline: `检出异常：${report.corrupted_count} 份哈希失配、${report.missing_count} 份缺失（共影响 ${report.impacts.length} 组快照）`,
  };
}

/**
 * 规范化 GC 输入参数，防止非法负数或 0 保留数误操作。
 */
export function normalizeGcParams(olderThanDaysRaw: string, keepRecentRaw: string): {
  olderThanDays: number;
  keepRecentPerFile: number;
} {
  const days = Number.parseInt(olderThanDaysRaw, 10);
  const keep = Number.parseInt(keepRecentRaw, 10);
  return {
    olderThanDays: Number.isFinite(days) && days >= 0 ? Math.min(days, 3650) : 30,
    keepRecentPerFile: Number.isFinite(keep) && keep >= 1 ? Math.min(keep, 100) : 3,
  };
}
