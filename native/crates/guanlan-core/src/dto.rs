//! 各端点响应 DTO。
//!
//! 字段名与 native/docs/contract-query-api.md 逐字对齐：
//! - 新增 DTO 统一 snake_case（契约 §0.1）：bootstrap、status、files 摘要；
//! - 现有 wire 格式 1:1 保留（契约 §0.1）：`/events`、`/events/days`、
//!   `/events/range` 的 `occurredMin/undatedCount` 等键保持 camelCase；
//! - 决定、关系、工作区配置沿用 `src/types/guanlan.ts` 现有字段名
//!   （契约 §1.9/§1.10/§1.1），Rust 侧用 `#[serde(rename)]` 逐字段镜像。
//!
//! 前端镜像类型：`src/services/apiTypes.ts`（手工镜像，改任一侧必须同步另一侧）。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub use crate::index::office::{
    OfficeDocxData, OfficeEvidenceAnchor, OfficeExtractRecord, OfficeXlsxData,
};
pub use crate::index::pdf::{PdfEvidenceAnchor, PdfPageExtract};

/// 工作区行（契约 §1.1 workspace：WorkspaceRecord，`WorkspaceStore.ts:39-46`）
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceRecord {
    pub workspace_id: String,
    pub root_path: String,
    pub root_key: String,
    pub created_at: String,
    pub last_scan_at: Option<String>,
    pub index_generation: u64,
}

/// 计数（契约 §1.1/§1.2 counts：`store.counts`，`WorkspaceStore.ts:766-779`）。
/// 实现注意：revisions 与 blobs 是全表计数（无 WHERE），与旧 /api 输出一致
/// （contract-storage.md §1.4 既有口径）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkspaceCounts {
    pub files: u64,
    pub revisions: u64,
    pub events: u64,
    pub blobs: u64,
    pub statements: u64,
    pub edges: u64,
}

/// 事件时间范围（键为 camelCase，保留现状：契约 §1.1 time_range、§1.6；
/// wire 镜像 `workspaceClient.ts:202-209`）
#[derive(Debug, Clone, Default, Serialize)]
pub struct EventTimeRange {
    #[serde(rename = "occurredMin")]
    pub occurred_min: Option<String>,
    #[serde(rename = "occurredMax")]
    pub occurred_max: Option<String>,
    #[serde(rename = "observedMin")]
    pub observed_min: Option<String>,
    #[serde(rename = "observedMax")]
    pub observed_max: Option<String>,
    #[serde(rename = "undatedCount")]
    pub undated_count: u64,
}

/// 事件查询窗口回显（契约 §1.4 window）
#[derive(Debug, Clone, Serialize)]
pub struct EventWindow {
    /// occurred（材料记载）| observed（采集）
    pub order: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub kinds: Vec<String>,
    /// md | svg | pdf | null
    pub format: Option<String>,
    pub undated: bool,
    pub q: Option<String>,
}

/// 事件行（契约 §1.4 items：EventPageItem，`queries.ts:34-52`）
#[derive(Debug, Clone, Serialize)]
pub struct EventPageItem {
    /// events.seq 全局单调（contract-storage.md §2.6），原样保留
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub revision_id: Option<String>,
    pub occurred_at: Option<String>,
    /// day | minute | second | unknown
    pub occurred_precision: String,
    /// document_self | file_mtime | collector | manifest | git_commit | null
    pub occurred_source: Option<String>,
    /// UTC ISO（含毫秒，contract-storage.md §5.5）
    pub observed_at: String,
    pub headline: String,
    pub detail: String,
    /// appeared/modified 事件的 payload_json 字段集见 contract-storage.md §5.7
    pub payload: serde_json::Value,
    pub file_id: Option<String>,
    pub file_path: Option<String>,
    pub file_title: Option<String>,
    /// md | svg | pdf | null（工作区级事件为 null）
    pub format: Option<String>,
}

/// GET /api/v1/events（契约 §1.4：现有 EventPage wire 格式 1:1 保留）
#[derive(Debug, Clone, Serialize)]
pub struct EventPage {
    pub ok: bool,
    pub index_generation: u64,
    pub window: EventWindow,
    /// 游标绑定的窗口快照（契约 §0.3-1：新事件不进入已打开窗口）
    pub snapshot_max_seq: i64,
    pub items: Vec<EventPageItem>,
    /// 末页为 null（`queries.ts:246-255`）
    pub next_cursor: Option<String>,
    pub has_more: bool,
    /// 不含游标条件的窗口计数（`queries.ts:257-273`）
    pub total_in_window: u64,
    pub undated_count: u64,
    /// 首屏后新增事件数（`queries.ts:310`），驱动「有新变化」提示
    pub newer_count: u64,
}

/// 事件日桶样本行（契约 §1.5 samples：EventDayItem，`queries.ts:374-398`）
#[derive(Debug, Clone, Serialize)]
pub struct EventDayItem {
    pub event_id: String,
    pub kind: String,
    pub headline: String,
    pub revision_id: Option<String>,
    pub file_id: Option<String>,
    pub file_path: Option<String>,
    pub file_title: Option<String>,
    pub file_role: Option<String>,
    pub format: Option<String>,
    pub occurred_at: Option<String>,
    pub occurred_precision: String,
    pub observed_at: String,
    /// document_self | file_mtime | collector | null
    pub time_basis: Option<String>,
    /// raised | conflicted | confirmed | rejected | superseded | shelved | null
    pub action: Option<String>,
    pub decision_id: Option<String>,
    pub code: Option<String>,
    pub status: Option<String>,
    pub ref_count: u64,
    pub version_count: u64,
    pub statement_count: u64,
}

/// 事件日桶决策样本（契约 §1.5 decisions，`queries.ts:514-541`：code/status 取组内 MAX(seq) 行）
#[derive(Debug, Clone, Serialize)]
pub struct EventDayDecision {
    pub decision_id: String,
    pub code: String,
    pub status: String,
    pub count: u64,
}

/// 事件日桶（契约 §1.5 groups：EventDayGroup，`queries.ts:402-410`）
#[derive(Debug, Clone, Serialize)]
pub struct EventDayGroup {
    /// YYYY-MM-DD；""=日期待考，恒排最后（`queries.ts:628-639`）
    pub date: String,
    pub count: u64,
    pub by_kind: HashMap<String, u64>,
    pub formats: HashMap<String, u64>,
    /// 桶内决定样本（受独立上限约束，不再随桶内决定数无界增长）
    pub decisions: Vec<EventDayDecision>,
    /// 桶内决定总数（去重 decision_id 数；与 `decisions.len()` 不同即表示被截断）
    pub decision_total: u64,
    /// 决定样本是否被上限截断（true 时客户端可经 `/api/v1/events?from=to=该桶日期`
    /// 按有界分页继续读该桶的决定类事件）
    pub decisions_truncated: bool,
    pub samples: Vec<EventDayItem>,
}

/// GET /api/v1/events/days（契约 §1.5：EventDaysResult；本端点无游标、无 snapshot 绑定）
#[derive(Debug, Clone, Serialize)]
pub struct EventDaysResult {
    pub ok: bool,
    pub index_generation: u64,
    pub order: String,
    /// day | week | month
    pub granularity: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub groups: Vec<EventDayGroup>,
    pub total: u64,
    /// 超 limit_days 折叠的更早桶数（`queries.ts:636-637`）
    pub hidden_days: u64,
    pub undated_count: u64,
}

/// GET /api/v1/events/range（契约 §1.6：camelCase 保留现状 + index_generation）
#[derive(Debug, Clone, Serialize)]
pub struct EventTimeRangeResponse {
    pub ok: bool,
    #[serde(flatten)]
    pub range: EventTimeRange,
    pub index_generation: u64,
}

/// 文件摘要（契约 §1.3 FileSummary：与 FileRecord 对齐并 snake_case 化的新 DTO）
#[derive(Debug, Clone, Serialize)]
pub struct FileSummary {
    pub file_id: String,
    /// files.current_path（`WorkspaceStore.ts:51`）
    pub relative_path: String,
    /// files.title，回退 titleOf（`project.ts:56-59,192`）
    pub title: String,
    /// md | svg | pdf
    pub format: String,
    pub folder: String,
    /// 事项/角色（files.role）
    pub role: String,
    /// active | missing | trashed
    pub status: String,
    pub current_revision_id: Option<String>,
    pub revision_count: u64,
    pub first_observed_at: String,
    pub last_observed_at: String,
    /// 最早版本发生时间（revisions 按 seq ASC 首条 occurred_at；契约 §1.3 与 §5 风险 1）
    pub first_source_time: Option<String>,
    /// full_text | svg_text | pdf_page_text | filename_only | unindexed（`project.ts:180-187`）
    pub coverage: String,
    /// PDF 保持明确覆盖状态（`project.ts:201-205`）；非 PDF 不出现（FileRecord.pdfStatus
    /// 的 undefined 口径）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_status: Option<String>,
    /// 当前版快照可用（hasUnreadChanges 消费 current_revision_id/snapshotAvailable）
    pub snapshot_available: bool,
}

