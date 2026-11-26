//! 工作区文件采集（移植自 `src/services/FileScanner.ts`）。
//!
//! 职责与 TS 版一致：只枚举授权根目录、算出字节 SHA-256、做稳定读取校验，
//! **不做任何版本/事件判定**（版本与事件由对账层比对持久库后分配）。
//!
//! 两处有意的实现差异（不影响事实口径）：
//! - **不整批驻留内容**：TS 把每个文件的字节留在内存里等写快照时复用；Rust 版
//!   采集阶段只流式算哈希，快照阶段按需重读，避免整批文件内容同时驻留内存。
//!   代价是变更文件读两遍，换来的是恒定内存占用。
//! - **目录项按名排序**：TS 用 OS 目录序（不可复现）；Rust 按名排序后深度优先，
//!   保证同一工作区每次扫描的采集顺序一致（事件 seq 的分配因此可复现）。
//!
//! **全文件类型采集**：所有常规文件均入库（`files.format` 记真实扩展名 token），
//! 只有两类内容被排除：
//!
//! 1. **系统/依赖目录黑名单**（[`DEFAULT_EXCLUDED`]）：`node_modules` / `.git` /
//!    `target` / `__pycache__` 等构建产物与依赖缓存。
//! 2. **`.gitignore` 命中的路径**：尊重用户亲手声明的忽略规则（逐目录生效，
//!    越深越优先）。实现见 [`crate::index::ignore`]。

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::index::file_format::FileFormat;
use crate::index::ignore::{Gitignore, IgnoreStack};

pub use crate::index::file_format::{
    class_of_token, FormatClass, SnapshotPolicy, SnapshotTier, BINARY_TOKEN,
};

/// 默认排除目录（系统/依赖黑名单）。
///
/// 口径：**只排构建产物、依赖缓存与系统目录**，绝不排用户可能放资料的目录名。
/// 保留旧管线的既有排除项（`node_modules` / `.git` / `.venv` / `_软件安装包` /
/// `_spike` / `dist` / `runtime` / `backups` / `tmp`），并补齐常见语言工具链依赖与系统目录。
pub const DEFAULT_EXCLUDED: &[&str] = &[
    "node_modules",
    "bower_components",
    "vendor",
    "Pods",
    ".pnp",
    ".pnpm-store",
    ".yarn",
    ".git",
    ".svn",
    ".hg",
    ".idea",
    ".vscode",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    ".gradle",
    ".m2",
    "target",
    "cmake-build-debug",
    "cmake-build-release",
    "CMakeFiles",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    ".terraform",
    "AppData",
    "$RECYCLE.BIN",
    "System Volume Information",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    "_软件安装包",
    "_spike",
    "dist",
    "runtime",
    "backups",
    "tmp",
];

/// 默认文件数上限（20 万，避免常规工作区被静默截断；触顶仍按「范围不完整」记账，绝不判缺失）。
pub const DEFAULT_MAX_FILES: usize = 200_000;
/// 默认目录深度上限。
pub const DEFAULT_MAX_DEPTH: usize = 32;

/// 采集到的文件（纯事实：路径、哈希、mtime、是否稳定读取）
#[derive(Debug, Clone)]
pub struct CollectedFile {
    /// 相对工作区根的路径（正斜杠）
    pub relative_path: String,
    /// 文件名
    pub file_name: String,
    /// 格式（细粒度扩展名 token + 派生的格式族）
    pub format: FileFormat,
    /// 字节数
    pub size_bytes: i64,
    /// 修改时间（毫秒，含亚毫秒小数；与 Node `stat.mtimeMs` 同公式）
    pub mtime_ms: f64,
    /// 全文件字节的 SHA-256（小写 hex）
    pub sha256: String,
    /// 读取期间未被改写；false 时本轮不落版本，只报告读取问题
    pub stable: bool,
    /// 绝对路径（快照阶段按需重读）
    pub absolute_path: PathBuf,
}

/// 采集期读不到的路径：不登记缺失，只报告问题
#[derive(Debug, Clone)]
pub struct ReadError {
    pub relative_path: String,
    pub message: String,
}

