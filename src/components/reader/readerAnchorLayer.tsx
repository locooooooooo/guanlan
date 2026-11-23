/**
 * D04 · 阅读器锚点批注层（独立组件文件，§4.2 防膨胀纪律）。
 *
 * 组成：
 * · ReaderAnnotationComposer —— 批注撰写卡（保存批注 / 一键转 [P1 - 待确认] 决定项）。
 *   MD 转决定项走桌面壳 save_workspace_file CAS 桥（显式点击，冲突诚实拒绝）；
 *   SVG/PDF 转决定项只落本地证据表（停机条款：绝不改用户原始 SVG/PDF 字节）。
 * · ReaderAnnotationDrawer —— 当前版本批注清单（定位=跳转+闪烁；删除；已转徽标）。
 * · SvgAnnotationOverlay —— SVG 图像容器上的框选叠加层（保存区域恒百分比定位，
 *   与缩放无关；拖拽区域在容器坐标内计算，pointer capture；绝不触碰 SVG 源字节）。
 * · PdfPageAnnotations —— 页级文本批注 chips（当前页）。
 *
 * SSR 纪律：纯受控组件，全部状态经 props 注入；pointer 交互仅客户端 effect；
 * 关闭态零 DOM（D01-a 像素基线结构性零扰动）。
 */

import React, { useRef, useState } from 'react';
import { Check, Loader2, MapPin, StickyNote, Trash2, X } from 'lucide-react';
import { Button } from '../ui/primitives';
import { formatAnnotationLocatorLabel, svgRegionStyle } from '../../utils/readerAnnotations';
import type { ReaderAnnotation } from '../../utils/readerAnnotations';

/* ═══════════════════ 批注撰写卡 ═══════════════════ */

export interface AnnotationComposerProps {
  open: boolean;
  /** 锚点人话标签（L42 / 框选区（12%, 34%）/ 第 3 页） */
  anchorLabel: string;
  paperLightMode: boolean;
  /** 一键转决定项可用性（MD 无桌面壳桥 / 版本哈希未就绪时诚实禁用） */
  convertAvailable: boolean;
  convertDisabledReason?: string;
  busy: boolean;
  notice: { kind: 'ok' | 'error'; message: string } | null;
  onSave: (note: string) => void;
  onConvert: (note: string) => void;
  onClose: () => void;
}

