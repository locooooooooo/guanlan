import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Popover 浮层原语（基于 @base-ui/react/popover，内置视口碰撞自动避让与原点缩放）。
 */
export const PopoverCreateHandle = PopoverPrimitive.createHandle;
export const Popover = PopoverPrimitive.Root;

export function PopoverTrigger({
  className,
  children,
  ...props
}: PopoverPrimitive.Trigger.Props): React.ReactElement {
  return (
    <PopoverPrimitive.Trigger
      className={className}
      data-slot="popover-trigger"
      {...props}
    >
      {children}
    </PopoverPrimitive.Trigger>
  );
}

export function PopoverPopup({
  children,
  className,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  alignOffset = 0,
  collisionPadding = 12,
  tooltipStyle = false,
  anchor,
  portalProps,
  ...props
}: PopoverPrimitive.Popup.Props & {
  portalProps?: PopoverPrimitive.Portal.Props;
  side?: PopoverPrimitive.Positioner.Props['side'];
  align?: PopoverPrimitive.Positioner.Props['align'];
  sideOffset?: PopoverPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: PopoverPrimitive.Positioner.Props['alignOffset'];
  collisionPadding?: PopoverPrimitive.Positioner.Props['collisionPadding'];
  tooltipStyle?: boolean;
  anchor?: PopoverPrimitive.Positioner.Props['anchor'];
}): React.ReactElement {
  return (
    <PopoverPrimitive.Portal {...portalProps}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-50 max-w-(--available-width)"
        collisionPadding={collisionPadding}
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            'relative flex origin-(--transform-origin) flex-col rounded-xl border border-border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg outline-none transition-[scale,opacity] duration-150 motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            tooltipStyle &&
              'w-fit text-balance rounded-md text-xs shadow-md before:rounded-[calc(var(--radius-md)-1px)]',
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          <PopoverPrimitive.Viewport
            className={cn(
              'relative size-full max-h-(--available-height) overflow-y-auto px-3.5 py-3',
              tooltipStyle && 'px-2 py-1',
            )}
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export function PopoverClose(props: PopoverPrimitive.Close.Props): React.ReactElement {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export function PopoverTitle({
  className,
  ...props
}: PopoverPrimitive.Title.Props): React.ReactElement {
  return (
    <PopoverPrimitive.Title
      className={cn('font-semibold text-sm leading-snug text-foreground', className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props): React.ReactElement {
  return (
    <PopoverPrimitive.Description
      className={cn('text-muted-foreground text-xs', className)}
      data-slot="popover-description"
      {...props}
    />
  );
}

export { PopoverPrimitive, PopoverPopup as PopoverContent };
