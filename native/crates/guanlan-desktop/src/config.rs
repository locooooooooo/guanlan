//! 桌面壳配置与最近工作区持久化（`desktop.json`）。
//!
//! 职责：
//! - 向后兼容读取 `{ "lastRoot": "..." }` 旧格式；
//! - 维护最近工作区列表（去重、最多 10 条、按最近打开时间倒序）；
//! - 零配置首启：无 `GUANLAN_WORKSPACE_ROOT` 且 `desktop.json` 无有效目录时返回 `None`，
//!   由前端渲染零配置首启引导（彻底移除硬编码 `DEFAULT_ROOT`）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "desktop.json";
pub const MAX_RECENT_WORKSPACES: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspaceEntry {
    pub root: String,
    pub name: String,
    pub last_opened_at: String,
}

/// 全局呼出热键默认值（`desktop.json` 的 `hotkey` 字段可覆盖——
/// 必须支持用户配置，禁止硬编码抢占系统常规快捷键）。
pub const DEFAULT_HOTKEY: &str = "alt+k";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    #[serde(default)]
    pub last_root: Option<String>,
    #[serde(default)]
    pub recent_workspaces: Vec<RecentWorkspaceEntry>,
    /// 全局呼出热键（如 "alt+k" / "ctrl+shift+p"）；None = 默认值。
    /// 非法值在注册处告警并回退默认（parse_hotkey 校验）。
    #[serde(default)]
    pub hotkey: Option<String>,
}

/// 供前端消费的最近工作区视图（附带磁盘目录是否仍存在的真实探测）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspaceStatus {
    pub root: String,
    pub name: String,
    pub last_opened_at: String,
    pub exists: bool,
}

/// 配置文件路径：支持 `GUANLAN_DESKTOP_CONFIG` 显式覆盖（单测隔离），
/// 否则落在 `%LOCALAPPDATA%/Guanlan/desktop.json`。
pub fn default_config_path() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("GUANLAN_DESKTOP_CONFIG") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    #[cfg(windows)]
    {
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|base| PathBuf::from(base).join("Guanlan").join(CONFIG_FILE))
    }
    #[cfg(not(windows))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            if !xdg.trim().is_empty() {
                return Some(PathBuf::from(xdg).join("guanlan").join(CONFIG_FILE));
            }
        }
        std::env::var("HOME").ok().map(|home| {
            PathBuf::from(home)
                .join(".config")
                .join("guanlan")
                .join(CONFIG_FILE)
        })
    }
}

/// 从路径提取展示名称（末段目录名）。
pub fn workspace_display_name(root: &str) -> String {
    let trimmed = root.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return root.trim().to_owned();
    }
    Path::new(trimmed)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| trimmed.to_owned())
}

/// 去重比较键：统一正斜杠、去掉尾斜杠（Windows 下大小写不敏感）。
pub fn normalize_dedup_key(root: &str) -> String {
    let slash = root.trim().replace('\\', "/");
    let stripped = if slash.len() > 1 {
        slash.trim_end_matches('/')
    } else {
        slash.as_str()
    };
    #[cfg(windows)]
    {
        stripped.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        stripped.to_owned()
    }
}

pub fn read_config_at(path: Option<&Path>) -> DesktopConfig {
    let Some(path) = path else {
        return DesktopConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return DesktopConfig::default();
    };
    serde_json::from_str::<DesktopConfig>(&text).unwrap_or_default()
}

pub fn write_config_at(path: Option<&Path>, config: &DesktopConfig) {
    let Some(path) = path else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(path, json);
    }
}

/// 从命令行参数解析初始打开目录（承接 Windows 资源管理器右键「用观澜打开此文件夹」）。
/// 支持两种形式：`guanlan-desktop --open "<目录>"` 或位置参数 `guanlan-desktop "<目录>"`。
pub fn parse_cli_startup_dir(args: &[String]) -> Option<String> {
    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].trim();
        if arg == "--open" || arg == "--workspace" || arg == "--root" {
            if let Some(next) = args.get(idx + 1) {
                let candidate = next.trim();
                if !candidate.is_empty() && Path::new(candidate).is_dir() {
                    return Some(candidate.to_owned());
                }
            }
            idx += 2;
            continue;
        }
        if !arg.starts_with('-') && !arg.is_empty() && Path::new(arg).is_dir() {
            return Some(arg.to_owned());
        }
        idx += 1;
    }
    None
}

/// 解析启动工作区（优先级：命令行右键/位置目录 > `GUANLAN_WORKSPACE_ROOT` > `desktop.json` 中仍然存在的 `lastRoot`）。
/// 不再使用硬编码缺省目录——无配置时返回 `None`，触发零配置首启引导。
pub fn resolve_startup_root_with_args(path: Option<&Path>, cli_args: &[String]) -> Option<String> {
    if let Some(cli_dir) = parse_cli_startup_dir(cli_args) {
        return Some(cli_dir);
    }
    resolve_startup_root(path)
}

/// 解析启动工作区：仅认 `GUANLAN_WORKSPACE_ROOT` 环境变量或 `desktop.json` 中仍然存在的 `lastRoot`。
/// 不再使用硬编码缺省目录——无配置时返回 `None`，触发零配置首启引导。
pub fn resolve_startup_root(path: Option<&Path>) -> Option<String> {
    if let Ok(env_root) = std::env::var("GUANLAN_WORKSPACE_ROOT") {
        let trimmed = env_root.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    let cfg = read_config_at(path);
    cfg.last_root
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty() && Path::new(s).is_dir())
}

