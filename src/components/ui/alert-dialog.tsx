import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · AlertDialog 不可逆/高影响二次确认原语（基于 @base-ui/react/alert-dialog）。
 * 用于批量确立已读基线、移入回收站等人工二次确认红线动作。
 */
export const AlertDialogCreateHandle = AlertDialogPrimitive.createHandle;
export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;

export function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props): React.ReactElement {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

export function AlertDialogBackdrop({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Backdrop
      className={cn(
        'fixed inset-0 z-50 bg-black/36 backdrop-blur-xs transition-opacity duration-200 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      data-slot="alert-dialog-backdrop"
      {...props}
    />
  );
}

export function AlertDialogViewport({
  className,
  ...props
}: AlertDialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Viewport
      className={cn(
        'fixed inset-0 z-50 grid grid-rows-[1fr_auto_2fr] justify-items-center p-4',
        className,
      )}
      data-slot="alert-dialog-viewport"
      {...props}
    />
  );
}

export function AlertDialogPopup({
  className,
  portalProps,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  portalProps?: AlertDialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <AlertDialogPortal {...portalProps}>
      <AlertDialogBackdrop />
      <AlertDialogViewport>
        <AlertDialogPrimitive.Popup
          className={cn(
            'relative row-start-2 flex max-h-[85vh] min-h-0 w-full min-w-0 max-w-md flex-col rounded-2xl border border-border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-xl outline-none transition-[scale,opacity] duration-180 ease-out motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            className,
          )}
          data-slot="alert-dialog-popup"
          {...props}
        />
      </AlertDialogViewport>
    </AlertDialogPortal>
  );
}

export function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn('flex flex-col gap-2 px-6 pt-5 pb-4', className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

export function AlertDialogFooter({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & {
  variant?: 'default' | 'bare';
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end',
        variant === 'default' &&
          'rounded-b-[calc(var(--radius-2xl)-1px)] border-t border-border bg-muted/70 py-3.5',
        variant === 'bare' && 'pb-5',
        className,
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Title
      className={cn('font-semibold text-base text-foreground', className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Description
      className={cn('text-muted-foreground text-xs leading-relaxed', className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

export function AlertDialogClose(props: AlertDialogPrimitive.Close.Props): React.ReactElement {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

export {
  AlertDialogPrimitive,
  AlertDialogBackdrop as AlertDialogOverlay,
  AlertDialogPopup as AlertDialogContent,
};
