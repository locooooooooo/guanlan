
import React, { useMemo, useState } from 'react';
import { BookMarked } from 'lucide-react';
import HomeView from '../HomeView';
import { KnowledgeGraph } from '../KnowledgeGraph';
import { TimelineView } from '../TimelineView';
import { CalendarBoardView } from '../CalendarBoardView';
import { CalendarSidePanels } from '../CalendarSidePanels';
import { Button } from '../ui/primitives';
import { Badge, SegmentedControl, SegmentedControlItem, Toolbar } from '../ui';
import {
  countAssetsByDomain,
  filterAssetsByDomain,
  type AssetDomainFilter,
} from '../../utils/formatMeta';
import {
  filterOutMutedFolders,
  filterPanoramaEventDays,
  filterPanoramaEventPage,
} from '../../utils/sidebarTree';
import { INITIAL_CANVAS_THEME, timelineReturnBreadcrumb } from '../../stores/useWorkspaceStore';
import type { WorkspaceStoreCtx } from '../../stores/useWorkspaceStore';

export function AppMainViews({ ctx }: { ctx: WorkspaceStoreCtx }) {
  const {
    activeTab, files, readingStates, mutedFolders, events, workspaceSummary, eventDays, recentItems,
    decisions, decisionsUnresolvedTotal, handleOpenDecisionReference, openDocFromCalendar, openDocResumeReading,
    handleMarkFullyRead, setActiveTab, setLibraryMode, setPanoramaMode, stateOverview,
    systemActions, dataSource, dataError, activeFile, desktopSystemAvailable,
    handleImportIntoFolder, portholeRef, eventTrail, setEventTrail, config,
    handleCanvasThemeChange, panoramaMode, handleOpenFileFromTimelineOrGraph,
    readerAnchor, setReaderAnchor, setReturnBreadcrumb, setActiveFileId,
    setPinnedRevisionId, handleAddEvidencePointer, openContextDrawer, activeDate,
    handleSelectCanvasDate, setActiveDate, dayGranularity, handleGranularityChange, handleDrillToBucket,
    handleJumpToDayInTimeline, selectedEventId, setSelectedEventId, renderPanoramaModeSwitch,
    eventPage, eventPageLoading, undatedOnly, eventOrder, toggleEventOrder, loadMoreEvents,
    refreshEvents, toggleUndatedEvents, dateFilter, applyDayFilter, eventKindFilter,
    applyKindFilter, resetEventFilters, handleOpenFileTimeline, openQuickPreview,
    spotlightEnabled, spotlightItems, spotlightDimmedFileIds, spotlightCursor,
    handleSpotlightToggle, handleSpotlightCursor,
    multiProjects,
    retryingConnection, handleRetryConnection,
  } = ctx;

  const [calendarFocusedDate, setCalendarFocusedDate] = useState<string | null>(null);
  const [calendarHoveredDate, setCalendarHoveredDate] = useState<string | null>(null);
  const unmutedPanorama = useMemo(
    () => filterOutMutedFolders(files, events, mutedFolders),
    [files, events, mutedFolders]
  );
  const [panoramaDomain, setPanoramaDomain] = useState<AssetDomainFilter>('all');
  const domainCounts = useMemo(
    () => countAssetsByDomain(unmutedPanorama.files),
    [unmutedPanorama.files]
  );
  const domainFiltered = useMemo(
    () => filterAssetsByDomain(unmutedPanorama.files, unmutedPanorama.events, panoramaDomain),
    [unmutedPanorama.files, unmutedPanorama.events, panoramaDomain]
  );
  const domainFilteredRecent = useMemo(() => {
    if (panoramaDomain === 'all' && mutedFolders.length === 0) return recentItems;
    const keptIds = new Set(domainFiltered.files.map((f) => f.file_id));
    return recentItems.filter((item) => keptIds.has(item.file_id));
  }, [panoramaDomain, mutedFolders.length, recentItems, domainFiltered.files]);
  const panoramaEventPage = useMemo(
    () => filterPanoramaEventPage(eventPage, mutedFolders, panoramaDomain),
    [eventPage, mutedFolders, panoramaDomain]
  );
  const panoramaEventDays = useMemo(
    () => filterPanoramaEventDays(eventDays, mutedFolders, panoramaDomain),
    [eventDays, mutedFolders, panoramaDomain]
  );

  const renderDomainToolbar = (inCanvasBar = false) => (
    <Toolbar
      aria-label="全景资产域过滤"
      data-panorama-domain-toolbar=""
      className="border-transparent bg-transparent p-0 shadow-none before:hidden"
    >
      <SegmentedControl
        role="group"
        aria-label="资产域切换"
        size="sm"
        className={
          inCanvasBar
            ? 'rounded-full bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] [&_[data-slot=segmented-control-indicator]]:rounded-full [&_[data-slot=segmented-control-indicator]]:bg-[color:var(--cv-seg-active-bg)] [&_[data-slot=segmented-control-indicator]]:shadow-none'
            : 'bg-[color:var(--depth-1-bg)]'
        }
      >
        {(
          [
            { id: 'all' as const, label: '全部资产', count: domainCounts.all },
            { id: 'business' as const, label: '业务文档', count: domainCounts.business },
            { id: 'code' as const, label: '工程代码', count: domainCounts.code },
          ] as const
        ).map((opt) => {
          const active = panoramaDomain === opt.id;
          return (
            <SegmentedControlItem
              key={opt.id}
              data-domain-option={opt.id}
              aria-pressed={active}
              title={`仅显示${opt.label}（${opt.count} 份）`}
              onClick={() => setPanoramaDomain(opt.id)}
              className={
                inCanvasBar
                  ? 'gap-1 rounded-full px-2 text-[length:var(--text-micro)] whitespace-nowrap text-[color:var(--cv-seg-idle)] hover:text-[color:var(--cv-seg-idle-hover)] aria-[pressed=true]:bg-[color:var(--cv-seg-active-bg)] aria-[pressed=true]:text-[color:var(--cv-seg-active-ink)]'
                  : 'gap-1 px-2 text-[length:var(--text-micro)] whitespace-nowrap'
              }
            >
              <span>{opt.label}</span>
              <span className="font-mono text-[10px] tabular-nums opacity-75">{opt.count}</span>
            </SegmentedControlItem>
          );
        })}
      </SegmentedControl>
    </Toolbar>
  );

  const handleJumpFromCalendarToStarMap = (date: string) => {
    handleSelectCanvasDate(date);
    setPanoramaMode('canvas');
  };

  const handleJumpFromHomeToStarMap = (date: string) => {
    setActiveDate(date);
    setActiveTab('panorama');
    setPanoramaMode('canvas');
  };
  const handleJumpFromHomeToCalendar = (date: string) => {
    setActiveDate(date);
    setCalendarFocusedDate(date);
    setActiveTab('panorama');
    setPanoramaMode('calendar');
  };

  return (
    <>
      {activeTab === 'home' && !(dataSource === 'loading' && files.length === 0 && !dataError) && (
        <main key="view-home" className="glx-view-enter flex-1 flex min-h-0 flex-col overflow-hidden">
          <HomeView
            files={files}
            readingStates={readingStates}
            events={events}
            summary={workspaceSummary}
            eventDays={eventDays}
            recentItems={recentItems}
            dataSource={dataSource}
            dataError={dataError}
            retryingConnection={retryingConnection}
            onRetryConnection={() => void handleRetryConnection()}
            decisions={decisions}
            decisionsUnresolvedTotal={decisionsUnresolvedTotal}
            onOpenDecision={handleOpenDecisionReference}
            onOpenDoc={openDocFromCalendar}
            onResumeReading={openDocResumeReading}
            onMarkFullyRead={handleMarkFullyRead}
            onOpenPackageBoard={() => {
              setActiveTab('library');
              setLibraryMode('overview');
            }}
            onOpenPanorama={() => {
              setActiveTab('panorama');
              setPanoramaMode('canvas');
            }}
            onOpenPanoramaAt={handleJumpFromHomeToStarMap}
            onOpenCalendarAt={handleJumpFromHomeToCalendar}
            onOpenChronosDigest={() => ctx.setIsChronosDigestOpen(true)}
            onPrefetchSvgCover={(fileId, revisionId) => {
              void ctx.ensureRevisionContent(fileId, revisionId);
            }}
            stateOverview={stateOverview}
            systemActions={systemActions}
            multiProject={{
              overview: multiProjects.overview,
              projects: multiProjects.projects,
              activeProjectId: multiProjects.activeProjectId,
              onAddProject: () => {
                multiProjects.setAddProjectError(null);
                multiProjects.setAddProjectModalOpen(true);
              },
              onFocusProject: (projectId, targetTab) => {
                void multiProjects.handleActivateProject(projectId, {
                  projectId,
                  openTab: targetTab ?? 'home',
                  libraryMode: targetTab === 'library' ? 'overview' : undefined,
                });
              },
              onOpenCrossDecision: (item) => {
                void multiProjects.handleActivateProject(item.project_id, {
                  projectId: item.project_id,
                  decisionId: item.decision_id,
                  openTab: 'library',
                  libraryMode: 'read',
                });
              },
              onOpenCrossFile: (item) => {
                void multiProjects.handleActivateProject(item.project_id, {
                  projectId: item.project_id,
                  fileId: item.file_id,
                  openTab: 'library',
                  libraryMode: 'read',
                });
              },
            }}
          />
        </main>
      )}

      {activeTab === 'library' && !activeFile && (
        <main className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-2">
            <p className="text-sm text-[var(--ink-soft)]">
              {dataSource === 'loading'
                ? '正在读取工作区数据…'
                : '当前工作区暂无可浏览的资料（文件列表为空）。'}
            </p>
            {dataError && (
              <p className="text-xs text-[color:var(--stage-ink-exec-text)] break-all">{dataError}</p>
            )}
            {desktopSystemAvailable && dataSource !== 'loading' && !dataError && (
              <div className="pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleImportIntoFolder('')}
                >
                  导入外部文件到工作区…
                </Button>
              </div>
            )}
          </div>
        </main>
      )}

      <main
        className={
          activeTab === 'panorama' && panoramaMode === 'canvas'
            ? 'flex-1 flex min-h-0 overflow-hidden p-3'
            : 'hidden'
        }
      >
        {activeFile || (eventDays && eventDays.groups.length > 0) ? <div
          ref={portholeRef}
          className="dark-porthole relative flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[20px]"
          data-canvas-theme={INITIAL_CANVAS_THEME}
        >
        <KnowledgeGraph
          trail={eventTrail}
          setTrail={setEventTrail}
          visible={activeTab === 'panorama' && panoramaMode === 'canvas'}
          root={config.rootPath}
          stateOverview={stateOverview}
          systemActions={systemActions}
          topBarSlot={
            domainCounts.code > 0 || mutedFolders.length > 0 ? (
              <div className="flex items-center gap-1.5 min-w-0">
                {domainCounts.code > 0 && renderDomainToolbar(true)}
                {mutedFolders.length > 0 && (
                  <Badge
                    variant="secondary"
                    size="sm"
                    data-panorama-muted-badge={mutedFolders.length}
                    title={`已静默 ${mutedFolders.length} 个目录（隐藏 ${unmutedPanorama.mutedFileCount} 份噪点资产），可在左侧目录树底缘恢复`}
                    className="font-mono text-[10px] whitespace-nowrap border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_14%,transparent)] bg-[color:var(--cv-slot)] text-[color:var(--cv-ink-2)]"
                  >
                    已静默 {mutedFolders.length} 目录
                  </Badge>
                )}
              </div>
            ) : undefined
          }
          onCanvasThemeChange={handleCanvasThemeChange}
          panoramaMode={panoramaMode}
          onPanoramaModeChange={setPanoramaMode}
          onOpenChronosDigest={() => ctx.setIsChronosDigestOpen(true)}
          onReadEvidence={(fileId, revisionId, line) => {
            handleOpenFileFromTimelineOrGraph(fileId, revisionId, 'read');
            setReaderAnchor(line ? { fileId, revisionId, line } : null);
            setReturnBreadcrumb(timelineReturnBreadcrumb('返回刚才的事件链'));
          }}
          files={domainFiltered.files}
          events={domainFiltered.events}
          decisions={decisions}
          relations={ctx.relations}
          readingStates={readingStates}
          selectedFileId={activeFile?.file_id ?? ''}
          onSelectFile={(fileId, revId) => {
            const target = files.find((f) => f.file_id === fileId);
            if (target) {
              setActiveFileId(target.file_id);
              setPinnedRevisionId(revId || target.current_revision_id);
            }
          }}
          onOpenReaderModal={(fileId, revId, mode) => {
            handleOpenFileFromTimelineOrGraph(fileId, revId, mode);
          }}
          onOpenDecisionModal={handleOpenDecisionReference}
          onAddEvidencePointer={(pointer) => {
            handleAddEvidencePointer(pointer);
            openContextDrawer();
          }}
          indexGeneration={config.runtimeStatus.indexGeneration}
          eventDays={panoramaEventDays}
          activeDate={activeDate}
          onSelectDate={handleSelectCanvasDate}
          granularity={dayGranularity}
          onGranularityChange={handleGranularityChange}
          onDrillToBucket={handleDrillToBucket}
          onOpenDayInTimeline={handleJumpToDayInTimeline}
          selectedEventId={selectedEventId}
          onSelectEvent={(eventId) => {
            setSelectedEventId(eventId);
            const day = eventDays?.groups.find((g) =>
              g.samples.some((sample) => sample.event_id === eventId)
            );
            if (day) setActiveDate(day.date);
          }}
          spotlight={{
            enabled: spotlightEnabled,
            items: spotlightItems,
            dimmedFileIds: spotlightDimmedFileIds,
            cursor: spotlightCursor,
            onToggle: handleSpotlightToggle,
            onCursor: handleSpotlightCursor,
          }}
        /> </div> : <p className="m-auto text-sm text-[var(--ink-soft)]">当前工程还没有可浏览的资料。</p>}
      </main>

      {activeTab === 'panorama' && panoramaMode === 'list' && (
        <main key="view-panorama-list" className="glx-view-enter flex-1 flex flex-col min-h-0 overflow-hidden">
          <div
            data-panorama-topbar="list"
            className="mx-3.5 mt-2.5 px-4 py-1.5 rounded-[14px] depth-2-card flex flex-wrap items-center justify-between gap-2.5 shrink-0"
          >
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              {renderPanoramaModeSwitch()}
              {domainCounts.code > 0 && renderDomainToolbar()}
            </div>
            <span className="flex items-center gap-2 font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)] shrink-0">
              {mutedFolders.length > 0 && (
                <Badge
                  variant="secondary"
                  size="sm"
                  data-panorama-muted-badge={mutedFolders.length}
                  title={`已静默 ${mutedFolders.length} 个目录（隐藏 ${unmutedPanorama.mutedFileCount} 份噪点资产），可在左侧目录树底缘恢复`}
                  className="font-mono text-[10px]"
                >
                  已静默 {mutedFolders.length} 目录
                </Badge>
              )}
              <span className="whitespace-nowrap">
                {panoramaDomain === 'all' && mutedFolders.length === 0
                  ? `${workspaceSummary?.counts.events ?? events.length} 条事件`
                  : `${domainFiltered.files.length} 资产 · ${domainFiltered.events.length} 条事件`}
              </span>
              <button
                type="button"
                data-open-chronos-digest=""
                onClick={() => ctx.setIsChronosDigestOpen(true)}
                title="打开「司辰手记」查看今日 / 近 7 日沉淀简报并一键复制 Markdown"
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/80 bg-card/90 px-2.5 py-0.5 font-sans text-[11px] font-medium whitespace-nowrap text-[color:var(--accent-iris-deep)] hover:border-[color:var(--accent-iris)]"
              >
                <BookMarked className="size-3" aria-hidden="true" />
                <span>司辰手记</span>
              </button>
            </span>
          </div>
          <TimelineView
            events={domainFiltered.events}
            page={panoramaEventPage}
            loadingPage={eventPageLoading}
            undatedOnly={undatedOnly}
            eventOrder={eventOrder}
            onToggleOrder={toggleEventOrder}
            onLoadMore={loadMoreEvents}
            onRefresh={refreshEvents}
            onToggleUndated={toggleUndatedEvents}
            files={domainFiltered.files}
            readingStates={readingStates}
            eventDays={panoramaEventDays}
            dateFilter={dateFilter.from || 'all'}
            onDateFilterChange={(d) => void applyDayFilter(d === 'all' ? undefined : d)}
            kindFilter={eventKindFilter}
            onKindFilterChange={(kind) => void applyKindFilter(kind)}
            onResetFilters={() => void resetEventFilters()}
            selectedEventId={selectedEventId}
            onSelectEvent={(ev) => {
              setSelectedEventId(ev.event_id);
              if (ev.file_id) {
                setActiveFileId(ev.file_id);
                setPinnedRevisionId(ev.revision_id);
              }
            }}
            onOpenFileFromTimeline={handleOpenFileFromTimelineOrGraph}
            onOpenFileTimeline={handleOpenFileTimeline}
            onQuickPreview={openQuickPreview}
            onOpenDecisionFromTimeline={handleOpenDecisionReference}
            onJumpToStarMap={handleJumpFromCalendarToStarMap}
            systemActions={systemActions}
          />
        </main>
      )}

      {activeTab === 'panorama' && panoramaMode === 'calendar' && (
        <main key="view-panorama-calendar" className="glx-view-enter flex-1 flex flex-col min-h-0 overflow-hidden">
          <div
            data-panorama-topbar="calendar"
            className="mx-3.5 mt-2.5 px-4 py-1.5 rounded-[14px] depth-2-card flex flex-wrap items-center justify-between gap-2.5 shrink-0"
          >
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              {renderPanoramaModeSwitch()}
              {domainCounts.code > 0 && renderDomainToolbar()}
            </div>
            <span className="flex items-center gap-2 font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)] shrink-0">
              {mutedFolders.length > 0 && (
                <Badge
                  variant="secondary"
                  size="sm"
                  data-panorama-muted-badge={mutedFolders.length}
                  title={`已静默 ${mutedFolders.length} 个目录（隐藏 ${unmutedPanorama.mutedFileCount} 份噪点资产），可在左侧目录树底缘恢复`}
                  className="font-mono text-[10px]"
                >
                  已静默 {mutedFolders.length} 目录
                </Badge>
              )}
              <span className="whitespace-nowrap">
                {domainFiltered.files.length} 资产 · {domainFiltered.events.length} 事件
              </span>
              <button
                type="button"
                data-open-chronos-digest=""
                onClick={() => ctx.setIsChronosDigestOpen(true)}
                title="打开「司辰手记」查看今日 / 近 7 日沉淀简报并一键复制 Markdown"
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/80 bg-card/90 px-2.5 py-0.5 font-sans text-[11px] font-medium whitespace-nowrap text-[color:var(--accent-iris-deep)] hover:border-[color:var(--accent-iris)]"
              >
                <BookMarked className="size-3" aria-hidden="true" />
                <span>司辰手记</span>
              </button>
            </span>
          </div>
          <div className="flex-1 flex min-h-0 overflow-hidden">
            <CalendarBoardView
              files={domainFiltered.files}
              events={domainFiltered.events}
              onOpenDocument={openDocFromCalendar}
              systemActions={systemActions}
              focusedDate={calendarFocusedDate}
              hoveredDate={calendarHoveredDate}
              onFocusDate={setCalendarFocusedDate}
              onHoverDate={setCalendarHoveredDate}
              onJumpToStarMap={handleJumpFromCalendarToStarMap}
            />
            <CalendarSidePanels
              files={domainFiltered.files}
              events={domainFiltered.events}
              recentItems={domainFilteredRecent}
              onOpenDocument={openDocFromCalendar}
              systemActions={systemActions}
              focusedDate={calendarFocusedDate}
              hoveredDate={calendarHoveredDate}
              onFocusDate={setCalendarFocusedDate}
              onHoverDate={setCalendarHoveredDate}
              onJumpToStarMap={handleJumpFromCalendarToStarMap}
            />
          </div>
        </main>
      )}
    </>
  );
}
