export type DocumentEvent = {
  line: number;
  end: number;
  title: string;
  kind: '章节' | '步骤' | '记录';
  checked?: boolean;
  date?: string;
  children: DocumentEvent[];
};

// Keep original line numbers when ignoring YAML metadata and fenced examples.
export function markdownLines(source: string): string[] {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const yamlEnd = lines[0]?.trim() === '---'
    ? lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line))
    : -1;
  let fence = '';
  return lines.map((line, i) => {
    if (i <= yamlEnd) return '';
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = '';
      return '';
    }
    if (marker) { fence = marker; return ''; }
    return line;
  });
}

function plain(text: string) {
  return text.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').trim();
}

function eventDate(title: string) {
  return /^(?:\[)?(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?|\d{1,2}:\d{2})(?=[\s\]：:·—]|$)/.exec(title)?.[1];
}

function stepTitle(text: string) {
  const stripTag = (value: string) => value.replace(/^\[(?:P\d(?:\s*[-–]\s*[^\]]+)?|已完成|待确认)\]\s*/, '');
  const bold = /^\*\*(.+?)\*\*/.exec(text)?.[1];
  const label = bold && stripTag(bold).trim() ? stripTag(bold) : stripTag(plain(text));
  return label.trim().replace(/[。：]$/, '');
}

/** Document order is the default. A peer group is dated only when every entry supplies a comparable date. */
export function orderedEvents(events: DocumentEvent[]): DocumentEvent[] {
  if (events.length < 2 || !events.every((event) => event.date)) return events;
  const dates = events.every((event) => /^\d{4}-/.test(event.date!));
  const times = events.every((event) => /^\d{1,2}:/.test(event.date!));
  if (!dates && !times) return events;
  const key = (event: DocumentEvent) => times ? event.date!.padStart(5, '0') : event.date!.replace('T', ' ');
  return [...events].sort((a, b) => key(a).localeCompare(key(b)) || a.line - b.line);
}

export function documentEvents(source: string): DocumentEvent[] {
  const lines = markdownLines(source);
  const roots: DocumentEvent[] = [];
  const headings: { level: number; event: DocumentEvent }[] = [];
  const items: { indent: number; event: DocumentEvent }[] = [];
  let inTable = false;
  const clearItems = (end: number, indent = -1) => {
    while (items.length && items[items.length - 1].indent >= indent) items.pop()!.event.end = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(raw);
    if (heading) {
      clearItems(i);
      while (headings.length && headings[headings.length - 1].level >= heading[1].length) {
        headings.pop()!.event.end = i;
      }
      const title = plain(heading[2].replace(/\s+#+\s*$/, ''));
      const event: DocumentEvent = { line: i + 1, end: lines.length, title, date: eventDate(title), kind: '章节', children: [] };
      (headings.at(-1)?.event.children ?? roots).push(event);
      headings.push({ level: heading[1].length, event });
      inTable = false;
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*\|/.test(raw)) { inTable = true; continue; }
    const row = inTable && /^\s*\|/.test(raw);
    if (!row) inTable = false;
    const list = /^(\s*)(?:[-*+]\s+|\d+[.)、]\s*)(?:\[([ xX])\]\s*)?(.+)$/.exec(raw);
    const dated = eventDate(plain(raw));
    if (!list && !row && !dated) {
      if (!raw.trim() || /^\S/.test(raw)) clearItems(i);
      continue;
    }
    const indent = list ? list[1].replace(/\t/g, '    ').length : 0;
    clearItems(i, indent);
    const text = list ? stepTitle(list[3]) : plain(row ? raw.trim().replace(/^\|/, '').split('|')[0] : raw);
    if (!text) continue;
    const event: DocumentEvent = {
      line: i + 1, end: i + 1, title: text,
      kind: list ? '步骤' : '记录', date: eventDate(text),
      checked: list?.[2] === undefined ? undefined : list[2].toLowerCase() === 'x', children: [],
    };
    (items.at(-1)?.event.children ?? headings.at(-1)?.event.children ?? roots).push(event);
    if (list) items.push({ indent, event });
  }
  clearItems(lines.length);
  // Most plans have one H1 giving the document title. Start directly at its phases.
  if (roots.length === 1 && roots[0].kind === '章节' && roots[0].children.length) return roots[0].children;
  return roots;
}

export function findDocumentEvent(events: DocumentEvent[], line: number): DocumentEvent | undefined {
  for (const event of events) {
    if (event.line === line) return event;
    if (event.line < line && line <= event.end) {
      const nested = findDocumentEvent(event.children, line);
      if (nested) return nested;
    }
  }
}
