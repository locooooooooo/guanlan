import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * 观澜 · 统一 Skeleton 原语（V01）。
 * 底层扫光动画复用 motion.css §3.29 的 .glx-skeleton（纯 transform 扫光，零 background-position 重绘，
 * prefers-reduced-motion 下流光层隐藏、静态骨架终态恒可见），并同口重导出既有 GlassSkeleton 与司辰空态。
 */
export function Skeleton({
  className,
  ...props
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'glx-skeleton rounded-md bg-[color:color-mix(in_srgb,var(--foreground)_8%,transparent)]',
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export {
  ChronosEmptyState,
  type ChronosEmptyStateProps,
  ChronosLineArt,
  GlassSkeleton,
  type GlassSkeletonProps,
  skeletonLineWidths,
} from './GlassSkeleton';
