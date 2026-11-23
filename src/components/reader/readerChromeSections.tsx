/**
 * D01-a 拆解 · 阅读器浮动 Chrome 层（任务卡 D01-a ②）。
 *
 * 从 ReaderView.tsx（原 2653-3093）原样迁入：返回面包屑横幅、新版本告警横幅、
 * 紧凑双层文件头（Row1 文档身份+阅读操作+文件菜单 / Row2 查看模式分段+所属专项
 * 五阶段 Stepper）。迁移纪律：JSX 与类名逐字一致（像素回归护栏）。
 *
 * ── U05（长任务卡 v1.1 §4）增补 ─────────────────────────────────────────
 *  ① 顶栏减密：CopyIdButton 与超长相对路径移入「标题轻悬浮信息卡 / ··· 菜单」，
 *     主行只留四大视觉锚点（衬线标题 / 版本演化胶囊 / 标为已读 / Zen·溯源·昼夜）。
 *  ② 文档迷你版本轴：点版本胶囊展开玻璃微型修订链（vN → … → v1，按修订链序，
 *     禁改按日期排），支持一键切版比对与「进入版本时光机 →」直达 U04 画布。
 *  ③ 专注纸面（Zen）：状态机纯函数 + 顶栏一键入口 + 快捷键。
 *  ④ 阅读进度光条：2px 琉璃光条的唯一换算出口 computeReadingProgressScaleX
 *     （百分比 → scaleX；数据源复用 handleMarkdownScroll 已算好的 pct）。
 *  本文件所有新增计算均为无 DOM 依赖的纯函数（测试直接 import）。
 */

import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bookmark,
  CheckCircle2,
  FileCode,
  FileSpreadsheet,
  FileText,
  Focus,
  GitCompare,
  Info,
  Minimize2,
  Moon,
  MoreHorizontal,
  Network,
  PanelLeft,
  Sun,
} from 'lucide-react';
// v0.6 品牌界面升级（B1/B2）：阅读器 chrome 走字阶令牌与基础件——
// 控件开合（墨实心）＝Button primary/ghost 双态（§4.3 #8/#9/#10），图标钮＝IconButton（§4.1）
import { Button } from '../ui/primitives';
import { Group, GroupSeparator, Toolbar } from '../ui';
import { FileSystemActionBar } from '../FileContextMenu';
// 契约⑧①：observed_at 相对时间（「X 分钟前/今天 HH:mm」）——单一事实源在 utils/timeFormat.ts
import { formatRelativeObservedAt } from '../../utils/timeFormat';
import {
  DOC_STATE_LABEL,
  docStatePillClass,
  initiativeStateBadgeLine,
  revisionVersionLabel,
} from '../../utils/stateProjection';
import { formatUiMeta } from '../../utils/formatMeta';
import { STAGE_STEPS } from './readerMarkdownModel';
import { CopyIdButton } from './readerShared';
import type { ReaderCtx } from './useReaderController';
import type { ReaderSubMode } from './readerShared';

/* ══════════════════════════════════════════════════════════════════════════
   U05 · 纯函数层（无 DOM 依赖，测试直接 import）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * ① 阅读进度光条的唯一换算出口：百分比 → scaleX。
 * 纪律：光条只动 transform（GPU 合成器无重排），禁动画 width；
 * 百分比来自 handleMarkdownScroll 已算好的 pct（禁另起第二套口径）。
 * 越界值一律钳位：负值→0、>100→1、NaN→0、+∞→1、-∞→0。
 */
export function computeReadingProgressScaleX(percent: number): number {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return 0;
  if (!Number.isFinite(percent)) return percent > 0 ? 1 : 0;
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round((clamped / 100) * 1e4) / 1e4;
}

/** 迷你版本轴消费的版本结构（Revision 的结构子集，便于夹具直构）。 */
export interface MiniVersionAxisRevision {
  revision_id: string;
  versionNumber: number;
  observed_at: string;
  snapshotAvailable?: boolean;
  changedSectionsFromPrev?: string[];
}

/** 迷你版本轴单节点（按修订链序渲染：vN → … → v1）。 */
export interface MiniVersionAxisNode {
  revisionId: string;
  versionNumber: number;
  /** 版本徽标（vN，不带「（最新）」后缀——最新态由 isLatest 单独表达）。 */
  label: string;
  /** 是否为当前正在阅读（钉住）的版本。 */
  isCurrent: boolean;
  /** 是否为该文档的最新版本。 */
  isLatest: boolean;
  /** 采集时刻相对时间（observed_at 口径，绝不与 occurred_at 混写）。 */
  observedLabel: string;
  /** 变动概览（章节级变更 / 快照淘汰 / 无变更记录，如实三选一）。 */
  changeSummary: string;
  changedSectionCount: number;
  snapshotAvailable: boolean;
}

