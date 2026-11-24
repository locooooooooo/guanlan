//! 观澜桌面壳（Tauri v2）：进程内嵌 `guanlan-service`，支持零配置首启引导、
//! 原生文件夹选择、多工作区秒切与平滑服务重绑、最近工作区持久化（`desktop.json`）
//! 及 `ROOT_IN_USE` 锁冲突友好恢复。
//!
//! 方案 §7「桌面壳不复制数据库与索引代码」：壳只启动/重绑/连接同一服务实现，
//! 工作区变更与停机时经 `RunningService::shutdown()` 释放端口、写线程、watcher 与排他锁。

// release 构建不弹控制台窗口；debug 构建保留终端便于看 stderr 诊断
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod folder_picker;
mod system_bridge;

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{DragDropEvent, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use config::{
    default_config_path, read_config_at, recent_statuses, record_workspace_opened,
    remove_recent_workspace_at, resolve_startup_root_with_args, workspace_display_name,
    RecentWorkspaceStatus,
};

struct ActiveWorkspace {
    root: String,
    root_key: String,
    service: guanlan_service::RunningService,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBridgeError {
    code: String,
    message: String,
    root: String,
    data_dir: Option<String>,
    lock_file_path: Option<String>,
    lock_info: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSessionState {
    /// `ready` | `unconfigured` | `root_in_use` | `error`
    status: String,
    endpoint: String,
    root: Option<String>,
    workspace_name: Option<String>,
    recent_workspaces: Vec<RecentWorkspaceStatus>,
    previous_root: Option<String>,
    error: Option<DesktopBridgeError>,
}

struct DesktopRuntime {
    config_path: Option<PathBuf>,
    active: tokio::sync::Mutex<Option<ActiveWorkspace>>,
    active_root_sync: RwLock<Option<String>>,
    active_hub_sync: RwLock<Option<std::sync::Arc<guanlan_service::projects::ProjectHub>>>,
    last_state: RwLock<DesktopSessionState>,
}

impl DesktopRuntime {
    fn new(config_path: Option<PathBuf>) -> Self {
        let recent = recent_statuses(&read_config_at(config_path.as_deref()));
        let initial = DesktopSessionState {
            status: "unconfigured".to_owned(),
            endpoint: String::new(),
            root: None,
            workspace_name: None,
            recent_workspaces: recent,
            previous_root: None,
            error: None,
        };
        Self {
            config_path,
            active: tokio::sync::Mutex::new(None),
            active_root_sync: RwLock::new(None),
            active_hub_sync: RwLock::new(None),
            last_state: RwLock::new(initial),
        }
    }

    fn projects_file_path(&self) -> Option<PathBuf> {
        self.config_path
            .as_deref()
            .and_then(|p| p.parent())
            .map(|dir| dir.join("projects.json"))
    }

    fn live_active_root(&self) -> Option<String> {
        if let Some(hub) = self.active_hub_sync.read().expect("项目Hub读锁").as_ref() {
            let root = hub.active_root_path();
            if !root.is_empty() {
                return Some(root);
            }
        }
        self.active_root_sync.read().expect("工作区根读锁").clone()
    }

    fn recent_list(&self) -> Vec<RecentWorkspaceStatus> {
        recent_statuses(&read_config_at(self.config_path.as_deref()))
    }

    /// C03：全局呼出热键配置（desktop.json `hotkey`；未配置返回 None → main 用默认值）
    fn hotkey_config(&self) -> Option<String> {
        read_config_at(self.config_path.as_deref())
            .hotkey
            .map(|h| h.trim().to_owned())
            .filter(|h| !h.is_empty())
    }

    fn set_state(&self, state: DesktopSessionState) -> DesktopSessionState {
        *self.last_state.write().expect("桌面状态写锁") = state.clone();
        state
    }

    fn current_state(&self) -> DesktopSessionState {
        let mut state = self.last_state.read().expect("桌面状态读锁").clone();
        state.recent_workspaces = self.recent_list();
        state
    }

    /// 切换（或首次接入）工作区：
    /// 1) 目录校验；2) 同工作区（同 rootKey）直接复用现役服务；
    /// 3) 先优雅关闭旧服务释放锁/端口/线程，再启动新服务；
    /// 4) 若新工作区遇 `ROOT_IN_USE`，回传锁诊断信息与 `previousRoot` 供恢复。
    async fn switch_to(
        &self,
        raw_root: &str,
    ) -> Result<DesktopSessionState, Box<DesktopBridgeError>> {
        let root = raw_root.trim().to_owned();
        if root.is_empty() || !Path::new(&root).is_dir() {
            return Err(Box::new(DesktopBridgeError {
                code: "NOT_FOUND".to_owned(),
                message: format!("工作区目录不存在或不可访问：{root}"),
                root,
                data_dir: None,
                lock_file_path: None,
                lock_info: None,
            }));
        }
        let target_key = guanlan_service::runtime::workspace_root_key(&root).map_err(|e| {
            Box::new(DesktopBridgeError {
                code: "INTERNAL".to_owned(),
                message: e.to_string(),
                root: root.clone(),
                data_dir: None,
                lock_file_path: None,
                lock_info: None,
            })
        })?;

        let mut active_guard = self.active.lock().await;
        if let Some(current) = active_guard.as_ref() {
            if current.root_key == target_key {
                let state = DesktopSessionState {
                    status: "ready".to_owned(),
                    endpoint: current.service.endpoint.clone(),
                    root: Some(current.root.clone()),
                    workspace_name: Some(workspace_display_name(&current.root)),
                    recent_workspaces: self.recent_list(),
                    previous_root: None,
                    error: None,
                };
                return Ok(self.set_state(state));
            }
        }

        let previous_root = active_guard.as_ref().map(|a| a.root.clone());
        if let Some(prev) = active_guard.take() {
            *self.active_root_sync.write().expect("工作区根写锁") = None;
            *self.active_hub_sync.write().expect("项目Hub写锁") = None;
            prev.service.shutdown().await;
        }

        match guanlan_service::start_service_with_projects_file(
            guanlan_service::ServeConfig {
                root: root.clone(),
                port: 0,
                cors_desktop: true,
                background_index: true,
            },
            self.projects_file_path(),
        )
        .await
        {
            Ok(svc) => {
                eprintln!(
                    "guanlan-desktop 已接入工作区 instance_id={} endpoint={} root={}",
                    svc.instance_id, svc.endpoint, root
                );
                let cfg = record_workspace_opened(
                    self.config_path.as_deref(),
                    &root,
                    now_utc_rfc3339_approx(),
                );
                let endpoint = svc.endpoint.clone();
                *self.active_root_sync.write().expect("工作区根写锁") = Some(root.clone());
                *self.active_hub_sync.write().expect("项目Hub写锁") = Some(svc.projects_hub());
                *active_guard = Some(ActiveWorkspace {
                    root: root.clone(),
                    root_key: target_key,
                    service: svc,
                });
                let state = DesktopSessionState {
                    status: "ready".to_owned(),
                    endpoint,
                    root: Some(root.clone()),
                    workspace_name: Some(workspace_display_name(&root)),
                    recent_workspaces: recent_statuses(&cfg),
                    previous_root: None,
                    error: None,
                };
                Ok(self.set_state(state))
            }
            Err(err) => {
                let (data_dir, lock_file_path, lock_info) =
                    match guanlan_service::runtime::workspace_lock_context(&root) {
                        Ok((d, l, info)) => (
                            Some(d.to_string_lossy().into_owned()),
                            Some(l.to_string_lossy().into_owned()),
                            info,
                        ),
                        Err(_) => (None, None, None),
                    };
                let is_root_in_use = matches!(err, guanlan_service::GuanlanError::RootInUse);
                let code = if is_root_in_use {
                    "ROOT_IN_USE".to_owned()
                } else {
                    "INTERNAL".to_owned()
                };
                let status = if is_root_in_use {
                    "root_in_use".to_owned()
                } else {
                    "error".to_owned()
                };
                let bridge_err = DesktopBridgeError {
                    code,
                    message: err.to_string(),
                    root: root.clone(),
                    data_dir,
                    lock_file_path,
                    lock_info,
                };
                let state = DesktopSessionState {
                    status,
                    endpoint: String::new(),
                    root: Some(root.clone()),
                    workspace_name: Some(workspace_display_name(&root)),
                    recent_workspaces: self.recent_list(),
                    previous_root,
                    error: Some(bridge_err),
                };
                Ok(self.set_state(state))
            }
        }
    }

    async fn shutdown_active(&self) {
        let mut active_guard = self.active.lock().await;
        *self.active_root_sync.write().expect("工作区根写锁") = None;
        *self.active_hub_sync.write().expect("项目Hub写锁") = None;
        if let Some(prev) = active_guard.take() {
            prev.service.shutdown().await;
        }
    }

    /// 外部文件拖入工作区指定相对目录并立即触发增量索引（< 500ms 出现在今日时间主干）。
    async fn import_external_files(
        &self,
        source_paths: Vec<String>,
        target_dir: String,
    ) -> Result<system_bridge::ImportExternalFilesResult, system_bridge::BridgeActionError> {
        let active_root = self.live_active_root().ok_or_else(|| {
            system_bridge::BridgeActionError::new(
                "NO_WORKSPACE",
                "当前尚未接入工作区，无法导入文件",
            )
        })?;

        let root_path = PathBuf::from(&active_root);
        let mut result = tokio::task::spawn_blocking(move || {
            system_bridge::import_external_files_impl(&root_path, &target_dir, &source_paths)
        })
        .await
        .map_err(|e| {
            system_bridge::BridgeActionError::new("IO", format!("导入任务执行异常：{e}"))
        })??;

        if !result.indexed_relative_paths.is_empty() {
            let guard = self.active.lock().await;
            if let Some(active) = guard.as_ref() {
                result.job_id = active
                    .service
                    .submit_changed_paths(result.indexed_relative_paths.clone());
            }
        }
        Ok(result)
    }
}

fn now_utc_rfc3339_approx() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简化 UTC ISO 时间戳（仅供 desktop.json 最近打开排序展示）
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hh = rem / 3_600;
    let mm = (rem % 3_600) / 60;
    let ss = rem % 60;
    // Howard Hinnant civil-from-days
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn build_init_script(initial_state: &DesktopSessionState) -> String {
    let boot_json = serde_json::to_string(initial_state)
        .unwrap_or_else(|_| "{}".to_owned())
        .replace('<', "\\u003c");
    let api_json = serde_json::to_string(&initial_state.endpoint)
        .unwrap_or_else(|_| "\"\"".to_owned())
        .replace('<', "\\u003c");
    format!("window.__GUANLAN_API__ = {api_json};\nwindow.__GUANLAN_BOOT__ = {boot_json};\n{SAVE_BRIDGE_JS}")
}

fn dispatch_native_drag_drop(window: &tauri::WebviewWindow, drop_event: &DragDropEvent) {
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    let payload = match drop_event {
        DragDropEvent::Enter { paths, position } => serde_json::json!({
            "kind": "enter",
            "paths": paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "x": position.x / scale,
            "y": position.y / scale,
        }),
        DragDropEvent::Over { position } => serde_json::json!({
            "kind": "over",
            "x": position.x / scale,
            "y": position.y / scale,
        }),
        DragDropEvent::Drop { paths, position } => serde_json::json!({
            "kind": "drop",
            "paths": paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "x": position.x / scale,
            "y": position.y / scale,
        }),
        DragDropEvent::Leave => serde_json::json!({
            "kind": "leave",
        }),
        _ => return,
    };
    let json = payload.to_string().replace('<', "\\u003c");
    let script = format!(
        "window.dispatchEvent(new CustomEvent('guanlan:native-drag-drop', {{ detail: {json} }}));"
    );
    let _ = window.eval(&script);
}

// ===== C03：全局呼出热键（Ctrl+K 面板唤起；desktop.json `hotkey` 可配置）=====

/// 热键配置解析（纯函数，单测锁定）：
/// - 形如 `"mod+mod+key"`，修饰符白名单 ctrl/control/alt/shift/super（大小写无关）；
/// - 主键：单个字母/数字、F1–F12；
/// - 输出小写规范化串（`ctrl` 归一为 `control`，与 tauri-plugin-global-shortcut
///   的 Shortcut 解析口径一致）；非法输入返回 Err（注册处告警并回退默认值）。
fn parse_hotkey(raw: &str) -> Result<String, String> {
    let parts: Vec<&str> = raw
        .split('+')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err(format!("热键至少需要一个修饰符与一个主键：{raw:?}"));
    }
    let mut modifiers: Vec<&str> = Vec::new();
    let key = parts[parts.len() - 1];
    for part in &parts[..parts.len() - 1] {
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "ctrl" | "control" => modifiers.push("control"),
            "alt" | "option" => modifiers.push("alt"),
            "shift" => modifiers.push("shift"),
            "super" | "cmd" | "command" | "win" => modifiers.push("super"),
            other => return Err(format!("未知修饰符 {other:?}（热键 {raw:?}）")),
        }
    }
    modifiers.dedup();
    let key_lower = key.to_ascii_lowercase();
    let key_ok = (key_lower.len() == 1
        && key_lower
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric()))
        || (key_lower.len() >= 2
            && key_lower.starts_with('f')
            && key_lower[1..].bytes().all(|b| b.is_ascii_digit())
            && key_lower[1..]
                .parse::<u32>()
                .map(|n| (1..=12).contains(&n))
                .unwrap_or(false));
    if !key_ok {
        return Err(format!("非法主键 {key:?}（允许单字母/数字与 F1–F12）"));
    }
    if modifiers.is_empty() {
        return Err(format!("热键至少需要一个修饰符：{raw:?}"));
    }
    Ok(format!("{}+{}", modifiers.join("+"), key_lower))
}

