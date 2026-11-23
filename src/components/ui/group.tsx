import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';
import { Separator } from './separator';

/**
 * 观澜 · Group 无缝拼接控件组（对齐 coss.com/ui Group / ButtonGroup）。
 * 用于顶栏工具簇、日历视图切档、阅读器工具组等紧凑拼接场景，自动收口相邻圆角与边框。
 */
export const groupVariants = cva(
  'flex w-fit *:focus-visible:z-1 has-[>[data-slot=group]]:gap-2 *:has-focus-visible:z-1',
  {
    defaultVariants: {
      orientation: 'horizontal',
    },
    variants: {
      orientation: {
        horizontal:
          '*:data-slot:has-[~[data-slot]]:rounded-e-none *:data-slot:has-[~[data-slot]]:border-e-0 *:data-slot:not-data-[slot=separator]:has-[~[data-slot]]:before:-end-[0.5px] *:data-slot:has-[~[data-slot]]:before:rounded-e-none *:[[data-slot]~[data-slot]:not([data-slot=separator])]:before:-start-[0.5px] *:[[data-slot]~[data-slot]]:rounded-s-none *:[[data-slot]~[data-slot]]:border-s-0 *:[[data-slot]~[data-slot]]:before:rounded-s-none',
        vertical:
          'flex-col *:data-slot:has-[~[data-slot]]:rounded-b-none *:data-slot:has-[~[data-slot]]:border-b-0 *:data-slot:not-data-[slot=separator]:has-[~[data-slot]]:before:hidden *:data-slot:has-[~[data-slot]]:before:rounded-b-none *:[[data-slot]~[data-slot]]:rounded-t-none *:[[data-slot]~[data-slot]]:border-t-0 *:[[data-slot]~[data-slot]]:before:rounded-t-none',
      },
    },
  },
);

export function Group({
  className,
  orientation = 'horizontal',
  children,
  ...props
}: {
  className?: string;
  orientation?: VariantProps<typeof groupVariants>['orientation'];
  children: React.ReactNode;
} & React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(groupVariants({ orientation }), className)}
      data-orientation={orientation}
      data-slot="group"
      role="group"
      {...props}
    >
      {children}
    </div>
  );
}

export function GroupText({
  className,
  render,
  ...props
}: useRender.ComponentProps<'div'>): React.ReactElement {
  const defaultProps = {
    className: cn(
      "relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-muted not-dark:bg-clip-padding px-2.5 text-xs text-muted-foreground shadow-xs outline-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] dark:bg-input/50 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)] [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
      className,
    ),
    'data-slot': 'group-text',
  };

  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });
}

export function GroupSeparator({
  className,
  orientation = 'vertical',
  ...props
}: {
  className?: string;
} & React.ComponentProps<typeof Separator>): React.ReactElement {
  return (
    <Separator
      className={cn('pointer-events-none relative z-2 bg-input', className)}
      orientation={orientation}
      {...props}
    />
  );
}

export {
  Group as ButtonGroup,
  GroupText as ButtonGroupText,
  GroupSeparator as ButtonGroupSeparator,
};
