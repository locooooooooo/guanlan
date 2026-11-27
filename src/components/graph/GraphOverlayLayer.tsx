
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BookMarked,
  BookOpen,
  ClipboardCheck,
  Clock,
  Copy,
  ExternalLink,
  FolderSearch,
  Scale,
  X,
} from 'lucide-react';
import CanvasMiniMap from '../canvas/CanvasMiniMap';
import CanvasNarrativeDrawer from '../canvas/CanvasNarrativeDrawer';
import { LANE_COLORS } from './geometry';
import type { GraphCanvasCtx } from './useGraphCanvasController';


/** 任务包标题 Overlay（挂在 stage 内，绝对定位；单点=选中分组、双击=原位改名） */
export function GraphPackageTitleOverlay({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    packageGroupLayouts,
    mountedPkgIds,
    zoomTransform,
    zoomExactRef,
    subscribeZoomFrame,
    pkgTitleOverrides,
    savePkgTitleOverride,
    onSelectFile,
  } = ctx;
  const [editingPkgId, setEditingPkgId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (editingPkgId) inputRef.current?.select();
  }, [editingPkgId]);

  const mountedLayouts = packageGroupLayouts.filter(({ group }) => mountedPkgIds.has(group.pkgId));

  useLayoutEffect(() => {
    const syncDom = (t: { x: number; y: number; k: number }) => {
      const k = t.k || 1;
      for (const { group, x, y, width } of mountedLayouts) {
        const el = itemRefs.current.get(group.pkgId);
        if (!el) continue;
        const bandWorld = Math.max(40, width - 28 - 8 - 8 - 8);
        el.style.left = `${t.x + (x + 14 + 8 + 8) * k}px`;
        el.style.top = `${t.y + (y + 22) * k}px`;
        el.style.maxWidth = `${Math.max(40, bandWorld * k)}px`;
      }
    };
    syncDom(zoomExactRef?.current ?? zoomTransform);
    return subscribeZoomFrame ? subscribeZoomFrame(syncDom) : undefined;
  }, [mountedLayouts, subscribeZoomFrame, zoomExactRef, zoomTransform]);

  const liveT = zoomExactRef?.current ?? zoomTransform;
  const k = liveT.k || 1;
  return (
    <>
      {mountedLayouts.map(({ group, x, y, width }) => {
        const rawName = group.name;
        const displayName = pkgTitleOverrides[group.pkgId] ?? rawName;
        const bandWorld = Math.max(40, width - 28 - 8 - 8 - 8);
        const screenLeft = liveT.x + (x + 14 + 8 + 8) * k;
        const screenCenterY = liveT.y + (y + 22) * k;
        const maxScreenWidth = Math.max(40, bandWorld * k);
        const isEditing = editingPkgId === group.pkgId;
        return (
          <div
            key={`pkg-title-${group.pkgId}`}
            ref={(el) => {
              if (el) itemRefs.current.set(group.pkgId, el);
              else itemRefs.current.delete(group.pkgId);
            }}
            data-cv-package-title-overlay={group.pkgId}
            style={{
              position: 'absolute',
              left: screenLeft,
              top: screenCenterY,
              transform: 'translateY(-50%)',
              maxWidth: maxScreenWidth,
              width: isEditing ? Math.min(240, maxScreenWidth) : undefined,
              height: 18,
              zIndex: 15,
              pointerEvents: 'auto',
            }}
            className="d3-no-pan inline-flex items-center gap-2 min-w-0 cursor-pointer group/pkgt"
            onClick={() => {
              const first = group.docs[0];
              if (first) onSelectFile(first.fileId);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(displayName);
              setEditingPkgId(group.pkgId);
            }}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => {
                  savePkgTitleOverride(group.pkgId, draft);
                  setEditingPkgId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    savePkgTitleOverride(group.pkgId, draft);
                    setEditingPkgId(null);
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    setEditingPkgId(null);
                  }
                }}
                title={`${rawName} · 回车确认（Esc 取消；仅固化画布显示名，目录名不动）`}
                className="min-w-0 flex-1 rounded-[4px] border border-[color:color-mix(in_srgb,var(--cv-lav)_45%,transparent)] bg-[color:var(--cv-card)] px-1 py-px text-[12px] font-semibold text-[color:var(--cv-ink)] outline-none"
              />
            ) : (
              <span
                title={`${rawName} · 双击改名（仅固化画布显示名，目录名不动）`}
                className="min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-[12px] font-semibold leading-[16px] text-[color:var(--cv-ink)]"
              >
                {displayName}
              </span>
            )}
            <span className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-[color:var(--cv-ink-dim)]">
              {group.docs.length} 份
            </span>
          </div>
        );
      })}
    </>
  );
}

