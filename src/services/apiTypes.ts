/**
 * /api/v1 接口类型与端点路径常量
 *
 * 同源说明：与 `native/crates/guanlan-core/src/dto.rs`（Rust DTO）手工一一镜像，
 * 字段名逐字对齐 `native/docs/contract-query-api.md`：
 * - 主流 DTO 统一 snake_case：bootstrap、status、files 摘要；
 * - 事件时间范围与分页 wire 格式 1:1 保留：/events、/events/days、/events/range 的
 *   occurredMin/undatedCount 等 camelCase 键；
 * - 决定、关系、工作区配置沿用 `../types/guanlan.ts` 现有字段名。
 * 改任一侧（Rust DTO / 本文件）必须同步另一侧。
 *
 * 与 Rust 的映射约定：
 * - `Option<T>`（恒序列化，可为 null）→ `T | null`；
 * - `Option<T>` + skip_serializing_if（缺省不出现在 JSON）→ `?:`；
 * - `serde_json::Value` → `Record<string, unknown>` / `unknown`；
 * - `HashMap<String, u64>` → `Record<string, number>`。
 */

import type {
  DecisionAssertion as DecisionAssertionWire,
  DecisionSourceEvidence as DecisionSourceEvidenceWire,
  RelationEdge as RelationEdgeWire,
  WorkspaceConfig as WorkspaceConfigWire,
} from '../types/guanlan';

// ===== 通用共享结构（镜像 WorkspaceRecord / WorkspaceCounts / EventTimeRange）=====

/** 工作区行（WorkspaceRecord，server/WorkspaceStore.ts:39-46） */
export interface WorkspaceRecord {
  workspace_id: string;
  root_path: string;
  root_key: string;
  created_at: string;
  last_scan_at: string | null;
  index_generation: number;
}

/** 计数（store.counts，WorkspaceStore.ts:766-779；revisions/blobs 为全表口径） */
export interface WorkspaceCounts {
  files: number;
  revisions: number;
  events: number;
  blobs: number;
  statements: number;
  edges: number;
}

/** 事件时间范围（键为 camelCase，保留现状） */
export interface EventTimeRange {
  occurredMin: string | null;
  occurredMax: string | null;
  observedMin: string | null;
  observedMax: string | null;
  undatedCount: number;
}

// ===== 事件 =====

/** 事件查询窗口回显 */
export interface EventWindow {
  /** occurred（材料记载）| observed（采集） */
  order: 'occurred' | 'observed';
  from: string | null;
  to: string | null;
  kinds: string[];
  format: string | null;
  undated: boolean;
  q: string | null;
}

/** 事件行（EventPageItem，server/queries.ts:34-52） */
export interface EventPageItem {
  /** events.seq 全局单调，原样保留 */
  seq: number;
  event_id: string;
  kind: string;
  subject_kind: string;
  subject_id: string;
  revision_id: string | null;
  occurred_at: string | null;
  /** day | minute | second | unknown */
  occurred_precision: 'day' | 'minute' | 'second' | 'unknown';
  /** document_self | file_mtime | collector | manifest | git_commit | null */
  occurred_source: string | null;
  /** UTC ISO（含毫秒） */
  observed_at: string;
  headline: string;
  detail: string;
  payload: Record<string, unknown>;
  file_id: string | null;
  file_path: string | null;
  file_title: string | null;
  /** 工作区级事件为 null */
  format: string | null;
}

/** GET /api/v1/events（现有 EventPage wire 格式 1:1 保留，queries.ts:54-74） */
export interface EventPage {
  ok: boolean;
  index_generation: number;
  window: EventWindow;
  /** 游标绑定的窗口快照：新事件不进入已打开窗口 */
  snapshot_max_seq: number;
  items: EventPageItem[];
  /** 末页为 null */
  next_cursor: string | null;
  has_more: boolean;
  /** 不含游标条件的窗口计数 */
  total_in_window: number;
  undated_count: number;
  /** 首屏后新增事件数，驱动「有新变化」提示 */
  newer_count: number;
}

/** 事件日桶样本行（EventDayItem，queries.ts:374-398） */
export interface EventDayItem {
  event_id: string;
  kind: string;
  headline: string;
  revision_id: string | null;
  file_id: string | null;
  file_path: string | null;
  file_title: string | null;
  file_role: string | null;
  format: string | null;
  occurred_at: string | null;
  occurred_precision: string;
  observed_at: string;
  /** document_self | file_mtime | collector | null */
  time_basis: string | null;
  /** raised | conflicted | confirmed | rejected | superseded | shelved | null */
  action: string | null;
  decision_id: string | null;
  code: string | null;
  status: string | null;
  ref_count: number;
  version_count: number;
  statement_count: number;
}

/** 事件日桶决策样本（queries.ts:514-541：code/status 取组内 MAX(seq) 行） */
export interface EventDayDecision {
  decision_id: string;
  code: string;
  status: string;
  count: number;
}

/** 事件日桶（EventDayGroup，queries.ts:402-410） */
export interface EventDayGroup {
  /** YYYY-MM-DD；''=日期待考，恒排最后 */
  date: string;
  count: number;
  by_kind: Record<string, number>;
  formats: Record<string, number>;
  decisions: EventDayDecision[];
  /** 桶内决定总数（去重 decision_id）；与 decisions.length 不等即被截断 */
  decision_total?: number;
  /** 决定样本是否被独立上限截断（可经 /events?from=to=该桶日期 继续读） */
  decisions_truncated?: boolean;
  samples: EventDayItem[];
}

/** GET /api/v1/events/days（EventDaysResult；无游标、无 snapshot 绑定） */
export interface EventDaysResult {
  ok: boolean;
  index_generation: number;
  order: 'occurred' | 'observed';
  /** day | week | month */
  granularity: 'day' | 'week' | 'month';
  from: string | null;
  to: string | null;
  groups: EventDayGroup[];
  total: number;
  /** 超 limit_days 折叠的更早桶数 */
  hidden_days: number;
  undated_count: number;
}

// ===== 文件 =====

/** 文件摘要（FileSummary：与 FileRecord 对齐的 snake_case DTO） */
export interface FileSummary {
  file_id: string;
  /** files.current_path */
  relative_path: string;
  title: string;
  format: string;
  folder: string;
  /** 事项/角色（files.role） */
  role: string;
  /** active | missing | trashed */
  status: 'active' | 'missing' | 'trashed';
  current_revision_id: string | null;
  revision_count: number;
  first_observed_at: string;
  last_observed_at: string;
  /** 最早版本发生时间（revisions 按 seq ASC 首条 occurred_at） */
  first_source_time: string | null;
  /** full_text | svg_text | pdf_page_text | filename_only | unindexed */
  coverage: string;
  /** 仅 PDF 下发（dto.rs Option+skip：非 PDF 不出现键，FileRecord.pdfStatus 的 undefined 口径） */
  pdf_status?: string;
  /** 当前版快照可用 */
  snapshot_available: boolean;
}

/** 侧栏筛选项计数 */
export interface FileFacets {
  folders: Record<string, number>;
  formats: Record<string, number>;
  matters: Record<string, number>;
}

/** GET /api/v1/files（文件摘要分页，排序 relative_path ASC） */
export interface FileSummaryPage {
  ok: boolean;
  index_generation: number;
  /** 游标绑定代际；续页时 != 当前代际 → CURSOR_STALE */
  snapshot_generation: number;
  items: FileSummary[];
  next_cursor: string | null;
  has_more: boolean;
  /** 与筛选同口径的计数 */
  total_matched: number;
  facets: FileFacets;
}

// ===== 版本链与版本内容 =====

/** 版本行（project.ts:454-466 字段逐字保留；不下发 snapshot_path） */
export interface RevisionSummary {
  revision_id: string;
  seq: number;
  prev_revision_id: string | null;
  content_hash: string;
  size_bytes: number;
  observed_at: string;
  occurred_at: string | null;
  occurred_precision: string;
  occurred_source: string | null;
  snapshot_available: boolean;
}

/** 版本链端点返回的文件头（project.ts:513-523） */
export interface FileHistoryHeader {
  file_id: string;
  current_path: string;
  title: string;
  format: string;
  role: string;
  status: 'active' | 'missing';
  first_observed_at: string;
  last_observed_at: string;
  last_revision_id: string | null;
}

