import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  FileText,
  History,
  X,
} from 'lucide-react';
import {
  fetchFileHistory,
  fetchRevisionContent,
  revisionRawUrl,
  type FileHistory,
  type FileHistoryRevision,
} from '../services/workspaceClient';
import { formatLocalDateTime, timeBasisLabel } from '../utils/timeFormat';
import { isPreviewableHtmlFormat } from '../utils/formatMeta';
import { buildHtmlSandboxDocument } from '../utils/htmlPreview';
import { Button } from './ui/primitives';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  ScrollArea,
} from './ui';
import { GlassSkeleton } from './ui/GlassSkeleton';

interface FileTimelineDrawerProps {
  isOpen: boolean;
  fileId: string;
  onClose: () => void;
  onOpenRevision: (fileId: string, revisionId: string) => void;
}

type HistoryEvent = FileHistory['events'][number];

interface TimelineNode {
  key: string;
  revision: FileHistoryRevision | null;
  events: HistoryEvent[];
  anchorAt: string;
}

function anchorOfRevision(rev: FileHistoryRevision): string {
  return rev.occurred_at || rev.observed_at;
}

function anchorOfEvent(ev: HistoryEvent): string {
  return ev.occurred_at || ev.observed_at;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'discovered':
      return '首次基线';
    case 'appeared':
      return '新出现';
    case 'modified':
      return '内容修改';
    case 'missing':
      return '路径不可访问';
    case 'moved_or_copied':
      return '同哈希副本候选';
    case 'file_renamed':
      return '重命名';
    case 'file_moved':
      return '移动路径';
    case 'file_trashed':
      return '移入回收站';
    case 'decision_raised':
      return '提出决策';
    case 'decision_changed':
      return '决策更新';
    case 'workspace_baseline':
      return '首次纳入';
    case 'read_error':
      return '读取问题';
    case 'read_recovered':
      return '读取恢复';
    default:
      return kind;
  }
}

