
import type {
  DecisionAssertion,
  FileRecord,
  TimelineEvent,
} from '../types/guanlan';
import { cleanDisplayText } from './displayText';
import { basenameOf, isToolNoisePath } from './documentIdentity';
import { extractCoreSummary, taskPackageOf } from './taskPackages';
import { localDay } from './timeFormat';
import {
  DECISION_STATUS_CONFIRMED,
  DECISION_STATUS_CONFLICT,
  DECISION_STATUS_PENDING,
} from './stateProjection';

export type ChronosReplayUnit = 'day' | 'week';
export type ChronosReplaySpeed = 1 | 2;
export type ChronosDigestRange = 'today' | 'week';

const ADDED_EVENT_KINDS = new Set<string>([
  'appeared',
  'discovered',
  'workspace_baseline',
]);

/** 司辰步进回放节拍间隔（ms）；1x=1850ms，2x=920ms，reduced-motion 放缓避免频闪 */
export function chronosReplayIntervalMs(
  speed: ChronosReplaySpeed,
  prefersReducedMotion = false
): number {
  const base = speed === 2 ? 920 : 1850;
  return prefersReducedMotion ? Math.max(base, 1400) : base;
}

function parseUtcDayMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 司辰时光步进索引计算（纯函数）：
 * - `dates` 为按时间升序（最旧 → 最新）排列的真实活跃日期数组（YYYY-MM-DD）；
 * - `unit === 'day'`：逐日步进 ±1 并钳位；
 * - `unit === 'week'`：沿时间方向跨越至少 7 个自然日落到首个活跃日（无更远日则落边界）。
 * 越界、空数组或单日数组均安全回退。
 */
export function stepChronosReplayIndex(
  dates: readonly string[],
  currentIndex: number,
  delta: -1 | 1,
  unit: ChronosReplayUnit = 'day'
): number {
  const len = dates.length;
  if (len === 0) return -1;
  if (len === 1) return 0;

  const cur =
    Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < len
      ? currentIndex
      : len - 1;

  if (unit === 'day') {
    return Math.max(0, Math.min(len - 1, cur + delta));
  }

  const curMs = parseUtcDayMs(dates[cur]);
  if (curMs === null) {
    return Math.max(0, Math.min(len - 1, cur + delta));
  }

  const SEVEN_DAYS_MS = 7 * 86_400_000;
  if (delta > 0) {
    for (let i = cur + 1; i < len; i += 1) {
      const targetMs = parseUtcDayMs(dates[i]);
      if (targetMs !== null && targetMs - curMs >= SEVEN_DAYS_MS) {
        return i;
      }
    }
    return len - 1;
  }

  for (let i = cur - 1; i >= 0; i -= 1) {
    const targetMs = parseUtcDayMs(dates[i]);
    if (targetMs !== null && curMs - targetMs >= SEVEN_DAYS_MS) {
      return i;
    }
  }
  return 0;
}

export interface ChronosDigestDocEntry {
  fileId: string;
  revisionId: string;
  title: string;
  relativePath: string;
  format: string;
  packageId: string;
  packageName: string;
  versionLabel: string;
  summary: string | null;
  eventCount: number;
  latestDay: string;
}

export interface ChronosDigestDecisionEntry {
  decisionId: string;
  code: string;
  question: string;
  status: string;
  confirmedAnswer: string | null;
  fileId: string | null;
  relativePath: string | null;
  lineStart: number | null;
}

export interface ChronosDigestPackageRank {
  packageId: string;
  packageName: string;
  eventCount: number;
  docCount: number;
  addedCount: number;
  evolvedCount: number;
}

export interface ChronosDigestModel {
  range: ChronosDigestRange;
  rangeLabel: string;
  startDay: string;
  endDay: string;
  totalEvents: number;
  activeDaysCount: number;
  addedDocs: ChronosDigestDocEntry[];
  evolvedDocs: ChronosDigestDocEntry[];
  resolvedDecisions: ChronosDigestDecisionEntry[];
  pendingDecisions: ChronosDigestDecisionEntry[];
  topPackages: ChronosDigestPackageRank[];
  markdown: string;
}

