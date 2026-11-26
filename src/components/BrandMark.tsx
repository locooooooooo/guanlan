import React, { useId } from 'react';

export type BrandMarkSize = 'sm' | 'md' | 'lg' | 'xl';

interface BrandMarkProps {
  size?: BrandMarkSize;
  className?: string;
}

const SIZE_CLASSES: Record<BrandMarkSize, string> = {
  sm: 'size-7',
  md: 'size-9',
  lg: 'size-12',
  xl: 'size-14',
};

/**
 * 司辰翼漏银匣徽（与 native/crates/guanlan-desktop/gen-icon.mjs 同源的光学矢量版本）。
 *
 * 视觉母题直承司辰原画与观澜纸墨气质：透明底曜石缎面双层文件夹 + 左上折耳司辰权杖朱砂眼 +
 * 夹层温润象牙纸页 + 居中对称弧形拉丝银翼与铂银朱砂流沙漏，小尺寸下仍清晰耐看、不挤压发糊。
 * 纯静态零动画（遵循 P1 静：ping / 呼吸动效仅用于未读与新变化提示，不属品牌位）。
 */
export const BrandMark: React.FC<BrandMarkProps> = ({ size = 'sm', className = '' }) => {
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const backGradId = `gl-bm-back-${uid}`;
  const paperGradId = `gl-bm-paper-${uid}`;
  const frontGradId = `gl-bm-front-${uid}`;
  const sheenGlowId = `gl-bm-sheen-${uid}`;
  const wingHiGradId = `gl-bm-wing-hi-${uid}`;
  const wingLoGradId = `gl-bm-wing-lo-${uid}`;
  const silverGradId = `gl-bm-silver-${uid}`;
  const sandGradId = `gl-bm-sand-${uid}`;

  return (
    <span
      aria-hidden="true"
      data-brand-mark={size}
      data-brand-motif="folder-hourglass"
      data-chronos-emblem="wings-tab-eye"
      className={`inline-flex shrink-0 aspect-square items-center justify-center ${SIZE_CLASSES[size]} ${className}`}
    >
      <svg
        viewBox="0 0 32 32"
        preserveAspectRatio="xMidYMid meet"
        fill="none"
        className="size-full block"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={backGradId} x1="16" y1="4" x2="16" y2="14" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#323848" />
            <stop offset="100%" stopColor="#1A1E29" />
          </linearGradient>
          <linearGradient id={paperGradId} x1="16" y1="8.8" x2="16" y2="11.2" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#F5F1EA" />
            <stop offset="100%" stopColor="#CCCFE0" />
          </linearGradient>
          <linearGradient id={frontGradId} x1="4" y1="10" x2="28" y2="28.5" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#3E455A" />
            <stop offset="56%" stopColor="#262B3B" />
            <stop offset="100%" stopColor="#161A25" />
          </linearGradient>
          <radialGradient id={sheenGlowId} cx="32%" cy="32%" r="64%">
            <stop offset="0%" stopColor="#A69EDA" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#A69EDA" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={wingHiGradId} x1="16" y1="15.2" x2="16" y2="20.4" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#E8ECF8" />
            <stop offset="100%" stopColor="#9DA6BE" />
          </linearGradient>
          <linearGradient id={wingLoGradId} x1="16" y1="17.8" x2="16" y2="22.4" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#BDC4D9" />
            <stop offset="100%" stopColor="#727C98" />
          </linearGradient>
          <linearGradient id={silverGradId} x1="16" y1="12.6" x2="16" y2="25.8" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FAFBFD" />
            <stop offset="100%" stopColor="#A8B0C4" />
          </linearGradient>
          <linearGradient id={sandGradId} x1="16" y1="15.2" x2="16" y2="24.5" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFA66C" />
            <stop offset="48%" stopColor="#F07440" />
            <stop offset="100%" stopColor="#D44E2A" />
          </linearGradient>
        </defs>

        <path
          d="M3.85 4H11.55C12.75 4 13.72 4.58 14.54 5.7L15.44 6.92C15.94 7.58 16.56 7.84 17.44 7.84H28.4C29.5 7.84 30.4 8.74 30.4 9.84V26.08C30.4 27.4 29.32 28.48 28 28.48H4C2.68 28.48 1.6 27.4 1.6 26.08V6.24C1.6 5 2.61 4 3.85 4Z"
          fill={`url(#${backGradId})`}
        />

        <circle cx="7.05" cy="6.48" r="1.12" fill="#DCE2F0" />
        <circle cx="7.05" cy="6.48" r="0.80" fill="#10131C" />
        <circle cx="7.05" cy="6.48" r="0.56" fill="#F07440" />

        <rect
          x="2.9"
          y="8.88"
          width="26.2"
          height="3.2"
          rx="1.05"
          fill={`url(#${paperGradId})`}
        />

        <rect
          x="1.6"
          y="10"
          width="28.8"
          height="18.48"
          rx="2.35"
          fill={`url(#${frontGradId})`}
        />
        <rect
          x="1.6"
          y="10"
          width="28.8"
          height="18.48"
          rx="2.35"
          fill={`url(#${sheenGlowId})`}
        />
        <circle
          cx="16"
          cy="19.24"
          r="7.1"
          stroke="#B8C2E2"
          strokeOpacity="0.16"
          strokeWidth="0.45"
        />
        <rect
          x="1.96"
          y="10.36"
          width="28.08"
          height="17.76"
          rx="2.0"
          stroke="#98A2C0"
          strokeOpacity="0.28"
          strokeWidth="0.72"
        />
        <path
          d="M3.95 10.36H28.05"
          stroke="#CBD3EB"
          strokeOpacity="0.48"
          strokeWidth="0.72"
          strokeLinecap="round"
        />

        <g>
          <path
            d="M14.1 20.6C12.2 20.3 10.3 20.6 8.8 21.5C10.5 22.1 12.6 21.8 14.3 21.2Z"
            fill={`url(#${wingLoGradId})`}
          />
          <path
            d="M14.2 19.7C11.6 18.6 8.8 18.3 6.5 19.1C8.6 20.4 11.7 20.7 14.3 20.4Z"
            fill={`url(#${wingLoGradId})`}
          />
          <path
            d="M14.3 18.8C11.2 16.5 7.5 15.5 4.6 16.5C7.1 18.4 10.8 19.4 14.4 19.6Z"
            fill={`url(#${wingHiGradId})`}
          />
          <path
            d="M17.9 20.6C19.8 20.3 21.7 20.6 23.2 21.5C21.5 22.1 19.4 21.8 17.7 21.2Z"
            fill={`url(#${wingLoGradId})`}
          />
          <path
            d="M17.8 19.7C20.4 18.6 23.2 18.3 25.5 19.1C23.4 20.4 20.3 20.7 17.7 20.4Z"
            fill={`url(#${wingLoGradId})`}
          />
          <path
            d="M17.7 18.8C20.8 16.5 24.5 15.5 27.4 16.5C24.9 18.4 21.2 19.4 17.6 19.6Z"
            fill={`url(#${wingHiGradId})`}
          />
        </g>

        <path
          d="M11.82 13.84C11.82 16.6 14.72 18.08 15.26 19.24C14.72 20.4 11.82 21.88 11.82 24.64H20.18C20.18 21.88 17.28 20.4 16.74 19.24C17.28 18.08 20.18 16.6 20.18 13.84Z"
          fill="#0F121B"
          fillOpacity="0.94"
        />

        <path
          d="M12.82 15.96Q16 16.68 19.18 15.96C18.56 17.48 16.76 18.44 16 19.24C15.24 18.44 13.44 17.48 12.82 15.96Z"
          fill={`url(#${sandGradId})`}
        />
        <path
          d="M12.24 24.46C12.98 22.24 14.64 21.06 16 21.06C17.36 21.06 19.02 22.24 19.76 24.46Z"
          fill={`url(#${sandGradId})`}
        />
        <line
          x1="16"
          y1="18.85"
          x2="16"
          y2="21.35"
          stroke="#FFDAA6"
          strokeWidth="0.9"
          strokeLinecap="round"
        />

        <path
          d="M11.82 13.84C11.82 16.6 14.72 18.08 15.26 19.24C14.72 20.4 11.82 21.88 11.82 24.64H20.18C20.18 21.88 17.28 20.4 16.74 19.24C17.28 18.08 20.18 16.6 20.18 13.84Z"
          stroke={`url(#${silverGradId})`}
          strokeWidth="0.94"
          strokeLinejoin="round"
        />
        <rect x="10.72" y="12.74" width="10.56" height="1.48" rx="0.74" fill={`url(#${silverGradId})`} />
        <rect x="10.72" y="24.22" width="10.56" height="1.48" rx="0.74" fill={`url(#${silverGradId})`} />
      </svg>
    </span>
  );
};

export default BrandMark;