/// 侧栏筛选项计数（契约 §1.3 facets）
#[derive(Debug, Clone, Default, Serialize)]
pub struct FileFacets {
    pub folders: HashMap<String, u64>,
    pub formats: HashMap<String, u64>,
    pub matters: HashMap<String, u64>,
}

/// GET /api/v1/files（契约 §1.3：文件摘要分页，排序 relative_path ASC）
#[derive(Debug, Clone, Serialize)]
pub struct FileSummaryPage {
    pub ok: bool,
    pub index_generation: u64,
    /// 游标绑定代际；续页时 != 当前代际 → CURSOR_STALE（契约 §1.3）
    pub snapshot_generation: u64,
    pub items: Vec<FileSummary>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    /// 与筛选同口径的计数
    pub total_matched: u64,
    pub facets: FileFacets,
}

/// 版本行（契约 §1.7 revisions：`project.ts:454-466` 字段逐字保留）。
/// 不下发 snapshot_path：服务端绝对路径不进 UI（`project.ts:465` 注释）。
#[derive(Debug, Clone, Serialize)]
pub struct RevisionSummary {
    pub revision_id: String,
    pub seq: i64,
    pub prev_revision_id: Option<String>,
    pub content_hash: String,
    pub size_bytes: i64,
    pub observed_at: String,
    pub occurred_at: Option<String>,
    pub occurred_precision: String,
    pub occurred_source: Option<String>,
    pub snapshot_available: bool,
}

/// 版本链端点返回的文件头（契约 §1.7 file：`project.ts:513-523`）
#[derive(Debug, Clone, Serialize)]
pub struct FileHistoryHeader {
    pub file_id: String,
    pub current_path: String,
    pub title: String,
    pub format: String,
    pub role: String,
    pub status: String,
    pub first_observed_at: String,
    pub last_observed_at: String,
    pub last_revision_id: Option<String>,
}

/// 版本链附带的事件行（契约 §1.7 events：`project.ts:525-537` 字段逐字保留）
#[derive(Debug, Clone, Serialize)]
pub struct FileHistoryEvent {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub revision_id: Option<String>,
    pub occurred_at: Option<String>,
    pub occurred_precision: String,
    pub occurred_source: Option<String>,
    pub observed_at: String,
    pub headline: String,
    pub detail: String,
    pub payload: serde_json::Value,
}

/// 版本链附带的陈述行（契约 §1.7 statements：`project.ts:487-498` 字段逐字保留）
#[derive(Debug, Clone, Serialize)]
pub struct StatementRef {
    pub statement_id: String,
    pub revision_id: String,
    pub code: String,
    pub question: String,
    pub status: String,
    pub line_start: i64,
    pub line_end: i64,
    pub decision_id: Option<String>,
}

/// 版本链附带的引用边行（契约 §1.7 edges：`project.ts:500-510` 字段逐字保留）
#[derive(Debug, Clone, Serialize)]
pub struct EdgeRef {
    pub edge_id: String,
    pub source_revision_id: String,
    pub target_file_id: String,
    pub target_revision_id: Option<String>,
    pub resolution: String,
    pub locator_start: Option<i64>,
    pub reason: String,
}

/// GET /api/v1/files/{file_id}/revisions（契约 §1.7）。
/// events/statements/edges 仅在请求 include 相应值时下发（Option，缺省不出现于 JSON）。
#[derive(Debug, Clone, Serialize)]
pub struct FileRevisionsResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub file: FileHistoryHeader,
    pub revisions: Vec<RevisionSummary>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total: u64,
    /// include=events：`project.ts:473-485` 四路覆盖
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<FileHistoryEvent>>,
    /// include=statements：`project.ts:487-498`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statements: Option<Vec<StatementRef>>,
    /// include=edges：`project.ts:500-510`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edges: Option<Vec<EdgeRef>>,
    /// include=aliases：文件历史/当前路径别名列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

/// 阅读器兼容视图的版本行（契约 §1.7 末段：FileRecord.revisions[] 的 camelCase
/// 派生字段，`types/guanlan.ts:46-70` + `project.ts:132-172 toRevision`）。
/// 仅对 SVG 内联正文（与 `project.ts:136-139` 保持一致）。
#[derive(Debug, Clone, Serialize)]
pub struct FileRecordRevision {
    pub revision_id: String,
    pub file_id: String,
    #[serde(rename = "versionNumber")]
    pub version_number: i64,
    pub content_sha256: String,
    pub observed_at: String,
    /// 文档内或目录声称的日期（occurred_at）；无记载不出现
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_time: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "snapshotAvailable")]
    pub snapshot_available: bool,
    #[serde(rename = "isBaselineProtected")]
    pub is_baseline_protected: bool,
    /// 仅 SVG 且快照可读时内联（≤256KiB，`project.ts:124-139`）。
    /// wire 名 `svgSource`（契约 §0.1/§1.7：FileRecord.revisions 的 camelCase
    /// 派生字段 1:1 保留，`types/guanlan.ts:58`）。
    #[serde(rename = "svgSource", skip_serializing_if = "Option::is_none")]
    pub svg_source: Option<String>,
    #[serde(rename = "svgExtractedTexts", skip_serializing_if = "Option::is_none")]
    pub svg_extracted_texts: Option<Vec<String>>,
    /// 来自 modified 事件 payload 的 changed_sections（`project.ts:102-114`）
    #[serde(
        rename = "changedSectionsFromPrev",
        skip_serializing_if = "Option::is_none"
    )]
    pub changed_sections_from_prev: Option<Vec<String>>,
    #[serde(rename = "summaryNote")]
    pub summary_note: String,
}

/// GET /api/v1/files/{file_id}/detail（契约 §1.7 末段「阅读器兼容视图」）：
/// 同 §1.7 数据集（文件级非分页，events/statements/edges 一并带回）
/// + SVG 内联正文等 camelCase 派生字段。
#[derive(Debug, Clone, Serialize)]
pub struct FileDetailResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub file: FileHistoryHeader,
    pub revisions: Vec<FileRecordRevision>,
    pub events: Vec<FileHistoryEvent>,
    pub statements: Vec<StatementRef>,
    pub edges: Vec<EdgeRef>,
}

/// GET /api/v1/revisions/{revision_id}/content（契约 §1.8）。
/// 核心查询层只定位快照路径：text 留空，正文/原始字节由服务层按
/// [`RevisionContentResponse::snapshot_path`] 流式返回（不整读大文件）。
#[derive(Debug, Clone, Serialize)]
pub struct RevisionContentResponse {
    pub ok: bool,
    /// md | svg | pdf
    pub format: String,
    pub revision_id: String,
    /// PDF：`/api/v1/revisions/<id>/content?raw=1`（契约 §1.8）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_url: Option<String>,
    /// MD/SVG：utf-8 读快照（`project.ts:564-569`），由服务层按路径填充
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 快照文件绝对路径。仅供服务层流式读取，不序列化进 JSON
    /// （服务端绝对路径不进 UI，`project.ts:465` 注释同义）
    #[serde(skip_serializing)]
    pub snapshot_path: Option<std::path::PathBuf>,
    /// 内容哈希：服务层据此生成稳定 ETag；不进 wire（客户端用不到，
    /// 版本身份已由 revision_id 表达）
    #[serde(skip_serializing)]
    pub content_hash: String,
}

/// 决定断言（契约 §1.9 items：结构 = `types/guanlan.ts:161-183`）
#[derive(Debug, Clone, Serialize)]
pub struct DecisionAssertion {
    pub decision_id: String,
    pub code: String,
    pub namespace: String,
    pub question: String,
    pub status: String,
    #[serde(rename = "isCandidateOnly")]
    pub is_candidate_only: bool,
    pub options: Vec<String>,
    pub recommendation: String,
    #[serde(rename = "impactBlocked")]
    pub impact_blocked: Vec<String>,
    #[serde(rename = "impactAllowed")]
    pub impact_allowed: Vec<String>,
    /// 可选字段缺省不出现键（types/guanlan.ts:167 `confirmationBasis?` 的 undefined 口径，
    /// 与 pdf_status 的 skip 口径及 Node wire 省略键口径一致）
    #[serde(rename = "confirmationBasis", skip_serializing_if = "Option::is_none")]
    pub confirmation_basis: Option<DecisionConfirmationBasis>,
    pub evidences: Vec<DecisionSourceEvidence>,
    #[serde(
        rename = "conflictExplanation",
        skip_serializing_if = "Option::is_none"
    )]
    pub conflict_explanation: Option<String>,
    pub topic: String,
}