/** 变动概览单一出口：章节级变更优先，其次快照淘汰，最后「无变更记录」。 */
export function summarizeMiniVersionChange(rev: MiniVersionAxisRevision): string {
  const sections = (rev.changedSectionsFromPrev ?? []).filter(
    (section) => typeof section === 'string' && section.trim().length > 0
  );
  if (sections.length > 0) {
    const head = sections.slice(0, 2).join(' / ');
    return sections.length > 2
      ? `变更 ${sections.length} 节 · ${head} 等`
      : `变更 ${sections.length} 节 · ${head}`;
  }
  if (rev.snapshotAvailable === false) return '快照已淘汰（仅保留版本元数据）';
  return '无章节级变更记录';
}

/**
 * ② 文档迷你版本轴：把文件版本集映射为「修订链序」节点数组。
 * 纪律：按版本号降序（上新下旧 vN → v1）——与版本时光机「按修订链」同一叙事，
 * 绝不改按日期排序；observed_at 与 occurred_at 双口径绝不混写。
 */
export function buildMiniVersionAxis(
  revisions: readonly MiniVersionAxisRevision[] | null | undefined,
  currentRevisionId: string,
  latestRevisionId: string
): MiniVersionAxisNode[] {
  if (!Array.isArray(revisions)) return [];
  const usable = revisions.filter((rev) => Boolean(rev && rev.revision_id));
  const ordered = [...usable].sort((a, b) => {
    const av = Number.isFinite(a.versionNumber) ? a.versionNumber : 0;
    const bv = Number.isFinite(b.versionNumber) ? b.versionNumber : 0;
    return bv - av;
  });
  return ordered.map((rev) => ({
    revisionId: rev.revision_id,
    versionNumber: rev.versionNumber,
    label: `v${rev.versionNumber}`,
    isCurrent: rev.revision_id === currentRevisionId,
    isLatest: rev.revision_id === latestRevisionId,
    observedLabel: formatRelativeObservedAt(rev.observed_at),
    changeSummary: summarizeMiniVersionChange(rev),
    changedSectionCount: (rev.changedSectionsFromPrev ?? []).filter(Boolean).length,
    snapshotAvailable: rev.snapshotAvailable !== false,
  }));
}

/** ③ Zen 切换触发源（顶栏按钮 / 快捷键）。 */
export type ZenToggleTrigger = 'toolbar-button' | 'shortcut';

/** Zen 切换结果原因（诚实回执：被拦下时如实说明为何没切）。 */
export type ZenToggleReason =
  | 'toggled'
  | 'shortcut-ignored-editable'
  | 'shortcut-ignored-overlay'
  | 'shortcut-ignored-submode';

export interface ZenToggleInput {
  zenMode: boolean;
  trigger: ZenToggleTrigger;
  subMode: ReaderSubMode;
  /** 焦点在文本编辑面（input/textarea/select/contenteditable）。 */
  editableTarget: boolean;
  /** 任一浮层/对话框打开（data-esc-layer="open" 或 role="dialog"）。 */
  overlayOpen: boolean;
}

export interface ZenToggleResult {
  nextZenMode: boolean;
  applied: boolean;
  reason: ZenToggleReason;
}

/**
 * ④ 专注纸面（Zen）状态机纯函数：读态切换的唯一判定出口。
 * 顶栏按钮恒可切（退出专注的唯一路径）；快捷键在编辑面 / 浮层打开 / 非阅读态一律让路
 * （与全局快捷键纪律同源：编辑面一切键让路、浮层内键归浮层自己）。
 */
export function resolveZenToggle(input: ZenToggleInput): ZenToggleResult {
  const current = Boolean(input.zenMode);
  if (input.trigger === 'toolbar-button') {
    return { nextZenMode: !current, applied: true, reason: 'toggled' };
  }
  if (input.editableTarget) {
    return { nextZenMode: current, applied: false, reason: 'shortcut-ignored-editable' };
  }
  if (input.overlayOpen) {
    return { nextZenMode: current, applied: false, reason: 'shortcut-ignored-overlay' };
  }
  if (input.subMode !== 'read') {
    return { nextZenMode: current, applied: false, reason: 'shortcut-ignored-submode' };
  }
  return { nextZenMode: !current, applied: true, reason: 'toggled' };
}

/**
 * 可直达「版本时光机」的文档格式（与 KnowledgeGraph.tsx:94 TIME_MACHINE_FORMATS 同集合）。
 * 非此集合的格式不显示「进入版本时光机 →」入口——不做跳过去发现没有时光机的假入口。
 */
export const READER_TIME_MACHINE_FORMATS: ReadonlySet<string> = new Set([
  'md',
  'svg',
  'csv',
  'tsv',
  'xlsx',
]);

/** 该文档格式是否可直达版本时光机（纯函数，供 chrome 与 App 层共用口径）。 */
export function canOpenTimeMachine(format: string): boolean {
  return READER_TIME_MACHINE_FORMATS.has(format);
}

