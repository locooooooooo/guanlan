/**
 * D01-a 拆解 · 阅读器 MD 阅读纸分节（任务卡 D01-a ②「格式专用阅读器插件层」之一）。
 *
 * 从 ReaderView.tsx（原 3799-4206）原样迁入：章节大纲侧栏、精装手稿纸容器、
 * GU-CC-01 回退提示、显式提要横幅、正文三态（错误/挂起/正文）、行模型渲染、
 * 底部决策回传动作条。渲染期闭包（renderMarkdownBlock 等）由 controller ctx 提供。
 * 迁移纪律：JSX 与类名逐字一致（像素回归护栏）。
 */

import React from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  PlusCircle,
  RotateCcw,
  Save,
} from 'lucide-react';
import { Button } from '../ui/primitives';
import { GlassSkeleton } from '../ui/GlassSkeleton';
import { formatSourceLineFallbackNotice, scrollToSourceLine } from './readerMarkdownModel';
import type { ReaderCtx } from './useReaderController';

/** === SUBMODE C / Format 1: MARKDOWN READER (§4.1) === */
export function ReaderMarkdownSection({ ctx }: { ctx: ReaderCtx }) {
  const {
    paperLightMode,
    outlineOpen,
    setOutlineOpen,
    showLineNumbers,
    setShowLineNumbers,
    outline,
    changedSectionsOutline,
    activeSectionId,
    setActiveSectionId,
    onMarkReadHere,
    activeFile,
    currentRev,
    markdownScrollRef,
    handleMarkdownScroll,
    sourceLineFallback,
    setSourceLineFallback,
    calloutsCollapsed,
    setCalloutsCollapsed,
    handleAddSectionToContext,
    bodyPhase,
    fetchError,
    setFetchError,
    contentKey,
    markdownBlocks,
    renderMarkdownBlock,
    resolveCardByAnchor,
    renderDecisionResolveCard,
    decisionSelectedCount,
    decisionCopied,
    handleCopyDecisionInstruction,
    onAddDecisionToBasket,
    handleAddDecisionToBasket,
    decisionSaveBridge,
    decisionSave,
    handleSaveDecisionReceipt,
    decisionSaveError,
  } = ctx;
  return (
    <div className="relative flex-1 flex overflow-hidden">
      {/* 章节大纲侧栏（lg+ 桌面端采用并排停靠侧轨，彻底杜绝遮挡正文标题与段落；
          中窄视口回退悬浮层；昼夜阅读模式同步切换专属暗色/纸白表面，无标题时展示清晰空态） */}
      {outlineOpen && (
        <aside
          aria-label="章节大纲与提要"
          className={`glx-fade-in absolute inset-y-0 left-0 z-20 w-[248px] max-w-[75%] border-r p-3.5 overflow-y-auto shadow-xl hidden md:block lg:static lg:shrink-0 lg:shadow-none transition-colors ${
            paperLightMode
              ? 'bg-[#FAF9FD]/95 border-[color:var(--glass-hairline)]'
              : 'bg-[#14161F] border-white/[0.08]'
          }`}
        >
          <div className="flex items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-[color:var(--glass-hairline)]">
            <span className="text-[11.5px] font-semibold tracking-wide text-[color:var(--ink-strong)]">
              章节大纲与提要
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowLineNumbers((v) => !v)}
                className={`text-[11px] leading-none cursor-pointer transition-colors ${
                  paperLightMode
                    ? 'text-[#9A6A45] hover:text-[#7C5436]'
                    : 'text-[#E5A96A] hover:text-[#F3C186]'
                }`}
              >
                {showLineNumbers ? '隐藏行号' : '显示来源行'}
              </button>
              <button
                type="button"
                onClick={() => setOutlineOpen(false)}
                aria-label="收起章节大纲"
                title="收起章节大纲（纸面回到全宽）"
                className={`shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none cursor-pointer transition-colors ${
                  paperLightMode
                    ? 'text-[color:var(--ink-soft)] hover:bg-[#EAE7DE] hover:text-[color:var(--ink-strong)]'
                    : 'text-[color:var(--ink-soft)] hover:bg-white/10 hover:text-[color:var(--ink-strong)]'
                }`}
              >
                ×
              </button>
            </div>
          </div>

          {outline.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-[color:var(--glass-hairline)] px-3 py-5 text-center space-y-1">
              <p className="text-[12px] font-medium text-[color:var(--ink-soft)]">
                本文档暂无层级标题
              </p>
              <p className="text-[11px] leading-relaxed text-[color:var(--ink-faint)]">
                使用 Markdown 标题（# / ##）后将自动生成可跳转目录
              </p>
            </div>
          ) : (
          <div className="space-y-0.5">
            {outline.map((sec) => {
              // issue #18：大纲「自上次读变更」高亮改走章节指纹按需计算
              // （changedSectionsOutline），不再消费全量 diff 的副产物
              const isChangedSinceRead =
                changedSectionsOutline.includes(sec.title);
              return (
                <button
                  key={`${sec.title}-${sec.startLine}`}
                  type="button"
                  onClick={() => {
                    setActiveSectionId(sec.title);
                    onMarkReadHere(
                      activeFile.file_id,
                      currentRev.revision_id,
                      sec.title
                    );
                    scrollToSourceLine(sec.startLine);
                  }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-[8px] text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] cursor-pointer transition-colors ${
                    sec.level === 3 ? 'pl-5 text-[12px]' : sec.level === 2 ? 'pl-3.5 text-[12.5px]' : 'font-semibold'
                  } ${
                    activeSectionId === sec.title
                      ? paperLightMode
                        ? 'bg-[#EFE7DC] text-[#9A5B33] font-medium'
                        : 'bg-white/10 text-[#F0BA7B] font-medium'
                      : paperLightMode
                        ? 'text-[color:var(--ink-soft)] hover:bg-[#EFECE5] hover:text-[color:var(--ink-strong)]'
                        : 'text-[color:var(--ink-soft)] hover:bg-white/[0.06] hover:text-[color:var(--ink-strong)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="truncate">{sec.title}</span>
                    <span
                      className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono shrink-0 tabular-nums opacity-70"
                    >
                      L{sec.startLine}
                    </span>
                  </div>
                  {isChangedSinceRead && (
                    <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--accent-wave)] mt-0.5">
                      上次读后有改动
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          )}
        </aside>
      )}

      {/* Markdown Main Paper / Dark Reading Surface —— 精装手稿纸浮于柔和画布之上 */}
      <div
        ref={markdownScrollRef}
        onScroll={handleMarkdownScroll}
        className={`flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 xl:px-8 transition-colors ${
          paperLightMode
            ? 'depth-0-surface text-[#1F1E1D]'
            : 'bg-[#0F1117] text-[#F4F3EE]'
        }`}
      >
        {/* GU-CC-01：证据行就近回退的中性提示 */}
        {sourceLineFallback && (
          <div
            role="status"
            className={`sticky top-0 z-10 mx-auto max-w-[820px] mb-3 flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2 text-xs shadow-sm ${
              paperLightMode
                ? 'bg-[#FBF6EE]/95 border-[#E3DCC9] text-[#9A6A45] backdrop-blur'
                : 'bg-[#262320]/95 border-[#383633] text-[#D99B52] backdrop-blur'
            }`}
          >
            <span>
              {formatSourceLineFallbackNotice(
                sourceLineFallback.target,
                sourceLineFallback.landed
              )}
            </span>
            <button
              type="button"
              aria-label="关闭定位回退提示"
              onClick={() => setSourceLineFallback(null)}
              className={`shrink-0 rounded px-1.5 font-sans ${
                paperLightMode ? 'hover:bg-[#EAE7DE]' : 'hover:bg-[#2E2B27]'
              }`}
            >
              ×
            </button>
          </div>
        )}
        {/* 精装手稿纸容器：正文行宽仍严格锁定 .reader-measure (714px) */}
        <div
          className={`mx-auto max-w-[828px] rounded-[20px] px-7 py-6 md:px-11 md:py-8 transition-colors ${
            paperLightMode
              ? 'bg-[#FFFEFA] shadow-[0_14px_42px_-14px_rgba(38,36,61,0.09),0_2px_6px_rgba(38,36,61,0.04),0_0_0_1px_rgba(38,36,61,0.055)]'
              : 'bg-[#171921] shadow-[0_18px_48px_-14px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.07)]'
          }`}
        >
        <div className="reader-measure mx-auto space-y-6">
          {/* Explicit Callouts Banner (核心结论 / 需你决策，保留原文行段入口，不自动捏造 AI 总结) */}
          {outline.filter((s) => s.isExplicitCallout).length > 0 && (
            <div className="text-xs">
              <button
                type="button"
                onClick={() => setCalloutsCollapsed((v) => !v)}
                className={`w-full flex items-center justify-between gap-3 rounded-md px-3 py-2 border text-left transition-colors ${
                  paperLightMode
                    ? 'bg-[#F5F0E8] border-[#E3DCC9]'
                    : 'bg-[#262320] border-[#383633]'
                }`}
              >
                <span
                  className="font-medium"
                  title="提取自原文显式提要段落，仅作导航与引用入口"
                >
                  文档提要
                </span>
                <span className="shrink-0 text-[length:var(--text-ui)] leading-[var(--lh-ui)] tabular-nums text-[#D99B52]">
                  {outline.filter((s) => s.isExplicitCallout).length} 条提要 ·{' '}
                  {calloutsCollapsed ? '展开' : '收起'}
                </span>
              </button>
              {!calloutsCollapsed && (
                <div className="mt-2">
                  {outline
                    .filter((s) => s.isExplicitCallout)
                    .map((sec) => (
                      <div
                        key={sec.startLine}
                        className={`py-2.5 border-b ${
                          paperLightMode ? 'border-[#E3E0D8]' : 'border-[#383633]'
                        }`}
                      >
                        <div className="flex items-center justify-between font-medium">
                          <span>{sec.title}</span>
                          <span className="font-mono text-[11px] opacity-70">
                            L{sec.startLine}–{sec.endLine}
                          </span>
                        </div>
                        <p className="opacity-80 line-clamp-2 mt-0.5">{sec.summaryText}</p>
                        <div className="flex items-center justify-between pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveSectionId(sec.title);
                              setShowLineNumbers(true);
                            }}
                            className={`font-medium hover:underline ${
                              paperLightMode ? 'text-[#9A6A45]' : 'text-[#D99B52]'
                            }`}
                          >
                            定位原文行 L{sec.startLine}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleAddSectionToContext(
                                sec.startLine,
                                sec.endLine,
                                `${sec.title}: ${sec.summaryText || ''}`,
                                `来自章节「${sec.title}」`
                              )
                            }
                            className="text-xs font-medium text-emerald-700 dark:text-emerald-400 flex items-center gap-1 hover:underline"
                          >
                            <PlusCircle className="w-3 h-3" />
                            <span>加入上下文</span>
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Structured Rendered Markdown Document (16-18px comfortable measure + wide table horizontal scroll) */}
          {bodyPhase === 'error' ? (
            /* 按版本读取正文失败：明确报错 + 重试，不静默渲染空文档 */
            <div
              role="alert"
              className={`p-4 rounded-lg border text-sm space-y-2 ${
                paperLightMode
                  ? 'bg-rose-50 border-rose-300 text-rose-800'
                  : 'bg-rose-950/40 border-rose-800 text-rose-200'
              }`}
            >
              <div className="font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
                <span>此版本正文读取失败（不使用磁盘当前内容冒充历史版本）</span>
              </div>
              <p className="text-xs leading-relaxed">{fetchError[contentKey]}</p>
              <p className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono opacity-80 tabular-nums">
                revision={currentRev.revision_id}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setFetchError((prev) => {
                    const next = { ...prev };
                    delete next[contentKey];
                    return next;
                  })
                }
              >
                <RotateCcw className="w-3.5 h-3.5" />
                重试读取正文
              </Button>
            </div>
          ) : bodyPhase === 'loading' ? (
            /* AC-02：正文读取挂起只在纸面内显示 loading——外层标题/工具栏/
               shell 已先渲染（无全局阻塞遮罩）；冷启动对账期正文可能较慢，
               但首屏渲染耗时由 readerFirstScreen 预算测量锁定。
               U11 实机核验收编：裸旋转图标升级琉璃骨架（条底 color-mix(currentColor)
               随纸面/夜航容器文字色 tint，双主题轨道均可见；reduce 下流光层
               display:none＝静态骨架终态）；role="status" 与三行诚实文案（含
               revision 可诊断信息）逐字保留。 */
            <div
              role="status"
              className={`p-6 rounded-lg border flex flex-col items-center justify-center gap-2.5 text-sm ${
                paperLightMode
                  ? 'bg-[#F5F0E8] border-[#E3DCC9] text-[#6E6A61]'
                  : 'bg-[#1A1917] border-[#383633] text-[#A1A09A]'
              }`}
            >
              <GlassSkeleton lines={2} className="w-full max-w-sm" />
              <span className="text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)]">
                正在按版本读取正文（首次对账期间可能较慢）…
              </span>
              <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)]">
                文档框架已就绪，正文到达后自动显示
              </span>
              <span className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono opacity-70 tabular-nums">
                revision={currentRev.revision_id}
              </span>
            </div>
          ) : (
          /* 正文档（§3.2 read-body）：17/32（1.88 行高，阅读优先底线①）；
             衬线为受闸切换（D3）——html 挂 serif-body-live 才启用，见 index.css .read-body */
          <article className="read-body space-y-0">
            {/* perf②：行模型（useMemo，deps=[markdownContent, 链接索引]）→ 渲染期叠加
                易变态（paperLightMode/sourceLine/showLineNumbers/activeSectionId/
                readingState）。DOM 结构、data-event-source-line 锚点粒度、键方案与
                旧解析 IIFE 逐字一致；解析只随正文/文件集变化重跑，易变渲染不再
                全量重解析（App 常驻保活下概览态同样受益）。 */}
            {markdownBlocks.map((block) => {
              const node = renderMarkdownBlock(block);
              // Inline 拍板（F5）：卡点块范围末块之后追加原位拍板卡
              //（原文行逐字渲染零改写；Fragment 接管 map 键，块内 wrapLine 键保留）
              const anchorBlock = resolveCardByAnchor.get(block.line);
              return anchorBlock ? (
                <React.Fragment key={`blk-${block.line}`}>
                  {node}
                  {renderDecisionResolveCard(anchorBlock)}
                </React.Fragment>
              ) : (
                node
              );
            })}
          </article>
          )}
        </div>
        </div>
      </div>

      {/* 决策回执 T3：底部悬浮「决策回传动作条」——勾选 ≥1 项时滑入。
          悬浮于阅读纸下缘（外层 relative 容器，不随正文滚动）；居中用 Tailwind
          -translate-x-1/2（v4 落独立 translate 属性），与滑入关键帧操作的 transform
          属性互不覆盖——居中位移若写进 transform 会被动画终帧 transform:none 抹掉。
          [保存回写原文件]桌面壳有命令桥（save_workspace_file：冲突检测+
          原子替换）时可点；浏览器/CLI dev 无桥 → 保持诚实禁用态（只读快照）。 */}
      {decisionSelectedCount >= 1 && (
        <div
          data-decision-action-bar
          role="group"
          aria-label="决策回传动作条"
          className="glx-slide-up-in absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2 rounded-lg border border-[color:var(--glass-hairline)] bg-white/85 px-3 py-2 shadow-[var(--glass-shadow)] backdrop-blur"
        >
          <span className="whitespace-nowrap text-xs font-medium text-[color:var(--ink-strong)]">
            已选择 {decisionSelectedCount} 项决策
          </span>
          <Button
            size="sm"
            variant={decisionCopied ? 'secondary' : 'primary'}
            onClick={handleCopyDecisionInstruction}
            title="把文档标题、已勾选项与填空内容组装为结构化 markdown 写入剪贴板"
          >
            {decisionCopied ? (
              <>
                <Check className="h-3.5 w-3.5 shrink-0" />
                <span>已复制</span>
              </>
            ) : (
              <>
                <ClipboardCopy className="h-3.5 w-3.5 shrink-0" />
                <span>生成决策指令并复制</span>
              </>
            )}
          </Button>
          {onAddDecisionToBasket && (
            <Button size="sm" variant="secondary" onClick={handleAddDecisionToBasket}>
              <PlusCircle className="h-3.5 w-3.5 shrink-0" />
              <span>加入证据篮</span>
            </Button>
          )}
          {decisionSaveBridge ? (
            <Button
              size="sm"
              variant={decisionSave === 'saved' ? 'secondary' : 'primary'}
              onClick={handleSaveDecisionReceipt}
              disabled={decisionSave === 'saving'}
              title={
                decisionSave === 'saved'
                  ? '已回写原文件；重新扫描后版本列表将更新'
                  : '把勾选与填空写回工作区原文件（冲突检测保护）'
              }
            >
              {decisionSave === 'saving' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  <span>保存中…</span>
                </>
              ) : decisionSave === 'saved' ? (
                <>
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span>已回写 ✓</span>
                </>
              ) : (
                <>
                  <Save className="h-3.5 w-3.5 shrink-0" />
                  <span>保存回写原文件</span>
                </>
              )}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled
              aria-disabled="true"
              title="当前环境为只读快照：复制指令回传智能体即可落盘"
            >
              <Lock className="h-3.5 w-3.5 shrink-0" />
              <span>保存回写原文件</span>
            </Button>
          )}
          {decisionSaveError && (
            <span
              role="alert"
              className="whitespace-nowrap text-xs text-[color:var(--accent-wave)]"
            >
              {decisionSaveError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
