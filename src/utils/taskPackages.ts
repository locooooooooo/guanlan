/**
 * 语义聚合层 · 任务包(Task Package)与五阶段生命周期。
 *
 * 从「File-Centric」聚合为「Workflow & Lifecycle-Centric」的纯函数地基：
 *  - 任务包识别：任意 relative_path 经 G1→G2→G3→G5 级联规则 100% 归属一个任务包
 *    （专项目录 / 执行轮次 run-id / 任务码 / 顶层资产桶 / 工作区根），id 永不为空；
 *  - 工具噪音隔离：draw 形态/`_` 前缀段产物在分桶前拦截（isToolNoisePath 单源
 *    documentIdentity，与首页高价值待阅同口径），不进包 docs 统计；
 *  - 五阶段分类：basename 关键词(顺序即优先级) > 容器默认 > 待分类；
 *    dominantStage 以「最远已到达阶段」表达『卡在决策』等生命周期语义；
 *  - 正文摘要：extractCoreSummary 镜像 guanlanEngine 既有范式，再统一过
 *    condenseSummary——去 markdown 标记、去路径与 KB、丢弃服务端元数据串（summaryNote），
 *    压成一行 ≤80 字；拿不到正文返回空串，由调用方显式占位，绝不拿文件属性冒充结论；
 *    多级回退链：显式「核心结论」章节 → 逐章节正文（跳过目录/编号规则等元话语节）
 *    → 原文首段扫描（跳 frontmatter/表格线/系统说明行，2~3 行截断）→ rev.summaryNote，
 *    避免多数文档因无显式核心结论章节而落空；
 *  - 包摘要优先级链（packageConclusionOf）：00-阅读与派发总览 → PLAN*.md → 01-需求单* →
 *    任意首篇 .md → 任意首篇有结论文档，全部扫完无真实正文才返回空串（数据层不造假）；
 *  - 元信息行 formatPackageMetaLine / 徽标行 packageBadgeLine：焦点卡/画廊
 *    消费的一行元信息与版本徽标，全部从 lastActivity / docs 版本 / dominantStage 真实派生，
 *    严禁「暂无事件」式假占位，无数据返回空串由 UI 降级；
 *  - 五阶段计数：stageCountsOf 供看板「蓝图 n → 计划 n → 决策 n → 执行 n → 交付 n」聚合胶囊；
 *  - 同日同文件合并：按 file_id + 本地日历日(localDay(occurred_at||observed_at)) 成桶，
 *    resolveVersion 由调用方注入(EventDayItem 无 versionNumber，禁止伪造)；
 *  - 日泳道：五阶段固定槽位[蓝图,计划,决策,执行,交付]。
 *
 * 铁律：时间语义零改动——只复用 timeFormat 既有导出(localDay/formatLocalClock/formatLocalStamp)，
 * 不写任何 UTC/时区转换（formatPackageMetaLine 的日差用 localDay 字符串比对）；
 * 版本链/版本时光机语义由 file.revisions 与 resolveVersion 承载，本层不触碰。
 * 仅 import 既有 documentIdentity / timeFormat / parseMarkdownOutline，无新依赖。
 */

import type { FileFormat, FileRecord, Revision } from '../types/guanlan';
import type { TimelineEvent } from '../types/guanlan';
import type { EventDayItem } from '../services/workspaceClient';
import { basenameOf, isToolNoisePath, normalizePath } from './documentIdentity';
import { formatLocalClock, formatLocalStamp, localDay } from './timeFormat';
import { parseMarkdownOutline } from './guanlanEngine';
// 统一状态机 SSOT：六阶段词表 StageRole 与阶段徽标短语单一出口在此，
// 本模块消费、不再自造状态文案；StageRole 定义随 wire 上移 apiTypes（经 stateProjection 再导出）
import { stageBadgeLine } from './stateProjection';
import type { StageRole } from './stateProjection';

// ================= 基础类型 =================

/** 六阶段词表：SSOT 在 stateProjection（wire 定义在 apiTypes.StageWire），此处再导出保兼容 */
export type { StageRole };
export type PackageKind = 'spec' | 'report' | 'longtask' | 'run' | 'fallback';