/// 全局热键按下 → 唤起窗口并转发 CustomEvent 给前端（镜像 dispatch_native_drag_drop
/// 的 eval 通道；前端 desktopBridge.subscribeGlobalShortcut 订阅打开命令面板）。
fn summon_and_notify(window: &tauri::WebviewWindow, hotkey: &str) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    let json = serde_json::json!({ "hotkey": hotkey })
        .to_string()
        .replace('<', "\\u003c");
    let script = format!(
        "window.dispatchEvent(new CustomEvent('guanlan:global-shortcut', {{ detail: {json} }}));"
    );
    let _ = window.eval(&script);
}

/// F03：构造 Windows 当前用户（HKCU，免 UAC 提权）资源管理器右键菜单「用观澜打开此文件夹」注册命令清单。
fn build_windows_context_menu_reg_args(exe_path: &str) -> Vec<Vec<String>> {
    let icon_val = format!("{exe_path},0");
    let dir_cmd = format!("\"{exe_path}\" --open \"%1\"");
    let bg_cmd = format!("\"{exe_path}\" --open \"%V\"");
    let keys = [
        (
            r"HKCU\Software\Classes\Directory\shell\GuanlanOpen",
            dir_cmd,
        ),
        (
            r"HKCU\Software\Classes\Directory\Background\shell\GuanlanOpen",
            bg_cmd,
        ),
    ];
    let mut cmds = Vec::new();
    for (root_key, open_cmd) in keys {
        cmds.push(vec![
            "add".to_owned(),
            root_key.to_owned(),
            "/ve".to_owned(),
            "/t".to_owned(),
            "REG_SZ".to_owned(),
            "/d".to_owned(),
            "用观澜打开此文件夹".to_owned(),
            "/f".to_owned(),
        ]);
        cmds.push(vec![
            "add".to_owned(),
            root_key.to_owned(),
            "/v".to_owned(),
            "Icon".to_owned(),
            "/t".to_owned(),
            "REG_SZ".to_owned(),
            "/d".to_owned(),
            icon_val.clone(),
            "/f".to_owned(),
        ]);
        cmds.push(vec![
            "add".to_owned(),
            format!(r"{root_key}\command"),
            "/ve".to_owned(),
            "/t".to_owned(),
            "REG_SZ".to_owned(),
            "/d".to_owned(),
            open_cmd,
            "/f".to_owned(),
        ]);
    }
    cmds
}

