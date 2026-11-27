
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import * as d3 from 'd3';
import {
  DecisionAssertion,
  DecisionSourceEvidence,
  EvidencePointer,
  FileRecord,
  ReadingState,
  RelationEdge,
  TimelineEvent,
} from '../../types/guanlan';
import {
  buildNodeHoverPreviewData,
  computeDynamicEdgePath,
  computeFanOutBounds,
  hasUnreadChanges,
} from '../../utils/guanlanEngine';
import { formatLocalClock, localDay } from '../../utils/timeFormat';
import { formatByteSize } from '../../utils/formatMeta';
import { effectiveMotionDurationMs } from '../../utils/keyboardShortcuts';
import {
  buildSpatialNavCards,
  useCanvasSpatialNav,
  type CanvasNavCard,
} from './useCanvasSpatialNav';
import {
  buildCardDescriptors,
  PACKAGE_GROUP_MAX_CARDS,
  visiblePackageGroupIds,
  lodGatesForTier,
  lodTierForScale,
} from '../../utils/canvasViewport';
import {
  getPackageTitleOverrides,
  setPackageTitleOverride,
  subscribePackageTitles,
} from '../../stores/packageTitleStore';
import {
  activeAccumulationSummary,
  buildCanvasEventScene,
  buildCanvasPackageGroups,
  compressEmptyRulerGaps,
  computeTrunkAccumulation,
  dedupeTicksByDate,
  deriveCanvasChangeSummary,
  fanOutDayHeaderLine,
  polishEventCardDigestLine,
  versionSpanCapsule,
  type CanvasEventCard,
  type CanvasEventScene,
} from '../../utils/graphEvents';
import type { EventDayGranularity, EventDaysResult } from '../../services/workspaceClient';
import type { StateOverviewResponse } from '../../services/apiTypes';
import { dayMergeLabel, extractCoreSummary, stageOfPath, taskPackageOf } from '../../utils/taskPackages';
import { indexStateOverview } from '../../utils/stateProjection';
import { PACKAGE_GROUP_FRAME_H } from '../canvas/PackageGroupFrame';
import { RICH_CARD_W } from '../canvas/RichDocPreviewCard';
import type { DesktopFileActionCallbacks } from '../FileContextMenu';
import type { CanvasTheme } from '../../utils/canvasThemeStore';
import { useGraphCanvasNarrative } from './graphCanvasNarrative';
import {
  CHRONOS_MASCOT_WIDTH,
  CHRONOS_TRUNK_DX,
  DATE_CARD_H,
  DATE_CARD_W,
  DEFAULT_NODE_POSITIONS,
  EVENT_CARD_H,
  EVENT_CARD_W,
  FIXED_TEXT_TRUNK_DX,
  FANOUT_HEADER_BUTTON_LEFT_GAP_W,
  milestoneY,
  eventMatchesRulerTick,
  sceneDateLabel,
  SOURCES_PANEL_COLLAPSED_LEFT,
  SOURCES_PANEL_SAFE_LEFT,
  PAN_TRANSITION_MS,
  TRUNK_AXIS_PAD,
  computeSafeTrunkEndY,
  dateCardRailX,
  fanOutHeaderCapsuleWidth,
  type CapabilityCode,
  type LeftSourceNodeModel,
  type NodePositionMap,
  type PanoramaMode,
  type SubAgentCardModel,
} from './geometry';
import type { ObstacleRect } from './edgeRouting';
import type { SpotlightChangeItem } from '../../utils/readingSpotlight';
import {
  chronosReplayIntervalMs,
  stepChronosReplayIndex,
  type ChronosReplaySpeed,
  type ChronosReplayUnit,
} from '../../utils/chronosDigest';

export interface GraphCanvasViewProps {
  files: FileRecord[];
  events: TimelineEvent[];
  decisions: DecisionAssertion[];
  relations: RelationEdge[];
  readingStates: Record<string, ReadingState>;
  selectedFileId: string;
  onSelectFile: (fileId: string, revisionId?: string) => void;
  onExploreFile: (fileId: string, revisionId?: string, eventId?: string) => void;
  onOpenReaderModal: (
    fileId: string,
    revisionId: string,
    mode: 'read' | 'diff_since_read' | 'relations'
  ) => void;
  onOpenDecisionModal: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
  onAddEvidencePointer: (pointer: EvidencePointer) => void;
  indexGeneration: number;
  eventDays?: EventDaysResult | null;
  activeDate?: string;
  onSelectDate?: (date: string | undefined) => void;
  onOpenDayInTimeline?: (date: string) => void;
  granularity?: EventDayGranularity;
  onGranularityChange?: (granularity: EventDayGranularity) => void;
  onDrillToBucket?: (bucketDate: string, bucketGranularity: EventDayGranularity) => void;
  selectedEventId?: string;
  onSelectEvent?: (eventId: string) => void;
  panoramaMode: PanoramaMode;
  onPanoramaModeChange: (mode: PanoramaMode) => void;
  onCanvasThemeChange?: (theme: CanvasTheme) => void;
  root?: string;
  visible?: boolean;
  stateOverview?: StateOverviewResponse | null;
  systemActions?: DesktopFileActionCallbacks;
  spotlight?: {
    enabled: boolean;
    items: SpotlightChangeItem[];
    dimmedFileIds: ReadonlySet<string>;
    cursor: number;
    onToggle: () => void;
    onCursor: (cursor: number) => void;
  };
  onOpenChronosDigest?: () => void;
  topBarSlot?: React.ReactNode;
}