export interface PackageDoc {
  fileId: string;
  title: string; // 核心文档名 = basenameOf(relative_path)
  format: FileFormat;
  stage: StageRole; // stageOfPath(relative_path)
  conclusion: string; // extractCoreSummary(FileRecord)，无结论为空串
  /**
   * 当前版版本号：当前修订 versionNumber；无修订为 null。
   * 可选字段——手构 PackageDoc 不带此字段时按「无版本数据」处理，
   * packageBadgeLine 返回空串由 UI 降级，绝不造数。
   */
  versionNumber?: number | null;
}

export interface TaskPackage {
  id: string; // 包目录相对路径：G1/G2=容器前缀目录，G3=顶层段，G5='__root__'
  name: string; // 显示名：目录末段(专项名_日期 / run-id / 任务码 / 顶层段)
  kind: PackageKind;
  stage: StageRole; // dominantStage(docs)
  docs: PackageDoc[];
  eventCount: number; // enrichPackagesWithEvents 回填；未回填为 0
  lastActivity: string; // 包内最新事件 observed_at(ISO)；无事件为空串
  latestConclusion: string; // 包摘要优先链(packageConclusionOf)：总览→PLAN→需求单→首篇 md→首篇有结论文档
  readingOrder: PackageDoc[]; // 推荐阅读顺序：蓝图→计划→决策→执行→交付，阶段内按 basename 自然序
}

// ================= 分组规则(G1→G2→G3→G5 级联，100% 覆盖)===================

export const SPEC_CONTAINERS: readonly string[] = [
  '01-方案文档/产品需求与任务包',
  '01-方案文档/项目计划与需求',
  '01-方案文档/汇报与整理',
  '01-方案文档/长任务与执行记录',
  '01-方案文档/发布包',
];

/** G1 容器 → PackageKind（spec=需求/计划类，report=汇报/发布类，longtask=长任务执行类）。 */
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

/**
 * 命名子专项段识别：段名以大写任务码前缀开头——
 * 如「MECH-WIN-001 机械设计工具独立交付」「OFF-PROD-001 文档中枢」。
 * 小写连字名（agent-a / pdm-long006，G2 run 域同名形态）与日期段（2026-11-06）不命中，
 * 避免把顶层资产桶按任意子目录碎成噪声包（G3 纪律：禁止父目录回退）。
 */
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

  // G1：01-方案文档/<容器>/<seg3>/…（深度 ≥ 4 才是包目录内的文件；深度 3 的文件是容器直属，不并入包）
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

  // G2：output/<项目>/<seg3>/…
  if (segments.length >= 4 && segments[0] === 'output') {
    return { id: `output/${segments[1]}/${segments[2]}`, name: segments[2], kind: 'run' };
  }

  // G3：其余深度 ≥ 2 归顶层段（禁止用「父目录」作回退——会碎成噪声包）。
  // 子锚定例外：目录内有文件（段深 ≥ 3）且子段是命名子专项（任务码前缀自证是交付单元，
  // 与 G2 把 OFF-PROD-001 作包名同一语义）→ 锚定子专项；其余一律顶层段不变。
  if (segments.length >= 2) {
    if (segments.length >= 3 && NAMED_SUBPROJECT_RE.test(segments[1])) {
      return { id: `${segments[0]}/${segments[1]}`, name: segments[1], kind: 'fallback' };
    }
    return { id: segments[0], name: segments[0], kind: 'fallback' };
  }

  // G5：根级文件
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

/**
 * 包摘要多级优先链：按阅读价值优先级扫描包内 docs——
 * 00-阅读与派发总览 → PLAN*.md → 01-需求单* → 任意首篇 .md → 任意首篇有结论文档（svg/pdf 兜底，
 * 图形文字/首页文本也是真实正文）。每级取首个 conclusion 非空者；全部扫完无真实正文才返回
 * 空串——空串由 UI 层诚实占位「暂无正文摘要」，数据层不造假。
 * 级内次序沿用 docs（readingOrder：阶段序→标题自然序），跨渲染稳定。
 * （原实现按 rev.observed_at 时间取最新写入文档——最新写入常是执行记录残页，
 * 把总览的好结论挤成空串，是「满屏暂无正文摘要」的包级根因之一。）
 */
