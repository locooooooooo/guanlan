import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';

interface ChronosMascotNodeProps {
  epochLabel?: string;
  x: number;
  y: number;
  activeTimeSlice: 'all' | '0:00' | '1:00' | '2:00';
  isHovered: boolean;
  isSelected: boolean;
  isPlaying?: boolean;
  prefersReducedMotion?: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClickCycleTime: () => void;
  caption?: string;
}

const MASCOT_SRC = '/assets/chronos-mascot.png';

function useTransparentMascotImage(src: string): string {
  const [processedUrl, setProcessedUrl] = useState<string>(src);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return;

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        const cornersTransparent =
          data[3] === 0 &&
          data[(w - 1) * 4 + 3] === 0 &&
          data[((h - 1) * w) * 4 + 3] === 0 &&
          data[((h - 1) * w + (w - 1)) * 4 + 3] === 0;
        if (cornersTransparent) {
          setProcessedUrl(src);
          return;
        }

        const visited = new Uint8Array(w * h);
        const queue = new Int32Array(w * h);
        let head = 0;
        let tail = 0;

        const isBgWhite = (idx4: number) => {
          const r = data[idx4];
          const g = data[idx4 + 1];
          const b = data[idx4 + 2];
          const a = data[idx4 + 3];
          return a > 0 && r >= 242 && g >= 242 && b >= 242;
        };

        const pushSeed = (sx: number, sy: number) => {
          const x = Math.max(0, Math.min(w - 1, Math.round(sx)));
          const y = Math.max(0, Math.min(h - 1, Math.round(sy)));
          const pos = y * w + x;
          if (!visited[pos] && isBgWhite(pos * 4)) {
            visited[pos] = 1;
            queue[tail++] = pos;
          }
        };

        for (let x = 0; x < w; x += 2) {
          pushSeed(x, 0);
          pushSeed(x, h - 1);
        }
        for (let y = 0; y < h; y += 2) {
          pushSeed(0, y);
          pushSeed(w - 1, y);
        }

        pushSeed(w * 0.21, h * 0.18);
        pushSeed(w * 0.23, h * 0.26);
        pushSeed(w * 0.28, h * 0.34);
        pushSeed(w * 0.28, h * 0.68);
        pushSeed(w * 0.68, h * 0.38);
        pushSeed(w * 0.49, h * 0.93);

        while (head < tail) {
          const curr = queue[head++];
          const cx = curr % w;
          const cy = (curr - cx) / w;
          const idx4 = curr * 4;

          data[idx4 + 3] = 0;

          if (cx > 0) {
            const n = curr - 1;
            if (!visited[n] && isBgWhite(n * 4)) {
              visited[n] = 1;
              queue[tail++] = n;
            }
          }
          if (cx < w - 1) {
            const n = curr + 1;
            if (!visited[n] && isBgWhite(n * 4)) {
              visited[n] = 1;
              queue[tail++] = n;
            }
          }
          if (cy > 0) {
            const n = curr - w;
            if (!visited[n] && isBgWhite(n * 4)) {
              visited[n] = 1;
              queue[tail++] = n;
            }
          }
          if (cy < h - 1) {
            const n = curr + w;
            if (!visited[n] && isBgWhite(n * 4)) {
              visited[n] = 1;
              queue[tail++] = n;
            }
          }
        }

        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const pos = y * w + x;
            if (visited[pos]) continue;
            const hasTransparentNeighbor =
              visited[pos - 1] ||
              visited[pos + 1] ||
              visited[pos - w] ||
              visited[pos + w];
            if (hasTransparentNeighbor) {
              const idx4 = pos * 4;
              const r = data[idx4];
              const g = data[idx4 + 1];
              const b = data[idx4 + 2];
              if (r > 225 && g > 225 && b > 225) {
                data[idx4 + 3] = 90;
              }
            }
          }
        }

        ctx.putImageData(imgData, 0, 0);
        setProcessedUrl(canvas.toDataURL('image/png'));
      } catch {
        setProcessedUrl(src);
      }
    };
    img.src = src;

    return () => {
      cancelled = true;
    };
  }, [src]);

  return processedUrl;
}

