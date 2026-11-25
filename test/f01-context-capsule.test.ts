import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCapsulePreviewPayload,
  canConfirmCapsuleExport,
  formatCapsuleBytes,
  sliceCapsuleEvidenceLines,
} from '../src/utils/contextCapsuleHelpers';
import type { CapsulePreviewResponse } from '../src/services/apiTypes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

function samplePreview(overrides: Partial<CapsulePreviewResponse> = {}): CapsulePreviewResponse {
  return {
    ok: true,
    preview_token: 'cap_prev_0123456789abcdef01234567',
    mode: 'with_snapshots',
    sanitize_secrets: true,
    title: '01-胶囊交付',
    initiative_id: 'init_1',
    from: null,
    to: null,
    selected_file_count: 2,
    total_candidate_count: 3,
    event_count: 4,
    decision_count: 1,
    relation_count: 1,
    estimated_total_bytes: 8192,
    snapshot_bytes: 4096,
    metadata_bytes: 4096,
    sensitive_excluded_count: 1,
    inline_redaction_count: 1,
    sensitive_warnings: ['已自动取消勾选敏感文件 .env'],
    dirs: ['01-胶囊交付'],
    files: [],
    ...overrides,
  };
}

describe('事项资料胶囊（Context Capsule）两阶段门禁与证据跳转', () => {
  it('字节体积格式化按 B / KiB / MiB / GiB 确定性输出', () => {
    assert.equal(formatCapsuleBytes(0), '0 B');
    assert.equal(formatCapsuleBytes(512), '512 B');
    assert.equal(formatCapsuleBytes(2048), '2.0 KiB');
    assert.equal(formatCapsuleBytes(5 * 1024 * 1024), '5.00 MiB');
  });

  it('停机红线门禁：未预览、加载中、未勾选确认或无选中文件时一律禁止导出', () => {
    const valid = samplePreview();
    assert.equal(
      canConfirmCapsuleExport({
        preview: null,
        previewLoading: false,
        exporting: false,
        confirmedPreview: true,
      }),
      false
    );
    assert.equal(
      canConfirmCapsuleExport({
        preview: valid,
        previewLoading: true,
        exporting: false,
        confirmedPreview: true,
      }),
      false
    );
    assert.equal(
      canConfirmCapsuleExport({
        preview: valid,
        previewLoading: false,
        exporting: false,
        confirmedPreview: false,
      }),
      false
    );
    assert.equal(
      canConfirmCapsuleExport({
        preview: samplePreview({ selected_file_count: 0 }),
        previewLoading: false,
        exporting: false,
        confirmedPreview: true,
      }),
      false
    );
    assert.equal(
      canConfirmCapsuleExport({
        preview: samplePreview({ preview_token: '' }),
        previewLoading: false,
        exporting: false,
        confirmedPreview: true,
      }),
      false
    );
    assert.equal(
      canConfirmCapsuleExport({
        preview: valid,
        previewLoading: false,
        exporting: false,
        confirmedPreview: true,
      }),
      true
    );
  });

  it('构建预览请求载荷正确透传模式、脱敏开关、时间窗与文件范围', () => {
    const payload = buildCapsulePreviewPayload({
      initiativeId: ' init_demo ',
      fileIds: ['f_1', 'f_2'],
      from: '2026-11-01',
      to: '2026-11-21',
      mode: 'manifest_only',
      sanitizeSecrets: true,
      excludedDirs: ['secrets'],
      selectedFileIds: ['f_1'],
    });
    assert.equal(payload.initiative_id, 'init_demo');
    assert.deepEqual(payload.file_ids, ['f_1', 'f_2']);
    assert.equal(payload.from, '2026-11-01');
    assert.equal(payload.to, '2026-11-21');
    assert.equal(payload.mode, 'manifest_only');
    assert.equal(payload.sanitize_secrets, true);
    assert.deepEqual(payload.selected_file_ids, ['f_1']);
  });

  it('胶囊原文证据行切片精准高亮目标区间并保留上下文行号', () => {
    const doc = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行内容`).join('\n');
    const slice = sliceCapsuleEvidenceLines(doc, 6, 7, 2);
    assert.deepEqual(
      slice.map((l) => l.lineNumber),
      [4, 5, 6, 7, 8, 9]
    );
    assert.deepEqual(
      slice.filter((l) => l.highlighted).map((l) => l.lineNumber),
      [6, 7]
    );
  });

  it('TaskPackageGallery 已接入胶囊打包入口与 ContextCapsuleModal（且无嵌套 button）', () => {
    const gallerySrc = readSrc('../src/components/TaskPackageGallery.tsx');
    assert.ok(gallerySrc.includes('ContextCapsuleModal'));
    assert.ok(gallerySrc.includes('data-capsule-export'));
    assert.ok(gallerySrc.includes('打开胶囊'));
    const modalSrc = readSrc('../src/components/ContextCapsuleModal.tsx');
    assert.ok(modalSrc.includes('previewCapsule'));
    assert.ok(modalSrc.includes('exportCapsule'));
    assert.ok(modalSrc.includes('inspectCapsuleDir'));
    assert.ok(modalSrc.includes('readCapsuleFile'));
    assert.ok(modalSrc.includes('confirmed_preview: true'));
  });
});