function packageConclusionOf(docs: PackageDoc[]): string {
  const mdDocs = docs.filter((d) => d.format === 'md');
  // 注意：PackageDoc.title = basenameOf 去扩展名（无 '.md' 后缀），前缀匹配即锚定文件名
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

/** 阅读顺序排序键：阶段序[蓝图,计划,决策,执行,交付]，待分类置尾；阶段内按 basename 自然序。 */
function compareReadingOrder(a: PackageDoc, b: PackageDoc): number {
  const rankA = STAGE_RANK[a.stage];
  const rankB = STAGE_RANK[b.stage];
  if (rankA !== rankB) return rankA - rankB;
  return a.title.localeCompare(b.title, undefined, { numeric: true });
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
    // latestConclusion：事件流最新写入文档的结论优先（最新动态承载最新结论，既有口径）；
    // 该文档无结论或包内无事件时保留 packageConclusionOf 优先链产物（总览→PLAN→需求单→…）。
    let latestConclusion = pkg.latestConclusion;
    if (lastEventFileId !== null) {
      const doc = pkg.docs.find((d) => d.fileId === lastEventFileId);
      if (doc && doc.conclusion) latestConclusion = doc.conclusion;
    }
    return { ...pkg, eventCount, lastActivity, latestConclusion };
  });
}

// ================= 五阶段分类 =================

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
  // 强信号只认文件名：目录段（容器/专项名）里的「决策/评审」不代表当前文件是决策纸
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

// ================= 核心结论 / 正文摘要 =================

/** 摘要单行上限（一行 ≤80 字，超出以省略号「…」收口）。 */
export const SUMMARY_MAX_CHARS = 80;

/**
 * 文件属性串识别——这些不是结论，是文件元数据，摘要层必须丢弃（降噪）。
 *
 * 唯一产地是服务端 summaryNote 拼装（server/project.ts）：
 *   `v2 · 2026-11-12 13:03:13（文件修改时间） · 9.1 KB · 01-方案文档/README.md`
 * 另有 PDF 未索引占位句与快照淘汰备注，同属状态说明而非正文。
 * 规则只认「整体形态」标记，不按包含关系误伤正文（正文里出现「KB」由 condenseSummary 的
 * 数字+单位剥离处理，不整句判为元数据）。
 */