/// 确认依据（`types/guanlan.ts:150-157` 内联形状）
#[derive(Debug, Clone, Serialize)]
pub struct DecisionConfirmationBasis {
    #[serde(rename = "recordText")]
    pub record_text: String,
    pub confirmer: String,
    #[serde(rename = "confirmedAt")]
    pub confirmed_at: String,
    pub file_id: String,
    pub revision_id: String,
    /// [startLine, endLine]
    #[serde(rename = "lineRange")]
    pub line_range: (u64, u64),
}

/// 决定来源证据（`types/guanlan.ts:146-159`）
#[derive(Debug, Clone, Serialize)]
pub struct DecisionSourceEvidence {
    pub source_id: String,
    pub file_id: String,
    pub revision_id: String,
    pub relative_path: String,
    #[serde(rename = "lineStart")]
    pub line_start: u64,
    #[serde(rename = "lineEnd")]
    pub line_end: u64,
    pub observed_at: String,
    /// types/guanlan.ts:155 `source_time?`：缺省不出现键（Node wire project.ts:392 同为
    /// 有值才带；undefined 口径与 confirmer 一致）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_time: Option<String>,
    #[serde(rename = "claimedStatus")]
    pub claimed_status: String,
    #[serde(rename = "exactQuote")]
    pub exact_quote: String,
    /// types/guanlan.ts:155 `confirmer?`：缺省不出现键（undefined 口径，同上）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmer: Option<String>,
    pub note: String,
    #[serde(rename = "officeAnchor", skip_serializing_if = "Option::is_none")]
    pub office_anchor: Option<OfficeEvidenceAnchor>,
    #[serde(rename = "pdfAnchor", skip_serializing_if = "Option::is_none")]
    pub pdf_anchor: Option<PdfEvidenceAnchor>,
}

/// GET /api/v1/decisions（契约 §1.9）
#[derive(Debug, Clone, Serialize)]
pub struct DecisionsResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub snapshot_generation: u64,
    pub items: Vec<DecisionAssertion>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total: u64,
    /// 全库活跃文件未决待拍板总数（来源不一致 + 待确认），不受 limit=100 截断
    pub unresolved_total: u64,
}

/// 引用定位（`types/guanlan.ts:198` 内联形状）
#[derive(Debug, Clone, Serialize)]
pub struct RelationLocator {
    #[serde(rename = "startLine")]
    pub start_line: u64,
    #[serde(rename = "endLine")]
    pub end_line: u64,
}

/// 引用边（契约 §1.10 items：RelationEdge，`types/guanlan.ts:192-201`）
#[derive(Debug, Clone, Serialize)]
pub struct RelationEdge {
    pub edge_id: String,
    pub source_id: String,
    pub target_id: String,
    /// explicit_reference | revision_evolution | decision_basis | same_topic_or_code | inferred_candidate
    #[serde(rename = "type")]
    pub edge_type: String,
    /// true 时使用虚线绘制
    #[serde(rename = "isInferred")]
    pub is_inferred: bool,
    pub label: String,
    pub reason: String,
    /// types/guanlan.ts:198 `locator?`：缺省不出现键（Node wire project.ts:259-261
    /// `… : undefined`，undefined 口径与 confirmer 一致）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locator: Option<RelationLocator>,
}

/// GET /api/v1/relations（契约 §1.10：全量下发可落文件的 explicit_reference 边）
#[derive(Debug, Clone, Serialize)]
pub struct RelationsResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub items: Vec<RelationEdge>,
}

/// 扫描枚举快照（`types/guanlan.ts:262-271` 内联形状）
#[derive(Debug, Clone, Serialize)]
pub struct EnumSnapshot {
    pub date: String,
    #[serde(rename = "mdCount")]
    pub md_count: u64,
    #[serde(rename = "svgCount")]
    pub svg_count: u64,
    #[serde(rename = "pdfCount")]
    pub pdf_count: u64,
    #[serde(rename = "totalCount")]
    pub total_count: u64,
    #[serde(rename = "indexedSuccessCount")]
    pub indexed_success_count: u64,
    #[serde(rename = "parseFailedCount")]
    pub parse_failed_count: u64,
    #[serde(rename = "pdfUnindexedCount")]
    pub pdf_unindexed_count: u64,
}

/// 快照配额（`types/guanlan.ts:272-278` 内联形状）。
/// usedTotalMiB 是 toFixed(1) 后的一 位小数（project.ts:297），用 f64 承载。
#[derive(Debug, Clone, Serialize)]
pub struct Quota {
    #[serde(rename = "maxTotalMiB")]
    pub max_total_mib: u64,
    #[serde(rename = "usedTotalMiB")]
    pub used_total_mib: f64,
    #[serde(rename = "maxSingleBinaryMiB")]
    pub max_single_binary_mib: u64,
    #[serde(rename = "protectedSnapshotsCount")]
    pub protected_snapshots_count: u64,
    #[serde(rename = "evictedSnapshotsCount")]
    pub evicted_snapshots_count: u64,
}

/// 运行状态（`types/guanlan.ts:279-285` 内联形状）
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    /// direct_stdio | magpie_router
    #[serde(rename = "connectionMode")]
    pub connection_mode: String,
    /// monitoring | reconciling | disconnected
    #[serde(rename = "serviceState")]
    pub service_state: String,
    #[serde(rename = "sseSeq")]
    pub sse_seq: u64,
    #[serde(rename = "indexGeneration")]
    pub index_generation: u64,
    #[serde(rename = "activeAgents")]
    pub active_agents: Vec<String>,
    #[serde(rename = "loopbackUrl")]
    pub loopback_url: String,
}

/// 工作区配置投影（`project.ts:274-310` 的投影，契约 §1.1 config）
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceConfig {
    #[serde(rename = "rootPath")]
    pub root_path: String,
    #[serde(rename = "rootKey")]
    pub root_key: String,
    #[serde(rename = "dataDirPath")]
    pub data_dir_path: String,
    #[serde(rename = "excludedDirs")]
    pub excluded_dirs: Vec<String>,
    #[serde(rename = "disableGitIgnore")]
    pub disable_git_ignore: bool,
    #[serde(rename = "gitIgnoreWarning")]
    pub git_ignore_warning: String,
    #[serde(rename = "enumSnapshot")]
    pub enum_snapshot: EnumSnapshot,
    pub quota: Quota,
    #[serde(rename = "runtimeStatus")]
    pub runtime_status: RuntimeStatus,
}

/// GET /api/v1/bootstrap（契约 §1.1：一个短读快照内生成）。
/// 约束：响应中任何位置不出现 svgSource、markdownContent、revisions[]
/// （不含正文、完整版本链、全量关系、历史 SVG 原文）。
#[derive(Debug, Clone, Serialize)]
pub struct BootstrapResponse {
    pub ok: bool,
    pub workspace: WorkspaceRecord,
    /// hasBaseline（`WorkspaceStore.ts:374-379`）；空工作区为 false，前端按「尚未覆盖」渲染
    pub baseline: bool,
    pub counts: WorkspaceCounts,
    /// camelCase 键保留现状（契约 §1.1）
    pub time_range: EventTimeRange,
    /// 结构同 §1.5（契约直接内嵌完整 EventDaysResult，含其自身 ok 字段）
    pub event_days: EventDaysResult,
    /// 结构同 §1.4（首页事件，无 cursor 入参）
    pub events: EventPage,
    /// 结构同 §1.3（首批文件摘要）
    pub files: FileSummaryPage,
    /// active 文件总数（listFiles，`WorkspaceStore.ts:540-548`）
    pub files_total: u64,
    /// §1.9 首批（前端首屏要 selectedDecisionId，`App.tsx:336-338`）
    pub decisions: Vec<DecisionAssertion>,
    /// 全库活跃文件未决待拍板总数（与 MultiProjectOverviewStrip 同口径）
    pub decisions_unresolved_total: u64,
    /// 关系总数；全量关系走 §1.10
    pub relations_total: u64,
    pub config: WorkspaceConfig,
    /// 当前索引任务列表（契约 §1.1）
    pub index_jobs: Vec<serde_json::Value>,
    /// 当前处于可恢复态（missing / trashed）的 file_id 列表，供前端剪枝阅读进度时保留
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recoverable_file_ids: Vec<String>,
}

/// 索引覆盖（契约 §1.2：listFiles(active/missing)，`WorkspaceStore.ts:540-548`）
#[derive(Debug, Clone, Serialize)]
pub struct IndexCoverage {
    pub active_files: u64,
    pub missing_files: u64,
}

/// GET /api/v1/status（契约 §1.2：实例信息 + 工作区摘要）
#[derive(Debug, Clone, Serialize)]
pub struct StatusResponse {
    pub ok: bool,
    /// 服务实例身份（SSE 游标三元组之一）
    pub instance_id: String,
    pub api_version: String,
    /// 数据库 schema 版本（契约 §1.2）
    pub schema_version: u32,
    pub workspace_id: String,
    pub root_path: String,
    pub data_dir: String,
    pub index_generation: u64,
    pub last_scan_at: Option<String>,
    pub baseline: bool,
    pub counts: WorkspaceCounts,
    /// camelCase 键保留现状（契约 §1.1）
    pub time_range: EventTimeRange,
    pub index_coverage: IndexCoverage,
    /// 进行中的索引任务
    pub active_jobs: Vec<serde_json::Value>,
    /// 文件监听状态（watcher 未装配时 enabled=false）
    pub watcher: WatcherStatus,
    /// L4A 后台沉淀进度
    pub l4a_progress: L4aProgress,
}

