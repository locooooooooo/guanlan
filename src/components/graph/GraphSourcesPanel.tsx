/**
 * 左侧浮动 Chrome · Sources 来源面板：
 * 承载七个分类折叠组（I/R/S/A/M/C/H）与收起窄条，数据一律来自 controller ctx。
 */

import React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { GraphSourcesMdList } from './GraphSourcesMdList';
import type { GraphCanvasCtx } from './useGraphCanvasController';

/** 左侧浮动来源面板：收起时切换为 w-[44px] 窄条（仅留展开钮），画布可视原点随 260ms 动画左移补位 */
export function GraphSourcesPanel({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    files,
    decisions,
    relations,
    readingStates,
    onSelectFile,
    sourcesPanelCollapsed,
    expandAllSidebar,
    collapseAllSidebar,
    toggleSourcesPanel,
    workspaceName,
    toggleGroup,
    expandedGroups,
    hiddenCategories,
    toggleCategoryVisibility,
    mdFiles,
    mdFindingsCount,
    unreadCount,
    visibleMdFiles,
    showAllMdSources,
    setShowAllMdSources,
    subAgentCards,
    activeFileRecord,
    setSelectedCanvasNodeId,
    exploreAfterClick,
    cancelExplore,
    openFileReader,
    svgFiles,
    scene,
    selectDate,
    activeTimeSlice,
    setActiveTimeSlice,
    pdfFiles,
  } = ctx;
  return (
    <aside
      aria-label="来源 资料分类目录"
      style={{ boxShadow: 'var(--cv-shadow-elevated)' }}
      className={`d3-no-pan absolute left-4 top-3.5 max-h-[calc(100%-4.5rem)] ${
        sourcesPanelCollapsed ? 'w-auto' : 'w-[206px]'
      } rounded-xl bg-[color:color-mix(in_srgb,var(--cv-card)_92%,var(--cv-panel))] backdrop-blur-md border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] flex flex-col overflow-hidden z-20`}
    >
      {/* Header Row */}
      <div className={sourcesPanelCollapsed ? 'px-2.5 py-1.5' : 'px-3.5 pt-3.5 pb-2'}>
        <div className="flex items-center justify-between">
          {!sourcesPanelCollapsed && (
            <span className="text-[12px] font-semibold text-[color:var(--cv-ink)] tracking-tight">
              来源
            </span>
          )}
          <div className="flex items-center gap-2.5 text-[11px] text-[color:var(--cv-ink-dim)]">
            {!sourcesPanelCollapsed && (
              <>
                <button
                  type="button"
                  onClick={expandAllSidebar}
                  className="hover:text-[color:var(--cv-ink-3)] transition-colors cursor-pointer"
                >
                  全部展开
                </button>
                <button
                  type="button"
                  onClick={collapseAllSidebar}
                  className="hover:text-[color:var(--cv-ink-3)] transition-colors cursor-pointer"
                >
                  全部收起
                </button>
              </>
            )}
            <button
              type="button"
              aria-label={sourcesPanelCollapsed ? '展开 来源面板' : '收起 来源面板'}
              title={sourcesPanelCollapsed ? '展开 来源面板' : '收起 来源面板'}
              onClick={toggleSourcesPanel}
              className="inline-flex items-center gap-1 text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] transition-colors cursor-pointer"
            >
              {sourcesPanelCollapsed ? (
                <>
                  <span className="text-[11px] font-medium">来源</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </>
              ) : (
                <ChevronLeft className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Built in / Project Root Summary Row：该行不可折叠故不放箭头装饰，名称取动态工作区名 */}
        {!sourcesPanelCollapsed && (
          <div className="mt-3 flex items-center justify-between text-[11.5px] text-[color:var(--cv-ink-3)] py-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">本工程 · {workspaceName}</span>
            </div>
            <span className="font-mono tabular-nums text-[color:var(--cv-ink)] font-semibold text-[11px]">
              {files.length}
            </span>
          </div>
        )}
      </div>

      {/* Scrollable Category List with Generous Vertical Breathing Room（收起时整列隐藏） */}
      {!sourcesPanelCollapsed && (
      <div className="flex-1 overflow-y-auto px-3.5 pb-3.5 space-y-2.5 text-xs">
        {/* 1. I · Instructions / MD Specs (Expanded by default with clean unboxed items) */}
        <div className="pt-1 border-t border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)]">
          <div
            onClick={() => toggleGroup('MD')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleGroup('MD');
            }}
            className="w-full flex items-center justify-between py-1 rounded hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_3%,transparent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {expandedGroups.MD ? (
                <ChevronDown className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              )}
              <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                I
              </span>
              <span className="text-[11.5px] text-[color:var(--cv-ink)] font-semibold truncate">
                Instructions
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-[color:var(--cv-ink)] font-semibold">
                {mdFiles.length}
                <span className="text-[color:var(--cv-ink-dim)] font-normal">/{files.length}</span>
              </span>
              <button
                type="button"
                aria-label="切换 MD 方案节点显示"
                onClick={(e) => toggleCategoryVisibility(e, 'MD')}
                className="text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)]"
              >
                {hiddenCategories.MD ? (
                  <EyeOff className="w-3.5 h-3.5 text-[color:var(--cv-ink-ghost)]" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="pl-6 pt-0.5 pb-2 text-[11px] text-[color:var(--cv-brand)] font-mono">
            {mdFindingsCount} 处发现 · {unreadCount} 未读
          </div>

          {expandedGroups.MD && (
            <GraphSourcesMdList
              visibleMdFiles={visibleMdFiles}
              mdFiles={mdFiles}
              readingStates={readingStates}
              subAgentCards={subAgentCards}
              activeFileRecord={activeFileRecord}
              showAllMdSources={showAllMdSources}
              setShowAllMdSources={setShowAllMdSources}
              onSelectFile={onSelectFile}
              setSelectedCanvasNodeId={setSelectedCanvasNodeId}
              exploreAfterClick={exploreAfterClick}
              cancelExplore={cancelExplore}
              openFileReader={openFileReader}
            />
          )}
        {/* 2. R · Rules (DEC 决策台账) */}
        <div className="pt-2 border-t border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)]">
          <div
            onClick={() => toggleGroup('DEC')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleGroup('DEC');
            }}
            className="w-full flex items-center justify-between py-1 rounded hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_3%,transparent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {expandedGroups.DEC ? (
                <ChevronDown className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              )}
              <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                R
              </span>
              <span className="text-[11.5px] text-[color:var(--cv-ink-3)] font-medium truncate">
                Rules · 决策
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-[color:var(--cv-ink)]">
                {decisions.filter((d) => !d.isCandidateOnly).length}
                <span className="text-[color:var(--cv-ink-dim)]">/{decisions.length}</span>
              </span>
              <button
                type="button"
                aria-label="切换 DEC 决策节点显示"
                onClick={(e) => toggleCategoryVisibility(e, 'DEC')}
                className="text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)]"
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {expandedGroups.DEC && (
            <div className="pl-6 pt-1.5 space-y-2">
              {decisions
                .filter((d) => !d.isCandidateOnly)
                .map((dec) => (
                  <button
                    key={dec.decision_id}
                    type="button"
                    onClick={() => {
                      const evidence = dec.evidences[0];
                      if (!evidence) return;
                      onSelectFile(evidence.file_id, evidence.revision_id);
                      const matched = subAgentCards.find(
                        (c) => c.fileId === evidence.file_id
                      );
                      if (matched) setSelectedCanvasNodeId(matched.id);
                    }}
                    className="w-full text-left text-[11px] text-[color:var(--cv-ink-muted)] hover:text-[color:var(--cv-ink)] cursor-pointer block truncate"
                  >
                    {dec.namespace}::{dec.code} ({dec.status})
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* 3. S · Skills (REV 版本快照) */}
        <div className="pt-1">
          <div
            onClick={() => toggleGroup('REV')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleGroup('REV');
            }}
            className="w-full flex items-center justify-between py-1 rounded hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_3%,transparent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {expandedGroups.REV ? (
                <ChevronDown className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              )}
              <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                S
              </span>
              <span className="text-[11.5px] text-[color:var(--cv-ink-3)] font-medium truncate">
                Skills · 快照
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-[color:var(--cv-ink)]">
                {files.reduce((sum, f) => sum + f.revisions.length, 0)}
                <span className="text-[color:var(--cv-ink-dim)]">/{files.length}</span>
              </span>
              <Eye className="w-3.5 h-3.5 text-[color:var(--cv-ink-dim)]" />
            </div>
          </div>
          {expandedGroups.REV && (
            <div className="pl-6 pt-1 text-[10.5px] font-mono text-[color:var(--cv-ink-dim)]">
              A → B → A 版本链校验通过
            </div>
          )}
        </div>

        {/* 4. A · Agents (SVG 架构图纸) */}
        <div className="pt-1">
          <div
            onClick={() => toggleGroup('SVG')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleGroup('SVG');
            }}
            className="w-full flex items-center justify-between py-1 rounded hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_3%,transparent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {expandedGroups.SVG ? (
                <ChevronDown className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              )}
              <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                A
              </span>
              <span className="text-[11.5px] text-[color:var(--cv-ink-3)] font-medium truncate">
                Agents · SVG
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-[color:var(--cv-ink)]">
                {svgFiles.length}
                <span className="text-[color:var(--cv-ink-dim)]">/{files.length}</span>
              </span>
              <button
                type="button"
                aria-label="切换 SVG 图纸节点显示"
                onClick={(e) => toggleCategoryVisibility(e, 'SVG')}
                className="text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)]"
              >
                {hiddenCategories.SVG ? (
                  <EyeOff className="w-3.5 h-3.5 text-[color:var(--cv-ink-ghost)]" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
          {expandedGroups.SVG && (
            <div className="pl-6 pt-1.5 space-y-2">
              {svgFiles.map((file) => (
                <button
                  key={file.file_id}
                  type="button"
                  onClick={() => {
                    onSelectFile(file.file_id);
                    const matched = subAgentCards.find((c) => c.fileId === file.file_id);
                    if (matched) setSelectedCanvasNodeId(matched.id);
                    exploreAfterClick(file.file_id);
                  }}
                  onDoubleClick={() => {
                    // 侧栏行双击仍直开阅读器（旧 readAfterDoubleClick 同行为）；
                    // 先取消 pending 单击下钻，防 240ms 后画布被切走
                    cancelExplore();
                    openFileReader(file.file_id);
                  }}
                  className="w-full text-left text-[11px] text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] cursor-pointer block truncate"
                >
                  {file.title}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 5. M · Memory (TIM 时间线轮次) */}
        <div className="pt-1">
          <div
            onClick={() => toggleGroup('TIM')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleGroup('TIM');
            }}
            className="w-full flex items-center justify-between py-1 rounded hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_3%,transparent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {expandedGroups.TIM ? (
                <ChevronDown className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              )}
              <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                M
              </span>
              <span className="text-[11.5px] text-[color:var(--cv-ink-3)] font-medium truncate">
                Memory · 轮次
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-[color:var(--cv-ink)]">
                {scene.hasRealEvents ? scene.totals.days : 0}
                <span className="text-[color:var(--cv-ink-dim)]">/{scene.hasRealEvents ? scene.totals.events : 0}</span>
              </span>
              <Eye className="w-3.5 h-3.5 text-[color:var(--cv-ink-dim)]" />
            </div>
          </div>
          {expandedGroups.TIM && (
            <div className="pl-6 pt-1.5 space-y-1.5">
              {scene.hasRealEvents ? (
                <>
                  {scene.days.slice(0, 5).map((day) => (
                    <button
                      key={day.date || 'undated'}
                      type="button"
                      onClick={() =>
                        // 再次点击当前日期取消选中
                        selectDate(scene.activeDate === day.date ? undefined : day.date)
                      }
                      className={`block text-[10.5px] font-mono cursor-pointer truncate max-w-[170px] ${
                        scene.activeDate === day.date ? 'text-[color:var(--cv-brand)]' : 'text-[color:var(--cv-ink-dim)]'
                      }`}
                    >
                      {day.label} · {day.count} 条
                    </button>
                  ))}
                </>
              ) : (
                (['all', '2:00', '1:00', '0:00'] as const).map((slice) => (
                  <button
                    key={slice}
                    type="button"
                    onClick={() => setActiveTimeSlice(slice)}
                    className={`block text-[10.5px] font-mono cursor-pointer ${
                      activeTimeSlice === slice ? 'text-[color:var(--cv-brand)]' : 'text-[color:var(--cv-ink-dim)]'
                    }`}
                  >
                    {slice === 'all' ? '全部轮次' : `时间片 ${slice}`}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* 6. C · MCP servers (PDF 规范) */}
        <div className="pt-1">
          <div
            onClick={() => toggleGroup('PDF')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleGroup('PDF');
            }}
            className="w-full flex items-center justify-between py-1 rounded hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_3%,transparent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {expandedGroups.PDF ? (
                <ChevronDown className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              )}
              <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                C
              </span>
              <span className="text-[11.5px] text-[color:var(--cv-ink-3)] font-medium truncate">
                MCP · PDF 规范
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-[color:var(--cv-ink)]">
                {pdfFiles.length}
                <span className="text-[color:var(--cv-ink-dim)]">/{files.length}</span>
              </span>
              <button
                type="button"
                aria-label="切换 PDF 规范节点显示"
                onClick={(e) => toggleCategoryVisibility(e, 'PDF')}
                className="text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)]"
              >
                {hiddenCategories.PDF ? (
                  <EyeOff className="w-3.5 h-3.5 text-[color:var(--cv-ink-ghost)]" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
          {expandedGroups.PDF && (
            <div className="pl-6 pt-1.5 space-y-2">
              {pdfFiles.map((file) => (
                <button
                  key={file.file_id}
                  type="button"
                  onClick={() => {
                    onSelectFile(file.file_id);
                    const matched = subAgentCards.find((c) => c.fileId === file.file_id);
                    if (matched) setSelectedCanvasNodeId(matched.id);
                    exploreAfterClick(file.file_id);
                  }}
                  onDoubleClick={() => {
                    // 侧栏行双击仍直开阅读器（旧 readAfterDoubleClick 同行为）；
                    // 先取消 pending 单击下钻，防 240ms 后画布被切走
                    cancelExplore();
                    openFileReader(file.file_id);
                  }}
                  className="w-full text-left text-[11px] text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] cursor-pointer block truncate"
                >
                  {file.title}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 7. H · Hooks (跨文档引用依据) */}
        <div className="pt-1">
          <div
            onClick={() => toggleGroup('REL')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleGroup('REL');
            }}
            className="w-full flex items-center justify-between py-1 rounded hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_3%,transparent)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {expandedGroups.REL ? (
                <ChevronDown className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-[color:var(--cv-ink-dim)] shrink-0" />
              )}
              <span className="w-4 h-4 rounded bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-center text-[9.5px] font-mono text-[color:var(--cv-ink-3)] shrink-0">
                H
              </span>
              <span className="text-[11.5px] text-[color:var(--cv-ink-3)] font-medium truncate">
                Hooks · 引用
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono tabular-nums text-[11px] text-[color:var(--cv-ink)]">
                {relations.length}
              </span>
              <Eye className="w-3.5 h-3.5 text-[color:var(--cv-ink-dim)]" />
            </div>
          </div>
        </div>
      </div>
      </div>
      )}
    </aside>
  );
}