/** 泳道图例：点击底部药丸「图例?」展开的气泡（保留 data-testid="trunk-lane-legend" 锚点）；
 *  四枚色点+中文名与四根泳道一一对应（色值取 LANE_COLORS 令牌引用，随主题自动换档） */
export function GraphLaneLegend({ ctx }: { ctx: GraphCanvasCtx }) {
  const { legendOpen, narrativeDrawerOpen } = ctx;
  if (!legendOpen) return null;
  return (
    <div
      data-testid="trunk-lane-legend"
      style={{ left: narrativeDrawerOpen ? 'calc(50% - 170px)' : '50%' }}
      className="d3-no-pan cvw-shortcut-pop absolute bottom-16 -translate-x-1/2 z-30 min-w-[240px] transition-[left] duration-300"
    >
      <div className="cvw-shortcut-title">泳道图例 · 色点与文件类型对应</div>
      {(
        [
          { key: 'md', label: '方案/规则 MD' },
          { key: 'svg', label: '图纸 SVG' },
          { key: 'pdf', label: 'PDF 规范' },
          { key: 'unknown', label: '未判定（决策/待考）' },
        ] as const
      ).map((item) => (
        <span
          key={item.key}
          className="flex items-center gap-2 whitespace-nowrap py-0.5 text-[11px] font-mono text-[color:var(--cv-ink-2)]"
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: LANE_COLORS[item.key] }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** 叙事抽屉「直流电流」连线已退役：
 *  旧版自选中卡拉出 5px 发光虚线横穿画布直指右缘抽屉，既会斜切遮挡相邻卡片正文、
 *  又把空间画布节点与 HUD 侧栏强行连线破坏层级隐喻。画布现通过 1:1 同步的高亮聚焦框
 *  与抽屉标题锚定同一对象，本组件保留导出以维持装配签名稳定并返回 null。 */
export function GraphNarrativeLinkOverlay({ ctx: _ctx }: { ctx: GraphCanvasCtx }) {
  return null;
}

function clampStageFloatingPos(params: {
  worldX: number;
  worldY: number;
  zoomTransform: { x: number; y: number; k: number };
  offsetX: number;
  offsetY: number;
  minLeft: number;
  cardWidth: number;
  cardHeight: number;
  stageWidth: number;
  stageHeight: number;
  narrativeDrawerOpen: boolean;
}): { left: number; top: number } {
  const {
    worldX,
    worldY,
    zoomTransform,
    offsetX,
    offsetY,
    minLeft,
    cardWidth,
    cardHeight,
    stageWidth,
    stageHeight,
    narrativeDrawerOpen,
  } = params;
  const effectiveWidth = stageWidth > 0 ? stageWidth : 1080;
  const effectiveHeight = stageHeight > 0 ? stageHeight : 680;
  const drawerReserve = narrativeDrawerOpen ? 368 : 24;
  const maxLeft = Math.max(minLeft, effectiveWidth - cardWidth - drawerReserve);
  const maxTop = Math.max(18, effectiveHeight - cardHeight - 76);
  const screenX = worldX * zoomTransform.k + zoomTransform.x + offsetX;
  const screenY = worldY * zoomTransform.k + zoomTransform.y + offsetY;
  return {
    left: Math.round(Math.min(Math.max(minLeft, screenX), maxLeft)),
    top: Math.round(Math.min(Math.max(18, screenY), maxTop)),
  };
}

/** ④ 司辰时间机器摘要气泡：拖到有事件刻度松手弹出（8s 自动清除，支持关闭与直达手记） */
export function GraphChronosDropBubble({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    chronosDropSummary,
    dismissChronosDropSummary,
    onOpenChronosDigest,
    zoomTransform,
    selectDate,
    stageWidth,
    stageHeight,
    narrativeDrawerOpen,
  } = ctx;
  if (!chronosDropSummary) return null;
  const pos = clampStageFloatingPos({
    worldX: chronosDropSummary.x,
    worldY: chronosDropSummary.y,
    zoomTransform,
    offsetX: 24,
    offsetY: 12,
    minLeft: 150,
    cardWidth: 320,
    cardHeight: 170,
    stageWidth,
    stageHeight,
    narrativeDrawerOpen,
  });
  const headlines =
    chronosDropSummary.headlines && chronosDropSummary.headlines.length > 0
      ? chronosDropSummary.headlines
      : chronosDropSummary.text
        ? [chronosDropSummary.text]
        : [];
  return (
    <div
      role="status"
      data-testid="chronos-drop-summary-bubble"
      data-chronos-carrier="drop-bubble"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      onClick={() => selectDate(chronosDropSummary.date)}
      className="d3-no-pan glx-popover-in absolute z-30 w-[320px] max-w-[calc(100%-32px)] rounded-xl bg-[color:color-mix(in_srgb,var(--cv-card)_98%,transparent)] backdrop-blur-xl border border-[color:color-mix(in_srgb,var(--cv-brand)_40%,transparent)] p-3 text-xs text-[color:var(--cv-ink-2)] cursor-pointer shadow-[0_16px_40px_color-mix(in_srgb,var(--cv-shadow-ink)_80%,transparent)]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--cv-brand)] shrink-0" aria-hidden="true" />
          <span className="font-mono text-[11px] font-semibold text-[color:var(--cv-brand-ink)] truncate tabular-nums">
            {chronosDropSummary.date} · {chronosDropSummary.count} 条事件
          </span>
        </div>
        <button
          type="button"
          aria-label="关闭司辰日期气泡"
          title="关闭"
          onClick={(e) => {
            e.stopPropagation();
            dismissChronosDropSummary();
          }}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] cursor-pointer"
        >
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1 font-mono text-[10px] tabular-nums">
        <span className="rounded bg-[color:var(--cv-slot)] px-1.5 py-0.5 text-[color:var(--cv-ink)]">
          +{chronosDropSummary.addedCount ?? 0} 新增
        </span>
        <span className="rounded bg-[color:var(--cv-slot)] px-1.5 py-0.5 text-[color:var(--cv-lav-ink)]">
          {chronosDropSummary.modifiedCount ?? 0} 演进
        </span>
        <span className="rounded bg-[color:var(--cv-slot)] px-1.5 py-0.5 text-[color:var(--cv-ink-dim)]">
          累计 {chronosDropSummary.cumulativeEvents ?? chronosDropSummary.count} 条
        </span>
      </div>

      {headlines.length > 0 && (
        <ul className="mt-2 space-y-1 text-[11px] text-[color:var(--cv-ink-2)] leading-snug">
          {headlines.map((line, i) => (
            <li key={i} className="truncate">
              · {line}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 pt-2 border-t border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] flex items-center justify-between text-[10px] font-mono">
        <span className="text-[color:var(--cv-ink-dim)]">已锁定该日 · 再次点击重对焦</span>
        {onOpenChronosDigest && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChronosDigest();
            }}
            className="inline-flex items-center gap-1 text-[color:var(--cv-lav-ink)] hover:underline cursor-pointer"
          >
            <BookMarked className="w-3 h-3" aria-hidden="true" />
            <span>查看司辰手记</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** FLOATING HOVER PREVIEW CARD (Core Summary + Unread Status + Modification Round, plus Chronos Time Telemetry card)
 *  悬停锚点锚定真实文件 */
export function GraphHoverPreviewCard({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    hoverPreviewData,
    hoveredPreviewAnchor,
    activeDraggingNodeId,
    zoomTransform,
    scene,
    activeTimeSlice,
    files,
    accumulationSummary,
    stageWidth,
    stageHeight,
    narrativeDrawerOpen,
  } = ctx;
  if (!hoverPreviewData || !hoveredPreviewAnchor || activeDraggingNodeId) return null;
  const pos = clampStageFloatingPos({
    worldX: hoveredPreviewAnchor.x,
    worldY: hoveredPreviewAnchor.y,
    zoomTransform,
    offsetX: 22,
    offsetY: -10,
    minLeft: 180,
    cardWidth: 346,
    cardHeight: 240,
    stageWidth,
    stageHeight,
    narrativeDrawerOpen,
  });
  return (
    <div
      role="status"
      data-slot="preview-card"
      data-graph-hover-preview=""
      data-chronos-carrier={hoveredPreviewAnchor.nodeId === 'chronos_deity' ? 'hover-card' : undefined}
      aria-label={`节点悬停预览：${
        hoveredPreviewAnchor.nodeId === 'chronos_deity'
          ? '观澜司辰 · 时间轴锚点'
          : hoverPreviewData.title
      }`}
      data-testid="node-hover-preview-card"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      className="glx-popover-in pointer-events-none absolute z-30 w-[346px] rounded-2xl bg-[color:color-mix(in_srgb,var(--cv-card)_98%,transparent)] backdrop-blur-xl border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_16%,transparent)] shadow-[0_24px_56px_color-mix(in_srgb,var(--cv-shadow-ink)_88%,transparent)] p-4 text-xs"
    >
      {hoveredPreviewAnchor.nodeId === 'chronos_deity' ? (
        <>
          <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--cv-brand)_14%,var(--cv-panel))] text-[color:var(--cv-brand-ink)] border border-[color:color-mix(in_srgb,var(--cv-brand)_40%,transparent)] font-mono text-[10px] uppercase shrink-0">
                  司辰 · CHRONOS
                </span>
                <span className="font-serif-claude font-semibold text-[color:var(--cv-ink)] text-[14px] truncate">
                  时间轴锚点
                </span>
              </div>
              <div className="text-[10.5px] font-mono text-[color:var(--cv-ink-dim)] truncate mt-1 tabular-nums">
                {scene.hasRealEvents
                  ? `${files.length} 份本地资料 · ${scene.totals.days} 沉淀日 · ${scene.totals.events} 条变更`
                  : `${files.length} 份本地资料 · 时间轴待命`}
              </div>
            </div>
          </div>

          <div className="mt-2.5 grid grid-cols-3 gap-1.5 font-mono">
            <div className="rounded-lg bg-[color:var(--cv-ctl)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] px-2 py-1.5 min-w-0">
              <div className="text-[9.5px] text-[color:var(--cv-ink-dim)]">当前刻度</div>
              <div className="mt-0.5 truncate text-[11px] font-semibold text-[color:var(--cv-ink)] tabular-nums">
                {scene.hasRealEvents
                  ? (scene.active?.label ?? '全域')
                  : activeTimeSlice === 'all'
                    ? '全域'
                    : activeTimeSlice}
              </div>
            </div>
            <div className="rounded-lg bg-[color:var(--cv-ctl)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] px-2 py-1.5 min-w-0">
              <div className="text-[9.5px] text-[color:var(--cv-ink-dim)]">当日变动</div>
              <div className="mt-0.5 truncate text-[11px] font-semibold text-[color:var(--cv-brand-ink)] tabular-nums">
                {accumulationSummary
                  ? `+${accumulationSummary.addedCount} / ↻${accumulationSummary.modifiedCount}`
                  : `${scene.active?.count ?? 0} 条`}
              </div>
            </div>
            <div className="rounded-lg bg-[color:var(--cv-ctl)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] px-2 py-1.5 min-w-0">
              <div className="text-[9.5px] text-[color:var(--cv-ink-dim)]">累计沉淀</div>
              <div className="mt-0.5 truncate text-[11px] font-semibold text-[color:var(--cv-lav-ink)] tabular-nums">
                {accumulationSummary
                  ? `${accumulationSummary.cumulativeEvents} (${accumulationSummary.cumulativePercent}%)`
                  : `${scene.totals.events} 条`}
              </div>
            </div>
          </div>

          <p className="mt-2.5 text-[11.5px] text-[color:var(--cv-ink-2)] leading-relaxed">
            {accumulationSummary
              ? `当前位于第 ${accumulationSummary.chronologicalOrder} / ${accumulationSummary.totalActiveDays} 个沉淀日（当日新增 ${accumulationSummary.addedCount} · 演进 ${accumulationSummary.modifiedCount}）。`
              : `按真实文件时间聚合 ${files.length} 份本地资料，上下拖拽可直接定位到对应日期分支。`}
          </p>

          <div className="mt-3 pt-2 border-t border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)] flex items-center justify-between text-[10.5px] font-mono text-[color:var(--cv-ink-dim)]">
            <span>沿轴上下拖拽定位日期</span>
            <span className="text-[color:var(--cv-brand)]">单击切换时间切片</span>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--cv-lav)_10%,var(--cv-panel))] text-[color:var(--cv-lav-ink)] font-mono text-[10px] uppercase shrink-0">
                  {hoverPreviewData.format}
                </span>
                <span className="font-serif-claude font-semibold text-[color:var(--cv-ink)] text-[14px] truncate">
                  {hoverPreviewData.title}
                </span>
              </div>
              <div className="text-[10.5px] font-mono text-[color:var(--cv-ink-dim)] truncate mt-1">
                {hoverPreviewData.relativePath}
              </div>
            </div>
            <span className="font-mono text-[10.5px] text-[color:var(--cv-ink-3)] bg-[color:var(--cv-slot)] px-2 py-0.5 rounded border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] shrink-0">
              v{hoverPreviewData.versionNumber}/{hoverPreviewData.totalRevisions}
            </span>
          </div>

          <div className="mt-2.5 flex items-center justify-between px-3 py-1.5 rounded-lg bg-[color:var(--cv-ctl)] border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)]">
            <span className="text-[11px] text-[color:var(--cv-ink-muted)] flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[color:var(--cv-lav)]" />
              <span>修改轮次</span>
            </span>
            <span className="font-mono text-[11px] text-[color:var(--cv-ink)] font-medium">
              {hoverPreviewData.modificationRoundLabel}
            </span>
          </div>

          <div
            className={`mt-2 px-3 py-2 rounded-lg border flex flex-col gap-1 ${
              hoverPreviewData.unreadStatus.isUnread
                ? 'bg-[color:color-mix(in_srgb,var(--cv-brand)_10%,var(--cv-panel))] border-[color:color-mix(in_srgb,var(--cv-brand)_40%,transparent)] text-[color:var(--cv-ink)]'
                : 'bg-[color:var(--cv-read-bg)] border-[color:color-mix(in_srgb,var(--cv-read-line)_40%,transparent)] text-[color:var(--cv-read-ink)]'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-[11px] flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    hoverPreviewData.unreadStatus.isUnread
                      ? 'bg-[color:var(--cv-brand)]'
                      : 'bg-[color:var(--cv-read-ink-strong)]'
                  }`}
                />
                <span>{hoverPreviewData.unreadStatus.statusLabel}</span>
              </span>
              <span className="font-mono text-[10px] opacity-80">
                阅读进度 {hoverPreviewData.unreadStatus.scrollPercent}%
              </span>
            </div>
            {hoverPreviewData.unreadStatus.changedSections.length > 0 && (
              <div className="text-[10px] opacity-85 truncate font-mono">
                变更章节：{hoverPreviewData.unreadStatus.changedSections.join(' · ')}
              </div>
            )}
          </div>

          <div className="mt-3">
            <div className="text-[10.5px] font-mono text-[color:var(--cv-ink-dim)] mb-1">
              核心摘要 (Core Summary)
            </div>
            <p className="text-[11.5px] text-[color:var(--cv-ink-2)] leading-relaxed line-clamp-3">
              {hoverPreviewData.coreSummary}
            </p>
          </div>

          <div className="mt-3 pt-2 border-t border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_6%,transparent)] flex items-center justify-between text-[10.5px] font-mono text-[color:var(--cv-ink-dim)]">
            <span>D3 自由拖拽节点</span>
            <span className="text-[color:var(--cv-brand)]">单击进入事件链 · 双击查看详情</span>
          </div>
        </>
      )}
    </div>
  );
}

/** 右上小地图：世界框（zoom 层内容包围盒）+ 视口框（当前 transform 折算），
 *  点击/拖框跳转走既有运镜（PAN_TRANSITION_MS=500=--dur-pan）；锚点 data-cv-minimap。
 *  定位在 right-4 top-3（约 160×100px）。 */
export function GraphMiniMapSection({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    stageWidth,
    stageHeight,
    canvasWorldBounds,
    minimapViewport,
    handleMinimapJump,
    narrativeDrawerOpen,
  } = ctx;
  if (!(stageWidth > 0 && stageHeight > 0)) return null;
  const drawerPosClass = narrativeDrawerOpen
    ? stageWidth >= 820
      ? 'right-[356px] opacity-100'
      : 'right-4 opacity-0 pointer-events-none'
    : 'right-4 opacity-100';
  return (
    <CanvasMiniMap
      className={`d3-no-pan absolute top-3 z-20 transition-[right,opacity] duration-300 ${drawerPosClass}`}
      worldWidth={canvasWorldBounds.width}
      worldHeight={canvasWorldBounds.height}
      viewport={minimapViewport}
      onJump={handleMinimapJump}
    />
  );
}

/** ?快捷键就地轻弹层（药丸上方浮出；纯 chrome，不进 zoom 层） */
export function GraphShortcutsPop({ ctx }: { ctx: GraphCanvasCtx }) {
  const { showShortcuts, narrativeDrawerOpen } = ctx;
  if (!showShortcuts) return null;
  return (
    <div
      style={{ left: narrativeDrawerOpen ? 'calc(50% - 170px)' : '50%' }}
      className="d3-no-pan cvw-shortcut-pop absolute bottom-16 -translate-x-1/2 z-30 min-w-[250px] transition-[left] duration-300"
      data-testid="canvas-shortcut-pop"
    >
      <div className="cvw-shortcut-title">画布操作 · 快捷键</div>
      {(
        [
          { key: 'Alt + ↑↓←→', desc: '沿引用 / 因果连线空间漫游' },
          { key: 'J / K', desc: '增量聚光灯逐条批阅变化' },
          { key: 'Space', desc: '原位轻预览（↑/↓ 切换）' },
          { key: 'Enter', desc: '深度阅读当前焦点文件' },
          { key: 'D', desc: '版本对比 / 多模态时光机' },
          { key: 'C', desc: '加入上下文篮' },
          { key: 'Ctrl + Z / Shift+Z', desc: '撤销 / 重做改名与移动' },
          { key: '单击 / 双击卡片', desc: '下钻事件链 / 叙事详情抽屉' },
          { key: '抓手拖拽 / 滚轮', desc: '平移 / 缩放画布' },
          { key: 'Esc / ?', desc: '按来源栈逐级返回 / 完整速查' },
        ] as const
      ).map((row) => (
        <div className="cvw-shortcut-row" key={row.key}>
          <span>{row.desc}</span>
          <span className="cvw-shortcut-key">{row.key}</span>
        </div>
      ))}
    </div>
  );
}

/** 叙事抽屉：双击节点 / 顶栏「详情」滑出（translateX+opacity --dur-3 --ease-spring），
 *  取代常驻检视器。footer 首位为「打开原文」（复用 openFileReader 链路）；
 *  追溯决策、复制证据、「已选中 · 层级」信息与返回主轴钮由叙事 memo / backButton 承载 */
export function GraphNarrativeDrawerSection({ ctx }: { ctx: GraphCanvasCtx }) {
  const {
    narrativeDrawerOpen,
    narrative,
    closeNarrativeDrawer,
    selectedCanvasNodeId,
    scene,
    setSelectedCanvasNodeId,
    openFileReader,
    files,
    systemActions,
    onOpenDecisionModal,
    narrativeCopyFileId,
    copiedId,
    handleCopyInspectorPointer,
  } = ctx;
  return (
    <CanvasNarrativeDrawer
      open={narrativeDrawerOpen}
      title={narrative.title}
      metaLine={narrative.metaLine}
      sections={narrative.sections}
      onClose={closeNarrativeDrawer}
      backButton={
        selectedCanvasNodeId !== 'main_hub'
          ? {
              label: scene.hasRealEvents ? '司辰时间轴' : '主智能体',
              onClick: () => setSelectedCanvasNodeId('main_hub'),
            }
          : undefined
      }
      footer={
        <>
          <button
            type="button"
            className="cvw-narrative-foot-primary"
            onClick={() => openFileReader(narrative.footerFileId || '', 'read')}
          >
            <BookOpen className="w-3.5 h-3.5 shrink-0" strokeWidth={1.6} aria-hidden="true" />
            <span>打开原文</span>
          </button>

          <div className="cvw-narrative-foot-secondary">
            {(() => {
              const nf = narrative.footerFileId
                ? files.find((f) => f.file_id === narrative.footerFileId)
                : undefined;
              if (!nf || !systemActions?.desktopSystemSupported) return null;
              return (
                <>
                  {systemActions.onRevealInExplorer && (
                    <button
                      type="button"
                      className="cvw-narrative-foot-btn"
                      title="在资源管理器中显示（选中该文件）"
                      onClick={() => systemActions.onRevealInExplorer?.(nf.relative_path)}
                    >
                      <FolderSearch className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span>定位目录</span>
                    </button>
                  )}
                  {systemActions.onOpenWithDefaultApp && (
                    <button
                      type="button"
                      className="cvw-narrative-foot-btn"
                      title="用系统默认应用打开"
                      onClick={() => systemActions.onOpenWithDefaultApp?.(nf.relative_path)}
                    >
                      <ExternalLink className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span>默认打开</span>
                    </button>
                  )}
                </>
              );
            })()}

            {narrative.decisionId && (
              <button
                type="button"
                className="cvw-narrative-foot-btn"
                onClick={() => onOpenDecisionModal(narrative.decisionId!)}
              >
                <Scale className="w-3.5 h-3.5 shrink-0 text-[color:var(--cv-amber-ink)]" strokeWidth={1.5} aria-hidden="true" />
                <span>追溯决策</span>
              </button>
            )}

            <button
              type="button"
              aria-label="复制当前节点证据指针"
              className="cvw-narrative-foot-btn"
              onClick={() =>
                handleCopyInspectorPointer(
                  narrativeCopyFileId,
                  `Graph 叙事抽屉引用：${narrative.title}`
                )
              }
            >
              {copiedId === narrativeCopyFileId ? (
                <>
                  <ClipboardCheck className="w-3.5 h-3.5 shrink-0 text-[color:var(--cv-read-ink-strong)]" strokeWidth={1.6} aria-hidden="true" />
                  <span>已复制</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  <span>复制证据</span>
                </>
              )}
            </button>
          </div>
        </>
      }
    />
  );
}