/// 采集结果
#[derive(Debug, Clone)]
pub struct CollectResult {
    pub files: Vec<CollectedFile>,
    pub read_errors: Vec<ReadError>,
    /// 采集是否覆盖了指定范围的完整遍历；**不完整时不得据此判定缺失**
    pub complete: bool,
    pub truncated: bool,
    /// 采集过程中是否因协作式取消/服务停机提前中止（此时 `complete` 必为 false）
    pub cancelled: bool,
    /// 被 `.gitignore` 排除的路径数（诊断用：让用户知道「为什么这个文件没进来」）
    pub ignored_count: usize,
}

#[inline]
fn is_cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::Acquire))
}

/// 采集工作区文件清单
pub fn collect_workspace(
    root: &Path,
    excluded_dirs: &[String],
    max_files: usize,
    max_depth: usize,
) -> CollectResult {
    collect_workspace_cancellable(root, excluded_dirs, max_files, max_depth, None)
}

/// 采集工作区文件清单（支持协作式取消：每目录、每文件以及大文件 64KiB 流式哈希块间隙检查取消标志）。
pub fn collect_workspace_cancellable(
    root: &Path,
    excluded_dirs: &[String],
    max_files: usize,
    max_depth: usize,
    cancel: Option<&AtomicBool>,
) -> CollectResult {
    let mut excluded: Vec<String> = DEFAULT_EXCLUDED.iter().map(|s| (*s).to_owned()).collect();
    excluded.extend(excluded_dirs.iter().cloned());

    let mut files: Vec<CollectedFile> = Vec::new();
    let mut read_errors: Vec<ReadError> = Vec::new();
    let mut complete = true;
    let mut truncated = false;
    let mut cancelled = false;

    if is_cancelled(cancel) {
        return CollectResult {
            files,
            read_errors,
            complete: false,
            truncated: false,
            cancelled: true,
            ignored_count: 0,
        };
    }

    if !root.is_dir() {
        return CollectResult {
            files,
            read_errors: vec![ReadError {
                relative_path: ".".to_owned(),
                message: format!("根目录不存在: {}", root.display()),
            }],
            complete: false,
            truncated: false,
            cancelled: false,
            ignored_count: 0,
        };
    }

    let mut ignored_count = 0usize;
    let mut stack = IgnoreStack::default();
    if let Some(root_layer) = read_gitignore(root, "") {
        stack.push(root_layer);
    }
    walk(
        root,
        "",
        0,
        &excluded,
        max_files,
        max_depth,
        &mut files,
        &mut read_errors,
        &mut complete,
        &mut truncated,
        &mut cancelled,
        &mut stack,
        &mut ignored_count,
        cancel,
    );

    CollectResult {
        files,
        read_errors,
        complete,
        truncated,
        cancelled,
        ignored_count,
    }
}

/// 默认目录枚举上限（侧栏真实文件夹树，含空文件夹）
pub const DEFAULT_MAX_FOLDERS: usize = 20_000;

/// 目录清单（含空目录）。
///
/// `truncated` = 触到目录数或深度上限，清单之外还有目录；`incomplete` = 有目录读不到。
/// 两者都表示「这份清单不是全貌」：调用方不得据此删掉既有目录记录，见
/// `LESSONS.md` 的「读不全不等于没有」。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderListing {
    pub folders: Vec<String>,
    pub truncated: bool,
    pub incomplete: bool,
}

/// 枚举工作区内所有可见真实目录（含空文件夹），沿用与 [`collect_workspace`] 一致的
/// 排除黑名单、点号隐藏目录跳过、符号链接防护与 `.gitignore` 规则。
pub fn collect_workspace_folders(
    root: &Path,
    excluded_dirs: &[String],
    max_dirs: usize,
    max_depth: usize,
) -> FolderListing {
    let mut excluded: Vec<String> = DEFAULT_EXCLUDED.iter().map(|s| (*s).to_owned()).collect();
    excluded.extend(excluded_dirs.iter().cloned());

    let mut listing = FolderListing::default();
    if !root.is_dir() {
        listing.incomplete = true;
        return listing;
    }

    let mut stack = IgnoreStack::default();
    if let Some(root_layer) = read_gitignore(root, "") {
        stack.push(root_layer);
    }
    walk_folders(
        root,
        "",
        0,
        &excluded,
        max_dirs,
        max_depth,
        &mut listing,
        &mut stack,
    );
    listing
}

