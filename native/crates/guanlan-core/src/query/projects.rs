//! 多项目只读查询聚合件（SQL 留在 core，service 层编排多项目池）。
//!
//! 职责：
//! - 单项目实时脉搏统计（文件数 / 真实目录数 / 待拍板数 / 最近活跃时间）；
//! - 单项目侧栏完整目录树（含真实空目录 + 轻量文件摘要，用于左侧栏多项目并列展开）；
//! - 跨项目待拍板决策与近期活跃文档采样（供今日首页多项目总览聚合）；
//! - 单项目多策略搜索（优先混合倒排全文检索，并兜底文件名/路径即时匹配，
//!   确保新加入尚未建完倒排索引的项目也能立即可搜）。

use std::collections::HashSet;

use crate::dto::{
    CrossProjectDecisionItem, CrossProjectRecentFile, CrossProjectSearchHit, ProjectTreeFileEntry,
    ProjectTreeResponse, SearchLocator,
};
use crate::error::GuanlanError;
use crate::index::ident::folder_from_path;
use crate::query::search::{search, SearchQuery};
use crate::storage::{internal_sql, ReadonlyStore};

/// 单项目实时观测统计
#[derive(Debug, Clone)]
pub struct ProjectLiveMetrics {
    pub index_generation: u64,
    pub file_count: u64,
    pub folder_count: u64,
    pub pending_decisions_count: u64,
    pub last_scan_at: Option<String>,
    pub last_activity_at: Option<String>,
}

/// 读取单项目实时指标（只读 SQL；目录数由调用方从目录清单缓存供给）。
///
/// 目录枚举要 `read_dir` 整棵树，**不放在只读连接上**：多项目并存时它会占满连接池，
/// 把检索与翻页一起拖到 `INDEX_BUSY`。缓存与失效策略在服务层的目录清单缓存里。
pub fn project_live_metrics(
    store: &ReadonlyStore,
    folder_count: u64,
) -> Result<ProjectLiveMetrics, GuanlanError> {
    let ws = store.workspace()?;
    let ws_id = ws.workspace_id.as_str();
    let conn = store.conn();

    let (file_count, last_activity_at): (i64, Option<String>) = conn
        .query_row(
            "SELECT COUNT(*), MAX(last_observed_at) \
             FROM files \
             WHERE workspace_id = ?1 AND status = 'active'",
            [ws_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(internal_sql)?;

    let pending_decisions_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ( \
               SELECT s.decision_id, s.status, ROW_NUMBER() OVER ( \
                 PARTITION BY s.decision_id \
                 ORDER BY COALESCE(r.observed_at, s.observed_at) DESC, s.observed_at DESC, s.line_start ASC \
               ) AS _rn \
               FROM statements s \
               JOIN files f ON f.file_id = s.file_id AND f.status = 'active' \
               LEFT JOIN revisions r ON r.revision_id = s.revision_id \
               WHERE s.workspace_id = ?1 AND s.decision_id IS NOT NULL \
             ) WHERE _rn = 1 AND status IN ('来源不一致', '待确认')",
            [ws_id],
            |row| row.get(0),
        )
        .map_err(internal_sql)?;

    Ok(ProjectLiveMetrics {
        index_generation: ws.index_generation,
        file_count: file_count.max(0) as u64,
        folder_count,
        pending_decisions_count: pending_decisions_count.max(0) as u64,
        last_scan_at: ws.last_scan_at,
        last_activity_at,
    })
}

/// 枚举单个项目的完整目录树（含真实空目录 + 受管活跃文件）
#[allow(clippy::too_many_arguments)] // 只读投影参数均为独立标量，拆结构体反而增加调用噪音
pub fn project_tree(
    store: &ReadonlyStore,
    project_id: &str,
    name: &str,
    root_path: &str,
    readonly: bool,
    is_active: bool,
    status: &str,
    limit: usize,
    // 目录清单（含空目录）由调用方从缓存供给，查询体不做目录遍历
    folder_listing: &crate::index::collector::FolderListing,
) -> Result<ProjectTreeResponse, GuanlanError> {
    let ws = store.workspace()?;
    let ws_id = ws.workspace_id.as_str();
    let clamped = limit.clamp(1, 5000);
    let conn = store.conn();

    let total_i64: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM files WHERE workspace_id = ?1 AND status = 'active'",
            [ws_id],
            |row| row.get(0),
        )
        .map_err(internal_sql)?;
    let total = total_i64.max(0) as usize;

    let mut stmt = conn
        .prepare(
            "SELECT f.file_id, f.current_path, f.title, f.format, \
                    COALESCE(f.last_revision_id, ''), f.last_observed_at, \
                    (SELECT COUNT(*) FROM revisions r WHERE r.file_id = f.file_id) AS rev_cnt, \
                    (SELECT COUNT(*) FROM statements s \
                     WHERE s.file_id = f.file_id \
                       AND s.revision_id = f.last_revision_id \
                       AND s.decision_id IS NOT NULL \
                       AND s.status IN ('来源不一致', '待确认')) AS pend_cnt \
             FROM files f \
             WHERE f.workspace_id = ?1 AND f.status = 'active' \
             ORDER BY f.current_path ASC \
             LIMIT ?2",
        )
        .map_err(internal_sql)?;

    let rows = stmt
        .query_map(rusqlite::params![ws_id, clamped as i64], |row| {
            let rel: String = row.get(1)?;
            let folder = folder_from_path(&rel);
            Ok(ProjectTreeFileEntry {
                file_id: row.get(0)?,
                relative_path: rel,
                title: row.get(2)?,
                format: row.get(3)?,
                folder,
                current_revision_id: row.get(4)?,
                updated_at: row.get(5)?,
                revision_count: row.get::<_, i64>(6)?.max(0) as u64,
                pending_decisions: row.get::<_, i64>(7)?.max(0) as u64,
            })
        })
        .map_err(internal_sql)?;

    let mut files = Vec::new();
    for row in rows {
        files.push(row.map_err(internal_sql)?);
    }

    Ok(ProjectTreeResponse {
        ok: true,
        project_id: project_id.to_owned(),
        name: name.to_owned(),
        root_path: root_path.to_owned(),
        readonly,
        is_active,
        status: status.to_owned(),
        total,
        truncated: total > files.len() || folder_listing.truncated,
        folders: folder_listing.folders.clone(),
        files,
    })
}

