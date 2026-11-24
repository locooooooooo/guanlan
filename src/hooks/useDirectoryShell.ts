/**
 * Quiet.md 风格全局常驻目录侧栏状态与文件夹/批量操作编排 Hook。
 *
 * 职责：
 * - 全局侧栏宽度（可拖拽调整）与折叠态持久化；
 * - 拉取并刷新工作区真实目录清单（含空文件夹，GET /api/v1/folders）；
 * - 工作区级置顶文件清单（localStorage 隔离持久化）；
 * - 挂载参考工作区目录树按需懒加载（GET /api/v1/mounts/{mount_id}/files）；
 * - 文件夹新建/重命名/移动/回收站、新建文档、批量移动/回收站执行与弹窗态。
 */

import { useCallback, useEffect, useState } from 'react';
import type { MountedFilesResponseDto } from '../services/apiTypes';
import {
  fetchMountedFiles,
  fetchWorkspaceFolders,
  postBatchMoveFiles,
  postBatchTrashFiles,
  postCreateDocument,
  postCreateFolder,
  postMoveFolder,
  postRenameFolder,
  postTrashFolder,
} from '../services/workspaceClient';
import {
  clampSidebarWidth,
  loadPinnedFileIds,
  loadSidebarShellPrefs,
  normalizeFolderPath,
  savePinnedFileIds,
  saveSidebarShellPrefs,
} from '../utils/sidebarTree';

export type DirOpModalRequest =
  | { kind: 'folder-move'; folderPath: string }
  | { kind: 'folder-trash'; folderPath: string; affectedCount: number }
  | { kind: 'batch-move'; fileIds: string[] }
  | { kind: 'batch-trash'; fileIds: string[]; sampleNames: string[] };

export interface MountedTreeCacheEntry {
  loading: boolean;
  error?: string;
  data?: MountedFilesResponseDto;
}

export interface UseDirectoryShellOptions {
  enabled: boolean;
  workspaceScopeKey: string;
  workspaceEpoch: number;
  bootstrapNonce: number;
  onSyncAfterMutation: (opts?: {
    renamedFolder?: { from: string; to: string };
    trashedFolder?: string;
    openNewFileId?: string;
  }) => void;
  showToast: (
    tone: 'ok' | 'warn' | 'error',
    text: string,
    actions?: { revealPath?: string; openPath?: string }
  ) => void;
}

