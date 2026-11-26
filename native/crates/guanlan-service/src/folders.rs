//! 目录清单缓存。
//!
//! 目录枚举要 `read_dir` 整棵树（默认上限两万目录、深度 32）。把它放在只读连接的
//! 查询体里时，多项目并存会占满连接池：侧栏树、今日总览与目录选择器同时刷新时，
//! 检索和翻页会被拖到 `INDEX_BUSY`。这里把枚举挪出查询通道，按根路径缓存一小段时间，
//! 并在文件夹增删改移成功后主动失效。
//!
//! **读不全不等于没有**：本次枚举只要有一层目录读不到（`incomplete`），就不覆盖上一次
//! 成功枚举的结果；没有上一次结果时才返回这份清单，并把 `incomplete` 如实带出去。
//! 详见 `LESSONS.md` 的「读不全的时候」。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use guanlan_core::index::collector::{self, FolderListing};

const DEFAULT_TTL_MS: u64 = 3_000;

fn ttl_from_env() -> Duration {
    let millis = std::env::var("GUANLAN_FOLDER_CACHE_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_TTL_MS);
    Duration::from_millis(millis)
}

struct CacheEntry {
    at: Instant,
    listing: FolderListing,
}

/// 进程内目录清单缓存（按根路径分键）。
pub struct FolderInventoryCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
    ttl: Duration,
}

impl FolderInventoryCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl: ttl_from_env(),
        }
    }

    fn normalized_key(root_path: &str) -> String {
        root_path
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    }

    /// 取某根目录的清单；过期或首次访问时重新枚举。
    ///
    /// 枚举在锁内进行：同一时刻只跑一次遍历，避免总览、侧栏树与目录选择器同时刷新时
    /// 各扫一遍。单次遍历通常只有几十毫秒，跨项目排队可以接受。
    pub fn get(&self, root_path: &str) -> FolderListing {
        let key = Self::normalized_key(root_path);
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = entries.get(&key) {
            if entry.at.elapsed() < self.ttl {
                return entry.listing.clone();
            }
        }
        let fresh = collector::collect_workspace_folders(
            std::path::Path::new(root_path),
            &[],
            collector::DEFAULT_MAX_FOLDERS,
            collector::DEFAULT_MAX_DEPTH,
        );
        match entries.get(&key) {
            Some(previous) if fresh.incomplete && !previous.listing.incomplete => {
                eprintln!("guanlan 目录清单：{root_path} 本次有目录读不到，保留上一次结果");
                previous.listing.clone()
            }
            _ => {
                entries.insert(
                    key,
                    CacheEntry {
                        at: Instant::now(),
                        listing: fresh.clone(),
                    },
                );
                fresh
            }
        }
    }

    /// 文件夹增删改移成功后立即失效对应根目录的缓存。
    pub fn invalidate(&self, root_path: &str) {
        let key = Self::normalized_key(root_path);
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&key);
    }
}

impl Default for FolderInventoryCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_dir(root: &std::path::Path, rel: &str) {
        std::fs::create_dir_all(root.join(rel)).expect("建目录");
    }

    #[test]
    fn cache_returns_folders_and_invalidates_after_folder_mutation() {
        let base = std::env::temp_dir().join(format!("guanlan-folders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("建根");
        write_dir(&base, "docs");
        let root = base.to_string_lossy().replace('\\', "/");

        let cache = FolderInventoryCache::new();
        let first = cache.get(&root);
        assert!(first.folders.contains(&"docs".to_owned()), "{first:?}");
        assert!(!first.incomplete);

        write_dir(&base, "new-inbox");
        let cached = cache.get(&root);
        assert!(!cached.folders.contains(&"new-inbox".to_owned()));

        cache.invalidate(&root);
        let refreshed = cache.get(&root);
        assert!(
            refreshed.folders.contains(&"new-inbox".to_owned()),
            "失效后应重新枚举：{refreshed:?}"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unreadable_root_is_reported_incomplete_not_empty() {
        let cache = FolderInventoryCache::new();
        let missing =
            std::env::temp_dir().join(format!("guanlan-folders-missing-{}", std::process::id()));
        let listing = cache.get(&missing.to_string_lossy());
        assert!(listing.folders.is_empty());
        assert!(listing.incomplete, "根目录读不到必须如实标记不完整");
    }
}
