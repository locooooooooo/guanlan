import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · PreviewCard 悬停速览卡（基于 @base-ui/react/preview-card）。
 * 用于左栏文件行、引用锚点与星图节点 250ms 悬停轻预览（免盲跳）。
 */
export const PreviewCard = PreviewCardPrimitive.Root;
export const PreviewCardCreateHandle = PreviewCardPrimitive.createHandle;

export function PreviewCardTrigger<Payload = unknown>({
  delay = 250,
  closeDelay = 120,
  ...props
}: PreviewCardPrimitive.Trigger.Props<Payload>): React.ReactElement {
  return (
    <PreviewCardPrimitive.Trigger
      closeDelay={closeDelay}
      data-slot="preview-card-trigger"
      delay={delay}
      {...props}
    />
  );
}

export function PreviewCardPopup({
  className,
  children,
  side = 'right',
  align = 'center',
  sideOffset = 8,
  collisionPadding = 12,
  anchor,
  portalProps,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  side?: PreviewCardPrimitive.Positioner.Props['side'];
  align?: PreviewCardPrimitive.Positioner.Props['align'];
  sideOffset?: PreviewCardPrimitive.Positioner.Props['sideOffset'];
  collisionPadding?: PreviewCardPrimitive.Positioner.Props['collisionPadding'];
  anchor?: PreviewCardPrimitive.Positioner.Props['anchor'];
  portalProps?: PreviewCardPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <PreviewCardPrimitive.Portal {...portalProps}>
      <PreviewCardPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="z-50"
        collisionPadding={collisionPadding}
        data-slot="preview-card-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          className={cn(
            'relative flex w-72 origin-(--transform-origin) flex-col gap-2 text-balance rounded-xl border border-border bg-popover not-dark:bg-clip-padding p-3.5 text-popover-foreground text-xs shadow-lg transition-[scale,opacity] duration-150 motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            className,
          )}
          data-slot="preview-card-content"
          {...props}
        >
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export {
  PreviewCardPrimitive,
  PreviewCard as HoverCard,
  PreviewCardTrigger as HoverCardTrigger,
  PreviewCardPopup as HoverCardContent,
};
