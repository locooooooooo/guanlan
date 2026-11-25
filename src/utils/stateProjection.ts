/**
 * 统一状态机投影层（SSOT）—— 六态文档状态机的前端唯一事实来源。
 *
 * 三层分工：
 *  - ① 存储与纯函数权威在 Rust：native/crates/guanlan-core/src/index/state_machine.rs
 *    （DocState 六态 / StateSignals / next_artifact_state / slot_state）。迁移规则的
 *    权威判定在该文件；本文件的 nextDocState 是其逐字 TS 镜像——双端改迁移规则必须
 *    两侧同步，且由单测锁定一致。
 *  - ② 本文件 = 前端投影 SSOT：六态词表（DOC_STATE_LABEL）、DOC_STATE↔StageRole 映射、
 *    双层投影 projectInitiativeState（服务端 /state-overview 优先，断连回退
 *    dominantStage——回退路径行为保持兼容）、阶段徽标短语
 *    （STAGE_BADGE_PHRASE，taskPackages 原私有词表上移）、文档态徽标/胶囊样式单一出口、
 *    task_node 状态词表、决策未决口径词表（DecisionRadar/HomeView 双份实现收敛）、
 *    版本「（最新）」后缀词（ReaderView/RightInspector 双份实现收敛）、
 *    陈述状态 wire 词映射。
 *  - ③ 消费层（专项卡片 / 专项详情下拉 / 星图节点 / 文档顶栏四处徽标）：
 *    taskPackages、TaskPackageGallery、GraphCanvasView、ReaderView、RightInspector、
 *    HomeView、DecisionRadar 一律从本文件取词，禁止再自造状态文案。
 *
 * 纪律：纯函数模块——禁 import .css / React（node --test 直跑约束）；运行时零依赖
 * （apiTypes 仅 type-only 导入，编译期擦除，与 services 层无运行时回环）。
 */

import type {
  ArtifactStateView,
  DocStateWire,
  InitiativeStateView,
  StageWire,
  StateOverviewResponse,
  StatementStatusWire,
  TaskNodeState,
} from '../services/apiTypes';

// ================= 六态文档状态机 =================

/** 文档六态（wire 词；Rust DocState 逐字镜像） */
export type DocState = DocStateWire;

/** 六阶段（与 taskPackages.StageRole 同词表；Rust Stage 逐字镜像——
 *  StageRole 本身经 taskPackages 再导出，两处共享同一 wire 定义） */
export type StageRole = StageWire;

/** 六态展示顺序（按生命周期自上而下） */
export const DOC_STATE_ORDER: readonly DocState[] = [
  'draft',
  'pending_review',
  'approved_revision',
  'executing',
  'delivered',
  'archived',
];

/** 六态词表（四视图同词的唯一出口）：
 *  draft=草稿、pending_review=待用户确认、approved_revision=选中修订、
 *  executing=执行中、delivered=已交付、archived=已归档。 */
export const DOC_STATE_LABEL: Record<DocState, string> = {
  draft: '草稿',
  pending_review: '待用户确认',
  approved_revision: '选中修订',
  executing: '执行中',
  delivered: '已交付',
  archived: '已归档',
};

/**
 * DOC_STATE → StageRole 映射（六态与五阶段无严格同构映射，按推进主阶段对齐）：
 * 语义：该文档态的推进主战场阶段——draft=蓝图制定、pending_review=待拍板（决策）、
 * approved_revision=定稿归入计划产物、executing=执行、delivered/archived=交付。
 */
export const DOC_STATE_STAGE: Record<DocState, StageRole> = {
  draft: '蓝图',
  pending_review: '决策',
  approved_revision: '计划',
  executing: '执行',
  delivered: '交付',
  archived: '交付',
};

/**
 * StageRole → DOC_STATE 回退映射（双层投影断连路径使用）。
 * 语义：按 dominantStage 的进行时短语对位六态——蓝图/计划制定中=草稿、
 * 待拍板=待用户确认、执行中=执行中、待用户验收=已交付（Delivered 后
 * 用户确认验收→Archived，故「待用户验收」最接近 delivered）、待分类=草稿。
 */
