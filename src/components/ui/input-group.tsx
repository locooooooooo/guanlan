import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';
import { Input, type InputProps } from './input';

/**
 * 观澜 · InputGroup 复合输入框原语（对齐 coss.com/ui，用于左栏快筛、日历搜索与命令栏）。
 */
export function InputGroup({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'relative inline-flex w-full items-center rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm text-foreground shadow-xs ring-ring/30 transition-shadow motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:before:shadow-[0_1px_rgba(0,0,0,0.04)] has-focus-visible:border-ring has-focus-visible:ring-2 has-disabled:opacity-60 dark:bg-input/32 dark:not-has-disabled:not-has-focus-visible:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
        className,
      )}
      data-slot="input-group"
      role="group"
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex shrink-0 select-none items-center justify-center gap-1.5 text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none",
  {
    defaultVariants: {
      align: 'inline-start',
    },
    variants: {
      align: {
        'inline-end': 'pe-2.5',
        'inline-start': 'ps-2.5',
      },
    },
  },
);

export function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>): React.ReactElement {
  return (
    <div
      className={cn(inputGroupAddonVariants({ align }), className)}
      data-align={align}
      data-slot="input-group-addon"
      {...props}
    />
  );
}

export function InputGroupInput({
  className,
  ...props
}: InputProps): React.ReactElement {
  return <Input className={cn('flex-1', className)} unstyled {...props} />;
}
