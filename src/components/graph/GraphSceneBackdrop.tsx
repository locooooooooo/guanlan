import React from 'react';
import { ChronosMascotNode } from '../ChronosMascotNode';
import PackageGroupFrame, { PACKAGE_GROUP_FRAME_H } from '../canvas/PackageGroupFrame';
import RichDocPreviewCard from '../canvas/RichDocPreviewCard';
import { cleanDisplayText } from '../../utils/displayText';
import { computeDynamicEdgePath, hasUnreadChanges, unreadStatusLabel } from '../../utils/guanlanEngine';
import { shouldDrawGroupConnector } from '../../utils/canvasViewport';
import {
  artifactStageBadgeText,
  artifactStateOf,
  DOC_STATE_LABEL,
} from '../../utils/stateProjection';
import { FANOUT_DAY_HEADER_TAIL } from '../../utils/graphEvents';
import {
  DATE_CARD_H,
  DATE_CARD_W,
  DEFAULT_NODE_POSITIONS,
  EVENT_CARD_H,
  EVENT_CARD_W,
  FANOUT_HEADER_BUTTON_W,
  FANOUT_HEADER_CAPSULE_H,
  FANOUT_HEADER_TEXT_LEFT,
  LANE_COLORS,
  LANE_OFFSETS,
  milestoneY,
  FIXED_TEXT_TRUNK_DX,
  SPRING_STAGGER_MS,
  TRUNK_META_TEXT_Y,
  fanOutHeaderButtonLeft,
  fanOutHeaderCapsuleWidth,
  fanOutHeaderCapsuleY,
  sceneDateLabel,
  trunkTickShowsLabel,
  type LaneKey,
} from './geometry';
import type { GraphCanvasCtx } from './useGraphCanvasController';


