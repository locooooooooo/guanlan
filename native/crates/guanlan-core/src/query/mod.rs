//! 有界查询：按端点拆分有界只读查询，避免每次构建整个工作区的大投影。
//!
//! 契约来源：`native/docs/contract-query-api.md`；
//! 行为基准：`server/queries.ts`、`server/project.ts`。
//!
//! 全部函数只执行只读 SQL（`contract-storage.md` §4 边界），
//! 遵守 §0.3 分页游标总语义（`snapshot_max_seq`/代际绑定 + 筛选指纹 → `CURSOR_STALE`）。
//!
//! 码表说明：游标筛选指纹不符统一返回 `CURSOR_STALE`（契约 §0.2/§0.3-3/§1.4）。

pub mod candidates;
pub mod cross_search;
pub mod cursor;
pub(crate) mod decisions;
pub(crate) mod events;
pub(crate) mod files;
pub mod longtasks;
pub(crate) mod office;
pub(crate) mod pdf;
pub(crate) mod preview;
pub mod projects;
pub mod reading_state;
pub mod search;

pub mod resume;
pub(crate) mod revisions;
#[cfg(test)]
#[path = "search_tests.rs"]
mod search_tests;
pub mod state_overview;

pub use candidates::{candidate_exists, list_candidates};
pub use cursor::{
    decode_event_cursor, decode_key_cursor, encode_event_cursor, encode_key_cursor, EventCursor,
    KeyCursor,
};
pub use decisions::{decisions, decisions_tx, relations, relations_tx};
pub use events::{
    event_time_range, query_event_days, query_event_days_tx, query_events, query_events_tx,
};
pub use files::{list_files, list_files_tx};
pub use longtasks::file_current_path;
pub use longtasks::{
    checkpoints, file_initiative_archived, file_summary, initiative_state, l4a_progress,
    map_status_wire, revision_draft_content, revision_drafts, statement_brief, statements,
    task_nodes, watch_baseline,
};
pub use office::{revision_office, revision_office_tx};
pub use pdf::{revision_pdf, revision_pdf_tx};
pub use preview::{
    detect_magic_signature, format_hex_head, inspect_image_dimensions, preview_kind_for,
    revision_preview, revision_preview_tx, slice_utf8_bounded, RevisionPreviewQuery,
    DEFAULT_PREVIEW_SLICE_BYTES,
};
pub use reading_state::reading_states;
pub use resume::resume_context;
pub use revisions::{
    file_detail, file_detail_tx, file_revisions, file_revisions_tx, revision_content,
    revision_content_tx,
};
pub use search::{search, search_state_of, SearchQuery};
pub use state_overview::state_overview;

// application 模块复用的内部查询件
pub(crate) use decisions::relations_total;
pub(crate) use events::event_time_range_inner;

/// &str → SQLite 绑定参数（rusqlite 0.42 的 `Value` 未实现 `From<&str>`）
pub(crate) fn sql_text(s: impl Into<String>) -> rusqlite::types::Value {
    rusqlite::types::Value::from(s.into())
}

/// 事件排序口径（契约 §1.4 order：occurred=材料记载 / observed=采集）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum EventOrder {
    #[default]
    Occurred,
    Observed,
}

/// 事件日桶粒度（契约 §1.5 granularity；桶键：day=YYYY-MM-DD、week=该周周一、month=YYYY-MM）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum EventGranularity {
    #[default]
    Day,
    Week,
    Month,
}

/// 版本链排序（契约 §1.7 order：默认 seq_desc，时间机器自上而下 v3→v2→v1）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RevisionOrder {
    SeqAsc,
    #[default]
    SeqDesc,
}

/// 版本链附加数据段（契约 §1.7 `include=events,statements,edges,aliases` 逗号分隔可选）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionIncludeSection {
    Events,
    Statements,
    Edges,
    Aliases,
}

/// GET /api/v1/events 请求参数（契约 §1.4 参数表）
#[derive(Debug, Clone, Default)]
pub struct EventQuery {
    /// YYYY-MM-DD 含端点，按本地日归属（契约 §0.3-7：`localDayExpr`，不能统一按 UTC 取日）
    pub from: Option<String>,
    pub to: Option<String>,
    /// 逗号分隔事件种类（EventKind 枚举，`WorkspaceStore.ts:21-29`；只接受 `kinds`，
    /// 旧别名 `kind` 不再兼容，见契约 §5 风险 5）
    pub kinds: Vec<String>,
    /// md | svg | pdf；工作区级事件不计入
    pub format: Option<String>,
    pub order: EventOrder,
    /// 1 只看日期待考（occurred_at IS NULL）
    pub undated: bool,
    /// headline/detail LIKE `%q%`
    pub q: Option<String>,
    /// 默认 50，clamp 1..200（契约 §0.3-6）
    pub limit: Option<u32>,
    /// 不透明游标：base64url(JSON {snap, k, s, fp})（契约 §0.3-2）
    pub cursor: Option<String>,
}

/// GET /api/v1/events/days 请求参数（契约 §1.5 参数表）
#[derive(Debug, Clone, Default)]
pub struct EventDaysQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub kinds: Vec<String>,
    pub format: Option<String>,
    pub order: EventOrder,
    pub granularity: EventGranularity,
    /// 默认 30，clamp 1..120（query 名 limit_days）
    pub limit_days: Option<u32>,
    /// 每桶样本数，默认 4，clamp 1..12（query 名沿用现状 `samples`）
    pub samples: Option<u32>,
}

/// GET /api/v1/files 请求参数（契约 §1.3 参数表）
#[derive(Debug, Clone, Default)]
pub struct FileListQuery {
    pub cursor: Option<String>,
    /// 默认 100，上限 500
    pub limit: Option<u32>,
    /// 目录前缀（相对路径，含子目录）
    pub dir: Option<String>,
    /// md | svg | pdf
    pub format: Option<String>,
    /// 事项/角色（files.role）
    pub matter: Option<String>,
    /// 标题或路径 LIKE
    pub q: Option<String>,
    /// 状态筛选：缺省/`active`；`trashed` / `missing` / `recoverable` / `all`
    pub status: Option<String>,
}

/// GET /api/v1/files/{file_id}/revisions 请求参数（契约 §1.7）
#[derive(Debug, Clone, Default)]
pub struct FileRevisionsQuery {
    pub cursor: Option<String>,
    /// 默认 50，上限 200
    pub limit: Option<u32>,
    pub order: RevisionOrder,
    /// include=events,statements,edges
    pub include: Vec<RevisionIncludeSection>,
}

/// GET /api/v1/decisions 请求参数（契约 §1.9）
#[derive(Debug, Clone, Default)]
pub struct DecisionsQuery {
    pub cursor: Option<String>,
    /// 默认 100
    pub limit: Option<u32>,
    /// 待确认|已确认|已否决|已搁置|已取代|来源不一致|未知
    pub status: Option<String>,
    /// 编号精确匹配
    pub code: Option<String>,
    /// question/namespace LIKE
    pub q: Option<String>,
}

/// GET /api/v1/revisions/{revision_id}/content 请求参数（契约 §1.8：raw=1 仅 PDF 生效）
#[derive(Debug, Clone, Copy, Default)]
pub struct RevisionContentQuery {
    pub raw: bool,
}
