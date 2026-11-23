import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canExecuteStorageGc,
  normalizeGcParams,
  summarizeIntegrityReport,
} from '../src/utils/storageMaintenanceHelpers';
import type { BlobIntegrityReport, StorageGcResponse } from '../src/services/apiTypes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

function sampleDryRun(overrides: Partial<StorageGcResponse> = {}): StorageGcResponse {
  return {
    ok: true,
    dry_run: true,
    older_than_days: 30,
    keep_recent_per_file: 3,
    total_revisions_with_snapshot: 12,
    protected_revisions_count: 9,
    protected_decision_evidence_count: 3,
    protected_edge_evidence_count: 2,
    protected_governance_event_count: 1,
    pruned_revisions_count: 3,
    deleted_blobs_count: 2,
    deleted_orphan_blobs_count: 1,
    skipped_shared_blob_count: 1,
    reclaimed_bytes: 128_000,
    protected_bytes: 512_000,
    pruned_samples: [],
    ...overrides,
  };
}

describe('F02：全量开放导出、决定证据铁律保护 GC 与 SHA-256 完整性核验', () => {
  it('GC 执行门禁：未预演、参数变动或无可清理项时一律禁用真实执行', () => {
    const dry = sampleDryRun();
    assert.equal(
      canExecuteStorageGc({
        dryRunReport: null,
        olderThanDays: 30,
        keepRecentPerFile: 3,
        removeOrphanBlobs: true,
        busy: false,
      }),
      false
    );
    // 参数漂移后旧预演失效
    assert.equal(
      canExecuteStorageGc({
        dryRunReport: dry,
        olderThanDays: 7,
        keepRecentPerFile: 3,
        removeOrphanBlobs: true,
        busy: false,
      }),
      false
    );
    // 无可清理项不允许误触执行
    assert.equal(
      canExecuteStorageGc({
        dryRunReport: sampleDryRun({
          pruned_revisions_count: 0,
          deleted_blobs_count: 0,
          deleted_orphan_blobs_count: 0,
        }),
        olderThanDays: 30,
        keepRecentPerFile: 3,
        removeOrphanBlobs: true,
        busy: false,
      }),
      false
    );
    // 匹配当前参数且有可清理项才放行
    assert.equal(
      canExecuteStorageGc({
        dryRunReport: dry,
        olderThanDays: 30,
        keepRecentPerFile: 3,
        removeOrphanBlobs: true,
        busy: false,
      }),
      true
    );
  });

  it('完整性报告摘要 100% 诚实区分健康态与损坏/缺失受损态', () => {
    const okReport: BlobIntegrityReport = {
      ok: true,
      verified_at: '2026-11-22T00:00:00.000Z',
      checked_blobs: 10,
      healthy_blobs: 10,
      corrupted_count: 0,
      missing_count: 0,
      orphan_blob_count: 2,
      orphan_blob_bytes: 1024,
      total_verified_bytes: 40960,
      impacts: [],
    };
    const okSum = summarizeIntegrityReport(okReport);
    assert.equal(okSum.status, 'healthy');
    assert.ok(okSum.headline.includes('10 份活跃快照'));

    const broken: BlobIntegrityReport = {
      ...okReport,
      ok: false,
      healthy_blobs: 8,
      corrupted_count: 1,
      missing_count: 1,
      impacts: [
        {
          content_hash: 'aaaa',
          issue_kind: 'hash_mismatch',
          detail: 'SHA-256 校验失败',
          expected_bytes: 100,
          actual_bytes: 99,
          actual_hash: 'bbbb',
          impacted_revisions: [],
          impacted_decisions: [],
          impacted_event_count: 1,
        },
        {
          content_hash: 'cccc',
          issue_kind: 'missing',
          detail: '磁盘快照缺失',
          expected_bytes: 50,
          actual_bytes: null,
          actual_hash: null,
          impacted_revisions: [],
          impacted_decisions: [],
          impacted_event_count: 0,
        },
      ],
    };
    const brokenSum = summarizeIntegrityReport(broken);
    assert.equal(brokenSum.status, 'degraded');
    assert.ok(brokenSum.headline.includes('1 份哈希失配'));
    assert.ok(brokenSum.headline.includes('1 份缺失'));
  });

  it('GC 参数规范化拦截负数与非法 0 保留数', () => {
    assert.deepEqual(normalizeGcParams('-5', '0'), {
      olderThanDays: 30,
      keepRecentPerFile: 3,
    });
    assert.deepEqual(normalizeGcParams('0', '1'), {
      olderThanDays: 0,
      keepRecentPerFile: 1,
    });
  });

  it('StorageUsageSection 已接入完整性校验、铁律保护 GC、全量开放导出与脱敏诊断 ZIP', () => {
    const src = readSrc('../src/components/StorageUsageSection.tsx');
    for (const token of [
      'verifyStorageIntegrity',
      'runStorageGc',
      'exportWorkspaceOpenArchive',
      'exportDiagnosticZip',
      'diagnosticZipDownloadUrl',
      '铁律保护',
    ]) {
      assert.ok(src.includes(token), `StorageUsageSection 缺 ${token}`);
    }
  });
});
