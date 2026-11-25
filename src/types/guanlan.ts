/** 全文件格式小写扩展名 token（既有的 'md' | 'svg' | 'pdf' 逐字保留，
 *  其余格式如 'ts' | 'png' | 'docx' | 'xlsx' | 'mp4' | 'zip' | 'bin' ...）。 */
export type FileFormat = string;

export type ContentRole =
  | '需求'
  | '方案'
  | '说明'
  | '交接'
  | '报告'
  | '决策'
  | '素材'
  | '其他';

export type ClassificationProvenance = '来自路径' | '来自正文' | '待核对';

export type CoverageKind =
  | 'full_text'
  | 'svg_text'
  | 'pdf_page_text'
  | 'office_structured'
  | 'filename_only'
  | 'unindexed';

export type PdfIndexStatus =
  | 'unindexed' // 初始状态：正文尚未索引，只检索文件名和已知元数据
  | 'page_indexed' // 已按需抽取文本层，包含页码来源
  | 'extract_failed' // 无可用文本层或字符提取失败（中文提取失败不直接判定为扫描件）
  | 'ocr_optional' // 后续可选 OCR 识别文本
  | 'image_only' // 纯图像页（扫描件），诚实标记待 OCR，绝不假阳性
  | 'ocr_pending' // 存在扫描页待 OCR（后端状态码）
  | 'encrypted' // 加密文档，诚实降级
  | 'corrupted' // 结构损坏，诚实降级
  | 'metadata_only'; // 超出快照配额仅记身份与元数据

export interface MarkdownSection {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  startLine: number;
  endLine: number;
  isExplicitCallout?: '核心结论' | '需你决策' | '推荐及理由' | '影响与等待范围';
  summaryText?: string;
}

export interface Revision {
  revision_id: string;
  file_id: string;
  versionNumber: number;
  content_sha256: string;
  observed_at: string; // ISO string +08:00
  source_time?: string; // 文档内或目录声称的日期，如 "2026-11-04"
  commit_time?: string; // Git 提交时间（如有）
  author_hint?: string; // 默认未知，仅在有明确提交/日志证据时展示
  agent_turn_hint?: string; // 所属智能体轮次（仅在有可靠标记时存在）
  sizeBytes: number;
  snapshotAvailable: boolean; // 若超过配额被清理则为 false
  isBaselineProtected?: boolean; // 是否作为阅读基线或当前版本受保护
  markdownContent?: string;
  svgSource?: string;
  svgExtractedTexts?: string[];
  pdfPages?: {
    pageNumber: number;
    heading: string;
    extractedText: string;
    visualSummary: string;
  }[];
  changedSectionsFromPrev?: string[];
  summaryNote: string;
}

export interface FileRecord {
  file_id: string;
  relative_path: string;
  previous_paths?: string[];
  title: string;
  format: FileFormat;
  folder: string;
  role: ContentRole;
  roleProvenance: ClassificationProvenance;
  topics: { name: string; provenance: ClassificationProvenance; rule: string }[];
  current_revision_id: string;
  revisions: Revision[];
  coverage: CoverageKind;
  pdfStatus?: PdfIndexStatus;
  pdfStatusReason?: string;
  parseWarning?: string;
  brokenLinks?: string[];
}

export type TimelineEventKind =
  | 'discovered' // 首次扫描发现已有文件（不叫新建于今天）
  | 'appeared' // 监测期间出现此前不存在的路径
  | 'modified' // 稳定读取后，内容哈希与上版不同
  | 'missing' // 原路径确认不可访问或不存在
  | 'moved_or_copied' // 有足够证据区分移动或复制，或保留同哈希候选
  | 'file_renamed' // 身份保真重命名
  | 'file_moved' // 身份保真跨目录移动
  | 'file_trashed' // 移入系统回收站（可还原重连）
  | 'decision_changed' // 明确的决策来源版本发生变化
  | 'decision_raised' // 来源中出现新的待决问题（提出问题 / 来源不一致）
  | 'workspace_baseline' // 整个范围的首次纳入（一张折叠卡，不逐文件刷屏）
  | 'read_error' // 读取问题（不稳定读取或目录暂不可读），不判定缺失
  | 'read_recovered'; // 读取问题恢复

