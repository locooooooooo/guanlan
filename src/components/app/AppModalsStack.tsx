
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
    agentContextPreset, presetPointers, recommendedMounts, focusedContextFileId, handleMountPointers,
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
        intent={agentContextPreset.intent}
        intentTemplate={agentContextPreset.intentTemplate}
        presetPointers={presetPointers}
        recommendedMounts={recommendedMounts}
        onMountPointers={handleMountPointers}
        onUpdatePointerGranularity={handleUpdatePointerGranularity}
        confirmedDecisions={confirmedDecisionLines}
        pendingBlockers={pendingBlockerLines}
        decisionChangeNote={decisionChangeNote}
      />

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

      <DecisionChangeToast
        note={decisionChangeToast}
        onOpenContextDrawer={() => {
          setDecisionChangeToast(null);
          openContextDrawer();
        }}
        onDismiss={() => setDecisionChangeToast(null)}
      />

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
