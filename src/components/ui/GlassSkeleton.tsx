import React from 'react';

/**
 * U11 · 琉璃流光骨架屏（通用轻组件，独立成件不并入 primitives 基建）。
 *
 * 依据：docs/guanlan/观澜-全站UIUX琉璃美学与司辰叙事收口-长任务卡-v1.1.md §4 U11、
 * 设计规范 v0.6 §6（空态线稿语法）与 motion.css §3.29（glx-skeleton 流光）。
 *
 * - 视觉：白玻璃条（L2 相位：发丝阴影环替代硬描边 + inset 顶沿白线高光，border:none）
 *   + transform 扫光流光（.glx-skeleton::after，只动 transform，禁 background-position）；
 *   prefers-reduced-motion 下流光层 display:none，终态＝静态琉璃骨架恒可见（motion.css §4）。
 * - 语义：本组件是纯视觉占位（aria-hidden），「正在加载」的诚实播报由调用方的
 *   role="status" 容器与原文案承担——骨架不得吞掉真实错误态 / 重试入口。
 * - 纪律：行宽由纯函数 skeletonLineWidths 决定（可单测）；零字面色（阴影环取既有
 *   rgba(38,36,61,.045) 阴影环语法与 --glass-shadow 同族的薰衣草相位）。
 */

/** 骨架行宽纯函数：首行满宽，逐行按固定步长收窄（尾行不低于 56%），
 *  行数钳到 ≥1（0 / 负数 / NaN 一律按单行兜底，不炸不返回空骨架）。 */
export function skeletonLineWidths(lines: number): string[] {
  const count = Math.max(1, Math.floor(lines));
  if (!Number.isFinite(count)) return ['100%'];
  const STEP_PCT = 11;
  const MIN_PCT = 56;
  return Array.from({ length: count }, (_, i) => `${Math.max(MIN_PCT, 100 - i * STEP_PCT)}%`);
}

/* 琉璃条底座：glx-skeleton（motion.css §3.29 流光载体）+ 随语境 tint 的玻璃面。
   实机核验修订：条底由固定 bg-white/75 改为 color-mix(currentColor 14%)——
   骨架条继承容器文字色（壳层 --ink-soft / 阅读纸面 #6E6A61 / 夜航纸面 #A1A09A），
   三语境下轨道均可见（固定白条在浅纸面 #F5F0E8 上近乎隐形）；描边走阴影环
   rgba(38,36,61,0.055)（v0.8 铁律：新表面 border:none），顶沿高光只用 inset 白线
   （0.55：暗底上不刺眼、浅底上仍是玻璃高光），弥散微影取 --glass-shadow 同族
   薰衣草相位。高度由调用处追加（行条 h-2.5 / 头像位 h-9），基类不写死尺寸。 */
const GLASS_BAR_CLASS =
  'glx-skeleton block rounded-full bg-[color:color-mix(in_srgb,currentColor_14%,transparent)] shadow-[0_0_0_1px_rgba(38,36,61,0.055),inset_0_1px_0_rgba(255,255,255,0.55),0_2px_8px_rgba(84,70,160,0.08)]';

export interface GlassSkeletonProps {
  /** 骨架行数（默认 3）；行宽由 skeletonLineWidths 纯函数决定 */
  lines?: number;
  /** 列表型加载：首行渲染圆形头像位 + 短题行 */
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

/** 克制的司辰线稿（v0.6 §6 空态语法：单点双圈涟漪线稿、澜青桥色 --canvas-bridge、
 *  衰减 α 1.0/.59/.31 施加于线稿层；纯静态零动画——呼吸语法只属未读/新变化提示）。 */
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
  /** 空态主句（诚实句，逐字由调用方给——「不承诺」「拒绝」类边界词是品牌资产） */
  title: string;
  /** 次行说明（可省） */
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
