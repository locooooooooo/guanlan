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
    networkOffline, streamDisconnected, retryingConnection, handleRetryConnection,
  } = ctx;
  const [dismissedNoticeKey, setDismissedNoticeKey] = useState<string | null>(null);
  const changeNoticeKey = changeNotice ? `${changeNotice.at}:${changeNotice.count}` : null;
  // 新事件分页并入条仅作用于全景溯源（星图/日历/时间线）；
  // 在知识资产库阅读文档或首页时不弹出通栏横幅打断阅读。
  const visibleChangeNotice =
    activeTab === 'panorama' && changeNotice && changeNoticeKey !== dismissedNoticeKey
      ? changeNotice
      : null;
  const showConnectionAlert =
    networkOffline || streamDisconnected || dataSource === 'error';
  const connectionAlertText = networkOffline
    ? '当前网络已断开，操作暂无法同步，请恢复网络后重试'
    : streamDisconnected
      ? '与本地读服务的实时连接已中断，正在等待重连或手动重试'
      : dataError || '无法连接观澜读服务，工作区数据暂不可用';
  return (
    <>
      {/* 全局断网 / 服务不可用告警条（role="alert" + 可点击重试，防重提交） */}
      {showConnectionAlert && (
        <div
          data-connection-alert=""
          role="alert"
          className="px-4 py-1.5 bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_10%,var(--card))] border-b border-[color:color-mix(in_srgb,var(--stage-ink-exec)_34%,transparent)] text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--stage-ink-exec-text)] flex flex-wrap items-center justify-between gap-2 shrink-0 tabular-nums"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="size-1.5 rounded-full bg-[color:var(--stage-ink-exec)] shrink-0" aria-hidden="true" />
            <span className="break-words">{connectionAlertText}</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={retryingConnection}
            aria-busy={retryingConnection}
            data-retry-connection=""
            onClick={() => void handleRetryConnection()}
          >
            {retryingConnection ? '重试中…' : '重试连接'}
          </Button>
        </div>
      )}

      {/* 手动重扫进度已收编入 TopHeader 右上角同步胶囊（「扫描中…」+ 旋转图标），
          不再弹出通栏横幅挤压正文/画布高度；仅在扫描失败时呈现可重试告警横幅。 */}
      {rescanState === 'error' && (
        <div
          className="px-4 py-1.5 bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_10%,var(--card))] border-b border-[color:color-mix(in_srgb,var(--stage-ink-exec)_36%,transparent)] text-[length:var(--text-ui)] leading-[var(--lh-ui)] text-[color:var(--stage-ink-exec-text)] flex flex-wrap items-center gap-2 shrink-0 tabular-nums"
          role="alert"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--stage-ink-exec)] shrink-0" aria-hidden="true" />
          <span className="break-words">{`扫描失败：${rescanError || '请检查服务连接后重试'}`}</span>
          <Button variant="secondary" size="sm" onClick={() => void handleRescan()}>
            重试扫描
          </Button>
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
                    className="block h-full rounded-full bg-[color:var(--accent-iris-deep)] motion-safe:transition-all"
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
                title="静默并入新事件，保持当前滚动位与已加载分页不动"
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
        <div
          className="flex-1 flex items-center justify-center p-8"
          role="status"
          aria-busy="true"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-4 text-center">
            <ChronosLineArt className="size-12 opacity-80" />
            <div role="progressbar" aria-label="正在读取工作区快照" className="w-64">
              <GlassSkeleton lines={3} className="w-full" />
            </div>
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