function resolveLocalTodayDay(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDayString(day: string, offsetDays: number): string {
  const ms = parseUtcDayMs(day);
  if (ms === null) return day;
  return new Date(ms + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function eventDigestDay(ev: TimelineEvent): string {
  if (ev.source_time) {
    const d = localDay(ev.source_time);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  }
  const obs = localDay(ev.observed_at);
  return obs && /^\d{4}-\d{2}-\d{2}$/.test(obs) ? obs : '';
}

function latestRevisionOf(file?: FileRecord) {
  if (!file || file.revisions.length === 0) return null;
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

function pickSummaryForFile(file?: FileRecord, fallbackDetail?: string): string | null {
  if (file) {
    const core = extractCoreSummary(file);
    if (core && core.trim().length > 0) return cleanDisplayText(core).slice(0, 140);
    const rev = latestRevisionOf(file);
    if (rev?.summaryNote && rev.summaryNote.trim().length > 0) {
      return cleanDisplayText(rev.summaryNote).slice(0, 140);
    }
  }
  const detail = fallbackDetail ? cleanDisplayText(fallbackDetail).trim() : '';
  return detail.length > 0 ? detail.slice(0, 140) : null;
}

/**
 * 格式化标准可溯源 Markdown 日报 / 周报（纯函数，零造数）。
 */
export function formatChronosDigestMarkdown(
  model: Omit<ChronosDigestModel, 'markdown'>
): string {
  const lines: string[] = [];
  const spanLabel =
    model.startDay === model.endDay
      ? model.endDay
      : `${model.startDay} ~ ${model.endDay}`;

  lines.push(`# 观澜 · 司辰沉淀手记（${model.rangeLabel} · ${spanLabel}）`);
  lines.push('');
  lines.push(
    `> 共记录 **${model.totalEvents}** 条真实演进事件（覆盖 ${model.activeDaysCount} 个活跃日）· 新增文档 **${model.addedDocs.length}** 份 · 演进文档 **${model.evolvedDocs.length}** 份 · 已拍板 **${model.resolvedDecisions.length}** 项 · 遗留待拍板 **${model.pendingDecisions.length}** 项`
  );
  lines.push('');

  if (model.totalEvents === 0 && model.pendingDecisions.length === 0) {
    lines.push('当前时间窗口内暂无新的文档演进与待拍板事项。');
    lines.push('');
    return lines.join('\n');
  }

  if (model.topPackages.length > 0) {
    lines.push('## 最活跃专项 Top 3');
    lines.push('');
    model.topPackages.forEach((pkg, idx) => {
      lines.push(
        `${idx + 1}. **${pkg.packageName}** — ${pkg.eventCount} 次变更（${pkg.docCount} 份文档：新增 ${pkg.addedCount} · 演进 ${pkg.evolvedCount}）`
      );
    });
    lines.push('');
  }

  lines.push(`## 新增文档（${model.addedDocs.length}）`);
  lines.push('');
  if (model.addedDocs.length === 0) {
    lines.push('- 本窗口无新增文档。');
  } else {
    for (const doc of model.addedDocs) {
      const summarySuffix = doc.summary ? ` — ${doc.summary}` : '';
      lines.push(
        `- [${doc.title}](guanlan://${doc.relativePath}) \`${doc.versionLabel}\`（${doc.packageName} · ${doc.latestDay}）${summarySuffix}`
      );
    }
  }
  lines.push('');

  lines.push(`## 演进文档（${model.evolvedDocs.length}）`);
  lines.push('');
  if (model.evolvedDocs.length === 0) {
    lines.push('- 本窗口无既有文档演进记录。');
  } else {
    for (const doc of model.evolvedDocs) {
      const summarySuffix = doc.summary ? ` — ${doc.summary}` : '';
      lines.push(
        `- [${doc.title}](guanlan://${doc.relativePath}) \`${doc.versionLabel}\`（${doc.packageName} · ${doc.eventCount} 次变更 · ${doc.latestDay}）${summarySuffix}`
      );
    }
  }
  lines.push('');

  lines.push(
    `## 决策进展（已拍板 ${model.resolvedDecisions.length} · 遗留待拍板 ${model.pendingDecisions.length}）`
  );
  lines.push('');
  if (model.resolvedDecisions.length > 0) {
    lines.push('### 已拍板');
    for (const d of model.resolvedDecisions) {
      const loc = d.relativePath
        ? ` · 来源：[${basenameOf(d.relativePath)}${d.lineStart ? `#L${d.lineStart}` : ''}](guanlan://${d.relativePath})`
        : '';
      const ans = d.confirmedAnswer ? ` → ${d.confirmedAnswer}` : '';
      lines.push(`- **${d.code}** ${d.question}${ans}${loc}`);
    }
    lines.push('');
  }
  if (model.pendingDecisions.length > 0) {
    lines.push('### 遗留待拍板');
    for (const d of model.pendingDecisions) {
      const loc = d.relativePath
        ? ` · 来源：[${basenameOf(d.relativePath)}${d.lineStart ? `#L${d.lineStart}` : ''}](guanlan://${d.relativePath})`
        : '';
      lines.push(`- [${d.status}] **${d.code}** ${d.question}${loc}`);
    }
    lines.push('');
  } else if (model.resolvedDecisions.length === 0) {
    lines.push('- 暂无决策记录。');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 构建「司辰手记」结构化回望模型（纯函数，零造数）：
 * - 基于真实 `events`、`files`、`decisions` 在 `today`（1 天）或 `week`（近 7 天）窗口内汇总；
 * - 自动过滤工具噪音路径（isToolNoisePath）与候选决策（isCandidateOnly）。
 */
export function buildChronosDigest(
  events: readonly TimelineEvent[],
  files: readonly FileRecord[],
  decisions: readonly DecisionAssertion[],
  range: ChronosDigestRange,
  anchorDate?: string
): ChronosDigestModel {
  const endDay =
    anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(anchorDate)
      ? anchorDate
      : resolveLocalTodayDay();
  const startDay = range === 'today' ? endDay : shiftDayString(endDay, -6);
  const rangeLabel = range === 'today' ? '今日沉淀' : '近 7 日沉淀';

  const fileById = new Map<string, FileRecord>();
  for (const f of files) fileById.set(f.file_id, f);

  const windowEvents: Array<{ ev: TimelineEvent; day: string }> = [];
  const activeDays = new Set<string>();

  for (const ev of events) {
    const file = ev.file_id ? fileById.get(ev.file_id) : undefined;
    if (file && isToolNoisePath(file.relative_path)) continue;
    const day = eventDigestDay(ev);
    if (!day || day < startDay || day > endDay) continue;
    windowEvents.push({ ev, day });
    activeDays.add(day);
  }

  interface DocAgg {
    fileId: string;
    revisionId: string;
    title: string;
    relativePath: string;
    format: string;
    packageId: string;
    packageName: string;
    versionLabel: string;
    summary: string | null;
    addedEvents: number;
    evolvedEvents: number;
    latestDay: string;
  }

  const docMap = new Map<string, DocAgg>();
  const pkgMap = new Map<
    string,
    {
      packageId: string;
      packageName: string;
      eventCount: number;
      docIds: Set<string>;
      addedCount: number;
      evolvedCount: number;
    }
  >();

  for (const { ev, day } of windowEvents) {
    const isAdded = ADDED_EVENT_KINDS.has(ev.kind);
    const file = ev.file_id ? fileById.get(ev.file_id) : undefined;
    const relPath = file?.relative_path || ev.topic_lane || '';
    const pkg = relPath ? taskPackageOf(relPath) : { id: '__workspace__', name: '工作区' };
    const pkgName = pkg.id === '__root__' ? '工作区根目录' : pkg.name;

    const pEntry = pkgMap.get(pkg.id) ?? {
      packageId: pkg.id,
      packageName: pkgName,
      eventCount: 0,
      docIds: new Set<string>(),
      addedCount: 0,
      evolvedCount: 0,
    };
    pEntry.eventCount += 1;
    if (isAdded) pEntry.addedCount += 1;
    else pEntry.evolvedCount += 1;
    if (ev.file_id) pEntry.docIds.add(ev.file_id);
    pkgMap.set(pkg.id, pEntry);

    if (!ev.file_id) continue;
    const rev = latestRevisionOf(file);
    const verNum = rev?.versionNumber ?? (file?.revisions.length || 1);
    const existing = docMap.get(ev.file_id);
    if (existing) {
      if (isAdded) existing.addedEvents += 1;
      else existing.evolvedEvents += 1;
      if (day > existing.latestDay) existing.latestDay = day;
      if (!existing.summary) existing.summary = pickSummaryForFile(file, ev.detail);
    } else {
      docMap.set(ev.file_id, {
        fileId: ev.file_id,
        revisionId: ev.revision_id || file?.current_revision_id || '',
        title: file?.title || basenameOf(relPath) || cleanDisplayText(ev.headline),
        relativePath: file?.relative_path || relPath,
        format: (file?.format || ev.format || 'doc').toUpperCase(),
        packageId: pkg.id,
        packageName: pkgName,
        versionLabel: `v${verNum}`,
        summary: pickSummaryForFile(file, ev.detail),
        addedEvents: isAdded ? 1 : 0,
        evolvedEvents: isAdded ? 0 : 1,
        latestDay: day,
      });
    }
  }

  const addedDocs: ChronosDigestDocEntry[] = [];
  const evolvedDocs: ChronosDigestDocEntry[] = [];
  for (const agg of docMap.values()) {
    const baseEntry = {
      fileId: agg.fileId,
      revisionId: agg.revisionId,
      title: agg.title,
      relativePath: agg.relativePath,
      format: agg.format,
      packageId: agg.packageId,
      packageName: agg.packageName,
      versionLabel: agg.versionLabel,
      summary: agg.summary,
      latestDay: agg.latestDay,
    };
    if (agg.addedEvents > 0 && agg.evolvedEvents === 0) {
      addedDocs.push({ ...baseEntry, eventCount: agg.addedEvents });
    } else if (agg.evolvedEvents > 0) {
      evolvedDocs.push({ ...baseEntry, eventCount: agg.addedEvents + agg.evolvedEvents });
      if (agg.addedEvents > 0) {
        addedDocs.push({ ...baseEntry, eventCount: agg.addedEvents });
      }
    }
  }

  const sortDocs = (a: ChronosDigestDocEntry, b: ChronosDigestDocEntry) =>
    b.eventCount - a.eventCount ||
    (b.latestDay > a.latestDay ? 1 : b.latestDay < a.latestDay ? -1 : 0) ||
    a.title.localeCompare(b.title, 'zh-Hans-CN');
  addedDocs.sort(sortDocs);
  evolvedDocs.sort(sortDocs);

  const topPackages: ChronosDigestPackageRank[] = Array.from(pkgMap.values())
    .sort((a, b) => b.eventCount - a.eventCount || b.docIds.size - a.docIds.size)
    .slice(0, 3)
    .map((p) => ({
      packageId: p.packageId,
      packageName: p.packageName,
      eventCount: p.eventCount,
      docCount: p.docIds.size,
      addedCount: p.addedCount,
      evolvedCount: p.evolvedCount,
    }));

  const realDecisions = decisions.filter((d) => !d.isCandidateOnly);
  const toDecisionEntry = (d: DecisionAssertion): ChronosDigestDecisionEntry => {
    const firstEv = d.evidences[0];
    const file = firstEv ? fileById.get(firstEv.file_id) : undefined;
    return {
      decisionId: d.decision_id,
      code: d.code,
      question: cleanDisplayText(d.question) || d.question,
      status: d.status,
      confirmedAnswer: d.confirmationBasis?.recordText
        ? cleanDisplayText(d.confirmationBasis.recordText)
        : null,
      fileId: firstEv?.file_id ?? d.confirmationBasis?.file_id ?? null,
      relativePath: file?.relative_path ?? firstEv?.relative_path ?? null,
      lineStart: firstEv?.lineStart ?? d.confirmationBasis?.lineRange?.[0] ?? null,
    };
  };

  const windowDecisionIds = new Set(
    windowEvents.map((w) => w.ev.decision_id).filter((id): id is string => Boolean(id))
  );
  const resolvedDecisions = realDecisions
    .filter((d) => {
      if (d.status !== DECISION_STATUS_CONFIRMED) return false;
      if (windowDecisionIds.has(d.decision_id)) return true;
      const confirmedAt = d.confirmationBasis?.confirmedAt
        ? localDay(d.confirmationBasis.confirmedAt)
        : '';
      if (confirmedAt && confirmedAt >= startDay && confirmedAt <= endDay) return true;
      return d.evidences.some((ev) => {
        const day = ev.source_time ? localDay(ev.source_time) : localDay(ev.observed_at);
        return Boolean(day && day >= startDay && day <= endDay);
      });
    })
    .map(toDecisionEntry)
    .slice(0, 12);

  const pendingDecisions = realDecisions
    .filter(
      (d) => d.status === DECISION_STATUS_CONFLICT || d.status === DECISION_STATUS_PENDING
    )
    .sort(
      (a, b) =>
        (a.status === DECISION_STATUS_CONFLICT ? 0 : 1) -
          (b.status === DECISION_STATUS_CONFLICT ? 0 : 1) ||
        b.impactBlocked.length - a.impactBlocked.length ||
        a.code.localeCompare(b.code, 'zh-Hans-CN')
    )
    .map(toDecisionEntry)
    .slice(0, 12);

  const partial = {
    range,
    rangeLabel,
    startDay,
    endDay,
    totalEvents: windowEvents.length,
    activeDaysCount: activeDays.size,
    addedDocs: addedDocs.slice(0, 20),
    evolvedDocs: evolvedDocs.slice(0, 20),
    resolvedDecisions,
    pendingDecisions,
    topPackages,
  };

  return {
    ...partial,
    markdown: formatChronosDigestMarkdown(partial),
  };
}