export const STAGE_DOC_STATE: Record<StageRole, DocState> = {
  蓝图: 'draft',
  计划: 'draft',
  决策: 'pending_review',
  执行: 'executing',
  交付: 'delivered',
  待分类: 'draft',
};

/** 状态机信号（Rust StateSignals 逐字镜像；signals 不落持久列）。
 *  三个可选字段为「一次性入参」语义：
 *  - exec_slot_completed / deliver_slot_completed：Executing→Delivered 的具体槽位判据
 *    （不用泛化的 !task_running），由五槽位重算方传入；
 *  - user_accepted：Delivered→Archived 的唯一人工来源 = 归档任务写线程置位。 */
export interface StateSignals {
  pending_p0: number;
  pending_p1: number;
  pending_p2: number;
  checklist_done: number;
  checklist_total: number;
  has_selected_revision: boolean;
  task_running: boolean;
  last_activity_days: number;
  exec_slot_completed?: boolean;
  deliver_slot_completed?: boolean;
  user_accepted?: boolean;
}

/**
 * 迁移判断（Rust next_artifact_state 的逐字 TS 镜像）：
 *  - Draft→PendingReview 当 (pending_p0+pending_p1)>0；
 *  - PendingReview→ApprovedRevision 当 p0==0&&p1==0&&has_selected_revision；
 *  - ApprovedRevision→Executing 当 task_running（=执行槽或交付槽 running，持久跨轮）；
 *  - Executing→Delivered 当 checklist_total>0&&checklist_done==checklist_total
 *    &&p0+p1==0&&执行槽 completed&&交付槽 completed；
 *  - Delivered→Archived 当 user_accepted 或 last_activity_days>30；
 *  - 逆向回流唯一边：state∈{executing,delivered} 且未决 P0/P1>0→PendingReview
 *    （优先于一切正向边判定）；
 *  - Archived 终态：唯一离开通道 = 人工重开（reopen 写线程），本函数恒返回 null。
 * 返回 null = 无迁移（保持现态）。纯函数：同输入恒同输出（running 持久性的
 * 声明式重算语义由幂等性保证）。
 */
export function nextDocState(current: DocState, signals: StateSignals): DocState | null {
  const blocking = signals.pending_p0 + signals.pending_p1;
  // 逆向回流唯一边：执行/交付中引入新的未决 P0/P1 → 打回待用户确认
  if ((current === 'executing' || current === 'delivered') && blocking > 0) {
    return 'pending_review';
  }
  switch (current) {
    case 'draft':
      return blocking > 0 ? 'pending_review' : null;
    case 'pending_review':
      return signals.pending_p0 === 0 &&
        signals.pending_p1 === 0 &&
        signals.has_selected_revision
        ? 'approved_revision'
        : null;
    case 'approved_revision':
      return signals.task_running ? 'executing' : null;
    case 'executing':
      return signals.checklist_total > 0 &&
        signals.checklist_done === signals.checklist_total &&
        blocking === 0 &&
        signals.exec_slot_completed === true &&
        signals.deliver_slot_completed === true
        ? 'delivered'
        : null;
    case 'delivered':
      return signals.user_accepted === true || signals.last_activity_days > 30
        ? 'archived'
        : null;
    case 'archived':
      return null;
  }
}

// ================= 阶段徽标短语（专项卡片等词表，单一出口） =================

/**
 * 阶段徽标短语（从 taskPackages 上移至此，数值逐字不动以保持回退路径兼容）：
 * 执行中＝画廊筛选胶囊既有词；待用户验收＝「待验收」筛选的同语义展开；
 * 待拍板＝首页「待你拍板的决策」同族；蓝图制定中/计划制定中为本层补充词；
 * 待分类不造短语（空串降级）。消费：taskPackages.packageBadgeLine /
 * stageBadgeLine / TaskPackageGallery GALLERY_FILTERS。
 */
