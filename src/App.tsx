/**
 * App 薄装配层：组装单一工作区状态 Store 与各主视图分节。
 *
 * 按职责拆分到以下模块：
 *  - stores/useWorkspaceStore.tsx       单一工作区状态 Store（全部 state/effect/handler → ctx）
 *  - components/app/AppBanners.tsx      横幅栈与冷启动进度
 *  - components/app/AppMainViews.tsx    首页 / 全景三态
 *  - components/app/AppLibraryStage.tsx 知识资产库三栏
 *  - components/app/AppModalsStack.tsx  抽屉与弹窗栈
 *
 * 本文件只保留：单一 Store 调用 + TopHeader 接线 + 工作区门禁分支 + 分节组合。
 */

import React from 'react';
import { WorkspaceGateModal } from './components/WorkspaceGateModal';
import { TopHeader } from './components/TopHeader';
// 画布组件的 .cvw-* 样式在此入口层常驻装载：
// node --test / tsx 测试链会导入 GraphCanvasView 的导出常量，无法加载 .css 扩展名
// （会触发 ERR_UNKNOWN_FILE_EXTENSION），因此组件内不直接 import .css；
// 画布组件均渲染在 App 树内，在此装载时序恒先于首帧渲染。
import './components/canvas/canvasWidgets.css';
// 同上：eventGraph.css（时光机 / 司辰 / 画布令牌样式）在入口层常驻装载，
// 避免被 node 测试链闭包加载，且时序恒先于首帧渲染。
import './components/eventGraph.css';
import { useWorkspaceStore } from './stores/useWorkspaceStore';
import { AppBanners } from './components/app/AppBanners';
import { AppMainViews } from './components/app/AppMainViews';
import { AppLibraryStage } from './components/app/AppLibraryStage';
import { AppModalsStack } from './components/app/AppModalsStack';
import { GlobalDirectorySidebar } from './components/app/GlobalDirectorySidebar';
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

  return (
    <ToastProvider position="bottom-right">
      <AnchoredToastProvider>
        <div className="glass-page h-screen w-screen flex flex-col text-[var(--ink-strong)] overflow-hidden">
      {/* Top Header Bar：工作区页签与同步状态胶囊 */}
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
        // 未决决策雷达（只读）——数据来自 bootstrap decisions 首批，点一行复用决策引用跳证据原文
        decisions={decisions}
        decisionsUnresolvedTotal={ctx.decisionsUnresolvedTotal}
        onOpenDecision={handleOpenDecisionReference}
        // 左栏主导航「未决决策」→ 雷达受控展开信号（App 只传 state，转发归 TopHeader）
        openSignal={decisionRadarSignal}
        config={config}
        dataSource={dataSource}
        scanSummary={scanSummary}
        dataError={dataError}
        files={filteredFiles}
        // 格式/事项筛选计数优先来自服务端 facets，缺失时回退本地计数
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
        // 数据时效（最后扫描时间）与手动重新扫描
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
        onActivateProject={(projectId) => {
          void ctx.multiProjects.handleActivateProject(projectId);
        }}
        onOpenAddProject={() => {
          ctx.multiProjects.setAddProjectError(null);
          ctx.multiProjects.setAddProjectModalOpen(true);
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
        <div className="flex-1 flex min-h-0 overflow-hidden relative">
          {/* Quiet.md 全局常驻可调宽/可折叠目录侧栏（首页 / 全景 / 知识资产库全视图共享） */}
          <GlobalDirectorySidebar ctx={ctx} />

          <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
            {/* 横幅栈（手动重扫 / L4A / HITL 清零 / 归档提示 / 监听提示）与冷启动进度 */}
            <AppBanners ctx={ctx} />

            {/* 主视图分节（首页 / 资产库空态 / 全景三态） */}
            <AppMainViews ctx={ctx} />

            {/* 知识资产库主区（阅读器 hidden 保活 / AtlasView / 检查器） */}
            {activeTab === 'library' && activeFile && <AppLibraryStage ctx={ctx} />}
          </div>
        </div>
      )}

      {/* 抽屉与弹窗栈 */}
      <AppModalsStack ctx={ctx} />
        </div>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
