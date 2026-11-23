/**
 * 观澜 v0.4 第一轮 —— 持久库 → 前端契约的投影
 *
 * 目的：现有 Graph / Timeline / Reader / Diff 组件不改结构，只把数据来源换成持久库。
 * 方案 §4「一份历史记录，同时服务三个视图」：三个视图读取同一份 versions/events。
 *
 * 注意：完整的多版本 revisions 全部投影给前端（第一轮要求「重启后仍能打开三个版本」），
 * 正文按快照大小内联；超大快照留给按版本取内容接口。
 */

import fs from 'node:fs';

import type {
  DecisionAssertion,
  FileRecord,
  RelationEdge,
  Revision,
  TimelineEvent,
  WorkspaceConfig,
  CoverageKind,
} from '../src/types/guanlan';
import type { WorkspaceStore, RevisionRow, EventRow, StatementRow, EdgeRow, FileRow } from './WorkspaceStore';
import { safeJson } from './queries';

const INLINE_LIMIT_BYTES = 256 * 1024;

export interface ProjectedWorkspace {
  config: WorkspaceConfig;
  files: FileRecord[];
  events: TimelineEvent[];
  decisions: DecisionAssertion[];
  relations: RelationEdge[];
  readingStates: Record<string, never>;
  scanDiagnostics: {
    errors: string[];
    scannedAt: string;
    durationHint: string;
    source: 'store';
    totalFiles: number;
    totalRevisions: number;
    totalEvents: number;
    baseline: boolean;
  };
}

function emptyGravatar(): Record<string, never> {
  return {};
}

function folderOf(relativePath: string): string {
  const rel = relativePath.replace(/\\/g, '/');
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '.' : rel.slice(0, idx);
}

function titleOf(relativePath: string): string {
  const base = relativePath.replace(/\\/g, '/').split('/').pop() || relativePath;
  return base.replace(/\.(md|markdown|svg|pdf)$/i, '');
}

function svgHasText(source: string | null): boolean {
  return Boolean(source && /<text[\s>]/i.test(source));
}