/// watcher 状态段（enabled/last_poll_at/changed_paths_pending/l4a_queue_depth）
#[derive(Debug, Clone, Serialize)]
pub struct WatcherStatus {
    pub enabled: bool,
    pub last_poll_at: Option<String>,
    pub changed_paths_pending: u32,
    pub l4a_queue_depth: u32,
}

/// POST /api/v1/index-jobs 请求体（外部允许提交
/// verify_all|changed_paths|l4a_summary|set_initiative_dirs；内部 kind 直接提交返回 400）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct IndexJobRequest {
    /// 任务类型；缺省视为 `verify_all`
    #[serde(default)]
    pub kind: String,
    /// changed_paths 必填（≤2000 条）：增量对账的相对路径
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    /// set_initiative_dirs 必填（≤64 条）：写入 meta.initiative_dirs
    #[serde(default)]
    pub dirs: Option<Vec<String>>,
}

/// POST /api/v1/index-jobs 响应：202 + job_id（契约 §2）
#[derive(Debug, Clone, Serialize)]
pub struct IndexJobAccepted {
    pub ok: bool,
    pub job_id: String,
    /// 任务当前状态（queued / running）
    pub state: String,
    /// 是否并入了已有任务（同工作区重复重扫合并，契约 §2）
    pub merged: bool,
    /// 受理时的索引代（前端据此判断是否需要重新拉取）
    pub index_generation: Option<u64>,
}

/// 索引任务状态（契约 §2：状态、阶段、已发现/已处理、失败项、覆盖范围）
#[derive(Debug, Clone, Serialize)]
pub struct IndexJobStatusResponse {
    pub ok: bool,
    pub job_id: String,
    /// 任务类型（verify_all）
    pub kind: String,
    /// queued | running | completed | failed
    pub state: String,
    /// 当前阶段（scanning / done）
    pub phase: String,
    /// 已发现的文件数
    pub discovered: u64,
    /// 已处理的文件数
    pub processed: u64,
    /// 失败项（路径或原因）
    pub failed_items: Vec<String>,
    /// 本轮结束后的索引代
    pub index_generation: Option<u64>,
    /// 本轮结束后的最后扫描时间
    pub last_scan_at: Option<String>,
    /// 失败原因（state=failed 时有值）
    pub error: Option<String>,
    /// 本轮统计
    pub report: Option<IndexJobReport>,
    /// 各 kind 的结果分支（writeback/proposal/adopt/diff/l4a/initiative）
    pub result: Option<serde_json::Value>,
}

/// 一轮对账的统计摘要
#[derive(Debug, Clone, Serialize)]
pub struct IndexJobReport {
    pub scanned: u64,
    pub new_files: u64,
    pub new_revisions: u64,
    pub unchanged: u64,
    pub mtime_only: u64,
    pub content_changed: u64,
    pub appeared: u64,
    pub missing: u64,
    pub recovered: u64,
    pub unstable_reads: u64,
    pub events_inserted: u64,
    pub events_skipped: u64,
    pub statements_upserted: u64,
    pub edges_upserted: u64,
    pub snapshots_written: u64,
    /// 仅记元数据未写快照的版本数
    #[serde(default)]
    pub metadata_only_revisions: u64,
    /// 被 .gitignore 排除的路径数
    #[serde(default)]
    pub ignored_paths: u64,
    pub generation: u64,
    pub duration_ms: u64,
}

/// 专项级投影行（initiatives[]）
#[derive(Debug, Clone, Serialize)]
pub struct InitiativeOverview {
    pub initiative_id: String,
    pub name: String,
    pub root_dir: String,
    /// 蓝图 | 计划 | 决策 | 执行 | 交付 | 待分类
    pub current_stage: String,
    /// draft | pending_review | approved_revision | executing | delivered | archived
    pub state: String,
    pub artifact_count: u32,
    pub pending_p0: u32,
    pub pending_p1: u32,
    pub pending_p2: u32,
    pub updated_at: String,
}

/// 文档级投影行（artifacts[]）
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactOverview {
    pub file_id: String,
    pub initiative_id: Option<String>,
    pub current_path: String,
    pub title: String,
    pub stage: String,
    pub state: String,
    pub selected_revision_id: Option<String>,
    pub checklist_done: u32,
    pub checklist_total: u32,
    pub pending_p0: u32,
    pub pending_p1: u32,
    pub pending_p2: u32,
    pub last_activity_at: Option<String>,
}

/// GET /api/v1/state-overview 的投影集合（服务层补 ok / index_generation / generated_at）
#[derive(Debug, Clone, Default, Serialize)]
pub struct StateOverview {
    pub initiatives: Vec<InitiativeOverview>,
    pub artifacts: Vec<ArtifactOverview>,
}

/// GET /api/v1/state-overview 响应（四视图唯一数据源）
#[derive(Debug, Clone, Serialize)]
pub struct StateOverviewResponse {
    pub ok: bool,
    pub index_generation: u64,
    /// 投影生成时刻（ISO）
    pub generated_at: String,
    pub initiatives: Vec<InitiativeOverview>,
    pub artifacts: Vec<ArtifactOverview>,
}

/// GET /api/v1/statements 响应（拍板表单数据源）
#[derive(Debug, Clone, Serialize)]
pub struct StatementsResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub items: Vec<StatementDetail>,
}

/// 陈述详情（options/recommendation/confirmer_hint 自 detail_json 解析；
/// impact 拆分为 impact_blocked 与 impact_allowed 两字段，不合并）
#[derive(Debug, Clone, Serialize)]
pub struct StatementDetail {
    pub statement_id: String,
    pub revision_id: String,
    pub code: String,
    pub question: String,
    /// 库内状态词：待确认/已确认/已否决/已搁置/已取代/来源不一致/未知
    pub status: String,
    pub line_start: i64,
    pub line_end: i64,
    pub decision_id: Option<String>,
    pub options: Option<Vec<String>>,
    pub recommendation: Option<String>,
    pub impact_blocked: Option<Vec<String>>,
    pub impact_allowed: Option<Vec<String>>,
    pub confirmer_hint: Option<String>,
}

/// POST /api/v1/decisions/{statement_id}/resolve 响应（恒 202，端点永不返回 409）
#[derive(Debug, Clone, Serialize)]
pub struct ResolveAccepted {
    pub ok: bool,
    pub job_id: String,
    pub statement_id: String,
    pub decision_id: String,
}

/// POST /api/v1/revision-proposals 响应（恒 202；conflict 为受理初判预览）
#[derive(Debug, Clone, Serialize)]
pub struct ProposalAccepted {
    pub ok: bool,
    pub job_id: String,
    pub draft_id: String,
    pub conflict: bool,
    /// 独立草案分支版本标签（`v(N+1)-agent-draft`）
    pub draft_version_label: String,
}

/// 202 任务受理的通用形状（adopt/dismiss/archive/reopen/diff/cancel）
#[derive(Debug, Clone, Serialize)]
pub struct JobAccepted {
    pub ok: bool,
    pub job_id: String,
}

/// GET /api/v1/revision-proposals 响应（只读分页）
#[derive(Debug, Clone, Serialize)]
pub struct DraftsPage {
    pub ok: bool,
    pub index_generation: u64,
    pub items: Vec<DraftDetail>,
    pub next_cursor: Option<String>,
}

/// 修订草案列表项
#[derive(Debug, Clone, Serialize)]
pub struct DraftDetail {
    pub draft_id: String,
    pub file_id: String,
    pub path: String,
    pub base_revision_id: String,
    pub proposed_content_hash: String,
    /// 独立草案分支标签（`v(N+1)-agent-draft`）
    pub draft_version_label: String,
    /// 提交本次草案所依赖的输入上下文哈希清单
    pub input_context_hashes: Vec<String>,
    /// Agent 回执摘要
    pub receipt_summary: Option<String>,
    /// mcp | agent
    pub source: String,
    /// proposed | adopted | dismissed
    pub status: String,
    pub conflict: bool,
    pub note: Option<String>,
    pub created_at: String,
}

