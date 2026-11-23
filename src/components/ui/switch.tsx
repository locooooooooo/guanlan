import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Switch 开关原语（基于 @base-ui/react/switch，对齐 coss.com/ui）。
 */
export function Switch({
  className,
  ...props
}: SwitchPrimitive.Root.Props): React.ReactElement {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'group/switch inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input p-0.5 shadow-xs outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-55',
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="pointer-events-none block size-4 rounded-full bg-background shadow-xs transition-transform duration-150 motion-reduce:transition-none data-checked:translate-x-4 data-unchecked:translate-x-0"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { SwitchPrimitive };
