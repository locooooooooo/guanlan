import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import type {
  OrphanRepairAction,
  ReviewBoardBucket,
  ReviewBoardCard,
  ReviewBoardCounts,
  ReviewBoardDraftBrief,
  ReviewBoardPendingStatement,
  ReviewBoardResponse,
} from '../services/apiTypes';
import { Button, IconButton } from './ui/primitives';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  ScrollArea,
} from './ui';

/**
 * 轻量「批阅看板」抽屉（五态分栏：待拍板 / 可派发 / Agent 运行中 /
 * 待批阅回执 / 已办结 + 失联/无回执诚实 unknown 孤儿诊断与安全修复入口）。
 *
 * 停机红线守卫：
 *  - 严禁提供任何「跳过人工审阅直接完结」按钮；
 *  - 无回执或进程失联一律诚实标 `unknown`，仅允许「重置为可派发」或「挂起待人工核查」；
 *  - 点击「已知悉」强制走后端 CAS 写回原 `.md` + SQLite 提交 + 状态机重算，三处状态同步。
 *
 * 视觉降噪与正向动效退场：
 *  - 抽屉统一接入 `.glx-t-panel` 弹簧抽屉双轨（两段式入场，rAF 翻转终态；
 *    与 FileTimelineDrawer 一致），不叠挂 `glx-drawer-in` 一次性 keyframes；
 *  - 顶部 6 态琉璃比例分布带（纯计算 `computeReviewBoardRatioBand`），
 *    替代顶栏冗长文字说明；段宽走静态 flex-grow 权重（零布局动画），
 *    整条带入场复用 `.glx-progress-grow`（scaleX 生长，reduce 已登记）；
 *  - 泳道主次分层：待拍板 / 待批阅回执为行动泳道（primary），已办结默认降噪
 *    （muted：不渲染 bucket_reason、收紧内距、标题转次文）；unknown 恒 secondary，
 *    诚实标示绝不降噪（停机红线）；
 *  - 「已知悉 / 孤儿修复」成功后的翠绿勾选脉冲（`.glx-ack-mark`）与卡片顺滑退场
 *    （`.glx-card-settle`）：唯一合法触发源 = store 的 `notice.kind === 'ok'`
 *    （即后端 CAS 确认成功分支）；CAS 冲突分支 store 恒记 error，绝不染绿。
 */

export type ReviewBoardFilter = 'all' | ReviewBoardBucket;

export const REVIEW_BOARD_LANES: ReadonlyArray<{
  key: ReviewBoardBucket;
  label: string;
  description: string;
}> = [
  { key: 'pending_decision', label: '待拍板', description: '存在阻塞级 P0/P1 未决或人工挂起' },
  { key: 'awaiting_receipt', label: '待批阅回执', description: '智能体已交草案回执，须经人工批阅' },
  { key: 'dispatchable', label: '可派发', description: '阻塞已清零，可交办智能体或推进下一步' },
  { key: 'agent_running', label: 'Agent 运行中', description: '执行/交付槽活跃运行，等待回执' },
  { key: 'completed', label: '已办结', description: '全部清单、拍板与回执核验已完成' },
  { key: 'unknown', label: '状态未知', description: '无回执或进程失联，需人工孤儿修复' },
];

/** 按分栏过滤看板卡片（纯函数，单测锁定） */
export function filterReviewBoardCards(
  items: readonly ReviewBoardCard[],
  filter: ReviewBoardFilter
): ReviewBoardCard[] {
  if (filter === 'all') return [...items];
  return items.filter((item) => item.bucket === filter);
}

/** 格式化失联耗时（秒 → 中文可读串） */
export function formatStallDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} 秒`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours} 小时 ${remMins} 分钟` : `${hours} 小时`;
}

/** 看板需人工关注总数（待拍板 + 待批阅回执 + 状态未知） */
export function reviewBoardAttentionCount(board: ReviewBoardResponse | null): number {
  if (!board) return 0;
  return (
    board.counts.pending_decision +
    board.counts.awaiting_receipt +
    board.counts.unknown
  );
}

/** 泳道主次权重：行动泳道（待拍板 / 待批阅回执）视觉强化为 primary；
 *  dispatchable / agent_running 归 secondary；已办结默认视觉降噪为 muted。
 *  ⚠ unknown 恒 secondary——诚实标示绝不被降噪弱化（停机红线）。 */
