
import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookMarked,
  Check,
  ClipboardCopy,
  FilePlus2,
  GitCommitHorizontal,
  Hourglass,
  Layers,
  Scale,
  X,
} from 'lucide-react';
import type { DecisionAssertion, FileRecord, TimelineEvent } from '../types/guanlan';
import {
  buildChronosDigest,
  type ChronosDigestRange,
} from '../utils/chronosDigest';
import { copyTextWithDesktopFallback } from '../services/desktopBridge';
import { Button, IconButton } from './ui/primitives';
import {
  anchoredToastManager,
  Badge,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Frame,
  FramePanel,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
} from './ui';

export interface ChronosDigestDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  events: TimelineEvent[];
  files: FileRecord[];
  decisions: DecisionAssertion[];
  onOpenDocument: (fileId: string, revisionId?: string) => void;
  onOpenDecision: (decisionId: string) => void;
  initialRange?: ChronosDigestRange;
  anchorDate?: string;
}

export const ChronosDigestDrawer: React.FC<ChronosDigestDrawerProps> = ({
  isOpen,
  onClose,
  events,
  files,
  decisions,
  onOpenDocument,
  onOpenDecision,
  initialRange = 'today',
  anchorDate,
}) => {
  const [range, setRange] = useState<ChronosDigestRange>(initialRange);
  const [copied, setCopied] = useState(false);

  const digest = useMemo(
    () => (isOpen ? buildChronosDigest(events, files, decisions, range, anchorDate) : null),
    [isOpen, events, files, decisions, range, anchorDate]
  );

  if (!isOpen || !digest) return null;

  const handleCopyMarkdown = async (ev: React.MouseEvent<HTMLButtonElement>) => {
    const anchorEl = ev.currentTarget;
    const res = await copyTextWithDesktopFallback(digest.markdown);
    if (res.ok) {
      setCopied(true);
      anchoredToastManager.add({
        title: `已复制${digest.rangeLabel} Markdown`,
        description: `共 ${digest.totalEvents} 条事件 · 带原文溯源链接`,
        type: 'success',
        positionerProps: { anchor: anchorEl, side: 'top', sideOffset: 8 },
        timeout: 2400,
      });
      setTimeout(() => setCopied(false), 2000);
    } else {
      anchoredToastManager.add({
        title: '复制失败',
        description: '剪贴板权限受限，请手动展开下方源码复制',
        type: 'error',
        positionerProps: { anchor: anchorEl, side: 'top', sideOffset: 8 },
        timeout: 2600,
      });
    }
  };

  const spanText =
    digest.startDay === digest.endDay
      ? digest.endDay
      : `${digest.startDay} → ${digest.endDay}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="司辰手记 · 沉淀简报与可溯源导出"
      data-esc-layer="open"
      data-chronos-digest-drawer="open"
      className="glx-backdrop-in fixed inset-0 z-50 flex justify-end bg-[color:var(--ink-anchor)]/38 dark:bg-black/62 p-2 sm:p-3 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-sheet-variant="inset"
        className="glx-drawer-in flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border/85 bg-popover/95 text-foreground backdrop-blur-2xl"
        style={{ boxShadow: 'var(--glass-shadow-pop)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 bg-card/85 px-6 py-4 backdrop-blur-md">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,transparent)] text-[color:var(--accent-iris-deep)]">
              <BookMarked className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="font-serif-claude text-[17px] leading-[1.35] font-semibold tracking-[-0.01em] text-foreground truncate">
                司辰手记 · 时光沉淀简报
              </h2>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                {spanText} · 基于真实事件、版本链与本地语义摘要生成
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <SegmentedControl size="sm" role="tablist" aria-label="手记时间跨度">
              <SegmentedControlItem
                type="button"
                role="tab"
                aria-selected={range === 'today'}
                aria-pressed={range === 'today'}
                data-digest-range="today"
                onClick={() => setRange('today')}
              >
                今日
              </SegmentedControlItem>
              <SegmentedControlItem
                type="button"
                role="tab"
                aria-selected={range === 'week'}
                aria-pressed={range === 'week'}
                data-digest-range="week"
                onClick={() => setRange('week')}
              >
                近 7 日
              </SegmentedControlItem>
            </SegmentedControl>
            <IconButton label="关闭司辰手记" onClick={onClose} className="cursor-pointer">
              <X />
            </IconButton>
          </div>
        </div>

        <ScrollArea scrollFade className="flex-1 min-h-0">
          <div className="space-y-4 p-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono tabular-nums">
              <div className="rounded-xl border border-border/75 bg-card/85 px-3 py-2.5">
                <div className="font-sans text-[11px] text-muted-foreground">新增文档</div>
                <div className="mt-0.5 text-[18px] font-semibold text-[color:var(--accent-iris-deep)]">
                  {digest.addedDocs.length}
                </div>
              </div>
              <div className="rounded-xl border border-border/75 bg-card/85 px-3 py-2.5">
                <div className="font-sans text-[11px] text-muted-foreground">演进文档</div>
                <div className="mt-0.5 text-[18px] font-semibold text-[color:var(--accent-wave)]">
                  {digest.evolvedDocs.length}
                </div>
              </div>
              <div className="rounded-xl border border-border/75 bg-card/85 px-3 py-2.5">
                <div className="font-sans text-[11px] text-muted-foreground">已拍板</div>
                <div className="mt-0.5 text-[18px] font-semibold text-[color:var(--stage-ink-deliver-text)]">
                  {digest.resolvedDecisions.length}
                </div>
              </div>
              <div className="rounded-xl border border-border/75 bg-card/85 px-3 py-2.5">
                <div className="font-sans text-[11px] text-muted-foreground">遗留待拍板</div>
                <div className="mt-0.5 text-[18px] font-semibold text-[color:var(--stage-ink-decision-text)]">
                  {digest.pendingDecisions.length}
                </div>
              </div>
            </div>

            {digest.totalEvents === 0 &&
            digest.resolvedDecisions.length === 0 &&
            digest.pendingDecisions.length === 0 ? (
              <Empty className="rounded-2xl border border-dashed border-border/80 bg-card/65 py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Hourglass className="size-4" />
                  </EmptyMedia>
                  <EmptyTitle>{digest.rangeLabel}暂无新动态</EmptyTitle>
                  <EmptyDescription>
                    {range === 'today'
                      ? '今日尚未观测到文档新增或变更，可切换「近 7 日」回望本周沉淀脉络'
                      : '近 7 个自然日内暂无文档演进记录与遗留待拍板项'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                {digest.topPackages.length > 0 && (
                  <Frame className="border border-border/75" data-digest-top-packages="">
                    <div className="flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-semibold text-foreground">
                      <Layers className="size-3.5 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
                      <span>最活跃专项 Top {digest.topPackages.length}</span>
                    </div>
                    <FramePanel className="space-y-2 p-3">
                      {digest.topPackages.map((pkg, idx) => (
                        <div
                          key={pkg.packageId}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/35 px-3 py-2 text-[12px]"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-[11px] font-semibold text-[color:var(--accent-iris-deep)]">
                              #{idx + 1}
                            </span>
                            <span className="truncate font-medium text-foreground">
                              {pkg.packageName}
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                            {pkg.eventCount} 次变更 · {pkg.docCount} 份
                          </span>
                        </div>
                      ))}
                    </FramePanel>
                  </Frame>
                )}

                {digest.addedDocs.length > 0 && (
                  <Frame className="border border-border/75" data-digest-added-docs="">
                    <div className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12px] font-semibold text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <FilePlus2 className="size-3.5 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
                        <span>新增文档</span>
                      </span>
                      <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                        {digest.addedDocs.length}
                      </Badge>
                    </div>
                    <FramePanel className="space-y-1.5 p-2.5">
                      {digest.addedDocs.map((doc) => (
                        <button
                          key={`add-${doc.fileId}`}
                          type="button"
                          onClick={() => {
                            onOpenDocument(doc.fileId, doc.revisionId || undefined);
                            onClose();
                          }}
                          className="group flex w-full cursor-pointer items-start justify-between gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/80 hover:bg-accent/60"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="outline" size="sm" className="font-mono text-[10px]">
                                {doc.format}
                              </Badge>
                              <span className="truncate text-[12.5px] font-medium text-foreground">
                                {doc.title}
                              </span>
                              <span className="font-mono text-[10.5px] text-muted-foreground">
                                {doc.versionLabel}
                              </span>
                            </div>
                            {doc.summary && (
                              <p className="line-clamp-1 text-[11.5px] text-muted-foreground">
                                {doc.summary}
                              </p>
                            )}
                            <div className="font-mono text-[10.5px] text-muted-foreground/85 truncate">
                              {doc.packageName} · {doc.relativePath}
                            </div>
                          </div>
                          <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                      ))}
                    </FramePanel>
                  </Frame>
                )}

                {digest.evolvedDocs.length > 0 && (
                  <Frame className="border border-border/75" data-digest-evolved-docs="">
                    <div className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12px] font-semibold text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <GitCommitHorizontal className="size-3.5 text-[color:var(--accent-wave)]" aria-hidden="true" />
                        <span>演进文档</span>
                      </span>
                      <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                        {digest.evolvedDocs.length}
                      </Badge>
                    </div>
                    <FramePanel className="space-y-1.5 p-2.5">
                      {digest.evolvedDocs.map((doc) => (
                        <button
                          key={`evo-${doc.fileId}`}
                          type="button"
                          onClick={() => {
                            onOpenDocument(doc.fileId, doc.revisionId || undefined);
                            onClose();
                          }}
                          className="group flex w-full cursor-pointer items-start justify-between gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/80 hover:bg-accent/60"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="brand" size="sm" className="font-mono text-[10px]">
                                {doc.versionLabel}
                              </Badge>
                              <span className="truncate text-[12.5px] font-medium text-foreground">
                                {doc.title}
                              </span>
                              <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                                {doc.eventCount} 次变更
                              </span>
                            </div>
                            {doc.summary && (
                              <p className="line-clamp-2 text-[11.5px] text-muted-foreground">
                                {doc.summary}
                              </p>
                            )}
                            <div className="font-mono text-[10.5px] text-muted-foreground/85 truncate">
                              {doc.packageName} · {doc.latestDay}
                            </div>
                          </div>
                          <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                      ))}
                    </FramePanel>
                  </Frame>
                )}

                {(digest.resolvedDecisions.length > 0 || digest.pendingDecisions.length > 0) && (
                  <Frame className="border border-border/75" data-digest-decisions="">
                    <div className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12px] font-semibold text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Scale className="size-3.5 text-[color:var(--stage-ink-decision-text)]" aria-hidden="true" />
                        <span>已拍板与遗留待拍板</span>
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        已定 {digest.resolvedDecisions.length} · 待定 {digest.pendingDecisions.length}
                      </span>
                    </div>
                    <FramePanel className="space-y-1.5 p-2.5">
                      {digest.resolvedDecisions.map((d) => (
                        <button
                          key={`res-${d.decisionId}`}
                          type="button"
                          onClick={() => {
                            onOpenDecision(d.decisionId);
                            onClose();
                          }}
                          className="flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-left text-[12px] hover:bg-accent/60"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="success" size="sm">已拍板</Badge>
                              <span className="font-mono text-[11px] text-muted-foreground">{d.code}</span>
                              <span className="truncate font-medium text-foreground">{d.question}</span>
                            </div>
                            {d.confirmedAnswer && (
                              <p className="line-clamp-1 text-[11px] text-muted-foreground">
                                定案：{d.confirmedAnswer}
                              </p>
                            )}
                          </div>
                        </button>
                      ))}
                      {digest.pendingDecisions.map((d) => (
                        <button
                          key={`pen-${d.decisionId}`}
                          type="button"
                          onClick={() => {
                            onOpenDecision(d.decisionId);
                            onClose();
                          }}
                          className="flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-left text-[12px] hover:bg-accent/60"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="warning" size="sm">{d.status}</Badge>
                              <span className="font-mono text-[11px] text-muted-foreground">{d.code}</span>
                              <span className="truncate font-medium text-foreground">{d.question}</span>
                            </div>
                            {d.relativePath && (
                              <div className="font-mono text-[10.5px] text-muted-foreground truncate">
                                {d.relativePath}
                                {d.lineStart ? ` · L${d.lineStart}` : ''}
                              </div>
                            )}
                          </div>
                        </button>
                      ))}
                    </FramePanel>
                  </Frame>
                )}

                <details className="rounded-xl border border-border/75 bg-muted/35 p-3">
                  <summary className="cursor-pointer select-none text-[11.5px] font-medium text-muted-foreground hover:text-foreground">
                    展开标准 Markdown 源码预览（带 guanlan:// 原文溯源链接）
                  </summary>
                  <pre
                    data-digest-markdown-preview=""
                    className="mt-2.5 max-h-56 overflow-auto rounded-lg border border-border/70 bg-card/85 p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words"
                  >
                    {digest.markdown}
                  </pre>
                </details>
              </>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between gap-3 border-t border-border/80 bg-card/85 px-6 py-3.5 backdrop-blur-xl">
          <span className="text-[11px] text-muted-foreground">
            每条沉淀记录均附原文溯源路径 · 零造数本地直出
          </span>
          <Button
            variant="primary"
            size="sm"
            data-digest-copy-markdown=""
            onClick={(ev) => void handleCopyMarkdown(ev)}
            className="cursor-pointer shrink-0"
          >
            {copied ? (
              <>
                <Check className="size-3.5" aria-hidden="true" />
                <span>已复制 Markdown</span>
              </>
            ) : (
              <>
                <ClipboardCopy className="size-3.5" aria-hidden="true" />
                <span>复制{range === 'today' ? '日报' : '周报'} Markdown</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ChronosDigestDrawer;
