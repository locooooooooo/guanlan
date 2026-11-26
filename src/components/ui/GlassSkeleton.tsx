import React from 'react';


/** 骨架行宽纯函数：首行满宽，逐行按固定步长收窄（尾行不低于 56%），
 *  行数钳到 ≥1（0 / 负数 / NaN 一律按单行兜底，不炸不返回空骨架）。 */
export function skeletonLineWidths(lines: number): string[] {
  const count = Math.max(1, Math.floor(lines));
  if (!Number.isFinite(count)) return ['100%'];
  const STEP_PCT = 11;
  const MIN_PCT = 56;
  return Array.from({ length: count }, (_, i) => `${Math.max(MIN_PCT, 100 - i * STEP_PCT)}%`);
}

const GLASS_BAR_CLASS =
  'glx-skeleton block rounded-full bg-[color:color-mix(in_srgb,currentColor_14%,transparent)] shadow-[0_0_0_1px_rgba(38,36,61,0.055),inset_0_1px_0_rgba(255,255,255,0.55),0_2px_8px_rgba(84,70,160,0.08)]';

export interface GlassSkeletonProps {
  lines?: number;
  avatar?: boolean;
  className?: string;
}

export function GlassSkeleton({ lines = 3, avatar = false, className = '' }: GlassSkeletonProps) {
  const widths = skeletonLineWidths(lines);
  return (
    <div className={`flex flex-col gap-2 ${className}`} data-glass-skeleton="" aria-hidden="true">
      {avatar && (
        <div className="mb-0.5 flex items-center gap-2.5">
          <span className={`${GLASS_BAR_CLASS} h-9 w-9 shrink-0`} />
          <span className={`${GLASS_BAR_CLASS} h-2.5 w-24`} />
        </div>
      )}
      {widths.map((width, index) => (
        <span key={index} className={`${GLASS_BAR_CLASS} h-2.5`} style={{ width }} />
      ))}
    </div>
  );
}

/** 克制的司辰空态线稿：单点双圈涟漪线稿、澜青桥色 --canvas-bridge、
 *  衰减 α 1.0/.59/.31 施加于线稿层；纯静态零动画——呼吸语法只属未读/新变化提示。 */
export function ChronosLineArt({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-chronos-lineart=""
      className={`size-14 shrink-0 ${className}`}
    >
      <circle cx="32" cy="32" r="26" stroke="var(--canvas-bridge)" strokeWidth="1.5" opacity="0.31" />
      <circle cx="32" cy="32" r="18.5" stroke="var(--canvas-bridge)" strokeWidth="1.5" opacity="0.59" />
      <circle cx="32" cy="32" r="4.5" fill="var(--ink-anchor)" opacity="0.92" />
    </svg>
  );
}

export interface ChronosEmptyStateProps {
  title: string;
  hint?: string;
  className?: string;
}

/** 司辰线稿空态：线稿 + 主句（--ink-strong）+ 说明（--ink-soft），零 --ink-faint 入文字。 */
export function ChronosEmptyState({ title, hint, className = '' }: ChronosEmptyStateProps) {
  return (
    <div className={`flex flex-col items-center gap-3 text-center ${className}`} data-chronos-empty="">
      <ChronosLineArt />
      <div className="space-y-1">
        <p className="text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium text-[color:var(--ink-strong)]">
          {title}
        </p>
        {hint && (
          <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

export default GlassSkeleton;