export type ReviewBoardLaneTier = 'primary' | 'secondary' | 'muted';

export function reviewBoardLanePriority(bucket: ReviewBoardBucket): ReviewBoardLaneTier {
  switch (bucket) {
    case 'pending_decision':
    case 'awaiting_receipt':
      return 'primary';
    case 'dispatchable':
    case 'agent_running':
    case 'unknown':
      return 'secondary';
    case 'completed':
      return 'muted';
  }
}

/** 六态比例带段：颜色只引用既有语义令牌（graphic 档），零新增色值。 */
export interface ReviewBoardRatioSegment {
  bucket: ReviewBoardBucket;
  label: string;
  color: string;
  count: number;
  /** 展示用四舍五入整数百分比（分母 = 六态分项和） */
  pct: number;
  /** 布局权重（= count）：flex-grow 天然守恒，段宽为静态布局、零动画布局属性 */
  weight: number;
  /** 零态剔除：count === 0 的段不进比例带 */
  visible: boolean;
}

export interface ReviewBoardRatioBand {
  segments: ReviewBoardRatioSegment[];
  /** 诚实分母 = 六态分项和；与 counts.total 不符时以分项和为准，不伪装占比 */
  total: number;
  /** 服务端 total 原样透出（仅对照，不参与占比计算） */
  totalCount: number;
  /** 分项和为 0 的诚实空态（即便 counts.total 非 0 也不伪造占比） */
  empty: boolean;
}

const BUCKET_RATIO_COLOR: Record<ReviewBoardBucket, string> = {
  pending_decision: 'var(--stage-ink-decision)',
  awaiting_receipt: 'var(--accent-iris)',
  dispatchable: 'var(--stage-ink-deliver)',
  agent_running: 'var(--accent-wave)',
  completed: 'var(--ink-soft)',
  unknown: 'var(--stage-ink-anomaly)',
};

/** 六态琉璃比例分布带纯计算：按 REVIEW_BOARD_LANES 键序产出六段、
 *  零态剔除、诚实分母（分项和）与空态判定。 */
export function computeReviewBoardRatioBand(counts: ReviewBoardCounts): ReviewBoardRatioBand {
  const segments: ReviewBoardRatioSegment[] = REVIEW_BOARD_LANES.map((lane) => {
    const count = Math.max(0, Math.floor(counts[lane.key] ?? 0));
    return {
      bucket: lane.key,
      label: lane.label,
      color: BUCKET_RATIO_COLOR[lane.key],
      count,
      pct: 0,
      weight: count,
      visible: count > 0,
    };
  });
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  for (const seg of segments) {
    seg.pct = total > 0 ? Math.round((seg.count / total) * 100) : 0;
  }
  return { segments, total, totalCount: counts.total, empty: total === 0 };
}

/** 由 statement_id 反查所在事项卡（「已知悉」成功反馈的定位出口，纯函数） */
export function findInitiativeIdByStatement(
  items: readonly ReviewBoardCard[],
  statementId: string
): string | null {
  for (const card of items) {
    if (card.pending_statements.some((stmt) => stmt.statement_id === statementId)) {
      return card.initiative_id;
    }
  }
  return null;
}

export interface ReviewBoardDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  board: ReviewBoardResponse | null;
  loading: boolean;
  error: string | null;
  busyKey: string | null;
  notice: { kind: 'ok' | 'error'; message: string } | null;
  onRefresh: () => void;
  onJumpToStatement: (stmt: ReviewBoardPendingStatement) => void;
  onAcknowledgeStatement: (stmt: ReviewBoardPendingStatement) => void;
  onInspectDraft: (draft: ReviewBoardDraftBrief) => void;
  onRepairOrphan: (initiativeId: string, nodeId: string, action: OrphanRepairAction) => void;
}

