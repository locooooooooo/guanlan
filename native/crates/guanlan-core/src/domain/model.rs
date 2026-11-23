//! 领域模型补齐（PRD v2.0 §2.1 四层资产与任务层级模型）。
//!
//! - [`Initiative`]：跨天长任务的一级容器（专项），贯穿五个标准阶段
//!   （PRD 2.1；阶段枚举以 apiContract A 冻结的「蓝图|计划|决策|执行|交付」为准，
//!   PRD 文案中的「提案」对应「蓝图」——裁定值，已登记 contract-storage.md §4.3）。
//! - [`Artifact`]：隶属于特定专项与阶段的文档/产出物，支持多版本演进
//!   （v1…vN，每版本唯一内容哈希）。
//! - [`DecisionItem`]：嵌入文档中的结构化卡点（P0/P1/P2），是控制长任务挂起与
//!   恢复的核心门禁（Gate，PRD 2.1/3.3）；由 [`crate::index::decision_block`]
//!   解析器从 `[P0/P1/P2 - 待确认]` 块产出。
//!
//! 本模块是纯领域模型：不含 serde wire 形状（wire 镜像在 [`crate::dto`]），
//! 不含 SQL 行结构（行结构在 [`crate::storage`]）。状态枚举 [`DocState`] /
//! [`Stage`] 的定义与迁移规则见 [`crate::index::state_machine`]（SSOT 纯函数层）。

use crate::index::state_machine::{DocState, Stage};

/// 专项（PRD 2.1）：跨天长任务的一级容器。
///
/// 持久载体：`initiatives` 表（contract-storage.md §4.3）。`initiative_id`
/// 生成规则：`init_` + stable_key(首段目录名)（与 decision_id 同源，
/// `crate::index::ident::stable_key`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Initiative {
    pub initiative_id: String,
    pub workspace_id: String,
    /// 展示名（v1 = 首段目录名本身）
    pub name: String,
    /// 专项根目录（首段目录名，相对工作区根）
    pub root_dir: String,
    /// 当前所处阶段（五阶段取最靠后者；无任何已归类文档时为「待分类」）
    pub current_stage: Stage,
    /// 专项级状态（六态，与文档同一套状态机）
    pub state: DocState,
    pub artifact_count: u32,
    pub pending_p0: u32,
    pub pending_p1: u32,
    pub pending_p2: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// 文档/产出物（PRD 2.1）：隶属于特定专项与阶段，多版本演进。
///
/// 持久载体：`artifact_states` 表。`file_id` 复用 `files` 主键——禁止第二套
/// 文件身份（contract-storage.md §4.3）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub file_id: String,
    pub workspace_id: String,
    /// 所属专项；未识别（首段目录不匹配专项规则）时为 None
    pub initiative_id: Option<String>,
    pub current_path: String,
    pub title: String,
    pub stage: Stage,
    /// 文档级状态（六态）
    pub state: DocState,
    /// 选中的修订（v1 口径 = files.last_revision_id，裁定值已登记）
    pub selected_revision_id: Option<String>,
    pub checklist_done: u32,
    pub checklist_total: u32,
    pub pending_p0: u32,
    pub pending_p1: u32,
    pub pending_p2: u32,
    /// 最近活动时刻（v1 口径 = 最新版本的 occurred_at，材料时间口径）
    pub last_activity_at: Option<String>,
}

/// 决策优先级（PRD 3.3：P0/P1/P2）。
///
/// P0/P1 是阻塞级（控制长任务挂起），P2 非阻塞。来源陈述若无优先级证据
/// （既有抽取规则产出的陈述 detail_json 无 priority 键），按 P2 计——
/// 裁定值，已登记 contract-storage.md §4.3。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DecisionPriority {
    P0,
    P1,
    P2,
}

impl DecisionPriority {
    /// wire 词（与卡点块标记里的优先级词一致）
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionPriority::P0 => "P0",
            DecisionPriority::P1 => "P1",
            DecisionPriority::P2 => "P2",
        }
    }

    /// 从 `P0|P1|P2` 词解析；其余返回 None
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "P0" => Some(DecisionPriority::P0),
            "P1" => Some(DecisionPriority::P1),
            "P2" => Some(DecisionPriority::P2),
            _ => None,
        }
    }
}

/// 结构化决策项（PRD 3.3）：解析 `[P0/P1/P2 - 待确认]` 标准块的产出。
///
/// 占位字段（决定/确认人等仍是下划线）为 `None`；已填写的为 `Some`。
/// `pending` 表示该卡点块仍处于待人工填写状态（决定字段仍是占位符）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionItem {
    /// 业务决定 ID：`dec_` + stable_key(命名空间::归一化问题)，与
    /// statements.decision_id 同源——同一问题的卡点块与来源陈述归入同一决定。
    pub decision_id: String,
    pub priority: DecisionPriority,
    /// 卡点标题（标记行 `[P1 - 待确认]` 之后的文字）
    pub question: String,
    /// 状态词（detect_status 口径：待确认/已确认/已否决/已搁置/已取代/来源不一致/未知）
    pub status: String,
    /// 1 起始行号（与 statements.line_start 同口径）
    pub line_start: usize,
    pub line_end: usize,
    /// 决定内容；None = 仍是下划线占位
    pub decision: Option<String>,
    pub confirmer: Option<String>,
    pub role: Option<String>,
    /// 现运行条件（PRD 3.3「现/新运行条件」）
    pub current_condition: Option<String>,
    pub new_condition: Option<String>,
    /// 生效范围与日期
    pub effective_scope: Option<String>,
    /// 推荐理由（「推荐」不等于已批准）
    pub recommendation: Option<String>,
    /// 预设选项（「可选方案」行 + `- **选项 X**：…` 行）
    pub options: Vec<String>,
    /// True = 决定字段仍是占位符，待人工填写
    pub pending: bool,
}

impl DecisionItem {
    /// 是否为阻塞级未决事项（P0/P1 且仍未拍板）
    pub fn is_blocking(&self) -> bool {
        self.pending && matches!(self.priority, DecisionPriority::P0 | DecisionPriority::P1)
    }
}