/// GET /api/v1/revision-proposals/{draft_id}/content 响应（多模态 Diff 审阅面）
#[derive(Debug, Clone, Serialize)]
pub struct DraftContentResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub draft_id: String,
    pub file_id: String,
    pub path: String,
    pub format: String,
    pub draft_version_label: String,
    pub base_revision_id: String,
    pub base_content_hash: String,
    pub disk_content_hash: String,
    pub proposed_content_hash: String,
    pub source: String,
    pub status: String,
    pub conflict: bool,
    pub note: Option<String>,
    pub receipt_summary: Option<String>,
    pub input_context_hashes: Vec<String>,
    /// 基准版本快照文本（超内联预算或快照不可用时为 null）
    pub base_text: Option<String>,
    /// 磁盘当前实时文本（冲突时用于与草案三方/双栏比对，绝不覆盖磁盘）
    pub disk_text: Option<String>,
    /// Agent 草案快照文本（超内联预算时为 null）
    pub proposed_text: Option<String>,
    /// 任一文本因超 2 MiB 预算未内联时为 true
    pub truncated: bool,
    pub created_at: String,
}

/// POST /api/v1/checkpoints 响应（同步 201）
#[derive(Debug, Clone, Serialize)]
pub struct CheckpointAccepted {
    pub ok: bool,
    pub checkpoint_id: String,
    /// 推进后的槽位节点状态（节点尚不存在时为 null）
    pub node_state: Option<String>,
}

/// GET /api/v1/checkpoints 响应（恢复时取节点最新 SUCCESS 记录）
#[derive(Debug, Clone, Serialize)]
pub struct CheckpointsPage {
    pub ok: bool,
    pub index_generation: u64,
    pub items: Vec<CheckpointDetail>,
    pub next_cursor: Option<String>,
}

/// checkpoint 列表项
#[derive(Debug, Clone, Serialize)]
pub struct CheckpointDetail {
    pub checkpoint_id: String,
    pub node_id: Option<String>,
    pub initiative_id: String,
    pub stage: String,
    pub status: String,
    pub input_context_hash: String,
    pub output_revision_id: Option<String>,
    /// 产出文档版本号（如 v2），由产出修订的 per-file seq 派生（与前端
    /// versionNumber 同源口径）；无产出修订时为 null。行存储保留
    /// output_revision_id，版本号在查询时派生。
    pub output_artifact_version: Option<String>,
    pub token_usage: Option<i64>,
    pub elapsed_ms: Option<i64>,
    pub note: Option<String>,
    pub created_at: String,
}

/// GET /api/v1/initiatives/{initiative_id}/resume-context 响应
/// （恢复上下文：最近 SUCCESS checkpoint + 增量变更 + 最新决策结果）。
#[derive(Debug, Clone, Serialize)]
pub struct ResumeContextResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub initiative_id: String,
    /// 最近一次 SUCCESS checkpoint（stage 过滤可选）；无成功快照时 null
    pub checkpoint: Option<ResumeCheckpoint>,
    /// 自 checkpoint.created_at 之后产生新版本的文件（每文件取最新一版）
    pub delta: Vec<ResumeDeltaFile>,
    /// 该专项最新决策结果（每 decision_id 取主陈述）
    pub latest_decisions: Vec<ResumeDecision>,
    /// 可直接注入外部 Agent 下一步 Prompt 的恢复上下文（仅增量 + 最新决策）
    pub prompt_context: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResumeCheckpoint {
    pub checkpoint_id: String,
    pub stage: String,
    pub output_revision_id: Option<String>,
    pub output_artifact_version: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResumeDeltaFile {
    pub file_id: String,
    pub path: String,
    pub title: String,
    pub revision_id: String,
    /// vN（revisions.seq 派生）
    pub version: String,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResumeDecision {
    pub decision_id: String,
    pub code: String,
    pub question: String,
    pub status: String,
    pub priority: String,
    pub quote: String,
    pub file_id: String,
    pub path: String,
    pub line_start: i64,
    pub line_end: i64,
}

/// GET /api/v1/initiatives/{initiative_id}/tasks 响应（五槽位 DAG）
#[derive(Debug, Clone, Serialize)]
pub struct TasksResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub nodes: Vec<TaskNodeDetail>,
}

/// 子任务节点列表项
#[derive(Debug, Clone, Serialize)]
pub struct TaskNodeDetail {
    pub node_id: String,
    pub stage: String,
    pub node_kind: String,
    pub title: String,
    pub state: String,
    pub depends: Vec<String>,
    pub latest_checkpoint_id: Option<String>,
    pub error: Option<String>,
}

/// GET /api/v1/summary/{file_id} 响应（L4A 确定性摘要）
#[derive(Debug, Clone, Serialize)]
pub struct FileSummaryResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub file_id: String,
    pub revision_id: Option<String>,
    pub content_hash: Option<String>,
    pub summary: Option<SummaryDetail>,
    /// 摘要仍在后台队列（queued/running）
    pub queued: bool,
}

/// 摘要体（generated_by 恒为 local_deterministic，纯本地确定性生成、无外部模型调用）
/// Deserialize：summary_json 落库后按行回读（query/longtasks.rs）
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct SummaryDetail {
    pub core_summary: String,
    pub outline: Vec<OutlineEntry>,
    pub decisions_digest: DecisionsDigest,
    pub generated_by: String,
    pub extract_rule_version: String,
}

/// 大纲条目（level=标题井号数）
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct OutlineEntry {
    pub level: u32,
    pub title: String,
    pub line: i64,
}

/// 决策摘要计数
#[derive(Debug, Clone, Default, serde::Deserialize, Serialize)]
pub struct DecisionsDigest {
    pub confirmed: u32,
    pub pending: u32,
    pub p0: u32,
    pub p1: u32,
}

/// L4A 队列进度（total=0 时 percent=100）
#[derive(Debug, Clone, Serialize)]
pub struct L4aProgress {
    pub done: u32,
    pub total: u32,
    pub percent: u32,
    /// queued+running（watcher 段 l4a_queue_depth 同源）
    pub queue_depth: u32,
}

/// POST /api/v1/context 响应（Token 预算感知上下文包）
#[derive(Debug, Clone, Serialize)]
pub struct ContextResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub intent: String,
    pub workspace_root: String,
    pub initiative_id: Option<String>,
    pub preset: ContextPreset,
    pub decisions: ContextDecisions,
    /// 上游规范/引用片段（随焦点/已选文档自动抽取，脱敏后随包交付）
    #[serde(default)]
    pub upstream_snippets: Vec<UpstreamReferenceSnippet>,
    pub token_budget: TokenBudget,
    /// 脱敏护栏拦截并替换的疑似密钥/敏感凭证计数（0 = 干净）
    #[serde(default)]
    pub redacted_secrets_count: u32,
    /// 仅 mode 包含 markdown 时填充
    pub markdown: Option<String>,
    /// 仅 mode 包含 structured 时填充
    pub payload: Option<serde_json::Value>,
}

/// 上游规范/关联引用片段（由星图 edges 自动溯源抽取，绝不含密钥）
#[derive(Debug, Clone, Serialize)]
pub struct UpstreamReferenceSnippet {
    pub file_id: String,
    pub path: String,
    pub title: String,
    pub version_label: Option<String>,
    pub content_hash: Option<String>,
    pub relation_type: String,
    pub reason: String,
    pub snippet: String,
    pub est_chars: u64,
    pub est_tokens: u64,
}

/// 预设清单 + 推荐挂载
#[derive(Debug, Clone, Serialize)]
pub struct ContextPreset {
    pub items: Vec<ContextItem>,
    /// 排序固定：同专项引用(3) > 跨专项引用(2) > 命名关联(1)
    pub recommended: Vec<RecommendedItem>,
}