/** GET /api/v1/files/{file_id}/revisions。
 *  events/statements/edges 仅在请求 include 相应值时出现（缺省不在 JSON 中）。 */
export interface FileRevisionsResponse {
  ok: boolean;
  index_generation: number;
  file: FileHistoryHeader;
  revisions: RevisionSummary[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  /** include=events（行形状见 workspaceClient.FileHistoryEvent） */
  events?: unknown[];
  /** include=statements */
  statements?: unknown[];
  /** include=edges */
  edges?: unknown[];
  /** include=aliases（历史与当前路径别名） */
  aliases?: string[];
}

/** /detail 版本行（阅读器兼容视图；镜像 dto.rs:349-377 FileRecordRevision）：
 *  FileRecord.revisions[] 的 camelCase 派生字段（types/guanlan.ts:46-70 同源），
 *  source_time/svgSource 等缺省不出现键（Option+skip 口径，见文件头映射约定）。 */
export interface FileRecordRevision {
  revision_id: string;
  file_id: string;
  versionNumber: number;
  content_sha256: string;
  observed_at: string;
  /** 文档内或目录声称的日期（occurred_at）；无记载不出现 */
  source_time?: string;
  sizeBytes: number;
  snapshotAvailable: boolean;
  isBaselineProtected: boolean;
  /** 仅 SVG 且快照可读时内联（≤256KiB，project.ts:124-139） */
  svgSource?: string;
  svgExtractedTexts?: string[];
  /** 来自 modified 事件 payload 的 changed_sections（dto.rs changedSectionsFromPrev） */
  changedSectionsFromPrev?: string[];
  summaryNote: string;
}

/** GET /api/v1/files/{file_id}/detail（阅读器兼容视图）：
 *  服务端只返回「文件头 + 当前版」（不内联正文，版本链走 /revisions 分页；
 *  附集合限额各 200 条）。应用内前端已改用 /revisions，本类型保留描述兼容 wire。 */
export interface FileDetailResponse {
  ok: boolean;
  index_generation: number;
  file: FileHistoryHeader;
  revisions: FileRecordRevision[];
  /** 附集合限额各 200 条（兼容保留）；行形状见 workspaceClient.FileHistoryEvent */
  events: unknown[];
  statements: unknown[];
  edges: unknown[];
}

/** GET /api/v1/revisions/{revision_id}/content：
 *  PDF raw=1 时 text 缺省、raw_url 指向自身；MD/SVG 时 text 有值。 */
export interface RevisionContentResponse {
  ok: boolean;
  format: string;
  revision_id: string;
  /** PDF：/api/v1/revisions/<id>/content?raw=1 */
  raw_url?: string;
  /** MD/SVG：utf-8 读快照 */
  text?: string;
}

// ===== 决定（字段名沿用 types/guanlan.ts 现有 wire 类型）=====

/** 决定来源证据（types/guanlan.ts:146-159，与 Rust DecisionSourceEvidence 同构镜像） */
export type DecisionSourceEvidence = DecisionSourceEvidenceWire;

/** 决定断言（结构 = types/guanlan.ts:161-183，与 Rust DecisionAssertion 同构镜像） */
export type DecisionAssertion = DecisionAssertionWire;

/** GET /api/v1/decisions */
export interface DecisionsResponse {
  ok: boolean;
  index_generation: number;
  snapshot_generation: number;
  items: DecisionAssertion[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  /** 全库活跃文件未决待拍板真实总数，不受分页截断 */
  unresolved_total?: number;
}

// ===== 关系（字段名沿用 types/guanlan.ts 现有 wire 类型）=====

/** 引用定位（types/guanlan.ts:198 内联形状，Rust 侧为 RelationLocator struct） */
export interface RelationLocator {
  startLine: number;
  endLine: number;
}

/** 引用边（RelationEdge，types/guanlan.ts:192-201，与 Rust RelationEdge 同构镜像） */
export type RelationEdge = RelationEdgeWire;

/** GET /api/v1/relations（全量文件引用边） */
export interface RelationsResponse {
  ok: boolean;
  index_generation: number;
  items: RelationEdge[];
}

// ===== 工作区配置（types/guanlan.ts:253-285 camelCase 保留）=====

/** 扫描枚举快照（types/guanlan.ts:262-271 内联形状，Rust 侧为 EnumSnapshot struct） */
export interface EnumSnapshot {
  date: string;
  mdCount: number;
  svgCount: number;
  pdfCount: number;
  totalCount: number;
  indexedSuccessCount: number;
  parseFailedCount: number;
  pdfUnindexedCount: number;
}

/** 快照配额（types/guanlan.ts:272-278 内联形状，Rust 侧为 Quota struct） */
export interface Quota {
  maxTotalMiB: number;
  usedTotalMiB: number;
  maxSingleBinaryMiB: number;
  protectedSnapshotsCount: number;
  evictedSnapshotsCount: number;
}

/** 运行状态（types/guanlan.ts:279-285 内联形状，Rust 侧为 RuntimeStatus struct） */
export interface RuntimeStatus {
  connectionMode: 'direct_stdio' | 'magpie_router';
  serviceState: 'monitoring' | 'reconciling' | 'disconnected';
  sseSeq: number;
  indexGeneration: number;
  activeAgents: string[];
  loopbackUrl: string;
}

/** 工作区配置投影（project.ts:274-310，与 Rust WorkspaceConfig 同构镜像） */
export type WorkspaceConfig = WorkspaceConfigWire;

// ===== 顶层响应 =====

/** GET /api/v1/bootstrap（在一个短读快照内生成；
 *  响应任何位置不出现 svgSource、markdownContent、revisions[]） */
export interface BootstrapResponse {
  ok: boolean;
  workspace: WorkspaceRecord;
  /** hasBaseline；空工作区为 false，前端按「尚未覆盖」渲染 */
  baseline: boolean;
  counts: WorkspaceCounts;
  /** camelCase 键保留现状 */
  time_range: EventTimeRange;
  /** 直接内嵌完整 EventDaysResult（含其自身 ok 字段） */
  event_days: EventDaysResult;
  /** 首页事件（无 cursor 入参） */
  events: EventPage;
  /** 首批文件摘要 */
  files: FileSummaryPage;
  /** active 文件总数 */
  files_total: number;
  /** 首批决定（前端首屏用于初始化 selectedDecisionId） */
  decisions: DecisionAssertion[];
  /** 全库活跃文件未决待拍板真实总数（与多项目工作台严格一致） */
  decisions_unresolved_total?: number;
  /** 关系总数；全量关系另走 /api/v1/relations */
  relations_total: number;
  config: WorkspaceConfig;
  /** 当前进行中的索引任务摘要列表 */
  index_jobs: unknown[];
  /** 当前处于可恢复态（missing / trashed）的 file_id 列表，供前端剪枝阅读进度时保留 */
  recoverable_file_ids?: string[];
}

// ===== 索引任务与运行状态 =====

/** POST /api/v1/index-jobs 的 202 响应（立即返回 202 + job_id） */
export interface IndexJobAccepted {
  ok: boolean;
  job_id: string;
  /** queued | running */
  state: string;
  /** 是否并入了已有任务（同工作区重复重扫合并） */
  merged: boolean;
  /** 受理时的索引代 */
  index_generation?: number;
}

/** 一轮对账的统计摘要 */
export interface IndexJobReport {
  scanned: number;
  new_files: number;
  new_revisions: number;
  unchanged: number;
  mtime_only: number;
  content_changed: number;
  appeared: number;
  missing: number;
  recovered: number;
  unstable_reads: number;
  events_inserted: number;
  events_skipped: number;
  statements_upserted: number;
  edges_upserted: number;
  snapshots_written: number;
  metadata_only_revisions?: number;
  ignored_paths?: number;
  generation: number;
  duration_ms: number;
}

/** GET /api/v1/jobs/{job_id}：状态、阶段、已发现/已处理、失败项、覆盖范围。
 *  kind 含外部四类（verify_all/changed_paths/l4a_summary/set_initiative_dirs）
 *  与内部类（decision_writeback/propose_revision/adopt_draft/archive_initiative/
 *  reopen_initiative/diff）；report 按 kind 分支（见 IndexJobKindReport）；result 见
 *  JobResultResponse（经 fetchJobResult 强类型读取）。JobState 恒四态——挂起语义只存在于
 *  task_nodes 层（suspended_on_hitl），不进入 /jobs 口径。 */
export interface IndexJobStatus {
  ok: boolean;
  job_id: string;
  /** verify_all | changed_paths | l4a_summary | set_initiative_dirs | 内部类… */
  kind: string;
  /** queued | running | completed | failed */
  state: string;
  /** queued | scanning | done | failed */
  phase: string;
  discovered: number;
  processed: number;
  failed_items: string[];
  index_generation?: number;
  last_scan_at?: string | null;
  error?: string | null;
  /** 按 kind 分支：扫描类=IndexJobReport；writeback/proposal/adopt/initiative 见各 JobReport* */
  report?: IndexJobKindReport | null;
  /** 业务载荷预览（弱类型）；强类型读取走 GET /jobs/{id}/result（fetchJobResult<R>） */
  result?: unknown;
}

/** GET /api/v1/status：实例信息 + 工作区摘要 + 进行中的任务。
 *  schema_version=2 起下发 watcher 与 l4a_progress；旧库或旧服务缺省时前端按可选字段降级，不造数据。 */
export interface WorkspaceStatusResponse {
  ok: boolean;
  instance_id: string;
  api_version: string;
  schema_version: number;
  workspace_id: string;
  root_path: string;
  data_dir: string;
  index_generation: number;
  last_scan_at: string | null;
  baseline: boolean;
  counts: WorkspaceCounts;
  time_range: EventTimeRange;
  index_coverage: {
    active_files: number;
    missing_files: number;
  };
  /** 进行中的索引任务（空数组表示没有在跑的任务） */
  active_jobs: IndexJobStatus[];
  /** 文件监听（watcher）状态（schema_version=2 起下发） */
  watcher?: StatusWatcher;
  /** L4A 结构化沉淀进度（0-100 整数，total=0 时恒 100） */
  l4a_progress?: L4aProgress;
}

// ===== 统一状态机投影（GET /api/v1/state-overview）=====
// 四视图唯一数据源：专项卡片 / 专项详情下拉 / 星图节点 / 文档顶栏的状态徽标
// 全部经 src/utils/stateProjection.ts 消费本节 wire DTO 投影。

/** 文档六态（Rust state_machine.rs DocState 逐字镜像；迁移规则见
 *  src/utils/stateProjection.ts nextDocState——双端改规则必须两侧同步） */
export type DocStateWire =
  | 'draft'
  | 'pending_review'
  | 'approved_revision'
  | 'executing'
  | 'delivered'
  | 'archived';

/** 六阶段（与 taskPackages.StageRole 同词表；Rust Stage 逐字镜像） */
export type StageWire = '蓝图' | '计划' | '决策' | '执行' | '交付' | '待分类';

/** 专项状态行 */
export interface InitiativeStateView {
  initiative_id: string;
  name: string;
  root_dir: string;
  current_stage: StageWire;
  state: DocStateWire;
  artifact_count: number;
  pending_p0: number;
  pending_p1: number;
  pending_p2: number;
  updated_at: string;
}

/** 文档/产出物状态行 */
export interface ArtifactStateView {
  file_id: string;
  /** 工作区级散文件为 null */
  initiative_id: string | null;
  current_path: string;
  title: string;
  stage: StageWire;
  state: DocStateWire;
  selected_revision_id: string | null;
  checklist_done: number;
  checklist_total: number;
  pending_p0: number;
  pending_p1: number;
  pending_p2: number;
  last_activity_at: string | null;
}

/** GET /api/v1/state-overview?initiative_id=（四视图唯一数据源） */
export interface StateOverviewResponse {
  ok: boolean;
  index_generation: number;
  generated_at: string;
  initiatives: InitiativeStateView[];
  artifacts: ArtifactStateView[];
}

// ===== 智能体上下文包（POST /api/v1/context）=====

/** 上下文入口意图（三入口：文档正文 / 专项详情 / 首页总览） */
export type ContextIntent = 'document' | 'initiative' | 'global';

/** 注入粒度（全文 / 仅大纲与结论 / 仅变更 Diff / 仅元数据路径 / 兼容仅决策） */
export type ContextGranularity =
  | 'full'
  | 'summary'
  | 'diff_only'
  | 'metadata_only'
  | 'decisions_only';

/** 导出形态（双模：Markdown 提示词清单 / MCP 载荷 / 两者都要） */
export type ContextExportMode = 'structured' | 'markdown' | 'both';

/** 引用定位（行段 / 整文件 / PDF 页 / SVG 提取文字） */
export interface ContextLocator {
  kind: 'lines' | 'file' | 'pdf_page' | 'svg_text';
  start?: number;
  end?: number;
  page?: number;
  fragment?: string;
}

export interface ContextRequestItem {
  file_id: string;
  revision_id?: string;
  granularity: ContextGranularity;
  locator?: ContextLocator;
}

/** POST /api/v1/context 请求体（items 缺省/空时由服务端按三入口默认规则组装） */
export interface ContextRequest {
  intent: ContextIntent;
  focus_file_id?: string;
  initiative_id?: string;
  items?: ContextRequestItem[];
  mode?: ContextExportMode;
  /** 默认 65536（推荐阈值 64k） */
  budget_tokens?: number;
}

/** 预填/已选清单条目 */
export interface ContextPresetItem {
  file_id: string;
  path: string;
  title: string;
  revision_id: string | null;
  seq: number | null;
  version_label: string | null;
  content_hash?: string | null;
  state: string;
  granularity: ContextGranularity;
  snapshot_available: boolean;
  est_chars?: number;
  est_tokens: number;
  /** 仅 mode 含 markdown 且 granularity=full 时内联（服务端 GUANLAN_RESPONSE_MAX_MIB 上限） */
  content?: string | null;
  /** 当前粒度脱敏渲染片段 */
  snippet?: string | null;
}

/** 上游规范引用片段 */
export interface ContextUpstreamSnippet {
  file_id: string;
  path: string;
  title: string;
  version_label: string | null;
  content_hash: string | null;
  relation_type: string;
  reason: string;
  snippet: string;
  est_chars: number;
  est_tokens: number;
}

/** 推荐挂载条目（reason ∈ 本文引用/同专项引用/命名关联，排序固定为
 *  同专项引用 > 跨专项引用 > 命名关联） */
export interface ContextRecommendedItem extends ContextPresetItem {
  reason: string;
}

/** Token 预算（双端共享公式 est_tokens=ceil(cjk*0.7+non_cjk_bytes/3.5)，阈值判定同源） */
export interface ContextTokenBudget {
  selected: number;
  est_chars?: number;
  est_tokens: number;
  threshold: number;
  over_threshold: boolean;
  /** 超阈值时建议降级为 summary 的 file_id 列表 */
  downgrade_suggestions: string[];
}

export interface ContextPendingDecision {
  decision_id: string;
  statement_id: string;
  code: string;
  priority: string;
  question: string;
  file_id: string;
  path: string;
  line_start: number;
}

export interface ContextConfirmedDecision {
  decision_id: string;
  decision_text: string;
  confirmer: string;
  effective_date: string | null;
}

/** 模式 B MCP 载荷（uri=guanlan://<path>，hash=sha256:<前16>） */
export interface ContextMcpPayload {
  protocol: 'guanlan-mcp/v1';
  session_checkpoint_id: string | null;
  workspace_root: string;
  initiative: { id: string; name: string; current_stage: string } | null;
  context_bundle: Array<{
    uri: string;
    granularity: string;
    version: string;
    hash: string;
  }>;
  allowed_mcp_tools: string[];
  guardrails: {
    block_write_on_unresolved_p0: boolean;
    require_version_bump: boolean;
  };
}

/** POST /api/v1/context 响应（markdown 仅 mode 含 markdown 时非 null，
 *  payload 仅 mode=structured/both 时非 null） */
export interface ContextResponse {
  ok: boolean;
  index_generation: number;
  intent: ContextIntent;
  workspace_root: string;
  initiative_id: string | null;
  preset: {
    items: ContextPresetItem[];
    recommended: ContextRecommendedItem[];
  };
  decisions: {
    pending: ContextPendingDecision[];
    confirmed: ContextConfirmedDecision[];
  };
  upstream_snippets?: ContextUpstreamSnippet[];
  token_budget: ContextTokenBudget;
  redacted_secrets_count?: number;
  markdown: string | null;
  payload: ContextMcpPayload | null;
}

/** 主流宿主 .mcp.json 自动配置（ZCode / Claude Code / Cursor） */
export type McpHostTarget = 'zcode' | 'claude_code' | 'cursor';

export interface McpHostConfigRequest {
  host: McpHostTarget;
  endpoint?: string;
  dry_run?: boolean;
  confirm?: boolean;
}

export interface McpHostConfigResponse {
  ok: boolean;
  host: McpHostTarget;
  target_relative_path: string;
  target_absolute_path: string;
  endpoint: string;
  merged_existing: boolean;
  written: boolean;
  config_json: string;
}

// ===== 陈述与拍板（GET /statements + POST /decisions/{id}/resolve）=====

/** 陈述状态 wire 词（query 传英文 wire 词，服务端映射库内中文词——
 *  pending→待确认、confirmed→已确认、rejected→已否决、shelved→已搁置、superseded→已取代；
 *  不传 = 全部） */
export type StatementStatusWire = 'pending' | 'confirmed' | 'rejected' | 'shelved' | 'superseded';

/** 拍板表单数据源（StatementDetailDTO）：options/recommendation/confirmer_hint
 *  自 detail_json；impact_blocked/impact_allowed 两字段保持分离（detail_json 键
 *  impactBlocked/impactAllowed）。既有 StatementRef（旧 wire）不受本 DTO 影响。 */
export interface StatementDetailDTO {
  statement_id: string;
  revision_id: string;
  code: string;
  question: string;
  /** 库内中文词：待确认 | 已确认 | 已否决 | 已搁置 | 已取代 */
  status: string;
  line_start: number;
  line_end: number;
  decision_id: string | null;
  options: string[] | null;
  recommendation: string | null;
  impact_blocked: string[] | null;
  impact_allowed: string[] | null;
  confirmer_hint: string | null;
}

/** GET /api/v1/statements?file_id=&status=&limit= */
export interface StatementsResponse {
  ok: boolean;
  index_generation: number;
  items: StatementDetailDTO[];
}

/** POST /api/v1/decisions/{statement_id}/resolve 请求体（effective_date=YYYY-MM-DD） */
export interface DecisionResolveRequest {
  decision: string;
  confirmer: string;
  role?: string;
  effective_scope?: string;
  effective_date?: string;
  note?: string;
}

/** 拍板受理（恒 202，端点永不 409——CAS 冲突走 job report） */
export interface DecisionResolveAccepted {
  ok: boolean;
  job_id: string;
  statement_id: string;
  decision_id: string;
}

// ===== 修订草案（/api/v1/revision-proposals 全链）=====

export interface RevisionProposalRequest {
  file_id: string;
  base_revision_id: string;
  content: string;
  note?: string;
  /** 本次修订依据的输入上下文内容哈希清单（采纳时写入 derived_from_context 边） */
  input_context_hashes?: string[];
  /** Agent 回执摘要 */
  receipt_summary?: string;
}

/** 提交受理（恒 202；conflict 为受理初判预览，权威结果在 job report.proposal） */
export interface RevisionProposalAccepted {
  ok: boolean;
  job_id: string;
  draft_id: string;
  conflict: boolean;
  /** 独立草案分支标签（`v(N+1)-agent-draft`） */
  draft_version_label?: string;
}

/** 草案列表项 */
export interface RevisionProposalRecord {
  draft_id: string;
  file_id: string;
  path: string;
  base_revision_id: string;
  proposed_content_hash: string;
  /** 独立草案分支标签（`v(N+1)-agent-draft`） */
  draft_version_label?: string;
  /** 本次修订依赖的输入上下文哈希清单 */
  input_context_hashes?: string[];
  /** Agent 回执摘要 */
  receipt_summary?: string | null;
  source: 'mcp' | 'agent';
  status: string;
  conflict: boolean;
  note: string | null;
  created_at: string;
}

/** GET /api/v1/revision-proposals/{draft_id}/content（草案多模态 Diff 审阅载荷） */
export interface RevisionProposalContentResponse {
  ok: boolean;
  index_generation: number;
  draft_id: string;
  file_id: string;
  path: string;
  format: string;
  draft_version_label: string;
  base_revision_id: string;
  base_content_hash: string;
  disk_content_hash: string;
  proposed_content_hash: string;
  source: 'mcp' | 'agent' | string;
  status: string;
  conflict: boolean;
  note: string | null;
  receipt_summary: string | null;
  input_context_hashes: string[];
  base_text: string | null;
  disk_text: string | null;
  proposed_text: string | null;
  truncated: boolean;
  created_at: string;
}

/** GET /api/v1/revision-proposals?status=&cursor=（分页） */
export interface RevisionProposalPage {
  ok: boolean;
  index_generation: number;
  items: RevisionProposalRecord[];
  next_cursor: string | null;
}

// ===== 长任务 DAG 与 Checkpoint =====

/** 五槽位任务节点状态（suspended_on_hitl 是节点持久态，不进 /jobs 口径） */
export type TaskNodeState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'suspended_on_hitl'
  | 'cancelled'
  | 'failed';

/** 节点类型（按阶段固定：蓝图/计划→derive、决策→await_decision、
 *  执行→generate、交付→deliver） */
export type TaskNodeKind = 'derive' | 'await_decision' | 'generate' | 'deliver';

/** GET /api/v1/initiatives/{initiative_id}/tasks */
export interface TaskNodeView {
  node_id: string;
  stage: StageWire;
  node_kind: TaskNodeKind;
  title: string;
  state: TaskNodeState;
  depends: string[];
  latest_checkpoint_id: string | null;
  error: string | null;
}

export interface InitiativeTasksResponse {
  ok: boolean;
  index_generation: number;
  nodes: TaskNodeView[];
}

/** Checkpoint 状态 */
export type CheckpointStatus = 'SUCCESS' | 'FAILED_RETRYABLE' | 'SUSPENDED_HITL';

/** POST /api/v1/checkpoints 请求体。
 *  node_id 缺省时服务端按 (initiative_id, stage) 反查唯一槽位推进：
 *  外部 agent 经 guanlan.commit_checkpoint 提交的载荷不含 node_id，反查是
 *  generate 槽唯一完成通道的必要语义。 */
export interface CheckpointCommitRequest {
  node_id?: string;
  initiative_id: string;
  stage: string;
  status: CheckpointStatus;
  input_context_hash: string;
  output_revision_id?: string;
  token_usage?: number;
  elapsed_ms?: number;
  note?: string;
}

/** 同步受理结果：201 成功；initiative/stage 校验失败 404 NOT_FOUND
 *  （checkpoint 不落库、node 不推进、无 job_id——受理与校验原子）；
 *  写线程积压 recv 超时 5s → 503 INDEX_BUSY。 */
export interface CheckpointCommitResult {
  ok: boolean;
  checkpoint_id: string;
  /** 提交后该节点状态；无匹配节点（或非 SUCCESS）为 null */
  node_state: string | null;
}

/** GET /api/v1/checkpoints（恢复时取节点最新 SUCCESS） */
export interface CheckpointRecord {
  checkpoint_id: string;
  node_id: string | null;
  initiative_id: string;
  stage: string;
  status: CheckpointStatus;
  input_context_hash: string;
  output_revision_id: string | null;
  token_usage: number | null;
  elapsed_ms: number | null;
  note: string | null;
  created_at: string;
}

export interface CheckpointsPage {
  ok: boolean;
  index_generation: number;
  items: CheckpointRecord[];
  next_cursor: string | null;
}

// ===== 归档与重开 =====

/** POST /api/v1/initiatives/{id}/archive|reopen 受理（写线程执行，
 *  report.warn='当前非已交付态' 见 JobReportInitiative） */
export interface InitiativeJobAccepted {
  ok: boolean;
  job_id: string;
}

// ===== 任务结果（/jobs/{id}/result 与 cancel）=====

/** 202 受理通用形状（adopt/dismiss/diff 等只回 job_id 的端点） */
export interface JobAccepted {
  ok: boolean;
  job_id: string;
}

/** POST /api/v1/jobs/{job_id}/cancel（queued 立即取消；running 协作式；
 *  已结束任务 → 409 CONFLICT） */
export interface JobCancelResult {
  ok: boolean;
  job_id: string;
  /** 取消受理后的当前态（queued 立即态变更；running 等写线程阶段间隙生效） */
  state: string;
}

/** CAS 乐观锁冲突明细（expected=受理时基线哈希，disk=落盘实测） */
export interface CasConflictDetail {
  expected_content_hash: string;
  disk_content_hash: string;
}

/** 拍板回写 report：CAS 失败时 error/failed_items 恒空——
 *  『处理拍板请求』本身成功（检测冲突并存草案），同时落 revision_drafts+proposal_raised */
export interface JobReportWriteback {
  cas_ok: boolean;
  file_changed: boolean;
  new_revision_id: string | null;
  decision_id?: string;
  elapsed_ms?: number;
  initiative_id?: string | null;
  remaining_pending_p0_p1?: number | null;
  unlocked_downstream?: boolean;
  initiative_state_after?: string | null;
  cas_conflict?: CasConflictDetail | null;
  draft_id?: string | null;
}

/** 批阅看板五态 + 失联未知 */
export type ReviewBoardBucket =
  | 'pending_decision'
  | 'dispatchable'
  | 'agent_running'
  | 'awaiting_receipt'
  | 'completed'
  | 'unknown';

export interface ReviewBoardCounts {
  pending_decision: number;
  dispatchable: number;
  agent_running: number;
  awaiting_receipt: number;
  completed: number;
  unknown: number;
  total: number;
}

export interface ReviewBoardPendingStatement {
  statement_id: string;
  decision_id: string | null;
  code: string;
  priority: string;
  question: string;
  file_id: string;
  path: string;
  line_start: number;
}

export interface ReviewBoardDraftBrief {
  draft_id: string;
  file_id: string;
  path: string;
  draft_version_label: string;
  conflict: boolean;
  receipt_summary: string | null;
  created_at: string;
}

export interface ReviewBoardSlotBrief {
  node_id: string;
  stage: string;
  node_kind: string;
  state: string;
  latest_checkpoint_id: string | null;
  latest_checkpoint_status: string | null;
  updated_at: string;
}

export type OrphanRepairAction = 'reset_to_dispatchable' | 'mark_suspended_hitl';

export interface OrphanDiagnostic {
  node_id: string;
  stage: string;
  reason: string;
  stalled_seconds: number;
  repair_actions: OrphanRepairAction[];
}

export interface ReviewBoardCard {
  initiative_id: string;
  name: string;
  root_dir: string;
  current_stage: string;
  doc_state: string;
  bucket: ReviewBoardBucket;
  bucket_label: string;
  bucket_reason: string;
  artifact_count: number;
  pending_p0: number;
  pending_p1: number;
  pending_p2: number;
  pending_proposals: number;
  pending_statements: ReviewBoardPendingStatement[];
  proposed_drafts: ReviewBoardDraftBrief[];
  slots: ReviewBoardSlotBrief[];
  orphan: OrphanDiagnostic | null;
  updated_at: string;
}

export interface ReviewBoardResponse {
  ok: boolean;
  index_generation: number;
  generated_at: string;
  stall_threshold_secs: number;
  counts: ReviewBoardCounts;
  items: ReviewBoardCard[];
}

export interface OrphanRepairRequest {
  action: OrphanRepairAction;
  node_id?: string;
  note?: string;
}

export interface JobReportOrphanRepair {
  initiative_id: string;
  node_id: string;
  stage: string;
  action: OrphanRepairAction;
  new_node_state: string;
  new_board_bucket: ReviewBoardBucket;
  repaired_at: string;
}

/** 修订草案 report（cas_ok=false=agent-draft 分支，revision_drafts.conflict=1） */
export interface JobReportProposal {
  draft_id: string;
  cas_ok: boolean;
  /** 恒为 'proposed' */
  status: string;
  conflict: boolean;
  draft_version_label?: string;
  input_context_hashes?: string[];
  receipt_summary?: string | null;
}

/** 草案采纳 report（成功后写线程写入 derived_from_context 边并 recompute_slots） */
export interface JobReportAdopt {
  cas_ok: boolean;
  new_revision_id: string | null;
  cas_conflict: CasConflictDetail | null;
  draft_version_label?: string;
  derived_edges_written?: number;
}

/** 草案退回重做 report */
export interface JobReportDismiss {
  draft_id: string;
  status: string;
  reason?: string | null;
}

/** 归档/重开 report（非 Delivered 态归档时 warn='当前非已交付态'） */
export interface JobReportInitiative {
  action: 'archive' | 'reopen';
  state: string;
  warn?: string;
}

/** 各 kind 的 report 分支联合：扫描类沿用 IndexJobReport；
 *  diff/l4a 的业务载荷在 result，report 仍是扫描统计 + error 字段 */
export type IndexJobKindReport =
  | IndexJobReport
  | JobReportWriteback
  | JobReportProposal
  | JobReportAdopt
  | JobReportInitiative;

/** GET /api/v1/jobs/{job_id}/result（diff/l4a/writeback/initiative 有分支；
 *  分块大结果经 next_cursor 续页） */
export interface JobResultResponse<R = unknown> {
  ok: boolean;
  job_id: string;
  /** queued | running | completed | failed */
  state: string;
  kind: string;
  result: R | null;
  next_cursor: string | null;
}

// ===== 语义 Diff（POST /api/v1/diff 走任务队列）=====

export interface DiffJobRequest {
  file_id: string;
  baseline_revision_id: string;
  target_revision_id: string;
}

export interface DiffLineRow {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface DiffSection {
  title: string;
  baseline_start: number;
  target_start: number;
  lines: DiffLineRow[];
}

/** 摘要卡单指标（新增交付项 / 关闭未决事项 / 修改接口契约处数） */
export interface DiffSummaryMetric {
  label: string;
  count: number;
  sign: string;
}

/** GET /jobs/{id}/result kind=diff 的载荷（行级 LCS ≤2000 行预算，
 *  超限 truncated=true + 分块 cursor） */
export interface DiffResult {
  summary: {
    headline: string;
    items: DiffSummaryMetric[];
    checkpoint_id: string | null;
  };
  sections: DiffSection[];
  truncated: boolean;
  next_cursor: string | null;
}

// ===== L4A 摘要与运行状态扩展 =====

export interface L4aOutlineNode {
  level: number;
  title: string;
  line: number;
}

export interface L4aDecisionsDigest {
  confirmed: number;
  pending: number;
  p0: number;
  p1: number;
}

/** L4A 摘要体（确定性本地摘要，generated_by 固定为 local_deterministic） */
export interface FileL4aSummary {
  core_summary: string;
  outline: L4aOutlineNode[];
  decisions_digest: L4aDecisionsDigest;
  generated_by: 'local_deterministic';
  extract_rule_version: string;
}

/** GET /api/v1/summary/{file_id}（summary=null 且 queued=true 表示已入队未完成） */
export interface FileSummaryDetailResponse {
  ok: boolean;
  index_generation: number;
  file_id: string;
  revision_id: string;
  content_hash: string;
  summary: FileL4aSummary | null;
  queued: boolean;
}

/** watcher 状态（schema_version=2 起下发） */
export interface StatusWatcher {
  enabled: boolean;
  last_poll_at: string | null;
  changed_paths_pending: number;
  l4a_queue_depth: number;
}

/** L4A 沉淀进度（percent=0-100 整数，total=0 时恒 100） */
export interface L4aProgress {
  done: number;
  total: number;
  percent: number;
  /** queued+running（Rust L4aProgress 同源；归 0 即排空完成） */
  queue_depth?: number;
}

// ===== 身份保真文件操作 =====

export interface RenameFileRequest {
  new_name: string;
}

export interface MoveFileRequest {
  target_dir: string;
  new_name?: string;
}

export interface TrashFileRequest {
  confirm: boolean;
}

export interface FileMutationResponse {
  ok: boolean;
  operation: 'file_renamed' | 'file_moved' | 'file_trashed';
  file_id: string;
  old_path: string;
  new_path: string | null;
  title: string;
  role: string;
  status: 'active' | 'trashed';
  event_id: string;
  index_generation: number;
  trash_recoverable: boolean;
}

// ===== 本地快照存储占用与三档配额策略 =====

export interface SnapshotTierPolicy {
  text_max_bytes: number;
  binary_max_bytes: number;
  text_max_mib: number;
  binary_max_mib: number;
  metadata_only_classes: string[];
}

export interface FormatClassUsage {
  format_class: string;
  label: string;
  files_count: number;
  revisions_count: number;
  metadata_only_revisions: number;
  snapshot_bytes: number;
}

export interface StorageStatsResponse {
  ok: boolean;
  index_generation: number;
  workspace_id: string;
  data_dir_path: string;
  blobs_bytes: number;
  blobs_disk_bytes: number;
  blobs_count: number;
  db_bytes: number;
  total_disk_bytes: number;
  used_total_mib: number;
  active_files_count: number;
  revisions_total: number;
  full_snapshot_revisions: number;
  metadata_only_revisions: number;
  gitignore_respected: boolean;
  policy: SnapshotTierPolicy;
  by_class: FormatClassUsage[];
  by_format: Record<string, number>;
}

export interface UpdateStoragePolicyResponse {
  ok: boolean;
  workspace_id: string;
  policy: SnapshotTierPolicy;
}

// ===== QuickLook 轻预览（GET /api/v1/revisions/{revision_id}/preview）=====

export type RevisionPreviewKind =
  | 'image'
  | 'vector'
  | 'markdown'
  | 'code'
  | 'table'
  | 'text'
  | 'pdf'
  | 'office'
  | 'binary';

export interface OfficePreviewSummary {
  status: 'indexed' | 'encrypted' | 'corrupted' | 'metadata_only' | string;
  error_reason?: string;
  heading_count: number;
  paragraph_count: number;
  comment_count: number;
  tracked_insertions: number;
  tracked_deletions: number;
  sheet_count: number;
  sheet_names: string[];
  headings_preview: string[];
  text_preview: string;
}

export interface ImagePreviewMeta {
  width: number;
  height: number;
}

export interface RevisionPreviewHistoryItem {
  revision_id: string;
  seq: number;
  size_bytes: number;
  delta_bytes: number | null;
  content_hash: string;
  observed_at: string;
  occurred_at?: string | null;
  snapshot_available: boolean;
}

export interface RevisionPreviewResponse {
  ok: boolean;
  index_generation: number;
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  format: string;
  format_class: string;
  mime_type: string;
  preview_kind: RevisionPreviewKind;
  seq: number;
  revision_count: number;
  content_hash: string;
  size_bytes: number;
  size_min_bytes: number;
  size_max_bytes: number;
  observed_at: string;
  occurred_at?: string | null;
  snapshot_available: boolean;
  blob_missing: boolean;
  raw_url?: string;
  thumbnail_url?: string;
  text_slice?: string;
  slice_offset: number;
  slice_bytes: number;
  total_bytes: number;
  line_count: number;
  truncated: boolean;
  image_meta?: ImagePreviewMeta;
  magic_signature?: string;
  header_hex?: string;
  office_summary?: OfficePreviewSummary;
  pdf_summary?: PdfPreviewSummary;
  history: RevisionPreviewHistoryItem[];
}

// ===== Office（.docx / .xlsx）L2 结构化阅读（GET /api/v1/revisions/{revision_id}/office）=====

export interface DocxHeading {
  para_index: number;
  level: number;
  text: string;
}

export interface DocxParagraph {
  para_index: number;
  style?: string;
  heading_level?: number;
  text: string;
  is_table_row: boolean;
}

export interface DocxComment {
  id: string;
  author: string;
  date?: string;
  text: string;
  para_index?: number;
}

export interface DocxTrackedChanges {
  insertions: number;
  deletions: number;
  samples: string[];
}

export interface OfficeDocxData {
  headings: DocxHeading[];
  paragraphs: DocxParagraph[];
  comments: DocxComment[];
  tracked_changes: DocxTrackedChanges;
  total_paragraphs: number;
  truncated: boolean;
}

export interface XlsxNumericColSummary {
  col_letter: string;
  header: string;
  count: number;
  min: number;
  max: number;
  sum: number;
  cell_range: string;
}

export interface XlsxCell {
  ref_id: string;
  col_idx: number;
  value: string;
  is_numeric: boolean;
  formula?: string;
}

export interface XlsxRow {
  row_num: number;
  cells: XlsxCell[];
}

export interface XlsxSheetData {
  name: string;
  index: number;
  dimension_ref?: string;
  headers: string[];
  row_count: number;
  col_count: number;
  numeric_summaries: XlsxNumericColSummary[];
  rows: XlsxRow[];
  truncated: boolean;
}

export interface OfficeXlsxData {
  sheets: XlsxSheetData[];
  total_sheets: number;
  truncated: boolean;
}

export interface OfficeContentResponse {
  ok: boolean;
  index_generation: number;
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  format: string;
  seq: number;
  content_hash: string;
  size_bytes: number;
  snapshot_available: boolean;
  status: 'indexed' | 'encrypted' | 'corrupted' | 'metadata_only' | string;
  error_reason?: string;
  docx?: OfficeDocxData;
  xlsx?: OfficeXlsxData;
  plain_text: string;
}

// ===== PDF 页级正文阅读（GET /api/v1/revisions/{revision_id}/pdf）=====

export interface PdfPreviewSummary {
  status: 'page_indexed' | 'image_only' | 'ocr_pending' | 'extract_failed' | 'encrypted' | 'corrupted' | 'metadata_only' | string;
  error_reason?: string;
  page_count: number;
  text_page_count: number;
  image_only_page_count: number;
  extract_failed_page_count: number;
  headings_preview: string[];
  text_preview: string;
}

export interface PdfPageExtract {
  page_number: number;
  heading: string;
  extracted_text: string;
  /** text | mixed | image_only | extract_failed | empty */
  page_kind: string;
  image_count: number;
  char_count: number;
  visual_summary: string;
}

export interface PdfContentResponse {
  ok: boolean;
  index_generation: number;
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  format: string;
  seq: number;
  content_hash: string;
  size_bytes: number;
  snapshot_available: boolean;
  status: 'page_indexed' | 'image_only' | 'ocr_pending' | 'extract_failed' | 'encrypted' | 'corrupted' | 'metadata_only' | string;
  error_reason?: string;
  page_count: number;
  text_page_count: number;
  image_only_page_count: number;
  extract_failed_page_count: number;
  pages: PdfPageExtract[];
  plain_text: string;
}


// ===== 候选事项（多信号编织；采纳前绝不写正式归属）=====

export interface InitiativeCandidateMember {
  file_id: string;
  relative_path: string;
  title: string;
  /** 理由胶囊数组：[{signal, detail}]，signal ∈ dir_prefix|link|same_stem|session|agent_batch */
  signals: { signal: string; detail: string }[];
}

export interface InitiativeCandidateItem {
  candidate_id: string;
  title: string;
  /** 主理由胶囊（人话一句话） */
  reason_summary: string;
  /** 0x01 目录前缀 | 0x02 显式链接 | 0x04 同名主干 | 0x08 会话共现 | 0x10 Agent 批次 */
  signal_mask: number;
  /** 置信分 0-100 */
  score: number;
  /** candidate | adopted | dismissed */
  state: 'candidate' | 'adopted' | 'dismissed' | string;
  member_count: number;
  members: InitiativeCandidateMember[];
  updated_at: string;
}

export interface InitiativeCandidatesResponse {
  ok: boolean;
  index_generation: number;
  items: InitiativeCandidateItem[];
}

// ===== 有界检索（GET /api/v1/search；CommandPalette 消费）=====

/** 检索定位器（serde tag=kind，与 Rust dto.rs SearchLocator 逐字镜像；行号/页码 1-based） */
export type SearchLocatorDto =
  | { kind: 'lines'; start: number; end: number }
  | { kind: 'svg_text'; fragment: string }
  | { kind: 'pdf_page'; page: number }
  | { kind: 'office'; anchor: string }
  | { kind: 'file' };

/** 检索命中条（字段与 Rust dto.rs SearchHit 逐字镜像） */
export interface SearchHitDto {
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  format: string;
  /** full_text | svg_text | pdf_page_text | office_structured | filename_only | decision */
  coverage: string;
  /** exact_code | bigram_phrase_verified | single_char_bounded | filename_match */
  match_strategy: string;
  locator: SearchLocatorDto;
  snippet: string;
  score: number;
  stale: boolean;
  /** 命中来源工作区（仅挂载区命中携带；主区命中缺省） */
  source_workspace?: SearchHitSourceDto;
}

/** 挂载区命中的来源标注（工作区名 + 身份哈希） */
export interface SearchHitSourceDto {
  /** 参考区库内 workspace_id（ws_<root_key>） */
  workspace_id: string;
  /** 参考区库内 root_key（16 hex 身份哈希） */
  root_key: string;
  /** 展示名（参考区根路径末段） */
  name: string;
}

/** GET /api/v1/search 响应（无游标分页，单页 top N） */
export interface SearchResponseDto {
  ok: boolean;
  index_generation: number;
  query: string;
  /** code | single | phrase */
  mode: string;
  total_matched: number;
  items: SearchHitDto[];
  truncated: boolean;
  /** ready | building | absent——非 ready 时 items 恒空 */
  search_state: string;
}

// ===== 跨项目只读挂载与联合检索（与 Rust dto.rs 逐字镜像）=====

/** 挂载区命中的来源标注（工作区名 + 身份哈希；主区命中不带该字段） */
export interface SearchHitSourceDto {
  /** 参考区库内 workspace_id（ws_<root_key>） */
  workspace_id: string;
  /** 参考区库内 root_key（16 hex 身份哈希） */
  root_key: string;
  /** 展示名（参考区根路径末段） */
  name: string;
}

/** 挂载参考工作区条目（离线时 online=false，其余字段为最后已知摘要 + error） */
export interface MountedWorkspaceDto {
  /** m_<mount_key> */
  mount_id: string;
  /** plain() 规范化根路径的 sha256 前 16 hex（挂载身份命名空间，与 root_key 独立） */
  mount_key: string;
  /** 参考区库内 root_key（未被观澜索引/无摘要时为空串） */
  root_key: string;
  /** 规范化后的绝对路径（无 \\?\ 泄漏） */
  root_path: string;
  name: string;
  online: boolean;
  index_generation: number;
  /** ready | building | absent */
  search_state: string;
  file_count: number;
  /** 离线原因（online=true 时缺省） */
  error?: string;
  /** 最近一次成功在线观测时间 */
  last_seen_at?: string;
}

/** GET /api/v1/mounts 响应 */
export interface MountListResponseDto {
  ok: boolean;
  /** 主区索引代（0 = 服务尚无缓存代际） */
  index_generation: number;
  items: MountedWorkspaceDto[];
}

/** POST /api/v1/mounts 响应（同步受理） */
export interface MountAcceptedDto {
  ok: boolean;
  mount: MountedWorkspaceDto;
}

/** GET /api/v1/search/cross 响应（主区 + 全部在线挂载区联合检索） */
export interface CrossSearchResponseDto {
  ok: boolean;
  index_generation: number;
  query: string;
  mode: string;
  /** 各来源命中文件数之和（跨库不去重计数） */
  total_matched: number;
  items: SearchHitDto[];
  truncated: boolean;
  /** 主区检索索引状态（挂载区各自状态见 mounts[].search_state） */
  search_state: string;
  /** 全部挂载区状态（含离线降级） */
  mounts: MountedWorkspaceDto[];
}

// ===== 事项资料胶囊（Context Capsule）两阶段预览/导出/秒开核验 =====

export type CapsuleMode = 'with_snapshots' | 'manifest_only';

export interface CapsulePreviewRequest {
  initiative_id?: string | null;
  file_ids?: string[];
  from?: string | null;
  to?: string | null;
  mode: CapsuleMode;
  sanitize_secrets: boolean;
  excluded_dirs?: string[];
  selected_file_ids?: string[] | null;
}

export interface CapsuleExportRequest extends CapsulePreviewRequest {
  preview_token: string;
  confirmed_preview: boolean;
  output_dir?: string | null;
}

export interface CapsuleFilePreview {
  file_id: string;
  relative_path: string;
  dir_path: string;
  title: string;
  format: string;
  revision_id: string | null;
  seq: number;
  content_hash: string;
  size_bytes: number;
  snapshot_available: boolean;
  selected: boolean;
  sensitive_path: boolean;
  sensitive_reason: string | null;
  inline_secret_hits: number;
}

export interface CapsulePreviewResponse {
  ok: boolean;
  preview_token: string;
  mode: CapsuleMode;
  sanitize_secrets: boolean;
  title: string;
  initiative_id: string | null;
  from: string | null;
  to: string | null;
  selected_file_count: number;
  total_candidate_count: number;
  event_count: number;
  decision_count: number;
  relation_count: number;
  estimated_total_bytes: number;
  snapshot_bytes: number;
  metadata_bytes: number;
  sensitive_excluded_count: number;
  inline_redaction_count: number;
  sensitive_warnings: string[];
  dirs: string[];
  files: CapsuleFilePreview[];
}

export interface CapsuleManifestInitiative {
  initiative_id: string;
  name: string;
  dir_path: string;
  state: string;
}

export interface CapsuleManifestFile {
  file_id: string;
  relative_path: string;
  title: string;
  format: string;
  revision_id: string | null;
  seq: number;
  content_hash: string;
  size_bytes: number;
  snapshot_available: boolean;
  bundled_rel_path: string | null;
  bundled_sha256: string | null;
  redactions_applied: number;
}

export interface CapsuleManifestEvent {
  event_id: string;
  kind: string;
  subject_kind: string;
  subject_id: string;
  revision_id: string | null;
  relative_path: string | null;
  occurred_at: string | null;
  occurred_precision: string;
  observed_at: string;
  headline: string;
  detail: string;
}

export interface CapsuleManifestDecision {
  statement_id: string;
  decision_id: string | null;
  file_id: string;
  relative_path: string;
  revision_id: string;
  code: string;
  status: string;
  question: string;
  quote: string;
  line_start: number;
  line_end: number;
  observed_at: string;
}

export interface CapsuleManifestRelation {
  edge_id: string;
  source_file_id: string;
  source_path: string;
  target_file_id: string;
  target_path: string;
  kind: string;
  locator_start: number;
  locator_end: number;
  reason: string;
}

export interface CapsuleManifest {
  schema_version: string;
  capsule_id: string;
  exported_at: string;
  mode: CapsuleMode;
  sanitized: boolean;
  title: string;
  source_workspace_id: string;
  initiative: CapsuleManifestInitiative | null;
  from: string | null;
  to: string | null;
  files: CapsuleManifestFile[];
  events: CapsuleManifestEvent[];
  decisions: CapsuleManifestDecision[];
  relations: CapsuleManifestRelation[];
}

export interface CapsuleExportResponse {
  ok: boolean;
  capsule_id: string;
  mode: CapsuleMode;
  output_dir: string;
  manifest_path: string;
  timeline_md_path: string;
  decisions_md_path: string;
  index_html_path: string;
  files_exported: number;
  snapshots_written: number;
  metadata_only_count: number;
  event_count: number;
  decision_count: number;
  relation_count: number;
  redactions_applied: number;
  total_bytes: number;
}

export interface CapsuleInspectResponse {
  ok: boolean;
  capsule_dir: string;
  integrity_ok: boolean;
  checked_snapshots: number;
  integrity_issues: string[];
  manifest: CapsuleManifest;
}

export interface CapsuleFileContentResponse {
  ok: boolean;
  bundled_rel_path: string;
  size_bytes: number;
  truncated: boolean;
  text: string | null;
}

// ===== 全量开放导出、决定证据保护存储瘦身（GC）、全量 SHA-256 完整性核验与一键脱敏诊断 ZIP =====

export interface ImpactedRevisionRef {
  file_id: string;
  relative_path: string;
  revision_id: string;
  seq: number;
  observed_at: string;
}

export interface ImpactedDecisionRef {
  statement_id: string;
  code: string;
  status: string;
  question: string;
  relative_path: string;
  line_start: number;
}

export interface CorruptedBlobImpact {
  content_hash: string;
  issue_kind: 'missing' | 'hash_mismatch' | 'read_error' | string;
  detail: string;
  expected_bytes: number;
  actual_bytes: number | null;
  actual_hash: string | null;
  impacted_revisions: ImpactedRevisionRef[];
  impacted_decisions: ImpactedDecisionRef[];
  impacted_event_count: number;
}

export interface BlobIntegrityReport {
  ok: boolean;
  verified_at: string;
  checked_blobs: number;
  healthy_blobs: number;
  corrupted_count: number;
  missing_count: number;
  orphan_blob_count: number;
  orphan_blob_bytes: number;
  total_verified_bytes: number;
  impacts: CorruptedBlobImpact[];
}

export interface StorageGcRequest {
  older_than_days: number;
  keep_recent_per_file: number;
  remove_orphan_blobs: boolean;
  dry_run: boolean;
}

export interface GcPrunedRevisionSample {
  file_id: string;
  relative_path: string;
  revision_id: string;
  seq: number;
  observed_at: string;
  size_bytes: number;
  blob_shared_retained: boolean;
}

export interface StorageGcResponse {
  ok: boolean;
  dry_run: boolean;
  older_than_days: number;
  keep_recent_per_file: number;
  total_revisions_with_snapshot: number;
  protected_revisions_count: number;
  protected_decision_evidence_count: number;
  protected_edge_evidence_count: number;
  protected_governance_event_count: number;
  pruned_revisions_count: number;
  deleted_blobs_count: number;
  deleted_orphan_blobs_count: number;
  skipped_shared_blob_count: number;
  reclaimed_bytes: number;
  protected_bytes: number;
  pruned_samples: GcPrunedRevisionSample[];
}

export interface WorkspaceOpenExportRequest {
  include_snapshots: boolean;
  output_dir?: string | null;
}

export interface WorkspaceOpenExportResponse {
  ok: boolean;
  schema_version: string;
  output_dir: string;
  manifest_path: string;
  events_jsonl_path: string;
  decisions_md_path: string;
  timeline_md_path: string;
  files_count: number;
  revisions_count: number;
  events_count: number;
  decisions_count: number;
  edges_count: number;
  snapshots_exported: number;
  snapshots_missing: number;
  total_bytes: number;
}

export interface DiagnosticZipResponse {
  ok: boolean;
  zip_path: string;
  size_bytes: number;
  entries_count: number;
  redactions_applied: number;
  integrity_ok: boolean;
  ledger_ok: boolean;
  sandbox_ok: boolean;
}

// ===== 真实目录树（含空目录）、文件夹一等操作、新建文档、批量整理与挂载目录树浏览 =====

export interface FolderListResponseDto {
  ok: boolean;
  index_generation: number;
  folders: string[];
  truncated: boolean;
}

export interface FolderMutationResponseDto {
  ok: boolean;
  operation: 'folder_created' | 'folder_renamed' | 'folder_moved' | 'folder_trashed' | string;
  old_path?: string | null;
  new_path?: string | null;
  affected_files: number;
  affected_file_ids: string[];
  index_generation: number;
  trash_recoverable: boolean;
}

export interface CreateDocumentResponseDto {
  ok: boolean;
  file_id: string;
  relative_path: string;
  title: string;
  format: string;
  index_generation: number;
}

export interface BatchFileFailureDto {
  file_id: string;
  error: string;
}

export interface BatchFileMutationResponseDto {
  ok: boolean;
  operation: 'batch_moved' | 'batch_trashed' | string;
  succeeded: FileMutationResponse[];
  failed: BatchFileFailureDto[];
  index_generation: number;
}

export interface MountedFileEntryDto {
  file_id: string;
  relative_path: string;
  title: string;
  format: string;
  folder: string;
  current_revision_id: string;
  updated_at: string;
}

export interface MountedFilesResponseDto {
  ok: boolean;
  mount_id: string;
  name: string;
  root_path: string;
  online: boolean;
  total: number;
  truncated: boolean;
  folders: string[];
  items: MountedFileEntryDto[];
}

// ===== 多项目并存与跨项目总览（Quiet.md 多目录工作台模型）=====

export type ProjectRuntimeStatus = 'ready' | 'scanning' | 'offline' | 'root_in_use' | 'error' | string;

export interface ProjectEntryDto {
  project_id: string;
  name: string;
  root_path: string;
  readonly: boolean;
  is_active: boolean;
  status: ProjectRuntimeStatus;
  error?: string | null;
  file_count: number;
  folder_count: number;
  pending_decisions_count: number;
  index_generation: number;
  is_scanning: boolean;
  last_scan_at?: string | null;
  last_activity_at?: string | null;
  added_at: string;
  last_opened_at: string;
}

export interface ProjectListResponseDto {
  ok: boolean;
  active_project_id: string;
  projects: ProjectEntryDto[];
}

export interface ProjectMutationResponseDto {
  ok: boolean;
  active_project_id: string;
  project: ProjectEntryDto;
  projects: ProjectEntryDto[];
}

export interface ProjectTreeFileEntryDto {
  file_id: string;
  relative_path: string;
  title: string;
  format: string;
  folder: string;
  current_revision_id: string;
  updated_at: string;
  revision_count: number;
  pending_decisions: number;
}

export interface ProjectTreeResponseDto {
  ok: boolean;
  project_id: string;
  name: string;
  root_path: string;
  readonly: boolean;
  is_active: boolean;
  status: ProjectRuntimeStatus;
  total: number;
  truncated: boolean;
  folders: string[];
  files: ProjectTreeFileEntryDto[];
}

export interface CrossProjectDecisionItemDto {
  project_id: string;
  project_name: string;
  decision_id: string;
  code: string;
  question: string;
  status: string;
  file_id: string;
  relative_path: string;
  title: string;
  line_start: number;
  observed_at: string;
}

export interface CrossProjectRecentFileDto {
  project_id: string;
  project_name: string;
  file_id: string;
  relative_path: string;
  title: string;
  format: string;
  current_revision_id: string;
  observed_at: string;
}

export interface ProjectsOverviewResponseDto {
  ok: boolean;
  active_project_id: string;
  total_projects: number;
  online_projects: number;
  total_files: number;
  total_pending_decisions: number;
  projects: ProjectEntryDto[];
  pending_decisions: CrossProjectDecisionItemDto[];
  recent_files: CrossProjectRecentFileDto[];
}

export interface CrossProjectSearchHitDto {
  project_id: string;
  project_name: string;
  is_active: boolean;
  file_id: string;
  revision_id: string;
  relative_path: string;
  title: string;
  format: string;
  coverage: string;
  match_strategy: string;
  locator: SearchLocatorDto;
  snippet: string;
  score: number;
}

export interface CrossProjectSearchResponseDto {
  ok: boolean;
  query: string;
  total_hits: number;
  searched_projects: number;
  offline_projects: number;
  items: CrossProjectSearchHitDto[];
}

// ===== 存量工作区批量确立已读基线与撤销还原 =====

export interface ReadingStateEntryDto {
  file_id: string;
  last_read_revision_id: string;
  updated_at: string;
}

export interface ReadingStateListResponseDto {
  ok: boolean;
  index_generation: number;
  items: ReadingStateEntryDto[];
}

export interface ReadingStateUndoItemDto {
  file_id: string;
  previous_revision_id: string | null;
  previous_updated_at: string | null;
}

export interface ReadingStateBatchRequestDto {
  action: 'mark_baseline' | 'restore' | 'mark_read' | 'mark_unread';
  scope?: 'workspace' | 'folder';
  folder_prefix?: string;
  restore_items?: ReadingStateUndoItemDto[];
  file_ids?: string[];
  revision_id?: string;
}

export interface ReadingStateBatchResponseDto {
  ok: boolean;
  action: string;
  affected_count: number;
  updated_items: ReadingStateEntryDto[];
  undo_items: ReadingStateUndoItemDto[];
}