export const STAGE_BADGE_PHRASE: Record<StageRole, string> = {
  蓝图: '蓝图制定中',
  计划: '计划制定中',
  决策: '待拍板',
  执行: '执行中',
  交付: '待用户验收',
  待分类: '',
};

/**
 * 阶段徽标行（版本 + 阶段短语组合的唯一出口）：
 * 「v8 · 待用户验收」式一行；有版本无短语（待分类）→「v8」；有短语无版本 →「待拍板」；
 * 两者皆无 → 空串由 UI 降级，严禁假占位。taskPackages.packageBadgeLine 委托本函数。
 */
export function stageBadgeLine(
  stage: StageRole,
  versionNumber: number | null | undefined
): string {
  const phrase = STAGE_BADGE_PHRASE[stage] || '';
  const version = typeof versionNumber === 'number' ? versionNumber : null;
  if (version === null && !phrase) return '';
  if (version === null) return phrase;
  return phrase ? `v${version} · ${phrase}` : `v${version}`;
}

// ================= 文档态徽标 / 胶囊样式（服务端投影路径出口） =================

/**
 * 文档态徽标行：版本 + DOC_STATE_LABEL 组合（服务端 /state-overview 投影路径）。
 * 「v8 · 已交付」；无版本时仅词。与 stageBadgeLine 同形不同源：
 * 服务端六态词（DOC_STATE_LABEL）优先，阶段短语（STAGE_BADGE_PHRASE）仅断连回退。
 */
export function initiativeStateBadgeLine(
  state: DocState,
  versionNumber?: number | null
): string {
  const label = DOC_STATE_LABEL[state];
  const version = typeof versionNumber === 'number' ? versionNumber : null;
  if (version === null) return label;
  return `v${version} · ${label}`;
}

/**
 * 状态徽标胶囊公共排版骨架（唯一出口）：w-fit/截断/圆角/内距/微字号/行高/中字重
 * ——六态胶囊（DOC_STATE_PILL_CLASS）与橱窗卡阶段徽标胶囊
 * （TaskPackageGallery 的 STAGE_BADGE_PILL_CLASS，颜色与阴影件各配）同用本骨架，
 * 避免同族排版参数分叉。
 */
export const PILL_LAYOUT_BASE =
  'w-fit max-w-full truncate rounded-full px-2 py-0.5 ' +
  'text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium ';

/** 胶囊公共骨架（PILL_LAYOUT_BASE 的文档态别名，保既有内部引用） */
const DOC_STATE_PILL_BASE = PILL_LAYOUT_BASE;

/** 六态胶囊样式（stage-ink -text 深档保证浅底 AA；archived 走 --ink-soft 弱化） */
export const DOC_STATE_PILL_CLASS: Record<DocState, string> = {
  draft:
    DOC_STATE_PILL_BASE +
    'bg-[color:color-mix(in_srgb,var(--stage-ink-blueprint)_12%,transparent)] ' +
    'text-[color:var(--stage-ink-blueprint-text)]',
  pending_review:
    DOC_STATE_PILL_BASE +
    'bg-[color:color-mix(in_srgb,var(--stage-ink-decision)_12%,transparent)] ' +
    'text-[color:var(--stage-ink-decision-text)]',
  approved_revision:
    DOC_STATE_PILL_BASE +
    'bg-[color:color-mix(in_srgb,var(--stage-ink-plan)_12%,transparent)] ' +
    'text-[color:var(--stage-ink-plan-text)]',
  executing:
    DOC_STATE_PILL_BASE +
    'bg-[color:color-mix(in_srgb,var(--stage-ink-exec)_12%,transparent)] ' +
    'text-[color:var(--stage-ink-exec-text)]',
  delivered:
    DOC_STATE_PILL_BASE +
    'bg-[color:color-mix(in_srgb,var(--stage-ink-deliver)_12%,transparent)] ' +
    'text-[color:var(--stage-ink-deliver-text)]',
  archived:
    DOC_STATE_PILL_BASE +
    'bg-[color:color-mix(in_srgb,var(--ink-soft)_10%,transparent)] ' +
    'text-[color:var(--ink-soft)]',
};

