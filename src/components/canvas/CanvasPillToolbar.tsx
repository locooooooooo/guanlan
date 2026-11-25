/**
 * 画布底部药丸工具栏（底部悬浮唯一控制栏）。
 *
 * 挂画布底部正中（宿主 Tailwind：left-1/2 -translate-x-1/2 bottom-4，z-20 低于
 * 叙事抽屉 z-30）；磨砂底 = --cv-panel 92% + backdrop-blur（canvasWidgets.css）。
 * 汇总画布核心交互控件，避免左下/右下多条悬浮栏叠加遮挡：
 *  ① +添加上下文 —— 宿主接既有 onAddEvidencePointer 链路；
 *  ② 指针/抓手双态 —— aria-pressed 语义（--cv-pill-active-* 取值）；
 *  ③ 只看最新/看版本演进双态 —— 联动宿主 isNodeInActiveTimeSlice/activeDate 语义；
 *  ④ 司辰时间轴滑块开关 —— 显隐司辰时间轴并支持时光流转重演；
 *  ⑤ ?快捷键 —— 就地轻弹层（宿主渲染）；
 *  ⑥ ⚙视图设置 —— 触发宿主布局/特效弹层（定位在药丸上方正中）；
 *  ⑦ 缩放簇（− / 百分比读数 / +）+ 重置 —— 读数保留 data-testid="canvas-scale-indicator"；
 *  ⑧ 图例「?」—— 点击展开四泳道图例气泡（气泡由宿主渲染，本组件只出按钮）。
 * 日期切换经主干刻度与司辰滑块完成，再次点击当前选中刻度可回到全域视图。
 * 锚点：容器 data-cv-pill-toolbar，控件 data-cv-pill-btn="add-context|tool|version-view|chronos|view-settings|zoom-out|zoom-percent|zoom-in|reset-view|legend|shortcuts"。
 * 舷窗纪律：样式全走 .cvw-*，零内联色值。
 */

