//! guanlan-core —— 观澜领域核心。
//!
//! 只承载领域规则、只读存储与查询契约，不依赖 React、Vite、Tauri、MCP 宿主或
//! HTTP 框架（方案：docs/guanlan/观澜-Rust服务拆分方案-v0.1.md:73）。
//!
//! 模块归属（方案 §2，41-81 行）：
//! - [`domain`]：身份、版本、事件、时间与证据规则（批次一已落地 rootKey /
//!   file_id / revision_id 的精确兼容实现与 win32 path 移植；批次二已补
//!   event_id 模板与去重身份所需的短摘要）
//! - [`storage`]：SQLite 只读打开、schema 版本校验、数据目录定位与快照定位（批次一）
//! - [`index`]：采集、稳定读取、对账、陈述与引用抽取（**批次二已落地：唯一写入路径**）；
//!   PRD v2.0 长任务批次补齐：[`index::state_machine`]（统一状态机 SSOT 纯函数）、
//!   [`index::state_engine`]（槽位声明式重算与三级状态迁移落库、checkpoint 同步受理）、
//!   [`index::decision_block`]（[P0/P1/P2 - 待确认] 卡点块解析器）
//! - [`query`]：文件、事件、版本等有界查询（批次一已落地只读实现）
//! - [`application`]：bootstrap、索引任务、diff、context（批次一已落地
//!   bootstrap/status；任务、diff、context 属批次二/三）
//! - [`error`]：统一错误枚举：六个错误码 + NOT_IMPLEMENTED（契约 §0.2/§2）
//! - [`dto`]：各端点响应 DTO（serde 字段名与 contract-query-api.md 逐字对齐；
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