/// 上下文条目（支持 full | summary | diff_only | metadata_only | decisions_only）
#[derive(Debug, Clone, Serialize)]
pub struct ContextItem {
    pub file_id: String,
    pub path: String,
    pub title: String,
    pub revision_id: Option<String>,
    pub seq: Option<i64>,
    /// 如 v1 / v3（"v"+seq）
    pub version_label: Option<String>,
    /// 真实内容哈希（SHA-256 十六进制，与草案 input_context_hashes 口径一致）
    #[serde(default)]
    pub content_hash: Option<String>,
    /// 文档级状态（artifact_states.state）
    pub state: String,
    /// full | summary | diff_only | metadata_only | decisions_only
    pub granularity: String,
    pub snapshot_available: bool,
    /// 当前粒度下估算字符数（用于实时字符/Token 预算）
    #[serde(default)]
    pub est_chars: u64,
    pub est_tokens: u64,
    pub content: Option<String>,
    /// 当前粒度渲染后的脱敏摘要/Diff/元数据片段（与 markdown 同源）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// 推荐挂载条目（同构 + reason）
#[derive(Debug, Clone, Serialize)]
pub struct RecommendedItem {
    #[serde(flatten)]
    pub item: ContextItem,
    /// 本文引用 | 同专项引用 | 命名关联
    pub reason: String,
}

/// 未决/已确认决策汇总
#[derive(Debug, Clone, Default, Serialize)]
pub struct ContextDecisions {
    pub pending: Vec<PendingDecision>,
    pub confirmed: Vec<ConfirmedDecision>,
}

/// 未决事项行
#[derive(Debug, Clone, Serialize)]
pub struct PendingDecision {
    pub decision_id: String,
    pub statement_id: String,
    pub code: String,
    /// P0 | P1 | P2（无证据按 P2）
    pub priority: String,
    pub question: String,
    pub file_id: String,
    pub path: String,
    pub line_start: i64,
}

/// 已确认决定行
#[derive(Debug, Clone, Serialize)]
pub struct ConfirmedDecision {
    pub decision_id: String,
    /// 已确认陈述的 quote（原文口径）
    pub decision_text: String,
    pub confirmer: Option<String>,
    pub effective_date: Option<String>,
}

/// Token 预算（前后端统一公式 est_tokens=ceil(cjk*0.7+non_cjk_bytes/3.5)）
#[derive(Debug, Clone, Serialize)]
pub struct TokenBudget {
    pub selected: u32,
    #[serde(default)]
    pub est_chars: u64,
    pub est_tokens: u64,
    pub threshold: u64,
    pub over_threshold: bool,
    /// 建议降级为 summary 的 file_id（全量条目按 est_tokens 降序）
    pub downgrade_suggestions: Vec<String>,
}

/// 身份保真文件操作响应（POST /api/v1/files/{file_id}/rename | /move | /trash）
#[derive(Debug, Clone, Serialize)]
pub struct FileMutationResponse {
    pub ok: bool,
    /// file_renamed | file_moved | file_trashed
    pub operation: String,
    pub file_id: String,
    pub old_path: String,
    pub new_path: Option<String>,
    pub title: String,
    pub role: String,
    /// active | trashed
    pub status: String,
    pub event_id: String,
    pub index_generation: u64,
    pub trash_recoverable: bool,
}

/// 三档快照配额策略
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotTierPolicyDto {
    pub text_max_bytes: i64,
    pub binary_max_bytes: i64,
    pub text_max_mib: u64,
    pub binary_max_mib: u64,
    /// 永远仅记元数据、绝不复制快照字节的格式族（audio / video / font / binary）
    pub metadata_only_classes: Vec<String>,
}

/// 按格式族统计的文件/版本/快照占用明细
#[derive(Debug, Clone, Serialize)]
pub struct FormatClassUsage {
    pub format_class: String,
    pub label: String,
    pub files_count: u64,
    pub revisions_count: u64,
    pub metadata_only_revisions: u64,
    pub snapshot_bytes: u64,
}

/// GET /api/v1/storage/stats 响应（真实本地快照磁盘占用与全格式分布）
#[derive(Debug, Clone, Serialize)]
pub struct StorageStatsResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub workspace_id: String,
    pub data_dir_path: String,
    /// blobs 表登记的去重快照字节总和
    pub blobs_bytes: u64,
    /// 磁盘 blobs/ 目录真实占用的字节总和
    pub blobs_disk_bytes: u64,
    /// 去重快照个数
    pub blobs_count: u64,
    /// index.db (+ wal/shm) 字节数
    pub db_bytes: u64,
    /// 本地数据目录总占用字节数（blobs_disk_bytes + db_bytes）
    pub total_disk_bytes: u64,
    /// 按 MiB 保留 2 位小数
    pub used_total_mib: f64,
    pub active_files_count: u64,
    pub revisions_total: u64,
    pub full_snapshot_revisions: u64,
    pub metadata_only_revisions: u64,
    pub gitignore_respected: bool,
    pub policy: SnapshotTierPolicyDto,
    pub by_class: Vec<FormatClassUsage>,
    pub by_format: HashMap<String, u64>,
}

/// POST /api/v1/storage/policy 响应（更新当前工作区快照阈值）
#[derive(Debug, Clone, Serialize)]
pub struct UpdateStoragePolicyResponse {
    pub ok: bool,
    pub workspace_id: String,
    pub policy: SnapshotTierPolicyDto,
}

/// 位图 / SVG 尺寸元数据（仅解析文件头前 ≤64KiB，零整图解码）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImagePreviewMeta {
    pub width: u32,
    pub height: u32,
}

/// 轻预览附带的同文件版本链体检摘要（大二进制文件体积演进与哈希历史）
#[derive(Debug, Clone, Serialize)]
pub struct RevisionPreviewHistoryItem {
    pub revision_id: String,
    pub seq: i64,
    pub size_bytes: i64,
    /// 相对上一版本（seq 前驱）的体积变化（字节）；首版为 None
    pub delta_bytes: Option<i64>,
    pub content_hash: String,
    pub observed_at: String,
    pub occurred_at: Option<String>,
    pub snapshot_available: bool,
}

/// GET /api/v1/revisions/{revision_id}/preview 响应（L1 轻预览）
#[derive(Debug, Clone, Serialize)]
pub struct RevisionPreviewResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub file_id: String,
    pub revision_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub format_class: String,
    pub mime_type: String,
    /// image | vector | markdown | code | table | text | pdf | binary
    pub preview_kind: String,
    pub seq: i64,
    pub revision_count: u64,
    pub content_hash: String,
    pub size_bytes: i64,
    pub size_min_bytes: i64,
    pub size_max_bytes: i64,
    pub observed_at: String,
    pub occurred_at: Option<String>,
    pub snapshot_available: bool,
    pub blob_missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_slice: Option<String>,
    pub slice_offset: u64,
    pub slice_bytes: u64,
    pub total_bytes: u64,
    pub line_count: u64,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_meta: Option<ImagePreviewMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magic_signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub office_summary: Option<OfficePreviewSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_summary: Option<PdfPreviewSummary>,
    pub history: Vec<RevisionPreviewHistoryItem>,
    /// 快照文件绝对路径：仅供服务层在异步阻塞池里按上限切片读取，不进 wire
    #[serde(skip_serializing)]
    pub snapshot_path: Option<std::path::PathBuf>,
}

/// QuickLook 轻预览卡附带的紧凑 Office 摘要
#[derive(Debug, Clone, Serialize)]
pub struct OfficePreviewSummary {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    pub heading_count: usize,
    pub paragraph_count: usize,
    pub comment_count: usize,
    pub tracked_insertions: usize,
    pub tracked_deletions: usize,
    pub sheet_count: usize,
    pub sheet_names: Vec<String>,
    pub headings_preview: Vec<String>,
    pub text_preview: String,
}

/// GET /api/v1/revisions/{revision_id}/office 响应（Office L2 结构化阅读）
#[derive(Debug, Clone, Serialize)]
pub struct OfficeContentResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub file_id: String,
    pub revision_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub seq: i64,
    pub content_hash: String,
    pub size_bytes: i64,
    pub snapshot_available: bool,
    /// indexed | encrypted | corrupted | metadata_only
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docx: Option<OfficeDocxData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xlsx: Option<OfficeXlsxData>,
    pub plain_text: String,
}

/// QuickLook 轻预览卡附带的紧凑 PDF 摘要
#[derive(Debug, Clone, Serialize)]
pub struct PdfPreviewSummary {
    /// page_indexed | image_only | ocr_pending | extract_failed | encrypted | corrupted | metadata_only
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    pub page_count: usize,
    pub text_page_count: usize,
    pub image_only_page_count: usize,
    pub extract_failed_page_count: usize,
    /// 前 8 页的页标题（heading）预览
    pub headings_preview: Vec<String>,
    pub text_preview: String,
}

/// GET /api/v1/revisions/{revision_id}/pdf 响应（PDF 页级文本阅读）
#[derive(Debug, Clone, Serialize)]
pub struct PdfContentResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub file_id: String,
    pub revision_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub seq: i64,
    pub content_hash: String,
    pub size_bytes: i64,
    pub snapshot_available: bool,
    /// page_indexed | image_only | ocr_pending | extract_failed | encrypted | corrupted | metadata_only
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    pub page_count: u64,
    pub text_page_count: u64,
    pub image_only_page_count: u64,
    pub extract_failed_page_count: u64,
    pub pages: Vec<PdfPageExtract>,
    pub plain_text: String,
}

/// 候选成员（含理由胶囊明细）
#[derive(Debug, Clone, Serialize)]
pub struct InitiativeCandidateMember {
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    /// 理由胶囊数组：
    pub signals: serde_json::Value,
}

/// 候选事项条目
#[derive(Debug, Clone, Serialize)]
pub struct InitiativeCandidateItem {
    pub candidate_id: String,
    pub title: String,
    /// 主理由胶囊（人话一句话）
    pub reason_summary: String,
    /// 信号位掩码：0x01 目录前缀 | 0x02 显式链接 | 0x04 同名主干 | 0x08 会话共现 | 0x10 Agent 批次
    pub signal_mask: u32,
    /// 置信分 0-100
    pub score: u32,
    /// candidate | adopted | dismissed
    pub state: String,
    pub member_count: u32,
    pub members: Vec<InitiativeCandidateMember>,
    pub updated_at: String,
}

/// GET /api/v1/initiative-candidates 响应
#[derive(Debug, Clone, Serialize)]
pub struct InitiativeCandidatesResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub items: Vec<InitiativeCandidateItem>,
}

