//! V04 · 工作区服务端已读基线只读查询（兼容旧库无 reading_states 表时的零写降级）。

use crate::dto::{ReadingStateEntry, ReadingStateListResponse};
use crate::error::GuanlanError;
use crate::storage::{internal_sql, ReadonlyStore};

/// 读取当前工作区全部服务端已读基线记录（表不存在时返回空数组，严守只读零写契约）。
pub fn reading_states(store: &ReadonlyStore) -> Result<ReadingStateListResponse, GuanlanError> {
    store.read_txn(|_conn| {
        let ws = store.workspace()?.clone();
        let conn = store.conn();
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'reading_states'",
                [],
                |row| row.get(0),
            )
            .map_err(internal_sql)?;
        if table_exists == 0 {
            return Ok(ReadingStateListResponse {
                ok: true,
                index_generation: ws.index_generation,
                items: Vec::new(),
            });
        }

        let mut stmt = conn
            .prepare(
                "SELECT file_id, last_read_revision_id, updated_at
                   FROM reading_states
                  WHERE workspace_id = ?1",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map([ws.workspace_id.as_str()], |row| {
                Ok(ReadingStateEntry {
                    file_id: row.get(0)?,
                    last_read_revision_id: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(internal_sql)?;
        let items = rows.collect::<Result<Vec<_>, _>>().map_err(internal_sql)?;
        Ok(ReadingStateListResponse {
            ok: true,
            index_generation: ws.index_generation,
            items,
        })
    })
}