export function projectWorkspace(
  store: WorkspaceStore,
  rootPath: string,
  options: { eventLimit?: number } = {}
): ProjectedWorkspace {
  const ws = store.ensureWorkspace(rootPath);
  const eventLimit = options.eventLimit ?? 2000;

  const activeFiles = store.listFiles(ws.workspace_id, false);
  const allFiles = store.listFiles(ws.workspace_id, true);

  const revisionRows = store.db
    .prepare('SELECT * FROM revisions WHERE workspace_id = ? ORDER BY file_id ASC, seq ASC')
    .all(ws.workspace_id) as unknown as RevisionRow[];

  const eventRows = store.db
    .prepare('SELECT * FROM events WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?')
    .all(ws.workspace_id, eventLimit) as unknown as EventRow[];

  const statements = store.listStatements(ws.workspace_id);
  const edges = store.listEdges(ws.workspace_id);

  // 索引
  const fileById = new Map<string, FileRow>();
  for (const f of allFiles) fileById.set(f.file_id, f);
  const fileByPath = new Map<string, FileRow>();
  for (const f of allFiles) fileByPath.set(f.current_path.replace(/\\/g, '/'), f);

  const revisionsByFile = new Map<string, RevisionRow[]>();
  const fileIdByRevision = new Map<string, string>();
  for (const rev of revisionRows) {
    if (!revisionsByFile.has(rev.file_id)) revisionsByFile.set(rev.file_id, []);
    revisionsByFile.get(rev.file_id)!.push(rev);
    fileIdByRevision.set(rev.revision_id, rev.file_id);
  }

  // 变更章节（来自 modified 事件的 payload）
  const changedSectionsByRevision = new Map<string, string[]>();
  const rollbackRevisions = new Set<string>();
  for (const ev of eventRows) {
    if (!ev.revision_id) continue;
    try {
      const payload = JSON.parse(ev.payload_json || '{}');
      if (Array.isArray(payload.changed_sections) && payload.changed_sections.length) {
        changedSectionsByRevision.set(ev.revision_id, payload.changed_sections);
      }
    } catch {
      /* payload 异常不影响读取 */
    }
  }
  // A → B → A：与更早版本内容哈希相同即为恢复
  for (const [, revs] of revisionsByFile) {
    const seen = new Map<string, number>();
    for (const rev of revs) {
      if (seen.has(rev.content_hash)) rollbackRevisions.add(rev.revision_id);
      else seen.set(rev.content_hash, rev.seq);
    }
  }

  const readRevisionText = (rev: RevisionRow): string | null => {
    if (!rev.snapshot_available) return null;
    if (rev.size_bytes > INLINE_LIMIT_BYTES) return null;
    const buffer = store.readSnapshot(rev.content_hash);
    if (!buffer) return null;
    return buffer.toString('utf-8');
  };

  // B04 对齐（contract-query-api.md §1.3 / Rust query/files.rs coverage_of）：
  // pdf=L2 页级抽取 page_indexed → pdf_page_text，否则 filename_only。Node 管线
  // 没有 PDF 解析器；受控夹具口径：magic 头 %PDF- 且不超过 Rust 侧按需解析上限
  // （query/pdf.rs MAX_ONDEMAND_PDF_BYTES = 32MiB）即视为可页级抽取
  // （seed 的 buildPdf 产物恒满足；scan 级别的大 PDF 仍诚实 filename_only）。
  const PDF_ONDEMAND_MAX_BYTES = 32 * 1024 * 1024;
  const readPdfPageIndexed = (rev: RevisionRow): boolean => {
    if (!rev.snapshot_available) return false;
    if (rev.size_bytes > PDF_ONDEMAND_MAX_BYTES) return false;
    const buffer = store.readSnapshot(rev.content_hash);
    if (!buffer || buffer.length < 5) return false;
    return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  };

  const toRevision = (rev: RevisionRow, fileFormat: string): Revision => {
    const kind = fileFormat;
    const p = fileByPath.get(fileById.get(rev.file_id)?.current_path.replace(/\\/g, '/') || '');
    const relPath = p?.current_path || '';
    // 阶段一瘦身：只对 SVG 内联正文（SVG 阅读器依赖 /scan 内联的 svgSource，契约不动）；
    // MD 正文不再随 /scan 传输（约 3MiB 级载荷收益），阅读器 / 搜索 / 差异 /
    // 智能体读取均镜像 ReaderView.tsx 的既有模式，经 /revisions/<id>/content 按需回退。
    const text = kind === 'svg' ? readRevisionText(rev) : null;

    const summaryParts = [`v${rev.seq}`];
    if (rev.occurred_at) {
      summaryParts.push(
        rev.occurred_precision === 'day'
          ? `${rev.occurred_at}（原文记载）`
          : `${rev.occurred_at.replace('T', ' ').slice(0, 19)}（${
              rev.occurred_source === 'file_mtime' ? '文件修改时间' : rev.occurred_source === 'document_self' ? '文档自述' : '采集'
            }）`
      );
    } else {
      summaryParts.push('日期待考');
    }
    summaryParts.push(`${(rev.size_bytes / 1024).toFixed(1)} KB`);
    if (!rev.snapshot_available) summaryParts.push('快照已过保留期');

    return {
      revision_id: rev.revision_id,
      file_id: rev.file_id,
      versionNumber: rev.seq,
      content_sha256: rev.content_hash,
      observed_at: rev.observed_at,
      source_time: rev.occurred_at ?? undefined,
      sizeBytes: rev.size_bytes,
      snapshotAvailable: Boolean(rev.snapshot_available),
      isBaselineProtected: rev.seq === 1,
      // MD 正文不再内联（字段保持可选，消费方按需经 /revisions/<id>/content 回退）
      svgSource: kind === 'svg' && text !== null ? text : undefined,
      svgExtractedTexts: kind === 'svg' && text ? extractSvgText(text) : undefined,
      changedSectionsFromPrev: changedSectionsByRevision.get(rev.revision_id),
      summaryNote: summaryParts.join(' · ') + (relPath ? ` · ${relPath}` : ''),
    };
  };

  const files: FileRecord[] = activeFiles.map((row) => {
    const revs = revisionsByFile.get(row.file_id) || [];
    const current =
      revs.find((r) => r.revision_id === row.last_revision_id) || revs[revs.length - 1];
    const revisions = revs.map((r) => toRevision(r, row.format));

    let coverage: CoverageKind = 'filename_only';
    if (row.format === 'md') {
      const text = current ? readRevisionText(current) : null;
      coverage = text !== null ? 'full_text' : 'filename_only';
    } else if (row.format === 'svg') {
      const text = current ? readRevisionText(current) : null;
      coverage = svgHasText(text) ? 'svg_text' : 'filename_only';
    } else if (row.format === 'pdf') {
      coverage = current && readPdfPageIndexed(current) ? 'pdf_page_text' : 'filename_only';
    }

    return {
      file_id: row.file_id,
      relative_path: row.current_path,
      title: row.title || titleOf(row.current_path),
      format: row.format,
      folder: folderOf(row.current_path),
      role: row.role as FileRecord['role'],
      roleProvenance: '来自路径',
      topics: [],
      current_revision_id: current?.revision_id || row.last_revision_id || '',
      revisions,
      coverage,
      pdfStatus: row.format === 'pdf' ? 'unindexed' : undefined,
      pdfStatusReason:
        row.format === 'pdf'
          ? '正文尚未索引，当前仅文件名与元数据可检索（阅读器可打开原文件预览）'
          : undefined,
    };
  });

  // ---------- 事件 ----------
  const events: TimelineEvent[] = eventRows.map((ev) => {
    const payload = safeJson(ev.payload_json);
    const fileId =
      ev.subject_kind === 'file'
        ? ev.subject_id
        : ev.revision_id
          ? fileIdByRevision.get(ev.revision_id) || ''
          : '';

    return {
      event_id: ev.event_id,
      kind: ev.kind as TimelineEvent['kind'],
      file_id: fileId,
      revision_id: ev.revision_id || '',
      observed_at: ev.observed_at,
      source_time: ev.occurred_at ?? undefined,
      occurred_source: ev.occurred_source ?? null,
      occurred_precision: ev.occurred_precision ?? null,
      topic_lane:
        (typeof payload.path === 'string' && folderOf(payload.path)) ||
        (fileId && fileById.has(fileId) ? folderOf(fileById.get(fileId)!.current_path) : '工作区'),
      headline: ev.headline,
      detail: ev.detail,
      changedSections: Array.isArray(payload.changed_sections)
        ? (payload.changed_sections as string[])
        : undefined,
      isRollback: ev.revision_id ? rollbackRevisions.has(ev.revision_id) : undefined,
      sameHashCandidatePaths: Array.isArray(payload.same_hash_candidate_paths)
        ? (payload.same_hash_candidate_paths as string[])
        : undefined,
    };
  });

  // ---------- 决策（按业务决定归并陈述） ----------
  const revisionObservedAt = new Map<string, string>();
  for (const rev of revisionRows) revisionObservedAt.set(rev.revision_id, rev.observed_at);
  const decisions = groupStatementsIntoDecisions(statements, fileById, revisionObservedAt);

  // ---------- 关系（只投影能落到文件的引用） ----------
  const relations: RelationEdge[] = edges
    .filter((e) => !e.target_file_id.startsWith('unresolved:'))
    .map((e) => ({
      edge_id: e.edge_id,
      source_id: e.source_file_id,
      target_id: e.target_file_id,
      type: 'explicit_reference' as const,
      isInferred: false,
      label: e.resolution === 'collected_version' ? '显式引用（收录版本）' : '显式引用',
      reason: e.reason,
      locator:
        e.locator_start != null && e.locator_end != null
          ? { startLine: e.locator_start, endLine: e.locator_end }
          : undefined,
    }));

  // ---------- 配置 ----------
  const mdCount = activeFiles.filter((f) => f.format === 'md').length;
  const svgCount = activeFiles.filter((f) => f.format === 'svg').length;
  const pdfCount = activeFiles.filter((f) => f.format === 'pdf').length;

  const blobTotals = store.db
    .prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes, COUNT(*) AS n FROM blobs')
    .get() as unknown as { bytes: number; n: number };

  const config: WorkspaceConfig = {
    rootPath: ws.root_path,
    rootKey: ws.root_key,
    dataDirPath: store.dataDir,
    excludedDirs: ['node_modules', '.git', '_软件安装包', '_spike'],
    disableGitIgnore: true,
    gitIgnoreWarning: '',
    enumSnapshot: {
      date: (ws.last_scan_at || new Date().toISOString()).slice(0, 10),
      mdCount,
      svgCount,
      pdfCount,
      totalCount: activeFiles.length,
      indexedSuccessCount: activeFiles.filter((f) => {
        if (f.format === 'md') return true;
        if (f.format === 'svg') return false;
        return false;
      }).length,
      parseFailedCount: 0,
      pdfUnindexedCount: pdfCount,
    },
    quota: {
      maxTotalMiB: 500,
      usedTotalMiB: Number((blobTotals.bytes / 1024 / 1024).toFixed(1)),
      maxSingleBinaryMiB: 20,
      protectedSnapshotsCount: blobTotals.n,
      evictedSnapshotsCount: 0,
    },
    runtimeStatus: {
      connectionMode: 'direct_stdio',
      serviceState: 'monitoring',
      sseSeq: eventRows.length,
      indexGeneration: ws.index_generation,
      activeAgents: [],
      loopbackUrl: '',
    },
  };

  const missingCount = allFiles.filter((f) => f.status === 'missing').length;

  return {
    config,
    files,
    events,
    decisions,
    relations,
    readingStates: emptyGravatar(),
    scanDiagnostics: {
      errors: [],
      scannedAt: ws.last_scan_at || new Date().toISOString(),
      durationHint:
        `${activeFiles.length} 个文件 · ${mdCount} MD / ${svgCount} SVG / ${pdfCount} PDF` +
        ` · ${revisionRows.length} 个版本` +
        (missingCount ? ` · ${missingCount} 缺失` : ''),
      source: 'store',
      totalFiles: activeFiles.length,
      totalRevisions: revisionRows.length,
      // 单条 workspace COUNT：maxEventSeq>0 与 COUNT(*)>0 判空恒同（seq 自增恒 ≥1），
      // 空工作区两条路径都返回 0，无须先 max 再 count 两条查询
      totalEvents: Number(
        (store.db
          .prepare('SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?')
          .get(ws.workspace_id) as unknown as { n: number }).n
      ),
      baseline: store.hasBaseline(ws.workspace_id),
    },
  };
}