#[allow(clippy::too_many_arguments)]
fn walk_folders(
    dir: &Path,
    relative_dir: &str,
    depth: usize,
    excluded: &[String],
    max_dirs: usize,
    max_depth: usize,
    listing: &mut FolderListing,
    stack: &mut IgnoreStack,
) {
    if depth >= max_depth || listing.folders.len() >= max_dirs {
        listing.truncated = true;
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        listing.incomplete = true;
        return;
    };
    let mut names: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, full_path) in names {
        if listing.folders.len() >= max_dirs {
            listing.truncated = true;
            return;
        }
        if name.starts_with('.') || excluded.iter().any(|ex| ex == &name) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&full_path) else {
            listing.incomplete = true;
            continue;
        };
        let ft = meta.file_type();
        if ft.is_symlink() || !ft.is_dir() {
            continue;
        }
        let rel = join_rel(relative_dir, &name);
        if stack.is_ignored(&rel, true) {
            continue;
        }
        listing.folders.push(rel.clone());
        let pushed = read_gitignore(&full_path, &rel).map(|layer| {
            stack.push(layer);
        });
        walk_folders(
            &full_path,
            &rel,
            depth + 1,
            excluded,
            max_dirs,
            max_depth,
            listing,
            stack,
        );
        if pushed.is_some() {
            stack.pop();
        }
    }
}

/// 只采集给定相对路径（单路径对账通道：决策回写/草案采纳后的定向核验，
/// 避免整树重算哈希，目标延迟 <200ms）。
///
/// `complete` 恒为 false：范围不完整，调用方不得据此判定任何文件缺失
/// （契约 §5.4）。路径按正斜杠归一化比对；不存在/不可读的路径进 read_errors
/// 而不是报错——由对账主流程按「读取问题」记账。
///
/// **`.gitignore` 纪律同样生效**：被忽略的路径不进采集结果——否则定向通道
/// 会把整树扫描排除掉的文件又塞回库里，造成「收录/缺失」来回抖动。
pub fn collect_specific_paths(root: &Path, paths: &[String]) -> CollectResult {
    collect_specific_paths_cancellable(root, paths, None)
}

/// 定向路径采集的可取消版本（服务停机或任务取消时在路径间隙与流式哈希循环中及时返回）。
pub fn collect_specific_paths_cancellable(
    root: &Path,
    paths: &[String],
    cancel: Option<&AtomicBool>,
) -> CollectResult {
    let mut files: Vec<CollectedFile> = Vec::new();
    let mut read_errors: Vec<ReadError> = Vec::new();
    let mut ignored_count = 0usize;
    let mut cancelled = false;
    for raw in paths {
        if is_cancelled(cancel) {
            cancelled = true;
            break;
        }
        let rel = raw.replace('\\', "/");
        if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
            read_errors.push(ReadError {
                relative_path: rel,
                message: "非法相对路径（绝对路径或越界）".to_owned(),
            });
            continue;
        }
        let full = root.join(&rel);
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_owned();
        let Some(meta) = fs::symlink_metadata(&full).ok() else {
            read_errors.push(ReadError {
                relative_path: rel.clone(),
                message: "路径不可访问".to_owned(),
            });
            continue;
        };
        if !meta.is_file() {
            read_errors.push(ReadError {
                relative_path: rel.clone(),
                message: "路径不是常规文件".to_owned(),
            });
            continue;
        }
        if is_ignored_path(root, &rel) {
            ignored_count += 1;
            continue;
        }
        let format = format_of(&name, &full);
        match hash_file_stable_cancellable(&full, cancel) {
            Ok(hashed) => files.push(CollectedFile {
                file_name: name,
                relative_path: rel,
                format,
                size_bytes: hashed.size_bytes,
                mtime_ms: hashed.mtime_ms,
                sha256: hashed.sha256,
                stable: hashed.stable,
                absolute_path: full,
            }),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted && is_cancelled(cancel) => {
                cancelled = true;
                break;
            }
            Err(err) => read_errors.push(ReadError {
                relative_path: rel,
                message: err.to_string(),
            }),
        }
    }
    CollectResult {
        files,
        read_errors,
        complete: false,
        truncated: false,
        cancelled,
        ignored_count,
    }
}