/** 1. Non-Intrusive New Version Alert Banner (§2.2, §5.3)；返回面包屑已并入文件头 Row 1 释放首屏阅读高度 */
export function ReaderTopBannerSection({ ctx }: { ctx: ReaderCtx }) {
  const {
    hasNewerRevisionWhileReading,
    currentRev,
    latestRev,
    setCustomFromRevId,
    setCustomToRevId,
    onChangeSubMode,
    onChangeRevision,
  } = ctx;
  if (!hasNewerRevisionWhileReading) return null;
  return (
    <div
      role="status"
      className="px-5 py-1.5 bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,transparent)] border-b border-[color:color-mix(in_srgb,var(--stage-ink-decision)_45%,transparent)] text-[color:var(--stage-ink-decision-text)] text-xs flex flex-wrap items-center justify-between gap-2"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-[color:var(--stage-ink-decision)] shrink-0" />
        <span>
          <strong>当前阅读的版本 v{currentRev.versionNumber} 已保持固定：</strong>
          <CopyIdButton id={currentRev.revision_id} className="mx-0.5" />
          观澜在 {formatRelativeObservedAt(latestRev.observed_at)} 捕获到新版本{' '}
          <code className="font-mono">v{latestRev.versionNumber}</code>
          <CopyIdButton id={latestRev.revision_id} className="mx-0.5" />
          （不在您读到一半时强行替换正文）。
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setCustomFromRevId(currentRev.revision_id);
            setCustomToRevId(latestRev.revision_id);
            onChangeSubMode('diff_versions');
          }}
        >
          对比新旧变化
        </Button>
        <Button variant="primary" size="sm" onClick={() => onChangeRevision(latestRev.revision_id)}>
          切换到最新版本 v{latestRev.versionNumber}
        </Button>
      </div>
    </div>
  );
}

/**
 * 2.5 文档迷你版本轴（U05）：点版本胶囊展开的玻璃微型修订链。
 * 顺序＝修订链序（vN → … → v1），每节点给「采集时刻 + 变动概览」；
 * 底部「进入版本时光机 →」直达 U04 画布（只做视图跳转，不改任何只读语义）。
 */
export interface ReaderMiniVersionAxisProps {
  nodes: MiniVersionAxisNode[];
  paperLightMode: boolean;
  /** 切版：把阅读器钉到该版本。 */
  onSelect: (revisionId: string) => void;
  /** 一键切版比对：以当前版为基准、该版为目标，进入历史快照对比。 */
  onCompare: (revisionId: string) => void;
  /** 进入版本时光机（仅在可直达的格式下提供）。 */
  onOpenTimeMachine?: () => void;
  canOpenTimeMachine?: boolean;
}

export function ReaderMiniVersionAxis({
  nodes,
  paperLightMode,
  onSelect,
  onCompare,
  onOpenTimeMachine,
  canOpenTimeMachine,
}: ReaderMiniVersionAxisProps) {
  return (
    <div
      role="region"
      aria-label="文档迷你版本轴"
      data-reader-version-axis=""
      data-esc-layer="open"
      className="glass-pop glx-popover-in absolute left-5 top-full z-50 mt-2 w-[320px] rounded-[14px] p-3"
      // 双态就地换底（实机走查修复）：① 夜航下 .glass-pop 固定白玻璃与浅字相撞不可读；
      // ② 白玻璃原 0.95 透率会让正文 H1 笔画透印（实测复合亮度 247/255 ≈1.05:1），
      //    提到 0.985 后复合亮度 252.6/255（Δ2.4 级）——1× 下不可辨。
      style={
        paperLightMode
          ? { background: 'rgba(255, 254, 250, 0.985)' }
          : { background: 'rgba(24, 27, 36, 0.985)' }
      }
    >
      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-[color:var(--glass-hairline)]">
        <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-strong)]">
          文档迷你版本轴
        </span>
        <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] tabular-nums">
          按修订链 · {nodes.length} 版
        </span>
      </div>

      {nodes.length === 0 ? (
        <p className="pt-2 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">
          本文档暂无可追溯的版本记录。
        </p>
      ) : (
        <ol className="mt-2 max-h-[288px] overflow-y-auto pl-1">
          {nodes.map((node) => (
            <li
              key={node.revisionId}
              data-reader-version-node={node.revisionId}
              className="relative flex items-start gap-2 border-l border-[color:var(--glass-hairline)] py-1 pl-3"
            >
              <span
                aria-hidden="true"
                className={`absolute -left-[3px] top-2.5 w-1.5 h-1.5 rounded-full ${
                  node.isCurrent
                    ? 'bg-[color:var(--accent-iris-deep)]'
                    : 'bg-[color:var(--ink-faint)]'
                }`}
              />
              <button
                type="button"
                onClick={() => onSelect(node.revisionId)}
                aria-current={node.isCurrent ? 'true' : undefined}
                className="min-w-0 flex-1 text-left cursor-pointer group/node"
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium text-[color:var(--ink-strong)]">
                    {node.label}
                  </span>
                  {node.isCurrent && (
                    <span className="rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] px-1.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--accent-iris-ink)]">
                      当前
                    </span>
                  )}
                  {node.isLatest && (
                    <span className="rounded-full bg-[color:color-mix(in_srgb,var(--accent-wave)_12%,transparent)] px-1.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--accent-wave)]">
                      最新
                    </span>
                  )}
                </span>
                <span className="block text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] tabular-nums">
                  {node.observedLabel}
                </span>
                <span className="block text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] truncate">
                  {node.changeSummary}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onCompare(node.revisionId)}
                title={`以当前阅读版本为基准，与 ${node.label} 比对`}
                className="shrink-0 self-center rounded-[6px] px-1.5 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--accent-iris-deep)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] cursor-pointer"
              >
                比对
              </button>
            </li>
          ))}
        </ol>
      )}

      {canOpenTimeMachine && onOpenTimeMachine && (
        <button
          type="button"
          onClick={onOpenTimeMachine}
          data-reader-open-time-machine=""
          className={`mt-2 w-full rounded-[8px] px-2.5 py-1.5 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium cursor-pointer ${
            paperLightMode
              ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--accent-iris-ink)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_18%,transparent)]'
              : 'bg-white/[0.08] text-[color:var(--accent-iris-ink)] hover:bg-white/[0.14]'
          }`}
        >
          进入版本时光机 →
        </button>
      )}
    </div>
  );
}

