//! guanlan-core —— 观澜领域核心。
//!
//! 只承载领域规则、存储、索引、查询与应用编排，不依赖 React、Vite、Tauri、MCP 宿主或
//! HTTP 框架。
//!
//! 模块归属：
//! - [`domain`]：身份、版本、事件、时间与证据规则（含 rootKey / file_id / revision_id
//!   的逐字兼容实现、win32 路径规范化与事件短摘要）
//! - [`storage`]：SQLite 只读打开、schema 版本校验与迁移、数据目录与快照定位、权限沙箱与账本审计
//! - [`index`]：采集、稳定读取、对账、陈述与引用抽取（唯一写入路径），以及
//!   [`index::state_machine`]（统一状态机 SSOT 纯函数）、
//!   [`index::state_engine`]（槽位声明式重算与三级状态迁移落库、checkpoint 同步受理）、
//!   [`index::decision_block`]（[P0/P1/P2 - 待确认] 卡点块解析器）
//! - [`query`]：文件、事件、版本与检索等有界只读查询
//! - [`application`]：bootstrap、status、diff、context、修订草案、批阅看板与资料胶囊
//! - [`error`]：统一错误枚举：契约 §0.2 的六个错误码，加本地扩展码
//!   （NOT_IMPLEMENTED、UNSUPPORTED_CONTENT、BAD_REQUEST、CONFLICT、MOUNT_REJECTED、
//!   CROSS_WORKSPACE_FORBIDDEN、CANCELLED、INTERNAL）
//! - [`dto`]：各端点响应 DTO（serde 字段名与 native/docs/contract-query-api.md 逐字对齐；
//!   前端手工镜像：src/services/apiTypes.ts）

pub mod application;
pub mod domain;
pub mod dto;
pub mod error;
pub mod index;
pub mod query;
pub mod storage;

#[cfg(test)]
mod test_support;