export function useDirectoryShell({
  enabled,
  workspaceScopeKey,
  workspaceEpoch,
  bootstrapNonce,
  onSyncAfterMutation,
  showToast,
}: UseDirectoryShellOptions) {
  const [sidebarPrefs, setSidebarPrefs] = useState(() => loadSidebarShellPrefs());
  // 画布/全景视图默认收起左侧目录栏（为星图与版本时光机让出空间），用户可随时一键展开
  const [panoramaSidebarOpen, setPanoramaSidebarOpen] = useState(false);
  const [realFolders, setRealFolders] = useState<string[]>([]);
  const [pinnedFileIds, setPinnedFileIds] = useState<string[]>(() =>
    loadPinnedFileIds(workspaceScopeKey)
  );
  const [mountedTrees, setMountedTrees] = useState<Record<string, MountedTreeCacheEntry>>({});
  const [dirOpModal, setDirOpModal] = useState<DirOpModalRequest | null>(null);
  const [dirOpSubmitting, setDirOpSubmitting] = useState(false);
  const [dirOpError, setDirOpError] = useState<string | null>(null);

  useEffect(() => {
    setPinnedFileIds(loadPinnedFileIds(workspaceScopeKey));
  }, [workspaceScopeKey]);

  useEffect(() => {
    setDirOpModal(null);
    setDirOpError(null);
    setDirOpSubmitting(false);
    setMountedTrees({});
  }, [workspaceEpoch]);

  const setSidebarWidth = useCallback((width: number) => {
    setSidebarPrefs((prev) => {
      const next = { ...prev, width: clampSidebarWidth(width) };
      saveSidebarShellPrefs(next);
      return next;
    });
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarPrefs((prev) => {
      const next = { ...prev, collapsed };
      saveSidebarShellPrefs(next);
      return next;
    });
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarPrefs((prev) => {
      const next = { ...prev, collapsed: !prev.collapsed };
      saveSidebarShellPrefs(next);
      return next;
    });
  }, []);

  const togglePanoramaSidebar = useCallback(() => {
    setPanoramaSidebarOpen((v) => !v);
  }, []);

  const refreshWorkspaceFolders = useCallback(async () => {
    if (!enabled) return;
    const res = await fetchWorkspaceFolders();
    if (res.ok && res.data && Array.isArray(res.data.folders)) {
      setRealFolders(res.data.folders);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refreshWorkspaceFolders();
  }, [enabled, workspaceEpoch, bootstrapNonce, refreshWorkspaceFolders]);

  const togglePinFile = useCallback(
    (fileId: string) => {
      setPinnedFileIds((prev) => {
        const exists = prev.includes(fileId);
        const next = exists ? prev.filter((id) => id !== fileId) : [fileId, ...prev];
        savePinnedFileIds(workspaceScopeKey, next);
        return next;
      });
    },
    [workspaceScopeKey]
  );

  const loadMountedTree = useCallback(async (mountId: string, force = false) => {
    setMountedTrees((prev) => {
      const cur = prev[mountId];
      if (!force && cur && (cur.loading || cur.data)) return prev;
      return { ...prev, [mountId]: { loading: true, data: cur?.data } };
    });
    const res = await fetchMountedFiles(mountId);
    setMountedTrees((prev) => {
      if (res.ok && res.data) {
        return { ...prev, [mountId]: { loading: false, data: res.data } };
      }
      return {
        ...prev,
        [mountId]: {
          loading: false,
          error: res.error || '无法读取该挂载目录结构',
          data: prev[mountId]?.data,
        },
      };
    });
  }, []);

  const handleCreateFolder = useCallback(
    async (parentDir: string, name: string): Promise<string | null> => {
      const res = await postCreateFolder(normalizeFolderPath(parentDir), name.trim());
      if (!res.ok || !res.data) {
        showToast('error', res.error || '新建文件夹失败');
        return null;
      }
      const createdPath = res.data.new_path || name.trim();
      await refreshWorkspaceFolders();
      onSyncAfterMutation();
      showToast('ok', `已新建文件夹「${createdPath}」`);
      return createdPath;
    },
    [onSyncAfterMutation, refreshWorkspaceFolders, showToast]
  );

  const handleCreateDocument = useCallback(
    async (targetDir: string, name: string): Promise<string | null> => {
      const res = await postCreateDocument(normalizeFolderPath(targetDir), name.trim());
      if (!res.ok || !res.data) {
        showToast('error', res.error || '新建文档失败');
        return null;
      }
      const created = res.data;
      await refreshWorkspaceFolders();
      onSyncAfterMutation({ openNewFileId: created.file_id });
      showToast('ok', `已新建文档「${created.relative_path}」`);
      return created.file_id;
    },
    [onSyncAfterMutation, refreshWorkspaceFolders, showToast]
  );

  const handleRenameFolder = useCallback(
    async (folderPath: string, newName: string): Promise<boolean> => {
      const norm = normalizeFolderPath(folderPath);
      const res = await postRenameFolder(norm, newName.trim());
      if (!res.ok || !res.data) {
        showToast('error', res.error || '重命名文件夹失败');
        return false;
      }
      const nextPath = res.data.new_path || norm;
      await refreshWorkspaceFolders();
      onSyncAfterMutation({ renamedFolder: { from: norm, to: nextPath } });
      showToast(
        'ok',
        res.data.affected_files > 0
          ? `已重命名文件夹为「${nextPath}」（${res.data.affected_files} 份文件身份保持连续）`
          : `已重命名文件夹为「${nextPath}」`
      );
      return true;
    },
    [onSyncAfterMutation, refreshWorkspaceFolders, showToast]
  );

  const handleMoveFolder = useCallback(
    async (folderPath: string, targetParentDir: string): Promise<boolean> => {
      const norm = normalizeFolderPath(folderPath);
      const res = await postMoveFolder(norm, normalizeFolderPath(targetParentDir));
      if (!res.ok || !res.data) {
        const msg = res.error || '移动文件夹失败';
        setDirOpError(msg);
        showToast('error', msg);
        return false;
      }
      const nextPath = res.data.new_path || norm;
      setDirOpModal(null);
      setDirOpError(null);
      await refreshWorkspaceFolders();
      onSyncAfterMutation({ renamedFolder: { from: norm, to: nextPath } });
      showToast(
        'ok',
        res.data.affected_files > 0
          ? `已移动文件夹至「${nextPath}」（${res.data.affected_files} 份文件身份保持连续）`
          : `已移动文件夹至「${nextPath}」`
      );
      return true;
    },
    [onSyncAfterMutation, refreshWorkspaceFolders, showToast]
  );

  const handleTrashFolder = useCallback(
    async (folderPath: string, confirm: boolean): Promise<boolean> => {
      const norm = normalizeFolderPath(folderPath);
      const res = await postTrashFolder(norm, confirm);
      if (!res.ok || !res.data) {
        const msg = res.error || '文件夹移入回收站失败';
        setDirOpError(msg);
        showToast('error', msg);
        return false;
      }
      setDirOpModal(null);
      setDirOpError(null);
      await refreshWorkspaceFolders();
      onSyncAfterMutation({ trashedFolder: norm });
      showToast(
        'warn',
        `文件夹「${norm}」（含 ${res.data.affected_files} 份文件）已移入系统回收站，可随时还原`
      );
      return true;
    },
    [onSyncAfterMutation, refreshWorkspaceFolders, showToast]
  );

  const handleBatchMoveFiles = useCallback(
    async (fileIds: string[], targetDir: string): Promise<boolean> => {
      const normTarget = normalizeFolderPath(targetDir);
      const res = await postBatchMoveFiles(fileIds, normTarget);
      if (!res.ok || !res.data) {
        const msg = res.error || '批量移动失败';
        setDirOpError(msg);
        showToast('error', msg);
        return false;
      }
      setDirOpModal(null);
      setDirOpError(null);
      await refreshWorkspaceFolders();
      onSyncAfterMutation();
      const okCount = res.data.succeeded.length;
      const failCount = res.data.failed.length;
      const destLabel = normTarget || '工作区根目录';
      showToast(
        failCount > 0 ? 'warn' : 'ok',
        failCount > 0
          ? `批量移动完成：${okCount} 份已移至「${destLabel}」，${failCount} 份失败`
          : `已将 ${okCount} 份文件批量移至「${destLabel}」（file_id 保持连续）`
      );
      return okCount > 0;
    },
    [onSyncAfterMutation, refreshWorkspaceFolders, showToast]
  );

  const handleBatchTrashFiles = useCallback(
    async (fileIds: string[], confirm: boolean): Promise<boolean> => {
      const res = await postBatchTrashFiles(fileIds, confirm);
      if (!res.ok || !res.data) {
        const msg = res.error || '批量移入回收站失败';
        setDirOpError(msg);
        showToast('error', msg);
        return false;
      }
      setDirOpModal(null);
      setDirOpError(null);
      await refreshWorkspaceFolders();
      onSyncAfterMutation();
      const okCount = res.data.succeeded.length;
      const failCount = res.data.failed.length;
      showToast(
        'warn',
        failCount > 0
          ? `批量回收完成：${okCount} 份已移入系统回收站，${failCount} 份失败`
          : `已将 ${okCount} 份文件移入系统回收站，可随时还原`
      );
      return okCount > 0;
    },
    [onSyncAfterMutation, refreshWorkspaceFolders, showToast]
  );

  const submitDirOpModal = useCallback(
    async (payload: { targetDir?: string; confirm?: boolean }): Promise<boolean> => {
      if (!dirOpModal) return false;
      setDirOpSubmitting(true);
      setDirOpError(null);
      try {
        switch (dirOpModal.kind) {
          case 'folder-move':
            return await handleMoveFolder(dirOpModal.folderPath, payload.targetDir ?? '');
          case 'folder-trash':
            return await handleTrashFolder(dirOpModal.folderPath, Boolean(payload.confirm));
          case 'batch-move':
            return await handleBatchMoveFiles(dirOpModal.fileIds, payload.targetDir ?? '');
          case 'batch-trash':
            return await handleBatchTrashFiles(dirOpModal.fileIds, Boolean(payload.confirm));
        }
      } finally {
        setDirOpSubmitting(false);
      }
    },
    [
      dirOpModal,
      handleBatchMoveFiles,
      handleBatchTrashFiles,
      handleMoveFolder,
      handleTrashFolder,
    ]
  );

  return {
    sidebarWidth: sidebarPrefs.width,
    sidebarCollapsed: sidebarPrefs.collapsed,
    panoramaSidebarOpen,
    setPanoramaSidebarOpen,
    togglePanoramaSidebar,
    setSidebarWidth,
    setSidebarCollapsed,
    toggleSidebarCollapsed,
    realFolders,
    refreshWorkspaceFolders,
    pinnedFileIds,
    togglePinFile,
    mountedTrees,
    loadMountedTree,
    dirOpModal,
    dirOpSubmitting,
    dirOpError,
    openDirOpModal: (req: DirOpModalRequest) => {
      setDirOpError(null);
      setDirOpModal(req);
    },
    closeDirOpModal: () => {
      if (dirOpSubmitting) return;
      setDirOpModal(null);
      setDirOpError(null);
    },
    submitDirOpModal,
    handleCreateFolder,
    handleCreateDocument,
    handleRenameFolder,
    handleMoveFolder,
  };
}
