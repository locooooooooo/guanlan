import { useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Layers, MoveHorizontal } from 'lucide-react';
import { sanitizeSvgForPreview } from '../../utils/guanlanEngine';
import type { SvgDiffResult, SvgShapeChange } from '../../utils/multimodalDiff';

/**
 * SVG 图纸半透明洋葱皮叠影（Onion-Skin）与滑动擦除（Swipe）对比面板。
 *
 * - 渲染红线：两版 SVG 一律经 sanitizeSvgForPreview 清洗后编 data:URI 走 <img>
 *   （readerSvgPdfSections.tsx 同款，绝不 inline 注入用户 SVG——脚本/事件处理器不执行）；
 * - 两版图层在正文拉取完成时一次性编码（useMemo），叠影/擦除切换只是样式状态翻转，
 *   不重解码不重布局——「任意两版切换叠影/擦除 <150ms」由结构兑现；
 * - 改动图元区域 = multimodalDiff.buildSvgDiff 的包围盒叠加层（琥珀=修改/绿=新增/红=删除，
 *   半透明描边+极淡填充），units 缺失（无 viewBox）时诚实退化为文本清单，不伪造几何定位；
 * - 滑动擦除：左显新版右显旧版，分隔线可拖拽（pointer capture）；洋葱皮：上层 0.5 不透明度
 *   叠放下层，可切换「新压旧/旧压新」。
 */

export type SvgCompareMode = 'onion' | 'swipe';

export interface SvgComparePanelProps {
  oldSvg: string;
  newSvg: string;
  diff: SvgDiffResult;
  oldLabel: string;
  newLabel: string;
}

/** 改动图元清单最多渲染条数（DOM 有界；其余以「还有 N 处」诚实提示） */
const MAX_CHANGE_ROWS = 24;

function svgDataUri(raw: string): string {
  const { sanitizedSvg } = sanitizeSvgForPreview(raw);
  return `data:image/svg+xml;utf8,${encodeURIComponent(sanitizedSvg)}`;
}