export const FileTimelineDrawer: React.FC<FileTimelineDrawerProps> = ({
  isOpen,
  fileId,
  onClose,
  onOpenRevision,
}) => {
  const [history, setHistory] = useState<FileHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [previewRevisionId, setPreviewRevisionId] = useState<string>('');
  const [previewText, setPreviewText] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>('');
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setEntered(false);
      return;
    }
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !fileId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setHistory(null);
    setPreviewRevisionId('');
    setPreviewText('');
    setPreviewError('');
    void fetchFileHistory(fileId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result) {
        setError('读取文件历史失败（/history 无响应或返回错误）');
        return;
      }
      setHistory(result);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, fileId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const nodes = useMemo<TimelineNode[]>(() => {
    if (!history) return [];
    const revisions = [...history.revisions].sort((a, b) => {
      const ta = anchorOfRevision(a);
      const tb = anchorOfRevision(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.seq - b.seq;
    });

    const eventsByRevision = new Map<string, HistoryEvent[]>();
    const leading: HistoryEvent[] = [];
    const orphanByRevision = new Map<string, HistoryEvent[]>();
    const revisionIds = new Set(revisions.map((r) => r.revision_id));

    for (const ev of history.events) {
      if (ev.revision_id && revisionIds.has(ev.revision_id)) {
        const list = eventsByRevision.get(ev.revision_id) || [];
        list.push(ev);
        eventsByRevision.set(ev.revision_id, list);
        continue;
      }
      const t = anchorOfEvent(ev);
      const host = revisions
        .filter((r) => anchorOfRevision(r) <= t)
        .sort((a, b) => (anchorOfRevision(a) < anchorOfRevision(b) ? -1 : 1))
        .pop();
      if (host) {
        const list = orphanByRevision.get(host.revision_id) || [];
        list.push(ev);
        orphanByRevision.set(host.revision_id, list);
      } else {
        leading.push(ev);
      }
    }

    const bySeq = (a: HistoryEvent, b: HistoryEvent) => a.seq - b.seq;
    const out: TimelineNode[] = [];
    if (leading.length > 0) {
      out.push({
        key: 'leading-events',
        revision: null,
        events: [...leading].sort(bySeq),
        anchorAt: anchorOfEvent(leading[0]!),
      });
    }
    for (const rev of revisions) {
      out.push({
        key: rev.revision_id,
        revision: rev,
        events: [
          ...(eventsByRevision.get(rev.revision_id) || []),
          ...(orphanByRevision.get(rev.revision_id) || []),
        ].sort(bySeq),
        anchorAt: anchorOfRevision(rev),
      });
    }
    return out;
  }, [history]);

  useEffect(() => {
    if (!previewRevisionId || !history) return;
    const rev = history.revisions.find((r) => r.revision_id === previewRevisionId);
    if (!rev || !rev.snapshot_available) return;
    if (history.file.format === 'pdf') return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewText('');
    void fetchRevisionContent(previewRevisionId).then((result) => {
      if (cancelled) return;
      setPreviewLoading(false);
      if (!result.ok) {
        setPreviewError(
          result.code === 'SNAPSHOT_UNAVAILABLE'
            ? '此版本正文已过保留期（快照未内联且已被淘汰），仅保留版本元数据。'
            : result.error || '按版本读取正文失败'
        );
        return;
      }
      setPreviewText(result.text || '');
    });
    return () => {
      cancelled = true;
    };
  }, [previewRevisionId, history]);

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

  const isPdf = history?.file.format === 'pdf';
  const isHtml = isPreviewableHtmlFormat(history?.file.format);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="文件时间线"
      data-esc-layer="open"
      className="glx-backdrop-in fixed inset-0 z-50 bg-[color:var(--ink-anchor)]/38 dark:bg-black/62 backdrop-blur-sm flex justify-end p-2 sm:p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-timeline-panel=""
        data-sheet-variant="inset"
        className="glx-t-panel bg-popover/95 dark:bg-popover/95 backdrop-blur-2xl w-full max-w-2xl h-full flex flex-col overflow-hidden rounded-2xl border border-border/85 text-foreground"
        style={{
          transform: entered ? 'none' : 'translateX(32px)',
          opacity: entered ? 1 : 0,
          boxShadow: 'var(--glass-shadow-pop)',
        }}
      >
        <div className="px-6 py-4 bg-card/85 backdrop-blur-md border-b border-border/80 flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-serif-claude text-[17px] leading-[1.35] font-semibold tracking-[-0.01em] text-foreground flex items-center gap-2">
              <History className="w-4 h-4 text-[color:var(--accent-iris)] shrink-0" />
              <span className="truncate">文件时间线 · {history?.file.title || '读取中…'}</span>
            </h2>
            <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
              {history?.file.current_path || fileId}
            </p>
            {history?.aliases && history.aliases.length > 1 && (
              <p
                className="text-[length:var(--text-micro)] text-muted-foreground font-mono truncate mt-0.5"
                title={history.aliases.join(' → ')}
              >
                曾用路径：{history.aliases.filter((a) => a !== history.file.current_path).join(' · ')}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭文件时间线"
            className="inline-flex size-8 items-center justify-center rounded-lg border border-border/75 bg-card/75 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <ScrollArea scrollFade className="flex-1 min-h-0">
        <div className="p-6 space-y-4">
          {loading && (
            <div
              role="status"
              className="flex flex-col items-center gap-3 py-8 w-full"
            >
              <GlassSkeleton lines={2} className="w-64" />
              <span className="text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">
                正在读取版本链与相关事件…
              </span>
            </div>
          )}

          {!loading && error && (
            <div className="p-3.5 rounded-md border-[color:var(--btn-danger-border)] bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_8%,transparent)] text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--btn-danger-ink)] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!loading && history && (
            <>
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-2 font-mono tabular-nums">
                  {[
                    { label: '版本快照', value: history.revisions.length, tone: 'var(--accent-iris-deep)' },
                    { label: '相关事件', value: history.events.length, tone: 'var(--stage-ink-plan-text)' },
                    { label: '决策陈述', value: history.statements.length, tone: 'var(--stage-ink-decision-text)' },
                    { label: '血缘引用', value: history.edges.length, tone: 'var(--stage-ink-deliver-text)' },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="depth-1-group px-3 py-2 flex flex-col justify-between"
                    >
                      <span className="font-sans text-[10.5px] text-[color:var(--ink-soft)]">
                        {stat.label}
                      </span>
                      <span
                        className="mt-0.5 text-[17px] leading-tight font-semibold"
                        style={{ color: stat.tone }}
                      >
                        {stat.value}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between px-1 font-mono text-[11px] text-[color:var(--ink-soft)]">
                  <span>格式 · {history.file.format.toUpperCase()}</span>
                  <span title="版本与事件按发生/采集时间混排（时间轴序·自新到旧），与版本时光机的修订链序（seq 降序）是两套口径">
                    排序 · 时间轴自新到旧（非修订链）
                  </span>
                </div>
                <div
                  className="px-1 text-[11px] text-[color:var(--ink-soft)]"
                  data-timeline-order-note=""
                >
                  内容演进请看版本时光机（按修订链）；本抽屉按时间轴混排版本与事件，仅作史迹回溯。
                </div>
              </div>

              {nodes.length === 0 && (
                <Empty className="rounded-2xl border border-dashed border-border/80 bg-card/65 py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <History className="size-4" />
                    </EmptyMedia>
                    <EmptyTitle>该文件没有版本与相关事件记录</EmptyTitle>
                    <EmptyDescription>
                      当文档发生首次入库、内容修订或决策引用时，时间脊柱会自动记录每个可追溯节点
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}

              <div className="relative pl-6 space-y-3" data-timeline-nodes="">
                <span
                  aria-hidden="true"
                  data-timeline-spine=""
                  className="pointer-events-none absolute left-[7px] top-3 bottom-3 w-[1.5px] rounded-full"
                  style={{
                    background:
                      'linear-gradient(180deg, color-mix(in srgb, var(--accent-iris) 55%, transparent) 0%, rgba(38,36,61,0.12) 85%, transparent 100%)',
                  }}
                />
                {nodes.map((node, nodeIdx) => {
                  const rev = node.revision;
                  const available = rev ? rev.snapshot_available : false;
                  const isActivePreview = rev && rev.revision_id === previewRevisionId;
                  return (
                    <div
                      key={node.key}
                      data-timeline-node={node.key}
                      data-timeline-node-kind={rev ? 'revision' : 'events'}
                      className="relative"
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute -left-[22px] top-4 size-2.5 rounded-full ring-4 ring-white/90 ${
                          nodeIdx === 0
                            ? 'bg-[color:var(--accent-iris)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent-iris)_22%,transparent)]'
                            : rev
                              ? 'bg-[color:var(--ink-soft)]'
                              : 'bg-[color:var(--stage-ink-decision)]'
                        }`}
                      />
                      <div
                        className={`depth-2-card p-3.5 transition-shadow ${
                          isActivePreview
                            ? 'ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)]'
                            : ''
                        }`}
                      >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {rev ? (
                            <span
                              className="px-1.5 py-0.5 rounded bg-white/70 border border-[#26243D]/15 font-mono text-[length:var(--text-micro)] text-[color:var(--accent-iris-deep)] shrink-0"
                              title={`版本 v${rev.seq} · ${(rev.size_bytes / 1024).toFixed(1)} KB${rev.snapshot_available ? '' : ' · 快照已淘汰（仅保留元数据）'}`}
                            >
                              v{rev.seq}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-white/70 border border-[#26243D]/15 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] shrink-0">
                              前导事件
                            </span>
                          )}
                          <span className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] tabular-nums flex items-center gap-1">
                            <CalendarClock className="w-3.5 h-3.5 text-[color:var(--ink-soft)] shrink-0" />
                            {formatLocalDateTime(node.anchorAt)}
                          </span>
                          {rev && (
                            <span className="font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                              {rev.occurred_at
                                ? `${timeBasisLabel(rev.occurred_source)} · ${rev.occurred_precision === 'day' ? '仅日期' : '含时刻'}`
                                : '日期待考'}
                            </span>
                          )}
                        </div>

                        {rev && (
                          <div className="flex items-center gap-2 shrink-0">
                            {available ? (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() =>
                                    setPreviewRevisionId((prev) =>
                                      prev === rev.revision_id ? '' : rev.revision_id
                                    )
                                  }
                                >
                                  <FileText className="w-3 h-3 shrink-0" />
                                  <span>{isActivePreview ? '收起正文' : '看该时点内容'}</span>
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => onOpenRevision(fileId, rev.revision_id)}
                                >
                                  <BookOpen className="w-3 h-3 shrink-0" />
                                  <span>阅读器打开</span>
                                </Button>
                              </>
                            ) : (
                              <span
                                className="px-2 py-1 rounded-[var(--r-ctl)] font-medium text-[length:var(--text-micro)] border-[color:color-mix(in_srgb,var(--stage-ink-decision)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_10%,transparent)] text-[color:var(--stage-ink-decision-text)] flex items-center gap-1"
                                title="该版本快照已超出保留配额被清理，只能查看版本元数据"
                              >
                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                <span>已过保留期 · 无法点开</span>
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {node.events.length > 0 && (
                        <div className="mt-2.5 pt-2.5 border-t border-[#26243D]/10 space-y-2">
                          {node.events.map((ev) => (
                            <div key={ev.event_id} className="text-xs">
                              <div className="flex flex-wrap items-center gap-2 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                                <span className="text-[color:var(--accent-iris-deep)]">{kindLabel(ev.kind)}</span>
                                <span aria-hidden="true">·</span>
                                <span>{formatLocalDateTime(anchorOfEvent(ev))}</span>
                                {rev && !ev.revision_id && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="text-[color:var(--ink-soft)]">按时间挂载</span>
                                  </>
                                )}
                              </div>
                              <div className="mt-0.5 text-[color:var(--ink-strong)] leading-relaxed">
                                {ev.headline}
                              </div>
                              {ev.detail && (
                                <div className="mt-0.5 text-[length:var(--text-micro)] text-[color:var(--ink-soft)] leading-relaxed">
                                  {ev.detail}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {rev && available && isActivePreview && (
                        <div className="mt-2.5 pt-2.5 border-t border-[#26243D]/10">
                          <div
                            className="mb-2 flex items-center justify-between font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] tabular-nums"
                            data-timeline-preview-meta=""
                          >
                            <span>该时点正文 · v{rev.seq}</span>
                            <span>{(rev.size_bytes / 1024).toFixed(1)} KB</span>
                          </div>
                          {isPdf ? (
                            <iframe
                              title={`版本 v${rev.seq} 原文（PDF）`}
                              src={`${revisionRawUrl(rev.revision_id)}#toolbar=0&navpanes=0&view=FitH`}
                              className="w-full h-72 rounded border border-[#26243D]/10 bg-white"
                            />
                          ) : previewLoading ? (
                            <div role="status" className="flex flex-col items-center gap-2.5 py-4 w-full">
                              <GlassSkeleton lines={2} className="w-full max-w-md" />
                              <span className="text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">
                                正在按版本读取正文…
                              </span>
                            </div>
                          ) : previewError ? (
                            <div className="text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--stage-ink-decision-text)] flex items-start gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                              <span>{previewError}</span>
                            </div>
                          ) : isHtml && previewText ? (
                            (() => {
                              const prepared = buildHtmlSandboxDocument(previewText, {
                                allowScripts: true,
                                allowExternalHttps: false,
                              });
                              return (
                                <iframe
                                  title={`版本 v${rev.seq} 原文（HTML 沙盒渲染）`}
                                  sandbox={prepared.sandboxAttr}
                                  srcDoc={prepared.srcDoc}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-72 rounded border border-[#26243D]/10 bg-white"
                                />
                              );
                            })()
                          ) : (
                            <pre className="p-3 rounded border border-[#26243D]/10 bg-white/70 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
                              {previewText || '（该版本正文为空）'}
                            </pre>
                          )}
                        </div>
                      )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        </ScrollArea>

        <div className="px-5 py-3 border-t border-border/80 bg-card/80 text-[11px] text-muted-foreground shrink-0">
          版本正文一律按 revision_id 从持久快照读取（/revisions/&lt;id&gt;/content），
          绝不用磁盘当前内容冒充历史版本；「已过保留期」版本仅保留元数据。
        </div>
      </div>
    </div>
  );
};
