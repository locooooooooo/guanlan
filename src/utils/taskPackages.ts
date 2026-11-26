
import type { FileFormat, FileRecord, Revision } from '../types/guanlan';
import type { TimelineEvent } from '../types/guanlan';
import type { EventDayItem } from '../services/workspaceClient';
import { basenameOf, isToolNoisePath, normalizePath } from './documentIdentity';
import { formatLocalClock, formatLocalStamp, localDay } from './timeFormat';
import { parseMarkdownOutline } from './guanlanEngine';
import { stageBadgeLine } from './stateProjection';
import type { StageRole } from './stateProjection';


/** 六阶段词表：SSOT 在 stateProjection（wire 定义在 apiTypes.StageWire），此处再导出保兼容 */
export type { StageRole };
export type PackageKind = 'spec' | 'report' | 'longtask' | 'run' | 'fallback';

export interface PackageDoc {
  fileId: string;
  title: string;
  format: FileFormat;
  stage: StageRole;
  conclusion: string;
  versionNumber?: number | null;
}

export interface TaskPackage {
  id: string;
  name: string;
  kind: PackageKind;
  stage: StageRole;
  docs: PackageDoc[];
  eventCount: number;
  lastActivity: string;
  latestConclusion: string;
  readingOrder: PackageDoc[];
}


export const SPEC_CONTAINERS: readonly string[] = [
  '01-方案文档/产品需求与任务包',
  '01-方案文档/项目计划与需求',
  '01-方案文档/汇报与整理',
  '01-方案文档/长任务与执行记录',
  '01-方案文档/发布包',
];

function containerKindOf(container: string): PackageKind {
  switch (container) {
    case '01-方案文档/产品需求与任务包':
    case '01-方案文档/项目计划与需求':
      return 'spec';
    case '01-方案文档/汇报与整理':
    case '01-方案文档/发布包':
      return 'report';
    case '01-方案文档/长任务与执行记录':
      return 'longtask';
    default:
      return 'fallback';
  }
}

const NAMED_SUBPROJECT_RE = /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+/;

/**
 * 单文件→任务包(纯路径判定，不读文件内容)。
 *  G1:01-方案文档/<容器>/<seg3>/… → id='01-方案文档/<容器>/<seg3>'，name=seg3(专项名_日期)
 *  G2:output/<项目>/<seg3>/… → id='output/<项目>/<seg3>'，name=seg3(run-id 或任务码)
 *  G3:其余深度≥2 → id=顶层段，name=顶层段(资产桶)；
 *    焦点锚定例外：顶层段下存在命名子专项段（任务码前缀）且段深≥3 →
 *    id=顶层段/子专项段，name=子专项段——焦点卡/画布分组锚定真正交付单元，
 *    不再只显示一级大目录名（04-智能体代码）
 *  G5:根级文件 → id='__root__'，name='工作区根'
 *  永不返回 null：任何 relative_path 都有归属。
 */
export function taskPackageOf(relativePath: string): {
  id: string;
  name: string;
  kind: PackageKind;
} {
  const segments = normalizePath(relativePath)
    .split('/')
    .filter((seg) => seg.length > 0);

  if (segments.length >= 4 && segments[0] === '01-方案文档') {
    const container = `${segments[0]}/${segments[1]}`;
    if (SPEC_CONTAINERS.includes(container)) {
      return {
        id: `${container}/${segments[2]}`,
        name: segments[2],
        kind: containerKindOf(container),
      };
    }
  }

  if (segments.length >= 4 && segments[0] === 'output') {
    return { id: `output/${segments[1]}/${segments[2]}`, name: segments[2], kind: 'run' };
  }

  if (segments.length >= 2) {
    if (segments.length >= 3 && NAMED_SUBPROJECT_RE.test(segments[1])) {
      return { id: `${segments[0]}/${segments[1]}`, name: segments[1], kind: 'fallback' };
    }
    return { id: segments[0], name: segments[0], kind: 'fallback' };
  }

  return { id: '__root__', name: '工作区根', kind: 'fallback' };
}

function packageDocOf(file: FileRecord): PackageDoc {
  const rev =
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1];
  return {
    fileId: file.file_id,
    title: basenameOf(file.relative_path),
    format: file.format,
    stage: stageOfPath(file.relative_path),
    conclusion: extractCoreSummary(file),
    versionNumber: rev ? (rev.versionNumber ?? null) : null,
  };
}

