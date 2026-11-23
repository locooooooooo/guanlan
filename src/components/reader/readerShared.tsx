/**
 * D01-a 拆解 · 阅读器共享类型与轻组件。
 *
 * ReaderSubMode / ReturnBreadcrumb 类型 + CopyIdButton（契约⑧③长 ID 行内复制钮）。
 * 独立成文件避免「ReaderView ↔ 分节渲染层」循环 import（分节层与 ReaderView 都消费）。
 */

import React, { useState } from 'react';
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
 * 契约⑧③：长 ID（file_id / revision_id / decision_id）行内展示统一按钮。
 * 📋 小图标（w-4 h-4），title=完整 ID，点击写剪贴板并 ✓ 反馈 800ms。
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
      className={`inline-flex items-center justify-center w-4 h-4 rounded text-[length:var(--text-micro)] leading-none opacity-60 hover:opacity-100 transition-opacity shrink-0 ${
        className || ''
      }`}
    >
      {copied ? '✓' : '📋'}
    </button>
  );
};
