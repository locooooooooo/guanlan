import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight } from 'lucide-react';
import { GraphCanvasView, type GraphCanvasViewProps } from './GraphCanvasView';
import { EventTimelineCanvas, type LinkedDocument } from './EventTimelineCanvas';
import { DocumentTimeMachineView } from './DocumentTimeMachineView';
import { documentEvents, findDocumentEvent, orderedEvents, type DocumentEvent } from '../utils/documentEvents';
import { documentLinks } from '../utils/documentLinks';
import { fetchRevisionContent } from '../services/workspaceClient';
import type { FileRecord } from '../types/guanlan';
import { basenameOf } from '../utils/documentIdentity';
import { isTimeMachineFormat } from '../utils/formatMeta';

export interface EventFrame {
  fileId: string;
  revisionId: string;
  line?: number;
  name: string;
  eventId?: string;
}
type Props = Omit<GraphCanvasViewProps, 'onExploreFile'> & {
  trail: EventFrame[];
  setTrail: React.Dispatch<React.SetStateAction<EventFrame[]>>;
  visible: boolean;
  root: string;
  onReadEvidence: (fileId: string, revisionId: string, line?: number) => void;
};

export function enterEventFrame(previous: EventFrame[], file: FileRecord, line?: number, name = file.title, revisionId = file.current_revision_id, eventId?: string): EventFrame[] {
  const index = previous.findIndex(f => f.fileId === file.file_id && f.revisionId === revisionId && f.line === line);
  return index >= 0 ? previous.slice(0, index + 1) : [...previous, { fileId: file.file_id, revisionId, line, name, eventId }];
}

export function KnowledgeGraph({ visible, root, trail, setTrail, onReadEvidence, ...graph }: Props) {
  const go = (file: FileRecord, line?: number, name = file.title, revisionId = file.current_revision_id, eventId?: string) => {
    setTrail(prev => enterEventFrame(prev, file, line, name, revisionId, eventId));
  };
  const backTo = (depth: number) => {
    if (depth === 0 && trail[0]) graph.onSelectFile(trail[0].fileId, trail[0].revisionId);
    setTrail(prev => prev.slice(0, depth));
  };
  useEffect(() => {
    if (!visible || !trail.length) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]') ||
          document.querySelector('[data-esc-layer="open"]') ||
          (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]'))) return;
      event.stopImmediatePropagation();
      backTo(trail.length - 1);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [visible, trail]);
  return <>
    <div className={trail.length ? 'hidden' : 'flex h-full w-full flex-1 min-h-0'}>
      <GraphCanvasView {...graph} visible={visible} onExploreFile={(id, revisionId, eventId) => {
        const file = graph.files.find(f => f.file_id === id);
        if (file) go(file, undefined, file.title, revisionId ?? file.current_revision_id, eventId);
      }}/>
    </div>
    {trail.map((frame, index) => {
      const file = graph.files.find(f => f.file_id === frame.fileId);
      if (!file) return null;
      return <EventLevel key={JSON.stringify([frame.fileId, frame.revisionId, frame.line])}
        active={visible && index === trail.length - 1} frame={frame} trail={trail.slice(0, index + 1)}
        root={root} file={file} graph={graph} onGo={go} onRead={onReadEvidence}
        onBack={backTo}/>;
    })}
  </>;
}

interface LevelProps {
  active: boolean;
  frame: EventFrame;
  trail: EventFrame[];
  root: string;
  file: FileRecord;
  graph: Omit<GraphCanvasViewProps, 'onExploreFile'>;
  onGo: (file: FileRecord, line?: number, title?: string, revisionId?: string) => void;
  onBack: (depth: number) => void;
  onRead: Props['onReadEvidence'];
}

