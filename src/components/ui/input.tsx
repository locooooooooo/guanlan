import { Input as InputPrimitive } from '@base-ui/react/input';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Input 原语（基于 @base-ui/react/input，对齐 coss.com/ui 1px 光学折边）。
 */
export type InputProps = Omit<InputPrimitive.Props, 'size'> & {
  size?: 'sm' | 'default' | 'lg';
  unstyled?: boolean;
};

export function Input({
  className,
  size = 'default',
  unstyled = false,
  ...props
}: InputProps): React.ReactElement {
  return (
    <span
      className={
        cn(
          !unstyled &&
            'relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm text-foreground shadow-xs ring-ring/30 transition-shadow motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:before:shadow-[0_1px_rgba(0,0,0,0.04)] has-focus-visible:border-ring has-focus-visible:ring-2 has-disabled:opacity-60 dark:bg-input/32 dark:not-has-disabled:not-has-focus-visible:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      <InputPrimitive
        className={cn(
          'w-full min-w-0 rounded-[inherit] bg-transparent px-2.5 text-foreground placeholder:text-muted-foreground/85 focus-visible:outline-2 focus-visible:outline-[color:var(--ring)] focus-visible:outline-offset-[-1px]',
          size === 'sm' && 'h-7 px-2 text-xs',
          size === 'default' && 'h-8 text-[13px]',
          size === 'lg' && 'h-9 px-3 text-sm',
        )}
        data-slot="input"
        {...props}
      />
    </span>
  );
}

export { InputPrimitive };
