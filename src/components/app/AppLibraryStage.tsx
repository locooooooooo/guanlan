/**
 * D01-a 拆解 · App 知识资产库三栏分节（原 App.tsx 3765-4038 逐字迁入）：
 * 窄视口抽屉条 + LeftSidebar + ReaderView（hidden 保活）/ AtlasView + RightInspector。
 * 数据一律来自 useWorkspaceStore ctx。
 */

import React, { useMemo, useRef } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '../ui/primitives';
import { ReaderView } from '../ReaderView';
import { AtlasView } from '../AtlasView';
import { RightInspector } from '../RightInspector';
import { enterEventFrame } from '../KnowledgeGraph';
import { copyTextWithDesktopFallback } from '../../services/desktopBridge';
import { formatContextForAgent, hasUnreadChanges } from '../../utils/guanlanEngine';
import type { WorkspaceStoreCtx } from '../../stores/useWorkspaceStore';

export function AppLibraryStage({ ctx }: { ctx: WorkspaceStoreCtx }) {
  const {
    activeTab, activeFile, setIsMobileLeftOpen, isMobileLeftOpen, isMobileRightOpen,
    setIsMobileRightOpen, setPanoramaMode, readerPaneRef, libraryMode,
    sidebarFilterActive, handleClearSidebarFilters, files, readingStates, events, systemActions,
    sidebarFilters, setSidebarFilters, openDocResumeReading, setActiveFileId,
    setPinnedRevisionId, openQuickPreview,
    readerAnchor, readerFocusSection, readerScrollPercentRef, activePackage,
    readerSubMode, setReaderSubMode, setReaderAnchor, setLibraryMode, activeFileInFilter, handleMarkReadHere, handleMarkFullyRead, handleMarkUnread, handleMarkReadingBaseline, handleMarkFolderUnread,
    handleScrollProgress, handleToggleBookmark, returnBreadcrumb,
    handleFollowReturnBreadcrumb, handleNavigateLinkedFile, decisions, relations, handleOpenDecisionReference,
    handleAddEvidencePointer, openContextDrawer, handleAddDecisionReceiptToBasket,
    handleDecisionResolved, handleBlockingCleared, libraryInspectorOpen,
    setLibraryInspectorOpen, overviewInspectorCollapsed, config, stateOverview, filteredFiles, sidebarFilterLabel,
    selectedDecisionId, handleSavePersonalNote, handleOpenFileTimeline, eventTrail,
    setEventTrail, pinnedRevisionId, setActiveTab, triggerSidebarInlineAction, dirShell,
  } = ctx;

  const activeFolderSegments =
    sidebarFilters.folder !== 'all'
      ? sidebarFilters.folder.split('/').filter(Boolean)
      : [];

  const activeFolderReadStats = useMemo(() => {
    if (sidebarFilters.folder === 'all') return { total: 0, unread: 0 };
    const normalized = sidebarFilters.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) return { total: 0, unread: 0 };
    const prefix = `${normalized}/`;
    let total = 0;
    let unread = 0;
    for (const f of files) {
      const p = f.relative_path.replace(/\\/g, '/');
      if (p === normalized || p.startsWith(prefix)) {
        total += 1;
        if (hasUnreadChanges(f, readingStates[f.file_id]).isUnread) {
          unread += 1;
        }
      }
    }
    return { total, unread };
  }, [files, readingStates, sidebarFilters.folder]);

  // ── U05 · 专注纸面（Zen）：本层是唯一同时握有「左栏折叠」与「右栏显隐」两把钥匙的层 ──
  // 进入 Zen：收起左侧目录栏 + 收起右侧溯源检查器 → 阅读纸居中（黄金行宽由 .reader-measure 锁定）；
  // 退出 Zen：恢复进入前的左栏折叠态（不覆盖用户既有偏好）。
  const zenSidebarRestoreRef = useRef<boolean | null>(null);
  const handleZenModeChange = (nextZen: boolean) => {
    if (nextZen) {
      if (zenSidebarRestoreRef.current === null) {
        zenSidebarRestoreRef.current = Boolean(dirShell.sidebarCollapsed);
      }
      dirShell.setSidebarCollapsed(true);
      setLibraryInspectorOpen(false);
      setIsMobileRightOpen(false);
      return;
    }
    const restore = zenSidebarRestoreRef.current;
    zenSidebarRestoreRef.current = null;
    if (restore !== null) dirShell.setSidebarCollapsed(restore);
  };

  // U05 · 迷你版本轴「进入版本时光机 →」：只做视图跳转（与「查看关联」同一路径范式），
  // 不改 pinnedRevisionId / 未读基线 / 只读语义。
  const handleOpenTimeMachine = () => {
    setEventTrail((prev) =>
      enterEventFrame(prev, activeFile, undefined, activeFile.title, pinnedRevisionId)
    );
    setActiveTab('panorama');
    setPanoramaMode('canvas');
    setIsMobileRightOpen(false);
  };

  return (
    <>
      {/* Narrow Viewport Drawer Bar */}
      <div className="xl:hidden relative flex items-center justify-between px-4 py-1.5 bg-card/82 dark:bg-card/88 backdrop-blur-md border-b border-[color:var(--glass-hairline)] shadow-[0_1px_3px_color-mix(in_srgb,var(--ink-strong)_6%,transparent)] text-xs">
        <Button
          variant="secondary"
          size="sm"
          className="lg:hidden"
          onClick={() => setIsMobileLeftOpen((v) => !v)}
        >
          {isMobileLeftOpen ? '收起左栏导航' : '展开左栏目录'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setActiveTab('panorama');
            setPanoramaMode('canvas');
          }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>返回全景溯源</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setIsMobileRightOpen((v) => !v)}
        >
          {isMobileRightOpen ? '关闭右侧检查器' : '打开右侧详情'}
        </Button>
      </div>

      <main className="flex-1 flex overflow-hidden relative min-h-0">
        {/* Center Main Viewport：目录面包屑栏 + 阅读器常驻 / AtlasView 概览 */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Quiet.md 目录面包屑工作栏：仅概览态呈现目录路径与快捷新建/已读入口，阅读态不再与正文双层叠压 */}
          {libraryMode === 'overview' && sidebarFilters.folder !== 'all' && (
            <div
              data-folder-breadcrumb-bar=""
              className="shrink-0 px-4 py-1.5 bg-card/82 dark:bg-card/88 backdrop-blur-md border-b border-[color:var(--glass-hairline)] flex items-center justify-between gap-2 text-[length:var(--text-ui)]"
            >
              <nav aria-label="当前目录面包屑" className="flex items-center gap-1 min-w-0 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setSidebarFilters((prev) => ({ ...prev, folder: 'all' }))}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded-[6px] text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] shrink-0 cursor-pointer motion-safe:transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)]" />
                  <span>工作区根</span>
                </button>
                {activeFolderSegments.map((seg, idx) => {
                  const full = activeFolderSegments.slice(0, idx + 1).join('/');
                  const isLast = idx === activeFolderSegments.length - 1;
                  return (
                    <React.Fragment key={full}>
                      <ChevronRight className="w-3 h-3 text-[color:var(--ink-faint)] shrink-0" />
                      <button
                        type="button"
                        onClick={() => setSidebarFilters((prev) => ({ ...prev, folder: full }))}
                        className={`px-1.5 py-0.5 rounded-[6px] truncate max-w-[180px] cursor-pointer motion-safe:transition-colors ${
                          isLast
                            ? 'font-semibold text-[color:var(--ink-strong)] bg-accent/85 border border-border/70'
                            : 'text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)]'
                        }`}
                      >
                        {seg}
                      </button>
                    </React.Fragment>
                  );
                })}
                <span className="ml-1.5 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] tabular-nums shrink-0">
                  {filteredFiles.length} 份
                </span>
                {activeFolderReadStats.total > 0 && (
                  activeFolderReadStats.unread > 0 ? (
                    <span
                      data-breadcrumb-folder-unread={activeFolderReadStats.unread}
                      title={`本目录共 ${activeFolderReadStats.total} 份，其中 ${activeFolderReadStats.unread} 份未读`}
                      className="inline-flex items-center gap-1 rounded-[var(--r-pill)] px-1.5 py-0.5 font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] tabular-nums text-[color:var(--accent-wave)] bg-[color:color-mix(in_srgb,var(--accent-wave)_10%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-wave)_24%,transparent)] shrink-0"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1 rounded-full bg-[color:var(--accent-wave)] shrink-0"
                      />
                      <span>{activeFolderReadStats.unread} 未读</span>
                    </span>
                  ) : (
                    <span
                      data-breadcrumb-folder-unread="0"
                      title={`本目录全部 ${activeFolderReadStats.total} 份均已读`}
                      className="inline-flex items-center gap-1 rounded-[var(--r-pill)] px-1.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)] bg-[color:color-mix(in_srgb,var(--status-green)_10%,transparent)] border border-[color:color-mix(in_srgb,var(--status-green)_24%,transparent)] shrink-0"
                    >
                      <Check className="w-3 h-3 shrink-0" />
                      <span>全部已读</span>
                    </span>
                  )
                )}
              </nav>

              <div className="flex items-center gap-1 shrink-0">
                {activeFolderReadStats.total > 0 && (
                  activeFolderReadStats.unread > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-breadcrumb-mark-folder-read=""
                      title={`一键将「${sidebarFilters.folder}」内 ${activeFolderReadStats.unread} 份未读文档标为已读（8 秒内可撤销）`}
                      onClick={() => void handleMarkReadingBaseline('folder', sidebarFilters.folder)}
                    >
                      <CheckCheck className="w-3.5 h-3.5 text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)]" />
                      <span>本目录已读</span>
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-breadcrumb-mark-folder-unread=""
                      title={`将「${sidebarFilters.folder}」内全部文档重置为未读（8 秒内可撤销）`}
                      onClick={() => void handleMarkFolderUnread('folder', sidebarFilters.folder)}
                    >
                      <RotateCcw className="w-3 h-3 text-[color:var(--accent-wave)]" />
                      <span>标为未读</span>
                    </Button>
                  )
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (dirShell.sidebarCollapsed) dirShell.setSidebarCollapsed(false);
                    triggerSidebarInlineAction('create-doc', sidebarFilters.folder);
                  }}
                >
                  <FilePlus2 className="w-3.5 h-3.5" />
                  <span>新建文档</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (dirShell.sidebarCollapsed) dirShell.setSidebarCollapsed(false);
                    triggerSidebarInlineAction('create-folder', sidebarFilters.folder);
                  }}
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  <span>子文件夹</span>
                </Button>
                <button
                  type="button"
                  aria-label="退出目录筛选"
                  title="清除目录筛选"
                  onClick={() => setSidebarFilters((prev) => ({ ...prev, folder: 'all' }))}
                  className="w-6 h-6 rounded-[7px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer motion-safe:transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
          {/* pm_2：切概览/改筛选时不卸载阅读器——纸面/行号/版次对比/PDF 页码与滚动位置原样保留 */}
          <div
            ref={readerPaneRef}
            className={
              libraryMode === 'read'
                ? 'flex-1 min-h-0 flex flex-col overflow-hidden'
                : 'hidden'
            }
          >
            {libraryMode === 'read' && sidebarFilterActive && activeFile && !activeFileInFilter && (
              <div
                data-reader-filter-mismatch=""
                className="relative shrink-0 px-4 py-1 bg-card/78 dark:bg-card/85 backdrop-blur-md border-b border-[color:var(--glass-hairline)] text-[11.5px] leading-[18px] text-[color:var(--ink-soft)] flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  {sidebarFilters.folder !== 'all'
                    ? `当前筛选目录「${sidebarFilters.folder}」（${filteredFiles.length} 份）不含本文档`
                    : '当前文章不在筛选内'}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {sidebarFilters.folder !== 'all' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="!h-6 !px-2 !text-[11px]"
                      onClick={() => setLibraryMode('overview')}
                    >
                      查看目录概览
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="!h-6 !px-2 !text-[11px]"
                    onClick={handleClearSidebarFilters}
                  >
                    清除筛选
                  </Button>
                </div>
              </div>
            )}
            <ReaderView
              sourceLine={readerAnchor?.fileId === activeFile.file_id && readerAnchor.revisionId === pinnedRevisionId ? readerAnchor.line : undefined}
              officeAnchor={readerAnchor?.fileId === activeFile.file_id && readerAnchor.revisionId === pinnedRevisionId ? readerAnchor.officeAnchor : undefined}
              pdfAnchor={readerAnchor?.fileId === activeFile.file_id && readerAnchor.revisionId === pinnedRevisionId ? readerAnchor.pdfAnchor : undefined}
              focusSectionId={
                readerFocusSection && readerFocusSection.fileId === activeFile.file_id
                  ? readerFocusSection.sectionId
                  : undefined
              }
              openToScrollPercent={
                readerScrollPercentRef.current &&
                readerScrollPercentRef.current.fileId === activeFile.file_id
                  ? readerScrollPercentRef.current.scrollPercent
                  : undefined
              }
              files={files}
              activeFile={activeFile}
              packageContext={activePackage}
              pinnedRevisionId={pinnedRevisionId}
              onChangeRevision={setPinnedRevisionId}
              subMode={readerSubMode}
              onChangeSubMode={setReaderSubMode}
              readingState={readingStates[activeFile.file_id]}
              onMarkReadHere={handleMarkReadHere}
              onMarkFullyRead={handleMarkFullyRead}
              onMarkUnread={handleMarkUnread}
              onScrollProgress={handleScrollProgress}
              onToggleBookmark={handleToggleBookmark}
              onNavigateLinkedFile={handleNavigateLinkedFile}
              returnBreadcrumb={returnBreadcrumb}
              onFollowReturnBreadcrumb={handleFollowReturnBreadcrumb}
              decisions={decisions}
              relations={relations}
              onSelectDecision={handleOpenDecisionReference}
              onAddEvidencePointer={(p) => {
                handleAddEvidencePointer(p);
                openContextDrawer();
              }}
              // 决策回执 T3：与「加入证据篮」同层动作——装配入篮并弹抽屉让用户
              // 当场核对条目（onAddEvidencePointer 同款交互语义）
              onAddDecisionToBasket={(p) => {
                handleAddDecisionReceiptToBasket(p);
                openContextDrawer();
              }}
              // Inline 拍板闭环（PRD 3.3 / F5）：回写成功 → 未决计数实时 -1
              //（decisions 本地置已确认，共用口径）；阻塞清零 → 长任务恢复横幅（AC-03）
              onDecisionResolved={handleDecisionResolved}
              onBlockingCleared={handleBlockingCleared}
              // v0.8 总装-3：右上角 ⓘ「溯源与关联」开合线程——显隐 state 归 App 级
              // （阅读态默认收起，见 RightInspector 容器合并条件）；溯源明细与
              // 「阅读顺序」上下游跳转由 RightInspector 承载（总装-5）
              inspectorOpen={libraryInspectorOpen}
              onToggleInspector={() => setLibraryInspectorOpen((v) => !v)}
              // U05 · 专注纸面（Zen）：阅读器状态变化 → 壳层收起/恢复左右侧栏
              onZenModeChange={handleZenModeChange}
              // U05 · 迷你版本轴「进入版本时光机 →」：只做视图跳转
              onOpenTimeMachine={handleOpenTimeMachine}
              readingNotice={ctx.changeNotice}
              onSilentMergeNotice={() => {
                void ctx.silentMergeNewEvents();
              }}
              silentMergingNotice={ctx.silentMergingEvents}
              onRefreshNoticeWindow={() => {
                void ctx.refreshEvents();
              }}
              indexGeneration={config.runtimeStatus.indexGeneration}
              stateOverview={stateOverview}
              systemActions={systemActions}
            />
          </div>

          {libraryMode === 'overview' && (
            <AtlasView
              variant="embedded"
              files={filteredFiles}
              readingStates={readingStates}
              events={events}
              onOpenFile={(fileId, revisionId) =>
                ctx.handleOpenFileFromTimelineOrGraph(fileId, revisionId, 'read')
              }
              onQuickPreview={openQuickPreview}
              activeFileId={activeFile.file_id}
              filterActive={sidebarFilterActive}
              filterLabel={sidebarFilterLabel}
              filteredCount={filteredFiles.length}
              onClearFilters={handleClearSidebarFilters}
              onMarkFileRead={handleMarkFullyRead}
              onMarkFileUnread={handleMarkUnread}
              onMarkFolderRead={(folder) =>
                void handleMarkReadingBaseline(folder ? 'folder' : 'workspace', folder || undefined)
              }
              onMarkFolderUnread={(folder) =>
                void handleMarkFolderUnread(folder ? 'folder' : 'workspace', folder || undefined)
              }
              stateOverview={stateOverview}
              systemActions={systemActions}
            />
          )}
        </div>

        {/* Right Inspector——v0.8 总装-2 显隐合并条件：移动端抽屉态（isMobileRightOpen，
            :306 state 由「打开右侧详情」钮驱动）必须原样保留在最前；概览态维持 xl+ 常驻；
            阅读态默认收起、ⓘ「溯源与关联」点开才现（libraryInspectorOpen，总装-3） */}
        <div
          className={`${
            isMobileRightOpen
              ? 'fixed inset-y-0 right-0 z-40 block shadow-2xl'
              : (libraryMode === 'overview' && !overviewInspectorCollapsed) || libraryInspectorOpen
                ? 'hidden xl:block'
                : 'hidden'
          } h-full shrink-0`}
        >
          <RightInspector
            selectedFile={activeFile}
            selectedDecision={decisions.find(
              (d) => d.decision_id === selectedDecisionId
            )}
            files={files}
            decisions={decisions}
            relations={relations}
            readingState={readingStates[activeFile.file_id]}
            onSavePersonalNote={handleSavePersonalNote}
            onOpenFile={(fileId, revId) => {
              const target = files.find((f) => f.file_id === fileId);
              if (target) {
                setActiveFileId(target.file_id);
                setPinnedRevisionId(revId || target.current_revision_id);
                setReaderSubMode('read');
                setActiveTab('library');
                setLibraryMode('read');
                setIsMobileRightOpen(false);
              }
            }}
            onOpenDecision={handleOpenDecisionReference}
            // T04：文件时间线抽屉入口
            onOpenFileTimeline={handleOpenFileTimeline}
            onViewRelationsGraph={() => {
              setEventTrail(prev => enterEventFrame(prev, activeFile, undefined, activeFile.title, pinnedRevisionId));
              setActiveTab('panorama');
              setPanoramaMode('canvas');
              setIsMobileRightOpen(false);
            }}
            // GU-CC-02：入口行为与文案对齐——点击即把统一导出器输出写入剪贴板，
            // 返回写入结果供 RightInspector 决定是否进入「已复制」态；
            // 写入失败返回 false（C4 同款：不谎报成功），清单加入与抽屉打开照常发生
            onCopyObjectToAgent={async (pointer) => {
              handleAddEvidencePointer(pointer);
              openContextDrawer();
              setIsMobileRightOpen(false);
              const res = await copyTextWithDesktopFallback(
                formatContextForAgent([pointer], config.rootPath)
              );
              return res.ok;
            }}
            indexGeneration={config.runtimeStatus.indexGeneration}
            stateOverview={stateOverview}
            systemActions={systemActions}
          />
        </div>
      </main>
    </>
  );
}
