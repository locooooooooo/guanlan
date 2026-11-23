import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Badge 原语（对齐 coss.com/ui 8% 语义浅底 + 深前景色 AA 配方）。
 */
export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-[var(--dur-1)] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-5 min-w-5 px-1.5 text-[11px]',
        lg: 'h-6 min-w-6 px-2 text-xs',
        sm: 'h-4 min-w-4 rounded-[4px] px-1 text-[10px]',
      },
      variant: {
        brand: 'bg-brand/10 text-brand dark:bg-brand/18',
        default: 'bg-primary text-primary-foreground [button&,a&]:hover:bg-primary/90',
        destructive: 'bg-destructive text-white [button&,a&]:hover:bg-destructive/90',
        error: 'bg-destructive/10 text-destructive-foreground dark:bg-destructive/18',
        info: 'bg-info/10 text-info-foreground dark:bg-info/18',
        outline:
          'border-input bg-background text-foreground dark:bg-input/32 [button&,a&]:hover:bg-accent/60',
        secondary: 'bg-secondary text-secondary-foreground [button&,a&]:hover:bg-secondary/85',
        success: 'bg-success/10 text-success-foreground dark:bg-success/18',
        warning: 'bg-warning/10 text-warning-foreground dark:bg-warning/18',
      },
    },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;
export type BadgeSize = NonNullable<VariantProps<typeof badgeVariants>['size']>;

export interface BadgeProps extends useRender.ComponentProps<'span'> {
  variant?: BadgeVariant;
  size?: BadgeSize;
}

export function Badge({
  className,
  variant,
  size,
  render,
  ...props
}: BadgeProps): React.ReactElement {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    'data-slot': 'badge',
  };

  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(defaultProps, props),
    render,
  });
}
