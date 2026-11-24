import React, { useId } from 'react';

export type BrandMarkSize = 'sm' | 'md' | 'lg';

interface BrandMarkProps {
  /** sm=24px（顶栏）/ md=34px（关于页）/ lg=44px（首启引导） */
  size?: BrandMarkSize;
  className?: string;
}

const SIZE_CLASSES: Record<BrandMarkSize, string> = {
  sm: 'size-6 rounded-[7px]',
  md: 'size-9 rounded-[10px]',
  lg: 'size-11 rounded-[12px]',
};

/**
 * 司辰星盘沙漏徽（与 native/crates/guanlan-desktop/gen-icon.mjs 同源的光学矢量版本）。
 *
 * 视觉母题直承司辰立绘：澜墨深空圆角底 + 薰衣草星雾 + 银白新月星盘环 +
 * 12 点司辰权杖指针与琥珀核心珠 + 居中暖琥珀流沙漏 + 3 点四芒星芒。
 * 纯静态零动画（遵循 P1 静：ping / 呼吸动效仅用于未读与新变化提示，不属品牌位）。
 */
export const BrandMark: React.FC<BrandMarkProps> = ({ size = 'sm', className = '' }) => {
  // React 19 SSR 与客户端均支持 useId()，多处同页渲染时渐变 ID 互不碰撞
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const bgGradId = `gl-bm-bg-${uid}`;
  const irisGlowId = `gl-bm-iris-${uid}`;
  const warmGlowId = `gl-bm-warm-${uid}`;
  const silverGradId = `gl-bm-silver-${uid}`;
  const sandGradId = `gl-bm-sand-${uid}`;

  return (
    <span
      aria-hidden="true"
      data-brand-mark={size}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden shadow-[0_2px_8px_rgba(17,32,48,0.28),inset_0_1px_0_rgba(255,255,255,0.22)] ${SIZE_CLASSES[size]} ${className}`}
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        className="size-full block"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={bgGradId} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#1C2846" />
            <stop offset="100%" stopColor="#0C1627" />
          </linearGradient>
          <radialGradient id={irisGlowId} cx="36%" cy="34%" r="58%">
            <stop offset="0%" stopColor="#7C6FD0" stopOpacity="0.46" />
            <stop offset="100%" stopColor="#7C6FD0" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={warmGlowId} cx="50%" cy="52%" r="36%">
            <stop offset="0%" stopColor="#F58642" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#F58642" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={silverGradId} x1="5" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="60%" stopColor="#E4EEFD" />
            <stop offset="100%" stopColor="#C4D3EE" />
          </linearGradient>
          <linearGradient id={sandGradId} x1="16" y1="12" x2="16" y2="23" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFB86C" />
            <stop offset="52%" stopColor="#F27E3B" />
            <stop offset="100%" stopColor="#D65222" />
          </linearGradient>
        </defs>

        {/* 澜墨深空圆角琉璃底 + 薰衣草星雾 + 琥珀暖晕 */}
        <rect width="32" height="32" fill={`url(#${bgGradId})`} />
        <rect width="32" height="32" fill={`url(#${irisGlowId})`} />
        <rect width="32" height="32" fill={`url(#${warmGlowId})`} />

        {/* 银白新月星盘环（左厚右纤的偏心圆环，零硬折痕） */}
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16 4.98A11.5 11.5 0 1 1 15.99 4.98ZM16.92 6.78A9.7 9.7 0 1 0 16.93 6.78Z"
          fill={`url(#${silverGradId})`}
        />

        {/* 12 点司辰权杖指针尖 + 核心琥珀宝珠 */}
        <path d="M16 1.85L17.45 5.45L16 7.15L14.55 5.45Z" fill="#F8FBFF" />
        <circle cx="16" cy="5.45" r="1.45" fill="#F4F8FF" />
        <circle cx="16" cy="5.45" r="0.96" fill="#0E1728" />
        <circle cx="16" cy="5.45" r="0.66" fill="#F3843E" />

        {/* 3 点四芒星芒（与左侧新月平衡，呼应全景星图） */}
        <path
          d="M27.3 14.55Q27.3 16.48 29.2 16.48Q27.3 16.48 27.3 18.41Q27.3 16.48 25.4 16.48Q27.3 16.48 27.3 14.55Z"
          fill="#FFF7EB"
        />

        {/* 居中琉璃沙漏主体 */}
        <path
          d="M11.6 10.65C11.6 13.75 14.75 15.35 15.25 16.48C14.75 17.61 11.6 19.21 11.6 22.3H20.4C20.4 19.21 17.25 17.61 16.75 16.48C17.25 15.35 20.4 13.75 20.4 10.65Z"
          fill="#0D1729"
          fillOpacity="0.86"
        />

        {/* 上仓暖琥珀流沙 + 细腰金线 + 下仓沉淀丘 */}
        <path
          d="M12.75 12.65Q16 13.45 19.25 12.65C18.65 14.35 16.75 15.45 16 16.48C15.25 15.45 13.35 14.35 12.75 12.65Z"
          fill={`url(#${sandGradId})`}
        />
        <path
          d="M12.35 22.05C13.1 19.8 14.7 18.75 16 18.75C17.3 18.75 18.9 19.8 19.65 22.05Z"
          fill={`url(#${sandGradId})`}
        />
        <line
          x1="16"
          y1="16.1"
          x2="16"
          y2="19.1"
          stroke="#FFD28A"
          strokeWidth="0.9"
          strokeLinecap="round"
        />

        {/* 沙漏银白玻璃廓线与上下端盖 */}
        <path
          d="M11.6 10.65C11.6 13.75 14.75 15.35 15.25 16.48C14.75 17.61 11.6 19.21 11.6 22.3H20.4C20.4 19.21 17.25 17.61 16.75 16.48C17.25 15.35 20.4 13.75 20.4 10.65Z"
          stroke={`url(#${silverGradId})`}
          strokeWidth="0.88"
          strokeLinejoin="round"
        />
        <rect x="10.45" y="9.1" width="11.1" height="1.6" rx="0.8" fill={`url(#${silverGradId})`} />
        <rect x="10.45" y="22.25" width="11.1" height="1.6" rx="0.8" fill={`url(#${silverGradId})`} />
      </svg>
    </span>
  );
};

export default BrandMark;
