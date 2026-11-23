/**
 * 观澜 v0.4 第一轮 —— 服务端派生：决策陈述与引用关系
 *
 * 对应方案 §1 的具体标识问题与 §5「将决定的业务 ID 与陈述 ID 分开」：
 * - 每条来源陈述都有独立 statement_id（同编号不同问题绝不共用身份）
 * - 业务决定 ID 由「命名空间 + 归一化问题」推导，只有同问题才归入同一决定
 * - 引用绑定到来源版本，并记录目标版本是否已知
 */

import type { StatementRow, EdgeRow, TimeSource, TimePrecision } from './WorkspaceStore';
import { EXTRACT_RULE_VERSION } from './WorkspaceStore';

export interface DeriveInput {
  workspaceId: string;
  fileId: string;
  revisionId: string;
  relativePath: string;
  folder: string;
  title: string;
  format: 'md' | 'svg' | 'pdf';
  content: string;
  observedAt: string;
  /** 工作区根目录：用于把原文中的绝对路径链接映射回工作区相对路径 */
  rootPath: string;
  /** 已知文件路径 → file_id，用于把链接解析成有依据的关系 */
  pathIndex: Map<string, string>;
  /** 目标文件当时的最新版本（引用随来源版本演进时记为 collected_version） */
  targetRevisionIndex: Map<string, string>;
}