/// 检索命中定位器（serde tag=kind；语义对齐前端 SearchHit.locator，
/// `guanlanEngine.ts:78-86`；行号/页码一律 1-based）
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchLocator {
    Lines { start: i64, end: i64 },
    SvgText { fragment: String },
    PdfPage { page: u64 },
    Office { anchor: String },
    File,
}

/// 检索命中条（字段对齐前端 SearchHit；matchStrategy 四态逐字沿用）
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub file_id: String,
    /// 命中所在版本（决定陈述命中为陈述产生版本，其余为文件当前版）
    pub revision_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    /// full_text | svg_text | pdf_page_text | office_structured | filename_only | decision
    pub coverage: String,
    /// exact_code | bigram_phrase_verified | single_char_bounded | filename_match
    pub match_strategy: String,
    pub locator: SearchLocator,
    /// 命中行原文（trim 后 ≤240 字符；决定陈述命中为 quote）
    pub snippet: String,
    /// 服务端排序分（title/path/content 权重和 + 命中方式加成；仅排序用）
    pub score: i64,
    /// 恒 false：服务端索引只命中最新的已入库版本（诚实语义占位）
    pub stale: bool,
    /// 命中来源工作区（仅挂载区命中携带；主区命中省略该字段，保持 `/search` wire 形状兼容）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_workspace: Option<SearchHitSource>,
}

/// 挂载区命中的来源标注（来源工作区名与身份哈希；root_key 为参考区库内
/// 工作区行身份，即其索引快照库的稳定哈希）
#[derive(Debug, Clone, Serialize)]
pub struct SearchHitSource {
    /// 参考区库内 workspace_id（`ws_<root_key>`）
    pub workspace_id: String,
    /// 参考区库内 root_key（16 hex 身份哈希）
    pub root_key: String,
    /// 展示名（参考区根路径末段）
    pub name: String,
}

/// GET /api/v1/search 响应（有界检索；无游标分页——单页取 top N）
#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub ok: bool,
    pub index_generation: u64,
    /// 归一化后的查询串（小写 + 空白折叠）
    pub query: String,
    /// code | single | phrase（Empty 查询在服务端被 400 拦截，不会出现在响应）
    pub mode: String,
    /// 命中文件去重数（含决定陈述命中的文件）
    pub total_matched: usize,
    pub items: Vec<SearchHit>,
    /// total_matched > items.len() 时为 true（有界截断诚实标记）
    pub truncated: bool,
    /// ready | building | absent——派生检索索引状态；非 ready 时 items 恒空
    pub search_state: String,
}

/// 挂载参考工作区条目（GET /api/v1/mounts 列表项 / POST /api/v1/mounts 返回体）。
/// 离线语义：参考区目录或索引库暂不可达时 `online=false`，其余字段为
/// **最后已知摘要**（绝不伪造在线数据），`error` 带人类可读原因。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MountedWorkspaceInfo {
    /// `m_<mount_key>`（挂载身份，规范化路径稳定哈希派生；重复挂载即重复 id）
    pub mount_id: String,
    /// 挂载身份哈希（plain() 规范化后的绝对路径 sha256 前 16 hex；与 root_key
    /// 命名空间独立——主区 root_key 口径不受影响）
    pub mount_key: String,
    /// 参考区库内 root_key（参考区被观澜索引过才有；离线且无最后已知时为空串）
    pub root_key: String,
    /// 规范化后的绝对路径（plain() 语义，无 `\\?\` 泄漏）
    pub root_path: String,
    /// 展示名（根路径末段）
    pub name: String,
    /// 当前是否在线（索引库可打开且可读）
    pub online: bool,
    /// 最后已知的参考区索引代（在线时现读）
    pub index_generation: u64,
    /// 最后已知的参考区检索索引状态（ready | building | absent）
    pub search_state: String,
    /// 最后已知的参考区 active 文件数
    pub file_count: u64,
    /// 离线原因（online=true 时为 None）
    pub error: Option<String>,
    /// 最近一次成功在线观测时间（ISO；离线摘要的时效标注）
    pub last_seen_at: Option<String>,
}

/// GET /api/v1/mounts 响应
#[derive(Debug, Clone, Serialize)]
pub struct MountListResponse {
    pub ok: bool,
    /// 主区索引代（0 = 服务尚无缓存代际，如启动后未执行任何查询）
    pub index_generation: u64,
    pub items: Vec<MountedWorkspaceInfo>,
}

/// POST /api/v1/mounts 响应（同步受理：校验 + 只读打开 + 现读摘要全部完成后返回）
#[derive(Debug, Clone, Serialize)]
pub struct MountAccepted {
    pub ok: bool,
    pub mount: MountedWorkspaceInfo,
}

/// GET /api/v1/search/cross 响应：主区 + 全部在线挂载区的联合检索。
/// 主区命中不携带 `source_workspace`；挂载区命中逐条携带来源工作区名与身份哈希。
#[derive(Debug, Clone, Serialize)]
pub struct CrossSearchResponse {
    pub ok: bool,
    /// 主区索引代
    pub index_generation: u64,
    pub query: String,
    /// 主区查询模式（code | single | phrase）
    pub mode: String,
    /// 各来源命中文件数之和（诚实口径：不做跨库去重计数）
    pub total_matched: usize,
    /// 合并后条目（score 降序；file_id 全局去重，同 id 主区优先）
    pub items: Vec<SearchHit>,
    /// 任一来源发生有界截断即为 true
    pub truncated: bool,
    /// 主区检索索引状态（挂载区各自状态见 mounts[].search_state）
    pub search_state: String,
    /// 全部挂载区状态（含离线：online=false + 最后已知摘要 + error）
    pub mounts: Vec<MountedWorkspaceInfo>,
}

/// 批阅看板五态 + 失联未知统计
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReviewBoardCounts {
    pub pending_decision: u32,
    pub dispatchable: u32,
    pub agent_running: u32,
    pub awaiting_receipt: u32,
    pub completed: u32,
    pub unknown: u32,
    pub total: u32,
}

/// 看板卡片上的待拍板语句（支持跳转原文或一键「已知悉」）
#[derive(Debug, Clone, Serialize)]
pub struct ReviewBoardPendingStatement {
    pub statement_id: String,
    pub decision_id: Option<String>,
    pub code: String,
    pub priority: String,
    pub question: String,
    pub file_id: String,
    pub path: String,
    pub line_start: i64,
}

/// 看板卡片上的待审 Agent 修订草案摘要
#[derive(Debug, Clone, Serialize)]
pub struct ReviewBoardDraftBrief {
    pub draft_id: String,
    pub file_id: String,
    pub path: String,
    pub draft_version_label: String,
    pub conflict: bool,
    pub receipt_summary: Option<String>,
    pub created_at: String,
}

/// 专项五槽位状态简报
#[derive(Debug, Clone, Serialize)]
pub struct ReviewBoardSlotBrief {
    pub node_id: String,
    pub stage: String,
    pub node_kind: String,
    pub state: String,
    pub latest_checkpoint_id: Option<String>,
    pub latest_checkpoint_status: Option<String>,
    pub updated_at: String,
}

/// 失联 / 无回执孤儿节点诊断（诚实标 unknown，附可执行的合法修复动作）
#[derive(Debug, Clone, Serialize)]
pub struct OrphanDiagnostic {
    pub node_id: String,
    pub stage: String,
    pub reason: String,
    pub stalled_seconds: i64,
    /// 允许的人工修复动作（绝不含隐式自动完结）：reset_to_dispatchable | mark_suspended_hitl
    pub repair_actions: Vec<String>,
}

/// 批阅看板单个事项卡
#[derive(Debug, Clone, Serialize)]
pub struct ReviewBoardCard {
    pub initiative_id: String,
    pub name: String,
    pub root_dir: String,
    pub current_stage: String,
    pub doc_state: String,
    /// pending_decision | dispatchable | agent_running | awaiting_receipt | completed | unknown
    pub bucket: String,
    pub bucket_label: String,
    pub bucket_reason: String,
    pub artifact_count: i64,
    pub pending_p0: i64,
    pub pending_p1: i64,
    pub pending_p2: i64,
    pub pending_proposals: u32,
    pub pending_statements: Vec<ReviewBoardPendingStatement>,
    pub proposed_drafts: Vec<ReviewBoardDraftBrief>,
    pub slots: Vec<ReviewBoardSlotBrief>,
    pub orphan: Option<OrphanDiagnostic>,
    pub updated_at: String,
}

/// GET /api/v1/review-board 响应
#[derive(Debug, Clone, Serialize)]
pub struct ReviewBoardResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub generated_at: String,
    pub stall_threshold_secs: i64,
    pub counts: ReviewBoardCounts,
    pub items: Vec<ReviewBoardCard>,
}