/// 采样单项目待拍板决策（来源不一致优先于待确认）
pub fn project_pending_decisions(
    store: &ReadonlyStore,
    project_id: &str,
    project_name: &str,
    limit: usize,
) -> Result<Vec<CrossProjectDecisionItem>, GuanlanError> {
    let ws = store.workspace()?;
    let ws_id = ws.workspace_id.as_str();
    let clamped = limit.clamp(1, 50) as i64;
    let conn = store.conn();

    let mut stmt = conn
        .prepare(
            "SELECT decision_id, code, question, status, file_id, current_path, title, line_start, obs_at \
             FROM ( \
               SELECT s.decision_id, s.code, s.question, s.status, s.file_id, \
                      f.current_path, f.title, s.line_start, \
                      COALESCE(r.observed_at, s.observed_at) AS obs_at, \
                      ROW_NUMBER() OVER ( \
                        PARTITION BY s.decision_id \
                        ORDER BY COALESCE(r.observed_at, s.observed_at) DESC, s.observed_at DESC, s.line_start ASC \
                      ) AS _rn \
               FROM statements s \
               JOIN files f ON f.file_id = s.file_id AND f.status = 'active' \
               LEFT JOIN revisions r ON r.revision_id = s.revision_id \
               WHERE s.workspace_id = ?1 AND s.decision_id IS NOT NULL \
             ) \
             WHERE _rn = 1 AND status IN ('来源不一致', '待确认') \
             ORDER BY CASE status WHEN '来源不一致' THEN 0 ELSE 1 END ASC, obs_at DESC \
             LIMIT ?2",
        )
        .map_err(internal_sql)?;

    let rows = stmt
        .query_map(rusqlite::params![ws_id, clamped], |row| {
            Ok(CrossProjectDecisionItem {
                project_id: project_id.to_owned(),
                project_name: project_name.to_owned(),
                decision_id: row.get(0)?,
                code: row.get(1)?,
                question: row.get(2)?,
                status: row.get(3)?,
                file_id: row.get(4)?,
                relative_path: row.get(5)?,
                title: row.get(6)?,
                line_start: row.get(7)?,
                observed_at: row.get(8)?,
            })
        })
        .map_err(internal_sql)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(internal_sql)?);
    }
    Ok(out)
}