/// 判定单个相对路径是否被目录黑名单或 `.gitignore` 忽略。
///
/// 逐层加载路径上的 `.gitignore`（根 → 目标所在目录），并检查**任一祖先目录**
/// 是否被忽略或命中系统/依赖黑名单——整树扫描会整棵剪掉，定向通道必须同口径。
pub fn is_ignored_path(root: &Path, rel_path: &str) -> bool {
    let mut stack = IgnoreStack::default();
    if let Some(root_layer) = read_gitignore(root, "") {
        stack.push(root_layer);
    }
    let mut current = String::new();
    let segments: Vec<&str> = rel_path.split('/').filter(|s| !s.is_empty()).collect();
    for (index, segment) in segments.iter().enumerate() {
        let is_last = index + 1 == segments.len();
        if is_last {
            if stack.is_ignored(rel_path, false) {
                return true;
            }
            break;
        }
        if segment.starts_with('.') || DEFAULT_EXCLUDED.contains(segment) {
            return true;
        }
        let dir_rel = if current.is_empty() {
            (*segment).to_owned()
        } else {
            format!("{current}/{segment}")
        };
        if stack.is_ignored(&dir_rel, true) {
            return true;
        }
        current = dir_rel;
        let dir_path = root.join(&current);
        if let Some(layer) = read_gitignore(&dir_path, &current) {
            stack.push(layer);
        }
    }
    false
}

enum CachedLayer {
    Absent,
    Present(std::sync::Arc<Gitignore>),
}

type GitignoreCache = HashMap<PathBuf, (Option<SystemTime>, CachedLayer)>;