function groupStatementsIntoDecisions(
  statements: StatementRow[],
  fileById: Map<string, FileRow>,
  revisionObservedAt: Map<string, string>
): DecisionAssertion[] {
  const byDecision = new Map<string, StatementRow[]>();
  for (const s of statements) {
    if (!s.decision_id) continue;
    if (!byDecision.has(s.decision_id)) byDecision.set(s.decision_id, []);
    byDecision.get(s.decision_id)!.push(s);
  }

  const decisions: DecisionAssertion[] = [];
  for (const [decisionId, list] of byDecision) {
    // 以「来源文件最新版本」的陈述作为当前口径；同版本内按行号先后
    const sorted = [...list].sort((a, b) => {
      // 跨文件比较新旧不能用 per-file seq：seq 按文件独立编号，文件 X 的 seq10
      // 不代表比文件 Y 的 seq2 更新。先比版本观察时间（与 reconcile.recordDecisionEvents
      // 的 observed_at 口径一致），同时间再比陈述观察时间，最后按行号。
      const tA = revisionObservedAt.get(a.revision_id) ?? a.observed_at;
      const tB = revisionObservedAt.get(b.revision_id) ?? b.observed_at;
      if (tA !== tB) return tA < tB ? 1 : -1;
      if (a.observed_at !== b.observed_at) return a.observed_at < b.observed_at ? 1 : -1;
      return a.line_start - b.line_start;
    });
    const primary = sorted[0];
    let detail: {
      options?: string[];
      recommendation?: string;
      impactBlocked?: string[];
      impactAllowed?: string[];
      confirmer?: string | null;
    } = {};
    try {
      detail = JSON.parse(primary.detail_json || '{}');
    } catch {
      detail = {};
    }

    const evidences = sorted.map((s) => {
      const file = fileById.get(s.file_id);
      return {
        source_id: s.statement_id,
        file_id: s.file_id,
        revision_id: s.revision_id,
        relative_path: file?.current_path || '',
        lineStart: s.line_start,
        lineEnd: s.line_end,
        observed_at: s.observed_at,
        source_time: s.observed_at.slice(0, 10),
        claimedStatus: s.status as DecisionAssertion['status'],
        exactQuote: s.quote,
        confirmer: detail.confirmer || undefined,
        note: `陈述 ${s.code} · 版本 ${s.revision_id} · ${s.namespace}`,
      };
    });

    decisions.push({
      decision_id: decisionId,
      code: primary.code,
      namespace: primary.namespace,
      question: primary.question,
      status: primary.status as DecisionAssertion['status'],
      isCandidateOnly: false,
      options: detail.options || [],
      recommendation: detail.recommendation || '原文未给出显式推荐。',
      impactBlocked: detail.impactBlocked || [],
      impactAllowed: detail.impactAllowed || [],
      confirmationBasis:
        primary.status === '已确认' && detail.confirmer
          ? {
              recordText: primary.quote.slice(0, 200),
              confirmer: detail.confirmer,
              confirmedAt: primary.observed_at.slice(0, 16).replace('T', ' '),
              file_id: primary.file_id,
              revision_id: primary.revision_id,
              lineRange: [primary.line_start, primary.line_end],
            }
          : undefined,
      topic: primary.namespace,
      evidences,
    });
  }

  // 有内容变更的排在前面：待确认/来源不一致优先
  const rank = (s: string) => (s === '来源不一致' ? 0 : s === '待确认' ? 1 : s === '已确认' ? 2 : 3);
  decisions.sort((a, b) => rank(a.status) - rank(b.status) || a.code.localeCompare(b.code));
  return decisions;
}

