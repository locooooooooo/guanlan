import { Dialog as CommandDialogPrimitive } from '@base-ui/react/dialog';
import { SearchIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Command 双层凹槽命令面板原语（对齐 coss.com/ui CommandPanel 结构）。
 * 外壳（bg-muted/72）承载搜索输入与快捷键底栏，内层亮板（CommandPanel）承载结果列表与预览。
 */
export const CommandDialog = CommandDialogPrimitive.Root;
export const CommandDialogPortal = CommandDialogPrimitive.Portal;
export const CommandCreateHandle = CommandDialogPrimitive.createHandle;

export function CommandDialogTrigger(
  props: CommandDialogPrimitive.Trigger.Props,
): React.ReactElement {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

export function CommandDialogBackdrop({
  className,
  ...props
}: CommandDialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(
        'fixed inset-0 z-50 bg-black/32 backdrop-blur-xs transition-opacity duration-200 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

export function CommandDialogViewport({
  className,
  ...props
}: CommandDialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        'fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(1rem,6vh)] sm:py-[10vh]',
        className,
      )}
      data-slot="command-dialog-viewport"
      {...props}
    />
  );
}

export function CommandDialogPopup({
  className,
  children,
  portalProps,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  portalProps?: CommandDialogPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <CommandDialogPortal {...portalProps}>
      <CommandDialogBackdrop />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          className={cn(
            'relative flex max-h-[min(78vh,620px)] min-h-0 w-full min-w-0 max-w-3xl -translate-y-[calc(1.25rem*var(--nested-dialogs))] scale-[calc(1-0.08*var(--nested-dialogs))] flex-col rounded-2xl border border-border bg-popover not-dark:bg-clip-padding text-popover-foreground opacity-[calc(1-0.12*var(--nested-dialogs))] shadow-xl outline-none transition-[scale,opacity,translate] duration-200 ease-out motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:bg-muted/72 before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

export function CommandInput({
  className,
  inputRef,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  inputRef?: React.Ref<HTMLInputElement>;
}): React.ReactElement {
  return (
    <div
      className="relative flex items-center gap-2.5 px-4 py-2.5"
      data-slot="command-input-wrap"
    >
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        className={cn(
          'w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground/80 outline-none',
          className,
        )}
        data-slot="command-input"
        {...props}
      />
    </div>
  );
}

export function CommandPanel({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'relative -mx-px min-h-0 flex-1 overflow-hidden rounded-t-xl border border-b-0 border-border bg-card not-dark:bg-clip-padding shadow-xs not-has-[+[data-slot=command-footer]]:-mb-px not-has-[+[data-slot=command-footer]]:rounded-b-2xl not-has-[+[data-slot=command-footer]]:border-b',
        className,
      )}
      data-slot="command-panel"
      {...props}
    />
  );
}

export function CommandFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn(
        'relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t border-border px-4 py-2.5 text-muted-foreground text-xs',
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

export function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<'kbd'>): React.ReactElement {
  return (
    <kbd
      className={cn(
        'ms-auto font-mono text-[11px] font-medium text-muted-foreground/80 tracking-wide',
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

export { CommandDialogPrimitive };
