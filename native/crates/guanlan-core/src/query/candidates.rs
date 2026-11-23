//! C01 · 候选事项（多信号编织产物）只读查询与 wire 组装。

use crate::dto::InitiativeCandidatesResponse;
use crate::error::GuanlanError;
use crate::query::files::title_of;
use crate::storage::ReadonlyStore;

/// 读取工作区全部候选（含成员路径/标题与理由胶囊明细；按 score 降序）
pub fn list_candidates(
    store: &ReadonlyStore,
) -> Result<InitiativeCandidatesResponse, GuanlanError> {
    let ws = store.workspace()?.clone();
    let candidates = writer_candidates(store)?;

    let mut items = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let mut members = Vec::with_capacity(candidate.members.len());
        for member in &candidate.members {
            // 成员文件可能已被删除/移动：文件行缺失时如实降级为 file_id 卡
            let (relative_path, title) = match store.file_by_id(&member.file_id)? {
                Some(file) => {
                    let title = if file.title.is_empty() {
                        title_of(&file.current_path)
                    } else {
                        file.title.clone()
                    };
                    (file.current_path, title)
                }
                None => (member.file_id.clone(), member.file_id.clone()),
            };
            members.push(crate::dto::InitiativeCandidateMember {
                file_id: member.file_id.clone(),
                relative_path,
                title,
                signals: serde_json::from_str(&member.signals_json)
                    .unwrap_or_else(|_| serde_json::Value::Array(vec![])),
            });
        }
        items.push(crate::dto::InitiativeCandidateItem {
            candidate_id: candidate.row.candidate_id,
            title: candidate.row.title,
            reason_summary: candidate.row.reason_summary,
            signal_mask: candidate.row.signal_mask.max(0) as u32,
            score: candidate.row.score.max(0) as u32,
            state: candidate.row.state,
            member_count: candidate.row.member_count.max(0) as u32,
            members,
            updated_at: candidate.row.updated_at,
        });
    }

    Ok(InitiativeCandidatesResponse {
        ok: true,
        index_generation: ws.index_generation,
        items,
    })
}

/// 库内候选行读取（ Writer 层接口复用；只读连接上同一 SELECT 面）
fn writer_candidates(
    store: &ReadonlyStore,
) -> Result<Vec<crate::index::writer::CandidateFull>, GuanlanError> {
    // 只读侧直接以相同 SQL 形状读取（不依赖 Writer 实例）
    use crate::index::writer::{CandidateFull, CandidateMemberRow, CandidateRow};

    let conn = store.conn();
    let mut stmt = conn
        .prepare(
            "SELECT candidate_id, workspace_id, candidate_key, title, reason_summary,
                    signal_mask, score, member_count, state, updated_at
             FROM initiative_candidates
             ORDER BY score DESC, candidate_id ASC",
        )
        .map_err(|e| GuanlanError::Internal(format!("候选列表查询失败: {e}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CandidateRow {
                candidate_id: row.get(0)?,
                workspace_id: row.get(1)?,
                candidate_key: row.get(2)?,
                title: row.get(3)?,
                reason_summary: row.get(4)?,
                signal_mask: row.get(5)?,
                score: row.get(6)?,
                member_count: row.get(7)?,
                state: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| GuanlanError::Internal(format!("候选列表读取失败: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| GuanlanError::Internal(format!("候选列表映射失败: {e}")))?;
    drop(stmt);

    let mut members_stmt = conn
        .prepare(
            "SELECT candidate_id, file_id, role, signals_json
             FROM initiative_candidate_members
             ORDER BY file_id ASC",
        )
        .map_err(|e| GuanlanError::Internal(format!("候选成员查询失败: {e}")))?;
    let mut members_by: std::collections::HashMap<String, Vec<CandidateMemberRow>> =
        std::collections::HashMap::new();
    let member_rows = members_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CandidateMemberRow {
                    file_id: row.get(1)?,
                    role: row.get(2)?,
                    signals_json: row.get(3)?,
                },
            ))
        })
        .map_err(|e| GuanlanError::Internal(format!("候选成员读取失败: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| GuanlanError::Internal(format!("候选成员映射失败: {e}")))?;
    drop(members_stmt);
    for (candidate_id, member) in member_rows {
        members_by.entry(candidate_id).or_default().push(member);
    }

    Ok(rows
        .into_iter()
        .map(|row| CandidateFull {
            members: members_by.remove(&row.candidate_id).unwrap_or_default(),
            row,
        })
        .collect())
}

/// 候选存在性校验（HTTP 受理前置；不存在 404 而非入队后失败）
pub fn candidate_exists(store: &ReadonlyStore, candidate_id: &str) -> Result<bool, GuanlanError> {
    let conn = store.conn();
    let exists: Option<String> = conn
        .query_row(
            "SELECT candidate_id FROM initiative_candidates WHERE candidate_id = ?",
            [candidate_id],
            |row| row.get(0),
        )
        .ok();
    Ok(exists.is_some())
}