function extractSvgText(source: string): string[] {
  const out: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

/** 供 history 接口复用：单文件版本链（含快照可用性与派生证据计数） */
export function projectFileHistory(store: WorkspaceStore, fileId: string) {
  const file = store.getFile(fileId);
  if (!file) return null;
  const revisions = store.revisionsOfFile(fileId).map((rev) => ({
    revision_id: rev.revision_id,
    seq: rev.seq,
    prev_revision_id: rev.prev_revision_id,
    content_hash: rev.content_hash,
    size_bytes: rev.size_bytes,
    observed_at: rev.observed_at,
    occurred_at: rev.occurred_at,
    occurred_precision: rev.occurred_precision,
    occurred_source: rev.occurred_source,
    snapshot_available: Boolean(rev.snapshot_available),
    // 不下发 snapshot_path：服务端绝对路径不进 UI；正文一律走 /revisions/<id>/content
  }));

  // 事件覆盖四类（缺一不可，否则版本链天生不完整）：
  // 1) subject_id = file_id（file 主体事件）
  // 2) revision_id 属于该文件（revision 主体事件）
  // 3) payload_json.file_id = file_id（决策事件：file_id 只在 payload、revision_id 为 null）
  // 4) subject_id = 'path:' + current_path（read_error / read_recovered 以路径为主体）
  const events = store.db
    .prepare(
      `SELECT * FROM events
       WHERE workspace_id = ?
         AND (
           subject_id = ?
           OR revision_id IN (SELECT revision_id FROM revisions WHERE file_id = ?)
           OR json_extract(payload_json,'$.file_id') = ?
           OR subject_id = 'path:' || (SELECT current_path FROM files WHERE file_id = ?)
         )
       ORDER BY seq ASC`
    )
    .all(file.workspace_id, fileId, fileId, fileId, fileId) as unknown as EventRow[];

  const statements = (store.db
    .prepare('SELECT * FROM statements WHERE file_id = ? ORDER BY revision_id, line_start')
    .all(fileId) as unknown as StatementRow[]).map((s) => ({
    statement_id: s.statement_id,
    revision_id: s.revision_id,
    code: s.code,
    question: s.question,
    status: s.status,
    line_start: s.line_start,
    line_end: s.line_end,
    decision_id: s.decision_id,
  }));

  const edges = (store.db
    .prepare('SELECT * FROM edges WHERE source_file_id = ?')
    .all(fileId) as unknown as EdgeRow[]).map((e) => ({
    edge_id: e.edge_id,
    source_revision_id: e.source_revision_id,
    target_file_id: e.target_file_id,
    target_revision_id: e.target_revision_id,
    resolution: e.resolution,
    locator_start: e.locator_start,
    reason: e.reason,
  }));

  return {
    file: {
      file_id: file.file_id,
      current_path: file.current_path,
      title: file.title,
      format: file.format,
      role: file.role,
      status: file.status,
      first_observed_at: file.first_observed_at,
      last_observed_at: file.last_observed_at,
      last_revision_id: file.last_revision_id,
    },
    revisions,
    events: events.map((e) => ({
      seq: e.seq,
      event_id: e.event_id,
      kind: e.kind,
      revision_id: e.revision_id,
      occurred_at: e.occurred_at,
      occurred_precision: e.occurred_precision,
      occurred_source: e.occurred_source,
      observed_at: e.observed_at,
      headline: e.headline,
      detail: e.detail,
      payload: safeJson(e.payload_json),
    })),
    statements,
    edges,
  };
}

/** 按版本读取正文（不提供任意路径下载，只按 revision_id） */
export function readRevisionContent(
  store: WorkspaceStore,
  revisionId: string
): { ok: boolean; format?: string; text?: string; snapshotPath?: string; error?: string } {
  const rev = store.getRevision(revisionId);
  if (!rev) return { ok: false, error: 'NOT_FOUND' };
  if (!rev.snapshot_available) {
    return {
      ok: false,
      error: 'REVISION_UNAVAILABLE',
    };
  }
  const file = store.getFile(rev.file_id);
  const snapshotPath = store.snapshotPath(rev.content_hash);
  if (!fs.existsSync(snapshotPath)) {
    return { ok: false, error: 'REVISION_UNAVAILABLE' };
  }
  if (file?.format === 'pdf') {
    return { ok: true, format: 'pdf', snapshotPath };
  }
  return {
    ok: true,
    format: file?.format || 'md',
    text: fs.readFileSync(snapshotPath, 'utf-8'),
    snapshotPath,
  };
}