#[cfg(windows)]
fn set_windows_context_menu_impl(enabled: bool) -> Result<bool, String> {
    if enabled {
        let exe = std::env::current_exe()
            .map_err(|e| format!("无法获取当前可执行文件路径：{e}"))?
            .to_string_lossy()
            .into_owned();
        for args in build_windows_context_menu_reg_args(&exe) {
            let status = std::process::Command::new("reg.exe")
                .args(&args)
                .status()
                .map_err(|e| format!("调用 reg.exe 注册右键菜单失败：{e}"))?;
            if !status.success() {
                return Err(format!("reg.exe 返回非零退出码：{status}"));
            }
        }
        Ok(true)
    } else {
        for key in [
            r"HKCU\Software\Classes\Directory\shell\GuanlanOpen",
            r"HKCU\Software\Classes\Directory\Background\shell\GuanlanOpen",
        ] {
            let _ = std::process::Command::new("reg.exe")
                .args(["delete", key, "/f"])
                .status();
        }
        Ok(false)
    }
}

#[cfg(not(windows))]
fn set_windows_context_menu_impl(_enabled: bool) -> Result<bool, String> {
    Err("资源管理器右键菜单仅支持 Windows 平台".to_owned())
}

#[cfg(windows)]
fn is_windows_context_menu_registered() -> bool {
    std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Classes\Directory\shell\GuanlanOpen",
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_windows_context_menu_registered() -> bool {
    false
}

#[tauri::command]
fn get_windows_context_menu_status() -> bool {
    is_windows_context_menu_registered()
}

#[tauri::command]
fn set_windows_context_menu(enabled: bool) -> Result<bool, String> {
    set_windows_context_menu_impl(enabled)
}

/// 检查更新的结果。`status`：`available`（有新版本）、`up_to_date`、`not_configured`
/// （生产包暂未配置更新源，见 docs/subsystems/release-pipeline.md 的「自动更新」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateCheck {
    status: String,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    pub_date: Option<String>,
}

/// 更新源是否配置：`plugins.updater.endpoints` 非空。未配置时不去联网——插件在空
/// endpoints 上会返回 ReleaseNotFound，那不是「已是最新」，也不该当成错误弹出来。
fn updater_endpoints_configured(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .is_some_and(|endpoints| !endpoints.is_empty())
}

/// 把下载进度转成前端 CustomEvent（与拖拽、全局热键同一种注入方式，不用事件插件）。
fn emit_update_progress(
    window: &tauri::WebviewWindow,
    phase: &str,
    downloaded: u64,
    total: Option<u64>,
) {
    let total_js = total
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_owned());
    let script = format!(
        "window.dispatchEvent(new CustomEvent('guanlan:update-progress', {{ detail: {{ phase: '{phase}', downloaded: {downloaded}, total: {total_js} }} }}));"
    );
    let _ = window.eval(&script);
}

#[tauri::command]
async fn check_desktop_update(app: tauri::AppHandle) -> Result<DesktopUpdateCheck, String> {
    use tauri_plugin_updater::UpdaterExt;
    let current_version = app.package_info().version.to_string();
    if !updater_endpoints_configured(&app) {
        return Ok(DesktopUpdateCheck {
            status: "not_configured".to_owned(),
            current_version,
            version: None,
            notes: None,
            pub_date: None,
        });
    }
    let updater = app
        .updater()
        .map_err(|err| format!("UPDATER_NOT_READY: {err}"))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(DesktopUpdateCheck {
            status: "available".to_owned(),
            current_version,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            pub_date: update.date.map(|date| date.to_string()),
        }),
        Ok(None) => Ok(DesktopUpdateCheck {
            status: "up_to_date".to_owned(),
            current_version,
            version: None,
            notes: None,
            pub_date: None,
        }),
        Err(err) => Err(format!("UPDATE_CHECK_FAILED: {err}")),
    }
}