/** 六态胶囊样式单一出口 */
export function docStatePillClass(state: DocState): string {
  return DOC_STATE_PILL_CLASS[state];
}

// ================= 双层投影（服务端优先 / 断连回退 dominantStage） =================

/** 服务端专项状态视图（/state-overview InitiativeStateView 的消费子集） */
export interface InitiativeStateServerView {
  state: DocState;
  current_stage: StageRole;
  pending_p0?: number;
  pending_p1?: number;
  pending_p2?: number;
}

/** 本地回退输入（dominantStage 产物；无服务端数据时的诚实降级） */
export interface InitiativeLocalFallback {
  stage: StageRole;
}

export interface InitiativeStateProjection {
  state: DocState;
  stage: StageRole;
  /** server=服务端 /state-overview 投影；fallback=dominantStage 回退（无服务端计数） */
  source: 'server' | 'fallback';
  /** 未决计数；fallback 路径为 null（本地无服务端口径，不造 0 冒充已对账） */
  pendingP0: number | null;
  pendingP1: number | null;
  pendingP2: number | null;
}

/**
 * 双层投影：服务端视图存在则逐字段采信；断连/未接线时按本地 dominantStage 回退
 * （阶段→六态走 STAGE_DOC_STATE，未决计数如实 null）。纯函数。
 */
export function projectInitiativeState(
  serverView: InitiativeStateServerView | null | undefined,
  localFallback: InitiativeLocalFallback
): InitiativeStateProjection {
  if (serverView) {
    return {
      state: serverView.state,
      stage: serverView.current_stage,
      source: 'server',
      pendingP0: typeof serverView.pending_p0 === 'number' ? serverView.pending_p0 : null,
      pendingP1: typeof serverView.pending_p1 === 'number' ? serverView.pending_p1 : null,
      pendingP2: typeof serverView.pending_p2 === 'number' ? serverView.pending_p2 : null,
    };
  }
  return {
    state: STAGE_DOC_STATE[localFallback.stage],
    stage: localFallback.stage,
    source: 'fallback',
    pendingP0: null,
    pendingP1: null,
    pendingP2: null,
  };
}

// ================= /state-overview 前端索引（四视图共享接线） =================

/**
 * /state-overview 的前端索引：一次构建，按 file_id / initiative_id / root_dir
 * 常数查——四视图（专项卡片 / 专项详情 / 星图节点 / 文档顶栏）共用同一份
 * App 级响应，不在各视图重复请求或重复扫数组。纯数据，不依赖 React。
 */
export interface StateOverviewIndex {
  overview: StateOverviewResponse;
  initiativesById: Map<string, InitiativeStateView>;
  initiativesByRootDir: Map<string, InitiativeStateView>;
  artifactsByFileId: Map<string, ArtifactStateView>;
}

