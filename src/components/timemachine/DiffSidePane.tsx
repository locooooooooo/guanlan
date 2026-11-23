import type { ReactNode } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';

/**
 * D03 · 文档版本时光机「多模态对比」停靠侧面板外壳。
 *
 * - 停靠在 .event-plot（position:relative 既有锚）右缘的普通 HTML 层——不是浮层弹窗，
 *   不入 App Esc 阶梯、不挂 data-esc-layer（不遮挡全屏，仅覆盖画布右侧空白卡区）；
 *   d3.zoom 监听在 <svg> 上，鼠标事件落在本层不会触发画布缩放；
 * - 视觉走既有 glass 令牌（--cv-panel/--cv-card/--cv-hairline-ink），无新裸色值；
 * - 关闭/展开由宿主（DocumentTimeMachineView）持状态，本组件纯受控渲染。
 */
export interface DiffSidePaneProps {
  /** 格式徽标：MD / SVG / CSV / XLSX … */
  badge: string;
  /** 对比方向：`v2 → v3` */
  subtitle: string;
  /** 面板标题（当前视图文案由宿主注入，如「人类可读对比 / 叠影对比 / 表格数值对比」） */
  title: string;
  /** 受控展开态；false 渲染右缘细条把手（点击展开），true 渲染完整面板 */
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

export function DiffSidePane({ badge, subtitle, title, open, onToggle, children }: DiffSidePaneProps) {
  if (!open) {
    return (
      <button
        type="button"
        data-machine-diff-pane="collapsed"
        onClick={onToggle}
        className="absolute right-1 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2"
        style={{
          background: 'var(--cv-panel)',
          borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 22%, transparent)',
          color: 'var(--cv-ink-3)',
        }}
        title={`展开${title}`}
        aria-label={`展开${title}`}
      >
        <PanelRightOpen size={14} />
        <span className="font-mono text-[10px] tracking-widest" style={{ writingMode: 'vertical-rl' }}>
          {badge} · 对比
        </span>
      </button>
    );
  }
  return (
    <section
      data-machine-diff-pane="open"
      aria-label={`${badge}版本对比 · ${subtitle}`}
      className="absolute inset-y-0 right-0 z-10 flex min-w-0 flex-col overflow-hidden border-l"
      style={{
        // V09：左侧版本链恒保留 ≥360px 可视宽度，彻底消除 v2/v1 卡片右缘截断
        width: 'min(560px, max(280px, calc(100% - 360px)))',
        background: 'color-mix(in srgb, var(--cv-panel) 88%, transparent)',
        borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 16%, transparent)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <header
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 12%, transparent)' }}
      >
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
          style={{ background: 'var(--cv-card)', color: 'var(--cv-brand-ink)' }}
        >
          {badge}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold" style={{ color: 'var(--cv-ink-3)' }} title={title}>
          {title}
        </h3>
        <span className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>{subtitle}</span>
        <button
          type="button"
          data-machine-diff-pane-close=""
          onClick={onToggle}
          className="rounded p-1"
          style={{ color: 'var(--cv-ink-meta)' }}
          title="收起对比面板（版本轴保留可见）"
          aria-label="收起对比面板"
        >
          <PanelRightClose size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">{children}</div>
    </section>
  );
}
