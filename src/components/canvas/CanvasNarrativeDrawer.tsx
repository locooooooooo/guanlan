/**
 * v0.8 任务空间桌面 · 画布叙事抽屉（R3 / 组件契约 C7）。
 *
 * 取代 334px 常驻右侧检视器：双击节点 / 顶栏「详情」时右侧滑出的流式时间叙事面板
 * （w≈340px，translateX+opacity --dur-3 --ease-spring，见 canvasWidgets.css）。
 * 内容为时间轴叙事分节（发生→变更章节→关联决策→引用依据，竖向点线轴非分割表单）；
 * 「打开原文」是 footer 首位钮（画布票 R3：双击语义变更后原文入口的唯一去处）。
 *
 * Esc 先关本抽屉：capture 监听 + stopImmediatePropagation（KnowledgeGraph.tsx:43-53
 * 先例同款），并带 [role="dialog"] 守卫——阅读器/决策弹层开着时不抢 Esc；
 * 可见浮层开着（data-esc-layer="open"）时同样让位，浮层先收口。
 * 锚点：data-cv-narrative-drawer（根）、data-cv-narrative-section={id}（每节）。
 * 舷窗纪律：样式全走 .cvw-*，零内联色值。
 */

import React, { useEffect } from 'react';
import { ArrowLeft, X } from 'lucide-react';
// css 装载上移 App.tsx（总装，指挥授权）：node --test/tsx 测试链加载不了 .css 扩展名，
// 组件内 import 会让 gc-12/wf2/canvas-theme 文件级失败；由 App 常驻装载兜底，零视觉变化

export interface CanvasNarrativeSection {
  id: string;
  label: string;
  /** 节时间戳（observed 口径 HH:MM / YYYY-MM-DD 等，原样透出） */
  timestamp?: string;
  /** 节点色档：default=中性 / change=修改语义（--cv-lane-md）/ decision=决策语义（--cv-lav） */
  tone?: 'default' | 'change' | 'decision';
  body: React.ReactNode;
}

export interface CanvasNarrativeDrawerProps {
  open: boolean;
  title: string;
  /** 标题下 mono 小字行（「已选中 · 层级 N」逐字迁移自旧检视器，R9） */
  metaLine?: string;
  sections: CanvasNarrativeSection[];
  onClose: () => void;
  /** footer 首位=「打开原文」钮由宿主传入（复用 openFileReader 链路） */
  footer?: React.ReactNode;
  /** 可选返回主轴钮（自旧检视器 :4029-4038 迁入；动作不丢失） */
  backButton?: { label: string; onClick: () => void };
}

export default function CanvasNarrativeDrawer({
  open,
  title,
  metaLine,
  sections,
  onClose,
  footer,
  backButton,
}: CanvasNarrativeDrawerProps) {
  // Esc 先关本抽屉（capture + stopImmediatePropagation；弹层守卫同 KnowledgeGraph 先例）。
  // 仲裁让位：可见浮层开着（data-esc-layer="open"，如 FilterDropdown/顶栏帮助浮层）时
  // 直接 return 不抢 Esc——浮层的 document bubble 关闭路径先收口，其 stopPropagation
  // 天然挡住本抽屉与 App 阶梯，各层 Esc 各归各位。
  // 依赖只有 open/onClose：常驻监听以 open 短路，不随抽屉挂卸反复注册。
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]') ||
          document.querySelector('[data-esc-layer="open"]')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open, onClose]);

  return (
    <aside
      className="cvw-narrative-drawer"
      data-cv-narrative-drawer
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open}
      aria-label="节点叙事详情"
    >
      <div className="cvw-narrative-head">
        <div className="cvw-narrative-level">{metaLine}</div>
        <h2 className="cvw-narrative-title">{title}</h2>
        {backButton && (
          <button
            type="button"
            className="cvw-narrative-back"
            onClick={backButton.onClick}
            style={{ display: open ? 'inline-flex' : 'none' }}
          >
            <ArrowLeft className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
            <span>{backButton.label}</span>
          </button>
        )}
      </div>

      <button
        type="button"
        className="cvw-narrative-close"
        aria-label="关闭叙事详情"
        title="关闭叙事详情（Esc）"
        onClick={onClose}
        style={{ display: open ? 'inline-flex' : 'none' }}
      >
        <X className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>

      <div className="cvw-narrative-body">
        {sections.length === 0 ? (
          <div className="cvw-narrative-content">等待工程事件接入后展示叙事。</div>
        ) : (
          sections.map((section) => (
            <section
              key={section.id}
              className="cvw-narrative-section"
              data-cv-narrative-section={section.id}
              data-tone={section.tone ?? 'default'}
            >
              <div className="cvw-narrative-label-row">
                <span className="cvw-narrative-label">{section.label}</span>
                {section.timestamp && <span className="cvw-narrative-ts">{section.timestamp}</span>}
              </div>
              <div className="cvw-narrative-content">{section.body}</div>
            </section>
          ))
        )}
      </div>

      {footer && (
        <div className="cvw-narrative-foot" style={{ display: open ? 'flex' : 'none' }}>
          {footer}
        </div>
      )}
    </aside>
  );
}