/// 下载并安装更新。Windows 上安装器启动后进程会退出（插件的行为），前端只需要把进度
/// 显示出来；安装器以 passive 模式运行（配置里的 installMode），不要求用户操作。
#[tauri::command]
async fn install_desktop_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    if !updater_endpoints_configured(&app) {
        return Err("UPDATE_NOT_CONFIGURED".to_owned());
    }
    let updater = app
        .updater()
        .map_err(|err| format!("UPDATER_NOT_READY: {err}"))?;
    let update = updater
        .check()
        .await
        .map_err(|err| format!("UPDATE_CHECK_FAILED: {err}"))?
        .ok_or_else(|| "UPDATE_NOT_AVAILABLE".to_owned())?;
    let progress_window = window.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                emit_update_progress(&progress_window, "downloading", downloaded, content_length);
            },
            move || emit_update_progress(&window, "installing", 0, None),
        )
        .await
        .map_err(|err| format!("UPDATE_INSTALL_FAILED: {err}"))?;
    // Windows 上安装器接管；其他平台按插件要求重启应用。
    #[cfg(not(windows))]
    app.restart();
    Ok(())
}

fn main() {
    let cli_args: Vec<String> = std::env::args().skip(1).collect();
    if cli_args.iter().any(|a| a == "--register-context-menu") {
        if let Err(err) = set_windows_context_menu_impl(true) {
            eprintln!("注册右键菜单失败：{err}");
            std::process::exit(1);
        }
        return;
    }
    if cli_args.iter().any(|a| a == "--unregister-context-menu") {
        if let Err(err) = set_windows_context_menu_impl(false) {
            eprintln!("清理右键菜单失败：{err}");
            std::process::exit(1);
        }
        return;
    }

    let runtime = DesktopRuntime::new(default_config_path());
    // C03：全局呼出热键（desktop.json `hotkey` 可配置；非法值回退默认并告警——
    // 可配置性是停机条件：抢占系统常规快捷键且不可配置即停）
    let hotkey_raw = runtime
        .hotkey_config()
        .unwrap_or_else(|| config::DEFAULT_HOTKEY.to_owned());
    let hotkey = parse_hotkey(&hotkey_raw).unwrap_or_else(|err| {
        eprintln!(
            "警告: 全局热键配置非法（{err}），回退默认 {}",
            config::DEFAULT_HOTKEY
        );
        config::DEFAULT_HOTKEY.to_owned()
    });
    let hotkey_for_handler = hotkey.clone();
    let app = tauri::Builder::default()
        .manage(runtime)
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app_handle, _shortcut, event| {
                    // 仅按下沿触发（松开沿忽略，避免双发）
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            summon_and_notify(&window, &hotkey_for_handler);
                        }
                    }
                })
                .build(),
        )
        // 应用内更新：插件读 tauri.conf.json 的 plugins.updater（公钥与 endpoints）。
        // 只注册 Rust 侧，前端经 __GUANLAN_UPDATE_BRIDGE__ 调下面的两个命令。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            save_workspace_file,
            get_desktop_state,
            pick_workspace_folder,
            pick_external_files,
            switch_workspace,
            remove_recent_workspace,
            reveal_in_explorer,
            open_with_default_app,
            write_clipboard_text,
            resolve_workspace_path,
            import_external_files,
            get_windows_context_menu_status,
            set_windows_context_menu,
            check_desktop_update,
            install_desktop_update
        ])
        .setup(move |app| {
            // 全局快捷键注册（解析失败的兜底值已保证合法；再失败仅告警不阻断启动）
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(err) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("警告: 全局热键 {hotkey} 注册失败：{err}（应用内 Ctrl+K 仍可用）");
            }
            let rt = app.state::<DesktopRuntime>();
            let initial_state =
                match resolve_startup_root_with_args(rt.config_path.as_deref(), &cli_args) {
                    Some(root) => match tauri::async_runtime::block_on(rt.switch_to(&root)) {
                        Ok(state) => state,
                        Err(err) => rt.set_state(DesktopSessionState {
                            status: "error".to_owned(),
                            endpoint: String::new(),
                            root: Some(root.clone()),
                            workspace_name: Some(workspace_display_name(&root)),
                            recent_workspaces: rt.recent_list(),
                            previous_root: None,
                            error: Some(*err),
                        }),
                    },
                    None => rt.current_state(),
                };
            let script = build_init_script(&initial_state);

            let main_window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("观澜")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 600.0)
                    .initialization_script(&script)
                    .build()?;
            let win_for_drop = main_window.clone();
            main_window.on_window_event(move |event| {
                if let WindowEvent::DragDrop(drop_ev) = event {
                    dispatch_native_drag_drop(&win_for_drop, drop_ev);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("观澜桌面壳初始化失败");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            let rt = app_handle.state::<DesktopRuntime>();
            tauri::async_runtime::block_on(rt.shutdown_active());
        }
    });
}

/// 决策回执与多工作区桥（与 __GUANLAN_API__ / __GUANLAN_BOOT__ 同批注入）：
/// 浏览器/CLI dev 环境无此桥；NOT_TAURI 兜底防误用。
const SAVE_BRIDGE_JS: &str = r#"
window.__GUANLAN_DESKTOP__ = true;
window.__GUANLAN_SAVE_FILE__ = function (req) {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.reject(new Error('NOT_TAURI'));
  }
  return window.__TAURI_INTERNALS__.invoke('save_workspace_file', { request: req });
};
window.__GUANLAN_WORKSPACE_BRIDGE__ = {
  getState: function () {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('get_desktop_state');
  },
  pickFolder: function () {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('pick_workspace_folder');
  },
  switchWorkspace: function (root) {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('switch_workspace', { root: root });
  },
  removeRecentWorkspace: function (root) {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('remove_recent_workspace', { root: root });
  }
};
window.__GUANLAN_SYSTEM_BRIDGE__ = {
  pickExternalFiles: function () {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('pick_external_files');
  },
  revealInExplorer: function (relativePath) {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('reveal_in_explorer', { relativePath: relativePath });
  },
  openWithDefaultApp: function (relativePath) {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('open_with_default_app', { relativePath: relativePath });
  },
  writeClipboardText: function (text) {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('write_clipboard_text', { text: text });
  },
  resolveWorkspacePath: function (relativePath) {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('resolve_workspace_path', { relativePath: relativePath });
  },
  importExternalFiles: function (sourcePaths, targetDir) {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('import_external_files', {
      sourcePaths: sourcePaths,
      targetDir: targetDir || ''
    });
  }
};
window.__GUANLAN_UPDATE_BRIDGE__ = {
  check: function () {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('check_desktop_update');
  },
  install: function () {
    if (!window.__TAURI_INTERNALS__) {
      return Promise.reject(new Error('NOT_TAURI'));
    }
    return window.__TAURI_INTERNALS__.invoke('install_desktop_update');
  }
};
"#;

