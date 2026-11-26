import React from 'react';
import { BookOpen, GitBranch } from 'lucide-react';
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


export function GraphSceneCards({ ctx }: { ctx: GraphCanvasCtx }) {
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
    spotlight,
  } = ctx;
  const spotlightCurrentFileId = (() => {
    if (!spotlight?.enabled || spotlight.items.length === 0) return null;
    const n = spotlight.items.length;
    return spotlight.items[((spotlight.cursor % n) + n) % n].file_id;
  })();
  const spotlightDim = (fileId: string | null | undefined): boolean =>
    Boolean(spotlight?.enabled && fileId && spotlight.dimmedFileIds.has(fileId));
  return (
    <>
        {(isFanOutCollapsed && canvasLayoutMode === 'xray'
          ? subAgentCards.slice(0, 2)
          : subAgentCards
        ).map((card, cardIdx) => {
          if (!isNodeVisibleByCategory(card.format)) return null;
          const pos = nodePositions[card.id] || DEFAULT_NODE_POSITIONS[card.id];
          const isSelected = selectedCanvasNodeId === card.id;
          const fileRec = files.find((f) => f.file_id === card.fileId);
          const unreadInfo = fileRec
            ? hasUnreadChanges(fileRec, readingStates[card.fileId])
            : null;
          const isUnread = unreadInfo?.isUnread ?? false;
          const spotlightDimmed = spotlightDim(card.fileId);
          const spotlightCurrent = Boolean(card.fileId && card.fileId === spotlightCurrentFileId);
          const inTimeSlice = isNodeInActiveTimeSlice(card.timeBucket);
          const artifactState = artifactStateOf(stateIndex, card.fileId);
          const stageBadgeText = artifactState
            ? DOC_STATE_LABEL[artifactState.state]
            : artifactStageBadgeText(card.packageStage, Boolean(card.decisionId));
          const stageBadgePillClass =
            'shrink-0 rounded-full bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)] px-1.5 py-px text-[9.5px] font-mono leading-[1.45] text-[color:var(--cv-ink-meta)]';
          const cardLaneColor = card.decisionId
            ? 'var(--cv-lav)'
            : card.format === 'svg'
              ? LANE_COLORS.svg
              : card.format === 'pdf'
                ? LANE_COLORS.pdf
                : card.format === 'md'
                  ? LANE_COLORS.md
                  : LANE_COLORS.unknown;
          const cardTitle = card.dirPrefix
            ? `${card.dirPrefix}/${card.fileName}`
            : card.fileName;
          const pkgLine = card.dirPrefix
            ? `${card.dirPrefix} · ${card.pkgPath || card.kindLabel || ''}`
            : card.pkgPath || card.kindLabel || '';

          return (
            <g
              key={card.id}
              className="d3-draggable-node cursor-grab active:cursor-grabbing"
              data-node-id={card.id}
              data-testid={`graph-node-${card.id}`}
              transform={`translate(${pos.x}, ${pos.y})`}
              opacity={inTimeSlice ? 1 : 0.3}
              onMouseEnter={() => {
                if (card.fileId) handleNodeMouseEnter(card.fileId, card.id);
              }}
              onMouseLeave={handleNodeMouseLeave}
              onClick={() => {
                setSelectedCanvasNodeId(card.id);
                setSelectedRichDocFileId(null);
                if (card.eventId) onSelectEvent?.(card.eventId);
                if (card.fileId) onSelectFile(card.fileId, card.revisionId ?? undefined);
                if (card.fileId) exploreAfterClick(card.fileId, card.revisionId ?? undefined, card.eventId);
              }}
              onDoubleClick={() => {
                if (card.fileId) {
                  openNarrativeDrawer({ nodeId: card.id, fileId: card.fileId });
                } else if (card.decisionId) {
                  openNarrativeDrawer({ nodeId: card.id });
                }
              }}
              onContextMenu={(e) => {
                if (!card.fileId || !systemActions?.onOpenFileContextMenu) return;
                const targetFile = files.find((f) => f.file_id === card.fileId);
                if (!targetFile) return;
                e.preventDefault();
                e.stopPropagation();
                systemActions.onOpenFileContextMenu(e, {
                  kind: 'file',
                  relativePath: targetFile.relative_path,
                  title: targetFile.title,
                  fileId: targetFile.file_id,
                  revisionId: card.revisionId || targetFile.current_revision_id,
                });
              }}
            >
              <g
                key={`${card.id}-${springRevealKey}`}
                className="anim-spring-pop"
                style={{
                  animationDelay: `${cardIdx * SPRING_STAGGER_MS}ms`,
                  transformOrigin: 'left center',
                }}
              >
              {isSelected && xrayLaserEnabled && (
                <rect
                  x="-3"
                  y="-3"
                  width={EVENT_CARD_W + 6}
                  height={EVENT_CARD_H + 6}
                  rx="14"
                  fill="none"
                  style={{ stroke: 'color-mix(in srgb, var(--cv-lane-md) 45%, transparent)' }}
                  strokeWidth="1"
                  className="animate-sonar-ripple"
                />
              )}
              <foreignObject width={EVENT_CARD_W} height={EVENT_CARD_H}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={cardTitle}
                  title={cardTitle}
                  data-spotlight-dimmed={spotlightDimmed ? 'true' : undefined}
                  data-spotlight-current={spotlightCurrent ? 'true' : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openNarrativeDrawer({ nodeId: card.id, fileId: card.fileId });
                    }
                  }}
                  className={`group/evcard glx-canvas-card relative overflow-hidden w-full h-full rounded-xl pl-3.5 pr-2.5 py-2.5 text-left flex flex-col justify-between gap-1 cursor-grab active:cursor-grabbing ${
                    isSelected
                      ? 'bg-[color:var(--cv-card-selected)] border border-[color:color-mix(in_srgb,var(--cv-lane-md)_90%,transparent)] shadow-[0_8px_22px_color-mix(in_srgb,var(--cv-lane-md)_20%,transparent)]'
                      : 'bg-[color:var(--cv-card)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_11%,transparent)] shadow-[0_2px_8px_color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)] hover:border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_25%,transparent)] hover:shadow-[0_8px_20px_-4px_color-mix(in_srgb,var(--cv-hairline-ink)_12%,transparent)]'
                  } ${
                    spotlightDimmed
                      ? 'opacity-[0.38] saturate-[0.35]'
                      : ''
                  } ${
                    spotlightCurrent
                      ? 'ring-1 ring-[color:var(--cv-amber)] shadow-[0_0_14px_color-mix(in_srgb,var(--cv-amber)_28%,transparent)]'
                      : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-2.5 left-0 w-[3px] rounded-r-full"
                    style={{
                      backgroundColor: cardLaneColor,
                      opacity: isSelected ? 1 : 0.65,
                    }}
                  />
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span
                      className="text-[12.5px] font-semibold text-[color:var(--cv-ink)] leading-[1.3] truncate min-w-0"
                    >
                      {card.fileName}
                    </span>
                    {card.versionSpan && (
                      <span
                        className="shrink-0 max-w-[48%] inline-flex items-center gap-1 truncate rounded-full border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_14%,transparent)] bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_5%,transparent)] px-1.5 text-[9.5px] font-mono tabular-nums leading-[1.6] text-[color:var(--cv-ink-meta)]"
                      >
                        <span
                          aria-hidden="true"
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: cardLaneColor, opacity: 0.85 }}
                        />
                        <span className="truncate">{card.versionSpan}</span>
                      </span>
                    )}
                  </div>

                  {pkgLine && (
                    <div className="text-[11px] leading-[1.2] text-[color:var(--cv-ink-meta)] font-mono truncate min-w-0">
                      {pkgLine}
                    </div>
                  )}

                  <div className="text-[10.5px] leading-[1.35] line-clamp-2 min-w-0 text-[color:var(--cv-ink-2)]">
                    {cleanDisplayText(card.digestLine || card.detail) || card.digestLine || card.detail}
                  </div>

                  <div className="flex items-center justify-between gap-1.5 w-full min-w-0">
                    <div className="flex items-center gap-1 min-w-0">
                      {stageBadgeText ? (
                        <span
                          data-doc-state={artifactState ? artifactState.state : undefined}
                          className={stageBadgePillClass}
                        >
                          {stageBadgeText}
                        </span>
                      ) : null}
                      <span
                        className={`d3-no-pan inline-flex items-center gap-1 transition-opacity duration-150 ${
                          isSelected
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/evcard:opacity-100 group-focus-within/evcard:opacity-100'
                        }`}
                      >
                        <button
                          type="button"
                          data-cv-card-trace={card.id}
                          title="追溯此条记录的版本脉络与来源证据"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCanvasNodeId(card.id);
                            if (card.fileId) onSelectFile(card.fileId, card.revisionId ?? undefined);
                            openNarrativeDrawer({ nodeId: card.id, fileId: card.fileId });
                          }}
                          className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] font-medium bg-[color:color-mix(in_srgb,var(--cv-lav)_12%,transparent)] text-[color:var(--cv-lav-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-lav)_22%,transparent)] cursor-pointer"
                        >
                          <GitBranch className="w-2.5 h-2.5" strokeWidth={1.7} aria-hidden="true" />
                          <span>溯源</span>
                        </button>
                        {card.fileId && (
                          <button
                            type="button"
                            data-cv-card-read={card.id}
                            title="在阅读器中打开原文"
                            onClick={(e) => {
                              e.stopPropagation();
                              openFileReader(card.fileId, 'read');
                            }}
                            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] font-medium bg-[color:color-mix(in_srgb,var(--cv-brand)_11%,transparent)] text-[color:var(--cv-brand-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-brand)_20%,transparent)] cursor-pointer"
                          >
                            <BookOpen className="w-2.5 h-2.5" strokeWidth={1.7} aria-hidden="true" />
                            <span>原文</span>
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 min-w-0">
                      {isUnread && !isSelected && unreadInfo && (
                        <span
                          title={unreadStatusLabel(unreadInfo.reason)}
                          className="w-1.5 h-1.5 rounded-full bg-[color:var(--cv-unread)] shrink-0"
                        />
                      )}
                      <span className="text-[10px] font-mono text-[color:var(--cv-ink-meta)] tabular-nums truncate inline-flex items-center gap-1">
                        {card.changeCounts ? (
                          <>
                            {card.changeCounts.added > 0 && (
                              <span style={{ color: 'var(--cv-add)' }}>
                                +{card.changeCounts.added}
                              </span>
                            )}
                            {card.changeCounts.removed > 0 && (
                              <span style={{ color: 'var(--cv-del)' }}>
                                -{card.changeCounts.removed}
                              </span>
                            )}
                            {card.changeCounts.added === 0 && card.changeCounts.removed === 0 && (
                              <span>±0</span>
                            )}
                            <span className="opacity-50">·</span>
                            <span>{card.observedClock}</span>
                          </>
                        ) : (
                          card.observedClock
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </foreignObject>
              </g>
            </g>
          );
        })}

        {canvasLayoutMode === 'xray' &&
          packageGroupLayouts.map(({ group, x, y, width }, groupIdx) => {
            if (!mountedPkgIds.has(group.pkgId)) return null;
            const cards = packageCardsByPkg.get(group.pkgId) ?? [];
            return (
            <React.Fragment key={`pkg-group-${group.pkgId}`}>
              {groupIdx > 0 &&
                (() => {
                  const prev = packageGroupLayouts[groupIdx - 1];
                  if (!shouldDrawGroupConnector(prev.group.pkgId, group.pkgId, mountedPkgIds)) {
                    return null;
                  }
                  const sy = y + PACKAGE_GROUP_FRAME_H / 2;
                  const sx = prev.x + prev.width;
                  const ex = x;
                  const lead = Math.max(24, (ex - sx) * 0.5);
                  const d = `M ${sx} ${sy} C ${sx + lead} ${sy}, ${ex - lead} ${sy}, ${ex} ${sy}`;
                  return (
                    <path
                      d={d}
                      fill="none"
                      style={{ stroke: 'var(--cv-lav)' }}
                      strokeOpacity="0.55"
                      strokeWidth="1.4"
                      strokeDasharray="6 18"
                      strokeLinecap="round"
                      className="anim-pulse-flow cv-stream-glow"
                    />
                  );
                })()}
              <PackageGroupFrame
                pkgId={group.pkgId}
                name={pkgTitleOverrides[group.pkgId] ?? group.name}
                docCount={group.docs.length}
                stage={group.stage}
                x={x}
                y={y}
                width={width}
                titleAsOverlay
                selected={group.pkgId === focusedPkgId}
                onSelect={() => {
                  const first = group.docs[0];
                  if (first) onSelectFile(first.fileId);
                }}
              >
                {cards.map((doc) => {
                  const fileRec = fileById.get(doc.fileId);
                  const isSelectedRich = selectedRichDocFileId === doc.fileId;
                  const richDimmed = spotlightDim(doc.fileId);
                  const richCurrent = Boolean(doc.fileId && doc.fileId === spotlightCurrentFileId);
                  return (
                    <RichDocPreviewCard
                      key={doc.fileId}
                      title={doc.title}
                      versionLabel={doc.versionLabel}
                      lane={
                        doc.format === 'md' || doc.format === 'svg' || doc.format === 'pdf'
                          ? doc.format
                          : 'unknown'
                      }
                      conclusion={doc.conclusion}
                      bodyPreview={doc.bodyPreview}
                      diffSections={doc.diffSections as React.ComponentProps<typeof RichDocPreviewCard>['diffSections']}
                      svgThumbDataUri={doc.svgThumbDataUri}
                      selected={isSelectedRich}
                      dimmed={richDimmed}
                      spotlightCurrent={richCurrent}
                      onClick={() => {
                        setSelectedRichDocFileId(doc.fileId);
                        if (fileRec) {
                          onSelectFile(fileRec.file_id);
                          exploreAfterClick(fileRec.file_id);
                        }
                      }}
                      onDoubleClick={() => {
                        openNarrativeDrawer({ fileId: doc.fileId });
                      }}
                      onContextMenu={(e) => {
                        if (!fileRec || !systemActions?.onOpenFileContextMenu) return;
                        e.preventDefault();
                        e.stopPropagation();
                        systemActions.onOpenFileContextMenu(e, {
                          kind: 'file',
                          relativePath: fileRec.relative_path,
                          title: fileRec.title,
                          fileId: fileRec.file_id,
                          revisionId: fileRec.current_revision_id,
                        });
                      }}
                    />
                  );
                })}
              </PackageGroupFrame>
            </React.Fragment>
            );
          })}
    </>
  );
}
