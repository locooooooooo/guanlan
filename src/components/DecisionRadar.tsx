import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Scale } from 'lucide-react';
import type { DecisionAssertion, DecisionSourceEvidence } from '../types/guanlan';
import { formatOfficeAnchorLabel, pickPrimaryOfficeEvidence } from '../utils/officeAnchor';
import { formatPdfAnchorLabel, pickPrimaryPdfEvidence } from '../utils/pdfAnchor';
// 统一状态机 SSOT（方案 F2）：决策状态词表与未决口径单一出口——
// DECIDED_STATUSES 与 HomeView 卡 A 的双份过滤实现收敛（AC-01 四视图同词）
import {
  DECIDED_DECISION_STATUSES,
  DECISION_STATUS_CONFIRMED,
  DECISION_STATUS_CONFLICT,
  DECISION_STATUS_PENDING,
  DECISION_STATUS_REJECTED,
  DECISION_STATUS_SHELVED,
  DECISION_STATUS_SUPERSEDED,
  unresolvedDecisionCount,
} from '../utils/stateProjection';
import { cleanDisplayText } from '../utils/displayText';

/**
 * pm_4：未决决策雷达（全程只读）。
 *
 * - 只读：DecisionAssertion 没有审批动作字段，服务端也没有写决策的路径；
 *   这里只有「展开 / 跳到证据原文」两种交互，不提供确认/否决/搁置/签批。
 * - 口径：未决 = 待确认 + 来源不一致（冲突）；状态未知单列「待核对」，不计入 N；
 *   已取代不算未决，归入「已定案」。
 * - 候选决策（isCandidateOnly）不计入 N、不进列表。
 * - 排序用 impactBlocked.length 作「阻塞任务数」代理（没有验收临近度数据，不伪造）。
 */
interface DecisionRadarProps {
  decisions: DecisionAssertion[];
  /** V03 SSOT：服务端全库未决待拍板真实总数（缺省时回退本地计算，兼容单测） */
  unresolvedTotal?: number | null;
  onOpenDecision: (decisionId: string, targetEvidence?: DecisionSourceEvidence) => void;
  /** v0.8 R5 受控展开信号：App 侧递增计数（如左栏主导航「未决决策」命中）经 TopHeader
   *  转发进来；>0 即展开面板。收起仍归本地状态（Esc/外点/再点按钮），信号不反向收起 */
  openSignal?: number;
}

// 状态字色 → stage-ink -text 深档（玻璃 ≥4.5 AA；同步胶囊三态同款映射：
// 待确认=decision、来源不一致=anomaly、已确认=deliver；未定局状态一律 --ink-soft）。
// 方案 F2：键取 stateProjection 决策词表常量，状态词不再就地硬编码
const STATUS_TEXT_COLORS: Record<string, string> = {
  [DECISION_STATUS_PENDING]: 'text-[color:var(--stage-ink-decision-text)]',
  [DECISION_STATUS_CONFLICT]: 'text-[color:var(--stage-ink-anomaly-text)]',
  [DECISION_STATUS_CONFIRMED]: 'text-[color:var(--stage-ink-deliver-text)]',
  [DECISION_STATUS_REJECTED]: 'text-[color:var(--ink-soft)]',
  [DECISION_STATUS_SHELVED]: 'text-[color:var(--ink-soft)]',
  [DECISION_STATUS_SUPERSEDED]: 'text-[color:var(--ink-soft)]',
  '未知': 'text-[color:var(--ink-soft)]',
};

/** 阻塞数降序；同数时按编号稳定排序，避免每次展开跳位 */
const byBlocked = (a: DecisionAssertion, b: DecisionAssertion) =>
  b.impactBlocked.length - a.impactBlocked.length ||
  a.code.localeCompare(b.code, 'zh-Hans-CN');

