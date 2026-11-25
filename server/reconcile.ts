/**
 * 观澜 Node 对拍基线 —— 对账与历史写入
 *
 * 写入顺序：稳定读取 → 保存并校验内容快照 → 事务提交版本与事件及证据 → 发出更新通知。
 *
 * 核心不变量：
 * - 内容哈希相同 ⇒ 不新增版本、不新增事件（连续重扫不增加事件）
 * - 只有 mtime 变化 ⇒ 仅更新采集状态，不增加内容版本
 * - A → B → A ⇒ 三次版本出现、两份内容快照（相同哈希共享 blob），可逐版回看
 * - 首次扫描 ⇒ 一条「首次纳入 N 份资料」基线事件，而不是给每个文件各发一条 discovered
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { collectWorkspace, type CollectedFile } from '../src/services/FileScanner';
import { parseMarkdownOutline } from '../src/services/WorkspaceTransformer';
import {
  WorkspaceStore,
  EXTRACT_RULE_VERSION,
  defaultDataDir,
  rootKeyOf,
  type EventKind,
  type EventRow,
  type RevisionRow,
  type StatementRow,
} from './WorkspaceStore';
import { deriveDocumentTime, deriveEdges, deriveStatements } from './derive';

export interface ReconcileOptions {
  dataDir?: string;
  excludedDirs?: string[];
  maxFiles?: number;
  /** 注入采集时刻，便于测试重放 */
  now?: string;
  /** 复用已有连接（开发服务器长期持有）；传入时本轮不负责关闭 */
  store?: WorkspaceStore;
}

export interface ReconcileReport {
  workspaceId: string;
  generation: number;
  initialBaseline: boolean;
  scanned: number;
  byFormat: { md: number; svg: number; pdf: number };
  newFiles: number;
  newRevisions: number;
  unchanged: number;
  mtimeOnly: number;
  contentChanged: number;
  appeared: number;
  missing: number;
  recovered: number;
  unstableReads: number;
  eventsInserted: number;
  eventsSkipped: number;
  decisionEventsInserted: number;
  statementsUpserted: number;
  edgesUpserted: number;
  snapshotsWritten: number;
  derivedRebuilt: boolean;
  backfilledDocDateEvents: number;
  durationMs: number;
}

