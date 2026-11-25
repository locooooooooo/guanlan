/**
 * 增量聚光灯条（司辰旁导航条）。
 *
 * 一键开启「增量聚光灯」：开启后画布上「上次离开前已读且未变」的节点退为低对比度
 * 背景骨架（GraphSceneCards 按 spotlight.dimmedFileIds 注入降亮度样式），仅高亮
 * 读后真实变化三类（新增版本 / 新挂起决定 / Agent 新草案）。
 *
 * 本组件承担两件事：
 *  1. 一键开关（aria-pressed 分段钮形制，与 GraphTopBar 既有钮同语言）；
 *  2. 开启后给出「共 M 处新变化 · 按时间逐条批阅（J/K 键）」导航条：
 *     J = 下一处、K = 上一处（循环），Enter/点击当前条 = 画布选中该节点（右栏联动）。
 *
 * 纪律：J/K 守卫（编辑面/浮层打开让路）走 readingSpotlight.shouldIgnoreSpotlightKeys
 * 纯函数；排序与三类派生在宿主 store（readingSpotlight.ts 纯函数单一出口），
 * 本组件不自行造数。关闭态仅渲染开关钮（导航条 null），undefined 时渲染 null。
 */

import React, { useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Sun, X } from 'lucide-react';
import type { GraphCanvasCtx } from './useGraphCanvasController';
import {
  shouldIgnoreSpotlightKeys,
  spotlightKindLabel,
  stepSpotlightCursor,
} from '../../utils/readingSpotlight';
import { formatLocalClock } from '../../utils/timeFormat';

/** 键步进方向（stepSpotlightCursor 的 dir 契约）。 */
type StepDir = 1 | -1;

export interface GraphSpotlightBarProps {
  ctx: GraphCanvasCtx;
  /**
   * 渲染分段：
   * - 'toggle'：仅顶栏紧凑开关钮（同时托管 J/K 键盘批阅监听），绝不撑宽顶栏；
   * - 'nav'：开启后在画布顶部正中浮出的独立批阅微条；
   * - 'both'（默认）：保留向后兼容的内联渲染。
   */
  mode?: 'both' | 'toggle' | 'nav';
}