export const ChronosMascotNode: React.FC<ChronosMascotNodeProps> = ({
  x,
  y,
  activeTimeSlice,
  epochLabel: epochLabelProp,
  isHovered,
  isSelected,
  isPlaying = false,
  prefersReducedMotion,
  onMouseEnter,
  onMouseLeave,
  onClickCycleTime,
  caption,
}) => {
  const effectiveReducedMotion =
    prefersReducedMotion ??
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const transparentMascotUrl = useTransparentMascotImage(MASCOT_SRC);
  const [castPulseCount, setCastPulseCount] = useState(0);

  const outerAstrolabeRef = useRef<SVGGElement | null>(null);
  const innerRuneRingRef = useRef<SVGGElement | null>(null);
  const staffSigilRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (effectiveReducedMotion) return;
    const speedBoost = isPlaying ? 2.1 : 1;
    const timer = d3.timer((elapsed) => {
      const outerDeg = (elapsed * 0.01 * speedBoost) % 360;
      const innerDeg = -(elapsed * 0.018 * speedBoost) % 360;
      const sigilDeg = (elapsed * 0.055 * speedBoost) % 360;

      if (outerAstrolabeRef.current) {
        outerAstrolabeRef.current.setAttribute('transform', `rotate(${outerDeg.toFixed(2)})`);
      }
      if (innerRuneRingRef.current) {
        innerRuneRingRef.current.setAttribute('transform', `rotate(${innerDeg.toFixed(2)})`);
      }
      if (staffSigilRef.current) {
        staffSigilRef.current.setAttribute('transform', `rotate(${sigilDeg.toFixed(1)})`);
      }
    });

    return () => {
      timer.stop();
    };
  }, [isPlaying, effectiveReducedMotion]);

  const epochLabel = epochLabelProp ?? (
    activeTimeSlice === 'all'
      ? '全域时间线'
      : `时间片 ${activeTimeSlice}`);

  return (
    <g
      className="d3-draggable-node cursor-grab active:cursor-grabbing"
      data-node-id="chronos_deity"
      data-testid="graph-node-chronos_deity"
      transform={`translate(${x}, ${y})`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(e) => {
        e.stopPropagation();
        setCastPulseCount((c) => c + 1);
        onClickCycleTime();
      }}
    >
      <ellipse
        cx="68"
        cy="132"
        rx="36"
        ry="7"
        style={{ fill: 'color-mix(in srgb, var(--cv-brand) 26%, transparent)' }}
        className="animate-chronos-shadow"
      />
      <ellipse
        cx="68"
        cy="132"
        rx="48"
        ry="9.5"
        fill="none"
        style={{ stroke: 'color-mix(in srgb, var(--cv-lav) 25%, transparent)' }}
        strokeWidth="0.9"
        strokeDasharray="4 6"
      />

      <g transform="translate(68, 62)">
        <g ref={outerAstrolabeRef} data-testid="d3-timer-outer-astrolabe">
          <circle
            r="58"
            style={{
              fill: 'color-mix(in srgb, var(--cv-panel) 48%, transparent)',
              stroke: 'color-mix(in srgb, var(--cv-brand) 38%, transparent)',
            }}
            strokeWidth="1.2"
            strokeDasharray="6 5"
          />
          <circle
            r="64"
            fill="none"
            style={{ stroke: 'color-mix(in srgb, var(--cv-lav) 24%, transparent)' }}
            strokeWidth="0.85"
            strokeDasharray="2 8"
          />
          <polygon
            points="0,-54 46.7,27 -46.7,27"
            fill="none"
            style={{ stroke: 'color-mix(in srgb, var(--cv-brand) 16%, transparent)' }}
            strokeWidth="0.8"
          />
          <polygon
            points="0,54 46.7,-27 -46.7,-27"
            fill="none"
            style={{ stroke: 'color-mix(in srgb, var(--cv-lav) 16%, transparent)' }}
            strokeWidth="0.8"
          />
          {Array.from({ length: 12 }).map((_, idx) => {
            const deg = idx * 30;
            return (
              <line
                key={idx}
                x1="0"
                y1="-54"
                x2="0"
                y2={idx % 3 === 0 ? '-47' : '-50'}
                style={{ stroke: idx % 3 === 0 ? 'var(--cv-brand)' : 'color-mix(in srgb, var(--cv-ink) 32%, transparent)' }}
                strokeWidth={idx % 3 === 0 ? '1.6' : '1'}
                transform={`rotate(${deg})`}
              />
            );
          })}
        </g>

        <text
          x="0"
          y="-46"
          textAnchor="middle"
          style={{ fill: 'var(--cv-amber)' }}
          fontSize="7"
          fontWeight="600"
          fontFamily="var(--font-serif)"
          opacity="0.85"
        >
          XII
        </text>
        <text
          x="48"
          y="2.5"
          textAnchor="middle"
          style={{ fill: 'var(--cv-lav)' }}
          fontSize="7"
          fontWeight="600"
          fontFamily="var(--font-serif)"
          opacity="0.8"
        >
          III
        </text>
        <text
          x="0"
          y="51"
          textAnchor="middle"
          style={{ fill: 'var(--cv-amber)' }}
          fontSize="7"
          fontWeight="600"
          fontFamily="var(--font-serif)"
          opacity="0.85"
        >
          VI
        </text>
        <text
          x="-48"
          y="2.5"
          textAnchor="middle"
          style={{ fill: 'var(--cv-lav)' }}
          fontSize="7"
          fontWeight="600"
          fontFamily="var(--font-serif)"
          opacity="0.8"
        >
          IX
        </text>

        <g ref={innerRuneRingRef}>
          <circle
            r="43"
            fill="none"
            style={{ stroke: 'color-mix(in srgb, var(--cv-lav) 45%, transparent)' }}
            strokeWidth="1.2"
            strokeDasharray="14 8 4 8"
          />
          <circle cx="0" cy="-43" r="2.3" style={{ fill: 'var(--cv-brand)' }} />
          <circle cx="43" cy="0" r="2.1" style={{ fill: 'var(--cv-lav)' }} />
          <circle cx="0" cy="43" r="2.3" style={{ fill: 'var(--cv-amber)' }} />
          <circle cx="-43" cy="0" r="2.1" style={{ fill: 'var(--cv-lav)' }} />
        </g>

        <g className="animate-clock-hour">
          <line
            x1="0"
            y1="8"
            x2="0"
            y2="-36"
            style={{ stroke: 'var(--cv-amber)' }}
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.78"
          />
          <polygon points="0,-40 -2.6,-33 2.6,-33" style={{ fill: 'var(--cv-amber)' }} opacity="0.85" />
        </g>
        <g className="animate-clock-minute">
          <line
            x1="0"
            y1="10"
            x2="0"
            y2="-50"
            style={{ stroke: 'var(--cv-brand)' }}
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.88"
          />
          <circle cx="0" cy="-50" r="2.2" style={{ fill: 'var(--cv-ink)' }} />
        </g>

        {castPulseCount > 0 && (
          <circle
            key={`cast-wave-${castPulseCount}`}
            r="52"
            fill="none"
            style={{ stroke: 'var(--cv-amber)' }}
            strokeWidth="2.2"
            className="animate-chronos-cast"
          />
        )}

        {(isHovered || isSelected || isPlaying || activeTimeSlice !== 'all') && (
          <circle
            r="59"
            fill="none"
            style={{ stroke: isPlaying ? 'var(--cv-amber)' : 'var(--cv-brand)' }}
            strokeWidth={isPlaying ? '1.8' : '1.5'}
            className="animate-sonar-ripple"
          />
        )}
      </g>

      <g className="animate-chronos-float">
        <circle
          cx="68"
          cy="64"
          r="40"
          fill="url(#chronos-halo-grad)"
          opacity={isHovered || isSelected ? 0.26 : 0.15}
          className="cv-stream-glow"
        />

        <g transform="translate(48, 58)">
          <g style={{ transformOrigin: '0px 0px' }} className="animate-wing-left">
            <path
              d="M 0,0 C -13,-15 -30,-13 -36,-3 C -26,-1 -16,2 -3,5 Z"
              style={{
                fill: 'color-mix(in srgb, var(--cv-lav) 36%, transparent)',
                stroke: 'var(--cv-lav-ink)',
              }}
              strokeWidth="0.9"
            />
            <path
              d="M -2,4 C -15,-3 -28,2 -32,10 C -20,10 -11,9 0,8 Z"
              style={{
                fill: 'color-mix(in srgb, var(--cv-brand) 30%, transparent)',
                stroke: 'var(--cv-amber)',
              }}
              strokeWidth="0.8"
            />
          </g>
        </g>

        <g transform="translate(88, 58)">
          <g style={{ transformOrigin: '0px 0px' }} className="animate-wing-right">
            <path
              d="M 0,0 C 13,-15 30,-13 36,-3 C 26,-1 16,2 3,5 Z"
              style={{
                fill: 'color-mix(in srgb, var(--cv-lav) 36%, transparent)',
                stroke: 'var(--cv-lav-ink)',
              }}
              strokeWidth="0.9"
            />
            <path
              d="M 2,4 C 15,-3 28,2 32,10 C 20,10 11,9 0,8 Z"
              style={{
                fill: 'color-mix(in srgb, var(--cv-brand) 30%, transparent)',
                stroke: 'var(--cv-amber)',
              }}
              strokeWidth="0.8"
            />
          </g>
        </g>

        <image
          href={transparentMascotUrl}
          x="6"
          y="2"
          width="124"
          height="124"
          preserveAspectRatio="xMidYMid meet"
        />

        <g transform="translate(38, 30)">
          <line
            x1="0"
            y1="-24"
            x2="0"
            y2="16"
            style={{ stroke: 'var(--cv-amber)' }}
            strokeWidth="1.4"
            strokeDasharray="3 3"
            className="animate-dash-flow-fast"
            opacity="0.85"
          />
          <circle
            r="7.5"
            style={{ fill: 'color-mix(in srgb, var(--cv-brand) 42%, transparent)' }}
            className="animate-staff-gem cv-stream-glow"
          />
          <g ref={staffSigilRef}>
            <rect
              x="-6.5"
              y="-6.5"
              width="13"
              height="13"
              rx="1.5"
              fill="none"
              style={{ stroke: 'var(--cv-amber)' }}
              strokeWidth="0.95"
              transform="rotate(45)"
            />
            <circle cx="0" cy="-10" r="1.5" style={{ fill: 'var(--cv-ink)' }} />
          </g>
          <circle
            r="11"
            fill="none"
            style={{ stroke: 'var(--cv-brand)' }}
            strokeWidth="1"
            className="animate-sonar-ripple"
          />
        </g>

        <g transform="translate(102, 46)">
          <line
            x1="0"
            y1="-7"
            x2="0"
            y2="9"
            style={{ stroke: 'var(--cv-ink)' }}
            strokeWidth="1.6"
            strokeDasharray="2 3"
            strokeLinecap="round"
            className="animate-dash-flow-fast"
          />
          <ellipse
            cx="0"
            cy="1"
            rx="15"
            ry="5.5"
            fill="none"
            style={{ stroke: 'color-mix(in srgb, var(--cv-amber) 65%, transparent)' }}
            strokeWidth="1.1"
            strokeDasharray="4 4"
            transform="rotate(-14)"
            className="animate-dash-flow"
          />
          <circle
            cx="-4"
            cy="2"
            r="2.1"
            style={{ fill: 'var(--cv-brand)' }}
            className="animate-sand-mote-1 cv-stream-glow"
          />
          <circle
            cx="3"
            cy="5"
            r="1.9"
            style={{ fill: 'var(--cv-amber)' }}
            className="animate-sand-mote-2 cv-stream-glow"
          />
          <circle
            cx="0"
            cy="-3"
            r="1.7"
            style={{ fill: 'var(--cv-lav)' }}
            className="animate-sand-mote-3 cv-stream-glow"
          />
        </g>
      </g>

      <g transform="translate(2, 136)">
        <rect
          x="0"
          y="0"
          width="128"
          height="38"
          rx="10"
          style={{
            fill: isHovered || isSelected || isPlaying ? 'var(--cv-card-selected)' : 'var(--cv-card)',
            stroke:
              isPlaying
                ? 'color-mix(in srgb, var(--cv-amber) 75%, transparent)'
                : isHovered || isSelected || activeTimeSlice !== 'all'
                  ? 'color-mix(in srgb, var(--cv-brand) 65%, transparent)'
                  : 'color-mix(in srgb, var(--cv-hairline-ink) 16%, transparent)',
          }}
          strokeWidth="1"
        />
        <circle
          cx="12"
          cy="13"
          r="3"
          style={{ fill: isPlaying ? 'var(--cv-amber)' : 'var(--cv-brand)' }}
          className={isPlaying ? 'cv-stream-glow' : undefined}
        />
        <text
          x="20"
          y="16"
          style={{ fill: 'var(--cv-ink)' }}
          fontSize="10.5"
          fontWeight="600"
          fontFamily="var(--font-sans)"
        >
          {isPlaying ? '司辰 · 时光流转' : '司辰 · 执掌时间'}
        </text>
        <text
          x="12"
          y="30.5"
          style={{ fill: 'var(--cv-amber-ink)' }}
          fontSize="9.5"
          fontFamily="var(--font-mono)"
        >
          {caption ?? epochLabel}
        </text>
      </g>
    </g>
  );
};
