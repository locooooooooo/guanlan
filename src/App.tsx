/**
 * D01-a 拆解 · App 薄装配层（任务卡 D01-a ②「单一工作区状态 Store」）。
 *
 * 巨石（4210 行）已按层拆入：
 *  - stores/useWorkspaceStore.tsx       单一工作区状态 Store（全部 state/effect/handler → ctx）
 *  - components/app/AppBanners.tsx      横幅栈与冷启动进度
 *  - components/app/AppMainViews.tsx    首页 / 全景三态
 *  - components/app/AppLibraryStage.tsx 知识资产库三栏
 *  - components/app/AppModalsStack.tsx  抽屉与弹窗栈
 *
 * 本文件只保留：单一 Store 调用 + TopHeader 接线 + 工作区门禁分支 + 分节组合
 * （DOM 嵌套结构与拆解前逐字一致，截图基线护栏覆盖）。
 */

import React from 'react';
import { WorkspaceGateModal } from './components/WorkspaceGateModal';
import { TopHeader } from './components/TopHeader';
// v0.8 总装：画布五件的 .cvw-* 样式在此常驻装载（原由 canvas/RichDocPreviewCard.tsx:15
// import，指挥授权越权单行上移）——node --test/tsx 测试链（gc-12/wf2/canvas-theme 经
// GraphCanvasView 导出常量断言）无法加载 .css 扩展名，组件内 import 会令三个测试文件级
// 失败（ERR_UNKNOWN_FILE_EXTENSION）；画布五件全部渲染在本文件舷窗子树内，import 时序
// 恒先于首帧渲染，Vite 打包零视觉变化。C 契约「由 C3-C7 所在文件 import」条款与
// node 测试链冲突，修订建议已记入总装 deviations。
import './components/canvas/canvasWidgets.css';
// v0.8 总装（指挥授权）：同上——KnowledgeGraph.tsx:12 的 eventGraph.css 同法上移
// （测试链闭包全量枚举后的最后一个 css import）；时光机/司辰/画布令牌块随 App
// 常驻装载，时序恒先于首帧渲染
import './components/eventGraph.css';
import { useWorkspaceStore } from './stores/useWorkspaceStore';
import { AppBanners } from './components/app/AppBanners';
import { AppMainViews } from './components/app/AppMainViews';
import { AppLibraryStage } from './components/app/AppLibraryStage';
import { AppModalsStack } from './components/app/AppModalsStack';
import { GlobalDirectorySidebar } from './components/app/GlobalDirectorySidebar';
import { AnchoredToastProvider, ToastProvider } from './components/ui/toast';

export default function App() {
  const ctx = useWorkspaceStore();
  const {
    activeTab,
    handleSelectPrimaryTab,
    searchQuery,
    setSearchQuery,
    searchHits,
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
      {/* Top Header Bar：工作区页签 + 🟢 已同步胶囊（契约②③⑥⑩） */}
      <TopHeader
        activeTab={activeTab}
        onSelectTab={handleSelectPrimaryTab}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchHits={searchHits}
        onSelectSearchHit={handleSelectSearchHit}
        unreadFilesCount={unreadFilesCount}        contextBasketCount={contextPointers.length}
        eventCount={workspaceSummary?.counts.events || 0}
        // pm_4：未决决策雷达（只读）——数据来自 bootstrap decisions 首批，点一行复用决策引用跳证据原文
        decisions={decisions}
        decisionsUnresolvedTotal={ctx.decisionsUnresolvedTotal}
        onOpenDecision={handleOpenDecisionReference}
        // v0.8 总装-6：左栏主导航「未决决策」→ 雷达受控展开信号（App 只传 state，转发归 TopHeader）
        openSignal={decisionRadarSignal}
        config={config}
        dataSource={dataSource}
        scanSummary={scanSummary}
        dataError={dataError}
        files={filteredFiles}
        // 批次一调整①：格式/事项筛选计数来自服务 facets（契约 §1.3），缺失时回退本地计数
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
        // 批次二：数据时效（最后扫描时间）与手动重新扫描
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
        sidebarCollapsed={ctx.dirShell.sidebarCollapsed}
        onToggleSidebar={() => {
          if (typeof window !== 'undefined' && window.innerWidth < 1024) {
            ctx.setIsMobileLeftOpen((v) => !v);
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
