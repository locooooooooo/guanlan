//! 原生系统桥接：资源管理器定位高亮、系统默认应用打开、剪贴板写入、外部文件安全导入。
//!
//! 安全红线（停机条件：允许写到 `root_path` 之外即停）：
//! - 所有工作区相对路径必须经 `validate_relative_segments` + 逐段符号链接/规范化校验，
//!   100% 拦截 `..`、绝对路径、盘符、UNC 前缀、NTFS 流冒号与逃逸符号链接；
//! - 外部文件导入只允许拷贝到 `root_path` 内部的指定相对目录，走同目录 `.tmp` + 原子
//!   rename 落盘，同名冲突自动改名（`stem (1).ext`），绝不静默覆盖既有文件。

use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

static IMPORT_TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActionError {
    pub code: String,
    pub message: String,
}

impl BridgeActionError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActionOk {
    pub ok: bool,
    pub message: String,
    pub absolute_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFileEntry {
    pub source_path: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub file_name: String,
    pub bytes: u64,
    pub renamed: bool,
    pub indexed_by_current_engine: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImportEntry {
    pub source_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalFilesResult {
    pub ok: bool,
    pub target_dir: String,
    pub imported: Vec<ImportedFileEntry>,
    pub skipped: Vec<SkippedImportEntry>,
    pub indexed_relative_paths: Vec<String>,
    pub job_id: Option<String>,
}

/// 剥离 Windows `std::fs::canonicalize` 产出的 `\\?\` 长路径前缀，
/// 避免 Explorer `/select,` 与 Shell API 无法识别或 UI 展示异常。
pub fn strip_win_verbatim_prefix(path: &Path) -> PathBuf {
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

fn validate_single_segment(seg: &str) -> Result<(), BridgeActionError> {
    if seg.is_empty() || seg == "." || seg == ".." {
        return Err(BridgeActionError::new(
            "INVALID_PATH",
            format!("非法路径段：{seg}"),
        ));
    }
    if seg.contains(':') || seg.contains('\0') || seg.contains('/') || seg.contains('\\') {
        return Err(BridgeActionError::new(
            "INVALID_PATH",
            format!("路径段包含非法字符：{seg}"),
        ));
    }
    if seg.chars().any(|c| c.is_control()) {
        return Err(BridgeActionError::new("INVALID_PATH", "路径段包含控制字符"));
    }
    if is_windows_reserved_stem(seg) {
        return Err(BridgeActionError::new(
            "INVALID_PATH",
            format!("路径段命中系统保留名称：{seg}"),
        ));
    }
    Ok(())
}

/// 解析并校验工作区相对路径段，100% 拦截绝对路径、盘符、UNC、`.`/`..` 上跳与空段。
pub fn validate_relative_segments(
    raw: &str,
    allow_root: bool,
) -> Result<Vec<String>, BridgeActionError> {
    if raw.contains('\0') {
        return Err(BridgeActionError::new("INVALID_PATH", "路径包含空字节"));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "." {
        if allow_root {
            return Ok(Vec::new());
        }
        return Err(BridgeActionError::new("INVALID_PATH", "相对路径不能为空"));
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(BridgeActionError::new("INVALID_PATH", "拒绝绝对路径"));
    }
    if normalized.contains(':') {
        return Err(BridgeActionError::new(
            "INVALID_PATH",
            "拒绝带盘符或流前缀的路径",
        ));
    }
    let probe = Path::new(&normalized);
    if probe.is_absolute() {
        return Err(BridgeActionError::new("INVALID_PATH", "拒绝绝对路径"));
    }
    for component in probe.components() {
        match component {
            Component::Normal(_) => {}
            Component::ParentDir => {
                return Err(BridgeActionError::new("INVALID_PATH", "拒绝 `..` 上跳段"));
            }
            _ => {
                return Err(BridgeActionError::new(
                    "INVALID_PATH",
                    format!("拒绝非法路径段：{component:?}"),
                ));
            }
        }
    }
    let mut segments = Vec::new();
    for seg in normalized.split('/') {
        validate_single_segment(seg)?;
        segments.push(seg.to_owned());
    }
    Ok(segments)
}

fn canonical_root(root: &Path) -> Result<PathBuf, BridgeActionError> {
    if !root.is_dir() {
        return Err(BridgeActionError::new(
            "NOT_FOUND",
            format!("工作区根目录不存在：{}", root.display()),
        ));
    }
    fs::canonicalize(root).map_err(|e| {
        BridgeActionError::new(
            "IO",
            format!("规范化工作区根目录失败：{} ({e})", root.display()),
        )
    })
}

/// 校验已有目标位于 `root` 之内（逐段查重解析点 + canonicalize `starts_with` 校验）。
pub fn resolve_existing_inside_workspace(
    root: &Path,
    relative_path: &str,
    allow_root: bool,
) -> Result<(PathBuf, bool), BridgeActionError> {
    let canon_root = canonical_root(root)?;
    let segments = validate_relative_segments(relative_path, allow_root)?;
    if segments.is_empty() {
        return Ok((strip_win_verbatim_prefix(&canon_root), true));
    }

    let mut cur = canon_root.clone();
    for seg in &segments {
        cur.push(seg);
        let meta = fs::symlink_metadata(&cur).map_err(|e| {
            BridgeActionError::new(
                "NOT_FOUND",
                format!("目标不存在或不可访问：{relative_path} ({e})"),
            )
        })?;
        let canon_step = fs::canonicalize(&cur).map_err(|e| {
            BridgeActionError::new(
                "NOT_FOUND",
                format!("解析目标路径失败：{relative_path} ({e})"),
            )
        })?;
        if !canon_step.starts_with(&canon_root) {
            return Err(BridgeActionError::new(
                "INVALID_PATH",
                format!("拒绝逃逸工作区根目录的路径：{relative_path}"),
            ));
        }
        let _ = meta;
    }

    let clean = strip_win_verbatim_prefix(&fs::canonicalize(&cur).map_err(|e| {
        BridgeActionError::new("NOT_FOUND", format!("目标不可解析：{relative_path} ({e})"))
    })?);
    Ok((clean, false))
}

/// 校验并按需创建工作区内的目标子目录，严格拦截越界写入及隐藏点目录。
pub fn resolve_target_dir_inside_workspace(
    root: &Path,
    target_dir: &str,
) -> Result<(PathBuf, String), BridgeActionError> {
    let canon_root = canonical_root(root)?;
    let segments = validate_relative_segments(target_dir, true)?;
    for seg in &segments {
        if seg.starts_with('.') {
            return Err(BridgeActionError::new(
                "INVALID_PATH",
                format!("禁止导入到隐藏目录：{seg}"),
            ));
        }
    }

    let mut cur = canon_root.clone();
    for seg in &segments {
        cur.push(seg);
        match fs::symlink_metadata(&cur) {
            Ok(meta) => {
                let canon_step = fs::canonicalize(&cur).map_err(|e| {
                    BridgeActionError::new("IO", format!("规范化目录失败：{} ({e})", cur.display()))
                })?;
                if !canon_step.starts_with(&canon_root) {
                    return Err(BridgeActionError::new(
                        "INVALID_PATH",
                        format!("拒绝越界符号链接目录：{target_dir}"),
                    ));
                }
                if !canon_step.is_dir() && !meta.is_dir() {
                    return Err(BridgeActionError::new(
                        "INVALID_PATH",
                        format!("目标路径不是目录：{target_dir}"),
                    ));
                }
                cur = canon_step;
            }
            Err(_) => {
                fs::create_dir(&cur).map_err(|e| {
                    BridgeActionError::new(
                        "IO",
                        format!("创建目标目录失败：{} ({e})", cur.display()),
                    )
                })?;
                let canon_step = fs::canonicalize(&cur).map_err(|e| {
                    BridgeActionError::new(
                        "IO",
                        format!("校验新建目录失败：{} ({e})", cur.display()),
                    )
                })?;
                if !canon_step.starts_with(&canon_root) {
                    return Err(BridgeActionError::new(
                        "INVALID_PATH",
                        format!("新建目录越界工作区：{target_dir}"),
                    ));
                }
                cur = canon_step;
            }
        }
    }

    let rel_norm = segments.join("/");
    Ok((strip_win_verbatim_prefix(&cur), rel_norm))
}

fn looks_like_pdf_header(path: &Path) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok() && &magic == b"%PDF"
}

fn is_indexed_by_current_engine(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if matches!(ext.as_str(), "md" | "markdown" | "svg" | "pdf") {
        return true;
    }
    ext.is_empty() && looks_like_pdf_header(path)
}

fn pick_non_colliding_name(dest_dir: &Path, original_name: &str) -> (PathBuf, String, bool) {
    let direct = dest_dir.join(original_name);
    if fs::symlink_metadata(&direct).is_err() {
        return (direct, original_name.to_owned(), false);
    }

    let path_obj = Path::new(original_name);
    let stem = path_obj
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(original_name);
    let ext = path_obj.extension().and_then(OsStr::to_str);

    for idx in 1..10_000u32 {
        let candidate_name = match ext {
            Some(e) if !e.is_empty() => format!("{stem} ({idx}).{e}"),
            _ => format!("{stem} ({idx})"),
        };
        let candidate_path = dest_dir.join(&candidate_name);
        if fs::symlink_metadata(&candidate_path).is_err() {
            return (candidate_path, candidate_name, true);
        }
    }

    let seq = IMPORT_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let fallback_name = match ext {
        Some(e) if !e.is_empty() => format!("{stem}-{seq}.{e}"),
        _ => format!("{stem}-{seq}"),
    };
    (dest_dir.join(&fallback_name), fallback_name, true)
}

fn copy_file_atomically(
    src: &Path,
    dest_dir: &Path,
    dest_file: &Path,
    final_name: &str,
) -> Result<u64, String> {
    let seq = IMPORT_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(
        ".{final_name}.guanlan-import-{}-{seq}.tmp",
        std::process::id()
    );
    let tmp_path = dest_dir.join(tmp_name);

    let result = (|| -> Result<u64, String> {
        let mut reader = fs::File::open(src).map_err(|e| format!("读取源文件失败：{e}"))?;
        let mut writer =
            fs::File::create(&tmp_path).map_err(|e| format!("创建临时文件失败：{e}"))?;
        let bytes = std::io::copy(&mut reader, &mut writer)
            .map_err(|e| format!("拷贝文件内容失败：{e}"))?;
        writer
            .flush()
            .map_err(|e| format!("刷新写入缓冲失败：{e}"))?;
        writer
            .sync_all()
            .map_err(|e| format!("落盘同步失败：{e}"))?;
        drop(writer);
        fs::rename(&tmp_path, dest_file).map_err(|e| format!("原子落盘失败：{e}"))?;
        Ok(bytes)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

/// 将外部文件批量安全拷贝到工作区指定相对目录（零越界、零覆写、原子落盘）。
pub fn import_external_files_impl(
    root: &Path,
    target_dir: &str,
    source_paths: &[String],
) -> Result<ImportExternalFilesResult, BridgeActionError> {
    if source_paths.is_empty() {
        return Err(BridgeActionError::new("EMPTY_INPUT", "未提供要导入的文件"));
    }

    let canon_root = canonical_root(root)?;
    let (dest_dir, target_dir_rel) = resolve_target_dir_inside_workspace(root, target_dir)?;
    let canon_dest_dir = fs::canonicalize(&dest_dir).map_err(|e| {
        BridgeActionError::new(
            "IO",
            format!("校验目标目录失败：{} ({e})", dest_dir.display()),
        )
    })?;
    if !canon_dest_dir.starts_with(&canon_root) {
        return Err(BridgeActionError::new(
            "INVALID_PATH",
            "拒绝写入工作区根目录之外",
        ));
    }

    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut indexed_relative_paths = Vec::new();

    for raw_src in source_paths {
        let trimmed = raw_src.trim();
        if trimmed.is_empty() {
            continue;
        }
        let src_path = Path::new(trimmed);
        let meta = match fs::metadata(src_path) {
            Ok(m) => m,
            Err(e) => {
                skipped.push(SkippedImportEntry {
                    source_path: raw_src.clone(),
                    reason: format!("源文件不存在或不可读取：{e}"),
                });
                continue;
            }
        };
        if !meta.is_file() {
            skipped.push(SkippedImportEntry {
                source_path: raw_src.clone(),
                reason: "仅支持导入常规文件（不支持直接拖入目录）".to_owned(),
            });
            continue;
        }

        let Some(raw_name) = src_path.file_name().and_then(OsStr::to_str) else {
            skipped.push(SkippedImportEntry {
                source_path: raw_src.clone(),
                reason: "无法解析合法 UTF-8 文件名".to_owned(),
            });
            continue;
        };
        if let Err(err) = validate_single_segment(raw_name) {
            skipped.push(SkippedImportEntry {
                source_path: raw_src.clone(),
                reason: err.message,
            });
            continue;
        }
        if raw_name.starts_with('.') {
            skipped.push(SkippedImportEntry {
                source_path: raw_src.clone(),
                reason: "拒绝导入点号开头的隐藏文件".to_owned(),
            });
            continue;
        }

        // 若源文件已在同一个目标目录内，不再自我复制制造冗余副本
        if let Ok(canon_src) = fs::canonicalize(src_path) {
            if canon_src.parent() == Some(canon_dest_dir.as_path()) {
                skipped.push(SkippedImportEntry {
                    source_path: raw_src.clone(),
                    reason: "该文件已位于目标目录中".to_owned(),
                });
                continue;
            }
        }

        let (dest_file, final_name, renamed) = pick_non_colliding_name(&dest_dir, raw_name);
        if dest_file.parent() != Some(dest_dir.as_path()) {
            return Err(BridgeActionError::new(
                "INVALID_PATH",
                "落盘路径超出指定目标目录",
            ));
        }

        match copy_file_atomically(src_path, &dest_dir, &dest_file, &final_name) {
            Ok(bytes) => {
                let canon_written = fs::canonicalize(&dest_file)
                    .map_err(|e| BridgeActionError::new("IO", format!("落盘校验失败：{e}")))?;
                if !canon_written.starts_with(&canon_root) {
                    let _ = fs::remove_file(&dest_file);
                    return Err(BridgeActionError::new(
                        "INVALID_PATH",
                        "检测到落盘路径越界，已回滚",
                    ));
                }
                let rel_path = if target_dir_rel.is_empty() {
                    final_name.clone()
                } else {
                    format!("{target_dir_rel}/{final_name}")
                };
                let indexed = is_indexed_by_current_engine(&dest_file);
                if indexed {
                    indexed_relative_paths.push(rel_path.clone());
                }
                imported.push(ImportedFileEntry {
                    source_path: raw_src.clone(),
                    relative_path: rel_path,
                    absolute_path: strip_win_verbatim_prefix(&canon_written)
                        .to_string_lossy()
                        .into_owned(),
                    file_name: final_name,
                    bytes,
                    renamed,
                    indexed_by_current_engine: indexed,
                });
            }
            Err(reason) => {
                skipped.push(SkippedImportEntry {
                    source_path: raw_src.clone(),
                    reason,
                });
            }
        }
    }

    Ok(ImportExternalFilesResult {
        ok: !imported.is_empty() || skipped.is_empty(),
        target_dir: target_dir_rel,
        imported,
        skipped,
        indexed_relative_paths,
        job_id: None,
    })
}

/// 解析工作区内路径的规范绝对路径（供复制绝对路径，绝不泄露或解析工作区外路径）。
pub fn resolve_workspace_path_impl(
    root: &Path,
    relative_path: &str,
) -> Result<String, BridgeActionError> {
    let (clean, _) = resolve_existing_inside_workspace(root, relative_path, true)?;
    Ok(clean.to_string_lossy().into_owned())
}

// ============================================================
// OS 原生操作（Windows Shell / Clipboard + 非 Windows 回退）
// ============================================================

#[cfg(windows)]
mod win_shell {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;
    const SW_SHOWNORMAL: i32 = 1;
    const CF_UNICODETEXT: u32 = 13;
    const GMEM_MOVEABLE: u32 = 0x0002;

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pv_reserved: *const c_void, dw_co_init: u32) -> i32;
        fn CoUninitialize();
    }

    #[link(name = "shell32")]
    extern "system" {
        fn ILCreateFromPathW(psz_path: *const u16) -> *mut c_void;
        fn ILFree(pidl: *mut c_void);
        fn SHOpenFolderAndSelectItems(
            pidl_folder: *const c_void,
            cidl: u32,
            apidl: *const *const c_void,
            dw_flags: u32,
        ) -> i32;
        fn ShellExecuteW(
            hwnd: *mut c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(h_wnd_new_owner: *mut c_void) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(u_format: u32, h_mem: *mut c_void) -> *mut c_void;
        fn CloseClipboard() -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(u_flags: u32, dw_bytes: usize) -> *mut c_void;
        fn GlobalLock(h_mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(h_mem: *mut c_void) -> i32;
        fn GlobalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    fn to_wide_null(s: &std::ffi::OsStr) -> Vec<u16> {
        let mut wide: Vec<u16> = s.encode_wide().collect();
        wide.push(0);
        wide
    }

    pub fn reveal_path(
        target: &Path,
        is_workspace_root: bool,
        owner_hwnd: isize,
    ) -> Result<(), String> {
        if is_workspace_root {
            return open_default(target, owner_hwnd);
        }

        let wide_path = to_wide_null(target.as_os_str());
        // SAFETY: STA COM 初始化与 PIDL 生命周期均受配对检查和释放保护；失败回退 explorer.exe。
        let shell_ok = unsafe {
            let hr_init = CoInitializeEx(null(), COINIT_APARTMENTTHREADED);
            let need_uninit = hr_init == 0 || hr_init == 1;
            if hr_init < 0 && hr_init != RPC_E_CHANGED_MODE {
                false
            } else {
                let pidl = ILCreateFromPathW(wide_path.as_ptr());
                let res = if !pidl.is_null() {
                    let hr = SHOpenFolderAndSelectItems(pidl, 0, null(), 0);
                    ILFree(pidl);
                    hr >= 0
                } else {
                    false
                };
                if need_uninit {
                    CoUninitialize();
                }
                res
            }
        };

        if shell_ok {
            return Ok(());
        }

        let arg = format!("/select,{}", target.to_string_lossy());
        std::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{e}"))?;
        Ok(())
    }

    pub fn open_default(target: &Path, owner_hwnd: isize) -> Result<(), String> {
        let wide_op = to_wide_null(std::ffi::OsStr::new("open"));
        let wide_file = to_wide_null(target.as_os_str());
        let parent = target.parent().unwrap_or(target);
        let wide_dir = to_wide_null(parent.as_os_str());

        // SAFETY: 所有 LPCWSTR 均以 NUL 结尾且在调用期间保持有效；ShellExecuteW 返回值 <= 32 表示失败。
        let hinst = unsafe {
            ShellExecuteW(
                owner_hwnd as *mut c_void,
                wide_op.as_ptr(),
                wide_file.as_ptr(),
                null(),
                wide_dir.as_ptr(),
                SW_SHOWNORMAL,
            )
        };
        if hinst <= 32 {
            return Err(format!(
                "系统默认程序打开失败（Win32 ShellExecute code={hinst}）"
            ));
        }
        Ok(())
    }

    pub fn write_clipboard_text(text: &str) -> Result<(), String> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let byte_len = wide.len() * std::mem::size_of::<u16>();

        let mut opened = false;
        for _ in 0..5 {
            // SAFETY: 无窗口拥有剪贴板时传入 null_mut() 是 Win32 合法用法，随后配对 CloseClipboard。
            if unsafe { OpenClipboard(null_mut()) } != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if !opened {
            return Err("无法打开系统剪贴板（可能正被其他应用占用）".to_owned());
        }

        // SAFETY: 成功 OpenClipboard 后配对 EmptyClipboard / SetClipboardData / CloseClipboard；
        // SetClipboardData 成功后内存所有权移交 OS，失败则显式 GlobalFree。
        unsafe {
            let _ = EmptyClipboard();
            let h_mem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
            if h_mem.is_null() {
                CloseClipboard();
                return Err("分配剪贴板内存失败".to_owned());
            }
            let ptr = GlobalLock(h_mem) as *mut u16;
            if ptr.is_null() {
                GlobalFree(h_mem);
                CloseClipboard();
                return Err("锁定剪贴板内存失败".to_owned());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            GlobalUnlock(h_mem);

            let res = SetClipboardData(CF_UNICODETEXT, h_mem);
            if res.is_null() {
                GlobalFree(h_mem);
                CloseClipboard();
                return Err("写入系统剪贴板失败".to_owned());
            }
            CloseClipboard();
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod unix_shell {
    use std::io::Write;
    use std::path::Path;
    use std::process::{Command, Stdio};

    pub fn reveal_path(
        target: &Path,
        is_workspace_root: bool,
        _owner_hwnd: isize,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("open");
            if !is_workspace_root {
                cmd.arg("-R");
            }
            cmd.arg(target)
                .spawn()
                .map_err(|e| format!("在 Finder 中显示失败：{e}"))?;
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let dir = if is_workspace_root || target.is_dir() {
                target
            } else {
                target.parent().unwrap_or(target)
            };
            Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("打开文件管理器失败：{e}"))?;
            Ok(())
        }
    }

    pub fn open_default(target: &Path, _owner_hwnd: isize) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        let prog = "open";
        #[cfg(not(target_os = "macos"))]
        let prog = "xdg-open";
        Command::new(prog)
            .arg(target)
            .spawn()
            .map_err(|e| format!("用默认应用打开失败：{e}"))?;
        Ok(())
    }

    pub fn write_clipboard_text(text: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        let candidates: &[(&str, &[&str])] = &[("pbcopy", &[])];
        #[cfg(not(target_os = "macos"))]
        let candidates: &[(&str, &[&str])] = &[
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ];

        for (prog, args) in candidates {
            if let Ok(mut child) = Command::new(prog).args(*args).stdin(Stdio::piped()).spawn() {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                if let Ok(status) = child.wait() {
                    if status.success() {
                        return Ok(());
                    }
                }
            }
        }
        Err("当前环境缺少系统剪贴板工具".to_owned())
    }
}

pub fn reveal_in_explorer_impl(
    root: &Path,
    relative_path: &str,
    owner_hwnd: isize,
) -> Result<BridgeActionOk, BridgeActionError> {
    let (clean, is_ws_root) = resolve_existing_inside_workspace(root, relative_path, true)?;
    let abs_str = clean.to_string_lossy().into_owned();
    #[cfg(windows)]
    let res = win_shell::reveal_path(&clean, is_ws_root, owner_hwnd);
    #[cfg(not(windows))]
    let res = unix_shell::reveal_path(&clean, is_ws_root, owner_hwnd);

    res.map_err(|msg| BridgeActionError::new("IO", msg))?;
    Ok(BridgeActionOk {
        ok: true,
        message: "已在资源管理器中显示".to_owned(),
        absolute_path: Some(abs_str),
    })
}

pub fn open_with_default_app_impl(
    root: &Path,
    relative_path: &str,
    owner_hwnd: isize,
) -> Result<BridgeActionOk, BridgeActionError> {
    let (clean, _) = resolve_existing_inside_workspace(root, relative_path, false)?;
    let abs_str = clean.to_string_lossy().into_owned();
    #[cfg(windows)]
    let res = win_shell::open_default(&clean, owner_hwnd);
    #[cfg(not(windows))]
    let res = unix_shell::open_default(&clean, owner_hwnd);

    res.map_err(|msg| BridgeActionError::new("IO", msg))?;
    Ok(BridgeActionOk {
        ok: true,
        message: "已调用系统默认应用打开".to_owned(),
        absolute_path: Some(abs_str),
    })
}

pub fn write_clipboard_text_impl(text: &str) -> Result<BridgeActionOk, BridgeActionError> {
    #[cfg(windows)]
    let res = win_shell::write_clipboard_text(text);
    #[cfg(not(windows))]
    let res = unix_shell::write_clipboard_text(text);

    res.map_err(|msg| BridgeActionError::new("IO", msg))?;
    Ok(BridgeActionOk {
        ok: true,
        message: "已写入系统剪贴板".to_owned(),
        absolute_path: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempGuard(PathBuf);
    impl TempGuard {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "guanlan-sysbridge-test-{}-{tag}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("创建测试目录");
            Self(dir)
        }
    }
    impl Drop for TempGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_all_traversal_and_outside_root_paths() {
        let base = TempGuard::new("traversal");
        let ws = base.0.join("ws");
        let outside = base.0.join("outside");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let ext_file = outside.join("secret.pdf");
        fs::write(&ext_file, b"%PDF-1.4\ntest\n").unwrap();

        for evil in [
            "../outside",
            "docs/../../outside",
            "..",
            ".\\..\\outside",
            "C:\\Windows\\System32",
            "/etc/passwd",
            "\\\\server\\share",
            "docs:stream",
            "CON",
            "docs/NUL.md",
            "docs\0evil",
        ] {
            assert_eq!(
                resolve_target_dir_inside_workspace(&ws, evil)
                    .expect_err(evil)
                    .code,
                "INVALID_PATH",
                "目标目录越界用例必须被 100% 拦截：{evil}"
            );
            assert_eq!(
                resolve_existing_inside_workspace(&ws, evil, false)
                    .expect_err(evil)
                    .code,
                "INVALID_PATH",
                "读取/定位越界用例必须被 100% 拦截：{evil}"
            );
            let import_err =
                import_external_files_impl(&ws, evil, &[ext_file.to_string_lossy().into_owned()])
                    .expect_err(evil);
            assert_eq!(import_err.code, "INVALID_PATH", "导入越界：{evil}");
        }

        // 确认工作区外没有发生任何写入
        assert!(!outside.join("secret (1).pdf").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&ws).unwrap().count(), 0);
    }

    #[test]
    fn imports_pdf_svg_and_raster_images_safely_with_collision_rename() {
        let base = TempGuard::new("import");
        let ws = base.0.join("ws");
        let src = base.0.join("external");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&src).unwrap();

        let pdf = src.join("方案定稿.pdf");
        let svg = src.join("架构图.svg");
        let png = src.join("现场照片.png");
        fs::write(&pdf, b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n").unwrap();
        fs::write(
            &svg,
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><text>OK</text></svg>",
        )
        .unwrap();
        fs::write(&png, b"\x89PNG\r\n\x1a\nfake-png").unwrap();

        let first = import_external_files_impl(
            &ws,
            "docs/inbox",
            &[
                pdf.to_string_lossy().into_owned(),
                svg.to_string_lossy().into_owned(),
                png.to_string_lossy().into_owned(),
            ],
        )
        .expect("导入成功");

        assert_eq!(first.target_dir, "docs/inbox");
        assert_eq!(first.imported.len(), 3);
        assert!(first.skipped.is_empty());
        assert_eq!(
            first.indexed_relative_paths,
            vec![
                "docs/inbox/方案定稿.pdf".to_owned(),
                "docs/inbox/架构图.svg".to_owned(),
            ]
        );
        assert!(ws.join("docs/inbox/方案定稿.pdf").is_file());
        assert!(ws.join("docs/inbox/架构图.svg").is_file());
        assert!(ws.join("docs/inbox/现场照片.png").is_file());

        // 同名再导入不得静默覆盖，自动重命名为 `stem (1).ext`
        let second =
            import_external_files_impl(&ws, "docs/inbox", &[pdf.to_string_lossy().into_owned()])
                .expect("同名不覆盖");
        assert_eq!(second.imported.len(), 1);
        assert!(second.imported[0].renamed);
        assert_eq!(second.imported[0].file_name, "方案定稿 (1).pdf");
        assert!(ws.join("docs/inbox/方案定稿 (1).pdf").is_file());
    }

    #[test]
    fn resolves_clean_workspace_paths_and_blocks_missing_or_root_open() {
        let base = TempGuard::new("resolve");
        let ws = base.0.join("ws");
        fs::create_dir_all(ws.join("docs")).unwrap();
        let file = ws.join("docs/plan.md");
        fs::write(&file, "# Plan\n").unwrap();

        let root_resolved = resolve_workspace_path_impl(&ws, "").expect("允许解析工作区根");
        assert!(!root_resolved.starts_with(r"\\?\"), "不得带 verbatim 前缀");

        let file_resolved = resolve_workspace_path_impl(&ws, "docs/plan.md").expect("解析内部文件");
        assert!(!file_resolved.starts_with(r"\\?\"));
        assert!(file_resolved.ends_with("plan.md"));

        assert_eq!(
            resolve_workspace_path_impl(&ws, "docs/missing.md")
                .expect_err("不存在目标报 NOT_FOUND")
                .code,
            "NOT_FOUND"
        );
        assert_eq!(
            resolve_workspace_path_impl(&ws, "../escape.md")
                .expect_err("越界路径报 INVALID_PATH")
                .code,
            "INVALID_PATH"
        );
        assert_eq!(
            open_with_default_app_impl(&ws, "", 0)
                .expect_err("禁止把根目录传给默认打开")
                .code,
            "INVALID_PATH"
        );
        assert_eq!(
            reveal_in_explorer_impl(&ws, "../escape.md", 0)
                .expect_err("越界路径禁止调用 Explorer")
                .code,
            "INVALID_PATH"
        );
    }
}
