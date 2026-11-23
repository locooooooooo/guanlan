import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Empty 空态原语（对齐 coss.com/ui 标志性三卡微倾扇形叠影图标栈）。
 * 统一全站零搜索命中、空目录、零待拍板、空证据篮等无数据诚实空态。
 */
const emptyMediaVariants = cva(
  'flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: 'bg-transparent',
        icon: "relative flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card not-dark:bg-clip-padding text-foreground shadow-xs before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)] [&_svg:not([class*='size-'])]:size-4",
      },
    },
  },
);

export function Empty({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-5 text-balance px-6 py-10 text-center',
        className,
      )}
      data-slot="empty"
      {...props}
    />
  );
}

export function EmptyHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn('flex max-w-sm flex-col items-center text-center', className)}
      data-slot="empty-header"
      {...props}
    />
  );
}

export function EmptyMedia({
  className,
  variant = 'default',
  children,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof emptyMediaVariants>): React.ReactElement {
  return (
    <div
      className={cn('relative mb-3', className)}
      data-slot="empty-media"
      data-variant={variant}
      {...props}
    >
      {variant === 'icon' && (
        <>
          <div
            aria-hidden="true"
            className={cn(
              emptyMediaVariants({ variant }),
              'pointer-events-none absolute bottom-px origin-bottom-left -translate-x-0.5 -rotate-10 scale-84 opacity-70 shadow-none',
            )}
          />
          <div
            aria-hidden="true"
            className={cn(
              emptyMediaVariants({ variant }),
              'pointer-events-none absolute bottom-px origin-bottom-right translate-x-0.5 rotate-10 scale-84 opacity-70 shadow-none',
            )}
          />
        </>
      )}
      <div className={cn(emptyMediaVariants({ variant }))}>{children}</div>
    </div>
  );
}

export function EmptyTitle({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn('font-semibold text-base text-foreground', className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

export function EmptyDescription({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'text-muted-foreground text-xs leading-relaxed [[data-slot=empty-title]+&]:mt-1',
        className,
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

export function EmptyContent({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 max-w-sm flex-col items-center gap-3 text-balance text-xs',
        className,
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}
