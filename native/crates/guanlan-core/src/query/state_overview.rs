//! 统一状态机投影（GET /api/v1/state-overview）。
//!
//! 四视图（专项卡片、详情下拉、星图节点、文档顶栏）的唯一数据源：
//! 只读 `initiatives` / `artifact_states`（+ `files` 补标题与路径），不现场重算
//! ——状态表由写入侧每轮 reconcile 幂等重算维护（state_engine）。
//!
//! 版本门禁：schema v2 之前的库（0/1，新表尚未由写入侧建出）返回空投影——
//! 服务启动首轮 reconcile（verify_all）后即有数；不把「未升级」伪装成错误。

use rusqlite::params;

use crate::dto::{ArtifactOverview, InitiativeOverview, StateOverview};
use crate::error::GuanlanError;
use crate::storage::{artifact_state_row, initiative_row, internal_sql, ReadonlyStore};

/// 三级状态投影：`initiative_id` 缺省为全部专项；给定时只返回该专项及其文档。
///
/// 排序：initiatives 按 initiative_id、artifacts 按 current_path（输出稳定，
/// 可直接分页或整包返回）。
pub fn state_overview(
    store: &ReadonlyStore,
    workspace_id: &str,
    initiative_id: Option<&str>,
) -> Result<StateOverview, GuanlanError> {
    if store.schema_version()? < 2 {
        // schema 版本低于 2 的旧库尚无状态投影表，返回空投影（首轮 reconcile 后有数）
        return Ok(StateOverview::default());
    }
    let conn = store.conn();

    let mut initiatives: Vec<InitiativeOverview> = Vec::new();
    {
        // 统一用可选绑定：? IS NULL OR initiative_id = ?（Option<&str> 绑 NULL）
        let mut stmt = conn
            .prepare(
                "SELECT * FROM initiatives WHERE workspace_id = ?
                   AND (? IS NULL OR initiative_id = ?)
                 ORDER BY initiative_id ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(
                params![workspace_id, initiative_id, initiative_id],
                initiative_row,
            )
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for row in rows {
            initiatives.push(InitiativeOverview {
                initiative_id: row.initiative_id,
                name: row.name,
                root_dir: row.root_dir,
                current_stage: row.current_stage,
                state: row.state,
                artifact_count: row.artifact_count.max(0) as u32,
                pending_p0: row.pending_p0.max(0) as u32,
                pending_p1: row.pending_p1.max(0) as u32,
                pending_p2: row.pending_p2.max(0) as u32,
                updated_at: row.updated_at,
            });
        }
    }

    let mut artifacts: Vec<ArtifactOverview> = Vec::new();
    {
        // files 内连接：file_id 复用 files 主键，files 行缺失视为已回收
        let mut stmt = conn
            .prepare(
                "SELECT a.*, f.current_path, f.title
                 FROM artifact_states a
                 JOIN files f ON f.file_id = a.file_id AND f.workspace_id = a.workspace_id
                 WHERE a.workspace_id = ? AND f.status != 'trashed'
                   AND (? IS NULL OR a.initiative_id = ?)
                 ORDER BY f.current_path ASC, a.file_id ASC",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map(params![workspace_id, initiative_id, initiative_id], |row| {
                Ok((
                    artifact_state_row(row)?,
                    row.get::<_, String>("current_path")?,
                    row.get::<_, String>("title")?,
                ))
            })
            .map_err(internal_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_sql)?;
        for (row, current_path, title) in rows {
            artifacts.push(ArtifactOverview {
                file_id: row.file_id,
                initiative_id: row.initiative_id,
                current_path,
                title,
                stage: row.stage,
                state: row.state,
                selected_revision_id: row.selected_revision_id,
                checklist_done: row.checklist_done.max(0) as u32,
                checklist_total: row.checklist_total.max(0) as u32,
                pending_p0: row.pending_p0.max(0) as u32,
                pending_p1: row.pending_p1.max(0) as u32,
                pending_p2: row.pending_p2.max(0) as u32,
                last_activity_at: row.last_activity_at,
            });
        }
    }

    Ok(StateOverview {
        initiatives,
        artifacts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{cleanup_dir, FixtureDb};

    /// v0/v1 库（新表未建）：投影为空而非报错
    #[test]
    fn pre_v2_database_returns_empty_overview() {
        let fixture = FixtureDb::new("state-overview-empty");
        let root = fixture.root();
        let ws_id = fixture.workspace(&root, 1, None);
        let store = crate::test_support::open_store(&fixture, &root);
        let overview = state_overview(&store, &ws_id, None).expect("v1 库应返回空投影");
        assert!(overview.initiatives.is_empty());
        assert!(overview.artifacts.is_empty());
        cleanup_dir(&fixture.dir);
    }
}