function packageConclusionOf(docs: PackageDoc[]): string {
  const mdDocs = docs.filter((d) => d.format === 'md');
  const levels: PackageDoc[][] = [
    mdDocs.filter((d) => /^00-阅读与派发总览/i.test(d.title)),
    mdDocs.filter((d) => /^PLAN/i.test(d.title)),
    mdDocs.filter((d) => /^01-需求单/i.test(d.title)),
    mdDocs,
    docs,
  ];
  for (const level of levels) {
    for (const d of level) {
      if (d.conclusion) return d.conclusion;
    }
  }
  return '';
}

const READING_ORDER_COLLATOR = new Intl.Collator(undefined, { numeric: true });

function compareReadingOrder(a: PackageDoc, b: PackageDoc): number {
  const rankA = STAGE_RANK[a.stage];
  const rankB = STAGE_RANK[b.stage];
  if (rankA !== rankB) return rankA - rankB;
  return READING_ORDER_COLLATOR.compare(a.title, b.title);
}

const STAGE_RANK: Record<StageRole, number> = {
  蓝图: 0,
  计划: 1,
  决策: 2,
  执行: 3,
  交付: 4,
  待分类: 5,
};

/**
 * 文件集→任务包列表(按 id 排序稳定；每包 docs 按 readingOrder 排)。
 * eventCount/lastActivity 为 0/'' 占位，由 enrichPackagesWithEvents 回填。
 * 工具噪音过滤：draw_edge/draw_ms/draw 等工具脚本产物严禁混入任务包统计——
 * 包文档数、画廊封面候选、画布分组 docCount、最活跃专项 eventCount 全部从包
 * docs 派生，故在分桶前按 isToolNoisePath（单一出口 documentIdentity，与首页
 * 高价值待阅同口径）拦干净；组件层零过滤，消费方拿到的 docs 即终稿。
 * 纯噪音桶（成员全为噪音）不产出空包，避免「0 份」橱窗卡。
 */
export function groupFilesIntoPackages(files: FileRecord[]): TaskPackage[] {
  const buckets = new Map<string, FileRecord[]>();
  for (const f of files) {
    if (isToolNoisePath(f.relative_path)) continue;
    const id = taskPackageOf(f.relative_path).id;
    const list = buckets.get(id);
    if (list) list.push(f);
    else buckets.set(id, [f]);
  }

  const packages: TaskPackage[] = [];
  for (const [, members] of buckets) {
    const first = taskPackageOf(members[0].relative_path);
    const docs = members.map(packageDocOf).sort(compareReadingOrder);
    packages.push({
      id: first.id,
      name: first.name,
      kind: first.kind,
      stage: dominantStage(docs),
      docs,
      eventCount: 0,
      lastActivity: '',
      latestConclusion: packageConclusionOf(docs),
      readingOrder: docs,
    });
  }

  packages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return packages;
}

/**
 * 事件回填：按 TimelineEvent.file_id 计数与取最新 observed_at，并计算 latestConclusion。
 * 不修改输入 packages（返回新对象）。
 */
export function enrichPackagesWithEvents(
  packages: TaskPackage[],
  events: TimelineEvent[]
): TaskPackage[] {
  const eventsByFile = new Map<string, TimelineEvent[]>();
  for (const ev of events) {
    const list = eventsByFile.get(ev.file_id);
    if (list) list.push(ev);
    else eventsByFile.set(ev.file_id, [ev]);
  }

  return packages.map((pkg) => {
    let eventCount = 0;
    let lastActivity = '';
    let lastEventFileId: string | null = null;
    for (const doc of pkg.docs) {
      const list = eventsByFile.get(doc.fileId);
      if (!list) continue;
      eventCount += list.length;
      for (const ev of list) {
        if (ev.observed_at > lastActivity) {
          lastActivity = ev.observed_at;
          lastEventFileId = doc.fileId;
        }
      }
    }
    let latestConclusion = pkg.latestConclusion;
    if (lastEventFileId !== null) {
      const doc = pkg.docs.find((d) => d.fileId === lastEventFileId);
      if (doc && doc.conclusion) latestConclusion = doc.conclusion;
    }
    return { ...pkg, eventCount, lastActivity, latestConclusion };
  });
}