interface PendingRevision {
  file: CollectedFile;
  fileId: string;
  isNewFile: boolean;
  recoveredMissing: boolean;
  revision: RevisionRow;
  prevHash: string | null;
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 稳定文件 ID：同一工作区同一路径重放得到同一标识。
 * 小写化以适配 Windows 大小写不敏感的匹配。
 */
function stableFileId(rootKey: string, relativePath: string): string {
  const h = createHash('sha256')
    .update(`${rootKey}|${normalizeRelPath(relativePath).toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
  return `f_${h}`;
}

function revisionIdOf(fileId: string, seq: number): string {
  return `${fileId}_r${seq}`;
}

function titleFromPath(relativePath: string): string {
  const base = normalizeRelPath(relativePath).split('/').pop() || relativePath;
  return base.replace(/\.(md|markdown|svg|pdf)$/i, '');
}

function folderFromPath(relativePath: string): string {
  const rel = normalizeRelPath(relativePath);
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '.' : rel.slice(0, idx);
}

function detectRole(relativePath: string, title: string, format: string): string {
  const p = normalizeRelPath(relativePath).toLowerCase();
  const t = title.toLowerCase();
  if (/决策|回执|待确认|已确认/.test(t)) return '决策';
  if (/需求单|需求|任务包|任务卡/.test(t) || /需求/.test(p)) return '需求';
  if (/方案|计划书/.test(t) || /方案/.test(p)) return '方案';
  if (/说明|边界|规范/.test(t)) return '说明';
  if (/报告|汇报|总览|进度/.test(t)) return '报告';
  if (/交接|派发|handoff/.test(t)) return '交接';
  if (format === 'svg') return '素材';
  if (format === 'pdf') return '说明';
  return '其他';
}

/** 变更摘要：章节增减与行数（内容修改时 MD 显示变更章节） */
function summarizeChange(
  prevText: string | null,
  newText: string | null,
  format: string
): { changedSections: string[]; added: number; removed: number } {
  if (!prevText) return { changedSections: ['首次捕获正文'], added: 0, removed: 0 };
  if (newText === null) {
    return { changedSections: ['本轮快照不可读，未计算差异'], added: 0, removed: 0 };
  }

  if (format !== 'md') {
    const prevLines = prevText.split('\n');
    const newLines = newText.split('\n');
    return {
      changedSections: [format === 'svg' ? 'SVG 源文本变化' : '二进制内容变化'],
      added: Math.max(0, newLines.length - prevLines.length),
      removed: Math.max(0, prevLines.length - newLines.length),
    };
  }

  const prevSections = parseMarkdownOutline(prevText).map((s) => s.title);
  const newSections = parseMarkdownOutline(newText);
  const changed: string[] = [];
  for (const sec of newSections) {
    if (!prevSections.includes(sec.title)) changed.push(sec.title);
  }
  for (const title of prevSections) {
    if (!newSections.some((s) => s.title === title)) changed.push(`${title}（已移除）`);
  }

  const prevLines = prevText.split('\n');
  const newLines = newText.split('\n');
  const prevSet = new Set(prevLines);
  const newSet = new Set(newLines);
  let added = 0;
  let removed = 0;
  for (const l of newLines) if (!prevSet.has(l)) added++;
  for (const l of prevLines) if (!newSet.has(l)) removed++;

  return { changedSections: changed.slice(0, 8), added, removed };
}

/**
 * 对账一次扫描，写入持久历史。返回本轮统计。
 */
export function reconcileWorkspace(
  rootPath: string,
  options: ReconcileOptions = {}
): { report: ReconcileReport; store: WorkspaceStore } {
  const startedAt = Date.now();
  const dataDir = options.dataDir || defaultDataDir(rootPath);
  const store = options.store || new WorkspaceStore(dataDir);
  const workspace = store.ensureWorkspace(rootPath);
  const observedAt = options.now || new Date().toISOString();
  const initialBaseline = !store.hasBaseline(workspace.workspace_id);

  const collected = collectWorkspace(rootPath, {
    excludedDirs: options.excludedDirs,
    maxFiles: options.maxFiles,
  });

  const report: ReconcileReport = {
    workspaceId: workspace.workspace_id,
    generation: workspace.index_generation,
    initialBaseline,
    scanned: collected.files.length,
    byFormat: { md: 0, svg: 0, pdf: 0 },
    newFiles: 0,
    newRevisions: 0,
    unchanged: 0,
    mtimeOnly: 0,
    contentChanged: 0,
    appeared: 0,
    missing: 0,
    recovered: 0,
    unstableReads: 0,
    eventsInserted: 0,
    eventsSkipped: 0,
    decisionEventsInserted: 0,
    statementsUpserted: 0,
    edgesUpserted: 0,
    snapshotsWritten: 0,
    derivedRebuilt: false,
    backfilledDocDateEvents: 0,
    durationMs: 0,
  };

  for (const f of collected.files) {
    if (f.format === 'md' || f.format === 'svg' || f.format === 'pdf') {
      report.byFormat[f.format]++;
    }
  }

  // ---------- 第一遍：识别文件身份并规划新版本 ----------
  const pending: PendingRevision[] = [];
  const resolvedByFileId = new Map<string, CollectedFile>();
  const missingHashCandidates = store
    .listFiles(workspace.workspace_id, true)
    .filter((f) => f.status === 'missing');

  for (const file of collected.files) {
    const relPath = normalizeRelPath(file.relativePath);

    let fileRow =
      store.findFileByPath(workspace.workspace_id, relPath) ||
      store.resolveFileByAlias(workspace.workspace_id, relPath);

    let recoveredMissing = false;
    let isNewFile = false;
    let evidence = 'exact_path';

    if (!fileRow) {
      const predictedId = stableFileId(workspace.root_key, relPath);
      const predicted = store.getFile(predictedId);
      if (predicted) {
        // 同 ID 但状态缺失后重现：恢复；路径也可能只是大小写差异
        fileRow = predicted;
        evidence = 'same_hash_candidate';
      }
    }

    if (!fileRow && file.stable) {
      // 改名/移动证据不足：仅当工作区里恰好有一个缺失文件与本文件同哈希时才考虑关联，
      // 否则保留「新增」与「缺失」两个独立事实
      const sameHashMissing = missingHashCandidates.filter((candidate) => {
        const rev = store.latestRevision(candidate.file_id);
        return rev && rev.content_hash === file.sha256;
      });
      if (sameHashMissing.length === 1) {
        const matched = sameHashMissing[0];
        // 关联后立刻从候选池移除该 file_id：同轮若有第二个同哈希新文件，
        // 让它按「新增」处理。否则两个计划会各自算出相同 seq 与 revision_id，
        // 事务内第二次 insertRevision 撞 UNIQUE(file_id, seq) 回滚整轮对账。
        missingHashCandidates.splice(missingHashCandidates.indexOf(matched), 1);
        fileRow = matched;
        recoveredMissing = true;
        evidence = 'same_hash_candidate';
      }
    }

    if (!fileRow) {
      isNewFile = true;
    }

    if (!file.stable) {
      report.unstableReads++;
      resolvedByFileId.set(fileRow?.file_id || `unstable:${relPath}`, file);
      continue;
    }

    const fileId = fileRow ? fileRow.file_id : stableFileId(workspace.root_key, relPath);
    resolvedByFileId.set(fileId, file);

    const latest = fileRow ? store.latestRevision(fileId) : undefined;

    if (latest && latest.content_hash === file.sha256) {
      // 内容未变：仅更新采集状态。mtime 单独保存，绝不新增版本或事件
      const mtimeMoved = fileRow!.last_mtime_ms !== file.mtimeMs;
      store.transaction(() => {
        store.touchFile(fileId, observedAt, file.mtimeMs, latest.revision_id);
        if (fileRow!.status === 'missing' || recoveredMissing) {
          store.markFileStatus(fileId, 'active');
          store.upsertAlias(workspace.workspace_id, relPath, fileId, observedAt, evidence);
        }
        if (mtimeMoved && fileRow!.status === 'active') {
          // 仅时间戳变化：不登记内容版本，也不产生事件
        }
      });
      if (fileRow!.status === 'missing' || recoveredMissing) {
        report.recovered++;
        insertEventSafe(store, report, {
          event_id: `evt_recovered_${fileId}`,
          workspace_id: workspace.workspace_id,
          kind: 'read_recovered',
          subject_kind: 'file',
          subject_id: fileId,
          revision_id: latest.revision_id,
          occurred_at: null,
          occurred_precision: 'unknown',
          occurred_source: null,
          observed_at: observedAt,
          headline: `路径恢复可访问：${fileRow!.current_path}`,
          detail: `${relPath} 重新出现在完整扫描中；已有版本与决策依据仍可访问。`,
          payload_json: JSON.stringify({ path: relPath }),
          batch_id: null,
        });
      }
      if (mtimeMoved) report.mtimeOnly++;
      else report.unchanged++;
      continue;
    }

    // 需要新版本
    const seq = (latest?.seq ?? 0) + 1;
    pending.push({
      file,
      fileId,
      isNewFile,
      recoveredMissing,
      prevHash: latest?.content_hash ?? null,
      revision: {
        revision_id: revisionIdOf(fileId, seq),
        file_id: fileId,
        workspace_id: workspace.workspace_id,
        seq,
        prev_revision_id: latest?.revision_id ?? null,
        content_hash: file.sha256,
        size_bytes: file.sizeBytes,
        observed_at: observedAt,
        occurred_at: null,
        occurred_precision: 'unknown',
        occurred_source: null,
        snapshot_hash: file.sha256,
        snapshot_available: 1,
        extract_rule_version: EXTRACT_RULE_VERSION,
      },
    });
    if (isNewFile) report.newFiles++;
  }

  // ---------- 第二遍：写快照（事务外 IO） ----------
  for (const plan of pending) {
    const content = plan.file.readContent();
    const wroteFile = store.writeSnapshotToDisk(content, plan.revision.content_hash);
    if (wroteFile) report.snapshotsWritten++;

    // 版本发生时间：
    // - 首次捕获（v1）：优先材料自述日期（回答「材料声称何时产生」）
    // - 后续修改（v2+）：用文件修改时间（回答「这次改动何时发生」），
    //   文档自述日期通常停留在初稿，不能拿来当修改时间
    const mtimeIso = new Date(plan.file.mtimeMs).toISOString();
    if (plan.revision.seq > 1) {
      plan.revision.occurred_at = mtimeIso;
      plan.revision.occurred_precision = 'second';
      plan.revision.occurred_source = 'file_mtime';
    } else {
      const self = plan.file.format === 'md' ? deriveDocumentTime(content.toString('utf-8')) : { occurredAt: null, precision: 'unknown', source: null } as const;
      if (self.occurredAt) {
        plan.revision.occurred_at = self.occurredAt;
        plan.revision.occurred_precision = self.precision;
        plan.revision.occurred_source = self.source;
      } else {
        plan.revision.occurred_at = mtimeIso;
        plan.revision.occurred_precision = 'second';
        plan.revision.occurred_source = 'file_mtime';
      }
    }
  }

  // ---------- 事务提交：文件、版本、事件、证据一起落库 ----------
  // 路径索引：已入库文件 + 本轮待写入文件，保证引用能解析到已有路径
  const pathIndex = new Map<string, string>();
  for (const f of store.listFiles(workspace.workspace_id, true)) {
    pathIndex.set(normalizeRelPath(f.current_path), f.file_id);
  }
  for (const plan of pending) {
    pathIndex.set(normalizeRelPath(plan.file.relativePath), plan.fileId);
  }

  store.transaction(() => {
    for (const plan of pending) {
      const relPath = normalizeRelPath(plan.file.relativePath);

      if (plan.isNewFile) {
        store.insertFile({
          file_id: plan.fileId,
          workspace_id: workspace.workspace_id,
          current_path: relPath,
          format: plan.file.format,
          title: titleFromPath(relPath),
          role: detectRole(relPath, titleFromPath(relPath), plan.file.format),
          first_observed_at: observedAt,
          last_observed_at: observedAt,
          last_mtime_ms: plan.file.mtimeMs,
          last_revision_id: plan.revision.revision_id,
          status: 'active',
        });
      } else {
        store.markFileStatus(plan.fileId, 'active');
      }
      store.upsertAlias(workspace.workspace_id, relPath, plan.fileId, observedAt, 'exact_path');
      pathIndex.set(relPath, plan.fileId);

      store.registerBlobRef(plan.revision.content_hash, plan.revision.size_bytes);
      store.insertRevision(plan.revision);
      store.touchFile(plan.fileId, observedAt, plan.file.mtimeMs, plan.revision.revision_id);
      report.newRevisions++;

      const kind: EventRow['kind'] = plan.isNewFile ? 'appeared' : 'modified';

      // 基线扫描的分工：
      // - 正文有可核验自述日期的材料：按「文档自述日期」各自入轴，落到那一天
      // - 没有日期依据的材料：不逐条刷屏，统一由「首次纳入 N 份资料」基线卡覆盖
      const datedBySelf = plan.revision.occurred_source === 'document_self';
      const skipBaselinePerFileEvent = initialBaseline && plan.isNewFile && !datedBySelf;

      if (!skipBaselinePerFileEvent) {
        const changed =
          plan.prevHash && kind === 'modified'
            ? summarizeChange(
                safeText(store.readSnapshot(plan.prevHash)),
                safeText(store.readSnapshot(plan.revision.content_hash)),
                plan.file.format
              )
            : { changedSections: [], added: 0, removed: 0 };

        const headline = plan.isNewFile
          ? datedBySelf
            ? `文档自述日期：${titleFromPath(relPath)}（${plan.revision.occurred_at}）`
            : `新出现：${relPath}`
          : `${titleFromPath(relPath)} 检测到更新（v${plan.revision.seq}）`;

        insertEventSafe(store, report, {
          event_id: `evt_${kind}_${plan.revision.revision_id}`,
          workspace_id: workspace.workspace_id,
          kind,
          subject_kind: 'revision',
          subject_id: plan.revision.revision_id,
          revision_id: plan.revision.revision_id,
          occurred_at: plan.revision.occurred_at,
          occurred_precision: plan.revision.occurred_precision,
          occurred_source: plan.revision.occurred_source,
          observed_at: observedAt,
          headline,
          detail: plan.isNewFile
            ? datedBySelf
              ? `正文明确记载日期 ${plan.revision.occurred_at}；观澜于 ${observedAt.slice(0, 10)} 采集到该版本。未补零点时刻。`
              : `完整基线建立后出现此前不存在的路径 ${relPath}`
            : changed.changedSections.length
              ? `变更章节：${changed.changedSections.join('、')}`
              : `内容哈希变化（+${changed.added}/-${changed.removed} 行）`,
          payload_json: JSON.stringify({
            path: relPath,
            format: plan.file.format,
            size_bytes: plan.revision.size_bytes,
            content_hash: plan.revision.content_hash,
            mtime_ms: plan.file.mtimeMs,
            time_basis: plan.isNewFile
              ? datedBySelf
                ? 'document_self'
                : 'file_mtime'
              : 'collector',
            changed_sections: changed.changedSections,
            added_lines: changed.added,
            removed_lines: changed.removed,
          }),
          batch_id: null,
        });

        if (plan.isNewFile) report.appeared++;
      }
      if (!plan.isNewFile) report.contentChanged++;
    }

    // 缺失检测：只在范围完整遍历时判定
    if (collected.complete) {
      const seenPaths = new Set(collected.files.map((f) => normalizeRelPath(f.relativePath)));
      const seenIds = new Set(pending.map((p) => p.fileId));
      for (const f of store.listFiles(workspace.workspace_id)) {
        if (seenPaths.has(normalizeRelPath(f.current_path)) || seenIds.has(f.file_id)) continue;
        store.markFileStatus(f.file_id, 'missing');
        report.missing++;
        insertEventSafe(store, report, {
          event_id: `evt_missing_${f.file_id}_${observedAt.slice(0, 10)}`,
          workspace_id: workspace.workspace_id,
          kind: 'missing',
          subject_kind: 'file',
          subject_id: f.file_id,
          revision_id: f.last_revision_id,
          occurred_at: null,
          occurred_precision: 'unknown',
          occurred_source: null,
          observed_at: observedAt,
          headline: `路径在本轮完整扫描中不可访问：${f.current_path}`,
          detail: '范围完整遍历后确认该路径消失；已有版本与决策依据仍可查阅。',
          payload_json: JSON.stringify({ path: f.current_path }),
          batch_id: null,
        });
      }
    }
  });

  store.transaction(() => {
    // 基线卡：正文有自述日期的材料已各自入轴，这里只覆盖扫描本身与无日期依据的部分
    const datedSelfCount = pending.filter((p) => p.isNewFile && p.revision.occurred_source === 'document_self').length;

    if (initialBaseline) {
      insertEventSafe(store, report, {
        event_id: `evt_baseline_${workspace.workspace_id}`,
        workspace_id: workspace.workspace_id,
        kind: 'workspace_baseline',
        subject_kind: 'workspace',
        subject_id: workspace.workspace_id,
        revision_id: null,
        occurred_at: observedAt.slice(0, 10),
        occurred_precision: 'day',
        occurred_source: 'collector',
        observed_at: observedAt,
        headline: `首次纳入 ${collected.files.length} 份资料`,
        detail:
          `${report.byFormat.md} 份 MD、${report.byFormat.svg} 份 SVG、${report.byFormat.pdf} 份 PDF。` +
          (datedSelfCount
            ? `其中 ${datedSelfCount} 份按正文自述日期单独入轴；其余 ${collected.files.length - datedSelfCount} 份只有采集依据，归在本卡。单文件基线版本可逐一查看。`
            : '本批材料没有可核验的正文日期，全部只按采集时间记录。单文件基线版本可逐一查看。'),
        payload_json: JSON.stringify({
          total: collected.files.length,
          md: report.byFormat.md,
          svg: report.byFormat.svg,
          pdf: report.byFormat.pdf,
          dated_by_document_self: datedSelfCount,
        }),
        batch_id: null,
      });
    }
  });

  store.transaction(() => {
    // 读取问题（不稳定读取或目录不可访问）：保留原记录，仅报告
    for (const err of collected.readErrors) {
      insertEventSafe(store, report, {
        event_id: `evt_read_error_${stableShort(err.relativePath)}_${observedAt.slice(0, 13).replace(/[:T]/g, '')}`,
        workspace_id: workspace.workspace_id,
        kind: 'read_error',
        subject_kind: 'file',
        subject_id: `path:${err.relativePath}`,
        revision_id: null,
        occurred_at: null,
        occurred_precision: 'unknown',
        occurred_source: null,
        observed_at: observedAt,
        headline: `读取问题：${err.relativePath}`,
        detail: err.message,
        payload_json: JSON.stringify({ path: err.relativePath }),
        batch_id: null,
      });
    }
  });

  // ---------- 派生索引：陈述与关系（按新版本粒度） ----------
  const targetRevisionIndex = new Map<string, string>();
  for (const f of store.listFiles(workspace.workspace_id, true)) {
    const rev = store.latestRevision(f.file_id);
    if (rev) targetRevisionIndex.set(f.file_id, rev.revision_id);
  }

  const newStatements: StatementRow[] = [];
  store.transaction(() => {
    for (const plan of pending) {
      if (plan.file.format !== 'md') continue;
      const content = safeText(store.readSnapshot(plan.revision.content_hash));
      if (content === null) continue;

      const relPath = normalizeRelPath(plan.file.relativePath);
      const input = {
        workspaceId: workspace.workspace_id,
        fileId: plan.fileId,
        revisionId: plan.revision.revision_id,
        relativePath: relPath,
        folder: folderFromPath(relPath),
        title: titleFromPath(relPath),
        format: 'md' as const,
        content,
        observedAt,
        rootPath,
        pathIndex,
        targetRevisionIndex,
      };

      const statements = deriveStatements(input);
      for (const s of statements) {
        store.upsertStatement(s);
        report.statementsUpserted++;
      }
      newStatements.push(...statements);
      const edges = deriveEdges(input);
      for (const e of edges) {
        store.upsertEdge(e);
        report.edgesUpserted++;
      }
    }

    // 读取不稳定：单独记录，不落版本
    for (const file of collected.files) {
      if (file.stable) continue;
      insertEventSafe(store, report, {
        event_id: `evt_unstable_${stableShort(normalizeRelPath(file.relativePath))}_${observedAt.slice(0, 13).replace(/[:T]/g, '')}`,
        workspace_id: workspace.workspace_id,
        kind: 'read_error',
        subject_kind: 'file',
        subject_id: `path:${normalizeRelPath(file.relativePath)}`,
        revision_id: null,
        occurred_at: null,
        occurred_precision: 'unknown',
        occurred_source: null,
        observed_at: observedAt,
        headline: `稳定读取未达成：${normalizeRelPath(file.relativePath)}`,
        detail: '读取期间文件被改写，本轮不落新版本；下轮对账会恢复。',
        payload_json: JSON.stringify({ path: normalizeRelPath(file.relativePath) }),
        batch_id: null,
      });
    }

    // 决策入轴：只有明确的状态转换才新增事件，同状态复述只补来源证据
    report.decisionEventsInserted += recordDecisionEvents(
      store,
      workspace.workspace_id,
      newStatements,
      observedAt
    );
  });

  // 规则升级：重建派生索引并记录规则版本
  const derived = rebuildDerivedIfNeeded(store, workspace.workspace_id, rootPath, observedAt);
  if (derived.rebuilt) {
    report.statementsUpserted += derived.statements;
    report.edgesUpserted += derived.edges;
    report.derivedRebuilt = true;
  }

  // 旧资料回填：已入库版本若正文明确记载日期，
  // 补一条「文档自述日期」事件；没有日期依据的一律保持只由基线卡覆盖。
  report.backfilledDocDateEvents = backfillDocumentSelfEvents(
    store,
    workspace.workspace_id,
    report
  );

  // 索引代只在校验到变化时推进：重复扫描不应让「代」无意义地增长
  const changed =
    report.newRevisions > 0 ||
    report.eventsInserted > 0 ||
    report.derivedRebuilt ||
    initialBaseline;
  report.generation = changed
    ? store.bumpGeneration(workspace.workspace_id)
    : workspace.index_generation;
  store.markScan(workspace.workspace_id);
  report.durationMs = Date.now() - startedAt;
  return { report, store };
}

/**
 * 为已入库、带正文自述日期且尚无入轴事件的版本补事件。
 * 幂等：事件唯一索引与显式存在性检查都保证重复执行不新增。
 */
function backfillDocumentSelfEvents(
  store: WorkspaceStore,
  workspaceId: string,
  report: ReconcileReport
): number {
  const rows = store.db
    .prepare(
      `SELECT r.revision_id, r.occurred_at, r.occurred_precision, r.occurred_source,
              f.file_id, f.current_path, f.title, f.format
       FROM files f
       JOIN revisions r ON r.revision_id = f.last_revision_id
       WHERE f.workspace_id = ?
         AND r.occurred_source = 'document_self'
         AND NOT EXISTS (
           SELECT 1 FROM events e WHERE e.revision_id = r.revision_id
         )`
    )
    .all(workspaceId) as unknown as Array<{
    revision_id: string;
    occurred_at: string;
    occurred_precision: string;
    occurred_source: string;
    file_id: string;
    current_path: string;
    title: string;
    format: string;
  }>;

  let inserted = 0;
  store.transaction(() => {
    for (const row of rows) {
      const rel = normalizeRelPath(row.current_path);
      insertEventSafe(store, report, {
        event_id: `evt_appeared_${row.revision_id}`,
        workspace_id: workspaceId,
        kind: 'appeared',
        subject_kind: 'revision',
        subject_id: row.revision_id,
        revision_id: row.revision_id,
        occurred_at: row.occurred_at,
        occurred_precision: (row.occurred_precision as 'day') || 'day',
        occurred_source: 'document_self',
        observed_at: nowForBackfill(store, row.revision_id),
        headline: `文档自述日期：${row.title}（${row.occurred_at}）`,
        detail: `正文明确记载日期 ${row.occurred_at}；该版本在首次扫描时被采集。未补零点时刻。`,
        payload_json: JSON.stringify({
          path: rel,
          format: row.format,
          time_basis: 'document_self',
          backfilled: true,
        }),
        batch_id: null,
      });
      inserted++;
    }
  });
  return inserted;
}

function nowForBackfill(store: WorkspaceStore, revisionId: string): string {
  const rev = store.getRevision(revisionId);
  return rev?.observed_at || new Date().toISOString();
}

/**
 * 抽取规则版本变化时，按「文件版本」粒度重建陈述与引用。
 * 删除旧派生数据后按当前规则重新抽取；普通重扫不触发。
 */
function rebuildDerivedIfNeeded(
  store: WorkspaceStore,
  workspaceId: string,
  rootPath: string,
  observedAt: string
): { rebuilt: boolean; statements: number; edges: number } {
  if (store.getMeta('extract_rule_version') === EXTRACT_RULE_VERSION) {
    return { rebuilt: false, statements: 0, edges: 0 };
  }

  const pathIndex = new Map<string, string>();
  const targetRevisionIndex = new Map<string, string>();
  const files = store.listFiles(workspaceId, true);
  for (const f of files) {
    pathIndex.set(normalizeRelPath(f.current_path), f.file_id);
    const latest = store.latestRevision(f.file_id);
    if (latest) targetRevisionIndex.set(f.file_id, latest.revision_id);
  }

  store.transaction(() => {
    store.db.prepare('DELETE FROM edges WHERE workspace_id = ?').run(workspaceId);
    store.db
      .prepare('DELETE FROM statements WHERE workspace_id = ? AND (extract_rule_version IS NULL OR extract_rule_version <> ?)')
      .run(workspaceId, EXTRACT_RULE_VERSION);
  });

  let statements = 0;
  let edges = 0;
  const rebuiltStatements: StatementRow[] = [];

  store.transaction(() => {
    for (const f of files) {
      if (f.format !== 'md') continue;
      const relPath = normalizeRelPath(f.current_path);
      for (const rev of store.revisionsOfFile(f.file_id)) {
        const buffer = store.readSnapshot(rev.content_hash);
        if (!buffer) continue;
        const input = {
          workspaceId,
          fileId: f.file_id,
          revisionId: rev.revision_id,
          relativePath: relPath,
          folder: folderFromPath(relPath),
          title: titleFromPath(relPath),
          format: 'md' as const,
          content: buffer.toString('utf-8'),
          observedAt,
          rootPath,
          pathIndex,
          targetRevisionIndex,
        };
        for (const s of deriveStatements(input)) {
          store.upsertStatement(s);
          rebuiltStatements.push(s);
          statements++;
        }
        for (const e of deriveEdges(input)) {
          store.upsertEdge(e);
          edges++;
        }
      }
    }
    recordDecisionEvents(store, workspaceId, rebuiltStatements, observedAt);
    store.setMeta('extract_rule_version', EXTRACT_RULE_VERSION);
  });

  return { rebuilt: true, statements, edges };
}
function insertEventSafe(
  store: WorkspaceStore,
  report: ReconcileReport,
  event: Omit<EventRow, 'seq'>
): void {
  const result = store.insertEvent(event);
  if (result.inserted) report.eventsInserted++;
  else report.eventsSkipped++;
}

/** 状态 → 界面用词与事件种类（决策提出、确认、否决或取代） */
function decisionActionFor(status: string): { kind: EventKind; word: string; action: string } {
  switch (status) {
    case '已确认':
      return { kind: 'decision_changed', word: '来源记载已确认', action: 'confirmed' };
    case '已否决':
      return { kind: 'decision_changed', word: '被否决', action: 'rejected' };
    case '已取代':
      return { kind: 'decision_changed', word: '被某项决定取代', action: 'superseded' };
    case '已搁置':
      return { kind: 'decision_changed', word: '已搁置', action: 'shelved' };
    case '来源不一致':
      return { kind: 'decision_raised', word: '来源不一致（提出问题）', action: 'conflicted' };
    default:
      return { kind: 'decision_raised', word: '提出问题', action: 'raised' };
  }
}

/**
 * 决策事件写入：
 * - 每条来源陈述已在 statements 中留证
 * - 工程轴只在状态发生转换时新增事件；新版本复述同一状态不重复记
 * 返回实际新增的事件数。
 */
function recordDecisionEvents(
  store: WorkspaceStore,
  workspaceId: string,
  statements: StatementRow[],
  observedAt: string
): number {
  // 每个业务决定取「最新来源陈述」判定当前口径
  const latestByDecision = new Map<string, StatementRow>();
  for (const s of statements) {
    if (!s.decision_id) continue;
    const prev = latestByDecision.get(s.decision_id);
    if (
      !prev ||
      s.observed_at > prev.observed_at ||
      (s.observed_at === prev.observed_at && s.line_start < prev.line_start)
    ) {
      latestByDecision.set(s.decision_id, s);
    }
  }

  let inserted = 0;
  for (const [decisionId, stmt] of latestByDecision) {
    const last = store.db
      .prepare(
        `SELECT payload_json FROM events
         WHERE workspace_id = ? AND subject_id = ? AND kind IN ('decision_raised','decision_changed')
         ORDER BY seq DESC LIMIT 1`
      )
      .get(workspaceId, decisionId) as unknown as { payload_json: string } | undefined;

    let lastStatus: string | null = null;
    if (last) {
      try {
        lastStatus = (JSON.parse(last.payload_json) as { status?: string }).status ?? null;
      } catch {
        lastStatus = null;
      }
    }
    // 同状态复述：证据已写入 statements，不再新增决策事件
    if (lastStatus === stmt.status) continue;

    const action = decisionActionFor(stmt.status);
    const rev = store.getRevision(stmt.revision_id);
    const result = store.insertEvent({
      event_id: `evt_${action.kind}_${decisionId}_${stableShort(stmt.status)}`,
      workspace_id: workspaceId,
      kind: action.kind,
      subject_kind: 'decision',
      subject_id: decisionId,
      revision_id: null,
      occurred_at: rev?.occurred_at ?? null,
      occurred_precision: rev?.occurred_precision ?? 'unknown',
      occurred_source: rev?.occurred_source ?? null,
      observed_at: observedAt,
      headline: `${action.word}：${stmt.code} · ${stmt.question}`,
      detail: `命名空间 ${stmt.namespace}；来源版本 ${stmt.revision_id} 第 ${stmt.line_start}–${stmt.line_end} 行；当前状态 ${stmt.status}。原文的「推荐」不等于已批准。`,
      payload_json: JSON.stringify({
        decision_id: decisionId,
        code: stmt.code,
        namespace: stmt.namespace,
        question: stmt.question,
        status: stmt.status,
        action: action.action,
        statement_id: stmt.statement_id,
        file_id: stmt.file_id,
        revision_id: stmt.revision_id,
        line_start: stmt.line_start,
        line_end: stmt.line_end,
      }),
      batch_id: null,
    });
    if (result.inserted) inserted++;
  }
  return inserted;
}

function safeText(buffer: Buffer | null): string | null {
  return buffer === null ? null : buffer.toString('utf-8');
}

function stableShort(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
