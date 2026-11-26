/**
 * Quiet.md 多项目并存管理 Hook（全局项目列表、多项目树懒加载、零重启焦点切换、
 * 跨项目总览汇总、跨项目置顶以及对任意非激活项目的原地目录/文档操控）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectEntryDto,
  ProjectsOverviewResponseDto,
  ProjectTreeResponseDto,
} from '../services/apiTypes';
import {
  deleteProject,
  fetchProjects,
  fetchProjectsOverview,
  fetchProjectTree,
  patchProject,
  postActivateProject,
  postAddProject,
  postCreateDocumentInProject,
  postCreateFolderInProject,
  postMoveFileInProject,
  postMoveFolderInProject,
  postRenameFolderInProject,
  postRescanProject,
  postTrashFolderInProject,
} from '../services/workspaceClient';
import {
  expandedProjectsAfterActivate,
  loadExpandedProjects,
  loadGlobalPinnedFiles,
  normalizeFolderPath,
  saveExpandedProjects,
  saveGlobalPinnedFiles,
  type GlobalPinnedFile,
} from '../utils/sidebarTree';

export interface ProjectTreeCacheEntry {
  loading: boolean;
  error?: string;
  data?: ProjectTreeResponseDto;
}

export interface PendingCrossProjectTarget {
  projectId: string;
  folder?: string;
  fileId?: string;
  decisionId?: string;
  openTab?: 'home' | 'panorama' | 'library';
  libraryMode?: 'read' | 'overview';
}

export interface UseMultiProjectsOptions {
  enabled: boolean;
  workspaceEpoch: number;
  bootstrapNonce: number;
  onProjectActivated: (projectId: string, pendingTarget?: PendingCrossProjectTarget) => void;
  showToast: (
    tone: 'ok' | 'warn' | 'error',
    text: string,
    actions?: { revealPath?: string; openPath?: string }
  ) => void;
}

export function useMultiProjects({
  enabled,
  workspaceEpoch,
  bootstrapNonce,
  onProjectActivated,
  showToast,
}: UseMultiProjectsOptions) {
  const [projects, setProjects] = useState<ProjectEntryDto[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [overview, setOverview] = useState<ProjectsOverviewResponseDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [activatingProjectId, setActivatingProjectId] = useState<string | null>(null);
  const [projectTrees, setProjectTrees] = useState<Record<string, ProjectTreeCacheEntry>>({});
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(loadExpandedProjects())
  );
  const [globalPins, setGlobalPins] = useState<GlobalPinnedFile[]>(() => loadGlobalPinnedFiles());
  const [addProjectModalOpen, setAddProjectModalOpen] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [addProjectBusy, setAddProjectBusy] = useState(false);

  const expandedRef = useRef(expandedProjects);
  expandedRef.current = expandedProjects;

  const activeProject = useMemo(
    () => projects.find((p) => p.project_id === activeProjectId) ?? projects[0] ?? null,
    [projects, activeProjectId]
  );

  const loadProjectTree = useCallback(async (projectId: string, force = false) => {
    if (!projectId) return;
    setProjectTrees((prev) => {
      const cur = prev[projectId];
      if (!force && cur && (cur.loading || cur.data)) return prev;
      return { ...prev, [projectId]: { loading: true, data: cur?.data } };
    });
    const res = await fetchProjectTree(projectId, 2000);
    setProjectTrees((prev) => {
      if (res.ok && res.data) {
        return { ...prev, [projectId]: { loading: false, data: res.data } };
      }
      return {
        ...prev,
        [projectId]: {
          loading: false,
          error: res.error || '无法读取该项目目录树',
          data: prev[projectId]?.data,
        },
      };
    });
  }, []);

  const refreshAll = useCallback(
    async (opts: { reloadExpandedTrees?: boolean } = {}) => {
      if (!enabled) return;
      setLoading(true);
      const [listRes, ovRes] = await Promise.all([fetchProjects(), fetchProjectsOverview()]);
      setLoading(false);
      if (listRes.ok && listRes.data) {
        const nextList = listRes.data.projects;
        const nextActive = listRes.data.active_project_id;
        setProjects(nextList);
        setActiveProjectId(nextActive);
        // 首次进入默认展开当前激活项目，其余展开态沿用本地持久化
        if (nextActive && !expandedRef.current.has(nextActive)) {
          setExpandedProjects((prev) => {
            if (prev.has(nextActive)) return prev;
            const next = new Set(prev);
            next.add(nextActive);
            saveExpandedProjects(Array.from(next));
            return next;
          });
        }
        if (opts.reloadExpandedTrees) {
          for (const p of nextList) {
            if (p.project_id !== nextActive && expandedRef.current.has(p.project_id)) {
              void loadProjectTree(p.project_id, true);
            }
          }
        }
      }
      if (ovRes.ok && ovRes.data) {
        setOverview(ovRes.data);
      }
    },
    [enabled, loadProjectTree]
  );

  // 启动与数据变更时刷新全局多项目列表与总览
  useEffect(() => {
    if (!enabled) return;
    void refreshAll({ reloadExpandedTrees: true });
  }, [enabled, workspaceEpoch, bootstrapNonce, refreshAll]);

  // 有项目正在扫描时轻轮询（1.2s）直至全部就绪：只刷新项目列表与总览计数。
  // 目录树不跟着每拍重拉——扫描中的项目树每一拍都在变，这里带上 reloadExpandedTrees
  // 会把其它已展开项目的整棵树反复塞进只读连接池（见 query 子系统：目录枚举曾拖垮
  // 检索与翻页）。树改为扫描结束后补一次，或用户展开时取。
  const anyScanning = useMemo(
    () => projects.some((p) => p.is_scanning || p.status === 'scanning'),
    [projects]
  );
  useEffect(() => {
    if (!enabled || !anyScanning) return;
    const timer = setInterval(() => {
      void refreshAll();
    }, 1200);
    return () => clearInterval(timer);
  }, [enabled, anyScanning, refreshAll]);

  // 扫描收尾补一次目录树：扫描期间树没跟着轮询刷新，这里补上；只补已展开的
  // 非激活项目（激活项目的树由它自己的取数路径管）。
  const wasScanningRef = useRef(anyScanning);
  useEffect(() => {
    if (wasScanningRef.current && !anyScanning) {
      void refreshAll({ reloadExpandedTrees: true });
    }
    wasScanningRef.current = anyScanning;
  }, [anyScanning, refreshAll]);

  const toggleProjectExpanded = useCallback(
    (projectId: string) => {
      let willExpand = false;
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        if (next.has(projectId)) {
          next.delete(projectId);
        } else {
          next.add(projectId);
          willExpand = true;
        }
        saveExpandedProjects(Array.from(next));
        return next;
      });
      if (willExpand && projectId !== activeProjectId) {
        void loadProjectTree(projectId, true);
      }
    },
    [activeProjectId, loadProjectTree]
  );

  const handleAddProject = useCallback(
    async (input: {
      rootPath: string;
      name?: string;
      readonly?: boolean;
      activate?: boolean;
    }): Promise<boolean> => {
      const trimmed = input.rootPath.trim();
      if (!trimmed) {
        setAddProjectError('请输入或选择项目文件夹路径');
        return false;
      }
      setAddProjectBusy(true);
      setAddProjectError(null);
      const res = await postAddProject({
        root_path: trimmed,
        name: input.name?.trim() || undefined,
        readonly: Boolean(input.readonly),
        activate: Boolean(input.activate),
      });
      setAddProjectBusy(false);
      if (!res.ok || !res.data) {
        const msg = res.error || '添加项目失败';
        setAddProjectError(msg);
        showToast('error', msg);
        return false;
      }
      const added = res.data.project;
      setProjects(res.data.projects);
      setActiveProjectId(res.data.active_project_id);
      const nextActiveId = res.data.active_project_id;
      setExpandedProjects((prev) => {
        // 添加并激活相当于一次聚焦切换：新项目展开，旧的聚焦项目收起；
        // 只添加不激活时保留当前展开集（多项目同时展开仍是显式能力）。
        const next =
          nextActiveId && nextActiveId !== activeProjectId
            ? new Set([
                ...expandedProjectsAfterActivate(prev, activeProjectId, nextActiveId),
                added.project_id,
              ])
            : new Set([...prev, added.project_id]);
        saveExpandedProjects(Array.from(next));
        return next;
      });
      setAddProjectModalOpen(false);
      setAddProjectError(null);
      void loadProjectTree(added.project_id, true);
      void refreshAll();
      if (input.activate) {
        onProjectActivated(added.project_id);
      }
      showToast(
        'ok',
        `已加入项目「${added.name}」${added.readonly ? '（只读保护）' : ''}，正在后台自动建立索引`
      );
      return true;
    },
    [activeProjectId, loadProjectTree, onProjectActivated, refreshAll, showToast]
  );

  const handleActivateProject = useCallback(
    async (projectId: string, pendingTarget?: PendingCrossProjectTarget): Promise<boolean> => {
      if (!projectId) return false;
      if (projectId === activeProjectId) {
        onProjectActivated(projectId, pendingTarget);
        return true;
      }
      setActivatingProjectId(projectId);
      const res = await postActivateProject(projectId);
      setActivatingProjectId(null);
      if (!res.ok || !res.data) {
        showToast('error', res.error || '切换项目失败');
        return false;
      }
      setProjects(res.data.projects);
      setActiveProjectId(res.data.active_project_id);
      setExpandedProjects((prev) => {
        // 聚焦切换：新项目展开，旧的聚焦项目收起；用户手动展开的其他项目保持。
        // 不能因新项目已在展开集里就提前返回——旧聚焦项目仍要收起。
        const next = new Set(
          expandedProjectsAfterActivate(
            prev,
            activeProjectId,
            res.data.active_project_id || projectId
          )
        );
        saveExpandedProjects(Array.from(next));
        return next;
      });
      onProjectActivated(projectId, pendingTarget);
      void refreshAll();
      return true;
    },
    [activeProjectId, onProjectActivated, refreshAll, showToast]
  );

  const handleUpdateProject = useCallback(
    async (
      projectId: string,
      patch: { name?: string; readonly?: boolean }
    ): Promise<boolean> => {
      const res = await patchProject(projectId, patch);
      if (!res.ok || !res.data) {
        showToast('error', res.error || '更新项目设置失败');
        return false;
      }
      setProjects(res.data.projects);
      setActiveProjectId(res.data.active_project_id);
      // 同步跨项目置顶里的项目名称
      if (patch.name) {
        const nextName = res.data.project.name;
        setGlobalPins((prev) => {
          const next = prev.map((pin) =>
            pin.projectId === projectId ? { ...pin, projectName: nextName } : pin
          );
          saveGlobalPinnedFiles(next);
          return next;
        });
      }
      void refreshAll({ reloadExpandedTrees: true });
      if (patch.readonly !== undefined) {
        showToast(
          'ok',
          patch.readonly
            ? `已为「${res.data.project.name}」开启只读归档保护`
            : `已为「${res.data.project.name}」恢复完整读写模式`
        );
      } else if (patch.name) {
        showToast('ok', `项目已更名为「${res.data.project.name}」`);
      }
      return true;
    },
    [refreshAll, showToast]
  );

  const handleRemoveProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      const target = projects.find((p) => p.project_id === projectId);
      const wasActive = projectId === activeProjectId;
      const res = await deleteProject(projectId);
      if (!res.ok || !res.data) {
        showToast('error', res.error || '移出项目失败');
        return false;
      }
      setProjects(res.data.projects);
      setActiveProjectId(res.data.active_project_id);
      setProjectTrees((prev) => {
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
      setGlobalPins((prev) => {
        const next = prev.filter((p) => p.projectId !== projectId);
        saveGlobalPinnedFiles(next);
        return next;
      });
      if (wasActive && res.data.active_project_id) {
        onProjectActivated(res.data.active_project_id);
      }
      void refreshAll();
      showToast('ok', `已将「${target?.name || projectId}」从观澜列表移出（磁盘原文件未动）`);
      return true;
    },
    [activeProjectId, onProjectActivated, projects, refreshAll, showToast]
  );

  const handleRescanProject = useCallback(
    async (projectId: string) => {
      const res = await postRescanProject(projectId);
      if (!res.ok) {
        showToast('error', res.error || '触发扫描失败');
        return;
      }
      const target = projects.find((p) => p.project_id === projectId);
      showToast('ok', `已开始重新扫描「${target?.name || projectId}」`);
      void refreshAll({ reloadExpandedTrees: true });
    },
    [projects, refreshAll, showToast]
  );

  // ===== 跨项目置顶 =====
  const toggleGlobalPin = useCallback((item: GlobalPinnedFile) => {
    setGlobalPins((prev) => {
      const exists = prev.some(
        (p) => p.projectId === item.projectId && p.fileId === item.fileId
      );
      const next = exists
        ? prev.filter((p) => !(p.projectId === item.projectId && p.fileId === item.fileId))
        : [item, ...prev];
      saveGlobalPinnedFiles(next);
      return next;
    });
  }, []);

  // ===== 对任意非激活项目的原地目录/文档 CRUD =====
  const handleCreateFolderInProject = useCallback(
    async (projectId: string, parentDir: string, name: string): Promise<string | null> => {
      const res = await postCreateFolderInProject(
        projectId,
        normalizeFolderPath(parentDir),
        name.trim()
      );
      if (!res.ok || !res.data) {
        showToast('error', res.error || '新建文件夹失败');
        return null;
      }
      await loadProjectTree(projectId, true);
      void refreshAll();
      showToast('ok', `已新建文件夹「${res.data.new_path || name.trim()}」`);
      return res.data.new_path || name.trim();
    },
    [loadProjectTree, refreshAll, showToast]
  );

  const handleCreateDocumentInProject = useCallback(
    async (projectId: string, targetDir: string, name: string): Promise<string | null> => {
      const res = await postCreateDocumentInProject(
        projectId,
        normalizeFolderPath(targetDir),
        name.trim()
      );
      if (!res.ok || !res.data) {
        showToast('error', res.error || '新建文档失败');
        return null;
      }
      await loadProjectTree(projectId, true);
      void refreshAll();
      showToast('ok', `已新建文档「${res.data.relative_path}」`);
      // 新建后直接切到该项目并打开文档进行阅读
      await handleActivateProject(projectId, {
        projectId,
        fileId: res.data.file_id,
        openTab: 'library',
        libraryMode: 'read',
      });
      return res.data.file_id;
    },
    [handleActivateProject, loadProjectTree, refreshAll, showToast]
  );

  const handleRenameFolderInProject = useCallback(
    async (projectId: string, folderPath: string, newName: string): Promise<boolean> => {
      const res = await postRenameFolderInProject(
        projectId,
        normalizeFolderPath(folderPath),
        newName.trim()
      );
      if (!res.ok || !res.data) {
        showToast('error', res.error || '重命名文件夹失败');
        return false;
      }
      await loadProjectTree(projectId, true);
      void refreshAll();
      showToast('ok', `已重命名文件夹为「${res.data.new_path || newName.trim()}」`);
      return true;
    },
    [loadProjectTree, refreshAll, showToast]
  );

  const handleMoveFolderInProject = useCallback(
    async (projectId: string, folderPath: string, targetParentDir: string): Promise<boolean> => {
      const res = await postMoveFolderInProject(
        projectId,
        normalizeFolderPath(folderPath),
        normalizeFolderPath(targetParentDir)
      );
      if (!res.ok || !res.data) {
        showToast('error', res.error || '移动文件夹失败');
        return false;
      }
      await loadProjectTree(projectId, true);
      void refreshAll();
      showToast('ok', `已移动文件夹至「${res.data.new_path || targetParentDir}」`);
      return true;
    },
    [loadProjectTree, refreshAll, showToast]
  );

  const handleTrashFolderInProject = useCallback(
    async (projectId: string, folderPath: string, confirm: boolean): Promise<boolean> => {
      const res = await postTrashFolderInProject(
        projectId,
        normalizeFolderPath(folderPath),
        confirm
      );
      if (!res.ok || !res.data) {
        showToast('error', res.error || '移入回收站失败');
        return false;
      }
      await loadProjectTree(projectId, true);
      void refreshAll();
      showToast('warn', `文件夹「${folderPath}」已移入系统回收站`);
      return true;
    },
    [loadProjectTree, refreshAll, showToast]
  );

  const handleMoveFileInProject = useCallback(
    async (projectId: string, fileId: string, targetDir: string): Promise<boolean> => {
      const res = await postMoveFileInProject(projectId, fileId, normalizeFolderPath(targetDir));
      if (!res.ok || !res.data) {
        showToast('error', res.error || '移动文件失败');
        return false;
      }
      await loadProjectTree(projectId, true);
      void refreshAll();
      showToast('ok', `已移动文件至「${res.data.new_path || targetDir || '根目录'}」`);
      return true;
    },
    [loadProjectTree, refreshAll, showToast]
  );

  return {
    projects,
    activeProjectId,
    activeProject,
    overview,
    loading,
    activatingProjectId,
    projectTrees,
    expandedProjects,
    globalPins,
    addProjectModalOpen,
    setAddProjectModalOpen,
    addProjectError,
    setAddProjectError,
    addProjectBusy,
    refreshAll,
    loadProjectTree,
    toggleProjectExpanded,
    handleAddProject,
    handleActivateProject,
    handleUpdateProject,
    handleRemoveProject,
    handleRescanProject,
    toggleGlobalPin,
    handleCreateFolderInProject,
    handleCreateDocumentInProject,
    handleRenameFolderInProject,
    handleMoveFolderInProject,
    handleTrashFolderInProject,
    handleMoveFileInProject,
  };
}
