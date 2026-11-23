import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { CheckIcon, ChevronRightIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Menu 下拉/操作菜单原语（基于 @base-ui/react/menu，对齐 coss.com/ui）。
 */
export const Menu = MenuPrimitive.Root;
export const MenuPortal = MenuPrimitive.Portal;
export const MenuGroup = MenuPrimitive.Group;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;
export const MenuSub = MenuPrimitive.SubmenuRoot;

export function MenuTrigger(props: MenuPrimitive.Trigger.Props): React.ReactElement {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

export function MenuPopup({
  className,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  collisionPadding = 10,
  portalProps,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props['side'];
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  collisionPadding?: MenuPrimitive.Positioner.Props['collisionPadding'];
  portalProps?: MenuPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <MenuPortal {...portalProps}>
      <MenuPrimitive.Positioner
        align={align}
        className="z-50"
        collisionPadding={collisionPadding}
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            'relative min-w-44 origin-(--transform-origin) rounded-xl border border-border bg-popover not-dark:bg-clip-padding p-1 text-popover-foreground shadow-lg outline-none transition-[scale,opacity] duration-140 motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
            className,
          )}
          data-slot="menu-popup"
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPortal>
  );
}

export function MenuItem({
  className,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & {
  variant?: 'default' | 'destructive';
}): React.ReactElement {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs outline-none transition-colors duration-[var(--dur-1)] motion-reduce:transition-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
        variant === 'destructive' &&
          'text-destructive-foreground data-highlighted:bg-destructive/10 data-highlighted:text-destructive-foreground',
        className,
      )}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

export function MenuCheckboxItem({
  className,
  children,
  ...props
}: MenuPrimitive.CheckboxItem.Props): React.ReactElement {
  return (
    <MenuPrimitive.CheckboxItem
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs outline-none transition-colors duration-[var(--dur-1)] motion-reduce:transition-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator className="flex size-3.5 items-center justify-center">
        <CheckIcon className="size-3.5" />
      </MenuPrimitive.CheckboxItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function MenuGroupLabel({
  className,
  ...props
}: MenuPrimitive.GroupLabel.Props): React.ReactElement {
  return (
    <MenuPrimitive.GroupLabel
      className={cn('px-2.5 py-1 text-[11px] font-medium text-muted-foreground', className)}
      data-slot="menu-group-label"
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props): React.ReactElement {
  return (
    <MenuPrimitive.Separator
      className={cn('my-1 h-px bg-border', className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

export function MenuSubTrigger({
  className,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props): React.ReactElement {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        className,
      )}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="ms-auto size-3.5 opacity-70" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

export { MenuPrimitive };
