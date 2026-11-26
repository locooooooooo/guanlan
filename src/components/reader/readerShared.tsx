
import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyTextWithDesktopFallback } from '../../services/desktopBridge';

export type ReaderSubMode = 'read' | 'diff_since_read' | 'diff_versions' | 'relations';

export interface ReturnBreadcrumb {
  fromType: 'timeline' | 'markdown_paragraph';
  label: string;
  fileId?: string;
  revisionId?: string;
  sectionId?: string;
}

/**
 * 长 ID（file_id / revision_id / decision_id）行内展示统一复制按钮。
 * 悬停 title 显示完整 ID，点击写入剪贴板并展示勾选反馈 800ms。
 */
export const CopyIdButton: React.FC<{ id: string; className?: string }> = ({
  id,
  className,
}) => {
  const [copied, setCopied] = useState<boolean>(false);
  return (
    <button
      type="button"
      title={id}
      aria-label={`复制 ID ${id}`}
      onClick={(event) => {
        event.stopPropagation();
        void copyTextWithDesktopFallback(id).then((res) => {
          if (!res.ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 800);
        });
      }}
      className={`inline-flex items-center justify-center w-5 h-5 rounded-[var(--r-ctl)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:bg-accent transition-colors shrink-0 cursor-pointer ${
        className || ''
      }`}
    >
      {copied ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
    </button>
  );
};
