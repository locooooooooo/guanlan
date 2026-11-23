import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Tooltip 轻提示原语（基于 @base-ui/react/tooltip）。
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props): React.ReactElement {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipPopup({
  className,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  children,
  portalProps,
  ...props
}: TooltipPrimitive.Popup.Props & {
  side?: TooltipPrimitive.Positioner.Props['side'];
  align?: TooltipPrimitive.Positioner.Props['align'];
  sideOffset?: TooltipPrimitive.Positioner.Props['sideOffset'];
  portalProps?: TooltipPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <TooltipPrimitive.Portal {...portalProps}>
      <TooltipPrimitive.Positioner
        align={align}
        className="z-60"
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            'relative flex w-fit origin-(--transform-origin) text-balance rounded-md border border-border bg-popover not-dark:bg-clip-padding px-2 py-1 text-popover-foreground text-xs shadow-md transition-[scale,opacity] duration-120 motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipPrimitive, TooltipPopup as TooltipContent };