import {
  CircleDot,
  Clock,
  GitBranch,
  Hand,
  HelpCircle,
  Keyboard,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
// 样式文件统一由 App.tsx 装载：Node 测试链不解析 .css 导入，由 App 常驻装载兜底

export interface CanvasPillToolbarProps {
  tool: 'pointer' | 'pan';
  onToolChange: (t: 'pointer' | 'pan') => void;
  versionView: 'latest' | 'evolution';
  onVersionViewChange: (v: 'latest' | 'evolution') => void;
  chronosSliderOpen: boolean;
  onToggleChronosSlider: () => void;
  /** 时光流转重演（可选：缺省时不渲染，兼容旧测试） */
  isTimeFlowPlaying?: boolean;
  onToggleTimeFlow?: () => void;
  onAddContext: () => void;
  onShowShortcuts: () => void;
  /* 视图设置弹层开关（弹层本体由宿主渲染） */
  viewSettingsOpen: boolean;
  onToggleViewSettings: () => void;
  /* 缩放簇（− / 读数 / +）与重置运镜；读数=整数百分比 */
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  /* 泳道图例「?」气泡开关（气泡本体由宿主渲染） */
  legendOpen: boolean;
  onToggleLegend: () => void;
}

export default function CanvasPillToolbar({
  tool,
  onToolChange,
  versionView,
  onVersionViewChange,
  chronosSliderOpen,
  onToggleChronosSlider,
  isTimeFlowPlaying = false,
  onToggleTimeFlow,
  onAddContext,
  onShowShortcuts,
  viewSettingsOpen,
  onToggleViewSettings,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onResetView,
  legendOpen,
  onToggleLegend,
}: CanvasPillToolbarProps) {
  return (
    <div className="cvw-pill-toolbar glx-floating-dock" data-cv-pill-toolbar>
      {/* ① +上下文：接宿主 onAddEvidencePointer 链路（当前选中文件证据指针） */}
      <button
        type="button"
        className="cvw-pill-btn"
        data-cv-pill-btn="add-context"
        title="添加上下文：把当前选中文件的证据指针加入台账"
        onClick={onAddContext}
      >
        <Plus className="w-3 h-3" strokeWidth={1.6} aria-hidden="true" />
        <span>上下文</span>
      </button>

      <span className="cvw-pill-sep" aria-hidden="true" />

      {/* ② 指针/抓手双态：aria-pressed 双钮形制 */}
      <button
        type="button"
        className="cvw-pill-btn"
        data-cv-pill-btn="tool"
        aria-pressed={tool === 'pointer'}
        title={tool === 'pointer' ? '指针：点选节点与卡片（拖拽平移关闭）' : '抓手：拖拽平移画布'}
        onClick={() => onToolChange(tool === 'pointer' ? 'pan' : 'pointer')}
      >
        {tool === 'pointer' ? (
          <MousePointer2 className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Hand className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
        )}
        <span>{tool === 'pointer' ? '指针' : '抓手'}</span>
      </button>

      {/* ③ 最新 / 演进：演进态放开按日调光（isNodeInActiveTimeSlice 全时段可见） */}
      <button
        type="button"
        className="cvw-pill-btn"
        data-cv-pill-btn="version-view"
        aria-pressed={versionView === 'evolution'}
        title={
          versionView === 'latest'
            ? '只看最新：按当前选中日期调光，其余时段降透明'
            : '看版本演进：全时段可见，卡片显示相对上一版的变更章节'
        }
        onClick={() => onVersionViewChange(versionView === 'latest' ? 'evolution' : 'latest')}
      >
        {versionView === 'latest' ? (
          <CircleDot className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <GitBranch className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
        )}
        <span>{versionView === 'latest' ? '最新' : '演进'}</span>
      </button>

      {/* ④ 司辰时间轴显隐与时光流转重演 */}
      <button
        type="button"
        className="cvw-pill-btn"
        data-cv-pill-btn="chronos"
        aria-pressed={chronosSliderOpen}
        title={chronosSliderOpen ? '暂隐司辰神座' : '唤出司辰执掌时间轴'}
        onClick={onToggleChronosSlider}
      >
        <Clock className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
        <span>司辰</span>
      </button>

      {onToggleTimeFlow && (
        <button
          type="button"
          className="cvw-pill-btn"
          data-cv-pill-btn="time-flow"
          aria-pressed={isTimeFlowPlaying}
          title={
            isTimeFlowPlaying
              ? '暂停时光流转重演'
              : '时光流转：由司辰引导从最早沉淀日向今日重演文件累积'
          }
          onClick={onToggleTimeFlow}
        >
          {isTimeFlowPlaying ? (
            <Pause className="w-3 h-3" strokeWidth={1.6} aria-hidden="true" />
          ) : (
            <Play className="w-3 h-3" strokeWidth={1.6} aria-hidden="true" />
          )}
          <span>{isTimeFlowPlaying ? '暂停' : '流转'}</span>
        </button>
      )}

      <span className="cvw-pill-sep" aria-hidden="true" />

      {/* ⑥ ⚙视图设置（纯图标瘦身） */}
      <button
        type="button"
        className="cvw-pill-btn cvw-pill-icon-btn"
        data-cv-pill-btn="view-settings"
        aria-label="视图设置"
        aria-pressed={viewSettingsOpen}
        title="视图设置：布局模式与流光特效开关"
        onClick={onToggleViewSettings}
      >
        <Settings2 className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>

      {/* ⑦ 缩放簇（− / 百分比读数 / +）+ 重置 */}
      <button
        type="button"
        className="cvw-pill-btn cvw-pill-icon-btn"
        data-cv-pill-btn="zoom-out"
        aria-label="缩小画布"
        title="缩小画布（滚轮亦可）"
        onClick={onZoomOut}
      >
        <ZoomOut className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <span
        data-testid="canvas-scale-indicator"
        data-cv-pill-btn="zoom-percent"
        className="cvw-pill-scale"
      >
        {Math.round(zoomPercent)}%
      </span>
      <button
        type="button"
        className="cvw-pill-btn cvw-pill-icon-btn"
        data-cv-pill-btn="zoom-in"
        aria-label="放大画布"
        title="放大画布（滚轮亦可）"
        onClick={onZoomIn}
      >
        <ZoomIn className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="cvw-pill-btn cvw-pill-icon-btn"
        data-cv-pill-btn="reset-view"
        aria-label="重置视图与节点布局"
        title="重置视图与节点布局（回 100% 默认缩放）"
        onClick={onResetView}
      >
        <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>

      <span className="cvw-pill-sep" aria-hidden="true" />

      {/* ⑧ 泳道图例与快捷键（纯图标瘦身） */}
      <button
        type="button"
        className="cvw-pill-btn cvw-pill-icon-btn"
        data-cv-pill-btn="legend"
        aria-label="泳道图例"
        aria-pressed={legendOpen}
        aria-expanded={legendOpen}
        title="泳道图例：四色光点与文件类型对应"
        onClick={onToggleLegend}
      >
        <HelpCircle className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>

      <button
        type="button"
        className="cvw-pill-btn cvw-pill-icon-btn"
        data-cv-pill-btn="shortcuts"
        aria-label="画布快捷键"
        title="画布快捷键与操作提示 (?)"
        onClick={onShowShortcuts}
      >
        <Keyboard className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}
