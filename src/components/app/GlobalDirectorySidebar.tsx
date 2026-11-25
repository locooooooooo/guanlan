/**
 * 全局常驻目录侧栏外壳：
 * - 在「首页 / 全景溯源 / 知识资产库」全视图常驻可见（可一键折叠，桌面端可拖动右缘改宽 220–480px）；
 * - 点击任意文件直接打开深度阅读（切入 library/read）；点击任意目录直接进入目录工作区视图；
 * - 聚合真实目录树（含空文件夹）、置顶、内联新建/改名、文件夹与文件拖拽、批量整理栏与挂载目录树。
 */

import React, { useRef, useState } from 'react';
import { LeftSidebar } from '../LeftSidebar';
import type { WorkspaceStoreCtx } from '../../stores/useWorkspaceStore';
import { clampSidebarWidth } from '../../utils/sidebarTree';

export function GlobalDirectorySidebar({ ctx }: { ctx: WorkspaceStoreCtx }) {
  const {
    activeTab,
    activeFile,
    files,
    readingStates,
    mutedFolders,
    handleToggleMuteFolder,
    handleUnmuteFolder,
    handleClearMutedFolders,
    filesTotal,
    sidebarFilters,
    setSidebarFilters,
    handleClearSidebarFilters,
    openDocResumeReading,
    setActiveTab,
    setLibraryMode,
    setActiveFileId,
    setPinnedRevisionId,
    openQuickPreview,
    handleOpenFileContextMenu,
    handleImportIntoFolder,
    desktopSystemAvailable,
    dragDropOverlay,
    stateOverviewIndex,
    agentDraftFileIds,
    handleTreeMoveFile,
    isMobileLeftOpen,
    setIsMobileLeftOpen,
    mountedWs,
    setMountPanelOpen,
    dirShell,
    multiProjects,
    sidebarInlineAction,
    dataSource,
    retryingConnection,
    handleRetryConnection,
  } = ctx;

  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef<{ x: number; width: number } | null>(null);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    dragStartRef.current = { x: e.clientX, width: dirShell.sidebarWidth };
    setResizing(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const delta = e.clientX - dragStartRef.current.x;
    dirShell.setSidebarWidth(clampSidebarWidth(dragStartRef.current.width + delta));
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragStartRef.current = null;
    setResizing(false);
  };

  const sidebarElement = (
    <LeftSidebar
      width={dirShell.sidebarWidth}
      files={files}
      dataSource={dataSource}
      retryingConnection={retryingConnection}
      onRetryConnection={() => void handleRetryConnection()}
      realFolders={dirShell.realFolders}
      readingStates={readingStates}
      totalCount={filesTotal || undefined}
      activeFileId={activeFile?.file_id ?? ''}
      filters={sidebarFilters}
      onUpdateFilters={(partial) => {
        setSidebarFilters((prev) => ({ ...prev, ...partial }));
        // 在首页或全景溯源页点选具体目录、未读/收藏或智能视图时，无缝切入资产库概览呈现筛选结果
        if (
          (activeTab === 'home' || activeTab === 'panorama') &&
          ((partial.folder !== undefined && partial.folder !== 'all') ||
            (partial.quickScope !== undefined && partial.quickScope !== 'all'))
        ) {
          setActiveTab('library');
          setLibraryMode('overview');
        }
        setIsMobileLeftOpen(false);
      }}
      onResetFilters={handleClearSidebarFilters}
      onOpenFileToRead={(fileId, sectionId) => {
        openDocResumeReading(fileId, sectionId);
        setIsMobileLeftOpen(false);
      }}
      onMarkReadingBaseline={ctx.handleMarkReadingBaseline}
      onMarkFileRead={ctx.handleMarkFullyRead}
      onMarkFileUnread={ctx.handleMarkUnread}
      onMarkFolderUnread={(folderPath) => ctx.handleMarkFolderUnread('folder', folderPath)}
      mutedFolders={mutedFolders}
      onToggleMuteFolder={handleToggleMuteFolder}
      onUnmuteFolder={handleUnmuteFolder}
      onClearMutedFolders={handleClearMutedFolders}
      onSelectFile={(fileId, revisionId) => {
        if (activeTab !== 'library') {
          openDocResumeReading(fileId);
        } else {
          setActiveFileId(fileId);
          if (revisionId) setPinnedRevisionId(revisionId);
          setLibraryMode('read');
        }
        setIsMobileLeftOpen(false);
      }}
      onQuickPreview={openQuickPreview}
      onOpenFileContextMenu={handleOpenFileContextMenu}
      onImportIntoFolder={(folder) => void handleImportIntoFolder(folder)}
      desktopSystemSupported={desktopSystemAvailable}
      dropHoveredFolder={dragDropOverlay.active ? dragDropOverlay.hoveredFolder : null}
      artifactsByFileId={stateOverviewIndex?.artifactsByFileId ?? null}
      agentDraftFileIds={agentDraftFileIds}
      onMoveFile={handleTreeMoveFile}
      pinnedFileIds={dirShell.pinnedFileIds}
      onTogglePinFile={(fileId) => {
        dirShell.togglePinFile(fileId);
        const f = files.find((item) => item.file_id === fileId);
        if (f && multiProjects.activeProjectId) {
          multiProjects.toggleGlobalPin({
            projectId: multiProjects.activeProjectId,
            projectName: multiProjects.activeProject?.name || '当前项目',
            fileId: f.file_id,
            title: f.title,
            format: f.format,
            relativePath: f.relative_path,
          });
        }
      }}
      onCreateFolder={dirShell.handleCreateFolder}
      onCreateDocument={dirShell.handleCreateDocument}
      onRenameFolder={dirShell.handleRenameFolder}
      onMoveFolder={dirShell.handleMoveFolder}
      onBatchMoveFiles={(fileIds) =>
        dirShell.openDirOpModal({ kind: 'batch-move', fileIds })
      }
      onBatchTrashFiles={(fileIds) => {
        const sampleNames = fileIds
          .slice(0, 5)
          .map((id) => files.find((f) => f.file_id === id)?.relative_path || id);
        dirShell.openDirOpModal({ kind: 'batch-trash', fileIds, sampleNames });
      }}
      mounts={mountedWs.mounts}
      mountedTrees={dirShell.mountedTrees}
      onExpandMount={(mountId) => void dirShell.loadMountedTree(mountId)}
      onOpenMountedFile={(fileId, revisionId) => openQuickPreview(fileId, revisionId)}
      onOpenMountManager={() => setMountPanelOpen(true)}
      inlineActionSignal={sidebarInlineAction}
      projects={multiProjects.projects}
      activeProjectId={multiProjects.activeProjectId}
      expandedProjects={multiProjects.expandedProjects}
      projectTrees={multiProjects.projectTrees}
      globalPins={multiProjects.globalPins}
      onToggleGlobalPin={multiProjects.toggleGlobalPin}
      onOpenGlobalPin={(pin) => {
        void multiProjects.handleActivateProject(pin.projectId, {
          projectId: pin.projectId,
          fileId: pin.fileId,
          openTab: 'library',
          libraryMode: 'read',
        });
        setIsMobileLeftOpen(false);
      }}
      onToggleProjectExpanded={multiProjects.toggleProjectExpanded}
      onActivateProject={(projectId, opts) => {
        void multiProjects.handleActivateProject(
          projectId,
          opts
            ? {
                projectId,
                folder: opts.folder,
                fileId: opts.fileId,
                openTab: opts.fileId || opts.folder !== undefined ? 'library' : undefined,
                libraryMode: opts.fileId ? 'read' : opts.folder !== undefined ? 'overview' : undefined,
              }
            : undefined
        );
        setIsMobileLeftOpen(false);
      }}
      onOpenAddProject={() => {
        multiProjects.setAddProjectError(null);
        multiProjects.setAddProjectModalOpen(true);
      }}
      onRenameProject={(projectId, newName) =>
        multiProjects.handleUpdateProject(projectId, { name: newName })
      }
      onToggleProjectReadonly={(projectId, nextReadonly) =>
        multiProjects.handleUpdateProject(projectId, { readonly: nextReadonly })
      }
      onRescanProject={(projectId) => void multiProjects.handleRescanProject(projectId)}
      onRemoveProject={(projectId) => void multiProjects.handleRemoveProject(projectId)}
      onCreateFolderInProject={multiProjects.handleCreateFolderInProject}
      onCreateDocumentInProject={multiProjects.handleCreateDocumentInProject}
    />
  );

  const desktopCollapsed =
    activeTab === 'panorama' ? !dirShell.panoramaSidebarOpen : dirShell.sidebarCollapsed;

  return (
    <>
      {/* 桌面常驻侧栏（全景/画布视图默认让位收起，可随时一键展开）+ 可拖拽调宽把手 */}
      {!desktopCollapsed && (
        <div className="hidden lg:flex h-full shrink-0 relative z-20">
          {sidebarElement}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整目录栏宽度"
            data-sidebar-resize-handle=""
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            title="拖动调整目录栏宽度（双击恢复默认）"
            onDoubleClick={() => dirShell.setSidebarWidth(264)}
            className={`w-1.5 -ml-0.5 h-full cursor-col-resize shrink-0 relative group/resize transition-colors ${
              resizing ? 'bg-[color:var(--accent-iris)]/35' : 'hover:bg-[color:var(--accent-iris)]/20'
            }`}
          >
            <span
              aria-hidden="true"
              className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-[1px] transition-colors ${
                resizing
                  ? 'bg-[color:var(--accent-iris-deep)]'
                  : 'bg-transparent group-hover/resize:bg-[color:var(--accent-iris-deep)]/60'
              }`}
            />
          </div>
        </div>
      )}

      {/* 窄视口抽屉层（lg 以下或主动呼出时） */}
      {isMobileLeftOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 flex bg-black/20 backdrop-blur-[1px]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setIsMobileLeftOpen(false);
          }}
        >
          <div className="h-full shadow-2xl">{sidebarElement}</div>
        </div>
      )}
    </>
  );
}
