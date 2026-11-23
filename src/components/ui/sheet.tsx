import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { XIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { ScrollArea } from './scroll-area';

/**
 * 观澜 · Sheet 悬浮/贴边抽屉原语（基于 @base-ui/react/dialog，对齐 coss.com/ui）。
 * 重点支持 variant="inset"（sm:p-4 + sm:rounded-2xl 悬浮圆角抽屉，优雅承接阅读与存档、
 * 批阅看板、文件历史与司辰手记抽屉）。
 */
export const Sheet = SheetPrimitive.Root;
export const SheetPortal = SheetPrimitive.Portal;

export function SheetTrigger(props: SheetPrimitive.Trigger.Props): React.ReactElement {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(props: SheetPrimitive.Close.Props): React.ReactElement {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

export function SheetBackdrop({
  className,
  ...props
}: SheetPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <SheetPrimitive.Backdrop
      className={cn(
        'fixed inset-0 z-50 bg-black/28 backdrop-blur-xs transition-opacity duration-200 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      data-slot="sheet-backdrop"
      {...props}
    />
  );
}

export function SheetViewport({
  className,
  side = 'right',
  variant = 'default',
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: 'right' | 'left' | 'top' | 'bottom';
  variant?: 'default' | 'inset';
}): React.ReactElement {
  return (
    <SheetPrimitive.Viewport
      className={cn(
        'fixed inset-0 z-50 grid',
        side === 'bottom' && 'grid-rows-[1fr_auto] pt-12',
        side === 'top' && 'grid-rows-[auto_1fr] pb-12',
        side === 'left' && 'flex justify-start',
        side === 'right' && 'flex justify-end',
        variant === 'inset' && 'sm:p-3.5',
        className,
      )}
      data-slot="sheet-viewport"
      {...props}
    />
  );
}

export function SheetPopup({
  className,
  children,
  showCloseButton = true,
  side = 'right',
  variant = 'default',
  closeProps,
  portalProps,
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  side?: 'right' | 'left' | 'top' | 'bottom';
  variant?: 'default' | 'inset';
  closeProps?: SheetPrimitive.Close.Props;
  portalProps?: SheetPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <SheetPortal {...portalProps}>
      <SheetBackdrop />
      <SheetViewport side={side} variant={variant}>
        <SheetPrimitive.Popup
          className={cn(
            'relative flex max-h-full min-h-0 w-full min-w-0 flex-col bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-xl outline-none transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            side === 'bottom' &&
              'row-start-2 border-t border-border data-ending-style:translate-y-8 data-starting-style:translate-y-8',
            side === 'top' &&
              'border-b border-border data-ending-style:-translate-y-8 data-starting-style:-translate-y-8',
            side === 'left' &&
              'w-[calc(100%-3rem)] max-w-md border-e border-border data-ending-style:-translate-x-8 data-starting-style:-translate-x-8',
            side === 'right' &&
              'col-start-2 w-[calc(100%-3rem)] max-w-md border-s border-border data-ending-style:translate-x-8 data-starting-style:translate-x-8',
            variant === 'inset' &&
              'sm:rounded-2xl sm:border sm:border-border sm:before:rounded-[calc(var(--radius-2xl)-1px)] sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]',
            className,
          )}
          data-slot="sheet-popup"
          data-variant={variant}
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitive.Close
              aria-label="关闭"
              className="absolute end-3 top-3"
              render={<Button size="icon-sm" variant="ghost" />}
              {...closeProps}
            >
              <XIcon />
            </SheetPrimitive.Close>
          )}
        </SheetPrimitive.Popup>
      </SheetViewport>
    </SheetPortal>
  );
}

export function SheetHeader({
  className,
  render,
  ...props
}: useRender.ComponentProps<'div'>): React.ReactElement {
  const defaultProps = {
    className: cn('flex flex-col gap-1 px-5 pt-4 pb-3 border-b border-border', className),
    'data-slot': 'sheet-header',
  };
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });
}

export function SheetFooter({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'div'> & {
  variant?: 'default' | 'bare';
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      'flex flex-col-reverse gap-2 px-5 sm:flex-row sm:justify-end',
      variant === 'default' && 'border-t border-border bg-muted/70 py-3.5',
      variant === 'bare' && 'pt-3 pb-5',
      className,
    ),
    'data-slot': 'sheet-footer',
  };
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });
}

export function SheetTitle({
  className,
  ...props
}: SheetPrimitive.Title.Props): React.ReactElement {
  return (
    <SheetPrimitive.Title
      className={cn('font-semibold text-base leading-snug text-foreground', className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props): React.ReactElement {
  return (
    <SheetPrimitive.Description
      className={cn('text-muted-foreground text-xs', className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export function SheetPanel({
  className,
  scrollFade = true,
  render,
  ...props
}: useRender.ComponentProps<'div'> & {
  scrollFade?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn('px-5 py-3.5', className),
    'data-slot': 'sheet-panel',
  };
  return (
    <ScrollArea overscrollContain scrollFade={scrollFade}>
      {useRender({
        defaultTagName: 'div',
        props: mergeProps<'div'>(defaultProps, props),
        render,
      })}
    </ScrollArea>
  );
}

export { SheetPrimitive, SheetBackdrop as SheetOverlay, SheetPopup as SheetContent };