export function SvgComparePanel({ oldSvg, newSvg, diff, oldLabel, newLabel }: SvgComparePanelProps) {
  const [mode, setMode] = useState<SvgCompareMode>('onion');
  const [topIsNew, setTopIsNew] = useState(true);
  const [ratio, setRatio] = useState(0.5);
  const [outlinesOn, setOutlinesOn] = useState(true);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const newUri = useMemo(() => svgDataUri(newSvg), [newSvg]);
  const oldUri = useMemo(() => svgDataUri(oldSvg), [oldSvg]);

  const aspectPct = diff.ok && diff.units && diff.units.width > 0
    ? (diff.units.height / diff.units.width) * 100
    : 75; // 无坐标系兜底 4:3

  const onTrackPointerMove = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setRatio(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  const changes = diff.ok ? diff.changes : [];
  const boxes = changes.filter((c) => c.box);
  const units = diff.ok ? diff.units : null;
  const hiddenCount = changes.length - Math.min(changes.length, MAX_CHANGE_ROWS);

  return (
    <div className="space-y-2" data-machine-svg-compare="">
      {/* 模式工具条 */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-machine-svg-mode="onion"
          onClick={() => setMode('onion')}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
          style={modeStyle(mode === 'onion')}
          aria-pressed={mode === 'onion'}
        >
          <Layers size={12} /> 叠影
        </button>
        <button
          type="button"
          data-machine-svg-mode="swipe"
          onClick={() => setMode('swipe')}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
          style={modeStyle(mode === 'swipe')}
          aria-pressed={mode === 'swipe'}
        >
          <MoveHorizontal size={12} /> 擦除
        </button>
        {mode === 'onion' && (
          <button
            type="button"
            onClick={() => setTopIsNew((v) => !v)}
            className="rounded px-2 py-0.5 text-[11px]"
            style={modeStyle(false)}
            title="切换洋葱皮上下层顺序"
          >
            {topIsNew ? '新压旧' : '旧压新'}
          </button>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-[11px]" style={{ color: 'var(--cv-ink-meta)' }}>
          <input
            type="checkbox"
            checked={outlinesOn}
            onChange={(e) => setOutlinesOn(e.target.checked)}
            data-machine-svg-outlines-toggle=""
          />
          改动框（{changes.length}）
        </label>
      </div>

      {/* 图层舞台 */}
      <div
        ref={trackRef}
        className="relative select-none overflow-hidden rounded-lg border"
        style={{
          background: 'var(--cv-card)',
          borderColor: 'color-mix(in srgb, var(--cv-hairline-ink) 18%, transparent)',
        }}
        data-machine-svg-stage=""
        onPointerDown={(e) => {
          if (mode !== 'swipe') return;
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onTrackPointerMove(e.clientX);
        }}
        onPointerMove={(e) => {
          if (mode !== 'swipe' || !draggingRef.current) return;
          onTrackPointerMove(e.clientX);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      >
        <div style={{ position: 'relative', width: '100%', paddingTop: `${aspectPct}%` }}>
          {/* 基底层 */}
          <img
            src={topIsNew || mode === 'swipe' ? oldUri : newUri}
            alt={`${mode === 'swipe' ? '右半' : '底层'}：${oldLabel}`}
            draggable={false}
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: 'contain' }}
            data-machine-svg-layer={mode === 'swipe' ? 'old' : topIsNew ? 'old' : 'new'}
          />
          {/* 上层（叠影半透明 / 擦除左侧裁切显新版） */}
          {mode === 'onion' ? (
            <img
              src={topIsNew ? newUri : oldUri}
              alt={`上层：${topIsNew ? newLabel : oldLabel}`}
              draggable={false}
              className="absolute inset-0 h-full w-full"
              style={{ objectFit: 'contain', opacity: 0.5 }}
              data-machine-svg-layer={topIsNew ? 'new' : 'old'}
            />
          ) : (
            <img
              src={newUri}
              alt={`左半：${newLabel}`}
              draggable={false}
              className="absolute inset-0 h-full w-full"
              style={{ objectFit: 'contain', clipPath: `inset(0 ${(1 - ratio) * 100}% 0 0)` }}
              data-machine-svg-layer="new"
            />
          )}

          {/* 改动图元叠加框（units 已知才渲染几何框，绝不伪造定位） */}
          {outlinesOn && units && diff.ok && (
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox={`0 0 ${units.width} ${units.height}`}
              preserveAspectRatio="xMidYMid meet"
              data-machine-svg-overlays=""
            >
              {boxes.slice(0, 60).map((change, i) => (
                <rect
                  key={`box-${i}`}
                  x={change.box!.x}
                  y={change.box!.y}
                  width={Math.max(change.box!.width, 1)}
                  height={Math.max(change.box!.height, 1)}
                  fill={overlayFill(change)}
                  stroke={overlayStroke(change)}
                  strokeWidth={Math.max(units.width / 400, 1.2)}
                  rx={units.width / 250}
                />
              ))}
            </svg>
          )}

          {/* 擦除分隔线 */}
          {mode === 'swipe' && (
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5"
              style={{ left: `${ratio * 100}%`, background: 'var(--cv-amber)' }}
              data-machine-svg-divider=""
            >
              <span
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full px-1 py-0.5 font-mono text-[9px]"
                style={{ background: 'var(--cv-amber)', color: 'var(--cv-panel)' }}
              >
                ⇔
              </span>
            </div>
          )}
          {/* 来源角标 */}
          <span
            className="absolute left-1 top-1 rounded px-1 font-mono text-[9px]"
            style={{ background: 'color-mix(in srgb, var(--cv-add) 22%, var(--cv-card))', color: 'var(--cv-add)' }}
          >
            {newLabel}
          </span>
          <span
            className="absolute right-1 top-1 rounded px-1 font-mono text-[9px]"
            style={{ background: 'color-mix(in srgb, var(--cv-del) 18%, var(--cv-card))', color: 'var(--cv-del)' }}
          >
            {oldLabel}
          </span>
        </div>
      </div>
      {!diff.ok && (
        <p role="status" className="text-[11px]" style={{ color: 'var(--cv-ink-meta)' }}>{diff.message}</p>
      )}
      {diff.ok && diff.truncated && (
        <p role="status" className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
          图元数量超过对比上限（前 1500 个已对比），其余以文本清单兜底。
        </p>
      )}
      {outlinesOn && !units && diff.ok && changes.length > 0 && (
        <p role="status" className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>
          该 SVG 缺少 viewBox/尺寸声明，无法定位图元坐标——改动以清单呈现，不伪造几何框。
        </p>
      )}

      {/* 改动清单 */}
      {changes.length === 0 ? (
        <p className="text-[11px]" style={{ color: 'var(--cv-ink-meta)' }}>两版图元无差异（外观等价）。</p>
      ) : (
        <ul className="space-y-0.5" data-machine-svg-changes="">
          {changes.slice(0, MAX_CHANGE_ROWS).map((change, i) => (
            <li key={`chg-${i}`} className="flex items-baseline gap-2 text-[11px]">
              <span className="shrink-0 font-mono text-[10px]" style={{ color: kindColor(change.kind) }}>
                {kindLabel(change)}
              </span>
              <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--cv-ink-3)' }} title={change.label}>
                {change.label}
              </span>
              {change.box && units && (
                <span className="shrink-0 font-mono text-[9px]" style={{ color: 'var(--cv-ink-meta)' }}>
                  @{Math.round(change.box.x)},{Math.round(change.box.y)}
                </span>
              )}
            </li>
          ))}
          {hiddenCount > 0 && (
            <li className="font-mono text-[10px]" style={{ color: 'var(--cv-ink-meta)' }}>…还有 {hiddenCount} 处改动</li>
          )}
        </ul>
      )}
    </div>
  );
}

function modeStyle(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--cv-card)' : 'transparent',
    color: active ? 'var(--cv-ink-3)' : 'var(--cv-ink-meta)',
    border: `1px solid ${active ? 'color-mix(in srgb, var(--cv-lav) 40%, transparent)' : 'transparent'}`,
  };
}

function kindColor(kind: SvgShapeChange['kind']): string {
  return kind === 'added' ? 'var(--cv-add)' : kind === 'removed' ? 'var(--cv-del)' : 'var(--cv-amber-ink)';
}

function kindLabel(change: SvgShapeChange): string {
  return change.kind === 'added' ? '[新增]' : change.kind === 'removed' ? '[删除]' : '[修改]';
}

function overlayFill(change: SvgShapeChange): string {
  const tone = change.kind === 'added' ? 'var(--cv-add)' : change.kind === 'removed' ? 'var(--cv-del)' : 'var(--cv-amber)';
  return `color-mix(in srgb, ${tone} 10%, transparent)`;
}

function overlayStroke(change: SvgShapeChange): string {
  return change.kind === 'added' ? 'var(--cv-add)' : change.kind === 'removed' ? 'var(--cv-del)' : 'var(--cv-amber)';
}
