
import React, { useSyncExternalStore } from 'react';
import { Activity, BookMarked, ChevronLeft, ChevronRight, MoonStar, Orbit, Pause, Play, Sparkles, Sun } from 'lucide-react';
import { Tabs, type TabsProps } from '../ui/primitives';
import { getCanvasTheme, subscribeCanvasTheme } from '../../utils/canvasThemeStore';
import type { CanvasTheme } from '../../utils/canvasThemeStore';
import CanvasPillToolbar from '../canvas/CanvasPillToolbar';
import { sceneDateLabel, type PanoramaMode } from './geometry';
import { GraphSpotlightBar } from './GraphSpotlightBar';
import type { GraphCanvasCtx } from './useGraphCanvasController';


/** 全景三态页签（星图/列表/日历）：主题形制自订阅，其余 props 原样透传 Tabs */
export function CanvasThemeAwareTabs(props: Omit<TabsProps, 'theme'>) {
  const canvasTheme = useSyncExternalStore(subscribeCanvasTheme, getCanvasTheme);
  return <Tabs {...props} theme={canvasTheme === 'xray-light' ? 'light' : 'dark'} />;
}

/** 画布主题分段钮（双 aria-pressed 形制）：激活段自订阅 */
export function CanvasThemeSegmented({ onChange }: { onChange?: (theme: CanvasTheme) => void }) {
  const canvasTheme = useSyncExternalStore(subscribeCanvasTheme, getCanvasTheme);
  return (
    <div
      role="group"
      aria-label="画布主题"
      className="flex items-center gap-0.5 h-[var(--ctl-h)] px-1 rounded-full border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)]"
    >
      {(
        [
          { key: 'xray-dark', label: '夜航', icon: MoonStar },
          { key: 'xray-light', label: '纸面', icon: Sun },
        ] as const
      ).map((seg) => {
        const SegIcon = seg.icon;
        const activeSeg = canvasTheme === seg.key;
        return (
          <button
            key={seg.key}
            type="button"
            aria-pressed={activeSeg}
            aria-label={seg.key === 'xray-light' ? '切换画布为纸面主题' : '切换画布为夜航主题'}
            title={seg.key === 'xray-light' ? '切换画布为纸面主题' : '切换画布为夜航主题'}
            onClick={() => onChange?.(seg.key)}
            className={`h-[var(--ctl-h-sm)] px-2 rounded-full flex items-center gap-1 text-[11px] font-medium cursor-pointer motion-safe:[transition:background-color_var(--dur-1)_var(--ease-fade),color_var(--dur-1)_var(--ease-fade)] ${
              activeSeg
                ? 'bg-[color:var(--cv-seg-active-bg)] text-[color:var(--cv-seg-active-ink)]'
                : 'text-[color:var(--cv-seg-idle)] hover:text-[color:var(--cv-seg-idle-hover)]'
            }`}
          >
            <SegIcon className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
            <span>{seg.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 全景溯源工作区顶栏：星图/列表/日历三态切换 + 画布主题分段钮 + 当前司辰日期。 */
export function GraphTopBar({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    panoramaMode,
    onPanoramaModeChange,
    onCanvasThemeChange,
    openNarrativeDrawer,
    activeDate,
    scene,
    rulerGranularity,
    onGranularityChange,
    isTimeFlowPlaying,
    toggleTimeFlowPlay,
    stepChronosDay,
    canStepOlder,
    canStepNewer,
    accumulationSummary,
    onOpenChronosDigest,
    topBarSlot,
  } = ctx;
  return (
    <div className="mx-3.5 mt-2.5 px-4 py-1.5 rounded-[14px] bg-[color:var(--cv-panel)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[12px] shrink-0 z-20">
      <div className="flex items-center gap-3 min-w-0 flex-wrap">
        <CanvasThemeAwareTabs
          items={[
            { key: 'canvas', label: '星图' },
            { key: 'list', label: '列表' },
            { key: 'calendar', label: '日历' },
          ]}
          active={panoramaMode}
          onChange={(key) => onPanoramaModeChange(key as PanoramaMode)}
          ariaLabel="全景溯源视图切换"
        />
        {topBarSlot}
      </div>
      <div
        role="toolbar"
        data-slot="toolbar"
        aria-label="星图画布工具栏"
        className="flex items-center gap-2 flex-wrap justify-end"
      >
        {onGranularityChange && scene.hasRealEvents && (
          <div
            role="group"
            aria-label="事件轴粒度"
            data-cv-granularity-switch=""
            className="flex items-center gap-0.5 h-[var(--ctl-h)] px-1 rounded-full border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)]"
          >
            {(
              [
                { key: 'month', label: '月' },
                { key: 'week', label: '周' },
                { key: 'day', label: '日' },
              ] as const
            ).map((opt) => {
              const activeOpt = rulerGranularity === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={activeOpt}
                  title={`按${opt.label}聚合事件轴刻度`}
                  onClick={() => onGranularityChange(opt.key)}
                  className={`h-[var(--ctl-h-sm)] px-2 rounded-full text-[11px] font-medium cursor-pointer motion-safe:[transition:background-color_var(--dur-1)_var(--ease-fade),color_var(--dur-1)_var(--ease-fade)] ${
                    activeOpt
                      ? 'bg-[color:var(--cv-seg-active-bg)] text-[color:var(--cv-seg-active-ink)]'
                      : 'text-[color:var(--cv-seg-idle)] hover:text-[color:var(--cv-seg-idle-hover)]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
        <CanvasThemeSegmented onChange={onCanvasThemeChange} />
        <button
          type="button"
          data-cv-topbar-detail
          onClick={() => openNarrativeDrawer({})}
          className="glx-pill-tactile px-2.5 py-0.5 rounded-full text-[11px] font-medium text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] hover:border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_25%,transparent)] cursor-pointer"
        >
          详情
        </button>
        {onOpenChronosDigest && (
          <button
            type="button"
            data-open-chronos-digest=""
            onClick={onOpenChronosDigest}
            title="打开「司辰手记」查看今日 / 近 7 日沉淀简报并一键复制 Markdown"
            className="glx-pill-tactile inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium text-[color:var(--cv-lav-ink)] bg-[color:color-mix(in_srgb,var(--cv-lav)_12%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--cv-lav)_20%,transparent)] border border-[color:color-mix(in_srgb,var(--cv-lav)_34%,transparent)] cursor-pointer"
          >
            <BookMarked className="w-3 h-3" aria-hidden="true" />
            <span>司辰手记</span>
          </button>
        )}
        <GraphSpotlightBar ctx={ctx} mode="toggle" />
        {(() => {
          const fullDateText =
            activeDate === undefined
              ? scene.activeDate
                ? sceneDateLabel(scene.activeDate, rulerGranularity)
                : '全域'
              : sceneDateLabel(activeDate, rulerGranularity);
          const shortDateText = /^\d{4}-\d{2}-\d{2}$/.test(fullDateText)
            ? fullDateText.slice(5)
            : fullDateText;
          const canPlay = canStepOlder || canStepNewer;
          return (
            <div
              data-cv-chronos-stepper=""
              className="flex items-center gap-0.5 h-[var(--ctl-h)] px-1 rounded-full bg-[color:var(--cv-slot)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] shrink-0"
              title={
                accumulationSummary
                  ? `司辰 · ${fullDateText}（第 ${accumulationSummary.chronologicalOrder}/${accumulationSummary.totalActiveDays} 个沉淀日，截至当日累计沉淀 ${accumulationSummary.cumulativeEvents} 条文档记录，占总历程 ${accumulationSummary.cumulativePercent}%）`
                  : `司辰聚焦时间 · ${fullDateText}`
              }
            >
              {canPlay && (
                <button
                  type="button"
                  aria-label="回溯更早一日"
                  disabled={!canStepOlder}
                  onClick={() => stepChronosDay(-1)}
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] disabled:opacity-30 cursor-pointer disabled:cursor-default transition-colors"
                >
                  <ChevronLeft className="w-3 h-3" strokeWidth={1.7} aria-hidden="true" />
                </button>
              )}
              {canPlay && (
                <button
                  type="button"
                  aria-label={isTimeFlowPlaying ? '暂停时光流转' : '播放时光流转'}
                  aria-pressed={isTimeFlowPlaying}
                  onClick={toggleTimeFlowPlay}
                  className={`w-5 h-5 rounded-full flex items-center justify-center cursor-pointer transition-colors ${
                    isTimeFlowPlaying
                      ? 'bg-[color:var(--cv-seg-active-bg)] text-[color:var(--cv-seg-active-ink)]'
                      : 'text-[color:var(--cv-brand)] hover:bg-[color:color-mix(in_srgb,var(--cv-brand)_12%,transparent)]'
                  }`}
                >
                  {isTimeFlowPlaying ? (
                    <Pause className="w-2.5 h-2.5" strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Play className="w-2.5 h-2.5 translate-x-[0.5px]" strokeWidth={2} aria-hidden="true" />
                  )}
                </button>
              )}
              <span className="px-1.5 font-mono text-[10.5px] font-medium text-[color:var(--cv-ink)] tabular-nums">
                {shortDateText}
              </span>
              {accumulationSummary && (
                <span className="hidden xl:inline-flex items-center pr-1 font-mono text-[10px] text-[color:var(--cv-ink-meta)] tabular-nums">
                  · 累计 {accumulationSummary.cumulativeEvents}
                </span>
              )}
              {canPlay && (
                <button
                  type="button"
                  aria-label="步进更新一日"
                  disabled={!canStepNewer}
                  onClick={() => stepChronosDay(1)}
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] disabled:opacity-30 cursor-pointer disabled:cursor-default transition-colors"
                >
                  <ChevronRight className="w-3 h-3" strokeWidth={1.7} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/** 视图设置弹层：布局三钮 + 特效三开关；由底部药丸「视图设置」触发，定位于 bottom-16 正中 */
export function GraphViewSettings({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    isViewSettingsOpen,
    narrativeDrawerOpen,
    handleToggleLayoutMode,
    canvasLayoutMode,
    setLiveFlowEnabled,
    liveFlowEnabled,
    setMeteorShowerEnabled,
    meteorShowerEnabled,
    setMeteorBurstKey,
    setXrayLaserEnabled,
    xrayLaserEnabled,
  } = ctx;
  if (!isViewSettingsOpen) return null;
  return (
    <div
      style={{ left: narrativeDrawerOpen ? 'calc(50% - 170px)' : '50%' }}
      className="d3-no-pan glx-popover-in absolute bottom-16 -translate-x-1/2 w-[230px] rounded-xl bg-[color:color-mix(in_srgb,var(--cv-card)_96%,var(--cv-panel))] backdrop-blur-md border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] shadow-[var(--cv-shadow-elevated)] p-2 space-y-1 z-20 flex flex-col items-start transition-[left] duration-300"
    >
      <button
        type="button"
        onClick={() => handleToggleLayoutMode('xray')}
        className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
          canvasLayoutMode === 'xray'
            ? 'bg-[color:var(--cv-slot)] text-[color:var(--cv-ink)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_15%,transparent)]'
            : 'text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)]'
        }`}
      >
        x-ray 脉络
      </button>
      <button
        type="button"
        onClick={() => handleToggleLayoutMode('force')}
        className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
          canvasLayoutMode === 'force'
            ? 'bg-[color:var(--cv-slot)] text-[color:var(--cv-ink)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_15%,transparent)]'
            : 'text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)]'
        }`}
      >
        D3 力导向
      </button>
      <button
        type="button"
        onClick={() => handleToggleLayoutMode('radial')}
        className={`px-2 py-0.5 rounded flex items-center gap-1 transition-colors cursor-pointer ${
          canvasLayoutMode === 'radial'
            ? 'bg-[color:var(--cv-slot)] text-[color:var(--cv-ink)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_15%,transparent)]'
            : 'text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)]'
        }`}
      >
        <Orbit className="w-3 h-3 text-[color:var(--cv-lav)]" />
        <span>D3 星环</span>
      </button>

      <button
        type="button"
        onClick={() => setLiveFlowEnabled((v) => !v)}
        className={`px-2 py-0.5 rounded flex items-center gap-1 transition-colors cursor-pointer ${
          liveFlowEnabled
            ? 'bg-[color:color-mix(in_srgb,var(--cv-lav)_10%,var(--cv-panel))] text-[color:var(--cv-lav-ink)] border border-[color:color-mix(in_srgb,var(--cv-lav)_40%,transparent)]'
            : 'text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink-3)]'
        }`}
      >
        <Sparkles className="w-3 h-3 text-[color:var(--cv-lav)]" />
        <span>流式粒子 {liveFlowEnabled ? '开' : '关'}</span>
      </button>

      <button
        type="button"
        onClick={() => {
          setMeteorShowerEnabled((v) => !v);
          setMeteorBurstKey((k) => k + 1);
        }}
        className={`px-2 py-0.5 rounded flex items-center gap-1 transition-colors cursor-pointer ${
          meteorShowerEnabled
            ? 'bg-[color:color-mix(in_srgb,var(--cv-brand)_10%,var(--cv-panel))] text-[color:var(--cv-ink)] border border-[color:color-mix(in_srgb,var(--cv-amber)_45%,transparent)]'
            : 'text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink-3)]'
        }`}
      >
        <Orbit className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span>流星雨 {meteorShowerEnabled ? '开' : '关'}</span>
      </button>

      <button
        type="button"
        onClick={() => setXrayLaserEnabled((v) => !v)}
        className={`px-2 py-0.5 rounded flex items-center gap-1 transition-colors cursor-pointer ${
          xrayLaserEnabled
            ? 'bg-[color:var(--cv-slot)] text-[color:var(--cv-ink-3)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_15%,transparent)]'
            : 'text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink-3)]'
        }`}
      >
        <Activity className="w-3 h-3 text-[color:var(--cv-amber-ink)]" />
        <span>X-Ray 扫描</span>
      </button>
    </div>
  );
}

/** 底部药丸工具栏接线（画布底部唯一悬浮控制栏）：
    控件包含 +上下文 / 指针抓手 / 只看最新·演进 / 司辰滑块 / ⚙视图设置 / 缩放±%·重置 /
    图例? / ?快捷键；left-1/2 bottom-4 正中悬浮，磨砂底 --cv-panel 92% + backdrop-blur，
    z-20 低于叙事抽屉 z-30；选中态使用 --cv-pill-active-*，与顶栏 --cv-seg-* 分段语法分离 */
export function GraphPillToolbarSection({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    canvasTool,
    setCanvasTool,
    versionView,
    setVersionView,
    chronosSliderOpen,
    setChronosSliderOpen,
    isTimeFlowPlaying,
    toggleTimeFlowPlay,
    stepChronosDay,
    canStepOlder,
    canStepNewer,
    replayUnit,
    setReplayUnit,
    replaySpeed,
    setReplaySpeed,
    accumulationSummary,
    scene,
    handleCopyInspectorPointer,
    activeFileRecord,
    activeSubAgent,
    selectedCanvasNodeId,
    setShowShortcuts,
    legendOpen,
    setLegendOpen,
    setIsViewSettingsOpen,
    isViewSettingsOpen,
    zoomTransform,
    zoomByDelta,
    handleResetCanvasLayout,
    narrativeDrawerOpen,
  } = ctx;
  const canReplay = canStepOlder || canStepNewer;
  const showReplayRail = canReplay && isTimeFlowPlaying;
  return (
    <div
      className="pointer-events-none absolute bottom-4 z-20 flex justify-center transition-[left,right] duration-300"
      style={{ left: 16, right: narrativeDrawerOpen ? 356 : 16 }}
    >
      <div className="d3-no-pan pointer-events-auto flex flex-col items-center gap-2 max-w-full">
      {showReplayRail && (
        <div
          role="toolbar"
          data-slot="toolbar"
          data-chronos-replay-rail=""
          aria-label="司辰时光步进回放控制轨"
          className="glx-popover-in flex items-center gap-2 rounded-full border border-[color:color-mix(in_srgb,var(--cv-lav)_34%,transparent)] bg-[color:color-mix(in_srgb,var(--cv-panel)_94%,transparent)] px-3 py-1 text-[11px] text-[color:var(--cv-ink)] shadow-[var(--cv-shadow-elevated)] backdrop-blur-xl"
        >
          <div className="inline-flex items-center gap-0.5 rounded-full bg-[color:var(--cv-slot)] p-0.5" role="group" aria-label="步进单位">
            {(['day', 'week'] as const).map((unit) => (
              <button
                key={unit}
                type="button"
                data-replay-unit={unit}
                aria-pressed={replayUnit === unit}
                onClick={() => setReplayUnit(unit)}
                className={`cursor-pointer rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                  replayUnit === unit
                    ? 'bg-[color:var(--cv-seg-active-bg)] text-[color:var(--cv-seg-active-ink)]'
                    : 'text-[color:var(--cv-seg-idle)] hover:text-[color:var(--cv-seg-idle-hover)]'
                }`}
              >
                {unit === 'day' ? '按日' : '按周'}
              </button>
            ))}
          </div>

          <div className="inline-flex items-center gap-0.5 rounded-full bg-[color:var(--cv-slot)] p-0.5 font-mono" role="group" aria-label="回放倍速">
            {([1, 2] as const).map((spd) => (
              <button
                key={spd}
                type="button"
                data-replay-speed={spd}
                aria-pressed={replaySpeed === spd}
                onClick={() => setReplaySpeed(spd)}
                className={`cursor-pointer rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
                  replaySpeed === spd
                    ? 'bg-[color:var(--cv-seg-active-bg)] text-[color:var(--cv-seg-active-ink)]'
                    : 'text-[color:var(--cv-seg-idle)] hover:text-[color:var(--cv-seg-idle-hover)]'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>

          <div className="inline-flex items-center gap-0.5">
            <button
              type="button"
              aria-label={replayUnit === 'week' ? '回退上一周' : '回退更早一日'}
              disabled={!canStepOlder}
              onClick={() => stepChronosDay(-1)}
              className="flex size-5 cursor-pointer items-center justify-center rounded-full text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] disabled:opacity-30"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="暂停时光步进回放"
              onClick={toggleTimeFlowPlay}
              className="flex size-5 cursor-pointer items-center justify-center rounded-full bg-[color:var(--cv-seg-active-bg)] text-[color:var(--cv-seg-active-ink)]"
            >
              <Pause className="size-2.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={replayUnit === 'week' ? '步进下一周' : '步进更新一日'}
              disabled={!canStepNewer}
              onClick={() => stepChronosDay(1)}
              className="flex size-5 cursor-pointer items-center justify-center rounded-full text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] disabled:opacity-30"
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>

          <span className="font-mono text-[10.5px] tabular-nums text-[color:var(--cv-ink-2)] whitespace-nowrap">
            {scene.activeDate || '—'}
            {accumulationSummary
              ? ` · +${accumulationSummary.addedCount} 新增 / ${accumulationSummary.modifiedCount} 演进 · 累计 ${accumulationSummary.cumulativeEvents}`
              : ''}
          </span>
        </div>
      )}
      <CanvasPillToolbar
        tool={canvasTool}
        onToolChange={setCanvasTool}
        versionView={versionView}
        onVersionViewChange={setVersionView}
        chronosSliderOpen={chronosSliderOpen}
        onToggleChronosSlider={() => setChronosSliderOpen((v) => !v)}
        isTimeFlowPlaying={isTimeFlowPlaying}
        onToggleTimeFlow={canStepOlder || canStepNewer ? toggleTimeFlowPlay : undefined}
        onAddContext={() =>
          handleCopyInspectorPointer(
            activeFileRecord?.file_id || '',
            `Graph 工具栏上下文引用：${activeSubAgent?.fileName ?? selectedCanvasNodeId}`
          )
        }
        onShowShortcuts={() => {
          setLegendOpen(false);
          setIsViewSettingsOpen(false);
          setShowShortcuts((v) => !v);
        }}
        viewSettingsOpen={isViewSettingsOpen}
        onToggleViewSettings={() => {
          setIsViewSettingsOpen((v) => !v);
          if (!isViewSettingsOpen) {
            setLegendOpen(false);
            setShowShortcuts(false);
          }
        }}
        zoomPercent={zoomTransform.k * 100}
        onZoomIn={() => zoomByDelta(0.15)}
        onZoomOut={() => zoomByDelta(-0.15)}
        onResetView={handleResetCanvasLayout}
        legendOpen={legendOpen}
        onToggleLegend={() => {
          setLegendOpen((v) => !v);
          if (!legendOpen) {
            setShowShortcuts(false);
            setIsViewSettingsOpen(false);
          }
        }}
      />
      </div>
    </div>
  );
}