#[tauri::command]
fn get_desktop_state(runtime: tauri::State<'_, DesktopRuntime>) -> DesktopSessionState {
    runtime.current_state()
}

fn owner_hwnd_of(window: &tauri::WebviewWindow) -> isize {
    #[cfg(windows)]
    {
        window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        0isize
    }
}

#[tauri::command]
async fn pick_workspace_folder(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    folder_picker::pick_workspace_folder_async(owner_hwnd_of(&window)).await
}

#[tauri::command]
async fn pick_external_files(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    folder_picker::pick_external_files_async(owner_hwnd_of(&window)).await
}

#[tauri::command]
async fn switch_workspace(
    runtime: tauri::State<'_, DesktopRuntime>,
    root: String,
) -> Result<DesktopSessionState, Box<DesktopBridgeError>> {
    runtime.switch_to(&root).await
}

#[tauri::command]
fn remove_recent_workspace(
    runtime: tauri::State<'_, DesktopRuntime>,
    root: String,
) -> Vec<RecentWorkspaceStatus> {
    let cfg = remove_recent_workspace_at(runtime.config_path.as_deref(), &root);
    recent_statuses(&cfg)
}

fn active_root_path(runtime: &DesktopRuntime) -> Result<PathBuf, system_bridge::BridgeActionError> {
    let Some(root) = runtime.live_active_root() else {
        return Err(system_bridge::BridgeActionError::new(
            "NO_WORKSPACE",
            "当前尚未接入工作区",
        ));
    };
    Ok(PathBuf::from(root))
}

#[tauri::command]
async fn reveal_in_explorer(
    runtime: tauri::State<'_, DesktopRuntime>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<system_bridge::BridgeActionOk, system_bridge::BridgeActionError> {
    let root = active_root_path(&runtime)?;
    let hwnd = owner_hwnd_of(&window);
    tokio::task::spawn_blocking(move || {
        system_bridge::reveal_in_explorer_impl(&root, &relative_path, hwnd)
    })
    .await
    .map_err(|e| system_bridge::BridgeActionError::new("IO", format!("系统定位线程异常：{e}")))?
}

#[tauri::command]
async fn open_with_default_app(
    runtime: tauri::State<'_, DesktopRuntime>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<system_bridge::BridgeActionOk, system_bridge::BridgeActionError> {
    let root = active_root_path(&runtime)?;
    let hwnd = owner_hwnd_of(&window);
    tokio::task::spawn_blocking(move || {
        system_bridge::open_with_default_app_impl(&root, &relative_path, hwnd)
    })
    .await
    .map_err(|e| {
        system_bridge::BridgeActionError::new("IO", format!("默认程序打开线程异常：{e}"))
    })?
}

#[tauri::command]
async fn write_clipboard_text(
    text: String,
) -> Result<system_bridge::BridgeActionOk, system_bridge::BridgeActionError> {
    tokio::task::spawn_blocking(move || system_bridge::write_clipboard_text_impl(&text))
        .await
        .map_err(|e| {
            system_bridge::BridgeActionError::new("IO", format!("剪贴板写入线程异常：{e}"))
        })?
}

#[tauri::command]
fn resolve_workspace_path(
    runtime: tauri::State<'_, DesktopRuntime>,
    relative_path: String,
) -> Result<String, system_bridge::BridgeActionError> {
    let root = active_root_path(&runtime)?;
    system_bridge::resolve_workspace_path_impl(&root, &relative_path)
}

#[tauri::command]
async fn import_external_files(
    runtime: tauri::State<'_, DesktopRuntime>,
    source_paths: Vec<String>,
    target_dir: String,
) -> Result<system_bridge::ImportExternalFilesResult, system_bridge::BridgeActionError> {
    runtime
        .import_external_files(source_paths, target_dir)
        .await
}

/// 保存回写请求（键名经 serde rename 对齐前端 camelCase）：
/// original_content 是前端展示时的原文快照（乐观并发基线），
/// new_content 是勾选/填空落笔后的完整新文本。
#[derive(Debug, Deserialize)]
struct SaveWorkspaceFileRequest {
    #[serde(rename = "relativePath")]
    relative_path: String,
    #[serde(rename = "originalContent")]
    original_content: String,
    #[serde(rename = "newContent")]
    new_content: String,
}

#[derive(Debug, Serialize)]
struct SaveWorkspaceFileOk {
    saved: bool,
    bytes: usize,
}

/// 结构化错误（前端按 code 分支承载：CONFLICT → 引导重开文档）
#[derive(Debug, Serialize)]
struct SaveWorkspaceFileErr {
    code: String,
    message: String,
}

impl SaveWorkspaceFileErr {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

/// CRLF 归一：比较与写回都以 LF 语义比对，避免 Windows 文本编辑器换行差异误报冲突
fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// 校验相对路径：拒绝绝对路径 / `..` 上跳 / 空段——WebView 侧输入不可信，
/// 绝不让相对路径逃出工作区根（路径穿越防线）。
fn validate_relative_path(relative_path: &str) -> Result<PathBuf, SaveWorkspaceFileErr> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err(SaveWorkspaceFileErr::new(
            "INVALID_PATH",
            "relative_path 为空",
        ));
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Err(SaveWorkspaceFileErr::new("INVALID_PATH", "拒绝绝对路径"));
    }
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err(SaveWorkspaceFileErr::new(
                    "INVALID_PATH",
                    "拒绝 `..` 上跳段",
                ));
            }
            std::path::Component::Normal(_) => {}
            _ => {
                return Err(SaveWorkspaceFileErr::new(
                    "INVALID_PATH",
                    format!("非法路径段：{component:?}"),
                ));
            }
        }
    }
    Ok(path)
}