/// 采样单项目最近活跃文档
pub fn project_recent_files(
    store: &ReadonlyStore,
    project_id: &str,
    project_name: &str,
    limit: usize,
) -> Result<Vec<CrossProjectRecentFile>, GuanlanError> {
    let ws = store.workspace()?;
    let ws_id = ws.workspace_id.as_str();
    let clamped = limit.clamp(1, 50) as i64;
    let conn = store.conn();

    let mut stmt = conn
        .prepare(
            "SELECT file_id, current_path, title, format, COALESCE(last_revision_id, ''), last_observed_at \
             FROM files \
             WHERE workspace_id = ?1 AND status = 'active' \
             ORDER BY last_observed_at DESC, current_path ASC \
             LIMIT ?2",
        )
        .map_err(internal_sql)?;

    let rows = stmt
        .query_map(rusqlite::params![ws_id, clamped], |row| {
            Ok(CrossProjectRecentFile {
                project_id: project_id.to_owned(),
                project_name: project_name.to_owned(),
                file_id: row.get(0)?,
                relative_path: row.get(1)?,
                title: row.get(2)?,
                format: row.get(3)?,
                current_revision_id: row.get(4)?,
                observed_at: row.get(5)?,
            })
        })
        .map_err(internal_sql)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(internal_sql)?);
    }
    Ok(out)
}

/// 单项目检索（优先混合倒排全文检索，同时兜底标题/路径大小写不敏感子串匹配）
pub fn project_search(
    store: &ReadonlyStore,
    project_id: &str,
    project_name: &str,
    is_active: bool,
    raw_query: &str,
    limit: usize,
) -> Result<Vec<CrossProjectSearchHit>, GuanlanError> {
    let trimmed = raw_query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let clamped = limit.clamp(1, 100);
    let mut hits: Vec<CrossProjectSearchHit> = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();

    // 1) 混合倒排索引全文检索（索引未就绪时返回空 items，不阻断兜底）
    let sq = SearchQuery {
        q: trimmed.to_owned(),
        format: None,
        dir: None,
        limit: Some(clamped as u32),
    };
    if let Ok(resp) = search(store, &sq) {
        for item in resp.items {
            seen_files.insert(item.file_id.clone());
            hits.push(CrossProjectSearchHit {
                project_id: project_id.to_owned(),
                project_name: project_name.to_owned(),
                is_active,
                file_id: item.file_id,
                revision_id: item.revision_id,
                relative_path: item.relative_path,
                title: item.title,
                format: item.format,
                coverage: item.coverage,
                match_strategy: item.match_strategy,
                locator: item.locator,
                snippet: item.snippet,
                score: item.score,
            });
        }
    }

    // 2) 标题/路径即时兜底（确保新加入项目或倒排构建前也能立刻命中文件名与路径）
    if hits.len() < clamped {
        let ws = store.workspace()?;
        let needle_lower = trimmed.to_lowercase();
        let mut stmt = store
            .conn()
            .prepare(
                "SELECT file_id, current_path, title, format, COALESCE(last_revision_id, '') \
                 FROM files \
                 WHERE workspace_id = ?1 AND status = 'active' \
                 ORDER BY last_observed_at DESC \
                 LIMIT 2000",
            )
            .map_err(internal_sql)?;
        let rows = stmt
            .query_map([ws.workspace_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(internal_sql)?;
        for row in rows {
            if hits.len() >= clamped {
                break;
            }
            let (file_id, rel, title, format, rev_id) = row.map_err(internal_sql)?;
            if seen_files.contains(&file_id) {
                continue;
            }
            let title_match = title.to_lowercase().contains(&needle_lower);
            let path_match = rel.to_lowercase().contains(&needle_lower);
            if title_match || path_match {
                seen_files.insert(file_id.clone());
                let score = if title_match { 85 } else { 65 };
                hits.push(CrossProjectSearchHit {
                    project_id: project_id.to_owned(),
                    project_name: project_name.to_owned(),
                    is_active,
                    file_id,
                    revision_id: rev_id,
                    relative_path: rel.clone(),
                    title: title.clone(),
                    format,
                    coverage: "filename_only".to_owned(),
                    match_strategy: "filename_match".to_owned(),
                    locator: SearchLocator::File,
                    snippet: rel,
                    score,
                });
            }
        }
    }

    Ok(hits)
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