fn gitignore_cache() -> &'static std::sync::Mutex<GitignoreCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<GitignoreCache>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn read_gitignore(dir: &Path, base: &str) -> Option<Gitignore> {
    let path = dir.join(".gitignore");
    let mtime = fs::metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok());
    {
        let cache = gitignore_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some((cached_mtime, layer)) = cache.get(&path) {
            if *cached_mtime == mtime {
                return match layer {
                    CachedLayer::Absent => None,
                    CachedLayer::Present(gitignore) => {
                        Some(Gitignore::from_rules(gitignore.rules().to_vec()))
                    }
                };
            }
        }
    }
    match fs::read_to_string(&path) {
        Ok(content) => {
            let parsed = std::sync::Arc::new(Gitignore::parse(base, &content));
            let out = Gitignore::from_rules(parsed.rules().to_vec());
            let mut cache = gitignore_cache().lock().unwrap_or_else(|p| p.into_inner());
            cache.insert(path, (mtime, CachedLayer::Present(parsed)));
            Some(out)
        }
        Err(_) => {
            let mut cache = gitignore_cache().lock().unwrap_or_else(|p| p.into_inner());
            cache.insert(path, (mtime, CachedLayer::Absent));
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn walk(
    dir: &Path,
    relative_dir: &str,
    depth: usize,
    excluded: &[String],
    max_files: usize,
    max_depth: usize,
    files: &mut Vec<CollectedFile>,
    read_errors: &mut Vec<ReadError>,
    complete: &mut bool,
    truncated: &mut bool,
    cancelled: &mut bool,
    stack: &mut IgnoreStack,
    ignored_count: &mut usize,
    cancel: Option<&AtomicBool>,
) {
    if is_cancelled(cancel) {
        *cancelled = true;
        *complete = false;
        return;
    }
    if depth > max_depth || files.len() >= max_files {
        *truncated = true;
        *complete = false;
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            *complete = false;
            read_errors.push(ReadError {
                relative_path: if relative_dir.is_empty() {
                    ".".to_owned()
                } else {
                    relative_dir.to_owned()
                },
                message: err.to_string(),
            });
            return;
        }
    };

    let mut names: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                *complete = false;
                read_errors.push(ReadError {
                    relative_path: if relative_dir.is_empty() {
                        ".".to_owned()
                    } else {
                        relative_dir.to_owned()
                    },
                    message: err.to_string(),
                });
                continue;
            }
        };
        names.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.path(),
        ));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, full_path) in names {
        if is_cancelled(cancel) {
            *cancelled = true;
            *complete = false;
            return;
        }
        if files.len() >= max_files {
            *truncated = true;
            *complete = false;
            return;
        }

        let file_type = match fs::symlink_metadata(&full_path) {
            Ok(meta) => meta.file_type(),
            Err(err) => {
                read_errors.push(ReadError {
                    relative_path: join_rel(relative_dir, &name),
                    message: err.to_string(),
                });
                continue;
            }
        };

        if file_type.is_dir() {
            if name.starts_with('.') || is_excluded(&name, excluded) {
                continue;
            }
            let child_rel = join_rel(relative_dir, &name);
            if stack.is_ignored(&child_rel, true) {
                *ignored_count += 1;
                continue;
            }
            let pushed =
                read_gitignore(&full_path, &child_rel).is_some_and(|layer| stack.push(layer));
            walk(
                &full_path,
                &child_rel,
                depth + 1,
                excluded,
                max_files,
                max_depth,
                files,
                read_errors,
                complete,
                truncated,
                cancelled,
                stack,
                ignored_count,
                cancel,
            );
            if pushed {
                stack.pop();
            }
            if *cancelled {
                return;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let relative_path = join_rel(relative_dir, &name);
        if stack.is_ignored(&relative_path, false) {
            *ignored_count += 1;
            continue;
        }

        let format = format_of(&name, &full_path);
        match hash_file_stable_cancellable(&full_path, cancel) {
            Ok(hashed) => files.push(CollectedFile {
                relative_path,
                file_name: name,
                format,
                size_bytes: hashed.size_bytes,
                mtime_ms: hashed.mtime_ms,
                sha256: hashed.sha256,
                stable: hashed.stable,
                absolute_path: full_path,
            }),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted && is_cancelled(cancel) => {
                *cancelled = true;
                *complete = false;
                return;
            }
            Err(err) => read_errors.push(ReadError {
                relative_path,
                message: err.to_string(),
            }),
        }
    }
}

fn join_rel(relative_dir: &str, name: &str) -> String {
    if relative_dir.is_empty() {
        name.to_owned()
    } else {
        format!("{relative_dir}/{name}")
    }
}

fn is_excluded(name: &str, excluded: &[String]) -> bool {
    excluded.iter().any(|pattern| glob_match(pattern, name))
}

fn glob_match(pattern: &str, name: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == name;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = name;
    if !rest.starts_with(parts[0]) {
        return false;
    }
    rest = &rest[parts[0].len()..];
    let last = parts[parts.len() - 1];
    for segment in &parts[1..parts.len() - 1] {
        match rest.find(segment) {
            Some(idx) => rest = &rest[idx + segment.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

const KNOWN_EXTENSIONLESS: &[(&str, &str)] = &[
    ("makefile", "make"),
    ("gnumakefile", "make"),
    ("dockerfile", "dockerfile"),
    ("containerfile", "containerfile"),
    ("license", "license"),
    ("licence", "license"),
    ("readme", "readme"),
    ("changelog", "changelog"),
    ("authors", "text"),
    ("contributors", "text"),
    ("copying", "license"),
    ("notice", "text"),
    ("todo", "text"),
    ("codeowners", "text"),
    (".gitignore", "gitignore"),
    (".gitattributes", "gitattributes"),
    (".gitmodules", "gitmodules"),
    (".editorconfig", "editorconfig"),
    (".env", "env"),
    (".npmrc", "npmrc"),
    (".yarnrc", "yarnrc"),
    (".prettierrc", "prettierrc"),
    (".eslintrc", "eslintrc"),
    (".babelrc", "babelrc"),
];

pub(crate) fn format_of(file_name: &str, path: &Path) -> FileFormat {
    let ext = extension_of(file_name);
    if !ext.is_empty() {
        return FileFormat::of_extension(ext);
    }
    let lower = file_name.to_ascii_lowercase();
    if let Some((_, token)) = KNOWN_EXTENSIONLESS.iter().find(|(name, _)| *name == lower) {
        return FileFormat::of_extension(token);
    }
    if looks_like_pdf(path) {
        return FileFormat::of_extension("pdf");
    }
    FileFormat::of_extension(BINARY_TOKEN)
}

fn extension_of(file_name: &str) -> &str {
    match file_name.rfind('.') {
        Some(0) | None => "",
        Some(idx) => &file_name[idx..],
    }
}

fn looks_like_pdf(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 4];
    match file.read_exact(&mut buf) {
        Ok(()) => &buf == b"%PDF",
        Err(_) => false,
    }
}

/// 稳定读取的结果
#[derive(Debug, Clone)]
pub struct HashedFile {
    pub sha256: String,
    pub size_bytes: i64,
    pub mtime_ms: f64,
    pub stable: bool,
}

/// 稳定读取：先 stat，读取并算哈希，再 stat；期间 size/mtime 变化则重读一次。
///
/// 第二次仍不稳定时 `stable` 仍为 false —— 调用方按读取问题处理，本轮不落版本
/// （与 TS `hashFileStable` 同口径）。
///
/// **恒定内存占用**：全程只持有一个 64KiB 缓冲，大文件（如 2GB 视频）的流式哈希内存峰值
/// 恒定在 64KB 量级——绝不整读大文件。
pub fn hash_file_stable(path: &Path) -> std::io::Result<HashedFile> {
    hash_file_stable_cancellable(path, None)
}

/// 稳定读取的可取消版本：每次 64KiB 分块读取前检查取消标志，大视频/归档文件也能毫秒级中止。
pub fn hash_file_stable_cancellable(
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> std::io::Result<HashedFile> {
    let first = attempt_hash_cancellable(path, cancel)?;
    if first.stable {
        return Ok(first);
    }
    attempt_hash_cancellable(path, cancel)
}

fn attempt_hash_cancellable(
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> std::io::Result<HashedFile> {
    if is_cancelled(cancel) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "采集已取消",
        ));
    }
    let before = stat_fingerprint(path)?;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if is_cancelled(cancel) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "采集已取消",
            ));
        }
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let after = stat_fingerprint(path)?;
    let stable = before.size == after.size && before.mtime_ns == after.mtime_ns;
    Ok(HashedFile {
        sha256: hex::encode(hasher.finalize()),
        size_bytes: after.size,
        mtime_ms: after.mtime_ms,
        stable,
    })
}

