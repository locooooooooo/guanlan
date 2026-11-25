import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './spinner';

/**
 * 观澜 · coss.com/ui 风格 Button 原语。
 *
 * 工艺特点：
 * - 基于 @base-ui/react/use-render 支持 render 多态组合（无需 asChild 嵌套 Hack）；
 * - 1px 光学折边：not-dark:bg-clip-padding + before:shadow（亮底微压影 / 暗顶金属高光）；
 * - 主钮带 1px 顶沿高光（inset-shadow），按下自动反转为内压微影；
 * - 内置 loading 态（文字透明保宽 + 居中 Spinner），零布局抖动；
 * - motion-reduce 下关闭一切过渡。
 */
export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border font-medium text-sm outline-none transition-[background-color,border-color,color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease-fade)] motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55 data-loading:select-none data-loading:text-transparent [&_svg:not([class*='opacity-'])]:opacity-85 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-8 px-[calc(--spacing(3)-1px)] text-[13px]',
        icon: 'size-8',
        'icon-lg': 'size-9',
        'icon-sm': 'size-7',
        'icon-xs':
          "size-6 rounded-md before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 px-[calc(--spacing(3.5)-1px)] text-sm',
        sm: "h-7 gap-1.5 px-[calc(--spacing(2.5)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3.5",
        xl: 'h-10 px-[calc(--spacing(4)-1px)] text-[15px]',
        xs: "h-6 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        brand:
          'not-disabled:inset-shadow-[0_1px_rgba(255,255,255,0.22)] border-brand bg-brand text-brand-foreground shadow-xs hover:opacity-92 data-pressed:opacity-90 *:data-[slot=button-loading-indicator]:text-brand-foreground [:active,[data-pressed]]:inset-shadow-[0_1px_rgba(0,0,0,0.12)] [:disabled,:active,[data-pressed]]:shadow-none',
        default:
          'not-disabled:inset-shadow-[0_1px_rgba(255,255,255,0.16)] border-primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 data-pressed:bg-primary/90 *:data-[slot=button-loading-indicator]:text-primary-foreground [:active,[data-pressed]]:inset-shadow-[0_1px_rgba(0,0,0,0.10)] [:disabled,:active,[data-pressed]]:shadow-none',
        destructive:
          'not-disabled:inset-shadow-[0_1px_rgba(255,255,255,0.16)] border-destructive bg-destructive text-white shadow-xs hover:bg-destructive/90 data-pressed:bg-destructive/90 *:data-[slot=button-loading-indicator]:text-white [:active,[data-pressed]]:inset-shadow-[0_1px_rgba(0,0,0,0.10)] [:disabled,:active,[data-pressed]]:shadow-none',
        'destructive-outline':
          'border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_rgba(0,0,0,0.04)] hover:border-destructive/35 hover:bg-destructive/6 data-pressed:border-destructive/35 data-pressed:bg-destructive/6 *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/35 dark:not-disabled:before:shadow-[0_-1px_rgba(255,255,255,0.06)] [:disabled,:active,[data-pressed]]:shadow-none',
        ghost:
          'border-transparent bg-transparent text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground',
        link: 'border-transparent bg-transparent text-foreground underline-offset-4 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground',
        outline:
          'border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_rgba(0,0,0,0.04)] hover:bg-accent/60 data-pressed:bg-accent/60 *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/35 dark:hover:bg-input/60 dark:data-pressed:bg-input/60 dark:not-disabled:before:shadow-[0_-1px_rgba(255,255,255,0.06)] [:disabled,:active,[data-pressed]]:shadow-none',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/85 data-pressed:bg-secondary/85 *:data-[slot=button-loading-indicator]:text-secondary-foreground',
      },
    },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export interface ButtonProps extends useRender.ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  disabled: disabledProp,
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled = Boolean(loading || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>['type'] =
    render ? undefined : 'button';

  const defaultProps = {
    'aria-disabled': loading || undefined,
    children: (
      <>
        {children}
        {loading && (
          <Spinner
            className="pointer-events-none absolute size-3.5"
            data-slot="button-loading-indicator"
          />
        )}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    'data-loading': loading ? '' : undefined,
    'data-slot': 'button',
    disabled: isDisabled,
    type: typeValue,
  };

  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(defaultProps, props),
    render,
  });
}