/** 关键词表：顺序即优先级，自上而下首个命中生效(交付>执行>决策>计划>蓝图)。
 *  受决策强信号约束（见 DECISION_BASENAME_KEYWORDS）：basename 命中强信号的
 *  文件不再进入本表循环，故「决策回执（请勾选后回传）」这类带执行族词的文件名不再被
 *  交付/执行关键词抢占到执行。 */
export const STAGE_KEYWORDS: ReadonlyArray<{
  role: StageRole;
  keywords: readonly string[];
}> = [
  { role: '交付', keywords: ['handoff', '交付', '复验', '验收', 'delivery', '汇报'] },
  { role: '执行', keywords: ['run-', '长任务', '执行', '启动', '续跑', '修改', '变更', '恢复', '轮次'] },
  { role: '决策', keywords: ['待确认', '决策', '阻塞', '回执', '卡点', '边界', 'question'] },
  { role: '计划', keywords: ['plan', '计划', '路线图', '排期', '进度', 'roadmap'] },
  { role: '蓝图', keywords: ['需求', '总览', '定义', '分工', '派发', 'overview', 'requirement', '规格'] },
];

/**
 * 决策强信号：文件名（basename，只看文件名本身、不看目录段）含其一 →
 * 直接归类决策，优先于 STAGE_KEYWORDS 顺序表。
 * 背景：「决策回执（请勾选后回传）」类文件名常混执行族词（修改/变更/轮次）或交付族词
 * （验收/复验），仅按「交付>执行>决策」首中序会把它们误判到执行/交付；文件名自证用途
 * （要你拍板/回传的纸），强信号必须压过泛化关键词。
 */
export const DECISION_BASENAME_KEYWORDS: readonly string[] = ['决策', '待确认', '回执', '评审'];

/** 容器默认阶段：basename 关键词未命中时按容器兜底；无容器→'待分类'。 */
export const CONTAINER_DEFAULT_STAGE: Readonly<Record<string, StageRole>> = {
  '01-方案文档/产品需求与任务包': '蓝图',
  '01-方案文档/项目计划与需求': '计划',
  '01-方案文档/汇报与整理': '交付',
  '01-方案文档/发布包': '交付',
  '01-方案文档/长任务与执行记录': '执行',
  output: '执行',
};

/**
 * 文档阶段：basename 决策强信号（优先于一切关键词）→basename 关键词(小写 contains)
 * →容器默认→'待分类'。容器判定取路径自身前缀：先看两段容器键（01-方案文档/<容器>），
 * 再看单段键（output）。
 */
export function stageOfPath(relativePath: string): StageRole {
  const base = basenameOf(relativePath).toLowerCase();
  const name = basenameOf(relativePath);
  for (const kw of DECISION_BASENAME_KEYWORDS) {
    if (name.includes(kw)) return '决策';
  }
  for (const { role, keywords } of STAGE_KEYWORDS) {
    for (const kw of keywords) {
      if (base.includes(kw.toLowerCase())) return role;
    }
  }

  const segments = normalizePath(relativePath)
    .split('/')
    .filter((seg) => seg.length > 0);
  if (segments.length >= 2) {
    const container = `${segments[0]}/${segments[1]}`;
    if (container in CONTAINER_DEFAULT_STAGE) return CONTAINER_DEFAULT_STAGE[container];
  }
  if (segments.length >= 1 && segments[0] in CONTAINER_DEFAULT_STAGE) {
    return CONTAINER_DEFAULT_STAGE[segments[0]];
  }
  return '待分类';
}

/**
 * 包主导阶段='最远已到达阶段'：依次看是否含 交付/执行/决策/计划/蓝图 文档，全无→'待分类'。
 * 例：有待确认事项但无交付 → '决策'(卡在决策)。待分类文档不计数。
 */
export function dominantStage(docs: PackageDoc[]): StageRole {
  const order: StageRole[] = ['交付', '执行', '决策', '计划', '蓝图'];
  for (const role of order) {
    if (docs.some((d) => d.stage === role)) return role;
  }
  return '待分类';
}


/** 摘要单行上限（一行 ≤80 字，超出以省略号「…」收口）。 */
export const SUMMARY_MAX_CHARS = 80;

const METADATA_PATTERNS: readonly RegExp[] = [
  /^v\d+\s*[·:：]/,
  /^v\d+\s*（/,
  /（(?:原文记载|文件修改时间|文档自述|采集)）/,
  /正文尚未索引/,
  /仅文件名与元数据可检索/,
  /快照已过保留期/,
  /^日期待考$/,
];