export interface TimelineEvent {
  event_id: string;
  kind: TimelineEventKind;
  file_id: string;
  revision_id: string;
  prev_revision_id?: string;
  observed_at: string; // UTC ISO（服务端 new Date().toISOString() 写入），展示前必须本地化
  /** 发生时间（材料记载时间；可为纯日期 'YYYY-MM-DD' 或含时刻 ISO）；无记载为空 */
  source_time?: string;
  /** 发生时间的依据：document_self / file_mtime / collector */
  occurred_source?: string | null;
  /** 发生时间的精度：day（仅日期）/ second / unknown */
  occurred_precision?: string | null;
  commit_time?: string;
  batch_id?: string;
  batch_title?: string; // 如一组相关修改 · 4 个文件
  topic_lane: string;
  task_code?: string;
  headline: string;
  detail: string;
  /** 事件关联文件的真实格式（决策事件由服务端从 payload 的 file_id 回填）；
   *  无法判定时为空——UI 落中性色，不再按扩展名猜成 md */
  format?: string | null;
  changedSections?: string[];
  /** 变更行数（payload.added_lines/removed_lines，服务端 reconcile 真实 diff 统计）。
   *  章节变更事件的 detail 不带「（+N/-M 行）」定式，画布摘要的 +/- 行数此前只能落空，
   *  事件表映射（TimelineView.pageItemToEvent）补齐后结构化直入；缺省为 undefined，
   *  摘要层回退解析 detail 定式，绝不编数 */
  addedLines?: number;
  removedLines?: number;
  isRollback?: boolean; // A -> B -> A 恢复旧内容事件
  sameHashCandidatePaths?: string[];
  decision_id?: string;
  /** 事件动作（服务端写进 payload.action）：decision_raised 的 raised/conflicted、
   *  decision_changed 的 confirmed/rejected/superseded/shelved——卡片用词与画布同源 */
  action?: string;
  /** 事件的时间依据（payload.time_basis）：document_self / file_mtime，用于「新出现」细分用词 */
  time_basis?: string | null;
}

export type DecisionStatus =
  | '待确认'
  | '已确认'
  | '已否决'
  | '已搁置'
  | '已取代'
  | '来源不一致'
  | '未知';

export interface OfficeEvidenceAnchor {
  kind: 'xlsx_range' | 'docx_paragraph';
  sheet?: string;
  cellRange?: string;
  paragraph?: number;
  heading?: string;
}

/** PDF 页码证据锚点（`path.pdf#page=N`，1-based 精确页码） */
export interface PdfEvidenceAnchor {
  kind: 'pdf_page';
  page: number;
  heading?: string;
  excerpt?: string;
}

export interface DecisionSourceEvidence {
  source_id: string;
  file_id: string;
  revision_id: string;
  relative_path: string;
  lineStart: number;
  lineEnd: number;
  observed_at: string;
  source_time?: string;
  claimedStatus: DecisionStatus;
  exactQuote: string;
  confirmer?: string;
  note: string;
  officeAnchor?: OfficeEvidenceAnchor;
  pdfAnchor?: PdfEvidenceAnchor;
}

export interface DecisionAssertion {
  decision_id: string; // 内部唯一标识，格式 dec_<hash>（由 server/derive 按命名空间+问题派生）
  code: string; // 现有编号
  namespace: string; // 所属项目/决策集，形如 "<项目名> / <决策集名>"
  question: string;
  status: DecisionStatus;
  isCandidateOnly: boolean; // 文档中“疑似决策”进入候选列表，不增加“待你确认”真实计数
  options: string[];
  recommendation: string; // 忠实保留原文限定，区分“推荐”与“批准”
  impactBlocked: string[]; // 哪些事项受影响等待
  impactAllowed: string[]; // 哪些基础核对/事项可以继续
  confirmationBasis?: {
    recordText: string;
    confirmer: string;
    confirmedAt: string;
    file_id: string;
    revision_id: string;
    lineRange: [number, number];
  };
  evidences: DecisionSourceEvidence[];
  conflictExplanation?: string;
  topic: string;
}

