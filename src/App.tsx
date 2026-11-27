
import React from 'react';
import { WorkspaceGateModal } from './components/WorkspaceGateModal';
import { TopHeader } from './components/TopHeader';
import './components/canvas/canvasWidgets.css';
import './components/eventGraph.css';
import { useWorkspaceStore } from './stores/useWorkspaceStore';
import { AppBanners } from './components/app/AppBanners';
import { AppMainViews } from './components/app/AppMainViews';
import { AppLibraryStage } from './components/app/AppLibraryStage';
import { AppModalsStack } from './components/app/AppModalsStack';
import { GlobalDirectorySidebar } from './components/app/GlobalDirectorySidebar';
import { ProjectSwitchTransition } from './components/app/ProjectSwitchTransition';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AnchoredToastProvider, ToastProvider } from './components/ui/toast';

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const ctx = useWorkspaceStore();
  const {
    activeTab,
    handleSelectPrimaryTab,
    searchQuery,
    setSearchQuery,
    searchHits,
    searchHitsTruncated,
    handleSelectSearchHit,
    unreadFilesCount,
    contextPointers,
    workspaceSummary,
    decisions,
    handleOpenDecisionReference,
    decisionRadarSignal,
    config,
    dataSource,
    scanSummary,
    dataError,
    filteredFiles,
    fileFacets,
    sidebarFilters,
    setSidebarFilters,
    handleClearSidebarFilters,
    libraryMode,
    handleLibraryModeChange,
    setIsSettingsOpen,
    setIsMcpConsoleOpen,
    openContextDrawer,
    reviewBoard,
    handleOpenReviewBoard,
    rescanState,
    handleRescan,
    serviceStatus,
    desktopBridgeAvailable,
    desktopSession,
    switchingWorkspace,
    workspaceSwitchError,
    handlePickWorkspaceFolder,
    handleSwitchWorkspace,
    handleRemoveRecentWorkspace,
    isHelpOpen,
    setIsHelpOpen,
    hasActiveBackend,
    activeFile,
  } = ctx;

  const switchingProjectId = ctx.multiProjects.activatingProjectId;
  const switchingProjectName =
    ctx.multiProjects.projects.find((p) => p.project_id === switchingProjectId)?.name ?? null;

  return (
    <ToastProvider position="bottom-right">
      <AnchoredToastProvider>
        <div className="glass-page h-screen w-screen flex flex-col text-[var(--ink-strong)] overflow-hidden">
      <TopHeader
        activeTab={activeTab}
        onSelectTab={handleSelectPrimaryTab}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchHits={searchHits}
        searchHitsTruncated={searchHitsTruncated}
        onSelectSearchHit={handleSelectSearchHit}
        unreadFilesCount={unreadFilesCount}        contextBasketCount={contextPointers.length}
        eventCount={workspaceSummary?.counts.events || 0}
        decisions={decisions}
        decisionsUnresolvedTotal={ctx.decisionsUnresolvedTotal}
        onOpenDecision={handleOpenDecisionReference}
        openSignal={decisionRadarSignal}
        config={config}
        dataSource={dataSource}
        scanSummary={scanSummary}
        dataError={dataError}
        files={filteredFiles}
        facets={fileFacets ?? undefined}
        sidebarFilters={sidebarFilters}
        onUpdateSidebarFilters={(partial) =>
          setSidebarFilters((prev) => ({ ...prev, ...partial }))
        }
        onResetSidebarFilters={handleClearSidebarFilters}
        libraryMode={libraryMode}
        onLibraryModeChange={handleLibraryModeChange}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenMcpConsole={() => setIsMcpConsoleOpen(true)}
        onOpenContextDrawer={openContextDrawer}
        onOpenReviewBoard={handleOpenReviewBoard}
        reviewBoardAttentionCount={
          reviewBoard
            ? reviewBoard.counts.pending_decision +
              reviewBoard.counts.awaiting_receipt +
              reviewBoard.counts.unknown
            : 0
        }
        lastScanAt={workspaceSummary?.last_scan_at ?? null}
        isScanning={rescanState === 'running'}
        watcherEnabled={serviceStatus?.watcher?.enabled ?? false}
        onRescan={() => {
          void handleRescan();
        }}
        desktopWorkspaceSupported={desktopBridgeAvailable}
        desktopGateStatus={desktopSession?.status ?? null}
        workspaceName={desktopSession?.workspaceName ?? null}
        recentWorkspaces={desktopSession?.recentWorkspaces ?? []}
        switchingWorkspace={switchingWorkspace}
        workspaceSwitchError={workspaceSwitchError}
        onPickWorkspaceFolder={() => {
          void handlePickWorkspaceFolder();
        }}
        onSwitchWorkspace={(root) => {
          void handleSwitchWorkspace(root);
        }}
        onRemoveRecentWorkspace={(root) => {
          void handleRemoveRecentWorkspace(root);
        }}
        helpOpen={isHelpOpen}
        onHelpOpenChange={setIsHelpOpen}
        sidebarCollapsed={
          activeTab === 'panorama' ? !ctx.dirShell.panoramaSidebarOpen : ctx.dirShell.sidebarCollapsed
        }
        onToggleSidebar={() => {
          if (typeof window !== 'undefined' && window.innerWidth < 1024) {
            ctx.setIsMobileLeftOpen((v) => !v);
          } else if (activeTab === 'panorama') {
            ctx.dirShell.togglePanoramaSidebar();
          } else {
            ctx.dirShell.toggleSidebarCollapsed();
          }
        }}
        managedProjects={ctx.multiProjects.projects}
        activeProjectId={ctx.multiProjects.activeProjectId}
        activatingProjectId={ctx.multiProjects.activatingProjectId}
        onActivateProject={(projectId) => {
          void ctx.multiProjects.handleActivateProject(projectId);
        }}
        onOpenAddProject={() => {
          ctx.multiProjects.setAddProjectError(null);
          ctx.multiProjects.setAddProjectModalOpen(true);
        }}
        onRemoveManagedProject={(projectId) => {
          void ctx.multiProjects.handleRemoveProject(projectId);
        }}
        readingIslandFiles={ctx.files}
        readingStates={ctx.readingStates}
        onOpenDocFromIsland={(fileId) => void ctx.openDocResumeReading(fileId)}
        onMarkFileReadFromIsland={ctx.handleMarkFullyRead}
        onMarkFileUnreadFromIsland={ctx.handleMarkUnread}
        onMarkReadingBaselineFromIsland={() => ctx.handleMarkReadingBaseline('workspace')}
      />

      {!hasActiveBackend && desktopSession ? (
        <WorkspaceGateModal
          session={desktopSession}
          busy={switchingWorkspace}
          actionError={workspaceSwitchError}
          onPickFolder={() => {
            void handlePickWorkspaceFolder();
          }}
          onOpenRoot={(root) => {
            void handleSwitchWorkspace(root);
          }}
          onRemoveRecent={(root) => {
            void handleRemoveRecentWorkspace(root);
          }}
        />
      ) : (
        <div
          className="flex-1 flex min-h-0 overflow-hidden relative"
          aria-busy={switchingProjectId ? true : undefined}
        >
          <GlobalDirectorySidebar ctx={ctx} />

          <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
            <AppBanners ctx={ctx} />

            <AppMainViews ctx={ctx} />

            {activeTab === 'library' && activeFile && <AppLibraryStage ctx={ctx} />}
          </div>
        </div>
      )}

      <AppModalsStack ctx={ctx} />

      {switchingProjectId && (
        <ProjectSwitchTransition projectName={switchingProjectName} />
      )}
        </div>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
