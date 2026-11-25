//! 身份保真文件操作：工作区内安全重命名、跨目录原子移动与操作系统回收站移除。
//!
//! 铁律与红线：
//! - 重命名/移动全程走工作区边界内路径校验（拦截 `..`、绝对路径、盘符/UNC、NTFS 流冒号、
//!   控制符、Windows 保留名、隐藏目录、排除目录与逃逸符号链接）+ `std::fs::rename` 原子操作；
//! - 删除**只准移入操作系统回收站（Trash）且必须经人工二次确认（`confirm = true`）**，
//!   严禁对用户工作区文件调用任何永久物理删除 API（`remove_file` / `remove_dir_all`）；
//! - 磁盘操作成功后，在**同一 SQLite 写事务**内原子更新 `files`（保留原 `file_id` 不裂变）、
//!   登记 `path_aliases`（旧路径 + 新路径双重别名）、写入 `file_renamed / file_moved / file_trashed`
//!   事件、同步重算状态机投影并推进 `index_generation`；
//! - 若从系统回收站还原原文件，下轮 `reconcile` 经 `files` / `path_aliases` / 同哈希候选
//!   自动重连原 `file_id`，版本链、关联决定与前端阅读进度 100% 连续。

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use crate::domain::normalize_rel_path;
use crate::dto::{
    BatchFileFailure, BatchFileMutationResponse, CreateDocumentResponse, FileMutationResponse,
    FolderMutationResponse,
};
use crate::error::GuanlanError;
use crate::index::clock;
use crate::index::collector;
use crate::index::derive::{json_object, json_string};
use crate::index::file_format::FileFormat;
use crate::index::ident::{detect_role, folder_from_path, stable_short, title_from_path};
use crate::index::state_engine::recompute_full;
use crate::index::writer::{NewEvent, Writer};
use crate::index::{reconcile_paths, ReconcileOptions};

static FILE_OP_SEQ: AtomicU64 = AtomicU64::new(1);
static LAST_OP_EPOCH_MS: AtomicI64 = AtomicI64::new(0);

/// 生成严格单调递增的 UTC ISO 时间戳，避免同毫秒内连续重命名/移动/删除
/// 在 `uniq_event_identity` 上碰撞而静默丢弃事件。
fn monotonic_now_iso() -> String {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut prev = LAST_OP_EPOCH_MS.load(Ordering::Relaxed);
    loop {
        let next = now_ms.max(prev + 1);
        match LAST_OP_EPOCH_MS.compare_exchange_weak(
            prev,
            next,
            Ordering::SeqCst,
            Ordering::Relaxed,
        ) {
            Ok(_) => return clock::iso_from_epoch_millis(next),
            Err(actual) => prev = actual,
        }
    }
}

/// 重命名载荷
#[derive(Debug, Clone)]
pub struct RenameFileInput {
    pub file_id: String,
    pub new_name: String,
}

/// 跨目录移动载荷
#[derive(Debug, Clone)]
pub struct MoveFileInput {
    pub file_id: String,
    /// 相对于工作区根的目标目录（`""` 或 `"."` 表示工作区根目录）
    pub target_dir: String,
    /// 可选同步改名；缺省保留原文件名
    pub new_name: Option<String>,
}

/// 移入回收站载荷
#[derive(Debug, Clone)]
pub struct TrashFileInput {
    pub file_id: String,
    /// 必须显式为 true（二次确认门禁，拒绝静默删除）
    pub confirm: bool,
}

/// 新建文件夹载荷
#[derive(Debug, Clone)]
pub struct CreateFolderInput {
    /// 父目录（`""` 或 `"."` 表示工作区根目录）
    pub parent_dir: String,
    /// 新文件夹名（单段，不可含路径分隔符或非法字符）
    pub name: String,
}

/// 重命名文件夹载荷
#[derive(Debug, Clone)]
pub struct RenameFolderInput {
    /// 相对工作区根的原文件夹路径（不可为空或根）
    pub folder_path: String,
    /// 新文件夹名（单段）
    pub new_name: String,
}

/// 移动文件夹载荷
#[derive(Debug, Clone)]
pub struct MoveFolderInput {
    /// 相对工作区根的源文件夹路径（不可为空或根）
    pub folder_path: String,
    /// 目标父目录（`""` 或 `"."` 表示工作区根目录）
    pub target_parent_dir: String,
}

/// 文件夹移入回收站载荷
#[derive(Debug, Clone)]
pub struct TrashFolderInput {
    /// 相对工作区根的文件夹路径（不可为空或根）
    pub folder_path: String,
    /// 必须显式为 true（二次确认门禁，拒绝静默删除）
    pub confirm: bool,
}

/// 在指定目录新建 Markdown 文档载荷
#[derive(Debug, Clone)]
pub struct CreateDocumentInput {
    /// 目标目录（`""` 或 `"."` 表示工作区根目录）
    pub target_dir: String,
    /// 文件名（未带扩展名时自动补 `.md`）
    pub name: String,
    /// 可选初始正文（缺省生成 `# <标题>\n\n`）
    pub initial_content: Option<String>,
}

/// 批量移动文件载荷
#[derive(Debug, Clone)]
pub struct BatchMoveFilesInput {
    pub file_ids: Vec<String>,
    pub target_dir: String,
}

/// 批量移入回收站载荷
#[derive(Debug, Clone)]
pub struct BatchTrashFilesInput {
    pub file_ids: Vec<String>,
    pub confirm: bool,
}

/// 回收站投递驱动（生产恒走 OS 回收站；单测可注入隔离目录验证还原链）
pub trait TrashDriver {
    fn move_to_trash(&self, abs_path: &Path) -> Result<&'static str, GuanlanError>;
}

/// 默认操作系统回收站实现
pub struct OsTrashDriver;

impl TrashDriver for OsTrashDriver {
    fn move_to_trash(&self, abs_path: &Path) -> Result<&'static str, GuanlanError> {
        os_trash::move_to_trash(abs_path)
    }
}

/// 剥离 Windows `canonicalize` 生成的 `\\?\` 长路径前缀，确保 Shell API 可识别且进回收站。
fn strip_win_verbatim_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn is_windows_reserved_stem(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn validate_single_segment(seg: &str, kind_label: &str) -> Result<String, GuanlanError> {
    let trimmed = seg.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(GuanlanError::BadRequest(format!(
            "{kind_label}不能为空或包含 `.` / `..`"
        )));
    }
    if trimmed.contains('\0')
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err(GuanlanError::BadRequest(format!(
            "{kind_label}包含非法字符：{trimmed}"
        )));
    }
    if trimmed.starts_with('.') {
        return Err(GuanlanError::BadRequest(format!(
            "禁止使用点号开头的隐藏名称：{trimmed}"
        )));
    }
    if is_windows_reserved_stem(trimmed) {
        return Err(GuanlanError::BadRequest(format!(
            "名称命中系统保留字：{trimmed}"
        )));
    }
    Ok(trimmed.to_owned())
}

fn validate_new_file_name(raw_name: &str, current_format: &str) -> Result<String, GuanlanError> {
    let clean = validate_single_segment(raw_name, "文件名")?;
    let expected = FileFormat::parse(current_format).ok_or_else(|| {
        GuanlanError::BadRequest(format!("不支持重命名此格式文件：{current_format}"))
    })?;
    // 扩展名兼容性按格式族判定：同族改名（md→markdown、
    // png→jpg）放行；跨族改名（md→png）仍拦住，避免阅读器拿到读不了的类型。
    let actual = collector::format_of(&clean, Path::new(&clean));
    if !expected.is_compatible_with(&actual) {
        return Err(GuanlanError::BadRequest(format!(
            "重命名须保持兼容的格式扩展名（当前为 {}，不允许改为 `{clean}`）",
            expected.as_str()
        )));
    }
    Ok(clean)
}

fn validate_target_dir_segments(raw_dir: &str) -> Result<Vec<String>, GuanlanError> {
    if raw_dir.contains('\0') {
        return Err(GuanlanError::BadRequest("目标目录包含空字节".to_owned()));
    }
    let trimmed = raw_dir.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(Vec::new());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err(GuanlanError::BadRequest(
            "拒绝绝对路径或带盘符的目标目录".to_owned(),
        ));
    }
    let probe = Path::new(&normalized);
    if probe.is_absolute() {
        return Err(GuanlanError::BadRequest("拒绝绝对路径目标目录".to_owned()));
    }
    for component in probe.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(GuanlanError::BadRequest(format!(
                "目标目录包含非法路径段：{trimmed}"
            )));
        }
    }
    let mut segments = Vec::new();
    for seg in normalized.split('/') {
        let valid = validate_single_segment(seg, "目录段")?;
        if collector::DEFAULT_EXCLUDED.contains(&valid.as_str()) {
            return Err(GuanlanError::BadRequest(format!(
                "目标目录包含被排除的依赖/构建目录（`{valid}`），移入会导致索引丢失"
            )));
        }
        segments.push(valid);
    }
    Ok(segments)
}

fn canonical_workspace_root(root_path: &str) -> Result<PathBuf, GuanlanError> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(GuanlanError::NotFound(format!(
            "工作区根目录不存在：{root_path}"
        )));
    }
    fs::canonicalize(root)
        .map_err(|e| GuanlanError::Internal(format!("规范化工作区根目录失败 {root_path}：{e}")))
}

fn resolve_existing_file_in_jail(
    canon_root: &Path,
    rel_path: &str,
) -> Result<PathBuf, GuanlanError> {
    let norm = normalize_rel_path(rel_path);
    let mut cur = canon_root.to_path_buf();
    for seg in norm.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(GuanlanError::BadRequest(format!(
                "库内源路径非法：{rel_path}"
            )));
        }
        cur.push(seg);
        let meta = fs::symlink_metadata(&cur).map_err(|e| {
            GuanlanError::NotFound(format!("磁盘文件不存在或不可访问：{rel_path} ({e})"))
        })?;
        if meta.file_type().is_symlink() {
            return Err(GuanlanError::BadRequest(format!(
                "拒绝操作工作区符号链接路径：{rel_path}"
            )));
        }
        let canon_step = fs::canonicalize(&cur)
            .map_err(|e| GuanlanError::NotFound(format!("解析源路径失败：{rel_path} ({e})")))?;
        if !canon_step.starts_with(canon_root) {
            return Err(GuanlanError::BadRequest(format!(
                "拒绝越界工作区根目录的路径：{rel_path}"
            )));
        }
    }
    let meta = fs::symlink_metadata(&cur)
        .map_err(|e| GuanlanError::NotFound(format!("磁盘文件不存在：{rel_path} ({e})")))?;
    if !meta.is_file() {
        return Err(GuanlanError::BadRequest(format!(
            "目标不是常规文件：{rel_path}"
        )));
    }
    Ok(strip_win_verbatim_prefix(&cur))
}