const METADATA_PATTERNS: readonly RegExp[] = [
  /^v\d+\s*[·:：]/, // vN · …（服务端版本摘要串的固定开头）
  /^v\d+\s*（/, // vN（日期待考…
  /（(?:原文记载|文件修改时间|文档自述|采集)）/, // 时间口径括注
  /正文尚未索引/, // PDF 正文未索引占位
  /仅文件名与元数据可检索/, // 同上（长句）
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
  s = s.replace(/```[\s\S]*?```/g, ' '); // 围栏代码块整段不是摘要
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // 图片
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // 链接只留文字
  // 表格分隔行 / 水平线（字符类不含 \s，避免把换行吃进来跨行误删）
  s = s.replace(/^[ \t]*\|?[ \t:|-]{3,}\|?[ \t]*$/gm, ' ');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // 标题
  s = s.replace(/^\s{0,3}>\s?/gm, ''); // 引用
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ''); // 列表符
  s = s.replace(/\|/g, ' · '); // 表格单元格 → 间隔
  s = s.replace(/[*_~`]+/g, ''); // 强调 / 行内代码
  s = s.replace(/<[^>]+>/g, ' '); // HTML 标签
  s = s.replace(/（(?:原文记载|文件修改时间|文档自述|采集)）/g, ' '); // 残留元数据碎片
  s = s.replace(/\d+(?:\.\d+)?\s?(?:KB|MB|GB|KiB|MiB)\b/g, ' '); // 体量
  s = s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  // 折叠成一行后，行内残留的列表符（「A。 - B」这种由多行拼接出来的）一并去掉
  s = s.replace(/(^|\s)[-*+]\s+/g, '$1');
  s = s.replace(/\s+/g, ' ').replace(/\s*·\s*/g, ' · ').trim();
  s = s.replace(/^[·、,，;；:：|\-\s]+/, '').replace(/[·、,，;；:：|\-\s]+$/, '');
  // 只剩标点/分隔符（无任何字母或数字）→ 视为无摘要
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  if (s.length > SUMMARY_MAX_CHARS) {
    s = `${s.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`;
  }
  return s;
}

// ---------- 元话语识别（目录/编号规则/自动生成声明是「关于文件的话」，不是业务描述） ----------

/** 系统说明行模式：命中任一即视为元话语。锚定「整体形态」短语，不按宽泛词误伤正文。 */
const META_DISCOURSE_RES: readonly RegExp[] = [
  /自动生成/, // 「本文件由…自动生成」
  /本文件由|本文档由/, // 生成方声明
  /编号规则/, // 「编号规则：PDM-YYYYMMDD-…」
  /归入目录|目录说明|目录结构/, // 归档/目录说明
  /^(?:文档|文件)?(?:目录|清单|导航)$/, // 整行就是「目录/文档目录/导航」标题
];

/** 目录/导航链接行：整行是一个 [文字](路径) 链接（可带列表符）——目录页条目，不是叙述。 */
const TOC_LINK_LINE_RE = /^\s*(?:[-*+]\s+)?\[[^\]]+\]\([^)]*\)\s*$/;

function isMetaDiscourseLine(line: string): boolean {
  return META_DISCOURSE_RES.some((re) => re.test(line));
}

/** 噪音章节标题：「目录」「编号规则」「使用说明(自动生成)」一类章节不产出业务摘要。 */
function isJunkSectionTitle(title: string): boolean {
  return /目录|编号规则|自动生成/.test(title);
}

/** 首段扫描行数上限（2~3 行截断口径：抓满 3 行收口，最终仍由 condenseSummary 压到 ≤80 字）。 */
const FIRST_PARAGRAPH_MAX_LINES = 3;

/**
 * 原文首段扫描：无标题文档（sections 为空）或全噪音章节时的最后一层正文回退。
 * 跳过：frontmatter（首个非空行恰为 '---' 的块）、围栏代码块、标题行、表格行（结构化数据
 * 不是叙述段，`|---` 分隔线已由 condenseSummary 再兜一道）、水平线、系统元话语行、
 * 目录链接行；遇空行即收口（只取第一段），抓满 3 行截断。
 * 返回未压缩的段落原文（可能含 markdown 标记），交 condenseSummary 统一清洗。
 */
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
      if (picked.length > 0) break; // 空行 = 段落终结
      continue;
    }
    const terminate = picked.length > 0; // 已开段后遇结构行一律收口
    if (!picked.length && /^-{3,}$/.test(line)) {
      inFrontmatter = true; // 仅文档头第一个 '---' 视为 frontmatter 开栅
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

  // DerivedSummary 缓存：派生摘要按版本身份（revision_id）缓存，
  // 输入以引用身份校验——同一版本未变化的正文是同一字符串实例（revisionContentStore
  // 的 ready 条目每次返回同一实例），引用相等即命中，不再对全部已加载 MD 重跑
  // parseMarkdownOutline 全文解析（此前每次发布都对已加载文档全量重解析，
  // 依次打开 K 篇累计 O(K²L)）。同一 revision 的内容不可变；唯一状态跃迁是
  // 「未加载 → 已加载」：未加载时按 summaryNote 兜底产出，正文到达后引用
  // 变化触发一次重算，此后复用。
  const cached = derivedSummaryCache.get(rev.revision_id);
  if (
    cached &&
    cached.md === rev.markdownContent &&
    cached.svgTexts === rev.svgExtractedTexts &&
    cached.pdfPages === rev.pdfPages &&
    cached.note === rev.summaryNote &&
    cached.reason === file.pdfStatusReason
  ) {
    // 访问续期（Map 迭代序=插入序 → LRU）
    derivedSummaryCache.delete(rev.revision_id);
    derivedSummaryCache.set(rev.revision_id, cached);
    return cached.summary;
  }

  let coreSummary = rev.summaryNote || '';
  if (file.format === 'md' && rev.markdownContent) {
    const sections = parseMarkdownOutline(rev.markdownContent);
    // ① 显式「核心结论」章节（summaryText 类型可选——parseMarkdownOutline 运行时恒填，
    // 但按契约判空：空则落回②，不把 undefined 递进 condenseSummary）
    const coreSec = sections.find((s) => s.isExplicitCallout === '核心结论');
    let summary = coreSec?.summaryText ? condenseSummary(coreSec.summaryText) : '';
    // ② 逐章节回退：跳噪音章节标题，节正文压完非空且非元话语才采纳
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
    // ③ 原文首段扫描（无标题文档的主回退）
    if (!summary) summary = condenseSummary(firstBusinessParagraph(rev.markdownContent));
    // ④ summaryNote 兜底：dirty summaryNote 由 condenseSummary 判噪音如实返回空串
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
  // 写缓存（LRU：超出容量按插入序逐最旧；覆盖长会话大量修订轮替的堆积）
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

/** DerivedSummary 缓存条目：输入按引用身份校验 */
interface DerivedSummaryEntry {
  md?: string;
  svgTexts?: string[];
  pdfPages?: Revision['pdfPages'];
  note?: string;
  reason?: string;
  summary: string;
}

/** 派生摘要缓存：revision_id → 输入指纹 + 产物（会话级，LRU 4096 版） */
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

// ================= 元信息行 / 徽标行 =================

/**
 * 徽标阶段短语：从 dominantStage 派生的进行时短语。词表 SSOT 已上移
 * stateProjection.STAGE_BADGE_PHRASE（专项卡片/下拉/星图/顶栏四视图同词），
 * 本模块只经 stageBadgeLine 组合「v8 · 短语」，不再自持词表。
 */

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

  // 解析失败（非 ISO 串）落不到任何一天：按归档形态原样透出（formatLocalStamp 契约：
  // 解析失败原样返回，不抛错），绝不冒充「刚收录」
  if (Number.isNaN(new Date(at).getTime())) return `${formatLocalStamp(at)} 归档${tail}`;

  const day = localDay(at);
  const today = localDay(now.toISOString());
  const diffMs =
    Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`);
  // 日历日差取整；时钟偏差导致的负值（未来时刻）夹回 0，按今天处理
  const diffDays = Math.max(0, Math.round(diffMs / 86400000));
  if (diffDays < 7) {
    const relDay = diffDays === 0 ? '今天' : diffDays === 1 ? '昨天' : `${diffDays} 天前`;
    const clock = formatLocalClock(at);
    return clock ? `${relDay} ${clock} 更新${tail}` : `${relDay} 更新${tail}`;
  }
  // 更早：最近活动日期（纯日期/含时刻一律取本地日历日 MM-DD）
  return `${day.slice(5, 10)} 归档${tail}`;
}

// ================= 同日同文件合并 =================

export interface DayRevisionMerge {
  fileId: string;
  day: string; // 本地日历日 YYYY-MM-DD(localDay(occurred_at||observed_at))
  vFirst: number | null; // 首条(observed_at 最早)事件版本号(resolveVersion 解析，首条不可解析为 null)
  vLast: number | null; // 末条(observed_at 最晚)事件版本号(末条不可解析为 null)
  evolutionCount: number; // 今日演进 N 次 = max(0, distinctRevisionCount - 1)
  headline: string; // 最后一次(observed_at 最大)事件 headline(ask：取最后一次 headline)
  revisionIds: string[]; // 桶内去重 revision_id，按事件顺序
  eventCount: number; // 该日该文件事件条数
  merged: boolean; // eventCount > 1(≥2 条事件才合并，单条原样)
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
      // vFirst/vLast = 首末条事件自身的版本号：首条不可解析→vFirst=null，末条不可解析→vLast=null
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

// ================= 日泳道 =================

export interface TaskDaySlot {
  role: StageRole;
  /** 该阶段 readingOrder 首位文档；无该阶段文档→null（契约注释口径，故类型为可空）。 */
  doc: PackageDoc | null;
  card: DayRevisionMerge | null; // 该文档当日合并记录；该日无事件→null
}

export interface TaskDayLane {
  package: TaskPackage;
  date: string; // 本地日历日 YYYY-MM-DD
  slots: TaskDaySlot[]; // 固定顺序：蓝图，计划，决策，执行，交付(各阶段一槽)
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
