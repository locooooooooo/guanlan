
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

export interface CanvasPillToolbarProps {
  tool: 'pointer' | 'pan';
  onToolChange: (t: 'pointer' | 'pan') => void;
  versionView: 'latest' | 'evolution';
  onVersionViewChange: (v: 'latest' | 'evolution') => void;
  chronosSliderOpen: boolean;
  onToggleChronosSlider: () => void;
  isTimeFlowPlaying?: boolean;
  onToggleTimeFlow?: () => void;
  onAddContext: () => void;
  onShowShortcuts: () => void;
  viewSettingsOpen: boolean;
  onToggleViewSettings: () => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
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
