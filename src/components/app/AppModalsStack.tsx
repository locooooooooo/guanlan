/**
 * D01-a 拆解 · App 抽屉与弹窗栈（原 App.tsx 4045-4207 逐字迁入）。
 * 文件时间线抽屉 / MCP 控制台 / 工作区设置 / 证道阁上下文抽屉 / 草案回写通知 /
 * 决策变更单 Toast / 右键菜单 / 命令面板 / 挂载面板 / QuickLook / 文件操作弹窗 /
 * 拖放导入浮层 / 系统动作反馈条。数据一律来自 useWorkspaceStore ctx。
 */

import React from 'react';
import { FileTimelineDrawer } from '../FileTimelineDrawer';
import {
  AgentContextDrawer,
  McpConsoleModal,
  WorkspaceSettingsModal,
} from '../ModalsAndDrawers';
import ProposalToast from '../ProposalToast';
import ReviewBoardDrawer from '../ReviewBoardDrawer';
import ChronosDigestDrawer from '../ChronosDigestDrawer';
import DecisionChangeToast from '../DecisionChangeToast';
import { FileContextMenu } from '../FileContextMenu';
import { CommandPalette } from '../CommandPalette';
import { MountManagerPanel } from '../MountManagerPanel';
import { QuickPreviewModal } from '../QuickPreviewModal';
import { FileOpsModal } from '../FileOpsModal';
import { DirOpsModal } from '../DirOpsModal';
import { AddProjectModal } from '../AddProjectModal';
import { pickDesktopWorkspaceFolder } from '../../services/desktopBridge';
import { hasUnreadChanges } from '../../utils/guanlanEngine';
import { isFolderMuted } from '../../utils/sidebarTree';
import {
  DragDropImportOverlay,
  SystemActionToastBanner,
} from '../DragDropImportOverlay';
import type { WorkspaceStoreCtx } from '../../stores/useWorkspaceStore';