fn resolve_or_create_dir_in_jail(
    canon_root: &Path,
    segments: &[String],
) -> Result<(PathBuf, String), GuanlanError> {
    let mut cur = canon_root.to_path_buf();
    for seg in segments {
        cur.push(seg);
        match fs::symlink_metadata(&cur) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(GuanlanError::BadRequest(format!(
                        "拒绝穿越符号链接目录：{seg}"
                    )));
                }
                let canon_step = fs::canonicalize(&cur).map_err(|e| {
                    GuanlanError::Internal(format!("规范化目标目录失败 {}：{e}", cur.display()))
                })?;
                if !canon_step.starts_with(canon_root) {
                    return Err(GuanlanError::BadRequest(format!(
                        "目标目录越界工作区：{seg}"
                    )));
                }
                if !meta.is_dir() {
                    return Err(GuanlanError::Conflict(format!(
                        "目标路径段已存在同名文件而非目录：{seg}"
                    )));
                }
                cur = canon_step;
            }
            Err(_) => {
                fs::create_dir(&cur).map_err(|e| {
                    GuanlanError::Internal(format!("创建目标目录失败 {}：{e}", cur.display()))
                })?;
                let canon_step = fs::canonicalize(&cur).map_err(|e| {
                    GuanlanError::Internal(format!("校验新建目录失败 {}：{e}", cur.display()))
                })?;
                if !canon_step.starts_with(canon_root) {
                    return Err(GuanlanError::BadRequest(format!(
                        "新建目标目录越界工作区：{seg}"
                    )));
                }
                cur = canon_step;
            }
        }
    }
    Ok((strip_win_verbatim_prefix(&cur), segments.join("/")))
}

fn next_event_id(prefix: &str, file_id: &str, tag: &str) -> String {
    let seq = FILE_OP_SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}_{}_{}",
        file_id,
        stable_short(&format!("{tag}#{seq}"))
    )
}

fn folder_label(folder: &str) -> &str {
    if folder == "." || folder.is_empty() {
        "工作区根目录"
    } else {
        folder
    }
}