/// 保存回写核心（纯函数便于单测）：乐观并发检查（磁盘内容 == 阅读快照）+
/// 临时文件写 + 原子 rename 落盘。冲突时不落任何字节。
fn save_workspace_file_impl(
    root: &Path,
    request: &SaveWorkspaceFileRequest,
) -> Result<SaveWorkspaceFileOk, SaveWorkspaceFileErr> {
    let relative = validate_relative_path(&request.relative_path)?;
    let target = root.join(relative);
    let disk = std::fs::read_to_string(&target)
        .map_err(|e| SaveWorkspaceFileErr::new("NOT_FOUND", format!("读取原文件失败：{e}")))?;
    if normalize_newlines(&disk) != normalize_newlines(&request.original_content) {
        return Err(SaveWorkspaceFileErr::new(
            "CONFLICT",
            "原文件已被外部修改（磁盘内容与阅读快照不一致）",
        ));
    }
    // 原子写：同目录临时文件 + rename 替换（Windows fs::rename 走
    // MOVEFILE_REPLACE_EXISTING，可直接覆盖已存在目标），失败不破坏原文件
    let dir = target
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let file_name = target
        .file_name()
        .map(std::ffi::OsStr::to_string_lossy)
        .unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(
        ".{file_name}.guanlan-save-{}.tmp",
        std::process::id()
    ));
    std::fs::write(&tmp, request.new_content.as_bytes())
        .map_err(|e| SaveWorkspaceFileErr::new("IO", format!("写临时文件失败：{e}")))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp); // 失败清理：不遗垃圾临时文件
        return Err(SaveWorkspaceFileErr::new(
            "IO",
            format!("原子替换失败：{e}"),
        ));
    }
    Ok(SaveWorkspaceFileOk {
        saved: true,
        bytes: request.new_content.len(),
    })
}

/// Tauri 命令：决策回执保存回写（读取当前活动工作区根，切工作区后自动指向新根）
#[tauri::command]
fn save_workspace_file(
    runtime: tauri::State<'_, DesktopRuntime>,
    request: SaveWorkspaceFileRequest,
) -> Result<SaveWorkspaceFileOk, SaveWorkspaceFileErr> {
    if runtime
        .active_hub_sync
        .read()
        .expect("项目Hub读锁")
        .as_ref()
        .is_some_and(|hub| hub.is_active_readonly())
    {
        return Err(SaveWorkspaceFileErr::new(
            "CROSS_WORKSPACE_FORBIDDEN",
            "当前项目已开启只读归档保护，禁止写回文件",
        ));
    }
    let Some(root) = runtime.live_active_root() else {
        return Err(SaveWorkspaceFileErr::new(
            "NO_WORKSPACE",
            "当前尚未接入工作区，无法回写文件",
        ));
    };
    save_workspace_file_impl(Path::new(&root), &request)
}

#[cfg(test)]
mod save_workspace_file_tests {
    use super::*;

    /// 独立临时目录（进程 id + 用例名隔离，跑完即清）
    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("guanlan-save-test-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("建临时目录");
            Self(dir)
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn request(relative: &str, original: &str, new: &str) -> SaveWorkspaceFileRequest {
        SaveWorkspaceFileRequest {
            relative_path: relative.to_owned(),
            original_content: original.to_owned(),
            new_content: new.to_owned(),
        }
    }

    #[test]
    fn writes_and_reports_bytes() {
        let root = TempRoot::new("ok");
        let doc = root.0.join("决策回执.md");
        std::fs::write(&doc, "□ A) 甲\n□ B) 乙").expect("种子文件");
        let outcome = save_workspace_file_impl(
            &root.0,
            &request("决策回执.md", "□ A) 甲\n□ B) 乙", "☑ A) 甲\n□ B) 乙"),
        );
        assert!(outcome.is_ok(), "{outcome:?}");
        assert_eq!(outcome.unwrap().bytes, "☑ A) 甲\n□ B) 乙".len());
        let disk = std::fs::read_to_string(&doc).expect("读回");
        assert_eq!(disk, "☑ A) 甲\n□ B) 乙");
    }

    #[test]
    fn conflict_when_disk_changed() {
        let root = TempRoot::new("conflict");
        let doc = root.0.join("决策回执.md");
        std::fs::write(&doc, "外部已改").expect("种子文件");
        let outcome =
            save_workspace_file_impl(&root.0, &request("决策回执.md", "阅读快照原文", "新内容"));
        let err = outcome.expect_err("必须冲突");
        assert_eq!(err.code, "CONFLICT");
        // 冲突不落任何字节
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "外部已改");
    }

    #[test]
    fn rejects_path_traversal() {
        let root = TempRoot::new("traversal");
        for evil in ["../逃逸.md", "a/../../b.md", "", "C:/abs/path.md"] {
            let outcome = save_workspace_file_impl(&root.0, &request(evil, "x", "y"));
            assert_eq!(
                outcome.expect_err(evil).code,
                "INVALID_PATH",
                "用例 {evil} 必须拒绝"
            );
        }
    }

    #[test]
    fn crlf_normalization_no_false_conflict() {
        let root = TempRoot::new("crlf");
        let doc = root.0.join("决策回执.md");
        std::fs::write(&doc, "□ A) 甲\r\n□ B) 乙").expect("种子 CRLF 文件");
        let outcome = save_workspace_file_impl(
            &root.0,
            &request("决策回执.md", "□ A) 甲\n□ B) 乙", "☑ A) 甲\n□ B) 乙"),
        );
        assert!(outcome.is_ok(), "CRLF 差异不得误报冲突：{outcome:?}");
    }

    #[tokio::test]
    async fn desktop_runtime_switches_three_workspaces_and_handles_root_in_use() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let base = TempRoot::new("rt");
        let cfg_path = base.0.join("desktop.json");
        let ws_a = base.0.join("alpha");
        let ws_b = base.0.join("beta");
        let ws_c = base.0.join("gamma");
        for (ws, label) in [(&ws_a, "Alpha"), (&ws_b, "Beta"), (&ws_c, "Gamma")] {
            std::fs::create_dir_all(ws).unwrap();
            for idx in 0..20 {
                std::fs::write(
                    ws.join(format!("doc-{idx:02}.md")),
                    format!("# {label} {idx}\n\n正文内容 {idx}\n"),
                )
                .unwrap();
            }
        }

        let rt = DesktopRuntime::new(Some(cfg_path.clone()));
        assert_eq!(rt.current_state().status, "unconfigured");
        assert!(rt.current_state().endpoint.is_empty());

        // 非法目录不得启动或破坏状态
        let bad = rt
            .switch_to(&base.0.join("missing").to_string_lossy())
            .await;
        assert_eq!(bad.expect_err("应报 NOT_FOUND").code, "NOT_FOUND");