/** 该文本是否为「文件属性串」而非正文摘要。空串返回 false（空本来就没有噪音）。 */
export function isFileMetadataText(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return METADATA_PATTERNS.some((re) => re.test(s));
}

/**
 * 正文摘要压缩（纯函数）：
 * ① 元数据串整体丢弃（返回空串，交由调用方显式占位「暂无正文摘要」，绝不把路径/KB 当结论）；
 * ② 去 markdown 标记（围栏代码块、标题井号、引用、列表符、表格竖线、强调/行内代码、HTML 标签、
 *    图片与链接地址）；
 * ③ 剥离残留元数据碎片（时间口径括注、`4.5 KB` 这类体量）；
 * ④ 压成一行、折叠空白、去掉行首尾的光杆分隔符；
 * ⑤ 超 SUMMARY_MAX_CHARS(80) 截断并加「…」。
 */
export function condenseSummary(raw: string): string {
  if (!raw) return '';
  if (isFileMetadataText(raw)) return '';

  let s = raw.replace(/\r/g, '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^[ \t]*\|?[ \t:|-]{3,}\|?[ \t]*$/gm, ' ');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');
  s = s.replace(/\|/g, ' · ');
  s = s.replace(/[*_~`]+/g, '');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/（(?:原文记载|文件修改时间|文档自述|采集)）/g, ' ');
  s = s.replace(/\d+(?:\.\d+)?\s?(?:KB|MB|GB|KiB|MiB)\b/g, ' ');
  s = s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  s = s.replace(/(^|\s)[-*+]\s+/g, '$1');
  s = s.replace(/\s+/g, ' ').replace(/\s*·\s*/g, ' · ').trim();
  s = s.replace(/^[·、,，;；:：|\-\s]+/, '').replace(/[·、,，;；:：|\-\s]+$/, '');
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  if (s.length > SUMMARY_MAX_CHARS) {
    s = `${s.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`;
  }
  return s;
}


const META_DISCOURSE_RES: readonly RegExp[] = [
  /自动生成/,
  /本文件由|本文档由/,
  /编号规则/,
  /归入目录|目录说明|目录结构/,
  /^(?:文档|文件)?(?:目录|清单|导航)$/,
];

const TOC_LINK_LINE_RE = /^\s*(?:[-*+]\s+)?\[[^\]]+\]\([^)]*\)\s*$/;

function isMetaDiscourseLine(line: string): boolean {
  return META_DISCOURSE_RES.some((re) => re.test(line));
}

function isJunkSectionTitle(title: string): boolean {
  return /目录|编号规则|自动生成/.test(title);
}

const FIRST_PARAGRAPH_MAX_LINES = 3;

function firstBusinessParagraph(markdown: string): string {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const picked: string[] = [];
  let inFrontmatter = false;
  let inCodeFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inFrontmatter) {
      if (/^-{3,}$/.test(line)) inFrontmatter = false;
      continue;
    }
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!line) {
      if (picked.length > 0) break;
      continue;
    }
    const terminate = picked.length > 0;
    if (!picked.length && /^-{3,}$/.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('|')) {
      if (terminate) break;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (terminate) break;
      continue;
    }
    if (isMetaDiscourseLine(line) || TOC_LINK_LINE_RE.test(line)) {
      if (terminate) break;
      continue;
    }
    picked.push(line);
    if (picked.length >= FIRST_PARAGRAPH_MAX_LINES) break;
  }
  return picked.join(' ');
}

/**
 * 当前版正文摘要（多级回退链）：
 * md→parseMarkdownOutline 后按序取首个可用摘要：
 *   ① isExplicitCallout==='核心结论' 的 summaryText（最高优先级）；
 *   ② 逐章节尝试：跳过目录/编号规则等噪音章节与元话语正文，首个压完非空者
 *      （避免「## 目录」或纯表格节抢位产出噪声摘要）；
 *   ③ 无标题文档/全噪音章节 → 原文首段扫描 firstBusinessParagraph（跳 frontmatter/
 *      表格线/系统说明行，2~3 行截断）——这是「多数文档没有核心结论章节」时的主回退；
 *   ④ rev.summaryNote 兜底（多为服务端元数据串，condense 后如实为空串）。
 * svg→'可检索图形文字 (N 处)：前 3 条'；pdf→pdfPages[0].extractedText || pdfStatusReason || summaryNote。
 * (算法镜像 guanlanEngine 既有范式)
 *
 * 统一过 condenseSummary：返回值保证单行 ≤80 字、不含 markdown 标记、
 * 不含 `4.5 KB` 体量、不含 `01-方案文档/…` 路径、不是 `vN · 日期 · 元数据` 串；
 * 全部层扫完无真实正文才返回空串（调用方显式占位，禁止把文件属性冒充结论）。
 */
export function extractCoreSummary(file: FileRecord): string {
  const rev =
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1];
  if (!rev) return '';

  const cached = derivedSummaryCache.get(rev.revision_id);
  if (
    cached &&
    cached.md === rev.markdownContent &&
    cached.svgTexts === rev.svgExtractedTexts &&
    cached.pdfPages === rev.pdfPages &&
    cached.note === rev.summaryNote &&
    cached.reason === file.pdfStatusReason
  ) {
    derivedSummaryCache.delete(rev.revision_id);
    derivedSummaryCache.set(rev.revision_id, cached);
    return cached.summary;
  }

  let coreSummary = rev.summaryNote || '';
  if (file.format === 'md' && rev.markdownContent) {
    const sections = parseMarkdownOutline(rev.markdownContent);
    const coreSec = sections.find((s) => s.isExplicitCallout === '核心结论');
    let summary = coreSec?.summaryText ? condenseSummary(coreSec.summaryText) : '';
    if (!summary) {
      for (const sec of sections) {
        if (sec === coreSec || !sec.summaryText) continue;
        if (isJunkSectionTitle(sec.title)) continue;
        const cand = condenseSummary(sec.summaryText);
        if (cand && !isMetaDiscourseLine(cand)) {
          summary = cand;
          break;
        }
      }
    }
    if (!summary) summary = condenseSummary(firstBusinessParagraph(rev.markdownContent));
    if (!summary) summary = rev.summaryNote || '';
    coreSummary = summary;
  } else if (file.format === 'svg' && rev.svgExtractedTexts && rev.svgExtractedTexts.length > 0) {
    coreSummary = `可检索图形文字 (${rev.svgExtractedTexts.length} 处)：${rev.svgExtractedTexts
      .slice(0, 3)
      .join(' · ')}`;
  } else if (file.format === 'pdf') {
    coreSummary =
      rev.pdfPages?.[0]?.extractedText ||
      file.pdfStatusReason ||
      rev.summaryNote ||
      '';
  }
  const summary = condenseSummary(coreSummary);
  if (derivedSummaryCache.size >= DERIVED_SUMMARY_CACHE_CAPACITY && !derivedSummaryCache.has(rev.revision_id)) {
    const oldest = derivedSummaryCache.keys().next();
    if (!oldest.done) derivedSummaryCache.delete(oldest.value);
  }
  derivedSummaryCache.set(rev.revision_id, {
    md: rev.markdownContent,
    svgTexts: rev.svgExtractedTexts,
    pdfPages: rev.pdfPages,
    note: rev.summaryNote,
    reason: file.pdfStatusReason,
    summary,
  });
  return summary;
}

interface DerivedSummaryEntry {
  md?: string;
  svgTexts?: string[];
  pdfPages?: Revision['pdfPages'];
  note?: string;
  reason?: string;
  summary: string;
}

const derivedSummaryCache = new Map<string, DerivedSummaryEntry>();
const DERIVED_SUMMARY_CACHE_CAPACITY = 4096;

/** 仅供测试/诊断：派生摘要缓存条目数 */
export function derivedSummaryCacheStatsForTest(): number {
  return derivedSummaryCache.size;
}

/** 仅供测试/诊断：清空派生摘要缓存 */
export function clearDerivedSummaryCacheForTest(): void {
  derivedSummaryCache.clear();
}

/**
 * 五阶段计数（看板「5 阶段聚合胶囊」的唯一数据源）：
 * 每个阶段在该包内有几份文档，如 `蓝图 1 → 计划 1 → 决策 1 → 执行 8 → 交付 2`。
 * 待分类单独计数（不进五阶段条，但仍参与「N 份」总量口径）。
 */
export function stageCountsOf(docs: PackageDoc[]): Record<StageRole, number> {
  const counts: Record<StageRole, number> = {
    蓝图: 0,
    计划: 0,
    决策: 0,
    执行: 0,
    交付: 0,
    待分类: 0,
  };
  for (const doc of docs) counts[doc.stage] += 1;
  return counts;
}



/**
 * 包整体版本号：包内文档当前版最大 versionNumber（全无修订数据 → null，不造数）。
 * 徽标行（阶段短语 / 服务端六态投影）共用同一版本口径。
 */
export function packageVersionNumber(pkg: Pick<TaskPackage, 'docs'>): number | null {
  let version: number | null = null;
  for (const d of pkg.docs) {
    if (typeof d.versionNumber === 'number' && (version === null || d.versionNumber > version)) {
      version = d.versionNumber;
    }
  }
  return version;
}

/**
 * 徽标行：版本与阶段全从 docs 真实派生——
 *   版本 = 包内文档当前版最大 versionNumber（包整体演进到 vN；全无修订数据 → 不造数）；
 *   阶段短语 = STAGE_BADGE_PHRASE[pkg.stage]（dominantStage 语义，SSOT 在 stateProjection）。
 * 输出形如「v8 · 待用户验收」；有版本无短语（待分类）→「v8」；有短语无版本 →「待拍板」；
 * 两者皆无（无版本数据的待分类包/手构 docs）→ 空串由 UI 降级，严禁假占位。
 * （组合逻辑委托 stateProjection.stageBadgeLine。）
 */
export function packageBadgeLine(pkg: TaskPackage): string {
  return stageBadgeLine(pkg.stage, packageVersionNumber(pkg));
}

/**
 * 一行元信息：时间从 pkg.lastActivity 真实计算，严禁「暂无事件」式假占位。
 *   近 7 天有活动 →「今天 14:20 更新 · 20 份资料」（相对日+时刻；昨天/2~6 天前同理）
 *   更早         →「11-04 归档 · 20 份资料」（最近活动日期 MM-DD）
 *   无任何时间   →「刚收录 · N 份资料」（事件流未回填 lastActivity 的诚实原貌）
 * 日差用 localDay 字符串比对（timeFormat 单一口径，不写新时区换算）；
 * 含时刻 ISO 的时刻用 formatLocalClock 按本地时区取钟。now 仅测试注入，缺省真实当下。
 */
export function formatPackageMetaLine(pkg: TaskPackage, now: Date = new Date()): string {
  const tail = ` · ${pkg.docs.length} 份资料`;
  const at = pkg.lastActivity;
  if (!at) return `刚收录${tail}`;

  if (Number.isNaN(new Date(at).getTime())) return `${formatLocalStamp(at)} 归档${tail}`;

  const day = localDay(at);
  const today = localDay(now.toISOString());
  const diffMs =
    Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`);
  const diffDays = Math.max(0, Math.round(diffMs / 86400000));
  if (diffDays < 7) {
    const relDay = diffDays === 0 ? '今天' : diffDays === 1 ? '昨天' : `${diffDays} 天前`;
    const clock = formatLocalClock(at);
    return clock ? `${relDay} ${clock} 更新${tail}` : `${relDay} 更新${tail}`;
  }
  return `${day.slice(5, 10)} 归档${tail}`;
}


export interface DayRevisionMerge {
  fileId: string;
  day: string;
  vFirst: number | null;
  vLast: number | null;
  evolutionCount: number;
  headline: string;
  revisionIds: string[];
  eventCount: number;
  merged: boolean;
}

/**
 * 同日同文件合并：输入一日桶的 samples，按 file_id 分组后每组产出一条记录。
 * resolveVersion 由调用方注入(file_id→revisions 查 versionNumber)；
 * versionNumber 不在 EventDayItem 内(workspaceClient.ts:403-425)，禁止伪造。
 * file_id 为空的事件（如无关联文件的决策事件）不构成文件日桶，跳过。
 */
export function mergeDayRevisions(
  samples: EventDayItem[],
  resolveVersion: (revisionId: string | null) => number | null
): DayRevisionMerge[] {
  const buckets = new Map<string, EventDayItem[]>();
  for (const sample of samples) {
    if (!sample.file_id) continue;
    const list = buckets.get(sample.file_id);
    if (list) list.push(sample);
    else buckets.set(sample.file_id, [sample]);
  }

  const results: DayRevisionMerge[] = [];
  for (const [fileId, items] of buckets) {
    const revisionIds: string[] = [];
    let earliest: EventDayItem | null = null;
    let latest: EventDayItem | null = null;
    for (const item of items) {
      if (item.revision_id && !revisionIds.includes(item.revision_id)) {
        revisionIds.push(item.revision_id);
      }
      if (!earliest || item.observed_at < earliest.observed_at) earliest = item;
      if (!latest || item.observed_at > latest.observed_at) latest = item;
    }
    results.push({
      fileId,
      day: localDay(items[0].occurred_at || items[0].observed_at),
      vFirst: earliest ? resolveVersion(earliest.revision_id) : null,
      vLast: latest ? resolveVersion(latest.revision_id) : null,
      evolutionCount: Math.max(0, revisionIds.length - 1),
      headline: latest?.headline ?? '',
      revisionIds,
      eventCount: items.length,
      merged: items.length > 1,
    });
  }
  return results;
}

/**
 * 合并卡标签：merged 且 vFirst!==vLast → 'v1 → v3 · 今日演进 2 次'；
 * 仅末版可解析 → 'v3'；全不可解析 → ''。evolutionCount===0 时不带演进短语。
 */
export function dayMergeLabel(m: DayRevisionMerge): string {
  if (!m.merged) return '';
  const hasRange = m.vFirst !== null && m.vLast !== null && m.vFirst !== m.vLast;
  if (hasRange) {
    return m.evolutionCount > 0
      ? `v${m.vFirst} → v${m.vLast} · 今日演进 ${m.evolutionCount} 次`
      : `v${m.vFirst} → v${m.vLast}`;
  }
  if (m.vLast !== null) return `v${m.vLast}`;
  return '';
}


export interface TaskDaySlot {
  role: StageRole;
  doc: PackageDoc | null;
  card: DayRevisionMerge | null;
}

export interface TaskDayLane {
  package: TaskPackage;
  date: string;
  slots: TaskDaySlot[];
}

/** 五阶段槽位固定顺序。日泳道与工作流看板共用同一份常量，禁止各处再抄一遍。 */
export const STAGE_SLOT_ORDER: readonly StageRole[] = ['蓝图', '计划', '决策', '执行', '交付'];

/**
 * 阶段槽位强调色（stage-ink 六色双层：graphic 原值接令牌，浅底文字走 -text 深档见 index.css）。
 * 原为 AtlasView 组件内常量，首页「任务动态」也需要同一套阶段色，故上移至此单一出口；
 * 对比度不足的硬编码色值统一收编至设计令牌，确保图形对比度达 3:1。
 */
export const STAGE_ACCENT: Record<StageRole, string> = {
  蓝图: 'var(--stage-ink-blueprint)',
  计划: 'var(--stage-ink-plan)',
  决策: 'var(--stage-ink-decision)',
  执行: 'var(--stage-ink-exec)',
  交付: 'var(--stage-ink-deliver)',
  待分类: 'var(--ink-soft)',
};

/**
 * 构建某日所有任务包的泳道。samplesByDay：当日各文件样本(由调用方按 EventDaysResult.groups 切片)。
 * 对 samplesByDay 的每一天，按 packages 原序为每个任务包产出一条泳道；
 * 槽位 doc 取该包 readingOrder 中该阶段首位文档，card 取该文档当日合并记录(无事件→null)。
 * files 参数按契约签名保留（供调用方交叉索引文件全集；泳道计算只依赖 packages 与 samples）。
 */
export function buildDayLanes(
  packages: TaskPackage[],
  files: FileRecord[],
  samplesByDay: ReadonlyMap<string, EventDayItem[]>,
  resolveVersion: (revisionId: string | null) => number | null
): TaskDayLane[] {
  const lanes: TaskDayLane[] = [];
  for (const [day, samples] of samplesByDay) {
    const mergesByFile = new Map<string, DayRevisionMerge>();
    for (const merge of mergeDayRevisions(samples, resolveVersion)) {
      mergesByFile.set(merge.fileId, merge);
    }
    for (const pkg of packages) {
      const slots: TaskDaySlot[] = STAGE_SLOT_ORDER.map((role) => {
        const doc = pkg.readingOrder.find((d) => d.stage === role) ?? null;
        const card = doc ? (mergesByFile.get(doc.fileId) ?? null) : null;
        return { role, doc, card };
      });
      lanes.push({ package: pkg, date: day, slots });
    }
  }
  return lanes;
}