/** 2. 紧凑双层文件头：第一层文档身份 + 第二层模式与阅读工具条，昼夜双态协同 */
export function ReaderFileHeaderSection({ ctx }: { ctx: ReaderCtx }) {
  const {
    activeFile,
    returnBreadcrumb,
    onFollowReturnBreadcrumb,
    systemActions,
    currentRev,
    latestRev,
    artifactState,
    rollbackInfo,
    onMarkFullyRead,
    onMarkUnread,
    onToggleBookmark,
    readingState,
    subMode,
    outlineOpen,
    setOutlineOpen,
    paperLightMode,
    setPaperLightMode,
    inspectorOpen,
    onToggleInspector,
    fileActionsOpen,
    setFileActionsOpen,
    fileActionsRef,
    onChangeSubMode,
    hasNewerRevisionWhileReading,
    unreadStatus,
    canCompareSinceRead,
    hasReadBaseline,
    activePackage,
    activePackageProjection,
    activeFileStage,
    jumpToStageDoc,
    // ── U05：Zen 专注纸面 / 迷你版本轴 / 阅读进度 ──
    zenMode,
    toggleZen,
    versionAxisOpen,
    setVersionAxisOpen,
    miniVersionAxis,
    selectMiniVersion,
    compareMiniVersion,
    canOpenTimeMachine,
    onOpenTimeMachine,
  } = ctx;
  return (
    <div
      className={`relative z-20 px-5 ${zenMode ? 'py-1' : 'py-1.5'} backdrop-blur-xl flex flex-col gap-1 transition-colors ${
        paperLightMode
          ? 'bg-white/85 shadow-[0_1px_0_rgba(38,36,61,0.06),0_6px_18px_-12px_rgba(38,36,61,0.09)]'
          : 'bg-[#151822]/95 shadow-[0_1px_0_rgba(255,255,255,0.08),0_10px_24px_-12px_rgba(0,0,0,0.65)]'
      }`}
      onContextMenu={(e) => {
        if (!systemActions?.onOpenFileContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        systemActions.onOpenFileContextMenu(e, {
          kind: 'file',
          relativePath: activeFile.relative_path,
          title: activeFile.title,
          fileId: activeFile.file_id,
          revisionId: currentRev.revision_id,
        });
      }}
    >
      {/* Row 1：返回来源胶囊 + 标题身份 + 版本徽标 + 状态胶囊 + 右侧阅读操作与文件菜单 */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
          {returnBreadcrumb && (
            <button
              type="button"
              onClick={onFollowReturnBreadcrumb}
              data-reader-return-breadcrumb=""
              title={`${returnBreadcrumb.label} · 阅读位置与跳转来源已保留`}
              className={`inline-flex shrink-0 items-center gap-1 rounded-[8px] border px-2 py-0.5 text-[11.5px] font-medium cursor-pointer transition-colors ${
                paperLightMode
                  ? 'border-[#E6D5C3] bg-[#FBF6EE] text-[#9A6A45] hover:bg-[#F5EBD9] hover:text-[#7C5436]'
                  : 'border-[#3D342A] bg-[#24201B] text-[#E5A96A] hover:bg-[#2E2821] hover:text-[#F3C186]'
              }`}
            >
              <ArrowLeft className="w-3 h-3 shrink-0" />
              <span className="max-w-[140px] truncate">{returnBreadcrumb.label}</span>
            </button>
          )}
          {/* 衬线文档标题 + 轻悬浮信息卡（U05 顶栏减密：长路径与文件 ID 移入卡内） */}
          <div className="relative group inline-flex min-w-0 items-center gap-1">
            <h1
              title={activeFile.title}
              className="font-serif-claude text-[17px] leading-[24px] font-semibold flex items-center gap-1.5 truncate text-[color:var(--ink-strong)]"
            >
              {activeFile.format === 'md' && (
                <FileText className="w-4 h-4 shrink-0 text-[color:var(--accent-wave)]" />
              )}
              {activeFile.format === 'svg' && (
                <FileCode className="w-4 h-4 text-[color:var(--accent-iris-deep)] shrink-0" />
              )}
              {activeFile.format === 'pdf' && (
                <FileSpreadsheet className="w-4 h-4 text-[color:var(--stage-ink-decision)] shrink-0" />
              )}
              {activeFile.format !== 'md' &&
                activeFile.format !== 'svg' &&
                activeFile.format !== 'pdf' && (
                  <FileText
                    className="w-4 h-4 shrink-0"
                    style={{ color: formatUiMeta(activeFile.format).dotColor }}
                  />
                )}
              <span className="truncate">{activeFile.title}</span>
            </h1>
            <button
              type="button"
              aria-label="查看文件信息（完整路径与文件 ID）"
              title="文件信息：完整相对路径与文件 ID"
              className="shrink-0 rounded-[6px] p-0.5 text-[color:var(--ink-faint)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-[color:var(--ink-soft)] cursor-pointer"
            >
              <Info className="w-3.5 h-3.5" />
            </button>
            <span
              data-reader-file-info=""
              className="invisible absolute left-0 top-full z-40 mt-1.5 w-[320px] rounded-[14px] p-3 text-left opacity-0 transition-opacity glass-pop group-hover:visible group-hover:opacity-100 group-focus-within:visible"
              // 双态就地换底（同迷你版本轴口径）：夜航下白玻璃与浅字相撞不可读；
              // 0.985/0.985 双档封堵正文笔画透印（浅档复合亮度 ≥252/255、
              // 夜航档亮笔画穿透 1.5% 复合 Δ≈3 级，1× 均不可辨）
              style={
                paperLightMode
                  ? { background: 'rgba(255, 254, 250, 0.985)' }
                  : { background: 'rgba(24, 27, 36, 0.985)' }
              }
            >
              <span className="flex items-center justify-between gap-2 pb-1.5 mb-2 border-b border-[color:var(--glass-hairline)]">
                <span className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] font-semibold text-[color:var(--ink-strong)]">
                  文件信息
                </span>
                <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)] tabular-nums">
                  {activeFile.revisions.length} 个版本
                </span>
              </span>
              <span className="block space-y-1.5">
                <span className="block text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                  完整相对路径
                </span>
                <span className="block font-mono text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-strong)] break-all">
                  {activeFile.relative_path}
                </span>
                <span className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                    文件 ID
                  </span>
                  <CopyIdButton id={activeFile.file_id} />
                </span>
              </span>
            </span>
          </div>
          {/* 元信息行（U05 减密后只剩：版本演化胶囊 + 六态胶囊 + 恢复提示） */}
          <div className="flex items-center gap-1.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] tabular-nums text-[color:var(--ink-soft)]">
            <div>
              <button
                type="button"
                onClick={() => setVersionAxisOpen((v) => !v)}
                data-reader-version-axis-trigger=""
                aria-haspopup="true"
                aria-expanded={versionAxisOpen}
                title="展开文档迷你版本轴（按修订链 vN → … → v1）"
                className="rounded-full bg-[color:color-mix(in_srgb,var(--accent-wave)_11%,transparent)] px-2 py-0.5 font-mono font-medium text-[color:var(--accent-wave)] hover:bg-[color:color-mix(in_srgb,var(--accent-wave)_18%,transparent)] cursor-pointer"
              >
                {revisionVersionLabel(currentRev.versionNumber, !hasNewerRevisionWhileReading)}
              </button>
            </div>
            {artifactState && (
              <span
                data-doc-state={artifactState.state}
                className={docStatePillClass(artifactState.state)}
                title={`文档状态：${DOC_STATE_LABEL[artifactState.state]}`}
              >
                {DOC_STATE_LABEL[artifactState.state]}
              </span>
            )}
            {rollbackInfo.isRollback && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[color:var(--stage-ink-decision-text)]">
                  A→B→A 恢复自 {rollbackInfo.matchesEarlierRevisionId}
                </span>
              </>
            )}
          </div>
        </div>

        <Toolbar
          aria-label="阅读器操作工具栏"
          data-reader-toolbar=""
          className="flex flex-wrap items-center gap-1.5"
        >
          <Group aria-label="阅读状态与收藏" className="gap-0.5 rounded-xl border border-border/75 bg-card/65 p-0.5">
            {(() => {
              // GL-01 单一真相源：以 unreadStatus.isUnread 判定是否已读，
              // 确保手工「标为已读」、V04「确立已读基线」与服务端水合态完全一致；
              // 浏览历史版本时绝不将已读基线倒退到旧版本，始终面向 latestRev。
              const isUpToDateRead = !unreadStatus.isUnread;
              const isUpdatedAfterRead = unreadStatus.reason === 'updated_since_last_read';
              const canToggleUnread = isUpToDateRead && Boolean(onMarkUnread);
              const label = hasNewerRevisionWhileReading
                ? isUpToDateRead
                  ? '最新版已读'
                  : '标最新版已读'
                : isUpToDateRead
                  ? '当前版已读'
                  : '标为已读';
              const title = hasNewerRevisionWhileReading
                ? isUpToDateRead
                  ? '当前正在查看历史版本，最新版已读（点击标为未读）'
                  : '当前正在查看历史版本，点击将最新版本标为已读基线'
                : canToggleUnread
                  ? '当前版本已读（点击标为未读）'
                  : isUpdatedAfterRead
                    ? '自上次阅读后文档已有新版本，点击推进至最新已读基线'
                    : '将当前版本标为已读基线（打开文件不会自动标记整篇已读）';
              const pillToneClass = isUpToDateRead
                ? 'bg-[color:color-mix(in_srgb,var(--status-green)_12%,transparent)] border-[color:color-mix(in_srgb,var(--status-green)_32%,transparent)] text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)] hover:bg-[color:color-mix(in_srgb,var(--status-green)_18%,transparent)]'
                : isUpdatedAfterRead
                  ? 'bg-[color:color-mix(in_srgb,var(--accent-wave)_11%,transparent)] border-[color:color-mix(in_srgb,var(--accent-wave)_32%,transparent)] text-[color:var(--accent-wave)] hover:bg-[color:color-mix(in_srgb,var(--accent-wave)_18%,transparent)]'
                  : 'hover:border-[color:color-mix(in_srgb,var(--status-green)_32%,transparent)] hover:text-[color:var(--stage-ink-deliver-text)] dark:hover:text-[color:var(--success-foreground)]';
              return (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-pressed={isUpToDateRead}
                  data-reader-read-toggle={isUpToDateRead ? 'read' : 'unread'}
                  data-reader-read-reason={unreadStatus.reason}
                  onClick={() => {
                    if (isUpToDateRead) {
                      onMarkUnread?.(activeFile.file_id);
                    } else {
                      onMarkFullyRead(activeFile.file_id, latestRev.revision_id);
                    }
                  }}
                  title={title}
                  className={pillToneClass}
                >
                  <CheckCircle2
                    className={`w-3.5 h-3.5 ${
                      isUpToDateRead
                        ? 'text-[color:var(--status-green)] dark:text-[color:var(--success)] glx-read-confirm-pop'
                        : isUpdatedAfterRead
                          ? 'text-[color:var(--accent-wave)]'
                          : 'text-[color:var(--ink-soft)]'
                    }`}
                  />
                  <span>{label}</span>
                  {isUpdatedAfterRead && (
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-[color:var(--accent-wave)] glx-unread-updated-dot shrink-0"
                    />
                  )}
                </Button>
              );
            })()}

            <Button
              variant={readingState?.bookmarked ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => onToggleBookmark(activeFile.file_id)}
              aria-label={readingState?.bookmarked ? '取消收藏' : '收藏此资料'}
              title={readingState?.bookmarked ? '取消收藏' : '收藏此资料'}
            >
              <Bookmark className="w-3.5 h-3.5" />
            </Button>
          </Group>

          <Group aria-label="纸面视图工具组" className="gap-0.5 rounded-xl border border-border/75 bg-card/65 p-0.5">
            {activeFile.format === 'md' && subMode === 'read' && (
              <Button
                variant={outlineOpen ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setOutlineOpen((v) => !v)}
                aria-pressed={outlineOpen}
                aria-label={outlineOpen ? '收起章节大纲' : '展开章节大纲'}
                title={
                  outlineOpen
                    ? '收起章节大纲（纸面回到全宽）'
                    : '展开章节大纲（浮层，不挤压纸面行宽）'
                }
              >
                <PanelLeft className="w-3.5 h-3.5" />
                {/* U05 主行单行化：1440（xl..2xl）下收文字只留图标（aria-label 提供可读名），
                    ≥2xl 恢复全标签；与昼夜钮合计省 ~104px，四大锚点在目录栏展开的主配置下回到同一条 Row1 */}
                <span className="max-2xl:hidden">{outlineOpen ? '收起大纲' : '大纲'}</span>
              </Button>
            )}

            {activeFile.format === 'md' && subMode === 'read' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPaperLightMode((v) => !v)}
                aria-label={paperLightMode ? '切换到深色阅读纸' : '切换到纸面浅色'}
                title={paperLightMode ? '切换到深色阅读纸' : '切换到纸面浅色'}
              >
                {paperLightMode ? (
                  <>
                    <Moon className="w-3.5 h-3.5" />
                    <span className="max-2xl:hidden">深色</span>
                  </>
                ) : (
                  <>
                    <Sun className="w-3.5 h-3.5" />
                    <span className="max-2xl:hidden">浅色</span>
                  </>
                )}
              </Button>
            )}

            <GroupSeparator className="hidden xl:block my-1" />

            <Button
              variant={inspectorOpen ? 'primary' : 'ghost'}
              size="sm"
              onClick={onToggleInspector}
              aria-expanded={inspectorOpen}
              className="max-xl:hidden"
              title="溯源与关联：版本时间、文件大小、完整路径与上下游阅读顺序"
            >
              <Info className="w-3.5 h-3.5" />
              <span>溯源</span>
            </Button>

            {/* 专注纸面（Zen）：一键收起左右侧栏 + 居中黄金阅读行宽（快捷键 Z） */}
            <Button
              variant={zenMode ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => toggleZen('toolbar-button')}
              aria-pressed={zenMode}
              data-reader-zen-toggle=""
              title={
                zenMode
                  ? '退出专注纸面：恢复左右侧栏（快捷键 Z）'
                  : '进入专注纸面：收起左右侧栏、居中黄金阅读行宽（快捷键 Z）'
              }
            >
              {zenMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Focus className="w-3.5 h-3.5" />}
              <span>{zenMode ? '退出专注' : '专注纸面'}</span>
            </Button>
          </Group>

          {systemActions &&
            systemActions.onRevealInExplorer &&
            systemActions.onOpenWithDefaultApp &&
            systemActions.onCopyRelativePath &&
            systemActions.onCopyAbsolutePath && (
              <div className="relative" ref={fileActionsRef}>
                <Button
                  variant={fileActionsOpen ? 'primary' : 'ghost'}
                  size="sm"
                  aria-label="文件操作"
                  aria-expanded={fileActionsOpen}
                  title="文件操作：定位目录、复制路径、重命名、移动、移入回收站"
                  onClick={() => setFileActionsOpen((v) => !v)}
                >
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
                {fileActionsOpen && (
                  <div
                    role="region"
                    aria-label="文件操作菜单"
                    data-esc-layer="open"
                    className="glass-pop glx-popover-in absolute right-0 top-full mt-2 w-[312px] rounded-[14px] p-3 z-50 space-y-2"
                    // 双态就地换底（同迷你版本轴口径）：夜航可读 + 封堵正文笔画透印
                    style={
                      paperLightMode
                        ? { background: 'rgba(255, 254, 250, 0.985)' }
                        : { background: 'rgba(24, 27, 36, 0.985)' }
                    }
                  >
                    <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-[color:var(--glass-hairline)]">
                      <span className="text-[11px] font-semibold text-[color:var(--ink-strong)]">
                        文件操作
                      </span>
                      <span
                        className="font-mono text-[10.5px] text-[color:var(--ink-soft)] truncate max-w-[210px]"
                        title={activeFile.relative_path}
                      >
                        {activeFile.relative_path}
                      </span>
                    </div>
                    {/* U05 顶栏减密：文件 ID 从主行移入此处（长 ID 不再占主行视线） */}
                    <div
                      data-reader-file-id-entry=""
                      className="flex items-center justify-between gap-2 rounded-[8px] bg-[color:color-mix(in_srgb,var(--ink-strong)_4%,transparent)] px-2 py-1"
                    >
                      <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]">
                        文件 ID
                      </span>
                      <CopyIdButton id={activeFile.file_id} />
                    </div>
                    <FileSystemActionBar
                      compact
                      relativePath={activeFile.relative_path}
                      fileId={activeFile.file_id}
                      title={activeFile.title}
                      desktopSupported={Boolean(systemActions.desktopSystemSupported)}
                      hasRootPath={Boolean(systemActions.hasWorkspaceRoot)}
                      onRevealInExplorer={(p) => {
                        setFileActionsOpen(false);
                        systemActions.onRevealInExplorer?.(p);
                      }}
                      onOpenWithDefaultApp={(p) => {
                        setFileActionsOpen(false);
                        systemActions.onOpenWithDefaultApp?.(p);
                      }}
                      onCopyRelativePath={systemActions.onCopyRelativePath}
                      onCopyAbsolutePath={systemActions.onCopyAbsolutePath}
                      onRenameFile={
                        systemActions.onRenameFile
                          ? (t) => {
                              setFileActionsOpen(false);
                              systemActions.onRenameFile?.(t);
                            }
                          : undefined
                      }
                      onMoveFile={
                        systemActions.onMoveFile
                          ? (t) => {
                              setFileActionsOpen(false);
                              systemActions.onMoveFile?.(t);
                            }
                          : undefined
                      }
                      onTrashFile={
                        systemActions.onTrashFile
                          ? (t) => {
                              setFileActionsOpen(false);
                              systemActions.onTrashFile?.(t);
                            }
                          : undefined
                      }
                    />
                  </div>
                )}
              </div>
            )}
        </Toolbar>
      </div>

      {/* Row 2：查看模式分段胶囊 + 所属专项紧凑条（单行合流，按需展示可用对比/历史项，释放首屏阅读高度） */}
      <div
        className={`glx-zen-chrome flex flex-wrap items-center justify-between gap-x-3 gap-y-1 ${
          zenMode ? 'opacity-70' : ''
        }`}
      >
        <div
          role="group"
          aria-label="当前对象查看模式"
          className={`inline-flex items-center gap-0.5 rounded-[9px] p-0.5 text-xs ${
            paperLightMode
              ? 'bg-[color:var(--depth-1-bg)] shadow-[inset_0_1px_2px_rgba(38,36,61,0.04)]'
              : 'bg-white/[0.06] shadow-[inset_0_1px_2px_rgba(0,0,0,0.28)]'
          }`}
        >
          <Button
            variant={subMode === 'read' ? 'primary' : 'ghost'}
            size="sm"
            className="!h-6 !px-2 !text-[11.5px]"
            title={`当前版本 ${revisionVersionLabel(currentRev.versionNumber, !hasNewerRevisionWhileReading)}`}
            onClick={() => onChangeSubMode('read')}
          >
            {hasNewerRevisionWhileReading
              ? `当前 v${currentRev.versionNumber}`
              : '正文'}
          </Button>

          {(canCompareSinceRead || subMode === 'diff_since_read') && (
            <Button
              variant={subMode === 'diff_since_read' ? 'primary' : 'ghost'}
              size="sm"
              className="!h-6 !px-2 !text-[11.5px]"
              onClick={() => onChangeSubMode('diff_since_read')}
              disabled={!canCompareSinceRead}
              title={
                hasReadBaseline
                  ? '与上次读到的版本比较'
                  : '尚未建立阅读基线：与最早收录的版本比较'
              }
            >
              <GitCompare className="w-3 h-3" />
              <span>{hasReadBaseline ? '对比上次阅读' : '对比最早版本'}</span>
              {hasReadBaseline && canCompareSinceRead && unreadStatus.isUnread && (
                <span className="ml-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)]">(有更新)</span>
              )}
            </Button>
          )}

          {(activeFile.revisions.length > 1 || subMode === 'diff_versions') && (
            <Button
              variant={subMode === 'diff_versions' ? 'primary' : 'ghost'}
              size="sm"
              className="!h-6 !px-2 !text-[11.5px]"
              onClick={() => onChangeSubMode('diff_versions')}
            >
              历史快照 ({activeFile.revisions.length})
            </Button>
          )}

          <Button
            variant={subMode === 'relations' ? 'primary' : 'ghost'}
            size="sm"
            className="!h-6 !px-2 !text-[11.5px]"
            onClick={() => onChangeSubMode('relations')}
          >
            <Network className="w-3 h-3" />
            <span>局部关系图</span>
          </Button>
        </div>

        {/* wf_4：所属专项 + 五阶段 Stepper 并入 Row 2 右侧，宽屏同行、窄屏优雅折行 */}
        {activePackage && (
          <div className="min-w-0 flex flex-wrap items-center gap-1.5 text-xs">
            <span
              className={`shrink-0 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium tracking-wide ${
                paperLightMode ? 'text-[color:var(--ink-soft)]' : 'text-white/55'
              }`}
            >
              所属专项
            </span>
            <span
              className={`truncate max-w-[160px] font-semibold text-[11.5px] ${
                paperLightMode ? 'text-[color:var(--ink-strong)]' : 'text-[#F3F4F8]'
              }`}
              title={activePackage.name}
            >
              {activePackage.name}
            </span>
            {activePackageProjection?.source === 'server' && (
              <span
                data-doc-state={activePackageProjection.state}
                className={docStatePillClass(activePackageProjection.state)}
                title={`专项状态：${DOC_STATE_LABEL[activePackageProjection.state]}${
                  activePackageProjection.pendingP0 !== null
                    ? ` · 未决 P0 ${activePackageProjection.pendingP0} / P1 ${activePackageProjection.pendingP1}`
                    : ''
                }`}
              >
                {initiativeStateBadgeLine(activePackageProjection.state)}
              </span>
            )}
            <div
              role="group"
              aria-label="五阶段进度 Stepper"
              className="flex flex-wrap items-center gap-0.5"
            >
              {STAGE_STEPS.map((step, i) => {
                const isCurrent = activePackage.stage === step.role;
                const isReadingDoc = activeFileStage === step.role;
                const stageDoc =
                  activePackage.readingOrder.find((d) => d.stage === step.role) ?? null;
                const reachable = stageDoc !== null && stageDoc.fileId !== activeFile.file_id;
                return (
                  <React.Fragment key={step.role}>
                    {i > 0 && (
                      <span
                        className={`text-[10px] leading-none ${
                          paperLightMode ? 'text-[color:var(--ink-soft)]' : 'text-white/35'
                        }`}
                      >
                        →
                      </span>
                    )}
                    <Button
                      variant={isCurrent ? 'primary' : 'ghost'}
                      size="sm"
                      disabled={!reachable}
                      title={`${step.full}${
                        stageDoc ? `：${stageDoc.title}` : '：该阶段暂无文档'
                      }${isCurrent ? '（当前阶段）' : ''}`}
                      aria-label={`${step.full}${isCurrent ? '（当前阶段）' : ''}${
                        isReadingDoc ? '（当前阅读）' : ''
                      }`}
                      onClick={() => jumpToStageDoc(step.role)}
                      className="relative !h-6 !px-1.5 !text-[11px]"
                    >
                      {step.short}
                      {isReadingDoc && !isCurrent && (
                        <span
                          className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${
                            paperLightMode ? 'bg-[#9A6A45]' : 'bg-[#D99B52]'
                          }`}
                          title="当前阅读文档在此阶段"
                        />
                      )}
                    </Button>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}

        {/* U05 · 迷你版本轴弹层挂头部根节点（避让修复）：锚 header 底沿向下展开，
            绝不盖住 Row2 查看模式分段条（历史快照/局部关系图）——弹层只覆盖正文
            纸面（非交互区）。关闭态零 DOM；outside-click 与 Esc 由控制器收口。 */}
        {versionAxisOpen && (
          <ReaderMiniVersionAxis
            nodes={miniVersionAxis}
            paperLightMode={paperLightMode}
            onSelect={selectMiniVersion}
            onCompare={compareMiniVersion}
            canOpenTimeMachine={canOpenTimeMachine}
            onOpenTimeMachine={onOpenTimeMachine}
          />
        )}
      </div>
    </div>
  );
}
