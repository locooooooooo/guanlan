import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { ContentRole, DecisionAssertion, FileRecord } from '../types/guanlan';
import type { FileMutationResponse } from '../services/apiTypes';
import {
  folderOfRelativePath,
  postMoveFile,
  postRenameFile,
  postTrashFile,
} from '../services/workspaceClient';
import type { FileOpActionTarget } from '../components/FileContextMenu';
import type {
  FileOpModalKind,
  FileOpModalRequest,
  FileOpSubmitPayload,
} from '../components/FileOpsModal';
import {
  collectWorkspaceFolderOptions,
  describeFileMutationSuccess,
  formatFromFileName,
} from '../utils/fileOps';

export interface UseFileOpsOptions {
  workspaceEpoch: number;
  files: FileRecord[];
  decisions: DecisionAssertion[];
  fileCacheRef: MutableRefObject<Map<string, FileRecord>>;
  detailLoadedIdsRef: MutableRefObject<Set<string>>;
  publishFiles: () => void;
  onMutationSuccess: (resp: FileMutationResponse, message: string) => void;
}

/**
 * 身份保真文件操作状态与执行 Hook（独立抽离，避免继续向 App.tsx 堆叠业务逻辑）。
 */
export function useFileOps({
  workspaceEpoch,
  files,
  decisions,
  fileCacheRef,
  detailLoadedIdsRef,
  publishFiles,
  onMutationSuccess,
}: UseFileOpsOptions) {
  const [modalRequest, setModalRequest] = useState<FileOpModalRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    setModalRequest(null);
    setSubmitting(false);
    setServerError(null);
  }, [workspaceEpoch]);

  const folderOptions = useMemo(() => collectWorkspaceFolderOptions(files), [files]);

  const openFileOp = useCallback(
    (kind: FileOpModalKind, target: FileOpActionTarget) => {
      const cached = fileCacheRef.current.get(target.fileId);
      const format = cached?.format ?? formatFromFileName(target.relativePath) ?? 'md';
      const lastVersion = cached?.revisions[cached.revisions.length - 1]?.versionNumber ?? 0;
      const revisionCount = cached
        ? Math.max(cached.revisions.length, lastVersion)
        : undefined;
      const linkedDecisionCount = decisions.filter((d) =>
        d.evidences.some((ev) => ev.file_id === target.fileId)
      ).length;

      setServerError(null);
      setModalRequest({
        kind,
        fileId: target.fileId,
        relativePath: cached?.relative_path ?? target.relativePath,
        title: cached?.title ?? target.title,
        format,
        revisionCount,
        linkedDecisionCount,
      });
    },
    [decisions, fileCacheRef]
  );

  const closeFileOp = useCallback(() => {
    if (submitting) return;
    setModalRequest(null);
    setServerError(null);
  }, [submitting]);

  const resetFileOp = useCallback(() => {
    setModalRequest(null);
    setSubmitting(false);
    setServerError(null);
  }, []);

  const submitFileOp = useCallback(
    async (payload: FileOpSubmitPayload): Promise<boolean> => {
      setSubmitting(true);
      setServerError(null);
      try {
        const result =
          payload.kind === 'rename'
            ? await postRenameFile(payload.fileId, payload.newName)
            : payload.kind === 'move'
              ? await postMoveFile(payload.fileId, payload.targetDir, payload.newName)
              : await postTrashFile(payload.fileId, payload.confirm);

        if (!result.ok || !result.data) {
          setServerError(result.error || '文件操作失败，请检查目标路径或权限后重试');
          return false;
        }

        const resp = result.data;
        detailLoadedIdsRef.current.delete(resp.file_id);

        if (resp.operation === 'file_trashed') {
          fileCacheRef.current.delete(resp.file_id);
        } else if (resp.new_path) {
          const existing = fileCacheRef.current.get(resp.file_id);
          if (existing) {
            const prevPaths = Array.from(
              new Set([...(existing.previous_paths ?? []), resp.old_path])
            ).filter((p) => p !== resp.new_path);
            fileCacheRef.current.set(resp.file_id, {
              ...existing,
              relative_path: resp.new_path,
              previous_paths: prevPaths.length > 0 ? prevPaths : existing.previous_paths,
              title: resp.title || existing.title,
              folder: folderOfRelativePath(resp.new_path),
              role: (resp.role as ContentRole) || existing.role,
            });
          }
        }
        publishFiles();
        setModalRequest(null);
        setServerError(null);
        onMutationSuccess(resp, describeFileMutationSuccess(resp));
        return true;
      } finally {
        setSubmitting(false);
      }
    },
    [detailLoadedIdsRef, fileCacheRef, onMutationSuccess, publishFiles]
  );

  return {
    fileOpModal: modalRequest,
    fileOpSubmitting: submitting,
    fileOpError: serverError,
    folderOptions,
    openFileOp,
    closeFileOp,
    resetFileOp,
    submitFileOp,
  };
}