const PAGE_SIZE = 8;
function siblingEvents(events: DocumentEvent[], line: number): DocumentEvent[] {
  const parent = events.find(event => event.line <= line && event.end >= line);
  if (!parent) return [];
  return parent.line === line ? orderedEvents(events) : siblingEvents(parent.children, line);
}
export function EventLevel({ active, frame, trail, root, file, graph, onGo, onBack, onRead }: LevelProps) {
  const rev = file.revisions.find(r => r.revision_id === frame.revisionId);
  const [fetched, setFetched] = useState<string>();
  const [error, setError] = useState('');
  const [selectedLine, setSelectedLine] = useState<number>();
  const [page, setPage] = useState(0);
  const content = rev?.markdownContent ?? fetched;
  useEffect(() => {
    if (!active || file.format !== 'md' || frame.line === undefined || content !== undefined || !rev || error) return;
    let cancelled = false;
    (async () => {
      const result = await fetchRevisionContent(frame.revisionId);
      if (!result.ok) {
        throw Error(
          result.code === 'SNAPSHOT_UNAVAILABLE'
            ? '此版本正文已过保留期，仅保留版本元数据。'
            : result.error || '读取失败'
        );
      }
      if (!cancelled) setFetched(result.text ?? '');
    })().catch(err => { if (!cancelled) setError(String(err.message || err)); });
    return () => { cancelled = true; };
  }, [active, frame.revisionId, file.format, content, rev, error]);

  const tree = useMemo(() => documentEvents(content ?? ''), [content]);
  const section = frame.line === undefined ? undefined : findDocumentEvent(tree, frame.line);
  const entries = useMemo(() => orderedEvents(section?.children ?? tree), [section, tree]);
  const selected = entries.find(entry => entry.line === selectedLine);
  const focus = selected ?? section;
  const lines = useMemo(() => (content ?? '').split(/\r?\n/), [content]);
  const byId = useMemo(() => new Map(graph.files.map(f => [f.file_id, f])), [graph.files]);
  const readLinks = useMemo(() => documentLinks(graph.files, root), [graph.files, root]);
  const outgoing = useMemo(() => file.format === 'md' && content !== undefined
    ? readLinks(file, content)
    : graph.relations.filter(r => r.source_id === file.file_id && !r.isInferred),
    [file, content, readLinks, graph.relations]);
  const linked = useMemo(() => {
    const links = new Map<string, LinkedDocument>();
    for (const edge of outgoing) {
      if (focus && (!edge.locator || edge.locator.startLine < focus.line || edge.locator.startLine > focus.end)) continue;
      const target = byId.get(edge.target_id);
      if (target) links.set(target.file_id, { fileId: target.file_id, title: target.title, label: edge.label + (edge.locator ? ' · L' + edge.locator.startLine : '') });
    }
    if (!focus) for (const edge of graph.relations) {
      if (edge.target_id !== file.file_id || edge.isInferred) continue;
      const source = byId.get(edge.source_id);
      if (source && !links.has(source.file_id)) links.set(source.file_id, { fileId: source.file_id, title: source.title, label: '引用本文件' });
    }
    return [...links.values()];
  }, [file, focus, graph.relations, outgoing, byId]);
  const siblings = useMemo(() => graph.files.filter(f => f.file_id !== file.file_id && f.folder === file.folder), [graph.files, file]);
  const decisions = graph.decisions.filter(d => d.evidences.some(e => e.file_id === file.file_id &&
    e.revision_id === frame.revisionId && (!focus || (e.lineStart <= focus.end && e.lineEnd >= focus.line))));
  const selectedIndex = entries.findIndex(entry => entry.line === selectedLine);
  const peers = useMemo(() => section ? siblingEvents(tree, section.line) : [], [tree, section]);
  const peerIndex = section ? peers.indexOf(section) : -1;
  const previousPhase = peerIndex > 0 ? peers[peerIndex - 1] : undefined;
  const nextPhase = peerIndex >= 0 ? peers[peerIndex + 1] : undefined;
  function select(entry: DocumentEvent, descend = true) {
    setSelectedLine(entry.line);
    setPage(Math.floor(entries.indexOf(entry) / PAGE_SIZE));
    if (descend && entry.children.length) onGo(file, entry.line, entry.title, frame.revisionId);
  }
  function step(delta: number) {
    const next = entries[selectedIndex + delta];
    if (next) select(next, false);
    else {
      const peer = delta > 0 ? nextPhase : previousPhase;
      if (peer) onGo(file, peer.line, peer.title, frame.revisionId);
    }
  }
  const goLink = (id: string) => { const target = byId.get(id); if (target) onGo(target); };
  const openText = () => onRead(file.file_id, frame.revisionId, focus?.line);
  const first = focus ? focus.line - 1 : 0;
  const last = focus?.end ?? Math.min(lines.length, 12);
  const excerpt = lines.slice(first, Math.min(last, first + 14)).join('\n').trim();
  const dated = entries.length > 0 && entries.every(e => e.date && /^\d{4}-/.test(e.date)) ||
    entries.length > 0 && entries.every(e => e.date && /^\d{1,2}:/.test(e.date));
  const offset = page * PAGE_SIZE;
  if (isTimeMachineFormat(file.format) && frame.line === undefined) {
    return <DocumentTimeMachineView active={active} file={file} frame={frame} trail={trail}
      root={root} files={graph.files} relations={graph.relations} decisions={graph.decisions}
      onGo={onGo} onBack={onBack} onRead={onRead}/>;
  }
  return <section className="event-workspace" hidden={!active} aria-label="文档事件图谱">
    <div className="event-toolbar">
      <button onClick={() => onBack(trail.length - 1)} aria-label="返回上一级画布"><ArrowLeft size={15}/> 返回</button>
      <nav aria-label="图谱路径"><button onClick={() => onBack(0)}>工程画布</button>
        {trail.map((item, i) => <span key={i}><ChevronRight size={12}/><button onClick={() => onBack(i + 1)} title={item.name}>{item.name}</button></span>)}
      </nav>
      <span className="event-order">{dated ? '按文内时间' : '按原文顺序'}</span>
    </div>
    <div className="event-stage">
      <aside className="event-panel event-directory">
        <h3>事件目录 <small>{entries.length}</small></h3>
        <div className="event-list">{entries.map((entry, i) => <button key={entry.line}
          aria-current={entry.line === selectedLine ? 'step' : undefined} onClick={() => select(entry)}>
          <small>{String(i + 1).padStart(2, '0')}</small><span>{entry.title}</span>{entry.children.length > 0 && <ChevronRight size={12}/>}
        </button>)}</div>
        {siblings.length > 0 && <details open={siblings.length <= 4}><summary>同目录资料 · {siblings.length}</summary>
          {siblings.map(f => <button key={f.file_id} className="event-doc-link" onClick={() => onGo(f)}>{f.title} <em>{f.format.toUpperCase()}</em></button>)}
        </details>}
      </aside>
      <div className="event-center">
        {error ? <p role="alert">{error} <button onClick={() => setError('')}>重试</button></p> :
         file.format === 'md' && content === undefined ? <p role="status">正在读取文内事件…</p> : null}
        <EventTimelineCanvas title={section?.title ?? file.title} subtitle={file.format.toUpperCase() + ' · ' + (section ? '章节' : '文档时间轴')}
          nodes={entries.slice(offset, offset + PAGE_SIZE)} offset={offset} total={entries.length} selected={selectedLine}
          links={linked} onSelect={select} onLink={goLink} onNext={() => {
            if (selectedIndex < entries.length - 1 || nextPhase) step(1);
            else if (linked[0]) goLink(linked[0].fileId);
          }} onRead={openText} active={active}/>
        {entries.length > PAGE_SIZE && <div className="event-paging">
          <button disabled={!page} onClick={() => setPage(page - 1)}>上一组</button>
          <span>{offset + 1}–{Math.min(entries.length, offset + PAGE_SIZE)} / {entries.length}</span>
          <button disabled={offset + PAGE_SIZE >= entries.length} onClick={() => setPage(page + 1)}>下一组</button>
        </div>}
      </div>
      <aside className="event-panel event-inspector" aria-label="事件依据">
        <small>已选中 · 层级 {trail.length}</small>
        <h2>{focus?.title ?? file.title}</h2>
        <div className="event-location" title={file.relative_path}>{basenameOf(file.relative_path)}</div>
        <div className="event-meta"><span>{file.format.toUpperCase()} · v{rev?.versionNumber ?? '?'}</span>
          {focus && <span>L{focus.line}{focus.end !== focus.line && '–' + focus.end}</span>}{focus?.checked !== undefined && <span>{focus.checked ? '已勾选' : '待处理'}</span>}
          {focus?.date && <span>{focus.date}</span>}
        </div>
        {excerpt && <><h3>原文依据</h3><pre>{excerpt}</pre></>}
        <button className="event-read" onClick={openText}><BookOpen size={14}/> {focus ? '阅读此处原文' : '打开原文'}</button>
        {selected && selected.children.length > 0 && <button className="event-doc-link" onClick={() => select(selected)}>展开此事件 · {selected.children.length} 项 <ArrowRight size={14}/></button>}
        {(entries.length > 0 || previousPhase || nextPhase) && <div className="event-step-actions">
          <button disabled={selectedIndex < 1 && !previousPhase} onClick={() => step(-1)}>{selectedIndex < 1 && previousPhase ? '上一阶段' : '上一事件'}</button>
          <button disabled={selectedIndex >= entries.length - 1 && !nextPhase} onClick={() => step(1)}>{selectedIndex >= entries.length - 1 && nextPhase ? '下一阶段' : '下一事件'} <ArrowRight size={13}/></button>
        </div>}
        {linked.length > 0 && <><h3>沿引用继续 <small>{linked.length}</small></h3>{linked.map(link =>
          <button className="event-doc-link" key={link.fileId} onClick={() => goLink(link.fileId)}>{link.title}<em>{link.label}</em></button>)}</>}
        {decisions.length > 0 && <><h3>相关决策</h3>{decisions.map(d =>
          <button key={d.decision_id + d.evidences[0]?.lineStart} className="event-doc-link" onClick={() => graph.onOpenDecisionModal(d.decision_id)}>{d.question}<em>{d.status}</em></button>)}</>}
        {siblings.length > 0 && <details className="event-compact-files"><summary>同目录资料 · {siblings.length}</summary>
          {siblings.map(f => <button key={f.file_id} className="event-doc-link" onClick={() => onGo(f)}>{f.title}<em>{f.format.toUpperCase()}</em></button>)}
        </details>}
      </aside>
    </div>
  </section>;
}