/// GET /api/v1/folders 响应（真实工作区目录清单，含空文件夹）
#[derive(Debug, Clone, Serialize)]
pub struct FolderListResponse {
    pub ok: bool,
    pub index_generation: u64,
    /// 相对工作区根的正斜杠路径列表（按字典序排列，不含根 `"."` 本身）
    pub folders: Vec<String>,
    pub truncated: bool,
}

/// 文件夹操作响应（POST /api/v1/folders | /rename | /move | /trash）
#[derive(Debug, Clone, Serialize)]
pub struct FolderMutationResponse {
    pub ok: bool,
    /// folder_created | folder_renamed | folder_moved | folder_trashed
    pub operation: String,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    /// 本次操作涉及并保持 file_id 连续（或移入回收站）的受管文件数
    pub affected_files: usize,
    pub affected_file_ids: Vec<String>,
    pub index_generation: u64,
    pub trash_recoverable: bool,
}

/// POST /api/v1/files/create 响应（在指定目录新建 Markdown 文档并立即入库）
#[derive(Debug, Clone, Serialize)]
pub struct CreateDocumentResponse {
    pub ok: bool,
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub index_generation: u64,
}

/// 批量文件操作中的单项失败明细
#[derive(Debug, Clone, Serialize)]
pub struct BatchFileFailure {
    pub file_id: String,
    pub error: String,
}

/// POST /api/v1/files/batch-move | /batch-trash 响应
#[derive(Debug, Clone, Serialize)]
pub struct BatchFileMutationResponse {
    pub ok: bool,
    /// batch_moved | batch_trashed
    pub operation: String,
    pub succeeded: Vec<FileMutationResponse>,
    pub failed: Vec<BatchFileFailure>,
    pub index_generation: u64,
}

/// GET /api/v1/mounts/{mount_id}/files 单个只读文件摘要
#[derive(Debug, Clone, Serialize)]
pub struct MountedFileEntry {
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub folder: String,
    pub current_revision_id: String,
    pub updated_at: String,
}

/// GET /api/v1/mounts/{mount_id}/files 响应（侧栏只读挂载目录树浏览）
#[derive(Debug, Clone, Serialize)]
pub struct MountedFilesResponse {
    pub ok: bool,
    pub mount_id: String,
    pub name: String,
    pub root_path: String,
    pub online: bool,
    pub total: usize,
    pub truncated: bool,
    pub folders: Vec<String>,
    pub items: Vec<MountedFileEntry>,
}

/// 单个受管项目条目（GET /api/v1/projects 列表项 / POST / PATCH / activate 返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// 项目稳定身份（= root_key，16 hex；与数据目录与工作区身份同源）
    pub project_id: String,
    /// 展示名（默认目录末段名，支持自定义别名）
    pub name: String,
    /// 规范化绝对路径（plain() 语义，无 `\\?\` 扩展前缀）
    pub root_path: String,
    /// 只读保护开关（false = 完整读写一等项目；true = 归档参考只读保护）
    pub readonly: bool,
    /// 是否当前聚焦/激活项目（主视图全景/资产库/MCP 默认指向）
    pub is_active: bool,
    /// ready | scanning | offline | root_in_use | error
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub file_count: u64,
    pub folder_count: u64,
    pub pending_decisions_count: u64,
    pub index_generation: u64,
    pub is_scanning: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_scan_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    pub added_at: String,
    pub last_opened_at: String,
}

/// GET /api/v1/projects 响应
#[derive(Debug, Clone, Serialize)]
pub struct ProjectListResponse {
    pub ok: bool,
    pub active_project_id: String,
    pub projects: Vec<ProjectEntry>,
}

/// POST /api/v1/projects | PATCH | POST /activate 响应
#[derive(Debug, Clone, Serialize)]
pub struct ProjectMutationResponse {
    pub ok: bool,
    pub active_project_id: String,
    pub project: ProjectEntry,
    pub projects: Vec<ProjectEntry>,
}

/// GET /api/v1/projects/{project_id}/tree 单个文件条目（侧栏并列目录树展示与原地操控用）
#[derive(Debug, Clone, Serialize)]
pub struct ProjectTreeFileEntry {
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub folder: String,
    pub current_revision_id: String,
    pub updated_at: String,
    pub revision_count: u64,
    pub pending_decisions: u64,
}

/// GET /api/v1/projects/{project_id}/tree 响应（含真实空目录 + 受管文件列表）
#[derive(Debug, Clone, Serialize)]
pub struct ProjectTreeResponse {
    pub ok: bool,
    pub project_id: String,
    pub name: String,
    pub root_path: String,
    pub readonly: bool,
    pub is_active: bool,
    pub status: String,
    pub total: usize,
    pub truncated: bool,
    pub folders: Vec<String>,
    pub files: Vec<ProjectTreeFileEntry>,
}

/// 跨项目待拍板决策汇总条（GET /api/v1/projects/overview）
#[derive(Debug, Clone, Serialize)]
pub struct CrossProjectDecisionItem {
    pub project_id: String,
    pub project_name: String,
    pub decision_id: String,
    pub code: String,
    pub question: String,
    pub status: String,
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    pub line_start: i64,
    pub observed_at: String,
}

/// 跨项目近期活跃文档条（GET /api/v1/projects/overview）
#[derive(Debug, Clone, Serialize)]
pub struct CrossProjectRecentFile {
    pub project_id: String,
    pub project_name: String,
    pub file_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub current_revision_id: String,
    pub observed_at: String,
}

/// GET /api/v1/projects/overview 响应（今日首页多项目总览台）
#[derive(Debug, Clone, Serialize)]
pub struct ProjectsOverviewResponse {
    pub ok: bool,
    pub active_project_id: String,
    pub total_projects: usize,
    pub online_projects: usize,
    pub total_files: u64,
    pub total_pending_decisions: u64,
    pub projects: Vec<ProjectEntry>,
    pub pending_decisions: Vec<CrossProjectDecisionItem>,
    pub recent_files: Vec<CrossProjectRecentFile>,
}

/// GET /api/v1/projects/search 单条命中（含来源项目身份，供 Ctrl+K 一键跨项目跳转）
#[derive(Debug, Clone, Serialize)]
pub struct CrossProjectSearchHit {
    pub project_id: String,
    pub project_name: String,
    pub is_active: bool,
    pub file_id: String,
    pub revision_id: String,
    pub relative_path: String,
    pub title: String,
    pub format: String,
    pub coverage: String,
    pub match_strategy: String,
    pub locator: SearchLocator,
    pub snippet: String,
    pub score: i64,
}

/// GET /api/v1/projects/search 响应
#[derive(Debug, Clone, Serialize)]
pub struct CrossProjectSearchResponse {
    pub ok: bool,
    pub query: String,
    pub total_hits: usize,
    pub searched_projects: usize,
    pub offline_projects: usize,
    pub items: Vec<CrossProjectSearchHit>,
}

/// 单文件服务端已读基线记录（仅记录已读版本与时刻，绝不伪造 scrollPercent）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadingStateEntry {
    pub file_id: String,
    pub last_read_revision_id: String,
    pub updated_at: String,
}

/// GET /api/v1/reading-state 响应
#[derive(Debug, Clone, Serialize)]
pub struct ReadingStateListResponse {
    pub ok: bool,
    pub index_generation: u64,
    pub items: Vec<ReadingStateEntry>,
}

/// 批量已读前单个文件的原状快照（用于 8 秒 Toast 一键 100% 撤销还原）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadingStateUndoItem {
    pub file_id: String,
    pub previous_revision_id: Option<String>,
    pub previous_updated_at: Option<String>,
}

fn default_reading_batch_action() -> String {
    "mark_baseline".to_owned()
}

/// POST /api/v1/reading-state/batch 请求体
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReadingStateBatchRequest {
    /// mark_baseline（默认）| restore（撤销还原）| mark_read（按 file_ids 标已读）| mark_unread（标未读）
    #[serde(default = "default_reading_batch_action")]
    pub action: String,
    /// workspace | folder（mark_baseline / mark_unread 按范围操作时生效，缺省视为 workspace）
    #[serde(default)]
    pub scope: Option<String>,
    /// scope = folder 时的工作区相对目录前缀（如 `01-星图引擎` 或 `01-星图引擎/01-主文档`）
    #[serde(default)]
    pub folder_prefix: Option<String>,
    /// action = restore 时传入上次响应的 undo_items
    #[serde(default)]
    pub restore_items: Option<Vec<ReadingStateUndoItem>>,
    /// action = mark_read / mark_unread 时指定的目标文件 ID 列表
    #[serde(default)]
    pub file_ids: Option<Vec<String>>,
    /// 单文件 action = mark_read 时可选指定的已读版本 ID（缺省推进至 files.last_revision_id）
    #[serde(default)]
    pub revision_id: Option<String>,
}

/// POST /api/v1/reading-state/batch 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingStateBatchResponse {
    pub ok: bool,
    pub action: String,
    pub affected_count: u64,
    pub updated_items: Vec<ReadingStateEntry>,
    pub undo_items: Vec<ReadingStateUndoItem>,
}