/** 分区折叠体（默认收起；只控制显隐，不触任何数据逻辑） */
const Disclosure: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({
  title,
  count,
  children,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-1 py-1 rounded text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] transition-colors"
      >
        <span className="flex items-center gap-1">
          <ChevronDown
            className={`w-3 h-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          <span>{title}</span>
        </span>
        <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]">{count}</span>
      </button>
      {open && <div className="mt-1 space-y-1">{children}</div>}
    </div>
  );
};

export const DecisionRadar: React.FC<DecisionRadarProps> = ({
  decisions,
  unresolvedTotal,
  onOpenDecision,
  openSignal,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // v0.8 R5 受控展开：信号变化且 >0 时展开（仅单向触发，不与本地关闭逻辑打架）
  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true);
  }, [openSignal]);

  // 点外面 / Esc 关闭：自包含，宿主无需接线
  useEffect(() => {
    if (!open) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 浮层先吃掉这一次 Esc：不拦冒泡的话 App 的全局 Esc 会接着切回全景溯源，
        // 一次按键既关面板又换工作区，阅读现场（滚动位/纸面/行号）随之丢失
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // 只统计真实决策：候选（isCandidateOnly）只作为线索，不计入任何分区
  const considered = useMemo(
    () => decisions.filter((d) => !d.isCandidateOnly),
    [decisions]
  );
  const conflicts = useMemo(
    () => considered.filter((d) => d.status === DECISION_STATUS_CONFLICT).sort(byBlocked),
    [considered]
  );
  const pending = useMemo(
    () => considered.filter((d) => d.status === DECISION_STATUS_PENDING).sort(byBlocked),
    [considered]
  );
  const decided = useMemo(
    () => considered.filter((d) => DECIDED_DECISION_STATUSES.includes(d.status)).sort(byBlocked),
    [considered]
  );
  // 未决/已定案之外的都进「待核对」：服务端若给出未知状态字符串也不会从列表里消失，
  // 保证非候选决策全量可枚举
  const unknown = useMemo(
    () =>
      considered
        .filter(
          (d) =>
            !DECIDED_DECISION_STATUSES.includes(d.status) &&
            d.status !== DECISION_STATUS_PENDING &&
            d.status !== DECISION_STATUS_CONFLICT
        )
        .sort(byBlocked),
    [considered]
  );
  // 未决计数单一出口（V03 SSOT：优先消费服务端全库未决总数，消除 288 vs 100 分页分裂；
  // 缺省时回退本地 stateProjection.unresolvedDecisionCount，单测与旧后端零破坏）
  const loadedUnresolvedCount = unresolvedDecisionCount(considered);
  const unresolvedCount =
    typeof unresolvedTotal === 'number' && unresolvedTotal >= 0
      ? unresolvedTotal
      : loadedUnresolvedCount;

  const renderRow = (dec: DecisionAssertion) => {
    const firstEvidence = dec.evidences[0];
    const officeEvidence = pickPrimaryOfficeEvidence(dec);
    const pdfEvidence = pickPrimaryPdfEvidence(dec);
    const hasEvidence = Boolean(firstEvidence || officeEvidence || pdfEvidence);
    const target = firstEvidence
      ? `${firstEvidence.relative_path}:${firstEvidence.lineStart}`
      : '';
    const officeLabel = officeEvidence?.officeAnchor
      ? formatOfficeAnchorLabel(officeEvidence.officeAnchor)
      : '';
    const pdfLabel = pdfEvidence?.pdfAnchor
      ? formatPdfAnchorLabel(pdfEvidence.pdfAnchor)
      : '';
    const leftAccent =
      dec.status === DECISION_STATUS_CONFLICT
        ? 'border-l-[color:var(--stage-ink-anomaly)]'
        : dec.status === DECISION_STATUS_PENDING
          ? 'border-l-[color:var(--stage-ink-decision)]'
          : dec.status === DECISION_STATUS_CONFIRMED
            ? 'border-l-[color:var(--stage-ink-deliver)]'
            : 'border-l-[color:var(--ink-faint)]';
    return (
      <div
        key={dec.decision_id}
        className={`rounded-[10px] border border-l-[3px] ${leftAccent} motion-safe:transition-all ${
          hasEvidence
            ? 'bg-card border-[color:var(--glass-hairline)] shadow-[0_1px_3px_rgba(38,36,61,0.04)] hover:border-[color:var(--btn-secondary-border-hover)] hover:shadow-[0_6px_16px_-4px_rgba(74,62,148,0.12)] hover:[transform:translateY(-1px)]'
            : 'bg-card/60 border-[color:var(--glass-hairline)] opacity-60'
        }`}
      >
        <button
          type="button"
          disabled={!hasEvidence}
          title={
            hasEvidence
              ? `跳到首条证据原文：${target}`
              : '无证据可跳转（该决策尚未解析到可定位的来源行）'
          }
          onClick={() => {
            if (!hasEvidence) return;
            onOpenDecision(dec.decision_id);
            setOpen(false);
          }}
          className={`w-full text-left px-3 py-2.5 ${hasEvidence ? 'cursor-pointer' : 'cursor-not-allowed'}`}
        >
          <div className="flex items-start gap-2">
            <span
              className={`shrink-0 mt-0.5 rounded px-1.5 py-0.5 font-mono text-[10.5px] leading-none font-semibold ${
                dec.code === 'P0'
                  ? 'bg-[color:color-mix(in_srgb,var(--stage-ink-anomaly)_14%,transparent)] text-[color:var(--stage-ink-anomaly-text)]'
                  : dec.code === 'P1'
                    ? 'bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_14%,transparent)] text-[color:var(--stage-ink-decision-text)]'
                    : 'bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-ink)]'
              }`}
            >
              {dec.code}
            </span>
            <span className="flex-1 min-w-0 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium text-[color:var(--ink-strong)] line-clamp-2">
              {cleanDisplayText(dec.question) || dec.question}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] tabular-nums">
            <span className={`font-medium ${STATUS_TEXT_COLORS[dec.status] ?? 'text-[color:var(--ink-soft)]'}`}>
              {dec.status}
            </span>
            <span aria-hidden="true" className="opacity-35">·</span>
            <span>证据 {dec.evidences.length}</span>
            <span aria-hidden="true" className="opacity-35">·</span>
            <span>阻塞 {dec.impactBlocked.length}</span>
            {!hasEvidence && <span className="text-[color:var(--ink-soft)]">· 无证据可跳转</span>}
          </div>
        </button>
        {officeEvidence && officeLabel && (
          <div className="px-3 pb-2 -mt-1 flex items-center">
            <button
              type="button"
              onClick={() => {
                onOpenDecision(dec.decision_id, officeEvidence);
                setOpen(false);
              }}
              title={`一键直达 Office 证据：${officeEvidence.relative_path}#${officeLabel}`}
              className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_11%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_19%,transparent)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--accent-iris-ink)] cursor-pointer transition-colors"
            >
              <span>直达表/段：{officeLabel}</span>
            </button>
          </div>
        )}
        {pdfEvidence && pdfLabel && (
          <div className="px-3 pb-2 -mt-1 flex items-center">
            <button
              type="button"
              onClick={() => {
                onOpenDecision(dec.decision_id, pdfEvidence);
                setOpen(false);
              }}
              title={`一键直达 PDF 页码证据：${pdfEvidence.relative_path}#page=${pdfEvidence.pdfAnchor?.page}`}
              className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_11%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_19%,transparent)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--accent-iris-ink)] cursor-pointer transition-colors"
            >
              <span>直达页：{pdfLabel}</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`未决决策 ${unresolvedCount}`}
        title={
          unresolvedCount > 0
            ? `有 ${unresolvedCount} 项待拍板决策 · 点击查看证据原文`
            : '未决决策（当前 0 项）· 点击查看已定案决策'
        }
        className={`glx-pill-tactile h-[var(--ctl-h-sm)] px-2.5 rounded-[var(--r-pill)] border flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
          unresolvedCount > 0
            ? 'bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_14%,var(--card))] border-[color:color-mix(in_srgb,var(--stage-ink-decision)_45%,transparent)] text-[color:var(--stage-ink-decision-text)] hover:border-[color:color-mix(in_srgb,var(--stage-ink-decision)_70%,transparent)] shadow-[0_2px_8px_-2px_rgba(168,118,43,0.22)]'
            : 'bg-card/65 border-border text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:bg-card hover:border-[color:var(--btn-secondary-border-hover)]'
        }`}
      >
        {unresolvedCount > 0 ? (
          <span
            aria-hidden="true"
            className="glx-live-dot size-1.5 shrink-0 rounded-full bg-[color:var(--stage-ink-decision)] text-[color:var(--stage-ink-decision)]"
          />
        ) : (
          <Scale className="w-3 h-3 shrink-0 opacity-75" />
        )}
        {unresolvedCount > 0 && (
          <span className="hidden lg:inline text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-medium">
            待拍板
          </span>
        )}
        <span className="font-mono text-[length:var(--text-micro)] font-semibold tabular-nums">
          {unresolvedCount}
        </span>
        <ChevronDown
          className={`w-3 h-3 shrink-0 motion-safe:transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* data-esc-layer="open"：Esc 仲裁锚点——事件链/叙事抽屉的 window capture 级
          Esc 监听（KnowledgeGraph/CanvasNarrativeDrawer）命中此标记时让位，
          保住上方 handleKeyDown 的 document bubble 关闭路径（stopPropagation 收尾）；
          缺标记时 capture 层会 stopImmediatePropagation 吞掉本次 Esc，trail 反被静默弹层 */}
      {open && (
        <div
          role="region"
          aria-label="未决决策面板"
          data-esc-layer="open"
          className="glass-pop glx-popover-in absolute right-0 top-full mt-2 w-[392px] max-h-[70vh] overflow-y-auto rounded-[16px] z-50 p-3.5 space-y-2.5"
        >
          <div className="flex items-baseline justify-between gap-2 px-1 pb-1.5 border-b border-[#26243D]/10">
            <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-strong)]">
              未决决策 {unresolvedCount}
            </span>
            <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
              只读 · 点一行跳到首条证据原文
            </span>
          </div>

          {unresolvedCount === 0 && (
            <p className="px-1 py-2 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">
              当前没有未决决策。
            </p>
          )}

          {/* 冲突（来源不一致）置顶，其次待确认；每组内按阻塞数降序 */}
          {conflicts.length > 0 && (
            <div className="space-y-2">
              <div className="px-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-semibold tracking-[0.16em] text-[color:var(--stage-ink-anomaly-text)]">
                {`冲突 · ${DECISION_STATUS_CONFLICT}`}
              </div>
              {conflicts.map(renderRow)}
            </div>
          )}
          {pending.length > 0 && (
            <div className="space-y-2">
              <div className="px-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-semibold tracking-[0.16em] text-[color:var(--stage-ink-decision-text)]">
                {DECISION_STATUS_PENDING}
              </div>
              {pending.map(renderRow)}
            </div>
          )}

          {/* 非候选决策全量可枚举：已定案 / 状态未知 两个折叠区 */}
          <div className="pt-1 border-t border-[#26243D]/10 space-y-1">
            <Disclosure title="已定案（已确认/已否决/已搁置/已取代）" count={decided.length}>
              {decided.length === 0 ? (
                <p className="px-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">暂无已定案决策。</p>
              ) : (
                decided.map(renderRow)
              )}
            </Disclosure>
            <Disclosure title="状态未知（待核对）" count={unknown.length}>
              {unknown.length === 0 ? (
                <p className="px-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">暂无待核对决策。</p>
              ) : (
                unknown.map(renderRow)
              )}
            </Disclosure>
          </div>
        </div>
      )}
    </div>
  );
};
