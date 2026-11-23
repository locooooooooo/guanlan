/**
 * D01-a 拆解 · App 横幅栈与冷启动进度（原 App.tsx 3379-3548 逐字迁入）。
 * 手动重扫进度 / L4A 沉淀 / HITL 清零恢复 / Delivered 归档提示 / Archived 重开 /
 * 监听提示 / 冷启动首扫进度。数据一律来自 useWorkspaceStore ctx。
 */

import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/primitives';
import { ChronosLineArt, GlassSkeleton } from '../ui/GlassSkeleton';
import { formatLocalClock } from '../../utils/timeFormat';
import type { WorkspaceStoreCtx } from '../../stores/useWorkspaceStore';

export function AppBanners({ ctx }: { ctx: WorkspaceStoreCtx }) {
  const {
    rescanState, rescanError, handleRescan, l4aProgress, hitlClearedAt,
    deliveredInitiative, deliveredInitiatives, initiativeLifecycle, runInitiativeLifecycle,
    activeInitiative, changeNotice, refreshEvents, silentMergeNewEvents, silentMergingEvents,
    dataSource, files, dataError, activeTab,
  } = ctx;
  const [dismissedNoticeKey, setDismissedNoticeKey] = useState<string | null>(null);
  const changeNoticeKey = changeNotice ? `${changeNotice.at}:${changeNotice.count}` : null;
  const visibleChangeNotice =
    changeNotice && changeNoticeKey !== dismissedNoticeKey ? changeNotice : null;
  return (
    <>
      {/* 批次二：手动重扫进度提示（扫描中 / 完成 / 失败）。
          语义与 L4A 沉淀横幅独立：这里说的是「用户手动触发的整库核验是否已并入索引」。
          建议更正（PRD §2.2）：本地服务具备后台增量通路（watcher 轮询 + L4A 沉淀队列，
          各自有独立进度展示），本横幅不再是「扫描是唯一能推进索引的动作」的宣言，
          而降级为手动触发兜底的如实回声——文案照旧只说这一轮扫描本身。 */}
      {rescanState !== 'idle' && (
        <div
          className="px-4 py-1 bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,transparent)] backdrop-blur-md border-b border-[color:color-mix(in_srgb,var(--stage-ink-decision)_40%,transparent)] text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--stage-ink-decision-text)] flex items-center gap-2 shrink-0 tabular-nums"
          role="status"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full bg-[color:var(--stage-ink-decision)] ${
              rescanState === 'running' ? 'animate-pulse' : ''
            }`}
          />
          <span>
            {rescanState === 'running'
              ? '正在扫描工作区，把最新文档并入索引…'
              : rescanState === 'done'
                ? '扫描完成，索引已更新'
                : `扫描失败：${rescanError || '未知原因'}`}
          </span>
          {rescanState === 'error' && (
            <Button variant="secondary" size="sm" onClick={() => void handleRescan()}>
              重试
            </Button>
          )}
        </div>
      )}

      {/* 后台语义整理与新事件合一细条：两项并发时并作单行轻条，避免双层横幅挤压主视口 */}
      {(l4aProgress || visibleChangeNotice) && (
        <div
          data-unified-status-ribbon=""
          role="status"
          className="px-4 py-0.5 min-h-[26px] bg-card/85 backdrop-blur-md border-b border-[color:var(--glass-hairline)] text-[11.5px] leading-[18px] text-[color:var(--ink-soft)] flex flex-wrap items-center justify-between gap-x-3 gap-y-1 shrink-0 tabular-nums"
        >
          <div className="flex items-center gap-2 min-w-0">
            {l4aProgress ? (
              <>
                <span className="size-1.5 rounded-full bg-[color:var(--accent-iris-deep)] animate-pulse shrink-0" />
                <span
                  className="truncate"
                  title="后台持续提取文档摘要与决策关系，期间可正常阅读与批注"
                >
                  后台语义整理中 ({l4aProgress.percent}%)
                </span>
                <span
                  aria-hidden="true"
                  className="h-1 w-20 overflow-hidden rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] shrink-0"
                >
                  <span
                    className="block h-full rounded-full bg-gradient-to-r from-[color:var(--accent-iris)] to-[color:var(--accent-iris-deep)] motion-safe:transition-all"
                    style={{ width: `${Math.max(4, Math.min(100, l4aProgress.percent))}%` }}
                  />
                </span>
                <span className="font-mono text-[11px] text-[color:var(--ink-soft)] shrink-0">
                  {l4aProgress.done}/{l4aProgress.total} 篇
                </span>
              </>
            ) : (
              visibleChangeNotice && (
                <div
                  className="flex items-center gap-2 text-[color:var(--stage-ink-decision-text)]"
                  title="可静默并入保持当前位置，或刷新切入最新分页窗口"
                >
                  <span className="size-1.5 rounded-full bg-[color:var(--stage-ink-decision)] animate-pulse shrink-0" />
                  <span>
                    检测到 {visibleChangeNotice.count} 条新事件（{formatLocalClock(visibleChangeNotice.at)}）
                  </span>
                </div>
              )
            )}
          </div>

          {visibleChangeNotice && (
            <div
              className="flex items-center gap-1.5 shrink-0"
              title="静默并入可在不丢失当前阅读/日历/分页滚动位的前提下合并新增事件"
            >
              {l4aProgress && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_12%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--stage-ink-decision-text)]">
                  <span className="size-1.5 rounded-full bg-[color:var(--stage-ink-decision)] animate-pulse" />
                  <span>
                    {visibleChangeNotice.count} 条新事件 · {formatLocalClock(visibleChangeNotice.at)}
                  </span>
                </span>
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={silentMergingEvents}
                data-silent-merge-events=""
                onClick={() => void silentMergeNewEvents()}
                className="!h-[22px] !px-2.5 !text-[11px] !rounded-full cursor-pointer"
                title="无痛并入新事件，保持当前滚动位与已加载分页不动"
              >
                {silentMergingEvents ? '静默并入中…' : '静默并入（保持当前位置）'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={silentMergingEvents}
                data-refresh-events-window=""
                onClick={() => void refreshEvents()}
                className="!h-[22px] !px-2.5 !text-[11px] !rounded-full cursor-pointer"
                title="重置分页并切入最新时间窗口"
              >
                刷新进入新窗口
              </Button>
              <button
                type="button"
                data-dismiss-change-notice=""
                aria-label="暂收新事件提示"
                title="暂收提示（不丢失未并入事件）"
                onClick={() => setDismissedNoticeKey(changeNoticeKey)}
                className="w-5 h-5 rounded-full flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Inline 拍板闭环（AC-03）：阻塞性事项（P0/P1）全部拍板清零 → 长任务恢复提示。
          语义＝deliver 绿（§3.1 stage-ink 双层），非阻塞告知 8s 自动收起——
          槽位唤醒由后端写线程 recompute_slots 完成，本横幅只陈述该事实 */}
      {hitlClearedAt && (
        <div
          className="px-4 py-1 bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_10%,transparent)] backdrop-blur-md border-b border-[color:color-mix(in_srgb,var(--stage-ink-deliver)_40%,transparent)] text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--stage-ink-deliver-text)] flex items-center gap-2 shrink-0 tabular-nums"
          role="status"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--stage-ink-deliver)]" />
          <span>阻塞性事项已全部拍板，长任务恢复执行</span>
          <span className="text-[color:var(--ink-soft)]">
            等待拍板的执行/交付槽位已解除挂起（{formatLocalClock(hitlClearedAt)}）
          </span>
        </div>
      )}

      {/* F24（PRD §2.2）：Delivered 已交付 → 提示一键归档。
          数据源 /state-overview；归档走 202 job + 轮询，完成后刷新状态投影。
          非阻塞横幅：不锁阅读/拍板/证道阁，失败就地展示并允许重试。 */}
      {deliveredInitiative && (
        <div
          data-initiative-archive-prompt=""
          role="status"
          className="px-4 py-1 bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_10%,transparent)] backdrop-blur-md border-b border-[color:color-mix(in_srgb,var(--stage-ink-deliver)_40%,transparent)] text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--stage-ink-deliver-text)] flex flex-wrap items-center gap-2 shrink-0 tabular-nums"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--stage-ink-deliver)]" />
          <span>
            专项「{deliveredInitiative.name}」已交付，确认验收后可一键归档
            {deliveredInitiatives.length > 1
              ? `（另有 ${deliveredInitiatives.length - 1} 个已交付专项）`
              : ''}
          </span>
          {initiativeLifecycle?.phase === 'error' &&
            initiativeLifecycle.action === 'archive' &&
            initiativeLifecycle.initiativeId === deliveredInitiative.initiative_id && (
              <span className="text-[color:var(--stage-ink-decision-text)]">
                {initiativeLifecycle.message}
              </span>
            )}
          <Button
            variant="primary"
            size="sm"
            disabled={initiativeLifecycle?.phase === 'running'}
            onClick={() =>
              void runInitiativeLifecycle(deliveredInitiative.initiative_id, 'archive')
            }
          >
            {initiativeLifecycle?.phase === 'running' &&
            initiativeLifecycle.action === 'archive' &&
            initiativeLifecycle.initiativeId === deliveredInitiative.initiative_id
              ? '归档中…'
              : '一键归档'}
          </Button>
        </div>
      )}

      {/* F24：当前文档所属专项已归档 → 提供人工重开入口（Archived 终态唯一离开通道）。
          仅在阅读归档专项内文档时出现，不对全局归档列表刷屏。 */}
      {activeInitiative?.state === 'archived' && (
        <div
          data-initiative-reopen-prompt=""
          role="status"
          className="px-4 py-1 bg-white/60 backdrop-blur-md border-b border-[color:var(--glass-hairline)] text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)] flex flex-wrap items-center gap-2 shrink-0 tabular-nums"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ink-soft)]" />
          <span>专项「{activeInitiative.name}」已归档，需要继续推进时可重开</span>
          {initiativeLifecycle?.phase === 'error' &&
            initiativeLifecycle.action === 'reopen' &&
            initiativeLifecycle.initiativeId === activeInitiative.id && (
              <span className="text-[color:var(--stage-ink-decision-text)]">
                {initiativeLifecycle.message}
              </span>
            )}
          <Button
            variant="secondary"
            size="sm"
            disabled={initiativeLifecycle?.phase === 'running'}
            onClick={() => void runInitiativeLifecycle(activeInitiative.id, 'reopen')}
          >
            {initiativeLifecycle?.phase === 'running' &&
            initiativeLifecycle.action === 'reopen' &&
            initiativeLifecycle.initiativeId === activeInitiative.id
              ? '重开中…'
              : '重开专项'}
          </Button>
        </div>
      )}

      {/* 冷启动首扫（千份级资料约一分钟）：首页上有明确的进度态；其余页签仍显示各自空态。
          U11：裸旋转图标升级为琉璃骨架屏——司辰线稿（静态）+ 流光骨架条（reduce 降级为
          静态玻璃条，motion.css §3.29）；role="status" 与两句诚实文案原样保留，
          骨架只是视觉占位，不吞任何真实错误态（dataError 分支整块不渲染骨架）。 */}
      {dataSource === 'loading' && files.length === 0 && !dataError && activeTab === 'home' && (
        <div className="flex-1 flex items-center justify-center p-8" role="status">
          <div className="flex flex-col items-center gap-4 text-center">
            <ChronosLineArt className="size-12 opacity-80" />
            <GlassSkeleton lines={3} className="w-64" />
            <p className="text-sm text-[color:var(--ink-soft)]">
              正在读取工作区快照…
            </p>
            <p className="text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--ink-soft)]">
              期间首页卡片与星图 / 列表 / 日历为空属正常；数据就绪后自动填充。
            </p>
          </div>
        </div>
      )}
    </>
  );
}
