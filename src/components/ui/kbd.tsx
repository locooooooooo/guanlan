import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Kbd 按键徽章原语（对齐 coss.com/ui）。
 * 统一全站快捷键提示（⌘K / Space / Z / Esc / 速查表）。
 */
export function Kbd({
  className,
  ...props
}: React.ComponentProps<'kbd'>): React.ReactElement {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded border border-border bg-muted px-1 font-mono font-medium text-[11px] leading-none text-muted-foreground [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

export function KbdGroup({
  className,
  ...props
}: React.ComponentProps<'kbd'>): React.ReactElement {
  return (
    <kbd
      className={cn('inline-flex items-center gap-1', className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}
