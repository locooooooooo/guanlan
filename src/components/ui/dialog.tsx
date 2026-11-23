import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { XIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { ScrollArea } from './scroll-area';

/**
 * 观澜 · Dialog 模态弹窗原语（基于 @base-ui/react/dialog，对齐 coss.com/ui）。
 * 内置 --nested-dialogs 嵌套景深退让与 ScrollArea 边缘渐隐内容区。
 */
export const DialogCreateHandle = DialogPrimitive.createHandle;
export const Dialog = DialogPrimitive.Root;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogTrigger(props: DialogPrimitive.Trigger.Props): React.ReactElement {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogClose(props: DialogPrimitive.Close.Props): React.ReactElement {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export function DialogBackdrop({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        'fixed inset-0 z-50 bg-black/32 backdrop-blur-xs transition-opacity duration-200 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

export function DialogViewport({
  className,
  ...props
}: DialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        'fixed inset-0 z-50 grid grid-rows-[1fr_auto_2fr] justify-items-center p-4',
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

export function DialogPopup({
  className,
  children,
  showCloseButton = true,
  closeProps,
  portalProps,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  closeProps?: DialogPrimitive.Close.Props;
  portalProps?: DialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <DialogPortal {...portalProps}>
      <DialogBackdrop />
      <DialogViewport>
        <DialogPrimitive.Popup
          className={cn(
            'relative row-start-2 flex max-h-[86vh] min-h-0 w-full min-w-0 max-w-lg -translate-y-[calc(1.25rem*var(--nested-dialogs))] scale-[calc(1-0.08*var(--nested-dialogs))] flex-col rounded-2xl border border-border bg-popover not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-0.12*var(--nested-dialogs))] shadow-xl outline-none transition-[scale,opacity,translate] duration-200 ease-out motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] data-nested-dialog-open:origin-top data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            className,
          )}
          data-slot="dialog-popup"
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label="关闭"
              className="absolute end-3 top-3"
              render={<Button size="icon-sm" variant="ghost" />}
              {...closeProps}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

export function DialogHeader({
  className,
  render,
  ...props
}: useRender.ComponentProps<'div'>): React.ReactElement {
  const defaultProps = {
    className: cn('flex flex-col gap-1.5 px-6 pt-5 pb-3', className),
    'data-slot': 'dialog-header',
  };
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });
}

export function DialogFooter({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'div'> & {
  variant?: 'default' | 'bare';
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      'flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end',
      variant === 'default' && 'rounded-b-[calc(var(--radius-2xl)-1px)] border-t border-border bg-muted/70 py-3.5',
      variant === 'bare' && 'pt-3 pb-5',
      className,
    ),
    'data-slot': 'dialog-footer',
  };
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(defaultProps, props),
    render,
  });
}

export function DialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props): React.ReactElement {
  return (
    <DialogPrimitive.Title
      className={cn('font-semibold text-base leading-snug text-foreground', className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props): React.ReactElement {
  return (
    <DialogPrimitive.Description
      className={cn('text-muted-foreground text-xs leading-relaxed', className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export function DialogPanel({
  className,
  scrollFade = true,
  render,
  ...props
}: useRender.ComponentProps<'div'> & {
  scrollFade?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn('px-6 py-3', className),
    'data-slot': 'dialog-panel',
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

export { DialogPrimitive, DialogBackdrop as DialogOverlay, DialogPopup as DialogContent };