        async fn http_get_bootstrap(endpoint: &str) -> (u16, String) {
            let addr = endpoint.trim_start_matches("http://");
            let mut stream = TcpStream::connect(addr).await.expect("连接服务");
            stream
                .write_all(
                    format!(
                        "GET /api/v1/bootstrap HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut resp = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                stream.read_to_string(&mut resp),
            )
            .await
            .expect("读取超时")
            .unwrap();
            let code = resp
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);
            (code, resp)
        }

        // 连续切换 A → B → C → A，并在存在活跃 SSE 长连接时验证平滑停机重绑与耗时
        let t_a = std::time::Instant::now();
        let s_a = rt.switch_to(&ws_a.to_string_lossy()).await.unwrap();
        let (code_a, body_a) = http_get_bootstrap(&s_a.endpoint).await;
        let ms_a = t_a.elapsed().as_millis();
        assert_eq!(s_a.status, "ready");
        assert_eq!(code_a, 200);
        assert!(body_a.contains("\"workspace_id\""));
        assert_eq!(s_a.workspace_name.as_deref(), Some("alpha"));

        // 模拟前端 EventSource 长连接驻留期间直接切工作区
        let addr_a = s_a.endpoint.trim_start_matches("http://").to_owned();
        let mut sse_conn = TcpStream::connect(&addr_a).await.expect("连接 SSE");
        sse_conn
            .write_all(
                format!(
                    "GET /api/v1/stream HTTP/1.1\r\nHost: {addr_a}\r\nAccept: text/event-stream\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut hello_acc = Vec::with_capacity(1024);
        let mut chunk = [0u8; 512];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "SSE hello 超时，已收内容: {}",
                String::from_utf8_lossy(&hello_acc)
            );
            let n = tokio::time::timeout(remaining, sse_conn.read(&mut chunk))
                .await
                .expect("SSE hello 超时")
                .unwrap();
            assert!(
                n > 0,
                "SSE 连接提前关闭，已收内容: {}",
                String::from_utf8_lossy(&hello_acc)
            );
            hello_acc.extend_from_slice(&chunk[..n]);
            if std::str::from_utf8(&hello_acc)
                .unwrap_or("")
                .contains("event: hello")
            {
                break;
            }
        }

        let t_b = std::time::Instant::now();
        let s_b = rt.switch_to(&ws_b.to_string_lossy()).await.unwrap();
        let (code_b, _) = http_get_bootstrap(&s_b.endpoint).await;
        let ms_b = t_b.elapsed().as_millis();
        assert_eq!(s_b.status, "ready");
        assert_eq!(code_b, 200);
        assert_ne!(s_a.endpoint, s_b.endpoint);
        // 旧 SSE 连接必须已关闭（不再阻塞）
        drop(sse_conn);

        let t_c = std::time::Instant::now();
        let s_c = rt.switch_to(&ws_c.to_string_lossy()).await.unwrap();
        let (code_c, _) = http_get_bootstrap(&s_c.endpoint).await;
        let ms_c = t_c.elapsed().as_millis();
        assert_eq!(s_c.status, "ready");
        assert_eq!(code_c, 200);

        let t_a2 = std::time::Instant::now();
        let s_a2 = rt.switch_to(&ws_a.to_string_lossy()).await.unwrap();
        let (code_a2, _) = http_get_bootstrap(&s_a2.endpoint).await;
        let ms_a2 = t_a2.elapsed().as_millis();
        assert_eq!(s_a2.status, "ready");
        assert_eq!(code_a2, 200);
        assert_eq!(s_a2.recent_workspaces.len(), 3);
        assert_eq!(s_a2.recent_workspaces[0].name, "alpha");
        assert_eq!(s_a2.recent_workspaces[1].name, "gamma");
        assert_eq!(s_a2.recent_workspaces[2].name, "beta");

        eprintln!(
            "[A02 实测] A={ms_a}ms (冷建库), A(带SSE)→B={ms_b}ms, B→C={ms_c}ms, C→A={ms_a2}ms"
        );
        assert!(
            ms_a2 < 300,
            "已建库工作区二次切回出首屏应 < 300ms，实测 {ms_a2}ms"
        );

        // 同目录重切幂等复用原端点
        let s_a_same = rt.switch_to(&ws_a.to_string_lossy()).await.unwrap();
        assert_eq!(s_a_same.endpoint, s_a2.endpoint);

        // 模拟外部实例锁定 ws_b → 切换 ws_b 必须进入 root_in_use 并保留 previous_root & 锁诊断
        let holder = guanlan_service::start_readonly_service(guanlan_service::ServeConfig {
            root: ws_b.to_string_lossy().into_owned(),
            port: 0,
            cors_desktop: false,
            background_index: false,
        })
        .await
        .expect("占位锁");
        let conflict = rt.switch_to(&ws_b.to_string_lossy()).await.unwrap();
        assert_eq!(conflict.status, "root_in_use");
        assert_eq!(
            conflict.previous_root.as_deref(),
            Some(ws_a.to_string_lossy().as_ref())
        );
        let err = conflict.error.expect("冲突明细");
        assert_eq!(err.code, "ROOT_IN_USE");
        assert!(err.lock_info.unwrap_or_default().contains("pid="));

        // 释放占用后重试即刻恢复 ready
        let b_data_dir = holder.data_dir.clone();
        holder.shutdown().await;
        let recovered = rt.switch_to(&ws_b.to_string_lossy()).await.unwrap();
        assert_eq!(recovered.status, "ready");

        rt.shutdown_active().await;