const BUCKET_BADGE_STYLE: Record<ReviewBoardBucket, string> = {
  pending_decision:
    'border-[color:var(--stage-ink-decision)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_12%,transparent)] text-[color:var(--stage-ink-decision-text)]',
  awaiting_receipt:
    'border-[color:var(--accent-iris)] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-deep)]',
  dispatchable:
    'border-[color:var(--stage-ink-deliver)] bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_10%,transparent)] text-[color:var(--stage-ink-deliver-text)]',
  agent_running:
    'border-[color:var(--accent-wave)] bg-[color:color-mix(in_srgb,var(--accent-wave)_12%,transparent)] text-[color:var(--ink-strong)]',
  completed:
    'border-[color:var(--glass-hairline)] bg-[color:var(--depth-1-bg)] text-[color:var(--ink-soft)]',
  unknown:
    'border-[color:var(--stage-ink-anomaly)] bg-[color:color-mix(in_srgb,var(--stage-ink-anomaly)_12%,transparent)] text-[color:var(--stage-ink-anomaly-text)]',
};

/** 反馈相位计时（与 motion.css 令牌对齐的 JS 镜像，仅推进相位，不定义样式）：
 *  pulse = 徽记弹出 --dur-2(180ms) + 光环扩散 --dur-3(260ms) + 余量；
 *  exit = 卡片退场 --dur-3(260ms) + 余量。 */
const ACK_PULSE_PHASE_MS = 520;
const ACK_EXIT_PHASE_MS = 280;

type SettledAction = {
  initiativeId: string;
  mode: 'ack' | 'repair';
  phase: 'pulse' | 'exit';
};