/// 文件指纹：size + mtime（纳秒）+ Node 口径的毫秒浮点。
/// watcher 轮询比对复用（契约 §6 监听语义：mtime/size 增量比对，不作为事实）。
#[derive(Debug, Clone, Copy)]
pub struct Fingerprint {
    pub size: i64,
    pub mtime_ns: i128,
    pub mtime_ms: f64,
}

/// 取文件指纹
pub fn stat_fingerprint(path: &Path) -> std::io::Result<Fingerprint> {
    let meta = fs::metadata(path)?;
    let size = meta.len() as i64;
    let (mtime_ns, mtime_ms) = match meta.modified() {
        Ok(time) => {
            let duration = time
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            let secs = duration.as_secs() as i64;
            let nanos = duration.subsec_nanos() as i64;
            let millis = secs as f64 * 1000.0 + nanos as f64 / 1_000_000.0;
            (i128::from(secs) * 1_000_000_000 + i128::from(nanos), millis)
        }
        Err(_) => (0, 0.0),
    };
    Ok(Fingerprint {
        size,
        mtime_ns,
        mtime_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, content: &[u8]) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("建目录");
        }
        fs::write(path, content).expect("写文件");
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("guanlan-collect-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn collects_every_format_and_skips_hidden_dirs() {
        let dir = tmp_dir("all-formats");
        write(&dir, "a.md", b"# A");
        write(&dir, "docs/b.markdown", b"# B");
        write(&dir, "c.svg", b"<svg/>");
        write(&dir, "d.pdf", b"%PDF-1.4");
        write(&dir, "e.txt", b"plain");
        write(&dir, "f.docx", b"PK\x03\x04");
        write(&dir, "g.xlsx", b"PK\x03\x04");
        write(&dir, "h.png", b"\x89PNG");
        write(&dir, "i.ts", b"export const a = 1;");
        write(&dir, "j.mp4", b"\x00\x00\x00 ftypisom");
        write(&dir, "k.zip", b"PK\x03\x04");
        write(&dir, ".hidden/f.md", b"# hidden");
        write(&dir, "node_modules/g.md", b"# nm");
        write(&dir, "target/debug/artifact.md", b"# rust target");

        let result = collect_workspace(&dir, &[], DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH);
        let mut names: Vec<&str> = result
            .files
            .iter()
            .map(|f| f.relative_path.as_str())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "a.md",
                "c.svg",
                "d.pdf",
                "docs/b.markdown",
                "e.txt",
                "f.docx",
                "g.xlsx",
                "h.png",
                "i.ts",
                "j.mp4",
                "k.zip"
            ]
        );
        assert!(result.complete);
        assert!(!result.truncated);
        let a = result
            .files
            .iter()
            .find(|f| f.relative_path == "a.md")
            .unwrap();
        assert_eq!(a.format.as_str(), "md");
        assert_eq!(a.size_bytes, 3);
        assert!(a.stable);
        assert_eq!(a.sha256.len(), 64);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_tokens_are_fine_grained() {
        let dir = tmp_dir("tokens");
        write(&dir, "a.md", b"# A");
        write(&dir, "b.docx", b"x");
        write(&dir, "c.ts", b"x");
        write(&dir, "d.png", b"x");
        write(&dir, "e.weird", b"x");
        let result = collect_workspace(&dir, &[], DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH);
        let token_of = |rel: &str| {
            result
                .files
                .iter()
                .find(|f| f.relative_path == rel)
                .unwrap()
                .format
                .as_str()
                .to_owned()
        };
        assert_eq!(token_of("a.md"), "md");
        assert_eq!(token_of("b.docx"), "docx");
        assert_eq!(token_of("c.ts"), "ts");
        assert_eq!(token_of("d.png"), "png");
        assert_eq!(token_of("e.weird"), "weird");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gitignore_rules_are_respected() {
        let dir = tmp_dir("gitignore");
        write(&dir, ".gitignore", b"*.log\nbuild/\n!keep.log\n");
        write(&dir, "a.log", b"x");
        write(&dir, "keep.log", b"x");
        write(&dir, "b.md", b"# B");
        write(&dir, "build/c.md", b"# C");

        let result = collect_workspace(&dir, &[], DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH);
        let mut names: Vec<&str> = result
            .files
            .iter()
            .map(|f| f.relative_path.as_str())
            .collect();
        names.sort();
        assert_eq!(names, vec![".gitignore", "b.md", "keep.log"]);
        assert!(result.ignored_count >= 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_gitignore_applies_to_its_subtree_only() {
        let dir = tmp_dir("gitignore-nested");
        write(&dir, "sub/.gitignore", b"*.tmp\n");
        write(&dir, "sub/a.tmp", b"x");
        write(&dir, "sub/b.md", b"# B");
        write(&dir, "a.tmp", b"x");

        let result = collect_workspace(&dir, &[], DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH);
        let mut names: Vec<&str> = result
            .files
            .iter()
            .map(|f| f.relative_path.as_str())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.tmp", "sub/.gitignore", "sub/b.md"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn targeted_collect_respects_gitignore() {
        let dir = tmp_dir("gitignore-target");
        write(&dir, ".gitignore", b"*.log\n");
        write(&dir, "a.log", b"x");
        write(&dir, "b.md", b"# B");

        let result = collect_specific_paths(&dir, &["a.log".to_owned(), "b.md".to_owned()]);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_path, "b.md");
        assert_eq!(result.ignored_count, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pdf_magic_without_extension_is_collected() {
        let dir = tmp_dir("pdf-magic");
        write(&dir, "mystery", b"%PDF-1.7\n...");
        let result = collect_workspace(&dir, &[], DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].format.as_str(), "pdf");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_root_is_incomplete_with_read_error() {
        let dir = tmp_dir("missing");
        let result = collect_workspace(&dir, &[], DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH);
        assert!(!result.complete);
        assert_eq!(result.read_errors.len(), 1);
        assert_eq!(result.read_errors[0].relative_path, ".");
    }

    #[test]
    fn extension_rules_match_node() {
        assert_eq!(extension_of("a.md"), ".md");
        assert_eq!(extension_of(".md"), "");
        assert_eq!(extension_of("noext"), "");
        assert_eq!(extension_of("a.b.md"), ".md");
    }

    #[test]
    fn empty_subdir_gitignore_does_not_drop_parent_rules() {
        let dir = tmp_dir("gitignore-empty-sub");
        write(&dir, ".gitignore", b"*.log\n");
        write(&dir, "sub/.gitignore", b"# only comment\n\n");
        write(&dir, "sub/skip.log", b"x");
        write(&dir, "sub/keep.md", b"# K");
        write(&dir, "sibling/after.log", b"x");

        let result = collect_workspace(&dir, &[], DEFAULT_MAX_FILES, DEFAULT_MAX_DEPTH);
        let mut names: Vec<&str> = result
            .files
            .iter()
            .map(|f| f.relative_path.as_str())
            .collect();
        names.sort();
        assert_eq!(names, vec![".gitignore", "sub/.gitignore", "sub/keep.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_binary_stream_hash_keeps_memory_flat() {
        let dir = tmp_dir("big");
        fs::create_dir_all(&dir).expect("建目录");
        let path = dir.join("big.bin");
        let file = fs::File::create(&path).expect("建大文件");
        let chunk = vec![7u8; 1024 * 1024];
        let mut writer = std::io::BufWriter::new(file);
        use std::io::Write;
        for _ in 0..8 {
            writer.write_all(&chunk).expect("写大文件");
        }
        writer.flush().expect("刷新");
        drop(writer);
        let hashed = hash_file_stable(&path).expect("流式哈希");
        assert_eq!(hashed.size_bytes, 8 * 1024 * 1024);
        assert_eq!(hashed.sha256.len(), 64);
        assert!(hashed.stable);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_workspace_cancellable_and_hash_abort_promptly() {
        let dir = tmp_dir("cancel");
        write(&dir, "a.md", b"# A");
        write(&dir, "sub/b.mp4", &vec![0x5Au8; 512 * 1024]);

        let flag = AtomicBool::new(true);
        let result = collect_workspace_cancellable(
            &dir,
            &[],
            DEFAULT_MAX_FILES,
            DEFAULT_MAX_DEPTH,
            Some(&flag),
        );
        assert!(result.cancelled, "已置位取消标志时必须立即中止采集");
        assert!(
            !result.complete,
            "中止采集范围不完整，complete 必须为 false"
        );
        assert!(result.files.is_empty());
        assert!(result.read_errors.is_empty(), "协作取消不得误记为读取错误");

        let hash_err = hash_file_stable_cancellable(&dir.join("sub/b.mp4"), Some(&flag))
            .expect_err("流式哈希应响应取消标志返回 Interrupted");
        assert_eq!(hash_err.kind(), std::io::ErrorKind::Interrupted);

        let specific = collect_specific_paths_cancellable(
            &dir,
            &["a.md".to_owned(), "sub/b.mp4".to_owned()],
            Some(&flag),
        );
        assert!(specific.cancelled);
        assert!(specific.read_errors.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