        for ws in [&ws_a, &ws_b, &ws_c] {
            if let Ok((d, _, _)) =
                guanlan_service::runtime::workspace_lock_context(&ws.to_string_lossy())
            {
                if d != b_data_dir {
                    let _ = std::fs::remove_dir_all(d);
                }
            }
        }
        let _ = std::fs::remove_dir_all(b_data_dir);
    }

    #[tokio::test]
    async fn desktop_import_external_files_reaches_timeline_trunk_under_500ms() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let base = TempRoot::new("import-e2e");
        let cfg_path = base.0.join("desktop.json");
        let ws = base.0.join("ws");
        let ext = base.0.join("external");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ws.join("seed.md"), "# Seed\n\n初始文档\n").unwrap();

        let ext_pdf = ext.join("外联验收单.pdf");
        let ext_svg = ext.join("架构示意图.svg");
        std::fs::write(&ext_pdf, b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n").unwrap();
        std::fs::write(
            &ext_svg,
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Imported</text></svg>",
        )
        .unwrap();

        let rt = DesktopRuntime::new(Some(cfg_path));
        let ready = rt.switch_to(&ws.to_string_lossy()).await.unwrap();
        assert_eq!(ready.status, "ready");
        let addr = ready.endpoint.trim_start_matches("http://").to_owned();

        async fn http_get(addr: &str, path: &str) -> String {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(
                    format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
            let mut resp = String::new();
            stream.read_to_string(&mut resp).await.unwrap();
            resp.split("\r\n\r\n").nth(1).unwrap_or("{}").to_owned()
        }

        // 等首次启动 VerifyAll 完成
        for _ in 0..40 {
            let status = http_get(&addr, "/api/v1/status").await;
            if status.contains("\"active_jobs\":[]") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // 验证越界目录导入被 100% 拦截且不写任何字节到工作区外
        let evil = rt
            .import_external_files(
                vec![ext_pdf.to_string_lossy().into_owned()],
                "../external".to_owned(),
            )
            .await
            .expect_err("越界导入必须拒绝");
        assert_eq!(evil.code, "INVALID_PATH");
        assert!(!ext.join("外联验收单 (1).pdf").exists());

        // 实测外部 PDF + SVG 拖入指定目录 `inbox/2026-11` → 落盘 → 今日时间主干 < 500ms
        let started = std::time::Instant::now();
        let outcome = rt
            .import_external_files(
                vec![
                    ext_pdf.to_string_lossy().into_owned(),
                    ext_svg.to_string_lossy().into_owned(),
                ],
                "inbox/2026-11".to_owned(),
            )
            .await
            .expect("合法目录导入成功");
        assert_eq!(outcome.imported.len(), 2);
        assert!(outcome.job_id.is_some());

        let mut appeared_in_trunk = false;
        while started.elapsed() < std::time::Duration::from_millis(500) {
            let days_raw = http_get(&addr, "/api/v1/events/days?order=observed&samples=12").await;
            if days_raw.contains("inbox/2026-11/外联验收单.pdf")
                && days_raw.contains("inbox/2026-11/架构示意图.svg")
            {
                appeared_in_trunk = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let elapsed_ms = started.elapsed().as_millis();
        eprintln!("[A04 实测] 外部 PDF/SVG 拖入落盘 → 出现在今日时间主干耗时 = {elapsed_ms}ms");
        assert!(
            appeared_in_trunk && elapsed_ms < 500,
            "拖入外部文件应在 < 500ms 内出现在今日时间主干，实测 {elapsed_ms}ms"
        );

        rt.shutdown_active().await;
        if let Ok((d, _, _)) =
            guanlan_service::runtime::workspace_lock_context(&ws.to_string_lossy())
        {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

/// C03：全局呼出热键解析与 desktop.json 持久化（纯函数 + 配置 roundtrip）
#[cfg(test)]
mod hotkey_tests {
    use super::{config, parse_hotkey};

    #[test]
    fn parses_modifiers_and_normalizes_case() {
        assert_eq!(parse_hotkey("alt+k").unwrap(), "alt+k");
        assert_eq!(parse_hotkey("Ctrl+Shift+P").unwrap(), "control+shift+p");
        assert_eq!(parse_hotkey("CTRL + alt + 7").unwrap(), "control+alt+7");
        assert_eq!(parse_hotkey("cmd+k").unwrap(), "super+k");
        assert_eq!(parse_hotkey("shift+F5").unwrap(), "shift+f5");
    }

    #[test]
    fn rejects_illegal_hotkeys() {
        // 无修饰符
        assert!(parse_hotkey("k").is_err());
        assert!(parse_hotkey("ctrl").is_err());
        // 非法主键
        assert!(parse_hotkey("alt+space").is_err());
        assert!(parse_hotkey("alt+F13").is_err());
        assert!(parse_hotkey("alt+;;").is_err());
        // 未知修饰符
        assert!(parse_hotkey("meta+k").is_err());
        // 空串
        assert!(parse_hotkey("").is_err());
        assert!(parse_hotkey("++").is_err());
    }

    #[test]
    fn desktop_json_hotkey_roundtrip_and_backward_compat() {
        let temp = std::env::temp_dir().join(format!(
            "guanlan-desktop-hotkey-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        let cfg_path = temp.join("desktop.json");

        // 写入含 hotkey 的配置
        let written = config::DesktopConfig {
            last_root: Some(r"H:\demo".to_owned()),
            recent_workspaces: Vec::new(),
            hotkey: Some("ctrl+shift+k".to_owned()),
        };
        config::write_config_at(Some(&cfg_path), &written);
        let read = config::read_config_at(Some(&cfg_path));
        assert_eq!(read, written);
        assert_eq!(read.hotkey.as_deref(), Some("ctrl+shift+k"));
        assert_eq!(
            parse_hotkey(&read.hotkey.unwrap()).unwrap(),
            "control+shift+k"
        );

        // 旧格式（无 hotkey 字段）向后兼容：反序列化缺省 None
        std::fs::write(&cfg_path, r#"{"lastRoot":"H:\\legacy"}"#).unwrap();
        let legacy = config::read_config_at(Some(&cfg_path));
        assert!(
            legacy.hotkey.is_none(),
            "旧 desktop.json 无 hotkey 字段应缺省 None"
        );
        assert_eq!(legacy.last_root.as_deref(), Some(r"H:\legacy"));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn f03_cli_open_dir_and_windows_context_menu_reg_commands() {
        let temp = std::env::temp_dir().join(format!(
            "guanlan-desktop-f03-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        let dir_str = temp.to_string_lossy().into_owned();

        // --open <目录> 与位置参数均应准确识别
        assert_eq!(
            config::parse_cli_startup_dir(&["--open".to_owned(), dir_str.clone()]).as_deref(),
            Some(dir_str.as_str())
        );
        assert_eq!(
            config::parse_cli_startup_dir(std::slice::from_ref(&dir_str)).as_deref(),
            Some(dir_str.as_str())
        );
        assert!(config::parse_cli_startup_dir(&["--unknown".to_owned()]).is_none());

        // HKCU 右键菜单注册命令必须覆盖 Directory 与 Directory\Background 两个入口且免 UAC
        let reg_cmds =
            super::build_windows_context_menu_reg_args(r"C:\Guanlan\guanlan-desktop.exe");
        assert_eq!(reg_cmds.len(), 6);
        let joined = reg_cmds
            .iter()
            .map(|c| c.join(" "))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains(r"HKCU\Software\Classes\Directory\shell\GuanlanOpen"));
        assert!(joined.contains(r"HKCU\Software\Classes\Directory\Background\shell\GuanlanOpen"));
        assert!(joined.contains("用观澜打开此文件夹"));
        assert!(joined.contains("--open \"%1\""));
        assert!(joined.contains("--open \"%V\""));

        let _ = std::fs::remove_dir_all(&temp);
    }
}
