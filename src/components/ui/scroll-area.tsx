import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · ScrollArea 原语（基于 @base-ui/react/scroll-area，对齐 coss.com/ui）。
 * 支持 scrollFade 边缘渐隐遮罩与自动隐身细滚动条，彻底取代生硬系统滚动条。
 */
export function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  children,
  scrollFade = false,
  scrollbarGutter = false,
  fill = false,
  clampContentMinWidth = true,
  overscrollContain = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  scrollFade?: boolean;
  scrollbarGutter?: boolean;
  fill?: boolean;
  clampContentMinWidth?: boolean;
  overscrollContain?: boolean;
}): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Root
      className={cn('relative size-full min-h-0 overflow-hidden', className)}
      data-slot="scroll-area"
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className={cn(
          'h-full rounded-[inherit] outline-none transition-shadow motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          overscrollContain &&
            'data-has-overflow-y:overscroll-y-contain data-has-overflow-x:overscroll-x-contain',
          scrollFade &&
            'mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.25rem]',
          scrollbarGutter && 'data-has-overflow-y:pe-2.5 data-has-overflow-x:pb-2.5',
          viewportClassName,
        )}
        data-slot="scroll-area-viewport"
      >
        <ScrollAreaPrimitive.Content
          className={cn(fill && 'size-full')}
          data-slot="scroll-area-content"
          style={clampContentMinWidth ? { minWidth: 0 } : undefined}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props): React.ReactElement {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        'm-1 flex opacity-0 transition-opacity delay-300 motion-reduce:transition-none data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:opacity-35 hover:opacity-100 data-hovering:opacity-100 data-scrolling:opacity-100 hover:delay-0 data-hovering:delay-0 data-scrolling:delay-0 hover:duration-100 data-hovering:duration-100 data-scrolling:duration-100',
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-foreground/26 hover:bg-foreground/42"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollAreaPrimitive };
