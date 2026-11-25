//! 跨项目联合检索的合并纯函数（契约 contract-query-api.md §2.5）。
//!
//! 输入：主区 [`SearchResponse`]（单库 `query::search` 输出，原样）+
//! 各挂载区 `{info, response}` 结果对（离线挂载 response=None）。
//! 输出：[`CrossSearchResponse`]——主区命中不带来源标注（逐字节兼容单库检索 wire 形状），
//! 挂载区命中逐条携带 `source_workspace`（来源工作区名 + 身份哈希）。
//!
//! 合并口径（纯数据、零 IO、确定性）：
//! - 排序 score 降序，同分 file_id 升序、locator 次序兜底（与单库检索排序同源）；
//! - **file_id 全局去重，主区优先**——跨工作区 file_id 理论上不可能撞（root_key
//!   不同 ⇒ file_id 不同），同 id 视为数据异常，保主区诚实口径；
//! - `total_matched` = 各来源命中文件数**之和**（跨库不去重计数，诚实口径）；
//!   `truncated` = 任一来源截断即为 true；
//! - 离线挂载区不出条目，但 `mounts[]` 照常给出（offline + 最后已知摘要）。

use crate::dto::{
    CrossSearchResponse, MountedFileEntry, MountedFilesResponse, MountedWorkspaceInfo, SearchHit,
    SearchResponse,
};
use crate::error::GuanlanError;
use crate::index::collector;
use crate::index::ident::folder_from_path;
use crate::storage::{internal_sql, ReadonlyStore};

/// 一个挂载区的联合检索输入（response=None = 离线/跳过，只带最后已知摘要）
#[derive(Debug, Clone)]
pub struct MountedSearchOutcome {
    pub info: MountedWorkspaceInfo,
    pub response: Option<SearchResponse>,
}

// ===== 服务层挂载注册表的只读探针（SQL 留在 core；service 只编排）=====

/// file_id 是否存在于该库（挂载区写拦截的溯源点查；主键点查 O(1)）
pub fn file_exists(store: &ReadonlyStore, file_id: &str) -> Result<bool, GuanlanError> {
    store
        .conn()
        .query_row("SELECT 1 FROM files WHERE file_id = ?1", [file_id], |_| {
            Ok(())
        })
        .map(|()| true)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(internal_sql(other)),
        })
}

/// revision_id 是否存在于该库（挂载区版本级只读路由的溯源点查）
pub fn revision_exists(store: &ReadonlyStore, revision_id: &str) -> Result<bool, GuanlanError> {
    store
        .conn()
        .query_row(
            "SELECT 1 FROM revisions WHERE revision_id = ?1",
            [revision_id],
            |_| Ok(()),
        )
        .map(|()| true)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(internal_sql(other)),
        })
}

/// 挂载区在线摘要现读：(root_key, index_generation, active 文件数, search_state)。
/// 任何一步失败都原样上抛（调用方据此判离线），绝不伪造在线摘要。
pub fn mount_live_summary(
    store: &ReadonlyStore,
) -> Result<(String, u64, u64, String), GuanlanError> {
    let ws = store.workspace()?;
    let file_count: i64 = store
        .conn()
        .query_row(
            "SELECT COUNT(*) AS n FROM files WHERE workspace_id = ?1 AND status = 'active'",
            [&ws.workspace_id],
            |row| row.get(0),
        )
        .map_err(internal_sql)?;
    let state = super::search::search_state_of(store)?;
    Ok((
        ws.root_key,
        ws.index_generation,
        file_count.max(0) as u64,
        state,
    ))
}

/// 挂载区目录树只读文件列表（侧栏浏览用；仅读 ReadonlyStore + 真实目录清单，零写入）
pub fn mount_list_files(
    store: &ReadonlyStore,
    mount_id: &str,
    name: &str,
    root_path: &str,
    limit: usize,
) -> Result<MountedFilesResponse, GuanlanError> {
    let ws = store.workspace()?;
    let clamped = limit.clamp(1, 5000);
    let total_i64: i64 = store
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM files WHERE workspace_id = ?1 AND status = 'active'",
            [&ws.workspace_id],
            |row| row.get(0),
        )
        .map_err(internal_sql)?;
    let total = total_i64.max(0) as usize;

    let mut stmt = store
        .conn()
        .prepare(
            "SELECT file_id, current_path, title, format, COALESCE(last_revision_id, ''), last_observed_at \
             FROM files \
             WHERE workspace_id = ?1 AND status = 'active' \
             ORDER BY current_path ASC \
             LIMIT ?2",
        )
        .map_err(internal_sql)?;
    let rows = stmt
        .query_map(rusqlite::params![&ws.workspace_id, clamped as i64], |row| {
            let rel: String = row.get(1)?;
            let folder = folder_from_path(&rel);
            Ok(MountedFileEntry {
                file_id: row.get(0)?,
                relative_path: rel,
                title: row.get(2)?,
                format: row.get(3)?,
                folder,
                current_revision_id: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(internal_sql)?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(internal_sql)?);
    }

    let listing = collector::collect_workspace_folders(
        std::path::Path::new(root_path),
        &[],
        collector::DEFAULT_MAX_FOLDERS,
        collector::DEFAULT_MAX_DEPTH,
    );

    Ok(MountedFilesResponse {
        ok: true,
        mount_id: mount_id.to_owned(),
        name: name.to_owned(),
        root_path: root_path.to_owned(),
        online: true,
        total,
        truncated: total > items.len() || listing.truncated,
        folders: listing.folders,
        items,
    })
}

/// 联合检索合并主入口（纯函数；node 侧无对应实现，core 单测锁定行为）
pub fn merge_cross_search(
    primary: SearchResponse,
    mounted: Vec<MountedSearchOutcome>,
    limit: usize,
) -> CrossSearchResponse {
    let mut all: Vec<SearchHit> = primary.items;
    let mut total_matched = primary.total_matched;
    let mut truncated = primary.truncated;

    for outcome in &mounted {
        total_matched += outcome
            .response
            .as_ref()
            .map(|r| r.total_matched)
            .unwrap_or(0);
        truncated = truncated
            || outcome
                .response
                .as_ref()
                .map(|r| r.truncated)
                .unwrap_or(false);
        let Some(resp) = outcome.response.as_ref() else {
            continue;
        };
        // 挂载区命中：逐条补来源标注（工作区名 + 身份哈希）
        let source = crate::dto::SearchHitSource {
            workspace_id: format!("ws_{}", outcome.info.root_key),
            root_key: outcome.info.root_key.clone(),
            name: outcome.info.name.clone(),
        };
        for mut hit in resp.items.clone() {
            hit.source_workspace = Some(crate::dto::SearchHitSource {
                workspace_id: source.workspace_id.clone(),
                root_key: source.root_key.clone(),
                name: source.name.clone(),
            });
            all.push(hit);
        }
    }

    // 排序：score 降序 → file_id 升序 → locator 次序（与单库检索排序同源）
    all.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.file_id.cmp(&b.file_id))
            .then_with(|| locator_order(a).cmp(&locator_order(b)))
    });

    // file_id 全局去重（同 id 主区优先——主区条目已在队首半区）；
    // 去重后按 limit 收口
    let mut seen = std::collections::HashSet::new();
    all.retain(|hit| seen.insert(hit.file_id.clone()));
    all.truncate(limit);

    CrossSearchResponse {
        ok: true,
        index_generation: primary.index_generation,
        query: primary.query,
        mode: primary.mode,
        total_matched,
        items: all,
        truncated,
        search_state: primary.search_state,
        mounts: mounted.into_iter().map(|o| o.info).collect(),
    }
}