/// 记录刚接入的工作区（置顶去重、截断至 `MAX_RECENT_WORKSPACES` 并落盘）。
pub fn record_workspace_opened(
    path: Option<&Path>,
    root: &str,
    opened_at_iso: String,
) -> DesktopConfig {
    let mut cfg = read_config_at(path);
    let key = normalize_dedup_key(root);
    let mut next_recent = Vec::with_capacity(MAX_RECENT_WORKSPACES);
    next_recent.push(RecentWorkspaceEntry {
        root: root.to_owned(),
        name: workspace_display_name(root),
        last_opened_at: opened_at_iso,
    });
    for item in cfg.recent_workspaces {
        if normalize_dedup_key(&item.root) == key {
            continue;
        }
        next_recent.push(item);
        if next_recent.len() >= MAX_RECENT_WORKSPACES {
            break;
        }
    }
    cfg.last_root = Some(root.to_owned());
    cfg.recent_workspaces = next_recent;
    write_config_at(path, &cfg);
    cfg
}

/// 从最近列表移除指定工作区；若刚好是 `last_root` 则清为下一个最近项或 `None`。
pub fn remove_recent_workspace_at(path: Option<&Path>, root: &str) -> DesktopConfig {
    let mut cfg = read_config_at(path);
    let key = normalize_dedup_key(root);
    cfg.recent_workspaces
        .retain(|item| normalize_dedup_key(&item.root) != key);
    if cfg
        .last_root
        .as_deref()
        .is_some_and(|last| normalize_dedup_key(last) == key)
    {
        cfg.last_root = cfg.recent_workspaces.first().map(|e| e.root.clone());
    }
    write_config_at(path, &cfg);
    cfg
}

/// 组装带 `exists` 标记的最近工作区列表（兼容仅存 `lastRoot` 的旧配置文件）。
pub fn recent_statuses(cfg: &DesktopConfig) -> Vec<RecentWorkspaceStatus> {
    let mut out: Vec<RecentWorkspaceStatus> = cfg
        .recent_workspaces
        .iter()
        .map(|entry| RecentWorkspaceStatus {
            root: entry.root.clone(),
            name: if entry.name.is_empty() {
                workspace_display_name(&entry.root)
            } else {
                entry.name.clone()
            },
            last_opened_at: entry.last_opened_at.clone(),
            exists: Path::new(&entry.root).is_dir(),
        })
        .collect();
    if let Some(last) = cfg.last_root.as_deref().filter(|s| !s.trim().is_empty()) {
        let key = normalize_dedup_key(last);
        if !out.iter().any(|e| normalize_dedup_key(&e.root) == key) {
            out.insert(
                0,
                RecentWorkspaceStatus {
                    root: last.to_owned(),
                    name: workspace_display_name(last),
                    last_opened_at: String::new(),
                    exists: Path::new(last).is_dir(),
                },
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("guanlan-desktop-cfg-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn zero_config_returns_none_without_hardcoded_default() {
        let dir = TempDir::new("zero");
        let cfg_path = dir.0.join("desktop.json");
        assert!(resolve_startup_root(Some(&cfg_path)).is_none());

        std::fs::write(
            &cfg_path,
            r#"{ "lastRoot": "Z:/never/exists/guanlan-missing" }"#,
        )
        .expect("写配置");
        assert!(resolve_startup_root(Some(&cfg_path)).is_none());
    }

    #[test]
    fn legacy_last_root_and_recent_dedup_and_remove() {
        let dir = TempDir::new("recent");
        let ws1 = dir.0.join("proj-one");
        let ws2 = dir.0.join("proj-two");
        std::fs::create_dir_all(&ws1).unwrap();
        std::fs::create_dir_all(&ws2).unwrap();
        let cfg_path = dir.0.join("desktop.json");

        std::fs::write(
            &cfg_path,
            serde_json::json!({ "lastRoot": ws1.to_string_lossy() }).to_string(),
        )
        .unwrap();
        assert_eq!(
            resolve_startup_root(Some(&cfg_path)).as_deref(),
            Some(ws1.to_string_lossy().as_ref())
        );

        record_workspace_opened(
            Some(&cfg_path),
            &ws1.to_string_lossy(),
            "2026-11-18T10:00:00Z".into(),
        );
        record_workspace_opened(
            Some(&cfg_path),
            &ws2.to_string_lossy(),
            "2026-11-18T11:00:00Z".into(),
        );
        let ws1_alt = format!("{}/", ws1.to_string_lossy().replace('\\', "/"));
        let cfg = record_workspace_opened(Some(&cfg_path), &ws1_alt, "2026-11-18T12:00:00Z".into());
        assert_eq!(cfg.recent_workspaces.len(), 2);
        assert_eq!(cfg.recent_workspaces[0].name, "proj-one");
        assert_eq!(cfg.recent_workspaces[1].name, "proj-two");

        let after_remove = remove_recent_workspace_at(Some(&cfg_path), &ws1_alt);
        assert_eq!(after_remove.recent_workspaces.len(), 1);
        assert_eq!(
            after_remove.last_root.as_deref(),
            Some(ws2.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn recent_workspaces_caps_at_max() {
        let dir = TempDir::new("cap");
        let cfg_path = dir.0.join("desktop.json");
        for i in 0..(MAX_RECENT_WORKSPACES + 4) {
            let ws = dir.0.join(format!("ws-{i}"));
            std::fs::create_dir_all(&ws).unwrap();
            record_workspace_opened(
                Some(&cfg_path),
                &ws.to_string_lossy(),
                format!("2026-11-18T10:{i:02}:00Z"),
            );
        }
        let cfg = read_config_at(Some(&cfg_path));
        assert_eq!(cfg.recent_workspaces.len(), MAX_RECENT_WORKSPACES);
        assert_eq!(
            cfg.recent_workspaces[0].name,
            format!("ws-{}", MAX_RECENT_WORKSPACES + 3)
        );
    }
}