export function AppModalsStack({ ctx }: { ctx: WorkspaceStoreCtx }) {
  const {
    historyFileId, setHistoryFileId, handleOpenFileFromTimelineOrGraph,
    files, events, decisions, relations,
    isMcpConsoleOpen, setIsMcpConsoleOpen, isSettingsOpen, setIsSettingsOpen,
    isContextDrawerOpen, setIsContextDrawerOpen, contextPointers, setContextPointers,
    config, activeInitiative, contextSessionCheckpointId, referenceMetaOf,
    zhendaogePreset, presetPointers, recommendedMounts, focusedContextFileId, handleMountPointers,
    handleUpdatePointerGranularity, confirmedDecisionLines, pendingBlockerLines,
    decisionChangeNote, proposalToast, proposalAdopting, proposalRejecting, proposalAdoptNotice,
    proposalDiffExpanded, proposalDiffLoading, proposalDiffError, proposalDiffContent,
    handleAdoptProposal, handleRejectProposal, handleViewProposalDiff,
    handleOpenProposalInReader, handleDismissProposalToast,
    isReviewBoardOpen, setIsReviewBoardOpen, reviewBoard, reviewBoardLoading,
    reviewBoardError, reviewBoardBusyKey, reviewBoardNotice,
    refreshReviewBoard, handleBoardAckStatement, handleBoardRepairOrphan,
    handleBoardJumpToStatement, handleBoardInspectDraft,
    decisionChangeToast, setDecisionChangeToast, openContextDrawer,
    fileContextMenu, setFileContextMenu, desktopSystemAvailable,
    handleRevealInExplorer, handleOpenWithDefaultApp, handleCopyRelativePath,
    handleCopyAbsolutePath, handleImportIntoFolder, openQuickPreview,
    handleRenameFile, handleMoveFile, handleTrashFile,
    isPaletteOpen, palette, closePalette, handlePaletteOpenFile, handlePaletteLocate,
    handlePaletteAddToBasket, handlePaletteAction,
    isMountPanelOpen, setMountPanelOpen, mountedWs,
    quickPreviewTarget, quickPreviewQueue, closeQuickPreview, navigateQuickPreview,
    fileOpModal, fileOpFolderOptions, fileOpSubmitting, fileOpError, closeFileOp,
    handleFileOpsSubmit, referenceImpact,
    dragDropOverlay, defaultImportTargetDir, systemToast, setSystemToast,
    handleAddEvidencePointer, systemActions,
    dirShell, multiProjects, triggerSidebarInlineAction,
    desktopBridgeAvailable, desktopSession,
  } = ctx;

  return (
    <>
      {/* 操作提示已统一合流进 TopHeader 顶部「?」帮助浮层（快捷键 ? / Esc 同步受控），
          彻底消除右下角悬浮 ? 钮对右侧检查器「复制给智能体」与日历网格的遮挡。 */}

      {/* Modals & Drawers */}
      {/* T04：以文件为中心的时间线抽屉——版本链按 occurred_at（无则 observed_at）排列，
          事件按 seq 挂到对应版本下；点有快照的版本可打开该时点内容 */}
      <FileTimelineDrawer
        isOpen={historyFileId !== ''}
        fileId={historyFileId}
        onClose={() => setHistoryFileId('')}
        onOpenRevision={(fileId, revisionId) => {
          setHistoryFileId('');
          handleOpenFileFromTimelineOrGraph(fileId, revisionId, 'read');
        }}
      />

      <McpConsoleModal
        isOpen={isMcpConsoleOpen}
        onClose={() => setIsMcpConsoleOpen(false)}
        config={config}
        files={files}
        events={events}
        decisions={decisions}
        relations={relations}
      />

      <WorkspaceSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={config}
        mutedFolders={ctx.mutedFolders}
        onUnmuteFolder={ctx.handleUnmuteFolder}
        onClearMutedFolders={ctx.handleClearMutedFolders}
      />

      {/* GU-CC-02：Context Basket 抽屉——证道阁改造（PRD 4.1–4.3 / F4）：
          路由默认包一键带入 + 注入粒度 + Token 预算条 + 推荐挂载折叠 + MCP 自检 +
          双模导出（导出文本经 zhendaogeExport 单一构建，formatContextForAgent
          保留给 RightInspector 旧入口） */}
      <AgentContextDrawer
        isOpen={isContextDrawerOpen}
        onClose={() => setIsContextDrawerOpen(false)}
        pointers={contextPointers}
        onRemovePointer={(idx) =>
          setContextPointers((prev) => prev.filter((_, i) => i !== idx))
        }
        onClearPointers={() => setContextPointers([])}
        workspaceRoot={config.rootPath}
        focusFileId={focusedContextFileId}
        initiative={activeInitiative}
        sessionCheckpointId={contextSessionCheckpointId}
        referenceMetaOf={referenceMetaOf}
        intent={zhendaogePreset.intent}
        intentTemplate={zhendaogePreset.intentTemplate}
        presetPointers={presetPointers}
        recommendedMounts={recommendedMounts}
        onMountPointers={handleMountPointers}
        onUpdatePointerGranularity={handleUpdatePointerGranularity}
        confirmedDecisions={confirmedDecisionLines}
        pendingBlockers={pendingBlockerLines}
        decisionChangeNote={decisionChangeNote}
      />

      {/* E04：轻量「批阅看板」抽屉（五态精简版 + 失联 unknown 孤儿诊断与安全修复） */}
      <ReviewBoardDrawer
        isOpen={isReviewBoardOpen}
        onClose={() => setIsReviewBoardOpen(false)}
        board={reviewBoard}
        loading={reviewBoardLoading}
        error={reviewBoardError}
        busyKey={reviewBoardBusyKey}
        notice={reviewBoardNotice}
        onRefresh={() => void refreshReviewBoard()}
        onJumpToStatement={handleBoardJumpToStatement}
        onAcknowledgeStatement={handleBoardAckStatement}
        onInspectDraft={handleBoardInspectDraft}
        onRepairOrphan={handleBoardRepairOrphan}
      />

      {/* V10：「司辰手记」今日 / 近 7 日沉淀简报抽屉（Sheet inset + 可溯源 Markdown 导出） */}
      <ChronosDigestDrawer
        isOpen={ctx.isChronosDigestOpen}
        onClose={() => ctx.setIsChronosDigestOpen(false)}
        events={events}
        files={files}
        decisions={decisions}
        onOpenDocument={(fileId, revisionId) =>
          handleOpenFileFromTimelineOrGraph(fileId, revisionId || '', 'read')
        }
        onOpenDecision={(decisionId) => ctx.handleOpenDecisionReference(decisionId)}
      />

      {/* 回写通知条（PRD 4.3 / F6 / E02）：智能体独立草案分支批阅（多模态 Diff / 退回重做 / 一键采纳） */}
      <ProposalToast
        toast={proposalToast}
        adopting={proposalAdopting}
        rejecting={proposalRejecting}
        adoptNotice={proposalAdoptNotice}
        diffExpanded={proposalDiffExpanded}
        diffLoading={proposalDiffLoading}
        diffError={proposalDiffError}
        diffContent={proposalDiffContent}
        onAdopt={handleAdoptProposal}
        onReject={handleRejectProposal}
        onViewDiff={handleViewProposalDiff}
        onOpenInReader={handleOpenProposalInReader}
        onDismiss={handleDismissProposalToast}
      />

      {/* AC-03（PRD 3.3 第 3 步）：决策变更单推送通知——点击查看证道阁 */}
      <DecisionChangeToast
        note={decisionChangeToast}
        onOpenZhendaoge={() => {
          setDecisionChangeToast(null);
          openContextDrawer();
        }}
        onDismiss={() => setDecisionChangeToast(null)}
      />

      {/* A04/A05：全局文件/目录右键操作菜单、身份保真文件操作弹窗、外部文件拖入引导浮层与系统动作反馈条 */}
      <FileContextMenu
        menu={fileContextMenu}
        onClose={() => setFileContextMenu(null)}
        desktopSupported={desktopSystemAvailable}
        hasRootPath={Boolean(config.rootPath)}
        onRevealInExplorer={(rel) => void handleRevealInExplorer(rel)}
        onOpenWithDefaultApp={(rel) => void handleOpenWithDefaultApp(rel)}
        onCopyRelativePath={(rel) => void handleCopyRelativePath(rel)}
        onCopyAbsolutePath={(rel) => void handleCopyAbsolutePath(rel)}
        onImportIntoFolder={(folderRel) => void handleImportIntoFolder(folderRel)}
        onQuickPreview={openQuickPreview}
        onOpenRead={(fileId, revisionId) =>
          handleOpenFileFromTimelineOrGraph(fileId, revisionId || '', 'read')
        }
        onOpenTimeline={(fileId) => ctx.handleOpenFileTimeline(fileId)}
        onRenameFile={handleRenameFile}
        onMoveFile={handleMoveFile}
        onTrashFile={handleTrashFile}
        isPinnedFile={(fileId) => dirShell.pinnedFileIds.includes(fileId)}
        onTogglePinFile={dirShell.togglePinFile}
        onCreateDocumentInFolder={(folderRel) => {
          if (dirShell.sidebarCollapsed) dirShell.setSidebarCollapsed(false);
          triggerSidebarInlineAction('create-doc', folderRel);
        }}
        onCreateSubfolder={(folderRel) => {
          if (dirShell.sidebarCollapsed) dirShell.setSidebarCollapsed(false);
          triggerSidebarInlineAction('create-folder', folderRel);
        }}
        onRenameFolder={(folderRel) => {
          if (dirShell.sidebarCollapsed) dirShell.setSidebarCollapsed(false);
          triggerSidebarInlineAction('rename-folder', folderRel);
        }}
        onMoveFolder={(folderRel) =>
          dirShell.openDirOpModal({ kind: 'folder-move', folderPath: folderRel })
        }
        onTrashFolder={(folderRel) => {
          const affectedCount = files.filter(
            (f) => f.folder === folderRel || f.folder.startsWith(`${folderRel}/`)
          ).length;
          dirShell.openDirOpModal({
            kind: 'folder-trash',
            folderPath: folderRel,
            affectedCount,
          });
        }}
        isFileUnread={(fileId) => {
          const target = files.find((f) => f.file_id === fileId);
          return target ? hasUnreadChanges(target, ctx.readingStates[fileId]).isUnread : true;
        }}
        onMarkFileRead={(fileId, revisionId) => {
          const target = files.find((f) => f.file_id === fileId);
          const targetRev = target?.current_revision_id || revisionId || '';
          if (targetRev) ctx.handleMarkFullyRead(fileId, targetRev);
        }}
        onMarkFileUnread={(fileId) => {
          ctx.handleMarkUnread(fileId);
        }}
        onMarkFolderRead={(folderRel) => {
          void ctx.handleMarkReadingBaseline(folderRel ? 'folder' : 'workspace', folderRel || undefined);
        }}
        onMarkFolderUnread={(folderRel) => {
          void ctx.handleMarkFolderUnread(folderRel ? 'folder' : 'workspace', folderRel || undefined);
        }}
        isFolderMuted={(folderRel) => isFolderMuted(folderRel, ctx.mutedFolders)}
        onToggleMuteFolder={(folderRel) => ctx.handleToggleMuteFolder(folderRel)}
      />

      {/* C03 + V08：Ctrl+K 全局时空命令面板（L4A 富预览 + Shift+Enter 直达时光机） */}
      <CommandPalette
        isOpen={isPaletteOpen}
        query={palette.query}
        items={palette.items}
        searching={palette.searching}
        files={files}
        onQueryChange={palette.setQuery}
        onClose={closePalette}
        onOpenFile={handlePaletteOpenFile}
        onOpenTimeMachine={(item) => {
          if (item.fileId) ctx.handleOpenFileTimeline(item.fileId);
        }}
        onLocate={handlePaletteLocate}
        onAddToBasket={handlePaletteAddToBasket}
        onRunAction={handlePaletteAction}
      />

      {/* C05：挂载参考工作区管理面板（只读挂载 / 离线徽标 / 跨项目检索入口） */}
      <MountManagerPanel
        isOpen={isMountPanelOpen}
        onClose={() => setMountPanelOpen(false)}
        mounts={mountedWs.mounts}
        loading={mountedWs.loading}
        error={mountedWs.error}
        onMount={mountedWs.mount}
        onUnmount={mountedWs.unmount}
      />

      <QuickPreviewModal
        isOpen={quickPreviewTarget !== null}
        target={quickPreviewTarget}
        queue={quickPreviewQueue}
        files={files}
        indexGeneration={config.runtimeStatus.indexGeneration}
        onClose={closeQuickPreview}
        onNavigate={navigateQuickPreview}
        onOpenFullReader={(fileId, revisionId) =>
          handleOpenFileFromTimelineOrGraph(fileId, revisionId || '', 'read')
        }
        onAddEvidencePointer={(pointer) => {
          handleAddEvidencePointer(pointer);
          openContextDrawer();
        }}
        systemActions={systemActions}
      />

      <FileOpsModal
        request={fileOpModal}
        folderOptions={fileOpFolderOptions}
        submitting={fileOpSubmitting}
        serverError={fileOpError}
        onClose={closeFileOp}
        onSubmit={handleFileOpsSubmit}
        referenceImpact={referenceImpact}
      />

      <DirOpsModal
        request={dirShell.dirOpModal}
        folderOptions={fileOpFolderOptions}
        submitting={dirShell.dirOpSubmitting}
        serverError={dirShell.dirOpError}
        onClose={dirShell.closeDirOpModal}
        onSubmit={dirShell.submitDirOpModal}
      />

      <AddProjectModal
        isOpen={multiProjects.addProjectModalOpen}
        onClose={() => {
          multiProjects.setAddProjectModalOpen(false);
          multiProjects.setAddProjectError(null);
        }}
        projects={multiProjects.projects}
        recentWorkspaces={desktopSession?.recentWorkspaces ?? []}
        desktopPickerSupported={desktopBridgeAvailable}
        onPickFolder={async () => {
          const picked = await pickDesktopWorkspaceFolder();
          return picked.ok ? picked.path : null;
        }}
        busy={multiProjects.addProjectBusy}
        error={multiProjects.addProjectError}
        onSubmit={multiProjects.handleAddProject}
      />

      <DragDropImportOverlay
        active={dragDropOverlay.active}
        paths={dragDropOverlay.paths}
        targetDir={defaultImportTargetDir}
        hoveredFolder={dragDropOverlay.hoveredFolder}
      />

      <SystemActionToastBanner
        toast={systemToast}
        onDismiss={() => setSystemToast(null)}
        onRevealInExplorer={(rel) => void handleRevealInExplorer(rel)}
        onOpenWithDefaultApp={(rel) => void handleOpenWithDefaultApp(rel)}
      />
    </>
  );
}
