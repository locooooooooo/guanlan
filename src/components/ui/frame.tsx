import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Frame 双层托盘容器（coss.com/ui 标志性表面结构）。
 * 外层凹槽（bg-muted/72 + p-1）承托内层亮面卡板（FramePanel），
 * 适用于首页工作台、日历分组、设置区块与批阅泳道。
 */
export function Frame({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl bg-muted/75 p-1',
        '*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-1',
        className,
      )}
      data-slot="frame"
      {...props}
    />
  );
}

export function FramePanel({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'relative rounded-xl border border-border bg-card not-dark:bg-clip-padding p-4 text-card-foreground shadow-xs before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
        className,
      )}
      data-slot="frame-panel"
      {...props}
    />
  );
}

export function FrameHeader({
  className,
  ...props
}: React.ComponentProps<'header'>): React.ReactElement {
  return (
    <header
      className={cn('flex flex-col gap-0.5 px-4 py-3', className)}
      data-slot="frame-panel-header"
      {...props}
    />
  );
}

export function FrameTitle({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn('font-semibold text-sm text-foreground', className)}
      data-slot="frame-panel-title"
      {...props}
    />
  );
}

export function FrameDescription({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn('text-muted-foreground text-xs', className)}
      data-slot="frame-panel-description"
      {...props}
    />
  );
}

export function FrameFooter({
  className,
  ...props
}: React.ComponentProps<'footer'>): React.ReactElement {
  return (
    <footer
      className={cn('px-4 py-3', className)}
      data-slot="frame-panel-footer"
      {...props}
    />
  );
}