export function GraphSpotlightBar({ ctx, mode = 'both' }: GraphSpotlightBarProps) {
  const { spotlight, onSelectFile, visible, narrativeDrawerOpen } = ctx;
  const enabled = spotlight?.enabled ?? false;
  const items = spotlight?.items ?? [];
  const rawCursor = spotlight?.cursor ?? 0;
  const onToggle = spotlight?.onToggle;
  const onCursor = spotlight?.onCursor;

  const total = items.length;
  // 游标对列表长度取模：数据刷新缩胀时永不越界（store 只存裸游标，消费侧归一）
  const cursor = total > 0 ? ((rawCursor % total) + total) % total : 0;
  const current = total > 0 ? items[cursor] : null;

  const step = useCallback(
    (dir: StepDir) => {
      if (total <= 0 || !onCursor) return;
      onCursor(stepSpotlightCursor(rawCursor, total, dir));
    },
    [onCursor, rawCursor, total]
  );

  // J/K 键盘批阅只在 toggle / both 实例挂一次，避免 toggle+nav 同时挂载时触发两次步进
  const ownsKeyboard = mode !== 'nav';
  useEffect(() => {
    if (!ownsKeyboard || !visible || !enabled || total <= 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const escLayerOpen =
        typeof document !== 'undefined' &&
        Boolean(document.querySelector('[data-esc-layer="open"], [role="dialog"]'));
      if (shouldIgnoreSpotlightKeys(event.target, escLayerOpen)) return;
      const key = event.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      event.preventDefault();
      step(key === 'j' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ownsKeyboard, visible, enabled, step, total]);

  // 宿主未接线（老调用方/测试链）→ 整组件 null，绝不渲染无数据源的假开关
  if (!spotlight || !onToggle) return null;

  const navContent = enabled ? (
    <span
      data-cv-spotlight-nav
      data-spotlight-total={total}
      className={
        mode === 'nav'
          ? 'd3-no-pan inline-flex items-center gap-2 rounded-full border border-[color:color-mix(in_srgb,var(--cv-amber)_36%,transparent)] bg-[color:color-mix(in_srgb,var(--cv-panel)_94%,transparent)] backdrop-blur-md shadow-[var(--cv-shadow-elevated)] px-3 py-1 text-[11px] text-[color:var(--cv-ink-2)] max-w-full'
          : 'inline-flex items-center gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] bg-[color:color-mix(in_srgb,var(--cv-panel)_70%,transparent)] px-1.5 py-0.5 text-[11px] text-[color:var(--cv-ink-dim)]'
      }
    >
      <Sun className="w-3 h-3 shrink-0 text-[color:var(--cv-amber-ink)]" aria-hidden="true" />
      {total > 0 && current ? (
        <>
          <span className="font-mono tabular-nums shrink-0 text-[color:var(--cv-ink-dim)]">
            {cursor + 1}/{total}
          </span>
          <span className="font-mono tabular-nums font-medium text-[color:var(--cv-amber-ink)] shrink-0">
            共 {total} 处新变化
          </span>
          <button
            type="button"
            aria-label="上一处（K）"
            data-cv-spotlight-prev
            className="rounded-full p-0.5 text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] cursor-pointer"
            onClick={() => step(-1)}
          >
            <ChevronLeft className="w-3 h-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-cv-spotlight-current
            title={`按时间批阅（J/K 键）：${current.title} · ${
              current.atMs !== null ? formatLocalClock(new Date(current.atMs).toISOString()) : '时间待考'
            }`}
            className="max-w-[220px] truncate rounded px-1.5 py-0.5 text-[color:var(--cv-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] cursor-pointer text-left"
            onClick={() => onSelectFile(current.file_id)}
          >
            <span className="mr-1 text-[color:var(--cv-amber-ink)]">
              {spotlightKindLabel(current.kind)}
            </span>
            {current.title}
          </button>
          <button
            type="button"
            aria-label="下一处（J）"
            data-cv-spotlight-next
            className="rounded-full p-0.5 text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_8%,transparent)] cursor-pointer"
            onClick={() => step(1)}
          >
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          </button>
        </>
      ) : (
        <span className="truncate">共 0 处新变化 · 已读未变节点已退为背景骨架</span>
      )}
      <span className="shrink-0 font-mono text-[10px] text-[color:var(--cv-ink-dim)]">
        J/K 逐条批阅
      </span>
      {mode === 'nav' && (
        <button
          type="button"
          aria-label="关闭增量聚光灯"
          title="退出增量聚光灯"
          onClick={onToggle}
          className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[color:var(--cv-ink-dim)] hover:text-[color:var(--cv-ink)] hover:bg-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] cursor-pointer"
        >
          <X className="w-2.5 h-2.5" aria-hidden="true" />
        </button>
      )}
    </span>
  ) : null;

  if (mode === 'nav') {
    if (!navContent) return null;
    return (
      <div
        className="pointer-events-none absolute top-3 z-20 flex justify-center transition-[left,right] duration-300"
        style={{
          left: 16,
          right: narrativeDrawerOpen ? 356 : 16,
        }}
      >
        <div className="pointer-events-auto max-w-full">{navContent}</div>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        data-cv-spotlight-toggle
        aria-pressed={enabled}
        title="增量聚光灯：已读未变的节点退为背景骨架，只看「我离开后发生了什么」（新增版本 / 新挂起决定 / Agent 新草案）"
        onClick={onToggle}
        className={`glx-pill-tactile inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap cursor-pointer border ${
          enabled
            ? 'bg-[color:color-mix(in_srgb,var(--cv-amber)_14%,var(--cv-panel))] text-[color:var(--cv-amber-ink)] border-[color:color-mix(in_srgb,var(--cv-amber)_45%,transparent)]'
            : 'text-[color:var(--cv-ink-3)] hover:text-[color:var(--cv-ink)] border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_10%,transparent)] hover:border-[color:color-mix(in_srgb,var(--cv-hairline-ink)_25%,transparent)]'
        }`}
      >
        <Sun className="w-3 h-3" aria-hidden="true" />
        <span>聚光灯</span>
        {enabled && (
          <span className="font-mono text-[10px] tabular-nums opacity-85">
            {total}
          </span>
        )}
      </button>
      {mode === 'both' && navContent}
    </span>
  );
}