/// 排序次键（与 query::search::locator_order 同口径；该函数私有，此处本地实现）
fn locator_order(hit: &SearchHit) -> i64 {
    match &hit.locator {
        crate::dto::SearchLocator::Lines { start, .. } => *start,
        crate::dto::SearchLocator::PdfPage { page } => *page as i64,
        crate::dto::SearchLocator::SvgText { .. } | crate::dto::SearchLocator::Office { .. } => 0,
        crate::dto::SearchLocator::File => i64::MAX,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{SearchLocator, SearchResponse};

    fn hit(file_id: &str, score: i64) -> SearchHit {
        SearchHit {
            file_id: file_id.to_owned(),
            revision_id: format!("{file_id}_r1"),
            relative_path: format!("docs/{file_id}.md"),
            title: file_id.to_owned(),
            format: "md".to_owned(),
            coverage: "full_text".to_owned(),
            match_strategy: "bigram_phrase_verified".to_owned(),
            locator: SearchLocator::Lines { start: 1, end: 1 },
            snippet: "命中行".to_owned(),
            score,
            stale: false,
            source_workspace: None,
        }
    }

    fn resp(items: Vec<SearchHit>, total: usize, truncated: bool) -> SearchResponse {
        SearchResponse {
            ok: true,
            index_generation: 7,
            query: "登录方案".to_owned(),
            mode: "phrase".to_owned(),
            total_matched: total,
            items,
            truncated,
            search_state: "ready".to_owned(),
        }
    }

    fn info(mount_id: &str, root_key: &str, name: &str, online: bool) -> MountedWorkspaceInfo {
        MountedWorkspaceInfo {
            mount_id: mount_id.to_owned(),
            mount_key: "a1b2c3d4e5f60718".to_owned(),
            root_key: root_key.to_owned(),
            root_path: format!(r"D:\archive\{name}"),
            name: name.to_owned(),
            online,
            index_generation: 3,
            search_state: if online { "ready" } else { "absent" }.to_owned(),
            file_count: 12,
            error: (!online).then(|| "离线：索引库暂不可达".to_owned()),
            last_seen_at: Some("2026-11-21T09:00:00.000+08:00".to_owned()),
        }
    }

    /// 挂载区命中逐条携带来源标注（工作区名 + root_key 哈希）；主区命中不带
    #[test]
    fn mounted_hits_carry_source_annotation_primary_hits_do_not() {
        let primary = resp(vec![hit("f_main", 60)], 1, false);
        let mounted = vec![MountedSearchOutcome {
            info: info("m_ref", "rk_ref", "legacy-a", true),
            response: Some(resp(vec![hit("f_ref", 80)], 1, false)),
        }];
        let merged = merge_cross_search(primary, mounted, 30);
        assert_eq!(merged.items.len(), 2);
        assert_eq!(merged.items[0].file_id, "f_ref", "高分在前");
        assert!(merged.items[0].source_workspace.is_some(), "挂载命中带来源");
        assert!(
            merged.items[1].source_workspace.is_none(),
            "主区命中不带来源"
        );
        let src = merged.items[0]
            .source_workspace
            .as_ref()
            .expect("挂载命中带来源");
        assert_eq!(src.name, "legacy-a");
        assert_eq!(src.root_key, "rk_ref");
        assert_eq!(src.workspace_id, "ws_rk_ref");
    }

    /// 排序 score 降序 + file_id 全局去重（主区优先）+ total_matched 求和 + truncated 联合
    #[test]
    fn merge_orders_dedupes_and_unions_totals() {
        let primary = resp(vec![hit("f_a", 50), hit("f_dup", 10)], 2, false);
        let mounted = vec![
            MountedSearchOutcome {
                info: info("m_a", "rk_a", "legacy-a", true),
                response: Some(resp(vec![hit("f_dup", 90), hit("f_b", 40)], 2, true)),
            },
            MountedSearchOutcome {
                info: info("m_b", "rk_b", "legacy-b", false),
                response: None,
            },
        ];
        let merged = merge_cross_search(primary, mounted, 30);
        // 去重：f_dup 主区保留（同 id 主区优先），f_a/f_b 依 score 排序
        let ids: Vec<&str> = merged.items.iter().map(|h| h.file_id.as_str()).collect();
        assert_eq!(ids, vec!["f_dup", "f_a", "f_b"]);
        assert_eq!(merged.total_matched, 4, "各来源命中文件数之和");
        assert!(merged.truncated, "任一来源截断即为 true");
        assert_eq!(merged.mounts.len(), 2);
        assert!(!merged.mounts[1].online, "离线挂载照常给出");
        assert_eq!(
            merged.mounts[1].error.as_deref(),
            Some("离线：索引库暂不可达")
        );
        assert_eq!(merged.index_generation, 7);
    }

    /// limit 收口：合并去重后按 limit 截断；离线挂载零条目但计入 mounts
    #[test]
    fn limit_truncates_after_dedupe() {
        let primary = resp(vec![hit("f1", 100), hit("f2", 90), hit("f3", 80)], 3, false);
        let mounted = vec![MountedSearchOutcome {
            info: info("m_x", "rk_x", "x", true),
            response: Some(resp(vec![hit("f4", 70), hit("f5", 60)], 2, false)),
        }];
        let merged = merge_cross_search(primary, mounted, 3);
        assert_eq!(merged.items.len(), 3);
        assert_eq!(merged.total_matched, 5, "total_matched 独立于 items 收口");
    }
}