const stripMd = (s: string) =>
  s
    .replace(/^[-*\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function detectStatus(text: string): string {
  // 去掉加粗/行内代码标记后再匹配，兼容「**当前状态**：已确认」这类写法
  const plain = text.replace(/\*\*/g, '').replace(/`/g, '');
  if (/状态[：:]\s*已确认/.test(plain) || /回执状态[：:]\s*已确认/.test(plain)) return '已确认';
  if (/状态[：:]\s*已否决/.test(plain)) return '已否决';
  if (/状态[：:]\s*已搁置/.test(plain)) return '已搁置';
  if (/状态[：:]\s*已取代/.test(plain)) return '已取代';
  if (/来源不一致/.test(plain)) return '来源不一致';
  if (/待确认/.test(plain)) return '待确认';
  return '未知';
}

/**
 * 归一化问题文本用于判定「是否同一项决定」。
 * 去掉空白、标点差异与编号前缀，保留语义主干。
 */
function normalizeQuestion(q: string): string {
  return q
    .replace(/\s+/g, '')
    .replace(/[：:，,。.、；;（）()【】\[\]"'"']/g, '')
    .replace(/^(Q\d+|q\d+)/, '')
    .toLowerCase()
    .slice(0, 60);
}

function stableKey(input: string): string {
  // 短摘要：用于 statement/decision/edge 的可重放身份，重试沿用同一记录标识
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 从条目正文提取选项、推荐语与影响范围。
 * 推荐语保留原文限定（“推荐”不等于“已确认”）。
 */
function extractDetail(bodyLines: string[]): {
  options: string[];
  recommendation: string;
  impactBlocked: string[];
  impactAllowed: string[];
  confirmer: string | null;
} {
  const body = bodyLines.join('\n');

  const options: string[] = [];
  const optionLine = bodyLines.find((l) => /可选方案/.test(l));
  if (optionLine) {
    const raw = stripMd(optionLine).replace(/^可选方案[：:]?/, '');
    for (const part of raw.split(/\s*\/\s*/)) {
      if (part.trim().length > 2) options.push(part.trim());
    }
  }
  for (const line of bodyLines) {
    const m = /[-*]\s*\*\*选项\s*([A-Z])[*]{0,2}[：:]\s*(.+)/.exec(line.trim());
    if (m) options.push(`选项 ${m[1]}：${m[2].trim()}`);
  }

  const recLine = bodyLines.find((l) => /推荐及理由|推荐采用/.test(l));
  const recommendation = recLine ? stripMd(recLine).replace(/^推荐及理由[：:]?/, '').slice(0, 300) : '';

  const impactLine = bodyLines.find((l) => /影响与等待范围/.test(l));
  const impactText = impactLine ? stripMd(impactLine).replace(/^影响与等待范围[：:]?/, '') : '';
  const impactBlocked = impactText
    .split(/[；;。]/)
    .map((s) => s.trim())
    .filter((s) => s && !/不阻断|非阻塞|可继续/.test(s))
    .slice(0, 4);
  const impactAllowed = impactText
    .split(/[；;。]/)
    .map((s) => s.trim())
    .filter((s) => /不阻断|非阻塞|可继续/.test(s))
    .slice(0, 4);

  const confirmerMatch = /确认人[：:]\s*([^\n，,；;]{2,40})/.exec(body);

  return {
    options,
    recommendation,
    impactBlocked,
    impactAllowed,
    confirmer: confirmerMatch ? confirmerMatch[1].replace(/\*\*/g, '').trim() : null,
  };
}

/**
 * 抽取决策陈述。
 * 支持两种真实格式：
 *   A：## N 标题 + `**沿用编号**：Q01/Q02` + `状态：**待确认**`
 *   B：### Q01：标题 + 当前状态：已确认
 */
export function deriveStatements(input: DeriveInput): StatementRow[] {
  const lines = input.content.split('\n');
  const namespaceBase = `${input.folder === '.' ? '' : input.folder + ' / '}${input.title}`;
  const out: StatementRow[] = [];
  const seen = new Set<string>();

  const push = (
    code: string,
    question: string,
    status: string,
    quote: string,
    lineStart: number,
    lineEnd: number,
    bodyLines: string[]
  ) => {
    const identity = `${code}|${lineStart}`;
    if (seen.has(identity)) return;
    seen.add(identity);

    // 业务决定 ID：命名空间 + 归一化问题 —— 同问题才同一决定，不同问题各自独立
    const decisionId = `dec_${stableKey(`${namespaceBase}::${normalizeQuestion(question)}`)}`;
    const statementId = `stmt_${stableKey(`${input.revisionId}::${code}::L${lineStart}`)}`;
    const detail = extractDetail(bodyLines);

    out.push({
      statement_id: statementId,
      workspace_id: input.workspaceId,
      file_id: input.fileId,
      revision_id: input.revisionId,
      code,
      namespace: namespaceBase,
      question: question.slice(0, 200),
      status,
      quote: quote.slice(0, 400),
      line_start: lineStart,
      line_end: lineEnd,
      decision_id: decisionId,
      detail_json: JSON.stringify(detail),
      extract_rule_version: EXTRACT_RULE_VERSION,
      observed_at: input.observedAt,
    });
  };

  const sectionBody = (start: number, end: number): string[] => {
    const body: string[] = [];
    let inFence = false;
    for (let i = start; i < end; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) inFence = !inFence;
      if (!inFence && /^#{1,3}\s+/.test(line.trim()) && i > start) break;
      body.push(line);
    }
    return body;
  };

  // 格式 A：## N 标题 + 沿用编号
  let currentTitle = '';
  let currentStart = 0;
  const sections: Array<{ title: string; start: number; body: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^##\s+(\d+[\.、\s].+)$/.exec(lines[i].trim());
    if (h) {
      if (currentTitle) sections.push({ title: currentTitle, start: currentStart, body: sectionBody(currentStart, i) });
      currentTitle = h[1].trim();
      currentStart = i + 1;
    }
  }
  if (currentTitle) sections.push({ title: currentTitle, start: currentStart, body: sectionBody(currentStart, lines.length) });

  for (const section of sections) {
    const codeLine = section.body.find((l) => /沿用编号|决策编号/.test(l));
    if (!codeLine) continue;
    const codes = Array.from(new Set((codeLine.match(/Q\s*\d+/gi) || []).map((c) => c.replace(/\s+/g, '').toUpperCase())));
    if (!codes.length) continue;
    const status = detectStatus(section.body.join('\n'));
    const quote = stripMd(section.body.filter((l) => l.trim()).join(' '));
    for (const code of codes) {
      push(code, section.title, status, quote, section.start + 1, section.start + section.body.length, section.body);
    }
  }

  // 格式 B：### Q01：标题
  for (let i = 0; i < lines.length; i++) {
    const m = /^###\s+(Q\d+)\s*[:：]\s*(.+)$/.exec(lines[i].trim());
    if (!m) continue;
    const bodyLines = sectionBody(i + 1, Math.min(i + 26, lines.length));
    push(m[1].toUpperCase(), m[2].trim(), detectStatus(bodyLines.join('\n')), stripMd(bodyLines.filter((l) => l.trim()).join(' ')), i + 1, i + bodyLines.length, bodyLines);
  }

  // 疑似决策候选：带「是不是可以考虑/口头探讨/尚未形成正式提案」的段落不计入真实待确认
  return out;
}

/**
 * 抽取引用关系并绑定到来源版本。
 * 相对路径按当前文档所在目录解析（避免 v0.3 已修的 endsWith 误匹配）。
 */
export function deriveEdges(input: DeriveInput): EdgeRow[] {
  if (input.format !== 'md') return [];
  const lines = input.content.split('\n');
  const edges: EdgeRow[] = [];
  const seen = new Set<string>();
  const currentDir = input.relativePath.includes('/')
    ? input.relativePath.slice(0, input.relativePath.lastIndexOf('/'))
    : '.';

  const linkRegex = /\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null;
    linkRegex.lastIndex = 0;
    while ((m = linkRegex.exec(lines[i])) !== null) {
      const hrefRaw = m[2];
      if (/^(https?:|mailto:|data:)/i.test(hrefRaw)) continue;

      // 支持三元形式：[文字](相对路径) / [文字](<C:/绝对路径>) / [文字](path "title")
      let href = hrefRaw.trim();
      if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim();
      try {
        href = decodeURIComponent(href);
      } catch {
        /* 保留原样 */
      }
      href = href.split('#')[0];
      if (!href) continue;

      const resolved = resolveWorkspacePath(input.rootPath, currentDir, href);
      if (resolved === null) continue; // 绝对路径指向工作区之外：不授予新目录权限

      const targetFileId = input.pathIndex.get(resolved);

      const edgeIdentity = `${input.revisionId}|${resolved}|${i + 1}`;
      const edgeId = `edge_${stableKey(edgeIdentity)}`;
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);

      const targetRevisionId = targetFileId ? input.targetRevisionIndex.get(targetFileId) ?? null : null;
      const resolution: EdgeRow['resolution'] = targetFileId
        ? targetRevisionId
          ? 'collected_version'
          : 'current_path_only'
        : 'unresolved';

      edges.push({
        edge_id: edgeId,
        workspace_id: input.workspaceId,
        source_file_id: input.fileId,
        source_revision_id: input.revisionId,
        target_file_id: targetFileId ?? `unresolved:${resolved}`,
        target_revision_id: targetRevisionId,
        kind: 'explicit_reference',
        resolution,
        locator_start: i + 1,
        locator_end: i + 1,
        reason: `${input.relativePath} 第 ${i + 1} 行链接指向 ${resolved}${
          resolution === 'unresolved' ? '（工作区内未找到该路径）' : ''
        }`,
      });
    }
  }
  return edges;
}

function normalizeJoin(dir: string, rel: string): string {
  const combined = rel.startsWith('/') ? rel.slice(1) : `${dir}/${rel}`;
  const parts = combined.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * 把原文链接解析成工作区相对路径。
 * - 相对路径：按当前文档所在目录解析
 * - 根相对（/a/b）：按工作区根解析
 * - 绝对路径（C:/...）：仅当落在已配置根目录内才映射；越界返回 null
 */
function resolveWorkspacePath(
  rootPath: string,
  currentDir: string,
  href: string
): string | null {
  const unix = href.replace(/\\/g, '/');
  const normRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');

  if (/^[a-zA-Z]:\//.test(unix)) {
    if (unix.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
      return normalizeJoin('.', unix.slice(normRoot.length + 1));
    }
    if (unix.toLowerCase() === normRoot.toLowerCase()) return '';
    return null;
  }
  if (unix.startsWith('/')) {
    return normalizeJoin('.', unix.slice(1));
  }
  return normalizeJoin(currentDir, unix);
}

/**
 * 从正文抽取「材料记载的发生时间」及其来源与精度。
 * 优先级：front matter date / 文档日期 / 正文声明日期；都没有则返回 null 由 mtime 兜底。
 */
export function deriveDocumentTime(content: string): {
  occurredAt: string | null;
  precision: TimePrecision;
  source: TimeSource | null;
} {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const candidates: string[] = [];
  if (fm) {
    const dateLine = /^(?:date|updated|created)\s*:\s*(.+)$/m.exec(fm[1]);
    if (dateLine) candidates.push(dateLine[1]);
  }
  const docDate = /文档日期[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(content);
  if (docDate) candidates.push(docDate[1]);
  const isoDate = /(\d{4}-\d{2}-\d{2})/.exec(content.slice(0, 1200));
  if (isoDate) candidates.push(isoDate[1]);

  for (const raw of candidates) {
    const cleaned = raw.trim().replace(/["']/g, '');
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cleaned);
    if (m) {
      // 只有日期：保留到天，不补零点时刻（方案 §3「只到日的事项归在日期组，不补零点」）
      return { occurredAt: `${m[1]}-${m[2]}-${m[3]}`, precision: 'day', source: 'document_self' };
    }
  }
  return { occurredAt: null, precision: 'unknown', source: null };
}