export function useGraphCanvasController({
  files,
  events,
  decisions,
  relations,
  readingStates,
  selectedFileId,
  onSelectFile,
  onExploreFile,
  onOpenReaderModal,
  onOpenDecisionModal,
  onAddEvidencePointer,
  indexGeneration,
  eventDays = null,
  activeDate: activeDateProp,
  onSelectDate,
  onOpenDayInTimeline,
  granularity,
  onGranularityChange,
  onDrillToBucket,
  selectedEventId,
  onSelectEvent,
  panoramaMode,
  onPanoramaModeChange,
  onCanvasThemeChange,
  root = '',
  visible = true,
  stateOverview = null,
  systemActions,
  spotlight,
  onOpenChronosDigest,
  topBarSlot,
}: GraphCanvasViewProps) {
  const stateIndex = useMemo(() => indexStateOverview(stateOverview), [stateOverview]);
  const workspaceName = root.split(/[\\/]/).filter(Boolean).pop() || '观澜';
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string>('');
  const [hoveredCanvasNodeId, setHoveredCanvasNodeId] = useState<string | null>(null);
  const [hoveredPreviewAnchor, setHoveredPreviewAnchor] = useState<{
    fileId: string;
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  const [isFanOutCollapsed, setIsFanOutCollapsed] = useState(false);
  const [canvasLayoutMode, setCanvasLayoutMode] = useState<'xray' | 'force' | 'radial'>('xray');
  const [sourcesPanelCollapsed, setSourcesPanelCollapsed] = useState(true);
  const [narrativeDrawerOpen, setNarrativeDrawerOpen] = useState(false);
  const [narrativeTarget, setNarrativeTarget] = useState<{
    nodeId?: string;
    fileId?: string;
  } | null>(null);
  const [canvasTool, setCanvasTool] = useState<'pointer' | 'pan'>('pointer');
  const [versionView, setVersionView] = useState<'latest' | 'evolution'>('latest');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [chronosSliderOpen, setChronosSliderOpen] = useState(true);
  const [isTimeFlowPlaying, setIsTimeFlowPlaying] = useState(false);
  const [replayUnit, setReplayUnit] = useState<ChronosReplayUnit>('day');
  const [replaySpeed, setReplaySpeed] = useState<ChronosReplaySpeed>(1);
  const [selectedRichDocFileId, setSelectedRichDocFileId] = useState<string | null>(null);
  const [stageHeight, setStageHeight] = useState(0);
  const [localActiveDate, setLocalActiveDate] = useState<string | undefined>(undefined);
  const activeDate = activeDateProp !== undefined ? activeDateProp : localActiveDate;
  const selectDateInternal = (date: string | undefined, opts?: { keepPlaying?: boolean; pan?: boolean }) => {
    if (!opts?.keepPlaying) setIsTimeFlowPlaying(false);
    setLocalActiveDate(date);
    onSelectDate?.(date);
    if (date && opts?.pan !== false) panToDate(date);
  };
  const selectDate = (date: string | undefined) => selectDateInternal(date);
  useEffect(() => {
    if (activeDateProp === undefined && localActiveDate !== undefined) {
      setLocalActiveDate(undefined);
    }
  }, [activeDateProp]);

  const [activeTimeSlice, setActiveTimeSlice] = useState<'all' | '0:00' | '1:00' | '2:00'>('all');
  const [liveFlowEnabled, setLiveFlowEnabled] = useState<boolean>(true);
  const [meteorShowerEnabled, setMeteorShowerEnabled] = useState<boolean>(true);
  const [meteorBurstKey, setMeteorBurstKey] = useState<number>(0);
  const [xrayLaserEnabled, setXrayLaserEnabled] = useState<boolean>(true);
  const [showAllMdSources, setShowAllMdSources] = useState<boolean>(false);

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    MD: true,
    DEC: false,
    REV: false,
    SVG: false,
    TIM: false,
    PDF: false,
    REL: false,
  });
  const [hiddenCategories, setHiddenCategories] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomLayerRef = useRef<SVGGElement | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const minSafeUserXRef = useRef(0);

  const [zoomTransform, setZoomTransform] = useState<{ x: number; y: number; k: number }>({
    x: SOURCES_PANEL_COLLAPSED_LEFT,
    y: 48,
    k: 1,
  });
  const zoomExactRef = useRef<{ x: number; y: number; k: number }>({
    x: SOURCES_PANEL_COLLAPSED_LEFT,
    y: 48,
    k: 1,
  });
  const zoomFrameListenersRef = useRef<Set<(t: { x: number; y: number; k: number }) => void>>(
    new Set()
  );
  const zoomSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribeZoomFrame = useCallback(
    (listener: (t: { x: number; y: number; k: number }) => void) => {
      zoomFrameListenersRef.current.add(listener);
      return () => {
        zoomFrameListenersRef.current.delete(listener);
      };
    },
    []
  );
  const notifyZoomFrame = useCallback((t: { x: number; y: number; k: number }) => {
    zoomExactRef.current = t;
    for (const listener of zoomFrameListenersRef.current) {
      listener(t);
    }
  }, []);
  const commitZoomState = useCallback((t: { x: number; y: number; k: number }) => {
    setZoomTransform({
      x: Math.round(t.x),
      y: Math.round(t.y),
      k: Number(t.k.toFixed(2)),
    });
  }, []);
  const [nodePositions, setNodePositions] = useState<NodePositionMap>(() => ({
    ...DEFAULT_NODE_POSITIONS,
  }));
  const [activeDraggingNodeId, setActiveDraggingNodeId] = useState<string | null>(null);

  const revisionVersionById = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) {
      for (const rev of f.revisions) {
        if (typeof rev.versionNumber === 'number') map.set(rev.revision_id, rev.versionNumber);
      }
    }
    return map;
  }, [files]);

  const scene = useMemo(
    () =>
      buildCanvasEventScene(eventDays, {
        activeDate,
        maxCardsPerGroup: 6,
        resolveVersion: (revisionId) =>
          revisionId ? revisionVersionById.get(revisionId) ?? null : null,
      }),
    [eventDays, activeDate, revisionVersionById]
  );

  const trunkTicks = useMemo(
    () => compressEmptyRulerGaps(dedupeTicksByDate(scene.ruler)),
    [scene.ruler]
  );

  const trunkAccumulation = useMemo(
    () => computeTrunkAccumulation(trunkTicks),
    [trunkTicks]
  );
  const accumulationSummary = useMemo(
    () => activeAccumulationSummary(trunkTicks, trunkAccumulation, scene.activeDate),
    [trunkTicks, trunkAccumulation, scene.activeDate]
  );

  const chronologicalActiveDates = useMemo(() => {
    const dated = scene.days
      .map((d) => d.date)
      .filter((d) => Boolean(d));
    return [...dated].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }, [scene.days]);

  const mainHubPos = nodePositions.main_hub || DEFAULT_NODE_POSITIONS.main_hub;
  const trunkX = mainHubPos.x + 62;
  const trunkStartY = mainHubPos.y + 74;
  const trunkEndY = computeSafeTrunkEndY(stageHeight);
  const TRUNK_AXIS_TOP = trunkStartY + TRUNK_AXIS_PAD;
  const TRUNK_AXIS_BOTTOM = trunkEndY - TRUNK_AXIS_PAD;
  const chronosIdx = trunkTicks.findIndex((t) => t.date === scene.activeDate);
  const chronosPos = {
    x: trunkX + CHRONOS_TRUNK_DX,
    y:
      activeDraggingNodeId === 'chronos_deity'
        ? (nodePositions.chronos_deity?.y ?? DEFAULT_NODE_POSITIONS.chronos_deity.y)
        : trunkTicks.length > 0
          ? milestoneY(
              chronosIdx >= 0 ? chronosIdx : 0,
              trunkTicks.length,
              TRUNK_AXIS_TOP,
              TRUNK_AXIS_BOTTOM
            )
          : DEFAULT_NODE_POSITIONS.chronos_deity.y,
  };

  useEffect(() => {
    minSafeUserXRef.current = Math.max(0, trunkX + FIXED_TEXT_TRUNK_DX);
  }, [trunkX]);


  const rulerMaxCount = useMemo(
    () => trunkTicks.reduce((max, t) => Math.max(max, t.count), 0),
    [trunkTicks]
  );
  const rulerLabelStep = useMemo(() => {
    const n = trunkTicks.length;
    if (n <= 1) return 1;
    const span = Math.max(240, TRUNK_AXIS_BOTTOM - TRUNK_AXIS_TOP);
    const perDay = span / (n - 1);
    return [1, 2, 3, 5, 7, 10, 14, 30, 60, 90, 180, 365].find(
      (step) => step * perDay >= 30
    ) ?? 365;
  }, [trunkTicks, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM]);

  const fanOutHeaderLine =
    scene.hasRealEvents && scene.active
      ? `⑃ ${fanOutDayHeaderLine(scene.active.label, scene.active.count, scene.active.cards.length)}`
      : '⑃ 扇出 · 暂无事件卡片';
  const rulerGranularity: EventDayGranularity = granularity ?? scene.granularity ?? 'day';

  const navigatorDateSet = useMemo(
    () => new Set(scene.navigator.map((nav) => nav.date)),
    [scene.navigator]
  );

  const activeTickY = useMemo(() => {
    if (!scene.hasRealEvents || !scene.activeDate || trunkTicks.length === 0) return null;
    const idx = trunkTicks.findIndex((t) => t.date === scene.activeDate);
    if (idx < 0) return null;
    return milestoneY(idx, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM);
  }, [scene, trunkTicks, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM]);

  const springRevealKey = `${scene.activeDate ?? 'none'}|${isFanOutCollapsed ? 'c' : 'e'}|${canvasLayoutMode}`;

  const realEventCards: SubAgentCardModel[] | null = useMemo(() => {
    if (!scene.hasRealEvents || !scene.active) return null;
    return scene.active.cards.map((card: CanvasEventCard, cardIdx: number) => {
      const file = files.find((f) => f.file_id === card.fileId);
      let changeLabel = '';
      let versionSpan = '';
      if (card.mergedDay) {
        changeLabel = dayMergeLabel(card.mergedDay);
        versionSpan = versionSpanCapsule({ merged: card.mergedDay });
      } else if (card.revisionId && !card.decisionId && file) {
        const revIdx = file.revisions.findIndex((r) => r.revision_id === card.revisionId);
        if (revIdx >= 0) {
          const vn = file.revisions[revIdx].versionNumber;
          if (card.kind === 'modified') changeLabel = vn <= 1 ? 'v1' : `v${vn - 1} → v${vn}`;
          else if (card.kind === 'appeared') changeLabel = `新出现 v${vn}`;
          versionSpan = versionSpanCapsule({ kind: card.kind, version: vn });
        }
      }
      let changeSummary = '';
      let changeCounts: { added: number; removed: number } | null = null;
      let digestLine = '';
      if (card.kind === 'modified' && !card.mergedCount) {
        const ev = card.eventId ? events.find((e) => e.event_id === card.eventId) : undefined;
        const changedSections =
          ev?.changedSections ??
          file?.revisions.find((r) => r.revision_id === card.revisionId)?.changedSectionsFromPrev;
        const derived = deriveCanvasChangeSummary({
          changedSections,
          detail: ev?.detail,
          addedLines: ev?.addedLines,
          removedLines: ev?.removedLines,
        });
        changeSummary = derived.description;
        changeCounts = derived.counts;
        digestLine = polishEventCardDigestLine({
          changedSections,
          description: derived.description,
          format: card.format ?? file?.format ?? null,
          counts: derived.counts,
        });
      } else if (card.kind === 'appeared' && file && !card.mergedCount) {
        digestLine = extractCoreSummary(file);
      }
      const pkg = file ? taskPackageOf(file.relative_path) : null;
      const isBaselineCard = !card.fileId && (card.fileName === '-' || card.fileName === '—' || !card.fileName.trim());
      const resolvedFileName = isBaselineCard ? '工作区基线' : card.fileName;
      const normalizedSlotId = `sub_0${(cardIdx % 8) + 1}`;
      return {
        id: normalizedSlotId,
        fileId: card.fileId,
        decisionId: card.decisionId ?? undefined,
        eventId: card.eventId,
        revisionId: card.revisionId,
        fileName: resolvedFileName,
        dirPrefix: card.dirPrefix,
        changeLabel,
        versionSpan,
        pkgPath: pkg?.id === '__root__' ? '根目录' : (pkg?.id ?? ''),
        digestLine,
        kindLabel: isBaselineCard ? '' : card.kindLabel,
        packageName: pkg?.name,
        packageStage: file ? stageOfPath(file.relative_path) : undefined,
        cornerLabel: card.cornerLabel,
        observedClock: card.observedClock,
        detail: card.detail,
        changeSummary,
        changeCounts,
        format: card.format ?? 'md',
        formatNeutral: card.format == null,
        roleLabel: card.roleLabel,
        peakMetric: `${card.refs}`,
        peakSub: `${card.versions} 个版本 · ${card.statements} 条陈述`,
        secondaryMetric: card.decisionId ? '决策' : card.format ? card.format.toUpperCase() : '—',
        secondarySub: card.cornerLabel,
        activityStats: {
          mdChanges: card.refs,
          svgNodes: card.versions,
          pdfRefs: card.statements,
          decisionLinks: card.decisionId ? 1 : 0,
        },
        outputSummary: card.detail,
        timeRange: card.dateLabel,
        timeBucket: card.bucketDate,
      };
    });
  }, [scene, files, events]);

  const subAgentCards: SubAgentCardModel[] = realEventCards ?? [];

  const sourceFileNodes: LeftSourceNodeModel[] = useMemo(() => {
    const pick = (
      predicate: (f: FileRecord) => boolean
    ): { fileId: string; label: string; badge: CapabilityCode; roundLabel: string; meta: string } => {
      const file = files.find(predicate);
      if (!file) {
        return {
          fileId: '',
          label: '（未发现）',
          badge: 'MD',
          roundLabel: '—',
          meta: '—',
        };
      }
      const rel = file.relative_path.replace(/\\/g, '/');
      const fileName = rel.slice(rel.lastIndexOf('/') + 1);
      const dir = rel.slice(0, Math.max(0, rel.lastIndexOf('/') + 1));
      const shortLabel = `${dir}${fileName.length > 14 ? fileName.slice(0, 12) + '…' : fileName}`;
      const rev =
        file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
        file.revisions[file.revisions.length - 1];
      const sizeLabel = formatByteSize(rev?.sizeBytes || 0);
      const badge: CapabilityCode =
        file.format === 'svg' ? 'SVG' : file.format === 'pdf' ? 'PDF' : file.role === '决策' ? 'DEC' : 'MD';
      return {
        fileId: file.file_id,
        label: shortLabel,
        badge,
        roundLabel: `${file.role} · v${rev?.versionNumber || 1} · ${rev && rev.observed_at ? formatLocalClock(rev.observed_at) : '—'}`,
        meta: `${sizeLabel} · ${rel.split('/').length} 层`,
      };
    };

    const dec = pick((f) => f.format === 'md' && f.role === '决策');
    const svg = pick((f) => f.format === 'svg');
    const plan = pick((f) => f.format === 'md' && f.role === '方案');
    const req = pick((f) => f.format === 'md' && f.role === '需求');

    const badgeShort: Record<CapabilityCode, string> = {
      MD: 'I',
      DEC: 'R',
      REV: 'S',
      SVG: 'A',
      TIM: 'M',
      PDF: 'C',
      REL: 'H',
    };

    return [
      {
        id: 'src_round15',
        fileId: dec.fileId,
        badge: dec.badge,
        shortBadge: badgeShort[dec.badge],
        label: dec.label,
        tokOrMeta: dec.meta,
        roundLabel: dec.roundLabel,
        yOffset: 146,
        targetTrunkY: 174,
        timeBucket: '2:00',
      },
      {
        id: 'src_svg_engine',
        fileId: svg.fileId,
        badge: svg.badge,
        shortBadge: badgeShort[svg.badge],
        label: svg.label,
        tokOrMeta: svg.meta,
        roundLabel: svg.roundLabel,
        yOffset: 146,
        targetTrunkY: 174,
        timeBucket: '1:00',
      },
      {
        id: 'src_four_spec',
        fileId: plan.fileId,
        badge: plan.badge,
        shortBadge: badgeShort[plan.badge],
        label: plan.label,
        tokOrMeta: plan.meta,
        roundLabel: plan.roundLabel,
        yOffset: 214,
        targetTrunkY: 248,
        timeBucket: '2:00',
      },
      {
        id: 'src_receipt',
        fileId: req.fileId,
        badge: req.badge,
        shortBadge: badgeShort[req.badge],
        label: req.label,
        tokOrMeta: req.meta,
        roundLabel: req.roundLabel,
        yOffset: 432,
        targetTrunkY: 462,
        timeBucket: '1:00',
      },
    ];
  }, [files]);

  const leftSourceNodes: LeftSourceNodeModel[] = useMemo(() => {
    if (!scene.hasRealEvents || scene.navigator.length === 0) return sourceFileNodes;
    const short: Record<CapabilityCode, string> = {
      MD: 'I', DEC: 'R', REV: 'S', SVG: 'A', TIM: 'M', PDF: 'C', REL: 'H',
    };
    const ids = ['src_round15', 'src_svg_engine', 'src_four_spec', 'src_receipt'];
    const navAnchorYs = scene.navigator.map((nav) => {
      const idx = trunkTicks.findIndex((t) => t.date === nav.date);
      return idx >= 0
        ? milestoneY(idx, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM)
        : TRUNK_AXIS_BOTTOM + 18;
    });
    const navDefaultYs: number[] = [];
    scene.navigator.forEach((_, i) => {
      const y0 = navAnchorYs[i] - 24;
      navDefaultYs.push(i === 0 ? y0 : Math.max(y0, navDefaultYs[i - 1] + 56));
    });
    return scene.navigator.map((nav, i) => {
      const badge: CapabilityCode =
        nav.format === 'svg'
          ? 'SVG'
          : nav.format === 'pdf'
            ? 'PDF'
            : nav.format === 'md'
              ? 'MD'
              : 'TIM';
      const sortedFormats = Object.entries(nav.formats || {}).sort((a, b) => b[1] - a[1]);
      const formatSummary = sortedFormats
        .map(([f, c]) => `${f.toUpperCase()}×${c}`)
        .join(' · ');
      const topFormat = sortedFormats[0]?.[0]?.toUpperCase();
      const latestNavYear = scene.navigator[0]?.date?.slice(0, 4) ?? '';
      const compactNavLabel =
        /^\d{4}-\d{2}-\d{2}$/.test(nav.label) && latestNavYear && nav.label.startsWith(`${latestNavYear}-`)
          ? nav.label.slice(5)
          : nav.label;
      const accumEntry = trunkAccumulation.find((a) => a.date === nav.date);
      const grainLevel = accumEntry
        ? Math.max(1, Math.min(5, Math.round(accumEntry.strataIntensity * 5)))
        : Math.max(1, Math.min(5, Math.ceil(Math.log1p(nav.count))));
      return {
        id: ids[i] || `src_date_${i}`,
        fileId: '',
        date: nav.date,
        badge,
        shortBadge: short[badge],
        label: compactNavLabel,
        tokOrMeta: `${nav.count} 变动`,
        dominantFormat: topFormat,
        grainLevel,
        cumulativeEvents: accumEntry?.cumulativeEvents,
        fullMetaTooltip: `${nav.label} · ${nav.count} 条记录${
          accumEntry ? ` · 截至当日累计沉淀 ${accumEntry.cumulativeEvents} 条` : ''
        }${formatSummary ? ` · ${formatSummary}` : ''}`,
        roundLabel: nav.date ? `日期 ${nav.date}` : '日期待考',
        yOffset: navDefaultYs[i] ?? 0,
        targetTrunkY: navAnchorYs[i] ?? TRUNK_AXIS_BOTTOM + 18,
        timeBucket: nav.date,
      };
    });
  }, [scene, trunkTicks, trunkAccumulation, sourceFileNodes, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM]);

  const resolveLeftSourcePos = (
    src: LeftSourceNodeModel
  ): { x: number; y: number } => {
    const storedPos = nodePositions[src.id];
    const baseDefault = DEFAULT_NODE_POSITIONS[src.id];
    if (storedPos && storedPos !== baseDefault) return storedPos;
    if (src.date !== undefined && baseDefault) {
      return { x: dateCardRailX(trunkX), y: src.yOffset };
    }
    return storedPos || baseDefault;
  };

  useEffect(() => {
    const matched = subAgentCards.find((c) => c.fileId === selectedFileId);
    if (matched && selectedCanvasNodeId !== 'main_hub' && selectedCanvasNodeId !== 'chronos_deity') {
      setSelectedCanvasNodeId(matched.id);
    }
  }, [selectedFileId, subAgentCards, selectedCanvasNodeId]);

  useEffect(() => {
    if (subAgentCards.length === 0) {
      if (selectedCanvasNodeId !== '') setSelectedCanvasNodeId('');
      return;
    }
    if (
      selectedCanvasNodeId !== 'main_hub' &&
      selectedCanvasNodeId !== 'chronos_deity' &&
      !subAgentCards.some((c) => c.id === selectedCanvasNodeId)
    ) {
      setSelectedCanvasNodeId(subAgentCards[0].id);
    }
  }, [subAgentCards, selectedCanvasNodeId]);

  useEffect(() => {
    if (!visible) return;
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      setStageWidth(el.clientWidth);
      setStageHeight(el.clientHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  const zoomInitializedRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.45, 2.2])
      .constrain((t) => {
        const minX = SOURCES_PANEL_SAFE_LEFT - t.k * minSafeUserXRef.current;
        return t.x < minX ? new d3.ZoomTransform(t.k, minX, t.y) : t;
      })
      .filter((event: any) => {
        if (event.type === 'wheel') return true;
        if (canvasTool !== 'pan') return false;
        const target = event.target as HTMLElement | null;
        if (!target) return true;
        if (
          target.closest('.d3-draggable-node') ||
          target.closest('.d3-no-pan')
        ) {
          return false;
        }
        return !event.button;
      })
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        const { x, y, k } = event.transform;
        const zoomLayer = zoomLayerRef.current;
        if (zoomLayer) {
          zoomLayer.setAttribute('transform', `translate(${x}, ${y}) scale(${k})`);
        }
        notifyZoomFrame({ x, y, k });
        if (zoomSettleTimerRef.current !== null) {
          clearTimeout(zoomSettleTimerRef.current);
        }
        zoomSettleTimerRef.current = setTimeout(() => {
          zoomSettleTimerRef.current = null;
          commitZoomState(zoomExactRef.current);
        }, 180);
      })
      .on('end', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (zoomSettleTimerRef.current !== null) {
          clearTimeout(zoomSettleTimerRef.current);
          zoomSettleTimerRef.current = null;
        }
        const { x, y, k } = event.transform;
        notifyZoomFrame({ x, y, k });
        commitZoomState({ x, y, k });
      });

    zoomBehaviorRef.current = zoomBehavior;
    const svgSelection = d3.select(svgEl);
    svgSelection.call(zoomBehavior);
    if (!zoomInitializedRef.current) {
      zoomInitializedRef.current = true;
      svgSelection.call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(SOURCES_PANEL_COLLAPSED_LEFT, 48).scale(1)
      );
    } else {
      const exact = zoomExactRef.current;
      svgSelection.call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(exact.x, exact.y).scale(exact.k)
      );
    }

    return () => {
      svgSelection.on('.zoom', null);
      if (zoomSettleTimerRef.current !== null) {
        clearTimeout(zoomSettleTimerRef.current);
        zoomSettleTimerRef.current = null;
      }
    };
  }, [canvasTool, visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    const zoomLayer = zoomLayerRef.current;
    if (!zoomLayer) return;
    const exact = zoomExactRef.current;
    zoomLayer.setAttribute(
      'transform',
      `translate(${exact.x}, ${exact.y}) scale(${exact.k})`
    );
  }, [visible]);

  const [isViewSettingsOpen, setIsViewSettingsOpen] = useState(false);

  const [chronosDropSummary, setChronosDropSummary] = useState<{
    date: string;
    count: number;
    addedCount: number;
    modifiedCount: number;
    cumulativeEvents: number;
    headlines: string[];
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const chronosDropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissChronosDropSummary = () => {
    if (chronosDropTimerRef.current !== null) {
      clearTimeout(chronosDropTimerRef.current);
      chronosDropTimerRef.current = null;
    }
    setChronosDropSummary(null);
  };
  const chronosDropContextRef = useRef<{
    scene: CanvasEventScene;
    events: TimelineEvent[];
    eventDays: EventDaysResult | null;
    axisTop: number;
    axisBottom: number;
  }>({ scene, events, eventDays, axisTop: TRUNK_AXIS_TOP, axisBottom: TRUNK_AXIS_BOTTOM });
  useEffect(() => {
    chronosDropContextRef.current = {
      scene,
      events,
      eventDays,
      axisTop: TRUNK_AXIS_TOP,
      axisBottom: TRUNK_AXIS_BOTTOM,
    };
  });
  useEffect(
    () => () => {
      if (chronosDropTimerRef.current !== null) {
        clearTimeout(chronosDropTimerRef.current);
        chronosDropTimerRef.current = null;
      }
    },
    []
  );

  const showChronosDropSummary = (dragEvent: d3.D3DragEvent<SVGGElement, unknown, unknown>) => {
    const svgEl = svgRef.current;
    const rulerTicks = compressEmptyRulerGaps(
      dedupeTicksByDate(chronosDropContextRef.current.scene.ruler)
    );
    if (!svgEl || rulerTicks.length === 0) return;

    const [pointerX, pointerY] = d3.pointer(dragEvent.sourceEvent, svgEl);
    const transform = d3.zoomTransform(svgEl);
    const k = transform.k || 1;
    const pointerLocalX = (pointerX - transform.x) / k;
    const pointerLocalY = (pointerY - transform.y) / k;
    const { axisTop, axisBottom } = chronosDropContextRef.current;
    const total = rulerTicks.length;
    let nearestIdx = -1;
    let nearestDist = Number.POSITIVE_INFINITY;
    rulerTicks.forEach((tick, i) => {
      if (tick.isTruncation || tick.isGap || !tick.hasEvents) return;
      const dist = Math.abs(milestoneY(i, total, axisTop, axisBottom) - pointerLocalY);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    });
    const tick = rulerTicks[nearestIdx];
    if (!tick || tick.isTruncation || tick.isGap || !tick.hasEvents) return;

    selectDateInternal(tick.date, { pan: false });

    const accumRows = computeTrunkAccumulation(rulerTicks);
    const accumAtTick = accumRows[nearestIdx];

    const dropOrder = chronosDropContextRef.current.eventDays?.order ?? 'occurred';
    const tickEvents = chronosDropContextRef.current.events.filter((item) =>
      eventMatchesRulerTick(
        dropOrder === 'observed'
          ? localDay(item.observed_at || '')
          : item.source_time
            ? localDay(item.source_time)
            : '',
        tick
      )
    );
    const headlines = tickEvents.map((item) => item.headline).filter(Boolean);
    if (headlines.length === 0) {
      const dayGroup = chronosDropContextRef.current.eventDays?.groups.find(
        (g) => g.date === tick.date
      );
      for (const sample of dayGroup?.samples ?? []) {
        if (headlines.length >= 3) break;
        if (sample.headline) headlines.push(sample.headline);
      }
    }
    const text =
      headlines.slice(0, 3).join('；') +
      (headlines.length > 3 ? ` 等 ${headlines.length} 条` : '');

    if (chronosDropTimerRef.current !== null) clearTimeout(chronosDropTimerRef.current);
    chronosDropTimerRef.current = setTimeout(() => {
      setChronosDropSummary(null);
      chronosDropTimerRef.current = null;
    }, 8000);
    setChronosDropSummary({
      date: tick.date,
      count: tick.count,
      addedCount: accumAtTick?.addedCount ?? 0,
      modifiedCount: accumAtTick?.modifiedCount ?? 0,
      cumulativeEvents: accumAtTick?.cumulativeEvents ?? tick.count,
      headlines: headlines.slice(0, 3),
      text,
      x: pointerLocalX,
      y: pointerLocalY,
    });
  };

  const dragRafRef = useRef<number | null>(null);
  const dragDeltasRef = useRef<Map<string, { dx: number; dy: number }>>(new Map());
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const flushDragDeltas = () => {
      dragRafRef.current = null;
      const deltas = dragDeltasRef.current;
      if (deltas.size === 0) return;
      const batch = Array.from(deltas.entries());
      deltas.clear();
      setNodePositions((prev) => {
        const next = { ...prev };
        for (const [dragNodeId, delta] of batch) {
          if (dragNodeId === 'fan_out_box') {
            Object.keys(next).forEach((k) => {
              if (k.startsWith('sub_')) {
                next[k] = {
                  x: Math.round(next[k].x + delta.dx),
                  y: Math.round(next[k].y + delta.dy),
                };
              }
            });
          } else if (dragNodeId === 'chronos_deity') {
            const curr = next[dragNodeId] || { x: 0, y: 0 };
            next[dragNodeId] = {
              x: curr.x,
              y: Math.round(curr.y + delta.dy),
            };
          } else {
            const curr = next[dragNodeId] || { x: 0, y: 0 };
            next[dragNodeId] = {
              x: Math.round(curr.x + delta.dx),
              y: Math.round(curr.y + delta.dy),
            };
          }
        }
        return next;
      });
    };

    const dragBehavior = d3
      .drag<SVGGElement, unknown>()
      .on('start', function (event) {
        event.sourceEvent?.stopPropagation?.();
        const nodeId = this.getAttribute('data-node-id');
        if (nodeId) {
          setActiveDraggingNodeId(nodeId);
          setHoveredPreviewAnchor(null);
        }
      })
      .on('drag', function (event) {
        const nodeId = this.getAttribute('data-node-id');
        if (!nodeId) return;
        const deltas = dragDeltasRef.current;
        const pending = deltas.get(nodeId) || { dx: 0, dy: 0 };
        deltas.set(nodeId, { dx: pending.dx + event.dx, dy: pending.dy + event.dy });
        if (dragRafRef.current === null) {
          dragRafRef.current = requestAnimationFrame(flushDragDeltas);
        }
      })
      .on('end', function (event) {
        if (dragRafRef.current !== null) {
          cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = null;
        }
        flushDragDeltas();
        setActiveDraggingNodeId(null);
        if (this.getAttribute('data-node-id') === 'chronos_deity') {
          showChronosDropSummary(event);
        }
      });

    const nodeSelection = d3
      .select(svgEl)
      .selectAll<SVGGElement, unknown>('.d3-draggable-node');
    nodeSelection.call(dragBehavior);

    return () => {
      nodeSelection.on('.drag', null);
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      dragDeltasRef.current.clear();
    };
  }, [isFanOutCollapsed, hiddenCategories, canvasLayoutMode, chronosSliderOpen]);

  const handleToggleLayoutMode = (mode: 'xray' | 'force' | 'radial') => {
    setCanvasLayoutMode(mode);
    if (mode === 'xray') {
      setNodePositions({ ...DEFAULT_NODE_POSITIONS });
      return;
    }

    if (mode === 'radial') {
      const centerX = 435;
      const centerY = 330;
      const radialPositions: NodePositionMap = {
        main_hub: { x: centerX - 75, y: centerY - 38 },
        chronos_deity: { x: 96, y: 245 },
      };

      leftSourceNodes.forEach((s, idx) => {
        const angle = Math.PI * 0.68 + idx * (Math.PI * 0.22);
        radialPositions[s.id] = {
          x: Math.round(centerX + Math.cos(angle) * 215 - 60),
          y: Math.round(centerY + Math.sin(angle) * 215 - 25),
        };
      });

      subAgentCards.forEach((c, idx) => {
        const angle = -Math.PI * 0.52 + idx * ((Math.PI * 1.15) / 7);
        radialPositions[c.id] = {
          x: Math.round(centerX + Math.cos(angle) * 285 - 75),
          y: Math.round(centerY + Math.sin(angle) * 270 - 44),
        };
      });

      setNodePositions(radialPositions);
      return;
    }

    interface ForceSimNode extends d3.SimulationNodeDatum {
      id: string;
      x: number;
      y: number;
      fx?: number;
      fy?: number;
    }

    const simNodes: ForceSimNode[] = Object.entries(DEFAULT_NODE_POSITIONS).map(
      ([id, pos]) => ({
        id,
        x: pos.x,
        y: pos.y,
        ...(id === 'main_hub' ? { fx: 390, fy: 285 } : {}),
        ...(id === 'chronos_deity' ? { fx: 112, fy: 266 } : {}),
      })
    );

    const simLinks: d3.SimulationLinkDatum<ForceSimNode>[] = [
      ...leftSourceNodes.map((s) => ({ source: s.id, target: 'main_hub' })),
      ...subAgentCards.map((c) => ({ source: 'main_hub', target: c.id })),
      { source: 'chronos_deity', target: 'main_hub' },
      { source: 'sub_01', target: 'sub_02' },
      { source: 'sub_02', target: 'sub_03' },
      { source: 'sub_04', target: 'sub_01' },
      { source: 'sub_05', target: 'sub_02' },
    ];

    const sim = d3
      .forceSimulation<ForceSimNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink<ForceSimNode, d3.SimulationLinkDatum<ForceSimNode>>(simLinks)
          .id((d) => d.id)
          .distance(195)
          .strength(0.75)
      )
      .force('charge', d3.forceManyBody().strength(-720))
      .force('collide', d3.forceCollide().radius(108))
      .force('x', d3.forceX(395).strength(0.12))
      .force('y', d3.forceY(310).strength(0.14))
      .stop();

    for (let i = 0; i < 140; i += 1) {
      sim.tick();
    }

    const nextPositions: NodePositionMap = {};
    simNodes.forEach((n) => {
      nextPositions[n.id] = {
        x: Math.round(n.x),
        y: Math.round(n.y),
      };
    });
    setNodePositions(nextPositions);
  };

  const applyProgrammaticZoom = (
    nextScale: number,
    nextPan?: { x: number; y: number },
    durationMs = 260
  ) => {
    const svgEl = svgRef.current;
    const zoomB = zoomBehaviorRef.current;
    const clampedK = Math.min(2.2, Math.max(0.45, Number(nextScale.toFixed(2))));
    const live = zoomExactRef.current;
    const targetX = nextPan ? nextPan.x : live.x;
    const targetY = nextPan ? nextPan.y : live.y;
    const effectiveMs = effectiveMotionDurationMs(durationMs);

    if (svgEl && zoomB) {
      const targetTransform = d3.zoomIdentity.translate(targetX, targetY).scale(clampedK);
      if (effectiveMs <= 0) {
        d3.select(svgEl).call(zoomB.transform, targetTransform);
      } else {
        d3.select(svgEl)
          .transition()
          .duration(effectiveMs)
          .call(zoomB.transform, targetTransform);
      }
    } else {
      notifyZoomFrame({ x: targetX, y: targetY, k: clampedK });
      commitZoomState({ x: targetX, y: targetY, k: clampedK });
    }
  };

  const zoomByDelta = (delta: number) => {
    applyProgrammaticZoom(zoomExactRef.current.k + delta);
  };

  function panToDate(date: string) {
    const stageEl = stageRef.current;
    if (!stageEl || trunkTicks.length === 0 || stageWidth <= 0) return;
    const idx = trunkTicks.findIndex((t) => t.date === date);
    if (idx < 0) return;
    const stageH = stageEl.clientHeight;
    if (stageH <= 0) return;

    const tickY = milestoneY(idx, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM);
    const k = zoomExactRef.current.k || 1;
    const triptychLeft = dateCardRailX(trunkX);
    const triptychRight = Math.max(fanOutBounds.x + fanOutBounds.width, trunkX + 640);
    const triptychCx = (triptychLeft + triptychRight) / 2;
    const rawX = stageWidth / 2 - triptychCx * k;
    const usableH = Math.max(240, stageH - 72);
    const rawY = Math.min(48, Math.max(usableH - 740 * k, usableH * 0.42 - tickY * k));
    const safeLeft = sourcesPanelCollapsed
      ? SOURCES_PANEL_COLLAPSED_LEFT
      : SOURCES_PANEL_SAFE_LEFT;
    const minX = safeLeft - k * Math.max(0, triptychLeft - 12);
    applyProgrammaticZoom(
      k,
      { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
      PAN_TRANSITION_MS
    );
  }

  const handleResetCanvasLayout = () => {
    setNodePositions({ ...DEFAULT_NODE_POSITIONS });
    setCanvasLayoutMode('xray');
    setActiveTimeSlice('all');
    applyProgrammaticZoom(1, { x: SOURCES_PANEL_SAFE_LEFT, y: 48 });
  };

  const toggleSourcesPanel = () => {
    const next = !sourcesPanelCollapsed;
    setSourcesPanelCollapsed(next);
    const live = zoomExactRef.current;
    applyProgrammaticZoom(live.k, {
      x: next ? SOURCES_PANEL_COLLAPSED_LEFT : SOURCES_PANEL_SAFE_LEFT,
      y: live.y,
    });
  };

  const cycleChronosTimeSlice = () => {
    setMeteorBurstKey((k) => k + 1);
    if (scene.hasRealEvents && scene.days.length > 0) {
      const current = scene.activeDate;
      const idx = scene.days.findIndex((d) => d.date === current);
      const next = scene.days[(idx + 1) % scene.days.length];
      if (next) selectDate(next.date);
      return;
    }
    setActiveTimeSlice((prev) =>
      prev === 'all'
        ? '2:00'
        : prev === '2:00'
        ? '1:00'
        : prev === '1:00'
        ? '0:00'
        : 'all'
    );
  };

  const activeChronoIdx = chronologicalActiveDates.indexOf(scene.activeDate ?? '');
  const canStepOlder = chronologicalActiveDates.length > 1 && (activeChronoIdx < 0 || activeChronoIdx > 0);
  const canStepNewer =
    chronologicalActiveDates.length > 1 &&
    activeChronoIdx >= 0 &&
    activeChronoIdx < chronologicalActiveDates.length - 1;

  const stepChronosDay = (delta: -1 | 1) => {
    if (chronologicalActiveDates.length === 0) return;
    const baseIdx = activeChronoIdx >= 0 ? activeChronoIdx : chronologicalActiveDates.length - 1;
    const nextIdx = stepChronosReplayIndex(chronologicalActiveDates, baseIdx, delta, replayUnit);
    const target = chronologicalActiveDates[nextIdx];
    if (target && target !== scene.activeDate) {
      setMeteorBurstKey((k) => k + 1);
      selectDate(target);
    }
  };

  const toggleTimeFlowPlay = () => {
    if (chronologicalActiveDates.length <= 1) return;
    if (isTimeFlowPlaying) {
      setIsTimeFlowPlaying(false);
      return;
    }
    setChronosSliderOpen(true);
    const curIdx = chronologicalActiveDates.indexOf(scene.activeDate ?? '');
    const startIdx =
      curIdx >= 0 && curIdx < chronologicalActiveDates.length - 1 ? curIdx : 0;
    const startDate = chronologicalActiveDates[startIdx];
    setIsTimeFlowPlaying(true);
    if (startDate && startDate !== scene.activeDate) {
      setMeteorBurstKey((k) => k + 1);
      selectDateInternal(startDate, { keepPlaying: true, pan: !prefersReducedMotion });
    }
  };

  useEffect(() => {
    if (!isTimeFlowPlaying || !visible) return;
    if (chronologicalActiveDates.length <= 1) {
      setIsTimeFlowPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      const curIdx = chronologicalActiveDates.indexOf(scene.activeDate ?? '');
      const nextIdx = stepChronosReplayIndex(
        chronologicalActiveDates,
        curIdx >= 0 ? curIdx : 0,
        1,
        replayUnit
      );
      if (nextIdx < 0 || nextIdx === curIdx) {
        setIsTimeFlowPlaying(false);
        return;
      }
      const nextDate = chronologicalActiveDates[nextIdx];
      if (!nextDate) {
        setIsTimeFlowPlaying(false);
        return;
      }
      setMeteorBurstKey((k) => k + 1);
      selectDateInternal(nextDate, { keepPlaying: true, pan: !prefersReducedMotion });
    }, chronosReplayIntervalMs(replaySpeed, prefersReducedMotion));
    return () => clearTimeout(timer);
  }, [
    isTimeFlowPlaying,
    visible,
    scene.activeDate,
    chronologicalActiveDates,
    prefersReducedMotion,
    replayUnit,
    replaySpeed,
  ]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleCategoryVisibility = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    setHiddenCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const expandAllSidebar = () => {
    setExpandedGroups({
      MD: true,
      DEC: true,
      REV: true,
      SVG: true,
      TIM: true,
      PDF: true,
      REL: true,
    });
  };

  const collapseAllSidebar = () => {
    setExpandedGroups({
      MD: false,
      DEC: false,
      REV: false,
      SVG: false,
      TIM: false,
      PDF: false,
      REL: false,
    });
  };

  const activeSubAgent = useMemo<SubAgentCardModel | undefined>(() => {
    return subAgentCards.find((c) => c.id === selectedCanvasNodeId);
  }, [subAgentCards, selectedCanvasNodeId]);

  const activeFileRecord = useMemo(() => {
    if (selectedCanvasNodeId === 'main_hub') {
      return files[0] ?? null;
    }
    return (
      files.find((f) => f.file_id === activeSubAgent?.fileId) || files[0] || null
    );
  }, [files, selectedCanvasNodeId, activeSubAgent]);

  const unreadCount = useMemo(() => {
    return files.filter((f) => hasUnreadChanges(f, readingStates[f.file_id]).isUnread).length;
  }, [files, readingStates]);


  const mdFiles = useMemo(() => files.filter((f) => f.format === 'md'), [files]);
  const svgFiles = useMemo(() => files.filter((f) => f.format === 'svg'), [files]);
  const pdfFiles = useMemo(() => files.filter((f) => f.format === 'pdf'), [files]);

  const visibleMdFiles = useMemo(() => {
    return showAllMdSources ? mdFiles : mdFiles.slice(0, 4);
  }, [mdFiles, showAllMdSources]);

  const mdFindingsCount = useMemo(() => {
    return mdFiles.reduce(
      (sum, f) => sum + (f.revisions[f.revisions.length - 1]?.changedSectionsFromPrev?.length ?? 0),
      0
    );
  }, [mdFiles]);

  const fanOutBounds = useMemo(() => {
    const visibleCards = isFanOutCollapsed ? subAgentCards.slice(0, 2) : subAgentCards;
    const boxes = visibleCards.map((c) => {
      const pos = nodePositions[c.id] || DEFAULT_NODE_POSITIONS[c.id];
      return {
        x: pos.x,
        y: pos.y,
        width: EVENT_CARD_W,
        height: EVENT_CARD_H,
      };
    });
    const bounds = computeFanOutBounds(boxes, isFanOutCollapsed);
    const headerNeed =
      fanOutHeaderCapsuleWidth(fanOutHeaderLine, Number.POSITIVE_INFINITY) + 12 + 82 + 38;
    return { ...bounds, width: Math.max(bounds.width, headerNeed) };
  }, [subAgentCards, nodePositions, isFanOutCollapsed, fanOutHeaderLine]);

  const selectedCardPos = useMemo(() => {
    const sel = subAgentCards.find((c) => c.id === selectedCanvasNodeId);
    if (!sel) return null;
    return nodePositions[sel.id] || DEFAULT_NODE_POSITIONS[sel.id];
  }, [subAgentCards, selectedCanvasNodeId, nodePositions]);

  const initialFocusDoneRef = useRef(false);
  useEffect(() => {
    if (initialFocusDoneRef.current) return;
    if (stageWidth <= 0 || stageHeight <= 0) return;
    if (!scene.hasRealEvents || !scene.active) return;
    if (fanOutBounds.width <= 0 || fanOutBounds.height <= 0) return;
    initialFocusDoneRef.current = true;
    const k = 1;
    const triptychLeft = dateCardRailX(trunkX);
    const triptychRight = fanOutBounds.x + fanOutBounds.width;
    const cx = (triptychLeft + triptychRight) / 2;
    const cy = (TRUNK_AXIS_TOP + fanOutBounds.y + fanOutBounds.height) / 2 - 20;
    const rawX = stageWidth / 2 - cx * k;
    const usableH = Math.max(240, stageHeight - 96);
    const rawY = Math.max(24, Math.min(40, usableH / 2 - cy * k));
    const safeLeft = sourcesPanelCollapsed
      ? SOURCES_PANEL_COLLAPSED_LEFT
      : SOURCES_PANEL_SAFE_LEFT;
    const minX = safeLeft - k * Math.max(0, triptychLeft - 12);
    applyProgrammaticZoom(
      k,
      { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
      PAN_TRANSITION_MS
    );
  }, [stageWidth, stageHeight, scene.hasRealEvents, scene.active]);

  const fileById = useMemo(
    () => new Map(files.map((f) => [f.file_id, f])),
    [files]
  );

  const packageGroups = useMemo(
    () => (visible ? buildCanvasPackageGroups(files, events) : []),
    [visible, files, events]
  );

  const focusedPkgId = useMemo(() => {
    const targetId = selectedFileId || files[0]?.file_id || '';
    const target = fileById.get(targetId) ?? files[0];
    return target ? taskPackageOf(target.relative_path).id : '';
  }, [fileById, files, selectedFileId]);

  const orderedPackageGroups = useMemo(() => {
    if (!focusedPkgId) return packageGroups;
    const focused = packageGroups.filter((g) => g.pkgId === focusedPkgId);
    const rest = packageGroups.filter((g) => g.pkgId !== focusedPkgId);
    return [...focused, ...rest];
  }, [packageGroups, focusedPkgId]);

  const PACKAGE_GROUP_BAND_Y = 782;
  const PACKAGE_GROUP_GAP_X = 64;
  const packageGroupLayouts = useMemo(() => {
    let x = dateCardRailX(trunkX);
    return orderedPackageGroups.map((group) => {
      const shown = Math.min(group.docs.length, PACKAGE_GROUP_MAX_CARDS);
      const width = Math.max(
        160,
        14 * 2 + shown * RICH_CARD_W + Math.max(0, shown - 1) * 12
      );
      const layout = { group, x, y: PACKAGE_GROUP_BAND_Y, width, shown };
      x += width + PACKAGE_GROUP_GAP_X;
      return layout;
    });
  }, [orderedPackageGroups, trunkX]);

  const packageCardsByPkg = useMemo(
    () =>
      buildCardDescriptors(
        orderedPackageGroups.map((g) => ({
          pkgId: g.pkgId,
          shown: Math.min(g.docs.length, PACKAGE_GROUP_MAX_CARDS),
          docs: g.docs,
        })),
        { evolutionView: versionView === 'evolution' }
      ),
    [orderedPackageGroups, versionView]
  );

  const canvasWorldBounds = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const grow = (x: number, y: number, w: number, h: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    };
    for (const pos of Object.values(nodePositions)) grow(pos.x, pos.y, 160, 80);
    grow(trunkX, trunkStartY, 1, trunkEndY - trunkStartY);
    grow(fanOutBounds.x, fanOutBounds.y, fanOutBounds.width, fanOutBounds.height);
    for (const layout of packageGroupLayouts) {
      grow(layout.x, layout.y, layout.width, PACKAGE_GROUP_FRAME_H);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return { x: 0, y: 0, width: 1000, height: 900 };
    }
    const pad = 40;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }, [nodePositions, trunkX, trunkStartY, trunkEndY, fanOutBounds, packageGroupLayouts]);

  const graphObstacleRects = useMemo<ObstacleRect[]>(() => {
    const rects: ObstacleRect[] = [];
    rects.push({ id: 'main_hub', x: mainHubPos.x, y: mainHubPos.y, width: 150, height: 76 });
    if (chronosSliderOpen) {
      rects.push({
        id: 'chronos_deity',
        x: chronosPos.x,
        y: chronosPos.y,
        width: CHRONOS_MASCOT_WIDTH,
        height: 174,
      });
    }
    for (const src of leftSourceNodes) {
      const p = resolveLeftSourcePos(src);
      rects.push({ id: src.id, x: p.x, y: p.y, width: DATE_CARD_W, height: DATE_CARD_H });
    }
    const visibleCards =
      isFanOutCollapsed && canvasLayoutMode === 'xray' ? subAgentCards.slice(0, 2) : subAgentCards;
    for (const c of visibleCards) {
      const p = nodePositions[c.id] || DEFAULT_NODE_POSITIONS[c.id];
      rects.push({ id: c.id, x: p.x, y: p.y, width: EVENT_CARD_W, height: EVENT_CARD_H });
    }
    if (canvasLayoutMode === 'xray') {
      rects.push({
        id: 'fan_out_box',
        x: fanOutBounds.x,
        y: fanOutBounds.y,
        width: fanOutBounds.width,
        height: fanOutBounds.height,
      });
    }
    for (const layout of packageGroupLayouts) {
      rects.push({
        id: `pkg_${layout.group.pkgId}`,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: PACKAGE_GROUP_FRAME_H,
      });
    }
    return rects;
  }, [
    mainHubPos,
    chronosSliderOpen,
    chronosPos.x,
    chronosPos.y,
    leftSourceNodes,
    nodePositions,
    trunkX,
    isFanOutCollapsed,
    canvasLayoutMode,
    subAgentCards,
    fanOutBounds,
    packageGroupLayouts,
  ]);

  const minimapViewport = useMemo(() => {
    const k = zoomTransform.k || 1;
    return {
      x: -zoomTransform.x / k,
      y: -zoomTransform.y / k,
      width: stageWidth / k,
      height: stageHeight / k,
    };
  }, [zoomTransform, stageWidth, stageHeight]);

  const mountedPkgIds = useMemo(
    () =>
      visiblePackageGroupIds(
        packageGroupLayouts.map((l) => ({
          pkgId: l.group.pkgId,
          x: l.x,
          width: l.width,
        })),
        minimapViewport,
        { focusPkgId: focusedPkgId }
      ),
    [packageGroupLayouts, minimapViewport, focusedPkgId]
  );

  const handleMinimapJump = (x: number, y: number) => {
    const k = zoomExactRef.current.k || 1;
    const rawX = stageWidth / 2 - x * k;
    const rawY = stageHeight / 2 - y * k;
    const minX = SOURCES_PANEL_SAFE_LEFT - k * Math.max(0, trunkX + FIXED_TEXT_TRUNK_DX);
    applyProgrammaticZoom(
      k,
      { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
      PAN_TRANSITION_MS
    );
  };

  const lodTier = useMemo(() => lodTierForScale(zoomTransform.k), [zoomTransform.k]);
  const lodGates = useMemo(() => lodGatesForTier(lodTier), [lodTier]);

  const pkgTitleOverrides = useSyncExternalStore(
    subscribePackageTitles,
    getPackageTitleOverrides
  );
  const savePkgTitleOverride = useCallback((pkgId: string, name: string) => {
    setPackageTitleOverride(pkgId, name);
  }, []);

  const handleSelectNarrativeCitation = useCallback(
    (fileId: string) => {
      if (!fileId) return;
      const matchedSub = subAgentCards.find((c) => c.fileId === fileId);
      if (matchedSub) {
        setSelectedCanvasNodeId(matchedSub.id);
        setSelectedRichDocFileId(null);
        setNarrativeTarget({ nodeId: matchedSub.id, fileId });
      } else {
        setSelectedRichDocFileId(fileId);
        setNarrativeTarget({ fileId });
      }
      onSelectFile(fileId);
      setNarrativeDrawerOpen(true);
    },
    [subAgentCards, onSelectFile]
  );

  const { narrative, narrativeCopyFileId } = useGraphCanvasNarrative({
    narrativeTarget,
    subAgentCards,
    files,
    decisions,
    relations,
    scene,
    rulerGranularity,
    packageGroups,
    orderedPackageGroups,
    focusedPkgId,
    unreadCount,
    workspaceName,
    onOpenDecisionModal,
    onSelectCitation: handleSelectNarrativeCitation,
    activeFileRecord,
  });

  const d3RiverStrands = useMemo(() => {
    const lineGen = d3.line<[number, number]>().curve(d3.curveBasis);
    return {
      md:
        lineGen([
          [trunkX - 5, trunkStartY],
          [trunkX - 7, 260],
          [trunkX - 4, 480],
          [trunkX - 6, trunkEndY],
        ]) || '',
      svg:
        lineGen([
          [trunkX - 1, trunkStartY],
          [trunkX + 2, 270],
          [trunkX - 1, 490],
          [trunkX, trunkEndY],
        ]) || '',
      pdf:
        lineGen([
          [trunkX + 3, trunkStartY],
          [trunkX + 6, 280],
          [trunkX + 3, 500],
          [trunkX + 5, trunkEndY],
        ]) || '',
      unknown:
        lineGen([
          [trunkX + 7, trunkStartY],
          [trunkX + 9, 290],
          [trunkX + 6, 510],
          [trunkX + 8, trunkEndY],
        ]) || '',
    };
  }, [trunkX, trunkStartY, trunkEndY]);

  const accumulationRibbonPath = useMemo(() => {
    if (!scene.hasRealEvents || trunkTicks.length < 2 || trunkAccumulation.length !== trunkTicks.length) {
      return '';
    }
    const pts: Array<{ y: number; halfW: number }> = trunkTicks.map((_, i) => ({
      y: milestoneY(i, trunkTicks.length, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM),
      halfW: 6 + 18 * (trunkAccumulation[i]?.accumulationRatio ?? 0.2),
    }));
    const areaGen = d3
      .area<{ y: number; halfW: number }>()
      .y((d) => d.y)
      .x0((d) => trunkX - d.halfW)
      .x1((d) => trunkX + d.halfW)
      .curve(d3.curveCatmullRom.alpha(0.5));
    return areaGen(pts) || '';
  }, [scene.hasRealEvents, trunkTicks, trunkAccumulation, trunkX, TRUNK_AXIS_TOP, TRUNK_AXIS_BOTTOM]);

  const chronosConduits = useMemo(() => {
    const lineGen = d3.line<[number, number]>().curve(d3.curveBasis);
    const staffGemX = chronosPos.x + 38;
    const staffGemY = chronosPos.y + 30;
    const hourglassX = chronosPos.x + 102;
    const hourglassY = chronosPos.y + 46;
    const riverTargetY = activeTickY ?? TRUNK_AXIS_TOP;

    const activeLeftSrc = leftSourceNodes.find(
      (s) => s.date !== undefined && s.date === scene.activeDate
    );
    const activeLeftPos = activeLeftSrc ? resolveLeftSourcePos(activeLeftSrc) : null;
    const staffTargetX = activeLeftPos
      ? activeLeftPos.x + DATE_CARD_W - 2
      : dateCardRailX(trunkX) + DATE_CARD_W - 2;
    const staffTargetY = activeLeftPos ? activeLeftPos.y + DATE_CARD_H / 2 : riverTargetY;

    return {
      staffToTimeline:
        lineGen([
          [staffGemX, staffGemY],
          [(staffGemX + staffTargetX) / 2, (staffGemY + staffTargetY) / 2 - 12],
          [staffTargetX, staffTargetY],
        ]) || '',
      hourglassToRiver:
        lineGen([
          [hourglassX, hourglassY],
          [(hourglassX + trunkX) / 2 + 4, (hourglassY + riverTargetY) / 2 - 8],
          [trunkX - 5, riverTargetY],
        ]) || '',
    };
  }, [chronosPos.x, chronosPos.y, trunkX, activeTickY, TRUNK_AXIS_TOP, leftSourceNodes, scene.activeDate, nodePositions]);

  const hoverPreviewData = useMemo(() => {
    if (!hoveredPreviewAnchor || activeDraggingNodeId) return null;
    const targetFile = files.find((f) => f.file_id === hoveredPreviewAnchor.fileId);
    if (!targetFile) return null;
    return buildNodeHoverPreviewData(targetFile, readingStates[targetFile.file_id]);
  }, [hoveredPreviewAnchor, activeDraggingNodeId, files, readingStates]);

  const handleNodeMouseEnter = (fileId: string, nodeId: string) => {
    if (activeDraggingNodeId) return;
    setHoveredCanvasNodeId(nodeId);
    const pos =
      nodeId === 'chronos_deity'
        ? chronosPos
        : nodePositions[nodeId] || { x: 350, y: 200 };
    setHoveredPreviewAnchor({
      fileId,
      nodeId,
      x: pos.x,
      y: pos.y,
    });
  };

  const handleNodeMouseLeave = () => {
    setHoveredCanvasNodeId(null);
    setHoveredPreviewAnchor(null);
  };

  const openFileReader = (
    fileId: string,
    mode: 'read' | 'diff_since_read' | 'relations' = 'read',
    revisionId?: string
  ) => {
    const f = files.find((item) => item.file_id === fileId) || files[0];
    if (!f) return;
    onOpenReaderModal(f.file_id, revisionId || f.current_revision_id, mode);
  };

  const pendingExplore = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelExplore = () => {
    if (pendingExplore.current !== null) clearTimeout(pendingExplore.current);
    pendingExplore.current = null;
  };
  useEffect(() => () => cancelExplore(), []);
  const exploreAfterClick = (fileId: string, revisionId?: string, eventId?: string) => {
    cancelExplore();
    pendingExplore.current = setTimeout(() => onExploreFile(fileId, revisionId, eventId), 240);
  };
  const openNarrativeDrawer = (target?: { nodeId?: string; fileId?: string }) => {
    cancelExplore();
    if (target && (target.nodeId || target.fileId)) {
      setNarrativeTarget(target);
      if (target.nodeId) {
        setSelectedCanvasNodeId(target.nodeId);
        setSelectedRichDocFileId(null);
      } else if (target.fileId) {
        const matchedSub = subAgentCards.find((c) => c.fileId === target.fileId);
        if (matchedSub) {
          setSelectedCanvasNodeId(matchedSub.id);
          setSelectedRichDocFileId(null);
        } else {
          setSelectedRichDocFileId(target.fileId);
        }
      }
      if (target.fileId) {
        onSelectFile(target.fileId);
      }
    } else {
      const sub = subAgentCards.find((c) => c.id === selectedCanvasNodeId);
      setNarrativeTarget(
        sub
          ? { nodeId: sub.id, fileId: sub.fileId || undefined }
          : selectedRichDocFileId
            ? { fileId: selectedRichDocFileId }
            : {}
      );
    }
    setNarrativeDrawerOpen(true);
  };
  const closeNarrativeDrawer = () => setNarrativeDrawerOpen(false);

  useEffect(() => {
    if (!narrativeDrawerOpen) return;
    if (selectedRichDocFileId) {
      setNarrativeTarget((prev) =>
        prev?.fileId === selectedRichDocFileId && !prev.nodeId
          ? prev
          : { fileId: selectedRichDocFileId }
      );
      return;
    }
    if (selectedCanvasNodeId === 'main_hub') {
      setNarrativeTarget((prev) =>
        prev && !prev.nodeId && !prev.fileId ? prev : {}
      );
      return;
    }
    const sub = subAgentCards.find((c) => c.id === selectedCanvasNodeId);
    if (sub) {
      setNarrativeTarget((prev) =>
        prev?.nodeId === sub.id && prev?.fileId === (sub.fileId || undefined)
          ? prev
          : { nodeId: sub.id, fileId: sub.fileId || undefined }
      );
    }
  }, [narrativeDrawerOpen, selectedCanvasNodeId, selectedRichDocFileId, subAgentCards]);

  const handleCopyInspectorPointer = (fileId: string, note: string) => {
    const f = files.find((item) => item.file_id === fileId) || files[0];
    if (!f) return;
    const currentRev =
      f.revisions.find((r) => r.revision_id === f.current_revision_id) ||
      f.revisions[f.revisions.length - 1];
    onAddEvidencePointer({
      file_id: f.file_id,
      revision_id: currentRev.revision_id,
      relative_path: f.relative_path,
      content_sha256: currentRev.content_sha256,
      locator: { kind: 'lines', start: 1, end: 32 },
      evidence_kind: 'explicit_source',
      index_generation: indexGeneration,
      observed_at: currentRev.observed_at,
      coverage: f.coverage,
      stale: false,
      excerpt: currentRev.summaryNote,
      note,
    });
    setCopiedId(fileId);
    setTimeout(() => setCopiedId(null), 1600);
  };

  const isNodeVisibleByCategory = (format: string) => {
    const key = format.toUpperCase();
    return !hiddenCategories[key];
  };

  const isNodeInActiveTimeSlice = (bucket: string) => {
    if (versionView === 'evolution') return true;
    if (scene.hasRealEvents) {
      if (activeDate === undefined) return true;
      if (activeDate === '') return bucket === '日期待考' || bucket === '';
      return bucket === activeDate;
    }
    if (activeTimeSlice === 'all') return true;
    return activeTimeSlice === bucket;
  };

  const spatialNavCards = useMemo<CanvasNavCard[]>(() => {
    if (!visible) return [];
    const leftWithPos = leftSourceNodes
      .filter((src) => Boolean(src.fileId))
      .map((src) => {
        const p = resolveLeftSourcePos(src);
        return { id: src.id, fileId: src.fileId, x: p.x, y: p.y };
      });
    const pkgLayouts = packageGroupLayouts.map((layout) => ({
      pkgId: layout.group.pkgId,
      x: layout.x,
      y: layout.y,
      docs: packageCardsByPkg.get(layout.group.pkgId) ?? [],
    }));
    return buildSpatialNavCards({
      subAgentCards,
      isFanOutCollapsed,
      canvasLayoutMode,
      nodePositions,
      defaultPositions: DEFAULT_NODE_POSITIONS,
      leftSourceNodes: leftWithPos,
      packageLayouts: pkgLayouts,
    });
  }, [
    visible,
    subAgentCards,
    isFanOutCollapsed,
    canvasLayoutMode,
    nodePositions,
    leftSourceNodes,
    trunkX,
    packageGroupLayouts,
    packageCardsByPkg,
  ]);

  useCanvasSpatialNav({
    enabled: visible,
    relations,
    cards: spatialNavCards,
    selectedNodeId: selectedCanvasNodeId,
    selectedRichDocFileId,
    selectedFileId,
    onSelectCard: (card) => {
      if (card.hiddenInFold) {
        setIsFanOutCollapsed(false);
      }
      if (card.kind === 'rich') {
        setSelectedRichDocFileId(card.fileId);
        onSelectFile(card.fileId);
      } else {
        setSelectedCanvasNodeId(card.id);
        setSelectedRichDocFileId(null);
        onSelectFile(card.fileId, card.revisionId);
      }
    },
    centerOn: (card, durationMs) => {
      const stageEl = stageRef.current;
      const stageH = stageEl?.clientHeight ?? 0;
      if (stageWidth <= 0 || stageH <= 0) return;
      const k = zoomExactRef.current.k || 1;
      const rawX = stageWidth * 0.5 - card.x * k;
      const rawY = stageH * 0.45 - card.y * k;
      const safeLeft = sourcesPanelCollapsed
        ? SOURCES_PANEL_COLLAPSED_LEFT
        : SOURCES_PANEL_SAFE_LEFT;
      const minX = safeLeft - k * Math.max(0, trunkX + FIXED_TEXT_TRUNK_DX);
      applyProgrammaticZoom(
        k,
        { x: Math.round(Math.max(minX, rawX)), y: Math.round(rawY) },
        durationMs
      );
    },
  });

  return {
    visible,
    files,
    events,
    decisions,
    relations,
    readingStates,
    selectedFileId,
    onSelectFile,
    onExploreFile,
    onOpenDecisionModal,
    onOpenDayInTimeline,
    onGranularityChange,
    onDrillToBucket,
    onSelectEvent,
    panoramaMode,
    onPanoramaModeChange,
    onCanvasThemeChange,
    workspaceName,
    stateIndex,
    systemActions,
    selectedCanvasNodeId,
    setSelectedCanvasNodeId,
    hoveredCanvasNodeId,
    setHoveredCanvasNodeId,
    hoveredPreviewAnchor,
    isFanOutCollapsed,
    setIsFanOutCollapsed,
    canvasLayoutMode,
    sourcesPanelCollapsed,
    narrativeDrawerOpen,
    canvasTool,
    setCanvasTool,
    versionView,
    setVersionView,
    showShortcuts,
    setShowShortcuts,
    legendOpen,
    setLegendOpen,
    chronosSliderOpen,
    setChronosSliderOpen,
    isTimeFlowPlaying,
    toggleTimeFlowPlay,
    stepChronosDay,
    canStepOlder,
    canStepNewer,
    replayUnit,
    setReplayUnit,
    replaySpeed,
    setReplaySpeed,
    onOpenChronosDigest,
    topBarSlot,
    selectedRichDocFileId,
    setSelectedRichDocFileId,
    isViewSettingsOpen,
    setIsViewSettingsOpen,
    chronosDropSummary,
    dismissChronosDropSummary,
    activeDraggingNodeId,
    stageWidth,
    stageHeight,
    activeDate,
    selectDate,
    activeTimeSlice,
    setActiveTimeSlice,
    liveFlowEnabled,
    setLiveFlowEnabled,
    meteorShowerEnabled,
    setMeteorShowerEnabled,
    meteorBurstKey,
    setMeteorBurstKey,
    xrayLaserEnabled,
    setXrayLaserEnabled,
    showAllMdSources,
    setShowAllMdSources,
    expandedGroups,
    hiddenCategories,
    copiedId,
    prefersReducedMotion,
    zoomTransform,
    nodePositions,
    mdFiles,
    svgFiles,
    pdfFiles,
    visibleMdFiles,
    mdFindingsCount,
    unreadCount,
    scene,
    trunkTicks,
    trunkAccumulation,
    accumulationSummary,
    accumulationRibbonPath,
    graphObstacleRects,
    mainHubPos,
    trunkX,
    trunkStartY,
    trunkEndY,
    TRUNK_AXIS_TOP,
    TRUNK_AXIS_BOTTOM,
    chronosPos,
    rulerMaxCount,
    rulerLabelStep,
    fanOutHeaderLine,
    rulerGranularity,
    navigatorDateSet,
    activeTickY,
    springRevealKey,
    subAgentCards,
    leftSourceNodes,
    resolveLeftSourcePos,
    activeSubAgent,
    activeFileRecord,
    fanOutBounds,
    selectedCardPos,
    packageGroups,
    focusedPkgId,
    fileById,
    orderedPackageGroups,
    packageGroupLayouts,
    packageCardsByPkg,
    canvasWorldBounds,
    minimapViewport,
    mountedPkgIds,
    lodTier,
    lodGates,
    pkgTitleOverrides,
    savePkgTitleOverride,
    narrative,
    narrativeCopyFileId,
    d3RiverStrands,
    chronosConduits,
    hoverPreviewData,
    svgRef,
    zoomLayerRef,
    zoomExactRef,
    subscribeZoomFrame,
    stageRef,
    handleToggleLayoutMode,
    applyProgrammaticZoom,
    zoomByDelta,
    panToDate,
    handleResetCanvasLayout,
    toggleSourcesPanel,
    cycleChronosTimeSlice,
    toggleGroup,
    toggleCategoryVisibility,
    expandAllSidebar,
    collapseAllSidebar,
    handleMinimapJump,
    handleNodeMouseEnter,
    handleNodeMouseLeave,
    openFileReader,
    exploreAfterClick,
    cancelExplore,
    openNarrativeDrawer,
    closeNarrativeDrawer,
    handleCopyInspectorPointer,
    isNodeVisibleByCategory,
    isNodeInActiveTimeSlice,
    spotlight,
  };
}

/** 层组件消费的控制器上下文（类型随控制器自动演化，零手工镜像）。 */
export type GraphCanvasCtx = ReturnType<typeof useGraphCanvasController>;