export function ReaderAnnotationComposer({
  open,
  anchorLabel,
  paperLightMode,
  convertAvailable,
  convertDisabledReason,
  busy,
  notice,
  onSave,
  onConvert,
  onClose,
}: AnnotationComposerProps) {
  const [note, setNote] = useState('');
  if (!open) return null;
  const cardCls = paperLightMode
    ? 'bg-[#FFFEFA]/95 border-[#E3DCC9] text-[#1F1E1D]'
    : 'bg-[#262320]/95 border-[#383633] text-[#F4F3EE]';
  return (
    <div
      data-annotation-composer="open"
      role="group"
      aria-label="批注撰写"
      className={`absolute bottom-16 left-1/2 -translate-x-1/2 z-30 w-[min(560px,calc(100%-2rem))] rounded-xl border px-4 py-3 shadow-lg backdrop-blur space-y-2 ${cardCls}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <StickyNote className="w-3.5 h-3.5 text-[#D99B52]" />
          <span>本地批注 · 锚点 {anchorLabel}</span>
        </span>
        <button
          type="button"
          aria-label="关闭批注撰写"
          data-annotation-composer-close
          onClick={onClose}
          className={`rounded px-1.5 cursor-pointer ${paperLightMode ? 'hover:bg-[#EAE7DE]' : 'hover:bg-white/10'}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={480}
        placeholder="写一句批注（只存本地证据表，按版本哈希绑定，不改原文）…"
        aria-label="批注正文"
        data-annotation-note-input
        className={`w-full rounded-lg border px-2.5 py-1.5 text-xs leading-relaxed bg-transparent focus:outline-none focus:border-[#9A6A45] ${
          paperLightMode ? 'border-[#E3DCC9]' : 'border-[#383633]'
        }`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => onSave(note)}
          data-annotation-save
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          <span>保存批注</span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !convertAvailable}
          onClick={() => onConvert(note)}
          data-annotation-convert
          title={
            !convertAvailable && convertDisabledReason
              ? convertDisabledReason
              : '在锚点后插入 [P1 - 待确认] 决定块（MD 回写原文件走 CAS 冲突保护；SVG/PDF 只存本地决定草案，绝不改二进制原文）'
          }
        >
          <span>转为 [P1 - 待确认] 决定项</span>
        </Button>
        {notice && (
          <span
            role="status"
            data-annotation-notice={notice.kind}
            className={`text-xs ${notice.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-[color:var(--accent-wave)]'}`}
          >
            {notice.message}
          </span>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════ 批注清单抽屉 ═══════════════════ */

export interface AnnotationDrawerProps {
  open: boolean;
  paperLightMode: boolean;
  annotations: ReaderAnnotation[];
  onJump: (annotation: ReaderAnnotation) => void;
  onDelete: (annotationId: string) => void;
  onClose: () => void;
}

export function ReaderAnnotationDrawer({
  open,
  paperLightMode,
  annotations,
  onJump,
  onDelete,
  onClose,
}: AnnotationDrawerProps) {
  if (!open) return null;
  const cardCls = paperLightMode
    ? 'bg-[#FFFEFA]/95 border-[#E3DCC9] text-[#1F1E1D]'
    : 'bg-[#262320]/95 border-[#383633] text-[#F4F3EE]';
  return (
    <div
      data-annotation-drawer="open"
      role="group"
      aria-label="本版本批注清单"
      className={`absolute bottom-4 right-4 z-30 w-[min(360px,calc(100%-2rem))] max-h-[46%] rounded-xl border px-3 py-2.5 shadow-lg backdrop-blur flex flex-col ${cardCls}`}
    >
      <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-[color:var(--glass-hairline)]">
        <span className="text-xs font-semibold flex items-center gap-1.5">
          <StickyNote className="w-3.5 h-3.5 text-[#D99B52]" />
          本版本批注（{annotations.length}）
        </span>
        <button
          type="button"
          aria-label="收起批注清单"
          data-annotation-drawer-close
          onClick={onClose}
          className={`rounded px-1.5 cursor-pointer ${paperLightMode ? 'hover:bg-[#EAE7DE]' : 'hover:bg-white/10'}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="overflow-y-auto space-y-1.5" data-annotation-drawer-list>
        {annotations.length === 0 ? (
          <p className="text-xs py-3 text-center opacity-70">
            本版本还没有批注。选中段落 / 框选区域 / 页内文字即可添加。
          </p>
        ) : (
          annotations.map((a) => (
            <div
              key={a.id}
              data-annotation-item={a.id}
              className={`rounded-lg border px-2.5 py-1.5 text-xs space-y-1 ${
                paperLightMode ? 'border-[#EFE7DA] bg-white/60' : 'border-[#383633] bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] opacity-80 shrink-0">
                  {formatAnnotationLocatorLabel(a.locator)}
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  {a.converted && (
                    <span className="px-1.5 py-0.5 rounded-full border text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-500/40">
                      已转决定项
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onJump(a)}
                    title="定位到此锚点并闪烁高亮"
                    className="flex items-center gap-0.5 rounded px-1 py-0.5 cursor-pointer text-[#9A6A45] dark:text-[#E5A96A] hover:underline"
                  >
                    <MapPin className="w-3 h-3" />
                    定位
                  </button>
                  <button
                    type="button"
                    aria-label="删除批注"
                    onClick={() => onDelete(a.id)}
                    className="rounded px-1 py-0.5 cursor-pointer opacity-60 hover:opacity-100"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              </div>
              <p className="leading-relaxed break-words">{a.note}</p>
              {a.converted && a.decision_text && (
                <p className="text-[11px] opacity-70 leading-relaxed">
                  决定文本：{a.decision_text}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ═══════════════════ SVG 框选叠加层 ═══════════════════ */

export interface SvgAnnotationOverlayProps {
  annotations: ReaderAnnotation[];
  annotateMode: boolean;
  paperLightMode: boolean;
  /** 反向定位闪烁的批注 id（决定/清单跳转到达时短暂高亮该区域） */
  flashAnnotationId: string | null;
  onRegionSelected: (region: { fx: number; fy: number; fw: number; fh: number }) => void;
}

/**
 * SVG 框选叠加层：绝对铺满图像容器（父级须 relative）。保存的批注区域按
 * 渲染盒百分比定位（缩放无关）；框选态开 crosshair + pointer capture 拖拽。
 * 纯叠加层——不进入 <img> 内部、不改 sanitize 后的 data:URI，SVG 原字节零触碰。
 */
export function SvgAnnotationOverlay({
  annotations,
  annotateMode,
  paperLightMode,
  flashAnnotationId,
  onRegionSelected,
}: SvgAnnotationOverlayProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<{ fx0: number; fy0: number; fx1: number; fy1: number } | null>(
    null
  );

  const fractionOf = (clientX: number, clientY: number) => {
    const box = boxRef.current;
    if (!box) return { fx: 0, fy: 0 };
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { fx: 0, fy: 0 };
    return {
      fx: (clientX - rect.left) / rect.width,
      fy: (clientY - rect.top) / rect.height,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!annotateMode || e.button !== 0) return;
    e.preventDefault();
    const p = fractionOf(e.clientX, e.clientY);
    setDraft({ fx0: p.fx, fy0: p.fy, fx1: p.fx, fy1: p.fy });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draft) return;
    const p = fractionOf(e.clientX, e.clientY);
    setDraft((prev) => (prev ? { ...prev, fx1: p.fx, fy1: p.fy } : prev));
  };
  const handlePointerUp = () => {
    if (!draft) return;
    const fx = Math.min(draft.fx0, draft.fx1);
    const fy = Math.min(draft.fy0, draft.fy1);
    const fw = Math.abs(draft.fx1 - draft.fx0);
    const fh = Math.abs(draft.fy1 - draft.fy0);
    setDraft(null);
    if (fw >= 0.01 && fh >= 0.01) {
      onRegionSelected({ fx, fy, fw, fh });
    }
  };

  const draftStyle = draft
    ? svgRegionStyle({
        fx: Math.min(draft.fx0, draft.fx1),
        fy: Math.min(draft.fy0, draft.fy1),
        fw: Math.abs(draft.fx1 - draft.fx0),
        fh: Math.abs(draft.fy1 - draft.fy0),
      })
    : null;

  return (
    <div
      ref={boxRef}
      data-svg-annotation-overlay={annotateMode ? 'select' : 'view'}
      className="absolute inset-0"
      style={{ cursor: annotateMode ? 'crosshair' : 'default', touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {annotations.map((a) =>
        a.locator.kind === 'svg' ? (
          <div
            key={a.id}
            data-svg-annotation-region={a.id}
            className={`absolute rounded-sm border pointer-events-none ${
              flashAnnotationId === a.id ? 'glx-anchor-flash' : ''
            }`}
            style={{
              ...svgRegionStyle(a.locator),
              borderWidth: 2,
              borderColor: '#D99B52',
              background: 'rgba(217, 155, 82, 0.10)',
            }}
          />
        ) : null
      )}
      {draftStyle && (
        <div
          data-svg-annotation-draft
          className="absolute rounded-sm pointer-events-none"
          style={{
            ...draftStyle,
            border: '2px dashed #9b8afb',
            background: 'rgba(155, 138, 251, 0.10)',
          }}
        />
      )}
      {annotateMode && (
        <span
          aria-hidden="true"
          className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium pointer-events-none ${
            paperLightMode ? 'bg-white/85 text-[#9A6A45]' : 'bg-black/60 text-[#F0BA7B]'
          }`}
        >
          框选模式：拖拽圈出批注区域
        </span>
      )}
    </div>
  );
}

/* ═══════════════════ PDF 页内批注 chips ═══════════════════ */

export interface PdfPageAnnotationsProps {
  annotations: ReaderAnnotation[];
  flashAnnotationId: string | null;
  paperLightMode: boolean;
}

/** 当前 PDF 页的批注 chips（页头下方；定位闪烁由清单/决定跳转驱动）。 */
export function PdfPageAnnotations({
  annotations,
  flashAnnotationId,
  paperLightMode,
}: PdfPageAnnotationsProps) {
  if (annotations.length === 0) return null;
  return (
    <div className="space-y-1" data-pdf-page-annotations={String(annotations.length)}>
      {annotations.map((a) => (
        <div
          key={a.id}
          data-pdf-annotation-item={a.id}
          className={`flex items-start gap-1.5 rounded-lg border px-2 py-1 text-[11px] leading-relaxed ${
            flashAnnotationId === a.id ? 'glx-anchor-flash' : ''
          } ${paperLightMode ? 'border-[#EFE7DA] bg-[#FBF6EE]' : 'border-[#383633] bg-white/[0.04]'}`}
        >
          <StickyNote className="w-3 h-3 mt-0.5 shrink-0 text-[#D99B52]" />
          <span className="min-w-0">
            {a.locator.kind === 'pdf' && a.locator.quote ? (
              <span className="opacity-70">「{a.locator.quote.slice(0, 60)}」· </span>
            ) : null}
            {a.note}
            {a.converted && (
              <span className="ml-1 text-emerald-600 dark:text-emerald-400">· 已转决定项</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