export type RelationType =
  | 'explicit_reference' // 引用：源文档确实存在可解析链接
  | 'derived_from_context' // 源自上下文：采纳智能体草案落版后记录的输入上下文因果边
  | 'revision_evolution' // 版本演进：同一文件 ID 的已捕获版本
  | 'decision_basis' // 决策依据：决策条目明确引用某材料
  | 'same_topic_or_code' // 同主题/同编号：仅作为分组关联，不表示依赖、因果或阻塞
  | 'inferred_candidate'; // 推断候选关系（虚线展示并写明原因，如同哈希候选或同名不同期）

export interface RelationEdge {
  edge_id: string;
  source_id: string; // file_id 或 decision_id
  target_id: string; // file_id 或 decision_id
  type: RelationType;
  isInferred: boolean; // true 时使用虚线绘制
  label: string;
  reason: string; // 明确证据位置或推断原因
  locator?: { startLine: number; endLine: number };
}

export interface ReadingState {
  file_id: string;
  last_read_revision_id?: string; // 已读基线版本（打开文件不自动标记整篇已读）
  last_section_id?: string;
  last_page_number?: number;
  scrollPercent: number;
  isFullyRead: boolean;
  bookmarked: boolean;
  personalNote?: string; // 仅属个人阅读状态，不改变工程决策状态
  updated_at: string;
  /** 仅由「一键确立已读基线」批量推进（未真实打开浏览过，不污染「继续阅读」与「最近浏览」） */
  baselineOnly?: boolean;
}

export interface EvidencePointer {
  file_id: string;
  revision_id: string;
  relative_path: string;
  content_sha256: string;
  locator:
    | { kind: 'lines'; start: number; end: number }
    | { kind: 'svg_text'; fragment: string }
    | { kind: 'pdf_page'; page: number }
    | { kind: 'file' };
  evidence_kind: 'explicit_source' | 'decision_record' | 'svg_label' | 'metadata_only';
  index_generation: number;
  observed_at: string;
  coverage: CoverageKind;
  stale: boolean;
  excerpt: string;
  note?: string;
  /** 上下文清单注入粒度（full / summary / diff_only / metadata_only / decisions_only；缺省 full） */
  granularity?: 'full' | 'summary' | 'diff_only' | 'metadata_only' | 'decisions_only';
  /** 当前版体量（Token 预算上界估算用；缺省按 0 估） */
  sizeBytes?: number;
}

export type McpToolName =
  | 'overview'
  | 'search'
  | 'read'
  | 'timeline'
  | 'diff'
  | 'decisions'
  | 'relations'
  | 'open_reader';

export type McpErrorCode =
  | 'OUT_OF_SCOPE'
  | 'NOT_FOUND'
  | 'REVISION_UNAVAILABLE'
  | 'INDEX_STALE'
  | 'ROOT_IN_USE'
  | 'UNSUPPORTED_CONTENT'
  | 'FILE_BUSY'
  /** 差异正文（基线或目标版）尚未取回：不能拿空串冒充空文档 */
  | 'CONTENT_NOT_LOADED'
  /** 差异规模超出预算被明确拒绝：返回错误而非空 diff 冒充成功 */
  | 'DIFF_TOO_LARGE';

export interface WorkspaceConfig {
  rootPath: string;
  rootKey: string;
  dataDirPath: string;
  excludedDirs: string[];
  disableGitIgnore: boolean;
  gitIgnoreWarning: string;
  enumSnapshot: {
    date: string;
    mdCount: number;
    svgCount: number;
    pdfCount: number;
    totalCount: number;
    indexedSuccessCount: number;
    parseFailedCount: number;
    pdfUnindexedCount: number;
  };
  quota: {
    maxTotalMiB: number;
    usedTotalMiB: number;
    maxSingleBinaryMiB: number;
    protectedSnapshotsCount: number;
    evictedSnapshotsCount: number;
  };
  runtimeStatus: {
    connectionMode: 'direct_stdio' | 'magpie_router';
    serviceState: 'monitoring' | 'reconciling' | 'disconnected';
    sseSeq: number;
    indexGeneration: number;
    activeAgents: string[];
    loopbackUrl: string;
  };
}