/// 原子重命名工作区内已纳管文件（同目录改名；保留 `file_id`、版本链、决定与阅读进度）。
pub fn rename_file(
    writer: &mut Writer,
    input: &RenameFileInput,
) -> Result<FileMutationResponse, GuanlanError> {
    let workspace = writer.workspace()?;
    let file = writer
        .get_file(&input.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {}", input.file_id)))?;
    if file.workspace_id != workspace.workspace_id {
        return Err(GuanlanError::NotFound(format!(
            "文件 {} 不属于当前工作区",
            input.file_id
        )));
    }
    if file.status != "active" {
        return Err(GuanlanError::Conflict(format!(
            "文件当前状态为「{}」，仅可重命名活动状态文件",
            file.status
        )));
    }

    let new_name = validate_new_file_name(&input.new_name, &file.format)?;
    let old_rel = normalize_rel_path(&file.current_path);
    let parent_dir = folder_from_path(&old_rel);
    let target_segments = if parent_dir == "." {
        Vec::new()
    } else {
        parent_dir.split('/').map(str::to_owned).collect()
    };
    let new_rel = if parent_dir == "." {
        new_name.clone()
    } else {
        format!("{parent_dir}/{new_name}")
    };
    if new_rel == old_rel {
        return Err(GuanlanError::BadRequest(
            "新文件名与当前名称相同".to_owned(),
        ));
    }

    execute_relocate(
        writer,
        &workspace.workspace_id,
        &workspace.root_path,
        &file,
        &old_rel,
        &target_segments,
        &new_name,
        &new_rel,
        "file_renamed",
        "explicit_rename",
    )
}

/// 工作区内原子移动文件（支持跨目录及可选同步改名；保留 `file_id`、版本链、决定与阅读进度）。
pub fn move_file(
    writer: &mut Writer,
    input: &MoveFileInput,
) -> Result<FileMutationResponse, GuanlanError> {
    let workspace = writer.workspace()?;
    let file = writer
        .get_file(&input.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {}", input.file_id)))?;
    if file.workspace_id != workspace.workspace_id {
        return Err(GuanlanError::NotFound(format!(
            "文件 {} 不属于当前工作区",
            input.file_id
        )));
    }
    if file.status != "active" {
        return Err(GuanlanError::Conflict(format!(
            "文件当前状态为「{}」，仅可移动活动状态文件",
            file.status
        )));
    }

    let old_rel = normalize_rel_path(&file.current_path);
    let old_name = old_rel.rsplit('/').next().unwrap_or(&old_rel).to_owned();
    let old_folder = folder_from_path(&old_rel);
    let target_segments = validate_target_dir_segments(&input.target_dir)?;
    let final_name = match &input.new_name {
        Some(raw) if !raw.trim().is_empty() => validate_new_file_name(raw, &file.format)?,
        _ => old_name,
    };
    let target_dir_norm = target_segments.join("/");
    let new_rel = if target_dir_norm.is_empty() {
        final_name.clone()
    } else {
        format!("{target_dir_norm}/{final_name}")
    };
    if new_rel == old_rel {
        return Err(GuanlanError::BadRequest(
            "目标路径与当前文件位置相同".to_owned(),
        ));
    }

    let same_dir =
        (old_folder == "." && target_dir_norm.is_empty()) || old_folder == target_dir_norm;
    let operation = if same_dir {
        "file_renamed"
    } else {
        "file_moved"
    };
    let evidence = if same_dir {
        "explicit_rename"
    } else {
        "explicit_move"
    };

    execute_relocate(
        writer,
        &workspace.workspace_id,
        &workspace.root_path,
        &file,
        &old_rel,
        &target_segments,
        &final_name,
        &new_rel,
        operation,
        evidence,
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_relocate(
    writer: &mut Writer,
    workspace_id: &str,
    root_path: &str,
    file: &crate::storage::FileRow,
    old_rel: &str,
    target_segments: &[String],
    final_name: &str,
    new_rel: &str,
    operation: &'static str,
    evidence: &'static str,
) -> Result<FileMutationResponse, GuanlanError> {
    let canon_root = canonical_workspace_root(root_path)?;
    let old_abs = resolve_existing_file_in_jail(&canon_root, old_rel)?;
    let old_folder = folder_from_path(old_rel);
    let old_name = old_rel.rsplit('/').next().unwrap_or(old_rel);
    let target_dir_norm = target_segments.join("/");
    let same_dir =
        (old_folder == "." && target_dir_norm.is_empty()) || old_folder == target_dir_norm;
    let case_only_rename = cfg!(windows)
        && same_dir
        && old_name.eq_ignore_ascii_case(final_name)
        && old_name != final_name;

    if !case_only_rename {
        // 核对库内是否有其他活动文件占用了目标路径（Windows 下按大小写无关核验）
        for existing in writer.list_files(workspace_id, false)? {
            if existing.file_id == file.file_id {
                continue;
            }
            let existing_norm = normalize_rel_path(&existing.current_path);
            let collides = if cfg!(windows) {
                existing_norm.eq_ignore_ascii_case(new_rel)
            } else {
                existing_norm == new_rel
            };
            if collides {
                return Err(GuanlanError::Conflict(format!(
                    "目标路径已存在同名受管文件：{new_rel}"
                )));
            }
        }
    }

    let (dest_dir_abs, _) = resolve_or_create_dir_in_jail(&canon_root, target_segments)?;
    let new_abs = dest_dir_abs.join(final_name);
    if !case_only_rename && fs::symlink_metadata(&new_abs).is_ok() {
        return Err(GuanlanError::Conflict(format!(
            "磁盘目标路径已存在同名文件，拒绝静默覆盖：{new_rel}"
        )));
    }

    // 事务外原子磁盘重命名 / 移动（仅同卷原子 rename，绝不调用物理删除）
    fs::rename(&old_abs, &new_abs).map_err(|e| {
        GuanlanError::Internal(format!("原子移动文件失败（{old_rel} -> {new_rel}）：{e}"))
    })?;

    // 落盘后核对新路径确在工作区边界内
    let canon_dest = fs::canonicalize(&new_abs).map_err(|e| {
        let _ = fs::rename(&new_abs, &old_abs);
        GuanlanError::Internal(format!("校验新文件路径失败：{e}"))
    })?;
    if !canon_dest.starts_with(&canon_root) {
        let _ = fs::rename(&new_abs, &old_abs);
        return Err(GuanlanError::BadRequest(
            "目标路径逃逸工作区根目录，已自动回滚".to_owned(),
        ));
    }

    let mtime_ms = collector::stat_fingerprint(&new_abs)
        .map(|fp| fp.mtime_ms)
        .unwrap_or(file.last_mtime_ms);
    let new_title = title_from_path(new_rel);
    let new_role = detect_role(new_rel, &new_title, &file.format).to_owned();
    let new_folder = folder_from_path(new_rel);
    let observed_at = monotonic_now_iso();
    let event_id = next_event_id(
        if operation == "file_renamed" {
            "evt_renamed"
        } else {
            "evt_moved"
        },
        &file.file_id,
        &format!("{old_rel}->{new_rel}@{observed_at}"),
    );

    let (headline, detail, payload) = if operation == "file_renamed" {
        (
            format!("重命名文件：{old_name} → {final_name}"),
            format!(
                "{old_rel} 已安全重命名为 {new_rel}；原 file_id（{}）、历史版本、关联决定与阅读进度全部保持连续。",
                file.file_id
            ),
            json_object(&[
                ("file_id", json_string(&file.file_id)),
                ("old_path", json_string(old_rel)),
                ("new_path", json_string(new_rel)),
                ("old_name", json_string(old_name)),
                ("new_name", json_string(final_name)),
                ("alias_recorded", "true".to_owned()),
            ]),
        )
    } else {
        (
            format!("移动文件：{old_rel} → {new_rel}"),
            format!(
                "已从「{}」移至「{}」；原 file_id（{}）、历史版本、关联决定与阅读进度全部保持连续。",
                folder_label(&old_folder),
                folder_label(&new_folder),
                file.file_id
            ),
            json_object(&[
                ("file_id", json_string(&file.file_id)),
                ("old_path", json_string(old_rel)),
                ("new_path", json_string(new_rel)),
                ("from_dir", json_string(&old_folder)),
                ("to_dir", json_string(&new_folder)),
                ("alias_recorded", "true".to_owned()),
            ]),
        )
    };

    let tx_res = writer.transaction(|writer| {
        writer.update_file_path_identity(
            &file.file_id,
            new_rel,
            &new_title,
            &new_role,
            &observed_at,
            mtime_ms,
        )?;
        writer.upsert_alias(workspace_id, old_rel, &file.file_id, &observed_at, evidence)?;
        writer.upsert_alias(workspace_id, new_rel, &file.file_id, &observed_at, evidence)?;
        writer.insert_event(&NewEvent {
            event_id: event_id.clone(),
            workspace_id: workspace_id.to_owned(),
            kind: operation.to_owned(),
            subject_kind: "file".to_owned(),
            subject_id: file.file_id.clone(),
            revision_id: file.last_revision_id.clone(),
            occurred_at: Some(observed_at.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("collector".to_owned()),
            observed_at: observed_at.clone(),
            headline,
            detail,
            payload_json: payload,
            batch_id: None,
        })?;
        let _ = recompute_full(writer, workspace_id, &observed_at)?;
        writer.bump_generation(workspace_id)
    });

    let generation = match tx_res {
        Ok(gen) => gen,
        Err(err) => {
            // 数据库写事务失败时尝试回滚磁盘路径，避免磁盘与索引状态分叉
            let _ = fs::rename(&new_abs, &old_abs);
            return Err(err);
        }
    };

    Ok(FileMutationResponse {
        ok: true,
        operation: operation.to_owned(),
        file_id: file.file_id.clone(),
        old_path: old_rel.to_owned(),
        new_path: Some(new_rel.to_owned()),
        title: new_title,
        role: new_role,
        status: "active".to_owned(),
        event_id,
        index_generation: generation,
        trash_recoverable: false,
    })
}

/// 将受管文件移入操作系统回收站（拒绝静默/永久物理删除；必须经人工二次确认）。
pub fn trash_file(
    writer: &mut Writer,
    input: &TrashFileInput,
) -> Result<FileMutationResponse, GuanlanError> {
    trash_file_with(writer, input, &OsTrashDriver)
}

/// 可注入回收站驱动的内部实现（生产仅经 [`trash_file`] 走 `OsTrashDriver`）。
pub fn trash_file_with(
    writer: &mut Writer,
    input: &TrashFileInput,
    driver: &dyn TrashDriver,
) -> Result<FileMutationResponse, GuanlanError> {
    if !input.confirm {
        return Err(GuanlanError::BadRequest(
            "移入回收站必须经人工二次确认（confirm=true）".to_owned(),
        ));
    }

    let workspace = writer.workspace()?;
    let file = writer
        .get_file(&input.file_id)?
        .ok_or_else(|| GuanlanError::NotFound(format!("未找到文件 {}", input.file_id)))?;
    if file.workspace_id != workspace.workspace_id {
        return Err(GuanlanError::NotFound(format!(
            "文件 {} 不属于当前工作区",
            input.file_id
        )));
    }
    if file.status != "active" {
        return Err(GuanlanError::Conflict(format!(
            "文件当前状态为「{}」，无法再次移入回收站",
            file.status
        )));
    }

    let old_rel = normalize_rel_path(&file.current_path);
    let canon_root = canonical_workspace_root(&workspace.root_path)?;
    let old_abs = resolve_existing_file_in_jail(&canon_root, &old_rel)?;

    let trash_method = driver.move_to_trash(&old_abs)?;
    if fs::symlink_metadata(&old_abs).is_ok() {
        return Err(GuanlanError::Internal(format!(
            "文件移入回收站后原路径仍存在：{old_rel}"
        )));
    }

    let observed_at = monotonic_now_iso();
    let event_id = next_event_id(
        "evt_trashed",
        &file.file_id,
        &format!("{old_rel}@{observed_at}"),
    );
    let payload = json_object(&[
        ("file_id", json_string(&file.file_id)),
        ("path", json_string(&old_rel)),
        ("old_path", json_string(&old_rel)),
        ("recoverable", "true".to_owned()),
        ("trash_method", json_string(trash_method)),
    ]);

    let generation = writer.transaction(|writer| {
        writer.mark_file_status(&file.file_id, "trashed")?;
        writer.upsert_alias(
            &workspace.workspace_id,
            &old_rel,
            &file.file_id,
            &observed_at,
            "explicit_trash",
        )?;
        writer.insert_event(&NewEvent {
            event_id: event_id.clone(),
            workspace_id: workspace.workspace_id.clone(),
            kind: "file_trashed".to_owned(),
            subject_kind: "file".to_owned(),
            subject_id: file.file_id.clone(),
            revision_id: file.last_revision_id.clone(),
            occurred_at: Some(observed_at.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("collector".to_owned()),
            observed_at: observed_at.clone(),
            headline: format!("已移入系统回收站：{old_rel}"),
            detail: format!(
                "文件已移入操作系统回收站（非永久删除）；从回收站还原后将自动重连原 file_id（{}）与全部历史。",
                file.file_id
            ),
            payload_json: payload,
            batch_id: None,
        })?;
        let _ = recompute_full(
            writer,
            &workspace.workspace_id,
            &observed_at,
        )?;
        writer.bump_generation(&workspace.workspace_id)
    })?;

    Ok(FileMutationResponse {
        ok: true,
        operation: "file_trashed".to_owned(),
        file_id: file.file_id,
        old_path: old_rel,
        new_path: None,
        title: file.title,
        role: file.role,
        status: "trashed".to_owned(),
        event_id,
        index_generation: generation,
        trash_recoverable: true,
    })
}

fn validate_folder_segment(raw_name: &str) -> Result<String, GuanlanError> {
    let valid = validate_single_segment(raw_name, "文件夹名")?;
    if collector::DEFAULT_EXCLUDED.contains(&valid.as_str()) {
        return Err(GuanlanError::BadRequest(format!(
            "文件夹名命中排除目录黑名单（`{valid}`），创建或迁入会导致索引忽略"
        )));
    }
    Ok(valid)
}

fn validate_nonempty_folder_segments(raw_dir: &str) -> Result<Vec<String>, GuanlanError> {
    let segments = validate_target_dir_segments(raw_dir)?;
    if segments.is_empty() {
        return Err(GuanlanError::BadRequest(
            "文件夹路径不能为空，禁止直接操作工作区根目录".to_owned(),
        ));
    }
    Ok(segments)
}

fn resolve_existing_dir_in_jail(
    canon_root: &Path,
    segments: &[String],
) -> Result<PathBuf, GuanlanError> {
    let mut cur = canon_root.to_path_buf();
    for seg in segments {
        cur.push(seg);
        let meta = fs::symlink_metadata(&cur).map_err(|e| {
            GuanlanError::NotFound(format!(
                "磁盘目录不存在或不可访问：{} ({e})",
                segments.join("/")
            ))
        })?;
        if meta.file_type().is_symlink() {
            return Err(GuanlanError::BadRequest(format!(
                "拒绝操作工作区符号链接目录：{}",
                segments.join("/")
            )));
        }
        let canon_step = fs::canonicalize(&cur).map_err(|e| {
            GuanlanError::NotFound(format!("解析目录路径失败：{} ({e})", segments.join("/")))
        })?;
        if !canon_step.starts_with(canon_root) {
            return Err(GuanlanError::BadRequest(format!(
                "拒绝越界工作区根目录的目录：{}",
                segments.join("/")
            )));
        }
        cur = canon_step;
    }
    let meta = fs::symlink_metadata(&cur).map_err(|e| {
        GuanlanError::NotFound(format!("磁盘目录不存在：{} ({e})", segments.join("/")))
    })?;
    if !meta.is_dir() {
        return Err(GuanlanError::BadRequest(format!(
            "目标不是目录：{}",
            segments.join("/")
        )));
    }
    Ok(strip_win_verbatim_prefix(&cur))
}

fn paths_equal_platform(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn is_same_or_descendant_dir(source_rel: &str, candidate_parent: &str) -> bool {
    if candidate_parent.is_empty() {
        return false;
    }
    if paths_equal_platform(candidate_parent, source_rel) {
        return true;
    }
    let prefix = format!("{source_rel}/");
    if cfg!(windows) {
        candidate_parent
            .to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
    } else {
        candidate_parent.starts_with(&prefix)
    }
}

/// 若 `file_rel` 位于 `folder_rel` 子树下，返回相对该目录的尾路径（不含前导 `/`）。
fn strip_folder_prefix(file_rel: &str, folder_rel: &str) -> Option<String> {
    let norm = normalize_rel_path(file_rel);
    let prefix = format!("{folder_rel}/");
    if cfg!(windows) {
        let lower_norm = norm.to_ascii_lowercase();
        let lower_prefix = prefix.to_ascii_lowercase();
        if lower_norm.starts_with(&lower_prefix) {
            // 按字符边界切片：prefix 由合法路径段组成，Unicode 大小写长度可能差异，改按段匹配最安全
            let folder_segs: Vec<&str> = folder_rel.split('/').collect();
            let file_segs: Vec<&str> = norm.split('/').collect();
            if file_segs.len() > folder_segs.len()
                && file_segs
                    .iter()
                    .take(folder_segs.len())
                    .zip(folder_segs.iter())
                    .all(|(a, b)| a.eq_ignore_ascii_case(b))
            {
                return Some(file_segs[folder_segs.len()..].join("/"));
            }
        }
        None
    } else {
        norm.strip_prefix(&prefix).map(str::to_owned)
    }
}

/// 在工作区内创建真实文件夹（安全边界校验；已存在报 409 CONFLICT）。
pub fn create_folder(
    writer: &mut Writer,
    input: &CreateFolderInput,
) -> Result<FolderMutationResponse, GuanlanError> {
    let workspace = writer.workspace()?;
    let parent_segments = validate_target_dir_segments(&input.parent_dir)?;
    let clean_name = validate_folder_segment(&input.name)?;
    let new_rel = if parent_segments.is_empty() {
        clean_name.clone()
    } else {
        format!("{}/{clean_name}", parent_segments.join("/"))
    };

    let canon_root = canonical_workspace_root(&workspace.root_path)?;
    if collector::is_ignored_path(&canon_root, &format!("{new_rel}/__probe__")) {
        return Err(GuanlanError::BadRequest(format!(
            "新建目录 `{new_rel}` 命中 .gitignore 或排除规则，无法纳入工作区目录树"
        )));
    }
    let (parent_abs, _) = resolve_or_create_dir_in_jail(&canon_root, &parent_segments)?;
    let dest_abs = parent_abs.join(&clean_name);
    if fs::symlink_metadata(&dest_abs).is_ok() {
        return Err(GuanlanError::Conflict(format!(
            "目标路径已存在同名目录或文件：{new_rel}"
        )));
    }
    fs::create_dir(&dest_abs)
        .map_err(|e| GuanlanError::Internal(format!("创建文件夹失败（{new_rel}）：{e}")))?;
    let canon_dest = fs::canonicalize(&dest_abs).map_err(|e| {
        let _ = fs::remove_dir(&dest_abs);
        GuanlanError::Internal(format!("校验新建文件夹失败：{e}"))
    })?;
    if !canon_dest.starts_with(&canon_root) {
        let _ = fs::remove_dir(&dest_abs);
        return Err(GuanlanError::BadRequest(
            "新建文件夹越界工作区根目录，已自动回滚".to_owned(),
        ));
    }

    let generation =
        writer.transaction(|writer| writer.bump_generation(&workspace.workspace_id))?;
    Ok(FolderMutationResponse {
        ok: true,
        operation: "folder_created".to_owned(),
        old_path: None,
        new_path: Some(new_rel),
        affected_files: 0,
        affected_file_ids: Vec::new(),
        index_generation: generation,
        trash_recoverable: false,
    })
}

/// 在工作区指定目录新建 Markdown 文档并立即执行定向入库，返回新 `file_id`。
pub fn create_document(
    writer: &mut Writer,
    input: &CreateDocumentInput,
) -> Result<CreateDocumentResponse, GuanlanError> {
    let workspace = writer.workspace()?;
    let target_segments = validate_target_dir_segments(&input.target_dir)?;
    let raw_name = input.name.trim();
    if raw_name.is_empty() {
        return Err(GuanlanError::BadRequest("文档名不能为空".to_owned()));
    }
    let with_ext = if raw_name.contains('.') {
        raw_name.to_owned()
    } else {
        format!("{raw_name}.md")
    };
    let clean_name = validate_single_segment(&with_ext, "文档名")?;
    let new_rel = if target_segments.is_empty() {
        clean_name.clone()
    } else {
        format!("{}/{clean_name}", target_segments.join("/"))
    };

    let canon_root = canonical_workspace_root(&workspace.root_path)?;
    if collector::is_ignored_path(&canon_root, &new_rel) {
        return Err(GuanlanError::BadRequest(format!(
            "新建文档 `{new_rel}` 命中 .gitignore 或排除规则，无法纳入工作区"
        )));
    }

    let (dir_abs, _) = resolve_or_create_dir_in_jail(&canon_root, &target_segments)?;
    let file_abs = dir_abs.join(&clean_name);
    if fs::symlink_metadata(&file_abs).is_ok() {
        return Err(GuanlanError::Conflict(format!(
            "目标路径已存在同名文件，拒绝覆盖：{new_rel}"
        )));
    }

    let stem = clean_name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(&clean_name);
    let body = match &input.initial_content {
        Some(text) => text.clone(),
        None => format!("# {stem}\n\n"),
    };

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_abs)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                GuanlanError::Conflict(format!("目标路径已存在同名文件：{new_rel}"))
            } else {
                GuanlanError::Internal(format!("创建文档失败（{new_rel}）：{e}"))
            }
        })?;
    file.write_all(body.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| GuanlanError::Internal(format!("写入新建文档失败（{new_rel}）：{e}")))?;
    drop(file);

    let report = reconcile_paths(
        writer,
        &ReconcileOptions::default(),
        std::slice::from_ref(&new_rel),
    )?;
    let row = writer
        .find_file_by_path(&workspace.workspace_id, &new_rel)?
        .ok_or_else(|| {
            GuanlanError::Internal(format!("文档已写入但入库后未查到索引记录：{new_rel}"))
        })?;

    Ok(CreateDocumentResponse {
        ok: true,
        file_id: row.file_id,
        relative_path: normalize_rel_path(&row.current_path),
        title: row.title,
        format: row.format,
        index_generation: report.generation,
    })
}

/// 原子重命名工作区文件夹，并同步更新子树内全部受管文件路径（保持 `file_id`、版本链与决定 100% 连续）。
pub fn rename_folder(
    writer: &mut Writer,
    input: &RenameFolderInput,
) -> Result<FolderMutationResponse, GuanlanError> {
    let workspace = writer.workspace()?;
    let old_segments = validate_nonempty_folder_segments(&input.folder_path)?;
    let new_name = validate_folder_segment(&input.new_name)?;
    let old_rel = old_segments.join("/");
    let parent_segments = &old_segments[..old_segments.len() - 1];
    let new_rel = if parent_segments.is_empty() {
        new_name.clone()
    } else {
        format!("{}/{new_name}", parent_segments.join("/"))
    };
    if new_rel == old_rel {
        return Err(GuanlanError::BadRequest(
            "新文件夹名与当前名称相同".to_owned(),
        ));
    }

    execute_folder_relocate(
        writer,
        &workspace.workspace_id,
        &workspace.root_path,
        &old_segments,
        &old_rel,
        parent_segments,
        &new_name,
        &new_rel,
        "folder_renamed",
        "explicit_rename",
    )
}

/// 原子移动工作区文件夹到新父目录（严格防成环：禁止移入自身或任意后代目录），并同步更新子树所有受管文件。
pub fn move_folder(
    writer: &mut Writer,
    input: &MoveFolderInput,
) -> Result<FolderMutationResponse, GuanlanError> {
    let workspace = writer.workspace()?;
    let old_segments = validate_nonempty_folder_segments(&input.folder_path)?;
    let target_parent_segments = validate_target_dir_segments(&input.target_parent_dir)?;
    let old_rel = old_segments.join("/");
    let target_parent_rel = target_parent_segments.join("/");

    if is_same_or_descendant_dir(&old_rel, &target_parent_rel) {
        return Err(GuanlanError::BadRequest(format!(
            "禁止将文件夹「{old_rel}」移动到自身或其子目录「{target_parent_rel}」内（防成环）"
        )));
    }

    let base_name = old_segments
        .last()
        .cloned()
        .ok_or_else(|| GuanlanError::BadRequest("源文件夹路径无效".to_owned()))?;
    let new_rel = if target_parent_rel.is_empty() {
        base_name.clone()
    } else {
        format!("{target_parent_rel}/{base_name}")
    };
    if paths_equal_platform(&new_rel, &old_rel) {
        return Err(GuanlanError::BadRequest(
            "目标位置与当前文件夹位置相同".to_owned(),
        ));
    }

    execute_folder_relocate(
        writer,
        &workspace.workspace_id,
        &workspace.root_path,
        &old_segments,
        &old_rel,
        &target_parent_segments,
        &base_name,
        &new_rel,
        "folder_moved",
        "explicit_move",
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_folder_relocate(
    writer: &mut Writer,
    workspace_id: &str,
    root_path: &str,
    old_segments: &[String],
    old_rel: &str,
    target_parent_segments: &[String],
    final_name: &str,
    new_rel: &str,
    operation: &'static str,
    evidence: &'static str,
) -> Result<FolderMutationResponse, GuanlanError> {
    let canon_root = canonical_workspace_root(root_path)?;
    let old_abs = resolve_existing_dir_in_jail(&canon_root, old_segments)?;
    let case_only_rename =
        cfg!(windows) && old_rel.eq_ignore_ascii_case(new_rel) && old_rel != new_rel;

    let (dest_parent_abs, _) = resolve_or_create_dir_in_jail(&canon_root, target_parent_segments)?;
    let new_abs = dest_parent_abs.join(final_name);
    if !case_only_rename && fs::symlink_metadata(&new_abs).is_ok() {
        return Err(GuanlanError::Conflict(format!(
            "目标路径已存在同名目录或文件，拒绝静默覆盖：{new_rel}"
        )));
    }

    // 找出子树中所有活动受管文件，提前准备新路径映射
    let all_active = writer.list_files(workspace_id, false)?;
    let mut subtree_updates: Vec<(crate::storage::FileRow, String, String)> = Vec::new();
    for row in all_active {
        let cur_norm = normalize_rel_path(&row.current_path);
        if let Some(suffix) = strip_folder_prefix(&cur_norm, old_rel) {
            let next_path = format!("{new_rel}/{suffix}");
            subtree_updates.push((row, cur_norm, next_path));
        }
    }

    fs::rename(&old_abs, &new_abs).map_err(|e| {
        GuanlanError::Internal(format!("原子移动文件夹失败（{old_rel} -> {new_rel}）：{e}"))
    })?;

    let canon_dest = fs::canonicalize(&new_abs).map_err(|e| {
        let _ = fs::rename(&new_abs, &old_abs);
        GuanlanError::Internal(format!("校验新文件夹路径失败：{e}"))
    })?;
    if !canon_dest.starts_with(&canon_root) {
        let _ = fs::rename(&new_abs, &old_abs);
        return Err(GuanlanError::BadRequest(
            "目标目录逃逸工作区根目录，已自动回滚".to_owned(),
        ));
    }

    let observed_at = monotonic_now_iso();
    let affected_ids: Vec<String> = subtree_updates
        .iter()
        .map(|(row, _, _)| row.file_id.clone())
        .collect();
    let affected_count = affected_ids.len();

    let tx_res = writer.transaction(|writer| {
        for (row, old_file_rel, new_file_rel) in &subtree_updates {
            let new_title = title_from_path(new_file_rel);
            let new_role = detect_role(new_file_rel, &new_title, &row.format).to_owned();
            let file_abs = canon_root.join(new_file_rel);
            let mtime_ms = collector::stat_fingerprint(&file_abs)
                .map(|fp| fp.mtime_ms)
                .unwrap_or(row.last_mtime_ms);
            writer.update_file_path_identity(
                &row.file_id,
                new_file_rel,
                &new_title,
                &new_role,
                &observed_at,
                mtime_ms,
            )?;
            writer.upsert_alias(
                workspace_id,
                old_file_rel,
                &row.file_id,
                &observed_at,
                evidence,
            )?;
            writer.upsert_alias(
                workspace_id,
                new_file_rel,
                &row.file_id,
                &observed_at,
                evidence,
            )?;
        }
        let evt_id = next_event_id(
            if operation == "folder_renamed" {
                "evt_dir_renamed"
            } else {
                "evt_dir_moved"
            },
            &stable_short(old_rel),
            &format!("{old_rel}->{new_rel}@{observed_at}"),
        );
        let (headline, detail) = if operation == "folder_renamed" {
            (
                format!("重命名文件夹：{old_rel} → {new_rel}"),
                format!(
                    "文件夹已重命名为 {new_rel}，共保持 {affected_count} 份文件的 file_id 与历史连续。"
                ),
            )
        } else {
            (
                format!("移动文件夹：{old_rel} → {new_rel}"),
                format!(
                    "文件夹已移动至 {new_rel}，共保持 {affected_count} 份文件的 file_id 与历史连续。"
                ),
            )
        };
        writer.insert_event(&NewEvent {
            event_id: evt_id,
            workspace_id: workspace_id.to_owned(),
            kind: operation.to_owned(),
            subject_kind: "folder".to_owned(),
            subject_id: new_rel.to_owned(),
            revision_id: None,
            occurred_at: Some(observed_at.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("collector".to_owned()),
            observed_at: observed_at.clone(),
            headline,
            detail,
            payload_json: json_object(&[
                ("old_path", json_string(old_rel)),
                ("new_path", json_string(new_rel)),
                ("affected_files", affected_count.to_string()),
            ]),
            batch_id: None,
        })?;
        if affected_count > 0 {
            let _ = recompute_full(writer, workspace_id, &observed_at)?;
        }
        writer.bump_generation(workspace_id)
    });

    let generation = match tx_res {
        Ok(gen) => gen,
        Err(err) => {
            let _ = fs::rename(&new_abs, &old_abs);
            return Err(err);
        }
    };

    Ok(FolderMutationResponse {
        ok: true,
        operation: operation.to_owned(),
        old_path: Some(old_rel.to_owned()),
        new_path: Some(new_rel.to_owned()),
        affected_files: affected_count,
        affected_file_ids: affected_ids,
        index_generation: generation,
        trash_recoverable: false,
    })
}

/// 将整个文件夹移入操作系统回收站（强制 confirm=true，绝不永久物理删除）。
pub fn trash_folder(
    writer: &mut Writer,
    input: &TrashFolderInput,
) -> Result<FolderMutationResponse, GuanlanError> {
    trash_folder_with(writer, input, &OsTrashDriver)
}

/// 可注入回收站驱动的文件夹回收站实现（生产仅经 [`trash_folder`] 走 OS 回收站）。
pub fn trash_folder_with(
    writer: &mut Writer,
    input: &TrashFolderInput,
    driver: &dyn TrashDriver,
) -> Result<FolderMutationResponse, GuanlanError> {
    if !input.confirm {
        return Err(GuanlanError::BadRequest(
            "文件夹移入回收站必须经人工二次确认（confirm=true）".to_owned(),
        ));
    }
    let workspace = writer.workspace()?;
    let segments = validate_nonempty_folder_segments(&input.folder_path)?;
    let old_rel = segments.join("/");
    let canon_root = canonical_workspace_root(&workspace.root_path)?;
    let old_abs = resolve_existing_dir_in_jail(&canon_root, &segments)?;

    let all_active = writer.list_files(&workspace.workspace_id, false)?;
    let subtree_files: Vec<(crate::storage::FileRow, String)> = all_active
        .into_iter()
        .filter_map(|row| {
            let cur_norm = normalize_rel_path(&row.current_path);
            strip_folder_prefix(&cur_norm, &old_rel).map(|_| (row, cur_norm))
        })
        .collect();

    let trash_method = driver.move_to_trash(&old_abs)?;
    if fs::symlink_metadata(&old_abs).is_ok() {
        return Err(GuanlanError::Internal(format!(
            "文件夹移入回收站后原路径仍存在：{old_rel}"
        )));
    }

    let observed_at = monotonic_now_iso();
    let affected_ids: Vec<String> = subtree_files
        .iter()
        .map(|(row, _)| row.file_id.clone())
        .collect();
    let affected_count = affected_ids.len();

    let generation = writer.transaction(|writer| {
        for (row, old_file_rel) in &subtree_files {
            writer.mark_file_status(&row.file_id, "trashed")?;
            writer.upsert_alias(
                &workspace.workspace_id,
                old_file_rel,
                &row.file_id,
                &observed_at,
                "explicit_trash",
            )?;
        }
        let evt_id = next_event_id(
            "evt_dir_trashed",
            &stable_short(&old_rel),
            &format!("{old_rel}@{observed_at}"),
        );
        writer.insert_event(&NewEvent {
            event_id: evt_id,
            workspace_id: workspace.workspace_id.clone(),
            kind: "folder_trashed".to_owned(),
            subject_kind: "folder".to_owned(),
            subject_id: old_rel.clone(),
            revision_id: None,
            occurred_at: Some(observed_at.clone()),
            occurred_precision: "second".to_owned(),
            occurred_source: Some("collector".to_owned()),
            observed_at: observed_at.clone(),
            headline: format!("文件夹已移入系统回收站：{old_rel}"),
            detail: format!(
                "文件夹 {old_rel}（含 {affected_count} 份受管文件）已移入操作系统回收站；还原后将自动重连原 file_id 与历史。"
            ),
            payload_json: json_object(&[
                ("path", json_string(&old_rel)),
                ("affected_files", affected_count.to_string()),
                ("recoverable", "true".to_owned()),
                ("trash_method", json_string(trash_method)),
            ]),
            batch_id: None,
        })?;
        if affected_count > 0 {
            let _ = recompute_full(writer, &workspace.workspace_id, &observed_at)?;
        }
        writer.bump_generation(&workspace.workspace_id)
    })?;

    Ok(FolderMutationResponse {
        ok: true,
        operation: "folder_trashed".to_owned(),
        old_path: Some(old_rel),
        new_path: None,
        affected_files: affected_count,
        affected_file_ids: affected_ids,
        index_generation: generation,
        trash_recoverable: true,
    })
}

const MAX_BATCH_FILE_OPS: usize = 200;

/// 批量跨目录移动文件（静默去重，逐个执行身份保真原子移动并如实汇报成败）。
pub fn batch_move_files(
    writer: &mut Writer,
    input: &BatchMoveFilesInput,
) -> Result<BatchFileMutationResponse, GuanlanError> {
    if input.file_ids.is_empty() {
        return Err(GuanlanError::BadRequest(
            "批量移动文件清单不能为空".to_owned(),
        ));
    }
    if input.file_ids.len() > MAX_BATCH_FILE_OPS {
        return Err(GuanlanError::BadRequest(format!(
            "单次批量移动上限为 {MAX_BATCH_FILE_OPS} 份文件"
        )));
    }
    let _ = validate_target_dir_segments(&input.target_dir)?;

    let mut seen = HashSet::new();
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    let mut latest_gen = writer.workspace()?.index_generation;

    for raw_id in &input.file_ids {
        if !seen.insert(raw_id.clone()) {
            continue;
        }
        match move_file(
            writer,
            &MoveFileInput {
                file_id: raw_id.clone(),
                target_dir: input.target_dir.clone(),
                new_name: None,
            },
        ) {
            Ok(resp) => {
                latest_gen = resp.index_generation;
                succeeded.push(resp);
            }
            Err(err) => {
                failed.push(BatchFileFailure {
                    file_id: raw_id.clone(),
                    error: err.to_string(),
                });
            }
        }
    }

    Ok(BatchFileMutationResponse {
        ok: !succeeded.is_empty() || failed.is_empty(),
        operation: "batch_moved".to_owned(),
        succeeded,
        failed,
        index_generation: latest_gen,
    })
}

/// 批量移入系统回收站（强制 confirm=true，逐个投递操作系统回收站并如实汇报成败）。
pub fn batch_trash_files_with(
    writer: &mut Writer,
    input: &BatchTrashFilesInput,
    driver: &dyn TrashDriver,
) -> Result<BatchFileMutationResponse, GuanlanError> {
    if !input.confirm {
        return Err(GuanlanError::BadRequest(
            "批量移入回收站必须经人工二次确认（confirm=true）".to_owned(),
        ));
    }
    if input.file_ids.is_empty() {
        return Err(GuanlanError::BadRequest(
            "批量回收站文件清单不能为空".to_owned(),
        ));
    }
    if input.file_ids.len() > MAX_BATCH_FILE_OPS {
        return Err(GuanlanError::BadRequest(format!(
            "单次批量删除上限为 {MAX_BATCH_FILE_OPS} 份文件"
        )));
    }

    let mut seen = HashSet::new();
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    let mut latest_gen = writer.workspace()?.index_generation;

    for raw_id in &input.file_ids {
        if !seen.insert(raw_id.clone()) {
            continue;
        }
        match trash_file_with(
            writer,
            &TrashFileInput {
                file_id: raw_id.clone(),
                confirm: true,
            },
            driver,
        ) {
            Ok(resp) => {
                latest_gen = resp.index_generation;
                succeeded.push(resp);
            }
            Err(err) => {
                failed.push(BatchFileFailure {
                    file_id: raw_id.clone(),
                    error: err.to_string(),
                });
            }
        }
    }

    Ok(BatchFileMutationResponse {
        ok: !succeeded.is_empty() || failed.is_empty(),
        operation: "batch_trashed".to_owned(),
        succeeded,
        failed,
        index_generation: latest_gen,
    })
}

#[cfg(windows)]
mod os_trash {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use crate::error::GuanlanError;

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    // CLSID_FileOperation: {3AD05575-8857-4850-9277-11B85BDB8E09}
    const CLSID_FILE_OPERATION: Guid = Guid {
        data1: 0x3AD0_5575,
        data2: 0x8857,
        data3: 0x4850,
        data4: [0x92, 0x77, 0x11, 0xB8, 0x5B, 0xDB, 0x8E, 0x09],
    };

    // IID_IFileOperation: {947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8}
    const IID_I_FILE_OPERATION: Guid = Guid {
        data1: 0x947A_AB5F,
        data2: 0x0A5C,
        data3: 0x4C13,
        data4: [0xB4, 0xD6, 0x4B, 0xF7, 0x83, 0x6F, 0xC9, 0xF8],
    };

    // IID_IShellItem: {43826D1E-E718-42EE-BC55-A1E261C37BFE}
    const IID_I_SHELL_ITEM: Guid = Guid {
        data1: 0x4382_6D1E,
        data2: 0xE718,
        data3: 0x42EE,
        data4: [0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE],
    };

    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
    const CLSCTX_INPROC_SERVER: u32 = 0x1;
    const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;

    const FOF_SILENT: u32 = 0x0004;
    const FOF_NOCONFIRMATION: u32 = 0x0010;
    const FOF_ALLOWUNDO: u32 = 0x0040;
    const FOF_NOERRORUI: u32 = 0x0400;
    // ShObjIdl_core.h: FOFX_RECYCLEONDELETE —— 仅走回收站，回收站不可用时失败而绝不静默永久删除
    const FOFX_RECYCLEONDELETE: u32 = 0x0008_0000;

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pv_reserved: *const c_void, dw_co_init: u32) -> i32;
        fn CoUninitialize();
        fn CoCreateInstance(
            rclsid: *const Guid,
            p_unk_outer: *mut c_void,
            dw_cls_context: u32,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHCreateItemFromParsingName(
            psz_path: *const u16,
            pbc: *mut c_void,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> i32;
    }

    #[repr(C)]
    struct ComObject {
        vtbl: *const *const c_void,
    }

    struct ComGuard<T: FnMut()> {
        cleanup: Option<T>,
    }

    impl<T: FnMut()> ComGuard<T> {
        fn new(cleanup: T) -> Self {
            Self {
                cleanup: Some(cleanup),
            }
        }
    }

    impl<T: FnMut()> Drop for ComGuard<T> {
        fn drop(&mut self) {
            if let Some(mut f) = self.cleanup.take() {
                f();
            }
        }
    }

    unsafe fn release_com(obj: *mut ComObject) {
        if !obj.is_null() {
            let release: unsafe extern "system" fn(*mut ComObject) -> u32 =
                std::mem::transmute(*(*obj).vtbl.add(2));
            release(obj);
        }
    }

    fn run_on_sta(path: &Path) -> Result<(), String> {
        // SAFETY: 所有 COM 指针、GUID、字符串均经空指针与 HRESULT 校验并由 ComGuard 释放。
        unsafe {
            let hr_init = CoInitializeEx(null(), COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            let need_uninit = if hr_init == 0 || hr_init == 1 {
                true
            } else if hr_init == RPC_E_CHANGED_MODE {
                // 当前线程已是 MTA，在干净的新 STA 线程上执行 Shell IFileOperation
                let owned = path.to_path_buf();
                return std::thread::spawn(move || run_on_sta(&owned))
                    .join()
                    .map_err(|_| "回收站线程异常中止".to_owned())?;
            } else {
                return Err(format!("COM 初始化失败：0x{hr_init:08x}"));
            };
            let _com_uninit = ComGuard::new(|| {
                if need_uninit {
                    CoUninitialize();
                }
            });

            let mut raw_op: *mut c_void = null_mut();
            let hr_create = CoCreateInstance(
                &CLSID_FILE_OPERATION,
                null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_I_FILE_OPERATION,
                &mut raw_op,
            );
            if hr_create < 0 || raw_op.is_null() {
                return Err(format!("创建系统文件操作对象失败：0x{hr_create:08x}"));
            }
            let op = raw_op as *mut ComObject;
            let _release_op = ComGuard::new(|| release_com(op));

            // 槽位核自 ShObjIdl_core.h：SetOperationFlags=5, DeleteItem=18,
            // PerformOperations=21, GetAnyOperationsAborted=22
            let set_flags: unsafe extern "system" fn(*mut ComObject, u32) -> i32 =
                std::mem::transmute(*(*op).vtbl.add(5));
            let delete_item: unsafe extern "system" fn(
                *mut ComObject,
                *mut c_void,
                *mut c_void,
            ) -> i32 = std::mem::transmute(*(*op).vtbl.add(18));
            let perform: unsafe extern "system" fn(*mut ComObject) -> i32 =
                std::mem::transmute(*(*op).vtbl.add(21));
            let get_aborted: unsafe extern "system" fn(*mut ComObject, *mut i32) -> i32 =
                std::mem::transmute(*(*op).vtbl.add(22));

            let flags = FOF_SILENT
                | FOF_NOCONFIRMATION
                | FOF_ALLOWUNDO
                | FOF_NOERRORUI
                | FOFX_RECYCLEONDELETE;
            let hr_flags = set_flags(op, flags);
            if hr_flags < 0 {
                return Err(format!("设置回收站标志失败：0x{hr_flags:08x}"));
            }

            let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
            wide_path.push(0);
            let mut raw_item: *mut c_void = null_mut();
            let hr_item = SHCreateItemFromParsingName(
                wide_path.as_ptr(),
                null_mut(),
                &IID_I_SHELL_ITEM,
                &mut raw_item,
            );
            if hr_item < 0 || raw_item.is_null() {
                return Err(format!(
                    "解析目标 ShellItem 失败（{}）：0x{hr_item:08x}",
                    path.display()
                ));
            }
            let item = raw_item as *mut ComObject;
            let _release_item = ComGuard::new(|| release_com(item));

            let hr_del = delete_item(op, raw_item, null_mut());
            if hr_del < 0 {
                return Err(format!("加入回收站删除队列失败：0x{hr_del:08x}"));
            }

            let hr_perf = perform(op);
            if hr_perf < 0 {
                return Err(format!("移入 Windows 回收站失败：0x{hr_perf:08x}"));
            }

            let mut aborted: i32 = 0;
            let hr_abort = get_aborted(op, &mut aborted);
            if hr_abort >= 0 && aborted != 0 {
                return Err("移入 Windows 回收站操作被中止".to_owned());
            }
            Ok(())
        }
    }

    pub fn move_to_trash(abs_path: &Path) -> Result<&'static str, GuanlanError> {
        run_on_sta(abs_path).map_err(GuanlanError::Internal)?;
        Ok("windows_recycle_bin")
    }
}

#[cfg(not(windows))]
mod os_trash {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use crate::error::GuanlanError;
    use crate::index::clock;

    #[cfg(target_os = "macos")]
    pub fn move_to_trash(abs_path: &Path) -> Result<&'static str, GuanlanError> {
        let escaped = abs_path
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let script = format!("tell application \"Finder\" to delete POSIX file \"{escaped}\"");
        if let Ok(output) = Command::new("osascript").args(["-e", &script]).output() {
            if output.status.success() && fs::symlink_metadata(abs_path).is_err() {
                return Ok("macos_finder_trash");
            }
        }
        // 无 GUI Finder 环境回退到 ~/.Trash 原子移动（绝不永久删除）
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| GuanlanError::Internal("无法解析 HOME 目录以定位废纸篓".to_owned()))?;
        let trash_dir = home.join(".Trash");
        fs::create_dir_all(&trash_dir)
            .map_err(|e| GuanlanError::Internal(format!("创建废纸篓目录失败：{e}")))?;
        let file_name = abs_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| GuanlanError::BadRequest("无效文件名".to_owned()))?;
        let target = pick_unique_in_dir(&trash_dir, file_name);
        fs::rename(abs_path, &target)
            .map_err(|e| GuanlanError::Internal(format!("移入废纸篓失败：{e}")))?;
        Ok("macos_trash_dir")
    }

    #[cfg(not(target_os = "macos"))]
    pub fn move_to_trash(abs_path: &Path) -> Result<&'static str, GuanlanError> {
        let trash_base =
            if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
                PathBuf::from(xdg).join("Trash")
            } else if let Some(home) = std::env::var_os("HOME") {
                PathBuf::from(home).join(".local/share/Trash")
            } else {
                return Err(GuanlanError::Internal(
                    "无法解析 XDG_DATA_HOME / HOME 以定位系统回收站".to_owned(),
                ));
            };
        let files_dir = trash_base.join("files");
        let info_dir = trash_base.join("info");
        fs::create_dir_all(&files_dir)
            .map_err(|e| GuanlanError::Internal(format!("创建回收站 files 目录失败：{e}")))?;
        fs::create_dir_all(&info_dir)
            .map_err(|e| GuanlanError::Internal(format!("创建回收站 info 目录失败：{e}")))?;

        let file_name = abs_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| GuanlanError::BadRequest("无效文件名".to_owned()))?;
        let (entry_name, dest_file, info_file) =
            pick_unique_freedesktop(&files_dir, &info_dir, file_name);
        let deletion_date = clock::now_iso();
        let deletion_stamp = deletion_date.get(..19).unwrap_or(&deletion_date);
        let encoded_path = percent_encode_path(&abs_path.to_string_lossy());
        let info_body =
            format!("[Trash Info]\nPath={encoded_path}\nDeletionDate={deletion_stamp}\n");
        fs::write(&info_file, info_body)
            .map_err(|e| GuanlanError::Internal(format!("写入回收站元信息失败：{e}")))?;

        match fs::rename(abs_path, &dest_file) {
            Ok(()) => Ok("freedesktop_trash"),
            Err(rename_err) => {
                // 跨挂载点尝试 gio trash（不调用永久物理删除）
                let _ = fs::remove_file(&info_file);
                if let Ok(output) = Command::new("gio").arg("trash").arg(abs_path).output() {
                    if output.status.success() && fs::symlink_metadata(abs_path).is_err() {
                        return Ok("gio_trash");
                    }
                }
                let _ = entry_name;
                Err(GuanlanError::Internal(format!(
                    "移入系统回收站失败：{rename_err}"
                )))
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn pick_unique_in_dir(dir: &Path, original_name: &str) -> PathBuf {
        let direct = dir.join(original_name);
        if fs::symlink_metadata(&direct).is_err() {
            return direct;
        }
        let path = Path::new(original_name);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(original_name);
        let ext = path.extension().and_then(|s| s.to_str());
        for i in 1..10_000 {
            let name = match ext {
                Some(e) if !e.is_empty() => format!("{stem} ({i}).{e}"),
                _ => format!("{stem} ({i})"),
            };
            let cand = dir.join(name);
            if fs::symlink_metadata(&cand).is_err() {
                return cand;
            }
        }
        dir.join(format!("{original_name}.{}", std::process::id()))
    }

    #[cfg(not(target_os = "macos"))]
    fn pick_unique_freedesktop(
        files_dir: &Path,
        info_dir: &Path,
        original_name: &str,
    ) -> (String, PathBuf, PathBuf) {
        let cand_file = files_dir.join(original_name);
        let cand_info = info_dir.join(format!("{original_name}.trashinfo"));
        if fs::symlink_metadata(&cand_file).is_err() && fs::symlink_metadata(&cand_info).is_err() {
            return (original_name.to_owned(), cand_file, cand_info);
        }
        let path = Path::new(original_name);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(original_name);
        let ext = path.extension().and_then(|s| s.to_str());
        for i in 1..10_000 {
            let name = match ext {
                Some(e) if !e.is_empty() => format!("{stem} ({i}).{e}"),
                _ => format!("{stem} ({i})"),
            };
            let cf = files_dir.join(&name);
            let ci = info_dir.join(format!("{name}.trashinfo"));
            if fs::symlink_metadata(&cf).is_err() && fs::symlink_metadata(&ci).is_err() {
                return (name, cf, ci);
            }
        }
        let fallback = format!("{original_name}.{}", std::process::id());
        (
            fallback.clone(),
            files_dir.join(&fallback),
            info_dir.join(format!("{fallback}.trashinfo")),
        )
    }

    #[cfg(not(target_os = "macos"))]
    fn percent_encode_path(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());
        for b in raw.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                    out.push(b as char)
                }
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{reconcile, ReconcileOptions};
    use crate::query::{
        self, DecisionsQuery, FileListQuery, FileRevisionsQuery, RevisionIncludeSection,
    };
    use crate::storage::ReadonlyStore;
    use std::sync::atomic::AtomicU64;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TestEnv {
        base: PathBuf,
        root: PathBuf,
        data_dir: PathBuf,
        trash_dir: PathBuf,
    }

    impl TestEnv {
        fn new(tag: &str) -> Self {
            let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let base = std::env::temp_dir().join(format!(
                "guanlan-a05-{tag}-{}-{seq}-{nanos}",
                std::process::id()
            ));
            let root = base.join("workspace");
            let data_dir = base.join("data");
            let trash_dir = base.join("trash");
            fs::create_dir_all(&root).expect("创建测试工作区");
            fs::create_dir_all(&data_dir).expect("创建测试数据目录");
            fs::create_dir_all(&trash_dir).expect("创建测试回收站目录");
            Self {
                base,
                root,
                data_dir,
                trash_dir,
            }
        }

        fn write(&self, rel: &str, body: &str) {
            let full = self.root.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).expect("创建父目录");
            }
            fs::write(full, body).expect("写测试文件");
        }

        fn writer(&self) -> Writer {
            Writer::open_at(&self.data_dir, &self.root.to_string_lossy()).expect("打开写库")
        }

        fn readonly(&self) -> ReadonlyStore {
            let mut store =
                ReadonlyStore::open(&self.data_dir.join("index.db")).expect("打开只读库");
            store
                .claim_workspace(&self.root.to_string_lossy())
                .expect("认领工作区");
            store
        }

        fn scan(&self, writer: &mut Writer, observed_at: &str) -> crate::index::ReconcileReport {
            reconcile(
                writer,
                &ReconcileOptions {
                    observed_at: Some(observed_at.to_owned()),
                    ..Default::default()
                },
            )
            .expect("对账")
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    struct TempTrashDriver {
        trash_dir: PathBuf,
    }

    impl TrashDriver for TempTrashDriver {
        fn move_to_trash(&self, abs_path: &Path) -> Result<&'static str, GuanlanError> {
            let name = abs_path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| GuanlanError::BadRequest("无效文件名".to_owned()))?;
            let dest = self.trash_dir.join(name);
            fs::rename(abs_path, dest)
                .map_err(|e| GuanlanError::Internal(format!("模拟回收站移动失败：{e}")))?;
            Ok("test_trash_dir")
        }
    }

    #[test]
    fn rename_and_move_preserve_file_id_history_decisions_and_aliases() {
        let env = TestEnv::new("rename-move");
        env.write(
            "01-演示专项/03-待确认事项.md",
            "---\ndate: 2026-05-01\n---\n# 03-待确认事项\n\n## 1. 接口策略\n沿用编号：Q01\n状态：待确认\n- **选项 A**：同步写回\n",
        );
        env.write("01-演示专项/设计图.svg", "<svg><text>v1</text></svg>");
        env.write(
            "01-演示专项/总览.md",
            "# 总览\n\n参考 [待确认](./03-待确认事项.md)\n",
        );

        let mut writer = env.writer();
        let r1 = env.scan(&mut writer, "2026-11-18T10:00:00.000Z");
        assert_eq!(r1.new_files, 3);

        // 追加 v2 版本
        env.write(
            "01-演示专项/03-待确认事项.md",
            "---\ndate: 2026-05-01\n---\n# 03-待确认事项\n\n## 1. 接口策略\n沿用编号：Q01\n状态：待确认\n- **选项 A**：同步写回\n补充说明 v2\n",
        );
        let _ = env.scan(&mut writer, "2026-11-18T10:05:00.000Z");

        let before = writer
            .find_file_by_path(&r1.workspace_id, "01-演示专项/03-待确认事项.md")
            .expect("查找文件")
            .expect("文件存在");
        let original_id = before.file_id.clone();

        // 1) 同目录重命名
        let renamed = rename_file(
            &mut writer,
            &RenameFileInput {
                file_id: original_id.clone(),
                new_name: "03-核心拍板单.md".to_owned(),
            },
        )
        .expect("重命名应成功");
        assert_eq!(renamed.operation, "file_renamed");
        assert_eq!(renamed.file_id, original_id);
        assert_eq!(renamed.old_path, "01-演示专项/03-待确认事项.md");
        assert_eq!(
            renamed.new_path.as_deref(),
            Some("01-演示专项/03-核心拍板单.md")
        );
        assert!(!env.root.join("01-演示专项/03-待确认事项.md").exists());
        assert!(env.root.join("01-演示专项/03-核心拍板单.md").is_file());

        // 2) 跨目录移动到新建子目录
        let moved = move_file(
            &mut writer,
            &MoveFileInput {
                file_id: original_id.clone(),
                target_dir: "02-方案归档/决策组".to_owned(),
                new_name: Some("03-定稿拍板单.md".to_owned()),
            },
        )
        .expect("移动应成功");
        assert_eq!(moved.operation, "file_moved");
        assert_eq!(moved.file_id, original_id);
        assert_eq!(
            moved.new_path.as_deref(),
            Some("02-方案归档/决策组/03-定稿拍板单.md")
        );
        assert!(env
            .root
            .join("02-方案归档/决策组/03-定稿拍板单.md")
            .is_file());

        // 3) 校验历史版本链、决定证据与路径别名全部连续
        let store = env.readonly();
        let history = query::file_revisions(
            &store,
            &original_id,
            &FileRevisionsQuery {
                include: vec![
                    RevisionIncludeSection::Events,
                    RevisionIncludeSection::Statements,
                    RevisionIncludeSection::Aliases,
                ],
                ..Default::default()
            },
        )
        .expect("读取版本链");
        assert_eq!(history.revisions.len(), 2, "历史版本链 100% 连续不断裂");
        assert_eq!(
            history.file.current_path,
            "02-方案归档/决策组/03-定稿拍板单.md"
        );
        let events = history.events.expect("events");
        assert!(events.iter().any(|e| e.kind == "file_renamed"));
        assert!(events.iter().any(|e| e.kind == "file_moved"));
        let aliases = history.aliases.expect("aliases");
        assert!(aliases.contains(&"01-演示专项/03-待确认事项.md".to_owned()));
        assert!(aliases.contains(&"01-演示专项/03-核心拍板单.md".to_owned()));
        assert!(aliases.contains(&"02-方案归档/决策组/03-定稿拍板单.md".to_owned()));

        let decs = query::decisions(&store, &DecisionsQuery::default()).expect("decisions");
        assert_eq!(decs.total, 1);
        assert_eq!(decs.items[0].evidences[0].file_id, original_id);
        assert_eq!(
            decs.items[0].evidences[0].relative_path,
            "02-方案归档/决策组/03-定稿拍板单.md"
        );

        // 4) 重扫幂等 + 在旧路径新建文件不会劫持旧 file_id
        let rescan = env.scan(&mut writer, "2026-11-18T10:10:00.000Z");
        assert_eq!(rescan.new_files, 0);
        assert_eq!(rescan.missing, 0);
        assert_eq!(rescan.recovered, 0);

        env.write(
            "01-演示专项/03-待确认事项.md",
            "# 全新同名文件\n\n独立内容。\n",
        );
        let after_new = env.scan(&mut writer, "2026-11-18T10:15:00.000Z");
        assert_eq!(after_new.new_files, 1);
        let new_file = writer
            .find_file_by_path(&r1.workspace_id, "01-演示专项/03-待确认事项.md")
            .expect("查询新文件")
            .expect("新文件存在");
        assert_ne!(
            new_file.file_id, original_id,
            "在旧路径新建文件必须分配独立 file_id，绝不覆盖已迁移文件的身份"
        );
        let old_still_there = writer
            .get_file(&original_id)
            .expect("查原文件")
            .expect("原文件仍在");
        assert_eq!(
            old_still_there.current_path,
            "02-方案归档/决策组/03-定稿拍板单.md"
        );
    }

    #[test]
    fn security_guards_block_traversal_reserved_excluded_and_format_mismatch() {
        let env = TestEnv::new("security");
        env.write("docs/spec.md", "# 规范\n");
        env.write("docs/other.md", "# 另一篇\n");
        let mut writer = env.writer();
        let report = env.scan(&mut writer, "2026-11-18T10:00:00.000Z");
        let spec = writer
            .find_file_by_path(&report.workspace_id, "docs/spec.md")
            .expect("查文件")
            .expect("存在");

        for bad_name in [
            "../evil.md",
            "a/b.md",
            "bad:stream.md",
            ".hidden.md",
            "CON.md",
            "spec.exe",
            "spec.svg",
            "",
        ] {
            let err = rename_file(
                &mut writer,
                &RenameFileInput {
                    file_id: spec.file_id.clone(),
                    new_name: bad_name.to_owned(),
                },
            )
            .expect_err("非法文件名应被拦截");
            assert_eq!(err.code(), "BAD_REQUEST", "bad_name={bad_name:?} => {err}");
        }

        // 重名冲突
        let conflict = rename_file(
            &mut writer,
            &RenameFileInput {
                file_id: spec.file_id.clone(),
                new_name: "other.md".to_owned(),
            },
        )
        .expect_err("同名冲突应拦截");
        assert_eq!(conflict.code(), "CONFLICT");

        for bad_dir in [
            "../outside",
            "/abs/dir",
            "C:\\Windows\\System32",
            "node_modules/sub",
            ".git/hooks",
            "docs/.hidden",
            "NUL/sub",
        ] {
            let err = move_file(
                &mut writer,
                &MoveFileInput {
                    file_id: spec.file_id.clone(),
                    target_dir: bad_dir.to_owned(),
                    new_name: None,
                },
            )
            .expect_err("非法目标目录应被拦截");
            assert_eq!(err.code(), "BAD_REQUEST", "bad_dir={bad_dir:?} => {err}");
        }
    }

    #[test]
    fn trash_requires_confirm_and_restore_reconnects_original_file_id() {
        let env = TestEnv::new("trash-restore");
        env.write(
            "docs/plan.md",
            "# 计划\n\n## 1. 选型\n沿用编号：Q02\n状态：待确认\n",
        );
        let mut writer = env.writer();
        let r1 = env.scan(&mut writer, "2026-11-18T10:00:00.000Z");
        let file = writer
            .find_file_by_path(&r1.workspace_id, "docs/plan.md")
            .expect("查文件")
            .expect("存在");
        let driver = TempTrashDriver {
            trash_dir: env.trash_dir.clone(),
        };

        // 1) 未二次确认拒绝执行
        let unconfirmed = trash_file_with(
            &mut writer,
            &TrashFileInput {
                file_id: file.file_id.clone(),
                confirm: false,
            },
            &driver,
        )
        .expect_err("confirm=false 必须拦截");
        assert_eq!(unconfirmed.code(), "BAD_REQUEST");
        assert!(env.root.join("docs/plan.md").is_file());

        // 2) 二次确认移入回收站
        let trashed = trash_file_with(
            &mut writer,
            &TrashFileInput {
                file_id: file.file_id.clone(),
                confirm: true,
            },
            &driver,
        )
        .expect("移入回收站应成功");
        assert_eq!(trashed.operation, "file_trashed");
        assert_eq!(trashed.status, "trashed");
        assert!(trashed.trash_recoverable);
        assert!(!env.root.join("docs/plan.md").exists());
        assert!(env.trash_dir.join("plan.md").is_file());

        // 活动列表不可见，可恢复列表可见（保护前端阅读进度不误删）
        let store = env.readonly();
        let active_list =
            query::list_files(&store, &FileListQuery::default()).expect("active files");
        assert_eq!(active_list.total_matched, 0);
        let recoverable_list = query::list_files(
            &store,
            &FileListQuery {
                status: Some("recoverable".to_owned()),
                ..Default::default()
            },
        )
        .expect("recoverable files");
        assert_eq!(recoverable_list.total_matched, 1);
        assert_eq!(recoverable_list.items[0].file_id, file.file_id);
        assert_eq!(
            store
                .recoverable_file_ids(&r1.workspace_id)
                .expect("recoverable ids"),
            vec![file.file_id.clone()]
        );

        // 3) 整库对账期间维持 trashed，不误覆盖为 missing
        let scan_while_trashed = env.scan(&mut writer, "2026-11-18T10:05:00.000Z");
        assert_eq!(scan_while_trashed.missing, 0);
        assert_eq!(
            writer
                .get_file(&file.file_id)
                .expect("查文件")
                .expect("存在")
                .status,
            "trashed"
        );

        // 4) 从回收站还原回原路径 → 自动重连原 file_id + read_recovered 事件 + 保留历史/决定
        fs::rename(env.trash_dir.join("plan.md"), env.root.join("docs/plan.md")).expect("还原文件");
        let restored = env.scan(&mut writer, "2026-11-18T10:10:00.000Z");
        assert_eq!(restored.new_files, 0, "还原不得分裂成新文件");
        assert_eq!(restored.recovered, 1);
        let file_after = writer
            .get_file(&file.file_id)
            .expect("查文件")
            .expect("存在");
        assert_eq!(file_after.status, "active");

        let history = query::file_revisions(
            &store,
            &file.file_id,
            &FileRevisionsQuery {
                include: vec![RevisionIncludeSection::Events],
                ..Default::default()
            },
        )
        .expect("history");
        assert_eq!(history.revisions.len(), 1);
        let events = history.events.expect("events");
        assert!(events.iter().any(|e| e.kind == "file_trashed"));
        assert!(events.iter().any(|e| e.kind == "read_recovered"));
    }

    #[test]
    fn folder_list_create_rename_move_trash_and_create_doc_preserve_identity() {
        let env = TestEnv::new("folder-lifecycle");
        env.write("docs/spec.md", "# Spec\n\nhello\n");
        env.write("docs/sub/plan.md", "# Plan\n\nworld\n");
        fs::create_dir_all(env.root.join("empty-inbox")).expect("建空目录");
        fs::create_dir_all(env.root.join(".hidden-dir")).expect("建隐藏目录");
        fs::create_dir_all(env.root.join("node_modules/pkg")).expect("建排除目录");

        let listing = collector::collect_workspace_folders(
            &env.root,
            &[],
            collector::DEFAULT_MAX_FOLDERS,
            collector::DEFAULT_MAX_DEPTH,
        );
        assert!(!listing.truncated);
        let folders = listing.folders;
        assert!(
            folders.contains(&"empty-inbox".to_owned()),
            "必须包含空文件夹"
        );
        assert!(folders.contains(&"docs".to_owned()));
        assert!(folders.contains(&"docs/sub".to_owned()));
        assert!(!folders.iter().any(|f| f.starts_with('.')));
        assert!(!folders.iter().any(|f| f.contains("node_modules")));

        let mut writer = env.writer();
        env.scan(&mut writer, "2026-11-22T01:00:00.000Z");
        let spec_before = writer
            .find_file_by_path(&writer.workspace().unwrap().workspace_id, "docs/spec.md")
            .unwrap()
            .unwrap();
        let plan_before = writer
            .find_file_by_path(
                &writer.workspace().unwrap().workspace_id,
                "docs/sub/plan.md",
            )
            .unwrap()
            .unwrap();

        // 1) 新建嵌套文件夹 + 新建文档并立即入库
        let created_dir = create_folder(
            &mut writer,
            &CreateFolderInput {
                parent_dir: "empty-inbox".to_owned(),
                name: "2026".to_owned(),
            },
        )
        .expect("新建子文件夹");
        assert_eq!(created_dir.new_path.as_deref(), Some("empty-inbox/2026"));
        assert!(env.root.join("empty-inbox/2026").is_dir());

        let created_doc = create_document(
            &mut writer,
            &CreateDocumentInput {
                target_dir: "empty-inbox/2026".to_owned(),
                name: "周报".to_owned(),
                initial_content: None,
            },
        )
        .expect("新建文档");
        assert_eq!(created_doc.relative_path, "empty-inbox/2026/周报.md");
        assert!(!created_doc.file_id.is_empty());

        // 2) 重命名文件夹 → 子树所有文件 file_id 不裂链
        let renamed = rename_folder(
            &mut writer,
            &RenameFolderInput {
                folder_path: "docs".to_owned(),
                new_name: "specs".to_owned(),
            },
        )
        .expect("重命名文件夹");
        assert_eq!(renamed.affected_files, 2);
        let spec_after = writer.get_file(&spec_before.file_id).unwrap().unwrap();
        let plan_after = writer.get_file(&plan_before.file_id).unwrap().unwrap();
        assert_eq!(spec_after.current_path, "specs/spec.md");
        assert_eq!(plan_after.current_path, "specs/sub/plan.md");

        // 3) 防成环：禁止把 specs 移入 specs/sub
        let cycle_err = move_folder(
            &mut writer,
            &MoveFolderInput {
                folder_path: "specs".to_owned(),
                target_parent_dir: "specs/sub".to_owned(),
            },
        )
        .expect_err("必须拦截移入子目录成环");
        assert!(matches!(cycle_err, GuanlanError::BadRequest(_)));

        // 4) 合法移动文件夹 specs → empty-inbox/specs
        let moved = move_folder(
            &mut writer,
            &MoveFolderInput {
                folder_path: "specs".to_owned(),
                target_parent_dir: "empty-inbox".to_owned(),
            },
        )
        .expect("移动文件夹");
        assert_eq!(moved.new_path.as_deref(), Some("empty-inbox/specs"));
        assert_eq!(moved.affected_files, 2);
        assert_eq!(
            writer
                .get_file(&plan_before.file_id)
                .unwrap()
                .unwrap()
                .current_path,
            "empty-inbox/specs/sub/plan.md"
        );

        // 5) 批量移动两个文件到根目录
        let batch_moved = batch_move_files(
            &mut writer,
            &BatchMoveFilesInput {
                file_ids: vec![spec_before.file_id.clone(), created_doc.file_id.clone()],
                target_dir: "".to_owned(),
            },
        )
        .expect("批量移动");
        assert_eq!(batch_moved.succeeded.len(), 2);
        assert!(batch_moved.failed.is_empty());
        assert_eq!(
            writer
                .get_file(&spec_before.file_id)
                .unwrap()
                .unwrap()
                .current_path,
            "spec.md"
        );

        // 6) 文件夹移入回收站（未确认必拒；确认后安全进回收站并标记子树文件 trashed）
        let driver = TempTrashDriver {
            trash_dir: env.trash_dir.clone(),
        };
        let reject_unconfirmed = trash_folder_with(
            &mut writer,
            &TrashFolderInput {
                folder_path: "empty-inbox/specs".to_owned(),
                confirm: false,
            },
            &driver,
        )
        .expect_err("confirm=false 必须拒绝");
        assert!(matches!(reject_unconfirmed, GuanlanError::BadRequest(_)));

        let trashed_dir = trash_folder_with(
            &mut writer,
            &TrashFolderInput {
                folder_path: "empty-inbox/specs".to_owned(),
                confirm: true,
            },
            &driver,
        )
        .expect("确认后移入回收站");
        assert_eq!(trashed_dir.affected_files, 1);
        assert!(trashed_dir.trash_recoverable);
        assert!(!env.root.join("empty-inbox/specs").exists());
        assert!(env.trash_dir.join("specs").is_dir());
        assert_eq!(
            writer
                .get_file(&plan_before.file_id)
                .unwrap()
                .unwrap()
                .status,
            "trashed"
        );

        // 7) 批量移入回收站
        let batch_trashed = batch_trash_files_with(
            &mut writer,
            &BatchTrashFilesInput {
                file_ids: vec![spec_before.file_id.clone(), created_doc.file_id.clone()],
                confirm: true,
            },
            &driver,
        )
        .expect("批量回收站");
        assert_eq!(batch_trashed.succeeded.len(), 2);
        assert_eq!(
            writer
                .get_file(&spec_before.file_id)
                .unwrap()
                .unwrap()
                .status,
            "trashed"
        );
    }
}
