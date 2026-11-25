//! 统一错误枚举与错误包络。
//!
//! 码表逐字对齐契约 native/docs/contract-query-api.md：
//! - §0.2 六个错误码：ROOT_IN_USE / NOT_FOUND / SNAPSHOT_UNAVAILABLE /
//!   INDEX_STALE / CURSOR_STALE / INDEX_BUSY；
//! - 占位码 NOT_IMPLEMENTED（不在六码内，前端不得当作业务错误码依赖）；
//! - 内部错误（存储/IO）沿用旧实现的 INTERNAL 兜底码与 500 状态
//!   （server/workspace-plugin.ts:134-140 `code || 'INTERNAL'`）。

use serde::Serialize;

/// 统一错误包络（契约 §0.2）：
/// `{ ok:false, code, error, detail?, index_generation? }`
#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    /// 恒为 false
    pub ok: bool,
    /// 契约 §0.2 码表中的 wire 错误码
    pub code: &'static str,
    /// 人类可读信息
    pub error: String,
    /// 可选补充
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 当前索引代（无法获取当前代际时为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_generation: Option<u64>,
}

/// 统一错误枚举。[`GuanlanError::code`] 与 [`GuanlanError::http_status`]
/// 的映射和契约 §0.2 码表逐字对齐。
#[derive(Debug, thiserror::Error)]
pub enum GuanlanError {
    /// 409：第二个服务实例对同一工作区抢锁（服务级排他锁）
    #[error("工作区已被另一个服务实例占用")]
    RootInUse,
    /// 404：workspace/file/revision/decision 等主体不存在
    #[error("{0}")]
    NotFound(String),
    /// 410：版本元数据在但快照已过保留期/磁盘缺失（不拿当前内容冒充旧版本）
    #[error("{0}")]
    SnapshotUnavailable(String),
    /// 409：客户端携带的 index_generation/游标快照与服务端当前代际不符，需整窗重查
    #[error("{0}")]
    IndexStale(String),
    /// 409：游标不可解码、游标绑定筛选与本次请求不一致、或可变列表游标失效
    #[error("{0}")]
    CursorStale(String),
    /// 503：查询/索引有界队列饱和（响应附 Retry-After）
    #[error("索引队列饱和，请稍后重试")]
    IndexBusy,
    /// 501：暂未实现的端点占位。载荷为端点名。
    #[error("该端点暂未实现")]
    NotImplemented(&'static str),
    /// 413：内容超出内联上限（响应字节预算）。载荷为提示（含 raw=1 建议）。
    /// 码表扩展项（非契约 §0.2 六码，与 INTERNAL/NotImplemented 同为本地扩展）。
    #[error("{0}")]
    UnsupportedContent(String),
    /// 400：请求体或参数不合法（如未支持的索引任务类型）。
    /// 码表扩展项（非契约 §0.2 六码，与 INTERNAL/NotImplemented 同为本地扩展）。
    #[error("{0}")]
    BadRequest(String),
    /// 409：主体状态不允许该操作（archived 文档需先人工重开、对已结束任务 cancel）。
    /// 码表扩展项（本地扩展码 CONFLICT）。
    /// 仅用于「主体状态不允许该操作」：CAS 内容冲突不占错误码、走 job report。
    #[error("{0}")]
    Conflict(String),
    /// 409：挂载参考工作区被确定性拒绝（父子目录互斥 / 与已有挂载嵌套 / 重复挂载）。
    /// 码表扩展项：外挂目录隔离约束——挂载前强制互斥校验，绝不放行父子嵌套或成环。
    #[error("{0}")]
    MountRejected(String),
    /// 403：跨挂载边界写操作被确定性拒绝（参考工作区只读；主/挂载区之间硬性禁止
    /// move / rename / trash 与一切跨库写入，仅允许只读引用）。
    /// 码表扩展项。
    #[error("{0}")]
    CrossWorkspaceForbidden(String),
    /// 409：协作式取消或服务停机在事务提交点前安全中止长耗时扫描/对账（非服务故障）。
    #[error("{0}")]
    Cancelled(String),
    /// 500：内部错误（rusqlite/IO 等），包络码 INTERNAL（非契约 §0.2 六码）
    #[error("内部错误：{0}")]
    Internal(String),
}

impl GuanlanError {
    /// 契约 §0.2 码表中的 wire 错误码
    pub fn code(&self) -> &'static str {
        match self {
            Self::RootInUse => "ROOT_IN_USE",
            Self::NotFound(_) => "NOT_FOUND",
            Self::SnapshotUnavailable(_) => "SNAPSHOT_UNAVAILABLE",
            Self::IndexStale(_) => "INDEX_STALE",
            Self::CursorStale(_) => "CURSOR_STALE",
            Self::IndexBusy => "INDEX_BUSY",
            Self::NotImplemented(_) => "NOT_IMPLEMENTED",
            Self::UnsupportedContent(_) => "UNSUPPORTED_CONTENT",
            Self::BadRequest(_) => "BAD_REQUEST",
            Self::Conflict(_) => "CONFLICT",
            Self::MountRejected(_) => "MOUNT_REJECTED",
            Self::CrossWorkspaceForbidden(_) => "CROSS_WORKSPACE_FORBIDDEN",
            Self::Cancelled(_) => "CANCELLED",
            Self::Internal(_) => "INTERNAL",
        }
    }

    /// 对应 HTTP 状态码（契约 §0.2：404/409/410/503，其余 500；NOT_IMPLEMENTED → 501）
    pub fn http_status(&self) -> u16 {
        match self {
            Self::RootInUse | Self::IndexStale(_) | Self::CursorStale(_) => 409,
            Self::NotFound(_) => 404,
            Self::SnapshotUnavailable(_) => 410,
            Self::IndexBusy => 503,
            Self::UnsupportedContent(_) => 413,
            Self::NotImplemented(_) => 501,
            Self::BadRequest(_) => 400,
            Self::Conflict(_) | Self::Cancelled(_) => 409,
            Self::MountRejected(_) => 409,
            Self::CrossWorkspaceForbidden(_) => 403,
            Self::Internal(_) => 500,
        }
    }

    /// 组装统一错误包络；`index_generation` 由调用方按当前代际补齐
    pub fn to_envelope(&self, index_generation: Option<u64>) -> ErrorEnvelope {
        ErrorEnvelope {
            ok: false,
            code: self.code(),
            error: self.to_string(),
            detail: match self {
                Self::NotFound(msg)
                | Self::SnapshotUnavailable(msg)
                | Self::IndexStale(msg)
                | Self::CursorStale(msg)
                | Self::UnsupportedContent(msg)
                | Self::BadRequest(msg)
                | Self::Conflict(msg)
                | Self::MountRejected(msg)
                | Self::CrossWorkspaceForbidden(msg)
                | Self::Cancelled(msg)
                | Self::Internal(msg) => Some(msg.clone()),
                Self::NotImplemented(endpoint) => Some((*endpoint).to_string()),
                Self::RootInUse | Self::IndexBusy => None,
            },
            index_generation,
        }
    }
}