/** 目录名归一：root_dir / 包 id 一律按 `/` 分段比较（Windows 反斜杠也收口） */
function normalizeOverviewDir(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** 空/缺省响应 → null（视图走既有阶段回退，不把「未接线」伪装成空投影） */
export function indexStateOverview(
  overview: StateOverviewResponse | null | undefined
): StateOverviewIndex | null {
  if (!overview) return null;
  const initiativesById = new Map<string, InitiativeStateView>();
  const initiativesByRootDir = new Map<string, InitiativeStateView>();
  for (const initiative of overview.initiatives ?? []) {
    initiativesById.set(initiative.initiative_id, initiative);
    const rootDir = normalizeOverviewDir(initiative.root_dir || '');
    if (rootDir) initiativesByRootDir.set(rootDir, initiative);
  }
  const artifactsByFileId = new Map<string, ArtifactStateView>();
  for (const artifact of overview.artifacts ?? []) {
    artifactsByFileId.set(artifact.file_id, artifact);
  }
  return { overview, initiativesById, initiativesByRootDir, artifactsByFileId };
}

/** 文档级六态行（星图节点 / 文档顶栏 / 检查器共用；无行 → null 走阶段回退） */
export function artifactStateOf(
  index: StateOverviewIndex | null | undefined,
  fileId: string | null | undefined
): ArtifactStateView | null {
  if (!index || !fileId) return null;
  return index.artifactsByFileId.get(fileId) ?? null;
}

/** 任务包定位所需的最小形状（TaskPackage 结构兼容；测试可传轻量对象） */
export interface PackageStateRef {
  id: string;
  docs: readonly { fileId: string }[];
}

/**
 * 专项行解析（专项卡片 / 专项详情共用）：
 *  ① 包内文档的 artifact 行全部指向同一 initiative_id → 直接采信；
 *  ② 否则按包 id 首段目录匹配 initiative.root_dir（G1/G3 包 id 首段即专项目录；
 *     多专项混包也走此兜底）；
 *  ③ 都不命中（output 域 / 根级散文件 / 首段无对应专项）→ null，视图回退 dominantStage。
 */
export function initiativeStateOfPackage(
  index: StateOverviewIndex | null | undefined,
  pkg: PackageStateRef
): InitiativeStateView | null {
  if (!index) return null;
  const artifactInitiativeIds = new Set<string>();
  for (const doc of pkg.docs) {
    const artifact = index.artifactsByFileId.get(doc.fileId);
    if (artifact?.initiative_id) artifactInitiativeIds.add(artifact.initiative_id);
  }
  if (artifactInitiativeIds.size === 1) {
    const [initiativeId] = artifactInitiativeIds;
    const row = index.initiativesById.get(initiativeId);
    if (row) return row;
  }
  const firstSegment = normalizeOverviewDir(pkg.id).split('/')[0] || '';
  if (!firstSegment || firstSegment === '__root__') return null;
  return index.initiativesByRootDir.get(firstSegment) ?? null;
}

/** 文档级双层投影结果（source 供 UI 诚实标注/降级） */
export interface ArtifactStateProjection {
  state: DocState;
  source: 'server' | 'fallback';
}

/**
 * 文档级双层投影：有服务端 artifact 行 → 采信六态；无 → 按本地阶段映射回退
 * （STAGE_DOC_STATE，与专项级回退同表）。视图可据 source 选择六态词或既有阶段词。
 */
export function projectArtifactState(
  artifact: ArtifactStateView | null | undefined,
  fallbackStage: StageRole
): ArtifactStateProjection {
  if (artifact) return { state: artifact.state, source: 'server' };
  return { state: STAGE_DOC_STATE[fallbackStage], source: 'fallback' };
}

// ================= 星图节点阶段回退词（GraphCanvasView 行 4 胶囊） =================

/**
 * 星图事件卡阶段胶囊词（原 GraphCanvasView.tsx:4184-4189 内联三元上移）：
 * 有所属阶段且非待分类 → 阶段词；待分类/无文件事件回退「决策」（卡本体即决策纸）；
 * 其余空串不渲染。
 */
export function artifactStageBadgeText(
  packageStage: string | null | undefined,
  isDecisionCard: boolean
): string {
  if (packageStage && packageStage !== '待分类') return packageStage;
  return isDecisionCard ? '决策' : '';
}

// ================= 五槽位任务节点词表（专项详情下拉数据源） =================

/**
 * task_node 状态词表（六态；suspended_on_hitl 是 HITL 挂起持久态，
 * 下拉/详情面高亮展示）。词表为 v1 裁定值；未知状态词原样返回（诚实透传，
 * 不造「未知」假词掩盖 wire 演进）。
 */
export const TASK_NODE_STATE_LABEL: Record<TaskNodeState, string> = {
  queued: '排队中',
  running: '进行中',
  completed: '已完成',
  suspended_on_hitl: '等待人工拍板',
  cancelled: '已取消',
  failed: '失败',
};

export function taskNodeStateLabel(state: string): string {
  return (TASK_NODE_STATE_LABEL as Record<string, string>)[state] ?? state;
}

// ================= 决策未决口径（DecisionRadar / HomeView 双份实现收敛） =================

/** 决策状态词（服务端 record_decision_events 口径逐字） */
export const DECISION_STATUS_PENDING = '待确认';
export const DECISION_STATUS_CONFLICT = '来源不一致';
export const DECISION_STATUS_CONFIRMED = '已确认';
export const DECISION_STATUS_REJECTED = '已否决';
export const DECISION_STATUS_SHELVED = '已搁置';
export const DECISION_STATUS_SUPERSEDED = '已取代';

/** 已定案状态集合（原 DecisionRadar.tsx:35 DECIDED_STATUSES 上移） */
export const DECIDED_DECISION_STATUSES: readonly string[] = [
  DECISION_STATUS_CONFIRMED,
  DECISION_STATUS_REJECTED,
  DECISION_STATUS_SHELVED,
  DECISION_STATUS_SUPERSEDED,
];

/** 未决状态集合：待确认 + 来源不一致（冲突） */
export const UNRESOLVED_DECISION_STATUSES: readonly string[] = [
  DECISION_STATUS_PENDING,
  DECISION_STATUS_CONFLICT,
];

/** 未决判定（候选决策 isCandidateOnly 只作线索，不计入任何分区/计数） */
export function isUnresolvedDecision(d: {
  status: string;
  isCandidateOnly?: boolean | null;
}): boolean {
  if (d.isCandidateOnly) return false;
  return UNRESOLVED_DECISION_STATUSES.includes(d.status);
}

/** 未决计数（DecisionRadar unresolvedCount 与 HomeView 卡 A decisionCount 的唯一出口） */
export function unresolvedDecisionCount<T extends { status: string; isCandidateOnly?: boolean | null }>(
  decisions: readonly T[]
): number {
  return decisions.filter(isUnresolvedDecision).length;
}

// ================= 版本「（最新）」后缀（ReaderView / RightInspector 收敛） =================

/** 版本链末版后缀词（统一全角括号；ReaderView 文件头/模式组/版本 select 与
 *  RightInspector 溯源区四处硬编码收敛到此） */
export const LATEST_REVISION_SUFFIX = '（最新）';

/** 「v8（最新）」式版本标签；非末版只有版本号 */
export function revisionVersionLabel(versionNumber: number, isLatest: boolean): string {
  return `v${versionNumber}${isLatest ? LATEST_REVISION_SUFFIX : ''}`;
}

// ================= 陈述状态 wire 词映射 =================

/**
 * wire 词 → 库内中文词（拍板表单/列表展示用；query 只传 wire 词，
 * 服务端按本表映射库内值——前端不自行翻译库内词）。
 */
export const STATEMENT_STATUS_LABEL: Record<StatementStatusWire, string> = {
  pending: DECISION_STATUS_PENDING,
  confirmed: DECISION_STATUS_CONFIRMED,
  rejected: DECISION_STATUS_REJECTED,
  shelved: DECISION_STATUS_SHELVED,
  superseded: DECISION_STATUS_SUPERSEDED,
};

// ================= 专项橱窗筛选词（TaskPackageGallery 上移） =================

export type GalleryFilterKey = 'all' | 'executing' | 'awaiting' | 'blueprint' | 'drawings';

/**
 * 橱窗筛选胶囊（原 TaskPackageGallery.tsx:38-44 GALLERY_FILTERS 上移统一）：
 * executing/awaiting 两个胶囊词直接取 STAGE_BADGE_PHRASE——筛选词与卡片徽标短语
 * 同源（消灭「执行中/待验收」与「执行中/待用户验收」的分叉）；
 * 全部专项/核心蓝图/图纸库不是阶段短语，保留既有词。
 * 判定语义不变：executing=pkg.stage==='执行'、awaiting=pkg.stage==='交付'
 * （matchesFilter 留在组件层，键与判定一一对应）。
 */
export const GALLERY_FILTERS: readonly { key: GalleryFilterKey; label: string }[] = [
  { key: 'all', label: '全部专项' },
  { key: 'executing', label: STAGE_BADGE_PHRASE['执行'] },
  { key: 'awaiting', label: STAGE_BADGE_PHRASE['交付'] },
  { key: 'blueprint', label: '核心蓝图' },
  { key: 'drawings', label: '图纸库' },
];