export const ReviewBoardDrawer: React.FC<ReviewBoardDrawerProps> = ({
  isOpen,
  onClose,
  board,
  loading,
  error,
  busyKey,
  notice,
  onRefresh,
  onJumpToStatement,
  onAcknowledgeStatement,
  onInspectDraft,
  onRepairOrphan,
}) => {
  const [filter, setFilter] = useState<ReviewBoardFilter>('all');
  // 弹簧抽屉两段式入场：首帧偏移态（translateX + opacity:0）→ rAF 翻转终态，
  // 过渡由 .glx-t-panel 双轨承担（transform→spring / opacity→fade，只动这两属性）。
  // reduce 用户走 motion.css 既有 .glx-t-panel → transition:none，第二帧瞬时落位。
  const [entered, setEntered] = useState(false);
  // 正向反馈：后端 CAS 确认成功（notice.kind === 'ok'）后的勾选脉冲与卡片退场
  const [settledAction, setSettledAction] = useState<SettledAction | null>(null);
  const [settledHidden, setSettledHidden] = useState<string[]>([]);
  const prevBusyRef = useRef<string | null>(null);
  const lastBoardRef = useRef<ReviewBoardResponse | null>(board);

  useEffect(() => {
    if (!isOpen) {
      setEntered(false);
      setSettledAction(null);
      setSettledHidden([]);
      return;
    }
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, [isOpen]);

  // 正向反馈唯一触发源：busyKey 释放沿 + store notice.kind === 'ok'
  // （即 postDecisionResolve → pollJobUntilSettled → completed 且非 CAS 冲突）。
  // CAS 冲突分支 store 恒记 error → 此处永不触发；点击回调绝不直接触发。
  useEffect(() => {
    const prev = prevBusyRef.current;
    prevBusyRef.current = busyKey;
    if (!prev || prev === busyKey || busyKey !== null) return;
    if (notice?.kind !== 'ok') return;
    if (prev.startsWith('ack:')) {
      const initiativeId = findInitiativeIdByStatement(board?.items ?? [], prev.slice(4));
      if (initiativeId) setSettledAction({ initiativeId, mode: 'ack', phase: 'pulse' });
    } else if (prev.startsWith('repair:')) {
      const initiativeId = prev.split(':')[1] ?? '';
      if (initiativeId) setSettledAction({ initiativeId, mode: 'repair', phase: 'pulse' });
    }
  }, [busyKey, notice, board]);

  // 相位推进：pulse（徽记弹出 + 光环）→ exit（卡片淡出下沉）→ 隐藏，等数据刷新归位
  useEffect(() => {
    if (!settledAction) return;
    const { initiativeId, phase } = settledAction;
    const delay = phase === 'pulse' ? ACK_PULSE_PHASE_MS : ACK_EXIT_PHASE_MS;
    const timer = window.setTimeout(() => {
      setSettledAction((current) => {
        if (!current || current.initiativeId !== initiativeId) return current;
        return phase === 'pulse' ? { ...current, phase: 'exit' } : null;
      });
      if (phase === 'exit') {
        setSettledHidden((current) =>
          current.includes(initiativeId) ? current : [...current, initiativeId]
        );
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [settledAction]);

  // 看板数据刷新到达（refreshReviewBoard 成功分支必发）→ 清空本地退场排除，
  // 让处理完的专项以新 bucket 重新归位
  useEffect(() => {
    if (lastBoardRef.current !== board) {
      lastBoardRef.current = board;
      setSettledHidden([]);
    }
  }, [board]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const items = board?.items ?? [];
  const filtered = filterReviewBoardCards(items, filter);
  const visibleCards = filtered.filter(
    (card) => !settledHidden.includes(card.initiative_id)
  );

  const counts = board?.counts ?? {
    pending_decision: 0,
    dispatchable: 0,
    agent_running: 0,
    awaiting_receipt: 0,
    completed: 0,
    unknown: 0,
    total: 0,
  };
  const band = computeReviewBoardRatioBand(counts);
  const bandAria =
    `批阅看板六态分布，共 ${band.total} 项：` +
    band.segments.map((seg) => `${seg.label} ${seg.count}`).join(' · ');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="批阅看板"
      data-esc-layer="open"
      data-review-board-drawer=""
      className="glx-backdrop-in fixed inset-0 z-50 bg-[color:var(--ink-anchor)]/38 dark:bg-black/62 backdrop-blur-sm flex justify-end p-2 sm:p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* coss Sheet (variant="inset") 悬浮抽屉材质 + glx-t-panel 弹簧双轨入场 */}
      <div
        data-sheet-variant="inset"
        className="glx-t-panel bg-popover/95 dark:bg-popover/95 backdrop-blur-2xl w-full max-w-2xl h-full flex flex-col overflow-hidden rounded-2xl border border-border/85 text-foreground"
        style={{
          // 弹簧抽屉入场只动 transform/opacity（glx-t-panel 双轨）；禁动画 right/width
          transform: entered ? 'none' : 'translateX(32px)',
          opacity: entered ? 1 : 0,
          boxShadow: 'var(--glass-shadow-pop)',
        }}
      >
        {/* Header · 精密悬浮顶栏（明暗双态自适应） */}
        <div
          className="px-6 py-4 bg-card/85 backdrop-blur-md border-b border-border/80 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_14%,transparent)] text-[color:var(--stage-ink-decision-text)] shrink-0">
              <ClipboardList className="w-4 h-4" />
            </span>
            <h2 className="font-serif-claude text-[17px] leading-[1.35] font-semibold tracking-[-0.01em] truncate">
              批阅看板 · HITL 拍板与回执联动
            </h2>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={onRefresh}
              className="cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>刷新</span>
            </Button>
            <IconButton label="关闭批阅看板" onClick={onClose} className="cursor-pointer">
              <X />
            </IconButton>
          </div>
        </div>

        {/* 六态比例分布带 + Lane filter bar（比例带替代顶栏冗长文字说明） */}
        <div
          className="px-6 py-3 border-b border-border/75 bg-muted/35 space-y-2.5"
          data-review-board-lanes=""
        >
          {band.empty ? (
            <div
              data-review-board-ratio-band="empty"
              className="flex h-2 w-full items-center justify-center rounded-full bg-muted"
            >
              <span className="sr-only">看板暂无在办事项，六态分布带为空</span>
            </div>
          ) : (
            <div
              role="img"
              aria-label={bandAria}
              data-review-board-ratio-band=""
              className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="glx-progress-grow flex h-full w-full gap-px">
                {band.segments
                  .filter((seg) => seg.visible)
                  .map((seg) => (
                    <div
                      key={seg.bucket}
                      data-board-ratio-seg={seg.bucket}
                      title={`${seg.label} ${seg.count} 项 · 占 ${seg.pct}%`}
                      className="h-full min-w-[3px]"
                      style={{ flexGrow: seg.weight, flexBasis: 0, background: seg.color }}
                    />
                  ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={filter === 'all'}
              data-board-filter="all"
              onClick={() => setFilter('all')}
              className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] transition-colors tabular-nums ${
                filter === 'all'
                  ? 'border-[color:var(--ink-anchor)] bg-[color:var(--ink-anchor)] text-[color:var(--paper-on-ink)]'
                  : 'border-border bg-card/75 text-muted-foreground hover:text-foreground'
              }`}
            >
              全部 ({counts.total})
            </button>
            {REVIEW_BOARD_LANES.map((lane) => {
              const count = counts[lane.key];
              const active = filter === lane.key;
              return (
                <button
                  key={lane.key}
                  type="button"
                  aria-pressed={active}
                  data-board-filter={lane.key}
                  title={lane.description}
                  onClick={() => setFilter(lane.key)}
                  className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] transition-colors tabular-nums ${
                    active
                      ? BUCKET_BADGE_STYLE[lane.key]
                      : 'border-border bg-card/75 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {lane.label} ({count})
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <ScrollArea scrollFade className="flex-1 min-h-0">
        <div className="p-6 space-y-3">
          {notice && (
            <div
              role="status"
              data-review-board-notice=""
              className={`rounded-[10px] border px-3 py-2 text-[length:var(--text-ui)] leading-[var(--lh-ui)] ${
                notice.kind === 'ok'
                  ? 'border-[color:var(--stage-ink-deliver)] bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_10%,transparent)] text-[color:var(--stage-ink-deliver-text)]'
                  : 'border-[color:var(--stage-ink-anomaly)] bg-[color:color-mix(in_srgb,var(--stage-ink-anomaly)_10%,transparent)] text-[color:var(--stage-ink-anomaly-text)]'
              }`}
            >
              {notice.message}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-[10px] border border-[color:var(--stage-ink-anomaly)] bg-[color:color-mix(in_srgb,var(--stage-ink-anomaly)_10%,var(--card))] px-3.5 py-2.5 text-[length:var(--text-ui)] text-[color:var(--stage-ink-anomaly-text)]"
            >
              批阅看板加载失败：{error}
            </div>
          )}

          {!error && visibleCards.length === 0 && (
            <Empty className="rounded-2xl border border-dashed border-border/80 bg-card/65 py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ClipboardList className="size-4" />
                </EmptyMedia>
                <EmptyTitle>{loading ? '正在加载批阅看板…' : '当前分栏下暂无事项卡'}</EmptyTitle>
                <EmptyDescription>
                  {loading
                    ? '正在核对本地任务槽位与待拍板陈述'
                    : '所有需人工拍板与智能体回执事项均已清零，可切换上部分栏查看历史记录'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {visibleCards.map((card) => {
            const laneTier = reviewBoardLanePriority(card.bucket);
            const settled =
              settledAction && settledAction.initiativeId === card.initiative_id
                ? settledAction
                : null;
            return (
              <div
                key={card.initiative_id}
                data-board-card={card.initiative_id}
                data-board-bucket={card.bucket}
                data-board-tier={laneTier}
                className={`depth-2-card relative space-y-2.5 ${
                  laneTier === 'muted' ? 'p-3' : 'p-4'
                } ${settled?.phase === 'exit' ? 'glx-card-settle' : ''}`}
              >
                {/* 翠绿勾选徽记：后端 CAS 确认成功后的唯一正向反馈装饰（aria-hidden 纯装饰层） */}
                {settled && (
                  <span
                    aria-hidden="true"
                    data-board-ack-pulse={card.initiative_id}
                    data-board-ack-pulse-mode={settled.mode}
                    className="glx-ack-mark absolute right-4 top-4 z-10 inline-flex size-6 items-center justify-center rounded-full text-white"
                    style={{ background: 'var(--stage-ink-deliver)' }}
                  >
                    <Check className="w-3.5 h-3.5" strokeWidth={3} />
                  </span>
                )}

                {/* Card top row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium ${BUCKET_BADGE_STYLE[card.bucket]}`}
                      >
                        {card.bucket_label}
                      </span>
                      <span
                        className={`font-semibold text-[length:var(--text-ui-body)] truncate ${
                          laneTier === 'muted'
                            ? 'text-[color:var(--ink-soft)]'
                            : 'text-[color:var(--ink-strong)]'
                        }`}
                      >
                        {card.name}
                      </span>
                      <span className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                        阶段：{card.current_stage}
                      </span>
                    </div>
                    {laneTier !== 'muted' && (
                      <p className="mt-1 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                        {card.bucket_reason}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-[10.5px] text-[color:var(--ink-faint)] tabular-nums">
                    {card.artifact_count} 份文档
                  </span>
                </div>

                {/* Pending P0/P1 statements: Jump to ReaderView OR one-click 「已知悉」 */}
                {card.pending_statements.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {card.pending_statements.map((stmt) => {
                      const isBusy = busyKey === `ack:${stmt.statement_id}`;
                      return (
                        <div
                          key={stmt.statement_id}
                          data-board-pending-stmt={stmt.statement_id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-[color:color-mix(in_srgb,var(--stage-ink-decision)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_6%,white)] px-2.5 py-1.5"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="font-mono text-[10.5px] font-semibold text-[color:var(--stage-ink-decision-text)] mr-1.5">
                              [{stmt.priority}]
                            </span>
                            <span className="text-[length:var(--text-ui)] text-[color:var(--ink-strong)]">
                              {stmt.question}
                            </span>
                            <span className="ml-1.5 font-mono text-[10.5px] text-[color:var(--ink-soft)]">
                              {stmt.path}#L{stmt.line_start}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onJumpToStatement(stmt)}
                              className="cursor-pointer"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>原位拍板</span>
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={isBusy}
                              data-board-ack-btn={stmt.statement_id}
                              onClick={() => onAcknowledgeStatement(stmt)}
                              className="cursor-pointer"
                                title="将此条以「已知悉」写回原 .md、扣减未决计数并解除下游阻塞"
                            >
                              <Check className="w-3 h-3" />
                              <span>{isBusy ? '写回中…' : '已知悉'}</span>
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Awaiting Agent drafts */}
                {card.proposed_drafts.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {card.proposed_drafts.map((draft) => (
                      <div
                        key={draft.draft_id}
                        data-board-draft={draft.draft_id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-[color:color-mix(in_srgb,var(--accent-iris)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--accent-iris)_6%,white)] px-2.5 py-1.5"
                      >
                        <div className="min-w-0 flex-1 text-[length:var(--text-ui)]">
                          <span className="font-mono text-[10.5px] font-semibold text-[color:var(--accent-iris-deep)] mr-1.5">
                            {draft.draft_version_label}
                          </span>
                          <span className="font-mono text-[color:var(--ink-strong)]">
                            {draft.path}
                          </span>
                          {draft.conflict && (
                            <span className="ml-1.5 text-[10.5px] text-[color:var(--stage-ink-anomaly-text)] font-medium">
                              · 并发冲突
                            </span>
                          )}
                          {draft.receipt_summary && (
                            <div className="text-[11px] text-[color:var(--ink-soft)] truncate">
                              回执：{draft.receipt_summary}
                            </div>
                          )}
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onInspectDraft(draft)}
                          className="cursor-pointer shrink-0"
                        >
                          查看 Diff 批阅
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Honest Unknown Orphan Diagnostic + Safe Repair Entry */}
                {card.orphan && (
                  <div
                    data-board-orphan={card.orphan.node_id}
                    className="rounded-[10px] border border-[color:var(--stage-ink-anomaly)] bg-[color:color-mix(in_srgb,var(--stage-ink-anomaly)_8%,white)] p-3 space-y-2"
                  >
                    <div className="flex items-start gap-2 text-[length:var(--text-ui)] text-[color:var(--stage-ink-anomaly-text)]">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-semibold">
                          孤儿/失联节点诊断（状态未知 · {card.orphan.stage}槽
                          {card.orphan.stalled_seconds > 0
                            ? ` · 已静默 ${formatStallDuration(card.orphan.stalled_seconds)}`
                            : ''}
                          ）
                        </div>
                        <p className="text-[length:var(--text-micro)] leading-[var(--lh-micro)]">
                          {card.orphan.reason}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyKey === `repair:${card.initiative_id}:reset_to_dispatchable`}
                        data-board-repair={`${card.initiative_id}:reset_to_dispatchable`}
                        onClick={() =>
                          onRepairOrphan(
                            card.initiative_id,
                            card.orphan!.node_id,
                            'reset_to_dispatchable'
                          )
                        }
                        className="cursor-pointer"
                      >
                        <Wrench className="w-3.5 h-3.5" />
                        <span>重置为可派发</span>
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyKey === `repair:${card.initiative_id}:mark_suspended_hitl`}
                        data-board-repair={`${card.initiative_id}:mark_suspended_hitl`}
                        onClick={() =>
                          onRepairOrphan(
                            card.initiative_id,
                            card.orphan!.node_id,
                            'mark_suspended_hitl'
                          )
                        }
                        className="cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>挂起待人工核查</span>
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </ScrollArea>
      </div>
    </div>
  );
};

export default ReviewBoardDrawer;