export function GraphSceneBackdrop({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    svgRef,
    canvasTool,
    zoomLayerRef,
    meteorShowerEnabled,
    meteorBurstKey,
    canvasLayoutMode,
    mainHubPos,
    trunkX,
    openFileReader,
    activeFileRecord,
    scene,
    rulerGranularity,
    onGranularityChange,
    onDrillToBucket,
    chronosSliderOpen,
    chronosConduits,
    liveFlowEnabled,
    d3RiverStrands,
    trunkTicks,
    TRUNK_AXIS_TOP,
    TRUNK_AXIS_BOTTOM,
    rulerMaxCount,
    rulerLabelStep,
    navigatorDateSet,
    selectDate,
    xrayLaserEnabled,
    leftSourceNodes,
    isNodeVisibleByCategory,
    resolveLeftSourcePos,
    hoveredCanvasNodeId,
    selectedCanvasNodeId,
    setSelectedCanvasNodeId,
    nodePositions,
    activeTimeSlice,
    onOpenDayInTimeline,
    isNodeInActiveTimeSlice,
    subAgentCards,
    fanOutBounds,
    fanOutHeaderLine,
    isFanOutCollapsed,
    setIsFanOutCollapsed,
    chronosPos,
    cycleChronosTimeSlice,
    handleNodeMouseEnter,
    handleNodeMouseLeave,
    workspaceName,
    onSelectFile,
    onSelectEvent,
    exploreAfterClick,
    openNarrativeDrawer,
    systemActions,
    readingStates,
    stateIndex,
    files,
    springRevealKey,
    prefersReducedMotion,
    lodGates,
    pkgTitleOverrides,
    packageGroupLayouts,
    mountedPkgIds,
    packageCardsByPkg,
    focusedPkgId,
    selectedRichDocFileId,
    setSelectedRichDocFileId,
    fileById,
  } = ctx;
  return (
    <>
      <defs>
        <filter id="d3-stream-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="d3-stream-glow-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="chronos-halo-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0.95" />
          <stop offset="50%" style={{ stopColor: 'var(--cv-brand-hover)' }} stopOpacity="0.75" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id="xray-laser-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0" />
          <stop offset="25%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0.65" />
          <stop offset="65%" style={{ stopColor: 'var(--cv-lav)' }} stopOpacity="0.75" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-lav)' }} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="meteor-tail-terracotta" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-ink)' }} stopOpacity="1" />
          <stop offset="18%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0.9" />
          <stop offset="55%" style={{ stopColor: 'var(--cv-amber)' }} stopOpacity="0.38" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="meteor-tail-lavender" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-ink)' }} stopOpacity="1" />
          <stop offset="18%" style={{ stopColor: 'var(--cv-lav)' }} stopOpacity="0.9" />
          <stop offset="55%" style={{ stopColor: 'var(--cv-link)' }} stopOpacity="0.38" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-lav)' }} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="meteor-tail-amber" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-ink)' }} stopOpacity="1" />
          <stop offset="20%" style={{ stopColor: 'var(--cv-amber)' }} stopOpacity="0.92" />
          <stop offset="60%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0.32" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-amber)' }} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="comet-conduit-terracotta" x1="100%" y1="0%" x2="0%" y2="0%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-ink)' }} stopOpacity="1" />
          <stop offset="30%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0.9" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-brand)' }} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="comet-conduit-lavender" x1="100%" y1="0%" x2="0%" y2="0%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-ink)' }} stopOpacity="1" />
          <stop offset="30%" style={{ stopColor: 'var(--cv-lav)' }} stopOpacity="0.9" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-lav)' }} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="comet-conduit-amber" x1="100%" y1="0%" x2="0%" y2="0%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-ink)' }} stopOpacity="1" />
          <stop offset="30%" style={{ stopColor: 'var(--cv-amber)' }} stopOpacity="0.92" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-amber)' }} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="chronos-accumulation-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style={{ stopColor: 'var(--cv-lane-md)' }} stopOpacity="0.28" />
          <stop offset="48%" style={{ stopColor: 'var(--cv-lav)' }} stopOpacity="0.18" />
          <stop offset="100%" style={{ stopColor: 'var(--cv-link)' }} stopOpacity="0.06" />
        </linearGradient>
      </defs>

        {meteorShowerEnabled && lodGates.meteors && (
          <g
            data-testid="shooting-stars-layer"
            className="pointer-events-none cv-ambient-stars"
          >
            {[
              { cx: 145, cy: 62, r: 1.4, color: 'var(--cv-amber)', delay: '0s' },
              { cx: 288, cy: 84, r: 1.6, color: 'var(--cv-lav)', delay: '0.9s' },
              { cx: 540, cy: 52, r: 1.5, color: 'var(--cv-brand)', delay: '1.7s' },
              { cx: 745, cy: 118, r: 1.8, color: 'var(--cv-ink)', delay: '0.4s' },
              { cx: 192, cy: 368, r: 1.4, color: 'var(--cv-link)', delay: '2.1s' },
              { cx: 332, cy: 565, r: 1.6, color: 'var(--cv-amber)', delay: '1.3s' },
              { cx: 785, cy: 495, r: 1.5, color: 'var(--cv-lav)', delay: '2.6s' },
            ].map((star, idx) => (
              <g
                key={`twinkle-${idx}`}
                transform={`translate(${star.cx}, ${star.cy})`}
              >
                <g
                  style={{ animationDelay: star.delay }}
                  className="animate-star-twinkle"
                >
                  <path
                    d="M -4.5,0 L 4.5,0 M 0,-4.5 L 0,4.5"
                    style={{ stroke: star.color }}
                    strokeWidth="0.8"
                    opacity="0.75"
                  />
                  <circle r={star.r} style={{ fill: 'var(--cv-ink)' }} />
                </g>
              </g>
            ))}

            {[
              {
                id: 'meteor-1',
                x: 720,
                y: 42,
                angle: -24,
                cls: 'animate-meteor-1',
                grad: 'url(#meteor-tail-terracotta)',
                accent: 'var(--cv-brand)',
                tailLen: 155,
              },
              {
                id: 'meteor-2',
                x: 490,
                y: 22,
                angle: -26,
                cls: 'animate-meteor-2',
                grad: 'url(#meteor-tail-lavender)',
                accent: 'var(--cv-lav)',
                tailLen: 140,
              },
              {
                id: 'meteor-3',
                x: 830,
                y: 168,
                angle: -25,
                cls: 'animate-meteor-3',
                grad: 'url(#meteor-tail-amber)',
                accent: 'var(--cv-amber)',
                tailLen: 165,
              },
              {
                id: 'meteor-4',
                x: 360,
                y: 86,
                angle: -23,
                cls: 'animate-meteor-4',
                grad: 'url(#meteor-tail-terracotta)',
                accent: 'var(--cv-brand)',
                tailLen: 130,
              },
              {
                id: 'meteor-5',
                x: 780,
                y: 340,
                angle: -26,
                cls: 'animate-meteor-5',
                grad: 'url(#meteor-tail-lavender)',
                accent: 'var(--cv-lav)',
                tailLen: 145,
              },
            ].map((m) => (
              <g
                key={m.id}
                transform={`translate(${m.x}, ${m.y}) rotate(${m.angle})`}
              >
                <g className={m.cls}>
                  <polygon
                    points={`0,0 ${m.tailLen},-3.2 ${m.tailLen},3.2`}
                    fill={m.grad}
                    opacity="0.88"
                  />
                  <line
                    x1="0"
                    y1="0"
                    x2={m.tailLen * 0.68}
                    y2="0"
                    stroke={m.grad}
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <circle cx="24" cy="-1.8" r="1.1" style={{ fill: m.accent }} opacity="0.85" />
                  <circle cx="48" cy="1.6" r="0.9" style={{ fill: 'var(--cv-ink)' }} opacity="0.75" />
                  <circle cx="76" cy="-1.2" r="0.8" style={{ fill: m.accent }} opacity="0.6" />
                  <path
                    d="M -7,0 L 7,0 M 0,-7 L 0,7"
                    style={{ stroke: 'var(--cv-ink)' }}
                    strokeWidth="1.1"
                  />
                  <circle
                    cx="0"
                    cy="0"
                    r="2.6"
                    style={{ fill: 'var(--cv-ink)' }}
                    className="cv-stream-glow"
                  />
                </g>
              </g>
            ))}

            {meteorBurstKey > 0 && (
              <g key={`meteor-burst-${meteorBurstKey}`}>
                {[
                  { x: 580, y: 54, angle: -25, grad: 'url(#meteor-tail-amber)' },
                  { x: 390, y: 128, angle: -23, grad: 'url(#meteor-tail-terracotta)' },
                  { x: 740, y: 210, angle: -26, grad: 'url(#meteor-tail-lavender)' },
                ].map((b, bIdx) => (
                  <g
                    key={bIdx}
                    transform={`translate(${b.x}, ${b.y}) rotate(${b.angle})`}
                  >
                    <g
                      className="animate-meteor-burst"
                      style={{ animationDelay: `${bIdx * 0.14}s` }}
                    >
                      <polygon
                        points="0,0 170,-3.6 170,3.6"
                        fill={b.grad}
                      />
                      <path
                        d="M -8,0 L 8,0 M 0,-8 L 0,8"
                        style={{ stroke: 'var(--cv-ink)' }}
                        strokeWidth="1.2"
                      />
                      <circle
                        cx="0"
                        cy="0"
                        r="3"
                        style={{ fill: 'var(--cv-ink)' }}
                        className="cv-stream-glow"
                      />
                    </g>
                  </g>
                ))}
              </g>
            )}
          </g>
        )}
        {canvasLayoutMode !== 'xray' && (
          <g transform={`translate(${mainHubPos.x + 75}, ${mainHubPos.y + 38})`}>
            <circle
              r="195"
              fill="none"
              style={{ stroke: 'color-mix(in srgb, var(--cv-brand) 16%, transparent)' }}
              strokeWidth="1"
              strokeDasharray="4 8"
              className="animate-orbit-spin"
            />
            <circle
              r="285"
              fill="none"
              style={{ stroke: 'color-mix(in srgb, var(--cv-lav) 16%, transparent)' }}
              strokeWidth="1"
              strokeDasharray="6 10"
              className="animate-orbit-spin"
            />
          </g>
        )}

        <g
          className="d3-no-pan cursor-pointer"
          data-trunk-open-reader-chip=""
          transform={`translate(${trunkX + FIXED_TEXT_TRUNK_DX}, ${TRUNK_META_TEXT_Y})`}
          onClick={() => openFileReader((activeFileRecord?.file_id || ''))}
        >
          <rect
            x="-6"
            y="-12"
            width="92"
            height="19"
            rx="9.5"
            style={{
              fill: 'color-mix(in srgb, var(--cv-panel) 88%, transparent)',
              stroke: 'color-mix(in srgb, var(--cv-link) 34%, transparent)',
            }}
            strokeWidth="0.9"
          />
          <text
            x="40"
            y="1"
            textAnchor="middle"
            style={{ fill: 'var(--cv-link)' }}
            fontSize="10.5"
            fontFamily="var(--font-sans)"
            fontWeight="500"
            className="hover:fill-[color:var(--cv-link-hover)] transition-colors"
          >
            打开阅读器 →
          </text>
          <text
            x="0"
            y="18"
            style={{ fill: 'var(--cv-ink-meta)' }}
            fontSize="9.5"
            fontFamily="var(--font-mono)"
            opacity="0.82"
          >
            时光沉淀 · 逐条可溯
          </text>
        </g>


        <g style={{ display: chronosSliderOpen ? undefined : 'none' }}>
          <path
            d={chronosConduits.staffToTimeline}
            fill="none"
            style={{ stroke: 'color-mix(in srgb, var(--cv-brand) 45%, transparent)' }}
            strokeWidth="1.4"
            strokeDasharray="4 6"
            className="animate-dash-flow"
          />
          <path
            d={chronosConduits.hourglassToRiver}
            fill="none"
            style={{ stroke: 'color-mix(in srgb, var(--cv-amber) 55%, transparent)' }}
            strokeWidth="1.6"
            strokeDasharray="5 10"
            className="animate-dash-flow-fast"
          />
          {liveFlowEnabled && lodGates.liveFlow && (
            <>
              <g className="cv-stream-glow">
                <path
                  d="M 0,0 L -20,0"
                  stroke="url(#comet-conduit-terracotta)"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                />
                <circle r="2.3" style={{ fill: 'var(--cv-ink)' }} />
                <animateMotion
                  dur="1.8s"
                  repeatCount="indefinite"
                  rotate="auto"
                  path={chronosConduits.staffToTimeline}
                />
              </g>
              <g className="cv-stream-glow">
                <path
                  d="M 0,0 L -22,0"
                  stroke="url(#comet-conduit-amber)"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                />
                <circle r="2.4" style={{ fill: 'var(--cv-ink)' }} />
                <animateMotion
                  dur="1.6s"
                  repeatCount="indefinite"
                  rotate="auto"
                  path={chronosConduits.hourglassToRiver}
                />
              </g>
            </>
          )}
        </g>

    </>
  );
}
