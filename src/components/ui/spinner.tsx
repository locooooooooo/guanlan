import { Loader2Icon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · Spinner 原语（对齐 coss.com/ui）。
 * 按钮内加载态与轻量功能流旋转提示使用；prefers-reduced-motion 下停帧保持图标可见。
 */
export function Spinner({
  className,
  ...props
}: React.ComponentProps<typeof Loader2Icon>): React.ReactElement {
  return (
    <Loader2Icon
      aria-label="加载中"
      className={cn('animate-spin motion-reduce:animate-none', className)}
      data-slot="spinner"
      role="status"
      {...props}
    />
  );
}
