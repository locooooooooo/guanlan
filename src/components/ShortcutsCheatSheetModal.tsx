
import React from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, Sparkles, X } from 'lucide-react';
import type { WorkspaceConfig } from '../types/guanlan';
import type { PrimaryTab } from './TopHeader';
import { APP_BUILD_INFO } from '../utils/appBuildInfo';
import { SHORTCUT_CHEATSHEET_GROUPS } from '../utils/keyboardShortcuts';
import { formatRelativeObservedAt } from '../utils/timeFormat';
import { IconButton } from './ui/primitives';
import {
  Badge,
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
  Kbd,
  KbdGroup,
  ScrollArea,
} from './ui';

export interface ShortcutsCheatSheetModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: PrimaryTab;
  config: WorkspaceConfig;
  lastScanAt?: string | null;
}

function renderKeySpec(keys: string): React.ReactElement {
  if (/^G [A-Z]$/.test(keys)) {
    const [first, second] = keys.split(' ');
    return (
      <KbdGroup className="shrink-0" aria-label={keys}>
        <Kbd>{first}</Kbd>
        <span className="text-[10px] text-muted-foreground">→</span>
        <Kbd>{second}</Kbd>
      </KbdGroup>
    );
  }
  return <Kbd className="shrink-0">{keys}</Kbd>;
}

export const ShortcutsCheatSheetModal: React.FC<ShortcutsCheatSheetModalProps> = ({
  isOpen,
  onClose,
  activeTab,
  config,
  lastScanAt,
}) => {
  if (!isOpen) return null;

  const activeTabLabel =
    activeTab === 'home'
      ? '今日观澜'
      : activeTab === 'panorama'
        ? '全景溯源'
        : '知识资产库';

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="全站快捷键速查"
      data-esc-layer="open"
      data-shortcuts-dialog="open"
      data-testid="shortcut-cheatsheet-popover"
      className="glx-backdrop-in fixed inset-0 z-[70] flex items-center justify-center bg-[color:var(--ink-anchor)]/38 dark:bg-black/62 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-dialog-nested-stack=""
        style={{ '--nested-dialogs': 0 } as React.CSSProperties}
        className="glass-pop glx-modal-in flex max-h-[min(86vh,720px)] w-full max-w-[820px] flex-col overflow-hidden rounded-2xl border border-border/85 text-foreground shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/85 px-6 py-4 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] text-[color:var(--accent-iris-deep)]">
              <Keyboard className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] text-foreground">
                  全站快捷键速查
                </h2>
                <Badge variant="outline" size="sm" className="shrink-0 font-normal">
                  当前 · {activeTabLabel}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                输入态自动让路 · 任意位置按 <span className="font-mono">?</span> 随时呼出或关闭
              </p>
            </div>
          </div>

          <IconButton label="关闭快捷键速查" onClick={onClose} className="cursor-pointer">
            <X />
          </IconButton>
        </header>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted/45 px-6 py-2 text-[11.5px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-3 tabular-nums">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-3 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
              <span className="whitespace-nowrap">版本</span>
              <strong className="font-mono font-medium text-foreground">
                观澜 {APP_BUILD_INFO.versionTag}
              </strong>
            </span>
            {config.enumSnapshot.totalCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="whitespace-nowrap">快照</span>
                <span className="font-mono text-foreground">
                  Guanlan · {config.enumSnapshot.date} · 索引第{' '}
                  {config.runtimeStatus.indexGeneration} 代
                </span>
              </span>
            )}
          </div>
          <div className="inline-flex items-center gap-1.5 tabular-nums">
            <span className="whitespace-nowrap">最后扫描</span>
            <span className="font-mono text-foreground">
              {lastScanAt ? formatRelativeObservedAt(lastScanAt) : '从未扫描'}
            </span>
          </div>
        </div>

        <ScrollArea scrollFade className="min-h-0 flex-1">
          <div className="grid grid-cols-1 gap-3.5 p-5 md:grid-cols-2">
            {SHORTCUT_CHEATSHEET_GROUPS.map((group) => (
              <Frame key={group.id} data-shortcut-group={group.id}>
                <FrameHeader className="px-3.5 py-2">
                  <FrameTitle className="text-[12px] font-semibold tracking-wide text-foreground">
                    {group.title}
                  </FrameTitle>
                </FrameHeader>
                <FramePanel className="divide-y divide-border/60 p-0">
                  {group.items.map((item) => (
                    <div
                      key={item.keys}
                      data-shortcut-item={item.keys}
                      className="flex items-center justify-between gap-3 px-3.5 py-2 text-[12px]"
                    >
                      <span className="min-w-0 leading-snug text-muted-foreground">
                        {item.desc}
                      </span>
                      {renderKeySpec(item.keys)}
                    </div>
                  ))}
                </FramePanel>
              </Frame>
            ))}
          </div>
        </ScrollArea>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/80 bg-muted/50 px-6 py-3 text-[11px] text-muted-foreground">
          <p className="leading-relaxed">
            编辑输入框 / 表单时全部快捷键自动让路（Ctrl+Z 归原生文本撤销）；已遵循系统「减少动态效果」静态降级。
          </p>
          <div className="inline-flex items-center gap-1.5 shrink-0">
            <Kbd>Esc</Kbd>
            <span>或</span>
            <Kbd>?</Kbd>
            <span>关闭</span>
          </div>
        </footer>
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(dialog, document.body);
  }
  return dialog;
};

export default ShortcutsCheatSheetModal;
