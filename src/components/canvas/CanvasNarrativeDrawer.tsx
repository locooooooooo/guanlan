
import React, { useEffect } from 'react';
import { ArrowLeft, X } from 'lucide-react';

export interface CanvasNarrativeSection {
  id: string;
  label: string;
  timestamp?: string;
  tone?: 'default' | 'change' | 'decision';
  body: React.ReactNode;
}

export interface CanvasNarrativeDrawerProps {
  open: boolean;
  title: string;
  metaLine?: string;
  sections: CanvasNarrativeSection[];
  onClose: () => void;
  footer?: React.ReactNode;
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
