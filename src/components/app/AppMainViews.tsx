/**
 * D01-a 拆解 · App 主视图分节（原 App.tsx 3550-3763 逐字迁入）：
 * 今日观澜首页 / 资产库空态 / 全景溯源三态（星图舷窗 / 列表 / 日历）。
 * 数据一律来自 useWorkspaceStore ctx；模块常量（INITIAL_CANVAS_THEME /
 * timelineReturnBreadcrumb）从 store 单一出处导入。
 */

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
    // D02 增量聚光灯（司辰旁导航条 + 画布骨架降亮度）
    spotlightEnabled, spotlightItems, spotlightDimmedFileIds, spotlightCursor,
    handleSpotlightToggle, handleSpotlightCursor,
    multiProjects,
  } = ctx;

  // 日历主板 ↔ 右侧迷你月历联动状态（悬停驱动纵贯光束，点击锁定聚焦卡并可一键飞向司辰星图）
  const [calendarFocusedDate, setCalendarFocusedDate] = useState<string | null>(null);
  const [calendarHoveredDate, setCalendarHoveredDate] = useState<string | null>(null);
  // V06：星图 / 日历 / 列表三视图同源排除工作区私有「目录静默清单」（左栏与 Ctrl+K 仍完全可见可阅读）
  const unmutedPanorama = useMemo(
    () => filterOutMutedFolders(files, events, mutedFolders),
    [files, events, mutedFolders]
  );
  // V05：全景顶栏共享域过滤（日历 / 星图 / 列表同源消费，复用 formatMeta 13 族分类 SSOT，严格 MECE 守恒）
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
                  ? 'gap-1 rounded-full px-2 text-[11px] whitespace-nowrap text-[color:var(--cv-seg-idle)] hover:text-[color:var(--cv-seg-idle-hover)] aria-[pressed=true]:text-[color:var(--cv-seg-active-ink)]'
                  : 'gap-1 px-2 text-[11px] whitespace-nowrap'
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

  // U10：首页「司辰今日徽记」/事件走势柱图 → 全景直跳。
  // 锁定语义用 setActiveDate 直写——handleSelectCanvasDate 是「再点同值即清空」的
  // toggle（只属于画布内自点）；首页直跳要的是锁定聚焦，绝不让用户点一次柱子后
  // 聚焦反被清掉（高风险点 #5：直跳 ≠ toggle）。
  const handleJumpFromHomeToStarMap = (date: string) => {
    setActiveDate(date);
    setActiveTab('panorama');
    setPanoramaMode('canvas');
  };
  // 日历落点：锁定 activeDate 并同步右侧「当日沉淀聚焦卡」（calendarFocusedDate 为
  // 本组件本地态，首页直跳可直接写入，无需抬升进 store）
  const handleJumpFromHomeToCalendar = (date: string) => {
    setActiveDate(date);
    setCalendarFocusedDate(date);
    setActiveTab('panorama');
    setPanoramaMode('calendar');
  };

  return (
    <>
      {/* PRIMARY VIEW 1: 今日观澜首页（玻璃改版新增）——轻数据（bootstrap 快照 + /events/days）先行渲染，
          files/events 分页续拉到达后统计卡与任务动态自动补齐；初始化 loading 态由上方进度块接管 */}
      {activeTab === 'home' && !(dataSource === 'loading' && files.length === 0 && !dataError) && (
        <main key="view-home" className="glx-view-enter flex-1 flex min-h-0 flex-col overflow-hidden">
          <HomeView
            files={files}
            readingStates={readingStates}
            events={events}
            summary={workspaceSummary}
            eventDays={eventDays}
            recentItems={recentItems}
            // v0.8 总装-4：专题卡 A 数据面——decisions 原始数组进 HomeView，卡内按
            // DecisionRadar 同口径过滤取前 2（FeaturedFocusCards 组件自身零造数）；
            // 斜叠决策卡点击复用决策引用跳证据原文链路
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
            // U10：柱图/徽记带日期直跳——精确 YYYY-MM-DD 锁定进星图/日历聚焦态
            onOpenPanoramaAt={handleJumpFromHomeToStarMap}
            onOpenCalendarAt={handleJumpFromHomeToCalendar}
            onOpenChronosDigest={() => ctx.setIsChronosDigestOpen(true)}
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

      {/* 接口失败或工作区为空时：知识资产库三栏必须有可渲染的空态，不得崩溃 */}
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

      {/* PRIMARY VIEW 2: 全景溯源（契约⑤）——星图 hidden 保活常驻：
          切列表/日历或去其他工作区都不卸载，画布选中态/力导向布局不丢 */}
      {/* T01：轻数据（eventDays）就绪即可渲染画布，文件元数据由 bootstrap 首批 + files 分页续拉补齐 */}
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
          // v0.7（§1.1）：主题作用域挂舷窗唯一安装点——一处属性覆盖 KnowledgeGraph /
          // GraphCanvasView / ChronosMascotNode / eventGraph.css / 时光机全部后代。
          // 不挂 html（scope 谎报），不挂 GraphCanvasView 根 div（漏 eventGraph 消费方）。
          // 评审第 2 轮起属性只由 React 写首帧初值（常量），翻转走 handleCanvasThemeChange
          // 命令式 dataset 直写——初值常量永不更新，后续重渲 diff 相同不会覆写命令式值
          data-canvas-theme={INITIAL_CANVAS_THEME}
        >
        <KnowledgeGraph
          trail={eventTrail}
          setTrail={setEventTrail}
          visible={activeTab === 'panorama' && panoramaMode === 'canvas'}
          root={config.rootPath}
          stateOverview={stateOverview}
          systemActions={systemActions}
          // V05 + V06：资产域切换与静默目录提示以原生 flex 插槽并入星图顶栏，杜绝绝对定位遮盖工具栏按钮
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
          // v0.7：画布主题切换回调经 GraphCanvasViewProps 扩散（KnowledgeGraph 零改动）；
          // 评审第 2 轮起值不再随 props 走（画布零主题重渲），分段钮/页签 theme 订阅 store
          onCanvasThemeChange={handleCanvasThemeChange}
          // 契约⑤：三态切换的必填透传（KnowledgeGraph 经 Omit<GraphCanvasViewProps,…> 零改动扩散给画布）
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
          // T05：再次点击当前刻度/日期可取消选中（undefined 回到画布自选最新一天）
          onSelectDate={handleSelectCanvasDate}
          // T03：标尺粒度（月/周/日）切换与聚合刻度下钻到日
          granularity={dayGranularity}
          onGranularityChange={handleGranularityChange}
          onDrillToBucket={handleDrillToBucket}
          // T05：日期组 / 「N 条待展开」一步切到全景列表态看当天全部（from=to 服务端下推）
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

      {/* 全景溯源 列表态：与星图顶栏同一浮动玻璃卡片语言，消除切换星图/列表/日历时的视觉跳变 */}
      {activeTab === 'panorama' && panoramaMode === 'list' && (
        <main key="view-panorama-list" className="glx-view-enter flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="mx-3.5 mt-2.5 px-4 py-1.5 rounded-[14px] depth-2-card flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              {renderPanoramaModeSwitch()}
              {renderDomainToolbar()}
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
              <span>
                {panoramaDomain === 'all' && mutedFolders.length === 0
                  ? `${workspaceSummary?.counts.events ?? events.length} 条事件`
                  : `${domainFiltered.files.length} 资产 · ${domainFiltered.events.length} 条事件`}
              </span>
              <button
                type="button"
                data-open-chronos-digest=""
                onClick={() => ctx.setIsChronosDigestOpen(true)}
                title="打开「司辰手记」今日/本周沉淀简报"
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/80 bg-card/90 px-2.5 py-0.5 font-sans text-[11px] font-medium text-[color:var(--accent-iris-deep)] hover:border-[color:var(--accent-iris)]"
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
            // T05：日期筛选选项来自 /events/days 全量日期；筛选值受控并下推服务端
            eventDays={panoramaEventDays}
            dateFilter={dateFilter.from || 'all'}
            onDateFilterChange={(d) => void applyDayFilter(d === 'all' ? undefined : d)}
            // pm_3：类型筛选同样受控并下推服务端（kinds 参与游标指纹）
            kindFilter={eventKindFilter}
            onKindFilterChange={(kind) => void applyKindFilter(kind)}
            onResetFilters={() => void resetEventFilters()}
            selectedEventId={selectedEventId}
            onSelectEvent={(ev) => {
              setSelectedEventId(ev.event_id);
              // workspace_baseline/decision 等事件无关联文件（file_id 为空）：
              // 跳过选中回写，避免阅读器悬空打开兜底文件
              if (ev.file_id) {
                setActiveFileId(ev.file_id);
                setPinnedRevisionId(ev.revision_id);
              }
            }}
            onOpenFileFromTimeline={handleOpenFileFromTimelineOrGraph}
            // T04：文件时间线抽屉入口
            onOpenFileTimeline={handleOpenFileTimeline}
            onQuickPreview={openQuickPreview}
            onOpenDecisionFromTimeline={handleOpenDecisionReference}
            onJumpToStarMap={handleJumpFromCalendarToStarMap}
            systemActions={systemActions}
          />
        </main>
      )}

      {/* 全景溯源 日历态：与星图/列表同一浮动三态切换顶栏 + V05 域过滤 Toolbar */}
      {activeTab === 'panorama' && panoramaMode === 'calendar' && (
        <main key="view-panorama-calendar" className="glx-view-enter flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="mx-3.5 mt-2.5 px-4 py-1.5 rounded-[14px] depth-2-card flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              {renderPanoramaModeSwitch()}
              {renderDomainToolbar()}
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
              <span>
                {domainFiltered.files.length} 资产 · {domainFiltered.events.length} 事件
              </span>
              <button
                type="button"
                data-open-chronos-digest=""
                onClick={() => ctx.setIsChronosDigestOpen(true)}
                title="打开「司辰手记」今日/本周沉淀简报"
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/80 bg-card/90 px-2.5 py-0.5 font-sans text-[11px] font-medium text-[color:var(--accent-iris-deep)] hover:border-[color:var(--accent-iris)]"
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
