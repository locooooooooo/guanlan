
import type {
  CapsuleMode,
  CapsulePreviewRequest,
  CapsulePreviewResponse,
} from '../services/apiTypes';

export function formatCapsuleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KiB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 2)} MiB`;
  return `${(mb / 1024).toFixed(2)} GiB`;
}

export interface CapsuleDraftParams {
  initiativeId?: string | null;
  fileIds?: string[];
  from?: string;
  to?: string;
  mode: CapsuleMode;
  sanitizeSecrets: boolean;
  excludedDirs?: string[];
  selectedFileIds?: string[] | null;
}

export function buildCapsulePreviewPayload(draft: CapsuleDraftParams): CapsulePreviewRequest {
  const fromTrim = draft.from?.trim() || null;
  const toTrim = draft.to?.trim() || null;
  return {
    initiative_id: draft.initiativeId?.trim() || null,
    file_ids: draft.fileIds && draft.fileIds.length > 0 ? draft.fileIds : [],
    from: fromTrim,
    to: toTrim,
    mode: draft.mode,
    sanitize_secrets: draft.sanitizeSecrets,
    excluded_dirs: draft.excludedDirs && draft.excludedDirs.length > 0 ? draft.excludedDirs : [],
    selected_file_ids: draft.selectedFileIds === undefined ? null : draft.selectedFileIds,
  };
}

/**
 * 停机红线客户端双重门禁：
 * 必须具备最新有效 preview_token、至少勾选 1 份文件、不在加载/导出中、且用户已显式勾选确认框。
 */
export function canConfirmCapsuleExport(opts: {
  preview: CapsulePreviewResponse | null;
  previewLoading: boolean;
  exporting: boolean;
  confirmedPreview: boolean;
}): boolean {
  if (opts.previewLoading || opts.exporting || !opts.confirmedPreview) return false;
  if (!opts.preview || !opts.preview.ok) return false;
  if (!opts.preview.preview_token || opts.preview.preview_token.trim().length === 0) return false;
  return opts.preview.selected_file_count > 0;
}

export interface CapsuleEvidenceLine {
  lineNumber: number;
  text: string;
  highlighted: boolean;
}

/**
 * 在开放胶囊已读文本中切片目标行号区间（1-based 闭区间），返回带上下文窗口的逐行视图。
 */
export function sliceCapsuleEvidenceLines(
  text: string,
  lineStart: number,
  lineEnd: number,
  contextLines = 4
): CapsuleEvidenceLine[] {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  if (rawLines.length === 0) return [];
  const total = rawLines.length;
  const start = Math.max(1, Math.min(total, Math.floor(lineStart || 1)));
  const end = Math.max(start, Math.min(total, Math.floor(lineEnd || start)));
  const winStart = Math.max(1, start - Math.max(0, contextLines));
  const winEnd = Math.min(total, end + Math.max(0, contextLines));
  const out: CapsuleEvidenceLine[] = [];
  for (let ln = winStart; ln <= winEnd; ln += 1) {
    out.push({
      lineNumber: ln,
      text: rawLines[ln - 1] ?? '',
      highlighted: ln >= start && ln <= end,
    });
  }
  return out;
}
